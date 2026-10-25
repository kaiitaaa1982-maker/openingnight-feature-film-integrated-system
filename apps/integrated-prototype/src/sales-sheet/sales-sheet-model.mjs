// 売上集計シートの計算（純関数）。1行の値（許可リスト・式・拡張属性）と、集計の決まり:
//   金額・件数 = 合計 / 在庫・残高 = 期末の値（系列ごとに最後の月の値を足す。月をまたいで足さない）
//   単価・料率・回転率 = 分子と分母をそれぞれ足してから割る（両方がある行だけ）/ 日付 = 最小〜最大 / 文字・はい/いいえ = 種類の数
// 外貨の額・レートは通貨ごとにしか足せないので、通貨が混ざる集計では空にする。
// サーバー（sales-sheet-routes.mjs）とブラウザの両方から読む。
import {
  SOURCE_REFS, CURRENCY_SCOPED_REFS, formulaColumns, evaluateFormula, roundTo, num, distributionCodeOf, unclassifiedName, GROUPS, VALUE_TYPES,
  SHEET_COLUMNS, ROYALTY_AMOUNT_KEYS, ROYALTY_MISMATCH_ITEMS, REMOVED_ATTRIBUTE_KEYS, catalogColumnOf, royaltyMismatchItems, salesBlock, sheetColumnOf,
} from './column-registry.mjs';

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

// 月を横に並べる（集計のとき）。金額の列: 月の基準がロイヤリティ計上月なら、組織が使っているロイヤリティ計上額の列（税抜／税込）。
// 裁定3 (a) でその列を止めた組織（額が売上と食い違う版が0件）と、ほかの月の基準では計上額（税抜／税込）。月はロイヤリティ計上月のまま。
// index: 組織の列カタログ（catalogIndex）。渡さなければロイヤリティ計上額の列を使う
export function pivotAmountKey(monthBasis, taxBasis, index = null) {
  const amount = taxBasis === 'inc' ? 'amount_inc_tax' : 'amount_ex_tax';
  if (monthBasis !== 'royalty') return amount;
  const royalty = taxBasis === 'inc' ? 'royalty_amount_inc_tax' : 'royalty_amount_ex_tax';
  return !index || index.get(royalty)?.active ? royalty : amount;
}
export const pivotAmountLabel = (key) => (String(key).startsWith('royalty_') ? 'ロイヤリティ計上額' : '計上額');
// ロイヤリティ計上月の横並びが計上額を読むとき（4列を止めた組織）、その行のロイヤリティ計上の額（同じ税の基準）が計上額と違うか。
// 止めたあとに額の違う版を記録した行を、横並びの条件に件数で出す（列を戻すのは adopt-v2 の流し直し）
export function royaltyPivotDiffers(ctx, pivotKey) {
  if (!ctx?.roy || !['amount_ex_tax', 'amount_inc_tax'].includes(pivotKey)) return false;
  return royaltyMismatchItems(ctx.s, ctx.roy, null).includes(pivotKey === 'amount_inc_tax' ? 'royalty_amount_inc_tax' : 'royalty_amount_ex_tax');
}
export const royaltyPivotNote = (count) => `計上額を読んでいます。ロイヤリティ計上の額が計上額と違う明細が${count}件あります（列「ロイヤリティ計上額の食い違い」で探せます。`
  + '管理者が列を辞書にそろえ直すと、ロイヤリティ計上額の列が戻り、横並びはその額を読みます）';
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

// ---------- 列の採用（辞書の v2）と、採用の前に数える件数 ----------
const EXAMPLES = 5;
const examplesOf = (ids) => [...new Set(ids)].sort((a, b) => a - b).slice(0, EXAMPLES);
const counted = (ids) => ({count: new Set(ids).size, examples: examplesOf(ids)});
const isEmptyAttribute = (row) => (row.value_text === null || row.value_text === undefined) && (row.value_number === null || row.value_number === undefined);

