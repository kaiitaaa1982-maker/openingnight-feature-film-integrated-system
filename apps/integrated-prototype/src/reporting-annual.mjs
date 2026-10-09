// 帳票センターの年間売上と、組織の年度設定。Worker でも動くよう node:* を import しない。
import {splitByAllocation} from './money-allocation.mjs';
import {distributionTypeLabels} from './distribution-label.mjs';
import {buildAnnualSales, drillLines, monthsBetween, shiftMonth, AXES} from './reports/annual-sales-model.mjs';

export const DEFAULT_FISCAL_START_MONTH = 5;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEAL_LABELS = {unverified: '未確認', royalty: 'ロイヤリティ', MG: 'MG', FLAT: 'FLAT（定額）', other: 'その他'};
const KIND_CODE = {digital: 'digital_unknown', package: 'package_unknown', theatrical: 'theatrical', broadcast: 'broadcast_unknown'};

function currentMonthJst(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function fiscalSetting(db, orgId) {
  const row = await db.get('SELECT fiscal_start_month, confirmed, updated_at, updated_by FROM fiscal_settings WHERE org_id=?', [orgId]);
  return {
    fiscalStartMonth: row ? Number(row.fiscal_start_month) : DEFAULT_FISCAL_START_MONTH,
    confirmed: row ? Boolean(row.confirmed) : false,
    updatedAt: row?.updated_at || null,
    source: row ? 'organization' : 'default',
    note: '決算4月（期首5月〜期末翌4月）を既定とする。期首4月か期末4月かは未確認（docs/uriage/report-requirements.md §1）',
  };
}

export function registerAnnualReportRoutes(app, {db, bad, body, permittedProjects}) {
  const wrap = (fn) => async (c) => {
    try { return await fn(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
  };
  async function financeScope(c) {
    const i = c.get('identity');
    if (i.role === 'production') return null;
    const projects = await permittedProjects(db, i, true);
    if (!projects.length) return null;
    const ids = new Set(projects.map((p) => p.id));
    const works = (await db.all('SELECT id, project_id, code, title FROM works WHERE org_id=?', [i.org_id])).filter((w) => ids.has(w.project_id));
    return {i, works};
  }

  app.get('/api/settings/fiscal', wrap(async (c) => {
    const i = c.get('identity');
    return c.json({ok: true, setting: await fiscalSetting(db, i.org_id)});
  }));

  app.put('/api/settings/fiscal', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '年度の設定は管理者だけが変更できます', 403);
    const input = await body(c);
    const start = Number(input.fiscalStartMonth);
    if (!Number.isInteger(start) || start < 1 || start > 12) return bad(c, '年度の開始月は1〜12で指定してください');
    const confirmed = input.confirmed === true || input.confirmed === 1 ? 1 : 0;
    const before = await db.get('SELECT * FROM fiscal_settings WHERE org_id=?', [i.org_id]);
    await db.batch([
      {sql: `INSERT INTO fiscal_settings(org_id, fiscal_start_month, confirmed, updated_by, updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(org_id) DO UPDATE SET fiscal_start_month=excluded.fiscal_start_month, confirmed=excluded.confirmed, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`,
      params: [i.org_id, start, confirmed, i.user_id]},
      {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
        params: [i.org_id, i.user_id, 'update', 'fiscal_settings', String(i.org_id), JSON.stringify({before, after: {fiscal_start_month: start, confirmed}})]},
    ]);
    return c.json({ok: true, setting: await fiscalSetting(db, i.org_id)});
  }));

  // 期間・基準・税・絞込の条件から、作品配賦済みの明細を作る
  async function loadLines(i, works, {from, to, basis, tax, workId, partnerId, distribution}) {
    const visible = new Map(works.map((w) => [w.id, w]));
    // 販売月の基準では、計上月が期間外でも販売月が期間内の明細がある。前後2年を読み、月で絞る。
    const readFrom = shiftMonth(from, basis === 'sales' ? -24 : 0);
    const readTo = shiftMonth(to, basis === 'sales' ? 24 : 0);
    const sales = await db.all(`SELECT s.id, s.work_id, s.product_id, s.partner_id, s.report_id, s.source_row, s.description, s.quantity,
        s.accounting_month, s.sales_period_from, s.amount_ex_tax, s.amount_inc_tax, s.tax_amount,
        r.kind, r.report_key, r.created_at AS report_created_at, rr.sales_month,
        p.name AS partner_name, p.code AS partner_code, pr.sku AS product_sku, pr.name AS product_name,
        d.distribution_code, d.settlement_method
      FROM sale_lines s
      JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
      JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
      LEFT JOIN products pr ON pr.org_id=s.org_id AND pr.id=s.product_id
      LEFT JOIN report_recognition rr ON rr.org_id=s.org_id AND rr.report_id=s.report_id
      LEFT JOIN sale_distribution_versions d ON d.org_id=s.org_id AND d.sale_id=s.id
        AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=s.org_id AND x.sale_id=s.id)
      WHERE s.org_id=? AND r.status='active' AND s.accounting_month BETWEEN ? AND ?
      ORDER BY s.id`, [i.org_id, readFrom, readTo]);
    const maps = await db.all('SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=?', [i.org_id]);
    // 流通の表示名は「D004｜配信｜RS｜TVOD」の形（流通名だけだと D004〜D006 がどれも「配信」になる）。帳票センター・/api/distribution-types と同じ
    const typeLabel = await distributionTypeLabels(db);
    const lines = [];
    let estimated = 0;
    for (const sale of sales) {
      let shares = sale.product_id ? maps.filter((m) => m.product_id === sale.product_id) : [];
      if (!shares.length) shares = [{work_id: sale.work_id, allocation_bps: 10000}];
      const amount = tax === 'inc' ? sale.amount_inc_tax : sale.amount_ex_tax;
      const parts = splitByAllocation(amount, shares);
      const salesMonth = sale.sales_month || String(sale.sales_period_from || '').slice(0, 7) || sale.accounting_month;
      const month = basis === 'sales' ? salesMonth : sale.accounting_month;
      const estimatedMonth = basis === 'sales' && !sale.sales_month;
      const code = sale.distribution_code || KIND_CODE[sale.kind] || 'other';
      for (const share of shares) {
        const work = visible.get(share.work_id);
        if (!work) continue;
        if (workId && share.work_id !== workId) continue;
        if (partnerId && sale.partner_id !== partnerId) continue;
        if (distribution && code !== distribution) continue;
        if (estimatedMonth) estimated += 1;
        lines.push({
          id: sale.id, report_id: sale.report_id, report_key: sale.report_key, source_row: sale.source_row, description: sale.description,
          quantity: sale.quantity, accounting_month: sale.accounting_month, sales_month: salesMonth, sales_month_estimated: estimatedMonth,
          month, amount: parts.get(share.work_id), allocation_bps: share.allocation_bps,
          work_id: share.work_id, work_title: work.title, work_code: work.code,
          partner_id: sale.partner_id, partner_name: sale.partner_name, partner_code: sale.partner_code,
          product_id: sale.product_id, product_sku: sale.product_sku, product_name: sale.product_name,
          distribution_code: code, distribution_label: typeLabel.get(code) || '未確認',
          deal: sale.settlement_method || 'unverified', deal_label: DEAL_LABELS[sale.settlement_method || 'unverified'] || sale.settlement_method,
          report_created_at: sale.report_created_at,
        });
      }
    }
    return {lines, estimated};
  }

  function readConditions(c, works) {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!MONTH.test(from || '') || !MONTH.test(to || '')) throw new Error('期間（from・to）を「2026-05」の形で指定してください');
    if (from > to) throw new Error('期間の開始月が終了月より後になっています');
    const basis = c.req.query('basis') === 'sales' ? 'sales' : 'accounting';
    const tax = c.req.query('tax') === 'inc' ? 'inc' : 'ex';
    const axis = Object.hasOwn(AXES, c.req.query('axis') || '') ? c.req.query('axis') : 'total';
    const workId = c.req.query('workId') ? Number(c.req.query('workId')) : null;
    const partnerId = c.req.query('partnerId') ? Number(c.req.query('partnerId')) : null;
    const distribution = c.req.query('distribution') || null;
    if (workId && !works.some((w) => w.id === workId)) {
      const error = new Error('作品への財務権限がありません');
      error.status = 403;
      throw error;
    }
    return {from, to, basis, tax, axis, workId, partnerId, distribution};
  }

  app.get('/api/reports/annual-sales', async (c) => {
    const scope = await financeScope(c);
    if (!scope) return bad(c, '帳票への財務権限がありません', 403);
    let q;
    try { q = readConditions(c, scope.works); } catch (error) { return bad(c, error.message, error.status || 400, undefined, error); }
    try {
      const months = monthsBetween(q.from, q.to);
      const current = await loadLines(scope.i, scope.works, q);
      const previous = await loadLines(scope.i, scope.works, {...q, from: shiftMonth(q.from, -12), to: shiftMonth(q.to, -12)});
      const result = buildAnnualSales(current.lines, {months, axis: q.axis, previousLines: previous.lines, currentMonth: currentMonthJst()});
      const latest = await db.get("SELECT MAX(created_at) AS at, COUNT(*) AS n FROM report_imports WHERE org_id=? AND status='active' AND kind<>'publicity'", [scope.i.org_id]);
      return c.json({
        ok: true, ...result, conditions: q, fiscal: await fiscalSetting(db, scope.i.org_id),
        dataAsOf: {latestImportAt: latest?.at || null, activeReports: Number(latest?.n || 0), generatedAt: new Date().toISOString()},
        estimatedSalesMonthLines: current.estimated,
        basisNote: q.basis === 'sales'
          ? '販売月基準。販売月が報告に無い明細は販売期間の開始月で数え、「販売月は推定」と表示します。'
          : '計上月基準。報告の計上月（実計上月）で数えます。',
        scope: '閲覧権限のある作品へ配賦済みの売上。0円と未受領は区別しません（未受領の管理は受領進捗で行います）。',
      });
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });

  app.get('/api/reports/annual-sales/lines', async (c) => {
    const scope = await financeScope(c);
    if (!scope) return bad(c, '帳票への財務権限がありません', 403);
    let q;
    try { q = readConditions(c, scope.works); } catch (error) { return bad(c, error.message, error.status || 400, undefined, error); }
    try {
      const month = c.req.query('month') || null;
      if (month && !MONTH.test(month)) return bad(c, '月を「2026-05」の形で指定してください');
      const key = c.req.query('key') || null;
      const limit = Math.min(Math.max(Number(c.req.query('limit') || 50), 1), 2000);
      const offset = Math.max(Number(c.req.query('offset') || 0), 0);
      const {lines} = await loadLines(scope.i, scope.works, q);
      const months = new Set(monthsBetween(q.from, q.to));
      const matched = drillLines(lines.filter((line) => months.has(line.month)), {axis: q.axis, key, month});
      const total = matched.reduce((sum, line) => sum + line.amount, 0);
      return c.json({ok: true, count: matched.length, total, rows: matched.slice(offset, offset + limit), offset, limit});
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });
}
