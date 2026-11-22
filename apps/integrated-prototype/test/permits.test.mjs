// 撮影の許可申請の表（移行 0060）と受け口（src/preprod/permits/permit-routes.mjs）。架空の提出先・作品・原本だけを使う。
// 権限の期待はプリプロの保存と同じ（見る: 案件の所属・管理者、書く: 管理者・制作の所属の制作担当・編集の所属の編集者）。
import {openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';
import {registerSourceDocument} from '../src/source-documents/source-documents-store.mjs';

async function login(app, email) { const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})}); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function call(app, cookie, method, path, body) { const r = await app.request(path, {method, headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, data: await r.json()}; }
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

async function office(app, cookie, name, leadBusinessDays, maxSpanDays) {
  const r = await call(app, cookie, 'POST', '/api/permit-offices', {name, leadBusinessDays, maxSpanDays});
  assert.equal(r.status, 201);
  return r.data.id;
}

test('表の CHECK 制約: 種類・状態・手数料・期間・申請日・受け取った日・書類の種類の誤りと、書き換え・削除・版の飛びを DB が断る', async (t) => {
  const db = await openTestDb({t});
  await db.run("INSERT INTO permit_offices(org_id,name,created_by) VALUES(1,'架空署',1)");
  const officeId = (await db.get("SELECT id FROM permit_offices WHERE name='架空署'")).id;
  await assert.rejects(db.run("INSERT INTO permit_offices(org_id,name,created_by) VALUES(1,'架空署',1)"));
  await assert.rejects(db.run('INSERT INTO permit_office_versions(org_id,office_id,version_no,lead_business_days,created_by) VALUES(1,?,1,31,1)', [officeId]));
  await assert.rejects(db.run('INSERT INTO permit_office_versions(org_id,office_id,version_no,max_span_days,created_by) VALUES(1,?,1,0,1)', [officeId]));
  await db.run('INSERT INTO permit_office_versions(org_id,office_id,version_no,lead_business_days,max_span_days,created_by) VALUES(1,?,1,1,15,1)', [officeId]);

  await assert.rejects(db.run("INSERT INTO permit_applications(org_id,work_id,application_key,kind,created_by) VALUES(1,1,'K-0','sky',1)"));
  const app1 = (await db.get("INSERT INTO permit_applications(org_id,work_id,application_key,kind,created_by) VALUES(1,1,'K-1','road',1) RETURNING id")).id;
  const insert = (version, over = {}) => {
    const v = {place: '架空町', starts_on: '2027-01-16', ends_on: '2027-01-16', applied_on: null, pickup_on: null, received_on: null, state: 'draft', fee_yen: null, ...over};
    return db.run(`INSERT INTO permit_application_versions(org_id,application_id,version_no,office_id,place,starts_on,ends_on,applied_on,pickup_on,received_on,state,fee_yen,created_by)
      VALUES(1,?,?,?,?,?,?,?,?,?,?,?,1)`, [app1, version, officeId, v.place, v.starts_on, v.ends_on, v.applied_on, v.pickup_on, v.received_on, v.state, v.fee_yen]);
  };
  await assert.rejects(insert(1, {state: 'lost'}));
  await assert.rejects(insert(1, {state: 'submitted'}), '提出したのに申請日が無い');
  await assert.rejects(insert(1, {fee_yen: -1}));
  await assert.rejects(insert(1, {ends_on: '2027-01-15'}));
  await assert.rejects(insert(1, {starts_on: '2027/01/16'}));
  await assert.rejects(insert(1, {state: 'submitted', applied_on: '2027-01-13', received_on: '2027-01-15'}), '提出のまま受け取った日');
  await assert.rejects(insert(1, {state: 'permitted', applied_on: '2027-01-13', received_on: '2027-01-12'}), '申請より前に受け取った');
  await assert.rejects(insert(1, {state: 'submitted', applied_on: '2027-01-13', pickup_on: '2027-01-12'}));
  await insert(1, {fee_yen: 0});
  await assert.rejects(insert(3), /stale permit application version/);
  await insert(2, {state: 'permitted', applied_on: '2027-01-13', pickup_on: '2027-01-15', received_on: '2027-01-15', fee_yen: 2500});
  await assert.rejects(db.run("UPDATE permit_application_versions SET place='x'"), /immutable/);
  await assert.rejects(db.run('DELETE FROM permit_applications'), /immutable/);

  const {id: doc} = await registerSourceDocument(db, {orgId: 1, userId: 1, kind: 'other', fileName: '架空の許可証.pdf', receivedOn: '2027-01-15', bytes: new TextEncoder().encode('架空の許可証')});
  await assert.rejects(db.run("INSERT INTO permit_application_documents(org_id,application_id,document_id,role,linked_by) VALUES(1,?,?,'photo',1)", [app1, doc]));
  await db.run("INSERT INTO permit_application_documents(org_id,application_id,document_id,role,linked_by) VALUES(1,?,?,'permit',1)", [app1, doc]);
  await assert.rejects(db.run("INSERT INTO permit_application_documents(org_id,application_id,document_id,role,linked_by) VALUES(1,?,?,'notice',1)", [app1, doc]), '同じ原本を2回結ばない');
  // 別の組織の作品・原本は指せない（外部キーは組織ごと）
  await assert.rejects(db.run("INSERT INTO permit_applications(org_id,work_id,application_key,kind,created_by) VALUES(1,2,'K-2','road',1)"));
});

test('申請を作り、版を足して直し、状態を変える。読んだ版が古ければ 409、期間の上限を超えれば 400', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const admin = await login(app, 'admin@openingnight.invalid'), production = await login(app, 'production@openingnight.invalid');
  const officeId = await office(app, production, '架空署', 1, 15);
  const noRule = await office(app, admin, '架空市 公園課', null, null);
  assert.equal((await call(app, admin, 'POST', '/api/permit-offices', {name: '架空署', leadBusinessDays: 2})).status, 409);

  const created = await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'road', officeId, place: '架空町1丁目', startsOn: '2027-01-16', endsOn: '2027-01-16', feeYen: 2500});
  assert.equal(created.status, 201);
  const id = created.data.id;
  // 期間の上限: 15日ちょうどは通り、16日は断る。上限の無い提出先は通す
  assert.equal((await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'road', officeId, place: '架空通り', startsOn: '2027-02-01', endsOn: '2027-02-15'})).status, 201);
  const over = await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'road', officeId, place: '架空通り', startsOn: '2027-02-01', endsOn: '2027-02-16'});
  assert.deepEqual([over.status, over.data.error], [400, 'この提出先にまとめて申請できるのは15日までです（16日）']);
  assert.equal((await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'park', officeId: noRule, place: '架空の森公園', startsOn: '2027-02-01', endsOn: '2027-03-31'})).status, 201);
  // 入力の誤り
  assert.equal((await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'sky', officeId, place: 'x', startsOn: '2027-01-16'})).status, 400);
  assert.equal((await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'road', officeId, place: 'x', startsOn: '2027-01-16', feeYen: 1.5})).status, 400);
  assert.equal((await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'road', officeId, place: 'x', startsOn: '2027-01-16', state: 'submitted'})).data.error, '提出したあとの状態には申請日を入れてください');

  let list = (await call(app, production, 'GET', '/api/permits')).data;
  let row = list.applications.find((r) => r.id === id);
  assert.deepEqual([row.workTitle, row.kind, row.officeName, row.state, row.feeYen, row.applyBy, row.pickupBy, row.documentCount, row.versionNo],
    ['風のあとさき', 'road', '架空署', 'draft', 2500, '2027-01-13', '2027-01-15', 0, 1]);
  assert.deepEqual(list.applications.find((r) => r.kind === 'park').applyBy, null, '日数が未確定の提出先は最終日を出さない');

  // 直す（版2）。古い版の番号では 409
  const edit = {officeId, place: '架空町2丁目', startsOn: '2027-01-16', endsOn: '2027-01-16', feeYen: 2500};
  assert.equal((await call(app, production, 'POST', `/api/permits/${id}/versions`, {...edit, baseVersionNo: 1})).status, 201);
  const stale = await call(app, production, 'POST', `/api/permits/${id}/versions`, {...edit, place: '架空町3丁目', baseVersionNo: 1});
  assert.equal(stale.status, 409);
  // 状態を変える（版3・版4）。中身は前の版を写す
  assert.equal((await call(app, production, 'POST', `/api/permits/${id}/state`, {state: 'submitted', baseVersionNo: 2})).status, 400, '申請日なしの提出は断る');
  assert.equal((await call(app, production, 'POST', `/api/permits/${id}/state`, {state: 'submitted', appliedOn: '2027-01-13', pickupOn: '2027-01-15', baseVersionNo: 2})).status, 201);
  assert.equal((await call(app, production, 'POST', `/api/permits/${id}/state`, {state: 'returned', baseVersionNo: 3})).status, 201);
  list = (await call(app, production, 'GET', '/api/permits')).data;
  row = list.applications.find((r) => r.id === id);
  assert.deepEqual([row.versionNo, row.place, row.state, row.appliedOn, row.pickupOn, row.alert], [4, '架空町2丁目', 'returned', '2027-01-13', '2027-01-15', 'returned']);
  const detail = (await call(app, production, 'GET', `/api/permits/${id}`)).data;
  assert.deepEqual(detail.versions.map((v) => v.state), ['draft', 'draft', 'submitted', 'returned']);

  // 準備のまま申請の最終日を過ぎた行は late（過去の架空の日付で確かめる）
  const late = (await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'facility', officeId, place: '架空体育館', startsOn: '2020-01-10'})).data.id;
  list = (await call(app, production, 'GET', '/api/permits')).data;
  assert.equal(list.applications.find((r) => r.id === late).alert, 'late');

  // 絞り込み
  assert.deepEqual((await call(app, production, 'GET', '/api/permits?kind=park')).data.applications.map((r) => r.kind), ['park']);
  assert.deepEqual((await call(app, production, 'GET', `/api/permits?state=returned&officeId=${officeId}`)).data.applications.map((r) => r.id), [id]);
  assert.equal((await call(app, production, 'GET', '/api/permits?kind=sky')).status, 400);

  // 提出先の設定の版（楽観ロック）
  assert.equal((await call(app, production, 'POST', `/api/permit-offices/${officeId}/versions`, {name: '架空署', leadBusinessDays: 2, maxSpanDays: 15, baseVersionNo: 1})).status, 201);
  assert.equal((await call(app, production, 'POST', `/api/permit-offices/${officeId}/versions`, {name: '架空署', leadBusinessDays: 3, baseVersionNo: 1})).status, 409);
  assert.equal((await call(app, production, 'POST', `/api/permit-offices/${officeId}/versions`, {name: '別の名前', baseVersionNo: 2})).status, 400);
  list = (await call(app, production, 'GET', '/api/permits')).data;
  assert.deepEqual(list.offices.find((o) => o.id === officeId), {id: officeId, name: '架空署', versionNo: 2, leadBusinessDays: 2, maxSpanDays: 15, note: null});
});

