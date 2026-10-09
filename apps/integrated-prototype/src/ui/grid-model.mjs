// DataGrid の論理（並べ替え・絞込・合計・小計・セル表示）。React に依存しない純関数。
// 原則: 黙って切らない・0で埋めない・足してはいけない列を足さない。

import {cellText as formatCell, isBlank, isNumericType, toNumber, int, UNKNOWN_TEXT} from './format.mjs';
import {labelOf, columnSpecFor, DEFAULT_HIDDEN_COLUMNS} from './labels.mjs';

export const RENDER_LIMIT = 2000;
export const NOT_SUMMABLE_TEXT = '合計不可';
export const NULL_FILTER = null; // 選択式の絞込で「未確認（空欄）」を表す値
// 行を押したときに開閉しない要素（セルの中の操作・入力）。フォームも入れる（削除の確認の注意文・余白を押しても行を開閉しない）
export const ROW_TOGGLE_IGNORE = 'a,button,input,select,textarea,label,summary,details,form';
// 押した要素 target が、その行 row の中の操作・入力（またはその中）か
export const ignoresRowToggle = (target, row) => { const hit = target?.closest?.(ROW_TOGGLE_IGNORE); return Boolean(hit && row?.contains?.(hit)); };

// ColumnSpec: {key, label, type, domain, total:'sum'|'none'|'not-summable', sticky, hidden, width, align, wrap,
//   value?:(row)=>any（計算列）, render?:(row)=>node（画面だけの表示）, exportValue?:(row)=>any, searchable?:boolean, digits?}
export function valueOf(column, row) {
  if (!row) return undefined;
  return typeof column.value === 'function' ? column.value(row) : row[column.key];
}

export function isNumericColumn(column) {
  return isNumericType(column?.type);
}

export function hasDomain(column) {
  return Boolean(column?.domain) && (column.type === 'status' || column.type === 'code' || column.type === undefined);
}

// 合計の扱い。明示が無ければ金額（yen）だけを足す。整数・率は明示したときだけ。
export function totalMode(column) {
  if (column.total) return column.total;
  return column.type === 'yen' ? 'sum' : 'none';
}

export function cellText(column, value, {blankZero = false} = {}) {
  if (hasDomain(column)) return labelOf(column.domain, value);
  return formatCell(column?.type || 'text', value, {blankZero, digits: column?.digits});
}

export function rowCellText(column, row, options) {
  return cellText(column, valueOf(column, row), options);
}

const collator = new Intl.Collator('ja-JP', {numeric: true, sensitivity: 'base'});

export function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sortKey(column, row) {
  const value = valueOf(column, row);
  if (isBlank(value) || value === '') return null;
  if (isNumericColumn(column)) {
    const n = toNumber(value);
    return n === null ? {text: String(value)} : {number: n};
  }
  if (hasDomain(column)) return {text: labelOf(column.domain, value)};
  if (typeof value === 'number') return {number: value};
  return {text: String(value)};
}

function compareKeys(a, b) {
  if (a.number !== undefined && b.number !== undefined) return a.number - b.number;
  if (a.number !== undefined) return -1; // 数値を文字（HOLD 等）より前に
  if (b.number !== undefined) return 1;
  return collator.compare(a.text, b.text);
}

// 並べ替え。null・空欄は向きにかかわらず末尾。同じ値の順序は元の順を保つ。
export function sortRows(rows, columns, sort) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  if (!sort?.key || !sort.dir) return list;
  const column = columns.find((c) => c.key === sort.key) || {key: sort.key, type: 'text'};
  const direction = sort.dir === 'desc' ? -1 : 1;
  const keyed = list.map((row, index) => ({row, index, key: sortKey(column, row)}));
  keyed.sort((a, b) => {
    if (a.key === null && b.key === null) return a.index - b.index;
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    return compareKeys(a.key, b.key) * direction || a.index - b.index;
  });
  return keyed.map((item) => item.row);
}

