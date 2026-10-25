#!/usr/bin/env node
// 売上集計シートの粒度の試験（test/sales-sheet-grain.test.mjs）の fixture を、統合前のコードと架空データから作る
// （会社ルートの plans/2026-10-09-sheet-columns-by-grain.md の香盤表 #3）。
//
//   node scripts/sales-sheet-grain-fixtures.mjs [--out <フォルダ>] [--twice]
//
// ・メモリの SQLite（使い捨て）に seedGrainDemo で架空データを入れ、架空の管理者で API を通して読み、4つの JSON を書く（既定 test/fixtures/sales-sheet/）:
//   grain-snapshot.json       明細の件数と、作品×商品×流通区分×取引先×月（計上月・販売月・ロイヤリティ計上月）ごとの
//                             amount_ex_tax・tax_amount・amount_inc_tax・raw_quantity・vod_partner_sales_ex_tax の合計、集計（切り口）の5つの測度、
//                             月を横に並べた集計（3つの月の基準）、比率（#20・#26・#39・#46）、流通区分の切り口（区分未確認を含む）、券種の切り口、
//                             保存した形の結果（G-1・G-5・G-8・G-9）
//   legacy-reproduction.json  旧131エントリの各列の値（再現表の種。G-2）。MG の4列（#15〜17・#74）は mg-versions.json で比べるので行に入れない
//   catalog-v1.json           旧の列カタログ（初期の列と追加の列の定義）・列セット・API の項目名（G-9・G-13・G-14）
//   mg-versions.json          版を2つ持つ MG 契約と訂正の行の架空の種と、月ごとの期待値（G-12。その月末までに始まった最新の版）
// ・--twice は2つの DB で2回作り、同じ JSON になることを確かめる（違えば終了コード1で、書き出さない）
// ・統合後のコード（唯一の辞書 SHEET_COLUMNS がある）では作らない（終了コード2）。統合前の値を固定する fixture を、統合後の出力で上書きしないため
// ・統合後のコードで試験が seedGrainDemo を呼ぶときは、組織 DEMO-SALES を「統合前に列を採用した組織」として作る（採用の入口は辞書の v2 を入れるので、
//   統合前の初期の列は catalog-v1.json から版1で入れる。insertPreIntegrationCatalog）。追加の列は seed の adopt-additional が入れる（統合前と同じ順）
// ・架空データは scripts/seed-all-demo.mjs の節のうち、台本PDFの取込（kouban。Python が要る）と原本の例（expense-originals）を除いたもの。
//   連続ドラマの作品だけは API で作る（test/seed-eigyo-demo.test.mjs と同じ）。そのうえで、旧131エントリのどの列にも値のある行ができるよう、
//   次を API で足す（seed-all-demo の売上は流通別の詳細・料率・原本の参照・訂正を持たないため。足さないと空の値どうしの比較になる）:
//   - 流通別の詳細つきの報告8通（CHANNEL_DETAIL_REPORTS。劇場・レンタル・都度課金・定額制・広告型・配信の定額・配信の最低保証・購入型）。
//     料率（定額・MG・RS・RSS・VOD の5キーに6売上。1売上に1キーで、どれも流通のまとまりと合うキー）と、ほかの拡張属性は取込の列（attr_<列キー>）で入れる
//   - 原本の参照の3つの経路の報告（SOURCE_ROUTE_REPORTS。列対応で取り込んだ CSV・旧方式の原本の選択・原本の分割）。原本の読み取りは
//     fixtureExtractor（Python を使わない。test/sales-source.test.mjs と同じ形）
//   - 訂正した報告（訂正前と訂正後）・取消の報告・流通分類を直して版2になった売上・ロイヤリティ計上の基準が版2の売上（REVISION_REPORTS）
//   - 月だけを翌月にしたロイヤリティ計上の基準2件（1件は版2で翌々月）、外貨のロイヤリティ計上額1件、手入力の拡張属性（MANUAL_ATTRIBUTES）
//   （ロイヤリティ計上の額はどれも売上と同じ。裁定3の食い違いは0件のまま。料率は1売上に1キー・まとまりと合うキーだけ（G-7 は0件のまま））
// ・取消の API は無い（report_imports.status は 'void' を持てるが、変える画面が無い）ので、取消の報告だけは取り込んだあとに表の状態を 'void' にする
// ・取込日時・加工日時は流すたびに変わるので、値の代わりに「(時刻)」を入れる（VOLATILE_COLUMNS）
// ・本番・staging・業務データ層には触れない
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv} from '../src/csv.mjs';
import * as registry from '../src/sales-sheet/column-registry.mjs';
import {seedAllDemo} from './seed-all-demo.mjs';
import {SALES_DEMO} from './seed-sales-demo.mjs';
import {EIGYO_DEMO} from './seed-eigyo-demo.mjs';
import {LEGACY_PLAN, MG_FIXTURE_KEYS} from './sales-sheet-columns-v2.mjs';

export const FIXTURE_DIR = fileURLToPath(new URL('../test/fixtures/sales-sheet/', import.meta.url));
export const GRAIN_SEED_STEPS = Object.freeze(['sales', 'distribution', 'eigyo', 'broadcast', 'plbs', 'expenses', 'masters']);
export const VOLATILE_COLUMNS = Object.freeze(['processed_at', 'imported_at']);
export const VOLATILE_MARK = '(時刻)';
export const SNAPSHOT_MEASURES = Object.freeze(['amount_ex_tax', 'tax_amount', 'amount_inc_tax', 'raw_quantity', 'vod_partner_sales_ex_tax']);
export const SNAPSHOT_KEYS = Object.freeze(['work_code', 'product_code', 'distribution_code', 'partner_code']);
export const MONTH_COLUMNS = Object.freeze({accounting: 'booking_month', sales: 'ref_sales_month', royalty: 'royalty_month'});
export const RATIO_COLUMNS = Object.freeze(['rs_partner_unit_ex_tax', 'rs_holder_unit_ex_tax', 'vod_unit_ex_tax', 'exchange_rate']);
// 集計（切り口は最大3つ）で5つの測度を控える切り口の組（G-1）
export const AGGREGATE_DIMS = Object.freeze([['work', 'product', 'distribution'], ['distribution', 'partner'], ['work', 'product', 'partner']]);
const PAGE = 500;

// 統合後のコードでは fixture を作らない。module は column-registry.mjs（試験では差し替えて確かめる）
export const preIntegrationProblem = (module = registry) => (Array.isArray(module.SHEET_COLUMNS)
  ? 'src/sales-sheet/column-registry.mjs に唯一の辞書（SHEET_COLUMNS）があります。この fixture は統合前のコードの値を固定するものなので、統合後のコードでは作りません'
  : null);

// ---------- API ----------
// 架空のメンバーで入り、{get, post, raw} を返す。get・post は 2xx 以外で止める。raw は {status, body} を返す（試験で失敗の形も見る）
export async function apiClient(app, email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  if (response.status !== 200) throw new Error(`${email} でログインできません（${response.status}）`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const raw = async (method, path, payload) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())};
  };
  const strict = async (method, path, payload) => {
    const out = await raw(method, path, payload);
    if (out.status >= 300 || out.body?.ok === false) throw new Error(`${method} ${path}: ${out.status} ${JSON.stringify(out.body).slice(0, 600)}`);
    return out.body;
  };
  return {raw, get: (path) => strict('GET', path), post: (path, payload) => strict('POST', path, payload)};
}
export const query = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();

