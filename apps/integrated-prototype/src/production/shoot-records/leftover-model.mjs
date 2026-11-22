// 未解決のシーン（撮り残し）の引き算（会社ルートの plans/2026-11-20-genba-inbox.md の手順 6a。brain の D-031 の2・3 を過ぎた撮影日まで広げたもの・D-047）。
// DB を読まない純関数。AI は判断しない: 台本のシーンを「撮れた・欠番・これから撮る」に分け、どれにも入らないものを未解決とする。
// - シーンが入っている日: 割り当てた日・結果の行がある日・順延の移し先の日（撮影日ごとの最新の結果で見る）
// - その日の状態: その日の最新の結果。結果の行が無ければ日々スケの撮影実績の区分（planned 以外）。どちらも無ければ状態なし
// - 今日以降の入っている日に状態なしの日があれば、これから撮る。無ければ、撮影日の日付の順で最後の日の状態で決める
// 最後は記入の順でなく撮影日の日付の順で決める（作品の進み workProgress・SCHED-034 は記入の順）。記入が遅れても撮れていないシーンが消えない、残る向きに倒す。
// どの撮影日にも割り当てていないシーンは出さない（ホームの「撮影日に割り当てていないシーン」が拾う。二重に出さない）。
import {latestBy} from './shoot-records-model.mjs';

// 未解決の理由（札は1〜4字。見た目の決まり docs/design/integrated-system-visual.md §1）
export const LEFTOVER_REASONS = Object.freeze({
  no_result: '結果なし', // 最後の日が過ぎていて、その日の状態が無い（順延の移し先でもない）
  no_target: '移先未定', // 最後の日の状態が順延（日々スケの区分 not_shot を含む）で、移し先が決まっていない
  target_passed: '期限切れ', // 最後の日の状態が移し先つきの順延か、最後の日が順延の移し先で、過ぎたのに状態が無い
  partial: '一部', // 最後の日の状態が一部
});

const dayKey = (dayId, sceneId) => `${Number(dayId)}:${Number(sceneId)}`;
// 日々スケの撮影実績の区分（day_scene_assignments.outcome）を、その日の状態に読み替える。planned は状態なし
const OUTCOME_STATE = Object.freeze({shot: 'shot', partial: 'partial', not_shot: 'postponed'});

// scenes: {id, work_id, scene_no, location, status}、days: {id, shoot_date}、assignments: {shooting_day_id, scene_id, outcome}、
// results: shooting_scene_results の行（id・shooting_day_id・scene_id・seq・result・postponed_to_day_id）。today は YYYY-MM-DD（日本時間）。
// 返すのは、未解決の行（scenes の並びのまま）と件数（未解決・撮れた・これから撮る・欠番）。割り当ての無いシーンは、撮れた・欠番のほかは数えない
export function deriveLeftover({scenes, days, assignments, results, today}) {
  const dayById = new Map(days.map((day) => [Number(day.id), day]));
  const latest = latestBy(results, (row) => dayKey(row.shooting_day_id, row.scene_id));
  const outcomes = new Map(assignments.map((row) => [dayKey(row.shooting_day_id, row.scene_id), row.outcome]));
  const assigned = new Set(assignments.map((row) => Number(row.scene_id)));
  const placed = new Map(), targeted = new Map();
  const add = (map, sceneId, dayId) => {
    if (!dayById.has(Number(dayId))) return;
    const set = map.get(sceneId) ?? new Set();
    set.add(Number(dayId));
    map.set(sceneId, set);
  };
  for (const row of assignments) add(placed, Number(row.scene_id), row.shooting_day_id);
  for (const row of latest.values()) {
    add(placed, Number(row.scene_id), row.shooting_day_id);
    if (row.result === 'postponed' && row.postponed_to_day_id != null) {
      add(placed, Number(row.scene_id), row.postponed_to_day_id);
      add(targeted, Number(row.scene_id), row.postponed_to_day_id);
    }
  }
  // その日の状態: {result, to}（to は順延の移し先）か null
  const stateOf = (dayId, sceneId) => {
    const row = latest.get(dayKey(dayId, sceneId));
    if (row) return {result: row.result, to: row.postponed_to_day_id == null ? null : Number(row.postponed_to_day_id)};
    const result = OUTCOME_STATE[outcomes.get(dayKey(dayId, sceneId))];
    return result ? {result, to: null} : null;
  };

  const counts = {unresolved: 0, shot: 0, upcoming: 0, dropped: 0};
  const rows = [];
  for (const scene of scenes) {
    const sceneId = Number(scene.id);
    const entries = [...(placed.get(sceneId) ?? [])].map((dayId) => ({day: dayById.get(dayId), state: stateOf(dayId, sceneId)}))
      .sort((a, b) => String(a.day.shoot_date).localeCompare(String(b.day.shoot_date)) || Number(a.day.id) - Number(b.day.id));
    // 決まり8: どの日にも状態が無く、シーンの状態が撮影済みなら撮れた
    if (entries.every((entry) => !entry.state) && scene.status === 'shot') { counts.shot += 1; continue; }
    const last = entries.at(-1) ?? null;
    const upcoming = entries.some((entry) => entry.day.shoot_date >= today && !entry.state);
    if (!upcoming && last?.state?.result === 'shot') { counts.shot += 1; continue; }
    if (!upcoming && last?.state?.result === 'dropped') { counts.dropped += 1; continue; }
    if (!assigned.has(sceneId)) continue;
    if (upcoming) { counts.upcoming += 1; continue; }
    if (!last) continue;
    const state = last.state;
    const reason = !state ? (targeted.get(sceneId)?.has(Number(last.day.id)) ? 'target_passed' : 'no_result')
      : state.result === 'partial' ? 'partial' : state.to == null ? 'no_target' : 'target_passed';
    counts.unresolved += 1;
    rows.push({sceneId, workId: scene.work_id == null ? null : Number(scene.work_id), sceneNo: scene.scene_no, location: scene.location ?? null,
      reason, reasonLabel: LEFTOVER_REASONS[reason], lastDayId: Number(last.day.id), lastShootDate: last.day.shoot_date, lastResult: state?.result ?? null});
  }
  return {rows, counts};
}

// 順延の移し先に選べる日: 今日以降の撮影日（日付・班の順）
export const upcomingDays = (days, today) => days.filter((day) => day.shoot_date >= today)
  .sort((a, b) => String(a.shoot_date).localeCompare(String(b.shoot_date)) || String(a.unit ?? '').localeCompare(String(b.unit ?? '')) || Number(a.id) - Number(b.id));
