import {ensureExpenseDemoSettings,demoAccounting,fictionalInvoice} from '../scripts/seed-expense-support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerWorkPnlRoutes} from '../src/work-pnl-report-routes.mjs';
import {buildWorkPnl, checksOk, salesDetailParams, workPnlLinkParams, incomeRows, incomeTotals, monthAxisLabels, EXPENSE_ONLY_CARD, productionCostOf} from '../src/reports/work-pnl-model.mjs';

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  registerWorkPnlRoutes(app, app.ux);
  async function login(email) {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const admin = await login('admin@openingnight.invalid');
  async function req(path, body, {cookie = admin} = {}) {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  }
  const ok = (result) => { assert.ok(result.status < 300 && result.data.ok !== false, JSON.stringify(result.data)); return result.data; };
  // 架空の2作品目と、2作品へ 60:40 で配賦した商品（奇数円で端数の行き先を確かめる）
  const work2 = ok(await req('/works', {project_id: 1, code: 'WRK-PNL-2', title: '架空の二作目', format: 'film'}));
  const shared = ok(await req('/products', {sku: 'SKU-PNL-SHARED', name: '架空の共有商品', channel: 'digital'}));
  ok(await req('/product-works', {productId: shared.id, allocations: [{workId: 1, allocationBps: 6000}, {workId: work2.id, allocationBps: 4000}]}));
  const sale = (key, fields) => req('/sales', {workId: 1, report_key: key, kind: 'digital', description: '架空売上', quantity: 1, basis_reason: '架空の根拠', recognition_basis_id: 1, ...fields});
  ok(await sale('PNL-1', {partner_id: 2, product_id: 1, period_from: '2026-06-01', period_to: '2026-06-30', sales_month: '2026-06', amount_ex_tax: 100000, tax_amount: 10000, amount_inc_tax: 110000}));
  ok(await sale('PNL-2', {partner_id: 2, product_id: shared.id, period_from: '2026-07-01', period_to: '2026-07-31', sales_month: '2026-07', amount_ex_tax: 30001, tax_amount: 3000, amount_inc_tax: 33001}));
  ok(await sale('PNL-3', {kind: 'package', partner_id: 3, product_id: 2, period_from: '2026-11-01', period_to: '2026-11-30', sales_month: '2026-11', amount_ex_tax: 70000, tax_amount: 7000, amount_inc_tax: 77000}));
  ok(await sale('PNL-OUT', {partner_id: 2, product_id: 1, period_from: '2027-06-01', period_to: '2027-06-30', sales_month: '2027-06', amount_ex_tax: 999999, tax_amount: 99999, amount_inc_tax: 1099998}));
  const settings = await ensureExpenseDemoSettings(db,1,async(p,b)=>ok(await req(p,b)));
  let expenseNumber=0;
  const expense = (fields) => req('/expenses', {partner_id:settings.payee, reason:'検証（架空）', invoice:fictionalInvoice('DEMO-PNL-'+(++expenseNumber),`${fields.accounting_month}-10`), accounting:demoAccounting(settings,fields.category==='宣伝費'||!fields.category?'宣伝費':'事務費',0), project_id: 1, incurred_on: `${fields.accounting_month}-10`, category: '宣伝費', description: '架空の経費', tax_amount: 0, actual_inc_tax: fields.actual_ex_tax, ...fields});
  ok(await expense({work_id: 1, accounting_month: '2026-06', actual_ex_tax: 40000}));
  ok(await expense({work_id: 1, accounting_month: '2026-12', actual_ex_tax: 15000, category: '外注費'}));
  ok(await expense({work_id: 1, accounting_month: '2027-07', actual_ex_tax: 5000})); // 期間外
  ok(await expense({work_id: null, accounting_month: '2026-08', actual_ex_tax: 22000, category: '共通費', description: '架空の共通経費'})); // 未配賦
  ok(await expense({work_id: work2.id, accounting_month: '2026-07', actual_ex_tax: 3000}));
  return {db, app, req, ok, login, work2};
}

const q = (params) => `/reports/work-pnl?${new URLSearchParams({from: '2026-05', to: '2027-04', ...params})}`;

