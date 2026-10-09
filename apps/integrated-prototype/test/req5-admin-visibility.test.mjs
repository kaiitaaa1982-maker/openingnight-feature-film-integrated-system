// 管理画面の ER 図・データ一覧（要件5の管理の見え方）の試験。DB は試験の DB のファクトリ（test-db.mjs）で開き、SQLite と PostgreSQL の両方で流す。
// 架空の215表の SQLite・D1 のカタログ（sqlite_master・PRAGMA・D1 の束ね）で確かめる試験は req5-admin-visibility-sqlite.test.mjs（SQLite だけ）
import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {registerErRoutes} from '../src/admin/er-routes.mjs';
import {registerDataBrowserRoutes, isLargeColumn} from '../src/admin/data-browser-routes.mjs';
import {cloudR2Internals} from '../src/cloud-r2-db.mjs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {createApi, errorNotice} from '../src/ui/api-client.mjs';
// 実際の表（試験の DB。SQLite は LocalDatabase、PostgreSQL は pg/schema.sql）で、定義は公開・行は管理者だけ・組織の外の行と秘密の列・大きな列は出さない。
// 表の定義は管理画面と同じ読み方（readTableSchema。SQLite は PRAGMA、PostgreSQL は pg_catalog）で読む。架空の215表の SQLite・D1 のカタログでの見え方は
// req5-admin-visibility-sqlite.test.mjs（SQLite だけ）
test('試験の DB: 定義は公開、行は管理者のみ、組織外・秘密・大列を出さない（役割3つ × 組織2つ）', async (t) => {
  const db = await openTestDb({t});
  await db.run('CREATE TABLE demo_visibility_probe(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER, api_token TEXT, raw_text TEXT, note TEXT, FOREIGN KEY(work_id) REFERENCES works(id))');
  await db.run("INSERT INTO demo_visibility_probe VALUES(1,1,1,'DEMO-SECRET','DEMO-LARGE','DEMO-NOTE')");
  for (const role of ['admin', 'editor', 'production']) for (const org of [1, 2]) {
    const label = `${role}/組織${org}`;
    const app = new Hono();
    app.use('*', async (c, next) => {c.set('identity', {role, org_id: org}); await next();});
    const bad = (c, error, status) => c.json({ok: false, error}, status);
    registerErRoutes(app, {db}); registerDataBrowserRoutes(app, {db, bad});
    const get = async (path) => {const res = await app.request(`/api${path}`); return {status: res.status, body: await res.json()};};
    const list = await get('/admin/tables');
    assert.equal(list.status, 200, label);
    assert.equal(list.body.canReadRows, role === 'admin', label);
    assert.ok(list.body.tables.some((table) => table.name === 'works'), label);
    assert.equal(list.body.tables.some((table) => table.name === 'demo_visibility_probe'), role !== 'production', label);
    for (const hidden of ['sessions', 'users', 'organizations']) assert.ok(!list.body.tables.some((table) => table.name === hidden), `${label} ${hidden}`);
    const er = (await get('/er')).body;
    assert.equal(er.tables.some((table) => table.name === 'demo_visibility_probe'), role !== 'production', label);
    assert.ok(er.tables.every((table) => !table.columns.some((c) => ['api_token', 'raw_text'].includes(c.name))), label);
    const definition = await get('/admin/tables/works/definition');
    assert.equal(definition.status, 200, label);
    assert.ok(definition.body.columns.some((c) => c.name === 'title' && c.type === 'TEXT'), label);
    const other = await get('/admin/tables/demo_visibility_probe/definition');
    assert.equal(other.status, role === 'production' ? 404 : 200, label);
    if (other.status === 200) {
      assert.deepEqual(other.body.columns.map((c) => c.name), ['id', 'org_id', 'work_id', 'note'], label);
      assert.deepEqual(other.body.foreignKeys.map((fk) => [fk.from, fk.table, fk.to]), [['work_id', 'works', 'id']], label);
      assert.ok(!JSON.stringify(other.body).includes('DEMO-'), label);
    }
    const rows = await get('/admin/tables/works');
    assert.equal(rows.status, role === 'admin' ? 200 : 403, label);
    if (role === 'admin') {
      assert.ok(rows.body.rows.length > 0 && rows.body.rows.every((row) => row.org_id === org), label);
      const probe = (await get('/admin/tables/demo_visibility_probe')).body;
      assert.equal(probe.total, org === 1 ? 1 : 0, label);
      assert.ok(!JSON.stringify(probe.rows).includes('DEMO-SECRET'), label);
      assert.ok(!JSON.stringify(probe.rows).includes('DEMO-LARGE'), label);
      if (org === 1) assert.equal(probe.rows[0].note, 'DEMO-NOTE', label);
    }
  }
});

test('実際の認証経路: 組織切替で役割を読み直し、管理画面APIの401・409を日本語で案内する', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const user = await db.get("SELECT id FROM users WHERE email='admin@openingnight.invalid'");
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(2,?,'production') ON CONFLICT(org_id,user_id) DO UPDATE SET role='production'", [user.id]);
  const switched = await app.request('/api/session/org', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify({orgId: 2})});
  assert.equal(switched.status, 200);
  const selectedCookie = `${cookie}; ${switched.headers.get('set-cookie').split(';')[0]}`;
  const paths = ['/er', '/admin/tables', '/admin/tables/works/definition', '/admin/tables/works'];
  for (const path of paths) {
    const api = createApi({fetchImpl: (url, init) => app.request(url, init)});
    await assert.rejects(() => api(path), (error) => error.status === 401 && /ログイン/.test(errorNotice(error).message));
    const oldTab = createApi({orgId: () => 1, fetchImpl: (url, init) => app.request(url, {...init, headers: {...init.headers, cookie: selectedCookie}})});
    await assert.rejects(() => oldTab(path), (error) => error.status === 409 && error.code === 'org_mismatch' && /組織/.test(errorNotice(error).message));
  }
  const headers = {cookie: selectedCookie, 'X-On-Org': '2'};
  const list = await (await app.request('/api/admin/tables', {headers})).json();
  assert.equal(list.role, 'production');
  assert.equal(list.canReadRows, false);
  assert.equal((await app.request('/api/admin/tables/works', {headers})).status, 403);
});

test('R2へ退避する列はすべて行データの取得対象から省略する', () => {
  for (const [table, columns] of cloudR2Internals.externalColumns) for (const column of columns) assert.ok(isLargeColumn(table, column), `${table}.${column}`);
});
