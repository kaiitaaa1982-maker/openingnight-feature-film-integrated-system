// プロデュース管理の進行表の DB の読み書き（移行 0047。要件 docs/requirements/planning/produce-progress.md）。
// どの表も追加だけ。版・連番の取り合いは DB のトリガーが断る（受け口が 409 にする）。変更の記録 audit_log に1行残す（本文は残さない）
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';

export async function readProduceProject(db, orgId, projectId) {
  return db.get('SELECT id,code,title,status FROM projects WHERE org_id=? AND id=?', [orgId, projectId]);
}

export async function readProjectsByIds(db, orgId, ids) {
  if (!ids.length) return [];
  return db.all(`SELECT id,code,title,status FROM projects WHERE org_id=? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, [orgId, ...ids]);
}

export async function readProjectWorks(db, orgId, projectId) {
  return db.all('SELECT id,code,title FROM works WHERE org_id=? AND project_id=? ORDER BY id', [orgId, projectId]);
}

const taskView = (r) => ({id: Number(r.id), taskUid: Number(r.task_uid), versionNo: Number(r.version_no), projectId: Number(r.project_id),
  workId: r.work_id == null ? null : Number(r.work_id), kind: r.kind, phase: r.phase, title: r.title, role: r.role, assigneeLabel: r.assignee_label,
  checkers: r.checkers, plannedStart: r.planned_start, plannedEnd: r.planned_end, milestoneCode: r.milestone_code, templateLabel: r.template_label,
  retired: Number(r.retired) === 1, reason: r.reason, createdAt: r.created_at});

export async function readTaskVersions(db, orgId, projectIds) {
  if (!projectIds.length) return [];
  const rows = await db.all(`SELECT id,task_uid,version_no,project_id,work_id,kind,phase,title,role,assignee_label,checkers,planned_start,planned_end,milestone_code,
    template_label,retired,reason,created_at FROM produce_tasks WHERE org_id=? AND project_id IN (${projectIds.map(() => '?').join(',')})
    ORDER BY task_uid,version_no`, [orgId, ...projectIds]);
  return rows.map(taskView);
}

export async function readTaskHistory(db, orgId, projectId, taskUid) {
  const rows = await db.all(`SELECT id,task_uid,version_no,project_id,work_id,kind,phase,title,role,assignee_label,checkers,planned_start,planned_end,milestone_code,
    template_label,retired,reason,created_at FROM produce_tasks WHERE org_id=? AND project_id=? AND task_uid=? ORDER BY version_no`, [orgId, projectId, taskUid]);
  return rows.map(taskView);
}

export async function readEvents(db, orgId, projectIds) {
  if (!projectIds.length) return [];
  const rows = await db.all(`SELECT id,project_id,task_uid,kind,on_date,note,created_at FROM produce_task_events WHERE org_id=?
    AND project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY id`, [orgId, ...projectIds]);
  return rows.map((r) => ({seq: Number(r.id), projectId: Number(r.project_id), taskUid: Number(r.task_uid), kind: r.kind, onDate: r.on_date, note: r.note, createdAt: r.created_at}));
}

export async function readChecks(db, orgId, projectId) {
  const rows = await db.all(`SELECT id,task_uid,check_uid,label,checked,created_at FROM produce_task_checks WHERE org_id=? AND project_id=? ORDER BY id`, [orgId, projectId]);
  return rows.map((r) => ({seq: Number(r.id), taskUid: Number(r.task_uid), checkUid: Number(r.check_uid), label: r.label, checked: Number(r.checked) === 1}));
}

export async function readPosts(db, orgId, projectId) {
  const rows = await db.all(`SELECT id,task_uid,speaker_label,body,created_at FROM produce_task_posts WHERE org_id=? AND project_id=? ORDER BY id`, [orgId, projectId]);
  return rows.map((r) => ({id: Number(r.id), taskUid: Number(r.task_uid), speakerLabel: r.speaker_label, body: r.body, createdAt: r.created_at}));
}

export async function readLinks(db, orgId, projectId) {
  const rows = await db.all(`SELECT id,task_uid,link_uid,label,target,is_fallback,removed FROM produce_task_links WHERE org_id=? AND project_id=? ORDER BY id`, [orgId, projectId]);
  return rows.map((r) => ({seq: Number(r.id), taskUid: Number(r.task_uid), linkUid: Number(r.link_uid), label: r.label, target: r.target,
    isFallback: Number(r.is_fallback) === 1, removed: Number(r.removed) === 1}));
}

export async function nextTaskUid(db, orgId) {
  return Number((await db.get('SELECT COALESCE(MAX(task_uid),0)+1 AS n FROM produce_tasks WHERE org_id=?', [orgId])).n);
}

function taskInsert(orgId, projectId, uid, versionNo, t, createdBy) {
  return {sql: `INSERT INTO produce_tasks(org_id,project_id,work_id,task_uid,version_no,kind,phase,title,role,assignee_label,checkers,planned_start,planned_end,
    milestone_code,template_label,retired,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: [orgId, projectId, t.workId ?? null, uid, versionNo, t.kind, t.phase, t.title, t.role, t.assigneeLabel ?? null, t.checkers ?? null, t.plannedStart,
    t.plannedEnd, t.milestoneCode ?? null, t.templateLabel ?? null, t.retired ? 1 : 0, t.reason ?? null, createdBy]};
}
function linkInsert(orgId, projectId, uid, linkUid, l, createdBy, removed = 0) {
  return {sql: `INSERT INTO produce_task_links(org_id,project_id,task_uid,link_uid,label,target,is_fallback,removed,created_by) VALUES(?,?,?,?,?,?,?,?,?)`,
    params: [orgId, projectId, uid, linkUid, l.label, l.target, l.isFallback ? 1 : 0, removed, createdBy]};
}

// 新しいチケットをまとめて足す（テンプレートを当てるときは複数）。tasks[i].links があれば一緒に足す
export async function addTasks(db, orgId, projectId, tasks, {createdBy, firstUid, action = 'append'}) {
  const statements = [];
  tasks.forEach((t, i) => {
    const uid = firstUid + i;
    statements.push(taskInsert(orgId, projectId, uid, 1, t, createdBy));
    (t.links ?? []).forEach((l, j) => statements.push(linkInsert(orgId, projectId, uid, j + 1, l, createdBy)));
  });
  statements.push({sql: AUDIT_INSERT, params: [orgId, createdBy, action, 'produce_task', `${projectId}:${firstUid}`, JSON.stringify({projectId, count: tasks.length})]});
  await db.batch(statements);
  return tasks.map((_, i) => firstUid + i);
}

export async function addTaskVersion(db, orgId, projectId, uid, versionNo, t, {createdBy}) {
  await db.batch([taskInsert(orgId, projectId, uid, versionNo, t, createdBy),
    {sql: AUDIT_INSERT, params: [orgId, createdBy, t.retired ? 'retire' : 'append', 'produce_task', `${projectId}:${uid}:${versionNo}`, JSON.stringify({projectId, versionNo})]}]);
}

export async function addEvent(db, orgId, projectId, uid, {kind, onDate, note}, {createdBy}) {
  await db.run('INSERT INTO produce_task_events(org_id,project_id,task_uid,kind,on_date,note,created_by) VALUES(?,?,?,?,?,?,?)',
    [orgId, projectId, uid, kind, onDate, note ?? null, createdBy]);
}

export async function addCheck(db, orgId, projectId, uid, {checkUid, label, checked}, {createdBy}) {
  await db.run('INSERT INTO produce_task_checks(org_id,project_id,task_uid,check_uid,label,checked,created_by) VALUES(?,?,?,?,?,?,?)',
    [orgId, projectId, uid, checkUid, label, checked ? 1 : 0, createdBy]);
}

export async function addPost(db, orgId, projectId, uid, {speakerLabel, body}, {createdBy}) {
  await db.run('INSERT INTO produce_task_posts(org_id,project_id,task_uid,speaker_label,body,created_by) VALUES(?,?,?,?,?,?)',
    [orgId, projectId, uid, speakerLabel, body, createdBy]);
}

export async function addLink(db, orgId, projectId, uid, linkUid, link, {createdBy, removed = false}) {
  const s = linkInsert(orgId, projectId, uid, linkUid, link, createdBy, removed ? 1 : 0);
  await db.run(s.sql, s.params);
}

// テンプレート（利用者が残したもの）
export async function readTemplates(db, orgId) {
  const heads = await db.all(`SELECT t.id,t.template_uid,t.version_no,t.name,t.anchor_kind,t.retired,t.created_at FROM produce_task_templates t WHERE t.org_id=?
    AND t.version_no=(SELECT MAX(x.version_no) FROM produce_task_templates x WHERE x.org_id=t.org_id AND x.template_uid=t.template_uid) ORDER BY t.template_uid`, [orgId]);
  const live = heads.filter((h) => Number(h.retired) !== 1);
  if (!live.length) return [];
  const items = await db.all(`SELECT template_id,sort_no,kind,phase,title,role,checkers,start_offset_days,end_offset_days,milestone_code,links_json FROM produce_task_template_items
    WHERE org_id=? AND template_id IN (${live.map(() => '?').join(',')}) ORDER BY template_id,sort_no`, [orgId, ...live.map((h) => h.id)]);
  return live.map((h) => ({id: Number(h.template_uid), versionNo: Number(h.version_no), name: h.name, anchorKind: h.anchor_kind, createdAt: h.created_at,
    items: items.filter((i) => Number(i.template_id) === Number(h.id)).map((i) => ({sortNo: Number(i.sort_no), kind: i.kind, phase: i.phase, title: i.title,
      role: i.role, checkers: i.checkers, startOffsetDays: Number(i.start_offset_days), endOffsetDays: Number(i.end_offset_days), milestoneCode: i.milestone_code,
      links: JSON.parse(i.links_json)}))}));
}

export async function addTemplate(db, orgId, {name, anchorKind, items}, {createdBy}) {
  const uid = Number((await db.get('SELECT COALESCE(MAX(template_uid),0)+1 AS n FROM produce_task_templates WHERE org_id=?', [orgId])).n);
  const head = '(SELECT t.id FROM produce_task_templates t WHERE t.org_id=? AND t.template_uid=? AND t.version_no=1)';
  await db.batch([
    {sql: 'INSERT INTO produce_task_templates(org_id,template_uid,version_no,name,anchor_kind,created_by) VALUES(?,?,1,?,?,?)', params: [orgId, uid, name, anchorKind, createdBy]},
    ...items.map((i) => ({sql: `INSERT INTO produce_task_template_items(org_id,template_id,sort_no,kind,phase,title,role,checkers,start_offset_days,end_offset_days,
      milestone_code,links_json) VALUES(?,${head},?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, orgId, uid, i.sortNo, i.kind, i.phase, i.title, i.role, i.checkers ?? null, i.startOffsetDays, i.endOffsetDays, i.milestoneCode ?? null,
      JSON.stringify(i.links ?? [])]})),
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'produce_task_template', String(uid), JSON.stringify({items: items.length})]},
  ]);
  return uid;
}
