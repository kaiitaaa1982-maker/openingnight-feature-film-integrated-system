// ロイヤリティの計算（純関数）。サーバー・画面・試験が同じ関数を使う。DB に触らず、node:* も import しない。
// 設計: docs/platform/team-development/royalty-committee-design.md §3。
// 流れ: 売上（計上月）→ 条件版（料率・基礎・対象流通）→ 月の発生額 → サイクルのフェーズで締め月 → イレギュラーの台帳
//       → 報告書（権利者×締め月: 前回まで・当期・累計、報告後の修正、調整、前払金の充当、繰越）→ 期間の一覧・集計シート。
// 金額は税抜の整数円、率は bp。料率の端数は切り捨て（0に向かって）。算定できない額は0円にせず保留（HOLD）に残す。
import {channelMatches, CHANNEL_LABELS} from '../sales/channel-group.mjs';
import {labelOf} from '../ui/labels.mjs';

export const CALCULATION_VERSION = 'royalty-cycle-v1';
export const ROYALTY_CATEGORIES = Object.freeze(['director', 'screenplay', 'music', 'original', 'creator', 'other']);
export const CALC_METHODS = Object.freeze(['rate', 'fixed_monthly', 'manual']);
export const BASE_KINDS = Object.freeze(['gross_sales', 'after_window_fee', 'after_window_fee_and_expenses', 'committee_income', 'committee_income_after_expenses']);
export const WINDOW_FEE_BASES = Object.freeze(['after_window_fee', 'after_window_fee_and_expenses']);
export const EXPENSE_BASES = Object.freeze(['after_window_fee_and_expenses', 'committee_income_after_expenses']);
export const COMMITTEE_BASES = Object.freeze(['committee_income', 'committee_income_after_expenses']);
export const CYCLE_KINDS = Object.freeze(['monthly', 'quarterly', 'semiannual', 'annual', 'custom', 'manual', 'none']);
export const ANCHORED_CYCLES = Object.freeze(['quarterly', 'semiannual', 'annual']);
export const IRREGULAR_KINDS = Object.freeze(['adjust_amount', 'move_period', 'hold', 'release', 'note']);
// 対象流通に選べる区分（区分未確認のビデオグラムは、レンタルとセルの両方を選ぶと入る）
export const TARGET_CHANNELS = Object.freeze(['theatrical', 'rental', 'sell', 'digital', 'broadcast', 'overseas', 'other']);
export const PERIOD_STATUSES = Object.freeze(['open', 'pending', 'overdue', 'created', 'reported', 'paid', 'merged']);
const STEP = Object.freeze({quarterly: 3, semiannual: 6, annual: 12});

// 画面で選ぶサイクルのプリセット（定型業務の算出シートの型）。anchorMonth は締め月の基準
export const CYCLE_PRESETS = Object.freeze([
  Object.freeze({id: 'monthly', label: '毎月', cycleKind: 'monthly', anchorMonth: null}),
  Object.freeze({id: 'quarterly', label: '四半期（3・6・9・12月締め）', cycleKind: 'quarterly', anchorMonth: 3}),
  Object.freeze({id: 'semiannual', label: '半年（6・12月締め）', cycleKind: 'semiannual', anchorMonth: 6}),
  Object.freeze({id: 'annual-12', label: '1年（12月締め）', cycleKind: 'annual', anchorMonth: 12}),
  Object.freeze({id: 'annual-6', label: '1年（6月末締め）', cycleKind: 'annual', anchorMonth: 6}),
  Object.freeze({id: 'annual-3', label: '1年（3月末締め）', cycleKind: 'annual', anchorMonth: 3}),
  Object.freeze({id: 'custom', label: '特殊（締め月を列挙）', cycleKind: 'custom', anchorMonth: null}),
  Object.freeze({id: 'manual', label: '別途協議', cycleKind: 'manual', anchorMonth: null}),
  Object.freeze({id: 'none', label: 'ロイヤリティ計上無し', cycleKind: 'none', anchorMonth: null}),
]);
// 報告条件・支払条件のプリセット（締め月末から offset か月後の day 日。'eom' は月末）
export const DUE_PRESETS = Object.freeze([
  Object.freeze({id: 'next-eom', label: '翌月末', offset: 1, day: 'eom'}),
  Object.freeze({id: 'next2-eom', label: '翌々月末', offset: 2, day: 'eom'}),
  Object.freeze({id: 'next3-eom', label: '翌々々月末', offset: 3, day: 'eom'}),
  Object.freeze({id: 'custom', label: '日付指定', offset: null, day: null}),
]);

// ---------- 月・日 ----------
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const isMonth = (value) => typeof value === 'string' && MONTH_RE.test(value);
export const isDate = (value) => typeof value === 'string' && DATE_RE.test(value) && Number(value.slice(8, 10)) <= lastDayOf(value.slice(0, 7));
export function addMonths(ym, n) {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}
export function monthsBetween(from, to, limit = 1200) {
  const out = [];
  for (let m = from; m <= to && out.length < limit; m = addMonths(m, 1)) out.push(m);
  return out;
}
export function lastDayOf(ym) {
  return new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
}
const monthNumber = (ym) => Number(ym.slice(5, 7));
export const monthLabel = (ym) => (isMonth(ym) ? `${Number(ym.slice(0, 4))}年${monthNumber(ym)}月` : '未確認');
const maxMonth = (a, b) => (a > b ? a : b);
const minMonth = (a, b) => (a < b ? a : b);

// 料率の額（0に向かって切り捨て。負の月もそのまま）。app.mjs の signedRateAmount と同じ式
export function signedRateAmount(value, bps) {
  if (!Number.isSafeInteger(value) || !Number.isInteger(bps)) throw new Error('金額または料率を整数として確認できません');
  const sign = value < 0 ? -1n : 1n;
  return Number(sign * (BigInt(Math.abs(value)) * BigInt(bps) / 10000n));
}

// 画面の「10.5（%）」と bp の変換。小数は2桁まで（1bp）。読めないときは null
export function percentToBps(text) {
  const clean = String(text ?? '').normalize('NFKC').replace(/[%％\s,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function bpsToPercent(bps) {
  if (bps === null || bps === undefined) return '';
  const whole = Math.trunc(bps / 100);
  const rest = Math.abs(bps % 100);
  return rest ? `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}` : String(whole);
}
export const rateText = (bps) => (bps === null || bps === undefined ? '—' : `${bpsToPercent(bps)}%`);

// ---------- サイクル ----------
export function parseCloseList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,、\s]+/);
  const months = list.map((item) => String(item).trim()).filter(Boolean);
  const invalid = months.filter((item) => !isMonth(item));
  return {months: [...new Set(months.filter(isMonth))].sort(), invalid};
}

// 計上月 → 締め月（ロイヤリティの計上月）。締められないとき（別途協議・計上無し・列挙の尽きた特殊）は null
export function closeMonthFor(accrualMonth, phase) {
  if (!phase || !isMonth(accrualMonth)) return null;
  const kind = phase.cycleKind;
  if (kind === 'monthly') return accrualMonth;
  if ((ANCHORED_CYCLES.includes(kind) || kind === 'custom') && phase.firstCloseImmediate && accrualMonth === phase.startsMonth) return accrualMonth;
  if (ANCHORED_CYCLES.includes(kind)) {
    const step = STEP[kind];
    const anchor = Number(phase.anchorMonth);
    if (!Number.isInteger(anchor) || anchor < 1 || anchor > 12) return null;
    const wait = (((anchor - monthNumber(accrualMonth)) % step) + step) % step;
    return addMonths(accrualMonth, wait);
  }
  if (kind === 'custom') return parseCloseList(phase.customCloseMonths).months.find((month) => month >= accrualMonth) || null;
  return null;
}

// 締め月末から offsetMonths か月後の day 日（'eom' は月末。月の日数を超える日は月末）
export function dueDate(closeMonth, offsetMonths, day) {
  if (!isMonth(closeMonth)) return null;
  const target = addMonths(closeMonth, Number(offsetMonths) || 0);
  const last = lastDayOf(target);
  const d = day === 'eom' || day === null || day === undefined ? last : Math.min(Number(day), last);
  return `${target}-${String(d).padStart(2, '0')}`;
}

export function phaseFor(schedule, month) {
  const phases = schedule?.phases || [];
  return phases.find((phase) => phase.startsMonth <= month && month <= (phase.endsMonth || '9999-12')) || null;
}

// その月に効いている条件版（effective_from が月以前で最大）
export function termFor(versions, month) {
  let found = null;
  for (const version of versions || []) if (version.effectiveFrom <= month && (!found || version.effectiveFrom > found.effectiveFrom)) found = version;
  return found;
}

export function presetOfPhase(phase) {
  if (!phase) return null;
  return CYCLE_PRESETS.find((preset) => preset.cycleKind === phase.cycleKind && (preset.anchorMonth === null || preset.anchorMonth === Number(phase.anchorMonth)))?.id || null;
}

export function cycleText(phase) {
  if (!phase) return 'サイクル未登録';
  const preset = CYCLE_PRESETS.find((p) => p.id === presetOfPhase(phase));
  let text;
  if (preset) text = preset.label;
  else if (ANCHORED_CYCLES.includes(phase.cycleKind)) {
    const step = STEP[phase.cycleKind];
    const anchor = Number(phase.anchorMonth);
    const closes = [];
    for (let k = 0; k < 12 / step; k += 1) closes.push(((anchor - 1 + k * step) % 12) + 1);
    text = `${labelOf('royaltyCycleKind', phase.cycleKind)}（${closes.sort((a, b) => a - b).join('・')}月締め）`;
  } else text = labelOf('royaltyCycleKind', phase.cycleKind);
  if (phase.cycleKind === 'custom') text += `: ${parseCloseList(phase.customCloseMonths).months.map(monthLabel).join('、')}`;
  if (phase.firstCloseImmediate) text += '・初月即締';
  return text;
}

export function dueText(offset, day) {
  const preset = DUE_PRESETS.find((p) => p.offset === Number(offset) && p.day === day);
  if (preset) return preset.label;
  const when = Number(offset) === 0 ? '締め月の' : `締め月の${offset}か月後の`;
  return `${when}${day === 'eom' ? '月末' : `${day}日`}`;
}

