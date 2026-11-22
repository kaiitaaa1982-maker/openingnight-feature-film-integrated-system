// 組織の本番・デモの印（organizations.kind。移行 0059。会社ルートの plans/2026-11-06-real-demo-split.md の手順2）。
// ・印は real と demo の2値だけで、付け忘れた組織は demo になる
// ・組織の一覧の API が組織ごとに印を返し、画面の札の文字は本番・デモ
// ・デモの seed は、投入先の組織が本番なら何も書かずに止まる
// 値はすべて架空。SQLite と PostgreSQL の両方で流れる（ファクトリ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {ORG_KIND_LABELS, orgKindLabel} from '../src/shell/org-model.mjs';
import {SALES_DEMO, REAL_ORG_REFUSED, createOrganization, seedSalesDemo} from '../scripts/seed-sales-demo.mjs';
import {seedAllDemo, tableCounts} from '../scripts/seed-all-demo.mjs';

const nextOrgId = async (db) => Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM organizations')).id);

test('組織の印は real と demo だけを受け、ほかの値と空は拒む', async (t) => {
  const db = await openTestDb({t});
  const id = await nextOrgId(db);
  await db.run("INSERT INTO organizations(id,code,name,kind) VALUES(?,?,?,'real')", [id, 'KIND-REAL', '架空の本番組織']);
  await db.run("INSERT INTO organizations(id,code,name,kind) VALUES(?,?,?,'demo')", [id + 1, 'KIND-DEMO', '架空のデモ組織']);
  for (const [kind, expected] of [['production', 'check'], ['REAL', 'check'], ['', 'check'], [null, 'not_null']]) {
    await assert.rejects(
      db.run('INSERT INTO organizations(id,code,name,kind) VALUES(?,?,?,?)', [id + 2, 'KIND-BAD', '架空の組織', kind]),
      (error) => error.dbError?.kind === expected, `kind=${kind} は ${expected} で拒む`);
  }
  await assert.rejects(db.run("UPDATE organizations SET kind='live' WHERE code='KIND-REAL'"), (error) => error.dbError?.kind === 'check');
  const rows = await db.all("SELECT code,kind FROM organizations WHERE code LIKE 'KIND-%' ORDER BY code");
  assert.deepEqual(rows.map((row) => ({...row})), [{code: 'KIND-DEMO', kind: 'demo'}, {code: 'KIND-REAL', kind: 'real'}]);
});

test('印を付けずに作った組織と、移行の前からある組織は demo になる', async (t) => {
  const db = await openTestDb({t});
  const id = await nextOrgId(db);
  await db.run('INSERT INTO organizations(id,code,name) VALUES(?,?,?)', [id, 'KIND-UNMARKED', '架空の印なし組織']);
  assert.equal((await db.get('SELECT kind FROM organizations WHERE id=?', [id])).kind, 'demo');
  // 試作の初期の組織（移行の前からある行にあたる）も demo
  assert.deepEqual((await db.all('SELECT DISTINCT kind FROM organizations WHERE id IN (1,2)')).map((row) => row.kind), ['demo']);
});

test('組織の一覧と切替の API は組織ごとに本番・デモの印を返し、画面の札は本番・デモの文字になる', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  await db.run("UPDATE organizations SET kind='real' WHERE id=2");
  await db.run("INSERT INTO memberships(org_id,user_id,role) SELECT 2,id,'admin' FROM users WHERE email='admin@openingnight.invalid'");
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const listed = await (await app.request('/api/session/orgs', {headers: {cookie}})).json();
  assert.deepEqual(listed.orgs.map((org) => [org.id, org.kind]), [[1, 'demo'], [2, 'real']]);
  const switched = await (await app.request('/api/session/org', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify({orgId: 2})})).json();
  assert.equal(switched.org.kind, 'real');
  assert.deepEqual(listed.orgs.map(orgKindLabel), ['デモ', '本番']);
  assert.deepEqual(ORG_KIND_LABELS, {real: '本番', demo: 'デモ'});
  // 印の無い一覧（古い API・プレビューの記録）と知らない値には札を出さない
  for (const org of [{id: 3}, {id: 3, kind: 'staging'}, {id: 3, kind: 'toString'}, null]) assert.equal(orgKindLabel(org), '', JSON.stringify(org));
});

test('デモの seed が作る組織には demo の印を明示して入れる', async (t) => {
  const db = await openTestDb({t});
  const orgId = await createOrganization(db);
  assert.deepEqual({...(await db.get('SELECT code,kind FROM organizations WHERE id=?', [orgId]))}, {code: SALES_DEMO.orgCode, kind: 'demo'});
});

test('デモの seed は、投入先の組織が本番なら何も書かずに止まる（売上の seed とまとめて流す seed）', async (t) => {
  const db = await openTestDb({t});
  const id = await nextOrgId(db);
  await db.run("INSERT INTO organizations(id,code,name,kind) VALUES(?,?,?,'real')", [id, SALES_DEMO.orgCode, '架空の本番組織']);
  const before = await tableCounts(db);
  await assert.rejects(seedSalesDemo(db), (error) => error.code === REAL_ORG_REFUSED && /本番/.test(error.message));
  await assert.rejects(seedAllDemo(db, {only: ['sales', 'masters']}), (error) => error.code === REAL_ORG_REFUSED);
  await assert.rejects(seedAllDemo(db), (error) => error.code === REAL_ORG_REFUSED);
  assert.deepEqual(await tableCounts(db), before, 'どの表にも書いていない');
});
