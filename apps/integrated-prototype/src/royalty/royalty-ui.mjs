// ロイヤリティの画面で使う純関数（入力欄の状態 ⇔ API の形、選択肢、状態の色）。React に依存しない（node で試験する）。
import {CYCLE_PRESETS, DUE_PRESETS, TARGET_CHANNELS, WINDOW_FEE_BASES, EXPENSE_BASES, percentToBps, bpsToPercent, isMonth, parseCloseList} from './royalty-model.mjs';
import {optionsOf, labelOf} from '../ui/labels.mjs';
import {parseYen} from '../ui/parse-input.mjs';

export const CATEGORY_OPTIONS = optionsOf('royaltyCategory');
export const CALC_METHOD_OPTIONS = optionsOf('royaltyCalcMethod');
export const BASE_KIND_OPTIONS = optionsOf('royaltyBaseKind');
export const IRREGULAR_KIND_OPTIONS = optionsOf('royaltyIrregularKind');
export const CHANNEL_OPTIONS = TARGET_CHANNELS.map((value) => ({value, label: labelOf('royaltyChannel', value)}));
export const CYCLE_OPTIONS = CYCLE_PRESETS.map((preset) => ({value: preset.id, label: preset.label}));
export const DUE_OPTIONS = DUE_PRESETS.map((preset) => ({value: preset.id, label: preset.label}));
export const DAY_OPTIONS = [{value: 'eom', label: '月末'}, ...Array.from({length: 31}, (_, index) => ({value: String(index + 1), label: `${index + 1}日`}))];
export const OFFSET_OPTIONS = Array.from({length: 13}, (_, index) => ({value: String(index), label: index === 0 ? '締め月の' : `締め月の${index}か月後の`}));

// 状態の色（Notice・ホームのカードと同じ語: bad 要対応 / warn 確認待ち / info お知らせ / ok 完了）
export const STATUS_TONE = Object.freeze({open: 'info', pending: 'warn', overdue: 'bad', created: 'info', reported: 'ok', paid: 'ok', merged: 'info', voided: 'info'});
export const statusTone = (status) => STATUS_TONE[status] || 'info';

export const dueInputOf = (offset, day) => {
  const preset = DUE_PRESETS.find((p) => p.offset === Number(offset) && p.day === day);
  return {preset: preset ? preset.id : 'custom', offset: String(offset ?? 1), day: String(day ?? 'eom')};
};
export function dueFromInput(input) {
  const preset = DUE_PRESETS.find((p) => p.id === input.preset && p.offset !== null);
  if (preset) return {offset: preset.offset, day: preset.day};
  return {offset: Number(input.offset), day: input.day === 'eom' ? 'eom' : String(input.day)};
}

// 条件版の入力欄の初期値（文字のまま持ち、送る前に termPayload で変換する）
export function emptyTerm(effectiveFrom = '') {
  return {effectiveFrom, calcMethod: 'rate', baseKind: 'gross_sales', ratePercent: '', windowFeePercent: '', fixedAmount: '', advance: '0', minPayment: '',
    channels: [], expenseCategories: [], clauseReference: '', reason: ''};
}

export function termFromVersion(term) {
  return {
    effectiveFrom: '', calcMethod: term.calcMethod, baseKind: term.baseKind || 'gross_sales', ratePercent: term.rateBps === null || term.rateBps === undefined ? '' : bpsToPercent(term.rateBps),
    windowFeePercent: term.windowFeeBps === null || term.windowFeeBps === undefined ? '' : bpsToPercent(term.windowFeeBps), fixedAmount: term.fixedAmountYen === null || term.fixedAmountYen === undefined ? '' : String(term.fixedAmountYen),
    advance: String(term.advanceYen ?? 0), minPayment: term.minPaymentYen === null || term.minPaymentYen === undefined ? '' : String(term.minPaymentYen),
    channels: [...(term.channels || [])], expenseCategories: [...(term.expenseCategories || [])], clauseReference: term.clauseReference || '', reason: '',
  };
}

// 入力欄 → API。読めない値は errors（項目名 → 日本語）に入れ、サーバーの検査に任せる値はそのまま送る
export function termPayload(state) {
  const errors = {};
  const payload = {effectiveFrom: state.effectiveFrom, calcMethod: state.calcMethod, clauseReference: state.clauseReference, reason: state.reason || null};
  if (state.calcMethod === 'rate') {
    payload.baseKind = state.baseKind;
    payload.rateBps = percentToBps(state.ratePercent);
    if (payload.rateBps === null) errors.rateBps = '料率を「10」や「2.5」（%）の形で入れてください';
    if (WINDOW_FEE_BASES.includes(state.baseKind)) {
      payload.windowFeeBps = percentToBps(state.windowFeePercent);
      if (payload.windowFeeBps === null) errors.windowFeeBps = '窓口手数料率を「25」（%）の形で入れてください';
    }
    payload.channels = [...state.channels];
    payload.expenseCategories = EXPENSE_BASES.includes(state.baseKind) ? [...state.expenseCategories] : [];
  }
  if (state.calcMethod === 'fixed_monthly') {
    const fixed = parseYen(state.fixedAmount, {allowNegative: false});
    if (!fixed.ok || fixed.value === null) errors.fixedAmountYen = '毎月の定額を入れてください';
    else payload.fixedAmountYen = fixed.value;
  }
  const advance = parseYen(state.advance, {allowNegative: false});
  if (!advance.ok) errors.advanceYen = advance.error;
  else payload.advanceYen = advance.value ?? 0;
  const min = parseYen(state.minPayment, {allowNegative: false});
  if (!min.ok) errors.minPaymentYen = min.error;
  else payload.minPaymentYen = min.value;
  return {payload, errors};
}

