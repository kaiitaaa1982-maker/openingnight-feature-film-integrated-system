// 架空データの記録（seed-all-demo.mjs --record）を、本番で1回に当てられる SQL ファイルに変える道具（scripts/seed-record-to-sql.mjs）の試験。
// 本番に見立てた写し（移行を当てた DB に試作用の行と今までの seed の売上（旧区分）を入れたもの）で記録 → SQL に変換 →
// 別の同じ写しに SQL ファイル全体を1つのトランザクションで当てる（BEGIN … COMMIT。失敗したら ROLLBACK）→
// replaySeedRecord（D1 と同じ型で binding する見立ての D1 を本番の部品で包んだもの）で再生したものと、全表の行数・中身が同じになるか。
// 壊れたら: 値の書き方が binding と違う（' 改行 NUL 絵文字 サロゲートペア・整数と実数・バイナリ）、指紋が違う本番に一部だけ当たる、
//           記録どおりの件数にならなくても当たったままになる、1文が D1 の上限（100KB）を超える、R2 に置く値を D1 に直接書く、
//           コメントで始まる定義の文・ログインの書き込みが SQL に入る、SQLite が読むと桁のずれる大きさの実数を書く、
//           本番の書き出しから作った写しで記録した SQL が、行の削除の穴のある本番の先頭の確かめで必ず落ちる（隠れ rowid を比べる）。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {R2BackedD1Database} from '../src/cloud-r2-db.mjs';
import {LocalDatabase} from '../src/db.mjs';
import {seedAllDemo, recordingDatabase, businessBatches, recordLines, openRecordingCopy, databaseFingerprint, replaySeedRecord, copyReadiness,
  isSessionWrite, d1LimitViolations, sqlWithoutComments, rowidAliasTables, fingerprintDifferences, FINGERPRINT_ROWID_SCOPE} from '../scripts/seed-all-demo.mjs';
import {seedSalesDemo} from '../scripts/seed-sales-demo.mjs';
import {sqlValue, sqlString, bindValues, recordToSql, applySqlText, locateFailure, compareDatabases, rawTableCounts, prepareCopy, STATEMENT_LIMIT_BYTES} from '../scripts/seed-record-to-sql.mjs';
import {splitSqlStatements} from '../../../scripts/ops/d1-reconcile.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrations = readdirSync(join(app, 'migrations')).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'on-seed-sql-')); });
after(() => { if (dir) rmSync(dir, {recursive: true, force: true}); });

// 移行を番号順に当て（wrangler と同じく d1_migrations に名前を残す）、試作用の行（いまの本番の形）を入れた DB
function productionLike(name, {upTo = migrations.length, extra = ''} = {}) {
  const path = join(dir, name);
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  for (const file of migrations.slice(0, upTo)) {
    raw.exec(readFileSync(join(app, 'migrations', file), 'utf8'));
    raw.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(file);
  }
  const sql = readFileSync(join(app, 'src', 'schema.sql'), 'utf8');
  const start = sql.indexOf('INSERT OR IGNORE INTO organizations');
  raw.exec(sql.slice(start, sql.indexOf('\nCREATE ', start)));
  raw.prepare("UPDATE users SET email='owner@example.test' WHERE id=1").run();
  if (extra) raw.exec(extra);
  raw.close();
  return path;
}
const copy = (from, name) => { const path = join(dir, name); copyFileSync(from, path); return path; };

// 本番の D1 binding の見立て。D1 は値を JSON で送るので、整数の number は INTEGER、ほかの number は REAL、真偽は 1/0 になる
const d1Param = (value) => (typeof value === 'boolean' ? (value ? 1n : 0n) : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value);
function fakeD1(raw) {
  const run = (sql, params) => {
    if (params.length > 100) throw new Error(`D1: too many SQL variables (${params.length})`);
    const out = raw.prepare(sql).run(...params.map(d1Param));
    return {success: true, meta: {changes: Number(out.changes), last_row_id: Number(out.lastInsertRowid)}};
  };
  const statement = (sql, params = []) => ({sql, params, bind: (...next) => statement(sql, next),
    all: async () => ({results: raw.prepare(sql).all(...params.map(d1Param)), success: true}), first: async () => raw.prepare(sql).get(...params.map(d1Param)) ?? null, run: async () => run(sql, params)});
  return {prepare: (sql) => statement(sql), batch: async (list) => {
    raw.exec('BEGIN');
    try { const out = list.map((s) => run(s.sql, s.params)); raw.exec('COMMIT'); return out; } catch (error) { raw.exec('ROLLBACK'); throw error; }
  }};
}
function fakeR2() {
  const values = new Map();
  return {values, head: async (key) => (values.has(key) ? {size: values.get(key).byteLength, customMetadata: {}} : null), put: async (key, value) => { values.set(key, new Uint8Array(value)); return {key}; },
    get: async (key) => (values.has(key) ? {body: true, arrayBuffer: async () => values.get(key).slice().buffer} : null)};
}
async function replayInto(path, text) {
  const raw = new DatabaseSync(path);
  try { return await replaySeedRecord(text, new R2BackedD1Database(fakeD1(raw), fakeR2())); } finally { raw.close(); }
}
function applyFile(path, sqlText) {
  const raw = new DatabaseSync(path);
  try {
    const before = rawTableCounts(raw);
    const result = applySqlText(raw, sqlText);
    return {...result, before, after: rawTableCounts(raw), failed: result.ok ? null : locateFailure(raw, sqlText), foreignKeys: raw.prepare('PRAGMA foreign_key_check').all().length};
  } finally { raw.close(); }
}
function compare(leftPath, rightPath) {
  const left = new DatabaseSync(leftPath, {readOnly: true}), right = new DatabaseSync(rightPath, {readOnly: true});
  try { return compareDatabases(left, right); } finally { left.close(); right.close(); }
}
const onlyTimeColumns = (diff) => Object.values(diff.skipped).flat().every((column) => /(_at|^at)$/.test(column));

