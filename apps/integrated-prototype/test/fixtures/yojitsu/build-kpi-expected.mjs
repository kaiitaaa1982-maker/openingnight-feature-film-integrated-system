#!/usr/bin/env node
// 行動指標の計画 段B #15 の golden（kpi-expected.json）を、src を import せずに作る生成スクリプト。
// 種は案件収支の予実の架空の種（seed.json。フェーズ1 #23a）を延長する（計画の K2-11）: seed.json・kpi-seed.json（段B の延長の行）・
// ../kpi-metrics/seed.json（段B #9 の設定の行）・../receipt-matching/invoices.json（計上の売上）を読み、次を作る。
// - 源泉別の実績（粗利と会社の売上。入金と計上）: フェーズ1 K-16 の利益額の取り方（golden.py の利益額の明細と同じ規則をここで別に書き、
//   expected.json の明細と一致することを確かめてから使う）を、案件の稼ぎ方で分けて足す。4費目を引かない場合の粗利も並べる
// - 出資者が複数の製作委員会: 自社の払込・取得額と、他の出資者の出資額・払込（数えない参考）
// - 案件別: 段階の確度・成立時の期間内の粗利（見込）・確度加重・実績・来期・次の一手と期限切れ、出資の回収
// - 通過率: 指標マスタの段の並びで、過去 N か月に段 s の活動記録があった案件のうち次の段へ進んだ件数
// - 3シナリオ（標準・楽観・悲観）・前提の効き・行動の候補: 段A の golden（test/fixtures/scenario/build-expected.mjs）と同じ定義
//   （1万円の格子へ half_up、行動は k 件の合計を寄せる、期待値は整数の内訳の和で配らない、楽観・悲観の幅、効きと候補の並び）を、
//   ここで別に書いた汎用の計算（scenarioCore）で数える。段A の入力をこの計算に通すと段A の golden と同じ値になることを試験で確かめる
// - 見直しの提案（K2-9）の4条件と、計画にいちばん足りない稼ぎ方に効く候補
// - branchCases: 種の本体では通らない分岐を、延長の種の架空の小さな入力で同じ関数に通した結果
// 確率は正確な分数（分母は10のべき乗の BigInt）のたたみ込みで数え、入力の順と逆の順の2回で同じ分布になることを確かめてから書き出す。
// golden は分布の要約・分位点・期待値・内訳で持ち、目標額を持たない（目標に依る値は試験が実行時の目標額で、このファイルの関数から数える）。
// 使い方: node test/fixtures/yojitsu/build-kpi-expected.mjs [--check]（--check は書かずに kpi-expected.json と比べ、違えば終了コード1）
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_PATH = resolve(here, 'seed.json');
export const KPI_SEED_PATH = resolve(here, 'kpi-seed.json');
export const METRICS_SEED_PATH = resolve(here, '../kpi-metrics/seed.json');
export const INVOICES_PATH = resolve(here, '../receipt-matching/invoices.json');
export const P1_EXPECTED_PATH = resolve(here, 'expected.json');
export const EXPECTED_PATH = resolve(here, 'kpi-expected.json');
export const DEFINITION_VERSION = 'kpi-stage-b-golden.2026-10-11';
export const GRID_YEN = 10000;
const GRID = 10000n;
const TEN4 = 10000n;

// ---------- 段A と同じ定数（楽観・悲観の幅、シナリオで動かす前提、効きで動かす前提、源泉の並び） ----------
export const RANGES = {
  salesMultiplierBps: {pessimistic: -1500, optimistic: 1500, min: 0, max: 100000},
  recoveryAmountBps: {pessimistic: -1500, optimistic: 1500, min: 0, max: 100000},
  meetingToProposalBps: {pessimistic: -1000, optimistic: 1000, min: 0, max: 10000},
  proposalToContractBps: {pessimistic: -1000, optimistic: 1000, min: 0, max: 10000},
  paymentDelayMonths: {pessimistic: 1, optimistic: 0, min: 0, max: 6},
};
const SCENARIO_MOVES = ['salesMultiplierBps', 'recoveryAmountBps', 'proposalToContractBps', 'paymentDelayMonths'];
const TORNADO_KEYS = ['salesMultiplierBps', 'recoveryAmountBps', 'meetingToProposalBps', 'proposalToContractBps', 'paymentDelayMonths'];
export const SOURCES = ['contract_work', 'own_investment', 'committee', 'acquisition', 'consignment'];
export const SCENARIO_KEYS = ['standard', 'optimistic', 'pessimistic'];

// ---------- 整数の道具 ----------
const big = (n) => BigInt(n);
const num = (b) => {
  const n = Number(b);
  if (!Number.isSafeInteger(n)) throw new Error('安全な整数を超えました');
  return n;
};
function trunc(n, d) {
  const neg = (n < 0n) !== (d < 0n);
  const q = (n < 0n ? -n : n) / (d < 0n ? -d : d);
  return neg ? -q : q;
}
function halfUp(n, d) {
  const neg = (n < 0n) !== (d < 0n);
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const q = a / b;
  const out = (a % b) * 2n >= b ? q + 1n : q;
  return neg ? -out : out;
}
const pow10 = (e) => 10n ** big(e);
const snap = (yen) => num(halfUp(big(yen), GRID));
export const mi = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
export const ms = (i) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
const ym = (iso) => iso.slice(0, 7);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sum = (list, f = (x) => x) => list.reduce((n, x) => n + f(x), 0);
const binom = (n, k) => {
  let out = 1n;
  for (let i = 1; i <= k; i++) out = (out * big(n - k + i)) / big(i);
  return out;
};
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
// 率の積を1回だけ truncate（率を連ねる式。docs/rules/money.md）
const chain = (amount, rates, extra = 1n) => num(trunc(rates.reduce((n, r) => n * big(r), big(amount)), extra * TEN4 ** big(rates.length)));
const ratioBps = (numerator, denominator) => (denominator > 0 ? num(trunc(big(numerator) * TEN4, big(denominator))) : null);

// =====================================================================================================
// シナリオの計算（段A と同じ定義の汎用の形）
//   inputs = {period: {from, to, nextTo}, actuals: {源泉: {status, actualYen, actualSalesYen}},
//             items: [{key, source, probabilityBps, conversionBps, salesConversionBps, placement, cashScheduled,
//                      inPeriod: {revenueBaseYen, deductionYen}, nextPeriod: {revenueBaseYen, deductionYen}, cash: [{month, baseYen}]}],
//             actions: [{source, step, countX100, dealYen, conversionBps, salesConversionBps, hoursX100}]}
//   成立時の粗利＝trunc(売上の区分の額×換算率×前提の倍率)−4費目の出金、会社の売上＝trunc(売上の区分の額×売上の換算率×前提の倍率)。
//   salesConversionBps が null の行は会社の売上に換算率を掛けない（段A の買付＝窓口の売上の総額）
// =====================================================================================================
export const multiplierOf = (source, a) => (source === 'acquisition' || source === 'consignment' ? a.salesMultiplierBps
  : source === 'own_investment' || source === 'committee' ? a.recoveryAmountBps : null);
const valueRates = (conv, mult) => (mult === null ? [conv] : [conv, mult]);
const salesRates = (salesConv, mult) => [...(salesConv === null ? [] : [salesConv]), ...(mult === null ? [] : [mult])];

function itemRows(inputs, a) {
  return inputs.items.map((it) => {
    const mult = multiplierOf(it.source, a);
    const part = (p) => ({value: chain(p.revenueBaseYen, valueRates(it.conversionBps, mult)) - p.deductionYen,
      sales: chain(p.revenueBaseYen, salesRates(it.salesConversionBps, mult))});
    const inP = part(it.inPeriod);
    const next = part(it.nextPeriod);
    const pBps = big(it.probabilityBps);
    const cashRates = mult === null ? [it.probabilityBps] : [mult, it.probabilityBps];
    const cash = it.cash.map((c) => ({month: ms(mi(c.month) + a.paymentDelayMonths), inflowYen: chain(c.baseYen, cashRates)}));
    return {key: it.key, source: it.source, probabilityBps: it.probabilityBps, placement: it.placement, cashScheduled: it.cashScheduled,
      valueYen: inP.value, weightedYen: num(trunc(big(inP.value) * pBps, TEN4)), salesValueYen: inP.sales, weightedSalesYen: num(trunc(big(inP.sales) * pBps, TEN4)),
      nextPeriodValueYen: next.value, nextPeriodWeightedYen: num(trunc(big(next.value) * pBps, TEN4)), cash};
  });
}

function actionRows(actions, a) {
  return actions.map((act) => {
    const mult = multiplierOf(act.source, a);
    const vRates = valueRates(act.conversionBps, mult);
    const stepRates = act.step === 'meeting' ? [a.meetingToProposalBps, a.proposalToContractBps] : [a.proposalToContractBps];
    const sRates = salesRates(act.salesConversionBps, mult);
    const pNum = stepRates.reduce((n, r) => n * big(r), 1n);
    return {source: act.source, step: act.step, countX100: act.countX100, dealYen: act.dealYen,
      valueYen: chain(act.dealYen, vRates), expectedYen: chain(big(act.dealYen) * big(act.countX100), [...vRates, ...stepRates], 100n),
      salesValueYen: chain(act.dealYen, sRates), expectedSalesYen: chain(big(act.dealYen) * big(act.countX100), [...sRates, ...stepRates], 100n),
      pNum, pExp: 4 * stepRates.length};
  });
}

// 試行の一覧: 各試行は {exp, outcomes: [{grid, num}]}（num の和は 10^exp）。案件は成立（確度）か不成立、行動は件数 n の二項分布と端数の1回
function trials(rows, acts) {
  const out = [];
  for (const r of rows) {
    if (r.placement !== 'in_period') continue;
    const s = big(r.probabilityBps);
    out.push({exp: 4, outcomes: [{grid: 0, num: TEN4 - s}, {grid: snap(r.valueYen), num: s}]});
  }
  for (const r of acts) {
    const n = Math.floor(r.countX100 / 100), f = r.countX100 % 100;
    const D = pow10(r.pExp);
    if (n > 0) {
      const outcomes = [];
      for (let k = 0; k <= n; k++) outcomes.push({grid: snap(k * r.valueYen), num: binom(n, k) * r.pNum ** big(k) * (D - r.pNum) ** big(n - k)});
      out.push({exp: r.pExp * n, outcomes});
    }
    if (f > 0) {
      const s = r.pNum * big(f);
      out.push({exp: r.pExp + 2, outcomes: [{grid: 0, num: D * 100n - s}, {grid: snap(r.valueYen), num: s}]});
    }
  }
  return out;
}

// たたみ込み（正確な分数）。試験の実行時の計算にも使う
export function convolve(start, list) {
  let dist = new Map([[start, 1n]]);
  let exp = 0;
  for (const t of list) {
    const next = new Map();
    for (const [g, p] of dist) for (const o of t.outcomes) {
      if (o.num === 0n) continue;
      next.set(g + o.grid, (next.get(g + o.grid) || 0n) + p * o.num);
    }
    dist = next;
    exp += t.exp;
  }
  return {exp, dist};
}

function sameDistribution(a, b) {
  const e = Math.max(a.exp, b.exp);
  const scale = (d) => new Map([...d.dist].map(([g, p]) => [g, p * pow10(e - d.exp)]));
  const x = scale(a), y = scale(b);
  if (x.size !== y.size) return false;
  for (const [g, p] of x) if (y.get(g) !== p) return false;
  return true;
}

