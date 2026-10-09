import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

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
  const sale = async (key, month, amount) => ok(await req('/sales', {workId: 1, report_key: key, kind: 'digital', description: `架空売上 ${key}`, quantity: 1, basis_reason: '架空の根拠', recognition_basis_id: 1,
    partner_id: 2, product_id: 1, period_from: `${month}-01`, period_to: `${month}-28`, sales_month: month, amount_ex_tax: amount, tax_amount: amount / 10, amount_inc_tax: amount + amount / 10}));
  for (const [key, month, amount] of [['RY-1', '2026-06', 100000], ['RY-2', '2026-08', 200000], ['RY-3', '2026-09', 50000], ['RY-4', '2026-10', 70000], ['RY-MG', '2026-08', 90000]]) await sale(key, month, amount);
  const reportId = async (key) => (await req('/reports?workId=1')).data.rows.find((row) => row.report_key === key).id;
  const commission = ok(await req('/settlement/contracts', {workId: 1, contractCode: 'RY-COM', title: '架空の手数料契約', contractType: 'commission', holderPartnerId: 3, terms: {platformRateBps: 3000, agencyFeeBps: 1000}}));
  const mg = ok(await req('/settlement/contracts', {workId: 1, contractCode: 'RY-MG', title: '架空のMG契約', contractType: 'mg', holderPartnerId: 1, mgContractYen: 50000, terms: {platformRateBps: 0, agencyFeeBps: 0, recoupBasis: 'platform_net'}}));
  for (const key of ['RY-1', 'RY-2', 'RY-3', 'RY-4']) ok(await req('/settlement/links', {reportId: await reportId(key), workId: 1, contractId: commission.contractId, termVersionId: commission.versionId, reportBasis: 'gross'}));
  ok(await req('/settlement/links', {reportId: await reportId('RY-MG'), workId: 1, contractId: mg.contractId, termVersionId: mg.versionId, reportBasis: 'net'}));
  const paid = ok(await req('/rights-reports/payments', {settlementContractId: commission.contractId, partnerId: 3, amountYen: 60000, paidOn: '2026-07-15', reference: 'RY-PAY-1', reason: '架空の支払'}));
  ok(await req('/rights-reports/payments', {settlementContractId: commission.contractId, partnerId: 3, amountYen: 30000, paidOn: '2026-08-20', reference: 'RY-PAY-2', reason: '架空の支払'}));
  ok(await req('/rights-reports/payments', {settlementContractId: commission.contractId, partnerId: 3, amountYen: 60000, paidOn: '2026-09-10', reference: 'RY-PAY-1-VOID', reason: '架空の取消', reversesEventId: paid.id}));
  return {db, req, ok, login, commission, mg};
}

test('royalty statement splits prior/current/cumulative and payments for one rights holder', async (t) => {
  const f = await fixture({t});
  const r = f.ok(await f.req('/reports/royalty-statement?from=2026-08&to=2026-09&holderId=3'));
  const row = r.rows.find((x) => x.contractCode === 'RY-COM');
  // 手数料型: 控除前報告 × (1-30%) × (1-10%) = 63%
  assert.equal(row.prior.holderAmount, 63000);
  assert.equal(row.current.holderAmount, 126000 + 31500);
  assert.equal(row.cumulative.holderAmount, row.prior.holderAmount + row.current.holderAmount, 'prior + current = cumulative');
  assert.equal(row.prior.paid, 60000);
  assert.equal(row.current.paid, 30000 - 60000, 'the reversal is recorded in the month it was made');
  assert.equal(row.cumulative.paid, 30000);
  assert.equal(row.unpaid, row.cumulative.holderAmount - 30000);
  assert.ok(!r.details.some((d) => d.accountingMonth === '2026-10'), 'lines after the period are excluded');
  assert.ok(r.checks.every((c) => c.value === 0), JSON.stringify(r.checks));
  assert.equal(r.holder.name, '架空ストア');
  assert.ok(r.assumptions.some((a) => a.includes('源泉')));
});

