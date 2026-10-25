// 製造の DB の読み書き（移行 0046）。行は足すだけで、上書き・削除はトリガーが断る。変更の記録 audit_log に1行残す（金額は残さない）
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const marks = (list) => list.map(() => '?').join(',');

export async function readWorksFor(db, orgId, projectIds) {
  if (!projectIds.length) return [];
  return db.all(`SELECT w.id,w.project_id,w.code,w.title FROM works w WHERE w.org_id=? AND w.project_id IN (${marks(projectIds)}) ORDER BY w.project_id,w.id`, [orgId, ...projectIds]);
}

export async function readPartners(db, orgId) {
  return db.all('SELECT id,code,name FROM partners WHERE org_id=? ORDER BY name', [orgId]);
}

export async function readProducts(db, orgId, projectIds) {
  if (!projectIds.length) return [];
  return db.all(`SELECT p.id,p.project_id,p.work_id,p.source_kind,p.source_ref,p.created_at,w.code AS work_code,w.title AS work_title FROM mfg_products p
    JOIN works w ON w.org_id=p.org_id AND w.id=p.work_id WHERE p.org_id=? AND p.project_id IN (${marks(projectIds)}) ORDER BY p.id`, [orgId, ...projectIds]);
}

export async function readProduct(db, orgId, productId) {
  return db.get(`SELECT p.id,p.project_id,p.work_id,p.source_kind,p.source_ref,p.created_at,w.code AS work_code,w.title AS work_title FROM mfg_products p
    JOIN works w ON w.org_id=p.org_id AND w.id=p.work_id WHERE p.org_id=? AND p.id=?`, [orgId, productId]);
}

export async function readVersions(db, orgId, productIds) {
  if (!productIds.length) return [];
  return db.all(`SELECT id,product_id,version_no,name,channel,media,edition_label,episode_from,episode_to,release_on,schedule_rule,planned_qty,note,reason,created_at
    FROM mfg_product_versions WHERE org_id=? AND product_id IN (${marks(productIds)}) ORDER BY product_id,version_no`, [orgId, ...productIds]);
}

export async function readStepEvents(db, orgId, productIds) {
  if (!productIds.length) return [];
  return db.all(`SELECT id,product_id,step_key,kind,on_date,voids_event_id,note,created_at FROM mfg_step_events WHERE org_id=? AND product_id IN (${marks(productIds)}) ORDER BY id`,
    [orgId, ...productIds]);
}

export async function readOrders(db, orgId, productIds) {
  if (!productIds.length) return {orders: [], lines: [], events: [], receipts: [], links: []};
  const orders = await db.all(`SELECT o.id,o.product_id,o.po_no,o.po_kind,o.partner_id,o.partner_label,o.deliver_to,o.due_on,o.note,o.created_at,pt.name AS partner_name
    FROM mfg_purchase_orders o LEFT JOIN partners pt ON pt.org_id=o.org_id AND pt.id=o.partner_id WHERE o.org_id=? AND o.product_id IN (${marks(productIds)}) ORDER BY o.id`,
    [orgId, ...productIds]);
  const ids = orders.map((o) => Number(o.id));
  if (!ids.length) return {orders, lines: [], events: [], receipts: [], links: []};
  const lines = await db.all(`SELECT id,po_id,line_no,item,spec,qty,unit_price_x100,amount_ex_tax_yen FROM mfg_purchase_order_lines WHERE org_id=? AND po_id IN (${marks(ids)}) ORDER BY po_id,line_no`,
    [orgId, ...ids]);
  const lineIds = lines.map((l) => Number(l.id));
  const [events, receipts, links] = await Promise.all([
    db.all(`SELECT id,po_id,kind,on_date,amount_ex_tax_yen,note,created_at FROM mfg_po_events WHERE org_id=? AND po_id IN (${marks(ids)}) ORDER BY id`, [orgId, ...ids]),
    lineIds.length ? db.all(`SELECT id,po_line_id,received_on,qty,defect_qty,result,note,created_at FROM mfg_receipts WHERE org_id=? AND po_line_id IN (${marks(lineIds)}) ORDER BY id`,
      [orgId, ...lineIds]) : [],
    lineIds.length ? db.all(`SELECT x.id,x.po_line_id,x.expense_id,x.action,x.reason,x.created_at,e.actual_ex_tax FROM mfg_po_expenses x
      LEFT JOIN expenses e ON e.org_id=x.org_id AND e.id=x.expense_id WHERE x.org_id=? AND x.po_line_id IN (${marks(lineIds)}) ORDER BY x.id`, [orgId, ...lineIds]) : [],
  ]);
  return {orders, lines, events, receipts, links};
}

export async function readOrderLine(db, orgId, lineId) {
  return db.get(`SELECT l.id,l.po_id,l.qty,o.product_id FROM mfg_purchase_order_lines l JOIN mfg_purchase_orders o ON o.org_id=l.org_id AND o.id=l.po_id
    WHERE l.org_id=? AND l.id=?`, [orgId, lineId]);
}