// p の分位点＝累積が p 以上になる最小の値（円）
export function quantileYen({exp, dist}, numer, denom) {
  const total = pow10(exp);
  let cum = 0n;
  for (const g of [...dist.keys()].sort((p, q) => p - q)) {
    cum += dist.get(g);
    if (cum * big(denom) >= total * big(numer)) return g * GRID_YEN;
  }
  throw new Error('分位点が見つかりません');
}

// 目標以上になる確率（bp、half_up）と、その正確な分子（10^exp が分母）
export function reachExact({exp, dist}, targetYen) {
  let hit = 0n;
  for (const [g, p] of dist) if (big(g) * GRID >= big(targetYen)) hit += p;
  return {hit, exp};
}
export const reachBps = (d, targetYen) => num(halfUp(reachExact(d, targetYen).hit * TEN4, pow10(d.exp)));

// 分布の点（段A の golden の distribution.points と同じ形: [円, 確率の小数]）
const toFloat = (p, exp) => Number((p * 10n ** 20n) / pow10(exp)) / 1e20;
export const distributionPoints = (d) => [...d.dist.entries()].sort(([a], [b]) => a - b).map(([g, p]) => [g * GRID_YEN, toFloat(p, d.exp)]);

function cashOf(inputs, rows) {
  const from = mi(inputs.period.from), to = mi(inputs.period.to);
  const nextTo = inputs.period.nextTo === null ? Infinity : mi(inputs.period.nextTo);
  const byMonth = new Map();
  let period = 0, last = 0, edge = 0, next = 0, unscheduled = 0;
  for (const r of rows) {
    if (r.placement === 'before_period') continue;
    if (!r.cashScheduled) { unscheduled++; continue; }
    for (const c of r.cash) {
      const m = mi(c.month);
      if (m > to) { if (m <= nextTo) next += c.inflowYen; continue; }
      if (m < from) continue;
      period += c.inflowYen;
      if (m >= to - 1) last += c.inflowYen;
      if (m === to) edge += c.inflowYen;
      if (c.inflowYen !== 0) byMonth.set(m, (byMonth.get(m) || 0) + c.inflowYen);
    }
  }
  return {byMonth: [...byMonth.entries()].sort(([a], [b]) => a - b).map(([m, yen]) => ({month: ms(m), yen})), periodYen: period, lastTwoMonthsYen: last,
    slipOutYen: edge, nextPeriodYen: next, unscheduledCount: unscheduled};
}

// 1つのシナリオを正確に数える（試験の実行時にも使う）
export function scenarioCore(inputs, {assumptions, actions}, {withDistribution = true, reverseCheck = false} = {}) {
  const rows = itemRows(inputs, assumptions);
  const act = actionRows(actions, assumptions);
  const actualTotal = SOURCES.reduce((n, s) => n + (inputs.actuals[s].actualYen ?? 0), 0);
  const start = snap(actualTotal);
  const bySource = SOURCES.map((source) => {
    const {status, actualYen, actualSalesYen} = inputs.actuals[source];
    const mine = rows.filter((r) => r.placement === 'in_period' && r.source === source);
    const acts = act.filter((r) => r.source === source);
    const forecast = mine.length > 0 || acts.length > 0;
    const weightedYen = sum(mine, (r) => r.weightedYen), actionYen = sum(acts, (r) => r.expectedYen);
    const weightedSalesYen = sum(mine, (r) => r.weightedSalesYen), actionSalesYen = sum(acts, (r) => r.expectedSalesYen);
    return {source, status, actualYen, weightedYen, actionYen, expectedYen: actualYen === null && !forecast ? null : (actualYen ?? 0) + weightedYen + actionYen,
      actualSalesYen, weightedSalesYen, actionSalesYen, expectedSalesYen: actualSalesYen === null && !forecast ? null : (actualSalesYen ?? 0) + weightedSalesYen + actionSalesYen};
  });
  const tot = (key) => bySource.reduce((n, r) => n + (r[key] ?? 0), 0);
  const out = {rows, act, start, bySource, expectedYen: tot('expectedYen'), actualYen: actualTotal, weightedYen: tot('weightedYen'), actionYen: tot('actionYen'),
    expectedSalesYen: tot('expectedSalesYen'), actualSalesYen: tot('actualSalesYen'), weightedSalesYen: tot('weightedSalesYen'), actionSalesYen: tot('actionSalesYen'),
    cash: cashOf(inputs, rows)};
  if (!withDistribution) return out;
  const list = trials(rows, act);
  const dist = convolve(start, list);
  if (reverseCheck && !sameDistribution(dist, convolve(start, [...list].reverse()))) throw new Error('たたみ込みの順で分布が変わりました');
  return {...out, list, dist, withoutActions: convolve(start, trials(rows, []))};
}

export function scenarioAssumptions(inputs, key) {
  const base = {...inputs.assumptions};
  if (key === 'standard') return base;
  if (key === 'custom') return {...base, ...(inputs.custom?.assumptions || {})};
  const out = {...base};
  for (const k of SCENARIO_MOVES) out[k] = clamp(base[k] + RANGES[k][key], RANGES[k].min, RANGES[k].max);
  return out;
}

export function scenarioActions(inputs, key) {
  const base = inputs.actions.map((a) => ({...a}));
  if (key !== 'custom') return base;
  const counts = new Map((inputs.custom?.actions || []).map((a) => [`${a.source}:${a.step}`, a.countX100]));
  return base.map((a) => (counts.has(`${a.source}:${a.step}`) ? {...a, countX100: counts.get(`${a.source}:${a.step}`)} : a));
}

// 分布の平均と整数の期待値の差は「内訳の数 × 5,001円」以内（段A と同じ確かめ）
function checkMean(s, label) {
  const components = 1 + s.list.length;
  let meanNum = 0n;
  for (const [g, p] of s.dist.dist) meanNum += big(g) * GRID * p;
  const diff = meanNum - big(s.expectedYen) * pow10(s.dist.exp);
  if ((diff < 0n ? -diff : diff) > big(components * 5001) * pow10(s.dist.exp)) throw new Error(`${label}: 分布の平均と期待値の差が許す幅を超えました`);
  return components;
}

export function distributionSummary(d) {
  const keys = [...d.dist.keys()].sort((p, q) => p - q);
  const lines = keys.map((g) => `${g * GRID_YEN}:${d.dist.get(g)}`).join('\n');
  return {gridYen: GRID_YEN, exp: d.exp, pointCount: keys.length, minYen: keys[0] * GRID_YEN, maxYen: keys.at(-1) * GRID_YEN, sha256: sha256(`${d.exp}\n${lines}`)};
}

const expectedOnly = (inputs, assumptions, actions) => {
  const s = scenarioCore(inputs, {assumptions, actions}, {withDistribution: false});
  return {expectedYen: s.expectedYen, periodCashYen: s.cash.periodYen};
};

export function tornado(inputs) {
  const base = scenarioAssumptions(inputs, 'standard');
  const actions = scenarioActions(inputs, 'standard');
  const rows = TORNADO_KEYS.map((key) => {
    const at = (side) => {
      const value = clamp(base[key] + RANGES[key][side], RANGES[key].min, RANGES[key].max);
      const r = expectedOnly(inputs, {...base, [key]: value}, actions);
      return {value, expectedYen: r.expectedYen, periodCashYen: r.periodCashYen};
    };
    const pessimistic = at('pessimistic'), optimistic = at('optimistic');
    return {key, pessimistic, optimistic, swingYen: Math.abs(optimistic.expectedYen - pessimistic.expectedYen), cashSwingYen: Math.abs(optimistic.periodCashYen - pessimistic.periodCashYen)};
  });
  rows.sort((a, b) => b.swingYen - a.swingYen || b.cashSwingYen - a.cashSwingYen || byText(a.key, b.key));
  return rows.slice(0, 8);
}

// 申し送り K-e の並び（段A と同じ）: 増分÷時間の大きい順（割らずに掛けて比べる）。時間0は先頭で、時間0どうしは増分の順。
// 同じなら期待値の増分の大きい順、それも同じなら「稼ぎ方:段」の名前の順。増分は整数（Number か BigInt）
export function perHourOrder(delta) {
  const times = (v, h) => (typeof v === 'bigint' ? v * big(h) : Number.isInteger(v) ? big(v) * big(h) : v * h);
  const cmp = (x, y) => (x > y ? -1 : x < y ? 1 : 0);
  return (a, b) => {
    const za = a.hoursX100 === 0, zb = b.hoursX100 === 0;
    if (za && !zb) return -1;
    if (zb && !za) return 1;
    const first = za ? cmp(delta(a), delta(b)) : cmp(times(delta(a), b.hoursX100), times(delta(b), a.hoursX100));
    if (first !== 0) return first;
    const second = cmp(a.expectedDeltaYen, b.expectedDeltaYen);
    if (second !== 0) return second;
    return byText(`${a.source}:${a.step}`, `${b.source}:${b.step}`);
  };
}

// 行動の候補 (1): 行動の件数を1件増やす（段A と同じ）。(2) 段階を進める・(3) 交渉は段B #12（golden に無い）
export function candidateDeltas(inputs, key = 'standard') {
  const assumptions = scenarioAssumptions(inputs, key);
  const actions = scenarioActions(inputs, key);
  const before = expectedOnly(inputs, assumptions, actions).expectedYen;
  const rows = actions.map((a, i) => {
    const more = actions.map((x, j) => (j === i ? {...x, countX100: x.countX100 + 100} : x));
    return {source: a.source, step: a.step, addCountX100: 100, hoursX100: a.hoursX100, expectedDeltaYen: expectedOnly(inputs, assumptions, more).expectedYen - before};
  });
  rows.sort(perHourOrder((r) => r.expectedDeltaYen));
  return rows;
}

// 実行時の目標額で、候補ごとの届く確率の増分（正確な分数）を数え、1時間あたりの増分が最大の候補を返す（見直しの提案の1つ目。K2-9）。
// 行動を1件足すと分布の指数（分母 10^exp）が候補ごとに違う（面談は2段の率で +8、提案は1段で +4）ので、増分の分子は before と全候補の exp の
// 最大 E にそろえてから比べる（分母が違う分子をそのまま掛けて比べると、exp の大きい候補が 10^差 倍有利になる）
export function probabilityPick(inputs, targetYen, key = 'standard') {
  const assumptions = scenarioAssumptions(inputs, key);
  const actions = scenarioActions(inputs, key);
  const before = scenarioCore(inputs, {assumptions, actions});
  const b = reachExact(before.dist, targetYen);
  const afters = actions.map((a, i) => {
    const more = actions.map((x, j) => (j === i ? {...x, countX100: x.countX100 + 100} : x));
    const after = scenarioCore(inputs, {assumptions, actions: more});
    return {a, after, r: reachExact(after.dist, targetYen)};
  });
  const E = Math.max(b.exp, ...afters.map(({r}) => r.exp));
  const rows = afters.map(({a, after, r}) => ({source: a.source, step: a.step, hoursX100: a.hoursX100, expectedDeltaYen: after.expectedYen - before.expectedYen,
    reachBeforeBps: reachBps(before.dist, targetYen), reachAfterBps: reachBps(after.dist, targetYen),
    deltaExact: r.hit * pow10(E - r.exp) - b.hit * pow10(E - b.exp)}));
  rows.sort(perHourOrder((r) => r.deltaExact));
  return rows.map(({deltaExact, ...r}) => r);
}

