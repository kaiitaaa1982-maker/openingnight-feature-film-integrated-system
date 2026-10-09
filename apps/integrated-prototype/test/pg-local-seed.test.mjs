// 試験の DB の土台（pg/schema.sql と pg/local-seed.sql）の行が、手元の SQLite（LocalDatabase）の試作・初期の行と一致するか（香盤表 #11）。
// PostgreSQL は試験の DB のファクトリ（test/test-db.mjs）で開く（ON_TEST_PG_URL があれば手元の PostgreSQL、無ければ PGlite）。架空のデータだけ。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalDatabase } from '../src/db.mjs';
import { SEED_PATH, convertLocalSeed, convertMigrations, lf } from '../scripts/pg-ddl.mjs';
import { openTestDb } from './test-db.mjs';

test('pg/local-seed.sql は src/*.sql の INSERT から生成したものと一致する（node scripts/pg-ddl.mjs --check の対象）', () => {
  const { identities } = convertMigrations();
  const seed = convertLocalSeed({ identities });
  assert.deepEqual(seed.errors, []);
  assert.equal(lf(readFileSync(SEED_PATH, 'utf8')), seed.sql, 'node scripts/pg-ddl.mjs で作り直してコミットする');
});

// 表ごとの行を、比べられる形（列の名前で並べた値の文字。時刻の既定値の列は除く）にして並べ替える
function normalize(rows, skip) {
  return rows.map((row) => JSON.stringify(Object.keys(row).filter((k) => !skip.has(k)).sort().map((k) => [k, row[k] === null ? null : String(row[k])]))).sort();
}

test('土台の行（DDL の初期の行と試作の行）が、表ごとに SQLite の LocalDatabase と一致する', async (t) => {
  const lite = new LocalDatabase(':memory:');
  t.after(() => lite.close());
  const pg = await openTestDb({ t, kind: 'pg' });
  const tables = lite.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.ok(tables.length > 200, `表の数 ${tables.length}`);
  const differ = [];
  let filled = 0;
  for (const table of tables) {
    // 時刻の既定値（CURRENT_TIMESTAMP）は入れた時刻なので比べない
    const skip = new Set(lite.raw.prepare(`PRAGMA table_info("${table}")`).all().filter((c) => /CURRENT_TIMESTAMP|datetime\(|strftime\(/i.test(String(c.dflt_value ?? ''))).map((c) => c.name));
    const left = normalize(lite.raw.prepare(`SELECT * FROM "${table}"`).all(), skip);
    const right = normalize(await pg.all(`SELECT * FROM "${table}"`), skip);
    if (left.length) filled += 1;
    if (JSON.stringify(left) !== JSON.stringify(right)) differ.push(`${table}: SQLite ${left.length} 行・PostgreSQL ${right.length} 行`);
  }
  assert.deepEqual(differ, []);
  assert.ok(filled >= 15, `行のある表 ${filled}`);
});

test('土台の IDENTITY は試作の行のあとに進めてあり、ID を渡さない INSERT が既存の行とぶつからない', async (t) => {
  const pg = await openTestDb({ t, kind: 'pg' });
  const row = await pg.get("INSERT INTO organizations(code, name) VALUES ('seed-next', '架空の組織') RETURNING id");
  const max = await pg.get("SELECT max(id) AS m FROM organizations WHERE code <> 'seed-next'");
  assert.ok(row.id > max.m, `${row.id} > ${max.m}`);
});

test('土台は試験ごとに別の DB で、ある試験の書き込みは次に開いた DB に残らない', async (t) => {
  const first = await openTestDb({ t, kind: 'pg' });
  await first.run("INSERT INTO partners(org_id, code, name, kind) VALUES (1, 'SEED-ISO', '架空の取引先', 'other')");
  assert.equal((await first.get("SELECT count(*) AS n FROM partners WHERE code = 'SEED-ISO'")).n, 1);
  await first.close();
  const second = await openTestDb({ t, kind: 'pg' });
  assert.equal((await second.get("SELECT count(*) AS n FROM partners WHERE code = 'SEED-ISO'")).n, 0);
});

test('ファクトリは ON_TEST_DB で DB を選ぶ（既定は SQLite の LocalDatabase、pg は PostgreSQL の入口）。知らない値は止める', async (t) => {
  const saved = process.env.ON_TEST_DB;
  t.after(() => { if (saved === undefined) delete process.env.ON_TEST_DB; else process.env.ON_TEST_DB = saved; });
  delete process.env.ON_TEST_DB;
  const lite = await openTestDb({ t });
  assert.equal(lite.kind, 'sqlite');
  assert.ok(lite instanceof LocalDatabase);
  process.env.ON_TEST_DB = 'pg';
  const pg = await openTestDb({ t });
  assert.equal(pg.kind, 'pg');
  assert.match((await pg.get("SELECT current_setting('server_version_num') AS v")).v, /^18\d{4}$/);
  process.env.ON_TEST_DB = 'mysql';
  await assert.rejects(openTestDb({ t }), /ON_TEST_DB は sqlite・pg のどれか/);
});
