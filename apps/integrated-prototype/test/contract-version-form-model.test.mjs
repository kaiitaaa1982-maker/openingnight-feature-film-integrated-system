// 受託制作の契約の版の入力の画面（行動指標の計画 #3）の欄の文字と受け口の本文の行き来（src/planning/contract-production/contract-version-form-model.mjs）を、
// DB を使わずに確かめる。期待値は要件 docs/requirements/revenue/contract-work.md の FR-REV-CWORK-035（受託費率は 1000〜1500 bps・既定 1000、
// 受託費＝総製作費×受託費率の truncate、節目は月初の日×割合で和が 10000）と、kpi-scenario-forecast.md の FR-REV-KPI-006（受託費率は交渉の条件で、
// 案件の編集の1項目として契約の版に書く）から持ってくる。架空の値だけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {contractProjectOptions, contractVersionBody, contractVersionFieldNames, feePreview, formFromVersion, shareTotalBps} from '../src/planning/contract-production/contract-version-form-model.mjs';

const form = (overrides = {}) => ({
  budget: '52,364,117', ratePercent: '12.5',
  milestones: [{month: '2026-05', sharePercent: '33.33'}, {month: '2026-09', sharePercent: '33.34'}, {month: '2027-01', sharePercent: '33.33'}],
  contractReference: ' FICT/契約書/架空_第2版.pdf ', note: '', ...overrides,
});

test('FR-REV-CWORK-035 案件の選択肢は、売上の4区分の受け口が返した財務の権限のある案件のうち型「受託制作」の案件だけ', () => {
  const body = {ok: true, projects: [
    {projectId: 4, code: 'FICT-CW-4', title: '架空の制作受託', projectType: 'contract_production'},
    {projectId: 5, code: 'FICT-ACQ-5', title: '架空の買付', projectType: 'acquisition'},
    {projectId: 6, code: 'FICT-SW-6', title: '架空の受託開発', projectType: 'contract_work'},
  ]};
  assert.deepEqual(contractProjectOptions(body), [{value: '4', label: 'FICT-CW-4｜架空の制作受託'}]);
  assert.deepEqual(contractProjectOptions({ok: true, projects: []}), []);
  assert.deepEqual(contractProjectOptions(null), []);
});

test('FR-REV-CWORK-035 版の無い案件の欄は受託費率が既定の 10%・節目1行 100%、版のある案件は最新の版の値（率は % の文字）から改める', () => {
  assert.deepEqual(formFromVersion(null), {budget: '', ratePercent: '10', milestones: [{month: '', sharePercent: '100'}], contractReference: '', note: ''});
  const latest = {versionNo: 2, budgetYen: 52364117, markupBps: 1250, feeYen: 6545514, contractReference: 'FICT/契約書/架空_第2版.pdf',
    milestones: [{seq: 1, dueOn: '2026-05-01', shareBps: 3333}, {seq: 2, dueOn: '2026-09-01', shareBps: 6667}]};
  assert.deepEqual(formFromVersion(latest), {budget: '52,364,117', ratePercent: '12.5',
    milestones: [{month: '2026-05', sharePercent: '33.33'}, {month: '2026-09', sharePercent: '66.67'}], contractReference: 'FICT/契約書/架空_第2版.pdf', note: ''});
});

test('FR-REV-CWORK-035 欄の文字は受け口の本文（総製作費は整数円、受託費率と節目の割合は bp、節目の月は月初の日）になり、見ていた版の番号を添える', () => {
  const built = contractVersionBody(form(), 2);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  assert.deepEqual(built.body, {previousVersionNo: 2, budgetYen: 52364117, markupBps: 1250,
    milestones: [{dueOn: '2026-05-01', shareBps: 3333}, {dueOn: '2026-09-01', shareBps: 3334}, {dueOn: '2027-01-01', shareBps: 3333}],
    contractReference: 'FICT/契約書/架空_第2版.pdf', note: null});
  // 全角・% 付き・円の書き方も読む（厳密さはシステムが吸収する）。版が無ければ見ていた版は 0
  const loose = contractVersionBody(form({budget: '￥１，０００，０００円', ratePercent: '１５％', milestones: [{month: '2026/5', sharePercent: '100%'}]}), null);
  assert.deepEqual([loose.ok, loose.body.previousVersionNo, loose.body.budgetYen, loose.body.markupBps, loose.body.milestones], [true, 0, 1000000, 1500, [{dueOn: '2026-05-01', shareBps: 10000}]]);
});