test('work P&L sales match the annual sales report and the report center for the same work and period', async (t) => {
  const f = await fixture({t});
  for (const workId of [1, f.work2.id]) {
    const pnl = f.ok(await f.req(q({workId})));
    const annual = f.ok(await f.req(`/reports/annual-sales?${new URLSearchParams({from: '2026-05', to: '2027-04', workId, axis: 'total'})}`));
    assert.equal(pnl.totals.sales, annual.totals.total, `work ${workId}`);
    const center = f.ok(await f.req(`/report-center?start=2026-05&workId=${workId}`));
    const row = center.profitLoss.find((r) => r.workId === workId);
    assert.equal(pnl.totals.sales, row.income, `work ${workId} income`);
    assert.equal(pnl.totals.expense, row.expense, `work ${workId} expense`);
    assert.equal(pnl.totals.balance, row.balance, `work ${workId} balance`);
    assert.ok(checksOk(pnl.checks), JSON.stringify(pnl.checks));
    assert.equal(pnl.monthly.length, 12, 'every month of the period has a row');
  }
  const one = f.ok(await f.req(q({workId: 1})));
  // 共有商品 30,001円 の 60% = 18,001円（端数の行き先は既存の配賦と同じ）
  assert.equal(one.totals.sales, 100000 + 18001 + 70000);
  assert.equal(one.totals.expense, 55000, 'out-of-period expenses are excluded');
  assert.equal(one.totals.balance, 188001 - 55000);
  const two = f.ok(await f.req(q({workId: f.work2.id})));
  assert.equal(two.totals.sales, 12000);
  assert.equal(one.totals.sales + two.totals.sales, 100000 + 30001 + 70000, 'allocated parts add up to the sale');
});

test('unallocated project expenses are listed separately and not deducted; production cost stays unverified', async (t) => {
  const f = await fixture({t});
  const pnl = f.ok(await f.req(q({workId: 1})));
  assert.equal(pnl.unallocated.count, 1);
  assert.equal(pnl.unallocated.total, 22000);
  assert.ok(!pnl.expenses.some((e) => e.work_id == null), 'unallocated expenses are not in the work expenses');
  assert.equal(pnl.totals.expense, 55000, 'unallocated 22,000 is not in the work total');
  assert.equal(pnl.productionCost.status, 'none', 'この作品には費目「制作費」の経費が無い');
  assert.doesNotMatch(pnl.productionCost.note, /差し引いていません/);
  assert.equal(pnl.totals.balance, pnl.totals.sales - pnl.totals.expense, 'the balance is sales minus all work expenses');
  // 流通別カード: 流通ごとの売上と、流通に紐づかない経費のカード。カードの差額の和＝作品計の差額
  const labels = pnl.cards.map((card) => card.kind);
  assert.ok(labels.includes('expense-only'));
  assert.equal(pnl.cards.filter((card) => card.kind === 'distribution').reduce((n, card) => n + card.sales, 0), pnl.totals.sales);
  assert.equal(pnl.cards.reduce((n, card) => n + card.balance, 0), pnl.totals.balance);
  assert.ok(pnl.cards.filter((card) => card.kind === 'distribution').every((card) => card.expenseLinked === false));
  const expenseCard = pnl.cards.find((card) => card.kind === 'expense-only');
  assert.equal(expenseCard.label, EXPENSE_ONLY_CARD);
  assert.equal(expenseCard.expense, 55000);
  // 月別の流通内訳の和＝その月の売上
  for (const row of pnl.monthly) assert.equal(Object.values(row.byDistribution).reduce((n, v) => n + v, 0), row.sales, row.month);
  assert.ok(pnl.lines.every((line) => line.month >= '2026-05' && line.month <= '2027-04'));
  assert.ok(pnl.dataAsOf.latestImportAt);
  assert.match(pnl.outOfScope, /範囲外/);
});

test('work P&L permissions and validation', async (t) => {
  const f = await fixture({t});
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req(q({workId: 1}), null, {cookie: production})).status, 403);
  const outsider = await f.login('outsider@other.invalid');
  assert.equal((await f.req(q({workId: 1}), null, {cookie: outsider})).status, 403, 'another organization cannot read the work');
  const editor = await f.login('editor@openingnight.invalid');
  assert.equal(f.ok(await f.req(q({workId: 1}), null, {cookie: editor})).totals.sales, 188001);
  assert.equal((await f.req('/reports/work-pnl?from=2026-05&to=2027-04')).status, 400, 'a work is required');
  assert.equal((await f.req(q({workId: 'abc'}))).status, 400);
  assert.equal((await f.req(q({workId: 1, from: '2027-05'}))).status, 400, 'from after to');
  assert.equal((await f.req(q({workId: 1, to: '2027-13'}))).status, 400);
  assert.equal((await f.req(q({workId: 9999}))).status, 403, 'unknown work');
});

