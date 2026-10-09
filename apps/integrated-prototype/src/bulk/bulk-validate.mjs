// Excel一括登録の検証（DB に依存しない純関数）。サーバーのプレビュー・登録と試験が使う。
// 1行ごとに「追加・修正・承認が必要・変更なし・エラー」を判定し、セル単位の理由と、修正前後の値を返す。
import {entityDef, REFERENCE_PREFIX} from './bulk-entities.mjs';
import {DOMAINS} from '../ui/labels.mjs';
import {parseYen, parseInteger, parseDate, parseMonth} from '../ui/parse-input.mjs';

const normalizeHeader = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
const blank = (value) => value === null || value === undefined || String(value).trim() === '';

export function mapHeaders(entity, headers = []) {
  const def = entityDef(entity);
  const byHeader = new Map();
  for (const column of def.columns) {
    byHeader.set(normalizeHeader(column.header), column.key);
    byHeader.set(normalizeHeader(column.key), column.key);
  }
  const columns = new Map();
  const ignored = [];
  const unknown = [];
  const duplicate = [];
  headers.forEach((header, index) => {
    const text = String(header ?? '').trim();
    if (!text) return;
    if (text.normalize('NFKC').startsWith(REFERENCE_PREFIX.normalize('NFKC'))) { ignored.push(text); return; }
    const key = byHeader.get(normalizeHeader(text));
    if (!key) { unknown.push(text); return; }
    if ([...columns.values()].includes(key)) { duplicate.push(text); return; }
    columns.set(index, key);
  });
  const present = new Set(columns.values());
  const missingRequired = def.columns.filter((column) => column.required && !present.has(column.key) && column.key !== def.key).map((column) => column.header);
  if (def.key !== 'id' && !present.has(def.key)) missingRequired.unshift(def.columns.find((c) => c.key === def.key).header);
  return {columns, ignored, unknown, duplicate, missingRequired};
}

// 見出し行の推定: 必須の見出しが最も多く含まれる行（先頭20行まで）
export function detectHeaderRow(entity, sheetRows = []) {
  const def = entityDef(entity);
  const wanted = new Set(def.columns.flatMap((column) => [normalizeHeader(column.header), normalizeHeader(column.key)]));
  let best = {index: -1, score: 0};
  sheetRows.slice(0, 20).forEach((row, index) => {
    const score = (row || []).filter((cell) => wanted.has(normalizeHeader(cell))).length;
    if (score > best.score) best = {index, score};
  });
  return best.index;
}

function domainOptions(domain) {
  return Object.entries(DOMAINS[domain] || {});
}

