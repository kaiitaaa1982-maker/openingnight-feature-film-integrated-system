#!/usr/bin/env node
// アプリのロールの権限の試験（香盤表 #27・段2の準備 論点9・FR-CORE-DATA-037）。pg/schema.sql と pg/local-seed.sql（架空の行）を当てた
// 使い捨ての DB に、pg_read_all_data と pg_write_all_data だけを持つロール（staging・本番の integrated_app と同じ持ち方）を作り、
// そのロールで次を確かめる。1つでも外れたら 1 で終わる。
//   - できること: 読む・INSERT・UPDATE・DELETE・IDENTITY の setval と pg_sequence_last_value（入口の IDENTITY の読み取りと、psql での ID の進め直し）
//   - 断られること（42501）: CREATE TABLE・ALTER TABLE … DISABLE TRIGGER・TRUNCATE（表を作る・トリガーを外す・行を一括で消す権限を持たない）
//   - 更新・削除を禁じるトリガーが、そのロールでも効くこと（P0001。distribution_master の更新・削除の禁止）
//   - ロールが superuser などの属性を持たず、属するロールが2つだけであること
//
//   node scripts/pg-role-check.mjs                       PGlite（手元）。SET LOCAL ROLE で試す
//   ON_TEST_PG_URL=postgres://… node scripts/pg-role-check.mjs
//                                                        手元の PostgreSQL（localhost だけ。CI の postgres:18.6-alpine）。DB を作り、
//                                                        ロールにログインして試し、DB とロールを消す
//   … --extra create|truncate|owner|superuser            わざと権限を足したロールで流す（試験が落ちる＝1 で終わることを確かめる）
//   … --summary <file>                                   結果の表を Markdown で足す（CI の job summary）
// 終了コード: 0 すべて通った・1 外れた試験がある・2 準備の失敗（DB に当たらない・引数の誤り）。
// ロールのパスワードは CI と手元だけの固定の偽物（PROBE_PASSWORD）。本物の接続文字列・パスワードは使わない。架空のデータだけを使う。
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { OUTPUT_PATH, SEED_PATH } from './pg-ddl.mjs';

export const APP_ROLE_MEMBERSHIPS = Object.freeze(['pg_read_all_data', 'pg_write_all_data']);
export const PROBE_ROLE = 'integrated_app_probe';
// 試験だけの偽物（秘密値ではない）。CI のサービスの POSTGRES_PASSWORD と同じく、localhost の使い捨ての DB にだけ使う
export const PROBE_PASSWORD = 'ci-only-fake-probe-password';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

// わざと足す権限（試験が落ちることを確かめる）。どれも、アプリのロールに持たせてはいけないもの
export const EXTRA_GRANTS = Object.freeze({
  create: ({ role, schema }) => `GRANT CREATE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)}`,
  truncate: ({ role, schema }) => `GRANT TRUNCATE ON ALL TABLES IN SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)}`,
  owner: ({ role }) => `ALTER TABLE distribution_master OWNER TO ${quoteIdent(role)}`,
  superuser: ({ role }) => `ALTER ROLE ${quoteIdent(role)} SUPERUSER`,
});

// 試験。expect は 'ok'（通る）か SQLSTATE（その誤りで断られる）。check は通ったときの結果を確かめる（誤りの文を返すと外れ）
const ORG_SEQ = "pg_get_serial_sequence('organizations', 'id')";
export const PROBES = Object.freeze([
  { name: '読む（SELECT）', expect: 'ok', sql: ['SELECT count(*) AS n FROM distribution_master'],
    check: ([r]) => (Number(r.rows[0].n) > 0 ? null : 'distribution_master に架空の行が無い（pg/local-seed.sql を当てたか）') },
  { name: '書く（INSERT・UPDATE・DELETE）', expect: 'ok',
    sql: ["INSERT INTO organizations (code, name) VALUES ('perm-probe', '架空の組織') RETURNING id",
      "UPDATE organizations SET name = '架空の組織（更新）' WHERE code = 'perm-probe'",
      "DELETE FROM organizations WHERE code = 'perm-probe'"],
    check: (rs) => (rs.every((r) => r.rowCount === 1) ? null : `行の数 ${rs.map((r) => r.rowCount).join('・')}`) },
  { name: 'IDENTITY の setval・pg_sequence_last_value', expect: 'ok',
    sql: [`SELECT setval(${ORG_SEQ}, (SELECT GREATEST(COALESCE(max(id), 0), 1) FROM organizations), true) AS v`,
      `SELECT pg_sequence_last_value(${ORG_SEQ}::regclass) AS v`],
    check: ([a, b]) => (String(a.rows[0].v) === String(b.rows[0].v) ? null : `setval ${a.rows[0].v}・last_value ${b.rows[0].v}`) },
  { name: 'CREATE TABLE が断られる', expect: '42501', sql: ['CREATE TABLE perm_probe_table (id bigint)'] },
  { name: 'ALTER TABLE … DISABLE TRIGGER が断られる', expect: '42501', sql: ['ALTER TABLE distribution_master DISABLE TRIGGER distribution_master_no_update'] },
  { name: 'TRUNCATE が断られる', expect: '42501', sql: ['TRUNCATE distribution_master'] },
  { name: '更新を禁じるトリガーが効く', expect: 'P0001', sql: ['UPDATE distribution_master SET notes = notes WHERE code = (SELECT min(code) FROM distribution_master)'] },
  { name: '削除を禁じるトリガーが効く', expect: 'P0001', sql: ['DELETE FROM distribution_master WHERE code = (SELECT min(code) FROM distribution_master)'] },
]);

