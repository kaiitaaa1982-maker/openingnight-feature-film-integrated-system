// ロイヤリティ報告管理のフォルダ画面の純関数（src/royalty/royalty-folder-model.mjs）。入力は期間の一覧（GET /api/royalty/periods）の形の架空の行
import test from 'node:test';
import assert from 'node:assert/strict';
import {fiscalMonths, fiscalYearOf, cellOf, buildGrid, dueThisMonth, paymentMonthTotals, holderTrend} from '../src/royalty/royalty-folder-model.mjs';

const period = (o) => ({key: `${o.holderId}:${o.closeMonth}`, holderName: o.holderId === 1 ? '架空 太郎' : '架空音楽出版', statusLabel: o.status, statementId: null,
  payableYen: null, royaltyYen: null, adjustmentYen: null, carriedOutYen: null, paidYen: 0, reportedOn: null, draft: null, ...o});
const statement = (o) => period({statementId: o.id ?? 1, versionNo: 1, ...o});
const draft = (o, t) => period({...o, draft: {totals: {payableYen: 0, royaltyYen: 0, adjustmentYen: 0, carriedOutYen: 0, ...t}}});

const PERIODS = [
  statement({holderId: 1, closeMonth: '2026-03', status: 'paid', reportDueOn: '2026-04-30', paymentDueOn: '2026-05-31', payableYen: 11749, royaltyYen: 11749, paidYen: 11749, reportedOn: '2026-04-20'}),
  statement({id: 2, holderId: 1, closeMonth: '2026-06', status: 'reported', reportDueOn: '2026-07-31', paymentDueOn: '2026-08-31', payableYen: 19245, royaltyYen: 19245, paidYen: 0, reportedOn: '2026-07-25'}),
  statement({id: 3, holderId: 1, closeMonth: '2026-09', status: 'reported', reportDueOn: '2026-10-31', paymentDueOn: '2026-11-30', payableYen: 0, royaltyYen: 0, reportedOn: '2026-10-10'}),
  statement({id: 4, holderId: 2, closeMonth: '2026-09', status: 'created', reportDueOn: '2026-10-31', paymentDueOn: '2026-11-30', payableYen: 7637, royaltyYen: 14215}),
  draft({holderId: 2, closeMonth: '2026-08', status: 'overdue', reportDueOn: '2026-09-30', paymentDueOn: '2026-10-31'}, {payableYen: 5000, royaltyYen: 5000}),
  draft({holderId: 1, closeMonth: '2026-10', status: 'pending', reportDueOn: '2026-11-30', paymentDueOn: '2026-12-31'}, {payableYen: 7725, royaltyYen: 7725}),
  period({holderId: 1, closeMonth: '2026-11', status: 'open', reportDueOn: '2026-12-31', paymentDueOn: '2027-01-31'}),
];

test('年度の12か月は期首の月から数え、基準日の年度は期首の前なら前の年', () => {
  assert.deepEqual(fiscalMonths(2026, 5).slice(0, 2), ['2026-05', '2026-06']);
  assert.equal(fiscalMonths(2026, 5).at(-1), '2027-04');
  assert.equal(fiscalYearOf('2026-04-30', 5), 2025);
  assert.equal(fiscalYearOf('2026-05-01', 5), 2026);
});

test('マスは状態の1字で、0円で報告済みは「0円済」、下書きの額は下書きとして持つ', () => {
  assert.equal(cellOf(PERIODS[0]).char, '払');
  const zero = cellOf(PERIODS[2]);
  assert.equal(zero.char, '0円済');
  assert.equal(zero.status, 'paid');
  assert.equal(cellOf(PERIODS[4]).char, '超');
  assert.deepEqual([cellOf(PERIODS[4]).amount.payableYen, cellOf(PERIODS[4]).amount.draft], [5000, true]);
  assert.equal(cellOf(PERIODS[6]).amount, null);
});

test('年度は報告月で区切り、期首前の締め月を期首の後に報告する期間は列を足して載せる', () => {
  const grid = buildGrid(PERIODS, fiscalMonths(2026, 5));
  // 3月締め（4月報告）は2026年度に入らない。6月締め以降は入る
  const taro = grid.rows.find((r) => r.holderId === 1);
  assert.equal(taro.cells['2026-03'], undefined);
  assert.equal(taro.cells['2026-06'].char, '報');
  assert.equal(grid.columns[0], '2026-05');
  const g2025 = buildGrid(PERIODS, fiscalMonths(2025, 5));
  assert.ok(g2025.columns.includes('2026-03'));
  assert.equal(g2025.rows.find((r) => r.holderId === 1).cells['2026-03'].char, '払');
});

test('今月送るは、報告期限が今月以前で報告していない期間（期限超過を含む・受付中を除く）を期限の順に並べる', () => {
  const due = dueThisMonth(PERIODS, '2026-10');
  assert.deepEqual(due.rows.map((p) => p.key), ['2:2026-08', '2:2026-09']);
  assert.deepEqual([due.unreported, due.uncreated], [1, 1]);
  assert.equal(dueThisMonth(PERIODS, '2026-11').rows.some((p) => p.key === '1:2026-10'), true);
});

test('支払月の合計は、確定版の支払予定・支払済・未払と、下書きの額を分けて足す', () => {
  const totals = paymentMonthTotals(PERIODS);
  assert.deepEqual(totals.find((r) => r.month === '2026-05'), {month: '2026-05', statements: 1, payableYen: 11749, paidYen: 11749, unpaidYen: 0, drafts: 0, draftYen: 0});
  assert.deepEqual(totals.find((r) => r.month === '2026-11'), {month: '2026-11', statements: 1, payableYen: 7637, paidYen: 0, unpaidYen: 7637, drafts: 0, draftYen: 0});
  assert.deepEqual(totals.find((r) => r.month === '2026-10'), {month: '2026-10', statements: 0, payableYen: 0, paidYen: 0, unpaidYen: 0, drafts: 1, draftYen: 5000});
  assert.equal(totals.some((r) => r.month === '2027-01'), false, '額の無い受付中は足さない');
});

test('権利者の推移は締め月の順で、当期の累計を持つ', () => {
  const trend = holderTrend(PERIODS, 1);
  assert.deepEqual(trend.map((r) => r.closeMonth), ['2026-03', '2026-06', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(trend.map((r) => r.cumulativeYen), [11749, 30994, 30994, 38719, 38719]);
  assert.equal(trend[3].draft, true);
  assert.equal(trend[3].paidYen, null);
});
