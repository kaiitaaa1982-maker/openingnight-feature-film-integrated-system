// 画面から原本を足すときの決まり（画面とサーバーで同じに使う）と、手元の試作で使うフォルダの置き場。データは架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uploadFolders, defaultUploadFolder, uploadName, uploadKind, uploadRequestPath, uploadProblem, sha256HexOfBlob, MAX_UPLOAD_BYTES, UPLOAD_PATH} from '../src/source-documents/source-upload-model.mjs';
import {parseUpload} from '../src/source-documents/source-upload.mjs';
import {localBusinessDataPorts} from '../src/source-documents/business-data-local.mjs';
import {sha256Hex} from '../src/source-documents/source-documents-store.mjs';

const enc = (text) => new TextEncoder().encode(text);

test('置く先に選べるのは、原本が既にあるフォルダとその上の階だけ（current そのものと、current の外は出さない）', () => {
  const folders = uploadFolders([
    {location: 'current/ORG/F03_架空/F03-07_許可申請/架空の申請書.pdf'},
    {location: 'current/ORG/F03_架空/架空のメモ.txt'},
    {location: 'current/架空の直下.pdf'},
    {location: 'archive/ORG/古い.pdf'},
    {location: null}, {},
  ]);
  assert.deepEqual(folders, [
    {value: 'current/ORG', label: 'ORG'},
    {value: 'current/ORG/F03_架空', label: 'ORG/F03_架空'},
    {value: 'current/ORG/F03_架空/F03-07_許可申請', label: 'ORG/F03_架空/F03-07_許可申請'},
  ]);
  assert.deepEqual(uploadFolders(null), []);
  assert.equal(defaultUploadFolder(folders, 'current/ORG/F03_架空/架空のメモ.txt'), 'current/ORG/F03_架空', '開いている原本と同じフォルダ');
  assert.equal(defaultUploadFolder(folders, 'current/別/架空.pdf'), 'current/ORG', '無ければ先頭');
  assert.equal(defaultUploadFolder([], undefined), '');
});

test('スマホのカメラの決まった名前は日本時間の日時に替え、ほかの名前は NFC に寄せてそのまま使う', () => {
  const now = new Date('2026-11-09T15:04:05Z'); // 日本時間 2026-11-10 00:04:05
  assert.equal(uploadName('image.jpg', now), '20261110_000405.jpg');
  assert.equal(uploadName('IMAGE.JPG', now), '20261110_000405.jpg');
  assert.equal(uploadName('写真.heic', now), '20261110_000405.heic');
  assert.equal(uploadName('', now), '20261110_000405');
  assert.equal(uploadName('架空の申請書.pdf', now), '架空の申請書.pdf');
  assert.equal(uploadName('ガ.pdf', now), 'ガ.pdf');
  assert.equal(uploadName('IMG_0001.JPG', now), 'IMG_0001.JPG', '番号つきの名前は替えない');
  assert.equal(uploadKind('image/jpeg'), 'image');
  assert.equal(uploadKind('video/mp4'), 'media');
  assert.equal(uploadKind('audio/mpeg'), 'audio');
  assert.equal(uploadKind('application/pdf'), 'other');
  assert.equal(uploadKind(''), 'other');
});

