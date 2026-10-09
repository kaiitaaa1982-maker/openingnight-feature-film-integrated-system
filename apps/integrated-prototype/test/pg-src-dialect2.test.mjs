// アプリの SQL の方言2（PG 計画 段1・香盤表 #11 の PR4。FR-CORE-DATA-025）を、SQLite（LocalDatabase）と PostgreSQL（PgDatabase。
// 既定は PGlite、ON_TEST_PG_URL があれば手元の PostgreSQL）の両方で流し、同じ結果になるかを確かめる。
// - x IS ?・x IS NOT ? は PostgreSQL の入口が IS NOT DISTINCT FROM・IS DISTINCT FROM に読み替える。? IS NULL は値の置き場所を text にする
// - 別名の大文字・小文字（EXISTS(…) isSuperseded・AS N）は、PostgreSQL の入口が SQLite と同じ書き方の名前で返す
// - ON CONFLICT … DO UPDATE SET の右辺の列は表の名前つきで書く（version=production_revisions.version+1）
// 試験の DB はファクトリ（test/test-db.mjs）で両方を明示して開く。架空のデータだけを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './test-db.mjs';
import { columnSpellings, rewriteLite, toPositional } from '../src/data-platform/pg-db.mjs';

const KINDS = ['sqlite', 'pg'];
const PROBE = {
  sqlite: 'CREATE TABLE dialect_probe2 (id INTEGER PRIMARY KEY, n INTEGER, t TEXT)',
  pg: 'CREATE TABLE dialect_probe2 (id bigint PRIMARY KEY, n bigint, t text COLLATE "C")',
};
const plain = (value) => JSON.parse(JSON.stringify(value));
// 両方の DB で同じ手順を流し、同じ結果になることを確かめて、その結果を返す
async function same(t, fn) {
  const out = {};
  for (const kind of KINDS) {
    const db = await openTestDb({ t, kind });
    await db.run(PROBE[kind]);
    await db.batch([
      { sql: 'INSERT INTO dialect_probe2(id,n,t) VALUES(?,?,?)', params: [1, null, 'a'] },
      { sql: 'INSERT INTO dialect_probe2(id,n,t) VALUES(?,?,?)', params: [2, 1, 'b'] },
      { sql: 'INSERT INTO dialect_probe2(id,n,t) VALUES(?,?,?)', params: [3, 2, null] },
    ]);
    out[kind] = plain(await fn(db));
  }
  assert.deepEqual(out.pg, out.sqlite, 'SQLite と PostgreSQL で結果が違う');
  return out.sqlite;
}
const pgText = (sql) => toPositional(rewriteLite(sql).text).text.replace(/\s+/g, ' ');

test('入口の読み替え: IS ? と IS NOT ? だけを IS [NOT] DISTINCT FROM にし、IS NULL・IS TRUE・IS DISTINCT FROM・文字列の中は変えない', () => {
  assert.equal(pgText('SELECT 1 FROM t WHERE a IS ? AND b IS NOT ?'), 'SELECT 1 FROM t WHERE a IS NOT DISTINCT FROM $1 AND b IS DISTINCT FROM $2');
  assert.equal(pgText('SELECT 1 FROM t WHERE a IS NULL AND b IS NOT NULL AND c IS TRUE AND d IS NOT DISTINCT FROM ? AND e IS FALSE'),
    'SELECT 1 FROM t WHERE a IS NULL AND b IS NOT NULL AND c IS TRUE AND d IS NOT DISTINCT FROM $1 AND e IS FALSE');
  assert.equal(pgText('SELECT 0 WHERE ? IS NOT (SELECT id FROM t LIMIT 1)'), 'SELECT 0 WHERE $1 IS DISTINCT FROM (SELECT id FROM t LIMIT 1)');
  assert.equal(pgText("SELECT 'a IS ?' AS s FROM t -- b IS ?"), "SELECT 'a IS ?' AS s FROM t -- b IS ?");
  // ? IS NULL は値の置き場所の型を決められないので text にする
  assert.equal(pgText('SELECT 1 FROM t WHERE (? IS NULL OR p=?) AND ? IS NOT NULL'), 'SELECT 1 FROM t WHERE (CAST($1 AS text) IS NULL OR p=$2) AND CAST($3 AS text) IS NOT NULL');
});

