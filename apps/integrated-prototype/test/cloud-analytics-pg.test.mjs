// 分析の写しの抽出（src/cloud-analytics.mjs の freezeAnalyticsSnapshot。PG 計画 段1・香盤表 #10。FR-CORE-DATA-009・010）を、
// PostgreSQL の入口（src/data-platform/pg-db.mjs の PgDatabase）で流し、SQLite の入口（LocalDatabase）と同じ写しになるかを確かめる。
// LocalDatabase と本番の D1 の入口（R2BackedD1Database）の試験は test/cloud-analytics.test.mjs。
// PostgreSQL は既定で PGlite（test/pg-client.mjs）。ON_TEST_PG_URL（localhost だけ）を渡すと手元の PostgreSQL で流し、
// 抽出の途中に別の接続が書く試験も流れる（PGlite は接続が1つなので skip。CI の postgres:18-alpine で流す）。架空のデータだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LocalDatabase } from '../src/db.mjs';
import { PgDatabase } from '../src/data-platform/pg-db.mjs';
import { freezeAnalyticsSnapshot, sha256, snapshotTables } from '../src/cloud-analytics.mjs';
import { MIGRATIONS_DIR } from '../scripts/pg-ddl.mjs';
import { openPgClient } from './pg-client.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));

function openSqlite() {
  const db = new LocalDatabase(':memory:', { init: false });
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) db.raw.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  return db;
}

// 両方の DB に同じ順で入れる架空の行（組織2の行は写しに入らない）
const SEED = [
  "INSERT INTO organizations (id, code, name) VALUES (1, 'ORG1', '架空の組織1'), (2, 'ORG2', '架空の組織2')",
  "INSERT INTO users (id, email, display_name) VALUES (1, 'admin1@example.invalid', '架空の管理者1'), (2, 'editor1@example.invalid', '架空の編集者1'), (3, 'admin2@example.invalid', '架空の管理者2')",
  "INSERT INTO memberships (org_id, user_id, role, active) VALUES (1, 1, 'admin', 1), (1, 2, 'editor', 1), (2, 3, 'admin', 1)",
  "INSERT INTO projects (id, org_id, code, title) VALUES (1, 1, 'PJ1', '架空の企画1'), (2, 2, 'PJ2', '架空の企画2')",
  "INSERT INTO works (id, org_id, project_id, code, title) VALUES (1, 1, 1, 'W1', '架空の作品1'), (2, 1, 1, 'W2', '架空の作品2'), (3, 2, 2, 'W3', '架空の作品3')",
  "INSERT INTO partners (id, org_id, code, name) VALUES (1, 1, 'P1', '架空の取引先1'), (2, 1, 'P2', '架空の取引先2'), (3, 2, 'P3', '架空の取引先3')",
  "INSERT INTO products (id, org_id, sku, name, channel) VALUES (1, 1, 'SKU1', '架空の商品1', 'digital'), (2, 2, 'SKU2', '架空の商品2', 'digital')",
  "INSERT INTO expenses (id, org_id, project_id, work_id, incurred_on, accounting_month, category, description, budget_yen, actual_ex_tax, tax_amount, actual_inc_tax) VALUES (1, 1, 1, 1, '2026-09-10', '2026-09', '架空の区分', '架空の経費', 50000, 10000, 1000, 11000)",
  "INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id, detail_json) VALUES (1, 1, 'create', 'works', '1', '{}')",
  "INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id, detail_json) VALUES (2, 3, 'create', 'works', '3', '{}')",
  "INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id, detail_json) VALUES (1, 1, 'create', 'partners', '2', '{}')",
];
const ARGS = { orgId: 1, registrationId: 'synthetic-test-registration', definitionVersion: 'test-definition-1', runId: 'b'.repeat(32), asOf: '2026-09-22', userId: 1 };
// 写しから、抽出のたびに変わる値（抽出の時刻と、それを含むハッシュ）を除く
const stable = ({ exportedAt, frozenHash, ...rest }) => plain(rest);
const auditThrough = async (db) => (await db.get('SELECT MAX(id) AS n FROM audit_log WHERE org_id = ?', [1])).n;

// 入口が文を1つ流すたびに afterStatement を呼ぶ PostgreSQL の入口（抽出の途中に別の接続の書き込みを挟む）
class HookedPgDatabase extends PgDatabase {
  async execute(client, sql, params) {
    const out = await super.execute(client, sql, params);
    await this.afterStatement?.();
    return out;
  }
}

