import {expenseSource} from '../expense-sheet/expense-read.mjs';
// ロイヤリティの読み込み（契約・条件版・サイクル・台帳・確定版・売上・経費・本委員会収入）。API・作業キュー・委員会の月次収支が使う。
// 権限: 作品の財務権限（settlementWork）がある契約だけを読む。権利者の契約に権限外の作品が1つでもあれば、その権利者は「制限あり」
// （報告書は権利者の全契約で1通なので、一部だけの報告書を作らない）。Worker でも動くよう node:* を import しない。
import {allIn} from '../sql-in.mjs';
import {workSaleLines} from '../sales/channel-group.mjs';
import {loadCommitteeIncome} from '../committee/committee-income.mjs';
import {
  accrueAgreement, resolveItems, holderClosings, periodRows, simulateDrafts, COMMITTEE_BASES, isMonth,
} from './royalty-model.mjs';

export const todayJst = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const bool = (value) => value === 1 || value === true || value === '1';

// 財務権限のある作品（制作担当は空）。access は ctx（{settlementWork, permittedProjects}）か settlementWork そのもの。
// permittedProjects があれば、settlementWork と同じ規則（作品の案件に財務権限＝permittedProjects(…, true) がある）を
// 作品数によらず2回の問い合わせで確かめる（D1 の1回の Worker 呼び出しあたりの問い合わせ数の上限のため）。
// 無ければ作品を1つずつ settlementWork で確かめる（作品ごとに問い合わせが増える）
export async function financeWorkIds(db, identity, access) {
  if (!identity || identity.role === 'production') return new Set();
  const settlementWork = typeof access === 'function' ? access : access?.settlementWork;
  const permittedProjects = typeof access === 'function' ? null : access?.permittedProjects;
  const works = await db.all('SELECT id, project_id FROM works WHERE org_id=? ORDER BY id', [identity.org_id]);
  if (typeof permittedProjects === 'function') {
    const finance = new Set((await permittedProjects(db, identity, true)).map((project) => Number(project.id)));
    return new Set(works.filter((work) => finance.has(Number(work.project_id))).map((work) => work.id));
  }
  const allowed = new Set();
  for (const work of works) if (await settlementWork(identity, work.id)) allowed.add(work.id);
  return allowed;
}

const termOf = (row) => ({
  id: row.id, agreementId: row.agreement_id, versionNo: row.version_no, effectiveFrom: row.effective_from, calcMethod: row.calc_method, baseKind: row.base_kind,
  rateBps: row.rate_bps, windowFeeBps: row.window_fee_bps, fixedAmountYen: row.fixed_amount_yen, advanceYen: row.advance_yen, minPaymentYen: row.min_payment_yen,
  clauseReference: row.clause_reference, reason: row.reason, createdAt: row.created_at, createdByName: row.created_by_name ?? null, channels: [], expenseCategories: [],
});
const phaseOf = (row) => ({
  id: row.id, scheduleVersionId: row.schedule_version_id, startsMonth: row.starts_month, endsMonth: row.ends_month, cycleKind: row.cycle_kind, anchorMonth: row.anchor_month,
  customCloseMonths: row.custom_close_months, firstCloseImmediate: bool(row.first_close_immediate), reportOffsetMonths: row.report_offset_months, reportDay: row.report_day,
  paymentOffsetMonths: row.payment_offset_months, paymentDay: row.payment_day, note: row.note,
});
export const entryOf = (row) => ({
  id: row.id, holderId: row.holder_partner_id, holderName: row.holder_name ?? null, agreementId: row.agreement_id, kind: row.kind, accrualMonth: row.accrual_month,
  closeMonth: row.close_month, amountYen: row.amount_yen, reason: row.reason, sourceReference: row.source_reference, reversesEntryId: row.reverses_entry_id,
  createdAt: row.created_at, createdByName: row.created_by_name ?? null,
});
export const manualOf = (row) => ({
  id: row.id, agreementId: row.agreement_id, accrualMonth: row.accrual_month, amountYen: row.amount_yen, sourceReference: row.source_reference, reason: row.reason,
  reversesEntryId: row.reverses_entry_id, createdAt: row.created_at, createdByName: row.created_by_name ?? null,
});
const lineOf = (row) => ({
  id: row.id, statementId: row.statement_id, lineNo: row.line_no, lineKind: row.line_kind, agreementId: row.agreement_id, accrualMonth: row.accrual_month,
  termVersionId: row.term_version_id, irregularEntryId: row.irregular_entry_id, salesYen: row.sales_yen, windowFeeYen: row.window_fee_yen, expenseYen: row.expense_yen,
  committeeIncomeYen: row.committee_income_yen, baseYen: row.base_yen, rateBps: row.rate_bps, amountYen: row.amount_yen, note: row.note,
});
export const eventOf = (row) => ({
  id: row.id, statementId: row.statement_id, eventKind: row.event_kind, occurredOn: row.occurred_on, amountYen: row.amount_yen, reference: row.reference, note: row.note,
  reversesEventId: row.reverses_event_id, createdAt: row.created_at, createdByName: row.created_by_name ?? null,
});

