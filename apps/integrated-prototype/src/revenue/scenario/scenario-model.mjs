// シナリオの比較（段A）の計算。純関数で、DB・受け口・時刻・乱数・環境変数に触れない。入力は scenario-inputs.mjs で正規化した要求と実績（facts）。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の「段A」「確率」「出資の回収」。式は申し送り §計算の決まりを採る。
// - 源泉の合成: 5つの稼ぎ方ごとに 実績（期間内の粗利）＋確度加重＋行動からの見込。facts の源泉が null なら未接続（null）で 0 円で埋めない。制作受託はいつも未接続
// - 期待値は内訳（実績・確度加重 signedRateAmount・行動からの見込＝率を全部掛けて1回 truncate）をそれぞれ整数にした和。配らない（負の内訳を落とさない）
// - 会社の売上も同じ内訳で並べる（目標は粗利で測り、売上を並べる。J-12 (c)）。買付は窓口の売上（総額）、受託・委託は純額、出資は回収・取得額
// - 確率は Float64 の分布（案件の成立と行動の二項分布を1万円の格子でたたみ込む）。出すときに bp へ half_up。乱数も時刻も読まない。
//   分布の平均は検算にだけ使い、円の端数を持つので応答に出さない。分布は1本と1つの要求の合計に上限を置き、
//   標準・楽観・悲観・カスタムが超えたら要求を止め（400）、目標に依る候補の確率と逆算は超えた所で止めて印（stopped）を付ける
// - 前提の効きと楽観・悲観は市場の前提だけを動かす。換算率（窓口手数料率・受託費率などの交渉の条件）と作り手の取り分は変数にしない
// - 段A の簡略（段B で広げる）: 候補の時間は行動1件の時間だけ（成約後の実行の時間は入れない）。逆算は (2) そろって増やす倍率だけで、
//   (1) 稼ぎ方ごとに届く件数と (3) 規模で届く額は出さない。逆算で固定する行動には理由（down＝増やすと今期は下がる、flat＝増やしても今期は変わらない）を添える
import {SOURCES, SOURCE_LABELS, MAX_PAYMENT_DELAY_MONTHS, ScenarioInputError, monthIndex, monthOfIndex} from './scenario-inputs.mjs';
import {rateChain, gridIndex, ratioBps} from './money-scenario.mjs';
import {signedRateAmount} from '../../royalty/royalty-model.mjs';

export const DEFINITION_VERSION = 'scenario-stage-a.2026-10-10';
export const GRID_YEN = 10000;
// 1本の分布の格子の数（1万円の格子で 200億円の幅）と、たたみ込みの掛け算の回数の上限。超える要求は止める（黙って落とさない）
export const MAX_DISTRIBUTION_CELLS = 2000000;
export const MAX_CONVOLUTION_STEPS = 50000000;
// 1つの要求で数える分布の本数と、たたみ込みの回数の合計の上限。標準・楽観・悲観・カスタム（各2本。最大でも 8本×1本の上限＝4億回）は
// この内で必ず数え、目標に依る行動の候補の届く確率と逆算は残りの枠で数える。残りの枠を超えたらそこで止めて印を付け、応答全体は止めない。
// 本数の上限は いまの形の最大（シナリオ4つ×2本＋目標2つ×（行動の候補10＋逆算の倍率61））＝150本 の少し上に置き、形が変わって本数が増えたときに止める
export const MAX_REQUEST_DISTRIBUTIONS = 160;
export const MAX_REQUEST_CONVOLUTION_STEPS = 1000000000;
export const SCENARIO_KEYS = Object.freeze(['standard', 'optimistic', 'pessimistic', 'custom']);
// 楽観・悲観の幅（採用中の値からの差。仮置き）。入金の遅れは悲観の側だけ動かす
export const SCENARIO_RANGES = Object.freeze({
  salesMultiplierBps: Object.freeze({pessimistic: -1500, optimistic: 1500, min: 0, max: 100000}),
  recoveryAmountBps: Object.freeze({pessimistic: -1500, optimistic: 1500, min: 0, max: 100000}),
  meetingToProposalBps: Object.freeze({pessimistic: -1000, optimistic: 1000, min: 0, max: 10000}),
  proposalToContractBps: Object.freeze({pessimistic: -1000, optimistic: 1000, min: 0, max: 10000}),
  paymentDelayMonths: Object.freeze({pessimistic: 1, optimistic: 0, min: 0, max: MAX_PAYMENT_DELAY_MONTHS}),
});
// 楽観・悲観で動かす主な前提（契約までの率の手前の面談→提案は前提の効きだけで見る）
const SCENARIO_MOVES = Object.freeze(['salesMultiplierBps', 'recoveryAmountBps', 'proposalToContractBps', 'paymentDelayMonths']);
// 前提の効き（トルネード図）で動かす市場の前提。交渉の条件・行動・作り手の取り分は入れない
export const TORNADO_KEYS = Object.freeze(['salesMultiplierBps', 'recoveryAmountBps', 'meetingToProposalBps', 'proposalToContractBps', 'paymentDelayMonths']);
export const ASSUMPTION_LABELS = Object.freeze({
  salesMultiplierBps: '窓口の売上の倍率', recoveryAmountBps: '回収の量', meetingToProposalBps: '面談→提案の率',
  proposalToContractBps: '提案→契約の率', paymentDelayMonths: '入金の遅れ',
});
const ASSUMPTION_CHECKS = Object.freeze({
  salesMultiplierBps: '窓口の直近の売上報告と需給の曲線の元の件数を見て、倍率を確かめる',
  recoveryAmountBps: '出資の作品の回収の入金と委員会の分配の実績を見て、回収の量を確かめる',
  meetingToProposalBps: '面談の記録のうち提案へ進んだ件数を数えて、率を確かめる',
  proposalToContractBps: '提案の記録のうち契約へ進んだ件数を数えて、率を確かめる',
  paymentDelayMonths: '取引先の支払いの条件を契約書で確かめ、案件の次の一手に期日を入れる',
});
const TORNADO_LIMIT = 8;
const TORNADO_CHECKED = 3;
const REACH_GOAL_BPS = 7000;
const MULTIPLIER_STEP_X100 = 5;
const MULTIPLIER_MAX_X100 = 400;
// 1件増やしたときの期待値の動きがこの幅（±5,000円）の内なら「増やしても今期は変わらない」、下へ超えたら「増やすと今期は下がる」
const FLAT_DELTA_YEN = 5000;
const INVEST_SOURCES = new Set(['own_investment', 'committee']);

const sum = (rows, pick) => rows.reduce((n, row) => n + pick(row), 0);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
// 件数×倍率÷100 の切り捨て（整数のまま）
const scaleCount = (countX100, multiplierX100) => (countX100 * multiplierX100 - ((countX100 * multiplierX100) % 100)) / 100;
const actionId = (row) => `${row.source}:${row.step}`;

