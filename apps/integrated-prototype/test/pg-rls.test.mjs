// 行単位の権限（pg/rls.sql。scripts/pg-rls.mjs が生成）を、アプリのロールで確かめる（会社ルートの plans/2026-10-21-db-rls-owner-only.md の香盤表 #3）。
// 持ち主（試験の接続）が pg/schema.sql と pg/rls.sql を当て、架空の2組織・3人を入れる。アプリのロールは持ち主でも BYPASSRLS でもないロールを作り、
// 1つのトランザクションの中で SET LOCAL ROLE と set_config('app.user_id', …, true) をしてから読む・書く。架空のデータだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NON_ORG_TABLES, ORG_POLICY, RLS_OFF_PATH, RLS_PATH, buildRlsSql, tablesOf } from '../scripts/pg-rls.mjs';
import { OUTPUT_PATH } from '../scripts/pg-ddl.mjs';
import { openPgClient } from './pg-client.mjs';

const APP_ROLE = 'on_rls_test_app';
// 架空の組織と利用者（ID は初期データと重ならない大きさ）
const ORG_A = 9101;
const ORG_B = 9102;
const OWNER = 9201; // 組織 A の管理者（代表にあたる）
const OTHER = 9202; // 組織 B だけに所属
const EXPIRED = 9203; // 組織 A の所属が期限切れ

let ctx;

before(async () => {
  ctx = await openPgClient();
  const c = ctx.client;
  await c.query(readFileSync(RLS_PATH, 'utf8'));
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS; END IF; END $$`);
  await c.query(`GRANT USAGE ON SCHEMA ${ctx.schema} TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ctx.schema} TO ${APP_ROLE};
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${ctx.schema} TO ${APP_ROLE}`);
  await c.query(`INSERT INTO organizations(id, code, name) VALUES (${ORG_A}, 'rls-a', '架空A'), (${ORG_B}, 'rls-b', '架空B');
    INSERT INTO users(id, email, display_name) VALUES (${OWNER}, 'owner@example.test', '代表'), (${OTHER}, 'other@example.test', '他社'), (${EXPIRED}, 'expired@example.test', '期限切れ');
    INSERT INTO memberships(org_id, user_id, role, active, expires_at) VALUES
      (${ORG_A}, ${OWNER}, 'admin', 1, NULL), (${ORG_B}, ${OTHER}, 'admin', 1, NULL), (${ORG_A}, ${EXPIRED}, 'editor', 1, '2000-01-01T00:00:00Z');
    INSERT INTO projects(org_id, code, title) VALUES (${ORG_A}, 'RLS-A1', '架空の作品A'), (${ORG_B}, 'RLS-B1', '架空の作品B')`);
});
after(async () => { await ctx?.close(); });

// アプリのロールで fn(client) を流し、最後に巻き戻す。settings は {user_id, login_email}
async function asApp(settings, fn) {
  const c = ctx.client;
  await c.query('BEGIN');
  try {
    await c.query(`SET LOCAL ROLE ${APP_ROLE}`);
    for (const [key, value] of Object.entries(settings)) await c.query('SELECT set_config($1, $2, true)', [`app.${key}`, String(value)]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
  }
}
const rows = async (c, sql, params) => (await c.query(sql, params)).rows;
const projectCodes = async (c) => (await rows(c, "SELECT code FROM projects WHERE code LIKE 'RLS-%' ORDER BY code")).map((r) => r.code);

describe('pg/rls.sql の生成', () => {
  test('pg/rls.sql は pg/schema.sql から生成したものと一致する', () => {
    assert.equal(readFileSync(RLS_PATH, 'utf8'), buildRlsSql(readFileSync(OUTPUT_PATH, 'utf8')));
  });

  test('FR-CORE-DATA-055 扱いを決めていない org_id の無い表が増えたら生成を止める', () => {
    const extra = `${readFileSync(OUTPUT_PATH, 'utf8')}\nCREATE TABLE rls_unknown_master (\n  id bigint PRIMARY KEY,\n  name text\n);\n`;
    assert.throws(() => buildRlsSql(extra), /rls_unknown_master/);
  });
});

describe('どの表に RLS がかかっているか（カタログ）', () => {
  test('FR-CORE-DATA-055 RLS をかけないのは、理由を書いた表だけ', async () => {
    const off = await rows(ctx.client, `SELECT c.relname FROM pg_class c WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r','p') AND NOT c.relrowsecurity ORDER BY 1`, [ctx.schema]);
    const outside = Object.entries(NON_ORG_TABLES).filter(([, kind]) => kind === 'outside').map(([name]) => name).sort();
    assert.deepEqual(off.map((r) => r.relname), outside);
  });

  test('FR-CORE-DATA-052 org_id を持つ全部の表に、所属で絞る同じ条件のポリシーが1つだけある', async () => {
    const orgTables = tablesOf(readFileSync(OUTPUT_PATH, 'utf8')).filter((t) => t.columns.includes('org_id')).map((t) => t.name);
    assert.ok(orgTables.length > 250, `org_id の表が少なすぎる: ${orgTables.length}`);
    const policies = await rows(ctx.client, `SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = $1`, [ctx.schema]);
    const byTable = new Map();
    for (const p of policies) byTable.set(p.tablename, [...(byTable.get(p.tablename) ?? []), p]);
    const [first] = byTable.get(orgTables[0]);
    for (const name of orgTables) {
      const list = byTable.get(name) ?? [];
      assert.equal(list.length, 1, `${name} のポリシーの数`);
      const [p] = list;
      assert.equal(p.policyname, ORG_POLICY, name);
      assert.equal(p.cmd, 'ALL', name);
      assert.match(p.qual, /rls_member_org_ids/, name);
      assert.equal(p.qual, first.qual, `${name} の USING`);
      assert.equal(p.with_check, first.with_check, `${name} の WITH CHECK`);
    }
  });

  test('FR-CORE-DATA-054 アプリのロールは持ち主でも BYPASSRLS でもない', async () => {
    const [role] = await rows(ctx.client, 'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    assert.deepEqual(role, { rolbypassrls: false, rolsuper: false });
  });
});

