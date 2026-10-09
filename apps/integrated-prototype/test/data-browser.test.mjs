import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

test('data definitions are shared; rows are admin-only, org-scoped, and hide secrets', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const get = async (path, cookie = admin) => { const r = await app.request(`/api${path}`, {headers: {cookie}}); return {status: r.status, data: await r.json()}; };
  const list = (await get('/admin/tables')).data.tables;
  const names = list.map((t) => t.name);
  for (const hidden of ['sessions', 'users', 'organizations', 'transaction_guards']) assert.ok(!names.includes(hidden), hidden);
  assert.equal(list.find((t) => t.name === 'partners').rows, null, '件数は選択後に数える');
  const partners = (await get('/admin/tables/partners')).data;
  assert.ok(partners.rows.every((row) => row.org_id === 1));
  const previews = (await get('/admin/tables/bulk_import_previews')).data;
  assert.ok(previews.hiddenColumns.includes('token'));
  assert.equal((await get('/admin/tables/sessions')).status, 404);
  const editor = await login('editor@openingnight.invalid');
  assert.equal((await get('/admin/tables', editor)).status, 200);
  assert.equal((await get('/admin/tables/partners', editor)).status, 403);
  assert.equal((await get('/admin/import-history', editor)).status, 403);
  const history = (await get('/admin/import-history')).data;
  assert.ok(Array.isArray(history.reports) && Array.isArray(history.batches));
});

test('データ一覧は原本・表編集の中身などの大きな列を読み込まず「省略」と返す（Worker のメモリ上限のため）', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const call = async (path, body) => { const r = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie: admin, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return {status: r.status, data: await r.json()}; };
  const created = await call('/sales', {workId: 1, report_key: 'DB-LARGE', kind: 'digital', description: '架空売上', quantity: 1, basis_reason: '架空の根拠', recognition_basis_id: 1,
    partner_id: 2, product_id: 1, period_from: '2026-08-01', period_to: '2026-08-31', sales_month: '2026-08', amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100});
  assert.ok(created.status < 300, JSON.stringify(created.data));
  const reports = (await call('/admin/tables/report_imports')).data;
  assert.ok(reports.omittedColumns.includes('raw_text'));
  assert.equal(reports.rows.find((row) => row.report_key === 'DB-LARGE').raw_text, '（大きな列のため表示を省略）');
  const artifacts = (await call('/admin/tables/workflow_raw_artifacts')).data;
  assert.deepEqual(['original_base64', 'extraction_json'].filter((column) => artifacts.omittedColumns.includes(column)), ['original_base64', 'extraction_json']);
  assert.ok(!(await call('/admin/tables/partners')).data.omittedColumns.length, '普通の表は省略しない');
});