// 確率（0〜1）を bp へ half_up。0以上なので Math.round と同じ向き（確率は金額ではない。money-rules の NOT_MONEY）
export function probabilityBps(p) {
  return clamp(Math.round(p * 10000), 0, 10000);
}

// 稼ぎ方の粗利に掛ける市場の前提（買付・委託は窓口の売上の倍率、出資は回収の量、受託は無し）
function multiplierOf(source, assumptions) {
  if (source === 'acquisition' || source === 'consignment') return assumptions.salesMultiplierBps;
  if (INVEST_SOURCES.has(source)) return assumptions.recoveryAmountBps;
  return null;
}

// 粗利（期間内の粗利）に掛ける率: 換算率と前提の倍率
const profitRatesOf = (conversionBps, multiplier) => (multiplier === null ? [conversionBps] : [conversionBps, multiplier]);
// 会社の売上に掛ける率（申し送り §稼ぎ方ごとの表の「会社の売上」）。買付は窓口の売上（総額）なので換算率（MG つきは手数料率）を掛けない。
// 受託（受託費）・委託（手数料）は純額、自社出資（回収）・委員会（自社の取得額）は粗利と同じ率
const salesRatesOf = (source, conversionBps, multiplier) => (source === 'acquisition' ? (multiplier === null ? [] : [multiplier]) : profitRatesOf(conversionBps, multiplier));

// ---------- 実績（源泉ごとの期間内の粗利と会社の売上） ----------

const unconnectedSource = () => ({status: 'unconnected', actualYen: null, actualSalesYen: null, rowCount: 0, unknownCount: 0});

// 源泉の実績。facts の源泉が null なら未接続、行があって額が全部未確定なら unknown（どちらも null で、0円で埋めない）。
// 売上は粗利と同じ行（額が確定した行）で数える
function sourceActual(rows, known, profitOf, salesOf) {
  if (rows === null) return unconnectedSource();
  const ok = rows.filter(known);
  const unknownCount = rows.length - ok.length;
  if (rows.length > 0 && ok.length === 0) return {status: 'unknown', actualYen: null, actualSalesYen: null, rowCount: 0, unknownCount};
  return {status: 'connected', actualYen: sum(ok, profitOf), actualSalesYen: sum(ok, salesOf), rowCount: ok.length, unknownCount};
}

// 粗利（J-11b (a) 払った月に引く。払込の判定は締めた月より前は実績の側）: 自社出資は 期間内の入金（税込・参考）、委員会は 期間内の自社の取得額 − 期間内の自社の払込、
// 買付は 買い切り＝期間内の税抜売上・MG つき＝手数料の和（MG 残は未控除）、販売委託は手数料（純額）の和、受託は未接続。
// 自社出資の出資額と買い切りの買付額は、段A では払った月を持たないので期間より前に払った（実績の側）扱いにし、期間の粗利・期待値から引かない
// （出資額は出資の回収の累計の差額にだけ出る。払込の月は段B #4）。委員会の自社の払込は払った日があるので、期間内の分をその月に引く。
// 会社の売上: 自社出資は回収（期間内の入金）、委員会は自社の取得額、買付は窓口の売上（総額）、販売委託は手数料（純額）。
// 買付・販売委託の契約にも入る委員会の作品（overlap）は、取得額を契約の分と分けられないので未確定の行にする（同じ売上を2つの源泉で数えない）
export function sourceActuals(facts) {
  return {
    contract_work: unconnectedSource(),
    own_investment: sourceActual(facts.ownInvestment, () => true, (row) => row.receiptsPeriodYen, (row) => row.receiptsPeriodYen),
    committee: sourceActual(facts.committee, (row) => row.acquisitionsPeriodYen !== null && !row.overlap,
      (row) => row.acquisitionsPeriodYen - row.paymentsPeriodYen, (row) => row.acquisitionsPeriodYen),
    acquisition: sourceActual(facts.acquisition, (row) => row.kind === 'outright' || row.agencyFeePeriodYen !== null,
      (row) => (row.kind === 'outright' ? row.salesPeriodYen : row.agencyFeePeriodYen), (row) => row.salesPeriodYen),
    consignment: sourceActual(facts.consignment, () => true, (row) => row.agencyFeePeriodYen, (row) => row.agencyFeePeriodYen),
  };
}

// ---------- 商談の残りの額 ----------

// 同じ作品×取引先の close_date の月以降の売上を、close_date 順（同じ日は商談ID順）に早い月から充て、余りを次の商談へ回す。
// 月の純額が負の月は充てない。失注・見込額の無い・close_date の無い商談は充てる相手にしない
export function allocateRemaining(opportunities, sales) {
  const salesByGroup = new Map();
  for (const line of sales) {
    const key = `${line.workId}:${line.partnerId}`;
    if (!salesByGroup.has(key)) salesByGroup.set(key, new Map());
    const months = salesByGroup.get(key);
    months.set(line.month, (months.get(line.month) || 0) + line.amountYen);
  }
  const eligible = opportunities.filter((o) => o.stage !== 'lost' && o.expectedYen !== null && o.closeDate !== null)
    .sort((a, b) => (a.closeDate === b.closeDate ? a.id - b.id : a.closeDate < b.closeDate ? -1 : 1));
  const pools = new Map();
  const remaining = new Map();
  for (const o of eligible) {
    const key = `${o.workId}:${o.partnerId}`;
    if (!pools.has(key)) {
      const months = salesByGroup.get(key) || new Map();
      pools.set(key, [...months.entries()].map(([month, amount]) => ({index: monthIndex(month), left: Math.max(0, amount)})).sort((a, b) => a.index - b.index));
    }
    const from = monthIndex(o.closeDate.slice(0, 7));
    let need = o.expectedYen;
    for (const pool of pools.get(key)) {
      if (need === 0) break;
      if (pool.index < from || pool.left === 0) continue;
      const take = Math.min(need, pool.left);
      pool.left -= take;
      need -= take;
    }
    remaining.set(o.id, need);
  }
  return remaining;
}

// ---------- 案件と行動の見込 ----------

