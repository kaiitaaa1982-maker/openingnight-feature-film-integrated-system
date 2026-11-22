// 共通の原本の中身を返す受け口（GET /api/source-documents/:id/content）。外の置き場は読むだけ。データは架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerSourceDocument, sha256Hex} from '../src/source-documents/source-documents-store.mjs';
import {businessDataKeyAllowed, contentDisposition} from '../src/source-documents/source-content.mjs';

const enc = (text) => new TextEncoder().encode(text);
async function login(app, email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('置き場で読んでよいキーは current/ の下だけで、上の階層へ出る部品や空の部品を通さない', () => {
  for (const key of ['current/ORG/F04_プロダクション/架空/日々スケ.pdf', 'current/a.pdf']) assert.equal(businessDataKeyAllowed(key), true, key);
  for (const key of ['ORG/a.pdf', 'current/', 'current//a.pdf', 'current/../secret', 'current/./a', 'current/a\\b', 'archive/a.pdf', null, 42])
    assert.equal(businessDataKeyAllowed(key), false, String(key));
});

test('日本語のファイル名は filename* で渡し、ASCII の側は記号を逃がす', () => {
  assert.equal(contentDisposition('架空の日々スケ.pdf'), `inline; filename="_______.pdf"; filename*=UTF-8''${encodeURIComponent('架空の日々スケ.pdf')}`);
  assert.equal(contentDisposition('a"b.pdf'), `inline; filename="a_b.pdf"; filename*=UTF-8''a%22b.pdf`);
});

test('外の置き場の原本は記録したキーで1回だけ読み、中身が記録と違えば返さない。置き場が無い・権限が無い・別組織は返さない', async (t) => {
  const db = await openTestDb({t});
  const body = enc('架空の日々スケの中身');
  const sha256 = await sha256Hex(body);
  const key = 'current/ORG/F04_プロダクション/架空/日々スケ_架空.pdf';
  const external = await registerSourceDocument(db, {orgId: 1, userId: 1, kind: 'schedule', fileName: '日々スケ_架空.pdf', mediaType: 'application/pdf',
    receivedOn: '2026-11-06', external: {location: key, byteLength: body.length, sha256}});
  const inline = await registerSourceDocument(db, {orgId: 1, userId: 1, kind: 'other', fileName: '架空のメモ.txt', mediaType: 'text/plain',
    receivedOn: '2026-11-06', bytes: enc('架空のメモ')});
  const externalId = external.id ?? external.document?.id, inlineId = inline.id ?? inline.document?.id;
  assert.ok(externalId && inlineId, JSON.stringify({external, inline}));

  const calls = [];
  let stored = body;
  const readBusinessObject = async (requested) => { calls.push(requested); return stored ? {arrayBuffer: async () => stored.slice().buffer} : null; };
  const app = createApp({db, mode: 'local', readBusinessObject});
  const admin = await login(app, 'admin@openingnight.invalid');
  const get = (cookie, id, target = app) => target.request(`/api/source-documents/${id}/content`, {headers: {cookie}});

  const ok = await get(admin, externalId);
  assert.equal(ok.status, 200);
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), body);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(calls, [key], '記録したキーで1回だけ読む');

  const own = await get(admin, inlineId);
  assert.equal(own.status, 200);
  assert.equal(new TextDecoder().decode(await own.arrayBuffer()), '架空のメモ');
  assert.equal(calls.length, 1, 'inline の原本は置き場を読まない');

  stored = enc('書き換えられた中身');
  assert.equal((await get(admin, externalId)).status, 409, '中身が記録と違えば返さない');
  stored = null;
  assert.equal((await get(admin, externalId)).status, 404, '置き場に無い');

  const production = await login(app, 'production@openingnight.invalid');
  assert.equal((await get(production, externalId)).status, 403, '制作担当は原本の一覧と同じく開けない');
  const outsider = await login(app, 'outsider@other.invalid');
  assert.notEqual((await get(outsider, externalId)).status, 200, '別組織の原本は返さない');
  assert.equal((await get(admin, 'abc')).status, 400);
  assert.equal((await get(admin, 999999)).status, 404);

  const unbound = createApp({db, mode: 'local'});
  assert.equal((await get(await login(unbound, 'admin@openingnight.invalid'), externalId, unbound)).status, 501, '置き場につながっていなければ 501');
});
