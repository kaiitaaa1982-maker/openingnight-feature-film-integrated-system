// 制作部の業務のひな型（移行 0057。要件 docs/requirements/production/work-templates.md）。架空の型・架空のファイルだけ。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
import {openTestDb} from './test-db.mjs';
import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';
import {blocksToText, missingRequired, normalizeBlocks, normalizeDriveRef, normalizeVariables, normalizeVersionInput, officeFileInfo, resolveBlocks, looksLikeZip} from '../src/production/work-templates/work-templates-model.mjs';

const VARIABLES = [
  {key: 'place', label: '宿の名前', kind: 'text', required: true},
  {key: 'nights', label: '泊数', kind: 'number'},
  {key: 'parking', label: '駐車場', kind: 'choice', options: ['あり', 'なし']},
];
const BLOCKS = [
  {kind: 'heading', text: '宿の連絡'},
  {kind: 'text', text: '{{place}} に {{nights}} 泊します。'},
  {kind: 'checklist', title: '確認', items: [{text: '予約番号を控える'}, {text: '駐車場の台数を伝える', when: {key: 'parking', op: 'equals', value: 'あり'}}]},
  {kind: 'fields', rows: [{label: '宿', value: '{{place}}'}, {label: '延泊', value: '要相談', when: {key: 'nights', op: 'filled'}}]},
  {kind: 'table', columns: ['日', '部屋'], rows: [{cells: ['1日目', '{{place}} 101']}]},
];
const version = (extra = {}) => ({name: '架空の宿の連絡', purpose: '宿の予約を知らせる', scene: '遠方ロケの前', variables: VARIABLES, blocks: BLOCKS, source: {kind: 'verbal', note: '架空の口頭の取り決め'}, ...extra});
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('架空のOfficeの中身 v1')]);
const b64 = (buf) => Buffer.from(buf).toString('base64');

