// シナリオの比較の画面の入力（文字のまま持つ）と、要求の本文（POST /api/revenue/scenarios/compare）の組み立て。純関数。時刻・乱数・環境変数は読まない（今月は引数で受ける）。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の A-3。段A は値を保存しないので、画面が持つ入力から毎回本文を作って送る。
// - 既定の値（確度・段の率・窓口別の支払いの間・市場の前提・標準の行動）は仮置き。test/fixtures/scenario/compare-request.json の架空の入力と同じ値にしてあり、
//   試験（scenario-form-model.test.mjs）がそろっていることを確かめる。本番の初期値は段B（J-13）で決める
// - 目標額（本人・会社）は入力中の文字のまま form.targets にだけ持つ。URL・localStorage・フォームの自動入力には載せない（ScenarioCompare.jsx が autocomplete=off で受ける）
// - 入力の文字は parseYen・percentToBps などで整数（円・bp・x100）に直し、読めなければどの項目かを添えて返す。0 で埋めない
import {MARKET_ASSUMPTIONS, MAX_PAYMENT_DELAY_MONTHS, normalizeCompareRequest, ScenarioInputError} from './scenario-inputs.mjs';
import {percentToBps, bpsToPercent} from '../../royalty/royalty-model.mjs';
import {parseYen, parseInteger, parseMonth, isBlankInput} from '../../ui/parse-input.mjs';
import {addMonths, fiscalYearOf, fiscalYearRange, DEFAULT_FISCAL_START_MONTH} from '../../ui/condition-model.mjs';

// 仮置きの既定値（申し送り §仮置きの値）。標準の行動の1件の額 7,025,000 円は、1万円の格子のちょうど半分になる架空の値（golden と同じ）
export const FORM_DEFAULTS = Object.freeze({
  stageProbabilityBps: Object.freeze({lead: 3000, proposal: 5000, negotiation: 8000}),
  // 窓口（取引先の種類）ごとの売上の月から入金までの月数。配信2・パッケージ販売1・海外3・そのほか1
  paymentGapMonths: Object.freeze({agency: 3, other: 1, platform: 2, retailer: 1}),
  assumptions: Object.freeze({salesMultiplierBps: 10000, recoveryAmountBps: 10000, meetingToProposalBps: 5000, proposalToContractBps: 3000, paymentDelayMonths: 0}),
  actions: Object.freeze([
    Object.freeze({source: 'consignment', step: 'meeting', countX100: 400, dealYen: 7025000, conversionBps: 2000, hoursX100: 300}),
    Object.freeze({source: 'acquisition', step: 'meeting', countX100: 150, dealYen: 6000000, conversionBps: 3000, hoursX100: 300}),
    Object.freeze({source: 'contract_work', step: 'proposal', countX100: 100, dealYen: 25000000, conversionBps: 1000, hoursX100: 4000}),
  ]),
  // 商談の換算率（交渉の条件の仮置き。契約の版から読む値。自社出資・委員会・買い切りは総額をそのまま、委託は手数料率、受託は受託費率）
  conversionBps: Object.freeze({contract_work: 1000, own_investment: 10000, committee: 10000, acquisition: 10000, consignment: 2000}),
});
// 窓口の既定に無い種類の取引先の支払いの間（仮置き）
export const UNKNOWN_CHANNEL_GAP_MONTHS = 1;

// 入力欄の単位（市場の前提）。率は %、入金の遅れは月
export const ASSUMPTION_UNITS = Object.freeze({
  salesMultiplierBps: '%', recoveryAmountBps: '%', meetingToProposalBps: '%', proposalToContractBps: '%', paymentDelayMonths: 'か月',
});
const isPercentAssumption = (key) => key !== 'paymentDelayMonths';

export const actionKey = (action) => `${action.source}:${action.step}`;

// ---------- 数の文字 ↔ 整数 ----------

const squash = (text) => String(text ?? '').normalize('NFKC').replace(/[,\s]/g, '');

