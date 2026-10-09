// 取引先別の配信・販売リスト（営業基幹）の API。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §3。
// - リスト（取引先×種類×名前）: 一覧・作成（理由必須・監査記録）
// - 明細: 一覧（状態は基準日から計算）・版の履歴・新しい明細・新しい版（理由必須・版の照合）
// - Excel: 共通テンプレート（入力・記入例・記入ガイド・_meta）の出力と取込（確認 → 理由を書いて登録。1回限り・30分）
// - 全取引先をまとめた出力（Excel・CSV）、作品×取引先の表（重なり）、確認（終了間近・再契約の空白・契約中の取引先が無い流通・期間外の売上）
// - 追加の列（定義と状態の版。管理者だけ）
// 見られるのは制作担当以外で、案件の閲覧権限がある作品の明細。直せるのは案件の編集権限がある作品の明細。期間外の売上は財務の権限（編集）がある作品の売上だけ。
// D1 の上限: 作品IDを値として並べない（組織で読んでから権限で絞る）。取込の登録は json_each で行数によらず一定の文の数。
import {isDbConflict, isGuardViolation, isUniqueViolation} from '../data-platform/db-errors.mjs';
import {integer, toCsv} from '../csv.mjs';
import {encodeReportXlsx} from '../xlsx-report.mjs';
import {importLimits, utf8Bytes, reportByteLimit, kbText} from '../import/limits.mjs';
import {splitByAllocation} from '../money-allocation.mjs';
import {
  TEMPLATE_VERSION, PREVIEW_MINUTES, SOON_DAYS, ENTRY_STATES, END_RULES, EXCLUSIVITY, ENTRY_STATUSES, SETTLEMENT_METHODS, FIELD_VALUE_TYPES, SALE_MATCH, OUT_OF_PERIOD, PERIOD_BASES,
  entryState, stateText, effectiveEnd, flowOf, flowText, overlapPairs, renewalGaps, endingSoon, uncoveredFlows, classifySale, partnerListSheets, entrySheetRow, fieldSetText,
  planPartnerListImport, normalizeEntryInput, changedParts, combinedColumns, combinedRow, reservedHeaders, headerKey, addMonthsYm, todayJst,
} from './partner-list-model.mjs';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const attachment = (name, ascii) => `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name).toWellFormed())}`;
const stamp = () => todayJst().replaceAll('-', '');
const nowIso = () => new Date().toISOString();
const SALES_LIMIT = 20000;
const KIND_FAMILY = {theatrical: 'theatrical', digital: 'digital', package: 'package', broadcast: 'broadcast', other: 'other'};