// ---------- 入力の検査（API と画面で共通） ----------
const intOrNull = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const cleanText = (value) => (value === null || value === undefined ? '' : String(value).trim());

export function normalizeTermInput(input = {}) {
  const errors = [];
  const add = (field, message) => errors.push({field, message});
  const effectiveFrom = cleanText(input.effectiveFrom);
  if (!isMonth(effectiveFrom)) add('effectiveFrom', '適用開始の計上月を「2026-04」の形で入れてください');
  const calcMethod = cleanText(input.calcMethod);
  if (!CALC_METHODS.includes(calcMethod)) add('calcMethod', '計算方法（料率・毎月定額・実額入力）を選んでください');
  let baseKind = null;
  let rateBps = null;
  let windowFeeBps = null;
  let fixedAmountYen = null;
  const channels = [...new Set((Array.isArray(input.channels) ? input.channels : []).map(String))];
  const categories = [...new Set((Array.isArray(input.expenseCategories) ? input.expenseCategories : []).map(cleanText).filter(Boolean))];
  if (calcMethod === 'rate') {
    baseKind = cleanText(input.baseKind);
    if (!BASE_KINDS.includes(baseKind)) add('baseKind', '料率をかける基礎を選んでください');
    rateBps = intOrNull(input.rateBps);
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) add('rateBps', '料率は0〜100%で入れてください');
    if (WINDOW_FEE_BASES.includes(baseKind)) {
      windowFeeBps = intOrNull(input.windowFeeBps);
      if (!Number.isInteger(windowFeeBps) || windowFeeBps < 0 || windowFeeBps > 10000) add('windowFeeBps', '窓口手数料率は0〜100%で入れてください');
    }
    const bad = channels.filter((channel) => !TARGET_CHANNELS.includes(channel));
    if (bad.length) add('channels', '対象流通を一覧から選んでください（区分未確認のビデオグラムは、レンタルとセルの両方を選ぶと入ります）');
    if (categories.length && !EXPENSE_BASES.includes(baseKind)) add('expenseCategories', '控除する経費の費目は、経費を差し引く基礎のときだけ選べます');
    if (categories.some((category) => category.length > 100)) add('expenseCategories', '費目は100文字以内です');
  } else {
    if (channels.length) add('channels', '対象流通は料率の契約だけで選べます');
    if (categories.length) add('expenseCategories', '控除する経費の費目は料率の契約だけで選べます');
  }
  if (calcMethod === 'fixed_monthly') {
    fixedAmountYen = intOrNull(input.fixedAmountYen);
    if (!Number.isSafeInteger(fixedAmountYen) || fixedAmountYen < 0) add('fixedAmountYen', '毎月の定額を0円以上の整数で入れてください');
  }
  const advanceYen = intOrNull(input.advanceYen) ?? 0;
  if (!Number.isSafeInteger(advanceYen) || advanceYen < 0) add('advanceYen', '前払金は0円以上の整数で入れてください（なしは0）');
  const minPaymentYen = intOrNull(input.minPaymentYen);
  if (minPaymentYen !== null && (!Number.isSafeInteger(minPaymentYen) || minPaymentYen < 0)) add('minPaymentYen', '支払の下限は0円以上の整数で入れてください（なしは空欄）');
  const clauseReference = cleanText(input.clauseReference);
  if (!clauseReference) add('clauseReference', '根拠の条項（例: 第8条第2項）を入れてください');
  else if (clauseReference.length > 500) add('clauseReference', '根拠の条項は500文字以内です');
  const reason = cleanText(input.reason) || null;
  if (reason && reason.length > 1000) add('reason', '理由は1000文字以内です');
  return {ok: errors.length === 0, errors, value: {effectiveFrom, calcMethod, baseKind: calcMethod === 'rate' ? baseKind : null, rateBps, windowFeeBps,
    fixedAmountYen, advanceYen, minPaymentYen, clauseReference, reason, channels: calcMethod === 'rate' ? channels : [], expenseCategories: calcMethod === 'rate' && EXPENSE_BASES.includes(baseKind) ? categories : []}};
}

function normalizeDay(value) {
  if (value === 'eom' || value === null || value === undefined || value === '') return 'eom';
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? String(n) : null;
}

export function normalizeScheduleInput(input = {}) {
  const errors = [];
  const add = (field, message) => errors.push({field, message});
  const statementsFrom = cleanText(input.statementsFrom) || null;
  if (statementsFrom && !isMonth(statementsFrom)) add('statementsFrom', '報告書を作り始める締め月を「2026-06」の形で入れてください');
  const reason = cleanText(input.reason) || null;
  if (reason && reason.length > 1000) add('reason', '理由は1000文字以内です');
  const raw = Array.isArray(input.phases) ? input.phases : [];
  if (!raw.length) add('phases', 'サイクルのフェーズを1つ以上入れてください');
  if (raw.length > 24) add('phases', 'フェーズは24個までです');
  const phases = raw.map((phase, index) => {
    const n = index + 1;
    const field = (name) => `phases.${index}.${name}`;
    const startsMonth = cleanText(phase.startsMonth);
    if (!isMonth(startsMonth)) add(field('startsMonth'), `フェーズ${n}の開始月を「2026-04」の形で入れてください`);
    const endsMonth = cleanText(phase.endsMonth) || null;
    if (endsMonth && !isMonth(endsMonth)) add(field('endsMonth'), `フェーズ${n}の終了月を「2027-03」の形で入れてください（以降ずっとなら空欄）`);
    if (endsMonth && isMonth(startsMonth) && endsMonth < startsMonth) add(field('endsMonth'), `フェーズ${n}の終了月が開始月より前です`);
    const cycleKind = cleanText(phase.cycleKind);
    if (!CYCLE_KINDS.includes(cycleKind)) add(field('cycleKind'), `フェーズ${n}のサイクルを選んでください`);
    let anchorMonth = null;
    if (ANCHORED_CYCLES.includes(cycleKind)) {
      anchorMonth = intOrNull(phase.anchorMonth);
      if (!Number.isInteger(anchorMonth) || anchorMonth < 1 || anchorMonth > 12) add(field('anchorMonth'), `フェーズ${n}の締め月（1〜12月）を選んでください`);
    }
    let customCloseMonths = null;
    if (cycleKind === 'custom') {
      const parsed = parseCloseList(phase.customCloseMonths);
      if (parsed.invalid.length) add(field('customCloseMonths'), `フェーズ${n}の締め月に読めない月があります: ${parsed.invalid.join('、')}`);
      else if (!parsed.months.length) add(field('customCloseMonths'), `フェーズ${n}の締め月を「2026-06, 2026-12」のように並べてください`);
      else if (parsed.months.length > 240) add(field('customCloseMonths'), `フェーズ${n}の締め月は240個までです`);
      else if (isMonth(startsMonth) && parsed.months.at(-1) < startsMonth) add(field('customCloseMonths'), `フェーズ${n}の締め月が開始月より前だけです`);
      customCloseMonths = parsed.months.join(',');
    }
    const firstCloseImmediate = Boolean(phase.firstCloseImmediate) && phase.firstCloseImmediate !== '0';
    if (firstCloseImmediate && !(ANCHORED_CYCLES.includes(cycleKind) || cycleKind === 'custom')) add(field('firstCloseImmediate'), `フェーズ${n}: 初月即締は四半期・半年・1年・特殊のときだけ選べます`);
    const reportOffsetMonths = intOrNull(phase.reportOffsetMonths) ?? 1;
    const paymentOffsetMonths = intOrNull(phase.paymentOffsetMonths) ?? 2;
    if (!Number.isInteger(reportOffsetMonths) || reportOffsetMonths < 0 || reportOffsetMonths > 24) add(field('reportOffsetMonths'), `フェーズ${n}の報告期限（締め月から何か月後か）は0〜24で入れてください`);
    if (!Number.isInteger(paymentOffsetMonths) || paymentOffsetMonths < 0 || paymentOffsetMonths > 24) add(field('paymentOffsetMonths'), `フェーズ${n}の支払期限（締め月から何か月後か）は0〜24で入れてください`);
    const reportDay = normalizeDay(phase.reportDay);
    const paymentDay = normalizeDay(phase.paymentDay);
    if (!reportDay) add(field('reportDay'), `フェーズ${n}の報告期限の日は1〜31か月末にしてください`);
    if (!paymentDay) add(field('paymentDay'), `フェーズ${n}の支払期限の日は1〜31か月末にしてください`);
    const note = cleanText(phase.note) || null;
    if (note && note.length > 500) add(field('note'), `フェーズ${n}のメモは500文字以内です`);
    return {startsMonth, endsMonth, cycleKind, anchorMonth, customCloseMonths, firstCloseImmediate, reportOffsetMonths, reportDay, paymentOffsetMonths, paymentDay, note};
  });
  const sorted = [...phases].filter((p) => isMonth(p.startsMonth)).sort((a, b) => a.startsMonth.localeCompare(b.startsMonth));
  for (let i = 1; i < sorted.length; i += 1) {
    if ((sorted[i - 1].endsMonth || '9999-12') >= sorted[i].startsMonth) {
      add('phases', `フェーズの期間が重なっています（${monthLabel(sorted[i].startsMonth)}から）。前のフェーズの終了月を、次の開始月の前の月にしてください`);
      break;
    }
  }
  return {ok: errors.length === 0, errors, value: {statementsFrom, reason, phases: sorted.length === phases.length ? sorted : phases}};
}

// ---------- 月の発生額 ----------
const sumBy = (list, pick) => list.reduce((total, item) => total + (pick(item) ?? 0), 0);

function groupByMonth(list, monthOf) {
  const map = new Map();
  for (const item of list) {
    const month = monthOf(item);
    if (!map.has(month)) map.set(month, []);
    map.get(month).push(item);
  }
  return map;
}

