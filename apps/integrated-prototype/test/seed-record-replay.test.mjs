// 本番の写しの上で架空データの書き込みを記録し（scripts/seed-all-demo.mjs --record）、本番の DB 部品（R2BackedD1Database）で再生できるか。
// 本番に見立てた DB は、移行 0001〜0007 を当てた白紙の SQLite に本物に見立てた組織1・利用者1・所属だけを入れたもの（ローカルの試作用の行は無い）。
// 壊れたら: 写しを開くときに試作用の行（組織2・利用者2〜4など）が黙って足され、記録の利用者IDが本番とずれて、再生が途中で外部キーの誤りで止まる
// （止まるまでの batch は本番に残る）。指紋を見ずに再生すると、本番が写しと違っても当ててしまう。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readdirSync, readFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {R2BackedD1Database} from '../src/cloud-r2-db.mjs';
import {seedAllDemo, recordingDatabase, businessBatches, recordLines, tableCounts, openRecordingCopy, copyReadiness, databaseFingerprint, replaySeedRecord, d1LimitViolations} from '../scripts/seed-all-demo.mjs';
import {seedSalesDemo} from '../scripts/seed-sales-demo.mjs';
import {LocalDatabase} from '../src/db.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let dir, recordedText; // 2つ目の試験で写しの上で記録した書き込み（3つ目の試験で、同じ形の別の本番へ当てる）
before(() => { dir = mkdtempSync(join(tmpdir(), 'on-seed-replay-')); });
after(() => { if (dir) rmSync(dir, {recursive: true, force: true}); });

// 移行を番号順に当てた DB（wrangler と同じく d1_migrations に名前を残す）に、本物に見立てた組織1・利用者1・所属だけを入れる
function productionLike(name, {withFixtures = false} = {}) {
  const path = join(dir, name);
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys=ON');
  raw.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
  for (const file of readdirSync(join(app, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(app, 'migrations', file), 'utf8'));
    raw.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(file);
  }
  if (withFixtures) {
    // いまの本番の形: 試作用の行（src/schema.sql の組織1・2、利用者1〜4、作品 WRK-DEMO など）が入り、利用者1のメールを本物に付け替えたもの
    const sql = readFileSync(join(app, 'src', 'schema.sql'), 'utf8');
    const start = sql.indexOf('INSERT OR IGNORE INTO organizations');
    const block = sql.slice(start, sql.indexOf('\nCREATE ', start)); // 試作用の行の INSERT の並び（次の CREATE の前まで）
    raw.exec(block);
    raw.prepare("UPDATE users SET email='owner@example.test' WHERE id=1").run();
  } else {
    raw.exec(`INSERT INTO organizations(id,code,name) VALUES(1,'on','本番の組織（見立て）');
      INSERT INTO schema_meta(org_id,version) VALUES(1,1);
      INSERT INTO users(id,email,display_name) VALUES(1,'owner@example.test','代表（見立て）');
      INSERT INTO memberships(org_id,user_id,role) VALUES(1,1,'admin');`);
  }
  raw.close();
  return path;
}

