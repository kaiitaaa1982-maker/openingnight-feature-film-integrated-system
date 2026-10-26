// FR-CORE-DATA-062〜064。架空の原本だけ。test-pg.mjs でも同じ試験を流す。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import * as documents from '../src/source-documents/source-documents-store.mjs';
import {MAX_R2_MANIFEST_ROWS} from '../src/source-documents/r2-manifest-routes.mjs';
import {D1_MAX_STATEMENTS} from '../src/d1-limits.mjs';

const OLD = 'current/F01_企画/架空企画.pdf';
const NEXT = 'current/ORG/F01_企画/架空企画.pdf';
const SHA = 'a'.repeat(64);
const base = {orgId: 1, userId: 1, kind: 'planning_deck', fileName: '架空企画.pdf', receivedOn: '2026-10-25'};
const line = (key, sha = SHA) => `${key}\t123\t${sha}\t2026-10-25T00:00:00Z`;
const register = (db, location = OLD, sha256 = SHA) => documents.registerSourceDocument(db,
  {...base, external: {location, sha256, byteLength: 123}});
const move = (db, documentId, toLocation, extra = {}) => documents.recordSourceDocumentMove(db,
  {orgId: 1, userId: 1, documentId, toLocation, ...extra});
const history = (db) => db.all('SELECT * FROM source_document_moves ORDER BY id');

async function fixture(t) {
  const raw = await openTestDb({t});
  const counter = {statements: 0, reads: 0};
  const db = new Proxy(raw, {get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (!['get', 'all', 'run', 'batch', 'readBatch'].includes(prop)) return value.bind(target);
    return (...args) => {
      const statements = ['batch', 'readBatch'].includes(prop) ? args[0] : [{sql: args[0], params: args[1]}];
      counter.statements += statements.length;
      for (const {sql, params = []} of statements) {
        assert.ok(params.length <= 100, 'D1の1文の値の上限');
        if (/^SELECT\b/i.test(sql.trim()) && /FROM source_documents\b/.test(sql)) counter.reads += 1;
      }
      return value.apply(target, args);
    };
  }});
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (rows, dryRun = false) => {
    const res = await app.request('/api/source-documents/import-r2-manifest', {method: 'POST',
      headers: {'content-type': 'application/json', cookie}, body: JSON.stringify({manifest: rows.join('\n'), dryRun})});
    assert.equal(res.status, 200);
    return (await res.json()).counts;
  };
  return {db, call, counter};
}

test('FR-CORE-DATA-062 FR-CORE-DATA-063 目録の移動は事前確認で書かず、本取り込み後は新しい場所と最初の場所を返し再送で増えない', async (t) => {
  const {db, call} = await fixture(t);
  const {id} = await register(db);
  const original = await db.get('SELECT * FROM source_documents WHERE id=?', [id]);
  assert.deepEqual(await call([line(NEXT)], true), {new: 0, duplicate: 0, moved: 1, rejected: 0});
  assert.deepEqual(await history(db), []);
  assert.equal((await documents.getSourceDocument(db, 1, id)).external_location, OLD);
  assert.deepEqual(await call([line(NEXT)]), {new: 0, duplicate: 0, moved: 1, rejected: 0});
  for (const doc of [await documents.getSourceDocument(db, 1, id, {withContent: true}), ...(await documents.listSourceDocuments(db, 1))]) {
    assert.equal(doc.external_location, NEXT);
    assert.equal(doc.originalLocation, OLD);
    assert.equal(doc.sha256, SHA);
  }
  assert.deepEqual(await db.get('SELECT * FROM source_documents WHERE id=?', [id]), original);
  const [record] = await history(db);
  assert.deepEqual([record.org_id, record.document_id, record.from_location, record.to_location, record.moved_by], [1, id, OLD, NEXT, 1]);
  assert.match(record.moved_at, /^\d{4}-\d{2}-\d{2} /);
  for (const dryRun of [false, true]) assert.deepEqual(await call([line(NEXT)], dryRun), {new: 0, duplicate: 1, moved: 0, rejected: 0});
  assert.equal((await history(db)).length, 1);
  await move(db, id, NEXT);
  assert.equal((await history(db)).length, 1, 'storeの同じ場所への記録も何もしない');
  await move(db, id, 'current/架空の次の場所.pdf', {reason: '架空の整理'});
  const last = (await history(db)).at(-1);
  assert.equal(last.from_location, NEXT);
  assert.equal(last.reason, '架空の整理');
  assert.equal((await documents.getSourceDocument(db, 1, id)).originalLocation, OLD);
  assert.equal((await documents.getSourceDocument(db, 1, id)).external_location, last.to_location);
});

test('FR-CORE-DATA-062 一覧の検索は、移動したあとの場所でも最初の場所でも見つかる', async (t) => {
  const {db, call} = await fixture(t);
  const {id} = await register(db);
  await call([line(NEXT)]);
  const found = async (q) => (await documents.listSourceDocuments(db, 1, {q})).map((doc) => doc.id);
  assert.deepEqual(await found('ORG/F01'), [id]);
  assert.deepEqual(await found('current/F01_企画'), [id]);
  assert.deepEqual(await found('架空企画'), [id]);
  assert.deepEqual(await found('別の場所'), []);
});

