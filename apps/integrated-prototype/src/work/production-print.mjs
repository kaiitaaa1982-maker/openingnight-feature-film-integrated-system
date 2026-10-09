// 制作（香盤・日々スケ・衣装香盤）の出力と、制作画面の入力の論理。React に依存しない純関数。
// - シート定義は xlsx-report.mjs の形（{name, title, conditions, dataAsOf, columns, rows, totals, notes, freezeCols}）。
//   Excel は encodeReportXlsx / downloadReportXlsx に、印刷は productionPrintHtml にそのまま渡す。
// - 日々スケの時刻は「撮影日の時刻」か「翌日の時刻」。保存形式は YYYY-MM-DDTHH:MM（日本時間のローカル日時）。
// - 印刷では空欄を空欄のまま出す（香盤の出演欄の空白を「未確認」と書かない）。

import {labelOf} from '../ui/labels.mjs';
import {dateJst, dateTimeJst, toNumber} from '../ui/format.mjs';

export const OUTCOME_LABELS = Object.freeze({planned: '予定', partial: '一部撮影', shot: '撮影済み', not_shot: '未撮影'});
export const SLOT_KIND_LABELS = Object.freeze({move: '移動', meal: '食事', wrap: '撤収', prep: '準備', other: 'その他'});
export const PREP_STATUS_LABELS = Object.freeze({pending: '未準備', ready: '準備済み', blocked: '保留'});
export const PRODUCTION_TABS = Object.freeze([
  Object.freeze({id: 'kouban', label: '香盤'}),
  Object.freeze({id: 'day', label: '日々スケ'}),
  Object.freeze({id: 'costume', label: '衣装香盤'}),
  Object.freeze({id: 'location', label: 'ロケ地マップ'}),
  Object.freeze({id: 'prep', label: '準備タスク'}),
]);

export function productionTab(value) {
  return PRODUCTION_TABS.some((tab) => tab.id === value) ? value : PRODUCTION_TABS[0].id;
}

// 準備タスクの状態の表示。準備済みでないまま期限（YYYY-MM-DD）を過ぎたものは「期限超過」を添える。
export function prepTaskState(task, today) {
  const label = PREP_STATUS_LABELS[task?.status] || '状態未確認';
  const overdue = Boolean(task?.due_on && today && task.status !== 'ready' && task.due_on < today);
  return {label: overdue ? `${label}・期限超過` : label, overdue, tone: task?.status === 'ready' ? 'ok' : overdue || task?.status === 'blocked' ? 'warn' : 'info'};
}

// 準備タスクの件数のまとめ
export function prepSummary(tasks, today) {
  const list = tasks || [];
  return {
    total: list.length,
    pending: list.filter((task) => task.status === 'pending').length,
    blocked: list.filter((task) => task.status === 'blocked').length,
    ready: list.filter((task) => task.status === 'ready').length,
    overdue: list.filter((task) => prepTaskState(task, today).overdue).length,
  };
}

// ─── 日付・時刻 ─────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

