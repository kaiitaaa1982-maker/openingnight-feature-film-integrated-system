// シナリオの比較（段A）の材料を DB から読む。読むだけで書かない。Worker でも動くよう node:* を import しない。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の「段A」の表。実績は PL・BS の材料（loadPlBsInput）をそのまま使い、
// ここで足す SQL は 作品・商談・活動・作品の費用の最新の版・分配契約・請求明細 の6本（作品の数に依らない固定の本数）。
// 作品→源泉の対応は作品の費用の最新の版（自社出資額・買付額）と分配契約（委託・MG）で決め、契約一覧の権利の取得（kind='acquisition'）は読まない。
// 分配契約（委託・MG）のある作品だけ settlementPreviewData（app.mjs。1作品 約7本）を呼ぶ。売上明細は workSaleLines（loadPlBsInput と同じ要求の中で分け合う）。
// 作品の範囲は呼び出し側が渡す案件（財務の権限がある案件）で絞る。どの行も組織（identity.org_id）で絞る。
import {loadPlBsInput} from '../../pl-bs/pl-bs-data.mjs';
import {workSaleLines, withSharedReads} from '../../sales/channel-group.mjs';

export async function readScenarioSources(db, identity, ctx, {projectIds, period, closedMonth}) {
  const orgId = identity.org_id;
  const shared = withSharedReads(db);
  const allowed = new Set(projectIds);
  const works = (await shared.all('SELECT id, project_id FROM works WHERE org_id=? ORDER BY id', [orgId])).filter((row) => allowed.has(row.project_id));
  const workIds = works.map((row) => row.id);
  if (!workIds.length) return null;
  const workSet = new Set(workIds);

  // 実績は締めた月まで（期間の終わりが締めた月より前でも、累計の回収は締めた月まで数える）
  const plbs = await loadPlBsInput(shared, identity, ctx, {from: period.from, to: closedMonth, asOf: closedMonth, workIds, includeCompany: false});
  const [lines, opportunities, activities, finance, contracts, invoiceLines] = await Promise.all([
    workSaleLines(shared, orgId, workIds, {to: closedMonth}),
    shared.all(`SELECT o.id, o.work_id, o.partner_id, o.name, o.stage, o.expected_yen, o.close_date, p.kind AS partner_kind
      FROM sales_opportunities o JOIN partners p ON p.org_id=o.org_id AND p.id=o.partner_id WHERE o.org_id=? ORDER BY o.id`, [orgId]),
    shared.all(`SELECT id, opportunity_id, work_id, occurred_on, activity_type FROM sales_activities
      WHERE org_id=? AND substr(occurred_on,1,7) BETWEEN ? AND ? ORDER BY id`, [orgId, period.from, period.to]),
    shared.all(`SELECT f.work_id, f.own_investment_yen, f.sales_rights_purchase_yen FROM work_finance_versions f
      WHERE f.org_id=? AND f.revision=(SELECT MAX(x.revision) FROM work_finance_versions x WHERE x.org_id=f.org_id AND x.work_id=f.work_id) ORDER BY f.work_id`, [orgId]),
    shared.all('SELECT id, work_id, contract_type FROM settlement_contracts WHERE org_id=? ORDER BY id', [orgId]),
    shared.all(`SELECT l.invoice_id, l.sale_id, l.amount_inc_tax, lw.work_id, lw.allocation_bps FROM billing_invoice_lines l
      JOIN billing_invoice_line_works lw ON lw.org_id=l.org_id AND lw.invoice_id=l.invoice_id AND lw.sale_id=l.sale_id
      WHERE l.org_id=? ORDER BY l.invoice_id, l.sale_id, lw.work_id`, [orgId]),
  ]);
  const settlementContracts = contracts.filter((row) => workSet.has(row.work_id)).map((row) => ({id: row.id, workId: row.work_id, contractType: row.contract_type}));

  // 分配契約（委託・MG）のある作品の試算。期間で絞れるよう行ごとの計上月を残す
  const previews = new Map();
  for (const workId of [...new Set(settlementContracts.filter((row) => row.contractType !== 'self_owned').map((row) => row.workId))].sort((a, b) => a - b)) {
    const preview = await ctx.settlementPreviewData(identity, workId);
    previews.set(workId, {
      lineResults: preview.lineResults.map((row) => ({contractId: row.contractId, contractType: row.contractType, reportId: row.reportId, accountingMonth: row.accountingMonth,
        agencyFee: row.agencyFee, holderAmount: row.holderAmount})),
      contractSummaries: preview.contractSummaries.map((row) => ({contractId: row.contractId, contractType: row.contractType, mgContractYen: row.mgContractYen ?? null, mgBalance: row.mgBalance ?? null})),
      linkedReportIds: preview.linkedReports.map((row) => row.id),
      unlinkedReportIds: preview.unlinkedReports.map((row) => row.id),
    });
  }

  return {
    workIds,
    selfPartnerId: plbs.profile?.selfPartnerId ?? null,
    works: plbs.works.map((row) => ({id: row.id, code: row.code, title: row.title, projectId: row.projectId, committee: row.committee, releaseMonth: row.releaseMonth, releaseSource: row.releaseSource})),
    saleLines: lines.map((line) => ({saleId: line.saleId, reportId: line.reportId, workId: line.workId, partnerId: line.partnerId, month: line.accountingMonth, amount: line.amount, channelGroup: line.channelGroup})),
    committee: plbs.committee, investmentPayments: plbs.investmentPayments, receipts: plbs.receipts,
    opportunities: opportunities.filter((row) => workSet.has(row.work_id)).map((row) => ({id: row.id, workId: row.work_id, partnerId: row.partner_id, partnerKind: row.partner_kind,
      name: row.name, stage: row.stage, expectedYen: row.expected_yen, closeDate: row.close_date})),
    activities: activities.filter((row) => workSet.has(row.work_id)).map((row) => ({id: row.id, opportunityId: row.opportunity_id, occurredOn: row.occurred_on, activityType: row.activity_type})),
    finance: finance.filter((row) => workSet.has(row.work_id)).map((row) => ({workId: row.work_id, ownInvestmentYen: row.own_investment_yen, salesRightsPurchaseYen: row.sales_rights_purchase_yen})),
    settlementContracts,
    invoiceLines: invoiceLines.map((row) => ({invoiceId: row.invoice_id, saleId: row.sale_id, amountIncTax: row.amount_inc_tax, workId: row.work_id, allocationBps: row.allocation_bps})),
    previews,
  };
}
