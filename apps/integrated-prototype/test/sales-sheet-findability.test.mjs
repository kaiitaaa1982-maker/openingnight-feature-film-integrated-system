// 売上集計シート（83列）を見つけやすくする変更（WP1-C）の試験。
// ・左メニュー 売上基幹 › 計上 › 帳票・分析 に「売上集計シート」（slug sales-sheet）。帳票センターの「よく使う帳票」にも出る。旧の URL（report-center&report=sales-sheet）も開く
// ・ロイヤリティの左メニューは「ロイヤリティ集計シート」（ページID・URL は変えない）
// ・未採用の組織: 採用前に列の一覧を返し、管理者以外には依頼先の管理者の名前を返す。採用は取り消せず監査に残る（2回目は 409）
// ・期間に行が無いとき、データのある最も新しい月を返す（画面の「データのある最新の年度を見る」）
// ・他の画面からのリンクは財務の権限がある人・作品だけ（GET /api/sales-sheet/access）
// ・表の列の並び: 明細は 計上月・作品コード・作品名（全列は 売上ID・作品コード）を左に固定、月を横に並べた集計は月を切り口の直後に（画面・Excel とも）
// ・流通IDの絞り込み・1ページの行数（100/200/500）は問い合わせに載る。帳票センターのカードを押したあと、読み込みでページが伸びたら送り直す
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv} from '../src/csv.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {INITIAL_SHEET_COLUMNS} from '../src/sales-sheet/column-registry.mjs';
import {SALES_PAGES} from '../src/navigation.mjs';
import {slugOf, pageOfSlug, displayLabel, menuGroups, pageScope} from '../src/shell/nav-model.mjs';
import {parseLocation} from '../src/shell/url-state.mjs';
import {featuredReports} from '../src/reports/report-catalog.mjs';
import {sheetQuery, sheetLayout, latestYearOffer, salesSheetLink, pageSizeOf, PAGE_SIZES} from '../src/sales-sheet/sheet-view-model.mjs';
import {createScrollFollower} from '../src/reports/scroll-follow.mjs';


test('入口: 左メニューの計上 › 帳票・分析に「売上集計シート」、よく使う帳票にもカード。旧の URL も開き、ロイヤリティ側は「ロイヤリティ集計シート」', () => {
  assert.ok(SALES_PAGES.includes('売上集計シート'));
  assert.equal(slugOf('売上集計シート'), 'sales-sheet');
  assert.equal(pageOfSlug('sales-sheet'), '売上集計シート');
  assert.equal(pageScope('売上集計シート'), 'company');
  const reports = menuGroups('sales', 'uriage').find((group) => group.id === 'reports');
  assert.deepEqual(reports.items.map((item) => item.label), ['帳票センター', '売上集計シート', '経費集計シート', '作品の月別収支', 'PL・BS', '分析']);
  assert.ok(featuredReports().some((entry) => entry.id === 'sales-sheet'), 'よく使う帳票に売上集計シート');
  assert.deepEqual(parseLocation('?p=report-center&report=sales-sheet'), {page: '帳票センター', workId: null, params: {report: 'sales-sheet'}});
  assert.equal(displayLabel('ロイヤリティ集計'), 'ロイヤリティ集計シート');
  assert.equal(slugOf('ロイヤリティ集計'), 'royalty-ledger', 'ページIDと URL は変えない');
});

test('問い合わせ: 流通IDと1ページの行数（100/200/500 だけ。100は既定なので載せない）', () => {
  assert.equal(new URLSearchParams(sheetQuery({set: 'basic', dist: 'D004', psize: '500'}, {from: '2025-05', to: '2026-04'})).get('distribution'), 'D004');
  assert.equal(new URLSearchParams(sheetQuery({set: 'basic', psize: '500'}, {})).get('pageSize'), '500');
  assert.equal(new URLSearchParams(sheetQuery({set: 'basic', psize: '100'}, {})).get('pageSize'), null);
  assert.equal(new URLSearchParams(sheetQuery({set: 'basic', psize: '9999'}, {})).get('pageSize'), null, '選択肢に無い値は既定に戻す');
  assert.deepEqual(PAGE_SIZES, [100, 200, 500]);
  assert.equal(pageSizeOf('200'), 200);
});