// 契約（条件版・サイクルつき）。access は financeWorkIds と同じ（ctx か settlementWork）。filters: {holderId, workId, category, agreementIds}。
// 返り値 {agreements（権限のあるもの）, restrictedHolders（権限外の契約を持つ権利者）, allowedWorks}
export async function loadAgreements(db, identity, access, filters = {}) {
  const allowedWorks = await financeWorkIds(db, identity, access);
  const all = await db.all(`SELECT a.*, w.title AS work_title, w.code AS work_code, p.name AS holder_name, p.code AS holder_code
    FROM royalty_agreements a JOIN works w ON w.org_id=a.org_id AND w.id=a.work_id JOIN partners p ON p.org_id=a.org_id AND p.id=a.holder_partner_id
    WHERE a.org_id=? ORDER BY a.id`, [identity.org_id]);
  const restrictedHolders = new Set(all.filter((row) => !allowedWorks.has(row.work_id)).map((row) => row.holder_partner_id));
  let rows = all.filter((row) => allowedWorks.has(row.work_id));
  if (filters.holderId) rows = rows.filter((row) => row.holder_partner_id === Number(filters.holderId));
  if (filters.workId) rows = rows.filter((row) => row.work_id === Number(filters.workId));
  if (filters.category) rows = rows.filter((row) => row.category === filters.category);
  if (filters.agreementIds) { const wanted = new Set(filters.agreementIds.map(Number)); rows = rows.filter((row) => wanted.has(row.id)); }
  const ids = rows.map((row) => row.id);
  const [terms, channels, categories, schedules, phases] = ids.length ? await Promise.all([
    allIn(db, `SELECT t.*, u.display_name AS created_by_name FROM royalty_term_versions t LEFT JOIN users u ON u.id=t.created_by
      WHERE t.org_id=? AND t.agreement_id IN (:in)`, {before: [identity.org_id], ids}),
    allIn(db, `SELECT c.* FROM royalty_term_channels c JOIN royalty_term_versions t ON t.org_id=c.org_id AND t.id=c.term_version_id
      WHERE c.org_id=? AND t.agreement_id IN (:in)`, {before: [identity.org_id], ids}),
    allIn(db, `SELECT c.* FROM royalty_term_expense_categories c JOIN royalty_term_versions t ON t.org_id=c.org_id AND t.id=c.term_version_id
      WHERE c.org_id=? AND t.agreement_id IN (:in)`, {before: [identity.org_id], ids}),
    allIn(db, `SELECT s.*, u.display_name AS created_by_name FROM royalty_schedule_versions s LEFT JOIN users u ON u.id=s.created_by
      WHERE s.org_id=? AND s.agreement_id IN (:in)`, {before: [identity.org_id], ids}),
    allIn(db, `SELECT p.* FROM royalty_schedule_phases p JOIN royalty_schedule_versions s ON s.org_id=p.org_id AND s.id=p.schedule_version_id
      WHERE p.org_id=? AND s.agreement_id IN (:in)`, {before: [identity.org_id], ids}),
  ]) : [[], [], [], [], []];
  const termMap = new Map(terms.map((row) => [row.id, termOf(row)]));
  for (const row of channels) termMap.get(row.term_version_id)?.channels.push(row.channel_group);
  for (const row of categories) termMap.get(row.term_version_id)?.expenseCategories.push(row.category);
  const phaseBySchedule = new Map();
  for (const row of phases) {
    if (!phaseBySchedule.has(row.schedule_version_id)) phaseBySchedule.set(row.schedule_version_id, []);
    phaseBySchedule.get(row.schedule_version_id).push(phaseOf(row));
  }
  const agreements = rows.map((row) => {
    const ownTerms = [...termMap.values()].filter((term) => term.agreementId === row.id).sort((a, b) => a.versionNo - b.versionNo);
    for (const term of ownTerms) { term.channels.sort(); term.expenseCategories.sort(); }
    const ownSchedules = schedules.filter((s) => s.agreement_id === row.id).sort((a, b) => a.version_no - b.version_no).map((s) => ({
      id: s.id, versionNo: s.version_no, statementsFrom: s.statements_from, reason: s.reason, createdAt: s.created_at, createdByName: s.created_by_name ?? null,
      phases: (phaseBySchedule.get(s.id) || []).sort((a, b) => a.startsMonth.localeCompare(b.startsMonth)),
    }));
    return {
      id: row.id, code: row.agreement_code, title: row.title, projectId: row.project_id, workId: row.work_id, workTitle: row.work_title, workCode: row.work_code,
      holderId: row.holder_partner_id, holderName: row.holder_name, holderCode: row.holder_code, category: row.category, documentReference: row.document_reference,
      note: row.note, createdAt: row.created_at, terms: ownTerms, schedules: ownSchedules, schedule: ownSchedules.at(-1) || null,
    };
  });
  return {agreements, restrictedHolders, allowedWorks};
}

