// PostgreSQL（PGlite か手元の PostgreSQL）を開く道具と、SQLite・PostgreSQL の表の形を同じ形に写して比べる道具。
// test/pg-ddl.test.mjs が使う。架空のデータだけを使う。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APP_DDL_SOURCES, MIGRATIONS_DIR, isOp, splitTop, tokenize, tree, up } from '../scripts/pg-ddl.mjs';
import { PG_FINGERPRINT_TABLE } from '../src/data-platform/pg-fingerprint.mjs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export async function openPostgres() {
  const url = process.env.ON_TEST_PG_URL;
  const schema = `pgddl_${process.pid}_${Date.now()}`;
  if (url) {
    const { hostname } = new URL(url);
    if (!LOCAL_HOSTS.has(hostname)) throw new Error('ON_TEST_PG_URL は手元（localhost）の PostgreSQL だけを受け付ける');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    return {
      kind: 'postgres',
      exec: (sql) => client.query(sql),
      query: async (sql, params = []) => (await client.query(sql, params)).rows,
      close: async () => { await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end(); },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  return {
    kind: 'pglite',
    exec: (sql) => db.exec(sql),
    query: async (sql, params = []) => (await db.query(sql, params)).rows,
    close: () => db.close(),
  };
}

export function openSqlite() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  // pg/schema.sql は移行のあとにアプリの DDL（migrations/ の外でアプリが作る表。scripts/pg-ddl.mjs の APP_DDL_SOURCES）も変換するので、同じ順に当てる
  for (const { sql } of APP_DDL_SOURCES) db.exec(sql);
  return db;
}

// ---------- 表の形の写し（両方の DB を同じ形にそろえる） ----------

// SQLite の型の宣言 → PostgreSQL の型（変換の決まり。scripts/pg-ddl.mjs の冒頭）
const TYPE_MAP = { INTEGER: 'bigint', TEXT: 'text', REAL: 'double precision', '': 'numeric' };
const ACTION = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const q = (name) => `"${name.replaceAll('"', '""')}"`;
const sortJson = (list) => list.map((x) => JSON.stringify(x)).sort();

// CREATE TABLE の文の CHECK の数（列の CHECK と表の CHECK を合わせて）。PostgreSQL の pg_constraint の contype='c' と比べる
function countChecks(createSql) {
  const body = tree(tokenize(createSql)).find((n) => n.t === 'grp');
  let count = 0;
  for (const def of splitTop(body.items)) def.forEach((n, i) => { if (up(n) === 'CHECK' && def[i + 1]?.t === 'grp') count += 1; });
  return count;
}

export function sqliteSnapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const columns = {};
  const checks = {};
  const foreignKeys = {};
  const indexes = {};
  for (const table of tables) {
    const info = db.prepare(`PRAGMA table_info(${q(table)})`).all();
    const pkCols = info.filter((c) => c.pk > 0);
    // PostgreSQL は主キーの列を必ず NOT NULL にする（SQLite は整数でない主キーに NULL を入れられる。記録の「変えたこと」）
    // 単独の INTEGER PRIMARY KEY は行番号の別名で、ID を指定しなければ SQLite が振る。PostgreSQL では IDENTITY が同じ役をする
    const rowidAlias = pkCols.length === 1 && pkCols[0].type.toUpperCase() === 'INTEGER' ? pkCols[0].name : null;
    columns[table] = info.map((c) => ({ name: c.name, notNull: Boolean(c.notnull) || c.pk > 0, hasDefault: c.dflt_value !== null, identity: c.name === rowidAlias, type: TYPE_MAP[c.type.toUpperCase()] ?? `?${c.type}` }));
    checks[table] = countChecks(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table).sql);
    const fks = new Map();
    for (const row of db.prepare(`PRAGMA foreign_key_list(${q(table)})`).all()) {
      const fk = fks.get(row.id) ?? { from: [], ref: row.table, to: [], onDelete: row.on_delete, onUpdate: row.on_update };
      fk.from.push(row.from);
      fk.to.push(row.to);
      fks.set(row.id, fk);
    }
    foreignKeys[table] = sortJson([...fks.values()].map((fk) => {
      if (fk.to.every((c) => c === null)) {
        fk.to = db.prepare(`PRAGMA table_info(${q(fk.ref)})`).all().filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      }
      return fk;
    }));
    const list = db.prepare(`PRAGMA index_list(${q(table)})`).all().map((ix) => ({
      columns: db.prepare(`PRAGMA index_xinfo(${q(ix.name)})`).all().filter((c) => c.key).map((c) => (c.cid === -2 ? '<expr>' : c.name)),
      unique: Boolean(ix.unique),
      partial: Boolean(ix.partial),
    }));
    // INTEGER PRIMARY KEY は SQLite では行番号そのもので索引が無い。PostgreSQL では主キーの索引になる
    if (pkCols.length === 1 && pkCols[0].type.toUpperCase() === 'INTEGER') list.push({ columns: [pkCols[0].name], unique: true, partial: false });
    indexes[table] = sortJson(list);
  }
  return { tables, columns, checks, foreignKeys, indexes };
}

