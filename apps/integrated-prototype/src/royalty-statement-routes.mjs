// ロイヤリティ報告書のAPI。作品ごとの権利・分配の試算（settlementPreviewData）を、閲覧できる作品すべてについて集め、
// 権利元×期間でまとめる。制作担当は参照できない。
import {allIn} from './sql-in.mjs';
import {buildRoyaltyStatement} from './reports/royalty-statement-model.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function registerRoyaltyStatementRoutes(app, {db, bad, settlementWork, settlementPreviewData}) {
  async function scope(i, workId) {
    const works = await db.all('SELECT id, title FROM works WHERE org_id=? ORDER BY id', [i.org_id]);
    const allowed = [];
    for (const work of works) if ((!workId || work.id === workId) && await settlementWork(i, work.id)) allowed.push(work);
    return allowed;
  }
  async function contractsFor(i, works) {
    if (!works.length) return [];
    const ids = works.map((w) => w.id);
    return allIn(db, `SELECT c.*, w.title AS work_title, p.name AS holder_name, p.code AS holder_code FROM settlement_contracts c
      JOIN works w ON w.org_id=c.org_id AND w.id=c.work_id LEFT JOIN partners p ON p.org_id=c.org_id AND p.id=c.holder_partner_id
      WHERE c.org_id=? AND c.work_id IN (:in) ORDER BY c.id`, {before: [i.org_id], ids, sortBy: (a, b) => a.id - b.id});
  }

  app.get('/api/reports/royalty-statement/holders', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, 'ロイヤリティ報告書は財務担当の帳票です', 403);
    const contracts = (await contractsFor(i, await scope(i, null))).filter((contract) => contract.holder_partner_id);
    const holders = new Map();
    for (const contract of contracts) {
      if (!holders.has(contract.holder_partner_id)) holders.set(contract.holder_partner_id, {id: contract.holder_partner_id, name: contract.holder_name, code: contract.holder_code, contracts: 0, mgContracts: 0});
      const h = holders.get(contract.holder_partner_id);
      h.contracts += 1;
      if (contract.contract_type === 'mg') h.mgContracts += 1;
    }
    return c.json({ok: true, holders: [...holders.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'))});
  });

  app.get('/api/reports/royalty-statement', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, 'ロイヤリティ報告書は財務担当の帳票です', 403);
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!MONTH.test(from || '') || !MONTH.test(to || '')) return bad(c, '期間（from・to）を「2026-05」の形で指定してください');
    if (from > to) return bad(c, '期間の開始月が終了月より後になっています');
    const holderId = c.req.query('holderId') ? Number(c.req.query('holderId')) : null;
    const workId = c.req.query('workId') ? Number(c.req.query('workId')) : null;
    try {
      const works = await scope(i, workId);
      if (workId && !works.length) return bad(c, '作品の財務権限がありません', 403);
      const contracts = await contractsFor(i, works);
      const lines = [];
      for (const work of works) {
        if (!contracts.some((contract) => contract.work_id === work.id)) continue;
        const preview = await settlementPreviewData(i, work.id);
        lines.push(...preview.lineResults);
      }
      const ids = contracts.map((contract) => contract.id);
      const payments = await allIn(db, 'SELECT * FROM rights_payment_events WHERE org_id=? AND settlement_contract_id IN (:in) ORDER BY paid_on, id', {before: [i.org_id], ids, sortBy: (a, b) => String(a.paid_on).localeCompare(String(b.paid_on)) || a.id - b.id});
      const statement = buildRoyaltyStatement({lines, contracts, payments, from, to, holderId});
      const holder = holderId ? contracts.find((contract) => contract.holder_partner_id === holderId) : null;
      const latest = await db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active'", [i.org_id]);
      return c.json({ok: true, ...statement, holder: holder ? {id: holderId, name: holder.holder_name, code: holder.holder_code} : null,
        dataAsOf: {latestImportAt: latest?.at || null, generatedAt: new Date().toISOString()}});
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });
}
