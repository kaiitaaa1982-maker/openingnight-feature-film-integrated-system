// 企画（planning）の領域の DB の読み書き。いまは案件の型・稼ぎ方・段階と確度・基準額・売上率と、その参照表・区分マスタ（移行 0012。
// フェーズ1の仕様書 #10）と、受託制作の契約の版（移行 0013）、稟議の版（移行 0019。行動指標の計画 段B #4）を置く。入力の判定は model（project/project-model.mjs）が先に済ませ、ここは SQL と組織（org_id）の絞り込みだけを持つ。
// 案件（projects）はまだ領域フォルダへ移していない古い形の表なので、ここから直接読み書きする（docs/rules/architecture.md の「ほかの領域の表」）。
// 参照表（稼ぎ方・ステップ・段階）は組織に依らない表で、コードの正本。組織ごとの表（既定の売上率の版・区分・段階の履歴）は必ず org_id で絞る。
// 施策の受け口（フェーズ1 #12a）は、文を返す関数（*Statements・*Statement）を、ほかの store の文と1回の batch にまとめて書く
import {allIn, IN_CHUNK} from '../sql-in.mjs';

// 既存の案件の API（bootstrap・/api/projects）が返す列。移行 0012 で足した列（型・稼ぎ方・基準額・売上率・相手など）は返さず、
// この store の読み取り（財務の権限を受け口が確かめたあと）でだけ読む
export const PROJECT_BASE_COLUMNS = Object.freeze(['id', 'org_id', 'code', 'title', 'status', 'budget_yen', 'version', 'created_at']);

// ---------- 参照表（組織に依らない） ----------

export async function listEarningTypes(db) {
  return db.all('SELECT code,label,project_type,profit_source,base_amount_kind,rate_source,sort_order FROM earning_types ORDER BY sort_order,code');
}

export async function listProjectStages(db) {
  return db.all('SELECT code,label,yomi,probability_bps,definition,step_code,requires_reason,sort_order FROM project_stages ORDER BY sort_order,code');
}

export async function listStageMeanings(db) {
  return db.all('SELECT m.stage_code,m.earning_type,m.meaning FROM project_stage_meanings m JOIN project_stages s ON s.code=m.stage_code JOIN earning_types e ON e.code=m.earning_type ORDER BY s.sort_order,e.sort_order');
}

// 段階の稼ぎ方ごとの意味を1行足す（種で足す形）
export async function addStageMeaning(db, {stageCode, earningType, meaning}) {
  await db.run('INSERT INTO project_stage_meanings(stage_code,earning_type,meaning) VALUES(?,?,?)', [stageCode, earningType, meaning]);
}

// 行動のステップ。親の無い行（面談・提案・契約）が先、細目は親の次に並ぶ
export async function listActionSteps(db) {
  return db.all(`SELECT s.code,s.label,s.parent_code,s.sort_order FROM action_steps s LEFT JOIN action_steps p ON p.code=s.parent_code
    ORDER BY COALESCE(p.sort_order,s.sort_order),CASE WHEN s.parent_code IS NULL THEN 0 ELSE 1 END,s.sort_order,s.code`);
}

// 細目のステップを1行足す（親は親の無い行だけ。DB の action_steps_two_levels が断る）。行動指標の計画 #10 が種で使う
export async function addActionStep(db, {code, label, parentCode, sortOrder}) {
  await db.run('INSERT INTO action_steps(code,label,parent_code,sort_order) VALUES(?,?,?,?)', [code, label, parentCode, sortOrder]);
}

// ---------- 案件 ----------

const PROJECT_INSERT = `INSERT INTO projects(org_id,code,title,project_type,earning_type,base_amount_yen,revenue_rate_bps,counterparty_name,key_person,started_on,planning_folder,note)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`;
const STAGE_INSERT = `INSERT INTO project_stage_events(org_id,project_id,seq,stage_code,previous_stage_code,entered_on,evidence,reason,created_by)
  VALUES(?,?,(SELECT COALESCE(MAX(e.seq),0)+1 FROM project_stage_events e WHERE e.org_id=? AND e.project_id=?),?,?,?,?,?,?) RETURNING seq`;

