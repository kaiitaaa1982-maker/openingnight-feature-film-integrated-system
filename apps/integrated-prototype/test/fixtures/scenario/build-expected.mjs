#!/usr/bin/env node
// シナリオの比較（段A）の golden を、model（src/revenue/scenario/）を import せずに作る生成スクリプト。
// 計画（plans/2026-10-09-sales-producer-kpi.md の「段A」「確率」「出資の回収」）と申し送り §計算の決まりの式を、ここで別に書く。
// 確率は正確な分数（分母は10のべき乗の BigInt）で、成立・不成立の組み合わせ（2^N 通り）と行動の二項分布を全部数える（全列挙）。
// 比べやすさのため、たたみ込みでも同じ分布を作り、全列挙と一致することをここで確かめてから書き出す。
// 金額は1万円の格子へ half_up（ちょうど0.5は0から遠ざける）で寄せ、行動は「k 件の合計を寄せる」。期待値は内訳を整数にした和（配らない）。
// golden は分布・期待値・内訳で持ち、目標額を含まない（目標に依る値は試験が実行時の目標額から、このファイルの関数で数える）。
// 使い方: node test/fixtures/scenario/build-expected.mjs [--in <compare-request.json>] [--out <expected.json>]
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFINITION_VERSION = 'scenario-stage-a.2026-10-10';
export const GRID_YEN = 10000;
const GRID = 10000n;
const TEN4 = 10000n;

// 楽観・悲観の幅（計画 K2-4。採用中の値からの差）と、前提の効きで動かす市場の前提。値の範囲で切る
const RANGES = {
  salesMultiplierBps: {pessimistic: -1500, optimistic: 1500, min: 0, max: 100000},
  recoveryAmountBps: {pessimistic: -1500, optimistic: 1500, min: 0, max: 100000},
  meetingToProposalBps: {pessimistic: -1000, optimistic: 1000, min: 0, max: 10000},
  proposalToContractBps: {pessimistic: -1000, optimistic: 1000, min: 0, max: 10000},
  paymentDelayMonths: {pessimistic: 1, optimistic: 0, min: 0, max: 6},
};
const SCENARIO_MOVES = ['salesMultiplierBps', 'recoveryAmountBps', 'proposalToContractBps', 'paymentDelayMonths'];
const TORNADO_KEYS = ['salesMultiplierBps', 'recoveryAmountBps', 'meetingToProposalBps', 'proposalToContractBps', 'paymentDelayMonths'];
const SOURCES = ['contract_work', 'own_investment', 'committee', 'acquisition', 'consignment'];

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
  const r = a % b;
  const out = r * 2n >= b ? q + 1n : q;
  return neg ? -out : out;
}
const pow10 = (e) => 10n ** big(e);
const snap = (yen) => num(halfUp(big(yen), GRID));
const mi = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const ms = (i) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const binom = (n, k) => {
  let out = 1n;
  for (let i = 1; i <= k; i++) out = (out * big(n - k + i)) / big(i);
  return out;
};

// ---------- 実績（源泉ごと。粗利と会社の売上） ----------
// facts の源泉が null（項目が無いときも）なら未接続、行はあるのに額が全部未確定なら unknown。どちらも粗利・売上は null（0円にしない）。
// 売上は粗利と同じ行（額が確定した行）で数える: 自社出資＝期間内の入金、委員会＝自社の取得額、買付＝窓口の売上、委託＝手数料。
// 費目は払った月に引く（J-11b (a)）。払った月の分からない自社出資の出資額と買い切りの買付額は、期間より前に払った（実績の側）とみなして期間の粗利から引かない。
// 委員会の自社の払込は払った日があるので、期間内の分を引く
function oneSource(list, isKnown, profit, sales) {
  if (list === null || list === undefined) return {status: 'unconnected', actualYen: null, actualSalesYen: null, rowCount: 0, unknownCount: 0};
  let p = 0, s = 0, known = 0;
  for (const r of list) {
    if (!isKnown(r)) continue;
    known++;
    p += profit(r);
    s += sales(r);
  }
  if (list.length && !known) return {status: 'unknown', actualYen: null, actualSalesYen: null, rowCount: 0, unknownCount: list.length};
  return {status: 'connected', actualYen: p, actualSalesYen: s, rowCount: known, unknownCount: list.length - known};
}

