// 未解決のシーン（撮り残し）の引き算（src/production/shoot-records/leftover-model.mjs）と、受け口 GET /api/production/shoot-records/leftover を確かめる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。期待値は会社ルートの plans/2026-11-20-genba-inbox.md の手順 6a（決まり 1〜9）と
// 要件 docs/requirements/production/schedule-commit.md の FR-PROD-SCHED-095〜097 から手で書いた。架空のデータだけを使う（組織1・2と利用者・作品1は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {deriveLeftover, LEFTOVER_REASONS} from '../src/production/shoot-records/leftover-model.mjs';
import {addDays, latestBy, workProgress} from '../src/production/shoot-records/shoot-records-model.mjs';
import {todayInJapan} from '../src/production/shoot-records/shoot-records-routes.mjs';

const TODAY = '2026-11-20';
// 架空の撮影日: 過ぎた日2つ・今日・今日より後の日
const P1 = 1, P2 = 2, T = 3, F = 4;
const DAYS = [{id: P1, shoot_date: '2026-11-10'}, {id: P2, shoot_date: '2026-11-15'}, {id: T, shoot_date: TODAY}, {id: F, shoot_date: '2026-11-25'}];

function fixture() {
  const scenes = [], assignments = [], results = [];
  let resultId = 0;
  const scene = (no, {status = 'draft', days = []} = {}) => {
    const id = 100 + no;
    scenes.push({id, work_id: 1, scene_no: String(no), location: `架空の場所${no}`, status});
    for (const day of days) assignments.push({shooting_day_id: day, scene_id: id});
    return id;
  };
  // at は記入の時刻（created_at）。同じシーンの結果は、書いた順に時刻を進める
  const result = (sceneId, day, value, {to = null, at} = {}) => {
    resultId += 1;
    const seq = results.filter((row) => row.shooting_day_id === day && row.scene_id === sceneId).length + 1;
    results.push({id: resultId, shooting_day_id: day, scene_id: sceneId, seq, result: value, postponed_to_day_id: to,
      created_at: at ?? `2026-11-19 ${String(resultId).padStart(2, '0')}:00:00`});
  };
  // 決まり1: 過ぎた撮影日だけに入っていて結果が無い
  scene(1, {days: [P1]});
  // 決まり2: 今日の撮影日で順延にしたが移し先が無い（その日のうちでも未解決）
  result(scene(2, {days: [T]}), T, 'postponed');
  // 決まり3: 順延の移し先が今日より後 → 未解決でない／移し先が過ぎて、その日の結果が無い → 未解決
  result(scene(3, {days: [P1]}), P1, 'postponed', {to: F});
  result(scene(4, {days: [P1]}), P1, 'postponed', {to: P2});
  // 決まり4: 一部で、今日以降の撮影日に入っていない → 未解決／今日より後の撮影日に割り当てた → 未解決でない
  result(scene(5, {days: [P1]}), P1, 'partial');
  result(scene(6, {days: [P1, F]}), P1, 'partial');
  // 決まり5: 撮影完了・欠番
  result(scene(7, {days: [P1]}), P1, 'shot');
  result(scene(8, {days: [P1]}), P1, 'dropped');
  // 決まり6: 今日以降の撮影日に割り当てがあり結果が無い（今日ちょうどと、今日より後）
  scene(9, {days: [F]});
  scene(10, {days: [T]});
  // 決まり7: どの撮影日にも入っていない
  scene(11);
  // 決まり8: シーンの状態が撮影済みで結果の行が無い → 撮れた／結果の行があれば結果を優先する
  scene(12, {status: 'shot', days: [P1]});
  result(scene(13, {status: 'shot', days: [P1]}), P1, 'partial');
  // 順延が2回続いても最後の移し先で判定する（FR-PROD-SCHED-069）
  const s14 = scene(14, {days: [P1]});
  result(s14, P1, 'postponed', {to: P2});
  result(s14, P2, 'postponed', {to: F});
  const s15 = scene(15, {days: [P1]});
  result(s15, P1, 'postponed', {to: P2});
  result(s15, P2, 'shot');
  // 同じ撮影日で結果を直した: 最新の行（連番の大きい行）が今の結果
  const s16 = scene(16, {days: [P1]});
  result(s16, P1, 'shot');
  result(s16, P1, 'partial');
  return {scenes, assignments, results};
}

