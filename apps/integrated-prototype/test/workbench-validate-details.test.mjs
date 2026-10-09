// 表編集のサーバー側: 「全件を検証」の失敗を 422 と行の対応（inputRow）で返す、固定版を使い回す、行数上限を取込の上限にそろえる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerWorkbenchRoutes} from '../src/workbench.mjs';
import {mapRowErrors, gridColumns} from '../src/workbench-ui.mjs';

const fixture = async ({t} = {}) => {
  const db = await openTestDb({t});
  return {db, app: createApp({db, mode: 'local'})};
};
async function login(app, email = 'admin@openingnight.invalid') {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  return response.headers.get('set-cookie').split(';')[0];
}
const call = async (app, cookie, path, data, method = data ? 'POST' : 'GET') => {
  const response = await app.request(`/api/workbench${path}`, {method, headers: {cookie, ...(data ? {'content-type': 'application/json'} : {})}, body: data ? JSON.stringify(data) : undefined});
  return {status: response.status, body: await response.json()};
};
const saleRow = (extra = {}) => ({report_key: 'wp09-report', kind: 'digital', partner_id: 2, product_id: 1, period_from: '2026-09-01', period_to: '2026-09-30',
  accounting_month: '2026-09', description: '架空の配信', quantity: 1, amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100, ...extra});

test('「全件を検証」の行エラーは 422 で返り、各エラーに下書きの何行目か（inputRow）が付く', async (t) => {
  const {db, app} = await fixture({t});
  try {
    const cookie = await login(app);
    const rows = [saleRow(), saleRow({amount_inc_tax: 999}), saleRow({accounting_month: '2026-13'})];
    const draft = await call(app, cookie, '/drafts', {dataset: 'sales_import', workId: 1, rows});
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const validated = await call(app, cookie, `/drafts/${draft.body.draft.id}/validate`, {revision: 1});
    assert.equal(validated.status, 422, JSON.stringify(validated.body));
    assert.equal(validated.body.ok, false);
    assert.equal(validated.body.error, '売上取込の業務検証に失敗しました');
    assert.deepEqual(validated.body.details.map((d) => [d.rowNo, d.inputRow]), [[3, 2], [4, 3]]);
    // 画面の対応付け: 表の2行目の税込額、3行目の計上月
    const columns = gridColumns((await call(app, cookie, '/metadata')).body.datasets.find((d) => d.key === 'sales_import').columns, {dataset: 'sales_import'});
    const mapped = mapRowErrors(validated.body.details, {rows, columns});
    assert.deepEqual(mapped.items.map((item) => [item.gridRow, item.column]), [[2, 'amount_inc_tax'], [3, 'accounting_month']]);
    assert.equal(await db.get("SELECT COUNT(*) n FROM workbench_validations").then((r) => r.n), 0, '失敗した検証は保存しない');
  } finally {
    await db.close();
  }
});

test('加工手順で行が減っても、行エラーは下書きの元の行に結び付く', async (t) => {
  const {db, app} = await fixture({t});
  try {
    const cookie = await login(app);
    const rows = [saleRow({description: 'drop'}), saleRow({amount_inc_tax: 5})];
    const steps = [{operation: 'filter', parameters: {column: 'description', operator: 'neq', value: 'drop'}}];
    const draft = await call(app, cookie, '/drafts', {dataset: 'sales_import', workId: 1, rows, steps});
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const validated = await call(app, cookie, `/drafts/${draft.body.draft.id}/validate`, {revision: 1});
    assert.equal(validated.status, 422);
    assert.equal(validated.body.details[0].rowNo, 2, '取込CSVでは1件目');
    assert.equal(validated.body.details[0].inputRow, 2, '下書きでは2行目');
  } finally {
    await db.close();
  }
});

test('データセットを何度開いても、内容が同じなら固定版（スナップショット）を増やさない', async (t) => {
  const {db, app} = await fixture({t});
  try {
    const cookie = await login(app);
    const count = async () => (await db.get('SELECT COUNT(*) n FROM workbench_snapshots')).n;
    const first = await call(app, cookie, '/datasets/works?projectId=1');
    const afterFirst = await count();
    const second = await call(app, cookie, '/datasets/works?projectId=1');
    await call(app, cookie, '/datasets/partners');
    await call(app, cookie, '/datasets/partners');
    assert.equal(second.body.snapshot.id, first.body.snapshot.id);
    assert.equal(await count(), afterFirst + 1, '取引先の1件だけ増える');
    await db.run("UPDATE works SET title='架空の改題' WHERE org_id=1 AND id=1");
    const third = await call(app, cookie, '/datasets/works?projectId=1');
    assert.notEqual(third.body.snapshot.id, first.body.snapshot.id, '内容が変われば新しい固定版');
    // 別の利用者は自分の固定版を持つ（下書きの権限確認が作成者で行われるため）
    const editor = await login(app, 'editor@openingnight.invalid');
    const other = await call(app, editor, '/datasets/works?projectId=1');
    assert.notEqual(other.body.snapshot.id, third.body.snapshot.id);
    // 使い回した固定版から下書きを作って検証できる
    const rows = second.body.rows.map((row) => ({...row}));
    const draft = await call(app, cookie, '/drafts', {dataset: 'works', projectId: 1, sourceSnapshotId: second.body.snapshot.id, rows});
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
  } finally {
    await db.close();
  }
});

