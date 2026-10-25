// 売上集計シートの列を唯一の辞書に統合する前後で、粒度が変わらないことを確かめる
// （会社ルートの plans/2026-10-09-sheet-columns-by-grain.md の受け入れ基準 G-1〜G-14。香盤表 #3）。
//
// ★ 名前に「#2a で緑にする」と付けた試験は、辞書の統合（香盤表 #2a）で緑にした。期待値は計画から作った:
//   G-1・G-2・G-5・G-9・G-11 の adopt-v2 のあと、G-7（料率の前提）・G-10・G-11 の adopt-v2、G-12 の MG の版と契約の選び方、G-13、G-14。
//   架空データの組織（DEMO-SALES。各試験で共有する DB）は「統合前に列を採用した組織」として作る（seedGrainDemo が統合前の初期の列を
//   catalog-v1.json から入れ、seed が追加の列を入れる）。adopt-v2 を当てる試験はファイルの最後にまとめて置く（adopt-v2 は2回目で版が増えないので、
//   どれが先に流れても同じ状態になる。前の試験は統合前の状態の組織を読む）。
// ★ {todo} を付けた試験は、#2a では緑にしない（PR A の CI を落とさないため、失敗しても全体は落とさない。流れて結果は出る）:
//   - 「PR C で緑にする」: 裁定1・2 (a) の退役キー（retired_by）と新しい表（香盤表 #6）。#2a の辞書には retired_by を持つ列が無い
//   - 「既知の不具合」: 作品の切り口の集計と作品の絞り込み（workId）の件数の食い違い（統合の前から。按分の要件の計画で直す。下の G-3）
// ★ #2a で決めた形（計画の「既定値」と決定ログ）:
//   - 辞書は column-registry.mjs の SHEET_COLUMNS（1要素 {key, retired_by, removed, sort_order, …}）
//   - 採用済みの組織へは POST /api/sales-sheet/columns/adopt-v2 {reason}。裁定3で4列を残した組織は応答の kept に列キー、keptReason に
//     残した理由の文（「食い違」と食い違いの件数を含む）を返す
//   - 裁定3の監査の列 royalty_amount_mismatch は はい・いいえ（bool）で、4項目のどれも違わない売上は「いいえ」（空ではない）
//   - 外した拡張属性のキーの列対応は、取込の確認（/api/imports/preview）の行の attributes に {k, skipped: 'removed', warning} を入れて返す
//     （読み飛ばした件数はその数。取込は止めない）
//   - 辞書に無いキーの拡張属性の値の件数・裁定3の食い違いの件数は src/sales-sheet/sales-sheet-model.mjs の attributeOrphans・
//     royaltyAmountMismatches（#1 の scripts/sales-sheet-columns-v2.mjs はこれを呼ぶ）で数える
//   - 列セット名 additional・all_plus は全列（all）の別名（決定ログ 2026-10-09「列セット additional・all_plus」）。URL の set= でも全列と同じ列を返す
//
// fixture（test/fixtures/sales-sheet/）は統合前の main で scripts/sales-sheet-grain-fixtures.mjs が架空データから作った（2回作って同じ値）。
// 期待値は fixture と計画から取る。計画の列番号はこの試験の中で書き下し（PLAN）、#1 の道具の写し（LEGACY_PLAN）と食い違わないことも確かめる。
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv} from '../src/csv.mjs';
import * as registry from '../src/sales-sheet/column-registry.mjs';
import {scaledInteger} from '../src/sales-sheet/sales-sheet-input.mjs';
import {
  LEGACY_PLAN, REMOVED_KEYS, ROYALTY_KEYS, MG_FIXTURE_KEYS, REMOVED_ATTRIBUTE_KEYS, BLOCK_OF_REMOVED, RATE_KEYS, removedHolderValue, processingIdOf,
  rateKeyConflicts, rateBlockMismatches, unrepresentableValues, attributeOrphans, royaltyAmountMismatches, checkOrganization, planCoverage, fictionalDatabaseProblems,
} from '../scripts/sales-sheet-columns-v2.mjs';
import {
  seedGrainDemo, apiClient, query, sheetDetail, sheetAggregate, groupLines, pivotOf, dimensionTable, savedViewResults, maskVolatile, saleOf, preIntegrationProblem, insertPreIntegrationCatalog,
  MONTH_COLUMNS, SNAPSHOT_KEYS, SNAPSHOT_MEASURES, RATIO_COLUMNS, AGGREGATE_DIMS, CHANNEL_DETAIL_REPORTS, REVISION_REPORTS, SOURCE_ROUTE_REPORTS, MANUAL_ATTRIBUTES,
  MG_VERSIONS_SEED, mgExpectedByMonth, seedMgVersions, MG_SHEET_COLUMNS, VOLATILE_MARK,
} from '../scripts/sales-sheet-grain-fixtures.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/sales-sheet/${name}`, import.meta.url), 'utf8'));
const snapshot = fixture('grain-snapshot.json');
const legacy = fixture('legacy-reproduction.json');
const catalogV1 = fixture('catalog-v1.json');
const mgFixture = fixture('mg-versions.json');
const legacyRows = legacy.rows.map((row) => Object.fromEntries(legacy.rowColumns.map((key, i) => [key, row[i]])));
const legacyByFingerprint = new Map(legacyRows.map((row) => [row.row_fingerprint, row]));
const v1ByKey = new Map(catalogV1.columns.map((c) => [c.column_key, c]));
const keyAt = (position) => catalogV1.columns.find((c) => c.legacy_position === position).column_key;

// ---------- 計画の書き下し（列番号は計画の対応表のとおり） ----------
const PLAN = {
  removed: [...[12, 19, 34, 59, 64, 65, 72, 73, 75, 82].map(keyAt), 'h_theatre_inc_amount', 'report_status'], // 消
  royalty: [...[44, 48, 52].map(keyAt), 'royalty_tax_amount'], // 裁定3: 食い違いが0件の組織だけ止める
  mg: [15, 16, 17, 74].map(keyAt), // G-12 で比べる
  rates: [11, 18, 25, 33, 41].map(keyAt), // 裁定1
  metrics: [24, 29, 30, 31, 32, 35, 56, 61, 63, 67].map(keyAt), // 裁定2
  added: ['royalty_amount_mismatch'], // 裁定3 (a) の監査の列
  holderKept: [28, 42].map(keyAt), // 群を helper へ移して全列に残す
};
// #2a のあとの有効な列（裁定3の食い違いが0件の組織）。裁定1・2 の列は PR C までは今のキーのまま
const expectedV2Active = ({keptRoyalty = false} = {}) => new Set([
  ...legacy.entries.map((e) => e.key).filter((key) => !PLAN.removed.includes(key) && (keptRoyalty || !PLAN.royalty.includes(key))), ...PLAN.added,
]);
// 再現表で、架空データに値のある行が1つも無くてよい列（無し。足すときは理由を書く）
const ALLOWED_EMPTY_COLUMNS = Object.freeze([]);
const TRACE_KEYS = ['sale_id', 'import_id', 'source_row_number', 'report_number', 'row_fingerprint', 'source_file'];
const SOURCE_KEYS = ['source_reference_id', 'processing_id', 'processed_at', 'source_file', 'imported_at'];
const PROVENANCE_KEYS = ['import_id', 'source_row_number', 'supersedes_report_id', 'distribution_version', 'currency_version', 'royalty_basis_version', 'record_version', 'row_fingerprint'];
const AUDIT_PROVENANCE = ['import_id', 'imported_at', 'source_file', 'processed_at', 'registration_kind', 'record_version', 'row_fingerprint'];
const VERSIONED_SOURCES = ['distribution_code', 'distribution_version', 'settlement_method', 'royalty_month', 'royalty_basis_version', 'royalty_basis_origin', 'currency_code',
  'foreign_amount', 'exchange_rate', 'currency_rate_date', 'currency_basis', 'currency_version', 'recognition_basis_id', 'recognition_reason', 'report_received_on',
  'recognition_contract_start_on', 'license_start_on', 'broadcast_on'];
const SUM_MEASURES = SNAPSHOT_MEASURES.filter((key) => v1ByKey.get(key).aggregation === 'sum');
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const ADMIN = 'admin@openingnight.invalid', EDITOR = 'editor@openingnight.invalid', OTHER_ADMIN = 'outsider@other.invalid';
const REASON = '売上集計シートの列を唯一の辞書へ（試験）';

// ---------- 道具 ----------
const sortStrings = (list) => [...list].sort();
const scaled2 = (value) => (value === null || value === undefined ? null : scaledInteger(String(value), 2));
async function latestColumns(db, orgId) {
  const rows = await db.all(`SELECT c.column_key,c.version_no,c.active,c.source_kind FROM sales_sheet_column_versions c
    WHERE c.org_id=? AND c.version_no=(SELECT MAX(x.version_no) FROM sales_sheet_column_versions x WHERE x.org_id=c.org_id AND x.column_key=c.column_key)`, [orgId]);
  return new Map(rows.map((row) => [row.column_key, {version: Number(row.version_no), active: Number(row.active) === 1, sourceKind: row.source_kind}]));
}
const versionCount = async (db, orgId) => Number((await db.get('SELECT COUNT(*) AS n FROM sales_sheet_column_versions WHERE org_id=?', [orgId])).n);
const auditCount = async (db, orgId) => Number((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE org_id=? AND entity_type='sales_sheet_column'", [orgId])).n);
const adoptV2 = (api) => api.raw('POST', '/sales-sheet/columns/adopt-v2', {reason: REASON});
const show = (out) => `${out.status} ${(out.body instanceof Uint8Array ? new TextDecoder().decode(out.body) : JSON.stringify(out.body)).slice(0, 300)}`;
// adopt-v2 が通ったこと（いまは入口が無く 404。#2a で足す）
const assertAdopted = (out) => assert.ok(out.status === 200 || out.status === 201, `adopt-v2: ${show(out)}`);
const orgOf = async (db, email) => Number((await db.get('SELECT m.org_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=? ORDER BY m.org_id LIMIT 1', [email])).org_id);
const latestAttributeValues = async (db, orgId) => (await db.all(`SELECT a.sale_id,a.column_key,a.value_text,a.value_number FROM sale_attribute_values a
  WHERE a.org_id=? AND a.version_no=(SELECT MAX(x.version_no) FROM sale_attribute_values x WHERE x.org_id=a.org_id AND x.sale_id=a.sale_id AND x.column_key=a.column_key)
  ORDER BY a.sale_id,a.column_key`, [orgId])).filter((row) => row.value_text !== null || row.value_number !== null);
// 裁定3で残した列のキー（kept が配列でも、{columns} でも、キーの対応でも読む）
const keptKeys = (kept) => sortStrings(Array.isArray(kept) ? kept.map((k) => (typeof k === 'string' ? k : k?.key ?? k?.columnKey))
  : kept && typeof kept === 'object' ? kept.columns ?? kept.keys ?? Object.keys(kept) : []);
// 応答の中の文字（残した理由を探す）
const textsOf = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) textsOf(item, out);
  return out;
};
// 取込の確認の応答の行から、読み飛ばした拡張属性の列（attributes の skipped）を集める
const skippedAttributes = (body) => (body?.rows || []).flatMap((row) => (row.attributes || []).filter((item) => item.skipped));
// 列セットの別名（additional・all_plus）は全列（all）と同じ列を同じ順に返し、辞書の有効な列だけで、統合前の中身（外した列・止めた列を除く）を含む
function assertAliasSet(got, key, active, all) {
  assert.deepEqual(got, all, `${key} は全列の別名`);
  const lower = catalogV1.sets[key].filter((k) => active.has(k));
  assert.equal(new Set(got).size, got.length, `${key} に同じ列が2回無い`);
  assert.deepEqual(got.filter((k) => !active.has(k)), [], `${key} は辞書の有効な列だけ`);
  assert.deepEqual(lower.filter((k) => !got.includes(k)), [], `${key} は統合前の中身（外した列・止めた列を除く）を含む`);
}

// 旧い組織（統合前に初期の列と追加の列を採用した組織）。初期の列は fixture（catalog-v1.json）を統合前の採用（adopt）と同じ形で版1に入れ、
// 追加の列は adopt-additional で入れる。既定の架空組織（admin@openingnight.invalid の組織）を使う。mutate で入れる前の列を変えられる
async function oldOrg(t, {mutate = (column) => column} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const admin = await apiClient(app, ADMIN);
  const orgId = await orgOf(db, ADMIN);
  const userId = Number((await db.get('SELECT id FROM users WHERE email=?', [ADMIN])).id);
  assert.equal(await insertPreIntegrationCatalog(db, orgId, userId, {mutate}), catalogV1.columns.filter((c) => c.template === 'initial').length);
  await admin.post('/sales-sheet/columns/adopt-additional', {reason: '統合前の追加の列（試験）'});
  return {db, app, admin, orgId, userId};
}
// 既定の架空組織に配信の売上を足す（作品1・取引先2・商品1）。n 件目の額は 10,000×n（税 1,000×n）。売上IDを返す
async function addSales(db, admin, orgId, months, prefix = 'GRAIN-TEST') {
  const ids = [];
  for (const [n, month] of months.entries()) {
    const key = `${prefix}-${n + 1}`;
    await admin.post('/sales', {workId: 1, report_key: key, kind: 'digital', description: `試験の配信 ${month}（架空）`, quantity: '', partner_id: 2, product_id: 1,
      period_from: `${month}-01`, period_to: `${month}-28`, accounting_month: month, amount_ex_tax: 10000 * (n + 1), tax_amount: 1000 * (n + 1), amount_inc_tax: 11000 * (n + 1)});
    ids.push(Number((await db.get('SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=? AND r.report_key=?', [orgId, key])).id));
  }
  return ids;
}
// 外した拡張属性のキーに入れる架空の値（統合前の旧い組織で入れる）
const REMOVED_ATTRIBUTE_VALUES = Object.freeze([
  ['theatre_unit_inc_tax', '1980'], ['ticket_audience', '一般の大人（架空）'], ['ticket_campaign', 'はい'],
  ['advance_guarantee_month', '50000'], ['maker_paid_total', '120000'], ['update_reason', '報告の差し替え（架空）'],
]);
async function addRemovedAttributeValues(admin, saleId) {
  await admin.post('/sales-sheet/values', {changes: REMOVED_ATTRIBUTE_VALUES.map(([columnKey, value]) => ({saleId, columnKey, baseVersion: 0, value})), reason: '外す列に入っていた値（架空）'});
}
// ロイヤリティ計上の額が売上と違う版を持つ旧い組織（裁定3の食い違いが1売上）。
//   mismatched: 2026-04 の売上（10,000・税 1,000）に、額を 9,000・税 900 にした版と、外貨のロイヤリティ計上額を外貨の計上額（100.00 USD）と違う 90.00 USD にした版
//   matched:    2026-05 の売上（20,000・税 2,000）に、月だけを 2026-06 にした版（額は売上と同じ）
const ROYALTY_MISMATCH = Object.freeze({exTax: 9000, tax: 900, foreignAmount: '100.00', foreignRoyalty: '90.00', rate: '100.0000'});
async function royaltyOrg(t, {mismatch = true} = {}) {
  const old = await oldOrg(t);
  const [first, second] = await addSales(old.db, old.admin, old.orgId, ['2026-04', '2026-05'], mismatch ? 'ROY' : 'ROY0');
  if (mismatch) {
    await old.admin.post(`/sales-sheet/sales/${first}/royalty-basis`, {baseVersion: 0, royaltyMonth: '2026-04', amountExTax: String(ROYALTY_MISMATCH.exTax), taxAmount: String(ROYALTY_MISMATCH.tax),
      reason: '額を変えた版（食い違い・架空）'});
    await old.admin.post(`/sales-sheet/sales/${first}/currency`, {baseVersion: 0, currencyCode: 'USD', originalAmount: ROYALTY_MISMATCH.foreignAmount, originalRoyaltyAmount: ROYALTY_MISMATCH.foreignRoyalty,
      exchangeRate: ROYALTY_MISMATCH.rate, rateDate: '2026-04-30', basis: '架空の為替の出典', reason: '外貨のロイヤリティ計上額を違う額で記録（食い違い・架空）'});
  } else {
    await old.admin.post(`/sales-sheet/sales/${first}/royalty-basis`, {baseVersion: 0, royaltyMonth: '2026-05', amountExTax: '10000', taxAmount: '1000', reason: '月だけ翌月にした版（架空）'});
  }
  await old.admin.post(`/sales-sheet/sales/${second}/royalty-basis`, {baseVersion: 0, royaltyMonth: '2026-06', amountExTax: '20000', taxAmount: '2000', reason: '月だけ翌月にした版（架空）'});
  return {...old, first, second};
}
// 明細の行の値（売上IDで引く）
const detailById = async (client, columns) => new Map((await sheetDetail(client, ['sale_id', ...columns])).rows.map((row) => [row.sale_id, row]));