// 裁定3 (a) の4項目の食い違いを売上の数で数える。basis: 最新のロイヤリティ計上の基準の版と売上の額
// [{sale_id, amount_ex_tax, tax_amount, amount_inc_tax, royalty_amount_ex_tax, royalty_tax_amount, royalty_amount_inc_tax}]、
// currency: 最新の外貨の版 [{sale_id, currency_code, original_amount_x100, original_royalty_x100}]
export function royaltyAmountMismatches({basis = [], currency = []} = {}) {
  const items = Object.fromEntries(ROYALTY_MISMATCH_ITEMS.map((key) => [key, []]));
  for (const row of basis) for (const item of royaltyMismatchItems(row, row, null)) items[item].push(Number(row.sale_id));
  for (const row of currency) for (const item of royaltyMismatchItems({}, null, row)) items[item].push(Number(row.sale_id));
  return {...counted(Object.values(items).flat()), items: Object.fromEntries(Object.entries(items).map(([key, ids]) => [key, counted(ids)]))};
}

// 拡張属性の残り。values: 最新の版の拡張属性 [{sale_id, column_key, value_text, value_number}]（値を消した版は数えない）。
// notInDictionary: dictionaryKeys（組織の使っている列）に無いキーの値、inRemovedKeys: 辞書から外した拡張属性のキーの値
export function attributeOrphans(values, {dictionaryKeys, removedKeys = REMOVED_ATTRIBUTE_KEYS} = {}) {
  const known = new Set(dictionaryKeys || []), removed = new Set(removedKeys);
  const pick = (test) => {
    const rows = values.filter((row) => !isEmptyAttribute(row) && test(row.column_key));
    const byKey = {};
    for (const row of rows) byKey[row.column_key] = (byKey[row.column_key] || 0) + 1;
    return {count: rows.length, byKey: Object.fromEntries(Object.entries(byKey).sort(([a], [b]) => a.localeCompare(b))), examples: examplesOf(rows.map((row) => Number(row.sale_id)))};
  };
  return {notInDictionary: pick((key) => !known.has(key)), inRemovedKeys: pick((key) => removed.has(key))};
}

// 裁定1 の前提（G-7）。料率の5キーと、その料率を記録してよい流通のまとまり（salesBlock）。辞書の料率の列は計上額（税抜）を分子にするので、
// 1売上に料率が1つだけで、料率のキーとまとまりが合う売上だけなら、統合前（まとまりの当社売上を分子）と同じ集計になる
export const RATE_BLOCKS = Object.freeze({flat_partner_rate: 'flat', mg_partner_rate: 'mg', rs_partner_rate: 'rs', rss_partner_rate: 'rss', vod_partner_rate: 'vod'});
// 料率の集計を決める列（料率の列と、分母の補助の列）
export const RATE_BASIS_KEYS = Object.freeze([...Object.keys(RATE_BLOCKS), ...Object.keys(RATE_BLOCKS).map((key) => sheetColumnOf(key).denominator_key)]);
// values: 最新の版の拡張属性 [{sale_id, column_key, value_text, value_number}]（値を消した版は数えない）。1売上に料率キーの値が2つ以上ある売上
export function rateKeyConflicts(values) {
  const keysOf = new Map();
  for (const row of values) {
    if (!Object.hasOwn(RATE_BLOCKS, row.column_key) || isEmptyAttribute(row)) continue;
    const saleId = Number(row.sale_id);
    if (!keysOf.has(saleId)) keysOf.set(saleId, new Set());
    keysOf.get(saleId).add(row.column_key);
  }
  const conflicts = [...keysOf].filter(([, keys]) => keys.size >= 2);
  return {...counted(conflicts.map(([saleId]) => saleId)), detail: conflicts.slice(0, EXAMPLES).map(([saleId, keys]) => ({saleId, keys: [...keys].sort()}))};
}
// 料率の値が入ったキーと、売上の流通のまとまりが食い違う売上。blockOfSale: Map(売上ID → まとまり（flat・mg・rs・rss・vod）か null)
export function rateBlockMismatches(values, blockOfSale) {
  const found = [];
  for (const row of values) {
    if (!Object.hasOwn(RATE_BLOCKS, row.column_key) || isEmptyAttribute(row)) continue;
    const saleId = Number(row.sale_id);
    const block = blockOfSale.has(saleId) ? blockOfSale.get(saleId) : null;
    if (block !== RATE_BLOCKS[row.column_key]) found.push({saleId, key: row.column_key, block});
  }
  return {...counted(found.map((item) => item.saleId)), detail: found.slice(0, EXAMPLES)};
}
// 料率の値がある売上の流通のまとまり。rows: sales-sheet-store.mjs の loadRateSaleBlockRows（シートの loadContexts と同じ材料）
export function rateSaleBlocksOf({sales = [], dist = [], th = [], pk = [], dg = []} = {}) {
  const bySale = (list) => new Map(list.map((row) => [Number(row.sale_id), row]));
  const d = bySale(dist), t = bySale(th), p = bySale(pk), g = bySale(dg);
  return new Map(sales.map(({id}) => {
    const saleId = Number(id), row = d.get(saleId);
    return [saleId, salesBlock({
      dist: row ? {code: row.distribution_code, settlement_method: row.settlement_method} : null,
      master: row?.distribution_name ? {distribution_name: row.distribution_name, transaction_method: row.transaction_method, sales_type: row.sales_type} : null,
      th: t.get(saleId) || null, pk: p.get(saleId) || null, dg: g.get(saleId) || null,
    })];
  }));
}

