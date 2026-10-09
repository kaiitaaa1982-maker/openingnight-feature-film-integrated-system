// 放送枠の承認待ちを、作品を切り替えずに一覧する API。承認・差し戻し自体は既存の
// POST /api/broadcast/slots/:slotId/transition（版の照合・管理者だけの承認）を使う。
// 閲覧できる作品（案件の権限）の放送枠だけを返す。制作担当は 403。
import {broadcastConflictMap, partnerRoles} from '../broadcast.mjs';

const PENDING = ['pending_first', 'pending_final'];
const OPEN = ['draft', 'rejected', 'pending_first', 'tentative', 'pending_final'];

const currentSql = `SELECT v.*, s.created_at AS slot_created_at, u.display_name AS changed_by_name
  FROM broadcast_slot_versions v
  JOIN broadcast_slots s ON s.org_id=v.org_id AND s.id=v.slot_id
  LEFT JOIN users u ON u.id=v.changed_by
  WHERE v.org_id=? AND v.revision=(SELECT MAX(z.revision) FROM broadcast_slot_versions z WHERE z.org_id=v.org_id AND z.slot_id=v.slot_id)`;

const matchKey = (value) => String(value ?? '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();

export function registerBroadcastApprovalRoutes(app, {db, bad, permittedProjects}) {
  app.get('/api/broadcast/approvals', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '制作担当は放送枠の承認待ちを参照できません', 403);
    const scope = c.req.query('scope') === 'open' ? 'open' : 'pending';
    const statuses = scope === 'open' ? OPEN : PENDING;
    const visibleProjects = new Set((await permittedProjects(db, i, false)).map((row) => row.id));
    const editProjects = new Set((await permittedProjects(db, i, true)).map((row) => row.id));
    const works = (await db.all('SELECT id, project_id, code, title FROM works WHERE org_id=? ORDER BY code', [i.org_id])).filter((work) => visibleProjects.has(work.project_id));
    const workById = new Map(works.map((work) => [work.id, work]));
    const all = (await db.all(currentSql, [i.org_id])).filter((row) => workById.has(row.work_id));
    // 競合（同じ作品・同じ月の別の局）は作品ごとに、申請中でない枠も含めて判定する
    const conflicts = broadcastConflictMap(all);
    const partners = await db.all('SELECT id, code, name FROM partners WHERE org_id=?', [i.org_id]);
    const partnerById = new Map(partners.map((partner) => [partner.id, partner]));
    const roles = await partnerRoles(db, i.org_id);
    const stations = partners.filter((partner) => (roles.get(partner.id) || []).includes('broadcaster'));
    const agreements = new Map((await db.all('SELECT id, contract_code, title FROM sales_agreements WHERE org_id=?', [i.org_id])).map((row) => [row.id, row]));
    const isAdmin = i.role === 'admin';
    const rows = all.filter((row) => statuses.includes(row.status)).map((row) => {
      const work = workById.get(row.work_id);
      const station = stations.find((partner) => matchKey(partner.name) === matchKey(row.station_name) || matchKey(partner.code) === matchKey(row.station_name)) || null;
      const others = all.filter((other) => other.slot_id !== row.slot_id && other.work_id === row.work_id && other.broadcast_month === row.broadcast_month
        && matchKey(other.station_name) !== matchKey(row.station_name) && !['draft', 'rejected', 'cancelled'].includes(other.status));
      const canEdit = editProjects.has(work.project_id);
      return {
        slotId: row.slot_id, revision: row.revision, status: row.status, workId: work.id, workCode: work.code, workTitle: work.title,
        broadcastMonth: row.broadcast_month, stationName: row.station_name, stationRegistered: Boolean(station), stationPartnerName: station?.name ?? null,
        customerName: partnerById.get(row.customer_partner_id)?.name ?? null, agencyName: partnerById.get(row.agency_partner_id)?.name ?? null,
        agreementCode: agreements.get(row.agreement_id)?.contract_code ?? null, agreementTitle: agreements.get(row.agreement_id)?.title ?? null,
        periodFrom: row.period_from, periodTo: row.period_to, plannedOn: row.planned_on, plannedRuns: row.planned_runs,
        sourceReference: row.source_reference, reason: row.reason, requestedAt: row.created_at, requestedBy: row.changed_by_name ?? null,
        conflict: conflicts.get(row.slot_id) ?? null, conflictWith: others.map((other) => ({slotId: other.slot_id, stationName: other.station_name, status: other.status})),
        canEdit, canApprove: isAdmin && canEdit && PENDING.includes(row.status),
      };
    }).sort((a, b) => Number(!PENDING.includes(a.status)) - Number(!PENDING.includes(b.status)) || String(a.requestedAt).localeCompare(String(b.requestedAt)) || a.slotId - b.slotId);
    const counts = Object.fromEntries(OPEN.map((status) => [status, all.filter((row) => row.status === status).length]));
    return c.json({ok: true, scope, rows, counts, approvalRole: isAdmin, works: works.map((work) => ({id: work.id, code: work.code, title: work.title}))});
  });
}

export default registerBroadcastApprovalRoutes;
