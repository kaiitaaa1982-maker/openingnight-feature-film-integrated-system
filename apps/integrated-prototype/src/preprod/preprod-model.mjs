// プリプロダクション（フォルダ原案 F03）の画面とオールスタッフの資料を、既存の制作の表から導く純関数。
// 正本は会社ルートの plans/2026-10-22-folder-preprod.md。状態の列は持たず、読むたびに導く。
// 入力は GET /api/production・GET /api/workflow/scripts・GET /api/field の返り値（新しい表は使わない第一切れ）。

export const PREPROD_FOLDERS = Object.freeze([
  Object.freeze({id: 'F03-01', label: '脚本'}),
  Object.freeze({id: 'F03-02', label: '台本'}),
  Object.freeze({id: 'F03-03', label: '香盤'}),
  Object.freeze({id: 'F03-04', label: '日々スケ'}),
  Object.freeze({id: 'F03-05', label: '衣装'}),
  Object.freeze({id: 'F03-06', label: 'ロケ地'}),
  Object.freeze({id: 'F03-07', label: 'キャスト'}),
]);

// 手配と美術の種類と状態の名前（画面と受け口の両方で使う）
export const ARRANGEMENT_KINDS = Object.freeze({camera: '撮影機材', grip: '特機', lighting: '照明', sound: '録音機材', truck: 'トラック', location_bus: 'ロケバス', vehicle: '車両・ドライバー', other: 'その他'});
export const ARRANGEMENT_STATES = Object.freeze({hold: '仮押さえ', confirmed: '確定', cancelled: '取消'});
export const ART_KINDS = Object.freeze({dressing: '飾り', prop: '小道具', build: '作り物'});
export const ART_STATES = Object.freeze({open: '未決', arranging: '手配中', done: '済', cancelled: '取消'});

const DAY_MS = 86400000;
const pagesText = (eighths) => {
  if (!eighths) return '0';
  const whole = Math.floor(eighths / 8), rest = eighths % 8;
  return rest ? `${whole} ${rest}/8` : String(whole);
};
export {pagesText};

function sceneMaps(production) {
  const scenes = production?.scenes || [];
  const days = (production?.days || []).slice().sort((a, b) => String(a.shoot_date).localeCompare(String(b.shoot_date)) || String(a.unit).localeCompare(String(b.unit)) || a.id - b.id);
  const assigned = new Map();
  for (const day of days) for (const a of day.assignments || []) {
    if (!assigned.has(a.scene_id)) assigned.set(a.scene_id, []);
    assigned.get(a.scene_id).push(day);
  }
  return {scenes, days, assigned};
}

// 出演（シーン×役）ごとに、その役のルックがシーンに割り当てられているか
export function costumeGaps(production) {
  const looks = new Map((production?.looks || []).map((l) => [l.key, l]));
  const have = new Set((production?.sceneLooks || []).map((sl) => `${sl.scene_id}|${looks.get(sl.look_key)?.character_key}`));
  const gaps = (production?.appearances || []).filter((a) => !have.has(`${a.scene_id}|${a.character_key}`));
  return {pairs: gaps.length, scenes: new Set(gaps.map((g) => g.scene_id)).size, rows: gaps};
}

// 役ごとの出番の日数（拘束日数。FR-PROD-SCHED-038 の数え方: 出番のある撮影日の数）
export function characterDays(production) {
  const {assigned} = sceneMaps(production);
  const out = new Map();
  for (const a of production?.appearances || []) {
    const set = out.get(a.character_key) || new Set();
    for (const day of assigned.get(a.scene_id) || []) set.add(day.id);
    out.set(a.character_key, set);
  }
  return new Map([...out].map(([k, v]) => [k, v.size]));
}

export function scriptStatus(scripts) {
  const rows = scripts || [];
  if (!rows.length) return {state: 'not_started', text: '未', reason: '台本の原本が無い'};
  if (rows.some((r) => r.commit_id)) return {state: 'done', text: '済', reason: '撮影に使う台本が香盤に確定済み'};
  if (rows.some((r) => r.review_id)) return {state: 'in_progress', text: '承認済', reason: '確認済みの版はあるが、香盤に未確定'};
  return {state: 'needs_review', text: '要確認', reason: '読み取った台本を確かめていない'};
}