// 商談ごとの 成立の確率・期間内の粗利 x_i（残り×換算率×前提の倍率を1回 truncate）・確度加重・会社の売上・売上の月と入金の月。期待値に入れない商談は理由つきで分ける
export function opportunityForecast(request, facts, assumptions) {
  const spec = new Map(request.opportunities.map((row) => [row.id, row]));
  const remaining = allocateRemaining(facts.opportunities, facts.salesByWorkPartner);
  const from = monthIndex(request.period.from);
  const to = monthIndex(request.period.to);
  const firstOpen = monthIndex(request.closedMonth) + 1;
  const rows = [];
  const excluded = [];
  for (const o of facts.opportunities) {
    const s = spec.get(o.id);
    let reason = null;
    if (o.stage === 'lost') reason = 'lost';
    else if (!s) reason = 'no_source';
    else if (o.expectedYen === null) reason = 'no_amount';
    else if (!s.revenueMonth && !o.closeDate) reason = 'no_month';
    if (reason) {
      excluded.push({opportunityId: o.id, reason, expectedYen: o.expectedYen});
      continue;
    }
    const revenue = monthIndex(s.revenueMonth ?? o.closeDate.slice(0, 7));
    // 締めた月までは実績の側。残りは早くても締めた月の次の月に立つとみなす
    const effective = Math.max(revenue, firstOpen);
    const placement = effective < from ? 'before_period' : effective > to ? 'after_period' : 'in_period';
    const probability = o.stage === 'won' ? 10000 : request.stageProbabilityBps[o.stage];
    const left = remaining.has(o.id) ? remaining.get(o.id) : o.expectedYen;
    const multiplier = multiplierOf(s.source, assumptions);
    const value = rateChain(left, profitRatesOf(s.conversionBps, multiplier));
    const salesValue = rateChain(left, salesRatesOf(s.source, s.conversionBps, multiplier));
    const channel = s.channel ?? o.partnerKind;
    const gap = channel !== null && Object.hasOwn(request.paymentGapMonths, channel) ? request.paymentGapMonths[channel] : null;
    const payment = placement === 'before_period' || gap === null ? null : effective + gap + assumptions.paymentDelayMonths;
    rows.push({
      opportunityId: o.id, workId: o.workId, name: o.name, source: s.source, stage: o.stage, probabilityBps: probability,
      remainingYen: left, valueYen: value, weightedYen: signedRateAmount(value, probability),
      salesValueYen: salesValue, weightedSalesYen: signedRateAmount(salesValue, probability),
      revenueMonth: monthOfIndex(effective), overdue: revenue < firstOpen, placement, channel,
      paymentMonth: payment === null ? null : monthOfIndex(payment),
      // 入金の見込は取引先から入る額（換算率の前）を確度で加重する
      inflowYen: payment === null ? null : rateChain(left, multiplier === null ? [probability] : [multiplier, probability]),
    });
  }
  return {rows: rows.sort((a, b) => a.opportunityId - b.opportunityId), excluded: excluded.sort((a, b) => a.opportunityId - b.opportunityId)};
}

// 行動（残りの期間の件数）の見込。成立の確率は段の率の積、1件の粗利は 1件の額×換算率×前提の倍率、
// 見込は 件数_x100×額×率を全部掛けて1回だけ truncate（申し送り §期待値）。会社の売上も同じ形で、率だけ salesRatesOf
export function actionForecast(actions, assumptions) {
  return actions.map((action) => {
    const multiplier = multiplierOf(action.source, assumptions);
    const valueRates = profitRatesOf(action.conversionBps, multiplier);
    const salesRates = salesRatesOf(action.source, action.conversionBps, multiplier);
    const stepRates = action.step === 'meeting' ? [assumptions.meetingToProposalBps, assumptions.proposalToContractBps] : [assumptions.proposalToContractBps];
    const total = BigInt(action.dealYen) * BigInt(action.countX100);
    return {
      source: action.source, step: action.step, countX100: action.countX100, dealYen: action.dealYen, hoursX100: action.hoursX100,
      valueYen: rateChain(action.dealYen, valueRates),
      expectedYen: rateChain(total, [...valueRates, ...stepRates], {divisor: 100}),
      salesValueYen: rateChain(action.dealYen, salesRates),
      expectedSalesYen: rateChain(total, [...salesRates, ...stepRates], {divisor: 100}),
      probability: stepRates.reduce((p, bps) => p * (bps / 10000), 1),
    };
  });
}

// ---------- 分布（1万円の格子。Float64） ----------

class Distribution {
  constructor(offset, probs) {
    this.offset = offset;
    this.probs = probs;
  }

  static at(index) {
    return new Distribution(index, Float64Array.of(1));
  }

  // 1つの試行（結果ごとの格子の番号と確率。確率0の結果は除いてある）をたたみ込む
  add(live) {
    const low = Math.min(...live.map((o) => o.grid));
    const high = Math.max(...live.map((o) => o.grid));
    const next = new Float64Array(this.probs.length + high - low);
    for (let i = 0; i < this.probs.length; i++) {
      const p = this.probs[i];
      if (p === 0) continue;
      for (const o of live) next[i + o.grid - low] += p * o.p;
    }
    return new Distribution(this.offset + low, next);
  }

  points() {
    const out = [];
    for (let i = 0; i < this.probs.length; i++) if (this.probs[i] > 0) out.push([(this.offset + i) * GRID_YEN, this.probs[i]]);
    return out;
  }

  // p の分位点＝累積が p 以上になる最小の値（浮動小数の足し算の誤差を 1e-12 まで許す。1−0.9 は 0.1 より小さくなる）
  quantile(p) {
    let cum = 0;
    for (let i = 0; i < this.probs.length; i++) {
      cum += this.probs[i];
      if (this.probs[i] > 0 && cum >= p - 1e-12) return (this.offset + i) * GRID_YEN;
    }
    return (this.offset + this.probs.length - 1) * GRID_YEN;
  }

  // 目標以上になる確率
  reach(targetYen) {
    let p = 0;
    for (let i = 0; i < this.probs.length; i++) if ((this.offset + i) * GRID_YEN >= targetYen) p += this.probs[i];
    return p;
  }

  mean() {
    let m = 0;
    for (let i = 0; i < this.probs.length; i++) m += this.probs[i] * (this.offset + i);
    return m * GRID_YEN;
  }
}

// 件数 n・成立の確率 p の二項分布。k 件の合計を寄せる（1件を寄せてから k 倍しない）。
// 初項 (1-p)^n は n が大きいと 0 に潰れるので、確率は対数で漸化し、いちばん大きい項で割ってから、和で割って1にそろえる
function binomialOutcomes(n, p, valueYen) {
  if (p <= 0) return [{grid: 0, p: 1}];
  if (p >= 1) return [{grid: gridIndex(n * valueYen, GRID_YEN), p: 1}];
  const logs = new Float64Array(n + 1);
  const odds = Math.log(p) - Math.log1p(-p);
  logs[0] = n * Math.log1p(-p);
  for (let k = 0; k < n; k++) logs[k + 1] = logs[k] + Math.log((n - k) / (k + 1)) + odds;
  let top = -Infinity;
  for (const value of logs) top = Math.max(top, value);
  const weights = Array.from(logs, (value) => Math.exp(value - top));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((weight, k) => ({grid: gridIndex(k * valueYen, GRID_YEN), p: weight / total}));
}

