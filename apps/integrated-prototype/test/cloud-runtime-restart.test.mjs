// F4: 処理環境の再起動が、分析中かどうかを「いま選んでいる組織」でしか確かめず、組織を切り替えた管理者の要求で
// 組織1の分析中に共有コンテナを壊せた。権限とロックを分析の組織（1）で確かめる（cloud-runtime-restart.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {identityForEmail, orgCookieValue, ORG_HEADER, ORG_MISMATCH_CODE} from '../src/session-org.mjs';
import {restartWorkbenchRuntime, ANALYTICS_ORG_ID} from '../src/cloud-runtime-restart.mjs';

const NOW = new Date('2026-09-25T03:00:00.000Z');
const later = new Date(NOW.getTime() + 10 * 60_000).toISOString();
const earlier = new Date(NOW.getTime() - 10 * 60_000).toISOString();

async function setup({t} = {}) {
  // 分析の写しのジョブの表（cloud_analytics_state）は、両方の試験の DB がすでに持つ（scripts/pg-ddl.mjs の APP_DDL_SOURCES）
  const db = await openTestDb({t});
  // 代表（利用者1）は組織1と架空データの組織（3）の両方の管理者
  await db.batch([
    {sql: "INSERT INTO organizations(id,code,name) VALUES(3,'DEMO-SALES','架空データ（デモ）')"},
    {sql: "INSERT INTO memberships(org_id,user_id,role) VALUES(3,1,'admin')"},
  ]);
  const destroyed = [];
  const restart = async (orgId, headerOrgId = orgId) => {
    const identity = await identityForEmail(db, 'admin@openingnight.invalid', orgId ? `on_org=${encodeURIComponent(orgCookieValue(1, orgId))}` : '');
    const request = new Request('https://integrated.example/api/workbench/runtime/restart', {method: 'POST', headers: headerOrgId ? {[ORG_HEADER]: String(headerOrgId)} : {}});
    return restartWorkbenchRuntime({db, identity, request, destroy: async () => { destroyed.push(identity.org_id); }, now: () => NOW});
  };
  return {db, destroyed, restart};
}

test('an admin who switched to another org cannot restart the shared container while org 1 is analysing', async (t) => {
  const f = await setup({t});
  assert.equal(ANALYTICS_ORG_ID, 1);
  await f.db.run('INSERT INTO cloud_analytics_state(org_id,generation,lock_job,lock_until) VALUES(1,1,?,?)', ['job-1', later]);
  // DEMO（組織3）の管理者として届いた要求は、そもそも再起動できない（分析は組織1）
  const fromDemo = await f.restart(3);
  assert.equal(fromDemo.status, 403);
  assert.match(fromDemo.body.error, /分析を持つ組織の管理者/);
  // 組織1の管理者でも、組織1が分析中なら 409
  const busy = await f.restart(1);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, '分析処理中は再起動できません');
  assert.deepEqual(f.destroyed, [], 'コンテナは壊さない');
});

test('the lock check covers every org row, and a finished lock lets the org 1 admin restart', async (t) => {
  const f = await setup({t});
  // どの組織の行でもロック中なら止める（コンテナは全組織で共有）
  await f.db.run('INSERT INTO cloud_analytics_state(org_id,generation,lock_job,lock_until) VALUES(3,1,?,?)', ['job-3', later]);
  assert.equal((await f.restart(1)).status, 409);
  await f.db.run('UPDATE cloud_analytics_state SET lock_until=? WHERE org_id=3', [earlier]);
  await f.db.run('INSERT INTO cloud_analytics_state(org_id,generation,lock_job,lock_until) VALUES(1,2,NULL,NULL)');
  const ok = await f.restart(1);
  assert.deepEqual({status: ok.status, body: ok.body}, {status: 200, body: {ok: true}});
  assert.deepEqual(f.destroyed, [1]);
});

test('restart refuses a stale screen (org mismatch) and non-admin roles', async (t) => {
  const f = await setup({t});
  // 画面は組織3を描いたまま、Cookie は組織1（別のタブで切り替えた）
  const stale = await f.restart(1, 3);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, ORG_MISMATCH_CODE);
  await f.db.run("UPDATE memberships SET role='editor' WHERE org_id=1 AND user_id=1");
  assert.equal((await f.restart(1)).status, 403);
  assert.deepEqual(f.destroyed, []);
});

// cloud-worker.mjs は @cloudflare/containers を読むため Node の試験では import できない。再起動の経路がこの関数を通ることだけを確かめる
test('cloud-worker routes the restart through restartWorkbenchRuntime (no per-selected-org lock check left)', () => {
  const source = readFileSync(new URL('../src/cloud-worker.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ restartWorkbenchRuntime \} from '\.\/cloud-runtime-restart\.mjs'/);
  assert.match(source, /restartWorkbenchRuntime\(\{db,identity,request,destroy:/);
  assert.doesNotMatch(source, /cloud_analytics_state WHERE org_id=\?/);
});
