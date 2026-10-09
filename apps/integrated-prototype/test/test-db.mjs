// 試験の DB を開くファクトリ（PG 計画 段1「試験の二重化」・香盤表 #11）。同じ試験を SQLite と PostgreSQL の両方で流すための入口。
//
//   const db = await openTestDb({t});            // ON_TEST_DB（既定 sqlite）で選ぶ
//   const db = await openTestDb({kind: 'pg'});   // 明示する
//
// 返すのは入口（all・get・run・batch・readBatch）と非同期の close。t を渡すと t.after で閉じる。
// 渡さなくても、閉じ忘れた DB はファイルの試験がすべて終わったあとに閉じる（root の after）。
//
// - sqlite: LocalDatabase(':memory:')（.raw も使える）。分析の2表も LocalDatabase が移行0011から作る（香盤表 #28）。
// - pg（ON_TEST_PG_URL が無いとき）: PGlite。プロセスごとに pg/schema.sql と pg/local-seed.sql を当てた土台を1つ作り、試験ごとに clone する
// - pg（ON_TEST_PG_URL があるとき。localhost だけ）: 本物の PostgreSQL。最初の1回に土台の DB（integrated_tpl）を作り、
//   試験ごとに CREATE DATABASE … TEMPLATE integrated_tpl で作り、閉じるときに DROP DATABASE … WITH (FORCE) で消す
//   （schema を作って消す形は、大きな schema の DROP SCHEMA が重なると out of shared memory になる）。土台は DDL と試作の行の指紋が
//   変わったときだけ作り直すので、CI のジョブでは最初のファイルが1回作り、後のファイルは使い回す
// 架空のデータだけを使う。接続文字列は環境変数で受け取り、ファイルに書かない。
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LocalDatabase } from '../src/db.mjs';
import { PgDatabase } from '../src/data-platform/pg-db.mjs';
import { OUTPUT_PATH, SEED_PATH } from '../scripts/pg-ddl.mjs';
import { pgliteStream } from './pg-client.mjs';

export const TEST_DB_KINDS = Object.freeze(['sqlite', 'pg']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const TEMPLATE_DB = 'integrated_tpl';

export const testDbKind = () => {
  const kind = process.env.ON_TEST_DB ?? 'sqlite';
  if (!TEST_DB_KINDS.includes(kind)) throw new Error(`ON_TEST_DB は ${TEST_DB_KINDS.join('・')} のどれか（${kind}）`);
  return kind;
};

// 土台に当てる SQL（DDL と試作の行）と、その指紋
let baseSql = null;
function loadBaseSql() {
  if (!baseSql) {
    const schema = readFileSync(OUTPUT_PATH, 'utf8');
    const seed = readFileSync(SEED_PATH, 'utf8');
    baseSql = { schema, seed, hash: createHash('sha256').update(schema).update('\n--seed--\n').update(seed).digest('hex').slice(0, 32) };
  }
  return baseSql;
}

const open = new Set();
// 閉じている途中の DB（試験が db.close() を await せずに終わったときも、土台と管理の接続はこれを待ってから閉じる）
const closing = new Set();
const track = (db) => { open.add(db); return db; };
// ファイルの試験がすべて終わったら、閉じ忘れた DB と土台を閉じる（本物の PostgreSQL の接続が残るとプロセスが終わらない）。
// 読み込んだときに root へ付ける（試験の中で after を呼ぶと、その試験の後始末になってしまう）。
// 試験の外（fixture を使う scripts/ の道具）から読み込んだときは付けない（node:test の root を作ると結果の行を出してしまう）
const underTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.some((arg) => arg.startsWith('--test'))
  || /\.test\.mjs$/.test(process.argv[1] ?? '');
if (underTest) after(() => closeAllTestDbs());

// 1つの close が落ちても（DROP DATABASE の失敗など）、残りの DB・土台・管理の接続は必ず閉じ、失敗はあとでまとめて投げる
// （接続が残ると node --test の子プロセスが終わらず、CI が timeout まで止まる）
export async function closeAllTestDbs() {
  const failures = [];
  const collect = (results) => { for (const r of results) if (r.status === 'rejected') failures.push(r.reason); };
  try {
    collect(await Promise.allSettled([...open].map((db) => Promise.resolve().then(() => db.close()))));
    collect(await Promise.allSettled([...closing]));
  } finally {
    const base = pgliteBase;
    const conn = admin;
    pgliteBase = null;
    admin = null;
    templateReady = null;
    collect(await Promise.allSettled([
      base && Promise.resolve(base).then((b) => b.close()),
      conn && Promise.resolve(conn).then((c) => c.end()),
    ].filter(Boolean)));
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, `試験の DB を閉じるときに ${failures.length} 件失敗した`);
}

// ---------- SQLite ----------

function openSqlite() {
  const db = new LocalDatabase(':memory:');
  let closed = false;
  // 試験が db.close() を await しなくても、SQLite はその場で閉じる（async の本体は最初の await までその場で流れる）
  db.close = async () => {
    if (closed) return;
    closed = true;
    open.delete(db);
    if (db.raw.isOpen) db.raw.close();
  };
  db.kind = 'sqlite';
  return track(db);
}

// ---------- PGlite ----------

let pgliteBase = null;
async function createPgliteBase() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { schema, seed } = loadBaseSql();
  const base = await PGlite.create();
  await base.exec(schema);
  await base.exec(seed);
  return base;
}

