// 売上集計シートの計算（純関数）。1行の値（許可リスト・式・拡張属性）と、集計の決まり:
//   金額・件数 = 合計 / 在庫・残高 = 期末の値（系列ごとに最後の月の値を足す。月をまたいで足さない）
//   単価・料率・回転率 = 分子と分母をそれぞれ足してから割る（両方がある行だけ）/ 日付 = 最小〜最大 / 文字・はい/いいえ = 種類の数
// 外貨の額・レートは通貨ごとにしか足せないので、通貨が混ざる集計では空にする。
// サーバー（sales-sheet-routes.mjs）とブラウザの両方から読む。
import {SOURCE_REFS, CURRENCY_SCOPED_REFS, formulaColumns, evaluateFormula, roundTo, num, distributionCodeOf, unclassifiedName, GROUPS, VALUE_TYPES} from './column-registry.mjs';

export const MONTH_BASES = Object.freeze({accounting: '計上月', sales: '販売月', royalty: 'ロイヤリティ計上月'});
export const TAX_BASES = Object.freeze({ex: '税抜', inc: '税込'});
export const GRAINS = Object.freeze({detail: '明細（1行＝売上1件）', aggregate: '集計（切り口ごと）'});
export const MAX_DIMENSIONS = 3;
export const MAX_PIVOT_MONTHS = 36;

// 集計の切り口（最大3つ）。of は {key, text}
const unknown = (text) => ({key: '', text});
export const DIMENSIONS = Object.freeze({
  work: {label: '作品', needs: [], of: (c) => (c.work ? {key: c.work.code, text: `${c.work.code} ${c.work.title}`} : unknown('（作品なし）'))},
  partner: {label: '取引先', needs: [], of: (c) => (c.partner ? {key: c.partner.code, text: `${c.partner.code} ${c.partner.name}`} : unknown('（取引先なし）'))},
  // 分類の無い明細は「未分類（ビデオグラム・区分未確認）」と出す（キーは報告の種類の既定のまま。絞り込み・保存したシートと合う）
  distribution: {label: '流通ID', needs: ['dist'], of: (c) => { const code = distributionCodeOf(c); if (!c.dist) return {key: code, text: unclassifiedName(c)}; const name = c.master?.distribution_name || c.distLabel; return {key: code, text: name && name !== code ? `${code} ${name}` : code}; }},
  method: {label: '取引方法', needs: ['dist'], of: (c) => { const v = SOURCE_REFS['dist.method'].get(c); return v ? {key: v, text: v} : unknown('（未確認）'); }},
  sales_type: {label: '販売種別', needs: ['dist'], of: (c) => { const v = SOURCE_REFS['dist.sales_type'].get(c); return v ? {key: v, text: v} : unknown('（未確認）'); }},
  product: {label: '商品', needs: [], of: (c) => (c.product ? {key: c.product.sku, text: `${c.product.sku} ${c.product.name}`} : unknown('（作品に直接計上）'))},
  mg: {label: '最低保証の契約', needs: ['mg'], of: (c) => (c.mg?.code ? {key: c.mg.code, text: c.mg.code} : unknown('（最低保証なし）'))},
  ticket: {label: '券種', needs: ['detail', 'attrs'], of: (c) => { const v = c.th?.ticket_type_code || c.attrs?.ticket_category?.t; return v ? {key: v, text: v} : unknown('（券種なし）'); }},
  // 外貨の額・レートは通貨ごとにしか足せないので、通貨でも分けられるようにする（設計の8つに足した切り口）
  currency: {label: '通貨', needs: ['currency'], of: (c) => { const v = c.cur?.currency_code || 'JPY'; return {key: v, text: v}; }},
});

// ---------- カタログ ----------
const parseFormula = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
// カタログ（最新の版の一覧）を キー→列 の Map にし、式・通貨ごとの列かどうかを付ける
export function catalogIndex(catalog) {
  const index = new Map();
  for (const raw of catalog) {
    const column = {...raw, active: raw.active === undefined ? true : Boolean(Number(raw.active) || raw.active === true), formula: raw.formula ?? parseFormula(raw.formula_json)};
    index.set(column.column_key, column);
  }
  const scoped = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const column of index.values()) {
      if (scoped.has(column.column_key) || !['decimal', 'yen', 'rate_pct', 'integer'].includes(column.value_type)) continue;
      const refs = [...(column.formula ? formulaColumns(column.formula) : []), ...(column.aggregation === 'ratio' ? [column.numerator_key, column.denominator_key] : [])];
      if (CURRENCY_SCOPED_REFS.includes(column.source_ref) || refs.some((key) => key !== column.column_key && scoped.has(key))) { scoped.add(column.column_key); changed = true; }
    }
  }
  for (const key of scoped) index.get(key).currencyScoped = true;
  return index;
}

