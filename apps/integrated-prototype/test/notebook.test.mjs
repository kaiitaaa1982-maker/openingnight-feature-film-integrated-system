import {openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';
import {fillFields, defaultTitle, threadView} from '../src/notebook/notebook-model.mjs';

const production = {
  scenes: [{id: 1, scene_no: '12', location_key: 'lh'}, {id: 2, scene_no: '14', location_key: 'lh'}],
  days: [{id: 5, shoot_date: '2026-11-03', unit: 'A', label: '1日目', assignments: [{scene_id: 2, sequence_order: 2, planned_start: '2026-11-03T10:00'}, {scene_id: 1, sequence_order: 1, planned_start: '2026-11-03T07:00'}]}],
  locations: [{key: 'lh', name: '灯台', address: '架空市1-1', green_room: '管理棟', parking: '第2'}],
  characters: [{key: 's', name: '汐里'}],
  calls: [{day_id: 5, character_key: 's', call_time: '2026-11-03T06:30', ready_time: '2026-11-03T07:30'}],
};

test('型の欄は制作の表から入る（撮影日・シーン・集合・ロケ地と控室・入り）。入れた欄はシステムからと印', () => {
  const f = Object.fromEntries(fillFields('daily', production, {dayId: 5}).map((x) => [x.label, x]));
  assert.equal(f['撮影日'].value, '11/3 A班 1日目');
  assert.equal(f['撮影するシーン'].value, 'S#12・S#14');
  assert.equal(f['集合'].value, '07:00');
  assert.equal(f['ロケ地と控室'].value, '灯台（控室: 管理棟）');
  assert.equal(f['持ち物・注意'].system, false);
  assert.equal(fillFields('call', production, {dayId: 5}).find((x) => x.label === '出演者と入り').value, '汐里 06:30（準備完了 07:30）');
  assert.equal(fillFields('location', production, {locationKey: 'lh'}).find((x) => x.label === '控室・駐車場').value, '管理棟／第2');
  assert.equal(defaultTitle('daily', fillFields('daily', production, {dayId: 5})), '11/3 A班 1日目 日々スケのお知らせ');
});

test('スレッドは新しい順。訂正された連絡は残り「訂正あり」、既読と了解は人ごとに数える', () => {
  const view = threadView([{id: 1}, {id: 2, corrects_post_id: 1}], [{post_id: 1, user_id: 7, kind: 'read'}, {post_id: 1, user_id: 8, kind: 'read'}, {post_id: 1, user_id: 7, kind: 'ack'}], 7);
  assert.deepEqual(view.map((p) => p.id), [2, 1]);
  assert.deepEqual([view[1].corrected, view[1].reads, view[1].acks, view[1].ackedByMe, view[0].readByMe], [true, 2, 1, true, false]);
});

async function login(app, email) { const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})}); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function call(app, cookie, method, path, body) { const r = await app.request(path, {method, headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, data: await r.json()}; }

test('連絡帳: 既定のスペース・出す・既読と了解（2回目は増えない）・訂正・権限', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const production1 = await login(app, 'production@openingnight.invalid'), outsider = await login(app, 'outsider@other.invalid');
  const spaces = (await call(app, production1, 'GET', '/api/notebook/spaces?workId=1')).data.spaces;
  assert.deepEqual(spaces.map((s) => s.name).slice(0, 3), ['全体', '演出部', '制作部']);
  assert.equal((await call(app, production1, 'GET', '/api/notebook/spaces?workId=1')).data.spaces.length, spaces.length, '2回開いてもスペースは増えない');
  const all = spaces[0].id;

  const sent = await call(app, production1, 'POST', `/api/notebook/spaces/${all}/posts`, {template: 'daily', title: '11/3 日々スケ', fields: [{label: '集合', value: '7:00', system: true}], design: 'table'});
  assert.equal(sent.status, 200);
  let posts = (await call(app, production1, 'GET', `/api/notebook/spaces/${all}/posts`)).data.posts;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].needs_ack, 1, '日々スケのお知らせは了解を求める');
  const id = posts[0].id;
  for (let k = 0; k < 2; k += 1) { await call(app, production1, 'POST', `/api/notebook/posts/${id}/read`, {}); await call(app, production1, 'POST', `/api/notebook/posts/${id}/ack`, {}); }
  assert.equal((await call(app, production1, 'POST', `/api/notebook/spaces/${all}/posts`, {template: 'free', title: '訂正: 集合は7:30', correctsPostId: id})).status, 200);
  posts = (await call(app, production1, 'GET', `/api/notebook/spaces/${all}/posts`)).data.posts;
  const original = posts.find((p) => p.id === id);
  assert.deepEqual([original.reads, original.acks, original.corrected], [1, 1, true]);

  assert.equal((await call(app, production1, 'POST', `/api/notebook/spaces/${all}/posts`, {template: 'nope', title: 'x'})).status, 400);
  assert.equal((await call(app, production1, 'POST', `/api/notebook/spaces/${all}/posts`, {template: 'free', title: 'x', attachments: [999]})).status, 400);
  assert.equal((await call(app, outsider, 'GET', `/api/notebook/spaces/${all}/posts`)).status, 403);
  assert.equal((await call(app, outsider, 'POST', `/api/notebook/posts/${id}/ack`, {})).status, 403);
  assert.equal((await call(app, production1, 'GET', '/api/notebook/spaces?workId=2')).status, 403);
  await assert.rejects(db.run('DELETE FROM notebook_posts'), /immutable/);
});

test('班の名前が「A班」で入っていても「A班班」にしない', async () => {
  const {unitLabel} = await import('../src/notebook/notebook-model.mjs');
  assert.equal(unitLabel('A'), 'A班');
  assert.equal(unitLabel('A班'), 'A班');
});
