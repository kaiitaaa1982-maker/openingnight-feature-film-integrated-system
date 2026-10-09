// 全作品のウィンドウ（営業基幹）の試験。期待値は試験の中に書いた値・手で数えた値で持ち、試験対象の関数で作らない。
// ・日付の読み取り（日・月・年・時期・未定）と幅
// ・種別の採用・追加（列と Excel の見出しが増える）・版・管理者だけ・理由必須・監査
// ・ウィンドウの版（照合・理由必須・変更削除の禁止・項目の型のトリガー）、状態・警告（販売条件・権利・放送枠）、絞り込み・100行ずつ
// ・Excel の出力と取込（同じ列の並び・知らない列は警告・無い列は変えない・版の衝突・理由を書いて登録・1回限り・文の数は行数によらない）
// ・制作担当は画面も API も使えない。閲覧だけの作品は直せない
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {parseWindowDate, dateBounds, earliestMonth, INITIAL_WINDOW_TYPES} from '../src/sales-ops/release-window-model.mjs';

async function setup({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const sessions = {};
  const as = async (role) => {
    if (!sessions[role]) {
      const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: `${role}@openingnight.invalid`})});
      assert.equal(login.status, 200, role);
      sessions[role] = login.headers.get('set-cookie').split(';')[0];
    }
    const cookie = sessions[role];
    const call = async (method, path, payload) => {
      const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
      const type = response.headers.get('content-type') || '';
      return {status: response.status, body: type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer())};
    };
    return {get: (path) => call('GET', path), post: (path, payload) => call('POST', path, payload)};
  };
  return {db, app, as};
}

async function adopted({t} = {}) {
  const env = await setup({t});
  const admin = await env.as('admin');
  assert.equal((await admin.post('/release-window-types/adopt', {reason: '初期の種別を採用（試験）'})).status, 201);
  const types = (await admin.get('/release-window-types')).body.types;
  env.types = new Map(types.map((type) => [type.type_key, type]));
  return {...env, admin};
}