describe('アプリのロールでの読み書き', () => {
  test('持ち主（移行・復旧のロール）は RLS の外で全組織を読む', async () => {
    assert.deepEqual(await projectCodes(ctx.client), ['RLS-A1', 'RLS-B1']);
  });

  test('FR-CORE-DATA-053 利用者 ID が無いと、業務の行・共通のマスタ・組織・所属を1行も返さない', async () => {
    await asApp({}, async (c) => {
      assert.deepEqual(await projectCodes(c), []);
      assert.equal((await rows(c, 'SELECT count(*)::int AS n FROM memberships'))[0].n, 0);
      assert.equal((await rows(c, 'SELECT count(*)::int AS n FROM organizations'))[0].n, 0);
      assert.equal((await rows(c, 'SELECT count(*)::int AS n FROM distribution_types'))[0].n, 0);
      assert.equal((await rows(c, 'SELECT count(*)::int AS n FROM users'))[0].n, 0);
    });
  });

  test('FR-CORE-DATA-053 数でない利用者 ID は無いのと同じ（どの行も返さない）', async () => {
    for (const bad of ['', '0', '-1', `${OWNER} OR 1=1`, `${OWNER}.0`, 'abc']) {
      await asApp({ user_id: bad }, async (c) => assert.deepEqual(await projectCodes(c), [], bad));
    }
  });

  test('FR-CORE-DATA-052 所属する組織の行だけを返す（画面が絞り込みを書き忘れても）', async () => {
    await asApp({ user_id: OWNER }, async (c) => {
      assert.deepEqual(await projectCodes(c), ['RLS-A1']);
      assert.deepEqual((await rows(c, `SELECT id FROM organizations WHERE id IN (${ORG_A}, ${ORG_B})`)).map((r) => Number(r.id)), [ORG_A]);
    });
    await asApp({ user_id: OTHER }, async (c) => assert.deepEqual(await projectCodes(c), ['RLS-B1']));
  });

  test('期限切れの所属は、所属が無いのと同じ', async () => {
    await asApp({ user_id: EXPIRED }, async (c) => assert.deepEqual(await projectCodes(c), []));
  });

  test('FR-CORE-DATA-052 他の組織の org_id では作れない（42501）', async () => {
    await asApp({ user_id: OWNER }, async (c) => {
      await assert.rejects(c.query(`INSERT INTO projects(org_id, code, title) VALUES (${ORG_B}, 'RLS-X', '他社へ')`), (e) => e.code === '42501');
    });
  });

  test('自分の組織の行は作れる', async () => {
    await asApp({ user_id: OWNER }, async (c) => {
      await c.query(`INSERT INTO projects(org_id, code, title) VALUES (${ORG_A}, 'RLS-A2', '架空の作品A2')`);
      assert.deepEqual(await projectCodes(c), ['RLS-A1', 'RLS-A2']);
    });
  });

  test('FR-CORE-DATA-052 他の組織の行は直せず消せない（0件）。自分の行を他の組織へ移すこともできない', async () => {
    await asApp({ user_id: OWNER }, async (c) => {
      assert.equal((await c.query("UPDATE projects SET title = '書き換え' WHERE code = 'RLS-B1'")).rowCount, 0);
      assert.equal((await c.query("DELETE FROM projects WHERE code = 'RLS-B1'")).rowCount, 0);
      await assert.rejects(c.query(`UPDATE projects SET org_id = ${ORG_B} WHERE code = 'RLS-A1'`), (e) => e.code === '42501');
    });
    assert.deepEqual(await rows(ctx.client, "SELECT title FROM projects WHERE code = 'RLS-B1'"), [{ title: '架空の作品B' }]);
  });

  test('所属の表は、自分が所属する組織の分だけ見える', async () => {
    await asApp({ user_id: OWNER }, async (c) => {
      const list = await rows(c, `SELECT org_id, user_id FROM memberships WHERE user_id IN (${OWNER}, ${OTHER}, ${EXPIRED}) ORDER BY user_id`);
      assert.deepEqual(list.map((r) => [Number(r.org_id), Number(r.user_id)]), [[ORG_A, OWNER], [ORG_A, EXPIRED]]);
    });
  });

  test('ログインの照会は、確かめたメールの利用者だけを引ける', async () => {
    await asApp({ login_email: 'owner@example.test' }, async (c) => {
      assert.deepEqual((await rows(c, 'SELECT email FROM users')).map((r) => r.email), ['owner@example.test']);
      assert.deepEqual(await projectCodes(c), []);
    });
  });

  test('利用者の行は自分の分しか直せない', async () => {
    await asApp({ user_id: OWNER }, async (c) => {
      assert.equal((await c.query(`UPDATE users SET display_name = '書き換え' WHERE id = ${OTHER}`)).rowCount, 0);
      assert.equal((await c.query(`UPDATE users SET display_name = '代表（改）' WHERE id = ${OWNER}`)).rowCount, 1);
    });
  });

  test('FR-CORE-DATA-053 利用者 ID はトランザクションの外へ残らない', async () => {
    const c = ctx.client;
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.user_id', String(OWNER)]);
    await c.query('COMMIT');
    const [{ v }] = await rows(c, "SELECT coalesce(current_setting('app.user_id', true), '') AS v");
    assert.equal(v, '');
  });
});

