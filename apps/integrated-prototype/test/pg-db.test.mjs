// PostgreSQL の入口（src/data-platform/pg-db.mjs。PG 計画 段1・香盤表 #8）を、SQLite の入口（LocalDatabase）と並べて確かめる。
// どちらも migrations/ から作る（SQLite は migrations/ をそのまま、PostgreSQL は変換した pg/schema.sql）。
// PostgreSQL は既定で PGlite（test/pg-client.mjs の薄い口で pg の Client をつなぐ）。ON_TEST_PG_URL（localhost だけ）を渡すと
// 手元の PostgreSQL で同じ試験を流す。架空のデータだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { LocalDatabase } from '../src/db.mjs';
import { D1Database } from '../src/d1-db.mjs';
import { PgDatabase, floatInWrite, insertTarget, parseValue, toPositional, writeInReadBatch } from '../src/data-platform/pg-db.mjs';
import { DbError, attachDbError, classifyDbError, dbErrorBody, dbErrorKind, isConstraintViolation, isDbConflict, isGuardViolation, isUniqueViolation } from '../src/data-platform/db-errors.mjs';
import { MIGRATIONS_DIR } from '../scripts/pg-ddl.mjs';
import { openPgClient } from './pg-client.mjs';

// node:sqlite の行は prototype の無いオブジェクトなので、比べる前に素のオブジェクトにそろえる
const plain = (value) => (Array.isArray(value) ? value.map(plain)
  : value && typeof value === 'object' && !(value instanceof Uint8Array) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)])) : value);

function openSqlite() {
  const db = new LocalDatabase(':memory:', { init: false });
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) db.raw.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  return db;
}

// 同じ操作を両方の入口で行い、{sqlite, pg} を返す（失敗はエラーを返す）
async function both(ctx, fn) {
  const settle = async (db) => { try { return { ok: true, value: plain(await fn(db)) }; } catch (error) { return { ok: false, error }; } };
  return { sqlite: await settle(ctx.sqlite), pg: await settle(ctx.pg) };
}
async function same(ctx, fn, message) {
  const r = await both(ctx, fn);
  assert.ok(r.sqlite.ok, `SQLite で通るはず: ${r.sqlite.error?.message}`);
  assert.ok(r.pg.ok, `PostgreSQL で通るはず: ${r.pg.error?.message}`);
  assert.deepEqual(r.pg.value, r.sqlite.value, message);
  return r.sqlite.value;
}
async function bothFail(ctx, fn) {
  const r = await both(ctx, fn);
  assert.equal(r.sqlite.ok, false, `SQLite で落ちるはず: ${JSON.stringify(r.sqlite.value)}`);
  assert.equal(r.pg.ok, false, `PostgreSQL で落ちるはず: ${JSON.stringify(r.pg.value)}`);
  return { sqlite: r.sqlite.error, pg: r.pg.error };
}

const PAYMENT_TERM = `INSERT INTO partner_payment_term_versions (org_id, created_by, reason, partner_id, version_no, active, effective_from, closing_rule, closing_day, payment_month_offset, payment_rule, payment_day, payment_method)
  VALUES (1, 1, '架空の支払条件', ?, ?, 1, ?, 'day', ?, 1, 'month_end', NULL, 'transfer')`;

// 金額を足す前に、安全な整数の Number かを確かめる（文字列の金額が '+' でつながるのを止める。FR-CORE-DATA-014）
function sumYen(rows, column) {
  return rows.reduce((total, row) => {
    const value = row[column];
    assert.ok(Number.isSafeInteger(value), `${column} は安全な整数の Number で返るはず（${typeof value} ${JSON.stringify(value)}）`);
    return total + value;
  }, 0);
}

// ---------- DB を使わない部分 ----------