export async function loadEntries(db, orgId, holderIds) {
  const rows = await allIn(db, `SELECT e.*, p.name AS holder_name, u.display_name AS created_by_name FROM royalty_irregular_entries e
    JOIN partners p ON p.org_id=e.org_id AND p.id=e.holder_partner_id LEFT JOIN users u ON u.id=e.created_by
    WHERE e.org_id=? AND e.holder_partner_id IN (:in)`, {before: [orgId], ids: [...holderIds], sortBy: (a, b) => a.id - b.id});
  return rows.map(entryOf);
}

export async function loadManual(db, orgId, agreementIds) {
  const rows = await allIn(db, `SELECT m.*, u.display_name AS created_by_name FROM royalty_manual_accruals m LEFT JOIN users u ON u.id=m.created_by
    WHERE m.org_id=? AND m.agreement_id IN (:in)`, {before: [orgId], ids: [...agreementIds], sortBy: (a, b) => a.id - b.id});
  return rows.map(manualOf);
}

const statementOf = (row) => ({
  id: row.id, holderId: row.holder_partner_id, holderName: row.holder_name ?? null, holderCode: row.holder_code ?? null, closeMonth: row.close_month,
  reportDueOn: row.report_due_on, paymentDueOn: row.payment_due_on, versionNo: row.version_no, previousStatementId: row.previous_statement_id, asOf: row.as_of,
  inputHash: row.input_hash, royaltyYen: row.royalty_yen, adjustmentYen: row.adjustment_yen, advanceRecoupedYen: row.advance_recouped_yen, carriedInYen: row.carried_in_yen,
  payableYen: row.payable_yen, carriedOutYen: row.carried_out_yen, holdCount: row.hold_count, lineCount: row.line_count, createdAt: row.created_at,
  createdByName: row.created_by_name ?? null, voided: row.void_id ? {reason: row.void_reason, createdAt: row.void_at, createdByName: row.void_by_name ?? null} : null,
  lines: [], events: [],
});

