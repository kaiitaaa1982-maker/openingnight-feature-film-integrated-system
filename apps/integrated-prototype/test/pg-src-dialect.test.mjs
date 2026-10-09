// アプリの SQL の方言（PG 計画 段1・香盤表 #11 の PR3。FR-CORE-DATA-023・025）を、SQLite（LocalDatabase）と PostgreSQL（PgDatabase。
// 既定は PGlite、ON_TEST_PG_URL があれば手元の PostgreSQL）の両方で流し、同じ結果になるかを確かめる。
// PostgreSQL の入口は json_extract・json_each・CAST(… AS INTEGER)・CURRENT_TIMESTAMP を補助の関数（pg/schema.sql の lite_*）へ読み替え、
// 値がそのまま json_extract の INSERT … SELECT は入れる先の列の型へ CAST する（src/data-platform/pg-db.mjs・src/data-platform/lite-sql.mjs）。
// 試験の DB はファクトリ（test/test-db.mjs）で両方を明示して開く。架空のデータだけを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './test-db.mjs';
import { jsonInsertItems, rewriteLite } from '../src/data-platform/pg-db.mjs';
import { TIMESTAMP_TEXT } from '../src/data-platform/lite-sql.mjs';
import { productionCommitStatements } from '../src/production.mjs';
import { partitionCommitStatements } from '../src/import/sales-source-store.mjs';
import { cloudAnalyticsSql, createCloudAnalytics } from '../src/cloud-analytics.mjs';
import { createApp } from '../src/app.mjs';
import { decodeXlsx } from '../src/xlsx.mjs';

const KINDS = ['sqlite', 'pg'];

// 確かめ用の表（列の型だけを DB ごとに書く。SQLite の整数の列は money.md と同じ typeof の CHECK で小数を断る）
const PROBE = {
  sqlite: "CREATE TABLE dialect_probe (id INTEGER PRIMARY KEY, n INTEGER CHECK (n IS NULL OR typeof(n) = 'integer'), t TEXT, r REAL, at TEXT)",
  pg: 'CREATE TABLE dialect_probe (id bigint PRIMARY KEY, n bigint, t text COLLATE "C", r double precision, at text COLLATE "C")',
};

// 両方の DB で同じ手順を流し、DB ごとの結果を返す
async function both(t, fn, { probe = false } = {}) {
  const out = {};
  for (const kind of KINDS) {
    const db = await openTestDb({ t, kind });
    if (probe) await db.run(PROBE[kind]);
    out[kind] = await fn(db, kind);
  }
  return out;
}
// 両方の DB で同じ結果になることを確かめ、その結果を返す（SQLite の行は prototype の無いオブジェクトなので、ふつうの値にして比べる）
const plain = (value) => JSON.parse(JSON.stringify(value));
async function same(t, fn, options) {
  const out = await both(t, fn, options);
  assert.deepEqual(plain(out.pg), plain(out.sqlite), 'SQLite と PostgreSQL で結果が違う');
  return plain(out.sqlite);
}

test('入口の読み替え: 関数の名前だけを替え、文字列・コメント・表の名前つきの列の中は変えない', () => {
  assert.equal(rewriteLite("SELECT json_extract(j.value, '$.a') FROM json_each(?) j").text, "SELECT lite_json_extract(j.value, '$.a') FROM lite_json_each(?, '$') j");
  assert.equal(rewriteLite("SELECT JSON_EACH ( ? , '$.f' ) -- json_each(x)\n, 'json_extract(x)', x.json_each").text, "SELECT lite_json_each ( ? , '$.f' ) -- json_each(x)\n, 'json_extract(x)', x.json_each");
  assert.equal(rewriteLite('SELECT CAST(value AS INTEGER), CAST((a + 1) AS INT), CAST(x AS TEXT) FROM t').text, 'SELECT lite_cast_int(value), lite_cast_int((a + 1)), CAST(x AS TEXT) FROM t');
  assert.equal(rewriteLite("UPDATE t SET at=CURRENT_TIMESTAMP WHERE note<>'CURRENT_TIMESTAMP'").text, `UPDATE t SET at=${TIMESTAMP_TEXT} WHERE note<>'CURRENT_TIMESTAMP'`);
  // 引数の数が違う呼び出しは読み替えない（PostgreSQL がそのまま断る）
  assert.equal(rewriteLite("SELECT json_extract(x, '$.a', '$.b')").text, "SELECT json_extract(x, '$.a', '$.b')");
});

