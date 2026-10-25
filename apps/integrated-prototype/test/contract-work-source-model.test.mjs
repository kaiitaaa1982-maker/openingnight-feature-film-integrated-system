// 源泉1 制作受託の導き方（src/accounting/profit/contract-work-source-model.mjs。行動指標の計画 段B #3）を、DB を使わずに確かめる。
// 期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-006（受託費×入金した節目の割合の純額。J-14 (a)。要確認12 の
// 「節目の月が締めた月までなら入金した」）と、project-cashflow-forecast-actual.md の FR-REV-YOJITSU-044・FR-REV-CWORK-035（節目ごとの受託費は
// 受託費×節目の割合を最大剰余法で配った額で、和が受託費）から、実装を読まずに計算する。架空の値だけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {contractWorkSource} from '../src/accounting/profit/contract-work-source-model.mjs';

// 受託費＝総製作費×受託費率の truncate（FR-REV-CWORK-035）
const feeOf = (budget, markup) => Number(BigInt(budget) * BigInt(markup) / 10000n);
// 受託費を節目の割合で配る: 各行を truncate し、足りない1円ずつを余りの大きい順（同じなら連番の小さい順）に足す（docs/rules/money.md の最大剰余法）
function largestRemainder(total, shares) {
  const parts = shares.map((share, index) => ({index, floor: Number(BigInt(total) * BigInt(share) / 10000n), rest: BigInt(total) * BigInt(share) % 10000n}));
  let left = total - parts.reduce((n, p) => n + p.floor, 0);
  for (const p of [...parts].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1))) {
    if (left === 0) break;
    p.floor += 1;
    left -= 1;
  }
  return parts.map((p) => p.floor);
}

// store の行の形（readContractWorkSourceRows）。PostgreSQL の BIGINT は文字で返ることがあるので、額の一部を文字にしておく
const project = (id, overrides = {}) => ({project_id: id, code: `FICT-CW-${id}`, title: `架空の制作受託${id}`, earning_type: 'contract_work', profit_source: 1,
  version_no: 2, budget_yen: '52364117', markup_bps: 1250, fee_yen: String(feeOf(52364117, 1250)), milestone_count: 3, ...overrides});
// 節目の行は版の番号つき（既定は案件の行の版 2）
const milestones = (id, list, versionNo = 2) => list.map(([seq, dueOn, share]) => ({project_id: id, version_no: versionNo, seq, due_on: dueOn, share_bps: share}));
const THREE = [[1, '2026-05-01', 3333], [2, '2026-09-01', 3334], [3, '2027-01-01', 3333]];
const PERIOD = {from: '2026-04', to: '2027-03'};

test('FR-REV-KPI-006 FR-REV-YOJITSU-044 源泉1の粗利は受託費×締めた月までの節目の割合（純額）で、節目ごとの額は受託費を最大剰余法で配った額', () => {
  const fee = feeOf(52364117, 1250);
  assert.equal(fee, 6545514); // 6,545,514.625 → truncate
  const parts = largestRemainder(fee, [3333, 3334, 3333]);
  const budgetParts = largestRemainder(52364117, [3333, 3334, 3333]);
  const source = contractWorkSource({projects: [project(7)], milestones: milestones(7, THREE)}, {period: PERIOD, closedMonth: '2026-10'});
  assert.equal(source.receiptBasis, 'milestone_month');
  assert.deepEqual(source.window, {from: '2026-04', to: '2026-10', closedMonth: '2026-10'});
  assert.equal(source.rows.length, 1);
  const [row] = source.rows;
  assert.deepEqual([row.projectId, row.versionNo, row.budgetYen, row.markupBps, row.feeYen, row.complete], [7, 2, 52364117, 1250, fee, true]);
  assert.deepEqual(row.milestones, [
    {seq: 1, month: '2026-05', shareBps: 3333, received: true, budgetYen: budgetParts[0], feeYen: parts[0]},
    {seq: 2, month: '2026-09', shareBps: 3334, received: true, budgetYen: budgetParts[1], feeYen: parts[1]},
    {seq: 3, month: '2027-01', shareBps: 3333, received: false, budgetYen: budgetParts[2], feeYen: parts[2]},
  ]);
  // 入金した節目（2026-05・2026-09）の割合 6667 bp と受託費の純額。制作費（総製作費の節目の額）は粗利に入れない
  assert.equal(row.receivedShareBps, 6667);
  assert.equal(row.feeReceivedTotalYen, parts[0] + parts[1]);
  assert.equal(row.feeReceivedPeriodYen, parts[0] + parts[1]);
  assert.equal(row.feeReceivedTotalYen, 4363894);
  // 節目の額の和は受託費・総製作費とちょうど一致する（端数を捨てない）
  assert.equal(row.milestones.reduce((n, m) => n + m.feeYen, 0), fee);
  assert.equal(row.milestones.reduce((n, m) => n + m.budgetYen, 0), 52364117);
  assert.equal(source.unknownCount, 0);
  assert.deepEqual([source.unregistered, source.excluded], [[], []]);
});

