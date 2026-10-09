// sales-source-review-fixes.test.mjs の組み立て（架空の原本・マスタ・列対応の版）。
// 受領原本の付け替え・分割（設計 §5）のレビュー指摘の回帰試験で使う。DB は試験の DB のファクトリ（test-db.mjs）で開く
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {buildDefinition, defaultFields, guessPeriod, blankField} from '../src/import/wizard-model.mjs';

export const HEADERS = ['作品CD', '商品ｺｰﾄﾞ', '配信区分', '対象月', '視聴/契約数', '単価(税抜)', '総額', 'PF手数料', '正味売上', '備考'];
export const row = (work, sku, net, note = '') => [work, sku, 'TVOD', '2026/08', '1', net, net, '0', net, note];
export const sheetOf = (data) => [['架空の配信報告（複数作品）', '', '', '', '', '', '', '', '', ''], HEADERS, ...data];
export const HEADER_ROW = 2;
export const ADMIN = 'admin@openingnight.invalid';
export const EDITOR = 'editor@openingnight.invalid';
export const EDITOR2 = 'editor2@openingnight.invalid';
export const EDITOR3 = 'editor3@openingnight.invalid';

// 作品: 1 WRK-DEMO（案件1）・3 WRK-B（案件1）・4 WRK-C（案件3。編集担当には権限なし）
// 商品: 1 SKU-DIGI→作品1、3 SKU-B→作品3、4 SKU-SHARED→作品1 60%・作品3 40%、5 SKU-C→作品4、8 SKU-NEW→作品1
// 利用者: 2 編集担当・5 編集担当2・6 編集担当3（どれも案件1の編集権限。案件3の権限なし）
async function seedMasters(db) {
  await db.batch([
    {sql: "INSERT INTO projects(id,org_id,code,title,status) VALUES (3,1,'PRJ-SPLIT','分割用の架空案件','active')"},
    {sql: "INSERT INTO works(id,org_id,project_id,code,title) VALUES (3,1,1,'WRK-B','二本目の架空作品'),(4,1,3,'WRK-C','権限外の架空作品')"},
    {sql: `INSERT INTO products(id,org_id,sku,name,channel) VALUES (3,1,'SKU-B','二本目の配信','digital'),(4,1,'SKU-SHARED','二本立ての配信','digital'),
      (5,1,'SKU-C','権限外の配信','digital'),(8,1,'SKU-NEW','新しい配信','digital')`},
    {sql: 'INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES (1,3,3,10000),(1,4,1,6000),(1,4,3,4000),(1,5,4,10000),(1,8,1,10000)'},
    {sql: "INSERT INTO users(id,email,display_name) VALUES (5,'editor2@openingnight.invalid','編集担当2'),(6,'editor3@openingnight.invalid','編集担当3')"},
    {sql: "INSERT INTO memberships(org_id,user_id,role) VALUES (1,5,'editor'),(1,6,'editor')"},
    {sql: "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES (1,1,5,'edit'),(1,1,6,'edit')"},
  ]);
}

