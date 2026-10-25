#!/usr/bin/env node
// 売上集計シートの列を、粒度を守って唯一の辞書に統合する（会社ルートの plans/2026-10-09-sheet-columns-by-grain.md）ための道具。
// いまあるのは --check（香盤表 #1。事前の確かめ）だけ。--dry-run・--apply・--views・--copy-attributes・--mappings は香盤表 #7 で足す。
//
//   node scripts/sales-sheet-columns-v2.mjs --check --db <架空データの使い捨ての SQLite のパス>
//
// --check は SQLite のファイルを読み取り専用で開き、書き込まない。組織ごとに数えて、JSON（件数と例の売上ID）を標準出力に出す。
//   rateKeys          G-7: 1売上に料率キー（定額・MG・RS・RSS・VOD の5キー）の値が2つ以上ある売上
//   rateBlocks        G-7: 料率の値が入ったキーと、売上の流通のまとまり（column-registry.mjs の salesBlock）が食い違う売上
//   unrepresentable   裁定1・2 (a): 新しい表の型（×100・bps・整数・円）で表せない既存の値。×100 と bps は小数2桁まで、整数と円は整数だけ
//   attributeOrphans  辞書（初期の列と追加の列）に無いキーの拡張属性の値（管理者が足した列）と、計画で外す拡張属性のキーの値
//   royaltyMismatch   裁定3: ロイヤリティ計上の額が売上と食い違う版。4項目（税抜・税額・税込が sale_lines と違う、外貨のロイヤリティ計上額が外貨の計上額と違う）
//   plan              この道具が持つ計画の対応表の写し（旧131エントリの扱い）が、コードの辞書と食い違わないか（旧エントリがどれも辞書にある）
// 拡張属性・外貨・ロイヤリティ計上は、どれも最新の版で数える（シートに出ている値。値を消した版は値なし）。報告の状態は問わない
// （訂正前の報告の売上の値も、新しい表へ写すときは対象になるため）。外貨のロイヤリティ計上額が空の版は食い違いに数えない
// （空は「外貨の計上額と同じ」の意味で、シートの列は空のまま出る）。
// 本番・staging には繋がない。data/integrated.sqlite は開かない（架空データの使い捨ての DB だけを受ける）。パスがほかでも、組織のコードが
// 架空の組織の形（demo・other・DEMO-…）でないか、メールが .invalid でない利用者がいる DB は、数える前に止める（fictionalDatabaseProblems。
// 本物の DB の複製・別名・リンクを開いても、数えた値を出さない）。
// 計画の対応表の写し（LEGACY_PLAN）と、消す列を残す列から作り直す純関数（legacyBlockOf・processingIdOf）は、
// 粒度の試験（test/sales-sheet-grain.test.mjs）と fixture を作る道具（scripts/sales-sheet-grain-fixtures.mjs）も使う。
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as registry from '../src/sales-sheet/column-registry.mjs';
import {scaledInteger} from '../src/sales-sheet/sales-sheet-input.mjs';
import {
  royaltyAmountMismatches as royaltyAmountMismatchesOf, attributeOrphans as attributeOrphansOf, RATE_BLOCKS, rateKeyConflicts, rateBlockMismatches, rateSaleBlocksOf,
} from '../src/sales-sheet/sales-sheet-model.mjs';
import {loadRateSaleBlockRows} from '../src/sales-sheet/sales-sheet-store.mjs';

export const CHECK_FORMAT = 'sales-sheet-columns-v2-check';
const EXAMPLES = 5;

