// 調達の DB の読み書き（移行 0052。会社ルートの plans/2026-10-24-folder-chotatsu.md）。
// 書き込みは1回の batch で、番号の取り合いは DB のトリガーが断る（受け口が 409 にする）。変更の記録 audit_log に1行残す（金額は残さない）
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const audit = (orgId, userId, action, entity, id, detail) => ({sql: AUDIT_INSERT, params: [orgId, userId, action, entity, String(id), JSON.stringify(detail)]});
const marks = (list) => list.map(() => '?').join(',');
const num = (v) => (v == null ? null : Number(v));

export async function readPartners(db, orgId) {
  return db.all('SELECT id,name FROM partners WHERE org_id=? ORDER BY name,id', [orgId]);
}

export async function readWorks(db, orgId, projectIds) {
  if (!projectIds.length) return [];
  return db.all(`SELECT id,project_id,code,title FROM works WHERE org_id=? AND project_id IN (${marks(projectIds)}) ORDER BY id`, [orgId, ...projectIds]);
}

export async function partnerExists(db, orgId, id) {
  return Boolean(await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?', [orgId, id]));
}

export async function readWork(db, orgId, id) {
  return db.get('SELECT id,project_id,title FROM works WHERE org_id=? AND id=?', [orgId, id]);
}

export async function salesActivityExists(db, orgId, id) {
  return Boolean(await db.get('SELECT 1 FROM sales_activities WHERE org_id=? AND id=?', [orgId, id]));
}

export async function expenseExists(db, orgId, id) {
  return Boolean(await db.get('SELECT 1 FROM expenses WHERE org_id=? AND id=?', [orgId, id]));
}

export async function readCaseRows(db, orgId) {
  return db.all('SELECT id,case_code,created_at FROM chotatsu_cases WHERE org_id=? ORDER BY id', [orgId]);
}

// 一覧と1件の両方が使う、案件ごとの記録（ids で絞る）
export async function readCaseRecords(db, orgId, ids) {
  if (!ids.length) return {versions: [], events: [], estimates: [], lines: [], agreements: [], ringi: [], contracts: [], scopes: [], materials: [], handoffs: [],
    handoffEvents: [], documents: [], expenses: []};
  const m = marks(ids);
  const p = [orgId, ...ids];
  const [versions, events, estimates, lines, agreements, ringi, contracts, materials, handoffs, handoffEvents, documents, expenses] = await Promise.all([
    db.all(`SELECT v.*,h.name AS holder_name,d.name AS distributor_name FROM chotatsu_case_versions v
      LEFT JOIN partners h ON h.org_id=v.org_id AND h.id=v.holder_partner_id LEFT JOIN partners d ON d.org_id=v.org_id AND d.id=v.distributor_partner_id
      WHERE v.org_id=? AND v.case_id IN (${m}) ORDER BY v.case_id,v.version_no`, p),
    db.all(`SELECT case_id,seq,stage,event,voids_seq,on_date,reason,created_at FROM chotatsu_stage_events WHERE org_id=? AND case_id IN (${m}) ORDER BY case_id,seq`, p),
    db.all(`SELECT * FROM chotatsu_estimates WHERE org_id=? AND case_id IN (${m}) ORDER BY case_id,version_no`, p),
    db.all(`SELECT case_id,estimate_id,line_no,expense_type,name,amount_ex_tax_yen,source_document_id FROM chotatsu_estimate_lines WHERE org_id=? AND case_id IN (${m})
      ORDER BY estimate_id,line_no`, p),
    db.all(`SELECT a.id,a.case_id,a.estimate_id,e.version_no AS estimate_version_no,a.agreed_on,a.source_document_id FROM chotatsu_agreements a
      JOIN chotatsu_estimates e ON e.org_id=a.org_id AND e.id=a.estimate_id WHERE a.org_id=? AND a.case_id IN (${m}) ORDER BY a.case_id,a.id`, p),
    db.all(`SELECT r.id,r.case_id,r.estimate_id,e.version_no AS estimate_version_no,r.result,r.result_on,r.source_document_id,r.note FROM chotatsu_ringi r
      JOIN chotatsu_estimates e ON e.org_id=r.org_id AND e.id=r.estimate_id WHERE r.org_id=? AND r.case_id IN (${m}) ORDER BY r.case_id,r.id`, p),
    db.all(`SELECT k.*,i.case_code AS intake_case_code,s.contract_code AS settlement_contract_code,w.title AS work_title FROM chotatsu_contracts k
      JOIN rights_intake_cases i ON i.org_id=k.org_id AND i.id=k.intake_case_id JOIN settlement_contracts s ON s.org_id=k.org_id AND s.id=k.settlement_contract_id
      JOIN works w ON w.org_id=k.org_id AND w.id=k.work_id WHERE k.org_id=? AND k.case_id IN (${m}) ORDER BY k.case_id,k.id`, p),
    db.all(`SELECT case_id,seq,material_kind,required,received_on,check_result,source_document_id,note FROM chotatsu_materials WHERE org_id=? AND case_id IN (${m})
      ORDER BY case_id,seq`, p),
    db.all(`SELECT h.*,e.version_no AS estimate_version_no FROM chotatsu_handoffs h JOIN chotatsu_estimates e ON e.org_id=h.org_id AND e.id=h.estimate_id
      WHERE h.org_id=? AND h.case_id IN (${m}) ORDER BY h.case_id,h.handoff_no`, p),
    db.all(`SELECT x.handoff_id,x.seq,x.event,x.reason,x.created_at FROM chotatsu_handoff_events x JOIN chotatsu_handoffs h ON h.org_id=x.org_id AND h.id=x.handoff_id
      WHERE x.org_id=? AND h.case_id IN (${m}) ORDER BY x.handoff_id,x.seq`, p),
    db.all(`SELECT l.case_id,l.source_document_id,l.doc_kind,d.file_name,d.received_on,d.byte_length FROM chotatsu_documents l
      JOIN source_documents d ON d.org_id=l.org_id AND d.id=l.source_document_id WHERE l.org_id=? AND l.case_id IN (${m}) ORDER BY l.case_id,l.id`, p),
    db.all(`SELECT case_id,expense_id,estimate_line_id FROM chotatsu_case_expenses WHERE org_id=? AND case_id IN (${m}) ORDER BY case_id,id`, p),
  ]);
  const intakeIds = [...new Set(contracts.map((k) => Number(k.intake_case_id)))];
  const scopes = intakeIds.length ? await db.all(`SELECT intake_case_id,channel,territory,rights_start,rights_end,exclusivity FROM rights_intake_scopes
    WHERE org_id=? AND intake_case_id IN (${marks(intakeIds)}) ORDER BY id`, [orgId, ...intakeIds]) : [];
  return {versions, events, estimates, lines, agreements, ringi, contracts, scopes, materials, handoffs, handoffEvents, documents, expenses};
}

export async function nextCaseCode(db, orgId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM chotatsu_cases WHERE org_id=?', [orgId]);
  return `CH-${String(Number(row.n) + 1).padStart(4, '0')}`;
}

const VERSION_COLUMNS = 'org_id,case_id,version_no,title,holder_partner_id,distributor_partner_id,media_family,work_id,origin,sales_activity_id,theatrical_release_on,offer_from,offer_until,release_month,release_slot,note,reason,created_by';
const versionParams = (orgId, caseRef, versionNo, v, userId) => [orgId, ...caseRef.params, versionNo, v.title, v.holderPartnerId, v.distributorPartnerId, v.mediaFamily, v.workId,
  v.origin, v.salesActivityId, v.theatricalReleaseOn, v.offerFrom, v.offerUntil, v.releaseMonth, v.releaseSlot, v.note, v.reason, userId];

export async function addCase(db, orgId, caseCode, version, {userId, today}) {
  const caseRef = {sql: '(SELECT id FROM chotatsu_cases WHERE org_id=? AND case_code=?)', params: [orgId, caseCode]};
  await db.batch([
    {sql: 'INSERT INTO chotatsu_cases(org_id,case_code,created_by) VALUES(?,?,?)', params: [orgId, caseCode, userId]},
    {sql: `INSERT INTO chotatsu_case_versions(${VERSION_COLUMNS}) VALUES(?,${caseRef.sql},?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: versionParams(orgId, caseRef, 1, version, userId)},
    {sql: `INSERT INTO chotatsu_stage_events(org_id,case_id,seq,stage,event,on_date,created_by) VALUES(?,${caseRef.sql},1,'wish','done',?,?)`, params: [orgId, orgId, caseCode, today, userId]},
    audit(orgId, userId, 'create', 'chotatsu_case', caseCode, {caseCode, mediaFamily: version.mediaFamily}),
  ]);
  const row = await db.get('SELECT id FROM chotatsu_cases WHERE org_id=? AND case_code=?', [orgId, caseCode]);
  return Number(row.id);
}

export async function addCaseVersion(db, orgId, caseId, versionNo, version, {userId}) {
  const caseRef = {sql: '?', params: [caseId]};
  await db.batch([
    {sql: `INSERT INTO chotatsu_case_versions(${VERSION_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: versionParams(orgId, caseRef, versionNo, version, userId)},
    audit(orgId, userId, 'version', 'chotatsu_case', caseId, {versionNo}),
  ]);
}

export async function addEstimate(db, orgId, caseId, versionNo, e, {userId}) {
  const estimateRef = '(SELECT id FROM chotatsu_estimates WHERE org_id=? AND case_id=? AND version_no=?)';
  await db.batch([
    {sql: `INSERT INTO chotatsu_estimates(org_id,case_id,version_no,format,set_count,bonus_note,list_price_ex_tax_yen,unit_revenue_ex_tax_yen,quantity,royalty_kind,
      royalty_rate_bps,royalty_per_unit_yen,promotion_note,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, caseId, versionNo, e.format, e.setCount, e.bonusNote, e.listPriceExTaxYen, e.unitRevenueExTaxYen, e.quantity, e.royaltyKind, e.royaltyRateBps,
      e.royaltyPerUnitYen, e.promotionNote, e.reason, userId]},
    ...e.lines.map((line) => ({sql: `INSERT INTO chotatsu_estimate_lines(org_id,case_id,estimate_id,line_no,expense_type,name,amount_ex_tax_yen,source_document_id)
      VALUES(?,?,${estimateRef},?,?,?,?,?)`, params: [orgId, caseId, orgId, caseId, versionNo, line.lineNo, line.expenseType, line.name, line.amountExTaxYen, line.sourceDocumentId]})),
    audit(orgId, userId, 'append', 'chotatsu_estimate', `${caseId}:${versionNo}`, {versionNo, lineCount: e.lines.length}),
  ]);
}

export async function addAgreement(db, orgId, caseId, {estimateId, agreedOn, sourceDocumentId}, {userId}) {
  await db.batch([
    {sql: 'INSERT INTO chotatsu_agreements(org_id,case_id,estimate_id,agreed_on,source_document_id,created_by) VALUES(?,?,?,?,?,?)',
      params: [orgId, caseId, estimateId, agreedOn, sourceDocumentId, userId]},
    audit(orgId, userId, 'append', 'chotatsu_agreement', caseId, {estimateId, agreedOn}),
  ]);
}

export async function addRingi(db, orgId, caseId, {estimateId, result, resultOn, sourceDocumentId, note}, {userId}) {
  await db.batch([
    {sql: 'INSERT INTO chotatsu_ringi(org_id,case_id,estimate_id,result,result_on,source_document_id,note,created_by) VALUES(?,?,?,?,?,?,?,?)',
      params: [orgId, caseId, estimateId, result, resultOn, sourceDocumentId, note, userId]},
    audit(orgId, userId, 'append', 'chotatsu_ringi', caseId, {estimateId, result}),
  ]);
}

// 契約: 調達案件（受け方 entrusted）・権利範囲・委託者・原本の参照、配給委託の契約（commission）と条件版、両者の関連、調達の契約の行を1回の batch で作る
export async function addContract(db, orgId, caseId, c, {userId}) {
  const intakeRef = '(SELECT id FROM rights_intake_cases WHERE org_id=? AND case_code=?)';
  const contractRef = '(SELECT id FROM settlement_contracts WHERE org_id=? AND contract_code=?)';
  const statements = [
    {sql: `INSERT INTO rights_intake_cases(org_id,project_id,work_id,case_code,title,intake_type,snapshot_version,created_by) VALUES(?,?,?,?,?,'entrusted',1,?)`,
      params: [orgId, c.projectId, c.workId, c.intakeCode, c.title, userId]},
    ...c.scopes.map((s) => ({sql: `INSERT INTO rights_intake_scopes(org_id,intake_case_id,channel,territory,rights_start,rights_end,exclusivity) VALUES(?,${intakeRef},?,?,?,?,?)`,
      params: [orgId, orgId, c.intakeCode, s.channel, s.territory, s.rightsStart, s.rightsEnd, s.exclusivity]})),
    {sql: `INSERT INTO rights_intake_participants(org_id,intake_case_id,party_kind,partner_id,role) VALUES(?,${intakeRef},'partner',?,'委託者')`,
      params: [orgId, orgId, c.intakeCode, c.holderPartnerId]},
    ...(c.signedDocument ? [{sql: `INSERT INTO rights_intake_documents(org_id,intake_case_id,title,reference,version_label,content_hash) VALUES(?,${intakeRef},?,?,?,?)`,
      params: [orgId, orgId, c.intakeCode, c.signedDocument.fileName, `source_documents:${c.signedDocument.id}`, '締結版', c.signedDocument.sha256]}] : []),
    {sql: `INSERT INTO settlement_contracts(org_id,project_id,work_id,contract_code,title,contract_type,holder_partner_id,created_by) VALUES(?,?,?,?,?,'commission',?,?)`,
      params: [orgId, c.projectId, c.workId, c.contractCode, c.title, c.holderPartnerId, userId]},
    {sql: `INSERT INTO settlement_term_versions(org_id,contract_id,version_no,platform_rate_bps,agency_fee_bps,note,created_by) VALUES(?,${contractRef},1,?,?,?,?)`,
      params: [orgId, orgId, c.contractCode, c.platformRateBps, c.agencyFeeBps, '調達の契約の段で作成', userId]},
    {sql: `INSERT INTO intake_settlement_links(org_id,intake_case_id,work_id,settlement_contract_id,created_by) VALUES(?,${intakeRef},?,${contractRef},?)`,
      params: [orgId, orgId, c.intakeCode, c.workId, orgId, c.contractCode, userId]},
    {sql: `INSERT INTO chotatsu_contracts(org_id,case_id,intake_case_id,work_id,settlement_contract_id,signed_on,signed_document_id,created_by) VALUES(?,?,${intakeRef},?,${contractRef},?,?,?)`,
      params: [orgId, caseId, orgId, c.intakeCode, c.workId, orgId, c.contractCode, c.signedOn, c.signedDocument?.id ?? null, userId]},
    audit(orgId, userId, 'create', 'chotatsu_contract', caseId, {intakeCode: c.intakeCode, contractCode: c.contractCode, workId: c.workId, scopes: c.scopes.length}),
  ];
  await db.batch(statements);
}

export async function addMaterial(db, orgId, caseId, seq, m, {userId}) {
  await db.batch([
    {sql: `INSERT INTO chotatsu_materials(org_id,case_id,seq,material_kind,required,received_on,check_result,source_document_id,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      params: [orgId, caseId, seq, m.materialKind, m.required ? 1 : 0, m.receivedOn, m.checkResult, m.sourceDocumentId, m.note, userId]},
    audit(orgId, userId, 'append', 'chotatsu_material', `${caseId}:${seq}`, {materialKind: m.materialKind, checkResult: m.checkResult}),
  ]);
}

export async function addHandoff(db, orgId, caseId, handoffNo, h, {userId}) {
  const handoffRef = '(SELECT id FROM chotatsu_handoffs WHERE org_id=? AND case_id=? AND handoff_no=?)';
  await db.batch([
    {sql: `INSERT INTO chotatsu_handoffs(org_id,case_id,handoff_no,work_id,intake_case_id,estimate_id,allowed_formats,territory,rights_end,release_slot,release_month,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, params: [orgId, caseId, handoffNo, h.workId, h.intakeCaseId, h.estimateId, JSON.stringify(h.allowedFormats), h.territory, h.rightsEnd,
      h.releaseSlot, h.releaseMonth, userId]},
    {sql: `INSERT INTO chotatsu_handoff_events(org_id,handoff_id,seq,event,created_by) VALUES(?,${handoffRef},1,'notice',?)`, params: [orgId, orgId, caseId, handoffNo, userId]},
    audit(orgId, userId, 'notice', 'chotatsu_handoff', `${caseId}:${handoffNo}`, {handoffNo, releaseMonth: h.releaseMonth}),
  ]);
}

export async function addHandoffEvent(db, orgId, handoffId, seq, event, reason, {userId}) {
  await db.batch([
    {sql: 'INSERT INTO chotatsu_handoff_events(org_id,handoff_id,seq,event,reason,created_by) VALUES(?,?,?,?,?,?)', params: [orgId, handoffId, seq, event, reason, userId]},
    audit(orgId, userId, event, 'chotatsu_handoff_event', `${handoffId}:${seq}`, {event}),
  ]);
}

export async function addStageEvent(db, orgId, caseId, seq, e, {userId}) {
  await db.batch([
    {sql: 'INSERT INTO chotatsu_stage_events(org_id,case_id,seq,stage,event,voids_seq,on_date,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
      params: [orgId, caseId, seq, e.stage, e.event, e.voidsSeq, e.onDate, e.reason, userId]},
    audit(orgId, userId, e.event, 'chotatsu_stage_event', `${caseId}:${seq}`, {stage: e.stage, event: e.event, voidsSeq: e.voidsSeq}),
  ]);
}

export async function linkDocument(db, orgId, caseId, sourceDocumentId, docKind, {userId}) {
  const exists = await db.get('SELECT 1 FROM chotatsu_documents WHERE org_id=? AND case_id=? AND source_document_id=?', [orgId, caseId, sourceDocumentId]);
  if (exists) return false;
  await db.batch([
    {sql: 'INSERT INTO chotatsu_documents(org_id,case_id,source_document_id,doc_kind,created_by) VALUES(?,?,?,?,?)', params: [orgId, caseId, sourceDocumentId, docKind, userId]},
    audit(orgId, userId, 'link', 'chotatsu_document', `${caseId}:${sourceDocumentId}`, {docKind}),
  ]);
  return true;
}

export async function linkExpense(db, orgId, caseId, expenseId, estimateLineId, {userId}) {
  await db.batch([
    {sql: 'INSERT INTO chotatsu_case_expenses(org_id,case_id,expense_id,estimate_line_id,created_by) VALUES(?,?,?,?,?)', params: [orgId, caseId, expenseId, estimateLineId, userId]},
    audit(orgId, userId, 'link', 'chotatsu_case_expense', `${caseId}:${expenseId}`, {estimateLineId}),
  ]);
}

export const toNumber = num;
