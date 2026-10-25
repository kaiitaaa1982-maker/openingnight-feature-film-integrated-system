// 営業管理の最初の切れの DB の読み書き（移行 0049 の5表と、営業案件・ウィンドウ・活動・契約の読み取り）。
// 受け口（proposal-routes.mjs）は SQL を書かず、ここの関数だけを呼ぶ。書き込みは監査の記録と同じ1つの batch に入れる。
import {allIn} from '../../sql-in.mjs';

const WINDOW_SQL = `SELECT w.id AS window_id,w.work_id,t.type_key,tv.label AS type_label,tv.family,tv.sort_order,v.start_on,v.end_on,v.date_precision,v.status
  FROM work_release_windows w
  JOIN release_window_types t ON t.org_id=w.org_id AND t.id=w.type_id
  JOIN release_window_type_versions tv ON tv.org_id=w.org_id AND tv.type_id=w.type_id
   AND tv.version_no=(SELECT MAX(y.version_no) FROM release_window_type_versions y WHERE y.org_id=w.org_id AND y.type_id=w.type_id)
  JOIN work_release_window_versions v ON v.org_id=w.org_id AND v.window_id=w.id
   AND v.version_no=(SELECT MAX(x.version_no) FROM work_release_window_versions x WHERE x.org_id=w.org_id AND x.window_id=w.id)
  WHERE w.org_id=? AND w.work_id IN (:in)`;

const audit = (orgId, userId, entityType, entityId, after) => ({
  sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
  params: [orgId, userId, 'create', entityType, String(entityId), JSON.stringify({before: null, after})],
});
const nextId = async (db, table) => Number((await db.get(`SELECT COALESCE(MAX(id),0)+1 AS id FROM ${table}`)).id);

export const readWorks = (db, orgId) => db.all('SELECT id,project_id,code,title FROM works WHERE org_id=? ORDER BY code,id', [orgId]);
export const readPartners = (db, orgId) => db.all('SELECT id,code,name,kind FROM partners WHERE org_id=? ORDER BY code,id', [orgId]);
export const readPartner = (db, orgId, id) => db.get('SELECT id FROM partners WHERE org_id=? AND id=?', [orgId, id]);
export const readOpportunity = (db, orgId, id) => db.get('SELECT id,project_id,work_id,partner_id FROM sales_opportunities WHERE org_id=? AND id=?', [orgId, id]);
export const readProposal = (db, orgId, id) => db.get('SELECT id,opportunity_id,proposed_on FROM sales_proposals WHERE org_id=? AND id=?', [orgId, id]);
export const readActivity = (db, orgId, id) => db.get('SELECT id,opportunity_id FROM sales_activities WHERE org_id=? AND id=?', [orgId, id]);
export const readSnapshotOf = (db, orgId, snapshotId, opportunityId) => db.get('SELECT id FROM sales_material_snapshots WHERE org_id=? AND id=? AND opportunity_id=?', [orgId, snapshotId, opportunityId]);
export const readAgreementOf = (db, orgId, agreementId, opportunityId) => db.get('SELECT id FROM sales_agreements WHERE org_id=? AND id=? AND opportunity_id=?', [orgId, agreementId, opportunityId]);
export const readOwnedWindows = (db, orgId, workId, ids) => allIn(db, 'SELECT id FROM work_release_windows WHERE org_id=? AND work_id=? AND id IN (:in)', {before: [orgId, workId], ids});