// ---------- 計画の対応表の写し（旧131エントリ） ----------
// 扱い: 残＝キーも取り方も残す／派＝式で出す／消＝辞書から外す（removed）／裁1・裁2＝裁定1・2 (a) で新しいキーへ（PR C の移行のあと。
// destination が行き先）／裁3＝食い違いが0件の組織だけ止める。mgFixture は粒度の試験で全行一致から外し、G-12 の fixture で比べる列。
const KEEP = '残', DERIVED = '派', REMOVE = '消', RULING1 = '裁1', RULING2 = '裁2', RULING3 = '裁3';
export const TREATMENTS = Object.freeze({KEEP, DERIVED, REMOVE, RULING1, RULING2, RULING3});
const keep = (key, extra = {}) => ({key, treatment: KEEP, ...extra});
const PLAN_BY_KEY = Object.freeze({
  flat_partner_rate: {treatment: RULING1, destination: 'reported_rate_pct'},
  mg_partner_rate: {treatment: RULING1, destination: 'reported_rate_pct'},
  rs_partner_rate: {treatment: RULING1, destination: 'reported_rate_pct'},
  rss_partner_rate: {treatment: RULING1, destination: 'reported_rate_pct'},
  vod_partner_rate: {treatment: RULING1, destination: 'reported_rate_pct'},
  h_flat_implied_deal: {treatment: RULING1, destination: 'h_rate_implied_gross'},
  h_mg_implied_gross: {treatment: RULING1, destination: 'h_rate_implied_gross'},
  h_rs_implied_gross: {treatment: RULING1, destination: 'h_rate_implied_gross'},
  h_rss_implied_declared: {treatment: RULING1, destination: 'h_rate_implied_gross'},
  h_vod_implied_gross: {treatment: RULING1, destination: 'h_rate_implied_gross'},
  rental_turnover: {treatment: RULING2, destination: 'reported_rental_turnover'},
  overdue_count: {treatment: RULING2, destination: 'reported_overdue_count'},
  overdue_amount: {treatment: RULING2, destination: 'reported_overdue_amount'},
  overdue_share: {treatment: RULING2, destination: 'reported_overdue_share'},
  rss_declared: {treatment: RULING2, destination: 'reported_rss_declared'},
  unique_viewers: {treatment: RULING2, destination: 'reported_unique_viewers'},
  theatre_name: {treatment: RULING2, destination: 'reported_theatre_name'},
  ticket_category: {treatment: RULING2, destination: 'reported_ticket_category'},
  ticket_unit_inc_tax: {treatment: RULING2, destination: 'reported_ticket_unit_inc_tax'},
  ticket_raw_label: {treatment: RULING2, destination: 'reported_ticket_raw_label'},
  foreign_royalty_amount: {treatment: RULING3}, royalty_amount_ex_tax: {treatment: RULING3}, royalty_amount_inc_tax: {treatment: RULING3}, royalty_tax_amount: {treatment: RULING3},
  view_hours: {treatment: DERIVED}, tax_rate: {treatment: DERIVED}, theatre_unit_ex_tax: {treatment: DERIVED},
  flat_holder_ex_tax: {treatment: REMOVE, storage: 'legacyBlockOf'}, mg_holder_ex_tax: {treatment: REMOVE, storage: 'legacyBlockOf'},
  rss_holder_ex_tax: {treatment: REMOVE, storage: 'legacyBlockOf'},
  theatre_unit_inc_tax: {treatment: REMOVE, storage: 'sale_attribute_values'}, ticket_audience: {treatment: REMOVE, storage: 'sale_attribute_values'},
  ticket_campaign: {treatment: REMOVE, storage: 'sale_attribute_values'}, advance_guarantee_month: {treatment: REMOVE, storage: 'sale_attribute_values'},
  maker_paid_total: {treatment: REMOVE, storage: 'sale_attribute_values'}, update_reason: {treatment: REMOVE, storage: 'sale_attribute_values'},
  processing_id: {treatment: REMOVE, storage: 'processingIdOf'}, h_theatre_inc_amount: {treatment: REMOVE, storage: 'sale_attribute_values×theatrical_sale_details'},
  report_status: {treatment: REMOVE, storage: 'report_imports.status'},
  mg_guarantee_ex_tax: {treatment: KEEP, mgFixture: true}, mg_start: {treatment: KEEP, mgFixture: true}, mg_end: {treatment: KEEP, mgFixture: true},
  advance_guarantee_balance: {treatment: KEEP, mgFixture: true},
});
// 旧131エントリ（統合前の初期の列103＝元の並び1〜83・参考10・補助10と、追加の列28）。統合のあとも変わらないよう、ここに固定する
// （コードの INITIAL_SHEET_COLUMNS は #2a で辞書から作るものになり、外した列が抜ける）
const LEGACY_POSITIONED = Object.freeze([
  'sale_id', 'distribution_code', 'sales_date', 'booking_month', 'royalty_month', 'work_code', 'product_code', 'mg_group', 'partner_code', 'flat_deal_ex_tax',
  'flat_partner_rate', 'flat_holder_ex_tax', 'flat_start', 'flat_end', 'mg_guarantee_ex_tax', 'mg_start', 'mg_end', 'mg_partner_rate', 'mg_holder_ex_tax', 'rs_partner_unit_ex_tax',
  'delivered_units', 'active_stores', 'active_units_per_store', 'rental_turnover', 'rs_partner_rate', 'rs_holder_unit_ex_tax', 'rs_count', 'rs_holder_ex_tax', 'overdue_count', 'overdue_amount',
  'overdue_share', 'rss_declared', 'rss_partner_rate', 'rss_holder_ex_tax', 'unique_viewers', 'view_seconds', 'view_hours', 'view_count', 'vod_unit_ex_tax', 'vod_partner_sales_ex_tax',
  'vod_partner_rate', 'vod_holder_ex_tax', 'foreign_amount', 'foreign_royalty_amount', 'currency_code', 'exchange_rate', 'amount_ex_tax', 'royalty_amount_ex_tax', 'tax_rate', 'tax_amount',
  'amount_inc_tax', 'royalty_amount_inc_tax', 'line_note', 'invoice_number', 'report_number', 'theatre_name', 'admissions', 'box_office_ex_tax', 'theatre_unit_inc_tax', 'theatre_unit_ex_tax',
  'ticket_category', 'ticket_name', 'ticket_unit_inc_tax', 'ticket_audience', 'ticket_campaign', 'ticket_channel', 'ticket_raw_label', 'invoice_date', 'payment_due', 'paid_on',
  'stock_units', 'advance_guarantee_month', 'maker_paid_total', 'advance_guarantee_balance', 'processing_id', 'processed_at', 'source_file', 'import_id', 'imported_at', 'registration_kind',
  'record_version', 'update_reason', 'row_fingerprint',
]);
const LEGACY_UNPOSITIONED = Object.freeze([
  'ref_work_title', 'ref_partner_name', 'ref_product_name', 'ref_distribution_name', 'ref_transaction_method', 'ref_sales_type', 'ref_report_kind', 'ref_territory', 'ref_service_name',
  'ref_sales_month', 'h_rs_partner_amount', 'h_flat_implied_deal', 'h_mg_implied_gross', 'h_rental_units', 'h_rs_implied_gross', 'h_rss_implied_declared', 'h_vod_implied_gross',
  'h_foreign_yen', 'h_theatre_inc_amount', 'h_ticket_inc_amount',
]);
const LEGACY_ADDITIONAL = Object.freeze([
  'sales_period_to', 'report_period_from', 'report_period_to', 'raw_quantity', 'recognition_basis_id', 'recognition_reason', 'report_received_on', 'recognition_contract_start_on',
  'license_start_on', 'broadcast_on', 'report_status', 'supersedes_report_id', 'source_row_number', 'source_reference_id', 'distribution_version', 'settlement_method', 'channel_model',
  'service_code', 'reported_actual_ex_tax', 'reported_recognized_ex_tax', 'calculated_actual_ex_tax', 'package_turns_count', 'currency_rate_date', 'currency_basis', 'currency_version',
  'royalty_tax_amount', 'royalty_basis_version', 'royalty_basis_origin',
]);
// 旧131エントリの並び（元の並び1〜83 → 参考・補助 → 追加の列）と扱い。PLAN_BY_KEY に無いキーは「残」
export const LEGACY_PLAN = Object.freeze([
  ...LEGACY_POSITIONED.map((key, i) => ({key, position: i + 1, template: 'initial'})),
  ...LEGACY_UNPOSITIONED.map((key) => ({key, position: null, template: 'initial'})),
  ...LEGACY_ADDITIONAL.map((key) => ({key, position: null, template: 'additional'})),
].map((entry) => Object.freeze({...entry, ...keep(entry.key), ...(PLAN_BY_KEY[entry.key] || {})})));
export const PLAN_KEYS = Object.freeze(Object.keys(PLAN_BY_KEY));
export const REMOVED_KEYS = Object.freeze(LEGACY_PLAN.filter((c) => c.treatment === REMOVE).map((c) => c.key));
export const ROYALTY_KEYS = Object.freeze(LEGACY_PLAN.filter((c) => c.treatment === RULING3).map((c) => c.key));
export const MG_FIXTURE_KEYS = Object.freeze(LEGACY_PLAN.filter((c) => c.mgFixture).map((c) => c.key));
// 外す拡張属性のキー（#59・64・65・72・73・82）。取込の列対応は読み飛ばし、値は sale_attribute_values に残る
export const REMOVED_ATTRIBUTE_KEYS = Object.freeze(LEGACY_PLAN.filter((c) => c.treatment === REMOVE && c.storage === 'sale_attribute_values').map((c) => c.key));

