// 撮影の記録の「全シーン」（未解決の画面のシート。会社ルートの plans/2026-11-20-genba-inbox.md の手順 14b）。DB を読まない純関数。
// 作品のシーンを1つずつ未解決の引き算（leftover-model.mjs の deriveLeftover）に通し、件数のどこに数えられたかで札を決める。
// 引き算の決まりはここに写さない（同じ関数を通すので、未解決の表・ホームの件数と食い違わない）。
// どこにも数えられないシーン（どの撮影日にも割り当てていない）は「未割当」にして、全シーンの数と札の数の和をそろえる（取りこぼしを見せる）。
import {deriveLeftover} from './leftover-model.mjs';

export const SCENE_STATES = Object.freeze(['unresolved', 'shot', 'upcoming', 'dropped', 'unassigned']);
// 札は1〜4字（見た目の決まり docs/design/integrated-system-visual.md §1）
export const SCENE_STATE_LABELS = Object.freeze({unresolved: '未解決', shot: '撮れた', upcoming: '予定', dropped: '欠番', unassigned: '未割当'});

// シーンごとの行だけを渡す（引き算はシーンごとに閉じているので、ほかのシーンの行を渡しても結果は変わらない。渡さない分だけ速い）
function bySceneId(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = Number(row.scene_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

// scenes・days・assignments・results・today は deriveLeftover と同じ形。返すのは scenes の並びのまま、シーンごとの札と、未解決なら最後の撮影日
export function sceneStates({scenes, days, assignments, results, today}) {
  const assigned = bySceneId(assignments);
  const recorded = bySceneId(results);
  return scenes.map((scene) => {
    const id = Number(scene.id);
    const {rows, counts} = deriveLeftover({scenes: [scene], days, assignments: assigned.get(id) ?? [], results: recorded.get(id) ?? [], today});
    const state = counts.unresolved ? 'unresolved' : counts.shot ? 'shot' : counts.upcoming ? 'upcoming' : counts.dropped ? 'dropped' : 'unassigned';
    return {sceneId: id, sceneNo: scene.scene_no, location: scene.location ?? null, state, label: SCENE_STATE_LABELS[state], lastShootDate: rows[0]?.lastShootDate ?? null};
  });
}

// 札ごとの数（全シーンのシートの式「撮れた＋予定＋欠番＋未解決＋未割当＝計」）
export function sceneStateCounts(states) {
  const counts = Object.fromEntries(SCENE_STATES.map((state) => [state, 0]));
  for (const row of states) counts[row.state] += 1;
  return {...counts, total: states.length};
}