// 数値・日付の条件式: ">=1000" "<0" "=0" "100..500" "100〜500"。当てはまらなければ null。
export function parseComparison(text) {
  const source = String(text ?? '').normalize('NFKC').replace(/[,\s¥円]/g, '');
  const range = source.match(/^(-?[\d.]+|\d{4}-\d{2}(?:-\d{2})?)(?:\.\.|〜|~)(-?[\d.]+|\d{4}-\d{2}(?:-\d{2})?)$/);
  if (range) return {op: 'range', from: range[1], to: range[2]};
  const single = source.match(/^(>=|<=|<>|!=|>|<|=)(.+)$/);
  if (single) return {op: single[1] === '<>' ? '!=' : single[1], value: single[2]};
  return null;
}

function compareForFilter(column, raw, target) {
  if (isNumericColumn(column)) {
    const a = toNumber(raw), b = toNumber(target);
    if (a === null || b === null) return null;
    return a - b;
  }
  if (raw == null || raw === '') return null;
  // 日付・月は前方一致を「同じ」とみなす（"2026-09" は 9月中の全日付に当たる）
  const a = String(raw), b = String(target);
  if (a.startsWith(b)) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchesComparison(column, raw, comparison) {
  if (comparison.op === 'range') {
    const low = compareForFilter(column, raw, comparison.from);
    const high = compareForFilter(column, raw, comparison.to);
    if (low === null || high === null) return false;
    return low >= 0 && high <= 0;
  }
  const diff = compareForFilter(column, raw, comparison.value);
  if (diff === null) return false;
  switch (comparison.op) {
    case '>': return diff > 0;
    case '>=': return diff >= 0;
    case '<': return diff < 0;
    case '<=': return diff <= 0;
    case '!=': return diff !== 0;
    default: return diff === 0;
  }
}

function matchesText(column, row, needle) {
  const raw = valueOf(column, row);
  const shown = normalizeText(cellText(column, raw));
  if (shown.includes(needle)) return true;
  return raw != null && normalizeText(raw).includes(needle);
}

function matchesFilter(column, row, filter) {
  if (filter === undefined || filter === '' || (Array.isArray(filter) && filter.length === 0)) return true;
  const raw = valueOf(column, row);
  if (Array.isArray(filter)) {
    const key = isBlank(raw) || raw === '' ? NULL_FILTER : String(raw);
    return filter.some((item) => (item === NULL_FILTER ? key === NULL_FILTER : String(item) === key));
  }
  const text = String(filter).trim();
  if (!text) return true;
  if (isNumericColumn(column) || column.type === 'date' || column.type === 'month' || column.type === 'datetime') {
    const comparison = parseComparison(text);
    if (comparison) return matchesComparison(column, raw, comparison);
  }
  return matchesText(column, row, normalizeText(text));
}

// 絞込。filters は {key: 文字列 | 値の配列}。query は全体検索（空白区切りの語をすべて含む行）。
export function filterRows(rows, columns, filters = {}, query = '') {
  const list = Array.isArray(rows) ? rows : [];
  const active = Object.entries(filters || {})
    .map(([key, filter]) => [columns.find((c) => c.key === key), filter])
    .filter(([column, filter]) => column && !(filter === undefined || filter === '' || (Array.isArray(filter) && !filter.length)));
  const terms = normalizeText(query).split(' ').filter(Boolean);
  const searchable = columns.filter((c) => c.searchable !== false);
  if (!active.length && !terms.length) return list.slice();
  return list.filter((row) => {
    for (const [column, filter] of active) if (!matchesFilter(column, row, filter)) return false;
    if (!terms.length) return true;
    const haystack = searchable.map((column) => {
      const raw = valueOf(column, row);
      return `${normalizeText(cellText(column, raw))} ${raw == null ? '' : normalizeText(raw)}`;
    }).join(' ');
    return terms.every((term) => haystack.includes(term));
  });
}

const tidy = (n) => Math.round(n * 1e6) / 1e6 + 0;

// 絞込後の全行の合計。{key: {value, count, missing}}。not-summable は {notSummable:true}。合計しない列は含めない。
export function totalsFor(rows, columns) {
  const totals = {};
  for (const column of columns) {
    const mode = totalMode(column);
    if (mode === 'not-summable') { totals[column.key] = {notSummable: true}; continue; }
    if (mode !== 'sum') continue;
    let value = 0, count = 0, missing = 0;
    // totalValue: 合計に入れる値（例: 取消済みの請求は行に額を出しつつ合計には入れない）。無ければ表示の値
    for (const row of rows) {
      const n = toNumber(typeof column.totalValue === 'function' ? column.totalValue(row) : valueOf(column, row));
      if (n === null) missing += 1; else { value += n; count += 1; }
    }
    totals[column.key] = {value: tidy(value), count, missing};
  }
  return totals;
}

// 合計の表示文字列。
export function totalText(column, total, {blankZero = false} = {}) {
  if (!total) return '';
  if (total.notSummable) return NOT_SUMMABLE_TEXT;
  const shown = cellText(column, total.value, {blankZero});
  return total.missing ? `${shown}（${UNKNOWN_TEXT}${int(total.missing)}件を除く）` : shown;
}

// 合計を Excel の totals 行の values（{key: 数値 | '合計不可'}）に直す。
export function totalsValues(totals) {
  const values = {};
  for (const [key, total] of Object.entries(totals || {})) values[key] = total.notSummable ? NOT_SUMMABLE_TEXT : total.value;
  return values;
}

// 小計つきの並び。[{type:'row', row} ... {type:'subtotal', group, label, count, totals}]。
// 同じグループの行は最初に現れた位置にまとめる（グループ内の順序は保つ）。
export function withSubtotals(rows, columns, groupKey, label) {
  const keyOf = typeof groupKey === 'function' ? groupKey : (row) => row?.[groupKey];
  const groupColumn = typeof groupKey === 'string' ? columns.find((c) => c.key === groupKey) : null;
  const groups = new Map();
  for (const row of rows || []) {
    const raw = keyOf(row);
    const id = isBlank(raw) || raw === '' ? '\u0000blank' : `v:${String(raw)}`;
    if (!groups.has(id)) groups.set(id, {value: raw, rows: []});
    groups.get(id).rows.push(row);
  }
  const items = [];
  for (const {value, rows: members} of groups.values()) {
    for (const row of members) items.push({type: 'row', row});
    const shown = groupColumn ? cellText(groupColumn, value) : isBlank(value) || value === '' ? UNKNOWN_TEXT : String(value);
    const text = typeof label === 'function' ? label(value, members) : label ? `${shown} ${label}` : `${shown} 小計`;
    items.push({type: 'subtotal', group: value, label: text, count: members.length, totals: totalsFor(members, columns)});
  }
  return items;
}

// 描画する行の上限。超えたら先頭 limit 行だけを描き、件数を示して絞込を促す（合計・出力は全行）。
export function limitItems(items, limit = RENDER_LIMIT) {
  let rowsShown = 0, total = 0;
  const shown = [];
  for (const item of items) {
    if (item.type === 'row') {
      total += 1;
      if (rowsShown < limit) { shown.push(item); rowsShown += 1; }
    } else if (total === rowsShown) {
      shown.push(item); // 小計はそのグループの行をすべて描いたときだけ出す
    }
  }
  return {items: shown, rowsShown, rowsTotal: total, truncated: total > rowsShown};
}

// 絞込の状態を文章にする（出力の条件行・画面の表示用）。
export function describeFilters(columns, filters = {}, query = '') {
  const parts = [];
  for (const [key, filter] of Object.entries(filters || {})) {
    const column = columns.find((c) => c.key === key);
    if (!column || filter === undefined || filter === '' || (Array.isArray(filter) && !filter.length)) continue;
    const text = Array.isArray(filter)
      ? filter.map((item) => (item === NULL_FILTER ? `${UNKNOWN_TEXT}（空欄）` : cellText(column, item))).join('・')
      : String(filter).trim();
    if (text) parts.push(`${column.label ?? key}: ${text}`);
  }
  if (String(query || '').trim()) parts.push(`検索: ${String(query).trim()}`);
  return parts.join(' ／ ');
}

// 行数の表示。「全N行中M行」。
export function countText(total, shown) {
  return total === shown ? `全${int(total)}行` : `全${int(total)}行中${int(shown)}行`;
}

// DataGrid の現在の表示から Excel のシート定義（xlsx-report.mjs の形）を作る。
// groupBy を渡すと、グループごとの小計行（{__kind:'subtotal'}）をはさむ。合計は小計行を含めずに計算する。
export function gridSheetSpec({columns, rows, exportSpec = {}, filters = {}, query = '', totalLabel = '合計', showTotals = true, groupBy, subtotalLabel}) {
  const visible = columns.filter((c) => !c.hidden && c.export !== false);
  const conditions = [...(exportSpec.conditions || [])];
  const filterText = describeFilters(columns, filters, query);
  if (filterText) conditions.push(['絞込', filterText]);
  const totals = totalsFor(rows, visible);
  const hasTotals = showTotals && Object.keys(totals).length > 0;
  const freezeCols = visible.findIndex((c) => !c.sticky);
  const firstKey = visible[0]?.key;
  const outputRows = groupBy
    ? withSubtotals(rows, columns, groupBy, subtotalLabel).map((item) => (item.type === 'row' ? item.row : {
      __kind: 'subtotal',
      ...Object.fromEntries(Object.entries(item.totals).map(([key, total]) => [key, total.notSummable ? NOT_SUMMABLE_TEXT : total.value])),
      ...(firstKey ? {[firstKey]: item.label} : {}),
    }))
    : rows;
  return {
    name: exportSpec.sheetName || exportSpec.name || '一覧',
    title: exportSpec.title || exportSpec.name,
    conditions,
    dataAsOf: exportSpec.dataAsOf,
    // 2段の見出し（group）の列は、出力では「<group> <列名>」の1段にする
    columns: visible.map(({render, ...column}) => (column.group ? {...column, label: `${column.group} ${column.label ?? column.key}`} : column)),
    rows: outputRows,
    totals: hasTotals ? [{label: `${totalLabel}（${int(rows.length)}行）`, values: totalsValues(totals)}] : [],
    notes: exportSpec.notes || [],
    freezeCols: freezeCols === -1 ? visible.length : Math.max(freezeCols, visible.length ? 1 : 0),
  };
}

// 行（または列名の配列）から ColumnSpec を推し量る。汎用一覧（DataTable）の置換用。
// lookups: {列名: [{id, code|sku, title|name}]} を渡すと ID を「コード｜名称」に直して表示・並べ替え・出力する。
export function inferColumns(rowsOrKeys, {resource, domains, lookups = {}, hidden = []} = {}) {
  const keys = Array.isArray(rowsOrKeys) && typeof rowsOrKeys[0] === 'string'
    ? rowsOrKeys
    : [...new Set((rowsOrKeys || []).flatMap((row) => Object.keys(row || {})))];
  return keys.map((key) => {
    let spec = columnSpecFor(key, {resource, domains});
    const list = lookups[key];
    if (Array.isArray(list)) {
      const byId = new Map(list.map((item) => [String(item.id), item]));
      spec = {
        ...spec, type: 'text', hidden: false,
        value: (row) => {
          const raw = row[key];
          if (raw == null || raw === '') return '指定なし'; // 参照を持たない行（取引先を決めていない経費など）。値が分からないのとは違う
          const item = byId.get(String(raw));
          if (!item) return `未登録（${raw}）`;
          const code = item.code || item.sku || '';
          return `${code}${code ? '｜' : ''}${item.title || item.name || ''}`;
        },
      };
    }
    // 日本語の鍵の列で、値がすべて数値なら数値の列にする（右寄せ・桁区切り。合計はしない）
    if (/[^\x00-\x7f]/.test(key) && !Array.isArray(list) && typeof rowsOrKeys[0] !== 'string') {
      const values = (rowsOrKeys || []).map((row) => row?.[key]).filter((value) => value !== null && value !== undefined && value !== '');
      if (values.length && values.every((value) => typeof value === 'number')) spec = {...spec, type: 'number', total: 'none'};
    }
    if (hidden.includes(key) || DEFAULT_HIDDEN_COLUMNS.includes(key)) spec = {...spec, hidden: true};
    return spec;
  });
}
