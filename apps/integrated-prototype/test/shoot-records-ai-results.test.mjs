// 撮影の結果を AI が入れる（会社ルートの plans/2026-11-20-genba-inbox.md の手順7、移行 0069。番号は仮）を、純関数（ai-results-model.mjs）・
// DB の制約・受け口（ai-results-routes.mjs と、いまの結果の受け口の歯止め）・ホームの項目で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は brain の D-047 の3・4・7（独立した2回の読みが一致したら確定・割れたら入れずに聞く・AI が入れたことと読みの記録を残す）と、
// 要件 docs/requirements/production/schedule-commit.md の FR-PROD-SCHED-103〜109 から手で書いた。架空のデータだけを使う（組織1・2と利用者・作品1は試作の行。モデルの名前も架空）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {compareReads, derivePendingReads, normalizeAiResultsInput, planAiResults, serviceTokenResultError} from '../src/production/shoot-records/ai-results-model.mjs';
import {addDays} from '../src/production/shoot-records/shoot-records-model.mjs';
import {todayInJapan} from '../src/production/shoot-records/shoot-records-routes.mjs';

const ADMIN = 1;
const A = 'fict-reader-a', B = 'fict-reader-b';
const reads = (first, second, {m1 = A, m2 = B} = {}) => ({first: {model: m1, reading: first}, second: {model: m2, reading: second}});
const count = async (db, table) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
const counts = async (db) => ({reads: await count(db, 'shooting_scene_reads'), results: await count(db, 'shooting_scene_results'), links: await count(db, 'shooting_scene_result_reads')});
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  assert.match(error.message, message);
  return true;
});

test('FR-PROD-SCHED-104 2回の読みの突き合わせ: 同じ結果（読めず を除く）だけ一致し、読みを撮影の結果へ読み替える。同じモデルの束・1回だけ・2回目の無い本文は断る', () => {
  assert.deepEqual(compareReads({model: A, reading: 'shot'}, {model: B, reading: 'shot'}), {agreed: true, reading: 'shot', result: 'shot'});
  assert.deepEqual(compareReads({model: A, reading: 'partial'}, {model: B, reading: 'partial'}), {agreed: true, reading: 'partial', result: 'partial'});
  assert.deepEqual(compareReads({model: A, reading: 'not_shot'}, {model: B, reading: 'not_shot'}), {agreed: true, reading: 'not_shot', result: 'postponed'});
  assert.deepEqual(compareReads({model: A, reading: 'shot'}, {model: B, reading: 'partial'}), {agreed: false, reading: null, result: null});
  assert.deepEqual(compareReads({model: A, reading: 'unreadable'}, {model: B, reading: 'unreadable'}), {agreed: false, reading: null, result: null});
  assert.deepEqual(compareReads({model: A, reading: 'shot'}, {model: B, reading: 'unreadable'}), {agreed: false, reading: null, result: null});
  assert.throws(() => compareReads({model: A, reading: 'shot'}, {model: ` ${A.toUpperCase()} `, reading: 'shot'}), /モデルが同じ/);
  const plan = planAiResults([{sceneId: 1, ...reads('shot', 'shot')}, {sceneId: 2, ...reads('shot', 'not_shot')}, {sceneId: 3, ...reads('not_shot', 'not_shot')}]);
  assert.deepEqual(plan.agreed, [{sceneId: 1, reading: 'shot', result: 'shot'}, {sceneId: 3, reading: 'not_shot', result: 'postponed'}]);
  assert.deepEqual(plan.split.map((row) => [row.sceneId, row.first.reading, row.second.reading]), [[2, 'shot', 'not_shot']]);
  // 本文: 1回目だけ・2回目が無い・同じモデル（大文字と空白の違いも同じ）は、束ごと ok が偽
  const fields = (raw) => normalizeAiResultsInput(raw).errors.map((error) => [error.scene, error.field]);
  assert.deepEqual(fields({scenes: [{sceneId: 1, first: {model: A, reading: 'shot'}}]}), [[0, 'second']]);
  assert.deepEqual(fields({scenes: [{sceneId: 1, ...reads('shot', 'shot')}, {sceneId: 2, ...reads('shot', 'shot', {m2: ` ${A.toUpperCase()}`})}]}), [[1, 'second.model']]);
  assert.deepEqual(fields({scenes: [{sceneId: 1, ...reads('shot', 'maybe')}]}), [[0, 'second.reading']]);
  assert.deepEqual(fields({scenes: [{sceneId: 1, ...reads('shot', 'shot')}, {sceneId: 1, ...reads('shot', 'shot')}]}), [[1, 'sceneId']]);
  assert.deepEqual(fields({scenes: []}), [[null, 'scenes']]);
  assert.deepEqual(fields({scenes: Array.from({length: 201}, (_, i) => ({sceneId: i + 1, ...reads('shot', 'shot')}))}), [[null, 'scenes']]);
  assert.equal(normalizeAiResultsInput({scenes: Array.from({length: 200}, (_, i) => ({sceneId: i + 1, ...reads('shot', 'shot')}))}).ok, true);
  assert.deepEqual(fields({readKey: 'あ', scenes: [{sceneId: 1, ...reads('shot', 'shot')}]}), [[null, 'readKey']]);
  assert.deepEqual(normalizeAiResultsInput({readKey: 'fict-1:a', sourceDocumentId: '7', scenes: [{sceneId: '3', ...reads('partial', 'shot')}]}).value,
    {readKey: 'fict-1:a', sourceDocumentId: 7, scenes: [{sceneId: 3, first: {model: A, reading: 'partial'}, second: {model: B, reading: 'shot'}}]});
});