// ---------- 架空データの組織（DEMO-SALES）。統合前の fixture と同じ入れ方 ----------
let db, api, orgId;
before(async (t) => {
  db = await openTestDb({t});
  ({api, orgId} = await seedGrainDemo(db));
});
// 行の照合値 → この DB の売上ID
async function saleIdByFingerprint() {
  const rows = await db.all(`SELECT s.id,s.source_row,r.content_hash FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=? AND r.status='active'`, [orgId]);
  return new Map(rows.map((row) => [`${row.content_hash}:${row.source_row ?? ''}`, Number(row.id)]));
}
const reportsWithStatus = async () => Object.fromEntries((await db.all(`SELECT r.status,COUNT(*) AS n FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
  WHERE s.org_id=? GROUP BY r.status`, [orgId])).map((row) => [row.status, Number(row.n)]));

// ---------- 計画の写しと fixture ----------
test('計画の写し: #1 の道具の旧131エントリ（LEGACY_PLAN）は統合前のカタログと同じで、どれもコードの辞書にあり、消・裁定・MG の列が計画の列番号と同じ', () => {
  assert.deepEqual(LEGACY_PLAN.map((c) => [c.key, c.position, c.template]), catalogV1.columns.map((c) => [c.column_key, c.legacy_position, c.template]));
  const coverage = planCoverage();
  assert.deepEqual({entries: coverage.entries, notInRegistry: coverage.notInRegistry, unknownPlanKeys: coverage.unknownPlanKeys}, {entries: 131, notInRegistry: [], unknownPlanKeys: []});
  // 辞書に足してよい新しいキーは、計画の「足す列」だけ
  const planned = new Set([...PLAN.added, ...LEGACY_PLAN.map((c) => c.destination).filter(Boolean)]);
  assert.deepEqual(coverage.newInRegistry.filter((key) => !planned.has(key)), []);
  assert.deepEqual(coverage.byTreatment, {残: 92, 派: 3, 消: 12, 裁1: 10, 裁2: 10, 裁3: 4});
  assert.deepEqual(sortStrings(REMOVED_KEYS), sortStrings(PLAN.removed));
  assert.deepEqual(sortStrings(ROYALTY_KEYS), sortStrings(PLAN.royalty));
  assert.deepEqual(sortStrings(MG_FIXTURE_KEYS), sortStrings(PLAN.mg));
  assert.deepEqual(sortStrings(LEGACY_PLAN.filter((c) => c.treatment === '裁1').map((c) => c.key)),
    sortStrings([...PLAN.rates, 'h_flat_implied_deal', 'h_mg_implied_gross', 'h_rs_implied_gross', 'h_rss_implied_declared', 'h_vod_implied_gross']));
  assert.deepEqual(sortStrings(LEGACY_PLAN.filter((c) => c.treatment === '裁2').map((c) => c.key)), sortStrings(PLAN.metrics));
  assert.deepEqual(legacy.entries.map((e) => e.key), LEGACY_PLAN.map((c) => c.key));
});

test('G-2 再現表（fixture）は旧131エントリをすべて持ち、行は明細と同じ件数で、MG の4列は G-12 の fixture に分けてある', () => {
  assert.equal(legacy.entries.length, 131);
  assert.equal(new Set(legacy.entries.map((e) => e.key)).size, 131);
  assert.deepEqual(sortStrings(legacy.entries.filter((e) => e.separated).map((e) => e.key)), sortStrings(PLAN.mg));
  assert.deepEqual(sortStrings(legacy.rowColumns), sortStrings(legacy.entries.filter((e) => !e.separated).map((e) => e.key)));
  assert.equal(legacy.rows.length, snapshot.lineCount);
  assert.equal(legacyByFingerprint.size, snapshot.lineCount, '行の照合値で1行ずつ引ける');
  assert.equal(catalogV1.columns.length, 131);
});

test('fixture: 再現表のどの列にも値のある行があり（全行が空の列は許容リストだけ）、訂正・版2・原本の3つの経路・複数の切り口に測度の値を持つ', () => {
  const empty = legacy.rowColumns.filter((key) => legacyRows.every((row) => row[key] === null));
  assert.deepEqual(empty, ALLOWED_EMPTY_COLUMNS, '架空データに値の無い列は、全行一致が空どうしの比較になる');
  const values = (key) => [...new Set(legacyRows.map((row) => row[key]).filter((v) => v !== null))].sort();
  assert.deepEqual(values('registration_kind'), ['新規', '訂正']);
  for (const key of ['record_version', 'distribution_version', 'royalty_basis_version', 'currency_version']) assert.deepEqual(values(key), [1, 2], `${key} は版1と版2`);
  assert.deepEqual(values('source_reference_id').map((ref) => ref.split(':')[0]), ['mapping', 'source', 'workflow'], '原本の参照の3つの経路');
  assert.deepEqual(values('processed_at'), [VOLATILE_MARK]);
  // raw_quantity と vod_partner_sales_ex_tax は、作品×商品×流通区分×取引先×計上月の2つ以上の組に値がある（測度の合計が1行の値の写しにならない）
  const index = (name) => snapshot.columns.indexOf(name);
  for (const measure of ['raw_quantity', 'vod_partner_sales_ex_tax']) {
    const groups = snapshot.byMonth.accounting.filter((row) => row[index(measure)] !== null);
    assert.ok(groups.length >= 2, `${measure} の値がある組: ${groups.length}`);
    assert.ok(legacyRows.filter((row) => row[measure] !== null).length >= 3, measure);
  }
});

test('fixture の道具は、統合後のコード（唯一の辞書 SHEET_COLUMNS がある）では作らない', () => {
  assert.equal(preIntegrationProblem({INITIAL_SHEET_COLUMNS: []}), null);
  assert.match(preIntegrationProblem({SHEET_COLUMNS: []}), /統合後のコードでは作りません/);
  // いまの作業場のコードで fixture を作り直せるのは、統合前のときだけ
  assert.equal(preIntegrationProblem(registry) === null, !Array.isArray(registry.SHEET_COLUMNS));
});

// ---------- G-1 件数・合計 ----------
const G1_COLUMNS = ['sale_id', 'row_fingerprint', ...SNAPSHOT_KEYS, ...Object.values(MONTH_COLUMNS), ...SNAPSHOT_MEASURES];
// 明細の件数・測度の合計・作品×商品×流通区分×取引先×月（3つの月の基準）の束が統合前と同じ
async function assertDetailTotals(client) {
  const {rows, total} = await sheetDetail(client, G1_COLUMNS);
  assert.equal(total, snapshot.lineCount);
  assert.equal(rows.length, snapshot.lineCount);
  for (const measure of SNAPSHOT_MEASURES) {
    const values = rows.map((row) => row[measure]).filter((v) => v !== null);
    assert.equal(values.length ? values.reduce((a, b) => a + b, 0) : null, snapshot.totals[measure], measure);
  }
  for (const [basis, column] of Object.entries(MONTH_COLUMNS)) assert.deepEqual(groupLines(rows, column), snapshot.byMonth[basis], `${basis}（${column}）`);
  return rows;
}
// 集計（切り口）の件数と5つの測度が統合前と同じ。作品×商品×取引先の集計は、明細から束ねた合計（fixture の byMonth を束ね直したもの）とも合う
async function assertAggregateTotals(client) {
  for (const dims of AGGREGATE_DIMS) {
    const table = await dimensionTable(client, dims, SNAPSHOT_MEASURES);
    assert.deepEqual(table, snapshot.aggregates[dims.join(',')], dims.join('×'));
    for (const measure of SUM_MEASURES) assert.equal(table.totals[measure], snapshot.totals[measure], `${dims.join('×')} の合計 ${measure}`);
  }
  const at = (name) => snapshot.columns.indexOf(name);
  const rolled = new Map();
  for (const row of snapshot.byMonth.accounting) {
    const key = JSON.stringify([row[at('work_code')], row[at('product_code')] ?? '', row[at('partner_code')]]);
    const sums = rolled.get(key) ?? {lines: 0, ...Object.fromEntries(SUM_MEASURES.map((m) => [m, null]))};
    sums.lines += row[at('lines')];
    for (const m of SUM_MEASURES) if (row[at(m)] !== null) sums[m] = (sums[m] ?? 0) + row[at(m)];
    rolled.set(key, sums);
  }
  const table = await dimensionTable(client, ['work', 'product', 'partner'], SUM_MEASURES);
  assert.equal(table.rows.length, rolled.size);
  for (const row of table.rows) {
    const sums = rolled.get(JSON.stringify(row.slice(0, 3)));
    assert.ok(sums, `明細の束に ${row.slice(0, 3).join('×')} がある`);
    assert.deepEqual([row[6], ...row.slice(7)], [sums.lines, ...SUM_MEASURES.map((m) => sums[m])], row.slice(0, 3).join('×'));
  }
}
// 月を横に並べた集計の月ごとの合計が統合前と同じで、明細の月ごとの合計（計上額。DEMO-SALES はロイヤリティ計上の額が売上と同じ）と一致する
async function assertPivotTotals(client, expectRoyaltyKey) {
  for (const basis of Object.keys(MONTH_COLUMNS)) {
    for (const tax of ['ex', 'inc']) {
      const {pivotKey, totals} = await pivotOf(client, basis, tax);
      assert.deepEqual(totals, snapshot.pivot[basis][tax], `${basis} ${tax}`);
      const amount = tax === 'inc' ? 'amount_inc_tax' : 'amount_ex_tax';
      assert.equal(pivotKey, basis === 'royalty' ? expectRoyaltyKey(tax) : amount, `${basis} ${tax} の横に並べる列`);
      const monthIndex = snapshot.columns.indexOf('month'), measureIndex = snapshot.columns.indexOf(amount);
      const byMonth = {};
      for (const row of snapshot.byMonth[basis]) byMonth[row[monthIndex]] = (byMonth[row[monthIndex]] || 0) + row[measureIndex];
      for (const [month, value] of Object.entries(totals)) assert.equal(value, byMonth[month] ?? null, `${basis} ${tax} ${month}`);
    }
  }
}

test('G-1 明細の件数と、作品×商品×流通区分×取引先×月ごとの5つの測度の合計が統合前と同じ（計上月・販売月・ロイヤリティ計上月）。訂正前・取消の報告の明細は数えない', async () => {
  const rows = await assertDetailTotals(api);
  // 架空データには訂正前の報告・取消の報告の明細があり（REVISION_REPORTS）、シートは有効な報告の明細だけを数える
  assert.deepEqual(await reportsWithStatus(), {active: snapshot.lineCount, superseded: REVISION_REPORTS.corrected.before.length, void: REVISION_REPORTS.voided.rows.length});
  // 計上月とロイヤリティ計上月が違う明細は、月だけを変えたロイヤリティ計上の基準の2件だけ（額は同じ）
  assert.equal(rows.filter((row) => row.royalty_month !== row.booking_month).length, 2);
});

test('G-1 集計（切り口を最大3つ）の件数と5つの測度が統合前と同じで、作品×商品×取引先の合計は明細から束ねた合計と一致する', async () => {
  await assertAggregateTotals(api);
});

test('G-1 月を横に並べた集計（計上月・販売月・ロイヤリティ計上月）の月ごとの合計が統合前と同じで、明細の月ごとの合計と一致する（税抜・税込）', async () => {
  await assertPivotTotals(api, (tax) => (tax === 'inc' ? 'royalty_amount_inc_tax' : 'royalty_amount_ex_tax'));
});

test('G-1 ロイヤリティ計上の額が売上と違う組織では、ロイヤリティ計上月の横並びはロイヤリティ計上額（9,000）を読み、計上額（10,000）ではない', async (t) => {
  const org = await royaltyOrg(t);
  for (const [tax, expected] of [['ex', {'2026-04': ROYALTY_MISMATCH.exTax, '2026-05': null, '2026-06': 20000}],
    ['inc', {'2026-04': ROYALTY_MISMATCH.exTax + ROYALTY_MISMATCH.tax, '2026-05': null, '2026-06': 22000}]]) {
    const {pivotKey, totals} = await pivotOf(org.admin, 'royalty', tax);
    assert.equal(pivotKey, tax === 'inc' ? 'royalty_amount_inc_tax' : 'royalty_amount_ex_tax');
    assert.deepEqual(totals, expected, tax);
  }
});

