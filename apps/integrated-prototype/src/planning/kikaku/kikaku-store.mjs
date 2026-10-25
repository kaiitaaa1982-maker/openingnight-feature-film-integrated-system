// 企画の DB の読み書き（移行 0025。会社ルートの plans/2026-10-22-folder-kikaku.md）。
// 版（企画の項目・試算）は版の行と子の行を1回の batch で書き、子の行は版の番号から版の ID を引く（版の ID を先に読まない）。
// 版の番号の取り合いは DB のトリガーが断る（受け口が 409 にする）。変更の記録 audit_log に1行残す（金額と本文は残さない）
import {registerSourceDocument} from '../../source-documents/source-documents-store.mjs';

const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const audit = (orgId, userId, action, entity, entityId, detail = {}) => ({sql: AUDIT_INSERT, params: [orgId, userId, action, entity, String(entityId), JSON.stringify(detail)]});

export async function readProject(db, orgId, projectId) {
  return db.get('SELECT id,code,title,status,project_type,earning_type,counterparty_name,planning_folder,created_at FROM projects WHERE org_id=? AND id=?', [orgId, projectId]);
}

export async function readProjectsByIds(db, orgId, ids) {
  if (!ids.length) return [];
  return db.all(`SELECT id,code,title,status,project_type,earning_type,counterparty_name,created_at FROM projects WHERE org_id=? AND id IN (${ids.map(() => '?').join(',')})
    ORDER BY id DESC`, [orgId, ...ids]);
}

// 一覧に要る、案件ごとの最新の段階・企画の項目の最新の版・試算の版・企画書・担当（ids は権限で絞った案件）
export async function readListRows(db, orgId, ids) {
  if (!ids.length) return {stages: [], profiles: [], trials: [], documents: [], owners: [], approvals: [], fixes: []};
  const marks = ids.map(() => '?').join(',');
  const p = [orgId, ...ids];
  const [stages, profiles, trials, documents, owners, approvals, fixes] = await Promise.all([
    db.all(`SELECT e.project_id,e.stage_code,e.entered_on,s.label FROM project_stage_events e JOIN project_stages s ON s.code=e.stage_code
      WHERE e.org_id=? AND e.project_id IN (${marks}) AND e.seq=(SELECT MAX(x.seq) FROM project_stage_events x WHERE x.org_id=e.org_id AND x.project_id=e.project_id)`, p),
    db.all(`SELECT v.project_id,v.revision,v.working_title,v.origin,v.episode_count,v.planned_release_year FROM planning_profile_versions v
      WHERE v.org_id=? AND v.project_id IN (${marks}) AND v.revision=(SELECT MAX(x.revision) FROM planning_profile_versions x WHERE x.org_id=v.org_id AND x.project_id=v.project_id)`, p),
    db.all(`SELECT id,project_id,revision,cost_total_yen,first_month,created_at FROM planning_trial_versions WHERE org_id=? AND project_id IN (${marks}) ORDER BY project_id,revision`, p),
    db.all(`SELECT project_id,kind,role,submitted_on FROM planning_documents WHERE org_id=? AND project_id IN (${marks})`, p),
    db.all(`SELECT o.project_id,o.user_id,o.started_on,o.revision,u.display_name FROM project_owner_versions o JOIN users u ON u.id=o.user_id
      WHERE o.org_id=? AND o.project_id IN (${marks}) ORDER BY o.project_id,o.revision`, p),
    db.all(`SELECT project_id,status,created_at FROM investment_approval_versions WHERE org_id=? AND project_id IN (${marks})`, p),
    db.all(`SELECT f.project_id,f.seq,f.action,v.version_no,f.created_at FROM budget_fixes f JOIN budget_versions v ON v.org_id=f.org_id AND v.id=f.version_id
      WHERE f.org_id=? AND f.project_id IN (${marks}) ORDER BY f.project_id,f.seq`, p),
  ]);
  return {stages, profiles, trials, documents, owners, approvals, fixes};
}

