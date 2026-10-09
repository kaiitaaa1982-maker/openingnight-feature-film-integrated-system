// 売上集計シート（83列）の列の許可リストと初期の列カタログ。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §4。
// - SOURCE_REFS: 列の値の取り方の許可リスト。列カタログ（sales_sheet_column_versions.source_ref）はこのキーだけを持ち、SQL の文字列は保存しない。
//   値はサーバーが読んだ「行の材料」（ctx）から作る。ctx の形は sales-sheet-routes.mjs の loadContexts を参照
// - INITIAL_SHEET_COLUMNS: 組織が採用する初期の列（元の並び1〜83と、参考の列・集計の補助の列）。見出しは中立の名前に付け直した
//   （定型業務の列の意味だけを使い、社名の入った見出し・物理名は持ち込まない）
// - COLUMN_SETS: 列セット7つ（基本／劇場／ビデオグラム／配信／MG・FLAT／税・請求・入金／監査・原本）と全列
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
const KIND_CODE = Object.freeze({digital: 'digital_unknown', package: 'package_unknown', theatrical: 'theatrical', broadcast: 'broadcast_unknown'});
export const distributionCodeOf = (ctx) => ctx?.dist?.code || KIND_CODE[ctx?.r?.kind] || 'other';
// 流通の分類が1つも無い明細の表示（流通ID は「未分類」、流通名は「未分類（ビデオグラム・区分未確認）」の形）。
// 集計・絞り込みのキーは distributionCodeOf のまま（報告の種類の既定 package_unknown など）なので、保存したシート・URL の絞り込みはそのまま動く
export const UNCLASSIFIED = '未分類';
export const unclassifiedName = (ctx) => (ctx?.distLabel ? `${UNCLASSIFIED}（${ctx.distLabel}）` : UNCLASSIFIED);
const obsSum = (ctx, metric, test = () => true) => sumOf((ctx.obs || []).filter((o) => o.metric === metric && test(o)).map((o) => Number(o.count)));
const storeUnit = (o) => /店/.test(String(o.unit || ''));
const svodLike = (ctx) => ['svod', 'avod'].includes(ctx.dg?.model);
const estLike = (ctx) => ['est', 'tvod'].includes(ctx.dg?.model);

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

// ---------- 初期の列カタログ ----------
// [列キー, 元の列番号, 見出し, まとまり, 型, 集計, 取り方の種類, 許可リストのキー|式, 追加（分子・分母・倍率・桁・説明）]
const C = (key, position, label, group, type, aggregation, kind, source, extra = {}) => Object.freeze({
  column_key: key, legacy_position: position, label, group_key: group, value_type: type, aggregation, source_kind: kind,
  source_ref: kind === 'attribute' || (kind === 'derived' && typeof source === 'object') ? null : source,
  formula: kind === 'derived' && typeof source === 'object' ? source : null,
  numerator_key: extra.num ?? null, denominator_key: extra.den ?? null, ratio_scale: extra.scale ?? null, digits: extra.digits ?? null,
  description: extra.description ?? null,
});
const RATE = (numKey, denKey, extra = {}) => ({num: numKey, den: denKey, scale: 100, digits: 2, ...extra});
// 記録した料率の集計: 行ごとに 当社売上÷料率×100（元の売上の逆算）を分母にして、当社売上の合計÷逆算の合計×100
const implied = (holderKey, rateKey) => div(mul(col(holderKey), {num: 100}), col(rateKey));
const IMPLIED = '集計は 当社売上の合計÷（当社売上÷料率×100）の合計×100。料率を記録した行だけで数える';
const UNIT = (numKey, denKey, extra = {}) => ({num: numKey, den: denKey, scale: 1, digits: 2, ...extra});

