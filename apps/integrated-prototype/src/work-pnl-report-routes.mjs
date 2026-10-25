import {expenseSource,resolveExpenseAccounts} from './expense-sheet/expense-read.mjs';
// 作品別収支（正式版）のAPI。Worker でも動くよう node:* を import しない。
// 売上は /api/reports/annual-sales（計上月・税抜）と同じ配賦で作品へ割り当てた明細を数える（合計が一致することを試験で確かめる）。
// 経費は作品に直接付いたものだけを作品計に入れ、作品の決まっていない案件の経費は「未配賦の経費」として別に返す。
// 制作担当は参照できない。作品の財務権限が要る。
// ?basis=accrual（既定。計上月）|cash（入金日・出金日の月。税抜にできない入出金は「未確定」。フェーズ1 #16）。応答と文書データに基準を付ける
import {splitByAllocation} from './money-allocation.mjs';
import {monthsBetween} from './reports/annual-sales-model.mjs';
import {buildWorkPnl, OUT_OF_SCOPE_NOTE} from './reports/work-pnl-model.mjs';
// 画面・Excel・印刷は応答の document（帳票の文書データ。計画の K-5）から出す。ほかの項目は従来の応答（試験と他の帳票の照合が読む）
import {workPnlDocument, basisNoteOf, SCOPE_NOTE} from './accounting/work-pnl/work-pnl-document.mjs';
import {workPnlCashRows, cashSaleIds} from './accounting/work-pnl/work-pnl-cash-model.mjs';
import {listWorkPnlSaleLines} from './accounting/accounting-store.mjs';
import {parseBasis, basisFields} from './reports/pl-bs-cash-model.mjs';
import {loadCashSide} from './pl-bs/pl-bs-data.mjs';
import {distributionTypeLabels} from './distribution-label.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEAL_LABELS = {unverified: '未確認', royalty: 'ロイヤリティ', MG: 'MG', FLAT: 'FLAT（定額）', other: 'その他'};
const KIND_CODE = {digital: 'digital_unknown', package: 'package_unknown', theatrical: 'theatrical', broadcast: 'broadcast_unknown'};

// 1作品の配賦済み売上明細（計上月・税抜）。reporting-annual の明細の作り方と同じ。
// 計上月の期間（from・to）で読む。saleIds を渡すとその売上明細だけを計上月によらず読む（入金ベースの入金の行の元。組織の全期間の売上明細を読まない）
export async function workPnlLines(db, orgId, workId, {from, to, saleIds = null}) {
  const sales = await listWorkPnlSaleLines(db, orgId, {from, to, saleIds});
  if (!sales.length) return [];
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

export function registerWorkPnlRoutes(app, {db, bad, settlementWork, sha256, canonical}) {
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
    // 基準: accrual（既定。計上月）か cash（入金日・出金日の月。フェーズ1 #16）。ほかの値は400
    const basisRead = parseBasis(c.req.query('basis'));
    if (!basisRead.ok) return bad(c, basisRead.error, 400, {field: 'basis'});
    const basis = basisRead.basis;
    try {
      const allowed = await settlementWork(i, workId);
      if (!allowed) return bad(c, '作品の財務権限がありません', 403);
      const months = monthsBetween(from, to);
      const work = await db.get('SELECT id, project_id, code, title FROM works WHERE org_id=? AND id=?', [i.org_id, workId]);
      // 入金ベースは、期間に入った入金・出金の元の売上明細と経費を計上月によらず読む（入金日・出金日の月で並べ直す）。
      // 売上明細は期間に入った確定の入金が指す明細だけ（cashSaleIds）。経費はこの作品・この案件の分だけを全期間で読む
      const cashSide = basis === 'cash' ? await loadCashSide(db, i.org_id) : null;
      const range = basis === 'cash' ? {from: '0000-01', to: '9999-12'} : {from, to};
      let lines = await workPnlLines(db, i.org_id, workId, cashSide ? {saleIds: cashSaleIds({workId, from, to, cashSide})} : range);
      let expenses = await db.all(`SELECT e.id, e.project_id, e.work_id, e.partner_id, e.incurred_on, e.accounting_month, e.category, e.description,
          e.actual_ex_tax, e.tax_amount, e.actual_inc_tax, p.name AS partner_name
        FROM ${expenseSource()} e LEFT JOIN partners p ON p.org_id=e.org_id AND p.id=e.partner_id
        WHERE e.org_id=? AND e.work_id=? AND e.accounting_month BETWEEN ? AND ? ORDER BY e.accounting_month, e.id`, [i.org_id, workId, range.from, range.to]);
      let unallocatedExpenses = await db.all(`SELECT e.id, e.project_id, e.work_id, e.partner_id, e.incurred_on, e.accounting_month, e.category, e.description,
          e.actual_ex_tax, e.tax_amount, e.actual_inc_tax, p.name AS partner_name
        FROM ${expenseSource()} e LEFT JOIN partners p ON p.org_id=e.org_id AND p.id=e.partner_id
        WHERE e.org_id=? AND e.project_id=? AND e.work_id IS NULL AND e.accounting_month BETWEEN ? AND ? ORDER BY e.accounting_month, e.id`, [i.org_id, work.project_id, range.from, range.to]);
      expenses = await resolveExpenseAccounts(db,i.org_id,expenses);
      let cash = null;
      if (basis === 'cash') {
        // 入金側の読み取りは pl-bs-data.mjs、税抜への換算は pl-bs-cash-model.mjs（work-pnl-cash-model.mjs が作品の行にする）
        cash = workPnlCashRows({workId, from, to, lines, expenses, unallocatedExpenses, cashSide});
        ({lines, expenses, unallocatedExpenses} = cash);
      }
      const result = buildWorkPnl({lines, expenses, unallocatedExpenses, months, basis});
      const latest = await db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active' AND kind<>'publicity'", [i.org_id]);
      const dataAsOf = {latestImportAt: latest?.at || null, generatedAt: new Date().toISOString()};
      const workRow = {id: work.id, code: work.code, title: work.title};
      const cashInput = cash ? {unsettled: cash.unsettled, unattachedReceiptCount: cash.unattachedReceiptCount} : {};
      const doc = await workPnlDocument({work: workRow, conditions: {workId, from, to}, dataAsOf, basis, lines, expenses, unallocatedExpenses, ...cashInput}, {sha256, canonical});
      return c.json({
        ok: true, work: workRow, conditions: {from, to, workId, basis},
        ...basisFields(basis),
        ...result, lines, expenses,
        ...(cash ? {unsettled: cash.unsettled, unattachedReceiptCount: cash.unattachedReceiptCount} : {}),
        dataAsOf,
        basisNote: basisNoteOf(basis),
        scope: SCOPE_NOTE,
        outOfScope: OUT_OF_SCOPE_NOTE,
        document: doc,
      });
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });
}
