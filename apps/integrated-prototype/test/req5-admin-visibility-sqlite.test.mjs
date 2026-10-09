// 管理画面の ER 図・データ一覧（要件5の管理の見え方）のうち、SQLite・D1 のカタログの読み方そのものを確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。
// node:sqlite に架空の215表を作り、手元の入口（local）・D1 の束ねを模した D1Database（d1）・R2 退避の D1（r2）の3つで、
// sqlite_master と PRAGMA の表値関数（pragma_table_info・pragma_foreign_key_list）で表の定義を3問い合わせで読むこと、表値関数が使えないときの表別 PRAGMA への切替、
// 1つの問い合わせの値は100個まで（D1 の上限）、引用符つきの表名・複合外部キー、役割と組織ごとの見え方を確かめる（PostgreSQL の試験の DB では組めない）。
// PostgreSQL のカタログの読み方（src/admin/pg-catalog-store.mjs）は admin-er-model.test.mjs が SQLite と並べて確かめ、
// 実際の表での役割と組織ごとの見え方は req5-admin-visibility.test.mjs が両方の DB で確かめる。
// 元は req5-admin-visibility.test.mjs の中にあった試験（2026-10-03、香盤表 #11 の PR7 で分けた。中身は変えていない）
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {D1Database} from '../src/d1-db.mjs';
import {R2BackedD1Database} from '../src/cloud-r2-db.mjs';
import {readTableSchema, registerErRoutes} from '../src/admin/er-routes.mjs';
import {registerDataBrowserRoutes} from '../src/admin/data-browser-routes.mjs';
function fixture(kind) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE works(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, title TEXT DEFAULT \'（架空）\');');
  for (let n = 0; n < 214; n++) raw.exec(`CREATE TABLE demo_${n}(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER, api_token TEXT, raw_text TEXT, FOREIGN KEY(work_id) REFERENCES works(id))`);
  raw.exec("INSERT INTO works VALUES(1,1,'DEMO-A（架空）'),(2,2,'DEMO-B（架空）')");
  const calls = [];
  const binding = {prepare(sql) { return {bind(...params) {
    assert.ok(params.length <= 100);
    const run = () => { calls.push(sql); return raw.prepare(sql); };
    return {all: async () => ({results: run().all(...params)}), first: async () => run().get(...params)};
  }}; }};
  const db = kind === 'local' ? {all: async (sql, params = []) => {calls.push(sql); return raw.prepare(sql).all(...params);}, get: async (sql, params = []) => {calls.push(sql); return raw.prepare(sql).get(...params);}}
    : kind === 'd1' ? new D1Database(binding) : new R2BackedD1Database(binding, {get() {throw new Error('定義・省略列からR2を読まない');}});
  return {db, raw, calls};
}

for (const kind of ['local', 'd1', 'r2']) test(`${kind}: 215表の定義と一覧を3問い合わせ、COUNTなしで取得する`, async () => {
  const {db, raw, calls} = fixture(kind);
  try {
    const {tables, definitionSource} = await readTableSchema(db);
    assert.equal(definitionSource, 'table-valued');
    assert.equal(tables.length, 215);
    assert.equal(calls.length, 3);
    for (const table of tables) {
      assert.deepEqual(table.columns, raw.prepare(`PRAGMA table_info("${table.name}")`).all().map((r) => ({...r})));
      assert.deepEqual(table.foreignKeys, raw.prepare(`PRAGMA foreign_key_list("${table.name}")`).all().map((r) => ({...r})));
    }
    const app = new Hono();
    app.use('*', async (c, next) => {c.set('identity', {role: 'admin', org_id: 1}); await next();});
    registerErRoutes(app, {db});
    registerDataBrowserRoutes(app, {db, bad: (c, error, status) => c.json({ok: false, error}, status)});
    for (const path of ['/api/er', '/api/admin/tables']) {
      calls.length = 0;
      const res = await app.request(path);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).tables.length, 215);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((sql) => !/COUNT\s*\(/i.test(sql)));
    }
    calls.length = 0;
    const detail = await (await app.request('/api/admin/tables/works')).json();
    assert.equal(detail.total, 1);
    assert.deepEqual(detail.rows.map((r) => r.title), ['DEMO-A（架空）']);
    assert.equal(calls.filter((sql) => /COUNT\s*\(/i.test(sql)).length, 1);
  } finally {raw.close();}
});

