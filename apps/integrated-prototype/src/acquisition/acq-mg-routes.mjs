// 支払う MG（買付分）の受け口。表と SQL は acq-mg-store.mjs、回収の計算は acq-mg-recoup.mjs。
// 計画は会社ルートの plans/2026-10-22-folder-mg-buy.md（香盤表 #3・#5）、要件は docs/requirements/planning/rights-acquisition.md。
// 権限は /api/mg/* と同じ: 制作担当は 403、対象の作品すべての財務権限（settlementWork）が要る。組織は identity の org_id だけを使う。
// この区切りでやること: 契約と条件版の登録・版の追加・一覧と1契約の中身（回収の値は売上明細から毎回計算）・売上報告の結び付け（自動と人）。
// 締め月の分配報告書の下書き（問い4 A。締め月を指して見る）・発行・取消・作り直しの照合（FR-PLAN-ACQ-017）。本体は acq-mg-statement-model.mjs。
// 支払の記録（MG の前払・超過の分配額。移行 0027 の acq_mg_payments）と取消。集計は acq-mg-payment-model.mjs。
// まだやらないこと: 原本（acq_mg_documents）・会計の仕訳（約束 F-2。postJournal が core に入ったら発行と支払の batch でつなぐ）・古い入口を閉じること。
import {isDbConflict, isUniqueViolation} from '../data-platform/db-errors.mjs';
import {newMgId} from '../mg.mjs';
import {computeRecoup, normalizeTerm} from './acq-mg-recoup.mjs';
import * as store from './acq-mg-store.mjs';
import {todayJst} from '../billing/receipt-model.mjs';
import {buildStatementBody, previousFromRow, statementGate} from './acq-mg-statement-model.mjs';
import {readPaymentInput, summarizePayments} from './acq-mg-payment-model.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const text = (v, name, max) => { const s = String(v ?? '').trim(); if (!s || s.length > max) throw fail(`${name}は1〜${max}文字で入力してください`); return s; };
const id = (v, name = 'ID') => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) throw fail(`${name}を確認してください`); return n; };
const date = (v, name) => { const s = String(v ?? ''); if (!ISO.test(s)) throw fail(`${name}は YYYY-MM-DD で入力してください`); return s; };
// 日付と月は日本時間（UTC のままだと、朝9時まで前の日になる）
const today = () => todayJst();
const thisMonth = () => todayJst().slice(0, 7);
const asOfOf = (c) => { const m = c.req.query('asOf') || thisMonth(); if (!MONTH.test(m)) throw fail('締め月は YYYY-MM です'); return m; };

