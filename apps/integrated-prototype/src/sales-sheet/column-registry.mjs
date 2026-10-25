// 売上集計シートの列の許可リストと、列の唯一の辞書。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §4、
// 列の統合は会社ルートの plans/2026-10-09-sheet-columns-by-grain.md（香盤表 #2a）。
// - SOURCE_REFS: 列の値の取り方の許可リスト。列カタログ（sales_sheet_column_versions.source_ref）はこのキーだけを持ち、SQL の文字列は保存しない。
//   値はサーバーが読んだ「行の材料」（ctx）から作る。ctx の形は sales-sheet-routes.mjs の loadContexts を参照
// - SHEET_COLUMNS: 列の唯一の辞書（旧131エントリと v2 で足した列）。並び（sort_order）は軸を左、流通の度合いを右の1群、監査を右端に置く。
//   removed は行き先なしで外す印（値は保存先に残る）、retired_by は新しいキーへ置き換えた印。どちらも無い列が組織の採用する列になる
//   （INITIAL_SHEET_COLUMNS はその派生）。見出しは中立の名前（定型業務の列の意味だけを使い、社名の入った見出し・物理名は持ち込まない）
// - COLUMN_SETS: 列セット7つ（基本／劇場／ビデオグラム／配信／MG・FLAT／税・請求・入金／監査・原本）と全列。additional・all_plus は全列の別名
// - 計算列の式（formula_json）は 四則演算と丸めだけの構文木。JS で評価し、任意のコードは実行しない
// 純関数だけ（Worker・ブラウザ・node のどれでも読める）。

export const VALUE_TYPES = Object.freeze({
  yen: '金額（円）', integer: '整数', decimal: '小数', rate_pct: '率（%）', date: '日付', month: '年月', text: '文字', bool: 'はい・いいえ',
});
export const AGGREGATIONS = Object.freeze({
  sum: '合計', period_end: '期末の値', ratio: '分子と分母から再計算', min_max: '最小〜最大', distinct: '種類の数',
});
export const SOURCE_KINDS = Object.freeze({core: '登録済みの表から', derived: '計算・結合で作る', attribute: '拡張属性（1売上×1列）'});
export const GROUPS = Object.freeze({
  identity: '識別', dates: '日付', quantity: '数量', unit_price: '単価', rate: '料率', partner_gross: '取引先側の総額', holder_sales: '当社売上',
  currency: '外貨', booking: '計上・税', mg_balance: '前払保証・残高', theatre: '劇場・券種', note: '備考', audit: '監査・原本',
  reference: '参考', helper: '集計の補助', custom: '追加の列',
});
// 取込（取引先別の列対応・CSV）で拡張属性の列に値を入れるときの変換先の名前: attr_<列キー>
export const ATTRIBUTE_TARGET_PREFIX = 'attr_';
export const attributeTargetKey = (columnKey) => `${ATTRIBUTE_TARGET_PREFIX}${columnKey}`;
export const isAttributeTarget = (target) => /^attr_[a-z][a-z0-9_]{0,47}$/.test(String(target || ''));
export const columnKeyOfTarget = (target) => (isAttributeTarget(target) ? String(target).slice(ATTRIBUTE_TARGET_PREFIX.length) : null);
export const COLUMN_KEY = /^[a-z][a-z0-9_]{0,47}$/;

