// PostgreSQL の版の印・カタログの確かめ・照合・アプリのロールの権限（香盤表 #27・段2の準備 論点9・10）。
// pg/schema.sql の最後の版の印の表、手で書いた pg/verify-catalog.sql、生成した pg/reconcile.sql、scripts/pg-role-check.mjs を、
// 試験の DB のファクトリ（test/test-db.mjs）の PostgreSQL（ON_TEST_PG_URL があれば手元の PostgreSQL、無ければ PGlite）で流す。
// 照合は SQLite（ファクトリの LocalDatabase）とも比べる。DB の種類は明示するので、npm test と npm run test:pg で同じことを確かめる。架空のデータだけ。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OUTPUT_PATH, RECONCILE_PATH, VERIFY_CATALOG_PATH, convertMigrations, lf, reconcileSql } from '../scripts/pg-ddl.mjs';
import { EXTRA_GRANTS, createProbeRole, dropProbeRole, formatResults, queryable, runProbes } from '../scripts/pg-role-check.mjs';
import { PG_FINGERPRINT_TABLE } from '../src/data-platform/pg-fingerprint.mjs';
import { readTableSchema } from '../src/admin/er-routes.mjs';
import { tableCounts } from '../scripts/seed-all-demo.mjs';
import { openTestDb } from './test-db.mjs';

const generated = convertMigrations();
const COUNT_ITEMS = ['tables', 'triggers', 'functions', 'identities', 'foreign_keys', 'indexes'];
const MARK_ITEMS = ['current_schema', 'fingerprint_rows', 'generator', 'last_migration', 'source_sha256', 'migrations_sha256', 'app_ddl_sha256', 'ddl_sha256'];

const raw = (db) => queryable(db.queryable);
const verifyCatalog = async (db) => (await raw(db).query(readFileSync(VERIFY_CATALOG_PATH, 'utf8'))).rows;
const byItem = (rows) => Object.fromEntries(rows.map((r) => [r.item, r]));

test('pg/schema.sql の最後に版の印の表があり、指紋と期待する数は生成の結果と同じ（ddl_sha256 は印の節より前の sha256）', () => {
  const sql = lf(readFileSync(OUTPUT_PATH, 'utf8'));
  assert.equal(sql, generated.sql, 'node scripts/pg-ddl.mjs で作り直してコミットする');
  const at = sql.indexOf(`\n\n-- ===== 版の印`);
  assert.ok(at > 0, '版の印の節がある');
  assert.match(sql.slice(at), new RegExp(`CREATE TABLE ${PG_FINGERPRINT_TABLE} \\(`));
  const f = generated.fingerprint;
  assert.equal(createHash('sha256').update(sql.slice(0, at + 1)).digest('hex'), f.ddlSha256);
  assert.match(sql, new RegExp(`^-- 元の移行の指紋: sha256 ${f.sourceSha256}$`, 'm'));
  assert.deepEqual(f.expected, { tables: 258, triggers: 540, functions: 199, identities: 137, foreignKeys: 628, indexes: 125 });
  assert.equal(f.expected.tables, generated.tables.length, '版の印の表は数えない');
  assert.ok(!generated.tables.includes(PG_FINGERPRINT_TABLE), 'D1・SQLite の表の一覧には入らない');
  assert.match(readFileSync(VERIFY_CATALOG_PATH, 'utf8'), new RegExp(`FROM ${PG_FINGERPRINT_TABLE}\\b`), 'verify-catalog.sql は同じ名前の表を読む');
});