export async function readTrialParts(db, orgId, versionIds) {
  if (!versionIds.length) return {rates: [], lines: [], investments: []};
  const marks = versionIds.map(() => '?').join(',');
  const p = [orgId, ...versionIds];
  const [rates, lines, investments] = await Promise.all([
    db.all(`SELECT version_id,type_code,share_bps,fee_bps,original_royalty_bps,creator_royalty_bps,unit_cost_yen,source FROM planning_trial_rates WHERE org_id=? AND version_id IN (${marks}) ORDER BY version_id,id`, p),
    db.all(`SELECT version_id,line_no,type_code,partner_name,window_label,start_month,months,calc,unit_price_yen,even_value,good_value,max_value,source,previous_sales_yen
      FROM planning_trial_lines WHERE org_id=? AND version_id IN (${marks}) ORDER BY version_id,line_no`, p),
    db.all(`SELECT version_id,seq,month,amount_yen FROM planning_trial_investments WHERE org_id=? AND version_id IN (${marks}) ORDER BY version_id,seq`, p),
  ]);
  return {rates, lines, investments};
}

export async function readProjectDetailRows(db, orgId, projectId) {
  const p = [orgId, projectId];
  const [profiles, people, trials, documents, materials, facts, owners, stages, approvals, members] = await Promise.all([
    db.all('SELECT * FROM planning_profile_versions WHERE org_id=? AND project_id=? ORDER BY revision', p),
    db.all(`SELECT pp.version_id,pp.position,pp.role,pp.name,pp.status FROM planning_profile_people pp JOIN planning_profile_versions v ON v.org_id=pp.org_id AND v.id=pp.version_id
      WHERE pp.org_id=? AND v.project_id=? ORDER BY pp.version_id,pp.position`, p),
    db.all('SELECT id,revision,cost_total_yen,first_month,source_kind,document_id,reason,created_by,created_at FROM planning_trial_versions WHERE org_id=? AND project_id=? ORDER BY revision', p),
    db.all(`SELECT d.id,d.kind,d.role,d.submitted_to,d.submitted_on,d.note,d.created_at,s.id AS document_id,s.file_name,s.media_type,s.byte_length,s.sha256,s.storage,s.external_location
      FROM planning_documents d JOIN source_documents s ON s.org_id=d.org_id AND s.id=d.document_id WHERE d.org_id=? AND d.project_id=? ORDER BY d.id DESC`, p),
    db.all(`SELECT m.id,m.kind,m.title,m.label,m.source,m.url,m.document_id,m.acquired_on,m.created_at,s.file_name FROM planning_materials m
      LEFT JOIN source_documents s ON s.org_id=m.org_id AND s.id=m.document_id WHERE m.org_id=? AND m.project_id=? ORDER BY m.id`, p),
    db.all('SELECT id,material_id,body,value_int,label,target,pages,state,previous_id,created_at FROM planning_facts WHERE org_id=? AND project_id=? ORDER BY id', p),
    db.all(`SELECT o.revision,o.user_id,o.started_on,o.reason,u.display_name FROM project_owner_versions o JOIN users u ON u.id=o.user_id WHERE o.org_id=? AND o.project_id=? ORDER BY o.revision`, p),
    db.all(`SELECT e.seq,e.stage_code,e.entered_on,e.reason,s.label FROM project_stage_events e JOIN project_stages s ON s.code=e.stage_code WHERE e.org_id=? AND e.project_id=? ORDER BY e.seq`, p),
    db.all('SELECT approval_no,version_no,status,amount_yen,created_at FROM investment_approval_versions WHERE org_id=? AND project_id=? ORDER BY approval_no,version_no', p),
    db.all(`SELECT m.user_id,u.display_name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=? AND m.active=1 ORDER BY u.display_name`, [orgId]),
  ]);
  return {profiles, people, trials, documents, materials, facts, owners, stages, approvals, members};
}

export async function readStages(db) {
  return db.all('SELECT code,label,probability_bps,requires_reason,sort_order FROM project_stages ORDER BY sort_order');
}