export const INITIAL_SHEET_COLUMNS = Object.freeze([
  C('sale_id', 1, '売上ID', 'identity', 'integer', 'distinct', 'core', 'sale.id'),
  C('distribution_code', 2, '流通ID', 'identity', 'text', 'distinct', 'core', 'dist.code', {description: '最新の流通分類（流通マスタの流通ID）。分類していない明細は「未分類」（帳票センターの流通の分類で分ける）'}),
  C('sales_date', 3, '販売日（販売期間の初日）', 'dates', 'date', 'min_max', 'core', 'sale.sales_date'),
  C('booking_month', 4, '計上月', 'dates', 'month', 'min_max', 'core', 'sale.accounting_month'),
  C('royalty_month', 5, 'ロイヤリティ計上月', 'dates', 'month', 'min_max', 'derived', 'royalty.month', {description: 'ロイヤリティ計上の基準の記録。無ければ計上月'}),
  C('work_code', 6, '作品コード', 'identity', 'text', 'distinct', 'core', 'work.code'),
  C('product_code', 7, '商品コード（SKU）', 'identity', 'text', 'distinct', 'core', 'product.sku'),
  C('mg_group', 8, '最低保証の契約コード', 'identity', 'text', 'distinct', 'derived', 'mg.code', {description: '商品が入っている受取の最低保証（MG）契約'}),
  C('partner_code', 9, '取引先コード', 'identity', 'text', 'distinct', 'core', 'partner.code'),
  C('flat_deal_ex_tax', 10, '定額：取引額（税抜）', 'partner_gross', 'yen', 'sum', 'core', 'digital.contract_amount'),
  C('flat_partner_rate', 11, '定額：取引先の支払料率（%）', 'rate', 'rate_pct', 'ratio', 'attribute', null, RATE('flat_holder_ex_tax', 'h_flat_implied_deal', {description: IMPLIED})),
  C('flat_holder_ex_tax', 12, '定額：当社売上（税抜）', 'holder_sales', 'yen', 'sum', 'derived', 'block.flat'),
  C('flat_start', 13, '定額：契約開始日', 'dates', 'date', 'min_max', 'core', 'digital.contract_from'),
  C('flat_end', 14, '定額：契約終了日', 'dates', 'date', 'min_max', 'core', 'digital.contract_to'),
  C('mg_guarantee_ex_tax', 15, '最低保証：保証額（税抜）', 'partner_gross', 'yen', 'period_end', 'derived', 'mg.amount'),
  C('mg_start', 16, '最低保証：契約開始日', 'dates', 'date', 'min_max', 'derived', 'mg.starts_on'),
  C('mg_end', 17, '最低保証：契約終了日', 'dates', 'date', 'min_max', 'derived', 'mg.ends_on'),
  C('mg_partner_rate', 18, '最低保証：取引先の支払料率（%）', 'rate', 'rate_pct', 'ratio', 'attribute', null, RATE('mg_holder_ex_tax', 'h_mg_implied_gross', {description: IMPLIED})),
  C('mg_holder_ex_tax', 19, '最低保証：当社売上（税抜）', 'holder_sales', 'yen', 'sum', 'derived', 'block.mg'),
  C('rs_partner_unit_ex_tax', 20, 'RS：取引先の単価（税抜）', 'unit_price', 'decimal', 'ratio', 'core', 'channel.partner_unit_price', UNIT('h_rs_partner_amount', 'rs_count')),
  C('delivered_units', 21, '納品数（集計元の報告）', 'quantity', 'integer', 'sum', 'core', 'obs.delivered'),
  C('active_stores', 22, '稼動店舗数', 'quantity', 'integer', 'period_end', 'core', 'obs.active_stores'),
  C('active_units_per_store', 23, '店舗あたりの稼動商品数', 'quantity', 'integer', 'period_end', 'core', 'obs.active_units'),
  C('rental_turnover', 24, '回転率', 'quantity', 'decimal', 'ratio', 'attribute', null, UNIT('rs_count', 'h_rental_units', {description: '集計は 販売件数の合計÷（販売件数÷回転率）の合計。回転率を記録した行だけで数える'})),
  C('rs_partner_rate', 25, 'RS：取引先の支払料率（%）', 'rate', 'rate_pct', 'ratio', 'attribute', null, RATE('rs_holder_ex_tax', 'h_rs_implied_gross', {description: IMPLIED})),
  C('rs_holder_unit_ex_tax', 26, 'RS：当社の単価（税抜）', 'unit_price', 'decimal', 'ratio', 'core', 'channel.holder_unit_price', UNIT('rs_holder_ex_tax', 'rs_count')),
  C('rs_count', 27, 'RS：販売件数', 'quantity', 'integer', 'sum', 'core', 'channel.sales_count'),
  C('rs_holder_ex_tax', 28, 'RS：当社売上（税抜）', 'holder_sales', 'yen', 'sum', 'derived', 'block.rs'),
  C('overdue_count', 29, '延滞数（通常）', 'quantity', 'integer', 'sum', 'attribute', null),
  C('overdue_amount', 30, '延滞額（通常）', 'partner_gross', 'yen', 'sum', 'attribute', null),
  C('overdue_share', 31, '延滞の分配額', 'holder_sales', 'yen', 'sum', 'attribute', null),
  C('rss_declared', 32, 'レンタル（RSS）：申告額', 'partner_gross', 'yen', 'sum', 'attribute', null),
  C('rss_partner_rate', 33, 'レンタル（RSS）：取引先の支払料率（%）', 'rate', 'rate_pct', 'ratio', 'attribute', null, RATE('rss_holder_ex_tax', 'h_rss_implied_declared', {description: IMPLIED})),
  C('rss_holder_ex_tax', 34, 'レンタル（RSS）：当社売上（税抜）', 'holder_sales', 'yen', 'sum', 'derived', 'block.rss'),
  C('unique_viewers', 35, '視聴UU数', 'quantity', 'integer', 'sum', 'attribute', null),
  C('view_seconds', 36, '視聴時間（秒）', 'quantity', 'integer', 'sum', 'core', 'digital.view_seconds'),
  C('view_hours', 37, '視聴時間（時間）', 'quantity', 'decimal', 'sum', 'derived', round(div(col('view_seconds'), {num: 3600}), 2), {digits: 2}),
  C('view_count', 38, '視聴回数の合計', 'quantity', 'integer', 'sum', 'core', 'digital.view_count'),
  C('vod_unit_ex_tax', 39, '見放題・広告型・海外：単価（税抜）', 'unit_price', 'decimal', 'ratio', 'core', 'digital.vod_unit_price', UNIT('vod_holder_ex_tax', 'view_count', {digits: 4})),
  C('vod_partner_sales_ex_tax', 40, '見放題・広告型・海外：取引先の売上（税抜）', 'partner_gross', 'yen', 'sum', 'core', 'digital.vod_partner_sales'),
  C('vod_partner_rate', 41, '見放題・広告型・海外：取引先の支払料率（%）', 'rate', 'rate_pct', 'ratio', 'attribute', null, RATE('vod_holder_ex_tax', 'h_vod_implied_gross', {description: IMPLIED})),
  C('vod_holder_ex_tax', 42, '見放題・広告型・海外：当社売上（税抜）', 'holder_sales', 'yen', 'sum', 'derived', 'block.vod'),
  C('foreign_amount', 43, '外貨：計上額（税抜）', 'currency', 'decimal', 'sum', 'core', 'currency.amount', {digits: 2, description: '通貨が混ざる集計では空にする'}),
  C('foreign_royalty_amount', 44, '外貨：ロイヤリティ計上額（税抜）', 'currency', 'decimal', 'sum', 'core', 'currency.royalty_amount', {digits: 2}),
  C('currency_code', 45, '通貨', 'currency', 'text', 'distinct', 'core', 'currency.code', {description: '外貨の記録が無い売上は JPY'}),
  C('exchange_rate', 46, '為替レート（1外貨あたりの円）', 'currency', 'decimal', 'ratio', 'core', 'currency.rate', UNIT('h_foreign_yen', 'foreign_amount', {digits: 4})),
  C('amount_ex_tax', 47, '計上額（税抜）', 'booking', 'yen', 'sum', 'core', 'sale.amount_ex_tax'),
  C('royalty_amount_ex_tax', 48, 'ロイヤリティ計上額（税抜）', 'booking', 'yen', 'sum', 'derived', 'royalty.amount_ex_tax', {description: 'ロイヤリティ計上の基準の記録。無ければ計上額と同じ'}),
  C('tax_rate', 49, '消費税率（%）', 'booking', 'rate_pct', 'ratio', 'derived', 'sale.tax_rate', RATE('tax_amount', 'amount_ex_tax', {digits: 1})),
  C('tax_amount', 50, '消費税額', 'booking', 'yen', 'sum', 'core', 'sale.tax_amount'),
  C('amount_inc_tax', 51, '計上額（税込）', 'booking', 'yen', 'sum', 'core', 'sale.amount_inc_tax'),
  C('royalty_amount_inc_tax', 52, 'ロイヤリティ計上額（税込）', 'booking', 'yen', 'sum', 'derived', 'royalty.amount_inc_tax'),
  C('line_note', 53, '明細名・備考', 'note', 'text', 'distinct', 'core', 'sale.description'),
  C('invoice_number', 54, '請求書番号', 'identity', 'text', 'distinct', 'core', 'billing.invoice_number'),
  C('report_number', 55, '報告番号（伝票番号）', 'identity', 'text', 'distinct', 'core', 'report.key'),
  C('theatre_name', 56, '劇場名', 'theatre', 'text', 'distinct', 'attribute', null),
  C('admissions', 57, '動員数', 'quantity', 'integer', 'sum', 'core', 'theatrical.admissions'),
  C('box_office_ex_tax', 58, '興行収入（税抜）', 'partner_gross', 'yen', 'sum', 'core', 'theatrical.gross_box_office'),
  C('theatre_unit_inc_tax', 59, '劇場別の単価（税込）', 'unit_price', 'decimal', 'ratio', 'attribute', null, UNIT('h_theatre_inc_amount', 'admissions')),
  C('theatre_unit_ex_tax', 60, '劇場別の単価（税抜）', 'unit_price', 'decimal', 'ratio', 'derived', round(div(col('box_office_ex_tax'), col('admissions')), 2), UNIT('box_office_ex_tax', 'admissions')),
  C('ticket_category', 61, '券種の区分', 'theatre', 'text', 'distinct', 'attribute', null),
  C('ticket_name', 62, '券種名', 'theatre', 'text', 'distinct', 'core', 'theatrical.ticket_type'),
  C('ticket_unit_inc_tax', 63, '券種の税込単価', 'unit_price', 'decimal', 'ratio', 'attribute', null, UNIT('h_ticket_inc_amount', 'admissions')),
  C('ticket_audience', 64, '券種の対象層', 'theatre', 'text', 'distinct', 'attribute', null),
  C('ticket_campaign', 65, '券種の施策（割引など）', 'theatre', 'bool', 'distinct', 'attribute', null),
  C('ticket_channel', 66, '券種の購入経路', 'theatre', 'text', 'distinct', 'core', 'theatrical.purchase_channel'),
  C('ticket_raw_label', 67, '券種の表記（原文）', 'theatre', 'text', 'distinct', 'attribute', null),
  C('invoice_date', 68, '請求日', 'dates', 'date', 'min_max', 'core', 'billing.invoice_date'),
  C('payment_due', 69, '入金期日', 'dates', 'date', 'min_max', 'core', 'billing.due_date'),
  C('paid_on', 70, '入金日', 'dates', 'date', 'min_max', 'core', 'billing.received_on'),
  C('stock_units', 71, '在庫数（店舗）', 'quantity', 'integer', 'period_end', 'core', 'obs.inventory'),
  C('advance_guarantee_month', 72, '当月の前払保証額', 'mg_balance', 'yen', 'sum', 'attribute', null, {description: '前払保証（最低保証の前払い）の、その月に初めて計上した分'}),
  C('maker_paid_total', 73, '製造元への支払累計額', 'mg_balance', 'yen', 'period_end', 'attribute', null),
  C('advance_guarantee_balance', 74, '前払保証の残高', 'mg_balance', 'yen', 'period_end', 'derived', 'mg.balance'),
  C('processing_id', 75, '加工の記録', 'audit', 'text', 'distinct', 'core', 'source.processing_id'),
  C('processed_at', 76, '加工日時', 'audit', 'text', 'min_max', 'core', 'source.processed_at'),
  C('source_file', 77, '原本のファイル名', 'audit', 'text', 'distinct', 'core', 'source.file_name'),
  C('import_id', 78, '取込の記録（報告ID）', 'audit', 'integer', 'distinct', 'core', 'report.id'),
  C('imported_at', 79, '取込日時', 'audit', 'text', 'min_max', 'core', 'report.created_at'),
  C('registration_kind', 80, '登録の種類', 'audit', 'text', 'distinct', 'core', 'report.registration_kind'),
  C('record_version', 81, '報告の版', 'audit', 'integer', 'min_max', 'core', 'report.version'),
  C('update_reason', 82, '更新の理由', 'audit', 'text', 'distinct', 'attribute', null),
  C('row_fingerprint', 83, '行の照合値', 'audit', 'text', 'distinct', 'core', 'report.row_fingerprint'),
  // 参考の列（元の83列には無い。見出しを人が読むため）
  C('ref_work_title', null, '作品名', 'reference', 'text', 'distinct', 'core', 'work.title'),
  C('ref_partner_name', null, '取引先名', 'reference', 'text', 'distinct', 'core', 'partner.name'),
  C('ref_product_name', null, '商品名', 'reference', 'text', 'distinct', 'core', 'product.name'),
  C('ref_distribution_name', null, '流通名', 'reference', 'text', 'distinct', 'core', 'dist.name'),
  C('ref_transaction_method', null, '取引方法', 'reference', 'text', 'distinct', 'core', 'dist.method'),
  C('ref_sales_type', null, '販売種別', 'reference', 'text', 'distinct', 'core', 'dist.sales_type'),
  C('ref_report_kind', null, '報告の種類', 'reference', 'text', 'distinct', 'core', 'report.kind'),
  C('ref_territory', null, '地域', 'reference', 'text', 'distinct', 'core', 'dist.territory'),
  C('ref_service_name', null, 'サービス名', 'reference', 'text', 'distinct', 'core', 'dist.service_name'),
  C('ref_sales_month', null, '販売月', 'reference', 'month', 'min_max', 'core', 'sale.sales_month'),
  // 集計の補助（比率を分子と分母から再計算するための積）
  C('h_rs_partner_amount', null, 'RS：取引先の単価×販売件数', 'helper', 'decimal', 'sum', 'derived', mul(col('rs_partner_unit_ex_tax'), col('rs_count')), {digits: 2}),
  C('h_flat_implied_deal', null, '定額：当社売上÷料率（取引額の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('flat_holder_ex_tax', 'flat_partner_rate'), {digits: 2}),
  C('h_mg_implied_gross', null, '最低保証：当社売上÷料率（取引先の売上の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('mg_holder_ex_tax', 'mg_partner_rate'), {digits: 2}),
  C('h_rental_units', null, '回転率の分母（販売件数÷回転率）', 'helper', 'decimal', 'sum', 'derived', div(col('rs_count'), col('rental_turnover')), {digits: 4}),
  C('h_rs_implied_gross', null, 'RS：当社売上÷料率（取引先の売上の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('rs_holder_ex_tax', 'rs_partner_rate'), {digits: 2}),
  C('h_rss_implied_declared', null, 'レンタル（RSS）：当社売上÷料率（申告額の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('rss_holder_ex_tax', 'rss_partner_rate'), {digits: 2}),
  C('h_vod_implied_gross', null, '見放題・広告型・海外：当社売上÷料率（取引先の売上の逆算）', 'helper', 'decimal', 'sum', 'derived', implied('vod_holder_ex_tax', 'vod_partner_rate'), {digits: 2}),
  C('h_foreign_yen', null, '外貨：計上額×為替レート', 'helper', 'decimal', 'sum', 'derived', mul(col('foreign_amount'), col('exchange_rate')), {digits: 2}),
  C('h_theatre_inc_amount', null, '劇場別の単価（税込）×動員数', 'helper', 'decimal', 'sum', 'derived', mul(col('theatre_unit_inc_tax'), col('admissions')), {digits: 2}),
  C('h_ticket_inc_amount', null, '券種の税込単価×動員数', 'helper', 'decimal', 'sum', 'derived', mul(col('ticket_unit_inc_tax'), col('admissions')), {digits: 2}),
]);
// 初期テンプレートの版の名前（採用の監査記録・Excel の定義に出す）
export const INITIAL_CATALOG_VERSION = 'sales-sheet-v1';

// 初期カタログとは別に採用する。83列・参考列・既存の列セットを変更しない。
export const ADDITIONAL_CATALOG_VERSION = 'sales-sheet-additional-v1';
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
].map(([key, label, type, source]) => C(key, null, label, 'custom', type, type === 'date' ? 'min_max' : 'distinct', 'core', source,
  {description: `${SOURCE_REFS[source].label}。既存の正本を参照。合算せず、日付は範囲、それ以外は種類を表示する。`} )));
export const ADDITIONAL_KEYS = Object.freeze(ADDITIONAL_SHEET_COLUMNS.map((column) => column.column_key));
export const isAdditionalColumn = (column) => ADDITIONAL_SHEET_COLUMNS.some((a) => a.column_key === column.column_key && a.source_kind === column.source_kind && a.source_ref === column.source_ref && a.value_type === column.value_type && column.legacy_position == null);
export const ADDITIONAL_COLUMN_SETS = Object.freeze([
  {key: 'additional', label: '追加の列', columns: ADDITIONAL_KEYS},
  {key: 'all_plus', label: '全列＋追加', columns: [...INITIAL_SHEET_COLUMNS.filter((c) => c.legacy_position).map((c) => c.column_key), ...ADDITIONAL_KEYS]},
]);

// ---------- 列セット ----------
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
// 採用後に足した列（元の83列に無い列）がどの列セットに入るか（まとまりで決める）
const GROUP_SETS = Object.freeze({
  theatre: ['theatre'], quantity: ['videogram', 'digital'], unit_price: ['videogram', 'digital'], rate: ['videogram', 'digital', 'mgflat'],
  partner_gross: ['mgflat'], holder_sales: ['mgflat'], currency: ['tax'], booking: ['tax'], mg_balance: ['mgflat'], audit: ['audit'], custom: ['basic'],
});
// 列セットの列キー（カタログの列だけ。使っていない列は除く）。全列は 元の並び（1〜83）→ 参考 → 追加の列 の順。
// 集計の補助の列（h_…）は列セットに入れない（比率の集計で内部に使う。列を指定すれば出せる）
export function columnsOfSet(setKey, catalog) {
  const extraSet = ADDITIONAL_COLUMN_SETS.find((set) => set.key === setKey);
  if (extraSet) return extraSet.columns.filter((key) => catalog.some((c) => c.column_key === key && c.active !== false && c.active !== 0 && (!ADDITIONAL_KEYS.includes(key) || isAdditionalColumn(c))));
  catalog = catalog.filter((c) => !isAdditionalColumn(c));
  const active = catalog.filter((column) => column.active !== false && column.active !== 0);
  const byKey = new Map(active.map((column) => [column.column_key, column]));
  if (setKey === ALL_SET || !COLUMN_SETS.some((set) => set.key === setKey)) {
    const rank = (column) => (column.legacy_position ? 0 : column.group_key === 'reference' ? 1 : 2);
    return active.filter((column) => column.group_key !== 'helper')
      .sort((a, b) => rank(a) - rank(b) || (a.legacy_position ?? 0) - (b.legacy_position ?? 0) || a.sort_order - b.sort_order || a.column_key.localeCompare(b.column_key))
      .map((column) => column.column_key);
  }
  const set = COLUMN_SETS.find((item) => item.key === setKey);
  const initial = new Set(INITIAL_SHEET_COLUMNS.map((column) => column.column_key));
  const added = active.filter((column) => !initial.has(column.column_key) && (GROUP_SETS[column.group_key] || []).includes(setKey))
    .sort((a, b) => a.sort_order - b.sort_order).map((column) => column.column_key);
  return [...set.columns.filter((key) => byKey.has(key)), ...added.filter((key) => !set.columns.includes(key))];
}

// 取込（取引先別の列対応・CSV）で値を入れられる拡張属性の列（初期カタログ）。取込の変換先の一覧（column-synonyms.mjs）が使う
export function attributeImportTargets(catalog = INITIAL_SHEET_COLUMNS) {
  return catalog.filter((column) => column.source_kind === 'attribute' && column.active !== false && column.active !== 0)
    .map((column) => ({key: attributeTargetKey(column.column_key), columnKey: column.column_key, label: column.label, valueType: column.value_type, group: GROUPS[column.group_key] || column.group_key}));
}