// 小数2桁までの文字 → ×100 の整数（件数・時間）。小数の計算を通さない。読めなければ null
export function decimalX100(text) {
  const clean = squash(text).replace(/(?:件|時間|h)$/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : null;
}

// ×100 の整数 → 入力欄の文字（4 → "0.04"、400 → "4"、150 → "1.5"）
export function x100Text(value) {
  if (value === null || value === undefined) return '';
  const whole = (value - (value % 100)) / 100;
  const rest = value % 100;
  return rest ? `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}` : String(whole);
}

const bpsText = (bps) => bpsToPercent(bps);
const yenText = (value) => (value === null || value === undefined ? '' : value.toLocaleString('ja-JP'));

// ---------- 入力（form）の既定 ----------

// 今月（'YYYY-MM'）と期首月から、期間（その年度）と締めた月（前の月。期間を出ない）の既定。今月を引数で受ける（時刻を読まない）
export function defaultPeriod(currentMonth, fiscalStartMonth = DEFAULT_FISCAL_START_MONTH) {
  const {from, to} = fiscalYearRange(fiscalYearOf(currentMonth, fiscalStartMonth), fiscalStartMonth);
  const previous = addMonths(currentMonth, -1);
  return {from, to, closedMonth: previous > to ? to : previous};
}

export function assumptionsForm(values) {
  return Object.fromEntries(MARKET_ASSUMPTIONS.map((key) => [key, isPercentAssumption(key) ? bpsText(values[key]) : String(values[key])]));
}

export function actionForm(action) {
  return {source: action.source, step: action.step, count: x100Text(action.countX100), dealYen: yenText(action.dealYen), conversionPct: bpsText(action.conversionBps), hours: x100Text(action.hoursX100)};
}

// 画面の最初の入力。opportunities は null（商談の一覧を読む前）で、読んだら withDiscovery が埋める
export function initialForm({currentMonth, fiscalStartMonth = DEFAULT_FISCAL_START_MONTH} = {}) {
  const period = defaultPeriod(currentMonth, fiscalStartMonth);
  return {
    period: {from: period.from, to: period.to},
    closedMonth: period.closedMonth,
    targets: {selfYen: '', companyYen: ''},
    stageProbabilityPct: Object.fromEntries(Object.entries(FORM_DEFAULTS.stageProbabilityBps).map(([stage, bps]) => [stage, bpsText(bps)])),
    paymentGapMonths: Object.fromEntries(Object.entries(FORM_DEFAULTS.paymentGapMonths).map(([channel, months]) => [channel, String(months)])),
    assumptions: assumptionsForm(FORM_DEFAULTS.assumptions),
    actions: FORM_DEFAULTS.actions.map(actionForm),
    opportunities: null,
    // カスタム: 標準から動かした値だけを持つ（無ければ標準と同じ）。前提は表示の単位の文字、行動は件数の文字
    custom: {assumptions: {}, actions: {}},
  };
}

// 商談ごとの指定の既定。作品の稼ぎ方が1つだけならその稼ぎ方、複数（重なり）か無ければ指定しない（'' ＝ 期待値に入れず、件数と額を横に出す）。
// 換算率は稼ぎ方ごとの仮置き。売上の月は商談の close_date の月（空）
export function defaultOpportunitySpecs(opportunityList = [], workSources = []) {
  const sourcesOf = new Map(workSources.map((row) => [row.workId, row.sources]));
  return opportunityList.map((row) => {
    const sources = sourcesOf.get(row.workId) ?? [];
    const source = sources.length === 1 ? sources[0] : '';
    return {id: row.id, source, conversionPct: source ? bpsText(FORM_DEFAULTS.conversionBps[source]) : '', revenueMonth: ''};
  });
}

// 商談に出てくる窓口（取引先の種類）の支払いの間。既定に無い種類は仮置き 1か月
export function channelGapsFor(opportunityList = [], current = {}) {
  const out = {...current};
  for (const row of opportunityList) {
    if (row.partnerKind && !Object.hasOwn(out, row.partnerKind)) out[row.partnerKind] = String(UNKNOWN_CHANNEL_GAP_MONTHS);
  }
  return out;
}

// 最初に読んだ応答（商談の一覧と作品→稼ぎ方の対応）から、商談ごとの指定と窓口の一覧を埋める
export function withDiscovery(form, response) {
  return {
    ...form,
    opportunities: defaultOpportunitySpecs(response.opportunityList, response.workSources),
    paymentGapMonths: channelGapsFor(response.opportunityList, form.paymentGapMonths),
  };
}

// ---------- 入力 → 要求の本文 ----------

function monthOf(text, label, add, field) {
  const parsed = parseMonth(text);
  if (!parsed.ok || parsed.value === null) {
    add(field, `${label}は「2026-04」の形の月で入れてください`);
    return null;
  }
  return parsed.value;
}

const bpsOf = (text, label, add, field, max = 10000) => {
  const value = percentToBps(text);
  if (value === null || value > max) {
    add(field, `${label}は0%以上${bpsText(max)}%以下の数（小数は2桁まで）で入れてください`);
    return null;
  }
  return value;
};

function monthsOf(text, label, add, field, max) {
  const parsed = parseInteger(text, {allowNegative: false, min: 0, max});
  if (!parsed.ok || parsed.value === null) {
    add(field, `${label}は0以上${max}以下の整数（か月）で入れてください`);
    return null;
  }
  return parsed.value;
}

function x100Of(text, label, add, field, unit) {
  const value = decimalX100(text);
  if (value === null) {
    add(field, `${label}は小数2桁までの数（${unit}）で入れてください`);
    return null;
  }
  return value;
}

function yenOf(text, label, add, field) {
  const parsed = parseYen(text, {allowNegative: false});
  if (!parsed.ok || parsed.value === null) {
    add(field, `${label}は0円以上の整数（円）で入れてください`);
    return null;
  }
  return parsed.value;
}

function assumptionOf(key, text, label, add, field) {
  return isPercentAssumption(key)
    ? bpsOf(text, label, add, field, 100000)
    : monthsOf(text, label, add, field, MAX_PAYMENT_DELAY_MONTHS);
}

// 入力の項目名（画面の項目の名前。誤りの文に使う）
export const FIELD_LABELS = Object.freeze({
  salesMultiplierBps: '窓口の売上の倍率', recoveryAmountBps: '回収の量', meetingToProposalBps: '面談→提案の率',
  proposalToContractBps: '提案→契約の率', paymentDelayMonths: '入金の遅れ',
  lead: '確度（見込み）', proposal: '確度（提案）', negotiation: '確度（交渉）',
});

// 入力 → 要求の本文。{ok: true, body} か {ok: false, errors: [{field, message}]}。
// 目標額は空なら送らない（目標に依る値は応答に出ない）。商談の源泉が空の行は指定しない（期待値に入れない）。
// 最後に normalizeCompareRequest（サーバーと同じ検査）を通し、値の範囲の誤りもここで返す
export function buildCompareRequest(form) {
  const errors = [];
  const add = (field, message) => errors.push({field, message});

  const period = {from: monthOf(form.period.from, '期間の始まり', add, 'period.from'), to: monthOf(form.period.to, '期間の終わり', add, 'period.to')};
  const closedMonth = monthOf(form.closedMonth, '締めた月', add, 'closedMonth');

  const stageProbabilityBps = {};
  for (const stage of Object.keys(FORM_DEFAULTS.stageProbabilityBps)) {
    stageProbabilityBps[stage] = bpsOf(form.stageProbabilityPct[stage], FIELD_LABELS[stage], add, `stageProbabilityBps.${stage}`);
  }

  const opportunities = [];
  for (const spec of form.opportunities ?? []) {
    if (!spec.source) continue;
    const field = `opportunities.${spec.id}`;
    const conversionBps = bpsOf(spec.conversionPct, `商談${spec.id}の換算率`, add, `${field}.conversionBps`);
    const row = {id: spec.id, source: spec.source, conversionBps};
    if (!isBlankInput(spec.revenueMonth)) row.revenueMonth = monthOf(spec.revenueMonth, `商談${spec.id}の売上の月`, add, `${field}.revenueMonth`);
    opportunities.push(row);
  }

  const paymentGapMonths = {};
  for (const [channel, text] of Object.entries(form.paymentGapMonths)) {
    paymentGapMonths[channel] = monthsOf(text, `窓口「${channel}」の支払いの間`, add, `paymentGapMonths.${channel}`, 24);
  }

  const assumptions = {};
  for (const key of MARKET_ASSUMPTIONS) assumptions[key] = assumptionOf(key, form.assumptions[key], FIELD_LABELS[key], add, `assumptions.${key}`);

  const actions = form.actions.map((row, index) => {
    const label = `行動${index + 1}`;
    const field = `actions[${index}]`;
    return {
      source: row.source, step: row.step,
      countX100: x100Of(row.count, `${label}の件数`, add, `${field}.countX100`, '件'),
      dealYen: yenOf(row.dealYen, `${label}の1件の額`, add, `${field}.dealYen`),
      conversionBps: bpsOf(row.conversionPct, `${label}の換算率`, add, `${field}.conversionBps`),
      hoursX100: x100Of(row.hours, `${label}の1件の時間`, add, `${field}.hoursX100`, '時間'),
    };
  });

  const customAssumptions = {};
  for (const [key, text] of Object.entries(form.custom.assumptions)) {
    if (!MARKET_ASSUMPTIONS.includes(key) || text === undefined) continue;
    customAssumptions[key] = assumptionOf(key, text, `カスタムの${FIELD_LABELS[key]}`, add, `custom.assumptions.${key}`);
  }
  const customActions = [];
  for (const row of form.actions) {
    const text = form.custom.actions[actionKey(row)];
    if (text === undefined) continue;
    customActions.push({source: row.source, step: row.step, countX100: x100Of(text, 'カスタムの行動の件数', add, `custom.actions.${actionKey(row)}`, '件')});
  }

  let targets;
  const target = (text, label, field) => {
    if (isBlankInput(text)) return undefined;
    const parsed = parseYen(text, {allowNegative: false});
    if (!parsed.ok || parsed.value === null || parsed.value < 1) {
      add(field, `${label}は1円以上の整数（円）で入れてください`);
      return undefined;
    }
    return parsed.value;
  };
  const selfYen = target(form.targets.selfYen, '目標（本人）', 'targets.selfYen');
  const companyYen = target(form.targets.companyYen, '目標（会社）', 'targets.companyYen');
  if (selfYen !== undefined || companyYen !== undefined) {
    targets = {};
    if (selfYen !== undefined) targets.selfYen = selfYen;
    if (companyYen !== undefined) targets.companyYen = companyYen;
  }

  if (errors.length) return {ok: false, errors};
  const body = {period, closedMonth, stageProbabilityBps, opportunities, paymentGapMonths, assumptions, actions,
    custom: {assumptions: customAssumptions, actions: customActions}};
  if (targets) body.targets = targets;
  // サーバーと同じ検査（範囲・重複・知らない項目）。通らなければ、どの項目かを添えて返す
  try {
    normalizeCompareRequest(body);
  } catch (error) {
    if (!(error instanceof ScenarioInputError)) throw error;
    return {ok: false, errors: [{field: error.field, message: error.message}]};
  }
  return {ok: true, body};
}

// 送った本文の同一性（同じ本文なら同じ文字）。入力が変わったか・表示中の応答が今の入力のものかの判定に使う
export const requestSignature = (body) => JSON.stringify(body);

// ---------- 画面の状態の小さな操作（純関数。React の setState に渡す） ----------

// path（['custom', 'actions', 'consignment:meeting']）の位置を value に直した新しいオブジェクト。value が undefined ならその項目を外す
export function setIn(object, path, value) {
  const [head, ...rest] = path;
  const base = Array.isArray(object) ? [...object] : {...object};
  if (rest.length === 0) {
    if (value === undefined) delete base[head];
    else base[head] = value;
    return base;
  }
  base[head] = setIn(object?.[head] ?? {}, rest, value);
  return base;
}

// 商談 id の指定を直す
export function setOpportunity(form, id, patch) {
  return {...form, opportunities: (form.opportunities ?? []).map((row) => (row.id === id ? {...row, ...patch} : row))};
}

// 稼ぎ方を替えたら、換算率はその稼ぎ方の仮置きに戻す（空にしたら指定しない）
export function chooseOpportunitySource(form, id, source) {
  return setOpportunity(form, id, source ? {source, conversionPct: bpsText(FORM_DEFAULTS.conversionBps[source])} : {source: '', conversionPct: ''});
}

// 行動の候補を「カスタムに入れる」: カスタムの件数（無ければ標準）に addCountX100 を足す。取り消すのは戻す（標準へ）か同じ候補の取り消し
export function customCountOf(form, action) {
  const text = form.custom.actions[actionKey(action)];
  return decimalX100(text !== undefined ? text : action.count);
}

export function addToCustom(form, source, step, addCountX100) {
  const row = form.actions.find((action) => action.source === source && action.step === step);
  if (!row) return form;
  const current = customCountOf(form, row);
  if (current === null) return form;
  return setIn(form, ['custom', 'actions', actionKey(row)], x100Text(current + addCountX100));
}

export function removeFromCustom(form, source, step, addCountX100) {
  const row = form.actions.find((action) => action.source === source && action.step === step);
  if (!row) return form;
  const current = customCountOf(form, row);
  const standard = decimalX100(row.count);
  if (current === null || standard === null) return form;
  const next = Math.max(standard, current - addCountX100);
  return setIn(form, ['custom', 'actions', actionKey(row)], next === standard ? undefined : x100Text(next));
}

export const resetCustom = (form) => ({...form, custom: {assumptions: {}, actions: {}}});
export const customIsEmpty = (form) => Object.keys(form.custom.assumptions).length === 0 && Object.keys(form.custom.actions).length === 0;

// 目標額の入力が空か（応答に目標に依る値が出るか）
export const hasTargets = (form) => !isBlankInput(form.targets.selfYen) || !isBlankInput(form.targets.companyYen);