// 特殊な値。binding と SQL の文字で同じ型・同じ中身になること。実数は SQL にできる大きさ（|値| が 1e15 以下で、0 か 1e-6 以上）の端と中
const SPECIAL = [
  "it's '' quoted", 'a\nb', 'a\r\nb\rc', 'tab\there', 'nul\u0000inside\u0000', '絵文字😀と𠮷（サロゲートペア）', '私用の文字と\n改行',
  "'); DROP TABLE t; --", '? と ?1 と :name（文字の中）', 'バックスラッシュ\\と\\n（文字の2字）', '', ' 前後の空白 ', 'x'.repeat(20_000) + '\n'.repeat(3_000) + '終わり',
  String.fromCharCode(...Array.from({length: 32}, (_, i) => i), 127) + '全部の制御文字', 'ひとりのサロゲート\uD800の後', '-- と /* は文字の中',
  0, -0, 1, -1, 2 ** 53 - 1, -(2 ** 53 - 1), 0.1, 0.1 + 0.2, 1 / 3, 2 / 3, 0.08, 1.1, 123456.789, 1234567.891, 1e-6, -1e-6, 1.0000000000000002e-6,
  999999999999999.9, -999999999999999.9, 1e15 - 0.125, 0.000123456789012345,
  2n ** 62n, -(2n ** 63n), 2n ** 63n - 1n, true, false, null, new Uint8Array([0, 1, 2, 255, 39, 10]), new Uint8Array([]),
];
const SPECIAL_RECORDED = SPECIAL.filter((value) => typeof value !== 'boolean');
// SQL にできない大きさの実数（指数つきの文字になり、SQLite が読むと最下位の桁がずれることがある）
const OUT_OF_RANGE_REALS = [2 ** 53, -(2 ** 53) - 2, 1e15 + 0.5, 1e21, 1.7976931348623157e308, -2.5e-8, -1e-7, 9.99999999999999e-7, 5e-324, 1.8692744550850122e+232];

test('値の書き方: 特殊な文字（\' 改行 CR タブ NUL 絵文字 サロゲートペア 私用領域）・整数と普通の大きさの実数・bigint・真偽・NULL・バイナリは、D1 と同じ binding で入れたものと型・中身まで同じ', () => {
  const make = () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a, b TEXT, c INTEGER, d REAL, e NUMERIC, f BLOB)');
    return raw;
  };
  const bound = make(), literal = make();
  const insert = bound.prepare('INSERT INTO t(id,a,b,c,d,e,f) VALUES(?,?,?,?,?,?,?)');
  SPECIAL.forEach((value, index) => {
    insert.run(BigInt(index + 1), ...Array(6).fill(d1Param(value)));
    const sql = bindValues('INSERT INTO t(id,a,b,c,d,e,f) VALUES(?,?,?,?,?,?,?)', [index + 1, ...Array(6).fill(value)]);
    assert.doesNotMatch(sql, /[\u0000-\u001f\u007f]/, `値 ${index + 1} の文に制御文字が残らない（1行に収まる）`);
    assert.ok(sql.endsWith(');'), sql.slice(-20));
    literal.exec(sql);
  });
  const dump = (raw) => raw.prepare(`SELECT id, ${['a', 'b', 'c', 'd', 'e', 'f'].map((c) => `typeof(${c})||':'||CASE typeof(${c}) WHEN 'real' THEN quote(${c}) ELSE hex(${c}) END AS ${c}`).join(',')} FROM t ORDER BY id`).all();
  const a = dump(bound), b = dump(literal);
  assert.equal(b.length, SPECIAL.length);
  for (let i = 0; i < a.length; i += 1) assert.deepEqual(b[i], a[i], `値 ${i + 1}（${String(SPECIAL[i]).slice(0, 20)}）`);
  // 型の見本: 整数の number は INTEGER、実数は REAL（範囲の中は指数を使わない）、真偽は 1/0
  assert.equal(sqlValue(5), '5');
  assert.equal(sqlValue(-0), '0');
  assert.equal(sqlValue(2 ** 53 - 1), '9007199254740991');
  assert.equal(sqlValue(0.1), '0.1');
  assert.equal(sqlValue(1e-6), '0.000001');
  assert.equal(sqlValue(999999999999999.9), '999999999999999.9');
  assert.equal(sqlValue(true), '1');
  // 範囲の外の実数（2^53 のような安全でない整数も REAL になるので同じ）は止める。値そのものは出さない
  for (const value of OUT_OF_RANGE_REALS) {
    assert.throws(() => sqlValue(value), (error) => /最下位の桁がずれうる/.test(error.message) && !error.message.includes(String(value)), String(value));
  }
  assert.throws(() => sqlValue(1e21), /\|値\| が 1e15 を超える実数/);
  assert.throws(() => sqlValue(-2.5e-8), /0 でなく \|値\| が 1e-6 未満の実数/);
  assert.equal(sqlValue(new Uint8Array([0, 255])), "X'00FF'");
  assert.equal(sqlString("it's"), "'it''s'");
  assert.equal(sqlString('a\nb'), "replace('ab',char(57344),char(10))");
  assert.throws(() => sqlValue(2n ** 63n), /64ビット/);
  assert.throws(() => sqlValue(Number.NaN), /有限でない/);
  assert.throws(() => sqlValue({a: 1}), /SQL にできない/);
});

test('文への埋め込み: 文字の中・コメントの中の ? は値にせず、?NNN は SQLite と同じ数え方。改行は1つの空白にし、数の違い・名前つきの値・文の途中の ; は止める', () => {
  assert.equal(bindValues("SELECT '?', ? -- ? のコメント\n , /* ? */ ?", [1, 'x']), "SELECT '?', 1 , 'x';");
  assert.equal(bindValues('SELECT ?2, ?1, ?', ['a', 'b', 'c']), "SELECT 'b', 'a', 'c';");
  assert.equal(bindValues('INSERT INTO "a""b"(x)\n  VALUES(?);', [3]), 'INSERT INTO "a""b"(x) VALUES(3);');
  assert.equal(bindValues("SELECT 'a\nb'"), "SELECT replace('ab',char(57344),char(10));", '文の中の文字の改行も1行にする');
  assert.throws(() => bindValues('SELECT ?, ?', [1]), /値の番号 2 がありません/);
  assert.throws(() => bindValues('SELECT ?', [1, 2]), /値の数が合いません/);
  assert.throws(() => bindValues('SELECT :name', ['x']), /名前つきの値/);
  assert.throws(() => bindValues('SELECT 1; SELECT 2'), /途中に ;/);
  assert.throws(() => bindValues("SELECT 'a"), /引用符が閉じていません/);
});