function validIsoDate(value) {
  const match = ISO_DATE.exec(String(value ?? ''));
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

// 暦日に日数を足す（YYYY-MM-DD）
export function addDays(isoDate, days = 1) {
  if (!validIsoDate(isoDate)) return null;
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
// 撮影日の表示「2026/10/01（木）」
export function shootDateText(isoDate) {
  if (!validIsoDate(isoDate)) return isoDate ? String(isoDate) : '日付未定';
  return `${dateJst(isoDate)}（${WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()]}）`;
}

// 時刻の入力を HH:MM に直す。「9:05」「０９：０５」「0905」を受け付ける。24〜47時台は翌日の時刻として返す。
// 戻り値: {ok, time:'HH:MM', nextDay:boolean, error}
export function parseClock(text) {
  const source = String(text ?? '').normalize('NFKC').trim();
  if (!source) return {ok: true, time: '', nextDay: false};
  const match = /^(\d{1,2}):?(\d{2})$/.exec(source);
  if (!match) return {ok: false, error: '時刻は 9:00 のように入力してください'};
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 47) return {ok: false, error: '存在しない時刻です'};
  return {ok: true, time: `${pad(hour % 24)}:${pad(minute)}`, nextDay: hour >= 24};
}

// 保存値（YYYY-MM-DDTHH:MM）を撮影日に対する {time, nextDay} に分ける。
// 撮影日・翌日のどちらでもない日付は outside:true（旧データ。直すときは撮影日に付け直す）。
export function splitDayTime(value, shootDate) {
  if (value === null || value === undefined || value === '') return {time: '', nextDay: false, outside: false};
  const match = LOCAL_DATE_TIME.exec(String(value));
  if (!match) return {time: '', nextDay: false, outside: true, raw: String(value)};
  const time = `${match[2]}:${match[3]}`;
  if (match[1] === shootDate) return {time, nextDay: false, outside: false};
  if (match[1] === addDays(shootDate, 1)) return {time, nextDay: true, outside: false};
  return {time, nextDay: false, outside: true, date: match[1], raw: String(value)};
}

// 撮影日・時刻・翌日の指定を保存値に組み立てる。時刻が空なら ''。25:30 のような入力は翌日 01:30 として扱う。
export function joinDayTime(shootDate, time, nextDay = false) {
  const parsed = parseClock(time);
  if (!parsed.ok) throw Error(parsed.error);
  if (!parsed.time) return '';
  if (!validIsoDate(shootDate)) throw Error('撮影日を先に入れてください');
  if (parsed.nextDay && nextDay) throw Error('翌日の24時以降は入力できません。撮影日を分けてください');
  const date = parsed.nextDay || nextDay ? addDays(shootDate, 1) : shootDate;
  return `${date}T${parsed.time}`;
}

// 撮影日を変えたとき、時刻を「同じ日目」のまま新しい撮影日に付け直す。範囲外の値は新しい撮影日の時刻にする。
export function rebaseDayTime(value, fromDate, toDate) {
  if (!value) return value ?? '';
  const parts = splitDayTime(value, fromDate);
  if (!parts.time || !validIsoDate(toDate)) return value;
  return joinDayTime(toDate, parts.time, parts.nextDay);
}

// 表示用「09:00」「翌01:30」。撮影日の範囲外は日付つきで出す。
export function dayTimeText(value, shootDate) {
  if (!value) return '';
  const parts = splitDayTime(value, shootDate);
  if (parts.outside) return parts.date ? `${dateJst(parts.date)} ${parts.time}` : String(value);
  return parts.nextDay ? `翌${parts.time}` : parts.time;
}

// 開始・終了の組み合わせを確かめる。問題が無ければ null、あれば日本語の理由。
export function timeRangeError(start, end, {label = '予定', bothRequired = false} = {}) {
  if (bothRequired && Boolean(start) !== Boolean(end)) return `${label}の開始と終了を両方入れてください`;
  if (start && end && end <= start) return `${label}の終了を開始より後にしてください（日をまたぐときは「翌日」に印を付けます）`;
  return null;
}

// ─── 未保存の変更の件数 ────────────────────────────────

const COLLECTION_KEYS = Object.freeze({
  characters: ['key'],
  locations: ['key'],
  locationPlans: ['location_key'],
  sceneDetails: ['scene_id'],
  appearances: ['scene_id', 'character_key'],
  looks: ['key'],
  sceneLooks: ['scene_id', 'look_key'],
  daySlots: ['day_id', 'key'],
  calls: ['day_id', 'character_key'],
});
// 値がすべて空の行は「無い」とみなす集まり（詳細を入れてから消した場合など）
const EMPTY_MEANS_ABSENT = new Set(['sceneDetails', 'calls']);
const IGNORED_FIELDS = new Set(['org_id', 'work_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'version']);

function comparableValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return JSON.stringify(value);
  const n = toNumber(value);
  return n === null ? String(value) : n;
}

function rowSignature(row, keyFields) {
  const entries = Object.keys(row || {}).filter((key) => !keyFields.includes(key) && !IGNORED_FIELDS.has(key))
    .map((key) => [key, comparableValue(row[key])]).filter(([, value]) => value !== null).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function rowMap(rows, name) {
  const keyFields = COLLECTION_KEYS[name];
  const map = new Map();
  for (const row of rows || []) {
    const signature = rowSignature(row, keyFields);
    if (EMPTY_MEANS_ABSENT.has(name) && signature === '[]') continue;
    map.set(JSON.stringify(keyFields.map((key) => comparableValue(row?.[key]))), signature);
  }
  return map;
}

// 保存済みの制作情報（before）と画面の入力（after）の差を行の数で数える（追加・削除・変更をそれぞれ1件）。
export function countGraphChanges(before, after) {
  let count = 0;
  for (const name of Object.keys(COLLECTION_KEYS)) {
    const a = rowMap(before?.[name], name);
    const b = rowMap(after?.[name], name);
    for (const [key, signature] of b) if (!a.has(key) || a.get(key) !== signature) count += 1;
    for (const key of a.keys()) if (!b.has(key)) count += 1;
  }
  return count;
}

// ─── 衣装の未割当 ───────────────────────────────────────

// 出演があるのに、その役の衣装（ルック）が付いていないシーン×役
export function wardrobeGaps({appearances = [], sceneLooks = [], looks = []} = {}) {
  const lookCharacter = new Map(looks.map((look) => [look.key, look.character_key]));
  return appearances.filter((appearance) => !sceneLooks.some((item) => item.scene_id === appearance.scene_id
    && lookCharacter.get(item.look_key) === appearance.character_key));
}

// 警告の文。先頭 limit 件を並べ、残りは「ほかn件」と数で示す（黙って切らない）。
export function gapSummary(gaps, {scenes = [], characters = [], limit = 8} = {}) {
  const sceneNo = new Map(scenes.map((scene) => [scene.id, scene.scene_no]));
  const name = new Map(characters.map((character) => [character.key, character.name]));
  const items = (gaps || []).map((gap) => `S#${sceneNo.get(gap.scene_id) ?? '?'} ${name.get(gap.character_key) ?? '役未確認'}`);
  const shown = items.slice(0, limit);
  const rest = Math.max(0, items.length - shown.length);
  return {total: items.length, shown, rest, text: items.length ? `${shown.join(' ／ ')}${rest ? ` ／ ほか${rest}件` : ''}` : ''};
}

// ─── 香盤 ──────────────────────────────────────────────

// 頁（1/8頁単位）の表示。13 → "1 5/8"、3 → "3/8"、null → ""。
export function pageText(eighths) {
  if (eighths === null || eighths === undefined || eighths === '') return '';
  const n = Math.round(Number(eighths));
  if (!Number.isFinite(n)) return '';
  const whole = Math.trunc(n / 8);
  const rest = Math.abs(n % 8);
  if (!rest) return String(whole);
  return whole ? `${whole} ${rest}/8` : `${n < 0 ? '-' : ''}${rest}/8`;
}

function detailOf(production, scene) {
  return (production.sceneDetails || []).find((item) => item.scene_id === scene.id) || {};
}

function locationName(production, scene) {
  const key = detailOf(production, scene).location_key;
  const location = key ? (production.locations || []).find((item) => item.key === key) : null;
  return location?.name || scene.location || '';
}

// 撮影日の順（日々スケの撮影順）でシーンをまとめ、どの日にも入っていないシーンを最後に置く。
export function koubanGroups(production) {
  const scenes = production?.scenes || [];
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const assigned = new Set();
  const groups = [];
  for (const day of production?.days || []) {
    const rows = [...(day.assignments || [])].sort((a, b) => a.sequence_order - b.sequence_order)
      .map((assignment) => byId.get(assignment.scene_id)).filter(Boolean);
    rows.forEach((scene) => assigned.add(scene.id));
    groups.push({day, scenes: rows});
  }
  const missing = scenes.filter((scene) => !assigned.has(scene.id));
  if (missing.length) groups.push({day: null, scenes: missing});
  return groups;
}

export function dayLabel(day) {
  if (!day) return '撮影日未編成';
  return `${shootDateText(day.shoot_date)} ${day.unit || ''}`.trim();
}

const sumPages = (production, scenes) => scenes.reduce((total, scene) => total + (Number(detailOf(production, scene).page_eighths) || 0), 0);
const sumMinutes = (production, scenes) => scenes.reduce((total, scene) => total + (toNumber(detailOf(production, scene).estimated_minutes) || 0), 0);

// 香盤の役の並び: 出演シーンの多い順（主な役が左）。同じ数なら香盤で先に出る順、次に名前順。
// 役の表に順番の列が無いので、出演の数で主な役を先に出す（役タブの並びは変えない）
export function koubanCharacters(production) {
  const order = new Map(koubanGroups(production).flatMap((group) => group.scenes).map((scene, index) => [scene.id, index]));
  const count = new Map(), first = new Map();
  for (const item of production?.appearances || []) {
    count.set(item.character_key, (count.get(item.character_key) || 0) + 1);
    const at = order.get(item.scene_id) ?? Number.MAX_SAFE_INTEGER;
    if (at < (first.get(item.character_key) ?? Number.MAX_SAFE_INTEGER)) first.set(item.character_key, at);
  }
  const last = Number.MAX_SAFE_INTEGER;
  return [...(production?.characters || [])].sort((a, b) => (count.get(b.key) || 0) - (count.get(a.key) || 0)
    || (first.get(a.key) ?? last) - (first.get(b.key) ?? last) || String(a.name).localeCompare(String(b.name), 'ja'));
}

// 香盤表のシート。列: 撮影日・S#・昼夜・頁・予定尺（分）・場所・内容・役（出演は○）。撮影日ごとに小計行。
export function koubanSheet(production, {workTitle = '', dataAsOf} = {}) {
  const characters = koubanCharacters(production);
  const appearances = new Set((production?.appearances || []).map((item) => `${item.scene_id}\u0001${item.character_key}`));
  const columns = [
    {key: 'shootDay', label: '撮影日', type: 'text', width: 20},
    {key: 'sceneNo', label: 'S#', type: 'text', width: 8},
    {key: 'dayNight', label: '昼夜', type: 'text', width: 7},
    {key: 'pages', label: '頁', type: 'text', align: 'right', width: 8},
    {key: 'minutes', label: '予定尺（分）', type: 'int', width: 11},
    {key: 'location', label: '場所', type: 'text', width: 18},
    {key: 'synopsis', label: '内容', type: 'text', wrap: true, width: 36},
    ...characters.map((character) => ({key: `cast:${character.key}`, label: character.short_name || character.name, type: 'text', align: 'center', width: 6})),
  ];
  const rows = [];
  for (const group of koubanGroups(production)) {
    const label = dayLabel(group.day);
    for (const scene of group.scenes) {
      const detail = detailOf(production, scene);
      const row = {
        shootDay: label,
        sceneNo: String(scene.scene_no ?? ''),
        dayNight: scene.day_night ? labelOf('dayNight', scene.day_night) : '',
        pages: pageText(detail.page_eighths),
        minutes: toNumber(detail.estimated_minutes),
        location: locationName(production, scene),
        synopsis: scene.synopsis || '',
      };
      for (const character of characters) row[`cast:${character.key}`] = appearances.has(`${scene.id}\u0001${character.key}`) ? '○' : '';
      rows.push(row);
    }
    rows.push({__kind: 'subtotal', shootDay: `小計（${group.scenes.length}シーン）`, pages: pageText(sumPages(production, group.scenes)), minutes: sumMinutes(production, group.scenes)});
  }
  const scenes = production?.scenes || [];
  return {
    name: '香盤表',
    title: `${workTitle ? `${workTitle} ` : ''}香盤表`,
    conditions: [['作品', workTitle || '未確認'], ['シーン数', `${scenes.length}`], ['撮影日数', `${(production?.days || []).length}`]],
    dataAsOf,
    columns,
    rows,
    totals: [{label: '合計', values: {pages: pageText(sumPages(production, scenes)), minutes: sumMinutes(production, scenes)}}],
    notes: ['○ は出演。頁は1/8頁単位。撮影日は日々スケの撮影順。'],
    freezeCols: 2,
  };
}

// ─── 日々スケ ───────────────────────────────────────────

// 1日の流れ（シーンと、移動・食事などの項目）を撮影順に並べる。項目は「何番目のシーンの後」に置く。
export function dayTimeline(day, daySlots = []) {
  const scenes = (day?.assignments || []).map((row) => ({type: 'scene', position: Number(row.sequence_order) || 0, sort: 0, row}));
  const slots = (daySlots || []).filter((slot) => slot.day_id === day?.id).map((row) => ({type: 'slot', position: Number(row.after_scene_order) || 0, sort: 1, row}));
  return [...scenes, ...slots].sort((a, b) => a.position - b.position || a.sort - b.sort);
}

function castNames(production, sceneId) {
  const keys = (production.appearances || []).filter((item) => item.scene_id === sceneId).map((item) => item.character_key);
  return (production.characters || []).filter((character) => keys.includes(character.key)).map((character) => character.short_name || character.name).join('・');
}

// 日々スケのシート（1日分）。列: 順・区分・S#・昼夜・場所・内容・出演・予定開始/終了・実績開始/終了・撮影実績・メモ。
export function dailyScheduleSheet(production, day, {workTitle = '', dataAsOf} = {}) {
  const scenes = new Map((production?.scenes || []).map((scene) => [scene.id, scene]));
  const date = day?.shoot_date;
  const rows = dayTimeline(day, production?.daySlots).map((item) => {
    const row = item.row;
    if (item.type === 'slot') {
      return {
        order: '', kind: SLOT_KIND_LABELS[row.kind] || 'その他', sceneNo: '', dayNight: '', location: '', synopsis: row.label || '', cast: '',
        plannedStart: dayTimeText(row.planned_start, date), plannedEnd: dayTimeText(row.planned_end, date),
        actualStart: dayTimeText(row.actual_start, date), actualEnd: dayTimeText(row.actual_end, date), outcome: '', notes: row.note || '',
      };
    }
    const scene = scenes.get(row.scene_id) || {id: row.scene_id, scene_no: '?'};
    return {
      order: String(row.sequence_order ?? ''), kind: 'シーン', sceneNo: String(scene.scene_no ?? ''),
      dayNight: scene.day_night ? labelOf('dayNight', scene.day_night) : '', location: locationName(production, scene), synopsis: scene.synopsis || '',
      cast: castNames(production, scene.id),
      plannedStart: dayTimeText(row.planned_start, date), plannedEnd: dayTimeText(row.planned_end, date),
      actualStart: dayTimeText(row.actual_start, date), actualEnd: dayTimeText(row.actual_end, date),
      outcome: OUTCOME_LABELS[row.outcome] || '', notes: row.notes || '',
    };
  });
  const text = (key, label, extra = {}) => ({key, label, type: 'text', ...extra});
  return {
    name: '日々スケ',
    title: `${workTitle ? `${workTitle} ` : ''}日々スケ ${shootDateText(date)}`,
    conditions: [['撮影日', shootDateText(date)], ['班', day?.unit || '未確認'], ['表示名', day?.label || ''], ['連絡事項', day?.notes || 'なし']],
    dataAsOf,
    columns: [
      text('order', '順', {width: 5, align: 'right'}), text('kind', '区分', {width: 7}), text('sceneNo', 'S#', {width: 7}), text('dayNight', '昼夜', {width: 6}),
      text('location', '場所', {width: 16}), text('synopsis', '内容', {wrap: true, width: 30}), text('cast', '出演', {wrap: true, width: 16}),
      text('plannedStart', '予定開始', {width: 9}), text('plannedEnd', '予定終了', {width: 9}), text('actualStart', '実績開始', {width: 9}), text('actualEnd', '実績終了', {width: 9}),
      text('outcome', '撮影実績', {width: 9}), text('notes', 'メモ', {wrap: true, width: 20}),
    ],
    rows,
    notes: ['時刻は日本時間。「翌」は撮影日の翌日。'],
    freezeCols: 3,
  };
}

// 入り時間のシート（1日分）。その日に出演するか、入り時間が入っている役を入りの早い順に。
export function callSheet(production, day, {workTitle = '', dataAsOf} = {}) {
  const date = day?.shoot_date;
  const sceneIds = new Set((day?.assignments || []).map((row) => row.scene_id));
  const onDay = new Set((production?.appearances || []).filter((item) => sceneIds.has(item.scene_id)).map((item) => item.character_key));
  const calls = new Map((production?.calls || []).filter((call) => call.day_id === day?.id).map((call) => [call.character_key, call]));
  const rows = (production?.characters || []).filter((character) => onDay.has(character.key) || calls.has(character.key)).map((character) => {
    const call = calls.get(character.key) || {};
    return {
      role: character.name, actor: character.actor_name || '', callTime: dayTimeText(call.call_time, date), readyTime: dayTimeText(call.ready_time, date),
      sort: call.call_time || '￿', notes: call.note || (onDay.has(character.key) ? '' : 'この日の出演シーンなし'),
    };
  }).sort((a, b) => a.sort.localeCompare(b.sort) || a.role.localeCompare(b.role, 'ja'));
  return {
    name: '入り時間',
    title: `${workTitle ? `${workTitle} ` : ''}入り時間 ${shootDateText(date)}`,
    conditions: [['撮影日', shootDateText(date)], ['班', day?.unit || '未確認']],
    dataAsOf,
    columns: [
      {key: 'role', label: '役', type: 'text', width: 14}, {key: 'actor', label: '俳優', type: 'text', width: 14},
      {key: 'callTime', label: '入り', type: 'text', width: 9}, {key: 'readyTime', label: '支度完了', type: 'text', width: 9},
      {key: 'notes', label: '備考', type: 'text', wrap: true, width: 24},
    ],
    rows: rows.map(({sort, ...row}) => row),
    freezeCols: 1,
  };
}

// ─── 衣装香盤 ───────────────────────────────────────────

function sceneOrder(production) {
  const order = new Map();
  let index = 0;
  for (const group of koubanGroups(production)) for (const scene of group.scenes) order.set(scene.id, index++);
  return order;
}

// 衣装香盤（役×ルック）。列: 役・俳優・ルック・メイク・持ち道具・靴・装飾品・備考・着用シーン。
export function costumeSheet(production, {workTitle = '', dataAsOf} = {}) {
  const scenes = new Map((production?.scenes || []).map((scene) => [scene.id, scene]));
  const order = sceneOrder(production);
  const characters = production?.characters || [];
  const rows = [];
  for (const character of characters) {
    for (const look of (production?.looks || []).filter((item) => item.character_key === character.key)) {
      const worn = (production?.sceneLooks || []).filter((item) => item.look_key === look.key).map((item) => item.scene_id)
        .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9)).map((id) => `S#${scenes.get(id)?.scene_no ?? '?'}`);
      rows.push({
        role: character.name, actor: character.actor_name || '', look: look.label || '', makeup: look.makeup || '', props: look.props || '',
        shoes: look.shoes || '', accessories: look.accessories || '', note: look.note || '', scenes: worn.join('、'),
      });
    }
  }
  const text = (key, label, extra = {}) => ({key, label, type: 'text', ...extra});
  return {
    name: '衣装香盤',
    title: `${workTitle ? `${workTitle} ` : ''}衣装香盤`,
    conditions: [['作品', workTitle || '未確認'], ['ルック数', `${rows.length}`]],
    dataAsOf,
    columns: [
      text('role', '役', {width: 12}), text('actor', '俳優', {width: 12}), text('look', 'ルック', {width: 8}), text('makeup', 'メイク', {wrap: true, width: 16}),
      text('props', '持ち道具', {wrap: true, width: 16}), text('shoes', '靴', {width: 12}), text('accessories', '装飾品', {wrap: true, width: 14}),
      text('note', '備考', {wrap: true, width: 16}), text('scenes', '着用シーン', {wrap: true, width: 24}),
    ],
    rows,
    freezeCols: 1,
  };
}

// シーン別の衣装（シーン → 役と衣装）。未割当の役には「未割当」と書く。
export function sceneCostumeSheet(production, {workTitle = '', dataAsOf} = {}) {
  const characters = new Map((production?.characters || []).map((character) => [character.key, character]));
  const looks = new Map((production?.looks || []).map((look) => [look.key, look]));
  const rows = [];
  let missingTotal = 0;
  for (const group of koubanGroups(production)) {
    for (const scene of group.scenes) {
      const cast = (production?.appearances || []).filter((item) => item.scene_id === scene.id);
      let missing = 0;
      const parts = cast.map((item) => {
        const labels = (production?.sceneLooks || []).filter((row) => row.scene_id === scene.id).map((row) => looks.get(row.look_key))
          .filter((look) => look?.character_key === item.character_key).map((look) => look.label);
        if (!labels.length) missing += 1;
        return `${characters.get(item.character_key)?.name ?? '役未確認'} ${labels.length ? labels.join('・') : '未割当'}`;
      });
      missingTotal += missing;
      rows.push({shootDay: dayLabel(group.day), sceneNo: String(scene.scene_no ?? ''), location: locationName(production, scene), cast: parts.join(' ／ '), missing: missing ? `${missing}件` : ''});
    }
  }
  return {
    name: 'シーン別衣装',
    title: `${workTitle ? `${workTitle} ` : ''}シーン別衣装`,
    conditions: [['作品', workTitle || '未確認'], ['衣装未割当', `${missingTotal}件`]],
    dataAsOf,
    columns: [
      {key: 'shootDay', label: '撮影日', type: 'text', width: 20}, {key: 'sceneNo', label: 'S#', type: 'text', width: 8},
      {key: 'location', label: '場所', type: 'text', width: 16}, {key: 'cast', label: '役と衣装', type: 'text', wrap: true, width: 48},
      {key: 'missing', label: '未割当', type: 'text', width: 8},
    ],
    rows,
    freezeCols: 2,
  };
}

// ─── 印刷用HTML ─────────────────────────────────────────

const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function printCell(column, value) {
  if (value === null || value === undefined || value === '') return '';
  if (column.type === 'int' || column.type === 'yen') {
    const n = toNumber(value);
    return n === null ? String(value) : n.toLocaleString('ja-JP');
  }
  return String(value);
}

function cellValue(column, row) {
  return typeof column.value === 'function' ? column.value(row) : row?.[column.key];
}

// 現場に配る印刷用の HTML。1シート＝1ページ以上。見出し行は各ページで繰り返し、行の途中で改ページしない。
// 空欄は空欄のまま出す。色は印刷用紙に合わせて黒1色（画面のテーマには依存しない）。
export function productionPrintHtml({title, subtitle = '', sheets = [], generatedAt = new Date(), paper = 'A4 landscape'} = {}) {
  const sections = sheets.map((sheet) => {
    const columns = sheet.columns || [];
    const conditions = (sheet.conditions || []).filter((item) => Array.isArray(item) && (item[1] ?? '') !== '')
      .map(([label, value]) => `<span><b>${escapeHtml(label)}</b> ${escapeHtml(value)}</span>`).join('');
    const head = columns.map((column) => `<th${column.align ? ` class="${escapeHtml(column.align)}"` : ''}>${escapeHtml(column.label ?? column.key)}</th>`).join('');
    const body = (sheet.rows || []).map((row) => {
      const subtotal = row && row.__kind === 'subtotal';
      const cells = columns.map((column) => {
        const classes = [column.align, column.wrap ? 'wrap' : '', column.type === 'int' || column.type === 'yen' ? 'right' : ''].filter(Boolean).join(' ');
        return `<td${classes ? ` class="${classes}"` : ''}>${escapeHtml(printCell(column, cellValue(column, row)))}</td>`;
      }).join('');
      return `<tr${subtotal ? ' class="subtotal"' : ''}>${cells}</tr>`;
    }).join('');
    const totals = (sheet.totals || []).map((total) => `<tr class="total">${columns.map((column, index) => {
      const value = total.values && Object.hasOwn(total.values, column.key) ? total.values[column.key] : index === 0 ? total.label ?? '合計' : '';
      const right = column.type === 'int' || column.type === 'yen' || column.align === 'right';
      return `<td${right ? ' class="right"' : ''}>${escapeHtml(printCell(column, value))}</td>`;
    }).join('')}</tr>`).join('');
    const empty = (sheet.rows || []).length ? '' : `<tr><td colspan="${Math.max(columns.length, 1)}" class="empty">登録がありません</td></tr>`;
    const notes = (sheet.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join('');
    return `<section><header><h1>${escapeHtml(sheet.title || sheet.name || title)}</h1>${conditions ? `<p class="meta">${conditions}</p>` : ''}</header>`
      + `<table><thead><tr>${head}</tr></thead><tbody>${body}${empty}</tbody>${totals ? `<tfoot>${totals}</tfoot>` : ''}</table>`
      + `${notes ? `<ul class="notes">${notes}</ul>` : ''}<footer>${escapeHtml(title)}${subtitle ? ` ／ ${escapeHtml(subtitle)}` : ''} ／ 出力 ${escapeHtml(dateTimeJst(generatedAt))}</footer></section>`;
  }).join('');
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
    + `<title>${escapeHtml(title)}</title><style>`
    + `@page{size:${paper};margin:10mm}*{box-sizing:border-box}html,body{background:white;color:black}`
    + 'body{margin:0;font:11px/1.45 "Yu Gothic","Hiragino Sans","Noto Sans JP",sans-serif}'
    + 'section{padding:8mm;break-after:page}section:last-of-type{break-after:auto}'
    + 'header{border-bottom:2px solid;margin-bottom:3mm;padding-bottom:2mm}h1{font-size:18px;margin:0 0 1mm}'
    + '.meta{display:flex;flex-wrap:wrap;gap:2mm 6mm;margin:0;font-size:11px}'
    + 'table{width:100%;border-collapse:collapse}th,td{border:1px solid;padding:1.2mm 1.6mm;vertical-align:top;text-align:left}'
    + 'th{font-weight:700;border-bottom-width:2px}thead{display:table-header-group}tr{break-inside:avoid}'
    + 'td.wrap{white-space:pre-wrap;overflow-wrap:anywhere}td.right,th.right{text-align:right;font-variant-numeric:tabular-nums}td.center,th.center{text-align:center}'
    + 'tr.subtotal td{font-weight:700;border-bottom-width:2px}tr.total td{font-weight:700;border-top:2px solid}td.empty{text-align:center;padding:6mm}'
    + '.notes{margin:2mm 0 0;padding-left:5mm;font-size:10px}footer{margin-top:3mm;font-size:9px}'
    + '.print-bar{padding:4mm 8mm}.print-bar button{font:inherit;padding:2mm 5mm}@media print{.print-bar{display:none}section{padding:0}}'
    + '</style></head><body><div class="print-bar"><button type="button" onclick="window.print()">印刷・PDF保存</button></div>'
    + sections + '</body></html>';
}
