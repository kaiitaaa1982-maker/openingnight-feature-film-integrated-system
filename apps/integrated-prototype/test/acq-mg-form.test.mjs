// 業務画面「MG 買付」の契約の登録フォームの入力の変換（acq-mg-form-model.mjs）の試験。
// フォームの値から作った形を受け口がそのまま受け付けること、読めない値をフォームの側で止めることを確かめる。架空のデータだけ。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {contractPayload} from '../src/acquisition/acq-mg-form-model.mjs';

const form = (extra = {}) => ({
  code: 'ACQ-FORM-001', title: '架空の買付', partnerId: '3', workIds: ['1'], consideration: 'mg', mgAmount: '300,000', startsOn: '2026-05-01', endsOn: '2031-04-30',
  recoupBasis: 'after_fee', platformRate: '30', agencyFee: '12.5', overage: 'yes', overageRate: '50', holdAgreementRef: '', multiWork: 'actual',
  schedule: [{trigger: 'signing', amount: '60000', dueOn: ''}, {trigger: 'delivery', amount: '240000', dueOn: ''}],
  deductions: [{category: '字幕費', capAmount: '30000', sourceRef: '契約 第8条'}], cycleKind: 'quarterly', anchorMonth: '3', reason: '契約書から登録', ...extra,
});

test('フォームの値を bp・円の整数に直し、周期の初期値（3か月・3月基準）を付ける', () => {
  const p = contractPayload(form());
  assert.equal(p.mgAmount, 300000);
  assert.equal(p.platformRateBps, 3000);
  assert.equal(p.agencyFeeBps, 1250);
  assert.equal(p.overageRateBps, 5000);
  assert.equal(p.multiWork, 'single', '作品が1つなら single');
  assert.deepEqual(p.paymentSchedule.map((s) => s.amount), [60000, 240000]);
  assert.deepEqual(p.phases, [{startsMonth: '2026-05', cycleKind: 'quarterly', anchorMonth: 3, reportOffsetMonths: 1, paymentOffsetMonths: 1}]);
  assert.equal(contractPayload(form({consideration: 'buyout'})).overageEnabled, false);
  assert.equal(contractPayload(form({overage: 'unknown'})).overageEnabled, null);
});

test('読めない値はフォームで止める（受け口に送らない）', () => {
  assert.throws(() => contractPayload(form({workIds: []})), /作品/);
  assert.throws(() => contractPayload(form({mgAmount: '30万'})), /MG の額/);
  assert.throws(() => contractPayload(form({agencyFee: '12.345'})), /手数料の率/);
  assert.throws(() => contractPayload(form({overageRate: '120'})), /率/);
  assert.throws(() => contractPayload(form({schedule: [{trigger: 'signing', amount: '1000', dueOn: ''}]})), /支払予定の和/);
});

test('フォームから作った形を、受け口がそのまま登録する', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await app.request('/api/acq-mg/contracts', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(contractPayload(form()))});
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  const {contractId} = await r.json();
  const detail = await (await app.request(`/api/acq-mg/contracts/${contractId}`, {headers: {cookie}})).json();
  assert.equal(detail.latest.schedule.length, 2);
  assert.equal(detail.latest.deductions[0].cap_amount, 30000);
  assert.equal(detail.latest.phases[0].cycle_kind, 'quarterly');
});