// 試験の組み立て。mode='worker' は認証を要求の見出し（x-test-user）で渡す。
// makeDb を渡すと、それが返す db（クラウドの R2 退避の包みなど）でアプリを作る（inner は試験の DB）。kind は試験の DB の種類（既定は ON_TEST_DB）
export async function fixture({t, kind, mode = 'local', makeDb = null} = {}) {
  const inner = await openTestDb({t, kind});
  await seedMasters(inner);
  const db = makeDb ? makeDb(inner) : inner;
  const sheets = new Map();
  const extractDocument = async ({name, base64}) => {
    const bytes = Buffer.from(base64, 'base64');
    return {extractorName: 'test', extractorVersion: '1', rawSha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, name, documentType: 'workbook', status: 'extracted', text: '', sheets: [{name: 'Details', rows: sheets.get(bytes.toString('utf8'))}]};
  };
  const authenticate = async (request) => {
    const email = request.headers.get('x-test-user') || ADMIN;
    const user = await inner.get('SELECT u.id AS user_id, u.email, u.display_name, m.org_id, m.role, m.expires_at FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=? ORDER BY m.org_id LIMIT 1', [email]);
    return user ? {...user} : null;
  };
  const app = createApp({db, mode, extractDocument, authenticate});
  const cookies = {};
  async function headersFor(email) {
    if (mode !== 'local') return {'x-test-user': email};
    if (!cookies[email]) {
      const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
      cookies[email] = response.headers.get('set-cookie').split(';')[0];
    }
    return {cookie: cookies[email]};
  }
  async function call(path, body, email = ADMIN) {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {...await headersFor(email), 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  }
  const base64Of = (label) => Buffer.from(label).toString('base64');
  const hashOf = (label) => createHash('sha256').update(label).digest('hex');
  async function receive(label, data, {binding = null, email, sheet = null} = {}) {
    sheets.set(label, sheet || sheetOf(data));
    return call('/sales-import/files', {name: `${label}.xlsx`, base64: base64Of(label), binding}, email);
  }
  return {db: inner, app, call, receive, hashOf};
}

// 列対応の版（配信）。resolvedProduct なら商品は「商品ID（照合）」の列から取る。productId なら商品をその1つに固定する
export async function mappingVersion(f, {resolvedProduct = false, productId = null, reportKey = 'SPLIT-202608', email, partnerId = 2, kind = 'digital', headers = HEADERS, amountColumn = null, productNone = false} = {}) {
  const sample = [row('WRK-DEMO', 'SKU-DIGI', '1000')];
  const {fields} = defaultFields({headers, sampleRows: headers === HEADERS ? sample : [], productIds: productId ? [productId] : [], period: headers === HEADERS ? guessPeriod(HEADERS, sample) : null, resolvedProduct});
  if ((!resolvedProduct && !productId) || productNone) fields.product_id = blankField('none');
  fields.report_key = {...blankField('literal'), value: reportKey};
  fields.recognition_basis_id = {...blankField('literal'), value: '2'};
  fields.basis_date = {...blankField('literal'), value: '2026-09-05'};
  fields.basis_reason = {...blankField('literal'), value: '月次報告を受領した月で計上'};
  if (headers !== HEADERS) {
    fields.period_from = {...blankField('literal'), value: '2026-08-01'};
    fields.period_to = {...blankField('literal'), value: '2026-08-31'};
    fields.description = blankField('none');
    fields.quantity = blankField('none');
  }
  if (amountColumn) fields.amount_ex_tax = {...blankField('source'), source: amountColumn};
  fields.tax_amount = blankField('zero');
  fields.amount_inc_tax = blankField('same_ex');
  const built = buildDefinition(fields, {headers, partnerId, autoKey: reportKey, resolvedProduct});
  assert.deepEqual(built.errors, []);
  let profile = (await f.call(`/sales-import/context?partnerId=${partnerId}&kind=${kind}`, null, email)).data.profile;
  if (!profile) profile = {id: (await f.call('/mapping-profiles', {partnerId, kind, name: `架空｜${partnerId}｜${kind}`}, email)).data.profileId};
  const version = await f.call(`/mapping-profiles/${profile.id}/versions`, built.definition, email);
  assert.equal(version.status, 201, JSON.stringify(version.data));
  return version.data.mappingVersionId;
}

export async function select(f, fileId, excludedRows = [], email, headerRow = HEADER_ROW) {
  const selection = await f.call(`/sales-import/files/${fileId}/selection`, {sheetName: 'Details', headerRow, excludedRows}, email);
  assert.equal(selection.status, 201, JSON.stringify(selection.data));
  return selection.data;
}
export const previewPartition = (f, partition, versionId, email) => f.call('/mapped-imports/preview', {workId: partition.workId, mappingVersionId: versionId, text: partition.csv, sourcePartitionId: partition.id}, email);
export async function commitPartition(f, partition, versionId, email, extra = {}) {
  const preview = await previewPartition(f, partition, versionId, email);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.ok, true, JSON.stringify(preview.data.errors));
  return f.call('/sales-import/commit', {token: preview.data.token, ...extra}, email);
}
export const count = async (f, table) => Number((await f.db.get(`SELECT count(*) AS n FROM ${table}`)).n);
