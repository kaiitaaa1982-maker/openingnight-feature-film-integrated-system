// 差分の移行（PG 計画 段2の実測 S14）の試験。scripts/pg-ddl.mjs の convertDelta が作る差分の SQL を、起点の全体を当てた DB に
// scripts/pg-migrate.mjs で当て、新しい全体を当てた DB と定義（scripts/pg-definition.mjs。数でなく、列・制約・トリガー・関数・索引・シーケンス・
// 版の印・初期の行の中身）で比べる。止まるとき（版の印・カタログ・持ち主・途中の失敗・外部キー・変換できない文・ロック待ち）は固定の語か
// SQLSTATE で止まり、何も変わらないことを確かめる。架空の移行のフォルダは試験の中で作り、手直し（SOURCE_PATCHES）は空で流す。
// PostgreSQL は既定で PGlite、ON_TEST_PG_URL があれば本物の PostgreSQL（CI の integrated-postgres の npm run test:pg）。
// 2つの接続が要るロック待ちの試験と、psql の -1 の経路の試験は本物の PostgreSQL だけで流れる。架空のデータだけを使う
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DELTA_RAISE_WORDS, DeltaError, MIGRATIONS_DIR, SECTIONS_PATH, compareSectionLedgers, convertDelta, convertMigrations, fingerprintRow, ledgerJson, lf, sectionLedger,
} from '../scripts/pg-ddl.mjs';
import {
  CHECK_RAISE_WORDS, applyDelta, checkSql, migrateCli, migrateDatabase, migrateError, migrateFailureCause, outputLines, planFiles, planFromFingerprint, readDbFingerprint,
} from '../scripts/pg-migrate.mjs';
import { definitionDiff, definitionSnapshot } from '../scripts/pg-definition.mjs';
import { compareReconciliation } from '../src/data-platform/pg-export-format.mjs';
import { openPgClient } from './pg-client.mjs';

// ---------- 架空の移行のフォルダ ----------

const BASE_FILES = {
  '0001_base.sql': `CREATE TABLE orgs (
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL UNIQUE,
 budget_yen INTEGER NOT NULL DEFAULT 0 CHECK(budget_yen>=0)
);
CREATE TABLE kinds (
 code TEXT PRIMARY KEY,
 label TEXT NOT NULL
);
INSERT INTO kinds(code,label) VALUES ('a','架空の種類A'),('b','架空の種類B');
CREATE TABLE items (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES orgs(id),
 kind TEXT REFERENCES kinds(code),
 amount_yen INTEGER NOT NULL CHECK(amount_yen>=0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX items_org_idx ON items(org_id);
CREATE TRIGGER items_no_delete BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT,'items are kept'); END;
`,
  '0002_notes.sql': `CREATE TABLE notes (
 id INTEGER PRIMARY KEY,
 item_id INTEGER NOT NULL REFERENCES items(id),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 200)
);
CREATE TRIGGER notes_body_fixed BEFORE UPDATE OF body ON notes WHEN NEW.body<>OLD.body BEGIN SELECT RAISE(ABORT,'note body is fixed'); END;
`,
  '0003_tags.sql': `CREATE TABLE tags (code TEXT PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE item_tags (
 item_id INTEGER NOT NULL REFERENCES items(id),
 tag_code TEXT NOT NULL REFERENCES tags(code),
 PRIMARY KEY(item_id, tag_code)
);
`,
};
// 差分に載る 0004: 新しい表・ID を指定した INSERT・既存の IDENTITY の表への ID 指定の INSERT・既定値つきの ADD COLUMN・
// REFERENCES つきの ADD COLUMN・既存の表へのトリガー・外部キー（新しい表から既存の表へ）
const DELTA_0004 = `CREATE TABLE IF NOT EXISTS stages (
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL UNIQUE,
 label TEXT NOT NULL
);
INSERT INTO stages(id,code,label) VALUES (1,'s1','架空の段階1'),(2,'s2','架空の段階2'),(3,'s3','架空の段階3');
INSERT INTO orgs(id,code,budget_yen) VALUES (1000,'SYSTEM',0);
ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed'));
ALTER TABLE items ADD COLUMN stage_id INTEGER REFERENCES stages(id);
CREATE INDEX items_stage_idx ON items(stage_id);
CREATE TRIGGER items_stage_known BEFORE UPDATE OF stage_id ON items
 WHEN NEW.stage_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stages s WHERE s.id=NEW.stage_id)
 BEGIN SELECT RAISE(ABORT,'unknown stage'); END;
CREATE TABLE stage_events (
 id INTEGER PRIMARY KEY,
 item_id INTEGER NOT NULL REFERENCES items(id),
 stage_id INTEGER NOT NULL REFERENCES stages(id),
 fee_yen INTEGER NOT NULL DEFAULT 0 CHECK(fee_yen>=0)
);
`;
// 途中の文（既存の行と重なる INSERT）で落ちる 0004
const FAIL_0004 = `CREATE TABLE stages (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE);
ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
INSERT INTO kinds(code,label) VALUES ('a','重なる架空の種類');
`;
// 既存の行（items）から作った行が、新しい外部キー（kinds）に反する 0004
const FK_0004 = `CREATE TABLE item_kinds (
 item_id INTEGER PRIMARY KEY REFERENCES items(id),
 kind TEXT NOT NULL REFERENCES kinds(code)
);
INSERT INTO item_kinds(item_id, kind) SELECT id, 'z' FROM items;
`;
// 架空の業務の行（起点の DB に入れる）
const FICTIONAL_ROWS = `INSERT INTO orgs(id, code, budget_yen) VALUES (1, 'DEMO-A', 500000), (2, 'DEMO-B', 1200000);
INSERT INTO items(org_id, kind, amount_yen) VALUES (1, 'a', 1000), (1, 'b', 2500), (2, 'a', 7000);
INSERT INTO notes(item_id, body) VALUES (1, '架空の覚え書き');
INSERT INTO tags(code, label) VALUES ('t1', '架空の札');
INSERT INTO item_tags(item_id, tag_code) VALUES (1, 't1');`;