// 権利者の確定版（明細・報告と支払の記録つき）。includeVoided=false なら取消されていないものだけ
export async function loadStatements(db, orgId, holderIds, {includeVoided = false, withCalculation = false, statementIds = null} = {}) {
  const ids = [...holderIds];
  if (!ids.length) return [];
  const rows = await allIn(db, `SELECT s.id, s.org_id, s.holder_partner_id, s.close_month, s.report_due_on, s.payment_due_on, s.version_no, s.previous_statement_id, s.as_of,
      s.input_hash, s.royalty_yen, s.adjustment_yen, s.advance_recouped_yen, s.carried_in_yen, s.payable_yen, s.carried_out_yen, s.hold_count, s.line_count, s.created_at,
      ${withCalculation ? 's.calculation_json,' : ''} p.name AS holder_name, p.code AS holder_code, u.display_name AS created_by_name,
      v.id AS void_id, v.reason AS void_reason, v.created_at AS void_at, vu.display_name AS void_by_name
    FROM royalty_statements s JOIN partners p ON p.org_id=s.org_id AND p.id=s.holder_partner_id LEFT JOIN users u ON u.id=s.created_by
    LEFT JOIN royalty_statement_voids v ON v.org_id=s.org_id AND v.statement_id=s.id LEFT JOIN users vu ON vu.id=v.created_by
    WHERE s.org_id=? AND s.holder_partner_id IN (:in)`, {before: [orgId], ids, sortBy: (a, b) => a.close_month.localeCompare(b.close_month) || a.version_no - b.version_no});
  const statements = rows.filter((row) => (includeVoided || !row.void_id) && (!statementIds || statementIds.includes(row.id))).map((row) => {
    const statement = statementOf(row);
    if (withCalculation) statement.calculation = JSON.parse(row.calculation_json);
    return statement;
  });
  const statementIdList = statements.map((statement) => statement.id);
  if (!statementIdList.length) return statements;
  const byId = new Map(statements.map((statement) => [statement.id, statement]));
  // 分割して保存した計算の内容（クラウドの1つの値の上限を超えたもの）は、分割を順につないで読む
  const split = statements.filter((statement) => statement.calculation?.calculationParts);
  if (split.length) {
    const parts = await allIn(db, 'SELECT statement_id, part_no, body FROM royalty_statement_calculation_parts WHERE org_id=? AND statement_id IN (:in)',
      {before: [orgId], ids: split.map((statement) => statement.id), sortBy: (a, b) => a.statement_id - b.statement_id || a.part_no - b.part_no});
    for (const statement of split) {
      const own = parts.filter((part) => part.statement_id === statement.id);
      if (own.length !== statement.calculation.calculationParts) throw new Error('報告書の計算の内容の分割がそろっていません');
      statement.calculation = JSON.parse(own.map((part) => part.body).join(''));
    }
  }
  const [lines, events] = await Promise.all([
    allIn(db, 'SELECT * FROM royalty_statement_lines WHERE org_id=? AND statement_id IN (:in)', {before: [orgId], ids: statementIdList, sortBy: (a, b) => a.statement_id - b.statement_id || a.line_no - b.line_no}),
    allIn(db, `SELECT e.*, u.display_name AS created_by_name FROM royalty_statement_events e LEFT JOIN users u ON u.id=e.created_by
      WHERE e.org_id=? AND e.statement_id IN (:in)`, {before: [orgId], ids: statementIdList, sortBy: (a, b) => a.id - b.id}),
  ]);
  for (const line of lines) byId.get(line.statement_id)?.lines.push(lineOf(line));
  for (const event of events) byId.get(event.statement_id)?.events.push(eventOf(event));
  return statements;
}

// 契約の発生額（締め月・保留つき）。売上は作品の配賦済み明細、経費は作品の経費、本委員会収入は委員会の担当の読み出し口。
export async function loadItems(db, identity, agreements, entries, manual, {toMonth, fromMonth = null}, ctx = {}) {
  if (!agreements.length || !isMonth(toMonth)) return [];
  const workIds = [...new Set(agreements.map((agreement) => agreement.workId))];
  const firstMonth = agreements.flatMap((agreement) => agreement.terms.map((term) => term.effectiveFrom)).sort()[0] || toMonth;
  const from = fromMonth && fromMonth > firstMonth ? fromMonth : firstMonth;
  if (from > toMonth) return [];
  const sales = await workSaleLines(db, identity.org_id, workIds, {from, to: toMonth});
  const expenses = await allIn(db, `SELECT id, work_id, accounting_month, category, description, actual_ex_tax FROM ${expenseSource()}
    WHERE org_id=? AND work_id IN (:in) AND accounting_month BETWEEN ? AND ?`, {before: [identity.org_id], ids: workIds, after: [from, toMonth], sortBy: (a, b) => a.id - b.id});
  const committeeWorks = [...new Set(agreements.filter((agreement) => agreement.terms.some((term) => COMMITTEE_BASES.includes(term.baseKind))).map((agreement) => agreement.workId))];
  const committeeByWork = new Map();
  if (committeeWorks.length) {
    const contracted = new Set((await allIn(db, 'SELECT DISTINCT work_id FROM committee_contracts WHERE org_id=? AND work_id IN (:in)', {before: [identity.org_id], ids: committeeWorks})).map((row) => row.work_id));
    const income = await loadCommitteeIncome(db, identity, {workIds: committeeWorks, from, to: toMonth}, ctx);
    for (const workId of committeeWorks) {
      committeeByWork.set(workId, {
        available: contracted.has(workId),
        rows: (income?.rows || []).filter((row) => Number(row.workId) === workId),
        expenses: (income?.expenses || []).filter((row) => Number(row.workId) === workId),
      });
    }
  }
  const salesByWork = new Map();
  for (const line of sales) {
    if (!salesByWork.has(line.workId)) salesByWork.set(line.workId, []);
    salesByWork.get(line.workId).push(line);
  }
  const expensesByWork = new Map();
  for (const row of expenses) {
    if (!expensesByWork.has(row.work_id)) expensesByWork.set(row.work_id, []);
    expensesByWork.get(row.work_id).push({id: row.id, month: row.accounting_month, category: row.category, description: row.description, amount: row.actual_ex_tax});
  }
  const items = [];
  for (const agreement of agreements) {
    const accruals = accrueAgreement({
      agreement, toMonth, fromMonth, sales: salesByWork.get(agreement.workId) || [], expenses: expensesByWork.get(agreement.workId) || [],
      committee: committeeByWork.get(agreement.workId) || null, manual: manual.filter((row) => row.agreementId === agreement.id),
    });
    items.push(...resolveItems({agreement, accruals, entries: entries.filter((entry) => entry.holderId === agreement.holderId)}));
  }
  return items;
}