async function connectPglite(instance) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ stream: () => pgliteStream(instance), user: 'postgres', database: 'postgres' });
  await client.connect();
  return client;
}

async function openPglite() {
  pgliteBase ??= createPgliteBase();
  const instance = await (await pgliteBase).clone();
  const client = await connectPglite(instance);
  return wrapPg(client, async () => { await client.end(); await instance.close(); }, 'pglite');
}

// ---------- 本物の PostgreSQL ----------

let admin = null;
let templateReady = null;
let sequence = 0;

function pgUrl() {
  const url = new URL(process.env.ON_TEST_PG_URL);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error('ON_TEST_PG_URL は手元（localhost）の PostgreSQL だけを受け付ける');
  return url;
}
const dbUrl = (name) => { const url = pgUrl(); url.pathname = `/${name}`; return url.toString(); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

async function adminClient() {
  admin ??= (async () => {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: pgUrl().toString() });
    await client.connect();
    return client;
  })();
  return admin;
}

// 土台の DB を、指紋（DDL と試作の行）が違うときだけ作り直す。複数のプロセスが同時に来ても1つだけが作る（advisory lock）
async function ensureTemplate() {
  templateReady ??= (async () => {
    const { default: pg } = await import('pg');
    const { schema, seed, hash } = loadBaseSql();
    const conn = await adminClient();
    await conn.query('SELECT pg_advisory_lock(hashtext($1))', [TEMPLATE_DB]);
    try {
      // 落ちた試験のプロセスが残した DB（itest_<pid>_…。そのプロセスがもう無いもの）を消す
      const leftovers = await conn.query("SELECT datname FROM pg_database WHERE left(datname, 6) = 'itest_'");
      for (const { datname } of leftovers.rows) {
        const pid = Number(datname.split('_')[1]);
        if (pid && pid !== process.pid && !alive(pid)) await conn.query(`DROP DATABASE IF EXISTS ${quoteIdent(datname)} WITH (FORCE)`);
      }
      const found = await conn.query('SELECT shobj_description(oid, \'pg_database\') AS note FROM pg_database WHERE datname = $1', [TEMPLATE_DB]);
      if (found.rows[0]?.note === hash) return;
      await conn.query(`DROP DATABASE IF EXISTS ${quoteIdent(TEMPLATE_DB)} WITH (FORCE)`);
      await conn.query(`CREATE DATABASE ${quoteIdent(TEMPLATE_DB)}`);
      const build = new pg.Client({ connectionString: dbUrl(TEMPLATE_DB) });
      await build.connect();
      try {
        await build.query(schema);
        await build.query(seed);
      } finally {
        await build.end();
      }
      // 指紋は最後に書く（途中で落ちた土台を使い回さない）
      await conn.query(`COMMENT ON DATABASE ${quoteIdent(TEMPLATE_DB)} IS '${hash}'`);
    } finally {
      await conn.query('SELECT pg_advisory_unlock(hashtext($1))', [TEMPLATE_DB]);
    }
  })();
  return templateReady;
}