test('x IS ?・x IS NOT ? は、NULL どうしを等しいとみる比べ方で、両方の DB で同じ行を返す', async (t) => {
  const rows = await same(t, async (db) => {
    const ids = async (sql, params) => (await db.all(sql, params)).map((row) => Number(row.id));
    return {
      isNull: await ids('SELECT id FROM dialect_probe2 WHERE n IS ? ORDER BY id', [null]),
      isOne: await ids('SELECT id FROM dialect_probe2 WHERE n IS ? ORDER BY id', [1]),
      isNotNull: await ids('SELECT id FROM dialect_probe2 WHERE n IS NOT ? ORDER BY id', [null]),
      isNotOne: await ids('SELECT id FROM dialect_probe2 WHERE n IS NOT ? ORDER BY id', [1]),
      optionalAll: await ids('SELECT id FROM dialect_probe2 WHERE (? IS NULL OR n=?) ORDER BY id', [null, null]),
      optionalOne: await ids('SELECT id FROM dialect_probe2 WHERE (? IS NULL OR n=?) ORDER BY id', [2, 2]),
    };
  });
  assert.deepEqual(rows, { isNull: [1], isOne: [2], isNotNull: [2, 3], isNotOne: [1, 3], optionalAll: [1, 2, 3], optionalOne: [3] });
});

test('別名の大文字・小文字: 両方の DB で、SQL に書いたとおりの名前で返す（同じ名前を小文字でも書いた文は小文字のまま）', async (t) => {
  const rows = await same(t, async (db) => ({
    exists: await db.all('SELECT p.id, EXISTS(SELECT 1 FROM dialect_probe2 s WHERE s.n=p.id) isLinked FROM dialect_probe2 p ORDER BY p.id'),
    aliases: await db.get('SELECT COUNT(*) AS N, MAX(id) AS maxId, MIN(t) minLabel FROM dialect_probe2'),
    lower: await db.all('SELECT t AS count FROM dialect_probe2 WHERE t IS NOT NULL GROUP BY t ORDER BY COUNT(*), t'),
    quoted: await db.get('SELECT id AS "rowId" FROM dialect_probe2 WHERE id=?', [2]),
  }));
  assert.deepEqual(rows.exists, [{ id: 1, isLinked: 1 }, { id: 2, isLinked: 1 }, { id: 3, isLinked: 0 }]);
  assert.deepEqual(rows.aliases, { N: 3, maxId: 3, minLabel: 'a' });
  assert.deepEqual(rows.lower, [{ count: 'a' }, { count: 'b' }]);
  assert.deepEqual(rows.quoted, { rowId: 2 });
  assert.equal(columnSpellings(' SELECT x AS count FROM t ORDER BY COUNT(*) ').has('count'), false);
});

test('ON CONFLICT … DO UPDATE SET の右辺を表の名前つきで書くと、両方の DB で既にある行の値から数える（版・回数の繰り上げ）', async (t) => {
  const rows = await same(t, async (db) => {
    for (let k = 0; k < 3; k += 1) await db.run('INSERT INTO dialect_probe2(id,n) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET n=dialect_probe2.n+1', [3]);
    await db.run('INSERT INTO dialect_probe2(id,n) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET n=dialect_probe2.n+1', [4]);
    return db.all('SELECT id, n FROM dialect_probe2 WHERE id IN (3,4) ORDER BY id');
  });
  assert.deepEqual(rows, [{ id: 3, n: 5 }, { id: 4, n: 1 }]);
});