async function login(app, email) { const r = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})}); assert.equal(r.status, 200); return r.headers.get('set-cookie').split(';')[0]; }
async function call(app, cookie, method, path, body) { const r = await app.request(path, {method, headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, data: await r.json()}; }
async function fixture(t) {
  const db = await openTestDb({t}), app = createApp({db});
  return {db, app, user: await login(app, 'production@openingnight.invalid'), admin: await login(app, 'admin@openingnight.invalid'), outsider: await login(app, 'outsider@other.invalid')};
}

test('FR-PROD-TMPL-002 部品は5種類・穴は本文の {{キー}}・条件つきの行を持ち、定義していない穴・知らない種類・長すぎる中身は断る', () => {
  const variables = normalizeVariables(VARIABLES);
  assert.equal(normalizeBlocks(BLOCKS, variables).length, 5);
  assert.throws(() => normalizeBlocks([{kind: 'text', text: '{{nothing}}'}], variables), /定義していない穴/);
  assert.throws(() => normalizeBlocks([{kind: 'video', text: 'x'}], variables), /種類/);
  assert.throws(() => normalizeBlocks([{kind: 'text', text: 'a', when: {key: 'zzz', op: 'filled'}}], variables), /条件/);
  assert.throws(() => normalizeBlocks([{kind: 'table', columns: ['a', 'b'], rows: [{cells: ['1']}]}], variables), /セルの数/);
  assert.throws(() => normalizeVariables([{key: 'A b', label: 'x'}]), /キー/);
  assert.throws(() => normalizeVariables([{key: 'a', label: 'x'}, {key: 'a', label: 'y'}]), /重なって/);
  assert.throws(() => normalizeVariables([{key: 'c', label: 'x', kind: 'choice'}]), /選択肢/);
  assert.throws(() => normalizeBlocks([{kind: 'text', text: 'あ'.repeat(5001)}], variables), /5000字/);
  assert.equal(normalizeVersionInput({name: '素'}, {first: true}).source.kind, 'unverified', '出どころが分からないときは unverified');
});

test('FR-PROD-TMPL-004 穴を埋める: 条件に合う行だけ残り、未入力は【名前】のまま、必須の穴の不足を数える', () => {
  const variables = normalizeVariables(VARIABLES), blocks = normalizeBlocks(BLOCKS, variables);
  const empty = resolveBlocks(blocks, {}, variables);
  assert.equal(empty[1].text, '【宿の名前】 に 【泊数】 泊します。');
  assert.equal(empty[2].items.length, 1, '駐車場が「あり」でなければ台数の項目は出ない');
  assert.equal(empty[3].rows.length, 1, '泊数が入っていなければ延泊の行は出ない');
  assert.deepEqual(missingRequired(variables, {}).map((v) => v.key), ['place']);
  const values = {place: '架空旅館', nights: '2', parking: 'あり'};
  const full = resolveBlocks(blocks, values, variables);
  assert.equal(full[1].text, '架空旅館 に 2 泊します。');
  assert.equal(full[2].items.length, 2);
  assert.equal(full[3].rows.length, 2);
  assert.deepEqual(missingRequired(variables, values), []);
  assert.match(blocksToText(full), /^■ 宿の連絡\n\n架空旅館 に 2 泊します。\n\n■ 確認\n□ 予約番号を控える\n□ 駐車場の台数を伝える/);
});

test('FR-PROD-TMPL-008 Google ドライブの出どころは任意で、ファイル ID か drive・docs のリンクだけ。ほかは断る', () => {
  assert.equal(normalizeDriveRef(undefined), null);
  assert.equal(normalizeDriveRef('  '), null);
  assert.equal(normalizeDriveRef('1AbCdEfGhIjKlMnOpQrStUv_-'), '1AbCdEfGhIjKlMnOpQrStUv_-');
  assert.equal(normalizeDriveRef('https://docs.google.com/document/d/FICTIONALID0123456789/edit'), 'https://docs.google.com/document/d/FICTIONALID0123456789/edit');
  for (const bad of ['short', 'http://drive.google.com/file/d/x', 'https://example.com/a', 'a b c d e f g h i j k']) assert.throws(() => normalizeDriveRef(bad), /ドライブ/);
});

test('FR-PROD-TMPL-006 置ける原本は docx・xlsx・pptx だけで、中身は ZIP の印を持つもの', () => {
  assert.equal(officeFileInfo('架空.DOCX').ext, 'docx');
  assert.equal(officeFileInfo('架空.xlsx').ext, 'xlsx');
  assert.equal(officeFileInfo('架空.pptx').ext, 'pptx');
  for (const name of ['架空.pdf', '架空.doc', '架空', '架空.exe']) assert.throws(() => officeFileInfo(name), /置けるのは/);
  assert.equal(looksLikeZip(new Uint8Array(ZIP)), true);
  assert.equal(looksLikeZip(new Uint8Array([1, 2, 3, 4, 5])), false);
});

test('FR-PROD-TMPL-001 FR-PROD-TMPL-003 FR-PROD-TMPL-007 フォルダを作る→ひな型を作る→版を足す（理由必須・古い画面は 409・やめる版）→一覧と検索', async (t) => {
  const {app, user, outsider} = await fixture(t);
  assert.deepEqual((await call(app, user, 'GET', '/api/work-templates/folders')).data.folders, [], '初期のフォルダは無い');
  const f1 = await call(app, user, 'POST', '/api/work-templates/folders', {name: '宿・移動の連絡', description: '架空の業務の種類'});
  assert.equal(f1.status, 200);
  assert.equal((await call(app, user, 'POST', '/api/work-templates/folders', {name: '宿・移動の連絡'})).status, 409, '同じ名前は断る');
  assert.equal((await call(app, user, 'POST', '/api/work-templates/folders', {name: '  '})).status, 400);
  const f2 = await call(app, user, 'POST', '/api/work-templates/folders', {name: 'ロケハンの持ち物'});

  const created = await call(app, user, 'POST', `/api/work-templates/folders/${f1.data.id}/templates`, version());
  assert.equal(created.status, 200);
  const tid = created.data.id;
  assert.equal((await call(app, user, 'POST', `/api/work-templates/folders/${f1.data.id}/templates`, version({blocks: [{kind: 'text', text: '{{x}}'}]}))).status, 400);

  const folders = (await call(app, user, 'GET', '/api/work-templates/folders')).data.folders;
  assert.deepEqual(folders.map((f) => [f.name, f.template_count]), [['宿・移動の連絡', 1], ['ロケハンの持ち物', 0]]);

  // 版
  const noReason = await call(app, user, 'POST', `/api/work-templates/templates/${tid}/versions`, {...version({name: '宿の連絡 改'}), expectedVersion: 1});
  assert.equal(noReason.status, 400, '2版目からは理由が要る');
  const v2 = await call(app, user, 'POST', `/api/work-templates/templates/${tid}/versions`, {...version({name: '宿の連絡 改'}), expectedVersion: 1, reason: '泊数の穴を足した'});
  assert.equal(v2.status, 200);
  assert.equal((await call(app, user, 'POST', `/api/work-templates/templates/${tid}/versions`, {...version(), expectedVersion: 1, reason: '古い画面から'})).status, 409, '古い画面からの直しは 409');
  const detail = (await call(app, user, 'GET', `/api/work-templates/templates/${tid}`)).data;
  assert.deepEqual(detail.versions.map((v) => [v.version_no, v.name, v.reason]), [[2, '宿の連絡 改', '泊数の穴を足した'], [1, '架空の宿の連絡', null]], '古い版も残る');
  assert.equal(detail.versions[1].blocks.length, 5);
  assert.deepEqual(detail.versions[1].source, {kind: 'verbal', note: '架空の口頭の取り決め'});

  const list = (await call(app, user, 'GET', `/api/work-templates/folders/${f1.data.id}/templates`)).data;
  assert.deepEqual(list.templates.map((x) => [x.name, x.version_no, x.file_count]), [['宿の連絡 改', 2, 0]]);
  // やめる版: 一覧から消え、?retired=1 で見える。戻す版も足せる
  assert.equal((await call(app, user, 'POST', `/api/work-templates/templates/${tid}/versions`, {...version({name: '宿の連絡 改', retired: true}), expectedVersion: 2, reason: '使わなくなった'})).status, 200);
  assert.equal((await call(app, user, 'GET', `/api/work-templates/folders/${f1.data.id}/templates`)).data.templates.length, 0);
  assert.equal((await call(app, user, 'GET', `/api/work-templates/folders/${f1.data.id}/templates?retired=1`)).data.templates[0].retired, true);
  assert.equal((await call(app, user, 'POST', `/api/work-templates/templates/${tid}/versions`, {...version({name: '宿の連絡 改'}), expectedVersion: 3, reason: '復活'})).status, 200);

  // 検索（名前・使う場面・フォルダ名。% は検索する文字）
  const q = async (word) => (await call(app, user, 'GET', `/api/work-templates/search?q=${encodeURIComponent(word)}`)).data.templates.map((x) => x.id);
  assert.deepEqual(await q('宿の連絡'), [tid]);
  assert.deepEqual(await q('遠方ロケ'), [tid]);
  assert.deepEqual(await q('移動の連'), [tid], 'フォルダの名前でも探せる');
  assert.deepEqual(await q('%'), []);
  assert.deepEqual(await q('存在しない'), []);
  assert.equal((await call(app, user, 'GET', '/api/work-templates/search?q=')).status, 400);
  assert.equal(f2.status, 200);

  // 別の組織からは見えない
  assert.deepEqual((await call(app, outsider, 'GET', '/api/work-templates/folders')).data.folders, []);
  assert.equal((await call(app, outsider, 'GET', `/api/work-templates/templates/${tid}`)).status, 404);
  assert.equal((await call(app, outsider, 'POST', `/api/work-templates/templates/${tid}/versions`, {...version(), expectedVersion: 4, reason: 'x'})).status, 404);
  assert.deepEqual(await (async () => (await call(app, outsider, 'GET', `/api/work-templates/search?q=${encodeURIComponent('宿')}`)).data.templates)(), []);
});

test('FR-PROD-TMPL-005 複製は別のフォルダへも作れ、複製元（ひな型と版）を残し、最新の原本を同じ原本のまま引き継ぐ', async (t) => {
  const {app, user, db} = await fixture(t);
  const a = (await call(app, user, 'POST', '/api/work-templates/folders', {name: '種類A'})).data.id;
  const b = (await call(app, user, 'POST', '/api/work-templates/folders', {name: '種類B'})).data.id;
  const tid = (await call(app, user, 'POST', `/api/work-templates/folders/${a}/templates`, version())).data.id;
  await call(app, user, 'POST', `/api/work-templates/templates/${tid}/files`, {fileName: '架空.docx', base64: b64(ZIP)});
  const copy = await call(app, user, 'POST', `/api/work-templates/templates/${tid}/copy`, {folderId: b, name: '宿の連絡（別作品用）'});
  assert.equal(copy.status, 200);
  const detail = (await call(app, user, 'GET', `/api/work-templates/templates/${copy.data.id}`)).data;
  assert.equal(detail.template.folder_id, b);
  assert.equal(detail.template.name, '宿の連絡（別作品用）');
  assert.deepEqual([detail.template.copied_from_template_id, detail.template.copied_from_version_no], [tid, 1]);
  assert.equal(detail.versions[0].blocks.length, 5);
  assert.equal(detail.files.length, 1);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM source_documents')).n, 1, '原本は増えない');
  const same = await call(app, user, 'POST', `/api/work-templates/templates/${tid}/copy`, {});
  assert.equal((await call(app, user, 'GET', `/api/work-templates/templates/${same.data.id}`)).data.template.name, '架空の宿の連絡（複製）');
  assert.equal((await call(app, user, 'POST', `/api/work-templates/templates/${tid}/copy`, {folderId: 9999})).status, 404);
});

test('FR-PROD-TMPL-006 FR-PROD-TMPL-007 FR-PROD-TMPL-008 Office の原本: 置く→置き直すと版が増え古い版も残る→ダウンロード・検索。種類・大きさ・中身・理由を確かめる', async (t) => {
  const {app, user, outsider} = await fixture(t);
  const folder = (await call(app, user, 'POST', '/api/work-templates/folders', {name: '書類'})).data.id;
  const tid = (await call(app, user, 'POST', `/api/work-templates/folders/${folder}/templates`, {name: '架空の見積書の型', source: {kind: 'sheet'}})).data.id;
  const put = (body) => call(app, user, 'POST', `/api/work-templates/templates/${tid}/files`, body);

  assert.equal((await put({fileName: '架空.pdf', base64: b64(ZIP)})).status, 400, 'pdf は断る');
  assert.equal((await put({fileName: '架空.docx', base64: b64('PK でない中身')})).status, 400, '拡張子だけ変えた別のファイルは断る');
  assert.equal((await put({fileName: '架空.docx', base64: ''})).status, 400);
  assert.equal((await put({fileName: '架空.docx', base64: b64(ZIP), driveRef: 'https://example.com/x'})).status, 400, 'ドライブ以外のリンクは断る');
  const big = Buffer.concat([ZIP, Buffer.alloc(12 * 1024 * 1024)]);
  assert.equal((await put({fileName: '架空.xlsx', base64: b64(big)})).status, 400, '12MB を超えると断る');

  const driveRef = 'https://drive.google.com/file/d/FICTIONALID0123456789/view';
  const first = await put({fileName: '架空の見積書.xlsx', base64: b64(ZIP), driveRef});
  assert.deepEqual([first.status, first.data.fileNo], [200, 1]);
  const v2Bytes = Buffer.concat([ZIP, Buffer.from(' v2')]);
  assert.equal((await put({fileName: '架空の見積書.xlsx', base64: b64(v2Bytes), expectedFileNo: 1})).status, 400, '置き直すには理由が要る');
  assert.equal((await put({fileName: '架空の見積書.xlsx', base64: b64(v2Bytes), reason: '単価を直した'})).status, 409, '直前の番号が無いと 409');
  const second = await put({fileName: '架空の見積書.xlsx', base64: b64(v2Bytes), reason: '単価を直した', expectedFileNo: 1});
  assert.deepEqual([second.status, second.data.fileNo], [200, 2]);
  assert.equal((await put({fileName: '架空の見積書.xlsx', base64: b64(v2Bytes), reason: '同じ', expectedFileNo: 2})).status, 409, '直前と同じ中身は断る');
  assert.equal((await put({fileName: '架空の見積書.xlsx', base64: b64(ZIP), reason: '戻した', expectedFileNo: 2})).data.fileNo, 3, '前の版と同じ中身は、同じ原本を指す新しい番号になる');

  const detail = (await call(app, user, 'GET', `/api/work-templates/templates/${tid}`)).data;
  assert.deepEqual(detail.files.map((f) => [f.file_no, f.reason, f.drive_ref]), [[3, '戻した', null], [2, '単価を直した', null], [1, null, driveRef]], '古い原本も残る');
  assert.equal(detail.files[0].document_id, detail.files[2].document_id);
  assert.equal(detail.maxBytes, 12 * 1024 * 1024);
  assert.equal(detail.files[1].media_type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal((await call(app, user, 'GET', `/api/work-templates/folders/${folder}/templates`)).data.templates[0].file_count, 3);

  // ダウンロード（古い版も）。中身がそのまま戻る
  for (const [file, expected] of [[detail.files[1], v2Bytes], [detail.files[2], ZIP]]) {
    const res = await app.request(`/api/work-templates/files/${file.id}/download`, {headers: {cookie: user}});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), expected);
  }
  assert.equal((await app.request(`/api/work-templates/files/${detail.files[0].id}/download`, {headers: {cookie: outsider}})).status, 404);
  // 原本のファイル名でも探せる
  assert.deepEqual((await call(app, user, 'GET', `/api/work-templates/search?q=${encodeURIComponent('見積書.xlsx')}`)).data.templates.map((x) => x.id), [tid]);
  // ひな型の版にも、ドライブの出どころ（任意）を持てる
  const withRef = await call(app, user, 'POST', `/api/work-templates/templates/${tid}/versions`, {name: '架空の見積書の型', driveRef: '1AbCdEfGhIjKlMnOpQrStUv_-', expectedVersion: 1, reason: 'ドライブの印を足した'});
  assert.equal(withRef.status, 200);
  assert.equal((await call(app, user, 'GET', `/api/work-templates/templates/${tid}`)).data.versions[0].drive_ref, '1AbCdEfGhIjKlMnOpQrStUv_-');
});

