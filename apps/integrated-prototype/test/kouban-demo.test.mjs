// 制作の架空データ（scripts/seed-kouban-demo.mjs）の試験。
// ・縦書きの台本PDFを実際の取込（ローカルのPython）で読み、2話分58シーンが話数付きのS#（7-1・8-1…）で1つの作品に登録されること。
// ・香盤の値（場所・昼夜・予定尺・出演・日ごとの頁・役ごとの出演数）を、元データ kouban-demo.json から独立に計算して照合する。
// ・撮影日は、元データの候補日・時間予算・ロケ地の空き日から、規則（話の順・シーンの順に、予算とロケ地が合う最も早い候補日）を
//   この試験の中で書き下して求めたものと一致すること。第8話は第7話の撮影日に追記され、撮影日は増えないこと。
// ・2回目は何もしない。組織1からは見えない。俳優名はすべて架空（「（架空）」または「エキストラ」）。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {seedKoubanDemo} from '../scripts/seed-kouban-demo.mjs';
import {SALES_DEMO} from '../scripts/seed-sales-demo.mjs';
import {koubanSheet} from '../src/work/production-print.mjs';

const source = JSON.parse(await readFile(new URL('../demo-fixtures/kouban/kouban-demo.json', import.meta.url), 'utf8'));
const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// ---------- 元データから独立に出す値 ----------
const scenesOf = () => source.episodes.flatMap((episode) => episode.scenes.map((scene) => ({...scene, episode: episode.no, sceneNo: `${episode.no}-${scene.no}`})));
const keyOf = (characterKey) => `role:${source.characters.find((c) => c.key === characterKey).short}`;
function plannedDays() {
  const left = new Map(source.schedule.days.map((day) => [day.date, day.budget]));
  const placed = new Map();
  for (const scene of scenesOf()) {
    const day = source.schedule.days.find((d) => d.locations.includes(scene.loc) && left.get(d.date) >= scene.min);
    assert.ok(day, `${scene.sceneNo} の入る日が元データにない`);
    left.set(day.date, left.get(day.date) - scene.min);
    placed.set(scene.sceneNo, day.date);
  }
  return placed;
}

let db, summary, production, work;
before(async (t) => {
  db = await openTestDb({t});
  summary = await seedKoubanDemo(db, {python});
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = async (path) => (await app.request(`/api${path}`, {headers: {cookie}})).json();
  work = (await get('/bootstrap')).works.find((row) => row.code === source.series.workCode);
  production = await get(`/production?workId=${work.id}`);
  production.history = (await get(`/workflow/scripts?workId=${work.id}`)).rows;
});
after(() => db?.close());

test('台本3本を取り込み、決定稿2本だけを確定して58シーン・20役・14ロケ地・9撮影日になる', () => {
  assert.equal(summary.skipped, false);
  assert.equal(production.history.length, 3);
  assert.deepEqual(production.history.filter((row) => row.commit_id).map((row) => row.file_name).sort(), ['fukurodo-ep07-kettei.pdf', 'fukurodo-ep08-kettei.pdf']);
  const expected = scenesOf();
  assert.equal(production.scenes.length, expected.length);
  assert.deepEqual(production.scenes.map((scene) => scene.scene_no).sort(), expected.map((scene) => scene.sceneNo).sort());
  assert.equal(production.characters.length, source.characters.length);
  assert.equal(production.locations.length, source.locations.length);
  assert.equal(production.days.length, source.schedule.days.length);
});

