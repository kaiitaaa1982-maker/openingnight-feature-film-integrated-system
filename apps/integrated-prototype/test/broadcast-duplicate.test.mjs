// 放送枠の二重登録の修正（WP3 の 0）。同じ作品・同じ放送月・同じ放送局（NFKC にして空白を除いて同じ名前）の生きている枠は1つだけ。
// 壊れたら: 同じ局の枠が2つ確定し、放送履歴の表に同じ局が2回出て、競合の赤にも出ない（全角・半角のゆれは逆に「別局の赤」になる）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {broadcastConflict, broadcastConflictMap} from '../src/broadcast.mjs';
import {findDuplicateSlot, duplicateSlotMap, importDuplicateErrors} from '../src/broadcast/slot-duplicates.mjs';

async function setup(t) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const call = async (path, {method = 'GET', body, cookie = admin} = {}) => {
    const res = await app.request(`/api/broadcast${path}`, {method, headers: {cookie, ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    return {status: res.status, data: await res.json()};
  };
  return {db, call};
}
const slot = (station, month = '2026-11') => ({workId: 1, broadcastMonth: month, stationName: station, periodFrom: `${month}-01`, periodTo: `${month}-28`, plannedRuns: 1, sourceReference: '架空の編成表'});
const move = (call, slotId, baseRevision, status) => call(`/slots/${slotId}/transition`, {method: 'POST', body: {baseRevision, status, reason: '架空の確認'}});
const slotCount = async (db) => Number((await db.get('SELECT COUNT(*) n FROM broadcast_slots')).n);

test('画面・API から同じ作品・同じ月・同じ局の2つ目の放送枠は登録できず、全角・半角や空白の違いも同じ局として止める', async (t) => {
  const {db, call} = await setup(t);
  try {
    const first = await call('/slots', {method: 'POST', body: slot('架空BS放送')});
    assert.equal(first.status, 201);
    for (const variant of ['架空BS放送', '架空ＢＳ放送', ' 架空 BS 放送 ', '架空bs放送']) {
      const again = await call('/slots', {method: 'POST', body: slot(variant)});
      assert.equal(again.status, 409, variant);
      assert.match(again.data.error, new RegExp(`放送枠ID ${first.data.slotId}`));
      assert.match(again.data.error, /全角・半角/);
    }
    assert.equal(await slotCount(db), 1, '拒否した登録は何も残さない');
    // 別の月・別の局は登録できる
    assert.equal((await call('/slots', {method: 'POST', body: slot('架空BS放送', '2026-12')})).status, 201);
    assert.equal((await call('/slots', {method: 'POST', body: slot('架空地上波')})).status, 201);
    assert.equal(await slotCount(db), 3);
    assert.equal(Number((await db.get("SELECT COUNT(*) n FROM audit_log WHERE entity_type='broadcast_slot' AND action='create'")).n), 3, '監査も登録できた3件だけ');
  } finally { await db.close(); }
});

test('中止した枠は数えず同じ局で登録し直せるが、差戻し・下書き・確定の枠は数える', async (t) => {
  const {db, call} = await setup(t);
  try {
    const a = (await call('/slots', {method: 'POST', body: slot('架空CS')})).data.slotId;
    assert.equal((await move(call, a, 1, 'pending_first')).status, 200);
    assert.equal((await move(call, a, 2, 'rejected')).status, 200);
    assert.equal((await call('/slots', {method: 'POST', body: slot('架空ＣＳ')})).status, 409, '差戻しの枠は直して申請し直せるので生きている');
    assert.equal((await move(call, a, 3, 'cancelled')).status, 200);
    const again = await call('/slots', {method: 'POST', body: slot('架空ＣＳ')});
    assert.equal(again.status, 201, '中止の枠は数えない');
    for (const [rev, status] of [[1, 'pending_first'], [2, 'tentative'], [3, 'pending_final'], [4, 'confirmed']]) assert.equal((await move(call, again.data.slotId, rev, status)).status, 200);
    assert.equal((await call('/slots', {method: 'POST', body: slot('架空CS')})).status, 409, '確定の枠と同じ局は登録できない');
  } finally { await db.close(); }
});

test('放送枠を直して別の枠と同じ月・同じ局にすることはできず、自分自身は重なりとみなさない', async (t) => {
  const {db, call} = await setup(t);
  try {
    const a = (await call('/slots', {method: 'POST', body: slot('局A')})).data.slotId;
    const b = (await call('/slots', {method: 'POST', body: slot('局B')})).data.slotId;
    const moved = await call(`/slots/${b}`, {method: 'PATCH', body: {baseRevision: 1, stationName: '局Ａ'}});
    assert.equal(moved.status, 409);
    assert.match(moved.data.error, new RegExp(`放送枠ID ${a}`));
    assert.equal((await call(`/slots/${a}`, {method: 'PATCH', body: {baseRevision: 1, plannedRuns: 3}})).status, 200, '自分の回数だけ直すのは通る');
    assert.equal((await call(`/slots/${b}`, {method: 'PATCH', body: {baseRevision: 1, stationName: '局A', broadcastMonth: '2026-12', periodFrom: '2026-12-01', periodTo: '2026-12-31'}})).status, 200, '別の月なら同じ局へ直せる');
  } finally { await db.close(); }
});

test('競合（同じ月の別の局）の判定は NFKC で比べ、表記ゆれを別局の赤にしない', async () => {
  const base = {work_id: 1, broadcast_month: '2026-11', status: 'confirmed'};
  assert.equal(broadcastConflict({...base, slot_id: 1, station_name: 'ＢＳ架空'}, {...base, slot_id: 2, station_name: 'BS架空'}), null);
  assert.equal(broadcastConflict({...base, slot_id: 1, station_name: 'BS架空'}, {...base, slot_id: 2, station_name: '地上波架空'}), 'red');
  assert.equal(broadcastConflict({...base, slot_id: 1, station_name: 'BS架空'}, {...base, slot_id: 2, station_name: '地上波架空', status: 'tentative'}), 'yellow');
  assert.equal(broadcastConflict({...base, slot_id: 1, station_name: 'BS架空'}, {...base, slot_id: 2, station_name: '地上波架空', status: 'cancelled'}), null, '中止は数えない');
  // 修正より前に入っていた二重登録（同じ局の表記ゆれ3件）: 互いに赤にはせず、二重登録として示す
  const legacy = [{...base, slot_id: 1, station_name: '架空テレビ'}, {...base, slot_id: 2, station_name: '架空テレビ'}, {...base, slot_id: 3, station_name: '架空ﾃﾚﾋﾞ'}];
  const colors = broadcastConflictMap(legacy);
  assert.deepEqual([...colors.values()], [null, null, null]);
  const dups = duplicateSlotMap(legacy);
  assert.deepEqual(dups.get(1), [2, 3]);
  assert.deepEqual(dups.get(3), [1, 2]);
  assert.equal(findDuplicateSlot(legacy, {workId: 1, month: '2026-11', station: '架空テレビ', exceptSlotId: 1})?.slot_id, 2);
  assert.equal(findDuplicateSlot([{...legacy[0], status: 'cancelled'}], {workId: 1, month: '2026-11', station: '架空テレビ'}), null);
});

test('修正前に入った二重登録は一覧で「同じ局の別の枠」として示し、競合の赤にはしない', async (t) => {
  const {db, call} = await setup(t);
  try {
    const a = (await call('/slots', {method: 'POST', body: slot('架空テレビ')})).data.slotId;
    // 修正前の状態を作る（二重登録を API は受け付けないので、同じ内容の枠を表へ直接入れる）
    await db.run('INSERT INTO broadcast_slots(id,org_id,work_id,created_by) VALUES(?,1,1,1)', [a + 1]);
    await db.run("INSERT INTO broadcast_slot_versions(org_id,work_id,slot_id,revision,broadcast_month,station_name,period_from,period_to,planned_runs,status,changed_by) VALUES(1,1,?,1,'2026-11','架空ﾃﾚﾋﾞ','2026-11-01','2026-11-28',1,'draft',1)", [a + 1]);
    const slots = (await call('?workId=1')).data.slots;
    assert.deepEqual(slots.map((s) => s.duplicate_of), [[a + 1], [a]]);
    assert.deepEqual(slots.map((s) => s.conflict), [null, null]);
  } finally { await db.close(); }
});

test('Excel 取込でも二重登録を止める（既存の枠と同じ局・ファイルの中の2行・既存の枠を同じ局へ直す）', async (t) => {
  const {db, call} = await setup(t);
  try {
    const a = (await call('/slots', {method: 'POST', body: slot('局A')})).data.slotId;
    const b = (await call('/slots', {method: 'POST', body: slot('局B')})).data.slotId;
    const headers = ['放送枠ID', '版', '作品コード', '放送月', '放送局', '期間開始', '期間終了', '予定回数', '根拠'];
    const preview = (rows) => call('/import/preview', {method: 'POST', body: {workId: 1, table: {headers, rows}}});
    const newRow = (station, month = '2026-11') => ['', '', 'WRK-DEMO', month, station, `${month}-01`, `${month}-28`, '1', '架空の編成表'];
    // 1. 既存の枠と同じ局（全角）
    let r = await preview([newRow('局Ａ')]);
    assert.equal(r.status, 400);
    assert.match(r.data.details.map((d) => d.message).join(' '), new RegExp(`放送枠ID ${a}にもあります.*放送枠IDと版を入れて`));
    // 2. ファイルの中の2行が同じ局
    r = await preview([newRow('局C'), newRow(' 局Ｃ ')]);
    assert.equal(r.status, 400);
    assert.deepEqual(r.data.failedRows.map((row) => row.rowNo), [2, 3]);
    assert.match(r.data.details[0].message, /3行目にもあります/);
    // 3. 既存の枠 B を A と同じ局へ直す
    r = await preview([[String(b), '1', 'WRK-DEMO', '2026-11', '局A', '2026-11-01', '2026-11-28', '1', '架空の編成表']]);
    assert.equal(r.status, 400);
    // 4. B を別の月へ動かし、空いた局B に新しい枠を足すのは通る（取込後の状態で数える）
    r = await preview([[String(b), '1', 'WRK-DEMO', '2026-12', '局B', '2026-12-01', '2026-12-28', '1', '架空の編成表'], newRow('局B')]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.counts.revise, r.data.counts.append], [1, 1]);
    assert.equal((await call('/import/commit', {method: 'POST', body: {token: r.data.token, confirmed: true}})).status, 201);
    assert.equal(await slotCount(db), 3);
  } finally { await db.close(); }
});

test('取込の確認の後に同じ局の枠が API で登録されたら、登録のときにもう一度止める', async (t) => {
  const {db, call} = await setup(t);
  try {
    const headers = ['作品コード', '放送月', '放送局', '期間開始', '期間終了', '予定回数', '根拠'];
    const r = await call('/import/preview', {method: 'POST', body: {workId: 1, table: {headers, rows: [['WRK-DEMO', '2026-11', '局X', '2026-11-01', '2026-11-28', '1', '架空']]}}});
    assert.equal(r.status, 200);
    assert.equal((await call('/slots', {method: 'POST', body: slot('局Ｘ')})).status, 201);
    const commit = await call('/import/commit', {method: 'POST', body: {token: r.data.token, confirmed: true}});
    assert.equal(commit.status, 409);
    assert.match(commit.data.error, /2行目/);
    assert.equal(await slotCount(db), 1, '取込の枠は入らない');
  } finally { await db.close(); }
});

test('取込の二重判定は取込後の状態で数える（純関数）', () => {
  const current = [{slot_id: 1, work_id: 1, broadcast_month: '2026-11', station_name: '局A', status: 'confirmed'}, {slot_id: 2, work_id: 1, broadcast_month: '2026-11', station_name: '局B', status: 'cancelled'}];
  const errors = importDuplicateErrors(current, [
    {rowNo: 2, action: 'append', slotId: null, value: {broadcast_month: '2026-11', station_name: '局Ｂ'}},
    {rowNo: 3, action: 'append', slotId: null, value: {broadcast_month: '2026-11', station_name: 'きょくA'}},
  ], 1);
  assert.equal(errors.size, 0, '中止の枠と同じ局・別の局は通る');
  const clash = importDuplicateErrors(current, [{rowNo: 5, action: 'append', slotId: null, value: {broadcast_month: '2026-11', station_name: '局A'}}], 1);
  assert.deepEqual([...clash.keys()], [5]);
});

test('申請中から確定までの放送枠（isActiveSlot）: 競合の判定と提案の「同時期の他局」で同じ集合を使う', async () => {
  const {isActiveSlot, ACTIVE_SLOT_STATUSES} = await import('../src/broadcast/slot-duplicates.mjs');
  const table = Object.fromEntries(['draft', 'pending_first', 'tentative', 'pending_final', 'confirmed', 'rejected', 'cancelled'].map((status) => [status, isActiveSlot({status})]));
  assert.deepEqual(table, {draft: false, pending_first: true, tentative: true, pending_final: true, confirmed: true, rejected: false, cancelled: false});
  assert.equal(isActiveSlot(null), false);
  assert.equal(ACTIVE_SLOT_STATUSES.size, 4);
});
