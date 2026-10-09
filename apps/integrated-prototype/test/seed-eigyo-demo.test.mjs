// 営業基幹の架空データ（scripts/seed-eigyo-demo.mjs）の試験。
// ・売上の架空データ（seed-sales-demo）の後に流し、1回だけ入ること（2回目は何も足さない）。組織1からは見えないこと。
// ・ウィンドウの状態（未登録・予定・確定・取り下げ）と警告を、計画（windowPlan・WARNING_FIXTURES の入力）から
//   この試験の中で書き下した決まりで計算し直し、API の結果と照合する（release-window-model の関数は使わない）。
// ・月まで・時期の原文・未定の日付が、仮の日付を作らずに入っていること。連続ドラマ（DEMO-D78）があればそれにも入ること。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {seedSalesDemo, SALES_DEMO} from '../scripts/seed-sales-demo.mjs';
import {seedEigyoDemo, windowPlan, WARNING_FIXTURES, EIGYO_DEMO, partnerListPlan, SALES_SHEET_RATES, THEATRE_ATTRIBUTES, SALES_SHEET_VIEWS,
  PROPOSAL_DEMO, proposalWindowPlan, svodPricePlan, proposalRightsPlan} from '../scripts/seed-eigyo-demo.mjs';

// ---------- この試験の中で書き下した決まり ----------
const POINT_TYPES = new Set(['theatrical', 'package_sell', 'package_rental']);
const ALL_TYPES = ['theatrical', 'package_sell', 'package_rental', 'pvod_early', 'pvod_second', 'est_early', 'est_regular', 'tvod_early', 'tvod_regular',
  'svod_early', 'svod_regular', 'avod', 'business_vod', 'broadcast', 'overseas'];
// 種別と流通ID（設計 §2 の対応。この架空データが使う流通IDだけ）
const CODES = {svod_early: ['D005'], svod_regular: ['D005'], tvod_early: ['D004'], tvod_regular: ['D004'], pvod_early: ['D007'], pvod_second: ['D007'], est_early: ['D003'], est_regular: ['D003']};
const DIGITAL = new Set(['pvod_early', 'pvod_second', 'est_early', 'est_regular', 'tvod_early', 'tvod_regular', 'svod_early', 'svod_regular', 'avod', 'business_vod']);
const monthEnd = (ym) => `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
function range(text) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text || '')) return [text, text];
  if (/^\d{4}-\d{2}$/.test(text || '')) return [`${text}-01`, monthEnd(text)];
  return null;
}
function expectedWarnings(item, last) {
  if (last.status === 'withdrawn') return [];
  const start = range(last.start);
  if (!start) return [];
  const end = POINT_TYPES.has(item.typeKey) ? start : range(last.end || '');
  const until = end ? end[1] : start[1];
  const kinds = [];
  const conditions = WARNING_FIXTURES.availabilities.filter((a) => a.workCode === item.workCode && (CODES[item.typeKey] || []).includes(a.distributionCode));
  if (conditions.length && !conditions.some((a) => a.releaseOn <= start[0] && until <= a.salesEndOn)) kinds.push('availability');
  const rights = [...WARNING_FIXTURES.rights, ...proposalRightsPlan()].filter((r) => r.workCode === item.workCode && r.channel === '配信' && DIGITAL.has(item.typeKey));
  if (rights.length && !rights.some((r) => r.rightsStart <= start[0] && until <= r.rightsEnd)) kinds.push('rights');
  if (item.typeKey === 'broadcast') {
    for (const slot of WARNING_FIXTURES.slots.filter((s) => s.workCode === item.workCode)) {
      const month = range(slot.broadcastMonth);
      if (month[1] < start[0] || (end && month[0] > end[1])) kinds.push('broadcast_slot');
    }
  }
  return kinds;
}

let db, summary, again, rows, api, orgId;
const count = async (table) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`, [orgId])).n);
before(async (t) => {
  db = await openTestDb({t});
  await seedSalesDemo(db);
  orgId = (await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode])).id;
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return async (method, path, payload) => {
      const res = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
      return {status: res.status, body: await res.json()};
    };
  };
  api = await login(SALES_DEMO.adminEmail);
  // 制作の架空データ（連続ドラマ）の代わりに、同じコードの作品だけを API で作る（台本PDFの取込はこの試験では流さない）
  const project = await api('POST', '/projects', {code: 'DEMO-P-SERIES', title: '架空の連続ドラマ（架空）', status: 'active', budget_yen: 1000000});
  await api('POST', '/works', {project_id: project.body.id, code: EIGYO_DEMO.seriesWork, title: '架空の連続ドラマ 第7・8話（架空）', format: 'series'});
  summary = await seedEigyoDemo(db);
  const counts = async () => Object.fromEntries(await Promise.all(['work_release_windows', 'work_release_window_versions', 'release_window_types', 'sales_availability_versions', 'rights_intake_cases', 'broadcast_slots', 'audit_log',
    'partner_lists', 'partner_list_entries', 'partner_list_entry_versions', 'partner_list_field_definitions', 'partner_list_field_values', 'partner_list_import_batches',
    'sales_sheet_column_versions', 'sale_attribute_values', 'sale_currency_versions', 'sales_sheet_views', 'sales_sheet_view_versions',
    'works', 'rights_intake_scopes', 'catalog_profiles', 'work_proposal_profiles'].map(async (t) => [t, await count(t)])));
  const first = await counts();
  again = {result: await seedEigyoDemo(db), before: first, after: await counts()};
  rows = (await api('GET', '/release-windows?pageSize=200')).body.rows;
});
after(() => db?.close());