// 期間内の案件を「確度で x_i が入る」試行、行動を件数の二項分布（端数は1回の試行）にする。確率0の結果は除く
function trialsOf(oppRows, actionRows) {
  const trials = [];
  for (const row of oppRows) {
    if (row.placement !== 'in_period') continue;
    const p = row.probabilityBps / 10000;
    trials.push([{grid: 0, p: 1 - p}, {grid: gridIndex(row.valueYen, GRID_YEN), p}]);
  }
  for (const row of actionRows) {
    const whole = (row.countX100 - (row.countX100 % 100)) / 100;
    const fraction = row.countX100 % 100;
    if (whole > 0) trials.push(binomialOutcomes(whole, row.probability, row.valueYen));
    if (fraction > 0) {
      const p = row.probability * (fraction / 100);
      trials.push([{grid: 0, p: 1 - p}, {grid: gridIndex(row.valueYen, GRID_YEN), p}]);
    }
  }
  return trials.map((outcomes) => outcomes.filter((o) => o.p > 0));
}

// 分布が上限を超えた（reason: too_large＝1本が上限を超える、request_limit＝1つの要求で数える分布の合計が上限を超える）。
// 行動の件数と1件の額で決まるので要求の本文の側の問題（ScenarioInputError。受け口は400）。目標に依る値の側では受け止めて、そこで数えるのを止める
export class DistributionLimitError extends ScenarioInputError {
  constructor(reason, message) {
    super('actions', message);
    this.name = 'DistributionLimitError';
    this.reason = reason;
  }
}

// 1つの要求で数えた分布の本数とたたみ込みの回数（compareScenarios が1つ作り、分布を数えるたびに足す）
export const distributionBudget = () => ({count: 0, steps: 0});

// 締めた月までの実績（源泉の和）を起点に試行をたたみ込む。格子の数とたたみ込みの回数が1本の上限か要求の合計の上限を超えるなら、配列を作る前に止める
function buildDistribution(actualYen, oppRows, actionRows, budget) {
  const trials = trialsOf(oppRows, actionRows);
  let cells = 1;
  let steps = 0;
  for (const live of trials) {
    steps += cells * live.length;
    cells += Math.max(...live.map((o) => o.grid)) - Math.min(...live.map((o) => o.grid));
  }
  if (cells > MAX_DISTRIBUTION_CELLS || steps > MAX_CONVOLUTION_STEPS) {
    throw new DistributionLimitError('too_large', `分布が大きすぎて数えられません（格子 ${cells}個・たたみ込み ${steps}回。上限は ${MAX_DISTRIBUTION_CELLS}個・${MAX_CONVOLUTION_STEPS}回）。行動の件数か1件の額を減らしてください`);
  }
  if (budget.count + 1 > MAX_REQUEST_DISTRIBUTIONS || budget.steps + steps > MAX_REQUEST_CONVOLUTION_STEPS) {
    throw new DistributionLimitError('request_limit', `1つの要求で数える分布が多すぎます（${budget.count + 1}本・たたみ込み 合計 ${budget.steps + steps}回。上限は ${MAX_REQUEST_DISTRIBUTIONS}本・${MAX_REQUEST_CONVOLUTION_STEPS}回）。行動の件数か1件の額を減らしてください`);
  }
  budget.count += 1;
  budget.steps += steps;
  let dist = Distribution.at(gridIndex(actualYen, GRID_YEN));
  for (const live of trials) dist = dist.add(live);
  return {dist, components: 1 + trials.length};
}

// 分布の平均と整数の期待値の差は「内訳の数 × 5,001円」（格子への寄せの5,000円と内訳の truncate の1円）に、
// 行動の1件の粗利の truncate（1円未満）が成立の件数ぶん重なる分（件数）を足した幅に収まる。超えたら分布が壊れているので止める（黙って出さない）。
// 誤りの文は app.onError がログに出すので、金額を入れず、どの分布か（label）・内訳の数・許す幅の種類だけを書く（integrated-logging）。
// 平均は円の端数を持つので応答に出さない（金額は整数円。integrated-money）
export function checkedDistribution(actualYen, oppRows, actionRows, expectedYen, label, budget = distributionBudget()) {
  const built = buildDistribution(actualYen, oppRows, actionRows, budget);
  const allowance = built.components * 5001 + sum(actionRows, (row) => row.countX100) / 100;
  if (!(Math.abs(built.dist.mean() - expectedYen) <= allowance)) {
    throw new Error(`分布の平均が期待値から許す幅を超えて離れました（${label}・内訳 ${built.components}個。許す幅は内訳ごとの格子への寄せと truncate、行動の件数の分。分布の計算の誤り）`);
  }
  return built;
}

const quantilesOf = (dist) => ({p10Yen: dist.quantile(0.1), p50Yen: dist.quantile(0.5), p90Yen: dist.quantile(0.9)});

// ---------- 入金の時期 ----------

// 期間内の入金の見込（月別）、期末2か月、入金が1か月遅れると期間の外へ出る額（期末の月の分）、来期へ持ち越す額。
// 遅れが上限のときは、さらに1か月遅れた値を測れないので null
export function cashSchedule(period, oppRows, paymentDelayMonths) {
  const from = monthIndex(period.from);
  const to = monthIndex(period.to);
  const byMonth = new Map();
  let periodYen = 0, lastTwoMonthsYen = 0, edgeYen = 0, nextPeriodYen = 0, unscheduledCount = 0;
  for (const row of oppRows) {
    if (row.placement === 'before_period') continue;
    if (row.paymentMonth === null) {
      unscheduledCount += 1;
      continue;
    }
    const month = monthIndex(row.paymentMonth);
    if (month > to) {
      nextPeriodYen += row.inflowYen;
      continue;
    }
    if (month < from) continue;
    periodYen += row.inflowYen;
    if (month >= to - 1) lastTwoMonthsYen += row.inflowYen;
    if (month === to) edgeYen += row.inflowYen;
    if (row.inflowYen !== 0) byMonth.set(month, (byMonth.get(month) || 0) + row.inflowYen);
  }
  return {
    byMonth: [...byMonth.entries()].sort(([a], [b]) => a - b).map(([month, yen]) => ({month: monthOfIndex(month), yen})),
    periodYen, lastTwoMonthsYen, slipOutYen: paymentDelayMonths >= MAX_PAYMENT_DELAY_MONTHS ? null : edgeYen, nextPeriodYen, unscheduledCount,
  };
}

// ---------- 出資の回収 ----------

