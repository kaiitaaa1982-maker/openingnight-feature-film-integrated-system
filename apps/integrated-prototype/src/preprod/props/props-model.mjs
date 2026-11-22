// 小道具の品目と打ち合わせの判定と並べ方（純関数。移行 0061。会社ルートの plans/2026-11-09-props-meeting.md、画面は案A＋案B）。
// DB・時刻・環境変数を読まない。受け口・画面・取込のスクリプトが同じ判定を使う。

export const PROP_KINDS = Object.freeze({hand: '持ち道具', consumable: '消え物', dressing: '装飾', costume: '衣装', vehicle: '車両', other: 'その他'});
export const PROP_DEPARTMENTS = Object.freeze({production: '制作部', producer: 'プロデューサー部', direction: '演出部', art: '美術', costume: '衣装', other: 'その他'});
export const PROP_STATES = Object.freeze({unassigned: '未割当', adjust: '要調整', arranging: '手配中', ready: '用意済み', unneeded: '不要'});
export const PROP_SOURCES = Object.freeze({script: '台本', meeting: '打合せ', both: '両方', callsheet: '日々スケ', manual: '手入力'});
// 打ち合わせで決める品目（案B の左の列に並ぶ）
export const OPEN_STATES = Object.freeze(['unassigned', 'adjust']);
// 取込は1回の batch（品目1件に2文）で書くので、文の数を抑える
export const IMPORT_LIMIT = 300;

const DATE = /^\d{4}-\d\d-\d\d$/;
export function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const text = (v, label, max, required = false) => {
  if (v != null && typeof v !== 'string') throw Error(`${label}を確認してください`);
  const s = (v || '').trim();
  if (s.length > max || (required && !s)) throw Error(`${label}を確認してください`);
  return s || null;
};
const date = (v, label) => { const s = text(v, label, 10); if (s && !isDate(s)) throw Error(`${label}を確認してください`); return s; };
const pick = (v, map, label, fallback) => {
  const s = v == null || v === '' ? fallback : v;
  if (typeof s !== 'string' || !Object.hasOwn(map, s)) throw Error(`${label}を確認してください`);
  return s;
};
const optPick = (v, map, label) => (v == null || v === '' ? null : pick(v, map, label));

// 版の中身（画面・取込の本文 → 表の列）。未割当は部署を持たない（表の CHECK と同じ）
export function normalizeVersion(input = {}) {
  const out = {
    scene_label: text(input.sceneLabel, 'シーン', 60), shoot_on: date(input.shootOn, '撮影日'), place: text(input.place, '場面', 120),
    name: text(input.name, '品目', 200, true), quantity: text(input.quantity, '数', 40), kind: pick(input.kind, PROP_KINDS, '種別', 'hand'),
    department: optPick(input.department, PROP_DEPARTMENTS, '部署'), owner_label: text(input.ownerLabel, '担当', 80),
    state: pick(input.state, PROP_STATES, '状態', 'unassigned'), next_action: text(input.nextAction, '次の行動', 300), due_on: date(input.dueOn, '期限'),
    source: pick(input.source, PROP_SOURCES, '出典', 'manual'), script_note: text(input.scriptNote, '台本の記述', 500), memo: text(input.memo, 'メモ', 1000),
  };
  if (out.state === 'unassigned' && out.department) throw Error('部署を決めたら状態を未割当から変えてください');
  return out;
}

// 表の列 → 画面・取込の本文（版を写して一部を変えるとき）
export const versionInput = (v) => ({sceneLabel: v.scene_label, shootOn: v.shoot_on, place: v.place, name: v.name, quantity: v.quantity, kind: v.kind,
  department: v.department, ownerLabel: v.owner_label, state: v.state, nextAction: v.next_action, dueOn: v.due_on, source: v.source,
  scriptNote: v.script_note, memo: v.memo});

export function normalizeMeeting(input = {}) {
  const heldOn = text(input.heldOn, '日付', 10, true);
  if (!isDate(heldOn)) throw Error('日付を確認してください');
  const list = Array.isArray(input.departments) ? input.departments : [];
  for (const d of list) pick(d, PROP_DEPARTMENTS, '出た部署');
  return {held_on: heldOn, title: text(input.title, '題', 120, true), departments: list.length ? [...new Set(list)].join(',') : null, note: text(input.note, 'メモ', 2000)};
}