test('見えない作品の申請は一覧にも1件にも出ず、書けない人は直せない。別の組織からは何も見えない', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const admin = await login(app, 'admin@openingnight.invalid'), production = await login(app, 'production@openingnight.invalid');
  const editor = await login(app, 'editor@openingnight.invalid'), outsider = await login(app, 'outsider@other.invalid');
  const hiddenProject = (await db.get("INSERT INTO projects(org_id,code,title) VALUES(1,'PRJ-HIDDEN','架空の別案件') RETURNING id")).id;
  const hiddenWork = (await db.get("INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,'WRK-HIDDEN','架空の別作品') RETURNING id", [hiddenProject])).id;
  const officeId = await office(app, admin, '架空北署', 2, null);
  const body = (workId) => ({workId, kind: 'road', officeId, place: '架空坂', startsOn: '2027-01-20'});

  const hidden = (await call(app, admin, 'POST', '/api/permits', body(hiddenWork))).data.id;
  const visible = (await call(app, editor, 'POST', '/api/permits', body(1))).data.id;
  assert.ok(Number.isSafeInteger(visible), '編集の所属の編集者は作れる');
  assert.equal((await call(app, production, 'POST', '/api/permits', body(hiddenWork))).status, 403);

  const seen = (await call(app, production, 'GET', '/api/permits')).data;
  assert.deepEqual(seen.applications.map((r) => r.id), [visible]);
  assert.deepEqual(seen.works.map((w) => [w.id, w.canWrite]), [[1, true]]);
  assert.equal((await call(app, production, 'GET', `/api/permits/${hidden}`)).status, 403);
  assert.equal((await call(app, production, 'POST', `/api/permits/${hidden}/versions`, {...body(hiddenWork), baseVersionNo: 1})).status, 403);
  assert.equal((await call(app, production, 'POST', `/api/permits/${hidden}/state`, {state: 'withdrawn', baseVersionNo: 1})).status, 403);
  assert.deepEqual((await call(app, admin, 'GET', '/api/permits')).data.applications.map((r) => r.id).sort((a, b) => a - b), [hidden, visible].sort((a, b) => a - b));

  const other = await call(app, outsider, 'GET', '/api/permits');
  assert.deepEqual([other.data.applications, other.data.offices], [[], []]);
  assert.equal((await call(app, outsider, 'GET', `/api/permits/${visible}`)).status, 403);
  assert.equal((await call(app, outsider, 'POST', `/api/permits/${visible}/state`, {state: 'withdrawn', baseVersionNo: 1})).status, 403);
  assert.equal((await call(app, outsider, 'POST', `/api/permit-offices/${officeId}/versions`, {name: '架空北署', baseVersionNo: 1})).status, 404);

  // 期限切れの所属は書けない（制作担当の所属を過去で切る）
  await db.run("UPDATE project_memberships SET expires_at='2000-01-01T00:00:00.000Z' WHERE org_id=1 AND project_id=1 AND user_id=3");
  assert.equal((await call(app, production, 'POST', `/api/permits/${visible}/state`, {state: 'withdrawn', baseVersionNo: 1})).status, 403);
  assert.deepEqual((await call(app, production, 'GET', '/api/permits')).data.applications, []);
});