test('FR-CORE-DATA-004 ? を $1・$2… に変え、文字列・識別子・コメントの中の ? は変えない', () => {
  assert.equal(toPositional('SELECT * FROM t WHERE a = ? AND b IN (?, ?)').text, 'SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)');
  assert.equal(toPositional("SELECT '?', 'it''s ?', \"col?\" FROM t WHERE x = ? -- ? はコメント\nAND y = ? /* ? /* 入れ子 ? */ ? */").text,
    "SELECT '?', 'it''s ?', \"col?\" FROM t WHERE x = $1 -- ? はコメント\nAND y = $2 /* ? /* 入れ子 ? */ ? */");
  assert.equal(toPositional("SELECT json_extract(j, '$.a[0]'), $$ ? $$ FROM t WHERE id = ?").text, "SELECT json_extract(j, '$.a[0]'), $$ ? $$ FROM t WHERE id = $1");
  assert.equal(toPositional('SELECT ?2, ?1, ?').text, 'SELECT $2, $1, $3');
  assert.equal(toPositional('SELECT a FROM t').count, 0);
  // CAST(… AS REAL) は double precision に読み替える（PostgreSQL の REAL は float4）。文字の中は変えない
  assert.equal(toPositional("SELECT CAST(? AS REAL) AS r, 'AS REAL' AS s FROM t").text, "SELECT CAST($1 AS double precision) AS r, 'AS REAL' AS s FROM t");
  // 書き込みの文の、値の置き場所（SET・VALUES・SELECT の並び）にある小数になる式と、INSERT の先の表と列
  const floatOf = (sql) => floatInWrite(toPositional(sql).masked);
  assert.equal(floatOf("INSERT INTO t(a, b) VALUES (?, 1000.5)"), '1000.5');
  assert.equal(floatOf("UPDATE t SET a = a * 1e2 WHERE id = ?"), '1e2');
  assert.equal(floatOf("INSERT INTO t(a, s) VALUES (?, '1.5')"), null, '文字の中の小数は数えない');
  assert.equal(floatOf('SELECT a / 2.0 FROM t'), null, '読み取りの文は止めない');
  assert.equal(floatOf('INSERT INTO t1(a) SELECT x10 FROM t2 WHERE n = 3'), null);
  assert.equal(floatOf('UPDATE t SET a = ? WHERE x > 0.5 AND y IN (SELECT z FROM u WHERE w < 1.5)'), null, '条件の中の小数は止めない');
  assert.equal(floatOf('UPDATE t SET a = CASE WHEN b > 0.5 THEN 1 ELSE 2.5 END WHERE id = ?'), '2.5', 'CASE の WHEN は条件、ELSE は値');
  assert.equal(floatOf('INSERT INTO t1(a) SELECT avg(x) FROM t2 GROUP BY g'), 'avg(', 'avg は小数を返す（PostgreSQL は bigint の列へ丸めて入れる）');
  assert.equal(floatOf('INSERT INTO t1(a) SELECT total(x) FROM t2'), 'total(');
  assert.equal(floatOf('INSERT INTO t1(a) VALUES (CAST(? AS REAL))'), 'AS REAL');
  assert.equal(floatOf('INSERT INTO t1(a) SELECT v FROM (SELECT 1.5 AS v) s'), '1.5', 'INSERT … SELECT の元の副問い合わせは値');
  assert.equal(floatOf('UPDATE t SET a = (SELECT max(b) FROM u WHERE u.c > 0.25) WHERE id = ?'), null);
  assert.equal(floatOf("INSERT INTO t(a) VALUES (?) ON CONFLICT(a) DO UPDATE SET b = excluded.b + 0.5 WHERE t.c > 0.5"), '0.5', 'ON CONFLICT の SET は値');
  assert.deepEqual(insertTarget(toPositional('INSERT INTO partners (id, org_id, code) VALUES (?, ?, ?)').masked), { table: 'partners', columns: ['id', 'org_id', 'code'] });
  assert.deepEqual(insertTarget(toPositional('INSERT INTO t SELECT * FROM u').masked), { table: 't', columns: null });
  assert.deepEqual(insertTarget(toPositional('INSERT INTO t DEFAULT VALUES').masked), { table: 't', columns: [] });
  assert.equal(insertTarget(toPositional("SELECT 'INSERT INTO x (id) VALUES (1)'").masked), null);
});

test('FR-CORE-DATA-012 FR-CORE-DATA-013 FR-CORE-DATA-051 値の型: bigint は安全な整数、表の numeric は Decimal の文字、date・JSON は文字、真偽は 0/1', () => {
  const field = (dataTypeID, tableID = 0) => ({ name: 'v', dataTypeID, tableID });
  assert.equal(parseValue('9007199254740991', field(20, 1)), 9007199254740991);
  assert.equal(parseValue('-9007199254740991', field(20)), -9007199254740991);
  assert.throws(() => parseValue('9007199254740992', field(20, 1)), (e) => e instanceof DbError && e.dbError.kind === 'out_of_range');
  assert.equal(parseValue('1000.50', field(1700, 16385)), '1000.50', '表の numeric の列は Decimal の文字のまま');
  assert.equal(parseValue('15', field(1700, 16385)), '15');
  assert.equal(parseValue('15', field(1700)), 15, '計算した numeric（bigint の sum）は小数点が無ければ整数');
  assert.throws(() => parseValue('90071992547409930', field(1700)), (e) => e.dbError?.kind === 'out_of_range');
  assert.equal(parseValue('1.5000000000000000', field(1700)), '1.5000000000000000', '小数点のある計算の結果（avg など）は Decimal の文字');
  assert.equal(parseValue('2026-01-02', field(1082)), '2026-01-02');
  assert.equal(parseValue('{"a": [1, 2]}', field(3802)), '{"a": [1, 2]}');
  assert.equal(parseValue('t', field(16)), 1);
  assert.equal(parseValue('f', field(16)), 0);
  assert.equal(parseValue(null, field(20)), null);
  assert.deepEqual([...parseValue('\\x00ff10', field(17))], [0, 255, 16]);
  // 配列は SQLite に無い型で、要素の範囲を確かめられないので止める（生の文字で返さない）
  assert.throws(() => parseValue('{9007199254740993}', field(1016)), (e) => e.dbError?.kind === 'unsupported_type');
  assert.throws(() => parseValue('{1.5,2}', field(1231)), (e) => e.dbError?.kind === 'unsupported_type');
});

test('FR-CORE-DATA-009 読み取りの一括に渡してよい文: SELECT・WITH・VALUES で、書き込みを含まない', () => {
  assert.equal(writeInReadBatch('SELECT id FROM t WHERE x = ?'), null);
  assert.equal(writeInReadBatch('WITH a AS (SELECT 1) SELECT * FROM a'), null);
  assert.equal(writeInReadBatch("SELECT replace(name, 'a', 'b'), 'UPDATE t SET x = 1' FROM t"), null, '関数の replace と文字の中は書き込みにしない');
  assert.equal(writeInReadBatch("UPDATE partners SET name = 'x'"), 'UPDATE');
  assert.equal(writeInReadBatch('INSERT INTO t(a) VALUES (1)'), 'INSERT');
  assert.equal(writeInReadBatch('WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a'), 'INSERT');
  assert.equal(writeInReadBatch('DELETE FROM t'), 'DELETE');
  assert.equal(writeInReadBatch('PRAGMA foreign_keys=OFF'), 'PRAGMA');
});