// 列カタログの1行（sales_sheet_column_versions に入れる値）
const IMMUTABLE_FIELDS = Object.freeze(['value_type', 'source_kind', 'source_ref', 'legacy_position']);
const MUTABLE_FIELDS = Object.freeze(['label', 'group_key', 'aggregation', 'numerator_key', 'denominator_key', 'ratio_scale', 'digits', 'formula_json', 'description', 'sort_order']);
const formulaJsonOf = (column) => column.formula_json ?? (column.formula ? JSON.stringify(column.formula) : null);
const catalogRowOf = (column) => ({
  column_key: column.column_key, label: column.label, legacy_position: column.legacy_position ?? null, group_key: column.group_key, value_type: column.value_type,
  aggregation: column.aggregation, numerator_key: column.numerator_key ?? null, denominator_key: column.denominator_key ?? null, ratio_scale: column.ratio_scale ?? null,
  digits: column.digits ?? null, source_kind: column.source_kind, source_ref: column.source_ref ?? null, formula_json: formulaJsonOf(column), description: column.description ?? null,
  sort_order: Number(column.sort_order),
});
// SQLite は数、PostgreSQL の入口は数か文字で返すので、文字にそろえて比べる
const sameValue = (a, b) => (a === null || a === undefined ? null : String(a)) === (b === null || b === undefined ? null : String(b));
const isActiveRow = (column) => column.active === true || Number(column.active) === 1;

// 新しい組織が採用する列（版1）。keepRoyalty: 裁定3の食い違いがあり、ロイヤリティ計上の額の4列を残すか
export function adoptionRows({keepRoyalty = false} = {}) {
  return SHEET_COLUMNS.filter((column) => !column.removed && !column.retired_by && (keepRoyalty || !ROYALTY_AMOUNT_KEYS.includes(column.key)))
    .map((column) => ({...catalogRowOf(catalogColumnOf(column)), version_no: 1, active: 1}));
}

