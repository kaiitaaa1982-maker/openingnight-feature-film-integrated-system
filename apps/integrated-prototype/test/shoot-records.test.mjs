// 撮影の記録（移行 0051）を、DB の制約と受け口（src/production/shoot-records/shoot-records-routes.mjs）で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は会社ルートの plans/2026-10-22-folder-prod.md（問い1〜7 は A）から手で書いた。架空のデータだけを使う（組織1・2と利用者・作品1は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {buildMatrix, cellState, currentItems, normalizeRecordInput} from '../src/production/shoot-records/shoot-records-model.mjs';

const WORK = 1;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function setup(t) {
  const db = await openTestDb({t});
  // 架空の撮影日3日（1日目・2日目・予備日）とシーン3つ。2日目に S#12・S#21 を割り当てる
  for (const [id, no] of [[901, '12'], [902, '13'], [903, '21']]) {
    await db.run('INSERT INTO scenes(id,org_id,project_id,work_id,scene_no,synopsis) VALUES(?,1,1,?,?,?)', [id, WORK, no, '架空']);
  }
  for (const [id, date, label] of [[801, '2026-10-03', '1日目'], [802, '2026-10-04', '2日目'], [805, '2026-10-08', '予備日']]) {
    await db.run('INSERT INTO shooting_days(id,org_id,project_id,work_id,shoot_date,unit,label,created_by) VALUES(?,1,1,?,?,?,?,1)', [id, WORK, date, 'A班', label]);
  }
  await db.run('INSERT INTO day_scene_assignments(org_id,work_id,shooting_day_id,scene_id,sequence_order) VALUES(1,?,802,901,1),(1,?,802,903,2),(1,?,801,902,1)', [WORK, WORK, WORK]);
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
  return {db, login, call};
}

test('撮影の結果: 順延は移し先と結び、最新の行が今の結果になり、全シーンの進みは最後の移し先で数える。DB は書き換えと消去を断る', async (t) => {
  const {db, login, call} = await setup(t);
  const production = await login('production@openingnight.invalid');
  const day = '/production/shoot-records/days/802';
  assert.equal((await call(production, `${day}/results`, {method: 'POST', payload: {sceneId: 901, result: 'shot', actualStart: '08:45', actualEnd: '10:05'}})).status, 201);
  assert.equal((await call(production, `${day}/results`, {method: 'POST', payload: {sceneId: 903, result: 'postponed', postponedToDayId: 805}})).status, 201);
  const detail = await call(production, day);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.scenes.map((s) => [s.sceneNo, s.latest?.result]), [['12', 'shot'], ['21', 'postponed']]);
  assert.deepEqual(detail.body.missed.map((s) => [s.sceneNo, s.latest.postponedToDayId]), [['21', 805]]);
  // 予備日へ移ってきたシーンは、予備日の画面に出て結果を付けられる
  const spare = await call(production, '/production/shoot-records/days/805');
  assert.deepEqual(spare.body.incoming.map((s) => [s.sceneNo, s.fromDayId]), [['21', 802]]);
  assert.equal((await call(production, '/production/shoot-records/days/805/results', {method: 'POST', payload: {sceneId: 903, result: 'shot'}})).status, 201);
  const matrix = await call(production, `/production/shoot-records?workId=${WORK}`);
  assert.deepEqual(matrix.body.progress, {scenes: 3, shot: 2, partial: 0, postponed: 0, dropped: 0, none: 1, unassignedPostponed: 0});
  // 予備日は移し先になったので「不要」でなく通常の日（架空の撮影日はどれも過去なので、届いていない記録は 遅れ）
  const spareRow = matrix.body.rows.find((r) => r.dayId === 805);
  assert.deepEqual([spareRow.spare, spareRow.used, spareRow.cells.ad.state], [true, true, 'late']);
  // 同じシーンの結果を直すと連番が進み、前の行は残る
  assert.equal((await call(production, `${day}/results`, {method: 'POST', payload: {sceneId: 901, result: 'partial'}})).status, 201);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM shooting_scene_results WHERE org_id=1 AND scene_id=901')).n), 2);
  await assert.rejects(db.run("UPDATE shooting_scene_results SET result='dropped' WHERE org_id=1"), (e) => dbErrorKind(e) === 'raise' && /immutable/.test(e.message));
  await assert.rejects(db.run('DELETE FROM shooting_scene_results WHERE org_id=1'), (e) => dbErrorKind(e) === 'raise' && /immutable/.test(e.message));
  // 移し先は同じ作品の別の撮影日だけ
  assert.equal((await call(production, `${day}/results`, {method: 'POST', payload: {sceneId: 901, result: 'postponed', postponedToDayId: 802}})).status, 400);
  assert.equal((await call(production, `${day}/results`, {method: 'POST', payload: {sceneId: 901, result: 'shot', actualStart: '10:00', actualEnd: '09:00'}})).status, 400);
});

