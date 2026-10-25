import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSellList, sellListRow as rowOf, monthlyApplied} from '../src/mg-sell/sell-list-model.mjs';
import {contractProgress, effectiveLedger, contractIdOf} from '../src/mg-ledger-import.mjs';

// MG 契約・台帳の画面（MgLedger.jsx）と同じ渡し方: 回収は contractProgress、行は訂正前を除いて契約ごとに絞る
const itemOf = (c, ledger) => ({contract: c, progress: contractProgress(c, ledger, 'incoming'), entries: effectiveLedger(ledger).filter((r) => contractIdOf(r, 'incoming') === Number(c.id))});
const sellListRow = (c, ledger, opts) => { const i = itemOf(c, ledger); return rowOf(c, i.progress, i.entries, opts); };

// 架空の受取 MG 契約（/api/mg/contracts と同じ形）と台帳の行（/api/mg/ledger と同じ形）
const contract = (id, {mg = 1000000, from = '2026-11-01', to = '2027-10-31', partyId = 2, version = 1} = {}) => ({
  id, code: `MG-DEMO-${id}`, title: `架空作品${id}`, party_id: partyId,
  versions: [{id: id * 10, version, mode: 'single', mg_amount_yen: mg, starts_on: from, ends_on: to, products: [{product_id: id, sku: `SKU-${id}`, name: `架空商品${id}`, evaluation_yen: mg}]}],
});
let seq = 0;
const entry = (contractId, month, applied, extra = {}) => ({
  id: ++seq, incoming_contract_id: contractId, outgoing_contract_id: null, term_version_id: contractId * 10, product_id: contractId,
  accounting_month: month, period_from: `${month}-01`, period_to: `${month}-28`, reported_eligible_yen: applied, applied_recoup_yen: applied,
  reported_overage_yen: 0, recognized_yen: 0, status: 'unverified', reverses_entry_id: null, ...extra,
});

test('到達した契約は到達の月を出し、残りは0', () => {
  const row = sellListRow(contract(1), [entry(1, '2026-11', 600000), entry(1, '2026-12', 500000)], {today: '2027-03-15'});
  assert.equal(row.state, 'reached');
  assert.equal(row.reachedMonth, '2026-12');
  assert.equal(row.remainingYen, 0);
  assert.equal(row.exceedYen, 100000);
});

test('FR-SETL-MGL-064: いまのペースで期限までに届く契約は「期間内」、届かない契約は「届かない見込」と越える月数', () => {
  const on = sellListRow(contract(2), [entry(2, '2026-11', 300000), entry(2, '2026-12', 200000), entry(2, '2027-01', 100000)], {today: '2027-03-15'});
  // 直近3回の平均 200,000、残り 400,000 → 2か月後の 2027-03
  assert.equal(on.paceYen, 200000);
  assert.equal(on.projectedMonth, '2027-03');
  assert.equal(on.state, 'onTrack');
  const risk = sellListRow(contract(3, {to: '2027-04-30'}), [entry(3, '2026-11', 50000), entry(3, '2026-12', 50000), entry(3, '2027-01', 50000)], {today: '2027-03-15'});
  // 残り 850,000 ÷ 50,000 = 17か月 → 2028-06。期限 2027-04 を14か月越える
  assert.equal(risk.state, 'atRisk');
  assert.equal(risk.projectedMonth, '2028-06');
  assert.equal(risk.overrunMonths, 14);
});

test('報告の無い契約は、期限前なら「報告待ち」、期限を過ぎたら「届かない見込」', () => {
  assert.equal(sellListRow(contract(4), [], {today: '2027-03-15'}).state, 'waiting');
  assert.equal(sellListRow(contract(5, {to: '2027-01-31'}), [], {today: '2027-03-15'}).state, 'atRisk');
});

test('訂正前の行は数えない（訂正版の値で回収と月ごとの和を出す）', () => {
  const original = entry(6, '2026-11', 900000);
  const fix = entry(6, '2026-11', 300000, {reverses_entry_id: original.id});
  const row = sellListRow(contract(6), [original, fix], {today: '2027-03-15'});
  assert.equal(row.cumulativeAppliedYen, 300000);
  assert.deepEqual(monthlyApplied([fix]), [{month: '2026-11', appliedYen: 300000}]);
  assert.deepEqual(row.months, [{month: '2026-11', appliedYen: 300000}]);
});

test('期間の経過と残りの月数', () => {
  const row = sellListRow(contract(7, {from: '2026-11-01', to: '2027-10-31'}), [], {today: '2027-03-15'});
  assert.equal(row.totalMonths, 12);
  assert.equal(row.elapsedMonths, 5);
  assert.equal(row.leftMonths, 7);
});

