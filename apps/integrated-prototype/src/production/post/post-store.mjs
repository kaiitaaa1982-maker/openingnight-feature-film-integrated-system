// ポストプロダクションの DB の読み書き（移行 0025。要件 docs/requirements/production/post-production.md）。
// どの表も足すだけ。1回の書き込みと変更の記録 audit_log の1行を1回の batch で書く（本文や TC は残さない）
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const audit = (orgId, userId, entityType, workId, detail) => ({sql: AUDIT_INSERT, params: [orgId, userId, 'append', entityType, String(workId), JSON.stringify(detail)]});

export async function readPostWorks(db, orgId, projectIds) {
  if (!projectIds.length) return [];
  return db.all(`SELECT w.id,w.project_id,w.code,w.title,p.title AS project_title FROM works w JOIN projects p ON p.org_id=w.org_id AND p.id=w.project_id
    WHERE w.org_id=? AND w.project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY w.id`, [orgId, ...projectIds]);
}

export async function readPostWork(db, orgId, workId) {
  return db.get(`SELECT w.id,w.project_id,w.code,w.title,p.title AS project_title FROM works w JOIN projects p ON p.org_id=w.org_id AND p.id=w.project_id
    WHERE w.org_id=? AND w.id=?`, [orgId, workId]);
}

// 1作品の全部（版・指摘・対応・タスク・タスクの記録・納品物・納品物の記録・指している取引先への納品）
export async function readPostDetail(db, orgId, workId) {
  const [cuts, notes, actions, tasks, taskEvents, items, itemEvents, sales] = await Promise.all([
    db.all(`SELECT id,episode_no,variant,label,kind,delivered_on,runtime_seconds,review_url,created_at FROM post_cuts WHERE org_id=? AND work_id=? ORDER BY id`, [orgId, workId]),
    db.all(`SELECT id,cut_id,tc_in_seconds,tc_out_seconds,viewpoint,from_role,assignee,body,created_at FROM post_notes WHERE org_id=? AND work_id=? ORDER BY id`, [orgId, workId]),
    db.all(`SELECT id,note_id,result,fixed_cut_id,reason,created_at FROM post_note_actions WHERE org_id=? AND work_id=? ORDER BY id`, [orgId, workId]),
    db.all(`SELECT id,phase,episode_no,name,due_on,assignee,created_at FROM post_tasks WHERE org_id=? AND work_id=? ORDER BY id`, [orgId, workId]),
    db.all(`SELECT id,task_id,kind,due_on,on_date FROM post_task_events WHERE org_id=? AND work_id=? ORDER BY id`, [orgId, workId]),
    db.all(`SELECT id,source_kind,committee_contract_id,committee_term_version_id,sales_deliverable_id,section,name,episode_no,spec,owner,created_at
      FROM post_deliverable_items WHERE org_id=? AND work_id=? ORDER BY id`, [orgId, workId]),
    db.all(`SELECT id,item_id,status,on_date,note FROM post_deliverable_events WHERE org_id=? AND work_id=? ORDER BY id`, [orgId, workId]),
    db.all(`SELECT id,title,due_on,status,submitted_on,accepted_on FROM sales_deliverables WHERE org_id=? AND work_id=? ORDER BY id`, [orgId, workId]),
  ]);
  return {cuts, notes, actions, tasks, taskEvents, items, itemEvents, sales};
}

export async function readPostSummaries(db, orgId, workIds) {
  if (!workIds.length) return {tasks: [], taskEvents: [], items: [], itemEvents: [], notes: [], actions: []};
  const marks = workIds.map(() => '?').join(',');
  const q = (sql) => db.all(sql.replace('%W', marks), [orgId, ...workIds]);
  const [tasks, taskEvents, items, itemEvents, notes, actions] = await Promise.all([
    q('SELECT id,work_id,phase,due_on FROM post_tasks WHERE org_id=? AND work_id IN (%W) ORDER BY id'),
    q('SELECT task_id,kind,due_on,on_date FROM post_task_events WHERE org_id=? AND work_id IN (%W) ORDER BY id'),
    q('SELECT id,work_id FROM post_deliverable_items WHERE org_id=? AND work_id IN (%W) ORDER BY id'),
    q('SELECT item_id,status,on_date FROM post_deliverable_events WHERE org_id=? AND work_id IN (%W) ORDER BY id'),
    q('SELECT id,work_id FROM post_notes WHERE org_id=? AND work_id IN (%W) ORDER BY id'),
    q('SELECT note_id,result FROM post_note_actions WHERE org_id=? AND work_id IN (%W) ORDER BY id'),
  ]);
  return {tasks, taskEvents, items, itemEvents, notes, actions};
}