test('FR-PROD-SCHED-095 未解決の引き算: 撮れた・欠番・これから撮るのどれにも入らない、割り当て済みのシーンだけを理由つきで出す', () => {
  const {scenes, assignments, results} = fixture();
  const {rows, counts} = deriveLeftover({scenes, days: DAYS, assignments, results, today: TODAY});
  assert.deepEqual(rows.map((row) => [row.sceneNo, row.reason, row.reasonLabel, row.lastDayId, row.lastShootDate, row.lastResult]), [
    ['1', 'no_result', '結果なし', P1, '2026-11-10', null],
    ['2', 'no_target', '移先未定', T, TODAY, 'postponed'],
    ['4', 'target_passed', '期限切れ', P2, '2026-11-15', null],
    ['5', 'partial', '一部', P1, '2026-11-10', 'partial'],
    ['13', 'partial', '一部', P1, '2026-11-10', 'partial'],
    ['16', 'partial', '一部', P1, '2026-11-10', 'partial'],
  ]);
  // 未解決6（1・2・4・5・13・16）、撮れた3（7・12・15）、これから撮る5（3・6・9・10・14）、欠番1（8）。11 はどれにも数えない
  assert.deepEqual(counts, {unresolved: 6, shot: 3, upcoming: 5, dropped: 1});
  assert.deepEqual(rows[0], {sceneId: 101, workId: 1, sceneNo: '1', location: '架空の場所1', reason: 'no_result', reasonLabel: '結果なし',
    lastDayId: P1, lastShootDate: '2026-11-10', lastResult: null});
  // 理由の札は1〜4字
  for (const label of Object.values(LEFTOVER_REASONS)) assert.ok(label.length >= 1 && label.length <= 4, label);
});

test('FR-PROD-SCHED-095 境目: 今日ちょうどの撮影日はこれから撮る側、翌日になると過ぎた撮影日として未解決に出る', () => {
  const scenes = [{id: 1, work_id: 1, scene_no: '1', location: null, status: 'draft'}];
  const assignments = [{shooting_day_id: T, scene_id: 1}];
  assert.deepEqual(deriveLeftover({scenes, days: DAYS, assignments, results: [], today: TODAY}).counts, {unresolved: 0, shot: 0, upcoming: 1, dropped: 0});
  const next = deriveLeftover({scenes, days: DAYS, assignments, results: [], today: addDays(TODAY, 1)});
  assert.deepEqual(next.rows.map((row) => [row.reason, row.lastShootDate]), [['no_result', TODAY]]);
  // 順延の移し先が今日ちょうどなら未解決でない。移し先の日を過ぎると 期限切れ
  const moved = [{id: 1, shooting_day_id: P1, scene_id: 1, seq: 1, result: 'postponed', postponed_to_day_id: T, created_at: '2026-11-10 10:00:00'}];
  const onlyP1 = [{shooting_day_id: P1, scene_id: 1}];
  assert.equal(deriveLeftover({scenes, days: DAYS, assignments: onlyP1, results: moved, today: TODAY}).rows.length, 0);
  assert.deepEqual(deriveLeftover({scenes, days: DAYS, assignments: onlyP1, results: moved, today: addDays(TODAY, 1)}).rows.map((row) => [row.reason, row.lastDayId]),
    [['target_passed', T]]);
});

const row = (id, day, sceneId, result, {to = null, at = '2026-11-19 10:00:00', seq = 1} = {}) =>
  ({id, shooting_day_id: day, scene_id: sceneId, seq, result, postponed_to_day_id: to, created_at: at});
