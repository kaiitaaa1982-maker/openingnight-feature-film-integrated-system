// 全作品のウィンドウ（営業基幹）の API。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §2。
// - 種別（行で増える）: 一覧・初期テンプレートの採用・追加・新しい版（管理者だけ・理由必須・監査記録）
// - ウィンドウ: 全作品の一覧（サーバー側の絞り込み・100行ずつ）・版の履歴・新しい版（理由必須・版の照合）
// - Excel: 画面と同じ列の並びで出力し、同じ形で取込（確認 → 理由を書いて登録）
// 見られるのは制作担当以外で、案件の閲覧権限がある作品。直せるのは案件の編集権限がある作品。
// D1 の上限: 作品IDを値として並べない（組織で読んでから権限で絞る）。取込は1つの文で複数行を入れる（json_each）。
import {isDbConflict, isGuardViolation} from '../data-platform/db-errors.mjs';
import {integer} from '../csv.mjs';
import {encodeReportXlsx} from '../xlsx-report.mjs';
import {importLimits, utf8Bytes, reportByteLimit, kbText} from '../import/limits.mjs';
import {
  INITIAL_WINDOW_TYPES, WINDOW_STATES, WINDOW_FAMILIES, DATE_PRECISIONS, VALUE_TYPES, CHOICE_DOMAINS, DATE_FIELDS, SHEET_NAME,
  normalizeTypeDefinition, normalizeWindowInput, windowWarnings, windowState, normalizeFilters, selectedTypes, rowMatches, sameTerritory,
  windowSheetColumns, windowSheetRow, planWindowImport, typeParts, headerOf,
} from './release-window-model.mjs';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const attachment = (name, ascii) => `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name).toWellFormed())}`;
const stamp = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '');
const nowIso = () => new Date().toISOString();
const PREVIEW_MINUTES = 30;

