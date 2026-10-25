// 受託制作の契約の版の入力の読み取りと、受託費・節目ごとの額の導き方（純関数。フェーズ1の仕様書 #10b）。
// 期待値は要件 docs/requirements/revenue/contract-work.md の FR-REV-CWORK-035（受託費率 1000〜1500 bps・既定 1000、受託費＝総製作費×受託費率を
// truncate、節目＝月初の日×割合で和が 10000）と、FR-REV-YOJITSU-044（純額＝受託費×節目の割合。J-14 (a)）から持ってくる。DB を使わない
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MARKUP_BPS, contractFeeYen, contractVersionComplete, isMonthStart, milestoneAmounts, normalizeContractVersionInput,
} from '../src/planning/contract-production/contract-production-model.mjs';

const milestones = [{dueOn: '2026-05-01', shareBps: 3000}, {dueOn: '2026-08-01', shareBps: 4000}, {dueOn: '2026-12-01', shareBps: 3000}];
const input = (overrides = {}) => ({previousVersionNo: 0, budgetYen: 48271903, markupBps: 1000, milestones, ...overrides});
const fields = (result) => result.errors.map((e) => e.field);

test('FR-REV-CWORK-035 受託費は総製作費×受託費率を料率の額として truncate した整数円', () => {
  // 48,271,903 × 10% = 4,827,190.3 → 4,827,190。52,364,117 × 12.5% = 6,545,514.625 → 6,545,514（切り上げも四捨五入もしない）
  assert.equal(contractFeeYen(48271903, 1000), 4827190);
  assert.equal(contractFeeYen(52364117, 1250), 6545514);
  assert.equal(contractFeeYen(19999, 1500), 2999, '2,999.85 → 2,999');
  // 境界: 総製作費は1円〜1兆円、率は 1000〜1500（ちょうどは通り、1つ外は断る）
  assert.equal(contractFeeYen(1, 1000), 0, '1円の10%は0円（0.1円を切り捨てる）');
  assert.equal(contractFeeYen(1_000_000_000_000, 1500), 150_000_000_000);
  for (const [budget, rate] of [[0, 1000], [1_000_000_000_001, 1000], [100.5, 1000], [1000, 999], [1000, 1501], [1000, 1250.5]]) {
    assert.throws(() => contractFeeYen(budget, rate), /総製作費|受託費率/, `${budget}・${rate}`);
  }
});

test('FR-REV-CWORK-035 受託費率は 1000〜1500 bps の整数で受け、空なら既定の 1000 にする', () => {
  assert.equal(DEFAULT_MARKUP_BPS, 1000);
  for (const omitted of [undefined, null]) {
    const result = normalizeContractVersionInput(input({markupBps: omitted}));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual([result.value.markupBps, result.value.feeYen], [1000, 4827190]);
  }
  assert.equal(normalizeContractVersionInput(input({markupBps: 1500})).value.feeYen, 7240785, '48,271,903 × 15% = 7,240,785.45');
  for (const bad of [999, 1501, 0, 1250.5, '1250', 12.5]) assert.deepEqual(fields(normalizeContractVersionInput(input({markupBps: bad}))), ['markupBps'], String(bad));
  for (const bad of [0, -1, 1_000_000_000_001, 100.5, '48271903', null]) assert.deepEqual(fields(normalizeContractVersionInput(input({budgetYen: bad}))), ['budgetYen'], String(bad));
  // 誤りがあるときは受託費を出さない（使わせない）
  assert.equal(normalizeContractVersionInput(input({markupBps: 999})).value.feeYen, null);
});