// 案件を作る文（作品は作らない）。最初の段階があれば、同じ batch で段階の履歴の1行目を足す（案件の ID は案件コードで引く）。
// project は normalizeProjectInput の value。案件への所属（project_memberships）は受け口が identity から足す
export function createProjectStatements(orgId, project, {createdBy}) {
  const statements = [{sql: PROJECT_INSERT, params: [orgId, project.code, project.title, project.projectType, project.earningType, project.baseAmountYen, project.revenueRateBps,
    project.counterpartyName, project.keyPerson, project.startedOn, project.planningFolder, project.note]}];
  if (project.stage) {
    const projectId = '(SELECT p.id FROM projects p WHERE p.org_id=? AND p.code=?)';
    statements.push({sql: `INSERT INTO project_stage_events(org_id,project_id,seq,stage_code,previous_stage_code,entered_on,evidence,reason,created_by)
      VALUES(?,${projectId},1,?,NULL,?,?,?,?)`, params: [orgId, orgId, project.code, project.stage.code, project.stage.enteredOn, project.stage.evidence, project.stage.reason, createdBy]});
  }
  return statements;
}

export async function createProject(db, orgId, project, {createdBy}) {
  const out = await db.batch(createProjectStatements(orgId, project, {createdBy}));
  return Number(out[0].rows[0].id);
}

// 段階の変更（段階の履歴に1行足す）の文。連番は DB の最新の行の次。前の段階が最新の行の段階と違えば DB が断る
export function stageChangeStatement(orgId, {projectId, stageCode, previousStageCode, enteredOn, evidence, reason, createdBy}) {
  return {sql: STAGE_INSERT, params: [orgId, projectId, orgId, projectId, stageCode, previousStageCode, enteredOn, evidence, reason, createdBy]};
}

export async function recordStageChange(db, orgId, change) {
  const statement = stageChangeStatement(orgId, change);
  const row = await db.get(statement.sql, statement.params);
  return {seq: Number(row.seq)};
}

// 案件の型・稼ぎ方・基準額・売上率と、いまの段階（段階の履歴の最新の行）・確度（段階から）・基準額の中身と使う率の出どころ（稼ぎ方から）。
// projectIds は受け口が権限で絞った案件の ID（組織の外の ID は org_id で落ちる）。段階の無い案件の段階・確度は NULL
export async function readProjectClassifications(db, orgId, projectIds) {
  return allIn(db, `SELECT p.id,p.code,p.title,p.status,p.project_type,p.earning_type,p.base_amount_yen,p.revenue_rate_bps,p.counterparty_name,p.key_person,
      p.started_on,p.planning_folder,p.note,e.base_amount_kind,e.rate_source,e.profit_source,
      ev.seq AS stage_seq,ev.stage_code,ev.entered_on AS stage_entered_on,s.probability_bps
    FROM projects p
    LEFT JOIN earning_types e ON e.code=p.earning_type
    LEFT JOIN project_stage_events ev ON ev.org_id=p.org_id AND ev.project_id=p.id
      AND ev.seq=(SELECT MAX(x.seq) FROM project_stage_events x WHERE x.org_id=p.org_id AND x.project_id=p.id)
    LEFT JOIN project_stages s ON s.code=ev.stage_code
    WHERE p.org_id=? AND p.id IN (:in)`, {before: [orgId], ids: projectIds, sortBy: (a, b) => Number(a.id) - Number(b.id)});
}

// 案件の段階の履歴（連番の順）
export async function readStageHistory(db, orgId, projectId) {
  return db.all(`SELECT seq,stage_code,previous_stage_code,entered_on,evidence,reason,created_by,created_at FROM project_stage_events
    WHERE org_id=? AND project_id=? ORDER BY seq`, [orgId, projectId]);
}

// ---------- 組織ごとの前提 ----------