// 出資のある案件（自社出資・委員会）ごとに1行と合計。差額＝収益−出資額（全期間の累計。負は「回収待ち」で未達と書かない）、回収率＝収益÷出資額（bp、truncate。
// 出資額が NULL・0 なら null で 0% で埋めない）、期末の見込みの差額＝差額＋表示中のシナリオの残りの期待値（その作品の出資の源泉の確度加重）。
// 自社出資は 出資額＝最新の版の出資額・収益＝作品の入金（税込・参考）、委員会は 出資額＝自社の払込の累計・収益＝自社の取得額の累計。
// 委員会の行は自社の出資のある作品（selfInvested）だけ（自社が参加者でない委員会の作品を、出資額0の回収済みの行にしない。源泉3の実績には入る）。
// 合計は差額が分かる行（出資額と収益の両方がある行）だけで足し、どの列も同じ行の集合にする（収益−出資額＝差額、回収率＝収益の合計÷出資額の合計）。
// 差額が分からない行は件数と出資額を unknown に分ける。facts の源泉が null（未接続）なら行を作らず unconnected に名前を出す
export function investmentRecovery({ownInvestment, committee}, remainingByWork = new Map()) {
  const base = [
    ...[...(ownInvestment ?? [])].sort((a, b) => a.workId - b.workId).map((row) => ({
      kind: 'own_investment', workId: row.workId, title: row.title, investmentYen: row.investmentYen, revenueYen: row.receiptsTotalYen,
      // 払込の月が無いので期間より前に払った（実績の側）扱いで、期間内の出資額は0円（段B #4 で払込の月を持つ）
      periodInvestmentYen: 0, periodRevenueYen: row.receiptsPeriodYen, error: null, holdNote: null,
    })),
    ...[...(committee ?? [])].filter((row) => row.selfInvested).sort((a, b) => a.workId - b.workId).map((row) => ({
      kind: 'committee', workId: row.workId, title: row.title, investmentYen: row.paymentsTotalYen, revenueYen: row.acquisitionsTotalYen,
      periodInvestmentYen: row.paymentsPeriodYen, periodRevenueYen: row.acquisitionsPeriodYen, error: row.error, holdNote: row.holdNote,
    })),
  ];
  const rows = base.map((row) => {
    const remainingExpectedYen = remainingByWork.get(row.workId) || 0;
    const diffYen = row.investmentYen === null || row.revenueYen === null ? null : row.revenueYen - row.investmentYen;
    const recoveryRateBps = diffYen === null ? null : ratioBps(row.revenueYen, row.investmentYen);
    return {
      ...row, remainingExpectedYen, diffYen, recoveryRateBps,
      status: diffYen === null ? 'unknown' : diffYen < 0 ? 'awaiting' : 'recovered',
      projectedDiffYen: diffYen === null ? null : diffYen + remainingExpectedYen,
    };
  });
  const known = rows.filter((row) => row.diffYen !== null);
  const unknown = rows.filter((row) => row.diffYen === null);
  // 同じ行の集合で足す。その集合の中に値の無い行があれば、その列の合計は null（一部だけ足した値を出さない）
  const total = (key) => (!known.length || known.some((row) => row[key] === null) ? null : sum(known, (row) => row[key]));
  const unconnected = [['own_investment', ownInvestment], ['committee', committee]].filter(([, list]) => list === null).map(([kind]) => kind);
  const investmentYen = total('investmentYen');
  const revenueYen = total('revenueYen');
  const diffYen = total('diffYen');
  const knownInvestment = unknown.filter((row) => row.investmentYen !== null);
  return {
    rows,
    total: {
      rowCount: known.length, investmentYen, revenueYen, diffYen,
      periodInvestmentYen: total('periodInvestmentYen'), periodRevenueYen: total('periodRevenueYen'), projectedDiffYen: total('projectedDiffYen'),
      recoveryRateBps: investmentYen === null ? null : ratioBps(revenueYen, investmentYen),
      // 合計に入る行が無ければ「回収済み」と言わない
      status: known.length ? (diffYen < 0 ? 'awaiting' : 'recovered') : unconnected.length === 2 ? 'unconnected' : 'unknown',
    },
    unknown: {count: unknown.length, investmentYen: knownInvestment.length ? sum(knownInvestment, (row) => row.investmentYen) : null},
    unconnected,
  };
}

// ---------- シナリオ ----------

export function scenarioAssumptions(request, key) {
  const base = request.assumptions;
  if (key === 'standard') return {...base};
  if (key === 'custom') return {...base, ...(request.custom?.assumptions || {})};
  const out = {...base};
  for (const name of SCENARIO_MOVES) {
    const range = SCENARIO_RANGES[name];
    out[name] = clamp(base[name] + range[key], range.min, range.max);
  }
  return out;
}

export function scenarioActions(request, key) {
  if (key !== 'custom' || !request.custom) return request.actions.map((action) => ({...action}));
  const counts = new Map(request.custom.actions.map((row) => [actionId(row), row.countX100]));
  return request.actions.map((action) => (counts.has(actionId(action)) ? {...action, countX100: counts.get(actionId(action))} : {...action}));
}

function expectedParts(actuals, oppRows, actionRows) {
  const bySource = SOURCES.map((source) => {
    const {status, actualYen, actualSalesYen} = actuals[source];
    const opp = oppRows.filter((row) => row.placement === 'in_period' && row.source === source);
    const act = actionRows.filter((row) => row.source === source);
    const forecast = opp.length > 0 || act.length > 0;
    const weightedYen = sum(opp, (row) => row.weightedYen);
    const actionYen = sum(act, (row) => row.expectedYen);
    const weightedSalesYen = sum(opp, (row) => row.weightedSalesYen);
    const actionSalesYen = sum(act, (row) => row.expectedSalesYen);
    // 実績が未接続・未確定で見込も無い源泉は null（0円で埋めない）
    const expectedYen = actualYen === null && !forecast ? null : (actualYen ?? 0) + weightedYen + actionYen;
    const expectedSalesYen = actualSalesYen === null && !forecast ? null : (actualSalesYen ?? 0) + weightedSalesYen + actionSalesYen;
    return {source, label: SOURCE_LABELS[source], status, actualYen, weightedYen, actionYen, expectedYen,
      actualSalesYen, weightedSalesYen, actionSalesYen, expectedSalesYen,
      awaitingRecovery: INVEST_SOURCES.has(source) && expectedYen !== null && expectedYen < 0};
  });
  const total = (key) => sum(bySource, (row) => row[key] ?? 0);
  return {
    bySource,
    expectedYen: total('expectedYen'), actualYen: total('actualYen'), weightedYen: total('weightedYen'), actionYen: total('actionYen'),
    expectedSalesYen: total('expectedSalesYen'), actualSalesYen: total('actualSalesYen'), weightedSalesYen: total('weightedSalesYen'), actionSalesYen: total('actionSalesYen'),
  };
}

// 期待値だけを数える（前提の効き・候補・逆算の期待値の側）
function expectedOnly(request, facts, actuals, assumptions, actions) {
  const {rows} = opportunityForecast(request, facts, assumptions);
  const parts = expectedParts(actuals, rows, actionForecast(actions, assumptions));
  return {expectedYen: parts.expectedYen, periodCashYen: cashSchedule(request.period, rows, assumptions.paymentDelayMonths).periodYen, rows, parts};
}

