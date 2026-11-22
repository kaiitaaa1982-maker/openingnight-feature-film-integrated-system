// 小道具の品目・版・打ち合わせの表（移行 0061）と受け口（src/preprod/props/props-routes.mjs）。架空の作品・品目だけを使う。
// 権限の期待はプリプロの保存と同じ（見る: 案件の所属・管理者、書く: 管理者・制作の所属の制作担当・編集の所属の編集者）。
import {openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';

async function login(app, email) { const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})}); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function call(app, cookie, method, path, body) { const r = await app.request(path, {method, headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, data: await r.json()}; }

test('表の CHECK 制約: 種別・部署・状態・出典・日付の形・未割当の部署の誤りと、書き換え・削除・版の飛び・別の作品の打ち合わせを DB が断る', async (t) => {
  const db = await openTestDb({t});
  const item = (await db.get("INSERT INTO prop_items(org_id,work_id,item_key,created_by) VALUES(1,1,'K-1',1) RETURNING id")).id;
  await assert.rejects(db.run("INSERT INTO prop_items(org_id,work_id,item_key,created_by) VALUES(1,1,'K-1',1)"), '同じ作品で同じ key は1つ');
  const insert = (version, over = {}) => {
    const v = {name: '架空のランタン', kind: 'hand', department: null, state: 'unassigned', source: 'manual', shoot_on: null, due_on: null, meeting_id: null, ...over};
    return db.run(`INSERT INTO prop_item_versions(org_id,item_id,version_no,name,kind,department,state,source,shoot_on,due_on,meeting_id,created_by)
      VALUES(1,?,?,?,?,?,?,?,?,?,?,1)`, [item, version, v.name, v.kind, v.department, v.state, v.source, v.shoot_on, v.due_on, v.meeting_id]);
  };
  await assert.rejects(insert(1, {kind: 'weapon'}));
  await assert.rejects(insert(1, {department: 'sound', state: 'arranging'}));
  await assert.rejects(insert(1, {state: 'lost'}));
  await assert.rejects(insert(1, {source: 'rumor'}));
  await assert.rejects(insert(1, {shoot_on: '2027/01/16'}));
  await assert.rejects(insert(1, {name: '  '}));
  await assert.rejects(insert(1, {department: 'production'}), '未割当のまま部署を持たない');
  await insert(1);
  await assert.rejects(insert(3), /stale prop item version/);
  await insert(2, {department: 'production', state: 'arranging', shoot_on: '2027-01-16'});
  await assert.rejects(db.run("UPDATE prop_item_versions SET name='x'"), /immutable/);
  await assert.rejects(db.run('DELETE FROM prop_items'), /immutable/);
  await assert.rejects(db.run("INSERT INTO prop_meetings(org_id,work_id,held_on,title,created_by) VALUES(1,1,'2027/01/10','架空の打ち合わせ',1)"));
  const project = (await db.get("INSERT INTO projects(org_id,code,title) VALUES(1,'PRJ-PROP','架空の別案件') RETURNING id")).id;
  const otherWork = (await db.get("INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,'WRK-PROP','架空の別作品') RETURNING id", [project])).id;
  const otherMeeting = (await db.get("INSERT INTO prop_meetings(org_id,work_id,held_on,title,created_by) VALUES(1,?,'2027-01-10','架空の打ち合わせ',1) RETURNING id", [otherWork])).id;
  await assert.rejects(insert(3, {meeting_id: otherMeeting, state: 'adjust'}), /another work/);
  await assert.rejects(db.run("UPDATE prop_meetings SET title='x'"), /immutable/);
});

test('品目を作り、版を足して直す。読んだ版が古ければ 409、入力の誤りは 400。一覧は撮影日・シーンの順', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const production = await login(app, 'production@openingnight.invalid');
  const make = async (over) => (await call(app, production, 'POST', '/api/props/items', {workId: 1, name: '架空の湯呑み', kind: 'hand', ...over})).data.id;
  const late = await make({name: '架空の缶コーヒー', kind: 'consumable', shootOn: '2027-01-17', sceneLabel: '#52'});
  const early = await make({name: '架空の手帳', shootOn: '2027-01-16', sceneLabel: '#31・#32', department: 'producer', state: 'arranging', quantity: '1（予備1）'});
  const scene9 = await make({name: '架空の地図', shootOn: '2027-01-16', sceneLabel: '#9'});
  const undated = await make({name: '架空の毛布'});
  assert.equal((await call(app, production, 'POST', '/api/props/items', {workId: 1, name: 'x', kind: 'weapon'})).status, 400);
  assert.equal((await call(app, production, 'POST', '/api/props/items', {workId: 1, name: ''})).status, 400);
  const bad = await call(app, production, 'POST', '/api/props/items', {workId: 1, name: 'x', department: 'production'});
  assert.deepEqual([bad.status, bad.data.error], [400, '部署を決めたら状態を未割当から変えてください']);

  let list = (await call(app, production, 'GET', '/api/props')).data;
  assert.equal(list.workId, 1);
  assert.deepEqual(list.items.map((r) => r.id), [scene9, early, late, undated]);
  const row = list.items.find((r) => r.id === early);
  assert.deepEqual([row.department, row.state, row.quantity, row.versionNo, row.source], ['producer', 'arranging', '1（予備1）', 1, 'manual']);
  assert.equal(list.vocab.states.adjust, '要調整');

  const edit = {name: '架空の缶コーヒー', kind: 'consumable', shootOn: '2027-01-17', sceneLabel: '#52', department: 'production', state: 'adjust', nextAction: '本数を決める', dueOn: '2027-01-12'};
  assert.equal((await call(app, production, 'POST', `/api/props/items/${late}/versions`, {...edit, baseVersionNo: 1})).status, 201);
  assert.equal((await call(app, production, 'POST', `/api/props/items/${late}/versions`, {...edit, state: 'ready', baseVersionNo: 1})).status, 409);
  const detail = (await call(app, production, 'GET', `/api/props/items/${late}`)).data;
  assert.deepEqual(detail.versions.map((v) => [v.versionNo, v.state, v.nextAction]), [[1, 'unassigned', null], [2, 'adjust', '本数を決める']]);
  assert.equal(detail.canWrite, true);
});

