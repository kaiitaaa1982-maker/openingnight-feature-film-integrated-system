import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {buildAnnualDashboard, monthsBetween, billedAt, dashboardSummary} from '../src/reports/annual-dashboard-model.mjs';

test('dashboard model: flows by month, voids and reversals in their own month, month-end balances', () => {
  const months = monthsBetween('2026-08', '2026-11');
  const sales = [
    {id: 1, accounting_month: '2026-08', sales_month: '2026-07', amount: 110000, invoices: [{invoice_date: '2026-09-10', voided_on: '2026-10-02'}, {invoice_date: '2026-10-05', voided_on: null}]},
    {id: 2, accounting_month: '2026-09', sales_month: '2026-09', amount: 220000, invoices: []},
    {id: 3, accounting_month: '2026-12', sales_month: '2026-11', amount: 33000, invoices: []},
  ];
  const invoices = [
    {id: 10, invoice_date: '2026-09-10', voided_on: '2026-10-02', amount: 110000},
    {id: 11, invoice_date: '2026-10-05', voided_on: null, amount: 110000},
  ];
  const receipts = [
    {invoice_id: 11, received_on: '2026-10-20', reversed_on: '2026-11-03', amount: 50000},
    {invoice_id: 11, received_on: '2026-11-10', reversed_on: null, amount: 60000},
  ];
  const r = buildAnnualDashboard({months, sales, invoices, receipts, previousSalesTotal: 165000});
  assert.deepEqual(r.series.salesAccounting, [110000, 220000, 0, 0]);
  assert.deepEqual(r.series.salesSales, [0, 220000, 0, 33000], 'sales month counts the line whose accounting month is after the period');
  assert.deepEqual(r.series.billed, [0, 110000, 0, 0], 'the void is subtracted in October, where the re-issue is added');
  assert.deepEqual(r.series.received, [0, 0, 50000, 10000], 'the reversal is subtracted in November');
  assert.deepEqual(r.rows.map((row) => row.unbilled), [110000, 220000, 220000, 220000], 'sale 1 is billed from September; the void and re-issue keep it billed at the October end');
  assert.deepEqual(r.rows.map((row) => row.unpaid), [0, 110000, 60000, 50000]);
  assert.equal(r.kpis.sales, 330000);
  assert.equal(r.kpis.yoy, 2);
  assert.equal(r.attention.length, 2);
  assert.match(r.attention[0].message, /2026年11月末/);
  assert.equal(billedAt(sales[0], '2026-10-03'), false, 'between the void and the re-issue the sale is unbilled');
  assert.match(dashboardSummary(r, (v) => `${v}円`), /^売上 330000円・請求 110000円・入金 60000円・未請求 220000円・未入金 50000円$/);
});

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const ok = (r) => { assert.ok(r.status < 300 && r.data.ok !== false, JSON.stringify(r.data)); return r.data; };
  const sale = async (key, month, received, amount) => ok(await req('/sales', {workId: 1, report_key: key, kind: 'digital', partner_id: 2, product_id: 1, period_from: `${month}-01`, period_to: `${month}-28`,
    recognition_basis_id: 2, report_received_on: received, basis_reason: '架空の報告受領月', description: '架空配信売上', quantity: 1, amount_ex_tax: amount, tax_amount: amount / 10, amount_inc_tax: amount + amount / 10}));
  await sale('DASH-1', '2026-08', '2026-09-05', 100000);
  await sale('DASH-2', '2026-09', '2026-10-05', 200000);
  const reportId = async (key) => (await req('/reports?workId=1')).data.rows.find((row) => row.report_key === key).id;
  const invoice = ok(await req('/billing/invoices', {workId: 1, reportIds: [await reportId('DASH-1')], invoiceDate: '2026-09-10', dueDate: '2026-10-31', sourceAmountBasis: 'platform_net'}));
  ok(await req('/billing/receipts', {partnerId: 2, reference: 'DASH-PAY-1', receivedOn: '2026-10-20', amountYen: 50000, allocations: [{invoiceId: invoice.invoiceId, amountYen: 50000}]}));
  return {db, req, ok, login};
}

