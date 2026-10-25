// 予算書の DB の読み書き（移行 0024。要件 docs/requirements/planning/budget-book.md）。
// 版・行・検査の結果は1回の batch で書き、行と検査の結果は版の番号から版の ID を引く（版の ID を先に読まない）。
// 確定の記録の連番・版の番号の取り合いは DB のトリガーが断る（受け口が 409 にする）。変更の記録 audit_log に1行残す（金額は残さない）
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const VERSION_ID = '(SELECT v.id FROM budget_versions v WHERE v.org_id=? AND v.project_id=? AND v.version_no=?)';

export async function readBudgetProject(db, orgId, projectId) {
  return db.get('SELECT id,code,title,status FROM projects WHERE org_id=? AND id=?', [orgId, projectId]);
}

export async function readProjectTitles(db, orgId, projectIds) {
  if (!projectIds.length) return [];
  return db.all(`SELECT id,code,title FROM projects WHERE org_id=? AND id IN (${projectIds.map(() => '?').join(',')}) ORDER BY id`, [orgId, ...projectIds]);
}

export async function readProjectWorks(db, orgId, projectId) {
  return db.all('SELECT id,code,title FROM works WHERE org_id=? AND project_id=? ORDER BY id', [orgId, projectId]);
}

export async function readBudgetVersions(db, orgId, projectId) {
  return db.all(`SELECT id,version_no,source_kind,source_file_name,previous_version_id,tax_rate_bps,management_fee_yen,contingency_yen,sheet_created_on,
    header_notes,title,reason,created_by,created_at FROM budget_versions WHERE org_id=? AND project_id=? ORDER BY version_no`, [orgId, projectId]);
}

export async function readBudgetLines(db, orgId, versionId) {
  return db.all(`SELECT category_code,line_no,work_id,department_id,name,unit_price_yen,qty_milli,unit,amount_ex_tax_yen,confirmed_source,payment_month,
    source_cell,note FROM budget_version_lines WHERE org_id=? AND version_id=? ORDER BY category_code,line_no`, [orgId, versionId]);
}

export async function readBudgetCheckRuns(db, orgId, projectId) {
  return db.all(`SELECT version_id,run_no,verdict,passed,failed,checks_json,created_at FROM budget_check_runs WHERE org_id=? AND project_id=?
    ORDER BY version_id,run_no`, [orgId, projectId]);
}

export async function readBudgetFixes(db, orgId, projectId) {
  return db.all(`SELECT f.seq,f.action,f.version_id,v.version_no,f.reason,f.created_by,f.created_at FROM budget_fixes f
    JOIN budget_versions v ON v.org_id=f.org_id AND v.id=f.version_id WHERE f.org_id=? AND f.project_id=? ORDER BY f.seq`, [orgId, projectId]);
}

// 一覧（フォルダ・予算書の一覧）に要る、案件ごとの版の最大の番号・確定の記録・最新の版の最新の検査
export async function readBudgetSummaries(db, orgId, projectIds) {
  if (!projectIds.length) return {versions: [], fixes: [], runs: []};
  const marks = projectIds.map(() => '?').join(',');
  const [versions, fixes, runs] = await Promise.all([
    db.all(`SELECT id,project_id,version_no,management_fee_yen,contingency_yen,tax_rate_bps,created_at FROM budget_versions
      WHERE org_id=? AND project_id IN (${marks}) ORDER BY project_id,version_no`, [orgId, ...projectIds]),
    db.all(`SELECT f.project_id,f.seq,f.action,f.version_id,v.version_no FROM budget_fixes f JOIN budget_versions v ON v.org_id=f.org_id AND v.id=f.version_id
      WHERE f.org_id=? AND f.project_id IN (${marks}) ORDER BY f.project_id,f.seq`, [orgId, ...projectIds]),
    db.all(`SELECT r.project_id,r.version_id,r.verdict,r.failed FROM budget_check_runs r WHERE r.org_id=? AND r.project_id IN (${marks})
      AND r.run_no=(SELECT MAX(x.run_no) FROM budget_check_runs x WHERE x.org_id=r.org_id AND x.version_id=r.version_id)`, [orgId, ...projectIds]),
  ]);
  return {versions, fixes, runs};
}

export async function readVersionLinesFor(db, orgId, versionIds) {
  if (!versionIds.length) return [];
  return db.all(`SELECT version_id,category_code,amount_ex_tax_yen FROM budget_version_lines WHERE org_id=? AND version_id IN (${versionIds.map(() => '?').join(',')})`,
    [orgId, ...versionIds]);
}