// ---------- G-2 行の値 ----------
test('G-2 消す列と裁定3の列の値は、保存先（拡張属性・報告の状態・原本の参照・ロイヤリティ計上の基準・外貨の版）と残す列から全行読み出せる', async () => {
  const ids = await saleIdByFingerprint();
  const attrs = new Map((await latestAttributeValues(db, orgId)).map((row) => [`${row.sale_id}|${row.column_key}`, row]));
  const admissions = new Map((await db.all('SELECT sale_id,admissions_count FROM theatrical_sale_details WHERE org_id=?', [orgId])).map((row) => [Number(row.sale_id), row.admissions_count]));
  const sales = new Map((await db.all(`SELECT s.id,s.amount_ex_tax,s.tax_amount,s.amount_inc_tax,r.status FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=?`, [orgId])).map((row) => [Number(row.id), row]));
  const latest = (table) => db.all(`SELECT v.* FROM ${table} v WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM ${table} x WHERE x.org_id=v.org_id AND x.sale_id=v.sale_id)`, [orgId]);
  const royalty = new Map((await latest('sale_royalty_basis_versions')).map((row) => [Number(row.sale_id), row]));
  const currency = new Map((await latest('sale_currency_versions')).map((row) => [Number(row.sale_id), row]));
  const STATUS = {active: '有効', superseded: '訂正前', void: '取消'}; // 旧の列「報告の状態」の表示
  const typed = (key, stored) => {
    if (!stored) return null;
    const type = v1ByKey.get(key).value_type;
    if (type === 'text') return stored.value_text;
    if (type === 'bool') return Number(stored.value_number) === 1;
    return Number(stored.value_number);
  };
  const filled = Object.fromEntries([...PLAN.removed, ...PLAN.royalty].map((key) => [key, 0]));
  for (const row of legacyRows) {
    const saleId = ids.get(row.row_fingerprint);
    assert.ok(saleId, `この DB に ${row.row_fingerprint} の明細がある`);
    const sale = sales.get(saleId), basis = royalty.get(saleId), cur = currency.get(saleId);
    const expected = {
      ...Object.fromEntries(Object.keys(BLOCK_OF_REMOVED).map((key) => [key, removedHolderValue(key, row)])),
      processing_id: processingIdOf(row.source_reference_id),
      ...Object.fromEntries(REMOVED_ATTRIBUTE_KEYS.map((key) => [key, typed(key, attrs.get(`${saleId}|${key}`))])),
      report_status: STATUS[sale.status],
      royalty_amount_ex_tax: Number(basis ? basis.royalty_amount_ex_tax : sale.amount_ex_tax),
      royalty_tax_amount: Number(basis ? basis.royalty_tax_amount : sale.tax_amount),
      royalty_amount_inc_tax: Number(basis ? basis.royalty_amount_inc_tax : sale.amount_inc_tax),
    };
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(row[key], value, `${key}（売上 ${row.sale_id}）`);
    // 小数の値は文字のまま ×100 の整数にして比べる（money.md）。h_theatre_inc_amount ＝ 劇場別の単価（税込・拡張属性）×動員数
    const unit = attrs.get(`${saleId}|theatre_unit_inc_tax`), count = admissions.get(saleId);
    const theatre = unit && count !== null && count !== undefined ? BigInt(scaledInteger(String(unit.value_number), 2)) * BigInt(count) : null;
    assert.equal(scaled2(row.h_theatre_inc_amount), theatre === null ? null : Number(theatre), `h_theatre_inc_amount（売上 ${row.sale_id}）`);
    // #44 外貨のロイヤリティ計上額: 外貨（円以外）の版に ×100 の額があれば、その額
    const royaltyX100 = cur && cur.currency_code !== 'JPY' && cur.original_royalty_x100 !== null ? Number(cur.original_royalty_x100) : null;
    assert.equal(scaled2(row.foreign_royalty_amount), royaltyX100, `foreign_royalty_amount（売上 ${row.sale_id}）`);
    for (const key of Object.keys(filled)) if (row[key] !== null) filled[key] += 1;
  }
  // どの列も値のある行で比べている（空どうしの比較だけで終わらない）
  assert.deepEqual(Object.entries(filled).filter(([, n]) => n === 0).map(([key]) => key), []);
  assert.equal(filled.report_status, snapshot.lineCount);
});

// 原本の参照の3つの経路の売上と、保存先から作った期待値（原本の参照・加工の記録・加工日時・原本のファイル名・取込日時）
async function sourceRouteSales() {
  const q = (sql, key) => db.all(sql, [orgId, key]);
  const {mapping, workflow, source} = SOURCE_ROUTE_REPORTS;
  const routes = [
    ['mapping', mapping, await q(`SELECT s.id AS sale_id,r.id AS report_id,r.created_at AS imported_at,m.mapping_version_id,m.created_at AS processed_at FROM sale_lines s
      JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN mapping_import_provenance m ON m.org_id=r.org_id AND m.report_id=r.id
      WHERE s.org_id=? AND r.report_key=? ORDER BY s.source_row`, mapping.reportKey),
    (row) => ({source_reference_id: `mapping:report:${row.report_id}:version:${row.mapping_version_id}`, processing_id: `列対応の版 ${row.mapping_version_id}`, source_file: null})],
    ['workflow', workflow, await q(`SELECT s.id AS sale_id,r.id AS report_id,r.created_at AS imported_at,c.artifact_id,c.mapping_version_id,c.committed_at AS processed_at,a.file_name FROM sale_lines s
      JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN workflow_report_commits c ON c.org_id=r.org_id AND c.report_id=r.id
      JOIN workflow_raw_artifacts a ON a.org_id=c.org_id AND a.id=c.artifact_id WHERE s.org_id=? AND r.report_key=? ORDER BY s.source_row`, workflow.reportKey),
    (row) => ({source_reference_id: `workflow:artifact:${row.artifact_id}:mapping:${row.mapping_version_id}`, processing_id: `原本 ${row.artifact_id}・列対応の版 ${row.mapping_version_id}`,
      source_file: workflow.fileName})],
    ['source', source, await q(`SELECT s.id AS sale_id,r.id AS report_id,r.created_at AS imported_at,c.file_id,c.partition_id,c.mapping_version_id,p.created_at AS processed_at,f.file_name FROM sale_lines s
      JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN sales_source_commits c ON c.org_id=r.org_id AND c.report_id=r.id
      JOIN sales_source_partitions p ON p.org_id=c.org_id AND p.id=c.partition_id JOIN sales_source_files f ON f.org_id=c.org_id AND f.id=c.file_id
      WHERE s.org_id=? AND r.report_key=? ORDER BY s.source_row`, source.reportKey),
    (row) => ({source_reference_id: `source:file:${row.file_id}:partition:${row.partition_id}:mapping:${row.mapping_version_id}`,
      processing_id: `原本の分割 ${row.partition_id}・列対応の版 ${row.mapping_version_id}`, source_file: source.fileName})],
  ];
  return routes.flatMap(([name, route, rows, expected]) => {
    assert.equal(rows.length, route.rows.length, `${name} の売上の件数`);
    return rows.map((row) => ({name, route, row, expected: {...expected(row), processed_at: row.processed_at, imported_at: row.imported_at, import_id: Number(row.report_id)}}));
  });
}

test('G-2 #75 加工の記録は、原本の追跡用参照（source_reference_id）の言い換えで、3つの経路の売上の応答の値と同じ。読めない参照は空', async () => {
  for (const {name, row, expected} of await sourceRouteSales()) {
    const {values} = await api.get(`/sales-sheet/sales/${row.sale_id}`);
    assert.equal(values.source_reference_id, expected.source_reference_id, name);
    assert.equal(values.processing_id, expected.processing_id, name);
    assert.equal(processingIdOf(values.source_reference_id), values.processing_id, `${name}: 消す列は残す列の純関数`);
  }
  assert.deepEqual(['', null, 'other:1', 'mapping:report:x:version:1'].map(processingIdOf), [null, null, null, null]);
});

test('G-2 外す拡張属性の列（#59・64・65・72・73・82）の値は、シートに出ていた値と sale_attribute_values の最新の版が同じ', async (t) => {
  const old = await oldOrg(t);
  const [saleId] = await addSales(old.db, old.admin, old.orgId, ['2026-04']);
  await addRemovedAttributeValues(old.admin, saleId);
  const {rows} = await sheetDetail(old.admin, ['sale_id', ...REMOVED_ATTRIBUTE_KEYS]);
  const {__id, ...shown} = rows.find((row) => row.sale_id === saleId);
  assert.equal(__id, saleId);
  const stored = new Map((await latestAttributeValues(old.db, old.orgId)).filter((row) => Number(row.sale_id) === saleId).map((row) => [row.column_key, row]));
  assert.deepEqual(shown, {
    sale_id: saleId, theatre_unit_inc_tax: Number(stored.get('theatre_unit_inc_tax').value_number), ticket_audience: stored.get('ticket_audience').value_text,
    ticket_campaign: Number(stored.get('ticket_campaign').value_number) === 1, advance_guarantee_month: Number(stored.get('advance_guarantee_month').value_number),
    maker_paid_total: Number(stored.get('maker_paid_total').value_number), update_reason: stored.get('update_reason').value_text,
  });
  assert.deepEqual(shown, {sale_id: saleId, theatre_unit_inc_tax: 1980, ticket_audience: '一般の大人（架空）', ticket_campaign: true, advance_guarantee_month: 50000,
    maker_paid_total: 120000, update_reason: '報告の差し替え（架空）'});
});

test('G-2 ロイヤリティ計上の3列と外貨のロイヤリティ計上額は、額が売上と違う版でも版の表（sale_royalty_basis_versions・sale_currency_versions）の値を出す', async (t) => {
  const org = await royaltyOrg(t);
  const rows = await detailById(org.admin, ['amount_ex_tax', 'tax_amount', 'amount_inc_tax', ...PLAN.royalty]);
  const basis = await org.db.get('SELECT royalty_amount_ex_tax,royalty_tax_amount,royalty_amount_inc_tax FROM sale_royalty_basis_versions WHERE org_id=? AND sale_id=? ORDER BY version_no DESC LIMIT 1',
    [org.orgId, org.first]);
  const cur = await org.db.get('SELECT original_amount_x100,original_royalty_x100 FROM sale_currency_versions WHERE org_id=? AND sale_id=? ORDER BY version_no DESC LIMIT 1', [org.orgId, org.first]);
  const row = rows.get(org.first);
  assert.deepEqual({ex: row.royalty_amount_ex_tax, tax: row.royalty_tax_amount, inc: row.royalty_amount_inc_tax},
    {ex: Number(basis.royalty_amount_ex_tax), tax: Number(basis.royalty_tax_amount), inc: Number(basis.royalty_amount_inc_tax)});
  assert.deepEqual({ex: row.royalty_amount_ex_tax, tax: row.royalty_tax_amount, inc: row.royalty_amount_inc_tax},
    {ex: ROYALTY_MISMATCH.exTax, tax: ROYALTY_MISMATCH.tax, inc: ROYALTY_MISMATCH.exTax + ROYALTY_MISMATCH.tax});
  assert.notDeepEqual([row.royalty_amount_ex_tax, row.royalty_tax_amount, row.royalty_amount_inc_tax], [row.amount_ex_tax, row.tax_amount, row.amount_inc_tax], '売上の額ではない');
  assert.equal(scaled2(row.foreign_royalty_amount), Number(cur.original_royalty_x100));
  assert.equal(scaled2(row.foreign_royalty_amount), scaledInteger(ROYALTY_MISMATCH.foreignRoyalty, 2));
  assert.notEqual(Number(cur.original_royalty_x100), Number(cur.original_amount_x100), '外貨の計上額ではない');
});

test('G-2 h_theatre_inc_amount は、拡張属性の劇場別の単価（税込）と動員数（theatrical_sale_details）の積で、保存先から作り直せる', async (t) => {
  const old = await oldOrg(t);
  const headers = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'accounting_month', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax',
    'theatrical_model', 'ticket_type_code', 'admissions_count', 'gross_box_office_ex_tax', 'attr_theatre_unit_inc_tax'];
  const preview = await old.admin.post('/imports/preview', {kind: 'theatrical', workId: 1, text: toCsv(headers, [
    ['G2-THR', 1, '', '2026-04-01', '2026-04-30', '2026-04', '劇場 一般 2026-04（架空）', '', 81000, 8100, 89100, 'theatrical_rs', '一般', 75, 180000, '1800.5'],
  ])});
  await old.admin.post('/imports/commit', {token: preview.token});
  const sale = await old.db.get(`SELECT s.id,t.admissions_count FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    JOIN theatrical_sale_details t ON t.org_id=s.org_id AND t.sale_id=s.id WHERE s.org_id=? AND r.report_key='G2-THR'`, [old.orgId]);
  const stored = await old.db.get("SELECT value_number FROM sale_attribute_values WHERE org_id=? AND sale_id=? AND column_key='theatre_unit_inc_tax' ORDER BY version_no DESC LIMIT 1",
    [old.orgId, sale.id]);
  const row = (await detailById(old.admin, ['h_theatre_inc_amount', 'theatre_unit_inc_tax', 'admissions'])).get(Number(sale.id));
  const expected = BigInt(scaledInteger(String(stored.value_number), 2)) * BigInt(sale.admissions_count);
  assert.equal(scaled2(row.h_theatre_inc_amount), Number(expected));
  assert.equal(expected, 13503750n, '1,800.50 円 × 75 人 ＝ 135,037.50 円（×100 で 13,503,750）');
});

// 統合前の main で作った再現表の各列の値が、いまの辞書（新しい辞書）の列で全行再現できる。止めた列（裁定3）は除いてよいが、それ以外が外れたら失敗する
async function assertLegacyReproduced(client, {stoppedRoyalty}) {
  const dictionary = registry.SHEET_COLUMNS;
  assert.ok(Array.isArray(dictionary), 'src/sales-sheet/column-registry.mjs が唯一の辞書 SHEET_COLUMNS を出していない（#2a）');
  const byKey = new Map(dictionary.map((c) => [c.key, c]));
  assert.deepEqual(legacy.entries.map((e) => e.key).filter((key) => !byKey.has(key)), [], '旧131エントリはどれも辞書に残る（removed・retired_by の印つきで）');
  assert.deepEqual(sortStrings(dictionary.filter((c) => c.removed).map((c) => c.key)), sortStrings(PLAN.removed), '再現できない（保存先で読む）列が「消」と一致');
  const destinationOf = (key) => {
    let column = byKey.get(key);
    for (const seen = new Set(); column?.retired_by && !seen.has(column.key);) { seen.add(column.key); column = byKey.get(column.retired_by); }
    return column;
  };
  const catalog = new Map((await client.get('/sales-sheet/columns')).columns.map((c) => [c.key, c]));
  const candidates = legacy.entries.filter((e) => !PLAN.removed.includes(e.key) && !e.separated).map((e) => ({legacy: e.key, destination: destinationOf(e.key)?.key}));
  const excluded = candidates.filter(({destination}) => !catalog.get(destination)?.active).map((x) => x.legacy);
  assert.deepEqual(sortStrings(excluded), stoppedRoyalty ? sortStrings(PLAN.royalty) : [], '有効でない行き先は、止めた裁定3の列だけ（保存先で読む。上の G-2）');
  const targets = candidates.filter(({legacy: key}) => !excluded.includes(key));
  assert.deepEqual(targets.filter((x) => x.destination !== x.legacy).map((x) => `${x.legacy}→${x.destination}`), [],
    '行き先が旧キーと違う列（PR C の reported_*）は、行き先の値から旧キーの値を出す関数をこの試験に足す');
  const {rows} = await sheetDetail(client, [...new Set([...targets.map((x) => x.destination), 'row_fingerprint'])]);
  assert.equal(rows.length, legacyRows.length);
  for (const row of rows) {
    const old = legacyByFingerprint.get(row.row_fingerprint);
    assert.ok(old, `再現表に ${row.row_fingerprint} がある`);
    for (const {legacy: key, destination} of targets) assert.deepEqual(maskVolatile(key, row[destination]), old[key], `${key}（売上 ${old.sale_id}）`);
  }
}

// ---------- G-3 掘り下げ ----------
test('G-3 どの列セットの明細も売上IDを持ち、売上1件の応答から 取込の記録・原本の行番号・報告番号・行の照合値・原本のファイル名 の列まで降りられる', async () => {
  const sets = Object.keys(catalogV1.sets);
  assert.ok(sets.length >= 10);
  for (const set of sets) {
    const body = await api.get(`/sales-sheet?${query({set, grain: 'detail', pageSize: 10, summary: '0'})}`);
    assert.equal(body.rows.length, 10, set);
    for (const row of body.rows) assert.ok(Number.isSafeInteger(row.__id) && row.__id > 0, `${set} の行の売上ID`);
    const one = await api.get(`/sales-sheet/sales/${body.rows[0].__id}`);
    for (const key of TRACE_KEYS) assert.ok(Object.hasOwn(one.values, key), `${set}: 売上1件の応答に ${key}`);
    const old = legacyByFingerprint.get(one.values.row_fingerprint);
    assert.ok(old, `${set}: 行の照合値で再現表の行に着く`);
    assert.deepEqual(TRACE_KEYS.slice(1).map((key) => one.values[key]), TRACE_KEYS.slice(1).map((key) => old[key]), set);
    for (const key of ['import_id', 'source_row_number', 'report_number', 'row_fingerprint']) assert.notEqual(one.values[key], null, `${set}: ${key}`);
  }
});

