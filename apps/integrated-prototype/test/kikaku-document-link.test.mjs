// 既存原本の検索とIDでの結び付け。同じ試験をSQLite/PGliteで流す。すべて架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerSourceDocument, getSourceDocument} from '../src/source-documents/source-documents-store.mjs';

async function fixture(t) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path, payload) => {
    const r = await app.request(`/api${path}`, {method: payload === undefined ? 'GET' : 'POST',
      headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    return {status: r.status, body: await r.json()};
  };
  const admin = await login('admin@openingnight.invalid');
  const editor = await login('editor@openingnight.invalid');
  const production = await login('production@openingnight.invalid');
  const add = (overrides = {}) => registerSourceDocument(db, {orgId: 1, userId: 1, kind: 'planning_deck', fileName: '架空企画書.pptx',
    receivedOn: '2026-10-25', external: {location: 'current/demo/企画/架空企画書.pptx', byteLength: 9 * 1024 * 1024, sha256: 'a'.repeat(64)}, ...overrides});
  return {db, call, admin, editor, production, add};
}

test('FR-PLAN-KIKAKU-051 原本一覧は組織内のメタデータだけを管理者と編集者に返し、制作担当は403', async (t) => {
  const {call, admin, editor, production, add} = await fixture(t);
  const external = await add();
  const inline = await add({fileName: '架空試算.pdf', kind: 'budget', external: undefined, bytes: new TextEncoder().encode('架空の中身')});
  await add({orgId: 2, userId: 4});
  for (const cookie of [admin, editor]) {
    const r = await call(cookie, '/source-documents');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((d) => d.id), [external.id, inline.id]);
    assert.deepEqual(r.body.items[0], {id: external.id, kind: 'planning_deck', fileName: '架空企画書.pptx', byteLength: 9437184,
      sha256: 'a'.repeat(64), storage: 'external', externalLocation: 'current/demo/企画/架空企画書.pptx', receivedOn: '2026-10-25'});
    assert.deepEqual(Object.keys(r.body.items[1]).sort(), ['id', 'kind', 'fileName', 'byteLength', 'sha256', 'storage', 'externalLocation', 'receivedOn'].sort());
    assert.equal(r.body.items[1].externalLocation, null);
  }
  assert.equal((await call(production, '/source-documents')).status, 403);
});

test('FR-PLAN-KIKAKU-051 原本一覧は名前と場所の部分一致・種類で絞り、検索記号を文字として扱う', async (t) => {
  const {call, admin, add} = await fixture(t);
  const first = await add();
  const second = await add({kind: 'budget', fileName: '試算_100%.xlsx', external: {location: 'current/demo/trials/試算.xlsx', byteLength: 1024, sha256: 'b'.repeat(64)}});
  for (const [query, ids] of [['q=企画書', [first.id]], ['q=trials', [second.id]], ['q=_100%', [second.id]], ['q=demo&kind=budget', [second.id]], ['q=なし', []]]) {
    const r = await call(admin, `/source-documents?${encodeURI(query)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items.map((d) => d.id), ids);
  }
  assert.equal((await call(admin, '/source-documents?kind=invalid')).status, 400);
});

test('FR-PLAN-KIKAKU-051 原本一覧は200件までで、上限の外の原本も検索すると選べる', async (t) => {
  const {call, admin, add} = await fixture(t);
  for (let i = 1; i <= 200; i += 1) await add({fileName: `架空${i}.pptx`, external: {location: `current/demo/${i}`, byteLength: 1, sha256: i.toString(16).padStart(64, '0')}});
  assert.equal((await call(admin, '/source-documents')).body.items.length, 200);
  const last = await add({fileName: '最後の架空原本.pptx'});
  assert.equal((await call(admin, '/source-documents?limit=999')).body.items.length, 200);
  assert.deepEqual((await call(admin, `/source-documents?q=${encodeURIComponent('最後')}`)).body.items.map((d) => d.id), [last.id]);
});

test('FR-PLAN-KIKAKU-052 external原本をIDで結ぶと企画のまとめに現れ、中身と原本の行は変わらない', async (t) => {
  const {db, call, editor, add} = await fixture(t);
  const {id: documentId} = await add();
  const before = await getSourceDocument(db, 1, documentId, {withContent: true});
  const linked = await call(editor, '/planning/kikaku/1/documents/link', {documentId, kind: 'deck', note: '架空の記録'});
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.documentId, documentId);
  const detail = await call(editor, '/planning/kikaku/1');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.documents.length, 1);
  assert.equal(detail.body.documents[0].documentId, documentId);
  assert.equal(detail.body.documents[0].fileName, '架空企画書.pptx');
  assert.equal(detail.body.documents[0].byteLength, 9437184);
  assert.equal(detail.body.documents[0].storage, 'external');
  assert.equal(detail.body.documents[0].externalLocation, 'current/demo/企画/架空企画書.pptx');
  assert.equal(detail.body.documents[0].role, 'draft');
  assert.equal(detail.body.documents[0].note, '架空の記録');
  assert.deepEqual(await getSourceDocument(db, 1, documentId, {withContent: true}), before);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM source_documents WHERE org_id=1')).n), 1);
});

test('FR-PLAN-KIKAKU-052 別組織・不明の原本と権限のない案件は403で結び付かない', async (t) => {
  const {db, call, admin, editor, production, add} = await fixture(t);
  const own = await add();
  const other = await add({orgId: 2, userId: 4});
  const made = await call(admin, '/planning/kikaku/projects', {code: 'KK-PRIVATE', title: '架空の非所属企画'});
  assert.equal(made.status, 201);
  for (const [cookie, projectId, documentId] of [[admin, 1, other.id], [admin, 1, 999999], [admin, 2, own.id], [editor, made.body.id, own.id], [production, 1, own.id]]) {
    const r = await call(cookie, `/planning/kikaku/${projectId}/documents/link`, {documentId, kind: 'deck'});
    assert.equal(r.status, 403, JSON.stringify(r.body));
  }
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM planning_documents')).n), 0);
});

test('FR-PLAN-KIKAKU-052 同じ原本・種類・役の2回目は409で、提出版には提出日が要る', async (t) => {
  const {call, admin, add} = await fixture(t);
  const {id: documentId} = await add();
  const path = '/planning/kikaku/1/documents/link';
  for (const input of [{}, {documentId: 0, kind: 'deck'}, {documentId: true, kind: 'deck'}, {documentId, kind: 'invalid'},
    {documentId, kind: 'deck', role: 'submitted'}, {documentId, kind: 'deck', role: 'submitted', submittedOn: '2026/10/25'}]) {
    assert.equal((await call(admin, path, input)).status, 400);
  }
  for (const payload of [{documentId, kind: 'deck'}, {documentId, kind: 'deck', role: 'submitted', submittedOn: '2026-10-25', submittedTo: '架空社'},
    {documentId, kind: 'trial'}, {documentId, kind: 'material'}]) {
    assert.equal((await call(admin, path, payload)).status, 201);
    const dup = await call(admin, path, payload);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, '同じ原本は受け取り済みです');
  }
  const detail = await call(admin, '/planning/kikaku/1');
  assert.equal(detail.body.documents.length, 4);
  assert.equal(detail.body.documents.find((d) => d.role === 'submitted').submittedTo, '架空社');
  assert.equal(detail.body.readiness.marks.find((m) => m.key === 'deck').done, true);
});