test('入口の読み替え: INSERT … SELECT の値がそのまま json_extract の位置と、入れる先の列を見つける', () => {
  const found = jsonInsertItems(rewriteLite("INSERT INTO t(a, \"B\", c, d) SELECT ?, json_extract(j.value,'$.b'), json_extract(j.value,'$.c')+1, json_extract(j.value,'$.d') FROM json_each(?) j ORDER BY key").tokens);
  assert.deepEqual(found.items.map((item) => item.column), ['B', 'd']);
  assert.equal(found.table, 't');
  assert.equal(jsonInsertItems(rewriteLite("INSERT INTO t(a) VALUES(json_extract(?, '$.a'))").tokens), null);
  assert.equal(jsonInsertItems(rewriteLite("INSERT INTO t(a, b) SELECT json_extract(?, '$.a') FROM x").tokens), null, '並びの数が列と合わない文は見ない');
});

test('json_each は配列・オブジェクト・スカラー・null を、SQLite と同じ行・同じ順・同じ値で返す（key・value は文字にして比べる）', async (t) => {
  const cases = [
    ['[1,1.5,"x",null,true,false,{"b":1,"a":2},[1,2]]', '$'],
    ['{"b":1,"a":{"z":1,"b":[1,2]},"aa":"s"}', '$'],
    ['5', '$'], ['"s"', '$'], ['null', '$'], [null, '$'],
    ['{"f":[{"d":3,"t":"x"}]}', '$.f'], ['{"f":[1]}', '$.missing'], ['[[1,2],[3]]', '$[1]'], ['[]', '$'], ['{}', '$'],
  ];
  const rows = await same(t, async (db) => {
    const out = [];
    for (const [json, path] of cases) out.push(await db.all('SELECT CAST(key AS TEXT) AS k, CAST(value AS TEXT) AS v, type FROM json_each(?, ?)', [json, path]));
    out.push(await db.all('SELECT CAST(key AS TEXT) AS k, CAST(value AS TEXT) AS v, type FROM json_each(?)', [cases[0][0]]));
    return out;
  });
  assert.deepEqual(rows[0], [
    { k: '0', v: '1', type: 'integer' }, { k: '1', v: '1.5', type: 'real' }, { k: '2', v: 'x', type: 'text' }, { k: '3', v: null, type: 'null' },
    { k: '4', v: '1', type: 'true' }, { k: '5', v: '0', type: 'false' }, { k: '6', v: '{"b":1,"a":2}', type: 'object' }, { k: '7', v: '[1,2]', type: 'array' },
  ]);
  assert.deepEqual(rows[1].map((row) => row.k), ['b', 'a', 'aa'], 'オブジェクトのキーは文書の順（jsonb の並べ替えた順ではない）');
  assert.deepEqual(rows[2], [{ k: null, v: '5', type: 'integer' }], 'スカラーは key が NULL の1行');
  assert.deepEqual(rows[4], [{ k: null, v: null, type: 'null' }], 'JSON の null も1行');
  assert.deepEqual(rows[5], [], 'SQL の NULL は0行');
  assert.deepEqual(rows[7], [], '無い道筋は0行');
  assert.deepEqual(rows[11], rows[0], 'json_each(x) は json_each(x, \'$\') と同じ');
});

test('json_each の配列は ORDER BY CAST(key AS INTEGER) で、10個を超えても文書の順に並ぶ。値は CAST(value AS INTEGER) で比べる', async (t) => {
  const items = Array.from({ length: 12 }, (_, n) => n * 10);
  const rows = await same(t, async (db) => ({
    order: (await db.all('SELECT CAST(value AS INTEGER) AS v FROM json_each(?) ORDER BY CAST(key AS INTEGER) DESC', [JSON.stringify(items)])).map((row) => row.v),
    // 売上シートの IDS・原本の取込の配賦の照合と同じ形（数の列と json_each の値を比べる）
    ids: (await db.all('SELECT id FROM products WHERE org_id = 1 AND id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY id', ['[2,1,99]'])).map((row) => row.id),
    none: (await db.all('SELECT id FROM products WHERE org_id = 1 AND id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) ORDER BY id', ['[1]'])).map((row) => row.id),
  }));
  assert.deepEqual(rows, { order: [...items].reverse(), ids: [1, 2], none: [2] });
});

