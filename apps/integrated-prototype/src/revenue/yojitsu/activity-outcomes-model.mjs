// 結果を明示した活動の案件×親の段ごとの集計。同じ期間の最新の結果を使う。
// 2026-10-15代表裁定: 進んだを分子、進んだ・保留・失注を分母とし、内訳を並べる。
import {ratioBps} from './money-yojitsu.mjs';
import {ACTIVITY_RESULTS} from './activity-model.mjs';

export function activityOutcomeSummary(rows, {steps, from = null, to = null}) {
  const parents = new Map(steps.map((s) => [s.code, s.parent_code ?? s.code]));
  const latest = new Map();
  let unverifiedCount = 0;
  for (const row of rows) {
    if ((from && row.occurred_on < from) || (to && row.occurred_on > to)) continue;
    if (!ACTIVITY_RESULTS.includes(row.result)) { unverifiedCount += 1; continue; }
    const step = parents.get(row.step);
    if (!step || !row.earning_type) continue;
    const key = `${row.project_id}|${row.earning_type}|${step}`;
    const before = latest.get(key);
    if (!before || row.occurred_on > before.occurred_on || (row.occurred_on === before.occurred_on && Number(row.id) > Number(before.id))) latest.set(key, {...row, step});
  }
  const groups = new Map();
  for (const row of latest.values()) {
    const key = `${row.earning_type}|${row.step}`;
    if (!groups.has(key)) groups.set(key, {earningType: row.earning_type, step: row.step, advanced: 0, onHold: 0, lost: 0});
    groups.get(key)[{advanced: 'advanced', on_hold: 'onHold', lost: 'lost'}[row.result]] += 1;
  }
  return {rows: [...groups.values()].map((g) => {
    const denominator = g.advanced + g.onHold + g.lost;
    return {...g, numerator: g.advanced, denominator, rateBps: ratioBps(g.advanced, denominator)};
  }).sort((a, b) => a.earningType.localeCompare(b.earningType) || a.step.localeCompare(b.step)), unverifiedCount};
}