const one = (status = 'draft') => [{id: 1, work_id: 1, scene_no: '1', location: null, status}];
const reasonsOf = (input) => deriveLeftover({days: DAYS, today: TODAY, scenes: one(), ...input}).rows.map((r) => [r.reasonLabel, r.lastDayId, r.lastResult]);
const countsOf = (input) => deriveLeftover({days: DAYS, today: TODAY, scenes: one(), ...input}).counts;

test('FR-PROD-SCHED-096 最後の結果は撮影日の日付の順で最後の日の状態で決め、記入が遅れても撮れていないシーンを消さない', () => {
  const both = [{shooting_day_id: P1, scene_id: 1, outcome: 'planned'}, {shooting_day_id: P2, scene_id: 1, outcome: 'planned'}];
  // 後の日（P2）の一部を先に記入し、前の日（P1）の撮影完了を遅れて記入した: 日付の順で最後の P2 の 一部 で未解決のまま
  const late = [row(1, P2, 1, 'partial', {at: '2026-11-15 18:00:00'}), row(2, P1, 1, 'shot', {at: '2026-11-16 09:00:00'})];
  assert.deepEqual(reasonsOf({assignments: both, results: late}), [['一部', P2, 'partial']]);
  // 作品の進み（SCHED-034）は記入の順なので、同じ入力で撮影完了と数える（記入の順が日付の順と違うときだけ食い違う）
  const progress = workProgress({assignments: both, latestResults: latestBy(late, (r) => `${r.shooting_day_id}:${r.scene_id}`)});
  assert.deepEqual([progress.shot, progress.partial], [1, 0]);
  // 前の日に撮影完了、後の過ぎた日に割り当てがあって結果なし: 撮れたとせず 結果なし で残る
  assert.deepEqual(reasonsOf({assignments: both, results: [row(1, P1, 1, 'shot')]}), [['結果なし', P2, null]]);
  // 順延の移し先の日が過ぎて結果なし: 期限切れ。移し先の日に撮影完了が入れば撮れた
  const p1 = [{shooting_day_id: P1, scene_id: 1, outcome: 'planned'}];
  assert.deepEqual(reasonsOf({assignments: p1, results: [row(1, P1, 1, 'postponed', {to: P2})]}), [['期限切れ', P2, null]]);
  assert.deepEqual(countsOf({assignments: p1, results: [row(1, P1, 1, 'postponed', {to: P2}), row(2, P2, 1, 'shot')]}), {unresolved: 0, shot: 1, upcoming: 0, dropped: 0});
  // 後の日の欠番が最後なら欠番。今日以降に状態なしの日があれば、ほかの日に撮影完了があってもこれから撮る
  assert.deepEqual(countsOf({assignments: both, results: [row(1, P1, 1, 'partial'), row(2, P2, 1, 'dropped')]}), {unresolved: 0, shot: 0, upcoming: 0, dropped: 1});
  const withFuture = [...p1, {shooting_day_id: F, scene_id: 1, outcome: 'planned'}];
  assert.deepEqual(countsOf({assignments: withFuture, results: [row(1, P1, 1, 'shot')]}), {unresolved: 0, shot: 0, upcoming: 1, dropped: 0});
  // 割り当ての並びが日付の順と違っても、日付の順で最後の日を見る（P2 を先に、P1 を後に並べた）
  const reversed = [{shooting_day_id: P2, scene_id: 1, outcome: 'planned'}, {shooting_day_id: P1, scene_id: 1, outcome: 'planned'}];
  assert.deepEqual(reasonsOf({assignments: reversed, results: [row(1, P1, 1, 'shot')]}), [['結果なし', P2, null]]);
  // 今日以降に状態なしの日があれば、日付の順で最後の日（F）に撮影完了が先に入っていても、これから撮る
  const todayAndLater = [{shooting_day_id: T, scene_id: 1, outcome: 'planned'}, {shooting_day_id: F, scene_id: 1, outcome: 'planned'}];
  assert.deepEqual(countsOf({assignments: todayAndLater, results: [row(1, F, 1, 'shot')]}), {unresolved: 0, shot: 0, upcoming: 1, dropped: 0});
  assert.deepEqual(countsOf({assignments: todayAndLater, results: [row(1, F, 1, 'dropped')]}), {unresolved: 0, shot: 0, upcoming: 1, dropped: 0});
  // 撮影日の一覧に無い日（移し先）は入っている日に数えない: 最後の日は P1 のままで、移し先つきの順延なので 期限切れ
  assert.deepEqual(reasonsOf({assignments: p1, results: [row(1, P1, 1, 'postponed', {to: 99})]}), [['期限切れ', P1, 'postponed']]);
});