test('実数の大きさ: |値| が 1e15 以下で 1e-6 以上の実数は、SQL の文字を SQLite が元と同じ倍精度に読む（ビットを乱数で作った数・金額・比率）', (t) => {
  const raw = new DatabaseSync(':memory:');
  let seed = 20260927;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const view = new DataView(new ArrayBuffer(8));
  // 指数が 2^-20〜2^49 の倍精度（仮数のビットは乱数）。範囲の外と整数は引き直す
  const randomReal = () => {
    for (;;) {
      view.setUint32(0, ((1003 + Math.floor(next() * 70)) << 20) | Math.floor(next() * 0x100000));
      view.setUint32(4, Math.floor(next() * 0x100000000));
      const value = view.getFloat64(0) * (next() < 0.5 ? -1 : 1);
      if (!Number.isSafeInteger(value) && Math.abs(value) >= 1e-6 && Math.abs(value) <= 1e15) return value;
    }
  };
  // SQLite が SQL の文字を読んだ数（VALUES の1列）と元の数を比べる → 違った数の個数
  const drift = (values) => {
    let bad = 0;
    for (let start = 0; start < values.length; start += 500) {
      const chunk = values.slice(start, start + 500);
      const rows = raw.prepare(`VALUES ${chunk.map((value) => `(${sqlValue(value)})`).join(',')}`).all();
      rows.forEach((row, index) => { if (!Object.is(row.column1, chunk[index])) bad += 1; });
    }
    return bad;
  };
  const make = (n, fn) => Array.from({length: n}, fn);
  const cases = [['ビットを乱数で作った数', make(60_000, randomReal)], ['金額（小数2桁）', make(20_000, () => Math.round(next() * 1e12) / 100)],
    ['比率', make(20_000, () => Math.max(next(), 1e-6))], ['範囲の端', [1e-6, -1e-6, 1.0000000000000002e-6, 999999999999999.9, 1e15 - 0.125, 0.1 + 0.2]]];
  for (const [name, values] of cases) assert.equal(drift(values), 0, `${name}: SQLite が読んだ数が元と違う`);
  // 参考: 範囲の外は SQLite の読み取りでずれることがある（数は SQLite の版による。ここでは確かめず、出すだけ）
  const outside = make(20_000, () => { view.setUint32(0, ((1100 + Math.floor(next() * 900)) << 20) | Math.floor(next() * 0x100000)); view.setUint32(4, Math.floor(next() * 0x100000000)); return view.getFloat64(0); });
  let outsideBad = 0;
  for (const value of outside) {
    let text = String(value);
    if (!/[.eE]/.test(text)) text += '.0';
    if (!Object.is(raw.prepare(`SELECT ${text} AS a`).get().a, value)) outsideBad += 1;
  }
  t.diagnostic(`範囲の外（2^77〜2^977）の乱数 ${outside.length}個のうち、SQLite が読むとずれた数 ${outsideBad}個（SQLite ${raw.prepare('SELECT sqlite_version() AS v').get().v}）`);
  raw.close();
});

test('文の種類はコメントを外して見る: 先頭・途中にコメントのある定義の文とログインの書き込みも止め、文字の中の -- や /* はコメントにしない', () => {
  const fingerprint = {counts: {users: 1}, maxIds: {}, users: [[1, 'a@example.test']], orgs: [[1, 'on']]};
  const record = (statements) => recordLines([{step: 't', statements}], {asOf: '2026-09-25', fingerprint});
  const definitions = ['/* 説明 */ CREATE TABLE x(a)', '-- 説明\nDROP TABLE audit_log', '  /* a */ -- b\n /* c */PRAGMA foreign_keys=OFF', '/**/BEGIN', '-- 説明\nCOMMIT', '/* x */ALTER TABLE audit_log ADD COLUMN y'];
  for (const sql of definitions) assert.throws(() => recordToSql(record([{sql, params: []}])), /定義・設定・トランザクションの文は入れられません/, sql);
  const sessionWrites = [
    ['/* ログイン */ INSERT INTO sessions(id_hash,user_id,org_id,expires_at) VALUES(?,?,?,?)', ['h', 1, 1, '2026-10-01']],
    ['-- ログアウト\nDELETE FROM sessions WHERE id_hash=?', ['h']],
    ['INSERT /* x */ INTO "sessions"(id_hash) VALUES(?)', ['h']],
    ['UPDATE /* x */ main.sessions SET expires_at=? WHERE id_hash=?', ['2026-10-01', 'h']],
    ['REPLACE INTO [sessions](id_hash) VALUES(?)', ['h']],
  ];
  for (const [sql, params] of sessionWrites) {
    assert.ok(isSessionWrite(sql), sql);
    assert.throws(() => recordToSql(record([{sql, params}])), /ログイン（sessions）の書き込みは入れません/, sql);
  }
  // 記録から外す判定（businessBatches）と D1 の上限の判定（d1LimitViolations）も、コメントを外して見る
  assert.deepEqual(businessBatches([{step: 't', statements: sessionWrites.map(([sql, params]) => ({sql, params}))}]), []);
  const ddl = d1LimitViolations([{step: 't', statements: definitions.filter((sql) => !/BEGIN|COMMIT/.test(sql)).map((sql) => ({sql, params: []}))}]);
  assert.equal(ddl.length, 4, ddl.join('\n'));
  assert.ok(ddl.every((line) => /DDL・設定の文 (CREATE|DROP|PRAGMA|ALTER)/.test(line)), ddl.join('\n'));
  // 文字・名前の中の -- や /* はコメントではない。名前が sessions で始まる別の表・文字の中の sessions は、ログインの書き込みではない
  assert.equal(sqlWithoutComments(`SELECT '--x', "a/*b" -- c`), `SELECT '--x', "a/*b"`);
  assert.equal(sqlWithoutComments('SELECT 1 /* 閉じていない'), 'SELECT 1');
  assert.equal(isSessionWrite('INSERT INTO sessions_log(a) VALUES(1)'), false);
  assert.equal(isSessionWrite("INSERT INTO audit_log(detail_json) VALUES('/* x */ INSERT INTO sessions')"), false);
  // 先頭にコメントのある普通の書き込みは入れる（SQL の文にはコメントを残さない）
  const ok = recordToSql(record([{sql: '-- 監査\nINSERT INTO audit_log(detail_json) /* 値 */ VALUES(?)', params: ["{'--':1}"]}]));
  assert.ok(ok.sql.split('\n').includes(`INSERT INTO audit_log(detail_json) VALUES('{''--'':1}');`), ok.sql);
});

