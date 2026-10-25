// 撮影の記録の DB の読み書き（移行 0051 の3表）。表の持ち主はプロダクション。撮影日・シーン・割当はプリプロの表を読むだけ（約束 PR-2）。
// 連番は最大の番号＋1 を読んでから入れ、取り合いは DB のトリガー（*_sequence）と一意の制約が断る（受け口が 409 にする）。
// 書くたびに同じ batch で audit_log に1行残す（原本の中身と本文は残さない）
import {getSourceDocument, registerSourceDocument} from '../../source-documents/source-documents-store.mjs';

const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';

export async function readWork(db, orgId, workId) {
  return db.get('SELECT id,project_id,code,title FROM works WHERE org_id=? AND id=?', [orgId, workId]);
}

// 案件の権限（project_memberships.permission。期限切れは除く）
export async function readProjectGrant(db, orgId, projectId, userId, nowIso) {
  return db.get('SELECT permission FROM project_memberships WHERE org_id=? AND project_id=? AND user_id=? AND (expires_at IS NULL OR expires_at>?)',
    [orgId, projectId, userId, nowIso]);
}

export async function readRecordWork(db, orgId, recordId) {
  return db.get('SELECT work_id FROM shooting_day_records WHERE org_id=? AND id=?', [orgId, recordId]);
}

export async function readDays(db, orgId, workId) {
  return db.all('SELECT id,shoot_date,unit,label FROM shooting_days WHERE org_id=? AND work_id=? ORDER BY shoot_date,unit,id', [orgId, workId]);
}

export async function readDay(db, orgId, dayId) {
  return db.get('SELECT id,project_id,work_id,shoot_date,unit,label FROM shooting_days WHERE org_id=? AND id=?', [orgId, dayId]);
}

export async function readAssignments(db, orgId, workId) {
  return db.all(`SELECT a.shooting_day_id,a.scene_id,a.sequence_order,a.planned_start,a.planned_end,s.scene_no,s.location,s.day_night,s.synopsis
    FROM day_scene_assignments a JOIN scenes s ON s.org_id=a.org_id AND s.id=a.scene_id
    WHERE a.org_id=? AND a.work_id=? ORDER BY a.shooting_day_id,a.sequence_order`, [orgId, workId]);
}

export async function readScenes(db, orgId, workId) {
  return db.all('SELECT id,scene_no,location FROM scenes WHERE org_id=? AND work_id=? ORDER BY scene_no', [orgId, workId]);
}

export async function readResults(db, orgId, workId) {
  return db.all(`SELECT id,shooting_day_id,scene_id,seq,result,postponed_to_day_id,actual_start,actual_end,note,created_by,created_at
    FROM shooting_scene_results WHERE org_id=? AND work_id=? ORDER BY shooting_day_id,scene_id,seq`, [orgId, workId]);
}

// 原本の名前・形式・大きさは共通の原本の表から読む（中身は一覧では読まない）
export async function readRecords(db, orgId, workId) {
  return db.all(`SELECT r.id,r.shooting_day_id,r.kind,r.seq,r.status,r.source_document_id,d.file_name,d.media_type AS mime_type,d.byte_length AS size_bytes,
    r.reason,r.created_by,r.created_at FROM shooting_day_records r LEFT JOIN source_documents d ON d.org_id=r.org_id AND d.id=r.source_document_id
    WHERE r.org_id=? AND r.work_id=? ORDER BY r.shooting_day_id,r.kind,r.seq`, [orgId, workId]);
}

// 置いた原本の中身（共通の原本の表から。bytes は Uint8Array）
export async function readRecordOriginal(db, orgId, recordId) {
  const record = await db.get('SELECT id,work_id,status,source_document_id FROM shooting_day_records WHERE org_id=? AND id=?', [orgId, recordId]);
  if (!record || record.status !== 'placed') return null;
  const document = await getSourceDocument(db, orgId, Number(record.source_document_id), {withContent: true});
  return document && document.bytes ? {fileName: document.file_name, mimeType: document.media_type, bytes: document.bytes} : null;
}

export async function readItems(db, orgId, workId) {
  return db.all(`SELECT id,shooting_day_id,department,item_type,status,body,scene_id,record_id,replaces_id,created_by,created_at
    FROM shooting_day_report_items WHERE org_id=? AND work_id=? ORDER BY shooting_day_id,id`, [orgId, workId]);
}

export async function addResult(db, {orgId, day, userId, input}) {
  const seq = Number((await db.get('SELECT COALESCE(MAX(seq),0) AS n FROM shooting_scene_results WHERE org_id=? AND shooting_day_id=? AND scene_id=?',
    [orgId, day.id, input.sceneId]))?.n ?? 0) + 1;
  await db.batch([
    {sql: `INSERT INTO shooting_scene_results(org_id,project_id,work_id,shooting_day_id,scene_id,seq,result,postponed_to_day_id,actual_start,actual_end,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, day.project_id, day.work_id, day.id, input.sceneId, seq, input.result, input.postponedToDayId, input.actualStart, input.actualEnd, input.note, userId]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'shooting_scene_result', `${day.id}:${input.sceneId}:${seq}`,
      JSON.stringify({dayId: day.id, sceneId: input.sceneId, result: input.result, postponedToDayId: input.postponedToDayId})]},
  ]);
}

// 原本の種類（共通の原本の表の kind）: 日々スケは schedule、スクリプター記録は script、日報は形式で image・audio・other
const documentKind = (kind, mimeType) => (kind === 'schedule' ? 'schedule' : kind === 'script' ? 'script'
  : String(mimeType ?? '').startsWith('image/') ? 'image' : String(mimeType ?? '').startsWith('audio/') ? 'audio' : 'other');

// 置くときは先に共通の原本の表へ受け取り（同じ中身なら前の行の ID が返る）、その ID を指す行を足す
export async function addRecord(db, {orgId, day, userId, input, receivedOn}) {
  const placed = input.status === 'placed';
  const document = placed ? await registerSourceDocument(db, {orgId, userId, kind: documentKind(input.kind, input.mimeType), fileName: input.fileName,
    mediaType: input.mimeType, receivedOn, bytes: input.bytes}) : null;
  const seq = Number((await db.get('SELECT COALESCE(MAX(seq),0) AS n FROM shooting_day_records WHERE org_id=? AND shooting_day_id=? AND kind=?',
    [orgId, day.id, input.kind]))?.n ?? 0) + 1;
  await db.batch([
    {sql: `INSERT INTO shooting_day_records(org_id,project_id,work_id,shooting_day_id,kind,seq,status,source_document_id,reason,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, day.project_id, day.work_id, day.id, input.kind, seq, input.status, document?.id ?? null, placed ? null : input.reason, userId]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'shooting_day_record', `${day.id}:${input.kind}:${seq}`,
      JSON.stringify({dayId: day.id, kind: input.kind, status: input.status, sourceDocumentId: document?.id ?? null})]},
  ]);
}

export async function addItem(db, {orgId, day, userId, input}) {
  await db.batch([
    {sql: `INSERT INTO shooting_day_report_items(org_id,project_id,work_id,shooting_day_id,department,item_type,status,body,scene_id,record_id,replaces_id,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, day.project_id, day.work_id, day.id, input.department, input.itemType, input.status, input.body, input.sceneId, input.recordId, input.replacesId, userId]},
    {sql: AUDIT_INSERT, params: [orgId, userId, input.status === 'withdrawn' ? 'withdraw' : 'append', 'shooting_day_report_item', `${day.id}:${input.department}`,
      JSON.stringify({dayId: day.id, department: input.department, itemType: input.itemType, replacesId: input.replacesId})]},
  ]);
}