test('G-3 原本の3つの経路（列対応・原本の選択・原本の分割）の売上は、売上1件の応答から原本の参照・加工の記録と日時・原本のファイル名まで降りられ、値は保存先と同じ', async () => {
  const seen = new Set();
  for (const {name, route, row, expected} of await sourceRouteSales()) {
    const {values} = await api.get(`/sales-sheet/sales/${row.sale_id}`);
    assert.deepEqual(Object.fromEntries(['import_id', ...SOURCE_KEYS].map((key) => [key, values[key]])), {import_id: expected.import_id,
      ...Object.fromEntries(SOURCE_KEYS.map((key) => [key, expected[key]]))}, `${name}（売上 ${row.sale_id}）`);
    for (const key of ['processed_at', 'imported_at']) assert.match(values[key], TIMESTAMP, `${name}: ${key} は日時`);
    assert.equal(values.report_number, route.reportKey, name);
    assert.ok(Number.isSafeInteger(values.source_row_number), `${name}: 原本の行番号`);
    if (name !== 'mapping') assert.notEqual(values.source_file, null, `${name}: 原本のファイル名`);
    // 再現表（統合前）の行とも同じ（時刻は印で比べる）
    const old = legacyByFingerprint.get(values.row_fingerprint);
    assert.ok(old, `${name}: 再現表の行に着く`);
    assert.deepEqual([...TRACE_KEYS.slice(1), ...SOURCE_KEYS].map((key) => maskVolatile(key, values[key])), [...TRACE_KEYS.slice(1), ...SOURCE_KEYS].map((key) => old[key]), name);
    seen.add(name);
  }
  assert.deepEqual(sortStrings(seen), ['mapping', 'source', 'workflow']);
});

// 集計の切り口から、絞り込みで明細を開く（画面の絞り込みと同じ URL の条件）
const DRILL_FILTERS = {
  partner: async () => {
    const partners = new Map((await db.all('SELECT id,code FROM partners WHERE org_id=?', [orgId])).map((row) => [row.code, Number(row.id)]));
    return (key) => ({partnerId: partners.get(key)});
  },
  distribution: async () => (key) => ({distribution: key}),
  product: async () => {
    const products = new Map((await db.all('SELECT id,sku FROM products WHERE org_id=?', [orgId])).map((row) => [row.sku, Number(row.id)]));
    return (key) => ({productId: key === '' ? 'none' : products.get(key)});
  },
};
async function drillByFilter(dim, filterOf) {
  const groups = await sheetAggregate(api, {dims: dim, columns: 'amount_ex_tax'});
  assert.ok(groups.rows.length >= 2, dim);
  let lines = 0;
  for (const group of groups.rows) {
    const key = group[`dimkey_${dim}`];
    const {rows, total} = await sheetDetail(api, ['sale_id', 'import_id', 'amount_ex_tax'], filterOf(key));
    assert.equal(total, group.__count, `${dim} ${key} の件数`);
    assert.equal(rows.reduce((n, row) => n + row.amount_ex_tax, 0), group.amount_ex_tax, `${dim} ${key} の計上額`);
    for (const row of rows) assert.ok(row.sale_id > 0 && row.import_id > 0, `${dim} ${key} の明細から取込の記録へ`);
    lines += total;
  }
  assert.equal(lines, snapshot.lineCount, `${dim} の切り口で全明細に降りられる`);
}
test('G-3 取引先・流通区分・商品の切り口の集計から、絞り込みで開いた明細は件数と計上額の合計が集計と一致し、取込の記録まで降りられる', async () => {
  for (const [dim, make] of Object.entries(DRILL_FILTERS)) await drillByFilter(dim, await make());
});

// 絞り込みの無い切り口は、明細の同じ値の列で束ねて、集計の行と同じ件数・計上額になることを確かめる（列から明細に降りられる）
const DRILL_COLUMNS = {
  work: {columns: ['work_code'], key: (row) => row.work_code},
  method: {columns: ['ref_transaction_method'], key: (row) => row.ref_transaction_method ?? ''},
  sales_type: {columns: ['ref_sales_type'], key: (row) => row.ref_sales_type ?? ''},
  currency: {columns: ['currency_code'], key: (row) => row.currency_code},
  mg: {columns: ['mg_group'], key: (row) => row.mg_group ?? ''},
  ticket: {columns: ['ticket_name', 'ticket_category'], key: (row) => row.ticket_name ?? row.ticket_category ?? ''},
};
test('G-3 作品・取引方法・販売種別・通貨・最低保証・券種の切り口の集計は、明細を同じ列で束ねた件数と計上額に一致する（列から明細と取込の記録へ降りられる）', async () => {
  for (const [dim, {columns, key}] of Object.entries(DRILL_COLUMNS)) {
    const groups = await sheetAggregate(api, {dims: dim, columns: 'amount_ex_tax'});
    const {rows} = await sheetDetail(api, ['sale_id', 'import_id', 'amount_ex_tax', ...columns]);
    const byKey = new Map();
    for (const row of rows) {
      assert.ok(row.sale_id > 0 && row.import_id > 0, `${dim}: 明細から取込の記録へ`);
      const k = key(row);
      const sums = byKey.get(k) ?? {count: 0, amount: 0};
      byKey.set(k, {count: sums.count + 1, amount: sums.amount + row.amount_ex_tax});
    }
    assert.ok(groups.rows.length >= 2, `${dim} の切り口が2つ以上`);
    assert.deepEqual(new Map(groups.rows.map((group) => [group[`dimkey_${dim}`], {count: group.__count, amount: group.amount_ex_tax}])), byKey, dim);
  }
});

// 既知の不具合（統合の前から）: 作品の切り口は明細の作品（sale_lines.work_id）で束ねるが、作品の絞り込み（workId）は商品の配賦先の作品の明細も含める
// （DEMO-BOX-W01W02 は DEMO-W01・DEMO-W02 の両方に配賦）。集計の DEMO-W02 から作品の絞り込みで開くと、DEMO-W01 の明細の配賦分も出て件数が合わない。
// 直し方（絞り込みを明細の作品だけにする・切り口を配賦先まで含める・画面の掘り下げを作品コードの列で行う）は、代表か計画の持ち主の裁定待ち
test('G-3 既知の不具合: 作品の切り口の集計から作品の絞り込み（workId）で開いた明細は、件数と計上額が集計と一致する',
  {todo: '既知の不具合（統合の前から）。作品の絞り込みは配賦先の作品の明細も含むので件数が合わない。直し方は代表か計画の持ち主の裁定待ち'}, async () => {
    const works = new Map((await db.all('SELECT id,code FROM works WHERE org_id=?', [orgId])).map((row) => [row.code, Number(row.id)]));
    await drillByFilter('work', (key) => ({workId: works.get(key)}));
  });

// ---------- G-4 版つきの値 ----------
test('G-4 流通分類・ロイヤリティ計上・為替・計上根拠の列は版の表から読み、取り方（source_ref）が統合前と同じ', async () => {
  const columns = new Map((await api.get('/sales-sheet/columns')).columns.map((c) => [c.key, c]));
  for (const key of VERSIONED_SOURCES) {
    const before = v1ByKey.get(key);
    assert.ok(before, key);
    assert.deepEqual({kind: columns.get(key)?.sourceKind, ref: columns.get(key)?.sourceRef}, {kind: before.source_kind, ref: before.source_ref}, key);
    assert.match(before.source_ref, /^(dist|royalty|currency|recognition)\./, key);
  }
  const {rows} = await sheetDetail(api, ['booking_month', 'royalty_month', 'royalty_basis_version', 'distribution_version', 'distribution_code']);
  assert.equal(rows.filter((row) => row.royalty_month !== row.booking_month).length, 2, 'ロイヤリティ計上月を変えた明細');
  assert.equal(rows.filter((row) => row.distribution_version === null).length, 1, '分類の無い明細だけ版が空');
});

test('G-4 版を2つ持つ売上は最新の版の値を出し（流通分類・ロイヤリティ計上・為替）、訂正した報告の明細は訂正後の報告の値と出所を出す', async () => {
  const one = async (saleId) => (await api.get(`/sales-sheet/sales/${saleId}`)).values;
  const latestOf = (table, saleId) => db.all(`SELECT * FROM ${table} WHERE org_id=? AND sale_id=? ORDER BY version_no DESC`, [orgId, saleId]);
  // 流通分類: 都度課金（D004）と誤って分類し、購入型（D003）に直した売上
  const reclassified = CHANNEL_DETAIL_REPORTS.find((report) => report.reclassify);
  const est = await one(await saleOf(db, orgId, reclassified.reportKey));
  const distVersions = await latestOf('sale_distribution_versions', est.sale_id);
  assert.deepEqual(distVersions.map((row) => [Number(row.version_no), row.distribution_code]), [[2, reclassified.reclassify.code], [1, reclassified.code]]);
  assert.deepEqual({code: est.distribution_code, version: est.distribution_version, salesType: est.ref_sales_type}, {code: reclassified.reclassify.code, version: 2, salesType: 'EST'});
  // ロイヤリティ計上: 版2で月を翌々月に直した売上（版1は翌月）
  const twice = await db.all('SELECT sale_id FROM sale_royalty_basis_versions WHERE org_id=? GROUP BY sale_id HAVING MAX(version_no)=2', [orgId]);
  assert.equal(twice.length, 1);
  const royaltySale = await one(Number(twice[0].sale_id));
  const [royaltyV2, royaltyV1] = await latestOf('sale_royalty_basis_versions', royaltySale.sale_id);
  assert.notEqual(royaltyV2.royalty_month, royaltyV1.royalty_month);
  assert.deepEqual({month: royaltySale.royalty_month, version: royaltySale.royalty_basis_version, origin: royaltySale.royalty_basis_origin},
    {month: royaltyV2.royalty_month, version: 2, origin: '独立した基準'});
  // 為替: 版2で外貨のロイヤリティ計上額を足した売上
  const currencyTwice = await db.all('SELECT sale_id FROM sale_currency_versions WHERE org_id=? GROUP BY sale_id HAVING MAX(version_no)=2', [orgId]);
  assert.equal(currencyTwice.length, 1);
  const currencySale = await one(Number(currencyTwice[0].sale_id));
  const [currencyV2, currencyV1] = await latestOf('sale_currency_versions', currencySale.sale_id);
  assert.equal(currencyV1.original_royalty_x100, null);
  assert.deepEqual({version: currencySale.currency_version, royalty: scaled2(currencySale.foreign_royalty_amount)}, {version: 2, royalty: Number(currencyV2.original_royalty_x100)});
  // 訂正: 訂正後の報告の明細だけが出て、訂正元の報告・版・登録の種類を持つ
  const {corrected} = REVISION_REPORTS;
  const reports = await db.all('SELECT id,status,supersedes_id FROM report_imports WHERE org_id=? AND report_key=? ORDER BY id', [orgId, corrected.reportKey]);
  assert.deepEqual(reports.map((r) => r.status), ['superseded', 'active']);
  const {rows} = await sheetDetail(api, ['report_number', 'import_id', 'supersedes_report_id', 'registration_kind', 'record_version', 'raw_quantity', 'amount_ex_tax'], {q: corrected.reportKey});
  assert.deepEqual(rows.map(({report_number, import_id, supersedes_report_id, registration_kind, record_version}) => ({report_number, import_id, supersedes_report_id, registration_kind, record_version})),
    corrected.rows.map(() => ({report_number: corrected.reportKey, import_id: Number(reports[1].id), supersedes_report_id: Number(reports[0].id), registration_kind: '訂正', record_version: 2})));
  assert.deepEqual(sortStrings(rows.map((row) => `${row.raw_quantity}:${row.amount_ex_tax}`)), sortStrings(corrected.rows.map((r) => `${r.qty}:${r.ex}`)), '訂正後の数量と額');
});

// ---------- G-5 比率・単価 ----------
test('G-5 単価・料率・税率・為替レートは分子と分母の列を持ち、#20・#26・#39・#46 の集計値が統合前と同じ', async () => {
  const columns = new Map((await api.get('/sales-sheet/columns')).columns.map((c) => [c.key, c]));
  for (const key of [...RATIO_COLUMNS, 'tax_rate', ...PLAN.rates, 'rental_turnover']) {
    const column = columns.get(key);
    assert.equal(column?.aggregation, 'ratio', key);
    for (const part of [column.numeratorKey, column.denominatorKey]) assert.ok(columns.get(part)?.active, `${key} の ${part}`);
  }
  assert.deepEqual(await dimensionTable(api, ['partner', 'distribution'], RATIO_COLUMNS), snapshot.ratios.byPartnerDistribution);
  assert.deepEqual(await dimensionTable(api, ['currency'], ['exchange_rate', 'foreign_amount']), snapshot.ratios.byCurrency);
});

test('G-5 行の単価は報告の単価、集計の単価は分子の合計÷分母の合計で、2つは別の値（都度課金の当社単価 280 と 300、定額制の当社単価 5 と 12.5）', async () => {
  const tvodReport = CHANNEL_DETAIL_REPORTS.find((r) => r.reportKey.includes('TVOD')), svodReport = CHANNEL_DETAIL_REPORTS.find((r) => r.reportKey.includes('SVOD'));
  const [tvod] = tvodReport.rows, [svod] = svodReport.rows;
  const [, , salesCount, partnerUnit, holderUnit] = tvod.extra, [, , viewCount, viewSeconds, vodUnit] = svod.extra;
  // 入力の当社単価は 計上額÷件数 と違う値（同じだと2つの取り違えが落ちない）
  assert.notEqual(holderUnit, tvod.ex / salesCount);
  assert.notEqual(Number(vodUnit), svod.ex / viewCount);
  const {rows} = await sheetDetail(api, ['line_note', 'rs_holder_unit_ex_tax', 'rs_partner_unit_ex_tax', 'vod_unit_ex_tax', 'view_hours']);
  const one = (desc) => rows.find((row) => row.line_note === desc);
  assert.deepEqual({holder: one(tvod.desc).rs_holder_unit_ex_tax, partner: one(tvod.desc).rs_partner_unit_ex_tax}, {holder: holderUnit, partner: partnerUnit});
  assert.deepEqual({vod: one(svod.desc).vod_unit_ex_tax, hours: one(svod.desc).view_hours}, {vod: Number(vodUnit), hours: viewSeconds / 3600});
  // 報告番号の語句で、その1明細だけの集計にする
  const aggregateOf = async (reportKey, columns) => {
    const body = await sheetAggregate(api, {dims: 'partner', columns: columns.join(','), q: reportKey});
    assert.equal(body.rows.length, 1, reportKey);
    assert.equal(body.rows[0].__count, 1, reportKey);
    return body.rows[0];
  };
  const tvodGroup = await aggregateOf(tvodReport.reportKey, ['rs_holder_unit_ex_tax', 'rs_partner_unit_ex_tax']);
  assert.deepEqual({holder: tvodGroup.rs_holder_unit_ex_tax, partner: tvodGroup.rs_partner_unit_ex_tax}, {holder: tvod.ex / salesCount, partner: partnerUnit});
  assert.equal((await aggregateOf(svodReport.reportKey, ['vod_unit_ex_tax'])).vod_unit_ex_tax, svod.ex / viewCount);
});

