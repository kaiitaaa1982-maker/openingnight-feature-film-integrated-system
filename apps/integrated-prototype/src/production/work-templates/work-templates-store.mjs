// 制作部の業務のひな型の DB の読み書き（DB の役。移行 0057 の4表）。表はすべて追加だけ。org_id を必ず付ける。
// 原本そのものは共通の source_documents（src/source-documents/source-documents-store.mjs）が持ち、ここは結びの行だけ足す。
// 書くたびに同じ batch で audit_log に1行残す（中身の本文は残さない）。
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';

// フォルダの現在の値 = 最新の直し（work_template_folder_revisions）。直しが無ければ作ったときの値
const FOLDER_CURRENT = `FROM work_template_folders f
  LEFT JOIN work_template_folder_revisions fr ON fr.org_id=f.org_id AND fr.folder_id=f.id
   AND fr.rev_no=(SELECT MAX(x.rev_no) FROM work_template_folder_revisions x WHERE x.org_id=f.org_id AND x.folder_id=f.id)`;
const FOLDER_COLUMNS = `f.id, f.created_at,
  CASE WHEN fr.id IS NULL THEN f.name ELSE fr.name END AS name,
  CASE WHEN fr.id IS NULL THEN f.description ELSE fr.description END AS description,
  CASE WHEN fr.id IS NULL THEN 0 ELSE fr.retired END AS retired,
  CASE WHEN fr.id IS NULL THEN 0 ELSE fr.rev_no END AS rev_no`;
// 現在そのフォルダにある、やめていないひな型の数
const TEMPLATE_COUNT = `(SELECT COUNT(*) FROM work_templates t
  JOIN work_template_versions v ON v.org_id=t.org_id AND v.template_id=t.id
   AND v.version_no=(SELECT MAX(x.version_no) FROM work_template_versions x WHERE x.org_id=t.org_id AND x.template_id=t.id)
  WHERE t.org_id=f.org_id AND v.retired=0
   AND COALESCE((SELECT m.folder_id FROM work_template_moves m WHERE m.org_id=t.org_id AND m.template_id=t.id
     AND m.move_no=(SELECT MAX(y.move_no) FROM work_template_moves y WHERE y.org_id=t.org_id AND y.template_id=t.id)),t.folder_id)=f.id)`;

export const readFolders = (db, orgId, {withRetired = false} = {}) => db.all(`SELECT ${FOLDER_COLUMNS}, ${TEMPLATE_COUNT} AS template_count
  ${FOLDER_CURRENT} WHERE f.org_id=?${withRetired ? '' : ' AND (fr.id IS NULL OR fr.retired=0)'} ORDER BY f.id`, [orgId]);
export const findFolder = (db, orgId, folderId) => db.get(`SELECT ${FOLDER_COLUMNS} ${FOLDER_CURRENT} WHERE f.org_id=? AND f.id=?`, [orgId, folderId]);
// フォルダの名前・説明・やめた印の履歴（新しい順）。作ったときの値を 0 番として添える
export async function readFolderRevisions(db, orgId, folderId) {
  const rows = await db.all(`SELECT r.rev_no, r.name, r.description, r.retired, r.reason, r.created_at, u.display_name AS author
    FROM work_template_folder_revisions r LEFT JOIN users u ON u.id=r.created_by WHERE r.org_id=? AND r.folder_id=? ORDER BY r.rev_no DESC`, [orgId, folderId]);
  const first = await db.get('SELECT f.name, f.description, f.created_at, u.display_name AS author FROM work_template_folders f LEFT JOIN users u ON u.id=f.created_by WHERE f.org_id=? AND f.id=?', [orgId, folderId]);
  return [...rows.map((r) => ({...r, rev_no: Number(r.rev_no), retired: Boolean(r.retired)})), {rev_no: 0, name: first.name, description: first.description, retired: false, reason: null, created_at: first.created_at, author: first.author}];
}

export async function insertFolder(db, orgId, userId, folder) {
  const out = await db.batch([
    {sql: 'INSERT INTO work_template_folders(org_id,name,description,created_by) VALUES(?,?,?,?) RETURNING id', params: [orgId, folder.name, folder.description, userId]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'work_template_folder', folder.name, JSON.stringify({name: folder.name})]},
  ]);
  return Number(out[0].rows[0].id);
}