test('日付の読み取りは仮の日付を作らない（日・月・年・時期の原文・未定）', () => {
  assert.deepEqual(parseWindowDate('2026/11/5'), {ok: true, precision: 'day', value: '2026-11-05', raw: '2026/11/5'});
  assert.deepEqual(parseWindowDate('２０２６年１１月'), {ok: true, precision: 'month', value: '2026-11', raw: '2026年11月'});
  assert.deepEqual(parseWindowDate('2027'), {ok: true, precision: 'year', value: '2027', raw: '2027'});
  assert.deepEqual(parseWindowDate('2027年春'), {ok: true, precision: 'range', value: '2027-03', raw: '2027年春'});
  assert.deepEqual(parseWindowDate('2027年4月以降'), {ok: true, precision: 'range', value: '2027-04', raw: '2027年4月以降'});
  assert.deepEqual(parseWindowDate('調整中の見込み'), {ok: true, precision: 'range', value: null, raw: '調整中の見込み'});
  assert.deepEqual(parseWindowDate('未定'), {ok: true, precision: 'tbd', value: null, raw: '未定'});
  assert.deepEqual(parseWindowDate(''), {ok: true, precision: null, value: null, raw: null});
  assert.equal(parseWindowDate('2026-02-30').ok, false);
  assert.equal(parseWindowDate('2026-13').ok, false);
  assert.deepEqual(dateBounds('2026-02'), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(dateBounds('2028-02'), ['2028-02-01', '2028-02-29']);
  assert.deepEqual(dateBounds('2026'), ['2026-01-01', '2026-12-31']);
  assert.equal(dateBounds('2027年春'), null);
  assert.equal(earliestMonth('2027年下期'), '2027-07');
  // 月の範囲は最初の月、季節の語は出てくる順、年度（4月始まり）の上期・下期
  assert.equal(earliestMonth('2027年1〜3月'), '2027-01');
  assert.equal(earliestMonth('2027年1~3月'), '2027-01');
  assert.equal(earliestMonth('2026年末〜2027年初'), '2026-12');
  assert.equal(earliestMonth('2026年度下期'), '2026-10');
  assert.equal(earliestMonth('2026年度上期'), '2026-04');
  assert.equal(earliestMonth('2026年秋'), '2026-09');
});

test('初期の種別は15種で、劇場は「劇場公開・配給開始」の1種別。配信は6項目（解禁・期限・告知・価格・視聴時間・独占）', () => {
  assert.equal(INITIAL_WINDOW_TYPES.length, 15);
  const theatrical = INITIAL_WINDOW_TYPES.filter((type) => type.family === 'theatrical');
  assert.deepEqual(theatrical.map((type) => [type.label, type.date_mode]), [['劇場公開・配給開始', 'point']]);
  const labels = INITIAL_WINDOW_TYPES.map((type) => type.label);
  for (const label of ['PVOD先行', 'PVOD②', 'EST先行', 'EST通常', 'TVOD先行', 'TVOD通常', 'SVOD先行', 'SVOD通常', 'AVOD', '業務用VOD', '放送', 'DVD・BD発売', 'レンタル開始', '海外']) assert.ok(labels.includes(label), label);
  for (const type of INITIAL_WINDOW_TYPES.filter((t) => t.family === 'digital')) {
    assert.equal(type.date_mode, 'period', type.label);
    assert.equal(type.has_announce, 1, type.label);
    assert.deepEqual(type.fields.map((f) => [f.label, f.value_type]), [['販売予定価格（税抜）', 'yen'], ['視聴権利時間', 'integer'], ['独占種別', 'choice']], type.label);
  }
});

test('種別の採用・追加・版は管理者だけ・理由必須で、追加した種別は次の読み込みで列と Excel の見出しに出る', async (t) => {
  const {db, as} = await setup({t});
  const admin = await as('admin'), editor = await as('editor');
  assert.equal((await admin.get('/release-windows')).body.needsAdoption, true);
  assert.equal((await editor.post('/release-window-types/adopt', {reason: 'x'})).status, 403);
  assert.equal((await admin.post('/release-window-types/adopt', {reason: ''})).status, 400);
  assert.equal((await admin.post('/release-window-types/adopt', {reason: '採用'})).status, 201);
  assert.equal((await admin.post('/release-window-types/adopt', {reason: '二重'})).status, 409);
  const before = (await admin.get('/release-window-types')).body.types;
  assert.equal(before.length, 15);
  const add = {type_key: 'svod_third', label: 'SVOD第3', family: 'digital', date_mode: 'period', start_label: '解禁日', end_label: '配信期限', has_announce: false,
    sort_order: 115, distributions: ['D005'], fields: [{field_key: 'note', label: 'メモ', value_type: 'text'}], reason: '3回目のSVODを管理する'};
  assert.equal((await editor.post('/release-window-types', add)).status, 403);
  assert.equal((await admin.post('/release-window-types', {...add, reason: ''})).status, 400);
  assert.equal((await admin.post('/release-window-types', {...add, label: 'SVOD先行'})).status, 400, '表示名が重なると Excel の見出しが重なる');
  assert.equal((await admin.post('/release-window-types', add)).status, 201);
  const list = (await admin.get('/release-windows')).body;
  assert.ok(list.types.some((type) => type.type_key === 'svod_third'));
  const exported = await admin.get('/release-windows/export.xlsx');
  assert.equal(exported.status, 200);
  const headers = decodeXlsx(exported.body).find((sheet) => sheet.name === 'ウィンドウ').rows[0];
  const order = ['SVOD通常 版', 'SVOD第3 解禁日', 'SVOD第3 配信期限', 'SVOD第3 メモ', 'SVOD第3 状態', 'SVOD第3 版', 'AVOD 解禁日'].map((header) => headers.indexOf(header));
  assert.ok(order.every((index) => index > 0), `見出し: ${headers.join('・')}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, '並び順（sort_order）どおりに列が並ぶ');
  // 新しい版で使うのをやめると列が消える（登録済みの版は残る）
  const third = (await admin.get('/release-window-types')).body.types.find((type) => type.type_key === 'svod_third');
  assert.equal((await admin.post(`/release-window-types/${third.id}/versions`, {baseVersion: 0, active: false, reason: 'やめる'})).status, 409, '版の照合');
  assert.equal((await admin.post(`/release-window-types/${third.id}/versions`, {baseVersion: 1, active: false, reason: 'やめる'})).status, 201);
  assert.ok(!(await admin.get('/release-windows')).body.types.some((type) => type.type_key === 'svod_third'));
  const audits = await db.all("SELECT action FROM audit_log WHERE entity_type='release_window_type' ORDER BY id");
  assert.deepEqual(audits.map((row) => row.action), ['adopt', 'create', 'version']);
  await assert.rejects(db.run("UPDATE release_window_type_versions SET label='x'"), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
  await assert.rejects(db.run('DELETE FROM release_window_types'), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
});

test('ウィンドウの版: 版の照合・理由必須・月まで・時期・未定・項目の型。変更・削除はトリガーで止まり、監査に残る', async (t) => {
  const {db, admin, types} = await adopted({t});
  const theatrical = types.get('theatrical'), svod = types.get('svod_early');
  const post = (payload) => admin.post('/release-windows', {workId: 1, reason: '試験', ...payload});
  assert.equal((await post({typeId: theatrical.id, baseVersion: 0, start: '2026-11', reason: ''})).status, 400, '理由必須');
  assert.equal((await post({typeId: theatrical.id, baseVersion: 0, start: '2026-11', end: '2026-12'})).status, 400, '1日の種別に終了は入れない');
  assert.equal((await post({typeId: theatrical.id, baseVersion: 0, start: '2026年秋', status: 'confirmed'})).status, 400, '時期のままでは確定にできない');
  assert.equal((await post({typeId: theatrical.id, baseVersion: 0, start: '2026-11'})).status, 201);
  assert.equal((await post({typeId: theatrical.id, baseVersion: 0, start: '2026-11-06'})).status, 409, '古い版からは登録しない');
  assert.equal((await post({typeId: theatrical.id, baseVersion: 1, start: '2026-11-06', status: 'confirmed'})).status, 201);
  assert.equal((await post({typeId: svod.id, baseVersion: 0, start: '2027-01-15', end: '2026-12', fields: {}})).status, 400, '期限が解禁より前');
  assert.equal((await post({typeId: svod.id, baseVersion: 0, start: '2027-01-15', end: '2027-12', fields: {price_ex_tax: '千五百'}})).status, 400);
  assert.equal((await post({typeId: svod.id, baseVersion: 0, start: '2027-01-15', end: '2027-12', announce: '2026-12-01', fields: {price_ex_tax: '1,500円', viewing_hours: '48', exclusivity: '独占'}})).status, 201);
  assert.equal((await post({typeId: types.get('avod').id, baseVersion: 0, start: '未定'})).status, 201);
  const rows = await db.all(`SELECT t.type_key,v.version_no,v.start_on,v.end_on,v.announce_on,v.date_precision,v.timing_raw,v.status FROM work_release_window_versions v
    JOIN work_release_windows w ON w.org_id=v.org_id AND w.id=v.window_id JOIN release_window_types t ON t.org_id=w.org_id AND t.id=w.type_id ORDER BY t.type_key,v.version_no`);
  assert.deepEqual(rows.map((r) => [r.type_key, r.version_no, r.start_on, r.end_on, r.announce_on, r.date_precision, r.timing_raw, r.status]), [
    ['avod', 1, null, null, null, 'tbd', '未定', 'draft'],
    ['svod_early', 1, '2027-01-15', '2027-12', '2026-12-01', 'day', null, 'draft'],
    ['theatrical', 1, '2026-11', null, null, 'month', null, 'draft'],
    ['theatrical', 2, '2026-11-06', null, null, 'day', null, 'confirmed'],
  ]);
  const values = await db.all('SELECT field_key,value_text,value_number FROM work_release_window_field_values ORDER BY field_key');
  assert.deepEqual(values.map((row) => ({...row})), [{field_key: 'exclusivity', value_text: 'exclusive', value_number: null}, {field_key: 'price_ex_tax', value_text: null, value_number: 1500},
    {field_key: 'viewing_hours', value_text: null, value_number: 48}]);
  // トリガー: 変更・削除の禁止、項目の型、存在しない項目、版の飛び
  await assert.rejects(db.run("UPDATE work_release_window_versions SET status='withdrawn'"), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
  await assert.rejects(db.run('DELETE FROM work_release_window_field_values'), (e) => e.dbError?.kind === 'raise' && /immutable/.test(e.message));
  const svodWindow = (await db.get("SELECT w.id FROM work_release_windows w JOIN release_window_types t ON t.id=w.type_id WHERE t.type_key='svod_early'")).id;
  await assert.rejects(db.run("INSERT INTO work_release_window_field_values(org_id,window_id,version_no,field_key,value_text) VALUES(1,?,1,'nothing','x')", [svodWindow]), (e) => e.dbError?.kind === 'raise' && /field type mismatch/.test(e.message));
  await assert.rejects(db.run("INSERT INTO work_release_window_versions(org_id,window_id,version_no,type_version_no,start_on,date_precision,status,source_kind,reason,created_by) VALUES(1,?,3,1,'2027-01-15','day','draft','manual','x',1)", [svodWindow]), (e) => e.dbError?.kind === 'raise' && /stale release window version/.test(e.message));
  await assert.rejects(db.run("INSERT INTO work_release_window_versions(org_id,window_id,version_no,type_version_no,start_on,date_precision,status,source_kind,reason,created_by) VALUES(1,?,2,1,'2027-1-15','day','draft','manual','x',1)", [svodWindow]), (e) => e.dbError?.kind === 'check');
  const audit = await db.all("SELECT action FROM audit_log WHERE entity_type='release_window' ORDER BY id");
  assert.deepEqual(audit.map((row) => row.action), ['create', 'version', 'create', 'create']);
  // 履歴は新しい版から
  const history = (await admin.get(`/release-windows/history?workId=1&typeId=${theatrical.id}`)).body;
  assert.deepEqual(history.versions.map((v) => [v.version_no, v.start_on, v.status]), [[2, '2026-11-06', 'confirmed'], [1, '2026-11', 'draft']]);
});

test('警告はその場で計算する: 対応する流通IDの確定済み販売条件の期間外・権利期間外・放送枠の月が放送期間外。取り下げは判定しない', async (t) => {
  const {db, admin, types} = await adopted({t});
  const svod = types.get('svod_early'), tvod = types.get('tvod_regular'), broadcast = types.get('broadcast'), est = types.get('est_regular');
  const post = (payload) => admin.post('/release-windows', {workId: 1, baseVersion: 0, reason: '試験', ...payload});
  assert.equal((await post({typeId: svod.id, start: '2027-01-15', end: '2027-12', status: 'confirmed'})).status, 201);
  assert.equal((await post({typeId: tvod.id, start: '2027-02', end: '2029-01-31'})).status, 201);
  assert.equal((await post({typeId: broadcast.id, start: '2027-04-01', end: '2028-03-31'})).status, 201);
  assert.equal((await post({typeId: est.id, start: '2027-02-01', status: 'withdrawn'})).status, 201);
  // 販売条件: SVOD(D005) は 2027-01-15〜2027-11-30（期限 2027-12 の月末が外れる）、TVOD(D004) は 2027-02-01〜2029-01-31（月まで 2027-02 は入る）、
  // EST(D003) は 2026年だけ（取り下げたウィンドウなので判定しない）。条件未確定の販売条件は使わない
  const catalog = (code, releaseOn, salesEndOn, status = 'confirmed', base = 0) => admin.post('/sales-catalog', {workId: 1, distributionCode: code, territory: '日本', baseVersion: base, releaseOn, salesEndOn,
    terms: '試験の条件', sourceReference: '試験', exclusivity: 'nonexclusive', status});
  assert.equal((await catalog('D005', '2027-01-15', '2027-11-30')).status, 201);
  assert.equal((await catalog('D004', '2027-02-01', '2029-01-31')).status, 201);
  assert.equal((await catalog('D003', '2026-01-01', '2026-12-31')).status, 201);
  assert.equal((await catalog('D006', '2030-01-01', '2030-12-31', 'draft')).status, 201);
  // 権利: 放送は 2027-12-31 まで（放送期限 2028-03-31 が外れる）
  assert.equal((await admin.post('/intakes', {workId: 1, caseCode: 'T-RIGHTS', title: '試験の権利', intakeType: 'sole_owned', documents: [{title: '許諾書', reference: '試験', versionLabel: '1'}],
    scopes: [{channel: '放送', territory: '日本', rightsStart: '2026-01-01', rightsEnd: '2027-12-31', exclusivity: 'nonexclusive'}], participants: [{partyKind: 'current_org'}]})).status, 201);
  // 放送枠: 2027-03（放送解禁の前の月）と 2027-06（期間内）、2028-05 の枠は中止
  const slot = async (m) => (await admin.post('/broadcast/slots', {workId: 1, broadcastMonth: m, stationName: '試験テレビ', periodFrom: `${m}-01`, periodTo: `${m}-28`, plannedRuns: 1})).body;
  await slot('2027-03');
  await slot('2027-06');
  const cancelled = await slot('2028-05');
  assert.equal((await admin.post(`/broadcast/slots/${cancelled.slotId}/transition`, {baseRevision: 1, status: 'cancelled', reason: '中止'})).status, 200);
  const row = (await admin.get('/release-windows')).body.rows[0];
  const messages = (key) => row.windows[key].warnings.map((w) => w.kind);
  assert.deepEqual(messages('svod_early'), ['availability']);
  assert.deepEqual(messages('tvod_regular'), []);
  assert.deepEqual(messages('broadcast'), ['rights', 'broadcast_slot']);
  assert.match(row.windows.broadcast.warnings[1].message, /2027年3月・試験テレビ/);
  assert.deepEqual(messages('est_regular'), []);
  assert.equal(row.windows.est_regular.state, 'withdrawn');
  assert.equal(row.windows.avod.state, 'unregistered');
  assert.equal(row.warningCount, 3);
  const only = (await admin.get('/release-windows?warnings=1')).body;
  assert.equal(only.total, 1);
  assert.equal((await admin.get('/release-windows?warnings=1&families=theatrical')).body.total, 0, '警告の絞り込みは選んだ種別だけで見る');
});

test('絞り込み（種別・状態・期間・語句）はサーバー側で行い、100行ずつ送る。未登録の作品も1行で出る', async (t) => {
  const {db, admin, types} = await adopted({t});
  // 作品を250本にする（fixture の作品1に加えて249本。案件1）
  await db.batch(Array.from({length: 249}, (_, i) => ({sql: "INSERT INTO works(org_id,project_id,code,title,format) VALUES(1,1,?,?,'film')", params: [`T-${String(i + 2).padStart(3, '0')}`, `試験作品${i + 2}`]})));
  const ids = new Map((await db.all('SELECT id,code FROM works WHERE org_id=1')).map((row) => [row.code, row.id]));
  const theatrical = types.get('theatrical');
  // 10本に劇場公開: 5本は確定（2026-10-01〜05）、3本は予定（月まで 2026-11）、2本は取り下げ
  for (let n = 10; n < 20; n += 1) {
    const code = `T-${String(n).padStart(3, '0')}`;
    const status = n < 15 ? 'confirmed' : n < 18 ? 'draft' : 'withdrawn';
    const start = n < 15 ? `2026-10-0${n - 9}` : '2026-11';
    assert.equal((await admin.post('/release-windows', {workId: ids.get(code), typeId: theatrical.id, baseVersion: 0, start, status, reason: '試験'})).status, 201);
  }
  const page1 = (await admin.get('/release-windows')).body;
  assert.equal(page1.total, 250);
  assert.equal(page1.rows.length, 100);
  assert.equal(page1.pages, 3);
  const page3 = (await admin.get('/release-windows?page=3')).body;
  assert.equal(page3.rows.length, 50);
  assert.equal(page3.rows.at(-1).work_code, 'WRK-DEMO', '作品コードの順');
  const query = async (qs) => (await admin.get(`/release-windows?${qs}`)).body;
  assert.equal((await query('types=theatrical&state=confirmed')).total, 5);
  assert.equal((await query('types=theatrical&state=draft')).total, 3);
  assert.equal((await query('types=theatrical&state=withdrawn')).total, 2);
  assert.equal((await query('types=theatrical&state=unregistered')).total, 240);
  assert.equal((await query('types=theatrical&dateField=start&from=2026-10&to=2026-10')).total, 5);
  assert.equal((await query('types=theatrical&dateField=start&from=2026-11-15&to=2026-11-15')).total, 5, '月までの日付は、その月のどの日とも重なる（取り下げも開始日は持つ）');
  // 1日の種別（劇場）の「販売中」は、その日が期間に入るもの（取り下げは除く）: 月まで 2026-11 の予定3本
  assert.equal((await query('types=theatrical&dateField=onsale&from=2026-11&to=2026-12')).total, 3, '販売中は取り下げを除く');
  assert.equal((await query('types=theatrical&dateField=onsale&from=2026-10-03&to=2026-11-30')).total, 6);
  assert.equal((await query('q=試験作品25')).total, 2, '語句（試験作品25・250）');
  const narrowed = await query('families=digital');
  assert.ok(narrowed.types.length === 15 && narrowed.selectedTypeKeys.length === 10);
  assert.ok(narrowed.rows.every((row) => Object.keys(row.windows).length === 10));
});

test('Excel は画面と同じ並びで出力し、取込は知らない列を警告・無い列は変えない・版の衝突を止め、理由を書いて1回だけ登録する', async (t) => {
  const {db, as, admin, types} = await adopted({t});
  const svod = types.get('svod_early');
  assert.equal((await admin.post('/release-windows', {workId: 1, typeId: svod.id, baseVersion: 0, start: '2027-01-15', end: '2027-12', fields: {price_ex_tax: '1500', exclusivity: 'exclusive'}, reason: '試験'})).status, 201);
  const file = await admin.get('/release-windows/export.xlsx?families=digital');
  const sheets = decodeXlsx(file.body);
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['ウィンドウ', '_定義', '_meta']);
  const [headers, row] = sheets[0].rows;
  assert.deepEqual(headers.slice(0, 11), ['作品コード', '参考_作品名', '参考_案件', 'PVOD先行 解禁日', 'PVOD先行 配信期限', 'PVOD先行 告知解禁日', 'PVOD先行 販売予定価格（税抜）', 'PVOD先行 視聴権利時間', 'PVOD先行 独占種別', 'PVOD先行 状態', 'PVOD先行 版']);
  const col = (name) => headers.indexOf(name);
  assert.equal(row[col('SVOD先行 解禁日')], '2027-01-15');
  assert.equal(row[col('SVOD先行 配信期限')], '2027-12');
  assert.equal(row[col('SVOD先行 販売予定価格（税抜）')], 1500);
  assert.equal(row[col('SVOD先行 独占種別')], '独占');
  assert.equal(row[col('SVOD先行 状態')], '予定');
  assert.equal(row[col('SVOD先行 版')], 1);
  // 取込: 見出しの一部だけ（SVOD先行の解禁日・期限・版、AVOD の解禁日・版）と、知らない列
  const partialHeaders = ['作品コード', 'SVOD先行 配信期限', 'SVOD先行 版', 'AVOD 解禁日', 'AVOD 版', '担当者メモ'];
  const partialRow = ['WRK-DEMO', '2027-12-31', 1, '2028-01', '', 'だれか'];
  const preview = await admin.post('/release-windows/import/preview', {table: {headers: partialHeaders, rows: [partialRow]}, fileName: '一部.xlsx'});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.match(preview.body.warnings.join(' '), /担当者メモ/);
  assert.deepEqual(preview.body.rows[0].changes.map((c) => [c.typeLabel, c.action, c.parts.join('・')]), [['SVOD先行', 'revise', '配信期限'], ['AVOD', 'append', '解禁日・状態']]);
  assert.equal((await admin.post('/release-windows/import/commit', {token: preview.body.token, confirmed: true, reason: ''})).status, 400, '理由必須');
  const editor = await as('editor');
  assert.equal((await editor.post('/release-windows/import/commit', {token: preview.body.token, confirmed: true, reason: '他人の確認'})).status, 410, '確認した本人だけ');
  // 文の数は行数によらない（json_each で1つの文にまとめる）
  const original = db.batch.bind(db);
  let statements = 0;
  db.batch = async (list) => { statements = list.length; return original(list); };
  const commit = await admin.post('/release-windows/import/commit', {token: preview.body.token, confirmed: true, reason: 'Excel で期限を確定', fileName: '一部.xlsx'});
  db.batch = original;
  assert.equal(commit.status, 201, JSON.stringify(commit.body));
  assert.deepEqual([commit.body.append, commit.body.revise], [1, 1]);
  assert.equal(statements, 8);
  assert.equal((await admin.post('/release-windows/import/commit', {token: preview.body.token, confirmed: true, reason: '二度目'})).status, 410, '1回限り');
  const svodNow = await db.get("SELECT v.* FROM work_release_window_versions v JOIN work_release_windows w ON w.id=v.window_id JOIN release_window_types t ON t.id=w.type_id WHERE t.type_key='svod_early' AND v.version_no=2");
  assert.deepEqual([svodNow.start_on, svodNow.end_on, svodNow.source_kind, svodNow.reason, svodNow.source_reference], ['2027-01-15', '2027-12-31', 'excel_import', 'Excel で期限を確定', '一部.xlsx']);
  const kept = await db.all('SELECT field_key,value_text,value_number FROM work_release_window_field_values v WHERE version_no=2 ORDER BY field_key');
  assert.deepEqual(kept.map((r) => [r.field_key, r.value_text ?? r.value_number]), [['exclusivity', 'exclusive'], ['price_ex_tax', 1500]], '無い列（価格・独占）は前の版のまま');
  // 同じファイルをもう一度: 出力後に直された（版の衝突）
  const again = await admin.post('/release-windows/import/preview', {table: {headers: partialHeaders, rows: [partialRow]}});
  assert.equal(again.status, 400);
  assert.match(again.body.failedRows[0].errors.join(' '), /いまは第2版/);
  // 知らない作品コード・同じ作品が2行・状態の誤り
  const bad = await admin.post('/release-windows/import/preview', {table: {headers: ['作品コード', 'AVOD 状態'], rows: [['NO-SUCH', '予定'], ['WRK-DEMO', '確定'], ['WRK-DEMO', '予定']]}});
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.failedRows.map((r) => r.rowNo), [2, 4]);
  // 作品コードの列が無いファイルは読まない
  assert.equal((await admin.post('/release-windows/import/preview', {table: {headers: ['AVOD 解禁日'], rows: [['2028-01']]}})).status, 400);
});

test('制作担当は営業基幹の API を使えず、閲覧だけの作品（案件の制作権限）は直せない', async (t) => {
  const {db, as, admin, types} = await adopted({t});
  const production = await as('production');
  for (const path of ['/release-windows', '/release-window-types', '/release-windows/export.xlsx', '/release-windows/history?workId=1&typeId=1']) assert.equal((await production.get(path)).status, 403, path);
  assert.equal((await production.post('/release-windows', {workId: 1, typeId: 1, baseVersion: 0, start: '2026-11', reason: 'x'})).status, 403);
  assert.equal((await production.post('/release-windows/import/preview', {table: {headers: ['作品コード'], rows: [['WRK-DEMO']]}})).status, 403);
  // 案件2（編集担当は制作の権限だけ）: 見えるが直せない
  await db.batch([
    {sql: "INSERT INTO projects(id,org_id,code,title,status,budget_yen) VALUES(3,1,'PRJ-VIEW','閲覧だけの案件','active',0)"},
    {sql: "INSERT INTO works(id,org_id,project_id,code,title,format) VALUES(3,1,3,'WRK-VIEW','閲覧だけの作品','film')"},
    {sql: "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,3,2,'production')"},
  ]);
  const editor = await as('editor');
  const list = (await editor.get('/release-windows')).body;
  assert.deepEqual(list.rows.map((row) => [row.work_code, row.canEdit]), [['WRK-DEMO', true], ['WRK-VIEW', false]]);
  assert.equal((await editor.post('/release-windows', {workId: 3, typeId: types.get('theatrical').id, baseVersion: 0, start: '2026-11', reason: 'x'})).status, 403);
  const preview = await editor.post('/release-windows/import/preview', {table: {headers: ['作品コード', '劇場公開・配給開始 公開日'], rows: [['WRK-VIEW', '2026-11']]}});
  assert.equal(preview.status, 400);
  assert.match(preview.body.failedRows[0].errors.join(' '), /編集権限/);
  // 別組織の作品コードは見えない
  const outsider = await admin.post('/release-windows/import/preview', {table: {headers: ['作品コード', '劇場公開・配給開始 公開日'], rows: [['WRK-OTHER', '2026-11']]}});
  assert.equal(outsider.status, 400);
});

test('確認の後に別の人が同じウィンドウを直したら、登録は全部止まる（途中まで入らない）', async (t) => {
  const {db, admin, types} = await adopted({t});
  const avod = types.get('avod');
  const preview = await admin.post('/release-windows/import/preview', {table: {headers: ['作品コード', 'AVOD 解禁日', 'AVOD 版', 'SVOD先行 解禁日', 'SVOD先行 版'], rows: [['WRK-DEMO', '2028-01', '', '2027-02', '']]}});
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal((await admin.post('/release-windows', {workId: 1, typeId: avod.id, baseVersion: 0, start: '2028-02', reason: '先に画面で登録'})).status, 201);
  const before = Number((await db.get('SELECT COUNT(*) AS n FROM work_release_window_versions')).n);
  const commit = await admin.post('/release-windows/import/commit', {token: preview.body.token, confirmed: true, reason: '取込'});
  assert.equal(commit.status, 409);
  assert.match(commit.body.error, /別の人が同じウィンドウ/);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM work_release_window_versions')).n), before, 'SVOD先行も入らない');
  assert.equal(Number((await db.get('SELECT consumed FROM release_window_import_previews WHERE token=?', [preview.body.token])).consumed), 0);
});