test('FR-PROD-SCHED-106 歯止めの判定: サービストークンの呼び出しの撮れた・一部だけを断り、順延・欠番と、人のログイン・印の無い呼び出しは通す', () => {
  for (const result of ['shot', 'partial']) assert.equal(serviceTokenResultError(result, 'service_token'), 'AI は撮れた・一部を2回の読みの受け口から入れます');
  for (const result of ['postponed', 'dropped']) assert.equal(serviceTokenResultError(result, 'service_token'), null);
  for (const via of ['access', null, undefined]) for (const result of ['shot', 'partial', 'postponed', 'dropped']) assert.equal(serviceTokenResultError(result, via), null);
});

test('FR-PROD-SCHED-107 要確認の導き方: いちばん新しい束が割れていて、そのあとに人の結果が無い撮影日×シーンだけ。新しい束が一致すれば消える', () => {
  const row = (id, key, readNo, model, reading, {day = 1, scene = 10, prior = 0} = {}) => ({id, work_id: 1, shooting_day_id: day, scene_id: scene, read_key: key,
    read_no: readNo, model, reading, prior_result_seq: prior, source_document_id: null, created_at: '2026-11-20 10:00:00', shoot_date: '2026-11-19', scene_no: '10', location: null});
  const split = [row(1, 'k1', 1, A, 'shot'), row(2, 'k1', 2, B, 'partial')];
  assert.deepEqual(derivePendingReads({reads: split, results: []}).map((r) => [r.readKey, r.first.reading, r.second.reading, r.first.label, r.second.label]),
    [['k1', 'shot', 'partial', '撮れた', '一部']]);
  // 束より前の人の結果（連番 1 ≦ 束を入れたときの連番 1）では消えない。束のあとの人の結果（連番 2）で消える。AI の結果（結びあり）では消えない
  const before = [row(1, 'k1', 1, A, 'shot', {prior: 1}), row(2, 'k1', 2, B, 'partial', {prior: 1})];
  assert.equal(derivePendingReads({reads: before, results: [{shooting_day_id: 1, scene_id: 10, seq: 1, ai_read_key: null}]}).length, 1);
  assert.equal(derivePendingReads({reads: before, results: [{shooting_day_id: 1, scene_id: 10, seq: 2, ai_read_key: null}]}).length, 0);
  assert.equal(derivePendingReads({reads: before, results: [{shooting_day_id: 1, scene_id: 10, seq: 2, ai_read_key: 'k0'}]}).length, 1);
  // 新しい束が一致すれば要確認でない。新しい束が割れていれば、古い束が一致していても要確認
  assert.equal(derivePendingReads({reads: [...split, row(3, 'k2', 1, A, 'shot'), row(4, 'k2', 2, B, 'shot')], results: []}).length, 0);
  assert.deepEqual(derivePendingReads({reads: [row(1, 'k0', 1, A, 'shot'), row(2, 'k0', 2, B, 'shot'), row(3, 'k2', 1, A, 'unreadable'), row(4, 'k2', 2, B, 'unreadable')],
    results: []}).map((r) => r.readKey), ['k2']);
  // 撮影日が違えば別に数える
  assert.equal(derivePendingReads({reads: [...split, row(5, 'k3', 1, A, 'shot', {day: 2}), row(6, 'k3', 2, B, 'not_shot', {day: 2})], results: []}).length, 2);
});