export function emptyPhase(startsMonth = '') {
  return {startsMonth, endsMonth: '', preset: 'semiannual', customCloseMonths: '', firstCloseImmediate: false,
    report: dueInputOf(1, 'eom'), payment: dueInputOf(2, 'eom'), note: ''};
}

export function phaseFromSaved(phase) {
  const preset = CYCLE_PRESETS.find((p) => p.cycleKind === phase.cycleKind && (p.anchorMonth === null || p.anchorMonth === Number(phase.anchorMonth)));
  return {startsMonth: phase.startsMonth, endsMonth: phase.endsMonth || '', preset: preset ? preset.id : `${phase.cycleKind}:${phase.anchorMonth}`,
    customCloseMonths: phase.customCloseMonths ? phase.customCloseMonths.split(',').join(', ') : '', firstCloseImmediate: Boolean(phase.firstCloseImmediate),
    report: dueInputOf(phase.reportOffsetMonths, phase.reportDay), payment: dueInputOf(phase.paymentOffsetMonths, phase.paymentDay), note: phase.note || ''};
}

export function phasePayload(phase) {
  let cycleKind;
  let anchorMonth = null;
  const preset = CYCLE_PRESETS.find((p) => p.id === phase.preset);
  if (preset) { cycleKind = preset.cycleKind; anchorMonth = preset.anchorMonth; } else {
    const [kind, anchor] = String(phase.preset || '').split(':');
    cycleKind = kind;
    anchorMonth = anchor ? Number(anchor) : null;
  }
  const report = dueFromInput(phase.report);
  const payment = dueFromInput(phase.payment);
  return {
    startsMonth: phase.startsMonth, endsMonth: phase.endsMonth || null, cycleKind, anchorMonth,
    customCloseMonths: cycleKind === 'custom' ? parseCloseList(phase.customCloseMonths).months.join(',') || phase.customCloseMonths : null,
    firstCloseImmediate: Boolean(phase.firstCloseImmediate), reportOffsetMonths: report.offset, reportDay: report.day,
    paymentOffsetMonths: payment.offset, paymentDay: payment.day, note: phase.note || null,
  };
}

export const allowsFirstClose = (presetId) => {
  const preset = CYCLE_PRESETS.find((p) => p.id === presetId);
  return Boolean(preset && ['quarterly', 'semiannual', 'annual', 'custom'].includes(preset.cycleKind));
};

// サーバーの検査結果（details.errors の field）を、入力欄の名前へ（term.rateBps → rateBps、schedule.phases.0.startsMonth → phases.0.startsMonth）
export function fieldErrorsOf(error, prefix = '') {
  const list = Array.isArray(error?.details?.errors) ? error.details.errors : Array.isArray(error?.details) ? error.details : [];
  const map = {};
  for (const item of list) {
    if (!item || !item.field) continue;
    const field = prefix && String(item.field).startsWith(`${prefix}.`) ? String(item.field).slice(prefix.length + 1) : String(item.field);
    if (!map[field]) map[field] = item.message;
  }
  return map;
}

// 一覧の「保留」の列。件数は報告書（期間）ごとの締め月時点の未解決の保留で、同じ保留が後の期間にも数えられるため合計しない
export const HOLD_COUNT_COLUMN = Object.freeze({key: 'holdCount', label: '未解決の保留（締め月時点）', type: 'int', total: 'none'});

// 一括で確定できる期間（blockedReason はサーバーが付ける）
export {isCreatablePeriod} from './royalty-model.mjs';

// 集計シートの権利者×月の右側の列。paymentScope が 'none'（作品・種別で絞った表）のときは、支払累計・報告済み・未払残を出さない
// （支払は権利者の全契約で1つの値のため、絞り込んだ累計から引くと未払残が狂う）
export function ledgerHolderTail(paymentScope = 'all') {
  const tail = [
    {key: 'periodYen', label: '期間計', type: 'yen', total: 'sum'},
    {key: 'cumulativeYen', label: '契約開始からの累計', type: 'yen', total: 'sum'},
    {key: 'adjustmentYen', label: '調整（イレギュラー）の累計', type: 'yen', total: 'sum'},
    {key: 'recoupYen', label: '前払金の充当', type: 'yen', total: 'sum'},
  ];
  if (paymentScope !== 'none') {
    tail.push({key: 'reportedYen', label: '報告済み（当期＋調整）', type: 'yen', total: 'sum', hidden: true},
      {key: 'paidYen', label: '支払累計', type: 'yen', total: 'sum'},
      {key: 'unpaidYen', label: '未払残', type: 'yen', total: 'sum'});
  }
  tail.push({key: 'holdSalesYen', label: '保留の対象売上', type: 'yen', total: 'sum'});
  return tail;
}

// 期間のキー（権利者:締め月）
export const periodKey = (holderId, closeMonth) => `${holderId}:${closeMonth}`;
export const validMonth = isMonth;
// 今日（日本時間）の日付。画面の既定の基準日・記録日に使う
export const todayJst = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