export async function postgresSnapshot(pg) {
  // PostgreSQL だけにある版の印の表（PG_FINGERPRINT_TABLE）は SQLite に無いので比べない（中身は test/pg-catalog.test.mjs が確かめる）
  const tables = (await pg.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname <> $1 ORDER BY c.relname COLLATE \"C\"", [PG_FINGERPRINT_TABLE])).map((r) => r.name);
  const columns = Object.fromEntries(tables.map((t) => [t, []]));
  for (const r of await pg.query("SELECT table_name, column_name, is_nullable, column_default, is_identity, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position")) {
    // IDENTITY の列は column_default が NULL になる。既定値の有無とは別に is_identity で写す
    if (!Object.hasOwn(columns, r.table_name)) continue;
    columns[r.table_name].push({ name: r.column_name, notNull: r.is_nullable === 'NO', hasDefault: r.column_default !== null, identity: r.is_identity === 'YES', type: r.data_type });
  }
  const checks = Object.fromEntries(tables.map((t) => [t, 0]));
  for (const r of await pg.query("SELECT t.relname AS tbl, count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'c' AND n.nspname = current_schema() GROUP BY t.relname")) {
    if (Object.hasOwn(checks, r.tbl)) checks[r.tbl] = r.n;
  }
  const foreignKeys = Object.fromEntries(tables.map((t) => [t, []]));
  for (const r of await pg.query(`SELECT (SELECT relname FROM pg_class WHERE oid = c.conrelid) AS tbl, (SELECT relname FROM pg_class WHERE oid = c.confrelid) AS ref,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
      (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols,
      c.confdeltype::text AS del, c.confupdtype::text AS upd
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = current_schema()`)) {
    if (!Object.hasOwn(foreignKeys, r.tbl)) continue;
    foreignKeys[r.tbl].push({ from: r.cols.split(','), ref: r.ref, to: r.refcols.split(','), onDelete: ACTION[r.del], onUpdate: ACTION[r.upd] });
  }
  const indexes = Object.fromEntries(tables.map((t) => [t, []]));
  for (const r of await pg.query(`SELECT t.relname AS tbl, x.indisunique AS uniq, (x.indpred IS NOT NULL) AS partial,
      (SELECT string_agg(CASE WHEN k.attnum = 0 THEN '<expr>' ELSE a.attname END, ',' ORDER BY k.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
        LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS cols
    FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = current_schema()`)) {
    if (!Object.hasOwn(indexes, r.tbl)) continue;
    indexes[r.tbl].push({ columns: r.cols.split(','), unique: r.uniq, partial: r.partial });
  }
  for (const t of tables) { foreignKeys[t] = sortJson(foreignKeys[t]); indexes[t] = sortJson(indexes[t]); }
  return { tables, columns, checks, foreignKeys, indexes };
}

// 表×時機×事象（UPDATE は列の指定つき）の組の一覧。本数では比べない（FR-CORE-DATA-020）
const triggerKey = (table, timing, event, columns) => `${table}|${timing}|${event}${columns.length ? ` OF ${[...columns].sort().join(',')}` : ''}`;