test('json_extract の値を INSERT … SELECT で列へ入れると、数・文字・null・真偽・入れ子が SQLite と同じ値と型で入る', async (t) => {
  const payload = JSON.stringify([[1, 7, 'あ', 1.5], [2, null, null, null], [3, true, { z: 1, b: [1, 2] }, 2], [4, '12', 'x', -0.25], [5, false, 5, 1.50]]);
  const rows = await same(t, async (db) => {
    // 確定版の明細と同じ形（列ごとに json_extract(value,'$[n]')、ORDER BY CAST(key AS INTEGER)）
    await db.run("INSERT INTO dialect_probe(id,n,t,r) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]') FROM json_each(?) ORDER BY CAST(key AS INTEGER)", [payload]);
    // 取込の登録と同じ形（オブジェクトのキー、値の置き場所の ? をまぜる）
    await db.run("INSERT INTO dialect_probe(id,n,t) SELECT json_extract(j.value,'$.id'), ?, json_extract(j.value,'$.t') FROM json_each(?) j", [42, JSON.stringify([{ id: 6, t: 'y' }, { id: 7 }])]);
    return db.all('SELECT id, n, t, r FROM dialect_probe ORDER BY id');
  }, { probe: true });
  assert.deepEqual(rows, [
    { id: 1, n: 7, t: 'あ', r: 1.5 }, { id: 2, n: null, t: null, r: null }, { id: 3, n: 1, t: '{"z":1,"b":[1,2]}', r: 2 },
    { id: 4, n: 12, t: 'x', r: -0.25 }, { id: 5, n: 0, t: '5', r: 1.5 }, { id: 6, n: 42, t: 'y', r: null }, { id: 7, n: 42, t: null, r: null },
  ]);
});

test('json_extract の小数を整数の列へ入れる行は、両方の DB で check の誤りになり、何も入らない', async (t) => {
  const out = await both(t, async (db) => {
    const error = await db.run("INSERT INTO dialect_probe(id,n) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?)", ['[[1,2],[2,1.5]]']).then(() => null, (e) => e);
    return { kind: error?.dbError?.kind ?? null, rows: (await db.get('SELECT count(*) AS c FROM dialect_probe')).c };
  }, { probe: true });
  assert.deepEqual(out, { sqlite: { kind: 'check', rows: 0 }, pg: { kind: 'check', rows: 0 } });
});

test('json_extract の値は CAST(… AS INTEGER) で数の列と比べ、足し、CASE で数の列とまぜる（版の照合・繰り上げ・取込の明細の形）', async (t) => {
  const rows = await same(t, async (db) => {
    await db.run("INSERT INTO dialect_probe(id,n,t) VALUES (1, 3, 'a'), (2, 4, 'b')");
    const change = JSON.stringify({ id: 2, base: 4, o: 'r', e: 1, territory: 'b' });
    return {
      match: await db.all("SELECT id FROM dialect_probe WHERE id = CAST(json_extract(?, '$.id') AS INTEGER) AND t = json_extract(?, '$.territory')", [change, change]),
      next: await db.get("SELECT CAST(json_extract(?, '$.base') AS INTEGER) + 1 AS v", [change]),
      stale: await db.all("SELECT id FROM dialect_probe WHERE CAST(json_extract(?, '$.base') AS INTEGER) <> COALESCE((SELECT MAX(n) FROM dialect_probe WHERE id = 2), 0)", [change]),
      entry: await db.get("SELECT CASE WHEN json_extract(?, '$.o') = 'a' THEN (SELECT MAX(id) FROM dialect_probe) ELSE CAST(json_extract(?, '$.e') AS INTEGER) END AS e", [change, change]),
      missing: await db.get("SELECT CAST(json_extract(?, '$.none') AS INTEGER) AS v", [change]),
    };
  }, { probe: true });
  assert.deepEqual(rows, { match: [{ id: 2 }], next: { v: 5 }, stale: [], entry: { e: 1 }, missing: { v: null } });
});

