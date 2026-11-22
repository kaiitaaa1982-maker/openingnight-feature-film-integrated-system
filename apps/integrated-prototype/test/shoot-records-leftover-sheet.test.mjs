// 撮影の記録の「未解決」の画面の論理（src/production/shoot-records/leftover-sheet-model.mjs）と、全シーンの札
// （scene-states-model.mjs・GET /api/production/shoot-records/leftover?scenes=all）、ホームからの入り方（view=leftover）を確かめる。
// ON_TEST_DB=pg で受け口の試験が PostgreSQL で流れる。期待値は会社ルートの plans/2026-11-20-genba-inbox.md の手順 14b と
// 要件 docs/requirements/production/schedule-commit.md の FR-PROD-SCHED-099〜102 から手で書いた。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {deriveLeftover} from '../src/production/shoot-records/leftover-model.mjs';
import {sceneStateCounts, sceneStates} from '../src/production/shoot-records/scene-states-model.mjs';
import {DROP, dayOptionLabel, leftoverColumns, leftoverRequests, leftoverSheetRows, moveOptions, sceneSheetRows, viewOf} from '../src/production/shoot-records/leftover-sheet-model.mjs';
import {sheetColumns} from '../src/ui/edit-sheet-model.mjs';
import {addDays} from '../src/production/shoot-records/shoot-records-model.mjs';
import {todayInJapan} from '../src/production/shoot-records/shoot-records-routes.mjs';

const TODAY = '2026-11-20';
const UPCOMING = [{id: 23, shootDate: '2026-11-21', unit: 'A班', label: '3日目', spare: false}, {id: 24, shootDate: '2027-01-08', unit: 'B班', label: null, spare: false}];
const API_ROWS = [
  {sceneId: 101, workId: 1, sceneNo: '5', location: '架空の坂道', reason: 'no_result', reasonLabel: '結果なし', lastDayId: 21, lastShootDate: '2026-11-17', lastResult: null},
  {sceneId: 102, workId: 1, sceneNo: '14', location: null, reason: 'partial', reasonLabel: '一部', lastDayId: 22, lastShootDate: '2026-11-19', lastResult: 'partial'},
];

test('FR-PROD-SCHED-099 未解決の表: 受け口の行を S#・場所・元の日・結果・理由・移し先の行にし、直せるのは移し先だけ（候補は今日以降の撮影日と欠番）', () => {
  assert.deepEqual(leftoverSheetRows(API_ROWS), [
    {id: 'scene:101', sceneId: 101, lastDayId: 21, s: '5', place: '架空の坂道', from: '2026-11-17', result: 'なし', reason: '結果なし', to: ''},
    {id: 'scene:102', sceneId: 102, lastDayId: 22, s: '14', place: '', from: '2026-11-19', result: '一部', reason: '一部', to: ''},
  ]);
  // 候補の名前は「月/日 撮影日の名前」。名前が無ければ班、今日と年が違えば年を付ける。最後は欠番
  assert.deepEqual(moveOptions(UPCOMING, {year: 2026}), [{value: '23', label: '11/21 3日目'}, {value: '24', label: '2027/1/08 B班'}, {value: DROP, label: '欠番'}]);
  assert.equal(dayOptionLabel({shootDate: '2026-11-21', unit: '', label: ''}, 2026), '11/21');
  const columns = sheetColumns(leftoverColumns({options: moveOptions(UPCOMING, {year: 2026}), year: 2026}));
  assert.deepEqual(columns.map((column) => column.label), ['S#', '場所', '元の日', '結果', '理由', '移し先']);
  assert.deepEqual(columns.filter((column) => column.editable).map((column) => [column.key, column.type]), [['to', 'lookup']]);
  // 移し先の候補は行ごとに元の日（最後の日）を外す（元の日が今日以降の撮影日のとき）
  const to = columns.find((column) => column.key === 'to');
  const sameDay = {...leftoverSheetRows(API_ROWS)[0], lastDayId: 23};
  assert.deepEqual(to.candidatesFor(sameDay).map((option) => option.value), ['24', DROP]);
  assert.deepEqual(to.candidatesFor(leftoverSheetRows(API_ROWS)[0]).map((option) => option.value), ['23', '24', DROP]);
  // 書けない人の表（シートを読むだけにする）は、移し先も直せない
  assert.deepEqual(sheetColumns(leftoverColumns({options: []}), {readOnly: true}).filter((column) => column.editable), []);
});