// 稼ぎ方の既定の売上率の版を1つ足し、足した版の番号を返す（版の番号は DB の最新の次。追記だけ）
export async function addRevenueRateVersion(db, orgId, {earningType, revenueRateBps, status, basis, createdBy}) {
  const row = await db.get(`INSERT INTO earning_type_rate_versions(org_id,earning_type,version_no,revenue_rate_bps,status,basis,created_by)
    VALUES(?,?,(SELECT COALESCE(MAX(v.version_no),0)+1 FROM earning_type_rate_versions v WHERE v.org_id=? AND v.earning_type=?),?,?,?,?) RETURNING version_no`,
  [orgId, earningType, orgId, earningType, revenueRateBps, status, basis, createdBy]);
  return Number(row.version_no);
}

// 稼ぎ方ごとの、いま有効な既定の売上率（最新の版）。版の無い稼ぎ方は行が無い
export async function readEffectiveRevenueRates(db, orgId) {
  return db.all(`SELECT v.earning_type,v.version_no,v.revenue_rate_bps,v.status,v.basis FROM earning_type_rate_versions v JOIN earning_types e ON e.code=v.earning_type
    WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM earning_type_rate_versions x WHERE x.org_id=v.org_id AND x.earning_type=v.earning_type)
    ORDER BY e.sort_order`, [orgId]);
}

// 区分マスタ（入金・出金と売上の元か）
export async function listCashflowCategories(db, orgId) {
  return db.all('SELECT id,code,label,direction,counts_as_revenue,sort_order FROM cashflow_categories WHERE org_id=? ORDER BY sort_order,id', [orgId]);
}

export async function addCashflowCategory(db, orgId, {code, label, direction, countsAsRevenue, sortOrder}) {
  const row = await db.get('INSERT INTO cashflow_categories(org_id,code,label,direction,counts_as_revenue,sort_order) VALUES(?,?,?,?,?,?) RETURNING id',
    [orgId, code, label, direction, countsAsRevenue, sortOrder]);
  return Number(row.id);
}

// ---------- 受託制作の契約の版（移行 0013。フェーズ1 #10b） ----------

const CONTRACT_VERSION_INSERT = `INSERT INTO contract_production_versions(org_id,project_id,version_no,budget_yen,markup_bps,fee_yen,milestone_count,contract_reference,note,created_by)
  VALUES(?,?,?,?,?,?,?,?,?,?)`;
const CONTRACT_MILESTONE_INSERT = 'INSERT INTO contract_production_milestones(org_id,project_id,version_no,seq,due_on,share_bps) VALUES(?,?,?,?,?,?)';
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';

// 契約の版を1つ足す文（版の行と節目の行と変更の記録 audit_log の1行。1回の batch で書く）。version は normalizeContractVersionInput の value で、
// 版の番号は画面が見ていた版の次（ほかの画面が先に足していれば DB の contract_production_versions_sequence が断り、記録の行も入らない）。
// 記録の detail_json は案件の ID・版の番号・節目の数だけにし、総製作費・受託費率・受託費は入れない（docs/rules/logging.md「契約の金額を残さない」）
export function contractVersionStatements(orgId, projectId, version, {createdBy}) {
  const versionNo = version.previousVersionNo + 1;
  return [
    {sql: CONTRACT_VERSION_INSERT, params: [orgId, projectId, versionNo, version.budgetYen, version.markupBps, version.feeYen, version.milestones.length,
      version.contractReference, version.note, createdBy]},
    ...version.milestones.map((m) => ({sql: CONTRACT_MILESTONE_INSERT, params: [orgId, projectId, versionNo, m.seq, m.dueOn, m.shareBps]})),
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'contract_production_version', `${projectId}:${versionNo}`,
      JSON.stringify({projectId, versionNo, milestoneCount: version.milestones.length})]},
  ];
}

export async function addContractVersion(db, orgId, projectId, version, {createdBy}) {
  await db.batch(contractVersionStatements(orgId, projectId, version, {createdBy}));
  return version.previousVersionNo + 1;
}