test('売上取込の行数上限は取込の共通上限にそろい、メタデータに編集範囲と上限の理由が出る', async (t) => {
  const {db, app} = await fixture({t});
  try {
    const cookie = await login(app);
    const meta = await call(app, cookie, '/metadata');
    const sales = meta.body.datasets.find((d) => d.key === 'sales_import');
    assert.equal(sales.scope, 'finance');
    assert.equal(meta.body.datasets.find((d) => d.key === 'partners').scope, 'org-admin');
    // app.mjs は createApp の mode を表編集へ渡す。ローカルは取込の共通上限（2,000行）
    assert.equal(sales.maxRows, 2000);
    assert.equal(meta.body.notes.salesImportMaxRows, 2000);
    const tooMany = await call(app, cookie, '/drafts', {dataset: 'sales_import', workId: 1, rows: Array.from({length: 2001}, () => saleRow())});
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /2000件以内|2,000件以内/);
  } finally {
    await db.close();
  }
  const local = new Hono();
  local.use('*', async (c, next) => { c.set('identity', {org_id: 1, user_id: 1, role: 'admin'}); await next(); });
  registerWorkbenchRoutes(local, {db: null, bad: (c, error, status = 400, details) => c.json({ok: false, error, details}, status), body: (c) => c.req.json(), mode: 'local'});
  const localMeta = await (await local.request('/api/workbench/metadata')).json();
  const worker = new Hono();
  worker.use('*', async (c, next) => { c.set('identity', {org_id: 1, user_id: 1, role: 'admin'}); await next(); });
  registerWorkbenchRoutes(worker, {db: null, bad: (c, error, status = 400, details) => c.json({ok: false, error, details}, status), body: (c) => c.req.json(), mode: 'worker'});
  const workerMeta = await (await worker.request('/api/workbench/metadata')).json();
  assert.equal(workerMeta.datasets.find((d) => d.key === 'sales_import').maxRows, 100, 'D1（Worker）は100行');
  const unset = new Hono();
  unset.use('*', async (c, next) => { c.set('identity', {org_id: 1, user_id: 1, role: 'admin'}); await next(); });
  registerWorkbenchRoutes(unset, {db: null, bad: (c, error, status = 400, details) => c.json({ok: false, error, details}, status), body: (c) => c.req.json()});
  assert.equal((await (await unset.request('/api/workbench/metadata')).json()).datasets.find((d) => d.key === 'sales_import').maxRows, 100, 'mode を渡さない登録は従来どおり（D1と同じ）');
  assert.equal(localMeta.datasets.find((d) => d.key === 'sales_import').maxRows, 2000);
  assert.equal(localMeta.notes.salesImportMaxRows, 2000);
  assert.match(localMeta.notes.salesImportLimitReason, /ローカル/);
});

test('原本ファイルの下書きは、開き直したときにシート名と見出し行を返し、同じ原本から新しい下書きを作れる', async (t) => {
  const db = await openTestDb({t});
  const sheet = {name: '報告', rows: [['架空の報告書'], ['report_key', 'amount_ex_tax'], ['R-1', '100']], formulaIssues: []};
  const app = createApp({db, mode: 'local', extractWorkbenchFile: async () => ({sheets: [sheet], sourceEncoding: 'utf-8'})});
  try {
    const cookie = await login(app);
    const extracted = await call(app, cookie, '/files/extract', {name: 'source.csv', base64: Buffer.from('x').toString('base64')});
    assert.equal(extracted.status, 200, JSON.stringify(extracted.body));
    const first = await call(app, cookie, '/drafts', {dataset: 'sales_import', workId: 1, sourceArtifactId: extracted.body.sourceArtifactId, sheetName: '報告', headerRow: 2});
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const opened = await call(app, cookie, `/drafts/${first.body.draft.id}`);
    assert.deepEqual(opened.body.draft.sourceScope, {sheetName: '報告', headerRow: 2});
    const again = await call(app, cookie, '/drafts', {dataset: 'sales_import', workId: 1, sourceArtifactId: extracted.body.sourceArtifactId, sheetName: opened.body.draft.sourceScope.sheetName, headerRow: opened.body.draft.sourceScope.headerRow, rows: opened.body.draft.rows});
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const plain = await call(app, cookie, '/drafts', {dataset: 'sales_import', workId: 1, rows: [saleRow()]});
    assert.equal((await call(app, cookie, `/drafts/${plain.body.draft.id}`)).body.draft.sourceScope, null);
  } finally {
    await db.close();
  }
});
