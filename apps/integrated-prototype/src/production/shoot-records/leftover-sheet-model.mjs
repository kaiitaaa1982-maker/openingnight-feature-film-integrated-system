// 撮影の記録の「未解決」の画面（会社ルートの plans/2026-11-20-genba-inbox.md の手順 14b）の論理。DB と画面を読まない純関数。
// 受け口 GET /api/production/shoot-records/leftover の行 → 表（EditSheet）の行、変えたセル → 撮影の結果の受け口へ送る本文。
// 直せるのは移し先だけ。選ぶと、その行の最後の日へ結果を1行足す（移し先 → 順延＋移し先、欠番 → 欠番）。記録は追記だけなので、戻す・空にするでは何も送らない。
// 見た目の決まり: core の docs/design/integrated-system-visual.md §7。要件 FR-PROD-SCHED-099〜102
import {RESULT_LABELS} from './shoot-records-model.mjs';
import {SCENE_STATE_LABELS} from './scene-states-model.mjs';

// 画面の切り替え（URL の view。ホームの「撮り残したシーン」は view=leftover で開く）
export const SHOOT_VIEWS = Object.freeze([{id: 'records', label: '記録'}, {id: 'leftover', label: '未解決'}]);
export const viewOf = (param) => (param === 'leftover' ? 'leftover' : 'records');

// 移し先の候補の「欠番」の値（撮影日の ID と重ならない文字）
export const DROP = 'drop';

const monthDay = (date, year) => {
  const match = String(date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(date ?? '');
  const short = `${Number(match[2])}/${match[3]}`;
  return year && Number(match[1]) === Number(year) ? short : `${match[1]}/${short}`;
};

// 移し先の候補の名前（例「11/21 3日目」）。撮影日の名前が無ければ班。今日と年が違えば年を付ける
export function dayOptionLabel(day, year) {
  return [monthDay(day.shootDate, year), day.label || day.unit || ''].filter(Boolean).join(' ');
}

// 移し先の候補: 今日以降の撮影日（受け口の upcomingDays の順）と欠番
export function moveOptions(upcomingDays = [], {year} = {}) {
  return [...upcomingDays.map((day) => ({value: String(day.id), label: dayOptionLabel(day, year)})), {value: DROP, label: '欠番'}];
}

const resultLabel = (result) => (result ? RESULT_LABELS[result] ?? result : 'なし');

// 未解決の行（受け口の rows）→ 表の行。行の鍵はシーン。移し先は空（選ぶと結果を足して、読み直すと行が消える）
export function leftoverSheetRows(rows = []) {
  return rows.map((row) => ({
    id: `scene:${row.sceneId}`, sceneId: row.sceneId, lastDayId: row.lastDayId,
    s: String(row.sceneNo ?? ''), place: row.location ?? '', from: row.lastShootDate ?? '', result: resultLabel(row.lastResult), reason: row.reasonLabel, to: '',
  }));
}

// 全シーンの行（受け口の scenes。?scenes=all のときだけ返る）→ 読むだけの表の行
export function sceneSheetRows(scenes = []) {
  return scenes.map((scene) => ({id: `scene:${scene.sceneId}`, s: String(scene.sceneNo ?? ''), place: scene.location ?? '', state: scene.state,
    label: scene.label ?? SCENE_STATE_LABELS[scene.state] ?? '', from: scene.lastShootDate ?? ''}));
}

const STATE_TONE = Object.freeze({unresolved: 'stop', shot: 'weak', upcoming: 'plain', dropped: 'weak', unassigned: 'plain'});

// 表の列（EditSheet の列の形）。直せるのは移し先だけ（ID で結ぶので候補から選ぶ）。行ごとの候補から、その行の元の日（最後の日）を外す
export function leftoverColumns({options = [], year} = {}) {
  return [
    {key: 's', label: 'S#', width: 84, readOnly: true},
    {key: 'place', label: '場所', width: 160, readOnly: true},
    {key: 'from', label: '元の日', type: 'date', year, width: 100, readOnly: true},
    {key: 'result', label: '結果', width: 96, readOnly: true, badge: () => 'plain'},
    {key: 'reason', label: '理由', width: 104, readOnly: true, badge: () => 'stop'},
    {key: 'to', label: '移し先', type: 'lookup', width: 170, options, candidatesFor: (row) => options.filter((option) => option.value !== String(row.lastDayId))},
  ];
}

export function sceneColumns({year} = {}) {
  return [
    {key: 's', label: 'S#', width: 84},
    {key: 'place', label: '場所', width: 170},
    {key: 'label', label: '状態', width: 100, badge: (row) => STATE_TONE[row.state] ?? 'plain'},
    {key: 'from', label: '元の日', type: 'date', year, width: 100},
  ];
}

// 変えたセル（EditSheet の edits）→ 撮影の結果の受け口へ送る本文。rows は変える前の表の行。
// 戻す（action 'undo'）と、空にした移し先は送らない（記録は追記だけ。消す道を作らない）。
// 元の日と同じ撮影日は移し先にできない（候補から外しているが、貼り付けなどで来たときの歯止め。受け口も断る）ので、送らずに理由を返す
export function leftoverRequests(edits = [], rows = [], {action} = {}) {
  const requests = [];
  const errors = [];
  if (action === 'undo') return {requests, errors};
  const byKey = new Map(rows.map((row) => [row.id, row]));
  for (const edit of edits) {
    if (edit.type !== 'cell' || edit.field !== 'to') continue;
    const row = byKey.get(edit.key);
    const to = String(edit.after ?? '').trim();
    if (!row || to === '') continue;
    if (to === DROP) {
      requests.push({key: row.id, dayId: row.lastDayId, body: {sceneId: row.sceneId, result: 'dropped'}});
      continue;
    }
    const target = Number(to);
    if (!Number.isSafeInteger(target) || target <= 0) continue;
    if (target === row.lastDayId) {
      errors.push({key: row.id, message: `S#${row.s} は元の日と同じ撮影日へは移せません`});
      continue;
    }
    requests.push({key: row.id, dayId: row.lastDayId, body: {sceneId: row.sceneId, result: 'postponed', postponedToDayId: target}});
  }
  return {requests, errors};
}