test('1回だけ入り、2回目は何も足さない', () => {
  assert.equal(summary.windows.skipped, false);
  assert.equal(summary.windows.withSeries, true);
  assert.equal(again.result.windows.skipped, true);
  assert.deepEqual(again.after, again.before);
  const plan = windowPlan({withSeries: true});
  assert.equal(summary.windows.windows, plan.length);
  assert.equal(summary.windows.versions, plan.reduce((n, item) => n + item.versions.length, 0));
  // 節4（提案資料）の窓の系列と、SVOD の月額単価の版を足した数
  assert.equal(again.before.work_release_windows, plan.length + proposalWindowPlan().length);
  assert.equal(again.before.work_release_window_versions, plan.reduce((n, item) => n + item.versions.length, 0) + proposalWindowPlan().length + svodPricePlan().length);
  assert.equal(again.before.release_window_types, 15);
});

// 節1と節4（提案資料）の窓の計画。SVOD の月額単価の版は日付と状態を変えない
const allWindowPlan = () => [...windowPlan({withSeries: true}), ...proposalWindowPlan()];

test('全20作品＋連続ドラマ＋公開前の新作6本が1行ずつ出て、状態（未登録・予定・確定・取り下げ）が計画の最後の版と一致する', () => {
  assert.equal(rows.length, 21 + PROPOSAL_DEMO.newWorks.length);
  const plan = allWindowPlan();
  const expected = new Map(plan.map((item) => [`${item.workCode}|${item.typeKey}`, item.versions.at(-1).status]));
  const tally = {unregistered: 0, draft: 0, confirmed: 0, withdrawn: 0};
  for (const row of rows) {
    for (const typeKey of ALL_TYPES) {
      const state = expected.get(`${row.work_code}|${typeKey}`) || 'unregistered';
      assert.equal(row.windows[typeKey].state, state, `${row.work_code} ${typeKey}`);
      tally[state] += 1;
    }
  }
  for (const [state, n] of Object.entries(tally)) assert.ok(n > 0, `${state} が1件もない`);
  assert.equal(tally.unregistered, rows.length * 15 - plan.length);
  // 手で数えた取り下げ: W11 レンタル・W15 SVOD先行・W08 AVOD
  assert.deepEqual(rows.flatMap((row) => ALL_TYPES.filter((key) => row.windows[key].state === 'withdrawn').map((key) => `${row.work_code}:${key}`)).sort(),
    ['DEMO-W08:avod', 'DEMO-W11:package_rental', 'DEMO-W15:svod_early']);
});

test('日付は仮の日付を作らない（月まで・時期の原文・未定）', () => {
  const version = (code, key) => rows.find((row) => row.work_code === code).windows[key].version;
  assert.deepEqual([version('DEMO-W19', 'package_sell').start_on, version('DEMO-W19', 'package_sell').date_precision], ['2026-10', 'month']);
  assert.deepEqual([version('DEMO-W20', 'package_rental').start_on, version('DEMO-W20', 'package_rental').date_precision], ['2026-11', 'month']);
  assert.deepEqual([version('DEMO-W19', 'svod_early').date_precision, version('DEMO-W19', 'svod_early').timing_raw, version('DEMO-W19', 'svod_early').start_on], ['range', '2027年春', '2027-03']);
  assert.deepEqual([version('DEMO-W20', 'broadcast').date_precision, version('DEMO-W20', 'broadcast').start_on], ['tbd', null]);
  assert.deepEqual([version(EIGYO_DEMO.seriesWork, 'svod_early').start_on, version(EIGYO_DEMO.seriesWork, 'svod_early').date_precision], ['2026-10', 'month']);
  // W01 の SVOD先行は2つの版（月まで → 日付で確定）
  const w01 = version('DEMO-W01', 'svod_early');
  assert.deepEqual([w01.version_no, w01.start_on, w01.end_on, w01.status], [2, '2025-03-01', '2026-02-28', 'confirmed']);
});

test('警告（販売条件の期間外・権利期間外・放送枠の月が放送期間外）が、独立に計算したものと一致する', () => {
  const plan = allWindowPlan();
  const expected = plan.flatMap((item) => expectedWarnings(item, item.versions.at(-1)).map((kind) => `${item.workCode}|${item.typeKey}|${kind}`)).sort();
  const actual = rows.flatMap((row) => ALL_TYPES.flatMap((key) => row.windows[key].warnings.map((w) => `${row.work_code}|${key}|${w.kind}`))).sort();
  assert.deepEqual(actual, expected);
  // 3種類の警告がそろっていて、W02 の EST（条件に含まれる）は警告なし
  for (const kind of ['availability', 'rights', 'broadcast_slot']) assert.ok(actual.some((key) => key.endsWith(`|${kind}`)), kind);
  assert.ok(!actual.some((key) => key.startsWith('DEMO-W02|est_regular')));
  assert.ok(actual.includes('DEMO-W01|svod_early|availability'));
  assert.ok(actual.includes('DEMO-W04|broadcast|broadcast_slot'));
});