// ---------- 数の扱い ----------
const isNil = (v) => v === null || v === undefined || v === '';
export function num(value) {
  if (isNil(value)) return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
// 0.5 を 0 から遠い側へ丸める（負の額も対称）。digits は小数の桁
export function roundTo(value, digits = 0) {
  const n = num(value);
  if (n === null) return null;
  const sign = n < 0 ? -1 : 1;
  const out = sign * Number(`${Math.round(Number(`${Math.abs(n)}e${digits}`))}e-${digits}`);
  return Object.is(out, -0) ? 0 : out;
}
const yenOf = (value) => { const n = num(value); return n === null ? null : roundTo(n, 0); };
const sumOf = (list) => (list.length ? list.reduce((a, b) => a + b, 0) : null);

// ---------- 流通のまとまり（どの「当社売上」の列に額が入るか） ----------
// 旧の行の意味: 定額（FLAT）・最低保証（MG）・RS（劇場・セル・レンタル・EST・TVOD）・レンタルRSS・見放題／広告型／海外などの視聴連動（vod）
const LEGACY_BLOCK = Object.freeze({
  theatrical: 'rs', package_rental: 'rs', package_sell: 'rs', est: 'rs', tvod: 'rs', svod: 'vod', avod: 'vod',
  broadcast_free: 'flat', broadcast_bs: 'flat', broadcast_cs: 'flat', broadcast_cable: 'flat',
});
export const BLOCK_LABELS = Object.freeze({flat: '定額', mg: '最低保証', rs: 'RS', rss: 'レンタル（RSS）', vod: '見放題・広告型・海外'});
export function salesBlock(ctx) {
  const model = ctx?.dg?.model;
  if (model === 'flat') return 'flat';
  if (model === 'mg') return 'mg';
  const method = ctx?.dist?.settlement_method;
  if (method === 'FLAT') return 'flat';
  if (method === 'MG') return 'mg';
  const m = ctx?.master;
  if (m) {
    if (m.transaction_method === 'FLAT') return 'flat';
    if (m.transaction_method === 'MG') return 'mg';
    if (m.distribution_name === 'レンタル_RSS') return 'rss';
    if (['SVOD', 'AVOD'].includes(m.sales_type) || ['海外', '業務用VOD', '放送'].includes(m.distribution_name)) return 'vod';
    if (['配給', '配給_物販', 'セル', 'レンタル', 'グッズ'].includes(m.distribution_name) || ['EST', 'TVOD'].includes(m.sales_type)) return 'rs';
    return null;
  }
  if (model === 'est' || model === 'tvod') return 'rs';
  if (model === 'svod' || model === 'avod') return 'vod';
  if (ctx?.th) return String(ctx.th.model || '').endsWith('flat') ? 'flat' : 'rs';
  if (ctx?.pk) return 'rs';
  return LEGACY_BLOCK[ctx?.dist?.code] || null;
}
const blockAmount = (block) => (ctx) => (salesBlock(ctx) === block ? ctx.s.amount_ex_tax : null);

// 消費税率（%）: 税額が 税抜×10%・8%・0% のどれかと1円まで合えばその率、合わなければ 税額÷税抜 の小数1桁
export function taxRateOf(amountExTax, taxAmount) {
  const ex = num(amountExTax), tax = num(taxAmount);
  if (ex === null || tax === null || ex === 0) return null;
  for (const rate of [10, 8, 0]) if (Math.abs(tax - roundTo(ex * rate / 100, 0)) <= 1) return rate;
  return roundTo(tax / ex * 100, 1);
}

const KIND_LABELS = Object.freeze({theatrical: '劇場', digital: '配信', package: 'ビデオグラム', broadcast: '放送', other: 'その他'});
// 流通の分類が無い明細の流通区分（報告の種類の既定）。シートの値・集計の切り口・絞り込みの SQL（sales-sheet-routes.mjs）が同じ表を使う
export const KIND_CODE = Object.freeze({digital: 'digital_unknown', package: 'package_unknown', theatrical: 'theatrical', broadcast: 'broadcast_unknown'});
export const KIND_CODE_OTHER = 'other';
export const kindDistributionCode = (kind) => KIND_CODE[kind] || KIND_CODE_OTHER;
export const distributionCodeOf = (ctx) => ctx?.dist?.code || kindDistributionCode(ctx?.r?.kind);
// 流通の分類が1つも無い明細の表示（流通ID は「未分類」、流通名は「未分類（ビデオグラム・区分未確認）」の形）。
// 集計・絞り込みのキーは distributionCodeOf のまま（報告の種類の既定 package_unknown など）なので、保存したシート・URL の絞り込みはそのまま動く
export const UNCLASSIFIED = '未分類';
export const unclassifiedName = (ctx) => (ctx?.distLabel ? `${UNCLASSIFIED}（${ctx.distLabel}）` : UNCLASSIFIED);
const obsSum = (ctx, metric, test = () => true) => sumOf((ctx.obs || []).filter((o) => o.metric === metric && test(o)).map((o) => Number(o.count)));
const storeUnit = (o) => /店/.test(String(o.unit || ''));
const svodLike = (ctx) => ['svod', 'avod'].includes(ctx.dg?.model);
const estLike = (ctx) => ['est', 'tvod'].includes(ctx.dg?.model);

// ---------- ロイヤリティ計上の額の食い違い（裁定3） ----------
// FR-SETL-ACCR-096 は「ロイヤリティ計上の基準は月だけを変え、額は変えさせない」。額が売上と食い違う版の4項目:
//   royalty_amount_ex_tax・royalty_tax_amount・royalty_amount_inc_tax（最新のロイヤリティ計上の基準の版が sale_lines と違う）、
//   original_royalty_x100（最新の外貨の版の外貨のロイヤリティ計上額が外貨の計上額と違う。空は「計上額と同じ」なので数えない）
// 額は整数（PostgreSQL の入口は文字で返すことがある）なので、文字の整数として比べる（浮動小数を通さない）
export const ROYALTY_MISMATCH_ITEMS = Object.freeze(['royalty_amount_ex_tax', 'royalty_tax_amount', 'royalty_amount_inc_tax', 'original_royalty_x100']);
const integerDiffers = (a, b) => BigInt(String(a)) !== BigInt(String(b));
const isNull = (value) => value === null || value === undefined;
// sale: {amount_ex_tax, tax_amount, amount_inc_tax}、basis: 最新のロイヤリティ計上の基準の版か null、currency: 最新の外貨の版か null。食い違う項目の名前の配列
export function royaltyMismatchItems(sale, basis, currency) {
  const items = [];
  if (basis) {
    if (integerDiffers(basis.royalty_amount_ex_tax, sale.amount_ex_tax)) items.push('royalty_amount_ex_tax');
    if (integerDiffers(basis.royalty_tax_amount, sale.tax_amount)) items.push('royalty_tax_amount');
    if (integerDiffers(basis.royalty_amount_inc_tax, sale.amount_inc_tax)) items.push('royalty_amount_inc_tax');
  }
  if (currency && currency.currency_code !== 'JPY' && !isNull(currency.original_royalty_x100)
    && (isNull(currency.original_amount_x100) || integerDiffers(currency.original_royalty_x100, currency.original_amount_x100))) items.push('original_royalty_x100');
  return items;
}

// ---------- 許可リスト ----------
// needs: 行の材料のうち読む必要があるもの（base は常に読む）。value_type はその取り方が返す値の型
const ref = (label, needs, valueType, get) => Object.freeze({label, needs: Object.freeze(needs), valueType, get});
const detailOf = (c) => c.th || c.pk || c.dg;
export const SOURCE_REFS = Object.freeze({
  'sale.period_to': ref('販売期間末日', [], 'date', (c) => c.s.sales_period_to),
  'sale.raw_quantity': ref('明細の原数量（種別を推測しない）', [], 'integer', (c) => c.s.quantity),
  'sale.source_row': ref('原本の行番号', [], 'integer', (c) => c.s.source_row),
  'report.period_from': ref('報告対象期間の初日', [], 'date', (c) => c.r?.period_from),
  'report.period_to': ref('報告対象期間の末日', [], 'date', (c) => c.r?.period_to),
  'report.status': ref('報告の状態（一覧は有効報告のみ）', [], 'text', (c) => ({active: '有効', superseded: '訂正前', void: '取消'}[c.r?.status] || c.r?.status)),
  'report.supersedes_id': ref('訂正元の報告ID', [], 'integer', (c) => c.r?.supersedes_id),
  'recognition.basis_id': ref('計上基準ID', ['recognition'], 'integer', (c) => c.recognition?.recognition_basis_id),
  'recognition.reason': ref('計上の理由', ['recognition'], 'text', (c) => c.recognition?.basis_reason),
  'recognition.received_on': ref('報告受領日', ['recognition'], 'date', (c) => c.recognition?.report_received_on),
  'recognition.contract_start_on': ref('計上根拠の契約開始日', ['recognition'], 'date', (c) => c.recognition?.contract_start_on),
  'recognition.license_start_on': ref('計上根拠の許諾開始日', ['recognition'], 'date', (c) => c.recognition?.license_start_on),
  'recognition.broadcast_on': ref('計上根拠の放送日', ['recognition'], 'date', (c) => c.recognition?.broadcast_on),
  'source.reference_id': ref('原本の追跡用参照（種類付き）', ['source'], 'text', (c) => c.src?.reference_id),
  'dist.version': ref('流通分類の版', ['dist'], 'integer', (c) => c.dist?.version_no),
  'dist.settlement_method': ref('精算方式（分類に記録した値）', ['dist'], 'text', (c) => c.dist?.settlement_method === 'unverified' ? '未確認' : c.dist?.settlement_method),
  'channel.model': ref('流通別の詳細モデル', ['detail'], 'text', (c) => detailOf(c)?.model),
  'digital.service_code': ref('配信サービスコード', ['detail'], 'text', (c) => c.dg?.service_code),
  'channel.reported_actual': ref('原報告の実績額（税抜・合算しない）', ['detail'], 'yen', (c) => detailOf(c)?.reported_actual_ex_tax),
  'channel.reported_recognized': ref('原報告の計上額（税抜・合算しない）', ['detail'], 'yen', (c) => detailOf(c)?.reported_recognized_ex_tax),
  'channel.calculated_actual': ref('実績額の計算照合値（税抜・合算しない）', ['detail'], 'yen', (c) => detailOf(c)?.calculated_actual_ex_tax),
  'package.turns_count': ref('レンタル回数（回転率とは別）', ['detail'], 'integer', (c) => c.pk?.turns_count),
  'currency.rate_date': ref('為替の基準日', ['currency'], 'date', (c) => c.cur?.rate_date),
  'currency.basis': ref('為替の根拠', ['currency'], 'text', (c) => c.cur?.basis),
  'currency.version': ref('為替の版', ['currency'], 'integer', (c) => c.cur?.version_no),
  'royalty.tax_amount': ref('ロイヤリティ計上の税額（記録が無ければ売上税額）', ['royalty'], 'yen', (c) => c.roy ? c.roy.royalty_tax_amount : c.s.tax_amount),
  'royalty.version': ref('ロイヤリティ計上の版（代用時は空欄）', ['royalty'], 'integer', (c) => c.roy?.version_no),
  'royalty.origin': ref('ロイヤリティ計上額の由来', ['royalty'], 'text', (c) => c.roy ? '独立した基準' : '売上額を代用'),
  'sale.id': ref('売上ID', [], 'integer', (c) => c.s.id),
  'sale.sales_date': ref('販売期間の初日', [], 'date', (c) => c.s.sales_period_from),
  'sale.accounting_month': ref('計上月', [], 'month', (c) => c.s.accounting_month),
  'sale.sales_month': ref('販売月（報告の販売月、無ければ販売期間の初日の月）', [], 'month', (c) => c.sales_month || String(c.s.sales_period_from || '').slice(0, 7) || null),
  'sale.amount_ex_tax': ref('計上額（税抜）', [], 'yen', (c) => c.s.amount_ex_tax),
  'sale.tax_amount': ref('消費税額', [], 'yen', (c) => c.s.tax_amount),
  'sale.amount_inc_tax': ref('計上額（税込）', [], 'yen', (c) => c.s.amount_inc_tax),
  'sale.tax_rate': ref('消費税率（税額と税抜から）', [], 'rate_pct', (c) => taxRateOf(c.s.amount_ex_tax, c.s.tax_amount)),
  'sale.description': ref('明細名', [], 'text', (c) => c.s.description || null),
  'work.code': ref('作品コード', [], 'text', (c) => c.work?.code ?? null),
  'work.title': ref('作品名', [], 'text', (c) => c.work?.title ?? null),
  'product.sku': ref('商品コード', [], 'text', (c) => c.product?.sku ?? null),
  'product.name': ref('商品名', [], 'text', (c) => c.product?.name ?? null),
  'partner.code': ref('取引先コード', [], 'text', (c) => c.partner?.code ?? null),
  'partner.name': ref('取引先名', [], 'text', (c) => c.partner?.name ?? null),
  'report.id': ref('報告ID', [], 'integer', (c) => c.s.report_id ?? null),
  'report.key': ref('報告番号', [], 'text', (c) => c.r?.report_key ?? null),
  'report.kind': ref('報告の種類', [], 'text', (c) => KIND_LABELS[c.r?.kind] || c.r?.kind || null),
  'report.created_at': ref('取込日時', [], 'text', (c) => c.r?.created_at ?? null),
  'report.registration_kind': ref('登録の種類（新規・訂正）', [], 'text', (c) => (c.r?.supersedes_id ? '訂正' : '新規')),
  'report.version': ref('報告の版（訂正の段数＋1）', ['depth'], 'integer', (c) => (c.r ? (c.r.depth ?? 0) + 1 : null)),
  'report.row_fingerprint': ref('行の照合値（報告の照合値＋元の行）', [], 'text', (c) => (c.r?.content_hash ? `${c.r.content_hash}:${c.s.source_row ?? ''}` : null)),
  'dist.code': ref('流通ID（最新の流通分類。分類の無い明細は「未分類」）', ['dist'], 'text', (c) => (c.dist ? distributionCodeOf(c) : UNCLASSIFIED)),
  'dist.name': ref('流通名', ['dist'], 'text', (c) => (c.dist ? c.master?.distribution_name || c.distLabel || null : unclassifiedName(c))),
  'dist.method': ref('取引方法', ['dist'], 'text', (c) => c.master?.transaction_method || (c.dist?.settlement_method && c.dist.settlement_method !== 'unverified' ? c.dist.settlement_method : null)),
  'dist.sales_type': ref('販売種別', ['dist'], 'text', (c) => c.master?.sales_type || null),
  'dist.territory': ref('地域', ['dist'], 'text', (c) => c.dist?.territory || null),
  'dist.service_name': ref('サービス名', ['dist'], 'text', (c) => c.dist?.service_name || null),
  'block.flat': ref('定額の行の計上額', ['dist', 'detail'], 'yen', blockAmount('flat')),
  'block.mg': ref('最低保証の行の計上額', ['dist', 'detail'], 'yen', blockAmount('mg')),
  'block.rs': ref('RS の行の計上額', ['dist', 'detail'], 'yen', blockAmount('rs')),
  'block.rss': ref('レンタル（RSS）の行の計上額', ['dist', 'detail'], 'yen', blockAmount('rss')),
  'block.vod': ref('見放題・広告型・海外の行の計上額', ['dist', 'detail'], 'yen', blockAmount('vod')),
  'digital.contract_amount': ref('配信（定額）の契約額', ['detail'], 'yen', (c) => yenOf(c.dg?.contract_amount_ex_tax)),
  'digital.contract_from': ref('配信（定額）の契約開始日', ['detail'], 'date', (c) => c.dg?.contract_period_from || null),
  'digital.contract_to': ref('配信（定額）の契約終了日', ['detail'], 'date', (c) => c.dg?.contract_period_to || null),
  'digital.view_seconds': ref('配信の視聴秒数', ['detail'], 'integer', (c) => num(c.dg?.view_seconds)),
  'digital.view_count': ref('配信の視聴回数', ['detail'], 'integer', (c) => num(c.dg?.view_count)),
  'digital.vod_unit_price': ref('見放題・広告型の当社単価', ['detail'], 'decimal', (c) => (svodLike(c) ? num(c.dg?.holder_unit_price_ex_tax) : null)),
  'digital.vod_partner_sales': ref('見放題・広告型の取引先売上', ['detail'], 'yen', (c) => (svodLike(c) ? yenOf(c.dg?.reported_actual_ex_tax) : null)),
  'channel.partner_unit_price': ref('取引先の単価（EST・TVOD・レンタル）', ['detail'], 'decimal', (c) => (estLike(c) ? num(c.dg?.unit_price_ex_tax) : num(c.pk?.average_rental_price_ex_tax))),
  'channel.holder_unit_price': ref('当社の単価（EST・TVOD・パッケージ）', ['detail'], 'decimal', (c) => (estLike(c) ? num(c.dg?.holder_unit_price_ex_tax) : num(c.pk?.holder_unit_price_ex_tax))),
  'channel.sales_count': ref('販売件数（配信の件数、無ければ明細の数量）', ['detail'], 'integer', (c) => num(c.dg?.sales_count) ?? num(c.s.quantity)),
  'theatrical.admissions': ref('動員数', ['detail'], 'integer', (c) => num(c.th?.admissions_count)),
  'theatrical.gross_box_office': ref('興行収入（税抜）', ['detail'], 'yen', (c) => yenOf(c.th?.gross_box_office_ex_tax)),
  'theatrical.ticket_type': ref('券種', ['detail'], 'text', (c) => c.th?.ticket_type_code || null),
  'theatrical.purchase_channel': ref('購入経路', ['detail'], 'text', (c) => c.th?.purchase_channel || null),
  'obs.delivered': ref('納品数（報告の観測値）', ['obs'], 'integer', (c) => obsSum(c, 'delivered')),
  'obs.active_stores': ref('稼動店舗数（単位が店舗の観測値）', ['obs'], 'integer', (c) => obsSum(c, 'active', storeUnit)),
  'obs.active_units': ref('店舗あたりの稼動商品数（単位が店舗以外の観測値）', ['obs'], 'integer', (c) => obsSum(c, 'active', (o) => !storeUnit(o))),
  'obs.inventory': ref('在庫数（報告の観測値）', ['obs'], 'integer', (c) => obsSum(c, 'inventory')),
  'billing.invoice_number': ref('請求書番号（取り消していない請求）', ['billing'], 'text', (c) => c.bill?.invoice_number ?? null),
  'billing.invoice_date': ref('請求日', ['billing'], 'date', (c) => c.bill?.invoice_date ?? null),
  'billing.due_date': ref('入金期日（承認した変更があればその日）', ['billing'], 'date', (c) => c.bill?.due_date ?? null),
  'billing.received_on': ref('入金日（取り消していない最後の入金）', ['billing'], 'date', (c) => c.bill?.received_on ?? null),
  'mg.code': ref('最低保証の契約コード（商品が入っている受取MG）', ['mg'], 'text', (c) => c.mg?.code ?? null),
  'mg.amount': ref('最低保証額', ['mg'], 'yen', (c) => c.mg?.mg_amount_yen ?? null),
  'mg.starts_on': ref('最低保証の契約開始日', ['mg'], 'date', (c) => c.mg?.starts_on ?? null),
  'mg.ends_on': ref('最低保証の契約終了日', ['mg'], 'date', (c) => c.mg?.ends_on ?? null),
  'mg.balance': ref('前払保証の残高（最低保証額−計上月までの充当）', ['mg'], 'yen', (c) => c.mg?.balance_yen ?? null),
  'currency.code': ref('通貨（記録が無ければ円）', ['currency'], 'text', (c) => c.cur?.currency_code || 'JPY'),
  'currency.amount': ref('外貨の計上額', ['currency'], 'decimal', (c) => (c.cur && c.cur.currency_code !== 'JPY' && c.cur.original_amount_x100 != null ? c.cur.original_amount_x100 / 100 : null)),
  'currency.royalty_amount': ref('外貨のロイヤリティ計上額', ['currency'], 'decimal', (c) => (c.cur && c.cur.currency_code !== 'JPY' && c.cur.original_royalty_x100 != null ? c.cur.original_royalty_x100 / 100 : null)),
  'currency.rate': ref('為替レート', ['currency'], 'decimal', (c) => (c.cur && c.cur.currency_code !== 'JPY' ? c.cur.exchange_rate_x10000 / 10000 : null)),
  'royalty.month': ref('ロイヤリティ計上月（記録が無ければ計上月）', ['royalty'], 'month', (c) => c.roy?.royalty_month || c.s.accounting_month),
  'royalty.amount_ex_tax': ref('ロイヤリティ計上額（税抜。記録が無ければ計上額）', ['royalty'], 'yen', (c) => (c.roy ? c.roy.royalty_amount_ex_tax : c.s.amount_ex_tax)),
  'royalty.amount_inc_tax': ref('ロイヤリティ計上額（税込。記録が無ければ計上額）', ['royalty'], 'yen', (c) => (c.roy ? c.roy.royalty_amount_inc_tax : c.s.amount_inc_tax)),
  'royalty.amount_mismatch': ref('ロイヤリティ計上の額が売上と食い違うか（税抜・税額・税込・外貨の4項目）', ['royalty', 'currency'], 'bool',
    (c) => royaltyMismatchItems(c.s, c.roy || null, c.cur || null).length > 0),
  'source.processing_id': ref('加工の記録（分割・原本・列対応の版）', ['source'], 'text', (c) => c.src?.processing_id ?? null),
  'source.processed_at': ref('加工日時', ['source'], 'text', (c) => c.src?.processed_at ?? null),
  'source.file_name': ref('原本のファイル名', ['source'], 'text', (c) => c.src?.file_name ?? null),
});
// 通貨ごとにしか足せない列（通貨が混ざる集計では空にする）を作る取り方
export const CURRENCY_SCOPED_REFS = Object.freeze(['currency.amount', 'currency.royalty_amount', 'currency.rate']);

// ---------- 計算列の式（四則演算と丸めだけ） ----------
// 形: {"col":"列キー"} | {"num":数} | {"op":"add|sub|mul|div","args":[式,式]} | {"op":"round","args":[式],"digits":0〜6}
const OPS = new Set(['add', 'sub', 'mul', 'div', 'round']);
export function formulaColumns(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.col === 'string') out.add(node.col);
  for (const arg of Array.isArray(node.args) ? node.args : []) formulaColumns(arg, out);
  return out;
}
// 式の形を確かめる。knownKeys: 参照してよい列キー。返り値は問題の文（無ければ null）
export function formulaProblem(node, knownKeys, {depth = 0, count = {n: 0}} = {}) {
  count.n += 1;
  if (count.n > 40) return '式が長すぎます（40個まで）';
  if (depth > 8) return '式の入れ子が深すぎます';
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '式の形が正しくありません';
  const keys = Object.keys(node);
  if (Object.hasOwn(node, 'col')) {
    if (keys.length !== 1 || typeof node.col !== 'string' || !COLUMN_KEY.test(node.col)) return '列の参照は {"col":"列キー"} の形です';
    return knownKeys && !knownKeys.has(node.col) ? `式が知らない列を参照しています: ${node.col}` : null;
  }
  if (Object.hasOwn(node, 'num')) return keys.length === 1 && Number.isFinite(node.num) ? null : '数は {"num":3600} の形です';
  if (!OPS.has(node.op)) return `使えない演算です: ${node.op}`;
  const args = Array.isArray(node.args) ? node.args : [];
  if (node.op === 'round') {
    if (args.length !== 1 || !Number.isInteger(node.digits) || node.digits < 0 || node.digits > 6 || keys.some((k) => !['op', 'args', 'digits'].includes(k))) return '丸めは {"op":"round","args":[式],"digits":0〜6} の形です';
  } else if (args.length !== 2 || keys.some((k) => !['op', 'args'].includes(k))) return '四則演算は {"op":"add","args":[式,式]} の形です';
  for (const arg of args) {
    const problem = formulaProblem(arg, knownKeys, {depth: depth + 1, count});
    if (problem) return problem;
  }
  return null;
}
// 評価。参照した列が空なら空。0で割るときも空
export function evaluateFormula(node, valueOf) {
  if (Object.hasOwn(node, 'col')) return num(valueOf(node.col));
  if (Object.hasOwn(node, 'num')) return node.num;
  const values = node.args.map((arg) => evaluateFormula(arg, valueOf));
  if (values.some((v) => v === null)) return null;
  const [a, b] = values;
  switch (node.op) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'mul': return a * b;
    case 'div': return b === 0 ? null : a / b;
    case 'round': return roundTo(a, node.digits);
    default: return null;
  }
}
const col = (key) => ({col: key});
const mul = (a, b) => ({op: 'mul', args: [a, b]});
const div = (a, b) => ({op: 'div', args: [a, b]});
const round = (a, digits) => ({op: 'round', args: [a], digits});

