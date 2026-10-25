// 支払う MG（買付分）の DB の役。表は移行 0026 の acq_mg_*。SQL はこのファイルだけに書く（docs/rules/architecture.md）。
// どの関数も org_id で絞る。権限の判定と入力の確かめは受け口（acq-mg-routes.mjs）が先に済ませる。
const marks = (list) => list.map(() => '?').join(',');

// 条件版1つ分の INSERT（版の行と子の行と操作の記録）。D1 の batch に入れる
function termStatements(orgId, userId, contractId, versionId, versionNo, input) {
  const {normalized: t, term, startsOn, endsOn, phases, reason} = input;
  const rows = [{sql: `INSERT INTO acq_mg_term_versions(id,org_id,contract_id,version_no,consideration,currency,mg_amount,starts_on,ends_on,recoup_basis,platform_rate_bps,agency_fee_bps,
      overage_enabled,overage_rate_bps,pooling,shortfall_from_other_media,multi_work,hold_agreement_ref,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: [versionId, orgId, contractId, versionNo, t.consideration, term.currency, t.mgAmount, startsOn, endsOn, t.recoupBasis, t.platformRateBps, t.agencyFeeBps,
    t.overageEnabled === null ? null : t.overageEnabled ? 1 : 0, t.overageRateBps, t.pooling, t.shortfallFromOtherMedia ? 1 : 0, t.multiWork,
    t.multiWork === 'hold_until_total' ? String(term.holdAgreementRef).trim() : null, reason, userId]}];
  for (const w of t.works) rows.push({sql: 'INSERT INTO acq_mg_term_works(org_id,term_version_id,work_id,preset_amount) VALUES(?,?,?,?)', params: [orgId, versionId, Number(w.workId), w.presetAmount]});
  term.deductions.forEach((d, index) => rows.push({sql: 'INSERT INTO acq_mg_term_deductions(org_id,term_version_id,category,cap_amount,cap_bps,source_ref) VALUES(?,?,?,?,?,?)',
    params: [orgId, versionId, t.deductions[index].category, t.deductions[index].capAmount, t.deductions[index].capBps, String(d.sourceRef).trim()]}));
  for (const p of phases) rows.push({sql: `INSERT INTO acq_mg_term_phases(org_id,term_version_id,phase_order,starts_month,ends_month,cycle_kind,anchor_month,report_offset_months,report_day,payment_offset_months,payment_day)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, params: [orgId, versionId, p.order, p.startsMonth, p.endsMonth, p.cycleKind, p.anchorMonth, p.reportOffsetMonths, p.reportDay, p.paymentOffsetMonths, p.paymentDay]});
  for (const m of t.mediaAllocations) rows.push({sql: 'INSERT INTO acq_mg_term_media_allocations(org_id,term_version_id,media,amount) VALUES(?,?,?,?)', params: [orgId, versionId, m.media, m.amount]});
  for (const p of term.paymentSchedule) rows.push({sql: 'INSERT INTO acq_mg_payment_schedule(org_id,term_version_id,installment,trigger_kind,due_on,amount) VALUES(?,?,?,?,?,?)',
    params: [orgId, versionId, p.installment, p.trigger, p.dueOn, p.amount]});
  rows.push({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
    params: [orgId, userId, 'append', 'acq_mg_term_version', String(versionId), JSON.stringify({contractId, versionNo, startsOn, endsOn, reason})]});
  return rows;
}

// DB の条件版の行と子の行を、計算の条件の形に戻す
function termFromRows(v, works, deductions, allocations, schedule) {
  return {
    consideration: v.consideration, currency: v.currency, mgAmount: v.mg_amount, recoupBasis: v.recoup_basis, platformRateBps: v.platform_rate_bps,
    agencyFeeBps: v.agency_fee_bps, overageEnabled: v.overage_enabled === null ? null : v.overage_enabled === 1, overageRateBps: v.overage_rate_bps ?? undefined,
    pooling: v.pooling, shortfallFromOtherMedia: v.shortfall_from_other_media === 1, multiWork: v.multi_work, holdAgreementRef: v.hold_agreement_ref,
    works: works.map((w) => ({workId: String(w.work_id), presetAmount: w.preset_amount})),
    deductions: deductions.map((d) => ({category: d.category, capAmount: d.cap_amount, capBps: d.cap_bps})),
    mediaAllocations: allocations.map((m) => ({media: m.media, amount: m.amount})),
    paymentSchedule: schedule.map((p) => ({installment: p.installment, trigger: p.trigger_kind, amount: p.amount})),
  };
}