test('FR-REV-KPI-006 締めた月ちょうどの節目は入金した側、1か月前に締めたなら入金の予定。期間の前の節目は累計にだけ入る', () => {
  const parts = largestRemainder(6545514, [3333, 3334, 3333]);
  const at = (closedMonth, period = PERIOD) => contractWorkSource({projects: [project(7)], milestones: milestones(7, THREE)}, {period, closedMonth}).rows[0];
  const exact = at('2026-09');
  assert.deepEqual(exact.milestones.map((m) => m.received), [true, true, false]);
  assert.deepEqual([exact.receivedShareBps, exact.feeReceivedPeriodYen], [6667, parts[0] + parts[1]]);
  const before = at('2026-08');
  assert.deepEqual(before.milestones.map((m) => m.received), [true, false, false]);
  assert.deepEqual([before.receivedShareBps, before.feeReceivedTotalYen, before.feeReceivedPeriodYen], [3333, parts[0], parts[0]]);
  // 期間が 2026-06 から: 2026-05 の節目は累計に入り、期間内には入らない
  const later = at('2026-10', {from: '2026-06', to: '2027-05'});
  assert.deepEqual([later.feeReceivedTotalYen, later.feeReceivedPeriodYen], [parts[0] + parts[1], parts[1]]);
  // 期間の終わりが締めた月より前: 期間の終わりより後の節目は期間内に入らない（累計には入る）
  const ended = at('2027-03', {from: '2026-04', to: '2026-08'});
  assert.deepEqual([ended.receivedShareBps, ended.feeReceivedTotalYen, ended.feeReceivedPeriodYen], [10000, 6545514, parts[0]]);
  // 締めた月が最後の節目より後なら、受託費の全部が入金した側（和は受託費ちょうど）
  assert.equal(at('2027-01').feeReceivedTotalYen, 6545514);
  // 締めた月が最初の節目より前なら、粗利は0円（行はあり、版がある。未接続ではない）
  const none = at('2026-04');
  assert.deepEqual([none.receivedShareBps, none.feeReceivedTotalYen, none.feeReceivedPeriodYen, none.complete], [0, 0, 0, true]);
});