test('FR-PROD-TMPL-011 毎晩の R2 の取り込みで入った原本（external）を、二重に登録せず、原本として結べる。権限・種類・場所の移動・ダウンロードの扱い', async (t) => {
  const {app, user, admin, outsider} = await fixture(t);
  const sha = createHash('sha256').update(ZIP).digest('hex');
  const KEY = 'current/ORG/F03_プリプロダクション/架空/架空の手配表.xlsx';
  const manifest = (key) => `key\tsize\tsha256\tuploaded_at\n${key}\t${ZIP.length}\t${sha}\t2026-10-27T21:05:00+09:00\ncurrent/ORG/F03_プリプロダクション/架空/架空の手配表.pdf\t10\t${'a'.repeat(64)}\t2026-10-27T21:05:00+09:00\n`;
  const imported = await call(app, admin, 'POST', '/api/source-documents/import-r2-manifest', {manifest: manifest(KEY), dryRun: false});
  assert.deepEqual([imported.status, imported.data.counts.new], [200, 2]);
  const folder = (await call(app, user, 'POST', '/api/work-templates/folders', {name: '手配'})).data.id;
  const tid = (await call(app, user, 'POST', `/api/work-templates/folders/${folder}/templates`, {name: '架空の手配表の型'})).data.id;
  const link = (cookie, body) => call(app, cookie, 'POST', `/api/work-templates/templates/${tid}/files`, body);

  // 探す: 管理者と編集者だけ。docx・xlsx・pptx だけが出る（pdf は出ない）
  assert.equal((await call(app, user, 'GET', '/api/work-templates/source-candidates?q=%E6%89%8B%E9%85%8D')).status, 403);
  const found = (await call(app, admin, 'GET', `/api/work-templates/source-candidates?q=${encodeURIComponent('手配表')}`)).data.documents;
  assert.deepEqual(found.map((d) => [d.file_name, d.storage, d.location]), [['架空の手配表.xlsx', 'external', KEY]]);
  assert.equal((await call(app, outsider, 'GET', `/api/work-templates/source-candidates?q=${encodeURIComponent('手配表')}`)).data.documents.length, 0, '別の組織の原本は出ない');

  // 結ぶ
  assert.equal((await link(user, {documentId: found[0].id})).status, 403, '制作の役割は結べない');
  assert.equal((await link(admin, {documentId: 999999})).status, 404);
  const pdfId = (await call(app, admin, 'GET', `/api/source-documents?q=${encodeURIComponent('手配表.pdf')}`)).data.items[0].id;
  assert.equal((await link(admin, {documentId: pdfId})).status, 400, 'pdf は断る');
  const first = await link(admin, {documentId: found[0].id, driveRef: 'https://docs.google.com/spreadsheets/d/FICTIONALID0123456789/edit'});
  assert.deepEqual([first.status, first.data.fileNo, first.data.storage], [200, 1, 'external']);
  assert.equal((await link(admin, {documentId: found[0].id, reason: '同じ', expectedFileNo: 1})).status, 409, '直前と同じ原本は断る');
  assert.equal((await link(outsider, {documentId: found[0].id})).status, 404, '別の組織からは結べない');

  // 同じ中身を画面から置いても、共通の原本は増えず、同じ原本を指す（二重に登録しない）
  const again = await call(app, user, 'POST', `/api/work-templates/templates/${(await call(app, user, 'POST', `/api/work-templates/folders/${folder}/templates`, {name: '別の型'})).data.id}/files`, {fileName: '手元の手配表.xlsx', base64: b64(ZIP)});
  assert.deepEqual([again.status, again.data.duplicate, again.data.documentId], [200, true, found[0].id]);
  // 目録を取り込み直しても増えず、R2 の中で場所が動いたら移動として数え、結んだ原本の場所が新しくなる
  assert.equal((await call(app, admin, 'POST', '/api/source-documents/import-r2-manifest', {manifest: manifest(KEY), dryRun: false})).data.counts.new, 0);
  const NEW_KEY = 'current/ORG/F04_プロダクション/架空/架空の手配表.xlsx';
  assert.equal((await call(app, admin, 'POST', '/api/source-documents/import-r2-manifest', {manifest: manifest(NEW_KEY), dryRun: false})).data.counts.moved, 1);
  const detail = (await call(app, user, 'GET', `/api/work-templates/templates/${tid}`)).data;
  assert.deepEqual(detail.files.map((f) => [f.file_no, f.storage, f.location, f.drive_ref !== null]), [[1, 'external', NEW_KEY, true]]);

  // R2 にある原本は、いまは画面から開けない。場所を添えて 409
  const res = await call(app, user, 'GET', `/api/work-templates/files/${detail.files[0].id}/download`);
  assert.equal(res.status, 409);
  assert.match(JSON.stringify(res.data), /F04_プロダクション/);
});