// 案件の契約の版の全部（版の番号の順）と節目の行（版・連番の順）
export async function readContractVersions(db, orgId, projectId) {
  const [versions, milestones] = await Promise.all([
    db.all(`SELECT version_no,budget_yen,markup_bps,fee_yen,milestone_count,contract_reference,note,created_by,created_at FROM contract_production_versions
      WHERE org_id=? AND project_id=? ORDER BY version_no`, [orgId, projectId]),
    db.all('SELECT version_no,seq,due_on,share_bps FROM contract_production_milestones WHERE org_id=? AND project_id=? ORDER BY version_no,seq', [orgId, projectId]),
  ]);
  return {versions, milestones};
}

// 案件ごとの最新の契約の版と、節目の行の数・割合の和（揃っているかは contract-production-model の contractVersionComplete で見る）。
// 版の無い案件は行が無い
export async function readLatestContractVersions(db, orgId, projectIds) {
  return allIn(db, `SELECT v.project_id,v.version_no,v.budget_yen,v.markup_bps,v.fee_yen,v.milestone_count,
      (SELECT COUNT(*) FROM contract_production_milestones m WHERE m.org_id=v.org_id AND m.project_id=v.project_id AND m.version_no=v.version_no) AS recorded_milestones,
      (SELECT COALESCE(SUM(m.share_bps),0) FROM contract_production_milestones m WHERE m.org_id=v.org_id AND m.project_id=v.project_id AND m.version_no=v.version_no) AS share_total_bps
    FROM contract_production_versions v
    WHERE v.org_id=? AND v.project_id IN (:in)
      AND v.version_no=(SELECT MAX(x.version_no) FROM contract_production_versions x WHERE x.org_id=v.org_id AND x.project_id=v.project_id)`,
  {before: [orgId], ids: projectIds, sortBy: (a, b) => Number(a.project_id) - Number(b.project_id)});
}

// 源泉1 制作受託の材料（行動指標の計画 段B #3。導き方は src/accounting/profit/contract-work-source-model.mjs）。projectIds は受け口が財務の
// 権限で絞った案件の ID。型「受託制作」の案件を、稼ぎ方と参照表の利益の源泉（源泉は稼ぎ方から導き、手で選ばない）と最新の契約の版と一緒に返し
// （版の無い案件も行を返し、版の列は NULL）、最新の版の節目の行（版の番号つき）を返す。案件の行と節目の行は読み取りの一括（db.readBatch）で
// 同じ時点から読む（間に版が足されても、古い版の総製作費・受託費に新しい版の節目の割合を組み合わせない。docs/rules/dialect.md）。
// 一括は80件ごとに1回（D1 の値の上限。sql-in.mjs の IN_CHUNK）で、案件の行とその案件の節目の行は必ず同じ一括に入る
export async function readContractWorkSourceRows(db, orgId, projectIds) {
  const ids = [...new Set(projectIds)];
  const projects = [];
  const milestones = [];
  for (let start = 0; start < ids.length; start += IN_CHUNK) {
    const part = ids.slice(start, start + IN_CHUNK);
    const marks = part.map(() => '?').join(',');
    const [projectRows, milestoneRows] = await db.readBatch([
      {sql: `SELECT p.id AS project_id,p.code,p.title,p.earning_type,e.profit_source,v.version_no,v.budget_yen,v.markup_bps,v.fee_yen,v.milestone_count
        FROM projects p LEFT JOIN earning_types e ON e.code=p.earning_type
        LEFT JOIN contract_production_versions v ON v.org_id=p.org_id AND v.project_id=p.id
          AND v.version_no=(SELECT MAX(x.version_no) FROM contract_production_versions x WHERE x.org_id=p.org_id AND x.project_id=p.id)
        WHERE p.org_id=? AND p.project_type='contract_production' AND p.id IN (${marks})`, params: [orgId, ...part]},
      {sql: `SELECT m.project_id,m.version_no,m.seq,m.due_on,m.share_bps FROM contract_production_milestones m
        WHERE m.org_id=? AND m.project_id IN (${marks})
          AND m.version_no=(SELECT MAX(x.version_no) FROM contract_production_versions x WHERE x.org_id=m.org_id AND x.project_id=m.project_id)`, params: [orgId, ...part]},
    ]);
    projects.push(...projectRows);
    milestones.push(...milestoneRows);
  }
  const byProject = (a, b) => Number(a.project_id) - Number(b.project_id);
  return {projects: projects.sort(byProject), milestones: milestones.sort((a, b) => byProject(a, b) || Number(a.seq) - Number(b.seq))};
}