test('組織1（既存の架空データ）からは DEMO-SALES のウィンドウが見えない', async () => {
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'editor@openingnight.invalid'})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const body = await (await app.request('/api/release-windows', {headers: {cookie}})).json();
  assert.ok(body.rows.every((row) => !row.work_code.startsWith('DEMO-')));
  assert.equal(body.needsAdoption, true, '組織1は種別をまだ採用していない');
});

// ---------- 節2: 取引先別の配信・販売リスト ----------
// 状態は基準日 2026-09-25・終了間近30日で、この試験の中で書き下した決まりで計算する（partner-list-model の関数は使わない）
function listState(entry) {
  if (entry.status === 'planned') return 'planned';
  if (entry.start > EIGYO_DEMO.asOf) return 'upcoming';
  if (entry.rule === 'date') {
    if (entry.end < EIGYO_DEMO.asOf) return 'ended';
    return (Date.parse(entry.end) - Date.parse(EIGYO_DEMO.asOf)) / 86400000 <= 30 ? 'ending_soon' : 'active';
  }
  return {auto_renew: 'auto_renew', perpetual: 'active', unknown: 'end_unknown'}[entry.rule];
}

test('取引先別リスト: 配信A・B・C と放送2局（配信リスト）、レンタル・セル（販売リスト）が1回だけ入る。配信Aは共通テンプレートの Excel 取込で入る', async () => {
  assert.equal(summary.partnerLists.skipped, false);
  assert.equal(again.result.partnerLists.skipped, true);
  const plan = partnerListPlan();
  const lists = (await api('GET', '/partner-lists')).body.lists;
  assert.deepEqual(lists.map((l) => [l.partner_code, l.list_kind]).sort(), [
    ['DEMO-PF-A', 'distribution'], ['DEMO-PF-B', 'distribution'], ['DEMO-PF-C', 'distribution'], ['DEMO-RNT-A', 'sales'], ['DEMO-SEL-A', 'sales'], ['DEMO-TV-A', 'distribution'], ['DEMO-TV-B', 'distribution']]);
  for (const list of lists) assert.match(list.name, /（架空）$/);
  const expectedEntries = plan.lists.reduce((n, l) => n + l.entries.length + (l.renewals?.length || 0), 0);
  assert.equal(again.before.partner_list_entries, expectedEntries);
  assert.equal(again.before.partner_list_field_definitions, 2);
  const batches = await db.all('SELECT appended,revised,withdrawn FROM partner_list_import_batches WHERE org_id=? ORDER BY id', [orgId]);
  assert.deepEqual(batches.map((b) => [b.appended, b.revised, b.withdrawn]), [[20, 0, 0], [1, 0, 0]]);
  // 再契約（2回目の取込）は、先に終わった W01 の独占の明細を再契約元として自動で結ぶ
  const w01 = await db.all(`SELECT e.id,e.renews_entry_id,v.contract_start FROM partner_list_entries e JOIN partner_list_entry_versions v ON v.entry_id=e.id JOIN works w ON w.id=e.work_id
    JOIN partner_lists l ON l.id=e.list_id JOIN partners p ON p.id=l.partner_id WHERE e.org_id=? AND w.code='DEMO-W01' AND p.code='DEMO-PF-A' ORDER BY v.contract_start`, [orgId]);
  assert.deepEqual(w01.map((e) => e.contract_start), ['2025-03-01', '2026-04-01']);
  assert.equal(w01[1].renews_entry_id, w01[0].id);
});

test('取引先別リスト: 明細の状態（自動更新・期限なし・終了間近・終了・予定を含む）が、計画から書き下した決まりと一致する', async () => {
  const plan = partnerListPlan();
  const lists = (await api('GET', '/partner-lists')).body.lists;
  const seen = new Set();
  for (const planned of plan.lists) {
    const list = lists.find((l) => l.name === planned.name);
    const entries = (await api('GET', `/partner-lists/${list.id}/entries?asOf=${EIGYO_DEMO.asOf}&soonDays=30`)).body.entries;
    const all = [...planned.entries, ...(planned.renewals || [])];
    assert.equal(entries.length, all.length, planned.name);
    for (const entry of all) {
      const actual = entries.find((e) => e.work_code === entry.work && e.distribution_code === entry.code && e.contract_start === entry.start);
      assert.ok(actual, `${planned.name} ${entry.work} ${entry.start}`);
      assert.equal(actual.state, listState(entry), `${planned.name} ${entry.work} ${entry.start}`);
      seen.add(actual.state);
    }
  }
  for (const state of ['active', 'ending_soon', 'ended', 'auto_renew', 'planned']) assert.ok(seen.has(state), state);
  // 期限なし（perpetual）が入っている
  assert.ok(plan.lists.some((l) => l.entries.some((e) => e.rule === 'perpetual')));
});