export const listContracts = (db, orgId) => db.all(`SELECT k.*,p.name AS partner_name FROM acq_mg_contracts k JOIN partners p ON p.org_id=k.org_id AND p.id=k.partner_id
  WHERE k.org_id=? ORDER BY k.code`, [orgId]);

export const getContract = (db, orgId, contractId) => db.get(`SELECT k.*,p.name AS partner_name FROM acq_mg_contracts k JOIN partners p ON p.org_id=k.org_id AND p.id=k.partner_id
  WHERE k.org_id=? AND k.id=?`, [orgId, contractId]);

export const contractVersions = (db, orgId, contractId) => db.all(`SELECT id,version_no,starts_on,ends_on,mg_amount,reason,created_at FROM acq_mg_term_versions
  WHERE org_id=? AND contract_id=? ORDER BY version_no`, [orgId, contractId]);

export async function latestVersionId(db, orgId, contractId) {
  const row = await db.get('SELECT id FROM acq_mg_term_versions WHERE org_id=? AND contract_id=? ORDER BY version_no DESC LIMIT 1', [orgId, contractId]);
  return row?.id ?? null;
}

export async function loadVersion(db, orgId, versionId) {
  const [v, works, deductions, allocations, schedule, phases] = await Promise.all([
    db.get('SELECT * FROM acq_mg_term_versions WHERE org_id=? AND id=?', [orgId, versionId]),
    db.all('SELECT * FROM acq_mg_term_works WHERE org_id=? AND term_version_id=? ORDER BY work_id', [orgId, versionId]),
    db.all('SELECT * FROM acq_mg_term_deductions WHERE org_id=? AND term_version_id=? ORDER BY category', [orgId, versionId]),
    db.all('SELECT * FROM acq_mg_term_media_allocations WHERE org_id=? AND term_version_id=? ORDER BY media', [orgId, versionId]),
    db.all('SELECT * FROM acq_mg_payment_schedule WHERE org_id=? AND term_version_id=? ORDER BY installment', [orgId, versionId]),
    db.all('SELECT * FROM acq_mg_term_phases WHERE org_id=? AND term_version_id=? ORDER BY phase_order', [orgId, versionId]),
  ]);
  if (!v) return null;
  return {row: v, works, deductions, allocations, schedule, phases, term: termFromRows(v, works, deductions, allocations, schedule)};
}

// 結び付けの鎖の最後の行だけが生きている（replaces_link_id で指された行は直された）
export function liveLinks(db, orgId, versionIds) {
  if (!versionIds.length) return Promise.resolve([]);
  return db.all(`SELECT l.* FROM acq_mg_report_links l WHERE l.org_id=? AND l.term_version_id IN (${marks(versionIds)})
    AND NOT EXISTS(SELECT 1 FROM acq_mg_report_links n WHERE n.org_id=l.org_id AND n.replaces_link_id=l.id) ORDER BY l.report_id,l.work_id`, [orgId, ...versionIds]);
}

