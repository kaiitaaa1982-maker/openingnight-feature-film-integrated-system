// 日々スケの矛盾の確かめと食事の数（会社ルートの plans/2026-10-31-call-sheet-check.md）。AI を使わず、決まりだけで判定する純関数。
// 入力は GET /api/production の形（days・appearances・calls・daySlots）。時刻は 'YYYY-MM-DDTHH:MM' の文字列で、文字列の大小がそのまま時刻の前後になる。
// 食事の数: 食事の帯（kind 'meal'）に、入り〜バラしが重なるキャストの人数と、その日のスタッフの数を足す。
// 入りかバラしの無いキャストは数に入れず「未定」に並べる。

export const ISSUE_KINDS = Object.freeze({
  wrap_before_call: 'バラしが入りより前',
  ready_before_call: '支度完了が入りより前',
  missing_call: '出るのに入りが無い',
  call_without_scene: '入りがあるのに出ない',
  scene_before_ready: 'シーンの開始が入り・支度完了より前',
  scene_after_wrap: 'シーンの終わりがバラしより後',
});

// 1日分。day は {id, crew_count, assignments: [{scene_id, planned_start, planned_end}]}
export function checkCallSheetDay(day, {appearances = [], calls = [], daySlots = []} = {}) {
  const sceneIds = new Set(day.assignments.map((a) => a.scene_id));
  // その日に出るキャストと、出るシーンの並び
  const scenesOf = new Map();
  for (const a of appearances) {
    if (!sceneIds.has(a.scene_id)) continue;
    if (!scenesOf.has(a.character_key)) scenesOf.set(a.character_key, []);
    scenesOf.get(a.character_key).push(a.scene_id);
  }
  const callOf = new Map(calls.filter((c) => c.day_id === day.id).map((c) => [c.character_key, c]));
  const issues = [];
  const add = (kind, characterKey, sceneId = null) => issues.push({kind, characterKey, sceneId, label: ISSUE_KINDS[kind]});

  for (const [key, call] of callOf) {
    if (call.call_time && call.wrap_time && call.wrap_time <= call.call_time) add('wrap_before_call', key);
    if (call.call_time && call.ready_time && call.ready_time < call.call_time) add('ready_before_call', key);
    if (call.call_time && !scenesOf.has(key)) add('call_without_scene', key);
  }
  for (const [key, sceneList] of scenesOf) {
    const call = callOf.get(key);
    if (!call?.call_time) { add('missing_call', key); continue; }
    const start = call.ready_time || call.call_time;
    for (const sceneId of sceneList) {
      const a = day.assignments.find((x) => x.scene_id === sceneId);
      if (a.planned_start && a.planned_start < start) add('scene_before_ready', key, sceneId);
      if (a.planned_end && call.wrap_time && a.planned_end > call.wrap_time) add('scene_after_wrap', key, sceneId);
    }
  }

  // 数える相手は、その日に出るキャストと、入りの行があるキャスト
  const people = [...new Set([...scenesOf.keys(), ...callOf.keys()])].sort();
  const crew = Number.isInteger(day.crew_count) ? day.crew_count : null;
  const meals = daySlots.filter((s) => s.day_id === day.id && s.kind === 'meal').map((slot) => {
    const base = {key: slot.key, label: slot.label, start: slot.planned_start || null, end: slot.planned_end || null, crew};
    if (!slot.planned_start || !slot.planned_end) return {...base, cast: [], unknown: people, castCount: null, total: null};
    const cast = [], unknown = [];
    for (const key of people) {
      const call = callOf.get(key);
      if (!call?.call_time || !call?.wrap_time) { unknown.push(key); continue; }
      if (call.call_time < slot.planned_end && call.wrap_time > slot.planned_start) cast.push(key);
    }
    return {...base, cast, unknown, castCount: cast.length, total: cast.length + (crew ?? 0)};
  });
  return {dayId: day.id, issues, meals, crewMissing: crew == null};
}

// 全日分
export function checkCallSheets(production) {
  return (production.days || []).map((day) => checkCallSheetDay(day, production));
}