for (const kind of ['local', 'd1', 'r2']) for (const role of ['admin', 'editor', 'production']) for (const org of [1, 2]) {
  test(`${kind}/${role}/組織${org}: 定義は公開、行は管理者のみ、組織外・秘密・大列を出さない`, async () => {
    const {db, raw} = fixture(kind);
    try {
      raw.exec("INSERT INTO demo_0 VALUES(1,1,1,'DEMO-SECRET','DEMO-LARGE')");
      const app = new Hono();
      app.use('*', async (c, next) => {c.set('identity', {role, org_id: org}); await next();});
      const bad = (c, error, status) => c.json({ok: false, error}, status);
      registerErRoutes(app, {db}); registerDataBrowserRoutes(app, {db, bad});
      const get = async (path) => {const res = await app.request(`/api${path}`); return {status: res.status, body: await res.json()};};
      const list = await get('/admin/tables');
      assert.equal(list.status, 200);
      assert.equal(list.body.canReadRows, role === 'admin');
      assert.ok(list.body.tables.some((t) => t.name === 'works'));
      assert.equal(list.body.tables.some((t) => t.name === 'demo_0'), role !== 'production');
      const er = (await get('/er')).body;
      assert.equal(er.tables.some((t) => t.name === 'demo_0'), role !== 'production');
      assert.ok(er.tables.every((t) => !t.columns.some((c) => ['api_token', 'raw_text'].includes(c.name))));
      const definition = await get('/admin/tables/works/definition');
      assert.equal(definition.status, 200);
      assert.ok(definition.body.columns.some((c) => c.name === 'title' && c.type === 'TEXT' && c.dflt_value === "'（架空）'"));
      assert.ok(!JSON.stringify(definition.body).includes('DEMO-A'));
      const other = await get('/admin/tables/demo_0/definition');
      assert.equal(other.status, role === 'production' ? 404 : 200);
      if (other.status === 200) {
        assert.ok(!other.body.columns.some((c) => c.name === 'api_token'));
        assert.ok(!other.body.columns.some((c) => c.name === 'raw_text'));
        assert.equal(other.body.foreignKeys[0].table, 'works');
      }
      const rows = await get('/admin/tables/works');
      assert.equal(rows.status, role === 'admin' ? 200 : 403);
      if (role === 'admin') {
        assert.deepEqual(rows.body.rows.map((r) => r.org_id), [org]);
        const large = (await get('/admin/tables/demo_0')).body;
        assert.ok(!JSON.stringify(large.rows).includes('DEMO-SECRET'));
        assert.ok(!JSON.stringify(large.rows).includes('DEMO-LARGE'));
        assert.equal(large.total, org === 1 ? 1 : 0);
      }
    } finally {raw.close();}
  });
}

for (const kind of ['local', 'd1', 'r2']) for (const rejected of ['pragma_', 'pragma_foreign_key_list']) test(`${kind}: ${rejected}失敗時は同じ定義と行を表別PRAGMAで返す`, async () => {
  const {db, raw, calls} = fixture(kind);
  try {
    raw.exec(`CREATE TABLE "DEMO-引用""符"(org_id INTEGER, work_id INTEGER, FOREIGN KEY(work_id) REFERENCES works(id));
      CREATE TABLE _cf_internal(id INTEGER); CREATE TABLE d1_migrations(id INTEGER)`);
    const expected = await readTableSchema(db);
    const fallback = {all(sql, ...args) {if (sql.includes(rejected)) throw new Error('table-valued PRAGMA unavailable'); return db.all(sql, ...args);}, get: (...args) => db.get(...args)};
    const actual = await readTableSchema(fallback);
    assert.equal(actual.definitionSource, 'per-table');
    assert.deepEqual(actual.tables, expected.tables);
    assert.ok(!actual.tables.some((t) => ['_cf_internal', 'd1_migrations'].includes(t.name)));
    const makeApp = (database, role) => {
      const app = new Hono();
      app.use('*', async (c, next) => {c.set('identity', {role, org_id: 1}); await next();});
      registerErRoutes(app, {db: database});
      registerDataBrowserRoutes(app, {db: database, bad: (c, error, status) => c.json({ok: false, error}, status)});
      return app;
    };
    for (const role of ['admin', 'editor', 'production']) {
      const normal = makeApp(db, role), backup = makeApp(fallback, role);
      for (const path of ['/api/er', '/api/admin/tables', '/api/admin/tables/works/definition', '/api/admin/tables/works']) {
        const before = await normal.request(path), after = await backup.request(path);
        assert.equal(after.status, before.status);
        const expectedBody = await before.json(), actualBody = await after.json();
        if (after.ok) {
          assert.equal(actualBody.definitionSource, 'per-table');
          delete actualBody.definitionSource; delete expectedBody.definitionSource;
        }
        assert.deepEqual(actualBody, expectedBody);
      }
    }
    calls.length = 0;
    const broken = {all(sql, ...args) {if (/pragma_|^PRAGMA table_info/.test(sql)) throw new Error('DEMO-PRAGMA失敗'); return db.all(sql, ...args);}};
    await assert.rejects(readTableSchema(broken), /DEMO-PRAGMA失敗/);
  } finally {raw.close();}
});

for (const kind of ['local', 'd1', 'r2']) test(`${kind}: 数字・引用符付き表名と複合外部キーを保持し、空・失敗・再取得を区別する`, async () => {
  const {db, raw} = fixture(kind);
  try {
    raw.exec(`CREATE TABLE "DEMO-表2"(org_id INTEGER, id INTEGER, PRIMARY KEY(org_id,id));
      CREATE TABLE "DEMO-引用""符"(org_id INTEGER, parent_id INTEGER, FOREIGN KEY(org_id,parent_id) REFERENCES "DEMO-表2"(org_id,id))`);
    const {tables} = await readTableSchema(db);
    const child = tables.find((t) => t.name === 'DEMO-引用"符');
    assert.deepEqual(child.foreignKeys.map((fk) => [fk.id, fk.seq, fk.from, fk.to]), [[0, 0, 'org_id', 'org_id'], [0, 1, 'parent_id', 'id']]);
    const app = new Hono();
    let fail = true;
    const unstable = {all: (...args) => {if (fail) throw new Error('DEMO-読み取り失敗'); return db.all(...args);}};
    app.use('*', async (c, next) => {c.set('identity', {role: 'admin', org_id: 1}); await next();});
    app.onError((error, c) => c.json({ok: false, error: error.message}, 500));
    registerErRoutes(app, {db: unstable});
    const failed = await app.request('/api/er');
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).error, /読み取り失敗/);
    fail = false;
    assert.equal((await (await app.request('/api/er')).json()).tables.length, 217);
    for (const t of tables) raw.exec(`DROP TABLE "${t.name.replaceAll('"', '""')}"`);
    assert.deepEqual(await readTableSchema(db), {tables: [], definitionSource: 'table-valued'});
  } finally {raw.close();}
});