export function holdersOf(agreements) {
  const holders = new Map();
  for (const agreement of agreements) {
    if (!holders.has(agreement.holderId)) holders.set(agreement.holderId, {id: agreement.holderId, name: agreement.holderName, code: agreement.holderCode, agreements: 0, categories: new Set()});
    const holder = holders.get(agreement.holderId);
    holder.agreements += 1;
    holder.categories.add(agreement.category);
  }
  return [...holders.values()].map((holder) => ({...holder, categories: [...holder.categories]})).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
}

const maskRestricted = (row) => ({...row, restricted: true, statementId: null, versionNo: null, payableYen: null, royaltyYen: null, adjustmentYen: null,
  carriedOutYen: null, holdCount: null, reportedOn: null, paidYen: null, paymentOverdue: false, draft: null});

// 期間の一覧（権利者×締め月）。withDrafts なら確定版のない期間の下書きの額を付ける（売上を読む）。
// statements・entries・agreements・items も返す（一括作成が読み直さずに使う。権限外の作品を含む権利者の分は画面に出さない）
export async function royaltyPeriods(db, identity, ctx, {asOf, holderId = null, withDrafts = true} = {}) {
  const {agreements, restrictedHolders} = await loadAgreements(db, identity, ctx, {holderId});
  const holders = holdersOf(agreements);
  const holderIds = holders.map((holder) => holder.id);
  const asOfMonth = asOf.slice(0, 7);
  const entries = holderIds.length ? await loadEntries(db, identity.org_id, holderIds) : [];
  const statements = await loadStatements(db, identity.org_id, holderIds);
  let items = [];
  const closingsByHolder = new Map();
  for (const holder of holders) {
    closingsByHolder.set(holder.id, holderClosings({agreements: agreements.filter((a) => a.holderId === holder.id), entries: entries.filter((e) => e.holderId === holder.id), asOfMonth}));
  }
  if (withDrafts && agreements.length) {
    const maxClose = [...closingsByHolder.values()].flatMap((closings) => [...closings.keys()]).sort().at(-1);
    const toMonth = maxClose && maxClose > asOfMonth ? maxClose : asOfMonth;
    const manual = await loadManual(db, identity.org_id, agreements.map((a) => a.id));
    items = await loadItems(db, identity, agreements, entries, manual, {toMonth}, ctx);
  }
  const periods = [];
  for (const holder of holders) {
    const own = statements.filter((statement) => statement.holderId === holder.id);
    const closings = closingsByHolder.get(holder.id);
    const rows = periodRows({holder, closings, statements: own, asOf});
    const restricted = restrictedHolders.has(holder.id);
    // 権限外の作品の契約を持つ権利者は、一部の契約だけの下書きを出さない（報告書は権利者の全契約で1通）
    if (withDrafts && !restricted) {
      const holderAgreements = agreements.filter((a) => a.holderId === holder.id);
      const drafts = simulateDrafts({holder, agreements: holderAgreements, items: items.filter((item) => item.holderId === holder.id),
        adjustments: entries.filter((entry) => entry.holderId === holder.id && entry.kind === 'adjust_amount'), statements: own, closings, asOf});
      for (const row of rows) {
        const draft = drafts.get(row.closeMonth);
        if (!draft || row.statementId) continue;
        row.draft = draft;
        row.royaltyYen = draft.totals.royaltyYen;
        row.adjustmentYen = draft.totals.adjustmentYen;
        row.payableYen = draft.totals.payableYen;
        row.carriedOutYen = draft.totals.carriedOutYen;
        row.holdCount = draft.totals.holdCount;
      }
    }
    // 権限外の作品の契約を持つ権利者は、確定版の金額・版・報告と支払も出さない（/statements と同じく、状態と締め月・期限だけ）
    for (const row of rows) periods.push(restricted ? maskRestricted(row) : {...row, restricted});
  }
  return {periods, holders: holders.map((holder) => ({...holder, restricted: restrictedHolders.has(holder.id)})), agreements, entries, statements, items};
}
