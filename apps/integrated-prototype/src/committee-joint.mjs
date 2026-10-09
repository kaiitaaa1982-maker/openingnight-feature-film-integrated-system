// Joint production, cash-basis settlement. This version is independent of the
// older per-window committee calculation and never rewrites its snapshots.
export const jointCalculationVersion = 'joint_cash_v1';
const yen = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`${label}は0以上の安全な整数円が必要です`);
  return value;
};
const safe = value => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) throw Error('計算額が安全な整数円の範囲外です');
  return Number(value);
};
const sum = (rows, key) => safe(rows.reduce((n, row) => n + BigInt(yen(row[key], key)), 0n));
const rate = (value, bps) => {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw Error('料率は0〜10000bpです');
  return safe(BigInt(yen(value, '料率基礎')) * BigInt(bps) / 10000n);
};
const date = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('日付はYYYY-MM-DD形式です');
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== value) throw Error('存在しない日付です');
  return d;
};
const iso = d => d.toISOString().slice(0, 10);
function nextMonthDay(from, offsetMonths, day) {
  const d = date(from), target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day === 'eom' ? last : Math.min(day, last))));
}
export function priorBusinessDay(value, holidays = []) {
  const blocked = new Set(holidays);
  const d = date(value);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || blocked.has(iso(d))) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}
