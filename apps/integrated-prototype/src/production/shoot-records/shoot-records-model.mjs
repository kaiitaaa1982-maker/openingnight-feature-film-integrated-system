// 撮影の記録の計算と判定（会社ルートの plans/2026-10-22-folder-prod.md。移行 0051）。DB を読まない純関数だけを置く。
// マス目は撮影日の表から導き、届くはずの記録の台帳は作らない。マスの状態は列に持たず、最新の行から読むたびに導く。

export const RECORD_KINDS = Object.freeze(['schedule', 'ad', 'art', 'camera', 'sound', 'production', 'script']);
export const DEPARTMENTS = Object.freeze(['ad', 'art', 'camera', 'sound', 'production']);
export const KIND_LABELS = Object.freeze({schedule: '日々スケ', ad: '助監督部', art: '美術部', camera: '撮影部', sound: '録音部', production: '制作部', script: 'スクリプター'});
export const RESULTS = Object.freeze(['shot', 'partial', 'postponed', 'dropped']);
export const RESULT_LABELS = Object.freeze({shot: '撮影完了', partial: '一部', postponed: '順延', dropped: '欠番'});
export const ITEM_TYPES = Object.freeze(['handover', 'problem', 'incident', 'expense_hint', 'other']);
export const ITEM_LABELS = Object.freeze({handover: '申し送り', problem: '問題', incident: '事故・けが', expense_hint: '経費の手がかり', other: 'そのほか'});
// マスの札（1〜4字。見た目の決まり docs/design/integrated-system-visual.md §1）
export const CELL_LABELS = Object.freeze({done: '済み', review: '要確認', open: '未', late: '遅れ', none: '不要'});
export const MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain', 'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/x-m4a']);
// 置ける原本の大きさ（受け口の本文の上限 8MB に base64 で収まる大きさ。写真は画面が長い辺 2560px に縮めてから送る）
export const MAX_FILE_BYTES = 6_000_000;

// 予備日の区分の列（SCHED-030）はまだ無いので、撮影日の名前に「予備」を含む日を予備日として扱う（区分の列が入ったら差し替える）
export const isSpareDay = (day) => /予備/.test(String(day?.label ?? ''));

// 日付（YYYY-MM-DD）に日数を足す
export function addDays(date, days) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// 記録の期限は撮影日の翌日。翌日を過ぎても届いていなければ遅れ
export const isOverdue = (shootDate, today) => today > addDays(shootDate, 1);

// 同じ鍵の行のうち、連番の最も大きい行
export function latestBy(rows, keyOf) {
  const latest = new Map();
  for (const row of rows) {
    const key = keyOf(row), seen = latest.get(key);
    if (!seen || Number(row.seq) > Number(seen.seq)) latest.set(key, row);
  }
  return latest;
}

// いまの日報の項目: 取り下げの行と、ほかの行から指された（直された）行を除く
export function currentItems(items) {
  const replaced = new Set(items.filter((item) => item.replaces_id != null).map((item) => Number(item.replaces_id)));
  return items.filter((item) => item.status === 'active' && !replaced.has(Number(item.id)));
}

// 1つのマスの状態。used は、予備日が順延の移し先になったか
export function cellState({kind, record, itemCount = 0, shootDate, today, spare = false, used = false}) {
  if (record?.status === 'not_needed') return 'none';
  if (record?.status === 'placed') return DEPARTMENTS.includes(kind) && itemCount === 0 ? 'review' : 'done';
  if (DEPARTMENTS.includes(kind) && itemCount > 0) return 'done';
  if (spare && !used) return 'none';
  return isOverdue(shootDate, today) ? 'late' : 'open';
}

// 撮影日ごとの結果の数: 割り当てたシーンのうち結果に載ったもの、順延と一部の数
export function dayResultSummary(assignedSceneIds, latestResults, dayId) {
  let recorded = 0, postponed = 0, partial = 0;
  for (const sceneId of assignedSceneIds) {
    const result = latestResults.get(`${dayId}:${sceneId}`);
    if (!result) continue;
    recorded += 1;
    if (result.result === 'postponed') postponed += 1;
    if (result.result === 'partial') partial += 1;
  }
  return {assigned: assignedSceneIds.length, recorded, postponed, partial};
}

// 作品のマス目。days・assignments・records・items・results は DB の行（records は中身を除いた行）
export function buildMatrix({days, assignments, records, items, results, today}) {
  const latestRecords = latestBy(records, (row) => `${row.shooting_day_id}:${row.kind}`);
  const latestResults = latestBy(results, (row) => `${row.shooting_day_id}:${row.scene_id}`);
  const live = currentItems(items);
  const usedAsTarget = new Set([...latestResults.values()].filter((row) => row.result === 'postponed' && row.postponed_to_day_id != null)
    .map((row) => Number(row.postponed_to_day_id)));
  const rows = days.map((day) => {
    const dayId = Number(day.id), spare = isSpareDay(day), used = usedAsTarget.has(dayId);
    const cells = Object.fromEntries(RECORD_KINDS.map((kind) => {
      const record = latestRecords.get(`${dayId}:${kind}`) ?? null;
      const itemCount = DEPARTMENTS.includes(kind) ? live.filter((item) => Number(item.shooting_day_id) === dayId && item.department === kind).length : 0;
      return [kind, {state: cellState({kind, record, itemCount, shootDate: day.shoot_date, today, spare, used}), itemCount, recordId: record ? Number(record.id) : null}];
    }));
    const assigned = assignments.filter((row) => Number(row.shooting_day_id) === dayId).map((row) => Number(row.scene_id));
    return {dayId, shootDate: day.shoot_date, unit: day.unit, label: day.label, spare, used, cells, result: dayResultSummary(assigned, latestResults, dayId)};
  });
  return {rows, progress: workProgress({assignments, latestResults})};
}

