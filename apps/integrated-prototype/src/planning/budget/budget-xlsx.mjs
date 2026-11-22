// 予算書の xlsx を読む（要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-008〜011・035〜041）。
// 予算書は数式で合計を出すので、取込の decodeXlsx（数式を断る）は使わず、セルに保存された値（Excel が最後に計算した値）と数式の有無・塗りの色を読む。
// 書式ごとの知識（見出しの語・合計の行の名前・区分の語・確定の印の色）は、読み取りの定義（データ。budget-read-model.mjs が検査する）から受け取る。
// ここに残すのは読み方（区画の見つけ方・小計の見つけ方・区分の当て方）と、定義がどう書かれていても破れない読み方の決まり
// （円は整数だけを読み、端数のある額・値の無い数式・区分の分からない明細は例外へ回す。区分は A〜K と制作管理費・予備費だけ）。
// 位置ではなく見出しの名前で列を探すので、列を動かした予算書も読める。どの区分の小計の行にも閉じられない明細と、A〜K に当たらない区分は例外に残す。
import {unzipSync, strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';
import {CATEGORY_CODES, categoryFromLabel, normalizeLabel} from './budget-model.mjs';
import {checkBudgetReadDefinition, firstTarget} from './budget-read-model.mjs';
import {BUDGET_READ_SEEDS} from './budget-read-seeds.mjs';
import {scaledInteger} from '../../sales-sheet/sales-sheet-input.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const columnIndex = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
export const columnLetters = (index) => { let s = ''; for (let n = index; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// ブックを開き、シートごとに「セル位置 → {value, formula, fill}」を返す。値は保存された値（文字か数）。数式だけで値の無いセルは value: null
export function readBudgetWorkbook(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_BYTES) throw new Error('予算書は20MB以下にしてください');
  let size = 0;
  const files = unzipSync(bytes, {filter: (file) => {
    size += file.originalSize;
    if (size > 50 * 1024 * 1024 || file.originalSize > MAX_BYTES) throw new Error('予算書の展開サイズが大きすぎます');
    return file.name.endsWith('.xml') || file.name.endsWith('.rels');
  }});
  const parser = new XMLParser({ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, parseAttributeValue: false, trimValues: false,
    processEntities: true, htmlEntities: true, removeNSPrefix: true});
  const read = (path) => {
    if (!files[path]) return null;
    const text = strFromU8(files[path]);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('外部定義を含む予算書は読み込めません');
    return parser.parse(text);
  };
  const book = read('xl/workbook.xml')?.workbook;
  if (!book) throw new Error('有効な xlsx ではありません');
  const rels = list(read('xl/_rels/workbook.xml.rels')?.Relationships?.Relationship);
  const textRun = (value) => (typeof value === 'string' ? value : value?.['#text'] ?? '');
  const rich = (si) => (si?.t != null ? textRun(si.t) : list(si?.r).map((r) => textRun(r.t)).join(''));
  const shared = list(read('xl/sharedStrings.xml')?.sst?.si).map(rich);
  const styles = read('xl/styles.xml')?.styleSheet ?? {};
  const fills = list(styles.fills?.fill).map((fill) => {
    const pattern = fill?.patternFill;
    if (!pattern || pattern['@patternType'] !== 'solid') return null;
    return pattern.fgColor?.['@rgb'] ?? (pattern.fgColor?.['@theme'] != null ? `theme:${pattern.fgColor['@theme']}` : null);
  });
  const xfFill = list(styles.cellXfs?.xf).map((xf) => fills[Number(xf['@fillId'] ?? 0)] ?? null);
  return list(book.sheets?.sheet).map((sheet) => {
    const rel = rels.find((x) => x['@Id'] === (sheet['@r:id'] ?? sheet['@id']));
    if (!rel || rel['@TargetMode'] === 'External') throw new Error('シートの参照が不正です');
    const path = String(rel['@Target']).startsWith('/') ? String(rel['@Target']).slice(1) : `xl/${rel['@Target']}`;
    if (path.includes('..')) throw new Error('シートのパスが不正です');
    const content = read(path)?.worksheet;
    if (!content) throw new Error('シートを取得できません');
    const cells = new Map();
    for (const row of list(content.sheetData?.row)) {
      for (const c of list(row.c)) {
        const ref = String(c['@r'] ?? '');
        const m = ref.match(/^([A-Z]+)(\d+)$/);
        if (!m) throw new Error('セル位置が不正です');
        const t = c['@t'];
        let value = c.v == null ? null : textRun(c.v);
        if (t === 'inlineStr') value = rich(c.is);
        else if (t === 's') value = shared[Number(value)] ?? null;
        else if (t === 'e') value = null;
        else if (value !== null && t !== 'str' && t !== 'b') { const n = Number(value); value = Number.isFinite(n) ? n : null; }
        const formula = c.f == null ? null : String(textRun(c.f) || (c.f?.['@t'] ? `shared:${c.f['@si']}` : ''));
        const fill = xfFill[Number(c['@s'] ?? 0)] ?? null;
        if (value === null && formula === null && fill === null) continue;
        cells.set(ref, {ref, row: Number(m[2]), col: columnIndex(m[1]), value, formula, fill, error: t === 'e'});
      }
    }
    return {name: String(sheet['@name']), cells};
  });
}

const textOf = (cell) => (cell && typeof cell.value === 'string' ? cell.value : '');
const numberOf = (cell) => (cell && typeof cell.value === 'number' ? cell.value : null);
// 円の値。整数でない値（式が端数を出した）は読まずに例外へ回す（丸めない。docs/rules/money.md）
const yenOf = (cell) => { const n = numberOf(cell); return n == null || !Number.isSafeInteger(n) ? null : n; };
const fractionalYen = (cell) => { const n = numberOf(cell); return n != null && !Number.isSafeInteger(n); };
// 確定の印: 名前か金額のセルの塗りが、定義の色（16進6桁。ARGB の後ろ6桁で照らす）のどれか
const confirmedByFill = (cells, fills) => cells.some((cell) => typeof cell?.fill === 'string' && fills.some((fill) => cell.fill.toUpperCase().endsWith(fill)));

// 見出しの上の要約（制作費見積り・消費税・合計金額）と見出しの項目（作成日）は、名前の右にある最初の値を読む。要約は stated に足す
function readHeaderArea(byRow, rows, headerRow, stated, definition) {
  const header = {notes: []};
  for (const r of rows.filter((row) => row < headerRow)) {
    const cells = byRow.get(r);
    for (const cell of cells) {
      const label = normalizeLabel(cell.value);
      if (!label) continue;
      const next = cells.find((other) => other.col > cell.col && other.value !== null && String(other.value).trim() !== '');
      const summary = firstTarget(definition.summary, cell.value);
      if (summary && stated[summary] == null) { stated[summary] = {yen: yenOf(next), cell: next?.ref ?? cell.ref, formula: next?.formula ?? null}; continue; }
      const field = firstTarget(definition.headerFields, cell.value);
      if (field === 'createdOn' && next) { header.createdOn = typeof next.value === 'number' ? excelSerialDate(next.value) : String(next.value).trim().slice(0, 10); continue; }
      if (definition.notes?.test(cell.value)) header.notes.push(String(cell.value).normalize('NFKC').replace(/\s+/g, ' ').trim());
    }
  }
  return header;
}

// 1枚のシートを、検査を通した定義（budget-read-model.mjs の compileBudgetReadDefinition）の読み方で読む。
// 区分の明細・原本に書かれた合計・見出しの項目・取り込まない部分を返す。定義の見出しが無ければ {ok: false, reason: 'no_header'}
export function readBudgetSheet(sheet, definition, {keepEmpty = false} = {}) {
  if (definition?.layout === 'code_detail') return readCodeDetailSheet(sheet, definition, {keepEmpty});
  if (definition?.layout !== 'category_blocks') throw new Error('読み取りの定義の読み方が分かりません');
  return readCategoryBlocksSheet(sheet, definition, {keepEmpty});
}

const sheetRows = (sheet) => {
  const byRow = new Map();
  for (const cell of sheet.cells.values()) { if (!byRow.has(cell.row)) byRow.set(cell.row, []); byRow.get(cell.row).push(cell); }
  for (const cells of byRow.values()) cells.sort((a, b) => a.col - b.col);
  return {byRow, rows: [...byRow.keys()].sort((a, b) => a - b)};
};
const NO_HEADER = Object.freeze({ok: false, reason: 'no_header'});

// ---------------------------------------------------------------- 読み方 category_blocks（「科目」の区画）
// 見出しの名前（定義の header.roles）で「科目」の役の右に単価・数量・金額が並ぶ所を区画として拾い（左右に2つまで）、
// 単価・数量・単位の列に小計の印（定義の subtotalMarkers）のある行で区分を閉じる。区分は行の名前の先頭の英字（A〜K）、分からなければ小計の並び
function readCategoryBlocksSheet(sheet, definition, {keepEmpty}) {
  const at = (row, col) => sheet.cells.get(`${columnLetters(col)}${row}`);
  const {byRow, rows} = sheetRows(sheet);
  const roleOf = (cell) => definition.roles.get(normalizeLabel(cell.value));

  // 見出しの行: 「科目」の右に単価・数量・金額が並ぶ所を、表の区画として拾う（1行に2区画まで並ぶ形を読む）
  const blocks = [];
  for (const r of rows) {
    const cells = byRow.get(r);
    for (const start of cells.filter((cell) => roleOf(cell) === 'name')) {
      const columns = {name: start.col};
      for (const cell of cells) {
        if (cell.col <= start.col || cell.col > start.col + 8) continue;
        const role = roleOf(cell);
        if (!role || role === 'name') { if (role === 'name') break; continue; }
        if (columns[role] == null) columns[role] = cell.col;
      }
      if (columns.amount != null) blocks.push({headerRow: r, columns, headerCell: start.ref});
    }
  }
  if (!blocks.length) return NO_HEADER;
  const headerRow = Math.min(...blocks.map((block) => block.headerRow));

  const lines = [];
  const categories = {};
  const uncategorized = [];
  const unknownSubtotals = [];
  const stated = {};
  const ignored = [];
  let emptyRows = 0;
  const withoutValue = [];
  const fractional = [];
  const seenCategory = new Set();
  const inferredCategories = [];
  let nextCategory = 0;

  for (const block of blocks) {
    let pending = [];
    for (const r of rows.filter((row) => row > block.headerRow)) {
      const nameCell = at(r, block.columns.name);
      const label = textOf(nameCell).trim();
      const marker = [block.columns.unitPrice, block.columns.qty, block.columns.unit].map((col) => col && normalizeLabel(textOf(at(r, col)))).find(Boolean);
      const amountCell = at(r, block.columns.amount);
      if (marker && definition.subtotalMarkers.includes(marker) && label) {
        let code = categoryFromLabel(label);
        // 名前で区分が分からない小計の行（名前を変えた・伏せた予算書）は、小計の行の並び（左の区画で A〜E、右で F〜K）から次の区分を当て、補った印を付ける
        // 「L 雑費」のように区分の英字を書いた行は当てない（A〜K の外を書いた行は区分違いの例外のまま）
        if (!code && !/^[A-Za-zＡ-Ｚａ-ｚ][\s　.．:：]/u.test(label) && CATEGORY_CODES[nextCategory] && !seenCategory.has(CATEGORY_CODES[nextCategory])) {
          code = CATEGORY_CODES[nextCategory];
          inferredCategories.push({cell: nameCell.ref, label, code});
        }
        if (!code || seenCategory.has(code)) { unknownSubtotals.push({cell: nameCell.ref, label}); uncategorized.push(...pending); pending = []; continue; }
        seenCategory.add(code);
        nextCategory = CATEGORY_CODES.indexOf(code) + 1;
        categories[code] = {label, cell: nameCell.ref, subtotal: {yen: yenOf(amountCell), cell: amountCell?.ref ?? null, formula: amountCell?.formula ?? null}};
        pending.forEach((line, i) => lines.push({...line, categoryCode: code, lineNo: i + 1}));
        pending = [];
        continue;
      }
      const totalKind = firstTarget(definition.totals, label);
      if (totalKind) {
        if (stated[totalKind] == null) stated[totalKind] = {yen: yenOf(amountCell), cell: amountCell?.ref ?? nameCell.ref, formula: amountCell?.formula ?? null};
        continue;
      }
      const unitPrice = block.columns.unitPrice ? yenOf(at(r, block.columns.unitPrice)) : null;
      const qtyValue = block.columns.qty ? numberOf(at(r, block.columns.qty)) : null;
      let amount = yenOf(amountCell);
      const marks = [];
      if (fractionalYen(amountCell)) { fractional.push(amountCell.ref); continue; }
      if (amount == null && amountCell?.formula) { withoutValue.push(amountCell.ref); continue; }
      const breakdownRef = amountCell?.formula ? parseBreakdownFormula(amountCell.formula, (ref) => textOf(sheet.cells.get(ref))) : null;
      // 型（keepEmpty）は額の無い行も費目として残す。内訳を別のシートから足す行は、額が0でも内訳を読むために残す
      if (!label || ((amount == null || amount === 0) && !keepEmpty && !breakdownRef)) { if (label || amount != null) emptyRows += 1; continue; }
      if (amount == null) amount = 0;
      if (amount < 0) { uncategorized.push({cell: nameCell?.ref ?? amountCell.ref, name: label, amountExTaxYen: amount, negative: true}); continue; }
      const confirmed = confirmedByFill([nameCell, amountCell], definition.confirmedFills);
      if (confirmed) marks.push('confirmed_from_fill');
      pending.push({name: label, unitPriceYen: unitPrice, qtyMilli: qtyValue == null ? null : scaledInteger(qtyValue, 3),
        unit: block.columns.unit ? (textOf(at(r, block.columns.unit)).trim() || null) : null, amountExTaxYen: amount, confirmed,
        sourceRow: r, cell: nameCell?.ref ?? amountCell?.ref, marks, ...(breakdownRef ? {breakdownRef, amountCell: amountCell.ref} : {})});
    }
    uncategorized.push(...pending);
  }

  const header = readHeaderArea(byRow, rows, headerRow, stated, definition);
  // 区画の外の見出し（キャストの別表の「役名」など。定義の ignore）は取り込まない（個人の名前と額を持たない。会社ルートの計画の問い8）
  for (const cell of byRow.get(headerRow) ?? []) {
    const kind = firstTarget(definition.ignore, cell.value);
    if (kind) ignored.push({kind, cell: cell.ref});
  }
  const managementFeeYen = stated.managementFee?.yen ?? null;
  const contingencyYen = stated.contingency?.yen ?? null;
  return {ok: true, sheet: sheet.name, blocks: blocks.map((block) => ({headerCell: block.headerCell, columns: block.columns})),
    header, lines, categories, uncategorized, unknownSubtotals, emptyRows, ignored, withoutValue, fractional, inferredCategories,
    stated: {...stated, managementFeeYen, contingencyYen}};
}

// ---------------------------------------------------------------- 読み方 code_detail（Code・Detail・Description の1区画）
// 見出し（定義の header.roles）に name・description・amount の役が揃う最初の行を見出しにする。明細は 合計 = 数×単価 の行。
// 区分の小計は合計が同じ列の範囲の SUM（SUM(F5:F16)）の行で、明細はその範囲から決める（読み方 sum_range_of_amount_column）。
// 節の合計（合計が小計を並べた SUM）は読まない。そのうち名前が定義の grandTotal に当たる行だけを原本の総合計にする。
// 区分は小計の行の名前を定義の categories に上から順に当てて決める（同じ区分に当たる小計が複数あれば1つの区分にまとめる）。
// 名前で決まらなければ、範囲の明細の名前を同じ規則に当てて最も多い区分を補い（「並びから当てた区分」の印）、それでも決まらなければ A〜K に当たらない区分の例外にする
// （読み方 words_then_line_majority）。
const SUM_RANGE = /^SUM\(\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?\)$/i;
const SUM_LIST = /^SUM\(\$?[A-Z]+\$?\d+(?:[,+]\$?[A-Z]+\$?\d+)+\)$/i;

function readCodeDetailSheet(sheet, definition, {keepEmpty = false} = {}) {
  const at = (row, col) => sheet.cells.get(`${columnLetters(col)}${row}`);
  const {byRow, rows} = sheetRows(sheet);
  const categoryOf = (label) => firstTarget(definition.categories, label);
  let headerRow = null;
  let columns = null;
  for (const r of rows) {
    const found = {};
    for (const cell of byRow.get(r)) {
      const role = definition.roles.get(normalizeLabel(cell.value));
      if (role && found[role] == null) found[role] = cell.col;
    }
    if (found.name != null && found.description != null && found.amount != null) { headerRow = r; columns = found; break; }
  }
  if (headerRow == null) return NO_HEADER;
  const amountLetters = columnLetters(columns.amount);
  const textAt = (r, col) => (col == null ? '' : textOf(at(r, col)).normalize('NFKC').replace(/\s+/g, ' ').trim());

  // 区分の小計の行（合計が同じ列の範囲の SUM）と、節の合計の行（小計を並べた SUM）
  const subtotals = [];
  const sectionRows = new Set();
  const stated = {};
  for (const r of rows.filter((row) => row > headerRow)) {
    const amountCell = at(r, columns.amount);
    const formula = String(amountCell?.formula ?? '').replace(/\s+/g, '');
    const range = formula.match(SUM_RANGE);
    if (range && range[1].toUpperCase() === amountLetters && (!range[3] || range[3].toUpperCase() === amountLetters)) {
      const from = Number(range[2]);
      const to = Number(range[4] ?? range[2]);
      if (from > headerRow && from <= to && to < r) {
        subtotals.push({row: r, from, to, label: textAt(r, columns.name), cell: at(r, columns.name)?.ref ?? amountCell.ref, amountCell});
        continue;
      }
    }
    if (SUM_LIST.test(formula)) {
      sectionRows.add(r);
      const label = [columns.code, columns.name].map((col) => textAt(r, col)).join('');
      if (definition.grandTotal?.test(label) && stated.total == null) stated.total = {yen: yenOf(amountCell), cell: amountCell.ref, formula: amountCell.formula};
    }
  }
  const subtotalRows = new Set(subtotals.map((item) => item.row));
  // 行 → その行を範囲に含む小計（範囲の狭いものを優先）
  const ownerOf = (r) => subtotals.filter((item) => item.from <= r && r <= item.to).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] ?? null;

  const raw = [];
  const withoutValue = [];
  const fractional = [];
  let emptyRows = 0;
  let lastName = '';
  let lastOwner;
  for (const r of rows.filter((row) => row > headerRow && !subtotalRows.has(row) && !sectionRows.has(row))) {
    const owner = ownerOf(r);
    if (owner !== lastOwner) { lastName = ''; lastOwner = owner; }
    const detail = textAt(r, columns.name);
    if (detail) lastName = detail;
    const description = textAt(r, columns.description);
    // Detail が空で Description だけの行は、同じ小計の中の直前の Detail を前に付ける（「ロケハン」の下の「ガソリン代」）
    const name = [detail || (description ? lastName : ''), description].filter(Boolean).join(' ');
    const amountCell = at(r, columns.amount);
    if (fractionalYen(amountCell)) { fractional.push(amountCell.ref); continue; }
    let amount = yenOf(amountCell);
    if (amount == null && amountCell?.formula && name) { withoutValue.push(amountCell.ref); continue; }
    if (!name || ((amount == null || amount === 0) && !keepEmpty)) { if (name || amount) emptyRows += 1; continue; }
    if (amount == null) amount = 0;
    const nameCell = at(r, columns.name) ?? at(r, columns.description);
    const qtyValue = columns.qty != null ? numberOf(at(r, columns.qty)) : null;
    const confirmed = confirmedByFill([nameCell, amountCell], definition.confirmedFills);
    raw.push({owner, line: {name, unitPriceYen: columns.unitPrice != null ? yenOf(at(r, columns.unitPrice)) : null,
      qtyMilli: qtyValue == null ? null : scaledInteger(qtyValue, 3), unit: columns.unit != null ? (textAt(r, columns.unit) || null) : null,
      amountExTaxYen: amount, confirmed, sourceRow: r, cell: nameCell?.ref ?? amountCell?.ref, marks: confirmed ? ['confirmed_from_fill'] : []}});
  }

  // 小計ごとに区分を決める
  const categories = {};
  const unknownSubtotals = [];
  const inferredCategories = [];
  const ignored = [];
  const codeOf = new Map();
  let managementFeeYen = null;
  let contingencyYen = null;
  for (const item of subtotals) {
    let code = categoryOf(item.label);
    if (!code) {
      const votes = new Map();
      for (const {owner, line} of raw) {
        if (owner !== item) continue;
        const vote = categoryOf(line.name);
        if (CATEGORY_CODES.includes(vote)) votes.set(vote, (votes.get(vote) ?? 0) + 1);
      }
      const best = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      if (best) { code = best[0]; inferredCategories.push({cell: item.cell, label: item.label, code}); }
    }
    codeOf.set(item, code);
    const yen = yenOf(item.amountCell);
    if (code === 'managementFee') { managementFeeYen = (managementFeeYen ?? 0) + (yen ?? 0); continue; }
    if (code === 'contingency') { contingencyYen = (contingencyYen ?? 0) + (yen ?? 0); continue; }
    // 区分の分からない小計でも、額が0で明細も無ければ取り込まない（使っていない費目の枠）。額か明細があれば A〜K に当たらない区分の例外
    if (!code && yen === 0 && !raw.some((entry) => entry.owner === item)) { ignored.push({kind: 'empty_subtotal', cell: item.cell}); continue; }
    if (!code) { unknownSubtotals.push({cell: item.cell, label: item.label}); continue; }
    if (!categories[code]) categories[code] = {label: item.label, cell: item.cell, subtotal: {yen: 0, cell: item.amountCell.ref, formula: item.amountCell.formula ?? null}, parts: []};
    const category = categories[code];
    category.parts.push({label: item.label, cell: item.cell, yen});
    category.subtotal.yen = category.subtotal.yen == null || yen == null ? null : category.subtotal.yen + yen;
    if (category.parts.length > 1) { category.subtotal.cell = `${category.subtotal.cell}+${item.amountCell.ref}`; category.subtotal.formula = null; }
  }

  const lines = [];
  const uncategorized = [];
  const lineNo = new Map();
  for (const {owner, line} of raw) {
    const code = owner ? codeOf.get(owner) : null;
    if (code === 'managementFee' || code === 'contingency') continue;
    if (!code || line.amountExTaxYen < 0) {
      uncategorized.push({cell: line.cell, name: line.name, amountExTaxYen: line.amountExTaxYen, ...(line.amountExTaxYen < 0 ? {negative: true} : {})});
      continue;
    }
    lineNo.set(code, (lineNo.get(code) ?? 0) + 1);
    lines.push({...line, categoryCode: code, lineNo: lineNo.get(code)});
  }
  lines.sort((a, b) => CATEGORY_CODES.indexOf(a.categoryCode) - CATEGORY_CODES.indexOf(b.categoryCode) || a.lineNo - b.lineNo);

  const header = readHeaderArea(byRow, rows, headerRow, stated, definition);
  return {ok: true, sheet: sheet.name, form: 'code_detail', blocks: [{headerCell: at(headerRow, columns.name)?.ref ?? null, columns}],
    header, lines, categories, uncategorized, unknownSubtotals, emptyRows, ignored, withoutValue, fractional, inferredCategories,
    stated: {...stated, managementFeeYen, contingencyYen}};
}

// DB を使わずに読むときの定義: 種（budget-read-seeds.mjs）の2つ。組織の受け口は、その組織の使用中の版を渡す（budget-routes.mjs）
export const SEED_READ_DEFINITIONS = Object.freeze(BUDGET_READ_SEEDS.map((seed) => Object.freeze({readVersionId: null, name: seed.name, versionNo: 1,
  definition: seed.definition})));

// 予算書のシートを探して読む。シートを前から順に、定義を渡された順に当て、最初に読めたシートと定義を使う（2枚目の仮払い・領収書のまとめは読まない）。
// definitions は [{readVersionId, name, versionNo, definition}]（definition は JSON の定義。ここで検査する）。
// 検査を通らない定義は飛ばして残りで読み、飛ばした定義（名前・版・誤り）を skippedDefinitions に返す。1つも通らなければ止める。
// 返す readDefinition に、読めた定義の版（readVersionId・名前・版の番号）を残す（FR-PLAN-BUDGET-038）
export function readBudgetFile(input, {keepEmpty = false, definitions = SEED_READ_DEFINITIONS} = {}) {
  if (!Array.isArray(definitions) || !definitions.length) throw new Error('使用中の読み取りの定義がありません');
  const readers = [];
  const skippedDefinitions = [];
  for (const entry of definitions) {
    const checked = checkBudgetReadDefinition(entry.definition);
    const label = {readVersionId: entry.readVersionId ?? null, name: entry.name ?? null, versionNo: entry.versionNo ?? null};
    if (checked.ok) readers.push({entry, definition: checked.definition});
    else skippedDefinitions.push({...label, errors: checked.errors});
  }
  if (!readers.length) {
    throw new Error(`読み取りの定義が正しくありません: ${skippedDefinitions.map((skip) => `${skip.name ?? '名前なし'} 版${skip.versionNo ?? '—'}（${skip.errors.join('／')}）`).join('、')}`);
  }
  const sheets = readBudgetWorkbook(input);
  for (const sheet of sheets) {
    for (const {entry, definition} of readers) {
      const parsed = readBudgetSheet(sheet, definition, {keepEmpty});
      if (!parsed.ok) continue;
      const breakdownChecks = resolveBreakdowns(parsed, sheets, definition);
      const used = new Set(breakdownChecks.map((check) => check.sheet));
      return {...parsed, readDefinition: {readVersionId: entry.readVersionId ?? null, name: entry.name ?? definition.name, versionNo: entry.versionNo ?? null},
        skippedDefinitions, breakdownChecks, breakdownSheets: [...used],
        otherSheets: sheets.filter((other) => other !== sheet && !used.has(other.name)).map((other) => other.name)};
    }
  }
  return {ok: false, reason: 'no_header', message: `読み取りの定義（${readers.map(({entry, definition}) => entry.name ?? definition.name).join('・')}）の見出しのあるシートがありません（形違い）`,
    sheets: sheets.map((sheet) => sheet.name), skippedDefinitions};
}

// 行の金額の数式が別のシートを足しているか（SUMIF(範囲, 条件, 足す範囲) か SUM(シート!範囲)）。条件がセルなら、そのセルの文字に読み替える
const REF = String.raw`(?:'((?:[^']|'')+)'|([^\s!'(),=+*/:<>&-]+))!\$?([A-Z]+)\$?(\d+)?(?::\$?([A-Z]+)\$?(\d+)?)?`;
export function parseBreakdownFormula(formula, cellText = () => '') {
  const text = String(formula).replace(/^=/, '');
  const ref = (m, i) => ({sheet: (m[i] ?? '').replaceAll("''", "'") || m[i + 1], col: m[i + 2], from: m[i + 3] ? Number(m[i + 3]) : null, toCol: m[i + 4] ?? m[i + 2], to: m[i + 5] ? Number(m[i + 5]) : null});
  const sumif = new RegExp(String.raw`^SUMIF\(\s*${REF}\s*,\s*([^,]+?)\s*,\s*${REF}\s*\)$`, 'i').exec(text);
  if (sumif) {
    const range = ref(sumif, 1);
    const sum = ref(sumif, 8);
    const rawCriteria = sumif[7].trim();
    const criteria = /^"(.*)"$/.test(rawCriteria) ? rawCriteria.slice(1, -1) : /^\$?[A-Z]+\$?\d+$/.test(rawCriteria) ? cellText(rawCriteria.replaceAll('$', '')) : null;
    if (range.sheet !== sum.sheet || criteria == null) return {kind: 'unsupported', formula: text};
    return {kind: 'sumif', sheet: range.sheet, criteriaCol: range.col, sumCol: sum.col, from: sum.from ?? range.from, to: sum.to ?? range.to, criteria};
  }
  const plain = new RegExp(String.raw`^SUM\(\s*${REF}\s*\)$`, 'i').exec(text);
  if (plain) { const r = ref(plain, 1); return {kind: 'sum', sheet: r.sheet, sumCol: r.col, from: r.from, to: r.to}; }
  return null;
}

// 内訳のシートを読み、行に内訳を付ける。内訳の行は条件の列が行の名前と同じ行で、範囲（SUMIF の行）の外の行も拾って「範囲の外」に印を付ける。
// 行の金額は内訳の和に置き換え、原本に保存された行の額（SUMIF の結果）との照らしを返す
// 内訳のシートの見出しの語（金額の列の見出し・名目・数量・単価の列）は定義の breakdown から受け取る
function resolveBreakdowns(parsed, sheets, definition) {
  const words = definition.breakdown ?? {};
  const checks = [];
  for (const line of parsed.lines) {
    const ref = line.breakdownRef;
    if (!ref) continue;
    const statedYen = line.amountExTaxYen;
    const sheet = sheets.find((candidate) => candidate.name === ref.sheet);
    if (!sheet || ref.kind === 'unsupported') { checks.push({cell: line.amountCell, sheet: ref.sheet ?? null, ok: false, reason: ref.kind === 'unsupported' ? 'unsupported_formula' : 'missing_sheet', statedYen, derivedYen: null, outside: []}); continue; }
    const rows = new Map();
    for (const cell of sheet.cells.values()) { if (!rows.has(cell.row)) rows.set(cell.row, new Map()); rows.get(cell.row).set(columnIndex(cell.ref.match(/^[A-Z]+/)[0]), cell); }
    const sumIdx = columnIndex(ref.sumCol);
    const criteriaIdx = ref.kind === 'sumif' ? columnIndex(ref.criteriaCol) : null;
    // 見出しの行（「金額」の列の上の文字）から、名目・数量・単価の列を探す
    let headerRow = null;
    for (const [r, cells] of [...rows].sort((a, b) => a[0] - b[0])) if (typeof cells.get(sumIdx)?.value === 'string' && words.amountHeader?.test(cells.get(sumIdx).value)) { headerRow = r; break; }
    const headerCells = headerRow ? rows.get(headerRow) : new Map();
    const findCol = (matcher) => (matcher ? [...headerCells].find(([, cell]) => matcher.test(cell.value))?.[0] ?? null : null);
    const labelIdx = findCol(words.label) ?? (criteriaIdx != null ? criteriaIdx + 1 : sumIdx - 1);
    const qtyIdx = findCol(words.qty);
    const priceIdx = findCol(words.unitPrice);
    const items = [];
    for (const [r, cells] of [...rows].sort((a, b) => a[0] - b[0])) {
      if (headerRow != null && r <= headerRow) continue;
      if (ref.kind === 'sumif' && normalizeLabel(cells.get(criteriaIdx)?.value) !== normalizeLabel(ref.criteria)) continue;
      const amountCell = cells.get(sumIdx);
      const amount = yenOf(amountCell);
      if (amount == null || amount === 0) continue;
      const inRange = (ref.from == null || r >= ref.from) && (ref.to == null || r <= ref.to);
      const qty = qtyIdx ? numberOf(cells.get(qtyIdx)) : null;
      items.push({label: textOf(cells.get(labelIdx)).trim() || `${ref.sheet} ${r}行`, qtyMilli: qty == null ? null : scaledInteger(qty, 3),
        unitPriceYen: priceIdx ? yenOf(cells.get(priceIdx)) : null, amountExTaxYen: amount, cell: amountCell.ref, sourceRow: r, inRange});
    }
    const derivedYen = items.reduce((sum, item) => sum + item.amountExTaxYen, 0);
    const outside = items.filter((item) => !item.inRange).map((item) => item.cell);
    line.breakdown = {sheet: ref.sheet, items, statedYen};
    line.amountExTaxYen = derivedYen;
    checks.push({cell: line.amountCell, sheet: ref.sheet, name: line.name, ok: statedYen === derivedYen, reason: outside.length ? 'outside_range' : statedYen === derivedYen ? null : 'mismatch',
      statedYen, derivedYen, outside});
  }
  return checks;
}

function excelSerialDate(serial) {
  // 日付だけのセルは整数の通し番号。時刻つき（端数あり）は日付として読まない
  if (!Number.isSafeInteger(serial)) return undefined;
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
}