// 1契約の計上月ごとの発生額。
// sales: [{accountingMonth, amount, channelGroup}]（作品の配賦済み売上明細）、expenses: [{id, month, category, description, amount}]（作品の経費）、
// committee: {available, rows:[{month, channelGroup, sales, income}], expenses:[{month, category, amount}]}（本委員会収入。委員会の担当が作る）、
// manual: [{id, accrualMonth, amountYen}]（実額の計上。取消の行を含む）。toMonth までの月を返す。
export function accrueAgreement({agreement, sales = [], expenses = [], committee = null, manual = [], toMonth, fromMonth = null}) {
  const terms = [...(agreement.terms || [])].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (!terms.length || !isMonth(toMonth)) return [];
  const start = fromMonth && fromMonth > terms[0].effectiveFrom ? fromMonth : terms[0].effectiveFrom;
  if (start > toMonth) return [];
  const inRange = (month) => isMonth(month) && month >= start && month <= toMonth;
  const salesByMonth = groupByMonth(sales.filter((line) => inRange(line.accountingMonth)), (line) => line.accountingMonth);
  const expensesByMonth = groupByMonth(expenses.filter((row) => inRange(row.month)), (row) => row.month);
  const committeeRows = groupByMonth((committee?.rows || []).filter((row) => inRange(row.month)), (row) => row.month);
  const committeeExpenses = groupByMonth((committee?.expenses || []).filter((row) => inRange(row.month)), (row) => row.month);
  const manualByMonth = groupByMonth(manual.filter((row) => inRange(row.accrualMonth)), (row) => row.accrualMonth);
  const months = new Set();
  const want = (month) => termFor(terms, month);
  for (const month of salesByMonth.keys()) { const t = want(month); if (t?.calcMethod === 'rate') months.add(month); }
  for (const month of expensesByMonth.keys()) { const t = want(month); if (t?.calcMethod === 'rate' && t.baseKind === 'after_window_fee_and_expenses') months.add(month); }
  for (const month of committeeRows.keys()) { const t = want(month); if (t?.calcMethod === 'rate' && COMMITTEE_BASES.includes(t.baseKind)) months.add(month); }
  for (const month of committeeExpenses.keys()) { const t = want(month); if (t?.calcMethod === 'rate' && t.baseKind === 'committee_income_after_expenses') months.add(month); }
  for (const month of manualByMonth.keys()) { const t = want(month); if (t?.calcMethod === 'manual') months.add(month); }
  terms.forEach((term, index) => {
    if (term.calcMethod !== 'fixed_monthly') return;
    const next = terms[index + 1];
    const end = minMonth(next ? addMonths(next.effectiveFrom, -1) : toMonth, toMonth);
    for (const month of monthsBetween(maxMonth(term.effectiveFrom, start), end)) months.add(month);
  });
  const items = [];
  for (const month of [...months].sort()) {
    const term = termFor(terms, month);
    const item = {
      key: `${agreement.id}:${month}`, agreementId: agreement.id, workId: agreement.workId, holderId: agreement.holderId, category: agreement.category,
      accrualMonth: month, termVersionId: term.id, termVersionNo: term.versionNo, calcMethod: term.calcMethod, baseKind: term.baseKind ?? null,
      rateBps: term.rateBps ?? null, windowFeeBps: term.windowFeeBps ?? null,
      salesYen: 0, windowFeeYen: 0, expenseYen: 0, committeeIncomeYen: 0, baseYen: null, royaltyYen: null,
      holdSalesYen: 0, excludedSalesYen: 0, holdReasons: [], channels: {}, expenseLines: [], manualEntries: [],
    };
    if (term.calcMethod === 'fixed_monthly') {
      item.royaltyYen = term.fixedAmountYen;
    } else if (term.calcMethod === 'manual') {
      const entries = manualByMonth.get(month) || [];
      item.manualEntries = entries.map((entry) => entry.id);
      item.royaltyYen = sumBy(entries, (entry) => entry.amountYen);
    } else {
      const filter = term.channels || [];
      const categories = term.expenseCategories || [];
      const categoryMatch = (category) => !categories.length || categories.includes(category);
      if (COMMITTEE_BASES.includes(term.baseKind)) {
        const rows = committeeRows.get(month) || [];
        if (!committee?.available) {
          const lines = salesByMonth.get(month) || [];
          item.salesYen = sumBy(lines.filter((line) => channelMatches(filter, line.channelGroup) !== false), (line) => line.amount);
          item.holdSalesYen = item.salesYen;
          item.holdReasons.push('製作委員会の条件が未登録のため、本委員会収入を計算できません');
        } else {
          let income = 0;
          let unknown = 0;
          let unknownSales = 0;
          let noWindow = 0;
          for (const row of rows) {
            const match = channelMatches(filter, row.channelGroup);
            // 窓口の条件が無い区分の売上（委員会の収入が null）は0円にせず保留にする
            if (row.income === null || row.income === undefined) {
              if (match !== false) noWindow += row.sales ?? 0;
              continue;
            }
            if (match === true) {
              income += row.income ?? 0;
              item.salesYen += row.sales ?? 0;
              item.channels[row.channelGroup] = (item.channels[row.channelGroup] || 0) + (row.income ?? 0);
            } else if (match === null) {
              unknown += row.income ?? 0;
              unknownSales += row.sales ?? 0;
            } else item.excludedSalesYen += row.sales ?? 0;
          }
          item.committeeIncomeYen = income;
          // 保留は「対象売上」で持つ（窓口の無い区分・委員会の条件が未登録の保留と同じ単位）。決められない本委員会収入は holdIncomeYen に別に持つ
          if (unknown || unknownSales) {
            item.holdSalesYen = unknownSales;
            item.holdIncomeYen = unknown;
            item.holdReasons.push('区分未確認のビデオグラム（レンタル／セルを決められない）の本委員会収入があります');
          }
          if (noWindow) {
            item.holdSalesYen = (item.holdSalesYen || 0) + noWindow;
            item.holdReasons.push('委員会の窓口の条件が無い区分の売上があり、本委員会収入を計算できません');
          }
          if (term.baseKind === 'committee_income_after_expenses') {
            const deducted = (committeeExpenses.get(month) || []).filter((row) => categoryMatch(row.category));
            item.expenseYen = sumBy(deducted, (row) => row.amount);
            item.expenseLines = deducted.map((row) => ({...row, source: 'committee'}));
          }
          item.baseYen = income - item.expenseYen;
          item.royaltyYen = signedRateAmount(item.baseYen, term.rateBps);
        }
      } else {
        let target = 0;
        let unknown = 0;
        for (const line of salesByMonth.get(month) || []) {
          const match = channelMatches(filter, line.channelGroup);
          if (match === true) {
            target += line.amount;
            item.channels[line.channelGroup] = (item.channels[line.channelGroup] || 0) + line.amount;
          } else if (match === null) unknown += line.amount;
          else item.excludedSalesYen += line.amount;
        }
        item.salesYen = target;
        if (unknown) {
          item.holdSalesYen = unknown;
          item.holdReasons.push('区分未確認のビデオグラム（レンタル／セルを決められない）の売上があります');
        }
        if (WINDOW_FEE_BASES.includes(term.baseKind)) item.windowFeeYen = signedRateAmount(target, term.windowFeeBps ?? 0);
        if (term.baseKind === 'after_window_fee_and_expenses') {
          const deducted = (expensesByMonth.get(month) || []).filter((row) => categoryMatch(row.category));
          item.expenseYen = sumBy(deducted, (row) => row.amount);
          item.expenseLines = deducted.map((row) => ({...row, source: 'work'}));
        }
        item.baseYen = target - item.windowFeeYen - item.expenseYen;
        item.royaltyYen = signedRateAmount(item.baseYen, term.rateBps);
      }
    }
    items.push(item);
  }
  return items;
}

// ---------- イレギュラーの台帳・サイクルを当てる ----------
// 取消された記録（と取消の行そのもの）を除いた、効いている記録
export function effectiveEntries(entries = []) {
  const reversed = new Set(entries.filter((entry) => entry.reversesEntryId).map((entry) => entry.reversesEntryId));
  return entries.filter((entry) => !entry.reversesEntryId && !reversed.has(entry.id)).sort((a, b) => a.id - b.id);
}

// 契約×計上月の保留の状態（hold と release を記録順に当て、最後が hold なら保留中）
export function holdStates(entries = []) {
  const state = new Map();
  for (const entry of effectiveEntries(entries)) {
    if (entry.kind !== 'hold' && entry.kind !== 'release') continue;
    const key = `${entry.agreementId}:${entry.accrualMonth}`;
    state.set(key, entry.kind === 'hold' ? {held: true, entryId: entry.id, reason: entry.reason} : {held: false, entryId: entry.id});
  }
  return state;
}

// 契約×計上月の締め月の変更（最後の記録が効く）
export function moveTargets(entries = []) {
  const moves = new Map();
  for (const entry of effectiveEntries(entries)) if (entry.kind === 'move_period') moves.set(`${entry.agreementId}:${entry.accrualMonth}`, entry);
  return moves;
}

function dueFrom(phase, closeMonth) {
  if (!phase || !closeMonth) return {reportDueOn: null, paymentDueOn: null};
  return {reportDueOn: dueDate(closeMonth, phase.reportOffsetMonths, phase.reportDay), paymentDueOn: dueDate(closeMonth, phase.paymentOffsetMonths, phase.paymentDay)};
}