test('annual dashboard API matches the annual sales report and the receivables, and keeps the permission boundary', async (t) => {
  const f = await fixture({t});
  const r = f.ok(await f.req('/reports/annual-dashboard?from=2026-09&to=2026-11'));
  assert.deepEqual(r.months, ['2026-09', '2026-10', '2026-11']);
  assert.deepEqual(r.values.salesAccounting, [110000, 220000, 0]);
  assert.deepEqual(r.values.billed, [110000, 0, 0]);
  assert.deepEqual(r.values.received, [0, 50000, 0]);
  assert.equal(r.kpis.unbilledAtEnd, 220000, 'the October report is not invoiced yet');
  assert.equal(r.kpis.unpaidAtEnd, 60000);
  const annual = f.ok(await f.req('/reports/annual-sales?from=2026-09&to=2026-11&tax=inc'));
  assert.equal(r.kpis.sales, annual.totals.total, 'same total as the annual sales report (tax included)');
  const balance = f.ok(await f.req('/reports/partner-balance?from=2026-09&to=2026-11'));
  assert.equal(r.kpis.received, balance.totals.receiptTotal);
  assert.equal(r.kpis.unbilledAtEnd, balance.totals.unbilledAtEnd);
  const receivables = f.ok(await f.req('/billing/receivables?asOf=2026-11-30'));
  assert.equal(r.kpis.unpaidAtEnd, receivables.totals.balance);
  assert.equal((await f.req('/reports/annual-dashboard?from=2026-09&to=2026-08')).status, 400);
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req('/reports/annual-dashboard?from=2026-09&to=2026-11', null, production)).status, 403);
  const outsider = await f.login('outsider@other.invalid');
  const other = f.ok(await f.req('/reports/annual-dashboard?from=2026-09&to=2026-11', null, outsider));
  assert.equal(other.kpis.sales, 0, 'another organization sees none of these numbers');
});

test('an invoice voided after the period end still counts as billed at that period end (partner balance and dashboard agree)', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const cookie = (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})})).headers.get('set-cookie').split(';')[0];
  const req = async (path, body, headers = {}) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json', ...headers}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const sale = await req('/sales', {workId: 1, report_key: 'VOID-LATE', kind: 'digital', partner_id: 2, product_id: 1, period_from: '2026-09-01', period_to: '2026-09-28',
    recognition_basis_id: 2, report_received_on: '2026-09-05', basis_reason: '架空の報告受領月', description: '架空配信売上', quantity: 1, amount_ex_tax: 100000, tax_amount: 10000, amount_inc_tax: 110000});
  assert.ok(sale.status < 300, JSON.stringify(sale.data));
  const reportId = (await req('/reports?workId=1')).data.rows.find((row) => row.report_key === 'VOID-LATE').id;
  const invoice = await req('/billing/invoices', {workId: 1, reportIds: [reportId], invoiceDate: '2026-09-10', dueDate: '2026-10-31', sourceAmountBasis: 'platform_net'});
  assert.ok(invoice.status < 300, JSON.stringify(invoice.data));
  const voided = await req(`/billing/invoices/${invoice.data.invoiceId}/void`, {voidedOn: '2026-10-15', reason: '架空の取消'}, {'If-Match': '1'});
  assert.ok(voided.status < 300, JSON.stringify(voided.data));
  const september = (await req('/reports/partner-balance?from=2026-09&to=2026-09')).data;
  assert.equal(september.totals.unbilledAtEnd, 0, 'billed on 9/10 and voided only on 10/15, so nothing was unbilled at the end of September');
  const october = (await req('/reports/partner-balance?from=2026-09&to=2026-10')).data;
  assert.equal(october.totals.unbilledAtEnd, 110000, 'after the void it is unbilled again');
  const dashboard = (await req('/reports/annual-dashboard?from=2026-09&to=2026-10')).data;
  assert.deepEqual(dashboard.rows.map((row) => row.unbilled), [0, 110000]);
});