// コードの辞書のキー。#2a の唯一の辞書（SHEET_COLUMNS。外した列も removed の印つきで持つ）があればそれ、無ければ統合前の初期の列と追加の列
export const registryKeys = () => (Array.isArray(registry.SHEET_COLUMNS) ? registry.SHEET_COLUMNS.map((c) => c.key)
  : [...registry.INITIAL_SHEET_COLUMNS, ...registry.ADDITIONAL_SHEET_COLUMNS].map((c) => c.column_key));
// 旧131エントリの写しが、コードの辞書と食い違わないか。notInRegistry: 辞書に無い旧エントリ（0件であること）、newInRegistry: 旧エントリに無い辞書のキー、
// unknownPlanKeys: 扱いを書いたのに旧エントリに無いキー（写し間違い）
export function planCoverage(keys = registryKeys()) {
  const legacy = new Set(LEGACY_PLAN.map((c) => c.key));
  const dictionary = new Set(keys);
  return {
    entries: LEGACY_PLAN.length,
    notInRegistry: [...legacy].filter((key) => !dictionary.has(key)),
    newInRegistry: [...dictionary].filter((key) => !legacy.has(key)),
    unknownPlanKeys: PLAN_KEYS.filter((key) => !legacy.has(key)),
    byTreatment: Object.fromEntries(Object.values(TREATMENTS).map((t) => [t, LEGACY_PLAN.filter((c) => c.treatment === t).length])),
  };
}

