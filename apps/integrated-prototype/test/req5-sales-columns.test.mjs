import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv, parseCsv} from '../src/csv.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {INITIAL_SHEET_COLUMNS, ADDITIONAL_SHEET_COLUMNS, ADDITIONAL_KEYS} from '../src/sales-sheet/column-registry.mjs';

let db, app, admin, editor, production, beforeCatalog, beforeEditorCatalog, beforeAdditionalSheets, beforeCsv, afterCsv, savedView;
const ids = {};
async function login(email, application = app) {
  const res = await application.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, payload) => {
    const response = await application.request(`/api${path}`, {method: payload === undefined ? 'GET' : 'POST', headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const type = response.headers.get('content-type');
    return {status: response.status, body: type.includes('json') ? await response.json() : type.includes('csv') ? await response.text() : new Uint8Array(await response.arrayBuffer())};
  };
}
async function ok(path, payload, status = 200) {
  const result = await admin(path, payload);
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}
const base = {partner_id: 2, period_from: '2026-04-01', period_to: '2026-06-30', sales_period_from: '2026-05-02', sales_period_to: '2026-05-29', accounting_month: '2026-05',
  recognition_basis_id: 2, report_received_on: '2026-05-30', contract_start_on: '2026-02-03', license_start_on: '2026-03-04', broadcast_on: '2026-04-05', basis_reason: '受領月で計上（架空）',
  description: '追加列の売上（架空）', quantity: 7, amount_ex_tax: 1200, tax_amount: 120, amount_inc_tax: 1320};
async function importOne(key, kind, extra = {}) {
  const row = {report_key: key, ...base, ...extra};
  const preview = await ok('/imports/preview', {kind, workId: 1, text: toCsv(Object.keys(row), [Object.values(row)])});
  assert.equal(preview.ok, true, JSON.stringify(preview));
  await ok('/imports/commit', {token: preview.token});
  return db.get('SELECT s.id,s.report_id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE r.report_key=? AND r.status=?', [key, 'active']);
}
const additionalRows = async (suffix = '') => (await ok(`/sales-sheet?set=additional&hideEmpty=0&q=DEMO-REQ5-${suffix}`)).rows;

before(async (t) => {
  db = await openTestDb({t});
  app = createApp({db, mode: 'local'});
  admin = await login('admin@openingnight.invalid');
  editor = await login('editor@openingnight.invalid');
  production = await login('production@openingnight.invalid');
  assert.equal((await admin('/sales-sheet/columns/adopt-additional', {reason: '前提確認（架空）'})).status, 409);
  await ok('/sales-sheet/columns/adopt', {reason: '互換列を採用（架空）'}, 201);
  ids.digital = await importOne('DEMO-REQ5-DIGITAL', 'digital', {digital_model: 'svod', service_code: 'DEMO-SERVICE', view_count: 100, holder_unit_price_ex_tax: 12,
    reported_actual_ex_tax: 2500, reported_recognized_ex_tax: 1200, calculated_actual_ex_tax: 1200});
  ids.package = await importOne('DEMO-REQ5-PACKAGE', 'package', {package_model: 'rental', turns_count: 8, average_rental_price_ex_tax: 200, holder_unit_price_ex_tax: 150,
    reported_actual_ex_tax: 1700, reported_recognized_ex_tax: 0, calculated_actual_ex_tax: 1200});
  ids.theatrical = await importOne('DEMO-REQ5-THEATRICAL', 'theatrical', {theatrical_model: 'theatrical_rs', ticket_type_code: 'DEMO-GENERAL', admissions_count: 4, gross_box_office_ex_tax: 3000,
    reported_actual_ex_tax: 3000, reported_recognized_ex_tax: 1200});
  ids.zero = await importOne('DEMO-REQ5-ZERO', 'other', {quantity: 0, amount_ex_tax: 0, tax_amount: 0, amount_inc_tax: 0});
  ids.null = await importOne('DEMO-REQ5-NULL', 'other', {quantity: ''});
  await ok('/report-center/classifications', {saleId: ids.digital.id, distributionCode: 'D005', baseVersion: 0, territory: '日本', serviceName: '配信サービス（架空）', settlementMethod: 'royalty', reason: '分類（架空）'}, 201);
  await ok('/report-center/classifications', {saleId: ids.digital.id, distributionCode: 'D005', baseVersion: 1, territory: '日本', serviceName: '配信サービス（架空）', settlementMethod: 'MG', reason: '分類訂正（架空）'}, 201);
  await ok(`/sales-sheet/sales/${ids.digital.id}/currency`, {baseVersion: 0, currencyCode: 'USD', originalAmount: '10', exchangeRate: '120', rateDate: '2026-05-01', basis: 'レートの根拠（架空）', reason: '換算（架空）'}, 201);
  await ok(`/sales-sheet/sales/${ids.digital.id}/currency`, {baseVersion: 1, currencyCode: 'USD', originalAmount: '8', exchangeRate: '150', rateDate: '2026-05-31', basis: '改定レートの根拠（架空）', reason: '換算訂正（架空）'}, 201);
  await ok(`/sales-sheet/sales/${ids.digital.id}/royalty-basis`, {baseVersion: 0, royaltyMonth: '2026-05', amountExTax: 600, taxAmount: 60, reason: '独立基準（架空）'}, 201);
  await ok(`/sales-sheet/sales/${ids.digital.id}/royalty-basis`, {baseVersion: 1, royaltyMonth: '2026-05', amountExTax: 500, taxAmount: 50, reason: '独立基準訂正（架空）'}, 201);
  beforeCatalog = await ok('/sales-sheet/columns');
  beforeEditorCatalog = (await editor('/sales-sheet/columns')).body;
  beforeAdditionalSheets = await Promise.all(['additional', 'all_plus'].map((set) => ok(`/sales-sheet?set=${set}&hideEmpty=0`)));
  beforeCsv = await ok('/sales-sheet/export.csv?q=DEMO-REQ5-');
  savedView = await ok('/sales-sheet/views', {name: '保存済みの形（架空）', reason: '互換確認（架空）', definition: {columns: ['work_code', 'amount_ex_tax', 'tax_amount'], grain: 'detail'}}, 201);
  await ok('/sales-sheet/columns/adopt-additional', {reason: '追加の列を採用（架空）'}, 201);
  afterCsv = await ok('/sales-sheet/export.csv?set=all_plus&q=DEMO-REQ5-');
});
after(() => db?.close());

test('83列だけ採用済み: 追加の未採用一覧と依頼先を返し、採用後は追加28列・全列＋追加111列が出る', async () => {
  assert.equal(beforeCatalog.adopted, true);
  assert.equal(beforeCatalog.additionalPending, 28);
  assert.deepEqual(beforeCatalog.additionalColumns.map((c) => c.key), ADDITIONAL_KEYS);
  assert.deepEqual(beforeCatalog.admins, []);
  assert.deepEqual(beforeEditorCatalog.admins, ['管理者']);
  assert.equal(beforeEditorCatalog.canAdmin, false);
  for (const [i, set] of ['additional', 'all_plus'].entries()) {
    const before = beforeAdditionalSheets[i];
    assert.equal(before.selected.length, i ? 83 : 0);
    assert.equal(before.columns.length, i ? 83 : 0);
    const after = await ok(`/sales-sheet?set=${set}&hideEmpty=0`);
    assert.equal(after.selected.length, i ? 111 : 28);
    assert.equal(after.columns.length, i ? 111 : 28);
    assert.ok(after.rows.length > 0);
    assert.ok(after.columns.some((c) => c.key === 'sales_period_to'));
  }
  const adopted = await ok('/sales-sheet/columns');
  assert.deepEqual(adopted.additionalColumns, []);
  assert.equal(adopted.admins, undefined);
});

test('追加採用は既存83列・既存セット・保存した形を変更せず、83列CSVがバイト単位で一致する', async () => {
  const catalog = await ok('/sales-sheet/columns');
  assert.equal(catalog.columns.length, 131);
  assert.deepEqual(catalog.columns.filter((c) => beforeCatalog.columns.some((b) => b.key === c.key)), beforeCatalog.columns);
  for (const set of beforeCatalog.sets.filter((s) => !['additional', 'all_plus'].includes(s.key))) assert.deepEqual(catalog.sets.find((s) => s.key === set.key), set);
  assert.equal(afterCsv, beforeCsv);
  assert.equal(Object.keys(parseCsv(afterCsv)[0].values).length, 83);
  const views = await ok('/sales-sheet/views');
  assert.deepEqual(views.views.find((v) => v.id === savedView.id).definition.columns, ['work_code', 'amount_ex_tax', 'tax_amount']);
  assert.deepEqual(catalog.sets.find((s) => s.key === 'additional').columns, ADDITIONAL_KEYS);
  assert.deepEqual(catalog.sets.find((s) => s.key === 'all_plus').columns, [...INITIAL_SHEET_COLUMNS.filter((c) => c.legacy_position).map((c) => c.column_key), ...ADDITIONAL_KEYS]);
});

test('追加採用は管理者・理由必須で監査に残り、再採用しても版を増やさない', async () => {
  assert.equal((await editor('/sales-sheet/columns/adopt-additional', {reason: '試験（架空）'})).status, 403);
  assert.equal((await admin('/sales-sheet/columns/adopt-additional', {reason: ''})).status, 400);
  const before = await db.all('SELECT * FROM sales_sheet_column_versions ORDER BY org_id,column_key,version_no');
  const auditsBefore = await db.all('SELECT * FROM audit_log ORDER BY id');
  assert.deepEqual(await ok('/sales-sheet/columns/adopt-additional', {reason: '再試行（架空）'}), {ok: true, adopted: 0});
  assert.deepEqual(await db.all('SELECT * FROM sales_sheet_column_versions ORDER BY org_id,column_key,version_no'), before);
  assert.deepEqual(await db.all('SELECT * FROM audit_log ORDER BY id'), auditsBefore);
  const audit = await db.all("SELECT detail_json FROM audit_log WHERE entity_type='sales_sheet_column' AND action='adopt'");
  const additional = audit.map((r) => JSON.parse(r.detail_json)).filter((r) => r.template === 'sales-sheet-additional-v1');
  assert.equal(additional.length, 1);
  assert.equal(additional[0].columns, 28);
  assert.equal((await ok('/sales-sheet/columns')).additionalPending, 0);
});

test('販売期間・報告期間・原数量・計上基準と理由・4つの根拠日を正本から分けて読む', async () => {
  const row = (await additionalRows('DIGITAL'))[0];
  assert.equal(row.sales_period_to, '2026-05-29');
  assert.equal(row.report_period_from, '2026-04-01');
  assert.equal(row.report_period_to, '2026-06-30');
  assert.equal(row.raw_quantity, 7);
  assert.equal(row.recognition_basis_id, 2);
  assert.equal(row.recognition_reason, '受領月で計上（架空）');
  assert.deepEqual([row.report_received_on, row.recognition_contract_start_on, row.license_start_on, row.broadcast_on], ['2026-05-30', '2026-02-03', '2026-03-04', '2026-04-05']);
  assert.equal(row.report_status, '有効');
  assert.equal(row.supersedes_report_id, null);
  assert.equal(row.source_row_number, 2);
  assert.equal(row.source_reference_id, null, '直接取込には存在しない原本参照を捏造しない');
});

test('流通と為替・ロイヤリティは最新の版を読み、独立税額と売上税額の代用を区別する', async () => {
  const row = (await additionalRows('DIGITAL'))[0];
  assert.deepEqual([row.distribution_version, row.settlement_method, row.service_code, row.channel_model], [2, 'MG', 'DEMO-SERVICE', 'svod']);
  assert.deepEqual([row.currency_rate_date, row.currency_basis, row.currency_version], ['2026-05-31', '改定レートの根拠(架空)', 2]);
  assert.deepEqual([row.royalty_tax_amount, row.royalty_basis_version, row.royalty_basis_origin], [500 * 0.1, 2, '独立した基準']);
  const other = (await additionalRows('PACKAGE'))[0];
  assert.deepEqual([other.royalty_tax_amount, other.royalty_basis_version, other.royalty_basis_origin], [1200 * 0.1, null, '売上額を代用']);
  assert.deepEqual([other.currency_rate_date, other.currency_basis, other.currency_version, other.distribution_version], [null, null, null, null]);
  const detail = await ok(`/sales-sheet/sales/${ids.digital.id}`);
  assert.equal(detail.values.recognition_reason, row.recognition_reason, '行を開いた詳細にも根拠が出る');
});

test('3種類の流通詳細で原報告実績・計上・独立計算値を分け、レンタル回数は回転率と混同しない', async () => {
  const digital = (await additionalRows('DIGITAL'))[0];
  assert.deepEqual([digital.reported_actual_ex_tax, digital.reported_recognized_ex_tax, digital.calculated_actual_ex_tax], [2500, 1200, 100 * 12]);
  const rental = (await additionalRows('PACKAGE'))[0];
  assert.deepEqual([rental.reported_actual_ex_tax, rental.reported_recognized_ex_tax, rental.calculated_actual_ex_tax, rental.package_turns_count], [1700, 0, 8 * 150, 8]);
  const theatre = (await additionalRows('THEATRICAL'))[0];
  assert.deepEqual([theatre.channel_model, theatre.reported_actual_ex_tax, theatre.reported_recognized_ex_tax, theatre.calculated_actual_ex_tax], ['theatrical_rs', 3000, 1200, null]);
  assert.equal(digital.package_turns_count, null);
});

test('未登録はNULL、原数量と税額の0は0。追加金額・数量を合計しない', async () => {
  const zero = (await additionalRows('ZERO'))[0];
  const empty = (await additionalRows('NULL'))[0];
  assert.equal(zero.raw_quantity, 0);
  assert.equal(empty.raw_quantity, null);
  assert.equal(zero.royalty_tax_amount, 0);
  assert.equal(zero.reported_actual_ex_tax, null);
  const group = await ok('/sales-sheet?set=all_plus&hideEmpty=0&q=DEMO-REQ5-&grain=aggregate');
  assert.equal(group.totals.amount_ex_tax, 4 * 1200);
  assert.equal(group.totals.reported_actual_ex_tax, '3種類');
  assert.equal(group.totals.reported_recognized_ex_tax, '2種類');
  assert.equal(group.totals.raw_quantity, '2種類');
  assert.equal(group.totals.royalty_tax_amount, '3種類');
  assert.equal((await admin('/sales-sheet/columns/reported_actual_ex_tax/versions', {baseVersion: 1, aggregation: 'sum', reason: '合算禁止の確認（架空）'})).status, 400);
  assert.equal((await admin('/sales-sheet/values', {reason: '参照値の変更禁止（架空）', changes: [{saleId: ids.digital.id, columnKey: 'raw_quantity', baseVersion: 0, value: 99}]})).status, 400);
});

test('追加と全列＋追加がCSV・Excelの見出し・明細・条件定義に反映される', async () => {
  for (const [set, count] of [['additional', 28], ['all_plus', 111]]) {
    const csv = parseCsv(await ok(`/sales-sheet/export-selected.csv?set=${set}&q=DEMO-REQ5-DIGITAL&hideEmpty=0`));
    assert.equal(Object.keys(csv[0].values).length, count);
    assert.equal(csv[0].values['販売期間末日'], '2026/05/29');
    assert.equal(csv[0].values['原報告の実績額（税抜）'], '2500');
    assert.equal(csv[0].values['ロイヤリティ計上の税額'], '50');
    const sheets = decodeXlsx(await ok(`/sales-sheet/export.xlsx?set=${set}&q=DEMO-REQ5-DIGITAL&hideEmpty=0`));
    const headerAt = sheets[0].rows.findIndex((row) => row.includes('販売期間末日'));
    const header = sheets[0].rows[headerAt];
    assert.equal(header.length, count);
    assert.equal(Number(sheets[0].rows[headerAt + 1][header.indexOf('原報告の実績額（税抜）')]), 2500);
    assert.ok(sheets[1].rows.some((row) => row.includes('reported_actual_ex_tax') && row.includes('種類の数')));
  }
});

test('追加列セットを保存して再現でき、定義一覧に型・意味・取得元が揃う', async () => {
  const catalog = await ok('/sales-sheet/columns');
  const columns = catalog.sets.find((s) => s.key === 'additional').columns;
  const view = await ok('/sales-sheet/views', {name: '根拠を確認する形（架空）', reason: '追加列保存（架空）', definition: {columns, grain: 'detail'}}, 201);
  const saved = (await ok('/sales-sheet/views')).views.find((v) => v.id === view.id);
  assert.deepEqual(saved.definition.columns, columns);
  assert.deepEqual((await ok(`/sales-sheet?columns=${columns.join(',')}&hideEmpty=0&q=DEMO-REQ5-DIGITAL`)).rows, await additionalRows('DIGITAL'));
  for (const key of columns) {
    const column = catalog.columns.find((c) => c.key === key);
    assert.equal(column.sourceKind, 'core');
    assert.ok(column.sourceRef && column.description && column.valueType);
    assert.equal(column.legacyPosition, null);
  }
});

test('追加列と出力にも既存の財務権限・組織境界を適用する', async () => {
  for (const path of ['/sales-sheet?set=additional', '/sales-sheet/columns', '/sales-sheet/export.xlsx?set=all_plus', '/sales-sheet/export-selected.csv?set=additional']) {
    assert.equal((await production(path)).status, 403);
  }
  const visible = await editor('/sales-sheet?set=additional&hideEmpty=0&q=DEMO-REQ5-');
  assert.equal(visible.status, 200);
  const otherOrg = await db.get('SELECT id FROM organizations WHERE id<>1 LIMIT 1');
  if (otherOrg) assert.equal((await db.get('SELECT COUNT(*) AS n FROM sales_sheet_column_versions WHERE org_id=? AND column_key=?', [otherOrg.id, 'raw_quantity'])).n, 0);
  const deniedWork = await editor('/sales-sheet?set=additional&workId=999999');
  assert.equal(deniedWork.status, 403);
});

test('FR-REV-ROLL-008 訂正後は有効報告だけを読み、訂正元IDを表示して旧額を二重計上しない', async () => {
  const old = await importOne('DEMO-REQ5-CORRECTION', 'other', {amount_ex_tax: 900, tax_amount: 90, amount_inc_tax: 990});
  const current = await importOne('DEMO-REQ5-CORRECTION', 'other', {supersedes_id: old.report_id, amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100});
  const sheet = await ok('/sales-sheet?set=all_plus&hideEmpty=0&q=DEMO-REQ5-CORRECTION');
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheet.rows[0].__id, current.id);
  assert.equal(sheet.rows[0].supersedes_report_id, old.report_id);
  assert.equal(sheet.rows[0].report_status, '有効');
  assert.equal(sheet.totals.amount_ex_tax, 1000);
});