// 作品の全シーンの進み。順延は最後の移し先で判定する（SCHED-034）: 順延の行の移し先に、そのシーンの後の結果があればそちらを読む
export function workProgress({assignments, latestResults}) {
  const scenes = [...new Set(assignments.map((row) => Number(row.scene_id)))];
  const byScene = new Map();
  for (const row of latestResults.values()) {
    const list = byScene.get(Number(row.scene_id)) ?? [];
    list.push(row);
    byScene.set(Number(row.scene_id), list);
  }
  const count = {shot: 0, partial: 0, postponed: 0, dropped: 0, none: 0, unassignedPostponed: 0};
  for (const sceneId of scenes) {
    const list = (byScene.get(sceneId) ?? []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id) - Number(b.id));
    const last = list.at(-1);
    if (!last) { count.none += 1; continue; }
    count[last.result] += 1;
    if (last.result === 'postponed' && last.postponed_to_day_id == null) count.unassignedPostponed += 1;
  }
  return {scenes: scenes.length, ...count};
}

const text = (value, label, max, required = false) => {
  if (value != null && typeof value !== 'string') throw new Error(`${label}を確かめてください`);
  const trimmed = (value ?? '').trim();
  if ((required && !trimmed) || trimmed.length > max) throw new Error(`${label}を確かめてください`);
  return trimmed || null;
};
const id = (value, label, optional = false) => {
  if (optional && (value == null || value === '')) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label}を確かめてください`);
  return number;
};
const clock = (value, label) => {
  const trimmed = text(value, label, 5);
  if (!trimmed) return null;
  if (!/^([01]\d|2[0-9]):[0-5]\d$/.test(trimmed)) throw new Error(`${label}は 09:30 の形で入れてください`);
  return trimmed;
};

export function normalizeResultInput(input) {
  const sceneId = id(input.sceneId, 'シーン');
  if (!RESULTS.includes(input.result)) throw new Error('結果を選んでください');
  const postponedToDayId = input.result === 'postponed' ? id(input.postponedToDayId, '順延の移し先', true) : null;
  const actualStart = clock(input.actualStart, '実績の開始'), actualEnd = clock(input.actualEnd, '実績の終了');
  if (actualStart && actualEnd && actualEnd <= actualStart) throw new Error('実績の終了は開始より後にしてください');
  return {sceneId, result: input.result, postponedToDayId, actualStart, actualEnd, note: text(input.note, 'メモ', 1000)};
}

export function normalizeRecordInput(input) {
  if (!RECORD_KINDS.includes(input.kind)) throw new Error('記録の種類を選んでください');
  if (input.notNeeded === true) return {kind: input.kind, status: 'not_needed', reason: text(input.reason, '不要の理由', 500, true)};
  const fileName = text(input.fileName, 'ファイル名', 240, true);
  if (!MIME_TYPES.includes(input.mimeType)) throw new Error('この形式のファイルは置けません（写真・PDF・Excel・テキスト・音声）');
  if (typeof input.base64 !== 'string' || !input.base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new Error('ファイルの中身を読めません');
  const sizeBytes = Math.floor(input.base64.length * 3 / 4) - (input.base64.endsWith('==') ? 2 : input.base64.endsWith('=') ? 1 : 0);
  if (sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES) throw new Error('ファイルは 6MB までです');
  const binary = atob(input.base64), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return {kind: input.kind, status: 'placed', fileName, mimeType: input.mimeType, bytes, sizeBytes};
}

export function normalizeItemInput(input) {
  if (!DEPARTMENTS.includes(input.department)) throw new Error('部署を選んでください');
  const replacesId = id(input.replacesId, '直す項目', true);
  if (input.withdraw === true) {
    if (!replacesId) throw new Error('取り下げる項目を選んでください');
    return {department: input.department, itemType: ITEM_TYPES.includes(input.itemType) ? input.itemType : 'other', status: 'withdrawn', body: null, sceneId: null, recordId: null, replacesId};
  }
  if (!ITEM_TYPES.includes(input.itemType)) throw new Error('項目の種類を選んでください');
  return {department: input.department, itemType: input.itemType, status: 'active', body: text(input.body, '本文', 2000, true),
    sceneId: id(input.sceneId, 'シーン', true), recordId: id(input.recordId, '日報の原本', true), replacesId};
}

// 事故・けがの項目は、香盤・日々スケ・印刷と同じく閲覧を絞る（CAST-017 と同じ扱い）。読めるのは書ける人だけ
export const visibleItems = (items, canWrite) => (canWrite ? items : items.filter((item) => item.item_type !== 'incident'));
