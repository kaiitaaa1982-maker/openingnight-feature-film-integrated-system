// 営業管理の最初の切れの受け口（会社ルートの plans/2026-10-22-folder-eigyo.md の表5〜8）。SQL は proposal-store.mjs に置く。
// - GET  /api/sales-launch-month?month=YYYY-MM&asOf=YYYY-MM-DD … 解禁月のページ（作品×流通のまとまり）
// - GET  /api/sales-proposals?partnerId=&workId= … 提案の振り返り・要因の集計・記録の画面の選択肢
// - GET  /api/sales-proposals/export.csv … つないだ表（提案1行）
// - POST /api/sales-opportunities … 営業案件（取引先×作品の商談）。いままで画面からも API からも作れなかった
// - POST /api/sales-proposals … 1回の提案（結んだウィンドウつき）
// - POST /api/sales-proposals/:id/reviews … 結果と自己評価・効いた要因
// - POST /api/sales-activity-notes … 接点の言葉
// - 対象は財務（営業）権限のある作品だけ。制作担当は 403。記録は追加だけで、監査の記録を同じ書き込みに入れる。
import {isoDate} from '../../csv.mjs';
import {todayJst} from '../pipeline-routes.mjs';
import {buildLaunchMonth, buildProposalReview, normalizeMonth, normalizeNoteInput, normalizeProposalInput, normalizeReviewInput, proposalCsv} from './proposal-model.mjs';
import {
  insertNote, insertOpportunity, insertProposal, insertReview, readActivity, readAgreementOf, readOpportunity, readOwnedWindows,
  readPartner, readPartners, readProposal, readSalesScope, readSnapshotOf, readWorks,
} from './proposal-store.mjs';

const EMPTY = {opportunities: [], windows: [], proposals: [], proposalWindows: [], reviews: [], factors: [], activities: [], notes: [], agreements: []};
const STAGES = ['lead', 'proposal', 'negotiation', 'won', 'lost'];