test('取引先別リスト: 重なり・再契約の空白・終了間近・契約中の取引先が無い流通が、手で数えた値と一致する', async () => {
  const matrix = (await api('GET', `/partner-lists/matrix?asOf=${EIGYO_DEMO.asOf}`)).body;
  const pairs = matrix.pairs.map((p) => `${p.severity} ${p.work_code} ${[p.left.partner_name, p.right.partner_name].sort().join('/')}`).sort();
  assert.deepEqual(pairs, [
    'caution DEMO-W01 架空BS放送（架空）/架空地上波テレビ（架空）',
    'caution DEMO-W03 架空BS放送（架空）/架空地上波テレビ（架空）',
    'caution DEMO-W04 架空配信B・都度課金（架空）/架空配信C・広告型（架空）',
    'exclusive DEMO-W06 架空配信A・定額制（架空）/架空配信C・広告型（架空）',
  ]);
  const checks = (await api('GET', `/partner-lists/checks?asOf=${EIGYO_DEMO.asOf}`)).body;
  // 終了間近: 配信A W05（2026-10-20）・配信A W07（2026-11-15）・レンタル W02（2026-11-30）・配信A W09（2026-12-10）
  assert.deepEqual(checks.endingSoon.map((e) => [e.partner_code, e.work_code, e.daysLeft, e.bucket]), [
    ['DEMO-PF-A', 'DEMO-W05', 25, 30], ['DEMO-PF-A', 'DEMO-W07', 51, 60], ['DEMO-RNT-A', 'DEMO-W02', 66, 90], ['DEMO-PF-A', 'DEMO-W09', 76, 90]]);
  // 再契約の空白: 配信A W01 の 2026年3月（31日）
  assert.deepEqual(checks.gaps.map((g) => [g.nextEntry.work_code, g.from, g.to, g.days]), [['DEMO-W01', '2026-03-01', '2026-03-31', 31]]);
  // 当社は売れるのに契約中の取引先が無い流通: W02 の EST（節1の販売条件）と W05 の AVOD（節2の販売条件）
  assert.deepEqual(checks.uncovered.map((u) => `${u.work_code} ${u.distribution_code}`), ['DEMO-W02 D003', 'DEMO-W05 D006']);
});

test('取引先別リスト: 期間外の売上は 配信A W01（開始前1・空白1）・配信A W11（予定のまま7）・BS W02（開始前1）の10件、流通違いは15件', async () => {
  const checks = (await api('GET', `/partner-lists/checks?asOf=${EIGYO_DEMO.asOf}`)).body;
  const rows = checks.sales.rows;
  const key = (row) => `${row.status}|${row.partner_name}|${row.work_code}`;
  const tally = {};
  for (const row of rows) tally[key(row)] = (tally[key(row)] || 0) + 1;
  // 手で数えた値（seed-sales-demo の窓口と周期から）:
  //   配信A W01: 販売は公開7か月後（2025-02）から月次。独占は 2025-03-01 から → 2025-02 は開始前。再契約は 2026-04-01 から → 2026-03 は空白
  //   配信A W11: 予定のまま、2025-12〜2026-06 の7か月の売上がある
  //   BS W02: 許諾の売上は 2025-06-01 から。リストは 2025-07-01 から → 開始前
  //   流通違い: 配信B W10（EST の明細だけ・売上は TVOD）2025-08〜2026-05 の10件、配信C W04（TVOD の明細・売上は AVOD）3件、配信C W06（SVOD の明細）2件
  assert.deepEqual(tally, {
    'before_start|架空配信A・定額制（架空）|DEMO-W01': 1, 'gap|架空配信A・定額制（架空）|DEMO-W01': 1, 'no_contract|架空配信A・定額制（架空）|DEMO-W11': 7,
    'before_start|架空BS放送（架空）|DEMO-W02': 1,
    'flow_mismatch|架空配信B・都度課金（架空）|DEMO-W10': 10, 'flow_mismatch|架空配信C・広告型（架空）|DEMO-W04': 3, 'flow_mismatch|架空配信C・広告型（架空）|DEMO-W06': 2,
  });
  assert.equal(checks.sales.outOfPeriod, 10);
  assert.deepEqual(rows.filter((r) => r.work_code === 'DEMO-W01' && r.partner_name.startsWith('架空配信A')).map((r) => [r.status, r.accounting_month]).sort(), [['before_start', '2025-02'], ['gap', '2026-03']]);
  assert.deepEqual(rows.filter((r) => r.status === 'no_contract').map((r) => r.accounting_month).sort(), ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
});

// ---------- 売上集計シート（節3） ----------
// 外貨の額はこの試験の中で 円÷レート を小数2桁に丸めて計算し直す（seed の foreignAmountOf は使わない）
const rounded = (value, digits) => { const f = 10 ** digits; return Math.sign(value) * Math.round(Math.abs(value) * f) / f; };
async function sheetLines(where, params = []) {
  return db.all(`SELECT s.id,s.amount_ex_tax,s.accounting_month,w.code AS work_code,p.code AS partner_code,r.kind,
      (SELECT d.territory FROM sale_distribution_versions d WHERE d.org_id=s.org_id AND d.sale_id=s.id ORDER BY d.version_no DESC LIMIT 1) AS territory
    FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
    WHERE s.org_id=? AND r.status='active' AND ${where} ORDER BY w.code,s.accounting_month,s.id`, [orgId, ...params]);
}

test('売上集計シート: 83列と追加28列を1回だけ採用し、保存した形が2つある', async () => {
  assert.equal(summary.salesSheet.skipped, false);
  assert.equal(again.result.salesSheet.skipped, true);
  assert.equal(again.before.sales_sheet_views, SALES_SHEET_VIEWS.length);
  const catalog = (await api('GET', '/sales-sheet/columns')).body;
  assert.equal(catalog.adopted, true);
  assert.equal(catalog.columns.filter((column) => column.legacyPosition).length, 83);
  assert.deepEqual(summary.salesSheet.additional, {skipped: false, columns: 28});
  assert.deepEqual(again.result.salesSheet.additional, {skipped: true});
  assert.equal(catalog.additionalPending, 0);
  for (const [set, expected] of [['additional', 28], ['all_plus', 111]]) {
    const sheet = (await api('GET', `/sales-sheet?set=${set}&hideEmpty=0`)).body;
    assert.equal(sheet.columns.length, expected);
    assert.equal(sheet.selected.length, expected);
    assert.ok(sheet.rows.length > 0);
  }
  const audits = await db.all(`SELECT detail_json FROM audit_log WHERE org_id=? AND entity_type='sales_sheet_column'
    AND action='adopt' AND json_extract(detail_json,'$.template')='sales-sheet-additional-v1'`, [orgId]);
  assert.equal(audits.length, 1);
  assert.match(JSON.parse(audits[0].detail_json).reason, /架空.*seed-eigyo-demo/);
  const views = (await api('GET', '/sales-sheet/views')).body.views;
  assert.deepEqual(views.map((view) => view.name).sort(), SALES_SHEET_VIEWS.map((view) => view.name).sort());
});

test('既存の架空組織で83列だけ採用済みでも追加28列を補い、再実行では版・監査を増やさない', async (t) => {
  const existing = await openTestDb({t});
  try {
    await seedSalesDemo(existing);
    const app = createApp({db: existing, mode: 'local'});
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const adopt = await app.request('/api/sales-sheet/columns/adopt', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify({reason: '追加列の導入前に83列だけ採用（架空）'})});
    assert.equal(adopt.status, 201);
    const initial = await existing.all('SELECT * FROM sales_sheet_column_versions ORDER BY column_key');
    assert.equal(initial.length, 103);
    const result = await seedEigyoDemo(existing);
    assert.equal(result.salesSheet.skipped, false, '追加の採用があれば営業seedも実行済みとして報告する');
    assert.deepEqual(result.salesSheet.additional, {skipped: false, columns: 28});
    const columns = await existing.all('SELECT * FROM sales_sheet_column_versions ORDER BY column_key');
    assert.deepEqual(columns.filter((c) => initial.some((before) => before.column_key === c.column_key)), initial);
    const audits = await existing.all('SELECT * FROM audit_log ORDER BY id');
    const repeated = await seedEigyoDemo(existing);
    assert.equal(repeated.salesSheet.skipped, true);
    assert.deepEqual(await existing.all('SELECT * FROM sales_sheet_column_versions ORDER BY column_key'), columns);
    assert.deepEqual(await existing.all('SELECT * FROM audit_log ORDER BY id'), audits);
  } finally { await existing.close(); }
});