const BASE = '0003_tags.sql';
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function migrationDir(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'pg-migrate-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries({ ...BASE_FILES, ...extra })) writeFileSync(join(dir, name), text);
  return dir;
}
const deltaDir = migrationDir({ '0004_stages.sql': DELTA_0004 });

async function openDb(t, sql = null) {
  const db = await openPgClient({ applySchema: false });
  t.after(() => db.close());
  if (sql) await db.client.query(sql);
  return db;
}
const query = (db) => (sql, params) => db.client.query(sql, params).then((r) => r.rows);
const snapshot = (db, state = true) => definitionSnapshot(query(db), { state });
// 起点の全体を当てた DB（rows を渡せば架空の行も入れる）と、差分
async function baseDb(t, dir, { rows = null } = {}) {
  const delta = convertDelta({ dir, patches: [], from: BASE });
  const db = await openDb(t, delta.base.sql);
  if (rows) await db.client.query(rows);
  return { db, delta };
}
const fullDb = (t, dir) => openDb(t, convertMigrations({ dir, patches: [] }).sql);
const causeIs = (cause) => (error) => migrateFailureCause(error) === cause;

// ---------- (1) 起点＋差分と全体の定義 ----------

test('架空の移行: 起点の全体に差分を当てた DB は、新しい全体の DB と、列（attnum の順）・制約と名前・トリガー・関数・索引・シーケンス・版の印・初期の行まで同じ', async (t) => {
  const { db, delta } = await baseDb(t, deltaDir);
  assert.equal(delta.state, 'delta');
  assert.deepEqual(delta.sections, ['0004_stages.sql']);
  assert.deepEqual(delta.newTables, [{ table: 'stages', rows: 3, maxRows: 3 }, { table: 'stage_events', rows: 0, maxRows: 0 }]);
  assert.deepEqual(delta.changedTables, [{ table: 'orgs', rows: 1, maxRows: 1 }]);
  const result = await migrateDatabase({ client: db.client, dir: deltaDir, patches: [] });
  assert.equal(result.state, 'applied');
  assert.equal(result.reconcile_equal, true);
  assert.deepEqual(result.new_tables, { stages: 3, stage_events: 0 });
  const full = await fullDb(t, deltaDir);
  const [left, right] = [await snapshot(full), await snapshot(db)];
  assert.deepEqual(definitionDiff(left, right), []);
  // 比べた中身が空でない（数ではなく定義の文と名前を並べている）
  assert.ok(right.columns.items.some((c) => /\|status\|text\|C\|true\|\|\|'open'::text$/.test(c)), right.columns.items.join(' / '));
  assert.deepEqual(right.columns.items.map((c) => c.split('|').slice(0, 2).join(':')), ['1:id', '2:org_id', '3:kind', '4:amount_yen', '5:created_at', '6:status', '7:stage_id']);
  assert.ok(right.constraints.items.some((c) => /^items_stage_id_fkey\|f\|FOREIGN KEY \(stage_id\) REFERENCES stages\(id\)/.test(c)), right.constraints.items.join(' / '));
  assert.ok(right.triggers.items.some((c) => c.startsWith('items_stage_known|CREATE TRIGGER items_stage_known BEFORE UPDATE OF stage_id ON items')));
  assert.ok(right.functions.some((f) => f.startsWith('items_stage_known_fn||trigger|plpgsql|')));
  assert.equal(right.fingerprint[0].last_migration, '0004_stages.sql');
  assert.deepEqual(right.fingerprint, left.fingerprint);
});

test('定義の比べは数でなく中身で比べ、制約の名前・既定値・トリガーの文・関数の本体・行の1か所のずれを見逃さない', async (t) => {
  const full = await fullDb(t, deltaDir);
  const before = await snapshot(full);
  const changes = [
    ['ALTER TABLE items RENAME CONSTRAINT items_stage_id_fkey TO items_stage_fk', ['constraints: items']],
    ["ALTER TABLE items ALTER COLUMN status SET DEFAULT 'closed'", ['columns: items']],
    ["CREATE OR REPLACE FUNCTION items_stage_known_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$", ['functions: 期待にあって無い 1・期待に無い 1']],
    ['DROP TRIGGER items_no_delete ON items', ['triggers: items']],
    ["UPDATE stages SET label = '架空の別の名前' WHERE id = 2", ['rows: stages']],
  ];
  for (const [sql, expected] of changes) {
    await full.client.query('BEGIN');
    await full.client.query(sql);
    assert.deepEqual(definitionDiff(before, await snapshot(full)), expected, sql);
    await full.client.query('ROLLBACK');
  }
  assert.deepEqual(definitionDiff(before, await snapshot(full)), []);
});

// ---------- (2) 起点の確かめで止まる ----------

test('版の印がずれた DB・索引を1つ落とした DB・版の印の無い DB・2行の DB・持ち主の違う表のある DB では、固定の語で止まり何も変わらない', async (t) => {
  const cases = [
    ['base_mismatch', "UPDATE schema_source_fingerprint SET ddl_sha256 = repeat('0', 64)"],
    ['catalog_mismatch', 'DROP INDEX items_org_idx'],
    ['no_fingerprint', 'DROP TABLE schema_source_fingerprint'],
    ['no_fingerprint', 'ALTER TABLE schema_source_fingerprint DROP CONSTRAINT schema_source_fingerprint_pkey; ALTER TABLE schema_source_fingerprint DROP CONSTRAINT schema_source_fingerprint_singleton_check; INSERT INTO schema_source_fingerprint SELECT * FROM schema_source_fingerprint'],
  ];
  for (const [cause, breakIt] of cases) {
    const { db, delta } = await baseDb(t, deltaDir, { rows: FICTIONAL_ROWS });
    await db.client.query(breakIt);
    const before = await snapshot(db);
    // 差分の SQL そのもの（起点の確かめの DO ブロック）が固定の語で止める
    await assert.rejects(applyDelta({ client: db.client, delta }), (error) => error.code === 'P0001' && error.message === cause && migrateFailureCause(error) === cause, cause);
    assert.deepEqual(definitionDiff(before, await snapshot(db)), [], `${cause}: 何も変わらない`);
    // 道具の入口（版の印を読んで起点を決める）も、接続した DB を変えずに止まる
    await assert.rejects(migrateDatabase({ client: db.client, dir: deltaDir, patches: [] }), causeIs(cause), `${cause}（入口）`);
    assert.deepEqual(definitionDiff(before, await snapshot(db)), [], `${cause}: 入口でも何も変わらない`);
  }
});

