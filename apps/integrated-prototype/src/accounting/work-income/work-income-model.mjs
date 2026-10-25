// 作品の月別収支（/api/analytics/income）の計算。売上明細を作品へ配り、経費と月別に並べる。DB に触れない
// （読み取りは accounting/accounting-store.mjs、受け口は work-income-routes.mjs）。
// 月別の行は売上か経費のある月だけで、数字の無い月を0円で埋めない。埋めるかは画面が選ぶ（reports/work-pnl-model.mjs の incomeRows の fillGaps）。
// 基準は計上（buildWorkIncome。計上月）と入金（buildWorkIncomeCash。入金日・出金日の月。フェーズ1 #16）
import {splitByAllocation} from '../../money-allocation.mjs';
import {cashReceiptParts, cashExpenseParts, unsettledReasonLabel} from '../../reports/pl-bs-cash-model.mjs';

// 見てよい作品: 見てよい案件（projectIds）に属する作品の ID
export function permittedWorkIds(works, projectIds) {
  return new Set(works.filter(w => projectIds.includes(w.project_id)).map(w => w.id));
}

// 売上明細を作品へ配る。商品の配賦（product_works）が無い明細は明細の作品へ全額。税抜と税を別々に分ける（最大剰余法。money.md）。
// 見てよい作品（permitted）と、絞った作品（workFilter）の分だけを返す
function allocateSaleLines(sales, mappings, permitted, workFilter) {
  const allocated = [];
  for (const sale of sales) {
    let shares = sale.product_id ? mappings.filter(x => x.product_id === sale.product_id) : [];
    if (!shares.length) shares = [{work_id: sale.work_id, allocation_bps: 10000}];
    if (shares.reduce((n, x) => n + x.allocation_bps, 0) !== 10000) throw Error('商品配賦が100%ではありません');
    const ex = splitByAllocation(sale.amount_ex_tax, shares), tax = splitByAllocation(sale.tax_amount, shares);
    for (const share of shares) if (permitted.has(share.work_id) && (!workFilter || workFilter === share.work_id)) allocated.push({sale_id: sale.id, allocated_work_id: share.work_id, allocation_bps: share.allocation_bps, accounting_month: sale.accounting_month, amount_ex_tax: ex.get(share.work_id), tax_amount: tax.get(share.work_id), amount_inc_tax: ex.get(share.work_id) + tax.get(share.work_id)});
  }
  return allocated;
}

const sum = (rows, key) => { const n = rows.reduce((v, r) => v + r[key], 0); if (!Number.isSafeInteger(n)) throw Error('集計金額が試作の整数範囲を超えています'); return n; };

// projectIds: 見てよい案件の ID（財務の権限）。works: 組織の作品（id・project_id）。sales: 有効な売上明細。mappings: 商品の配賦。
// expenses: 取消を除いた経費。monthFilter・workFilter: 絞り込み（読み取りの側でも月で絞ってある）
export function buildWorkIncome({projectIds, works, sales, mappings, expenses, monthFilter = null, workFilter = null}) {
  const permitted = permittedWorkIds(works, projectIds);
  const allocated = allocateSaleLines(sales, mappings, permitted, workFilter);
  const visibleExpenses = expenses.filter(e => projectIds.includes(e.project_id));
  const selectedExpenses = visibleExpenses.filter(e => !workFilter || e.work_id === workFilter);
  const monthKeys = [...new Set([...allocated.map(r => r.accounting_month), ...selectedExpenses.map(r => r.accounting_month)])].sort();
  const monthly = monthKeys.map(m => { const revenue = sum(allocated.filter(r => r.accounting_month === m), 'amount_ex_tax'), cost = sum(selectedExpenses.filter(r => r.accounting_month === m), 'actual_ex_tax'); return {month: m, revenue, cost, profit: revenue - cost}; });
  return {
    filters: {month: monthFilter || null, workId: workFilter},
    sales: {exTax: sum(allocated, 'amount_ex_tax'), tax: sum(allocated, 'tax_amount'), incTax: sum(allocated, 'amount_inc_tax')},
    expenses: {exTax: sum(selectedExpenses, 'actual_ex_tax'), tax: sum(selectedExpenses, 'tax_amount'), incTax: sum(selectedExpenses, 'actual_inc_tax'), budget: selectedExpenses.reduce((n, r) => n + (r.budget_yen || 0), 0)},
    unallocatedProjectExpenses: visibleExpenses.filter(e => e.work_id == null && (!workFilter || e.project_id === works.find(w => w.id === workFilter)?.project_id)),
    profitExTax: sum(allocated, 'amount_ex_tax') - sum(selectedExpenses, 'actual_ex_tax'),
    monthly,
    source: 'sale_lines + expenses; campaigns are not joined',
    allocatedLines: allocated,
  };
}