// 案件を作る: 案件・所属（管理者以外）・担当の最初の版・企画の項目の最初の版（任意）を1回の batch で書く
export async function createKikakuProject(db, identity, project, {profile, today}) {
  const orgId = identity.org_id;
  const id = '(SELECT p.id FROM projects p WHERE p.org_id=? AND p.code=?)';
  const statements = [
    {sql: `INSERT INTO projects(org_id,code,title,project_type,earning_type,counterparty_name,planning_folder,note) VALUES(?,?,?,?,?,?,?,?) RETURNING id`,
      params: [orgId, project.code, project.title, project.projectType, project.earningType, project.counterpartyName, project.planningFolder, project.note]},
  ];
  if (identity.role !== 'admin') statements.push({sql: `INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(?,${id},?,'edit')`, params: [orgId, orgId, project.code, identity.user_id]});
  statements.push({sql: `INSERT INTO project_owner_versions(org_id,project_id,revision,user_id,started_on,reason,created_by) VALUES(?,${id},1,?,?,?,?)`,
    params: [orgId, orgId, project.code, identity.user_id, today, '案件を登録した人', identity.user_id]});
  if (project.stage) statements.push({sql: `INSERT INTO project_stage_events(org_id,project_id,seq,stage_code,previous_stage_code,entered_on,evidence,reason,created_by) VALUES(?,${id},1,?,NULL,?,?,?,?)`,
    params: [orgId, orgId, project.code, project.stage.code, project.stage.enteredOn, null, project.stage.reason ?? null, identity.user_id]});
  if (profile) statements.push(...profileStatements(orgId, id, [orgId, project.code], 1, profile, identity.user_id));
  statements.push(audit(orgId, identity.user_id, 'kikaku.project.create', 'projects', project.code, {code: project.code}));
  const out = await db.batch(statements);
  return Number(out[0].rows[0].id);
}

function profileStatements(orgId, projectRef, projectParams, revision, v, userId) {
  const version = `(SELECT x.id FROM planning_profile_versions x WHERE x.org_id=? AND x.project_id=${projectRef} AND x.revision=?)`;
  return [
    {sql: `INSERT INTO planning_profile_versions(org_id,project_id,revision,working_title,origin,logline,synopsis_short,synopsis_long,format,episode_count,planned_release_year,submit_to,reason,created_by)
      VALUES(?,${projectRef},?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [orgId, ...projectParams, revision, v.workingTitle, v.origin, v.logline, v.synopsisShort, v.synopsisLong, v.format, v.episodeCount, v.plannedReleaseYear, v.submitTo, v.reason, userId]},
    ...v.people.map((p) => ({sql: `INSERT INTO planning_profile_people(org_id,version_id,position,role,name,status) VALUES(?,${version},?,?,?,?)`,
      params: [orgId, orgId, ...projectParams, revision, p.position, p.role, p.name, p.status]})),
  ];
}

export async function addProfileVersion(db, identity, projectId, revision, v) {
  const orgId = identity.org_id;
  await db.batch([...profileStatements(orgId, '?', [projectId], revision, v, identity.user_id),
    audit(orgId, identity.user_id, 'kikaku.profile.add', 'planning_profile_versions', projectId, {revision})]);
}

export async function addTrialVersion(db, identity, projectId, revision, v, {sourceKind, documentId = null}) {
  const orgId = identity.org_id;
  const version = '(SELECT x.id FROM planning_trial_versions x WHERE x.org_id=? AND x.project_id=? AND x.revision=?)';
  const ref = [orgId, projectId, revision];
  const statements = [
    {sql: 'INSERT INTO planning_trial_versions(org_id,project_id,revision,cost_total_yen,first_month,source_kind,document_id,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
      params: [orgId, projectId, revision, v.costTotalYen, v.firstMonth, sourceKind, documentId, v.reason, identity.user_id]},
    ...v.rates.map((r) => ({sql: `INSERT INTO planning_trial_rates(org_id,version_id,type_code,share_bps,fee_bps,original_royalty_bps,creator_royalty_bps,unit_cost_yen,source) VALUES(?,${version},?,?,?,?,?,?,?)`,
      params: [orgId, ...ref, r.typeCode, r.shareBps, r.feeBps, r.originalBps, r.creatorBps, r.unitCostYen, r.source]})),
    ...v.lines.map((l) => ({sql: `INSERT INTO planning_trial_lines(org_id,version_id,line_no,type_code,partner_name,window_label,start_month,months,calc,unit_price_yen,even_value,good_value,max_value,source,previous_sales_yen)
      VALUES(?,${version},?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [orgId, ...ref, l.lineNo, l.typeCode, l.partnerName, l.windowLabel, l.startMonth, l.months, l.calc, l.unitPriceYen, l.evenValue, l.goodValue, l.maxValue, l.source, l.previousSalesYen]})),
    ...v.investments.map((i) => ({sql: `INSERT INTO planning_trial_investments(org_id,version_id,seq,month,amount_yen) VALUES(?,${version},?,?,?)`, params: [orgId, ...ref, i.seq, i.month, i.amountYen]})),
    audit(orgId, identity.user_id, 'kikaku.trial.add', 'planning_trial_versions', projectId, {revision, lines: v.lines.length}),
  ];
  await db.batch(statements);
}

