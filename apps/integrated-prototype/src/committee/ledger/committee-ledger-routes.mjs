// 製作委員会の契約の型・条件版の式・日程の版・収支の台帳の受け口（要件 docs/requirements/settlement/committee.md。移行 0042〜0044）。
//   GET  /api/committee/ledger/templates                          契約の型（全版）
//   POST /api/committee/ledger/templates                          型の新しい版 {code, name, body, reason}
//   GET  /api/committee/ledger/contracts/:contractId               契約・条件版・式・日程と回・台帳の収支報告書と累計（?tier&closeOn&asOf&until）
//   POST /api/committee/ledger/contracts/:contractId/formula       条件版の式 {termVersionId, templateId, businesses, committeeSteps, budgetLines}
//   POST /api/committee/ledger/contracts/:contractId/schedule-versions  日程の新しい版 {effectiveFrom, baseKind, baseDate, reason, phases}
//   POST /api/committee/ledger/contracts/:contractId/round-overrides    回だけの変更 {tier, closeOn, field, valueOn, reason}
//   POST /api/committee/ledger/contracts/:contractId/rounds/received   届いた収支報告書の全行 {tier, closeOn, report, reportedPrior}
//   POST /api/committee/ledger/contracts/:contractId/rounds/reverse    1回分の取消 {tier, closeOn, reason}
// 制作担当は 403。契約の作品の財務の権限（settlementWork）が要り、権限の無い契約と別の組織の契約は同じ 403 にする。
// 金額の計算は純関数（committee-*-model.mjs）、DB は store（committee-ledger-store.mjs）。問い合わせはすべて組織（identity.org_id）で絞る。
import {dbErrorKind} from '../../data-platform/db-errors.mjs';
import {roundsFor} from './committee-schedule-model.mjs';
import {statement, cumulativeBy, checkReportedPrior, entriesFromReport} from './committee-ledger-model.mjs';
import {addTemplateVersion, readTemplates, saveTermFormula, readTermFormula, addScheduleVersion, addRoundOverride, readSchedule,
  appendLedgerRound, reverseLedgerRound, readLedger, readCommitteeContract, readTermVersions, termVersionOfContract, readInvestmentTotal, readPartners} from './committee-ledger-store.mjs';

const FORBIDDEN = 'この製作委員会の契約への権限がありません';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIERS = ['to_manager', 'to_members'];
const today = () => new Date().toISOString().slice(0, 10);
const addYears = (date, n) => `${Number(date.slice(0, 4)) + n}${date.slice(4)}`;

