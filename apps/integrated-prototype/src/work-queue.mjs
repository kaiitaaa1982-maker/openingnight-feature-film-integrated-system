// ホームの作業キュー。役割と閲覧権限の範囲で「次に対応すること」を件数と先頭5件で返す。
// 各項目は開く画面（page・params）を持ち、ホームから該当画面へ1手で移れる。制作担当には財務の項目を返さない。
import {canContractVersion} from './mg.mjs';
import {royaltyPeriods} from './royalty/royalty-data.mjs';

const TOP = 5;
const BROADCAST_LABELS = {pending_first: '一次承認待ち', pending_final: '最終承認待ち'};
// 表示用の日付・月（日本の書き方）。2026-09-24 → 2026/09/24、2026-09 → 2026年9月
const ymd = (value) => (value ? String(value).slice(0, 10).replaceAll('-', '/') : '');
const ym = (value) => (value ? `${Number(String(value).slice(0, 4))}年${Number(String(value).slice(5, 7))}月` : '');
const DATASET_LABELS = {works: '作品', products: '商品', partners: '取引先', expenses: '経費', sales_import: '売上取込'};
// 表編集の申請日時（UTC保存）を日本時間の「2026/09/24 15:00」にする
const jstDateTime = (value) => {
  const time = Date.parse(String(value || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value || '')) ? '' : 'Z'));
  if (!Number.isFinite(time)) return String(value || '');
  const d = new Date(time + 9 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function registerWorkQueueRoutes(app, {db, permittedProjects, settlementWork}) {
  app.get('/api/work-queue', async (c) => {
    const i = c.get('identity');
    const today = c.req.query('today') && /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('today')) ? c.req.query('today') : todayJst();
    const projects = new Set((await permittedProjects(db, i)).map((p) => p.id));
    const works = (await db.all('SELECT id, project_id, title FROM works WHERE org_id=?', [i.org_id])).filter((w) => projects.has(w.project_id));
    const workTitle = new Map(works.map((w) => [w.id, w.title]));
    const visible = (workId) => workTitle.has(workId);
    const finance = i.role !== 'production';
    const financeWorks = new Set();
    if (finance) for (const w of works) if (await settlementWork(i, w.id)) financeWorks.add(w.id);
    const items = [];
    const push = (item) => items.push({...item, count: item.rows.length, rows: item.rows.slice(0, TOP)});

    // 準備タスク（全役割）: 期限切れ・7日以内・保留
    const tasks = (await db.all("SELECT id, work_id, title, owner_label, due_on, status FROM prep_tasks WHERE org_id=? AND status IN ('pending','blocked') ORDER BY due_on IS NULL, due_on, id", [i.org_id]))
      .filter((t) => visible(t.work_id) && (t.status === 'blocked' || (t.due_on && t.due_on <= addDays(today, 7))));
    push({id: 'prep-tasks', title: '撮影準備のタスク（期限7日以内・保留）', page: '制作', params: {tab: 'prep'}, tone: tasks.some((t) => t.status === 'blocked' || t.due_on < today) ? 'bad' : 'warn',
      rows: tasks.map((t) => ({label: t.title, detail: `${workTitle.get(t.work_id)}・${t.status === 'blocked' ? '保留中' : t.due_on < today ? `期限切れ（${ymd(t.due_on)}）` : `期限 ${ymd(t.due_on)}`}${t.owner_label ? `・担当 ${t.owner_label}` : ''}`, workId: t.work_id}))});

    // 撮影日に割り当てていないシーン（全役割）: 撮影日を1日以上登録した作品で、撮影済みでないのにどの撮影日にも入っていないシーン
    const unassigned = (await db.all(`SELECT s.id, s.work_id, s.scene_no, s.location FROM scenes s
      WHERE s.org_id=? AND s.status<>'shot'
        AND EXISTS (SELECT 1 FROM shooting_days d WHERE d.org_id=s.org_id AND d.work_id=s.work_id)
        AND NOT EXISTS (SELECT 1 FROM day_scene_assignments a WHERE a.org_id=s.org_id AND a.scene_id=s.id)
      ORDER BY s.work_id, s.scene_no`, [i.org_id])).filter((scene) => visible(scene.work_id));
    push({id: 'unassigned-scenes', title: '撮影日に割り当てていないシーン', page: '制作', params: {tab: 'day'}, tone: 'warn',
      rows: unassigned.map((scene) => ({label: `S#${scene.scene_no}${scene.location ? `・${scene.location}` : ''}`, detail: workTitle.get(scene.work_id), workId: scene.work_id}))});

    if (finance) {
      const slots = await db.all(`SELECT v.work_id, v.slot_id, v.station_name, v.broadcast_month, v.status FROM broadcast_slot_versions v
        WHERE v.org_id=? AND v.revision=(SELECT MAX(x.revision) FROM broadcast_slot_versions x WHERE x.org_id=v.org_id AND x.slot_id=v.slot_id)
        AND v.status IN ('pending_first','pending_final') ORDER BY v.broadcast_month, v.slot_id`, [i.org_id]);
      push({id: 'broadcast-approvals', title: '放送枠の承認待ち', page: '番販・放送', params: {tab: 'approvals'}, tone: 'warn',
        rows: slots.filter((s) => visible(s.work_id)).map((s) => ({label: `${s.station_name}・${ym(s.broadcast_month)}`, detail: `${workTitle.get(s.work_id)}・${BROADCAST_LABELS[s.status]}`, workId: s.work_id}))});

      const deliverables = await db.all("SELECT id, work_id, title, due_on, status FROM sales_deliverables WHERE org_id=? AND status IN ('pending','blocked') AND due_on IS NOT NULL AND due_on<? ORDER BY due_on", [i.org_id, today]);
      push({id: 'deliverables-overdue', title: '納期を過ぎた納品物', page: '商品・営業', params: {view: 'pipeline', pipe: 'deliverables'}, tone: 'bad',
        rows: deliverables.filter((d) => visible(d.work_id)).map((d) => ({label: d.title, detail: `${workTitle.get(d.work_id)}・納期 ${ymd(d.due_on)}${d.status === 'blocked' ? '・保留中' : ''}`, workId: d.work_id}))});

      const maps = await db.all('SELECT product_id, work_id FROM product_works WHERE org_id=?', [i.org_id]);
      const unbilled = (await db.all(`SELECT s.id, s.work_id, s.product_id, s.accounting_month, s.amount_inc_tax, p.name AS partner_name FROM sale_lines s
        JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id AND r.status='active' JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
        LEFT JOIN billing_sale_claims bc ON bc.org_id=s.org_id AND bc.sale_id=s.id LEFT JOIN billing_invoice_voids v ON v.org_id=s.org_id AND v.invoice_id=bc.invoice_id
        WHERE s.org_id=? AND (bc.invoice_id IS NULL OR v.invoice_id IS NOT NULL) ORDER BY s.accounting_month, s.id`, [i.org_id]))
        .filter((s) => {
          const allocated = s.product_id ? maps.filter((m) => m.product_id === s.product_id).map((m) => m.work_id) : [];
          return (allocated.length ? allocated : [s.work_id]).every((id) => financeWorks.has(id));
        });
      push({id: 'unbilled-sales', title: '請求していない売上', page: '売上', params: {billing: 'unbilled'}, tone: 'info',
        rows: unbilled.map((s) => ({label: `${s.partner_name}・${ym(s.accounting_month)}`, detail: `${s.amount_inc_tax.toLocaleString('ja-JP')}円（税込）`}))});

      const invoices = await db.all(`SELECT inv.id, inv.invoice_number, inv.due_date, inv.amount_inc_tax, p.name AS partner_name,
          COALESCE((SELECT SUM(a.amount_yen) FROM billing_receipt_allocations a JOIN billing_receipts r ON r.org_id=a.org_id AND r.id=a.receipt_id
            LEFT JOIN billing_receipt_reversals rv ON rv.org_id=r.org_id AND rv.receipt_id=r.id WHERE a.org_id=inv.org_id AND a.invoice_id=inv.id AND rv.receipt_id IS NULL),0) AS paid
        FROM billing_invoices inv JOIN partners p ON p.org_id=inv.org_id AND p.id=inv.partner_id
        LEFT JOIN billing_invoice_voids v ON v.org_id=inv.org_id AND v.invoice_id=inv.id
        WHERE inv.org_id=? AND v.invoice_id IS NULL AND inv.due_date<? ORDER BY inv.due_date`, [i.org_id, today]);
      const invoiceWorks = await db.all('SELECT DISTINCT invoice_id, work_id FROM billing_invoice_line_works WHERE org_id=?', [i.org_id]);
      const overdue = invoices.filter((inv) => inv.amount_inc_tax - inv.paid > 0 && invoiceWorks.filter((w) => w.invoice_id === inv.id).every((w) => financeWorks.has(w.work_id)));
      push({id: 'overdue-invoices', title: '支払期日を過ぎた未入金の請求', page: '帳票センター', params: {report: 'receivables'}, tone: 'bad',
        rows: overdue.map((inv) => ({label: `${inv.partner_name}・${inv.invoice_number}`, detail: `期日 ${ymd(inv.due_date)}・残高 ${(inv.amount_inc_tax - inv.paid).toLocaleString('ja-JP')}円`}))});

      const mgAll = await db.all(`SELECT l.id, l.term_version_id, l.accounting_month, l.source_reference, COALESCE(ic.code, oc.code) AS contract_code FROM mg_ledger_entries l
        JOIN mg_term_versions v ON v.org_id=l.org_id AND v.id=l.term_version_id
        LEFT JOIN mg_incoming_contracts ic ON ic.org_id=v.org_id AND ic.id=v.incoming_contract_id LEFT JOIN mg_outgoing_contracts oc ON oc.org_id=v.org_id AND oc.id=v.outgoing_contract_id
        WHERE l.org_id=? AND l.status='unverified' ORDER BY l.accounting_month, l.id`, [i.org_id]);
      // MG契約の画面と同じく、条件版の全商品の作品に財務権限があるものだけを数える
      const versionOk = new Map();
      const mg = [];
      for (const m of mgAll) {
        if (!versionOk.has(m.term_version_id)) versionOk.set(m.term_version_id, await canContractVersion(db, i, m.term_version_id, settlementWork));
        if (versionOk.get(m.term_version_id)) mg.push(m);
      }
      push({id: 'mg-unverified', title: '未確認のMG台帳の行', page: 'MG契約・台帳', tone: 'info',
        rows: mg.map((m) => ({label: `${m.contract_code}・${ym(m.accounting_month)}`, detail: `元資料 ${m.source_reference}`}))});

      // ロイヤリティ報告書の作成待ち・期限超過（契約のサイクルから並べる。財務権限のない作品の契約を持つ権利者は除く）
      const royalty = (await royaltyPeriods(db, i, {settlementWork, permittedProjects}, {asOf: today, withDrafts: false})).periods
        .filter((period) => !period.restricted && (period.status === 'pending' || period.status === 'overdue'))
        .sort((a, b) => a.closeMonth.localeCompare(b.closeMonth) || String(a.holderName).localeCompare(String(b.holderName), 'ja'));
      push({id: 'royalty-periods', title: 'ロイヤリティ報告書の作成待ち・期限超過', page: 'ロイヤリティ作成', tone: royalty.some((period) => period.status === 'overdue') ? 'bad' : 'warn',
        rows: royalty.map((period) => ({label: `${period.holderName}・${ym(period.closeMonth)}締め`,
          detail: `${period.statusLabel}${period.statementId ? '（作成済み・報告の記録なし）' : ''}${period.reportDueOn ? `・報告期限 ${ymd(period.reportDueOn)}` : ''}`}))});
    }

    if (i.role === 'admin') {
      const plans = await db.all(`SELECT q.id, q.invoice_id, q.proposed_due_date, inv.invoice_number FROM receipt_plan_requests q
        JOIN billing_invoices inv ON inv.org_id=q.org_id AND inv.id=q.invoice_id
        LEFT JOIN receipt_plan_decisions d ON d.org_id=q.org_id AND d.request_id=q.id WHERE q.org_id=? AND d.request_id IS NULL ORDER BY q.id`, [i.org_id]);
      push({id: 'receipt-plan-requests', title: '入金予定の変更の承認待ち', page: '月別消込', tone: 'warn',
        rows: plans.map((p) => ({label: p.invoice_number, detail: `新しい予定日 ${ymd(p.proposed_due_date)}`}))});
      const changes = await db.all("SELECT cs.id, cs.reason, cs.created_at, cs.draft_id, d.dataset FROM workbench_change_sets cs JOIN workbench_drafts d ON d.id=cs.draft_id WHERE cs.org_id=? AND cs.status='submitted' ORDER BY cs.created_at", [i.org_id]);
      push({id: 'workbench-approvals', title: '表編集の承認待ち', page: '業務データ編集', tone: 'warn',
        rows: changes.map((cs) => ({label: cs.reason || '（理由なし）', detail: `${DATASET_LABELS[cs.dataset] || cs.dataset || ''}・申請 ${jstDateTime(cs.created_at)}`,
          page: cs.dataset === 'sales_import' ? '売上データ編集' : '業務データ編集', params: {draft: cs.draft_id}}))});
    }
    return c.json({ok: true, today, role: i.role, items, total: items.reduce((n, item) => n + item.count, 0)});
  });
}