// 版・行・最初の検査の結果を1回の batch で足す。version は受け口が整えた値
export async function addBudgetVersion(db, orgId, projectId, version, {createdBy}) {
  const statements = [
    {sql: `INSERT INTO budget_versions(org_id,project_id,version_no,source_kind,source_file_name,previous_version_id,tax_rate_bps,management_fee_yen,contingency_yen,
      sheet_created_on,header_notes,title,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, projectId, version.versionNo, version.sourceKind, version.sourceFileName ?? null, version.previousVersionId ?? null, version.taxRateBps,
      version.managementFeeYen, version.contingencyYen, version.sheetCreatedOn ?? null, version.headerNotes ?? null, version.title ?? null, version.reason, createdBy]},
    ...version.lines.map((line) => ({
      sql: `INSERT INTO budget_version_lines(org_id,project_id,version_id,category_code,line_no,work_id,department_id,name,unit_price_yen,qty_milli,unit,
        amount_ex_tax_yen,confirmed_source,payment_month,source_cell,note) VALUES(?,?,${VERSION_ID},?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [orgId, projectId, orgId, projectId, version.versionNo, line.categoryCode, line.lineNo, line.workId ?? null, line.departmentId ?? null, line.name,
        line.unitPriceYen ?? null, line.qtyMilli ?? null, line.unit ?? null, line.amountExTaxYen, line.confirmedSource, line.paymentMonth ?? null,
        line.sourceCell ?? null, line.note ?? null]})),
    ...version.lines.flatMap((line) => (line.breakdown?.items ?? []).map((item) => ({
      sql: `INSERT INTO budget_line_items(org_id,project_id,version_id,category_code,line_no,item_no,breakdown_sheet,label,qty_milli,unit_price_yen,amount_ex_tax_yen,casting_ref,source_cell,note)
        VALUES(?,?,${VERSION_ID},?,?,?,?,?,?,?,?,?,?,?)`,
      params: [orgId, projectId, orgId, projectId, version.versionNo, line.categoryCode, line.lineNo, item.itemNo, line.breakdown.sheet, item.label, item.qtyMilli ?? null,
        item.unitPriceYen ?? null, item.amountExTaxYen, item.castingRef ?? null, item.sourceCell ?? null, item.note ?? null]}))),
    ...(version.templateVersionId ? [{sql: `INSERT INTO budget_version_templates(org_id,project_id,version_id,template_version_id) VALUES(?,?,${VERSION_ID},?)`,
      params: [orgId, projectId, orgId, projectId, version.versionNo, version.templateVersionId]}] : []),
    checkRunStatement(orgId, projectId, version.versionNo, 1, version.check, createdBy),
    {sql: AUDIT_INSERT, params: [orgId, createdBy, 'append', 'budget_version', `${projectId}:${version.versionNo}`,
      JSON.stringify({projectId, versionNo: version.versionNo, sourceKind: version.sourceKind, lineCount: version.lines.length})]},
  ];
  await db.batch(statements);
  return version.versionNo;
}

function checkRunStatement(orgId, projectId, versionNo, runNo, check, createdBy) {
  return {sql: `INSERT INTO budget_check_runs(org_id,project_id,version_id,run_no,verdict,passed,failed,checks_json,created_by) VALUES(?,?,${VERSION_ID},?,?,?,?,?,?)`,
    params: [orgId, projectId, orgId, projectId, versionNo, runNo, check.verdict, check.passed, check.failed, JSON.stringify(check.checks), createdBy]};
}

// 確定・取り消しの記録を1行足す（seq は読んだ最後の番号の次。取り合いは budget_fixes_sequence が断る）
export async function addBudgetFix(db, orgId, projectId, {seq, action, versionId, versionNo, reason}, {createdBy}) {
  await db.batch([
    {sql: 'INSERT INTO budget_fixes(org_id,project_id,seq,action,version_id,reason,created_by) VALUES(?,?,?,?,?,?,?)',
      params: [orgId, projectId, seq, action, versionId, reason, createdBy]},
    {sql: AUDIT_INSERT, params: [orgId, createdBy, action === 'fix' ? 'fix' : 'void', 'budget_fix', `${projectId}:${seq}`, JSON.stringify({projectId, versionNo, action})]},
  ]);
}

// ---- 型（テンプレ）と行の内訳（移行 0028）----

export async function readLineItems(db, orgId, versionId) {
  return db.all(`SELECT category_code,line_no,item_no,breakdown_sheet,label,qty_milli,unit_price_yen,amount_ex_tax_yen,casting_ref,source_cell,note
    FROM budget_line_items WHERE org_id=? AND version_id=? ORDER BY category_code,line_no,item_no`, [orgId, versionId]);
}

export async function readVersionTemplate(db, orgId, versionId) {
  return db.get(`SELECT t.id AS template_id,t.name,tv.version_no FROM budget_version_templates bt JOIN budget_template_versions tv ON tv.org_id=bt.org_id AND tv.id=bt.template_version_id
    JOIN budget_templates t ON t.org_id=tv.org_id AND t.id=tv.template_id WHERE bt.org_id=? AND bt.version_id=?`, [orgId, versionId]);
}