// ---------- 稟議の版（移行 0019。行動指標の計画 段B #4。K2-17） ----------
// 版の流れ・額・番号は DB のトリガーが断り、受け口は先に investment-approval-model.mjs で確かめて分かる言葉で返す。
// 記録の detail_json は案件・稟議・版の番号と版の種類だけにし、額は入れない（docs/rules/logging.md「契約の金額を残さない」）

const APPROVAL_VERSION_INSERT = `INSERT INTO investment_approval_versions(org_id,project_id,approval_no,version_no,status,amount_yen,basis_reference,paid_on,note,created_by)
  VALUES(?,?,?,?,?,?,?,?,?,?)`;
const APPROVAL_VERSION_COLUMNS = 'v.project_id,v.approval_no,v.version_no,v.status,v.amount_yen,v.basis_reference,v.paid_on,v.note,v.created_by,v.created_at';

// 稟議の版を1つ足す文（版の行と変更の記録 audit_log の1行。1回の batch で書く）。version は investment-approval-model の
// normalizeNewApproval・normalizeApprovalStep の value（稟議の番号・版の番号は画面が見ていた最新の次。ほかの画面が先に足していれば
// DB の investment_approval_versions_sequence か主キーが断り、記録の行も入らない）
export function investmentApprovalVersionStatements(orgId, projectId, version, {createdBy}) {
  return [
    {sql: APPROVAL_VERSION_INSERT, params: [orgId, projectId, version.approvalNo, version.versionNo, version.status, version.amountYen,
      version.basisReference, version.paidOn, version.note, createdBy]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'investment_approval_version', `${projectId}:${version.approvalNo}:${version.versionNo}`,
      JSON.stringify({projectId, approvalNo: version.approvalNo, versionNo: version.versionNo, status: version.status})]},
  ];
}

export async function addInvestmentApprovalVersion(db, orgId, projectId, version, {createdBy}) {
  await db.batch(investmentApprovalVersionStatements(orgId, projectId, version, {createdBy}));
  return {approvalNo: version.approvalNo, versionNo: version.versionNo};
}

// 1つの案件の稟議の版の全部（稟議の番号・版の番号の順）。版を足す前に、いまの状態を読むのに使う
export async function readProjectInvestmentApprovals(db, orgId, projectId) {
  return db.all(`SELECT ${APPROVAL_VERSION_COLUMNS} FROM investment_approval_versions v WHERE v.org_id=? AND v.project_id=?
    ORDER BY v.approval_no,v.version_no`, [orgId, projectId]);
}

// 見てよい案件（scope は受け口が渡す財務の権限の副問い合わせ）のうち、稼ぎ方が自社出資の案件と稟議の版のある案件（稼ぎ方をあとから変えた
// 案件の稟議を一覧から落とさない）と、その稟議の版の全部を、読み取りの一括（同じ時点）で読む
export async function readInvestmentApprovals(db, orgId, {scope}) {
  const [projects, versions] = await db.readBatch([
    {sql: `SELECT p.id,p.code,p.title,p.earning_type FROM projects p
      WHERE p.org_id=? AND p.id IN (${scope.sql})
        AND (p.earning_type='own_investment' OR EXISTS(SELECT 1 FROM investment_approval_versions x WHERE x.org_id=p.org_id AND x.project_id=p.id))
      ORDER BY p.id`, params: [orgId, ...scope.params]},
    investmentApprovalVersionsStatement(orgId, scope),
  ]);
  return {projects, versions};
}