let roleSeq = 0;
test('持ち主の確かめ: いまのロールが ALTER できない表（持ち主のロールの一員でない）があれば not_owner で止まり何も変わらず、持ち主のロールの一員なら当たる', async (t) => {
  // スーパーユーザーはどのロールの一員でもある（pg_has_role が真）ので、ふつうのロール（owner）に全表を持たせ、SET ROLE で当てる
  const { db, delta } = await baseDb(t, deltaDir, { rows: FICTIONAL_ROWS });
  const owner = `s14_owner_${process.pid}_${roleSeq += 1}`;
  const other = `s14_other_${process.pid}_${roleSeq}`;
  await db.client.query(`CREATE ROLE ${owner} NOLOGIN; CREATE ROLE ${other} NOLOGIN`);
  try {
    await db.client.query(`GRANT USAGE, CREATE ON SCHEMA ${db.schema} TO ${owner}`);
    await db.client.query(`DO $own$ DECLARE r record; BEGIN
      FOR r IN SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p') LOOP
        EXECUTE format('ALTER TABLE %I OWNER TO ${owner}', r.relname);
      END LOOP; END $own$`);
    // tags だけ別のロールの持ち物にする（読めるが ALTER できない表）
    await db.client.query(`ALTER TABLE tags OWNER TO ${other}; GRANT SELECT ON tags TO ${owner}`);
    await db.client.query(`SET ROLE ${owner}`);
    const before = await snapshot(db);
    await assert.rejects(applyDelta({ client: db.client, delta }), causeIs('not_owner'));
    assert.deepEqual(definitionDiff(before, await snapshot(db)), [], 'not_owner で止まったら何も変わらない');
    await db.client.query('RESET ROLE');
    await db.client.query(`GRANT ${other} TO ${owner}`);
    await db.client.query(`SET ROLE ${owner}`);
    assert.equal((await applyDelta({ client: db.client, delta })).state, 'applied', '持ち主のロールの一員なら当たる');
    assert.equal((await readDbFingerprint(db.client)).last_migration, '0004_stages.sql');
  } finally {
    await db.client.query('RESET ROLE');
    await db.client.query(`REASSIGN OWNED BY ${owner}, ${other} TO CURRENT_USER`);
    await db.client.query(`DROP OWNED BY ${owner}, ${other}`);
    await db.client.query(`DROP ROLE ${owner}, ${other}`);
  }
});

// ---------- 終わりの確かめ・版の印の書き換え ----------

test('差分の (6) の前に余計な索引を足すと、終わりの確かめが catalog_mismatch_after で止め、何も残らない', async (t) => {
  const { db, delta } = await baseDb(t, deltaDir, { rows: FICTIONAL_ROWS });
  const before = await snapshot(db);
  assert.equal(delta.sql.split('-- (6)').length, 2);
  const extra = { ...delta, sql: delta.sql.replace('-- (6)', 'CREATE INDEX extra_after_probe_idx ON items (amount_yen);\n-- (6)') };
  await assert.rejects(applyDelta({ client: db.client, delta: extra }), causeIs('catalog_mismatch_after'));
  assert.deepEqual(definitionDiff(before, await snapshot(db)), []);
});

test('版の印の更新を捨てるトリガーがあると、版の印の書き換えが fingerprint_not_updated で止め、何も残らない', async (t) => {
  const { db, delta } = await baseDb(t, deltaDir, { rows: FICTIONAL_ROWS });
  // 関数は別の schema に置く（いまの schema の関数の数を変えると、起点の確かめが先に catalog_mismatch で止める）。版の印の表のトリガーは数えない
  const probe = `s14probe_${process.pid}_${roleSeq += 1}`;
  t.after(() => db.client.query(`DROP SCHEMA IF EXISTS ${probe} CASCADE`).catch(() => {}));
  await db.client.query(`CREATE SCHEMA ${probe};
    CREATE FUNCTION ${probe}.skip_update() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END $fn$;
    CREATE TRIGGER fingerprint_skip_update BEFORE UPDATE ON schema_source_fingerprint FOR EACH ROW EXECUTE FUNCTION ${probe}.skip_update()`);
  const before = await snapshot(db);
  await assert.rejects(applyDelta({ client: db.client, delta }), causeIs('fingerprint_not_updated'));
  assert.deepEqual(definitionDiff(before, await snapshot(db)), []);
  assert.equal((await readDbFingerprint(db.client)).last_migration, BASE);
});

// ---------- (3) 途中で落ちる・(4) 2回目・(6) 外部キー・予行 ----------

test('途中の文で落ちると全部戻り（作った表・足した列も残らない）、版の印も元のまま', async (t) => {
  const dir = migrationDir({ '0004_fail.sql': FAIL_0004 });
  const { db } = await baseDb(t, dir, { rows: FICTIONAL_ROWS });
  const before = await snapshot(db);
  await assert.rejects(migrateDatabase({ client: db.client, dir, patches: [] }), causeIs('23505'));
  assert.deepEqual(definitionDiff(before, await snapshot(db)), []);
  assert.equal((await readDbFingerprint(db.client)).last_migration, BASE);
});