test('FR-CORE-DATA-015 SQLite・D1 の文と PostgreSQL の SQLSTATE を、同じ共通のエラーの種類に読む', () => {
  const sqlite = (message, errcode) => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
  const pgError = (code, fields = {}) => Object.assign(new Error('x'), { code, severity: 'ERROR', ...fields });
  assert.deepEqual(classifyDbError(sqlite('UNIQUE constraint failed: partners.org_id, partners.code', 2067)),
    { code: 2067, kind: 'unique', table: 'partners', columns: ['org_id', 'code'], constraint: null });
  assert.deepEqual(classifyDbError(pgError('23505', { table: 'partners', constraint: 'partners_org_id_code_key', detail: 'Key (org_id, code)=(1, P001) already exists.' })),
    { kind: 'unique', table: 'partners', columns: ['org_id', 'code'], constraint: 'partners_org_id_code_key', code: '23505' });
  // D1 は前に D1_ERROR、後ろに結果コードを付ける
  assert.equal(dbErrorKind(new Error('D1_ERROR: UNIQUE constraint failed: partners.code: SQLITE_CONSTRAINT')), 'unique');
  assert.deepEqual(classifyDbError(new Error('D1_ERROR: CHECK constraint failed: value=1: SQLITE_CONSTRAINT')).constraint, 'value=1');
  assert.equal(classifyDbError(new Error('D1_ERROR: stale expense version: SQLITE_CONSTRAINT')).message, 'stale expense version');
  assert.equal(dbErrorKind(sqlite('stale expense version', 1811)), 'raise');
  assert.equal(dbErrorKind(pgError('P0001')), 'raise');
  assert.equal(dbErrorKind(sqlite('FOREIGN KEY constraint failed', 787)), 'foreign_key');
  assert.equal(dbErrorKind(pgError('23503', { detail: 'Key (user_id)=(99) is not present in table "users".' })), 'foreign_key');
  assert.equal(dbErrorKind(sqlite('NOT NULL constraint failed: organizations.name', 1299)), 'not_null');
  assert.equal(dbErrorKind(pgError('23502', { column: 'name' })), 'not_null');
  assert.equal(dbErrorKind(pgError('22P02')), 'invalid_input', '読めない値（読み取りの WHERE id = \'abc\' など）は制約の違反にしない');
  assert.equal(dbErrorKind(attachDbError(pgError('22P02'), { inWrite: true })), 'check', '書き込みの文の整数の列への小数（SQLite では整数の強制の CHECK）');
  assert.equal(dbErrorKind(attachDbError(pgError('22003'), { inWrite: false })), 'invalid_input');
  assert.equal(isDbConflict(pgError('22P02')), false, '読み取りの型の誤りは 409 にしない');
  assert.equal(dbErrorKind(pgError('25006')), 'read_only');
  assert.equal(dbErrorKind(sqlite('attempt to write a readonly database', 8)), 'read_only');
  assert.equal(dbErrorKind(pgError('42P01')), null, 'ほかの SQLSTATE は種類にしない');
  assert.equal(dbErrorKind(new Error('stale broadcast slot')), null, 'アプリが投げた文は DB の種類にしない');
  assert.equal(dbErrorKind(Object.assign(new Error('EPIPE'), { code: 'EPIPE' })), null);
  // 同時更新の止め（transaction_guards）
  assert.ok(isGuardViolation(sqlite('CHECK constraint failed: value=1', 275)));
  assert.ok(isGuardViolation(pgError('23514', { table: 'transaction_guards', constraint: 'transaction_guards_value_check' })));
  assert.ok(!isGuardViolation(sqlite('CHECK constraint failed: value_type IN (\'text\')', 275)));
  assert.ok(isUniqueViolation(sqlite('UNIQUE constraint failed: broadcast_slots.org_id', 2067), 'broadcast_slots'));
  assert.ok(!isUniqueViolation(sqlite('UNIQUE constraint failed: broadcast_slots.org_id', 2067), ['partners']));
  assert.ok(isConstraintViolation(pgError('23514')));
  assert.ok(!isConstraintViolation(pgError('P0001')), 'トリガーの拒否は制約の違反に数えない');
  assert.ok(isDbConflict(pgError('P0001')), '状態の番号（409）の判定はトリガーの拒否を含める（D1 の … : SQLITE_CONSTRAINT が前の照合で 409 だった）');
  assert.ok(isDbConflict(sqlite('stale expense version', 1811)));
  assert.ok(isDbConflict(pgError('23505')));
  assert.ok(!isDbConflict(new Error('接続が切れました')));
  assert.deepEqual(dbErrorBody(pgError('23505', { table: 't', detail: 'Key (code)=(x) already exists.' })), { kind: 'unique', table: 't', columns: ['code'] });
  assert.equal(dbErrorBody(new Error('x')), null);
});

