// 撮影の記録の受け口（会社ルートの plans/2026-10-22-folder-prod.md。移行 0051）。
// - GET  /api/production/shoot-records?workId=        作品のマス目（撮影日×記録の種類）と全シーンの進み
// - GET  /api/production/shoot-records/days/:dayId    1日の画面（予定と実績・撮りこぼし・置いた原本・日報の項目）
// - POST /api/production/shoot-records/days/:dayId/results  撮影の結果を足す（撮影完了・一部・順延・欠番）
// - POST /api/production/shoot-records/days/:dayId/records  原本を置く（写真・PDF など）か、理由つきで「不要」にする
// - POST /api/production/shoot-records/days/:dayId/items    日報の項目を足す・直す・取り下げる
// - GET  /api/production/shoot-records/records/:id/original 置いた原本を返す（中身は共通の原本の表 source_documents）
// 読めるのは作品の案件に所属する人。書けるのは管理者と、制作担当・編集担当のうち案件に制作の権限を持つ人（香盤・日々スケの保存と同じ）。
// 作品ごとの役目の表（SCHED-062）が入ったら、助監督・スクリプター・部署の役目で絞る。権限の無い作品と別の組織は、有無を見せず同じ 403
import {addItem, addRecord, addResult, readAssignments, readDay, readDays, readItems, readProjectGrant, readRecordOriginal, readRecords, readRecordWork, readResults,
  readScenes, readWork} from './shoot-records-store.mjs';
import {buildMatrix, currentItems, latestBy, normalizeItemInput, normalizeRecordInput, normalizeResultInput, visibleItems} from './shoot-records-model.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';

const FORBIDDEN = 'この作品の撮影の記録への権限がありません';
const NOT_WRITER = '撮影の記録を書けるのは、管理者と、この案件に制作の権限を持つ人です';
const STALE = 'ほかの画面で同じ記録が足されました。読み直してください';

// 日本時間の今日（撮影日の期限の判定に使う）
export const todayInJapan = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function toBase64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

const positiveId = (raw) => (/^\d+$/.test(String(raw ?? '')) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null);

