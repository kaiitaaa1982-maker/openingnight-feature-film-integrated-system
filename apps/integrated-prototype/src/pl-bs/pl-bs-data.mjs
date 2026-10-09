import {expenseSource,resolveExpenseAccounts} from '../expense-sheet/expense-read.mjs';
import {loadSettlement} from '../expense-accounting/settlement-model.mjs';
import {expenseBsAdjustments} from '../expense-accounting/settlement-pl-bs.mjs';
// PL・BS の材料を DB から読み、純関数 buildPlBs（src/reports/pl-bs-model.mjs）の入力にする。Worker でも動くよう node:* を import しない。
// 問い合わせはすべて組織（identity.org_id）で絞る。IN (...) に並べる値は allIn で80件ずつに分ける（D1 の1文の値は100個まで）。
// 作品の範囲（workIds）は呼び出し側が権限で決める。includeCompany が false のときは、作品に付かない額（作品の決まっていない案件の経費・
// 作品を付けない手入力の額・作品に分けられない入金や支払）を読まない（会社全体を見る権限が無い人に会社の数字を渡さない）。
import {splitByAllocation} from '../money-allocation.mjs';
import {workSaleLines, withSharedReads} from '../sales/channel-group.mjs';
import {loadCommitteeTerms, loadCommitteeIncome} from '../committee/committee-income.mjs';
import {buildCommitteeMonthly} from '../committee/committee-monthly-model.mjs';
import {loadRoyaltyAccruals} from '../royalty/royalty-loader.mjs';
import {advanceRecoupSeries, termFor} from '../royalty/royalty-model.mjs';
import {fiscalSetting} from '../reporting-annual.mjs';
import {splitByWeights} from '../reports/pl-bs-model.mjs';

const monthOf = (date) => String(date || '').slice(0, 7);

export async function latestProfile(db, orgId) {
  const row = await db.get(`SELECT v.*, p.code AS self_partner_code, p.name AS self_partner_name, u.display_name AS created_by_name
    FROM org_profile_versions v LEFT JOIN partners p ON p.org_id=v.org_id AND p.id=v.self_partner_id LEFT JOIN users u ON u.id=v.created_by
    WHERE v.org_id=? ORDER BY v.version_no DESC LIMIT 1`, [orgId]);
  return row ? profileFromRow(row) : null;
}
export function profileFromRow(row) {
  return {
    versionNo: row.version_no, legalName: row.legal_name, corporateNumber: row.corporate_number, invoiceRegistrationNumber: row.invoice_registration_number,
    postalCode: row.postal_code, address: row.address, capitalYen: row.capital_yen, selfPartnerId: row.self_partner_id ?? null,
    selfPartnerCode: row.self_partner_code ?? null, selfPartnerName: row.self_partner_name ?? null, openingMonth: row.opening_month ?? null,
    reason: row.reason, createdAt: row.created_at, createdByName: row.created_by_name ?? null,
  };
}

export async function loadAccounts(db, orgId) {
  return (await db.all('SELECT id, code, name, section, source, system_key, cash_effect, sort_order, note FROM gl_accounts WHERE org_id=? ORDER BY sort_order, code', [orgId]))
    .map((row) => ({id: row.id, code: row.code, name: row.name, section: row.section, source: row.source, systemKey: row.system_key, cashEffect: Boolean(row.cash_effect), sortOrder: row.sort_order, note: row.note}));
}

// 手入力の額のうち、取り消されていない元の行（取消の行と、取り消された元の行は除く）
export function liveManualRows(rows) {
  const reversed = new Set(rows.filter((row) => row.reverses_id != null).map((row) => row.reverses_id));
  return rows.filter((row) => row.reverses_id == null && !reversed.has(row.id));
}

