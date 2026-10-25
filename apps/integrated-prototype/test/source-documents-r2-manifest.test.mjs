// FR-CORE-DATA-061。目録はすべて架空。ON_TEST_DB=pg でも同じ受け口と保存結果を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {R2LargeValueDatabase} from '../src/cloud-r2-db.mjs';
import {D1_MAX_STATEMENTS} from '../src/d1-limits.mjs';
import {MAX_R2_MANIFEST_ROWS} from '../src/source-documents/r2-manifest-routes.mjs';
import {parseManifest, kindForKey, fileNameForKey, receivedOnForUpload} from '../src/source-documents/r2-manifest.mjs';
import {SOURCE_DOCUMENT_KINDS, listSourceDocuments, registerSourceDocument} from '../src/source-documents/source-documents-store.mjs';

const SHA = 'a'.repeat(64);
const AT = '2026-10-24T15:00:00.0000000Z';
const HEADER = 'key\tsize\tsha256\tuploaded_at';
const line = (key = 'current/contracts/架空契約.pdf', size = 123, sha = SHA, at = AT) => [key, size, sha, at].join('\t');
const payload = (manifest, dryRun = true) => ({manifest, dryRun});
const PATH = '/api/source-documents/import-r2-manifest';

test('FR-CORE-DATA-061 見出しの有無・BOM・CRLFにかかわらず目録を読み、列の順と値を保つ', () => {
  for (const text of [line(), `${HEADER}\n${line()}\n`, `\uFEFF${HEADER}\r\n${line()}\r\n`, `\uFEFF${line()}`]) {
    const rows = parseManifest(text);
    assert.deepEqual(rows, [{key: 'current/contracts/架空契約.pdf', byteLength: 123, sha256: SHA, uploadedAt: AT}]);
    assert.deepEqual(rows.rejected, []);
  }
  assert.deepEqual(parseManifest(''), []);
  assert.deepEqual(parseManifest(`${HEADER}\n`), []);
});