test('シーンごとの場所・昼夜・予定尺・出演が元データと一致する', () => {
  const byNo = new Map(production.scenes.map((scene) => [scene.scene_no, scene]));
  const detail = new Map(production.sceneDetails.map((row) => [row.scene_id, row]));
  const cast = new Map();
  for (const row of production.appearances) {
    if (!cast.has(row.scene_id)) cast.set(row.scene_id, new Set());
    cast.get(row.scene_id).add(row.character_key);
  }
  for (const scene of scenesOf()) {
    const saved = byNo.get(scene.sceneNo);
    assert.equal(saved.day_night, scene.dn, scene.sceneNo);
    assert.equal(detail.get(saved.id).location_key, scene.loc, scene.sceneNo);
    assert.equal(detail.get(saved.id).estimated_minutes, scene.min, scene.sceneNo);
    assert.ok(detail.get(saved.id).page_eighths >= 1, `${scene.sceneNo} の頁`);
    assert.deepEqual([...(cast.get(saved.id) || [])].sort(), [...scene.cast, ...(scene.extras || [])].map(keyOf).sort(), scene.sceneNo);
    // 台本の見出しの「同・」は直前の場所で読み替えられている
    assert.ok(!saved.location.startsWith('同'), `${scene.sceneNo}: ${saved.location}`);
  }
});

test('FR-PROD-SCHED-005 FR-PROD-SCHED-007 撮影日は規則どおり。第8話は第7話の撮影日に追記され、撮りこぼした1シーンは後の日に回る', () => {
  const planned = plannedDays();
  const dayOf = new Map(production.days.map((day) => [day.id, day.shoot_date]));
  const sceneOf = new Map(production.scenes.map((scene) => [scene.id, scene.scene_no]));
  const moved = source.schedule.notShot;
  const rows = production.days.flatMap((day) => day.assignments.map((a) => ({sceneNo: sceneOf.get(a.scene_id), date: dayOf.get(a.shooting_day_id), outcome: a.outcome})));
  for (const [sceneNo, date] of planned) {
    const mine = rows.filter((row) => row.sceneNo === sceneNo);
    if (sceneNo === `${moved.episode}-${moved.scene}`) {
      assert.deepEqual(mine.map((row) => [row.date, row.outcome]).sort(), [[moved.date, 'not_shot'], [moved.moveTo, 'planned']].sort());
      assert.equal(date, moved.date);
    } else {
      assert.deepEqual(mine.map((row) => row.date), [date], sceneNo);
      assert.equal(mine[0].outcome, date < source.schedule.asOf ? 'shot' : 'planned', sceneNo);
    }
  }
  const mixed = production.days.filter((day) => new Set(day.assignments.map((a) => sceneOf.get(a.scene_id).split('-')[0])).size === 2);
  assert.ok(mixed.length >= 3, `2話が同じ日に並ぶ撮影日: ${mixed.length}日`);
});

test('香盤表（Excel・印刷と同じシート）の日ごとの頁の小計と、役ごとの出演数が元データから出した値と一致する', () => {
  const sheet = koubanSheet(production, {workTitle: work.title});
  const castColumns = sheet.columns.filter((column) => column.key.startsWith('cast:'));
  assert.equal(castColumns[0].label, '千尋', '出演の最も多い役が左端');
  const expectedCount = new Map();
  for (const scene of scenesOf()) for (const key of [...scene.cast, ...(scene.extras || [])]) expectedCount.set(keyOf(key), (expectedCount.get(keyOf(key)) || 0) + 1);
  const movedNo = `${source.schedule.notShot.episode}-${source.schedule.notShot.scene}`;
  const extra = new Map(scenesOf().find((scene) => scene.sceneNo === movedNo).cast.map((key) => [keyOf(key), 1]));
  const sceneRows = sheet.rows.filter((row) => row.sceneNo);
  for (const column of castColumns) {
    const key = column.key.slice(5);
    const marks = sceneRows.filter((row) => row[column.key] === '○').length;
    // 撮りこぼしのシーンは2つの撮影日に出る（両方の行に○）
    assert.equal(marks, (expectedCount.get(key) || 0) + (extra.get(key) || 0), column.label);
  }
  const eighths = new Map(production.sceneDetails.map((row) => [row.scene_id, row.page_eighths]));
  for (const day of production.days) {
    const total = day.assignments.reduce((n, a) => n + eighths.get(a.scene_id), 0);
    const reported = production.pageTotals.find((row) => row.dayId === day.id).pageEighths;
    assert.equal(reported, total, day.shoot_date);
  }
});

