// シナリオの比較の要求の本文（POST /api/revenue/scenarios/compare）と、model へ渡す実績（facts）の形を確かめて正規化する。純関数。
// 段A は値を保存しないので、商談ごとの源泉・換算率・売上の月・窓口と、窓口別の支払いの間・市場の前提・行動・目標額を本文で受ける（仮置き）。
// 換算率は交渉の条件（契約の版から読む値の仮置き）で、カスタムでは動かせない（作り手の取り分の裏返しになるため）。
// 金額は整数の円、率は bp、件数と時間は x100 の整数。読めない値は 0 にせず、どの項目かを添えて止める。

export const SOURCES = Object.freeze(['contract_work', 'own_investment', 'committee', 'acquisition', 'consignment']);
export const SOURCE_LABELS = Object.freeze({
  contract_work: '制作受託', own_investment: '自社出資', committee: '製作委員会', acquisition: '買付', consignment: '販売委託',
});
export const OPEN_STAGES = Object.freeze(['lead', 'proposal', 'negotiation']);
export const STAGES = Object.freeze([...OPEN_STAGES, 'won', 'lost']);
export const ACTION_STEPS = Object.freeze(['meeting', 'proposal']);
// 市場の前提（自分では決められない値）。シナリオ・前提の効きで動かすのはこれだけ
export const MARKET_ASSUMPTIONS = Object.freeze(['salesMultiplierBps', 'recoveryAmountBps', 'meetingToProposalBps', 'proposalToContractBps', 'paymentDelayMonths']);
export const MAX_PAYMENT_DELAY_MONTHS = 6;
export const MAX_PERIOD_MONTHS = 60;
// 行動の件数（x100）と1件の額の上限。分布の格子の数と畳み込みの回数は model が別に上限で止める
export const MAX_ACTION_COUNT_X100 = 100000;
export const MAX_DEAL_YEN = 10000000000;

const REQUEST_KEYS = new Set(['period', 'closedMonth', 'stageProbabilityBps', 'opportunities', 'paymentGapMonths', 'assumptions', 'actions', 'custom', 'targets']);
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CHANNEL = /^[a-z][a-z0-9_]{0,31}$/;

export class ScenarioInputError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'ScenarioInputError';
    this.field = field;
  }
}

