// 小道具の品目・版・打ち合わせの DB の読み書き（DB の役。移行 0061）。
// 表は追加だけ。版の番号は呼ぶ側が「読んだ版 +1」を渡し、移行のトリガーと一意の制約が連番を守る（楽観ロック）。

const VERSION_COLUMNS = 'scene_label,shoot_on,place,name,quantity,kind,department,owner_label,state,next_action,due_on,source,script_note,memo,meeting_id';
const versionParams = (row, meetingId) => [row.scene_label, row.shoot_on, row.place, row.name, row.quantity, row.kind, row.department, row.owner_label,
  row.state, row.next_action, row.due_on, row.source, row.script_note, row.memo, meetingId ?? null];
const VERSION_MARKS = '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?';

export const readWorks = (db, orgId) => db.all('SELECT id,project_id,title FROM works WHERE org_id=? ORDER BY id', [orgId]);

// 作品の品目・全部の版・打ち合わせ（1つの時点で読む）
export async function readWorkRows(db, orgId, workId) {
  const [items, versions, meetings] = await db.readBatch([
    {sql: 'SELECT * FROM prop_items WHERE org_id=? AND work_id=? ORDER BY id', params: [orgId, workId]},
    {sql: `SELECT v.* FROM prop_item_versions v JOIN prop_items i ON i.org_id=v.org_id AND i.id=v.item_id
      WHERE v.org_id=? AND i.work_id=? ORDER BY v.item_id,v.version_no`, params: [orgId, workId]},
    {sql: `SELECT m.*,(SELECT COUNT(*) FROM prop_item_versions v WHERE v.org_id=m.org_id AND v.meeting_id=m.id) AS decided
      FROM prop_meetings m WHERE m.org_id=? AND m.work_id=? ORDER BY m.held_on DESC,m.id DESC`, params: [orgId, workId]},
  ]);
  return {items, versions, meetings};
}

export const findItem = (db, orgId, id) => db.get('SELECT * FROM prop_items WHERE org_id=? AND id=?', [orgId, id]);
export const findMeeting = (db, orgId, id) => db.get('SELECT * FROM prop_meetings WHERE org_id=? AND id=?', [orgId, id]);

export const readItemVersions = (db, orgId, itemId) => db.all(`SELECT v.*,m.title AS meeting_title,m.held_on AS meeting_held_on
  FROM prop_item_versions v LEFT JOIN prop_meetings m ON m.org_id=v.org_id AND m.id=v.meeting_id
  WHERE v.org_id=? AND v.item_id=? ORDER BY v.version_no`, [orgId, itemId]);

export async function readMeetingVersions(db, orgId, meetingId) {
  const [versions, items] = await db.readBatch([
    {sql: 'SELECT * FROM prop_item_versions WHERE org_id=? AND meeting_id=? ORDER BY id', params: [orgId, meetingId]},
    {sql: `SELECT i.* FROM prop_items i WHERE i.org_id=? AND i.id IN (SELECT item_id FROM prop_item_versions WHERE org_id=? AND meeting_id=?)`, params: [orgId, orgId, meetingId]},
  ]);
  return {versions, items};
}

export const readItemKeys = async (db, orgId, workId) =>
  new Set((await db.all('SELECT item_key FROM prop_items WHERE org_id=? AND work_id=?', [orgId, workId])).map((r) => r.item_key));

// 品目と最初の版を作る文（batch に並べる）。あとの文は一意の (work_id,item_key) で品目を引く
function createStatements(orgId, userId, workId, key, row, meetingId) {
  return [
    {sql: 'INSERT INTO prop_items(org_id,work_id,item_key,created_by) VALUES(?,?,?,?)', params: [orgId, workId, key, userId]},
    {sql: `INSERT INTO prop_item_versions(org_id,item_id,version_no,${VERSION_COLUMNS},created_by)
      SELECT ?,id,1,${VERSION_MARKS},? FROM prop_items WHERE org_id=? AND work_id=? AND item_key=?`, params: [orgId, ...versionParams(row, meetingId), userId, orgId, workId, key]},
  ];
}

export async function createItem(db, orgId, userId, workId, key, row, meetingId = null) {
  await db.batch(createStatements(orgId, userId, workId, key, row, meetingId));
  return db.get('SELECT id FROM prop_items WHERE org_id=? AND work_id=? AND item_key=?', [orgId, workId, key]);
}

// 取込: まとめて1回の batch で作る（途中で落ちれば何も残らない）
export const createItems = (db, orgId, userId, workId, list) =>
  db.batch(list.flatMap(({key, row}) => createStatements(orgId, userId, workId, key, row, null)));

export const appendItemVersion = (db, orgId, userId, itemId, versionNo, row, meetingId = null) => db.run(
  `INSERT INTO prop_item_versions(org_id,item_id,version_no,${VERSION_COLUMNS},created_by) VALUES(?,?,?,${VERSION_MARKS},?)`,
  [orgId, itemId, versionNo, ...versionParams(row, meetingId), userId]);

export const createMeeting = (db, orgId, userId, workId, row) => db.get(
  'INSERT INTO prop_meetings(org_id,work_id,held_on,title,departments,note,created_by) VALUES(?,?,?,?,?,?,?) RETURNING id',
  [orgId, workId, row.held_on, row.title, row.departments, row.note, userId]);