// 1つのシナリオの内訳・分布・入金の時期・出資の回収（key はシナリオの種類。分布の誤りの文に添える）
export function computeScenario(request, facts, {assumptions, actions, key = 'standard'}, actuals = sourceActuals(facts), budget = distributionBudget()) {
  const {rows: oppRows, excluded} = opportunityForecast(request, facts, assumptions);
  const actionRows = actionForecast(actions, assumptions);
  const parts = expectedParts(actuals, oppRows, actionRows);
  const {dist, components} = checkedDistribution(parts.actualYen, oppRows, actionRows, parts.expectedYen, key, budget);
  const {dist: withoutActions} = checkedDistribution(parts.actualYen, oppRows, [], parts.actualYen + parts.weightedYen, `${key}_without_actions`, budget);
  const remainingByWork = new Map();
  for (const row of oppRows) {
    if (row.placement !== 'in_period' || !INVEST_SOURCES.has(row.source)) continue;
    remainingByWork.set(row.workId, (remainingByWork.get(row.workId) || 0) + row.weightedYen);
  }
  return {
    assumptions: {...assumptions},
    actions: actions.map((action) => ({source: action.source, step: action.step, countX100: action.countX100})),
    expectedYen: parts.expectedYen, actualYen: parts.actualYen, weightedYen: parts.weightedYen, actionYen: parts.actionYen,
    // 着地の代わりの「実績＋確度加重」（行動からの見込を含まない）
    actualPlusWeightedYen: parts.actualYen + parts.weightedYen,
    expectedSalesYen: parts.expectedSalesYen, actualSalesYen: parts.actualSalesYen, weightedSalesYen: parts.weightedSalesYen, actionSalesYen: parts.actionSalesYen,
    actualPlusWeightedSalesYen: parts.actualSalesYen + parts.weightedSalesYen,
    bySource: parts.bySource,
    opportunities: oppRows,
    actionRows: actionRows.map(({probability, hoursX100, ...row}) => row),
    excluded,
    nextPeriodProfitYen: sum(oppRows.filter((row) => row.placement === 'after_period'), (row) => row.weightedYen),
    componentCount: components,
    distribution: {gridYen: GRID_YEN, points: dist.points()},
    quantiles: quantilesOf(dist),
    quantilesWithoutActions: quantilesOf(withoutActions),
    cash: cashSchedule(request.period, oppRows, assumptions.paymentDelayMonths),
    investmentRecovery: investmentRecovery(facts, remainingByWork),
    _dist: dist,
    _withoutActions: withoutActions,
  };
}

// ---------- 前提の効き・行動の候補・逆算 ----------

// 市場の前提を1つずつ悲観と楽観へ動かし（ほかは標準のまま）、期待値の動きの大きい順に並べる。上位3つに確かめる手段
export function tornado(request, facts, actuals = sourceActuals(facts)) {
  const base = scenarioAssumptions(request, 'standard');
  const actions = scenarioActions(request, 'standard');
  const rows = TORNADO_KEYS.map((key) => {
    const range = SCENARIO_RANGES[key];
    const side = (name) => {
      const value = clamp(base[key] + range[name], range.min, range.max);
      const result = expectedOnly(request, facts, actuals, {...base, [key]: value}, actions);
      return {value, expectedYen: result.expectedYen, periodCashYen: result.periodCashYen};
    };
    const pessimistic = side('pessimistic');
    const optimistic = side('optimistic');
    return {key, label: ASSUMPTION_LABELS[key], pessimistic, optimistic,
      swingYen: Math.abs(optimistic.expectedYen - pessimistic.expectedYen), cashSwingYen: Math.abs(optimistic.periodCashYen - pessimistic.periodCashYen)};
  });
  rows.sort((a, b) => b.swingYen - a.swingYen || b.cashSwingYen - a.cashSwingYen || (a.key < b.key ? -1 : 1));
  return rows.slice(0, TORNADO_LIMIT).map((row, index) => ({...row, check: index < TORNADO_CHECKED ? ASSUMPTION_CHECKS[row.key] : null}));
}

// 大きい順（< と > は BigInt と Number をまたいで値で比べる）。整数の円の増分×時間は BigInt にして、安全な整数の範囲を超えても順が崩れないようにする
const descending = (a, b) => (a > b ? -1 : a < b ? 1 : 0);
const crossed = (value, hoursX100) => (Number.isSafeInteger(value) ? BigInt(value) * BigInt(hoursX100) : value * hoursX100);

// 申し送り K-e の並び: 増分÷時間の大きい順（割らずに掛けて比べる。時間0は先頭で、時間0どうしは増分の順）、同じなら期待値の増分の順、それも同じなら稼ぎ方と段の名前の順
function byPerHour(delta) {
  return (a, b) => {
    const zeroA = a.hoursX100 === 0, zeroB = b.hoursX100 === 0;
    if (zeroA !== zeroB) return zeroA ? -1 : 1;
    const order = zeroA ? descending(delta(a), delta(b)) : descending(crossed(delta(a), b.hoursX100), crossed(delta(b), a.hoursX100));
    if (order) return order;
    const second = descending(a.expectedDeltaYen, b.expectedDeltaYen);
    if (second) return second;
    return actionId(a) < actionId(b) ? -1 : actionId(a) > actionId(b) ? 1 : 0;
  };
}

// 行動の候補 (1): 行動の件数を1件増やす。期待値の増分と時間（行動1件の時間。成約後の実行の時間は段B）
export function actionCandidates(request, facts, actuals = sourceActuals(facts)) {
  const assumptions = scenarioAssumptions(request, 'standard');
  const actions = scenarioActions(request, 'standard');
  const before = expectedOnly(request, facts, actuals, assumptions, actions).expectedYen;
  return actions.map((action, index) => {
    const more = actions.map((row, j) => (j === index ? {...row, countX100: row.countX100 + 100} : row));
    return {source: action.source, step: action.step, addCountX100: 100, hoursX100: action.hoursX100,
      expectedDeltaYen: expectedOnly(request, facts, actuals, assumptions, more).expectedYen - before};
  }).sort(byPerHour((row) => row.expectedDeltaYen));
}

// 行動を差し替えた標準のシナリオの期待値と、その分布（label は誤りの文に添える分布の名前）
function forecastOf(request, facts, actuals, assumptions, actions) {
  const {rows} = opportunityForecast(request, facts, assumptions);
  const actionRows = actionForecast(actions, assumptions);
  return {rows, actionRows, parts: expectedParts(actuals, rows, actionRows)};
}
function reachOf(request, facts, actuals, assumptions, actions, label, budget) {
  const {rows, actionRows, parts} = forecastOf(request, facts, actuals, assumptions, actions);
  return {dist: checkedDistribution(parts.actualYen, rows, actionRows, parts.expectedYen, label, budget).dist, expectedYen: parts.expectedYen};
}