test('FR-PROD-SCHED-099 移し先を選ぶと、その行の最後の日へ結果を1行足す本文になる（移し先 → 順延＋移し先、欠番 → 欠番）。戻す・空にするでは送らない', () => {
  const rows = leftoverSheetRows(API_ROWS);
  const cell = (key, after, before = '') => ({type: 'cell', key, field: 'to', before, after});
  assert.deepEqual(leftoverRequests([cell('scene:101', '23'), cell('scene:102', DROP)], rows), {errors: [], requests: [
    {key: 'scene:101', dayId: 21, body: {sceneId: 101, result: 'postponed', postponedToDayId: 23}},
    {key: 'scene:102', dayId: 22, body: {sceneId: 102, result: 'dropped'}},
  ]});
  // 記録は追記だけ: 戻す（部品の undo）も、移し先を空にしても、何も送らない
  assert.deepEqual(leftoverRequests([cell('scene:101', '23', DROP)], rows, {action: 'undo'}), {requests: [], errors: []});
  assert.equal(leftoverRequests([cell('scene:101', '23', DROP)], rows).requests.length, 1, '戻すでなければ送る（上の確かめが空振りでない）');
  assert.deepEqual(leftoverRequests([cell('scene:101', '')], rows), {requests: [], errors: []});
  // 元の日と同じ撮影日へは移せない（受け口も 400 で断る）。送らずに理由を返す
  assert.deepEqual(leftoverRequests([cell('scene:102', '22')], rows), {requests: [], errors: [{key: 'scene:102', message: 'S#14 は元の日と同じ撮影日へは移せません'}]});
  // 移し先でない列・知らない行・番号でない値は送らない
  assert.deepEqual(leftoverRequests([{type: 'cell', key: 'scene:101', field: 'reason', before: '', after: 'x'}, cell('scene:999', '23'), cell('scene:101', 'abc')], rows),
    {requests: [], errors: []});
});

test('FR-PROD-SCHED-102 画面の切り替え: URL の view が leftover なら未解決、それ以外は記録', () => {
  assert.equal(viewOf('leftover'), 'leftover');
  for (const value of [null, undefined, '', 'records', 'LEFTOVER', 'x']) assert.equal(viewOf(value), 'records', String(value));
});

// 架空の撮影日: 過ぎた日・今日より後の日
const P1 = 1, F = 2;
const DAYS = [{id: P1, shoot_date: '2026-11-10'}, {id: F, shoot_date: '2026-11-25'}];

test('FR-PROD-SCHED-101 全シーンの札: 同じ引き算に通し、撮れた・予定・欠番・未解決・未割当のどれか1つに入り、札の数の和が全シーンの数と一致する', () => {
  const scene = (id, status = 'draft') => ({id, work_id: 1, scene_no: String(id), location: `架空の場所${id}`, status});
  const scenes = [scene(1), scene(2), scene(3), scene(4), scene(5), scene(6, 'shot')];
  const assignments = [{shooting_day_id: P1, scene_id: 1}, {shooting_day_id: P1, scene_id: 2}, {shooting_day_id: P1, scene_id: 3}, {shooting_day_id: F, scene_id: 4}];
  const results = [
    {id: 1, shooting_day_id: P1, scene_id: 2, seq: 1, result: 'shot', postponed_to_day_id: null, created_at: '2026-11-10 10:00:00'},
    {id: 2, shooting_day_id: P1, scene_id: 3, seq: 1, result: 'dropped', postponed_to_day_id: null, created_at: '2026-11-10 11:00:00'},
  ];
  const states = sceneStates({scenes, days: DAYS, assignments, results, today: TODAY});
  // 1: 過ぎた日に入って結果なし → 未解決。2: 撮れた。3: 欠番。4: 今日より後の日 → 予定。5: どの日にも無い → 未割当。6: 日が無く撮影済み → 撮れた
  assert.deepEqual(states.map((row) => [row.sceneNo, row.state, row.label, row.lastShootDate]), [
    ['1', 'unresolved', '未解決', '2026-11-10'], ['2', 'shot', '撮れた', null], ['3', 'dropped', '欠番', null],
    ['4', 'upcoming', '予定', null], ['5', 'unassigned', '未割当', null], ['6', 'shot', '撮れた', null],
  ]);
  const counts = sceneStateCounts(states);
  assert.deepEqual(counts, {unresolved: 1, shot: 2, upcoming: 1, dropped: 1, unassigned: 1, total: 6});
  // 未解決の引き算の件数（未割当は数えない）と食い違わない
  const whole = deriveLeftover({scenes, days: DAYS, assignments, results, today: TODAY}).counts;
  assert.deepEqual({unresolved: counts.unresolved, shot: counts.shot, upcoming: counts.upcoming, dropped: counts.dropped}, whole);
  assert.equal(counts.unresolved + counts.shot + counts.upcoming + counts.dropped + counts.unassigned, scenes.length);
  assert.deepEqual(sceneSheetRows(states)[0], {id: 'scene:1', s: '1', place: '架空の場所1', state: 'unresolved', label: '未解決', from: '2026-11-10'});
});

