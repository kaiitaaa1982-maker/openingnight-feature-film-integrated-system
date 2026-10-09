import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {buildMgPortfolio} from '../src/mg-portfolio.mjs';
import {partyRows, detailRows, ledgerRows, reconcile, contractStatus} from '../src/reports/mg-sales-model.mjs';

const entry = (id, term, product, month, eligible, applied, overage = 0, recognized = 0) => ({id, term_version_id: term, product_id: product, accounting_month: month,
  period_from: `${month}-01`, period_to: `${month}-28`, reported_eligible_yen: eligible, applied_recoup_yen: applied, reported_overage_yen: overage, recognized_yen: recognized,
  source_reference: `架空-${id}`, status: 'reviewed'});
function contract(id, partyId, guarantee, ledger) {
  return {direction: 'incoming', contract: {id, code: `MG-${id}`, title: '架空MG', partner_id: partyId, source_reference: '架空契約'}, party: {id: partyId, code: `P-${partyId}`, name: `架空先${partyId}`},
    versions: [{id: id * 10, version: 1, starts_on: '2026-01-01', ends_on: '2026-12-31', mode: 'cross', mg_amount_yen: guarantee, products: [{product_id: 11, evaluation_yen: guarantee / 2}, {product_id: 12, evaluation_yen: guarantee / 2}]}],
    ledger: ledger.map((e) => ({...e, term_version_id: id * 10})),
    mappings: [{product_id: 11, work_id: 1, allocation_bps: 6000}, {product_id: 11, work_id: 2, allocation_bps: 4000}, {product_id: 12, work_id: 1, allocation_bps: 10000}],
    products: [{id: 11, sku: 'P11', name: '架空商品11'}, {id: 12, sku: 'P12', name: '架空商品12'}]};
}

test('FR-SETL-MGL-019 FR-SETL-MGL-020 MG sales rows put contract-level values on the first row only and reconcile with the ledger', () => {
  const report = buildMgPortfolio({direction: 'incoming', accountingMonth: '2026-03', works: [{id: 1, title: '架空作品1'}, {id: 2, title: '架空作品2'}], contracts: [
    contract(1, 2, 1000, [entry(1, 0, 11, '2026-01', 600, 500), entry(2, 0, 12, '2026-02', 500, 400, 100, 75), entry(3, 0, 11, '2026-03', 400, 200, 200, 150)]),
    contract(2, 3, 300, [entry(4, 0, 11, '2026-03', 150, 100, 50, 40), entry(5, 0, 12, '2026-04', 999, 999)]),
  ]});
  const details = detailRows(report);
  const heads = details.filter((row) => row.isContractHead);
  assert.equal(heads.length, 2);
  assert.equal(details.filter((row) => row.guaranteeYen !== null).length, 2, 'guarantee appears once per contract');
  assert.equal(heads.reduce((sum, row) => sum + row.guaranteeYen, 0), 1300);
  const parties = partyRows(report);
  assert.deepEqual(parties.map((p) => p.partyName), ['架空先2', '架空先3']);
  assert.equal(parties.reduce((sum, p) => sum + p.cumulativeApplied, 0), report.totals.cumulative.appliedYen);
  const checks = reconcile(report);
  assert.equal(checks[2].value, 0, JSON.stringify(checks));
  assert.equal(checks[6].value, 0, JSON.stringify(checks));
  assert.ok(ledgerRows(report).every((row) => row.accountingMonth <= '2026-03'), 'entries after the base month are not used');
  assert.equal(contractStatus({unverifiedCount: 0, guaranteeYen: 300, cumulative: {appliedYen: 300}}).label, '到達済');
  assert.equal(contractStatus({unverifiedCount: 1, guaranteeYen: 300, cumulative: {appliedYen: 0}}).label, '条件未確認');
});

test('month choices list only months that have ledger rows; production cannot read', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const months = await (await app.request('/api/reports/mg-sales/months?direction=incoming', {headers: {cookie: admin}})).json();
  assert.deepEqual(months, {ok: true, direction: 'incoming', months: []});
  const production = await login('production@openingnight.invalid');
  assert.equal((await app.request('/api/reports/mg-sales/months', {headers: {cookie: production}})).status, 403);
});
