// 放送ウィンドウ提案から下書きを作るときの月の選び方（src/broadcast/proposal-draft-model.mjs）。
// 提案の結果は試験の中で書き下した形（proposeWindow は使わない）にし、選べる月・放送枠の期間・選べない理由を日付で照合する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalMonthOptions, monthOptionLabel, groupBlockedMonths, checkDraftMonths, duplicateMonths, runKindOf, draftBasisText, draftSourceReference, draftReason, monthBlockReason}
  from '../src/broadcast/proposal-draft-model.mjs';

// 基準日 2026-09-26 から24か月。放送してよい期間は 2026-10-01〜。独占（架空CS）2027-01-01〜2027-06-30、ホールドバック 2027-07-11〜2027-07-20。
// 提案する期間は P1 2026-10-01〜2026-12-31（初回）、P2 2027-07-01〜2027-07-10（再放送・短い）、P3 2027-07-21〜2028-09-26（再放送）
const result = {
  state: 'ok', horizon: {from: '2026-09-26', to: '2028-09-26'}, allowed: [{from: '2026-10-01', to: '2028-09-26'}],
  basis: ['権利: 2024/01/01〜2031/12/31', '放送の解禁: 2026/10/01〜2030/03/31'],
  blocked: [
    {kind: 'exclusive', from: '2027-01-01', to: '2027-06-30', station: '架空CS', planned: false},
    {kind: 'holdback', from: '2027-07-11', to: '2027-07-20', station: '架空CS', months: 3, planned: false},
  ],
  proposals: [
    {from: '2026-10-01', to: '2026-12-31', run: '初回', short: false, others: [
      {station: '架空BS', kind: 'nonexclusive', from: '2026-10-01', to: '2026-11-15'},
      {station: '架空CS', kind: 'slot', month: '2026-11', status: 'confirmed', from: '2026-11-01', to: '2026-11-30'},
    ]},
    {from: '2027-07-01', to: '2027-07-10', run: '再放送', short: true, others: []},
    {from: '2027-07-21', to: '2028-09-26', run: '再放送', short: false, others: []},
  ],
};

