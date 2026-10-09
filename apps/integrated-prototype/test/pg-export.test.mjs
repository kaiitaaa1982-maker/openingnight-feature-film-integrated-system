import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {openPgClient} from './pg-client.mjs';
import {PgDatabase} from '../src/data-platform/pg-db.mjs';
import {exportPgDatabase, scanExportTable, EXPORT_BATCH_ROWS, SMALL_EXPORT_ROW_BYTES, MAX_EXPORT_ROW_BYTES} from '../src/data-platform/pg-export-store.mjs';
import {restorePgDatabase} from '../src/data-platform/pg-restore-store.mjs';
import {compareReconciliation} from '../../../scripts/ops/pg-reconcile.mjs';
import {runScheduledPgExport} from '../src/data-platform/cloud-pg-export.mjs';
import {memoryBucket, exportFixture, exportSchema} from './pg-export-fixture.mjs';
import {sha256} from '../src/data-platform/pg-export-store.mjs';
import {RECONCILE_MONEY_COLUMN, EXPORT_ERROR_CODES, exportError, failureCause} from '../src/data-platform/pg-export-format.mjs';
import {RECONCILE_MONEY_COLUMN as ddlMoneyColumn} from '../scripts/pg-ddl.mjs';

const MiB = 1024 * 1024;
// 原因の種類が code と同じで、許可リストを通ってログに出る形であること
const causeIs = code => error => error.code === code && failureCause(error) === code;

test('FR-CORE-DATA-043 書き出しを空のPGへ戻すと全表の件数と金額が元と一致する', async t => {
  const source = await openTestDb({t, kind: 'pg'});
  const target = await openPgClient({applySchema: false});
  t.after(() => target.close());
  const bucket = memoryBucket();
  const result = await exportPgDatabase({db: source, bucket, pageRows: 2});
  assert.equal(result.manifest.tables.length, 258);
  const restored = await restorePgDatabase({db: new PgDatabase(target.client), bucket, manifestKey: result.manifestKey,
    schemaSql: readFileSync(new URL('../pg/schema.sql', import.meta.url), 'utf8')});
  assert.deepEqual(compareReconciliation(result.manifest, restored), {equal: true, differences: []});
  assert.deepEqual(await source.all('SELECT * FROM organizations ORDER BY id'), await new PgDatabase(target.client).all('SELECT * FROM organizations ORDER BY id'));
});

test('FR-CORE-DATA-045 照合は両DBのSQLの出力を読み金額差と欠落を見逃さない', async t => {
  assert.equal(RECONCILE_MONEY_COLUMN.source, ddlMoneyColumn.source);
  const db = await openTestDb({t});
  const rows = await db.all(readFileSync(new URL('../pg/reconcile.sql', import.meta.url), 'utf8'));
  assert.deepEqual(compareReconciliation(rows, rows), {equal: true, differences: []});
  assert.equal(compareReconciliation(rows, rows.slice(1)).equal, false);
  const money = rows.find(row => row.money_sums);
  const changed = rows.map(row => row === money ? {...row, money_sums: row.money_sums.replace(/=-?\d+/, '=123456789')} : row);
  assert.equal(compareReconciliation(rows, changed).equal, false);
});