function sourceActuals(facts) {
  return {
    contract_work: oneSource(null),
    own_investment: oneSource(facts.ownInvestment, () => true, (r) => r.receiptsPeriodYen, (r) => r.receiptsPeriodYen),
    // 買付・販売委託の契約にも入る委員会の作品（overlap）は、取得額を契約の分と分けられないので未確定（同じ売上を2つの源泉で数えない）
    committee: oneSource(facts.committee, (r) => r.acquisitionsPeriodYen !== null && r.overlap !== true, (r) => r.acquisitionsPeriodYen - r.paymentsPeriodYen, (r) => r.acquisitionsPeriodYen),
    // 買い切りは期間内の税抜売上（買付額は期間より前に払った扱い）、MG つきは MG の行の手数料（無ければ未確定）
    acquisition: oneSource(facts.acquisition, (r) => r.kind === 'outright' || r.agencyFeePeriodYen !== null,
      (r) => (r.kind === 'outright' ? r.salesPeriodYen : r.agencyFeePeriodYen), (r) => r.salesPeriodYen),
    consignment: oneSource(facts.consignment, () => true, (r) => r.agencyFeePeriodYen, (r) => r.agencyFeePeriodYen),
  };
}

// ---------- 商談の残り（同じ作品×取引先の close_date 以降の売上を close_date 順に充てる） ----------
function remainders(facts) {
  const groups = new Map();
  for (const o of facts.opportunities) {
    if (o.stage === 'lost' || o.expectedYen === null || o.closeDate === null) continue;
    const key = `${o.workId}:${o.partnerId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const out = new Map();
  for (const [key, opps] of groups) {
    const [workId, partnerId] = key.split(':').map(Number);
    const months = new Map();
    for (const s of facts.salesByWorkPartner) if (s.workId === workId && s.partnerId === partnerId) months.set(s.month, (months.get(s.month) || 0) + s.amountYen);
    // 月の純額が負の月は充てない
    const pool = [...months.entries()].sort(([a], [b]) => mi(a) - mi(b)).map(([month, amount]) => ({month, left: Math.max(0, amount)}));
    const ordered = [...opps].sort((a, b) => (a.closeDate < b.closeDate ? -1 : a.closeDate > b.closeDate ? 1 : a.id - b.id));
    for (const o of ordered) {
      let need = o.expectedYen;
      for (const p of pool) {
        if (need === 0) break;
        if (mi(p.month) < mi(o.closeDate.slice(0, 7)) || p.left === 0) continue;
        const take = Math.min(need, p.left);
        p.left -= take;
        need -= take;
      }
      out.set(o.id, need);
    }
  }
  return out;
}

const multiplierOf = (source, a) => (source === 'acquisition' || source === 'consignment' ? a.salesMultiplierBps
  : source === 'own_investment' || source === 'committee' ? a.recoveryAmountBps : null);
// 率の積を1回だけ truncate
const chain = (amount, rates, extra = 1n) => num(trunc(rates.reduce((n, r) => n * big(r), big(amount)), extra * TEN4 ** big(rates.length)));
// 会社の売上の率（申し送り §稼ぎ方ごとの表）: 買付は窓口の売上（総額）なので換算率を掛けない。ほかは粗利と同じ率（受託・委託は純額、出資は回収・取得額）
const salesRates = (source, conversionBps, mult) => {
  if (source === 'acquisition') return mult === null ? [] : [mult];
  return mult === null ? [conversionBps] : [conversionBps, mult];
};

// ---------- 1つのシナリオ ----------
function opportunityRows(fixture, a) {
  const {request, facts} = fixture;
  const spec = new Map(request.opportunities.map((o) => [o.id, o]));
  const rest = remainders(facts);
  const from = mi(request.period.from), to = mi(request.period.to), firstOpen = mi(request.closedMonth) + 1;
  const rows = [];
  const excluded = [];
  for (const o of [...facts.opportunities].sort((x, y) => x.id - y.id)) {
    const s = spec.get(o.id);
    if (o.stage === 'lost') { excluded.push({opportunityId: o.id, reason: 'lost', expectedYen: o.expectedYen}); continue; }
    if (!s) { excluded.push({opportunityId: o.id, reason: 'no_source', expectedYen: o.expectedYen}); continue; }
    if (o.expectedYen === null) { excluded.push({opportunityId: o.id, reason: 'no_amount', expectedYen: null}); continue; }
    const revenue = s.revenueMonth ?? (o.closeDate ? o.closeDate.slice(0, 7) : null);
    if (!revenue) { excluded.push({opportunityId: o.id, reason: 'no_month', expectedYen: o.expectedYen}); continue; }
    const remaining = rest.has(o.id) ? rest.get(o.id) : o.expectedYen;
    const eff = Math.max(mi(revenue), firstOpen);
    const placement = eff < from ? 'before_period' : eff > to ? 'after_period' : 'in_period';
    const pBps = o.stage === 'won' ? 10000 : request.stageProbabilityBps[o.stage];
    const mult = multiplierOf(s.source, a);
    const rates = mult === null ? [s.conversionBps] : [s.conversionBps, mult];
    const value = chain(remaining, rates);
    const weighted = num(trunc(big(value) * big(pBps), TEN4));
    // 会社の売上も、成立時の額を1回 truncate してから確度を掛けて truncate（粗利と同じ2段）
    const salesValue = chain(remaining, salesRates(s.source, s.conversionBps, mult));
    const weightedSales = num(trunc(big(salesValue) * big(pBps), TEN4));
    const channel = s.channel ?? o.partnerKind;
    const gap = channel !== null && Object.hasOwn(request.paymentGapMonths, channel) ? request.paymentGapMonths[channel] : null;
    const payment = placement === 'before_period' || gap === null ? null : eff + gap + a.paymentDelayMonths;
    const cashRates = mult === null ? [pBps] : [mult, pBps];
    const inflow = payment === null ? null : num(trunc(cashRates.reduce((n, r) => n * big(r), big(remaining)), TEN4 ** big(cashRates.length)));
    rows.push({opportunityId: o.id, workId: o.workId, source: s.source, stage: o.stage, probabilityBps: pBps, remainingYen: remaining, valueYen: value, weightedYen: weighted,
      salesValueYen: salesValue, weightedSalesYen: weightedSales, revenueMonth: ms(eff), overdue: mi(revenue) < firstOpen, placement, channel, paymentMonth: payment === null ? null : ms(payment), inflowYen: inflow});
  }
  return {rows, excluded};
}

function actionRows(actions, a) {
  return actions.map((act) => {
    const mult = multiplierOf(act.source, a);
    const valueRates = mult === null ? [act.conversionBps] : [act.conversionBps, mult];
    const value = chain(act.dealYen, valueRates);
    const stepRates = act.step === 'meeting' ? [a.meetingToProposalBps, a.proposalToContractBps] : [a.proposalToContractBps];
    const expected = chain(big(act.dealYen) * big(act.countX100), [...valueRates, ...stepRates], 100n);
    const sRates = salesRates(act.source, act.conversionBps, mult);
    const salesValue = chain(act.dealYen, sRates);
    const expectedSales = chain(big(act.dealYen) * big(act.countX100), [...sRates, ...stepRates], 100n);
    // 成立の確率（分子と10のべき乗）
    const pNum = stepRates.reduce((n, r) => n * big(r), 1n);
    const pExp = 4 * stepRates.length;
    return {source: act.source, step: act.step, countX100: act.countX100, dealYen: act.dealYen, valueYen: value, expectedYen: expected,
      salesValueYen: salesValue, expectedSalesYen: expectedSales, pNum, pExp};
  });
}

// 試行の一覧: 各試行は {exp, outcomes: [{grid, num}]}（num の和は 10^exp）
function trials(oppRows, actRows) {
  const out = [];
  for (const r of oppRows) {
    if (r.placement !== 'in_period') continue;
    const s = big(r.probabilityBps);
    out.push({exp: 4, outcomes: [{grid: 0, num: TEN4 - s}, {grid: snap(r.valueYen), num: s}]});
  }
  for (const r of actRows) {
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

// 全列挙: 試行の結果の組み合わせを全部たどる
function enumerate(start, list) {
  const exp = list.reduce((n, t) => n + t.exp, 0);
  const dist = new Map();
  const walk = (i, grid, p) => {
    if (p === 0n) return;
    if (i === list.length) { dist.set(grid, (dist.get(grid) || 0n) + p); return; }
    for (const o of list[i].outcomes) walk(i + 1, grid + o.grid, p * o.num);
  };
  walk(0, start, 1n);
  return {exp, dist};
}

// たたみ込み（全列挙と同じ分布になることを確かめる相手。試験の実行時の計算にも使う）
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
  const scale = (d, e, to) => new Map([...d.dist].map(([g, p]) => [g, p * pow10(to - e)]));
  const e = Math.max(a.exp, b.exp);
  const x = scale(a, a.exp, e), y = scale(b, b.exp, e);
  if (x.size !== y.size) return false;
  for (const [g, p] of x) if (y.get(g) !== p) return false;
  return true;
}

export function quantileYen({exp, dist}, numer, denom) {
  const total = pow10(exp);
  let cum = 0n;
  for (const g of [...dist.keys()].sort((p, q) => p - q)) {
    cum += dist.get(g);
    if (cum * big(denom) >= total * big(numer)) return g * GRID_YEN;
  }
  throw new Error('分位点が見つかりません');
}

// 目標以上になる確率（bp、half_up）
export function reachBps({exp, dist}, targetYen) {
  let hit = 0n;
  for (const [g, p] of dist) if (big(g) * GRID >= big(targetYen)) hit += p;
  return num(halfUp(hit * TEN4, pow10(exp)));
}

const toFloat = (p, exp) => Number((p * 10n ** 20n) / pow10(exp)) / 1e20;

// 出資の回収（委員会は自社の出資のある作品 selfInvested だけ。計画の「出資のある案件ごと」）。差額は全期間の累計の 収益−出資額。
// 期間内の出資は、自社出資は期間より前に払った扱いの0円、委員会は期間内の自社の払込。合計は差額が分かる行だけで、出資額・収益・差額・期間内の列・期末の見込みを同じ行の集合で足す（収益−出資額＝差額になる）。
// その集合の中に値の無い列は合計も null。回収率は 収益の合計÷出資額の合計（出資額の合計が0以下なら null）。差額が分からない行は件数と出資額を別に出す。
// 合計に入る行が無ければ「回収済み」と言わない（両方の源泉が未接続なら unconnected、そうでなければ unknown）
function investmentRows(facts, oppRows) {
  const remainingOf = (workId) => oppRows.filter((r) => r.placement === 'in_period' && r.workId === workId && (r.source === 'own_investment' || r.source === 'committee'))
    .reduce((n, r) => n + r.weightedYen, 0);
  const rows = [];
  for (const r of [...(facts.ownInvestment ?? [])].sort((a, b) => a.workId - b.workId)) {
    rows.push({kind: 'own_investment', workId: r.workId, title: r.title, investmentYen: r.investmentYen, revenueYen: r.receiptsTotalYen,
      periodInvestmentYen: 0, periodRevenueYen: r.receiptsPeriodYen, remainingExpectedYen: remainingOf(r.workId), error: null, holdNote: null});
  }
  for (const r of [...(facts.committee ?? [])].filter((r) => r.selfInvested).sort((a, b) => a.workId - b.workId)) {
    rows.push({kind: 'committee', workId: r.workId, title: r.title, investmentYen: r.paymentsTotalYen, revenueYen: r.acquisitionsTotalYen,
      periodInvestmentYen: r.paymentsPeriodYen, periodRevenueYen: r.acquisitionsPeriodYen, remainingExpectedYen: remainingOf(r.workId), error: r.error, holdNote: r.holdNote});
  }
  const out = rows.map((r) => {
    const diff = r.investmentYen === null || r.revenueYen === null ? null : r.revenueYen - r.investmentYen;
    const rate = diff !== null && r.investmentYen > 0 ? num(trunc(big(r.revenueYen) * TEN4, big(r.investmentYen))) : null;
    return {...r, diffYen: diff, recoveryRateBps: rate, status: diff === null ? 'unknown' : diff < 0 ? 'awaiting' : 'recovered',
      projectedDiffYen: diff === null ? null : diff + r.remainingExpectedYen};
  });
  const known = out.filter((r) => r.diffYen !== null);
  const unknown = out.filter((r) => r.diffYen === null);
  const total = {rowCount: known.length};
  for (const key of ['investmentYen', 'revenueYen', 'diffYen', 'periodInvestmentYen', 'periodRevenueYen', 'projectedDiffYen']) {
    total[key] = known.length && known.every((r) => r[key] !== null) ? known.reduce((n, r) => n + r[key], 0) : null;
  }
  total.recoveryRateBps = total.investmentYen !== null && total.investmentYen > 0 ? num(trunc(big(total.revenueYen) * TEN4, big(total.investmentYen))) : null;
  const unconnected = [];
  if (facts.ownInvestment === null || facts.ownInvestment === undefined) unconnected.push('own_investment');
  if (facts.committee === null || facts.committee === undefined) unconnected.push('committee');
  total.status = known.length ? (total.diffYen < 0 ? 'awaiting' : 'recovered') : unconnected.length === 2 ? 'unconnected' : 'unknown';
  const unknownInvested = unknown.filter((r) => r.investmentYen !== null);
  return {rows: out, total, unknown: {count: unknown.length, investmentYen: unknownInvested.length ? unknownInvested.reduce((n, r) => n + r.investmentYen, 0) : null}, unconnected};
}

function cashOf(request, oppRows) {
  const from = mi(request.period.from), to = mi(request.period.to);
  const byMonth = new Map();
  let period = 0, last = 0, edge = 0, next = 0, unscheduled = 0;
  for (const r of oppRows) {
    if (r.placement === 'before_period') continue;
    if (r.paymentMonth === null) { unscheduled++; continue; }
    const m = mi(r.paymentMonth);
    if (m > to) { next += r.inflowYen; continue; }
    if (m < from) continue;
    period += r.inflowYen;
    if (m >= to - 1) last += r.inflowYen;
    if (m === to) edge += r.inflowYen;
    if (r.inflowYen !== 0) byMonth.set(m, (byMonth.get(m) || 0) + r.inflowYen);
  }
  return {byMonth: [...byMonth.entries()].sort(([a], [b]) => a - b).map(([m, yen]) => ({month: ms(m), yen})), periodYen: period, lastTwoMonthsYen: last, slipOutYen: edge, nextPeriodYen: next, unscheduledCount: unscheduled};
}

export {sourceActuals, investmentRows};

export function scenarioAssumptions(fixture, key) {
  const base = {...fixture.request.assumptions};
  if (key === 'standard') return base;
  if (key === 'custom') return {...base, ...(fixture.request.custom?.assumptions || {})};
  const out = {...base};
  for (const k of SCENARIO_MOVES) out[k] = clamp(base[k] + RANGES[k][key], RANGES[k].min, RANGES[k].max);
  return out;
}

export function scenarioActions(fixture, key) {
  const base = fixture.request.actions.map((a) => ({...a, conversionBps: a.conversionBps ?? 10000}));
  if (key !== 'custom') return base;
  const counts = new Map((fixture.request.custom?.actions || []).map((a) => [`${a.source}:${a.step}`, a.countX100]));
  return base.map((a) => (counts.has(`${a.source}:${a.step}`) ? {...a, countX100: counts.get(`${a.source}:${a.step}`)} : a));
}

// 1つのシナリオを正確に数える（試験の実行時にも使う）
export function exactScenario(fixture, {assumptions, actions, method = 'convolve'}) {
  const actuals = sourceActuals(fixture.facts);
  const {rows: opp, excluded} = opportunityRows(fixture, assumptions);
  const act = actionRows(actions, assumptions);
  const actualTotal = SOURCES.reduce((n, s) => n + (actuals[s].actualYen ?? 0), 0);
  const start = snap(actualTotal);
  const list = trials(opp, act);
  const dist = method === 'enumerate' ? enumerate(start, list) : convolve(start, list);
  const withoutActions = convolve(start, trials(opp, []));
  const bySource = SOURCES.map((source) => {
    const {status, actualYen, actualSalesYen} = actuals[source];
    const mine = opp.filter((r) => r.placement === 'in_period' && r.source === source);
    const acts = act.filter((r) => r.source === source);
    const add = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
    const forecast = mine.length > 0 || acts.length > 0;
    const weightedYen = add(mine, 'weightedYen'), actionYen = add(acts, 'expectedYen');
    const weightedSalesYen = add(mine, 'weightedSalesYen'), actionSalesYen = add(acts, 'expectedSalesYen');
    return {source, status, actualYen, weightedYen, actionYen, expectedYen: actualYen === null && !forecast ? null : (actualYen ?? 0) + weightedYen + actionYen,
      actualSalesYen, weightedSalesYen, actionSalesYen, expectedSalesYen: actualSalesYen === null && !forecast ? null : (actualSalesYen ?? 0) + weightedSalesYen + actionSalesYen};
  });
  const tot = (key) => bySource.reduce((n, r) => n + (r[key] ?? 0), 0);
  return {actuals, opp, excluded, act, start, list, dist, withoutActions, bySource, expectedYen: tot('expectedYen'), actualYen: actualTotal, weightedYen: tot('weightedYen'), actionYen: tot('actionYen'),
    expectedSalesYen: tot('expectedSalesYen'), actualSalesYen: tot('actualSalesYen'), weightedSalesYen: tot('weightedSalesYen'), actionSalesYen: tot('actionSalesYen')};
}

function scenarioGolden(fixture, key) {
  const assumptions = scenarioAssumptions(fixture, key);
  const actions = scenarioActions(fixture, key);
  const s = exactScenario(fixture, {assumptions, actions, method: 'enumerate'});
  if (!sameDistribution(s.dist, convolve(s.start, s.list))) throw new Error(`${key}: 全列挙とたたみ込みの分布が一致しません`);
  // 分布の平均と整数の期待値の差は「内訳の数 × 5,001円」以内
  const components = 1 + s.list.length;
  let meanNum = 0n;
  for (const [g, p] of s.dist.dist) meanNum += big(g) * GRID * p;
  const diff = meanNum - big(s.expectedYen) * pow10(s.dist.exp);
  if ((diff < 0n ? -diff : diff) > big(components * 5001) * pow10(s.dist.exp)) throw new Error(`${key}: 分布の平均と期待値の差が許す幅を超えました`);
  const points = [...s.dist.dist.entries()].sort(([a], [b]) => a - b).map(([g, p]) => [g * GRID_YEN, toFloat(p, s.dist.exp)]);
  const nextPeriodProfitYen = s.opp.filter((r) => r.placement === 'after_period').reduce((n, r) => n + r.weightedYen, 0);
  return {
    assumptions, actions: actions.map((a) => ({source: a.source, step: a.step, countX100: a.countX100})),
    expectedYen: s.expectedYen, actualYen: s.actualYen, weightedYen: s.weightedYen, actionYen: s.actionYen,
    actualPlusWeightedYen: s.bySource.reduce((n, r) => n + (r.actualYen ?? 0) + r.weightedYen, 0),
    expectedSalesYen: s.expectedSalesYen, actualSalesYen: s.actualSalesYen, weightedSalesYen: s.weightedSalesYen, actionSalesYen: s.actionSalesYen,
    actualPlusWeightedSalesYen: s.bySource.reduce((n, r) => n + (r.actualSalesYen ?? 0) + r.weightedSalesYen, 0),
    bySource: s.bySource,
    opportunities: s.opp.map(({channel, ...r}) => r),
    actionRows: s.act.map(({pNum, pExp, ...r}) => r),
    nextPeriodProfitYen,
    componentCount: components,
    distribution: {gridYen: GRID_YEN, points},
    quantiles: {p10Yen: quantileYen(s.dist, 1, 10), p50Yen: quantileYen(s.dist, 1, 2), p90Yen: quantileYen(s.dist, 9, 10)},
    quantilesWithoutActions: {p10Yen: quantileYen(s.withoutActions, 1, 10), p50Yen: quantileYen(s.withoutActions, 1, 2), p90Yen: quantileYen(s.withoutActions, 9, 10)},
    cash: cashOf(fixture.request, s.opp),
    investmentRecovery: investmentRows(fixture.facts, s.opp),
  };
}

const expectedOnly = (fixture, assumptions, actions) => {
  const {opp, act, bySource} = exactScenario(fixture, {assumptions, actions});
  return {expectedYen: bySource.reduce((n, r) => n + (r.expectedYen ?? 0), 0), periodCashYen: cashOf(fixture.request, opp).periodYen, act};
};

function tornado(fixture) {
  const base = scenarioAssumptions(fixture, 'standard');
  const actions = scenarioActions(fixture, 'standard');
  const rows = TORNADO_KEYS.map((key) => {
    const at = (side) => {
      const value = clamp(base[key] + RANGES[key][side], RANGES[key].min, RANGES[key].max);
      const r = expectedOnly(fixture, {...base, [key]: value}, actions);
      return {value, expectedYen: r.expectedYen, periodCashYen: r.periodCashYen};
    };
    const pessimistic = at('pessimistic'), optimistic = at('optimistic');
    return {key, pessimistic, optimistic, swingYen: Math.abs(optimistic.expectedYen - pessimistic.expectedYen), cashSwingYen: Math.abs(optimistic.periodCashYen - pessimistic.periodCashYen)};
  });
  rows.sort((a, b) => b.swingYen - a.swingYen || b.cashSwingYen - a.cashSwingYen || (a.key < b.key ? -1 : 1));
  return rows.slice(0, 8);
}

// 申し送り K-e の並び: 増分÷時間の大きい順（割らずに掛けて比べる）。時間0は先頭で、時間0どうしは増分の順。
// 同じなら期待値の増分の大きい順、それも同じなら「稼ぎ方:段」の名前の順。増分が整数なら BigInt で、確率（小数）ならそのまま掛ける
export function perHourOrder(delta) {
  const times = (v, h) => (Number.isInteger(v) ? big(v) * big(h) : v * h);
  const cmp = (x, y) => (x > y ? -1 : x < y ? 1 : 0);
  return (a, b) => {
    const za = a.hoursX100 === 0, zb = b.hoursX100 === 0;
    if (za && !zb) return -1;
    if (zb && !za) return 1;
    const first = za ? cmp(delta(a), delta(b)) : cmp(times(delta(a), b.hoursX100), times(delta(b), a.hoursX100));
    if (first !== 0) return first;
    const second = cmp(a.expectedDeltaYen, b.expectedDeltaYen);
    if (second !== 0) return second;
    const ka = `${a.source}:${a.step}`, kb = `${b.source}:${b.step}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

export function candidateDeltas(fixture, key = 'standard') {
  const assumptions = scenarioAssumptions(fixture, key);
  const actions = scenarioActions(fixture, key);
  const before = expectedOnly(fixture, assumptions, actions).expectedYen;
  const rows = actions.map((a, i) => {
    const more = actions.map((x, j) => (j === i ? {...x, countX100: x.countX100 + 100} : x));
    return {source: a.source, step: a.step, addCountX100: 100, hoursX100: a.hoursX100, expectedDeltaYen: expectedOnly(fixture, assumptions, more).expectedYen - before};
  });
  rows.sort(perHourOrder((r) => r.expectedDeltaYen));
  return rows;
}

// 作り手・権利元へ渡る額: 販売委託の権利元の取り分の和（未接続なら null）。買付の MG は参考
export function creators(facts) {
  const mg = (facts.acquisition ?? []).filter((r) => r.kind === 'mg' && r.mgContractYen !== null);
  const holder = facts.consignment === null || facts.consignment === undefined ? null : facts.consignment.reduce((n, r) => n + r.holderAmountPeriodYen, 0);
  return {
    totalYen: holder,
    bySource: {contract_work: null, own_investment: null, committee: null, acquisition: null, consignment: holder},
    mgReferenceYen: mg.length ? mg.reduce((n, r) => n + r.mgContractYen, 0) : null,
  };
}

function actionActuals(fixture) {
  const {request, facts} = fixture;
  const from = mi(request.period.from), to = mi(request.period.to);
  const sourceOf = new Map(request.opportunities.map((o) => [o.id, o.source]));
  const inPeriod = (date) => date !== null && mi(date.slice(0, 7)) >= from && mi(date.slice(0, 7)) <= to;
  const counts = {};
  const bump = (source, step) => {
    counts[source] ||= {meeting: 0, proposal: 0, contract: 0};
    counts[source][step] += 1;
  };
  for (const a of facts.activities) {
    if (!inPeriod(a.occurredOn)) continue;
    const step = a.activityType === 'contact' ? 'meeting' : a.activityType === 'proposal' ? 'proposal' : null;
    if (step) bump(sourceOf.get(a.opportunityId) ?? 'unassigned', step);
  }
  for (const o of facts.opportunities) if (o.stage === 'won' && inPeriod(o.closeDate)) bump(sourceOf.get(o.id) ?? 'unassigned', 'contract');
  const keys = Object.keys(counts).sort();
  const bySource = keys.map((source) => ({source, ...counts[source]}));
  const total = {meeting: 0, proposal: 0, contract: 0};
  for (const r of bySource) for (const k of Object.keys(total)) total[k] += r[k];
  return {bySource, total};
}

function excludedSummary(rows) {
  const reasons = ['lost', 'no_source', 'no_amount', 'no_month'];
  return reasons.map((reason) => {
    const list = rows.filter((r) => r.reason === reason);
    return {reason, count: list.length, amountYen: list.reduce((n, r) => n + (r.expectedYen ?? 0), 0), opportunityIds: list.map((r) => r.opportunityId)};
  });
}

export function buildExpected(fixture) {
  if (fixture.fictional !== true) throw new Error('fictional: true の印の無い入力からは作りません');
  const keys = ['standard', 'optimistic', 'pessimistic', ...(fixture.request.custom ? ['custom'] : [])];
  const scenarios = Object.fromEntries(keys.map((key) => [key, scenarioGolden(fixture, key)]));
  const standard = exactScenario(fixture, {assumptions: scenarioAssumptions(fixture, 'standard'), actions: scenarioActions(fixture, 'standard')});
  return {
    fictional: true,
    generatedBy: 'test/fixtures/scenario/build-expected.mjs',
    definitionVersion: DEFINITION_VERSION,
    gridYen: GRID_YEN,
    sources: SOURCES.map((source) => ({source, ...standard.actuals[source]})),
    excluded: excludedSummary(standard.excluded),
    creators: creators(fixture.facts),
    actionActuals: actionActuals(fixture),
    overlapCount: fixture.facts.overlapCount,
    unlinkedReports: fixture.facts.unlinkedReports,
    scenarios,
    tornado: tornado(fixture),
    candidates: candidateDeltas(fixture),
  };
}

export function loadFixture(path = resolve(here, 'compare-request.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => (args.includes(name) ? resolve(args[args.indexOf(name) + 1]) : fallback);
  const input = arg('--in', resolve(here, 'compare-request.json'));
  const output = arg('--out', resolve(here, 'expected.json'));
  const expected = buildExpected(loadFixture(input));
  writeFileSync(output, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`書きました: ${output}`);
}