test('打ち合わせ: 回を作り、その回で決めた版を一覧にする。別の作品の回は付けられない', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const admin = await login(app, 'admin@openingnight.invalid'), production = await login(app, 'production@openingnight.invalid');
  const id = (await call(app, production, 'POST', '/api/props/items', {workId: 1, name: '架空の折り紙の桜', kind: 'dressing', state: 'adjust', department: 'production'})).data.id;
  const other = (await call(app, production, 'POST', '/api/props/items', {workId: 1, name: '架空のスコップ'})).data.id;
  assert.equal((await call(app, production, 'POST', '/api/props/meetings', {workId: 1, heldOn: '2027/01/10', title: 'x'})).status, 400);
  assert.equal((await call(app, production, 'POST', '/api/props/meetings', {workId: 1, heldOn: '2027-01-10', title: 'x', departments: ['sound']})).status, 400);
  const meeting = (await call(app, production, 'POST', '/api/props/meetings', {workId: 1, heldOn: '2027-01-10', title: '架空の小道具打ち合わせ', departments: ['production', 'producer', 'direction']})).data.id;

  const decide = (itemId, base, over) => call(app, production, 'POST', `/api/props/items/${itemId}/versions`, {name: over.name, kind: 'hand', baseVersionNo: base, meetingId: meeting, ...over});
  assert.equal((await decide(id, 1, {name: '架空の折り紙の桜', kind: 'dressing', department: 'producer', ownerLabel: 'AP', state: 'arranging', nextAction: '両面テープも買う', dueOn: '2027-01-12'})).status, 201);
  assert.equal((await decide(other, 1, {name: '架空のスコップ', department: 'direction', state: 'arranging'})).status, 201);
  assert.equal((await call(app, production, 'POST', `/api/props/items/${other}/versions`, {name: '架空のスコップ', baseVersionNo: 2, meetingId: 999999})).status, 400);

  const project = (await db.get("INSERT INTO projects(org_id,code,title) VALUES(1,'PRJ-PROP2','架空の別案件') RETURNING id")).id;
  const otherWork = (await db.get("INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,'WRK-PROP2','架空の別作品') RETURNING id", [project])).id;
  const foreign = (await call(app, admin, 'POST', '/api/props/meetings', {workId: otherWork, heldOn: '2027-01-11', title: '架空の別の回'})).data.id;
  assert.equal((await call(app, admin, 'POST', `/api/props/items/${other}/versions`, {name: '架空のスコップ', baseVersionNo: 2, meetingId: foreign})).status, 400);

  const got = (await call(app, production, 'GET', `/api/props/meetings/${meeting}`)).data;
  assert.deepEqual(got.meeting.departments, ['production', 'producer', 'direction']);
  assert.deepEqual(got.decisions.map((d) => [d.name, d.department, d.state, d.nextAction]),
    [['架空の折り紙の桜', 'producer', 'arranging', '両面テープも買う'], ['架空のスコップ', 'direction', 'arranging', null]]);
  const list = (await call(app, production, 'GET', '/api/props')).data;
  assert.deepEqual(list.meetings.map((m) => [m.id, m.decided]), [[meeting, 2]]);
  assert.equal(list.items.find((r) => r.id === id).meetingId, meeting);
});

