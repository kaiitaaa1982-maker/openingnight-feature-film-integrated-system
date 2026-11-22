import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb, writeMark} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerSourceDocument, recordSourceDocumentMove} from '../src/source-documents/source-documents-store.mjs';

const PATH = '/api/source-documents/tree';
const base = {orgId: 1, userId: 1, kind: 'other', fileName: '架空原本.pdf', receivedOn: '2026-10-28'};
async function login(app, email = 'admin@openingnight.invalid') {
  const res = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}
async function read(app, cookie, suffix = '') {
  const res = await app.request(PATH + suffix, {headers: {cookie}});
  assert.equal(res.status, 200);
  return (await res.json()).items;
}
async function project(db, orgId, code, title) {
  return (await db.get('INSERT INTO projects(org_id,code,title) VALUES(?,?,?) RETURNING id', [orgId, code, title])).id;
}

test('原本の木は組織内だけを読み、移動後の場所と場所なしと未を返し、何も書き換えない', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const admin = await login(app);
  const other = await login(app, 'outsider@other.invalid');
  const {id} = await registerSourceDocument(db, {...base,
    external: {location: 'current/ORG/F01/架空作品/旧.pdf', byteLength: 123, sha256: 'a'.repeat(64)}});
  await recordSourceDocumentMove(db, {orgId: 1, userId: 1, documentId: id, toLocation: 'current/ORG/F02/架空作品/中.pdf'});
  const location = 'current/ORG/F22/架空作品/原本.pdf';
  await recordSourceDocumentMove(db, {orgId: 1, userId: 1, documentId: id, toLocation: location});
  const inline = await registerSourceDocument(db, {...base, fileName: '架空メモ.txt', bytes: new TextEncoder().encode('架空のメモ')});
  const outsider = await registerSourceDocument(db, {...base, orgId: 2, userId: 4,
    external: {location: 'current/ORG/F01/別組織/秘密.pdf', byteLength: 456, sha256: 'a'.repeat(64)}});
  const otherProject = await project(db, 2, 'TREE-OTHER', '架空別組織案件');
  await db.run("INSERT INTO planning_documents(org_id,project_id,document_id,kind,created_by) VALUES(2,?,?,'material',4)", [otherProject, outsider.id]);
  const mark = await writeMark(db);
  const items = await read(app, admin, '?org_id=2');
  assert.deepEqual(await writeMark(db), mark);
  assert.deepEqual(items.map((d) => d.id), [id, inline.id]);
  assert.deepEqual(items[0], {id, fileName: base.fileName, location, sha256: 'a'.repeat(64), byteLength: 123,
    kind: 'other', links: [], linkedCount: 0, unlinked: true});
  assert.equal(items[1].location, null);
  assert.equal(items[1].unlinked, true);
  assert.equal(JSON.stringify(items).includes('content_base64'), false);
  assert.equal(JSON.stringify(items).includes('架空別組織案件'), false);
  const otherItems = await read(app, other);
  assert.deepEqual(otherItems.map((d) => d.id), [outsider.id]);
  assert.equal(otherItems[0].links[0].targets[0].name, '架空別組織案件');
});

