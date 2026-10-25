// 予算書の xlsx を読む（要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-008〜011）。
// 予算書は数式で合計を出すので、取込の decodeXlsx（数式を断る）は使わず、セルに保存された値（Excel が最後に計算した値）と数式の有無・塗りの色を読む。
// 形は「科目・単価・数量・単位・金額(税抜)」の見出しの並ぶ表（左右に2つ並んでよい）で、区分ごとに明細の行が続き、「A 企画費 … 小計」の行で区分が閉じる。
// 位置ではなく見出しの名前で列を探すので、列を動かした予算書も読める。どの区分の小計の行にも閉じられない明細と、A〜K に当たらない区分は例外に残す。
import {unzipSync, strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';
import {CATEGORY_CODES, categoryFromLabel, normalizeLabel} from './budget-model.mjs';
import {scaledInteger} from '../../sales-sheet/sales-sheet-input.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const columnIndex = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
export const columnLetters = (index) => { let s = ''; for (let n = index; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// 見出しの名前（正規化したもの）→ 列の役
const HEADER_ROLES = new Map([
  ['科目', 'name'], ['費目', 'name'], ['単価', 'unitPrice'], ['数量', 'qty'], ['単位', 'unit'],
  ['金額税抜', 'amount'], ['金額', 'amount'], ['税抜', 'amount'], ['金額税込', 'amountIncTax'], ['実費', 'actual'],
]);
// 合計の行の名前（正規化したもの）→ 原本に書かれた合計の種類
const TOTAL_LABELS = [
  [/^直接制作費(合計|小計|計)?$/, 'direct'], [/^制作管理費$/, 'managementFee'], [/^予備費$/, 'contingency'],
  [/^総合計(税抜き?)?$/, 'total'], [/^小計$/, 'subtotalWithFee'],
];
const SUMMARY_LABELS = [[/^制作費見積り?(税抜き?)?$/, 'estimate'], [/^消費税/, 'tax'], [/^合計金額(税込)?$/, 'totalIncTax']];
const HEADER_FIELDS = [[/^作成日$/, 'createdOn']];
const YELLOW = /FFFF00$/i;

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

// 1枚のシートから予算書を読む。区分の明細・原本に書かれた合計・見出しの項目・取り込まない部分を返す
export function readBudgetSheet(sheet, {keepEmpty = false} = {}) {
  const at = (row, col) => sheet.cells.get(`${columnLetters(col)}${row}`);
  const byRow = new Map();
  for (const cell of sheet.cells.values()) { if (!byRow.has(cell.row)) byRow.set(cell.row, []); byRow.get(cell.row).push(cell); }
  for (const cells of byRow.values()) cells.sort((a, b) => a.col - b.col);
  const rows = [...byRow.keys()].sort((a, b) => a - b);

  // 見出しの行: 「科目」の右に単価・数量・金額が並ぶ所を、表の区画として拾う（1行に2区画まで並ぶ形を読む）
  const blocks = [];
  for (const r of rows) {
    const cells = byRow.get(r);
    for (const start of cells.filter((cell) => HEADER_ROLES.get(normalizeLabel(cell.value)) === 'name')) {
      const columns = {name: start.col};
      for (const cell of cells) {
        if (cell.col <= start.col || cell.col > start.col + 8) continue;
        const role = HEADER_ROLES.get(normalizeLabel(cell.value));
        if (!role || role === 'name') { if (role === 'name') break; continue; }
        if (columns[role] == null) columns[role] = cell.col;
      }
      if (columns.amount != null) blocks.push({headerRow: r, columns, headerCell: start.ref});
    }
  }
  if (!blocks.length) return {ok: false, reason: 'no_header', message: '「科目」「金額(税抜)」の見出しが見つかりません（形違い）'};
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
      if (marker === '小計' && label) {
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
      const totalKind = TOTAL_LABELS.find(([pattern]) => pattern.test(normalizeLabel(label)))?.[1];
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
      const confirmed = [nameCell, amountCell].some((cell) => cell?.fill && YELLOW.test(cell.fill));
      if (confirmed) marks.push('confirmed_from_fill');
      pending.push({name: label, unitPriceYen: unitPrice, qtyMilli: qtyValue == null ? null : scaledInteger(qtyValue, 3),
        unit: block.columns.unit ? (textOf(at(r, block.columns.unit)).trim() || null) : null, amountExTaxYen: amount, confirmed,
        sourceRow: r, cell: nameCell?.ref ?? amountCell?.ref, marks, ...(breakdownRef ? {breakdownRef, amountCell: amountCell.ref} : {})});
    }
    uncategorized.push(...pending);
  }

  // 見出しの上の要約（制作費見積り・消費税・合計金額）と見出しの項目（作成日）は、名前の右にある最初の値を読む
  const header = {notes: []};
  for (const r of rows.filter((row) => row < headerRow)) {
    const cells = byRow.get(r);
    for (const cell of cells) {
      const label = normalizeLabel(cell.value);
      if (!label) continue;
      const next = cells.find((other) => other.col > cell.col && other.value !== null && String(other.value).trim() !== '');
      const summary = SUMMARY_LABELS.find(([pattern]) => pattern.test(label))?.[1];
      if (summary && stated[summary] == null) { stated[summary] = {yen: yenOf(next), cell: next?.ref ?? cell.ref, formula: next?.formula ?? null}; continue; }
      const field = HEADER_FIELDS.find(([pattern]) => pattern.test(label))?.[1];
      if (field === 'createdOn' && next) { header.createdOn = typeof next.value === 'number' ? excelSerialDate(next.value) : String(next.value).trim().slice(0, 10); continue; }
      if (/準備期間|撮影日数|完成|人数|スタッフ数/.test(label)) header.notes.push(String(cell.value).normalize('NFKC').replace(/\s+/g, ' ').trim());
    }
  }
  // 区画の外の見出し（キャストの別表の「役名」など）は取り込まない（個人の名前と額を持たない。会社ルートの計画の問い8）
  for (const cell of byRow.get(headerRow) ?? []) {
    if (/役名|役者名|所属/.test(String(cell.value ?? ''))) ignored.push({kind: 'cast_table', cell: cell.ref});
  }
  const managementFeeYen = stated.managementFee?.yen ?? null;
  const contingencyYen = stated.contingency?.yen ?? null;
  return {ok: true, sheet: sheet.name, blocks: blocks.map((block) => ({headerCell: block.headerCell, columns: block.columns})),
    header, lines, categories, uncategorized, unknownSubtotals, emptyRows, ignored, withoutValue, fractional, inferredCategories,
    stated: {...stated, managementFeeYen, contingencyYen}};
}

// 予算書のシートを探して読む。「科目」の見出しのあるシートのうち最初の1枚（2枚目の仮払い・領収書のまとめは読まない）
export function readBudgetFile(input, {keepEmpty = false} = {}) {
  const sheets = readBudgetWorkbook(input);
  for (const sheet of sheets) {
    const parsed = readBudgetSheet(sheet, {keepEmpty});
    if (!parsed.ok) continue;
    const breakdownChecks = resolveBreakdowns(parsed, sheets);
    const used = new Set(breakdownChecks.map((check) => check.sheet));
    return {...parsed, breakdownChecks, breakdownSheets: [...used], otherSheets: sheets.filter((other) => other !== sheet && !used.has(other.name)).map((other) => other.name)};
  }
  return {ok: false, reason: 'no_header', message: '「科目」「金額(税抜)」の見出しのあるシートがありません（形違い）', sheets: sheets.map((sheet) => sheet.name)};
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
function resolveBreakdowns(parsed, sheets) {
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
    for (const [r, cells] of [...rows].sort((a, b) => a[0] - b[0])) if (typeof cells.get(sumIdx)?.value === 'string' && /金額|合計/.test(cells.get(sumIdx).value)) { headerRow = r; break; }
    const headerCells = headerRow ? rows.get(headerRow) : new Map();
    const findCol = (pattern) => [...headerCells].find(([, cell]) => pattern.test(normalizeLabel(cell.value)))?.[0] ?? null;
    const labelIdx = findCol(/役名|名目|氏名|項目|内容/) ?? (criteriaIdx != null ? criteriaIdx + 1 : sumIdx - 1);
    const qtyIdx = findCol(/^(数量|日数|人数)/);
    const priceIdx = findCol(/^(単価|日額)/);
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