describe('RLS の外のロール（書き出し）', () => {
  const EXPORT_ROLE = 'on_rls_test_export';
  before(async () => {
    await ctx.client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${EXPORT_ROLE}') THEN CREATE ROLE ${EXPORT_ROLE} NOLOGIN BYPASSRLS; END IF; END $$`);
    await ctx.client.query(`GRANT USAGE ON SCHEMA ${ctx.schema} TO ${EXPORT_ROLE}; GRANT SELECT ON ALL TABLES IN SCHEMA ${ctx.schema} TO ${EXPORT_ROLE}`);
  });
  // 書き出し（src/data-platform/pg-export-store.mjs）と同じ読み方: READ ONLY のトランザクションで row_security = off にしてから読む
  const exportRead = async (role) => {
    const c = ctx.client;
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await c.query(`SET LOCAL ROLE ${role}`);
      await c.query('SET LOCAL row_security = off');
      return await projectCodes(c);
    } finally {
      await c.query('ROLLBACK');
    }
  };

  test('FR-CORE-DATA-054 アプリのロールで書き出すと 42501 で止まる（部分的な写しにならない）', async () => {
    await assert.rejects(exportRead(APP_ROLE), (e) => e.code === '42501');
  });

  test('FR-CORE-DATA-054 BYPASSRLS の書き出しのロールは、利用者 ID なしで全組織を読む', async () => {
    assert.deepEqual(await exportRead(EXPORT_ROLE), ['RLS-A1', 'RLS-B1']);
  });
});

describe('当て直しと戻し（pg/rls.sql・pg/rls-off.sql。core の runbooks/16-rls-staging.md）', () => {
  const rlsTables = async () => (await rows(ctx.client, `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = $1::regnamespace AND relkind IN ('r','p') AND relrowsecurity`, [ctx.schema]))[0].n;
  const policyCount = async () => (await rows(ctx.client, 'SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1', [ctx.schema]))[0].n;

  test('FR-CORE-DATA-052 pg/rls.sql は2回当てても止まらず、ポリシーの数が変わらない', async () => {
    const before = await policyCount();
    await ctx.client.query(readFileSync(RLS_PATH, 'utf8'));
    assert.equal(await policyCount(), before);
    await asApp({ user_id: OWNER }, async (c) => assert.deepEqual(await projectCodes(c), ['RLS-A1']));
  });

  test('FR-CORE-DATA-052 pg/rls-off.sql で全部の表の RLS とポリシーが外れ、pg/rls.sql で元に戻る', async () => {
    const tables = await rlsTables();
    const policies = await policyCount();
    assert.ok(tables > 250);
    await ctx.client.query(readFileSync(RLS_OFF_PATH, 'utf8'));
    try {
      assert.equal(await rlsTables(), 0);
      assert.equal(await policyCount(), 0);
      // 外したあとは RLS を入れる前と同じ（アプリのロールが全組織を読む）
      await asApp({}, async (c) => assert.deepEqual(await projectCodes(c), ['RLS-A1', 'RLS-B1']));
      // 2回外しても止まらない
      await ctx.client.query(readFileSync(RLS_OFF_PATH, 'utf8'));
    } finally {
      await ctx.client.query(readFileSync(RLS_PATH, 'utf8'));
    }
    assert.equal(await rlsTables(), tables);
    assert.equal(await policyCount(), policies);
    await asApp({}, async (c) => assert.deepEqual(await projectCodes(c), []));
  });
});
