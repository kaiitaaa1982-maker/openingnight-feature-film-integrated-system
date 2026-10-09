// 月次の受領進捗のAPI。届くはずの報告の登録・終了と、取引先×月のマトリクス。
// 制作担当は403。作品を指定した規則はその作品の財務権限が要る。報告は財務権限のある作品のものだけで判定する。
// node:* を import しない（Worker でも動く）。
import {buildProgressMatrix, monthsBetween, FREQUENCIES} from './progress-model.mjs';
import {labelOf} from '../ui/labels.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const KINDS = ['theatrical', 'digital', 'package', 'broadcast', 'other'];
const todayJst = (now = new Date()) => new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function registerProgressRoutes(app, {db, bad, body, settlementWork, permittedProjects}) {
  // 作品を決めない規則は取引先単位の財務情報なので、どこかの案件の財務権限（または管理者）を求める
  async function hasFinance(i) {
    if (i.role === 'admin') return true;
    return (await permittedProjects(db, i, true)).length > 0;
  }
  async function allowedWorks(i) {
    const works = await db.all('SELECT id FROM works WHERE org_id=?', [i.org_id]);
    const allowed = new Set();
    for (const work of works) if (await settlementWork(i, work.id)) allowed.add(work.id);
    return allowed;
  }
  async function rulesFor(i, allowed) {
    const rows = await db.all(`SELECT e.*, p.name AS partner_name, p.code AS partner_code, w.title AS work_title, x.last_month, x.reason AS closed_reason,
        u.display_name AS created_by_name
      FROM expected_reports e JOIN partners p ON p.org_id=e.org_id AND p.id=e.partner_id
      LEFT JOIN works w ON w.org_id=e.org_id AND w.id=e.work_id
      LEFT JOIN expected_report_closures x ON x.org_id=e.org_id AND x.expected_report_id=e.id
      LEFT JOIN users u ON u.id=e.created_by
      WHERE e.org_id=? ORDER BY p.name, e.kind, e.id`, [i.org_id]);
    const finance = await hasFinance(i);
    return rows.filter((row) => (row.work_id == null ? finance : allowed.has(row.work_id)))
      .map((row) => ({...row, kind_label: labelOf('reportKind', row.kind), frequency_label: FREQUENCIES[row.frequency]?.label || row.frequency}));
  }

  app.get('/api/progress/rules', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '受領進捗は財務担当の画面です', 403);
    return c.json({ok: true, rules: await rulesFor(i, await allowedWorks(i))});
  });

  app.post('/api/progress/rules', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, 'この役割では登録できません', 403);
    const input = await body(c);
    const errors = [];
    const partnerId = Number(input.partnerId);
    const workId = input.workId ? Number(input.workId) : null;
    if (!Number.isInteger(partnerId) || partnerId <= 0 || !await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?', [i.org_id, partnerId])) errors.push({field: 'partnerId', message: '取引先を選んでください'});
    if (!KINDS.includes(input.kind)) errors.push({field: 'kind', message: '報告の種類を選んでください'});
    if (!FREQUENCIES[input.frequency]) errors.push({field: 'frequency', message: '頻度を選んでください'});
    if (!MONTH.test(input.activeFrom || '')) errors.push({field: 'activeFrom', message: '開始月を「2026-05」の形で入れてください'});
    const dueDay = input.dueDay === '' || input.dueDay == null ? null : Number(input.dueDay);
    if (dueDay !== null && !(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31)) errors.push({field: 'dueDay', message: '届く日は1〜31の日にちで入れてください（空欄は翌月末）'});
    const note = input.note ? String(input.note).trim().slice(0, 500) : null;
    if (errors.length) return bad(c, errors.map((e) => e.message).join(' ／ '), 400, {errors});
    if (workId && !await settlementWork(i, workId)) return bad(c, '作品の財務権限がありません', 403);
    if (!workId && !await hasFinance(i)) return bad(c, '財務の権限がある案件がないため登録できません', 403);
    // 有効期間が重なる同じ取引先・種類・作品の登録があれば断る（二重に数えないため。スキーマのトリガーでも止める）
    const overlap = await db.get(`SELECT e.id, e.active_from, x.last_month FROM expected_reports e
      LEFT JOIN expected_report_closures x ON x.org_id=e.org_id AND x.expected_report_id=e.id
      WHERE e.org_id=? AND e.partner_id=? AND e.kind=? AND e.work_id IS ? AND (x.last_month IS NULL OR x.last_month>=?) ORDER BY e.id LIMIT 1`,
    [i.org_id, partnerId, input.kind, workId, input.activeFrom]);
    if (overlap) {
      const until = overlap.last_month ? `${overlap.last_month}まで` : '終了していません';
      return bad(c, `同じ取引先・種類・作品の届くはずの報告が有効期間中です（${overlap.active_from}から・${until}）。条件を変えるときは、前の登録を終了してから登録してください`, 409, {existingId: overlap.id});
    }
    const out = await db.get('INSERT INTO expected_reports(org_id, partner_id, kind, work_id, frequency, due_day, active_from, note, created_by) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
      [i.org_id, partnerId, input.kind, workId, input.frequency, dueDay, input.activeFrom, note, i.user_id]);
    await db.run('INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
      [i.org_id, i.user_id, 'create', 'expected_report', String(out.id), JSON.stringify({partnerId, kind: input.kind, workId, frequency: input.frequency, dueDay, activeFrom: input.activeFrom})]);
    return c.json({ok: true, id: out.id}, 201);
  });

  app.post('/api/progress/rules/:id/close', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, 'この役割では変更できません', 403);
    const id = Number(c.req.param('id'));
    const rule = await db.get('SELECT * FROM expected_reports WHERE org_id=? AND id=?', [i.org_id, id]);
    if (!rule) return bad(c, '届くはずの報告が見つかりません', 404);
    if (rule.work_id && !await settlementWork(i, rule.work_id)) return bad(c, '作品の財務権限がありません', 403);
    if (!rule.work_id && !await hasFinance(i)) return bad(c, '財務の権限がある案件がないため変更できません', 403);
    const input = await body(c);
    if (!MONTH.test(input.lastMonth || '')) return bad(c, '最後の対象月を「2026-05」の形で入れてください', 400, {errors: [{field: 'lastMonth', message: '最後の対象月を入れてください'}]});
    if (input.lastMonth < rule.active_from) return bad(c, '最後の対象月は開始月以後にしてください', 400, {errors: [{field: 'lastMonth', message: '開始月以後にしてください'}]});
    const reason = String(input.reason || '').trim();
    if (!reason) return bad(c, '終了の理由を入れてください', 400, {errors: [{field: 'reason', message: '理由は必須です'}]});
    if (await db.get('SELECT 1 FROM expected_report_closures WHERE org_id=? AND expected_report_id=?', [i.org_id, id])) return bad(c, 'すでに終了しています', 409);
    await db.batch([
      {sql: 'INSERT INTO expected_report_closures(org_id, expected_report_id, last_month, reason, created_by) VALUES(?,?,?,?,?)', params: [i.org_id, id, input.lastMonth, reason.slice(0, 500), i.user_id]},
      {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', params: [i.org_id, i.user_id, 'close', 'expected_report', String(id), JSON.stringify({lastMonth: input.lastMonth, reason})]},
    ]);
    return c.json({ok: true}, 201);
  });

  app.get('/api/progress/matrix', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '受領進捗は財務担当の画面です', 403);
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!MONTH.test(from || '') || !MONTH.test(to || '') || from > to) return bad(c, '期間（from・to）を「2026-05」の形で、開始≦終了で指定してください');
    const months = monthsBetween(from, to);
    if (months.length > 36) return bad(c, '期間は36か月以内で指定してください');
    const today = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('today') || '') ? c.req.query('today') : todayJst();
    const allowed = await allowedWorks(i);
    const rules = await rulesFor(i, allowed);
    const reports = (await db.all(`SELECT id, work_id, partner_id, kind, period_from, period_to, report_key, accounting_month FROM report_imports
      WHERE org_id=? AND status='active' AND kind<>'publicity'`, [i.org_id])).filter((report) => allowed.has(report.work_id));
    const lines = await db.all(`SELECT s.report_id, COUNT(*) AS n, SUM(CASE WHEN bc.sale_id IS NULL THEN 0 ELSE 1 END) AS claimed
      FROM sale_lines s LEFT JOIN billing_sale_claims bc ON bc.org_id=s.org_id AND bc.sale_id=s.id WHERE s.org_id=? GROUP BY s.report_id`, [i.org_id]);
    const invoices = await db.all(`SELECT DISTINCT s.report_id, inv.id AS invoice_id, inv.amount_inc_tax,
        COALESCE((SELECT SUM(a.amount_yen) FROM billing_receipt_allocations a LEFT JOIN billing_receipt_reversals v ON v.org_id=a.org_id AND v.receipt_id=a.receipt_id
          WHERE a.org_id=inv.org_id AND a.invoice_id=inv.id AND v.receipt_id IS NULL), 0) AS paid
      FROM sale_lines s JOIN billing_sale_claims bc ON bc.org_id=s.org_id AND bc.sale_id=s.id
      JOIN billing_invoices inv ON inv.org_id=bc.org_id AND inv.id=bc.invoice_id WHERE s.org_id=?`, [i.org_id]);
    const billing = new Map();
    for (const row of lines) billing.set(row.report_id, {lines: Number(row.n), claimed: Number(row.claimed || 0), openInvoices: 0});
    for (const row of invoices) {
      const entry = billing.get(row.report_id);
      if (entry && Number(row.paid) < Number(row.amount_inc_tax)) entry.openInvoices += 1;
    }
    const matrix = buildProgressMatrix({rules, reports, billing, months, today});
    return c.json({ok: true, from, to, today, ...matrix,
      reportKeys: Object.fromEntries(reports.map((report) => [report.id, report.report_key])),
      basis: '報告は、取引先・報告の種類（・作品）が一致し、対象期間に報告期間が重なる有効な報告で判定します。財務権限のある作品の報告だけを見ます。期限は対象期間の翌月の「届く日」（空欄は翌月末）。'});
  });
}