// 手配・美術・撮影の方針の噛み合い（資料の「決めること」）。plans は GET /api/preprod/works/:id/plans の返り値
export function planChecks({production, plans, today}) {
  if (!plans) return [];
  const {scenes, days, assigned} = sceneMaps(production);
  const live = (plans.arrangements || []).filter((a) => a.state !== 'cancelled');
  const out = [];
  const lateHold = live.filter((a) => a.state === 'hold' && a.deadline_on && a.deadline_on < today);
  if (lateHold.length) out.push({key: 'arr-deadline', text: '締切を過ぎた仮押さえの手配', count: lateHold.length, detail: lateHold.map((a) => a.item).join('・'), view: 'doc'});
  // 全日に要る手配（撮影機材・録音機材・トラック）は、撮影日が期間の外なら噛み合わない
  const allDays = live.filter((a) => ['camera', 'sound', 'truck'].includes(a.kind) && a.starts_on && a.ends_on);
  const outside = [];
  for (const a of allDays) for (const d of days) if ((d.assignments || []).length && (d.shoot_date < a.starts_on || d.shoot_date > a.ends_on)) outside.push(`${a.item} ${Number(d.shoot_date.slice(5, 7))}/${Number(d.shoot_date.slice(8, 10))}`);
  // シーンの撮影の方針の「要る機材」に手配の品目が書いてあれば、そのシーンの撮影日が手配の期間の中か確かめる
  const plansByScene = new Map((plans.shootPlans || []).map((p) => [p.scene_id, p]));
  for (const a of live.filter((x) => x.starts_on && x.ends_on)) for (const s of scenes) {
    const eq = plansByScene.get(s.id)?.equipment || '';
    if (!eq.includes(a.item)) continue;
    for (const d of assigned.get(s.id) || []) if (d.shoot_date < a.starts_on || d.shoot_date > a.ends_on) outside.push(`S#${s.scene_no} ${a.item}`);
  }
  if (outside.length) out.push({key: 'arr-period', text: '手配の期間の外の撮影', count: outside.length, detail: outside.slice(0, 6).join('・'), view: 'doc'});
  const art = (plans.artItems || []).filter((a) => a.state !== 'cancelled');
  const openArt = art.filter((a) => a.state === 'open');
  if (openArt.length) out.push({key: 'art-open', text: '未決の美術', count: openArt.length, detail: openArt.map((a) => a.content).join('・'), view: 'doc'});
  const lateArt = art.filter((a) => a.delivery_on && a.scene_id && (assigned.get(a.scene_id) || []).some((d) => d.shoot_date < a.delivery_on));
  if (lateArt.length) out.push({key: 'art-late', text: '搬入が撮影に間に合わない美術', count: lateArt.length, detail: lateArt.map((a) => a.content).join('・'), view: 'doc'});
  return out;
}