// 作品の範囲の営業の記録を、解禁月のページと提案の振り返りに要る分だけまとめて読む
export async function readSalesScope(db, orgId, workIds) {
  const scope = {before: [orgId], ids: workIds};
  const opportunities = await allIn(db, `SELECT o.id,o.project_id,o.work_id,o.partner_id,o.name,o.stage,p.name AS partner_name,p.code AS partner_code
    FROM sales_opportunities o JOIN partners p ON p.org_id=o.org_id AND p.id=o.partner_id WHERE o.org_id=? AND o.work_id IN (:in)`, {...scope, sortBy: (a, b) => a.id - b.id});
  const byOpportunity = {before: [orgId], ids: opportunities.map((row) => row.id)};
  const [windows, proposals, activities, agreements] = await Promise.all([
    allIn(db, WINDOW_SQL, {...scope, sortBy: (a, b) => a.sort_order - b.sort_order || a.window_id - b.window_id}),
    allIn(db, 'SELECT * FROM sales_proposals WHERE org_id=? AND opportunity_id IN (:in)', {...byOpportunity, sortBy: (a, b) => a.id - b.id}),
    allIn(db, 'SELECT id,opportunity_id,work_id,occurred_on,activity_type,summary,result FROM sales_activities WHERE org_id=? AND opportunity_id IN (:in)', {...byOpportunity, sortBy: (a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on)) || b.id - a.id}),
    allIn(db, 'SELECT id,opportunity_id,work_id,contract_code,title FROM sales_agreements WHERE org_id=? AND opportunity_id IN (:in)', {...byOpportunity, sortBy: (a, b) => a.id - b.id}),
  ]);
  const byProposal = {before: [orgId], ids: proposals.map((row) => row.id)};
  const [proposalWindows, reviews] = await Promise.all([
    allIn(db, 'SELECT proposal_id,window_id FROM sales_proposal_windows WHERE org_id=? AND proposal_id IN (:in)', byProposal),
    allIn(db, 'SELECT * FROM sales_proposal_reviews WHERE org_id=? AND proposal_id IN (:in)', {...byProposal, sortBy: (a, b) => a.id - b.id}),
  ]);
  const [factors, notes] = await Promise.all([
    allIn(db, 'SELECT review_id,factor,effect FROM sales_proposal_review_factors WHERE org_id=? AND review_id IN (:in)', {before: [orgId], ids: reviews.map((row) => row.id)}),
    allIn(db, 'SELECT id,activity_id,note_kind,body,tone,created_at FROM sales_activity_notes WHERE org_id=? AND activity_id IN (:in)', {before: [orgId], ids: activities.map((row) => row.id), sortBy: (a, b) => a.id - b.id}),
  ]);
  return {opportunities, windows, proposals, proposalWindows, reviews, factors, activities, notes, agreements};
}

export async function insertOpportunity(db, {orgId, userId, work, input}) {
  const id = await nextId(db, 'sales_opportunities');
  await db.batch([
    {sql: 'INSERT INTO sales_opportunities(id,org_id,project_id,work_id,partner_id,name,stage,expected_yen,close_date) VALUES(?,?,?,?,?,?,?,?,?)',
      params: [id, orgId, work.project_id, work.id, input.partnerId, input.name, input.stage, input.expectedYen, input.closeDate]},
    audit(orgId, userId, 'sales_opportunity', id, input),
  ]);
  return id;
}

export async function insertProposal(db, {orgId, userId, opportunityId, input}) {
  const id = await nextId(db, 'sales_proposals');
  await db.batch([
    {sql: `INSERT INTO sales_proposals(id,org_id,opportunity_id,proposed_on,settlement_method,amount_ex_tax,rate_bps,term_start,term_end,exclusivity,material_snapshot_id,pitch_note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [id, orgId, opportunityId, input.proposedOn, input.settlementMethod, input.amountExTax, input.rateBps, input.termStart, input.termEnd, input.exclusivity, input.materialSnapshotId, input.pitchNote, userId]},
    ...input.windowIds.map((windowId) => ({sql: 'INSERT INTO sales_proposal_windows(org_id,proposal_id,window_id) VALUES(?,?,?)', params: [orgId, id, windowId]})),
    audit(orgId, userId, 'sales_proposal', id, input),
  ]);
  return id;
}

export async function insertReview(db, {orgId, userId, proposalId, input}) {
  const id = await nextId(db, 'sales_proposal_reviews');
  await db.batch([
    {sql: 'INSERT INTO sales_proposal_reviews(id,org_id,proposal_id,reviewed_on,outcome,score,worked,missed,agreement_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
      params: [id, orgId, proposalId, input.reviewedOn, input.outcome, input.score, input.worked, input.missed, input.agreementId, userId]},
    ...input.factors.map(({factor, effect}) => ({sql: 'INSERT INTO sales_proposal_review_factors(org_id,review_id,factor,effect) VALUES(?,?,?,?)', params: [orgId, id, factor, effect]})),
    audit(orgId, userId, 'sales_proposal_review', id, {proposalId, ...input}),
  ]);
  return id;
}

export async function insertNote(db, {orgId, userId, input}) {
  const id = await nextId(db, 'sales_activity_notes');
  await db.batch([
    {sql: 'INSERT INTO sales_activity_notes(id,org_id,activity_id,note_kind,body,tone,created_by) VALUES(?,?,?,?,?,?,?)', params: [id, orgId, input.activityId, input.noteKind, input.body, input.tone, userId]},
    audit(orgId, userId, 'sales_activity_note', id, input),
  ]);
  return id;
}