async function setup(t) {
  const db = await openTestDb({t});
  const today = todayInJapan();
  // 架空の撮影日2日（過ぎた日・今日より後の日）とシーン4つ。過ぎた日に S#41・S#42、今日より後の日に S#43。S#44 はどの日にも入れない
  for (const [id, no] of [[941, '41'], [942, '42'], [943, '43'], [944, '44']]) {
    await db.run('INSERT INTO scenes(id,org_id,project_id,work_id,scene_no,location,synopsis) VALUES(?,1,1,1,?,?,?)', [id, no, `架空の土手${no}`, '架空']);
  }
  const past = addDays(today, -4), next = addDays(today, 5);
  await db.run('INSERT INTO shooting_days(id,org_id,project_id,work_id,shoot_date,unit,label,created_by) VALUES(?,1,1,1,?,?,?,1),(?,1,1,1,?,?,?,1)',
    [831, past, 'A班', '1日目', 832, next, 'A班', '2日目']);
  await db.run('INSERT INTO day_scene_assignments(org_id,work_id,shooting_day_id,scene_id,sequence_order) VALUES(1,1,831,941,1),(1,1,831,942,2),(1,1,832,943,1)');
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
  return {past, next, login, call};
}

test('FR-PROD-SCHED-101 受け口: scenes=all のときだけ全シーンの札を返し、ほかの値は 400。札の数の和は作品のシーンの数', async (t) => {
  const {past, login, call} = await setup(t);
  const admin = await login('admin@openingnight.invalid');
  const plain = await call(admin, '/production/shoot-records/leftover?workId=1');
  assert.equal(plain.status, 200);
  assert.equal('scenes' in plain.body, false);
  assert.deepEqual([(await call(admin, '/production/shoot-records/leftover?workId=1&scenes=some')).status], [400]);
  const all = await call(admin, '/production/shoot-records/leftover?workId=1&scenes=all');
  assert.equal(all.status, 200);
  const mine = all.body.scenes.filter((row) => [941, 942, 943, 944].includes(row.sceneId)).map((row) => [row.sceneNo, row.label, row.lastShootDate]);
  assert.deepEqual(mine, [['41', '未解決', past], ['42', '未解決', past], ['43', '予定', null], ['44', '未割当', null]]);
  const counts = sceneStateCounts(all.body.scenes);
  assert.equal(counts.total, all.body.scenes.length);
  assert.equal(counts.unresolved, all.body.counts.unresolved);
  assert.equal(counts.unresolved, all.body.rows.length);
  // 権限の無い人は同じ 403（全シーンでも有無を見せない）
  const outsider = await call(await login('outsider@other.invalid'), '/production/shoot-records/leftover?workId=1&scenes=all');
  assert.deepEqual([outsider.status, outsider.body.error], [403, 'この作品の撮影の記録への権限がありません']);
});

test('FR-PROD-SCHED-099 画面の送り方のとおりに受け口へ送ると、移した行と欠番にした行が未解決から消え、全シーンの札が予定・欠番に変わる', async (t) => {
  const {next, login, call} = await setup(t);
  const production = await login('production@openingnight.invalid');
  const read = () => call(production, '/production/shoot-records/leftover?workId=1&scenes=all');
  let body = (await read()).body;
  const rows = leftoverSheetRows(body.rows.filter((row) => [941, 942].includes(row.sceneId)));
  const target = moveOptions(body.upcomingDays, {year: Number(next.slice(0, 4))}).find((option) => option.label.endsWith('2日目'));
  assert.ok(target, '今日より後の撮影日が候補にある');
  const plan = leftoverRequests([
    {type: 'cell', key: 'scene:941', field: 'to', before: '', after: target.value},
    {type: 'cell', key: 'scene:942', field: 'to', before: '', after: DROP},
  ], rows);
  assert.equal(plan.requests.length, 2);
  for (const item of plan.requests) assert.equal((await call(production, `/production/shoot-records/days/${item.dayId}/results`, {method: 'POST', payload: item.body})).status, 201);
  body = (await read()).body;
  assert.deepEqual(body.rows.filter((row) => [941, 942].includes(row.sceneId)), []);
  assert.deepEqual(body.scenes.filter((row) => [941, 942].includes(row.sceneId)).map((row) => row.label), ['予定', '欠番']);
});

test('FR-PROD-SCHED-102 ホームの「撮り残したシーン」は撮影の記録の未解決（view=leftover）を開く', async (t) => {
  const {login, call} = await setup(t);
  const queue = await call(await login('admin@openingnight.invalid'), '/work-queue');
  const item = queue.body.items.find((entry) => entry.id === 'leftover-scenes');
  assert.deepEqual([item.page, item.params, item.count >= 2], ['撮影の記録', {view: 'leftover'}, true]);
  assert.equal(viewOf(item.params.view), 'leftover');
});