// 練習 E（PITR の drill の DB に reconcile.sql を流し、世代の manifest と比べる）が、金額の列の選び方の違いで
// 誤って不一致にならないこと。manifest は PostgreSQL のカタログの整数の列から、reconcile.sql は migrations の宣言から選ぶ。
test('FR-CORE-DATA-045 同じDBの書き出しのmanifestとreconcile.sqlの結果は照合で一致する', async t => {
  const db = await openTestDb({t, kind: 'pg'});
  const org = (await db.get('SELECT id FROM organizations ORDER BY id LIMIT 1')).id;
  // 合計が 2^53 を超える金額と NULL の金額を混ぜる（架空の値）
  await db.run('INSERT INTO projects (org_id, code, title, budget_yen) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    [org, 'FICT-RECON-1', '架空の照合1', '9007199254740993', org, 'FICT-RECON-2', '架空の照合2', null]);
  const {manifest} = await exportPgDatabase({db, bucket: memoryBucket()});
  const rows = await db.all(readFileSync(new URL('../pg/reconcile.sql', import.meta.url), 'utf8'));
  assert.equal(rows.length, manifest.tables.length);
  assert.deepEqual(compareReconciliation(manifest, rows), {equal: true, differences: []});
  const projects = manifest.tables.find(table => table.table_name === 'projects');
  assert.equal(BigInt(projects.money_sums.budget_yen) > 9007199254740993n, true);
  assert.equal(manifest.tables.some(table => Object.keys(table.money_sums).length > 1), true);
});

test('FR-CORE-DATA-043 分割後も大きな合計と負額・NULL・小数文字・バイナリ・R2の原本を正確に戻す', async t => {
  const source = await exportFixture(t), target = await exportFixture(t, {empty: true});
  const data = Buffer.from('架空の原本'.repeat(20000)), hash = sha256(data);
  const artifactKey = `private/workbench/sha256/${hash.slice(0, 2)}/${hash}`;
  const artifacts = memoryBucket(), output = memoryBucket(), bucket = memoryBucket();
  await artifacts.put(artifactKey, data);
  await source.client.query('INSERT INTO sales_source_files (id, original_base64, amount_yen, precise, bytes) VALUES ($1,$2,$3,$4,$5)',
    [7, `@r2:v1:${artifactKey}:${hash}:${data.length}`, '9007199254740991', '1.234567890123456789', Buffer.from([0, 255])]);
  await source.client.query('INSERT INTO sales_source_files (id, amount_yen) VALUES (8,9007199254740991),(9,-7),(10,NULL)');
  await source.client.query('INSERT INTO z_children (parent_id, amount_yen) VALUES (7, -10)');
  const result = await exportPgDatabase({db: source.db, bucket, artifacts, pageRows: 1, partBytes: 1});
  const table = result.manifest.tables[0];
  assert.equal(table.parts.length, 4);
  assert.deepEqual(table.money_sums, {amount_yen: '18014398509481975'});
  assert.equal(result.manifest.blobs.length, 1);
  const restored = await restorePgDatabase({db: target.db, bucket, manifestKey: result.manifestKey, schemaSql: exportSchema, artifacts: output});
  assert.deepEqual(compareReconciliation(result.manifest, restored), {equal: true, differences: []});
  assert.deepEqual((await source.client.query('SELECT * FROM sales_source_files ORDER BY id')).rows,
    (await target.client.query('SELECT * FROM sales_source_files ORDER BY id')).rows);
  assert.deepEqual(output.objects.get(artifactKey), data);
  assert.equal((await target.db.get('INSERT INTO sales_source_files (amount_yen) VALUES (?) RETURNING id', [12])).id, 11);
  await assert.rejects(target.db.run('UPDATE sales_source_files SET amount_yen=? WHERE id=?', [1, 7]), /immutable/);
  await assert.rejects(target.db.run('INSERT INTO z_children (parent_id) VALUES (?)', [999]), {code: '23503'});
});

test('FR-CORE-DATA-043 破損・欠落・版違いは復旧のDDLごと巻き戻し既存DBは触らない', async t => {
  const source = await exportFixture(t), target = await exportFixture(t, {empty: true}), bucket = memoryBucket();
  await source.db.run('INSERT INTO sales_source_files (amount_yen) VALUES (?)', [17]);
  const result = await exportPgDatabase({db: source.db, bucket});
  const restore = () => restorePgDatabase({db: target.db, bucket, manifestKey: result.manifestKey, schemaSql: exportSchema});
  const manifestBytes = bucket.objects.get(result.manifestKey);
  const part = result.manifest.tables[0].parts[0], original = bucket.objects.get(part.key);
  bucket.objects.set(part.key, Buffer.from('corrupt'));
  await assert.rejects(restore(), causeIs('part_checksum'));
  assert.equal((await target.client.query('SELECT count(*)::text AS n FROM pg_tables WHERE schemaname=current_schema()')).rows[0].n, '0');
  bucket.objects.delete(part.key);
  await assert.rejects(restore(), causeIs('part_missing_or_large'));
  bucket.objects.set(part.key, original);
  const wrong = JSON.parse(manifestBytes);
  wrong.schema.ddl_sha256 = 'another-version';
  bucket.objects.set(result.manifestKey, Buffer.from(JSON.stringify(wrong)));
  await assert.rejects(restore(), causeIs('schema_mismatch'));
  bucket.objects.set(result.manifestKey, manifestBytes);
  await restore();
  await assert.rejects(restore(), causeIs('target_not_empty'));
  assert.equal((await target.db.get('SELECT amount_yen FROM sales_source_files')).amount_yen, 17);
});

test('FR-CORE-DATA-043 書き出し途中のR2失敗ではmanifestを残さずトランザクションを閉じる', async t => {
  const source = await exportFixture(t);
  const bucket = memoryBucket(async () => { throw new Error('fictional-private-row'); });
  await assert.rejects(exportPgDatabase({db: source.db, bucket}), /fictional-private-row/);
  assert.deepEqual([...bucket.objects.keys()], []);
  await source.db.run('INSERT INTO sales_source_files (amount_yen) VALUES (?)', [19]);
  assert.equal((await source.db.get('SELECT amount_yen FROM sales_source_files')).amount_yen, 19);
  const missing = memoryBucket();
  const hash = 'a'.repeat(64);
  await source.db.run('INSERT INTO sales_source_files (original_base64) VALUES (?)', [`@r2:v1:private/workbench/sha256/aa/${hash}:${hash}:1`]);
  await assert.rejects(exportPgDatabase({db: source.db, bucket: missing, artifacts: memoryBucket()}), causeIs('artifact_missing'));
  assert.equal([...missing.objects.keys()].some(key => key.endsWith('manifest.json')), false);
});

test('FR-CORE-DATA-043 ログに出す原因の種類は許可リストの語・SQLSTATE・unexpected だけ', () => {
  // exportError は固定の語で呼び、その語はすべて許可リストにある（使わない語も残さない）
  const dir = new URL('../src/data-platform/', import.meta.url);
  const files = [...readdirSync(dir).filter(name => name.endsWith('.mjs')).map(name => new URL(name, dir)),
    new URL('../../../scripts/ops/pg-restore.mjs', import.meta.url), new URL('../../../scripts/ops/pg-reconcile.mjs', import.meta.url)];
  const used = new Set();
  for (const file of files) {
    for (const [, arg] of readFileSync(file, 'utf8').matchAll(/exportError\(([^)]*)\)/g)) {
      if (arg === 'code') continue; // 定義
      assert.match(arg, /^'[a-z_]+'$/, `${file.pathname} の exportError は固定の語で呼ぶ`);
      used.add(arg.slice(1, -1));
    }
  }
  assert.deepEqual([...used].filter(code => !EXPORT_ERROR_CODES.includes(code)).sort(), []);
  assert.deepEqual(EXPORT_ERROR_CODES.filter(code => !used.has(code)), []);
  const withCode = (code, message = 'fictional-private-value') => Object.assign(new Error(message), {code});
  assert.equal(failureCause(exportError('part_checksum')), 'part_checksum');
  assert.equal(failureCause(exportError('fictional_unlisted')), 'unexpected');
  assert.equal(failureCause(withCode('part_checksum')), 'unexpected');
  for (const code of ['57014', '22P02', '28P01', '08006']) assert.equal(failureCause(withCode(code)), code);
  for (const code of ['abcde', '5701', '570144', 'ECONNRESET', 57014, undefined]) assert.equal(failureCause(withCode(code)), 'unexpected');
  for (const value of [null, undefined, 'fictional-private-value', 42]) assert.equal(failureCause(value), 'unexpected');
});