// 画面の入力を、DB の列と計算の条件の両方に使える形にする。計算の条件の確かめは normalizeTerm と同じ決まりに任せる
export function readTermInput(x) {
  const works = (Array.isArray(x.works) ? x.works : []).map((w) => ({workId: id(w.workId, '作品'), presetAmount: w.presetAmount == null || w.presetAmount === '' ? null : Number(w.presetAmount)}));
  const term = {
    consideration: String(x.consideration ?? 'mg'), currency: String(x.currency ?? 'JPY'), mgAmount: Number(x.mgAmount),
    recoupBasis: String(x.recoupBasis ?? 'platform_net'), platformRateBps: Number(x.platformRateBps ?? 0),
    agencyFeeBps: x.agencyFeeBps == null || x.agencyFeeBps === '' ? null : Number(x.agencyFeeBps),
    overageEnabled: x.overageEnabled === null || x.overageEnabled === undefined || x.overageEnabled === '' ? null : x.overageEnabled === true || x.overageEnabled === 1 || x.overageEnabled === '1',
    overageRateBps: x.overageRateBps == null || x.overageRateBps === '' ? undefined : Number(x.overageRateBps),
    pooling: String(x.pooling ?? 'all_media'), shortfallFromOtherMedia: x.shortfallFromOtherMedia === true,
    mediaAllocations: Array.isArray(x.mediaAllocations) ? x.mediaAllocations.map((m) => ({media: String(m.media), amount: Number(m.amount)})) : [],
    multiWork: String(x.multiWork ?? (works.length > 1 ? 'actual' : 'single')), holdAgreementRef: x.holdAgreementRef ?? null,
    works: works.map((w) => ({workId: String(w.workId), presetAmount: w.presetAmount})),
    deductions: Array.isArray(x.deductions) ? x.deductions.map((d) => ({category: String(d.category), capAmount: d.capAmount ?? null, capBps: d.capBps ?? null, sourceRef: d.sourceRef})) : [],
    paymentSchedule: Array.isArray(x.paymentSchedule) ? x.paymentSchedule.map((p, index) => ({installment: index + 1, trigger: String(p.trigger), dueOn: p.dueOn || null, amount: Number(p.amount)})) : [],
  };
  let normalized;
  try { normalized = normalizeTerm(term); } catch (e) { throw fail(e.message); }
  const startsOn = date(x.startsOn, '契約開始日'), endsOn = date(x.endsOn, '契約終了日');
  if (endsOn < startsOn) throw fail('契約終了日は開始日以降にしてください');
  for (const d of term.deductions) text(d.sourceRef, '費目の根拠（契約の条項）', 200);
  for (const p of term.paymentSchedule) {
    if (!['signing', 'delivery', 'release', 'date'].includes(p.trigger)) throw fail('支払のきっかけは署名・納品・公開・日付から選んでください');
    if (p.trigger === 'date' && !p.dueOn) throw fail('日付で払う回は予定日が要ります');
    if (p.dueOn) date(p.dueOn, '支払の予定日');
  }
  const phases = (Array.isArray(x.phases) ? x.phases : []).map((p, index) => ({
    order: index + 1, startsMonth: String(p.startsMonth), endsMonth: p.endsMonth || null, cycleKind: String(p.cycleKind ?? 'quarterly'),
    anchorMonth: p.anchorMonth == null || p.anchorMonth === '' ? null : Number(p.anchorMonth), reportOffsetMonths: Number(p.reportOffsetMonths ?? 1),
    reportDay: p.reportDay == null || p.reportDay === '' ? null : Number(p.reportDay), paymentOffsetMonths: Number(p.paymentOffsetMonths ?? 1),
    paymentDay: p.paymentDay == null || p.paymentDay === '' ? null : Number(p.paymentDay),
  }));
  for (const p of phases) if (!MONTH.test(p.startsMonth) || (p.endsMonth && !MONTH.test(p.endsMonth))) throw fail('周期の月は YYYY-MM で入力してください');
  return {term, normalized, startsOn, endsOn, phases, reason: text(x.reason, '登録の理由', 500)};
}

// 一覧の1行に出す数字だけ（問い2 A の重要な数字）
function summarize(r) {
  const failed = r.checks.filter((x) => !x.ok).length;
  return {status: r.status, base: r.base, recouped: r.recouped, balance: r.balance, overage: r.overage, distribution: r.distribution,
    exceptionCount: r.exceptions.length, checksPassed: r.checks.length - failed, checksTotal: r.checks.length, statementAllowed: r.statementAllowed};
}

