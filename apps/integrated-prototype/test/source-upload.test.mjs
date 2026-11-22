// 画面から原本を足す受け口（POST /api/source-documents/upload）。置き場は足すだけ（同じキーがあれば止める）。データは架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerSourceDocument, sha256Hex} from '../src/source-documents/source-documents-store.mjs';
import {businessDataPorts} from '../src/source-documents/business-data-bucket.mjs';
import {parseUpload, todayJst, MAX_UPLOAD_BYTES} from '../src/source-documents/source-upload.mjs';

const enc = (text) => new TextEncoder().encode(text);
const FOLDER = 'current/ORG/F03_プリプロダクション/架空/F03-07_許可申請';
async function login(app, email) {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
// R2 の束ねの代わり。put は条件（If-None-Match: *）が無ければ投げ、同じキーがあれば null、sha256 が中身と違えば投げる
function fakeBucket() {
  const objects = new Map(); const puts = [];
  return {objects, puts,
    get: async (key) => objects.has(key) ? {arrayBuffer: async () => objects.get(key).slice().buffer} : null,
    put: async (key, body, options = {}) => {
      puts.push(key);
      if (!(options.onlyIf instanceof Headers) || options.onlyIf.get('if-none-match') !== '*') throw new Error('条件なしの put');
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (objects.has(key)) return null;
      if (options.sha256 && options.sha256 !== await sha256Hex(bytes)) throw new Error('sha256 mismatch');
      objects.set(key, bytes);
      return {key, size: bytes.length};
    }};
}

test('置く先と名前の検査: current/ の下のフォルダと、ドライブへ写せる名前だけを通す', () => {
  const ok = {folder: FOLDER, name: '架空の申請書.pdf', sha256: 'a'.repeat(64), contentLength: '10'};
  assert.equal(parseUpload(ok).key, `${FOLDER}/架空の申請書.pdf`);
  assert.equal(parseUpload({...ok, folder: `${FOLDER}/`}).key, `${FOLDER}/架空の申請書.pdf`, '末尾の / は落とす');
  assert.equal(parseUpload({...ok, name: 'ガ.pdf'}).name, 'ガ.pdf', 'Mac の NFD は NFC に寄せる');
  assert.equal(parseUpload(ok).kind, 'other');
  for (const bad of [{folder: 'current'}, {folder: 'archive/ORG'}, {folder: 'current/../x'}, {folder: ''}, {folder: null},
    {name: 'a/b.pdf'}, {name: 'a\\b.pdf'}, {name: 'a#b.pdf'}, {name: 'a?.pdf'}, {name: '100%.pdf'}, {name: 'a:b.pdf'}, {name: '.hidden'}, {name: 'a.'}, {name: ''}, {name: 'x'.repeat(241)},
    {kind: 'unknown'}, {mediaType: 'text/plain; charset=x'}, {sha256: 'A'.repeat(64)}, {sha256: null}, {contentLength: '0'}, {contentLength: undefined}, {contentLength: '1e3'}])
    assert.ok(parseUpload({...ok, ...bad}).error, JSON.stringify(bad));
  assert.equal(parseUpload({...ok, contentLength: String(MAX_UPLOAD_BYTES)}).byteLength, MAX_UPLOAD_BYTES);
  assert.equal(parseUpload({...ok, contentLength: String(MAX_UPLOAD_BYTES + 1)}).status, 413);
  assert.equal(parseUpload({...ok, folder: `current/${'あ'.repeat(490)}`}).error, '置く先とファイル名を合わせて500字までにしてください');
  assert.equal(todayJst(new Date('2026-11-09T15:00:00Z')), '2026-11-10', '日本時間の日付');
});

test('置き場へ渡す口は get と条件付きの put だけ。条件なしの put を書く場所がない', async () => {
  assert.deepEqual(businessDataPorts(undefined), {readBusinessObject: null, addBusinessObject: null});
  const bucket = fakeBucket();
  const ports = businessDataPorts(bucket);
  assert.deepEqual(Object.keys(ports).sort(), ['addBusinessObject', 'readBusinessObject']);
  assert.deepEqual(await ports.addBusinessObject('current/a.txt', enc('架空')), {key: 'current/a.txt', size: 6});
  assert.equal(await ports.addBusinessObject('current/a.txt', enc('上書き')), null, '同じキーは置かない');
  assert.equal(new TextDecoder().decode(await (await ports.readBusinessObject('current/a.txt')).arrayBuffer()), '架空');
  // src の中で束ね BUSINESS_DATA に触れるのは Worker の入口だけで、そこでは businessDataPorts へ渡すだけ
  const files = readdirSync(new URL('../src/', import.meta.url), {recursive: true}).map((f) => String(f).replaceAll('\\', '/')).filter((f) => f.endsWith('.mjs'));
  const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  assert.deepEqual(files.filter((f) => /env\.BUSINESS_DATA/.test(read(f))), ['cloud-worker.mjs']);
  assert.deepEqual(read('cloud-worker.mjs').match(/env\.BUSINESS_DATA.?/g), ['env.BUSINESS_DATA)']);
  // 口を作る1か所は、バケットの get と条件付きの put しか呼ばない
  const ports0 = read('source-documents/business-data-bucket.mjs');
  assert.equal((ports0.match(/bucket\.\w+\(/g) || []).join(' '), 'bucket.get( bucket.put(');
  assert.ok(ports0.includes("bucket.put(key, body, {onlyIf: new Headers({'If-None-Match': '*'})"));
});

test('FR-CORE-DATA-065 足すだけ: 置けたら原本の行ができて開ける。同じ名前・同じ中身の2回目は 409 で何も書かない。権限と置く先を守る', async (t) => {
  const db = await openTestDb({t});
  const seed = enc('架空の先に置いてある書類');
  await registerSourceDocument(db, {orgId: 1, userId: 1, kind: 'other', fileName: '架空の既存.pdf', receivedOn: '2026-11-01',
    external: {location: `${FOLDER}/架空の既存.pdf`, byteLength: seed.length, sha256: await sha256Hex(seed)}});
  const bucket = fakeBucket();
  const app = createApp({db, mode: 'local', ...businessDataPorts(bucket)});
  const admin = await login(app, 'admin@openingnight.invalid');
  const post = async (cookie, {folder = FOLDER, name, body, sha256, type = 'application/octet-stream', target = app, extra = ''}) =>
    target.request(`/api/source-documents/upload?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}${extra}`, {method: 'POST', body, duplex: 'half',
      headers: {cookie, 'content-type': type, 'content-length': String(body.length), 'x-content-sha256': sha256 ?? await sha256Hex(body)}});
  const count = async () => Number((await db.get('SELECT COUNT(*) AS n FROM source_documents')).n);

  const photo = enc('架空の現場写真の中身');
  const before = await count();
  const created = await post(admin, {name: '架空の現場写真.jpg', body: photo, extra: '&kind=image&type=image%2Fjpeg'});
  assert.equal(created.status, 201, await created.clone().text());
  const made = await created.json();
  assert.equal(made.key, `${FOLDER}/架空の現場写真.jpg`);
  assert.equal(made.byteLength, photo.length);
  assert.deepEqual(bucket.objects.get(made.key), photo);
  const row = await db.get('SELECT kind, file_name, media_type, storage, external_location, byte_length, sha256, received_on FROM source_documents WHERE id=?', [made.id]);
  assert.deepEqual({...row, byte_length: Number(row.byte_length)}, {kind: 'image', file_name: '架空の現場写真.jpg', media_type: 'image/jpeg', storage: 'external',
    external_location: made.key, byte_length: photo.length, sha256: await sha256Hex(photo), received_on: todayJst()});
  const opened = await app.request(`/api/source-documents/${made.id}/content`, {headers: {cookie: admin}});
  assert.equal(opened.status, 200);
  assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), photo, '上げた原本をそのまま開ける');

  // 2回目: 同じ名前（中身は別）・同じ中身（名前は別）とも 409。置き場にも DB にも何も書かない
  const puts = bucket.puts.length, rows = await count();
  assert.equal(rows, before + 1);
  const sameName = await post(admin, {name: '架空の現場写真.jpg', body: enc('別の中身')});
  assert.equal(sameName.status, 409);
  assert.equal((await sameName.json()).details.id, made.id);
  assert.equal((await post(admin, {name: '架空の別名.jpg', body: photo})).status, 409);
  assert.equal(bucket.puts.length, puts, '置き場を呼ばない');
  // DB に記録が無くても、置き場に同じキーがあれば 409（上書きしない）
  bucket.objects.set(`${FOLDER}/架空の置き場だけ.pdf`, enc('置き場に先にある'));
  assert.equal((await post(admin, {name: '架空の置き場だけ.pdf', body: enc('後から来た中身')})).status, 409);
  assert.equal(new TextDecoder().decode(bucket.objects.get(`${FOLDER}/架空の置き場だけ.pdf`)), '置き場に先にある');
  assert.equal(await count(), rows);

  // 中身がハッシュと違えば置かない
  assert.equal((await post(admin, {name: '架空の化け.pdf', body: enc('途中で化けた'), sha256: 'b'.repeat(64)})).status, 400);
  assert.equal(bucket.objects.has(`${FOLDER}/架空の化け.pdf`), false);
  // 新しいフォルダは作らない。下に原本があるフォルダには置ける。JSON や大きすぎる本文は受けない
  assert.equal((await post(admin, {folder: 'current/ORG/架空の新しいフォルダ', name: 'a.pdf', body: enc('新しい')})).status, 400);
  assert.equal((await post(admin, {folder: 'current/ORG/F03_プリプロダクション', name: '架空の上の階.pdf', body: enc('上の階')})).status, 201);
  assert.equal((await post(admin, {name: 'a.pdf', body: enc('{}'), type: 'application/json'})).status, 415);
  const raw = (headers) => app.request(`/api/source-documents/upload?folder=${encodeURIComponent(FOLDER)}&name=x.pdf`, {method: 'POST', body: enc('x'), duplex: 'half',
    headers: {cookie: admin, 'content-type': 'application/octet-stream', 'content-length': '1', 'x-content-sha256': 'c'.repeat(64), ...headers}});
  assert.equal((await raw({'content-length': String(MAX_UPLOAD_BYTES + 1)})).status, 413);
  assert.equal((await raw({origin: 'https://example.invalid'})).status, 403, '別サイトからは受けない');

  // 権限: 制作担当は足せない。別組織は、自分の組織に原本が無いフォルダへ足せない
  const production = await login(app, 'production@openingnight.invalid');
  assert.equal((await post(production, {name: '架空の制作.pdf', body: enc('制作')})).status, 403);
  const outsider = await login(app, 'outsider@other.invalid');
  assert.notEqual((await post(outsider, {name: '架空の外.pdf', body: enc('外')})).status, 201);
  assert.equal(bucket.objects.has(`${FOLDER}/架空の外.pdf`), false);
  // 置き場につながっていなければ 501
  const unbound = createApp({db, mode: 'local'});
  assert.equal((await post(await login(unbound, 'admin@openingnight.invalid'), {name: '架空の未接続.pdf', body: enc('未接続'), target: unbound})).status, 501);
});