// ---------- G-6 出所 ----------
test('G-6 出所の列（取込の記録・原本の行番号・訂正元の報告・版番号・行の照合値）が辞書にあり、監査の列セットの出所の列は外れない', async () => {
  const body = await api.get('/sales-sheet/columns');
  const columns = new Map(body.columns.map((c) => [c.key, c]));
  for (const key of PROVENANCE_KEYS) assert.equal(columns.get(key)?.active, true, key);
  const audit = body.sets.find((set) => set.key === 'audit').columns;
  for (const key of AUDIT_PROVENANCE) assert.ok(audit.includes(key), `監査の列セットに ${key}`);
  for (const key of AUDIT_PROVENANCE) assert.ok(catalogV1.sets.audit.includes(key), `統合前の監査の列セットにも ${key}`);
});

// ---------- G-7 事前 ----------
// 架空データの拡張属性の値の数: seed-all-demo の節の 166 と、fixture の道具が足した値（取込の列 attr_… と手入力）。keep で数えるキーを絞る
const addedAttributeValues = (keep = () => true) => CHANNEL_DETAIL_REPORTS.reduce((n, report) => n + report.rows.reduce((m, row) => m
  + report.headers.filter((header, i) => header.startsWith('attr_') && keep(header.slice('attr_'.length)) && row.extra[i] !== '').length, 0), 0)
  + MANUAL_ATTRIBUTES.reduce((n, item) => n + Object.keys(item.values).filter(keep).length, 0);
const ADDED_ATTRIBUTE_VALUES = addedAttributeValues();
test('G-7 架空データで、1売上に料率キーが2つ以上ある売上・料率のキーと流通のまとまりが食い違う売上・新しい表の型で表せない値・裁定3の食い違いが0件', async () => {
  const result = await checkOrganization(db, orgId);
  assert.equal(result.saleLines, snapshot.lineCount + REVISION_REPORTS.corrected.before.length + REVISION_REPORTS.voided.rows.length, '訂正前・取消の報告の売上も数える');
  assert.deepEqual({rateKeys: result.rateKeys.count, rateBlocks: result.rateBlocks.count, unrepresentable: result.unrepresentable.count, royalty: result.royaltyMismatch.count},
    {rateKeys: 0, rateBlocks: 0, unrepresentable: 0, royalty: 0});
  // 0件は空どうしではない: 料率は5つのキーのどれにも値があり（6売上）、裁定2の値（延滞・回転率・視聴UU数・劇場名・券種）もあって、どれも新しい表の型で表せる
  const rates = (await latestAttributeValues(db, orgId)).filter((row) => Object.hasOwn(RATE_KEYS, row.column_key));
  assert.deepEqual(sortStrings(new Set(rates.map((row) => row.column_key))), sortStrings(Object.keys(RATE_KEYS)));
  assert.equal(rates.length, 6);
  assert.equal(result.attributeValues, 166 + ADDED_ATTRIBUTE_VALUES);
  assert.deepEqual(result.attributeOrphans.notInDictionary.count, 0);
  assert.equal(result.attributeOrphans.inRemovedKeys.count, addedAttributeValues((key) => REMOVED_ATTRIBUTE_KEYS.includes(key)), '外す拡張属性のキーの値（seed-all-demo には無い）');
  assert.equal(result.attributeOrphans.inRemovedKeys.count, 9);
});

test('G-7 料率を2キーに入れた行・キーとまとまりが食い違う行・bps で表せない料率では、検査が件数と売上IDを返す', async (t) => {
  const tdb = await openTestDb({t});
  const app = createApp({db: tdb, mode: 'local'});
  const admin = await apiClient(app, ADMIN);
  const org = await orgOf(tdb, ADMIN);
  await admin.post('/sales-sheet/columns/adopt', {reason: REASON});
  const [a, b, c] = await addSales(tdb, admin, org, ['2026-04', '2026-05', '2026-06'], 'G7');
  for (const saleId of [a, b, c]) {
    await admin.post('/report-center/classifications', {saleId, distributionCode: 'D004', baseVersion: 0, territory: '日本', serviceName: null, settlementMethod: 'unverified', reason: '試験の分類（都度課金＝RS）'});
  }
  await admin.post('/sales-sheet/values', {reason: '試験の料率', changes: [
    {saleId: a, columnKey: 'rs_partner_rate', baseVersion: 0, value: '40.125'},
    {saleId: b, columnKey: 'flat_partner_rate', baseVersion: 0, value: '35'}, {saleId: b, columnKey: 'rs_partner_rate', baseVersion: 0, value: '35'},
    {saleId: c, columnKey: 'rs_partner_rate', baseVersion: 0, value: '62.5'},
  ]});
  const result = await checkOrganization(tdb, org);
  assert.deepEqual(result.rateKeys, {count: 1, examples: [b], detail: [{saleId: b, keys: ['flat_partner_rate', 'rs_partner_rate']}]});
  assert.deepEqual(result.rateBlocks, {count: 1, examples: [b], detail: [{saleId: b, key: 'flat_partner_rate', block: 'rs'}]});
  assert.deepEqual(result.unrepresentable, {count: 1, examples: [a], byMetric: {reported_rate_bps: {kind: 'bps', keys: ['rs_partner_rate'], count: 1, examples: [a]}}});
});

test('G-7 検査の純関数: 値を消した版は数えず、キーの重なり・まとまりの食い違い・×100 と整数で表せない値を数える', () => {
  const v = (sale_id, column_key, value_number, value_text = null) => ({sale_id, column_key, value_number, value_text});
  const values = [v(1, 'rs_partner_rate', 40), v(1, 'vod_partner_rate', null), v(2, 'mg_partner_rate', 30), v(2, 'rss_partner_rate', 30), v(3, 'vod_partner_rate', 45),
    v(4, 'rental_turnover', 2.125), v(5, 'rental_turnover', 2.4), v(6, 'unique_viewers', 12.5), v(7, 'overdue_amount', 300), v(8, 'theatre_name', null, '架空劇場')];
  assert.deepEqual(rateKeyConflicts(values), {count: 1, examples: [2], detail: [{saleId: 2, keys: ['mg_partner_rate', 'rss_partner_rate']}]});
  const blocks = new Map([[1, 'rs'], [2, 'mg'], [3, null]]);
  assert.deepEqual(rateBlockMismatches(values, blocks), {count: 2, examples: [2, 3], detail: [{saleId: 2, key: 'rss_partner_rate', block: 'mg'}, {saleId: 3, key: 'vod_partner_rate', block: null}]});
  assert.deepEqual(unrepresentableValues(values), {count: 2, examples: [4, 6], byMetric: {
    rental_turnover_x100: {kind: 'x100', keys: ['rental_turnover'], count: 1, examples: [4]}, viewer_uu_count: {kind: 'integer', keys: ['unique_viewers'], count: 1, examples: [6]}}});
  // PostgreSQL の入口は数を Decimal の文字で返す
  assert.deepEqual(unrepresentableValues([v(9, 'rs_partner_rate', '62.50'), v(10, 'rs_partner_rate', '62.555'), v(11, 'overdue_count', '3.0')]).examples, [10]);
});

test('#1 の --check は架空データの DB だけを数える（組織のコードが架空の形でない・メールが .invalid でない・組織の無い DB は止める）', async () => {
  assert.deepEqual(await fictionalDatabaseProblems(db), []);
  const fake = (orgs, users) => ({all: async (sql) => (/organizations/.test(sql) ? orgs : users)});
  assert.deepEqual(await fictionalDatabaseProblems(fake([{code: 'demo'}, {code: 'ACME'}], [{email: 'admin@openingnight.invalid'}])),
    ['架空データの組織のコード（demo・other・DEMO-…）ではない組織が1件あります']);
  assert.deepEqual(await fictionalDatabaseProblems(fake([{code: 'DEMO-SALES'}], [{email: 'person@example.com'}, {email: 'admin@openingnight.invalid'}])),
    ['メールが .invalid ではない利用者が1人います']);
  assert.deepEqual(await fictionalDatabaseProblems(fake([], [])), ['組織がありません（架空データの seed を入れた DB を指定してください）']);
});

// ---------- G-8 区分未確認 ----------
test('G-8 流通区分の切り口で、区分未確認の明細の額も合計に入る（区分ごとの合計＝全体の合計）', async () => {
  const table = await dimensionTable(api, ['distribution'], ['amount_ex_tax']);
  assert.deepEqual(table, snapshot.byDistribution);
  const amount = table.rows.reduce((n, row) => n + row.at(-1), 0);
  assert.equal(amount, table.totals.amount_ex_tax);
  assert.equal(amount, snapshot.totals.amount_ex_tax);
  const unclassified = table.rows.filter((row) => String(row[1]).startsWith('未分類'));
  assert.equal(unclassified.length, 1);
  assert.equal(unclassified[0][2], 1, '区分未確認の明細は1件');
  assert.equal(table.unclassifiedCount, 1);
});

// ---------- G-9 旧キーの参照 ----------
const activeKeysOf = async (client) => new Set((await client.get('/sales-sheet/columns')).columns.filter((c) => c.active).map((c) => c.key));
async function oldKeysStillWork(client) {
  const context = await client.get('/sales-import/context');
  assert.deepEqual(Object.keys(context).sort(), catalogV1.api.importContext, '/sales-import/context の項目名');
  const columnsBody = await client.get('/sales-sheet/columns');
  for (const key of catalogV1.api.columns) assert.ok(Object.hasOwn(columnsBody, key), `/sales-sheet/columns の ${key}`);
  assert.deepEqual(await savedViewResults(client), snapshot.views, '保存した形（旧キーの列）');
  assert.deepEqual(await dimensionTable(client, ['ticket'], ['amount_ex_tax']), snapshot.byTicket, '切り口 ticket');
  const active = await activeKeysOf(client);
  const all = columnsBody.sets.find((set) => set.key === 'all').columns;
  for (const set of ['additional', 'all_plus']) {
    const body = await client.get(`/sales-sheet?${query({set, grain: 'detail', pageSize: 10, summary: '0'})}`);
    assert.equal(body.rows.length, 10, `URL の set=${set} で明細が出る`);
    assertAliasSet(body.selected, set, active, all);
    assert.deepEqual(columnsBody.sets.find((item) => item.key === set).columns, all, `列カタログの ${set}`);
  }
  const keys = ['theatre_name', 'ticket_category', 'ticket_unit_inc_tax', 'rs_count', 'overdue_count', 'unique_viewers'];
  const url = await client.get(`/sales-sheet?${query({columns: keys.join(','), grain: 'detail', kind: 'theatrical', distribution: 'H001', pageSize: 10, summary: '0'})}`);
  assert.deepEqual(url.selected, keys, 'URL の columns に旧キー');
}
test('G-9 取込の文脈の項目名・保存した形・券種の切り口・URL の旧キーが統合前と同じに動き、列セット名（additional・all_plus）は全列の別名で動く', async () => {
  await oldKeysStillWork(api);
});

test('G-9 #2a で緑にする: 外した拡張属性のキーの列対応は、取込で読み飛ばして件数を返し（取込は成功）、前の値は sale_attribute_values に残る', async (t) => {
  const old = await oldOrg(t);
  const [saleId] = await addSales(old.db, old.admin, old.orgId, ['2026-04'], 'G9');
  await addRemovedAttributeValues(old.admin, saleId);
  const before = await latestAttributeValues(old.db, old.orgId);
  const out = await adoptV2(old.admin);
  assertAdopted(out);
  const headers = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'accounting_month', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax',
    'attr_ticket_audience', 'attr_update_reason'];
  const preview = await old.admin.raw('POST', '/imports/preview', {kind: 'digital', workId: 1, text: toCsv(headers, [['G9-IMPORT', 2, 1, '2026-05-01', '2026-05-31', '2026-05', '外した列の列対応（架空）', '',
    20000, 2000, 22000, '学生（架空）', '列を外した後の値（架空）']])});
  assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 400));
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body.errors));
  const skipped = skippedAttributes(preview.body);
  assert.deepEqual(skipped.map((item) => [item.k, item.skipped]), [['ticket_audience', 'removed'], ['update_reason', 'removed']], `読み飛ばした2件を返す: ${JSON.stringify(preview.body).slice(0, 400)}`);
  for (const item of skipped) assert.match(item.warning, new RegExp(`attr_${item.k}.*読み飛ばしました`));
  const commit = await old.admin.raw('POST', '/imports/commit', {token: preview.body.token});
  assert.equal(commit.status, 200, JSON.stringify(commit.body).slice(0, 400));
  assert.deepEqual(await latestAttributeValues(old.db, old.orgId), before, '値は残り、取込で足されない');
});

test('G-9 #2a で緑にする: 辞書から外した列でも拡張属性でない列（#75 加工の記録）の列対応 attr_processing_id は読み飛ばさず、取込の確認でその行のエラーにする', async (t) => {
  const old = await oldOrg(t);
  assertAdopted(await adoptV2(old.admin));
  assert.deepEqual((await latestColumns(old.db, old.orgId)).get('processing_id'), {version: 2, active: false, sourceKind: 'core'}, '外した列（登録済みの表から作る列）');
  const headers = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'accounting_month', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax',
    'attr_processing_id'];
  const preview = await old.admin.raw('POST', '/imports/preview', {kind: 'digital', workId: 1, text: toCsv(headers, [['G9-CORE', 2, 1, '2026-05-01', '2026-05-31', '2026-05', '外した登録済みの列の列対応（架空）', '',
    20000, 2000, 22000, '加工の記録（架空）']])});
  assert.equal(preview.status, 200, show(preview));
  assert.equal(preview.body.ok, false);
  assert.deepEqual(preview.body.errors.map((e) => e.message), [`${v1ByKey.get('processing_id').label}（attr_processing_id）は拡張属性の列ではありません`]);
  assert.deepEqual(skippedAttributes(preview.body), [], '読み飛ばさない');
});

// ---------- G-10 採用の入口 ----------
test('G-10 #2a で緑にする: adopt-v2 は管理者だけ・未採用は 409・外す列に active=0 の版・残す列は有効・2回目は版が増えない', async (t) => {
  const old = await oldOrg(t);
  const editor = await apiClient(old.app, EDITOR);
  assert.equal((await adoptV2(editor)).status, 403, '管理者以外');
  const other = await apiClient(old.app, OTHER_ADMIN);
  assert.equal((await adoptV2(other)).status, 409, '列を採用していない組織');
  const before = await latestColumns(old.db, old.orgId);
  const first = await adoptV2(old.admin);
  assertAdopted(first);
  const after = await latestColumns(old.db, old.orgId);
  for (const key of PLAN.removed) assert.deepEqual(after.get(key), {...before.get(key), version: before.get(key).version + 1, active: false}, `外す列 ${key}`);
  // 退役キー（retired_by）の active=0 は、retired_by を持つ列が辞書に入る PR C の試験（下の todo）で確かめる
  for (const key of expectedV2Active()) assert.equal(after.get(key)?.active, true, `残す列 ${key}`);
  assert.equal(first.status, 201, '版を足した呼び出し');
  const count = await versionCount(old.db, old.orgId);
  const audits = await auditCount(old.db, old.orgId);
  const second = await adoptV2(old.admin);
  assert.equal(second.status, 200, `2回目は何も足さない: ${show(second)}`);
  assert.deepEqual({adopted: second.body.adopted, added: second.body.added, updated: second.body.updated, deactivated: second.body.deactivated},
    {adopted: 0, added: [], updated: [], deactivated: []});
  assert.equal(await versionCount(old.db, old.orgId), count, '2回目は版を足さない');
  assert.equal(await auditCount(old.db, old.orgId), audits, '2回目は監査の記録も足さない');
});