export function registerAcqMgRoutes(app, {db, bad, body, settlementWork, settlementSource, canonical, sha256}) {
  const routeError = (c, e) => bad(c, e.message, e.status || (isDbConflict(e) ? 409 : 400), undefined, e);
  app.use('/api/acq-mg/*', async (c, next) => {
    if (c.get('identity')?.role === 'production') return bad(c, '制作担当は支払う MG を参照できません', 403);
    await next();
  });

  // 対象の作品すべての財務権限が無ければ断る（作品を1つでも見られない契約は、一覧にも出さない）
  async function requireWorks(i, workIds) {
    for (const workId of new Set(workIds)) if (!await settlementWork(i, Number(workId))) throw fail('対象の作品の財務権限がありません', 403);
  }

  // 1契約の回収（最新の条件版と、その版へ include で結んだ報告の、作品へ配った売上明細）
  async function contractRecoup(i, contract, asOfMonth) {
    const versionId = await store.latestVersionId(db, i.org_id, contract.id);
    if (!versionId) return null;
    const version = await store.loadVersion(db, i.org_id, versionId);
    await requireWorks(i, version.works.map((w) => w.work_id));
    const links = await store.liveLinks(db, i.org_id, [versionId]);
    const include = links.filter((l) => l.decision === 'include');
    const lines = [];
    for (const workId of new Set(include.map((l) => l.work_id))) {
      const source = await settlementSource(i, workId);
      const reportBasis = new Map(include.filter((l) => l.work_id === workId).map((l) => [l.report_id, l.report_basis]));
      for (const part of source.parts) {
        if (!reportBasis.has(part.report_id)) continue;
        lines.push({saleId: `${part.id}:${workId}`, workId: String(workId), media: null, accountingMonth: part.accounting_month,
          amountExTax: part.allocated_amount_ex_tax, reportBasis: reportBasis.get(part.report_id)});
      }
    }
    return {version, links, recoup: computeRecoup({term: version.term, lines, expenses: [], asOfMonth})};
  }

  app.get('/api/acq-mg/contracts', async (c) => {
    try {
      const i = c.get('identity'), asOfMonth = asOfOf(c);
      const rows = [];
      for (const k of await store.listContracts(db, i.org_id)) {
        let result;
        try { result = await contractRecoup(i, k, asOfMonth); } catch (e) { if (e.status === 403) continue; throw e; }
        rows.push({id: k.id, code: k.code, title: k.title, partnerName: k.partner_name, versionNo: result?.version.row.version_no ?? null, termVersionId: result?.version.row.id ?? null,
          consideration: result?.version.row.consideration ?? null, mgAmount: result?.version.row.mg_amount ?? null,
          workIds: result?.version.works.map((w) => w.work_id) ?? [], recoup: result ? summarize(result.recoup) : null});
      }
      return c.json({ok: true, asOfMonth, contracts: rows});
    } catch (e) { return routeError(c, e); }
  });

  app.get('/api/acq-mg/contracts/:id', async (c) => {
    try {
      const i = c.get('identity'), contractId = id(c.req.param('id'), '契約'), asOfMonth = asOfOf(c);
      const k = await store.getContract(db, i.org_id, contractId);
      if (!k) throw fail('支払う MG の契約がありません', 404);
      const result = await contractRecoup(i, k, asOfMonth);
      const versions = await store.contractVersions(db, i.org_id, contractId);
      return c.json({ok: true, asOfMonth, contract: {id: k.id, code: k.code, title: k.title, partnerId: k.partner_id, partnerName: k.partner_name, intakeCaseId: k.intake_case_id},
        versions, latest: result && {row: result.version.row, works: result.version.works, deductions: result.version.deductions, allocations: result.version.allocations,
          schedule: result.version.schedule, phases: result.version.phases}, links: result?.links ?? [], recoup: result?.recoup ?? null});
    } catch (e) { return routeError(c, e); }
  });

  app.post('/api/acq-mg/contracts', async (c) => {
    try {
      const i = c.get('identity'), x = await body(c);
      const code = text(x.code, '契約の番号', 40), title = text(x.title, '契約の題', 200), partnerId = id(x.partnerId, '権利元');
      const input = readTermInput(x), workIds = input.normalized.works.map((w) => Number(w.workId));
      await requireWorks(i, workIds);
      if (!await store.partnerExists(db, i.org_id, partnerId)) throw fail('権利元（取引先）を確認してください', 404);
      const intakeCaseId = x.intakeCaseId == null || x.intakeCaseId === '' ? null : id(x.intakeCaseId, '調達案件');
      if (intakeCaseId && !await store.intakeCaseForWorks(db, i.org_id, intakeCaseId, workIds)) throw fail('対象の作品の調達案件を選んでください', 409);
      const contractId = newMgId(), versionId = newMgId();
      try { await store.insertContract(db, {orgId: i.org_id, userId: i.user_id, contractId, versionId, code, title, partnerId, intakeCaseId, input}); }
      catch (e) { if (isUniqueViolation(e, ['acq_mg_contracts'])) throw fail(`契約の番号 ${code} は登録済みです。別の番号にしてください`, 409); throw e; }
      return c.json({ok: true, contractId, termVersionId: versionId, versionNo: 1}, 201);
    } catch (e) { return routeError(c, e); }
  });

  app.post('/api/acq-mg/contracts/:id/versions', async (c) => {
    try {
      const i = c.get('identity'), contractId = id(c.req.param('id'), '契約'), x = await body(c);
      if (!await store.contractExists(db, i.org_id, contractId)) throw fail('支払う MG の契約がありません', 404);
      await requireWorks(i, await store.contractWorkIds(db, i.org_id, contractId));
      const input = readTermInput(x);
      await requireWorks(i, input.normalized.works.map((w) => w.workId));
      const versionId = newMgId();
      const versionNo = await store.insertVersion(db, {orgId: i.org_id, userId: i.user_id, contractId, versionId, input});
      return c.json({ok: true, termVersionId: versionId, versionNo}, 201);
    } catch (e) { return routeError(c, e); }
  });

  // 結び付けの候補: 対象の作品の売上報告のうち、まだ結んでいないもの。作品と期間で1つの条件版に決まれば「自動で結べる」
  app.get('/api/acq-mg/link-candidates', async (c) => {
    try {
      const i = c.get('identity');
      const versions = await store.latestVersionWorks(db, i.org_id), linked = await store.linkedPairs(db, i.org_id);
      const candidates = [];
      for (const workId of new Set(versions.map((v) => v.work_id))) {
        if (!await settlementWork(i, workId)) continue;
        for (const r of (await settlementSource(i, workId)).reports) {
          if (linked.has(`${r.id}:${workId}`)) continue;
          const hits = versions.filter((v) => v.work_id === workId && r.period_from >= v.starts_on && r.period_to <= v.ends_on);
          candidates.push({reportId: r.id, workId, reportKey: r.report_key, accountingMonth: r.accounting_month, periodFrom: r.period_from, periodTo: r.period_to,
            termVersionIds: hits.map((v) => v.id), autoLinkable: hits.length === 1,
            reason: hits.length === 1 ? '作品と期間で1つに決まる' : hits.length === 0 ? '契約期間の外か、対象の作品の契約が無い' : '2つ以上の契約に当たる'});
        }
      }
      return c.json({ok: true, candidates});
    } catch (e) { return routeError(c, e); }
  });

  // 締め月の報告書の本体とハッシュを、いまの売上明細から組み立てる（下書き・発行・照合で同じ組み立てを使う）
  async function draftStatement(i, contract, closeMonth) {
    const result = await contractRecoup(i, contract, closeMonth);
    if (!result) return {gate: statementGate(null), body: null, sha: null, result: null};
    const previous = previousFromRow(await store.previousLiveIssue(db, i.org_id, contract.id, closeMonth));
    const body = buildStatementBody({contract, version: result.version.row, closeMonth, recoup: result.recoup, previous});
    const json = canonical(body);
    return {gate: statementGate(result.recoup), body, json, sha: await sha256(json), result};
  }
  const closeMonthOf = (v) => { const m = String(v ?? ''); if (!MONTH.test(m)) throw fail('締め月は YYYY-MM で入力してください'); return m; };

  app.get('/api/acq-mg/contracts/:id/statements', async (c) => {
    try {
      const i = c.get('identity'), contractId = id(c.req.param('id'), '契約');
      const k = await store.getContract(db, i.org_id, contractId);
      if (!k) throw fail('支払う MG の契約がありません', 404);
      const draft = c.req.query('closeMonth') ? await draftStatement(i, k, closeMonthOf(c.req.query('closeMonth'))) : null;
      if (!draft) await contractRecoup(i, k, thisMonth());
      return c.json({ok: true, statements: await store.contractStatements(db, i.org_id, contractId),
        draft: draft && {gate: draft.gate, body: draft.body, sha256: draft.sha}});
    } catch (e) { return routeError(c, e); }
  });

  app.post('/api/acq-mg/contracts/:id/statements', async (c) => {
    try {
      const i = c.get('identity'), contractId = id(c.req.param('id'), '契約'), x = await body(c);
      const k = await store.getContract(db, i.org_id, contractId);
      if (!k) throw fail('支払う MG の契約がありません', 404);
      const closeMonth = closeMonthOf(x.closeMonth);
      const draft = await draftStatement(i, k, closeMonth);
      if (!draft.gate.ok) throw fail(draft.gate.reason, 409);
      // 画面で見た下書きと同じ本体だけを発行する（見たあとに売上が変わっていたら断る）
      if (x.expectedSha256 && x.expectedSha256 !== draft.sha) throw fail('下書きを見たあとに売上が変わりました。見直してから発行してください', 409);
      const statementId = newMgId();
      await store.insertStatementIssue(db, {orgId: i.org_id, userId: i.user_id, statementId, termVersionId: draft.result.version.row.id, closeMonth,
        recoup: draft.result.recoup, bodyJson: draft.json, bodySha256: draft.sha, issuedOn: today()});
      return c.json({ok: true, statementId, sha256: draft.sha}, 201);
    } catch (e) { return routeError(c, e); }
  });

  app.post('/api/acq-mg/statements/:id/void', async (c) => {
    try {
      const i = c.get('identity'), statementId = id(c.req.param('id'), '報告書'), x = await body(c);
      const target = await store.getStatement(db, i.org_id, statementId);
      if (!target || target.kind !== 'issue') throw fail('取り消せる報告書がありません', 404);
      const k = await store.getContract(db, i.org_id, target.contract_id);
      await contractRecoup(i, k, target.close_month);
      const voidId = newMgId();
      await store.insertStatementVoid(db, {orgId: i.org_id, userId: i.user_id, statementId: voidId, target, reason: text(x.reason, '取消の理由', 500), issuedOn: today()});
      return c.json({ok: true, voidId}, 201);
    } catch (e) { return routeError(c, e); }
  });

  // 作り直しの照合: 発行した本体と、いまの入力から作り直した本体のハッシュが同じか（FR-PLAN-ACQ-017。監査に耐える根拠、仮説 H6）
  app.get('/api/acq-mg/statements/:id/verify', async (c) => {
    try {
      const i = c.get('identity'), statementId = id(c.req.param('id'), '報告書');
      const target = await store.getStatement(db, i.org_id, statementId);
      if (!target || target.kind !== 'issue') throw fail('報告書がありません', 404);
      const k = await store.getContract(db, i.org_id, target.contract_id);
      const draft = await draftStatement(i, k, target.close_month);
      return c.json({ok: true, issuedSha256: target.body_sha256, rebuiltSha256: draft.sha, same: draft.sha === target.body_sha256});
    } catch (e) { return routeError(c, e); }
  });

  // 支払の一覧と集計（MG の前払は支払予定の回ごと、分配額は最新の発行の累計に対して）
  async function paymentView(i, contract) {
    const versionId = await store.latestVersionId(db, i.org_id, contract.id);
    const version = versionId ? await store.loadVersion(db, i.org_id, versionId) : null;
    if (version) await requireWorks(i, version.works.map((w) => w.work_id));
    const [payments, latest] = await Promise.all([store.contractPayments(db, i.org_id, contract.id), store.latestLiveIssue(db, i.org_id, contract.id)]);
    const summary = summarizePayments({mgAmount: version?.row.mg_amount ?? 0, schedule: version?.schedule ?? [], payments, distributionOwed: latest?.distribution ?? 0});
    return {version, payments, latest, summary};
  }

  app.get('/api/acq-mg/contracts/:id/payments', async (c) => {
    try {
      const i = c.get('identity'), contractId = id(c.req.param('id'), '契約');
      const k = await store.getContract(db, i.org_id, contractId);
      if (!k) throw fail('支払う MG の契約がありません', 404);
      const view = await paymentView(i, k);
      return c.json({ok: true, payments: view.payments, summary: view.summary, latestStatementId: view.latest?.id ?? null});
    } catch (e) { return routeError(c, e); }
  });

  app.post('/api/acq-mg/contracts/:id/payments', async (c) => {
    try {
      const i = c.get('identity'), contractId = id(c.req.param('id'), '契約'), x = await body(c);
      const k = await store.getContract(db, i.org_id, contractId);
      if (!k) throw fail('支払う MG の契約がありません', 404);
      const input = readPaymentInput(x);
      const view = await paymentView(i, k);
      if (!view.version) throw fail('条件版がありません', 409);
      // 払いすぎを止める（MG の前払は回の残り、回の無い契約は MG の残り。分配額は最新の発行の未払）
      if (input.kind === 'mg_advance') {
        if (view.summary.installments.length && input.installment === null) throw fail('支払予定の回を選んでください');
        const left = input.installment === null ? view.summary.mgUnpaid : view.summary.installments.find((s) => s.installment === input.installment)?.unpaid;
        if (left === undefined) throw fail('支払予定に無い回です', 409);
        if (input.amountYen > left) throw fail(`この回の残りは ${left} 円です`, 409);
      } else {
        if (input.statementId !== view.latest?.id) throw fail('分配額は、取り消されていない最新の報告書に対して払ってください', 409);
        if (input.amountYen > view.summary.distributionUnpaid) throw fail(`分配額の未払は ${view.summary.distributionUnpaid} 円です`, 409);
      }
      const paymentId = newMgId();
      try { await store.insertPayment(db, {orgId: i.org_id, userId: i.user_id, paymentId, contract: k, termVersionId: view.version.row.id, input}); }
      catch (e) { if (isUniqueViolation(e, ['acq_mg_payments'])) throw fail(`参照 ${input.reference} の支払は記録済みです`, 409); throw e; }
      return c.json({ok: true, paymentId}, 201);
    } catch (e) { return routeError(c, e); }
  });

  // 取消: 元と同じ契約・種類・額の取消の行を足す（理由・参照・日付は取消のもの）
  app.post('/api/acq-mg/payments/:id/reverse', async (c) => {
    try {
      const i = c.get('identity'), paymentId = id(c.req.param('id'), '支払'), x = await body(c);
      const original = await store.getPayment(db, i.org_id, paymentId);
      if (!original || original.reverses_payment_id != null) throw fail('取り消せる支払がありません', 404);
      const k = await store.getContract(db, i.org_id, original.contract_id);
      await paymentView(i, k);
      const input = {kind: original.kind, installment: original.installment, statementId: original.statement_id, amountYen: original.amount_yen,
        paidOn: today(), reference: text(x.reference ?? `取消-${original.reference}`, '取消の参照', 160), reason: text(x.reason, '取消の理由', 1000),
        currency: original.currency, foreignAmount: original.foreign_amount, fxRateMicro: original.fx_rate_micro, fxRateOn: original.fx_rate_on};
      const reverseId = newMgId();
      await store.insertPayment(db, {orgId: i.org_id, userId: i.user_id, paymentId: reverseId, contract: k, termVersionId: original.term_version_id, input, reversesPaymentId: original.id});
      return c.json({ok: true, paymentId: reverseId}, 201);
    } catch (e) { return routeError(c, e); }
  });

  // 結ぶ。auto は候補が1つに決まるときだけ受け付ける（決まらないものは人が term_version_id と理由を選ぶ）
  app.post('/api/acq-mg/report-links', async (c) => {
    try {
      const i = c.get('identity'), x = await body(c);
      const reportId = id(x.reportId, '報告'), workId = id(x.workId, '作品'), termVersionId = id(x.termVersionId, '条件版');
      const decidedBy = x.decidedBy === 'auto' ? 'auto' : 'human', decision = x.decision === 'exclude' ? 'exclude' : 'include';
      const reportBasis = x.reportBasis === 'gross' ? 'gross' : 'net';
      if (!await settlementWork(i, workId)) throw fail('作品の財務権限がありません', 403);
      const version = await store.versionForWork(db, i.org_id, termVersionId, workId);
      if (!version) throw fail('この作品を対象にする条件版を選んでください', 409);
      const report = (await settlementSource(i, workId)).reports.find((r) => r.id === reportId);
      if (!report) throw fail('この作品へ配った有効な売上報告がありません', 409);
      if (decidedBy === 'auto') {
        const inside = report.period_from >= version.starts_on && report.period_to <= version.ends_on;
        const others = await store.otherVersionsCovering(db, i.org_id, workId, termVersionId, report.period_from, report.period_to);
        if (!inside || others.length) throw fail('自動で結べるのは、作品と期間で1つの契約に決まる報告だけです。人が理由を書いて結んでください', 409);
      }
      const reason = decidedBy === 'auto' ? '作品と期間で1つに決まる' : text(x.reason, '理由', 500);
      const replacesLinkId = x.replacesLinkId == null || x.replacesLinkId === '' ? null : id(x.replacesLinkId, '直す元');
      const linkId = newMgId();
      await store.insertLink(db, {orgId: i.org_id, userId: i.user_id, linkId, reportId, workId, termVersionId, reportBasis, decidedBy, decision, reason, replacesLinkId});
      return c.json({ok: true, linkId}, 201);
    } catch (e) { return routeError(c, e); }
  });
}