test('FR-PROD-TMPL-012 フォルダの改名・説明の更新・やめる／戻す: 追記で履歴が残り、現在の名前は重ならず、古い画面は 409、やめたフォルダは一覧から外れる', async (t) => {
  const {app, user, outsider} = await fixture(t);
  const make = async (name) => (await call(app, user, 'POST', '/api/work-templates/folders', {name})).data.id;
  const a = await make('架空の手配'); const b = await make('架空の下見');
  const tid = (await call(app, user, 'POST', `/api/work-templates/folders/${a}/templates`, version())).data.id;
  const rev = (id, body, cookie = user) => call(app, cookie, 'POST', `/api/work-templates/folders/${id}/revisions`, body);

  assert.equal((await rev(a, {name: '架空の下見', expectedRev: 0})).status, 409, '別のフォルダの現在の名前には直せない');
  assert.equal((await rev(a, {name: '  ', expectedRev: 0})).status, 400);
  assert.equal((await rev(a, {name: '新名称'})).status, 400, '直す元の番号が要る');
  assert.equal((await rev(a, {name: '架空の宿手配', description: '宿と駐車場', expectedRev: 0, reason: '呼び方を揃えた'})).data.revNo, 1);
  assert.equal((await rev(a, {name: '古い画面', expectedRev: 0})).status, 409, '古い画面からは直せない');
  assert.equal((await rev(outsider, {name: 'x', expectedRev: 0})).status, 404, '別の組織のフォルダは無いものとして扱う');

  // 直す前の名前は空き、現在の名前は重ならない
  assert.equal((await call(app, user, 'POST', '/api/work-templates/folders', {name: '架空の手配'})).status, 200, '直す前の名前は新しいフォルダが使える');
  assert.equal((await call(app, user, 'POST', '/api/work-templates/folders', {name: '架空の宿手配'})).status, 409);
  const list = (await call(app, user, 'GET', '/api/work-templates/folders')).data.folders;
  assert.deepEqual(list.filter((f) => f.id === a).map((f) => [f.name, f.description, f.rev_no, f.template_count]), [['架空の宿手配', '宿と駐車場', 1, 1]]);
  // 履歴は作ったときの値まで残る（新しい順）
  const history = (await call(app, user, 'GET', `/api/work-templates/folders/${a}/templates`)).data;
  assert.deepEqual(history.revisions.map((r) => [r.rev_no, r.name, r.reason]), [[1, '架空の宿手配', '呼び方を揃えた'], [0, '架空の手配', null]]);
  assert.equal(history.folder.name, '架空の宿手配');
  // 検索はいまのフォルダ名で当たる
  assert.deepEqual((await call(app, user, 'GET', `/api/work-templates/search?q=${encodeURIComponent('宿手配')}`)).data.templates.map((x) => [x.id, x.folder_name]), [[tid, '架空の宿手配']]);

  // やめる→一覧から外れ、ひな型は残る。やめたフォルダには作れず・複製できず・移せない。戻すと復活
  assert.equal((await rev(a, {name: '架空の宿手配', retired: true, expectedRev: 1, reason: '使わない'})).data.revNo, 2);
  assert.equal((await call(app, user, 'GET', '/api/work-templates/folders')).data.folders.some((f) => f.id === a), false);
  assert.equal((await call(app, user, 'GET', '/api/work-templates/folders?retired=1')).data.folders.find((f) => f.id === a).retired, true);
  assert.equal((await call(app, user, 'GET', `/api/work-templates/folders/${a}/templates`)).data.templates.length, 1, 'やめたフォルダの中身は読める（削除はしない）');
  assert.deepEqual((await call(app, user, 'GET', `/api/work-templates/search?q=${encodeURIComponent('宿の連絡')}`)).data.templates, [], 'やめたフォルダのひな型は検索に出ない');
  assert.equal((await call(app, user, 'POST', `/api/work-templates/folders/${a}/templates`, version())).status, 409);
  assert.equal((await call(app, user, 'POST', `/api/work-templates/templates/${tid}/copy`, {folderId: a})).status, 409);
  assert.equal((await call(app, user, 'POST', `/api/work-templates/templates/${tid}/move`, {folderId: a, expectedMoveNo: 0})).status, 409);
  assert.equal((await rev(a, {name: '架空の宿手配', retired: false, expectedRev: 2})).data.revNo, 3);
  assert.equal((await call(app, user, 'GET', '/api/work-templates/folders')).data.folders.some((f) => f.id === a), true);
  assert.equal((await call(app, user, 'POST', `/api/work-templates/folders/${a}/templates`, version({name: '架空の別の型'}))).status, 200);
  assert.equal(b > 0, true);
});

