// 稟議の受け口（行動指標の計画 段B #4。K2-17。要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-038・039）。
//   GET  /api/planning/investment-approvals[?from=YYYY-MM&to=YYYY-MM]  見てよい自社出資の案件ごとの稟議（版の全部・いまの状態・出資枠）と、
//        出資と回収（出資額＝稟議の払込の累計、収益＝入金の基準の確定の売上の累計、差額・回収率。締めた月まで）。from・to は期間の列
//   POST /api/planning/projects/:projectId/investment-approvals                     新しい稟議（版1の申請）
//   POST /api/planning/projects/:projectId/investment-approvals/:approvalNo/versions  稟議に版を1つ足す（申請し直し・承認・却下・払込）
// - 権限: 制作担当は 403。財務の権限がある案件（管理者は組織の全案件、編集担当は所属が edit の案件）だけ。権限の無い案件と別の組織の案件は
//   有無を見せず同じ 403。稼ぎ方が自社出資でない案件に稟議を足そうとしたら 409
// - 申請と承認は同じ人でよい（J-10 (a)。investment-approval-model の APPROVAL_POLICY）。版の記録した人・日時と、承認・却下が申請した人と同じかを返す。
//   版を足すと同じ batch で audit_log に1行残る（額は残さない）
// - 回収額は会社への利益額（フェーズ1 #14b）の入金を案件に結ぶ規則で出す（readProfitSources と buildCompanyProfit の入金の基準。ここで入金を読み直さない）。
//   締めた月は予実の月の設定（移行 0018 の closed_month）の最新の版。無ければ全期間
// Worker でも動くよう node:* を import しない
import {addInvestmentApprovalVersion, readInvestmentApprovals, readProjectClassifications, readProjectInvestmentApprovals} from '../planning-store.mjs';
import {readProfitSources} from '../../accounting/accounting-store.mjs';
import {readEffectiveChoices} from '../../revenue/revenue-store.mjs';
import {buildCompanyProfit, profitRecordsFromSources} from '../../accounting/profit/profit-model.mjs';
import {ownInvestmentSource} from '../../accounting/profit/own-investment-source-model.mjs';
import {parseProfitPeriod} from '../../accounting/profit/profit-routes.mjs';
import {APPROVAL_POLICY, nextApprovalNo, normalizeApprovalStep, normalizeNewApproval, summarizeApprovals} from './investment-approval-model.mjs';
import {isDbConflict} from '../../data-platform/db-errors.mjs';

const NO_ACCESS = 'この案件の稟議への権限がありません';
const positiveId = (raw) => (/^\d+$/.test(raw ?? '') && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null);