test('2回目は何もしない。組織1からは見えない。俳優名はすべて架空', async () => {
  assert.equal((await seedKoubanDemo(db, {python})).skipped, true);
  assert.equal(Number((await db.get('SELECT COUNT(*) n FROM works WHERE code=?', [source.series.workCode])).n), 1);
  assert.ok(!(await db.get('SELECT 1 FROM works WHERE org_id=1 AND code=?', [source.series.workCode])));
  for (const character of production.characters) assert.match(character.actor_name, /（架空）|エキストラ/, character.name);
});

// ---------- 本番の保存の上限（1回の batch は500文・1文の値は100個）----------
// 本番の DB 部品は1回の batch を D1_ATOMIC_STATEMENT_LIMIT（500）文までにする。同じ上限をかぶせた DB で保存する。
// 1行1文で積んでいたときは、DEMO-D78 に見取り図を8か所描くと501文になり「更新できませんでした」で保存できなかった
// inlineBytes: 1行の文字の値の上限（本番の部品と同じ 128KB。超えたら本番の部品と同じ文言で止める）
function limitedDb(limit, {inlineBytes = 128 * 1024} = {}) {
  const seen = {maxStatements: 0, maxParams: 0};
  const wrapped = Object.assign(Object.create(db), {
    seen, maxBatchStatements: limit,
    batch(statements) {
      seen.maxStatements = Math.max(seen.maxStatements, statements.length);
      if (statements.length > limit) throw new Error(`D1 atomic batch exceeds ${limit} statements`);
      for (const statement of statements) {
        seen.maxParams = Math.max(seen.maxParams, (statement.params || []).length);
        if ((statement.params || []).length > 100) throw new Error(`D1 の上限（100値）を超えました: ${statement.params.length}`);
        for (const value of statement.params || []) if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > inlineBytes) throw new Error('この項目はD1行内サイズ上限を超えています');
      }
      return db.batch(statements);
    },
  });
  return wrapped;
}
async function productionClient(limit, options) {
  const wrapped = limitedDb(limit, options);
  const app = createApp({db: wrapped, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (path, {method = 'GET', payload, headers = {}} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {}), ...headers}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, data: await response.json()};
  };
  return {wrapped, call};
}
const graphOf = (current, plans) => ({
  characters: current.characters, locations: current.locations, sceneDetails: current.sceneDetails, appearances: current.appearances, looks: current.looks,
  sceneLooks: current.sceneLooks, daySlots: current.daySlots, calls: current.calls, locationPlans: plans,
});
const drawing = (n) => [{tool: 'blue', width: 0.004, points: [{x: 0.1, y: 0.1 + n / 100}, {x: 0.6, y: 0.2 + n / 100}, {x: 0.6, y: 0.7}]}, {tool: 'red', width: 0.006, points: [{x: 0.3, y: 0.3}]}];