async function openPostgres() {
  await ensureTemplate();
  const { default: pg } = await import('pg');
  const conn = await adminClient();
  const name = `itest_${process.pid}_${Date.now().toString(36)}_${sequence += 1}`;
  await conn.query(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(TEMPLATE_DB)}`);
  const client = new pg.Client({ connectionString: dbUrl(name) });
  try {
    await client.connect();
  } catch (error) {
    await conn.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    throw error;
  }
  return wrapPg(client, async () => {
    try { await client.end(); } finally { await conn.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`); }
  }, 'postgres');
}

// ---------- 共通 ----------

function wrapPg(client, release, engine) {
  const db = new PgDatabase(client);
  let done = null;
  db.close = () => {
    if (!done) {
      done = (async () => { open.delete(db); await release(); })();
      closing.add(done);
      done.then(() => closing.delete(done), () => closing.delete(done));
    }
    return done;
  };
  db.kind = 'pg';
  db.engine = engine;
  return track(db);
}

export async function openTestDb({ t, kind = testDbKind() } = {}) {
  if (!TEST_DB_KINDS.includes(kind)) throw new Error(`openTestDb の kind は ${TEST_DB_KINDS.join('・')} のどれか（${kind}）`);
  const db = kind === 'sqlite' ? openSqlite() : process.env.ON_TEST_PG_URL ? await openPostgres() : await openPglite();
  if (t) t.after(() => db.close());
  return db;
}

// ---------- DB の種類によらない確かめ方 ----------

const isPg = (db) => db instanceof PgDatabase;

// 外部キーの違反の行（無ければ空の配列）。LocalDatabase（ファクトリの外で作ったものも）と、ファクトリの PostgreSQL の DB を受け付ける。
// - SQLite: PRAGMA foreign_key_check の行（SQLite は foreign_keys=ON でも、移行の途中など文の外で違反が残りうるので表を読む）
// - PostgreSQL: すべての外部キーについて、表を読んで違反の行を数える（MATCH SIMPLE: 列のどれかが NULL の行は見ない）。
//   PostgreSQL は外部キーを文ごとに強制するが、強制を外していた間（強制のトリガーを止めた・session_replication_role を replica にした・
//   NOT VALID で足した）に入った行は、強制を戻したあとも残り、カタログからは見えない。強制が効いているかをカタログで確かめるだけでは、
//   その行を見落とす。なので強制の状態によらず、毎回すべての外部キーで表を読む（行のある子の表の外部キーだけを、1つの問い合わせにまとめる）。
//   外部キーが1つも無いときは誤り（DDL の変換が外部キーを落としたら、空の結果が何も確かめていないことになる）
export async function foreignKeyViolations(db) {
  if (!isPg(db)) return db.all('PRAGMA foreign_key_check');
  const constraints = await db.all(`SELECT c.conname AS name, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
      (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_columns,
      (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_columns
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace ORDER BY c.conrelid::regclass::text, c.conname`);
  if (!constraints.length) throw new Error('foreignKeyViolations: PostgreSQL の DB に外部キーが1つも無い（pg/schema.sql を確かめる）');
  const q = (name) => `"${name.replaceAll('"', '""')}"`;
  const lit = (text) => `'${text.replaceAll("'", "''")}'`;
  // 行の無い表に違反の行は無いので、行のある子の表の外部キーだけを数える（どの表に行があるかは表を読んで決める。統計は使わない）
  const children = [...new Set(constraints.map((fk) => fk.child))];
  const filled = new Set((await db.all(children.map((name) => `SELECT ${lit(name)} AS t WHERE EXISTS (SELECT 1 FROM ${name})`).join(' UNION ALL '))).map((row) => row.t));
  const counts = constraints.map((fk, i) => [fk, i]).filter(([fk]) => filled.has(fk.child)).map(([fk, i]) => {
    const child = fk.child_columns.split(','), parent = fk.parent_columns.split(',');
    return `SELECT ${i} AS i, (SELECT count(*) FROM ${fk.child} x WHERE ${child.map((c) => `x.${q(c)} IS NOT NULL`).join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${child.map((c, k) => `p.${q(parent[k])} = x.${q(c)}`).join(' AND ')})) AS n`;
  });
  if (!counts.length) return [];
  const rows = await db.all(`SELECT i, n FROM (${counts.join(' UNION ALL ')}) v WHERE n > 0 ORDER BY i`);
  return rows.map((row) => {
    const fk = constraints[Number(row.i)];
    return {table: fk.child, parent: fk.parent, constraint: fk.name, rows: Number(row.n)};
  });
}

