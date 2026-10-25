// 制作費の版の受け口（フェーズ1の仕様書 #5。要件 docs/requirements/expenses/production-cost.md の FR-EXP-PCOST-001〜005・008・039）。
// 作品の版の一覧と状態（3値）を返し、最初の版を「出資額から作る」と「契約書から入れる」の2つの入口で足す（追加の版の入口はまだ無い）。
// 読めるのは作品の財務の権限のある人（管理者と、作品の案件の編集の権限を持つ編集担当）。登録できるのは管理者と、その作品にプロデューサーの
// 役目を持つ人（役割と役目の両方を確かめる。FR-EXP-PCOST-008）。作品ごとの役目の表（docs/requirements/production/schedule-commit.md の
// FR-PROD-SCHED-062）はまだ無いので、いまはプロデューサーの役目を確かめられず、管理者だけが登録できる。制作担当には読ませない。
// 権限の無い作品と別の組織の作品は、有無を見せず同じ 403 にする。版を足すと同じ batch で audit_log に1行残る（金額は残さない）
import {addProductionCostVersion, noInvestmentRecordGuard, readInvestmentRecords, readPartner, readProductionCostVersions, readWork} from '../expenses-store.mjs';
import {INVESTMENT_SOURCE_MESSAGES, investmentSource, normalizeContractVersionInput, normalizeInvestmentVersionInput, productionCostAccess,
  productionCostStatus, productionCostVersionView} from './production-cost-model.mjs';
import {dbErrorKind, isGuardViolation, isUniqueViolation} from '../../data-platform/db-errors.mjs';

const STALE = 'stale production cost version';
const STALE_MESSAGE = 'ほかの画面で制作費の版が足されました。読み直してください';
// 版の番号の取り合いに負けた書き込み。SQLite・D1 は書き込みが直列なので版の番号のトリガー（production_cost_versions_sequence）が stale の文で断り、
// PostgreSQL で同じ作品の版を同時に足すと、両方のトリガーが番号の判定を通ったあと、主キー（組織・作品・版の番号）の一意の違反で後の側が落ちる。どちらも同じ 409 にする
const lostVersionRace = (error) => (dbErrorKind(error) === 'raise' && error.message.includes(STALE)) || isUniqueViolation(error, 'production_cost_versions');
// 出資額の照合のトリガー（移行 0016 の production_cost_versions_own_investment・_committee_investment）の文。読んだあとに出資の記録が変わると断る
// （文がトリガーと食い違うと 409 の言い換えが消えるので、test/production-cost.test.mjs が受け口に割り込んで両方の文を確かめる）
const INVESTMENT_CHANGED = /must match the latest (confirmed own|committee) investment/;
const FORBIDDEN = 'この作品の制作費の版への権限がありません';
const NOT_REGISTRAR = '制作費の版を登録できるのは、管理者と、この作品にプロデューサーの役目を持つ人です';