test('FR-CORE-DATA-043 定時実行は接続失敗の中身をログにも例外にも出さず閉じる', async () => {
  let closed = 0;
  const log = [], times = [1000, 1250];
  class Client {
    async connect() { throw new Error('fictional-private-connection-and-row'); }
    async end() { closed += 1; }
  }
  await assert.rejects(runScheduledPgExport({DATABASE_ENGINE: 'postgres', PG_EXPORTS: {}, HYPERDRIVE: {connectionString: 'fictional'}},
    {loadClient: async () => Client, report: entry => log.push(entry), clock: () => times.shift()}), error => {
    assert.equal(error.message, 'pg_daily_export_failed');
    return true;
  });
  assert.deepEqual(log, [{event: 'pg_daily_export_failed', cause: 'unexpected', elapsed_ms: 250, tables: 0, rows: 0}]);
  assert.equal(closed, 1);
  // 束ねの欠けは固定の語で出し、接続しない
  const missing = [];
  await assert.rejects(runScheduledPgExport({DATABASE_ENGINE: 'postgres', PG_EXPORTS: {}},
    {loadClient: () => assert.fail('接続してはいけない'), report: entry => missing.push(entry), clock: () => 5}), {message: 'pg_daily_export_failed'});
  assert.deepEqual(missing, [{event: 'pg_daily_export_failed', cause: 'binding_missing', elapsed_ms: 0, tables: 0, rows: 0}]);
  // 閉じるのに失敗したときも、種類だけを出す
  const closing = [];
  class BrokenEnd {
    async connect() { throw Object.assign(new Error('fictional-private-connection'), {code: '08006'}); }
    async end() { throw new Error('fictional-private-close'); }
  }
  await assert.rejects(runScheduledPgExport({DATABASE_ENGINE: 'postgres', PG_EXPORTS: {}, HYPERDRIVE: {connectionString: 'fictional'}},
    {loadClient: async () => BrokenEnd, report: entry => closing.push(entry), clock: () => 7}), {message: 'pg_daily_export_close_failed'});
  assert.deepEqual(closing, [
    {event: 'pg_daily_export_failed', cause: '08006', elapsed_ms: 0, tables: 0, rows: 0},
    {event: 'pg_daily_export_close_failed', cause: 'unexpected', elapsed_ms: 0},
  ]);
  const worker = readFileSync(new URL('../src/cloud-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /async scheduled\([^)]*\)\s*\{\s*await runScheduledPgExport\(env, \{loadClient: loadPgClient\}\)/);
});

test('FR-CORE-DATA-043 定時実行の失敗のログは原因の種類と進み具合だけで、エラーの文と行の値を出さない', async t => {
  const source = await exportFixture(t);
  await source.db.run('INSERT INTO sales_source_files (amount_yen, original_base64) VALUES (?, ?), (?, ?), (?, ?)',
    [11, 'fictional-private-cell', 22, 'fictional-private-cell', 33, 'fictional-private-cell']);
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(['error', line]));
  t.mock.method(console, 'log', line => lines.push(['log', line]));
  const env = bucket => ({DATABASE_ENGINE: 'postgres', PG_EXPORTS: bucket, HYPERDRIVE: {connectionString: 'fictional'}});
  const borrow = (query = (...args) => source.client.query(...args)) => async () => class {
    async connect() { /* 架空DBの接続を借りる */ }
    query(...args) { return query(...args); }
    async end() { /* 借りた接続は試験が閉じる */ }
  };
  const failure = async (bucket, loadClient) => {
    lines.length = 0;
    await assert.rejects(runScheduledPgExport(env(bucket), {loadClient}), {message: 'pg_daily_export_failed'});
    assert.equal(lines.length, 1);
    assert.equal(lines[0][0], 'error');
    assert.doesNotMatch(lines[0][1], /fictional-private|12345678912345|PG export|canceling/);
    const entry = JSON.parse(lines[0][1]);
    assert.equal(Number.isSafeInteger(entry.elapsed_ms) && entry.elapsed_ms >= 0, true);
    delete entry.elapsed_ms;
    return entry;
  };
  // R2 の失敗（message に架空の値）。1表目を書き終え、2表目の保存で落ちる
  const r2 = memoryBucket(async key => { if (key.includes('/tables/z_children/')) throw new Error('fictional-private-row 12345678912345'); });
  assert.deepEqual(await failure(r2, borrow()), {event: 'pg_daily_export_failed', cause: 'unexpected', tables: 1, rows: 3});
  // DB の失敗は SQLSTATE だけ（statement_timeout を模す）
  const timeout = borrow(async (sql, ...args) => {
    if (typeof sql === 'string' && sql.startsWith('FETCH')) throw Object.assign(new Error('canceling statement: fictional-private-row'), {code: '57014'});
    return source.client.query(sql, ...args);
  });
  assert.deepEqual(await failure(memoryBucket(), timeout), {event: 'pg_daily_export_failed', cause: '57014', tables: 0, rows: 0});
  // 書き出しの固定の語はそのまま。途中の表で読み終えた行も数える
  const hash = 'b'.repeat(64);
  await source.db.run('INSERT INTO sales_source_files (original_base64) VALUES (?)', [`@r2:v1:private/workbench/sha256/bb/${hash}:${hash}:1`]);
  assert.deepEqual(await failure(memoryBucket(), borrow()), {event: 'pg_daily_export_failed', cause: 'artifact_missing', tables: 0, rows: 3});
});

test('FR-CORE-DATA-043 定時実行のPG経路は読取専用で束ねて取り、manifestを最後に置いて成功の1行を出し接続を閉じる', async t => {
  const source = await exportFixture(t), statements = [], bucket = memoryBucket(), lines = [];
  await source.db.run('INSERT INTO sales_source_files (amount_yen, original_base64) VALUES (?, ?), (?, ?)', [5, 'fictional-private-cell', 6, null]);
  t.mock.method(console, 'error', line => lines.push(['error', line]));
  t.mock.method(console, 'log', line => lines.push(['log', line]));
  let closed = 0;
  class Client {
    async connect() { /* 架空DBの接続を借りる */ }
    async query(...args) { statements.push(typeof args[0] === 'string' ? args[0] : args[0].text); return source.client.query(...args); }
    async end() { closed += 1; }
  }
  const result = await runScheduledPgExport({DATABASE_ENGINE: 'postgres', PG_EXPORTS: bucket, HYPERDRIVE: {connectionString: 'fictional'}},
    {loadClient: async () => Client});
  assert.equal(result.skipped, false);
  assert.equal(closed, 1);
  assert.equal([...bucket.objects.keys()].at(-1), result.manifestKey);
  assert.match(result.manifestKey, /^pg-daily\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]+\/manifest\.json$/);
  assert.equal(statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(statements.includes("SET LOCAL statement_timeout = '50s'"), true);
  assert.equal(statements.includes(`FETCH FORWARD ${EXPORT_BATCH_ROWS} FROM on_export_cursor`), true);
  assert.deepEqual(statements.filter(sql => sql.startsWith('FETCH')).filter(sql => sql !== `FETCH FORWARD ${EXPORT_BATCH_ROWS} FROM on_export_cursor`), []);
  assert.equal(statements.at(-1), 'COMMIT');
  // 成功の1行は固定の名前・世代のキー・表と行の数・所要時間だけ
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'log');
  assert.doesNotMatch(lines[0][1], /fictional-private/);
  const entry = JSON.parse(lines[0][1]);
  assert.equal(Number.isSafeInteger(entry.elapsed_ms) && entry.elapsed_ms >= 0, true);
  delete entry.elapsed_ms;
  assert.deepEqual(entry, {event: 'pg_daily_export_succeeded', manifest_key: result.manifestKey, tables: 2, rows: 2});
});