test('香盤の保存: DEMO-D78 に見取り図を8か所描いても本番と同じ500文の上限の中で保存でき、行の数は変わらない', async () => {
  const {wrapped, call} = await productionClient(500);
  const before = (await call(`/production?workId=${work.id}`)).data;
  assert.equal(before.appearances.length, 141, '元の出演の数');
  const plans = before.locations.slice(0, 8).map((location, n) => ({location_key: location.key, strokes: drawing(n)}));
  assert.equal(plans.length, 8);
  const saved = await call(`/production/${work.id}`, {method: 'PUT', payload: graphOf(before, plans), headers: {'If-Match': String(before.version)}});
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  // 1行1文なら 見取り図8か所で501文。表ごとにまとめると十分に小さい
  assert.ok(wrapped.seen.maxStatements < 100, `1回の保存の文の数: ${wrapped.seen.maxStatements}`);
  assert.ok(wrapped.seen.maxParams <= 100, `1文の値の数: ${wrapped.seen.maxParams}`);
  const after = (await call(`/production?workId=${work.id}`)).data;
  assert.equal(after.version, before.version + 1);
  assert.equal(after.locationPlans.length, 8);
  assert.deepEqual(after.locationPlans.find((plan) => plan.location_key === plans[3].location_key).strokes, plans[3].strokes);
  for (const key of ['characters', 'locations', 'sceneDetails', 'appearances', 'looks', 'sceneLooks', 'daySlots', 'calls']) assert.equal(after[key].length, before[key].length, key);
  // 値もそのまま（出演の組・入り時間・日々スケの項目名）
  const pairs = (rows, pick) => rows.map(pick).sort();
  assert.deepEqual(pairs(after.appearances, (row) => `${row.scene_id}:${row.character_key}`), pairs(before.appearances, (row) => `${row.scene_id}:${row.character_key}`));
  assert.deepEqual(pairs(after.calls, (row) => `${row.day_id}:${row.character_key}:${row.call_time}`), pairs(before.calls, (row) => `${row.day_id}:${row.character_key}:${row.call_time}`));
  assert.deepEqual(pairs(after.daySlots, (row) => `${row.day_id}:${row.key}:${row.label}`), pairs(before.daySlots, (row) => `${row.day_id}:${row.key}:${row.label}`));
});

test('香盤の保存: 1回で保存できる数を超えたら、件数が原因だと分かる文言（413）で断り、何も変えない', async () => {
  const {call} = await productionClient(10);
  const before = (await call(`/production?workId=${work.id}`)).data;
  const response = await call(`/production/${work.id}`, {method: 'PUT', payload: graphOf(before, before.locationPlans), headers: {'If-Match': String(before.version)}});
  assert.equal(response.status, 413);
  assert.match(response.data.error, /件数が多すぎて、1回で保存できません（保存の処理 \d+件・上限 10件）/);
  assert.doesNotMatch(response.data.error, /再読込/);
  const after = (await call(`/production?workId=${work.id}`)).data;
  assert.equal(after.version, before.version);
  assert.equal(after.appearances.length, before.appearances.length);
});

test('香盤の保存: 1ロケ地の見取り図が本番の1行の上限（128KB）を超えると、ロケ地の分かる文言で断る（再読込の文言にしない）', async () => {
  const {call} = await productionClient(500);
  const before = (await call(`/production?workId=${work.id}`)).data;
  const key = before.locations[0].key;
  const big = Array.from({length: 6}, () => ({tool: 'blue', width: 0.004, points: Array.from({length: 970}, (_, n) => ({x: 0.1234, y: (n % 100) / 100 + 0.0001}))}));
  const tooBig = await call(`/production/${work.id}`, {method: 'PUT', payload: graphOf(before, [{location_key: key, strokes: big}]), headers: {'If-Match': String(before.version)}});
  assert.equal(tooBig.status, 422, JSON.stringify(tooBig.data).slice(0, 200));
  assert.match(tooBig.data.error, new RegExp(`見取り図（ロケ地 ${key}）は1ロケ地128KB以内です`));
  const fitting = await call(`/production/${work.id}`, {method: 'PUT', payload: graphOf(before, [{location_key: key, strokes: big.slice(0, 4)}]), headers: {'If-Match': String(before.version)}});
  assert.equal(fitting.status, 200, '上限の中なら本番と同じ上限の DB でも保存できる');
  // 本番の部品が1行の上限で止めたときは 413 で、何を減らせばよいかを返す（上限を小さくした DB で確かめる）
  const small = await productionClient(500, {inlineBytes: 1000});
  const now = (await small.call(`/production?workId=${work.id}`)).data;
  const response = await small.call(`/production/${work.id}`, {method: 'PUT', payload: graphOf(now, [{location_key: key, strokes: big.slice(0, 1)}]), headers: {'If-Match': String(now.version)}});
  assert.equal(response.status, 413);
  assert.match(response.data.error, /見取り図が大きすぎて保存できません/);
  assert.doesNotMatch(response.data.error, /再読込/);
});
