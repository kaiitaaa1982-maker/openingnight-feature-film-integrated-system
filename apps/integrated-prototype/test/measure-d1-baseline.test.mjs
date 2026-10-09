// 段0「D1 の基準を測る」の計測スクリプト（scripts/measure-d1-baseline.mjs）の試験。
// ・小さい合成の1通を画面と同じ API の順（作品ごとの確認のたびに重なりの確認）で入れると、区切り①〜⑦の時刻が順に並び、予実の即時の判定（はい・いいえ）が出る
// ・予実の判定は、届くはずの報告が登録と合わないとき「いいえ」になる（いつも「はい」を返す作りではない）
// ・中央値は数の大きさで並べて取る
// 架空データの組織 DEMO-SALES を :memory: に作る。表の読み取りは手元の Python（ON_PYTHON）の実物
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {seedSalesDemo} from '../scripts/seed-sales-demo.mjs';
import {MILESTONES, buildSyntheticWorkbook, measureOnce, median, summarize} from '../scripts/measure-d1-baseline.mjs';

function assertOrdered(run) {
  const times = MILESTONES.map(({key}) => run.marks[key]);
  assert.ok(times.every(Number.isFinite), `区切りの時刻がそろっている: ${JSON.stringify(run.marks)}`);
  assert.equal(run.marks.m1, 0, '① が起点');
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index] >= times[index - 1], `${MILESTONES[index].no} は ${MILESTONES[index - 1].no} より後: ${JSON.stringify(run.marks)}`);
  }
  assert.ok(run.extractedAt > 0 && run.extractedAt <= run.marks.m2, '抽出は ① と ② のあいだに終わる');
  assert.ok(run.immediateAt >= run.marks.m4 && run.immediateAt <= run.marks.m5, '予実の即時の読み取りは ④ の直後');
}

test('段0 D1 の基準（ローカル）: 小さい合成の1通で区切り①〜⑦が順に並び、予実の判定が出る。届くはずの報告と合わない登録は「いいえ」', async (t) => {
  const db = await openTestDb({t});
  try {
    await seedSalesDemo(db);
    const run = await measureOnce({db, workbook: buildSyntheticWorkbook({rows: 5, works: 2, month: '2026-07'})});
    assertOrdered(run);
    assert.deepEqual(run.registered, {works: 2, reports: 2, rows: 5, excludedRows: 0});
    assert.equal(run.humanReviewMs, 0, '②〜③の人の確認は0');
    assert.equal(run.forecastImmediate, true, '登録の応答の直後に予実へ反映されている');
    assert.deepEqual(run.reflected, {royaltyDraft: true, companySales: true, receiptLedger: true, invoiceDraft: true, receivableBalance: true, forecast: true});
    assert.ok(run.db.segments['m3-m4'].calls > 0, '登録の区間で DB を呼んでいる');
    // 画面と同じく、作品ごとの確認のたびに重なる報告を読む（②〜③に入る）
    const count = (label) => run.steps.find((row) => row.label === label)?.count ?? 0;
    assert.equal(count('作品ごとの確認'), 2);
    assert.equal(count('重なりの確認'), 2, '作品ごとの確認と同じ回数だけ重なりを確かめる');

    // 届くはずの報告を別の報告の種類（ビデオグラム）で立てると、配信の報告を登録しても予実は反映されない
    const other = await measureOnce({db, workbook: buildSyntheticWorkbook({rows: 3, works: 3, month: '2026-08'}), forecastKind: 'package'});
    assertOrdered(other);
    assert.equal(other.forecastImmediate, false);
    assert.equal(other.reflected.forecast, false);
    assert.equal(other.reflected.companySales, true, '書類の側は反映される');
  } finally {
    await db.close();
  }
});

test('段0 D1 の基準（ローカル）: 中央値は数の大きさで並べて取り、区切りごとに出す', () => {
  assert.equal(median([10, 9, 100]), 10);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  const runs = [7, 1, 4].map((scale) => ({
    marks: Object.fromEntries(MILESTONES.map(({key}, index) => [key, index * scale])),
    steps: [{label: '登録', ms: scale}], extractedAt: scale, forecastImmediate: true,
  }));
  const summary = summarize(runs);
  assert.deepEqual(MILESTONES.map(({key}) => summary.marks[key]), MILESTONES.map((_, index) => index * 4));
  assert.equal(summary.segments['m3-m4'], 4);
  assert.deepEqual(summary.steps, [{label: '登録', ms: 4}]);
  assert.deepEqual(summary.forecastImmediate, [true, true, true]);
});