// ---------- 消す列を、残す列から作り直す（純関数） ----------
// #12・19・34（定額・MG・RSS の当社売上）は amount_ex_tax を流通のまとまりで振り分けた列。まとまりを残す列
// （channel_model・settlement_method・distribution_code・ref_distribution_name・ref_transaction_method・ref_sales_type・ref_report_kind）から決める。
// 流通マスタの流通ID（英大文字1字＋数字3桁）なら 流通名・取引方法・販売種別 で、それ以外（旧区分・未分類）は報告の種類と旧区分で決める
const MASTER_CODE = /^[A-Z]\d{3}$/;
const LEGACY_CODE_BLOCK = Object.freeze({
  theatrical: 'rs', package_rental: 'rs', package_sell: 'rs', est: 'rs', tvod: 'rs', svod: 'vod', avod: 'vod',
  broadcast_free: 'flat', broadcast_bs: 'flat', broadcast_cs: 'flat', broadcast_cable: 'flat',
});
export function legacyBlockOf(v) {
  const model = v.channel_model ?? null;
  if (model === 'flat') return 'flat';
  if (model === 'mg') return 'mg';
  if (v.settlement_method === 'FLAT') return 'flat';
  if (v.settlement_method === 'MG') return 'mg';
  if (MASTER_CODE.test(String(v.distribution_code ?? '')) && v.ref_distribution_name) {
    const name = v.ref_distribution_name, method = v.ref_transaction_method, type = v.ref_sales_type;
    if (method === 'FLAT') return 'flat';
    if (method === 'MG') return 'mg';
    if (name === 'レンタル_RSS') return 'rss';
    if (['SVOD', 'AVOD'].includes(type) || ['海外', '業務用VOD', '放送'].includes(name)) return 'vod';
    if (['配給', '配給_物販', 'セル', 'レンタル', 'グッズ'].includes(name) || ['EST', 'TVOD'].includes(type)) return 'rs';
    return null;
  }
  if (model === 'est' || model === 'tvod') return 'rs';
  if (model === 'svod' || model === 'avod') return 'vod';
  if (v.ref_report_kind === '劇場' && model) return String(model).endsWith('flat') ? 'flat' : 'rs';
  if (v.ref_report_kind === 'ビデオグラム' && model) return 'rs';
  return LEGACY_CODE_BLOCK[v.distribution_code] || null;
}
export const BLOCK_OF_REMOVED = Object.freeze({flat_holder_ex_tax: 'flat', mg_holder_ex_tax: 'mg', rss_holder_ex_tax: 'rss'});
// #12・19・34 の値: まとまりが合えば amount_ex_tax、合わなければ空
export const removedHolderValue = (key, v) => (legacyBlockOf(v) === BLOCK_OF_REMOVED[key] ? v.amount_ex_tax ?? null : null);