test('表の列: 明細は 計上月・作品コード・作品名 を左に固定、全列は 売上ID・作品コード。集計は 切り口（固定）→ 月 → 明細数 → 列', () => {
  const col = (key) => ({key, label: key});
  const basic = sheetLayout({grain: 'detail', columns: ['booking_month', 'sales_date', 'work_code', 'ref_work_title', 'partner_code', 'amount_ex_tax'].map(col)});
  assert.deepEqual(basic.map((item) => [item.key, item.sticky]), [['booking_month', true], ['work_code', true], ['ref_work_title', true], ['sales_date', false], ['partner_code', false], ['amount_ex_tax', false]]);
  const all = sheetLayout({grain: 'detail', columns: ['sale_id', 'distribution_code', 'sales_date', 'booking_month', 'royalty_month', 'work_code', 'product_code'].map(col)}, {allSet: true});
  assert.deepEqual(all.filter((item) => item.sticky).map((item) => item.key), ['sale_id', 'work_code']);
  assert.deepEqual(all.slice(0, 3).map((item) => item.key), ['sale_id', 'work_code', 'distribution_code']);
  const view = sheetLayout({grain: 'detail', columns: ['partner_code', 'amount_ex_tax'].map(col)});
  assert.deepEqual(view.filter((item) => item.sticky).map((item) => item.key), ['partner_code'], '固定する列が無い形は先頭だけ固定');
  const pivot = sheetLayout({grain: 'aggregate', dimensions: [{key: 'work', label: '作品'}, {key: 'partner', label: '取引先'}], months: ['2025-05', '2025-06'], columns: ['amount_ex_tax', 'tax_amount'].map(col)});
  assert.deepEqual(pivot.map((item) => item.key), ['dim_work', 'dim_partner', 'm_2025-05', 'm_2025-06', '__count', 'amount_ex_tax', 'tax_amount']);
  assert.deepEqual(pivot.filter((item) => item.sticky).map((item) => item.key), ['dim_work', 'dim_partner']);
});

test('データのある最新の年度: 期間に行が無く、別の年度にあるときだけ（開始月5月なら 2025-06 は2025年度）', () => {
  const offer = latestYearOffer({total: 0, latestMonth: '2025-06', fiscalYear: 2026, fiscalStartMonth: 5});
  assert.equal(offer.fiscalYear, 2025);
  assert.equal(offer.label, 'データのある最新の年度（2025年度）を見る');
  assert.match(offer.note, /最も新しいのは2025年6月です/);
  assert.equal(latestYearOffer({total: 0, latestMonth: '2026-04', fiscalYear: 2025, fiscalStartMonth: 5}), null, '同じ年度なら出さない');
  assert.equal(latestYearOffer({total: 3, latestMonth: '2025-06', fiscalYear: 2026, fiscalStartMonth: 5}), null, '行があれば出さない');
  assert.equal(latestYearOffer({total: 0, latestMonth: null, fiscalYear: 2026, fiscalStartMonth: 5}), null, 'どこにも無ければ出さない');
});

test('他の画面からのリンク: 財務の権限がある作品だけ。取引先だけで絞るリンクは財務の画面を使える人なら出す', () => {
  assert.deepEqual(salesSheetLink({canOpen: true, workIds: null}, {workId: 7, partnerId: 3}), {page: '売上集計シート', params: {workId: '7', partnerId: '3'}});
  assert.equal(salesSheetLink({canOpen: true, workIds: [1, 2]}, {workId: 7}), null, '権限の無い作品');
  assert.deepEqual(salesSheetLink({canOpen: true, workIds: [1]}, {partnerId: 3}), {page: '売上集計シート', params: {partnerId: '3'}});
  assert.equal(salesSheetLink({canOpen: false, workIds: []}, {workId: 1}), null, '制作担当');
  assert.equal(salesSheetLink(null, {workId: 1}), null, '読み込む前');
});

test('帳票センターのカード: 押した直後に1回送り、読み込みでページが伸びたら送り直し、落ち着いたらやめる。利用者が動かしたらやめる', () => {
  const f = createScrollFollower({maxMs: 5000, settleMs: 700});
  assert.deepEqual(f.step({now: 0, height: 40, busy: true, top: 600}), {action: 'scroll', behavior: 'smooth'});
  assert.deepEqual(f.step({now: 100, height: 40, busy: true, top: 579}), {action: 'wait'}, '読み込み中はまだ待つ（ページが短くて21pxしか動かない状態）');
  assert.deepEqual(f.step({now: 900, height: 40, busy: true, top: 579}), {action: 'wait'}, '読み込み中は高さが同じでもやめない');
  assert.deepEqual(f.step({now: 1000, height: 1800, busy: false, top: 579}), {action: 'scroll', behavior: 'auto'}, '表が出てページが伸びたら送り直す');
  assert.deepEqual(f.step({now: 1200, height: 1800, busy: false, top: 0}), {action: 'wait'});
  assert.deepEqual(f.step({now: 1800, height: 1800, busy: false, top: 0}), {action: 'done'});
  const user = createScrollFollower();
  user.step({now: 0, height: 10, top: 500});
  user.stop();
  assert.deepEqual(user.step({now: 50, height: 900, top: 500}), {action: 'done'}, '利用者がスクロールしたら送らない');
  const slow = createScrollFollower({maxMs: 2000});
  slow.step({now: 0, height: 10, busy: true});
  assert.deepEqual(slow.step({now: 2500, height: 10, busy: true}), {action: 'done'}, '読み込みが終わらなくても上限でやめる');
});