test('buildWorkPnl pads months, keeps distributions apart and reconciles', () => {
  const months = ['2026-05', '2026-06', '2026-07'];
  const lines = [
    {id: 1, month: '2026-05', amount: 1000, distribution_code: 'svod', distribution_label: 'SVOD', deal_label: 'MG', partner_name: '架空配信'},
    {id: 2, month: '2026-07', amount: 500, distribution_code: 'svod', distribution_label: 'SVOD', deal_label: 'FLAT（定額）', partner_name: '架空配信'},
    {id: 3, month: '2026-07', amount: -200, distribution_code: 'dvd', distribution_label: 'DVD', partner_name: '架空販売'},
    {id: 4, month: '2026-08', amount: 99999, distribution_code: 'dvd', distribution_label: 'DVD'},
  ];
  const r = buildWorkPnl({lines, months, expenses: [{accounting_month: '2026-06', actual_ex_tax: 300}], unallocatedExpenses: [{accounting_month: '2026-06', actual_ex_tax: 50}, {accounting_month: '2027-01', actual_ex_tax: 7}]});
  assert.deepEqual(r.monthly.map((row) => row.sales), [1000, 0, 300]);
  assert.deepEqual(r.monthly.map((row) => row.balance), [1000, -300, 300]);
  assert.deepEqual(r.totals, {sales: 1300, expense: 300, balance: 1000});
  assert.deepEqual(r.distributions.map((d) => [d.label, d.sales]), [['SVOD', 1500], ['DVD', -200]]);
  assert.deepEqual(r.distributions[0].deals, ['FLAT（定額）', 'MG']);
  assert.equal(r.unallocated.total, 50, 'only unallocated expenses inside the period');
  assert.equal(r.lineCount, 3);
  assert.ok(checksOk(r.checks));
  assert.deepEqual([r.productionCost.status, r.productionCost.amount], ['none', 0]);
  const empty = buildWorkPnl({months});
  assert.deepEqual(empty.totals, {sales: 0, expense: 0, balance: 0});
  assert.equal(empty.cards.length, 0, 'no expense card without expenses');
  assert.ok(checksOk(empty.checks));
});

test('links to the sales list and to the report center carry the same conditions', () => {
  assert.deepEqual(salesDetailParams({workId: 3, from: '2026-05', to: '2027-04', distribution: 'svod'}), {period: 'custom', from: '2026-05', to: '2027-04', workId: '3', distribution: 'svod'});
  assert.deepEqual(salesDetailParams({workId: 3, from: '2026-05', to: '2026-05'}), {period: 'custom', from: '2026-05', to: '2026-05', workId: '3'});
  assert.deepEqual(workPnlLinkParams(7), {report: 'work-pnl', workId: '7'});
  assert.deepEqual(workPnlLinkParams(null), {report: 'work-pnl'});
});

test('income dashboard helpers: totals row and month labels with the year', () => {
  const rows = incomeRows([{month: '2026-11', revenue: '1000', cost: 300, profit: 700}, {month: '2027-01', revenue: 0, cost: 50}]);
  assert.deepEqual(rows[1], {month: '2027-01', revenue: 0, cost: 50, profit: -50});
  assert.deepEqual(incomeTotals(rows), {revenue: 1000, cost: 350, profit: 650});
  const labels = monthAxisLabels(['2026-11', '2026-12', '2027-01'], {every: false});
  assert.deepEqual(labels.map((l) => [l.month, l.year]), [['11月', '2026年'], ['12月', ''], ['1月', '2027年']]);
  assert.equal(labels[1].full, '2026年12月');
  assert.ok(monthAxisLabels(['2026-11', '2026-12']).every((l) => l.year), 'short ranges show the year on every month');
});

test('income rows can fill the months without numbers so that the months do not skip', () => {
  const rows = incomeRows([{month: '2026-11', revenue: 1000, cost: 300}, {month: '2027-02', revenue: 0, cost: 50}], {fillGaps: true});
  assert.deepEqual(rows.map((r) => r.month), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(rows[1], {month: '2026-12', revenue: 0, cost: 0, profit: 0});
  assert.deepEqual(incomeTotals(rows), {revenue: 1000, cost: 350, profit: 650});
});

test('buildWorkPnl: 公開月一括の区分の経費も月別収支では計上月で差し引き、PLとの時期の違いを説明する', () => {
  const months = ['2026-05', '2026-06'];
  const r = buildWorkPnl({months, lines: [], expenses: [
    {accounting_month: '2026-05', expense_recognition_timing:'release_month_once', category: '制作費', actual_ex_tax: 300},
    {accounting_month: '2026-06', category: '宣伝費', actual_ex_tax: 100},
    {accounting_month: '2026-07', expense_recognition_timing:'release_month_once', category: '制作費', actual_ex_tax: 50},
    {accounting_month: '2026-06', category: '配信マスター制作費', actual_ex_tax: 20},
  ]});
  assert.deepEqual([r.productionCost.status, r.productionCost.amount, r.productionCost.count, r.productionCost.months], ['included', 300, 1, ['2026-05']]);
  assert.match(r.productionCost.note, /差し引いています/);
  assert.equal(r.totals.expense, 420);
  assert.ok(checksOk(r.checks));
  assert.equal(productionCostOf([]).status, 'none');
});
