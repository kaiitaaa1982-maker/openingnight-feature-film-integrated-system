import {openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';
import {suggestCategory, sourceKindFor, currentPlacements, countByCategory} from '../src/preprod/vault-model.mjs';

test('名前と元のフォルダから種類を提案する（決まった規則だけ）', () => {
  const cases = [
    ['脚本/第8話 号外③.pdf', 'script'], ['総合予定表_1011.pdf', 'schedule'], ['日々スケ/決定/0415.pdf', 'daily'], ['1016日々スケ/1027.jpg', 'daily'],
    ['衣装香盤0413.pdf', 'costume'], ['地図/灯台のロケ先.pdf', 'location'], ['キャスト_スタッフ表/スタッフリスト.xlsx', 'cast'],
    ['スチールラフ/展望室/明るさの参考.jpg', 'still'], ['第8話_デザインラフ.pptx', 'design'], ['地図/契約/制作契約書.pdf', 'contract'],
    ['IMG_0001.jpg', 'still'], ['memo.txt', 'other'],
  ];
  for (const [path, want] of cases) assert.equal(suggestCategory(path), want, path);
  assert.equal(sourceKindFor('daily', '1027.jpg'), 'image');
  assert.equal(sourceKindFor('contract', 'scan.jpg'), 'contract');
  assert.equal(sourceKindFor('script', 'a.pdf'), 'script');
});

test('いまの置き場は原本ごとの最新の行。件数は種類ごと', () => {
  const rows = [{id: 1, document_id: 10, category: 'other'}, {id: 2, document_id: 11, category: 'script'}, {id: 3, document_id: 10, category: 'location'}];
  const now = currentPlacements(rows);
  assert.deepEqual(now.map((r) => [r.document_id, r.category]).sort(), [[10, 'location'], [11, 'script']]);
  assert.equal(countByCategory(now).location, 1);
});

async function login(app, email) { const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})}); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function call(app, cookie, method, path, body) { const r = await app.request(path, {method, headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, res: r}; }
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('保管庫: 置く・同じ原本は原本を増やさず置き場だけ足す・置き場を変える・開く。権限の無い人と別の作品は断る', async (t) => {
  const db = await openTestDb({t}), app = createApp({db});
  const production = await login(app, 'production@openingnight.invalid'), outsider = await login(app, 'outsider@other.invalid');
  const base = '/api/preprod/works/1/documents';

  const first = await call(app, production, 'POST', base, {fileName: '架空の地図.pdf', mediaType: 'application/pdf', base64: b64('架空の地図'), category: 'location', originPath: '地図'});
  assert.equal(first.status, 200);
  const firstBody = await first.res.json();
  assert.equal(firstBody.duplicate, false);
  const again = await (await call(app, production, 'POST', base, {fileName: '架空の地図（写し）.pdf', base64: b64('架空の地図'), category: 'other', originPath: '地図/契約'})).res.json();
  assert.deepEqual([again.id, again.duplicate], [firstBody.id, true]);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM source_documents')).n, 1);

  let list = await (await call(app, production, 'GET', base)).res.json();
  assert.equal(list.documents.length, 1);
  assert.equal(list.documents[0].category, 'other', '2回目に置いた置き場がいまの置き場');
  assert.deepEqual(list.documents[0].origins.sort(), ['地図', '地図/契約']);

  assert.equal((await call(app, production, 'POST', `${base}/${firstBody.id}/placements`, {category: 'location'})).status, 200);
  list = await (await call(app, production, 'GET', base)).res.json();
  assert.equal(list.documents[0].category, 'location');

  const content = await call(app, production, 'GET', `${base}/${firstBody.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(await content.res.text(), '架空の地図');

  assert.equal((await call(app, production, 'POST', base, {fileName: 'x.pdf', base64: b64('x'), category: 'nope'})).status, 400);
  assert.equal((await call(app, outsider, 'GET', base)).status, 403);
  assert.equal((await call(app, outsider, 'GET', `${base}/${firstBody.id}/content`)).status, 403);
  assert.equal((await call(app, production, 'POST', '/api/preprod/works/2/documents', {fileName: 'y.pdf', base64: b64('y'), category: 'other'})).status, 403);
  assert.equal((await call(app, production, 'GET', `/api/preprod/works/2/documents/${firstBody.id}/content`)).status, 403);
  await assert.rejects(db.run("UPDATE preprod_document_placements SET category='other'"), /immutable/);
});