const fail = (field, message) => { throw new ScenarioInputError(field, message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
export const monthOfIndex = (index) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;

function month(value, field) {
  if (typeof value !== 'string' || !MONTH.test(value)) fail(field, '「2026-04」の形の月にしてください');
  return value;
}

function integerIn(value, field, {min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isSafeInteger(value)) fail(field, '整数にしてください');
  if (value < min || value > max) fail(field, `${min}以上${max}以下にしてください`);
  return value;
}

const bps = (value, field, max = 10000) => integerIn(value, field, {min: 0, max});
const months = (value, field, max = 24) => integerIn(value, field, {min: 0, max});

function onlyKeys(object, allowed, field) {
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail(`${field}.${key}`, '知らない項目です');
}

function normalizeAssumptions(raw, field, {partial}) {
  if (!isObject(raw)) fail(field, '市場の前提を入れてください');
  onlyKeys(raw, new Set(MARKET_ASSUMPTIONS), field);
  const out = {};
  for (const key of MARKET_ASSUMPTIONS) {
    if (!Object.hasOwn(raw, key)) {
      if (!partial) fail(`${field}.${key}`, '値を入れてください');
      continue;
    }
    const value = raw[key];
    if (key === 'paymentDelayMonths') out[key] = months(value, `${field}.${key}`, MAX_PAYMENT_DELAY_MONTHS);
    else if (key === 'salesMultiplierBps' || key === 'recoveryAmountBps') out[key] = bps(value, `${field}.${key}`, 100000);
    else out[key] = bps(value, `${field}.${key}`);
  }
  return out;
}

function normalizeAction(raw, field) {
  if (!isObject(raw)) fail(field, '行動を入れてください');
  onlyKeys(raw, new Set(['source', 'step', 'countX100', 'dealYen', 'conversionBps', 'hoursX100']), field);
  if (!SOURCES.includes(raw.source)) fail(`${field}.source`, `稼ぎ方は ${SOURCES.join('・')} のどれかです`);
  if (!ACTION_STEPS.includes(raw.step)) fail(`${field}.step`, `段は ${ACTION_STEPS.join('・')} のどれかです`);
  return {
    source: raw.source,
    step: raw.step,
    countX100: integerIn(raw.countX100, `${field}.countX100`, {min: 0, max: MAX_ACTION_COUNT_X100}),
    dealYen: integerIn(raw.dealYen, `${field}.dealYen`, {min: 0, max: MAX_DEAL_YEN}),
    conversionBps: raw.conversionBps === undefined ? 10000 : bps(raw.conversionBps, `${field}.conversionBps`),
    hoursX100: integerIn(raw.hoursX100, `${field}.hoursX100`, {min: 0, max: 100000}),
  };
}

const actionKey = (action) => `${action.source}:${action.step}`;

// 要求の本文を確かめて正規化する。basis は受けない（段A の基準は計上で固定）
export function normalizeCompareRequest(body) {
  if (!isObject(body)) fail('body', 'JSON のオブジェクトで送ってください');
  if (Object.hasOwn(body, 'basis')) fail('basis', '基準は計上で固定です（段A は basis を受けません）');
  onlyKeys(body, REQUEST_KEYS, 'body');

  if (!isObject(body.period)) fail('period', '期間（from・to）を入れてください');
  onlyKeys(body.period, new Set(['from', 'to']), 'period');
  const from = month(body.period.from, 'period.from');
  const to = month(body.period.to, 'period.to');
  if (monthIndex(to) < monthIndex(from)) fail('period.to', '期間の終わりは始まり以降にしてください');
  if (monthIndex(to) - monthIndex(from) + 1 > MAX_PERIOD_MONTHS) fail('period', `期間は${MAX_PERIOD_MONTHS}か月以内にしてください`);
  const closedMonth = month(body.closedMonth, 'closedMonth');

  if (!isObject(body.stageProbabilityBps)) fail('stageProbabilityBps', '段階ごとの確度（bp）を入れてください');
  onlyKeys(body.stageProbabilityBps, new Set(OPEN_STAGES), 'stageProbabilityBps');
  const stageProbabilityBps = {};
  for (const stage of OPEN_STAGES) stageProbabilityBps[stage] = bps(body.stageProbabilityBps[stage], `stageProbabilityBps.${stage}`);

  if (!Array.isArray(body.opportunities)) fail('opportunities', '商談ごとの指定を配列で入れてください');
  const seen = new Set();
  const opportunities = body.opportunities.map((raw, index) => {
    const field = `opportunities[${index}]`;
    if (!isObject(raw)) fail(field, '商談の指定を入れてください');
    onlyKeys(raw, new Set(['id', 'source', 'conversionBps', 'revenueMonth', 'channel']), field);
    const id = integerIn(raw.id, `${field}.id`, {min: 1});
    if (seen.has(id)) fail(`${field}.id`, '同じ商談を2回指定しています');
    seen.add(id);
    if (!SOURCES.includes(raw.source)) fail(`${field}.source`, `稼ぎ方は ${SOURCES.join('・')} のどれかです`);
    const channel = raw.channel === undefined || raw.channel === null ? null : raw.channel;
    if (channel !== null && (typeof channel !== 'string' || !CHANNEL.test(channel))) fail(`${field}.channel`, '窓口は英小文字の語にしてください');
    return {
      id, source: raw.source, conversionBps: bps(raw.conversionBps, `${field}.conversionBps`),
      revenueMonth: raw.revenueMonth === undefined || raw.revenueMonth === null ? null : month(raw.revenueMonth, `${field}.revenueMonth`),
      channel,
    };
  }).sort((a, b) => a.id - b.id);

  if (!isObject(body.paymentGapMonths)) fail('paymentGapMonths', '窓口別の支払いの間（月数）を入れてください');
  const paymentGapMonths = {};
  for (const [channel, value] of Object.entries(body.paymentGapMonths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!CHANNEL.test(channel)) fail(`paymentGapMonths.${channel}`, '窓口は英小文字の語にしてください');
    paymentGapMonths[channel] = months(value, `paymentGapMonths.${channel}`);
  }

  const assumptions = normalizeAssumptions(body.assumptions, 'assumptions', {partial: false});

  if (!Array.isArray(body.actions)) fail('actions', '行動を配列で入れてください（無ければ空の配列）');
  const actions = body.actions.map((raw, index) => normalizeAction(raw, `actions[${index}]`));
  const actionKeys = new Set();
  for (const [index, action] of actions.entries()) {
    if (actionKeys.has(actionKey(action))) fail(`actions[${index}]`, '同じ稼ぎ方と段の行動を2回入れています');
    actionKeys.add(actionKey(action));
  }

  let custom = null;
  if (body.custom !== undefined && body.custom !== null) {
    if (!isObject(body.custom)) fail('custom', 'カスタムをオブジェクトで入れてください');
    onlyKeys(body.custom, new Set(['assumptions', 'actions']), 'custom');
    const customAssumptions = body.custom.assumptions === undefined ? {} : normalizeAssumptions(body.custom.assumptions, 'custom.assumptions', {partial: true});
    const customActions = body.custom.actions === undefined ? [] : body.custom.actions;
    if (!Array.isArray(customActions)) fail('custom.actions', 'カスタムの行動を配列で入れてください');
    const counts = customActions.map((raw, index) => {
      const field = `custom.actions[${index}]`;
      if (!isObject(raw)) fail(field, '行動を入れてください');
      // 件数だけを動かす。1件の額・換算率（交渉の条件）・時間はカスタムで変えない
      onlyKeys(raw, new Set(['source', 'step', 'countX100']), field);
      const key = `${raw.source}:${raw.step}`;
      if (!actionKeys.has(key)) fail(field, '標準の行動に無い稼ぎ方と段です');
      return {source: raw.source, step: raw.step, countX100: integerIn(raw.countX100, `${field}.countX100`, {min: 0, max: MAX_ACTION_COUNT_X100})};
    });
    custom = {assumptions: customAssumptions, actions: counts};
  }

  let targets = null;
  if (body.targets !== undefined && body.targets !== null) {
    if (!isObject(body.targets)) fail('targets', '目標額をオブジェクトで入れてください');
    onlyKeys(body.targets, new Set(['selfYen', 'companyYen']), 'targets');
    targets = {};
    for (const key of ['selfYen', 'companyYen']) {
      if (body.targets[key] === undefined || body.targets[key] === null) continue;
      targets[key] = integerIn(body.targets[key], `targets.${key}`, {min: 1});
    }
    if (!Object.keys(targets).length) targets = null;
  }

  return {period: {from, to}, closedMonth, stageProbabilityBps, opportunities, paymentGapMonths, assumptions, actions, custom, targets};
}

// ---------- 実績（facts）: store が DB から読んで model へ渡す形 ----------

function list(raw, field) {
  if (!Array.isArray(raw)) fail(field, '配列にしてください');
  return raw;
}
const nullableInt = (value, field, options) => (value === null || value === undefined ? null : integerIn(value, field, options));
const text = (value, field) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(field, '文字にしてください');
  return value;
};

// 源泉の実績（ownInvestment・committee・acquisition・consignment）は、null（項目が無いときも）＝未接続、配列＝接続済み（0件なら0円）で分ける。
// store は読めない源泉（自社の取引先が無い組織の委員会など）を null で渡し、0円の配列で埋めない
const sourceList = (raw, field, map) => (raw === null || raw === undefined ? null : list(raw, field).map(map));

export function normalizeScenarioFacts(raw) {
  if (!isObject(raw)) fail('facts', '実績をオブジェクトで渡してください');
  const opportunities = list(raw.opportunities, 'facts.opportunities').map((row, index) => {
    const field = `facts.opportunities[${index}]`;
    if (!STAGES.includes(row.stage)) fail(`${field}.stage`, `段階は ${STAGES.join('・')} のどれかです`);
    if (row.closeDate !== null && row.closeDate !== undefined && (typeof row.closeDate !== 'string' || !DATE.test(row.closeDate))) fail(`${field}.closeDate`, '日付の形ではありません');
    return {
      id: integerIn(row.id, `${field}.id`, {min: 1}), workId: integerIn(row.workId, `${field}.workId`, {min: 1}),
      partnerId: integerIn(row.partnerId, `${field}.partnerId`, {min: 1}), partnerKind: text(row.partnerKind, `${field}.partnerKind`),
      name: text(row.name, `${field}.name`), stage: row.stage,
      expectedYen: nullableInt(row.expectedYen, `${field}.expectedYen`, {min: 0}), closeDate: row.closeDate ?? null,
    };
  }).sort((a, b) => a.id - b.id);
  const sales = list(raw.salesByWorkPartner, 'facts.salesByWorkPartner').map((row, index) => ({
    workId: integerIn(row.workId, `facts.salesByWorkPartner[${index}].workId`, {min: 1}),
    partnerId: integerIn(row.partnerId, `facts.salesByWorkPartner[${index}].partnerId`, {min: 1}),
    month: month(row.month, `facts.salesByWorkPartner[${index}].month`),
    amountYen: integerIn(row.amountYen, `facts.salesByWorkPartner[${index}].amountYen`),
  }));
  const activities = list(raw.activities ?? [], 'facts.activities').map((row, index) => {
    if (typeof row.occurredOn !== 'string' || !DATE.test(row.occurredOn)) fail(`facts.activities[${index}].occurredOn`, '日付の形ではありません');
    return {id: integerIn(row.id, `facts.activities[${index}].id`, {min: 1}), opportunityId: integerIn(row.opportunityId, `facts.activities[${index}].opportunityId`, {min: 1}),
      occurredOn: row.occurredOn, activityType: text(row.activityType, `facts.activities[${index}].activityType`)};
  });
  const ownInvestment = sourceList(raw.ownInvestment, 'facts.ownInvestment', (row, index) => {
    const field = `facts.ownInvestment[${index}]`;
    return {workId: integerIn(row.workId, `${field}.workId`, {min: 1}), title: text(row.title, `${field}.title`),
      investmentYen: nullableInt(row.investmentYen, `${field}.investmentYen`, {min: 0}),
      receiptsTotalYen: integerIn(row.receiptsTotalYen, `${field}.receiptsTotalYen`), receiptsPeriodYen: integerIn(row.receiptsPeriodYen, `${field}.receiptsPeriodYen`)};
  });
  // selfInvested: 自社の出資のある委員会の作品か（出資の回収の行にするか）。源泉3の実績は false の行も数える。
  // overlap: 買付・販売委託の契約にも入る委員会の作品か（取得額を契約の分と分けられないので、源泉3の実績に入れない）。無ければ false
  const committee = sourceList(raw.committee, 'facts.committee', (row, index) => {
    const field = `facts.committee[${index}]`;
    if (typeof row.selfInvested !== 'boolean') fail(`${field}.selfInvested`, '自社の出資のある作品か（true・false）を入れてください');
    if (row.overlap !== undefined && typeof row.overlap !== 'boolean') fail(`${field}.overlap`, '契約のある稼ぎ方にも入る作品か（true・false）を入れてください');
    return {workId: integerIn(row.workId, `${field}.workId`, {min: 1}), title: text(row.title, `${field}.title`), selfInvested: row.selfInvested, overlap: row.overlap ?? false,
      paymentsTotalYen: integerIn(row.paymentsTotalYen, `${field}.paymentsTotalYen`), paymentsPeriodYen: integerIn(row.paymentsPeriodYen, `${field}.paymentsPeriodYen`),
      acquisitionsTotalYen: nullableInt(row.acquisitionsTotalYen, `${field}.acquisitionsTotalYen`),
      acquisitionsPeriodYen: nullableInt(row.acquisitionsPeriodYen, `${field}.acquisitionsPeriodYen`),
      error: text(row.error, `${field}.error`), holdNote: text(row.holdNote, `${field}.holdNote`)};
  });
  const acquisition = sourceList(raw.acquisition, 'facts.acquisition', (row, index) => {
    const field = `facts.acquisition[${index}]`;
    if (!['outright', 'mg'].includes(row.kind)) fail(`${field}.kind`, '買い切り（outright）か MG つき（mg）です');
    // 買い切りは買付額のある作品だけ（買付額も MG も無い作品は買付に入れない）
    if (row.kind === 'outright' && (row.purchaseYen === null || row.purchaseYen === undefined)) fail(`${field}.purchaseYen`, '買い切りの買付に買付額がありません');
    return {workId: integerIn(row.workId, `${field}.workId`, {min: 1}), title: text(row.title, `${field}.title`), kind: row.kind,
      salesPeriodYen: integerIn(row.salesPeriodYen, `${field}.salesPeriodYen`), purchaseYen: nullableInt(row.purchaseYen, `${field}.purchaseYen`, {min: 0}),
      agencyFeePeriodYen: nullableInt(row.agencyFeePeriodYen, `${field}.agencyFeePeriodYen`), mgContractYen: nullableInt(row.mgContractYen, `${field}.mgContractYen`, {min: 0}),
      mgBalanceYen: nullableInt(row.mgBalanceYen, `${field}.mgBalanceYen`)};
  });
  const consignment = sourceList(raw.consignment, 'facts.consignment', (row, index) => {
    const field = `facts.consignment[${index}]`;
    return {workId: integerIn(row.workId, `${field}.workId`, {min: 1}), title: text(row.title, `${field}.title`),
      agencyFeePeriodYen: integerIn(row.agencyFeePeriodYen, `${field}.agencyFeePeriodYen`), holderAmountPeriodYen: integerIn(row.holderAmountPeriodYen, `${field}.holderAmountPeriodYen`)};
  });
  const unlinked = isObject(raw.unlinkedReports) ? raw.unlinkedReports : {count: 0, amountYen: 0};
  return {
    opportunities, salesByWorkPartner: sales, activities, ownInvestment, committee, acquisition, consignment,
    overlapCount: integerIn(raw.overlapCount ?? 0, 'facts.overlapCount', {min: 0}),
    unlinkedReports: {count: integerIn(unlinked.count, 'facts.unlinkedReports.count', {min: 0}), amountYen: integerIn(unlinked.amountYen, 'facts.unlinkedReports.amountYen')},
  };
}
