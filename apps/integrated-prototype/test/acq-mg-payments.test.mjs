// 支払う MG の支払の記録の試験（MG の前払の回・分配額・取消・外貨・払いすぎの止め）。表は移行 0027 の acq_mg_payments。
// 要件は docs/requirements/planning/rights-acquisition.md の FR-PLAN-ACQ-015・019・042、計画は会社ルートの plans の 2026-10-22-folder-mg-buy（仮説 H4）。架空のデータだけ。
import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {livePayments, readPaymentInput, summarizePayments} from '../src/acquisition/acq-mg-payment-model.mjs';

async function fixture(t) {
  const db = await openTestDb({t}), app = createApp({db});
  const login = async (email) => {
    const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    return r.headers.get('set-cookie').split(';')[0];
  };
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const r = await app.request('/api' + path, {method: body ? 'POST' : 'GET', headers: {cookie, ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, data: await r.json()};
  };
  const ok = (r) => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.data; };
  const contract = ok(await req('/acq-mg/contracts', {code: 'ACQ-PAY-001', title: '架空の買付', partnerId: 3, consideration: 'mg', mgAmount: 100000,
    startsOn: '2026-06-01', endsOn: '2031-05-31', recoupBasis: 'platform_net', overageEnabled: true, overageRateBps: 5000, works: [{workId: 1}],
    paymentSchedule: [{trigger: 'signing', amount: 20000}, {trigger: 'delivery', amount: 80000}], reason: '架空'}));
  const pay = (body, cookie) => req(`/acq-mg/contracts/${contract.contractId}/payments`, {paidOn: '2026-06-10', reason: '架空の支払', ...body}, cookie);
  const view = async () => ok(await req(`/acq-mg/contracts/${contract.contractId}/payments`));
  return {db, req, ok, login, contract, pay, view};
}

test('FR-PLAN-ACQ-015 MG の前払は支払予定の回ごとに数え、回の残りを超える支払は止める（仮説 H4）', async (t) => {
  const f = await fixture(t);
  f.ok(await f.pay({kind: 'mg_advance', installment: 1, amountYen: 20000, reference: '振込-001'}));
  assert.equal((await f.pay({kind: 'mg_advance', installment: 1, amountYen: 1, reference: '振込-002'})).status, 409, '1回目は払い済み');
  assert.equal((await f.pay({kind: 'mg_advance', amountYen: 1000, reference: '振込-003'})).status, 400, '予定のある契約は回が要る');
  assert.equal((await f.pay({kind: 'mg_advance', installment: 9, amountYen: 1000, reference: '振込-004'})).status, 409, '予定に無い回');
  f.ok(await f.pay({kind: 'mg_advance', installment: 2, amountYen: 30000, reference: '振込-005'}));
  const v = await f.view();
  assert.equal(v.summary.mgPaid, 50000);
  assert.equal(v.summary.mgUnpaid, 50000);
  assert.deepEqual(v.summary.installments.map((s) => [s.installment, s.paid, s.unpaid]), [[1, 20000, 0], [2, 30000, 50000]]);
  assert.equal((await f.pay({kind: 'mg_advance', installment: 2, amountYen: 1000, reference: '振込-001'})).status, 409, '同じ参照は二重に入らない');
});

test('取消の行は元と同じ額で、取り消した支払は数えない。取消は1回だけ、記録は変えられない', async (t) => {
  const f = await fixture(t);
  const paid = f.ok(await f.pay({kind: 'mg_advance', installment: 1, amountYen: 20000, reference: '振込-101'}));
  assert.equal((await f.req(`/acq-mg/payments/${paid.paymentId}/reverse`, {})).status, 400, '取消の理由が要る');
  const rev = f.ok(await f.req(`/acq-mg/payments/${paid.paymentId}/reverse`, {reason: '架空の誤送金'}));
  assert.equal((await f.req(`/acq-mg/payments/${paid.paymentId}/reverse`, {reason: '二度目', reference: '取消-別'})).status, 409, '取消は1回だけ');
  assert.equal((await f.req(`/acq-mg/payments/${rev.paymentId}/reverse`, {reason: '取消の取消'})).status, 404);
  const v = await f.view();
  assert.equal(v.summary.mgPaid, 0);
  assert.equal(v.payments.length, 2);
  await assert.rejects(f.db.run('UPDATE acq_mg_payments SET amount_yen=1 WHERE id=?', [paid.paymentId]), /変更できません/);
  await assert.rejects(f.db.run('DELETE FROM acq_mg_payments WHERE id=?', [paid.paymentId]), /削除できません/);
  // 払い直せる
  f.ok(await f.pay({kind: 'mg_advance', installment: 1, amountYen: 20000, reference: '振込-102'}));
  assert.deepEqual(await foreignKeyViolations(f.db), []);
});