// 見てよい案件（scope）の稟議の版の全部（案件・稟議の番号・版の番号の順）を読む文。readInvestmentApprovals と、
// 源泉別の利益額（accounting-store の readSourceProfitSources。行動指標の計画 段B #2）の読み取りの一括が使う
export function investmentApprovalVersionsStatement(orgId, scope) {
  return {sql: `SELECT ${APPROVAL_VERSION_COLUMNS} FROM investment_approval_versions v WHERE v.org_id=? AND v.project_id IN (${scope.sql})
      ORDER BY v.project_id,v.approval_no,v.version_no`, params: [orgId, ...scope.params]};
}

// 見てよい案件（scope）の受託制作の最新の契約の版の節目の行（案件・連番の順。版の番号つき）を読む文。源泉別の利益額
// （accounting-store の readSourceProfitSources。行動指標の計画 段B #2）が、案件の行（projectRevenueBasesStatement の最新の契約の版の列）と
// 同じ読み取りの一括（同じ時点）に入れる。案件 ID を値として並べないので、案件の数によらず1文（readContractWorkSourceRows は80件ごとに1回）
export function contractMilestonesStatement(orgId, scope) {
  return {sql: `SELECT m.project_id,m.version_no,m.seq,m.due_on,m.share_bps FROM contract_production_milestones m
    WHERE m.org_id=? AND m.project_id IN (${scope.sql})
      AND m.version_no=(SELECT MAX(x.version_no) FROM contract_production_versions x WHERE x.org_id=m.org_id AND x.project_id=m.project_id)
    ORDER BY m.project_id,m.seq`, params: [orgId, ...scope.params]};
}

// 会社への利益額（accounting-store の readProfitSources）に入れる、稟議の払込の版の SELECT（ORDER BY を持たない。製作委員会への自社の払込と
// UNION ALL で1つの文にする。列は source・id・paid_on・amount_yen・reverses_id・project_id・work_id・approval_no・version_no の順）。
// months（{from, to}）を渡すと払った日の月がその間に入る版だけ
export function ownInvestmentPaymentsSelect(orgId, scope, months = null) {
  return {sql: `SELECT 'own_investment' AS source,NULL AS id,v.paid_on,v.amount_yen,NULL AS reverses_id,v.project_id,NULL AS work_id,v.approval_no,v.version_no
    FROM investment_approval_versions v
    WHERE v.org_id=? AND v.status='paid' AND v.project_id IN (${scope.sql})${months ? `
      AND substr(v.paid_on,1,7) BETWEEN ? AND ?` : ''}`, params: [orgId, ...scope.params, ...(months ? [months.from, months.to] : [])]};
}

// 見てよい案件のうち、稼ぎ方が自社出資で稟議の払込の版が1つも無い案件の数を返す副問い合わせ（利益額の注記「出資額を引いていない案件」。
// 期間によらず数える）
export function ownInvestmentUnpaidCountSubquery(orgId, scope) {
  return {sql: `(SELECT COUNT(*) FROM projects ox WHERE ox.org_id=? AND ox.earning_type='own_investment' AND ox.id IN (${scope.sql})
      AND NOT EXISTS(SELECT 1 FROM investment_approval_versions ov WHERE ov.org_id=ox.org_id AND ov.project_id=ox.id AND ov.status='paid'))`,
  params: [orgId, ...scope.params]};
}