export function calculateJointPeriods({contract, members, windows, periods, receipts, costs, holidays = []}) {
  if (members.length !== 2 || members.filter(m => m.role === 'investor').length !== 2 || members.reduce((n, m) => n + m.shareBps, 0) !== 10000) throw Error('共同製作の出資者2社と持分100%が必要です');
  if (!members.some(m => m.partnerId === contract.managerPartnerId) || members.some(m => m.partnerId === contract.producerPartnerId)) throw Error('幹事は出資者、受託制作会社は委員会外です');
  if (contract.managerPartnerId === contract.producerPartnerId) throw Error('幹事と受託制作会社は別会社です');
  yen(contract.productionCostIncTaxYen, '税込直接製作費'); yen(contract.paIncTaxYen, '税込P&A');
  yen(contract.incomeThresholdYen, '委員会収入の繰越閾値');
  yen(contract.transferThresholdYen, '窓口送金の繰越閾値');
  const knownWindows = new Set(windows.map(w => w.id));
  if (knownWindows.size !== windows.length || windows.some(w => !members.some(m => m.partnerId === w.partnerId))) throw Error('窓口担当は出資者から明示してください');
  const seenSources = new Set();
  for (const row of [...receipts, ...costs]) {
    if (seenSources.has(row.sourceRef)) throw Error('証憑識別子を期間・費目間で再利用できません');
    seenSources.add(row.sourceRef);
    if (row.windowId != null && !knownWindows.has(row.windowId)) throw Error('窓口が契約条件にありません');
    yen(row.amountYen, '収入または費用');
  }
  if(costs.some(row=>row.taxBasis!=='inc_tax'))throw Error('共同製作・入金基準では費用も税込契約額に統一してください');
  const sorted = [...periods].sort((a, b) => a.sequence - b.sequence);
  const sequenceSet=new Set(sorted.map(p=>p.sequence));
  if(sequenceSet.size!==sorted.length||receipts.some(r=>!sequenceSet.has(r.periodSequence))||costs.some(r=>!sequenceSet.has(r.periodSequence)))throw Error('収入・費用の期間が契約日程にありません');
  let carry = new Map(windows.map(w => [w.id, {grossIncTaxYen: 0, committeeIncomeYen: 0, sourceRefs: []}]));
  const usedCashMonths=new Set();
  const results = [];
  for (const period of sorted) {
    date(period.from); date(period.to);
    if (period.from > period.to) throw Error('期間の開始と終了が逆転しています');
    const reported = receipts.filter(r => r.periodSequence === period.sequence);
    const periodCosts = costs.filter(r => r.periodSequence === period.sequence);
    const windowResults = windows.map(window => {
      const rows = reported.filter(r => r.windowId === window.id);
      const direct = periodCosts.filter(r => r.kind === 'window_direct' && r.windowId === window.id);
      const music = periodCosts.filter(r => r.kind === 'music_window_paid' && r.windowId === window.id);
      const netReceiptYen = sum(rows, 'amountYen');
      const grossIncTaxYen = sum(rows, 'grossIncTaxYen');
      const directExpenseYen = sum(direct, 'amountYen');
      const musicFeeYen = sum(music, 'amountYen');
      if (directExpenseYen > netReceiptYen) throw Error('窓口直接経費が正味収入を超えます。赤字期の扱いは未確定です');
      const windowFeeYen = rate(netReceiptYen - directExpenseYen, window.feeBps);
      const committeeIncomeYen = netReceiptYen - directExpenseYen - windowFeeYen - musicFeeYen;
      if (committeeIncomeYen < 0) throw Error('窓口収入が負です。赤字期の扱いは未確定です');
      const previous = carry.get(window.id), availableGrossIncTaxYen = safe(BigInt(previous.grossIncTaxYen) + BigInt(grossIncTaxYen));
      const availableCommitteeIncomeYen = safe(BigInt(previous.committeeIncomeYen) + BigInt(committeeIncomeYen));
      const incomeDeferred = availableCommitteeIncomeYen < contract.incomeThresholdYen;
      const transferDeferredByGross = availableGrossIncTaxYen < contract.transferThresholdYen;
      const transferDeferred = incomeDeferred || transferDeferredByGross;
      const receiptDates=rows.map(r=>r.managerReceiptOn).filter(Boolean).sort();
      if(receiptDates.some(d=>d<period.from))throw Error('売上対象期間より前の実入金日は指定できません');
      if(receiptDates.length && receiptDates.length!==rows.length)throw Error('同一期の入金済みと未着金の売上を一括受入できません');
      if(new Set(receiptDates.map(d=>d.slice(0,7))).size>1)throw Error('同一窓口の異なる実入金月を一つの分配期に合算できません');
      const managerReceiptOn=receiptDates.at(-1)||null;
      if (!transferDeferred && availableCommitteeIncomeYen && !managerReceiptOn) throw Error('窓口送金の実入金日が必要です');
      if (transferDeferred && managerReceiptOn) throw Error('少額繰越中に実入金日を登録できません');
      carry.set(window.id, transferDeferred ? {grossIncTaxYen: availableGrossIncTaxYen, committeeIncomeYen: availableCommitteeIncomeYen, sourceRefs: [...previous.sourceRefs, ...rows.map(r => r.sourceRef)]} : {grossIncTaxYen: 0, committeeIncomeYen: 0, sourceRefs: []});
      return {windowId: window.id, windowLabel: window.label, partnerId: window.partnerId, grossIncTaxYen, netReceiptYen, directExpenseYen, windowFeeBasisYen: netReceiptYen - directExpenseYen, windowFeeYen, musicFeeYen, committeeIncomeYen, previousCarryYen: previous.committeeIncomeYen, previousGrossCarryYen:previous.grossIncTaxYen, incomeComparisonYen:availableCommitteeIncomeYen, transferComparisonYen:availableGrossIncTaxYen, cashReceivedYen: transferDeferred ? 0 : availableCommitteeIncomeYen, carriedYen: transferDeferred ? availableCommitteeIncomeYen : 0, incomeDeferred, transferDeferredByGross, transferDeferred, managerReceiptOn, receiptRefs: rows.map(r => r.sourceRef), releasedSourceRefs: transferDeferred ? [] : [...previous.sourceRefs, ...rows.map(r => r.sourceRef)], windowReportDueOn: nextMonthDay(period.to, window.reportOffsetMonths, window.reportDay), windowPaymentDueOn: priorBusinessDay(nextMonthDay(period.to, window.paymentOffsetMonths, window.paymentDay), holidays)};
    });
    const committeeIncomeYen = sum(windowResults, 'cashReceivedYen');
    const rightsCostYen = sum(periodCosts.filter(r => r.kind === 'rights_manager'), 'amountYen');
    const masterCostYen = sum(periodCosts.filter(r => r.kind === 'master_management'), 'amountYen');
    const bankAdvanceYen = sum(periodCosts.filter(r => r.kind === 'bank_advance'), 'amountYen');
    const managerFeeBasisYen = committeeIncomeYen - rightsCostYen;
    if (managerFeeBasisYen < 0) throw Error('幹事料の基礎が負です。赤字期の扱いは未確定です');
    const managerFeeYen = rate(managerFeeBasisYen, contract.managerFeeBps);
    // Demo assumption: repayment of a documented bank advance precedes member
    // distribution and does not reduce the manager-fee basis.
    const distributableYen = managerFeeBasisYen - managerFeeYen - masterCostYen - bankAdvanceYen;
    if (distributableYen < 0) throw Error('分配原資が負です。立替残高の扱いを人が決めてください');
    const distributions = members.map(member => {
      const earnedYen = rate(distributableYen, member.shareBps);
      return {partnerId: member.partnerId, shareBps: member.shareBps, earnedYen, paidYen: 0, outstandingYen: earnedYen};
    });
    const roundingResidualYen = distributableYen - sum(distributions, 'earnedYen');
    const managerReceiptOn = windowResults.map(w => w.managerReceiptOn).filter(Boolean).sort().at(-1) || null;
    if(new Set(windowResults.map(w=>w.managerReceiptOn?.slice(0,7)).filter(Boolean)).size>1)throw Error('異なる実入金月は同一分配期に合算できません');
    const cashMonth=managerReceiptOn?.slice(0,7)||null;
    if(cashMonth&&usedCashMonths.has(cashMonth))throw Error('別の売上対象期が同じ実入金月に重なります。月次一括計算が必要です');
    if(cashMonth)usedCashMonths.add(cashMonth);
    const cashAsOf=managerReceiptOn?nextMonthDay(managerReceiptOn,0,'eom'):null;
    const investorReportDueOn = managerReceiptOn ? nextMonthDay(managerReceiptOn, contract.investorReportOffsetMonths, contract.investorReportDay) : null;
    const investorPaymentDueOn = managerReceiptOn ? nextMonthDay(managerReceiptOn, contract.investorPaymentOffsetMonths, contract.investorPaymentDay) : null;
    if (investorPaymentDueOn && investorPaymentDueOn < investorReportDueOn) throw Error('出資者支払予定日が報告予定日より前です');
    results.push({periodSequence: period.sequence, from: period.from, to: period.to, managerReceiptOn, cashAsOf, windows: windowResults, committeeIncomeYen, rightsCostYen, managerFeeBasisYen, managerFeeYen, masterCostYen, bankAdvanceRepaidYen: bankAdvanceYen, distributableYen, roundingResidualYen, investorReportDueOn, investorPaymentDueOn, distributions, calculationVersion: jointCalculationVersion, assumptions: ['銀行手数料立替は分配前に優先返済し、幹事料基礎は減らさない', '端数は円未満切捨て、残額は分配せず明示', '通常の製作費・MG優先回収は適用しない', '出資者支払日は契約文脈を超えて休日調整しない']});
  }
  return results;
}