export async function readCutForWork(db, orgId, workId, cutId) {
  return db.get('SELECT id FROM post_cuts WHERE org_id=? AND work_id=? AND id=?', [orgId, workId, cutId]);
}
export async function readNoteForWork(db, orgId, workId, noteId) {
  return db.get('SELECT id FROM post_notes WHERE org_id=? AND work_id=? AND id=?', [orgId, workId, noteId]);
}
export async function readTaskForWork(db, orgId, workId, taskId) {
  return db.get('SELECT id FROM post_tasks WHERE org_id=? AND work_id=? AND id=?', [orgId, workId, taskId]);
}
export async function readItemForWork(db, orgId, workId, itemId) {
  return db.get('SELECT id FROM post_deliverable_items WHERE org_id=? AND work_id=? AND id=?', [orgId, workId, itemId]);
}
export async function readSalesDeliverableForWork(db, orgId, workId, id) {
  return db.get('SELECT id FROM sales_deliverables WHERE org_id=? AND work_id=? AND id=?', [orgId, workId, id]);
}

export async function addCut(db, orgId, work, v, userId) {
  await db.batch([
    {sql: `INSERT INTO post_cuts(org_id,project_id,work_id,episode_no,variant,label,kind,delivered_on,runtime_seconds,review_url,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      params: [orgId, work.project_id, work.id, v.episodeNo, v.variant, v.label, v.kind, v.deliveredOn, v.runtimeSeconds, v.reviewUrl, userId]},
    audit(orgId, userId, 'post_cut', work.id, {label: v.label, kind: v.kind}),
  ]);
}

export async function addNote(db, orgId, work, v, userId) {
  await db.batch([
    {sql: `INSERT INTO post_notes(org_id,work_id,cut_id,tc_in_seconds,tc_out_seconds,viewpoint,from_role,assignee,body,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      params: [orgId, work.id, v.cutId, v.tcIn, v.tcOut, v.viewpoint, v.fromRole, v.assignee, v.body, userId]},
    audit(orgId, userId, 'post_note', work.id, {cutId: v.cutId, viewpoint: v.viewpoint}),
  ]);
}

export async function addNoteAction(db, orgId, work, noteId, v, userId) {
  await db.batch([
    {sql: 'INSERT INTO post_note_actions(org_id,work_id,note_id,result,fixed_cut_id,reason,created_by) VALUES(?,?,?,?,?,?,?)',
      params: [orgId, work.id, noteId, v.result, v.fixedCutId, v.reason, userId]},
    audit(orgId, userId, 'post_note_action', work.id, {noteId, result: v.result}),
  ]);
}

export async function addTask(db, orgId, work, v, userId) {
  await db.batch([
    {sql: 'INSERT INTO post_tasks(org_id,project_id,work_id,phase,episode_no,name,due_on,assignee,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
      params: [orgId, work.project_id, work.id, v.phase, v.episodeNo, v.name, v.dueOn, v.assignee, userId]},
    audit(orgId, userId, 'post_task', work.id, {phase: v.phase}),
  ]);
}

export async function addTaskEvent(db, orgId, work, taskId, v, onDate, userId) {
  await db.batch([
    {sql: 'INSERT INTO post_task_events(org_id,work_id,task_id,kind,due_on,on_date,created_by) VALUES(?,?,?,?,?,?,?)',
      params: [orgId, work.id, taskId, v.kind, v.dueOn, onDate, userId]},
    audit(orgId, userId, 'post_task_event', work.id, {taskId, kind: v.kind}),
  ]);
}

export async function addDeliverables(db, orgId, work, list, userId) {
  await db.batch([
    ...list.map((v) => ({sql: `INSERT INTO post_deliverable_items(org_id,project_id,work_id,source_kind,sales_deliverable_id,section,name,episode_no,spec,owner,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, params: [orgId, work.project_id, work.id, v.sourceKind, v.salesDeliverableId, v.section, v.name, v.episodeNo, v.spec, v.owner, userId]})),
    audit(orgId, userId, 'post_deliverable', work.id, {count: list.length}),
  ]);
}

export async function addDeliverableEvent(db, orgId, work, itemId, v, userId) {
  await db.batch([
    {sql: 'INSERT INTO post_deliverable_events(org_id,work_id,item_id,status,on_date,note,created_by) VALUES(?,?,?,?,?,?,?)',
      params: [orgId, work.id, itemId, v.status, v.onDate, v.note, userId]},
    audit(orgId, userId, 'post_deliverable_event', work.id, {itemId, status: v.status}),
  ]);
}