test('取込: 問題があれば何も書かない。2回流しても増えない', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const production = await login(app, 'production@openingnight.invalid');
  const items = [
    {key: 'demo-001', sceneLabel: '#3', shootOn: '2027-01-16', name: '架空のランタン', kind: 'hand', department: 'direction', ownerLabel: '演出A', state: 'arranging', source: 'both', scriptNote: '階段でランタンを掲げる'},
    {key: 'demo-002', sceneLabel: '#5', shootOn: '2027-01-16', name: '架空の朝食', kind: 'consumable', state: 'unassigned', source: 'script'},
  ];
  const broken = await call(app, production, 'POST', '/api/props/import', {workId: 1, items: [...items, {key: 'demo-001', name: '重なり'}, {key: 'demo-003', name: 'x', kind: 'weapon'}]});
  assert.equal(broken.status, 400);
  assert.match(broken.data.error, /3件目: key「demo-001」が重なっています ／ 4件目: 種別を確認してください/);
  assert.equal((await call(app, production, 'GET', '/api/props')).data.items.length, 0);

  const first = await call(app, production, 'POST', '/api/props/import', {workId: 1, items});
  assert.deepEqual([first.status, first.data.created, first.data.skipped], [201, 2, 0]);
  const again = await call(app, production, 'POST', '/api/props/import', {workId: 1, items: [...items, {key: 'demo-003', name: '架空の毛布'}]});
  assert.deepEqual([again.data.created, again.data.skipped], [1, 2]);
  const list = (await call(app, production, 'GET', '/api/props')).data.items;
  assert.deepEqual(list.map((r) => r.key), ['demo-001', 'demo-002', 'demo-003']);
  assert.equal(list[0].scriptNote, '階段でランタンを掲げる');
});

test('見えない作品の品目は一覧にも1件にも出ず、書けない人は直せない。別の組織からは何も見えない', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const admin = await login(app, 'admin@openingnight.invalid'), production = await login(app, 'production@openingnight.invalid');
  const editor = await login(app, 'editor@openingnight.invalid'), outsider = await login(app, 'outsider@other.invalid');
  const hiddenProject = (await db.get("INSERT INTO projects(org_id,code,title) VALUES(1,'PRJ-HIDDEN','架空の別案件') RETURNING id")).id;
  const hiddenWork = (await db.get("INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,'WRK-HIDDEN','架空の別作品') RETURNING id", [hiddenProject])).id;
  const hidden = (await call(app, admin, 'POST', '/api/props/items', {workId: hiddenWork, name: '架空の秘密の箱'})).data.id;
  const visible = (await call(app, editor, 'POST', '/api/props/items', {workId: 1, name: '架空の箱'})).data.id;
  assert.ok(Number.isSafeInteger(visible), '編集の所属の編集者は作れる');
  assert.equal((await call(app, production, 'POST', '/api/props/items', {workId: hiddenWork, name: 'x'})).status, 403);
  assert.equal((await call(app, production, 'GET', `/api/props?workId=${hiddenWork}`)).status, 403);
  const seen = (await call(app, production, 'GET', '/api/props')).data;
  assert.deepEqual([seen.items.map((r) => r.id), seen.works.map((w) => [w.id, w.canWrite])], [[visible], [[1, true]]]);
  assert.equal((await call(app, production, 'GET', `/api/props/items/${hidden}`)).status, 403);
  assert.equal((await call(app, production, 'POST', `/api/props/items/${hidden}/versions`, {name: 'x', baseVersionNo: 1})).status, 403);
  assert.equal((await call(app, production, 'POST', '/api/props/import', {workId: hiddenWork, items: [{key: 'k', name: 'x'}]})).status, 403);

  const other = (await call(app, outsider, 'GET', '/api/props')).data;
  assert.deepEqual(other.items, [], '別の組織には自分の組織の作品しか出ない');
  assert.ok(!other.works.some((w) => w.id === 1));
  assert.equal((await call(app, outsider, 'GET', `/api/props/items/${visible}`)).status, 403);

  await db.run("UPDATE project_memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE org_id=1 AND project_id=1 AND user_id=3");
  assert.equal((await call(app, production, 'POST', `/api/props/items/${visible}/versions`, {name: 'x', baseVersionNo: 1})).status, 403);
});