export function registerProductionCostRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('production cost routes require app, db, bad, body and permittedProjects');
  }

  async function workAccess(c) {
    const identity = c.get('identity');
    const raw = c.req.param('workId');
    const workId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(workId) || workId <= 0) return {error: bad(c, '作品の番号を確かめてください', 400)};
    const work = await readWork(db, identity.org_id, workId);
    const financeProjects = identity.role === 'production' ? [] : (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
    // 作品ごとの役目の表（FR-PROD-SCHED-062）が入ったら、その人がこの作品に持つ役目をここで読む
    const workRoles = [];
    const access = productionCostAccess({role: identity.role, financeProject: Boolean(work) && financeProjects.includes(Number(work.project_id)), workRoles});
    if (!work || !access.read) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, work: {...work, id: Number(work.id)}, access};
  }

  async function readBody(c) {
    try {
      const input = await body(c);
      return {input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }

  // 版の一覧・最新の版・状態（registered・tax_unknown・unregistered）と、出資の記録から最初の版を作れるか
  app.get('/api/expenses/works/:workId/production-cost', async (c) => {
    const found = await workAccess(c);
    if (found.error) return found.error;
    const {identity, work, access} = found;
    const [rows, records] = await Promise.all([readProductionCostVersions(db, identity.org_id, work.id), readInvestmentRecords(db, identity.org_id, work.id)]);
    const versions = rows.map(productionCostVersionView);
    const latest = versions.at(-1) ?? null;
    const source = investmentSource(records);
    return c.json({
      ok: true, workId: work.id, workCode: work.code, status: productionCostStatus(latest), latest, versions,
      investment: source.ok
        ? {ready: true, hasRecord: true, kind: source.kind, amountYen: source.amountYen, taxBasis: source.taxBasis}
        : {ready: false, hasRecord: source.hasRecord, reason: source.reason, message: INVESTMENT_SOURCE_MESSAGES[source.reason]},
      canRegister: access.register,
      registrable: {fromInvestment: access.register && !latest && source.ok, fromContract: access.register && !latest && !source.hasRecord},
    });
  });

  // 出資額から最初の版を作る（FR-EXP-PCOST-002・003）。額は出資の記録から読み、本文で受けない。本文は内訳（breakdown）とメモ（note）だけ
  app.post('/api/expenses/works/:workId/production-cost/from-investment', async (c) => {
    const found = await workAccess(c);
    if (found.error) return found.error;
    const {identity, work, access} = found;
    if (!access.register) return bad(c, NOT_REGISTRAR, 403);
    const read = await readBody(c);
    if (read.error) return read.error;
    if ((await readProductionCostVersions(db, identity.org_id, work.id)).length) return bad(c, '最初の制作費の版はもうあります（版を足すのは追加の契約からです）', 409);
    const source = investmentSource(await readInvestmentRecords(db, identity.org_id, work.id));
    if (!source.ok) return bad(c, INVESTMENT_SOURCE_MESSAGES[source.reason], 409, {reason: source.reason});
    const n = normalizeInvestmentVersionInput(read.input, source);
    if (!n.ok) return bad(c, '制作費の版の入力を確かめてください', 400, n.errors);
    try {
      const versionNo = await addProductionCostVersion(db, identity.org_id, work.id, n.value, {createdBy: identity.user_id});
      return c.json({ok: true, workId: work.id, versionNo, sourceKind: n.value.sourceKind, investmentKind: source.kind, amountYen: n.value.amountYen,
        taxBasis: n.value.taxBasis, status: productionCostStatus(n.value)}, 201);
    } catch (error) {
      if (lostVersionRace(error)) return bad(c, STALE_MESSAGE, 409, undefined, error);
      if (dbErrorKind(error) === 'raise' && INVESTMENT_CHANGED.test(error.message)) return bad(c, '出資の記録が読んだあとに変わりました。読み直してください', 409, undefined, error);
      throw error;
    }
  });

  // 契約書から最初の版を入れる（出資の記録が無い作品だけ。FR-EXP-PCOST-039・023）。出資の記録がある作品は断る
  app.post('/api/expenses/works/:workId/production-cost/from-contract', async (c) => {
    const found = await workAccess(c);
    if (found.error) return found.error;
    const {identity, work, access} = found;
    if (!access.register) return bad(c, NOT_REGISTRAR, 403);
    const read = await readBody(c);
    if (read.error) return read.error;
    if ((await readProductionCostVersions(db, identity.org_id, work.id)).length) return bad(c, '最初の制作費の版はもうあります（版を足すのは追加の契約からです）', 409);
    const source = investmentSource(await readInvestmentRecords(db, identity.org_id, work.id));
    if (source.hasRecord) return bad(c, '出資の記録がある作品は、出資額から制作費の版を作ります（契約書からは入れられません）', 409, {reason: 'investment_recorded'});
    const n = normalizeContractVersionInput(read.input);
    if (!n.ok) return bad(c, '制作費の版の入力を確かめてください', 400, n.errors);
    if (!await readPartner(db, identity.org_id, n.value.contract.counterpartyPartnerId)) {
      return bad(c, '制作費の版の入力を確かめてください', 400, [{field: 'counterpartyPartnerId', message: '契約の相手を組織の取引先から選んでください'}]);
    }
    try {
      const versionNo = await addProductionCostVersion(db, identity.org_id, work.id, n.value,
        {createdBy: identity.user_id, guards: [noInvestmentRecordGuard(identity.org_id, work.id)]});
      return c.json({ok: true, workId: work.id, versionNo, sourceKind: n.value.sourceKind, amountYen: n.value.amountYen, taxBasis: n.value.taxBasis,
        status: productionCostStatus(n.value)}, 201);
    } catch (error) {
      if (lostVersionRace(error)) return bad(c, STALE_MESSAGE, 409, undefined, error);
      if (isGuardViolation(error)) return bad(c, '出資の記録が読んだあとに入りました。出資額から制作費の版を作ってください', 409, {reason: 'investment_recorded'}, error);
      throw error;
    }
  });
}
