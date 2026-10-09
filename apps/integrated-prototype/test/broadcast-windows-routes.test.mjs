// 放送ウィンドウ提案・放送アベイルズリスト・放送の項目（局の種別・許諾回数・ホールドバック）の API。
// 画面と同じ API で材料（権利・放送の解禁・放送用の商品・取引先別リスト）を登録し、提案・Excel を読み戻して照合する。
// 壊れたら: 別組織・権限外の作品が出る、0件の指定で全作品の一覧が出る、提案を見ただけで何かが登録される、版の食い違いで上書きされる。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {availsMatchResult} from '../src/broadcast/avails-list-model.mjs';

let db, call, adminWork, broadcastEntry, digitalEntry, exclusiveEntry, productId;
const asOf = '2026-09-26';
before(async (t) => {
  db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const cookies = {admin: await login('admin@openingnight.invalid'), editor: await login('editor@openingnight.invalid'), production: await login('production@openingnight.invalid'), outsider: await login('outsider@other.invalid')};
  call = async (path, {method = 'GET', body, as = 'admin'} = {}) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie: cookies[as], ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    const type = res.headers.get('content-type') || '';
    return {status: res.status, data: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()), headers: res.headers};
  };
  const ok = async (path, body, as = 'admin') => { const r = await call(path, {method: 'POST', body, as}); assert.ok(r.status < 300, `${path}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
  const project = await ok('/projects', {code: 'PRJ-ADMIN', title: '管理者だけの案件', status: 'active', budget_yen: 0});
  adminWork = (await ok('/works', {project_id: project.id, code: 'WRK-ADMIN', title: '管理者だけの作品', format: 'film'})).id;
  await ok('/works', {project_id: project.id, code: 'WRK-ADMIN2', title: '管理者だけの作品・続編', format: 'film'});
  // 材料: 放送の解禁（全作品のウィンドウ）・権利範囲（放送・日本）・放送用の商品・取引先別リストの放送の明細
  await ok('/release-window-types/adopt', {reason: '試験の組織で初期の種別を採用'});
  const broadcastType = (await call('/release-window-types')).data.types.find((t) => t.type_key === 'broadcast');
  await ok('/release-windows', {workId: 1, typeId: broadcastType.id, baseVersion: 0, start: '2026-10-01', end: '2030-03-31', announce: '', status: 'confirmed', fields: {}, sourceReference: '架空の資料', reason: '放送の解禁'});
  await ok('/intakes', {workId: 1, caseCode: 'WRK-DEMO-TV', title: '放送の権利（架空）', intakeType: 'sole_owned', documents: [{title: '許諾書（架空）', reference: '架空', versionLabel: '第1版'}],
    scopes: [{channel: '放送', territory: '日本', rightsStart: '2024-01-01', rightsEnd: '2031-12-31', exclusivity: 'exclusive'}], participants: [{partyKind: 'current_org', role: '権利保有'}]});
  productId = (await ok('/products', {sku: 'SKU-TV', name: '放送権（架空）', channel: 'broadcast'})).id;
  await ok('/product-works', {productId, allocations: [{workId: 1, allocationBps: 10000}]});
  const list = await ok('/partner-lists', {partnerId: 2, listKind: 'distribution', name: '放送の許諾（架空）', reason: '試験'});
  const add = async (values) => (await ok(`/partner-lists/${list.id}/entries`, {workId: 1, values: {territory: '日本', source_reference: '架空の許諾通知', ...values}, reason: '試験'})).entryId;
  exclusiveEntry = await add({distribution_code: 'B001', contract_start: '2027-01-01', contract_end: '2027-06-30', end_rule: 'date', exclusivity: 'exclusive', status: 'contracted'});
  broadcastEntry = await add({distribution_code: 'B002', contract_start: '2026-10-01', contract_end: '2026-12-31', end_rule: 'date', exclusivity: 'nonexclusive', status: 'contracted'});
  digitalEntry = await add({distribution_code: 'D005', contract_start: '2026-10-01', contract_end: '2027-12-31', end_rule: 'date', exclusivity: 'nonexclusive', status: 'contracted'});
});
after(() => db?.close());

test('局の種別は版で積み、理由と監査が残り、版の食い違い・知らない種別・制作担当・別組織の取引先は止める', async () => {
  let r = await call('/broadcast/station-types');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.types, {terrestrial: '地上波', bs: 'BS', cs: 'CS', catv: 'CATV', streaming: '配信', other: 'その他'});
  assert.deepEqual(r.data.stations, [], 'まだ放送局の区分も種別も無い');
  assert.equal((await call('/broadcast/station-types', {method: 'POST', body: {partnerId: 2, stationType: 'bs', baseVersion: 0, reason: '架空の局の種別'}})).status, 201);
  assert.equal((await call('/broadcast/station-types', {method: 'POST', body: {partnerId: 2, stationType: 'cs', baseVersion: 0, reason: '古い画面から'}})).status, 409);
  assert.equal((await call('/broadcast/station-types', {method: 'POST', body: {partnerId: 2, stationType: 'satellite', baseVersion: 1, reason: 'x'}})).status, 400);
  assert.equal((await call('/broadcast/station-types', {method: 'POST', body: {partnerId: 2, stationType: 'cs', baseVersion: 1, reason: ''}})).status, 400, '理由は必須');
  assert.equal((await call('/broadcast/station-types', {method: 'POST', body: {partnerId: 2, stationType: 'cs', baseVersion: 1, reason: 'x'}, as: 'production'})).status, 403);
  assert.equal((await call('/broadcast/station-types', {method: 'POST', body: {partnerId: 2, stationType: 'cs', baseVersion: 0, reason: 'x'}, as: 'outsider'})).status, 404, '別組織の取引先は無いものとして扱う');
  assert.equal((await call('/broadcast/station-types', {method: 'POST', body: {partnerId: 2, stationType: 'cs', baseVersion: 1, reason: '局の編成替え'}, as: 'editor'})).status, 201);
  r = await call('/broadcast/station-types');
  assert.deepEqual(r.data.stations.map((s) => [s.code, s.station_type, s.version_no]), [['PT-DIGITAL', 'cs', 2]]);
  assert.equal((await call('/broadcast/station-types', {as: 'outsider'})).data.stations.length, 0);
  assert.equal(Number((await db.get("SELECT COUNT(*) n FROM audit_log WHERE entity_type='broadcast_station_type'")).n), 2);
  await assert.rejects(db.run("UPDATE broadcast_station_type_versions SET station_type='other'"), /immutable/);
  await assert.rejects(db.run('DELETE FROM broadcast_station_type_versions'), /immutable/);
  await assert.rejects(db.run("INSERT INTO broadcast_station_type_versions(org_id,partner_id,version_no,station_type,reason,created_by) VALUES(1,2,5,'bs','飛ばした版',1)"), /stale/);
});

test('許諾回数とホールドバックは放送の明細にだけ版で付け、編集権限と版を確かめ、変わらない登録は止める', async () => {
  const path = (id) => `/partner-list-entries/${id}/broadcast-terms`;
  assert.equal((await call(path(broadcastEntry), {method: 'POST', body: {baseVersion: 0, licensedRuns: '3', holdbackMonths: '3', reason: '許諾通知の条件'}, as: 'editor'})).status, 201);
  assert.equal((await call(path(broadcastEntry), {method: 'POST', body: {baseVersion: 0, licensedRuns: 4, holdbackMonths: 3, reason: '古い画面'}})).status, 409);
  assert.equal((await call(path(broadcastEntry), {method: 'POST', body: {baseVersion: 1, licensedRuns: 3, holdbackMonths: 3, reason: '同じ'}})).status, 400, '前の版と同じ');
  assert.equal((await call(path(broadcastEntry), {method: 'POST', body: {baseVersion: 1, licensedRuns: 0, holdbackMonths: 3, reason: 'x'}})).status, 400, '許諾回数は1以上');
  assert.equal((await call(path(broadcastEntry), {method: 'POST', body: {baseVersion: 1, licensedRuns: 2, holdbackMonths: 121, reason: 'x'}})).status, 400);
  assert.equal((await call(path(digitalEntry), {method: 'POST', body: {baseVersion: 0, licensedRuns: 2, reason: '配信の明細'}})).status, 400, '配信の明細には付けない');
  assert.equal((await call(path(broadcastEntry), {method: 'POST', body: {baseVersion: 1, licensedRuns: 2, reason: 'x'}, as: 'production'})).status, 403);
  assert.equal((await call(path(broadcastEntry), {method: 'POST', body: {baseVersion: 1, licensedRuns: 2, reason: 'x'}, as: 'outsider'})).status, 404);
  const history = await call(path(broadcastEntry));
  assert.equal(history.status, 200);
  assert.deepEqual([history.data.current.licensed_runs, history.data.current.holdback_months, history.data.versions.length], [3, 3, 1]);
  assert.deepEqual((await call('/broadcast/entry-terms')).data.terms.map((t) => [t.entry_id, t.licensed_runs]), [[broadcastEntry, 3]]);
  assert.deepEqual((await call('/broadcast/entry-terms', {as: 'outsider'})).data.terms, []);
  // 表の決まり: 放送の明細だけ・版は順に・変更と削除は禁止
  await assert.rejects(db.run("INSERT INTO broadcast_entry_term_versions(org_id,entry_id,version_no,licensed_runs,reason,created_by) VALUES(1,?,1,2,'直接',1)", [digitalEntry]), /need a broadcast entry/);
  await assert.rejects(db.run("UPDATE broadcast_entry_term_versions SET licensed_runs=9"), /immutable/);
  await assert.rejects(db.run("INSERT INTO broadcast_entry_term_versions(org_id,entry_id,version_no,licensed_runs,reason,created_by) VALUES(2,?,1,2,'別組織',4)", [broadcastEntry]), (e) => e.dbError?.kind === 'foreign_key' || (e.dbError?.kind === 'raise' && /need a broadcast entry/.test(e.message)), '別組織の明細には付けられない');
  await assert.rejects(db.run("INSERT INTO broadcast_station_type_versions(org_id,partner_id,version_no,station_type,reason,created_by) VALUES(2,2,1,'bs','別組織の取引先',4)"), (e) => e.dbError?.kind === 'foreign_key', '別組織の取引先には付けられない');
});

test('放送ウィンドウ提案: 権利∩放送の解禁∩24か月から独占とホールドバックを引き、非独占は同時期の他局に出し、何も登録しない', async () => {
  const counts = async () => Object.fromEntries(await Promise.all(['broadcast_slots', 'partner_list_entries', 'partner_list_entry_versions', 'broadcast_entry_term_versions', 'audit_log'].map(async (t) => [t, Number((await db.get(`SELECT COUNT(*) n FROM ${t}`)).n)])));
  const beforeCounts = await counts();
  const r = await call(`/broadcast/window-proposals?asOf=${asOf}&workId=1`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.readOnly, true);
  assert.equal(r.data.rows.length, 1);
  const row = r.data.rows[0];
  assert.deepEqual([row.product_sku, row.state], ['SKU-TV', 'ok']);
  // 独立に書き下した期待値: 権利 2024-01-01〜2031-12-31 ∩ 解禁 2026-10-01〜2030-03-31 ∩ 2026-09-26〜2028-09-26 ＝ 2026-10-01〜2028-09-26
  // 独占 2027-01-01〜2027-06-30、非独占 2026-10-01〜2026-12-31 のホールドバック3か月＝2027-01-01〜2027-03-31（独占と重なる）
  assert.deepEqual(row.result.allowed, [{from: '2026-10-01', to: '2028-09-26'}]);
  assert.deepEqual(row.result.proposals.map((p) => [p.from, p.to]), [['2026-10-01', '2026-12-31'], ['2027-07-01', '2028-09-26']]);
  assert.deepEqual(row.result.blocked.map((b) => [b.kind, b.from, b.to]), [['exclusive', '2027-01-01', '2027-06-30'], ['holdback', '2027-01-01', '2027-03-31']]);
  assert.deepEqual(row.result.proposals[0].others.map((o) => [o.station, o.kind]), [['架空配信', 'nonexclusive']]);
  assert.match(row.license_text, /架空配信: 3回中0回（残り3回）・ホールドバック3か月/);
  assert.match(row.basis_text, /権利: 2024\/01\/01〜2031\/12\/31/);
  assert.deepEqual(await counts(), beforeCounts, '提案を見ても何も登録しない');
  // 全作品: 放送用の商品が無い作品は作品全体の行（権利が無いので提案なし）
  const all = await call(`/broadcast/window-proposals?asOf=${asOf}`);
  assert.deepEqual(all.data.rows.map((x) => [x.work_code, x.product_sku || null, x.state]), [['WRK-ADMIN', null, 'blocked'], ['WRK-ADMIN2', null, 'blocked'], ['WRK-DEMO', 'SKU-TV', 'ok']]);
  assert.deepEqual(all.data.counts, {rows: 3, ok: 1, full: 0, blocked: 2});
  assert.deepEqual((await call(`/broadcast/window-proposals?asOf=${asOf}`, {as: 'editor'})).data.rows.map((x) => x.work_code), ['WRK-DEMO']);
  assert.equal((await call('/broadcast/window-proposals', {as: 'production'})).status, 403);
  assert.equal((await call('/broadcast/window-proposals?workId=1', {as: 'outsider'})).status, 403);
  assert.equal((await call('/broadcast/window-proposals?asOf=2026-02-30')).status, 400);
  const x = await call(`/broadcast/window-proposals/export.xlsx?asOf=${asOf}&workId=1`);
  assert.equal(x.status, 200);
  const [sheet] = decodeXlsx(x.data);
  assert.equal(sheet.name, '放送ウィンドウ提案');
  assert.deepEqual(sheet.rows[4], ['作品コード', '作品名', '品番', '商品名', '判定', '放送してよい期間', '根拠', '独占・ホールドバックで塞がっている期間', '提案する期間', '初回／再放送', '同時期の他局', '直近の放送局（3局まで）', '許諾回数と残り', '要確認の理由']);
  assert.deepEqual(sheet.rows[5].slice(0, 5), ['WRK-DEMO', '風のあとさき', 'SKU-TV', '放送権（架空）', '提案あり']);
  assert.equal(sheet.rows[5][8], '2026/10/01〜2026/12/31\n2027/07/01〜2028/09/26');
});

test('放送アベイルズリスト: 貼り付けた作品名を一致・候補が複数・見つからないに分け、選んだ順に17列で出し、0件では全件に落とさず止める', async () => {
  const match = await call('/broadcast/availability-list/match', {method: 'POST', body: {text: '風のあとさき\n\nｗｒｋ－ｄｅｍｏ\n管理者だけ\n管理者だけの作品\n存在しない作品（架空）\nSKU-TV'}});
  assert.equal(match.status, 200);
  assert.deepEqual(match.data.rows.map((r) => [r.input, r.status, r.candidates.map((c) => c.code)]), [
    ['風のあとさき', 'matched', ['WRK-DEMO']],
    ['ｗｒｋ－ｄｅｍｏ', 'matched', ['WRK-DEMO']],
    ['管理者だけ', 'ambiguous', ['WRK-ADMIN', 'WRK-ADMIN2']],
    ['管理者だけの作品', 'matched', ['WRK-ADMIN']],
    ['存在しない作品（架空）', 'not_found', []],
    ['SKU-TV', 'matched', ['WRK-DEMO']],
  ]);
  assert.deepEqual(match.data.counts, {matched: 4, ambiguous: 1, not_found: 1, prefix: 0, partial: 0});
  // 前方一致の1件（1文字の「風」・作品コードの途中まで）は一致に数え、利用者が確かめて入れる件数（prefix）にも数える
  const prefixMatch = await call('/broadcast/availability-list/match', {method: 'POST', body: {text: '風\nwrk-dem'}});
  assert.deepEqual(prefixMatch.data.rows.map((r) => [r.input, r.status, r.level, r.candidates.map((c) => c.code)]), [['風', 'matched', 'prefix', ['WRK-DEMO']], ['wrk-dem', 'matched', 'prefix', ['WRK-DEMO']]]);
  assert.deepEqual(prefixMatch.data.counts, {matched: 2, ambiguous: 0, not_found: 0, prefix: 2, partial: 0});
  const editorMatch = await call('/broadcast/availability-list/match', {method: 'POST', body: {text: '管理者だけ'}, as: 'editor'});
  assert.equal(editorMatch.data.rows[0].status, 'not_found', '権限の無い作品は候補に出ない');
  assert.equal((await call('/broadcast/availability-list/match', {method: 'POST', body: {text: Array.from({length: 201}, (_, n) => `作品${n}`).join('\n')}})).status, 400, '201行は止める');
  assert.equal((await call('/broadcast/availability-list/match', {method: 'POST', body: {text: ' \n '}})).status, 400);
  assert.equal((await call('/broadcast/availability-list/match', {method: 'POST', body: {text: 'x'}, as: 'production'})).status, 403);

  const x = await call(`/broadcast/availability-list/export.xlsx?asOf=${asOf}&workIds=${adminWork},1`);
  assert.equal(x.status, 200);
  assert.match(decodeURIComponent(x.headers.get('content-disposition')), /放送アベイルズリスト_管理者だけの作品他1件_\d{8}\.xlsx/);
  const [sheet] = decodeXlsx(x.data);
  assert.equal(sheet.name, '放送アベイルズリスト');
  assert.deepEqual(sheet.rows[4], ['区分', '品番', '作品名', 'ジャンル', '一次利用（劇場公開・DVD発売）', '製作年', '直近の放送局（3局まで）', '直近の放送履歴', '放送アベイルズ状況',
    'メモ（SVOD の解禁状況）', '出演', '監督', '時間', '画質・字幕・吹替', 'イントロダクション', 'あらすじ', 'コピーライト']);
  const rows = sheet.rows.slice(5).filter((r) => r[2]);
  assert.deepEqual(rows.slice(0, 2).map((r) => r[2]), ['管理者だけの作品', '風のあとさき'], '選んだ順');
  assert.equal(rows[1][1], 'SKU-TV');
  assert.equal(rows[1][6], '放送実績なし');
  assert.match(rows[1][8], /^放送可：2026年10月1日〜2026年12月31日 ほか1区間（同時期に他局あり）／独占契約中：〜2027年6月30日（架空配信）$/);
  assert.match(rows[0][8], /^要確認：権利範囲が未登録/);
  // 0件（権限外・存在しない ID だけ）は全件に落とさず 400
  const empty = await call(`/broadcast/availability-list/export.xlsx?workIds=${adminWork},99999`, {as: 'editor'});
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /全作品は出力しません/);
  assert.equal((await call('/broadcast/availability-list/export.xlsx?workIds=')).status, 400);
  assert.equal((await call(`/broadcast/availability-list/export.xlsx?workIds=${Array.from({length: 201}, (_, n) => n + 1).join(',')}`)).status, 400);
  assert.equal((await call('/broadcast/availability-list/export.xlsx?workIds=1', {as: 'outsider'})).status, 400, '別組織からは0件');
});

test('照合の元（candidates）は照合と同じ範囲で、同じ純関数で組み立てると照合の API と同じ結果になる（閲覧用プレビューの照合に使う）', async () => {
  const text = '風のあとさき\nｗｒｋ－ｄｅｍｏ\n管理者だけ\n存在しない作品（架空）\nSKU-TV';
  const source = await call('/broadcast/availability-list/candidates');
  assert.equal(source.status, 200);
  const api = await call('/broadcast/availability-list/match', {method: 'POST', body: {text}});
  const local = availsMatchResult(text, source.data);
  assert.deepEqual({rows: local.rows, counts: local.counts}, {rows: api.data.rows, counts: api.data.counts});
  assert.deepEqual(api.data.counts, {matched: 3, ambiguous: 1, not_found: 1, prefix: 0, partial: 0});
  // 範囲は照合と同じ: 編集者には権限外の作品もその商品も出ない。制作担当は 403
  const editor = await call('/broadcast/availability-list/candidates', {as: 'editor'});
  assert.ok(!editor.data.works.some((w) => w.code === 'WRK-ADMIN'), '権限外の作品は出ない');
  assert.ok(editor.data.products.every((p) => editor.data.works.some((w) => w.id === p.work_id)), '権限外の作品の商品は出ない');
  assert.equal((await call('/broadcast/availability-list/candidates', {as: 'production'})).status, 403);
  const outsider = await call('/broadcast/availability-list/candidates', {as: 'outsider'});
  assert.ok(!(outsider.data.works || []).some((w) => w.code === 'WRK-DEMO'), '別組織の作品は出ない');
});

test('放送アベイルズリストのジャンル・コピーライトは、提案資料に出す作品情報（営業基幹）の最新の版から出す', async () => {
  const columnOf = (sheet, label) => sheet.rows[4].indexOf(label);
  const rowOf = (sheet, title) => sheet.rows.slice(5).find((r) => r[2] === title);
  const before = decodeXlsx((await call(`/broadcast/availability-list/export.xlsx?asOf=${asOf}&workIds=1`)).data)[0];
  assert.equal(rowOf(before, '風のあとさき')[columnOf(before, 'ジャンル')] ?? '', '', '作品情報が無ければ空欄（推測で埋めない）');
  const post = (payload) => call('/work-proposal-profiles/1', {method: 'POST', body: payload});
  assert.equal((await post({baseRevision: 0, genre: 'ドラマ', copyright_notice: '©2026 架空（架空）', source_reference: '試験の宣伝資料'})).status, 201);
  assert.equal((await post({baseRevision: 1, genre: 'ヒューマンドラマ', copyright_notice: '©2026 架空（架空）', source_reference: '試験の宣伝資料（改訂）'})).status, 201);
  const after = decodeXlsx((await call(`/broadcast/availability-list/export.xlsx?asOf=${asOf}&workIds=1`)).data)[0];
  const row = rowOf(after, '風のあとさき');
  assert.equal(row[columnOf(after, 'ジャンル')], 'ヒューマンドラマ', '最新の版');
  assert.equal(row[columnOf(after, 'コピーライト')], '©2026 架空（架空）');
});

// ---------- 見直しで足した試験（材料を書き足すので最後に置く） ----------
test('許諾回数の行に取引先とリストを返す（放送ウィンドウ提案から取引先別リストへ移って入れるため）。局の種別の一覧は保存の後に読み直す', async () => {
  const row = (await call(`/broadcast/window-proposals?asOf=${asOf}&workId=1`)).data.rows[0];
  const license = row.result.licenses.find((l) => l.entryId === broadcastEntry);
  assert.equal(license.partnerId, 2);
  assert.ok(Number.isInteger(license.listId) && license.listId > 0);
  const {readFileSync} = await import('node:fs');
  const terms = readFileSync(new URL('../src/broadcast/BroadcastTerms.jsx', import.meta.url), 'utf8');
  assert.match(terms, /<StationTypeEditor request=\{request\} partnerId=\{s\.partner_id\} readOnly=\{readOnly\} onSaved=\{load\} \/>/, '一覧の中の編集は保存の後に一覧を読み直す');
  assert.match(terms, /try \{ await onSaved\?\.\(\); \}/);
  const proposals = readFileSync(new URL('../src/broadcast/WindowProposals.jsx', import.meta.url), 'utf8');
  assert.match(proposals, /取引先別リストで入れる（明細 \{l\.entryId\}）/);
});

test('契約終了日 9999-12-31 の明細にホールドバックを付けても、提案とアベイルズの Excel は 400 にならない（終わりなしとして扱う）', async () => {
  const list = await call('/partner-lists', {method: 'POST', body: {partnerId: 3, listKind: 'distribution', name: '終わりの無い放送の許諾（架空）', reason: '試験'}});
  assert.equal(list.status, 201, JSON.stringify(list.data));
  const created = await call(`/partner-lists/${list.data.id}/entries`, {method: 'POST', body: {workId: 1, reason: '試験', values: {territory: '日本', source_reference: '架空', distribution_code: 'B001',
    contract_start: '2026-10-01', contract_end: '9999-12-31', end_rule: 'date', exclusivity: 'nonexclusive', status: 'contracted'}}});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const entryId = created.data.entryId;
  assert.equal((await call(`/partner-list-entries/${entryId}/broadcast-terms`, {method: 'POST', body: {baseVersion: 0, licensedRuns: 2, holdbackMonths: 3, reason: '試験'}})).status, 201);
  const proposals = await call(`/broadcast/window-proposals?asOf=${asOf}`);
  assert.equal(proposals.status, 200, JSON.stringify(proposals.data));
  assert.ok(!proposals.data.rows.find((r) => r.work_id === 1).result.blocked.some((b) => b.entryId === entryId), 'ホールドバックは付かない');
  const xlsx = await call(`/broadcast/availability-list/export.xlsx?asOf=${asOf}&workIds=1,${adminWork}`);
  assert.equal(xlsx.status, 200);
});

test('販売条件（作品共通・放送）の最新の版が取り下げなら提案なし、改訂中の下書きなら直前の確認済みの期間で計算し、どちらも要確認に出す', async () => {
  const post = (payload) => call('/broadcast/conditions', {method: 'POST', body: {workId: 1, distributionCode: 'B001', territory: '日本', exclusivity: 'nonexclusive', terms: '架空の販売条件', sourceReference: '試験', ...payload}});
  assert.equal((await post({baseVersion: 0, releaseOn: '2026-10-01', salesEndOn: '2027-03-31', status: 'confirmed'})).status, 201);
  let row = (await call(`/broadcast/window-proposals?asOf=${asOf}&workId=1`)).data.rows[0];
  assert.match(row.basis_text, /作品共通の販売条件: 2026\/10\/01〜2027\/03\/31/);
  assert.equal((await post({baseVersion: 1, releaseOn: '2026-10-01', salesEndOn: '2029-03-31', status: 'draft'})).status, 201);
  row = (await call(`/broadcast/window-proposals?asOf=${asOf}&workId=1`)).data.rows[0];
  assert.match(row.proposal_text, /^2026\/10\/01〜2026\/12\/31/);
  assert.doesNotMatch(row.proposal_text, /2028/, '下書きの期間（〜2029）では広げない');
  assert.match(row.reasons_text, /作品共通の販売条件に未確定の版がある（B001・日本。直前の確認済み 2026\/10\/01〜2027\/03\/31 で計算）/);
  assert.equal((await post({baseVersion: 2, status: 'withdrawn'})).status, 201);
  row = (await call(`/broadcast/window-proposals?asOf=${asOf}&workId=1`)).data.rows[0];
  assert.deepEqual([row.state, row.proposal_text], ['blocked', '提案なし']);
  assert.match(row.basis_text, /販売条件: 取り下げ（販売しない）/);
  assert.match(row.reasons_text, /作品共通の販売条件が取り下げ（B001・日本。販売しない）/);
  const [sheet] = decodeXlsx((await call(`/broadcast/availability-list/export.xlsx?asOf=${asOf}&workIds=1`)).data);
  const status = sheet.rows.slice(5).find((r) => r[2] === '風のあとさき')[sheet.rows[4].indexOf('放送アベイルズ状況')];
  assert.match(status, /^要確認：.*販売条件/);
});

test('権利範囲の終了日を空欄で登録すると、提案は終わりなしで計算しつつ要確認・アベイルズの一文に「要確認」を出す', async () => {
  const created = await call('/intakes', {method: 'POST', body: {workId: adminWork, caseCode: 'WRK-ADMIN-TV', title: '放送の権利（終了日の記載なし・架空）', intakeType: 'sole_owned',
    documents: [{title: '許諾書（架空）', reference: '架空', versionLabel: '第1版'}], scopes: [{channel: '放送', territory: '日本', rightsStart: '2024-01-01', rightsEnd: '', exclusivity: 'exclusive'}],
    participants: [{partyKind: 'current_org', role: '権利保有'}]}});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const broadcastType = (await call('/release-window-types')).data.types.find((t) => t.type_key === 'broadcast');
  assert.equal((await call('/release-windows', {method: 'POST', body: {workId: adminWork, typeId: broadcastType.id, baseVersion: 0, start: '2026-10-01', end: '', announce: '', status: 'confirmed', fields: {}, sourceReference: '架空', reason: '試験'}})).status, 201);
  const row = (await call(`/broadcast/window-proposals?asOf=${asOf}&workId=${adminWork}`)).data.rows[0];
  assert.equal(row.state, 'ok');
  assert.match(row.reasons_text, /権利範囲の終了日が未入力/);
  const [sheet] = decodeXlsx((await call(`/broadcast/availability-list/export.xlsx?asOf=${asOf}&workIds=${adminWork}`)).data);
  assert.match(sheet.rows.slice(5).find((r) => r[2] === '管理者だけの作品')[sheet.rows[4].indexOf('放送アベイルズ状況')], /要確認/);
});

test('題名に 𠮷 など4バイトの字が40文字目をまたぐ作品を先頭に選んでも、アベイルズの Excel を出せる', async () => {
  const project = (await call('/projects', {method: 'POST', body: {code: 'PRJ-LONG', title: '長い題名の案件（架空）', status: 'active', budget_yen: 0}})).data.id;
  const title = `${'あ'.repeat(39)}\u{20BB7}野家の架空作品`;
  const workId = (await call('/works', {method: 'POST', body: {project_id: project, code: 'WRK-LONG', title, format: 'film'}})).data.id;
  const x = await call(`/broadcast/availability-list/export.xlsx?asOf=${asOf}&workIds=${workId}`);
  assert.equal(x.status, 200, JSON.stringify(x.data));
  const disposition = x.headers.get('content-disposition');
  const encoded = /filename\*=UTF-8''(.+)$/.exec(disposition)[1];
  const decoded = decodeURIComponent(encoded);
  assert.ok(decoded.startsWith(`放送アベイルズリスト_${'あ'.repeat(39)}\u{20BB7}_`), decoded);
  assert.match(decoded, /_\d{8}\.xlsx$/);
});