async function setup(t) {
  const db = await openTestDb({t});
  const today = todayInJapan();
  const days = {past: addDays(today, -3), past2: addDays(today, -2)};
  // 架空のシーン5つ（作品1）と、別の作品2のシーン1つ。過ぎた撮影日2日（作品1）
  for (const [id, no] of [[971, '71'], [972, '72'], [973, '73'], [974, '74'], [975, '75']]) {
    await db.run('INSERT INTO scenes(id,org_id,project_id,work_id,scene_no,location,synopsis) VALUES(?,1,1,1,?,?,?)', [id, no, `架空の坂${no}`, '架空']);
  }
  await db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(2001,1,1,'FICT-AI-2','架空の別作品')");
  await db.run("INSERT INTO scenes(id,org_id,project_id,work_id,scene_no,synopsis) VALUES(979,1,1,2001,'79','架空')");
  for (const [id, date, label] of [[871, days.past, '1日目'], [872, days.past2, '2日目']]) {
    await db.run('INSERT INTO shooting_days(id,org_id,project_id,work_id,shoot_date,unit,label,created_by) VALUES(?,1,1,1,?,?,?,1)', [id, date, 'A班', label]);
  }
  await db.run('INSERT INTO day_scene_assignments(org_id,work_id,shooting_day_id,scene_id,sequence_order) VALUES(1,1,871,971,1),(1,1,871,972,2),(1,1,871,973,3),(1,1,871,974,4),(1,1,871,975,5)');
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

// 呼び出しの経路の印（identity.via。FR-CORE-DATA-066）を付けた identity で受け口を呼ぶ。本番の Worker が付ける印を、認証の差し替えで同じ形に作る
// （印の付け方そのものは test/cloud-db.test.mjs が Worker の JWT で確かめる）
async function appAs(db, via) {
  const {identityForUser} = await import('../src/session-org.mjs');
  const identity = await identityForUser(db, {user_id: ADMIN, email: 'admin@openingnight.invalid', display_name: '管理者'}, null);
  const app = createApp({db, mode: 'production', authenticate: async () => (via === undefined ? identity : {...identity, via})});
  return async (path, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: payload ? {'content-type': 'application/json'} : {}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
}

const AI = '/production/shoot-records/days/871/ai-results';

test('FR-PROD-SCHED-105 FR-PROD-SCHED-107 一致した行だけ結果が入り、割れた行・読めず の行は読みの記録だけで要確認に出る。割れたシーンに人が結果を足すと要確認から消える', async (t) => {
  const {db, login, call} = await setup(t);
  const production = await login('production@openingnight.invalid');
  const posted = await call(production, AI, {method: 'POST', payload: {readKey: 'fict-bundle-1', scenes: [
    {sceneId: 971, ...reads('shot', 'shot')}, {sceneId: 972, ...reads('partial', 'partial')}, {sceneId: 973, ...reads('not_shot', 'not_shot')},
    {sceneId: 974, ...reads('shot', 'partial')}, {sceneId: 975, ...reads('unreadable', 'unreadable')}]}});
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.deepEqual(posted.body.added.map((row) => [row.sceneNo, row.reading, row.result]), [['71', 'shot', 'shot'], ['72', 'partial', 'partial'], ['73', 'not_shot', 'postponed']]);
  assert.deepEqual(posted.body.split.map((row) => [row.sceneNo, row.first.model, row.first.reading, row.second.model, row.second.reading]),
    [['74', A, 'shot', B, 'partial'], ['75', A, 'unreadable', B, 'unreadable']]);
  assert.deepEqual([posted.body.readKey, posted.body.counts], ['fict-bundle-1', {scenes: 5, added: 3, split: 2}]);
  // DB: 結果は一致した3行だけ（not_shot は移し先の無い順延）。結びも3行。読みは5シーン×2回
  assert.deepEqual((await db.all('SELECT scene_id,result,postponed_to_day_id,seq FROM shooting_scene_results WHERE org_id=1 ORDER BY scene_id')).map((r) => [Number(r.scene_id), r.result, r.postponed_to_day_id, Number(r.seq)]),
    [[971, 'shot', null, 1], [972, 'partial', null, 1], [973, 'postponed', null, 1]]);
  assert.deepEqual(await counts(db), {reads: 10, results: 3, links: 3});
  assert.deepEqual((await db.all('SELECT DISTINCT read_key,created_by FROM shooting_scene_reads')).map((r) => [r.read_key, Number(r.created_by)]), [['fict-bundle-1', 3]]);
  // 要確認: 割れた2シーン（撮影日・シーン・2回の結果とモデル）
  const pending = await call(production, '/production/shoot-records/reads/pending?workId=1');
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.body.rows.map((row) => [row.dayId, row.sceneNo, row.first.model, row.first.reading, row.second.model, row.second.reading, row.readKey]),
    [[871, '74', A, 'shot', B, 'partial', 'fict-bundle-1'], [871, '75', A, 'unreadable', B, 'unreadable', 'fict-bundle-1']]);
  assert.equal(pending.body.count, 2);
  // 人が S#74 に結果を足すと要確認から消える（S#75 は残る）
  assert.equal((await call(production, '/production/shoot-records/days/871/results', {method: 'POST', payload: {sceneId: 974, result: 'partial'}})).status, 201);
  assert.deepEqual((await call(production, '/production/shoot-records/reads/pending?workId=1')).body.rows.map((row) => row.sceneNo), ['75']);
  // 束の鍵を送らなければ受け口が作る
  const generated = await call(production, '/production/shoot-records/days/872/ai-results', {method: 'POST', payload: {scenes: [{sceneId: 971, ...reads('shot', 'shot')}]}});
  assert.equal(generated.status, 201);
  assert.match(generated.body.readKey, /^srr-[0-9a-f-]{36}$/);
});

test('FR-PROD-SCHED-105 200シーンの束も1回の書き込みで入り、文の数と1文の値の数は D1 の上限（500文・100個）に収まる', async (t) => {
  const {db, login, call} = await setup(t);
  const ids = Array.from({length: 200}, (_, i) => 5000 + i);
  for (let offset = 0; offset < ids.length; offset += 20) {
    const chunk = ids.slice(offset, offset + 20);
    await db.run(`INSERT INTO scenes(id,org_id,project_id,work_id,scene_no,synopsis) VALUES ${chunk.map(() => "(?,1,1,1,?,'架空')").join(',')}`, chunk.flatMap((id) => [id, `B${id}`]));
  }
  const batches = [];
  const batch = db.batch.bind(db);
  db.batch = async (statements) => { batches.push(statements); return batch(statements); };
  const production = await login('production@openingnight.invalid');
  // 偶数番目は一致（撮れた）、奇数番目は割れる
  const posted = await call(production, AI, {method: 'POST', payload: {scenes: ids.map((sceneId, i) => ({sceneId, ...reads('shot', i % 2 ? 'partial' : 'shot')}))}});
  assert.equal(posted.status, 201, JSON.stringify(posted.body).slice(0, 300));
  assert.deepEqual(posted.body.counts, {scenes: 200, added: 100, split: 100});
  assert.deepEqual(await counts(db), {reads: 400, results: 100, links: 100});
  const written = batches.find((statements) => statements.some((s) => /INSERT INTO shooting_scene_reads/.test(s.sql)));
  assert.ok(written.length <= 500, `文の数 ${written.length}`);
  assert.ok(Math.max(...written.map((s) => s.params.length)) < 100, '1文の値の数');
});

test('FR-PROD-SCHED-105 1回の読みだけ・同じモデルの2回・2回目の無い本文では撮れたを入れられない（400。1行も書かない）', async (t) => {
  const {db, login, call} = await setup(t);
  const admin = await login('admin@openingnight.invalid');
  const empty = {reads: 0, results: 0, links: 0};
  for (const scenes of [
    [{sceneId: 971, first: {model: A, reading: 'shot'}}],
    [{sceneId: 971, ...reads('shot', 'shot', {m2: A})}],
    [{sceneId: 971, ...reads('shot', 'shot')}, {sceneId: 972, first: {model: A, reading: 'shot'}, second: null}],
    [{sceneId: 971, ...reads('shot', 'shot')}, {sceneId: 972, ...reads('shot', 'shot', {m1: 'Fict-Reader-X', m2: 'fict-reader-x '})}],
  ]) {
    const refused = await call(admin, AI, {method: 'POST', payload: {readKey: 'fict-refused', scenes}});
    assert.equal(refused.status, 400, JSON.stringify(scenes));
    assert.equal(refused.body.error, '読みの束の入力を確かめてください');
    assert.deepEqual(await counts(db), empty);
  }
  // 作品のシーンでないもの（別の作品・無いシーン）が1つでもあれば、ほかの行も書かない
  const foreign = await call(admin, AI, {method: 'POST', payload: {scenes: [{sceneId: 971, ...reads('shot', 'shot')}, {sceneId: 979, ...reads('shot', 'shot')}, {sceneId: 99999, ...reads('shot', 'shot')}]}});
  assert.equal(foreign.status, 400);
  assert.deepEqual(foreign.body.details.map((e) => [e.scene, e.field, e.message]), [[1, 'sceneId', 'この作品のシーンではありません'], [2, 'sceneId', 'この作品のシーンではありません']]);
  // 組織に無い香盤の原本も断る
  const document = await call(admin, AI, {method: 'POST', payload: {sourceDocumentId: 99999, scenes: [{sceneId: 971, ...reads('shot', 'shot')}]}});
  assert.deepEqual([document.status, document.body.details.map((e) => e.field)], [400, ['sourceDocumentId']]);
  assert.deepEqual(await counts(db), empty);
});

test('FR-PROD-SCHED-105 同じ束の鍵の2回目は 409 で二重に入れない。別の組織と書けない人は書けない', async (t) => {
  const {db, login, call} = await setup(t);
  const production = await login('production@openingnight.invalid');
  const payload = {readKey: 'fict-bundle-dup', scenes: [{sceneId: 971, ...reads('shot', 'shot')}]};
  assert.equal((await call(production, AI, {method: 'POST', payload})).status, 201);
  const again = await call(production, AI, {method: 'POST', payload: {...payload, scenes: [{sceneId: 972, ...reads('shot', 'shot')}]}});
  assert.deepEqual([again.status, again.body.error], [409, '同じ束の鍵の読みがもうあります（二重に入れません）']);
  // 別の撮影日でも同じ鍵は二重に入れない
  assert.equal((await call(production, '/production/shoot-records/days/872/ai-results', {method: 'POST', payload})).status, 409);
  assert.deepEqual(await counts(db), {reads: 2, results: 1, links: 1});
  // 別の組織は有無を見せず 403（書き込みも要確認も）
  const outsider = await login('outsider@other.invalid');
  const foreign = await call(outsider, AI, {method: 'POST', payload: {readKey: 'fict-other', scenes: [{sceneId: 971, ...reads('shot', 'shot')}]}});
  assert.deepEqual([foreign.status, foreign.body.error], [403, 'この作品の撮影の記録への権限がありません']);
  assert.equal((await call(outsider, '/production/shoot-records/reads/pending?workId=1')).status, 403);
  // 案件の権限が制作でない制作担当は、読めるが書けない
  await db.run("UPDATE project_memberships SET permission='edit' WHERE org_id=1 AND project_id=1 AND user_id=3");
  const reader = await login('production@openingnight.invalid');
  assert.equal((await call(reader, AI, {method: 'POST', payload: {readKey: 'fict-reader', scenes: [{sceneId: 972, ...reads('shot', 'shot')}]}})).status, 403);
  assert.equal((await call(reader, '/production/shoot-records/reads/pending?workId=1')).status, 200);
  assert.deepEqual(await counts(db), {reads: 2, results: 1, links: 1});
});

test('FR-PROD-SCHED-106 FR-CORE-DATA-066 サービストークンの呼び出しは、いまの結果の受け口で撮れた・一部が 400、順延・欠番は通り、2回の読みの受け口からは入れられる。人のログインは今までどおり', async (t) => {
  const {db} = await setup(t);
  const service = await appAs(db, 'service_token');
  const results = '/production/shoot-records/days/871/results';
  for (const result of ['shot', 'partial']) {
    const refused = await service(results, {method: 'POST', payload: {sceneId: 971, result}});
    assert.deepEqual([refused.status, refused.body.error], [400, 'AI は撮れた・一部を2回の読みの受け口から入れます'], result);
  }
  assert.equal(await count(db, 'shooting_scene_results'), 0);
  assert.equal((await service(results, {method: 'POST', payload: {sceneId: 971, result: 'postponed', postponedToDayId: 872}})).status, 201);
  assert.equal((await service(results, {method: 'POST', payload: {sceneId: 972, result: 'dropped'}})).status, 201);
  const ai = await service(AI, {method: 'POST', payload: {scenes: [{sceneId: 973, ...reads('shot', 'shot')}]}});
  assert.deepEqual([ai.status, ai.body.counts.added], [201, 1]);
  // 人のログイン（access）と印の無い呼び出しは、いまの結果の受け口で撮れた・一部を入れられる
  for (const via of ['access', undefined]) {
    const person = await appAs(db, via);
    assert.equal((await person(results, {method: 'POST', payload: {sceneId: 974, result: 'shot'}})).status, 201, String(via));
    assert.equal((await person(results, {method: 'POST', payload: {sceneId: 975, result: 'partial'}})).status, 201, String(via));
  }
  assert.equal(await count(db, 'shooting_scene_results'), 7);
});

test('FR-PROD-SCHED-103 読みの記録と結びは追記だけで変更・削除を DB が断り、結べるのは別のモデルの一致した2回の読みを読み替えた結果だけ', async (t) => {
  const {db, login, call} = await setup(t);
  const admin = await login('admin@openingnight.invalid');
  assert.equal((await call(admin, AI, {method: 'POST', payload: {readKey: 'fict-db', scenes: [{sceneId: 971, ...reads('not_shot', 'not_shot')}, {sceneId: 972, ...reads('shot', 'partial')}]}})).status, 201);
  for (const table of ['shooting_scene_reads', 'shooting_scene_result_reads']) {
    await rejects(db.run(`UPDATE ${table} SET read_key='fict-x' WHERE org_id=1`), 'raise', /scene read record immutable/);
    await rejects(db.run(`DELETE FROM ${table} WHERE org_id=1`), 'raise', /scene read record immutable/);
  }
  // 割れた S#72 の束に、人が足したような結果を結ぶ → 断る。一致した S#71（not_shot）に、撮れたの結果を結ぶ → 断る
  await db.run("INSERT INTO shooting_scene_results(org_id,project_id,work_id,shooting_day_id,scene_id,seq,result,created_by) VALUES(1,1,1,871,972,1,'shot',1)");
  const split = Number((await db.get('SELECT id FROM shooting_scene_results WHERE org_id=1 AND scene_id=972')).id);
  await rejects(db.run("INSERT INTO shooting_scene_result_reads(org_id,work_id,scene_id,result_id,read_key) VALUES(1,1,972,?,'fict-db')", [split]), 'raise', /scene result reads disagree/);
  await db.run("INSERT INTO shooting_scene_results(org_id,project_id,work_id,shooting_day_id,scene_id,seq,result,created_by) VALUES(1,1,1,871,971,2,'shot',1)");
  const wrong = Number((await db.get('SELECT id FROM shooting_scene_results WHERE org_id=1 AND scene_id=971 AND seq=2')).id);
  await rejects(db.run("INSERT INTO shooting_scene_result_reads(org_id,work_id,scene_id,result_id,read_key) VALUES(1,1,971,?,'fict-other')", [wrong]), 'raise', /scene result reads disagree/);
  // 読みの記録: 2回目は別のモデルの1回目があるときだけ。1つの鍵は1つの撮影日だけ
  const insertRead = (key, day, readNo, model) => db.run(`INSERT INTO shooting_scene_reads(org_id,project_id,work_id,shooting_day_id,scene_id,read_key,read_no,model,reading,prior_result_seq,created_by)
    VALUES(1,1,1,?,973,?,?,?,'shot',0,1)`, [day, key, readNo, model]);
  await rejects(insertRead('fict-solo', 871, 2, A), 'raise', /scene read not independent/);
  await insertRead('fict-same', 871, 1, A);
  await rejects(insertRead('fict-same', 871, 2, ` ${A.toUpperCase()}`), 'raise', /scene read not independent/);
  await rejects(insertRead('fict-same', 872, 1, A), 'raise', /scene read key spans days/);
  await rejects(insertRead('fict-same', 871, 1, B), 'unique', /./);
  // 結びは AI が入れた結果の行だけ: 一致した S#71 の1行
  assert.deepEqual((await db.all('SELECT scene_id,read_key FROM shooting_scene_result_reads')).map((r) => [Number(r.scene_id), r.read_key]), [[971, 'fict-db']]);
});

test('FR-PROD-SCHED-109 AI が入れた結果も未解決の引き算では人の結果と同じ: 撮れず は移し先の無い順延で「移先未定」に残り、撮れたは消える', async (t) => {
  const {login, call} = await setup(t);
  const production = await login('production@openingnight.invalid');
  const leftover = async () => (await call(production, '/production/shoot-records/leftover?workId=1')).body;
  assert.equal((await leftover()).counts.unresolved, 5);
  assert.equal((await call(production, AI, {method: 'POST', payload: {scenes: [{sceneId: 971, ...reads('shot', 'shot')}, {sceneId: 972, ...reads('not_shot', 'not_shot')},
    {sceneId: 973, ...reads('partial', 'partial')}, {sceneId: 974, ...reads('shot', 'not_shot')}]}})).status, 201);
  const body = await leftover();
  assert.deepEqual(body.rows.map((row) => [row.sceneNo, row.reasonLabel, row.lastResult]), [['72', '移先未定', 'postponed'], ['73', '一部', 'partial'], ['74', '結果なし', null], ['75', '結果なし', null]]);
  assert.deepEqual(body.counts, {unresolved: 4, shot: 1, upcoming: 0, dropped: 0});
});

test('FR-PROD-SCHED-108 ホームの「香盤の読みが割れたシーン」: 全役割に確認待ちで出し、見てよい作品だけ・人が結果を足すと消える', async (t) => {
  const {days, login, call} = await setup(t);
  const production = await login('production@openingnight.invalid');
  assert.equal((await call(production, AI, {method: 'POST', payload: {scenes: [{sceneId: 971, ...reads('shot', 'shot')}, {sceneId: 974, ...reads('shot', 'partial')}]}})).status, 201);
  const queue = async (email) => Object.fromEntries((await call(await login(email), '/work-queue')).body.items.map((item) => [item.id, item]));
  for (const email of ['admin@openingnight.invalid', 'editor@openingnight.invalid', 'production@openingnight.invalid']) {
    const item = (await queue(email))['scene-reads-pending'];
    assert.deepEqual({id: item.id, title: item.title, page: item.page, params: item.params, tone: item.tone, count: item.count},
      {id: 'scene-reads-pending', title: '香盤の読みが割れたシーン', page: '撮影の記録', params: {view: 'leftover'}, tone: 'warn', count: 1}, email);
    assert.deepEqual(item.rows, [{label: 'S#74・架空の坂74', detail: `風のあとさき・${days.past.replaceAll('-', '/')}・撮れた／一部`, workId: 1}], email);
  }
  assert.equal((await queue('outsider@other.invalid'))['scene-reads-pending'].count, 0);
  assert.equal((await call(production, '/production/shoot-records/days/871/results', {method: 'POST', payload: {sceneId: 974, result: 'dropped'}})).status, 201);
  assert.equal((await queue('production@openingnight.invalid'))['scene-reads-pending'].count, 0);
});