test('売上集計シート: 海外の売上すべてに外貨（北米 USD・台湾 TWD）。外貨×レートは円の計上額と1円まで合い、通貨ごとの集計が書き下した値と一致する', async () => {
  const overseas = await sheetLines("p.code='DEMO-OS-A'");
  assert.ok(overseas.length > 0);
  assert.equal(summary.salesSheet.currencies, overseas.length);
  const expected = {};
  for (const line of overseas) {
    const {code, rate} = SALES_SHEET_RATES[line.territory];
    const original = Math.round(line.amount_ex_tax * 100 / Number(rate)) / 100;
    assert.ok(Math.abs(rounded(original * Number(rate), 0) - line.amount_ex_tax) <= 1, `${line.work_code} ${line.accounting_month}`);
    expected[code] ??= {foreign: 0, yen: 0};
    expected[code].foreign += original;
    expected[code].yen += original * Number(rate);
  }
  const body = (await api('GET', '/sales-sheet?set=mgflat&grain=aggregate&dims=currency&hideEmpty=0')).body;
  for (const [code, value] of Object.entries(expected)) {
    const row = body.rows.find((item) => item.dimkey_currency === code);
    assert.equal(row.foreign_amount, rounded(value.foreign, 2), code);
    assert.equal(row.exchange_rate, rounded(value.yen / value.foreign, 4), code);
  }
  // 取引先で集計すると通貨が混ざるので外貨の額は空（混ざったことを返す）
  const byPartner = (await api('GET', '/sales-sheet?set=mgflat&grain=aggregate&dims=partner&hideEmpty=0')).body;
  const row = byPartner.rows.find((item) => item.dimkey_partner === 'DEMO-OS-A');
  assert.equal(row.foreign_amount, null);
  assert.ok(row.__mixed.includes('foreign_amount'));
});