// 品目ごとの最新の版
export function latestVersions(rows) {
  const map = new Map();
  for (const row of rows) { const prev = map.get(row.item_id); if (!prev || row.version_no > prev.version_no) map.set(row.item_id, row); }
  return map;
}

// 一覧の1行
export function propRow({item, version}) {
  return {
    id: item.id, key: item.item_key, workId: item.work_id, versionNo: version.version_no,
    sceneLabel: version.scene_label, shootOn: version.shoot_on, place: version.place, name: version.name, quantity: version.quantity,
    kind: version.kind, department: version.department, ownerLabel: version.owner_label, state: version.state,
    nextAction: version.next_action, dueOn: version.due_on, source: version.source, scriptNote: version.script_note, memo: version.memo,
    meetingId: version.meeting_id ?? null, updatedAt: version.created_at,
  };
}

export const needsDecision = (row) => OPEN_STATES.includes(row.state);

// 「#31・#32」「#18〜#22」「#6Fla」から並べるための先頭の番号。番号が無ければ大きな値
export function sceneOrder(label) {
  const m = /(\d+)/.exec(label || '');
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// 撮影日（無いものは最後）→ シーンの先頭の番号 → 登録の順
export function sortRows(rows) {
  return [...rows].sort((a, b) => (a.shootOn || '9999').localeCompare(b.shootOn || '9999') || sceneOrder(a.sceneLabel) - sceneOrder(b.sceneLabel) || a.id - b.id);
}

// 案A の絞り込み（null と空は絞らない）。department に 'none' を渡すと部署の無い品目
export function filterRows(rows, {shootOn = null, department = null, state = null, kind = null, text: q = null} = {}) {
  const needle = (q || '').trim();
  return rows.filter((r) => (!shootOn || (shootOn === 'none' ? !r.shootOn : r.shootOn === shootOn))
    && (!department || (department === 'none' ? !r.department : r.department === department))
    && (!state || r.state === state) && (!kind || r.kind === kind)
    && (!needle || [r.name, r.sceneLabel, r.place, r.ownerLabel, r.nextAction, r.memo].some((v) => (v || '').includes(needle))));
}

// 案B の左の列: 決める品目を、未割当を先に、撮影日とシーンの順に
export function meetingQueue(rows, {all = false} = {}) {
  const list = all ? rows : rows.filter(needsDecision);
  return sortRows(list).sort((a, b) => Number(b.state === 'unassigned') - Number(a.state === 'unassigned'));
}

// 状態ごとの数（赤の「要確認」は未割当と要調整の合計）
export function stateCounts(rows) {
  const counts = Object.fromEntries(Object.keys(PROP_STATES).map((k) => [k, 0]));
  for (const r of rows) counts[r.state] += 1;
  return {...counts, open: counts.unassigned + counts.adjust};
}

// 打ち合わせで決めたこと: その回の版を、版を足した順に1行ずつ
export function meetingDecisions(versions, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  return [...versions].sort((a, b) => a.id - b.id).map((v) => ({
    itemId: v.item_id, key: byId.get(v.item_id)?.item_key ?? null, versionNo: v.version_no, sceneLabel: v.scene_label, name: v.name,
    state: v.state, department: v.department, ownerLabel: v.owner_label, nextAction: v.next_action, dueOn: v.due_on, quantity: v.quantity,
  }));
}

// 取込の JSON の検査。{items:[{key, ...版の本文}]}。問題があれば problems に並べ、1件も書かない
export function checkImport(source) {
  const problems = [];
  const items = Array.isArray(source?.items) ? source.items : null;
  if (!items) return {problems: [{index: null, message: 'items（品目の並び）がありません'}], rows: []};
  if (!items.length) problems.push({index: null, message: '品目が1件もありません'});
  if (items.length > IMPORT_LIMIT) problems.push({index: null, message: `一度に取り込めるのは${IMPORT_LIMIT}件までです（${items.length}件）`});
  const seen = new Set(), rows = [];
  items.forEach((input, index) => {
    const key = typeof input?.key === 'string' ? input.key.trim() : '';
    if (!key || key.length > 64) problems.push({index, message: 'key（1〜64字）を確認してください'});
    else if (seen.has(key)) problems.push({index, message: `key「${key}」が重なっています`});
    seen.add(key);
    try { rows.push({key, row: normalizeVersion(input)}); } catch (e) { problems.push({index, message: e.message}); }
  });
  return {problems, rows};
}

export const formatProblem = (p) => (p.index == null ? p.message : `${p.index + 1}件目: ${p.message}`);