test('FR-PLAN-ACQ-015 分配額は、最新の発行の分配額に対して払い、MG の前払と相殺しない', async (t) => {
  const f = await fixture(t);
  const key = 'ACQ-PAY-R1';
  f.ok(await f.req('/sales', {workId: 1, kind: 'digital', report_key: key, partner_id: 2, period_from: '2026-06-01', period_to: '2026-06-30', accounting_month: '2026-06',
    description: '架空の報告', quantity: 1, amount_ex_tax: 140000, tax_amount: 0, amount_inc_tax: 140000}));
  const reportId = f.ok(await f.req('/reports?workId=1')).rows.find((x) => x.report_key === key).id;
  f.ok(await f.req('/acq-mg/report-links', {reportId, workId: 1, termVersionId: f.contract.termVersionId, decidedBy: 'auto'}));
  assert.equal((await f.pay({kind: 'distribution', statementId: 1, amountYen: 100, reference: '分配-000'})).status, 409, '報告書の無い分配の支払');
  const st = f.ok(await f.req(`/acq-mg/contracts/${f.contract.contractId}/statements`, {closeMonth: '2026-06'}));
  // 超過 40,000 × 50% → 分配額 20,000
  assert.equal((await f.pay({kind: 'distribution', statementId: st.statementId, amountYen: 20001, reference: '分配-001'})).status, 409, '未払を超える');
  f.ok(await f.pay({kind: 'distribution', statementId: st.statementId, amountYen: 20000, reference: '分配-002'}));
  f.ok(await f.pay({kind: 'mg_advance', installment: 1, amountYen: 20000, reference: '振込-201'}));
  const v = await f.view();
  assert.equal(v.summary.distributionOwed, 20000);
  assert.equal(v.summary.distributionPaid, 20000);
  assert.equal(v.summary.distributionUnpaid, 0);
  assert.equal(v.summary.mgPaid, 20000, 'MG の前払は分配の支払と別に数える');
});

test('FR-PLAN-ACQ-019 FR-PLAN-ACQ-042 外貨の支払は、通貨・外貨の額・レート・レートの日を円の額と一緒に残す', async (t) => {
  const f = await fixture(t);
  f.ok(await f.pay({kind: 'mg_advance', installment: 1, amountYen: 20000, reference: '振込-USD', currency: 'usd', foreignAmount: 13400, fxRate: '149.253731', fxRateOn: '2026-06-09'}));
  const row = (await f.view()).payments[0];
  assert.deepEqual([row.currency, row.foreign_amount, row.fx_rate_micro, row.fx_rate_on, row.amount_yen], ['USD', 13400, 149253731, '2026-06-09', 20000]);
  assert.equal((await f.pay({kind: 'mg_advance', installment: 2, amountYen: 100, reference: '振込-USD2', currency: 'USD', foreignAmount: 1, fxRate: '149.2537311', fxRateOn: '2026-06-09'})).status, 400, 'レートは6桁まで');
});

test('集計と入力の確かめ（純関数）', () => {
  const payments = [{id: 1, kind: 'mg_advance', installment: 1, amount_yen: 5}, {id: 2, kind: 'mg_advance', installment: 1, amount_yen: 5, reverses_payment_id: 1}, {id: 3, kind: 'distribution', amount_yen: 7}];
  assert.deepEqual(livePayments(payments).map((p) => p.id), [3]);
  assert.deepEqual(summarizePayments({mgAmount: 10, schedule: [{installment: 1, trigger_kind: 'signing', amount: 10}], payments, distributionOwed: 9}),
    {mgAmount: 10, mgPaid: 0, mgUnpaid: 10, installments: [{installment: 1, trigger: 'signing', dueOn: undefined, amount: 10, paid: 0, unpaid: 10}], distributionOwed: 9, distributionPaid: 7, distributionUnpaid: 2});
  assert.throws(() => readPaymentInput({kind: 'distribution', amountYen: 1, paidOn: '2026-06-01', reference: 'x', reason: 'y'}), /報告書/);
  assert.throws(() => readPaymentInput({kind: 'mg_advance', amountYen: 1.5, paidOn: '2026-06-01', reference: 'x', reason: 'y'}), /整数/);
});

test('制作担当は支払を見られず、記録もできない', async (t) => {
  const f = await fixture(t);
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req(`/acq-mg/contracts/${f.contract.contractId}/payments`, null, production)).status, 403);
  assert.equal((await f.pay({kind: 'mg_advance', installment: 1, amountYen: 1, reference: 'P'}, production)).status, 403);
});
