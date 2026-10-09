// 営業基幹「提案資料」の API。設計: docs/platform/team-development/sales-proposals.md。
// - 月別の5種（PVOD基準・TVOD基準・TVOD先行基準・EST先行基準・EST基準）: 基準と月ごとの件数、1つの基準×月の表、Excel・CSV
// - SVOD: 提案先×提案期間の表（継続・新規・注意と小計・合計）、Excel・CSV
// - 提案資料に出す作品情報（work_proposal_profiles）: 最新の版と履歴の読み取り、新しい版の登録（理由必須・版の照合・監査記録）
// 見られるのは全作品のウィンドウと同じ（制作担当以外で、案件の閲覧権限がある作品）。作品情報を直せるのは案件の編集権限がある作品だけ。
// ウィンドウは全作品のウィンドウの各系列の最新の版（既定の地域）から、そのつど組み立てる（提案資料を別の表に写さない）。
// D1 の上限: 作品IDを値として並べない（組織で読んでから権限で絞る）。登録は3文（照合・版・監査）で、1文の値は20個まで。
import {isDbConflict, isGuardViolation} from '../data-platform/db-errors.mjs';
import {integer} from '../csv.mjs';
import {encodeReportXlsx, specTable} from '../xlsx-report.mjs';
import {csvDocument} from '../report-output.mjs';
import {dateTimeJst} from '../ui/format.mjs';
import {sameTerritory} from './release-window-model.mjs';
import {flowOf, territoriesIntersect} from './partner-list-model.mjs';
import {
  PROPOSAL_BASES, STATUS_MODES, SHEET_NAME, CONDITION_SHEET, SVOD_SHEET, SVOD_TYPE_KEYS, SVOD_CATEGORIES, SVOD_COLUMNS,
  basisOf, isMonth, shiftMonth, monthText, selectProposalEntries, proposalMonthCounts, proposalColumns, proposalRow, emptyColumns, undatedText,
  svodProposal, svodSheetRows, SVOD_MAX_MONTHS,
} from './release-proposal-model.mjs';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const attachment = (name, ascii) => `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name).toWellFormed())}`;
const nowIso = () => new Date().toISOString();
const thisMonthJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 7);
const cleanName = (text) => String(text ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();

// 提案資料に出す作品情報の項目（キー・見出し・上限の文字数）。数と上限は proposal-profiles.sql の CHECK と同じ
export const PROFILE_FIELDS = Object.freeze([
  ['title_kana', 'フリガナ', 200], ['title_en', '英題', 300], ['genre', 'ジャンル', 100], ['copyright_notice', 'コピーライト', 300],
  ['caution', '注意事項', 2000], ['intro_short', 'イントロダクション（短）', 1000], ['intro_long', 'イントロダクション（長）', 4000],
  ['info_url', '作品情報URL', 1000], ['image_url', '画像のURL', 1000], ['image_key', '保存済みの画像のキー', 300], ['image_file_name', '画像のファイル名', 240],
]);

// 入力 → 保存する値。{value} か {error}。空欄は null（前の版の値は持ち越さない。画面は今の版を下書きにする）
export function normalizeProfileInput(input = {}) {
  const value = {};
  for (const [key, label, max] of PROFILE_FIELDS) {
    const raw = input[key];
    if (raw !== null && raw !== undefined && typeof raw !== 'string') return {error: `${label}は文字で入れてください`};
    const text = String(raw ?? '').normalize('NFC').trim();
    if (text.length > max) return {error: `${label}は${max}文字までです（${text.length}文字）`};
    value[key] = text || null;
  }
  for (const key of ['info_url', 'image_url']) {
    if (value[key] && (!/^https?:\/\/\S+$/.test(value[key]) || value[key].length < 10)) return {error: `${PROFILE_FIELDS.find((f) => f[0] === key)[1]}は http:// か https:// で始まるアドレスです`};
  }
  if (value.image_key && !/^[A-Za-z0-9/._-]+$/.test(value.image_key)) return {error: '保存済みの画像のキーは英数字と / . _ - だけです'};
  if (value.image_url && value.image_key) return {error: '画像は URL か保存済みのキーのどちらか1つにしてください'};
  if (value.image_file_name && !value.image_url && !value.image_key) return {error: '画像のファイル名は、画像の URL かキーと一緒に入れてください'};
  const source = String(input.source_reference ?? '').trim();
  if (!source || source.length > 1000) return {error: '出所・改訂理由（1000文字まで）を入れてください'};
  value.source_reference = source;
  return {value};
}

export function registerReleaseProposalRoutes(app, {db, bad, body, permittedProjects}) {
  const friendly = (error) => (isGuardViolation(error) || /stale/.test(error.message)
    ? '確かめた後に、別の人が同じ作品の作品情報を直しました。読み直してからもう一度登録してください' : error.message);
  const wrap = (fn) => async (c) => {
    try { return await fn(c); } catch (error) { return bad(c, friendly(error), isDbConflict(error) || /stale|immutable/i.test(error.message) ? 409 : 400, undefined, error); }
  };
  const denied = (c) => bad(c, '営業基幹は担当範囲外です', 403);

  // 見られる作品（案件の閲覧権限）と直せる作品（案件の編集権限）。制作担当は null（営業基幹は担当範囲外）
  async function scope(i, {allowProduction = false} = {}) {
    if (i.role === 'production' && !allowProduction) return null;
    const [view, edit] = await Promise.all([permittedProjects(db, i, false), i.role === 'production' ? [] : permittedProjects(db, i, true)]);
    const viewIds = new Set(view.map((p) => p.id)), editIds = new Set(edit.map((p) => p.id));
    const works = (await db.all('SELECT id,code,title,project_id FROM works WHERE org_id=? ORDER BY code,id', [i.org_id])).filter((w) => viewIds.has(w.project_id));
    return {works, visible: new Set(works.map((w) => w.id)), editable: new Set(works.filter((w) => editIds.has(w.project_id)).map((w) => w.id))};
  }

  // 種別の最新の版（項目つき）。type_key → 種別
  async function loadTypes(orgId) {
    const [versions, fields] = await Promise.all([
      db.all(`SELECT t.id,t.type_key,v.version_no,v.label,v.family,v.date_mode,v.start_label,v.end_label,v.default_territory,v.sort_order,v.active
        FROM release_window_types t JOIN release_window_type_versions v ON v.org_id=t.org_id AND v.type_id=t.id
        WHERE t.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM release_window_type_versions x WHERE x.org_id=t.org_id AND x.type_id=t.id) ORDER BY v.sort_order,t.id`, [orgId]),
      db.all(`SELECT f.type_id,f.field_key,f.label,f.value_type,f.choice_domain,f.sort_order FROM release_window_type_fields f
        WHERE f.org_id=? AND f.version_no=(SELECT MAX(x.version_no) FROM release_window_type_versions x WHERE x.org_id=f.org_id AND x.type_id=f.type_id) ORDER BY f.sort_order,f.field_key`, [orgId]),
    ]);
    return new Map(versions.map((v) => [v.type_key, {...v, active: Number(v.active) === 1, fields: fields.filter((f) => f.type_id === v.id).map(({type_id, ...f}) => f)}]));
  }

  // 作品ごとのウィンドウ（既定の地域の系列の最新の版・項目の値つき）。workId → Map(type_key → 版)
  async function loadWindows(orgId, types, visible) {
    const [rows, values] = await Promise.all([
      db.all(`SELECT w.id AS window_id,w.work_id,w.type_id,w.territory,v.version_no,v.start_on,v.end_on,v.announce_on,v.date_precision,v.timing_raw,v.status
        FROM work_release_windows w JOIN work_release_window_versions v ON v.org_id=w.org_id AND v.window_id=w.id
          AND v.version_no=(SELECT MAX(x.version_no) FROM work_release_window_versions x WHERE x.org_id=w.org_id AND x.window_id=w.id)
        WHERE w.org_id=? ORDER BY w.id`, [orgId]),
      db.all(`SELECT f.window_id,f.field_key,f.value_text,f.value_number FROM work_release_window_field_values f
        WHERE f.org_id=? AND f.version_no=(SELECT MAX(x.version_no) FROM work_release_window_versions x WHERE x.org_id=f.org_id AND x.window_id=f.window_id)`, [orgId]),
    ]);
    const fieldsOf = new Map();
    for (const value of values) {
      if (!fieldsOf.has(value.window_id)) fieldsOf.set(value.window_id, {});
      fieldsOf.get(value.window_id)[value.field_key] = {t: value.value_text ?? null, n: value.value_number ?? null};
    }
    const typeById = new Map([...types.values()].map((type) => [type.id, type]));
    const byWork = new Map();
    for (const row of rows) {
      const type = typeById.get(row.type_id);
      if (!type || !visible.has(row.work_id)) continue;
      // 既定の地域の系列（同じ文字 → 名寄せで同じ地域）。同じ文字の系列を先にする
      const exact = row.territory === type.default_territory;
      if (!exact && !sameTerritory(row.territory, type.default_territory)) continue;
      if (!byWork.has(row.work_id)) byWork.set(row.work_id, new Map());
      const map = byWork.get(row.work_id);
      const current = map.get(type.type_key);
      if (current && (current.territory === type.default_territory || !exact)) continue;
      map.set(type.type_key, {...row, fields: fieldsOf.get(row.window_id) || {}});
    }
    return byWork;
  }

  // 作品カタログの最新の版（クレジット・映像版・映像版の国と言語つき）。workId → カタログ
  async function loadCatalog(orgId) {
    const latest = (alias) => `${alias}.revision=(SELECT MAX(x.revision) FROM catalog_profiles x WHERE x.org_id=${alias}.org_id AND x.work_id=${alias}.work_id)`;
    const [profiles, credits, editions, tags] = await Promise.all([
      db.all(`SELECT p.work_id,p.revision,p.synopsis_long,p.synopsis_short,p.catch_long,p.catch_short,p.production_year FROM catalog_profiles p WHERE p.org_id=? AND ${latest('p')}`, [orgId]),
      db.all(`SELECT c.work_id,c.position,c.role,c.name,c.detail FROM catalog_credits c WHERE c.org_id=? AND ${latest('c')} ORDER BY c.work_id,c.position`, [orgId]),
      db.all(`SELECT e.work_id,e.edition_key,e.name,e.runtime_seconds,e.rating_authority,e.rating_code FROM catalog_editions e WHERE e.org_id=? AND ${latest('e')}`, [orgId]),
      db.all(`SELECT t.work_id,t.edition_key,t.kind,t.value FROM catalog_edition_tags t WHERE t.org_id=? AND ${latest('t')} ORDER BY t.work_id,t.edition_key,t.kind,t.value`, [orgId]),
    ]);
    const out = new Map(profiles.map((p) => [p.work_id, {...p, credits: [], editions: []}]));
    for (const credit of credits) out.get(credit.work_id)?.credits.push(credit);
    for (const edition of editions) {
      const own = tags.filter((t) => t.work_id === edition.work_id && t.edition_key === edition.edition_key);
      out.get(edition.work_id)?.editions.push({...edition, country: own.filter((t) => t.kind === 'country').map((t) => t.value), language: own.filter((t) => t.kind === 'language').map((t) => t.value)});
    }
    return out;
  }

  async function loadProfiles(orgId) {
    const rows = await db.all(`SELECT d.* FROM work_proposal_profiles d WHERE d.org_id=?
      AND d.revision=(SELECT MAX(x.revision) FROM work_proposal_profiles x WHERE x.org_id=d.org_id AND x.work_id=d.work_id)`, [orgId]);
    return new Map(rows.map((row) => [row.work_id, row]));
  }

  // 権利範囲（置き換えられていない調達ケースの範囲）。workId → [範囲]
  async function loadScopes(orgId) {
    const rows = await db.all(`SELECT c.work_id,s.channel,s.territory,s.rights_start,s.rights_end,s.exclusivity FROM rights_intake_scopes s
      JOIN rights_intake_cases c ON c.org_id=s.org_id AND c.id=s.intake_case_id
      WHERE s.org_id=? AND NOT EXISTS(SELECT 1 FROM rights_intake_cases n WHERE n.org_id=c.org_id AND n.source_case_id=c.id) ORDER BY s.id`, [orgId]);
    const map = new Map();
    for (const row of rows) { if (!map.has(row.work_id)) map.set(row.work_id, []); map.get(row.work_id).push(row); }
    return map;
  }

  async function statusModeOf(c) {
    const value = c.req.query('status') || 'all';
    if (!Object.hasOwn(STATUS_MODES, value)) throw Error('状態の条件は all（予定＋確定）か confirmed（確定だけ）です');
    return value;
  }

  // ---- 月別 --------------------------------------------------------------------------------
  async function monthlyContext(i) {
    const access = await scope(i);
    if (!access) return null;
    const types = await loadTypes(i.org_id);
    const windows = await loadWindows(i.org_id, types, access.visible);
    return {access, types, windows, windowsOf: (workId) => windows.get(workId) || new Map()};
  }
  const available = (basis, types) => basis.typeKeys.some((key) => types.get(key)?.active !== false && types.has(key));

  app.get('/api/release-proposals', wrap(async (c) => {
    const i = c.get('identity');
    const ctx = await monthlyContext(i);
    if (!ctx) return denied(c);
    const statusMode = await statusModeOf(c);
    const thisMonth = thisMonthJst();
    const bases = PROPOSAL_BASES.map((basis) => {
      const months = proposalMonthCounts(basis, {statusMode, works: ctx.access.works, windowsOf: ctx.windowsOf});
      return {key: basis.key, label: basis.label, typeLabels: basis.typeKeys.map((key) => ctx.types.get(key)?.label || key), available: available(basis, ctx.types),
        months, total: months.reduce((n, m) => n + m.count, 0)};
    });
    return c.json({ok: true, bases, statusModes: STATUS_MODES, statusMode, thisMonth, defaultMonth: shiftMonth(thisMonth, 1), needsAdoption: ctx.types.size === 0, worksVisible: ctx.access.works.length});
  }));

  async function monthlyReport(i, c) {
    const basis = basisOf(c.req.param('basis'));
    if (!basis) return {status: 404, error: '提案資料の基準がありません（pvod・tvod・tvod_early・est_early・est のどれか）'};
    const month = c.req.query('month') || shiftMonth(thisMonthJst(), 1);
    if (!isMonth(month)) return {status: 400, error: '対象月は 2026-10 の形で指定してください'};
    const statusMode = await statusModeOf(c);
    const ctx = await monthlyContext(i);
    if (!ctx) return {status: 403, error: '営業基幹は担当範囲外です'};
    if (!ctx.types.size) return {status: 409, error: 'ウィンドウの種別がまだありません（管理者が全作品のウィンドウで初期の種別を採用してください）'};
    const [catalog, profiles, scopes] = await Promise.all([loadCatalog(i.org_id), loadProfiles(i.org_id), loadScopes(i.org_id)]);
    const selected = selectProposalEntries(basis, {month, statusMode, works: ctx.access.works, windowsOf: ctx.windowsOf, types: ctx.types});
    const columns = proposalColumns(basis, ctx.types);
    const rows = selected.rows.map((entry) => proposalRow(entry, columns, {windows: ctx.windowsOf(entry.work.id), types: ctx.types,
      catalog: catalog.get(entry.work.id) || null, profile: profiles.get(entry.work.id) || null, scopes: scopes.get(entry.work.id) || []}, statusMode));
    const empty = emptyColumns(columns, rows);
    const undated = selected.undated.map((entry) => ({work_code: entry.work.code, work_title: entry.work.title, type_label: ctx.types.get(entry.typeKey)?.label || entry.typeKey,
      text: undatedText(entry, ctx.types)}));
    return {basis, month, statusMode, columns, rows, empty, undated, types: ctx.types, dataAsOf: nowIso(), fileBase: `提案資料_${basis.label}_${month}`};
  }

  app.get('/api/release-proposals/:basis', wrap(async (c) => {
    const report = await monthlyReport(c.get('identity'), c);
    if (report.error) return bad(c, report.error, report.status);
    const {basis, month, statusMode, columns, rows, empty, undated, dataAsOf, fileBase} = report;
    return c.json({ok: true, basis: {key: basis.key, label: basis.label}, month, monthText: monthText(month), statusMode, statusText: STATUS_MODES[statusMode],
      columns: columns.map(({field, ...column}) => column), rows, count: rows.length, emptyColumns: empty.map((column) => column.label), undated, dataAsOf, fileName: `${fileBase}.xlsx`});
  }));

  function monthlyConditionRows(report) {
    const {basis, month, statusMode, columns, rows, empty, undated, types, dataAsOf} = report;
    return [
      {item: '資料', value: `${basis.label}の提案資料`},
      {item: '基準のウィンドウ', value: basis.typeKeys.map((key) => types.get(key)?.label || key).join('・')},
      {item: '対象月', value: `${monthText(month)}（${month}）`},
      {item: '状態の条件', value: `${STATUS_MODES[statusMode]}（取り下げは除く。基準のウィンドウで行を選び、ほかのウィンドウの列にも同じ条件を当てる。確定だけのとき予定のウィンドウは空欄、予定＋確定のとき予定のウィンドウは備考に書く）`},
      {item: '対象の決め方', value: '全作品のウィンドウで、基準のウィンドウ（既定の地域の系列の最新の版）の解禁日が対象月にあるもの。年まで・時期の原文のウィンドウは表に入れず、下の「月が決まっていない候補」に出す（時期の原文は、原文から読める月の幅の各月と、最も早い月の年から原文に書かれた最も遅い年までの各月の資料に出す。「2026年度」「2026年度下期」「2026年度末」「2026年度第4四半期」「2026年12月〜3月」「2026年冬」は翌年の月にも出る）。未定のウィンドウは入れない'},
      {item: '並び', value: '解禁日（日付 → 月までのもの）→ 作品コード → ウィンドウ'},
      {item: '件数', value: `${rows.length}件`},
      {item: '列の数', value: `${columns.length}列`},
      {item: '空の列の数', value: `${empty.length}列（データが無い列も空欄のまま出す。推測で埋めない）`},
      {item: '空の列', value: empty.map((column) => column.label).join('、') || 'なし'},
      {item: '月が決まっていない候補の数', value: `${undated.length}件`},
      ...undated.map((entry) => ({item: '月が決まっていない候補', value: entry.text})),
      {item: 'データ時点', value: `${dateTimeJst(dataAsOf)}（日本時間）`},
      {item: '見られる範囲', value: '閲覧できる作品だけ（全作品のウィンドウと同じ）'},
    ];
  }

  const metaSheet = (rows) => ({name: '_meta', hidden: true, titleBand: false, freezeCols: 0, columns: [{key: 'k', label: '項目', type: 'text'}, {key: 'v', label: '値', type: 'text'}], rows});
  const conditionSheet = (rows) => ({name: CONDITION_SHEET, titleBand: false, freezeCols: 0, columns: [{key: 'item', label: '項目', type: 'text', width: 26}, {key: 'value', label: '内容', type: 'text', wrap: true, width: 90}], rows});
  const excelColumns = (columns) => columns.map(({key, label, type, wrap}) => ({key, label, type, ...(wrap ? {wrap: true, width: 40} : {})}));

  app.get('/api/release-proposals/:basis/export.xlsx', wrap(async (c) => {
    const i = c.get('identity');
    const report = await monthlyReport(i, c);
    if (report.error) return bad(c, report.error, report.status);
    const sheets = [
      {name: SHEET_NAME, titleBand: false, freezeCols: 0, columns: excelColumns(report.columns), rows: report.rows},
      conditionSheet(monthlyConditionRows(report)),
      metaSheet([{k: 'kind', v: 'release-proposal'}, {k: 'basis', v: report.basis.key}, {k: 'month', v: report.month}, {k: 'status', v: report.statusMode},
        {k: 'org', v: String(i.org_id)}, {k: 'rows', v: String(report.rows.length)}, {k: 'empty_columns', v: String(report.empty.length)}, {k: 'generated_at', v: report.dataAsOf}]),
    ];
    return new Response(encodeReportXlsx({sheets}), {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(`${cleanName(report.fileBase)}.xlsx`, `proposals-${report.basis.key}-${report.month}.xlsx`)}});
  }));

  app.get('/api/release-proposals/:basis/export.csv', wrap(async (c) => {
    const report = await monthlyReport(c.get('identity'), c);
    if (report.error) return bad(c, report.error, report.status);
    const table = specTable({columns: excelColumns(report.columns), rows: report.rows}, {mode: 'raw'});
    return new Response(csvDocument([table.header, ...table.rows]), {headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': attachment(`${cleanName(report.fileBase)}.csv`, `proposals-${report.basis.key}-${report.month}.csv`)}});
  }));

  // ---- SVOD --------------------------------------------------------------------------------
  async function svodReport(i, c) {
    const ctx = await monthlyContext(i);
    if (!ctx) return {status: 403, error: '営業基幹は担当範囲外です'};
    const statusMode = await statusModeOf(c);
    const from = c.req.query('from') || shiftMonth(thisMonthJst(), 1);
    const to = c.req.query('to') || shiftMonth(from, 11);
    if (!isMonth(from) || !isMonth(to)) return {status: 400, error: '提案期間は 2026-10 の形の開始月と終了月で指定してください'};
    if (to < from) return {status: 400, error: '提案期間の終了月が開始月より前です'};
    if (shiftMonth(from, SVOD_MAX_MONTHS - 1) < to) return {status: 400, error: `提案期間は${SVOD_MAX_MONTHS}か月までです`};
    const partners = await db.all('SELECT id,code,name,kind FROM partners WHERE org_id=? ORDER BY code,id', [i.org_id]);
    // 自社（会社の設定の自社を表す取引先）は提案先の選択肢に出さない
    const self = await db.get('SELECT self_partner_id FROM org_profile_versions WHERE org_id=? ORDER BY version_no DESC LIMIT 1', [i.org_id]).catch(() => null);
    const selfPartnerId = self?.self_partner_id ?? null;
    const codes = new Map((await db.all(`SELECT t.code,t.family,t.utilization,t.label,m.distribution_name,m.transaction_method,m.sales_type
      FROM distribution_types t LEFT JOIN distribution_master m ON m.code=t.code`)).map((row) => [row.code, row]));
    const entries = await db.all(`SELECT e.id AS entry_id,e.renews_entry_id,e.work_id,l.partner_id,p.name AS partner_name,p.code AS partner_code,v.distribution_code,v.territory,v.contract_start,v.contract_end,v.end_rule,
        v.exclusivity,v.status,v.settlement_method,v.amount_ex_tax
      FROM partner_list_entries e JOIN partner_lists l ON l.org_id=e.org_id AND l.id=e.list_id JOIN partners p ON p.org_id=l.org_id AND p.id=l.partner_id
      JOIN partner_list_entry_versions v ON v.org_id=e.org_id AND v.entry_id=e.id AND v.version_no=(SELECT MAX(x.version_no) FROM partner_list_entry_versions x WHERE x.org_id=e.org_id AND x.entry_id=e.id)
      WHERE e.org_id=? ORDER BY e.id`, [i.org_id]);
    // SVOD（流通マスタの販売種別が SVOD・旧区分 svod）で、地域が日本と重なる明細
    const contracts = entries.filter((entry) => ctx.access.visible.has(entry.work_id) && territoriesIntersect(entry.territory, '日本')).filter((entry) => {
      const flow = flowOf(codes.get(entry.distribution_code) || {}, entry.territory);
      return flow.group === 'digital' && flow.sub === 'SVOD';
    });
    const svodCount = new Map();
    for (const contract of contracts) if (contract.status !== 'withdrawn') svodCount.set(contract.partner_id, (svodCount.get(contract.partner_id) || 0) + 1);
    // 提案先: partnerId を省くと SVOD の明細が最も多い取引先（同数はコードの順）、空欄か none は「指定なし」
    const partnerText = c.req.query('partnerId');
    let partnerId = null;
    if (partnerText === undefined) {
      const ranked = partners.filter((p) => svodCount.get(p.id)).sort((a, b) => svodCount.get(b.id) - svodCount.get(a.id) || (a.code < b.code ? -1 : 1));
      partnerId = ranked[0]?.id ?? null;
    } else if (partnerText !== '' && partnerText !== 'none') partnerId = integer(partnerText);
    const partner = partnerId === null ? null : partners.find((p) => p.id === partnerId);
    if (partnerId !== null && !partner) return {status: 404, error: '提案先の取引先がありません'};
    const scopes = await loadScopes(i.org_id);
    const svodWindowsOf = (workId) => SVOD_TYPE_KEYS.map((key) => ({typeKey: key, typeLabel: ctx.types.get(key)?.label || key, version: ctx.windowsOf(workId).get(key)})).filter((item) => item.version);
    const result = svodProposal({partnerId, from, to, statusMode, works: ctx.access.works, svodWindowsOf, contracts, rightsOf: (workId) => scopes.get(workId) || []});
    // 提案先の選択肢: SVOD の明細が多い順（1件以上が先）→ 配信の取引先 → そのほか（どれもコードの順）。自社は出さない（いま選んでいる取引先は残す）
    const groupOf = (p) => (svodCount.get(p.id) ? 'svod' : p.kind === 'platform' ? 'platform' : 'other');
    const groupOrder = {svod: 0, platform: 1, other: 2};
    const partnerOptions = partners.filter((p) => p.id !== selfPartnerId || p.id === partnerId)
      .map((p) => ({...p, svodContracts: svodCount.get(p.id) || 0, group: groupOf(p)}))
      .sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || b.svodContracts - a.svodContracts || (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id - b.id));
    return {partner, partnerId, partners: partnerOptions, from, to, statusMode, result, dataAsOf: nowIso(),
      fileBase: `提案資料_SVOD_${partner ? partner.code : '提案先指定なし'}_${from}〜${to}`};
  }

  app.get('/api/svod-proposals', wrap(async (c) => {
    const report = await svodReport(c.get('identity'), c);
    if (report.error) return bad(c, report.error, report.status);
    const {partner, partners, from, to, statusMode, result, dataAsOf, fileBase} = report;
    return c.json({ok: true, partner, partners, from, to, statusMode, statusText: STATUS_MODES[statusMode], period: result.period, rows: result.rows, subtotals: result.subtotals, total: result.total,
      categories: SVOD_CATEGORIES, columns: SVOD_COLUMNS, dataAsOf, fileName: `${fileBase}.xlsx`});
  }));

  function svodConditionRows(report) {
    const {partner, from, to, statusMode, result, dataAsOf} = report;
    const money = (n) => `${Number(n).toLocaleString('ja-JP')}円`;
    return [
      {item: '資料', value: 'SVOD の提案資料'},
      {item: '提案先', value: partner ? `${partner.code} ${partner.name}` : '指定なし（継続は出さず、新規は SVOD のウィンドウだけで決める）'},
      {item: '提案期間', value: `${monthText(from)}〜${monthText(to)}（${result.period.months}か月）`},
      {item: '状態の条件', value: `SVOD のウィンドウは ${STATUS_MODES[statusMode]}（取り下げは除く）`},
      {item: '継続', value: '作品ごとに、提案先との SVOD の明細のうち最も遅く終わるものが、契約済み・日付で終わり・期間の中に終わり、再契約元として指されていないもの（終了日の翌日以降に続く明細・再契約があれば出さない）。提案は終了日の翌日から'},
      {item: '新規', value: 'SVOD先行・SVOD通常のウィンドウが期間と重なり、提案先との SVOD の明細（予定・契約済み）が期間と重ならないもの'},
      {item: '注意', value: '継続・新規のうち、他の取引先の独占の契約が提案の期間と重なるもの、または期間の前に権利が切れているもの（除かずに印を付ける。権利が切れている行は月数0・金額は空欄）'},
      {item: '提案のウィンドウ', value: '提案の期間と重なる SVOD のウィンドウのうち、SVOD通常 → SVOD先行 の順で1つ。提案の開始・終了はそのウィンドウの解禁日・配信期限で狭め、配信・日本の権利範囲（終了日がすべてある時は最も遅い終了日、開始日がすべてある時は最も早い開始日）でも狭める。年まで・時期の原文のウィンドウは最も早い日（1月1日・最も早い月の1日）から数え、備考に書く。月の無い時期のウィンドウは対象にしない'},
      {item: '提案金額', value: '月額単価（提案のウィンドウの価格・税抜）× 月数（提案の開始月〜終了月。月の途中から始まる月も1か月と数える）。単価が無い行は空欄'},
      ...Object.entries(SVOD_CATEGORIES).map(([key, label]) => ({item: `件数と提案金額（${label}）`, value: `${result.subtotals[key].count}件・提案金額 ${money(result.subtotals[key].amount)}（単価のある行 ${result.subtotals[key].priced}件）`})),
      {item: '件数と提案金額（合計）', value: `${result.total.count}件・提案金額 ${money(result.total.amount)}`},
      {item: 'データ時点', value: `${dateTimeJst(dataAsOf)}（日本時間）`},
      {item: '見られる範囲', value: '閲覧できる作品だけ（全作品のウィンドウと同じ）'},
    ];
  }

  function svodSheets(i, report) {
    const {result} = report;
    return [
      {name: SVOD_SHEET, titleBand: false, freezeCols: 0, columns: SVOD_COLUMNS.map(({key, label, type, wrap}) => ({key, label, type, ...(wrap ? {wrap: true, width: 40} : {})})),
        rows: svodSheetRows(result), totals: [{label: `合計（${result.total.count}件）`, values: {months: result.total.months, amount: result.total.amount}}]},
      conditionSheet(svodConditionRows(report)),
      metaSheet([{k: 'kind', v: 'svod-proposal'}, {k: 'partner', v: report.partner ? report.partner.code : ''}, {k: 'from', v: report.from}, {k: 'to', v: report.to},
        {k: 'status', v: report.statusMode}, {k: 'org', v: String(i.org_id)}, {k: 'rows', v: String(result.rows.length)}, {k: 'amount', v: String(result.total.amount)}, {k: 'generated_at', v: report.dataAsOf}]),
    ];
  }

  app.get('/api/svod-proposals/export.xlsx', wrap(async (c) => {
    const i = c.get('identity');
    const report = await svodReport(i, c);
    if (report.error) return bad(c, report.error, report.status);
    return new Response(encodeReportXlsx({sheets: svodSheets(i, report)}), {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(`${cleanName(report.fileBase)}.xlsx`, `proposals-svod-${report.from}-${report.to}.xlsx`)}});
  }));

  app.get('/api/svod-proposals/export.csv', wrap(async (c) => {
    const i = c.get('identity');
    const report = await svodReport(i, c);
    if (report.error) return bad(c, report.error, report.status);
    const [sheet] = svodSheets(i, report);
    const table = specTable(sheet, {mode: 'raw'});
    return new Response(csvDocument([table.header, ...table.rows]), {headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': attachment(`${cleanName(report.fileBase)}.csv`, `proposals-svod-${report.from}-${report.to}.csv`)}});
  }));

  // ---- 提案資料に出す作品情報 ------------------------------------------------------------------------
  // 見るのは作品・商品マスタと同じ（制作担当も案件の閲覧権限がある作品は見られる）。直すのは案件の編集権限がある人（制作担当は直せない）
  app.get('/api/work-proposal-profiles/:workId{[0-9]+}', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i, {allowProduction: true});
    const workId = integer(c.req.param('workId'));
    const work = access.works.find((w) => w.id === workId);
    if (!work) return bad(c, '作品への権限がありません', 403);
    const versions = await db.all(`SELECT d.revision,d.source_reference,d.created_at,u.display_name AS created_by_name FROM work_proposal_profiles d LEFT JOIN users u ON u.id=d.created_by
      WHERE d.org_id=? AND d.work_id=? ORDER BY d.revision DESC`, [i.org_id, workId]);
    const revisionText = c.req.query('revision');
    const revision = revisionText ? integer(revisionText) : versions[0]?.revision || null;
    const profile = revision ? await db.get('SELECT * FROM work_proposal_profiles WHERE org_id=? AND work_id=? AND revision=?', [i.org_id, workId, revision]) : null;
    if (revisionText && !profile) return bad(c, 'その版はありません', 404);
    return c.json({ok: true, work: {id: work.id, code: work.code, title: work.title}, profile, versions, canEdit: access.editable.has(workId), fields: PROFILE_FIELDS.map(([key, label, max]) => ({key, label, max}))});
  }));

  app.post('/api/work-proposal-profiles/:workId{[0-9]+}', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, '提案資料の作品情報は制作担当では直せません', 403);
    const access = await scope(i);
    const workId = integer(c.req.param('workId'));
    if (!access.editable.has(workId)) return bad(c, '作品の編集権限がありません', 403);
    const b = await body(c);
    const base = integer(b.baseRevision ?? '');
    const normalized = normalizeProfileInput(b);
    if (normalized.error) return bad(c, normalized.error, 400);
    const v = normalized.value, next = base + 1;
    const current = await db.get('SELECT COALESCE(MAX(revision),0) AS n FROM work_proposal_profiles WHERE org_id=? AND work_id=?', [i.org_id, workId]);
    if (Number(current.n) !== base) return bad(c, `作品情報が更新されています（いまは第${current.n}版）。読み直してから直してください`, 409);
    await db.batch([
      {sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE ?<>(SELECT COALESCE(MAX(revision),0) FROM work_proposal_profiles WHERE org_id=? AND work_id=?)', params: [base, i.org_id, workId]},
      {sql: `INSERT INTO work_proposal_profiles(org_id,work_id,revision,title_kana,title_en,genre,copyright_notice,caution,intro_short,intro_long,info_url,image_url,image_key,image_file_name,source_reference,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [i.org_id, workId, next, v.title_kana, v.title_en, v.genre, v.copyright_notice, v.caution, v.intro_short, v.intro_long,
        v.info_url, v.image_url, v.image_key, v.image_file_name, v.source_reference, i.user_id]},
      {sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', params: [i.org_id, i.user_id, base ? 'version' : 'create', 'work_proposal_profile', String(workId),
        JSON.stringify({revision: next, source: v.source_reference, filled: PROFILE_FIELDS.map(([key]) => key).filter((key) => v[key])})]},
    ]);
    return c.json({ok: true, revision: next}, 201);
  }));
}