test('特殊な文字を含む記録: SQL ファイルを写しに当てたものと、replaySeedRecord で再生したものが、全表の行数・型・中身まで同じ', async () => {
  // 本番に見立てた DB に、特殊な値を入れる表を足す（記録の外。指紋を取る前）
  const prod = productionLike('special.sqlite', {extra: 'CREATE TABLE special_values(id INTEGER PRIMARY KEY, a, b TEXT, c BLOB, note TEXT NOT NULL)'});
  const recordingCopy = copy(prod, 'special-record.sqlite');
  const recorded = await openRecordingCopy(recordingCopy).catch((error) => error);
  // 表を1つ足したので移行の数とは合わない。d1_migrations があるので全ファイルが当たっていれば写しとして開ける
  assert.ok(!(recorded instanceof Error), String(recorded?.message));
  const fingerprint = await databaseFingerprint(recorded);
  const writer = recordingDatabase(recorded);
  writer.step = 'special';
  // 真偽は node:sqlite の binding が受け付けない（seed の記録に真偽は入らない）ので、ここでは外す（真偽の書き方は1つ目の試験）
  await writer.batch(SPECIAL_RECORDED.map((value, index) => ({sql: 'INSERT INTO special_values(id,a,b,c,note) VALUES(?,?,?,?,?)',
    params: [index + 1, value, typeof value === 'string' ? value : null, value instanceof Uint8Array ? value : null, `値 ${index + 1}`]})));
  await writer.run("INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)", [1, 1, 'create', 'special', 'x', JSON.stringify({text: SPECIAL[1], emoji: SPECIAL[5]})]);
  const afterFingerprint = await databaseFingerprint(recorded);
  recorded.close();
  const text = recordLines(businessBatches(writer.batches), {asOf: '2026-09-25', fingerprint, after: afterFingerprint});
  const converted = recordToSql(text, {source: 'special.jsonl'});
  const sqlPath = join(dir, 'special.sql');
  writeFileSync(sqlPath, converted.sql);
  // ファイルに書いて読み直した文字で当てる（本番へ渡すのはファイル）
  const fileText = readFileSync(sqlPath, 'utf8');
  const viaSql = copy(prod, 'special-sql.sqlite'), viaReplay = copy(prod, 'special-replay.sqlite');
  const applied = applyFile(viaSql, fileText);
  assert.equal(applied.ok, true, `${applied.error} ${JSON.stringify(applied.failed)}`);
  const replayed = await replayInto(viaReplay, text);
  assert.equal(replayed.ok, true, replayed.differences.join('／'));
  const diff = compare(viaSql, viaReplay);
  assert.deepEqual(diff.counts, []);
  assert.deepEqual(diff.content, []);
  assert.ok(onlyTimeColumns(diff), JSON.stringify(diff.skipped));
  // 記録した写しとも同じ（記録した写しは node:sqlite の binding で書いたので、型の違いが出うる列を持たない表だけを比べる）
  const withRecorded = compare(viaSql, recordingCopy);
  assert.deepEqual(withRecorded.counts, []);
  assert.equal(applied.after.special_values, SPECIAL_RECORDED.length);
});

let prodPath, recordText, recordCopyPath, converted;
test('本番に見立てた写し（今までの seed を入れて最新の移行を当てたもの）で記録 → SQL → 別の同じ写しに1つのトランザクションで当てると、再生したものと全表が同じ', async () => {
  // 今までの seed: 2026-09-25 に本番へ入れた形（売上を旧区分で分類）。移行は最新まで当たっている
  prodPath = productionLike('prod.sqlite');
  const seeding = new LocalDatabase(prodPath, {init: false});
  try { await seedSalesDemo(seeding, {legacyDistribution: true}); } finally { seeding.close(); }
  recordCopyPath = copy(prodPath, 'prod-record.sqlite');
  const recordingCopy = await openRecordingCopy(recordCopyPath);
  const fingerprint = await databaseFingerprint(recordingCopy);
  const recorder = recordingDatabase(recordingCopy);
  const results = await seedAllDemo(recorder, {only: ['sales', 'distribution', 'eigyo', 'broadcast', 'plbs']});
  const afterFingerprint = await databaseFingerprint(recordingCopy);
  recordingCopy.close();
  assert.deepEqual(results.map((row) => [row.key, row.skipped]), [['sales', true], ['distribution', false], ['eigyo', false], ['broadcast', false], ['plbs', false]]);
  const batches = businessBatches(recorder.batches);
  recordText = recordLines(batches, {asOf: '2026-09-25', fingerprint, after: afterFingerprint});
  converted = recordToSql(recordText, {source: 'prod.jsonl'});
  const statements = batches.reduce((sum, batch) => sum + batch.statements.length, 0);
  assert.equal(converted.counts.body, statements);
  assert.equal(converted.counts.batches, batches.length);
  assert.ok(converted.counts.before > 200 && converted.counts.after === converted.counts.before, JSON.stringify(converted.counts));
  assert.ok(converted.maxStatementBytes < STATEMENT_LIMIT_BYTES);
  // 1文1行。BEGIN・COMMIT・PRAGMA は無い。SQLite の文の区切り（sqlite3_complete と同じ考え方）でも同じ数に分かれる
  const lines = converted.sql.trimEnd().split('\n');
  const sqlLines = lines.filter((line) => !line.startsWith('--'));
  assert.equal(sqlLines.length, converted.counts.statements);
  assert.ok(sqlLines.every((line) => line.endsWith(';') && !/^\s*(BEGIN|COMMIT|PRAGMA|ROLLBACK)\b/i.test(line)));
  assert.equal(splitSqlStatements(converted.sql).length, converted.counts.statements);
  const sqlPath = join(dir, 'prod.sql');
  writeFileSync(sqlPath, converted.sql);
  const viaSql = copy(prodPath, 'prod-sql.sqlite'), viaReplay = copy(prodPath, 'prod-replay.sqlite');
  const applied = applyFile(viaSql, readFileSync(sqlPath, 'utf8'));
  assert.equal(applied.ok, true, `${applied.error} ${JSON.stringify(applied.failed)}`);
  assert.equal(applied.foreignKeys, 0);
  const replayed = await replayInto(viaReplay, recordText);
  assert.equal(replayed.ok, true, replayed.differences.join('／'));
  assert.equal(replayed.applied, batches.length);
  const diff = compare(viaSql, viaReplay);
  assert.deepEqual(diff.counts, []);
  assert.deepEqual(diff.content, [], `中身が違う表: ${diff.content.join('、')}`);
  assert.ok(onlyTimeColumns(diff), JSON.stringify(diff.skipped));
  // 記録した写し（流した後）とも、全表の行数と中身が同じ
  const withRecorded = compare(viaSql, recordCopyPath);
  assert.deepEqual(withRecorded.counts, []);
  assert.deepEqual(withRecorded.content, [], `記録した写しと中身が違う表: ${withRecorded.content.join('、')}`);
  // 当てた先でもう一度記録すると、どの節も入れ済みで書き込みは無い
  const again = await openRecordingCopy(viaSql);
  try {
    const recorder2 = recordingDatabase(again);
    const second = await seedAllDemo(recorder2, {only: ['sales', 'distribution', 'eigyo', 'broadcast', 'plbs']});
    assert.ok(second.every((row) => row.skipped), JSON.stringify(second.map((row) => [row.key, row.skipped])));
    assert.deepEqual(businessBatches(recorder2.batches), []);
  } finally { again.close(); }
});

