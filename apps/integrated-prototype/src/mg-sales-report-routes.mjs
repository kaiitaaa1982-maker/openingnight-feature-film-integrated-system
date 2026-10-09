// MG売上報告（台帳ベース）の補助API。集計本体は既存の /api/rights-reports/mg-portfolio を使う。
// ここでは基準月の選択肢（台帳に明細がある月と件数、新しい順）だけを返す。
// 数えるのは、MG集計（mg-portfolio）と同じく、対象商品の配賦先の作品すべてに財務権限がある契約の台帳行だけ。
export function registerMgSalesReportRoutes(app, {db, bad, settlementWork}) {
  app.get('/api/reports/mg-sales/months', async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, 'MG集計の財務権限がありません', 403);
    const direction = c.req.query('direction') === 'outgoing' ? 'outgoing' : 'incoming';
    const column = direction === 'incoming' ? 'incoming_contract_id' : 'outgoing_contract_id';
    const [versions, versionProducts, mappings, ledger] = await Promise.all([
      db.all(`SELECT id, ${column} AS contract_id FROM mg_term_versions WHERE org_id=? AND ${column} IS NOT NULL`, [i.org_id]),
      db.all('SELECT term_version_id, product_id FROM mg_version_products WHERE org_id=?', [i.org_id]),
      db.all('SELECT product_id, work_id FROM product_works WHERE org_id=?', [i.org_id]),
      db.all(`SELECT l.term_version_id, l.accounting_month FROM mg_ledger_entries l JOIN mg_term_versions v ON v.org_id=l.org_id AND v.id=l.term_version_id
        WHERE l.org_id=? AND v.${column} IS NOT NULL`, [i.org_id]),
    ]);
    const access = new Map();
    const canWork = async (workId) => {
      if (!access.has(workId)) access.set(workId, Boolean(await settlementWork(i, workId)));
      return access.get(workId);
    };
    const readableVersions = new Set();
    for (const contractId of new Set(versions.map((v) => v.contract_id))) {
      const termIds = versions.filter((v) => v.contract_id === contractId).map((v) => v.id);
      const productIds = new Set(versionProducts.filter((p) => termIds.includes(p.term_version_id)).map((p) => p.product_id));
      const allocation = mappings.filter((m) => productIds.has(m.product_id));
      // 配賦の無い商品がある契約は、作品単位の権限を確かめられないので数えない（mg-portfolio と同じ）
      if (!productIds.size || [...productIds].some((id) => !allocation.some((m) => m.product_id === id))) continue;
      let ok = true;
      for (const workId of new Set(allocation.map((m) => m.work_id))) if (!await canWork(workId)) { ok = false; break; }
      if (ok) termIds.forEach((id) => readableVersions.add(id));
    }
    const counts = new Map();
    for (const row of ledger) if (readableVersions.has(row.term_version_id)) counts.set(row.accounting_month, (counts.get(row.accounting_month) || 0) + 1);
    const months = [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, entries]) => ({month, entries}));
    return c.json({ok: true, direction, months});
  });
}