export function sqliteTriggerPairs(db) {
  const keys = new Set();
  for (const { sql } of db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger'").all()) {
    const m = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+(?:(BEFORE|AFTER|INSTEAD\s+OF)\s+)?(INSERT|UPDATE|DELETE)(?:\s+OF\s+([\s\S]+?))?\s+ON\s+("?)([A-Za-z0-9_]+)\4/i.exec(sql);
    if (!m) throw new Error(`トリガーの頭を読めない: ${sql.slice(0, 120)}`);
    const columns = m[3] ? m[3].split(',').map((c) => c.trim()) : [];
    keys.add(triggerKey(m[5], (m[1] ?? 'BEFORE').toUpperCase(), m[2].toUpperCase(), columns));
  }
  return [...keys].sort();
}

export async function postgresTriggerPairs(pg) {
  const keys = new Set();
  for (const r of await pg.query(`SELECT c.relname AS tbl, t.tgtype::int AS type,
      COALESCE((SELECT array_agg(a.attname::text) FROM unnest(t.tgattr::int2[]) k(attnum) JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum), '{}') AS cols
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = current_schema()`)) {
    if (!(r.type & 1)) throw new Error(`${r.tbl}: 行ごとでないトリガー`);
    const timing = r.type & 64 ? 'INSTEAD OF' : r.type & 2 ? 'BEFORE' : 'AFTER';
    const events = [[4, 'INSERT'], [8, 'DELETE'], [16, 'UPDATE']].filter(([bit]) => r.type & bit).map(([, e]) => e);
    for (const event of events) keys.add(triggerKey(r.tbl, timing, event, event === 'UPDATE' ? r.cols : []));
  }
  return [...keys].sort();
}

// 2つの写しの違いを、読める文の一覧にする（空なら一致）
export function snapshotDiff(expected, actual) {
  const diffs = [];
  const missing = expected.tables.filter((t) => !actual.tables.includes(t));
  const extra = actual.tables.filter((t) => !expected.tables.includes(t));
  if (missing.length) diffs.push(`PostgreSQL に無い表: ${missing.join(', ')}`);
  if (extra.length) diffs.push(`SQLite に無い表: ${extra.join(', ')}`);
  for (const table of expected.tables.filter((t) => actual.tables.includes(t))) {
    for (const key of ['columns', 'checks', 'foreignKeys', 'indexes']) {
      const a = JSON.stringify(expected[key][table]);
      const b = JSON.stringify(actual[key][table]);
      if (a !== b) diffs.push(`${table} の ${key}: SQLite ${a} / PostgreSQL ${b}`);
    }
  }
  return diffs;
}

// ---------- トリガーを名前ごとに（変換は1対1で名前を保つ） ----------
// 組の一覧（上）は、同じ組を共有するトリガーの1本が消えても変わらない。名前ごとに
// {表・時機・事象・列の指定・WHEN の有無・RAISE の文} を比べて、消えたトリガー・WHEN や拒否の文の抜けを拾う（FR-CORE-DATA-020）

export function sqliteTriggers(db) {
  const out = {};
  for (const { name, sql } of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all()) {
    const m = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+(?:(BEFORE|AFTER|INSTEAD\s+OF)\s+)?(INSERT|UPDATE|DELETE)(?:\s+OF\s+([\s\S]+?))?\s+ON\s+("?)([A-Za-z0-9_]+)\4/i.exec(sql);
    if (!m) throw new Error(`トリガーの頭を読めない: ${sql.slice(0, 120)}`);
    const tokens = tokenize(sql);
    const onAt = tokens.findIndex((t) => up(t) === 'ON');
    const beginAt = tokens.findIndex((t) => up(t) === 'BEGIN');
    const messages = [];
    tokens.forEach((t, i) => { if (up(t) === 'RAISE' && isOp(tokens[i + 1], '(') && tokens[i + 4]?.t === 'str') messages.push(tokens[i + 4].v.slice(1, -1).replaceAll("''", "'")); });
    out[name] = {
      table: m[5],
      timing: (m[1] ?? 'BEFORE').toUpperCase(),
      event: m[2].toUpperCase(),
      columns: m[3] ? m[3].split(',').map((c) => c.trim()).sort() : [],
      when: tokens.slice(onAt + 2, beginAt).some((t) => up(t) === 'WHEN'),
      messages: messages.sort(),
    };
  }
  return out;
}

// 変換は WHEN を関数の先頭の IF に移す（scripts/pg-ddl.mjs の convertTrigger）
const WHEN_IN_FUNCTION = /^\s*BEGIN\s*\n\s*IF \(.*\) IS NOT TRUE THEN RETURN (?:NEW|OLD|NULL); END IF;/;
export async function postgresTriggers(pg) {
  const out = {};
  for (const r of await pg.query(`SELECT t.tgname AS name, c.relname AS tbl, t.tgtype::int AS type, t.tgargs AS args, (t.tgqual IS NOT NULL) AS qual, p.prosrc AS src,
      COALESCE((SELECT array_agg(a.attname::text) FROM unnest(t.tgattr::int2[]) k(attnum) JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum), '{}') AS cols
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND n.nspname = current_schema()`)) {
    const events = [[4, 'INSERT'], [8, 'DELETE'], [16, 'UPDATE']].filter(([bit]) => r.type & bit).map(([, e]) => e);
    if (events.length !== 1) throw new Error(`${r.name}: 事象が1つでない`);
    // 共通の関数のトリガーは文を引数（tgargs。NUL で区切る）で、トリガーごとの関数は本文の MESSAGE で持つ
    const args = Buffer.from(r.args ?? []).toString('utf8').split('\0').filter(Boolean);
    const messages = [...args, ...[...(r.src ?? '').matchAll(/MESSAGE = '((?:[^']|'')*)'/g)].map((x) => x[1].replaceAll("''", "'"))];
    out[r.name] = {
      table: r.tbl,
      timing: r.type & 64 ? 'INSTEAD OF' : r.type & 2 ? 'BEFORE' : 'AFTER',
      event: events[0],
      columns: events[0] === 'UPDATE' ? [...r.cols].sort() : [],
      when: r.qual || WHEN_IN_FUNCTION.test(r.src ?? ''),
      messages: messages.sort(),
    };
  }
  return out;
}

export function triggerDiff(expected, actual) {
  const diffs = [];
  for (const name of Object.keys(expected).sort()) {
    if (!(name in actual)) diffs.push(`PostgreSQL に無いトリガー: ${name}`);
    else if (JSON.stringify(expected[name]) !== JSON.stringify(actual[name])) diffs.push(`${name}: SQLite ${JSON.stringify(expected[name])} / PostgreSQL ${JSON.stringify(actual[name])}`);
  }
  for (const name of Object.keys(actual).sort()) if (!(name in expected)) diffs.push(`SQLite に無いトリガー: ${name}`);
  return diffs;
}