// 選んだ列の値を作るのに要る列（式の参照・比率の分子と分母）を足す
export function requiredKeys(selected, index) {
  const out = new Set();
  const visit = (key) => {
    if (out.has(key) || !index.has(key)) return;
    out.add(key);
    const column = index.get(key);
    if (column.formula) for (const ref of formulaColumns(column.formula)) visit(ref);
    if (column.aggregation === 'ratio') { visit(column.numerator_key); visit(column.denominator_key); }
  };
  for (const key of selected) visit(key);
  return out;
}

// 行の材料のうち読む必要があるもの
export function needsOf(keys, index, {dimensions = [], monthBasis = 'accounting'} = {}) {
  const needs = new Set();
  for (const key of keys) {
    const column = index.get(key);
    if (!column) continue;
    if (column.source_kind === 'attribute') needs.add('attrs');
    const source = column.source_ref ? SOURCE_REFS[column.source_ref] : null;
    for (const need of source?.needs || []) needs.add(need);
    if (column.aggregation === 'period_end') needs.add('dist');
    if (column.currencyScoped) needs.add('currency');
  }
  for (const dim of dimensions) for (const need of DIMENSIONS[dim]?.needs || []) needs.add(need);
  if (monthBasis === 'royalty') needs.add('royalty');
  return needs;
}

// ---------- 1行の値 ----------
function attributeValue(stored, type) {
  if (!stored) return null;
  if (['yen', 'integer', 'decimal', 'rate_pct'].includes(type)) return num(stored.n);
  if (type === 'bool') return stored.n === null || stored.n === undefined ? null : Number(stored.n) === 1;
  return stored.t ?? null;
}
function normalizeValue(value, column) {
  if (value === null || value === undefined || value === '') return null;
  switch (column.value_type) {
    case 'yen': return roundTo(value, 0);
    case 'integer': { const n = num(value); return n === null ? null : roundTo(n, 0); }
    case 'decimal': case 'rate_pct': { const n = num(value); return n === null ? null : column.digits === null || column.digits === undefined ? n : roundTo(n, column.digits); }
    case 'bool': return Boolean(value);
    default: return String(value);
  }
}
// ctx（行の材料）から keys の値を作る。{key: 値}
export function rowValues(ctx, keys, index) {
  const memo = new Map();
  const visiting = new Set();
  const valueOf = (key) => {
    if (memo.has(key)) return memo.get(key);
    const column = index.get(key);
    if (!column || visiting.has(key)) return null;
    visiting.add(key);
    let value = null;
    if (column.source_kind === 'attribute') value = attributeValue(ctx.attrs?.[key], column.value_type);
    else if (column.source_ref) value = SOURCE_REFS[column.source_ref] ? SOURCE_REFS[column.source_ref].get(ctx) : null;
    else if (column.formula) value = evaluateFormula(column.formula, valueOf);
    value = normalizeValue(value, column);
    visiting.delete(key);
    memo.set(key, value);
    return value;
  };
  const out = {};
  for (const key of keys) out[key] = valueOf(key);
  return out;
}

// 行の月（月の基準ごと）
export function monthOf(ctx, basis = 'accounting') {
  if (basis === 'sales') return SOURCE_REFS['sale.sales_month'].get(ctx);
  if (basis === 'royalty') return SOURCE_REFS['royalty.month'].get(ctx);
  return ctx.s.accounting_month;
}
// 期末の値の系列（最低保証の保証額・残高は契約ごと、ほかは商品、商品が無ければ 作品×取引先×流通ID）
export function seriesOf(ctx, column) {
  if (column?.source_ref && /^mg\./.test(column.source_ref) && ctx.mg?.code) return `mg:${ctx.mg.code}`;
  return ctx.s.product_id ? `p:${ctx.s.product_id}` : `w:${ctx.s.work_id}|pt:${ctx.s.partner_id}|d:${distributionCodeOf(ctx)}`;
}
// 集計に渡す1行（値・月・系列・通貨）
export function rowRecord(ctx, keys, index, {monthBasis = 'accounting'} = {}) {
  const values = rowValues(ctx, keys, index);
  const series = {};
  for (const key of keys) if (index.get(key)?.aggregation === 'period_end') series[key] = seriesOf(ctx, index.get(key));
  return {saleId: ctx.s.id, month: monthOf(ctx, monthBasis), values, series, currency: ctx.cur?.currency_code || 'JPY'};
}