export async function readOrder(db, orgId, orderId) {
  return db.get('SELECT id,product_id,po_no FROM mfg_purchase_orders WHERE org_id=? AND id=?', [orgId, orderId]);
}

export async function readExpense(db, orgId, expenseId) {
  return db.get('SELECT id,project_id,work_id,partner_id,actual_ex_tax FROM expenses WHERE org_id=? AND id=?', [orgId, expenseId]);
}

export async function countOrders(db, orgId) {
  return Number((await db.get('SELECT COUNT(*) AS n FROM mfg_purchase_orders WHERE org_id=?', [orgId])).n);
}

export async function addProduct(db, orgId, {projectId, workId, sourceKind, sourceRef, version}, {createdBy}) {
  const row = await db.get(`INSERT INTO mfg_products(org_id,project_id,work_id,source_kind,source_ref,created_by) VALUES(?,?,?,?,?,?) RETURNING id`,
    [orgId, projectId, workId, sourceKind, sourceRef ?? null, createdBy]);
  const productId = Number(row.id);
  await addVersion(db, orgId, productId, {...version, versionNo: 1}, {createdBy});
  return productId;
}

export async function addVersion(db, orgId, productId, v, {createdBy}) {
  await db.batch([
    {sql: `INSERT INTO mfg_product_versions(org_id,product_id,version_no,name,channel,media,edition_label,episode_from,episode_to,release_on,schedule_rule,planned_qty,note,reason,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, productId, v.versionNo, v.name, v.channel, v.media, v.editionLabel, v.episodeFrom, v.episodeTo, v.releaseOn, v.scheduleRule, v.plannedQty, v.note, v.reason, createdBy]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'mfg_product_version', `${productId}:${v.versionNo}`, JSON.stringify({productId, versionNo: v.versionNo, releaseOn: v.releaseOn})]},
  ]);
}

export async function addStepEvent(db, orgId, productId, e, {createdBy}) {
  await db.batch([
    {sql: 'INSERT INTO mfg_step_events(org_id,product_id,step_key,kind,on_date,voids_event_id,note,created_by) VALUES(?,?,?,?,?,?,?,?)',
      params: [orgId, productId, e.stepKey, e.kind, e.onDate, e.voidsEventId, e.note, createdBy]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'mfg_step_event', String(productId), JSON.stringify({productId, stepKey: e.stepKey, kind: e.kind})]},
  ]);
}

export async function addOrder(db, orgId, productId, o, {createdBy}) {
  const row = await db.get(`INSERT INTO mfg_purchase_orders(org_id,product_id,po_no,po_kind,partner_id,partner_label,deliver_to,due_on,note,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`, [orgId, productId, o.poNo, o.poKind, o.partnerId, o.partnerLabel, o.deliverTo, o.dueOn, o.note, createdBy]);
  const poId = Number(row.id);
  await db.batch([
    ...o.lines.map((l) => ({sql: 'INSERT INTO mfg_purchase_order_lines(org_id,po_id,line_no,item,spec,qty,unit_price_x100,amount_ex_tax_yen) VALUES(?,?,?,?,?,?,?,?)',
      params: [orgId, poId, l.lineNo, l.item, l.spec, l.qty, l.unitPriceX100, l.amountExTaxYen]})),
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'mfg_purchase_order', o.poNo, JSON.stringify({productId, poKind: o.poKind, lineCount: o.lines.length})]},
  ]);
  return poId;
}

export async function addOrderEvent(db, orgId, poId, e, {createdBy}) {
  await db.batch([
    {sql: 'INSERT INTO mfg_po_events(org_id,po_id,kind,on_date,amount_ex_tax_yen,note,created_by) VALUES(?,?,?,?,?,?,?)',
      params: [orgId, poId, e.kind, e.onDate, e.amountExTaxYen ?? null, e.note ?? null, createdBy]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'mfg_po_event', String(poId), JSON.stringify({poId, kind: e.kind})]},
  ]);
}

export async function addReceipt(db, orgId, lineId, r, {createdBy}) {
  await db.batch([
    {sql: 'INSERT INTO mfg_receipts(org_id,po_line_id,received_on,qty,defect_qty,result,note,created_by) VALUES(?,?,?,?,?,?,?,?)',
      params: [orgId, lineId, r.receivedOn, r.qty, r.defectQty, r.result, r.note ?? null, createdBy]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'mfg_receipt', String(lineId), JSON.stringify({lineId, qty: r.qty, result: r.result})]},
  ]);
}

export async function addExpenseLink(db, orgId, lineId, x, {createdBy}) {
  await db.batch([
    {sql: 'INSERT INTO mfg_po_expenses(org_id,po_line_id,expense_id,action,reason,created_by) VALUES(?,?,?,?,?,?)',
      params: [orgId, lineId, x.expenseId, x.action, x.reason ?? null, createdBy]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, x.action, 'mfg_po_expense', String(lineId), JSON.stringify({lineId, expenseId: x.expenseId})]},
  ]);
}
