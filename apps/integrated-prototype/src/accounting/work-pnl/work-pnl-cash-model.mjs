// 作品別収支の入金ベース（basis=cash。フェーズ1の仕様書 #16）の行。DB・時刻に触れない純関数。
// 売上は請求の入金（消込で結んだ請求明細のこの作品の分）を入金日の月に、経費は出金を出金日の月に並べ、どちらも
// src/reports/pl-bs-cash-model.mjs の税抜換算（U-5 まで仮の出し方）で税抜にする。期間（from〜to）の月の分だけを返す。
// 税抜にできない入出金（請求額と違う入金・経費の税込額と違う出金）は「未確定」に税込のまま並べ、作品計に入れない。
// 作品を決められない入金（請求明細の配賦がそろわない消込）は、ほかの作品の額が混ざるので、この作品の帳票には件数だけを返す
import {cashReceiptParts, cashExpenseParts, unsettledReasonLabel} from '../../reports/pl-bs-cash-model.mjs';

// 売上明細の行（work-pnl-report-routes.mjs の workPnlLines）から入金の行へ写す項目
const SALE_FIELDS = ['report_id', 'report_key', 'source_row', 'description', 'quantity', 'accounting_month', 'partner_id', 'partner_name', 'partner_code',
  'product_id', 'product_sku', 'product_name', 'distribution_code', 'distribution_label', 'deal', 'deal_label'];

const expenseInput = (row) => ({...row, id: Number(row.id), exTax: row.actual_ex_tax, incTax: row.actual_inc_tax});
// 出金の行: 経費の行の表示の項目に、出金の識別・出金日・月・税抜の額・出金の額を付ける（id は出金の ID。経費の ID は expense_id）
const paymentRow = (part, extra) => {
  const {exTax, incTax, ...expense} = part.expense;
  return {...expense, id: part.paymentId, expense_id: expense.id, paid_on: part.on, month: part.month, ...extra};
};

// 期間（from〜to）に入ったこの作品の確定の入金が指す売上明細の ID（受け口はこの明細だけを読み、入金の行の流通・取引先などの元にする）
export function cashSaleIds({workId, from, to, cashSide = {}}) {
  const inPeriod = (month) => Boolean(month) && month >= from && month <= to;
  return [...new Set(cashReceiptParts(cashSide).settled.filter((part) => part.workId === workId && inPeriod(part.month)).map((part) => part.saleId))].sort((a, b) => a - b);
}

// lines: この作品の売上明細（入金の行の流通・取引先などの元。cashSaleIds の明細を計上月によらず）。expenses・unallocatedExpenses: この作品の経費・案件の未配賦の経費の全期間。
// cashSide: pl-bs-data.mjs の loadCashSide
export function workPnlCashRows({workId, from, to, lines = [], expenses = [], unallocatedExpenses = [], cashSide = {}}) {
  const inPeriod = (month) => Boolean(month) && month >= from && month <= to;
  const saleOf = new Map(lines.map((line) => [Number(line.id), line]));
  const receipts = cashReceiptParts(cashSide);
  const cashLines = receipts.settled.filter((part) => part.workId === workId && inPeriod(part.month)).map((part) => {
    const sale = saleOf.get(part.saleId) || {};
    return {
      ...Object.fromEntries(SALE_FIELDS.map((key) => [key, sale[key] ?? null])),
      distribution_code: sale.distribution_code ?? 'other', distribution_label: sale.distribution_label ?? '未確認', deal: sale.deal ?? 'unverified', deal_label: sale.deal_label ?? '未確認',
      id: part.saleId, receipt_id: part.receiptId, invoice_id: part.invoiceId, received_on: part.on, month: part.month, allocation_bps: part.bps, amount: part.amount,
    };
  });
  const payments = cashSide.expensePayments || [];
  const workPaid = cashExpenseParts({expenses: expenses.map(expenseInput), payments});
  const unallocatedPaid = cashExpenseParts({expenses: unallocatedExpenses.map(expenseInput), payments});
  const settledRows = (paid) => paid.settled.filter((part) => inPeriod(part.month))
    .map((part) => paymentRow(part, {actual_ex_tax: part.exTax, paid_amount: part.amount}));
  const unsettledOf = (paid, kind, kindLabel) => paid.unsettled.filter((part) => inPeriod(part.month)).map((part) => ({
    kind, kindLabel, on: part.on, month: part.month, amount: part.amount, reason: part.reason, reasonLabel: unsettledReasonLabel(part.reason),
    ref: `経費 ${part.expense.id}・出金 ${part.paymentId}`, category: part.expense.category ?? null,
  }));
  const unsettled = [
    ...receipts.unsettled.filter((part) => part.workId === workId && inPeriod(part.month)).map((part) => ({
      kind: 'receipt', kindLabel: '入金', on: part.on, month: part.month, amount: part.amount, reason: part.reason, reasonLabel: unsettledReasonLabel(part.reason),
      ref: `入金 ${part.receiptId}・請求 ${part.invoiceId}`, category: null,
    })),
    ...unsettledOf(workPaid, 'expense', '作品の経費の出金'),
    ...unsettledOf(unallocatedPaid, 'unallocated', '未配賦の経費の出金'),
  ].sort((a, b) => a.on.localeCompare(b.on) || a.kind.localeCompare(b.kind));
  const unattachedReceiptCount = new Set(receipts.unsettled.filter((part) => part.workId === null && part.workIds.includes(workId) && inPeriod(part.month))
    .map((part) => part.receiptId)).size;
  return {lines: cashLines, expenses: settledRows(workPaid), unallocatedExpenses: settledRows(unallocatedPaid), unsettled, unattachedReceiptCount};
}
