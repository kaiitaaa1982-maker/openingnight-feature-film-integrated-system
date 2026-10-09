import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {buildPartnerBalance, buildReceivables, agingBucket} from '../src/billing/receivables.mjs';

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
  await sale('RCV-1', '2026-08', '2026-09-05', 100000);
  await sale('RCV-2', '2026-09', '2026-10-05', 200000);
  const reportId = async (key) => (await req('/reports?workId=1')).data.rows.find((row) => row.report_key === key).id;
  const invoice = ok(await req('/billing/invoices', {workId: 1, reportIds: [await reportId('RCV-1')], invoiceDate: '2026-09-10', dueDate: '2026-10-31', sourceAmountBasis: 'platform_net'}));
  ok(await req('/billing/receipts', {partnerId: 2, reference: 'RCV-PAY-1', receivedOn: '2026-10-20', amountYen: 50000, allocations: [{invoiceId: invoice.invoiceId, amountYen: 50000}]}));
  return {db, req, ok, login, invoice};
}

test('partner balance: previous balance + sales - receipts = balance, with unbilled sales kept', async (t) => {
  const f = await fixture({t});
  const r = f.ok(await f.req('/reports/partner-balance?from=2026-09&to=2026-11'));
  assert.deepEqual(r.months, ['2026-09', '2026-10', '2026-11']);
  const row = r.rows.find((x) => x.partnerName === '架空配信');
  assert.equal(row.opening, 0, 'nothing recognized before September (accounting month = report received month)');
  assert.deepEqual(row.sales, [110000, 220000, 0]);
  assert.deepEqual(row.receipts, [0, 50000, 0]);
  assert.deepEqual(row.balances, [110000, 280000, 280000]);
  assert.equal(row.unbilledAtEnd, 220000, 'the October report is not invoiced yet');
  assert.equal(r.checks[0].value, 0);
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req('/reports/partner-balance?from=2026-09&to=2026-11', null, production)).status, 403);
  assert.equal((await f.req('/reports/partner-balance?from=2026-11&to=2026-09')).status, 400);
});

test('receivables list: balance, status and aging as of a date', async (t) => {
  const f = await fixture({t});
  const before = f.ok(await f.req('/billing/receivables?asOf=2026-10-15'));
  assert.equal(before.rows[0].status, '未入金');
  assert.equal(before.rows[0].aging, '期日前');
  const after = f.ok(await f.req('/billing/receivables?asOf=2026-11-30'));
  assert.equal(after.rows[0].received, 50000);
  assert.equal(after.rows[0].balance, f.invoice.amountIncTax - 50000);
  assert.match(after.rows[0].status, /^一部入金・期日超過30日$/);
  assert.equal(after.rows[0].aging, '1〜30日');
  assert.equal(after.totals.overdue, after.rows[0].balance);
});

test('pure helpers', () => {
  assert.equal(agingBucket(null), '—');
  assert.equal(agingBucket(91), '90日超');
  const b = buildPartnerBalance({from: '2026-01', to: '2026-02', sales: [{partner_id: 1, partner_name: 'A', month: '2025-12', amount: 100}], receipts: [{partner_id: 1, partner_name: 'A', month: '2026-02', amount: 40}]});
  assert.deepEqual(b.rows[0].balances, [100, 60]);
  const r = buildReceivables({asOf: '2026-01-10', invoices: [{id: 1, invoice_date: '2026-01-01', due_date: '2026-01-31', amount_inc_tax: 10, voided_on: '2026-01-05'}]});
  assert.equal(r[0].status, '取消済み');
  assert.equal(r[0].balance, 0);
});

test('売掛金の期日超過は、基準日までに承認された入金予定日から数える（請求・入金と同じ基準）', async (t) => {
  const f = await fixture({t});
  f.ok(await f.req('/receipt-plan/requests', {invoiceId: f.invoice.invoiceId, baseVersion: 0, proposedDueDate: '2026-12-31', reason: '架空の支払延長の連絡'}));
  const request = await f.db.get('SELECT id FROM receipt_plan_requests WHERE invoice_id=?', [f.invoice.invoiceId]);
  f.ok(await f.req(`/receipt-plan/requests/${request.id}/decide`, {decision: 'approved', effectiveOn: '2026-11-10', reason: '架空の承認'}));
  const moved = f.ok(await f.req('/billing/receivables?asOf=2026-11-30'));
  assert.deepEqual([moved.rows[0].dueDate, moved.rows[0].plannedDate, moved.rows[0].status, moved.rows[0].aging, moved.totals.overdue],
    ['2026-10-31', '2026-12-31', '一部入金', '期日前', 0]);
  const beforeApproval = f.ok(await f.req('/billing/receivables?asOf=2026-11-05'));
  assert.deepEqual([beforeApproval.rows[0].plannedDate, beforeApproval.rows[0].status], ['2026-10-31', '一部入金・期日超過5日'], '承認の適用日より前の基準日では元の期日');
});
