import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyTerm, termFromVersion, termPayload, emptyPhase, phaseFromSaved, phasePayload, dueInputOf, dueFromInput, fieldErrorsOf, statusTone, allowsFirstClose,
  CATEGORY_OPTIONS, CHANNEL_OPTIONS, CYCLE_OPTIONS,
} from '../src/royalty/royalty-ui.mjs';
import {normalizeTermInput, normalizeScheduleInput} from '../src/royalty/royalty-model.mjs';

test('画面の選択肢はすべて日本語（英字のコードを出さない）', () => {
  for (const option of [...CATEGORY_OPTIONS, ...CHANNEL_OPTIONS, ...CYCLE_OPTIONS]) assert.doesNotMatch(option.label, /^[a-z_]+$/);
  assert.deepEqual(CATEGORY_OPTIONS.map((o) => o.label), ['監督料', '脚本料', '音楽著作権料', '原作料', 'クリエーター報酬', 'その他']);
  assert.ok(!CHANNEL_OPTIONS.some((o) => o.value === 'package'), '区分未確認は対象に選ばせない');
});

test('条件版の入力欄 → API（%→bp、円の文字→整数）はサーバーの検査を通る', () => {
  const state = {...emptyTerm('2025-04'), baseKind: 'after_window_fee_and_expenses', ratePercent: '３．５', windowFeePercent: '25', advance: '１，０００，０００円', minPayment: '',
    channels: ['digital'], expenseCategories: ['宣伝費'], clauseReference: '第8条'};
  const {payload, errors} = termPayload(state);
  assert.deepEqual(errors, {});
  assert.equal(payload.rateBps, 350);
  assert.equal(payload.windowFeeBps, 2500);
  assert.equal(payload.advanceYen, 1000000);
  assert.equal(payload.minPaymentYen, null);
  assert.equal(normalizeTermInput(payload).ok, true);
  assert.ok(termPayload({...emptyTerm('2025-04'), ratePercent: '10%%x', clauseReference: 'x'}).errors.rateBps);
  const fixed = termPayload({...emptyTerm('2025-04'), calcMethod: 'fixed_monthly', fixedAmount: '30,000', clauseReference: 'x'});
  assert.equal(fixed.payload.fixedAmountYen, 30000);
  assert.equal(fixed.payload.rateBps, undefined);
  const back = termFromVersion({calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1050, windowFeeBps: null, fixedAmountYen: null, advanceYen: 0, minPaymentYen: 5000, channels: ['theatrical'], expenseCategories: [], clauseReference: '第2条'});
  assert.equal(back.ratePercent, '10.5');
  assert.equal(back.minPayment, '5000');
  assert.equal(back.effectiveFrom, '', '新しい版の適用開始は入れ直す');
});

test('FR-SETL-STMT-007 サイクルのフェーズの入力欄 ⇔ API（プリセット・期限・登録済みの基準月）', () => {
  const phase = {...emptyPhase('2025-01'), preset: 'annual-6', firstCloseImmediate: true, report: dueInputOf(2, 'eom'), payment: {preset: 'custom', offset: '3', day: '15'}};
  const payload = phasePayload(phase);
  assert.deepEqual(payload, {startsMonth: '2025-01', endsMonth: null, cycleKind: 'annual', anchorMonth: 6, customCloseMonths: null, firstCloseImmediate: true,
    reportOffsetMonths: 2, reportDay: 'eom', paymentOffsetMonths: 3, paymentDay: '15', note: null});
  assert.equal(normalizeScheduleInput({phases: [payload]}).ok, true);
  const saved = phaseFromSaved({startsMonth: '2025-01', endsMonth: null, cycleKind: 'quarterly', anchorMonth: 1, customCloseMonths: null, firstCloseImmediate: false,
    reportOffsetMonths: 1, reportDay: '20', paymentOffsetMonths: 2, paymentDay: 'eom', note: null});
  assert.equal(saved.preset, 'quarterly:1', 'プリセットに無い基準月もそのまま保つ');
  assert.deepEqual(phasePayload(saved).anchorMonth, 1);
  assert.deepEqual(saved.report, {preset: 'custom', offset: '1', day: '20'});
  assert.deepEqual(dueFromInput(saved.report), {offset: 1, day: '20'});
  const custom = phasePayload({...emptyPhase('2025-01'), preset: 'custom', customCloseMonths: '2025-12、2025-06'});
  assert.equal(custom.customCloseMonths, '2025-06,2025-12');
  assert.equal(allowsFirstClose('monthly'), false);
  assert.equal(allowsFirstClose('custom'), true);
});

test('サーバーの検査結果を入力欄の名前へ、状態の色', () => {
  const error = {details: {errors: [{field: 'term.rateBps', message: '料率'}, {field: 'schedule.phases.0.startsMonth', message: '開始月'}, {field: 'title', message: '契約名'}]}};
  assert.deepEqual(fieldErrorsOf(error, 'term'), {rateBps: '料率', 'schedule.phases.0.startsMonth': '開始月', title: '契約名'});
  assert.deepEqual(fieldErrorsOf(error), {'term.rateBps': '料率', 'schedule.phases.0.startsMonth': '開始月', title: '契約名'});
  assert.equal(statusTone('overdue'), 'bad');
  assert.equal(statusTone('pending'), 'warn');
  assert.equal(statusTone('paid'), 'ok');
  assert.equal(statusTone('unknown'), 'info');
});