// #75（加工の記録）は source_reference_id（原本の追跡用参照）と同じ材料の言い換え
export function processingIdOf(referenceId) {
  const text = String(referenceId ?? '');
  let m = /^mapping:report:\d+:version:(\d+)$/.exec(text);
  if (m) return `列対応の版 ${m[1]}`;
  m = /^workflow:artifact:(\d+):mapping:(\d+)$/.exec(text);
  if (m) return `原本 ${m[1]}・列対応の版 ${m[2]}`;
  m = /^source:file:\d+:partition:(\d+):mapping:(\d+)$/.exec(text);
  if (m) return `原本の分割 ${m[1]}・列対応の版 ${m[2]}`;
  return null;
}

// ---------- 数える（純関数） ----------
const isEmptyValue = (row) => (row.value_text === null || row.value_text === undefined) && (row.value_number === null || row.value_number === undefined);
const examplesOf = (ids) => [...new Set(ids)].sort((a, b) => a - b).slice(0, EXAMPLES);

// 料率の5キーとまとまり、G-7 の2件の数え方は src（sales-sheet-model.mjs。adopt-v2 が料率の分子を変える前に同じ数え方で確かめる）
export const RATE_KEYS = RATE_BLOCKS;
export {rateKeyConflicts, rateBlockMismatches};

// 裁定1・2 (a) の新しい表（sale_distribution_metric_versions）の metric_key と、値を入れる列の型（計画の香盤表 #6）
//   x100: ×100 の整数（小数2桁まで）／ bps: % を1万分率の整数（% の小数2桁まで）／ integer・yen: 整数だけ／ text: 文字
export const METRIC_TARGETS = Object.freeze({
  rental_turnover: {metric: 'rental_turnover_x100', kind: 'x100'},
  overdue_count: {metric: 'overdue_count', kind: 'integer'},
  overdue_amount: {metric: 'overdue_amount_yen', kind: 'yen'},
  overdue_share: {metric: 'overdue_share_yen', kind: 'yen'},
  rss_declared: {metric: 'reported_declared_ex_tax', kind: 'yen'},
  unique_viewers: {metric: 'viewer_uu_count', kind: 'integer'},
  theatre_name: {metric: 'theater_name', kind: 'text'},
  ticket_category: {metric: 'ticket_class', kind: 'text'},
  ticket_unit_inc_tax: {metric: 'ticket_unit_price_inc_tax_yen', kind: 'yen'},
  ticket_raw_label: {metric: 'ticket_type_text', kind: 'text'},
  ...Object.fromEntries(Object.keys(RATE_KEYS).map((key) => [key, {metric: 'reported_rate_bps', kind: 'bps'}])),
});
// 数の値の文字（SQLite は Number、PostgreSQL の入口は Decimal の文字で返す）。指数の形は読めないので null
const numberTextOf = (value) => {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : String(value).trim();
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
};
// 新しい表の型で表せるか。小数の値は文字のまま桁を数える（浮動小数で掛けない。money.md）
export function representable(kind, row) {
  if (kind === 'text') return row.value_text !== null && row.value_text !== undefined && String(row.value_text).length > 0;
  const text = numberTextOf(row.value_number);
  if (text === null) return false;
  if (kind === 'x100' || kind === 'bps') return scaledInteger(text, 2) !== null;
  return scaledInteger(text.replace(/\.0+$/, ''), 0) !== null;
}
export function unrepresentableValues(values) {
  const byMetric = {};
  const all = [];
  for (const row of values) {
    const target = METRIC_TARGETS[row.column_key];
    if (!target || isEmptyValue(row) || representable(target.kind, row)) continue;
    const saleId = Number(row.sale_id);
    all.push(saleId);
    byMetric[target.metric] ??= {kind: target.kind, keys: new Set(), sales: []};
    byMetric[target.metric].keys.add(row.column_key);
    byMetric[target.metric].sales.push(saleId);
  }
  return {
    count: all.length, examples: examplesOf(all),
    byMetric: Object.fromEntries(Object.entries(byMetric).sort(([a], [b]) => a.localeCompare(b)).map(([metric, item]) => [metric, {kind: item.kind, keys: [...item.keys].sort(), count: item.sales.length, examples: examplesOf(item.sales)}])),
  };
}