test('6系統の参照を表ごとに数え、複数案件の名前・ページID・作品を返して未を外す', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'}), cookie = await login(app);
  const {id} = await registerSourceDocument(db, {...base, bytes: new TextEncoder().encode('架空の共通資料')});
  const p1 = await project(db, 1, 'TREE-A', '架空案件A'), p2 = await project(db, 1, 'TREE-B', '架空案件B');
  const work = (await db.get("INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,'TREE-W','架空作品A') RETURNING id", [p1])).id;
  const day = (await db.get("INSERT INTO shooting_days(org_id,project_id,work_id,shoot_date,unit,label,created_by) VALUES(1,?,?,'2026-10-28','A','架空撮影日',1) RETURNING id", [p1, work])).id;
  const contract = (await db.get("INSERT INTO acq_mg_contracts(org_id,code,title,partner_id,created_by) VALUES(1,'TREE-MG','架空買付A',1,1) RETURNING id")).id;
  for (const kind of ['contract', 'invoice']) await db.run("INSERT INTO acq_mg_documents(org_id,contract_id,source_document_id,kind,reason,created_by) VALUES(1,?,?,?,'架空検証',1)", [contract, id, kind]);
  for (const p of [p1, p1, p2]) await db.run("INSERT INTO planning_documents(org_id,project_id,document_id,kind,created_by) VALUES(1,?,?,'material',1)", [p, id]);
  for (const kind of ['camera', 'sound']) await db.run("INSERT INTO shooting_day_records(org_id,project_id,work_id,shooting_day_id,kind,seq,status,source_document_id,created_by) VALUES(1,?,?,?,?,1,'placed',?,1)", [p1, work, day, kind, id]);
  const caseId = (await db.get("INSERT INTO chotatsu_cases(org_id,case_code,created_by) VALUES(1,'TREE-C',1) RETURNING id")).id;
  for (const [version, title] of [[1, '架空調達旧'], [2, '架空調達A']]) {
    await db.run("INSERT INTO chotatsu_case_versions(org_id,case_id,version_no,title,media_family,origin,reason,created_by) VALUES(1,?,?,?,'other','self','架空検証',1)", [caseId, version, title]);
  }
  await db.run("INSERT INTO chotatsu_documents(org_id,case_id,source_document_id,doc_kind,created_by) VALUES(1,?,?,'other',1)", [caseId, id]);
  for (const category of ['other', 'script']) await db.run('INSERT INTO preprod_document_placements(org_id,work_id,document_id,category,placed_by) VALUES(1,?,?,?,1)', [work, id, category]);
  await db.run("INSERT INTO permit_offices(org_id,name,created_by) VALUES(1,'架空署',1)");
  const permit = (await db.get("INSERT INTO permit_applications(org_id,work_id,application_key,kind,created_by) VALUES(1,?,'TREE-P','road',1) RETURNING id", [work])).id;
  await db.run("INSERT INTO permit_application_documents(org_id,application_id,document_id,role,linked_by) VALUES(1,?,?,'permit',1)", [permit, id]);
  const [item] = await read(app, cookie);
  assert.equal(item.linkedCount, 11);
  assert.equal(item.unlinked, false);
  assert.deepEqual(item.links.map((l) => [l.table, l.pageId, l.count]), [
    ['acq_mg_documents', 'MG 買付', 2], ['planning_documents', '企画', 3], ['shooting_day_records', '撮影の記録', 2],
    ['chotatsu_documents', '調達', 1], ['preprod_document_placements', 'プリプロ', 2], ['permit_application_documents', '許可申請', 1],
  ]);
  assert.deepEqual(item.links[1].targets, [{id: p1, name: '架空案件A', count: 2, workId: null}, {id: p2, name: '架空案件B', count: 1, workId: null}]);
  assert.deepEqual(item.links[2].targets, [{id: work, name: '架空作品A', count: 2, workId: work}]);
  assert.equal(item.links[3].targets[0].name, '架空調達A');
  assert.equal(item.links[4].targets[0].workId, work);
  assert.deepEqual(item.links[5].targets, [{id: permit, name: '架空作品A', count: 1, workId: work}]);
});

test('編集者も木を読めるが未認証と制作担当は読めず、原本は200件で打ち切らない', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  assert.equal((await app.request(PATH)).status, 401);
  const production = await login(app, 'production@openingnight.invalid');
  const denied = await app.request(PATH, {headers: {cookie: production}});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, '原本の一覧への権限がありません');
  const editor = await login(app, 'editor@openingnight.invalid');
  assert.deepEqual(await read(app, editor), []);
  for (let i = 0; i < 201; i += 1) await registerSourceDocument(db, {...base, fileName: `架空原本${i}.txt`, bytes: new TextEncoder().encode(`架空資料${i}`)});
  const items = await read(app, editor);
  assert.equal(items.length, 201);
  assert.equal(items.filter((d) => d.unlinked).length, 201);
});