test('FR-PROD-SCHED-096 日々スケの撮影実績の区分は、その日の結果の行が無いときだけ使い、結果の行があれば結果を優先する', () => {
  const on = (outcome) => [{shooting_day_id: P1, scene_id: 1, outcome}];
  // 区分 shot で結果の行なし → 撮れた。partial → 一部。not_shot → 移し先の無い順延と同じ。planned → 状態なし
  assert.deepEqual(countsOf({assignments: on('shot'), results: []}), {unresolved: 0, shot: 1, upcoming: 0, dropped: 0});
  assert.deepEqual(reasonsOf({assignments: on('partial'), results: []}), [['一部', P1, 'partial']]);
  assert.deepEqual(reasonsOf({assignments: on('not_shot'), results: []}), [['移先未定', P1, 'postponed']]);
  assert.deepEqual(reasonsOf({assignments: on('planned'), results: []}), [['結果なし', P1, null]]);
  // 区分が shot でも、結果の行が順延なら結果が優先して未解決
  assert.deepEqual(reasonsOf({assignments: on('shot'), results: [row(1, P1, 1, 'postponed')]}), [['移先未定', P1, 'postponed']]);
  // 区分 not_shot の日のあとに、今日より後の日へ割り当てた → これから撮る
  assert.deepEqual(countsOf({assignments: [...on('not_shot'), {shooting_day_id: F, scene_id: 1, outcome: 'planned'}], results: []}), {unresolved: 0, shot: 0, upcoming: 1, dropped: 0});
  // シーンの状態が撮影済みでも、区分か結果のどれかに状態があればそちらで決める。どれにも無ければ撮れた（決まり8）
  assert.deepEqual(deriveLeftover({days: DAYS, today: TODAY, scenes: one('shot'), assignments: on('partial'), results: []}).counts, {unresolved: 1, shot: 0, upcoming: 0, dropped: 0});
  assert.deepEqual(deriveLeftover({days: DAYS, today: TODAY, scenes: one('shot'), assignments: on('planned'), results: []}).counts, {unresolved: 0, shot: 1, upcoming: 0, dropped: 0});
});

async function setup(t) {
  const db = await openTestDb({t});
  const today = todayInJapan();
  // 架空の撮影日4日（過ぎた日2つ・今日より後の日・今日より後の予備日）とシーン3つ。過ぎた1日目に S#31・S#32、今日より後の日に S#33 を割り当てる
  for (const [id, no] of [[931, '31'], [932, '32'], [933, '33']]) {
    await db.run('INSERT INTO scenes(id,org_id,project_id,work_id,scene_no,location,synopsis) VALUES(?,1,1,1,?,?,?)', [id, no, `架空の路地${no}`, '架空']);
  }
  const days = {past1: addDays(today, -5), past2: addDays(today, -2), next: addDays(today, 3), spare: addDays(today, 6)};
  for (const [id, date, label] of [[821, days.past1, '1日目'], [822, days.past2, '2日目'], [823, days.next, '3日目'], [824, days.spare, '予備日']]) {
    await db.run('INSERT INTO shooting_days(id,org_id,project_id,work_id,shoot_date,unit,label,created_by) VALUES(?,1,1,1,?,?,?,1)', [id, date, 'A班', label]);
  }
  await db.run('INSERT INTO day_scene_assignments(org_id,work_id,shooting_day_id,scene_id,sequence_order) VALUES(1,1,821,931,1),(1,1,821,932,2),(1,1,823,933,1)');
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
  return {db, days, login, call};
}

