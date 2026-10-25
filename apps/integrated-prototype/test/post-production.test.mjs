// ポストプロダクション（移行 0025）を、純関数（src/production/post/post-model.mjs）・DB の制約・受け口（post-routes.mjs）で確かめる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。期待値は要件 docs/requirements/production/post-production.md から手で書いた。
// 架空のデータだけを使う（組織1・2と利用者・試作の作品1・2は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {formatTc, noteState, parseTc, postFolderStatus, taskState, vimeoEmbed} from '../src/production/post/post-model.mjs';

const WORK = 1;
const OTHER_ORG_WORK = 2;

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

test('FR-PROD-POST-005 TC は 00:12:40・12:40・秒で読め、読めない形は null。Vimeo の非公開リンクは埋め込みの URL になる', () => {
  assert.equal(parseTc('00:12:40'), 760);
  assert.equal(parseTc('12:40'), 760);
  assert.equal(parseTc('1:02:03'), 3723);
  assert.equal(parseTc('01:02:03:12'), 3723);
  assert.equal(parseTc('125'), 125);
  assert.equal(parseTc('00:61:00'), null);
  assert.equal(parseTc('abc'), null);
  assert.equal(formatTc(3723), '01:02:03');
  assert.equal(vimeoEmbed('https://vimeo.com/123456789/abcdef1234'), 'https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1');
  assert.equal(vimeoEmbed('https://player.vimeo.com/video/123456789?h=ff00aa11'), 'https://player.vimeo.com/video/123456789?h=ff00aa11&dnt=1');
  assert.equal(vimeoEmbed('https://vimeo.com/123456789'), 'https://player.vimeo.com/video/123456789?dnt=1');
  assert.equal(vimeoEmbed('https://example.com/video/123456789'), null);
  assert.equal(vimeoEmbed('http://vimeo.com/123456789'), null);
});

test('FR-PROD-POST-006 FR-PROD-POST-008 指摘・タスク・フォルダの状態は足した行の最後から導く', () => {
  assert.equal(noteState([]), 'open');
  assert.equal(noteState([{result: 'fixed'}, {result: 'reopen'}]), 'open');
  assert.equal(noteState([{result: 'hold'}, {result: 'fixed'}]), 'fixed');
  assert.deepEqual(taskState({dueOn: '2026-10-20'}, [{kind: 'done', onDate: '2026-10-21'}, {kind: 'undone', onDate: '2026-10-22'}, {kind: 'due', dueOn: '2026-10-30', onDate: '2026-10-22'}]),
    {done: false, doneOn: null, dueOn: '2026-10-30'});
  const today = '2026-10-24';
  assert.equal(postFolderStatus({tasks: [], deliverables: [], notes: [], finalScreeningNoteOpen: false, today}).state, 'not_started');
  const late = postFolderStatus({tasks: [{phase: 'edit', done: false, dueOn: '2026-10-20'}], deliverables: [{status: 'pending'}], notes: [{state: 'open'}], finalScreeningNoteOpen: false, today});
  assert.deepEqual([late.state, late.reason], ['needs_review', '残 1・期限超']);
  const done = postFolderStatus({tasks: [{phase: 'edit', done: true, dueOn: '2026-10-20'}], deliverables: [{status: 'delivered', onDate: '2026-10-22'}, {status: 'delivered', onDate: '2026-10-23'}],
    notes: [{state: 'fixed'}], finalScreeningNoteOpen: false, today});
  assert.deepEqual([done.state, done.doneOn], ['done', '2026-10-23']);
  assert.equal(postFolderStatus({tasks: [], deliverables: [{status: 'delivered', onDate: '2026-10-23'}], notes: [{state: 'open'}], finalScreeningNoteOpen: true, today}).state, 'needs_review');
});