// フォルダの名前・説明・やめた印を直す（追加だけ）。前の番号を渡し、取り合いは DB のトリガーが断る。名前の重なりも DB が断る
export async function insertFolderRevision(db, orgId, userId, folderId, revNo, folder) {
  await db.batch([
    {sql: 'INSERT INTO work_template_folder_revisions(org_id,folder_id,rev_no,name,description,retired,reason,created_by) VALUES(?,?,?,?,?,?,?,?)',
      params: [orgId, folderId, revNo, folder.name, folder.description, folder.retired ? 1 : 0, folder.reason, userId]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'work_template_folder_revision', String(folderId), JSON.stringify({revNo, retired: folder.retired})]},
  ]);
}

// ひな型を別のフォルダへ移す（追加だけ）
export async function insertMove(db, orgId, userId, templateId, moveNo, folderId, reason) {
  await db.batch([
    {sql: 'INSERT INTO work_template_moves(org_id,template_id,move_no,folder_id,reason,created_by) VALUES(?,?,?,?,?,?)', params: [orgId, templateId, moveNo, folderId, reason, userId]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'work_template_move', String(templateId), JSON.stringify({moveNo, folderId})]},
  ]);
}
export const readMoves = (db, orgId, templateId) => db.all(`SELECT m.move_no, m.folder_id, m.reason, m.created_at, u.display_name AS author,
  CASE WHEN fr.id IS NULL THEN f.name ELSE fr.name END AS folder_name
  FROM work_template_moves m JOIN work_template_folders f ON f.org_id=m.org_id AND f.id=m.folder_id
  LEFT JOIN work_template_folder_revisions fr ON fr.org_id=f.org_id AND fr.folder_id=f.id AND fr.rev_no=(SELECT MAX(x.rev_no) FROM work_template_folder_revisions x WHERE x.org_id=f.org_id AND x.folder_id=f.id)
  LEFT JOIN users u ON u.id=m.created_by WHERE m.org_id=? AND m.template_id=? ORDER BY m.move_no DESC`, [orgId, templateId]);

// ひな型の一覧の共通の形（最新の版）
const LATEST = `FROM work_templates t
  JOIN work_template_versions v ON v.org_id=t.org_id AND v.template_id=t.id
   AND v.version_no=(SELECT MAX(x.version_no) FROM work_template_versions x WHERE x.org_id=t.org_id AND x.template_id=t.id)
  LEFT JOIN work_template_moves mv ON mv.org_id=t.org_id AND mv.template_id=t.id
   AND mv.move_no=(SELECT MAX(y.move_no) FROM work_template_moves y WHERE y.org_id=t.org_id AND y.template_id=t.id)
  JOIN work_template_folders f ON f.org_id=t.org_id AND f.id=COALESCE(mv.folder_id,t.folder_id)
  LEFT JOIN work_template_folder_revisions fr ON fr.org_id=f.org_id AND fr.folder_id=f.id
   AND fr.rev_no=(SELECT MAX(z.rev_no) FROM work_template_folder_revisions z WHERE z.org_id=f.org_id AND z.folder_id=f.id)`;
const LATEST_COLUMNS = `t.id, f.id AS folder_id, CASE WHEN fr.id IS NULL THEN f.name ELSE fr.name END AS folder_name,
  CASE WHEN fr.id IS NULL THEN 0 ELSE fr.retired END AS folder_retired, CASE WHEN mv.id IS NULL THEN 0 ELSE mv.move_no END AS move_no,
  t.created_at, t.copied_from_template_id, t.copied_from_version_no,
  v.version_no, v.name, v.purpose, v.scene, v.retired, v.drive_ref, v.created_at AS updated_at,
  (SELECT COUNT(*) FROM work_template_files wf WHERE wf.org_id=t.org_id AND wf.template_id=t.id) AS file_count`;

export const readTemplates = (db, orgId, folderId, {withRetired = false} = {}) => db.all(
  `SELECT ${LATEST_COLUMNS} ${LATEST} WHERE t.org_id=? AND f.id=?${withRetired ? '' : ' AND v.retired=0'} ORDER BY t.id`, [orgId, folderId]);