test('売上集計シート: 劇場の売上に劇場名・券種、配信Aに視聴UU数（計上額÷120）、レンタルに延滞・回転率が入る', async () => {
  const body = (await api('GET', '/sales-sheet?set=all&pageSize=500&hideEmpty=0&kind=theatrical')).body;
  for (const item of THEATRE_ATTRIBUTES) {
    const lines = await sheetLines("w.code=? AND r.kind='theatrical'", [item.workCode]);
    assert.ok(lines.length > 0, item.workCode);
    for (const line of lines) {
      const row = body.rows.find((r) => r.__id === line.id);
      assert.deepEqual([row.theatre_name, row.ticket_category, row.ticket_unit_inc_tax], [item.theatre, item.category, Number(item.unitIncTax)]);
    }
  }
  const uu = await db.all("SELECT a.sale_id,a.value_number,s.amount_ex_tax FROM sale_attribute_values a JOIN sale_lines s ON s.org_id=a.org_id AND s.id=a.sale_id WHERE a.org_id=? AND a.column_key='unique_viewers'", [orgId]);
  assert.equal(uu.length, 5 * 6);
  // value_number は型なしの列。PostgreSQL の入口は Decimal の文字列で返す（FR-CORE-DATA-013）ので、数にして比べる（型は列の CHECK が守る）
  for (const row of uu) assert.equal(Number(row.value_number), Math.max(1, Math.round(row.amount_ex_tax / 120)));
  const rental = await db.all("SELECT a.column_key,COUNT(*) AS n,SUM(a.value_number) AS total FROM sale_attribute_values a WHERE a.org_id=? AND a.column_key IN ('overdue_count','overdue_amount','overdue_share','rental_turnover') GROUP BY a.column_key ORDER BY a.column_key", [orgId]);
  // W01〜W04 のレンタルの最初の4か月: 延滞数は 3,5,7,9 → 1作品24、4作品で96
  assert.deepEqual(rental.map((row) => [row.column_key, row.n]), [['overdue_amount', 16], ['overdue_count', 16], ['overdue_share', 16], ['rental_turnover', 16]]);
  assert.equal(rental.find((row) => row.column_key === 'overdue_count').total, 4 * (3 + 5 + 7 + 9));
  assert.equal(summary.salesSheet.attributes, uu.length + 16 * 4 + (await db.get("SELECT COUNT(*) AS n FROM sale_attribute_values WHERE org_id=? AND column_key IN ('theatre_name','ticket_category','ticket_unit_inc_tax')", [orgId])).n);
});

test('売上集計シート: 組織1（既存の架空データ）からは DEMO-SALES の列・値が見えない', async () => {
  const outsider = await (async () => {
    const app = createApp({db, mode: 'local'});
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'editor@openingnight.invalid'})});
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return async (path) => { const res = await app.request(`/api${path}`, {headers: {cookie}}); return {status: res.status, body: await res.json()}; };
  })();
  const other = await outsider('/sales-sheet?set=basic');
  assert.equal(other.status, 200);
  assert.equal(other.body.adopted, false, '組織1は列を採用していない');
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM sale_attribute_values WHERE org_id<>?", [orgId])).n, 0);
});

// ---------- 提案資料（節4） ----------
// 月の件数・SVOD の提案金額は、計画（windowPlan・proposalWindowPlan・partnerListPlan・svodPricePlan）からこの試験の中で書き下した決まりで数え直す
// （release-proposal-model の関数は使わない）
const monthOfStart = (start) => (/^\d{4}-\d{2}-\d{2}$/.test(start || '') ? start.slice(0, 7) : /^\d{4}-\d{2}$/.test(start || '') ? start : null);
const BASIS_TYPES = {pvod: ['pvod_early', 'pvod_second'], tvod: ['tvod_regular'], tvod_early: ['tvod_early'], est_early: ['est_early'], est: ['est_regular']};
function expectedMonthCount(basis, month) {
  return allWindowPlan().filter((item) => BASIS_TYPES[basis].includes(item.typeKey)).map((item) => item.versions.at(-1))
    .filter((last) => last.status !== 'withdrawn' && monthOfStart(last.start) === month).length;
}
const nextMonths = ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];

test('提案資料: 節4は1回だけ入り（新作6本・窓・SVOD の単価・権利範囲・作品カタログ・作品情報）、2回目は何も足さない', () => {
  assert.equal(summary.proposals.skipped, false);
  assert.equal(again.result.proposals.skipped, true);
  assert.deepEqual({works: summary.proposals.works, windows: summary.proposals.windows, prices: summary.proposals.prices, rights: summary.proposals.rights, catalogs: summary.proposals.catalogs, profiles: summary.proposals.profiles},
    {works: 6, windows: proposalWindowPlan().length, prices: svodPricePlan().length, rights: proposalRightsPlan().length, catalogs: 26, profiles: 26});
  assert.equal(again.before.work_proposal_profiles, 26);
  assert.equal(again.before.catalog_profiles, 26);
  for (const work of PROPOSAL_DEMO.newWorks) assert.match(work.title, /（架空）$/);
});