test('pg/verify-catalog.sql は、当てた DDL の数（表258・トリガー540・IDENTITY137 など）を版の印と並べ、数と指紋と current_schema だけを出す', async (t) => {
  const pg = await openTestDb({ t, kind: 'pg' });
  const rows = await verifyCatalog(pg);
  assert.deepEqual(rows.map((r) => Object.keys(r)), rows.map(() => ['ord', 'item', 'actual', 'expected', 'ok']));
  assert.deepEqual(rows.map((r) => r.item), [...MARK_ITEMS, ...COUNT_ITEMS], '項目は数と印だけ');
  const items = byItem(rows);
  for (const item of COUNT_ITEMS) assert.equal(items[item].ok, true, `${item}: ${items[item].actual} と ${items[item].expected}`);
  assert.equal(items.tables.actual, '258');
  assert.equal(items.triggers.actual, '540');
  assert.equal(items.identities.actual, '137');
  assert.equal(items.fingerprint_rows.ok, true);
  const f = generated.fingerprint;
  assert.deepEqual([items.generator.actual, items.last_migration.actual, items.source_sha256.actual, items.migrations_sha256.actual, items.app_ddl_sha256.actual, items.ddl_sha256.actual],
    [f.generator, f.lastMigration, f.sourceSha256, f.migrationsSha256, f.appDdlSha256, f.ddlSha256]);
  assert.equal(items.current_schema.actual, (await pg.get('SELECT current_schema() AS s')).s);
  for (const item of MARK_ITEMS.filter((x) => x !== 'fingerprint_rows')) assert.equal(items[item].ok, null, `${item} は見比べる印で、判定しない`);
});

test('pg/verify-catalog.sql は、トリガー・索引の欠けと余計な表を false で出す', async (t) => {
  const pg = await openTestDb({ t, kind: 'pg' });
  await pg.run('DROP TRIGGER distribution_master_no_update ON distribution_master');
  await pg.run('DROP INDEX scenes_org_work_id_uidx CASCADE');
  await raw(pg).query('CREATE TABLE extra_probe_table (id bigint)');
  const items = byItem(await verifyCatalog(pg));
  assert.deepEqual(COUNT_ITEMS.filter((item) => items[item].ok === false), ['tables', 'triggers', 'foreign_keys', 'indexes']);
  assert.equal(items.tables.actual, '259');
  assert.equal(items.triggers.actual, '539');
  assert.equal(items.indexes.actual, '124');
});

test('pg/reconcile.sql は生成物と一致し、SQLite と PostgreSQL で表ごとの件数と金額の列の合計が同じになり、差を見逃さない', async (t) => {
  const sql = readFileSync(RECONCILE_PATH, 'utf8');
  assert.equal(lf(sql), reconcileSql(generated), 'node scripts/pg-ddl.mjs で作り直してコミットする');
  assert.ok(!sql.includes(PG_FINGERPRINT_TABLE), '版の印の表は照合しない（D1 に無い）');
  const lite = await openTestDb({ t, kind: 'sqlite' });
  const pg = await openTestDb({ t, kind: 'pg' });
  const insert = "INSERT INTO projects (org_id, code, title, budget_yen) VALUES (1, 'RECON-1', '架空の企画', 1234567)";
  await lite.run(insert);
  await pg.run(insert);
  const norm = (rows) => rows.map((r) => [String(r.ord), r.table_name, String(r.row_count), r.money_sums]);
  const left = norm(await lite.all(sql));
  const right = norm((await raw(pg).query(sql)).rows);
  assert.equal(left.length, 258);
  assert.deepEqual(right, left);
  const projects = left.find((r) => r[1] === 'projects');
  assert.match(projects[3], /^budget_yen=\d+$/);
  assert.ok(Number(projects[3].split('=')[1]) >= 1234567, projects[3]);
  assert.ok(left.filter((r) => r[3]).length > 50, '金額の列のある表');
  // 値の行は出さない（列は並び・表・件数・合計の4つ）
  assert.deepEqual(Object.keys((await lite.all(sql))[0]), ['ord', 'table_name', 'row_count', 'money_sums']);
  await pg.run("UPDATE projects SET budget_yen = budget_yen + 1 WHERE code = 'RECON-1'");
  const after = norm((await raw(pg).query(sql)).rows);
  assert.deepEqual(after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(left[i])).map((r) => r[1]), ['projects']);
});

