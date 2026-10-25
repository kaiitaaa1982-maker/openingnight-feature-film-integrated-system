import {openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';

async function login(app, email) { const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})}); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function call(app, cookie, method, path, body) { const r = await app.request(path, {method, headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, data: await r.json()}; }

test('手配・美術・撮影の方針は版を足すだけで、いまの値は最新の版。権限の無い人と別の作品は断る', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const production = await login(app, 'production@openingnight.invalid'), outsider = await login(app, 'outsider@other.invalid');
  const work = await db.get('SELECT id,project_id,org_id FROM works WHERE id=1');
  await db.run("INSERT INTO scenes(org_id,project_id,work_id,scene_no,synopsis) VALUES(?,?,?,'P-1','架空')", [work.org_id, work.project_id, work.id]);
  const scene = await db.get("SELECT id FROM scenes WHERE scene_no='P-1'");
  const base = '/api/preprod/works/1';

  // 手配: 仮押さえ → 延長して確定（同じ識別子で版2）
  const first = await call(app, production, 'POST', `${base}/arrangements`, {kind: 'grip', item: 'レール 10m', quantity: 1, unit: '式', startsOn: '2026-11-03', endsOn: '2026-11-05', deadlineOn: '2026-10-30'});
  assert.equal(first.status, 200);
  assert.equal((await call(app, production, 'POST', `${base}/arrangements`, {key: first.data.key, kind: 'grip', item: 'レール 10m', quantity: 1, unit: '式', startsOn: '2026-11-03', endsOn: '2026-11-06', state: 'confirmed'})).status, 200);
  // 美術と撮影の方針
  assert.equal((await call(app, production, 'POST', `${base}/art-items`, {sceneId: scene.id, kind: 'build', content: '灯台の光', owner: '美術部', deliveryOn: '2026-11-02'})).status, 200);
  assert.equal((await call(app, production, 'POST', `${base}/shoot-plans`, {sceneId: scene.id, methods: 'レール移動', equipment: 'レール 10m'})).status, 200);
  assert.equal((await call(app, production, 'POST', `${base}/shoot-plans`, {sceneId: scene.id, methods: '手持ち'})).status, 200);

  const plans = (await call(app, production, 'GET', `${base}/plans`)).data;
  assert.equal(plans.arrangements.length, 1);
  assert.deepEqual([plans.arrangements[0].version_no, plans.arrangements[0].state, plans.arrangements[0].ends_on], [2, 'confirmed', '2026-11-06']);
  assert.deepEqual(plans.artItems.map((a) => [a.content, a.state]), [['灯台の光', 'open']]);
  assert.deepEqual(plans.shootPlans.map((p) => [p.version_no, p.methods, p.equipment]), [[2, '手持ち', null]]);

  // 入力の誤り・期間の逆転は 400、権限の無い人と別の作品は 403
  assert.equal((await call(app, production, 'POST', `${base}/arrangements`, {kind: 'helicopter', item: 'x'})).status, 400);
  assert.equal((await call(app, production, 'POST', `${base}/arrangements`, {kind: 'truck', item: '2t', startsOn: '2026-11-05', endsOn: '2026-11-03'})).status, 400);
  assert.equal((await call(app, outsider, 'GET', `${base}/plans`)).status, 403);
  assert.equal((await call(app, outsider, 'POST', `${base}/arrangements`, {kind: 'truck', item: '2t'})).status, 403);
  assert.equal((await call(app, production, 'POST', '/api/preprod/works/2/arrangements', {kind: 'truck', item: '2t'})).status, 403);

  // 版は書き換えも削除もできない（トリガー）
  await assert.rejects(db.run("UPDATE production_arrangement_versions SET item='x'"), /immutable/);
  await assert.rejects(db.run('DELETE FROM scene_art_item_versions'), /immutable/);
});