test('既存の独自列とキーが衝突すると、追加採用を全件止めて独自列を保持する', async (t) => {
  const isolated = await openTestDb({t});
  try {
    const call = await login('admin@openingnight.invalid', createApp({db: isolated, mode: 'local'}));
    assert.equal((await call('/sales-sheet/columns/adopt', {reason: '互換確認（架空）'})).status, 201);
    assert.equal((await call('/sales-sheet/columns', {columnKey: 'raw_quantity', label: '独自の数量（架空）', groupKey: 'custom', valueType: 'integer', aggregation: 'sum', reason: '既存定義（架空）'})).status, 201);
    const result = await call('/sales-sheet/columns/adopt-additional', {reason: '衝突確認（架空）'});
    assert.equal(result.status, 409);
    assert.match(result.body.error, /raw_quantity/);
    const catalog = (await call('/sales-sheet/columns')).body;
    assert.equal(catalog.columns.length, 104);
    assert.equal(catalog.columns.find((c) => c.key === 'raw_quantity').sourceKind, 'attribute');
  } finally { await isolated.close(); }
});

test('取込の来歴がある行には種類付きの追跡参照を出し、原本の内容を列へ展開しない', async () => {
  const profile = await ok('/mapping-profiles', {partnerId: 2, kind: 'digital', name: '列対応（架空）'}, 201);
  const version = await ok(`/mapping-profiles/${profile.id}/versions`, {ignoredColumns: [], mappings: [
    {target: 'report_key', mode: 'source', source: '報告番号'}, {target: 'partner_id', mode: 'literal', valueType: 'integer', value: '2'},
    {target: 'period_from', mode: 'source', source: '開始'}, {target: 'period_to', mode: 'source', source: '終了'},
    {target: 'accounting_month', mode: 'source', source: '計上月'},
    {target: 'amount_ex_tax', mode: 'source', source: '税抜'}, {target: 'tax_amount', mode: 'source', source: '税'}, {target: 'amount_inc_tax', mode: 'source', source: '税込'},
  ]}, 201);
  const preview = await ok('/mapped-imports/preview', {workId: 1, mappingVersionId: version.id, text: toCsv(['報告番号', '開始', '終了', '計上月', '税抜', '税', '税込'], [['DEMO-REQ5-SOURCE', '2026-05-01', '2026-05-31', '2026-05', 100, 10, 110]])});
  assert.equal(preview.ok, true, JSON.stringify(preview));
  await ok('/mapped-imports/commit', {token: preview.token});
  const row = (await additionalRows('SOURCE'))[0];
  const sale = await db.get('SELECT report_id FROM sale_lines WHERE id=?', [row.__id]);
  assert.equal(row.source_reference_id, `mapping:report:${sale.report_id}:version:${version.id}`);
  assert.equal(row.source_row_number, 2);
});
