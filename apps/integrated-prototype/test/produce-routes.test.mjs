// プロデュース管理の進行表（移行 0047）を、DB の制約と受け口（src/planning/produce/produce-routes.mjs）で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は要件 docs/requirements/planning/produce-progress.md の FR-PLAN-PRODUCE から手で書いた。架空のデータだけを使う（組織1・2と試作の案件1・2は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {STANDARD_TEMPLATE, boardSummary, tasksFromTemplate, templateFromTasks, taskState} from '../src/planning/produce/produce-model.mjs';

const DEMO_PROJECT = 1;
const OTHER_ORG_PROJECT = 2;

async function appWithLogin(db) {
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
  return {login, call};
}
const p = (entry = '') => `/produce/projects/${DEMO_PROJECT}${entry}`;

test('FR-PLAN-PRODUCE-001 FR-PLAN-PRODUCE-002 FR-PLAN-PRODUCE-003 FR-PLAN-PRODUCE-009 チケットを（関連する場所つきで）足して直すと版が増え、最新の版だけが進行表に出る。DB は変更と削除を断る', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const made = await call(admin, p('/tasks'), {method: 'POST', payload: {title: '予告編の確認', phase: 'post', kind: 'check', role: 'producer',
    plannedStart: '2026-12-01', plannedEnd: '2026-12-02', checkers: '監督・P', links: [{label: '予告編', target: '?p=catalog'}]}});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const uid = made.body.taskUid;
  const noReason = await call(admin, p(`/tasks/${uid}/versions`), {method: 'POST', payload: {baseVersionNo: 1, plannedEnd: '2026-12-03'}});
  assert.equal(noReason.status, 400);
  const edited = await call(admin, p(`/tasks/${uid}/versions`), {method: 'POST', payload: {baseVersionNo: 1, plannedEnd: '2026-12-03', reason: '監督の都合'}});
  assert.equal(edited.status, 201, JSON.stringify(edited.body));
  const stale = await call(admin, p(`/tasks/${uid}/versions`), {method: 'POST', payload: {baseVersionNo: 1, plannedEnd: '2026-12-04', reason: '古い画面から'}});
  assert.equal(stale.status, 409);
  const board = await call(admin, p());
  assert.equal(board.status, 200);
  const task = board.body.tasks.find((x) => x.taskUid === uid);
  assert.deepEqual([task.versionNo, task.plannedEnd, task.kind, task.checkers], [2, '2026-12-03', 'check', '監督・P']);
  assert.deepEqual(board.body.links.filter((l) => l.taskUid === uid).map((l) => l.label), ['予告編']);
  const retired = await call(admin, p(`/tasks/${uid}/versions`), {method: 'POST', payload: {baseVersionNo: 2, retired: true, reason: 'やめた'}});
  assert.equal(retired.status, 201);
  assert.equal((await call(admin, p())).body.tasks.some((x) => x.taskUid === uid), false);
  await assert.rejects(db.run('UPDATE produce_tasks SET title=? WHERE org_id=1', ['書き換え']), (e) => dbErrorKind(e) === 'raise' && /immutable/.test(e.message));
  await assert.rejects(db.run('DELETE FROM produce_tasks WHERE org_id=1'), (e) => dbErrorKind(e) === 'raise' && /immutable/.test(e.message));
});

test('FR-PLAN-PRODUCE-004 FR-PLAN-PRODUCE-006 着手・完了の記録とチェック項目・掲示板が残り、完了は戻せる', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const uid = (await call(admin, p('/tasks'), {method: 'POST', payload: {title: 'カラコレ', phase: 'post', role: 'line_producer', plannedStart: '2020-01-01', plannedEnd: '2020-01-05'}})).body.taskUid;
  assert.equal((await call(admin, p())).body.tasks.find((x) => x.taskUid === uid).state, 'late');
  assert.equal((await call(admin, p(`/tasks/${uid}/events`), {method: 'POST', payload: {kind: 'done', onDate: '2020-01-05'}})).status, 201);
  assert.equal((await call(admin, p())).body.tasks.find((x) => x.taskUid === uid).state, 'done');
  await call(admin, p(`/tasks/${uid}/events`), {method: 'POST', payload: {kind: 'reopened', onDate: '2020-01-06'}});
  assert.equal((await call(admin, p())).body.tasks.find((x) => x.taskUid === uid).state, 'late');
  const check = await call(admin, p(`/tasks/${uid}/checks`), {method: 'POST', payload: {label: '完成台本を渡す'}});
  assert.equal(check.status, 201);
  await call(admin, p(`/tasks/${uid}/checks`), {method: 'POST', payload: {checkUid: check.body.checkUid, checked: true}});
  assert.equal((await call(admin, p(`/tasks/${uid}/posts`), {method: 'POST', payload: {speakerLabel: 'LP', body: '撮影部の立ち会いは12/3'}})).status, 201);
  const board = (await call(admin, p())).body;
  assert.deepEqual(board.checks.filter((x) => x.taskUid === uid).map((x) => [x.label, x.checked]), [['完成台本を渡す', true]]);
  assert.deepEqual(board.posts.filter((x) => x.taskUid === uid).map((x) => [x.speakerLabel, x.body]), [['LP', '撮影部の立ち会いは12/3']]);
  await assert.rejects(db.run("INSERT INTO produce_task_posts(org_id,project_id,task_uid,speaker_label,body,created_by) VALUES(1,1,99999,'P','無いチケット',1)"),
    (e) => dbErrorKind(e) === 'raise' && /not found/.test(e.message));
});