// 名前・何のためか・使う場面・フォルダの名前・原本のファイル名の部分一致（% と _ も検索する文字）
export function searchTemplates(db, orgId, q, {withRetired = false, limit = 100} = {}) {
  const pattern = `%${q.trim().replace(/[!%_]/g, '!$&')}%`;
  return db.all(`SELECT ${LATEST_COLUMNS} ${LATEST} WHERE t.org_id=?${withRetired ? '' : ' AND v.retired=0 AND (fr.id IS NULL OR fr.retired=0)'}
    AND (LOWER(v.name) LIKE LOWER(?) ESCAPE '!' OR LOWER(COALESCE(v.purpose,'')) LIKE LOWER(?) ESCAPE '!' OR LOWER(COALESCE(v.scene,'')) LIKE LOWER(?) ESCAPE '!'
      OR LOWER(CASE WHEN fr.id IS NULL THEN f.name ELSE fr.name END) LIKE LOWER(?) ESCAPE '!'
      OR EXISTS (SELECT 1 FROM work_template_files wf JOIN source_documents d ON d.org_id=wf.org_id AND d.id=wf.document_id
        WHERE wf.org_id=t.org_id AND wf.template_id=t.id AND LOWER(d.file_name) LIKE LOWER(?) ESCAPE '!'))
    ORDER BY t.id DESC LIMIT ?`, [orgId, pattern, pattern, pattern, pattern, pattern, limit]);
}

export const findTemplate = (db, orgId, templateId) => db.get(`SELECT ${LATEST_COLUMNS} ${LATEST} WHERE t.org_id=? AND t.id=?`, [orgId, templateId]);

export const readVersions = (db, orgId, templateId) => db.all(`SELECT v.id, v.version_no, v.name, v.purpose, v.scene, v.blocks_json, v.variables_json, v.source_json, v.drive_ref,
  v.retired, v.reason, v.created_at, u.display_name AS author
  FROM work_template_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.org_id=? AND v.template_id=? ORDER BY v.version_no DESC`, [orgId, templateId]);

const VERSION_INSERT = `INSERT INTO work_template_versions(org_id,template_id,version_no,name,purpose,scene,blocks_json,variables_json,source_json,drive_ref,retired,reason,created_by)`;
const versionParams = (orgId, userId, versionNo, v) => [versionNo, v.name, v.purpose, v.scene, JSON.stringify(v.blocks), JSON.stringify(v.variables), JSON.stringify(v.source), v.driveRef, v.retired ? 1 : 0, v.reason, userId];

// ひな型の本体と1版目を同じ batch で足す（本体だけ残らない）。同じ batch の中で本体の ID は組織内の最大の ID で引く
export async function insertTemplate(db, orgId, userId, folderId, version, copiedFrom = null) {
  const out = await db.batch([
    {sql: 'INSERT INTO work_templates(org_id,folder_id,copied_from_template_id,copied_from_version_no,created_by) VALUES(?,?,?,?,?) RETURNING id',
      params: [orgId, folderId, copiedFrom?.templateId ?? null, copiedFrom?.versionNo ?? null, userId]},
    {sql: `${VERSION_INSERT} SELECT ?,(SELECT MAX(t.id) FROM work_templates t WHERE t.org_id=?),?,?,?,?,?,?,?,?,?,?,?`, params: [orgId, orgId, ...versionParams(orgId, userId, 1, version)]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'work_template', version.name, JSON.stringify({folderId, copiedFrom})]},
  ]);
  return Number(out[0].rows[0].id);
}

// 新しい版。前の版の番号を渡し、取り合いは DB のトリガー（work_template_versions_sequence）が断る
export async function insertVersion(db, orgId, userId, templateId, versionNo, version) {
  await db.batch([
    {sql: `${VERSION_INSERT} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [orgId, templateId, ...versionParams(orgId, userId, versionNo, version)]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'work_template_version', String(templateId), JSON.stringify({versionNo, retired: version.retired})]},
  ]);
}

export const readFiles = (db, orgId, templateId) => db.all(`SELECT wf.id, wf.file_no, wf.document_id, wf.drive_ref, wf.reason, wf.created_at, u.display_name AS author,
  d.file_name, d.media_type, d.byte_length, d.sha256, d.received_on
  FROM work_template_files wf JOIN source_documents d ON d.org_id=wf.org_id AND d.id=wf.document_id LEFT JOIN users u ON u.id=wf.created_by
  WHERE wf.org_id=? AND wf.template_id=? ORDER BY wf.file_no DESC`, [orgId, templateId]);
export const findFile = (db, orgId, fileId) => db.get('SELECT id,template_id,file_no,document_id FROM work_template_files WHERE org_id=? AND id=?', [orgId, fileId]);

export async function insertFile(db, orgId, userId, templateId, fileNo, documentId, {driveRef, reason}) {
  await db.batch([
    {sql: 'INSERT INTO work_template_files(org_id,template_id,file_no,document_id,drive_ref,reason,created_by) VALUES(?,?,?,?,?,?,?)', params: [orgId, templateId, fileNo, documentId, driveRef, reason, userId]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'work_template_file', String(templateId), JSON.stringify({fileNo, documentId})]},
  ]);
}