// 作品の公開月: 全作品のウィンドウの劇場公開（確定・日か月まで）の最も早い月。無ければ最初に売上を計上した月（推定）
export async function releaseMonths(db, orgId) {
  const rows = await db.all(`SELECT w.work_id, v.start_on
    FROM work_release_windows w
    JOIN work_release_window_versions v ON v.org_id=w.org_id AND v.window_id=w.id
      AND v.version_no=(SELECT MAX(x.version_no) FROM work_release_window_versions x WHERE x.org_id=v.org_id AND x.window_id=v.window_id)
    JOIN release_window_type_versions t ON t.org_id=w.org_id AND t.type_id=w.type_id
      AND t.version_no=(SELECT MAX(y.version_no) FROM release_window_type_versions y WHERE y.org_id=t.org_id AND y.type_id=t.type_id)
    WHERE w.org_id=? AND t.family='theatrical' AND v.status='confirmed' AND v.date_precision IN ('day','month') AND v.start_on IS NOT NULL`, [orgId]);
  const out = new Map();
  for (const row of rows) {
    const month = monthOf(row.start_on);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (!out.has(row.work_id) || month < out.get(row.work_id)) out.set(row.work_id, month);
  }
  return out;
}

export async function loadPlBsInput(db, identity, ctx, {from, to, asOf, workIds, includeCompany}) {
  const orgId = identity.org_id;
  const end = asOf && asOf > to ? asOf : to;
  const shared = withSharedReads(db);
  const targetIds = new Set((workIds || []).map(Number));
  const allWorks = await db.all('SELECT id, project_id, code, title FROM works WHERE org_id=? ORDER BY code, id', [orgId]);
  const works = allWorks.filter((row) => targetIds.has(row.id));
  const ids = works.map((row) => row.id);
  const [profile, accounts, fiscal, terms, windowRelease] = await Promise.all([
    latestProfile(db, orgId), loadAccounts(db, orgId), fiscalSetting(db, orgId),
    ids.length ? loadCommitteeTerms(shared, orgId, ids) : new Map(), releaseMonths(db, orgId),
  ]);
  const selfPartnerId = profile?.selfPartnerId ?? null;
  const committeeIds = ids.filter((id) => terms.has(id));

  // 売上（作品へ配賦済み・税抜）と、同じ配賦で分けた税額
  const lines = ids.length ? await workSaleLines(shared, orgId, ids, {to: end}) : [];
  const taxRows = ids.length ? await db.all(`SELECT s.id, s.product_id, s.work_id, s.tax_amount FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=? AND r.status='active' AND s.accounting_month<=?`, [orgId, end]) : [];
  const productWorks = await db.all('SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=? ORDER BY product_id, work_id', [orgId]);
  const sharesOf = new Map();
  for (const row of productWorks) {
    if (!sharesOf.has(row.product_id)) sharesOf.set(row.product_id, []);
    sharesOf.get(row.product_id).push({work_id: row.work_id, allocation_bps: row.allocation_bps});
  }
  const taxSplit = new Map();
  for (const sale of taxRows) {
    let shares = sale.product_id ? sharesOf.get(sale.product_id) || [] : [];
    if (!shares.length) shares = [{work_id: sale.work_id, allocation_bps: 10000}];
    taxSplit.set(sale.id, splitByAllocation(sale.tax_amount, shares));
  }
  const saleLines = lines.map((line) => ({saleId: line.saleId, workId: line.workId, month: line.accountingMonth, amount: line.amount,
    tax: taxSplit.get(line.saleId)?.get(line.workId) ?? 0, channelGroup: line.channelGroup}));
  const firstSale = new Map();
  for (const line of saleLines) if (!firstSale.has(line.workId) || line.month < firstSale.get(line.workId)) firstSale.set(line.workId, line.month);

  // 経費と出金。作品を付けない経費（作品の決まっていない案件・作品が1本も無い案件の経費）は会社の分なので、会社全体を見る人だけに渡す
  const expenseRows = (await resolveExpenseAccounts(db,orgId,await db.all(`SELECT * FROM ${expenseSource({history:true})} WHERE org_id=? ORDER BY id`, [orgId])))
    .filter((row) => (row.work_id != null ? targetIds.has(row.work_id) : includeCompany));
  const expenseIds = new Set(expenseRows.map((row) => row.id));
  const expensePayments = (await db.all('SELECT id, expense_id, paid_on, amount_yen FROM expense_payments WHERE org_id=? ORDER BY id', [orgId]))
    .filter((row) => expenseIds.has(row.expense_id)).map((row) => ({id: row.id, expenseId: row.expense_id, paidOn: row.paid_on, amount: row.amount_yen}));

  const settlement=await loadSettlement(db,orgId);
  const expenseVoids=expenseRows.filter(e=>e.expense_voided_on);
  // 取消は取消月に反対額。過去の費用を消さない。
  for(const e of expenseVoids)expenseRows.push({...e,id:-e.id,accounting_month:e.expense_voided_on.slice(0,7),actual_ex_tax:-e.actual_ex_tax,tax_amount:-e.tax_amount,actual_inc_tax:-e.actual_inc_tax});
  const companyExpenseIds=new Set(expenseRows.filter(e=>e.id>0&&!terms.has(e.work_id)).map(e=>e.id));
  settlement.expenses=settlement.expenses.filter(e=>companyExpenseIds.has(e.id));
  settlement.payments=settlement.payments.filter(e=>companyExpenseIds.has(e.expense_id));
  settlement.records.expense_refund_receipts=settlement.records.expense_refund_receipts.filter(r=>companyExpenseIds.has(r.credit_expense_id));
  // 納付・引落は会社の資金。作品限定の帳票には組織全体の決済を渡さない。
  if(!includeCompany){settlement.records.expense_withholding_remittances=[];settlement.records.expense_card_debits=[];settlement.allocations=[];}
  const expenseSettlement=expenseBsAdjustments(settlement,{asOf:asOf??to,openingMonth:profile?.openingMonth});

  // ロイヤリティの発生額と支払（支払は報告書の明細の作品ごとの、前払金の充当を引いた額の比で分ける）
  const accruals = ids.length ? await loadRoyaltyAccruals(shared, identity, {workIds: ids, from: '0000-01', to: end}, ctx) : [];
  const royaltyAccruals = accruals.map((row) => ({workId: row.workId, month: row.accrualMonth, royaltyYen: row.royaltyYen, holdSalesYen: row.holdSalesYen}));
  // 前払金の充当（台帳・報告書と同じ式で、契約ごとに累計発生額が前払金に達するまで）。自社作品の未払ロイヤリティから引く
  const agreementWork = new Map(accruals.map((row) => [row.agreementId, Number(row.workId)]));
  const termRows = agreementWork.size ? await db.all('SELECT agreement_id, effective_from, advance_yen FROM royalty_term_versions WHERE org_id=? ORDER BY agreement_id, effective_from', [orgId]) : [];
  const termsByAgreement = new Map();
  for (const row of termRows) {
    if (!agreementWork.has(row.agreement_id)) continue;
    if (!termsByAgreement.has(row.agreement_id)) termsByAgreement.set(row.agreement_id, []);
    termsByAgreement.get(row.agreement_id).push({effectiveFrom: row.effective_from, advanceYen: Number(row.advance_yen) || 0});
  }
  const advanceOf = (agreementId, month) => termFor(termsByAgreement.get(agreementId), month)?.advanceYen ?? 0;
  const royaltyRecoups = advanceRecoupSeries({accruals: accruals.map((row) => ({agreementId: row.agreementId, month: row.accrualMonth, royaltyYen: row.royaltyYen})), advanceOf})
    .map((row) => ({workId: agreementWork.get(row.agreementId), agreementId: row.agreementId, month: row.month, amount: row.amount}));
  // 前払金のある契約（前払金の支払は記録していないので、BS では未確定の理由にする）
  const royaltyAdvances = [...termsByAgreement.entries()].map(([agreementId, versions]) => {
    const advanceYen = termFor(versions, end)?.advanceYen ?? Math.max(0, ...versions.map((row) => row.advanceYen));
    return {agreementId, workId: agreementWork.get(agreementId), advanceYen};
  }).filter((row) => row.advanceYen > 0);
  const [events, weights] = await Promise.all([
    db.all("SELECT id, statement_id, occurred_on, amount_yen, reverses_event_id FROM royalty_statement_events WHERE org_id=? AND event_kind='paid' ORDER BY id", [orgId]),
    // 充当の行は負にして足す（充当だけで済んだ作品に支払を回さない）。取り消した報告書の明細は使わない
    db.all(`SELECT l.statement_id, a.work_id, SUM(CASE WHEN l.line_kind='advance_recoup' THEN -l.amount_yen ELSE l.amount_yen END) AS amount
      FROM royalty_statement_lines l JOIN royalty_agreements a ON a.org_id=l.org_id AND a.id=l.agreement_id
      WHERE l.org_id=? AND l.line_kind IN ('accrual','revision','advance_recoup')
        AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=l.org_id AND v.statement_id=l.statement_id)
      GROUP BY l.statement_id, a.work_id`, [orgId]),
  ]);
  const weightsOf = new Map();
  for (const row of weights) {
    if (!weightsOf.has(row.statement_id)) weightsOf.set(row.statement_id, []);
    weightsOf.get(row.statement_id).push({workId: row.work_id, weight: Math.max(0, Number(row.amount) || 0)});
  }
  const royaltyPayments = [];
  for (const event of events) {
    const list = weightsOf.get(event.statement_id) || [];
    const inScope = list.filter((row) => targetIds.has(row.workId));
    // 会社全体を見ないときは、対象の作品に分かる分だけ（作品に分けられない支払は会社の分なので渡さない）
    if (!includeCompany && !inScope.length) continue;
    royaltyPayments.push({statementId: event.statement_id, paidOn: event.occurred_on, amount: event.reverses_event_id ? -event.amount_yen : event.amount_yen, weights: list});
  }

  // 製作委員会: 自社の取得額（委員会の月次収支と同じ計算）・出資の払込・委員会からの受取
  const committee = [];
  if (committeeIds.length) {
    const income = await loadCommitteeIncome(shared, identity, {workIds: committeeIds, from: '0000-01', to: end}, ctx);
    for (const workId of committeeIds) {
      const term = terms.get(workId);
      const selfMember = selfPartnerId ? term.members.find((member) => member.partnerId === selfPartnerId) : null;
      const committedYen = selfPartnerId ? term.investments?.find((row) => row.partnerId === selfPartnerId)?.amountYen ?? null : null;
      const entry = {workId, contractId: term.contract.id, contractCode: term.contract.code, selfShareBps: selfMember?.shareBps ?? null, committedYen, acquisitions: [], error: null, holdNote: null};
      try {
        if (!term.version) throw new Error('委員会契約に条件版がありません');
        const report = buildCommitteeMonthly({
          from: end, to: end, fiscalStartMonth: fiscal.fiscalStartMonth,
          incomeRows: income.rows.filter((row) => row.workId === workId), expenses: income.expenses.filter((row) => row.workId === workId),
          accruals: accruals.filter((row) => Number(row.workId) === workId && row.accrualMonth <= end),
          members: term.members, windows: term.windows, feeShares: term.feeShares, managerPartnerId: term.version.managerPartnerId, investments: term.investments, versions: term.versions,
        });
        if (selfPartnerId) {
          entry.acquisitions = report.monthly.filter((row) => row.investors[selfPartnerId]).map((row) => ({month: row.month, ...row.investors[selfPartnerId]}));
        }
        const holds = [];
        if (report.holds.windowMissing.length) holds.push(`窓口の条件が無い区分（${report.holds.windowMissing.map((row) => row.label).join('・')}）の売上を委員会の収入にしていません`);
        if (report.holds.royalty.length) holds.push('委員会の権利処理費に算定できない月があります');
        if (report.holds.unassignedWindowFee) holds.push('取り分の決まらない窓口手数料があります');
        entry.holdNote = holds.length ? `委員会の月次収支に保留があります: ${holds.join('／')}` : null;
      } catch (error) {
        entry.error = error.message;
      }
      committee.push(entry);
    }
  }
  // 出資の払込は、約定額（最新の条件版の出資額）を読んだのと同じ委員会契約の分だけ、全部の条件版をまとめて数える
  const investmentPayments = (await db.all(`SELECT p.id, p.term_version_id, p.partner_id, p.paid_on, p.amount_yen, c.work_id, v.contract_id FROM committee_investment_payments p
      JOIN committee_term_versions v ON v.org_id=p.org_id AND v.id=p.term_version_id JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id
      WHERE p.org_id=? ORDER BY p.id`, [orgId]))
    .filter((row) => targetIds.has(row.work_id) && (!terms.has(row.work_id) || terms.get(row.work_id).contract?.id === row.contract_id))
    .map((row) => ({workId: row.work_id, partnerId: row.partner_id, paidOn: row.paid_on, amount: row.amount_yen}));
  const committeeReceipts = selfPartnerId ? (await db.all(`SELECT e.paid_on, e.amount_yen, e.reverses_event_id, s.work_id FROM rights_payment_events e
      JOIN committee_report_snapshots s ON s.org_id=e.org_id AND s.id=e.committee_snapshot_id WHERE e.org_id=? AND e.partner_id=? ORDER BY e.id`, [orgId, selfPartnerId]))
    .filter((row) => targetIds.has(row.work_id)).map((row) => ({workId: row.work_id, receivedOn: row.paid_on, amount: row.reverses_event_id ? -row.amount_yen : row.amount_yen})) : [];

  // 請求の入金（入金を請求書の作品ごとの税込額の比で分ける。取消は取消日に負の額）
  const [allocations, invoiceLines] = await Promise.all([
    db.all(`SELECT a.receipt_id, a.invoice_id, a.amount_yen, r.received_on, x.reversed_on FROM billing_receipt_allocations a
      JOIN billing_receipts r ON r.org_id=a.org_id AND r.id=a.receipt_id LEFT JOIN billing_receipt_reversals x ON x.org_id=a.org_id AND x.receipt_id=a.receipt_id
      WHERE a.org_id=? ORDER BY a.receipt_id, a.invoice_id`, [orgId]),
    db.all(`SELECT l.invoice_id, l.sale_id, l.amount_inc_tax, lw.work_id, lw.allocation_bps FROM billing_invoice_lines l
      JOIN billing_invoice_line_works lw ON lw.org_id=l.org_id AND lw.invoice_id=l.invoice_id AND lw.sale_id=l.sale_id WHERE l.org_id=? ORDER BY l.invoice_id, l.sale_id, lw.work_id`, [orgId]),
  ]);
  const byInvoiceSale = new Map();
  for (const row of invoiceLines) {
    const key = `${row.invoice_id}:${row.sale_id}`;
    if (!byInvoiceSale.has(key)) byInvoiceSale.set(key, {invoiceId: row.invoice_id, amount: row.amount_inc_tax, shares: []});
    byInvoiceSale.get(key).shares.push({work_id: row.work_id, allocation_bps: row.allocation_bps});
  }
  const invoiceWeights = new Map();
  for (const item of byInvoiceSale.values()) {
    const total = item.shares.reduce((n, share) => n + share.allocation_bps, 0);
    if (total !== 10000) continue;
    const parts = splitByAllocation(item.amount, item.shares);
    if (!invoiceWeights.has(item.invoiceId)) invoiceWeights.set(item.invoiceId, new Map());
    const map = invoiceWeights.get(item.invoiceId);
    for (const [workId, amount] of parts) map.set(workId, (map.get(workId) || 0) + amount);
  }
  const receipts = [];
  for (const row of allocations) {
    const weightMap = invoiceWeights.get(row.invoice_id) || new Map();
    const list = [...weightMap.entries()].map(([workId, weight]) => ({workId, weight: Math.max(0, weight)}));
    if (!includeCompany && !list.some((item) => targetIds.has(item.workId))) continue;
    receipts.push({receiptId: row.receipt_id, invoiceId: row.invoice_id, receivedOn: row.received_on, amount: row.amount_yen, weights: list});
    if (row.reversed_on) receipts.push({receiptId: row.receipt_id, invoiceId: row.invoice_id, receivedOn: row.reversed_on, amount: -row.amount_yen, weights: list});
  }

  // 手入力の額（取り消されていない行）
  const manualRows = liveManualRows(await db.all('SELECT id, account_id, month, kind, amount_yen, tax_yen, work_id, status, reverses_id FROM gl_manual_amounts WHERE org_id=? ORDER BY id', [orgId]))
    .filter((row) => (row.work_id != null ? targetIds.has(row.work_id) : includeCompany))
    .map((row) => ({id: row.id, accountId: row.account_id, month: row.month, kind: row.kind, amount: row.amount_yen, tax: row.tax_yen ?? 0, workId: row.work_id, status: row.status}));

  // MG（参考）: 最新の条件版の保証額を商品評価の比で商品へ、商品配賦で作品へ分け、消化（充当）の累計を引く
  const mg = await loadMgMemo(db, orgId, sharesOf, targetIds);

  return {
    from, to, asOf, fiscal, profile, accounts,
    works: works.map((row) => ({id: row.id, code: row.code, title: row.title, projectId: row.project_id, committee: terms.has(row.id),
      releaseMonth: windowRelease.get(row.id) || firstSale.get(row.id) || null, releaseSource: windowRelease.has(row.id) ? 'window' : firstSale.has(row.id) ? 'first_sale' : null})),
    saleLines, expenses: expenseRows.map((row) => ({id: row.id, workId: row.work_id, projectId: row.project_id, month: row.accounting_month, category: row.category,
      accountId:row.expense_account_id,accountName:row.expense_account_name,section:row.expense_section,systemKey:row.expense_system_key,recognitionTiming:row.expense_recognition_timing,classificationOrigin:row.expense_classification_origin,
      exTax: row.actual_ex_tax, tax: row.tax_amount, incTax: row.actual_inc_tax})),
    expenseSettlement, expensePayments, royaltyAccruals, royaltyRecoups, royaltyAdvances, royaltyPayments, committee, investmentPayments, committeeReceipts, receipts, manual: manualRows, mg,
  };
}