// 買付の契約の形を見分ける材料（案件ごと）: MG の分配契約の数と、作品の費用の最新の版に買付額のある作品の数。
// 分配契約（settlement_contracts）・作品（works）・作品の費用の版（work_finance_versions）は、まだ領域フォルダへ移していない古い形の表なので直接読む
export async function readAcquisitionEvidence(db, orgId, projectIds) {
  return allIn(db, `SELECT p.id AS project_id,
      (SELECT COUNT(*) FROM settlement_contracts s WHERE s.org_id=p.org_id AND s.project_id=p.id AND s.contract_type='mg') AS mg_contracts,
      (SELECT COUNT(*) FROM works w JOIN work_finance_versions f ON f.org_id=w.org_id AND f.work_id=w.id
        AND f.revision=(SELECT MAX(x.revision) FROM work_finance_versions x WHERE x.org_id=w.org_id AND x.work_id=w.id)
        WHERE w.org_id=p.org_id AND w.project_id=p.id AND f.sales_rights_purchase_yen IS NOT NULL) AS purchase_works
    FROM projects p WHERE p.org_id=? AND p.id IN (:in)`,
  {before: [orgId], ids: projectIds, sortBy: (a, b) => Number(a.project_id) - Number(b.project_id)});
}

// 売上の4区分を導くのに読むもの（revenue-class-model の revenueClassBases に渡す形）。projectIds は受け口が財務の権限で絞った案件の ID
export async function readRevenueClassInputs(db, orgId, projectIds) {
  const [projects, earningTypes, defaultRates, contractVersions, acquisitionEvidence] = await Promise.all([
    readProjectClassifications(db, orgId, projectIds), listEarningTypes(db), readEffectiveRevenueRates(db, orgId),
    readLatestContractVersions(db, orgId, projectIds), readAcquisitionEvidence(db, orgId, projectIds),
  ]);
  return {projects, earningTypes, defaultRates, contractVersions, acquisitionEvidence};
}

// ---------- 予実の4段の読み取りの一括に入れる文（フェーズ1 #14。SQL の数を10本以内にするため、上の読み取りを2つの文にまとめる） ----------
// 文を返すだけで、流すのは src/revenue/revenue-store.mjs の readYojitsuSources（1回の readBatch）。scope は受け口が渡す「見てよい案件」の
// 副問い合わせ（src/app.mjs の permittedProjectScope の {sql, params}。案件 ID を値として並べないので D1 の値の上限に掛からない）

// 稼ぎ方の参照表と、組織の既定の売上率の最新の版（listEarningTypes と readEffectiveRevenueRates を1つにした形。版の無い稼ぎ方の列は NULL）
export function earningTypesWithDefaultRatesStatement(orgId) {
  return {sql: `SELECT e.code,e.label,e.project_type,e.profit_source,e.base_amount_kind,e.rate_source,e.sort_order,
      v.version_no AS default_rate_version_no,v.revenue_rate_bps AS default_rate_bps,v.status AS default_rate_status,v.basis AS default_rate_basis
    FROM earning_types e LEFT JOIN earning_type_rate_versions v ON v.org_id=? AND v.earning_type=e.code
      AND v.version_no=(SELECT MAX(x.version_no) FROM earning_type_rate_versions x WHERE x.org_id=v.org_id AND x.earning_type=v.earning_type)
    ORDER BY e.sort_order,e.code`, params: [orgId]};
}