test('FR-CORE-DATA-063 現在のキーが目録にあれば行の順によらず重複とし、最新の移動先でも同じ判定をする', async (t) => {
  const {db, call} = await fixture(t);
  const {id} = await register(db);
  for (const rows of [[line(NEXT), line(OLD)], [line(OLD), line(NEXT)]]) {
    for (const dryRun of [true, false]) assert.deepEqual(await call(rows, dryRun), {new: 0, duplicate: 2, moved: 0, rejected: 0});
  }
  assert.equal((await history(db)).length, 0);
  await move(db, id, NEXT);
  assert.deepEqual(await call([line('current/架空コピー.pdf'), line(NEXT)]), {new: 0, duplicate: 2, moved: 0, rejected: 0});
  assert.equal((await history(db)).length, 1);
});

test('FR-CORE-DATA-063 移動先が複数あっても先頭へ1回だけ移し、同じ要求の残りと再送は重複にする', async (t) => {
  const {db, call} = await fixture(t);
  await register(db);
  const rows = [line(NEXT), line('current/架空コピー.pdf'), line(NEXT)];
  for (const dryRun of [true, false]) assert.deepEqual(await call(rows, dryRun), {new: 0, duplicate: 2, moved: 1, rejected: 0});
  assert.deepEqual(await call(rows), {new: 0, duplicate: 3, moved: 0, rejected: 0});
  assert.equal((await history(db)).length, 1);
});

test('FR-CORE-DATA-062 移動の変更と削除とinlineの移動をDBが拒み、組織と所属の境界を守る', async (t) => {
  const {db, call} = await fixture(t);
  const {id} = await register(db);
  await move(db, id, NEXT);
  for (const sql of ['UPDATE source_document_moves SET reason=? WHERE document_id=?', 'DELETE FROM source_document_moves WHERE reason=? OR document_id=?']) {
    await assert.rejects(db.run(sql, ['変更', id]), (e) => e.dbError?.kind === 'raise' && /変更できません|削除できません/.test(e.message));
  }
  const inline = await documents.registerSourceDocument(db, {...base, bytes: new TextEncoder().encode('架空の中身')});
  await assert.rejects(move(db, inline.id, NEXT), /外の置き場の原本だけ/);
  const inlineDoc = await documents.getSourceDocument(db, 1, inline.id);
  assert.deepEqual(await call([line('current/架空inline.pdf', inlineDoc.sha256)]), {new: 0, duplicate: 1, moved: 0, rejected: 0});
  const insert = (orgId, docId, userId) => db.run(`INSERT INTO source_document_moves(org_id,document_id,from_location,to_location,moved_by) VALUES(?,?,?,?,?)`, [orgId, docId, OLD, NEXT, userId]);
  await assert.rejects(insert(1, inline.id, 1), (e) => e.dbError?.kind === 'raise' && /外の置き場の原本だけ/.test(e.message));
  await assert.rejects(insert(2, id, 4), (e) => e.dbError?.kind === 'foreign_key');
  await assert.rejects(insert(1, id, 4), (e) => e.dbError?.kind === 'foreign_key');
  assert.equal(await documents.getSourceDocument(db, 2, id), null);
  assert.deepEqual(await documents.listSourceDocuments(db, 2), []);
  assert.equal((await history(db)).length, 1);
});

test('FR-CORE-DATA-062 場所は1字から500字、理由は任意で500字までとし同じ場所の行はDBが断る', async (t) => {
  const db = await openTestDb({t});
  const {id} = await register(db);
  const insert = (from, to, reason = null) => db.run(`INSERT INTO source_document_moves(org_id,document_id,from_location,to_location,moved_by,reason) VALUES(1,?,?,?,1,?)`, [id, from, to, reason]);
  await insert('a', 'b'.repeat(500), '理'.repeat(500));
  await insert('a'.repeat(500), 'b');
  for (const [from, to, reason] of [['', 'b'], ['a', ''], ['a'.repeat(501), 'b'], ['a', 'b'.repeat(501)], ['a', 'a'], ['a', 'b', '理'.repeat(501)]]) {
    await assert.rejects(insert(from, to, reason), (e) => e.dbError?.kind === 'check');
  }
  assert.equal((await history(db)).length, 2);
});

test('FR-CORE-DATA-064 上限200件の移動も現在の場所を一括で読み問い合わせ500回以内で事前確認と取り込みを行う', async (t) => {
  const {db, call, counter} = await fixture(t);
  const rows = [];
  for (let i = 0; i < MAX_R2_MANIFEST_ROWS; i += 1) {
    const sha = i.toString(16).padStart(64, '0');
    await register(db, `current/旧/架空${i}.pdf`, sha);
    rows.push(line(`current/新/架空${i}.pdf`, sha));
  }
  for (const dryRun of [true, false]) {
    counter.statements = 0; counter.reads = 0;
    assert.deepEqual(await call(rows, dryRun), {new: 0, duplicate: 0, moved: 200, rejected: 0});
    assert.ok(counter.statements <= D1_MAX_STATEMENTS, `問い合わせ${counter.statements}回`);
    assert.ok(counter.reads <= 3, `一括照会${counter.reads}回`);
    t.diagnostic(`${dryRun ? 'dryRun' : '本取り込み'}: 問い合わせ${counter.statements}回・一括照会${counter.reads}回`);
    assert.equal((await history(db)).length, dryRun ? 0 : 200);
  }
});