// ---------- 列の唯一の辞書 ----------
// 1要素: {key, label, group_key, value_type, aggregation, source_kind, source_ref, formula, legacy_position, numerator_key, denominator_key, ratio_scale, digits,
//   description, since:'v1'|'v2', retired_by:キー|null, removed:bool, sort_order}。
// - 意味の変わらない列はキーと取り方（value_type・source_kind・source_ref・legacy_position）を残し、見出し・群・並びだけを直す
//   （取り方は列カタログのトリガーが版をまたいで変えさせない。sales-sheet.sql の sales_sheet_column_versions_sequence）
// - removed: true は辞書から外す列（行き先なし）。値は保存先（拡張属性・報告の状態・原本の参照）に残り、採用済みの組織では adopt-v2 が active=0 の版を足す
// - retired_by は新しいキーへ置き換えた列（裁定1・2 (a)。新しい表 sale_distribution_metric_versions を足す PR C で付ける。いまは無い）
// - 群（group_key）は表示の見出しだけ。既存の16値の中で付け替え、列セット（COLUMN_SETS）の中身は変えない
// - 並び（sort_order）は辞書の順。全列・CSV はこの順に出す（旧83列の順の CSV は廃止。legacy_position は元の列番号として残す）
const D = (key, label, group, type, aggregation, kind, source, extra = {}) => ({
  key, label, group_key: group, value_type: type, aggregation, source_kind: kind,
  source_ref: kind === 'attribute' || (kind === 'derived' && typeof source === 'object') ? null : source,
  formula: kind === 'derived' && typeof source === 'object' ? source : null,
  legacy_position: extra.pos ?? null, numerator_key: extra.num ?? null, denominator_key: extra.den ?? null, ratio_scale: extra.scale ?? null, digits: extra.digits ?? null,
  description: extra.description ?? null, since: extra.since ?? 'v1', retired_by: extra.retired_by ?? null, removed: extra.removed === true,
});
const RATE = (numKey, denKey, extra = {}) => ({num: numKey, den: denKey, scale: 100, digits: 2, ...extra});
// 記録した料率の集計: 行ごとに 計上額÷料率×100（元の売上の逆算）を分母にして、計上額の合計÷逆算の合計×100。
// 1売上に料率が1つだけで、料率のキーと流通のまとまり（salesBlock）が合うのが前提（裁定1の前提 G-7）。そのとき料率を記録した行の計上額は、
// その料率のまとまりの当社売上（統合前の分子 #12・19・28・34・42）と同じ額になる。統合前の分子の組織を adopt-v2 がこの分子に変えるのは、
// 前提を満たさない売上が0件のときだけ（sales-sheet-model.mjs の rateKeyConflicts・rateBlockMismatches。満たさなければ 409）
const implied = (rateKey) => div(mul(col('amount_ex_tax'), {num: 100}), col(rateKey));
const IMPLIED = '集計は 計上額の合計÷（計上額÷料率×100）の合計×100。料率を記録した行だけで数える';
const UNIT = (numKey, denKey, extra = {}) => ({num: numKey, den: denKey, scale: 1, digits: 2, ...extra});
// 追加の列（統合前の追加の28列）の説明。正本を参照し、合算しない
const REFERENCE = (source) => ({description: `${SOURCE_REFS[source].label}。既存の正本を参照。合算せず、日付は範囲、それ以外は種類を表示する。`});
const ref1 = (key, label, group, type, source) => D(key, label, group, type, type === 'date' ? 'min_max' : 'distinct', 'core', source, REFERENCE(source));
const MG_VERSION = 'MG 台帳の条件版のうち、計上月の末日までに始まった最新の版（FR-SETL-MGL-050。MG 台帳の帳票と同じ選び方）';
const REMOVED = {removed: true};

