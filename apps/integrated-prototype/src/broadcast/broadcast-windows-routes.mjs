// 番販・放送の放送履歴表・放送アベイルズリスト・商品別の放送ウィンドウ提案と、放送の項目（局の種別・許諾回数・ホールドバック）の API。
// 設計: docs/platform/team-development/broadcast-windows.md。
// - 放送履歴表: GET /api/broadcast/history（条件つき・120作品で打ち切り）、GET /api/broadcast/history/export.xlsx（打ち切らない）
// - 放送アベイルズリスト: POST /api/broadcast/availability-list/match（作品名の照合）、GET /api/broadcast/availability-list/export.xlsx
//   （今ある /api/broadcast/avails は「販売条件の一覧」で別物。名前を分ける）
// - 放送ウィンドウ提案: GET /api/broadcast/window-proposals（読み取りだけ）、GET …/export.xlsx
// - 提案から放送枠の下書きを作る: POST /api/broadcast/window-proposals/drafts（放送枠の登録の経路 broadcastSlotStore で下書きを作り、どの提案から作ったかを残す）、
//   GET …/drafts（提案から作った下書きの一覧と削除したもの）、POST …/drafts/:slotId/delete（下書きのうちだけ「削除（合意に至らず）」。理由必須・監査記録）
// - 放送局の種別: GET/POST /api/broadcast/station-types。明細ごとの許諾回数・ホールドバック: GET /api/broadcast/entry-terms、
//   GET/POST /api/partner-list-entries/:entryId/broadcast-terms（版で積む・理由必須・監査記録）
// 見られるのは制作担当以外で、案件の閲覧権限がある作品。直せるのは案件の編集権限がある作品の明細（局の種別は制作担当以外）。
// D1 の上限: 作品IDを値として並べない（組織で読んでから権限で絞る）。1文の値は数個だけ。
import {isDbConflict, isGuardViolation, isUniqueViolation} from '../data-platform/db-errors.mjs';
import {integer} from '../csv.mjs';
import {encodeReportXlsx} from '../xlsx-report.mjs';
import {partnerRoles, broadcastSlotStore, NOT_DELETED_SLOT} from '../broadcast.mjs';
import {isLiveSlot, stationKey} from './slot-duplicates.mjs';
import {stationPartner} from './broadcast-sheet.mjs';
import {checkDraftMonths, draftSourceReference, draftReason, draftBasisText, monthBlockReason, DRAFT_RUN_KINDS, DELETED_LABEL} from './proposal-draft-model.mjs';
import {labelOf} from '../ui/labels.mjs';
import {todayJst} from '../sales-ops/partner-list-model.mjs';
import {buildHistoryMatrix, historySheets, normalizeHistoryQuery, HISTORY_ROW_LIMIT, todayYmJst} from './broadcast-history-model.mjs';
import {proposeWindow, proposalRow, proposalSummary, recentStations, PROPOSAL_COLUMNS, STATION_TYPES, PROPOSAL_HORIZON_MONTHS, PROPOSAL_MIN_MONTHS} from './window-proposal-model.mjs';
import {splitTitleLines, availsMatchResult, normalizeWorkIds, availsRow, availsSheet, availsFileName} from './avails-list-model.mjs';
import {isIsoDate, ymText} from './intervals.mjs';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// 名前に孤立したサロゲート（題名を途中で切ったときなど）があっても、encodeURIComponent が投げないようにそろえる
const attachment = (name, ascii) => `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name).toWellFormed())}`;
const stamp = () => todayJst().replaceAll('-', '');
const DENIED = '番販・放送は担当範囲外です';
// 同時の操作で負けた側の文言（操作ごと。先頭の版の照合が先に落ちるので、route の側で決める）
const DRAFT_DELETE_CONFLICT = '確かめた後に、別の人がこの下書きを直したか、売上を紐付けたか、削除しました。読み直してください';
const DRAFT_CREATE_CONFLICT = '確かめた後に、別の人が同じ作品の放送枠を登録・更新しました。読み直してからもう一度提案してください';
const SALES_LINKED = '放送報告の売上が紐付いている放送枠は削除できません。放送枠のタブで中止してください（売上突合に「中止枠に売上あり」で残ります）';
const isDeleteRace = (error) => isGuardViolation(error) || isUniqueViolation(error, 'broadcast_proposal_draft_deletions') || /broadcast proposal draft deletion needs a cancelled draft|broadcast slot deleted as a proposal draft/.test(error.message);
const isCreateRace = (error) => isGuardViolation(error) || isUniqueViolation(error, 'broadcast_slots') || /broadcast proposal draft needs a new draft slot/.test(error.message);
const text = (value, max, required = false) => {
  if (value !== null && value !== undefined && typeof value !== 'string') throw Error('文字を入力してください');
  const v = String(value ?? '').trim();
  if (v.length > max || (required && !v)) throw Error(required ? '理由を入れてください' : `${max}文字までです`);
  return v || null;
};
const optionalInt = (value, min, max, label) => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).normalize('NFKC').trim());
  if (!Number.isInteger(n) || n < min || n > max) throw Error(`${label}は${min}〜${max}の整数で入れてください（空欄は未確認）`);
  return n;
};

