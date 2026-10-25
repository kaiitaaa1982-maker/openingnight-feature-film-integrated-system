// 需給予測の曲線（src/revenue/scenario/demand-curve.mjs）を、手で数えた小さい架空の入力で確かめる。
// 期待値は計画（会社ルートの plans/2026-10-09-sales-producer-kpi.md の「需給予測」と段A の表の公開月）から取る:
// 窓口×公開からの月数ごとの売上の和と、その月数まで観測できた作品の数（公開月＋月数が締めた月以前で、その窓口に公開後の売上がある作品）、
// 平均＝和÷作品の数の切り捨て（0に向かって）。公開月の無い作品の行・公開月より前の行・締めた月より後の行は曲線に入れず件数を出す。
import test from 'node:test';
import assert from 'node:assert/strict';
import {demandCurve, DEMAND_CURVE_VERSION} from '../src/revenue/scenario/demand-curve.mjs';

// 締めた月 2026-06。作品1は劇場公開の確定の版で 2026-01、作品2・3は最初の売上月で 2026-03・2026-05、作品4は公開月が無い、作品5は締めた月の後（2026-08）
const works = [
  {id: 3, releaseMonth: '2026-05', releaseSource: 'first_sale'},
  {id: 1, releaseMonth: '2026-01', releaseSource: 'window'},
  {id: 2, releaseMonth: '2026-03', releaseSource: 'first_sale'},
  {id: 4, releaseMonth: null, releaseSource: null},
  {id: 5, releaseMonth: '2026-08', releaseSource: 'window'},
];
const line = (workId, month, amount, channelGroup) => ({workId, month, amount, channelGroup});
const saleLines = [
  line(1, '2026-01', 1000, 'digital'), line(1, '2026-02', 600, 'digital'), line(1, '2026-04', 49, 'digital'),
  line(1, '2025-12', 50, 'digital'), // 公開月より前
  line(1, '2026-07', 999, 'digital'), // 締めた月より後
  line(1, '2026-01', 5000, 'theatrical'),
  line(1, '2026-02', 10, 'unknown_kind'), // 知らない窓口は「その他」
  line(2, '2026-03', 2000, 'digital'), line(2, '2026-04', 800, 'digital'), line(2, '2026-06', -100, 'digital'), // 返品で月数3が負
  line(3, '2026-05', 700, 'digital'), line(3, '2026-06', 200, 'digital'),
  line(3, '2026-05', 3001, 'theatrical'),
  line(4, '2026-02', 400, 'digital'), // 公開月が無い
  line(5, '2026-06', 100, 'digital'), // 公開月が締めた月の後
];
const curve = () => demandCurve({works, saleLines, throughMonth: '2026-06'});
const channel = (out, key) => out.channels.find((row) => row.channel === key);