test('FR-CORE-DATA-061 不正な列・ハッシュ・大きさ・キー・名前・日時は元の行番号と理由を返す', () => {
  const invalid = [
    ['a\tb\tc', /4列/], [line() + '\textra', /4列/],
    [line(undefined, 1, 'A'.repeat(64)), /SHA-256/], [line(undefined, 1, 'g'.repeat(64)), /SHA-256/],
    [line(undefined, 1, 'a'.repeat(63)), /SHA-256/],
    ...['0', '-1', '1.5', '1e3', ' 1', 'NaN', '9007199254740992', ''].map((size) => [line(undefined, size), /正の安全な整数/]),
    [line('trash/contracts/a.pdf'), /current\//], [line('current/'), /ファイル名/],
    [line(`current/${'a'.repeat(241)}`), /240/],
    [line(`current/${'d'.repeat(254)}/${'e'.repeat(240)}`), /500/],
    [line(undefined, 1, SHA, ''), /日時/], [line(undefined, 1, SHA, '2026-02-30T00:00:00Z'), /日時/],
    [line(undefined, 1, SHA, '2026-10-24T00:00:00'), /日時/],
    [line(undefined, 1, SHA, '2026-10-24T24:00:00Z'), /日時/], ['', /4列/],
  ];
  const rows = parseManifest([HEADER, ...invalid.map(([value]) => value), line()].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(rows.rejected.length, invalid.length);
  invalid.forEach(([, reason], i) => {
    assert.equal(rows.rejected[i].line, i + 2);
    assert.match(rows.rejected[i].reason, reason);
  });
  const firstBad = parseManifest(`key\tbroken\theader\there\n${line()}`);
  assert.equal(firstBad.rejected[0].line, 1, '見出しに似た不正行も黙って捨てない');
});

test('FR-CORE-DATA-061 名前は3つの符号だけを一度戻し、240字と241字を区別する', () => {
  assert.equal(fileNameForKey('current/materials/架空%23試作%3F100%25.pdf'), '架空#試作?100%.pdf');
  assert.equal(fileNameForKey('current/materials/%2523%253F%2525%2F%20.txt'), '%23%3F%25%2F%20.txt');
  assert.equal(fileNameForKey('current/materials/100%完成%3f.txt'), '100%完成?.txt');
  assert.equal(fileNameForKey(`current/${'あ'.repeat(240)}`), 'あ'.repeat(240));
  assert.throws(() => fileNameForKey(`current/${'あ'.repeat(241)}`), /240/);
  assert.throws(() => fileNameForKey('current/materials/'), /ファイル名/);
  assert.equal(parseManifest(line(`current/${'a'.repeat(251)}/${'b'.repeat(240)}`, Number.MAX_SAFE_INTEGER)).length, 1);
});

test('FR-CORE-DATA-061 種類はフォルダと拡張子の対応表で決め、支払資料を口座明細にしない', () => {
  const cases = [
    ['contracts/架空.pdf', 'contract'], ['invoices_in/架空.xlsx', 'invoice'],
    ['payments/銀行明細.pdf', 'other'], ['payments/materials/a.mp4', 'other'],
    ...['mp4', 'mov', 'mxf', 'avi', 'mkv', 'webm', 'm4v', 'mpg', 'mpeg'].map((ext) => [`materials/a.${ext}`, 'media']),
    ...['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'heic'].map((ext) => [`materials/a.${ext}`, 'image']),
    ...['wav', 'mp3', 'aac', 'm4a', 'flac', 'aif', 'aiff', 'ogg'].map((ext) => [`materials/a.${ext}`, 'audio']),
    ['materials/予告.MOV', 'media'], ['materials/仕様.pdf', 'other'],
    ['production/架空予算表.xlsx', 'budget'], ['production/budget_v1.csv', 'budget'],
    ['production/schedule.xlsx', 'other'], ['production/予算説明.mp4', 'other'],
    ['unknown/budget.xlsx', 'other'], ['notcontracts/a.pdf', 'other'], ['contracts.pdf', 'other'],
  ];
  for (const [path, expected] of cases) {
    const got = kindForKey(`current/架空案件/${path}`);
    assert.equal(got, expected, path);
    assert.equal(SOURCE_DOCUMENT_KINDS.includes(got), true);
  }
});

test('FR-CORE-DATA-061 受領日は上げた日時のJSTで日付・年・うるう日を正しく扱う', () => {
  assert.equal(receivedOnForUpload('2026-10-24T14:59:59Z'), '2026-10-24');
  assert.equal(receivedOnForUpload(AT), '2026-10-25');
  assert.equal(receivedOnForUpload('2026-12-31T15:00:00Z'), '2027-01-01');
  assert.equal(receivedOnForUpload('2028-02-29T00:00:00+09:00'), '2028-02-29');
  assert.equal(receivedOnForUpload('2026-10-24T23:30:00-07:00'), '2026-10-25');
  assert.throws(() => receivedOnForUpload('2026-02-29T00:00:00Z'), /日時/);
  assert.throws(() => receivedOnForUpload('9999-12-31T15:00:00Z'), /日時/);
});

async function fixture(t) {
  const raw = await openTestDb({t});
  const counter = {n: 0, sourceReads: 0};
  const counted = new Proxy(raw, {get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (['all', 'get', 'run', 'batch', 'readBatch'].includes(prop)) return (...args) => {
      const statements = ['batch', 'readBatch'].includes(prop) ? args[0] : [{sql: args[0], params: args[1]}];
      counter.n += statements.length;
      for (const {sql, params = []} of statements) {
        assert.ok(params.length <= 100, 'D1 の1文の値は100個以内');
        if (/^SELECT\b/i.test(sql.trim()) && /FROM source_documents\b/i.test(sql)) counter.sourceReads += 1;
      }
      return value.apply(target, args);
    };
    return value.bind(target);
  }});
  const noR2 = () => { throw new Error('目録の取り込みでは R2 に接続しない'); };
  const db = new R2LargeValueDatabase(counted, {head: noR2, get: noR2, put: noR2});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const res = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie').split(';')[0];
  };
  const call = async (input, cookie = '', extraHeaders = {}) => {
    const res = await app.request(PATH, {method: 'POST', headers: {'content-type': 'application/json', cookie, ...extraHeaders}, body: JSON.stringify(input)});
    return {status: res.status, body: await res.json()};
  };
  return {db, app, login, call, counter};
}

test('FR-CORE-DATA-061 保存名の予約形式と制御文字を行番号つきで断り、残りの有効行を取り込む', async (t) => {
  const {db, login, call} = await fixture(t);
  const cookie = await login('admin@openingnight.invalid');
  const invalid = ['@r2:v1:foo.pdf', ' @r2:v1:foo.pdf', '\u0000先頭.pdf', '中\u0001間.pdf', '末尾.pdf\u007f', '制御\u0085文字.pdf'];
  const manifest = [HEADER, ...invalid.map((name) => line(`current/contracts/${name}`)), line()].join('\n');
  const parsed = parseManifest(manifest);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed.rejected.map((r) => r.line), [2, 3, 4, 5, 6, 7]);
  parsed.rejected.forEach((r) => assert.match(r.reason, /予約|制御文字/));
  const dry = await call(payload(manifest), cookie);
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.counts, {new: 1, duplicate: 0, moved: 0, rejected: 6});
  assert.deepEqual(await listSourceDocuments(db, 1), []);
  assert.deepEqual(await call(payload(manifest, false), cookie), dry);
  assert.equal((await listSourceDocuments(db, 1)).length, 1);
  for (const fileName of invalid) {
    await assert.rejects(registerSourceDocument(db, {orgId: 1, userId: 1, kind: 'other', fileName,
      receivedOn: '2026-10-25', external: {location: 'current/架空.pdf', byteLength: 1, sha256: SHA}}),
    (error) => error.name === 'SourceDocumentError' && /予約|制御文字/.test(error.message));
  }
});