// 逆算: いまの行動をそろって増やす倍率（0.05刻み・4倍まで）で、期待値が目標に届く倍率と、届く確率が70%になる倍率。
// 1件増やして期待値が5,000円より多く増えない行動は固定し、理由（down＝5,000円より多く下がる、flat＝±5,000円の内）を添える。届かなければ null。
// 段A の行動の粗利は0円以上なので down は出ない（段B で MG・商品化の費用を払う月が回収より先に来る行動を入れると出る）。
// 分布が上限（1本か要求の合計）を超える倍率に来たら、確率の探索はそこで止めて stopped に倍率と理由を出す（その倍率から先の確率は数えていない）。
// 期待値の倍率は分布を使わないので、止めたあとも探す
function reverseMultiplier(request, facts, actuals, targetYen, candidates, budget) {
  const assumptions = scenarioAssumptions(request, 'standard');
  const actions = scenarioActions(request, 'standard');
  const reasonOf = new Map(candidates.filter((row) => row.expectedDeltaYen <= FLAT_DELTA_YEN)
    .map((row) => [actionId(row), row.expectedDeltaYen < -FLAT_DELTA_YEN ? 'down' : 'flat']));
  const fixed = actions.filter((row) => reasonOf.has(actionId(row))).map((row) => ({source: row.source, step: row.step, reason: reasonOf.get(actionId(row))}));
  const out = {expected: null, probability: null, fixed, goalBps: REACH_GOAL_BPS, stopped: null};
  if (fixed.length === actions.length) return out;
  for (let multiplierX100 = 100; multiplierX100 <= MULTIPLIER_MAX_X100; multiplierX100 += MULTIPLIER_STEP_X100) {
    const scaled = actions.map((row) => (reasonOf.has(actionId(row)) ? row : {...row, countX100: scaleCount(row.countX100, multiplierX100)}));
    const hoursX100 = sum(scaled, (row) => scaleCount(row.countX100, row.hoursX100));
    const {rows, actionRows, parts} = forecastOf(request, facts, actuals, assumptions, scaled);
    const found = {multiplierX100, hoursX100, actions: scaled.map((row) => ({source: row.source, step: row.step, countX100: row.countX100}))};
    if (!out.expected && parts.expectedYen >= targetYen) out.expected = {...found, expectedYen: parts.expectedYen};
    if (!out.probability && !out.stopped) {
      try {
        const reach = probabilityBps(checkedDistribution(parts.actualYen, rows, actionRows, parts.expectedYen, 'reverse', budget).dist.reach(targetYen));
        if (reach >= REACH_GOAL_BPS) out.probability = {...found, reachBps: reach};
      } catch (error) {
        if (!(error instanceof DistributionLimitError)) throw error;
        out.stopped = {multiplierX100, reason: error.reason};
      }
    }
    if (out.expected && (out.probability || out.stopped)) break;
  }
  return out;
}

// 目標額に依る値（差・達成率・届く確率・候補の確率の増分・逆算）。送った要求の応答にだけ入れる（目標額は保存しない）。
// 行動の候補の届く確率は、分布が上限を超える候補だけ null にして理由（stopped）を添え、並びの最後に置く（確率を数えた候補は増分÷時間の順）
function targetView(request, facts, actuals, scenarios, candidates, targetYen, budget) {
  const perScenario = {};
  for (const [key, scenario] of Object.entries(scenarios)) {
    perScenario[key] = {
      gapYen: scenario.expectedYen - targetYen,
      // 回収待ちを含んで期待値が0以下のときは負の達成率を出さない
      achievementBps: scenario.expectedYen > 0 ? ratioBps(scenario.expectedYen, targetYen) : null,
      reachBps: probabilityBps(scenario._dist.reach(targetYen)),
      reachWithoutActionsBps: probabilityBps(scenario._withoutActions.reach(targetYen)),
    };
  }
  const assumptions = scenarioAssumptions(request, 'standard');
  const actions = scenarioActions(request, 'standard');
  const before = scenarios.standard._dist.reach(targetYen);
  const withProbability = candidates.map((row) => {
    const more = actions.map((action) => (actionId(action) === actionId(row) ? {...action, countX100: action.countX100 + row.addCountX100} : action));
    let after = null, stopped = null;
    try {
      after = reachOf(request, facts, actuals, assumptions, more, 'candidate', budget).dist.reach(targetYen);
    } catch (error) {
      if (!(error instanceof DistributionLimitError)) throw error;
      stopped = error.reason;
    }
    return {source: row.source, step: row.step, hoursX100: row.hoursX100, expectedDeltaYen: row.expectedDeltaYen,
      reachBeforeBps: probabilityBps(before), reachAfterBps: after === null ? null : probabilityBps(after), reachDelta: after === null ? null : after - before, stopped};
  });
  const ordered = [...withProbability.filter((row) => row.reachDelta !== null).sort(byPerHour((row) => row.reachDelta)), ...withProbability.filter((row) => row.reachDelta === null)]
    .map(({reachDelta, ...row}) => ({...row, reachDeltaBps: row.reachAfterBps === null ? null : row.reachAfterBps - row.reachBeforeBps}));
  return {targetYen, scenarios: perScenario, candidates: ordered, reverse: reverseMultiplier(request, facts, actuals, targetYen, candidates, budget)};
}