// 本番の D1 binding の代わり（node:sqlite。D1 の上限の1文100値は超えたら止める）と R2 の代わり
function fakeD1(raw) {
  const run = (sql, params) => {
    if (params.length > 100) throw new Error(`D1: too many SQL variables (${params.length})`);
    const out = raw.prepare(sql).run(...params);
    return {success: true, meta: {changes: Number(out.changes), last_row_id: Number(out.lastInsertRowid)}};
  };
  const statement = (sql, params = []) => ({sql, params, bind: (...next) => statement(sql, next),
    all: async () => ({results: raw.prepare(sql).all(...params), success: true}), first: async () => raw.prepare(sql).get(...params) ?? null, run: async () => run(sql, params)});
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

async function recordOnCopy(prodPath, copyName) {
  const copyPath = join(dir, copyName);
  copyFileSync(prodPath, copyPath);
  const copy = await openRecordingCopy(copyPath);
  const fingerprint = await databaseFingerprint(copy);
  const recorder = recordingDatabase(copy);
  await seedAllDemo(recorder, {only: ['sales']});
  const batches = businessBatches(recorder.batches);
  return {copy, text: recordLines(batches, {asOf: '2026-09-25', fingerprint}), batches};
}
const withoutSessions = (counts) => Object.fromEntries(Object.entries(counts).filter(([table]) => !['sessions', 'd1_migrations'].includes(table)));

test('写しは表の定義も試作用の行も流さずに開き（行は増えない）、最新の移行まで当たっていない写しは断る', async () => {
  const prod = productionLike('prod-a.sqlite');
  const copyPath = join(dir, 'copy-a.sqlite');
  copyFileSync(prod, copyPath);
  const copy = await openRecordingCopy(copyPath);
  try {
    assert.deepEqual((await copy.all('SELECT id FROM users ORDER BY id')).map((row) => row.id), [1], '試作用の利用者2〜4を足さない');
    assert.deepEqual((await copy.all('SELECT code FROM organizations ORDER BY id')).map((row) => row.code), ['on'], '試作用の組織（demo・other）を足さない');
  } finally { copy.close(); }
  // 移行の途中までしか当たっていない写しは止める
  const partial = new DatabaseSync(join(dir, 'partial.sqlite'));
  partial.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  partial.exec(readFileSync(join(app, 'migrations', '0001_initial.sql'), 'utf8'));
  partial.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run('0001_initial.sql');
  assert.match(copyReadiness(partial).reason, /当たっていない移行があります: 0002_ux_extensions\.sql/);
  partial.close();
  // d1_migrations の無い写し（移行の文を当てただけ）は、表・トリガー・索引の数を移行の manifest と比べる
  const bare = new DatabaseSync(':memory:');
  for (const file of readdirSync(join(app, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) bare.exec(readFileSync(join(app, 'migrations', file), 'utf8'));
  assert.deepEqual(copyReadiness(bare), {ok: true, by: 'manifest'});
  bare.close();
  await assert.rejects(openRecordingCopy(join(dir, 'partial.sqlite')), /本番の写しとして使えません/);
});

test('写しの上で記録した書き込みは、本番の DB 部品を通して本番へ最後まで再生でき、表ごとの行数が写しと同じになる', async () => {
  const prod = productionLike('prod-b.sqlite');
  const {copy, text} = await recordOnCopy(prod, 'copy-b.sqlite');
  recordedText = text;
  const raw = new DatabaseSync(prod);
  raw.exec('PRAGMA foreign_keys=ON');
  try {
    const cloud = new R2BackedD1Database(fakeD1(raw), fakeR2());
    const result = await replaySeedRecord(text, cloud);
    assert.deepEqual(result.differences, []);
    assert.equal(result.ok, true);
    assert.equal(result.applied, text.trimEnd().split('\n').length - 1, '全部の batch を当てた');
    assert.deepEqual(withoutSessions(await tableCounts(cloud)), withoutSessions(await tableCounts(copy)));
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { raw.close(); copy.close(); }
});

test('本番が写しと違う（利用者が1人増えた）ときは、1文も当てずに不一致として断る', async () => {
  // 2つ目の試験の本番と同じ形の本番（写しを取った時点と同じ）に、後から利用者が1人入った
  const prod = productionLike('prod-c.sqlite');
  const text = recordedText;
  assert.ok(text, '2つ目の試験の記録');
  const raw = new DatabaseSync(prod);
  raw.exec('PRAGMA foreign_keys=ON');
  try {
    raw.prepare("INSERT INTO users(id,email,display_name) VALUES(2,'new@example.test','後から入った人（見立て）')").run();
    const cloud = new R2BackedD1Database(fakeD1(raw), fakeR2());
    const before = await tableCounts(cloud);
    const result = await replaySeedRecord(text, cloud);
    assert.equal(result.ok, false);
    assert.equal(result.applied, 0);
    assert.ok(result.differences.some((text) => text.includes('users')), result.differences.join('／'));
    assert.deepEqual(await tableCounts(cloud), before, '何も当てていない');
  } finally { raw.close(); }
});

test('いまの本番の形（試作用の行が入り、利用者1のメールを付け替えたもの）でも、写しで記録して最後まで再生できる', async () => {
  const prod = productionLike('prod-d.sqlite', {withFixtures: true});
  const {copy, text} = await recordOnCopy(prod, 'copy-d.sqlite');
  const raw = new DatabaseSync(prod);
  raw.exec('PRAGMA foreign_keys=ON');
  try {
    const result = await replaySeedRecord(text, new R2BackedD1Database(fakeD1(raw), fakeR2()));
    assert.equal(result.ok, true, result.differences.join('／'));
    assert.deepEqual(withoutSessions(await tableCounts(new R2BackedD1Database(fakeD1(raw), fakeR2()))), withoutSessions(await tableCounts(copy)));
  } finally { raw.close(); copy.close(); }
});

// 2026-09-25 に売上の架空データを旧区分の流通の分類で入れた本番（DEMO-SALES）に、流通マスタの流通IDへの付け替え（scripts/seed-sales-distribution.mjs）を
// 写しで記録して再生する。壊れたら: 付け替えの書き込みが本番の DB 部品で当たらない（D1 の上限・外部キー）か、再生の後にもう一度流すとまた付け替える
test('旧区分で入れた本番: 流通の分類の付け替えを写しで記録して再生すると写しと同じになり、再生の後にもう一度記録しても書き込みは無い', async () => {
  const prod = productionLike('prod-e.sqlite');
  const seeding = new LocalDatabase(prod, {init: false});
  try { await seedSalesDemo(seeding, {legacyDistribution: true}); } finally { seeding.close(); }
  const record = async (name) => {
    const copyPath = join(dir, name);
    copyFileSync(prod, copyPath);
    const copy = await openRecordingCopy(copyPath);
    const fingerprint = await databaseFingerprint(copy);
    const recorder = recordingDatabase(copy);
    const results = await seedAllDemo(recorder, {only: ['sales', 'distribution']});
    const batches = businessBatches(recorder.batches);
    return {copy, results, batches, text: recordLines(batches, {asOf: '2026-09-25', fingerprint})};
  };
  const first = await record('copy-e.sqlite');
  const raw = new DatabaseSync(prod);
  raw.exec('PRAGMA foreign_keys=ON');
  try {
    assert.deepEqual(first.results.map((row) => [row.key, row.skipped]), [['sales', true], ['distribution', false]], '売上は入れ済み、流通の分類だけ付け替える');
    const reclassified = first.results[1].result.reclassified;
    assert.ok(reclassified > 700, `付け替え ${reclassified}行`);
    assert.equal(first.batches.length, reclassified);
    assert.ok(first.batches.every((batch) => batch.step === 'distribution' && batch.statements.every((s) => /^\s*INSERT INTO (sale_distribution_versions|audit_log)\b/i.test(s.sql))));
    assert.deepEqual(d1LimitViolations(first.batches), []);
    const result = await replaySeedRecord(first.text, new R2BackedD1Database(fakeD1(raw), fakeR2()));
    assert.equal(result.ok, true, result.differences.join('／'));
    assert.equal(result.applied, reclassified);
    assert.deepEqual(withoutSessions(await tableCounts(new R2BackedD1Database(fakeD1(raw), fakeR2()))), withoutSessions(await tableCounts(first.copy)));
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0);
    // 本番の DEMO-SALES に、seed が旧区分で入れたままの明細が残っていない
    const left = raw.prepare(`SELECT COUNT(*) AS n FROM sale_distribution_versions d LEFT JOIN distribution_master m ON m.code=d.distribution_code
      WHERE d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=d.org_id AND x.sale_id=d.sale_id) AND m.code IS NULL`).get().n;
    assert.equal(Number(left), 0);
  } finally { raw.close(); first.copy.close(); }
  // 再生した本番の写しでもう一度記録すると、どの節も入れ済みで書き込みは無い（2回流しても増えない）
  const again = await record('copy-e2.sqlite');
  try {
    assert.deepEqual(again.results.map((row) => [row.key, row.skipped]), [['sales', true], ['distribution', true]]);
    assert.deepEqual(again.batches, []);
  } finally { again.copy.close(); }
});