test('原本を置くとマスが変わり、同じ原本は二度受け取らず、「不要」は理由つきで残る。部署の日報は項目が入るまで 要確認', async (t) => {
  const {login, call} = await setup(t);
  const production = await login('production@openingnight.invalid');
  const day = '/production/shoot-records/days/802';
  const put = (payload) => call(production, `${day}/records`, {method: 'POST', payload});
  assert.equal((await put({kind: 'schedule', fileName: '日々スケ_1004.png', mimeType: 'image/png', base64: PNG})).status, 201);
  assert.equal((await put({kind: 'schedule', fileName: '日々スケ_1004.png', mimeType: 'image/png', base64: PNG})).status, 409);
  assert.equal((await put({kind: 'art', fileName: '美術日報.png', mimeType: 'image/png', base64: PNG})).status, 201);
  // スマホの写真は 500KB を超える（受け口の本文の上限は、この受け口だけ 8MB）
  const large = Buffer.from(new Uint8Array(700_000).map((_, i) => (i * 31 + 7) % 256)).toString('base64');
  assert.equal((await put({kind: 'camera', fileName: '撮影部日報.jpg', mimeType: 'image/jpeg', base64: large})).status, 201);
  assert.equal((await put({kind: 'sound', notNeeded: true, reason: 'この日は入らない'})).status, 201);
  assert.equal((await put({kind: 'camera', notNeeded: true})).status, 400);
  assert.equal((await put({kind: 'camera', fileName: 'x.exe', mimeType: 'application/x-msdownload', base64: PNG})).status, 400);
  let row = (await call(production, `/production/shoot-records?workId=${WORK}`)).body.rows.find((r) => r.dayId === 802);
  assert.deepEqual(['schedule', 'art', 'sound', 'camera', 'production'].map((k) => row.cells[k].state), ['done', 'review', 'none', 'review', 'late']);
  // 美術部の項目を入れると 済み になる。取り下げると元に戻る
  const art = (await call(production, day)).body.records.find((r) => r.kind === 'art');
  assert.equal((await call(production, `${day}/items`, {method: 'POST', payload: {department: 'art', itemType: 'handover', body: 'S#30 の看板、翌日差し替え', recordId: art.id}})).status, 201);
  row = (await call(production, `/production/shoot-records?workId=${WORK}`)).body.rows.find((r) => r.dayId === 802);
  assert.equal(row.cells.art.state, 'done');
  const item = (await call(production, day)).body.items.find((x) => x.department === 'art');
  assert.equal((await call(production, `${day}/items`, {method: 'POST', payload: {department: 'art', itemType: 'handover', withdraw: true, replacesId: item.id}})).status, 201);
  assert.equal((await call(production, `${day}/items`, {method: 'POST', payload: {department: 'art', itemType: 'handover', withdraw: true, replacesId: item.id}})).status, 409);
  row = (await call(production, `/production/shoot-records?workId=${WORK}`)).body.rows.find((r) => r.dayId === 802);
  assert.equal(row.cells.art.state, 'review');
  // 置いた原本を読み戻せる（中身が一致する）
  const original = await call(production, `/production/shoot-records/records/${art.id}/original`);
  assert.deepEqual([original.status, original.body.base64, original.body.mimeType], [200, PNG, 'image/png']);
});