// ---------- 原本の読み取りの代わり ----------
// 架空の原本は「区切りの入らない値」を , と改行で並べた文字。1枚のシート（FIXTURE_SHEET）として返す。
// 本物の抽出器（python/extract_document.py）は Python が要るので、fixture と試験ではこれを使う
export const FIXTURE_SHEET = '報告';
export async function fixtureExtractor({name, base64}) {
  const bytes = Buffer.from(String(base64), 'base64');
  const rows = bytes.toString('utf8').split('\n').filter((line) => line !== '').map((line) => line.split(','));
  return {extractorName: 'grain-fixture', extractorVersion: '1', rawSha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, name,
    documentType: 'workbook', status: 'extracted', text: '', sheets: [{name: FIXTURE_SHEET, rows}]};
}
export function sourceFileBase64(rows) {
  for (const cell of rows.flat()) if (/[,\n\r"]/.test(String(cell))) throw new Error(`架空の原本の値に区切りの文字があります: ${cell}`);
  return Buffer.from(rows.map((row) => row.join(',')).join('\n')).toString('base64');
}

// ---------- 架空データ ----------
// seed-all-demo の節（台本PDF・原本の例を除く）と、上の見出しに書いた追加。試験（test/sales-sheet-grain.test.mjs）も同じ関数で入れるので、
// fixture と同じ売上ID・値になる
export async function seedGrainDemo(db, {log = () => {}} = {}) {
  await seedAllDemo(db, {only: ['sales', 'distribution'], log});
  const app = createApp({db, mode: 'local', extractDocument: fixtureExtractor});
  const api = await apiClient(app, SALES_DEMO.adminEmail);
  const project = await api.post('/projects', {code: 'DEMO-P-SERIES', title: '架空の連続ドラマ（架空）', status: 'active', budget_yen: 1000000});
  await api.post('/works', {project_id: project.id, code: EIGYO_DEMO.seriesWork, title: '架空の連続ドラマ 第7・8話（架空）', format: 'series'});
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  if (preIntegrationProblem()) {
    const admin = await db.get('SELECT id FROM users WHERE email=?', [SALES_DEMO.adminEmail]);
    await insertPreIntegrationCatalog(db, org.id, Number(admin.id), {reason: '統合前に採用した初期の列（catalog-v1.json。架空データ）'});
  }
  await seedAllDemo(db, {only: GRAIN_SEED_STEPS.filter((key) => !['sales', 'distribution'].includes(key)), log});
  const ids = masterIds(db, org.id);
  for (const report of CHANNEL_DETAIL_REPORTS) await importReport(db, api, org.id, ids, report);
  // ロイヤリティ計上の基準: 配信の売上の最初の2件の月を1か月後へ（額は売上と同じ。月だけを変える）。1件目は版2で翌々月へ
  const digital = await db.all(`SELECT s.id,s.accounting_month,s.amount_ex_tax,s.tax_amount FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=? AND r.status='active' AND r.kind='digital' ORDER BY s.id LIMIT 2`, [org.id]);
  for (const line of digital) {
    await api.post(`/sales-sheet/sales/${line.id}/royalty-basis`, {baseVersion: 0, royaltyMonth: nextMonth(line.accounting_month), amountExTax: String(line.amount_ex_tax),
      taxAmount: String(line.tax_amount), reason: '報告の到着が遅れた分のロイヤリティ計上月を翌月にする（架空データ・額は売上と同じ）'});
  }
  await api.post(`/sales-sheet/sales/${digital[0].id}/royalty-basis`, {baseVersion: 1, royaltyMonth: nextMonth(nextMonth(digital[0].accounting_month)),
    amountExTax: String(digital[0].amount_ex_tax), taxAmount: String(digital[0].tax_amount), reason: '報告がさらに遅れたのでロイヤリティ計上月を翌々月に直す（架空データ・額は売上と同じ）'});
  // 外貨のロイヤリティ計上額: 外貨の記録がある最初の売上に、外貨の計上額と同じ額を足した版
  const currency = await db.get(`SELECT v.sale_id,v.currency_code,v.original_amount_x100,v.exchange_rate_x10000,v.rate_date,v.basis FROM sale_currency_versions v
    WHERE v.org_id=? AND v.version_no=1 ORDER BY v.sale_id LIMIT 1`, [org.id]);
  await api.post(`/sales-sheet/sales/${currency.sale_id}/currency`, {baseVersion: 1, currencyCode: currency.currency_code, originalAmount: x100Text(currency.original_amount_x100),
    originalRoyaltyAmount: x100Text(currency.original_amount_x100), exchangeRate: x10000Text(currency.exchange_rate_x10000), rateDate: currency.rate_date, basis: currency.basis,
    reason: '外貨のロイヤリティ計上額を記録（架空データ・外貨の計上額と同じ）'});
  await seedSourceRoutes(db, api, org.id, ids);
  await seedRevisions(db, api, org.id, ids);
  for (const item of MANUAL_ATTRIBUTES) {
    const saleId = await saleOf(db, org.id, item.reportKey, item.row);
    await api.post('/sales-sheet/values', {reason: item.reason, changes: Object.entries(item.values).map(([columnKey, value]) => ({saleId, columnKey, baseVersion: 0, value}))});
  }
  return {orgId: org.id, api, app};
}

// 統合前の採用（adopt）と同じ形で、統合前の初期の列（catalog-v1.json の initial）を組織の列カタログの版1に入れ、採用の監査を残す。
// 統合前に列を採用した組織を、統合後のコードで作るため（試験の旧い組織と、統合後の seedGrainDemo の DEMO-SALES）。mutate で入れる前の列を変えられる
const V1_INSERT = `INSERT INTO sales_sheet_column_versions(org_id,column_key,version_no,label,legacy_position,group_key,value_type,aggregation,numerator_key,denominator_key,
  ratio_scale,digits,source_kind,source_ref,formula_json,description,sort_order,active,reason,created_by) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`;
export async function insertPreIntegrationCatalog(db, orgId, userId, {reason = '統合前の初期の列（fixture）', mutate = (column) => column} = {}) {
  const catalog = JSON.parse(readFileSync(join(FIXTURE_DIR, 'catalog-v1.json'), 'utf8'));
  const initial = catalog.columns.filter((c) => c.template === 'initial').map((c) => mutate({...c}));
  await db.batch([
    ...initial.map((c) => ({sql: V1_INSERT, params: [orgId, c.column_key, c.label, c.legacy_position, c.group_key, c.value_type, c.aggregation, c.numerator_key, c.denominator_key,
      c.ratio_scale, c.digits, c.source_kind, c.source_ref, c.formula_json, c.description, c.sort_order, reason, userId]})),
    {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
      params: [orgId, userId, 'adopt', 'sales_sheet_column', String(orgId), JSON.stringify({template: catalog.templates.initial, columns: initial.length, reason})]},
  ]);
  return initial.length;
}

// 架空の組織のコード → ID
function masterIds(db, orgId) {
  const memo = new Map();
  const lookup = async (table, column, value) => {
    const key = `${table}|${value}`;
    if (!memo.has(key)) {
      const row = await db.get(`SELECT id FROM ${table} WHERE org_id=? AND ${column}=?`, [orgId, value]);
      if (!row) throw new Error(`${table} に ${value} がありません`);
      memo.set(key, Number(row.id));
    }
    return memo.get(key);
  };
  return {work: (code) => lookup('works', 'code', code), partner: (code) => lookup('partners', 'code', code), product: (sku) => lookup('products', 'sku', sku)};
}
const GRAIN_WORK = 'DEMO-W02';
export async function saleOf(db, orgId, reportKey, row = 0) {
  const sales = await db.all(`SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=? AND r.report_key=? AND r.status='active' ORDER BY s.source_row`, [orgId, reportKey]);
  if (!sales[row]) throw new Error(`${reportKey} の ${row + 1} 行目の売上がありません`);
  return Number(sales[row].id);
}
async function classifyReport(db, api, orgId, reportKey, {code, settlement, reason = '流通別の詳細つきの報告を分類（架空データ）'}) {
  const sales = await db.all(`SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=? AND r.report_key=? AND r.status='active' ORDER BY s.source_row`, [orgId, reportKey]);
  for (const sale of sales) {
    const {n} = await db.get('SELECT COALESCE(MAX(version_no),0) AS n FROM sale_distribution_versions WHERE org_id=? AND sale_id=?', [orgId, sale.id]);
    await api.post('/report-center/classifications', {saleId: sale.id, distributionCode: code, baseVersion: Number(n), territory: '日本', serviceName: null, settlementMethod: settlement, reason});
  }
}

// 流通別の詳細つきの報告（CSV の取込）。値は DEMO-W02 の 2026-07・2026-08。単価・件数・視聴・観測値・料率・券種の列と、それぞれの比率の列に値が出るようにする。
// 当社単価は 計上額÷件数 とわざと違う値にする（行の値＝報告の単価、集計の比率＝計上額の合計÷件数の合計。2つの取り違えが落ちるように）
const BASE_HEADERS = Object.freeze(['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'accounting_month', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax']);
const JULY = {from: '2026-07-01', to: '2026-07-31', month: '2026-07'}, AUGUST = {from: '2026-08-01', to: '2026-08-31', month: '2026-08'};
export const CHANNEL_DETAIL_REPORTS = Object.freeze([
  {kind: 'theatrical', reportKey: 'GRAIN-W02-THR-2026-07', partner: 'DEMO-INV-HAI', sku: 'DEMO-W02-THR', code: 'H001', settlement: 'royalty', period: JULY,
    headers: ['theatrical_model', 'ticket_type_code', 'purchase_channel', 'admissions_count', 'gross_box_office_ex_tax', 'reported_actual_ex_tax', 'reported_recognized_ex_tax',
      'calculated_actual_ex_tax', 'attr_theatre_name', 'attr_ticket_category', 'attr_ticket_unit_inc_tax', 'attr_theatre_unit_inc_tax', 'attr_ticket_audience', 'attr_ticket_campaign',
      'attr_ticket_raw_label', 'attr_rs_partner_rate'],
    rows: [{desc: '劇場 一般 2026-07（架空）', qty: '', ex: 972000, tax: 97200, extra: ['theatrical_rs', '一般', '窓口', 1200, 2160000, 2160000, 972000, 2160000,
      '架空シネマ新宿（架空）', '一般', '1980', '1980', '一般の大人（架空）', 'いいえ', '一般 1980円（架空）', '45']},
    {desc: '劇場 シニア 2026-07（架空）', qty: '', ex: 175500, tax: 17550, extra: ['theatrical_rs', 'シニア', 'オンライン', 300, 390000, '', '', '',
      '架空シネマ新宿（架空）', 'シニア', '1300', '1300', 'シニア（架空）', 'はい', 'シニア 1300円（架空）', '']}]},
  {kind: 'package', reportKey: 'GRAIN-W02-RNT-2026-07', partner: 'DEMO-RNT-A', sku: 'DEMO-W02-RNT', code: 'R004', settlement: 'royalty', period: JULY,
    headers: ['package_model', 'turns_count', 'average_rental_price_ex_tax', 'holder_unit_price_ex_tax', 'delivered_count', 'active_count', 'inventory_count', 'observation_unit',
      'observation_scope', 'observation_basis', 'inventory_as_of', 'reported_recognized_ex_tax', 'attr_rental_turnover', 'attr_rss_declared', 'attr_rss_partner_rate',
      'attr_overdue_count', 'attr_overdue_amount', 'attr_overdue_share'],
    rows: [{desc: 'レンタル 2026-07（架空）', qty: 150, ex: 37500, tax: 3750, extra: ['rental', 150, 400, 250, 500, 3, 60, '本', '全店', '月末', '2026-07-31', 37500,
      '2.5', '60000', '62.5', '4', '1200', '600']},
    {desc: 'レンタル 稼動店舗 2026-07（架空）', qty: 40, ex: 10000, tax: 1000, extra: ['rental', 40, 400, 250, '', 25, '', '店', '全店', '月末', '', '',
      '1.6', '', '', '', '', '']}]},
  {kind: 'digital', reportKey: 'GRAIN-W02-TVOD-2026-07', partner: 'DEMO-PF-B', sku: 'DEMO-W02-DIG', code: 'D004', settlement: 'royalty', period: JULY,
    headers: ['digital_model', 'service_code', 'sales_count', 'unit_price_ex_tax', 'holder_unit_price_ex_tax', 'reported_actual_ex_tax', 'reported_recognized_ex_tax',
      'calculated_actual_ex_tax', 'attr_rs_partner_rate'],
    rows: [{desc: '都度課金 2026-07（架空）', qty: 300, ex: 90000, tax: 9000, extra: ['tvod', 'DEMO-SVC-B', 300, 500, 280, 150000, 90000, 150000, '60']}]},
  {kind: 'digital', reportKey: 'GRAIN-W02-SVOD-2026-07', partner: 'DEMO-PF-A', sku: 'DEMO-W02-DIG', code: 'D005', settlement: 'royalty', period: JULY,
    headers: ['digital_model', 'service_code', 'view_count', 'view_seconds', 'holder_unit_price_ex_tax', 'reported_actual_ex_tax', 'attr_unique_viewers', 'attr_vod_partner_rate'],
    rows: [{desc: '定額制 2026-07（架空）', qty: '', ex: 50000, tax: 5000, extra: ['svod', 'DEMO-SVC-A', 4000, 1440000, '5', 125000, '1500', '40']}]},
  {kind: 'digital', reportKey: 'GRAIN-W02-AVOD-2026-08', partner: 'DEMO-PF-C', sku: 'DEMO-W02-DIG', code: 'D006', settlement: 'royalty', period: AUGUST,
    headers: ['digital_model', 'service_code', 'view_count', 'view_seconds', 'holder_unit_price_ex_tax', 'reported_actual_ex_tax', 'calculated_actual_ex_tax'],
    rows: [{desc: '広告型 2026-08（架空）', qty: '', ex: 24000, tax: 2400, extra: ['avod', 'DEMO-SVC-C', 8000, 2400000, '3', 80000, 80000]}]},
  {kind: 'digital', reportKey: 'GRAIN-W02-FLAT-2026-08', partner: 'DEMO-PF-A', sku: 'DEMO-W02-DIG', code: 'D002', settlement: 'FLAT', period: AUGUST,
    headers: ['digital_model', 'service_code', 'contract_amount_ex_tax', 'contract_period_from', 'contract_period_to', 'reported_actual_ex_tax', 'attr_flat_partner_rate'],
    rows: [{desc: '配信の定額 2026-08（架空）', qty: 1, ex: 300000, tax: 30000, extra: ['flat', 'DEMO-SVC-A', 500000, '2026-08-01', '2027-07-31', 500000, '60']}]},
  {kind: 'digital', reportKey: 'GRAIN-W02-MG-2026-08', partner: 'DEMO-PF-B', sku: 'DEMO-W02-DIG', code: 'D001', settlement: 'MG', period: AUGUST,
    headers: ['digital_model', 'service_code', 'reported_actual_ex_tax', 'attr_mg_partner_rate'],
    rows: [{desc: '配信の最低保証 2026-08（架空）', qty: 1, ex: 200000, tax: 20000, extra: ['mg', 'DEMO-SVC-B', 250000, '80']}]},
  // 流通分類を直して版2になる売上（はじめに都度課金と誤って分類し、購入型に直す。G-4）
  {kind: 'digital', reportKey: 'GRAIN-W02-EST-2026-08', partner: 'DEMO-PF-B', sku: 'DEMO-W02-DIG', code: 'D004', settlement: 'royalty', period: AUGUST,
    reclassify: {code: 'D003', settlement: 'royalty', reason: '販売種別の誤り（都度課金ではなく購入型）を直す（架空データ）'},
    headers: ['digital_model', 'service_code', 'sales_count', 'unit_price_ex_tax', 'holder_unit_price_ex_tax', 'reported_actual_ex_tax'],
    rows: [{desc: '購入型 2026-08（架空）', qty: 120, ex: 36000, tax: 3600, extra: ['est', 'DEMO-SVC-B', 120, 1000, 300, 120000]}]},
]);
// 訂正した報告（訂正前2行→訂正後3行。訂正前の行はシートに出ない）と取消の報告（1行。シートに出ない）。G-1・G-4・G-6
export const REVISION_REPORTS = Object.freeze({
  corrected: {kind: 'package', reportKey: 'GRAIN-W02-SEL-2026-08', partner: 'DEMO-SEL-A', sku: 'DEMO-W02-SEL', code: 'S001', settlement: 'other', period: AUGUST, headers: [],
    before: [{desc: 'セル 委託 2026-08（架空）', qty: 100, ex: 150000, tax: 15000, extra: []}, {desc: 'セル 委託 追加 2026-08（架空）', qty: 60, ex: 90000, tax: 9000, extra: []}],
    rows: [{desc: 'セル 委託 2026-08（架空）', qty: 100, ex: 150000, tax: 15000, extra: []}, {desc: 'セル 委託 追加 2026-08（架空）', qty: 64, ex: 96000, tax: 9600, extra: []},
      {desc: 'セル 委託 店舗追加 2026-08（架空）', qty: 16, ex: 24000, tax: 2400, extra: []}]},
  voided: {kind: 'package', reportKey: 'GRAIN-W02-SEL-VOID-2026-08', partner: 'DEMO-SEL-A', sku: 'DEMO-W02-SEL', period: AUGUST, headers: [],
    rows: [{desc: 'セル 二重に届いた報告 2026-08（架空）', qty: 10, ex: 15000, tax: 1500, extra: []}]},
});
// 手入力の拡張属性（外す列の値。G-2 で保存先から読み出す）
export const MANUAL_ATTRIBUTES = Object.freeze([
  {reportKey: 'GRAIN-W02-MG-2026-08', row: 0, values: {advance_guarantee_month: '50000', maker_paid_total: '120000'}, reason: '最低保証の前払いの記録（架空データ）'},
  {reportKey: 'GRAIN-W02-SEL-2026-08', row: 1, values: {update_reason: '数量の訂正（架空）'}, reason: '訂正の理由の記録（架空データ）'},
]);
const csvOf = async (ids, report, rows, extraHeaders = [], extraCells = () => []) => {
  const partnerId = await ids.partner(report.partner), productId = await ids.product(report.sku);
  const p = report.period;
  return toCsv([...BASE_HEADERS, ...report.headers, ...extraHeaders],
    rows.map((r) => [report.reportKey, partnerId, productId, p.from, p.to, p.month, r.desc, r.qty, r.ex, r.tax, r.ex + r.tax, ...r.extra, ...extraCells(r)]));
};
async function importCsv(api, ids, kind, text) {
  const preview = await api.post('/imports/preview', {kind, workId: await ids.work(GRAIN_WORK), text});
  await api.post('/imports/commit', {token: preview.token});
}
async function importReport(db, api, orgId, ids, report) {
  await importCsv(api, ids, report.kind, await csvOf(ids, report, report.rows));
  await classifyReport(db, api, orgId, report.reportKey, report);
  if (report.reclassify) await classifyReport(db, api, orgId, report.reportKey, report.reclassify);
}
async function seedRevisions(db, api, orgId, ids) {
  const {corrected, voided} = REVISION_REPORTS;
  await importCsv(api, ids, corrected.kind, await csvOf(ids, corrected, corrected.before));
  const before = await db.get("SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND status='active'", [orgId, corrected.reportKey]);
  await importCsv(api, ids, corrected.kind, await csvOf(ids, corrected, corrected.rows, ['supersedes_id'], () => [before.id]));
  await classifyReport(db, api, orgId, corrected.reportKey, {code: corrected.code, settlement: corrected.settlement, reason: '訂正後の報告を分類（架空データ）'});
  await importCsv(api, ids, voided.kind, await csvOf(ids, voided, voided.rows));
  await db.run("UPDATE report_imports SET status='void' WHERE org_id=? AND report_key=? AND status='active'", [orgId, voided.reportKey]);
}

// 原本の参照の3つの経路（G-2 #75・G-3）。どれも DEMO-W02 の報告。
//   mapping  列対応で取り込んだ CSV（mapping_import_provenance。原本のファイル名は無い）
//   workflow 旧方式の原本の選択（workflow_raw_artifacts・workflow_report_commits）
//   source   原本の分割（sales_source_files・sales_source_partitions・sales_source_commits）
const src = (target, source) => ({target, mode: 'source', source});
const lit = (target, value) => ({target, mode: 'literal', valueType: Number.isInteger(value) ? 'integer' : 'string', value: String(value)});
export const SOURCE_ROUTE_REPORTS = Object.freeze({
  mapping: {reportKey: 'GRAIN-MAP-TVOD-2026-09', kind: 'digital', partner: 'DEMO-PF-B', sku: 'DEMO-W02-DIG', code: 'D004', settlement: 'royalty', profile: '架空配信B 都度課金の月次CSV（架空）',
    headers: ['報告番号', '販売開始', '販売終了', '受領日', '件数', '単価', '当社単価', '税抜', '税額', '税込', '摘要', 'サービス', '実績額'],
    rows: [['GRAIN-MAP-TVOD-2026-09', '2026-08-01', '2026-08-31', '2026-09-05', '40', '500', '300', '12000', '1200', '13200', '都度課金 列対応 1（架空）', 'DEMO-SVC-B', '20000'],
      ['GRAIN-MAP-TVOD-2026-09', '2026-08-01', '2026-08-31', '2026-09-05', '25', '500', '300', '7500', '750', '8250', '都度課金 列対応 2（架空）', 'DEMO-SVC-B', '12500']],
    mappings: (partnerId, productId) => [src('report_key', '報告番号'), src('period_from', '販売開始'), src('period_to', '販売終了'), src('report_received_on', '受領日'),
      src('quantity', '件数'), src('sales_count', '件数'), src('unit_price_ex_tax', '単価'), src('holder_unit_price_ex_tax', '当社単価'), src('amount_ex_tax', '税抜'),
      src('tax_amount', '税額'), src('amount_inc_tax', '税込'), src('description', '摘要'), src('service_code', 'サービス'), src('reported_actual_ex_tax', '実績額'),
      lit('partner_id', partnerId), lit('product_id', productId), lit('digital_model', 'tvod'), lit('recognition_basis_id', 2), lit('basis_reason', '配信事業者の月次報告を受領した月で計上（架空）')]},
  workflow: {reportKey: 'GRAIN-WF-AVOD-2026-09', kind: 'digital', partner: 'DEMO-PF-C', sku: 'DEMO-W02-DIG', code: 'D006', settlement: 'royalty', profile: '架空配信C 広告型の原本（架空）',
    fileName: 'GRAIN-WF-AVOD-2026-09.csv', title: '架空配信C 広告型 月次報告（架空）',
    headers: ['報告番号', '対象開始', '対象終了', '許諾開始日', '視聴回数', '視聴秒', '当社単価', '税抜', '税額', '税込', '摘要', 'サービス', '実績額'],
    rows: [['GRAIN-WF-AVOD-2026-09', '2026-09-01', '2026-09-30', '2026-09-01', '6000', '1800000', '3', '18000', '1800', '19800', '広告型 原本 1（架空）', 'DEMO-SVC-C', '60000'],
      ['GRAIN-WF-AVOD-2026-09', '2026-09-01', '2026-09-30', '2026-09-01', '2000', '600000', '3', '6000', '600', '6600', '広告型 原本 2（架空）', 'DEMO-SVC-C', '20000']],
    mappings: (partnerId, productId) => [src('report_key', '報告番号'), src('period_from', '対象開始'), src('period_to', '対象終了'), src('license_start_on', '許諾開始日'),
      src('view_count', '視聴回数'), src('view_seconds', '視聴秒'), src('holder_unit_price_ex_tax', '当社単価'), src('amount_ex_tax', '税抜'), src('tax_amount', '税額'),
      src('amount_inc_tax', '税込'), src('description', '摘要'), src('service_code', 'サービス'), src('reported_actual_ex_tax', '実績額'),
      lit('partner_id', partnerId), lit('product_id', productId), lit('digital_model', 'avod'), lit('recognition_basis_id', 4), lit('basis_reason', '許諾の利用開始月で計上（架空）')]},
  source: {reportKey: 'GRAIN-SRC-TV-2026-10', kind: 'broadcast', partner: 'DEMO-TV-C', sku: 'DEMO-W02-TV', code: 'B001', settlement: 'FLAT', profile: '架空CS放送の放送報告（架空）',
    fileName: 'GRAIN-SRC-TV-2026-10.csv', title: '架空CS放送 放送報告（架空）',
    headers: ['報告番号', '対象開始', '対象終了', '放送日', '回数', '税抜', '税額', '税込', '摘要'],
    rows: [['GRAIN-SRC-TV-2026-10', '2026-10-01', '2026-10-31', '2026-10-12', '1', '800000', '80000', '880000', '本編の放送（架空）'],
      ['GRAIN-SRC-TV-2026-10', '2026-10-01', '2026-10-31', '2026-10-12', '1', '400000', '40000', '440000', '特別編の放送（架空）']],
    mappings: (partnerId, productId) => [src('report_key', '報告番号'), src('period_from', '対象開始'), src('period_to', '対象終了'), src('broadcast_on', '放送日'),
      src('quantity', '回数'), src('amount_ex_tax', '税抜'), src('tax_amount', '税額'), src('amount_inc_tax', '税込'), src('description', '摘要'),
      lit('partner_id', partnerId), lit('product_id', productId), lit('recognition_basis_id', 5), lit('basis_reason', '放送した月で計上（架空）')]},
});
const withTitle = (route) => [[route.title, ...route.headers.slice(1).map(() => '')], route.headers, ...route.rows];
async function mappingVersionOf(api, ids, route) {
  const partnerId = await ids.partner(route.partner), productId = await ids.product(route.sku);
  const profile = await api.post('/mapping-profiles', {partnerId, kind: route.kind, name: route.profile});
  const version = await api.post(`/mapping-profiles/${profile.profileId}/versions`, {ignoredColumns: [], mappings: route.mappings(partnerId, productId)});
  return version.mappingVersionId;
}
async function seedSourceRoutes(db, api, orgId, ids) {
  const workId = await ids.work(GRAIN_WORK);
  const {mapping, workflow, source} = SOURCE_ROUTE_REPORTS;
  {
    const mappingVersionId = await mappingVersionOf(api, ids, mapping);
    const preview = await api.post('/mapped-imports/preview', {workId, mappingVersionId, text: toCsv(mapping.headers, mapping.rows)});
    await api.post('/imports/commit', {token: preview.token});
  }
  {
    const uploaded = await api.post('/workflow/artifacts/extract', {kind: 'sales_report', workId, name: workflow.fileName, base64: sourceFileBase64(withTitle(workflow))});
    const selection = await api.post(`/workflow/reports/${uploaded.artifactId}/selection`, {sheetName: FIXTURE_SHEET, headerRow: 2});
    const mappingVersionId = await mappingVersionOf(api, ids, workflow);
    const preview = await api.post('/mapped-imports/preview', {workId, mappingVersionId, text: selection.canonicalCsv, workflowSelectionId: selection.selectionId});
    await api.post('/mapped-imports/commit', {token: preview.token});
  }
  {
    const received = await api.post('/sales-import/files', {name: source.fileName, base64: sourceFileBase64(withTitle(source)), binding: {mode: 'single_work', workId}});
    const selection = await api.post(`/sales-import/files/${received.fileId}/selection`, {sheetName: FIXTURE_SHEET, headerRow: 2, excludedRows: []});
    const mappingVersionId = await mappingVersionOf(api, ids, source);
    const planned = await api.post(`/sales-import/files/${received.fileId}/partitions`, {kind: source.kind, mappingVersionId, bindingId: received.bindingId, selectionId: selection.selectionId});
    if (planned.partitions.length !== 1) throw new Error(`原本の分割が1つではありません（${planned.partitions.length}）`);
    const [partition] = planned.partitions;
    const preview = await api.post('/mapped-imports/preview', {workId, mappingVersionId, text: partition.csv, sourcePartitionId: partition.id});
    await api.post('/sales-import/commit', {token: preview.token});
  }
  for (const route of [mapping, workflow, source]) await classifyReport(db, api, orgId, route.reportKey, {...route, reason: '原本から取り込んだ報告を分類（架空データ）'});
}

const nextMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
// 整数倍の値を小数の文字に（浮動小数を通さない）
const scaledText = (value, digits) => {
  const n = BigInt(value), base = 10n ** BigInt(digits), sign = n < 0n ? '-' : '', abs = n < 0n ? -n : n;
  return `${sign}${abs / base}.${String(abs % base).padStart(digits, '0')}`;
};
export const x100Text = (value) => scaledText(value, 2);
export const x10000Text = (value) => scaledText(value, 4);

// ---------- 読む ----------
// 明細（grain=detail）を全ページ読む
export async function sheetDetail(api, columns, extra = {}) {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const body = await api.get(`/sales-sheet?${query({grain: 'detail', columns: columns.join(','), pageSize: PAGE, page, summary: '0', hideEmpty: '0', ...extra})}`);
    rows.push(...body.rows);
    if (page >= body.pages) return {rows, total: body.total};
  }
}
// 集計（grain=aggregate）を全ページ読む
export async function sheetAggregate(api, params) {
  const rows = [];
  let first = null;
  for (let page = 1; ; page += 1) {
    const body = await api.get(`/sales-sheet?${query({grain: 'aggregate', pageSize: PAGE, page, hideEmpty: '0', ...params})}`);
    first ??= body;
    rows.push(...body.rows);
    if (page >= body.pages) return {...first, rows};
  }
}

export const sumOrNull = (values) => {
  const present = values.filter((v) => v !== null && v !== undefined);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
};
export const compareKeys = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? '', y = b[i] ?? '';
    if (x !== y) return String(x) < String(y) ? -1 : 1;
  }
  return 0;
};
// 明細を 作品×商品×流通区分×取引先×月 で束ね、[キー5つ, 件数, 測度5つ] の行にする
export function groupLines(rows, monthColumn) {
  const groups = new Map();
  for (const row of rows) {
    const key = [...SNAPSHOT_KEYS.map((k) => row[k] ?? null), row[monthColumn] ?? null];
    const id = JSON.stringify(key);
    if (!groups.has(id)) groups.set(id, {key, lines: []});
    groups.get(id).lines.push(row);
  }
  return [...groups.values()].sort((a, b) => compareKeys(a.key, b.key))
    .map(({key, lines}) => [...key, lines.length, ...SNAPSHOT_MEASURES.map((m) => sumOrNull(lines.map((line) => line[m])))]);
}
export const SNAPSHOT_COLUMNS = Object.freeze([...SNAPSHOT_KEYS, 'month', 'lines', ...SNAPSHOT_MEASURES]);
const DETAIL_COLUMNS = ['sale_id', 'row_fingerprint', ...SNAPSHOT_KEYS, ...Object.values(MONTH_COLUMNS), ...SNAPSHOT_MEASURES];

