// 売上集計シートの画面の決まり（React に依存しない。試験で使う）。
// ・API の問い合わせ（条件・列セット・流通ID・1ページの行数）
// ・表の列の並びと固定: 明細は 計上月・作品コード・作品名（全列は 売上ID・作品コード）を左に寄せて固定する。
//   集計は 切り口（すべて固定）→ 月（月を横に並べるとき）→ 明細数 → 列 の順（右端まで送らなくても月が見える）
// ・期間に行が無いときの「データのある最新の年度を見る」
import {fiscalYearOf, monthText} from '../ui/condition-model.mjs';

export const PINNED_DETAIL_COLUMNS = Object.freeze(['booking_month', 'work_code', 'ref_work_title']);
export const PINNED_ALL_COLUMNS = Object.freeze(['sale_id', 'work_code']);
export const PAGE_SIZES = Object.freeze([100, 200, 500]);
export const DEFAULT_PAGE_SIZE = 100;

export const pageSizeOf = (value) => (PAGE_SIZES.includes(Number(value)) ? Number(value) : DEFAULT_PAGE_SIZE);

// 条件 → API の問い合わせ
export function sheetQuery(params, conditions = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({from: conditions.from, to: conditions.to, workId: conditions.workId, partnerId: conditions.partnerId})) if (value) search.set(key, value);
  const q = params.q || conditions.q;
  if (q) search.set('q', q);
  const distribution = params.dist || conditions.distribution;
  if (distribution) search.set('distribution', distribution);
  // 売上明細から開いたときの請求・商品・取引区分の条件（売上明細と同じ意味で絞る）
  for (const key of ['billing', 'productId', 'deal']) if (conditions[key]) search.set(key, conditions[key]);
  if (params.kind) search.set('kind', params.kind);
  if (params.cols) search.set('columns', params.cols);
  else search.set('set', params.set || 'basic');
  if (params.grain === 'aggregate') {
    search.set('grain', 'aggregate');
    if (params.dims) search.set('dims', params.dims);
    if (params.pivot === '1') search.set('pivot', '1');
  }
  if (params.month && params.month !== 'accounting') search.set('month', params.month);
  if (params.tax === 'inc') search.set('tax', 'inc');
  if (params.empty === 'show') search.set('hideEmpty', '0');
  const size = pageSizeOf(params.psize);
  if (size !== DEFAULT_PAGE_SIZE) search.set('pageSize', String(size));
  if (params.page && params.page !== '1') search.set('page', params.page);
  return search.toString();
}

// 表の列の並び。戻り値は [{kind: 'dim'|'month'|'count'|'column', key, sticky, dim?, month?, column?}]
// allSet: 全列（元の83列の順）で見ているか。固定する列は、その列セットにある列だけを左に寄せる
export function sheetLayout(body, {allSet = false} = {}) {
  if (!body) return [];
  const out = [];
  if (body.grain === 'aggregate') {
    for (const dim of body.dimensions || []) out.push({kind: 'dim', key: `dim_${dim.key}`, dim, sticky: true});
    for (const month of body.months || []) out.push({kind: 'month', key: `m_${month}`, month, sticky: false});
    out.push({kind: 'count', key: '__count', sticky: false});
    for (const column of body.columns || []) out.push({kind: 'column', key: column.key, column, sticky: false});
    return out;
  }
  const pins = allSet ? PINNED_ALL_COLUMNS : PINNED_DETAIL_COLUMNS;
  const columns = body.columns || [];
  const pinned = pins.map((key) => columns.find((column) => column.key === key)).filter(Boolean);
  // 固定する列が1つも無い形（保存した形など）は、先頭の列だけ固定する（従来どおり）
  if (!pinned.length && columns.length) pinned.push(columns[0]);
  for (const column of pinned) out.push({kind: 'column', key: column.key, column, sticky: true});
  for (const column of columns) if (!pinned.includes(column)) out.push({kind: 'column', key: column.key, column, sticky: false});
  return out;
}

// 期間に行が無く、期間を外すとデータがあるとき（body.latestMonth）の案内。見ている年度と違う年度にあるときだけ出す
export function latestYearOffer({total, latestMonth, fiscalYear, fiscalStartMonth}) {
  if (total !== 0 || !/^\d{4}-\d{2}$/.test(String(latestMonth || ''))) return null;
  const year = fiscalYearOf(latestMonth, fiscalStartMonth);
  if (!Number.isInteger(year) || year === Number(fiscalYear)) return null;
  return {fiscalYear: year, label: `データのある最新の年度（${year}年度）を見る`, note: `この条件の売上は、いま見ている期間にはありません。最も新しいのは${monthText(latestMonth)}です。`, latestMonth};
}

// 他の画面から「この作品・取引先の売上集計シート」を開く条件。作品で絞るのは財務の権限がある作品だけ（access は GET /api/sales-sheet/access）
export function salesSheetLink(access, {workId = null, partnerId = null} = {}) {
  if (!access?.canOpen) return null;
  const work = workId === null || workId === undefined ? null : Number(workId);
  if (work !== null && Array.isArray(access.workIds) && !access.workIds.includes(work)) return null;
  const params = {};
  if (work !== null) params.workId = String(work);
  if (partnerId !== null && partnerId !== undefined) params.partnerId = String(partnerId);
  return {page: '売上集計シート', params};
}