const manyLines = (count) => Array.from({length: count}, (_, i) => line(`current/contracts/架空${i}.pdf`, 123, i.toString(16).padStart(64, '0')));

test('FR-CORE-DATA-061 有効行200件ちょうどの事前確認と本取り込みは一括照会でD1の問い合わせ上限内に収まる', async (t) => {
  const {db, login, call, counter} = await fixture(t);
  const cookie = await login('admin@openingnight.invalid');
  assert.equal(MAX_R2_MANIFEST_ROWS, 200);
  const manifest = [HEADER, ...manyLines(MAX_R2_MANIFEST_ROWS), line('trash/不正.pdf')].join('\n');
  for (const dryRun of [true, false]) {
    counter.n = 0; counter.sourceReads = 0;
    const res = await call(payload(manifest, dryRun), cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.counts, {new: 200, duplicate: 0, moved: 0, rejected: 1});
    assert.ok(counter.n <= D1_MAX_STATEMENTS, `問い合わせ数 ${counter.n} は${D1_MAX_STATEMENTS}以内`);
    assert.ok(counter.sourceReads <= 3, `重複照会 ${counter.sourceReads} は3回以内`);
    t.diagnostic(`${dryRun ? 'dryRun' : '本取り込み'}: 問い合わせ${counter.n}回（重複照会${counter.sourceReads}回）`);
    assert.equal((await listSourceDocuments(db, 1)).length, dryRun ? 0 : 200);
  }
  counter.sourceReads = 0;
  const replay = await call(payload(manifest, false), cookie);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.counts, {new: 0, duplicate: 200, moved: 0, rejected: 1});
  assert.ok(counter.sourceReads <= 3, '2つ目以降の区切りも一括照会で重複を検出する');
  assert.equal((await listSourceDocuments(db, 1)).length, 200);
});

test('FR-CORE-DATA-061 有効行201件は事前確認も本取り込みも413で分割件数を返し、1行も保存しない', async (t) => {
  const {db, login, call, counter} = await fixture(t);
  const cookie = await login('admin@openingnight.invalid');
  for (const dryRun of [true, false]) {
    counter.sourceReads = 0;
    const res = await call(payload([HEADER, ...manyLines(201)].join('\n'), dryRun), cookie);
    assert.equal(res.status, 413);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /200.*分け/);
    assert.equal(res.body.details.maxRows, 200);
    assert.equal(counter.sourceReads, 0);
    assert.deepEqual(await listSourceDocuments(db, 1), []);
  }
});