// 1作品のプリプロの状況。today は 'YYYY-MM-DD'
export function preprodSummary({production, scripts, field, plans, today}) {
  const {scenes, days, assigned} = sceneMaps(production);
  const details = new Map(scenes.map((s) => [s.id, s]));
  const unassigned = scenes.filter((s) => !assigned.has(s.id));
  const noLocation = scenes.filter((s) => !details.get(s.id)?.location_key);
  const noMinutes = scenes.filter((s) => !s.estimated_minutes);
  const locations = production?.locations || [];
  const locNoAddress = locations.filter((l) => !String(l.address || '').trim());
  const characters = production?.characters || [];
  const noActor = characters.filter((c) => !String(c.actor_name || '').trim());
  const gap = costumeGaps(production);
  const timedDays = days.filter((d) => (d.assignments || []).length && (d.assignments || []).every((a) => a.planned_start));
  const tasks = (field?.tasks || []).filter((t) => t.status !== 'ready');
  const overdueTasks = tasks.filter((t) => t.due_on && t.due_on < today);
  const pageTotal = scenes.reduce((n, s) => n + (Number(s.page_eighths) || 0), 0);
  const future = days.map((d) => d.shoot_date).filter((d) => d >= today).sort();
  const untilShoot = future.length ? Math.round((Date.parse(`${future[0]}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) : null;
  const script = scriptStatus(scripts);

  const folders = [
    {id: 'F03-01', ...((scripts || []).length ? {state: 'in_progress', text: `稿 ${(scripts || []).length}`} : {state: 'not_started', text: '未'}), tab: null},
    {id: 'F03-02', state: script.state, text: script.text, reason: script.reason, page: '台本・香盤'},
    {id: 'F03-03', ...(!scenes.length ? {state: 'not_started', text: '未'} : unassigned.length ? {state: 'needs_review', text: `未割当 ${unassigned.length}`} : {state: 'done', text: '済'}), page: '制作', tab: 'kouban'},
    {id: 'F03-04', ...(!days.length ? {state: 'not_started', text: '未'} : timedDays.length < days.length ? {state: 'in_progress', text: `${timedDays.length}/${days.length}`} : {state: 'done', text: '済'}), page: '制作', tab: 'day'},
    {id: 'F03-05', ...(!(production?.appearances || []).length ? {state: 'not_started', text: '未'} : gap.scenes ? {state: 'needs_review', text: `不足 ${gap.scenes}`} : {state: 'done', text: '済'}), page: '制作', tab: 'costume'},
    {id: 'F03-06', ...(!scenes.length ? {state: 'not_started', text: '未'} : (noLocation.length || locNoAddress.length) ? {state: 'needs_review', text: `未設定 ${noLocation.length + locNoAddress.length}`} : {state: 'done', text: '済'}), page: '制作', tab: 'location'},
    {id: 'F03-07', ...(!characters.length ? {state: 'not_started', text: '未'} : noActor.length ? {state: 'needs_review', text: `未入力 ${noActor.length}`} : {state: 'done', text: '済'}), page: '制作', tab: 'kouban'},
  ].map((f) => ({...f, label: PREPROD_FOLDERS.find((x) => x.id === f.id).label}));

  const todos = [];
  if (script.state === 'needs_review') todos.push({key: 'script', text: '読み取った台本を確かめていない', count: (scripts || []).filter((r) => !r.review_id).length, page: '台本・香盤'});
  if (unassigned.length) todos.push({key: 'unassigned', text: '撮影日に入っていないシーン', count: unassigned.length, detail: unassigned.slice(0, 8).map((s) => `S#${s.scene_no}`).join('・'), page: '制作', tab: 'kouban'});
  if (noMinutes.length) todos.push({key: 'minutes', text: '予定分が未入力のシーン', count: noMinutes.length, page: '制作', tab: 'kouban'});
  if (gap.scenes) todos.push({key: 'costume', text: '衣装が割り当たっていないシーン', count: gap.scenes, page: '制作', tab: 'costume'});
  if (noLocation.length) todos.push({key: 'location', text: 'ロケ地が未設定のシーン', count: noLocation.length, page: '制作', tab: 'location'});
  if (locNoAddress.length) todos.push({key: 'address', text: '住所が未入力のロケ地', count: locNoAddress.length, detail: locNoAddress.map((l) => l.name).join('・'), page: '制作', tab: 'location'});
  if (noActor.length) todos.push({key: 'actor', text: '俳優が未入力の役', count: noActor.length, detail: noActor.map((c) => c.name).join('・'), page: '制作', tab: 'kouban'});
  if (overdueTasks.length) todos.push({key: 'tasks', text: '期限を過ぎた準備タスク', count: overdueTasks.length, page: '制作', tab: 'prep'});
  todos.push(...planChecks({production, plans, today}));

  // F03 の済: 撮影に使う台本が香盤に確定し、未割当が 0（問い3 A）
  const done = script.state === 'done' && scenes.length > 0 && unassigned.length === 0;
  return {
    folders, todos, done,
    numbers: {scenes: scenes.length, days: days.length, pages: pageTotal, untilShoot, firstDay: days[0]?.shoot_date || null, lastDay: days[days.length - 1]?.shoot_date || null, locations: locations.length, characters: characters.length},
  };
}

// 全業務の共通の口（調整役の X-16）に合わせた形。第一切れは画面の中で使う
export function folderStatus(summary) {
  const doneCount = summary.folders.filter((f) => f.state === 'done').length;
  const state = summary.done ? 'done' : summary.todos.length ? 'needs_review' : summary.folders.every((f) => f.state === 'not_started') ? 'not_started' : 'in_progress';
  return {folderId: 'F03', state, done: doneCount, total: summary.folders.length, reason: summary.todos.map((t) => `${t.text} ${t.count}`).join('・')};
}

// オールスタッフ／美術打ち合わせの資料。章ごとに行を返す（表示と書き出しは画面）
export function meetingDocument({production, scripts, field, plans, today}) {
  const summary = preprodSummary({production, scripts, field, plans, today});
  const shootPlans = new Map((plans?.shootPlans || []).map((p) => [p.scene_id, p]));
  const {scenes, days} = sceneMaps(production);
  const byScene = new Map(scenes.map((s) => [s.id, s]));
  const locs = new Map((production?.locations || []).map((l) => [l.key, l]));
  const chars = new Map((production?.characters || []).map((c) => [c.key, c]));
  const looks = new Map((production?.looks || []).map((l) => [l.key, l]));
  const castOf = (sceneId) => (production?.appearances || []).filter((a) => a.scene_id === sceneId).map((a) => chars.get(a.character_key)?.short_name || chars.get(a.character_key)?.name).filter(Boolean);
  const looksOf = (sceneId) => (production?.sceneLooks || []).filter((s) => s.scene_id === sceneId).map((s) => {const l = looks.get(s.look_key); return l ? `${chars.get(l.character_key)?.short_name || chars.get(l.character_key)?.name || ''} ${l.label}`.trim() : null;}).filter(Boolean);
  const dayRows = days.map((d) => {
    const items = (d.assignments || []).slice().sort((a, b) => a.sequence_order - b.sequence_order).map((a) => byScene.get(a.scene_id)).filter(Boolean);
    const locNames = [...new Set(items.map((s) => locs.get(s.location_key)?.name || s.location).filter(Boolean))];
    return {id: d.id, date: d.shoot_date, unit: d.unit, label: d.label, notes: d.notes || '', scenes: items.map((s) => s.scene_no), locations: locNames,
      dayNight: [...new Set(items.map((s) => s.day_night).filter(Boolean))].join('・'), pages: items.reduce((n, s) => n + (Number(s.page_eighths) || 0), 0), minutes: items.reduce((n, s) => n + (Number(s.estimated_minutes) || 0), 0),
      reserve: /予備/.test(`${d.label} ${d.notes || ''}`)};
  });
  const cd = characterDays(production);
  return {
    summary,
    cover: {firstDay: summary.numbers.firstDay, lastDay: summary.numbers.lastDay, days: days.length, reserveDays: dayRows.filter((d) => d.reserve).length, scenes: scenes.length, pages: summary.numbers.pages},
    decisions: summary.todos,
    schedule: dayRows,
    scenes: scenes.map((s) => ({id: s.id, methods: shootPlans.get(s.id)?.methods || '', equipment: shootPlans.get(s.id)?.equipment || '', no: s.scene_no, location: locs.get(s.location_key)?.name || s.location || '', dayNight: s.day_night || '', cast: castOf(s.id), looks: looksOf(s.id), pages: Number(s.page_eighths) || 0, minutes: Number(s.estimated_minutes) || 0, synopsis: s.synopsis || '', note: s.note || '', days: dayRows.filter((d) => d.scenes.includes(s.scene_no)).map((d) => d.date)})),
    locations: (production?.locations || []).map((l) => ({name: l.name, address: l.address || '', greenRoom: l.green_room || '', parking: l.parking || '', facilities: l.facilities || '', contact: l.contact ? '有' : '', days: dayRows.filter((d) => d.locations.includes(l.name)).map((d) => d.date)})),
    cast: (production?.characters || []).map((c) => ({role: c.name, actor: c.actor_name || '', days: cd.get(c.key) || 0, looks: (production?.looks || []).filter((l) => l.character_key === c.key).map((l) => l.label)})),
    tasks: (field?.tasks || []).filter((t) => t.status !== 'ready').map((t) => ({title: t.title, owner: t.owner_label || '', due: t.due_on || '', status: t.status})),
    arrangements: (plans?.arrangements || []).slice().sort((a, b) => String(a.starts_on || '9999').localeCompare(String(b.starts_on || '9999')) || a.kind.localeCompare(b.kind)),
    art: (plans?.artItems || []).map((a) => ({...a, scene_no: byScene.get(a.scene_id)?.scene_no || ''})).sort((a, b) => String(a.scene_no).localeCompare(String(b.scene_no), 'ja', {numeric: true})),
  };
}