test('提案資料: 来月（2026-10）から半年は5つの基準どれも資料が空にならず、月ごとの件数は計画から数え直した値と一致する', async () => {
  const body = (await api('GET', '/release-proposals')).body;
  for (const basis of body.bases) {
    for (const month of nextMonths) {
      const actual = basis.months.find((m) => m.month === month)?.count || 0;
      assert.ok(actual >= 1, `${basis.label} ${month} が空`);
      assert.equal(actual, expectedMonthCount(basis.key, month), `${basis.label} ${month}`);
    }
    // 過去の月（先行の窓は W09〜W20 の 2025-06〜2026-05、PVOD② は W13〜W20）も計画どおり
    for (const month of ['2025-06', '2025-10', '2026-03', '2026-05']) assert.equal(basis.months.find((m) => m.month === month)?.count || 0, expectedMonthCount(basis.key, month), `${basis.label} ${month}`);
  }
  assert.equal(expectedMonthCount('est_early', '2025-06'), 1);
  assert.equal(expectedMonthCount('pvod', '2025-10'), 2, 'W16 の PVOD先行と W13 の PVOD②');
  // 年だけ決まっている W08 の TVOD先行は、2026年の月の「月が決まっていない候補」に出て、表には入らない
  const tvodEarly = (await api('GET', '/release-proposals/tvod_early?month=2026-10')).body;
  assert.deepEqual(tvodEarly.undated.map((u) => u.work_code), ['DEMO-W08']);
  assert.ok(!tvodEarly.rows.some((r) => r.work_code === 'DEMO-W08'));
  assert.deepEqual((await api('GET', '/release-proposals/tvod_early?month=2027-01')).body.undated, []);
  // 「確定だけ」: 新作は N01・N02 だけ確定なので、2026-12 以降の EST基準は0件
  const confirmed = (await api('GET', '/release-proposals?status=confirmed')).body.bases.find((b) => b.key === 'est');
  assert.equal(confirmed.months.find((m) => m.month === '2026-10')?.count, 1);
  assert.equal(confirmed.months.find((m) => m.month === '2026-12')?.count || 0, 0);
});