test('指紋が違う写し（利用者が1人増えた・行を消して足した）では、先頭の確かめで失敗して1行も変わらない', () => {
  assert.ok(converted, '前の試験の SQL');
  const cases = [
    ['user', "INSERT INTO users(id,email,display_name) VALUES(90,'late@example.test','後から入った人（見立て）')", /当てる前: users の/],
    // 行数は同じでも、最後の行を消して足すと最大の rowid が変わる（id を書かずに足す行の ID がずれる）
    ['rowid', "DELETE FROM audit_log WHERE id=(SELECT MAX(id) FROM audit_log); INSERT INTO audit_log(id,org_id,user_id,action,entity_type,entity_id,detail_json) VALUES((SELECT MAX(id)+5 FROM audit_log),1,1,'x','x','x','{}')", /当てる前: audit_log の行数 \d+・最大の rowid/],
  ];
  for (const [name, change, label] of cases) {
    const path = copy(prodPath, `prod-drift-${name}.sqlite`);
    const raw = new DatabaseSync(path);
    raw.exec(change);
    raw.close();
    const untouched = copy(path, `prod-drift-${name}-before.sqlite`);
    const applied = applyFile(path, converted.sql);
    assert.equal(applied.ok, false, name);
    assert.match(applied.error, /CHECK constraint failed/);
    assert.match(applied.failed.label, label);
    assert.ok(applied.failed.line < 500, `先頭の確かめで落ちる（${applied.failed.line}行目）`);
    const diff = compare(path, untouched);
    assert.deepEqual([diff.counts, diff.content, diff.skipped], [[], [], {}], `${name}: 1行も変わらない`);
  }
});

test('当てた後の確かめ: 記録どおりの件数にならなければ、記録の文を全部当てた後でも失敗して1行も変わらない', () => {
  assert.ok(recordText, '前の試験の記録');
  const [headLine, ...rest] = recordText.trimEnd().split('\n');
  const head = JSON.parse(headLine);
  head.after.counts.audit_log += 1; // 流した後の件数が記録と合わない（途中の文が当たらなかったのと同じ形）
  const tampered = recordToSql([JSON.stringify(head), ...rest].join('\n') + '\n');
  const path = copy(prodPath, 'prod-tail.sqlite');
  const untouched = copy(prodPath, 'prod-tail-before.sqlite');
  const applied = applyFile(path, tampered.sql);
  assert.equal(applied.ok, false);
  assert.match(applied.failed.label, /^当てた後: audit_log の行数/);
  const diff = compare(path, untouched);
  assert.deepEqual([diff.counts, diff.content], [[], []], '1行も変わらない');
});

test('止める記録: 古い記録（指紋なし）・定義の文・ログインの行・1文が100KB以上・R2 に置く値。見出しに after が無い記録は最後の確かめを入れない', () => {
  const fingerprint = {counts: {users: 1}, maxIds: {}, users: [[1, 'a@example.test']], orgs: [[1, 'on']]};
  const record = (statements, head = {fingerprint}) => recordLines([{step: 't', statements}], {asOf: '2026-09-25', ...head});
  assert.throws(() => recordToSql(record([{sql: 'SELECT 1', params: []}], {})), /指紋がありません/);
  assert.throws(() => recordToSql(record([{sql: 'CREATE TABLE x(a)', params: []}])), /定義・設定・トランザクション/);
  assert.throws(() => recordToSql(record([{sql: 'BEGIN', params: []}])), /定義・設定・トランザクション/);
  assert.throws(() => recordToSql(record([{sql: 'INSERT INTO sessions(token) VALUES(?)', params: ['t']}])), /ログイン/);
  // 1つの値は D1 の上限（128KB 未満）でも、SQL の文字にすると1文が 100KB 以上になる
  assert.throws(() => recordToSql(record([{sql: 'INSERT INTO audit_log(detail_json) VALUES(?)', params: ['x'.repeat(100_000)]}])), /1文の上限（100,000バイト）以上の文が 1文/);
  assert.throws(() => recordToSql(record([{sql: 'INSERT INTO workflow_raw_artifacts(id,original_base64) VALUES(?,?)', params: [1, 'QUJD']}])), /R2 に置く値があります: workflow_raw_artifacts\.original_base64/);
  const noAfter = recordToSql(record([{sql: 'INSERT INTO audit_log(detail_json) VALUES(?)', params: ['{}']}]));
  assert.equal(noAfter.counts.after, 0);
  assert.match(noAfter.sql, /見出しに after が無い古い記録なので入れていない/);
  // SQLite が読むと桁のずれる大きさの実数（金額・比率の外）は、どの batch の何文目かを出して止める（値そのものは出さない）
  assert.throws(() => recordToSql(record([{sql: 'INSERT INTO audit_log(detail_json) VALUES(?)', params: ['{}']}, {sql: 'INSERT INTO t(a,b) VALUES(?,?)', params: [1, 1.5e20]}])),
    (error) => /batch 1 の 2文目: \|値\| が 1e15 を超える実数/.test(error.message) && !/1\.5e\+?20/.test(error.message));
  assert.throws(() => recordToSql(record([{sql: 'INSERT INTO t(a) VALUES(?)', params: [3e-9]}])), /0 でなく \|値\| が 1e-6 未満の実数/);
  // 隠れ rowid の表も比べる古い指紋（rowids があって rowidScope が無い。2026-09-27 の直しより前の記録）は SQL にせず、再生の照合でも断る
  const stale = {...fingerprint, rowids: {users: 1, memberships: 1}};
  assert.throws(() => recordToSql(record([{sql: 'INSERT INTO audit_log(detail_json) VALUES(?)', params: ['{}']}], {fingerprint: stale})), /当てる前: 記録の指紋が古い形です/);
  assert.ok(fingerprintDifferences(stale, stale).some((text) => /指紋が古い形/.test(text)));
  const current = {...fingerprint, rowids: {users: 1}, rowidScope: FINGERPRINT_ROWID_SCOPE};
  assert.deepEqual(fingerprintDifferences(current, current), []);
  assert.match(recordToSql(record([{sql: 'INSERT INTO audit_log(detail_json) VALUES(?)', params: ['{}']}], {fingerprint: current})).sql, /当てる前: users の行数 1・最大の rowid 1/);
});