// pg の Client と PGlite の差をならす（rows と rowCount）
export function queryable(client) {
  return {
    query: async (sql) => {
      const r = await client.query(sql);
      return { rows: r.rows, rowCount: r.rowCount ?? r.affectedRows ?? 0 };
    },
  };
}

async function roleAttributes(admin, role) {
  const { rows: [attr] } = await admin.query(`SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication,
      COALESCE((SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '{}') AS memberships
    FROM pg_roles r WHERE r.rolname = '${role.replaceAll("'", "''")}'`);
  if (!attr) return `ロール ${role} が無い`;
  const flags = ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolbypassrls', 'rolreplication'].filter((k) => attr[k]);
  const memberships = Array.isArray(attr.memberships) ? attr.memberships : String(attr.memberships).replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  const problems = [];
  if (flags.length) problems.push(`属性 ${flags.join('・')}`);
  if (JSON.stringify(memberships) !== JSON.stringify(APP_ROLE_MEMBERSHIPS)) problems.push(`属するロール ${memberships.join('・') || '無し'}`);
  return problems.length ? problems.join('。') : null;
}

// 試験を流す。admin は superuser の接続（ロールの属性を読む。as を渡さないときは SET LOCAL ROLE で role になって流す）。
// as はロールでログインした接続（CI）。どの試験もトランザクションの中で流して ROLLBACK する（setval だけは戻らないが、値は max(id) のまま）
export async function runProbes({ admin, as = null, role }) {
  const conn = as ?? admin;
  const results = [];
  const membership = await roleAttributes(admin, role);
  results.push({ name: `ロールの属性（${APP_ROLE_MEMBERSHIPS.join('・')} だけ・superuser などでない）`, expect: 'ok', got: membership ? 'NG' : 'ok', ok: !membership, detail: membership ?? '' });
  for (const probe of PROBES) {
    let got = 'ok';
    let detail = '';
    const outs = [];
    await conn.query('BEGIN');
    try {
      if (!as) await conn.query(`SET LOCAL ROLE ${quoteIdent(role)}`);
      for (const sql of probe.sql) outs.push(await conn.query(sql));
    } catch (error) {
      got = error.code ?? 'error';
      detail = String(error.message ?? error).split('\n')[0];
    } finally {
      await conn.query('ROLLBACK');
    }
    let ok = got === probe.expect;
    if (ok && probe.check) {
      const problem = probe.check(outs);
      if (problem) { ok = false; detail = problem; }
    }
    if (!ok && got === 'ok' && !detail) detail = '断られるはずが通った';
    results.push({ name: probe.name, expect: probe.expect, got, ok, detail });
  }
  return results;
}

// アプリのロールを作る（admin で）。extra はわざと足す権限の名前
export async function createProbeRole({ admin, role = PROBE_ROLE, login = false, extra = null }) {
  const { rows: [{ schema }] } = await admin.query('SELECT current_schema() AS schema');
  await admin.query(`CREATE ROLE ${quoteIdent(role)} ${login ? `LOGIN PASSWORD '${PROBE_PASSWORD}'` : 'NOLOGIN'}`);
  await admin.query(`GRANT ${APP_ROLE_MEMBERSHIPS.join(', ')} TO ${quoteIdent(role)}`);
  if (extra) await admin.query(EXTRA_GRANTS[extra]({ role, schema }));
  return { role, schema };
}

