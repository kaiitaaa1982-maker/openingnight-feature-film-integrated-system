// 本人の倍率の API（行動指標の計画 段B #8。要件 kpi-scenario-forecast.md の FR-REV-KPI-013〜015）の純関数: 目標の版の持ち主（本人）の判定、
// 年の目標の倍率と額、人件費（報酬の行の12か月の合計）、年の粗利、本人の倍率（年の粗利÷年の報酬。J-5 (a)）を、期間ごとの1行にそろえる。
// 目標は src/revenue/revenue-store.mjs の readTargets（FR-REV-YOJITSU-009。額は owner 本人にだけ入る）が返した形をそのまま受け取り、計算し直さない。
// 人件費と年の粗利は呼ぶ側が期間 → 円か null で渡す。報酬の行（フェーズ1 #17）と5源泉の粗利の合成（段B #2）が無い間はどちらも null（未接続）で、
// 0円で埋めない。DB・時刻・環境変数を読まない（docs/rules/architecture.md）
import {DEFAULT_MULTIPLIER_X100, TARGET_KINDS} from '../yojitsu/yojitsu-model.mjs';
import {ratioX100} from './money-metrics.mjs';

export const SELF_MULTIPLIER_DEFINITION_VERSION = 'self-multiplier.2026-10-11';
export const SELF_MULTIPLIER_NOTES = Object.freeze({
  compensation_unconnected: '報酬の行（フェーズ1 #17）がまだ無いので、人件費・人件費×倍率の目標の額・本人の倍率は未接続（null）です',
  profit_unconnected: '5つの源泉の粗利の合成（行動指標の計画 段B #2）がまだ無いので、年の粗利と本人の倍率は未接続（null）です',
  no_compensation: '年の報酬が0円以下で割れないので、本人の倍率は null です',
  rounding_provisional: '本人の倍率は 年の粗利×100÷年の報酬 を0に向かって切り捨てた100倍の整数です（端数の処理は要確認10 で確かめるまでの仮）',
});

const known = (value) => value !== null && value !== undefined;

// 本人の倍率（100倍の整数）。年の報酬か年の粗利が分からなければ null（unconnected）、年の報酬が0円以下なら割れないので null（no_compensation）
export function selfMultiple(annualProfitYen, annualCompensationYen) {
  if (!known(annualCompensationYen) || !known(annualProfitYen)) return {x100: null, resolution: 'unconnected'};
  const x100 = ratioX100(annualProfitYen, annualCompensationYen);
  return x100 === null ? {x100: null, resolution: 'no_compensation'} : {x100, resolution: 'computed'};
}

// 読む人が持ち主（owner）の、有効な全体の目標（期間×種類ごとに1つ）。本人以外の目標・制作の取り分の目標・改めた前の版は入れない
export function ownedTargets(targets) {
  return targets.filter((t) => t.isOwner === true && t.effective === true && t.scope === 'all' && TARGET_KINDS.includes(t.kind));
}

const targetSummary = (t) => (t ? {versionNo: t.versionNo, basisKind: t.basisKind, multiplierX100: t.multiplierX100, amountYen: t.amountYen,
  resolution: t.resolution, status: t.status, decidedOn: t.decidedOn} : null);

// 期間ごとの1行。返すのは読む人が持ち主の目標がある期間だけで、1つも無ければ allowed が偽（受け口は 403 にし、ほかの値を返さない）。
// periods は [{id, yearNo, startsOn}]、targets は readTargets の有効な版、annualCompensations・annualProfits は 期間の id → 円か null の Map
export function selfMultiplierView({periods, targets, annualCompensations = new Map(), annualProfits = new Map()}) {
  const owned = ownedTargets(targets);
  if (!owned.length) return {allowed: false};
  const rows = periods.filter((p) => owned.some((t) => t.periodId === p.id)).map((p) => {
    const of = (kind) => owned.find((t) => t.periodId === p.id && t.kind === kind);
    const annualCompensationYen = annualCompensations.get(p.id) ?? null;
    const annualProfitYen = annualProfits.get(p.id) ?? null;
    const multiple = selfMultiple(annualProfitYen, annualCompensationYen);
    return {periodId: p.id, yearNo: p.yearNo, startsOn: p.startsOn, targets: {self: targetSummary(of('self')), company: targetSummary(of('company'))},
      annualCompensationYen, compensationResolution: known(annualCompensationYen) ? 'recorded' : 'unconnected',
      annualProfitYen, profitResolution: known(annualProfitYen) ? 'computed' : 'unconnected',
      selfMultipleX100: multiple.x100, selfMultipleResolution: multiple.resolution};
  });
  const codes = [];
  if (rows.some((r) => r.compensationResolution === 'unconnected')) codes.push('compensation_unconnected');
  if (rows.some((r) => r.profitResolution === 'unconnected')) codes.push('profit_unconnected');
  if (rows.some((r) => r.selfMultipleResolution === 'no_compensation')) codes.push('no_compensation');
  if (rows.some((r) => r.selfMultipleResolution === 'computed')) codes.push('rounding_provisional');
  return {allowed: true, definitionVersion: SELF_MULTIPLIER_DEFINITION_VERSION, defaultMultiplierX100: {...DEFAULT_MULTIPLIER_X100}, periods: rows,
    notes: codes.map((code) => ({code, text: SELF_MULTIPLIER_NOTES[code]}))};
}