// 見てよい案件の、型・稼ぎ方・いまの段階と確度・売上率の材料（readProjectClassifications・readLatestContractVersions・readAcquisitionEvidence を
// 1つにした形。受託制作の契約の最新の版と節目のそろい、MG の分配契約の数、作品の費用の最新の版に買付額のある作品の数）と、案件の作品の数
// （会社への利益額が作品の無い案件の売上を「未確定」に分ける。フェーズ1 #14b）。並びは案件の ID
export function projectRevenueBasesStatement(orgId, scope) {
  return {sql: `SELECT p.id,p.code,p.title,p.status,p.project_type,p.earning_type,p.base_amount_yen,p.revenue_rate_bps,
      e.base_amount_kind,e.rate_source,e.profit_source,ev.seq AS stage_seq,ev.stage_code,ev.entered_on AS stage_entered_on,s.probability_bps,
      cv.version_no AS contract_version_no,cv.budget_yen AS contract_budget_yen,cv.markup_bps AS contract_markup_bps,cv.fee_yen AS contract_fee_yen,
      cv.milestone_count AS contract_milestone_count,
      (SELECT COUNT(*) FROM contract_production_milestones m WHERE m.org_id=cv.org_id AND m.project_id=cv.project_id AND m.version_no=cv.version_no) AS contract_recorded_milestones,
      (SELECT COALESCE(SUM(m.share_bps),0) FROM contract_production_milestones m WHERE m.org_id=cv.org_id AND m.project_id=cv.project_id AND m.version_no=cv.version_no) AS contract_share_total_bps,
      (SELECT COUNT(*) FROM settlement_contracts sc WHERE sc.org_id=p.org_id AND sc.project_id=p.id AND sc.contract_type='mg') AS mg_contracts,
      (SELECT COUNT(*) FROM works w JOIN work_finance_versions f ON f.org_id=w.org_id AND f.work_id=w.id
        AND f.revision=(SELECT MAX(x.revision) FROM work_finance_versions x WHERE x.org_id=w.org_id AND x.work_id=w.id)
        WHERE w.org_id=p.org_id AND w.project_id=p.id AND f.sales_rights_purchase_yen IS NOT NULL) AS purchase_works,
      (SELECT COUNT(*) FROM works wc WHERE wc.org_id=p.org_id AND wc.project_id=p.id) AS work_count
    FROM projects p
    LEFT JOIN earning_types e ON e.code=p.earning_type
    LEFT JOIN project_stage_events ev ON ev.org_id=p.org_id AND ev.project_id=p.id
      AND ev.seq=(SELECT MAX(x.seq) FROM project_stage_events x WHERE x.org_id=p.org_id AND x.project_id=p.id)
    LEFT JOIN project_stages s ON s.code=ev.stage_code
    LEFT JOIN contract_production_versions cv ON cv.org_id=p.org_id AND cv.project_id=p.id
      AND cv.version_no=(SELECT MAX(x.version_no) FROM contract_production_versions x WHERE x.org_id=p.org_id AND x.project_id=p.id)
    WHERE p.org_id=? AND p.id IN (${scope.sql})
    ORDER BY p.id`, params: [orgId, ...scope.params]};
}

// 上の2つの文の行を、readRevenueClassInputs と同じ形（revenue-class-model の revenueClassBases に渡す形）にそろえる
export function revenueClassInputsFromRows({earningTypeRows, projectRows}) {
  return {
    projects: projectRows,
    earningTypes: earningTypeRows.map((e) => ({code: e.code, label: e.label, project_type: e.project_type, profit_source: e.profit_source,
      base_amount_kind: e.base_amount_kind, rate_source: e.rate_source, sort_order: e.sort_order})),
    defaultRates: earningTypeRows.filter((e) => e.default_rate_version_no !== null && e.default_rate_version_no !== undefined)
      .map((e) => ({earning_type: e.code, version_no: e.default_rate_version_no, revenue_rate_bps: e.default_rate_bps, status: e.default_rate_status, basis: e.default_rate_basis})),
    contractVersions: projectRows.filter((p) => p.contract_version_no !== null && p.contract_version_no !== undefined)
      .map((p) => ({project_id: p.id, version_no: p.contract_version_no, budget_yen: p.contract_budget_yen, markup_bps: p.contract_markup_bps, fee_yen: p.contract_fee_yen,
        milestone_count: p.contract_milestone_count, recorded_milestones: p.contract_recorded_milestones, share_total_bps: p.contract_share_total_bps})),
    acquisitionEvidence: projectRows.map((p) => ({project_id: p.id, mg_contracts: p.mg_contracts, purchase_works: p.purchase_works})),
  };
}

// 売上の元になる入金の区分（区分マスタの入金で、売上の元が「はい」）の id の副問い合わせ（予実の予測の売上の行を絞る）
export function revenueCategoryScope(orgId) {
  return {sql: "SELECT rc.id FROM cashflow_categories rc WHERE rc.org_id=? AND rc.direction='in' AND rc.counts_as_revenue=1", params: [orgId]};
}