test('CAST(… AS INTEGER) は SQLite と同じ値（先頭の整数・読めなければ 0・0 の方へ切り捨て・64ビット）', async (t) => {
  const row = await same(t, (db) => db.get('SELECT CAST(? AS INTEGER) AS a, CAST(? AS INTEGER) AS b, CAST(? AS INTEGER) AS c, CAST(-1.9 AS INTEGER) AS d, CAST(NULL AS INTEGER) AS e', ['12abc', 'abc', '9007199254740991']));
  assert.deepEqual(row, { a: 12, b: 0, c: 9007199254740991, d: -1, e: null });
});

test('CURRENT_TIMESTAMP は両方の DB で UTC の YYYY-MM-DD HH:MM:SS の文字（文字の列への INSERT・UPDATE と、読み取り）', async (t) => {
  const started = Date.now();
  const out = await both(t, async (db) => {
    await db.run('INSERT INTO dialect_probe(id, at) VALUES (1, CURRENT_TIMESTAMP)');
    await db.run("UPDATE dialect_probe SET at = CURRENT_TIMESTAMP, t = 'x' WHERE id = 1");
    return [(await db.get('SELECT at FROM dialect_probe WHERE id = 1')).at, (await db.get('SELECT CURRENT_TIMESTAMP AS now')).now];
  }, { probe: true });
  for (const value of [...out.sqlite, ...out.pg]) {
    assert.match(value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const at = Date.parse(`${value.replace(' ', 'T')}Z`);
    assert.ok(at >= Math.floor(started / 1000) * 1000 - 1000 && at <= Date.now() + 1000, `${value} は試験の時刻（UTC）`);
  }
});

test('ON CONFLICT DO NOTHING（INSERT OR IGNORE の置き換え）: 撮影の役は、同じ名前・同じキーの行があれば両方の DB で黙って飛ばす', async (t) => {
  const statements = productionCommitStatements(1, 1, [{ sceneNo: '1', cast: ['架空の役A', '架空の役B'] }], new Map([['1', 1]]))
    .filter((statement) => /^INSERT INTO production_characters\b/.test(statement.sql));
  assert.equal(statements.length, 2);
  const rows = await same(t, async (db) => {
    // 名前は同じでキーが違う役（手で足した役）。一意の制約は (org_id,work_id,key) と (org_id,work_id,name) の2つ
    await db.run("INSERT INTO production_characters(org_id,work_id,key,name) VALUES (1, 1, 'manual-a', '架空の役A')");
    await db.batch(statements);
    await db.batch(statements);
    return db.all('SELECT key, name FROM production_characters WHERE org_id = 1 AND work_id = 1 ORDER BY key');
  });
  assert.deepEqual(rows, [{ key: 'manual-a', name: '架空の役A' }, { key: 'role:架空の役B', name: '架空の役B' }]);
});

test('ON CONFLICT(org_id) DO NOTHING（INSERT OR IGNORE の置き換え）: 分析の更新の状態の行は1つのまま、2回目の開始で世代が進む', async (t) => {
  const identity = { org_id: 1, user_id: 1, role: 'admin' };
  const rows = await same(t, async (db) => {
    for (const sql of cloudAnalyticsSql.split(';').map((s) => s.trim()).filter(Boolean)) await db.run(sql);
    let tick = Date.parse('2030-01-01T00:00:00Z');
    const service = createCloudAnalytics({ db, bucket: {}, registrationId: 'synthetic-test-registration', definitionVersion: 'test-definition-1', clock: () => new Date(tick), leaseMs: 1000 });
    await service.begin(identity, '2026-09-22');
    tick += 5000; // 1回目の貸し出しの期限が切れたあと
    await service.begin(identity, '2026-09-22');
    return db.all('SELECT org_id, generation FROM cloud_analytics_state');
  });
  assert.deepEqual(rows, [{ org_id: 1, generation: 2 }]);
});

test('json_each の値を数の列と IN で比べる（原本の取込の配賦の照合）: 確かめた作品の外への配賦があるときだけ、両方の DB で止まる', async (t) => {
  const guard = (workIds) => partitionCommitStatements({ org_id: 1, user_id: 1 }, {
    mapping: { sourceProductIds: [1, 2], sourceAllocationWorkIds: workIds }, meta: {}, workId: 1, hash: 'h',
  }, 'token')[0];
  const out = await same(t, async (db) => {
    const result = [];
    for (const workIds of [[1], [], [2]]) {
      const { sql, params } = guard(workIds);
      result.push(await db.run(sql, params).then(() => 'ok', (e) => e.dbError?.kind ?? 'error'));
    }
    return result;
  });
  assert.deepEqual(out, ['ok', 'check', 'check']);
});

// 画面の API を、渡した DB の上の試作のアプリで呼ぶ（試作のログイン。架空の利用者）
function appOn(db) {
  const app = createApp({ db, mode: 'local' });
  const sessions = {};
  return async (role) => {
    if (!sessions[role]) {
      const login = await app.request('/api/local/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${role}@openingnight.invalid` }) });
      assert.equal(login.status, 200, role);
      sessions[role] = login.headers.get('set-cookie').split(';')[0];
    }
    const cookie = sessions[role];
    const call = async (method, path, payload) => {
      const response = await app.request(`/api${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
      const type = response.headers.get('content-type') || '';
      return { status: response.status, body: type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer()) };
    };
    const ok = async (response) => { assert.ok(response.status < 300, JSON.stringify(response.body).slice(0, 400)); return response.body; };
    return { get: (path) => call('GET', path), post: (path, payload) => call('POST', path, payload), ok };
  };
}

test('全作品のウィンドウの取込の登録（JOIN json_each … ON 1=1 を2段）: 追加と修正の版・項目の値が、両方の DB で同じ行で入る', async (t) => {
  const rows = await same(t, async (db) => {
    const admin = await appOn(db)('admin');
    await admin.ok(await admin.post('/release-window-types/adopt', { reason: '初期の種別を採用（試験）' }));
    const types = new Map((await admin.ok(await admin.get('/release-window-types'))).types.map((type) => [type.type_key, type]));
    await admin.ok(await admin.post('/release-windows', { workId: 1, typeId: types.get('svod_early').id, baseVersion: 0, start: '2027-01-15', end: '2027-12', fields: { price_ex_tax: '1500', exclusivity: 'exclusive' }, reason: '試験' }));
    const preview = await admin.ok(await admin.post('/release-windows/import/preview', {
      table: { headers: ['作品コード', 'SVOD先行 配信期限', 'SVOD先行 版', 'AVOD 解禁日', 'AVOD 版'], rows: [['WRK-DEMO', '2027-12-31', 1, '2028-01', '']] }, fileName: '架空.xlsx',
    }));
    const commit = await admin.ok(await admin.post('/release-windows/import/commit', { token: preview.token, confirmed: true, reason: 'Excel で期限を確定（試験）', fileName: '架空.xlsx' }));
    return {
      commit,
      versions: await db.all(`SELECT t.type_key, v.version_no, v.type_version_no, v.start_on, v.end_on, v.date_precision, v.status, v.source_kind, v.source_reference, v.reason
        FROM work_release_window_versions v JOIN work_release_windows w ON w.id = v.window_id JOIN release_window_types t ON t.id = w.type_id ORDER BY t.type_key, v.version_no`),
      fields: await db.all(`SELECT t.type_key, f.version_no, f.field_key, f.value_text, f.value_number
        FROM work_release_window_field_values f JOIN work_release_windows w ON w.id = f.window_id JOIN release_window_types t ON t.id = w.type_id ORDER BY t.type_key, f.version_no, f.field_key`),
    };
  });
  assert.deepEqual([rows.commit.append, rows.commit.revise], [1, 1]);
  assert.deepEqual(rows.versions.map((v) => [v.type_key, v.version_no, v.start_on, v.end_on, v.source_kind]), [
    ['avod', 1, '2028-01', null, 'excel_import'], ['svod_early', 1, '2027-01-15', '2027-12', 'manual'], ['svod_early', 2, '2027-01-15', '2027-12-31', 'excel_import'],
  ]);
  assert.deepEqual(rows.fields.filter((f) => f.version_no === 2).map((f) => [f.field_key, f.value_text ?? f.value_number]), [['exclusivity', 'exclusive'], ['price_ex_tax', 1500]], '修正の版は前の版の項目の値を引き継ぐ');
});

test('取引先別リストの取込の登録（JOIN json_each … ON 1=1 を2段・版の照合）: 追加と修正の明細・項目の値が、両方の DB で同じ行で入る', async (t) => {
  const rows = await same(t, async (db) => {
    const as = appOn(db);
    const admin = await as('admin');
    const editor = await as('editor');
    await admin.ok(await admin.post('/partner-list-fields', { fieldKey: 'viewing_hours', label: '視聴期間（時間）', valueType: 'integer', partnerId: 2, reason: '取引先2だけの列（試験）' }));
    const field = (await admin.ok(await admin.get('/partner-list-fields'))).fields.find((f) => f.field_key === 'viewing_hours').id;
    const list = (await editor.ok(await editor.post('/partner-lists', { partnerId: 2, listKind: 'distribution', name: '見放題（試験）', reason: '取引先のリストを作る（試験）' }))).id;
    const entry = (await editor.ok(await editor.post(`/partner-lists/${list}/entries`, { workId: 1, values: { distribution_code: 'D005', contract_start: '2025-01-01', contract_end: '2026-10-10', status: 'contracted', fields: { [field]: '48' } }, reason: '許諾通知書を登録（試験）' }))).entryId;
    const sheets = decodeXlsx((await editor.get(`/partner-lists/${list}/template.xlsx?kind=current&asOf=2026-09-25`)).body);
    const input = sheets.find((s) => s.name === '入力');
    const meta = Object.fromEntries(sheets.find((s) => s.name === '_meta').rows.slice(1).map((r) => [r[0], r[1]]));
    const headers = input.rows[0].map((h) => String(h ?? ''));
    const h = (label) => headers.indexOf(label);
    const revised = [...input.rows[1]];
    revised[h('契約終了日')] = '2027-03-31';
    const added = headers.map(() => '');
    added[h('作品コード')] = 'WRK-DEMO'; added[h('流通ID')] = 'V001'; added[h('契約開始日')] = '2026-10-01'; added[h('契約終了日')] = '2027-09-30';
    added[h('状態')] = '予定'; added[h('取引方法')] = 'FLAT'; added[h('契約金額（税抜）')] = '1,200,000'; added[h('視聴期間（時間）')] = '72';
    const table = { headers, meta, rows: [{ rowNo: 2, cells: revised }, { rowNo: 3, cells: added }] };
    const preview = await editor.ok(await editor.post(`/partner-lists/${list}/import/preview`, { table, fileName: '架空.xlsx' }));
    const commit = await editor.ok(await editor.post(`/partner-lists/${list}/import/commit`, { token: preview.token, reason: '取引先から届いた一覧を反映（試験）', confirmed: true }));
    return {
      entry,
      commit: { appended: commit.appended, revised: commit.revised, withdrawn: commit.withdrawn },
      versions: await db.all(`SELECT entry_id, version_no, distribution_code, contract_start, contract_end, status, settlement_method, amount_ex_tax, source_row, import_batch_id IS NOT NULL AS imported
        FROM partner_list_entry_versions ORDER BY entry_id, version_no`),
      fields: await db.all(`SELECT v.entry_id, v.version_no, d.field_key, f.value_text, f.value_number
        FROM partner_list_field_values f JOIN partner_list_entry_versions v ON v.id = f.entry_version_id JOIN partner_list_field_definitions d ON d.id = f.definition_id ORDER BY v.entry_id, v.version_no, d.field_key`),
    };
  });
  assert.deepEqual(rows.commit, { appended: 1, revised: 1, withdrawn: 0 });
  assert.deepEqual(rows.versions.map((v) => [v.entry_id, v.version_no, v.contract_end, v.amount_ex_tax, Boolean(v.imported)]), [
    [rows.entry, 1, '2026-10-10', null, false], [rows.entry, 2, '2027-03-31', null, true], [rows.entry + 1, 1, '2027-09-30', 1200000, true],
  ]);
  assert.deepEqual(rows.fields.map((f) => [f.entry_id, f.version_no, f.field_key, f.value_number]), [
    [rows.entry, 1, 'viewing_hours', 48], [rows.entry, 2, 'viewing_hours', 48], [rows.entry + 1, 1, 'viewing_hours', 72],
  ]);
});