test('FR-PLAN-ACQ-013 MG contracts are held (HOLD) with their sales kept, not counted as zero', async (t) => {
  const f = await fixture({t});
  const all = f.ok(await f.req('/reports/royalty-statement?from=2026-05&to=2027-04'));
  assert.equal(all.hold.length, 1);
  assert.equal(all.hold[0].reportedAmount, 90000);
  assert.equal(all.hold[0].holderAmount, null);
  const mgRow = all.rows.find((x) => x.contractCode === 'RY-MG');
  assert.equal(mgRow.cumulative.holdCount, 1);
  assert.equal(mgRow.cumulative.holdReported, 90000);
  assert.equal(mgRow.cumulative.holderAmount, 0, 'held lines are not mixed into the holder amount');
  assert.deepEqual(all.holders.map((h) => h.holderName).sort(), ['架空シネマ', '架空ストア'].sort());
  const holders = f.ok(await f.req('/reports/royalty-statement/holders'));
  assert.equal(holders.holders.length, 2);
});

test('royalty statement permissions and validation', async (t) => {
  const f = await fixture({t});
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req('/reports/royalty-statement?from=2026-05&to=2027-04', null, production)).status, 403);
  assert.equal((await f.req('/reports/royalty-statement/holders', null, production)).status, 403);
  assert.equal((await f.req('/reports/royalty-statement?from=2027-05&to=2026-04')).status, 400);
  const outsider = await f.login('outsider@other.invalid');
  assert.equal(f.ok(await f.req('/reports/royalty-statement?from=2026-05&to=2027-04', null, outsider)).rows.length, 0);
  // 抽出後も従来の試算APIは同じ結果を返す
  const preview = f.ok(await f.req('/settlement/preview?workId=1'));
  assert.equal(preview.contractSummaries.find((c) => c.contractCode === 'RY-COM').holderAmount, 63000 + 126000 + 31500 + 44100);
});

test('FR-PLAN-ACQ-015 MG契約への支払はMG前払として別に数え、未払残と相殺しない', async (t) => {
  const f = await fixture({t});
  const before = f.ok(await f.req('/reports/royalty-statement?from=2026-05&to=2027-04'));
  f.ok(await f.req('/rights-reports/payments', {settlementContractId: f.mg.contractId, partnerId: 1, amountYen: 20000, paidOn: '2026-08-10', reference: 'RY-MG-ADV', reason: '架空のMG前払'}));
  const after = f.ok(await f.req('/reports/royalty-statement?from=2026-05&to=2027-04'));
  const mgRow = after.rows.find((x) => x.contractCode === 'RY-MG');
  assert.deepEqual([mgRow.cumulative.paid, mgRow.cumulative.advance, mgRow.unpaid], [0, 20000, 0], '未払残をマイナスにしない');
  assert.equal(after.totals.unpaid, before.totals.unpaid, '手数料型の未払残は変わらない');
  assert.equal(after.totals.paid, before.totals.paid);
  assert.equal(after.totals.advance, 20000);
  assert.equal(after.holders.find((h) => h.holderName === '架空シネマ').advance, 20000);
  assert.match(after.payments.find((p) => p.reference === 'RY-MG-ADV').kind, /MG前払・充当未確認/);
  assert.ok(after.checks.every((c) => c.value === 0), JSON.stringify(after.checks));
});

test('期間の終了月より後の支払・取消は支払記録に載せず、期間末に有効だった支払を「取消済み」にしない', async (t) => {
  const f = await fixture({t});
  const r = f.ok(await f.req('/reports/royalty-statement?from=2026-07&to=2026-08&holderId=3'));
  assert.deepEqual(r.payments.map((p) => p.reference).sort(), ['RY-PAY-1', 'RY-PAY-2'], '9月の取消は期間後なので載せない');
  assert.equal(r.payments.find((p) => p.reference === 'RY-PAY-1').kind, '支払', '取消は期間後なので、期間末の時点では有効な支払');
  assert.equal(r.payments.reduce((n, p) => n + p.amount, 0), r.totals.paid, '支払記録の合計＝累計の支払');
  f.ok(await f.req('/rights-reports/payments', {settlementContractId: f.commission.contractId, partnerId: 3, amountYen: 5000, paidOn: '2026-11-05', reference: 'RY-PAY-LATER', reason: '架空の後日の支払'}));
  const again = f.ok(await f.req('/reports/royalty-statement?from=2026-07&to=2026-08&holderId=3'));
  assert.deepEqual(again.payments, r.payments, '期間後の支払を足しても、その期間の報告書の中身は変わらない');
  const withVoid = f.ok(await f.req('/reports/royalty-statement?from=2026-07&to=2026-09&holderId=3'));
  assert.equal(withVoid.payments.find((p) => p.reference === 'RY-PAY-1').kind, '支払（取消済み）');
});