test('FR-CORE-DATA-061 dryRunは書き込まず同じ組織と目録内の重複を数え、本取り込みと再送でも一致する', async (t) => {
  const {db, login, call} = await fixture(t);
  const cookie = await login('admin@openingnight.invalid');
  const base = {orgId: 1, userId: 1, kind: 'other', fileName: '既存.pdf', receivedOn: '2026-10-01'};
  await registerSourceDocument(db, {...base, external: {location: 'current/既存.pdf', byteLength: 1, sha256: SHA}});
  await registerSourceDocument(db, {...base, orgId: 2, userId: 4, external: {location: 'current/別組織.pdf', byteLength: 1, sha256: 'b'.repeat(64)}});
  const manifest = [HEADER, line(), line('current/materials/架空%23予告.MOV', 80_000_000_000, 'b'.repeat(64)),
    line('current/materials/同じ中身.mov', 80_000_000_000, 'b'.repeat(64)), line('trash/断る.pdf'),
    line('current/invoices_in/架空.pdf', 222, 'c'.repeat(64)), line(`current/${'x'.repeat(241)}`),
    line(undefined, 1, SHA, '不明')].join('\n');
  const before = await db.all('SELECT * FROM source_documents ORDER BY id');
  const dry = await call(payload(manifest), cookie);
  assert.equal(dry.status, 200);
  assert.equal(dry.body.ok, true);
  assert.deepEqual(dry.body.counts, {new: 2, duplicate: 1, moved: 1, rejected: 3});
  assert.deepEqual(dry.body.rejected.map((r) => r.line), [5, 7, 8]);
  assert.deepEqual(await db.all('SELECT * FROM source_documents ORDER BY id'), before);
  // 本文の組織・利用者を偽っても認証済みの組織・利用者だけで登録する。
  const actual = await call({...payload(manifest, false), orgId: 2, receivedBy: 4, userId: 4}, cookie);
  assert.deepEqual(actual, dry);
  const docs = await listSourceDocuments(db, 1);
  assert.equal(docs.length, 3);
  assert.deepEqual(docs.slice(1).map((d) => [d.kind, d.file_name, d.byte_length, d.sha256, d.storage, d.received_on, d.received_by]), [
    ['media', '架空#予告.MOV', 80_000_000_000, 'b'.repeat(64), 'external', '2026-10-25', 1],
    ['invoice', '架空.pdf', 222, 'c'.repeat(64), 'external', '2026-10-25', 1],
  ]);
  assert.equal(docs[1].external_location, 'current/materials/架空%23予告.MOV');
  assert.deepEqual((await db.all('SELECT content_base64 FROM source_documents')).map((r) => r.content_base64), [null, null, null, null]);
  assert.equal((await listSourceDocuments(db, 2)).length, 1);
  const replay = await call(payload(manifest, false), cookie);
  assert.deepEqual(replay.body.counts, {new: 0, duplicate: 4, moved: 0, rejected: 3});
  assert.deepEqual((await call(payload(manifest), cookie)).body, replay.body);
});

test('FR-CORE-DATA-061 未認証・管理者以外・組織の食い違いは事前確認も取り込みも拒む', async (t) => {
  const {db, login, call} = await fixture(t);
  const editor = await login('editor@openingnight.invalid');
  const production = await login('production@openingnight.invalid');
  const admin = await login('admin@openingnight.invalid');
  for (const dryRun of [true, false]) {
    assert.equal((await call(payload(line(), dryRun))).status, 401);
    for (const cookie of [editor, production]) {
      const denied = await call(payload(line(), dryRun), cookie);
      assert.equal(denied.status, 403);
      assert.match(denied.body.error, /管理者/);
    }
    assert.equal((await call(payload(line(), dryRun), admin, {'X-On-Org': '2'})).status, 409);
  }
  assert.deepEqual(await listSourceDocuments(db, 1), []);
  assert.deepEqual(await listSourceDocuments(db, 2), []);
});

test('FR-CORE-DATA-061 TSV文字列と真偽のdryRunを必須とし、不正な本文では保存しない', async (t) => {
  const {db, app, login, call} = await fixture(t);
  const cookie = await login('admin@openingnight.invalid');
  for (const input of [null, [], {}, {manifest: 123, dryRun: true}, {manifest: line()}, {manifest: line(), dryRun: 'false'}, {manifest: line(), dryRun: 0}]) {
    const res = await call(input, cookie);
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
  }
  const broken = await app.request(PATH, {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: '{'});
  assert.equal(broken.status, 400);
  assert.deepEqual((await call(payload(''), cookie)).body, {ok: true, counts: {new: 0, duplicate: 0, moved: 0, rejected: 0}, rejected: []});
  assert.deepEqual(await listSourceDocuments(db, 1), []);
});