// 4費目（出資額2つ・買付の MG・買い切りの買付額）を引かない場合の入力（回収待ちの見え方。FR-REV-KPI-007・044）: 案件の4費目の出金を0にし、
// 実績を4費目を引かない粗利にする
export function withoutFourItemsInputs(inputs) {
  if (!inputs.actualsWithoutFourItems) throw new Error('4費目を引かない実績が入力に無い');
  const zero = (p) => ({...p, deductionYen: 0});
  return {...inputs, actuals: inputs.actualsWithoutFourItems, items: inputs.items.map((it) => ({...it, inPeriod: zero(it.inPeriod), nextPeriod: zero(it.nextPeriod)}))};
}

function scenarioGolden(inputs, key) {
  const assumptions = scenarioAssumptions(inputs, key);
  const actions = scenarioActions(inputs, key);
  const s = scenarioCore(inputs, {assumptions, actions}, {reverseCheck: true});
  const componentCount = checkMean(s, key);
  let withoutFour = null;
  if (inputs.actualsWithoutFourItems) {
    const w = scenarioCore(withoutFourItemsInputs(inputs), {assumptions, actions});
    checkMean(w, `${key}（4費目を引かない）`);
    withoutFour = {expectedYen: w.expectedYen, actualYen: w.actualYen, weightedYen: w.weightedYen, actionYen: w.actionYen,
      distribution: distributionSummary(w.dist), quantiles: {p10Yen: quantileYen(w.dist, 1, 10), p50Yen: quantileYen(w.dist, 1, 2), p90Yen: quantileYen(w.dist, 9, 10)}};
  }
  return {
    assumptions, actions: actions.map((a) => ({source: a.source, step: a.step, countX100: a.countX100})),
    expectedYen: s.expectedYen, actualYen: s.actualYen, weightedYen: s.weightedYen, actionYen: s.actionYen,
    actualPlusWeightedYen: s.bySource.reduce((n, r) => n + (r.actualYen ?? 0) + r.weightedYen, 0),
    expectedSalesYen: s.expectedSalesYen, actualSalesYen: s.actualSalesYen, weightedSalesYen: s.weightedSalesYen, actionSalesYen: s.actionSalesYen,
    actualPlusWeightedSalesYen: s.bySource.reduce((n, r) => n + (r.actualSalesYen ?? 0) + r.weightedSalesYen, 0),
    bySource: s.bySource,
    projects: s.rows.map((r) => ({projectCode: r.key, source: r.source, placement: r.placement, probabilityBps: r.probabilityBps, valueYen: r.valueYen,
      weightedYen: r.weightedYen, salesValueYen: r.salesValueYen, weightedSalesYen: r.weightedSalesYen,
      nextPeriodValueYen: r.nextPeriodValueYen, nextPeriodWeightedYen: r.nextPeriodWeightedYen,
      periodInflowYen: r.cash.filter((c) => mi(c.month) >= mi(inputs.period.from) && mi(c.month) <= mi(inputs.period.to)).reduce((n, c) => n + c.inflowYen, 0)})),
    actionRows: s.act.map(({pNum, pExp, ...r}) => r),
    nextPeriodProfitYen: s.rows.reduce((n, r) => n + r.nextPeriodWeightedYen, 0),
    componentCount,
    distribution: distributionSummary(s.dist),
    quantiles: {p10Yen: quantileYen(s.dist, 1, 10), p50Yen: quantileYen(s.dist, 1, 2), p90Yen: quantileYen(s.dist, 9, 10)},
    quantilesWithoutActions: {p10Yen: quantileYen(s.withoutActions, 1, 10), p50Yen: quantileYen(s.withoutActions, 1, 2), p90Yen: quantileYen(s.withoutActions, 9, 10)},
    cash: s.cash,
    withoutFourItems: withoutFour,
  };
}

// 段A の golden（test/fixtures/scenario/ の compare-request.json と expected.json）を、この計算の入力の形にする（段A と食い違わないことの試験に使う）。
// 商談の残りの額・置き場・入金の月（遅れ0）は段A の golden の標準の行から読み、段A の会社の売上の決まり（買付は窓口の売上の総額）を salesConversionBps: null で写す
export function inputsFromStageA(fixture, golden) {
  const {request} = fixture;
  const spec = new Map(request.opportunities.map((o) => [o.id, o]));
  const zero = {revenueBaseYen: 0, deductionYen: 0};
  const items = golden.scenarios.standard.opportunities.filter((r) => r.placement !== 'before_period').map((r) => {
    const conv = spec.get(r.opportunityId).conversionBps;
    const part = {revenueBaseYen: r.remainingYen, deductionYen: 0};
    return {key: r.opportunityId, source: r.source, probabilityBps: r.probabilityBps, conversionBps: conv, salesConversionBps: r.source === 'acquisition' ? null : conv,
      placement: r.placement, cashScheduled: r.paymentMonth !== null, inPeriod: r.placement === 'in_period' ? part : zero, nextPeriod: r.placement === 'after_period' ? part : zero,
      cash: r.paymentMonth === null ? [] : [{month: r.paymentMonth, baseYen: r.remainingYen}]};
  });
  const actions = request.actions.map((a) => {
    const conv = a.conversionBps ?? 10000;
    return {source: a.source, step: a.step, countX100: a.countX100, dealYen: a.dealYen, conversionBps: conv, salesConversionBps: a.source === 'acquisition' ? null : conv, hoursX100: a.hoursX100};
  });
  return {period: {from: request.period.from, to: request.period.to, nextTo: null}, assumptions: {...request.assumptions},
    actuals: Object.fromEntries(golden.sources.map((s) => [s.source, {status: s.status, actualYen: s.actualYen, actualSalesYen: s.actualSalesYen}])),
    items, actions, custom: request.custom ?? null};
}

// =====================================================================================================
// 段B の種から入力を作る
// =====================================================================================================
const EARNING = {買付: 'acquisition', 販売委託: 'consignment', 自社出資: 'own_investment', 製作委員会: 'committee', 制作受託: 'contract_work'};
const TOP_STEP = {面談: 'meeting', 提案: 'proposal', 契約: 'contract'};
// 役（指標マスタの役のコード）と、行動の時間を連ねる役（仕入れ・企画の側。売り側の時間は実行の時間に入る。申し送り §行動の表）
const PRODUCING_ROLE = {contract_work: 'producer', own_investment: 'producer', committee: 'producer', acquisition: 'sales_sourcing', consignment: 'sales_sourcing'};
// J-11b (a) の4費目（フェーズ1 K-16 の費目の名前）と、予測の行で4費目に当たる区分
const FOUR_ITEMS = ['自社出資の出資額', '製作委員会の出資額（自社の分）', '買付の MG', '買い切りの買付額'];
const DEDUCTION_KUBUN = ['出資', '買付'];
// 予測の行で粗利に入れない区分と理由
const NOT_COUNTED_KUBUN = {
  制作の実費: 'J-14 (a): 受託は受託費の純額で、制作の実費は粗利に入れない',
  '作り手・権利元への分配': 'J-11a (b)・J-9 (c): 売上率を掛けた純額で数えるので、権利元へ渡る分は会社の売上と粗利に入れない',
  クラウドファンディングの支援金: 'U-5 の残り（クラファンの支援金）。売上に数えない入金で、決まるまで粗利に入れない',
  クラウドファンディングの費用: 'U-5 の残り（クラファンの支援金）。支援金と同じく決まるまで粗利に入れない',
};

export function loadSeeds() {
  const read = (path) => {
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    return {text, json: JSON.parse(text)};
  };
  return {seed: read(SEED_PATH), kpiSeed: read(KPI_SEED_PATH), metrics: read(METRICS_SEED_PATH), invoices: read(INVOICES_PATH), p1: read(P1_EXPECTED_PATH)};
}

function periodOf(seed) {
  const closed = ym(seed.設定.締めた月);
  const periods = seed.設定.期間;
  const i = periods.findIndex((p) => ym(p.始め) <= closed && closed <= ym(p.終わり));
  if (i < 0) throw new Error('締めた月を含む期間がありません');
  const p = periods[i], n = periods[i + 1] ?? null;
  return {name: p.期間, from: ym(p.始め), to: ym(p.終わり), nextFrom: n ? ym(n.始め) : null, nextTo: n ? ym(n.終わり) : null, closedMonth: closed, asOf: seed.as_of};
}

// ---------- フェーズ1 K-16 の利益額の明細（golden.py の profit_details と同じ規則をここで別に書く） ----------
const K16_ITEMS = {
  売上: ['売上', '確定'], '売上（源泉のある取引先）': ['売上', '未確定'], '売上（作品の無い案件）': ['売上', '未確定'],
  自社出資の出資額: ['経費', '確定'], '製作委員会の出資額（自社の分）': ['経費', '確定'], '買付の MG': ['経費', '確定'], 買い切りの買付額: ['経費', '確定'],
  '宣伝費（負担者 自社）': ['経費', '確定'], '配給費（負担者 自社）': ['経費', '未確定'], '宣伝費（負担者 自社以外）': ['経費', '未確定'],
  '配給費（負担者 自社以外）': ['経費', '未確定'], '費用区分「制作費」の経費': ['経費', '未確定'], 制作の実費: ['経費', '除外'],
  '出資の実績の行（出資の記録の払込と同じ）': ['経費', '除外'],
};
const K16_ORDER = Object.keys(K16_ITEMS);
const rateAmount = (amount, bps) => num(trunc(big(amount) * big(bps), TEN4));

