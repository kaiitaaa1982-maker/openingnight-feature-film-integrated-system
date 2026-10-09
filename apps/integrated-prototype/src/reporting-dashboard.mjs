// 年間推移ダッシュボードのAPI（GET /api/reports/annual-dashboard）。会社全体（財務権限のある作品だけ）の
// 売上（計上月・販売月）・請求・入金を同じ月の列に並べ、月末の未請求残・未入金残と前年比を返す。税込。
// 売上は配賦先の作品すべてに財務権限がある明細だけ、請求は明細の作品すべてに財務権限がある請求書だけを数える（売掛と同じ境界）。
// node:* を import しない（Worker でも動く）。
import {buildAnnualDashboard, monthsBetween, DASHBOARD_SERIES} from './reports/annual-dashboard-model.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

export function registerDashboardRoutes(app, {db, bad, settlementWork}) {
  async function allowedWorks(i) {
    const works = await db.all('SELECT id FROM works WHERE org_id=?', [i.org_id]);
    const allowed = new Set();
    for (const work of works) if (await settlementWork(i, work.id)) allowed.add(work.id);
    return allowed;
  }

  // 計上月が期間より後でも販売月が期間内の明細があるため、計上月は期間末の2年後まで読む（年間売上の販売月基準と同じ）
  async function visibleSales(i, allowed, to) {
    const rows = await db.all(`SELECT s.id, s.work_id, s.product_id, s.accounting_month, s.sales_period_from, s.amount_inc_tax, rr.sales_month
      FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id AND r.status='active'
      LEFT JOIN report_recognition rr ON rr.org_id=s.org_id AND rr.report_id=s.report_id
      WHERE s.org_id=? AND r.kind<>'publicity' AND s.accounting_month<=?`, [i.org_id, shiftMonth(to, 24)]);
    const maps = await db.all('SELECT product_id, work_id FROM product_works WHERE org_id=?', [i.org_id]);
    return rows.filter((s) => {
      const allocated = s.product_id ? maps.filter((m) => m.product_id === s.product_id).map((m) => m.work_id) : [];
      return (allocated.length ? allocated : [s.work_id]).every((id) => allowed.has(id));
    }).map((s) => ({
      id: s.id, accounting_month: s.accounting_month, amount: Number(s.amount_inc_tax),
      sales_month: s.sales_month || String(s.sales_period_from || '').slice(0, 7) || s.accounting_month,
    }));
  }

  app.get('/api/reports/annual-dashboard', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '帳票への財務権限がありません', 403);
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!MONTH.test(from || '') || !MONTH.test(to || '') || from > to) return bad(c, '期間（from・to）を「2026-05」の形で、開始≦終了で指定してください');
    const months = monthsBetween(from, to);
    if (months.length > 36) return bad(c, '期間は36か月以内で指定してください');
    const allowed = await allowedWorks(i);

    const sales = await visibleSales(i, allowed, to);
    const history = await db.all(`SELECT l.sale_id, inv.invoice_date, v.voided_on FROM billing_invoice_lines l
      JOIN billing_invoices inv ON inv.org_id=l.org_id AND inv.id=l.invoice_id
      LEFT JOIN billing_invoice_voids v ON v.org_id=l.org_id AND v.invoice_id=l.invoice_id WHERE l.org_id=?`, [i.org_id]);
    const invoicesOfSale = new Map();
    for (const row of history) {
      if (!invoicesOfSale.has(row.sale_id)) invoicesOfSale.set(row.sale_id, []);
      invoicesOfSale.get(row.sale_id).push({invoice_date: row.invoice_date, voided_on: row.voided_on});
    }
    for (const sale of sales) sale.invoices = invoicesOfSale.get(sale.id) || [];

    const invoiceRows = await db.all(`SELECT inv.id, inv.invoice_date, inv.amount_inc_tax, v.voided_on FROM billing_invoices inv
      LEFT JOIN billing_invoice_voids v ON v.org_id=inv.org_id AND v.invoice_id=inv.id WHERE inv.org_id=? AND inv.invoice_date<=?`, [i.org_id, `${to}-31`]);
    const lineWorks = await db.all('SELECT DISTINCT invoice_id, work_id FROM billing_invoice_line_works WHERE org_id=?', [i.org_id]);
    const invoices = invoiceRows.filter((inv) => {
      const list = lineWorks.filter((w) => w.invoice_id === inv.id);
      return list.length > 0 && list.every((w) => allowed.has(w.work_id));
    }).map((inv) => ({id: inv.id, invoice_date: inv.invoice_date, voided_on: inv.voided_on, amount: Number(inv.amount_inc_tax)}));
    const invoiceIds = new Set(invoices.map((inv) => inv.id));
    const receipts = invoiceIds.size ? (await db.all(`SELECT a.invoice_id, a.amount_yen, r.received_on, v.reversed_on
      FROM billing_receipt_allocations a JOIN billing_receipts r ON r.org_id=a.org_id AND r.id=a.receipt_id
      LEFT JOIN billing_receipt_reversals v ON v.org_id=r.org_id AND v.receipt_id=r.id WHERE a.org_id=?`, [i.org_id]))
      .filter((row) => invoiceIds.has(row.invoice_id))
      .map((row) => ({invoice_id: row.invoice_id, received_on: row.received_on, reversed_on: row.reversed_on, amount: Number(row.amount_yen)})) : [];

    const previousFrom = shiftMonth(from, -12);
    const previousTo = shiftMonth(to, -12);
    const previousSalesTotal = sales.filter((s) => s.accounting_month >= previousFrom && s.accounting_month <= previousTo).reduce((sum, s) => sum + s.amount, 0);

    const result = buildAnnualDashboard({months, sales, invoices, receipts, previousSalesTotal: previousSalesTotal || null});
    const latest = await db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active' AND kind<>'publicity'", [i.org_id]);
    return c.json({
      ok: true, from, to, ...result, series: DASHBOARD_SERIES,
      values: result.series,
      previous: {from: previousFrom, to: previousTo, sales: previousSalesTotal || 0},
      dataAsOf: {latestImportAt: latest?.at || null, generatedAt: new Date().toISOString()},
      basis: '金額は税込。売上は財務権限のある作品へ配賦された有効な報告の明細、請求・入金は明細の作品すべてに財務権限がある請求書だけ。請求・入金の取消は取消日の月に差し戻す。',
    });
  });
}