// 入金ベース（basis=cash。フェーズ1 #16）の作品の月別収支。売上は請求の入金（消込で結んだ請求明細の作品の配賦）を入金日の月に、
// 経費は出金を出金日の月に並べ、どちらも reports/pl-bs-cash-model.mjs の税抜換算（U-5 まで仮の出し方）で税抜にする。
// 税抜にできない入出金は unsettled（税込）に分け、売上・経費・差引に入れない。作品の配賦がそろわない入金（作品を決められない入金）は、作品で絞らず、
// その請求の全部の作品が見てよい作品のときだけ unsettled の行に入れる（ほかの作品の額が混ざるため）。行に入れられない分のうち、
// 見ている作品（作品で絞ったときはその作品、絞らないときは見てよい作品）を含む入金は、額を出さずに件数を unsettled.unattachedReceiptCount で返す
// （作品の月別収支の画面は常に作品で絞るので、件数が無いと黙って消える。作品別収支の unattachedReceiptCount と同じ数え方）。
// 経費の範囲は計上と同じ（作品で絞ると作品の経費だけ、絞らないと見てよい案件の経費すべて）。月の行は入出金のある月だけ
export function buildWorkIncomeCash({projectIds, works, expenses, cashSide = {}, monthFilter = null, workFilter = null}) {
  const permitted = permittedWorkIds(works, projectIds);
  const inScope = (workId) => permitted.has(workId) && (!workFilter || workFilter === workId);
  const inMonth = (row) => Boolean(row.month) && (!monthFilter || row.month === monthFilter);
  const receipts = cashReceiptParts(cashSide);
  const lines = receipts.settled.filter((part) => inScope(part.workId) && inMonth(part));
  const visibleExpenses = expenses.filter(e => projectIds.includes(e.project_id));
  const selectedExpenses = visibleExpenses.filter(e => !workFilter || e.work_id === workFilter);
  const paid = cashExpenseParts({expenses: selectedExpenses.map(e => ({...e, id: Number(e.id), exTax: e.actual_ex_tax, incTax: e.actual_inc_tax})), payments: cashSide.expensePayments || []});
  const outflows = paid.settled.filter(inMonth);
  const unattachedShown = (part) => !workFilter && part.workIds.length > 0 && part.workIds.every((id) => permitted.has(id));
  const unattachedReceiptCount = new Set(receipts.unsettled.filter((part) => part.workId === null && inMonth(part) && !unattachedShown(part) && part.workIds.some(inScope))
    .map((part) => part.receiptId)).size;
  const unsettled = [
    ...receipts.unsettled.filter((part) => inMonth(part) && (part.workId === null ? unattachedShown(part) : inScope(part.workId)))
      .map((part) => ({direction: 'in', kind: 'receipt', workId: part.workId, on: part.on, month: part.month, amount: part.amount, reason: part.reason, reasonLabel: unsettledReasonLabel(part.reason),
        receiptId: part.receiptId, invoiceId: part.invoiceId})),
    ...paid.unsettled.filter(inMonth).map((part) => ({direction: 'out', kind: 'expense', workId: part.expense.work_id ?? null, on: part.on, month: part.month, amount: part.amount,
      reason: part.reason, reasonLabel: unsettledReasonLabel(part.reason), expenseId: part.expense.id, paymentId: part.paymentId})),
  ].sort((a, b) => a.on.localeCompare(b.on) || a.direction.localeCompare(b.direction));
  const monthKeys = [...new Set([...lines.map(r => r.month), ...outflows.map(r => r.month)])].sort();
  const monthly = monthKeys.map(m => {
    const revenue = sum(lines.filter(r => r.month === m), 'amount'), cost = sum(outflows.filter(r => r.month === m), 'exTax');
    return {month: m, revenue, cost, profit: revenue - cost};
  });
  const revenue = sum(lines, 'amount'), cost = sum(outflows, 'exTax');
  return {
    filters: {month: monthFilter || null, workId: workFilter},
    // 入金ベースの税額・税込は出さない（税抜にした額だけ。入金の税抜の出し方は U-5）
    sales: {exTax: revenue, tax: null, incTax: null},
    expenses: {exTax: cost, tax: null, incTax: null, budget: null},
    unallocatedProjectExpenses: visibleExpenses.filter(e => e.work_id == null && (!workFilter || e.project_id === works.find(w => w.id === workFilter)?.project_id)),
    profitExTax: revenue - cost,
    monthly,
    unsettled: {rows: unsettled, inflowYen: sum(unsettled.filter(r => r.direction === 'in'), 'amount'), outflowYen: sum(unsettled.filter(r => r.direction === 'out'), 'amount'), unattachedReceiptCount},
    source: 'billing_receipts（消込で結んだ請求明細） + expense_payments; campaigns are not joined',
    allocatedLines: lines.map((part) => ({sale_id: part.saleId, receipt_id: part.receiptId, invoice_id: part.invoiceId, allocated_work_id: part.workId, allocation_bps: part.bps,
      received_on: part.on, month: part.month, amount_ex_tax: part.amount, tax_amount: null, amount_inc_tax: null})),
  };
}
