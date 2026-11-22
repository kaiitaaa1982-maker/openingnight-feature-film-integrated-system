// 撮影の許可申請の DB の読み書き（DB の役。移行 0060 の提出先・提出先の設定の版・申請・申請の版・原本の結び付き）。
// 表は追加だけ。版の番号は呼ぶ側が「読んだ版 +1」を渡し、移行のトリガーと一意の制約が連番を守る（楽観ロック）。

export const readOffices = (db, orgId) => db.all('SELECT id,name,created_at FROM permit_offices WHERE org_id=? ORDER BY name,id', [orgId]);
export const readOfficeVersions = (db, orgId) => db.all('SELECT * FROM permit_office_versions WHERE org_id=? ORDER BY office_id,version_no', [orgId]);
export const findOffice = (db, orgId, officeId) => db.get('SELECT id,name FROM permit_offices WHERE org_id=? AND id=?', [orgId, officeId]);
export const latestOfficeVersion = (db, orgId, officeId) =>
  db.get('SELECT * FROM permit_office_versions WHERE org_id=? AND office_id=? ORDER BY version_no DESC LIMIT 1', [orgId, officeId]);

// 提出先と最初の設定の版を1回の batch で作る（名前は組織の中で一意）
export async function createOffice(db, orgId, userId, row) {
  await db.batch([
    {sql: 'INSERT INTO permit_offices(org_id,name,created_by) VALUES(?,?,?)', params: [orgId, row.name, userId]},
    {sql: `INSERT INTO permit_office_versions(org_id,office_id,version_no,lead_business_days,max_span_days,note,created_by)
      SELECT ?,id,1,?,?,?,? FROM permit_offices WHERE org_id=? AND name=?`, params: [orgId, row.lead_business_days, row.max_span_days, row.note, userId, orgId, row.name]},
  ]);
  return db.get('SELECT id FROM permit_offices WHERE org_id=? AND name=?', [orgId, row.name]);
}

export const appendOfficeVersion = (db, orgId, userId, officeId, versionNo, row) => db.run(
  'INSERT INTO permit_office_versions(org_id,office_id,version_no,lead_business_days,max_span_days,note,created_by) VALUES(?,?,?,?,?,?,?)',
  [orgId, officeId, versionNo, row.lead_business_days, row.max_span_days, row.note, userId]);

// 作品の並び（works の id・案件・題）。見る権限の絞り込みは受け口が行う
export const readWorks = (db, orgId) => db.all('SELECT id,project_id,title FROM works WHERE org_id=? ORDER BY id', [orgId]);

export const findApplication = (db, orgId, id) => db.get('SELECT * FROM permit_applications WHERE org_id=? AND id=?', [orgId, id]);

// 組織の申請と全部の版と原本の数（1つの時点で読む）。見る権限の絞り込みは受け口が作品で行う
export async function readApplicationRows(db, orgId) {
  const [applications, versions, documentCounts] = await db.readBatch([
    {sql: 'SELECT * FROM permit_applications WHERE org_id=? ORDER BY id', params: [orgId]},
    {sql: 'SELECT * FROM permit_application_versions WHERE org_id=? ORDER BY application_id,version_no', params: [orgId]},
    {sql: 'SELECT application_id,COUNT(*) AS n FROM permit_application_documents WHERE org_id=? GROUP BY application_id', params: [orgId]},
  ]);
  return {applications, versions, documentCounts};
}

export const readApplicationVersions = (db, orgId, applicationId) =>
  db.all('SELECT * FROM permit_application_versions WHERE org_id=? AND application_id=? ORDER BY version_no', [orgId, applicationId]);

export const readApplicationDocuments = (db, orgId, applicationId) => db.all(`SELECT l.id,l.document_id,l.role,l.created_at,d.file_name,d.media_type,d.byte_length,d.storage,d.received_on
  FROM permit_application_documents l JOIN source_documents d ON d.org_id=l.org_id AND d.id=l.document_id
  WHERE l.org_id=? AND l.application_id=? ORDER BY l.id`, [orgId, applicationId]);

const VERSION_COLUMNS = 'office_id,place,starts_on,ends_on,applied_on,pickup_on,received_on,state,fee_yen,note';
const versionParams = (row) => [row.office_id, row.place, row.starts_on, row.ends_on, row.applied_on, row.pickup_on, row.received_on, row.state, row.fee_yen, row.note];

// 申請と最初の版を1回の batch で作る。同じ batch のあとの文は一意の application_key で申請を引く
export async function createApplication(db, orgId, userId, {key, workId, kind}, row) {
  await db.batch([
    {sql: 'INSERT INTO permit_applications(org_id,work_id,application_key,kind,created_by) VALUES(?,?,?,?,?)', params: [orgId, workId, key, kind, userId]},
    {sql: `INSERT INTO permit_application_versions(org_id,application_id,version_no,${VERSION_COLUMNS},created_by)
      SELECT ?,id,1,?,?,?,?,?,?,?,?,?,?,? FROM permit_applications WHERE org_id=? AND application_key=?`, params: [orgId, ...versionParams(row), userId, orgId, key]},
  ]);
  return db.get('SELECT id FROM permit_applications WHERE org_id=? AND application_key=?', [orgId, key]);
}

export const appendApplicationVersion = (db, orgId, userId, applicationId, versionNo, row) => db.run(
  `INSERT INTO permit_application_versions(org_id,application_id,version_no,${VERSION_COLUMNS},created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [orgId, applicationId, versionNo, ...versionParams(row), userId]);

export const linkDocument = (db, orgId, userId, applicationId, documentId, role) => db.run(
  'INSERT INTO permit_application_documents(org_id,application_id,document_id,role,linked_by) VALUES(?,?,?,?,?)', [orgId, applicationId, documentId, role, userId]);

// 原本の置き場（GET /api/source-documents/tree）から辿る許可申請。行は申請ごと
export const readPermitSourceLinks = (db, orgId) => db.all(`SELECT l.document_id,a.id AS target_id,w.id AS work_id,w.title AS name,COUNT(*) AS n
  FROM permit_application_documents l JOIN permit_applications a ON a.org_id=l.org_id AND a.id=l.application_id
  JOIN works w ON w.org_id=a.org_id AND w.id=a.work_id
  WHERE l.org_id=? GROUP BY l.document_id,a.id,w.id,w.title ORDER BY w.title,a.id`, [orgId]);