function notesOf(facts, actuals, excludedRows) {
  const notes = [
    {code: 'provisional', text: '確度・段の率・1件の額・換算率・窓口別の支払いの間は仮置きです'},
    {code: 'independence', text: '確率は案件どうしの成立を独立とみなし、前提を固定した条件つきの値です。売上の量の振れを含みません'},
    {code: 'basis', text: '基準は計上（税抜）です。入金と回収額（自社出資の売上）は税込の参考で、未確定です（U-5 まで）'},
  ];
  for (const source of SOURCES) {
    const {status} = actuals[source];
    if (status === 'unconnected') notes.push({code: `${source}_unconnected`, text: `${SOURCE_LABELS[source]}の実績は未接続です（0円で埋めていません）`});
    if (status === 'unknown') notes.push({code: `${source}_unknown`, text: `${SOURCE_LABELS[source]}の実績は額が全部未確定です（0円で埋めていません）`});
  }
  notes.push(
    {code: 'investment_paid_before_period', text: '自社出資の出資額と買い切りの買付額は、払込・支払いの月を持たないので期間より前に払った扱い（実績の側）にし、期間の粗利と期待値から引いていません（出資の回収の表の「期間内の出資額」も自社出資は0円）。出資額は出資の回収の表の全期間の累計の差額に出ています。製作委員会の自社の払込は、期間内で締めた月までに払った分をその月に引いています。締めた月より後の日付の払込は、期間内でも期間の粗利・期待値から引かず、出資の回収の累計にも入れていません（予定の払込として引くのは段B）。払込の月は段B で持ちます'},
    {code: 'acquisition_meetings', text: '買付候補の面談は数えていません'},
    {code: 'action_timing', text: '行動から生まれる取引の入金の時期と、時間の上限の判定は数えていません（段B）'},
    {code: 'candidate_hours', text: '候補の時間は行動1件の時間だけで、成約後の実行の時間を含みません。稼ぎ方ごとに届く件数は出していません（段B）'},
  );
  if ((facts.acquisition ?? []).some((row) => row.kind === 'mg')) notes.push({code: 'mg_balance', text: 'MG 残は未控除です'});
  if (facts.unlinkedReports.count > 0) notes.push({code: 'unlinked', text: `未紐付けの報告 ${facts.unlinkedReports.count}件（税抜 ${facts.unlinkedReports.amountYen}円）は販売委託の手数料に入れていません`});
  if (facts.overlapCount > 0) notes.push({code: 'overlap', text: `出資と契約が重なる作品 ${facts.overlapCount}件は、契約のある源泉を先にしています`});
  const committeeOverlap = (facts.committee ?? []).filter((row) => row.overlap).length;
  if (committeeOverlap > 0) {
    notes.push({code: 'overlap_committee', text: `買付・販売委託の契約にも入る製作委員会の作品 ${committeeOverlap}件は、取得額を契約の分と分けられないので、製作委員会の実績に入れていません（未確定。出資の回収の表には取得額をそのまま出しています）`});
  }
  const unknown = SOURCES.reduce((n, source) => n + actuals[source].unknownCount, 0);
  if (unknown > 0) notes.push({code: 'unknown_rows', text: `額が未確定で実績に入れていない行 ${unknown}件`});
  if (excludedRows.length) notes.push({code: 'excluded', text: `期待値に入れていない商談 ${excludedRows.length}件（失注・源泉の指定が無い・見込額が無い・月が無い）`});
  return notes;
}

function excludedSummary(rows) {
  return ['lost', 'no_source', 'no_amount', 'no_month'].map((reason) => {
    const list = rows.filter((row) => row.reason === reason);
    return {reason, count: list.length, amountYen: sum(list, (row) => row.expectedYen ?? 0), opportunityIds: list.map((row) => row.opportunityId)};
  });
}

// 作り手・権利元へ渡る額（KPI の第4枚。段A は販売委託の権利元の取り分 holderAmount の和。ほかの源泉は null、買付の MG は別列の参考）。
// 販売委託が未接続（null）なら合計も null（0円で埋めない）
export function creatorsAmount(facts) {
  const mg = (facts.acquisition ?? []).filter((row) => row.kind === 'mg' && row.mgContractYen !== null);
  const consignment = facts.consignment === null ? null : sum(facts.consignment, (row) => row.holderAmountPeriodYen);
  return {
    totalYen: consignment,
    bySource: {contract_work: null, own_investment: null, committee: null, acquisition: null, consignment},
    mgReferenceYen: mg.length ? sum(mg, (row) => row.mgContractYen) : null,
  };
}

// 行動の実績（稼ぎ方×段）。面談＝contact、提案＝proposal、契約＝won で close_date が期間内の件数（sales_agreements の登録日は使わない）
export function actionActuals(request, facts) {
  const from = monthIndex(request.period.from);
  const to = monthIndex(request.period.to);
  const sourceOf = new Map(request.opportunities.map((row) => [row.id, row.source]));
  const within = (date) => date !== null && monthIndex(date.slice(0, 7)) >= from && monthIndex(date.slice(0, 7)) <= to;
  const counts = new Map();
  const count = (opportunityId, step) => {
    const source = sourceOf.get(opportunityId) ?? 'unassigned';
    if (!counts.has(source)) counts.set(source, {source, meeting: 0, proposal: 0, contract: 0});
    counts.get(source)[step] += 1;
  };
  const steps = {contact: 'meeting', proposal: 'proposal'};
  for (const activity of facts.activities) if (within(activity.occurredOn) && steps[activity.activityType]) count(activity.opportunityId, steps[activity.activityType]);
  for (const o of facts.opportunities) if (o.stage === 'won' && within(o.closeDate)) count(o.id, 'contract');
  const bySource = [...counts.values()].sort((a, b) => (a.source < b.source ? -1 : 1));
  return {bySource, total: {meeting: sum(bySource, (row) => row.meeting), proposal: sum(bySource, (row) => row.proposal), contract: sum(bySource, (row) => row.contract)}};
}

const publicScenario = ({_dist, _withoutActions, ...scenario}) => scenario;

// シナリオの比較の全体。標準・楽観・悲観（とカスタム）を同じ実績で並べ、前提の効き・行動の候補・出資の回収・作り手へ渡る額を添える
export function compareScenarios(request, facts) {
  const actuals = sourceActuals(facts);
  const budget = distributionBudget();
  const keys = SCENARIO_KEYS.filter((key) => key !== 'custom' || request.custom);
  const scenarios = Object.fromEntries(keys.map((key) => [key, computeScenario(request, facts, {
    assumptions: scenarioAssumptions(request, key), actions: scenarioActions(request, key), key}, actuals, budget)]));
  const candidates = actionCandidates(request, facts, actuals);
  const out = {
    definitionVersion: DEFINITION_VERSION,
    basis: 'accrual',
    gridYen: GRID_YEN,
    period: {...request.period},
    closedMonth: request.closedMonth,
    sources: SOURCES.map((source) => ({source, label: SOURCE_LABELS[source], ...actuals[source]})),
    excluded: excludedSummary(scenarios.standard.excluded),
    creators: creatorsAmount(facts),
    actionActuals: actionActuals(request, facts),
    overlapCount: facts.overlapCount,
    unlinkedReports: {...facts.unlinkedReports},
    scenarios: Object.fromEntries(Object.entries(scenarios).map(([key, scenario]) => [key, publicScenario(scenario)])),
    tornado: tornado(request, facts, actuals),
    candidates,
    notes: notesOf(facts, actuals, scenarios.standard.excluded),
  };
  if (request.targets) {
    out.targetView = {};
    for (const [name, key] of [['self', 'selfYen'], ['company', 'companyYen']]) {
      if (request.targets[key] !== undefined) out.targetView[name] = targetView(request, facts, actuals, scenarios, candidates, request.targets[key], budget);
    }
    const views = Object.values(out.targetView);
    if (views.some((view) => view.reverse.stopped || view.candidates.some((row) => row.stopped))) {
      out.notes.push({code: 'distribution_limit', text: '分布が大きすぎて、目標に届く確率の一部（逆算の倍率の先・行動の候補）を数えていません。行動の件数か1件の額を減らすと数えます'});
    }
  }
  return out;
}
