// 年間推移ダッシュボード（純関数）。同じ期間の月ごとに、売上（計上月・販売月）・請求（請求日）・入金（入金日）を並べ、
// 月末時点の未請求残・未入金残を出す。金額はすべて税込（請求書・入金が税込のため、比べられるようにそろえる）。
// 請求の取消は取消日の月に、入金の取消は取消日の月に負の値で戻す（元の月は書き換えない）。

export const DASHBOARD_SERIES = Object.freeze([
  {key: 'salesAccounting', label: '売上（計上月）', note: '報告の計上月で数えた売上'},
  {key: 'salesSales', label: '売上（販売月）', note: '販売が発生した月で数えた売上。販売月の無い報告は販売期間の開始月'},
  {key: 'billed', label: '請求', note: '請求日の月。取消は取消日の月に差し戻す'},
  {key: 'received', label: '入金', note: '入金日の月。取消は取消日の月に差し戻す'},
]);

const monthEnd = (month) => `${month}-31`;
const monthLabel = (month) => `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
const monthOf = (date) => String(date || '').slice(0, 7);
// その日の終わりの時点で、有効な（発行済みで取り消されていない）請求に入っているか
export const billedAt = (sale, end) => (sale.invoices || []).some((inv) => inv.invoice_date <= end && !(inv.voided_on && inv.voided_on <= end));

export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// sales: [{id, accounting_month, sales_month, amount, invoices: [{invoice_date, voided_on}]}]（amount は税込。invoices はその売上を含んだ請求の履歴。取消後に再請求すると2件）
// invoices: [{id, invoice_date, voided_on, amount}]、receipts: [{invoice_id, received_on, reversed_on, amount}]
export function buildAnnualDashboard({months, sales = [], invoices = [], receipts = [], previousSalesTotal = null}) {
  const index = new Map(months.map((month, i) => [month, i]));
  const zero = () => months.map(() => 0);
  const series = {salesAccounting: zero(), salesSales: zero(), billed: zero(), received: zero()};
  const add = (key, month, amount) => { const i = index.get(month); if (i !== undefined) series[key][i] += amount; };
  for (const sale of sales) {
    add('salesAccounting', sale.accounting_month, sale.amount);
    add('salesSales', sale.sales_month || sale.accounting_month, sale.amount);
  }
  for (const invoice of invoices) {
    add('billed', monthOf(invoice.invoice_date), invoice.amount);
    if (invoice.voided_on) add('billed', monthOf(invoice.voided_on), -invoice.amount);
  }
  for (const receipt of receipts) {
    add('received', monthOf(receipt.received_on), receipt.amount);
    if (receipt.reversed_on) add('received', monthOf(receipt.reversed_on), -receipt.amount);
  }

  // 月末時点の残高。未請求残＝その月末までに計上した売上のうち、月末時点で有効な請求に入っていないもの。
  // 未入金残＝その月末までに発行し取り消されていない請求の、月末までの入金（取消済みを除く）を引いた残り。
  const unbilled = months.map((month) => {
    const end = monthEnd(month);
    return sales.filter((s) => s.accounting_month <= month && !billedAt(s, end)).reduce((sum, s) => sum + s.amount, 0);
  });
  const unpaid = months.map((month) => {
    const end = monthEnd(month);
    let total = 0;
    for (const invoice of invoices) {
      if (invoice.invoice_date > end || (invoice.voided_on && invoice.voided_on <= end)) continue;
      const paid = receipts.filter((r) => r.invoice_id === invoice.id && r.received_on <= end && !(r.reversed_on && r.reversed_on <= end))
        .reduce((sum, r) => sum + r.amount, 0);
      total += Math.max(0, invoice.amount - paid);
    }
    return total;
  });

  const sum = (values) => values.reduce((a, b) => a + b, 0);
  const totals = Object.fromEntries(Object.keys(series).map((key) => [key, sum(series[key])]));
  const last = months.length - 1;
  const kpis = {
    sales: totals.salesAccounting,
    billed: totals.billed,
    received: totals.received,
    unbilledAtEnd: last >= 0 ? unbilled[last] : 0,
    unpaidAtEnd: last >= 0 ? unpaid[last] : 0,
    previousSales: previousSalesTotal,
    yoy: previousSalesTotal ? totals.salesAccounting / previousSalesTotal : null,
  };
  const rows = months.map((month, i) => ({
    month, salesAccounting: series.salesAccounting[i], salesSales: series.salesSales[i], billed: series.billed[i], received: series.received[i],
    unbilled: unbilled[i], unpaid: unpaid[i],
  }));
  const attention = [];
  if (kpis.unbilledAtEnd > 0) attention.push({key: 'unbilled', message: `期末（${monthLabel(months[last])}末）時点で未請求の売上が残っています`});
  if (kpis.unpaidAtEnd > 0) attention.push({key: 'unpaid', message: `期末（${monthLabel(months[last])}末）時点で入金されていない請求が残っています`});
  return {months, series, rows, totals, kpis, attention};
}

// 1行の要約（折りたたんだときの表示）
export function dashboardSummary(result, formatYen) {
  if (!result) return '';
  const {kpis} = result;
  const parts = [`売上 ${formatYen(kpis.sales)}`, `請求 ${formatYen(kpis.billed)}`, `入金 ${formatYen(kpis.received)}`];
  if (kpis.unbilledAtEnd) parts.push(`未請求 ${formatYen(kpis.unbilledAtEnd)}`);
  if (kpis.unpaidAtEnd) parts.push(`未入金 ${formatYen(kpis.unpaidAtEnd)}`);
  return parts.join('・');
}