test('FR-PROD-TMPL-013 ひな型を別のフォルダへ移す: 追記で履歴が残り、件数・一覧・検索が現在のフォルダになり、古い画面・同じフォルダ・やめたフォルダ・別の組織は断る。名称・中身の更新は新しい版', async (t) => {
  const {app, user, outsider} = await fixture(t);
  const make = async (name) => (await call(app, user, 'POST', '/api/work-templates/folders', {name})).data.id;
  const a = await make('架空の移動元'); const b = await make('架空の移動先'); const gone = await make('架空のやめる先');
  await call(app, user, 'POST', `/api/work-templates/folders/${gone}/revisions`, {name: '架空のやめる先', retired: true, expectedRev: 0});
  const tid = (await call(app, user, 'POST', `/api/work-templates/folders/${a}/templates`, version())).data.id;
  const move = (body, cookie = user) => call(app, cookie, 'POST', `/api/work-templates/templates/${tid}/move`, body);

  assert.equal((await move({folderId: b})).status, 400, '移す元の番号が要る');
  assert.equal((await move({folderId: a, expectedMoveNo: 0})).status, 409, 'いまと同じフォルダは断る');
  assert.equal((await move({folderId: gone, expectedMoveNo: 0})).status, 409, 'やめたフォルダへは移せない');
  assert.equal((await move({folderId: 999999, expectedMoveNo: 0})).status, 404);
  assert.equal((await move({folderId: b, expectedMoveNo: 0}, outsider)).status, 404);
  assert.equal((await move({folderId: b, expectedMoveNo: 0, reason: '種類を分けた'})).data.moveNo, 1);
  assert.equal((await move({folderId: a, expectedMoveNo: 0})).status, 409, '古い画面からは移せない');

  const detail = (await call(app, user, 'GET', `/api/work-templates/templates/${tid}`)).data;
  assert.deepEqual([detail.template.folder_id, detail.template.folder_name, detail.template.move_no], [b, '架空の移動先', 1]);
  assert.deepEqual(detail.moves.map((m) => [m.move_no, m.folder_id, m.folder_name, m.reason]), [[1, b, '架空の移動先', '種類を分けた']]);
  assert.equal((await call(app, user, 'GET', `/api/work-templates/folders/${a}/templates`)).data.templates.length, 0);
  assert.deepEqual((await call(app, user, 'GET', `/api/work-templates/folders/${b}/templates`)).data.templates.map((x) => x.id), [tid]);
  const counts = Object.fromEntries((await call(app, user, 'GET', '/api/work-templates/folders')).data.folders.map((f) => [f.id, f.template_count]));
  assert.deepEqual([counts[a], counts[b]], [0, 1]);
  assert.deepEqual((await call(app, user, 'GET', `/api/work-templates/search?q=${encodeURIComponent('移動先')}`)).data.templates.map((x) => x.id), [tid]);
  // 戻すのも追記
  assert.equal((await move({folderId: a, expectedMoveNo: 1})).data.moveNo, 2);
  assert.equal((await call(app, user, 'GET', `/api/work-templates/templates/${tid}`)).data.moves.length, 2);

  // 名称・説明・中身の更新は新しい版（古い版は残る）。移したあとも同じ
  const v2 = await call(app, user, 'POST', `/api/work-templates/templates/${tid}/versions`, version({name: '架空の宿の連絡（改）', purpose: '説明を直した', expectedVersion: 1, reason: '名称と説明を直した'}));
  assert.equal(v2.status, 200);
  const after = (await call(app, user, 'GET', `/api/work-templates/templates/${tid}`)).data;
  assert.deepEqual([after.template.name, after.template.purpose, after.versions.length, after.template.folder_id], ['架空の宿の連絡（改）', '説明を直した', 2, a]);
  // 複製は現在のフォルダが既定
  const copy = (await call(app, user, 'POST', `/api/work-templates/templates/${tid}/copy`, {})).data.id;
  assert.equal((await call(app, user, 'GET', `/api/work-templates/templates/${copy}`)).data.template.folder_id, a);
});