// 取り方の4項目（value_type・source_kind・source_ref・legacy_position）のどれかが辞書と違う列。どれも line_note（#53 明細名）を変えた組織で確かめる
const MISMATCHED_DEFINITIONS = Object.freeze([
  ['source_ref', (c) => ({...c, source_ref: 'report.key'})],
  ['value_type', (c) => ({...c, value_type: 'integer'})],
  ['source_kind', (c) => ({...c, source_kind: 'derived'})],
  ['legacy_position', (c) => ({...c, legacy_position: null})],
]);
test('G-10 #2a で緑にする: 取り方（value_type・source_kind・source_ref・legacy_position）が辞書と違うキーは、どれも 409 で名指しし、版を足さない', async (t) => {
  for (const [item, change] of MISMATCHED_DEFINITIONS) {
    const old = await oldOrg(t, {mutate: (c) => (c.column_key === 'line_note' ? change(c) : c)});
    const count = await versionCount(old.db, old.orgId);
    const out = await adoptV2(old.admin);
    assert.equal(out.status, 409, `${item}: ${show(out)}`);
    assert.match(JSON.stringify(out.body), /line_note/, item);
    assert.equal(await versionCount(old.db, old.orgId), count, item);
  }
});

test('G-10 #2a で緑にする: 新しい見出しが既存の列の見出しと NFKC で重なると 409 で名指しし、版を足さない', async (t) => {
  const old = await oldOrg(t);
  // 計画の対応表で #10 flat_deal_ex_tax の見出しは「契約額（配信の定額）」になる。管理者が括弧だけ半角の列を先に足していた組織（NFKC で同じ見出し）
  await old.admin.post('/sales-sheet/columns', {columnKey: 'contract_note', label: '契約額(配信の定額)', groupKey: 'custom', valueType: 'text', aggregation: 'distinct', sourceKind: 'attribute',
    reason: '管理者が足した列（架空）'});
  const count = await versionCount(old.db, old.orgId);
  const out = await adoptV2(old.admin);
  assert.equal(out.status, 409);
  assert.match(JSON.stringify(out.body), /契約額/);
  assert.equal(await versionCount(old.db, old.orgId), count);
});

// 料率の集計を決める列: 料率の5列（分子を当社売上から計上額へ）と、分母の補助の5列（式の分子を当社売上から計上額へ）。計画の裁定1 (a)
const RATE_BASIS = [...PLAN.rates, ...PLAN.rates.map((key) => v1ByKey.get(key).denominator_key)];
const byRateDetail = (a, b) => a.saleId - b.saleId || String(a.key).localeCompare(String(b.key));
test('G-7・G-10 #2a で緑にする: 料率の分子を計上額に変える adopt-v2 は、料率を2キーに入れた売上・料率のキーと流通のまとまりが食い違う売上があると 409 で件数と売上IDを名指しして版を足さず、値を直せば通り、分子を変えたあとの呼び出しは止めない', async (t) => {
  const old = await oldOrg(t);
  const [a, b, c] = await addSales(old.db, old.admin, old.orgId, ['2026-04', '2026-05', '2026-06'], 'RATE');
  for (const saleId of [a, b, c]) {
    await old.admin.post('/report-center/classifications', {saleId, distributionCode: 'D004', baseVersion: 0, territory: '日本', serviceName: null, settlementMethod: 'unverified', reason: '試験の分類（都度課金＝RS）'});
  }
  await old.admin.post('/sales-sheet/values', {reason: '試験の料率（架空）', changes: [
    {saleId: a, columnKey: 'rs_partner_rate', baseVersion: 0, value: '40'}, // 前提どおり（RS の売上に RS の料率）
    {saleId: b, columnKey: 'rs_partner_rate', baseVersion: 0, value: '35'}, {saleId: b, columnKey: 'vod_partner_rate', baseVersion: 0, value: '35'}, // 2キー（VOD は RS と食い違う）
    {saleId: c, columnKey: 'flat_partner_rate', baseVersion: 0, value: '30'}, // RS の売上に定額の料率
  ]});
  const count = await versionCount(old.db, old.orgId);
  const refused = await adoptV2(old.admin);
  assert.equal(refused.status, 409, show(refused));
  const {ratePremise, rateBasisChanged} = refused.body.details;
  assert.deepEqual({...ratePremise.rateKeys, detail: [...ratePremise.rateKeys.detail].sort(byRateDetail)},
    {count: 1, examples: [b], detail: [{saleId: b, keys: ['rs_partner_rate', 'vod_partner_rate']}]});
  assert.deepEqual({...ratePremise.rateBlocks, detail: [...ratePremise.rateBlocks.detail].sort(byRateDetail)},
    {count: 2, examples: [b, c], detail: [{saleId: b, key: 'vod_partner_rate', block: 'rs'}, {saleId: c, key: 'flat_partner_rate', block: 'rs'}]});
  assert.deepEqual(sortStrings(rateBasisChanged), sortStrings(RATE_BASIS), '料率の5列と分母の補助の5列の分子が変わる');
  assert.match(refused.body.error, new RegExp(`料率が2つ以上ある売上 1件（売上ID ${b}）`));
  assert.match(refused.body.error, new RegExp(`料率のキーと流通のまとまりが食い違う売上 2件（売上ID ${b}・${c}）`));
  assert.equal(await versionCount(old.db, old.orgId), count, '版を足さない');
  // 値を直す（b の VOD の料率と、c の定額の料率を消す）と通る
  await old.admin.post('/sales-sheet/values', {reason: '料率のキーを直した（架空）', changes: [
    {saleId: b, columnKey: 'vod_partner_rate', baseVersion: 1, value: ''}, {saleId: c, columnKey: 'flat_partner_rate', baseVersion: 1, value: ''},
  ]});
  const done = await adoptV2(old.admin);
  assert.equal(done.status, 201, show(done));
  const after = await latestColumns(old.db, old.orgId);
  for (const key of RATE_BASIS) assert.equal(after.get(key).version, 2, `${key} は辞書の分子の版`);
  // 分子を変えたあとは、adopt-v2 が料率の集計を変えないので、前提を満たさない値があっても止めない（--check で数える）
  await old.admin.post('/sales-sheet/values', {reason: '前提を満たさない料率（架空）', changes: [{saleId: c, columnKey: 'flat_partner_rate', baseVersion: 2, value: '30'}]});
  const again = await adoptV2(old.admin);
  assert.equal(again.status, 200, show(again));
});

test('G-10 #2a で緑にする: 辞書から外した列と同じキーで管理者が足した独自列（取り方が違う）は、adopt-v2 が止めない', async (t) => {
  const tdb = await openTestDb({t});
  const app = createApp({db: tdb, mode: 'local'});
  const admin = await apiClient(app, OTHER_ADMIN);
  const org = await orgOf(tdb, OTHER_ADMIN);
  await admin.post('/sales-sheet/columns/adopt', {reason: REASON});
  // 辞書を採用した組織には外した列（report_status。辞書では報告の状態を読む列）が無いので、同じキーの拡張属性の列を足せる
  await admin.post('/sales-sheet/columns', {columnKey: 'report_status', label: '報告の状態（独自・架空）', groupKey: 'custom', valueType: 'text', aggregation: 'distinct',
    sourceKind: 'attribute', reason: '管理者が足した列（架空）'});
  const before = await latestColumns(tdb, org);
  assert.deepEqual(before.get('report_status'), {version: 1, active: true, sourceKind: 'attribute'});
  const out = await adoptV2(admin);
  assert.equal(out.status, 200, show(out));
  assert.deepEqual(out.body.deactivated, []);
  assert.deepEqual((await latestColumns(tdb, org)).get('report_status'), before.get('report_status'), '独自列は使い続ける');
});

test('G-10 #2a で緑にする: adopt-v2 は辞書の値に置き換えた項目を列ごとに返し、採用のあとに直した見出しを辞書の見出しに戻した列は、前の見出しと版を revertedEdits で返す（前の版は履歴に残る）', async (t) => {
  const old = await oldOrg(t);
  const edited = '明細の名前・管理者が直した・架空'; // 入力の正規化（NFKC）で変わらない文字だけ
  await old.admin.post('/sales-sheet/columns/line_note/versions', {baseVersion: 1, label: edited, reason: '見出しを直した（架空）'});
  const out = await adoptV2(old.admin);
  assertAdopted(out);
  const dictionary = registry.SHEET_COLUMNS.find((c) => c.key === 'line_note');
  assert.deepEqual(out.body.revertedEdits, [{key: 'line_note', version: 2, fields: ['label'], before: {label: edited, description: v1ByKey.get('line_note').description}}]);
  assert.ok(out.body.updatedFields.line_note.includes('label'));
  // 版1のまま辞書が見出しを変えた列（#10 契約額）は、置き換えた項目には出るが、戻した手直しには出ない
  assert.notEqual(v1ByKey.get('flat_deal_ex_tax').label, '契約額（配信の定額）');
  assert.ok(out.body.updatedFields.flat_deal_ex_tax.includes('label'));
  const labels = (await old.db.all("SELECT label FROM sales_sheet_column_versions WHERE org_id=? AND column_key='line_note' ORDER BY version_no", [old.orgId])).map((row) => row.label);
  assert.deepEqual(labels, [v1ByKey.get('line_note').label, edited, dictionary.label]);
});

// ---------- G-11 裁定3 ----------
test('G-11 ロイヤリティ計上の額の食い違い（4項目）を数える関数は、項目ごとの件数と売上IDを返す', () => {
  const basis = [
    {sale_id: 1, amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100, royalty_amount_ex_tax: 1000, royalty_tax_amount: 100, royalty_amount_inc_tax: 1100},
    {sale_id: 2, amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100, royalty_amount_ex_tax: 900, royalty_tax_amount: 90, royalty_amount_inc_tax: 990},
    {sale_id: 3, amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100, royalty_amount_ex_tax: 1000, royalty_tax_amount: 0, royalty_amount_inc_tax: 1000},
  ];
  const currency = [
    {sale_id: 4, currency_code: 'USD', original_amount_x100: 1000000, original_royalty_x100: 1000000},
    {sale_id: 5, currency_code: 'USD', original_amount_x100: 1000000, original_royalty_x100: 900000},
    {sale_id: 6, currency_code: 'TWD', original_amount_x100: 500000, original_royalty_x100: null},
    {sale_id: 7, currency_code: 'JPY', original_amount_x100: null, original_royalty_x100: null},
  ];
  assert.deepEqual(royaltyAmountMismatches({basis, currency}), {count: 3, examples: [2, 3, 5], items: {
    royalty_amount_ex_tax: {count: 1, examples: [2]}, royalty_tax_amount: {count: 2, examples: [2, 3]}, royalty_amount_inc_tax: {count: 2, examples: [2, 3]},
    original_royalty_x100: {count: 1, examples: [5]}}});
  assert.equal(royaltyAmountMismatches({basis: basis.slice(0, 1), currency: [currency[0], currency[2], currency[3]]}).count, 0);
});

test('G-11 外貨の項目の境目: 円の版は外貨のロイヤリティ計上額が外貨の計上額と違っても数えず、外貨の計上額が空の外貨の版はロイヤリティ計上額があれば数える', () => {
  const currency = [
    {sale_id: 11, currency_code: 'JPY', original_amount_x100: 1000000, original_royalty_x100: 900000},
    {sale_id: 12, currency_code: 'EUR', original_amount_x100: null, original_royalty_x100: 500000},
    {sale_id: 13, currency_code: 'EUR', original_amount_x100: null, original_royalty_x100: null},
    {sale_id: 14, currency_code: 'USD', original_amount_x100: '1000000', original_royalty_x100: '999999'}, // PostgreSQL の入口は文字で返す
  ];
  assert.deepEqual(royaltyAmountMismatches({currency}), {count: 2, examples: [12, 14], items: {
    royalty_amount_ex_tax: {count: 0, examples: []}, royalty_tax_amount: {count: 0, examples: []}, royalty_amount_inc_tax: {count: 0, examples: []},
    original_royalty_x100: {count: 2, examples: [12, 14]}}});
  // シートの行の列（royalty_amount_mismatch）も同じ関数で決める
  const sale = {amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100};
  assert.deepEqual(currency.map((cur) => registry.royaltyMismatchItems(sale, null, cur)), [[], ['original_royalty_x100'], [], ['original_royalty_x100']]);
});

test('G-11 #2a で緑にする: 外貨のロイヤリティ計上額だけが外貨の計上額と違う売上は、行の royalty_amount_mismatch が「はい」で、数える関数と adopt-v2 の応答も外貨の項目でその売上だけを数える', async (t) => {
  const old = await oldOrg(t);
  const [foreign, same, none] = await addSales(old.db, old.admin, old.orgId, ['2026-04', '2026-05', '2026-06'], 'FX');
  const currency = (saleId, amount, royalty) => old.admin.post(`/sales-sheet/sales/${saleId}/currency`, {baseVersion: 0, currencyCode: 'USD', originalAmount: amount, originalRoyaltyAmount: royalty,
    exchangeRate: '100.0000', rateDate: '2026-04-30', basis: '架空の為替の出典', reason: '外貨の記録（架空）'});
  await currency(foreign, '100.00', '95.00'); // 計上額 10,000 円＝100.00 USD。ロイヤリティ計上額だけ違う
  await currency(same, '200.00', '200.00'); // 20,000 円＝200.00 USD。同じ額
  const empty = {count: 0, examples: []};
  const expected = {count: 1, examples: [foreign], items: {royalty_amount_ex_tax: empty, royalty_tax_amount: empty, royalty_amount_inc_tax: empty, original_royalty_x100: {count: 1, examples: [foreign]}}};
  assert.deepEqual((await checkOrganization(old.db, old.orgId)).royaltyMismatch, expected);
  const out = await adoptV2(old.admin);
  assertAdopted(out);
  assert.deepEqual(out.body.royaltyMismatch, expected);
  assert.deepEqual(keptKeys(out.body.kept), sortStrings(PLAN.royalty), '外貨の項目だけの食い違いでも4列を残す');
  const rows = await detailById(old.admin, ['royalty_amount_mismatch', 'royalty_amount_ex_tax', 'amount_ex_tax']);
  assert.deepEqual([foreign, same, none].map((id) => rows.get(id).royalty_amount_mismatch), [true, false, false]);
  assert.equal(rows.get(foreign).royalty_amount_ex_tax, rows.get(foreign).amount_ex_tax, '円のロイヤリティ計上額は売上と同じ（外貨の項目だけが違う）');
});