test('FR-SETL-MGL-064: 一覧は「届かない見込」を先に、同じ状態は残りの大きい順に並べ、5つの数字を出す。別の契約の行は混ぜない', () => {
  const contracts = [contract(11), contract(12, {to: '2027-02-28'}), contract(13, {mg: 2000000, to: '2027-02-28'})];
  const ledger = [entry(11, '2026-11', 1000000), entry(12, '2026-11', 10000), entry(13, '2026-11', 10000)];
  const {rows, summary} = buildSellList({items: contracts.map((c) => itemOf(c, ledger)), partners: [{id: 2, name: '架空配信A社'}], today: '2027-03-15'});
  assert.deepEqual(rows.map((r) => r.code), ['MG-DEMO-13', 'MG-DEMO-12', 'MG-DEMO-11']);
  assert.equal(rows[0].partnerName, '架空配信A社');
  assert.equal(summary.contractCount, 3);
  assert.equal(summary.reachedCount, 1);
  assert.equal(summary.atRiskCount, 2);
  assert.equal(summary.guaranteeYen, 4000000);
  assert.equal(summary.recoveredYen, 1020000);
  assert.equal(summary.remainingYen, 2980000);
});

test('保証額0円の契約は到達率を出さず「保証額0円」', () => {
  const row = sellListRow(contract(14, {mg: 0}), [], {today: '2027-03-15'});
  assert.equal(row.state, 'zero');
  assert.equal(row.rate, null);
});

// 報告の取消（4つの額を0にした訂正版を足す）。API を通して、回収の計算から外れることを確かめる
import {buildVoidPayload, isVoidEntry} from '../src/mg-sell/void-model.mjs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {ledgerView} from '../src/mg-ledger-import.mjs';

test('FR-SETL-MGL-065: 報告を取り消すと、元の行は訂正前として残り、回収の累計から外れる。同じ行の2回目の取消は断られる', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const r0 = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  const cookie = r0.headers.get('set-cookie').split(';')[0];
  const req = async (path, input) => {
    const r = await app.request(`/api${path}`, {method: input ? 'POST' : 'GET', headers: {cookie, ...(input ? {'content-type': 'application/json'} : {})}, body: input ? JSON.stringify(input) : undefined});
    return {status: r.status, data: await r.json()};
  };
  const made = await req('/mg/contracts', {direction: 'incoming', code: 'MG-VOID', title: '架空の取消の確認', partnerId: 2, contractDate: '2026-10-01', contractSourceReference: 'SYNTH-C',
    mgAmountYen: 100000, startsOn: '2026-10-01', endsOn: '2027-09-30', mode: 'single', reason: '架空', sourceReference: 'SYNTH-T', products: [{productId: 1, evaluationYen: 100000}],
    phases: [{startsOn: '2026-10-01', endsOn: '2027-09-30', intervalMonths: 1, firstCloseOn: '2026-10-31', reportOffsetMonths: 1, reportDay: 28, payOffsetMonths: 2, payDay: 28}]});
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const {contractId, versionId} = made.data;
  const entry = await req('/mg/ledger', {termVersionId: versionId, productId: 1, periodFrom: '2026-10-01', periodTo: '2026-10-31', accountingMonth: '2026-10',
    sourceReference: 'SYNTH-R-2026-10', reportedEligibleYen: 40000, appliedRecoupYen: 40000, reportedOverageYen: 0, recognizedYen: 0});
  assert.equal(entry.status, 201, JSON.stringify(entry.data));
  const load = async () => {
    const [c, l] = await Promise.all([req('/mg/contracts?direction=incoming'), req('/mg/ledger')]);
    const contract = c.data.contracts.find((x) => Number(x.id) === Number(contractId));
    return {contract, ledger: l.data.rows};
  };
  let {contract, ledger} = await load();
  const row = ledgerView({ledger, contracts: [contract], direction: 'incoming'}).find((x) => x.id === Number(entry.data.entryId));
  assert.equal(buildVoidPayload(row, '  '), null);
  const voided = await req('/mg/ledger', buildVoidPayload(row, '取り違えた取引先の報告'));
  assert.equal(voided.status, 201, JSON.stringify(voided.data));
  ({contract, ledger} = await load());
  assert.equal(contractProgress(contract, ledger, 'incoming').cumulativeAppliedYen, 0);
  assert.equal(ledger.length, 2);
  assert.ok(isVoidEntry(ledger.find((x) => Number(x.id) === Number(voided.data.entryId))));
  const again = await req('/mg/ledger', buildVoidPayload(row, 'もう一度'));
  assert.equal(again.status, 409, JSON.stringify(again.data));
});