// 発生額に締め月・保留・移行前（この仕組みの外で報告済み）を付ける。計上無しのフェーズの月は除く。
export function resolveItems({agreement, accruals = [], entries = []}) {
  const schedule = agreement.schedule || null;
  const holds = holdStates(entries.filter((entry) => entry.agreementId === agreement.id));
  const moves = moveTargets(entries.filter((entry) => entry.agreementId === agreement.id));
  const out = [];
  for (const accrual of accruals) {
    const item = {...accrual, holdReasons: [...(accrual.holdReasons || [])], closeMonth: null, phaseId: null, movedFrom: null, moveEntryId: null,
      held: false, holdEntryId: null, unscheduled: false, external: false, reportDueOn: null, paymentDueOn: null};
    const phase = phaseFor(schedule, accrual.accrualMonth);
    if (phase?.cycleKind === 'none') continue;
    let reason = null;
    if (!schedule) reason = 'サイクル（締め月の決まり）が未登録です';
    else if (!phase) reason = 'サイクルのフェーズの期間外のため、締め月を決められません';
    else {
      item.phaseId = phase.id ?? null;
      item.closeMonth = closeMonthFor(accrual.accrualMonth, phase);
      if (!item.closeMonth) reason = phase.cycleKind === 'manual' ? '別途協議のため締め月が決まっていません（イレギュラーの台帳で締め月を指定してください）' : '特殊サイクルの締め月の列挙に、この計上月以後の月がありません';
    }
    const move = moves.get(accrual.key);
    if (move) {
      item.movedFrom = item.closeMonth;
      item.closeMonth = move.closeMonth;
      item.moveEntryId = move.id;
      reason = null;
    }
    if (reason) { item.unscheduled = true; item.holdReasons.push(reason); }
    const hold = holds.get(accrual.key);
    if (hold?.held) { item.held = true; item.holdEntryId = hold.entryId; item.holdReasons.push(`イレギュラーの台帳で保留中（${hold.reason}）`); }
    if (item.royaltyYen === null && !item.holdReasons.length) item.holdReasons.push('発生額を計算できません');
    Object.assign(item, dueFrom(phase || (schedule?.phases || [])[0], item.closeMonth));
    if (schedule?.statementsFrom && item.closeMonth && item.closeMonth < schedule.statementsFrom) item.external = true;
    out.push(item);
  }
  return out;
}

// 報告済み（取消されていない確定版に載った）契約×計上月 → 最初に載った確定版の締め月。statements は締め月の順でなくてよい
export function reportedMonths(statements = []) {
  const reported = new Map();
  for (const statement of [...statements].sort((a, b) => a.closeMonth.localeCompare(b.closeMonth))) {
    for (const line of statement.lines || []) {
      if (line.lineKind !== 'accrual' && line.lineKind !== 'revision') continue;
      const key = `${line.agreementId}:${line.accrualMonth}`;
      if (!reported.has(key)) reported.set(key, statement.closeMonth);
    }
  }
  return reported;
}

// サイクルの版を足す前の検査。確定版に載った計上月の扱いを、後から変える版は足せない
// （報告済みの月が計上無し・締め月未定・移行前になると、報告済みの額が集計から消えるか、内と外で二重に数えられる）。
// schedule: normalizeScheduleInput の value。statements: 権利者の取消されていない確定版（lines つき）。返り値: [{field, message}]
export function scheduleConflicts({agreement, schedule, statements = [], entries = []}) {
  const errors = [];
  const own = statements.filter((statement) => (statement.lines || []).some((line) => line.agreementId === agreement.id));
  const earliest = own.map((statement) => statement.closeMonth).sort()[0] || null;
  if (schedule.statementsFrom && earliest && schedule.statementsFrom > earliest) {
    errors.push({field: 'statementsFrom', message: `${monthLabel(earliest)}締めの確定版にこの契約の明細があります。報告書を作り始める締め月は${monthLabel(earliest)}以前にしてください（確定版がある期間は移行前にできません）`});
  }
  const moves = moveTargets(entries.filter((entry) => entry.agreementId === agreement.id));
  const problems = new Map();
  const note = (reason, month, close) => {
    if (!problems.has(reason)) problems.set(reason, []);
    problems.get(reason).push(`${monthLabel(month)}（${monthLabel(close)}締めで報告済み）`);
  };
  // 報告済みの額（売上・基礎を含む）がすべて0の月は、扱いが変わっても額は動かないので止めない
  const net = new Map();
  for (const statement of own) for (const line of statement.lines || []) {
    if (!isRoyaltyLine(line) || line.agreementId !== agreement.id) continue;
    const key = `${line.agreementId}:${line.accrualMonth}`;
    if (!net.has(key)) net.set(key, emptyFigures());
    addFigures(net.get(key), line);
  }
  for (const [key, close] of [...reportedMonths(own)].sort(([a], [b]) => a.localeCompare(b))) {
    const [agreementId, month] = [Number(key.split(':')[0]), key.slice(key.indexOf(':') + 1)];
    if (agreementId !== agreement.id || Object.values(net.get(key) || {}).every((value) => value === 0)) continue;
    const phase = phaseFor(schedule, month);
    if (phase?.cycleKind === 'none') { note('「計上無し」になります', month, close); continue; }
    const move = moves.get(key);
    const next = move ? move.closeMonth : phase ? closeMonthFor(month, phase) : null;
    if (!next) note(!phase ? 'フェーズの期間外（締め月未定）になります' : phase.cycleKind === 'manual' ? '「別途協議」で締め月未定になります' : '特殊サイクルの締め月が無くなります', month, close);
    else if (schedule.statementsFrom && next < schedule.statementsFrom) note('移行前（以前の仕組みで報告済み）になります', month, close);
  }
  for (const [reason, months] of problems) {
    errors.push({field: 'phases', message: `報告済みの計上月 ${months.slice(0, 6).join('、')}${months.length > 6 ? ` ほか${months.length - 6}か月` : ''}が${reason}。報告済みの額を直すときは、サイクルは変えずに「金額の調整」を使ってください`});
  }
  return errors;
}

// イレギュラーの記録を取り消す前の検査。報告済みの計上月が、取消で保留に戻る・締め月が変わるときはメッセージを返す（取り消せない）
// entry: 取り消す記録、entries: 権利者の記録（取消の行を含む）、reported: reportedMonths の結果
export function irregularReversalConflict({entry, entries = [], reported = new Map()}) {
  if (!['hold', 'release', 'move_period'].includes(entry.kind) || !entry.agreementId || !entry.accrualMonth) return null;
  const key = `${entry.agreementId}:${entry.accrualMonth}`;
  if (!reported.has(key)) return null;
  const after = [...entries, {id: Number.MAX_SAFE_INTEGER, kind: entry.kind, agreementId: entry.agreementId, accrualMonth: entry.accrualMonth, closeMonth: entry.closeMonth ?? null,
    reason: '取消', reversesEntryId: entry.id}];
  const reportedAt = `${monthLabel(entry.accrualMonth)}の計上は${monthLabel(reported.get(key))}締めの報告書で報告済みです`;
  if (entry.kind === 'move_period') {
    const now = moveTargets(entries).get(key)?.closeMonth ?? null;
    const next = moveTargets(after).get(key)?.closeMonth ?? null;
    if (now !== next) return `${reportedAt}。この取消で締め月が変わるため取り消せません（報告済みの月の締め月は変えません）。直すときは「金額の調整」を使ってください`;
    return null;
  }
  if (holdStates(after).get(key)?.held && !holdStates(entries).get(key)?.held) {
    return `${reportedAt}。この取消で保留に戻るため取り消せません（報告済みの月は保留にしません）。直すときは「金額の調整」を使ってください`;
  }
  return null;
}

// 報告書に入れられない（保留の）発生額か
export const isHeldItem = (item) => item.held || item.unscheduled || item.royaltyYen === null;
// 移行前（この仕組みの外で報告済み）として除く発生額か。この仕組みの確定版に載った計上月（reported: キー → 報告済みの額）は、
// 後からサイクルの版で「報告書を作り始める締め月」が後ろへずれても外の分にしない（同じ額を内と外で二重に数えない）
export const isExternalItem = (item, reported) => Boolean(item.external) && !(reported && reported.has(item.key));

// ---------- 締め月（期間）の列挙 ----------
// 契約のサイクルから、asOfMonth までの計上月の締め月を並べる（売上の有無によらず、報告のサイクルとして）。
// 返り値: Map 締め月 → {reportDueOn, paymentDueOn}（複数のフェーズが同じ締め月を作るときは早い期限）
export function enumerateClosings({agreement, entries = [], asOfMonth}) {
  const closings = new Map();
  const terms = agreement.terms || [];
  const schedule = agreement.schedule;
  if (!terms.length || !schedule || !isMonth(asOfMonth)) return closings;
  const first = terms.map((t) => t.effectiveFrom).sort()[0];
  const put = (close, phase) => {
    if (!close || (schedule.statementsFrom && close < schedule.statementsFrom)) return;
    const due = dueFrom(phase, close);
    const previous = closings.get(close);
    if (!previous) closings.set(close, due);
    else closings.set(close, {
      reportDueOn: [previous.reportDueOn, due.reportDueOn].filter(Boolean).sort()[0] || null,
      paymentDueOn: [previous.paymentDueOn, due.paymentDueOn].filter(Boolean).sort()[0] || null,
    });
  };
  for (const month of monthsBetween(first, asOfMonth)) {
    const phase = phaseFor(schedule, month);
    if (!phase || phase.cycleKind === 'none' || phase.cycleKind === 'manual') continue;
    put(closeMonthFor(month, phase), phase);
  }
  for (const move of moveTargets(entries.filter((entry) => entry.agreementId === agreement.id)).values()) {
    if (move.accrualMonth > asOfMonth) continue;
    put(move.closeMonth, phaseFor(schedule, move.accrualMonth) || phaseFor(schedule, move.closeMonth) || schedule.phases?.[0]);
  }
  return closings;
}

// 権利者の期間: 契約ごとの締め月と、金額の調整（イレギュラー）の締め月。調整だけの期間の期限は、その月に効いている契約のフェーズから決める
export function holderClosings({agreements = [], entries = [], asOfMonth}) {
  const closings = new Map();
  const merge = (close, due) => {
    const previous = closings.get(close);
    if (!previous) { closings.set(close, {...due}); return; }
    closings.set(close, {
      reportDueOn: [previous.reportDueOn, due.reportDueOn].filter(Boolean).sort()[0] || null,
      paymentDueOn: [previous.paymentDueOn, due.paymentDueOn].filter(Boolean).sort()[0] || null,
    });
  };
  for (const agreement of agreements) for (const [close, due] of enumerateClosings({agreement, entries, asOfMonth})) merge(close, due);
  for (const entry of effectiveEntries(entries)) {
    if (entry.kind !== 'adjust_amount' || closings.has(entry.closeMonth)) continue;
    const phase = agreements.map((agreement) => phaseFor(agreement.schedule, entry.closeMonth)).find(Boolean) || null;
    merge(entry.closeMonth, dueFrom(phase, entry.closeMonth));
  }
  return closings;
}