test('2回目は「当てるものが無い」で何も変えず、予行は全部を流してから ROLLBACK して何も変えない', async (t) => {
  const { db } = await baseDb(t, deltaDir, { rows: FICTIONAL_ROWS });
  const untouched = await snapshot(db);
  const dry = await migrateDatabase({ client: db.client, dir: deltaDir, patches: [], dryRun: true });
  assert.equal(dry.state, 'dry_run');
  assert.equal(dry.reconcile_equal, true);
  assert.deepEqual(dry.new_tables, { stages: 3, stage_events: 0 });
  assert.deepEqual(definitionDiff(untouched, await snapshot(db)), [], '予行のあとは元のまま');
  assert.equal((await migrateDatabase({ client: db.client, dir: deltaDir, patches: [] })).state, 'applied');
  const applied = await snapshot(db);
  assert.deepEqual(await migrateDatabase({ client: db.client, dir: deltaDir, patches: [] }), { state: 'current', from: '0004_stages.sql', to: '0004_stages.sql' });
  assert.deepEqual(definitionDiff(applied, await snapshot(db)), []);
});

test('既存の行から作った行が新しい外部キーに反する移行は、23503 で止まり全部戻る', async (t) => {
  const dir = migrationDir({ '0004_fk.sql': FK_0004 });
  const { db, delta } = await baseDb(t, dir, { rows: FICTIONAL_ROWS });
  // INSERT … SELECT の行の数は DB で決まるので、新しい表の行の数は照合しない（null）
  assert.deepEqual(delta.newTables, [{ table: 'item_kinds', rows: null, maxRows: null }]);
  const before = await snapshot(db);
  await assert.rejects(migrateDatabase({ client: db.client, dir, patches: [] }), causeIs('23503'));
  assert.deepEqual(definitionDiff(before, await snapshot(db)), []);
});

// ---------- (5) 照合 ----------

test('元の表の件数と金額は変わらず、新しい表の行の数は移行が入れる数で、既存の IDENTITY の表は入れた ID の次から振る', async (t) => {
  const { db, delta } = await baseDb(t, deltaDir, { rows: FICTIONAL_ROWS });
  const reconcile = async () => (await db.client.query(delta.base.reconcile)).rows.map((r) => ({ table_name: r.table_name, row_count: String(r.row_count), money_sums: r.money_sums }));
  const before = await reconcile();
  const result = await migrateDatabase({ client: db.client, dir: deltaDir, patches: [] });
  assert.equal(result.reconcile_equal, true);
  assert.equal(result.reconcile_tables, before.length - 1, '新しい節が INSERT する既存の表（orgs）は、件数が増える表として別に見る');
  const afterRows = await reconcile();
  const others = (rows) => rows.filter((r) => r.table_name !== 'orgs');
  assert.deepEqual(compareReconciliation(others(before), others(afterRows)), { equal: true, differences: [] });
  const orgs = (rows) => rows.find((r) => r.table_name === 'orgs');
  assert.deepEqual([orgs(before).row_count, orgs(afterRows).row_count, orgs(afterRows).money_sums], ['2', '3', orgs(before).money_sums]);
  assert.deepEqual((await db.client.query('SELECT count(*)::int AS n FROM stages')).rows, [{ n: 3 }]);
  assert.deepEqual((await db.client.query("SELECT DISTINCT status FROM items")).rows, [{ status: 'open' }], '既定値つきの列は既存の行にも既定値が入る');
  assert.deepEqual((await db.client.query("INSERT INTO orgs(code) VALUES ('DEMO-NEXT') RETURNING id")).rows, [{ id: '1001' }]);
  assert.deepEqual((await db.client.query("INSERT INTO stages(code, label) VALUES ('s4', '架空の段階4') RETURNING id")).rows, [{ id: '4' }]);
  await assert.rejects(db.client.query('UPDATE items SET stage_id = 99 WHERE id = 1'), /unknown stage/, '既存の表へのトリガーが効く');
});

test('照合の SQL は、元の表の件数か金額が変わったら reconcile_mismatch、新しい表の行の数が違えば new_table_rows で止まり、全部戻る', async (t) => {
  for (const [cause, tamper] of [['reconcile_mismatch', 'UPDATE items SET amount_yen = amount_yen + 1 WHERE id = 1;'], ['new_table_rows', "INSERT INTO stages(id, code, label) VALUES (9, 's9', '余計な架空の段階');"]]) {
    const { db, delta } = await baseDb(t, deltaDir, { rows: FICTIONAL_ROWS });
    const before = await snapshot(db);
    // 差分の SQL の最後に、元の表の金額か新しい表の行を変える文を足したものを当てる（移行が黙って行を変えた形）
    await assert.rejects(applyDelta({ client: db.client, delta: { ...delta, sql: `${delta.sql}\n${tamper}\n` } }), causeIs(cause), cause);
    assert.deepEqual(definitionDiff(before, await snapshot(db)), [], cause);
  }
});

test('既存の表への INSERT OR IGNORE は「前以上、前＋VALUES の行の数以下」、INSERT … SELECT は「前以上」で照合し、外れたら reconcile_mismatch で止まる', async (t) => {
  const dir = migrationDir({ '0004_loose.sql': `INSERT OR IGNORE INTO kinds(code,label) VALUES ('a','重なる架空の種類'),('c','架空の種類C');
INSERT INTO tags(code,label) SELECT 'k-'||code, label FROM kinds;
CREATE TABLE codes (code TEXT PRIMARY KEY);
INSERT OR IGNORE INTO codes(code) VALUES ('x'),('x'),('y');
` });
  const plan = convertDelta({ dir, patches: [], from: BASE });
  assert.deepEqual(plan.changedTables, [{ table: 'kinds', rows: null, maxRows: 2 }, { table: 'tags', rows: null, maxRows: null }]);
  assert.deepEqual(plan.newTables, [{ table: 'codes', rows: null, maxRows: 3 }]);
  const { db } = await baseDb(t, dir, { rows: FICTIONAL_ROWS });
  const result = await migrateDatabase({ client: db.client, dir, patches: [] });
  assert.deepEqual([result.state, result.new_tables], ['applied', { codes: 2 }]);
  for (const [label, tamper] of [['前より減る', 'DELETE FROM tags WHERE code NOT IN (SELECT tag_code FROM item_tags);'], ['上限を超える', "INSERT INTO kinds(code,label) VALUES ('d','架空D'),('e','架空E');"], ['新しい表が上限を超える', "INSERT INTO codes(code) VALUES ('p'),('q');"]]) {
    // 札を1つ足しておく（参照されていない札と、差分が入れた札を消すと、前より減る）
    const again = await baseDb(t, dir, { rows: `${FICTIONAL_ROWS}\nINSERT INTO tags(code, label) VALUES ('t2', '架空の札2');` });
    const before = await snapshot(again.db);
    const cause = label.startsWith('新しい表') ? 'new_table_rows' : 'reconcile_mismatch';
    await assert.rejects(applyDelta({ client: again.db.client, delta: { ...again.delta, sql: `${again.delta.sql}\n${tamper}\n` } }), causeIs(cause), label);
    assert.deepEqual(definitionDiff(before, await snapshot(again.db)), [], label);
  }
});

