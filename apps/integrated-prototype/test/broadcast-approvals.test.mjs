import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerBroadcastApprovalRoutes} from '../src/broadcast/broadcast-approvals-routes.mjs';

async function setup(t) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  registerBroadcastApprovalRoutes(app, app.ux);
  // 架空の2つ目の案件・作品（編集担当はこの案件の権限を持たない）
  await db.run("INSERT INTO projects(id,org_id,code,title,status,budget_yen) VALUES(3,1,'PRJ-SECOND','架空の二本目','active',1000000)");
  await db.run("INSERT INTO works(id,org_id,project_id,code,title,format,forecast_yen) VALUES(3,1,3,'WRK-SECOND','架空の二本目','film',1000000)");
  // 架空の放送局（取引先の区分に「放送局」）
  await db.run("INSERT INTO partners(id,org_id,code,name,kind) VALUES(10,1,'PT-TV','架空テレビ','other')");
  await db.run("INSERT INTO partner_profile_versions(org_id,partner_id,version_no,roles_json,created_by) VALUES(1,10,1,'[\"broadcaster\",\"customer\"]',1)");
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const cookies = {admin: await login('admin@openingnight.invalid'), editor: await login('editor@openingnight.invalid'), production: await login('production@openingnight.invalid'), outsider: await login('outsider@other.invalid')};
  const call = async (path, {method = 'GET', body, as = 'admin'} = {}) => {
    const r = await app.request(`/api${path}`, {method, headers: {cookie: cookies[as], ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    return {status: r.status, data: await r.json()};
  };
  const slot = async (workId, station, month = '2026-11') => {
    const r = await call('/broadcast/slots', {method: 'POST', body: {workId, broadcastMonth: month, stationName: station, periodFrom: `${month}-01`, periodTo: `${month}-28`, plannedRuns: 1, sourceReference: '架空編成表'}});
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.slotId;
  };
  const move = async (slotId, baseRevision, status, as = 'admin', reason = '架空確認') => call(`/broadcast/slots/${slotId}/transition`, {method: 'POST', body: {baseRevision, status, reason}, as});
  return {db, call, slot, move};
}

test('approval queue lists pending slots across works without switching the work', async (t) => {
  const {db, call, slot, move} = await setup(t);
  try {
    const a = await slot(1, '架空テレビ');
    const b = await slot(3, '未登録の架空局');
    const draftOnly = await slot(1, '下書きだけの局', '2026-12');
    assert.equal((await move(a, 1, 'pending_first')).status, 200);
    assert.equal((await move(b, 1, 'pending_first')).status, 200);
    assert.equal((await move(b, 2, 'tentative')).status, 200);
    assert.equal((await move(b, 3, 'pending_final')).status, 200);

    const list = await call('/broadcast/approvals');
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.deepEqual(list.data.rows.map((row) => row.slotId).sort(), [a, b].sort(), 'both works appear; the draft does not');
    const first = list.data.rows.find((row) => row.slotId === a);
    const final = list.data.rows.find((row) => row.slotId === b);
    assert.equal(first.status, 'pending_first');
    assert.equal(first.workCode, 'WRK-DEMO');
    assert.equal(first.stationRegistered, true, 'the station matches a partner with the broadcaster role');
    assert.equal(final.status, 'pending_final');
    assert.equal(final.workCode, 'WRK-SECOND');
    assert.equal(final.stationRegistered, false, '未登録の局');
    assert.equal(first.canApprove, true);
    assert.equal(list.data.counts.draft, 1);
    assert.equal(list.data.approvalRole, true);
    assert.ok(first.requestedAt, 'the time of the request is returned for the waiting days');

    const open = await call('/broadcast/approvals?scope=open');
    assert.ok(open.data.rows.some((row) => row.slotId === draftOnly), 'scope=open includes drafts that still need an application');
    assert.equal(open.data.rows[0].status.startsWith('pending'), true, 'pending approvals come first');

    // その場で承認・差し戻しすると一覧から消える（既存の遷移APIを使う）
    assert.equal((await move(a, 2, 'tentative')).status, 200);
    assert.equal((await move(b, 4, 'rejected', 'admin', '期間を確認してください')).status, 200);
    const after = await call('/broadcast/approvals');
    assert.deepEqual(after.data.rows, []);
    const rejected = (await call('/broadcast/approvals?scope=open')).data.rows.find((row) => row.slotId === b);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, '期間を確認してください', 'the reason of the send-back is shown to the requester');
    assert.deepEqual(await foreignKeyViolations(db), []);
  } finally {
    await db.close();
  }
});

test('approval queue hides works outside the permission, and production gets 403', async (t) => {
  const {db, call, slot, move} = await setup(t);
  try {
    const mine = await slot(1, '架空テレビ');
    const other = await slot(3, '別案件の局');
    for (const id of [mine, other]) assert.equal((await move(id, 1, 'pending_first')).status, 200);

    const editor = await call('/broadcast/approvals', {as: 'editor'});
    assert.equal(editor.status, 200);
    assert.deepEqual(editor.data.rows.map((row) => row.slotId), [mine], 'the editor sees only the project with membership');
    assert.equal(editor.data.rows[0].canApprove, false, 'approving is for the manager only');
    assert.equal(editor.data.rows[0].canEdit, true);
    assert.equal(editor.data.approvalRole, false);
    assert.ok(!editor.data.works.some((work) => work.id === 3));

    assert.equal((await call('/broadcast/approvals', {as: 'production'})).status, 403);
    const outsider = await call('/broadcast/approvals', {as: 'outsider'});
    assert.equal(outsider.status, 200);
    assert.deepEqual(outsider.data.rows, [], 'another organization sees none of these slots');

    // 編集担当は承認できない（既存の遷移APIの権限）
    assert.equal((await move(mine, 2, 'tentative', 'editor')).status, 403);
  } finally {
    await db.close();
  }
});

test('approval rows carry the conflict with another station in the same month', async (t) => {
  const {db, call, slot, move} = await setup(t);
  try {
    const a = await slot(1, '架空テレビ');
    const b = await slot(1, '別の架空局');
    for (const id of [a, b]) {
      assert.equal((await move(id, 1, 'pending_first')).status, 200);
      assert.equal((await move(id, 2, 'tentative')).status, 200);
    }
    assert.equal((await move(b, 3, 'pending_final')).status, 200);
    assert.equal((await move(b, 4, 'confirmed')).status, 200);
    assert.equal((await move(a, 3, 'pending_final')).status, 200);
    const row = (await call('/broadcast/approvals')).data.rows.find((item) => item.slotId === a);
    assert.equal(row.conflict, 'yellow');
    assert.deepEqual(row.conflictWith.map((item) => [item.stationName, item.status]), [['別の架空局', 'confirmed']]);
  } finally {
    await db.close();
  }
});