export function registerInvestmentApprovalRoutes(app, {db, bad, body, permittedProjects, permittedProjectScope, sha256, canonical}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function'
    || typeof permittedProjectScope !== 'function' || typeof sha256 !== 'function' || typeof canonical !== 'function') {
    throw new Error('investment approval routes require app, db, bad, body, permittedProjects, permittedProjectScope, sha256 and canonical');
  }

  // 財務の権限のある、稼ぎ方が自社出資の案件だけを通す
  async function ownInvestmentProject(c) {
    const identity = c.get('identity');
    const projectId = positiveId(c.req.param('projectId'));
    if (projectId === null) return {error: bad(c, '案件の番号を確かめてください', 400)};
    const allowed = identity.role === 'production' ? [] : (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
    if (!allowed.includes(projectId)) return {error: bad(c, NO_ACCESS, 403)};
    const [project] = await readProjectClassifications(db, identity.org_id, [projectId]);
    if (!project) return {error: bad(c, NO_ACCESS, 403)};
    if (project.earning_type !== 'own_investment') return {error: bad(c, '稼ぎ方が自社出資の案件ではありません（稟議は自社出資の案件だけに持ちます）', 409)};
    return {identity, project, projectId};
  }

  async function append(c, {identity, projectId}, version) {
    try {
      await addInvestmentApprovalVersion(db, identity.org_id, projectId, version, {createdBy: identity.user_id});
      return null;
    } catch (error) {
      // 版の番号の取り合いに負けた書き込み（トリガーの stale・主キーの一意の違反）と、読んだあとに状態が変わって流れ・額のトリガーが断った書き込み
      if (isDbConflict(error)) return bad(c, 'ほかの画面で稟議の版が足されました。読み直してから入れてください', 409, undefined, error);
      throw error;
    }
  }

  app.get('/api/planning/investment-approvals', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '稟議は財務の画面です（制作担当は見られません）', 403);
    const period = parseProfitPeriod(c.req.query('from'), c.req.query('to'));
    if (!period.ok) return bad(c, period.error, 400, {field: period.field});
    const scope = permittedProjectScope(identity, true);
    const choices = await readEffectiveChoices(db, identity.org_id);
    const closedMonth = choices.closedMonth ? String(choices.closedMonth.value).slice(0, 7) : null;
    const {projects, versions} = await readInvestmentApprovals(db, identity.org_id, {scope});
    const sources = await readProfitSources(db, identity.org_id, {scope, to: closedMonth});
    if (identity.role !== 'admin' && !sources.projectRows.length) return bad(c, '財務の権限がある案件がありません', 403);
    const records = profitRecordsFromSources(sources);
    const cumulative = buildCompanyProfit(records, {basis: 'cash', to: closedMonth, includeCompany: false});
    const hasPeriod = period.from !== null || period.to !== null;
    // 期間の列は期間の中で締めた月まで（締めていない月の入金は実績に入れない）
    const periodTo = closedMonth !== null && (period.to === null || period.to > closedMonth) ? closedMonth : period.to;
    const periodView = hasPeriod ? buildCompanyProfit(records, {basis: 'cash', from: period.from, to: periodTo, includeCompany: false}) : null;
    const view = ownInvestmentSource({projects, versions, cumulative, periodView}, {closedMonth, period: hasPeriod ? {from: period.from, to: period.to} : null});
    const out = {
      ...view, policy: APPROVAL_POLICY,
      revenueBasis: {basis: cumulative.basis, basisLabel: cumulative.basisLabel, taxLabel: cumulative.taxLabel,
        note: '収益は会社への利益額の入金の基準の確定の売上（入金×売上率。税別）。請求額と違う入金・売上率の決まらない案件の売上は未確定で、その案件は差額と回収率を出さない'},
    };
    const sourceHash = await sha256(canonical(out));
    return c.json({ok: true, ...out, sourceHash});
  });

  app.post('/api/planning/projects/:projectId/investment-approvals', async (c) => {
    const found = await ownInvestmentProject(c);
    if (found.error) return found.error;
    const rows = await readProjectInvestmentApprovals(db, found.identity.org_id, found.projectId);
    const input = normalizeNewApproval(await body(c), {nextNo: nextApprovalNo(rows)});
    if (!input.ok) return bad(c, '稟議の申請の入力を確かめてください', input.status, input.errors);
    const failed = await append(c, found, input.value);
    if (failed) return failed;
    return c.json({ok: true, projectId: found.projectId, approvalNo: input.value.approvalNo, versionNo: 1, status: 'applied'}, 201);
  });

  app.post('/api/planning/projects/:projectId/investment-approvals/:approvalNo/versions', async (c) => {
    const found = await ownInvestmentProject(c);
    if (found.error) return found.error;
    const approvalNo = positiveId(c.req.param('approvalNo'));
    if (approvalNo === null) return bad(c, '稟議の番号を確かめてください', 400);
    const rows = await readProjectInvestmentApprovals(db, found.identity.org_id, found.projectId);
    const approval = summarizeApprovals(rows).find((a) => a.approvalNo === approvalNo);
    if (!approval) return bad(c, 'この案件にその番号の稟議はありません', 404);
    const input = normalizeApprovalStep(await body(c), {approval, actorUserId: found.identity.user_id});
    if (!input.ok) return bad(c, input.status === 409 ? input.errors[0].message : '稟議の版の入力を確かめてください', input.status, input.errors);
    const failed = await append(c, found, input.value);
    if (failed) return failed;
    const {versionNo, status, amountYen} = input.value;
    const decision = status === 'approved' || status === 'rejected';
    return c.json({ok: true, projectId: found.projectId, approvalNo, versionNo, status, amountYen,
      sameAsApplicant: decision ? found.identity.user_id === approval.applicantUserId : null}, 201);
  });
}
