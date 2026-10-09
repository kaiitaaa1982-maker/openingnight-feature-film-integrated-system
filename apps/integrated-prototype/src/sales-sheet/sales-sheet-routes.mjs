// 売上集計シート（83列・売上基幹 › 計上 › 帳票）の API。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §4。
// - 列カタログ: 一覧・初期の83列の採用・列の追加・版（管理者だけ・理由必須・監査記録）
// - シート: サーバー側で絞り、ページに分ける（明細）／切り口で集計する（集計）。合計・空の列は条件に合う全行から作る
// - 値: 拡張属性（1売上×1列×版）・外貨・ロイヤリティ計上の基準を版で積む（財務の権限・理由必須・監査記録）
// - シート定義（保存した形）・Excel（条件のシートつき）・83列の順の CSV
// 見られるのは制作担当以外で、売上明細と同じ「財務の権限がある作品の、有効な報告の売上」。商品を複数の作品に配賦した明細は、
// 配賦先の作品すべてに権限があるときだけ出す（額は配賦前の明細の額）。
// D1 の上限: 作品・売上のIDを値として並べない（権限は副問い合わせ、読んだ売上のIDは json_each の1つの値で渡す）。
import {isDbConflict, isGuardViolation} from '../data-platform/db-errors.mjs';
import {encodeReportXlsx} from '../xlsx-report.mjs';
import {toCsv} from '../csv.mjs';
import {DISTRIBUTION_TYPE_LABELS_SQL} from '../distribution-label.mjs';
import {
  INITIAL_SHEET_COLUMNS, INITIAL_CATALOG_VERSION, COLUMN_SETS, COLUMN_SET_LABELS, ALL_SET, SOURCE_REFS, GROUPS, VALUE_TYPES, AGGREGATIONS, SOURCE_KINDS,
  columnsOfSet, BLOCK_LABELS, salesBlock, ADDITIONAL_SHEET_COLUMNS, ADDITIONAL_CATALOG_VERSION, ADDITIONAL_COLUMN_SETS,
} from './column-registry.mjs';
import {
  DIMENSIONS, MONTH_BASES, TAX_BASES, GRAINS, MAX_PIVOT_MONTHS, catalogIndex, requiredKeys, needsOf, rowRecord, rowValues, createGroup, addToGroup, finishGroup,
  aggregateCell, groupKeyOf, pivotAmountKey, monthRange, gridType, groupLabel,
} from './sales-sheet-model.mjs';
import {
  parseAttributeValue, sameAttribute, normalizeCurrencyInput, normalizeRoyaltyInput, normalizeColumnDefinition, normalizeSheetQuery, normalizeViewDefinition, BILLING_FILTERS, DEAL_TYPES,
} from './sales-sheet-input.mjs';
import {importLimits, reportByteLimit, utf8Bytes, kbText} from '../import/limits.mjs';

// 追加の項目の数の値（sale_attribute_values.value_number。型なしの列で、CHECK が整数か小数だけを通す）。SQLite（D1）は Number で返し、
// PostgreSQL の入口は型なしの列（numeric）を Decimal の文字列で返す（FR-CORE-DATA-013）ので、読んだ所で Number にそろえる。SQLite では値は変わらない
const attributeNumber = (row) => (row.value_number === null || row.value_number === undefined || typeof row.value_number === 'number' ? row : {...row, value_number: Number(row.value_number)});

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const attachment = (name, ascii) => `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name).toWellFormed())}`;
const stamp = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '');
const nowIso = () => new Date().toISOString();
export const SHEET_BATCH = 2000; // 全行を読むときの1回の件数
export const SUMMARY_LIMIT = 50000; // 合計・空の列を画面のたびに全行から作る上限（超えたら作らない）
export const EXPORT_LIMIT = 100000; // 集計・出力で読む行の上限（Excel の帳票の行の上限と同じ）
export const MAX_VALUE_CHANGES = 500;
const IDS = 'SELECT CAST(value AS INTEGER) FROM json_each(?)';
const KIND_CODE = {digital: 'digital_unknown', package: 'package_unknown', theatrical: 'theatrical', broadcast: 'broadcast_unknown'};

const text = (value, max, required = false) => {
  if (value !== null && value !== undefined && typeof value !== 'string') throw Error('文字を入力してください');
  const v = String(value ?? '').trim();
  if (v.length > max || (required && !v)) throw Error(required ? '理由を入れてください（1000文字まで）' : `${max}文字までです`);
  return v || null;
};
const reasonOf = (value) => text(value, 1000, true);
const intOf = (value, label) => {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isSafeInteger(n) || n < 0) throw Error(`${label}を確かめてください`);
  return n;
};