export async function partnerExists(db, orgId, partnerId) {
  return Boolean(await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?', [orgId, partnerId]));
}

export async function intakeCaseForWorks(db, orgId, intakeCaseId, workIds) {
  return Boolean(await db.get(`SELECT 1 FROM rights_intake_cases WHERE org_id=? AND id=? AND work_id IN (${marks(workIds)})`, [orgId, intakeCaseId, ...workIds]));
}

export async function contractExists(db, orgId, contractId) {
  return Boolean(await db.get('SELECT 1 FROM acq_mg_contracts WHERE org_id=? AND id=?', [orgId, contractId]));
}

// 契約のどれかの版で対象にした作品（版を足すときは、前の版の作品の権限も要る）
export async function contractWorkIds(db, orgId, contractId) {
  const rows = await db.all(`SELECT DISTINCT w.work_id FROM acq_mg_term_works w JOIN acq_mg_term_versions v ON v.org_id=w.org_id AND v.id=w.term_version_id
    WHERE w.org_id=? AND v.contract_id=?`, [orgId, contractId]);
  return rows.map((r) => r.work_id);
}

export async function insertContract(db, {orgId, userId, contractId, versionId, code, title, partnerId, intakeCaseId, input}) {
  await db.batch([
    {sql: 'INSERT INTO acq_mg_contracts(id,org_id,code,title,partner_id,intake_case_id,created_by) VALUES(?,?,?,?,?,?,?)', params: [contractId, orgId, code, title, partnerId, intakeCaseId, userId]},
    ...termStatements(orgId, userId, contractId, versionId, 1, input),
  ]);
}

// 版の番号は DB のトリガーが連番を確かめる（同時に足したら後の方が断られる）
export async function insertVersion(db, {orgId, userId, contractId, versionId, input}) {
  const next = await db.get('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM acq_mg_term_versions WHERE org_id=? AND contract_id=?', [orgId, contractId]);
  const versionNo = Number(next.n);
  await db.batch(termStatements(orgId, userId, contractId, versionId, versionNo, input));
  return versionNo;
}

// 各契約の最新の版と、その対象の作品・期間（結び付けの候補を出すため）
export const latestVersionWorks = (db, orgId) => db.all(`SELECT v.id,v.contract_id,v.starts_on,v.ends_on,w.work_id FROM acq_mg_term_versions v
  JOIN acq_mg_term_works w ON w.org_id=v.org_id AND w.term_version_id=v.id
  WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM acq_mg_term_versions x WHERE x.org_id=v.org_id AND x.contract_id=v.contract_id)`, [orgId]);

export async function linkedPairs(db, orgId) {
  const rows = await db.all('SELECT report_id,work_id FROM acq_mg_report_links WHERE org_id=?', [orgId]);
  return new Set(rows.map((l) => `${l.report_id}:${l.work_id}`));
}

export const versionForWork = (db, orgId, versionId, workId) => db.get(`SELECT v.* FROM acq_mg_term_versions v JOIN acq_mg_term_works w ON w.org_id=v.org_id AND w.term_version_id=v.id
  WHERE v.org_id=? AND v.id=? AND w.work_id=?`, [orgId, versionId, workId]);

// 同じ作品で、報告の期間を覆うほかの契約の最新の版（自動で結べるのは1つに決まるときだけ）
export const otherVersionsCovering = (db, orgId, workId, versionId, periodFrom, periodTo) => db.all(`SELECT v.id FROM acq_mg_term_versions v
  JOIN acq_mg_term_works w ON w.org_id=v.org_id AND w.term_version_id=v.id
  WHERE v.org_id=? AND w.work_id=? AND v.id<>? AND v.starts_on<=? AND v.ends_on>=?
  AND v.version_no=(SELECT MAX(x.version_no) FROM acq_mg_term_versions x WHERE x.org_id=v.org_id AND x.contract_id=v.contract_id)`, [orgId, workId, versionId, periodFrom, periodTo]);

// 報告が有効なときだけ結ぶ（取り消された報告は transaction_guards で batch ごと止める）
export async function insertLink(db, {orgId, userId, linkId, reportId, workId, termVersionId, reportBasis, decidedBy, decision, reason, replacesLinkId}) {
  await db.batch([
    {sql: "INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM report_imports WHERE org_id=? AND id=? AND status='active')", params: [orgId, reportId]},
    {sql: `INSERT INTO acq_mg_report_links(id,org_id,report_id,work_id,term_version_id,report_basis,decided_by,decision,reason,replaces_link_id,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, params: [linkId, orgId, reportId, workId, termVersionId, reportBasis, decidedBy, decision, reason, replacesLinkId, userId]},
    {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
      params: [orgId, userId, 'link', 'acq_mg_report_link', String(linkId), JSON.stringify({reportId, workId, termVersionId, decidedBy, decision, replacesLinkId})]},
  ]);
}

// ---------- 分配報告書（acq_mg_statements）----------

// 契約の全部の版の発行と取消（新しい締め月から）。取消された発行には voided を付ける
export const contractStatements = (db, orgId, contractId) => db.all(`SELECT s.id,s.term_version_id,s.close_month,s.kind,s.status,s.recouped,s.balance,s.overage,s.distribution,
  s.body_sha256,s.issued_on,s.voids_statement_id,s.reason,s.created_by,s.created_at,
  EXISTS(SELECT 1 FROM acq_mg_statements v WHERE v.org_id=s.org_id AND v.voids_statement_id=s.id) AS voided
  FROM acq_mg_statements s JOIN acq_mg_term_versions t ON t.org_id=s.org_id AND t.id=s.term_version_id
  WHERE s.org_id=? AND t.contract_id=? ORDER BY s.close_month DESC,s.id DESC`, [orgId, contractId]);

// 同じ契約で、締め月より前の、取り消されていない最後の発行（当期の増分の起点）
export const previousLiveIssue = (db, orgId, contractId, closeMonth) => db.get(`SELECT s.* FROM acq_mg_statements s
  JOIN acq_mg_term_versions t ON t.org_id=s.org_id AND t.id=s.term_version_id
  WHERE s.org_id=? AND t.contract_id=? AND s.kind='issue' AND s.close_month<?
  AND NOT EXISTS(SELECT 1 FROM acq_mg_statements v WHERE v.org_id=s.org_id AND v.voids_statement_id=s.id)
  ORDER BY s.close_month DESC,s.id DESC LIMIT 1`, [orgId, contractId, closeMonth]);

export const getStatement = (db, orgId, statementId) => db.get(`SELECT s.*,t.contract_id FROM acq_mg_statements s
  JOIN acq_mg_term_versions t ON t.org_id=s.org_id AND t.id=s.term_version_id WHERE s.org_id=? AND s.id=?`, [orgId, statementId]);

// 発行。同じ条件版と締め月に生きた発行があれば DB のトリガーが断る
export async function insertStatementIssue(db, {orgId, userId, statementId, termVersionId, closeMonth, recoup, bodyJson, bodySha256, issuedOn}) {
  await db.batch([
    {sql: `INSERT INTO acq_mg_statements(id,org_id,term_version_id,close_month,kind,status,recouped,balance,overage,distribution,body_json,body_sha256,issued_on,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [statementId, orgId, termVersionId, closeMonth, 'issue', recoup.status, recoup.recouped, recoup.balance, recoup.overage,
      recoup.distribution, bodyJson, bodySha256, issuedOn, userId]},
    {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
      params: [orgId, userId, 'issue', 'acq_mg_statement', String(statementId), JSON.stringify({termVersionId, closeMonth, bodySha256})]},
  ]);
}

// 取消。前の発行を指す行を足す（取消の行は値を持たない）。取り消せるのは同じ条件版と締め月の発行だけ（トリガー）
export async function insertStatementVoid(db, {orgId, userId, statementId, target, reason, issuedOn}) {
  await db.batch([
    {sql: `INSERT INTO acq_mg_statements(id,org_id,term_version_id,close_month,kind,issued_on,voids_statement_id,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?)`,
      params: [statementId, orgId, target.term_version_id, target.close_month, 'void', issuedOn, target.id, reason, userId]},
    {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
      params: [orgId, userId, 'void', 'acq_mg_statement', String(target.id), JSON.stringify({voidId: statementId, reason})]},
  ]);
}

// ---------- 支払（acq_mg_payments。移行 0027）----------

export const contractPayments = (db, orgId, contractId) => db.all(`SELECT p.* FROM acq_mg_payments p WHERE p.org_id=? AND p.contract_id=? ORDER BY p.paid_on DESC,p.created_at DESC`, [orgId, contractId]);

export const contractSchedule = (db, orgId, termVersionId) => db.all('SELECT * FROM acq_mg_payment_schedule WHERE org_id=? AND term_version_id=? ORDER BY installment', [orgId, termVersionId]);

// 取り消されていない最新の発行（分配額の累計＝払うべき分配額）
export const latestLiveIssue = (db, orgId, contractId) => db.get(`SELECT s.* FROM acq_mg_statements s
  JOIN acq_mg_term_versions t ON t.org_id=s.org_id AND t.id=s.term_version_id
  WHERE s.org_id=? AND t.contract_id=? AND s.kind='issue'
  AND NOT EXISTS(SELECT 1 FROM acq_mg_statements v WHERE v.org_id=s.org_id AND v.voids_statement_id=s.id)
  ORDER BY s.close_month DESC,s.created_at DESC LIMIT 1`, [orgId, contractId]);

export const getPayment = (db, orgId, paymentId) => db.get('SELECT * FROM acq_mg_payments WHERE org_id=? AND id=?', [orgId, paymentId]);

// 仕訳（約束 F-2）は postJournal が core に入ったときに、この batch に足す
export async function insertPayment(db, {orgId, userId, paymentId, contract, termVersionId, input, reversesPaymentId = null}) {
  await db.batch([
    {sql: `INSERT INTO acq_mg_payments(id,org_id,contract_id,term_version_id,kind,installment,statement_id,partner_id,amount_yen,paid_on,reference,currency,foreign_amount,fx_rate_micro,fx_rate_on,reverses_payment_id,reason,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [paymentId, orgId, contract.id, termVersionId, input.kind, input.installment, input.statementId, contract.partner_id, input.amountYen,
      input.paidOn, input.reference, input.currency, input.foreignAmount, input.fxRateMicro, input.fxRateOn, reversesPaymentId, input.reason, userId]},
    {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
      params: [orgId, userId, reversesPaymentId ? 'reverse' : 'create', 'acq_mg_payment', String(paymentId), JSON.stringify({contractId: contract.id, kind: input.kind, amountYen: input.amountYen, paidOn: input.paidOn, reversesPaymentId})]},
  ]);
}