test('FR-PROD-SCHED-097 受け口: 過ぎた撮影日の撮り残しを返し、今日より後の移し先への順延か欠番を足すと消える。移し先が過ぎた日なら残る', async (t) => {
  const {days, login, call} = await setup(t);
  const production = await login('production@openingnight.invalid');
  const leftover = () => call(production, '/production/shoot-records/leftover?workId=1');
  let read = await leftover();
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.rows.map((row) => [row.sceneNo, row.location, row.reasonLabel, row.lastDayId, row.lastShootDate, row.lastResult]), [
    ['31', '架空の路地31', '結果なし', 821, days.past1, null],
    ['32', '架空の路地32', '結果なし', 821, days.past1, null],
  ]);
  assert.deepEqual(read.body.counts, {unresolved: 2, shot: 0, upcoming: 1, dropped: 0});
  assert.deepEqual(read.body.upcomingDays, [{id: 823, shootDate: days.next, unit: 'A班', label: '3日目', spare: false},
    {id: 824, shootDate: days.spare, unit: 'A班', label: '予備日', spare: true}]);
  assert.equal(read.body.canWrite, true);
  const add = (payload) => call(production, '/production/shoot-records/days/821/results', {method: 'POST', payload});
  // S#31 を今日より後の予備日へ順延すると消える
  assert.equal((await add({sceneId: 931, result: 'postponed', postponedToDayId: 824})).status, 201);
  // S#32 を過ぎた2日目へ順延しても、その日の結果が無いので 期限切れ で残る。欠番にすると消える
  assert.equal((await add({sceneId: 932, result: 'postponed', postponedToDayId: 822})).status, 201);
  read = await leftover();
  assert.deepEqual(read.body.rows.map((row) => [row.sceneNo, row.reason, row.lastDayId, row.lastShootDate]), [['32', 'target_passed', 822, days.past2]]);
  assert.equal((await add({sceneId: 932, result: 'dropped'})).status, 201);
  read = await leftover();
  assert.deepEqual(read.body.rows, []);
  assert.deepEqual(read.body.counts, {unresolved: 0, shot: 0, upcoming: 2, dropped: 1});
});

test('FR-PROD-SCHED-097 受け口の権限: 読めるのは作品の案件に所属する人で、書けない人も読める。別の組織と無い作品は同じ 403、作品の番号が無ければ 400', async (t) => {
  const {db, login, call} = await setup(t);
  const outsider = await login('outsider@other.invalid');
  const denied = await call(outsider, '/production/shoot-records/leftover?workId=1');
  assert.deepEqual([denied.status, denied.body.error], [403, 'この作品の撮影の記録への権限がありません']);
  const admin = await login('admin@openingnight.invalid');
  const missing = await call(admin, '/production/shoot-records/leftover?workId=999');
  assert.deepEqual([missing.status, missing.body.error], [403, 'この作品の撮影の記録への権限がありません']);
  assert.equal((await call(admin, '/production/shoot-records/leftover')).status, 400);
  assert.equal((await call(await login('editor@openingnight.invalid'), '/production/shoot-records/leftover?workId=1')).body.rows.length, 2);
  // 案件の権限が制作でない制作担当は書けないが、未解決は読める
  await db.run("UPDATE project_memberships SET permission='edit' WHERE org_id=1 AND project_id=1 AND user_id=3");
  const production = await call(await login('production@openingnight.invalid'), '/production/shoot-records/leftover?workId=1');
  assert.deepEqual([production.status, production.body.canWrite, production.body.rows.length], [200, false, 2]);
});