function parsePercent(raw) {
  const text = String(raw).normalize('NFKC').replace(/[%％\s,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return {error: '配賦率は0より大きく100以下の数（小数は2桁まで）で入れてください'};
  const bps = Math.round(Number(text) * 100);
  if (bps <= 0 || bps > 10000) return {error: '配賦率は0より大きく100以下にしてください'};
  return {value: bps};
}

export function parseCell(column, raw, ctx = {}) {
  if (blank(raw)) return column.required ? {error: `${column.header}を入れてください`} : {value: null};
  const text = typeof raw === 'string' ? raw.trim() : raw;
  switch (column.type) {
    case 'code': {
      const value = String(text).normalize('NFKC').trim();
      if (/\s/.test(value) || value.length > 50) return {error: `${column.header}は空白を含まない50文字以内にしてください`};
      return {value};
    }
    case 'text': {
      const value = String(text);
      if (column.max && value.length > column.max) return {error: `${column.header}は${column.max}文字以内にしてください`};
      return {value};
    }
    case 'yen':
    case 'int': {
      const parsed = column.type === 'yen' ? parseYen(String(text), {allowNegative: Boolean(column.allowNegative)}) : parseInteger(String(text), {allowNegative: Boolean(column.allowNegative)});
      if (!parsed.ok) return {error: `${column.header}: ${parsed.error}`};
      if (column.min !== undefined && parsed.value < column.min) return {error: `${column.header}は${column.min}以上にしてください`};
      return {value: parsed.value};
    }
    case 'date': {
      const parsed = parseDate(String(text));
      return parsed.ok ? {value: parsed.value} : {error: `${column.header}: ${parsed.error}`};
    }
    case 'month': {
      const parsed = parseMonth(String(text));
      return parsed.ok ? {value: parsed.value} : {error: `${column.header}: ${parsed.error}`};
    }
    case 'select': {
      const value = String(text).normalize('NFKC').trim();
      const options = domainOptions(column.domain);
      const hit = options.find(([code, label]) => code === value || label.normalize('NFKC') === value);
      if (!hit) return {error: `${column.header}は「${options.map(([, label]) => label).join('・')}」のどれかにしてください`};
      return {value: hit[0]};
    }
    case 'lookup': {
      const code = String(text).normalize('NFKC').trim();
      const id = ctx.lookups?.[column.lookup]?.get(code);
      if (id === undefined) return {error: `${column.header}「${code}」は登録されていません`, code};
      return {value: id, code};
    }
    case 'percent':
      return parsePercent(text);
    default:
      return {value: text};
  }
}

const same = (a, b) => (a === null || a === undefined || a === '' ? null : String(a)) === (b === null || b === undefined || b === '' ? null : String(b));

// parsedRows: [{rowNo, cells: {列キー: 生の値}}]
// ctx: {existing: Map(キー→DB行), lookups: {projects|works|partners: Map(コード→ID)}, workProject: Map(作品ID→案件ID),
//       allocations: Map(商品ID→[{workId, bps}]), usedExpenses: Set(経費ID), can(action, values) → null | 理由}
export function planBulk(entity, parsedRows, ctx = {}) {
  const def = entityDef(entity);
  const columns = def.columns;
  const existing = ctx.existing || new Map();
  const seenKeys = new Map();
  const seenExpenseContent = new Map();
  const rows = [];
  for (const source of parsedRows) {
    const cells = source.cells || {};
    if (columns.every((column) => blank(cells[column.key]))) continue;
    const errors = [];
    const values = {};
    const codes = {};
    for (const column of columns) {
      if (!(column.key in cells) && !column.required) continue;
      const parsed = parseCell(column, cells[column.key], ctx);
      if (parsed.error) errors.push({column: column.header, message: parsed.error});
      else values[column.key] = parsed.value;
      if (parsed.code) codes[column.key] = parsed.code;
    }
    // 導出・相互の検査
    if (entity === 'expenses') {
      if (values.accounting_month == null && values.incurred_on) values.accounting_month = values.incurred_on.slice(0, 7);
      if (values.actual_ex_tax != null && values.tax_amount != null) {
        const sum = values.actual_ex_tax + values.tax_amount;
        if (values.actual_inc_tax == null) values.actual_inc_tax = sum;
        else if (values.actual_inc_tax !== sum) errors.push({column: '実績税込（円）', message: `実績税込は税抜＋税額（${sum.toLocaleString('ja-JP')}円）と一致させてください`});
      }
      if (values.work_id != null && values.project_id != null && ctx.workProject?.get(values.work_id) !== values.project_id) {
        errors.push({column: '作品コード', message: '作品が案件に属していません。案件コードと作品コードを確かめてください'});
      }
    }
    let allocations = null;
    if (entity === 'products') {
      allocations = [];
      for (const n of [1, 2, 3]) {
        const work = values[`alloc_work_${n}`], rate = values[`alloc_rate_${n}`];
        if (work == null && rate == null) continue;
        if (work == null || rate == null) { errors.push({column: `配賦先作品コード${n}`, message: `配賦先作品コード${n}と配賦率${n}は両方入れてください`}); continue; }
        allocations.push({workId: work, bps: rate});
      }
      if (allocations.length) {
        if (new Set(allocations.map((a) => a.workId)).size !== allocations.length) errors.push({column: '配賦先作品コード1', message: '同じ作品が複数の配賦列にあります'});
        const total = allocations.reduce((sum, a) => sum + a.bps, 0);
        if (total !== 10000) errors.push({column: '配賦率1（%）', message: `配賦率の合計を100%にしてください（いまは${(total / 100).toFixed(2)}%）`});
      }
    }
    const keyValue = values[def.key];
    const keyText = keyValue == null ? null : String(keyValue);
    if (keyText !== null) {
      if (seenKeys.has(keyText)) errors.push({column: columns.find((c) => c.key === def.key).header, message: `${seenKeys.get(keyText)}行目と同じキーです。1行にまとめてください`});
      else seenKeys.set(keyText, source.rowNo);
    }
    const found = keyText === null ? null : existing.get(keyText) || null;
    // 権限のない案件と同じコード: 中身（ID・状態・版）は返さず、行のエラーにする
    const before = found?.hidden ? null : found;
    if (found?.hidden) errors.push({column: columns.find((c) => c.key === def.key).header, message: `この${def.label}コードは、閲覧できない別の${def.label}で使われています。別のコードにしてください`});
    // 閲覧できない案件の作品などで既に使われているコードは、登録すると重複で失敗するので先に止める
    else if (!found && keyText !== null && ctx.takenKeys?.has(keyText)) errors.push({column: columns.find((c) => c.key === def.key).header, message: `この${def.label}コードは、閲覧できない別の案件で使われています。別のコードにしてください`});
    let action;
    let changes = [];
    let note = '';
    if (entity === 'expenses' && keyText !== null && !before) {
      errors.push({column: '経費ID', message: `経費ID ${keyText} は見つかりません。新規なら空欄にしてください`});
    }
    if (before) {
      changes = columns
        .filter((column) => !column.allocation && column.key !== def.key && Object.hasOwn(values, column.key) && !same(values[column.key], before[column.key]))
        .map((column) => ({key: column.key, header: column.header, before: before[column.key], after: values[column.key]}));
      if (entity === 'products' && allocations?.length) {
        const current = (ctx.allocations?.get(before.id) || []).map((a) => `${a.workId}:${a.bps}`).sort().join(',');
        const next = allocations.map((a) => `${a.workId}:${a.bps}`).sort().join(',');
        if (current !== next) changes.push({key: 'allocations', header: '配賦', before: current || '（なし）', after: next});
      }
    }
    if (errors.length) action = 'error';
    else if (!before) action = 'insert';
    else if (!changes.length) action = 'unchanged';
    else if (def.update === 'direct') {
      if (entity === 'expenses' && ctx.usedExpenses?.has(before.id)) {
        action = 'error';
        errors.push({column: '経費ID', message: '製作委員会の報告で使用済みの経費は変更できません'});
      } else action = 'update';
    } else if (def.update === 'approval') {
      action = 'approval';
      note = changes.some((change) => change.key === 'allocations')
        ? '配賦の変更は「営業案件・契約」の配賦画面で行います。この画面では反映しません'
        : `既存の${def.label}の修正は「マスタの表編集」で承認して反映します。この画面では反映しません`;
    } else {
      action = 'blocked';
      note = `既存の${def.label}はこの画面では修正できません。この行は反映しません`;
    }
    if (action === 'insert' || action === 'update') {
      const denied = ctx.can?.(action, values, before);
      if (denied) { action = 'error'; errors.push({column: '', message: denied}); }
    }
    if (action === 'insert' && entity === 'expenses' && ctx.duplicateExpense?.(values)) {
      action = 'error';
      errors.push({column: '', message: `同じ内容の経費が登録済みです（経費ID ${ctx.duplicateExpense(values)}）。二重登録を防ぐため登録しません`});
    }
    // 同じファイルの中の、同じ内容の新しい経費（2行目以降）も二重登録として止める
    if (action === 'insert' && entity === 'expenses' && ctx.expenseContentKey) {
      const content = ctx.expenseContentKey(values);
      if (seenExpenseContent.has(content)) {
        action = 'error';
        errors.push({column: '', message: `${seenExpenseContent.get(content)}行目と同じ内容の経費です。二重登録を防ぐため登録しません（別の経費なら内容を書き分けてください）`});
      } else seenExpenseContent.set(content, source.rowNo);
    }
    rows.push({rowNo: source.rowNo, action, key: keyText, values, codes, allocations, before, changes, errors, note});
  }
  const fileKeys = new Set(rows.map((row) => row.key).filter(Boolean));
  const missing = [...existing.entries()].filter(([key, row]) => !row?.hidden && !fileKeys.has(key)).length;
  const count = (action) => rows.filter((row) => row.action === action).length;
  return {
    entity, rows, missing,
    summary: {insert: count('insert'), update: count('update'), approval: count('approval') + count('blocked'), unchanged: count('unchanged'), error: count('error'), missing, total: rows.length},
    canCommit: rows.length > 0 && count('error') === 0 && count('insert') + count('update') > 0,
  };
}

// 登録前後の同一性の比較用（プレビューと登録時の再計算が同じ結論か）
export function planFingerprint(plan) {
  return JSON.stringify(plan.rows.map((row) => [row.rowNo, row.action, row.key, row.changes.map((c) => [c.key, String(c.after)]), row.before?.version ?? null]));
}