// 辞書に無いキーの値（src の attributeOrphans。adopt-v2 の応答と同じ数え方）。dictionaryKeys の既定は旧131エントリ、removedKeys は計画で外すキー
export function attributeOrphans(values, {dictionaryKeys = LEGACY_PLAN.map((c) => c.key), removedKeys = REMOVED_ATTRIBUTE_KEYS} = {}) {
  return attributeOrphansOf(values, {dictionaryKeys, removedKeys});
}

// 裁定3 の4項目（src の royaltyAmountMismatches。adopt・adopt-v2 が4列を止めるかを決める数え方と同じ）
export const ROYALTY_ITEMS = registry.ROYALTY_MISMATCH_ITEMS;
export const royaltyAmountMismatches = royaltyAmountMismatchesOf;

// ---------- DB から読む（D1・SQLite・PostgreSQL の入口のどれでも。all(sql, params) だけを使う） ----------
const LATEST_ATTRIBUTES = `SELECT a.sale_id,a.column_key,a.value_text,a.value_number FROM sale_attribute_values a
  WHERE a.org_id=? AND a.version_no=(SELECT MAX(x.version_no) FROM sale_attribute_values x WHERE x.org_id=a.org_id AND x.sale_id=a.sale_id AND x.column_key=a.column_key)
  ORDER BY a.sale_id,a.column_key`;
// 料率の値がある売上の流通のまとまり。シート（sales-sheet-routes.mjs の loadContexts）と同じ材料（流通分類の最新の版・流通マスタ・流通別の詳細）で salesBlock を呼ぶ
const rateSaleBlocks = async (db, orgId) => rateSaleBlocksOf(await loadRateSaleBlockRows(db, orgId, Object.keys(RATE_KEYS)));

export async function checkOrganization(db, orgId) {
  const values = (await db.all(LATEST_ATTRIBUTES, [orgId])).filter((row) => !isEmptyValue(row));
  const [blocks, basis, currency, sales] = await Promise.all([
    rateSaleBlocks(db, orgId),
    db.all(`SELECT s.id AS sale_id,s.amount_ex_tax,s.tax_amount,s.amount_inc_tax,b.royalty_amount_ex_tax,b.royalty_tax_amount,b.royalty_amount_inc_tax
      FROM sale_lines s JOIN sale_royalty_basis_versions b ON b.org_id=s.org_id AND b.sale_id=s.id
      WHERE s.org_id=? AND b.version_no=(SELECT MAX(x.version_no) FROM sale_royalty_basis_versions x WHERE x.org_id=b.org_id AND x.sale_id=b.sale_id) ORDER BY s.id`, [orgId]),
    db.all(`SELECT v.sale_id,v.currency_code,v.original_amount_x100,v.original_royalty_x100 FROM sale_currency_versions v
      WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM sale_currency_versions x WHERE x.org_id=v.org_id AND x.sale_id=v.sale_id) ORDER BY v.sale_id`, [orgId]),
    db.all('SELECT COUNT(*) AS n FROM sale_lines WHERE org_id=?', [orgId]),
  ]);
  return {
    saleLines: Number(sales[0]?.n ?? 0), attributeValues: values.length,
    rateKeys: rateKeyConflicts(values), rateBlocks: rateBlockMismatches(values, blocks), unrepresentable: unrepresentableValues(values),
    attributeOrphans: attributeOrphans(values), royaltyMismatch: royaltyAmountMismatches({basis, currency}),
  };
}