// ---------- (7) 変換できない文・手直し ----------

test('変換できない文を含む移行は、接続する前に止まる（plan・apply とも）', async () => {
  const dir = migrationDir({ '0004_stop.sql': 'ALTER TABLE items RENAME TO goods;\n' });
  assert.throws(() => convertDelta({ dir, patches: [], from: BASE }), (error) => error instanceof DeltaError && error.code === 'convert_failed');
  for (const argv of [['apply'], ['plan', '--from', BASE, '--out', join(dir, 'plan')]]) {
    const out = [];
    const err = [];
    let opened = false;
    const code = await migrateCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), dir, patches: [], open: async () => { opened = true; throw new Error('接続しない'); } });
    assert.equal(code, 1, argv.join(' '));
    assert.equal(opened, false, `${argv[0]} は接続しない`);
    assert.deepEqual(err, ['{"event":"pg_migrate_failed","cause":"convert_failed"}']);
    assert.deepEqual(out, []);
  }
});

test('起点より後ろの移行の手直しは、起点の変換で使われないので差分を作らずに止まる（手直しを変えると差分で上げられない）', () => {
  const patch = { trigger: 'items_stage_known', why: '架空の手直し', find: 'NEW.stage_id IS NOT NULL', replace: 'NEW.stage_id IS NOT NULL' };
  assert.deepEqual(convertMigrations({ dir: deltaDir, patches: [patch] }).errors, []);
  assert.throws(() => convertDelta({ dir: deltaDir, patches: [patch], from: BASE }), (error) => error instanceof DeltaError && error.code === 'convert_failed' && /使われなかった/.test(error.detail));
});

// ---------- (8) ロック待ち（本物の PostgreSQL だけ） ----------

test('別の接続が表を押さえているあいだは lock_timeout（55P03）で止まり、何も変わらない（本物の PostgreSQL の2つの接続）', { skip: process.env.ON_TEST_PG_URL ? false : 'PGlite は接続が1つなので、別の接続でロックを持てない（CI の postgres:18.6-alpine で流す）' }, async (t) => {
  const delta = convertDelta({ dir: deltaDir, patches: [], from: BASE, lockTimeoutMs: 300 });
  const db = await openDb(t, delta.base.sql);
  await db.client.query(FICTIONAL_ROWS);
  const before = await snapshot(db);
  const other = await db.pool().connect();
  try {
    await other.query('BEGIN');
    await other.query('LOCK TABLE items IN SHARE MODE');
    const started = Date.now();
    await assert.rejects(applyDelta({ client: db.client, delta, options: { lockTimeoutMs: 300 } }), causeIs('55P03'));
    assert.ok(Date.now() - started < 20000, 'ロック待ちは lock_timeout で切れる');
  } finally {
    await other.query('ROLLBACK');
    other.release();
  }
  assert.deepEqual(definitionDiff(before, await snapshot(db)), []);
  assert.equal((await migrateDatabase({ client: db.client, dir: deltaDir, patches: [] })).state, 'applied', 'ロックが外れれば当たる');
});

const twoConnections = { skip: process.env.ON_TEST_PG_URL ? false : 'PGlite は接続が1つなので、別の接続を持てない（CI の postgres:18.6-alpine で流す）' };

test('別の接続が既存の IDENTITY の表（orgs）に未コミットの INSERT を持つあいだは、照合の前の EXCLUSIVE のロック待ちが 55P03 で止まり何も変わらない（本物の PostgreSQL の2つの接続）', twoConnections, async (t) => {
  const delta = convertDelta({ dir: deltaDir, patches: [], from: BASE, lockTimeoutMs: 300 });
  const db = await openDb(t, delta.base.sql);
  await db.client.query(FICTIONAL_ROWS);
  const before = await snapshot(db, false);
  const other = await db.pool().connect();
  try {
    await other.query('BEGIN');
    await other.query("INSERT INTO orgs (id, code) VALUES (7000, 'DEMO-HOLD')");
    await assert.rejects(applyDelta({ client: db.client, delta, options: { lockTimeoutMs: 300 } }), causeIs('55P03'));
  } finally {
    await other.query('ROLLBACK');
    other.release();
  }
  // 別の接続の INSERT が使った番号は戻らないので、シーケンスの今の値は比べない
  assert.deepEqual(definitionDiff(before, await snapshot(db, false)), []);
  assert.equal((await readDbFingerprint(db.client)).last_migration, BASE);
});