const DICTIONARY = [
  // 軸（作品×商品×流通区分×取引先）と明細名
  D('sale_id', '売上ID', 'identity', 'integer', 'distinct', 'core', 'sale.id', {pos: 1}),
  D('work_code', '作品コード', 'identity', 'text', 'distinct', 'core', 'work.code', {pos: 6}),
  D('ref_work_title', '作品名', 'identity', 'text', 'distinct', 'core', 'work.title'),
  D('product_code', '商品コード（SKU）', 'identity', 'text', 'distinct', 'core', 'product.sku', {pos: 7}),
  D('ref_product_name', '商品名', 'identity', 'text', 'distinct', 'core', 'product.name'),
  D('distribution_code', '流通ID', 'identity', 'text', 'distinct', 'core', 'dist.code', {pos: 2, description: '最新の流通分類（流通マスタの流通ID）。分類していない明細は「未分類」（帳票センターの流通の分類で分ける）'}),
  D('ref_distribution_name', '流通名', 'identity', 'text', 'distinct', 'core', 'dist.name'),
  D('ref_transaction_method', '取引方法', 'identity', 'text', 'distinct', 'core', 'dist.method'),
  D('ref_sales_type', '販売種別', 'identity', 'text', 'distinct', 'core', 'dist.sales_type'),
  D('partner_code', '取引先コード', 'identity', 'text', 'distinct', 'core', 'partner.code', {pos: 9}),
  D('ref_partner_name', '取引先名', 'identity', 'text', 'distinct', 'core', 'partner.name'),
  D('mg_group', '最低保証の契約コード', 'identity', 'text', 'distinct', 'derived', 'mg.code', {pos: 8, description: `商品が入っている受取の最低保証（MG）契約。${MG_VERSION}の商品で決める`}),
  D('line_note', '明細名', 'identity', 'text', 'distinct', 'core', 'sale.description', {pos: 53}),
  // 日付
  D('ref_sales_month', '販売月', 'dates', 'month', 'min_max', 'core', 'sale.sales_month'),
  D('booking_month', '計上月', 'dates', 'month', 'min_max', 'core', 'sale.accounting_month', {pos: 4}),
  D('royalty_month', 'ロイヤリティ計上月', 'dates', 'month', 'min_max', 'derived', 'royalty.month', {pos: 5, description: 'ロイヤリティ計上の基準の記録。無ければ計上月'}),
  D('sales_date', '販売期間の初日', 'dates', 'date', 'min_max', 'core', 'sale.sales_date', {pos: 3}),
  ref1('sales_period_to', '販売期間末日', 'dates', 'date', 'sale.period_to'),
  ref1('report_period_from', '報告対象期間の初日', 'dates', 'date', 'report.period_from'),
  ref1('report_period_to', '報告対象期間の末日', 'dates', 'date', 'report.period_to'),
  D('flat_start', '定額：契約開始日', 'dates', 'date', 'min_max', 'core', 'digital.contract_from', {pos: 13}),
  D('flat_end', '定額：契約終了日', 'dates', 'date', 'min_max', 'core', 'digital.contract_to', {pos: 14}),
  D('mg_start', '最低保証：契約開始日', 'dates', 'date', 'min_max', 'derived', 'mg.starts_on', {pos: 16, description: MG_VERSION}),
  D('mg_end', '最低保証：契約終了日', 'dates', 'date', 'min_max', 'derived', 'mg.ends_on', {pos: 17, description: MG_VERSION}),
  // 計上・税・請求・入金
  D('amount_ex_tax', '計上額（税抜）', 'booking', 'yen', 'sum', 'core', 'sale.amount_ex_tax', {pos: 47}),
  D('royalty_amount_ex_tax', 'ロイヤリティ計上額（税抜）', 'booking', 'yen', 'sum', 'derived', 'royalty.amount_ex_tax', {pos: 48, description: 'ロイヤリティ計上の基準の記録。無ければ計上額と同じ'}),
  D('tax_rate', '消費税率（%）', 'booking', 'rate_pct', 'ratio', 'derived', 'sale.tax_rate', {pos: 49, ...RATE('tax_amount', 'amount_ex_tax', {digits: 1})}),
  D('tax_amount', '消費税額', 'booking', 'yen', 'sum', 'core', 'sale.tax_amount', {pos: 50}),
  D('amount_inc_tax', '計上額（税込）', 'booking', 'yen', 'sum', 'core', 'sale.amount_inc_tax', {pos: 51}),
  D('royalty_amount_inc_tax', 'ロイヤリティ計上額（税込）', 'booking', 'yen', 'sum', 'derived', 'royalty.amount_inc_tax', {pos: 52}),
  ref1('royalty_tax_amount', 'ロイヤリティ計上の税額', 'booking', 'yen', 'royalty.tax_amount'),
  ref1('royalty_basis_version', 'ロイヤリティ計上の版', 'booking', 'integer', 'royalty.version'),
  ref1('royalty_basis_origin', 'ロイヤリティ計上額の由来', 'booking', 'text', 'royalty.origin'),
  D('invoice_number', '請求書番号', 'booking', 'text', 'distinct', 'core', 'billing.invoice_number', {pos: 54}),
  D('invoice_date', '請求日', 'booking', 'date', 'min_max', 'core', 'billing.invoice_date', {pos: 68}),
  D('payment_due', '入金期日', 'booking', 'date', 'min_max', 'core', 'billing.due_date', {pos: 69}),
  D('paid_on', '入金日', 'booking', 'date', 'min_max', 'core', 'billing.received_on', {pos: 70}),
  // 外貨
  D('foreign_amount', '外貨：計上額（税抜）', 'currency', 'decimal', 'sum', 'core', 'currency.amount', {pos: 43, digits: 2, description: '通貨が混ざる集計では空にする'}),
  D('foreign_royalty_amount', '外貨：ロイヤリティ計上額（税抜）', 'currency', 'decimal', 'sum', 'core', 'currency.royalty_amount', {pos: 44, digits: 2}),
  D('currency_code', '通貨', 'currency', 'text', 'distinct', 'core', 'currency.code', {pos: 45, description: '外貨の記録が無い売上は JPY'}),
  D('exchange_rate', '為替レート（1外貨あたりの円）', 'currency', 'decimal', 'ratio', 'core', 'currency.rate', {pos: 46, ...UNIT('h_foreign_yen', 'foreign_amount', {digits: 4})}),
  ref1('currency_rate_date', '為替の基準日', 'currency', 'date', 'currency.rate_date'),
  ref1('currency_basis', '為替の根拠', 'currency', 'text', 'currency.basis'),
  ref1('currency_version', '為替の版', 'currency', 'integer', 'currency.version'),
  // 流通の詳細
  D('ref_report_kind', '報告の種類', 'reference', 'text', 'distinct', 'core', 'report.kind'),
  D('ref_territory', '地域', 'reference', 'text', 'distinct', 'core', 'dist.territory'),
  D('ref_service_name', 'サービス名', 'reference', 'text', 'distinct', 'core', 'dist.service_name'),
  ref1('settlement_method', '精算方式', 'reference', 'text', 'dist.settlement_method'),
  ref1('channel_model', '流通別の詳細モデル', 'reference', 'text', 'channel.model'),
  ref1('service_code', '配信サービスコード', 'reference', 'text', 'digital.service_code'),
  // 流通の度合い（料率・数量 → 劇場 → ビデオグラム → 配信 → MG・FLAT → 原報告の値）
  D('flat_partner_rate', '定額：取引先の支払料率（%）', 'quantity', 'rate_pct', 'ratio', 'attribute', null, {pos: 11, ...RATE('amount_ex_tax', 'h_flat_implied_deal', {description: IMPLIED})}),
  D('mg_partner_rate', '最低保証：取引先の支払料率（%）', 'quantity', 'rate_pct', 'ratio', 'attribute', null, {pos: 18, ...RATE('amount_ex_tax', 'h_mg_implied_gross', {description: IMPLIED})}),
  D('rs_partner_rate', 'RS：取引先の支払料率（%）', 'quantity', 'rate_pct', 'ratio', 'attribute', null, {pos: 25, ...RATE('amount_ex_tax', 'h_rs_implied_gross', {description: IMPLIED})}),
  D('rss_partner_rate', 'レンタル（RSS）：取引先の支払料率（%）', 'quantity', 'rate_pct', 'ratio', 'attribute', null, {pos: 33, ...RATE('amount_ex_tax', 'h_rss_implied_declared', {description: IMPLIED})}),
  D('vod_partner_rate', '見放題・広告型・海外：取引先の支払料率（%）', 'quantity', 'rate_pct', 'ratio', 'attribute', null, {pos: 41, ...RATE('amount_ex_tax', 'h_vod_implied_gross', {description: IMPLIED})}),
  D('rs_count', 'RS：販売件数（無ければ明細の数量）', 'quantity', 'integer', 'sum', 'core', 'channel.sales_count', {pos: 27, description: '配信の販売件数。記録が無ければ明細の数量で代用する（RS の単価の分母）'}),
  ref1('raw_quantity', '明細の原数量', 'quantity', 'integer', 'sale.raw_quantity'),
  D('theatre_name', '劇場名', 'quantity', 'text', 'distinct', 'attribute', null, {pos: 56}),
  D('ticket_name', '券種コード', 'quantity', 'text', 'distinct', 'core', 'theatrical.ticket_type', {pos: 62}),
  D('ticket_category', '券種の区分', 'quantity', 'text', 'distinct', 'attribute', null, {pos: 61}),
  D('ticket_channel', '券種の購入経路', 'quantity', 'text', 'distinct', 'core', 'theatrical.purchase_channel', {pos: 66}),
  D('ticket_raw_label', '券種の表記（原文）', 'quantity', 'text', 'distinct', 'attribute', null, {pos: 67}),
  D('admissions', '動員数', 'quantity', 'integer', 'sum', 'core', 'theatrical.admissions', {pos: 57}),
  D('box_office_ex_tax', '興行収入（税抜）', 'quantity', 'yen', 'sum', 'core', 'theatrical.gross_box_office', {pos: 58}),
  D('theatre_unit_ex_tax', '劇場別の単価（税抜）', 'quantity', 'decimal', 'ratio', 'derived', round(div(col('box_office_ex_tax'), col('admissions')), 2), {pos: 60, ...UNIT('box_office_ex_tax', 'admissions')}),
  D('ticket_unit_inc_tax', '券種の税込単価', 'quantity', 'decimal', 'ratio', 'attribute', null, {pos: 63, ...UNIT('h_ticket_inc_amount', 'admissions')}),
  D('delivered_units', '納品数（集計元の報告）', 'quantity', 'integer', 'sum', 'core', 'obs.delivered', {pos: 21}),
  D('active_stores', '稼動店舗数', 'quantity', 'integer', 'period_end', 'core', 'obs.active_stores', {pos: 22}),
  D('active_units_per_store', '店舗あたりの稼動商品数', 'quantity', 'integer', 'period_end', 'core', 'obs.active_units', {pos: 23}),
  D('stock_units', '在庫数（店舗）', 'quantity', 'integer', 'period_end', 'core', 'obs.inventory', {pos: 71}),
  D('rental_turnover', '回転率', 'quantity', 'decimal', 'ratio', 'attribute', null, {pos: 24, ...UNIT('rs_count', 'h_rental_units', {description: '集計は 販売件数の合計÷（販売件数÷回転率）の合計。回転率を記録した行だけで数える'})}),
  ref1('package_turns_count', 'レンタル回数', 'quantity', 'integer', 'package.turns_count'),
  D('rs_partner_unit_ex_tax', 'RS：取引先の単価（税抜）', 'quantity', 'decimal', 'ratio', 'core', 'channel.partner_unit_price', {pos: 20, ...UNIT('h_rs_partner_amount', 'rs_count')}),
  D('rs_holder_unit_ex_tax', 'RS：当社の単価（税抜）', 'quantity', 'decimal', 'ratio', 'core', 'channel.holder_unit_price', {pos: 26, ...UNIT('rs_holder_ex_tax', 'rs_count')}),
  D('overdue_count', '延滞数（通常）', 'quantity', 'integer', 'sum', 'attribute', null, {pos: 29}),
  D('overdue_amount', '延滞額（通常）', 'quantity', 'yen', 'sum', 'attribute', null, {pos: 30}),
  D('overdue_share', '延滞の分配額', 'quantity', 'yen', 'sum', 'attribute', null, {pos: 31}),
  D('rss_declared', 'レンタル（RSS）：申告額', 'quantity', 'yen', 'sum', 'attribute', null, {pos: 32}),
  D('unique_viewers', '視聴UU数', 'quantity', 'integer', 'sum', 'attribute', null, {pos: 35}),
  D('view_seconds', '視聴時間（秒）', 'quantity', 'integer', 'sum', 'core', 'digital.view_seconds', {pos: 36}),
  D('view_hours', '視聴時間（時間）', 'quantity', 'decimal', 'sum', 'derived', round(div(col('view_seconds'), {num: 3600}), 2), {pos: 37, digits: 2}),
  D('view_count', '視聴回数の合計', 'quantity', 'integer', 'sum', 'core', 'digital.view_count', {pos: 38}),
  D('vod_unit_ex_tax', '見放題・広告型・海外：単価（税抜）', 'quantity', 'decimal', 'ratio', 'core', 'digital.vod_unit_price', {pos: 39, ...UNIT('vod_holder_ex_tax', 'view_count', {digits: 4})}),
  D('vod_partner_sales_ex_tax', '見放題・広告型・海外：取引先の売上（税抜）', 'quantity', 'yen', 'sum', 'core', 'digital.vod_partner_sales', {pos: 40}),
  D('flat_deal_ex_tax', '契約額（配信の定額）', 'quantity', 'yen', 'sum', 'core', 'digital.contract_amount', {pos: 10}),
  D('mg_guarantee_ex_tax', '最低保証：保証額（税抜）', 'quantity', 'yen', 'period_end', 'derived', 'mg.amount', {pos: 15, description: MG_VERSION}),
  D('advance_guarantee_balance', '前払保証の残高', 'quantity', 'yen', 'period_end', 'derived', 'mg.balance',
    {pos: 74, description: `MG 台帳の回収の計算（FR-SETL-MGL-026）。${MG_VERSION}の保証額から、計上月までの実充当（訂正は訂正後の行）を引いた残り（0未満は0）`}),
  ref1('reported_actual_ex_tax', '原報告の実績額（税抜）', 'quantity', 'yen', 'channel.reported_actual'),
  ref1('reported_recognized_ex_tax', '原報告の計上額（税抜）', 'quantity', 'yen', 'channel.reported_recognized'),
  // 集計の補助（比率を分子と分母から再計算するための列。当社売上の2列は単価の分子）
  D('rs_holder_ex_tax', 'RS：当社売上（税抜）', 'helper', 'yen', 'sum', 'derived', 'block.rs', {pos: 28}),
  D('vod_holder_ex_tax', '見放題・広告型・海外：当社売上（税抜）', 'helper', 'yen', 'sum', 'derived', 'block.vod', {pos: 42}),
  D('h_rs_partner_amount', 'RS：取引先の単価×販売件数', 'helper', 'decimal', 'sum', 'derived', mul(col('rs_partner_unit_ex_tax'), col('rs_count')), {digits: 2}),
  D('h_rental_units', '回転率の分母（販売件数÷回転率）', 'helper', 'decimal', 'sum', 'derived', div(col('rs_count'), col('rental_turnover')), {digits: 4}),
  D('h_foreign_yen', '外貨：計上額×為替レート', 'helper', 'decimal', 'sum', 'derived', mul(col('foreign_amount'), col('exchange_rate')), {digits: 2}),
  D('h_ticket_inc_amount', '券種の税込単価×動員数', 'helper', 'decimal', 'sum', 'derived', mul(col('ticket_unit_inc_tax'), col('admissions')), {digits: 2}),
  D('h_flat_implied_deal', '定額：当社売上÷料率（取引額の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('flat_partner_rate'), {digits: 2}),
  D('h_mg_implied_gross', '最低保証：当社売上÷料率（取引先の売上の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('mg_partner_rate'), {digits: 2}),
  D('h_rs_implied_gross', 'RS：当社売上÷料率（取引先の売上の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('rs_partner_rate'), {digits: 2}),
  D('h_rss_implied_declared', 'レンタル（RSS）：当社売上÷料率（申告額の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('rss_partner_rate'), {digits: 2}),
  D('h_vod_implied_gross', '見放題・広告型・海外：当社売上÷料率（取引先の売上の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('vod_partner_rate'), {digits: 2}),
  // 監査・原本（明細 → 報告 → 原本の行 → 訂正の鎖 → 版つきの値 → 計上根拠）
  D('report_number', '報告番号（伝票番号）', 'audit', 'text', 'distinct', 'core', 'report.key', {pos: 55}),
  D('import_id', '取込の記録（報告ID）', 'audit', 'integer', 'distinct', 'core', 'report.id', {pos: 78}),
  D('source_file', '原本のファイル名', 'audit', 'text', 'distinct', 'core', 'source.file_name', {pos: 77}),
  ref1('source_row_number', '原本の行番号', 'audit', 'integer', 'sale.source_row'),
  D('row_fingerprint', '行の照合値', 'audit', 'text', 'distinct', 'core', 'report.row_fingerprint', {pos: 83}),
  D('record_version', '報告の版', 'audit', 'integer', 'min_max', 'core', 'report.version', {pos: 81}),
  D('registration_kind', '登録の種類', 'audit', 'text', 'distinct', 'core', 'report.registration_kind', {pos: 80}),
  ref1('supersedes_report_id', '訂正元の報告ID', 'audit', 'integer', 'report.supersedes_id'),
  D('imported_at', '取込日時', 'audit', 'text', 'min_max', 'core', 'report.created_at', {pos: 79}),
  D('processed_at', '加工日時', 'audit', 'text', 'min_max', 'core', 'source.processed_at', {pos: 76}),
  ref1('source_reference_id', '原本の追跡用参照', 'audit', 'text', 'source.reference_id'),
  ref1('distribution_version', '流通分類の版', 'audit', 'integer', 'dist.version'),
  ref1('recognition_basis_id', '計上基準ID', 'audit', 'integer', 'recognition.basis_id'),
  ref1('recognition_reason', '計上の理由', 'audit', 'text', 'recognition.reason'),
  ref1('report_received_on', '報告受領日', 'audit', 'date', 'recognition.received_on'),
  ref1('recognition_contract_start_on', '計上根拠の契約開始日', 'audit', 'date', 'recognition.contract_start_on'),
  ref1('license_start_on', '計上根拠の許諾開始日', 'audit', 'date', 'recognition.license_start_on'),
  ref1('broadcast_on', '計上根拠の放送日', 'audit', 'date', 'recognition.broadcast_on'),
  ref1('calculated_actual_ex_tax', '実績額の計算照合値（税抜）', 'audit', 'yen', 'channel.calculated_actual'),
  D('royalty_amount_mismatch', 'ロイヤリティ計上額の食い違い', 'audit', 'bool', 'distinct', 'derived', 'royalty.amount_mismatch',
    {since: 'v2', description: 'ロイヤリティ計上の基準の税抜・税額・税込が売上と違うか、外貨のロイヤリティ計上額が外貨の計上額と違えば「はい」（FR-SETL-ACCR-096 は額を変えさせない）'}),
  // 辞書から外す列（行き先なし。値は保存先に残る。定義は統合前のまま）
  D('flat_holder_ex_tax', '定額：当社売上（税抜）', 'holder_sales', 'yen', 'sum', 'derived', 'block.flat', {pos: 12, ...REMOVED}),
  D('mg_holder_ex_tax', '最低保証：当社売上（税抜）', 'holder_sales', 'yen', 'sum', 'derived', 'block.mg', {pos: 19, ...REMOVED}),
  D('rss_holder_ex_tax', 'レンタル（RSS）：当社売上（税抜）', 'holder_sales', 'yen', 'sum', 'derived', 'block.rss', {pos: 34, ...REMOVED}),
  D('theatre_unit_inc_tax', '劇場別の単価（税込）', 'unit_price', 'decimal', 'ratio', 'attribute', null, {pos: 59, ...UNIT('h_theatre_inc_amount', 'admissions'), ...REMOVED}),
  D('ticket_audience', '券種の対象層', 'theatre', 'text', 'distinct', 'attribute', null, {pos: 64, ...REMOVED}),
  D('ticket_campaign', '券種の施策（割引など）', 'theatre', 'bool', 'distinct', 'attribute', null, {pos: 65, ...REMOVED}),
  D('advance_guarantee_month', '当月の前払保証額', 'mg_balance', 'yen', 'sum', 'attribute', null, {pos: 72, description: '前払保証（最低保証の前払い）の、その月に初めて計上した分', ...REMOVED}),
  D('maker_paid_total', '製造元への支払累計額', 'mg_balance', 'yen', 'period_end', 'attribute', null, {pos: 73, ...REMOVED}),
  D('processing_id', '加工の記録', 'audit', 'text', 'distinct', 'core', 'source.processing_id', {pos: 75, ...REMOVED}),
  D('update_reason', '更新の理由', 'audit', 'text', 'distinct', 'attribute', null, {pos: 82, ...REMOVED}),
  D('h_theatre_inc_amount', '劇場別の単価（税込）×動員数', 'helper', 'decimal', 'sum', 'derived', mul(col('theatre_unit_inc_tax'), col('admissions')), {digits: 2, ...REMOVED}),
  {...ref1('report_status', '報告の状態', 'custom', 'text', 'report.status'), ...REMOVED},
];
export const SHEET_COLUMNS = Object.freeze(DICTIONARY.map((column, n) => Object.freeze({...column, sort_order: (n + 1) * 10})));
const SHEET_COLUMN_BY_KEY = new Map(SHEET_COLUMNS.map((column) => [column.key, column]));
export const sheetColumnOf = (key) => SHEET_COLUMN_BY_KEY.get(key) || null;
// 辞書の版の名前（採用の監査記録に残す）。統合前の初期の列（v1）・追加の列（additional-v1）は互換のために名前を残す
export const SHEET_CATALOG_VERSION = 'sales-sheet-v2';
export const INITIAL_CATALOG_VERSION = 'sales-sheet-v1';
export const ADDITIONAL_CATALOG_VERSION = 'sales-sheet-additional-v1';
// 裁定3 (a): ロイヤリティ計上の額の4列。額が売上と食い違う版が0件の組織だけ止める（件数があれば残す）
export const ROYALTY_AMOUNT_KEYS = Object.freeze(['foreign_royalty_amount', 'royalty_amount_ex_tax', 'royalty_amount_inc_tax', 'royalty_tax_amount']);
// 辞書のエントリ → 列カタログの行の形（sales_sheet_column_versions の列名）
export const catalogColumnOf = (column) => Object.freeze({
  column_key: column.key, legacy_position: column.legacy_position, label: column.label, group_key: column.group_key, value_type: column.value_type,
  aggregation: column.aggregation, source_kind: column.source_kind, source_ref: column.source_ref, formula: column.formula, numerator_key: column.numerator_key,
  denominator_key: column.denominator_key, ratio_scale: column.ratio_scale, digits: column.digits, description: column.description, sort_order: column.sort_order,
});
const inUse = (column) => !column.removed && !column.retired_by;
// 組織が採用する列（removed も retired_by も無い列）。裁定3の4列を含む（止めるかは組織ごとに adopt・adopt-v2 が決める）
export const INITIAL_SHEET_COLUMNS = Object.freeze(SHEET_COLUMNS.filter(inUse).map(catalogColumnOf));
// 外した拡張属性のキー（取込の列対応は読み飛ばす。値は sale_attribute_values に残る）
export const REMOVED_ATTRIBUTE_KEYS = Object.freeze(SHEET_COLUMNS.filter((column) => column.removed && column.source_kind === 'attribute').map((column) => column.key));
// 列カタログ（または キー→列 の Map）が辞書の v2 を採用済みか（v2 で足した列が1つでもある）
export function isV2Catalog(catalog) {
  const keys = catalog instanceof Map ? new Set(catalog.keys()) : new Set((catalog || []).map((column) => column.column_key));
  return SHEET_COLUMNS.some((column) => column.since === 'v2' && inUse(column) && keys.has(column.key));
}

// 統合前の追加の列（追加の28列）。adopt-additional（統合前に初期の列だけを採用した組織への互換の入口）だけが使う。
// 定義は統合前のまま（群は custom・並びは2000〜）。辞書の v2 へは adopt-v2 が版を足して合わせる
const C = (key, label, type, source) => Object.freeze({
  column_key: key, legacy_position: null, label, group_key: 'custom', value_type: type, aggregation: type === 'date' ? 'min_max' : 'distinct', source_kind: 'core', source_ref: source,
  formula: null, numerator_key: null, denominator_key: null, ratio_scale: null, digits: null, description: REFERENCE(source).description,
});
export const ADDITIONAL_SHEET_COLUMNS = Object.freeze([
  ['sales_period_to', '販売期間末日', 'date', 'sale.period_to'],
  ['report_period_from', '報告対象期間の初日', 'date', 'report.period_from'],
  ['report_period_to', '報告対象期間の末日', 'date', 'report.period_to'],
  ['raw_quantity', '明細の原数量', 'integer', 'sale.raw_quantity'],
  ['recognition_basis_id', '計上基準ID', 'integer', 'recognition.basis_id'],
  ['recognition_reason', '計上の理由', 'text', 'recognition.reason'],
  ['report_received_on', '報告受領日', 'date', 'recognition.received_on'],
  ['recognition_contract_start_on', '計上根拠の契約開始日', 'date', 'recognition.contract_start_on'],
  ['license_start_on', '計上根拠の許諾開始日', 'date', 'recognition.license_start_on'],
  ['broadcast_on', '計上根拠の放送日', 'date', 'recognition.broadcast_on'],
  ['report_status', '報告の状態', 'text', 'report.status'],
  ['supersedes_report_id', '訂正元の報告ID', 'integer', 'report.supersedes_id'],
  ['source_row_number', '原本の行番号', 'integer', 'sale.source_row'],
  ['source_reference_id', '原本の追跡用参照', 'text', 'source.reference_id'],
  ['distribution_version', '流通分類の版', 'integer', 'dist.version'],
  ['settlement_method', '精算方式', 'text', 'dist.settlement_method'],
  ['channel_model', '流通別の詳細モデル', 'text', 'channel.model'],
  ['service_code', '配信サービスコード', 'text', 'digital.service_code'],
  ['reported_actual_ex_tax', '原報告の実績額（税抜）', 'yen', 'channel.reported_actual'],
  ['reported_recognized_ex_tax', '原報告の計上額（税抜）', 'yen', 'channel.reported_recognized'],
  ['calculated_actual_ex_tax', '実績額の計算照合値（税抜）', 'yen', 'channel.calculated_actual'],
  ['package_turns_count', 'レンタル回数', 'integer', 'package.turns_count'],
  ['currency_rate_date', '為替の基準日', 'date', 'currency.rate_date'],
  ['currency_basis', '為替の根拠', 'text', 'currency.basis'],
  ['currency_version', '為替の版', 'integer', 'currency.version'],
  ['royalty_tax_amount', 'ロイヤリティ計上の税額', 'yen', 'royalty.tax_amount'],
  ['royalty_basis_version', 'ロイヤリティ計上の版', 'integer', 'royalty.version'],
  ['royalty_basis_origin', 'ロイヤリティ計上額の由来', 'text', 'royalty.origin'],
].map(([key, label, type, source]) => C(key, label, type, source)));
export const ADDITIONAL_KEYS = Object.freeze(ADDITIONAL_SHEET_COLUMNS.map((column) => column.column_key));
// セット名 additional・all_plus は全列の別名（URL の set= と保存した形のために名前を残す。中身は辞書の有効な列）
export const ADDITIONAL_COLUMN_SETS = Object.freeze([
  {key: 'additional', label: '追加の列'},
  {key: 'all_plus', label: '全列＋追加'},
]);

// ---------- 列セット ----------
// 7組の中身は統合前と同じ列リスト（使っていない列・外した列は組織のカタログで落ちる）
const BASE = ['booking_month', 'work_code', 'ref_work_title', 'partner_code', 'ref_partner_name'];
export const COLUMN_SETS = Object.freeze([
  {key: 'basic', label: '基本', columns: ['booking_month', 'sales_date', 'work_code', 'ref_work_title', 'partner_code', 'ref_partner_name', 'distribution_code', 'ref_distribution_name',
    'ref_transaction_method', 'product_code', 'line_note', 'rs_count', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax']},
  {key: 'theatre', label: '劇場', columns: [...BASE, 'theatre_name', 'ticket_name', 'ticket_category', 'ticket_audience', 'ticket_campaign', 'ticket_channel', 'ticket_raw_label',
    'admissions', 'box_office_ex_tax', 'theatre_unit_inc_tax', 'theatre_unit_ex_tax', 'ticket_unit_inc_tax', 'rs_holder_ex_tax', 'amount_ex_tax']},
  {key: 'videogram', label: 'ビデオグラム', columns: [...BASE, 'distribution_code', 'product_code', 'delivered_units', 'active_stores', 'active_units_per_store', 'rental_turnover', 'stock_units',
    'rs_partner_unit_ex_tax', 'rs_partner_rate', 'rs_holder_unit_ex_tax', 'rs_count', 'rs_holder_ex_tax', 'overdue_count', 'overdue_amount', 'overdue_share',
    'rss_declared', 'rss_partner_rate', 'rss_holder_ex_tax', 'amount_ex_tax']},
  {key: 'digital', label: '配信', columns: [...BASE, 'distribution_code', 'ref_service_name', 'ref_territory', 'unique_viewers', 'view_seconds', 'view_hours', 'view_count', 'vod_unit_ex_tax',
    'vod_partner_sales_ex_tax', 'vod_partner_rate', 'vod_holder_ex_tax', 'rs_partner_unit_ex_tax', 'rs_holder_unit_ex_tax', 'rs_count', 'rs_holder_ex_tax',
    'currency_code', 'foreign_amount', 'exchange_rate', 'amount_ex_tax']},
  {key: 'mgflat', label: 'MG・FLAT', columns: [...BASE, 'product_code', 'distribution_code', 'mg_group', 'flat_deal_ex_tax', 'flat_partner_rate', 'flat_holder_ex_tax', 'flat_start', 'flat_end',
    'mg_guarantee_ex_tax', 'mg_start', 'mg_end', 'mg_partner_rate', 'mg_holder_ex_tax', 'advance_guarantee_month', 'maker_paid_total', 'advance_guarantee_balance',
    'currency_code', 'foreign_amount', 'exchange_rate', 'amount_ex_tax']},
  {key: 'tax', label: '税・請求・入金', columns: ['booking_month', 'royalty_month', 'work_code', 'ref_work_title', 'partner_code', 'ref_partner_name', 'amount_ex_tax', 'tax_rate', 'tax_amount',
    'amount_inc_tax', 'royalty_amount_ex_tax', 'royalty_amount_inc_tax', 'currency_code', 'foreign_amount', 'foreign_royalty_amount', 'exchange_rate',
    'invoice_number', 'report_number', 'invoice_date', 'payment_due', 'paid_on']},
  {key: 'audit', label: '監査・原本', columns: ['sale_id', 'booking_month', 'work_code', 'partner_code', 'report_number', 'line_note', 'processing_id', 'processed_at', 'source_file',
    'import_id', 'imported_at', 'registration_kind', 'record_version', 'update_reason', 'row_fingerprint']},
]);
export const ALL_SET = 'all';
export const COLUMN_SET_LABELS = Object.freeze({...Object.fromEntries([...COLUMN_SETS, ...ADDITIONAL_COLUMN_SETS].map((set) => [set.key, set.label])), [ALL_SET]: '全列'});
// 辞書に無い列（管理者が足した列）がどの列セットに入るか（まとまりで決める）。辞書の列には効かせない
const GROUP_SETS = Object.freeze({
  theatre: ['theatre'], quantity: ['videogram', 'digital'], unit_price: ['videogram', 'digital'], rate: ['videogram', 'digital', 'mgflat'],
  partner_gross: ['mgflat'], holder_sales: ['mgflat'], currency: ['tax'], booking: ['tax'], mg_balance: ['mgflat'], audit: ['audit'], custom: ['basic'],
});
const isActiveColumn = (column) => column.active !== false && column.active !== 0;
const isHelperKey = (key) => key.startsWith('h_');
// 列セットの列キー（カタログの使っている列だけ）。全列（と別名の additional・all_plus）は使っている列を並び順（sort_order）に並べ、
// 集計の補助の列（h_…）だけを除く（比率の集計で内部に使う。列を指定すれば出せる）
export function columnsOfSet(setKey, catalog) {
  const active = catalog.filter(isActiveColumn);
  const set = COLUMN_SETS.find((item) => item.key === setKey);
  if (!set) {
    return active.filter((column) => !isHelperKey(column.column_key))
      .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || a.column_key.localeCompare(b.column_key))
      .map((column) => column.column_key);
  }
  const byKey = new Set(active.map((column) => column.column_key));
  const added = active.filter((column) => !SHEET_COLUMN_BY_KEY.has(column.column_key) && (GROUP_SETS[column.group_key] || []).includes(setKey))
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order)).map((column) => column.column_key);
  return [...set.columns.filter((key) => byKey.has(key)), ...added.filter((key) => !set.columns.includes(key))];
}

// 取込（取引先別の列対応・CSV）で値を入れられる拡張属性の列（辞書の採用する列）。取込の変換先の一覧（column-synonyms.mjs）が使う
export function attributeImportTargets(catalog = INITIAL_SHEET_COLUMNS) {
  return catalog.filter((column) => column.source_kind === 'attribute' && column.active !== false && column.active !== 0)
    .map((column) => ({key: attributeTargetKey(column.column_key), columnKey: column.column_key, label: column.label, valueType: column.value_type, group: GROUPS[column.group_key] || column.group_key}));
}