// 書き込みの印。読み取りの前後で比べ、同じなら、その間にこの DB へ書き込みが無かった（「読み取りが書き込まない」を確かめる）。
// - SQLite: total_changes()（この接続で INSERT・UPDATE・DELETE が変えた行の累計。値を変えない UPDATE と、ROLLBACK した行も数える）
// - PostgreSQL: 全部の表の生きている行の (ctid, xmin) と、この schema の順番（sequence）の値の指紋。INSERT・DELETE は行が増減し、
//   UPDATE は値を変えなくても新しい版の行（別の ctid と xmin）になるので、確定した書き込みはすべて指紋を変える。ROLLBACK した INSERT も、
//   順番の値を進めていれば指紋を変える。統計（pg_stat_*）は遅れて数えるので使わない。
//   VACUUM は生きている行を動かさず xmin も変えない（凍結は印のビットで、xmin の値は残る）ので、自動の掃除で印は変わらない
export async function writeMark(db) {
  if (!isPg(db)) return {kind: 'sqlite', changes: Number((await db.get('SELECT total_changes() AS n')).n)};
  const tables = (await db.all(`SELECT c.oid::regclass::text AS name FROM pg_class c
    WHERE c.relkind IN ('r', 'p') AND c.relnamespace = current_schema()::regnamespace ORDER BY 1`)).map((row) => row.name);
  if (!tables.length) throw new Error('writeMark: PostgreSQL の DB に表が1つも無い');
  const parts = tables.map((name) => `SELECT '${name.replaceAll("'", "''")}' AS t, (SELECT md5(coalesce(string_agg(ctid::text || ':' || xmin::text, ',' ORDER BY ctid), '')) FROM ${name}) AS h`);
  const rows = await db.all(parts.join(' UNION ALL '));
  const sequences = await db.get(`SELECT md5(coalesce(string_agg(sequencename || '=' || coalesce(last_value::text, '-'), ',' ORDER BY sequencename), '')) AS h
    FROM pg_sequences WHERE schemaname = current_schema()`);
  const fingerprint = createHash('sha256');
  for (const row of rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))) fingerprint.update(`${row.t}=${row.h}\n`);
  fingerprint.update(`sequences=${sequences.h}`);
  return {kind: 'pg', tables: rows.length, fingerprint: fingerprint.digest('hex')};
}

// 表があるか（sqlite_master は PostgreSQL に無い）。PostgreSQL はいまの schema の表だけを見る
export async function hasTable(db, name) {
  if (!isPg(db)) return Boolean(await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]));
  return Boolean(await db.get("SELECT c.relname FROM pg_class c WHERE c.relkind IN ('r', 'p') AND c.relnamespace = current_schema()::regnamespace AND c.relname = ?", [name]));
}
