// 会社全体の売上明細一覧（閲覧権限のある作品だけ）。登録済みの売上をスプレッドシートで確かめ、Excel/CSVで出す場所。
// 1行＝売上明細1件。商品の作品配賦がある明細は、配賦先の作品すべてに財務権限がある場合だけ表示する。
import {splitByAllocation} from '../money-allocation.mjs';
import {DISTRIBUTION_TYPE_LABELS_SQL} from '../distribution-label.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const KIND_LABELS = {theatrical: '劇場', digital: '配信', package: 'ビデオグラム', broadcast: '放送', other: 'その他'};
// 流通区分が記録されていない明細は、報告の種類から既定の流通区分にする（reporting-annual の KIND_CODE と同じ）
const KIND_CODE = {digital: 'digital_unknown', package: 'package_unknown', theatrical: 'theatrical', broadcast: 'broadcast_unknown'};
export const SALES_LIST_LIMIT = 5000;

export function registerSalesLinesRoutes(app, {db, bad, permittedProjects}) {
  app.get('/api/sales-lines', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '売上明細は財務担当の画面です', 403);
    const finance = new Set((await permittedProjects(db, i, true)).map((p) => p.id));
    const works = (await db.all('SELECT id, project_id, code, title FROM works WHERE org_id=?', [i.org_id])).filter((w) => finance.has(w.project_id));
    const visible = new Map(works.map((w) => [w.id, w]));
    const from = c.req.query('from') || null;
    const to = c.req.query('to') || null;
    if ((from && !MONTH.test(from)) || (to && !MONTH.test(to))) return bad(c, '期間は「2026-05」の形で指定してください');
    const workId = c.req.query('workId') ? Number(c.req.query('workId')) : null;
    const partnerId = c.req.query('partnerId') ? Number(c.req.query('partnerId')) : null;
    const kind = c.req.query('kind') || null;
    const billing = c.req.query('billing') || null;
    const distribution = c.req.query('distribution') || null;
    // 年間売上の商品別・取引区分別から開くときの条件。productId=none は商品を決めていない明細
    const productParam = c.req.query('productId') || null;
    const deal = c.req.query('deal') || null;
    const q = String(c.req.query('q') || '').trim().normalize('NFKC').toLowerCase();
    if (workId && !visible.has(workId)) return bad(c, '作品への財務権限がありません', 403);
    const where = ['s.org_id=?', "r.status='active'"];
    const params = [i.org_id];
    if (from) { where.push('s.accounting_month>=?'); params.push(from); }
    if (to) { where.push('s.accounting_month<=?'); params.push(to); }
    if (partnerId) { where.push('s.partner_id=?'); params.push(partnerId); }
    if (kind) { where.push('r.kind=?'); params.push(kind); }
    if (productParam === 'none') where.push('s.product_id IS NULL');
    else if (productParam) { where.push('s.product_id=?'); params.push(Number(productParam)); }
    const rows = await db.all(`SELECT s.id, s.work_id, s.product_id, s.partner_id, s.report_id, s.source_row, s.description, s.quantity,
        s.accounting_month, s.sales_period_from, s.sales_period_to, s.amount_ex_tax, s.tax_amount, s.amount_inc_tax, s.created_at,
        r.kind, r.report_key, r.status AS report_status, r.supersedes_id, rr.sales_month,
        p.code AS partner_code, p.name AS partner_name, pr.sku AS product_sku, pr.name AS product_name,
        bc.invoice_id, bi.invoice_number, bi.due_date, bi.amount_inc_tax AS invoice_amount, bv.voided_on, d.distribution_code, d.settlement_method
      FROM sale_lines s
      JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
      JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
      LEFT JOIN products pr ON pr.org_id=s.org_id AND pr.id=s.product_id
      LEFT JOIN report_recognition rr ON rr.org_id=s.org_id AND rr.report_id=s.report_id
      LEFT JOIN billing_sale_claims bc ON bc.org_id=s.org_id AND bc.sale_id=s.id
      LEFT JOIN billing_invoices bi ON bi.org_id=s.org_id AND bi.id=bc.invoice_id
      LEFT JOIN billing_invoice_voids bv ON bv.org_id=s.org_id AND bv.invoice_id=bc.invoice_id
      LEFT JOIN sale_distribution_versions d ON d.org_id=s.org_id AND d.sale_id=s.id
        AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=s.org_id AND x.sale_id=s.id)
      WHERE ${where.join(' AND ')} ORDER BY s.accounting_month DESC, s.id DESC`, params);
    const maps = await db.all('SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=?', [i.org_id]);
    const sharesOf = (row) => {
      const allocated = row.product_id ? maps.filter((m) => m.product_id === row.product_id) : [];
      return allocated.length ? allocated.map((m) => ({work_id: m.work_id, allocation_bps: m.allocation_bps})) : [{work_id: row.work_id, allocation_bps: 10000}];
    };
    const worksOf = (row) => sharesOf(row).map((share) => share.work_id);
    // 作品で絞るときは、複数の作品に配賦した商品の明細をその作品の配賦分だけで数える（年間売上・作品別収支と同じ規則）
    const shareOf = (row, amount) => {
      if (!workId || amount == null) return amount;
      const shares = sharesOf(row);
      if (shares.length === 1) return amount;
      try { return splitByAllocation(Number(amount), shares).get(workId) ?? 0; } catch { return amount; }
    };
    const paid = new Map((await db.all(`SELECT a.invoice_id, SUM(CASE WHEN v.receipt_id IS NULL THEN a.amount_yen ELSE 0 END) AS paid
      FROM billing_receipt_allocations a JOIN billing_receipts r ON r.org_id=a.org_id AND r.id=a.receipt_id
      LEFT JOIN billing_receipt_reversals v ON v.org_id=r.org_id AND v.receipt_id=r.id WHERE a.org_id=? GROUP BY a.invoice_id`, [i.org_id])).map((row) => [row.invoice_id, Number(row.paid || 0)]));
    const types = distribution ? await db.all(DISTRIBUTION_TYPE_LABELS_SQL) : [];
    const distributionLabel = distribution ? types.find((t) => t.code === distribution)?.label || distribution : null;
    const out = [];
    for (const row of rows) {
      const distributionCode = row.distribution_code || KIND_CODE[row.kind] || 'other';
      if (distribution && distributionCode !== distribution) continue;
      if (deal && (row.settlement_method || 'unverified') !== deal) continue;
      const workIds = worksOf(row);
      if (!workIds.every((id) => visible.has(id))) continue;
      if (workId && !workIds.includes(workId)) continue;
      const billed = row.invoice_id && !row.voided_on;
      const billingStatus = !row.invoice_id ? '未請求' : row.voided_on ? '請求取消' : '請求済';
      if (billing === 'unbilled' && billed) continue;
      if (billing === 'billed' && !billed) continue;
      const invoicePaid = billed ? paid.get(row.invoice_id) || 0 : 0;
      const receiptStatus = !billed ? '—' : invoicePaid >= row.invoice_amount ? '入金済' : invoicePaid > 0 ? '一部入金' : '未入金';
      const titles = workIds.map((id) => visible.get(id).title);
      const line = {
        id: row.id, accounting_month: row.accounting_month, sales_month: row.sales_month || null,
        sales_period: `${row.sales_period_from}〜${row.sales_period_to}`,
        partner_id: row.partner_id, partner_name: row.partner_name, partner_code: row.partner_code,
        work_titles: titles.join('、'), work_ids: workIds, product_sku: row.product_sku, product_name: row.product_name || '（作品に直接計上）',
        kind: row.kind, kind_label: KIND_LABELS[row.kind] || row.kind, distribution_code: distributionCode, description: row.description, quantity: row.quantity,
        amount_ex_tax: shareOf(row, row.amount_ex_tax), tax_amount: shareOf(row, row.tax_amount), amount_inc_tax: shareOf(row, row.amount_inc_tax),
        allocation_bps: workId ? (sharesOf(row).find((share) => share.work_id === workId)?.allocation_bps ?? 10000) : null,
        original_amount_ex_tax: row.amount_ex_tax,
        report_id: row.report_id, report_key: row.report_key, source_row: row.source_row, corrected: Boolean(row.supersedes_id),
        billing_status: billingStatus, invoice_number: row.invoice_number || null, receipt_status: receiptStatus, created_at: row.created_at,
      };
      if (q && ![line.partner_name, line.partner_code, line.work_titles, line.product_name, line.product_sku, line.description, line.report_key]
        .some((value) => String(value || '').normalize('NFKC').toLowerCase().includes(q))) continue;
      out.push(line);
    }
    if (out.length > SALES_LIST_LIMIT) return bad(c, `該当が${out.length.toLocaleString('ja-JP')}件あり、一度に表示できる${SALES_LIST_LIMIT.toLocaleString('ja-JP')}件を超えます。期間や取引先で絞ってください`, 413, {count: out.length});
    const sum = (key) => out.reduce((total, line) => total + Number(line[key] || 0), 0);
    return c.json({ok: true, rows: out, count: out.length, distribution: distribution ? {code: distribution, label: distributionLabel} : null, totals: {amount_ex_tax: sum('amount_ex_tax'), tax_amount: sum('tax_amount'), amount_inc_tax: sum('amount_inc_tax')},
      scope: workId
        ? '選んだ作品の売上明細（複数の作品に配賦した商品は、この作品の配賦分の額。訂正で置き換えた旧報告は含めない）'
        : '閲覧権限のある作品の有効な報告の売上明細（訂正で置き換えた旧報告は含めない）'});
  });
}