export function registerBroadcastWindowRoutes(app, {db, bad, body, permittedProjects}) {
  const friendly = (error) => (isGuardViolation(error) || /stale broadcast/.test(error.message)
    ? '確かめた後に、別の人が同じ項目を直しました。読み直してからもう一度登録してください'
    : /broadcast entry terms need a broadcast entry/.test(error.message) ? '放送の条件は、流通が放送の明細にだけ付けられます'
      : isUniqueViolation(error, 'broadcast_slots') || /broadcast proposal draft needs a new draft slot/.test(error.message) ? DRAFT_CREATE_CONFLICT
        : isUniqueViolation(error, 'broadcast_proposal_draft_deletions') || /broadcast proposal draft deletion needs a cancelled draft|broadcast slot deleted as a proposal draft/.test(error.message)
          ? DRAFT_DELETE_CONFLICT : error.message);
  const wrap = (fn) => async (c) => {
    try { return await fn(c); } catch (error) { return bad(c, friendly(error), isDbConflict(error) || /stale|immutable|mismatch|need a broadcast|proposal draft/i.test(error.message) ? 409 : 400, undefined, error); }
  };
  const slotStore = broadcastSlotStore(db);
  const audit = (i, action, entity, id, detail) => ({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)', params: [i.org_id, i.user_id, action, entity, String(id), JSON.stringify(detail)]});
  const guard = (sql, params) => ({sql: `INSERT INTO transaction_guards(value) SELECT 0 WHERE ${sql}`, params});

  async function scope(i) {
    if (i.role === 'production') return null;
    const [view, edit] = await Promise.all([permittedProjects(db, i, false), permittedProjects(db, i, true)]);
    const viewIds = new Set(view.map((p) => p.id)), editIds = new Set(edit.map((p) => p.id));
    const works = (await db.all('SELECT id,code,title,project_id FROM works WHERE org_id=? ORDER BY code,id', [i.org_id])).filter((w) => viewIds.has(w.project_id));
    return {works, visible: new Set(works.map((w) => w.id)), editable: new Set(works.filter((w) => editIds.has(w.project_id)).map((w) => w.id))};
  }

  // ---- 読み込み（組織で読んで、見られる作品で絞る） ------------------------------------------------
  // 放送枠の最新版。提案の下書きのうちに削除した枠は、履歴表・提案（同時期の他局・直近3局・初回／再放送）・アベイルズのどれにも使わない
  const latestSlotsSql = `SELECT v.* FROM broadcast_slot_versions v WHERE v.org_id=? AND v.revision=(SELECT MAX(z.revision) FROM broadcast_slot_versions z WHERE z.org_id=v.org_id AND z.slot_id=v.slot_id)${NOT_DELETED_SLOT}`;
  async function broadcastCodes() {
    const rows = await db.all(`SELECT t.code FROM distribution_types t LEFT JOIN distribution_master m ON m.code=t.code WHERE m.distribution_name='放送' OR t.family='broadcast'`);
    return new Set(rows.map((r) => r.code));
  }
  async function load(i, access, {catalog = false} = {}) {
    const orgId = i.org_id;
    const [slots, airings, products, windows, conditions, productWindows, confirmedConditions, confirmedProductWindows, rights, entries, terms, codes] = await Promise.all([
      db.all(latestSlotsSql, [orgId]),
      db.all('SELECT slot_id,work_id,aired_on,run_count FROM broadcast_airings WHERE org_id=?', [orgId]),
      db.all('SELECT p.id,p.sku,p.name,p.channel,pw.work_id FROM products p JOIN product_works pw ON pw.org_id=p.org_id AND pw.product_id=p.id WHERE p.org_id=? ORDER BY p.sku,p.id', [orgId]),
      db.all(`SELECT w.id AS window_id,w.work_id,w.territory,t.type_key,tv.family,tv.label AS type_label,v.version_no,v.start_on,v.end_on,v.date_precision,v.timing_raw,v.status
        FROM work_release_windows w JOIN release_window_types t ON t.org_id=w.org_id AND t.id=w.type_id
        JOIN release_window_type_versions tv ON tv.org_id=t.org_id AND tv.type_id=t.id AND tv.version_no=(SELECT MAX(x.version_no) FROM release_window_type_versions x WHERE x.org_id=t.org_id AND x.type_id=t.id)
        JOIN work_release_window_versions v ON v.org_id=w.org_id AND v.window_id=w.id AND v.version_no=(SELECT MAX(x.version_no) FROM work_release_window_versions x WHERE x.org_id=w.org_id AND x.window_id=w.id)
        WHERE w.org_id=?`, [orgId]),
      db.all(`SELECT v.work_id,v.distribution_code,v.territory,v.version_no,v.release_on,v.sales_end_on,v.exclusivity,v.status FROM sales_availability_versions v
        WHERE v.org_id=? AND v.version_no=(SELECT MAX(z.version_no) FROM sales_availability_versions z WHERE z.org_id=v.org_id AND z.work_id=v.work_id AND z.distribution_code=v.distribution_code AND z.territory=v.territory)`, [orgId]),
      db.all(`SELECT w.work_id,w.product_id,w.distribution_code,w.territory,w.window_key,w.revision,w.release_on,w.sales_end_on,w.status FROM catalog_product_windows w
        WHERE w.org_id=? AND w.revision=(SELECT MAX(z.revision) FROM catalog_product_windows z WHERE z.org_id=w.org_id AND z.work_id=w.work_id AND z.product_id=w.product_id AND z.distribution_code=w.distribution_code AND z.territory=w.territory AND z.window_key=w.window_key)`, [orgId]),
      // 系列ごとに直近の確認済みの版（最新の版が改訂中の下書きのとき、直前の確認済みの期間で計算するため）
      db.all(`SELECT v.work_id,v.distribution_code,v.territory,v.version_no,v.release_on,v.sales_end_on,v.exclusivity,v.status FROM sales_availability_versions v
        WHERE v.org_id=? AND v.status='confirmed' AND v.version_no=(SELECT MAX(z.version_no) FROM sales_availability_versions z WHERE z.org_id=v.org_id AND z.work_id=v.work_id AND z.distribution_code=v.distribution_code AND z.territory=v.territory AND z.status='confirmed')`, [orgId]),
      db.all(`SELECT w.work_id,w.product_id,w.distribution_code,w.territory,w.window_key,w.revision,w.release_on,w.sales_end_on,w.status FROM catalog_product_windows w
        WHERE w.org_id=? AND w.status='confirmed' AND w.revision=(SELECT MAX(z.revision) FROM catalog_product_windows z WHERE z.org_id=w.org_id AND z.work_id=w.work_id AND z.product_id=w.product_id AND z.distribution_code=w.distribution_code AND z.territory=w.territory AND z.window_key=w.window_key AND z.status='confirmed')`, [orgId]),
      db.all(`SELECT c.work_id,c.case_code,s.channel,s.territory,s.rights_start,s.rights_end,s.exclusivity FROM rights_intake_scopes s JOIN rights_intake_cases c ON c.org_id=s.org_id AND c.id=s.intake_case_id
        WHERE s.org_id=? AND NOT EXISTS(SELECT 1 FROM rights_intake_cases n WHERE n.org_id=c.org_id AND n.source_case_id=c.id)`, [orgId]),
      db.all(`SELECT e.id AS entry_id,e.work_id,l.id AS list_id,l.partner_id,p.code AS partner_code,p.name AS partner_name,v.version_no,v.distribution_code,v.territory,v.product_id,
          v.contract_start,v.contract_end,v.end_rule,v.exclusivity,v.status
        FROM partner_list_entries e JOIN partner_lists l ON l.org_id=e.org_id AND l.id=e.list_id JOIN partners p ON p.org_id=l.org_id AND p.id=l.partner_id
        JOIN partner_list_entry_versions v ON v.org_id=e.org_id AND v.entry_id=e.id AND v.version_no=(SELECT MAX(x.version_no) FROM partner_list_entry_versions x WHERE x.org_id=e.org_id AND x.entry_id=e.id)
        WHERE e.org_id=?`, [orgId]),
      db.all(`SELECT t.entry_id,t.version_no,t.licensed_runs,t.holdback_months,t.reason,t.created_at FROM broadcast_entry_term_versions t
        WHERE t.org_id=? AND t.version_no=(SELECT MAX(x.version_no) FROM broadcast_entry_term_versions x WHERE x.org_id=t.org_id AND x.entry_id=t.entry_id)`, [orgId]),
      broadcastCodes(),
    ]);
    const mine = (row) => access.visible.has(row.work_id);
    const out = {
      slots: slots.filter(mine), airings: airings.filter(mine), products: products.filter(mine), windows: windows.filter(mine),
      conditions: conditions.filter((c) => mine(c) && codes.has(c.distribution_code)),
      productWindows: productWindows.filter((w) => mine(w) && codes.has(w.distribution_code)),
      confirmedConditions: confirmedConditions.filter((c) => mine(c) && codes.has(c.distribution_code)),
      confirmedProductWindows: confirmedProductWindows.filter((w) => mine(w) && codes.has(w.distribution_code)),
      rights: rights.filter(mine), entries: entries.filter((e) => mine(e) && codes.has(e.distribution_code)),
      terms: new Map(terms.map((t) => [t.entry_id, t])),
    };
    if (catalog) {
      const [profiles, credits, editions, bindings, tags] = await Promise.all([
        db.all('SELECT p.* FROM catalog_profiles p WHERE p.org_id=? AND p.revision=(SELECT MAX(z.revision) FROM catalog_profiles z WHERE z.org_id=p.org_id AND z.work_id=p.work_id)', [orgId]),
        db.all('SELECT c.work_id,c.revision,c.position,c.role,c.name FROM catalog_credits c WHERE c.org_id=? AND c.revision=(SELECT MAX(z.revision) FROM catalog_profiles z WHERE z.org_id=c.org_id AND z.work_id=c.work_id) ORDER BY c.work_id,c.position', [orgId]),
        db.all('SELECT e.work_id,e.edition_key,e.runtime_seconds FROM catalog_editions e WHERE e.org_id=? AND e.revision=(SELECT MAX(z.revision) FROM catalog_profiles z WHERE z.org_id=e.org_id AND z.work_id=e.work_id) ORDER BY e.work_id,e.edition_key', [orgId]),
        db.all('SELECT b.work_id,b.product_id,b.edition_key FROM catalog_product_editions b WHERE b.org_id=? AND b.revision=(SELECT MAX(z.revision) FROM catalog_profiles z WHERE z.org_id=b.org_id AND z.work_id=b.work_id)', [orgId]),
        db.all("SELECT t.work_id,t.edition_key,t.value FROM catalog_edition_tags t WHERE t.org_id=? AND t.kind='language' AND t.revision=(SELECT MAX(z.revision) FROM catalog_profiles z WHERE z.org_id=t.org_id AND z.work_id=t.work_id) ORDER BY t.value", [orgId]),
      ]);
      // ジャンル・コピーライトは、提案資料に出す作品情報（移行 0005 の work_proposal_profiles）の最新の版。入っていない作品は空欄
      const extras = await db.all('SELECT p.work_id,p.genre,p.copyright_notice FROM work_proposal_profiles p WHERE p.org_id=? AND p.revision=(SELECT MAX(z.revision) FROM work_proposal_profiles z WHERE z.org_id=p.org_id AND z.work_id=p.work_id)', [orgId]);
      out.catalog = {profiles: new Map(profiles.map((p) => [p.work_id, p])), credits, editions, bindings, tags, extras: new Map(extras.map((e) => [e.work_id, e]))};
    }
    return out;
  }
  const byWork = (list, workId) => list.filter((row) => row.work_id === workId);
  const broadcastWindows = (data, workId) => data.windows.filter((w) => w.work_id === workId && w.family === 'broadcast');
  // 1つの作品・商品の提案の材料
  const proposalInput = (data, workId, product) => ({
    rights: byWork(data.rights, workId), releaseWindows: broadcastWindows(data, workId),
    conditions: byWork(data.conditions, workId), confirmedConditions: byWork(data.confirmedConditions, workId),
    productWindows: product ? data.productWindows.filter((w) => w.work_id === workId && w.product_id === product.id) : [],
    confirmedProductWindows: product ? data.confirmedProductWindows.filter((w) => w.work_id === workId && w.product_id === product.id) : [],
    entries: byWork(data.entries, workId), terms: data.terms, slots: byWork(data.slots, workId), airings: byWork(data.airings, workId),
  });
  // 提案の計算で例外が出た作品・商品は、その行だけ「要確認」にして、ほかの作品の行は返す（1件の明細で一覧全体を 400 にしない）
  const safePropose = (options) => {
    try { return proposeWindow(options); } catch (error) {
      const horizon = {from: options.asOf, to: null};
      return {state: 'blocked', horizon, allowed: [], basis: [], reasons: [`日付を計算できない明細がある（取引先別リストの契約終了日を確かめてください: ${error.message}）`],
        blocked: [], nonexclusive: [], proposals: [], recent: [], licenses: [], timeline: {from: options.asOf, to: options.asOf, lanes: []}};
    }
  };

  // ---- 放送履歴表 ---------------------------------------------------------------------------------
  async function history(c) {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return {denied: true};
    const normalized = normalizeHistoryQuery(c.req.query(), todayYmJst());
    if (normalized.error) throw Error(normalized.error);
    const data = await load(i, access);
    const windows = new Map();
    for (const w of data.windows.filter((w) => w.family === 'broadcast').sort((a, b) => (a.territory === '日本' ? -1 : 1) - (b.territory === '日本' ? -1 : 1))) if (!windows.has(w.work_id)) windows.set(w.work_id, w);
    const matrix = buildHistoryMatrix({works: access.works, slots: data.slots, airings: data.airings, products: data.products, windows, filters: normalized.value, limit: HISTORY_ROW_LIMIT});
    return {filters: normalized.value, matrix, data};
  }
  app.get('/api/broadcast/history', wrap(async (c) => {
    const out = await history(c);
    if (out.denied) return bad(c, DENIED, 403);
    const {matrix, filters} = out;
    return c.json({ok: true, filters, months: matrix.months, rows: matrix.rows, total: matrix.total, truncated: matrix.truncated, limit: HISTORY_ROW_LIMIT, stations: matrix.stations, counts: matrix.counts});
  }));
  app.get('/api/broadcast/history/export.xlsx', wrap(async (c) => {
    const out = await history(c);
    if (out.denied) return bad(c, DENIED, 403);
    const {matrix, filters, data} = out;
    const i = c.get('identity');
    const partners = await db.all('SELECT id,name FROM partners WHERE org_id=?', [i.org_id]);
    const conditions = [['期間', `${ymText(filters.from)}〜${ymText(filters.to)}`], filters.q ? ['作品', filters.q] : null, filters.station ? ['放送局', filters.station] : null,
      filters.overlaps ? ['絞り込み', '同じ月に別の局があるものだけ'] : null].filter(Boolean);
    const bytes = encodeReportXlsx({sheets: historySheets(matrix, {conditions, dataAsOf: new Date().toISOString(), slots: data.slots, airings: data.airings, partners})});
    return new Response(bytes, {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(`放送履歴表_${filters.from}-${filters.to}_${stamp()}.xlsx`, 'broadcast-history.xlsx')}});
  }));

  // ---- 放送ウィンドウ提案 -----------------------------------------------------------------------------
  function proposalOptions(c) {
    const asOf = c.req.query('asOf') || todayJst();
    if (!isIsoDate(asOf)) throw Error('基準日は 2026-09-26 の形で指定してください');
    const minMonths = c.req.query('minMonths') ? Number(c.req.query('minMonths')) : PROPOSAL_MIN_MONTHS;
    if (!Number.isInteger(minMonths) || minMonths < 1 || minMonths > 24) throw Error('短い区間の目安は1〜24か月です');
    const workId = c.req.query('workId') ? integer(c.req.query('workId')) : null;
    return {asOf, minMonths, workId};
  }
  function proposalsFor(access, data, {asOf, minMonths, workId}) {
    const rows = [];
    for (const work of access.works) {
      if (workId && work.id !== workId) continue;
      const products = data.products.filter((p) => p.work_id === work.id && p.channel === 'broadcast');
      // 提案から下書きを作る画面のために、編集できるかと、この作品の生きている放送枠（同じ月・同じ局の二重登録を先に示す）を添える
      const live = byWork(data.slots, work.id).filter(isLiveSlot).map((s) => ({slot_id: s.slot_id, month: s.broadcast_month, station: s.station_name, status: s.status}));
      for (const product of products.length ? products : [null]) {
        const result = safePropose({asOf, minMonths, horizonMonths: PROPOSAL_HORIZON_MONTHS, product, ...proposalInput(data, work.id, product)});
        rows.push({...proposalRow({work, product, result}), result, can_edit: access.editable.has(work.id), live_slots: live});
      }
    }
    return rows;
  }
  app.get('/api/broadcast/window-proposals', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const options = proposalOptions(c);
    if (options.workId && !access.visible.has(options.workId)) return bad(c, '作品への権限がありません', 403);
    const rows = proposalsFor(access, await load(i, access), options);
    const counts = {rows: rows.length, ok: rows.filter((r) => r.state === 'ok').length, full: rows.filter((r) => r.state === 'full').length, blocked: rows.filter((r) => r.state === 'blocked').length};
    return c.json({ok: true, asOf: options.asOf, horizonMonths: PROPOSAL_HORIZON_MONTHS, minMonths: options.minMonths, rows, counts, readOnly: true});
  }));
  app.get('/api/broadcast/window-proposals/export.xlsx', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const options = proposalOptions(c);
    if (options.workId && !access.visible.has(options.workId)) return bad(c, '作品への権限がありません', 403);
    const rows = proposalsFor(access, await load(i, access), options);
    const bytes = encodeReportXlsx({sheets: [{name: '放送ウィンドウ提案', title: '商品別の放送ウィンドウ提案', columns: PROPOSAL_COLUMNS, rows, freezeCols: 4, paperSize: 'A3', dataAsOf: new Date().toISOString(),
      conditions: [['基準日', options.asOf], ['提案の先', `${PROPOSAL_HORIZON_MONTHS}か月`], ['短い区間', `${options.minMonths}か月未満`], options.workId ? ['作品', rows[0]?.work_code || ''] : ['作品', '閲覧できる全作品']],
      notes: ['放送してよい期間＝権利範囲（放送）∩ 放送の解禁 ∩ 商品別の販売ウィンドウ（無ければ作品共通の販売条件）∩ 基準日から24か月。独占の契約とホールドバックの期間を引いたものが提案する期間。',
        '販売条件は系列ごとの最新の版で決める。改訂中の下書きは直前の確認済みの期間で計算し、取り下げは販売しない（どちらも要確認に出す）。',
        '非独占の契約と他局の放送枠は塞がず「同時期の他局」に出す。この表からは登録しない（放送枠の下書きは画面の「提案する（下書きを作る）」から作る）。']}]});
    return new Response(bytes, {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(`放送ウィンドウ提案_${options.asOf.replaceAll('-', '')}_${stamp()}.xlsx`, 'broadcast-window-proposals.xlsx')}});
  }));

  // ---- 提案から放送枠の下書きを作る・合意に至らなければ削除する ---------------------------------------------
  // 局の候補: 区分に「放送局」がある取引先と、局の種別を登録した取引先（放送局の種別の一覧と同じ範囲）
  async function stationList(i) {
    const [partners, roles, types] = await Promise.all([
      db.all('SELECT id,code,name,kind FROM partners WHERE org_id=? ORDER BY code,id', [i.org_id]), partnerRoles(db, i.org_id),
      db.all(`SELECT t.partner_id,t.version_no,t.station_type,t.reason,t.created_at FROM broadcast_station_type_versions t
        WHERE t.org_id=? AND t.version_no=(SELECT MAX(x.version_no) FROM broadcast_station_type_versions x WHERE x.org_id=t.org_id AND x.partner_id=t.partner_id)`, [i.org_id]),
    ]);
    const typeOf = new Map(types.map((t) => [t.partner_id, t]));
    const stations = partners.filter((p) => (roles.get(p.id) || []).includes('broadcaster') || typeOf.has(p.id)).map((p) => ({
      partner_id: p.id, code: p.code, name: p.name, roles: roles.get(p.id) || [], station_type: typeOf.get(p.id)?.station_type || null,
      version_no: typeOf.get(p.id)?.version_no || 0, reason: typeOf.get(p.id)?.reason || null, updated_at: typeOf.get(p.id)?.created_at || null,
    }));
    return {partners, stations};
  }
  const draftRowsSql = `SELECT d.slot_id,d.work_id,d.proposal_key,d.product_id,d.station_partner_id,d.broadcast_month,d.run_kind,d.as_of,d.proposal_from,d.proposal_to,d.basis_text,d.memo,d.created_at,
      w.code AS work_code,w.title AS work_title,p.sku AS product_sku,p.name AS product_name,pt.name AS station_partner_name,u.display_name AS created_by_name,
      v.revision,v.status,v.station_name,v.customer_partner_id,v.period_from,v.period_to,v.planned_runs,v.broadcast_month AS slot_month,
      x.reason AS deleted_reason,x.deleted_at,x.revision AS deleted_revision,du.display_name AS deleted_by_name,
      EXISTS(SELECT 1 FROM broadcast_sale_links l WHERE l.org_id=d.org_id AND l.slot_id=d.slot_id) AS has_sales
    FROM broadcast_proposal_drafts d
    JOIN works w ON w.org_id=d.org_id AND w.id=d.work_id
    JOIN partners pt ON pt.org_id=d.org_id AND pt.id=d.station_partner_id
    JOIN broadcast_slot_versions v ON v.org_id=d.org_id AND v.slot_id=d.slot_id AND v.revision=(SELECT MAX(z.revision) FROM broadcast_slot_versions z WHERE z.org_id=d.org_id AND z.slot_id=d.slot_id)
    LEFT JOIN products p ON p.org_id=d.org_id AND p.id=d.product_id
    LEFT JOIN users u ON u.id=d.created_by
    LEFT JOIN broadcast_proposal_draft_deletions x ON x.org_id=d.org_id AND x.slot_id=d.slot_id
    LEFT JOIN users du ON du.id=x.deleted_by
    WHERE d.org_id=?`;
  // 局・種別・月・期間は放送枠の最新版から出す（放送枠のタブの「修正」で局や月を変えた後も、名前と種別が同じ局を指す）。
  // 局（取引先と種別）は、今の放送枠の局名から放送局の取引先を引く（名前かコード。NFKC・空白を除く・小文字。放送枠のタブの「未登録の局」と同じ見分け方）。
  // 取引先（売上の相手）の列は見ない: 放送枠のタブで局名だけを直すと、売上の相手は元の局のまま残るため。引けない局名は種別を未登録（null）にする。
  // 提案したときの局・月は proposed_* に分けて返す。
  // check: 今の放送枠の期間が、基準日で計算し直した提案する期間の外に出たか（独占・ホールドバックの月に入ったなど）→ {needs, reason}
  const draftRow = (row, access, stations, check = null) => {
    const deleted = row.deleted_revision != null;
    const canEdit = access.editable.has(row.work_id);
    const hasSales = Boolean(Number(row.has_sales));
    const station = stationPartner(row.station_name, stations);
    const changed = row.slot_month !== row.broadcast_month || stationKey(row.station_name) !== stationKey(row.station_partner_name);
    const outside = row.period_from < row.proposal_from || row.period_to > row.proposal_to;
    return {
      slot_id: row.slot_id, work_id: row.work_id, work_code: row.work_code, work_title: row.work_title, proposal_key: row.proposal_key,
      product_id: row.product_id, product_sku: row.product_sku || '', product_name: row.product_name || '（放送用の商品が未登録・作品全体）',
      station_partner_id: station?.partner_id ?? null, station_name: row.station_name, station_type: station?.station_type || null,
      proposed_station_partner_id: row.station_partner_id, proposed_station_name: row.station_partner_name, proposed_month: row.broadcast_month,
      broadcast_month: row.slot_month, period_from: row.period_from, period_to: row.period_to, planned_runs: row.planned_runs,
      run_kind: row.run_kind, run_label: DRAFT_RUN_KINDS[row.run_kind], memo: row.memo, as_of: row.as_of, proposal_from: row.proposal_from, proposal_to: row.proposal_to,
      basis_text: row.basis_text, created_by_name: row.created_by_name || '', created_at: row.created_at, status: row.status, revision: row.revision,
      changed_after_proposal: changed, outside_proposal: !deleted && row.status !== 'cancelled' && outside,
      needs_check: Boolean(check?.needs), check_reason: check?.needs ? check.reason : null,
      deleted, deleted_reason: row.deleted_reason || null, deleted_by_name: row.deleted_by_name || null, deleted_at: row.deleted_at || null,
      has_sales: hasSales, can_edit: canEdit, can_delete: canEdit && !deleted && row.status === 'draft' && !hasSales,
    };
  };
  // 下書きの今の月・期間を、その下書きの基準日で計算し直した提案と照らす（作品・商品・基準日・局ごとに1回だけ計算する。削除・中止の枠は見ない）。
  // 今の放送枠の局との独占の契約は塞ぐ理由から外す（forStation）。合意して確定まで進めた枠に、その合意の契約（同じ局・独占）を取引先別リストへ入れても
  // 要確認にしない。ほかの局の独占の契約・ホールドバック・権利・解禁・販売条件は、状態を問わず（下書き〜確定・差し戻し）これまでどおり見る
  function draftChecks(raw, data) {
    const results = new Map(), out = new Map();
    for (const row of raw) {
      if (row.deleted_revision != null || row.status === 'cancelled') continue;
      const key = `${row.work_id}|${row.product_id ?? ''}|${row.as_of}|${stationKey(row.station_name)}`;
      if (!results.has(key)) {
        const product = row.product_id ? data.products.find((p) => p.id === row.product_id && p.work_id === row.work_id) || null : null;
        results.set(key, safePropose({asOf: row.as_of, minMonths: PROPOSAL_MIN_MONTHS, horizonMonths: PROPOSAL_HORIZON_MONTHS, product, forStation: row.station_name, ...proposalInput(data, row.work_id, product)}));
      }
      const result = results.get(key);
      const inside = result.state === 'ok' && result.proposals.some((p) => (!p.from || p.from <= row.period_from) && (!p.to || row.period_to <= p.to));
      if (!inside) out.set(row.slot_id, {needs: true, reason: `${ymText(row.slot_month)}は提案する期間の外です（${monthBlockReason(result, row.slot_month)}）`});
    }
    return out;
  }
  app.get('/api/broadcast/window-proposals/drafts', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const workId = c.req.query('workId') ? integer(c.req.query('workId')) : null;
    if (workId && !access.visible.has(workId)) return bad(c, '作品への権限がありません', 403);
    const [{stations}, raw] = await Promise.all([stationList(i), db.all(`${draftRowsSql} ORDER BY d.created_at DESC,d.slot_id DESC`, [i.org_id])]);
    const mine = raw.filter((row) => access.visible.has(row.work_id) && (!workId || row.work_id === workId));
    const checks = mine.some((row) => row.deleted_revision == null && row.status !== 'cancelled') ? draftChecks(mine, await load(i, access)) : new Map();
    const all = mine.map((row) => draftRow(row, access, stations, checks.get(row.slot_id)));
    const rows = all.filter((row) => !row.deleted), deleted = all.filter((row) => row.deleted);
    const inStatus = (list) => rows.filter((r) => list.includes(r.status)).length;
    return c.json({ok: true, rows, deleted,
      counts: {drafts: inStatus(['draft']), inFlow: inStatus(['pending_first', 'tentative', 'pending_final', 'confirmed']), rejected: inStatus(['rejected']), cancelled: inStatus(['cancelled']), deleted: deleted.length},
      stations: stations.map((s) => ({partner_id: s.partner_id, code: s.code, name: s.name, station_type: s.station_type})), stationTypes: STATION_TYPES, runKinds: DRAFT_RUN_KINDS});
  }));
  app.post('/api/broadcast/window-proposals/drafts', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const b = await body(c);
    const workId = integer(b.workId ?? '');
    if (!access.visible.has(workId)) return bad(c, '作品への権限がありません', 403);
    if (!access.editable.has(workId)) return bad(c, '作品の編集権限がありません（提案から下書きを作れるのは案件の編集権限がある人です）', 403);
    const asOf = String(b.asOf ?? '');
    if (!isIsoDate(asOf)) throw Error('基準日は 2026-09-26 の形で指定してください');
    const minMonths = b.minMonths === undefined || b.minMonths === null || b.minMonths === '' ? PROPOSAL_MIN_MONTHS : Number(b.minMonths);
    if (!Number.isInteger(minMonths) || minMonths < 1 || minMonths > 24) throw Error('短い区間の目安は1〜24か月です');
    const runKind = String(b.runKind ?? '');
    if (!Object.hasOwn(DRAFT_RUN_KINDS, runKind)) throw Error('初回か再放送を選んでください');
    const memo = text(b.memo, 1000);
    const {stations} = await stationList(i);
    const station = stations.find((s) => s.partner_id === Number(b.stationPartnerId));
    if (!station) return bad(c, '放送局を選んでください（取引先のうち、区分に「放送局」があるか局の種別を登録した取引先）', 400);
    const data = await load(i, access);
    const products = data.products.filter((p) => p.work_id === workId && p.channel === 'broadcast');
    const noProduct = b.productId === undefined || b.productId === null || b.productId === '';
    const product = products.length ? products.find((p) => p.id === Number(b.productId)) || null : null;
    if (products.length && !product) return bad(c, 'この作品の放送用の商品を選んでください', 400);
    if (!products.length && !noProduct) return bad(c, 'この作品には放送用の商品がありません（作品全体の行から提案してください）', 400);
    // 提案をこの場で計算し直し、選んだ月が今も提案する期間の中にあるかを確かめる（画面を開いた後に契約や権利が変わっていても、塞がった月には作らない）
    const result = safePropose({asOf, minMonths, horizonMonths: PROPOSAL_HORIZON_MONTHS, product, ...proposalInput(data, workId, product)});
    if (result.state !== 'ok') return bad(c, result.state === 'full' ? '基準日から24か月の中に提案できる期間がありません（空きなし）' : '提案なし（要確認）の商品からは下書きを作れません。要確認の理由を先に解いてください', 409);
    const checked = checkDraftMonths(result, b.months);
    if (checked.errors.length) return bad(c, checked.errors.map((e) => e.message).join('／'), 400);
    // 放送枠の登録の経路で、月ごとに下書きの第1版を作る（二重登録・入力の確かめ・同じ月の版の数の照合は放送枠の追加と同じ）
    const proposalKey = crypto.randomUUID();
    const firstId = await slotStore.nextSlotId();
    const statements = [], created = [], duplicates = [];
    for (const [index, option] of checked.accepted.entries()) {
      const slotId = firstId + index;
      const draft = await slotStore.draftSlot(i, workId, {broadcastMonth: option.month, stationName: station.name, customerPartnerId: station.partner_id,
        periodFrom: option.from, periodTo: option.to, plannedRuns: 1, sourceReference: draftSourceReference({asOf, option}), reason: draftReason({runKind, memo})}, slotId);
      if (draft.duplicate) { duplicates.push(draft.message); continue; }
      const basis = draftBasisText(result, option);
      statements.push(...draft.statements,
        {sql: `INSERT INTO broadcast_proposal_drafts(org_id,slot_id,work_id,proposal_key,product_id,station_partner_id,broadcast_month,run_kind,as_of,proposal_from,proposal_to,basis_text,memo,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params: [i.org_id, slotId, workId, proposalKey, product?.id ?? null, station.partner_id, option.month, runKind, asOf, option.proposal.from, option.proposal.to, basis, memo, i.user_id]},
        audit(i, 'create', 'broadcast_slot', slotId, {after: draft.value, revision: 1, source: 'window_proposal', proposalKey, productId: product?.id ?? null, stationPartnerId: station.partner_id,
          runKind, asOf, proposal: option.proposal, memo}));
      created.push({slotId, month: option.month, periodFrom: option.from, periodTo: option.to});
    }
    if (duplicates.length) return bad(c, duplicates.join('／'), 409);
    try {
      await db.batch(statements);
    } catch (error) {
      // 確かめた後に、別の人が同じ作品・月の放送枠を登録・更新した（同じ月の版の数の照合・放送枠IDの重なり）
      if (isCreateRace(error)) return bad(c, DRAFT_CREATE_CONFLICT, 409);
      throw error;
    }
    return c.json({ok: true, proposalKey, count: created.length, slots: created, station: {partnerId: station.partner_id, name: station.name}}, 201);
  }));
  app.post('/api/broadcast/window-proposals/drafts/:slotId/delete', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const slotId = integer(c.req.param('slotId'));
    const row = await db.get(`${draftRowsSql} AND d.slot_id=?`, [i.org_id, slotId]);
    if (!row || !access.visible.has(row.work_id)) return bad(c, '提案から作った放送枠がないか、作品への権限がありません', 404);
    if (!access.editable.has(row.work_id)) return bad(c, '作品の編集権限がありません', 403);
    if (row.deleted_revision != null) return bad(c, 'この下書きはもう削除しています', 409);
    if (row.status === 'cancelled') return bad(c, '中止の放送枠は削除できません（中止のまま一覧に残ります）', 409);
    if (row.status === 'rejected') return bad(c, '差し戻しの放送枠はこの画面から削除できません。放送枠のタブで直して申請し直すか、中止にしてください', 409);
    if (row.status !== 'draft') {
      return bad(c, `${labelOf('broadcastStatus', row.status)}の放送枠はこの画面から削除できません（削除できるのは下書きのうちだけ）。放送枠のタブの承認の流れ（差し戻し・中止）で扱ってください`, 409);
    }
    if (Number(row.has_sales)) return bad(c, SALES_LINKED, 409);
    const b = await body(c);
    const base = integer(b.baseRevision ?? '');
    if (base !== row.revision) return bad(c, '他の人がこの放送枠を直しました。読み直してからもう一度削除してください', 409);
    const reason = text(b.reason, 1000, true);
    const current = await db.get('SELECT * FROM broadcast_slot_versions WHERE org_id=? AND slot_id=? AND revision=?', [i.org_id, slotId, base]);
    const value = {...Object.fromEntries(slotStore.columns.map((k) => [k, current[k]])), status: 'cancelled', reason: `${DELETED_LABEL}：${reason}`};
    try {
      await db.batch([
        guard('EXISTS(SELECT 1 FROM broadcast_slot_versions WHERE org_id=? AND slot_id=? AND revision>?)', [i.org_id, slotId, base]),
        // 確かめた後に売上が紐付いた枠も削除しない（表のトリガーでも止める）
        guard('EXISTS(SELECT 1 FROM broadcast_sale_links WHERE org_id=? AND slot_id=?)', [i.org_id, slotId]),
        {sql: slotStore.insertVersion, params: slotStore.params(i, row.work_id, slotId, base + 1, value)},
        {sql: 'INSERT INTO broadcast_proposal_draft_deletions(org_id,slot_id,revision,reason,deleted_by) VALUES(?,?,?,?,?)', params: [i.org_id, slotId, base + 1, reason, i.user_id]},
        audit(i, 'delete', 'broadcast_slot', slotId, {from: 'draft', to: 'deleted', reason, revision: base + 1, source: 'window_proposal', proposalKey: row.proposal_key,
          workId: row.work_id, month: row.slot_month, station: row.station_name}),
      ]);
    } catch (error) {
      // 確かめた後に、別の人がこの下書きを直した・売上を紐付けた・削除した
      if (isDeleteRace(error)) return bad(c, DRAFT_DELETE_CONFLICT, 409);
      throw error;
    }
    return c.json({ok: true, slotId, revision: base + 1, deleted: true});
  }));

  // ---- 放送アベイルズリスト ---------------------------------------------------------------------------
  // 照合の元: 閲覧できる作品（製作年つき）と、その作品の商品の品番・名前。照合（POST …/match）と同じ範囲で、読むだけ。
  // 閲覧用プレビューは、この応答を記録しておき、照合をブラウザの中で同じ純関数（availsMatchResult）で行う
  async function matchSource(i, access) {
    const [profiles, products] = await Promise.all([
      db.all('SELECT p.work_id,p.production_year FROM catalog_profiles p WHERE p.org_id=? AND p.revision=(SELECT MAX(z.revision) FROM catalog_profiles z WHERE z.org_id=p.org_id AND z.work_id=p.work_id)', [i.org_id]),
      db.all('SELECT p.sku,p.name,pw.work_id FROM products p JOIN product_works pw ON pw.org_id=p.org_id AND pw.product_id=p.id WHERE p.org_id=?', [i.org_id]),
    ]);
    const years = new Map(profiles.map((p) => [p.work_id, p.production_year]));
    return {
      works: access.works.map((w) => ({id: w.id, code: w.code, title: w.title, production_year: years.get(w.id) ?? null})),
      products: products.filter((p) => access.visible.has(p.work_id)).map((p) => ({work_id: p.work_id, sku: p.sku, name: p.name})),
    };
  }
  app.get('/api/broadcast/availability-list/candidates', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    return c.json({ok: true, ...(await matchSource(i, access))});
  }));
  app.post('/api/broadcast/availability-list/match', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const b = await body(c);
    if (splitTitleLines(b.text).error) return bad(c, splitTitleLines(b.text).error, 400);
    const result = availsMatchResult(b.text, await matchSource(i, access));
    return c.json({ok: true, rows: result.rows, counts: result.counts});
  }));
  app.get('/api/broadcast/availability-list/export.xlsx', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const picked = normalizeWorkIds(c.req.query('workIds'));
    if (picked.error) return bad(c, picked.error, 400);
    const asOf = c.req.query('asOf') || todayJst();
    if (!isIsoDate(asOf)) return bad(c, '基準日は 2026-09-26 の形で指定してください', 400);
    const byId = new Map(access.works.map((w) => [w.id, w]));
    const chosen = picked.workIds.map((id) => byId.get(id)).filter(Boolean);
    // 権限や削除で1件も残らなければ、全作品に落とさず止める
    if (!chosen.length) return bad(c, '選んだ作品はどれも閲覧できません（権限を確かめてください）。全作品は出力しません', 400);
    const data = await load(i, access, {catalog: true});
    const rows = chosen.map((work) => {
      const products = data.products.filter((p) => p.work_id === work.id);
      const broadcast = products.filter((p) => p.channel === 'broadcast');
      const sku = broadcast[0]?.sku || products.find((p) => p.channel === 'package')?.sku || '';
      const slots = byWork(data.slots, work.id), airings = byWork(data.airings, work.id);
      const result = safePropose({asOf, product: broadcast[0] || null, ...proposalInput(data, work.id, broadcast[0] || null)});
      const cat = data.catalog;
      const edition = cat.bindings.find((b) => b.work_id === work.id && broadcast.some((p) => p.id === b.product_id))?.edition_key || cat.editions.find((e) => e.work_id === work.id)?.edition_key;
      return availsRow(work, {
        windows: data.windows.filter((w) => w.work_id === work.id), catalog: cat.profiles.get(work.id) || null,
        credits: cat.credits.filter((cr) => cr.work_id === work.id), runtimeSeconds: cat.editions.find((e) => e.work_id === work.id && e.edition_key === edition)?.runtime_seconds || null,
        languages: [...new Set(cat.tags.filter((t) => t.work_id === work.id && t.edition_key === edition).map((t) => t.value))],
        sku, genre: cat.extras.get(work.id)?.genre || '', copyright: cat.extras.get(work.id)?.copyright_notice || '',
        recent: recentStations({slots, airings, asOf}), proposal: proposalSummary(result),
      });
    });
    const bytes = encodeReportXlsx({sheets: [availsSheet(rows, {asOf, dataAsOf: new Date().toISOString()})]});
    return new Response(bytes, {headers: {'content-type': XLSX_TYPE, 'content-disposition': attachment(availsFileName(rows, todayJst()), 'broadcast-availability-list.xlsx'), 'x-work-count': String(rows.length)}});
  }));

  // ---- 放送局の種別 ----------------------------------------------------------------------------------
  app.get('/api/broadcast/station-types', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, DENIED, 403);
    // 区分に「放送局」がある取引先と、種別を登録した取引先
    const {partners, stations} = await stationList(i);
    return c.json({ok: true, types: STATION_TYPES, stations, partners: partners.map((p) => ({id: p.id, code: p.code, name: p.name})), canEdit: true});
  }));
  app.post('/api/broadcast/station-types', wrap(async (c) => {
    const i = c.get('identity');
    if (i.role === 'production') return bad(c, DENIED, 403);
    const b = await body(c);
    const partnerId = integer(b.partnerId ?? '');
    const partner = await db.get('SELECT id,code,name FROM partners WHERE org_id=? AND id=?', [i.org_id, partnerId]);
    if (!partner) return bad(c, '取引先がありません', 404);
    const type = String(b.stationType || '');
    if (!Object.hasOwn(STATION_TYPES, type)) throw Error('局の種別は 地上波・BS・CS・CATV・配信・その他 から選んでください');
    const reason = text(b.reason, 1000, true);
    const base = integer(b.baseVersion ?? 0);
    const current = Number((await db.get('SELECT COALESCE(MAX(version_no),0) n FROM broadcast_station_type_versions WHERE org_id=? AND partner_id=?', [i.org_id, partnerId])).n);
    if (base !== current) return bad(c, '他の人が先に局の種別を直しました。読み直してからもう一度登録してください', 409);
    await db.batch([
      guard('(SELECT COALESCE(MAX(version_no),0) FROM broadcast_station_type_versions WHERE org_id=? AND partner_id=?)<>?', [i.org_id, partnerId, base]),
      {sql: 'INSERT INTO broadcast_station_type_versions(org_id,partner_id,version_no,station_type,reason,created_by) VALUES(?,?,?,?,?,?)', params: [i.org_id, partnerId, base + 1, type, reason, i.user_id]},
      audit(i, 'version', 'broadcast_station_type', partnerId, {partner: partner.code, version: base + 1, stationType: type, reason}),
    ]);
    return c.json({ok: true, version: base + 1, stationType: type}, 201);
  }));

  // ---- 明細ごとの許諾回数・ホールドバック -----------------------------------------------------------------
  async function entryOf(i, entryId) {
    return db.get(`SELECT e.id,e.work_id,e.list_id,l.partner_id,p.name AS partner_name,v.distribution_code,m.distribution_name
      FROM partner_list_entries e JOIN partner_lists l ON l.org_id=e.org_id AND l.id=e.list_id JOIN partners p ON p.org_id=l.org_id AND p.id=l.partner_id
      JOIN partner_list_entry_versions v ON v.org_id=e.org_id AND v.entry_id=e.id AND v.version_no=(SELECT MAX(x.version_no) FROM partner_list_entry_versions x WHERE x.org_id=e.org_id AND x.entry_id=e.id)
      LEFT JOIN distribution_master m ON m.code=v.distribution_code WHERE e.org_id=? AND e.id=?`, [i.org_id, entryId]);
  }
  app.get('/api/broadcast/entry-terms', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const rows = await db.all(`SELECT t.entry_id,e.work_id,t.version_no,t.licensed_runs,t.holdback_months,t.reason,t.created_at FROM broadcast_entry_term_versions t
      JOIN partner_list_entries e ON e.org_id=t.org_id AND e.id=t.entry_id
      WHERE t.org_id=? AND t.version_no=(SELECT MAX(x.version_no) FROM broadcast_entry_term_versions x WHERE x.org_id=t.org_id AND x.entry_id=t.entry_id)`, [i.org_id]);
    return c.json({ok: true, terms: rows.filter((r) => access.visible.has(r.work_id))});
  }));
  app.get('/api/partner-list-entries/:entryId/broadcast-terms', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const entry = await entryOf(i, integer(c.req.param('entryId')));
    if (!entry || !access.visible.has(entry.work_id)) return bad(c, '明細がないか、作品への権限がありません', 404);
    const versions = await db.all(`SELECT t.*,u.display_name AS created_by_name FROM broadcast_entry_term_versions t LEFT JOIN users u ON u.id=t.created_by
      WHERE t.org_id=? AND t.entry_id=? ORDER BY t.version_no DESC`, [i.org_id, entry.id]);
    return c.json({ok: true, entryId: entry.id, broadcast: entry.distribution_name === '放送', canEdit: access.editable.has(entry.work_id), current: versions[0] || null, versions});
  }));
  app.post('/api/partner-list-entries/:entryId/broadcast-terms', wrap(async (c) => {
    const i = c.get('identity');
    const access = await scope(i);
    if (!access) return bad(c, DENIED, 403);
    const entry = await entryOf(i, integer(c.req.param('entryId')));
    if (!entry || !access.visible.has(entry.work_id)) return bad(c, '明細がないか、作品への権限がありません', 404);
    if (!access.editable.has(entry.work_id)) return bad(c, '作品の編集権限がありません', 403);
    if (entry.distribution_name !== '放送') return bad(c, '放送の条件は、流通が放送の明細にだけ付けられます', 400);
    const b = await body(c);
    const licensed = optionalInt(b.licensedRuns, 1, 9999, '許諾放送回数');
    const holdback = optionalInt(b.holdbackMonths, 0, 120, 'ホールドバック（月）');
    const reason = text(b.reason, 1000, true);
    const base = integer(b.baseVersion ?? 0);
    const current = await db.get('SELECT * FROM broadcast_entry_term_versions WHERE org_id=? AND entry_id=? ORDER BY version_no DESC LIMIT 1', [i.org_id, entry.id]);
    if (base !== (current?.version_no || 0)) return bad(c, '他の人が先にこの明細の放送の条件を直しました。読み直してからもう一度登録してください', 409);
    if (current && current.licensed_runs === licensed && current.holdback_months === holdback) return bad(c, '前の版から変わった項目がありません', 400);
    await db.batch([
      guard('(SELECT COALESCE(MAX(version_no),0) FROM broadcast_entry_term_versions WHERE org_id=? AND entry_id=?)<>?', [i.org_id, entry.id, base]),
      {sql: 'INSERT INTO broadcast_entry_term_versions(org_id,entry_id,version_no,licensed_runs,holdback_months,reason,created_by) VALUES(?,?,?,?,?,?,?)', params: [i.org_id, entry.id, base + 1, licensed, holdback, reason, i.user_id]},
      audit(i, 'version', 'broadcast_entry_terms', entry.id, {version: base + 1, before: current ? {licensedRuns: current.licensed_runs, holdbackMonths: current.holdback_months} : null, after: {licensedRuns: licensed, holdbackMonths: holdback}, reason}),
    ]);
    return c.json({ok: true, version: base + 1, licensedRuns: licensed, holdbackMonths: holdback}, 201);
  }));
}
