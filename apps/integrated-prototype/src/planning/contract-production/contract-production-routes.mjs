// 受託制作の契約の版の受け口（フェーズ1の仕様書 #10b。要件 FR-REV-CWORK-035）。型「受託制作」の案件に、総製作費・受託費率・支払いの節目の
// 版を足し（追記だけ）、版の一覧と節目ごとの制作費・受託費を返す。総製作費と受託費は財務の値なので、財務の権限のある案件（管理者か、
// 案件の編集の権限）だけに読ませ・書かせ、制作担当には返さない（既存の案件の API が budget_yen を伏せるのと同じ線）。
// 受託費率を入れる画面は行動指標の計画 #3（案件の編集の1項目）の ContractProductionPanel.jsx（同じフォルダ）で、ここは受け口だけ。版を足すと、同じ batch で audit_log に1行残る
// （store の contractVersionStatements。金額は残さない）
import {addContractVersion, readContractVersions, readProjectClassifications} from '../planning-store.mjs';
import {contractVersionComplete, milestoneAmounts, normalizeContractVersionInput} from './contract-production-model.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';

const STALE = 'stale contract production version';
// 版の番号の取り合いに負けた書き込み。SQLite・D1 は書き込みが直列なので版の番号のトリガーが stale の文で断り、PostgreSQL で同じ案件の版を
// 同時に足すと、両方のトリガーが番号の判定を通ったあと、主キー（組織・案件・版の番号）の一意の違反で後の側が落ちる。どちらも同じ 409 にする
const lostVersionRace = (error) => (dbErrorKind(error) === 'raise' && error.message.includes(STALE)) || isUniqueViolation(error, 'contract_production_versions');

export function registerContractProductionRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('contract production routes require app, db, bad, body and permittedProjects');
  }

  // 財務の権限のある、型「受託制作」の案件だけを通す。権限の無い案件と別の組織の案件は、有無を見せず同じ 403 にする
  async function contractProject(c) {
    const identity = c.get('identity');
    const raw = c.req.param('projectId');
    const projectId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(projectId) || projectId <= 0) return {error: bad(c, '案件の番号を確かめてください', 400)};
    const allowed = identity.role === 'production' ? [] : (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
    if (!allowed.includes(projectId)) return {error: bad(c, 'この案件の契約の版への権限がありません', 403)};
    const [project] = await readProjectClassifications(db, identity.org_id, [projectId]);
    if (!project) return {error: bad(c, 'この案件の契約の版への権限がありません', 403)};
    if (project.project_type !== 'contract_production') return {error: bad(c, '受託制作の案件ではありません（契約の版は型「受託制作」の案件だけに持ちます）', 409)};
    return {identity, project};
  }

  app.get('/api/planning/projects/:projectId/contract-versions', async (c) => {
    const found = await contractProject(c);
    if (found.error) return found.error;
    const {identity, project} = found;
    const {versions, milestones} = await readContractVersions(db, identity.org_id, Number(project.id));
    const rows = versions.map((v) => {
      const own = milestones.filter((m) => Number(m.version_no) === Number(v.version_no));
      const summary = {...v, recorded_milestones: own.length, share_total_bps: own.reduce((total, m) => total + Number(m.share_bps), 0)};
      const complete = contractVersionComplete(summary);
      const amounts = complete ? new Map(milestoneAmounts({budgetYen: Number(v.budget_yen), feeYen: Number(v.fee_yen), milestones: own}).map((a) => [a.seq, a])) : new Map();
      return {
        versionNo: Number(v.version_no), budgetYen: Number(v.budget_yen), markupBps: Number(v.markup_bps), feeYen: Number(v.fee_yen),
        milestoneCount: Number(v.milestone_count), complete, contractReference: v.contract_reference, note: v.note, createdBy: Number(v.created_by), createdAt: v.created_at,
        milestones: own.map((m) => ({seq: Number(m.seq), dueOn: m.due_on, shareBps: Number(m.share_bps),
          budgetYen: amounts.get(Number(m.seq))?.budgetYen ?? null, feeYen: amounts.get(Number(m.seq))?.feeYen ?? null})),
      };
    });
    const latest = rows.at(-1) ?? null;
    return c.json({ok: true, projectId: Number(project.id), projectCode: project.code, latestVersionNo: latest?.versionNo ?? null, versions: rows});
  });

  app.post('/api/planning/projects/:projectId/contract-versions', async (c) => {
    const found = await contractProject(c);
    if (found.error) return found.error;
    const {identity, project} = found;
    const input = normalizeContractVersionInput(await body(c));
    if (!input.ok) return bad(c, '契約の版の入力を確かめてください', 400, input.errors);
    try {
      const versionNo = await addContractVersion(db, identity.org_id, Number(project.id), input.value, {createdBy: identity.user_id});
      return c.json({ok: true, projectId: Number(project.id), versionNo, budgetYen: input.value.budgetYen, markupBps: input.value.markupBps, feeYen: input.value.feeYen}, 201);
    } catch (error) {
      if (lostVersionRace(error)) return bad(c, 'ほかの画面で契約の版が足されました。読み直してから入れてください', 409, undefined, error);
      throw error;
    }
  });
}