// 原本を共通の原本の表（source_documents。移行 0025）に置く。同じ中身はいまの行を使う。返り値は {documentId, existed}
const SOURCE_KIND = {deck: 'planning_deck', trial: 'other', material: 'other'};
export async function putSourceDocument(db, identity, {kind, fileName, mediaType, bytes, receivedOn}) {
  const out = await registerSourceDocument(db, {orgId: identity.org_id, userId: identity.user_id, kind: SOURCE_KIND[kind] ?? 'other', fileName, mediaType, receivedOn, bytes});
  return {documentId: out.id, existed: out.duplicate};
}

export async function linkPlanningDocument(db, identity, projectId, {documentId, kind, role, submittedTo, submittedOn, note}) {
  const orgId = identity.org_id;
  const out = await db.batch([
    {sql: 'INSERT INTO planning_documents(org_id,project_id,document_id,kind,role,submitted_to,submitted_on,note,created_by) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
      params: [orgId, projectId, documentId, kind, role, submittedTo, submittedOn, note, identity.user_id]},
    audit(orgId, identity.user_id, 'kikaku.document.link', 'planning_documents', projectId, {kind, role}),
  ]);
  return Number(out[0].rows[0].id);
}

export async function readDocumentForProject(db, orgId, projectId, documentId) {
  return db.get(`SELECT s.id FROM source_documents s WHERE s.org_id=? AND s.id=?
    AND (EXISTS(SELECT 1 FROM planning_documents d WHERE d.org_id=s.org_id AND d.document_id=s.id AND d.project_id=?)
      OR EXISTS(SELECT 1 FROM planning_materials m WHERE m.org_id=s.org_id AND m.document_id=s.id AND m.project_id=?))`, [orgId, documentId, projectId, projectId]);
}

export async function addOwnerVersion(db, identity, projectId, revision, {userId, startedOn, reason}) {
  const orgId = identity.org_id;
  await db.batch([
    {sql: 'INSERT INTO project_owner_versions(org_id,project_id,revision,user_id,started_on,reason,created_by) VALUES(?,?,?,?,?,?,?)', params: [orgId, projectId, revision, userId, startedOn, reason, identity.user_id]},
    audit(orgId, identity.user_id, 'kikaku.owner.add', 'project_owner_versions', projectId, {revision}),
  ]);
}

export async function addMaterial(db, identity, projectId, v, documentId) {
  const orgId = identity.org_id;
  const out = await db.batch([
    {sql: 'INSERT INTO planning_materials(org_id,project_id,kind,title,label,source,url,document_id,acquired_on,created_by) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id',
      params: [orgId, projectId, v.kind, v.title, v.label, v.source, v.url, documentId, v.acquiredOn, identity.user_id]},
    audit(orgId, identity.user_id, 'kikaku.material.add', 'planning_materials', projectId, {kind: v.kind}),
  ]);
  return Number(out[0].rows[0].id);
}

export async function addFact(db, identity, projectId, v, {state, previousId = null}) {
  const orgId = identity.org_id;
  const out = await db.batch([
    {sql: 'INSERT INTO planning_facts(org_id,project_id,material_id,body,value_int,label,target,pages,state,previous_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
      params: [orgId, projectId, v.materialId, v.body, v.valueInt, v.label, v.target, v.pages, state, previousId, identity.user_id]},
    audit(orgId, identity.user_id, `kikaku.fact.${state === 'human_confirmed' ? 'confirm' : 'draft'}`, 'planning_facts', projectId, {}),
  ]);
  return Number(out[0].rows[0].id);
}

export async function hasPlanningDocument(db, orgId, projectId, {documentId, kind, role}) {
  return Boolean(await db.get("SELECT 1 FROM planning_documents WHERE org_id=? AND project_id=? AND document_id=? AND kind=? AND COALESCE(role,'')=?",
    [orgId, projectId, documentId, kind, role ?? '']));
}

export async function isActiveMember(db, orgId, userId) {
  return Boolean(await db.get('SELECT 1 FROM memberships WHERE org_id=? AND user_id=? AND active=1', [orgId, userId]));
}

export async function readFact(db, orgId, projectId, factId) {
  return db.get('SELECT id,material_id,body,value_int,label,target,pages,state FROM planning_facts WHERE org_id=? AND project_id=? AND id=?', [orgId, projectId, factId]);
}