test('FR-CORE-DATA-043 別接続の書き込みが途中で確定しても全表とmanifestは開始時の一時点になる', async t => {
  const source = await exportFixture(t);
  const pool = source.pool();
  if (!pool) { t.skip('PGliteは接続が1本なので同時書き込みの合否はCIの本物のPostgreSQLで確かめる'); return; }
  await source.db.run('INSERT INTO sales_source_files (id, amount_yen) VALUES (?, ?)', [1, 100]);
  await source.db.run('INSERT INTO sales_source_files (id, amount_yen) VALUES (?, ?)', [2, 200]);
  // 小さい行の上限（16 KiB）を超え、ctid で取り直す行
  await source.db.run('INSERT INTO sales_source_files (id, amount_yen, original_base64) VALUES (?, ?, ?)', [3, 300, 'x'.repeat(20000)]);
  await source.db.run('INSERT INTO z_children (parent_id, amount_yen) VALUES (?, ?)', [1, 25]);
  let writes = 0;
  const bucket = memoryBucket(async key => {
    if (key.includes('/tables/sales_source_files/') && writes === 0) {
      await pool.query('INSERT INTO sales_source_files (amount_yen) VALUES (400)');
      await pool.query('INSERT INTO z_children (parent_id, amount_yen) VALUES (1, 50)');
      // 取り直す前の大きい行を別の接続で消しても、書き出しは開始時の版を ctid で読む
      await pool.query('DELETE FROM sales_source_files WHERE id = 3');
      writes += 1;
    }
  });
  const {manifest} = await exportPgDatabase({db: source.db, bucket, pageRows: EXPORT_BATCH_ROWS, partBytes: 1});
  assert.equal(writes, 1);
  assert.deepEqual(manifest.tables.map(t => [t.row_count, t.money_sums.amount_yen]), [['3', '600'], ['1', '25']]);
  const exported = manifest.tables[0].parts.flatMap(part => bucket.objects.get(part.key).toString().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  assert.deepEqual(exported.map(row => [row.id, row.original_base64?.length ?? null]), [['1', null], ['2', null], ['3', 20000]]);
  assert.equal((await source.db.get('SELECT count(*) AS n FROM sales_source_files')).n, 3);
  assert.equal((await source.db.get('SELECT count(*) AS n FROM z_children')).n, 2);
});

test('FR-CORE-DATA-043 D1と束ねの無いenvの定時実行は接続も書き出しもしない', async () => {
  for (const env of [{}, {DATABASE_ENGINE: 'd1', PG_EXPORTS: {}}, {DATABASE_ENGINE: 'postgres'}]) {
    assert.deepEqual(await runScheduledPgExport(env, {loadClient: () => assert.fail('接続してはいけない')}), {skipped: true});
  }
});

// 架空の cursor。FETCH は束ごとに rows から pageRows 行を返し、ctid の取り直しは refetch が答える。
// accept の保存を待つあいだに次の取得（FETCH・取り直し）が来たら落とす。
function stubCursor(rows, refetch = () => ({rows: []})) {
  const events = [], queue = [...rows];
  let saving = false;
  const client = {async query(sql, params) {
    assert.equal(saving, false, '渡した行の保存を待ってから次を取得する');
    if (sql.startsWith('DECLARE')) { events.push(['declare', sql]); return {rows: []}; }
    const fetch = sql.match(/^FETCH FORWARD (\d+) FROM on_export_cursor$/);
    if (fetch) { events.push(['fetch', Number(fetch[1])]); return {rows: queue.splice(0, Number(fetch[1]))}; }
    if (sql === 'CLOSE on_export_cursor') { events.push(['close']); return {rows: []}; }
    events.push(['refetch', params, sql]);
    return refetch(params);
  }};
  const accept = async row => {
    saving = true;
    await new Promise(resolve => setImmediate(resolve));
    events.push(['accept', row.value]);
    saving = false;
  };
  return {client, accept, events};
}
const small = value => ({on_export_row: JSON.stringify({value}), on_export_oid: null, on_export_tid: null});
const large = tid => ({on_export_row: null, on_export_oid: '16384', on_export_tid: tid});
const tooLarge = () => ({on_export_row: null, on_export_oid: null, on_export_tid: null});
const fictionalTable = {table_name: 'fictional', columns: [{name: 'value'}]};

test('FR-CORE-DATA-043 束は行数×小さい行の上限が1MiB以下で、64行を超える束は断る', async () => {
  assert.equal(SMALL_EXPORT_ROW_BYTES, 16 * 1024);
  assert.equal(MAX_EXPORT_ROW_BYTES, MiB);
  assert.equal(EXPORT_BATCH_ROWS * SMALL_EXPORT_ROW_BYTES <= MiB, true);
  for (const pageRows of [1, 16, EXPORT_BATCH_ROWS]) {
    const values = Array.from({length: 130}, (_, i) => `fictional-${i}`);
    const {client, accept, events} = stubCursor(values.map(small));
    await scanExportTable(client, fictionalTable, pageRows, accept);
    const declare = events.find(e => e[0] === 'declare')[1];
    assert.match(declare, new RegExp(`on_export_bytes <= ${SMALL_EXPORT_ROW_BYTES} THEN on_export_json`));
    assert.match(declare, new RegExp(`on_export_bytes > ${SMALL_EXPORT_ROW_BYTES} AND on_export_bytes <= ${MiB} THEN on_export_tid`));
    const fetches = events.filter(e => e[0] === 'fetch').map(e => e[1]);
    // 束の行数×小さい行の上限（DB が本文を返す最大）が 1 MiB を超えない
    for (const fetched of fetches) assert.equal(fetched * SMALL_EXPORT_ROW_BYTES <= MiB, true);
    assert.deepEqual(fetches, Array(Math.floor(130 / pageRows) + 1).fill(pageRows));
    assert.deepEqual(events.filter(e => e[0] === 'accept').map(e => e[1]), values);
    assert.deepEqual(events.at(-1), ['close']);
  }
  const {client} = stubCursor([]);
  for (const pageRows of [0, EXPORT_BATCH_ROWS + 1, 1.5]) {
    await assert.rejects(scanExportTable(client, fictionalTable, pageRows, () => {}), causeIs('invalid_export_options'));
    await assert.rejects(exportPgDatabase({db: {}, bucket: memoryBucket(), pageRows}), causeIs('invalid_export_options'));
  }
  await assert.rejects(scanExportTable(client, fictionalTable, 1, () => {}, {smallRowBytes: SMALL_EXPORT_ROW_BYTES + 1}), causeIs('invalid_export_options'));
  await assert.rejects(scanExportTable(client, fictionalTable, 1, () => {}, {maxRowBytes: MiB + 1}), causeIs('invalid_export_options'));
});

test('FR-CORE-DATA-043 小さい行の上限を超える行は束から外して単独で取り直し、元の順のまま渡す', async () => {
  const bodies = {'(0,2)': 'fictional-large-b', '(0,4)': 'fictional-large-d'};
  const {client, accept, events} = stubCursor([small('a'), large('(0,2)'), small('c'), large('(0,4)'), small('e')],
    ([, tid]) => ({rows: [{on_export_row: JSON.stringify({value: bodies[tid]})}]}));
  await scanExportTable(client, fictionalTable, EXPORT_BATCH_ROWS, accept);
  assert.deepEqual(events.filter(e => e[0] !== 'declare').map(e => e[0] === 'refetch' ? ['refetch', e[1]] : e), [
    ['fetch', EXPORT_BATCH_ROWS],
    ['accept', 'a'],
    ['refetch', ['16384', '(0,2)']], ['accept', 'fictional-large-b'],
    ['accept', 'c'],
    ['refetch', ['16384', '(0,4)']], ['accept', 'fictional-large-d'],
    ['accept', 'e'],
    ['close'],
  ]);
  // 取り直しは同じ表の1行を tableoid と ctid で指し、DB の側で 1 MiB を超えた本文を返さない
  const refetchSql = events.find(e => e[0] === 'refetch')[2];
  assert.match(refetchSql, /on_export_source\.tableoid = \$1::oid AND on_export_source\.ctid = \$2::tid/);
  assert.match(refetchSql, new RegExp(`octet_length\\(on_export_json\\) \\+ 1 <= ${MiB} THEN on_export_json`));
});

test('FR-CORE-DATA-043 1MiBを超える行は本文を受け取らずに断り、その後の行を渡さない', async () => {
  const run = async (rows, refetch) => {
    const stub = stubCursor(rows, refetch);
    const error = await scanExportTable(stub.client, fictionalTable, EXPORT_BATCH_ROWS, stub.accept).then(() => null, e => e);
    return {error, accepted: stub.events.filter(e => e[0] === 'accept').map(e => e[1]), refetches: stub.events.filter(e => e[0] === 'refetch').length};
  };
  // DB が本文も ctid も返さない行（1 MiB 超）
  const over = await run([small('a'), tooLarge(), small('c')], () => assert.fail('1 MiB を超える行は取り直さない'));
  assert.equal(causeIs('row_too_large')(over.error), true);
  assert.deepEqual([over.accepted, over.refetches], [['a'], 0]);
  // 取り直しで DB が上限を超えたと答えたとき
  const grown = await run([small('a'), large('(0,2)'), small('c')], () => ({rows: [{on_export_row: null}]}));
  assert.equal(causeIs('row_too_large')(grown.error), true);
  assert.deepEqual([grown.accepted, grown.refetches], [['a'], 1]);
  // 取り直しで行が見つからないとき
  const gone = await run([large('(0,1)'), small('b')], () => ({rows: []}));
  assert.equal(causeIs('row_refetch_missing')(gone.error), true);
  assert.deepEqual([gone.accepted, gone.refetches], [[], 1]);
});

test('FR-CORE-DATA-043 JSON化後のUTF8で小さい行の上限ちょうどは束で、1バイト超過は取り直しで、最大ちょうどまで取り超過はDBから値を送らない', async t => {
  const source = await exportFixture(t), table = {table_name: 'bounded_rows', columns: [{name: 'value'}]};
  await source.client.query('CREATE TABLE bounded_rows(value text)');
  const value = '架空\\"\n';
  const smallLimit = Buffer.byteLength(JSON.stringify({value}) + '\n');
  const options = {smallRowBytes: smallLimit, maxRowBytes: smallLimit + 1};
  const query = source.client.query.bind(source.client), payloads = [], refetched = [];
  const client = {async query(sql, params) {
    const result = await query(sql, params);
    if (sql.startsWith('FETCH')) payloads.push(...result.rows);
    else if (sql.startsWith('SELECT')) refetched.push(...result.rows);
    return result;
  }};
  // 小さい行の上限ちょうど（束の本文）・1バイト超過（最大ちょうど。取り直し）を交互に入れる
  const values = [value, value + 'x', value, value + 'x'];
  for (const v of values) await query('INSERT INTO bounded_rows VALUES ($1)', [v]);
  await query('BEGIN');
  const rows = [];
  await scanExportTable(client, table, EXPORT_BATCH_ROWS, row => rows.push(row), options);
  assert.deepEqual(rows.map(row => row.value), values);
  assert.deepEqual(rows.map(row => row.value), (await query('SELECT value FROM bounded_rows ORDER BY ctid')).rows.map(row => row.value));
  assert.deepEqual(payloads.map(p => [p.on_export_row !== null, p.on_export_oid !== null, p.on_export_tid !== null]),
    [[true, false, false], [false, true, true], [true, false, false], [false, true, true]]);
  assert.equal(refetched.length, 2);
  await query('COMMIT');
  // 最大を1バイト超えた行は、DB が本文も ctid も返さず、取り直さない
  await query('INSERT INTO bounded_rows VALUES ($1)', [value + 'xx']);
  await query('BEGIN');
  payloads.length = 0; refetched.length = 0;
  await assert.rejects(scanExportTable(client, table, EXPORT_BATCH_ROWS, () => {}, options), causeIs('row_too_large'));
  assert.deepEqual(payloads.at(-1), {on_export_row: null, on_export_oid: null, on_export_tid: null});
  assert.equal(refetched.length, 2);
  await query('ROLLBACK');
});

test('FR-CORE-DATA-043 大きなpart指定でも1MiB以下で保存し超過行ではmanifestを公開しない', async t => {
  const source = await exportFixture(t), bucket = memoryBucket();
  // 各256KiBの5行だけで、旧20MiBの値を確保せずバッファ上限を横切る（小さい行の上限を超えるので1行ずつ取り直す）。
  await source.client.query("INSERT INTO sales_source_files (original_base64) SELECT repeat('x', 262144) FROM generate_series(1, 5)");
  const {manifest, manifestKey} = await exportPgDatabase({db: source.db, bucket, pageRows: 64, partBytes: 20 * 1024 * 1024});
  const table = manifest.tables.find(table => table.table_name === 'sales_source_files');
  assert.equal(table.row_count, '5');
  assert.equal(table.parts.length, 2);
  for (const part of table.parts) {
    assert.equal(part.bytes <= MiB, true);
    assert.equal(bucket.objects.get(part.key).length, part.bytes);
  }
  // 戻した先の読み直し（同じトランザクションで入れた大きい行も ctid で取り直す）でも件数と値がそろう
  const target = await exportFixture(t, {empty: true});
  const restored = await restorePgDatabase({db: target.db, bucket, manifestKey, schemaSql: exportSchema});
  assert.deepEqual(compareReconciliation(manifest, restored), {equal: true, differences: []});
  assert.deepEqual((await target.client.query('SELECT id, length(original_base64) AS n FROM sales_source_files ORDER BY id')).rows.map(row => [String(row.id), row.n]),
    (await source.client.query('SELECT id, length(original_base64) AS n FROM sales_source_files ORDER BY id')).rows.map(row => [String(row.id), row.n]));

  // 既にある行を「上限超過」とするDB側の境界だけ下げ、失敗時の後始末も実DBで確かめる。
  const query = source.client.query.bind(source.client), statements = [];
  t.mock.method(source.client, 'query', async (sql, ...args) => {
    statements.push(typeof sql === 'string' ? sql : sql.text);
    if (typeof sql === 'string' && sql.startsWith('DECLARE')) sql = sql.replaceAll(`<= ${MiB}`, '<= 64');
    return query(sql, ...args);
  });
  const failedBucket = memoryBucket();
  await assert.rejects(exportPgDatabase({db: source.db, bucket: failedBucket}), causeIs('row_too_large'));
  assert.equal([...failedBucket.objects.keys()].some(key => key.endsWith('/manifest.json')), false);
  assert.equal(statements.at(-1), 'ROLLBACK');
});