export function registerSalesProposalRoutes(app, {db, bad, body, permittedProjects}) {
  // 財務（営業）権限のある作品だけ
  async function scopedWorks(i) {
    const projects = new Set((await permittedProjects(db, i, true)).map((project) => project.id));
    return (await readWorks(db, i.org_id)).filter((work) => projects.has(work.project_id));
  }
  async function readAll(i, works) {
    return {works, ...(works.length ? await readSalesScope(db, i.org_id, works.map((work) => work.id)) : EMPTY)};
  }
  async function opportunityInScope(i, opportunityId) {
    const opportunity = await readOpportunity(db, i.org_id, opportunityId);
    if (!opportunity) return null;
    return (await scopedWorks(i)).some((work) => work.id === opportunity.work_id) ? opportunity : false;
  }
  const forbidden = (c, i) => (i.role === 'production' ? bad(c, '制作担当は営業の提案を参照・記録できません', 403) : null);

  app.get('/api/sales-launch-month', async (c) => {
    const i = c.get('identity');
    const denied = forbidden(c, i);
    if (denied) return denied;
    let month;
    let asOf;
    try {
      asOf = isoDate(String(c.req.query('asOf') || todayJst()));
      month = normalizeMonth(c.req.query('month'), asOf.slice(0, 7));
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
    return c.json({ok: true, ...buildLaunchMonth({month, asOf, ...await readAll(i, await scopedWorks(i))})});
  });

  async function proposalView(c, i) {
    const data = await readAll(i, await scopedWorks(i));
    const partnerId = c.req.query('partnerId') ? Number(c.req.query('partnerId')) : null;
    const workId = c.req.query('workId') ? Number(c.req.query('workId')) : null;
    const opportunities = data.opportunities.filter((row) => (!partnerId || row.partner_id === partnerId) && (!workId || row.work_id === workId));
    const keep = new Set(opportunities.map((row) => row.id));
    const built = buildProposalReview({...data, proposals: data.proposals.filter((row) => keep.has(row.opportunity_id))});
    return {data, opportunities, built};
  }

  app.get('/api/sales-proposals', async (c) => {
    const i = c.get('identity');
    const denied = forbidden(c, i);
    if (denied) return denied;
    const {data, opportunities, built} = await proposalView(c, i);
    const keep = new Set(opportunities.map((row) => row.id));
    return c.json({
      ok: true, ...built,
      partners: (await readPartners(db, i.org_id)).map(({id, code, name, kind}) => ({id, code, name, kind})),
      works: data.works.map(({id, code, title}) => ({id, code, title})),
      opportunities: opportunities.map(({id, work_id: workId, partner_id: partnerId, name, stage, partner_name: partnerName}) => ({id, workId, partnerId, name, stage, partnerName})),
      windows: data.windows.map((row) => ({windowId: row.window_id, workId: row.work_id, typeLabel: row.type_label, startOn: row.start_on, status: row.status})),
      agreements: data.agreements.map((row) => ({id: row.id, opportunityId: row.opportunity_id, contractCode: row.contract_code, title: row.title})),
      activities: data.activities.filter((row) => keep.has(row.opportunity_id)).map((row) => ({id: row.id, opportunityId: row.opportunity_id, occurredOn: row.occurred_on, activityType: row.activity_type, summary: row.summary, result: row.result,
        notes: data.notes.filter((note) => note.activity_id === row.id).map((note) => ({id: note.id, noteKind: note.note_kind, body: note.body, tone: note.tone}))})),
    });
  });

  app.get('/api/sales-proposals/export.csv', async (c) => {
    const i = c.get('identity');
    const denied = forbidden(c, i);
    if (denied) return denied;
    const {built} = await proposalView(c, i);
    return new Response(proposalCsv(built.rows), {headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('提案の振り返り.csv')}`}});
  });

  app.post('/api/sales-opportunities', async (c) => {
    const i = c.get('identity');
    const denied = forbidden(c, i);
    if (denied) return denied;
    const raw = await body(c);
    const input = {
      workId: Number(raw.workId), partnerId: Number(raw.partnerId), name: raw.name == null ? '' : String(raw.name).trim(), stage: String(raw.stage || 'lead'),
      expectedYen: raw.expectedYen == null || raw.expectedYen === '' ? null : Number(String(raw.expectedYen).replace(/[,，円\s]/g, '')),
      closeDate: raw.closeDate ? String(raw.closeDate) : null,
    };
    if (!Number.isInteger(input.workId) || input.workId <= 0) return bad(c, '作品を選んでください', 400);
    if (!Number.isInteger(input.partnerId) || input.partnerId <= 0) return bad(c, '取引先を選んでください', 400);
    if (!input.name || input.name.length > 200) return bad(c, '営業案件の名前を200文字以内で入れてください', 400);
    if (!STAGES.includes(input.stage)) return bad(c, '段階を選んでください', 400);
    if (input.expectedYen != null && (!Number.isInteger(input.expectedYen) || input.expectedYen < 0)) return bad(c, '見込額は0以上の整数（円）で入れてください', 400);
    try {
      if (input.closeDate) isoDate(input.closeDate);
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
    const work = (await scopedWorks(i)).find((row) => row.id === input.workId);
    if (!work) return bad(c, 'この作品の営業を記録する権限がありません', 403);
    if (!await readPartner(db, i.org_id, input.partnerId)) return bad(c, '取引先が見つかりません', 404);
    const id = await insertOpportunity(db, {orgId: i.org_id, userId: i.user_id, work, input});
    return c.json({ok: true, opportunityId: id}, 201);
  });

  app.post('/api/sales-proposals', async (c) => {
    const i = c.get('identity');
    const denied = forbidden(c, i);
    if (denied) return denied;
    let input;
    try {
      input = normalizeProposalInput(await body(c));
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
    const opportunity = await opportunityInScope(i, input.opportunityId);
    if (opportunity === null) return bad(c, '営業案件が見つかりません', 404);
    if (!opportunity) return bad(c, 'この作品の営業を記録する権限がありません', 403);
    if (input.windowIds.length && (await readOwnedWindows(db, i.org_id, opportunity.work_id, input.windowIds)).length !== input.windowIds.length) {
      return bad(c, '営業案件の作品に無いウィンドウが含まれています', 409);
    }
    if (input.materialSnapshotId && !await readSnapshotOf(db, i.org_id, input.materialSnapshotId, opportunity.id)) return bad(c, 'この営業案件の営業資料の版ではありません', 409);
    const id = await insertProposal(db, {orgId: i.org_id, userId: i.user_id, opportunityId: opportunity.id, input});
    return c.json({ok: true, proposalId: id}, 201);
  });

  app.post('/api/sales-proposals/:proposalId/reviews', async (c) => {
    const i = c.get('identity');
    const denied = forbidden(c, i);
    if (denied) return denied;
    let input;
    const proposalId = Number(c.req.param('proposalId'));
    try {
      if (!Number.isInteger(proposalId) || proposalId <= 0) throw new Error('提案を選んでください');
      input = normalizeReviewInput(await body(c));
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
    const proposal = await readProposal(db, i.org_id, proposalId);
    if (!proposal) return bad(c, '提案が見つかりません', 404);
    if (!await opportunityInScope(i, proposal.opportunity_id)) return bad(c, 'この作品の営業を記録する権限がありません', 403);
    if (input.reviewedOn < proposal.proposed_on) return bad(c, '評価した日は提案日より後にしてください', 400);
    if (input.agreementId && !await readAgreementOf(db, i.org_id, input.agreementId, proposal.opportunity_id)) return bad(c, 'この営業案件の契約ではありません', 409);
    const id = await insertReview(db, {orgId: i.org_id, userId: i.user_id, proposalId, input});
    return c.json({ok: true, reviewId: id}, 201);
  });

  app.post('/api/sales-activity-notes', async (c) => {
    const i = c.get('identity');
    const denied = forbidden(c, i);
    if (denied) return denied;
    let input;
    try {
      input = normalizeNoteInput(await body(c));
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
    const activity = await readActivity(db, i.org_id, input.activityId);
    if (!activity) return bad(c, '営業活動が見つかりません', 404);
    if (!await opportunityInScope(i, activity.opportunity_id)) return bad(c, 'この作品の営業を記録する権限がありません', 403);
    const id = await insertNote(db, {orgId: i.org_id, userId: i.user_id, input});
    return c.json({ok: true, noteId: id}, 201);
  });
}