// ---------- 報告書（権利者×締め月） ----------
const emptyFigures = () => ({salesYen: 0, windowFeeYen: 0, expenseYen: 0, committeeIncomeYen: 0, baseYen: 0, amountYen: 0});
function addFigures(target, line) {
  target.salesYen += line.salesYen ?? 0;
  target.windowFeeYen += line.windowFeeYen ?? 0;
  target.expenseYen += line.expenseYen ?? 0;
  target.committeeIncomeYen += line.committeeIncomeYen ?? 0;
  target.baseYen += line.baseYen ?? 0;
  target.amountYen += line.amountYen ?? 0;
}
const recoupOf = (advance, cumulative) => Math.min(advance, Math.max(0, cumulative));

// 前払金の充当の月ごとの額（契約ごと。台帳・報告書と同じ式: 累計発生額が前払金に達するまで）。
// 月 m の充当 = recoupOf(m の前払金, m までの累計発生額) − それまでの充当の累計。算定できない月（royaltyYen が null）は累計に入れない。
// accruals: [{agreementId, month, royaltyYen}]、advanceOf(agreementId, month) → その月に効いている条件版の前払金（無ければ0）。
// 返り値: [{agreementId, month, amount}]（充当が動いた月だけ。累計が減ると負の額で戻す）
export function advanceRecoupSeries({accruals = [], advanceOf = () => 0} = {}) {
  const byAgreement = new Map();
  for (const row of accruals) {
    if (!Number.isSafeInteger(row.royaltyYen) || !isMonth(row.month)) continue;
    if (!byAgreement.has(row.agreementId)) byAgreement.set(row.agreementId, new Map());
    const months = byAgreement.get(row.agreementId);
    months.set(row.month, (months.get(row.month) ?? 0) + row.royaltyYen);
  }
  const out = [];
  for (const [agreementId, months] of byAgreement) {
    let cumulative = 0, recouped = 0;
    for (const month of [...months.keys()].sort()) {
      cumulative += months.get(month);
      const total = recoupOf(Math.max(0, Number(advanceOf(agreementId, month)) || 0), cumulative);
      if (total !== recouped) out.push({agreementId, month, amount: total - recouped});
      recouped = total;
    }
  }
  return out;
}
const isRoyaltyLine =(line) => line.lineKind === 'accrual' || line.lineKind === 'revision';

export const LINE_KIND_LABELS = Object.freeze({accrual: '当期の計上', revision: '報告後の修正・遅れて締めた分', adjustment: '調整（イレギュラー）', advance_recoup: '前払金の充当'});

