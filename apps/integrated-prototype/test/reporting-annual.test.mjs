import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {buildAnnualSales, monthsBetween, periodBuckets, shiftMonth} from '../src/reports/annual-sales-model.mjs';

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  async function login(email) {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const admin = await login('admin@openingnight.invalid');
  async function req(path, body, {cookie = admin, method} = {}) {
    const response = await app.request(`/api${path}`, {method: method || (body ? 'POST' : 'GET'), headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  }
  const ok = (result) => { assert.ok(result.status < 300 && result.data.ok !== false, JSON.stringify(result.data)); return result.data; };
  // 架空の2作品目と、2作品へ半分ずつ配賦した商品
  const work2 = ok(await req('/works', {project_id: 1, code: 'WRK-ANNUAL-2', title: '架空の二作目', format: 'film'}));
  const product = ok(await req('/products', {sku: 'SKU-SHARED', name: '架空の共有商品', channel: 'digital'}));
  ok(await req('/product-works', {productId: product.id, allocations: [{workId: 1, allocationBps: 5000}, {workId: work2.id, allocationBps: 5000}]}));
  const sale = (key, fields) => req('/sales', {workId: 1, report_key: key, kind: 'digital', description: '架空売上', quantity: 1, basis_reason: '架空の根拠', ...fields});
  // 計上月 2026-06（販売月基準）
  ok(await sale('ANNUAL-1', {partner_id: 2, product_id: 1, period_from: '2026-06-01', period_to: '2026-06-30', recognition_basis_id: 1, sales_month: '2026-06', amount_ex_tax: 100000, tax_amount: 10000, amount_inc_tax: 110000}));
  // 報告受領で計上月 2026-08、販売月の記録なし（販売期間の開始月 2026-06 を推定）。共有商品で2作品へ配賦（奇数円）
  ok(await sale('ANNUAL-2', {partner_id: 2, product_id: product.id, period_from: '2026-06-01', period_to: '2026-06-30', recognition_basis_id: 2, report_received_on: '2026-08-05', amount_ex_tax: 30001, tax_amount: 3000, amount_inc_tax: 33001}));
  // 別の取引先・パッケージ
  ok(await sale('ANNUAL-3', {kind: 'package', partner_id: 3, product_id: 2, period_from: '2026-11-01', period_to: '2026-11-30', recognition_basis_id: 1, sales_month: '2026-11', amount_ex_tax: 70000, tax_amount: 7000, amount_inc_tax: 77000}));
  // 前年（2025-07）
  ok(await sale('ANNUAL-PREV', {partner_id: 2, product_id: 1, period_from: '2025-07-01', period_to: '2025-07-31', recognition_basis_id: 1, sales_month: '2025-07', amount_ex_tax: 50000, tax_amount: 5000, amount_inc_tax: 55000}));
  return {db, app, req, ok, login, work2};
}

const q = (params) => `/reports/annual-sales?${new URLSearchParams({from: '2026-05', to: '2027-04', ...params})}`;

test('FR-REV-ROLL-006 FR-REV-ROLL-007 FR-REV-ROLL-016 annual sales reconcile with the existing report center and with the lines, by every axis', async (t) => {
  const f = await fixture({t});
  const center = f.ok(await f.req('/report-center?start=2026-05'));
  for (const axis of ['total', 'work', 'partner', 'distribution', 'product', 'partner-distribution', 'deal']) {
    const r = f.ok(await f.req(q({axis})));
    assert.equal(r.totals.total, center.total, axis);
    assert.equal(r.totals.total, 200001, axis);
    assert.equal(r.integrity.diff, 0, axis);
    assert.equal(r.rows.reduce((sum, row) => sum + row.total, 0), r.totals.total, axis);
    for (let m = 0; m < 12; m += 1) assert.equal(r.rows.reduce((sum, row) => sum + row.values[m], 0), r.totals.values[m], `${axis}:${m}`);
    assert.equal(r.totals.quarters.reduce((a, b) => a + b, 0), r.totals.total, axis);
    assert.deepEqual(r.quarters, ['第1四半期', '第2四半期', '第3四半期', '第4四半期']);
    assert.equal(r.totals.halves[0] + r.totals.halves[1], r.totals.total);
  }
  const byWork = f.ok(await f.req(q({axis: 'work'})));
  assert.equal(byWork.rows.find((row) => row.label === '架空の二作目').total, 15000);
  assert.equal(byWork.rows.find((row) => row.label === '風のあとさき').total, 185001);
  const pd = f.ok(await f.req(q({axis: 'partner-distribution'})));
  assert.equal(pd.subtotals.reduce((sum, row) => sum + row.total, 0), pd.totals.total);
  assert.equal(pd.fiscal.fiscalStartMonth, 5);
  assert.equal(pd.fiscal.confirmed, false);
  assert.ok(pd.dataAsOf.latestImportAt);
});

test('FR-REV-ROLL-013 FR-REV-ROLL-014 sales-month basis moves lines, estimates missing sales months, and tax-inclusive uses allocated inc-tax amounts', async (t) => {
  const f = await fixture({t});
  const accounting = f.ok(await f.req(q({axis: 'total'})));
  const aug = accounting.months.indexOf('2026-08');
  const jun = accounting.months.indexOf('2026-06');
  assert.equal(accounting.totals.values[aug], 30001);
  const sales = f.ok(await f.req(q({axis: 'total', basis: 'sales'})));
  assert.equal(sales.totals.values[aug], 0);
  assert.equal(sales.totals.values[jun], 130001);
  assert.equal(sales.estimatedSalesMonthLines, 2);
  const inc = f.ok(await f.req(q({axis: 'total', tax: 'inc'})));
  assert.equal(inc.totals.total, 110000 + 33001 + 77000);
});

test('FR-REV-ROLL-009 FR-REV-ROLL-015 previous year, share, drill-down and filters', async (t) => {
  const f = await fixture({t});
  const r = f.ok(await f.req(q({axis: 'partner'})));
  const digital = r.rows.find((row) => row.label === '架空配信');
  assert.equal(digital.prevTotal, 50000);
  assert.equal(digital.total, 130001);
  assert.ok(Math.abs(digital.yoy - (130001 / 50000 - 1)) < 1e-9);
  assert.ok(Math.abs(r.rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  const lines = f.ok(await f.req(`/reports/annual-sales/lines?${new URLSearchParams({from: '2026-05', to: '2027-04', axis: 'partner', key: digital.key, month: '2026-06'})}`));
  assert.equal(lines.count, 1);
  assert.equal(lines.total, 100000);
  const filtered = f.ok(await f.req(q({axis: 'total', partnerId: '3'})));
  assert.equal(filtered.totals.total, 70000);
  const byWork = f.ok(await f.req(q({axis: 'total', workId: String(f.work2.id)})));
  assert.equal(byWork.totals.total, 15000);
});

test('FR-REV-ROLL-017 permissions and validation', async (t) => {
  const f = await fixture({t});
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req(q({}), null, {cookie: production})).status, 403);
  assert.equal((await f.req(`/reports/annual-sales/lines?from=2026-05&to=2027-04`, null, {cookie: production})).status, 403);
  assert.equal((await f.req('/reports/annual-sales?from=2026-13&to=2027-04')).status, 400);
  assert.equal((await f.req('/reports/annual-sales?from=2027-05&to=2026-04')).status, 400);
  const outsider = await f.login('outsider@other.invalid');
  const other = f.ok(await f.req(q({}), null, {cookie: outsider}));
  assert.equal(other.totals.total, 0);
});

test('FR-REV-ROLL-016 fiscal settings: default May start, admin-only change, audited', async (t) => {
  const f = await fixture({t});
  assert.equal(f.ok(await f.req('/settings/fiscal')).setting.fiscalStartMonth, 5);
  const editor = await f.login('editor@openingnight.invalid');
  assert.equal((await f.req('/settings/fiscal', {fiscalStartMonth: 4}, {cookie: editor, method: 'PUT'})).status, 403);
  assert.equal((await f.req('/settings/fiscal', {fiscalStartMonth: 13}, {method: 'PUT'})).status, 400);
  const saved = f.ok(await f.req('/settings/fiscal', {fiscalStartMonth: 4, confirmed: true}, {method: 'PUT'}));
  assert.deepEqual([saved.setting.fiscalStartMonth, saved.setting.confirmed], [4, true]);
  assert.equal(f.ok(await f.req('/settings/fiscal', null, {cookie: editor})).setting.fiscalStartMonth, 4);
  assert.ok(await f.db.get("SELECT 1 FROM audit_log WHERE entity_type='fiscal_settings'"));
});

test('FR-REV-ROLL-012 model: buckets only for 12 months, future months flagged, rows without amounts dropped', () => {
  assert.deepEqual(periodBuckets(monthsBetween('2026-05', '2026-10')), {quarters: [], halves: []});
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  const months = monthsBetween('2026-05', '2027-04');
  const r = buildAnnualSales([{month: '2026-05', amount: 5, partner_id: 1, partner_name: 'A'}, {month: '2026-06', amount: 0, partner_id: 2, partner_name: 'B'}],
    {months, axis: 'partner', currentMonth: '2026-09'});
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.future.slice(3, 6), [false, false, true]);
  assert.deepEqual(r.totals.cumulative.slice(0, 2), [5, 5]);
});