test('既存の IDENTITY の表の次の値は、照合の前より先にコミットされた行まで数え、照合の前のあとは別の接続の INSERT を通さない（本物の PostgreSQL の2つの接続）', twoConnections, async (t) => {
  const delta = convertDelta({ dir: deltaDir, patches: [], from: BASE });
  const db = await openDb(t, delta.base.sql);
  await db.client.query(FICTIONAL_ROWS);
  const other = await db.pool().connect();
  try {
    // 照合の前より先にコミットされた ID 5000 は、差分の (5) の MAX に入る
    await other.query("INSERT INTO orgs (id, code) VALUES (5000, 'DEMO-EARLY')");
    const checks = checkSql(delta);
    await db.client.query('BEGIN');
    await db.client.query(checks.before);
    // 照合の前（REPEATABLE READ の最初の読み）のあとは、別の接続が既存の表に行を入れられない（入れられると MAX が古い時点の値になる）
    await other.query("SET lock_timeout = '300ms'");
    await assert.rejects(other.query("INSERT INTO orgs (id, code) VALUES (6000, 'DEMO-LATE')"), (error) => error.code === '55P03');
    await db.client.query(delta.sql);
    await db.client.query(checks.after);
    await db.client.query('COMMIT');
  } catch (error) {
    await db.client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    other.release();
  }
  assert.deepEqual((await db.client.query("INSERT INTO orgs (code) VALUES ('DEMO-NEXT') RETURNING id")).rows, [{ id: '5001' }]);
});

test('2つの接続で同時に当てると片方だけが当たり（版の印の行の FOR UPDATE と表のロック）、もう片方は何も残さずに止まる（本物の PostgreSQL の2つの接続）', twoConnections, async (t) => {
  // 既存の表に INSERT しない移行（照合の前の EXCLUSIVE が無く、差分の (2) の FOR UPDATE が二重の適用を止める）
  const dir = migrationDir({ '0004_plain.sql': "CREATE TABLE stages (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE);\nINSERT INTO stages(id,code) VALUES (1,'s1'),(2,'s2');\nALTER TABLE items ADD COLUMN note TEXT;\n" });
  const delta = convertDelta({ dir, patches: [], from: BASE });
  assert.deepEqual(delta.changedTables, []);
  const db = await openDb(t, delta.base.sql);
  await db.client.query(FICTIONAL_ROWS);
  const other = await db.pool().connect();
  let results;
  try {
    results = await Promise.allSettled([applyDelta({ client: db.client, delta }), applyDelta({ client: other, delta })]);
  } finally {
    other.release();
  }
  const applied = results.filter((r) => r.status === 'fulfilled');
  const stopped = results.filter((r) => r.status === 'rejected');
  assert.equal(applied.length, 1, JSON.stringify(results.map((r) => r.status === 'rejected' ? migrateFailureCause(r.reason) : r.value.state)));
  // 止まり方は、待った先で版の印が変わっていた（RR の 40001・base_mismatch）か、照合の前の読みと ALTER のロックの行き違い（40P01）か、ロック待ち（55P03）
  assert.ok(['40001', '40P01', 'base_mismatch', '55P03'].includes(migrateFailureCause(stopped[0].reason)), migrateFailureCause(stopped[0].reason));
  const full = await fullDb(t, dir);
  // 架空の行は全体の DB に無いので、行とシーケンスの今の値は比べない
  assert.deepEqual(definitionDiff(await snapshot(full, false), await snapshot(db, false)), [], '当たったのは1回だけで、新しい全体と同じ');
});

// ---------- (9) psql の -1 の経路（本物の PostgreSQL と psql があるときだけ） ----------

const psqlReady = Boolean(process.env.ON_TEST_PG_URL) && spawnSync('psql', ['--version'], { encoding: 'utf8' }).status === 0;
test('psql の -1 で同じファイル（check-before・delta・check-after）を当てると node と同じ定義になり、止まるときは RAISE の固定の語と SQLSTATE が出る', { skip: psqlReady ? false : 'psql と本物の PostgreSQL（ON_TEST_PG_URL）が要る（CI の integrated-postgres で流す）' }, async (t) => {
  const files = planFiles(convertDelta({ dir: deltaDir, patches: [], from: BASE }));
  const work = mkdtempSync(join(tmpdir(), 'pg-migrate-psql-'));
  dirs.push(work);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
  const psql = (schema) => spawnSync('psql', ['-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-v', 'SHOW_CONTEXT=never', '-1',
    '-f', join(work, 'check-before.sql'), '-f', join(work, 'delta.sql'), '-f', join(work, 'check-after.sql'), process.env.ON_TEST_PG_URL],
  { encoding: 'utf8', env: { ...process.env, PGOPTIONS: `-c search_path=${schema}` } });
  const viaPsql = await openDb(t, files['base-schema.sql']);
  await viaPsql.client.query(FICTIONAL_ROWS);
  const run = psql(viaPsql.schema);
  assert.equal(run.status, 0, run.stderr);
  const lines = outputLines(run.stdout.split(/\r?\n/));
  assert.deepEqual(JSON.parse(lines.new_tables), { stages: 3, stage_events: 0 });
  assert.deepEqual(compareReconciliation(JSON.parse(lines.reconcile_before), JSON.parse(lines.reconcile_after)), { equal: true, differences: [] });
  const viaNode = await openDb(t, files['base-schema.sql']);
  await viaNode.client.query(FICTIONAL_ROWS);
  await migrateDatabase({ client: viaNode.client, dir: deltaDir, patches: [] });
  // 作った時刻の列は除いて行を比べる（scripts/pg-definition.mjs）。シーケンスの今の値も同じ
  assert.deepEqual(definitionDiff(await snapshot(viaNode), await snapshot(viaPsql)), []);
  // 2回目（版の印が新しい）は、起点の確かめが base_mismatch で止め、psql は 3 で終わる
  const again = psql(viaPsql.schema);
  assert.equal(again.status, 3);
  assert.match(again.stderr, /ERROR:\s+P0001: base_mismatch/);
});

// ---------- (10) 実際の移行 ----------

const realFiles = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
for (const from of [...new Set(['0011_cloud_analytics.sql', realFiles.at(-2)])]) {
  test(`実際の移行: ${from} を起点に ${realFiles.at(-1)} まで差分で当てた DB は、新しい全体の pg/schema.sql の DB と定義が一致する（差分に載らない移行を足すと落ちる）`, async (t) => {
    const delta = convertDelta({ from });
    assert.equal(delta.state, 'delta');
    const db = await openDb(t, delta.base.sql);
    const result = await migrateDatabase({ client: db.client });
    assert.equal(result.state, 'applied');
    assert.equal(result.reconcile_equal, true);
    assert.deepEqual(result.new_tables, result.expected_new_tables);
    const full = await openPgClient({ applySchema: true });
    t.after(() => full.close());
    assert.deepEqual(definitionDiff(await snapshot(full), await snapshot(db)), []);
  });
}

