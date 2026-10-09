import {expenseSource,resolveExpenseAccounts} from './expense-sheet/expense-read.mjs';
// 作品別収支（正式版）のAPI。Worker でも動くよう node:* を import しない。
// 売上は /api/reports/annual-sales（計上月・税抜）と同じ配賦で作品へ割り当てた明細を数える（合計が一致することを試験で確かめる）。
// 経費は作品に直接付いたものだけを作品計に入れ、作品の決まっていない案件の経費は「未配賦の経費」として別に返す。
// 制作担当は参照できない。作品の財務権限が要る。
import {splitByAllocation} from './money-allocation.mjs';
import {monthsBetween} from './reports/annual-sales-model.mjs';
import {buildWorkPnl, OUT_OF_SCOPE_NOTE} from './reports/work-pnl-model.mjs';
import {distributionTypeLabels} from './distribution-label.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEAL_LABELS = {unverified: '未確認', royalty: 'ロイヤリティ', MG: 'MG', FLAT: 'FLAT（定額）', other: 'その他'};
const KIND_CODE = {digital: 'digital_unknown', package: 'package_unknown', theatrical: 'theatrical', broadcast: 'broadcast_unknown'};

// 1作品の配賦済み売上明細（計上月・税抜）。reporting-annual の明細の作り方と同じ。
export async function workPnlLines(db, orgId, workId, {from, to}) {
  const sales = await db.all(`SELECT s.id, s.work_id, s.product_id, s.partner_id, s.report_id, s.source_row, s.description, s.quantity,
      s.accounting_month, s.amount_ex_tax, r.kind, r.report_key,
      p.name AS partner_name, p.code AS partner_code, pr.sku AS product_sku, pr.name AS product_name,
      d.distribution_code, d.settlement_method
    FROM sale_lines s
    JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
    LEFT JOIN products pr ON pr.org_id=s.org_id AND pr.id=s.product_id
    LEFT JOIN sale_distribution_versions d ON d.org_id=s.org_id AND d.sale_id=s.id
      AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=s.org_id AND x.sale_id=s.id)
    WHERE s.org_id=? AND r.status='active' AND s.accounting_month BETWEEN ? AND ?
    ORDER BY s.id`, [orgId, from, to]);
  const maps = await db.all('SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=?', [orgId]);
  // カードの見出し・「売上のうち ○○」の列は流通IDごとに区別できる表示名（「D004｜配信｜RS｜TVOD」）。年間売上と同じ
  const typeLabel = await distributionTypeLabels(db);
  const lines = [];
  for (const sale of sales) {
    let shares = sale.product_id ? maps.filter((m) => m.product_id === sale.product_id) : [];
    if (!shares.length) shares = [{work_id: sale.work_id, allocation_bps: 10000}];
    const share = shares.find((s) => s.work_id === workId);
    if (!share) continue;
    const parts = splitByAllocation(sale.amount_ex_tax, shares);
    const code = sale.distribution_code || KIND_CODE[sale.kind] || 'other';
    const deal = sale.settlement_method || 'unverified';
    lines.push({
      id: sale.id, report_id: sale.report_id, report_key: sale.report_key, source_row: sale.source_row, description: sale.description,
      quantity: sale.quantity, month: sale.accounting_month, accounting_month: sale.accounting_month, amount: parts.get(workId), allocation_bps: share.allocation_bps,
      partner_id: sale.partner_id, partner_name: sale.partner_name, partner_code: sale.partner_code,
      product_id: sale.product_id, product_sku: sale.product_sku, product_name: sale.product_name,
      distribution_code: code, distribution_label: typeLabel.get(code) || '未確認', deal, deal_label: DEAL_LABELS[deal] || deal,
    });
  }
  return lines;
}

export function registerWorkPnlRoutes(app, {db, bad, settlementWork}) {
  app.get('/api/reports/work-pnl', async (c) => {
    const i = c.get('identity');
    if (!i || i.role === 'production') return bad(c, '作品別収支は財務担当の帳票です', 403);
    const rawWork = c.req.query('workId');
    if (!rawWork) return bad(c, '作品を選んでください');
    const workId = /^\d+$/.test(rawWork) ? Number(rawWork) : NaN;
    if (!Number.isSafeInteger(workId) || workId < 1) return bad(c, '作品の指定を読み取れません');
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!MONTH.test(from || '') || !MONTH.test(to || '')) return bad(c, '期間（from・to）を「2026-05」の形で指定してください');
    if (from > to) return bad(c, '期間の開始月が終了月より後になっています');
    try {
      const allowed = await settlementWork(i, workId);
      if (!allowed) return bad(c, '作品の財務権限がありません', 403);
      const months = monthsBetween(from, to);
      const work = await db.get('SELECT id, project_id, code, title FROM works WHERE org_id=? AND id=?', [i.org_id, workId]);
      const lines = await workPnlLines(db, i.org_id, workId, {from, to});
      let expenses = await db.all(`SELECT e.id, e.project_id, e.work_id, e.partner_id, e.incurred_on, e.accounting_month, e.category, e.description,
          e.actual_ex_tax, e.tax_amount, e.actual_inc_tax, p.name AS partner_name
        FROM ${expenseSource()} e LEFT JOIN partners p ON p.org_id=e.org_id AND p.id=e.partner_id
        WHERE e.org_id=? AND e.work_id=? AND e.accounting_month BETWEEN ? AND ? ORDER BY e.accounting_month, e.id`, [i.org_id, workId, from, to]);
      const unallocatedExpenses = await db.all(`SELECT e.id, e.project_id, e.work_id, e.partner_id, e.incurred_on, e.accounting_month, e.category, e.description,
          e.actual_ex_tax, e.tax_amount, e.actual_inc_tax, p.name AS partner_name
        FROM ${expenseSource()} e LEFT JOIN partners p ON p.org_id=e.org_id AND p.id=e.partner_id
        WHERE e.org_id=? AND e.project_id=? AND e.work_id IS NULL AND e.accounting_month BETWEEN ? AND ? ORDER BY e.accounting_month, e.id`, [i.org_id, work.project_id, from, to]);
      expenses = await resolveExpenseAccounts(db,i.org_id,expenses);
      const result = buildWorkPnl({lines, expenses, unallocatedExpenses, months});
      const latest = await db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active' AND kind<>'publicity'", [i.org_id]);
      return c.json({
        ok: true, work: {id: work.id, code: work.code, title: work.title}, conditions: {from, to, workId},
        ...result, lines, expenses,
        dataAsOf: {latestImportAt: latest?.at || null, generatedAt: new Date().toISOString()},
        basisNote: '計上月・税抜。売上は商品の作品配賦で割り当てた額（帳票センターの年間売上と同じ数え方）。',
        scope: '作品に直接付いた経費だけを作品計に入れます。作品の決まっていない案件の経費は「未配賦の経費」として別に示し、差し引きません。',
        outOfScope: OUT_OF_SCOPE_NOTE,
      });
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });
}