export const jointExportColumns = {
  joint_window_periods: ['contract_id','period_sequence','as_of','calculation_version','tax_basis','window_id','window_label','partner_id','partner_name','gross_inc_tax_yen','net_receipt_contract_yen','direct_expense_yen','window_fee_yen','music_fee_yen','committee_income_yen','previous_carry_yen','previous_gross_carry_yen','income_comparison_yen','transfer_comparison_yen','income_deferred','transfer_deferred_by_gross','cash_received_yen','carried_yen','manager_receipt_on','report_due_on','payment_due_on'],
  joint_period_totals: ['contract_id','period_sequence','as_of','manager_receipt_on','cash_as_of','calculation_version','tax_basis','cash_received_yen','rights_cost_yen','manager_fee_basis_yen','manager_fee_yen','master_cost_yen','bank_advance_repaid_yen','distributable_yen','rounding_residual_yen','investor_report_due_on','investor_payment_due_on'],
  joint_member_distributions: ['contract_id','period_sequence','as_of','manager_receipt_on','cash_as_of','calculation_version','tax_basis','partner_id','partner_name','share_bps','earned_yen','paid_yen','outstanding_yen','payment_due_on'],
  joint_production_milestones: ['contract_id','calculation_version','tax_basis','stage','due_on','condition_met_on','acceptance_on','amount_inc_tax_yen','paid_on','paid_inc_tax_yen']
};
export function jointExportRows(contractId, results, milestones = [], partnerNames = {}) {
  const common={contract_id:contractId,calculation_version:jointCalculationVersion,tax_basis:'inc_tax'};
  return {
    joint_window_periods: results.flatMap(p => p.windows.map(w => ({...common,period_sequence:p.periodSequence,as_of:p.to,window_id:w.windowId,window_label:w.windowLabel,partner_id:w.partnerId,partner_name:partnerNames[w.partnerId]||'',gross_inc_tax_yen:w.grossIncTaxYen,net_receipt_contract_yen:w.netReceiptYen,direct_expense_yen:w.directExpenseYen,window_fee_yen:w.windowFeeYen,music_fee_yen:w.musicFeeYen,committee_income_yen:w.committeeIncomeYen,previous_carry_yen:w.previousCarryYen,previous_gross_carry_yen:w.previousGrossCarryYen,income_comparison_yen:w.incomeComparisonYen,transfer_comparison_yen:w.transferComparisonYen,income_deferred:w.incomeDeferred?1:0,transfer_deferred_by_gross:w.transferDeferredByGross?1:0,cash_received_yen:w.cashReceivedYen,carried_yen:w.carriedYen,manager_receipt_on:w.managerReceiptOn,report_due_on:w.windowReportDueOn,payment_due_on:w.windowPaymentDueOn}))),
    joint_period_totals: results.map(p => ({...common,period_sequence:p.periodSequence,as_of:p.to,manager_receipt_on:p.managerReceiptOn,cash_as_of:p.cashAsOf,cash_received_yen:p.committeeIncomeYen,rights_cost_yen:p.rightsCostYen,manager_fee_basis_yen:p.managerFeeBasisYen,manager_fee_yen:p.managerFeeYen,master_cost_yen:p.masterCostYen,bank_advance_repaid_yen:p.bankAdvanceRepaidYen,distributable_yen:p.distributableYen,rounding_residual_yen:p.roundingResidualYen,investor_report_due_on:p.investorReportDueOn,investor_payment_due_on:p.investorPaymentDueOn})),
    joint_member_distributions: results.flatMap(p => p.distributions.map(d => ({...common,period_sequence:p.periodSequence,as_of:p.to,manager_receipt_on:p.managerReceiptOn,cash_as_of:p.cashAsOf,partner_id:d.partnerId,partner_name:partnerNames[d.partnerId]||'',share_bps:d.shareBps,earned_yen:d.earnedYen,paid_yen:d.paidYen,outstanding_yen:d.outstandingYen,payment_due_on:p.investorPaymentDueOn}))),
    joint_production_milestones: milestones.map(m => ({...common,stage:m.stage,due_on:m.due_on,condition_met_on:m.condition_met_on,acceptance_on:m.acceptance_on,amount_inc_tax_yen:m.amount_inc_tax_yen,paid_on:m.paid_on,paid_inc_tax_yen:m.paid_inc_tax_yen}))
  };
}