export function k16Details(seed, invoices) {
  const proj = new Map(seed.案件.map((p) => [p.案件コード, p]));
  const kubun = new Map(seed.vocabulary.kubun.map((k) => [k.name, k]));
  const withWork = new Set(seed.works.map((w) => w.project_code));
  const workProject = new Map(seed.works.map((w) => [w.work_id, w.project_code]));
  const projectOfWorkCode = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  const withholding = new Set(invoices.contracts.filter((c) => c.foreign_withholding_bps).map((c) => c.partner_code));
  const invoicePartner = new Map(invoices.invoices.map((v) => [v.invoice_number, v.partner_code]));
  const raw = new Map();
  const unknown = new Map();
  const add = (basis, month, code, item, amount) => {
    if (!Object.hasOwn(K16_ITEMS, item)) throw new Error(`費目が決まっていない: ${item}`);
    const key = JSON.stringify([basis, month, code, item]);
    raw.set(key, (raw.get(key) || 0) + amount);
  };
  const saleItem = (code, partner) => (withholding.has(partner) ? '売上（源泉のある取引先）' : withWork.has(code) ? '売上' : '売上（作品の無い案件）');
  const payments = new Set(seed.investments.flatMap((x) => x.payments.map((p) => JSON.stringify([projectOfWorkCode.get(x.work_code), p.paid_on, p.amount_yen]))));
  for (const r of seed.実績) {
    const k = kubun.get(r.区分);
    if (!k) throw new Error(`実績の区分が無い: ${r.実績ID}`);
    const code = r.案件コード, month = ym(r.日付), amount = r['金額（円・税別）'];
    if (k.direction === '入金') {
      if (k.sales_source !== 'はい') throw new Error(`売上に数えない入金の扱いは U-5 の残り: ${r.実績ID}`);
      if (!code || !proj.has(code)) { unknown.set(`cash|${month}`, (unknown.get(`cash|${month}`) || 0) + amount); continue; }
      add('cash', month, code, saleItem(code, invoicePartner.get(r.invoice_number)), amount);
    } else if (r.区分 === '出資') {
      if (!payments.has(JSON.stringify([code, r.日付, amount]))) throw new Error(`出資の実績の行が出資の記録の払込に無い: ${r.実績ID}`);
      for (const basis of ['cash', 'accrual']) add(basis, month, code, '出資の実績の行（出資の記録の払込と同じ）', amount);
    } else if (r.区分 === '買付') {
      for (const basis of ['cash', 'accrual']) add(basis, month, code, r.項目.includes('MG') ? '買付の MG' : '買い切りの買付額', amount);
    } else if (r.区分 === '制作の実費') {
      for (const basis of ['cash', 'accrual']) add(basis, month, code, '制作の実費', amount);
    } else {
      throw new Error(`扱いを決めていない出金の区分: ${r.実績ID}`);
    }
  }
  for (const v of invoices.invoices) for (const line of v.lines) {
    const code = workProject.get(line.work_id);
    if (!code || !proj.has(code)) { unknown.set(`accrual|${line.accounting_month}`, (unknown.get(`accrual|${line.accounting_month}`) || 0) + line.amount_ex_tax); continue; }
    add('accrual', line.accounting_month, code, saleItem(code, v.partner_code), line.amount_ex_tax);
  }
  for (const x of seed.investments) {
    const code = projectOfWorkCode.get(x.work_code);
    if (!['自社出資', '製作委員会'].includes(x.kind) || x.tax_basis !== '税抜') throw new Error(`出資の記録の種類か税の基準が想定と違う: ${x.investment_id}`);
    const item = x.kind === '自社出資' ? '自社出資の出資額' : '製作委員会の出資額（自社の分）';
    for (const p of x.payments) if (p.paid_on <= seed.as_of) for (const basis of ['cash', 'accrual']) add(basis, ym(p.paid_on), code, item, p.amount_yen);
  }
  for (const x of seed.expenses) {
    let item;
    if (x.category === '制作費') item = '費用区分「制作費」の経費';
    else if (x.category === '宣伝費' || x.category === '配給費') item = `${x.category}（負担者 ${x.bearer === '自社' ? '自社' : '自社以外'}）`;
    else throw new Error(`扱いを決めていない費用区分: ${x.expense_id}`);
    add('accrual', ym(x.accounting_month), x.project_code, item, x.amount_ex_tax);
    if (x.paid_on && x.paid_on <= seed.as_of) add('cash', ym(x.paid_on), x.project_code, item, x.amount_ex_tax);
  }
  const details = [...raw.entries()].map(([key, amount]) => {
    const [basis, month, code, item] = JSON.parse(key);
    const [side, status] = K16_ITEMS[item];
    const row = {基準: basis, 月: month, 案件コード: code, 稼ぎ方: proj.get(code).稼ぎ方, 費目: item, 向き: side, 状態: status, 税別の額: amount};
    if (side === '売上') {
      row.売上率bps = proj.get(code).rate_bps;
      row.額 = rateAmount(amount, row.売上率bps);
    } else {
      row.額 = amount;
    }
    return row;
  });
  details.sort((a, b) => byText(a.基準, b.基準) || byText(a.月, b.月) || byText(a.案件コード, b.案件コード) || K16_ORDER.indexOf(a.費目) - K16_ORDER.indexOf(b.費目));
  return {details, unknown};
}

// フェーズ1 の golden（expected.json の利益額.明細）と、ここで作った明細が同じことを確かめる（源泉別の合計が P1 #14b と一致する前提）
function checkAgainstP1(details, p1) {
  const mine = JSON.stringify(details);
  const theirs = JSON.stringify(p1.利益額.明細);
  if (mine !== theirs) throw new Error('K-16 の明細がフェーズ1 の golden（expected.json の利益額.明細）と違います');
}

function inPeriodMonth(month, period) {
  return mi(month) >= mi(period.from) && mi(month) <= mi(period.closedMonth);
}

// ---------- 源泉別の実績（期間の始まり〜締めた月） ----------
function sourceProfit(details, unknown, seed, kpiSeed, period) {
  const contractProjects = new Set(seed.案件.filter((p) => p.稼ぎ方 === '制作受託').map((p) => p.案件コード));
  const connectedContractWork = kpiSeed.contractVersions.some((v) => contractProjects.has(v.projectCode));
  const out = {};
  for (const basis of ['cash', 'accrual']) {
    const rows = details.filter((d) => d.基準 === basis && inPeriodMonth(d.月, period));
    const bySource = SOURCES.map((source) => {
      if (source === 'contract_work' && !connectedContractWork) {
        return {source, status: 'unconnected', salesYen: null, costYen: null, profitYen: null, fourItemsYen: null, profitWithoutFourItemsYen: null, unconfirmed: [], excluded: []};
      }
      const mine = rows.filter((d) => EARNING[d.稼ぎ方] === source);
      const fixed = mine.filter((d) => d.状態 === '確定');
      const salesYen = sum(fixed.filter((d) => d.向き === '売上'), (d) => d.額);
      const costYen = sum(fixed.filter((d) => d.向き === '経費'), (d) => d.額);
      const fourItemsYen = sum(fixed.filter((d) => FOUR_ITEMS.includes(d.費目)), (d) => d.額);
      const groups = (status) => K16_ORDER.filter((item) => mine.some((d) => d.状態 === status && d.費目 === item))
        .map((item) => ({item, side: K16_ITEMS[item][0], amountYen: sum(mine.filter((d) => d.状態 === status && d.費目 === item), (d) => d.額)}));
      return {source, status: 'connected', salesYen, costYen, profitYen: salesYen - costYen, fourItemsYen, profitWithoutFourItemsYen: salesYen - costYen + fourItemsYen,
        unconfirmed: groups('未確定'), excluded: groups('除外')};
    });
    const total = (key) => (bySource.every((r) => r[key] === null) ? null : sum(bySource, (r) => r[key] ?? 0));
    const unattributedYen = [...unknown.entries()].filter(([k]) => k.startsWith(`${basis}|`) && inPeriodMonth(k.slice(basis.length + 1), period)).reduce((n, [, v]) => n + v, 0);
    out[basis] = {bySource, total: {salesYen: total('salesYen'), costYen: total('costYen'), profitYen: total('profitYen'), fourItemsYen: total('fourItemsYen'),
      profitWithoutFourItemsYen: total('profitWithoutFourItemsYen')}, unattributedYen};
  }
  return out;
}

// フェーズ1 の golden の月別の利益額（確定）の、期間の始まり〜締めた月の和（源泉別の合計と照らす）
function p1PeriodProfit(p1, basis, period) {
  const months = p1.利益額.月;
  const fixed = p1.利益額.基準[basis].確定;
  return months.reduce((n, m, i) => (inPeriodMonth(m, period) ? n + fixed.利益額[i] : n), 0);
}

// ---------- 出資者が複数の製作委員会 ----------
function committees(seed, kpiSeed, details, period) {
  const projectOfWork = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  const cashSales = (code, inPeriod) => sum(details.filter((d) => d.基準 === 'cash' && d.案件コード === code && d.費目 === '売上' && d.状態 === '確定'
    && mi(d.月) <= mi(period.closedMonth) && (!inPeriod || inPeriodMonth(d.月, period))), (d) => d.額);
  const out = [];
  for (const p of seed.案件.filter((x) => x.稼ぎ方 === '製作委員会').sort((a, b) => byText(a.案件コード, b.案件コード))) {
    const invs = seed.investments.filter((x) => x.kind === '製作委員会' && projectOfWork.get(x.work_code) === p.案件コード)
      .sort((a, b) => byText(a.investment_id, b.investment_id));
    if (!invs.length) {
      out.push({projectCode: p.案件コード, investments: [], ownInvestmentYen: null, note: 'no_investment_record'});
      continue;
    }
    const inPeriodDate = (d) => inPeriodMonth(ym(d), period);
    const investments = invs.map((x) => {
      const others = x.members.filter((m) => m.name !== '自社');
      const memberPay = kpiSeed.memberPayments.filter((m) => m.investmentId === x.investment_id);
      const own = x.payments;
      return {investmentId: x.investment_id, workCode: x.work_code, memberCount: x.members.length, totalInvestmentYen: x.total_yen, ownInvestmentYen: x.own_yen,
        ownRatioBps: x.own_ratio_bps,
        ownPaidTotalYen: sum(own.filter((q) => q.paid_on <= seed.as_of), (q) => q.amount_yen),
        ownPaidPeriodYen: sum(own.filter((q) => q.paid_on <= seed.as_of && inPeriodDate(q.paid_on)), (q) => q.amount_yen),
        ownScheduledPeriodYen: sum(own.filter((q) => q.paid_on > seed.as_of && mi(ym(q.paid_on)) <= mi(period.to)), (q) => q.amount_yen),
        otherMembers: others.map((m) => {
          const pays = memberPay.filter((q) => q.member === m.name);
          return {member: m.name, investmentYen: m.amount_yen, paidTotalYen: sum(pays.filter((q) => q.paidOn <= seed.as_of), (q) => q.amountYen),
            paidPeriodYen: sum(pays.filter((q) => q.paidOn <= seed.as_of && inPeriodDate(q.paidOn)), (q) => q.amountYen),
            scheduledPeriodYen: sum(pays.filter((q) => q.paidOn > seed.as_of && mi(ym(q.paidOn)) <= mi(period.to)), (q) => q.amountYen), counted: false};
        }),
      };
    });
    const ownPaidPeriodYen = sum(investments, (x) => x.ownPaidPeriodYen);
    const acquisitionsPeriodYen = cashSales(p.案件コード, true);
    out.push({projectCode: p.案件コード, ownRatioBps: p.rate_bps, investments,
      ownPaidTotalYen: sum(investments, (x) => x.ownPaidTotalYen), ownPaidPeriodYen,
      otherMembersPaidPeriodYen: sum(investments, (x) => sum(x.otherMembers, (m) => m.paidPeriodYen)),
      acquisitionsTotalYen: cashSales(p.案件コード, false), acquisitionsPeriodYen,
      acquisitionsMinusOwnPaidPeriodYen: acquisitionsPeriodYen - ownPaidPeriodYen});
  }
  return out;
}

// ---------- 設定（フェーズ1 #23a の行動の行を先に入れて残し、段B #9 の設定の行の同じ変数×範囲は入らない） ----------
function effectiveSettings(seed, metrics) {
  const rows = [];
  const key = (r) => [r.variableKey, r.scope, r.earningType ?? '', r.step ?? ''].join('|');
  const seen = new Set();
  const push = (r, origin) => {
    if (seen.has(key(r))) return false;
    seen.add(key(r));
    rows.push({...r, origin});
    return true;
  };
  const ratio = (v) => {
    const [whole, fraction = ''] = String(v).split('.');
    if (!/^\d+$/.test(whole) || !/^\d{0,4}$/.test(fraction)) throw new Error(`率 ${v} は bp で表せない`);
    return Number(whole) * 10000 + Number(fraction.padEnd(4, '0'));
  };
  for (const r of seed.行動) {
    const earningType = EARNING[r.稼ぎ方];
    push({variableKey: 'unit_amount', scope: 'earning_type', earningType, value: {kind: 'yen', value: r['1件あたりの額（円・税別）']}}, 'yojitsu');
    push({variableKey: 'conversion_rate', scope: 'earning_type_step', earningType, step: 'meeting', value: {kind: 'bps', value: ratio(r['面談→提案の率'])}}, 'yojitsu');
    push({variableKey: 'conversion_rate', scope: 'earning_type_step', earningType, step: 'proposal', value: {kind: 'bps', value: ratio(r['提案→契約の率'])}}, 'yojitsu');
  }
  const skipped = [];
  for (const s of metrics.settings) {
    const r = {variableKey: s.variableKey, scope: s.scope, earningType: s.earningType, step: s.step, value: s.value};
    if (!push(r, 'kpi-metrics')) {
      const kept = rows.find((x) => key(x) === key(r));
      skipped.push({variableKey: s.variableKey, scope: s.scope, earningType: s.earningType ?? null, step: s.step ?? null,
        sameValue: kept.value.kind === s.value.kind && kept.value.value === s.value.value});
    }
  }
  const get = (variableKey, scope, earningType = undefined, step = undefined) =>
    rows.find((r) => r.variableKey === variableKey && r.scope === scope && r.earningType === earningType && r.step === step)?.value.value ?? null;
  return {rows, skipped, get};
}