async function loadMgMemo(db, orgId, sharesOf, targetIds) {
  const [versions, products, entries] = await Promise.all([
    db.all('SELECT id, incoming_contract_id, outgoing_contract_id, version, mg_amount_yen FROM mg_term_versions WHERE org_id=? ORDER BY id', [orgId]),
    db.all('SELECT term_version_id, product_id, evaluation_yen FROM mg_version_products WHERE org_id=? ORDER BY term_version_id, product_id', [orgId]),
    db.all('SELECT id, term_version_id, product_id, applied_recoup_yen, reverses_entry_id FROM mg_ledger_entries WHERE org_id=? ORDER BY id', [orgId]),
  ]);
  const superseded = new Set(entries.filter((row) => row.reverses_entry_id != null).map((row) => row.reverses_entry_id));
  const current = entries.filter((row) => !superseded.has(row.id));
  const contractKey = (row) => (row.incoming_contract_id ? `in:${row.incoming_contract_id}` : `out:${row.outgoing_contract_id}`);
  const latest = new Map();
  for (const row of versions) if (!latest.has(contractKey(row)) || latest.get(contractKey(row)).version < row.version) latest.set(contractKey(row), row);
  const versionContract = new Map(versions.map((row) => [row.id, contractKey(row)]));
  const out = [];
  for (const [key, version] of latest) {
    const direction = key.startsWith('in:') ? 'incoming' : 'outgoing';
    const own = products.filter((row) => row.term_version_id === version.id);
    const guaranteed = splitByWeights(version.mg_amount_yen, own.map((row) => ({key: row.product_id, weight: row.evaluation_yen}))) || new Map();
    const applied = new Map();
    for (const row of current.filter((item) => versionContract.get(item.term_version_id) === key)) applied.set(row.product_id, (applied.get(row.product_id) || 0) + row.applied_recoup_yen);
    for (const productId of new Set([...guaranteed.keys(), ...applied.keys()])) {
      const shares = sharesOf.get(productId) || [];
      if (!shares.length) continue;
      const g = splitByAllocation(guaranteed.get(productId) || 0, shares);
      const a = splitByAllocation(applied.get(productId) || 0, shares);
      for (const share of shares) if (targetIds.has(share.work_id)) out.push({workId: share.work_id, direction, guaranteedYen: g.get(share.work_id), appliedYen: a.get(share.work_id)});
    }
  }
  return out;
}