const text = (value, max, required = false) => {
  if (value !== null && value !== undefined && typeof value !== 'string') throw Error('文字を入力してください');
  const v = String(value ?? '').trim();
  if (v.length > max || (required && !v)) throw Error(required ? '必須の項目（理由など）を入れてください' : `${max}文字までです`);
  return v || null;
};
const reasonOf = (value) => text(value, 1000, true);

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function registerReleaseWindowRoutes(app, {db, bad, body, permittedProjects, mode = 'local'}) {
  // 版の照合（transaction_guards への 0 の挿入）で止まったときは、利用者に分かる文にする
  const friendly = (error) => (isGuardViolation(error)
    ? '確かめた後に、別の人が同じウィンドウ（または種別）を直しました。読み直してからもう一度登録してください' : error.message);
  const wrap = (fn) => async (c) => {
    try { return await fn(c); } catch (error) { return bad(c, friendly(error), isDbConflict(error) || /stale|immutable|mismatch/i.test(error.message) ? 409 : 400, undefined, error); }
  };
  const audit = (i, action, entity, id, detail) => ({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', params: [i.org_id, i.user_id, action, entity, String(id), JSON.stringify(detail)]});
  const guard = (sql, params) => ({sql: `INSERT INTO transaction_guards(value) SELECT 0 WHERE ${sql}`, params});

  // 見られる作品（案件の閲覧権限）と直せる作品（案件の編集権限）。制作担当は null（営業基幹は担当範囲外）
  async function scope(i) {
    if (i.role === 'production') return null;
    const [view, edit] = await Promise.all([permittedProjects(db, i, false), permittedProjects(db, i, true)]);
    const viewIds = new Set(view.map((p) => p.id)), editIds = new Set(edit.map((p) => p.id));
    const works = (await db.all(`SELECT w.id,w.code,w.title,w.project_id,p.code AS project_code,p.title AS project_title
      FROM works w JOIN projects p ON p.org_id=w.org_id AND p.id=w.project_id WHERE w.org_id=? ORDER BY w.code,w.id`, [i.org_id])).filter((w) => viewIds.has(w.project_id));
    return {works, editable: new Set(works.filter((w) => editIds.has(w.project_id)).map((w) => w.id))};
  }

  // 種別の最新の版（項目・流通IDつき）。並び順 → ID の順
  async function loadTypes(orgId) {
    const latest = 'version_no=(SELECT MAX(x.version_no) FROM release_window_type_versions x WHERE x.org_id=%a.org_id AND x.type_id=%a.type_id)';
    const [versions, fields, distributions] = await Promise.all([
      db.all(`SELECT t.id,t.type_key,v.version_no,v.label,v.group_label,v.family,v.date_mode,v.start_label,v.end_label,v.has_announce,v.default_territory,v.sort_order,v.active,v.reason,v.created_at
        FROM release_window_types t JOIN release_window_type_versions v ON v.org_id=t.org_id AND v.type_id=t.id
        WHERE t.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM release_window_type_versions x WHERE x.org_id=t.org_id AND x.type_id=t.id) ORDER BY v.sort_order,t.id`, [orgId]),
      db.all(`SELECT f.type_id,f.field_key,f.label,f.value_type,f.choice_domain,f.sort_order FROM release_window_type_fields f WHERE f.org_id=? AND f.${latest.replaceAll('%a', 'f')} ORDER BY f.sort_order,f.field_key`, [orgId]),
      db.all(`SELECT d.type_id,d.distribution_code FROM release_window_type_distributions d WHERE d.org_id=? AND d.${latest.replaceAll('%a', 'd')} ORDER BY d.distribution_code`, [orgId]),
    ]);
    return versions.map((v) => ({
      ...v, has_announce: Number(v.has_announce), active: Number(v.active) === 1,
      fields: fields.filter((f) => f.type_id === v.id).map(({type_id, ...f}) => f),
      distributions: distributions.filter((d) => d.type_id === v.id).map((d) => d.distribution_code),
    }));
  }

  // 各系列の最新の版（項目の値つき）
  async function loadWindows(orgId) {
    const [rows, values] = await Promise.all([
      db.all(`SELECT w.id AS window_id,w.work_id,w.type_id,w.territory,v.version_no,v.type_version_no,v.start_on,v.end_on,v.announce_on,v.date_precision,v.timing_raw,v.status,
          v.availability_version_id,v.source_kind,v.source_reference,v.reason,v.import_batch_id,v.created_at,u.display_name AS created_by_name
        FROM work_release_windows w JOIN work_release_window_versions v ON v.org_id=w.org_id AND v.window_id=w.id
          AND v.version_no=(SELECT MAX(x.version_no) FROM work_release_window_versions x WHERE x.org_id=w.org_id AND x.window_id=w.id)
        LEFT JOIN users u ON u.id=v.created_by WHERE w.org_id=?`, [orgId]),
      db.all(`SELECT f.window_id,f.field_key,f.value_text,f.value_number FROM work_release_window_field_values f
        WHERE f.org_id=? AND f.version_no=(SELECT MAX(x.version_no) FROM work_release_window_versions x WHERE x.org_id=f.org_id AND x.window_id=f.window_id)`, [orgId]),
    ]);
    const fieldsOf = new Map();
    for (const value of values) {
      if (!fieldsOf.has(value.window_id)) fieldsOf.set(value.window_id, {});
      fieldsOf.get(value.window_id)[value.field_key] = {t: value.value_text ?? null, n: value.value_number ?? null};
    }
    return rows.map((row) => ({...row, fields: fieldsOf.get(row.window_id) || {}}));
  }

  // 警告の材料（作品ごと）: 販売条件の最新版・権利範囲（置き換えられていない調達ケース）・放送枠の最新版・流通名
  async function loadWarningContext(orgId) {
    const [availabilities, scopes, slots, master] = await Promise.all([
      db.all(`SELECT v.id,v.work_id,v.distribution_code,v.territory,v.version_no,v.release_on,v.sales_end_on,v.status FROM sales_availability_versions v
        WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM sales_availability_versions x WHERE x.org_id=v.org_id AND x.work_id=v.work_id AND x.distribution_code=v.distribution_code AND x.territory=v.territory)`, [orgId]),
      db.all(`SELECT c.work_id,s.channel,s.territory,s.rights_start,s.rights_end FROM rights_intake_scopes s JOIN rights_intake_cases c ON c.org_id=s.org_id AND c.id=s.intake_case_id
        WHERE s.org_id=? AND NOT EXISTS(SELECT 1 FROM rights_intake_cases n WHERE n.org_id=c.org_id AND n.source_case_id=c.id)`, [orgId]),
      db.all(`SELECT v.work_id,v.slot_id,v.broadcast_month,v.station_name,v.status FROM broadcast_slot_versions v
        WHERE v.org_id=? AND v.revision=(SELECT MAX(z.revision) FROM broadcast_slot_versions z WHERE z.org_id=v.org_id AND z.slot_id=v.slot_id)`, [orgId]),
      db.all('SELECT code,distribution_name FROM distribution_master'),
    ]);
    const group = (list) => { const map = new Map(); for (const row of list) { if (!map.has(row.work_id)) map.set(row.work_id, []); map.get(row.work_id).push(row); } return map; };
    return {availabilities: group(availabilities), scopes: group(scopes), slots: group(slots), distributionNames: new Map(master.map((m) => [m.code, m.distribution_name]))};
  }

  // 系列を 作品|種別 で引けるようにする
  function indexWindows(windows) {
    const index = new Map();
    for (const w of windows) {
      const key = `${w.work_id}|${w.type_id}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(w);
    }
    return index;
  }
  // 既定の地域のウィンドウ（同じ文字 → 名寄せで同じ地域 の順）
  function defaultWindow(index, workId, type) {
    const list = index.get(`${workId}|${type.id}`) || [];
    return list.find((w) => w.territory === type.default_territory) || list.find((w) => sameTerritory(w.territory, type.default_territory)) || null;
  }

  // 全作品の行（条件で絞ったもの。ページに分ける前）
  async function buildRows(i, query) {
    const access = await scope(i);
    if (!access) return null;
    const types = await loadTypes(i.org_id);
    const activeTypes = types.filter((type) => type.active);
    const filters = normalizeFilters(query, activeTypes);
    const selected = selectedTypes(activeTypes, filters);
    const [windows, context] = await Promise.all([loadWindows(i.org_id), loadWarningContext(i.org_id)]);
    const visible = new Set(access.works.map((w) => w.id));
    const ownWindows = windows.filter((w) => visible.has(w.work_id));
    const index = indexWindows(ownWindows);
    const all = access.works.map((work) => {
      const workContext = {availabilities: context.availabilities.get(work.id) || [], scopes: context.scopes.get(work.id) || [], slots: context.slots.get(work.id) || [], distributionNames: context.distributionNames};
      const entries = selected.map((type) => {
        const version = defaultWindow(index, work.id, type);
        const warnings = windowWarnings(version, type, version?.territory || type.default_territory, workContext);
        return {typeKey: type.type_key, typeLabel: type.label, typeVersion: type, version, state: windowState(version), warnings};
      });
      return {work_id: work.id, work_code: work.code, work_title: work.title, project_code: work.project_code, project_title: work.project_title, canEdit: access.editable.has(work.id), entries};
    });
    const matched = all.filter((row) => rowMatches(row, filters));
    return {access, types, activeTypes, selected, filters, all, matched, windows: ownWindows};
  }

  const publicRow = (row) => ({
    work_id: row.work_id, work_code: row.work_code, work_title: row.work_title, project_code: row.project_code, project_title: row.project_title, canEdit: row.canEdit,
    warningCount: row.entries.reduce((n, entry) => n + entry.warnings.length, 0),
    windows: Object.fromEntries(row.entries.map((entry) => [entry.typeKey, {typeLabel: entry.typeLabel, state: entry.state, warnings: entry.warnings,
      version: entry.version ? {...entry.version} : null}])),
  });

  // ---- 種別 -----------------------------------------------------------------------------
  app.get('/api/release-window-types', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '営業基幹は担当範囲外です', 403);
    const [types, codes] = await Promise.all([loadTypes(i.org_id), db.all('SELECT t.code,t.label,m.distribution_name,m.transaction_method,m.sales_type FROM distribution_types t LEFT JOIN distribution_master m ON m.code=t.code ORDER BY t.sort_order,t.code')]);
    return c.json({ok: true, types, canAdmin: i.role === 'admin', canAdopt: i.role === 'admin' && types.length === 0, templates: INITIAL_WINDOW_TYPES,
      families: WINDOW_FAMILIES, states: WINDOW_STATES, precisions: DATE_PRECISIONS, valueTypes: VALUE_TYPES, choiceDomains: CHOICE_DOMAINS, dateFields: DATE_FIELDS, distributionCodes: codes});
  }));

  async function typeStatements(i, orgId, definition, versionNo, reason, knownCodes) {
    const typeId = {sql: '(SELECT id FROM release_window_types WHERE org_id=? AND type_key=?)', params: [orgId, definition.type_key]};
    const out = [{sql: `INSERT INTO release_window_type_versions(org_id,type_id,version_no,label,group_label,family,date_mode,start_label,end_label,has_announce,default_territory,sort_order,active,reason,created_by)
      VALUES(?,${typeId.sql},?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [orgId, ...typeId.params, versionNo, definition.label, definition.group_label, definition.family, definition.date_mode,
      definition.start_label, definition.end_label, definition.has_announce, definition.default_territory, definition.sort_order, definition.active, reason, i.user_id]}];
    for (const field of definition.fields) {
      out.push({sql: `INSERT INTO release_window_type_fields(org_id,type_id,version_no,field_key,label,value_type,choice_domain,sort_order) VALUES(?,${typeId.sql},?,?,?,?,?,?)`,
        params: [orgId, ...typeId.params, versionNo, field.field_key, field.label, field.value_type, field.choice_domain, field.sort_order]});
    }
    for (const code of definition.distributions) {
      if (!knownCodes.has(code)) continue;
      out.push({sql: `INSERT INTO release_window_type_distributions(org_id,type_id,version_no,distribution_code) VALUES(?,${typeId.sql},?,?)`, params: [orgId, ...typeId.params, versionNo, code]});
    }
    return out;
  }

  // 初期テンプレートの採用（種別がまだ1つも無い組織だけ）
  app.post('/api/release-window-types/adopt', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '種別の採用・追加・変更は管理者が行います', 403);
    const b = await body(c), reason = reasonOf(b.reason);
    if ((await loadTypes(i.org_id)).length) return bad(c, 'この組織はウィンドウの種別を採用済みです。種別は追加・版の作成で直してください', 409);
    const knownCodes = new Set((await db.all('SELECT code FROM distribution_types')).map((row) => row.code));
    const statements = [guard('EXISTS(SELECT 1 FROM release_window_types WHERE org_id=?)', [i.org_id])];
    for (const template of INITIAL_WINDOW_TYPES) {
      const definition = {...template, active: 1, fields: [...template.fields], distributions: [...template.distributions]};
      statements.push({sql: 'INSERT INTO release_window_types(org_id,type_key,created_by) VALUES(?,?,?)', params: [i.org_id, definition.type_key, i.user_id]});
      statements.push(...await typeStatements(i, i.org_id, definition, 1, reason, knownCodes));
    }
    statements.push(audit(i, 'adopt', 'release_window_type', i.org_id, {types: INITIAL_WINDOW_TYPES.map((t) => t.type_key), reason}));
    await db.batch(statements);
    return c.json({ok: true, adopted: INITIAL_WINDOW_TYPES.length}, 201);
  }));

  app.post('/api/release-window-types', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '種別の採用・追加・変更は管理者が行います', 403);
    const b = await body(c), reason = reasonOf(b.reason);
    const types = await loadTypes(i.org_id);
    const normalized = normalizeTypeDefinition(b, {existingKeys: types.map((t) => t.type_key), existingLabels: types.filter((t) => t.active).map((t) => t.label)});
    if (normalized.error) throw Error(normalized.error);
    const knownCodes = new Set((await db.all('SELECT code FROM distribution_types')).map((row) => row.code));
    const unknown = normalized.value.distributions.filter((code) => !knownCodes.has(code));
    if (unknown.length) throw Error(`登録されていない流通IDです: ${unknown.join('、')}`);
    await db.batch([
      {sql: 'INSERT INTO release_window_types(org_id,type_key,created_by) VALUES(?,?,?)', params: [i.org_id, normalized.value.type_key, i.user_id]},
      ...await typeStatements(i, i.org_id, normalized.value, 1, reason, knownCodes),
      audit(i, 'create', 'release_window_type', normalized.value.type_key, {version: 1, definition: normalized.value, reason}),
    ]);
    return c.json({ok: true, typeKey: normalized.value.type_key, version: 1}, 201);
  }));

  app.post('/api/release-window-types/:typeId/versions', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '種別の採用・追加・変更は管理者が行います', 403);
    const typeId = integer(c.req.param('typeId'));
    const b = await body(c), reason = reasonOf(b.reason), base = integer(b.baseVersion ?? '');
    const types = await loadTypes(i.org_id);
    const current = types.find((t) => t.id === typeId);
    if (!current) return bad(c, '種別がありません', 404);
    if (current.version_no !== base) return bad(c, `種別が更新されています（いまは第${current.version_no}版）。読み直してから直してください`, 409);
    const merged = {...current, ...b, type_key: current.type_key, fields: Object.hasOwn(b, 'fields') ? b.fields : current.fields, distributions: Object.hasOwn(b, 'distributions') ? b.distributions : current.distributions};
    const normalized = normalizeTypeDefinition(merged, {requireKey: false, existingLabels: types.filter((t) => t.active && t.id !== typeId).map((t) => t.label)});
    if (normalized.error) throw Error(normalized.error);
    const definition = {...normalized.value, type_key: current.type_key};
    const knownCodes = new Set((await db.all('SELECT code FROM distribution_types')).map((row) => row.code));
    const unknown = definition.distributions.filter((code) => !knownCodes.has(code));
    if (unknown.length) throw Error(`登録されていない流通IDです: ${unknown.join('、')}`);
    await db.batch([
      guard('?<>(SELECT COALESCE(MAX(version_no),0) FROM release_window_type_versions WHERE org_id=? AND type_id=?)', [base, i.org_id, typeId]),
      ...await typeStatements(i, i.org_id, definition, base + 1, reason, knownCodes),
      audit(i, 'version', 'release_window_type', typeId, {version: base + 1, before: {label: current.label, active: current.active}, after: {label: definition.label, active: Boolean(definition.active)}, reason}),
    ]);
    return c.json({ok: true, version: base + 1}, 201);
  }));

  // ---- ウィンドウ ---------------------------------------------------------------------------
  app.get('/api/release-windows', wrap(async (c) => {
    const i = c.get('identity');
    const built = await buildRows(i, c.req.query());
    if (!built) return bad(c, '営業基幹は担当範囲外です', 403);
    const {filters, matched, selected, types, access} = built;
    const pages = Math.max(1, Math.ceil(matched.length / filters.pageSize));
    const page = Math.min(filters.page, pages);
    const rows = matched.slice((page - 1) * filters.pageSize, page * filters.pageSize).map(publicRow);
    const byState = Object.fromEntries(Object.keys(WINDOW_STATES).map((state) => [state, 0]));
    let warningWindows = 0;
    for (const row of matched) for (const entry of row.entries) { byState[entry.state] += 1; if (entry.warnings.length) warningWindows += 1; }
    return c.json({ok: true, types: types.filter((t) => t.active), selectedTypeKeys: selected.map((t) => t.type_key), filters, rows, page, pages, pageSize: filters.pageSize,
      total: matched.length, worksVisible: access.works.length, counts: {byState, warningWindows, warningRows: matched.filter((row) => row.entries.some((e) => e.warnings.length)).length},
      canAdmin: i.role === 'admin', needsAdoption: types.length === 0});
  }));

  app.get('/api/release-windows/history', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, '営業基幹は担当範囲外です', 403);
    const workId = integer(c.req.query('workId') || ''), typeId = integer(c.req.query('typeId') || '');
    const work = access.works.find((w) => w.id === workId);
    if (!work) return bad(c, '作品への権限がありません', 403);
    const type = (await loadTypes(i.org_id)).find((t) => t.id === typeId);
    if (!type) return bad(c, '種別がありません', 404);
    const territory = String(c.req.query('territory') || '').trim() || null;
    const series = await db.all('SELECT id,territory FROM work_release_windows WHERE org_id=? AND work_id=? AND type_id=? ORDER BY id', [i.org_id, workId, typeId]);
    const win = territory ? series.find((w) => w.territory === territory) : series.find((w) => w.territory === type.default_territory) || series.find((w) => sameTerritory(w.territory, type.default_territory));
    const versions = win ? await db.all(`SELECT v.*,u.display_name AS created_by_name FROM work_release_window_versions v LEFT JOIN users u ON u.id=v.created_by
      WHERE v.org_id=? AND v.window_id=? ORDER BY v.version_no DESC`, [i.org_id, win.id]) : [];
    const values = win ? await db.all('SELECT version_no,field_key,value_text,value_number FROM work_release_window_field_values WHERE org_id=? AND window_id=?', [i.org_id, win.id]) : [];
    const typeVersions = await db.all('SELECT version_no,label FROM release_window_type_versions WHERE org_id=? AND type_id=?', [i.org_id, typeId]);
    // 種別の最新の版に無いが、この系列の版に値がある追加項目（履歴に「今は使っていない」列として出す）。見出しはその項目があった最後の種別の版
    const current = new Set(type.fields.map((field) => field.field_key));
    const pastKeys = new Set(values.map((f) => f.field_key).filter((key) => !current.has(key)));
    const pastFields = [];
    if (pastKeys.size) {
      const defined = await db.all('SELECT field_key,label,value_type,choice_domain,sort_order,version_no FROM release_window_type_fields WHERE org_id=? AND type_id=? ORDER BY version_no DESC', [i.org_id, typeId]);
      for (const key of pastKeys) {
        const field = defined.find((f) => f.field_key === key);
        pastFields.push(field ? {field_key: key, label: field.label, value_type: field.value_type, choice_domain: field.choice_domain, sort_order: field.sort_order} : {field_key: key, label: key, value_type: 'text', choice_domain: null, sort_order: 10000});
      }
      pastFields.sort((a, b) => a.sort_order - b.sort_order || a.field_key.localeCompare(b.field_key));
    }
    const context = await loadWarningContext(i.org_id);
    const availabilities = (context.availabilities.get(workId) || []).filter((a) => type.distributions.includes(a.distribution_code));
    return c.json({ok: true, work: {id: work.id, code: work.code, title: work.title}, canEdit: access.editable.has(workId) && type.active, type,
      territory: win?.territory || territory || type.default_territory, windowId: win?.id || null, otherTerritories: series.filter((w) => w !== win).map((w) => w.territory),
      versions: versions.map((v) => ({...v, type_label: typeVersions.find((t) => t.version_no === v.type_version_no)?.label || type.label,
        fields: Object.fromEntries(values.filter((f) => f.version_no === v.version_no).map((f) => [f.field_key, {t: f.value_text ?? null, n: f.value_number ?? null}]))})),
      availabilities, pastFields});
  }));

  app.post('/api/release-windows', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, '営業基幹は担当範囲外です', 403);
    const b = await body(c), workId = integer(b.workId ?? ''), typeId = integer(b.typeId ?? '');
    if (!access.editable.has(workId)) return bad(c, '作品の編集権限がありません', 403);
    const type = (await loadTypes(i.org_id)).find((t) => t.id === typeId);
    if (!type) return bad(c, '種別がありません', 404);
    if (!type.active) return bad(c, `「${type.label}」は使っていない種別です。管理者が使う設定に戻してから直してください`, 409);
    // 地域を省いたときは既定の地域の系列（同じ文字 → 名寄せで同じ地域。「国内」などの別表記の系列もそのまま使う）
    const given = text(b.territory ?? null, 100);
    const territory = given || (await db.all('SELECT territory FROM work_release_windows WHERE org_id=? AND work_id=? AND type_id=? ORDER BY id', [i.org_id, workId, typeId])
      .then((rows) => rows.find((w) => w.territory === type.default_territory) || rows.find((w) => sameTerritory(w.territory, type.default_territory))))?.territory || type.default_territory;
    const base = integer(b.baseVersion ?? '');
    const reason = reasonOf(b.reason);
    const sourceReference = text(b.sourceReference ?? null, 1000);
    const availabilityId = b.availabilityVersionId === null || b.availabilityVersionId === undefined || b.availabilityVersionId === '' ? null : integer(b.availabilityVersionId);
    if (availabilityId && !await db.get('SELECT 1 FROM sales_availability_versions WHERE org_id=? AND id=? AND work_id=?', [i.org_id, availabilityId, workId])) throw Error('根拠にする販売条件の版がこの作品にありません');
    const sourceKind = b.sourceKind === 'from_availability' && availabilityId ? 'from_availability' : 'manual';
    const series = await db.get('SELECT w.id,COALESCE(MAX(v.version_no),0) AS n,(SELECT status FROM work_release_window_versions z WHERE z.org_id=w.org_id AND z.window_id=w.id ORDER BY z.version_no DESC LIMIT 1) AS status FROM work_release_windows w LEFT JOIN work_release_window_versions v ON v.org_id=w.org_id AND v.window_id=w.id WHERE w.org_id=? AND w.work_id=? AND w.type_id=? AND w.territory=? GROUP BY w.id', [i.org_id, workId, typeId, territory]);
    if ((series?.n || 0) !== base) return bad(c, `このウィンドウは更新されています（いまは第${series?.n || 0}版）。読み直してから直してください`, 409);
    const normalized = normalizeWindowInput({start: b.start, end: b.end, announce: b.announce, status: b.status, fields: b.fields || {}}, type, {currentStatus: series?.status || null});
    if (normalized.errors.length) return bad(c, normalized.errors.join(' ／ '), 400);
    const value = normalized.value, next = base + 1;
    const windowRef = '(SELECT id FROM work_release_windows WHERE org_id=? AND work_id=? AND type_id=? AND territory=?)';
    const key = [i.org_id, workId, typeId, territory];
    const statements = [guard(`?<>(SELECT COALESCE(MAX(v.version_no),0) FROM work_release_window_versions v JOIN work_release_windows w ON w.org_id=v.org_id AND w.id=v.window_id WHERE w.org_id=? AND w.work_id=? AND w.type_id=? AND w.territory=?)`, [base, ...key])];
    if (base === 0) statements.push({sql: 'INSERT INTO work_release_windows(org_id,work_id,type_id,territory,created_by) VALUES(?,?,?,?,?)', params: [...key, i.user_id]});
    statements.push({sql: `INSERT INTO work_release_window_versions(org_id,window_id,version_no,type_version_no,start_on,end_on,announce_on,date_precision,timing_raw,status,availability_version_id,source_kind,source_reference,reason,created_by)
      VALUES(?,${windowRef},?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [i.org_id, ...key, next, type.version_no, value.start_on, value.end_on, value.announce_on, value.date_precision, value.timing_raw, value.status,
      availabilityId, sourceKind, sourceReference, reason, i.user_id]});
    for (const [fieldKey, field] of Object.entries(value.fields)) {
      statements.push({sql: `INSERT INTO work_release_window_field_values(org_id,window_id,version_no,field_key,value_text,value_number) VALUES(?,${windowRef},?,?,?,?)`, params: [i.org_id, ...key, next, fieldKey, field.t, field.n]});
    }
    statements.push(audit(i, base ? 'version' : 'create', 'release_window', `${workId}:${type.type_key}:${territory}`, {version: next, after: value, reason, sourceKind, availabilityVersionId: availabilityId}));
    await db.batch(statements);
    return c.json({ok: true, version: next, territory}, 201);
  }));

  // ---- Excel ------------------------------------------------------------------------------
  app.get('/api/release-windows/export.xlsx', wrap(async (c) => {
    const i = c.get('identity');
    const built = await buildRows(i, c.req.query());
    if (!built) return bad(c, '営業基幹は担当範囲外です', 403);
    const {selected, matched, filters, types} = built;
    const columns = windowSheetColumns(selected);
    const rows = matched.map((row) => windowSheetRow(publicRow(row), selected));
    const validations = [];
    for (const type of selected) {
      validations.push({key: `${type.type_key}:status`, list: ['予定', '確定', '取り下げ']});
      for (const field of type.fields) if (field.value_type === 'choice') validations.push({key: `${type.type_key}:field:${field.field_key}`, list: Object.values(CHOICE_DOMAINS[field.choice_domain] || {})});
    }
    const definition = selected.map((type) => ({type_key: type.type_key, version_no: type.version_no, headers: typeParts(type).map((part) => headerOf(type, part))}));
    const hash = await sha256Hex(JSON.stringify(definition));
    const conditionText = [
      filters.families.length ? `分類: ${filters.families.map((f) => WINDOW_FAMILIES[f]).join('・')}` : '',
      filters.typeKeys.length ? `種別: ${filters.typeKeys.map((k) => types.find((t) => t.type_key === k)?.label || k).join('・')}` : '',
      filters.state ? `状態: ${WINDOW_STATES[filters.state]}` : '',
      filters.dateField && (filters.from || filters.to) ? `${DATE_FIELDS[filters.dateField]}: ${filters.from || '…'}〜${filters.to || '…'}` : '',
      filters.q ? `語句: ${filters.q}` : '', filters.warnings ? '警告のあるものだけ' : '',
    ].filter(Boolean).join(' ／ ') || '指定なし（閲覧できる全作品）';
    const headerKinds = Object.fromEntries(columns.map((column) => [column.key, column.reference ? 'reference' : column.key === 'work_code' ? 'required' : 'header']));
    const sheets = [
      {name: SHEET_NAME, titleBand: false, freezeCols: 1, columns, rows, headerKinds, validations},
      {name: '_定義', title: '全作品のウィンドウ（種別の定義）', conditions: [['条件', conditionText]], dataAsOf: nowIso(), freezeCols: 0,
        columns: [{key: 'type_key', label: '種別キー', type: 'code'}, {key: 'label', label: '種別', type: 'text'}, {key: 'group_label', label: 'まとまり', type: 'text'},
          {key: 'family', label: '分類', type: 'text'}, {key: 'date_mode', label: '日付の形', type: 'text'}, {key: 'territory', label: '既定の地域', type: 'text'},
          {key: 'headers', label: '列の見出し', type: 'text', wrap: true, width: 60}, {key: 'distributions', label: '対応する流通ID', type: 'text', wrap: true}, {key: 'version_no', label: '種別の版', type: 'int'}],
        rows: selected.map((type) => ({type_key: type.type_key, label: type.label, group_label: type.group_label, family: WINDOW_FAMILIES[type.family], date_mode: type.date_mode === 'point' ? '1日' : '期間',
          territory: type.default_territory, headers: typeParts(type).map((part) => headerOf(type, part)).join('、'), distributions: type.distributions.join('、'), version_no: type.version_no})),
        notes: ['日付は 2026-11-05（日付）・2026-11（月まで）・2026（年まで）の形で入れます。「2027年春」のような時期は原文のまま、「未定」は未定として読みます。',
          '取込は作品コードで照合します。「参考_」で始まる列と、知らない見出しの列は読みません。無い列は変更しません。ある列の空欄は空にします（状態の空欄は今の状態のまま）。',
          '版の列は出力したときの版です。出力の後に別の人が直した行は取り込めません（出力し直してください）。']},
      {name: '_meta', hidden: true, titleBand: false, freezeCols: 0, columns: [{key: 'key', label: '項目', type: 'text'}, {key: 'value', label: '値', type: 'text'}],
        rows: [{key: '出力日時', value: nowIso()}, {key: '組織', value: String(i.org_id)}, {key: '条件', value: conditionText}, {key: '行数', value: String(rows.length)}, {key: '定義の照合値', value: hash}]},
    ];
    const bytes = encodeReportXlsx({sheets});
    return new Response(bytes, {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(`全作品のウィンドウ_${stamp()}.xlsx`, 'release-windows.xlsx')}});
  }));

  app.post('/api/release-windows/import/preview', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, '営業基幹は担当範囲外です', 403);
    const b = await body(c);
    const table = b?.table;
    if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) throw Error('読み込んだ表がありません');
    const allTypes = await loadTypes(i.org_id);
    const types = allTypes.filter((t) => t.active);
    if (!types.length) return bad(c, 'ウィンドウの種別がまだありません（管理者が初期の種別を採用してください）', 409);
    const visible = new Set(access.works.map((work) => work.id));
    const index = indexWindows((await loadWindows(i.org_id)).filter((w) => visible.has(w.work_id)));
    const current = new Map();
    for (const work of access.works) for (const type of types) {
      const win = defaultWindow(index, work.id, type);
      if (win) current.set(`${work.id}|${type.id}`, win);
    }
    const plan = planWindowImport(table, {types, allTypes, works: access.works, editable: access.editable, current});
    const rows = plan.rows.map(({cells, ...row}) => row);
    if (plan.counts.errors) {
      return c.json({ok: false, error: `${plan.counts.errors}行にエラーがあります（全${plan.counts.rows}行）。1行でもエラーがあると、どの行も登録しません。表の理由を見て直し、もう一度読み込んでください`,
        counts: plan.counts, rows, warnings: plan.fileWarnings, headers: table.headers, failedRows: plan.rows.filter((row) => row.errors.length).map((row) => ({rowNo: row.rowNo, cells: row.cells, errors: row.errors}))}, 400);
    }
    if (!plan.changes.length) return c.json({ok: true, token: null, counts: plan.counts, rows, warnings: plan.fileWarnings});
    const payload = JSON.stringify(plan.changes);
    const limit = reportByteLimit(importLimits(mode));
    if (utf8Bytes(payload) > limit) return bad(c, `変更が多すぎます（${plan.changes.length}件のウィンドウ・${kbText(utf8Bytes(payload))}）。1回の取込は${kbText(limit)}までです。ファイルを分けて読み込んでください`, 413);
    const token = crypto.randomUUID(), expires = new Date(Date.now() + PREVIEW_MINUTES * 60_000).toISOString();
    await db.run('INSERT INTO release_window_import_previews(token,org_id,user_id,payload_json,expires_at) VALUES(?,?,?,?,?)', [token, i.org_id, i.user_id, payload, expires]);
    return c.json({ok: true, token, expiresAt: expires, counts: plan.counts, rows, warnings: plan.fileWarnings, fileName: String(b.fileName || '')});
  }));

  app.post('/api/release-windows/import/commit', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, '営業基幹は担当範囲外です', 403);
    const b = await body(c);
    const reason = reasonOf(b.reason);
    if (b.confirmed !== true) return bad(c, '差分を確かめてから登録してください', 400);
    const preview = await db.get('SELECT * FROM release_window_import_previews WHERE token=? AND org_id=? AND user_id=? AND consumed=0 AND expires_at>?', [String(b.token || ''), i.org_id, i.user_id, nowIso()]);
    if (!preview) return bad(c, '取込の確認がないか期限切れです。もう一度読み込んでください', 410);
    const changes = JSON.parse(preview.payload_json);
    if (changes.some((change) => !access.editable.has(change.workId))) return bad(c, '作品の編集権限がありません', 403);
    const source = text(b.fileName ?? null, 200);
    const from = 'FROM release_window_import_previews p JOIN json_each(p.payload_json) j ON 1=1';
    const windowJoin = "JOIN work_release_windows w ON w.org_id=p.org_id AND w.work_id=CAST(json_extract(j.value,'$.workId') AS INTEGER) AND w.type_id=CAST(json_extract(j.value,'$.typeId') AS INTEGER) AND w.territory=json_extract(j.value,'$.territory')";
    const statements = [
      guard('NOT EXISTS(SELECT 1 FROM release_window_import_previews WHERE token=? AND consumed=0 AND expires_at>?)', [preview.token, nowIso()]),
      // 確認の後に別の人が直した系列があれば止める（1つの文で全系列を照合する）
      {sql: `INSERT INTO transaction_guards(value) SELECT 0 ${from} WHERE p.token=? AND CAST(json_extract(j.value,'$.baseVersion') AS INTEGER)<>COALESCE((SELECT MAX(v.version_no) FROM work_release_window_versions v JOIN work_release_windows x ON x.org_id=v.org_id AND x.id=v.window_id
        WHERE x.org_id=p.org_id AND x.work_id=CAST(json_extract(j.value,'$.workId') AS INTEGER) AND x.type_id=CAST(json_extract(j.value,'$.typeId') AS INTEGER) AND x.territory=json_extract(j.value,'$.territory')),0) LIMIT 1`, params: [preview.token]},
      // 種別が変わった（版が進んだ・使わなくなった）ときも止める
      {sql: `INSERT INTO transaction_guards(value) SELECT 0 ${from} WHERE p.token=? AND NOT EXISTS(SELECT 1 FROM release_window_type_versions tv WHERE tv.org_id=p.org_id AND tv.type_id=CAST(json_extract(j.value,'$.typeId') AS INTEGER)
        AND tv.version_no=CAST(json_extract(j.value,'$.typeVersionNo') AS INTEGER) AND tv.active=1 AND tv.version_no=(SELECT MAX(z.version_no) FROM release_window_type_versions z WHERE z.org_id=tv.org_id AND z.type_id=tv.type_id)) LIMIT 1`, params: [preview.token]},
      {sql: `INSERT INTO work_release_windows(org_id,work_id,type_id,territory,created_by) SELECT p.org_id,json_extract(j.value,'$.workId'),json_extract(j.value,'$.typeId'),json_extract(j.value,'$.territory'),? ${from}
        WHERE p.token=? AND CAST(json_extract(j.value,'$.baseVersion') AS INTEGER)=0`, params: [i.user_id, preview.token]},
      {sql: `INSERT INTO work_release_window_versions(org_id,window_id,version_no,type_version_no,start_on,end_on,announce_on,date_precision,timing_raw,status,source_kind,source_reference,reason,import_batch_id,created_by)
        SELECT p.org_id,w.id,CAST(json_extract(j.value,'$.baseVersion') AS INTEGER)+1,json_extract(j.value,'$.typeVersionNo'),json_extract(j.value,'$.start_on'),json_extract(j.value,'$.end_on'),json_extract(j.value,'$.announce_on'),
          json_extract(j.value,'$.date_precision'),json_extract(j.value,'$.timing_raw'),json_extract(j.value,'$.status'),'excel_import',?,?,p.token,? ${from} ${windowJoin} WHERE p.token=?`,
        params: [source, reason, i.user_id, preview.token]},
      {sql: `INSERT INTO work_release_window_field_values(org_id,window_id,version_no,field_key,value_text,value_number)
        SELECT p.org_id,w.id,CAST(json_extract(j.value,'$.baseVersion') AS INTEGER)+1,json_extract(f.value,'$.k'),json_extract(f.value,'$.t'),json_extract(f.value,'$.n') ${from} JOIN json_each(j.value,'$.fields') f ON 1=1 ${windowJoin} WHERE p.token=?`,
        params: [preview.token]},
      {sql: 'UPDATE release_window_import_previews SET consumed=1 WHERE token=?', params: [preview.token]},
      audit(i, 'import', 'release_window', preview.token, {append: changes.filter((x) => x.baseVersion === 0).length, revise: changes.filter((x) => x.baseVersion > 0).length, fileName: source, reason}),
    ];
    await db.batch(statements);
    return c.json({ok: true, append: changes.filter((x) => x.baseVersion === 0).length, revise: changes.filter((x) => x.baseVersion > 0).length}, 201);
  }));
}