// 採用済みの組織（統合前の初期の列・追加の列）を辞書の v2 にそろえる差分（adopt-v2）。catalog: 組織の列カタログの最新の版
//   versions:  足す版。退役キー（retired_by）・外す列（removed）・止める裁定3の4列のうち使っている辞書の列は active=0 の版（定義はそのまま）、
//              無い列は版1、残す列は見出し・群・集計・分子と分母・桁・式・説明・並びが辞書と違えば次の版（使っているかどうかはそのまま）。
//              ただし keepRoyalty（裁定3の食い違いがある組織）では、止めてある4列（前の adopt-v2・管理者が止めた列）を使う版にする
//   conflicts: 取り方（value_type・source_kind・source_ref・legacy_position）が辞書と違う列（版をまたいで変えられない。辞書の誤りか同じキーの独自列）
//   labelClashes: 足す列・見出しを変える列・使う版に戻す列の見出しが、使っているほかの列の見出しと NFKC で重なる組
//   kept: 残した裁定3の列（reactivated: そのうち止めてあったのを戻した列）
//   updatedFields: 次の版を足した列 → 辞書の値に置き換えた項目。revertedEdits: そのうち版1でない列（採用のあとに版を足した列。管理者の手直しのことがある）の
//              見出し・説明を辞書の値に置き換えたもの（前の値つき。前の版は履歴に残る）
//   rateBasisChanged: 料率の集計を決める列（RATE_BASIS_KEYS）のうち、分子・分母・式を辞書の値に変える列（裁定1の前提 G-7 を確かめる対象）
export function adoptV2Plan(catalog, {keepRoyalty = false} = {}) {
  const index = new Map(catalog.map((column) => [column.column_key, column]));
  const versions = [], conflicts = [], added = [], updated = [], deactivated = [], reactivated = [], revertedEdits = [];
  const updatedFields = {};
  const finalLabels = new Map();
  for (const entry of SHEET_COLUMNS) {
    const current = index.get(entry.key);
    const royalty = ROYALTY_AMOUNT_KEYS.includes(entry.key);
    const stop = entry.removed || Boolean(entry.retired_by) || (!keepRoyalty && royalty);
    const target = catalogRowOf(catalogColumnOf(entry));
    if (stop) {
      // 止めるのは辞書の列だけ（取り方が辞書と同じ列）。同じキーで管理者が足した列（辞書の列を採用しなかった組織で足したもの）には触れない
      if (current && isActiveRow(current) && IMMUTABLE_FIELDS.every((field) => sameValue(current[field], target[field]))) {
        versions.push({...catalogRowOf(current), version_no: Number(current.version_no) + 1, active: 0});
        deactivated.push(entry.key);
      }
      continue;
    }
    if (!current) {
      versions.push({...target, version_no: 1, active: 1});
      added.push(entry.key);
      finalLabels.set(entry.key, {label: target.label, changed: true});
      continue;
    }
    const items = IMMUTABLE_FIELDS.filter((field) => !sameValue(current[field], target[field]));
    if (items.length) { conflicts.push({key: entry.key, items}); continue; }
    const changed = MUTABLE_FIELDS.filter((field) => !sameValue(field === 'formula_json' ? formulaJsonOf(current) : current[field], target[field]));
    const reactivate = keepRoyalty && royalty && !isActiveRow(current);
    if (changed.length || reactivate) versions.push({...target, version_no: Number(current.version_no) + 1, active: reactivate || isActiveRow(current) ? 1 : 0});
    if (changed.length) {
      updated.push(entry.key);
      updatedFields[entry.key] = changed;
      const edited = changed.filter((field) => field === 'label' || field === 'description');
      if (Number(current.version_no) > 1 && edited.length) {
        revertedEdits.push({key: entry.key, version: Number(current.version_no), fields: edited, before: {label: current.label, description: current.description ?? null}});
      }
    }
    if (reactivate) reactivated.push(entry.key);
    if (isActiveRow(current) || reactivate) finalLabels.set(entry.key, {label: target.label, changed: changed.includes('label') || reactivate});
  }
  // 使い続ける列（辞書に無い列と、外す列と同じキーの独自列）の見出し
  const stopped = new Set(deactivated);
  for (const column of catalog) {
    if (!finalLabels.has(column.column_key) && !stopped.has(column.column_key) && isActiveRow(column)) finalLabels.set(column.column_key, {label: column.label, changed: false});
  }
  const byLabel = new Map();
  for (const [key, item] of finalLabels) {
    const label = String(item.label).normalize('NFKC');
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push({key, ...item});
  }
  const labelClashes = [...byLabel.values()].filter((list) => list.length > 1 && list.some((item) => item.changed))
    .map((list) => ({label: list.find((item) => item.changed).label, keys: list.map((item) => item.key)}));
  const kept = keepRoyalty ? ROYALTY_AMOUNT_KEYS.filter((key) => finalLabels.has(key)) : [];
  const rateBasisChanged = RATE_BASIS_KEYS.filter((key) => (updatedFields[key] || []).some((field) => ['numerator_key', 'denominator_key', 'formula_json'].includes(field)));
  return {versions, conflicts, labelClashes, added, updated, deactivated, kept, reactivated, updatedFields, revertedEdits, rateBasisChanged};
}