test('FR-REV-KPI-006 契約の版の無い受託は unregistered、節目の欠けた版は額を null（未確定）、稼ぎ方の無い案件は除外の理由つきで、どれも0円で埋めない', () => {
  const source = contractWorkSource({
    projects: [
      project(3, {version_no: null, budget_yen: null, markup_bps: null, fee_yen: null, milestone_count: null}),
      project(5, {version_no: 3, budget_yen: 1000000, markup_bps: 1200, fee_yen: 120000, milestone_count: 3}),
      project(9, {earning_type: null, profit_source: null}),
    ],
    milestones: [...milestones(5, [[1, '2026-05-01', 5000]], 3), ...milestones(9, THREE)],
  }, {period: PERIOD, closedMonth: '2026-10'});
  assert.deepEqual(source.unregistered, [{projectId: 3, code: 'FICT-CW-3', title: '架空の制作受託3'}]);
  assert.deepEqual(source.excluded, [{projectId: 9, code: 'FICT-CW-9', title: '架空の制作受託9', reason: 'no_earning_type'}]);
  assert.equal(source.rows.length, 1);
  const [row] = source.rows;
  assert.deepEqual([row.projectId, row.complete, row.receivedShareBps, row.feeReceivedTotalYen, row.feeReceivedPeriodYen], [5, false, null, null, null]);
  assert.deepEqual(row.milestones, [{seq: 1, month: '2026-05', shareBps: 5000, received: true, budgetYen: null, feeYen: null}]);
  assert.equal(source.unknownCount, 1);
  // 版のある案件が1件も無ければ、源泉1は未接続（rows が null。空の配列や0円にしない）
  const empty = contractWorkSource({projects: [project(3, {version_no: null})], milestones: []}, {period: PERIOD, closedMonth: '2026-10'});
  assert.deepEqual([empty.rows, empty.unknownCount, empty.unregistered.length], [null, 0, 1]);
  assert.equal(contractWorkSource({projects: [], milestones: []}, {period: PERIOD, closedMonth: '2026-10'}).rows, null);
});

test('FR-REV-KPI-006 節目の行の版が案件の行の版と食い違う材料（別の時点に読んだ）は、古い版の受託費に新しい版の節目の割合を組み合わせず額を null にする', () => {
  const at = (rows) => contractWorkSource({projects: [project(7)], milestones: rows}, {period: PERIOD, closedMonth: '2026-10'});
  // 案件の行は第2版（総製作費 52,364,117・受託費率 12.5%）、節目の行は第3版（行の数と割合の和は揃っている）
  const newer = at(milestones(7, THREE, 3));
  assert.equal(newer.rows.length, 1);
  const [row] = newer.rows;
  assert.deepEqual([row.versionNo, row.complete, row.receivedShareBps, row.feeReceivedTotalYen, row.feeReceivedPeriodYen], [2, false, null, null, null]);
  // 食い違う版の節目は、この版の節目として出さない
  assert.deepEqual(row.milestones, []);
  assert.equal(newer.unknownCount, 1);
  // 1行だけ食い違っても（残りの2行は第2版）、版は揃っていない扱いで額を出さない
  const mixed = at([...milestones(7, THREE.slice(0, 2)), ...milestones(7, THREE.slice(2), 3)]).rows[0];
  assert.deepEqual([mixed.complete, mixed.feeReceivedTotalYen], [false, null]);
  assert.deepEqual(mixed.milestones.map((m) => [m.seq, m.feeYen]), [[1, null], [2, null]]);
  // 版の番号の無い節目の行（読み方の誤り）も食い違いとみなす
  const bare = at(THREE.map(([seq, dueOn, share]) => ({project_id: 7, seq, due_on: dueOn, share_bps: share}))).rows[0];
  assert.deepEqual([bare.complete, bare.feeReceivedTotalYen], [false, null]);
  // 同じ版なら額が出る（文字の版の番号でも同じ版とみなす）
  const same = at(milestones(7, THREE, '2')).rows[0];
  assert.deepEqual([same.complete, same.receivedShareBps], [true, 6667]);
});

test('FR-REV-KPI-006 期間と締めた月は YYYY-MM で受け、読めない値と始まりが終わりより後の期間は断る', () => {
  const run = (period, closedMonth) => () => contractWorkSource({projects: [], milestones: []}, {period, closedMonth});
  assert.throws(run({from: '2026-4', to: '2027-03'}, '2026-10'), /期間は \{from, to\} の YYYY-MM/);
  assert.throws(run({from: '2026-04', to: '2027-13'}, '2026-10'), /期間は \{from, to\} の YYYY-MM/);
  assert.throws(run(undefined, '2026-10'), /期間は \{from, to\} の YYYY-MM/);
  assert.throws(run({from: '2027-04', to: '2027-03'}, '2026-10'), /始まりが終わりより後/);
  assert.throws(run({from: '2026-04', to: '2027-03'}, '2026-10-01'), /締めた月は YYYY-MM/);
  // ちょうど1か月の期間は通る
  assert.equal(run({from: '2026-04', to: '2026-04'}, '2026-04')().rows, null);
});