test('選べる月は提案する期間と重なる月だけ。放送枠の期間は重なり（月の途中が塞がれば長いほう）、選べない月は理由つき', () => {
  const {months, blocked} = proposalMonthOptions(result);
  // 書き下し: 2026-09〜2028-09 の25か月のうち、2026-10〜12 と 2027-07〜2028-09 の18か月が選べる
  const expectedMonths = ['2026-10', '2026-11', '2026-12',
    '2027-07', '2027-08', '2027-09', '2027-10', '2027-11', '2027-12',
    '2028-01', '2028-02', '2028-03', '2028-04', '2028-05', '2028-06', '2028-07', '2028-08', '2028-09'];
  assert.equal(expectedMonths.length, 18);
  assert.deepEqual(months.map((o) => o.month), expectedMonths);
  assert.deepEqual(blocked.map((b) => b.month), ['2026-09', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06']);
  const byMonth = new Map(months.map((o) => [o.month, o]));
  assert.deepEqual((({from, to, whole, run}) => ({from, to, whole, run}))(byMonth.get('2026-10')), {from: '2026-10-01', to: '2026-10-31', whole: true, run: '初回'});
  // 2027年7月は 7/1〜7/10（10日）と 7/21〜7/31（11日）。長いほう（P3・再放送）
  assert.deepEqual((({from, to, whole, split, run, short, proposal}) => ({from, to, whole, split, run, short, proposal}))(byMonth.get('2027-07')),
    {from: '2027-07-21', to: '2027-07-31', whole: false, split: true, run: '再放送', short: false, proposal: {from: '2027-07-21', to: '2028-09-26'}});
  assert.deepEqual([byMonth.get('2028-09').from, byMonth.get('2028-09').to, byMonth.get('2028-09').whole], ['2028-09-01', '2028-09-26', false]);
  // 同時期の他局は、その月に重なるものだけ（非独占の契約は 11/15 まで、放送枠は 2026-11 だけ）
  assert.deepEqual(byMonth.get('2026-11').others.map((o) => o.station), ['架空BS', '架空CS']);
  assert.deepEqual(byMonth.get('2026-12').others.map((o) => o.station), []);
  assert.equal(blocked[0].reason, '放送してよい期間の外（権利・放送の解禁・販売条件）');
  assert.equal(blocked[1].reason, '独占契約中（架空CS・2027/01/01〜2027/06/30）');
  assert.equal(monthBlockReason(result, '2027-07'), 'ホールドバック（架空CS・3か月・2027/07/11〜2027/07/20）', '塞がる期間が重なる月の理由');
});

test('月の選択肢の文と、選べない月のまとめ（続く月で同じ理由は1行）', () => {
  const {months, blocked} = proposalMonthOptions(result);
  const byMonth = new Map(months.map((o) => [o.month, o]));
  assert.equal(monthOptionLabel(byMonth.get('2026-10')), '2026年10月');
  assert.equal(monthOptionLabel(byMonth.get('2028-09')), '2028年9月（9/1〜9/26）');
  assert.equal(monthOptionLabel(byMonth.get('2027-07')), '2027年7月（7/21〜7/31・月の途中に塞がる期間あり）');
  assert.deepEqual(groupBlockedMonths(blocked).map((g) => g.text), [
    '2026年9月：放送してよい期間の外（権利・放送の解禁・販売条件）',
    '2027年1月〜2027年6月：独占契約中（架空CS・2027/01/01〜2027/06/30）',
  ]);
  assert.deepEqual(groupBlockedMonths([]), []);
});

test('登録の前の確かめ: 選べる月だけ通し、範囲外・塞がる月・重複・形の違いは理由を返す', () => {
  const {accepted, errors} = checkDraftMonths(result, ['2027-02', '2026-11', '2026-11', '2029-01', 'x', '2026-10']);
  assert.deepEqual(accepted.map((o) => o.month), ['2026-10', '2026-11'], '月の順に並べる');
  assert.deepEqual(errors.map((e) => e.message), [
    '2027年2月は提案する期間の外なので選べません（独占契約中（架空CS・2027/01/01〜2027/06/30））',
    '2026年11月が2回選ばれています',
    '2029年1月は提案する期間の外なので選べません（提案の範囲（基準日から24か月・2026/09/26〜2028/09/26）の外）',
    '放送する月は 2026-11 の形で選んでください（x）',
  ]);
  assert.match(checkDraftMonths(result, []).errors[0].message, /1つ以上/);
  assert.match(checkDraftMonths(result, null).errors[0].message, /1つ以上/);
  assert.match(checkDraftMonths(result, Array.from({length: 25}, (_, n) => `2027-${String((n % 12) + 1).padStart(2, '0')}`)).errors[0].message, /24か月まで/);
  // 提案なし（要確認）の結果からは、どの月も選べない
  const blockedResult = {...result, state: 'blocked', proposals: []};
  assert.deepEqual(proposalMonthOptions(blockedResult).months, []);
  assert.ok(proposalMonthOptions(blockedResult).blocked.every((b) => b.reason === '提案なし（要確認の理由を見てください）'));
  assert.deepEqual(proposalMonthOptions({state: 'ok'}), {months: [], blocked: []}, '基準日の無い結果は空');
});

test('二重登録になる月: その局（全角・半角・空白のゆれを同じ局）の生きている枠がある月。中止の枠は数えない', () => {
  const slots = [
    {slot_id: 1, month: '2026-11', station: '架空ＢＳ', status: 'draft'},
    {slot_id: 2, month: '2026-12', station: '架空BS', status: 'cancelled'},
    {slot_id: 3, broadcast_month: '2027-08', station_name: ' 架空 BS ', status: 'confirmed'},
    {slot_id: 4, month: '2027-09', station: '架空CS', status: 'confirmed'},
  ];
  assert.deepEqual([...duplicateMonths(slots, '架空BS').entries()].map(([m, s]) => [m, s.slot_id]), [['2026-11', 1], ['2027-08', 3]]);
  assert.equal(duplicateMonths(slots, '').size, 0, '局を選ぶまでは何も止めない');
  assert.equal(duplicateMonths(null, '架空BS').size, 0);
});

test('初回／再放送・放送枠の根拠と理由・提案の根拠の文', () => {
  assert.equal(runKindOf('再放送'), 'rerun');
  assert.equal(runKindOf('初回'), 'first');
  assert.equal(runKindOf(undefined), 'first');
  const option = proposalMonthOptions(result).months.find((o) => o.month === '2026-11');
  assert.equal(draftSourceReference({asOf: '2026-09-26', option}), '放送ウィンドウ提案（基準日 2026/09/26・提案する期間 2026/10/01〜2026/12/31）');
  assert.equal(draftReason({runKind: 'rerun', memo: '年末の枠'}), '放送ウィンドウ提案から下書き（再放送）：年末の枠');
  assert.equal(draftReason({runKind: 'first', memo: null}), '放送ウィンドウ提案から下書き（初回）');
  assert.ok(draftReason({runKind: 'first', memo: 'あ'.repeat(2000)}).length <= 1000);
  assert.equal(draftBasisText(result, option), [
    '提案する期間: 2026/10/01〜2026/12/31', 'この月の放送枠の期間: 2026/11/01〜2026/11/30', '権利: 2024/01/01〜2031/12/31', '放送の解禁: 2026/10/01〜2030/03/31',
    '塞がっている期間: 2027/01/01〜2027/06/30 架空CS（独占）', '塞がっている期間: 2027/07/11〜2027/07/20 架空CS（ホールドバック 3か月）', '同時期の他局: 架空BS・架空CS',
  ].join('\n'));
  const long = draftBasisText({...result, basis: ['あ'.repeat(5000)]}, option);
  assert.equal(long.length, 4000);
});
