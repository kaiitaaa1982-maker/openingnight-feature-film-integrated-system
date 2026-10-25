// 製作委員会の収支の式（純関数。表は読まない）。
// 要件: docs/requirements/settlement/committee.md（FR-SETL-COMM-001〜009）。設計: 会社ルート plans/2026-10-23-committee-terms-ledger.md の A。
//
// 事業ごとの式: 収入から、並べた順に「経費」「二次使用料」「窓口手数料」を引き、残りが配分金（委員会へ入る額）。
// 委員会全体の式: 配分金合計 A から、並べた順に「委員会経費」「幹事手数料」「成功報酬」を引き、残りが配分原資 D。D を持分で分ける。
// 並べた順が計算の順で、順番を変えると額が変わる（二次使用料はそれより前に引いた経費だけを引く、など）。
import {factorRateAmount, splitByAllocation} from '../../money-allocation.mjs';
import {signedRateAmount} from '../../royalty/royalty-model.mjs';

export const BUSINESS_STEP_KINDS = Object.freeze(['expense', 'secondary_royalty', 'agent_fee']);
export const COMMITTEE_STEP_KINDS = Object.freeze(['overhead', 'manager_fee', 'success_fee']);

function yen(value, label) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label}を整数の円として確認できません`);
  return value;
}
function bps(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 10000) throw new Error(`${label}を 0〜10000 の bp として確認できません`);
  return value;
}
function sum(values, label = '合計') {
  const total = values.reduce((acc, v) => acc + BigInt(yen(v, label)), 0n);
  const out = Number(total);
  if (!Number.isSafeInteger(out)) throw new Error(`${label}が安全な整数を超えました`);
  return out;
}

// 1つの事業の式。steps は並べた順。返り値の steps は入力と同じ順で、各段の額・基礎・その段のあとの残り。
export function calcBusiness({incomeYen, steps = []}) {
  yen(incomeYen, '事業の収入');
  let remaining = incomeYen;
  let expensesSoFar = 0;
  const out = steps.map((step, index) => {
    if (!BUSINESS_STEP_KINDS.includes(step.kind)) throw new Error(`事業の式に置けない段です（${index + 1}段目: ${step.kind}）`);
    let amountYen;
    let baseYen;
    if (step.kind === 'expense') {
      amountYen = yen(step.amountYen, '経費');
      baseYen = null;
      expensesSoFar = sum([expensesSoFar, amountYen], '経費の合計');
    } else if (step.kind === 'secondary_royalty') {
      const minusYen = step.deductExpenses ? expensesSoFar : 0;
      baseYen = incomeYen;
      amountYen = factorRateAmount({
        amount: incomeYen,
        grossFactorBps: bps(step.grossFactorBps ?? 10000, '収入に掛ける係数'),
        minusYen,
        rateBps: bps(step.rateBps, '二次使用料の料率'),
        afterFactorBps: bps(step.afterFactorBps ?? 10000, '後から掛ける係数'),
      });
    } else {
      if (!['income', 'remaining'].includes(step.base)) throw new Error('窓口手数料の基礎は income（収入）か remaining（この時点の残り）で指定してください');
      baseYen = step.base === 'income' ? incomeYen : remaining;
      amountYen = signedRateAmount(baseYen, bps(step.rateBps, '窓口手数料の率'));
    }
    remaining = sum([remaining, -amountYen], '残り');
    return {...step, amountYen, baseYen, remainingYen: remaining};
  });
  return {incomeYen, steps: out, distributionYen: remaining};
}

// 成功報酬。cumulativeBefore は前回までの基礎の累計、periodBase は今回の基礎（A − 委員会経費 − 幹事手数料）。
//   excess: 閾値を累計で超えた分に率を掛ける。累計で truncate した額の差を今回の額にするので、回ごとの和は通期で計算した額と一致する
//   after_recoup: 累計が閾値に届いたあとの回は A に率を掛ける。届く回の扱いは crossingRule で必ず指定する（要確認1。推測で決めない）
//     whole_period: 届いた回は A の全体に掛ける ／ excess_part: 届いた回は A のうち閾値を超えた分だけに掛ける
function successFee(step, {aYen, cumulativeBefore, periodBase}) {
  const threshold = yen(step.thresholdYen, '成功報酬の閾値');
  const rate = bps(step.rateBps, '成功報酬の率');
  const before = cumulativeBefore;
  const after = sum([cumulativeBefore, periodBase], '基礎の累計');
  const over = (v) => Math.max(0, v - threshold);
  if (step.mode === 'excess') return {amountYen: signedRateAmount(over(after), rate) - signedRateAmount(over(before), rate), cumulativeAfter: after};
  if (step.mode === 'after_recoup') {
    if (after <= threshold) return {amountYen: 0, cumulativeAfter: after};
    if (before >= threshold) return {amountYen: signedRateAmount(aYen, rate), cumulativeAfter: after};
    if (step.crossingRule === 'whole_period') return {amountYen: signedRateAmount(aYen, rate), cumulativeAfter: after};
    if (step.crossingRule === 'excess_part') return {amountYen: signedRateAmount(Math.min(aYen, over(after)), rate), cumulativeAfter: after};
    throw new Error('閾値に届く回の扱い（crossingRule: whole_period か excess_part）を指定してください');
  }
  throw new Error('成功報酬の掛け方（mode: excess か after_recoup）を指定してください');
}

// 委員会全体の式。aYen は事業の配分金の合計 A、otherIncomeYen はその他収入 B。残りは A＋B から引いていく。
// 「a」を基礎にする段（幹事手数料の a・成功報酬の after_recoup）は A だけに掛ける。priorSuccessBaseYen は前回までの成功報酬の基礎の累計。
export function calcCommittee({aYen, otherIncomeYen = 0, steps = [], priorSuccessBaseYen = 0}) {
  yen(aYen, '配分金合計');
  yen(otherIncomeYen, 'その他収入');
  yen(priorSuccessBaseYen, '成功報酬の基礎の累計');
  let remaining = sum([aYen, otherIncomeYen], 'A＋B');
  let overhead = 0;
  let managerFees = 0;
  let successBaseAfter = null;
  const out = steps.map((step, index) => {
    if (!COMMITTEE_STEP_KINDS.includes(step.kind)) throw new Error(`委員会全体の式に置けない段です（${index + 1}段目: ${step.kind}）`);
    let amountYen;
    let baseYen = null;
    if (step.kind === 'overhead') {
      amountYen = yen(step.amountYen, '委員会経費');
      overhead = sum([overhead, amountYen], '委員会経費の合計');
    } else if (step.kind === 'manager_fee') {
      if (!['a', 'remaining'].includes(step.base)) throw new Error('幹事手数料の基礎は a（配分金合計）か remaining（この時点の残り）で指定してください');
      baseYen = step.base === 'a' ? aYen : remaining;
      amountYen = signedRateAmount(baseYen, bps(step.rateBps, '幹事手数料の率'));
      managerFees = sum([managerFees, amountYen], '幹事手数料の合計');
    } else {
      baseYen = sum([aYen, otherIncomeYen, -overhead, -managerFees], '成功報酬の基礎');
      const fee = successFee(step, {aYen, cumulativeBefore: priorSuccessBaseYen, periodBase: baseYen});
      amountYen = fee.amountYen;
      successBaseAfter = fee.cumulativeAfter;
    }
    remaining = sum([remaining, -amountYen], '残り');
    return {...step, amountYen, baseYen, remainingYen: remaining};
  });
  const successBaseThisPeriod = sum([aYen, otherIncomeYen, -overhead, -managerFees], '成功報酬の基礎');
  return {
    aYen,
    otherIncomeYen,
    steps: out,
    poolYen: remaining,
    successBaseCumulativeYen: successBaseAfter ?? sum([priorSuccessBaseYen, successBaseThisPeriod], '基礎の累計'),
  };
}

// 配分原資を持分で分ける。最大剰余法（足りない1円は余りの大きい順、同じなら当事者の並び順）。和は配分原資と一致する。
export function splitToMembers(poolYen, members) {
  if (!members.length) throw new Error('当事者がありません');
  const total = members.reduce((acc, m) => acc + bps(m.shareBps, '持分'), 0);
  if (total !== 10000) throw new Error(`持分の合計が100%ではありません（${total / 100}%）`);
  // splitByAllocation は同点を ID の小さい順に割り当てるので、並び順（1始まり）を ID にして渡す
  const split = splitByAllocation(yen(poolYen, '配分原資'), members.map((m, i) => ({work_id: i + 1, allocation_bps: m.shareBps})));
  return members.map((m, i) => ({partnerId: m.partnerId, shareBps: m.shareBps, amountYen: split.get(i + 1)}));
}

// 1回分の計算。収入 = 事業ごとに引いた額 ＋ 委員会全体で引いた額 ＋ 当事者への配分、が成り立つことを確かめて返す。
export function calcRound({businesses = [], otherIncomeYen = 0, committeeSteps = [], members = [], priorSuccessBaseYen = 0}) {
  const lanes = businesses.map((b) => ({key: b.key, ...calcBusiness(b)}));
  const aYen = sum(lanes.map((l) => l.distributionYen), '配分金合計');
  const committee = calcCommittee({aYen, otherIncomeYen, steps: committeeSteps, priorSuccessBaseYen});
  const distributions = splitToMembers(committee.poolYen, members);
  const income = sum([...lanes.map((l) => l.incomeYen), otherIncomeYen], '収入の合計');
  const deducted = sum([...lanes.flatMap((l) => l.steps.map((s) => s.amountYen)), ...committee.steps.map((s) => s.amountYen)], '引いた額の合計');
  const distributed = sum(distributions.map((d) => d.amountYen), '配分の合計');
  if (sum([deducted, distributed], '引いた額と配分') !== income) throw new Error('収入と、引いた額と配分の合計が一致しません');
  return {lanes, aYen, otherIncomeYen, committee, distributions, incomeYen: income};
}