test('FR-REV-CWORK-035 支払いの節目は月初の日の順に1〜60行で、割合はちょうど 10000 bp', () => {
  const ok = normalizeContractVersionInput(input({contractReference: '  FICT/契約書/架空.pdf  ', note: ' 架空のメモ '}));
  assert.deepEqual(ok, {ok: true, errors: [], value: {
    previousVersionNo: 0, budgetYen: 48271903, markupBps: 1000, feeYen: 4827190,
    milestones: [{seq: 1, dueOn: '2026-05-01', shareBps: 3000}, {seq: 2, dueOn: '2026-08-01', shareBps: 4000}, {seq: 3, dueOn: '2026-12-01', shareBps: 3000}],
    contractReference: 'FICT/契約書/架空.pdf', note: '架空のメモ',
  }});
  assert.equal(normalizeContractVersionInput(input({milestones: [{dueOn: '2027-01-01', shareBps: 10000}]})).ok, true, '一括払いは1行');
  // 和が 10000 でない（1つ足りない・1つ多い）
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: [{dueOn: '2026-05-01', shareBps: 4999}, {dueOn: '2026-06-01', shareBps: 5000}]}))), ['milestones']);
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: [{dueOn: '2026-05-01', shareBps: 5001}, {dueOn: '2026-06-01', shareBps: 5000}]}))), ['milestones']);
  // 月初の日でない・月の順でない・同じ月を重ねる
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: [{dueOn: '2026-05-15', shareBps: 10000}]}))), ['milestones.0.dueOn']);
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: [{dueOn: '2026-5-01', shareBps: 10000}]}))), ['milestones.0.dueOn']);
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: [{dueOn: '2026-13-01', shareBps: 10000}]}))), ['milestones.0.dueOn']);
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: [{dueOn: '2026-08-01', shareBps: 5000}, {dueOn: '2026-05-01', shareBps: 5000}]}))), ['milestones.1.dueOn']);
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: [{dueOn: '2026-08-01', shareBps: 5000}, {dueOn: '2026-08-01', shareBps: 5000}]}))), ['milestones.1.dueOn']);
  // 割合は1〜10000 の整数
  for (const bad of [0, 10001, 50.5, '5000']) {
    assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: [{dueOn: '2026-05-01', shareBps: bad}, {dueOn: '2026-06-01', shareBps: 5000}]}))), ['milestones.0.shareBps'], String(bad));
  }
  // 行の数は1〜60（ちょうど60は通り、0行・61行は断る）
  const months = (n) => Array.from({length: n}, (_, i) => ({dueOn: `${2026 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}-01`, shareBps: i === 0 ? 10000 - (n - 1) : 1}));
  assert.equal(normalizeContractVersionInput(input({milestones: months(60)})).ok, true);
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: months(61)}))), ['milestones']);
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: []}))), ['milestones']);
  assert.deepEqual(fields(normalizeContractVersionInput(input({milestones: null}))), ['milestones']);
  // 見ていた版の番号は0以上の整数（版が無ければ 0 か null）
  assert.equal(normalizeContractVersionInput(input({previousVersionNo: null})).value.previousVersionNo, 0);
  for (const bad of [-1, 1.5, '1']) assert.deepEqual(fields(normalizeContractVersionInput(input({previousVersionNo: bad}))), ['previousVersionNo'], String(bad));
  assert.deepEqual(fields(normalizeContractVersionInput(input({contractReference: 'x'.repeat(501)}))), ['contractReference']);
});

test('暦の月初の日だけを節目の月として受ける', () => {
  for (const ok of ['2026-01-01', '2026-12-01', '2028-02-01']) assert.equal(isMonthStart(ok), true, ok);
  for (const bad of ['2026-00-01', '2026-13-01', '2026-02-02', '2026-2-01', '２０２６-01-01', '2026-01', '', null]) assert.equal(isMonthStart(bad), false, String(bad));
});

test('FR-REV-YOJITSU-044 節目ごとの制作費と受託費（純額＝受託費×節目の割合）は最大剰余法で配り、和が総製作費・受託費と一致する', () => {
  // 総製作費 52,364,117・受託費 6,545,514 を 3333・3334・3333 bp に配る。切り捨てた残り（制作費1円・受託費2円）を余りの大きい節目から、
  // 同点は連番の小さい順に1円ずつ足す
  const rows = milestoneAmounts({budgetYen: 52364117, feeYen: 6545514, milestones: [{seq: 1, share_bps: 3333}, {seq: 2, share_bps: 3334}, {seq: 3, share_bps: 3333}]});
  assert.deepEqual(rows, [
    {seq: 1, budgetYen: 17452960, feeYen: 2181620},
    {seq: 2, budgetYen: 17458197, feeYen: 2182274},
    {seq: 3, budgetYen: 17452960, feeYen: 2181620},
  ]);
  assert.equal(rows.reduce((n, r) => n + r.budgetYen, 0), 52364117);
  assert.equal(rows.reduce((n, r) => n + r.feeYen, 0), 6545514);
  // 入力の形（{seq, shareBps}）でも同じ
  assert.deepEqual(milestoneAmounts({budgetYen: 100, feeYen: 10, milestones: [{seq: 1, shareBps: 10000}]}), [{seq: 1, budgetYen: 100, feeYen: 10}]);
});

test('FR-REV-CWORK-035 版は節目の行の数と割合の和（10000）が揃ったときだけ揃った版とみなす', () => {
  assert.equal(contractVersionComplete({milestone_count: 3, recorded_milestones: 3, share_total_bps: 10000}), true);
  assert.equal(contractVersionComplete({milestone_count: 3, recorded_milestones: 2, share_total_bps: 7000}), false, '節目が欠けた版');
  assert.equal(contractVersionComplete({milestone_count: '2', recorded_milestones: 2, share_total_bps: '10000'}), true, 'PostgreSQL の文字の数も数として読む');
  assert.equal(contractVersionComplete(null), false);
});
