// 売掛の見える化（純関数）。
// 1) 取引先別の月次残高: 前月残＋当月売上（計上月・税込）−当月入金（入金日・取消は取消日に戻す）＝当月残。
//    売上計上を起点にするので、請求していない売上・入金と一致しない請求が残高に現れ、処理するまで消えない。
// 2) 売掛金の一覧: 請求書ごとの入金済・残高・状態・期日からの経過日数と経過区分。

const monthIndex = (value) => {
  const [y, m] = value.split('-').map(Number);
  return y * 12 + (m - 1);
};

export function monthsRange(from, to) {
  const out = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i += 1) out.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
  return out;
}

// sales: [{partner_id, partner_name, month, amount}]、receipts: [{partner_id, partner_name, month, amount（取消は負）}]、unbilled: [{partner_id, month, amount}]
export function buildPartnerBalance({sales = [], receipts = [], unbilled = [], from, to}) {
  const months = monthsRange(from, to);
  const partners = new Map();
  const ensure = (id, name) => {
    if (!partners.has(id)) partners.set(id, {partnerId: id, partnerName: name, opening: 0, sales: months.map(() => 0), receipts: months.map(() => 0), unbilledAtEnd: 0});
    return partners.get(id);
  };
  for (const row of sales) {
    const p = ensure(row.partner_id, row.partner_name);
    if (row.month < from) p.opening += row.amount;
    else if (row.month <= to) p.sales[months.indexOf(row.month)] += row.amount;
  }
  for (const row of receipts) {
    const p = ensure(row.partner_id, row.partner_name);
    if (row.month < from) p.opening -= row.amount;
    else if (row.month <= to) p.receipts[months.indexOf(row.month)] += row.amount;
  }
  for (const row of unbilled) {
    if (row.month > to) continue;
    const p = ensure(row.partner_id, row.partner_name);
    p.unbilledAtEnd += row.amount;
  }
  const rows = [...partners.values()].map((p) => {
    const balances = [];
    let running = p.opening;
    months.forEach((_, i) => { running += p.sales[i] - p.receipts[i]; balances.push(running); });
    const salesTotal = p.sales.reduce((a, b) => a + b, 0);
    const receiptTotal = p.receipts.reduce((a, b) => a + b, 0);
    return {...p, balances, salesTotal, receiptTotal, closing: running};
  }).filter((p) => p.opening || p.salesTotal || p.receiptTotal || p.closing)
    .sort((a, b) => b.closing - a.closing || (a.partnerName || '').localeCompare(b.partnerName || '', 'ja'));
  const sum = (pick) => rows.reduce((total, row) => total + pick(row), 0);
  const totals = {
    opening: sum((r) => r.opening), sales: months.map((_, i) => sum((r) => r.sales[i])), receipts: months.map((_, i) => sum((r) => r.receipts[i])),
    balances: months.map((_, i) => sum((r) => r.balances[i])), salesTotal: sum((r) => r.salesTotal), receiptTotal: sum((r) => r.receiptTotal),
    closing: sum((r) => r.closing), unbilledAtEnd: sum((r) => r.unbilledAtEnd),
  };
  const checks = [{item: '期首残＋期間売上−期間入金−期末残（差0）', value: totals.opening + totals.salesTotal - totals.receiptTotal - totals.closing}];
  return {months, rows, totals, checks};
}

const DAY = 24 * 3600 * 1000;
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

export function agingBucket(overdueDays) {
  if (overdueDays === null) return '—';
  if (overdueDays <= 0) return '期日前';
  if (overdueDays <= 30) return '1〜30日';
  if (overdueDays <= 60) return '31〜60日';
  if (overdueDays <= 90) return '61〜90日';
  return '90日超';
}

// invoices: [{id, invoice_number, partner_id, partner_name, invoice_date, due_date, planned_date?, amount_inc_tax, voided_on}]、paid: Map(invoiceId→入金済)
// 期日超過は入金予定日（基準日までに承認された予定の変更を反映した日。無ければ支払期日）から数える。請求・入金と月別入金表と同じ基準
export function buildReceivables({invoices = [], paid = new Map(), asOf}) {
  return invoices.filter((inv) => inv.invoice_date <= asOf).map((inv) => {
    const voided = Boolean(inv.voided_on && inv.voided_on <= asOf);
    const received = paid.get(inv.id) || 0;
    const balance = voided ? 0 : inv.amount_inc_tax - received;
    let status;
    if (voided) status = '取消済み';
    else if (balance <= 0) status = '入金済み';
    else if (received > 0) status = '一部入金';
    else status = '未入金';
    const plannedDate = inv.planned_date || inv.due_date;
    const overdueDays = !voided && balance > 0 ? days(plannedDate, asOf) : null;
    if (overdueDays !== null && overdueDays > 0) status = `${status}・期日超過${overdueDays}日`;
    return {
      invoiceId: inv.id, invoiceNumber: inv.invoice_number, partnerId: inv.partner_id, partnerName: inv.partner_name,
      invoiceDate: inv.invoice_date, dueDate: inv.due_date, plannedDate, amount: inv.amount_inc_tax, received, balance, status,
      overdueDays, aging: agingBucket(overdueDays), open: !voided && balance > 0,
    };
  }).sort((a, b) => (b.overdueDays ?? -99999) - (a.overdueDays ?? -99999) || a.plannedDate.localeCompare(b.plannedDate));
}
