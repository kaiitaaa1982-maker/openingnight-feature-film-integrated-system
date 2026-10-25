// 業務を問わない共通の原本の表（移行 0025・src/source-documents/source-documents-store.mjs）を、SQLite と PostgreSQL の両方で確かめる。
// 会社ルートの plans/2026-10-22-folder-parallel-design.md の X-1・X-7。架空のデータだけを使う（初期データの組織1・2と利用者1・4）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {MAX_INLINE_BYTES, SourceDocumentError, getSourceDocument, listSourceDocuments, registerSourceDocument, sha256Hex} from '../src/source-documents/source-documents-store.mjs';

const bytesOf = (text) => new TextEncoder().encode(text);
const base = {orgId: 1, userId: 1, kind: 'contract', fileName: '架空の契約書.pdf', mediaType: 'application/pdf', receivedOn: '2026-10-01'};

test('FR-CORE-DATA-056 原本を受け取ると中身とハッシュが残り、変更と削除は DB が断る', async (t) => {
  const db = await openTestDb({t});
  const content = bytesOf('架空の契約書の中身');
  const {id, duplicate} = await registerSourceDocument(db, {...base, bytes: content});
  assert.equal(duplicate, false);
  const got = await getSourceDocument(db, 1, id, {withContent: true});
  assert.equal(got.storage, 'inline');
  assert.equal(got.byte_length, content.length);
  assert.equal(got.sha256, await sha256Hex(content));
  assert.deepEqual([...got.bytes], [...content]);
  assert.equal((await getSourceDocument(db, 1, id)).bytes, undefined, '中身は頼んだときだけ付ける');
  await assert.rejects(db.run('UPDATE source_documents SET file_name=? WHERE id=?', ['書き換え', id]), /変更できません/);
  await assert.rejects(db.run('DELETE FROM source_documents WHERE id=?', [id]), /削除できません/);
});

test('FR-CORE-DATA-057 同じ組織で同じ中身は1行だけ。2回目は前の行の ID を duplicate で返し、別の組織なら別の行になる', async (t) => {
  const db = await openTestDb({t});
  const content = bytesOf('同じ中身の請求書');
  const first = await registerSourceDocument(db, {...base, kind: 'invoice', bytes: content});
  const second = await registerSourceDocument(db, {...base, kind: 'invoice', fileName: '別の名前.pdf', bytes: content});
  assert.deepEqual(second, {id: first.id, duplicate: true});
  assert.equal((await listSourceDocuments(db, 1, {kind: 'invoice'})).length, 1);
  const other = await registerSourceDocument(db, {...base, orgId: 2, userId: 4, kind: 'invoice', bytes: content});
  assert.equal(other.duplicate, false);
  assert.notEqual(other.id, first.id);
  // 組織をまたいで読めない（アプリの絞り。PostgreSQL ではこの下に行単位の権限 pg/rls.sql もかかる）
  assert.equal(await getSourceDocument(db, 1, other.id), null);
  assert.deepEqual((await listSourceDocuments(db, 2)).map((r) => r.id), [other.id]);
});

test('FR-CORE-DATA-058 12MB を超える中身は inline で断り、外の置き場は名前・大きさ・ハッシュだけを持つ', async (t) => {
  const db = await openTestDb({t});
  await assert.rejects(registerSourceDocument(db, {...base, kind: 'media', bytes: new Uint8Array(MAX_INLINE_BYTES + 1)}), SourceDocumentError);
  const sha = 'a'.repeat(64);
  const {id} = await registerSourceDocument(db, {...base, kind: 'media', fileName: '本編マスター.mov', external: {location: '架空の外の置き場/本編マスター.mov', byteLength: 80_000_000_000, sha256: sha}});
  const got = await getSourceDocument(db, 1, id, {withContent: true});
  assert.equal(got.storage, 'external');
  assert.equal(got.byte_length, 80_000_000_000);
  assert.equal(got.bytes, null);
  assert.equal(got.external_location, '架空の外の置き場/本編マスター.mov');
  await assert.rejects(registerSourceDocument(db, {...base, kind: 'media', external: {location: 'x', byteLength: 1, sha256: 'ABC'}}), /SHA-256/);
  await assert.rejects(registerSourceDocument(db, {...base, bytes: bytesOf('a'), external: {location: 'x', byteLength: 1, sha256: sha}}), /どちらか一方/);
  // DB も inline の大きさの上限を断る（入口を通らない書き込みでも）
  await assert.rejects(db.run(`INSERT INTO source_documents(org_id,kind,file_name,byte_length,sha256,storage,content_base64,received_on,received_by) VALUES(1,'media','x',?,?,'inline','AA==','2026-10-01',1)`, [MAX_INLINE_BYTES + 1, 'b'.repeat(64)]));
});

test('FR-CORE-DATA-059 既存の原本の表の行を指せる（同じ行を2回は指さない）。種類・日付・ハッシュの形の誤りは DB でも断る', async (t) => {
  const db = await openTestDb({t});
  await registerSourceDocument(db, {...base, kind: 'sales_report', bytes: bytesOf('売上報告書1'), legacy: {table: 'sales_source_files', id: 7}});
  await assert.rejects(registerSourceDocument(db, {...base, kind: 'sales_report', bytes: bytesOf('売上報告書2'), legacy: {table: 'sales_source_files', id: 7}}));
  await assert.rejects(registerSourceDocument(db, {...base, bytes: bytesOf('x'), legacy: {table: 'users', id: 1}}), SourceDocumentError);
  await assert.rejects(registerSourceDocument(db, {...base, kind: 'secret', bytes: bytesOf('y')}), SourceDocumentError);
  await assert.rejects(registerSourceDocument(db, {...base, receivedOn: '2026/10/01', bytes: bytesOf('z')}), SourceDocumentError);
  const insert = (sha, kind = 'other') => db.run(`INSERT INTO source_documents(org_id,kind,file_name,byte_length,sha256,storage,content_base64,received_on,received_by) VALUES(1,?,'x',1,?,'inline','AA==','2026-10-01',1)`, [kind, sha]);
  await assert.rejects(insert('G'.repeat(64)));
  await assert.rejects(insert('c'.repeat(64), 'secret'));
});

test('FR-CORE-DATA-060 一覧は種類と受けた日の範囲で絞れ、中身は付けない', async (t) => {
  const db = await openTestDb({t});
  await registerSourceDocument(db, {...base, kind: 'schedule', receivedOn: '2026-09-30', bytes: bytesOf('香盤1')});
  await registerSourceDocument(db, {...base, kind: 'schedule', receivedOn: '2026-10-15', bytes: bytesOf('香盤2')});
  await registerSourceDocument(db, {...base, kind: 'budget', receivedOn: '2026-10-15', bytes: bytesOf('予算書')});
  const october = await listSourceDocuments(db, 1, {kind: 'schedule', from: '2026-10-01', to: '2026-10-31'});
  assert.deepEqual(october.map((r) => r.received_on), ['2026-10-15']);
  assert.equal('content_base64' in october[0], false);
  assert.equal((await listSourceDocuments(db, 1, {from: '2026-10-01'})).length, 2);
});