test('0011 を起点にした差分は、移行0012・0013 の新しい表に移行の正解どおりの行を入れる（earning_types 5・action_steps 3・project_stages 11・ほかは0）', () => {
  // 終わりを 0013 に決める（後に積む移行で新しい表が増えても、この正解は変わらない）
  const delta = convertDelta({ from: '0011_cloud_analytics.sql', until: '0013_contract_production_versions.sql' });
  assert.equal(delta.to, '0013_contract_production_versions.sql');
  assert.deepEqual(Object.fromEntries(delta.newTables.map(({ table, rows }) => [table, rows])), {
    earning_types: 5, action_steps: 3, project_stages: 11, project_stage_meanings: 0, project_stage_events: 0, earning_type_rate_versions: 0, cashflow_categories: 0,
    contract_production_versions: 0, contract_production_milestones: 0,
  });
  assert.deepEqual(delta.changedTables, []);
  // 起点の全体は、0011 までの版の印（表258・トリガー540・関数199・IDENTITY137・FK628・索引125）を持つ
  assert.deepEqual(delta.base.fingerprint.expected, { tables: 258, triggers: 540, functions: 199, identities: 137, foreignKeys: 628, indexes: 125 });
  assert.match(delta.sql, /^SET LOCAL lock_timeout = '5000ms';$/m);
  assert.doesNotMatch(delta.sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im, '差分に BEGIN・COMMIT を入れない');
});

// ---------- 節の指紋・起点の決め方・原因の種類 ----------

test('pg/ddl-sections.json は生成物と一致し、節の指紋の比べは既存の節の変化・消失・補助関数と手直しの変化を見つけ、新しい節が増えるだけなら通す', () => {
  const ledger = sectionLedger();
  assert.equal(lf(readFileSync(SECTIONS_PATH, 'utf8')), ledgerJson(ledger), 'node scripts/pg-ddl.mjs で作り直してコミットする');
  assert.deepEqual(ledger.sections.map((s) => s.file), realFiles);
  // 各節は、その移行までで変換した全体の版の印を持つ（0011 は main の版。最後は全体の pg/schema.sql の版）
  assert.deepEqual(ledger.sections.find((s) => s.file === '0011_cloud_analytics.sql').fingerprint, convertDelta({ from: '0011_cloud_analytics.sql' }).fromRow);
  assert.deepEqual(ledger.sections.at(-1).fingerprint, fingerprintRow(convertMigrations().fingerprint));
  // 0003 の手直しが使われない 0001・0002 までの版は、差分の起点にできないので null
  assert.deepEqual(ledger.sections.slice(0, 2).map((s) => s.fingerprint), [null, null]);
  const previous = { ...ledger, sections: ledger.sections.slice(0, -1) };
  assert.deepEqual(compareSectionLedgers(previous, ledger), [], '新しい節が増えるだけなら通す');
  assert.deepEqual(compareSectionLedgers(ledger, ledger), []);
  const edited = { ...ledger, sections: ledger.sections.map((s, k) => (k === 2 ? { ...s, sha256: '0'.repeat(64) } : s)) };
  assert.deepEqual(compareSectionLedgers(edited, ledger), [`既存の節が変わった: ${realFiles[2]}`]);
  assert.deepEqual(compareSectionLedgers({ ...ledger, sections: [...ledger.sections, { file: '9999_gone.sql', sha256: '1'.repeat(64) }] }, ledger), ['既存の節が消えた: 9999_gone.sql']);
  assert.equal(compareSectionLedgers({ ...ledger, helpers_sha256: '2'.repeat(64) }, ledger).length, 1);
  assert.equal(compareSectionLedgers({ ...ledger, patches_sha256: '3'.repeat(64) }, ledger).length, 1);
  // 架空の移行で、節の中身を変えると指紋が変わる
  const a = sectionLedger({ dir: deltaDir, patches: [] });
  const b = sectionLedger({ dir: migrationDir({ '0004_stages.sql': DELTA_0004.replace("'open'", "'closed'") }), patches: [] });
  assert.deepEqual(compareSectionLedgers(a, b), ['既存の節が変わった: 0004_stages.sql']);
  // 節の中の文が同じでも、節の外の文（ここでは見出しの注釈。アプリの DDL の行）が変わると、どの版の印も変わる。CI の比べが落ち、
  // 配備済みの DB が base_mismatch になる前に見つかる
  const header = sectionLedger({ dir: deltaDir, patches: [], appSources: [{ name: 'fictional-app.sql', sql: 'CREATE TABLE IF NOT EXISTS app_probe (id INTEGER PRIMARY KEY);' }] });
  assert.deepEqual(header.sections.slice(0, 4).map((s) => s.sha256), a.sections.map((s) => s.sha256), '節の中の文は同じ');
  const headerProblems = compareSectionLedgers(a, header);
  assert.deepEqual(headerProblems.map((line) => line.split('（')[0]), a.sections.map((s) => `既存の版の印が変わった: ${s.file}`));
  assert.ok(headerProblems.every((line) => line.includes('ddl_sha256')), headerProblems.join(' / '));
  const edited2 = { ...ledger, sections: ledger.sections.map((s, k) => (k === 10 ? { ...s, fingerprint: { ...s.fingerprint, ddl_sha256: '4'.repeat(64) } } : s)) };
  assert.deepEqual(compareSectionLedgers(edited2, ledger), [`既存の版の印が変わった: ${realFiles[10]}（ddl_sha256。その版の DB は差分の起点にできない）`]);
});

