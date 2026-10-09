const windowFields={grossReported:'gross_reported_yen',netReported:'net_reported_yen',platformFeeKnown:'platform_fee_known_yen',platformNet:'platform_net_yen',windowFee:'window_fee_yen',managerFee:'manager_fee_yen',expenseTotal:'expense_yen',distributionPool:'distribution_pool_yen',residual:'residual_yen'};
// Each collection has its own grain. Join dimensions, never multiply these fact tables together.
export function flattenCommitteeSnapshots(snapshots){
 const periods=[],windows=[],members=[],sources=[];
 for(const row of snapshots){const calc=row.calculation||JSON.parse(row.calculation_json),base={org_id:row.org_id,snapshot_id:row.id,work_id:row.work_id,contract_id:row.contract_id,term_version_id:row.term_version_id,period_from:row.period_from,period_to:row.period_to,period_date_basis:row.period_date_basis,status:row.status||'draft',verification:row.verification||'unverified'};
  periods.push({...base,close_on:row.close_on,report_on:row.report_on,payment_on:row.payment_on,calculation_version:row.calculation_version});
  for(const w of calc.windows){const windowId=w.windowId??w.kind;windows.push({...base,window_id:windowId,channel:w.kind,route:w.route,fee_order:w.feeOrder,window_fee_basis:w.windowFeeBasis,manager_fee_basis:w.managerFeeBasis,...Object.fromEntries(Object.entries(windowFields).map(([key,column])=>[column,w[key]||0]))});for(const p of w.payouts)members.push({...base,window_id:windowId,channel:w.kind,partner_id:p.partnerId,share_bps:p.shareBps,distribution_yen:p.amount,route:p.route})}
  for(const line of calc.lines||[])sources.push({...base,window_id:line.windowId,report_id:line.reportId,sale_id:line.saleId,source_row:line.sourceRow,allocation_bps:line.allocationBps,accounting_month:line.accountingMonth,allocated_amount_ex_tax:line.allocatedAmountExTax});
 }
 return {committee_periods:periods,committee_windows:windows,committee_members:members,committee_sources:sources};
}
export function flattenRightsPayments(events){return events.map(e=>({...e,signed_amount_yen:e.reverses_event_id?-e.amount_yen:e.amount_yen,payment_month:e.paid_on.slice(0,7),event_kind:e.reverses_event_id?'reversal':'payment'}))}