// 架空データの DB か。架空の組織のコード（schema の既定の demo・other と、seed の DEMO-…）と、架空のメール（.invalid）だけなら空の配列。
// 問題は件数だけを返す（本物の DB だったときに、組織のコードやメールを画面に出さない）
export const FICTIONAL_ORG_CODE = /^(demo|other|DEMO-[A-Z0-9-]+)$/;
export async function fictionalDatabaseProblems(db) {
  const orgs = await db.all('SELECT code FROM organizations ORDER BY id');
  const users = await db.all('SELECT email FROM users ORDER BY id');
  const problems = [];
  if (!orgs.length) problems.push('組織がありません（架空データの seed を入れた DB を指定してください）');
  const realOrgs = orgs.filter((row) => !FICTIONAL_ORG_CODE.test(String(row.code ?? ''))).length;
  if (realOrgs) problems.push(`架空データの組織のコード（demo・other・DEMO-…）ではない組織が${realOrgs}件あります`);
  const realUsers = users.filter((row) => !/\.invalid$/i.test(String(row.email ?? ''))).length;
  if (realUsers) problems.push(`メールが .invalid ではない利用者が${realUsers}人います`);
  return problems;
}

// DB 全体（組織ごと）。ok は計画の前提（G-7 の2件と、新しい表の型で表せない値が0件。計画の写しが辞書と一致）
export async function checkDatabase(db) {
  const orgs = await db.all('SELECT id,code FROM organizations ORDER BY id');
  const organizations = [];
  for (const org of orgs) organizations.push({org: org.code, ...(await checkOrganization(db, org.id))});
  const plan = planCoverage();
  const sum = (pick) => organizations.reduce((n, org) => n + pick(org), 0);
  const totals = {
    rateKeys: sum((o) => o.rateKeys.count), rateBlocks: sum((o) => o.rateBlocks.count), unrepresentable: sum((o) => o.unrepresentable.count),
    attributeOrphans: sum((o) => o.attributeOrphans.notInDictionary.count), removedAttributeValues: sum((o) => o.attributeOrphans.inRemovedKeys.count),
    royaltyMismatch: sum((o) => o.royaltyMismatch.count),
  };
  return {
    format: CHECK_FORMAT, ok: totals.rateKeys === 0 && totals.rateBlocks === 0 && totals.unrepresentable === 0 && !plan.notInRegistry.length && !plan.unknownPlanKeys.length,
    totals, plan: {...plan, removed: REMOVED_KEYS, removedAttributes: REMOVED_ATTRIBUTE_KEYS, royalty: ROYALTY_KEYS, mgFixture: MG_FIXTURE_KEYS}, organizations,
  };
}

// ---------- コマンド ----------
function parseArgs(argv) {
  const options = {check: false, db: null};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--db') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error('--db の値（SQLite のパス）を指定してください');
      options.db = next;
      i += 1;
    } else throw new Error(`知らない指定です: ${arg}（いまあるのは --check --db <パス> だけ）`);
  }
  if (!options.check) throw new Error('いまあるのは --check だけです: node scripts/sales-sheet-columns-v2.mjs --check --db <架空データの SQLite>');
  if (!options.db) throw new Error('--db で架空データの使い捨ての SQLite を指定してください（例: node scripts/seed-all-demo.mjs --db <パス> で作ったもの）');
  return options;
}

// 読み取り専用の SQLite を、入口と同じ all(sql, params) の形で包む
function openReadOnly(path) {
  const raw = new DatabaseSync(path, {readOnly: true});
  const all = async (sql, params = []) => raw.prepare(sql).all(...params).map((row) => ({...row}));
  return {all, get: async (sql, params = []) => (await all(sql, params))[0], close: () => raw.close()};
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
  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (resolve(options.db).toLowerCase() === resolve(mainDb).toLowerCase()) {
    console.error('data/integrated.sqlite は開きません。scripts/seed-all-demo.mjs --db で作った使い捨ての DB を指定してください。');
    process.exit(2);
  }
  const db = openReadOnly(resolve(options.db));
  try {
    const problems = await fictionalDatabaseProblems(db);
    if (problems.length) {
      console.error(`架空データの使い捨ての DB ではないので数えません: ${problems.join('／')}`);
      process.exitCode = 2;
    } else {
      const result = await checkDatabase(db);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    }
  } finally {
    db.close();
  }
}