test('FR-PROD-POST-001 FR-PROD-POST-003 FR-PROD-POST-004 版を足し、止めた TC にメモを残して対応すると、残りの数と状態が変わる', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const production = await login('production@openingnight.invalid');
  const cut = await call(production, `/post/works/${WORK}/cuts`, {method: 'POST', payload: {label: 'v3', kind: 'work', episodeNo: 1, variant: '地上波版',
    deliveredOn: '2026-10-14', runtime: '24:10', reviewUrl: 'https://vimeo.com/123456789/abcdef1234'}});
  assert.equal(cut.status, 201, JSON.stringify(cut.body));
  let detail = (await call(production, `/post/works/${WORK}`)).body;
  const cutId = detail.cuts[0].id;
  assert.deepEqual([detail.cuts[0].runtimeSeconds, detail.cuts[0].embedUrl], [1450, 'https://player.vimeo.com/video/123456789?h=abcdef1234&dnt=1']);
  const note = await call(production, `/post/works/${WORK}/notes`, {method: 'POST', payload: {cutId, tcIn: '00:12:40', tcOut: '00:12:52', viewpoint: '専門の確認',
    fromRole: '監修・専門家', assignee: '編集', body: '7巡目の捨て牌の順番が違う'}});
  assert.equal(note.status, 201, JSON.stringify(note.body));
  detail = (await call(production, `/post/works/${WORK}`)).body;
  assert.deepEqual([detail.notes[0].tcIn, detail.notes[0].tcOut, detail.notes[0].state, detail.numbers.openNotes], [760, 772, 'open', 1]);
  const bad = await call(production, `/post/works/${WORK}/notes`, {method: 'POST', payload: {cutId, tcIn: '00:12:40', tcOut: '00:10:00', viewpoint: '編集', fromRole: '監督', assignee: '編集', body: 'x'}});
  assert.equal(bad.status, 400);
  const skip = await call(production, `/post/works/${WORK}/notes/${detail.notes[0].id}/actions`, {method: 'POST', payload: {result: 'skipped'}});
  assert.equal(skip.status, 400);
  const fixed = await call(production, `/post/works/${WORK}/notes/${detail.notes[0].id}/actions`, {method: 'POST', payload: {result: 'fixed', fixedCutId: cutId}});
  assert.equal(fixed.status, 201);
  detail = (await call(production, `/post/works/${WORK}`)).body;
  assert.deepEqual([detail.notes[0].state, detail.numbers.openNotes], ['fixed', 0]);
  // 書き換え・削除は DB が断る（足すだけ）
  await assert.rejects(db.run('UPDATE post_notes SET body=? WHERE org_id=1', ['書き換え']), (error) => dbErrorKind(error) === 'raise' && /immutable/.test(error.message));
  await assert.rejects(db.run('DELETE FROM post_cuts WHERE org_id=1'), (error) => dbErrorKind(error) === 'raise' && /immutable/.test(error.message));
});

test('FR-PROD-POST-002 工程のタスクを足して済みにすると、工程の「済／全部」と期限超の数が変わる', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const editor = await login('editor@openingnight.invalid');
  for (const [name, dueOn] of [['オフライン v1', '2000-01-10'], ['画フィックス', '2999-12-31']]) {
    const r = await call(editor, `/post/works/${WORK}/tasks`, {method: 'POST', payload: {phase: 'edit', name, dueOn, episodeNo: 1}});
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  let detail = (await call(editor, `/post/works/${WORK}`)).body;
  let edit = detail.phases.find((p) => p.phase === 'edit');
  assert.deepEqual([edit.done, edit.total, edit.late, detail.numbers.lateTasks], [0, 2, 1, 1]);
  const first = detail.tasks.find((x) => x.name === 'オフライン v1');
  assert.equal((await call(editor, `/post/works/${WORK}/tasks/${first.id}/events`, {method: 'POST', payload: {kind: 'done'}})).status, 201);
  detail = (await call(editor, `/post/works/${WORK}`)).body;
  edit = detail.phases.find((p) => p.phase === 'edit');
  assert.deepEqual([edit.done, edit.total, edit.late], [1, 2, 0]);
  assert.equal(detail.tasks.find((x) => x.id === first.id).done, true);
  assert.equal((await call(editor, `/post/works/${WORK}/tasks/${first.id}/events`, {method: 'POST', payload: {kind: 'due'}})).status, 400);
});

test('FR-PROD-POST-009 FR-PROD-POST-010 契約の納入物件の型から12行を作り、状態を足すと納品済みの数とフォルダの状態が変わる', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const made = await call(admin, `/post/works/${WORK}/deliverables`, {method: 'POST', payload: {template: 'contract'}});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.count, 12);
  let detail = (await call(admin, `/post/works/${WORK}`)).body;
  assert.deepEqual([detail.numbers.total, detail.numbers.pending, detail.numbers.delivered], [12, 12, 0]);
  for (const item of detail.deliverables) {
    assert.equal((await call(admin, `/post/works/${WORK}/deliverables/${item.id}/events`, {method: 'POST', payload: {status: 'delivered', onDate: '2026-10-23'}})).status, 201);
  }
  detail = (await call(admin, `/post/works/${WORK}`)).body;
  assert.deepEqual([detail.numbers.delivered, detail.folderStatus.state, detail.folderStatus.doneOn], [12, 'done', '2026-10-23']);
  const list = (await call(admin, '/post/works')).body;
  assert.equal(list.works.find((w) => w.workId === WORK).numbers.delivered, 12);
});

test('FR-PROD-POST-011 別の組織の作品と、案件に所属しない作品は同じ 403 にし、別組織の作品は一覧に出ない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const production = await login('production@openingnight.invalid');
  assert.equal((await call(production, `/post/works/${OTHER_ORG_WORK}`)).status, 403);
  assert.equal((await call(production, `/post/works/${OTHER_ORG_WORK}/tasks`, {method: 'POST', payload: {phase: 'edit', name: 'x'}})).status, 403);
  assert.equal((await call(production, '/post/works/999999')).status, 403);
  const list = (await call(production, '/post/works')).body;
  assert.deepEqual(list.works.map((w) => w.workId), [WORK]);
  const outsider = await login('outsider@other.invalid');
  assert.equal((await call(outsider, `/post/works/${WORK}`)).status, 403);
});