// ---------- 集計 ----------
export function createGroup(keys, index) {
  const state = {count: 0, cols: new Map()};
  for (const key of keys) {
    const column = index.get(key);
    if (!column) continue;
    state.cols.set(key, {column, sum: 0, any: false, isFloat: false, series: new Map(), num: 0, den: 0, pairs: 0, min: null, max: null, distinct: new Set(), currencies: new Set()});
  }
  return state;
}
const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
export function addToGroup(state, record) {
  state.count += 1;
  for (const [key, s] of state.cols) {
    const {column} = s;
    const value = record.values[key];
    if (column.aggregation === 'ratio') {
      const n = num(record.values[column.numerator_key]), d = num(record.values[column.denominator_key]);
      if (n !== null && d !== null) { s.num += n; s.den += d; s.pairs += 1; if (column.currencyScoped) s.currencies.add(record.currency); }
      continue;
    }
    if (value === null || value === undefined) continue;
    if (column.currencyScoped) s.currencies.add(record.currency);
    switch (column.aggregation) {
      case 'sum': s.sum += value; s.any = true; if (!Number.isInteger(value)) s.isFloat = true; break;
      case 'period_end': {
        const seriesKey = record.series[key] ?? '';
        const prev = s.series.get(seriesKey);
        const month = record.month || '';
        if (!prev || month > prev.month || (month === prev.month && record.saleId > prev.saleId)) s.series.set(seriesKey, {month, saleId: record.saleId, value});
        break;
      }
      case 'min_max':
        if (s.min === null || cmp(value, s.min) < 0) s.min = value;
        if (s.max === null || cmp(value, s.max) > 0) s.max = value;
        break;
      default: s.distinct.add(typeof value === 'boolean' ? (value ? 'はい' : 'いいえ') : String(value));
    }
  }
}
// 集計の結果。{values: {key: 値}, mixed: [通貨が混ざって空にした列]}
// 値: 合計・期末・比率は数（無ければ null）、最小〜最大は {min,max}、種類の数は {count, value（1種類ならその値）}
export function finishGroup(state) {
  const values = {};
  const mixed = [];
  for (const [key, s] of state.cols) {
    const {column} = s;
    if (column.currencyScoped && s.currencies.size > 1) { values[key] = null; mixed.push(key); continue; }
    switch (column.aggregation) {
      case 'sum': values[key] = s.any ? (s.isFloat || column.value_type === 'decimal' ? roundTo(s.sum, column.digits ?? 6) : s.sum) : null; break;
      case 'period_end': {
        if (!s.series.size) { values[key] = null; break; }
        const total = [...s.series.values()].reduce((a, b) => a + b.value, 0);
        values[key] = column.value_type === 'decimal' ? roundTo(total, column.digits ?? 6) : total;
        break;
      }
      case 'ratio': values[key] = s.pairs && s.den !== 0 ? roundTo(s.num / s.den * column.ratio_scale, column.digits ?? 4) : null; break;
      case 'min_max': values[key] = s.min === null ? null : {min: s.min, max: s.max}; break;
      default: values[key] = s.distinct.size ? {count: s.distinct.size, value: s.distinct.size === 1 ? [...s.distinct][0] : null} : null;
    }
  }
  return {values, mixed, count: state.count};
}

// 集計値の表示の文字（Excel・CSV・画面）。数はそのまま返す
export function aggregateCell(column, value) {
  if (value === null || value === undefined) return null;
  if (column?.aggregation === 'min_max' && typeof value === 'object') return cmp(value.min, value.max) === 0 ? value.min : `${value.min}〜${value.max}`;
  if (column?.aggregation === 'distinct' && typeof value === 'object') return value.count === 1 ? value.value : `${value.count}種類`;
  return value;
}

// 切り口の組み合わせで行を分ける。rows は {ctx, record}。返り値は並べた集計行
export function groupKeyOf(ctx, dimensions) {
  const parts = dimensions.map((dim) => DIMENSIONS[dim].of(ctx));
  return {key: parts.map((p) => p.key).join('\u0001'), parts};
}

// 月を横に並べる（集計のとき）。金額の列: 月の基準がロイヤリティ計上月ならロイヤリティ計上額、ほかは計上額（税抜／税込）
export function pivotAmountKey(monthBasis, taxBasis) {
  if (monthBasis === 'royalty') return taxBasis === 'inc' ? 'royalty_amount_inc_tax' : 'royalty_amount_ex_tax';
  return taxBasis === 'inc' ? 'amount_inc_tax' : 'amount_ex_tax';
}
export function monthRange(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length <= MAX_PIVOT_MONTHS) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// 画面・出力の列の型（DataGrid / xlsx-report の type）
export function gridType(column) {
  switch (column.value_type) {
    case 'yen': return 'yen';
    case 'integer': return column.group_key === 'identity' || column.group_key === 'audit' ? 'id' : 'int';
    case 'decimal': return 'number';
    case 'rate_pct': return 'number';
    case 'date': return 'date';
    case 'month': return 'month';
    default: return 'text';
  }
}
export const groupLabel = (column) => GROUPS[column.group_key] || column.group_key;
export const valueTypeLabel = (column) => VALUE_TYPES[column.value_type] || column.value_type;