test('権限: 読めるのは案件に所属する人、書けるのは管理者と制作の権限を持つ人。別の組織は見えず、事故・けがの項目は書けない人に出さない', async (t) => {
  const {db, login, call} = await setup(t);
  const admin = await login('admin@openingnight.invalid');
  const day = '/production/shoot-records/days/802';
  assert.equal((await call(admin, `${day}/items`, {method: 'POST', payload: {department: 'ad', itemType: 'incident', body: '架空: 小道具で指を切った'}})).status, 201);
  assert.equal((await call(admin, `${day}/items`, {method: 'POST', payload: {department: 'ad', itemType: 'handover', body: '翌日は8時集合'}})).status, 201);
  // 編集担当を読み取りだけにする（案件の権限を外し、所属は残す）ための行は無いので、所属の無い作品で確かめる: 別の組織の利用者
  const outsider = await login('outsider@other.invalid');
  assert.equal((await call(outsider, `/production/shoot-records?workId=${WORK}`)).status, 403);
  assert.equal((await call(outsider, day)).status, 403);
  assert.equal((await call(outsider, `${day}/results`, {method: 'POST', payload: {sceneId: 901, result: 'shot'}})).status, 403);
  // 編集担当は案件の権限が edit なので書ける。事故・けがも読める
  const editor = await login('editor@openingnight.invalid');
  assert.equal((await call(editor, day)).body.items.length, 2);
  // 書けない人（権限の行を消した制作担当）は読めるが、事故・けがは出ず、書き込みは 403
  await db.run("UPDATE project_memberships SET permission='edit' WHERE org_id=1 AND project_id=1 AND user_id=3");
  const production = await login('production@openingnight.invalid');
  const read = await call(production, day);
  assert.equal(read.status, 200);
  assert.equal(read.body.canWrite, false);
  assert.deepEqual(read.body.items.map((x) => x.itemType), ['handover']);
  assert.equal((await call(production, `${day}/results`, {method: 'POST', payload: {sceneId: 901, result: 'shot'}})).status, 403);
});

test('マスの判定（純関数）: 期限は撮影日の翌日、予備日は移し先になるまで不要、取り下げと直しの行は数えない', () => {
  assert.equal(cellState({kind: 'ad', shootDate: '2026-10-04', today: '2026-10-05'}), 'open');
  assert.equal(cellState({kind: 'ad', shootDate: '2026-10-04', today: '2026-10-06'}), 'late');
  assert.equal(cellState({kind: 'ad', shootDate: '2026-10-08', today: '2026-10-20', spare: true}), 'none');
  assert.equal(cellState({kind: 'ad', shootDate: '2026-10-08', today: '2026-10-20', spare: true, used: true}), 'late');
  assert.equal(cellState({kind: 'script', record: {status: 'placed'}, shootDate: '2026-10-04', today: '2026-10-04'}), 'done');
  const items = [{id: 1, status: 'active'}, {id: 2, status: 'active', replaces_id: 1}, {id: 3, status: 'active'}, {id: 4, status: 'withdrawn', replaces_id: 3}];
  assert.deepEqual(currentItems(items).map((x) => x.id), [2]);
  const matrix = buildMatrix({days: [{id: 1, shoot_date: '2026-10-04', unit: 'A', label: '1日目'}], assignments: [], records: [], items: [], results: [], today: '2026-10-04'});
  assert.deepEqual(matrix.rows[0].cells.schedule, {state: 'open', itemCount: 0, recordId: null});
  assert.throws(() => normalizeRecordInput({kind: 'art', fileName: 'a.png', mimeType: 'image/png', base64: 'A'.repeat(8_000_004)}), /6MB/);
});