test('FR-REV-CWORK-035 範囲の外の受託費率・割合の和は止めずに受け口へ送り（判定は受け口の項目ごとの 400）、読めない欄と空の受託費率だけをここで止める', () => {
  // 16%・9.99% は bp にして送る（範囲の判定を画面に重ねない）
  assert.deepEqual([contractVersionBody(form({ratePercent: '16'}), 0).ok, contractVersionBody(form({ratePercent: '16'}), 0).body.markupBps], [true, 1600]);
  assert.equal(contractVersionBody(form({ratePercent: '9.99'}), 0).body.markupBps, 999);
  assert.equal(contractVersionBody(form({milestones: [{month: '2026-05', sharePercent: '99.99'}]}), 0).ok, true);
  // 空の受託費率は送らない（受け口は空を既定 10% にするので、打ち間違いで率が黙って既定に戻らないようにする）
  const blank = contractVersionBody(form({ratePercent: ' '}), 0);
  assert.equal(blank.ok, false);
  assert.match(blank.errors.markupBps, /受託費率を入れてください（既定は 10%）/);
  assert.match(contractVersionBody(form({ratePercent: '12.345'}), 0).errors.markupBps, /小数は2桁まで/);
  assert.match(contractVersionBody(form({ratePercent: '十二'}), 0).errors.markupBps, /% の数/);
  // 総製作費: 空・負・小数は止める
  assert.match(contractVersionBody(form({budget: ''}), 0).errors.budgetYen, /総製作費（税別・円）を入れてください/);
  assert.equal(contractVersionBody(form({budget: '-1000'}), 0).ok, false);
  assert.match(contractVersionBody(form({budget: '1000.5'}), 0).errors.budgetYen, /1円単位/);
  // 節目: 月と割合は行ごとの項目の名前（受け口と同じ milestones.<行>.dueOn・shareBps）で返す
  const rows = contractVersionBody(form({milestones: [{month: '2026-05', sharePercent: '50'}, {month: '', sharePercent: 'abc'}]}), 0);
  assert.deepEqual(Object.keys(rows.errors).sort(), ['milestones.1.dueOn', 'milestones.1.shareBps']);
});

test('FR-REV-CWORK-035 受託費の見込みは総製作費×受託費率の truncate（版に残る額と同じ）で、範囲の外の率と読めない欄では出さない', () => {
  // 52,364,117 × 12.5% ＝ 6,545,514.625 → 6,545,514
  assert.deepEqual(feePreview(form()), {feeYen: 6545514, budgetYen: 52364117, markupBps: 1250, reason: null});
  // 範囲の両端は出し、1bp 外は出さない
  assert.equal(feePreview(form({ratePercent: '10'})).feeYen, 5236411);
  assert.equal(feePreview(form({ratePercent: '15'})).feeYen, 7854617);
  assert.deepEqual([feePreview(form({ratePercent: '15.01'})).feeYen, feePreview(form({ratePercent: '15.01'})).reason], [null, 'rate_range']);
  assert.deepEqual([feePreview(form({ratePercent: '9.99'})).feeYen, feePreview(form({ratePercent: '9.99'})).reason], [null, 'rate_range']);
  assert.equal(feePreview(form({ratePercent: ''})).reason, 'rate');
  assert.equal(feePreview(form({budget: ''})).reason, 'budget');
  assert.equal(feePreview(form({budget: '0'})).reason, 'budget');
});

test('FR-REV-CWORK-035 節目の割合の和（表示用）と、受け口のエラーを欄へ当てる項目の名前', () => {
  assert.equal(shareTotalBps(form()), 10000);
  assert.equal(shareTotalBps(form({milestones: [{month: '2026-05', sharePercent: '40'}, {month: '2026-06', sharePercent: 'x'}]})), 4000);
  assert.deepEqual(contractVersionFieldNames(2), ['previousVersionNo', 'budgetYen', 'markupBps', 'milestones', 'contractReference', 'note',
    'milestones.0.dueOn', 'milestones.0.shareBps', 'milestones.1.dueOn', 'milestones.1.shareBps']);
});