// ロールを消す（その DB で持たせた権限・所有を外してから）
export async function dropProbeRole({ admin, role = PROBE_ROLE }) {
  const { rows } = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = '${role.replaceAll("'", "''")}'`);
  if (!rows.length) return;
  await admin.query(`REASSIGN OWNED BY ${quoteIdent(role)} TO CURRENT_USER`);
  await admin.query(`DROP OWNED BY ${quoteIdent(role)}`);
  await admin.query(`DROP ROLE ${quoteIdent(role)}`);
}

export function formatResults(results) {
  return results.map((r) => `${r.ok ? 'OK' : 'NG'}  ${r.name}（期待 ${r.expect}・結果 ${r.got}）${r.detail ? `: ${r.detail}` : ''}`).join('\n');
}

function markdown(results, { where, extra }) {
  const passed = results.filter((r) => r.ok).length;
  return [
    `### 権限の試験（${where}${extra ? `・わざと足した権限 ${extra}` : ''}）: ${passed}/${results.length}`,
    '',
    '| 試験 | 期待 | 結果 | 判定 |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.expect} | ${r.got} | ${r.ok ? 'OK' : '**NG**'} |`),
    '',
  ].join('\n');
}

async function withPglite({ extra }) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  try {
    await db.exec(readFileSync(OUTPUT_PATH, 'utf8'));
    await db.exec(readFileSync(SEED_PATH, 'utf8'));
    const admin = queryable(db);
    const { role } = await createProbeRole({ admin, extra });
    return await runProbes({ admin, role });
  } finally {
    await db.close();
  }
}

async function withPostgres({ url, extra }) {
  const { hostname } = url;
  if (!LOCAL_HOSTS.has(hostname)) throw Object.assign(new Error('ON_TEST_PG_URL は手元（localhost）の PostgreSQL だけを受け付ける'), { setup: true });
  const { default: pg } = await import('pg');
  const name = `integrated_perm_${process.pid}`;
  const root = new pg.Client({ connectionString: url.toString() });
  await root.connect();
  let build = null;
  let probe = null;
  try {
    await root.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${quoteIdent(name)}`);
    const dbUrl = new URL(url);
    dbUrl.pathname = `/${name}`;
    build = new pg.Client({ connectionString: dbUrl.toString() });
    await build.connect();
    await build.query(readFileSync(OUTPUT_PATH, 'utf8'));
    await build.query(readFileSync(SEED_PATH, 'utf8'));
    const admin = queryable(build);
    await dropProbeRole({ admin });
    const { role } = await createProbeRole({ admin, login: true, extra });
    const roleUrl = new URL(dbUrl);
    roleUrl.username = role;
    roleUrl.password = PROBE_PASSWORD;
    probe = new pg.Client({ connectionString: roleUrl.toString() });
    await probe.connect();
    return await runProbes({ admin, as: queryable(probe), role });
  } finally {
    if (probe) await probe.end().catch(() => {});
    if (build) {
      await dropProbeRole({ admin: queryable(build) }).catch(() => {});
      await build.end().catch(() => {});
    }
    await root.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`).catch(() => {});
    await root.query(`DROP ROLE IF EXISTS ${quoteIdent(PROBE_ROLE)}`).catch(() => {});
    await root.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : null; };
  const extra = valueOf('--extra');
  const summary = valueOf('--summary');
  if (extra && !Object.hasOwn(EXTRA_GRANTS, extra)) {
    console.error(`--extra は ${Object.keys(EXTRA_GRANTS).join('・')} のどれか（${extra}）`);
    process.exit(2);
  }
  const url = process.env.ON_TEST_PG_URL ? new URL(process.env.ON_TEST_PG_URL) : null;
  const where = url ? '手元の PostgreSQL（ON_TEST_PG_URL・ロールでログイン）' : 'PGlite（SET LOCAL ROLE）';
  let results;
  try {
    results = url ? await withPostgres({ url, extra }) : await withPglite({ extra });
  } catch (error) {
    console.error(`準備に失敗した: ${error.message}`);
    process.exit(2);
  }
  console.log(`権限の試験（${where}${extra ? `・わざと足した権限 ${extra}` : ''}）`);
  console.log(formatResults(results));
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `外れた試験 ${failed}/${results.length}` : `すべて通った ${results.length}/${results.length}`);
  if (summary) appendFileSync(summary, markdown(results, { where, extra }));
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