// holder: {id, name, code}。agreements: 権利者の契約（terms・schedule つき）。items: resolveItems の結果（権利者の契約すべて）。
// adjustments: 権利者の adjust_amount の記録（取消の行を含む）。priorStatements: 締め月が前の、取消されていない確定版（lines つき）。
// due: {reportDueOn, paymentDueOn}（期間の列挙から）。previous: 直前の確定版（前期繰越の元）。
export function buildStatement({holder, closeMonth, asOf = null, agreements = [], items = [], adjustments = [], priorStatements = [], due = {}}) {
  const prior = [...priorStatements].filter((s) => s.closeMonth < closeMonth).sort((a, b) => a.closeMonth.localeCompare(b.closeMonth));
  const previous = prior.at(-1) || null;
  const agreementById = new Map(agreements.map((agreement) => [agreement.id, agreement]));
  const reported = new Map();
  const reportedAdjust = new Map();
  const priorByAgreement = new Map();
  const recoupedBefore = new Map();
  for (const statement of prior) {
    for (const line of statement.lines || []) {
      if (isRoyaltyLine(line)) {
        const key = `${line.agreementId}:${line.accrualMonth}`;
        if (!reported.has(key)) reported.set(key, {...emptyFigures(), agreementId: line.agreementId, accrualMonth: line.accrualMonth});
        addFigures(reported.get(key), line);
        if (!priorByAgreement.has(line.agreementId)) priorByAgreement.set(line.agreementId, emptyFigures());
        addFigures(priorByAgreement.get(line.agreementId), line);
      } else if (line.lineKind === 'adjustment') {
        reportedAdjust.set(line.irregularEntryId, (reportedAdjust.get(line.irregularEntryId) ?? 0) + line.amountYen);
      } else if (line.lineKind === 'advance_recoup') {
        recoupedBefore.set(line.agreementId, (recoupedBefore.get(line.agreementId) ?? 0) + line.amountYen);
      }
    }
  }
  const lines = [];
  const holds = [];
  const expenses = [];
  const externalByAgreement = new Map();
  // 照合の「集計シート側」: 計上月ごとに、この報告書までで報告済みになるはずの額（下の checks を参照）
  let ledgerCumulative = 0;
  const seen = new Set();
  const itemsSorted = [...items].sort((a, b) => a.agreementId - b.agreementId || a.accrualMonth.localeCompare(b.accrualMonth));
  for (const item of itemsSorted) {
    const agreement = agreementById.get(item.agreementId);
    if (!agreement) continue;
    seen.add(item.key);
    // この仕組みの確定版に載った計上月は、後から移行前（statementsFrom より前）になっても「以前の仕組みで報告済み」と二重に数えない
    if (isExternalItem(item, reported)) {
      if (item.royaltyYen !== null) externalByAgreement.set(item.agreementId, (externalByAgreement.get(item.agreementId) ?? 0) + item.royaltyYen);
      continue;
    }
    const before = reported.get(item.key);
    const held = isHeldItem(item);
    const inScope = item.closeMonth ? item.closeMonth <= closeMonth : item.accrualMonth <= closeMonth;
    if (held || item.holdSalesYen) {
      if (inScope || (held && before)) {
        holds.push({key: item.key, agreementId: item.agreementId, agreementCode: agreement.code, workTitle: agreement.workTitle, category: agreement.category,
          accrualMonth: item.accrualMonth, closeMonth: item.closeMonth, holdSalesYen: held ? (item.holdSalesYen || item.salesYen || 0) : item.holdSalesYen,
          royaltyYen: held ? item.royaltyYen : null, partial: !held,
          reasons: held && before ? [...item.holdReasons, `報告済みの額（${before.amountYen.toLocaleString('ja-JP')}円）は戻さず、その後の差額だけを保留しています`] : item.holdReasons,
          alreadyReported: Boolean(before), reportedYen: before ? before.amountYen : null});
      }
      // 保留は報告と支払を止める記録。報告済みの額は戻さない（戻すときは金額の調整）
      if (held) { ledgerCumulative += before?.amountYen ?? 0; continue; }
    }
    if (!item.closeMonth || item.closeMonth > closeMonth) { ledgerCumulative += before?.amountYen ?? 0; continue; }
    ledgerCumulative += item.royaltyYen;
    const values = {salesYen: item.salesYen, windowFeeYen: item.windowFeeYen, expenseYen: item.expenseYen, committeeIncomeYen: item.committeeIncomeYen, baseYen: item.baseYen ?? 0, amountYen: item.royaltyYen};
    if (!before && item.closeMonth === closeMonth) {
      lines.push({lineKind: 'accrual', agreementId: item.agreementId, accrualMonth: item.accrualMonth, termVersionId: item.termVersionId, irregularEntryId: null,
        ...values, baseYen: item.baseYen, rateBps: item.rateBps,
        note: item.moveEntryId ? (item.movedFrom ? `締め月の変更（元は${monthLabel(item.movedFrom)}締め）` : '締め月をイレギュラーの記録で指定') : null});
      for (const expense of item.expenseLines) expenses.push({agreementId: item.agreementId, agreementCode: agreement.code, workTitle: agreement.workTitle, accrualMonth: item.accrualMonth, ...expense});
      continue;
    }
    const base = before || emptyFigures();
    const delta = {
      salesYen: values.salesYen - base.salesYen, windowFeeYen: values.windowFeeYen - base.windowFeeYen, expenseYen: values.expenseYen - base.expenseYen,
      committeeIncomeYen: values.committeeIncomeYen - base.committeeIncomeYen, baseYen: values.baseYen - base.baseYen, amountYen: values.amountYen - base.amountYen,
    };
    if (Object.values(delta).every((value) => value === 0)) continue;
    const note = before ? '報告後に売上・経費・条件が変わった分の差額'
      : item.moveEntryId ? `締め月の変更で当期に含める分（${monthLabel(item.closeMonth)}締め）` : '締め月の後に計上した分（保留の解除・遅れて届いた報告など）';
    lines.push({lineKind: 'revision', agreementId: item.agreementId, accrualMonth: item.accrualMonth, termVersionId: item.termVersionId, irregularEntryId: null,
      ...delta, rateBps: item.rateBps, note});
  }
  // 報告済みなのに、いまは発生額の行が無い計上月（売上の取消・条件の変更・計上無しのサイクル）は、報告済みの額を戻す
  // （発生額が0になった月と同じ扱い。黙って累計から消さない）
  for (const [key, before] of [...reported.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (seen.has(key) || !agreementById.has(before.agreementId)) continue;
    const delta = {salesYen: -before.salesYen, windowFeeYen: -before.windowFeeYen, expenseYen: -before.expenseYen, committeeIncomeYen: -before.committeeIncomeYen,
      baseYen: -before.baseYen, amountYen: -before.amountYen};
    if (Object.values(delta).every((value) => value === 0)) continue;
    lines.push({lineKind: 'revision', agreementId: before.agreementId, accrualMonth: before.accrualMonth, termVersionId: null, irregularEntryId: null, ...delta, rateBps: null,
      note: '報告後に発生額が無くなった計上月（売上の取消・条件やサイクルの変更）の戻し'});
  }
  // 調整（イレギュラーの金額の調整）。取消されたものは0として、報告済みとの差を当期に入れる
  const reversedIds = new Set(adjustments.filter((entry) => entry.reversesEntryId).map((entry) => entry.reversesEntryId));
  const adjustmentRows = [];
  for (const entry of adjustments.filter((e) => e.kind === 'adjust_amount' && !e.reversesEntryId).sort((a, b) => a.id - b.id)) {
    if (entry.closeMonth > closeMonth) continue;
    const effective = reversedIds.has(entry.id) ? 0 : entry.amountYen;
    const done = reportedAdjust.get(entry.id) ?? 0;
    const delta = effective - done;
    if (delta === 0) continue;
    const agreement = entry.agreementId ? agreementById.get(entry.agreementId) : null;
    const note = reversedIds.has(entry.id) ? '取り消した調整の戻し' : entry.closeMonth < closeMonth ? `締め月（${monthLabel(entry.closeMonth)}）の後に記録した調整` : null;
    lines.push({lineKind: 'adjustment', agreementId: entry.agreementId ?? null, accrualMonth: entry.accrualMonth ?? null, termVersionId: null, irregularEntryId: entry.id,
      salesYen: null, windowFeeYen: null, expenseYen: null, committeeIncomeYen: null, baseYen: null, rateBps: null, amountYen: delta, note});
    adjustmentRows.push({entryId: entry.id, agreementId: entry.agreementId ?? null, agreementCode: agreement?.code || null, accrualMonth: entry.accrualMonth ?? null,
      closeMonth: entry.closeMonth, amountYen: delta, reason: entry.reason, sourceReference: entry.sourceReference ?? null, note});
  }
  // 前払金の充当（契約ごと）: 報告済みの累計発生額が前払金に達するまで。移行前（外で報告済み）の分はすでに充当済みとみなす
  const currentByAgreement = new Map();
  for (const line of lines.filter(isRoyaltyLine)) {
    if (!currentByAgreement.has(line.agreementId)) currentByAgreement.set(line.agreementId, emptyFigures());
    addFigures(currentByAgreement.get(line.agreementId), line);
  }
  const advance = [];
  for (const agreement of [...agreements].sort((a, b) => a.id - b.id)) {
    const term = termFor(agreement.terms, closeMonth);
    const advanceYen = term?.advanceYen ?? 0;
    if (!advanceYen) continue;
    const external = externalByAgreement.get(agreement.id) ?? 0;
    const cumulativeBefore = external + (priorByAgreement.get(agreement.id)?.amountYen ?? 0);
    const cumulativeAfter = cumulativeBefore + (currentByAgreement.get(agreement.id)?.amountYen ?? 0);
    const before = (recoupedBefore.get(agreement.id) ?? 0) + recoupOf(advanceYen, external);
    const now = recoupOf(advanceYen, cumulativeAfter) - before;
    if (now !== 0) lines.push({lineKind: 'advance_recoup', agreementId: agreement.id, accrualMonth: null, termVersionId: term.id, irregularEntryId: null,
      salesYen: null, windowFeeYen: null, expenseYen: null, committeeIncomeYen: null, baseYen: null, rateBps: null, amountYen: now,
      note: now < 0 ? '返品などで累計が減ったため、充当を戻す分' : null});
    advance.push({agreementId: agreement.id, agreementCode: agreement.code, workTitle: agreement.workTitle, category: agreement.category, advanceYen,
      cumulativeBefore, cumulativeAfter, recoupedBefore: before, recoupedNow: now, recoupedTotal: before + now, remainingYen: advanceYen - (before + now)});
  }
  lines.forEach((line, index) => {
    const agreement = line.agreementId ? agreementById.get(line.agreementId) : null;
    Object.assign(line, {lineNo: index + 1, lineKindLabel: labelOf('royaltyLineKind', line.lineKind), agreementCode: agreement?.code ?? null,
      workTitle: agreement?.workTitle ?? null, categoryLabel: agreement ? labelOf('royaltyCategory', agreement.category) : null});
  });
  // 作品×種別（契約ごと）の前回まで・当期・累計
  const rows = [];
  for (const agreement of [...agreements].sort((a, b) => (a.workTitle || '').localeCompare(b.workTitle || '', 'ja') || a.code.localeCompare(b.code))) {
    const priorFigures = priorByAgreement.get(agreement.id) || emptyFigures();
    const current = currentByAgreement.get(agreement.id) || emptyFigures();
    const active = termFor(agreement.terms, closeMonth);
    if (!active && !priorByAgreement.has(agreement.id) && !currentByAgreement.has(agreement.id)) continue;
    const cumulative = emptyFigures();
    addFigures(cumulative, priorFigures);
    addFigures(cumulative, current);
    const rates = [...new Set(lines.filter((line) => isRoyaltyLine(line) && line.agreementId === agreement.id).map((line) => line.rateBps).filter((bps) => bps !== null && bps !== undefined))];
    rows.push({agreementId: agreement.id, agreementCode: agreement.code, title: agreement.title, workId: agreement.workId, workTitle: agreement.workTitle,
      category: agreement.category, categoryLabel: labelOf('royaltyCategory', agreement.category), calcMethod: active?.calcMethod ?? null, baseKind: active?.baseKind ?? null,
      rateText: rates.length ? rates.map(rateText).join('→') : active?.calcMethod === 'rate' ? rateText(active.rateBps) : active ? labelOf('royaltyCalcMethod', active.calcMethod) : '—',
      prior: priorFigures, current, cumulative});
  }
  const royaltyYen = sumBy(lines.filter(isRoyaltyLine), (line) => line.amountYen);
  const adjustmentYen = sumBy(lines.filter((line) => line.lineKind === 'adjustment'), (line) => line.amountYen);
  const advanceRecoupedYen = sumBy(lines.filter((line) => line.lineKind === 'advance_recoup'), (line) => line.amountYen);
  const carriedInYen = previous?.carriedOutYen ?? 0;
  const balanceYen = carriedInYen + royaltyYen + adjustmentYen - advanceRecoupedYen;
  const thresholds = agreements.map((agreement) => termFor(agreement.terms, closeMonth)).filter(Boolean).map((term) => term.minPaymentYen ?? 0);
  const minPaymentYen = thresholds.length ? Math.min(...thresholds) : 0;
  let payableYen = 0;
  let carriedOutYen = 0;
  let carryReason = null;
  if (balanceYen <= 0) {
    carriedOutYen = balanceYen;
    if (balanceYen < 0) carryReason = 'マイナスの残高（返品・調整など）を翌期へ繰り越します';
  } else if (balanceYen < minPaymentYen) {
    carriedOutYen = balanceYen;
    carryReason = `支払の下限（${minPaymentYen.toLocaleString('ja-JP')}円）未満のため翌期へ繰り越します`;
  } else payableYen = balanceYen;
  const accrualMonths = lines.filter((line) => line.lineKind === 'accrual').map((line) => line.accrualMonth).sort();
  const cumulativeReported = sumBy(rows, (row) => row.cumulative.amountYen);
  const adjustmentsReported = [...reportedAdjust.values()].reduce((n, v) => n + v, 0) + adjustmentYen;
  const adjustmentsLedger = sumBy(adjustments.filter((e) => e.kind === 'adjust_amount' && !e.reversesEntryId && !reversedIds.has(e.id) && e.closeMonth <= closeMonth), (e) => e.amountYen);
  const checks = [
    {item: '明細の和−当期の一覧（差0）', value: royaltyYen - sumBy(rows, (row) => row.current.amountYen)},
    {item: '前回まで＋当期−累計（差0）', value: sumBy(rows, (row) => row.prior.amountYen + row.current.amountYen - row.cumulative.amountYen)},
    {item: '前期繰越＋当期＋調整−前払金の充当−支払予定額−翌期繰越（差0）', value: carriedInYen + royaltyYen + adjustmentYen - advanceRecoupedYen - payableYen - carriedOutYen},
    {item: '報告書の累計−集計シートの締め月までの発生額（保留の月と締め月が後の月は報告済みの額。差0）', value: cumulativeReported - ledgerCumulative},
    {item: '報告済みの調整の累計−台帳の調整（差0）', value: adjustmentsReported - adjustmentsLedger},
  ];
  const holdSalesYen = sumBy(holds, (hold) => hold.holdSalesYen);
  return {
    calculationVersion: CALCULATION_VERSION, holder, closeMonth, asOf,
    reportDueOn: due.reportDueOn ?? null, paymentDueOn: due.paymentDueOn ?? null,
    previousStatementId: previous?.id ?? null, previousCloseMonth: previous?.closeMonth ?? null,
    accrualFrom: accrualMonths[0] || null, accrualTo: accrualMonths.at(-1) || null,
    lines, rows, adjustments: adjustmentRows, advance, holds, expenses,
    totals: {royaltyYen, adjustmentYen, advanceRecoupedYen, carriedInYen, balanceYen, minPaymentYen, payableYen, carriedOutYen, carryReason, holdCount: holds.length, holdSalesYen},
    checks,
    assumptions: STATEMENT_ASSUMPTIONS,
  };
}

export const STATEMENT_ASSUMPTIONS = Object.freeze([
  '金額は税抜・円。源泉徴収は計上していません（扱いは未確認）',
  '売上は計上月ごとに発生させ、契約のサイクルで締めた月（締め月）の報告書にまとめます',
  '料率の額は1円未満を切り捨てます（マイナスの月も同じ）',
  '報告後に売上・経費・条件が変わった計上月は、差額を「報告後の修正」として次の報告書に含めます',
  '前払金の充当は契約ごとに、報告済みの累計発生額が前払金に達するまでです。調整（イレギュラー）は充当の対象にしていません',
  '支払の下限は、この権利者の契約のうち最も小さい下限額を使います（下限の無い契約があれば下限なし）。下限未満とマイナスは翌期へ繰り越します',
  '算定できない額（区分未確認の売上・サイクル未設定・保留の記録）は0円にせず、保留として別に示しています',
]);

// 確定版の検算（試験と画面で使う）
export const checksOk = (checks = []) => checks.every((check) => check.value === 0);

// 照合（checks）の合わない下書きは確定しない。理由の文（照合の項目と差額）。合っていれば null
export function statementBlockReason(draft) {
  const ng = (draft?.checks || []).filter((check) => check.value !== 0);
  if (!ng.length) return null;
  return `照合が合いません（${ng.map((check) => `${check.item.replace(/（[^（）]*）$/, '')}の差額 ${check.value.toLocaleString('ja-JP')}円`).join('、')}）。報告書の「照合」の表で差額の元を確かめ、元のデータを直してから確定してください`;
}

// 一括で確定できる期間（作成待ち・期限超過で確定版が無く、権限外の作品を含まず、照合が合っている）
export const isCreatablePeriod = (p) => !p.statementId && !p.restricted && !p.blockedReason && (p.status === 'pending' || p.status === 'overdue');

// 期間の行（periodRows に draft を付けたもの）の、作成待ち・期限超過で確定版の無い期間に、確定できない理由（blockedReason）を付ける。
// 照合の合わない期間と、同じ権利者のそれより後の期間（繰越がつながらないため）。rows をそのまま書き換えて返す
export function markBlockedPeriods(rows) {
  const byHolder = new Map();
  for (const row of rows) {
    if (!byHolder.has(row.holderId)) byHolder.set(row.holderId, []);
    byHolder.get(row.holderId).push(row);
  }
  for (const list of byHolder.values()) {
    let blockedBy = null;
    for (const row of [...list].sort((a, b) => a.closeMonth.localeCompare(b.closeMonth))) {
      if (row.statementId || row.restricted || !(row.status === 'pending' || row.status === 'overdue')) continue;
      const reason = row.draft ? statementBlockReason(row.draft) : null;
      if (blockedBy) row.blockedReason = `前の期間（${monthLabel(blockedBy)}締め）の照合が合わないため、この期間も作れません`;
      else if (reason) { row.blockedReason = reason; blockedBy = row.closeMonth; }
    }
  }
  return rows;
}

// ---------- 期間の一覧 ----------
export function eventState(events = []) {
  const reversed = new Set(events.filter((event) => event.reversesEventId).map((event) => event.reversesEventId));
  const live = events.filter((event) => !event.reversesEventId && !reversed.has(event.id));
  const reports = live.filter((event) => event.eventKind === 'reported').sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  const payments = live.filter((event) => event.eventKind === 'paid');
  return {reportedOn: reports[0]?.occurredOn || null, paidYen: sumBy(payments, (event) => event.amountYen), lastPaidOn: payments.map((event) => event.occurredOn).sort().at(-1) || null};
}

// 確定版の状態。支払済は支払予定額（正）に支払の記録が届いたもの
export function statementStatus(statement, events, asOf) {
  const state = eventState(events);
  if (statement.payableYen > 0 && state.paidYen >= statement.payableYen) return 'paid';
  if (state.reportedOn) return 'reported';
  if (statement.reportDueOn && asOf && statement.reportDueOn < asOf) return 'overdue';
  return 'created';
}

// 権利者ごとの期間（締め月）。closings: Map 締め月 → 期限、statements: 取消されていない確定版（events つき）。
// 状態: 受付中（締め月が未到来）／作成待ち／期限超過（報告期限を過ぎて報告の記録なし）／作成済／報告済／支払済／後の報告書に含める
export function periodRows({holder, closings, statements = [], asOf}) {
  const asOfMonth = asOf.slice(0, 7);
  const byClose = new Map(statements.map((statement) => [statement.closeMonth, statement]));
  const latestActive = statements.map((statement) => statement.closeMonth).sort().at(-1) || null;
  const closes = [...new Set([...closings.keys(), ...byClose.keys()])].sort();
  return closes.map((closeMonth) => {
    const statement = byClose.get(closeMonth) || null;
    const due = closings.get(closeMonth) || {};
    let status;
    if (statement) status = statementStatus(statement, statement.events || [], asOf);
    else if (closeMonth >= asOfMonth) status = 'open';
    else if (latestActive && closeMonth < latestActive) status = 'merged';
    else status = due.reportDueOn && due.reportDueOn < asOf ? 'overdue' : 'pending';
    const state = statement ? eventState(statement.events || []) : {reportedOn: null, paidYen: 0};
    return {
      key: `${holder.id}:${closeMonth}`, holderId: holder.id, holderName: holder.name, holderCode: holder.code, closeMonth,
      reportDueOn: statement ? statement.reportDueOn : due.reportDueOn ?? null, paymentDueOn: statement ? statement.paymentDueOn : due.paymentDueOn ?? null,
      status, statusLabel: labelOf('royaltyPeriodStatus', status), statementId: statement?.id ?? null, versionNo: statement?.versionNo ?? null,
      payableYen: statement ? statement.payableYen : null, royaltyYen: statement ? statement.royaltyYen : null, adjustmentYen: statement ? statement.adjustmentYen : null,
      carriedOutYen: statement ? statement.carriedOutYen : null, holdCount: statement ? statement.holdCount : null,
      reportedOn: state.reportedOn, paidYen: state.paidYen,
      paymentOverdue: Boolean(statement && statement.payableYen > state.paidYen && statement.paymentDueOn && statement.paymentDueOn < asOf),
      draft: null,
    };
  });
}

// 確定版のない期間を古い順に仮に作り、前期繰越・報告済みの額をつないだ下書きを返す（期間の一覧の額と、一括作成の中身）
export function simulateDrafts({holder, agreements, items, adjustments, statements = [], closings, asOf, closesToDraft}) {
  const active = [...statements].sort((a, b) => a.closeMonth.localeCompare(b.closeMonth));
  const latest = active.at(-1)?.closeMonth || null;
  const drafts = new Map();
  const chain = [...active];
  const targets = [...(closesToDraft || closings.keys())].filter((close) => !latest || close > latest).sort();
  for (const closeMonth of [...new Set(targets)]) {
    const draft = buildStatement({holder, closeMonth, asOf, agreements, items, adjustments, priorStatements: chain, due: closings.get(closeMonth) || {}});
    drafts.set(closeMonth, draft);
    chain.push({id: null, closeMonth, carriedOutYen: draft.totals.carriedOutYen, lines: draft.lines});
  }
  return drafts;
}

// ---------- 集計シート ----------
// 行＝権利者（×種別×作品）、列＝各月の発生額・期間計・契約開始からの累計・調整・前払金の充当・報告済・支払・未払残。
// paymentHolderIds: 支払累計・報告済み・未払残を出す権利者（Set。null ならすべて）。支払と報告書は権利者の全契約で1つなので、
// 作品・種別で絞った表や、権限外の作品の契約を持つ権利者には出さない（絞った累計から権利者全体の支払を引くと未払残が狂う）
export function buildLedger({agreements = [], items = [], entries = [], manualAccruals = [], statements = [], from, to, paymentHolderIds = null}) {
  const months = monthsBetween(from, to);
  const agreementById = new Map(agreements.map((agreement) => [agreement.id, agreement]));
  const reportedStatus = new Map();
  for (const statement of statements) {
    for (const line of statement.lines || []) {
      if (!isRoyaltyLine(line)) continue;
      const key = `${line.agreementId}:${line.accrualMonth}`;
      if (!reportedStatus.has(key)) reportedStatus.set(key, {statementId: statement.id, closeMonth: statement.closeMonth, amountYen: 0});
      reportedStatus.get(key).amountYen += line.amountYen;
    }
  }
  const upTo = items.filter((item) => item.accrualMonth <= to);
  const external = (item) => isExternalItem(item, reportedStatus);
  // 保留の対象売上: 発生額ごと保留の月はその月の対象売上すべて、一部だけ保留の月は決められない売上
  const heldSales = (item) => (external(item) ? 0 : isHeldItem(item) ? (item.holdSalesYen || item.salesYen || 0) : item.holdSalesYen || 0);
  const detail = items.filter((item) => item.accrualMonth >= from && item.accrualMonth <= to).map((item) => {
    const agreement = agreementById.get(item.agreementId);
    const reportedInfo = reportedStatus.get(item.key);
    const held = !external(item) && isHeldItem(item);
    let status;
    if (external(item)) status = '以前の仕組みで報告済み';
    else if (held) status = reportedInfo ? `保留（${monthLabel(reportedInfo.closeMonth)}締めで報告済みの額は戻していません）` : '保留';
    else if (reportedInfo) status = reportedInfo.amountYen === item.royaltyYen ? `報告済み（${monthLabel(reportedInfo.closeMonth)}締め）` : `報告済み・差額あり（${monthLabel(reportedInfo.closeMonth)}締め）`;
    else status = '未報告';
    return {
      held,
      key: item.key, agreementId: item.agreementId, agreementCode: agreement?.code, title: agreement?.title, holderId: agreement?.holderId, holderName: agreement?.holderName,
      category: agreement?.category, categoryLabel: labelOf('royaltyCategory', agreement?.category), workId: agreement?.workId, workTitle: agreement?.workTitle,
      accrualMonth: item.accrualMonth, closeMonth: item.closeMonth, termVersionNo: item.termVersionNo, calcMethod: item.calcMethod,
      calcMethodLabel: labelOf('royaltyCalcMethod', item.calcMethod), baseKindLabel: item.baseKind ? labelOf('royaltyBaseKind', item.baseKind) : '—',
      salesYen: item.salesYen, windowFeeYen: item.windowFeeYen, expenseYen: item.expenseYen, committeeIncomeYen: item.committeeIncomeYen, baseYen: item.baseYen,
      rateBps: item.rateBps, royaltyYen: item.royaltyYen, holdSalesYen: heldSales(item), excludedSalesYen: item.excludedSalesYen,
      status, holdReason: item.holdReasons.join('／'), reportedYen: reportedInfo?.amountYen ?? null, statementId: reportedInfo?.statementId ?? null,
      channelText: Object.entries(item.channels || {}).map(([group, amount]) => `${CHANNEL_LABELS[group] || group} ${amount.toLocaleString('ja-JP')}`).join('、'),
    };
  });
  const effective = effectiveEntries(entries);
  const reversedIds = new Set(entries.filter((entry) => entry.reversesEntryId).map((entry) => entry.reversesEntryId));
  const adjustByHolder = new Map();
  for (const entry of effective) {
    if (entry.kind !== 'adjust_amount' || entry.closeMonth > to) continue;
    adjustByHolder.set(entry.holderId, (adjustByHolder.get(entry.holderId) ?? 0) + entry.amountYen);
  }
  const showsPayment = (holderId) => !paymentHolderIds || paymentHolderIds.has(holderId);
  const paidByHolder = new Map();
  const reportedByHolder = new Map();
  const endDate = `${to}-${String(lastDayOf(to)).padStart(2, '0')}`;
  for (const statement of statements) {
    if (statement.closeMonth <= to) reportedByHolder.set(statement.holderId, (reportedByHolder.get(statement.holderId) ?? 0)
      + sumBy((statement.lines || []).filter((line) => line.lineKind !== 'advance_recoup'), (line) => line.amountYen));
    // 支払は支払日が期間の終了月までのもの。取消の記録はその日付で差し引く
    for (const event of statement.events || []) {
      if (event.eventKind !== 'paid' || event.occurredOn > endDate) continue;
      const signed = event.reversesEventId ? -event.amountYen : event.amountYen;
      paidByHolder.set(statement.holderId, (paidByHolder.get(statement.holderId) ?? 0) + signed);
    }
  }
  // 前払金の充当見込み（契約ごとに、累計発生額が前払金に達するまで）。移行前（この仕組みの外で報告済み）の分は、充当も支払も外で済んだとみなす:
  // 未払残から外の分の発生額をすべて除き（外で充当した分も外で支払った分も含む）、この仕組みの充当は外で充当した残りだけ
  const recoupByAgreement = new Map();
  const externalByAgreement = new Map();
  for (const agreement of agreements) {
    const own = upTo.filter((item) => item.agreementId === agreement.id && item.royaltyYen !== null);
    const outside = sumBy(own.filter(external), (item) => item.royaltyYen);
    const term = termFor(agreement.terms, to);
    const advance = term?.advanceYen ?? 0;
    externalByAgreement.set(agreement.id, outside);
    if (advance) recoupByAgreement.set(agreement.id, recoupOf(advance, sumBy(own, (item) => item.royaltyYen)) - recoupOf(advance, outside));
  }
  function aggregate(keyOf, describe) {
    const map = new Map();
    for (const item of upTo) {
      const agreement = agreementById.get(item.agreementId);
      if (!agreement) continue;
      const key = keyOf(agreement);
      if (!map.has(key)) map.set(key, {key, ...describe(agreement), months: Object.fromEntries(months.map((m) => [m, 0])), periodYen: 0, cumulativeYen: 0, holdYen: 0, holdSalesYen: 0, agreementIds: new Set()});
      const row = map.get(key);
      row.agreementIds.add(agreement.id);
      if (item.royaltyYen !== null) {
        row.cumulativeYen += item.royaltyYen;
        if (item.accrualMonth >= from) { row.months[item.accrualMonth] += item.royaltyYen; row.periodYen += item.royaltyYen; }
      }
      if (isHeldItem(item) && !external(item)) { row.holdYen += item.royaltyYen ?? 0; }
      if (item.accrualMonth >= from) row.holdSalesYen += heldSales(item);
    }
    for (const agreement of agreements) {
      const key = keyOf(agreement);
      if (!map.has(key)) map.set(key, {key, ...describe(agreement), months: Object.fromEntries(months.map((m) => [m, 0])), periodYen: 0, cumulativeYen: 0, holdYen: 0, holdSalesYen: 0, agreementIds: new Set()});
      map.get(key).agreementIds.add(agreement.id);
    }
    return [...map.values()].map((row) => ({...row, recoupYen: [...row.agreementIds].reduce((n, id) => n + (recoupByAgreement.get(id) ?? 0), 0),
      externalYen: [...row.agreementIds].reduce((n, id) => n + (externalByAgreement.get(id) ?? 0), 0), agreementCount: row.agreementIds.size, agreementIds: [...row.agreementIds]}));
  }
  const byHolder = aggregate((a) => a.holderId, (a) => ({holderId: a.holderId, holderName: a.holderName}))
    .map((row) => {
      const adjustmentYen = adjustByHolder.get(row.holderId) ?? 0;
      if (!showsPayment(row.holderId)) return {...row, adjustmentYen, reportedYen: null, paidYen: null, unpaidYen: null, paymentShown: false};
      const paidYen = paidByHolder.get(row.holderId) ?? 0;
      return {...row, adjustmentYen, reportedYen: reportedByHolder.get(row.holderId) ?? 0, paidYen, unpaidYen: row.cumulativeYen - row.externalYen + adjustmentYen - row.recoupYen - paidYen, paymentShown: true};
    })
    .sort((a, b) => (a.holderName || '').localeCompare(b.holderName || '', 'ja'));
  const byHolderCategory = aggregate((a) => `${a.holderId}:${a.category}`, (a) => ({holderId: a.holderId, holderName: a.holderName, category: a.category, categoryLabel: labelOf('royaltyCategory', a.category)}))
    .sort((a, b) => (a.holderName || '').localeCompare(b.holderName || '', 'ja') || ROYALTY_CATEGORIES.indexOf(a.category) - ROYALTY_CATEGORIES.indexOf(b.category));
  const byWorkCategory = aggregate((a) => `${a.workId}:${a.category}`, (a) => ({workId: a.workId, workTitle: a.workTitle, category: a.category, categoryLabel: labelOf('royaltyCategory', a.category)}))
    .sort((a, b) => (a.workTitle || '').localeCompare(b.workTitle || '', 'ja') || ROYALTY_CATEGORIES.indexOf(a.category) - ROYALTY_CATEGORIES.indexOf(b.category));
  const expenses = [];
  for (const item of items.filter((i) => i.accrualMonth >= from && i.accrualMonth <= to)) {
    const agreement = agreementById.get(item.agreementId);
    for (const expense of item.expenseLines || []) expenses.push({key: `${item.key}:${expense.source}:${expense.id ?? expense.category}:${expenses.length}`, agreementCode: agreement?.code, holderName: agreement?.holderName,
      workTitle: agreement?.workTitle, categoryLabel: labelOf('royaltyCategory', agreement?.category), accrualMonth: item.accrualMonth, expenseCategory: expense.category,
      description: expense.description ?? null, amountYen: expense.amount, sourceLabel: expense.source === 'committee' ? '委員会の経費' : '作品の経費'});
  }
  const holds = detail.filter((row) => row.held || row.holdSalesYen).map((row) => ({...row, holdKind: row.held ? '発生額を保留' : '売上の一部を保留'}));
  const irregular = entries.slice().sort((a, b) => a.id - b.id).map((entry) => {
    const agreement = entry.agreementId ? agreementById.get(entry.agreementId) : null;
    let effect;
    if (entry.reversesEntryId) effect = `記録${entry.reversesEntryId}の取消`;
    else if (reversedIds.has(entry.id)) effect = '取消済み（効いていません）';
    else if (entry.kind === 'adjust_amount') effect = `${monthLabel(entry.closeMonth)}締めの報告書に ${entry.amountYen > 0 ? '+' : ''}${entry.amountYen.toLocaleString('ja-JP')}円`;
    else if (entry.kind === 'move_period') {
      const item = items.find((i) => i.agreementId === entry.agreementId && i.accrualMonth === entry.accrualMonth);
      effect = `${monthLabel(entry.accrualMonth)}の計上を${monthLabel(entry.closeMonth)}締めへ${item ? `（${item.royaltyYen === null ? '額は保留' : `${item.royaltyYen.toLocaleString('ja-JP')}円`}）` : '（この月の発生額はありません）'}`;
    } else if (entry.kind === 'hold' || entry.kind === 'release') {
      const state = holdStates(entries).get(`${entry.agreementId}:${entry.accrualMonth}`);
      const item = items.find((i) => i.agreementId === entry.agreementId && i.accrualMonth === entry.accrualMonth);
      effect = `${monthLabel(entry.accrualMonth)}: ${state?.held ? '保留中' : '保留なし'}${item?.royaltyYen !== null && item ? `（発生額 ${item.royaltyYen.toLocaleString('ja-JP')}円）` : ''}`;
    } else effect = '記録だけ（金額・締め月に影響しません）';
    return {key: entry.id, id: entry.id, createdAt: entry.createdAt ?? null, holderName: entry.holderName ?? agreement?.holderName ?? null, agreementCode: agreement?.code ?? null,
      workTitle: agreement?.workTitle ?? null, kind: entry.kind, kindLabel: labelOf('royaltyIrregularKind', entry.kind), accrualMonth: entry.accrualMonth ?? null, closeMonth: entry.closeMonth ?? null,
      amountYen: entry.amountYen ?? null, reason: entry.reason, sourceReference: entry.sourceReference ?? null, reversed: reversedIds.has(entry.id), isReversal: Boolean(entry.reversesEntryId), effect};
  });
  const manual = manualAccruals.slice().sort((a, b) => a.id - b.id).map((row) => {
    const agreement = agreementById.get(row.agreementId);
    return {key: row.id, id: row.id, agreementCode: agreement?.code, holderName: agreement?.holderName, workTitle: agreement?.workTitle, accrualMonth: row.accrualMonth, amountYen: row.amountYen,
      sourceReference: row.sourceReference, reason: row.reason, isReversal: Boolean(row.reversesEntryId)};
  });
  // 支払累計・未払残の合計は、出している権利者の分だけ（出していない権利者の数は paymentHiddenCount）
  const withPayment = byHolder.filter((row) => row.paymentShown);
  const totals = {
    periodYen: sumBy(byHolder, (row) => row.periodYen), cumulativeYen: sumBy(byHolder, (row) => row.cumulativeYen), adjustmentYen: sumBy(byHolder, (row) => row.adjustmentYen),
    recoupYen: sumBy(byHolder, (row) => row.recoupYen),
    paidYen: withPayment.length ? sumBy(withPayment, (row) => row.paidYen) : null, unpaidYen: withPayment.length ? sumBy(withPayment, (row) => row.unpaidYen) : null,
    paymentHiddenCount: byHolder.length - withPayment.length,
    holdCount: holds.length, holdSalesYen: sumBy(holds, (row) => row.holdSalesYen || 0),
  };
  const checks = [
    {item: '権利者×月の期間計−明細の発生額の和（差0）', value: totals.periodYen - sumBy(detail, (row) => row.royaltyYen)},
    {item: '権利者×種別の累計−権利者の累計（差0）', value: sumBy(byHolderCategory, (row) => row.cumulativeYen) - totals.cumulativeYen},
    {item: '作品×種別の累計−権利者の累計（差0）', value: sumBy(byWorkCategory, (row) => row.cumulativeYen) - totals.cumulativeYen},
  ];
  return {from, to, months, byHolder, byHolderCategory, byWorkCategory, detail, expenses, holds, irregular, manual, totals, checks};
}
