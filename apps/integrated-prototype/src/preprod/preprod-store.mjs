// プリプロの DB の読み書き（DB の役。移行 0053 の手配・美術の項目・シーンの撮影の方針と、権限の判定に要る読み取り）。
// 表は追加だけ。版の番号は INSERT の中で「いまの最大 +1」を取り、移行のトリガーが連番を守る。

export const findWork = (db, orgId, workId) => db.get('SELECT id,project_id FROM works WHERE org_id=? AND id=?', [orgId, workId]);

export const projectGrant = (db, orgId, projectId, userId, nowIso) =>
  db.get('SELECT permission FROM project_memberships WHERE org_id=? AND project_id=? AND user_id=? AND (expires_at IS NULL OR expires_at>?)', [orgId, projectId, userId, nowIso]);

export async function readPlanRows(db, orgId, workId) {
  const scope = [orgId, workId];
  const [arrangements, artItems, shootPlans, partners] = await Promise.all([
    db.all('SELECT * FROM production_arrangement_versions WHERE org_id=? AND work_id=? ORDER BY arrangement_key,version_no', scope),
    db.all('SELECT * FROM scene_art_item_versions WHERE org_id=? AND work_id=? ORDER BY item_key,version_no', scope),
    db.all('SELECT * FROM scene_shoot_plan_versions WHERE org_id=? AND work_id=? ORDER BY scene_id,version_no', scope),
    db.all('SELECT id,name FROM partners WHERE org_id=? ORDER BY name', [orgId]),
  ]);
  return {arrangements, artItems, shootPlans, partners};
}

export const appendArrangement = (db, orgId, userId, workId, row) => db.run(
  `INSERT INTO production_arrangement_versions(org_id,work_id,arrangement_key,version_no,kind,partner_id,item,quantity,unit,capacity,starts_on,ends_on,deadline_on,state,note,created_by)
   SELECT ?,?,?,COALESCE(MAX(version_no),0)+1,?,?,?,?,?,?,?,?,?,?,?,? FROM production_arrangement_versions WHERE org_id=? AND work_id=? AND arrangement_key=?`,
  [orgId, workId, row.key, row.kind, row.partner_id, row.item, row.quantity, row.unit, row.capacity, row.starts_on, row.ends_on, row.deadline_on, row.state, row.note, userId, orgId, workId, row.key]);

export const appendArtItem = (db, orgId, userId, workId, row) => db.run(
  `INSERT INTO scene_art_item_versions(org_id,work_id,item_key,version_no,scene_id,kind,content,owner_label,delivery_on,state,note,created_by)
   SELECT ?,?,?,COALESCE(MAX(version_no),0)+1,?,?,?,?,?,?,?,? FROM scene_art_item_versions WHERE org_id=? AND work_id=? AND item_key=?`,
  [orgId, workId, row.key, row.scene_id, row.kind, row.content, row.owner_label, row.delivery_on, row.state, row.note, userId, orgId, workId, row.key]);

export const appendShootPlan = (db, orgId, userId, workId, row) => db.run(
  `INSERT INTO scene_shoot_plan_versions(org_id,work_id,scene_id,version_no,methods,equipment,note,created_by)
   SELECT ?,?,?,COALESCE(MAX(version_no),0)+1,?,?,?,? FROM scene_shoot_plan_versions WHERE org_id=? AND work_id=? AND scene_id=?`,
  [orgId, workId, row.scene_id, row.methods, row.equipment, row.note, userId, orgId, workId, row.scene_id]);

export const writeAudit = (db, orgId, userId, action, entity, id, detail) =>
  db.run('INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', [orgId, userId, action, entity, String(id), JSON.stringify(detail)]);