test('窓口×公開からの月数ごとに、売上の和・その月数まで観測できた作品の数・平均（切り捨て）を出す', () => {
  const out = curve();
  assert.equal(out.definitionVersion, DEMAND_CURVE_VERSION);
  assert.deepEqual({origin: out.origin, throughMonth: out.throughMonth}, {origin: 'release_month', throughMonth: '2026-06'});
  // 配信: 作品1・2・3。月数0＝1000＋2000＋700、月数1＝600＋800＋200、月数2＝売上なし、月数3＝49−100。
  // 観測できた作品: 月数0・1は3本、月数2・3は作品3（2026-05＋2＝2026-07）が締めた月を越えるので2本。−51÷2 は 0 に向かって −25
  assert.deepEqual(channel(out, 'digital'), {channel: 'digital', label: '配信', status: 'curve', fallback: null, workCount: 3, lineCount: 8, points: [
    {offset: 0, workCount: 3, sumYen: 3700, averageYen: 1233},
    {offset: 1, workCount: 3, sumYen: 1600, averageYen: 533},
    {offset: 2, workCount: 2, sumYen: 0, averageYen: 0},
    {offset: 3, workCount: 2, sumYen: -51, averageYen: -25},
  ]});
  // 劇場: 作品1・3の公開月の売上だけ。8001÷2 の切り捨て
  assert.deepEqual(channel(out, 'theatrical').points, [{offset: 0, workCount: 2, sumYen: 8001, averageYen: 4000}]);
  assert.deepEqual([channel(out, 'theatrical').workCount, channel(out, 'theatrical').lineCount], [2, 2]);
  // 知らない窓口の行は「その他」に入る（作品1の月数1）。月数0は売上が無くても観測できた作品の数を数える
  assert.deepEqual(channel(out, 'other').points, [{offset: 0, workCount: 1, sumYen: 0, averageYen: 0}, {offset: 1, workCount: 1, sumYen: 10, averageYen: 10}]);
  // 元の行が無い窓口は「曲線なし」で、配るときは均等（段A は配らない）
  for (const key of ['rental', 'sell', 'package', 'broadcast', 'overseas']) {
    assert.deepEqual(pick(channel(out, key), ['status', 'fallback', 'workCount', 'lineCount', 'points']), {status: 'no_curve', fallback: 'even', workCount: 0, lineCount: 0, points: []}, key);
  }
  assert.deepEqual(out.channels.map((row) => row.channel), ['theatrical', 'rental', 'sell', 'package', 'digital', 'broadcast', 'overseas', 'other']);
  assert.deepEqual([out.workCount, out.lineCount], [3, 11]);
});

test('公開月の出どころを数え、公開月の無い作品の行・公開月より前の行・締めた月より後の行は曲線に入れず件数を出す', () => {
  const out = curve();
  // 作品5（公開月が締めた月の後）の行は、公開月の無い作品の行と同じく曲線に入れない
  assert.deepEqual(out.releaseSources, {window: 1, first_sale: 2, none: 1, after_close: 1});
  assert.deepEqual(out.excluded, {afterCloseLines: 1, noReleaseLines: 2, beforeReleaseLines: 1});
  assert.deepEqual(out.releases, [
    {workId: 1, releaseMonth: '2026-01', releaseSource: 'window'}, {workId: 2, releaseMonth: '2026-03', releaseSource: 'first_sale'},
    {workId: 3, releaseMonth: '2026-05', releaseSource: 'first_sale'}, {workId: 4, releaseMonth: null, releaseSource: null},
    {workId: 5, releaseMonth: '2026-08', releaseSource: 'window'}]);
  // 曲線に入った行と除いた行で、元の行を全部数える
  assert.equal(out.lineCount + out.excluded.afterCloseLines + out.excluded.noReleaseLines + out.excluded.beforeReleaseLines, saleLines.length);
});

test('締めた月を1か月先へ動かすと、その月の行が曲線に入り、観測できた作品の数が増える', () => {
  const out = demandCurve({works, saleLines, throughMonth: '2026-07'});
  // 2026-07 の作品1の999円（月数6）が入り、作品3の月数2が観測できるようになる
  assert.deepEqual(out.excluded, {afterCloseLines: 0, noReleaseLines: 2, beforeReleaseLines: 1});
  const digital = channel(out, 'digital');
  assert.deepEqual(digital.points.find((p) => p.offset === 2), {offset: 2, workCount: 3, sumYen: 0, averageYen: 0});
  assert.deepEqual(digital.points.find((p) => p.offset === 6), {offset: 6, workCount: 1, sumYen: 999, averageYen: 999});
  assert.deepEqual(digital.points.find((p) => p.offset === 5), {offset: 5, workCount: 1, sumYen: 0, averageYen: 0});
  assert.equal(digital.lineCount, 9);
});

test('元の行が1つも無ければ、どの窓口も曲線なしで、作品の数と行数は0', () => {
  const out = demandCurve({works, saleLines: [], throughMonth: '2026-06'});
  assert.equal(out.channels.every((row) => row.status === 'no_curve' && row.points.length === 0), true);
  assert.deepEqual([out.workCount, out.lineCount, out.excluded], [0, 0, {afterCloseLines: 0, noReleaseLines: 0, beforeReleaseLines: 0}]);
});

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}