test('G-11 #2a で緑にする: 食い違いのある組織では adopt-v2 が4列を残して kept と理由を返し、royalty_amount_mismatch は食い違う売上だけ「はい」で、横並びはロイヤリティ計上額のまま', async (t) => {
  const kept = await royaltyOrg(t);
  const mismatch = await checkOrganization(kept.db, kept.orgId);
  assert.deepEqual({count: mismatch.royaltyMismatch.count, examples: mismatch.royaltyMismatch.examples}, {count: 1, examples: [kept.first]});
  const out = await adoptV2(kept.admin);
  assertAdopted(out);
  assert.deepEqual(keptKeys(out.body.kept), sortStrings(PLAN.royalty), '残した4列を返す');
  assert.deepEqual({count: out.body.royaltyMismatch.count, examples: out.body.royaltyMismatch.examples}, {count: 1, examples: [kept.first]}, '食い違いの件数を返す');
  assert.ok(textsOf(out.body).some((text) => /食い違/.test(text) && text.includes('1')), `残した理由（食い違いの件数）を返す: ${show(out)}`);
  const after = await latestColumns(kept.db, kept.orgId);
  for (const key of PLAN.royalty) assert.equal(after.get(key).active, true, `残す ${key}`);
  for (const key of PLAN.removed) assert.equal(after.get(key).active, false, `ほかの差分は当てる ${key}`);
  assert.equal(after.get('royalty_amount_mismatch')?.active, true, '監査の列を足す');
  const rows = await detailById(kept.admin, ['royalty_amount_mismatch']);
  assert.deepEqual([rows.get(kept.first).royalty_amount_mismatch, rows.get(kept.second).royalty_amount_mismatch], [true, false]);
  const {pivotKey, totals} = await pivotOf(kept.admin, 'royalty', 'ex');
  assert.deepEqual({pivotKey, totals}, {pivotKey: 'royalty_amount_ex_tax', totals: {'2026-04': ROYALTY_MISMATCH.exTax, '2026-05': null, '2026-06': 20000}});
});

test('G-11 #2a で緑にする: 食い違いが0件の組織（ロイヤリティ計上の基準はあり、額は売上と同じ）では4列が active=0 になり、royalty_amount_mismatch は全行「いいえ」で、横並びは計上額を読む', async (t) => {
  const stopped = await royaltyOrg(t, {mismatch: false});
  const check = await checkOrganization(stopped.db, stopped.orgId);
  assert.equal(check.royaltyMismatch.count, 0);
  assert.equal(Number((await stopped.db.get('SELECT COUNT(*) AS n FROM sale_royalty_basis_versions WHERE org_id=?', [stopped.orgId])).n), 2, '空どうしの0件ではない');
  const done = await adoptV2(stopped.admin);
  assertAdopted(done);
  const after = await latestColumns(stopped.db, stopped.orgId);
  for (const key of PLAN.royalty) assert.equal(after.get(key).active, false, `止める ${key}`);
  const rows = await detailById(stopped.admin, ['royalty_amount_mismatch']);
  assert.deepEqual([rows.get(stopped.first).royalty_amount_mismatch, rows.get(stopped.second).royalty_amount_mismatch], [false, false]);
  for (const [tax, amount, expected] of [['ex', 'amount_ex_tax', {'2026-05': 10000, '2026-06': 20000}], ['inc', 'amount_inc_tax', {'2026-05': 11000, '2026-06': 22000}]]) {
    assert.deepEqual(await pivotOf(stopped.admin, 'royalty', tax), {pivotKey: amount, totals: expected}, `${tax}: 月はロイヤリティ計上月のまま、額は計上額`);
  }
});

// ロイヤリティ計上月の横並び（税抜）の、横に並べた列・月ごとの合計・条件
async function royaltyPivot(client) {
  const body = await sheetAggregate(client, {dims: 'partner', pivot: '1', month: 'royalty', tax: 'ex', columns: 'amount_ex_tax'});
  return {pivotKey: body.pivotKey, totals: Object.fromEntries(body.months.map((month) => [month, body.rows.reduce((n, row) => (row[`m_${month}`] === null ? n : (n ?? 0) + row[`m_${month}`]), null)])),
    conditions: Object.fromEntries(body.conditions)};
}
test('G-11 #2a で緑にする: 4列を止めたあとに額の違うロイヤリティ計上の版を記録すると、横並びは計上額を読んだまま条件にその件数を出し、adopt-v2 を流し直すと4列が戻って kept と理由を返し、横並びはロイヤリティ計上額を読む', async (t) => {
  const org = await royaltyOrg(t, {mismatch: false});
  assertAdopted(await adoptV2(org.admin));
  for (const key of PLAN.royalty) assert.equal((await latestColumns(org.db, org.orgId)).get(key).active, false, `止めた ${key}`);
  // 2026-05 の売上（20,000・税 2,000。ロイヤリティ計上月 2026-06）に、額を 15,000・税 1,500 にした版を記録する（FR-SETL-ACCR-096 に反する版）
  await org.admin.post(`/sales-sheet/sales/${org.second}/royalty-basis`, {baseVersion: 1, royaltyMonth: '2026-06', amountExTax: '15000', taxAmount: '1500',
    reason: '止めたあとに額を変えた版（食い違い・架空）'});
  const stopped = await royaltyPivot(org.admin);
  assert.deepEqual({pivotKey: stopped.pivotKey, totals: stopped.totals}, {pivotKey: 'amount_ex_tax', totals: {'2026-05': 10000, '2026-06': 20000}}, '止めた組織の横並びは計上額');
  assert.equal(stopped.conditions['月を横に並べる'], '税抜の計上額', '条件が読んだ額を言う');
  assert.match(stopped.conditions['横並びの額'], /ロイヤリティ計上の額が計上額と違う明細が1件/);
  assert.deepEqual([...(await detailById(org.admin, ['royalty_amount_mismatch'])).entries()].filter(([, row]) => row.royalty_amount_mismatch).map(([id]) => id), [org.second]);
  // 流し直すと4列が戻る
  const again = await adoptV2(org.admin);
  assert.equal(again.status, 201, show(again));
  assert.deepEqual(keptKeys(again.body.kept), sortStrings(PLAN.royalty));
  assert.deepEqual(sortStrings(again.body.reactivated), sortStrings(PLAN.royalty));
  assert.deepEqual({count: again.body.royaltyMismatch.count, examples: again.body.royaltyMismatch.examples}, {count: 1, examples: [org.second]});
  assert.match(again.body.keptReason, /食い違う版が1件/);
  const after = await latestColumns(org.db, org.orgId);
  for (const key of PLAN.royalty) assert.equal(after.get(key).active, true, `戻した ${key}`);
  const kept = await royaltyPivot(org.admin);
  assert.deepEqual({pivotKey: kept.pivotKey, totals: kept.totals}, {pivotKey: 'royalty_amount_ex_tax', totals: {'2026-05': 10000, '2026-06': 15000}});
  assert.equal(kept.conditions['月を横に並べる'], '税抜のロイヤリティ計上額');
  assert.equal(Object.hasOwn(kept.conditions, '横並びの額'), false, 'ロイヤリティ計上額を読むときは注意を出さない');
  // 3回目は何も足さない
  const count = await versionCount(org.db, org.orgId);
  assert.equal((await adoptV2(org.admin)).status, 200);
  assert.equal(await versionCount(org.db, org.orgId), count);
});

// ---------- G-12 MG ----------
async function mgDb(t) {
  const tdb = await openTestDb({t});
  const app = createApp({db: tdb, mode: 'local'});
  const admin = await apiClient(app, MG_VERSIONS_SEED.adminEmail);
  await admin.post('/sales-sheet/columns/adopt', {reason: REASON});
  await seedMgVersions(tdb, admin);
  const {rows} = await sheetDetail(admin, MG_SHEET_COLUMNS);
  return {admin, rows: rows.sort((a, b) => a.booking_month.localeCompare(b.booking_month))};
}
test('G-12 MG の fixture: 期待値は「その月末までに始まった最新の版」と訂正の扱いから出したもので、MG 台帳の帳票（mg-portfolio）の同じ月の値と一致する', async (t) => {
  assert.deepEqual(mgFixture.seed, JSON.parse(JSON.stringify(MG_VERSIONS_SEED)));
  assert.deepEqual(mgFixture.expected, mgExpectedByMonth(mgFixture.seed));
  // 境界: 版2は 2025-07-15 に始まる → 2025-06 は版1、2025-07 は版2。訂正（L4 が L2 を置き換え）は L2 を数えず、L4 は 2025-11 から数える
  const at = (month) => mgFixture.expected.find((row) => row.month === month);
  assert.deepEqual([at('2025-06').version, at('2025-07').version], [1, 2]);
  assert.deepEqual([at('2025-06').advance_guarantee_balance, at('2025-10').advance_guarantee_balance, at('2025-11').advance_guarantee_balance],
    [3000000 - 800000, 5000000 - 800000 - 1200000, 5000000 - 800000 - 1200000 - 700000]);
  const {admin, rows} = await mgDb(t);
  // 訂正した報告の売上は訂正後の1行だけが出る
  assert.deepEqual(rows.map((row) => [row.booking_month, row.amount_ex_tax]), MG_VERSIONS_SEED.sales.map((s) => [s.month, s.correctedAmountExTax ?? s.amountExTax]));
  for (const expected of mgFixture.expected) {
    const report = (await admin.get(`/rights-reports/mg-portfolio?${query({direction: 'incoming', month: expected.month})}`)).report;
    const contract = report.contracts.find((c) => c.code === MG_VERSIONS_SEED.contract.code);
    assert.deepEqual({version: contract.termVersion, mg_guarantee_ex_tax: contract.guaranteeYen, mg_start: contract.startsOn, mg_end: contract.endsOn, advance_guarantee_balance: contract.remainingAppliedYen},
      {version: expected.version, mg_guarantee_ex_tax: expected.mg_guarantee_ex_tax, mg_start: expected.mg_start, mg_end: expected.mg_end, advance_guarantee_balance: expected.advance_guarantee_balance}, expected.month);
  }
});

test('G-12 #2a で緑にする: シートの MG の保証額・開始日・終了日・残高（#15〜17・#74）が、その月末までに始まった最新の版と台帳の回収の計算と一致する', async (t) => {
  const {rows} = await mgDb(t);
  assert.deepEqual(rows.map((row) => ({month: row.booking_month, ...Object.fromEntries(PLAN.mg.map((key) => [key, row[key]]))})),
    mgFixture.expected.map(({version, ...row}) => row));
  for (const row of rows) assert.equal(row.mg_group, MG_VERSIONS_SEED.contract.code, row.booking_month);
});

// 同じ商品を持つ受取の MG 契約が3つと、条件版から外した商品の台帳の行（架空。既定の組織 demo の作品 WRK-DEMO・取引先 PT-DIGITAL）。
//   A: 版1 2025-01-01〜 商品 P（SKU-DIGI）・保証 3,000,000
//   B: 版1 2025-04-01〜 商品 P・Q（SKU-PACK）・保証 4,000,000。Q の台帳の行（2025-05 計上・実充当 500,000）。版2 2025-07-01〜 商品 P だけ・保証 4,500,000
//   C: 版1 2025-04-01〜（B と同じ日）商品 P・保証 2,000,000
// 売上: P 2025-03（A だけが始まっている）、P 2025-05（A・B・C。版の始まりが遅いのは B と C で、同じ日なので ID の大きい方。
//       MG 契約の ID は乱数（src/mg.mjs の newId）なので、作った順ではなく、作った契約の ID から期待値を決める）、
//       Q 2025-08（B の版2の商品には無いが、台帳の行があるので MG 帳票の B の商品の行にある）
const MG_SHARED = Object.freeze({
  contracts: [
    {code: 'MGS-A', versions: [{amount: 3000000, startsOn: '2025-01-01', endsOn: '2025-12-31', firstCloseOn: '2025-03-31', products: ['P']}]},
    {code: 'MGS-B', versions: [{amount: 4000000, startsOn: '2025-04-01', endsOn: '2026-03-31', firstCloseOn: '2025-06-30', products: ['P', 'Q']},
      {amount: 4500000, startsOn: '2025-07-01', endsOn: '2026-06-30', firstCloseOn: '2025-09-30', products: ['P']}],
    ledger: [{version: 1, product: 'Q', periodFrom: '2025-04-01', periodTo: '2025-04-30', accountingMonth: '2025-05', applied: 500000}]},
    {code: 'MGS-C', versions: [{amount: 2000000, startsOn: '2025-04-01', endsOn: '2026-03-31', firstCloseOn: '2025-06-30', products: ['P']}]},
  ],
  sales: [{key: 'MGS-P-2025-03', product: 'P', month: '2025-03', expected: 'MGS-A'}, {key: 'MGS-P-2025-05', product: 'P', month: '2025-05', expected: 'MGS-B|MGS-C'},
    {key: 'MGS-Q-2025-08', product: 'Q', month: '2025-08', expected: 'MGS-B'}],
});
test('G-12 #2a で緑にする: 同じ商品を持つ MG 契約が2つ以上なら選んだ版の始まりが遅い契約（同じ日なら ID の大きい契約）で、条件版から外した商品も台帳の行があれば MG 帳票と同じく契約に入り、値は MG 帳票の同じ月の契約の値と一致する', async (t) => {
  const tdb = await openTestDb({t});
  const app = createApp({db: tdb, mode: 'local'});
  const admin = await apiClient(app, ADMIN);
  await admin.post('/sales-sheet/columns/adopt', {reason: REASON});
  const product = {P: 1, Q: 2}; // 既定の組織の SKU-DIGI（配信）と SKU-PACK（パッケージ）
  const term = (v) => ({mgAmountYen: v.amount, startsOn: v.startsOn, endsOn: v.endsOn, mode: v.products.length > 1 ? 'cross' : 'single', reason: '架空の条件', sourceReference: '架空の契約書',
    products: v.products.map((p) => ({productId: product[p], evaluationYen: v.amount / v.products.length})), // 評価額の合計＝保証額
    phases: [{startsOn: v.startsOn, endsOn: v.endsOn, intervalMonths: 3, firstCloseOn: v.firstCloseOn, reportOffsetMonths: 1, reportDay: 28, payOffsetMonths: 2, payDay: 28}]});
  const contractIds = {};
  for (const contract of MG_SHARED.contracts) {
    const [first, ...rest] = contract.versions;
    const created = await admin.post('/mg/contracts', {direction: 'incoming', code: contract.code, title: `${contract.code}（架空）`, partnerId: 2, contractDate: '2024-12-01',
      contractSourceReference: '架空の許諾契約書', ...term(first)});
    contractIds[contract.code] = Number(created.contractId);
    const versionIds = [created.versionId];
    for (const [n, v] of rest.entries()) versionIds.push((await admin.post(`/mg/contracts/incoming/${created.contractId}/versions`, {baseVersion: n + 1, ...term(v)})).versionId);
    for (const e of contract.ledger || []) {
      await admin.post('/mg/ledger', {termVersionId: versionIds[e.version - 1], productId: product[e.product], periodFrom: e.periodFrom, periodTo: e.periodTo, accountingMonth: e.accountingMonth,
        sourceReference: `${contract.code}-L`, reportedEligibleYen: e.applied, appliedRecoupYen: e.applied, reportedOverageYen: 0, recognizedYen: 0, status: 'reviewed', acknowledgement: true,
        confirmationReason: '架空データの手入力値'});
    }
  }
  // 始まりが同じ日の B と C は、ID の大きい契約
  assert.notEqual(contractIds['MGS-B'], contractIds['MGS-C']);
  const tieWinner = contractIds['MGS-B'] > contractIds['MGS-C'] ? 'MGS-B' : 'MGS-C';
  const expectedOf = (s) => (s.expected === 'MGS-B|MGS-C' ? tieWinner : s.expected);
  const lineNote = (month) => `MG の契約の選び方の試験 ${month}（架空）`;
  for (const s of MG_SHARED.sales) {
    const pack = s.product === 'Q';
    await admin.post('/sales', {workId: 1, report_key: s.key, kind: pack ? 'package' : 'digital', description: lineNote(s.month), quantity: '',
      partner_id: pack ? 3 : 2, product_id: product[s.product], period_from: `${s.month}-01`, period_to: `${s.month}-28`, accounting_month: s.month,
      amount_ex_tax: 10000, tax_amount: 1000, amount_inc_tax: 11000});
  }
  const rows = (await sheetDetail(admin, [...MG_SHEET_COLUMNS, 'line_note'])).rows.filter((r) => MG_SHARED.sales.some((s) => r.line_note === lineNote(s.month)));
  assert.equal(rows.length, MG_SHARED.sales.length);
  for (const s of MG_SHARED.sales) {
    const row = rows.find((r) => r.line_note === lineNote(s.month));
    const report = (await admin.get(`/rights-reports/mg-portfolio?${query({direction: 'incoming', month: s.month})}`)).report;
    const contract = report.contracts.find((c) => c.code === expectedOf(s));
    assert.ok(contract, `${s.month}: MG 帳票に ${expectedOf(s)}`);
    assert.ok(contract.rows.some((r) => Number(r.productId) === product[s.product]), `${s.month}: MG 帳票の ${expectedOf(s)} に商品 ${s.product} の行`);
    assert.deepEqual({mg_group: row.mg_group, ...Object.fromEntries(PLAN.mg.map((key) => [key, row[key]]))},
      {mg_group: expectedOf(s), mg_guarantee_ex_tax: contract.guaranteeYen, mg_start: contract.startsOn, mg_end: contract.endsOn, advance_guarantee_balance: contract.remainingAppliedYen}, s.month);
  }
  // 値を書き下す（MG 帳票の値と合っても、契約の取り違えを見落とさないように）
  const byMonth = Object.fromEntries(rows.map((row) => [row.booking_month, [row.mg_group, row.mg_guarantee_ex_tax, row.advance_guarantee_balance]]));
  // 2025-05 の B は版1の保証 4,000,000 から Q の実充当 500,000（2025-05 計上）を引いた残り
  const tie = {'MGS-B': ['MGS-B', 4000000, 3500000], 'MGS-C': ['MGS-C', 2000000, 2000000]}[tieWinner];
  assert.deepEqual(byMonth, {'2025-03': ['MGS-A', 3000000, 3000000], '2025-05': tie, '2025-08': ['MGS-B', 4500000, 4000000]});
});