test('FR-CORE-DATA-065 画面が作る道と名前は、サーバーの検査をそのまま通る', async () => {
  const folder = 'current/ORG/F03_架空/F03-07_許可申請';
  const name = uploadName('image.jpg', new Date('2026-11-09T15:04:05Z'));
  const path = uploadRequestPath({folder, name, kind: 'image', mediaType: 'image/jpeg'});
  assert.ok(path.startsWith('/source-documents/upload?'), '/api は画面の request が付ける');
  assert.equal(`/api${path.split('?')[0]}`, UPLOAD_PATH);
  const query = new URL(`http://x.invalid${path}`).searchParams;
  const parsed = parseUpload({folder: query.get('folder'), name: query.get('name'), kind: query.get('kind'), mediaType: query.get('type'),
    sha256: await sha256HexOfBlob(new Blob([enc('架空')])), contentLength: '6'});
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.key, `${folder}/20261110_000405.jpg`);
  assert.equal(parsed.kind, 'image');
  assert.equal(await sha256HexOfBlob(new Blob([enc('架空')])), await sha256Hex(enc('架空')));
  assert.equal(new URL(`http://x.invalid${uploadRequestPath({folder, name: 'a.pdf'})}`).searchParams.has('kind'), false);

  assert.equal(uploadProblem({folder, name: 'a.pdf', size: 1}), null);
  assert.equal(uploadProblem({folder: '', name: 'a.pdf', size: 1}), '置く先を選んでください');
  assert.equal(uploadProblem({folder, name: '', size: 1}), '名前を入れてください');
  assert.equal(uploadProblem({folder, name: 'a.pdf', size: 0}), '中身が空です');
  assert.equal(uploadProblem({folder, name: 'a.pdf', size: MAX_UPLOAD_BYTES}), null);
  assert.match(uploadProblem({folder, name: 'a.pdf', size: MAX_UPLOAD_BYTES + 1}), /95MB/);
});

test('手元のフォルダの置き場: 口は Worker と同じ2つ。無ければ置き、あれば置かず、中身が違えば置かない。仮のファイルを残さない', async (t) => {
  assert.deepEqual(localBusinessDataPorts(undefined), {readBusinessObject: null, addBusinessObject: null});
  const dir = mkdtempSync(join(tmpdir(), 'on-bd-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const ports = localBusinessDataPorts(dir);
  assert.deepEqual(Object.keys(ports).sort(), ['addBusinessObject', 'readBusinessObject']);
  const key = 'current/ORG/架空/架空の現場写真.jpg';
  const body = enc('架空の現場写真の中身');
  const stream = (bytes) => new Blob([bytes]).stream();
  assert.equal(await ports.readBusinessObject(key), null);
  assert.deepEqual(await ports.addBusinessObject(key, stream(body), {sha256: await sha256Hex(body)}), {key, size: body.length});
  assert.deepEqual(new Uint8Array(await (await ports.readBusinessObject(key)).arrayBuffer()), body);
  assert.equal(await ports.addBusinessObject(key, stream(enc('上書き')), {}), null, '同じキーは置かない');
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'current', 'ORG', '架空', '架空の現場写真.jpg'))), body, '先の中身のまま');
  await assert.rejects(ports.addBusinessObject('current/ORG/架空/架空の化け.pdf', stream(enc('化けた')), {sha256: 'b'.repeat(64)}), /sha256/);
  assert.deepEqual(readdirSync(join(dir, 'current', 'ORG', '架空')), ['架空の現場写真.jpg'], '置かなかった中身も仮のファイルも残さない');
  // 先に置いてあるファイル（ドライブから来たもの）は読める。置き場の外・current の外のキーは受けない
  mkdirSync(join(dir, 'current', 'ORG', '先'), {recursive: true});
  writeFileSync(join(dir, 'current', 'ORG', '先', '架空の既存.txt'), '先にある');
  assert.equal(new TextDecoder().decode(await (await ports.readBusinessObject('current/ORG/先/架空の既存.txt')).arrayBuffer()), '先にある');
  for (const bad of ['current/../外.txt', '../外.txt', 'archive/x.txt', '/current/x.txt'])
    await assert.rejects(ports.addBusinessObject(bad, stream(enc('外')), {}), undefined, bad);
  // 口を作る1か所は、消す・書き換える呼び出しを持たない（仮のファイルの unlink だけ）
  const source = readFileSync(new URL('../src/source-documents/business-data-local.mjs', import.meta.url), 'utf8');
  assert.equal(/\b(?:writeFile|rename|rm|rmdir|copyFile|truncate)\(/.test(source), false);
  assert.equal(source.match(/unlink\(/g).length, 1);
});