// 横並び（集計・月を横に並べる）。pivotKey は横に並べた金額の列、totals は月ごとの合計
export async function pivotOf(api, monthBasis, taxBasis) {
  const amount = taxBasis === 'inc' ? 'amount_inc_tax' : 'amount_ex_tax';
  const body = await sheetAggregate(api, {dims: 'partner', pivot: '1', month: monthBasis, tax: taxBasis, columns: amount});
  return {pivotKey: body.pivotKey, totals: Object.fromEntries(body.months.map((month) => [month, sumOrNull(body.rows.map((row) => row[`m_${month}`]))]))};
}
export const pivotTotals = async (api, monthBasis, taxBasis) => (await pivotOf(api, monthBasis, taxBasis)).totals;
const dimRows = (body, dims, columns) => body.rows.map((row) => [...dims.map((d) => row[`dimkey_${d}`] ?? null), ...dims.map((d) => row[`dim_${d}`] ?? null), row.__count, ...columns.map((c) => row[c] ?? null)])
  .sort((a, b) => compareKeys(a.slice(0, dims.length), b.slice(0, dims.length)));
export async function dimensionTable(api, dims, columns, extra = {}) {
  const body = await sheetAggregate(api, {dims: dims.join(','), columns: columns.join(','), ...extra});
  return {dims, columns, rows: dimRows(body, dims, columns), totals: Object.fromEntries(columns.map((c) => [c, body.totals?.[c] ?? null])), unclassifiedCount: body.unclassifiedCount ?? null, total: body.total};
}