test('版の印の行から起点を決める: 全体と同じなら当てるものが無い、作業場に無い移行は database_ahead、12の列が違えば base_mismatch、形が違えば invalid_fingerprint', () => {
  const fullRow = fingerprintRow(convertMigrations({ dir: deltaDir, patches: [] }).fingerprint);
  const baseRow = convertDelta({ dir: deltaDir, patches: [], from: BASE }).fromRow;
  const plan = (row) => planFromFingerprint(row, { dir: deltaDir, patches: [] });
  assert.equal(plan(fullRow).state, 'current');
  assert.equal(plan(baseRow).state, 'delta');
  // 世代の manifest（schema に版の印の行。singleton も持つ）からも決められる
  assert.equal(plan({ format: 'x', schema: { singleton: 'true', ...baseRow } }).from, BASE);
  // 数は数字でも文字でも同じ
  assert.equal(plan({ ...baseRow, expected_tables: Number(baseRow.expected_tables) }).state, 'delta');
  assert.throws(() => plan({ ...baseRow, last_migration: '0099_later.sql' }), causeIs('database_ahead'));
  assert.throws(() => plan({ ...baseRow, ddl_sha256: 'f'.repeat(64) }), causeIs('base_mismatch'));
  assert.throws(() => plan({ ...fullRow, expected_indexes: '99' }), causeIs('base_mismatch'));
  for (const bad of [null, [], { ...baseRow, ddl_sha256: 'xyz' }, { ...baseRow, expected_tables: '-1' }, { ...baseRow, last_migration: '../x.sql' }, { generator: 'pg-ddl 1' }]) {
    assert.throws(() => plan(bad), causeIs('invalid_fingerprint'), JSON.stringify(bad));
  }
});

test('失敗の原因の種類は、道具の許可リストの語・RAISE の固定の語・SQLSTATE・unexpected だけで、文の値を出さない', async () => {
  const withCode = (code, message = 'fictional-private-value') => Object.assign(new Error(message), { code });
  assert.equal(migrateFailureCause(migrateError('base_mismatch')), 'base_mismatch');
  assert.equal(migrateFailureCause(migrateError('fictional_unlisted')), 'unexpected');
  assert.equal(migrateFailureCause(new DeltaError('sections_changed', '架空の詳細')), 'sections_changed');
  for (const word of ['no_fingerprint', 'base_mismatch', 'catalog_mismatch', 'not_owner', 'fingerprint_not_updated', 'catalog_mismatch_after', 'reconcile_mismatch', 'new_table_rows']) {
    assert.equal(migrateFailureCause(withCode('P0001', word)), word);
  }
  assert.equal(migrateFailureCause(withCode('P0001', 'project earning type does not match project type')), 'P0001', '移行のトリガーの文は出さない');
  for (const code of ['55P03', '42501', '23503', '23514']) assert.equal(migrateFailureCause(withCode(code)), code);
  for (const value of [withCode('ENOENT'), withCode(undefined), null, 'fictional-private-value']) assert.equal(migrateFailureCause(value), 'unexpected');
  const err = [];
  assert.equal(await migrateCli(['plan'], { out: () => {}, err: (l) => err.push(l) }), 1);
  assert.deepEqual(err, ['{"event":"pg_migrate_failed","cause":"invalid_arguments"}']);
});

test('ps1（pg-staging.ps1・pg-drill-migrate.ps1）が拾う RAISE の固定の語は、差分の SQL と照合の SQL の語（DELTA_RAISE_WORDS・CHECK_RAISE_WORDS）と同じ', () => {
  const expected = [...DELTA_RAISE_WORDS, ...CHECK_RAISE_WORDS].sort();
  for (const name of ['pg-staging.ps1', 'pg-drill-migrate.ps1']) {
    const text = readFileSync(join(MIGRATIONS_DIR, '..', 'scripts', name), 'utf8');
    const listed = /\$migrateWords = @\(([^)]*)\)/.exec(text);
    assert.ok(listed, `${name} に $migrateWords がある`);
    assert.deepEqual([...listed[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(), expected, name);
  }
});

test('plan は起点の schema.sql・reconcile.sql・差分・照合と plan.json を書き、起点の schema.sql は起点までの変換とバイトで同じ', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pg-migrate-plan-'));
  dirs.push(work);
  const fingerprint = join(work, 'fingerprint.json');
  writeFileSync(fingerprint, JSON.stringify(convertDelta({ dir: deltaDir, patches: [], from: BASE }).fromRow));
  const out = [];
  assert.equal(await migrateCli(['plan', '--fingerprint', fingerprint, '--out', join(work, 'plan')], { out: (l) => out.push(l), err: (l) => assert.fail(l), dir: deltaDir, patches: [] }), 0);
  const summary = JSON.parse(out[0]);
  assert.deepEqual([summary.state, summary.from, summary.to, summary.new_tables, summary.changed_tables], ['delta', BASE, '0004_stages.sql', { stages: 3, stage_events: 0 }, { orgs: 1 }]);
  assert.deepEqual(readdirSync(join(work, 'plan')).sort(), ['base-reconcile.sql', 'base-schema.sql', 'check-after.sql', 'check-before.sql', 'delta.sql', 'plan.json']);
  assert.equal(readFileSync(join(work, 'plan', 'base-schema.sql'), 'utf8'), convertMigrations({ dir: deltaDir, patches: [], until: BASE }).sql);
  const checks = checkSql(convertDelta({ dir: deltaDir, patches: [], from: BASE }));
  assert.equal(readFileSync(join(work, 'plan', 'check-after.sql'), 'utf8'), checks.after);
  assert.match(checks.before, /^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;$/m);
  // 当てるものが無い版の印では、ファイルを書かずに current を返す
  const current = join(work, 'current.json');
  writeFileSync(current, JSON.stringify(fingerprintRow(convertMigrations({ dir: deltaDir, patches: [] }).fingerprint)));
  const out2 = [];
  assert.equal(await migrateCli(['status', '--fingerprint', current], { out: (l) => out2.push(l), err: (l) => assert.fail(l), dir: deltaDir, patches: [] }), 0);
  assert.deepEqual(JSON.parse(out2[0]), { state: 'current', from: '0004_stages.sql', to: '0004_stages.sql' });
});