test('版の印の表は PostgreSQL だけにあり、管理画面の表の定義（ER 図・データ一覧）と表ごとの行数には出ない', async (t) => {
  const lite = await openTestDb({ t, kind: 'sqlite' });
  const pg = await openTestDb({ t, kind: 'pg' });
  assert.equal(Number((await pg.get(`SELECT count(*) AS n FROM ${PG_FINGERPRINT_TABLE}`)).n), 1);
  const names = async (db) => (await readTableSchema(db)).tables.map((x) => x.name);
  const pgNames = await names(pg);
  assert.ok(!pgNames.includes(PG_FINGERPRINT_TABLE));
  assert.deepEqual(pgNames, await names(lite), 'SQLite と同じ表の一覧');
  assert.ok(!Object.hasOwn(await tableCounts(pg), PG_FINGERPRINT_TABLE));
});

let roleSeq = 0;
async function probeWith(t, extra = null) {
  const pg = await openTestDb({ t, kind: 'pg' });
  const admin = raw(pg);
  const role = `perm_probe_${process.pid}_${roleSeq += 1}`;
  // ロールはクラスタに1つなので、DB を閉じる前（試験の中）に消す
  try {
    await createProbeRole({ admin, role, extra });
    return await runProbes({ admin, role });
  } finally {
    await dropProbeRole({ admin, role });
  }
}

test('pg_read_all_data と pg_write_all_data だけのロールは、DML・setval・pg_sequence_last_value ができ、CREATE TABLE・DISABLE TRIGGER・TRUNCATE を断られ、禁止のトリガーが効く', async (t) => {
  const results = await probeWith(t);
  assert.deepEqual(results.filter((r) => !r.ok), [], formatResults(results));
  assert.equal(results.length, 9);
});

test('staging の権限SQLは真偽だけを返し、アプリ権限で全IDENTITYを確かめてもsequenceを変えない', async (t) => {
  const pg = await openTestDb({t, kind:'pg'});
  const admin = raw(pg);
  const role = `staging_probe_${process.pid}_${roleSeq += 1}`;
  const sql = readFileSync(new URL('../pg/staging-permissions.sql', import.meta.url),'utf8');
  const split = sql.indexOf('CREATE TEMP TABLE');
  const readSequences = async () => (await admin.query("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows;
  const before = await readSequences();
  try {
    await createProbeRole({admin,role});
    await admin.query(`SET ROLE "${role}"`);
    const row = (await admin.query(sql.slice(0,split))).rows[0];
    assert.deepEqual(Object.keys(row),['database_ok','schema_ok','owner_is_other_ok','no_create_ok']);
    assert.equal(Object.values(row).every(value=>typeof value==='boolean'),true);
    assert.equal(row.schema_ok,true);
    assert.equal(row.owner_is_other_ok,true);
    assert.equal(row.no_create_ok,true);
    const end = sql.indexOf('SELECT sequence_ok');
    await admin.query(sql.slice(split,end));
    assert.deepEqual((await admin.query('SELECT sequence_ok FROM staging_permission_result')).rows,[{sequence_ok:true}]);
    await admin.query('DROP TABLE staging_permission_result');
    await admin.query('RESET ROLE');
    assert.deepEqual(await readSequences(),before);
  } finally { await admin.query('RESET ROLE'); await dropProbeRole({admin,role}); }
});

test('わざと権限を足したロールでは、権限の試験が落ちる（create・truncate・owner・superuser）', async (t) => {
  const failedBy = {};
  for (const extra of Object.keys(EXTRA_GRANTS)) {
    failedBy[extra] = (await probeWith(t, extra)).filter((r) => !r.ok).map((r) => r.name);
  }
  assert.deepEqual(failedBy, {
    create: ['CREATE TABLE が断られる'],
    truncate: ['TRUNCATE が断られる'],
    owner: ['ALTER TABLE … DISABLE TRIGGER が断られる', 'TRUNCATE が断られる'],
    superuser: ['ロールの属性（pg_read_all_data・pg_write_all_data だけ・superuser などでない）', 'CREATE TABLE が断られる', 'ALTER TABLE … DISABLE TRIGGER が断られる', 'TRUNCATE が断られる'],
  });
});