test('FR-PLAN-PRODUCE-007 標準の進行を当てると20件のチケット（代表の19項目と節目「初号」）ができ、その進行をテンプレートとして残して別の起点で当て直せる', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const applied = await call(admin, p('/apply-template'), {method: 'POST', payload: {templateId: 'standard', anchorDate: '2026-08-04'}});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.created, 20);
  const board = (await call(admin, p())).body;
  const shoot = board.tasks.find((x) => x.title === '撮影期間');
  assert.deepEqual([shoot.plannedStart, shoot.plannedEnd, shoot.templateLabel], ['2026-08-04', '2026-08-31', '標準の進行']);
  assert.equal(board.tasks.find((x) => x.title === '納品').plannedStart, '2027-01-01');
  assert.ok(board.links.some((l) => l.isFallback), 'カット割り表は仮の書類として印が付く');
  const saved = await call(admin, p('/save-template'), {method: 'POST', payload: {name: '架空の進行'}});
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const list = (await call(admin, '/produce/templates')).body.templates;
  const mine = list.find((x) => x.name === '架空の進行');
  assert.equal(mine.items.length, 20);
  assert.equal(mine.items.find((i) => i.title === '撮影期間').startOffsetDays, 0);
});

test('FR-PLAN-PRODUCE-008 別の組織の案件は有無を見せず403、書き込みも403', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  assert.equal((await call(admin, `/produce/projects/${OTHER_ORG_PROJECT}`)).status, 403);
  assert.equal((await call(admin, `/produce/projects/${OTHER_ORG_PROJECT}/tasks`, {method: 'POST', payload: {title: 'x', phase: 'post', plannedStart: '2026-01-01'}})).status, 403);
  assert.equal((await call(admin, '/produce/projects/999999')).status, 403);
});

test('FR-PLAN-PRODUCE-005 上の箱: 初号・納品までの日数、初号までのチェックの回数と次のチェック、遅れの数', () => {
  const tasks = [
    {taskUid: 1, kind: 'check', title: '監督チェック①', plannedStart: '2026-11-12', plannedEnd: '2026-11-14', checkers: '監督・P'},
    {taskUid: 2, kind: 'check', title: '音チェック', plannedStart: '2026-12-20', plannedEnd: '2026-12-21', checkers: '監督・録音'},
    {taskUid: 3, kind: 'check', title: '完成後の確認', plannedStart: '2027-01-05', plannedEnd: '2027-01-05', checkers: 'P'},
    {taskUid: 4, kind: 'milestone', title: '初号', milestoneCode: 'first_print', plannedStart: '2026-12-22', plannedEnd: '2026-12-22'},
    {taskUid: 5, kind: 'milestone', title: '納品', milestoneCode: 'delivery', plannedStart: '2027-01-15', plannedEnd: '2027-01-15'},
    {taskUid: 6, kind: 'work', title: '編集期間', plannedStart: '2026-09-07', plannedEnd: '2026-11-01'},
  ];
  const states = {1: 'done', 2: 'plan', 3: 'plan', 4: 'plan', 5: 'plan', 6: 'late'};
  const s = boardSummary(tasks, states, '2026-11-10');
  assert.deepEqual(s.firstPrint, {date: '2026-12-22', days: 42});
  assert.deepEqual(s.delivery, {date: '2027-01-15', days: 66});
  assert.deepEqual(s.checks, {total: 2, done: 1, until: '2026-12-22'});
  assert.equal(s.nextCheck.title, '音チェック');
  assert.equal(s.late, 1);
  assert.equal(taskState({plannedStart: '2026-11-01', plannedEnd: '2026-11-05'}, [], '2026-11-10'), 'late');
  assert.equal(taskState({plannedStart: '2026-11-01', plannedEnd: '2026-11-20'}, [], '2026-11-10'), 'now');
  const built = tasksFromTemplate(STANDARD_TEMPLATE, '2026-08-04');
  const back = templateFromTasks(built.tasks.map((x, i) => ({...x, taskUid: i + 1})));
  assert.equal(back.anchor, '2026-08-04');
  assert.deepEqual(back.items.map((i) => i.startOffsetDays).sort((a, b) => a - b), STANDARD_TEMPLATE.items.map((i) => i.startOffsetDays).sort((a, b) => a - b));
});
