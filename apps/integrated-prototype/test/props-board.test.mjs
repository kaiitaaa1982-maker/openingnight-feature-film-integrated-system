// 小道具の看板（src/preprod/props/props-board-model.mjs）が、#270 の既存の受け口（GET /api/props・POST /api/props/items/:id/versions）の上で動くこと。
// 架空の作品・品目・人名だけを使う。
import {openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';
import {moveBody, ownerSummary, boardColumns} from '../src/preprod/props/props-board-model.mjs';

async function login(app, email) { const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})}); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function call(app, cookie, method, path, body) { const r = await app.request(path, {method, headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, data: await r.json()}; }

const ITEMS = [
  {key: 'b-1', sceneLabel: '#31', shootOn: '2099-11-14', place: '居間', name: '湯のみ', quantity: '2（予備1）', kind: 'hand', department: 'direction', ownerLabel: '演出部（鈴木さん）', state: 'arranging', nextAction: '架空の倉庫で探す', dueOn: '2099-11-10', source: 'both', scriptNote: '湯のみを置く', memo: '白いもの'},
  {key: 'b-2', sceneLabel: '#31・#32', shootOn: '2099-11-14', name: '新聞', quantity: '1', kind: 'hand', department: 'production', ownerLabel: '鈴木さん・田中さん', state: 'ready', source: 'script'},
  {key: 'b-3', sceneLabel: '#40', shootOn: '2099-11-15', name: '花束', quantity: '多めに', kind: 'consumable', department: 'production', ownerLabel: '田中さん', state: 'adjust', source: 'meeting'},
  {key: 'b-4', sceneLabel: '#41', shootOn: '2099-11-15', name: '鍵', kind: 'hand', state: 'unassigned', source: 'script'},
];

async function setup(t) {
  const db = await openTestDb({t}), app = createApp({db});
  // 同じ組織で、案件を見られるが書けない制作担当（6。所属の権限が edit）と、案件に所属しない制作担当（5）
  await db.run("INSERT INTO users(id,email,display_name) VALUES(5,'nogrant@openingnight.invalid','所属なし'),(6,'reader@openingnight.invalid','見るだけ')");
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,5,'production'),(1,6,'production')");
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,1,6,'edit')");
  const production = await login(app, 'production@openingnight.invalid');
  assert.equal((await call(app, production, 'POST', '/api/props/import', {workId: 1, items: ITEMS})).status, 201);
  return {db, app, production};
}
const items = async (app, cookie) => (await call(app, cookie, 'GET', '/api/props?workId=1')).data.items;
const byName = (rows, name) => rows.find((r) => r.name === name);

test('FR-PROD-BOARD-003 FR-PROD-BOARD-004 GET /api/props の品目から、担当ごとの件数と5状態の列が出る', async (t) => {
  const {app, production} = await setup(t);
  const rows = await items(app, production);
  assert.deepEqual(ownerSummary(rows).map((n) => [n.owner, n.total, n.ready, n.arranging, n.adjust, n.unassigned, n.unneeded, n.remaining]), [
    ['田中さん', 2, 1, 0, 1, 0, 0, 1], ['鈴木さん', 2, 1, 1, 0, 0, 0, 1], ['未定', 1, 0, 0, 0, 1, 0, 1]]);
  assert.deepEqual(boardColumns(rows, {shootOn: '2099-11-14'}).map((c) => [c.label, c.cards.map((x) => x.name)]), [
    ['未割当', []], ['要調整', []], ['手配中', ['湯のみ']], ['用意済み', ['新聞']], ['不要', []]]);
});

test('FR-PROD-BOARD-005 看板の状態の変更は既存の版の受け口で版を1つ足し、ほかの中身を変えず、古い版からの変更は 409、部署のある品目の未割当は 400', async (t) => {
  const {db, app, production} = await setup(t);
  const before = byName(await items(app, production), '湯のみ');
  const moved = await call(app, production, 'POST', `/api/props/items/${before.id}/versions`, moveBody(before, 'ready'));
  assert.deepEqual([moved.status, moved.data.versionNo], [201, 2]);
  const after = byName(await items(app, production), '湯のみ');
  const {versionNo: v1, state: s1, updatedAt: u1, ...rest1} = before;
  const {versionNo: v2, state: s2, updatedAt: u2, ...rest2} = after;
  assert.deepEqual([v2, s2], [2, 'ready']);
  assert.deepEqual(rest2, rest1);
  // 古い版（1）からの変更は 409。版は増えない
  const stale = await call(app, production, 'POST', `/api/props/items/${before.id}/versions`, moveBody(before, 'adjust'));
  assert.equal(stale.status, 409);
  // 部署を持つ品目を未割当へ: 受け口が 400 で断る（画面はこの選択肢を出さない）
  const toUnassigned = await call(app, production, 'POST', `/api/props/items/${after.id}/versions`, moveBody(after, 'unassigned'));
  assert.equal(toUnassigned.status, 400);
  assert.match(toUnassigned.data.error, /部署を決めたら状態を未割当から変えてください/);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM prop_item_versions WHERE item_id=?', [before.id])).n), 2);
  // 部署の無い品目は未割当へも戻せる
  const key = byName(await items(app, production), '鍵');
  const adj = await call(app, production, 'POST', `/api/props/items/${key.id}/versions`, moveBody(key, 'adjust'));
  assert.equal(adj.status, 201);
  const back = byName(await items(app, production), '鍵');
  assert.equal((await call(app, production, 'POST', `/api/props/items/${key.id}/versions`, moveBody(back, 'unassigned'))).status, 201);
});

test('FR-PROD-BOARD-006 看板を見られるのは小道具と同じ人で、書けない人は canWrite が false で状態を変えられず、別の組織には品目が見えない', async (t) => {
  const {app, production} = await setup(t);
  const reader = await login(app, 'reader@openingnight.invalid'), nogrant = await login(app, 'nogrant@openingnight.invalid'), outsider = await login(app, 'outsider@other.invalid');
  const read = (await call(app, reader, 'GET', '/api/props?workId=1')).data;
  assert.deepEqual([read.works.find((w) => w.id === 1).canWrite, read.items.length], [false, 4]);
  assert.equal((await call(app, production, 'GET', '/api/props?workId=1')).data.works.find((w) => w.id === 1).canWrite, true);
  const target = byName(read.items, '鍵');
  for (const cookie of [reader, nogrant, outsider]) assert.equal((await call(app, cookie, 'POST', `/api/props/items/${target.id}/versions`, moveBody(target, 'adjust'))).status, 403);
  assert.equal((await call(app, nogrant, 'GET', '/api/props?workId=1')).status, 403);
  assert.equal((await call(app, outsider, 'GET', '/api/props?workId=1')).status, 403);
  const own = (await call(app, outsider, 'GET', '/api/props')).data;
  assert.deepEqual([own.workId, own.items], [2, []]);
});