test('FR-CORE-DATA-009 D1 の読み取りの一括は、素の batch を1回だけ呼び、文ごとの行を返す', async () => {
  const calls = [];
  const binding = {
    prepare: (sql) => ({ bind: (...params) => ({ sql, params }) }),
    batch: async (statements) => { calls.push(statements); return statements.map((s, i) => ({ success: true, results: [{ i, sql: s.sql, params: s.params }] })); },
  };
  const out = await new D1Database(binding).readBatch([{ sql: 'SELECT 1', params: [] }, { sql: 'SELECT ?', params: [2] }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(out, [[{ i: 0, sql: 'SELECT 1', params: [] }], [{ i: 1, sql: 'SELECT ?', params: [2] }]]);
  const failing = { ...binding, batch: async (statements) => statements.map(() => ({ success: false })) };
  await assert.rejects(new D1Database(failing).readBatch([{ sql: 'SELECT 1' }]), /D1 read batch failed/);
  // D1 の batch は書き込みも通すので、書き込みの文は素の batch を呼ぶ前に断る
  await assert.rejects(new D1Database(binding).readBatch([{ sql: 'SELECT 1' }, { sql: "UPDATE partners SET name = 'x'" }]), (e) => e.dbError?.kind === 'read_only');
  assert.equal(calls.length, 1, '書き込みの混ざった一括では素の batch を呼ばない');
  // D1 のエラーにも共通のエラーの種類を付ける
  const throwing = { ...binding, batch: async () => { throw new Error('D1_ERROR: UNIQUE constraint failed: partners.code: SQLITE_CONSTRAINT'); } };
  await assert.rejects(new D1Database(throwing).batch([{ sql: 'INSERT INTO partners(code) VALUES (?)', params: ['x'] }]), (e) => e.dbError?.kind === 'unique');
});

// ---------- SQLite と PostgreSQL を並べる ----------

describe('SQLite の入口と PostgreSQL の入口を並べる', () => {
  const ctx = {};
  before(async () => {
    ctx.sqlite = openSqlite();
    ctx.conn = await openPgClient();
    ctx.pg = new PgDatabase(ctx.conn.client);
  });
  after(async () => {
    ctx.sqlite?.close();
    await ctx.conn?.close();
  });

  test('FR-CORE-DATA-003 FR-CORE-DATA-005 入口の4つが同じ形の結果を返す（all は行の配列、get は1行か null、run は変わった行の数、batch は文ごとの変わった行の数と RETURNING の行）', async () => {
    await same(ctx, (db) => db.run("INSERT INTO organizations (id, code, name) VALUES (1, 'ORG1', '架空の組織')"));
    await same(ctx, (db) => db.run("INSERT INTO users (id, email, display_name) VALUES (1, 'tester@example.invalid', '架空の利用者')"));
    await same(ctx, (db) => db.run("INSERT INTO memberships (org_id, user_id, role, active) VALUES (1, 1, 'admin', 1)"));
    // 新しい行の ID は RETURNING で受け取る（lastInsertRowid は返さない）
    const inserted = await same(ctx, (db) => db.get('INSERT INTO partners (org_id, code, name) VALUES (?, ?, ?) RETURNING id, code', [1, 'P001', '架空の取引先']));
    assert.deepEqual(inserted, { id: 1, code: 'P001' });
    assert.deepEqual(await same(ctx, (db) => db.run('UPDATE partners SET name = ? WHERE org_id = ?', ['架空の取引先（改）', 1])), { changes: 1 });
    assert.deepEqual(await same(ctx, (db) => db.run('UPDATE partners SET name = ? WHERE org_id = ?', ['x', 99])), { changes: 0 });
    assert.deepEqual(await same(ctx, (db) => db.all('SELECT id, org_id, code, name FROM partners WHERE org_id = ? ORDER BY id', [1])),
      [{ id: 1, org_id: 1, code: 'P001', name: '架空の取引先（改）' }]);
    assert.equal(await same(ctx, (db) => db.get('SELECT id FROM partners WHERE code = ?', ['無い'])), null);
    assert.deepEqual(await same(ctx, (db) => db.all('SELECT id FROM partners WHERE code = ?', ['無い'])), []);
    const batch = await same(ctx, (db) => db.batch([
      { sql: 'INSERT INTO partners (org_id, code, name) VALUES (?, ?, ?) RETURNING id', params: [1, 'P002', '架空の取引先2'] },
      { sql: 'UPDATE partners SET name = name WHERE org_id = ?', params: [1] },
      { sql: "INSERT INTO partners (org_id, code, name) SELECT 1, 'P003', '架空の取引先3' WHERE 1 = 0" },
    ]));
    assert.deepEqual(batch, [{ changes: 1, rows: [{ id: 2 }] }, { changes: 2, rows: [] }, { changes: 0, rows: [] }]);
  });

  test('FR-CORE-DATA-004 アプリの ? の SQL を両方で同じに流す（文字列・コメントの中の ? は値にしない）', async () => {
    const row = await same(ctx, (db) => db.get("SELECT ? AS a, '?' AS q, 'it''s ?' AS s /* ? */, ? AS b -- ?\n FROM partners WHERE code = ?", ['x', 'y', 'P001']));
    assert.deepEqual(row, { a: 'x', q: '?', s: "it's ?", b: 'y' });
  });

  test('FR-CORE-DATA-022 ID を指定して入れた行のあと、ID を指定せずに入れた行は既存の ID とぶつからない（batch の中でも）', async () => {
    await same(ctx, (db) => db.run("INSERT INTO partners (id, org_id, code, name) VALUES (10, 1, 'P010', '明示の ID')"));
    assert.deepEqual(await same(ctx, (db) => db.get("INSERT INTO partners (org_id, code, name) VALUES (1, 'P011', '自動の ID') RETURNING id")), { id: 11 });
    const out = await same(ctx, (db) => db.batch([
      { sql: "INSERT INTO partners (id, org_id, code, name) VALUES (20, 1, 'P020', '明示の ID')" },
      { sql: "INSERT INTO partners (org_id, code, name) VALUES (1, 'P021', '自動の ID') RETURNING id" },
    ]));
    assert.deepEqual(out[1].rows, [{ id: 21 }]);
    // 小さい ID を明示しても、順番の値は下げない
    await same(ctx, (db) => db.run("INSERT INTO partners (id, org_id, code, name) VALUES (5, 1, 'P005', '明示の小さい ID')"));
    assert.deepEqual(await same(ctx, (db) => db.get("INSERT INTO partners (org_id, code, name) VALUES (1, 'P022', '自動の ID') RETURNING id")), { id: 22 });
  });

  test('FR-CORE-DATA-006 batch は1つのトランザクション: transaction_guards の CHECK で途中が落ちると、前の文の書き込みも残らない', async () => {
    const errors = await bothFail(ctx, (db) => db.batch([
      { sql: "INSERT INTO partners (org_id, code, name) VALUES (1, 'P100', '戻るはずの行')" },
      { sql: 'INSERT INTO transaction_guards (value) SELECT 0 WHERE EXISTS (SELECT 1 FROM partners WHERE org_id = ?)', params: [1] },
    ]));
    assert.ok(isGuardViolation(errors.sqlite), errors.sqlite.message);
    assert.ok(isGuardViolation(errors.pg), errors.pg.message);
    assert.deepEqual(await same(ctx, (db) => db.all("SELECT id FROM partners WHERE code = 'P100'")), []);
    // 戻ったあとも同じ接続で書ける
    assert.deepEqual(await same(ctx, (db) => db.run("UPDATE partners SET name = name WHERE code = 'P001'")), { changes: 1 });
  });

  test('FR-CORE-DATA-015 制約の違反とトリガーの拒否は、両方の DB で同じ共通のエラーの種類になる（トリガーは同じ文）', async () => {
    const unique = await bothFail(ctx, (db) => db.run("INSERT INTO partners (org_id, code, name) VALUES (1, 'P001', '同じコード')"));
    for (const error of [unique.sqlite, unique.pg]) {
      assert.equal(error.dbError?.kind, 'unique', error.message);
      assert.equal(error.dbError.table, 'partners');
      assert.deepEqual(error.dbError.columns, ['org_id', 'code']);
    }
    const check = await bothFail(ctx, (db) => db.run('INSERT INTO billing_invoice_sequences (org_id, year_month, last_number) VALUES (1, ?, 1)', ['2026-11']));
    assert.deepEqual([check.sqlite.dbError?.kind, check.pg.dbError?.kind], ['check', 'check']);
    const fk = await bothFail(ctx, (db) => db.run("INSERT INTO memberships (org_id, user_id, role, active) VALUES (1, 99, 'admin', 1)"));
    assert.deepEqual([fk.sqlite.dbError?.kind, fk.pg.dbError?.kind], ['foreign_key', 'foreign_key']);
    const notNull = await bothFail(ctx, (db) => db.run('INSERT INTO organizations (code, name) VALUES (?, NULL)', ['ORG2']));
    assert.deepEqual([notNull.sqlite.dbError?.kind, notNull.pg.dbError?.kind], ['not_null', 'not_null']);
    // トリガーの拒否（更新の禁止・版の飛ばし）は、種類も文も同じ
    await same(ctx, (db) => db.run(PAYMENT_TERM, [1, 1, '2026-10-01', 25]));
    const immutable = await bothFail(ctx, (db) => db.run('UPDATE partner_payment_term_versions SET reason = ? WHERE org_id = 1 AND partner_id = 1', ['書き換え']));
    assert.deepEqual([immutable.sqlite.dbError?.kind, immutable.pg.dbError?.kind], ['raise', 'raise']);
    assert.equal(immutable.pg.message, immutable.sqlite.message);
    const stale = await bothFail(ctx, (db) => db.run(PAYMENT_TERM, [1, 3, '2026-11-01', 25]));
    assert.deepEqual([stale.sqlite.dbError?.kind, stale.pg.dbError?.kind], ['raise', 'raise']);
    assert.equal(stale.pg.message, stale.sqlite.message);
  });

  test('FR-CORE-DATA-012 bigint の列への小数は、値で渡しても SQL の定数で書いても、両方で値の範囲の違反で止まり丸めて入らない', async () => {
    const param = await bothFail(ctx, (db) => db.run(PAYMENT_TERM, [1, 2, '2026-11-01', 15.5]));
    assert.deepEqual([param.sqlite.dbError?.kind, param.pg.dbError?.kind], ['check', 'check']);
    const literal = await bothFail(ctx, (db) => db.run(PAYMENT_TERM.replace("'day', ?, 1", "'day', 15.5, 1"), [1, 2, '2026-11-01']));
    assert.deepEqual([literal.sqlite.dbError?.kind, literal.pg.dbError?.kind], ['check', 'check']);
    assert.deepEqual(await same(ctx, (db) => db.all('SELECT version_no FROM partner_payment_term_versions WHERE org_id = 1 ORDER BY version_no')), [{ version_no: 1 }]);
  });

  test('FR-CORE-DATA-012 FR-CORE-DATA-014 bigint の列・count・整数の sum は安全な整数の Number で両方同じ。範囲を超える値は丸めずに止まる', async () => {
    await same(ctx, (db) => db.batch([
      { sql: 'INSERT INTO billing_invoice_sequences (org_id, year_month, last_number) VALUES (1, ?, ?)', params: ['202610', 9007199254740000] },
      { sql: 'INSERT INTO billing_invoice_sequences (org_id, year_month, last_number) VALUES (1, ?, ?)', params: ['202611', 991] },
    ]));
    const rows = await same(ctx, (db) => db.all('SELECT last_number FROM billing_invoice_sequences WHERE org_id = 1 ORDER BY year_month'));
    assert.equal(sumYen(rows, 'last_number'), 9007199254740991);
    const totals = await same(ctx, (db) => db.get('SELECT count(*) AS n, sum(last_number) AS total, CAST(sum(last_number) AS BIGINT) AS cast_total FROM billing_invoice_sequences WHERE org_id = ?', [1]));
    assert.deepEqual(totals, { n: 2, total: 9007199254740991, cast_total: 9007199254740991 });
    // 安全な整数を超える値: SQLite（node:sqlite）も PostgreSQL の入口も、丸めずに止まる
    await same(ctx, (db) => db.run("UPDATE billing_invoice_sequences SET last_number = last_number + 1 WHERE year_month = '202611'"));
    const over = await bothFail(ctx, (db) => db.get('SELECT sum(last_number) AS total FROM billing_invoice_sequences WHERE org_id = 1'));
    assert.match(over.sqlite.message, /too large/);
    assert.equal(over.pg.dbError?.kind, 'out_of_range');
    const big = await bothFail(ctx, (db) => db.get('SELECT CAST(? AS BIGINT) AS v', ['9007199254740993']));
    assert.match(big.sqlite.message, /too large/);
    assert.equal(big.pg.dbError?.kind, 'out_of_range');
  });

  test('FR-CORE-DATA-014 金額が文字列で返ると、足す前の確かめで落ちる（pg の既定の型の読み方では bigint が文字列になる）', async () => {
    const raw = await ctx.conn.client.query("SELECT last_number FROM billing_invoice_sequences WHERE year_month = '202610'");
    assert.equal(typeof raw.rows[0].last_number, 'string', 'pg の既定は bigint を文字列で返す');
    assert.throws(() => sumYen([{ last_number: 1 }, ...raw.rows], 'last_number'), /安全な整数の Number/);
    assert.equal(1 + raw.rows[0].last_number, '19007199254740000', '確かめずに足すと文字列としてつながる');
    const viaEntry = await ctx.pg.all("SELECT last_number FROM billing_invoice_sequences WHERE year_month = '202610'");
    assert.equal(sumYen([{ last_number: 1 }, ...viaEntry], 'last_number'), 9007199254740001);
  });

  test('FR-CORE-DATA-051 date・JSON・真偽は SQLite の入口と同じ JavaScript の型で返る（JSON は解析した値で比べる）', async () => {
    const json = '{"b": 1, "a": [1, 2]}';
    const lite = plain(await ctx.sqlite.get('SELECT date(?) AS d, json(?) AS j, (1 = 1) AS yes, (1 = 0) AS no', ['2026-01-02', json]));
    const pgRow = await ctx.pg.get('SELECT CAST(? AS date) AS d, CAST(? AS jsonb) AS j, (1 = 1) AS yes, (1 = 0) AS no', ['2026-01-02', json]);
    for (const row of [lite, pgRow]) {
      assert.equal(row.d, '2026-01-02');
      assert.equal(typeof row.j, 'string');
      assert.deepEqual(JSON.parse(row.j), { a: [1, 2], b: 1 });
      assert.deepEqual([row.yes, row.no], [1, 0]);
    }
    assert.notEqual(pgRow.j, lite.j, 'jsonb はキーの順と空白を整えるので、文字列では比べない');
  });

  test('FR-CORE-DATA-013 numeric の列は Decimal の文字列で返り、浮動小数点の Number にならない', async () => {
    await ctx.conn.client.query('CREATE TABLE pgdb_decimal_probe (id bigint PRIMARY KEY, amount numeric(20, 4))');
    await ctx.pg.batch([{ sql: 'INSERT INTO pgdb_decimal_probe (id, amount) VALUES (1, ?)', params: ['0.1000'] }, { sql: 'INSERT INTO pgdb_decimal_probe (id, amount) VALUES (2, ?)', params: ['0.2000'] }]);
    const rows = await ctx.pg.all('SELECT amount FROM pgdb_decimal_probe ORDER BY id');
    assert.deepEqual(rows, [{ amount: '0.1000' }, { amount: '0.2000' }]);
    assert.deepEqual(await ctx.pg.get('SELECT sum(amount) AS total, avg(amount) AS mean FROM pgdb_decimal_probe'), { total: '0.3000', mean: '0.15000000000000000000' });
  });

  test('FR-CORE-DATA-003 同じ名前の列が2つある行は、両方で後の列の値を残し、列ごとにその列の型で読む', async () => {
    assert.deepEqual(await same(ctx, (db) => db.get("SELECT CAST(1 AS BIGINT) AS v, 'abc' AS v")), { v: 'abc' });
    assert.deepEqual(await same(ctx, (db) => db.get("SELECT 'abc' AS v, CAST(7 AS BIGINT) AS v")), { v: 7 });
    const joined = await same(ctx, (db) => db.get("SELECT p.*, m.role AS name FROM partners p JOIN memberships m ON m.org_id = p.org_id WHERE p.code = 'P001'"));
    assert.equal(joined.name, 'admin');
  });

  test('FR-CORE-DATA-012 書き込みの条件の中の小数は通し、値の置き場所の小数になる式（avg・AS REAL）は PostgreSQL で丸めずに止める', async () => {
    assert.deepEqual(await same(ctx, (db) => db.run("UPDATE partners SET name = name WHERE code = 'P001' AND id > 0.5")), { changes: 1 });
    await assert.rejects(ctx.pg.run("UPDATE billing_invoice_sequences SET last_number = (SELECT avg(last_number) FROM billing_invoice_sequences) WHERE org_id = 1"), (e) => e.dbError?.kind === 'check');
    await assert.rejects(ctx.pg.run('UPDATE billing_invoice_sequences SET last_number = CAST(? AS REAL) WHERE org_id = 1', [2.5]), (e) => e.dbError?.kind === 'check');
    // 読み取りの CAST(… AS REAL) は SQLite と同じ倍精度（PostgreSQL の REAL のままだと 16777217 が 16777216 になる）
    assert.deepEqual(await same(ctx, (db) => db.get('SELECT CAST(? AS REAL) AS r', [16777217])), { r: 16777217 });
  });

  test('FR-CORE-DATA-015 読み取りの条件の型の誤り（bigint の列と読めない文字）は、制約の違反（409）にしない', async () => {
    assert.equal(await ctx.sqlite.get('SELECT id FROM partners WHERE id = ?', ['abc']), null, 'SQLite は行が無いだけ');
    await assert.rejects(ctx.pg.get('SELECT id FROM partners WHERE id = ?', ['abc']), (e) => e.dbError?.kind === 'invalid_input' && !isDbConflict(e));
  });

  test('FR-CORE-DATA-007 PostgreSQL の batch は文の数の上限（D1 の500）を持ち込まず、1,200文を1つのトランザクションで全部入れるか全部戻す', async () => {
    const statements = Array.from({ length: 1200 }, (_, i) => ({ sql: 'INSERT INTO partners (org_id, code, name) VALUES (?, ?, ?)', params: [1, `B${String(i).padStart(4, '0')}`, '一括の架空の行'] }));
    const failing = [...statements.map((s) => ({ ...s, params: [s.params[0], `F${s.params[1]}`, s.params[2]] })), { sql: 'INSERT INTO transaction_guards (value) VALUES (0)' }];
    await assert.rejects(ctx.pg.batch(failing), (e) => isGuardViolation(e));
    assert.deepEqual(await ctx.pg.get("SELECT count(*) AS n FROM partners WHERE code LIKE 'FB%'"), { n: 0 });
    const out = await ctx.pg.batch(statements);
    assert.equal(out.length, 1200);
    assert.deepEqual(await ctx.pg.get("SELECT count(*) AS n FROM partners WHERE code LIKE 'B%'"), { n: 1200 });
  });

  test('FR-CORE-DATA-009 読み取りの一括は、文ごとの行を all と同じ形で返す。PostgreSQL は READ ONLY・REPEATABLE READ のトランザクション', async () => {
    const statements = [
      { sql: 'SELECT id, code FROM partners WHERE org_id = ? AND code IN (?, ?) ORDER BY id', params: [1, 'P001', 'P002'] },
      { sql: 'SELECT count(*) AS n FROM memberships WHERE org_id = ?', params: [1] },
    ];
    const read = await same(ctx, (db) => db.readBatch(statements));
    assert.deepEqual(read, [[{ id: 1, code: 'P001' }, { id: 2, code: 'P002' }], [{ n: 1 }]]);
    assert.deepEqual(read[0], plain(await ctx.sqlite.all(statements[0].sql, statements[0].params)));
    const [[mode]] = await ctx.pg.readBatch([{ sql: "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only" }]);
    assert.deepEqual(mode, { isolation: 'repeatable read', read_only: 'on' });
    // 書き込みの文は、3つの入口とも共通のエラーの種類 read_only で断り、SQLite でも書き込みが入らない
    const writing = await bothFail(ctx, (db) => db.readBatch([{ sql: 'SELECT 1 AS one' }, { sql: "UPDATE partners SET name = '一括で書いた' WHERE code = 'P001'" }]));
    assert.deepEqual([writing.sqlite.dbError?.kind, writing.pg.dbError?.kind], ['read_only', 'read_only']);
    assert.deepEqual(await same(ctx, (db) => db.all("SELECT count(*) AS n FROM partners WHERE name = '一括で書いた'")), [{ n: 0 }]);
    // 文の見た目で分からない書き込み（順番の値を進める nextval）も、PostgreSQL は READ ONLY で断る（25006 → read_only）
    await assert.rejects(ctx.pg.readBatch([{ sql: "SELECT nextval(pg_get_serial_sequence('partners', 'id')) AS n" }]), (e) => e.dbError?.kind === 'read_only');
    // SQLite は一括のあいだ PRAGMA query_only で書き込みを断り、一括のあとは戻す
    assert.deepEqual(plain(ctx.sqlite.raw.prepare('PRAGMA query_only').get()), { query_only: 0 });
    // 一括の外は、いつもの書き込みのトランザクションに戻る
    const [[normal]] = await ctx.pg.batch([{ sql: "SELECT current_setting('transaction_read_only') AS read_only" }]).then((out) => [out[0].rows]);
    assert.deepEqual(normal, { read_only: 'off' });
  });

  test('FR-CORE-DATA-009 読み取りの一括の途中に別の接続が書いても、一括は1つの時点の行だけを返す（本物の PostgreSQL の2つの接続）', { skip: process.env.ON_TEST_PG_URL ? false : 'PGlite は接続が1つなので、同時の書き込みを挟めない（CI の postgres:18-alpine で流す）' }, async () => {
    const pool = ctx.conn.pool();
    const reader = new PgDatabase(pool);
    const writer = new PgDatabase(pool);
    const reading = reader.readBatch([
      { sql: 'SELECT count(*) AS n FROM partners WHERE org_id = ?', params: [1] },
      { sql: 'SELECT pg_sleep(0.5) IS NULL AS slept' },
      { sql: 'SELECT count(*) AS n FROM partners WHERE org_id = ?', params: [1] },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writer.run("INSERT INTO partners (org_id, code, name) VALUES (1, 'SNAP1', '一括の途中に足した行')");
    const [first, , last] = await reading;
    assert.deepEqual(last, first, '一括の中では、途中に足した行が見えない');
    const now = await writer.get('SELECT count(*) AS n FROM partners WHERE org_id = ?', [1]);
    assert.equal(now.n, first[0].n + 1);
  });
});

test('PgDatabase は Pool か Client を受け取り、接続文字列を持たない', () => {
  assert.throws(() => new PgDatabase('postgres://example.invalid/db'), /Pool か Client/);
  const pool = new pg.Pool({ max: 1 });
  assert.equal(new PgDatabase(pool).isPool, true);
  pool.end();
  assert.equal(new PgDatabase({ query: async () => ({ rows: [], fields: [] }) }).isPool, false);
});

test('FR-CORE-DATA-006 Pool の接続は、ROLLBACK や BEGIN が落ちたときと接続の誤りのとき release(error) で捨て、SQL の誤りのときは戻す', async () => {
  // 偽の Pool: 接続ごとに、どの文で落ちるかを決める
  function fakePool(failOn) {
    const released = [];
    const pool = {
      totalCount: 0,
      query: async () => ({ rows: [], fields: [], rowCount: 0 }),
      connect: async () => ({
        query: async (q) => {
          const text = typeof q === 'string' ? q : q.text;
          const hit = failOn.find(([pattern]) => pattern.test(text));
          if (hit) throw hit[1]();
          return { rows: [], fields: [], rowCount: 1 };
        },
        release: (...args) => released.push(args),
      }),
    };
    return { pool, released };
  }
  const sqlError = () => Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', severity: 'ERROR' });
  const lost = () => Object.assign(new Error('Connection terminated unexpectedly'));
  const statements = [{ sql: 'INSERT INTO t(a) VALUES (?)', params: [1] }];

  // SQL の誤り（サーバーが返した 23505）で ROLLBACK が通れば、接続は Pool に戻す
  let fake = fakePool([[/^INSERT/, sqlError]]);
  await assert.rejects(new PgDatabase(fake.pool).batch(statements), (e) => e.dbError?.kind === 'unique');
  assert.deepEqual(fake.released, [[]]);
  // ROLLBACK も落ちた（接続が切れた）ら、release(error) で捨てる
  fake = fakePool([[/^INSERT/, lost], [/^ROLLBACK/, lost]]);
  await assert.rejects(new PgDatabase(fake.pool).batch(statements), /Connection terminated/);
  assert.equal(fake.released.length, 1);
  assert.ok(fake.released[0][0] instanceof Error, 'ROLLBACK が落ちた接続は捨てる');
  // BEGIN が落ちた接続も捨てる
  fake = fakePool([[/^BEGIN/, lost]]);
  await assert.rejects(new PgDatabase(fake.pool).readBatch([{ sql: 'SELECT 1' }]), /Connection terminated/);
  assert.ok(fake.released[0][0] instanceof Error);
  // COMMIT が接続の誤りで落ち、ROLLBACK も落ちたら捨てる
  fake = fakePool([[/^COMMIT/, lost], [/^ROLLBACK/, lost]]);
  await assert.rejects(new PgDatabase(fake.pool).batch(statements), /Connection terminated/);
  assert.ok(fake.released[0][0] instanceof Error);
  // 1つの文（ID を指定した INSERT は接続を借りる）が接続の誤りで落ちたら捨てる
  fake = fakePool([[/^INSERT/, lost]]);
  await assert.rejects(new PgDatabase(fake.pool).run('INSERT INTO t(id, a) VALUES (?, ?)', [1, 2]), /Connection terminated/);
  assert.ok(fake.released[0][0] instanceof Error, '接続の誤り（サーバーの SQLSTATE の無いエラー）は捨てる');
  // 成功したら引数なしで戻す
  fake = fakePool([]);
  await new PgDatabase(fake.pool).batch(statements);
  assert.deepEqual(fake.released, [[]]);
});

test('FR-CORE-DATA-016 API は DB の制約の違反を共通のエラーの種類で判定し、SQLite の文でも PostgreSQL の SQLSTATE でも同じ状態の番号と dbError を返す', async () => {
  const { createApp } = await import('../src/app.mjs');
  const login = async (app) => (await app.request('/api/local/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@openingnight.invalid' }) })).headers.get('set-cookie').split(';')[0];
  const post = (app, cookie, body) => app.request('/api/partners', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const db = new LocalDatabase(':memory:');
  try {
    // SQLite: 同じコードの取引先を2回入れる
    const app = createApp({ db, mode: 'local' });
    const cookie = await login(app);
    assert.equal((await post(app, cookie, { code: 'PGDB-1', name: '架空の取引先', kind: 'other' })).status, 201);
    const dup = await post(app, cookie, { code: 'PGDB-1', name: '同じコード', kind: 'other' });
    const dupBody = await dup.json();
    assert.equal(dup.status, 409);
    assert.deepEqual(dupBody.dbError, { kind: 'unique', table: 'partners', columns: ['org_id', 'code'] });
    // PostgreSQL の SQLSTATE（23505）で同じ違反が返ったときも、同じ状態の番号と種類になる（文は PostgreSQL の文のまま）
    const pgLike = Object.create(db);
    pgLike.get = async (sql, params) => {
      if (/^INSERT INTO partners/.test(sql)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "partners_org_id_code_key"'),
          { code: '23505', severity: 'ERROR', table: 'partners', constraint: 'partners_org_id_code_key', detail: 'Key (org_id, code)=(1, PGDB-1) already exists.' });
      }
      return db.get(sql, params);
    };
    const pgApp = createApp({ db: pgLike, mode: 'local' });
    const pgDup = await post(pgApp, await login(pgApp), { code: 'PGDB-1', name: '同じコード', kind: 'other' });
    assert.equal(pgDup.status, 409);
    assert.deepEqual((await pgDup.json()).dbError, dupBody.dbError);
    // DB の制約の違反でない失敗には dbError を載せない
    const plainFail = Object.create(db);
    plainFail.get = async (sql, params) => { if (/^INSERT INTO partners/.test(sql)) throw new Error('接続が切れました'); return db.get(sql, params); };
    const failApp = createApp({ db: plainFail, mode: 'local' });
    const failed = await post(failApp, await login(failApp), { code: 'PGDB-2', name: '架空', kind: 'other' });
    assert.equal(failed.status, 500);
    assert.equal('dbError' in (await failed.json()), false);
  } finally {
    db.close();
  }
});