export function registerShootRecordRoutes(app, {db, bad, body, permittedProjects, now = () => new Date()}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('shoot record routes require app, db, bad, body and permittedProjects');
  }

  // 書けるか: 管理者、または制作担当（案件の権限が制作）・編集担当（制作か編集）
  async function canWrite(identity, projectId) {
    if (identity.role === 'admin') return true;
    if (!['production', 'editor'].includes(identity.role)) return false;
    const grant = await readProjectGrant(db, identity.org_id, projectId, identity.user_id, new Date().toISOString());
    if (!grant) return false;
    return identity.role === 'production' ? grant.permission === 'production' : ['production', 'edit'].includes(grant.permission);
  }

  async function workAccess(c, workId) {
    const identity = c.get('identity');
    if (!workId) return {error: bad(c, '作品の番号を確かめてください', 400)};
    const work = await readWork(db, identity.org_id, workId);
    const allowed = work ? new Set((await permittedProjects(db, identity, false)).map((row) => Number(row.id))) : new Set();
    if (!work || !allowed.has(Number(work.project_id))) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, work: {...work, id: Number(work.id), project_id: Number(work.project_id)}, write: await canWrite(identity, Number(work.project_id))};
  }

  async function dayAccess(c, {write = false} = {}) {
    const identity = c.get('identity');
    const dayId = positiveId(c.req.param('dayId'));
    if (!dayId) return {error: bad(c, '撮影日の番号を確かめてください', 400)};
    const day = await readDay(db, identity.org_id, dayId);
    if (!day) return {error: bad(c, FORBIDDEN, 403)};
    const found = await workAccess(c, Number(day.work_id));
    if (found.error) return found;
    if (write && !found.write) return {error: bad(c, NOT_WRITER, 403)};
    return {...found, day: {...day, id: Number(day.id), project_id: Number(day.project_id), work_id: Number(day.work_id)}};
  }

  async function readBody(c) {
    try {
      const input = await body(c);
      return {input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }

  const conflict = (c, error) => (dbErrorKind(error) === 'raise' && /stale shooting/.test(error.message)) || isUniqueViolation(error);

  app.get('/api/production/shoot-records', async (c) => {
    const found = await workAccess(c, positiveId(c.req.query('workId')));
    if (found.error) return found.error;
    const {identity, work} = found;
    const scope = [identity.org_id, work.id];
    const [days, assignments, records, items, results] = await Promise.all([readDays(db, ...scope), readAssignments(db, ...scope), readRecords(db, ...scope),
      readItems(db, ...scope), readResults(db, ...scope)]);
    const matrix = buildMatrix({days, assignments, records, items, results, today: todayInJapan(now())});
    return c.json({ok: true, work: {id: work.id, code: work.code, title: work.title}, canWrite: found.write, today: todayInJapan(now()), ...matrix});
  });

  app.get('/api/production/shoot-records/days/:dayId', async (c) => {
    const found = await dayAccess(c);
    if (found.error) return found.error;
    const {identity, work, day, write} = found;
    const scope = [identity.org_id, work.id];
    const [days, assignments, records, items, results] = await Promise.all([readDays(db, ...scope), readAssignments(db, ...scope), readRecords(db, ...scope),
      readItems(db, ...scope), readResults(db, ...scope)]);
    const latest = latestBy(results, (row) => `${row.shooting_day_id}:${row.scene_id}`);
    const view = (row) => row && {result: row.result, postponedToDayId: row.postponed_to_day_id == null ? null : Number(row.postponed_to_day_id),
      actualStart: row.actual_start, actualEnd: row.actual_end, note: row.note, seq: Number(row.seq), createdAt: row.created_at};
    const scenes = assignments.filter((row) => Number(row.shooting_day_id) === day.id).map((row) => ({
      sceneId: Number(row.scene_id), sceneNo: row.scene_no, location: row.location, dayNight: row.day_night, order: Number(row.sequence_order),
      plannedStart: row.planned_start, plannedEnd: row.planned_end, latest: view(latest.get(`${day.id}:${row.scene_id}`))}));
    // ほかの日から順延でこの日へ移ってきたシーン（割当はプリプロの解錠→直し→施錠で入る。入るまでの間もここで結果を付けられる）
    const assignedHere = new Set(scenes.map((row) => row.sceneId));
    const sceneInfo = new Map((await readScenes(db, ...scope)).map((row) => [Number(row.id), row]));
    const incoming = [...latest.values()].filter((row) => row.result === 'postponed' && Number(row.postponed_to_day_id) === day.id && !assignedHere.has(Number(row.scene_id)))
      .map((row) => ({sceneId: Number(row.scene_id), sceneNo: sceneInfo.get(Number(row.scene_id))?.scene_no ?? '', location: sceneInfo.get(Number(row.scene_id))?.location ?? null,
        fromDayId: Number(row.shooting_day_id), latest: view(latest.get(`${day.id}:${row.scene_id}`))}));
    const missed = scenes.filter((row) => ['postponed', 'partial'].includes(row.latest?.result));
    const dayRecords = records.filter((row) => Number(row.shooting_day_id) === day.id).map((row) => ({id: Number(row.id), kind: row.kind, seq: Number(row.seq),
      status: row.status, fileName: row.file_name, mimeType: row.mime_type, sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes), reason: row.reason, createdAt: row.created_at}));
    const dayItems = visibleItems(currentItems(items.filter((row) => Number(row.shooting_day_id) === day.id)), write).map((row) => ({id: Number(row.id),
      department: row.department, itemType: row.item_type, body: row.body, sceneId: row.scene_id == null ? null : Number(row.scene_id),
      recordId: row.record_id == null ? null : Number(row.record_id), createdAt: row.created_at}));
    const matrix = buildMatrix({days, assignments, records, items, results, today: todayInJapan(now())});
    return c.json({ok: true, canWrite: write, work: {id: work.id, code: work.code, title: work.title},
      day: {id: day.id, shootDate: day.shoot_date, unit: day.unit, label: day.label},
      days: days.map((row) => ({id: Number(row.id), shootDate: row.shoot_date, unit: row.unit, label: row.label})),
      row: matrix.rows.find((row) => row.dayId === day.id), scenes, incoming, missed, records: dayRecords, items: dayItems});
  });

  app.post('/api/production/shoot-records/days/:dayId/results', async (c) => {
    const found = await dayAccess(c, {write: true});
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    let input;
    try { input = normalizeResultInput(read.input); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const {identity, work, day} = found;
    const sceneIds = new Set((await readScenes(db, identity.org_id, work.id)).map((row) => Number(row.id)));
    if (!sceneIds.has(input.sceneId)) return bad(c, 'この作品のシーンではありません', 400);
    if (input.postponedToDayId != null) {
      const target = await readDay(db, identity.org_id, input.postponedToDayId);
      if (!target || Number(target.work_id) !== work.id || Number(target.id) === day.id) return bad(c, '順延の移し先は、この作品の別の撮影日を選んでください', 400);
    }
    try {
      await addResult(db, {orgId: identity.org_id, day, userId: identity.user_id, input});
    } catch (error) {
      if (conflict(c, error)) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
    return c.json({ok: true}, 201);
  });

  app.post('/api/production/shoot-records/days/:dayId/records', async (c) => {
    const found = await dayAccess(c, {write: true});
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    let input;
    try { input = normalizeRecordInput(read.input); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const {identity, day} = found;
    try {
      await addRecord(db, {orgId: identity.org_id, day, userId: identity.user_id, input, receivedOn: todayInJapan(now())});
    } catch (error) {
      if (error?.name === 'SourceDocumentError') return bad(c, error.message, 400, undefined, error);
      if (isUniqueViolation(error, 'shooting_day_records') && input.status === 'placed') return bad(c, '同じ原本はこの撮影日のこの種類に置き済みです', 409, undefined, error);
      if (conflict(c, error)) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
    return c.json({ok: true}, 201);
  });

  app.post('/api/production/shoot-records/days/:dayId/items', async (c) => {
    const found = await dayAccess(c, {write: true});
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    let input;
    try { input = normalizeItemInput(read.input); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const {identity, work, day} = found;
    if (input.sceneId != null && !(await readScenes(db, identity.org_id, work.id)).some((row) => Number(row.id) === input.sceneId)) return bad(c, 'この作品のシーンではありません', 400);
    try {
      await addItem(db, {orgId: identity.org_id, day, userId: identity.user_id, input});
    } catch (error) {
      if (dbErrorKind(error) === 'raise' && /report item/.test(error.message)) return bad(c, '同じ撮影日・同じ部署の、いまの項目だけを直せます', 400, undefined, error);
      if (isUniqueViolation(error, 'shooting_day_report_items')) return bad(c, 'この項目はもう直されています。読み直してください', 409, undefined, error);
      throw error;
    }
    return c.json({ok: true}, 201);
  });

  app.get('/api/production/shoot-records/records/:recordId/original', async (c) => {
    const identity = c.get('identity');
    const recordId = positiveId(c.req.param('recordId'));
    if (!recordId) return bad(c, '原本の番号を確かめてください', 400);
    const meta = await readRecordWork(db, identity.org_id, recordId);
    if (!meta) return bad(c, FORBIDDEN, 403);
    const found = await workAccess(c, Number(meta.work_id));
    if (found.error) return found.error;
    const original = await readRecordOriginal(db, identity.org_id, recordId);
    if (!original) return bad(c, '原本がありません', 404);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ok: true, recordId, fileName: original.fileName, mimeType: original.mimeType, base64: toBase64(original.bytes)});
  });
}