test('原本の結び付け: 制作担当は作品の保管庫に置いた原本だけ、管理者は組織の原本を結べる。同じ原本の2回目と別の作品は断る', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const admin = await login(app, 'admin@openingnight.invalid'), production = await login(app, 'production@openingnight.invalid');
  const officeId = await office(app, production, '架空署', 1, 15);
  const id = (await call(app, production, 'POST', '/api/permits', {workId: 1, kind: 'road', officeId, place: '架空町', startsOn: '2027-01-16'})).data.id;

  const placed = await app.request('/api/preprod/works/1/documents', {method: 'POST', headers: {cookie: production, 'content-type': 'application/json'},
    body: JSON.stringify({fileName: '架空の申請書.pdf', mediaType: 'application/pdf', base64: b64('架空の申請書'), category: 'location'})});
  const vaultDoc = (await placed.json()).id;
  const {id: looseDoc} = await registerSourceDocument(db, {orgId: 1, userId: 1, kind: 'other', fileName: '架空の通知書.pdf', receivedOn: '2027-01-15', bytes: new TextEncoder().encode('架空の通知書')});

  assert.equal((await call(app, production, 'POST', `/api/permits/${id}/documents`, {documentId: vaultDoc, role: 'application'})).status, 201);
  assert.equal((await call(app, production, 'POST', `/api/permits/${id}/documents`, {documentId: vaultDoc, role: 'sketch'})).status, 409);
  assert.equal((await call(app, production, 'POST', `/api/permits/${id}/documents`, {documentId: looseDoc, role: 'notice'})).status, 403, '保管庫に無い原本');
  assert.equal((await call(app, production, 'POST', `/api/permits/${id}/documents`, {documentId: vaultDoc, role: 'photo'})).status, 400);
  assert.equal((await call(app, admin, 'POST', `/api/permits/${id}/documents`, {documentId: looseDoc, role: 'notice'})).status, 201);
  assert.equal((await call(app, admin, 'POST', `/api/permits/${id}/documents`, {documentId: 999999, role: 'notice'})).status, 403);

  const detail = (await call(app, production, 'GET', `/api/permits/${id}`)).data;
  assert.deepEqual(detail.documents.map((d) => [d.role, d.file_name]), [['application', '架空の申請書.pdf'], ['notice', '架空の通知書.pdf']]);
  assert.equal(detail.canWrite, true);
  const row = (await call(app, production, 'GET', '/api/permits')).data.applications.find((r) => r.id === id);
  assert.equal(row.documentCount, 2);
});