// 稼ぎ方ごとに同じ値でなければ止める（段A の前提は稼ぎ方に共通の1つ。稼ぎ方ごとに違う値の効きの動かし方は段B #12）
function oneValue(values, label) {
  const set = new Set(values);
  if (set.size !== 1 || values.includes(null)) throw new Error(`${label} が稼ぎ方ごとに違うか、無い`);
  return values[0];
}

function standardAssumptions(settings) {
  const mult = [settings.get('sales_multiplier', 'all')];
  for (const e of ['acquisition', 'consignment']) { const v = settings.get('sales_multiplier', 'earning_type', e); if (v !== null) mult.push(v); }
  return {
    salesMultiplierBps: oneValue(mult, '窓口の売上の倍率'),
    recoveryAmountBps: oneValue(['own_investment', 'committee'].map((e) => settings.get('recovery_amount', 'earning_type', e)), '回収の量'),
    meetingToProposalBps: oneValue(SOURCES.map((e) => settings.get('conversion_rate', 'earning_type_step', e, 'meeting')), '面談→提案の率'),
    proposalToContractBps: oneValue(SOURCES.map((e) => settings.get('conversion_rate', 'earning_type_step', e, 'proposal')), '提案→契約の率'),
    paymentDelayMonths: oneValue([settings.get('payment_delay', 'all')], '入金の遅れ'),
  };
}

// 行動1件の時間（x100）: 指標マスタの仕入れ・企画の側の段の並びで、最初の段からその段（集計のステップに畳む最後の段）まで、
// 段の1件の時間を次の段へ進む率の逆数で連ねた和（申し送り §行動の表「受託の提案1件＝企画メモ4件×4時間＋予算割と見積2件×8時間＋提案8時間」）。
// 正確な分数で足してから1回だけ truncate（端数は要件の要確認10 まで truncate を仮に使う）
function chainedHoursX100(metrics, settings, earningType, topStep) {
  const role = PRODUCING_ROLE[earningType];
  const chain = metrics.metricMaster.chains.find((c) => c.role === role && c.earningType === earningType);
  if (!chain) throw new Error(`指標マスタに ${role}×${earningType} が無い`);
  const parent = new Map(metrics.steps.map((s) => [s.code, s.parent]));
  const fold = (code) => (TOP_STEP_CODES.includes(code) ? code : parent.get(code));
  const codes = chain.steps.map((s) => s.step);
  const k = codes.map(fold).lastIndexOf(topStep);
  if (k < 0) throw new Error(`${earningType} の段の並びに ${topStep} に畳む段が無い`);
  const hours = codes.map((c) => settings.get('step_hours', 'earning_type_step', earningType, c));
  const rates = codes.map((c) => settings.get('conversion_rate', 'earning_type_step', earningType, c));
  let denom = 1n;
  for (let i = 0; i < k; i++) denom *= big(rates[i]);
  let numer = 0n;
  for (let j = 0; j <= k; j++) {
    if (hours[j] === null) throw new Error(`${earningType} の段 ${codes[j]} の1件の時間が無い`);
    let t = big(hours[j]) * TEN4 ** big(k - j);
    for (let i = 0; i < j; i++) t *= big(rates[i]);
    numer += t;
  }
  return num(trunc(numer, denom));
}
const TOP_STEP_CODES = Object.values(TOP_STEP);

// ---------- 予測の行（案件の最新の版で、採用シナリオか単一のシナリオの行） ----------
function forecastRowsOf(seed, code) {
  const rows = seed.予測.filter((r) => r.案件コード === code);
  if (!rows.length) return {versionLabel: null, rows: []};
  const versions = [...new Set(rows.map((r) => `${r.作った日}|${r.版}`))].sort(byText);
  const latest = versions.at(-1);
  const mine = rows.filter((r) => `${r.作った日}|${r.版}` === latest);
  if (mine.some((r) => r.予測に使う !== 'はい') || rows.some((r) => `${r.作った日}|${r.版}` !== latest && r.予測に使う === 'はい')) {
    throw new Error(`${code}: 最新の版と「予測に使う」の印が食い違う`);
  }
  const adopted = seed.設定.採用シナリオ;
  return {versionLabel: latest.split('|')[1], versionCreatedOn: latest.split('|')[0], rows: mine.filter((r) => r.シナリオ === adopted || r.シナリオ === '単一')};
}

// 受託制作の契約の版（延長の種）と、予測の受託収益の行（入金の月と額）が同じことを確かめる（源泉1を予測の行で数えるため）
function checkContractVersions(seed, kpiSeed) {
  const proj = new Map(seed.案件.map((p) => [p.案件コード, p]));
  for (const v of kpiSeed.contractVersions) {
    const p = proj.get(v.projectCode);
    if (!p || p.稼ぎ方 !== '制作受託' || p.段階 !== '契約済み') throw new Error(`${v.projectCode}: 契約済みの制作受託の案件でない`);
    if (v.budgetYen !== p['基準額（円・税別）'] || v.markupBps !== p.rate_bps) throw new Error(`${v.projectCode}: 総製作費か受託費率が案件と違う`);
    if (sum(v.milestones, (m) => m.shareBps) !== 10000) throw new Error(`${v.projectCode}: 節目の割合の和が100%でない`);
    const rows = forecastRowsOf(seed, v.projectCode).rows.filter((r) => r.区分 === '受託収益');
    const want = v.milestones.map((m) => [ym(m.dueOn), num(trunc(big(v.budgetYen) * big(m.shareBps), TEN4))]);
    const got = rows.map((r) => [ym(r.月), r['金額（円・税別）']]).sort((a, b) => byText(a[0], b[0]));
    if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error(`${v.projectCode}: 契約の版の節目と予測の受託収益の行が違う`);
  }
}

function stageInputs(seed, kpiSeed, settings, metrics, details, period) {
  const kubun = new Map(seed.vocabulary.kubun.map((k) => [k.name, k]));
  const stageProb = Object.fromEntries(seed.vocabulary.stages.map((s) => [s.name, s.probability_bps]));
  const actualOf = (code) => {
    const fixed = details.filter((d) => d.基準 === 'cash' && d.案件コード === code && d.状態 === '確定' && inPeriodMonth(d.月, period));
    const salesYen = sum(fixed.filter((d) => d.向き === '売上'), (d) => d.額);
    return {profitYen: salesYen - sum(fixed.filter((d) => d.向き === '経費'), (d) => d.額), salesYen};
  };
  const closed = mi(period.closedMonth), to = mi(period.to), nextTo = period.nextTo === null ? Infinity : mi(period.nextTo);
  const items = [];
  const excluded = [];
  const projects = [];
  // 期間内の予測の「出資」区分の出金（予定の払込）。出資の回収の期末の見込みで、自社出資の残りの期待値に足し戻す
  const investmentDeductions = new Map();
  for (const p of [...seed.案件].sort((a, b) => byText(a.案件コード, b.案件コード))) {
    const source = EARNING[p.稼ぎ方];
    const probabilityBps = stageProb[p.段階];
    if (probabilityBps === undefined) throw new Error(`${p.案件コード}: 段階 ${p.段階} の確度が無い`);
    const {versionLabel, versionCreatedOn, rows} = forecastRowsOf(seed, p.案件コード);
    const part = (lo, hi) => {
      const inside = rows.filter((r) => mi(ym(r.月)) > lo && mi(ym(r.月)) <= hi);
      const notCounted = {};
      for (const r of inside) if (Object.hasOwn(NOT_COUNTED_KUBUN, r.区分)) notCounted[r.区分] = (notCounted[r.区分] || 0) + r['金額（円・税別）'];
      for (const r of inside) {
        const k = kubun.get(r.区分);
        if (!k) throw new Error(`${p.案件コード}: 予測の区分 ${r.区分} が区分マスタに無い`);
        const revenue = k.direction === '入金' && k.sales_source === 'はい';
        if (!revenue && !DEDUCTION_KUBUN.includes(r.区分) && !Object.hasOwn(NOT_COUNTED_KUBUN, r.区分)) throw new Error(`${p.案件コード}: 予測の区分 ${r.区分} の粗利での扱いを決めていない`);
      }
      return {rows: inside, revenueBaseYen: sum(inside.filter((r) => kubun.get(r.区分).direction === '入金' && kubun.get(r.区分).sales_source === 'はい'), (r) => r['金額（円・税別）']),
        deductionYen: sum(inside.filter((r) => DEDUCTION_KUBUN.includes(r.区分)), (r) => r['金額（円・税別）']),
        investmentDeductionYen: sum(inside.filter((r) => r.区分 === '出資'), (r) => r['金額（円・税別）']), notCounted};
    };
    const inP = part(closed, to);
    const next = part(to, nextTo);
    if (inP.investmentDeductionYen) investmentDeductions.set(p.案件コード, inP.investmentDeductionYen);
    const actual = actualOf(p.案件コード);
    const base = {projectCode: p.案件コード, earningType: p.稼ぎ方, source, stage: p.段階, probabilityBps, rateBps: p.rate_bps, rateStatus: p.rate_status,
      forecastVersion: versionLabel, forecastCreatedOn: versionCreatedOn ?? null, actualProfitYen: actual.profitYen, actualSalesYen: actual.salesYen};
    let reason = null;
    if (p.段階 === '見送り') reason = 'declined';
    else if (!inP.rows.length && !next.rows.length) reason = 'no_forecast';
    if (reason) {
      excluded.push({projectCode: p.案件コード, source, reason});
      projects.push({...base, excludedReason: reason, revenueBaseYen: null, deductionYen: null, notCountedYen: null});
      continue;
    }
    const cashRows = new Map();
    for (const r of [...inP.rows, ...next.rows]) {
      const k = kubun.get(r.区分);
      if (k.direction !== '入金' || k.sales_source !== 'はい') continue;
      cashRows.set(ym(r.月), (cashRows.get(ym(r.月)) || 0) + r['金額（円・税別）']);
    }
    items.push({key: p.案件コード, source, probabilityBps, conversionBps: p.rate_bps, salesConversionBps: p.rate_bps,
      placement: inP.rows.length ? 'in_period' : 'after_period', cashScheduled: true,
      inPeriod: {revenueBaseYen: inP.revenueBaseYen, deductionYen: inP.deductionYen}, nextPeriod: {revenueBaseYen: next.revenueBaseYen, deductionYen: next.deductionYen},
      cash: [...cashRows.entries()].sort(([a], [b]) => byText(a, b)).map(([month, baseYen]) => ({month, baseYen}))});
    projects.push({...base, excludedReason: null, revenueBaseYen: inP.revenueBaseYen, deductionYen: inP.deductionYen,
      notCountedYen: Object.keys(inP.notCounted).length ? inP.notCounted : null});
  }
  // 行動（延長の種の行動の計画。締めた月の次の月〜期間の終わりの件数を、稼ぎ方×段で足す）
  const defaults = new Map(seed.vocabulary.earning_types.map((e) => [EARNING[e.name], e.default_sales_rate_bps]));
  const groups = new Map();
  for (const a of kpiSeed.actionPlan) {
    const m = mi(ym(a.month));
    if (m <= closed || m > to) continue;
    const key = `${EARNING[a.earningType]}|${TOP_STEP[a.step]}`;
    groups.set(key, (groups.get(key) || 0) + a.countX100);
  }
  const actions = [...groups.entries()].map(([key, countX100]) => {
    const [source, step] = key.split('|');
    const dealYen = settings.get('unit_amount', 'earning_type', source);
    if (dealYen === null) throw new Error(`${source} の1件の額が無い`);
    return {source, step, countX100, dealYen, conversionBps: defaults.get(source), salesConversionBps: defaults.get(source), hoursX100: chainedHoursX100(metrics, settings, source, step)};
  });
  return {stageProbabilityBps: stageProb, items, excluded, projects, actions, investmentDeductions};
}