// ---------- G-13 2つの道 ----------
test('G-13 #2a で緑にする: 新しい組織（adopt で v2）と旧い組織（v1→追加の列→adopt-v2）の有効な列のカタログが同じ', async (t) => {
  const old = await oldOrg(t);
  const out = await adoptV2(old.admin);
  assertAdopted(out);
  const fresh = await apiClient(old.app, OTHER_ADMIN);
  await fresh.post('/sales-sheet/columns/adopt', {reason: REASON});
  const definition = (c) => ({key: c.key, label: c.label, group: c.group, valueType: c.valueType, aggregation: c.aggregation, legacyPosition: c.legacyPosition, sourceKind: c.sourceKind,
    sourceRef: c.sourceRef, formula: c.formula, numeratorKey: c.numeratorKey, denominatorKey: c.denominatorKey, ratioScale: c.ratioScale, digits: c.digits, description: c.description,
    sortOrder: c.sortOrder});
  const activeOf = async (client) => (await client.get('/sales-sheet/columns')).columns.filter((c) => c.active).map(definition).sort((a, b) => a.key.localeCompare(b.key));
  const [oldCatalog, newCatalog] = [await activeOf(old.admin), await activeOf(fresh)];
  assert.deepEqual(new Set(newCatalog.map((c) => c.key)), expectedV2Active(), '有効な列のキー（計画: 消12と裁定3の4を除き、監査の1列を足す）');
  assert.deepEqual(oldCatalog, newCatalog);
});

// ---------- G-14 列セット ----------
test('G-14 #2a で緑にする: 7組の列セットは統合前と同じ（外した列・止めた列を除く）、全列は辞書の有効な列を並び順に並べ補助の列だけ除き、additional・all_plus は辞書の有効な列から出る', async (t) => {
  const old = await oldOrg(t);
  const out = await adoptV2(old.admin);
  assertAdopted(out);
  const body = await old.admin.get('/sales-sheet/columns');
  const sets = Object.fromEntries(body.sets.map((set) => [set.key, set.columns]));
  const active = expectedV2Active();
  const retired = new Map((registry.SHEET_COLUMNS || []).filter((c) => c.retired_by).map((c) => [c.key, c.retired_by]));
  const expectedSet = (key) => [...new Set(catalogV1.sets[key].map((k) => retired.get(k) ?? k))].filter((k) => active.has(k));
  for (const key of ['basic', 'theatre', 'videogram', 'digital', 'mgflat', 'tax', 'audit']) assert.deepEqual(sets[key], expectedSet(key), key);
  const shown = body.columns.filter((c) => c.active && !c.key.startsWith('h_'));
  assert.equal(new Set(shown.map((c) => c.sortOrder)).size, shown.length, '有効な列の並び順（sort_order）に重なりが無い');
  assert.deepEqual(sets.all, shown.sort((a, b) => a.sortOrder - b.sortOrder).map((c) => c.key), '全列は有効な列を並び順に（補助 h_ だけ除く）');
  assert.deepEqual(new Set(sets.all), new Set([...active].filter((k) => !k.startsWith('h_'))));
  for (const key of [...PLAN.holderKept, ...catalogV1.sets.additional.filter((k) => active.has(k))]) assert.ok(sets.all.includes(key), `全列に ${key}`);
  for (const key of ['additional', 'all_plus']) assertAliasSet(sets[key], key, active, sets.all);
});

test('G-14 #2a で緑にする: 辞書に無いキーの拡張属性の値（外した列に残った値）を attributeOrphans が数える', async (t) => {
  const old = await oldOrg(t);
  const [saleId] = await addSales(old.db, old.admin, old.orgId, ['2026-04'], 'G14');
  await addRemovedAttributeValues(old.admin, saleId);
  const out = await adoptV2(old.admin);
  assertAdopted(out);
  const dictionaryKeys = (await old.admin.get('/sales-sheet/columns')).columns.filter((c) => c.active).map((c) => c.key);
  const orphans = attributeOrphans(await latestAttributeValues(old.db, old.orgId), {dictionaryKeys});
  assert.deepEqual(orphans.notInDictionary, {count: 6, byKey: Object.fromEntries(sortStrings(REMOVED_ATTRIBUTE_KEYS).map((key) => [key, 1])), examples: [saleId]});
  assert.deepEqual(out.body.attributeOrphans, orphans, 'adopt-v2 の応答も同じ件数を返す');
});

// ---------- 裁定1・2 (a) の退役キー（PR C） ----------
const RETIRED = Object.freeze(Object.fromEntries(LEGACY_PLAN.filter((c) => ['裁1', '裁2'].includes(c.treatment)).map((c) => [c.key, c.destination])));
test('G-9・G-10・G-14 PR C で緑にする: 裁定1・2 の旧キー20は辞書で retired_by に行き先を持ち、adopt-v2 で active=0 になり、列セットでは行き先に置き換わり、列対応 attr_<旧キー> の値は新しい表へ入る',
  {todo: 'PR C（香盤表 #6。新しい表と reported_*）で緑にする。#2a の辞書には retired_by を持つ列が無い'}, async (t) => {
    const dictionary = registry.SHEET_COLUMNS || [];
    assert.deepEqual(Object.fromEntries(dictionary.filter((c) => c.retired_by).map((c) => [c.key, c.retired_by]).sort(([a], [b]) => a.localeCompare(b))),
      Object.fromEntries(Object.entries(RETIRED).sort(([a], [b]) => a.localeCompare(b))), '退役キーと行き先は計画の対応表のとおり');
    const old = await oldOrg(t);
    assertAdopted(await adoptV2(old.admin));
    const after = await latestColumns(old.db, old.orgId);
    for (const [key, destination] of Object.entries(RETIRED)) {
      assert.equal(after.get(key)?.active, false, `退役キー ${key}`);
      assert.equal(after.get(destination)?.active, true, `行き先 ${destination}`);
    }
    const sets = Object.fromEntries((await old.admin.get('/sales-sheet/columns')).sets.map((set) => [set.key, set.columns]));
    for (const key of ['theatre', 'videogram', 'digital', 'mgflat']) {
      for (const column of catalogV1.sets[key].filter((k) => Object.hasOwn(RETIRED, k))) assert.ok(sets[key].includes(RETIRED[column]), `${key} の ${column} は ${RETIRED[column]} に`);
    }
    const headers = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'accounting_month', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax', 'attr_theatre_name'];
    const preview = await old.admin.post('/imports/preview', {kind: 'theatrical', workId: 1, text: toCsv(headers, [['PRC-THR', 1, '', '2026-04-01', '2026-04-30', '2026-04', '劇場（架空）', '', 1000, 100, 1100,
      '架空シネマ（架空）']])});
    await old.admin.post('/imports/commit', {token: preview.token});
    const stored = await old.db.get("SELECT value_text FROM sale_distribution_metric_versions WHERE org_id=? AND metric_key='theater_name'", [old.orgId]);
    assert.equal(stored?.value_text, '架空シネマ（架空）');
  });

// ---------- 架空データの組織（DEMO-SALES）に adopt-v2 を当てたあと（ファイルの最後に置く。前の試験は統合前の状態を読む） ----------
test('G-1 #2a で緑にする: adopt-v2 で4列を止めた組織（DEMO-SALES。食い違い0件）でも明細・集計・横並びの件数と合計が統合前と同じで、ロイヤリティ計上月の横並びは計上額を読み、月はロイヤリティ計上月のまま', async () => {
  assertAdopted(await adoptV2(api));
  const after = await latestColumns(db, orgId);
  for (const key of PLAN.royalty) assert.equal(after.get(key)?.active, false, `止めた ${key}`);
  await assertDetailTotals(api);
  await assertAggregateTotals(api);
  await assertPivotTotals(api, (tax) => (tax === 'inc' ? 'amount_inc_tax' : 'amount_ex_tax'));
});

test('G-11 #2a で緑にする: 食い違いが0件の架空データの組織（DEMO-SALES）では adopt-v2 が4列を止め、royalty_amount_mismatch は全行「いいえ」', async () => {
  assertAdopted(await adoptV2(api));
  const {rows} = await sheetDetail(api, ['sale_id', 'royalty_amount_mismatch']);
  assert.equal(rows.length, snapshot.lineCount);
  assert.deepEqual([...new Set(rows.map((row) => row.royalty_amount_mismatch))], [false]);
});

test('G-2 #2a で緑にする: 旧131エントリの各列の値が、新しい辞書（SHEET_COLUMNS）の列の値で全行再現でき、再現から外れる列は止めた裁定3の4列だけ', async () => {
  assertAdopted(await adoptV2(api));
  await assertLegacyReproduced(api, {stoppedRoyalty: true});
});

test('G-9 #2a で緑にする: adopt-v2 のあとも、取込の文脈の項目名・保存した形・券種の切り口・URL の旧キーと列セット名が同じに動く', async () => {
  assertAdopted(await adoptV2(api));
  await oldKeysStillWork(api);
});

// 計画の対応表の分子と分母（#20・#26・#39・#46。裁定1 (a) の料率は分子を計上額（税抜）に）。ほかの比率の列は統合前のカタログのまま
const PLAN_RATIO_PARTS = Object.freeze({
  rs_partner_unit_ex_tax: ['h_rs_partner_amount', 'rs_count'], rs_holder_unit_ex_tax: ['rs_holder_ex_tax', 'rs_count'], vod_unit_ex_tax: ['vod_holder_ex_tax', 'view_count'],
  exchange_rate: ['h_foreign_yen', 'foreign_amount'], ...Object.fromEntries(PLAN.rates.map((key) => [key, ['amount_ex_tax', v1ByKey.get(key).denominator_key]])),
});
// 料率の取引先ごとの集計を、再現表の行（統合前の分子＝流通のまとまりの当社売上と、統合前の分母）から作る。行はシートと同じく売上IDの順に足す
function legacyRateTable(saleIds) {
  const rows = legacyRows.map((row) => ({row, id: saleIds.get(row.row_fingerprint)})).sort((a, b) => a.id - b.id).map(({row}) => row);
  const out = {byPartner: {}, totals: {}};
  for (const key of PLAN.rates) {
    const {numerator_key: numKey, denominator_key: denKey, ratio_scale: scale, digits} = v1ByKey.get(key);
    const sums = new Map([['', {num: 0, den: 0, pairs: 0}]]);
    for (const row of rows) {
      if (row[numKey] === null || row[denKey] === null) continue;
      for (const group of [row.partner_code, '']) {
        const sum = sums.get(group) ?? {num: 0, den: 0, pairs: 0};
        sums.set(group, {num: sum.num + row[numKey], den: sum.den + row[denKey], pairs: sum.pairs + 1});
      }
    }
    for (const [group, sum] of sums) {
      const value = sum.pairs && sum.den !== 0 ? registry.roundTo(sum.num / sum.den * scale, digits) : null;
      if (group === '') out.totals[key] = value;
      else (out.byPartner[group] ??= {})[key] = value;
    }
  }
  return out;
}
test('G-5 #2a で緑にする: adopt-v2 のあと（辞書の分子と分母）も、比率の列の分子と分母は計画の対応表のとおりで、#20・#26・#39・#46 の集計値が統合前と同じ。料率の集計も統合前の分子と分母から作った値と同じ', async () => {
  assertAdopted(await adoptV2(api));
  const columns = new Map((await api.get('/sales-sheet/columns')).columns.map((c) => [c.key, c]));
  const dictionary = new Map(registry.SHEET_COLUMNS.map((c) => [c.key, c]));
  const ratios = registry.SHEET_COLUMNS.filter((c) => c.aggregation === 'ratio' && !c.removed && !c.retired_by).map((c) => c.key);
  for (const key of RATIO_COLUMNS) assert.ok(ratios.includes(key), key);
  for (const key of ratios) {
    const expected = PLAN_RATIO_PARTS[key] ?? [v1ByKey.get(key).numerator_key, v1ByKey.get(key).denominator_key];
    assert.deepEqual([dictionary.get(key).numerator_key, dictionary.get(key).denominator_key], expected, `辞書の ${key}`);
    assert.deepEqual([columns.get(key).numeratorKey, columns.get(key).denominatorKey], expected, `adopt-v2 のあとのカタログの ${key}`);
    for (const part of expected) assert.equal(columns.get(part)?.active, true, `${key} の ${part}`);
  }
  assert.deepEqual(await dimensionTable(api, ['partner', 'distribution'], RATIO_COLUMNS), snapshot.ratios.byPartnerDistribution);
  assert.deepEqual(await dimensionTable(api, ['currency'], ['exchange_rate', 'foreign_amount']), snapshot.ratios.byCurrency);
  // 料率（5つのキー。架空データの6売上に値がある）の取引先ごとの集計と合計
  const expected = legacyRateTable(await saleIdByFingerprint());
  const table = await dimensionTable(api, ['partner'], PLAN.rates);
  assert.ok(Object.values(expected.totals).every((value) => value !== null), `どの料率にも集計の値がある: ${JSON.stringify(expected.totals)}`);
  assert.deepEqual(table.totals, expected.totals);
  for (const row of table.rows) {
    assert.deepEqual(Object.fromEntries(PLAN.rates.map((key, n) => [key, row[3 + n]])), Object.fromEntries(PLAN.rates.map((key) => [key, expected.byPartner[row[0]]?.[key] ?? null])), row[0]);
  }
});