test('提案資料: 来月の PVOD基準の Excel は新作の PVOD先行・PVOD② の2行で、作品情報・権利・クレジットが埋まり、空の列は「EST通常 配信期限」だけ（備考に予定のウィンドウ）', async () => {
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (await api('GET', '/release-proposals/pvod?month=2026-10')).body;
  assert.deepEqual(json.rows.map((r) => [r.work_code, r.basis_type, r.basis_start]), [['DEMO-N01', 'PVOD先行', '2026-10-02'], ['DEMO-N01', 'PVOD②', '2026-10-16']]);
  assert.deepEqual(json.emptyColumns, ['EST通常 配信期限']);
  // 状態の条件はほかのウィンドウの列にも効く: 予定＋確定なら予定の SVOD のウィンドウも出して備考に書き、確定だけなら空欄にする
  const early = json.rows[0];
  assert.deepEqual([early['svod_early:start'], early['svod_regular:field:price_ex_tax']], ['2027-01-01', 90000]);
  assert.match(early.note, /予定のウィンドウ: .*SVOD先行・SVOD通常/);
  const confirmedOnly = (await api('GET', '/release-proposals/pvod?month=2026-10&status=confirmed')).body.rows.find((r) => r.basis_type === 'PVOD先行');
  assert.deepEqual([confirmedOnly['svod_early:start'], confirmedOnly['svod_regular:field:price_ex_tax']], [null, null]);
  assert.match(confirmedOnly.note, /予定のウィンドウは出していません（.*SVOD先行・SVOD通常）/);
  const res = await app.request('/api/release-proposals/pvod/export.xlsx?month=2026-10', {headers: {cookie}});
  const [sheet] = decodeXlsx(new Uint8Array(await res.arrayBuffer()));
  const [header, ...rows] = sheet.rows;
  const at = (label) => rows[0][header.indexOf(label)];
  assert.equal(rows.length, 2);
  assert.deepEqual([at('フリガナ'), at('英題'), at('製作年'), at('権利期限')], ['シオミザカノユウビンハイタツ', 'The Shiomizaka Mail Carrier', 2026, '2033-09-30']);
  assert.match(at('クレジット'), /^監督: .+（架空）／脚本: .+（架空）／キャスト: /);
  assert.equal(at('SVOD先行 月額単価（税抜）'), 200000);
  assert.match(at('画像の参照'), /^https:\/\/example\.invalid\//);
});

test('提案資料: 配信A への SVOD の提案（2026-10〜2027-09）は、継続7・新規（新作6本＋連続ドラマ）・注意（W06・配信C の独占）で、提案金額は計画から数え直した値と一致する', async () => {
  const partner = (await db.get("SELECT id FROM partners WHERE org_id=? AND code='DEMO-PF-A'", [orgId])).id;
  const body = (await api('GET', `/svod-proposals?partnerId=${partner}&from=2026-10&to=2027-09`)).body;
  const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
  const months = (from, to) => monthIndex(to.slice(0, 7)) - monthIndex(from.slice(0, 7)) + 1;
  const nextDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const price = (code, typeKey) => svodPricePlan().find((p) => p.workCode === code && p.typeKey === typeKey)?.price ?? null;
  const plan = allWindowPlan();
  const svodWindow = (code, typeKey) => plan.find((item) => item.workCode === code && item.typeKey === typeKey)?.versions.at(-1);
  const expected = [];
  // 継続: 配信A の契約済み・日付で終わる明細で、終了日が期間の中（後に再契約が無いもの）。提案は翌日から、SVOD通常の窓の期限か期間の終わりまで
  const pfa = partnerListPlan().lists.find((l) => l.partnerCode === 'DEMO-PF-A');
  const entries = [...pfa.entries, ...pfa.renewals];
  for (const entry of entries) {
    if (entry.status !== 'contracted' || entry.rule !== 'date' || entry.end < '2026-10-01' || entry.end > '2027-09-30') continue;
    if (entries.some((other) => other !== entry && other.work === entry.work && other.start > entry.end)) continue;
    const window = svodWindow(entry.work, 'svod_regular');
    const start = [nextDay(entry.end), window.start].sort().at(-1);
    const end = [window.end, '2027-09-30'].sort()[0];
    expected.push(['継続', entry.work, start, end, months(start, end), price(entry.work, 'svod_regular')]);
  }
  // 新規: 配信A と明細の無い新作（SVOD先行の窓・公開の3か月後から）と連続ドラマ（SVOD先行 2026-10・単価なし）
  for (const work of PROPOSAL_DEMO.newWorks) {
    const window = svodWindow(work.code, 'svod_early');
    expected.push(['新規', work.code, window.start, '2027-09-30', months(window.start, '2027-09-30'), Number(window.fields.price_ex_tax)]);
  }
  expected.push(['新規', EIGYO_DEMO.seriesWork, '2026-10-01', '2027-09-30', 12, null]);
  // 注意: W06（配信A の明細は 2026-06-30 に終了、配信C の独占 2026-01〜2026-12 と重なる）。SVOD通常の窓（公開の20か月後から）
  const w06 = svodWindow('DEMO-W06', 'svod_regular');
  const w06start = [w06.start, '2026-10-01'].sort().at(-1);
  expected.push(['注意', 'DEMO-W06', w06start, '2027-09-30', months(w06start, '2027-09-30'), price('DEMO-W06', 'svod_regular')]);
  // 並びは 区分（継続 → 新規 → 注意）→ 作品コード
  const order = {継続: 0, 新規: 1, 注意: 2};
  expected.sort((a, b) => order[a[0]] - order[b[0]] || (a[1] < b[1] ? -1 : 1));
  const actual = body.rows.map((r) => [r.category_label, r.work_code, r.proposal_start, r.proposal_end, r.months, r.unit_price]);
  assert.deepEqual(actual, expected);
  for (const row of body.rows) assert.equal(row.amount, row.unit_price === null ? null : row.unit_price * row.months, row.work_code);
  const sum = (category) => expected.filter((e) => e[0] === category).reduce((n, e) => n + (e[5] === null ? 0 : e[5] * e[4]), 0);
  assert.deepEqual([body.subtotals.renewal.count, body.subtotals.new.count, body.subtotals.caution.count], [7, 7, 1]);
  assert.deepEqual([body.subtotals.renewal.amount, body.subtotals.new.amount, body.subtotals.caution.amount], [sum('継続'), sum('新規'), sum('注意')]);
  assert.equal(body.total.amount, sum('継続') + sum('新規') + sum('注意'));
  assert.match(body.rows.find((r) => r.work_code === 'DEMO-W06').blocking, /架空配信C・広告型（架空） 2026\/01\/01〜2026\/12\/31（独占）/);
});

test('提案資料: SVOD の提案先の選択肢は SVOD の明細がある取引先（配信A・配信C）が先。提案先の指定なし・2027年の DEMO-W02 は権利期限（2027-07-31）で狭める', async () => {
  const body = (await api('GET', '/svod-proposals?from=2026-10&to=2027-09')).body;
  assert.equal(body.partners[0].code, 'DEMO-PF-A');
  assert.deepEqual(body.partners.filter((p) => p.group === 'svod').map((p) => p.code).sort(), ['DEMO-PF-A', 'DEMO-PF-C']);
  assert.ok(body.partners.findIndex((p) => p.group !== 'svod') >= 2, 'SVOD の明細がある取引先の後にほかが続く');
  const none = (await api('GET', '/svod-proposals?partnerId=none&from=2027-01&to=2027-12')).body;
  const w02 = none.rows.find((r) => r.work_code === 'DEMO-W02');
  const price = svodPricePlan().find((p) => p.workCode === 'DEMO-W02' && p.typeKey === 'svod_regular').price;
  assert.deepEqual([w02.proposal_end, w02.months, w02.amount], ['2027-07-31', 7, price * 7]);
  assert.match(w02.note, /権利期限 2027\/07\/31/);
});

test('提案資料: 節4の登録はすべて API を通り、DDL を含まず、1つの値は128KB未満', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../scripts/seed-eigyo-demo.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|TRIGGER|VIEW)\b/i);
  assert.doesNotMatch(source, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i, 'DB へ直接書かない');
  const {catalogPlan, profilePlan} = await import('../scripts/seed-eigyo-demo.mjs');
  const limit = 128 * 1024;
  for (const work of [...Array.from({length: 20}, (_, i) => ({code: `DEMO-W${String(i + 1).padStart(2, '0')}`, title: '作品（架空）'})), ...PROPOSAL_DEMO.newWorks]) {
    for (const payload of [catalogPlan(work.code, work.title), profilePlan(work.code, work.title)]) {
      assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < limit, work.code);
    }
  }
  const audit = await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE org_id=? AND entity_type='work_proposal_profile'", [orgId]);
  assert.equal(Number(audit.n), 26, '作品情報の登録はすべて監査に残る');
});