// ---------- API ----------
let db, app, admin, editor, production;
async function loginAs(email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())};
  };
  return {get: (path) => call('GET', path), post: (path, payload) => call('POST', path, payload)};
}
before(async (t) => {
  db = await openTestDb({t});
  app = createApp({db, mode: 'local'});
  admin = await loginAs('admin@openingnight.invalid');
  editor = await loginAs('editor@openingnight.invalid');
  production = await loginAs('production@openingnight.invalid');
});
after(() => db?.close());

test('未採用の組織: 採用前に列の一覧を返し、管理者以外には依頼先の管理者の名前を返す。採用は1回だけで監査に残る', async () => {
  const forAdmin = await admin.get('/sales-sheet/columns');
  assert.equal(forAdmin.status, 200);
  assert.equal(forAdmin.body.adopted, false);
  assert.equal(forAdmin.body.initialColumns.length, INITIAL_SHEET_COLUMNS.length);
  assert.equal(forAdmin.body.initialColumns.filter((column) => column.legacyPosition).length, 83);
  assert.deepEqual(forAdmin.body.initialColumns[0], {key: 'sale_id', label: '売上ID', legacyPosition: 1, group: 'identity', groupLabel: forAdmin.body.initialColumns[0].groupLabel});
  assert.deepEqual(forAdmin.body.admins, [], '管理者自身には依頼先を出さない');
  const forEditor = await editor.get('/sales-sheet/columns');
  assert.deepEqual(forEditor.body.admins, ['管理者'], '組織1の有効な管理者の名前だけ（別組織の管理者は出さない）');
  assert.equal(forEditor.body.canAdmin, false);
  assert.equal((await production.get('/sales-sheet/columns')).status, 403);
  assert.equal((await editor.post('/sales-sheet/columns/adopt', {reason: '依頼'})).status, 403);
  assert.equal((await admin.post('/sales-sheet/columns/adopt', {reason: '試験で採用'})).status, 201);
  assert.equal((await admin.post('/sales-sheet/columns/adopt', {reason: 'もう一度'})).status, 409, '採用は取り消せない（やり直せない）');
  const adopted = await admin.get('/sales-sheet/columns');
  assert.equal(adopted.body.adopted, true);
  assert.equal(adopted.body.initialColumns, undefined, '採用後は一覧を別に返さない');
  const audit = await db.get("SELECT action, detail_json FROM audit_log WHERE entity_type='sales_sheet_column' AND action='adopt'");
  assert.match(audit.detail_json, /試験で採用/);
});

test('期間に行が無いとき、期間を外した同じ条件でデータのある最も新しい月を返す（行があるとき・期間を指定しないときは返さない）', async () => {
  const base = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'accounting_month', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax'];
  for (const [key, month, ex] of [['FIND-2025-06', '2025-06', 120000], ['FIND-2024-11', '2024-11', 80000]]) {
    const preview = await admin.post('/imports/preview', {kind: 'digital', workId: 1, text: toCsv(base, [[key, 2, 1, `${month}-01`, `${month}-28`, month, '配信（架空）', '', ex, ex / 10, ex + ex / 10]])});
    assert.equal(preview.body.ok, true, JSON.stringify(preview.body.errors));
    assert.equal((await admin.post('/imports/commit', {token: preview.body.token})).status, 200);
  }
  const empty = await admin.get('/sales-sheet?from=2026-05&to=2027-04&set=basic');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.total, 0);
  assert.equal(empty.body.latestMonth, '2025-06');
  const aggregate = await admin.get('/sales-sheet?from=2026-05&to=2027-04&set=basic&grain=aggregate&dims=work');
  assert.equal(aggregate.body.latestMonth, '2025-06');
  const filtered = await admin.get('/sales-sheet?from=2026-05&to=2027-04&set=basic&partnerId=3');
  assert.equal(filtered.body.latestMonth, null, 'ほかの条件（取引先）は外さない');
  const found = await admin.get('/sales-sheet?from=2025-05&to=2026-04&set=basic');
  assert.equal(found.body.total, 1);
  assert.equal(found.body.latestMonth, null);
  assert.equal((await admin.get('/sales-sheet?set=basic')).body.latestMonth, null);
  // 1ページの行数・流通ID（分類していない配信は「配信・区分未確認」）
  const page = await admin.get('/sales-sheet?from=2024-05&to=2026-04&set=basic&pageSize=200&distribution=digital_unknown');
  assert.equal(page.body.pageSize, 200);
  assert.equal(page.body.total, 2);
  assert.equal((await admin.get('/sales-sheet?from=2024-05&to=2026-04&set=basic&distribution=D004')).body.total, 0);
});