export function registerCommitteeLedgerRoutes(app, {db, bad, body, settlementWork}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof settlementWork !== 'function') {
    throw new Error('committee ledger routes require app, db, bad, body and settlementWork');
  }
  const conflict = (c, error) => bad(c, dbErrorKind(error) === 'raise' || error.code ? error.message : 'ほかの画面で変わったか、条件に合いません。読み直してください', 409, undefined, error);

  // 契約の有無を見せず、権限が無ければ同じ 403
  async function contractAccess(c) {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return {error: bad(c, FORBIDDEN, 403)};
    const contractId = Number(c.req.param('contractId'));
    if (!Number.isSafeInteger(contractId) || contractId <= 0) return {error: bad(c, FORBIDDEN, 403)};
    const contract = await readCommitteeContract(db, identity.org_id, contractId);
    if (!contract || !await settlementWork(identity, contract.workId)) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, contract};
  }
  function tierOf(c, value) {
    const tier = value ?? 'to_members';
    return TIERS.includes(tier) ? tier : null;
  }

  app.get('/api/committee/ledger/templates', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '製作委員会の契約の型は財務担当の情報です', 403);
    return c.json({ok: true, templates: await readTemplates(db, identity.org_id)});
  });

  app.post('/api/committee/ledger/templates', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '製作委員会の契約の型は財務担当の情報です', 403);
    const input = await body(c);
    const code = String(input.code ?? '').trim();
    const name = String(input.name ?? '').trim();
    const reason = String(input.reason ?? '').trim();
    if (!code || !name || !reason || typeof input.body !== 'object' || input.body === null) return bad(c, '型のコード・名前・中身・理由を入れてください');
    try {
      const row = await addTemplateVersion(db, {orgId: identity.org_id, userId: identity.user_id, code, name, body: input.body, reason});
      return c.json({ok: true, template: {id: Number(row.id), code: row.code, versionNo: Number(row.version_no)}}, 201);
    } catch (error) { return conflict(c, error); }
  });

  app.get('/api/committee/ledger/contracts/:contractId', async (c) => {
    const access = await contractAccess(c);
    if (access.error) return access.error;
    const {identity, contract} = access;
    const tier = tierOf(c, c.req.query('tier'));
    if (!tier) return bad(c, '段は to_manager か to_members で指定してください');
    const asOf = c.req.query('asOf') || today();
    const until = c.req.query('until') || addYears(asOf, 3);
    if (!DATE.test(asOf) || !DATE.test(until)) return bad(c, '日付は YYYY-MM-DD で指定してください');
    const versions = await readTermVersions(db, identity.org_id, contract.id);
    const latest = versions.at(-1) ?? null;
    const formula = latest ? await readTermFormula(db, identity.org_id, latest.id) : null;
    const schedule = await readSchedule(db, identity.org_id, contract.id, asOf);
    let rounds = {to_manager: [], to_members: []};
    let scheduleError = null;
    if (schedule) {
      try {
        for (const t of TIERS) {
          if (schedule.phases.some((p) => p.tier === t)) rounds[t] = roundsFor({baseDate: schedule.baseDate, phases: schedule.phases, tier: t, untilDate: until, overrides: schedule.overrides});
        }
      } catch (error) { scheduleError = error.message; rounds = {to_manager: [], to_members: []}; }
    }
    const entries = await readLedger(db, identity.org_id, contract.id, tier);
    const closes = [...new Set(entries.map((e) => e.closeOn))].sort();
    const closeOn = c.req.query('closeOn') || closes.at(-1) || null;
    if (closeOn && !DATE.test(closeOn)) return bad(c, '締め日は YYYY-MM-DD で指定してください');
    const investmentYen = await readInvestmentTotal(db, identity.org_id, latest?.id ?? null);
    const report = closeOn ? statement(entries, {closeOn, investmentTotalYen: investmentYen ?? 0}) : null;
    const cumulative = (section, key) => closeOn ? [...cumulativeBy(entries, {section, closeOn, ...(key ? {key} : {})}).entries()].map(([k, v]) => ({key: k, ...v})) : [];
    const partners = await readPartners(db, identity.org_id);
    return c.json({ok: true, contract, termVersions: versions, formula, schedule, scheduleError, rounds, tier, closes, closeOn, partners,
      investmentTotalYen: investmentYen, statement: report,
      cumulatives: closeOn ? {
        members: cumulative('member_distribution'),
        holders: cumulative('secondary_royalty', (r) => `${r.holderRole ?? ''}|${r.counterparty ?? ''}`),
        successFee: cumulative('success_fee'),
        agentFee: cumulative('agent_fee'),
      } : null});
  });

  app.post('/api/committee/ledger/contracts/:contractId/formula', async (c) => {
    const access = await contractAccess(c);
    if (access.error) return access.error;
    const {identity, contract} = access;
    const input = await body(c);
    const termVersionId = Number(input.termVersionId);
    if (!await termVersionOfContract(db, identity.org_id, contract.id, termVersionId)) {
      return bad(c, 'この契約の条件版がありません', 409);
    }
    if (!Array.isArray(input.businesses) || !Array.isArray(input.committeeSteps)) return bad(c, '事業の式と委員会全体の式を入れてください');
    try {
      await saveTermFormula(db, {orgId: identity.org_id, userId: identity.user_id, termVersionId, templateId: input.templateId ?? null,
        businesses: input.businesses, committeeSteps: input.committeeSteps, budgetLines: input.budgetLines ?? []});
      return c.json({ok: true, formula: await readTermFormula(db, identity.org_id, termVersionId)}, 201);
    } catch (error) { return conflict(c, error); }
  });

  app.post('/api/committee/ledger/contracts/:contractId/schedule-versions', async (c) => {
    const access = await contractAccess(c);
    if (access.error) return access.error;
    const {identity, contract} = access;
    const input = await body(c);
    if (!Array.isArray(input.phases) || !input.phases.length) return bad(c, 'フェーズを1つ以上入れてください');
    try {
      // 式で回を導けることを、書く前に確かめる（読めない日程の版を残さない）
      for (const t of TIERS) if (input.phases.some((p) => p.tier === t)) roundsFor({baseDate: input.baseDate, phases: input.phases, tier: t, untilDate: input.baseDate});
    } catch (error) { return bad(c, error.message); }
    try {
      await addScheduleVersion(db, {orgId: identity.org_id, userId: identity.user_id, contractId: contract.id, effectiveFrom: input.effectiveFrom, baseKind: input.baseKind,
        baseDate: input.baseDate, reason: String(input.reason ?? '').trim(), sourceReference: input.sourceReference ?? null, phases: input.phases});
      return c.json({ok: true, schedule: await readSchedule(db, identity.org_id, contract.id, input.effectiveFrom)}, 201);
    } catch (error) { return conflict(c, error); }
  });

  app.post('/api/committee/ledger/contracts/:contractId/round-overrides', async (c) => {
    const access = await contractAccess(c);
    if (access.error) return access.error;
    const {identity, contract} = access;
    const input = await body(c);
    if (!String(input.reason ?? '').trim()) return bad(c, '回だけの変更には理由を書いてください');
    try {
      await addRoundOverride(db, {orgId: identity.org_id, userId: identity.user_id, contractId: contract.id, tier: input.tier, closeOn: input.closeOn,
        field: input.field, valueOn: input.valueOn ?? null, reason: String(input.reason).trim(), sourceReference: input.sourceReference ?? null});
      return c.json({ok: true}, 201);
    } catch (error) { return conflict(c, error); }
  });

  app.post('/api/committee/ledger/contracts/:contractId/rounds/received', async (c) => {
    const access = await contractAccess(c);
    if (access.error) return access.error;
    const {identity, contract} = access;
    const input = await body(c);
    const tier = tierOf(c, input.tier);
    if (!tier || !DATE.test(String(input.closeOn ?? ''))) return bad(c, '段と締め日（YYYY-MM-DD）を入れてください');
    let rows;
    try { rows = entriesFromReport(input.report ?? {}, {tier, closeOn: input.closeOn}); }
    catch (error) { return bad(c, error.message, 400, error.code ? {code: error.code, diffYen: error.diffYen} : undefined); }
    // 報告書の「前回まで累計」が台帳と合わなければ止める（入れ間違いか幹事の訂正。FR-SETL-COMM-018）
    const reported = Array.isArray(input.reportedPrior) ? input.reportedPrior : [];
    if (reported.length) {
      const checks = checkReportedPrior(await readLedger(db, identity.org_id, contract.id, tier), {closeOn: input.closeOn, reported});
      const ng = checks.filter((x) => !x.ok);
      if (ng.length) return bad(c, '報告書の前回まで累計が台帳と一致しません', 409, {code: 'prior_mismatch', checks: ng});
    }
    try {
      await appendLedgerRound(db, {orgId: identity.org_id, userId: identity.user_id, contractId: contract.id, tier, closeOn: input.closeOn,
        sourceKind: 'received', sourceReference: input.sourceReference ?? null, entries: rows});
      return c.json({ok: true, rows: rows.length}, 201);
    } catch (error) { return conflict(c, error); }
  });

  app.post('/api/committee/ledger/contracts/:contractId/rounds/reverse', async (c) => {
    const access = await contractAccess(c);
    if (access.error) return access.error;
    const {identity, contract} = access;
    const input = await body(c);
    const tier = tierOf(c, input.tier);
    if (!tier || !DATE.test(String(input.closeOn ?? '')) || !String(input.reason ?? '').trim()) return bad(c, '段・締め日と、取り消す理由を入れてください');
    try {
      const reversed = await reverseLedgerRound(db, {orgId: identity.org_id, userId: identity.user_id, contractId: contract.id, tier, closeOn: input.closeOn, reason: String(input.reason).trim()});
      return c.json({ok: true, reversed}, 201);
    } catch (error) { return conflict(c, error); }
  });
}
