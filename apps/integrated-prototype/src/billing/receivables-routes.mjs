// 売掛のAPI。請求書は、その明細の作品すべてに財務権限がある場合だけ対象にする（既存の入金表と同じ境界）。
import {allIn} from '../sql-in.mjs';
import {buildPartnerBalance, buildReceivables} from './receivables.mjs';
import {billedAt} from '../reports/annual-dashboard-model.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function registerReceivablesRoutes(app, {db, bad, settlementWork}) {
  async function scope(i) {
    const works = await db.all('SELECT id FROM works WHERE org_id=?', [i.org_id]);
    const allowed = new Set();
    for (const work of works) if (await settlementWork(i, work.id)) allowed.add(work.id);
    return allowed;
  }
  async function invoicesInScope(i, allowed) {
    const invoices = await db.all(`SELECT inv.id, inv.invoice_number, inv.partner_id, p.name AS partner_name, inv.invoice_date, inv.due_date, inv.amount_inc_tax, v.voided_on
      FROM billing_invoices inv JOIN partners p ON p.org_id=inv.org_id AND p.id=inv.partner_id LEFT JOIN billing_invoice_voids v ON v.org_id=inv.org_id AND v.invoice_id=inv.id
      WHERE inv.org_id=? ORDER BY inv.invoice_date, inv.id`, [i.org_id]);
    const works = await db.all('SELECT DISTINCT invoice_id, work_id FROM billing_invoice_line_works WHERE org_id=?', [i.org_id]);
    return invoices.filter((inv) => {
      const list = works.filter((w) => w.invoice_id === inv.id);
      return list.length > 0 && list.every((w) => allowed.has(w.work_id));
    });
  }
  async function receiptEvents(i, invoiceIds) {
    return allIn(db, `SELECT a.invoice_id, a.amount_yen, r.partner_id, p.name AS partner_name, r.received_on, v.reversed_on
      FROM billing_receipt_allocations a JOIN billing_receipts r ON r.org_id=a.org_id AND r.id=a.receipt_id
      JOIN partners p ON p.org_id=r.org_id AND p.id=r.partner_id
      LEFT JOIN billing_receipt_reversals v ON v.org_id=r.org_id AND v.receipt_id=r.id
      WHERE a.org_id=? AND a.invoice_id IN (:in)`, {before: [i.org_id], ids: invoiceIds});
  }

  app.get('/api/billing/receivables', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '売掛は財務担当の画面です', 403);
    const asOf = c.req.query('asOf') || todayJst();
    if (!DATE.test(asOf)) return bad(c, '基準日は「2026-09-30」の形で指定してください');
    const allowed = await scope(i);
    const invoices = await invoicesInScope(i, allowed);
    const events = await receiptEvents(i, invoices.map((inv) => inv.id));
    // 基準日までに承認された入金予定の変更（最新の版）を入金予定日にする（commercial.mjs の billingState と同じ条件）
    const plans = await allIn(db, `SELECT q.invoice_id, q.proposed_due_date, d.version_no FROM receipt_plan_requests q
      JOIN receipt_plan_decisions d ON d.org_id=q.org_id AND d.request_id=q.id
      WHERE q.org_id=? AND d.decision='approved' AND d.effective_on<=? AND q.invoice_id IN (:in)`, {before: [i.org_id, asOf], ids: invoices.map((inv) => inv.id)});
    const latestPlan = new Map();
    for (const plan of plans) if (!latestPlan.has(plan.invoice_id) || plan.version_no > latestPlan.get(plan.invoice_id).version_no) latestPlan.set(plan.invoice_id, plan);
    for (const inv of invoices) inv.planned_date = latestPlan.get(inv.id)?.proposed_due_date || inv.due_date;
    const paid = new Map();
    for (const e of events) {
      if (e.received_on > asOf) continue;
      if (e.reversed_on && e.reversed_on <= asOf) continue;
      paid.set(e.invoice_id, (paid.get(e.invoice_id) || 0) + e.amount_yen);
    }
    const rows = buildReceivables({invoices, paid, asOf});
    const open = rows.filter((row) => row.open);
    return c.json({ok: true, asOf, rows, totals: {count: rows.length, open: open.length, balance: open.reduce((s, r) => s + r.balance, 0),
      overdue: open.filter((r) => r.overdueDays > 0).reduce((s, r) => s + r.balance, 0)}});
  });

  app.get('/api/reports/partner-balance', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '売掛は財務担当の帳票です', 403);
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!MONTH.test(from || '') || !MONTH.test(to || '') || from > to) return bad(c, '期間（from・to）を「2026-05」の形で、開始≦終了で指定してください');
    const allowed = await scope(i);
    const maps = await db.all('SELECT product_id, work_id FROM product_works WHERE org_id=?', [i.org_id]);
    const saleRows = await db.all(`SELECT s.id, s.partner_id, p.name AS partner_name, s.accounting_month AS month, s.amount_inc_tax AS amount, s.work_id, s.product_id
      FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id AND r.status='active'
      JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
      WHERE s.org_id=? AND s.accounting_month<=?`, [i.org_id, to]);
    // 請求の取消で請求の紐付けは消えるため、期末時点で請求済みだったかは請求明細の履歴（請求日・取消日）で判定する
    const history = await db.all(`SELECT l.sale_id, inv.invoice_date, v.voided_on FROM billing_invoice_lines l
      JOIN billing_invoices inv ON inv.org_id=l.org_id AND inv.id=l.invoice_id
      LEFT JOIN billing_invoice_voids v ON v.org_id=l.org_id AND v.invoice_id=l.invoice_id WHERE l.org_id=?`, [i.org_id]);
    const invoicesOfSale = new Map();
    for (const row of history) {
      if (!invoicesOfSale.has(row.sale_id)) invoicesOfSale.set(row.sale_id, []);
      invoicesOfSale.get(row.sale_id).push({invoice_date: row.invoice_date, voided_on: row.voided_on});
    }
    const visible = saleRows.filter((s) => {
      const allocated = s.product_id ? maps.filter((m) => m.product_id === s.product_id).map((m) => m.work_id) : [];
      return (allocated.length ? allocated : [s.work_id]).every((id) => allowed.has(id));
    });
    const invoices = await invoicesInScope(i, allowed);
    const events = await receiptEvents(i, invoices.map((inv) => inv.id));
    const receipts = [];
    for (const e of events) {
      receipts.push({partner_id: e.partner_id, partner_name: e.partner_name, month: e.received_on.slice(0, 7), amount: e.amount_yen});
      if (e.reversed_on) receipts.push({partner_id: e.partner_id, partner_name: e.partner_name, month: e.reversed_on.slice(0, 7), amount: -e.amount_yen});
    }
    const endOfPeriod = `${to}-31`;
    const unbilled = visible.filter((s) => !billedAt({invoices: invoicesOfSale.get(s.id) || []}, endOfPeriod)).map((s) => ({partner_id: s.partner_id, partner_name: s.partner_name, month: s.month, amount: s.amount}));
    const report = buildPartnerBalance({sales: visible, receipts, unbilled, from, to});
    return c.json({ok: true, from, to, ...report, basis: '売上は計上月・税込、入金は入金日（取消は取消日に差し戻し）。残高は売上から入金を引いた売掛で、未請求の売上も含む。'});
  });
}