// 保存した形を、その定義のまま開いた結果（件数と合計）
export async function savedViewResults(api) {
  const {views} = await api.get('/sales-sheet/views');
  const out = [];
  for (const view of views.sort((a, b) => a.name.localeCompare(b.name))) {
    const d = view.definition;
    const params = {grain: d.grain, columns: d.columns.join(','), month: d.monthBasis, tax: d.taxBasis, dims: d.dimensions.join(',') || undefined, pivot: d.pivot ? '1' : undefined,
      pageSize: PAGE, hideEmpty: '0', ...d.filters};
    const body = await api.get(`/sales-sheet?${query(params)}`);
    out.push({name: view.name, columns: d.columns, total: body.total, groups: body.groups ?? null, totals: body.totals});
  }
  return out;
}

export async function collectGrainSnapshot(api) {
  const {rows, total} = await sheetDetail(api, DETAIL_COLUMNS);
  const byMonth = Object.fromEntries(Object.entries(MONTH_COLUMNS).map(([basis, column]) => [basis, groupLines(rows, column)]));
  const pivot = {};
  for (const basis of Object.keys(MONTH_COLUMNS)) pivot[basis] = {ex: await pivotTotals(api, basis, 'ex'), inc: await pivotTotals(api, basis, 'inc')};
  const aggregates = {};
  for (const dims of AGGREGATE_DIMS) aggregates[dims.join(',')] = await dimensionTable(api, dims, SNAPSHOT_MEASURES);
  return {
    lineCount: total,
    columns: SNAPSHOT_COLUMNS,
    totals: Object.fromEntries(SNAPSHOT_MEASURES.map((m) => [m, sumOrNull(rows.map((row) => row[m]))])),
    byMonth,
    pivot,
    aggregates,
    ratios: {
      byPartnerDistribution: await dimensionTable(api, ['partner', 'distribution'], RATIO_COLUMNS),
      byCurrency: await dimensionTable(api, ['currency'], ['exchange_rate', 'foreign_amount']),
    },
    byDistribution: await dimensionTable(api, ['distribution'], ['amount_ex_tax']),
    byTicket: await dimensionTable(api, ['ticket'], ['amount_ex_tax']),
    views: await savedViewResults(api),
  };
}