// ---------- 出資の回収（FR-REV-YOJITSU-030・FR-REV-KPI-049 と同じ形。シナリオごと） ----------
// 出資額は FR-REV-YOJITSU-030 のとおり、自社出資＝出資の記録の自社の出資額（版の出資額。予定の払込を含む）、製作委員会＝種の時点までの自社の払込の累計。
// 期末の見込みの差額＝差額＋残りの期待値。残りの期待値は、製作委員会は案件の確度加重（予測の「出資」区分の予定の払込を引いたあと）のまま、
// 自社出資は出資額が予定の払込を含むので、予測の「出資」区分の出金を足し戻してから確度を掛ける（trunc((見込＋予定の払込)×確度÷10000)。同じ払込を2回引かない）。
// investmentDeductions: 案件コード → 期間内の予測の「出資」区分の出金
function investmentRecovery(seed, details, period, scenarioProjects, investmentDeductions = new Map()) {
  const projectOfWork = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  const scenarioOf = new Map(scenarioProjects.map((r) => [r.projectCode, r]));
  const salesOf = (code, inPeriod) => sum(details.filter((d) => d.基準 === 'cash' && d.案件コード === code && d.向き === '売上' && d.状態 === '確定'
    && mi(d.月) <= mi(period.closedMonth) && (!inPeriod || inPeriodMonth(d.月, period))), (d) => d.額);
  const remainingOf = (code, own) => {
    const s = scenarioOf.get(code);
    if (!s) return 0;
    if (!own) return s.weightedYen;
    return num(trunc(big(s.valueYen + (investmentDeductions.get(code) ?? 0)) * big(s.probabilityBps), TEN4));
  };
  const rows = [];
  for (const p of [...seed.案件].sort((a, b) => byText(a.案件コード, b.案件コード))) {
    if (p.稼ぎ方 !== '自社出資' && p.稼ぎ方 !== '製作委員会') continue;
    const invs = seed.investments.filter((x) => projectOfWork.get(x.work_code) === p.案件コード);
    if (!invs.length) continue;
    const paid = invs.flatMap((x) => x.payments.filter((q) => q.paid_on <= seed.as_of));
    const own = p.稼ぎ方 === '自社出資';
    rows.push({kind: own ? 'own_investment' : 'committee', projectCode: p.案件コード,
      investmentYen: own ? sum(invs, (x) => x.own_yen) : sum(paid, (q) => q.amount_yen),
      revenueYen: salesOf(p.案件コード, false),
      periodInvestmentYen: sum(paid.filter((q) => inPeriodMonth(ym(q.paid_on), period)), (q) => q.amount_yen),
      periodRevenueYen: salesOf(p.案件コード, true), remainingExpectedYen: remainingOf(p.案件コード, own)});
  }
  const out = rows.map((r) => {
    const diff = r.revenueYen - r.investmentYen;
    return {...r, diffYen: diff, recoveryRateBps: r.investmentYen > 0 ? ratioBps(r.revenueYen, r.investmentYen) : null,
      status: diff < 0 ? 'awaiting' : 'recovered', projectedDiffYen: diff + r.remainingExpectedYen};
  });
  const total = {rowCount: out.length};
  for (const key of ['investmentYen', 'revenueYen', 'diffYen', 'periodInvestmentYen', 'periodRevenueYen', 'projectedDiffYen']) total[key] = sum(out, (r) => r[key]);
  total.recoveryRateBps = total.investmentYen > 0 ? ratioBps(total.revenueYen, total.investmentYen) : null;
  total.status = out.length ? (total.diffYen < 0 ? 'awaiting' : 'recovered') : 'unknown';
  return {rows: out, total};
}

// ---------- 次の一手と期限切れ（案件の最後の活動記録。期日が種の時点より前なら期限切れ。期日が種の時点と同じ日は期限切れでない） ----------
function nextActions(seed) {
  const out = new Map();
  seed.活動記録.forEach((r, i) => {
    const prev = out.get(r.案件コード);
    if (!prev || r.日付 > prev.recordedOn || (r.日付 === prev.recordedOn && i > prev.index)) {
      out.set(r.案件コード, {index: i, recordedOn: r.日付, nextAction: r.次の一手, dueOn: r.期日});
    }
  });
  return new Map([...out].map(([code, r]) => [code, {recordedOn: r.recordedOn, dueOn: r.dueOn, hasNextAction: r.nextAction !== null,
    overdue: r.dueOn !== null && r.dueOn < seed.as_of}]));
}

// ---------- 通過率（K2-7。FR-REV-KPI-029） ----------
// 指標マスタの段の並び（役×稼ぎ方）ごとに、過去 N か月（設定の rate_window。締めた月で終わる）に段 s の活動記録があった案件の数と、
// そのうち同じ窓の中で、段 s の最初の記録の日以後に次の段の活動記録がある案件の数。結果（進んだ・保留・失注）は使わない（次の段の記録で数える）。
// 最小件数（rate_min_count）未満は insufficient で、当てる率は設定の仮置きの率（J-13）。観測の率は truncate（要確認10 まで仮）
function stageRates(seed, metrics, settings, period) {
  const windowMonths = settings.get('rate_window', 'all');
  const minCountX100 = settings.get('rate_min_count', 'all');
  const end = mi(period.closedMonth);
  const fromMonth = ms(end - windowMonths + 1);
  const toDate = `${period.closedMonth}-31`;
  const fromDate = `${fromMonth}-01`;
  const labelToCode = new Map([...metrics.steps.map((s) => [s.label, s.code]), ...Object.entries(TOP_STEP)]);
  const earningOf = new Map(seed.案件.map((p) => [p.案件コード, EARNING[p.稼ぎ方]]));
  const records = seed.活動記録.filter((r) => r.stage !== null)
    .map((r) => ({project: r.案件コード, earningType: earningOf.get(r.案件コード), step: labelToCode.get(r.stage), on: r.日付}));
  for (const r of records) if (!r.step) throw new Error('活動記録の段が指標マスタの段に無い');
  const rows = passRateRows({records, chains: metrics.metricMaster.chains.map((c) => ({role: c.role, earningType: c.earningType, steps: c.steps.map((s) => s.step)})),
    fromDate, toDate, minCountX100, provisionalRate: (earningType, step) => settings.get('conversion_rate', 'earning_type_step', earningType, step)});
  return {windowMonths, minCountX100, from: fromMonth, to: period.closedMonth, rows};
}

// 通過率の数え方（純関数。試験が架空の小さな入力でも確かめる）。records: [{project, earningType, step, on}]、chains: [{role, earningType, steps: [段のコード]}]
const ROLE_ORDER = ['producer', 'sales_sourcing', 'sales_selling'];
export function passRateRows({records, chains, fromDate, toDate, minCountX100, provisionalRate}) {
  const inWindow = records.filter((r) => r.on >= fromDate && r.on <= toDate);
  const ordered = [...chains].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || SOURCES.indexOf(a.earningType) - SOURCES.indexOf(b.earningType));
  const rows = [];
  for (const c of ordered) {
    const codes = c.steps;
    for (let i = 0; i < codes.length - 1; i++) {
      const firstOn = new Map();
      for (const r of inWindow) {
        if (r.earningType !== c.earningType || r.step !== codes[i]) continue;
        if (!firstOn.has(r.project) || r.on < firstOn.get(r.project)) firstOn.set(r.project, r.on);
      }
      const projects = [...firstOn.keys()].sort(byText);
      const advanced = projects.filter((code) => inWindow.some((r) => r.project === code && r.earningType === c.earningType && r.step === codes[i + 1] && r.on >= firstOn.get(code)));
      const provisional = provisionalRate(c.earningType, codes[i]);
      const status = projects.length * 100 >= minCountX100 ? 'measured' : 'insufficient';
      const observed = projects.length ? ratioBps(advanced.length, projects.length) : null;
      rows.push({role: c.role, source: c.earningType, step: codes[i], nextStep: codes[i + 1], count: projects.length, advancedCount: advanced.length,
        projectCodes: projects, advancedProjectCodes: advanced, observedRateBps: observed, provisionalRateBps: provisional, status,
        appliedRateBps: status === 'measured' ? observed : provisional});
    }
  }
  return rows;
}

// ---------- 見直しの提案（K2-9。FR-REV-KPI-041） ----------
// (1) 予測誤差: 締めた月までの期間内の月ごとに、案件の入金×売上率（実績の売上）と、その月の最初の入金の日に有効だった予測の版
//     （作った日がその日以前の最新の版。採用シナリオか単一の行）の売上を比べ、差が「予測の売上の10%と1万円の大きいほう」を超えたら（FR-REV-FCST-018 の型）
// (2) 次の一手の期限切れ、(3) 源泉の偏り＝期待値の会社の売上が有効な計画（期間の最新の採用の記録が指す版）を下回る稼ぎ方があり、いちばん足りない稼ぎ方
//     （回収待ち＝期待値の粗利が負の自社出資・製作委員会は除く）、(4) 通過率が件数不足。提案の行は参照 ID と率だけ（金額を持たない）
function forecastErrors(seed, period) {
  const kubun = new Map(seed.vocabulary.kubun.map((k) => [k.name, k]));
  const proj = new Map(seed.案件.map((p) => [p.案件コード, p]));
  const isSales = (name) => kubun.get(name)?.direction === '入金' && kubun.get(name)?.sales_source === 'はい';
  const keys = new Set();
  for (const r of seed.実績) if (isSales(r.区分) && proj.has(r.案件コード) && inPeriodMonth(ym(r.日付), period)) keys.add(`${r.案件コード}|${ym(r.日付)}`);
  const rows = [];
  let unforecast = 0;
  for (const key of [...keys].sort(byText)) {
    const [code, month] = key.split('|');
    const p = proj.get(code);
    const receipts = seed.実績.filter((r) => r.案件コード === code && ym(r.日付) === month && isSales(r.区分));
    const firstOn = receipts.map((r) => r.日付).sort(byText)[0];
    const versions = [...new Set(seed.予測.filter((r) => r.案件コード === code && r.作った日 <= firstOn).map((r) => `${r.作った日}|${r.版}`))].sort(byText);
    const actualSalesYen = rateAmount(sum(receipts, (r) => r['金額（円・税別）']), p.rate_bps);
    const version = versions.at(-1);
    const forecastRows = version ? seed.予測.filter((r) => r.案件コード === code && `${r.作った日}|${r.版}` === version && ym(r.月) === month && isSales(r.区分)
      && (r.シナリオ === seed.設定.採用シナリオ || r.シナリオ === '単一')) : [];
    if (!forecastRows.length) { unforecast++; continue; }
    const forecastSalesYen = rateAmount(sum(forecastRows, (r) => r['金額（円・税別）']), p.rate_bps);
    const thresholdYen = Math.max(num(trunc(big(forecastSalesYen) * 1000n, TEN4)), 10000);
    const diff = actualSalesYen - forecastSalesYen;
    rows.push({projectCode: code, month, forecastVersion: version.split('|')[1], forecastCreatedOn: version.split('|')[0], actualSalesYen, forecastSalesYen,
      thresholdYen, exceeded: Math.abs(diff) > thresholdYen, direction: diff > 0 ? 'over' : diff < 0 ? 'under' : 'equal', ratioBps: ratioBps(actualSalesYen, forecastSalesYen)});
  }
  return {rows, unforecastCount: unforecast};
}