describe('分析の写しの抽出を SQLite と PostgreSQL の入口で並べる', () => {
  const ctx = {};
  before(async () => {
    ctx.sqlite = openSqlite();
    ctx.conn = await openPgClient();
    ctx.pg = new PgDatabase(ctx.conn.client);
    for (const sql of SEED) { await ctx.sqlite.run(sql); await ctx.pg.run(sql); }
  });
  after(async () => {
    ctx.sqlite?.close();
    await ctx.conn?.close();
  });

  test('FR-CORE-DATA-010 PostgreSQL の入口の読み取りの一括でも、写しの表・列・行・audit_through・管理者の確かめが SQLite と同じ', async () => {
    const sqlite = await freezeAnalyticsSnapshot({ db: ctx.sqlite, ...ARGS });
    const pg = await freezeAnalyticsSnapshot({ db: ctx.pg, ...ARGS });
    assert.deepEqual(stable(pg), stable(sqlite));
    for (const snap of [sqlite, pg]) {
      const { frozenHash, ...payload } = snap;
      assert.equal(frozenHash, await sha256(JSON.stringify(payload)));
      assert.deepEqual(Object.keys(snap.tables), Object.keys(snapshotTables));
      for (const [table, columns] of Object.entries(snapshotTables)) assert.deepEqual(snap.tables[table].columns, columns.split(','), table);
      assert.equal(snap.auditThrough, 3, '組織1の監査の上限（組織2の行は数えない）');
      assert.deepEqual(snap.tables.works.rows.map((r) => r.id), [1, 2]);
      assert.deepEqual(snap.tables.partners.rows.map((r) => r.code), ['P1', 'P2']);
      // 金額は安全な整数の Number（PostgreSQL の bigint も文字にしない。FR-CORE-DATA-012・014）
      assert.deepEqual(plain(snap.tables.expenses.rows), [{ id: 1, org_id: 1, project_id: 1, work_id: 1, accounting_month: '2026-09', category: '架空の区分', budget_yen: 50000, actual_ex_tax: 10000, tax_amount: 1000, actual_inc_tax: 11000 }]);
      assert.ok(snap.tables.distribution_types.rows.length > 0, '組織によらない表は全部の行');
    }
    // 管理者の確かめも同じ一括の中で行う。失効・管理者でない利用者・別の組織の管理者は、両方の DB で 403
    await ctx.sqlite.run("UPDATE memberships SET expires_at = '2000-01-01T00:00:00Z' WHERE org_id = 1 AND user_id = 1");
    await ctx.pg.run("UPDATE memberships SET expires_at = '2000-01-01T00:00:00Z' WHERE org_id = 1 AND user_id = 1");
    for (const [db, userId] of [[ctx.sqlite, 1], [ctx.pg, 1], [ctx.sqlite, 2], [ctx.pg, 2], [ctx.sqlite, 3], [ctx.pg, 3]]) {
      await assert.rejects(freezeAnalyticsSnapshot({ db, ...ARGS, userId }), (e) => e.status === 403 && /権限が失効/.test(e.message));
    }
    await ctx.sqlite.run('UPDATE memberships SET expires_at = NULL WHERE org_id = 1 AND user_id = 1');
    await ctx.pg.run('UPDATE memberships SET expires_at = NULL WHERE org_id = 1 AND user_id = 1');
    assert.equal((await freezeAnalyticsSnapshot({ db: ctx.pg, ...ARGS })).auditThrough, 3);
  });

  test('FR-CORE-DATA-009 FR-CORE-DATA-010 分析の写しの抽出の途中に別の接続が書いても、写しは1つの時点の行だけを含む（本物の PostgreSQL の2つの接続）', { skip: process.env.ON_TEST_PG_URL ? false : 'PGlite は接続が1つなので、抽出の途中に書き込みを挟めない（CI の postgres:18-alpine で流す）' }, async () => {
    const pool = ctx.conn.pool();
    const reader = new HookedPgDatabase(pool);
    const writer = new PgDatabase(pool);
    // 別の要求の書き込み（取引先を1行足して監査に記録する）を、別の接続のトランザクションで確定する
    const writeOnce = (code) => {
      const state = { done: false };
      reader.afterStatement = async () => {
        if (state.done) return;
        state.done = true;
        await writer.batch([
          { sql: 'INSERT INTO partners (org_id, code, name) VALUES (?, ?, ?)', params: [1, code, '抽出の途中に足した架空の取引先'] },
          { sql: "INSERT INTO audit_log (org_id, user_id, action, entity_type, entity_id, detail_json) VALUES (1, 1, 'create', 'partners', ?, '{}')", params: [code] },
        ]);
      };
      return state;
    };
    // 対照: 入口の all を並べると、途中の書き込みが後の読み取りに見える（この試験が書き込みを本当に挟めている）
    const control = writeOnce('CONTROL');
    await reader.all('SELECT id FROM committee_report_snapshots WHERE org_id = ?', [1]);
    assert.ok((await reader.all('SELECT code FROM partners WHERE org_id = ?', [1])).some((r) => r.code === 'CONTROL'));
    assert.equal(control.done, true);
    // 読み取りの一括: 1つ目の文を読んだあとに別の接続が書いても、残りの文は一括を始めた時点を読む（REPEATABLE READ）
    const beforeAudit = await auditThrough(writer);
    const mid = writeOnce('MID-PG');
    const snap = await freezeAnalyticsSnapshot({ db: reader, ...ARGS });
    reader.afterStatement = null;
    assert.equal(mid.done, true);
    assert.equal(snap.tables.partners.rows.some((r) => r.code === 'MID-PG'), false, '途中に足した行は写しに入らない');
    assert.ok(snap.tables.partners.rows.some((r) => r.code === 'CONTROL'), '一括の前に足した行は写しに入る');
    assert.equal(snap.auditThrough, beforeAudit, '監査の上限も抽出を始めた時点のまま');
    assert.deepEqual(await writer.all('SELECT code FROM partners WHERE code = ?', ['MID-PG']), [{ code: 'MID-PG' }], '書き込みは確定している');
    assert.equal(await auditThrough(writer), beforeAudit + 1);
  });
});