// 旧131エントリの各列の値（MG の4列を除く）。行は売上IDの順、時刻の列は印にする
export const LEGACY_ROW_COLUMNS = Object.freeze(LEGACY_PLAN.map((c) => c.key).filter((key) => !MG_FIXTURE_KEYS.includes(key)));
export const maskVolatile = (key, value) => (VOLATILE_COLUMNS.includes(key) && value !== null && value !== undefined ? VOLATILE_MARK : value ?? null);
export async function collectLegacyRows(api) {
  const {rows} = await sheetDetail(api, LEGACY_ROW_COLUMNS);
  const seen = new Set();
  for (const row of rows) {
    if (!row.row_fingerprint || seen.has(row.row_fingerprint)) throw new Error(`行の照合値が空か重なっています（売上ID ${row.sale_id}）`);
    seen.add(row.row_fingerprint);
  }
  return rows.sort((a, b) => a.sale_id - b.sale_id).map((row) => LEGACY_ROW_COLUMNS.map((key) => maskVolatile(key, row[key])));
}

// 旧の列カタログ（API の列の形を、表の列の形に戻す）
const TEMPLATE_OF = new Map(LEGACY_PLAN.map((c) => [c.key, c.template]));
const catalogRow = (column) => ({
  template: TEMPLATE_OF.get(column.key) ?? 'custom',
  column_key: column.key, label: column.label, legacy_position: column.legacyPosition, group_key: column.group, value_type: column.valueType, aggregation: column.aggregation,
  numerator_key: column.numeratorKey, denominator_key: column.denominatorKey, ratio_scale: column.ratioScale, digits: column.digits, source_kind: column.sourceKind,
  source_ref: column.sourceRef, formula_json: column.formula ? JSON.stringify(column.formula) : null, description: column.description, sort_order: column.sortOrder,
});
export async function collectCatalog(api) {
  const body = await api.get('/sales-sheet/columns');
  const detail = await api.get(`/sales-sheet?${query({grain: 'detail', set: 'basic', pageSize: 10})}`);
  const aggregate = await api.get(`/sales-sheet?${query({grain: 'aggregate', set: 'basic', dims: 'partner', pageSize: 10})}`);
  const context = await api.get('/sales-import/context');
  return {
    columns: body.columns.map(catalogRow).sort((a, b) => a.sort_order - b.sort_order || a.column_key.localeCompare(b.column_key)),
    sets: Object.fromEntries(body.sets.map((set) => [set.key, set.columns])),
    api: {columns: Object.keys(body).sort(), sheetDetail: Object.keys(detail).sort(), sheetAggregate: Object.keys(aggregate).sort(), importContext: Object.keys(context).sort()},
  };
}