const text = (value, max, required = false) => {
  if (value !== null && value !== undefined && typeof value !== 'string') throw Error('文字を入力してください');
  const v = String(value ?? '').trim();
  if (v.length > max || (required && !v)) throw Error(required ? '必須の項目（理由・名前など）を入れてください' : `${max}文字までです`);
  return v || null;
};
const reasonOf = (value) => text(value, 1000, true);
const isoDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const ymOk = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function registerPartnerListRoutes(app, {db, bad, body, permittedProjects, mode = 'local'}) {
  const friendly = (error) => {
    if (isGuardViolation(error)) return '確かめた後に、別の人が同じ明細（または追加の列）を直しました。読み直してからもう一度登録してください';
    if (isUniqueViolation(error, 'partner_list_import_batches')) return '同じ内容のファイルは、このリストへ取り込み済みです';
    if (isUniqueViolation(error, 'partner_lists')) return 'この取引先には同じ種類・同じ名前のリストがあります';
    if (isUniqueViolation(error, 'partner_list_field_definitions')) return '同じキーの追加の列があります';
    return error.message;
  };
  const wrap = (fn) => async (c) => {
    try { return await fn(c); } catch (error) { return bad(c, friendly(error), isDbConflict(error) || /stale|immutable|mismatch/i.test(error.message) ? 409 : 400, undefined, error); }
  };
  const audit = (i, action, entity, id, detail) => ({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', params: [i.org_id, i.user_id, action, entity, String(id), JSON.stringify(detail)]});
  const guard = (sql, params) => ({sql: `INSERT INTO transaction_guards(value) SELECT 0 WHERE ${sql}`, params});
  const denied = (c) => bad(c, '営業基幹は担当範囲外です', 403);

  // 見られる作品（案件の閲覧権限）と直せる作品（案件の編集権限）。制作担当は null
  async function scope(i) {
    if (i.role === 'production') return null;
    const [view, edit] = await Promise.all([permittedProjects(db, i, false), permittedProjects(db, i, true)]);
    const viewIds = new Set(view.map((p) => p.id)), editIds = new Set(edit.map((p) => p.id));
    const works = (await db.all('SELECT id,code,title,project_id FROM works WHERE org_id=? ORDER BY code,id', [i.org_id])).filter((w) => viewIds.has(w.project_id));
    return {works, visible: new Set(works.map((w) => w.id)), editable: new Set(works.filter((w) => editIds.has(w.project_id)).map((w) => w.id))};
  }

  const asOfOf = (c) => { const v = c.req.query('asOf'); if (v && !isoDay(v)) throw Error('基準日は 2026-09-25 の形で指定してください'); return v || todayJst(); };
  const soonOf = (c) => { const n = Number(c.req.query('soonDays') || 30); return SOON_DAYS.includes(n) ? n : 30; };

  async function codeInfo() {
    const rows = await db.all(`SELECT t.code,t.family,t.utilization,t.label,m.distribution_name,m.transaction_method,m.sales_type
      FROM distribution_types t LEFT JOIN distribution_master m ON m.code=t.code ORDER BY t.sort_order,t.code`);
    return new Map(rows.map((row) => [row.code, row]));
  }

  async function loadLists(orgId) {
    return db.all(`SELECT l.id,l.partner_id,l.list_kind,l.name,l.service_name,l.contract_reference,l.reason,l.created_at,p.code AS partner_code,p.name AS partner_name,k.label AS kind_label,k.sort_order AS kind_order
      FROM partner_lists l JOIN partners p ON p.org_id=l.org_id AND p.id=l.partner_id JOIN partner_list_kinds k ON k.code=l.list_kind
      WHERE l.org_id=? ORDER BY p.code,k.sort_order,l.name,l.id`, [orgId]);
  }

  // 追加の列（定義＋最新の状態）
  async function loadFields(orgId) {
    const rows = await db.all(`SELECT d.id,d.field_key,d.value_type,d.list_kind,d.partner_id,p.code AS partner_code,p.name AS partner_name,
        s.version_no,s.label,s.active,s.sort_order,s.options_json,s.reason,s.created_at
      FROM partner_list_field_definitions d JOIN partner_list_field_states s ON s.org_id=d.org_id AND s.definition_id=d.id
        AND s.version_no=(SELECT MAX(x.version_no) FROM partner_list_field_states x WHERE x.org_id=d.org_id AND x.definition_id=d.id)
      LEFT JOIN partners p ON p.org_id=d.org_id AND p.id=d.partner_id
      WHERE d.org_id=? ORDER BY s.sort_order,d.id`, [orgId]);
    const kinds = new Map((await db.all('SELECT code,label FROM partner_list_kinds')).map((k) => [k.code, k.label]));
    return rows.map((row) => {
      let options = null;
      try { options = row.options_json ? JSON.parse(row.options_json) : null; } catch { options = null; }
      const scopeText = [row.list_kind ? kinds.get(row.list_kind) || row.list_kind : 'すべての種類', row.partner_id ? `${row.partner_name}だけ` : 'すべての取引先'].join('・');
      return {...row, active: Number(row.active) === 1, options, scope_text: scopeText};
    });
  }
  const applicableFields = (fields, list) => fields.filter((f) => f.active && (!f.list_kind || f.list_kind === list.list_kind) && (!f.partner_id || f.partner_id === list.partner_id));

  // 明細の最新の版（見られる作品だけ）。listId を渡すとそのリストだけ
  async function loadEntries(orgId, access, codes, {listId = null} = {}) {
    const listFilter = listId ? ' AND e.list_id=?' : '';
    const params = listId ? [orgId, listId] : [orgId];
    const [rows, values] = await Promise.all([
      db.all(`SELECT e.id AS entry_id,e.list_id,e.work_id,e.renews_entry_id,l.partner_id,l.list_kind,l.name AS list_name,l.service_name,k.label AS kind_label,
          p.code AS partner_code,p.name AS partner_name,
          v.id AS version_id,v.version_no,v.distribution_code,v.partner_category,v.territory,v.product_id,v.partner_work_code,v.contract_start,v.contract_end,v.end_rule,v.announce_on,
          v.exclusivity,v.status,v.settlement_method,v.amount_ex_tax,v.rate_bps,v.billing_partner_id,v.agreement_id,v.source_reference,v.note,v.reason,v.created_at,v.import_batch_id,
          u.display_name AS created_by_name,w.code AS work_code,w.title AS work_title,pr.sku AS product_sku,bp.code AS billing_partner_code,bp.name AS billing_partner_name,a.contract_code AS agreement_code
        FROM partner_list_entries e
        JOIN partner_lists l ON l.org_id=e.org_id AND l.id=e.list_id
        JOIN partner_list_kinds k ON k.code=l.list_kind
        JOIN partners p ON p.org_id=l.org_id AND p.id=l.partner_id
        JOIN partner_list_entry_versions v ON v.org_id=e.org_id AND v.entry_id=e.id AND v.version_no=(SELECT MAX(x.version_no) FROM partner_list_entry_versions x WHERE x.org_id=e.org_id AND x.entry_id=e.id)
        JOIN works w ON w.org_id=e.org_id AND w.id=e.work_id
        LEFT JOIN products pr ON pr.org_id=v.org_id AND pr.id=v.product_id
        LEFT JOIN partners bp ON bp.org_id=v.org_id AND bp.id=v.billing_partner_id
        LEFT JOIN sales_agreements a ON a.org_id=v.org_id AND a.id=v.agreement_id
        LEFT JOIN users u ON u.id=v.created_by
        WHERE e.org_id=?${listFilter} ORDER BY w.code,e.id`, params),
      db.all(`SELECT f.entry_version_id,f.definition_id,f.value_text,f.value_number FROM partner_list_field_values f
        JOIN partner_list_entry_versions v ON v.org_id=f.org_id AND v.id=f.entry_version_id
        WHERE f.org_id=?${listId ? ' AND v.list_id=?' : ''} AND v.version_no=(SELECT MAX(x.version_no) FROM partner_list_entry_versions x WHERE x.org_id=v.org_id AND x.entry_id=v.entry_id)`, params),
    ]);
    const byVersion = new Map();
    for (const value of values) {
      if (!byVersion.has(value.entry_version_id)) byVersion.set(value.entry_version_id, {});
      byVersion.get(value.entry_version_id)[value.definition_id] = {t: value.value_text ?? null, n: value.value_number ?? null};
    }
    return rows.filter((row) => access.visible.has(row.work_id)).map((row) => {
      const info = codes.get(row.distribution_code) || {};
      return {...row, fields: byVersion.get(row.version_id) || {}, distribution_name: info.distribution_name || info.label || row.distribution_code, sales_type: info.sales_type || null,
        master_method: info.transaction_method || null, flow: flowOf(info, row.territory), canEdit: access.editable.has(row.work_id)};
    });
  }

  async function loadAvailabilities(orgId, codes) {
    const rows = await db.all(`SELECT v.id,v.work_id,v.distribution_code,v.territory,v.version_no,v.release_on,v.sales_end_on,v.status FROM sales_availability_versions v
      WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM sales_availability_versions x WHERE x.org_id=v.org_id AND x.work_id=v.work_id AND x.distribution_code=v.distribution_code AND x.territory=v.territory)`, [orgId]);
    return rows.map((row) => ({...row, flow: flowOf(codes.get(row.distribution_code) || {}, row.territory)}));
  }

  async function loadList(orgId, listId) {
    return db.get(`SELECT l.*,p.code AS partner_code,p.name AS partner_name,k.label AS kind_label FROM partner_lists l
      JOIN partners p ON p.org_id=l.org_id AND p.id=l.partner_id JOIN partner_list_kinds k ON k.code=l.list_kind WHERE l.org_id=? AND l.id=?`, [orgId, listId]);
  }

  // 取込・1件の入力で使う照合表
  async function lookups(i, access, codes) {
    const [products, allocations, partners, agreements] = await Promise.all([
      db.all('SELECT id,sku FROM products WHERE org_id=?', [i.org_id]),
      db.all('SELECT product_id,work_id FROM product_works WHERE org_id=?', [i.org_id]),
      db.all('SELECT id,code FROM partners WHERE org_id=?', [i.org_id]),
      db.all('SELECT id,contract_code,work_id FROM sales_agreements WHERE org_id=?', [i.org_id]),
    ]);
    const worksOf = new Map();
    for (const a of allocations) { if (!worksOf.has(a.product_id)) worksOf.set(a.product_id, new Set()); worksOf.get(a.product_id).add(a.work_id); }
    const lower = (value) => String(value).normalize('NFKC').trim().toLowerCase();
    return {
      works: new Map(access.works.map((w) => [lower(w.code), w])),
      editable: access.editable,
      products: new Map(products.map((p) => [lower(p.sku), {id: p.id, works: worksOf.get(p.id) || new Set()}])),
      partners: new Map(partners.map((p) => [lower(p.code), p.id])),
      agreements: new Map(agreements.map((a) => [lower(a.contract_code), {id: a.id, work_id: a.work_id}])),
      codes: new Map([...codes].filter(([, info]) => info.distribution_name)),
      flowOfCode: (code, territory) => flowOf(codes.get(code) || {}, territory),
    };
  }

  const entryPublic = (entry, asOf, soonDays) => {
    const state = entryState(entry, asOf, soonDays);
    return {...entry, flow_text: flowText(entry.flow), state: state?.key || null, state_text: stateText(state), days_left: state?.daysLeft ?? null};
  };

  // ---- リスト --------------------------------------------------------------------------------
  app.get('/api/partner-lists', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const asOf = asOfOf(c), soonDays = soonOf(c);
    const codes = await codeInfo();
    const [lists, fields, kinds, partners, entries] = await Promise.all([
      loadLists(i.org_id), loadFields(i.org_id), db.all('SELECT code,label,sort_order FROM partner_list_kinds ORDER BY sort_order,code'),
      db.all('SELECT id,code,name,kind FROM partners WHERE org_id=? ORDER BY code,id', [i.org_id]), loadEntries(i.org_id, access, codes),
    ]);
    const counts = new Map();
    for (const entry of entries) {
      if (!counts.has(entry.list_id)) counts.set(entry.list_id, {entries: 0, byState: {}});
      const item = counts.get(entry.list_id);
      item.entries += 1;
      const key = entryState(entry, asOf, soonDays)?.key;
      item.byState[key] = (item.byState[key] || 0) + 1;
    }
    const listCount = new Map();
    for (const list of lists) listCount.set(list.partner_id, (listCount.get(list.partner_id) || 0) + 1);
    return c.json({ok: true, asOf, soonDays, kinds, fields, states: ENTRY_STATES,
      partners: partners.map((p) => ({...p, listCount: listCount.get(p.id) || 0})),
      lists: lists.map((list) => ({...list, entryCount: counts.get(list.id)?.entries || 0, byState: counts.get(list.id)?.byState || {}})),
      distributionCodes: [...codes.values()].filter((info) => info.distribution_name).map((info) => ({code: info.code, distribution_name: info.distribution_name, transaction_method: info.transaction_method, sales_type: info.sales_type})),
      options: {endRules: END_RULES, exclusivity: EXCLUSIVITY, statuses: ENTRY_STATUSES, settlementMethods: SETTLEMENT_METHODS, valueTypes: FIELD_VALUE_TYPES, periodBases: PERIOD_BASES, saleMatch: SALE_MATCH},
      canAdmin: i.role === 'admin', canCreate: true, worksVisible: access.works.length});
  }));

  app.post('/api/partner-lists', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    if (!access.editable.size) return bad(c, 'リストを作るには、案件の編集権限が1つ以上必要です', 403);
    const b = await body(c), reason = reasonOf(b.reason);
    const partnerId = integer(b.partnerId ?? '');
    const partner = await db.get('SELECT id,code,name FROM partners WHERE org_id=? AND id=?', [i.org_id, partnerId]);
    if (!partner) return bad(c, '取引先がありません', 404);
    const kind = await db.get('SELECT code,label FROM partner_list_kinds WHERE code=?', [String(b.listKind || '')]);
    if (!kind) throw Error('リストの種類を選んでください');
    const name = text(b.name, 200, true), serviceName = text(b.serviceName ?? null, 200), contractReference = text(b.contractReference ?? null, 1000);
    if (await db.get('SELECT 1 FROM partner_lists WHERE org_id=? AND partner_id=? AND list_kind=? AND name=?', [i.org_id, partnerId, kind.code, name])) return bad(c, `${partner.name}には同じ名前の${kind.label}があります`, 409);
    await db.batch([
      {sql: 'INSERT INTO partner_lists(org_id,partner_id,list_kind,name,service_name,contract_reference,reason,created_by) VALUES(?,?,?,?,?,?,?,?)', params: [i.org_id, partnerId, kind.code, name, serviceName, contractReference, reason, i.user_id]},
      audit(i, 'create', 'partner_list', `${partner.code}:${kind.code}:${name}`, {partnerId, listKind: kind.code, name, serviceName, contractReference, reason}),
    ]);
    const created = await db.get('SELECT id FROM partner_lists WHERE org_id=? AND partner_id=? AND list_kind=? AND name=?', [i.org_id, partnerId, kind.code, name]);
    return c.json({ok: true, id: created.id}, 201);
  }));

  // ---- 明細 ----------------------------------------------------------------------------------
  app.get('/api/partner-lists/:listId/entries', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const listId = integer(c.req.param('listId'));
    const list = await loadList(i.org_id, listId);
    if (!list) return bad(c, 'リストがありません', 404);
    const asOf = asOfOf(c), soonDays = soonOf(c);
    const codes = await codeInfo();
    const [all, fields] = await Promise.all([loadEntries(i.org_id, access, codes), loadFields(i.org_id)]);
    const pairs = overlapPairs(all);
    const byId = new Map(all.map((entry) => [entry.entry_id, entry]));
    const overlapsOf = (id) => pairs.filter((p) => p.a === id || p.b === id).map((p) => {
      const other = byId.get(p.a === id ? p.b : p.a);
      return {entry_id: other.entry_id, partner_name: other.partner_name, list_name: other.list_name, severity: p.severity, from: p.from, to: p.to};
    });
    const renewedBy = new Map(all.filter((e) => e.renews_entry_id).map((e) => [e.renews_entry_id, e.entry_id]));
    const entries = all.filter((entry) => entry.list_id === listId).map((entry) => ({...entryPublic(entry, asOf, soonDays), overlaps: overlapsOf(entry.entry_id), renewed_by: renewedBy.get(entry.entry_id) || null}));
    const byState = {};
    for (const entry of entries) byState[entry.state] = (byState[entry.state] || 0) + 1;
    const applicable = applicableFields(fields, list);
    return c.json({ok: true, asOf, soonDays, list, fields: applicable, entries, counts: {entries: entries.length, byState, overlaps: entries.filter((e) => e.overlaps.length).length},
      canEdit: access.editable.size > 0, works: access.works.filter((w) => access.editable.has(w.id)).map((w) => ({id: w.id, code: w.code, title: w.title}))});
  }));

  app.get('/api/partner-list-entries/:entryId/history', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const entryId = integer(c.req.param('entryId'));
    const entry = await db.get('SELECT e.*,w.code AS work_code,w.title AS work_title FROM partner_list_entries e JOIN works w ON w.org_id=e.org_id AND w.id=e.work_id WHERE e.org_id=? AND e.id=?', [i.org_id, entryId]);
    if (!entry || !access.visible.has(entry.work_id)) return bad(c, '明細がないか、作品への権限がありません', 404);
    const [versions, values, list, fields, renewedBy] = await Promise.all([
      db.all(`SELECT v.*,u.display_name AS created_by_name,pr.sku AS product_sku,bp.code AS billing_partner_code,a.contract_code AS agreement_code,b.file_name AS batch_file_name
        FROM partner_list_entry_versions v LEFT JOIN users u ON u.id=v.created_by LEFT JOIN products pr ON pr.org_id=v.org_id AND pr.id=v.product_id
        LEFT JOIN partners bp ON bp.org_id=v.org_id AND bp.id=v.billing_partner_id LEFT JOIN sales_agreements a ON a.org_id=v.org_id AND a.id=v.agreement_id
        LEFT JOIN partner_list_import_batches b ON b.org_id=v.org_id AND b.id=v.import_batch_id
        WHERE v.org_id=? AND v.entry_id=? ORDER BY v.version_no DESC`, [i.org_id, entryId]),
      db.all('SELECT f.entry_version_id,f.definition_id,f.value_text,f.value_number FROM partner_list_field_values f JOIN partner_list_entry_versions v ON v.org_id=f.org_id AND v.id=f.entry_version_id WHERE f.org_id=? AND v.entry_id=?', [i.org_id, entryId]),
      loadList(i.org_id, entry.list_id), loadFields(i.org_id),
      db.all('SELECT id FROM partner_list_entries WHERE org_id=? AND renews_entry_id=? ORDER BY id', [i.org_id, entryId]),
    ]);
    const fieldsOf = (versionId) => Object.fromEntries(values.filter((f) => f.entry_version_id === versionId).map((f) => [f.definition_id, {t: f.value_text ?? null, n: f.value_number ?? null}]));
    return c.json({ok: true, entry: {id: entry.id, list_id: entry.list_id, work_id: entry.work_id, work_code: entry.work_code, work_title: entry.work_title, renews_entry_id: entry.renews_entry_id,
      renewed_by: renewedBy.map((r) => r.id)}, list, canEdit: access.editable.has(entry.work_id), fields: fields.filter((f) => (!f.list_kind || f.list_kind === list.list_kind) && (!f.partner_id || f.partner_id === list.partner_id)),
      versions: versions.map((v) => ({...v, fields: fieldsOf(v.id)}))});
  }));

  // 1件の入力（画面）。input のキーは Excel と同じ（流通ID・日付・選択肢のコードまたは日本語・商品SKU・取引先コード・販売契約コード・料率（%））
  async function entryStatements(i, list, {workId, current, input, reason, renewsEntryId = null}) {
    const access = await scope(i);
    if (!access) return {status: 403, error: '営業基幹は担当範囲外です'};
    if (!access.editable.has(workId)) return {status: 403, error: '作品の編集権限がありません'};
    const codes = await codeInfo();
    const [ctx, fields] = await Promise.all([lookups(i, access, codes), loadFields(i.org_id)]);
    const applicable = applicableFields(fields, list);
    const raw = {...(input || {})};
    for (const [id, value] of Object.entries(input?.fields || {})) raw[`f:${id}`] = value;
    delete raw.fields;
    // 入力に無い追加の列は今の版の値を写す（present に入れない）
    const present = new Set(Object.keys(raw));
    const normalized = normalizeEntryInput(raw, current, {...ctx, present, workId, fields: applicable});
    if (normalized.errors.length) return {status: 400, error: normalized.errors.join(' ／ ')};
    return {value: normalized.value, applicable};
  }

  const versionInsert = (i, list, {entryRef, entryParams, workId, versionNo, value, reason}) => {
    const out = [{sql: `INSERT INTO partner_list_entry_versions(org_id,list_id,entry_id,work_id,version_no,distribution_code,partner_category,territory,product_id,partner_work_code,
        contract_start,contract_end,end_rule,announce_on,exclusivity,status,settlement_method,amount_ex_tax,rate_bps,billing_partner_id,agreement_id,source_reference,note,reason,created_by)
      VALUES(?,?,${entryRef},?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [i.org_id, list.id, ...entryParams, workId, versionNo, value.distribution_code, value.partner_category, value.territory,
      value.product_id, value.partner_work_code, value.contract_start, value.contract_end, value.end_rule, value.announce_on, value.exclusivity, value.status, value.settlement_method,
      value.amount_ex_tax, value.rate_bps, value.billing_partner_id, value.agreement_id, value.source_reference, value.note, reason, i.user_id]}];
    for (const [definitionId, field] of Object.entries(value.fields || {})) {
      out.push({sql: `INSERT INTO partner_list_field_values(org_id,entry_version_id,definition_id,value_text,value_number)
        VALUES(?,(SELECT id FROM partner_list_entry_versions WHERE org_id=? AND entry_id=${entryRef} AND version_no=?),?,?,?)`,
      params: [i.org_id, i.org_id, ...entryParams, versionNo, Number(definitionId), field.t ?? null, field.n ?? null]});
    }
    return out;
  };

  app.post('/api/partner-lists/:listId/entries', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return denied(c);
    const listId = integer(c.req.param('listId'));
    const list = await loadList(i.org_id, listId);
    if (!list) return bad(c, 'リストがありません', 404);
    const b = await body(c), reason = reasonOf(b.reason), workId = integer(b.workId ?? '');
    let renewsEntryId = null;
    if (b.renewsEntryId !== null && b.renewsEntryId !== undefined && b.renewsEntryId !== '') {
      renewsEntryId = integer(b.renewsEntryId);
      if (!await db.get('SELECT 1 FROM partner_list_entries WHERE org_id=? AND id=? AND list_id=? AND work_id=?', [i.org_id, renewsEntryId, listId, workId])) throw Error('再契約元の明細は、同じリスト・同じ作品の明細を選んでください');
    }
    const built = await entryStatements(i, list, {workId, current: null, input: b.values || {}, reason});
    if (built.error) return bad(c, built.error, built.status);
    const entryRef = '(SELECT MAX(id) FROM partner_list_entries WHERE org_id=? AND list_id=? AND work_id=?)';
    const entryParams = [i.org_id, listId, workId];
    await db.batch([
      {sql: 'INSERT INTO partner_list_entries(org_id,list_id,work_id,renews_entry_id,created_by) VALUES(?,?,?,?,?)', params: [i.org_id, listId, workId, renewsEntryId, i.user_id]},
      ...versionInsert(i, list, {entryRef, entryParams, workId, versionNo: 1, value: built.value, reason}),
      audit(i, 'create', 'partner_list_entry', `${listId}:${workId}`, {version: 1, renewsEntryId, after: built.value, reason}),
    ]);
    const created = await db.get('SELECT MAX(id) AS id FROM partner_list_entries WHERE org_id=? AND list_id=? AND work_id=?', [i.org_id, listId, workId]);
    return c.json({ok: true, entryId: created.id, version: 1}, 201);
  }));

  app.post('/api/partner-list-entries/:entryId/versions', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return denied(c);
    const entryId = integer(c.req.param('entryId'));
    const entry = await db.get('SELECT id,list_id,work_id FROM partner_list_entries WHERE org_id=? AND id=?', [i.org_id, entryId]);
    if (!entry) return bad(c, '明細がありません', 404);
    const list = await loadList(i.org_id, entry.list_id);
    const b = await body(c), reason = reasonOf(b.reason), base = integer(b.baseVersion ?? '');
    const access = await scope(i);
    const codes = await codeInfo();
    const current = (await loadEntries(i.org_id, access, codes, {listId: entry.list_id})).find((e) => e.entry_id === entryId);
    if (!current) return bad(c, '作品への権限がありません', 403);
    if (current.version_no !== base) return bad(c, `この明細は更新されています（いまは第${current.version_no}版）。読み直してから直してください`, 409);
    const built = await entryStatements(i, list, {workId: entry.work_id, current, input: b.values || {}, reason});
    if (built.error) return bad(c, built.error, built.status);
    if (!changedParts(current, built.value).length) return bad(c, '今の版と同じ内容です（変更がありません）', 400);
    await db.batch([
      guard('?<>(SELECT COALESCE(MAX(version_no),0) FROM partner_list_entry_versions WHERE org_id=? AND entry_id=?)', [base, i.org_id, entryId]),
      ...versionInsert(i, list, {entryRef: '?', entryParams: [entryId], workId: entry.work_id, versionNo: base + 1, value: built.value, reason}),
      audit(i, 'version', 'partner_list_entry', entryId, {version: base + 1, parts: changedParts(current, built.value), reason}),
    ]);
    return c.json({ok: true, version: base + 1}, 201);
  }));

  // ---- Excel（共通テンプレート） ----------------------------------------------------------------
  app.get('/api/partner-lists/:listId/template.xlsx', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const listId = integer(c.req.param('listId'));
    const list = await loadList(i.org_id, listId);
    if (!list) return bad(c, 'リストがありません', 404);
    const kind = c.req.query('kind') === 'current' ? 'current' : 'template';
    const asOf = asOfOf(c), soonDays = soonOf(c);
    const codes = await codeInfo();
    const fields = applicableFields(await loadFields(i.org_id), list);
    const entries = kind === 'current' ? (await loadEntries(i.org_id, access, codes, {listId})) : [];
    const rows = entries.map((entry) => entrySheetRow(entry, fields, {asOf, soonDays}));
    const sheets = partnerListSheets({list, fields, rows, kind, generatedAt: nowIso(), fieldSetHash: fieldSetText(fields), asOf,
      distributionCodes: [...codes.values()].filter((info) => info.distribution_name).map((info) => info.code)});
    const name = `${list.partner_name}_${list.name}_${kind === 'current' ? '明細' : 'テンプレート'}_${stamp()}.xlsx`;
    return new Response(encodeReportXlsx({sheets}), {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(name, `partner-list-${listId}-${kind}.xlsx`)}});
  }));

  app.post('/api/partner-lists/:listId/import/preview', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const listId = integer(c.req.param('listId'));
    const list = await loadList(i.org_id, listId);
    if (!list) return bad(c, 'リストがありません', 404);
    const b = await body(c);
    const table = b?.table;
    if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) throw Error('読み込んだ表がありません');
    const importMode = b.mode === 'full' ? 'full' : 'partial';
    const meta = table.meta || b.meta || null;
    const codes = await codeInfo();
    const allFields = await loadFields(i.org_id);
    const fields = applicableFields(allFields, list);
    const fileWarnings = [];
    if (meta && meta.template) {
      if (meta.template !== TEMPLATE_VERSION) return bad(c, `このファイルは別の形式のテンプレート（${meta.template}）です。この画面の「テンプレート」から出し直してください`, 400);
      if (meta.list_id && Number(meta.list_id) !== listId) {
        const other = await loadList(i.org_id, Number(meta.list_id));
        return bad(c, `このファイルは「${other ? `${other.partner_name} ${other.name}` : `${meta.partner_code || ''} ${meta.list_name || ''}`.trim()}」のリストのものです。そのリストの画面で読み込んでください`, 400);
      }
      if (meta.field_set !== undefined && meta.field_set !== fieldSetText(fields)) fileWarnings.push('テンプレートを出した後に追加の列が変わりました（見出しで照合して読みます）');
    } else fileWarnings.push('テンプレートの _meta シートが無いファイルです（見出しで照合して読みます）');
    const contentHash = await sha256Hex(JSON.stringify({headers: table.headers, rows: table.rows.map((row) => (Array.isArray(row) ? row : row?.cells || []))}));
    const done = await db.get('SELECT created_at FROM partner_list_import_batches WHERE org_id=? AND list_id=? AND content_hash=?', [i.org_id, listId, contentHash]);
    if (done) return bad(c, `同じ内容のファイルは ${done.created_at} にこのリストへ取り込み済みです`, 409);
    const [ctx, entries, availabilities] = await Promise.all([lookups(i, access, codes), loadEntries(i.org_id, access, codes, {listId}), loadAvailabilities(i.org_id, codes)]);
    const availabilityMap = new Map();
    for (const a of availabilities) { if (!availabilityMap.has(a.work_id)) availabilityMap.set(a.work_id, []); availabilityMap.get(a.work_id).push(a); }
    const plan = planPartnerListImport({headers: table.headers, rows: table.rows}, {...ctx, list, entries: new Map(entries.map((e) => [e.entry_id, e])), fields, allFields, availabilities: availabilityMap}, {mode: importMode});
    const warnings = [...fileWarnings, ...plan.fileWarnings];
    const rows = plan.rows.map(({cells, ...row}) => row);
    if (plan.counts.errors) {
      return c.json({ok: false, error: `${plan.counts.errors}行にエラーがあります（全${plan.counts.rows}行）。1行でもエラーがあると、どの行も登録しません。表の理由を見て直し、もう一度読み込んでください`,
        counts: plan.counts, rows, warnings, headers: table.headers, failedRows: plan.rows.filter((row) => row.errors.length).map((row) => ({rowNo: row.rowNo, cells: row.cells, errors: row.errors}))}, 400);
    }
    if (!plan.changes.length) return c.json({ok: true, token: null, counts: plan.counts, rows, withdraw: plan.withdraw, warnings, mode: importMode});
    const payload = JSON.stringify(plan.changes);
    const limit = reportByteLimit(importLimits(mode));
    if (utf8Bytes(payload) > limit) return bad(c, `変更が多すぎます（${plan.changes.length}件の明細・${kbText(utf8Bytes(payload))}）。1回の取込は${kbText(limit)}までです。ファイルを分けて読み込んでください`, 413);
    const token = crypto.randomUUID(), expires = new Date(Date.now() + PREVIEW_MINUTES * 60_000).toISOString();
    const fileName = text(b.fileName ?? null, 200);
    await db.run('INSERT INTO partner_list_import_previews(token,org_id,user_id,list_id,file_name,content_hash,template_version,mode,payload_json,unchanged,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      [token, i.org_id, i.user_id, listId, fileName, contentHash, TEMPLATE_VERSION, importMode, payload, plan.counts.unchanged, expires]);
    return c.json({ok: true, token, expiresAt: expires, counts: plan.counts, rows, withdraw: plan.withdraw, warnings, mode: importMode, fileName, payloadBytes: utf8Bytes(payload)});
  }));

  app.post('/api/partner-lists/:listId/import/commit', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const listId = integer(c.req.param('listId'));
    const b = await body(c);
    const reason = reasonOf(b.reason);
    if (b.confirmed !== true) return bad(c, '差分を確かめてから登録してください', 400);
    const preview = await db.get('SELECT * FROM partner_list_import_previews WHERE token=? AND org_id=? AND user_id=? AND list_id=? AND consumed=0 AND expires_at>?', [String(b.token || ''), i.org_id, i.user_id, listId, nowIso()]);
    if (!preview) return bad(c, '取込の確認がないか期限切れです。もう一度読み込んでください', 410);
    const changes = JSON.parse(preview.payload_json);
    if (changes.some((change) => !access.editable.has(change.w))) return bad(c, '作品の編集権限がありません', 403);
    const withdrawMissing = b.withdrawMissing === true ? 1 : 0;
    const counted = (op) => changes.filter((change) => change.o === op).length;
    const tally = {appended: counted('a'), revised: counted('r'), withdrawn: withdrawMissing ? counted('w') : 0};
    const from = 'FROM partner_list_import_previews p JOIN json_each(p.payload_json) j ON 1=1 JOIN partner_list_import_batches b ON b.org_id=p.org_id AND b.list_id=p.list_id AND b.content_hash=p.content_hash';
    const opFilter = "(json_extract(j.value,'$.o')<>'w' OR ?=1)";
    const entryExpr = "CASE WHEN json_extract(j.value,'$.o')='a' THEN (SELECT e.id FROM partner_list_entries e WHERE e.org_id=p.org_id AND e.created_batch_id=b.id AND e.created_source_row=CAST(json_extract(j.value,'$.row') AS INTEGER)) ELSE CAST(json_extract(j.value,'$.e') AS INTEGER) END";
    const x = (key) => `json_extract(j.value,'$.${key}')`;
    // 数の列と比べる・足す値（PostgreSQL の json_extract は text を返す。dialect.md）
    const n = (key) => `CAST(${x(key)} AS INTEGER)`;
    const statements = [
      guard('NOT EXISTS(SELECT 1 FROM partner_list_import_previews WHERE token=? AND consumed=0 AND expires_at>?)', [preview.token, nowIso()]),
      // 確認の後に別の人が直した明細があれば止める（1つの文で全明細を照合する）
      {sql: `INSERT INTO transaction_guards(value) SELECT 0 FROM partner_list_import_previews p JOIN json_each(p.payload_json) j ON 1=1 WHERE p.token=? AND ${x('o')}<>'a' AND ${opFilter}
        AND ${n('b')}<>COALESCE((SELECT MAX(v.version_no) FROM partner_list_entry_versions v WHERE v.org_id=p.org_id AND v.entry_id=${n('e')}),0) LIMIT 1`, params: [preview.token, withdrawMissing]},
      {sql: `INSERT INTO partner_list_import_batches(org_id,list_id,file_name,content_hash,template_version,mode,appended,revised,withdrawn,unchanged,reason,created_by)
        SELECT org_id,list_id,file_name,content_hash,template_version,mode,?,?,?,unchanged,?,? FROM partner_list_import_previews WHERE token=?`,
      params: [tally.appended, tally.revised, tally.withdrawn, reason, i.user_id, preview.token]},
      {sql: `INSERT INTO partner_list_entries(org_id,list_id,work_id,renews_entry_id,created_batch_id,created_source_row,created_by)
        SELECT p.org_id,p.list_id,${x('w')},${x('rn')},b.id,${x('row')},? ${from} WHERE p.token=? AND ${x('o')}='a'`, params: [i.user_id, preview.token]},
      {sql: `INSERT INTO partner_list_entry_versions(org_id,list_id,entry_id,work_id,version_no,distribution_code,partner_category,territory,product_id,partner_work_code,
          contract_start,contract_end,end_rule,announce_on,exclusivity,status,settlement_method,amount_ex_tax,rate_bps,billing_partner_id,agreement_id,source_reference,note,
          import_batch_id,source_row,reason,created_by)
        SELECT p.org_id,p.list_id,${entryExpr},${x('w')},${n('b')}+1,${x('d')},${x('pc')},${x('t')},${x('p')},${x('pw')},${x('s')},${x('en')},${x('er')},${x('an')},${x('x')},${x('st')},${x('m')},
          ${x('a')},${x('rb')},${x('bp')},${x('ag')},${x('sr')},${x('nt')},b.id,${x('row')},?,? ${from} WHERE p.token=? AND ${opFilter}`,
      params: [reason, i.user_id, preview.token, withdrawMissing]},
      {sql: `INSERT INTO partner_list_field_values(org_id,entry_version_id,definition_id,value_text,value_number)
        SELECT p.org_id,v.id,json_extract(f.value,'$.d'),json_extract(f.value,'$.t'),json_extract(f.value,'$.n') ${from} JOIN json_each(j.value,'$.f') f ON 1=1
        JOIN partner_list_entry_versions v ON v.org_id=p.org_id AND v.import_batch_id=b.id AND v.entry_id=${entryExpr} WHERE p.token=? AND ${opFilter}`,
      params: [preview.token, withdrawMissing]},
      {sql: 'UPDATE partner_list_import_previews SET consumed=1 WHERE token=?', params: [preview.token]},
      audit(i, 'import', 'partner_list', listId, {...tally, mode: preview.mode, fileName: preview.file_name, token: preview.token, reason}),
    ];
    await db.batch(statements);
    return c.json({ok: true, ...tally, statements: statements.length}, 201);
  }));

  // ---- 全取引先をまとめた出力 ------------------------------------------------------------------------
  app.get('/api/partner-lists/export', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const asOf = asOfOf(c), soonDays = soonOf(c);
    const kind = c.req.query('kind') || null;
    const codes = await codeInfo();
    const [entries, fields] = await Promise.all([loadEntries(i.org_id, access, codes), loadFields(i.org_id)]);
    const rows = entries.filter((entry) => !kind || entry.list_kind === kind)
      .sort((a, b) => (a.partner_code < b.partner_code ? -1 : a.partner_code > b.partner_code ? 1 : a.list_name < b.list_name ? -1 : a.list_name > b.list_name ? 1 : a.entry_id - b.entry_id))
      .map((entry) => combinedRow(entry, fields, {asOf, soonDays}));
    const columns = combinedColumns(fields);
    if (c.req.query('format') === 'csv') {
      const csv = toCsv(columns.map((column) => column.label), rows.map((row) => columns.map((column) => row[column.key] ?? '')));
      return new Response(`﻿${csv}`, {headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': attachment(`取引先別リスト_全取引先_${stamp()}.csv`, 'partner-lists-all.csv')}});
    }
    const sheets = [
      {name: '全取引先', title: '取引先別の配信・販売リスト（全取引先・最新の版・1明細1行）', conditions: [['基準日', asOf], ['種類', kind || 'すべて'], ['件数', `${rows.length}件`]], dataAsOf: nowIso(), freezeCols: 2, columns, rows},
      {name: '_meta', hidden: true, titleBand: false, freezeCols: 0, columns: [{key: 'k', label: 'key', type: 'text'}, {key: 'v', label: 'value', type: 'text'}],
        rows: [{k: 'kind', v: 'partner-lists-combined'}, {k: 'as_of', v: asOf}, {k: 'rows', v: String(rows.length)}, {k: 'generated_at', v: nowIso()}]},
    ];
    return new Response(encodeReportXlsx({sheets}), {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(`取引先別リスト_全取引先_${stamp()}.xlsx`, 'partner-lists-all.xlsx')}});
  }));

  // ---- 作品×取引先の表 -------------------------------------------------------------------------------
  app.get('/api/partner-lists/matrix', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const asOf = asOfOf(c), soonDays = soonOf(c);
    const kind = c.req.query('kind') || null;
    const q = String(c.req.query('q') || '').normalize('NFKC').trim().toLowerCase();
    const onlyOverlaps = c.req.query('overlaps') === '1';
    const codes = await codeInfo();
    const all = await loadEntries(i.org_id, access, codes);
    const live = all.filter((entry) => entry.status !== 'withdrawn');
    const pairs = overlapPairs(live);
    const severity = new Map();
    for (const pair of pairs) for (const id of [pair.a, pair.b]) if (severity.get(id) !== 'exclusive') severity.set(id, pair.severity);
    const shown = live.filter((entry) => (!kind || entry.list_kind === kind) && (!q || `${entry.work_code} ${entry.work_title}`.normalize('NFKC').toLowerCase().includes(q)));
    const columnMap = new Map();
    for (const entry of shown) {
      const key = `${entry.partner_id}|${entry.distribution_code}`;
      if (!columnMap.has(key)) columnMap.set(key, {key, partner_id: entry.partner_id, partner_code: entry.partner_code, partner_name: entry.partner_name, distribution_code: entry.distribution_code,
        label: `${entry.distribution_code} ${entry.sales_type || entry.distribution_name}`});
    }
    const columns = [...columnMap.values()].sort((a, b) => (a.partner_code < b.partner_code ? -1 : a.partner_code > b.partner_code ? 1 : a.distribution_code < b.distribution_code ? -1 : 1));
    const rowsMap = new Map();
    for (const entry of shown) {
      if (!rowsMap.has(entry.work_id)) rowsMap.set(entry.work_id, {work_id: entry.work_id, work_code: entry.work_code, work_title: entry.work_title, cells: {}, overlap: null});
      const row = rowsMap.get(entry.work_id);
      const key = `${entry.partner_id}|${entry.distribution_code}`;
      if (!row.cells[key]) row.cells[key] = [];
      const state = entryState(entry, asOf, soonDays);
      const mark = severity.get(entry.entry_id) || null;
      row.cells[key].push({entry_id: entry.entry_id, list_name: entry.list_name, contract_start: entry.contract_start, contract_end: effectiveEnd(entry), end_rule: entry.end_rule,
        exclusivity: entry.exclusivity, status: entry.status, state: state?.key, state_text: stateText(state), overlap: mark});
      if (mark === 'exclusive' || (mark && !row.overlap)) row.overlap = mark;
    }
    let rows = [...rowsMap.values()].sort((a, b) => (a.work_code < b.work_code ? -1 : 1));
    if (onlyOverlaps) rows = rows.filter((row) => row.overlap);
    const byId = new Map(all.map((entry) => [entry.entry_id, entry]));
    const describe = (id) => { const e = byId.get(id); return {entry_id: id, partner_name: e.partner_name, list_name: e.list_name, distribution_code: e.distribution_code, contract_start: e.contract_start, contract_end: effectiveEnd(e), exclusivity: e.exclusivity}; };
    const shownWorks = new Set(rows.map((row) => row.work_id));
    const pairRows = pairs.filter((pair) => shownWorks.has(pair.work_id)).map((pair) => ({...pair, work_code: byId.get(pair.a).work_code, work_title: byId.get(pair.a).work_title, left: describe(pair.a), right: describe(pair.b)}));
    return c.json({ok: true, asOf, columns, rows, pairs: pairRows, counts: {works: rows.length, entries: shown.length, exclusive: pairRows.filter((p) => p.severity === 'exclusive').length, caution: pairRows.filter((p) => p.severity === 'caution').length},
      worksWithout: access.works.length - new Set(live.map((e) => e.work_id)).size});
  }));

  // ---- 確認 ----------------------------------------------------------------------------------------
  app.get('/api/partner-lists/checks', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return denied(c);
    const asOf = asOfOf(c);
    const basis = Object.hasOwn(PERIOD_BASES, c.req.query('basis') || '') ? c.req.query('basis') : 'month';
    const to = c.req.query('to') || asOf.slice(0, 7), from = c.req.query('from') || addMonthsYm(to, -23);
    if (!ymOk(from) || !ymOk(to) || from > to) throw Error('売上の期間は 2025-04 の形で、から ≦ まで にしてください');
    const statusFilter = c.req.query('status') || null;
    const codes = await codeInfo();
    const [entries, availabilities] = await Promise.all([loadEntries(i.org_id, access, codes), loadAvailabilities(i.org_id, codes)]);
    const byId = new Map(entries.map((entry) => [entry.entry_id, entry]));
    const brief = (entry) => ({entry_id: entry.entry_id, partner_name: entry.partner_name, partner_code: entry.partner_code, list_name: entry.list_name, work_id: entry.work_id, work_code: entry.work_code, work_title: entry.work_title,
      distribution_code: entry.distribution_code, distribution_name: entry.distribution_name, territory: entry.territory, contract_start: entry.contract_start, contract_end: entry.contract_end,
      end_rule: entry.end_rule, exclusivity: entry.exclusivity, status: entry.status});
    const soon = endingSoon(entries, asOf, 90).map((item) => ({...brief(byId.get(item.entry_id)), daysLeft: item.daysLeft, bucket: item.bucket, renewed: item.renewed}));
    const gaps = renewalGaps(entries).map((gap) => ({...gap, prevEntry: brief(byId.get(gap.prev)), nextEntry: brief(byId.get(gap.next))}));
    const workOf = new Map(access.works.map((w) => [w.id, w]));
    const uncovered = uncoveredFlows(availabilities.filter((a) => access.visible.has(a.work_id)), entries, asOf).map((item) => {
      const info = codes.get(item.distribution_code) || {};
      return {...item, work_code: workOf.get(item.work_id)?.code, work_title: workOf.get(item.work_id)?.title, distribution_name: info.distribution_name || info.label || item.distribution_code, flow_text: flowText(flowOf(info, item.territory))};
    });
    // 期間外の売上（財務の権限がある作品の売上だけ）
    let sales = null;
    const financeProjects = new Set((await permittedProjects(db, i, true)).map((p) => p.id));
    const finance = new Set(access.works.filter((w) => financeProjects.has(w.project_id)).map((w) => w.id));
    if (finance.size) {
      const saleRows = await db.all(`SELECT s.id,s.work_id,s.product_id,s.partner_id,s.sales_period_from,s.sales_period_to,s.accounting_month,s.amount_ex_tax,s.description,
          r.kind,r.report_key,d.distribution_code,d.territory,p.code AS partner_code,p.name AS partner_name
        FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
        JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
        LEFT JOIN sale_distribution_versions d ON d.org_id=s.org_id AND d.sale_id=s.id AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=s.org_id AND x.sale_id=s.id)
        WHERE s.org_id=? AND r.status='active' AND s.accounting_month BETWEEN ? AND ?
          AND (s.partner_id IN (SELECT l.partner_id FROM partner_lists l WHERE l.org_id=?)
            OR s.partner_id IN (SELECT v.billing_partner_id FROM partner_list_entry_versions v WHERE v.org_id=? AND v.billing_partner_id IS NOT NULL))
        ORDER BY s.accounting_month,s.id LIMIT ${SALES_LIMIT + 1}`, [i.org_id, from, to, i.org_id, i.org_id]);
      if (saleRows.length > SALES_LIMIT) return bad(c, `売上明細が${SALES_LIMIT.toLocaleString('ja-JP')}件を超えます。売上の期間を狭めてください`, 413);
      const allocations = await db.all('SELECT product_id,work_id,allocation_bps FROM product_works WHERE org_id=?', [i.org_id]);
      const sharesOf = new Map();
      for (const a of allocations) { if (!sharesOf.has(a.product_id)) sharesOf.set(a.product_id, []); sharesOf.get(a.product_id).push({work_id: a.work_id, allocation_bps: a.allocation_bps}); }
      const candidatesOf = new Map();
      for (const entry of entries) {
        for (const partnerId of new Set([entry.partner_id, entry.billing_partner_id].filter(Boolean))) {
          const key = `${partnerId}|${entry.work_id}`;
          if (!candidatesOf.has(key)) candidatesOf.set(key, []);
          candidatesOf.get(key).push(entry);
        }
      }
      const counts = Object.fromEntries(Object.keys(SALE_MATCH).map((key) => [key, 0]));
      const rows = [];
      let skipped = 0;
      for (const sale of saleRows) {
        const shares = (sale.product_id && sharesOf.get(sale.product_id)?.length) ? sharesOf.get(sale.product_id) : [{work_id: sale.work_id, allocation_bps: 10000}];
        if (!shares.every((share) => finance.has(share.work_id))) { skipped += 1; continue; }
        let amounts;
        try { amounts = splitByAllocation(Number(sale.amount_ex_tax), shares); } catch { amounts = new Map(shares.map((share) => [share.work_id, null])); }
        const info = sale.distribution_code ? codes.get(sale.distribution_code) || {} : {family: KIND_FAMILY[sale.kind] || 'other'};
        const saleFlow = flowOf(info, sale.territory);
        for (const share of shares) {
          const result = classifySale({...sale, code: sale.distribution_code, flow: saleFlow}, candidatesOf.get(`${sale.partner_id}|${share.work_id}`) || [], basis);
          counts[result.status] += 1;
          const wanted = statusFilter ? result.status === statusFilter : OUT_OF_PERIOD.includes(result.status) || result.status === 'flow_mismatch';
          if (!wanted) continue;
          const work = workOf.get(share.work_id);
          rows.push({sale_id: sale.id, partner_code: sale.partner_code, partner_name: sale.partner_name, work_id: share.work_id, work_code: work?.code, work_title: work?.title,
            accounting_month: sale.accounting_month, sales_period_from: sale.sales_period_from, sales_period_to: sale.sales_period_to, amount_ex_tax: amounts.get(share.work_id) ?? null,
            allocation_bps: share.allocation_bps, description: sale.description, report_key: sale.report_key, distribution_code: sale.distribution_code || null,
            flow_text: flowText(saleFlow), flow_basis: sale.distribution_code ? '流通分類' : '報告の種類（参考）', status: result.status, status_text: SALE_MATCH[result.status],
            entries: result.entryIds.map((id) => byId.get(id)).filter(Boolean).map((e) => `#${e.entry_id} ${e.list_name} ${e.distribution_code} ${e.contract_start || '開始未定'}〜${effectiveEnd(e) || END_RULES[e.end_rule]}`).join(' ／ ')});
        }
      }
      const order = (row) => (OUT_OF_PERIOD.includes(row.status) ? 0 : row.status === 'flow_mismatch' ? 1 : 2);
      rows.sort((a, b) => order(a) - order(b) || (a.accounting_month < b.accounting_month ? -1 : a.accounting_month > b.accounting_month ? 1 : a.sale_id - b.sale_id));
      sales = {basis, from, to, counts, rows, outOfPeriod: OUT_OF_PERIOD.reduce((n, key) => n + counts[key], 0), scanned: saleRows.length, skipped, statusFilter};
    }
    return c.json({ok: true, asOf, endingSoon: soon, soonCounts: {30: soon.filter((s) => s.bucket === 30).length, 60: soon.filter((s) => s.bucket === 60).length, 90: soon.filter((s) => s.bucket === 90).length},
      gaps, uncovered, sales, salesDenied: !finance.size});
  }));

  // ---- 追加の列 ------------------------------------------------------------------------------------
  const fieldOptions = (valueType, raw) => {
    if (valueType !== 'choice') return null;
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[,、\n]/)).map((item) => String(item).normalize('NFKC').trim()).filter(Boolean);
    if (!list.length || list.length > 50 || new Set(list).size !== list.length || list.some((item) => item.length > 40 || /[,"]/.test(item))) throw Error('選択肢は1〜50個・重ならない40文字以内の言葉（カンマ・引用符なし）にしてください');
    return list;
  };
  const checkLabel = (label, fields, selfId = null) => {
    if (reservedHeaders().has(headerKey(label))) throw Error(`「${label}」は固定の列の見出しと同じです。別の表示名にしてください`);
    if (label.normalize('NFKC').startsWith('参考_')) throw Error('「参考_」で始まる表示名は使えません（取込で読まない列の印です）');
    if (fields.some((f) => f.active && f.id !== selfId && headerKey(f.label) === headerKey(label))) throw Error(`「${label}」は使っている追加の列と同じ表示名です`);
  };

  app.get('/api/partner-list-fields', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return denied(c);
    const [fields, kinds, partners] = await Promise.all([loadFields(i.org_id), db.all('SELECT code,label FROM partner_list_kinds ORDER BY sort_order'), db.all('SELECT id,code,name FROM partners WHERE org_id=? ORDER BY code', [i.org_id])]);
    return c.json({ok: true, fields, kinds, partners, valueTypes: FIELD_VALUE_TYPES, canAdmin: i.role === 'admin'});
  }));

  app.post('/api/partner-list-fields', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '追加の列の定義と変更は管理者が行います', 403);
    const b = await body(c), reason = reasonOf(b.reason);
    const key = String(b.fieldKey || '').trim();
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw Error('キーは英小文字で始まる英小文字・数字・_ の40文字以内にしてください');
    const label = text(b.label, 40, true);
    if (!Object.hasOwn(FIELD_VALUE_TYPES, b.valueType)) throw Error('型を選んでください');
    const fields = await loadFields(i.org_id);
    if (fields.some((f) => f.field_key === key)) return bad(c, `キー「${key}」の追加の列があります`, 409);
    checkLabel(label, fields);
    const listKind = b.listKind ? String(b.listKind) : null;
    if (listKind && !await db.get('SELECT 1 FROM partner_list_kinds WHERE code=?', [listKind])) throw Error('リストの種類がありません');
    const partnerId = b.partnerId === null || b.partnerId === undefined || b.partnerId === '' ? null : integer(b.partnerId);
    if (partnerId && !await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?', [i.org_id, partnerId])) throw Error('取引先がありません');
    const options = fieldOptions(b.valueType, b.options);
    const sortOrder = b.sortOrder === undefined || b.sortOrder === '' ? 1000 : integer(b.sortOrder);
    if (sortOrder > 100000) throw Error('並び順は0〜100000です');
    const definition = '(SELECT id FROM partner_list_field_definitions WHERE org_id=? AND field_key=?)';
    await db.batch([
      {sql: 'INSERT INTO partner_list_field_definitions(org_id,field_key,value_type,list_kind,partner_id,created_by) VALUES(?,?,?,?,?,?)', params: [i.org_id, key, b.valueType, listKind, partnerId, i.user_id]},
      {sql: `INSERT INTO partner_list_field_states(org_id,definition_id,version_no,label,active,sort_order,options_json,reason,created_by) VALUES(?,${definition},1,?,1,?,?,?,?)`,
        params: [i.org_id, i.org_id, key, label, sortOrder, options ? JSON.stringify(options) : null, reason, i.user_id]},
      audit(i, 'create', 'partner_list_field', key, {valueType: b.valueType, listKind, partnerId, label, options, reason}),
    ]);
    return c.json({ok: true, fieldKey: key, version: 1}, 201);
  }));

  app.post('/api/partner-list-fields/:id/versions', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '追加の列の定義と変更は管理者が行います', 403);
    const id = integer(c.req.param('id'));
    const b = await body(c), reason = reasonOf(b.reason), base = integer(b.baseVersion ?? '');
    const fields = await loadFields(i.org_id);
    const current = fields.find((f) => f.id === id);
    if (!current) return bad(c, '追加の列がありません', 404);
    if (current.version_no !== base) return bad(c, `追加の列が更新されています（いまは第${current.version_no}版）。読み直してから直してください`, 409);
    const label = text(b.label ?? current.label, 40, true);
    const active = b.active === undefined ? current.active : Boolean(b.active);
    if (active) checkLabel(label, fields, id);
    const options = b.options === undefined ? current.options : fieldOptions(current.value_type, b.options);
    const sortOrder = b.sortOrder === undefined || b.sortOrder === '' ? current.sort_order : integer(b.sortOrder);
    await db.batch([
      guard('?<>(SELECT COALESCE(MAX(version_no),0) FROM partner_list_field_states WHERE org_id=? AND definition_id=?)', [base, i.org_id, id]),
      {sql: 'INSERT INTO partner_list_field_states(org_id,definition_id,version_no,label,active,sort_order,options_json,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
        params: [i.org_id, id, base + 1, label, active ? 1 : 0, sortOrder, options ? JSON.stringify(options) : null, reason, i.user_id]},
      audit(i, 'version', 'partner_list_field', current.field_key, {version: base + 1, before: {label: current.label, active: current.active, options: current.options}, after: {label, active, options}, reason}),
    ]);
    return c.json({ok: true, version: base + 1}, 201);
  }));
}