// 有効な計画の版＝期間の採用の記録のうち、種の時点（as_of）までに採用したものの最新（採用日の新しい順、同じ日は版の番号の大きい順）。
// 採用の記録の行の並びには依らない
export function effectivePlan(seed, period) {
  const adoptions = seed.plan_adoptions.filter((a) => a.period === period.name && a.adopted_on <= seed.as_of)
    .sort((a, b) => byText(b.adopted_on, a.adopted_on) || b.version_no - a.version_no);
  const last = adoptions[0];
  if (!last) return null;
  const rows = seed.計画.filter((r) => r.期間 === period.name && r.版 === last.version_no);
  if (!rows.length || !rows.every((r) => r.fictional === true)) throw new Error('有効な計画の版の行が無いか、架空の印が無い');
  return {versionNo: last.version_no, amounts: new Map(rows.map((r) => [EARNING[r.稼ぎ方], r['計画額（円・税別）']]))};
}

// 源泉の偏り: 期待値の会社の売上÷有効な計画の版の額（bp）。回収待ち（期待値の粗利が負の自社出資・製作委員会）は除き、
// 計画を下回る稼ぎ方のうち率がいちばん小さいもの（どれも上回れば余裕のいちばん小さいもの）と、その稼ぎ方の候補の上位1つ
function sourceShortfall(plan, bySource, candidates) {
  if (!plan) return null;
  const awaiting = bySource.filter((r) => (r.source === 'own_investment' || r.source === 'committee') && r.expectedYen !== null && r.expectedYen < 0).map((r) => r.source);
  const ratios = SOURCES.filter((s) => plan.amounts.has(s) && plan.amounts.get(s) > 0 && !awaiting.includes(s)).map((s) => {
    const row = bySource.find((r) => r.source === s);
    return {source: s, ratioBps: ratioBps(row.expectedSalesYen ?? 0, plan.amounts.get(s))};
  });
  const short = ratios.filter((r) => r.ratioBps < 10000).sort((a, b) => a.ratioBps - b.ratioBps || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source));
  const worst = short[0] ?? [...ratios].sort((a, b) => a.ratioBps - b.ratioBps || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source))[0] ?? null;
  const pick = worst ? candidates.find((c) => c.source === worst.source) ?? null : null;
  return {fictional: true, planVersionNo: plan.versionNo, awaitingExcluded: awaiting, ratios, triggered: short.length > 0,
    mostShortSource: worst?.source ?? null, allAbovePlan: short.length === 0,
    pick: pick ? {source: pick.source, step: pick.step, addCountX100: pick.addCountX100} : null, pickReason: pick ? 'top_candidate_of_most_short_source' : 'no_candidate_for_source'};
}

function proposals(seed, period, standard, candidates, rates, projectRows) {
  const fe = forecastErrors(seed, period);
  const overdue = projectRows.filter((r) => r.nextAction?.overdue).map((r) => ({projectCode: r.projectCode, recordedOn: r.nextAction.recordedOn, dueOn: r.nextAction.dueOn}));
  const insufficient = rates.rows.filter((r) => r.status === 'insufficient').map((r) => ({role: r.role, source: r.source, step: r.step, count: r.count}));
  const shortfall = sourceShortfall(effectivePlan(seed, period), standard.bySource, candidates);
  const conditions = {
    forecastError: {triggered: fe.rows.some((r) => r.exceeded), rows: fe.rows.filter((r) => r.exceeded).map((r) => ({projectCode: r.projectCode, month: r.month, direction: r.direction, ratioBps: r.ratioBps})),
      unforecastCount: fe.unforecastCount},
    overdueNextAction: {triggered: overdue.length > 0, rows: overdue},
    sourceImbalance: {triggered: shortfall?.triggered ?? false, mostShortSource: shortfall?.mostShortSource ?? null},
    insufficientRate: {triggered: insufficient.length > 0, rows: insufficient},
  };
  return {
    triggered: Object.values(conditions).some((c) => c.triggered),
    conditions,
    forecastErrorDetail: fe.rows,
    shortfall,
    probabilityPick: {computedAtRuntime: true, by: 'probabilityPick(inputs, 目標額)（このファイル）', rule: '1時間あたりの届く確率の増分が最大の候補。目標額は試験が実行時に作る'},
  };
}

// ---------- 種の本体では通らない分岐（延長の種の branchCases。架空の小さな入力を golden と同じ関数に通す） ----------
// (0) 期間の境界（締めた月・期間の始まりと終わり・来期の始まりと終わり・来期の後の予測の行と行動の計画）、
// (1) 予測誤差がしきい値を超える行（上振れ・下振れ・しきい値ちょうど・1万円の床・月の最初の入金の日より後に作った版・採用シナリオでない行・予測外）、
// (2) 期日が種の時点と同じ日の次の一手（期限切れでない）と前の日（期限切れ）、同じ日の記録の後の行・後の日の記録で期限切れが消える行、
// (3) 件数が最小件数以上（measured）の通過率、(4) 期待値の粗利が負の製作委員会（回収待ち）を源泉の偏りから除く、
// (5) 予定の払込のある自社出資と製作委員会の出資の回収（同じ払込を2回引かない）
function branchCases(seed, kpiSeed, metrics, settings, period, inputs, scenarios, candidates, rates) {
  const b = kpiSeed.branchCases;
  if (!b) throw new Error('延長の種に branchCases が無い');
  const pb = b.periodBoundary;
  const boundary = stageInputs({vocabulary: seed.vocabulary, 設定: seed.設定, 案件: pb.案件, 予測: pb.予測}, {actionPlan: pb.actionPlan}, settings, metrics, [], period);
  const fe = forecastErrors({vocabulary: seed.vocabulary, 設定: seed.設定, 案件: b.forecastError.案件, 実績: b.forecastError.実績, 予測: b.forecastError.予測}, period);
  const next = nextActions({as_of: seed.as_of, 活動記録: b.nextAction.活動記録});
  const chains = b.passRate.chains.map((k) => {
    const c = metrics.metricMaster.chains.find((x) => x.role === k.role && x.earningType === k.earningType);
    if (!c) throw new Error(`指標マスタに ${k.role}×${k.earningType} が無い`);
    return {role: c.role, earningType: c.earningType, steps: c.steps.map((s) => s.step)};
  });
  const passRate = passRateRows({records: b.passRate.records, chains, fromDate: `${rates.from}-01`, toDate: `${rates.to}-31`, minCountX100: rates.minCountX100,
    provisionalRate: (earningType, step) => settings.get('conversion_rate', 'earning_type_step', earningType, step)});
  const overrides = new Map(b.awaitingExcluded.overrides.map((o) => [o.source, o]));
  const bySource = scenarios.standard.bySource.map((r) => (overrides.has(r.source)
    ? {...r, expectedYen: overrides.get(r.source).expectedYen, expectedSalesYen: overrides.get(r.source).expectedSalesYen} : r));
  const sch = b.scheduledInvestment;
  const stageProb = Object.fromEntries(seed.vocabulary.stages.map((s) => [s.name, s.probability_bps]));
  const miniItems = sch.forecast.map((f) => {
    const p = sch.案件.find((x) => x.案件コード === f.案件コード);
    return {key: p.案件コード, source: EARNING[p.稼ぎ方], probabilityBps: stageProb[p.段階], conversionBps: p.rate_bps, salesConversionBps: p.rate_bps,
      placement: 'in_period', cashScheduled: false, inPeriod: {revenueBaseYen: f.revenueBaseYen, deductionYen: f.investmentDeductionYen},
      nextPeriod: {revenueBaseYen: 0, deductionYen: 0}, cash: []};
  });
  const miniSeed = {案件: sch.案件, works: sch.works, investments: sch.investments, as_of: seed.as_of};
  const details = sch.cashSales.map((r) => ({基準: 'cash', 月: r.月, 案件コード: r.案件コード, 向き: '売上', 状態: '確定', 額: r.額}));
  const deductions = new Map(sch.forecast.map((f) => [f.案件コード, f.investmentDeductionYen]));
  const scheduledInvestment = Object.fromEntries(SCENARIO_KEYS.map((key) => {
    const rows = itemRows({items: miniItems}, scenarioAssumptions(inputs, key))
      .map((r) => ({projectCode: r.key, probabilityBps: r.probabilityBps, valueYen: r.valueYen, weightedYen: r.weightedYen}));
    return [key, investmentRecovery(miniSeed, details, period, rows, deductions)];
  }));
  return {
    notice: '延長の種（kpi-seed.json の branchCases）の架空の小さな入力を golden と同じ関数に通した結果。種の本体では通らない分岐を固定する',
    periodBoundary: {items: boundary.items, excluded: boundary.excluded, actions: boundary.actions},
    forecastError: fe,
    nextAction: [...next.entries()].sort(([a], [c]) => byText(a, c)).map(([projectCode, r]) => ({projectCode, ...r})),
    passRate,
    awaitingExcluded: sourceShortfall(effectivePlan(seed, period), bySource, candidates),
    scheduledInvestment,
  };
}