test('FR-PROD-TMPL-009 DB は6表とも変更・削除を断り、連番の取り合い・理由なしの2版目・別の組織のフォルダを断る', async (t) => {
  const db = await openTestDb({t});
  const user = (await db.get("SELECT id FROM users WHERE email='production@openingnight.invalid'")).id;
  await db.run('INSERT INTO work_template_folders(org_id,name,created_by) VALUES(1,?,?)', ['架空の種類', user]);
  const folderId = (await db.get('SELECT id FROM work_template_folders')).id;
  await db.run('INSERT INTO work_templates(org_id,folder_id,created_by) VALUES(1,?,?)', [folderId, user]);
  const templateId = (await db.get('SELECT id FROM work_templates')).id;
  const insert = (versionNo, reason = null) => db.run('INSERT INTO work_template_versions(org_id,template_id,version_no,name,reason,created_by) VALUES(1,?,?,?,?,?)', [templateId, versionNo, '架空', reason, user]);
  await insert(1);
  await assert.rejects(() => insert(1), '同じ版番号は入らない');
  await assert.rejects(() => insert(3, '飛ばす'), '連番を飛ばせない');
  await assert.rejects(() => insert(2), '2版目は理由が要る');
  await insert(2, '直した');
  await assert.rejects(() => db.run("INSERT INTO work_template_versions(org_id,template_id,version_no,name,blocks_json,created_by) VALUES(1,?,3,'x','{}',?)", [templateId, user]), '部品は配列だけ');
  await assert.rejects(() => db.run('INSERT INTO work_templates(org_id,folder_id,created_by) VALUES(2,?,?)', [folderId, user]), '別の組織のフォルダには入らない');
  // フォルダの直し・移動: 連番、現在の名前の重なり（直す前の名前は使える）、別の組織の参照
  const rev = (no, name, folder = folderId, org = 1) => db.run('INSERT INTO work_template_folder_revisions(org_id,folder_id,rev_no,name,created_by) VALUES(?,?,?,?,?)', [org, folder, no, name, user]);
  await assert.rejects(() => rev(2, '飛ばす'), '連番を飛ばせない');
  await assert.rejects(() => db.run('INSERT INTO work_template_folders(org_id,name,created_by) VALUES(1,?,?)', ['架空の種類', user]), '現在の名前と同じは入らない');
  await rev(1, '改名した種類');
  await db.run('INSERT INTO work_template_folders(org_id,name,created_by) VALUES(1,?,?)', ['架空の種類', user]); // 直す前の名前は別のフォルダが使える
  const other = (await db.get("SELECT id FROM work_template_folders WHERE name='架空の種類'")).id;
  await assert.rejects(() => rev(1, '改名した種類', other), '別のフォルダの現在の名前には直せない');
  await assert.rejects(() => rev(1, '別', folderId, 2), '別の組織のフォルダは直せない');
  const move = (no, folder, orgId = 1) => db.run('INSERT INTO work_template_moves(org_id,template_id,move_no,folder_id,created_by) VALUES(?,?,?,?,?)', [orgId, templateId, no, folder, user]);
  await assert.rejects(() => move(2, other), '移動も連番を飛ばせない');
  await assert.rejects(() => move(1, other, 2), '別の組織には移せない');
  await move(1, other);
  for (const table of ['work_template_folder_revisions', 'work_template_moves']) {
    await assert.rejects(() => db.run(`UPDATE ${table} SET created_at='2000-01-01'`), /immutable/);
    await assert.rejects(() => db.run(`DELETE FROM ${table}`), /immutable/);
  }
  for (const table of ['work_template_folders', 'work_templates', 'work_template_versions']) {
    await assert.rejects(() => db.run(`UPDATE ${table} SET created_at='2000-01-01'`), /immutable/);
    await assert.rejects(() => db.run(`DELETE FROM ${table}`), /immutable/);
  }
  await db.run("INSERT INTO source_documents(org_id,kind,file_name,byte_length,sha256,storage,content_base64,received_on,received_by) VALUES(1,'other','架空.docx',4,?,'inline','UEsDBA==','2026-10-28',?)", ['b'.repeat(64), user]);
  const docId = (await db.get('SELECT id FROM source_documents')).id;
  await db.run('INSERT INTO work_template_files(org_id,template_id,file_no,document_id,created_by) VALUES(1,?,1,?,?)', [templateId, docId, user]);
  await assert.rejects(() => db.run('INSERT INTO work_template_files(org_id,template_id,file_no,document_id,reason,created_by) VALUES(1,?,3,?,?,?)', [templateId, docId, '飛ばす', user]));
  await assert.rejects(() => db.run('INSERT INTO work_template_files(org_id,template_id,file_no,document_id,created_by) VALUES(1,?,2,?,?)', [templateId, docId, user]), '2つ目は理由が要る');
  await assert.rejects(() => db.run("INSERT INTO work_template_files(org_id,template_id,file_no,document_id,reason,drive_ref,created_by) VALUES(1,?,2,?,'x','   ',?)", [templateId, docId, user]), 'ドライブの印は空白だけにできない');
  await assert.rejects(() => db.run('UPDATE work_template_files SET reason=NULL'), /immutable/);
  await assert.rejects(() => db.run('DELETE FROM work_template_files'), /immutable/);
});