// ---------- MG（G-12） ----------
// 既定の架空組織（demo）の作品 WRK-DEMO・商品 SKU-DIGI・取引先 PT-DIGITAL に、版を2つ持つ受取の MG 契約と訂正の行を作る種。
// 版2は月の途中（7月15日）に始まる（その月末までに始まったので7月から版2）。台帳の L4 は L2 の訂正（実充当を 900,000 → 700,000）。
// 売上は月ごとに1件。2025-10 の売上は報告を訂正（supersedes_id）して額を直す
export const MG_VERSIONS_SEED = Object.freeze({
  org: 'demo', adminEmail: 'admin@openingnight.invalid', workCode: 'WRK-DEMO', productSku: 'SKU-DIGI', partnerCode: 'PT-DIGITAL',
  contract: {code: 'MGV-INC-01', title: '架空の配信許諾の最低保証（版2つ・架空）', contractDate: '2024-12-10', contractSourceReference: '架空の許諾契約書（MG の版の試験）'},
  versions: [
    {version: 1, mgAmountYen: 3000000, startsOn: '2025-01-01', endsOn: '2025-12-31', firstCloseOn: '2025-03-31', reason: '当初の条件（架空）', sourceReference: '架空の許諾契約書 第4条'},
    {version: 2, mgAmountYen: 5000000, startsOn: '2025-07-15', endsOn: '2026-06-30', firstCloseOn: '2025-09-30', reason: '延長と保証額の増額（架空）', sourceReference: '架空の変更契約書 第2条'},
  ],
  ledger: [
    {ref: 'MGV-L1', version: 1, periodFrom: '2025-01-01', periodTo: '2025-03-31', accountingMonth: '2025-04', eligible: 800000, applied: 800000, overage: 0, recognized: 0},
    {ref: 'MGV-L2', version: 1, periodFrom: '2025-04-01', periodTo: '2025-06-30', accountingMonth: '2025-07', eligible: 900000, applied: 900000, overage: 0, recognized: 0},
    {ref: 'MGV-L3', version: 2, periodFrom: '2025-07-15', periodTo: '2025-09-30', accountingMonth: '2025-10', eligible: 1200000, applied: 1200000, overage: 0, recognized: 0},
    {ref: 'MGV-L4', version: 1, reverses: 'MGV-L2', periodFrom: '2025-04-01', periodTo: '2025-06-30', accountingMonth: '2025-11', eligible: 700000, applied: 700000, overage: 0, recognized: 0},
  ],
  sales: [
    {reportKey: 'MGV-2025-03', month: '2025-03', amountExTax: 60000},
    {reportKey: 'MGV-2025-06', month: '2025-06', amountExTax: 70000},
    {reportKey: 'MGV-2025-07', month: '2025-07', amountExTax: 80000},
    {reportKey: 'MGV-2025-10', month: '2025-10', amountExTax: 100000, correctedAmountExTax: 120000},
    {reportKey: 'MGV-2025-11', month: '2025-11', amountExTax: 90000},
    {reportKey: 'MGV-2026-03', month: '2026-03', amountExTax: 50000},
  ],
});
const monthEnd = (ym) => `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
const taxOf = (yen) => yen / 10; // 架空の額はどれも10の倍数（10%・端数なし）

// 月ごとの期待値（計画の G-12・FR-SETL-MGL-050・MGL-026 から。アプリの関数は使わない）:
//   版 = その月の末日までに始まった版のうち、版の番号が最大のもの（始まっていなければ空）
//   残高 = max(0, 保証額 − その月までの実充当の合計)。訂正された行（訂正の行が指す行）は数えず、訂正の行はその計上月から数える
export function mgExpectedByMonth(seed = MG_VERSIONS_SEED) {
  const replaced = new Set(seed.ledger.filter((e) => e.reverses).map((e) => e.reverses));
  const months = [...new Set(seed.sales.map((s) => s.month))].sort();
  return months.map((month) => {
    const started = seed.versions.filter((v) => v.startsOn <= monthEnd(month));
    if (!started.length) return {month, version: null, mg_guarantee_ex_tax: null, mg_start: null, mg_end: null, advance_guarantee_balance: null};
    const selected = started.reduce((a, b) => (b.version > a.version ? b : a));
    const applied = seed.ledger.filter((e) => !replaced.has(e.ref) && e.accountingMonth <= month).reduce((n, e) => n + e.applied, 0);
    return {month, version: selected.version, mg_guarantee_ex_tax: selected.mgAmountYen, mg_start: selected.startsOn, mg_end: selected.endsOn,
      advance_guarantee_balance: Math.max(0, selected.mgAmountYen - applied)};
  });
}

// 種を API で入れる。api は seed.adminEmail のメンバー、db は同じ DB（ID を引くだけ）
export async function seedMgVersions(db, api, seed = MG_VERSIONS_SEED) {
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [seed.org]);
  const id = async (sql, value) => {
    const row = await db.get(sql, [org.id, value]);
    if (!row) throw new Error(`${value} がありません`);
    return Number(row.id);
  };
  const workId = await id('SELECT id FROM works WHERE org_id=? AND code=?', seed.workCode);
  const productId = await id('SELECT id FROM products WHERE org_id=? AND sku=?', seed.productSku);
  const partnerId = await id('SELECT id FROM partners WHERE org_id=? AND code=?', seed.partnerCode);
  const phase = (v) => [{startsOn: v.startsOn, endsOn: v.endsOn, intervalMonths: 3, firstCloseOn: v.firstCloseOn, reportOffsetMonths: 1, reportDay: 28, payOffsetMonths: 2, payDay: 28}];
  const term = (v) => ({mgAmountYen: v.mgAmountYen, startsOn: v.startsOn, endsOn: v.endsOn, mode: 'single', reason: v.reason, sourceReference: v.sourceReference,
    products: [{productId, evaluationYen: v.mgAmountYen}], phases: phase(v)});
  const [v1, v2] = seed.versions;
  const created = await api.post('/mg/contracts', {direction: 'incoming', code: seed.contract.code, title: seed.contract.title, partnerId, contractDate: seed.contract.contractDate,
    contractSourceReference: seed.contract.contractSourceReference, ...term(v1)});
  const second = await api.post(`/mg/contracts/incoming/${created.contractId}/versions`, {baseVersion: 1, ...term(v2)});
  const versionIds = {1: created.versionId, 2: second.versionId};
  const entries = {};
  for (const e of seed.ledger) {
    const out = await api.post('/mg/ledger', {termVersionId: versionIds[e.version], productId, periodFrom: e.periodFrom, periodTo: e.periodTo, accountingMonth: e.accountingMonth,
      sourceReference: e.ref, reportedEligibleYen: e.eligible, appliedRecoupYen: e.applied, reportedOverageYen: e.overage, recognizedYen: e.recognized, status: 'reviewed', acknowledgement: true,
      confirmationReason: e.reverses ? `${e.reverses} の実充当の訂正（架空）` : '架空データの手入力値', ...(e.reverses ? {reversesEntryId: entries[e.reverses]} : {})});
    entries[e.ref] = out.entryId;
  }
  const sale = (s, amount, supersedesId = '') => api.post('/sales', {workId, report_key: s.reportKey, kind: 'digital', description: `MG の版の試験 ${s.month}（架空）`, quantity: '', partner_id: partnerId,
    product_id: productId, period_from: `${s.month}-01`, period_to: monthEnd(s.month), accounting_month: s.month, amount_ex_tax: amount, tax_amount: taxOf(amount), amount_inc_tax: amount + taxOf(amount),
    supersedes_id: supersedesId});
  for (const s of seed.sales) {
    await sale(s, s.amountExTax);
    if (s.correctedAmountExTax !== undefined) {
      const report = await db.get("SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND status='active'", [org.id, s.reportKey]);
      await sale(s, s.correctedAmountExTax, report.id);
    }
  }
  return {orgId: org.id, workId, productId, partnerId, contractId: created.contractId, versionIds, entries};
}
export const MG_SHEET_COLUMNS = Object.freeze(['sale_id', 'booking_month', 'amount_ex_tax', 'mg_group', ...MG_FIXTURE_KEYS]);

// ---------- まとめて作る ----------
async function buildOnce(log) {
  const db = new LocalDatabase(':memory:');
  try {
    const {api} = await seedGrainDemo(db, {log});
    const snapshot = await collectGrainSnapshot(api);
    const legacyRows = await collectLegacyRows(api);
    const catalog = await collectCatalog(api);
    // MG: 既定の組織で列を採用し、種を入れて、いまのシートの値（統合前）を月ごとに控える（試験は期待値と比べる。これは参考）
    const app = createApp({db, mode: 'local'});
    const admin = await apiClient(app, MG_VERSIONS_SEED.adminEmail);
    await admin.post('/sales-sheet/columns/adopt', {reason: 'MG の版の fixture を作る（架空）'});
    await seedMgVersions(db, admin);
    const mgRows = (await sheetDetail(admin, MG_SHEET_COLUMNS)).rows.sort((a, b) => a.booking_month.localeCompare(b.booking_month) || a.sale_id - b.sale_id);
    return {snapshot, legacyRows, catalog, mgCurrent: mgRows.map((row) => ({month: row.booking_month, amount_ex_tax: row.amount_ex_tax, ...Object.fromEntries(MG_FIXTURE_KEYS.map((k) => [k, row[k]]))}))};
  } finally {
    db.raw?.close?.();
  }
}

const SOURCE = 'scripts/sales-sheet-grain-fixtures.mjs で、統合前の main のコードと架空データ（seed-all-demo の節と、この道具の追加。組織 DEMO-SALES）から作った。手で直さない';
export function fixtureFiles(built) {
  return {
    'grain-snapshot.json': {format: 'sales-sheet-grain-snapshot', source: SOURCE, org: SALES_DEMO.orgCode, seedSteps: GRAIN_SEED_STEPS, ...built.snapshot},
    'legacy-reproduction.json': {
      format: 'sales-sheet-legacy-reproduction', source: SOURCE, org: SALES_DEMO.orgCode, keyColumn: 'row_fingerprint', volatile: {columns: VOLATILE_COLUMNS, mark: VOLATILE_MARK},
      entries: LEGACY_PLAN.map((c) => ({key: c.key, position: c.position, treatment: c.treatment, ...(c.destination ? {destination: c.destination} : {}), ...(c.storage ? {storage: c.storage} : {}),
        ...(c.mgFixture ? {separated: 'mg-versions.json'} : {})})),
      rowColumns: LEGACY_ROW_COLUMNS, rows: built.legacyRows,
    },
    'catalog-v1.json': {format: 'sales-sheet-catalog-v1', source: SOURCE, templates: {initial: 'sales-sheet-v1', additional: 'sales-sheet-additional-v1'}, ...built.catalog},
    'mg-versions.json': {format: 'sales-sheet-mg-versions', source: 'scripts/sales-sheet-grain-fixtures.mjs の MG_VERSIONS_SEED と mgExpectedByMonth。expected は FR-SETL-MGL-050・MGL-026 の決まりから出した期待値、currentSheet は統合前のシートの値（参考）',
      seed: MG_VERSIONS_SEED, expected: mgExpectedByMonth(), currentSheet: built.mgCurrent},
  };
}

// 読みやすく、差分が小さくなる JSON（数・文字だけの配列は1行、配列の配列は1行に1つ）
export function fixtureJson(value, indent = '') {
  const next = `${indent}  `;
  const flat = (v) => v === null || typeof v !== 'object';
  if (flat(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(flat)) return `[${value.map((v) => JSON.stringify(v)).join(',')}]`;
    return `[\n${value.map((v) => `${next}${fixtureJson(v, next)}`).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${fixtureJson(v, next)}`).join(',\n')}\n${indent}}`;
}

function parseArgs(argv) {
  const options = {out: FIXTURE_DIR, twice: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--twice') options.twice = true;
    else if (arg === '--out') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error('--out の値（フォルダ）を指定してください');
      options.out = resolve(next);
      i += 1;
    } else throw new Error(`知らない指定です: ${arg}`);
  }
  return options;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const problem = preIntegrationProblem();
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  const log = () => {};
  const render = (built) => Object.fromEntries(Object.entries(fixtureFiles(built)).map(([name, value]) => [name, `${fixtureJson(value)}\n`]));
  const first = render(await buildOnce(log));
  if (options.twice) {
    const second = render(await buildOnce(log));
    const different = Object.keys(first).filter((name) => first[name] !== second[name]);
    if (different.length) {
      console.error(`2回作った fixture が違います: ${different.join('・')}（書き出していません）`);
      process.exit(1);
    }
    console.log(`2回作って同じでした: ${Object.keys(first).join('・')}`);
  }
  mkdirSync(options.out, {recursive: true});
  for (const [name, text] of Object.entries(first)) {
    writeFileSync(join(options.out, name), text);
    console.log(`${name}: ${Buffer.byteLength(text).toLocaleString('ja-JP')} バイト`);
  }
}