// =====================================================================================================
export function buildKpiExpected(loaded = loadSeeds()) {
  const seed = loaded.seed.json, kpiSeed = loaded.kpiSeed.json, metrics = loaded.metrics.json, invoices = loaded.invoices.json, p1 = loaded.p1.json;
  for (const [name, x] of Object.entries({seed, kpiSeed, metrics, p1})) if (x.fictional !== true) throw new Error(`${name}: fictional: true の印の無い入力からは作りません`);
  const period = periodOf(seed);
  const {details, unknown} = k16Details(seed, invoices);
  checkAgainstP1(details, p1);
  checkContractVersions(seed, kpiSeed);
  const settings = effectiveSettings(seed, metrics);
  const profit = sourceProfit(details, unknown, seed, kpiSeed, period);
  for (const basis of ['cash', 'accrual']) {
    if (profit[basis].total.profitYen !== p1PeriodProfit(p1, basis, period)) throw new Error(`${basis}: 源泉別の粗利の和がフェーズ1 の golden の利益額と違います`);
  }
  const si = stageInputs(seed, kpiSeed, settings, metrics, details, period);
  const actuals = Object.fromEntries(profit.cash.bySource.map((r) => [r.source, {status: r.status, actualYen: r.profitYen, actualSalesYen: r.salesYen}]));
  const actualsWithoutFourItems = Object.fromEntries(profit.cash.bySource.map((r) => [r.source, {status: r.status, actualYen: r.profitWithoutFourItemsYen, actualSalesYen: r.salesYen}]));
  const inputs = {
    period: {name: period.name, from: period.from, to: period.to, nextTo: period.nextTo}, closedMonth: period.closedMonth, basis: 'cash',
    assumptions: standardAssumptions(settings), actuals, actualsWithoutFourItems, items: si.items, actions: si.actions,
  };
  const scenarios = Object.fromEntries(SCENARIO_KEYS.map((key) => [key, scenarioGolden(inputs, key)]));
  for (const key of SCENARIO_KEYS) {
    scenarios[key].investmentRecovery = investmentRecovery(seed, details, period, scenarios[key].projects, si.investmentDeductions);
  }
  if (!(scenarios.pessimistic.expectedYen <= scenarios.standard.expectedYen && scenarios.standard.expectedYen <= scenarios.optimistic.expectedYen)) {
    throw new Error('悲観 ≤ 標準 ≤ 楽観 の順になっていません');
  }
  const next = nextActions(seed);
  const standardProjects = new Map(scenarios.standard.projects.map((r) => [r.projectCode, r]));
  const recovery = new Map(scenarios.standard.investmentRecovery.rows.map((r) => [r.projectCode, r]));
  const projects = si.projects.map((p) => {
    const s = standardProjects.get(p.projectCode);
    const rec = recovery.get(p.projectCode);
    return {...p, valueYen: s?.valueYen ?? null, weightedYen: s?.weightedYen ?? null, salesValueYen: s?.salesValueYen ?? null, weightedSalesYen: s?.weightedSalesYen ?? null,
      expectedYen: s ? p.actualProfitYen + (s.placement === 'in_period' ? s.weightedYen : 0) : null,
      nextPeriodWeightedYen: s?.nextPeriodWeightedYen ?? null,
      recovery: rec ? {investmentYen: rec.investmentYen, revenueYen: rec.revenueYen, diffYen: rec.diffYen, recoveryRateBps: rec.recoveryRateBps, status: rec.status} : null,
      nextAction: next.get(p.projectCode) ?? null};
  });
  const rates = stageRates(seed, metrics, settings, period);
  const candidates = candidateDeltas(inputs);
  return {
    fictional: true,
    notice: '架空データ。行動指標の計画 段B #15 の golden（src を読まずに build-kpi-expected.mjs が作る）。目標額・報酬・家賃補助を持たない',
    generator: 'build-kpi-expected.mjs',
    plan: '会社ルート plans/2026-10-09-sales-producer-kpi.md の段B #15（K2-11: 段B は フェーズ1 #23a の種を延長）',
    definitionVersion: DEFINITION_VERSION,
    sources: {
      'yojitsu/seed.json': sha256(loaded.seed.text), 'yojitsu/kpi-seed.json': sha256(loaded.kpiSeed.text), 'kpi-metrics/seed.json': sha256(loaded.metrics.text),
      'receipt-matching/invoices.json': sha256(loaded.invoices.text), 'yojitsu/expected.json': sha256(loaded.p1.text),
    },
    rules: RULES,
    gridYen: GRID_YEN,
    period: {name: period.name, from: period.from, to: period.to, nextFrom: period.nextFrom, nextTo: period.nextTo}, closedMonth: period.closedMonth, asOf: period.asOf,
    settings: {
      precedence: kpiSeed.settingPrecedence,
      skippedKpiMetricsSettings: settings.skipped,
      stageProbabilityBps: si.stageProbabilityBps,
      standardAssumptions: inputs.assumptions,
    },
    sourceProfit: profit,
    committees: committees(seed, kpiSeed, details, period),
    projects,
    excluded: si.excluded,
    stageRates: rates,
    inputs,
    scenarios,
    tornado: tornado(inputs),
    candidates,
    proposals: proposals(seed, period, scenarios.standard, candidates, rates, projects),
    branchCases: branchCases(seed, kpiSeed, metrics, settings, period, inputs, scenarios, candidates, rates),
    notInGolden: NOT_IN_GOLDEN,
  };
}

const RULES = [
  '期間は種の設定の期間のうち締めた月を含む期間。実績は期間の始まり〜締めた月、予測は締めた月の次の月〜期間の終わり、来期は次の期間（来期の入金・粗利の見込）',
  '源泉は稼ぎ方と1対1（制作受託＝1・自社出資＝2・製作委員会＝3・買付＝4・販売委託＝5。J-2 (a)・J-3 (a)）',
  '源泉別の実績＝フェーズ1 K-16 の利益額の「確定」の明細（golden.py と同じ規則で別に作り、expected.json の利益額.明細と一致を確かめた）を案件の稼ぎ方で分けた和。入金（cash）と計上（accrual）。会社の売上＝売上の費目（入金×売上率）、粗利＝売上−確定の経費。4費目を引かない粗利を並べる。未確定・除外は源泉ごとに別の行。源泉1は受託制作の契約の版（延長の種）が無ければ unconnected',
  '製作委員会は自社の払込と自社の取得額（入金×自社の出資比率）だけを数え、他の出資者の出資額・払込は counted: false の参考に出す',
  '案件の確度は案件の段階の確度（種の段階の表）。見送りの案件と予測の行の無い案件は除外（理由つき）',
  '案件の予測の行＝案件の最新の版（作った日の順）の行のうち、シナリオが採用シナリオか単一の行。成立時の期間内の粗利（見込）＝trunc(売上の区分の額の和×売上率×前提の倍率)−4費目の区分（出資・買付）の出金。会社の売上＝trunc(売上の区分の額の和×売上率×前提の倍率)。前提の倍率は買付・販売委託が窓口の売上の倍率、自社出資・製作委員会が回収の量、制作受託は無し。制作の実費・作り手と権利元への分配・クラファンの支援金と費用は粗利に入れない（notCountedYen に区分ごとの額）',
  '確度加重＝trunc(見込×確度÷10000)（段A と同じ2段の truncate）。案件別の期待値＝実績＋確度加重',
  '出資の回収: 自社出資＝出資の記録の自社の出資額（版の出資額。予定の払込を含む）、製作委員会＝自社の払込の累計（種の時点まで）。収益＝入金×売上率の累計（締めた月まで）。差額＝収益−出資額、回収率は truncate（要件の要確認10 まで仮）、期末の見込み＝差額＋残りの期待値。残りの期待値は製作委員会が案件の確度加重（予定の払込を引いたあと）、自社出資は予測の「出資」区分の出金（予定の払込）を足し戻してから確度を掛けた額（出資額が予定の払込を含むので2回引かない）',
  '次の一手は案件の最後の活動記録の次の一手と期日。期日が種の時点より前なら期限切れ（同じ日は期限切れでない）',
  '有効な計画の版＝期間の採用の記録のうち種の時点までに採用した最新（採用日の新しい順、同じ日は版の番号の大きい順。採用の記録の行の並びに依らない）',
  'branchCases: 種の本体では通らない分岐（予測誤差がしきい値を超える行、期日が種の時点と同じ日の次の一手、件数が最小件数以上の通過率、回収待ちの出資を源泉の偏りから除く計画、予定の払込のある自社出資と製作委員会の出資の回収）を、延長の種の架空の小さな入力で同じ関数に通した結果',
  '通過率は指標マスタの段の並び（役×稼ぎ方）ごとに、締めた月で終わる過去 N か月（rate_window）に段 s の活動記録があった案件の数と、そのうち段 s の最初の記録の日以後・窓の中に次の段の活動記録がある案件の数。最小件数（rate_min_count）未満は insufficient で、当てる率は設定の仮置きの率',
  '設定はフェーズ1 #23a の行動の行（1件あたりの額・面談→提案・提案→契約の率）を先に入れて残し、段B #9 の設定の行の同じ変数×範囲は入らない（skippedKpiMetricsSettings）',
  'シナリオは段A と同じ定義: 標準＝設定の値、楽観・悲観＝窓口の売上の倍率・回収の量・提案→契約の率・入金の遅れを段A と同じ幅で動かす（入金の遅れは悲観だけ）。期待値＝実績（入金の基準の源泉別の粗利）＋確度加重＋行動からの見込で、内訳の整数の和（配らない）',
  '行動は延長の種の行動の計画のうち締めた月の次の月〜期間の終わりの件数を稼ぎ方×段で足したもの。1件の額＝設定の1件あたりの額、換算率＝稼ぎ方の既定の売上率、成立の確率＝面談→提案×提案→契約（提案は提案→契約だけ）、1件の時間＝指標マスタの段の1件の時間を率の逆数で連ねた和（truncate）。行動の時期（契約までの月数・窓口に出るまでの月数）は期待値に入れない（段A と同じ）',
  '4費目を引かない場合（withoutFourItems。回収待ちの見え方。FR-REV-KPI-007・044）: 実績を4費目を引かない粗利にし、案件の4費目の区分の出金を0にして同じ計算をする',
  '分布は実績を起点に、案件の成立と行動の二項分布を1万円の格子（half_up）で正確な分数でたたみ込む。golden は分布の要約（点の数・最小・最大・正確な分数の SHA-256）と10・50・90%点で持ち、点の一覧は持たない（試験は inputs から distributionPoints で作る）',
  '入金の時期: 予測の行の月（入金の月）＋入金の遅れ。入金の見込＝trunc(月の売上の区分の額×前提の倍率×確度)（換算率の前）。来期は次の期間の月だけ',
  '前提の効き・行動の候補 (1) は段A と同じ。候補の (2) 段階を進める・(3) 交渉は golden に無い',
  '見直しの提案（K2-9）の4条件: 予測誤差（月の最初の入金の日に有効だった予測の版の売上と入金×売上率の差が、予測の売上の10%と1万円の大きいほうを超えた。FR-REV-FCST-018 の型）、次の一手の期限切れ、源泉の偏り（期待値の会社の売上が有効な計画の版を下回る稼ぎ方。回収待ちの出資は除く）、通過率の件数不足。提案の2つ目＝いちばん足りない稼ぎ方の候補の上位1つ。1つ目（1時間あたりの届く確率の増分が最大）は目標額に依るので probabilityPick で実行時に数える',
  '目標額・目標に依る値（差・達成率・届く確率・候補の確率）は持たない。目標は粗利で測る（J-12 (c)）ので、試験は分布（粗利）から実行時の目標額で数える。計画の版の額に依る値（源泉の偏りの率）は fictional: true の印つき',
];

const NOT_IN_GOLDEN = [
  {item: '市場の前提のうち契約までの月数・窓口に出るまでの月数・受託の実費の超過', why: '効きの幅と式（実費の超過を何に掛けるか、要件の要確認3）が段B #12 で決まるまで、シナリオと効きは段A の5つの前提だけで数える'},
  {item: '行動の時期（行動の月ごとの組の契約・窓口・入金の月）と時間の上限（いちばん多い月）', why: '段B #12（FR-REV-KPI-030・032）。golden は段A と同じく行動の時期を期待値に入れない'},
  {item: '自社出資・製作委員会の行動、買付の1件の MG・商品化の費用', why: '1件の粗利の式（出資額・MG・商品化の費用を引く）が段B #12 で決まるまで行動の計画に入れない'},
  {item: '行動の候補 (2) 段階を進める・(3) 交渉', why: '一手の時間と通る確率の混ぜ方の細目は段B #12（scenario_trials）'},
  {item: 'カスタムのシナリオ', why: 'scenario_values の上書きは段B #12。計画は「3シナリオ」'},
  {item: '作り手・権利元へ渡る額', why: '人へ渡る割合・成功報酬・買付の MG＋超過分（要件の要確認4・11）は段B #2・#16'},
  {item: '需給（供給・需要・見込み）', why: '段B #11 の需給の集計は表を足さず元の件数を出すので、種の延長が要らない。golden に入れるかは #11 で決める'},
];

export function expectedText(loaded = loadSeeds()) {
  return `${JSON.stringify(buildKpiExpected(loaded), null, 2)}\n`;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const text = expectedText();
  if (process.argv.includes('--check')) {
    const current = readFileSync(EXPECTED_PATH, 'utf8').replace(/\r\n/g, '\n');
    if (current !== text) { console.error('kpi-expected.json が種から作った golden と違います'); process.exit(1); }
    console.log('kpi-expected.json は種から作った golden と同じ');
  } else {
    writeFileSync(EXPECTED_PATH, text);
    console.log(`kpi-expected.json を書いた（${(text.length / 1024).toFixed(0)} KB）`);
  }
}