test('月を横に並べた集計の Excel は、月の列を切り口の直後に置く（画面と同じ並び）', async () => {
  const out = await admin.get('/sales-sheet/export.xlsx?from=2024-05&to=2026-04&set=basic&grain=aggregate&dims=work&pivot=1');
  assert.equal(out.status, 200);
  const [sheet] = decodeXlsx(out.body);
  const header = sheet.rows.find((row) => row.includes('作品') && row.includes('明細数'));
  const at = (label) => header.findIndex((cell) => String(cell).startsWith(label));
  assert.equal(at('作品'), 0);
  assert.equal(at('2024-05'), 1, `見出し: ${header.slice(0, 5).join(' / ')}`);
  assert.ok(at('2026-04') < at('明細数'), '月の列は明細数より前');
  assert.ok(at('明細数') < at('計上月'));
});

test('他の画面からのリンクの権限: 管理者は全作品、編集担当は財務の権限がある作品だけ、制作担当は開けない', async () => {
  assert.deepEqual((await admin.get('/sales-sheet/access')).body, {ok: true, canOpen: true, workIds: null});
  assert.deepEqual((await editor.get('/sales-sheet/access')).body, {ok: true, canOpen: true, workIds: [1]});
  const production403 = await production.get('/sales-sheet/access');
  assert.equal(production403.status, 200);
  assert.deepEqual(production403.body, {ok: true, canOpen: false, workIds: []});
});

// ---------- 画面（DOM は使わず文字列に描く） ----------
test('未採用の案内: 列の一覧・取り消せないこと・監査・依頼先の管理者の名前・採用済みの別の組織への切替', async () => {
  const {transformSync} = await import('esbuild');
  const hooks = registerHooks({load(url, context, nextLoad) {
    if (url.endsWith('.css')) return {format: 'module', source: '', shortCircuit: true};
    if (url.endsWith('.jsx')) return {format: 'module', source: transformSync(readFileSync(new URL(url), 'utf8'), {loader: 'jsx', format: 'esm'}).code, shortCircuit: true};
    return nextLoad(url, context);
  }});
  let AdoptionGuide;
  try { ({AdoptionGuide} = await import('../src/sales-sheet/SalesSheet.jsx')); } finally { hooks.deregister(); }
  const render = (props) => renderToStaticMarkup(React.createElement(AdoptionGuide, props));
  const initialColumns = INITIAL_SHEET_COLUMNS.map((column) => ({key: column.column_key, label: column.label, legacyPosition: column.legacy_position ?? null, groupLabel: column.group_key}));
  const editorView = render({catalog: {adopted: false, canAdmin: false, initialCount: initialColumns.length, initialColumns, admins: ['架空の管理者A', '架空の管理者B']},
    adoptedElsewhere: [{id: 3, name: '架空データ（デモ）'}], onSwitchOrg: async () => true});
  assert.match(editorView, /採用は取り消せません。/);
  assert.match(editorView, /監査の記録に残ります/);
  assert.match(editorView, /採用する列の一覧を見る（103列）/);
  assert.match(editorView, /この組織の管理者（架空の管理者A・架空の管理者B）に、初期の83列の採用を依頼してください。/);
  assert.match(editorView, /組織「架空データ（デモ）」では採用済みで、表を見られます。/);
  assert.match(editorView, /組織「架空データ（デモ）」に切り替えて売上集計シートを開く/);
  assert.doesNotMatch(editorView, /初期の83列を採用する<\/button>/, '管理者以外に採用のボタンは出さない');
  const adminView = render({catalog: {adopted: false, canAdmin: true, initialCount: initialColumns.length, initialColumns, admins: []}, reason: '', adoptedElsewhere: []});
  assert.match(adminView, /<button type="button" disabled="">初期の83列を採用する<\/button>/, '理由を書くまで押せない');
  assert.doesNotMatch(adminView, /切り替えて売上集計シートを開く/);
});
