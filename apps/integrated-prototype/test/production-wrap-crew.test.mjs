// キャストのバラしと撮影日のスタッフの数（移行 0058）。保存・読み込み・拒否と、日々スケの取り込み直しで消えないこと。データは架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {productionGraph} from '../src/production/call-sheet-import.mjs';

async function login(app, email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function request(app, cookie, path, method = 'GET', payload, headers = {}) {
  const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {}), ...headers}, body: payload ? JSON.stringify(payload) : undefined});
  return {status: response.status, data: await response.json()};
}
const empty = () => ({characters: [], locations: [], sceneDetails: [], appearances: [], looks: [], sceneLooks: [], daySlots: [], calls: []});

test('バラしとスタッフの数を保存して読み戻し、バラしが入り以前・範囲外の数・別作品の撮影日は拒む', async (t) => {
  const db = await openTestDb({t}), app = createApp({db, mode: 'local'});
  try {
    const production = await login(app, 'production@openingnight.invalid');
    const d1 = await request(app, production, '/field/days', 'POST', {workId: 1, shootDate: '2026-12-01', unit: 'A班', label: '第1日', notes: '', assignments: []});
    const d2 = await request(app, production, '/field/days', 'POST', {workId: 1, shootDate: '2026-12-02', unit: 'A班', label: '第2日', notes: '', assignments: []});
    assert.equal(d1.status, 201); assert.equal(d2.status, 201);
    const day1 = d1.data.dayId, day2 = d2.data.dayId;
    const graph = {...empty(), characters: [{key: 'r1', name: '架空の役'}],
      calls: [{day_id: day1, character_key: 'r1', call_time: '2026-12-01T07:00', ready_time: '2026-12-01T08:00', wrap_time: '2026-12-02T01:30'}],
      dayCrews: [{day_id: day1, crew_count: 25}]};
    const save = await request(app, production, '/production/1', 'PUT', graph, {'If-Match': '0'});
    assert.equal(save.status, 200, JSON.stringify(save.data));
    const reload = (await request(app, production, '/production?workId=1')).data;
    assert.equal(reload.calls[0].wrap_time, '2026-12-02T01:30', '翌日のバラしも保存できる');
    assert.deepEqual(reload.days.map((d) => [d.id, d.crew_count]), [[day1, 25], [day2, null]], '送らない撮影日はそのまま');

    // 送らなければ今の値のまま、null を送れば消える
    assert.equal((await request(app, production, '/production/1', 'PUT', {...graph, dayCrews: undefined}, {'If-Match': '1'})).status, 200);
    assert.equal((await request(app, production, '/production?workId=1')).data.days[0].crew_count, 25);
    assert.equal((await request(app, production, '/production/1', 'PUT', {...graph, dayCrews: [{day_id: day1, crew_count: null}]}, {'If-Match': '2'})).status, 200);
    assert.equal((await request(app, production, '/production?workId=1')).data.days[0].crew_count, null);

    const reject = async (patch, why) => {
      const r = await request(app, production, '/production/1', 'PUT', {...graph, ...patch}, {'If-Match': '3'});
      assert.equal(r.status, 422, `${why}: ${JSON.stringify(r.data)}`);
    };
    await reject({calls: [{...graph.calls[0], wrap_time: '2026-12-01T07:00'}]}, 'バラしが入りと同じ');
    await reject({calls: [{...graph.calls[0], wrap_time: '2026-12-01T06:00'}]}, 'バラしが入りより前');
    await reject({calls: [{...graph.calls[0], wrap_time: '2026-12-03T01:00'}]}, 'バラしが撮影日の翌々日');
    await reject({dayCrews: [{day_id: day1, crew_count: 10000}]}, 'スタッフの数が上限を超える');
    await reject({dayCrews: [{day_id: day1, crew_count: -1}]}, 'スタッフの数が負');
    await reject({dayCrews: [{day_id: 99999, crew_count: 3}]}, '別作品の撮影日');
    await reject({dayCrews: [{day_id: day1, crew_count: 3}, {day_id: day1, crew_count: 4}]}, '同じ撮影日が2回');
    // 撮影日の更新（PATCH）はスタッフの数に触れない
    assert.equal((await request(app, production, '/production/1', 'PUT', graph, {'If-Match': '3'})).status, 200);
    const patched = await request(app, production, `/field/days/${day1}`, 'PATCH', {label: '第1日（改）', assignments: []}, {'If-Match': '1'});
    assert.equal(patched.status, 200, JSON.stringify(patched.data));
    assert.equal((await request(app, production, '/production?workId=1')).data.days[0].crew_count, 25);
  } finally { await db.close(); }
});

test('DB もバラしが入り以前の行を拒む（画面と受け口を通らない書き込み）', async (t) => {
  const db = await openTestDb({t});
  try {
    const production = createApp({db, mode: 'local'});
    const cookie = await login(production, 'production@openingnight.invalid');
    const d = await request(production, cookie, '/field/days', 'POST', {workId: 1, shootDate: '2026-12-01', unit: 'A班', label: '第1日', notes: '', assignments: []});
    await db.run("INSERT INTO production_characters(org_id,work_id,key,name) VALUES(1,1,'r1','架空の役')");
    await assert.rejects(db.run("INSERT INTO production_calls(org_id,work_id,day_id,character_key,call_time,wrap_time) VALUES(1,1,?,'r1','2026-12-01T09:00','2026-12-01T08:00')", [d.data.dayId]));
    await assert.rejects(db.run('UPDATE shooting_days SET crew_count=-1 WHERE id=?', [d.data.dayId]));
  } finally { await db.close(); }
});

test('日々スケを取り込み直しても、人が入れたバラしは残る（新しい入りより前になったバラしは外す）', () => {
  const source = {work: {unit: 'A班'}, characters: [{key: 'r1', name: '架空の役'}, {key: 'r2', name: '架空の役2'}], locations: [{key: 'l1', name: '架空の場所'}], groups: {}};
  const sheet = {date: '2026-12-01', rows: [], calls: [{who: ['r1'], time: '07:00'}, {who: ['r2'], time: '10:00'}]};
  const production = {scenes: [], days: [{id: 1, shoot_date: '2026-12-01', unit: 'A班'}, {id: 2, shoot_date: '2026-12-02', unit: 'A班'}],
    characters: [{key: 'r1', name: '架空の役'}, {key: 'r2', name: '架空の役2'}],
    calls: [
      {day_id: 1, character_key: 'r1', call_time: '2026-12-01T08:00', wrap_time: '2026-12-01T18:00'},
      {day_id: 1, character_key: 'r2', call_time: '2026-12-01T08:00', wrap_time: '2026-12-01T09:30'},
      {day_id: 2, character_key: 'r1', call_time: '2026-12-02T08:00', wrap_time: '2026-12-02T17:00'},
    ]};
  const graph = productionGraph(source, [sheet], production);
  const wraps = Object.fromEntries(graph.calls.map((c) => [`${c.day_id}:${c.character_key}`, [c.call_time, c.wrap_time]]));
  assert.deepEqual(wraps, {
    '2:r1': ['2026-12-02T08:00', '2026-12-02T17:00'],
    '1:r1': ['2026-12-01T07:00', '2026-12-01T18:00'],
    '1:r2': ['2026-12-01T10:00', null],
  });
});