test('写しを作る（--prepare-copy）: 本番の書き出し（親より先に子の行が来る .sql）を読み、当たっていない移行を当てて d1_migrations に残す。d1_migrations が無ければ --applied が要る', () => {
  // 0006 まで当たった本番の見立て（0007・0008 は未適用）。書き出しは表の名前の逆順（子の行が先）に作る
  const source = productionLike('export-src.sqlite', {upTo: 6});
  const dump = (withMigrations, extraRows = '') => {
    const raw = new DatabaseSync(source, {readOnly: true});
    try {
      const objects = raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name DESC").all();
      const out = ['PRAGMA defer_foreign_keys=TRUE;'];
      for (const table of objects.filter((o) => o.type === 'table' && (withMigrations || o.name !== 'd1_migrations'))) {
        out.push(`${table.sql};`);
        const columns = raw.prepare(`PRAGMA table_info("${table.name}")`).all().map((c) => c.name);
        const select = raw.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM "${table.name}"`);
        select.setReadBigInts(true);
        for (const row of select.all()) out.push(`INSERT INTO "${table.name}" VALUES(${columns.map((c) => sqlValue(row[c])).join(',')});`);
      }
      if (extraRows) out.push(extraRows); // 索引・トリガーより前（行と同じ位置）
      for (const o of objects.filter((x) => x.type !== 'table')) out.push(`${o.sql};`);
      return out.join('\n');
    } finally { raw.close(); }
  };
  const withTable = join(dir, 'export-with.sql');
  writeFileSync(withTable, dump(true));
  const made = join(dir, 'made-copy.sqlite');
  const result = prepareCopy({from: withTable, out: made});
  assert.deepEqual(result.applied, migrations.slice(6), '0007 以降だけを当てる');
  const check = new DatabaseSync(made, {readOnly: true});
  try {
    assert.deepEqual(copyReadiness(check), {ok: true, by: 'd1_migrations'});
    assert.deepEqual(check.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((row) => row.name), migrations);
    assert.equal(check.prepare('PRAGMA foreign_key_check').all().length, 0);
    const src = new DatabaseSync(source, {readOnly: true});
    try {
      const a = rawTableCounts(src), b = rawTableCounts(check);
      for (const [table, n] of Object.entries(a)) assert.equal(b[table], n, `${table} の行は書き出しのまま`);
    } finally { src.close(); }
  } finally { check.close(); }
  // d1_migrations の無い書き出し: --applied が無ければ止め、あれば当たっているものを入れてから残りを当てる
  const withoutTable = join(dir, 'export-without.sql');
  writeFileSync(withoutTable, dump(false));
  assert.throws(() => prepareCopy({from: withoutTable, out: join(dir, 'made-none.sqlite')}), /d1_migrations がありません/);
  assert.equal(existsSync(join(dir, 'made-none.sqlite')), false, '止めたときは写しを残さない');
  const applied = prepareCopy({from: withoutTable, out: join(dir, 'made-applied.sqlite'), applied: migrations.slice(0, 6)});
  assert.deepEqual(applied.applied, migrations.slice(6));
  // 外部キーの違反がある書き出しからは写しを作らない
  const broken = join(dir, 'export-broken.sql');
  writeFileSync(broken, dump(true, "INSERT INTO memberships(org_id,user_id,role) VALUES(999,999,'admin');"));
  assert.throws(() => prepareCopy({from: broken, out: join(dir, 'made-broken.sqlite')}), /外部キーの違反/);
  assert.equal(existsSync(join(dir, 'made-broken.sqlite')), false);
  // SQLite の写しからも作れる。出力先がもうあれば止める
  const fromSqlite = prepareCopy({from: source, out: join(dir, 'made-from-sqlite.sqlite')});
  assert.deepEqual(fromSqlite.applied, migrations.slice(6));
  assert.throws(() => prepareCopy({from: source, out: made}), /もうあります/);
});

// ---------- 本番の書き出し（wrangler d1 export）の見立て ----------
// miniflare の dumpSql（node_modules/miniflare/dist/src/workers/d1/database.worker.js）と同じ形: PRAGMA defer_foreign_keys=TRUE; →
// 表を作った順（sqlite_sequence は最後で、DELETE の後に行）に CREATE TABLE と列名つきの INSERT（rowid は書かない）→ 索引・トリガー・ビュー。
// 数はそのまま、文字は ' を '' にし、改行・CR は \n・\r と書いて replace(…,'\n',char(10)) で戻す。バイナリは X'…'
const escapeId = (id) => `"${id.replace(/"/g, '""')}"`;
function exportString(cell) {
  let lfs = false, crs = false;
  let out = `'${cell.replace(/'|(\n)|(\r)/g, (_, lf, cr) => (lf ? ((lfs = true), '\\n') : cr ? ((crs = true), '\\r') : "''"))}'`;
  if (crs) out = `replace(${out},'\\r',char(13))`;
  if (lfs) out = `replace(${out},'\\n',char(10))`;
  return out;
}
function d1Export(path) {
  const raw = new DatabaseSync(path, {readOnly: true});
  try {
    const out = ['PRAGMA defer_foreign_keys=TRUE;'];
    const tables = raw.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type=='table' AND sql NOT NULL ORDER BY tbl_name='sqlite_sequence', rowid").all();
    for (const {name, sql} of tables) {
      if (name === 'sqlite_sequence') out.push('DELETE FROM sqlite_sequence;');
      else if (/^sqlite_stat./.test(name)) out.push('ANALYZE sqlite_schema;');
      else {
        if (name.startsWith('_cf_') || name.startsWith('sqlite_')) continue;
        out.push(/CREATE TABLE ['"].*/.test(sql) ? `CREATE TABLE IF NOT EXISTS ${sql.substring(13)};` : `${sql};`);
      }
      const columns = raw.prepare(`PRAGMA table_info=${escapeId(name)}`).all().map((column) => column.name);
      const names = columns.map(escapeId).join(',');
      for (const row of raw.prepare(`SELECT ${columns.map(escapeId).join(', ')} FROM ${escapeId(name)};`).all()) {
        const cells = columns.map((column) => {
          const cell = row[column];
          return cell === null ? 'NULL' : typeof cell === 'number' ? String(cell) : typeof cell === 'string' ? exportString(cell) : `X'${Buffer.from(cell).toString('hex')}'`;
        });
        out.push(`INSERT INTO ${escapeId(name)} (${names}) VALUES(${cells.join(',')});`);
      }
    }
    for (const {sql} of raw.prepare("SELECT name, sql FROM sqlite_schema WHERE sql NOT NULL AND type IN ('index', 'trigger', 'view') ORDER BY type COLLATE NOCASE").all()) out.push(`${sql};`);
    return out.join('\n');
  } finally { raw.close(); }
}
const asyncDb = (raw) => ({all: async (sql, params = []) => raw.prepare(sql).all(...params), get: async (sql, params = []) => raw.prepare(sql).get(...params)});
const maxRowid = (path, table) => {
  const raw = new DatabaseSync(path, {readOnly: true});
  try { return Number(raw.prepare(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${escapeId(table)}`).get().n); } finally { raw.close(); }
};
const rowidList = (raw, table) => raw.prepare(`SELECT rowid AS r FROM ${escapeId(table)} ORDER BY rowid`).all().map((row) => row.r).join(',');

test('rowid の別名: 主キーが宣言の型 INTEGER の1列の表だけ（主キーが複数の列・INTEGER でない列・INTEGER PRIMARY KEY DESC・WITHOUT ROWID は別名なし）', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE a(id INTEGER PRIMARY KEY, x); CREATE TABLE b(x, id integer, PRIMARY KEY(id)); CREATE TABLE c(id INT PRIMARY KEY);
    CREATE TABLE d(id INTEGER PRIMARY KEY DESC); CREATE TABLE e(org INTEGER, id INTEGER, PRIMARY KEY(org,id)); CREATE TABLE f(code TEXT PRIMARY KEY);
    CREATE TABLE g(id INTEGER PRIMARY KEY, x) WITHOUT ROWID; CREATE TABLE h(x); CREATE TABLE "q""t"(id INTEGER PRIMARY KEY)`);
  assert.deepEqual([...await rowidAliasTables(asyncDb(raw), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'q"t'])].sort(), ['a', 'b', 'q"t']);
  raw.close();
});

test('穴のある本番: 列名つき INSERT の書き出し → --prepare-copy → 記録 → SQL を元の本番（写しの複製ではない）に当てると成功し、replaySeedRecord の再生と全表が同じ', async () => {
  // 本番の見立て: 今までの seed を入れ、rowid の別名のない表（主キーが複数の列・文字の列）と別名のある表の両方に、途中の行の削除の穴を作る
  const prod = productionLike('holes.sqlite');
  const seeding = new LocalDatabase(prod, {init: false});
  try { await seedSalesDemo(seeding, {legacyDistribution: true}); } finally { seeding.close(); }
  const raw = new DatabaseSync(prod);
  try {
    // billing_invoice_sequences（主キー org_id,year_month）: 記録の節も行を足す表。隠れ rowid 1・2・3 の2を消す
    raw.exec("INSERT INTO billing_invoice_sequences(org_id,year_month,last_number) VALUES(1,'202001',1),(1,'202002',1),(1,'202003',1)");
    raw.exec("DELETE FROM billing_invoice_sequences WHERE org_id=1 AND year_month='202002'");
    // import_previews（主キー token）と audit_log（id INTEGER PRIMARY KEY）: 真ん中の行を消す
    for (const [table, key] of [['import_previews', 'rowid'], ['audit_log', 'id']]) {
      const rows = raw.prepare(`SELECT ${key} AS k FROM ${table} ORDER BY ${key}`).all();
      raw.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(rows[Math.floor(rows.length / 2)].k);
    }
  } finally { raw.close(); }
  const exportPath = join(dir, 'holes-export.sql');
  writeFileSync(exportPath, d1Export(prod));
  assert.doesNotMatch(readFileSync(exportPath, 'utf8'), /\browid\b/i, '書き出しは rowid を書かない');
  const copyPath = join(dir, 'holes-copy.sqlite');
  assert.deepEqual(prepareCopy({from: exportPath, out: copyPath}).applied, [], '移行はすべて当たっている');
  // 書き出し → 写し: 別名のない表の隠れ rowid は1から振り直される（直す前は、これで SQL の先頭の確かめが必ず落ちた）
  assert.deepEqual([maxRowid(prod, 'billing_invoice_sequences'), maxRowid(copyPath, 'billing_invoice_sequences')], [3, 2]);
  assert.ok(maxRowid(prod, 'import_previews') > maxRowid(copyPath, 'import_previews'));
  const prodRaw = new DatabaseSync(prod, {readOnly: true}), copyRaw = new DatabaseSync(copyPath, {readOnly: true});
  try {
    const aliases = await rowidAliasTables(asyncDb(prodRaw), Object.keys(rawTableCounts(prodRaw)));
    assert.ok(aliases.has('audit_log') && aliases.has('users') && !aliases.has('import_previews') && !aliases.has('billing_invoice_sequences') && !aliases.has('memberships'));
    // 別名のある表は、rowid（id の列）が書き出し → 写しで同じ値のまま（穴も残る）
    assert.deepEqual([...aliases].filter((table) => rowidList(prodRaw, table) !== rowidList(copyRaw, table)), [], '書き出し → 写しで rowid が変わった別名のある表');
    // 指紋の rowids は別名のある表だけで、本番と写しの指紋は同じ
    const prodPrint = await databaseFingerprint(asyncDb(prodRaw)), copyPrint = await databaseFingerprint(asyncDb(copyRaw));
    assert.deepEqual(Object.keys(copyPrint.rowids).sort(), [...aliases].sort());
    assert.equal(copyPrint.rowidScope, FINGERPRINT_ROWID_SCOPE);
    assert.deepEqual(fingerprintDifferences(copyPrint, prodPrint), []);
    // 行の中身も書き出しのまま
    const content = compareDatabases(prodRaw, copyRaw);
    assert.deepEqual([content.counts, content.content], [[], []]);
  } finally { prodRaw.close(); copyRaw.close(); }
  // 写しの上で記録する（売上は入れ済み。付け替え・営業基幹・番販と放送・PL・BS）
  const recordingCopy = await openRecordingCopy(copyPath);
  const fingerprint = await databaseFingerprint(recordingCopy);
  const recorder = recordingDatabase(recordingCopy);
  const results = await seedAllDemo(recorder, {only: ['sales', 'distribution', 'eigyo', 'broadcast', 'plbs']});
  const afterFingerprint = await databaseFingerprint(recordingCopy);
  recordingCopy.close();
  assert.deepEqual(results.map((row) => [row.key, row.skipped]), [['sales', true], ['distribution', false], ['eigyo', false], ['broadcast', false], ['plbs', false]]);
  const text = recordLines(businessBatches(recorder.batches), {asOf: '2026-09-25', fingerprint, after: afterFingerprint});
  const converted = recordToSql(text, {source: 'holes.jsonl'});
  assert.doesNotMatch(converted.sql, /-- 当て(る前|た後): (import_previews|billing_invoice_sequences|memberships) の[^\n]*rowid/, '別名のない表の rowid は確かめない');
  assert.match(converted.sql, /-- 当てる前: audit_log の行数 \d+・最大の rowid \d+/);
  // 元の本番の見立てに当てる（写しの複製ではない）。1つのトランザクションで最後まで当たり、先頭と最後の確かめを通る
  const viaSql = copy(prod, 'holes-sql.sqlite'), viaReplay = copy(prod, 'holes-replay.sqlite');
  const applied = applyFile(viaSql, converted.sql);
  assert.equal(applied.ok, true, `${applied.error} ${JSON.stringify(applied.failed)}`);
  assert.equal(applied.foreignKeys, 0);
  const replayed = await replayInto(viaReplay, text);
  assert.equal(replayed.ok, true, replayed.differences.join('／'));
  const diff = compare(viaSql, viaReplay);
  assert.deepEqual(diff.counts, []);
  assert.deepEqual(diff.content, [], `中身が違う表: ${diff.content.join('、')}`);
  assert.ok(onlyTimeColumns(diff), JSON.stringify(diff.skipped));
  // 記録した写し（流した後）とも行数と中身が同じ。違うのは別名のない表の隠れ rowid だけ（記録で行が増えた billing_invoice_sequences は、本番が写しより1つ先）
  const withRecorded = compare(viaSql, copyPath);
  assert.deepEqual(withRecorded.counts, []);
  assert.deepEqual(withRecorded.content, [], `記録した写しと中身が違う表: ${withRecorded.content.join('、')}`);
  assert.ok(maxRowid(copyPath, 'billing_invoice_sequences') > 2, '記録で billing_invoice_sequences に行が増えた');
  assert.equal(maxRowid(viaSql, 'billing_invoice_sequences') - maxRowid(copyPath, 'billing_invoice_sequences'), 1);
});

// staging: the same recorded fictional sales are applied as native SQL to both engines.
test('FR-CORE-DATA-042 staging の同じ売上記録の SQL は両DBで全表の件数と金額が一致し、再投入を拒む', async (t) => {
  const { stagingRecord, stagingSql } = await import('../scripts/seed-staging.mjs');
  const { openTestDb } = await import('./test-db.mjs');
  const { tableCounts } = await import('../scripts/seed-all-demo.mjs');
  const record = await stagingRecord();
  const sql = stagingSql(record);
  const lite = new LocalDatabase(':memory:', {init:false});
  t.after(() => lite.close());
  for (const name of readdirSync(resolve(app,'migrations')).filter(x => x.endsWith('.sql')).sort()) lite.raw.exec(readFileSync(resolve(app,'migrations',name),'utf8'));
  lite.raw.exec('BEGIN');
  lite.raw.exec(sql.d1);
  lite.raw.exec('COMMIT');
  assert.equal((await lite.get('SELECT count(*) n FROM works')).n,20);
  const pg = await openTestDb({t,kind:'pg'});
  await pg.queryable.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pg.queryable.query(readFileSync(resolve(app,'pg/schema.sql'),'utf8'));
  await pg.queryable.query('BEGIN');
  try { await pg.queryable.query(sql.pg); await pg.queryable.query('COMMIT'); }
  catch (error) { await pg.queryable.query('ROLLBACK'); throw error; }
  assert.deepEqual(await tableCounts(pg), await tableCounts(lite));
  const reconcile=readFileSync(resolve(app,'pg/reconcile.sql'),'utf8');
  assert.deepEqual(await pg.all(reconcile), (await lite.all(reconcile)).map(row => ({...row})));
  assert.equal((await pg.get('SELECT count(*) n FROM sessions')).n,0);
  assert.deepEqual((await pg.all('SELECT email FROM users')).map(x=>x.email),['demo-admin@openingnight.invalid']);
  assert.equal((await pg.get("INSERT INTO organizations(code,name) VALUES('DEMO-NEXT','架空の次の組織') RETURNING id")).id,2);
  await pg.queryable.query('BEGIN');
  await assert.rejects(pg.queryable.query(sql.pg), error => error.code === '23514');
  await pg.queryable.query('ROLLBACK');
  assert.equal((await pg.get('SELECT count(*) n FROM organizations')).n,2);
  lite.raw.exec('BEGIN');
  assert.throws(()=>lite.raw.exec(sql.d1), /CHECK constraint failed/);
  lite.raw.exec('ROLLBACK');
  assert.equal((await lite.get('SELECT count(*) n FROM works')).n,20);
  // 代表の在籍も値をファイルへ埋めず、psql の引用と同じ SQL リテラルで確認する。
  // 引用符を含む架空メールでも SQL を壊さず、再実行で行が増えない。
  const memberSql = readFileSync(resolve(app,'pg/staging-member.sql'),'utf8')
    .replaceAll(":'member_email'", sqlValue("staging.o'connor@example.invalid"));
  for (let i = 0; i < 2; i += 1) {
    await pg.queryable.query('BEGIN');
    await pg.queryable.query(memberSql);
    await pg.queryable.query('COMMIT');
    assert.equal(applySqlText(lite.raw, memberSql).ok,true);
  }
  const membership = "SELECT u.email,m.role,m.active,m.expires_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=?";
  const email = "staging.o'connor@example.invalid";
  const expected = [{email,role:'admin',active:1,expires_at:null}];
  assert.deepEqual(await pg.all(membership,[email]),expected);
  assert.deepEqual((await lite.all(membership,[email])).map(row=>({...row})),expected);
});
