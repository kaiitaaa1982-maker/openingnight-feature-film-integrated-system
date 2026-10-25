// 売上集計シートの列の採用（adopt・adopt-v2）と MG の列が読む表の読み取り（DB の役。業務の判断はしない。数えるのは sales-sheet-model.mjs）。
// どれも org_id で絞る。最新の版は版の番号が最大の行。

// 裁定3 (a) の食い違いを数える材料: 最新のロイヤリティ計上の基準の版と売上の額、最新の外貨の版（報告の状態は問わない）
export async function loadRoyaltyMismatchRows(db, orgId) {
  const [basis, currency] = await Promise.all([
    db.all(`SELECT s.id AS sale_id,s.amount_ex_tax,s.tax_amount,s.amount_inc_tax,b.royalty_amount_ex_tax,b.royalty_tax_amount,b.royalty_amount_inc_tax
      FROM sale_lines s JOIN sale_royalty_basis_versions b ON b.org_id=s.org_id AND b.sale_id=s.id
      WHERE s.org_id=? AND b.version_no=(SELECT MAX(x.version_no) FROM sale_royalty_basis_versions x WHERE x.org_id=b.org_id AND x.sale_id=b.sale_id)`, [orgId]),
    db.all(`SELECT v.sale_id,v.currency_code,v.original_amount_x100,v.original_royalty_x100 FROM sale_currency_versions v
      WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM sale_currency_versions x WHERE x.org_id=v.org_id AND x.sale_id=v.sale_id)`, [orgId]),
  ]);
  return {basis, currency};
}

// 拡張属性の最新の版（値を消した版を含む。数えるときに除く）
export function loadLatestAttributeValues(db, orgId) {
  return db.all(`SELECT a.sale_id,a.column_key,a.value_text,a.value_number FROM sale_attribute_values a
    WHERE a.org_id=? AND a.version_no=(SELECT MAX(x.version_no) FROM sale_attribute_values x WHERE x.org_id=a.org_id AND x.sale_id=a.sale_id AND x.column_key=a.column_key)`, [orgId]);
}

// 裁定1の前提（G-7）を確かめる材料: 料率のキーの値がある売上と、その流通分類の最新の版（流通マスタつき）・流通別の詳細のモデル。
// まとまりを決めるのは sales-sheet-model.mjs の rateSaleBlocksOf。rateKeys: 料率のキー
export async function loadRateSaleBlockRows(db, orgId, rateKeys) {
  const keys = JSON.stringify(rateKeys);
  const hasRate = `EXISTS(SELECT 1 FROM sale_attribute_values ra WHERE ra.org_id=s.org_id AND ra.sale_id=s.id AND ra.column_key IN (SELECT value FROM json_each(?)))`;
  const q = (sql) => db.all(sql, [orgId, keys]);
  const [sales, dist, th, pk, dg] = await Promise.all([
    q(`SELECT s.id FROM sale_lines s WHERE s.org_id=? AND ${hasRate}`),
    q(`SELECT d.sale_id,d.distribution_code,d.settlement_method,m.distribution_name,m.transaction_method,m.sales_type FROM sale_distribution_versions d
      JOIN sale_lines s ON s.org_id=d.org_id AND s.id=d.sale_id LEFT JOIN distribution_master m ON m.code=d.distribution_code
      WHERE d.org_id=? AND ${hasRate} AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=d.org_id AND x.sale_id=d.sale_id)`),
    q(`SELECT t.sale_id,t.model FROM theatrical_sale_details t JOIN sale_lines s ON s.org_id=t.org_id AND s.id=t.sale_id WHERE t.org_id=? AND ${hasRate}`),
    q(`SELECT p.sale_id,p.model FROM package_sale_details p JOIN sale_lines s ON s.org_id=p.org_id AND s.id=p.sale_id WHERE p.org_id=? AND ${hasRate}`),
    q(`SELECT g.sale_id,g.model FROM digital_sale_details g JOIN sale_lines s ON s.org_id=g.org_id AND s.id=g.sale_id WHERE g.org_id=? AND ${hasRate}`),
  ]);
  return {sales, dist, th, pk, dg};
}

// 受取の MG 契約・条件版・条件版の商品・台帳の行（受取の契約の版の行だけ）
export async function loadIncomingMg(db, orgId) {
  const [contracts, terms, products, ledger] = await Promise.all([
    db.all('SELECT id,code FROM mg_incoming_contracts WHERE org_id=?', [orgId]),
    db.all('SELECT id,incoming_contract_id,version,mg_amount_yen,starts_on,ends_on FROM mg_term_versions WHERE org_id=? AND incoming_contract_id IS NOT NULL', [orgId]),
    db.all('SELECT term_version_id,product_id FROM mg_version_products WHERE org_id=?', [orgId]),
    db.all(`SELECT l.id,l.term_version_id,l.product_id,l.accounting_month,l.applied_recoup_yen,l.reverses_entry_id FROM mg_ledger_entries l
      JOIN mg_term_versions v ON v.org_id=l.org_id AND v.id=l.term_version_id WHERE l.org_id=? AND v.incoming_contract_id IS NOT NULL`, [orgId]),
  ]);
  return {contracts, terms, products, ledger};
}