export function registerSalesSheetRoutes(app, {db, bad, body, permittedProjects, permittedProjectScope, mode = 'local'}) {
  const friendly = (error, message = error.message) => (isGuardViolation(error) ? '確かめた後に、別の人が同じ値を直しました。読み直してからもう一度登録してください'
    : /stale/.test(message) ? '版が進んでいます（別の人が先に直しました）。読み直してからもう一度登録してください'
      : /does not match the booked yen amount/.test(message) ? '外貨の計上額×為替レートが、円の計上額（税抜）と合いません'
        : /type mismatch/.test(message) ? '値の型が列の定義と合いません（列の型を確かめてください）' : message);
  const wrap = (fn) => async (c) => {
    try { return await fn(c); } catch (error) { return bad(c, friendly(error), isDbConflict(error) || /stale|immutable|mismatch|does not match/i.test(error.message) ? 409 : 400, undefined, error); }
  };
  const audit = (i, action, entity, id, detail) => ({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', params: [i.org_id, i.user_id, action, entity, String(id), JSON.stringify(detail)]});
  const guard = (sql, params) => ({sql: `INSERT INTO transaction_guards(value) SELECT 0 WHERE ${sql}`, params});
  const denied = (c, i) => (i.role === 'production' ? bad(c, '売上集計シートは財務担当の画面です（制作担当は使えません）', 403) : null);

  // ---- カタログ ----------------------------------------------------------------------------
  async function loadCatalog(orgId) {
    const rows = await db.all(`SELECT c.*, u.display_name AS created_by_name FROM sales_sheet_column_versions c LEFT JOIN users u ON u.id=c.created_by
      WHERE c.org_id=? AND c.version_no=(SELECT MAX(x.version_no) FROM sales_sheet_column_versions x WHERE x.org_id=c.org_id AND x.column_key=c.column_key)
      ORDER BY COALESCE(c.legacy_position,1000), c.sort_order, c.column_key`, [orgId]);
    return rows.map((row) => ({...row, active: Number(row.active) === 1}));
  }
  const publicColumn = (column) => ({
    key: column.column_key, label: column.label, group: column.group_key, groupLabel: groupLabel(column), valueType: column.value_type, type: gridType(column),
    aggregation: column.aggregation, aggregationLabel: AGGREGATIONS[column.aggregation], legacyPosition: column.legacy_position ?? null, sourceKind: column.source_kind,
    sourceRef: column.source_ref ?? null, formula: column.formula ?? null, numeratorKey: column.numerator_key ?? null, denominatorKey: column.denominator_key ?? null,
    ratioScale: column.ratio_scale ?? null, digits: column.digits ?? null, description: column.description ?? null, sortOrder: column.sort_order, active: Boolean(column.active),
    version: column.version_no, currencyScoped: Boolean(column.currencyScoped), updatedAt: column.created_at, updatedBy: column.created_by_name ?? null,
  });

  // ---- 見られる売上（副問い合わせで権限を絞る） ---------------------------------------------------
  function visibility(i) {
    if (i.role === 'admin') return {sql: '', params: []};
    const scope = permittedProjectScope(i, true);
    const works = `SELECT vw.id FROM works vw WHERE vw.org_id=? AND vw.project_id IN (${scope.sql})`;
    return {
      sql: ` AND s.work_id IN (${works}) AND NOT EXISTS(SELECT 1 FROM product_works vpw WHERE vpw.org_id=s.org_id AND vpw.product_id=s.product_id AND vpw.work_id NOT IN (${works}))`,
      params: [i.org_id, ...scope.params, i.org_id, ...scope.params],
    };
  }
  const monthExpr = (basis) => (basis === 'sales' ? "COALESCE(rr.sales_month, substr(s.sales_period_from,1,7))"
    : basis === 'royalty' ? 'COALESCE((SELECT b.royalty_month FROM sale_royalty_basis_versions b WHERE b.org_id=s.org_id AND b.sale_id=s.id ORDER BY b.version_no DESC LIMIT 1), s.accounting_month)'
      : 's.accounting_month');
  const FROM = `FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id JOIN partners pt ON pt.org_id=s.org_id AND pt.id=s.partner_id
    LEFT JOIN products pr ON pr.org_id=s.org_id AND pr.id=s.product_id LEFT JOIN report_recognition rr ON rr.org_id=s.org_id AND rr.report_id=s.report_id`;
  function filterSql(i, f, extra = []) {
    const where = ['s.org_id=?', "r.status='active'"];
    const params = [i.org_id];
    const vis = visibility(i);
    const month = monthExpr(f.monthBasis);
    if (f.from) { where.push(`${month}>=?`); params.push(f.from); }
    if (f.to) { where.push(`${month}<=?`); params.push(f.to); }
    if (f.workId) { where.push('(s.work_id=? OR EXISTS(SELECT 1 FROM product_works fw WHERE fw.org_id=s.org_id AND fw.product_id=s.product_id AND fw.work_id=?))'); params.push(f.workId, f.workId); }
    if (f.partnerId) { where.push('s.partner_id=?'); params.push(f.partnerId); }
    if (f.kind) { where.push('r.kind=?'); params.push(f.kind); }
    if (f.distribution) {
      where.push(`COALESCE((SELECT d.distribution_code FROM sale_distribution_versions d WHERE d.org_id=s.org_id AND d.sale_id=s.id ORDER BY d.version_no DESC LIMIT 1),
        CASE r.kind WHEN 'digital' THEN 'digital_unknown' WHEN 'package' THEN 'package_unknown' WHEN 'theatrical' THEN 'theatrical' WHEN 'broadcast' THEN 'broadcast_unknown' ELSE 'other' END)=?`);
      params.push(f.distribution);
    }
    // 請求（取り消していない請求に入っている売上が請求済）・商品（none は商品を決めていない明細）・取引区分（流通分類の精算方式。記録が無ければ未確認）
    if (f.billing) {
      const billed = `EXISTS(SELECT 1 FROM billing_sale_claims bc WHERE bc.org_id=s.org_id AND bc.sale_id=s.id
        AND NOT EXISTS(SELECT 1 FROM billing_invoice_voids bv WHERE bv.org_id=bc.org_id AND bv.invoice_id=bc.invoice_id))`;
      where.push(f.billing === 'billed' ? billed : `NOT ${billed}`);
    }
    if (f.productId === 'none') where.push('s.product_id IS NULL');
    else if (f.productId) { where.push('s.product_id=?'); params.push(Number(f.productId)); }
    if (f.deal) {
      where.push(`COALESCE((SELECT d.settlement_method FROM sale_distribution_versions d WHERE d.org_id=s.org_id AND d.sale_id=s.id ORDER BY d.version_no DESC LIMIT 1),'unverified')=?`);
      params.push(f.deal);
    }
    if (f.q) {
      const like = `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      where.push("(pt.name LIKE ? ESCAPE '\\' OR pt.code LIKE ? ESCAPE '\\' OR w.title LIKE ? ESCAPE '\\' OR w.code LIKE ? ESCAPE '\\' OR COALESCE(pr.sku,'') LIKE ? ESCAPE '\\' OR COALESCE(pr.name,'') LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\' OR r.report_key LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like, like, like, like);
    }
    for (const item of extra) { where.push(item.sql); params.push(...item.params); }
    return {sql: `${FROM} WHERE ${where.join(' AND ')}${vis.sql}`, params: [...params, ...vis.params]};
  }

  // ---- 行の材料（ctx）を読む -------------------------------------------------------------------
  // 組織で1回だけ読むもの（流通区分の名前・MG・報告の訂正の段数）
  async function loadShared(orgId, needs) {
    const shared = {types: new Map(), mg: null, depth: null};
    for (const row of await db.all(DISTRIBUTION_TYPE_LABELS_SQL)) shared.types.set(row.code, row.label);
    if (needs.has('mg')) {
      const [terms, products, ledger] = await Promise.all([
        db.all(`SELECT t.id,t.incoming_contract_id,t.version,t.mg_amount_yen,t.starts_on,t.ends_on,c.code FROM mg_term_versions t
          JOIN mg_incoming_contracts c ON c.org_id=t.org_id AND c.id=t.incoming_contract_id WHERE t.org_id=? AND t.incoming_contract_id IS NOT NULL`, [orgId]),
        db.all('SELECT term_version_id,product_id FROM mg_version_products WHERE org_id=?', [orgId]),
        db.all('SELECT id,term_version_id,accounting_month,applied_recoup_yen,reverses_entry_id FROM mg_ledger_entries WHERE org_id=?', [orgId]),
      ]);
      const latest = new Map();
      for (const t of terms) if (!latest.has(t.incoming_contract_id) || latest.get(t.incoming_contract_id).version < t.version) latest.set(t.incoming_contract_id, t);
      const contractOfTerm = new Map(terms.map((t) => [t.id, t.incoming_contract_id]));
      const byProduct = new Map();
      for (const p of products) {
        const contract = contractOfTerm.get(p.term_version_id);
        if (contract === undefined || latest.get(contract)?.id !== p.term_version_id) continue;
        if (!byProduct.has(p.product_id)) byProduct.set(p.product_id, []);
        byProduct.get(p.product_id).push(latest.get(contract));
      }
      const reversed = new Set(ledger.filter((e) => e.reverses_entry_id).map((e) => e.reverses_entry_id));
      const applied = new Map(); // contract -> [{month, yen}]
      for (const e of ledger) {
        if (e.reverses_entry_id || reversed.has(e.id)) continue;
        const contract = contractOfTerm.get(e.term_version_id);
        if (contract === undefined) continue;
        if (!applied.has(contract)) applied.set(contract, []);
        applied.get(contract).push({month: e.accounting_month, yen: Number(e.applied_recoup_yen)});
      }
      shared.mg = {byProduct, applied};
    }
    if (needs.has('depth')) {
      const chain = new Map((await db.all('SELECT id,supersedes_id FROM report_imports WHERE org_id=?', [orgId])).map((row) => [row.id, row.supersedes_id]));
      const memo = new Map();
      const depthOf = (id) => {
        if (memo.has(id)) return memo.get(id);
        let n = 0, cursor = chain.get(id);
        const seen = new Set([id]);
        while (cursor && !seen.has(cursor) && n < 1000) { seen.add(cursor); n += 1; cursor = chain.get(cursor); }
        memo.set(id, n);
        return n;
      };
      shared.depth = depthOf;
    }
    return shared;
  }
  function mgFor(shared, productId, month) {
    const list = productId ? shared.mg?.byProduct.get(productId) : null;
    if (!list?.length) return null;
    const covering = list.filter((t) => t.starts_on.slice(0, 7) <= month && t.ends_on.slice(0, 7) >= month);
    const term = (covering.length ? covering : list).sort((a, b) => b.starts_on.localeCompare(a.starts_on) || b.id - a.id)[0];
    const recouped = (shared.mg.applied.get(term.incoming_contract_id) || []).filter((e) => e.month <= month).reduce((n, e) => n + e.yen, 0);
    return {code: term.code, mg_amount_yen: term.mg_amount_yen, starts_on: term.starts_on, ends_on: term.ends_on, balance_yen: term.mg_amount_yen - recouped};
  }

  // ids の売上の ctx を ids の順で返す
  async function loadContexts(orgId, ids, needs, shared) {
    if (!ids.length) return [];
    const json = JSON.stringify(ids);
    const q = (sql, extra = []) => db.all(sql, [orgId, ...extra, json]);
    const tasks = {
      base: q(`SELECT s.id,s.work_id,s.product_id,s.partner_id,s.report_id,s.source_row,s.description,s.quantity,s.accounting_month,s.sales_period_from,s.sales_period_to,
          s.amount_ex_tax,s.tax_amount,s.amount_inc_tax,s.created_at,r.kind,r.report_key,r.created_at AS report_created_at,r.content_hash,r.supersedes_id,rr.sales_month,
          r.status AS report_status,r.period_from AS report_period_from,r.period_to AS report_period_to,
          w.code AS work_code,w.title AS work_title,pt.code AS partner_code,pt.name AS partner_name,pr.sku AS product_sku,pr.name AS product_name
        ${FROM} WHERE s.org_id=? AND s.id IN (${IDS})`),
    };
    if (needs.has('recognition')) tasks.recognition = q(`SELECT s.id AS sale_id,rr.* FROM sale_lines s JOIN report_recognition rr ON rr.org_id=s.org_id AND rr.report_id=s.report_id WHERE s.org_id=? AND s.id IN (${IDS})`);
    if (needs.has('dist')) tasks.dist = q(`SELECT d.sale_id,d.version_no,d.distribution_code,d.settlement_method,d.territory,d.service_name,m.distribution_name,m.transaction_method,m.sales_type
      FROM sale_distribution_versions d LEFT JOIN distribution_master m ON m.code=d.distribution_code
      WHERE d.org_id=? AND d.sale_id IN (${IDS}) AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=d.org_id AND x.sale_id=d.sale_id)`);
    if (needs.has('detail') || needs.has('dist')) {
      tasks.th = q(`SELECT * FROM theatrical_sale_details WHERE org_id=? AND sale_id IN (${IDS})`);
      tasks.pk = q(`SELECT * FROM package_sale_details WHERE org_id=? AND sale_id IN (${IDS})`);
      tasks.dg = q(`SELECT * FROM digital_sale_details WHERE org_id=? AND sale_id IN (${IDS})`);
    }
    if (needs.has('obs')) tasks.obs = q(`SELECT s.id AS sale_id,o.metric,o.count,o.unit FROM sale_lines s JOIN package_report_observations o ON o.org_id=s.org_id AND o.report_id=s.report_id AND o.source_row=s.source_row
      WHERE s.org_id=? AND s.id IN (${IDS})`);
    if (needs.has('billing')) {
      tasks.bill = q(`SELECT c.sale_id,i.id AS invoice_id,i.invoice_number,i.invoice_date,i.due_date,v.voided_on FROM billing_sale_claims c
        JOIN billing_invoices i ON i.org_id=c.org_id AND i.id=c.invoice_id LEFT JOIN billing_invoice_voids v ON v.org_id=i.org_id AND v.invoice_id=i.id
        WHERE c.org_id=? AND c.sale_id IN (${IDS})`);
      tasks.receipts = q(`SELECT a.invoice_id,MAX(b.received_on) AS received_on FROM billing_receipt_allocations a JOIN billing_receipts b ON b.org_id=a.org_id AND b.id=a.receipt_id
        LEFT JOIN billing_receipt_reversals x ON x.org_id=b.org_id AND x.receipt_id=b.id
        WHERE a.org_id=? AND x.receipt_id IS NULL AND a.invoice_id IN (SELECT c.invoice_id FROM billing_sale_claims c WHERE c.org_id=a.org_id AND c.sale_id IN (${IDS})) GROUP BY a.invoice_id`);
      tasks.plans = q(`SELECT q.invoice_id,q.proposed_due_date,d.version_no FROM receipt_plan_decisions d JOIN receipt_plan_requests q ON q.org_id=d.org_id AND q.id=d.request_id
        WHERE d.org_id=? AND d.decision='approved' AND q.invoice_id IN (SELECT c.invoice_id FROM billing_sale_claims c WHERE c.org_id=d.org_id AND c.sale_id IN (${IDS}))`);
    }
    if (needs.has('source')) {
      const reports = `SELECT s.report_id FROM sale_lines s WHERE s.org_id=? AND s.id IN (${IDS})`;
      const qs = (sql) => db.all(sql, [orgId, orgId, json]);
      tasks.srcCommits = qs(`SELECT c.report_id,c.file_id,c.partition_id,c.mapping_version_id,p.created_at AS processed_at,f.file_name FROM sales_source_commits c
        JOIN sales_source_partitions p ON p.org_id=c.org_id AND p.id=c.partition_id JOIN sales_source_files f ON f.org_id=c.org_id AND f.id=c.file_id
        WHERE c.org_id=? AND c.report_id IN (${reports})`);
      tasks.wfCommits = qs(`SELECT c.report_id,c.artifact_id,c.mapping_version_id,c.committed_at,a.file_name FROM workflow_report_commits c
        JOIN workflow_raw_artifacts a ON a.org_id=c.org_id AND a.id=c.artifact_id WHERE c.org_id=? AND c.report_id IN (${reports})`);
      tasks.provenance = qs(`SELECT m.report_id,m.mapping_version_id,m.created_at FROM mapping_import_provenance m WHERE m.org_id=? AND m.report_id IN (${reports})`);
    }
    if (needs.has('currency')) tasks.cur = q(`SELECT v.* FROM sale_currency_versions v WHERE v.org_id=? AND v.sale_id IN (${IDS})
      AND v.version_no=(SELECT MAX(x.version_no) FROM sale_currency_versions x WHERE x.org_id=v.org_id AND x.sale_id=v.sale_id)`);
    if (needs.has('royalty')) tasks.roy = q(`SELECT v.* FROM sale_royalty_basis_versions v WHERE v.org_id=? AND v.sale_id IN (${IDS})
      AND v.version_no=(SELECT MAX(x.version_no) FROM sale_royalty_basis_versions x WHERE x.org_id=v.org_id AND x.sale_id=v.sale_id)`);
    if (needs.has('attrs')) tasks.attrs = q(`SELECT a.sale_id,a.column_key,a.value_text,a.value_number,a.version_no FROM sale_attribute_values a WHERE a.org_id=? AND a.sale_id IN (${IDS})
      AND a.version_no=(SELECT MAX(x.version_no) FROM sale_attribute_values x WHERE x.org_id=a.org_id AND x.sale_id=a.sale_id AND x.column_key=a.column_key)`);
    const keys = Object.keys(tasks);
    const results = Object.fromEntries((await Promise.all(keys.map((key) => tasks[key]))).map((rows, index) => [keys[index], rows]));
    const bySale = (rows) => new Map((rows || []).map((row) => [row.sale_id, row]));
    const dist = bySale(results.dist), th = bySale(results.th), pk = bySale(results.pk), dg = bySale(results.dg), bill = bySale(results.bill), cur = bySale(results.cur), roy = bySale(results.roy);
    const receipts = new Map((results.receipts || []).map((row) => [row.invoice_id, row.received_on]));
    const plans = new Map();
    for (const row of results.plans || []) if (!plans.has(row.invoice_id) || plans.get(row.invoice_id).version_no < row.version_no) plans.set(row.invoice_id, row);
    const obs = new Map();
    for (const row of results.obs || []) { if (!obs.has(row.sale_id)) obs.set(row.sale_id, []); obs.get(row.sale_id).push(row); }
    const attrs = new Map();
    for (const row of (results.attrs || []).map(attributeNumber)) {
      if (!attrs.has(row.sale_id)) attrs.set(row.sale_id, {});
      if (row.value_text === null && row.value_number === null) continue; // 値を消した版
      attrs.get(row.sale_id)[row.column_key] = {t: row.value_text, n: row.value_number, v: row.version_no};
    }
    const source = new Map();
    for (const row of results.provenance || []) source.set(row.report_id, {reference_id: `mapping:report:${row.report_id}:version:${row.mapping_version_id}`, processing_id: `列対応の版 ${row.mapping_version_id}`, processed_at: row.created_at, file_name: null});
    for (const row of results.wfCommits || []) source.set(row.report_id, {reference_id: `workflow:artifact:${row.artifact_id}:mapping:${row.mapping_version_id}`, processing_id: `原本 ${row.artifact_id}・列対応の版 ${row.mapping_version_id}`, processed_at: row.committed_at, file_name: row.file_name});
    for (const row of results.srcCommits || []) source.set(row.report_id, {reference_id: `source:file:${row.file_id}:partition:${row.partition_id}:mapping:${row.mapping_version_id}`, processing_id: `原本の分割 ${row.partition_id}・列対応の版 ${row.mapping_version_id}`, processed_at: row.processed_at, file_name: row.file_name});
    const recognition = bySale(results.recognition);
    const byId = new Map();
    for (const row of results.base) {
      const d = dist.get(row.id);
      const invoice = bill.get(row.id);
      const billed = invoice && !invoice.voided_on;
      const code = d?.distribution_code || KIND_CODE[row.kind] || 'other';
      byId.set(row.id, {
        s: row, r: {kind: row.kind, report_key: row.report_key, created_at: row.report_created_at, content_hash: row.content_hash, supersedes_id: row.supersedes_id, depth: shared.depth ? shared.depth(row.report_id) : null,
          status: row.report_status, period_from: row.report_period_from, period_to: row.report_period_to}, recognition: recognition.get(row.id) || null,
        sales_month: row.sales_month, work: {code: row.work_code, title: row.work_title}, partner: {code: row.partner_code, name: row.partner_name},
        product: row.product_id ? {sku: row.product_sku, name: row.product_name} : null,
        dist: d ? {code: d.distribution_code, version_no: d.version_no, settlement_method: d.settlement_method, territory: d.territory, service_name: d.service_name} : null,
        master: d?.distribution_name ? {distribution_name: d.distribution_name, transaction_method: d.transaction_method, sales_type: d.sales_type} : null,
        distLabel: shared.types.get(code) || null,
        th: th.get(row.id) || null, pk: pk.get(row.id) || null, dg: dg.get(row.id) || null, obs: obs.get(row.id) || [],
        bill: billed ? {invoice_number: invoice.invoice_number, invoice_date: invoice.invoice_date, due_date: plans.get(invoice.invoice_id)?.proposed_due_date || invoice.due_date, received_on: receipts.get(invoice.invoice_id) || null} : null,
        mg: shared.mg ? mgFor(shared, row.product_id, row.accounting_month) : null,
        src: source.get(row.report_id) || null, cur: cur.get(row.id) || null, roy: roy.get(row.id) || null, attrs: attrs.get(row.id) || {},
      });
    }
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  // ---- 条件から列・行を作る ---------------------------------------------------------------------
  async function prepare(i, query) {
    const catalog = await loadCatalog(i.org_id);
    const index = catalogIndex(catalog);
    const parsed = normalizeSheetQuery(query, index);
    if (parsed.error) throw Error(parsed.error);
    const f = parsed.value;
    const selected = (f.columns.length ? f.columns : columnsOfSet(f.set, catalog)).filter((key) => index.has(key));
    const pivotKey = f.pivot ? pivotAmountKey(f.monthBasis, f.taxBasis) : null;
    const keys = requiredKeys([...selected, ...(pivotKey ? [pivotKey] : [])], index);
    const needs = needsOf(keys, index, {dimensions: f.dimensions, monthBasis: f.monthBasis});
    return {catalog, index, f, selected, keys, needs, pivotKey};
  }
  // 条件に合う全行を SHEET_BATCH 件ずつ読み、each(ctx) を呼ぶ
  async function eachRow(i, prep, each, limit = EXPORT_LIMIT) {
    const base = filterSql(i, prep.f);
    const total = Number((await db.get(`SELECT COUNT(*) AS n ${base.sql}`, base.params)).n);
    if (total > limit) return {total, tooMany: true};
    const shared = await loadShared(i.org_id, prep.needs);
    let last = 0;
    for (;;) {
      const page = filterSql(i, prep.f, [{sql: 's.id>?', params: [last]}]);
      const ids = (await db.all(`SELECT s.id ${page.sql} ORDER BY s.id LIMIT ${SHEET_BATCH}`, page.params)).map((row) => row.id);
      if (!ids.length) break;
      for (const ctx of await loadContexts(i.org_id, ids, prep.needs, shared)) each(ctx);
      last = ids.at(-1);
      if (ids.length < SHEET_BATCH) break;
    }
    return {total, tooMany: false};
  }
  const conditionList = (f, names = {}) => [
    ['月の基準', MONTH_BASES[f.monthBasis]], ['期間', f.from || f.to ? `${f.from || '…'}〜${f.to || '…'}` : '指定なし'],
    ...(f.workId ? [['作品', names.work || String(f.workId)]] : []), ...(f.partnerId ? [['取引先', names.partner || String(f.partnerId)]] : []),
    ...(f.kind ? [['報告の種類', {theatrical: '劇場', digital: '配信', package: 'ビデオグラム', broadcast: '放送', other: 'その他'}[f.kind]]] : []),
    ...(f.distribution ? [['流通ID', f.distribution]] : []), ...(f.q ? [['語句', f.q]] : []),
    ...(f.billing ? [['請求', BILLING_FILTERS[f.billing]]] : []), ...(f.productId ? [['商品', f.productId === 'none' ? '商品未登録（作品に直接計上）' : names.product || String(f.productId)]] : []),
    ...(f.deal ? [['取引区分', DEAL_TYPES[f.deal]]] : []),
    ['粒度', GRAINS[f.grain]], ...(f.dimensions.length ? [['切り口', f.dimensions.map((d) => DIMENSIONS[d].label).join('・')]] : []),
    ...(f.pivot ? [['月を横に並べる', `${TAX_BASES[f.taxBasis]}の${f.monthBasis === 'royalty' ? 'ロイヤリティ計上額' : '計上額'}`]] : []),
    ['列セット', f.columns.length ? '指定した列' : COLUMN_SET_LABELS[f.set] || f.set],
  ];
  // 条件に出す名前。作品は財務の権限がある案件の中で引く（権限が無ければ denied。売上明細と同じく 403 にする）
  async function names(i, f) {
    const out = {};
    if (f.workId) {
      const scope = permittedProjectScope(i, true);
      const work = await db.get(`SELECT title FROM works WHERE org_id=? AND id=? AND project_id IN (${scope.sql})`, [i.org_id, f.workId, ...scope.params]);
      if (!work) return {denied: true};
      out.work = work.title;
    }
    if (f.partnerId) out.partner = (await db.get('SELECT name FROM partners WHERE org_id=? AND id=?', [i.org_id, f.partnerId]))?.name;
    if (f.productId && f.productId !== 'none') {
      const product = await db.get('SELECT sku,name FROM products WHERE org_id=? AND id=?', [i.org_id, Number(f.productId)]);
      if (product) out.product = `${product.sku}｜${product.name}`;
    }
    return out;
  }
  const WORK_DENIED = '作品の財務権限がありません';

  // 集計（切り口ごと）。全行から作ってページに分ける
  async function aggregateRows(i, prep) {
    const groups = new Map();
    const pivotMonths = new Set();
    const totals = createGroup(prep.keys, prep.index);
    const result = await eachRow(i, prep, (ctx) => {
      const record = rowRecord(ctx, prep.keys, prep.index, {monthBasis: prep.f.monthBasis});
      addToGroup(totals, record);
      const {key, parts} = groupKeyOf(ctx, prep.f.dimensions);
      if (!groups.has(key)) groups.set(key, {parts, state: createGroup(prep.keys, prep.index), pivot: new Map()});
      const group = groups.get(key);
      addToGroup(group.state, record);
      if (prep.pivotKey && record.month) {
        pivotMonths.add(record.month);
        const amount = record.values[prep.pivotKey];
        if (amount !== null && amount !== undefined) group.pivot.set(record.month, (group.pivot.get(record.month) || 0) + amount);
      }
    });
    if (result.tooMany) return result;
    let months = [];
    if (prep.pivotKey) {
      const seen = [...pivotMonths].sort();
      months = monthRange(prep.f.from || seen[0], prep.f.to || seen.at(-1));
      if (months.length > MAX_PIVOT_MONTHS) throw Error(`月を横に並べるときは期間を${MAX_PIVOT_MONTHS}か月以内に絞ってください`);
    }
    const rows = [...groups.values()].map((group) => {
      const done = finishGroup(group.state);
      const row = {__count: done.count, __mixed: done.mixed};
      prep.f.dimensions.forEach((dim, n) => { row[`dim_${dim}`] = group.parts[n].text; row[`dimkey_${dim}`] = group.parts[n].key; });
      for (const key of prep.selected) row[key] = aggregateCell(prep.index.get(key), done.values[key]);
      for (const month of months) row[`m_${month}`] = group.pivot.has(month) ? group.pivot.get(month) : null;
      return row;
    }).sort((a, b) => prep.f.dimensions.map((dim) => String(a[`dimkey_${dim}`] || '￿').localeCompare(String(b[`dimkey_${dim}`] || '￿'))).find((n) => n !== 0) || 0);
    const total = finishGroup(totals);
    return {total: result.total, rows, months, totals: Object.fromEntries(prep.selected.map((key) => [key, aggregateCell(prep.index.get(key), total.values[key])])), mixed: total.mixed};
  }

  // 明細の1ページ（と、条件に合う全行の合計・空の列）
  async function detailPage(i, prep, {summary = true} = {}) {
    const base = filterSql(i, prep.f);
    const total = Number((await db.get(`SELECT COUNT(*) AS n ${base.sql}`, base.params)).n);
    const pages = Math.max(1, Math.ceil(total / prep.f.pageSize));
    const page = Math.min(prep.f.page, pages);
    const ids = (await db.all(`SELECT s.id ${base.sql} ORDER BY s.accounting_month DESC, s.id DESC LIMIT ? OFFSET ?`, [...base.params, prep.f.pageSize, (page - 1) * prep.f.pageSize])).map((row) => row.id);
    const shared = await loadShared(i.org_id, prep.needs);
    const contexts = await loadContexts(i.org_id, ids, prep.needs, shared);
    const rows = contexts.map((ctx) => ({__id: ctx.s.id, ...pick(rowValues(ctx, prep.keys, prep.index), prep.selected)}));
    let totals = null, empty = null, mixed = [];
    if (summary && total <= SUMMARY_LIMIT) {
      const state = createGroup(prep.keys, prep.index);
      const filled = new Set();
      await eachRow(i, prep, (ctx) => {
        const record = rowRecord(ctx, prep.keys, prep.index, {monthBasis: prep.f.monthBasis});
        addToGroup(state, record);
        for (const key of prep.selected) if (record.values[key] !== null && record.values[key] !== undefined) filled.add(key);
      });
      const done = finishGroup(state);
      totals = Object.fromEntries(prep.selected.map((key) => [key, aggregateCell(prep.index.get(key), done.values[key])]));
      empty = prep.selected.filter((key) => !filled.has(key));
      mixed = done.mixed;
    }
    return {total, page, pages, rows, totals, empty, mixed, summarySkipped: summary && total > SUMMARY_LIMIT};
  }
  const pick = (values, keys) => Object.fromEntries(keys.map((key) => [key, values[key] ?? null]));
  // 期間に行が無いとき、期間を外した同じ条件で、データのある最も新しい月（月の基準どおり）。画面の「データのある最新の年度を見る」に使う
  async function latestMonthOf(i, prep) {
    if (!prep.f.from && !prep.f.to) return null;
    const base = filterSql(i, {...prep.f, from: null, to: null});
    return (await db.get(`SELECT MAX(${monthExpr(prep.f.monthBasis)}) AS month ${base.sql}`, base.params))?.month || null;
  }
  // 今の条件で、流通の分類が1つも無い明細の件数（画面の「分類待ち」。帳票センターの流通の分類で分ける）
  async function unclassifiedCountOf(i, prep) {
    const base = filterSql(i, prep.f, [{sql: 'NOT EXISTS(SELECT 1 FROM sale_distribution_versions dv WHERE dv.org_id=s.org_id AND dv.sale_id=s.id)', params: []}]);
    return Number((await db.get(`SELECT COUNT(*) AS n ${base.sql}`, base.params))?.n || 0);
  }
  const scopeText = (i) => (i.role === 'admin' ? '組織の全作品の有効な報告の売上明細（訂正で置き換えた旧報告は含めない）'
    : '財務の権限がある作品の有効な報告の売上明細（訂正で置き換えた旧報告は含めない。複数の作品に配賦した商品の明細は、配賦先すべてに権限があるときだけ）');

  // ---- API: カタログ ----------------------------------------------------------------------------
  app.get('/api/sales-sheet/columns', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const catalog = await loadCatalog(i.org_id);
    const index = catalogIndex(catalog);
    const finance = (await permittedProjects(db, i, true)).length > 0;
    const adopted = catalog.length > 0;
    const additionalColumns = ADDITIONAL_SHEET_COLUMNS.filter((column) => !index.has(column.column_key))
      .map((column) => ({key: column.column_key, label: column.label, group: column.group_key, groupLabel: groupLabel(column)}));
    // 採用前: 採用する列の一覧（採用前に見られるように）と、管理者以外には依頼先の管理者の名前（組織の中の有効な管理者だけ）
    const pending = adopted ? {} : {
      initialColumns: INITIAL_SHEET_COLUMNS.map((column) => ({key: column.column_key, label: column.label, legacyPosition: column.legacy_position ?? null, group: column.group_key, groupLabel: groupLabel(column)})),
    };
    const contacts = adopted && !additionalColumns.length ? {} : {
      admins: i.role === 'admin' ? [] : (await db.all(`SELECT u.display_name FROM memberships m JOIN users u ON u.id=m.user_id
        WHERE m.org_id=? AND m.role='admin' AND m.active=1 AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY u.display_name`, [i.org_id, nowIso()])).map((row) => row.display_name),
    };
    return c.json({
      ok: true, adopted, ...pending, ...contacts, canAdmin: i.role === 'admin', canEdit: finance, catalogVersion: INITIAL_CATALOG_VERSION,
      columns: catalog.map((column) => publicColumn(index.get(column.column_key))),
      sets: [...COLUMN_SETS.map((set) => ({key: set.key, label: set.label, columns: columnsOfSet(set.key, catalog)})), {key: ALL_SET, label: COLUMN_SET_LABELS[ALL_SET], columns: columnsOfSet(ALL_SET, catalog)},
        ...ADDITIONAL_COLUMN_SETS.map((set) => ({key: set.key, label: set.label, columns: columnsOfSet(set.key, catalog)}))],
      additionalPending: additionalColumns.length, additionalColumns,
      initialCount: INITIAL_SHEET_COLUMNS.length, groups: GROUPS, valueTypes: VALUE_TYPES, aggregations: AGGREGATIONS, sourceKinds: SOURCE_KINDS,
      sourceRefs: Object.entries(SOURCE_REFS).map(([key, value]) => ({key, label: value.label, valueType: value.valueType})),
      dimensions: Object.entries(DIMENSIONS).map(([key, value]) => ({key, label: value.label})), monthBases: MONTH_BASES, taxBases: TAX_BASES, grains: GRAINS, blocks: BLOCK_LABELS,
    });
  }));

  // 他の画面（営業基幹の全作品のウィンドウ・取引先別リスト）から「この作品の売上集計シート」を出してよいか。
  // 制作担当は開けない（403 にせず canOpen: false を返す。画面はリンクを出さないだけ）。作品で絞るリンクは財務の権限がある作品だけ（管理者は全作品＝workIds: null）
  app.get('/api/sales-sheet/access', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return c.json({ok: true, canOpen: false, workIds: []});
    if (i.role === 'admin') return c.json({ok: true, canOpen: true, workIds: null});
    const scope = permittedProjectScope(i, true);
    const works = await db.all(`SELECT id FROM works WHERE org_id=? AND project_id IN (${scope.sql}) ORDER BY id`, [i.org_id, ...scope.params]);
    return c.json({ok: true, canOpen: true, workIds: works.map((row) => row.id)});
  }));

  app.post('/api/sales-sheet/columns/adopt', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '列の採用・追加・変更は管理者が行います', 403);
    const b = await body(c), reason = reasonOf(b.reason);
    if ((await loadCatalog(i.org_id)).length) return bad(c, 'この組織は売上集計シートの列を採用済みです。列は追加・版の作成で直してください', 409);
    const payload = INITIAL_SHEET_COLUMNS.map((column, n) => ({
      k: column.column_key, l: column.label, p: column.legacy_position, g: column.group_key, t: column.value_type, a: column.aggregation, nk: column.numerator_key, dk: column.denominator_key,
      rs: column.ratio_scale, d: column.digits, sk: column.source_kind, sr: column.source_ref, f: column.formula ? JSON.stringify(column.formula) : null, ds: column.description, o: (n + 1) * 10,
    }));
    await db.batch([
      guard('EXISTS(SELECT 1 FROM sales_sheet_column_versions WHERE org_id=?)', [i.org_id]),
      {sql: `INSERT INTO sales_sheet_column_versions(org_id,column_key,version_no,label,legacy_position,group_key,value_type,aggregation,numerator_key,denominator_key,ratio_scale,digits,
          source_kind,source_ref,formula_json,description,sort_order,active,reason,created_by)
        SELECT ?,json_extract(j.value,'$.k'),1,json_extract(j.value,'$.l'),json_extract(j.value,'$.p'),json_extract(j.value,'$.g'),json_extract(j.value,'$.t'),json_extract(j.value,'$.a'),
          json_extract(j.value,'$.nk'),json_extract(j.value,'$.dk'),json_extract(j.value,'$.rs'),json_extract(j.value,'$.d'),json_extract(j.value,'$.sk'),json_extract(j.value,'$.sr'),
          json_extract(j.value,'$.f'),json_extract(j.value,'$.ds'),json_extract(j.value,'$.o'),1,?,? FROM json_each(?) j`,
      params: [i.org_id, reason, i.user_id, JSON.stringify(payload)]},
      audit(i, 'adopt', 'sales_sheet_column', i.org_id, {template: INITIAL_CATALOG_VERSION, columns: payload.length, reason}),
    ]);
    return c.json({ok: true, adopted: payload.length}, 201);
  }));

  const insertColumn = (i, d, versionNo, reason) => ({sql: `INSERT INTO sales_sheet_column_versions(org_id,column_key,version_no,label,legacy_position,group_key,value_type,aggregation,numerator_key,
      denominator_key,ratio_scale,digits,source_kind,source_ref,formula_json,description,sort_order,active,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: [i.org_id, d.column_key, versionNo, d.label, d.legacy_position, d.group_key, d.value_type, d.aggregation, d.numerator_key, d.denominator_key, d.ratio_scale, d.digits,
    d.source_kind, d.source_ref, d.formula_json, d.description, d.sort_order, d.active, reason, i.user_id]});

  app.post('/api/sales-sheet/columns/adopt-additional', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '追加の列の採用は管理者が行います', 403);
    const b = await body(c), reason = reasonOf(b.reason);
    const index = catalogIndex(await loadCatalog(i.org_id));
    if (!index.size) return bad(c, '先に初期の83列を採用してください', 409);
    for (const column of ADDITIONAL_SHEET_COLUMNS) {
      const existing = index.get(column.column_key);
      if (existing && (existing.source_kind !== column.source_kind || existing.source_ref !== column.source_ref || existing.value_type !== column.value_type || existing.legacy_position !== null)) {
        return bad(c, `同じ列キーの独自列があります: ${column.column_key}。既存の定義は変更していません`, 409);
      }
    }
    const missing = ADDITIONAL_SHEET_COLUMNS.filter((column) => !index.has(column.column_key));
    for (const column of missing) {
      const clash = [...index.values()].find((existing) => existing.active && existing.label.normalize('NFKC') === column.label.normalize('NFKC'));
      if (clash) return bad(c, `追加の列の見出しが既存の列と重なります: ${column.label}（${clash.column_key}）。既存の定義は変更していません`, 409);
    }
    if (!missing.length) return c.json({ok: true, adopted: 0});
    await db.batch([
      ...missing.map((column) => insertColumn(i, {...column, formula_json: null, sort_order: 2000 + ADDITIONAL_SHEET_COLUMNS.indexOf(column) * 10, active: 1}, 1, reason)),
      audit(i, 'adopt', 'sales_sheet_column', i.org_id, {template: ADDITIONAL_CATALOG_VERSION, columns: missing.length, reason}),
    ]);
    return c.json({ok: true, adopted: missing.length}, 201);
  }));

  app.post('/api/sales-sheet/columns', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '列の採用・追加・変更は管理者が行います', 403);
    const b = await body(c), reason = reasonOf(b.reason);
    const catalog = await loadCatalog(i.org_id);
    if (!catalog.length) return bad(c, '先に初期の83列を採用してください', 409);
    const normalized = normalizeColumnDefinition(b, catalogIndex(catalog));
    if (normalized.error) throw Error(normalized.error);
    await db.batch([insertColumn(i, normalized.value, 1, reason), audit(i, 'create', 'sales_sheet_column', normalized.value.column_key, {version: 1, definition: normalized.value, reason})]);
    return c.json({ok: true, columnKey: normalized.value.column_key, version: 1}, 201);
  }));

  app.post('/api/sales-sheet/columns/:key/versions', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '列の採用・追加・変更は管理者が行います', 403);
    const b = await body(c), reason = reasonOf(b.reason), base = intOf(b.baseVersion, '元の版');
    const catalog = await loadCatalog(i.org_id);
    const index = catalogIndex(catalog);
    const current = index.get(c.req.param('key'));
    if (!current) return bad(c, '列がありません', 404);
    if (current.version_no !== base) return bad(c, `列が更新されています（いまは第${current.version_no}版）。読み直してから直してください`, 409);
    const normalized = normalizeColumnDefinition(b, index, current);
    if (normalized.error) throw Error(normalized.error);
    await db.batch([
      guard('?<>(SELECT COALESCE(MAX(version_no),0) FROM sales_sheet_column_versions WHERE org_id=? AND column_key=?)', [base, i.org_id, current.column_key]),
      insertColumn(i, normalized.value, base + 1, reason),
      audit(i, 'version', 'sales_sheet_column', current.column_key, {version: base + 1, before: publicColumn(current), after: normalized.value, reason}),
    ]);
    return c.json({ok: true, version: base + 1}, 201);
  }));

  // ---- API: シート -----------------------------------------------------------------------------
  app.get('/api/sales-sheet', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const prep = await prepare(i, c.req.query());
    const named = await names(i, prep.f);
    if (named.denied) return bad(c, WORK_DENIED, 403);
    const conditions = conditionList(prep.f, named);
    const columns = prep.selected.map((key) => publicColumn(prep.index.get(key)));
    if (!prep.catalog.length) return c.json({ok: true, adopted: false, columns: [], rows: [], total: 0, page: 1, pages: 1, conditions, scope: scopeText(i)});
    if (prep.f.grain === 'aggregate') {
      const out = await aggregateRows(i, prep);
      if (out.tooMany) return bad(c, `条件に合う売上が${out.total.toLocaleString('ja-JP')}件あり、集計できる${EXPORT_LIMIT.toLocaleString('ja-JP')}件を超えます。期間や取引先で絞ってください`, 413, {count: out.total});
      const pages = Math.max(1, Math.ceil(out.rows.length / prep.f.pageSize));
      const page = Math.min(prep.f.page, pages);
      const visible = prep.f.hideEmpty ? columns.filter((column) => out.rows.some((row) => row[column.key] !== null && row[column.key] !== undefined)) : columns;
      return c.json({ok: true, adopted: true, grain: 'aggregate', selected: prep.selected, dimensions: prep.f.dimensions.map((key) => ({key, label: DIMENSIONS[key].label})),
        columns: visible, hiddenEmpty: columns.filter((column) => !visible.includes(column)).map((column) => column.key), months: out.months, pivotKey: prep.pivotKey,
        rows: out.rows.slice((page - 1) * prep.f.pageSize, page * prep.f.pageSize), groups: out.rows.length, total: out.total, page, pages, pageSize: prep.f.pageSize,
        totals: out.totals, mixed: out.mixed, latestMonth: out.total === 0 ? await latestMonthOf(i, prep) : null, unclassifiedCount: await unclassifiedCountOf(i, prep), conditions, scope: scopeText(i)});
    }
    const out = await detailPage(i, prep, {summary: c.req.query('summary') !== '0'});
    const hidden = prep.f.hideEmpty && out.empty ? new Set(out.empty) : new Set();
    return c.json({ok: true, adopted: true, grain: 'detail', selected: prep.selected, columns: columns.filter((column) => !hidden.has(column.key)), hiddenEmpty: [...hidden],
      rows: out.rows, total: out.total, page: out.page, pages: out.pages, pageSize: prep.f.pageSize, totals: out.totals, mixed: out.mixed, summarySkipped: out.summarySkipped,
      latestMonth: out.total === 0 ? await latestMonthOf(i, prep) : null, unclassifiedCount: await unclassifiedCountOf(i, prep), conditions, scope: scopeText(i)});
  }));

  // Excel（画面の列の並び・条件のシート付き）
  app.get('/api/sales-sheet/export.xlsx', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const prep = await prepare(i, c.req.query());
    if (!prep.catalog.length) return bad(c, '売上集計シートの列がまだ採用されていません', 409);
    const named = await names(i, prep.f);
    if (named.denied) return bad(c, WORK_DENIED, 403);
    const conditions = conditionList(prep.f, named);
    const sheetColumn = (column) => {
      const type = gridType(column);
      return {key: column.column_key, label: column.label, type: column.aggregation === 'min_max' || column.aggregation === 'distinct' ? (prep.f.grain === 'aggregate' ? 'text' : type) : type,
        digits: column.digits ?? (column.value_type === 'rate_pct' ? 2 : 4), group: groupLabel(column)};
    };
    let columns = prep.selected.map((key) => sheetColumn(prep.index.get(key)));
    let rows = [], totals = {}, total = 0;
    if (prep.f.grain === 'aggregate') {
      const out = await aggregateRows(i, prep);
      if (out.tooMany) return bad(c, `条件に合う売上が${out.total.toLocaleString('ja-JP')}件あり、出力できる${EXPORT_LIMIT.toLocaleString('ja-JP')}件を超えます。期間や取引先で絞ってください`, 413);
      // 月を横に並べるときは、月の列を切り口の直後に置く（画面と同じ並び。右端まで送らなくても月が見える）
      columns = [...prep.f.dimensions.map((dim) => ({key: `dim_${dim}`, label: DIMENSIONS[dim].label, type: 'text'})),
        ...out.months.map((month) => ({key: `m_${month}`, label: `${month}（${prep.f.monthBasis === 'royalty' ? 'ロイヤリティ計上額' : '計上額'}・${TAX_BASES[prep.f.taxBasis]}）`, type: 'yen'})),
        {key: '__count', label: '明細数', type: 'int'}, ...columns];
      rows = out.rows;
      totals = out.totals;
      total = out.total;
    } else {
      const state = createGroup(prep.keys, prep.index);
      const collected = [];
      const result = await eachRow(i, prep, (ctx) => {
        const record = rowRecord(ctx, prep.keys, prep.index, {monthBasis: prep.f.monthBasis});
        addToGroup(state, record);
        collected.push({month: ctx.s.accounting_month, id: ctx.s.id, values: pick(record.values, prep.selected)});
      });
      if (result.tooMany) return bad(c, `条件に合う売上が${result.total.toLocaleString('ja-JP')}件あり、出力できる${EXPORT_LIMIT.toLocaleString('ja-JP')}件を超えます。期間や取引先で絞ってください`, 413);
      rows = collected.sort((a, b) => b.month.localeCompare(a.month) || b.id - a.id).map((item) => item.values);
      const done = finishGroup(state);
      totals = Object.fromEntries(prep.selected.map((key) => [key, aggregateCell(prep.index.get(key), done.values[key])]));
      total = result.total;
      if (prep.f.hideEmpty) {
        const filled = new Set(prep.selected.filter((key) => rows.some((row) => row[key] !== null && row[key] !== undefined)));
        columns = columns.filter((column) => filled.has(column.key));
      }
    }
    for (const row of rows) for (const key of Object.keys(row)) if (typeof row[key] === 'boolean') row[key] = row[key] ? 'はい' : 'いいえ';
    const totalValues = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, typeof value === 'boolean' ? (value ? 'はい' : 'いいえ') : value]));
    const definitionRows = prep.selected.map((key) => prep.index.get(key)).map((column) => ({
      position: column.legacy_position, key: column.column_key, label: column.label, group: groupLabel(column), type: VALUE_TYPES[column.value_type], aggregation: AGGREGATIONS[column.aggregation],
      source: column.source_kind === 'attribute' ? '拡張属性' : column.source_ref ? `${SOURCE_KINDS[column.source_kind]}（${SOURCE_REFS[column.source_ref]?.label || column.source_ref}）` : `式 ${JSON.stringify(column.formula)}`,
      ratio: column.aggregation === 'ratio' ? `${column.numerator_key} ÷ ${column.denominator_key}${column.ratio_scale === 100 ? ' ×100' : ''}` : '',
      description: column.description || '',
    }));
    const dataAsOf = nowIso();
    const sheets = [
      {name: '売上集計シート', title: '売上集計シート', conditions, dataAsOf, freezeCols: prep.f.grain === 'aggregate' ? Math.max(1, prep.f.dimensions.length) : 1, columns, rows,
        totals: [{label: `合計（${total.toLocaleString('ja-JP')}件）`, values: totalValues}],
        notes: ['合計行: 金額・件数は合計、在庫・残高は期末の値、単価・料率・回転率は分子と分母を足してから割った値、日付は最小〜最大、文字は種類の数。', scopeText(i),
          '外貨の額・為替レートは、通貨が混ざる合計では空にしています。', '追加の列の金額・数量は合算せず、同じ値ならその値、異なる値なら種類の数を表示します。']},
      {name: '条件', title: '売上集計シートの条件と列の定義', conditions, dataAsOf, freezeCols: 0,
        columns: [{key: 'position', label: '元の列番号', type: 'int'}, {key: 'key', label: '列キー', type: 'code'}, {key: 'label', label: '見出し', type: 'text'}, {key: 'group', label: 'まとまり', type: 'text'},
          {key: 'type', label: '型', type: 'text'}, {key: 'aggregation', label: '集計の決まり', type: 'text'}, {key: 'source', label: '取り方', type: 'text', wrap: true, width: 50},
          {key: 'ratio', label: '比率の分子÷分母', type: 'text'}, {key: 'description', label: '説明', type: 'text', wrap: true, width: 50}],
        rows: definitionRows, notes: conditions.map(([k, v]) => `${k}: ${v}`)},
      {name: '_meta', hidden: true, titleBand: false, freezeCols: 0, columns: [{key: 'key', label: '項目', type: 'text'}, {key: 'value', label: '値', type: 'text'}],
        rows: [{key: '出力日時', value: dataAsOf}, {key: '組織', value: String(i.org_id)}, {key: '行数', value: String(rows.length)}, {key: '明細数', value: String(total)},
          {key: '列', value: prep.selected.join(',')}, {key: '初期の列の版', value: INITIAL_CATALOG_VERSION}]},
    ];
    const bytes = encodeReportXlsx({sheets});
    return new Response(bytes, {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(`売上集計シート_${stamp()}.xlsx`, 'sales-sheet.xlsx')}});
  }));

  // 83列の順の CSV（明細・日付 YYYY/MM/DD・月 YYYY/MM・率は%の数・はい/いいえは 1/0）
  const exportCsv = (selectedColumns) => wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const catalog = await loadCatalog(i.org_id);
    if (!catalog.length) return bad(c, '売上集計シートの列がまだ採用されていません', 409);
    let legacy = catalog.filter((column) => column.legacy_position).sort((a, b) => a.legacy_position - b.legacy_position);
    const prep = await prepare(i, {...c.req.query(), grain: 'detail', ...(selectedColumns ? {} : {columns: legacy.map((column) => column.column_key).join(',')})});
    if (selectedColumns) legacy = prep.selected.map((key) => prep.index.get(key));
    if ((await names(i, prep.f)).denied) return bad(c, WORK_DENIED, 403);
    const format = (column, value) => {
      if (value === null || value === undefined) return '';
      if (column.value_type === 'date') return String(value).replaceAll('-', '/');
      if (column.value_type === 'month') return String(value).replace('-', '/');
      if (column.value_type === 'bool') return value ? '1' : '0';
      return value;
    };
    const lines = [];
    const result = await eachRow(i, prep, (ctx) => {
      const values = rowValues(ctx, prep.keys, prep.index);
      lines.push({month: ctx.s.accounting_month, id: ctx.s.id, cells: legacy.map((column) => format(column, values[column.column_key]))});
    });
    if (result.tooMany) return bad(c, `条件に合う売上が${result.total.toLocaleString('ja-JP')}件あり、出力できる${EXPORT_LIMIT.toLocaleString('ja-JP')}件を超えます。期間や取引先で絞ってください`, 413);
    lines.sort((a, b) => b.month.localeCompare(a.month) || b.id - a.id);
    const csv = toCsv(legacy.map((column) => column.label), lines.map((line) => line.cells));
    return new Response(`﻿${csv}`, {headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': attachment(`売上集計シート_${selectedColumns ? '選択列' : '83列'}_${stamp()}.csv`, selectedColumns ? 'sales-sheet-selected.csv' : 'sales-sheet-83.csv')}});
  });
  app.get('/api/sales-sheet/export.csv', exportCsv(false));
  app.get('/api/sales-sheet/export-selected.csv', exportCsv(true));

  // ---- API: 売上1件（全列の値と履歴） ----------------------------------------------------------------
  async function visibleSale(i, saleId) {
    const base = filterSql(i, {monthBasis: 'accounting'}, [{sql: 's.id=?', params: [saleId]}]);
    return db.get(`SELECT s.id,s.amount_ex_tax,s.tax_amount,s.amount_inc_tax,s.accounting_month ${base.sql}`, base.params);
  }
  app.get('/api/sales-sheet/sales/:id', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const saleId = intOf(c.req.param('id'), '売上ID');
    if (!await visibleSale(i, saleId)) return bad(c, '売上が無いか、財務の権限がありません', 404);
    const catalog = await loadCatalog(i.org_id);
    const index = catalogIndex(catalog);
    const keys = new Set(catalog.map((column) => column.column_key));
    const needs = needsOf(keys, index);
    for (const need of ['dist', 'detail', 'obs', 'billing', 'mg', 'source', 'currency', 'royalty', 'attrs', 'depth']) needs.add(need);
    const [ctx] = await loadContexts(i.org_id, [saleId], needs, await loadShared(i.org_id, needs));
    const values = rowValues(ctx, keys, index);
    const [attributes, currency, royalty] = await Promise.all([
      db.all(`SELECT a.column_key,a.version_no,a.value_text,a.value_number,a.origin,a.reason,a.created_at,u.display_name AS created_by_name FROM sale_attribute_values a
        LEFT JOIN users u ON u.id=a.created_by WHERE a.org_id=? AND a.sale_id=? ORDER BY a.column_key,a.version_no DESC`, [i.org_id, saleId]),
      db.all(`SELECT v.*,u.display_name AS created_by_name FROM sale_currency_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.org_id=? AND v.sale_id=? ORDER BY v.version_no DESC`, [i.org_id, saleId]),
      db.all(`SELECT v.*,u.display_name AS created_by_name FROM sale_royalty_basis_versions v LEFT JOIN users u ON u.id=v.created_by WHERE v.org_id=? AND v.sale_id=? ORDER BY v.version_no DESC`, [i.org_id, saleId]),
    ]);
    const versions = {};
    attributes.splice(0, attributes.length, ...attributes.map(attributeNumber));
    for (const row of attributes) if (!Object.hasOwn(versions, row.column_key)) versions[row.column_key] = row.version_no;
    return c.json({ok: true, saleId, canEdit: true, block: BLOCK_LABELS[salesBlock(ctx)] || null,
      sale: {id: saleId, work: ctx.work, partner: ctx.partner, product: ctx.product, reportKey: ctx.r.report_key, accountingMonth: ctx.s.accounting_month,
        amountExTax: ctx.s.amount_ex_tax, taxAmount: ctx.s.tax_amount, amountIncTax: ctx.s.amount_inc_tax, description: ctx.s.description},
      columns: catalog.map((column) => publicColumn(index.get(column.column_key))), values, attributeVersions: versions,
      history: {attributes, currency, royalty}, currencyVersion: currency[0]?.version_no ?? 0, royaltyVersion: royalty[0]?.version_no ?? 0});
  }));

  // ---- API: 値を直す（拡張属性・外貨・ロイヤリティ計上の基準） ------------------------------------------
  app.post('/api/sales-sheet/values', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const b = await body(c), reason = reasonOf(b.reason);
    const changes = Array.isArray(b.changes) ? b.changes : [];
    if (!changes.length || changes.length > MAX_VALUE_CHANGES) return bad(c, `直す値を1〜${MAX_VALUE_CHANGES}件送ってください`);
    const index = catalogIndex(await loadCatalog(i.org_id));
    const saleIds = [...new Set(changes.map((change) => intOf(change?.saleId, '売上ID')))];
    const visible = new Set();
    const vis = filterSql(i, {monthBasis: 'accounting'}, [{sql: `s.id IN (${IDS})`, params: [JSON.stringify(saleIds)]}]);
    for (const row of await db.all(`SELECT s.id ${vis.sql}`, vis.params)) visible.add(row.id);
    const current = new Map((await db.all(`SELECT a.sale_id,a.column_key,a.version_no,a.value_text,a.value_number FROM sale_attribute_values a WHERE a.org_id=? AND a.sale_id IN (${IDS})
      AND a.version_no=(SELECT MAX(x.version_no) FROM sale_attribute_values x WHERE x.org_id=a.org_id AND x.sale_id=a.sale_id AND x.column_key=a.column_key)`, [i.org_id, JSON.stringify(saleIds)]))
      .map((row) => [`${row.sale_id}|${row.column_key}`, attributeNumber(row)]));
    const rows = [], errors = [], seen = new Set();
    let unchanged = 0;
    changes.forEach((change, n) => {
      const saleId = Number(change.saleId), key = String(change.columnKey || '');
      const where = `${n + 1}件目（売上ID ${saleId}・${index.get(key)?.label || key}）`;
      if (!visible.has(saleId)) { errors.push(`${where}: 売上が無いか、財務の権限がありません`); return; }
      const column = index.get(key);
      if (!column || column.source_kind !== 'attribute') { errors.push(`${where}: 拡張属性の列ではありません（登録済みの表から作る列は、元の報告を訂正して直します）`); return; }
      if (!column.active) { errors.push(`${where}: 使うのをやめた列です`); return; }
      if (seen.has(`${saleId}|${key}`)) { errors.push(`${where}: 同じ売上・列が2回あります`); return; }
      seen.add(`${saleId}|${key}`);
      const now = current.get(`${saleId}|${key}`);
      const base = Number(change.baseVersion ?? 0);
      if ((now?.version_no ?? 0) !== base) { errors.push(`${where}: 別の人が先に直しました（いまは第${now?.version_no ?? 0}版）。読み直してください`); return; }
      const parsed = parseAttributeValue(column, change.value);
      if (parsed.error) { errors.push(`${where}: ${parsed.error}`); return; }
      if (sameAttribute(parsed.value, now ? {t: now.value_text, n: now.value_number} : {t: null, n: null})) { unchanged += 1; return; }
      rows.push({s: saleId, k: key, v: base + 1, t: parsed.value.t, n: parsed.value.n, before: now ? (now.value_text ?? now.value_number) : null});
    });
    if (errors.length) return bad(c, `${errors.length}件の値を登録できません。1件でも誤りがあれば登録しません`, errors.some((e) => /先に直しました/.test(e)) ? 409 : 400, errors);
    if (!rows.length) return c.json({ok: true, saved: 0, unchanged});
    // 登録は1つの値（json_each）と監査の1行。どちらもクラウドの D1 の1値の上限（約128KB）に収める（画面の取込と同じ reportByteLimit）
    const payload = JSON.stringify(rows.map(({before, ...row}) => row));
    const auditEntry = audit(i, 'update', 'sale_attribute_values', rows.length === 1 ? `${rows[0].s}:${rows[0].k}` : `${rows.length}件`, {reason, changes: rows.map((row) => ({saleId: row.s, columnKey: row.k, version: row.v, before: row.before, after: row.t ?? row.n}))});
    const limit = reportByteLimit(importLimits(mode));
    const size = Math.max(utf8Bytes(payload), utf8Bytes(auditEntry.params[5]));
    if (size > limit) return bad(c, `登録する値が大きすぎます（${rows.length}件・${kbText(size)}）。1回に登録できるのは${kbText(limit)}までです。件数を分けて登録してください`, 413, {count: rows.length, bytes: size, limit});
    await db.batch([
      {sql: `INSERT INTO sale_attribute_values(org_id,sale_id,column_key,version_no,value_text,value_number,origin,reason,created_by)
        SELECT ?,json_extract(j.value,'$.s'),json_extract(j.value,'$.k'),json_extract(j.value,'$.v'),json_extract(j.value,'$.t'),json_extract(j.value,'$.n'),'manual',?,? FROM json_each(?) j`,
      params: [i.org_id, reason, i.user_id, payload]},
      auditEntry,
    ]);
    return c.json({ok: true, saved: rows.length, unchanged}, 201);
  }));

  app.post('/api/sales-sheet/sales/:id/currency', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const saleId = intOf(c.req.param('id'), '売上ID');
    const sale = await visibleSale(i, saleId);
    if (!sale) return bad(c, '売上が無いか、財務の権限がありません', 404);
    const b = await body(c), reason = reasonOf(b.reason), base = intOf(b.baseVersion ?? 0, '元の版');
    const current = await db.get('SELECT MAX(version_no) AS v FROM sale_currency_versions WHERE org_id=? AND sale_id=?', [i.org_id, saleId]);
    if ((current?.v ?? 0) !== base) return bad(c, `外貨の記録が更新されています（いまは第${current?.v ?? 0}版）。読み直してください`, 409);
    const normalized = normalizeCurrencyInput(b, sale);
    if (normalized.error) throw Error(normalized.error);
    const v = normalized.value;
    await db.batch([
      {sql: `INSERT INTO sale_currency_versions(org_id,sale_id,version_no,currency_code,original_amount_x100,original_royalty_x100,exchange_rate_x10000,rate_date,basis,reason,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, params: [i.org_id, saleId, base + 1, v.currency_code, v.original_amount_x100, v.original_royalty_x100, v.exchange_rate_x10000, v.rate_date, v.basis, reason, i.user_id]},
      audit(i, 'version', 'sale_currency', saleId, {version: base + 1, after: v, reason}),
    ]);
    return c.json({ok: true, version: base + 1}, 201);
  }));

  app.post('/api/sales-sheet/sales/:id/royalty-basis', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const saleId = intOf(c.req.param('id'), '売上ID');
    if (!await visibleSale(i, saleId)) return bad(c, '売上が無いか、財務の権限がありません', 404);
    const b = await body(c), reason = reasonOf(b.reason), base = intOf(b.baseVersion ?? 0, '元の版');
    const current = await db.get('SELECT MAX(version_no) AS v FROM sale_royalty_basis_versions WHERE org_id=? AND sale_id=?', [i.org_id, saleId]);
    if ((current?.v ?? 0) !== base) return bad(c, `ロイヤリティ計上の基準が更新されています（いまは第${current?.v ?? 0}版）。読み直してください`, 409);
    const normalized = normalizeRoyaltyInput(b);
    if (normalized.error) throw Error(normalized.error);
    const v = normalized.value;
    await db.batch([
      {sql: `INSERT INTO sale_royalty_basis_versions(org_id,sale_id,version_no,royalty_month,royalty_amount_ex_tax,royalty_tax_amount,royalty_amount_inc_tax,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?)`,
        params: [i.org_id, saleId, base + 1, v.royalty_month, v.royalty_amount_ex_tax, v.royalty_tax_amount, v.royalty_amount_inc_tax, reason, i.user_id]},
      audit(i, 'version', 'sale_royalty_basis', saleId, {version: base + 1, after: v, reason}),
    ]);
    return c.json({ok: true, version: base + 1}, 201);
  }));

  // ---- API: シート定義（保存した形） ----------------------------------------------------------------
  async function loadViews(orgId) {
    const rows = await db.all(`SELECT v.id,v.name,v.created_by,u.display_name AS created_by_name,x.version_no,x.column_keys_json,x.grain,x.dimensions_json,x.month_basis,x.tax_basis,
        x.pivot_months,x.hide_empty,x.filters_json,x.active,x.reason,x.created_at,xu.display_name AS updated_by_name
      FROM sales_sheet_views v JOIN sales_sheet_view_versions x ON x.org_id=v.org_id AND x.view_id=v.id
        AND x.version_no=(SELECT MAX(y.version_no) FROM sales_sheet_view_versions y WHERE y.org_id=v.org_id AND y.view_id=v.id)
      LEFT JOIN users u ON u.id=v.created_by LEFT JOIN users xu ON xu.id=x.created_by WHERE v.org_id=? ORDER BY v.name`, [orgId]);
    return rows.map((row) => ({id: row.id, name: row.name, version: row.version_no, active: Number(row.active) === 1, createdBy: row.created_by, createdByName: row.created_by_name,
      updatedByName: row.updated_by_name, updatedAt: row.created_at, reason: row.reason,
      definition: {columns: JSON.parse(row.column_keys_json), grain: row.grain, dimensions: JSON.parse(row.dimensions_json), monthBasis: row.month_basis, taxBasis: row.tax_basis,
        pivot: Number(row.pivot_months) === 1, hideEmpty: Number(row.hide_empty) === 1, filters: JSON.parse(row.filters_json)}}));
  }
  const viewVersion = (i, viewIdSql, viewIdParams, versionNo, d, active, reason) => ({sql: `INSERT INTO sales_sheet_view_versions(org_id,view_id,version_no,column_keys_json,grain,dimensions_json,month_basis,tax_basis,
      pivot_months,hide_empty,filters_json,active,reason,created_by) VALUES(?,${viewIdSql},?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: [i.org_id, ...viewIdParams, versionNo, JSON.stringify(d.columns), d.grain, JSON.stringify(d.dimensions), d.monthBasis, d.taxBasis, d.pivot ? 1 : 0, d.hideEmpty ? 1 : 0,
    JSON.stringify(d.filters), active ? 1 : 0, reason, i.user_id]});
  app.get('/api/sales-sheet/views', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    return c.json({ok: true, views: (await loadViews(i.org_id)).map((view) => ({...view, canEdit: i.role === 'admin' || view.createdBy === i.user_id}))});
  }));
  app.post('/api/sales-sheet/views', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    if (!(await permittedProjects(db, i, true)).length) return bad(c, 'シートの形を保存するには、財務の権限がある案件が1つ以上要ります', 403);
    const b = await body(c), reason = reasonOf(b.reason);
    const name = text(b.name, 60, true);
    const normalized = normalizeViewDefinition(b.definition, catalogIndex(await loadCatalog(i.org_id)));
    if (normalized.error) throw Error(normalized.error);
    if (await db.get('SELECT 1 FROM sales_sheet_views WHERE org_id=? AND name=?', [i.org_id, name])) return bad(c, `「${name}」という名前の形があります。別の名前にするか、その形を上書きしてください`, 409);
    const id = Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM sales_sheet_views')).id);
    await db.batch([
      {sql: 'INSERT INTO sales_sheet_views(id,org_id,name,created_by) VALUES(?,?,?,?)', params: [id, i.org_id, name, i.user_id]},
      viewVersion(i, '?', [id], 1, normalized.value, true, reason),
      audit(i, 'create', 'sales_sheet_view', id, {name, version: 1, definition: normalized.value, reason}),
    ]);
    return c.json({ok: true, id, version: 1}, 201);
  }));
  app.post('/api/sales-sheet/views/:id/versions', wrap(async (c) => {
    const i = c.get('identity');
    const no = denied(c, i);
    if (no) return no;
    const viewId = intOf(c.req.param('id'), 'シートの形');
    const b = await body(c), reason = reasonOf(b.reason), base = intOf(b.baseVersion, '元の版');
    const view = (await loadViews(i.org_id)).find((item) => item.id === viewId);
    if (!view) return bad(c, 'シートの形がありません', 404);
    if (i.role !== 'admin' && view.createdBy !== i.user_id) return bad(c, 'シートの形を直せるのは、作った人と管理者です', 403);
    if (view.version !== base) return bad(c, `シートの形が更新されています（いまは第${view.version}版）。読み直してください`, 409);
    const normalized = normalizeViewDefinition(b.definition ?? view.definition, catalogIndex(await loadCatalog(i.org_id)));
    if (normalized.error) throw Error(normalized.error);
    const active = b.active === undefined ? view.active : Boolean(b.active);
    await db.batch([
      guard('?<>(SELECT COALESCE(MAX(version_no),0) FROM sales_sheet_view_versions WHERE org_id=? AND view_id=?)', [base, i.org_id, viewId]),
      viewVersion(i, '?', [viewId], base + 1, normalized.value, active, reason),
      audit(i, 'version', 'sales_sheet_view', viewId, {version: base + 1, before: view.definition, after: normalized.value, active, reason}),
    ]);
    return c.json({ok: true, version: base + 1}, 201);
  }));
}
