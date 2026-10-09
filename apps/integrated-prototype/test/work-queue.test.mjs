import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {seedReportDemo} from '../scripts/seed-report-demo.mjs';

test('home work queue shows role-appropriate items with counts and links', async (t) => {
  const db = await openTestDb({t});
  await seedReportDemo(db);
  await db.run("INSERT INTO prep_tasks(org_id,project_id,work_id,title,owner_label,due_on,status,created_by) VALUES(1,1,1,'架空の小道具準備','美術','2026-09-20','pending',1)");
  await db.run("INSERT INTO prep_tasks(org_id,project_id,work_id,title,due_on,status,created_by) VALUES(1,1,1,'来月の準備','2026-12-31','pending',1)");
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const get = async (cookie) => (await app.request('/api/work-queue?today=2026-09-24', {headers: {cookie}})).json();
  const admin = await get(await login('admin@openingnight.invalid'));
  const byId = Object.fromEntries(admin.items.map((item) => [item.id, item]));
  assert.equal(byId['prep-tasks'].count, 1, 'only tasks due within 7 days or blocked');
  assert.match(byId['prep-tasks'].rows[0].detail, /期限切れ/);
  assert.equal(byId['unbilled-sales'].count, 9);
  assert.deepEqual(byId['unbilled-sales'].params, {billing: 'unbilled'});
  assert.ok(byId['unbilled-sales'].rows.length <= 5, 'only the first five rows are returned');
  assert.equal(byId['mg-unverified'].count, 0);
  assert.ok(byId['workbench-approvals'], 'admin sees approval queues');
  const production = await get(await login('production@openingnight.invalid'));
  assert.deepEqual(production.items.map((item) => item.id), ['prep-tasks', 'unassigned-scenes'], 'production sees no finance items');
  const scenes = byId['unassigned-scenes'];
  assert.equal(scenes.page, '制作');
  assert.deepEqual(scenes.params, {tab: 'day'});
  const editor = await get(await login('editor@openingnight.invalid'));
  assert.ok(!editor.items.some((item) => item.id === 'workbench-approvals'));
});

test('unassigned scenes: only works with shooting days, not shot, and not on any day', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  await db.run("INSERT INTO scenes(org_id,project_id,work_id,scene_no,location,status) VALUES(1,1,1,'Q1','架空の駅','draft'),(1,1,1,'Q2','架空の港','shot'),(1,1,1,'Q3',NULL,'ready')");
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const get = async () => (await app.request('/api/work-queue?today=2026-09-24', {headers: {cookie: await login('production@openingnight.invalid')}})).json();
  const before = (await get()).items.find((item) => item.id === 'unassigned-scenes');
  const existingDays = await db.get('SELECT COUNT(*) AS n FROM shooting_days WHERE org_id=1 AND work_id=1');
  if (!existingDays.n) {
    assert.equal(before.count, 0, 'no shooting day yet, so nothing is reported');
    await db.run("INSERT INTO shooting_days(org_id,project_id,work_id,shoot_date,unit,label,created_by) VALUES(1,1,1,'2026-10-01','A','架空の撮影1日目',1)");
  }
  const after = (await get()).items.find((item) => item.id === 'unassigned-scenes');
  const labels = after.rows.map((row) => row.label);
  assert.ok(labels.includes('S#Q1・架空の駅'));
  assert.ok(labels.includes('S#Q3'));
  assert.ok(!labels.some((label) => label.startsWith('S#Q2')), 'shot scenes are not listed');
});