export async function readBudgetTemplates(db, orgId) {
  return db.all(`SELECT t.id,t.name,t.created_at,v.id AS version_id,v.version_no,v.created_at AS version_created_at,v.reason,
      (SELECT COUNT(*) FROM budget_template_items i WHERE i.org_id=v.org_id AND i.template_version_id=v.id) AS item_count,
      (SELECT COUNT(*) FROM budget_template_items i WHERE i.org_id=v.org_id AND i.template_version_id=v.id AND i.breakdown_sheet IS NOT NULL) AS breakdown_count
    FROM budget_templates t JOIN budget_template_versions v ON v.org_id=t.org_id AND v.template_id=t.id
      AND v.version_no=(SELECT MAX(x.version_no) FROM budget_template_versions x WHERE x.org_id=t.org_id AND x.template_id=t.id)
    WHERE t.org_id=? ORDER BY t.name`, [orgId]);
}

export async function readBudgetTemplate(db, orgId, templateId) {
  return db.get('SELECT id,name,created_at FROM budget_templates WHERE org_id=? AND id=?', [orgId, templateId]);
}

export async function readTemplateVersions(db, orgId, templateId) {
  return db.all(`SELECT id,version_no,source_kind,source_file_name,source_project_id,source_budget_version_id,reason,created_by,created_at
    FROM budget_template_versions WHERE org_id=? AND template_id=? ORDER BY version_no`, [orgId, templateId]);
}

export async function readTemplateItems(db, orgId, templateVersionId) {
  return db.all(`SELECT category_code,line_no,name,unit,unit_price_yen,qty_milli,breakdown_sheet,note FROM budget_template_items
    WHERE org_id=? AND template_version_id=? ORDER BY category_code,line_no`, [orgId, templateVersionId]);
}

const TEMPLATE_VERSION_ID = '(SELECT v.id FROM budget_template_versions v WHERE v.org_id=? AND v.template_id=? AND v.version_no=?)';

function templateItemStatements(orgId, templateId, versionNo, items) {
  return items.map((item) => ({sql: `INSERT INTO budget_template_items(org_id,template_version_id,category_code,line_no,name,unit,unit_price_yen,qty_milli,breakdown_sheet,note)
    VALUES(?,${TEMPLATE_VERSION_ID},?,?,?,?,?,?,?,?)`, params: [orgId, orgId, templateId, versionNo, item.categoryCode, item.lineNo, item.name, item.unit ?? null,
    item.unitPriceYen ?? null, item.qtyMilli ?? null, item.breakdownSheet ?? null, item.note ?? null]}));
}

// 型を新しく作る（型と版1と費目を1回の batch で）
// 型の ID は名前から引く（型・版・費目を1回の batch で書き、途中で落ちたら何も残さない）
export async function addBudgetTemplate(db, orgId, {name, source, items, reason}, {createdBy}) {
  const templateId = `(SELECT t.id FROM budget_templates t WHERE t.org_id=${Number(orgId)} AND t.name=?)`;
  await db.batch([
    {sql: 'INSERT INTO budget_templates(org_id,name,created_by) VALUES(?,?,?)', params: [orgId, name, createdBy]},
    {sql: `INSERT INTO budget_template_versions(org_id,template_id,version_no,source_kind,source_file_name,source_project_id,source_budget_version_id,reason,created_by)
      VALUES(?,${templateId},1,?,?,?,?,?,?)`, params: [orgId, name, source.kind, source.fileName ?? null, source.projectId ?? null, source.budgetVersionId ?? null, reason, createdBy]},
    ...items.map((item) => ({sql: `INSERT INTO budget_template_items(org_id,template_version_id,category_code,line_no,name,unit,unit_price_yen,qty_milli,breakdown_sheet,note)
      VALUES(?,(SELECT v.id FROM budget_template_versions v WHERE v.org_id=? AND v.version_no=1 AND v.template_id=${templateId}),?,?,?,?,?,?,?,?)`,
    params: [orgId, orgId, name, item.categoryCode, item.lineNo, item.name, item.unit ?? null, item.unitPriceYen ?? null, item.qtyMilli ?? null, item.breakdownSheet ?? null, item.note ?? null]})),
    {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
      params: [orgId, createdBy, 'append', 'budget_template', name, JSON.stringify({itemCount: items.length, source: source.kind})]},
  ]);
  return Number((await db.get('SELECT id FROM budget_templates WHERE org_id=? AND name=?', [orgId, name])).id);
}

export async function addTemplateVersion(db, orgId, templateId, {versionNo, source, items, reason}, {createdBy}) {
  await db.batch([
    {sql: `INSERT INTO budget_template_versions(org_id,template_id,version_no,source_kind,source_file_name,source_project_id,source_budget_version_id,reason,created_by)
      VALUES(?,?,?,?,?,?,?,?,?)`, params: [orgId, templateId, versionNo, source.kind, source.fileName ?? null, source.projectId ?? null, source.budgetVersionId ?? null, reason, createdBy]},
    ...templateItemStatements(orgId, templateId, versionNo, items),
    {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
      params: [orgId, createdBy, 'append', 'budget_template_version', `${templateId}:${versionNo}`, JSON.stringify({templateId, versionNo, itemCount: items.length, source: source.kind})]},
  ]);
}
