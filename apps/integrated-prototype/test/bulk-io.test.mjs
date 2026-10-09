import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {mapHeaders, planBulk, detectHeaderRow, parseCell} from '../src/bulk/bulk-validate.mjs';
import {BULK_ENTITIES} from '../src/bulk/bulk-entities.mjs';
import {importLimits} from '../src/import/limits.mjs';
import {detectEncoding, decodeText} from '../src/import/text-decode.mjs';

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  async function login(email) {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    return response.headers.get('set-cookie').split(';')[0];
  }
  const admin = await login('admin@openingnight.invalid');
  async function req(path, body, {cookie = admin, method, headers = {}} = {}) {
    const response = await app.request(`/api${path}`, {method: method || (body ? 'POST' : 'GET'), headers: {cookie, 'content-type': 'application/json', ...headers}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  }
  return {db, app, req, login};
}

// 出力された行（列キー）を、日本語見出しの表（アップロードと同じ形）へ
function asUpload(entity, rows) {
  const columns = BULK_ENTITIES[entity].columns;
  return {headers: columns.map((c) => c.header), rows: rows.map((row, index) => ({rowNo: index + 2, values: columns.map((c) => row[c.key] ?? '')}))};
}

test('exporting current partners and uploading them unchanged finds nothing to register', async (t) => {
  const f = await fixture({t});
  const exported = await f.req('/bulk/partners/rows');
  assert.equal(exported.status, 200);
  const preview = await f.req('/bulk/partners/preview', {fileName: '取引先.xlsx', ...asUpload('partners', exported.data.rows)});
  assert.equal(preview.status, 200);
  assert.equal(preview.data.summary.unchanged, exported.data.rows.length);
  assert.equal(preview.data.summary.insert, 0);
  assert.equal(preview.data.canCommit, false);
});

test('new partner rows are registered once; name changes need approval and are not applied', async (t) => {
  const f = await fixture({t});
  const exported = (await f.req('/bulk/partners/rows')).data.rows;
  const edited = exported.map((row) => (row.code === 'PT-STORE' ? {...row, name: '架空ストア（改名）'} : row));
  edited.push({code: 'PT-BULK-1', name: '架空の一括登録先', kind: '配信事業者', region: '全国'});
  const preview = (await f.req('/bulk/partners/preview', {fileName: '取引先.xlsx', ...asUpload('partners', edited)})).data;
  assert.equal(preview.summary.insert, 1);
  assert.equal(preview.summary.approval, 1);
  const renamed = preview.rows.find((row) => row.key === 'PT-STORE');
  assert.equal(renamed.action, 'approval');
  assert.deepEqual(renamed.changes.map((c) => [c.header, c.after]), [['名称', '架空ストア（改名）']]);
  assert.equal((await f.req('/bulk/partners/commit', {token: preview.token})).status, 400, 'confirmation is required');
  const committed = await f.req('/bulk/partners/commit', {token: preview.token, confirmed: true});
  assert.equal(committed.status, 200, JSON.stringify(committed.data));
  assert.equal(committed.data.batch.inserted_count, 1);
  assert.equal(committed.data.approvalRows.length, 1);
  const saved = await f.db.get("SELECT * FROM partners WHERE code='PT-BULK-1'");
  assert.equal(saved.kind, 'platform');
  assert.equal((await f.db.get("SELECT name FROM partners WHERE code='PT-STORE'")).name, '架空ストア');
  assert.ok(await f.db.get("SELECT 1 FROM audit_log WHERE action='bulk_create' AND entity_type='partners' AND entity_id='PT-BULK-1'"));
  assert.equal((await f.req('/bulk/partners/commit', {token: preview.token, confirmed: true})).status, 409, 'a preview commits only once');
  const again = (await f.req('/bulk/partners/preview', {fileName: '取引先.xlsx', ...asUpload('partners', edited)})).data;
  assert.equal(again.summary.insert, 0, 'the same file does not add the partner twice');
  assert.ok(again.previousBatch, 'the same content was registered before');
  await assert.rejects(() => f.db.run('DELETE FROM bulk_import_batches'), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
});

test('cell errors block the whole file and are reported per row and column', async (t) => {
  const f = await fixture({t});
  const upload = {headers: ['取引先コード', '名称', '区分', '地域', '参考_メモ', '不明な列'], rows: [
    {rowNo: 2, values: ['PT-OK', '正しい行', '劇場', '', 'x', 'y']},
    {rowNo: 3, values: ['PT-BAD', '', '映画館', '', '', '']},
    {rowNo: 4, values: ['PT-OK', '重複', 'その他', '', '', '']},
  ]};
  const preview = (await f.req('/bulk/partners/preview', {fileName: 'bad.csv', ...upload})).data;
  assert.deepEqual(preview.ignoredColumns, ['参考_メモ']);
  assert.deepEqual(preview.unknownColumns, ['不明な列']);
  assert.equal(preview.canCommit, false);
  const bad = preview.rows.find((row) => row.rowNo === 3);
  assert.deepEqual(bad.errors.map((e) => e.column).sort(), ['名称', '区分'].sort());
  assert.match(preview.rows.find((row) => row.rowNo === 4).errors[0].message, /2行目と同じキー/);
  assert.equal((await f.req('/bulk/partners/commit', {token: preview.token, confirmed: true})).status, 400);
  assert.equal(await f.db.get("SELECT 1 FROM partners WHERE code='PT-OK'"), null);
  const missing = await f.req('/bulk/partners/preview', {fileName: 'x.csv', headers: ['名称'], rows: [{rowNo: 2, values: ['a']}]});
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.data.details.missingColumns, ['取引先コード', '区分']);
});

test('works and products resolve codes; products get their allocation', async (t) => {
  const f = await fixture({t});
  const works = (await f.req('/bulk/works/preview', {fileName: 'w.xlsx', headers: ['作品コード', '案件コード', '作品名', '形式'], rows: [
    {rowNo: 2, values: ['WRK-BULK', 'PRJ-DEMO', '架空の一括作品', 'シリーズ']},
    {rowNo: 3, values: ['WRK-BAD', 'PRJ-NONE', '案件なし', '映画']},
  ]})).data;
  assert.equal(works.rows[1].errors[0].message, '案件コード「PRJ-NONE」は登録されていません');
  const onlyGood = (await f.req('/bulk/works/preview', {fileName: 'w.xlsx', headers: ['作品コード', '案件コード', '作品名', '形式'], rows: [{rowNo: 2, values: ['WRK-BULK', 'PRJ-DEMO', '架空の一括作品', 'シリーズ']}]})).data;
  assert.equal((await f.req('/bulk/works/commit', {token: onlyGood.token, confirmed: true})).status, 200);
  const products = (await f.req('/bulk/products/preview', {fileName: 'p.xlsx', headers: ['商品SKU', '商品名', '流通', '配賦先作品コード1', '配賦率1（%）', '配賦先作品コード2', '配賦率2（%）'], rows: [
    {rowNo: 2, values: ['SKU-BULK', '架空の共同商品', '配信', 'WRK-DEMO', '60', 'WRK-BULK', '40%']},
    {rowNo: 3, values: ['SKU-BAD', '合計が合わない', '配信', 'WRK-DEMO', '50', '', '']},
  ]})).data;
  assert.match(products.rows[1].errors[0].message, /合計を100%/);
  const good = (await f.req('/bulk/products/preview', {fileName: 'p.xlsx', headers: ['商品SKU', '商品名', '流通', '配賦先作品コード1', '配賦率1（%）', '配賦先作品コード2', '配賦率2（%）'], rows: [
    {rowNo: 2, values: ['SKU-BULK', '架空の共同商品', '配信', 'WRK-DEMO', '60', 'WRK-BULK', '40%']}]})).data;
  assert.equal((await f.req('/bulk/products/commit', {token: good.token, confirmed: true})).status, 200);
  const alloc = await f.db.all("SELECT pw.allocation_bps FROM product_works pw JOIN products p ON p.id=pw.product_id WHERE p.sku='SKU-BULK' ORDER BY pw.allocation_bps");
  assert.deepEqual(alloc.map((a) => a.allocation_bps), [4000, 6000]);
});

test('expenses: new rows require invoices; legacy duplicate protection and versioned update remain', async (t) => {
  const f = await fixture({t});
  const headers = ['経費ID', '案件コード', '作品コード', '取引先コード', '発生日', '計上月', '費目', '内容', '予算（円）', '実績税抜（円）', '税額（円）', '実績税込（円）'];
  const row = ['', 'PRJ-DEMO', 'WRK-DEMO', 'PT-STORE', '2026/9/1', '', '宣伝費', '架空の予告編', '300,000', '２５０，０００', '25000', ''];
  const first = (await f.req('/bulk/expenses/preview', {fileName: 'e.xlsx', headers, rows: [{rowNo: 2, values: row}]})).data;
  assert.equal(first.ok,false);assert.match(first.error,/請求書/);
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM expenses')).n,0);
  await f.db.run("INSERT INTO expenses(org_id,project_id,work_id,partner_id,incurred_on,accounting_month,category,description,budget_yen,actual_ex_tax,tax_amount,actual_inc_tax) SELECT 1,1,1,id,'2026-09-01','2026-09','宣伝費','架空の予告編',300000,250000,25000,275000 FROM partners WHERE org_id=1 AND code='PT-STORE'");
  const dup = (await f.req('/bulk/expenses/preview', {fileName: 'e.xlsx', headers, rows: [{rowNo: 2, values: row}]})).data;
  assert.equal(dup.canCommit, false);
  assert.match(dup.rows[0].errors[0].message, /同じ内容の経費が登録済み/);
  const saved = await f.db.get("SELECT * FROM expenses WHERE description='架空の予告編'");
  const wrongTax = (await f.req('/bulk/expenses/preview', {fileName: 'e.xlsx', headers, rows: [{rowNo: 2, values: [String(saved.id), 'PRJ-DEMO', 'WRK-DEMO', 'PT-STORE', '2026-09-01', '2026-09', '宣伝費', '架空の予告編', '300000', '260000', '26000', '999']}]})).data;
  assert.match(wrongTax.rows[0].errors[0].message, /税抜＋税額/);
  const change = (await f.req('/bulk/expenses/preview', {fileName: 'e.xlsx', headers, rows: [{rowNo: 2, values: [String(saved.id), 'PRJ-DEMO', 'WRK-DEMO', 'PT-STORE', '2026-09-01', '2026-09', '宣伝費', '架空の予告編', '300000', '260000', '26000', '']}]})).data;
  assert.equal(change.summary.update, 1);
  // プレビューの後に画面から同じ経費を修正すると、登録は全件止まる
  const patched = await f.req(`/expenses/${saved.id}`, {description: '架空の予告編（画面で修正）'}, {method: 'PATCH', headers: {'If-Match': String(saved.version)}});
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.equal((await f.req('/bulk/expenses/commit', {token: change.token, confirmed: true})).status, 409);
  assert.equal((await f.db.get('SELECT actual_ex_tax FROM expenses WHERE id=?', [saved.id])).actual_ex_tax, 250000);
});

test('production role cannot bulk register; spec and limits are published', async (t) => {
  const f = await fixture({t});
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req('/bulk/partners/rows', null, {cookie: production})).status, 403);
  assert.equal((await f.req('/bulk/partners/preview', {headers: ['取引先コード'], rows: [{rowNo: 2, values: ['x']}]}, {cookie: production})).status, 403);
  const entities = (await f.req('/bulk/entities')).data;
  assert.deepEqual(entities.entities.map((e) => e.entity), ['partners', 'projects', 'works', 'products', 'expenses']);
  assert.equal(entities.limits.bulkRows, 2000);
  assert.equal(importLimits('worker').bulkRows, 200);
});

test('pure helpers: headers, header row detection, select labels and encodings', () => {
  const mapping = mapHeaders('partners', ['取引先コード', ' 名 称 ', 'kind', '参考_名称']);
  assert.deepEqual([...mapping.columns.values()], ['code', 'name', 'kind']);
  assert.equal(detectHeaderRow('partners', [['取引先の一括登録'], [], ['取引先コード', '名称', '区分']]), 2);
  assert.equal(parseCell(BULK_ENTITIES.partners.columns[2], '配信事業者').value, 'platform');
  assert.equal(parseCell(BULK_ENTITIES.partners.columns[2], 'platform').value, 'platform');
  const plan = planBulk('partners', [{rowNo: 2, cells: {code: '', name: '', kind: '', region: ''}}], {existing: new Map()});
  assert.equal(plan.rows.length, 0, 'blank rows are skipped');
  const sjis = new Uint8Array([0x8a, 0xbf, 0x8e, 0x9a]); // 「漢字」
  assert.equal(detectEncoding(sjis), 'shift_jis');
  assert.equal(decodeText(sjis).text, '漢字');
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
  assert.deepEqual(decodeText(bom), {text: 'A', encoding: 'utf-8-bom'});
  assert.equal(decodeText(new TextEncoder().encode('売上')).encoding, 'utf-8');
});

test('template and current-data Excel files round-trip through the reader and preview', async (t) => {
  const {encodeReportXlsx} = await import('../src/xlsx-report.mjs');
  const {templateSheets, currentSheets} = await import('../src/bulk/bulk-template.mjs');
  const {readUpload} = await import('../src/bulk/bulk-read.mjs');
  const f = await fixture({t});
  const current = (await f.req('/bulk/partners/rows')).data;
  const template = readUpload('partners', encodeReportXlsx({sheets: templateSheets(current.spec)}), '取引先_テンプレート.xlsx');
  assert.equal(template.headerRowNo, 1);
  assert.deepEqual(template.meta, {entity: 'partners', version: current.spec.version, kind: 'template'});
  assert.equal(template.rows.length, 0);
  const exported = readUpload('partners', encodeReportXlsx({sheets: currentSheets(current.spec, current.rows)}), '取引先_現在.xlsx');
  assert.equal(exported.sheetName, '入力');
  assert.equal(exported.rows.length, current.rows.length);
  assert.ok(exported.rows.some((row) => row.values.includes('配信事業者')), 'select values are exported as Japanese labels');
  const preview = (await f.req('/bulk/partners/preview', {fileName: '取引先_現在.xlsx', headers: exported.headers, rows: exported.rows, meta: exported.meta})).data;
  assert.equal(preview.summary.unchanged, current.rows.length);
  assert.equal(preview.summary.error, 0);
  const wrongKind = await f.req('/bulk/works/preview', {fileName: 'x.xlsx', headers: exported.headers, rows: exported.rows, meta: exported.meta});
  assert.equal(wrongKind.status, 400);
  const sjisCsv = new Uint8Array([...new TextEncoder().encode('')]);
  assert.equal(sjisCsv.length, 0);
  const csv = readUpload('partners', new TextEncoder().encode('取引先コード,名称,区分\r\nPT-CSV,"架空,カンマ",劇場\r\n'), 'p.csv');
  assert.deepEqual(csv.rows[0].values, ['PT-CSV', '架空,カンマ', '劇場']);
});

test('after updating legacy expenses, only the rows just saved are read back (no other project data)', async (t) => {
  const f = await fixture({t});
  // 先に別の案件の経費を直接入れておく（最新の行になる）
  await f.db.run("INSERT INTO projects(org_id,code,title,status) VALUES(1,'PRJ-OTHER','架空の別案件','planning')");
  const other = await f.db.get("SELECT id FROM projects WHERE code='PRJ-OTHER'");
  const headers = ['経費ID', '案件コード', '作品コード', '取引先コード', '発生日', '計上月', '費目', '内容', '予算（円）', '実績税抜（円）', '税額（円）', '実績税込（円）'];
  const old=await f.db.get("INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,'2026-09-01','2026-09','宣伝費','更新前（架空）',1000,100,1100) RETURNING id");
  const preview = (await f.req('/bulk/expenses/preview', {fileName: 'e.xlsx', headers, rows: [{rowNo: 2, values: [String(old.id), 'PRJ-DEMO', 'WRK-DEMO', '', '2026-09-01', '', '宣伝費', '架空の登録行', '', '1000', '100', '']}]})).data;
  await f.db.run('INSERT INTO expenses(org_id,project_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax,created_by) VALUES(1,?,?,?,?,?,?,?,?,1)', [other.id, '2026-09-02', '2026-09', '秘密費目', '他案件の秘密の経費', 999000, 99900, 1098900]).catch(() => null);
  const committed = await f.req('/bulk/expenses/commit', {token: preview.token, confirmed: true});
  assert.equal(committed.status, 200, JSON.stringify(committed.data));
  assert.deepEqual(committed.data.saved.map((row) => row.description), ['架空の登録行']);
});

test('in the cloud (Worker) mode, a file that needs more statements than one D1 batch allows is stopped at preview with the row count to split into', async (t) => {
  const db = await openTestDb({t});
  const identity = {org_id: 1, user_id: 1, role: 'admin', email: 'admin@openingnight.invalid', expires_at: null};
  const app = createApp({db, mode: 'worker', authenticate: async () => identity});
  const headerNames = BULK_ENTITIES.products.columns.map((c) => c.header);
  const byKey = (n) => ({sku: `SKU-BULK-${n}`, name: `架空の商品${n}`, channel: '配信', alloc_work_1: 'WRK-DEMO', alloc_rate_1: '100'});
  const rowFor = (n) => BULK_ENTITIES.products.columns.map((c) => byKey(n)[c.key] ?? '');
  const rows = Array.from({length: 180}, (_, n) => ({rowNo: n + 2, values: rowFor(n)}));
  const response = await app.request('/api/bulk/products/preview', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({fileName: 'p.xlsx', headers: headerNames, rows})});
  const data = await response.json();
  assert.equal(response.status, 413, JSON.stringify(data).slice(0, 300));
  assert.match(data.error, /処理の数（480件）を超えます/);
  assert.match(data.error, /\d+行ずつ/);
});

test('codes used by projects or works the user cannot see are rejected without revealing their contents; duplicate new expense rows in one file are stopped', async (t) => {
  const f = await fixture({t});
  await f.db.run("INSERT INTO projects(org_id,code,title,status) VALUES(1,'PRJ-SECRET','架空の非公開案件','planning')");
  const secret = await f.db.get("SELECT id FROM projects WHERE code='PRJ-SECRET'");
  await f.db.run("INSERT INTO works(org_id,project_id,code,title,format) VALUES(1,?,'WRK-SECRET','架空の非公開作品','film')", [secret.id]);
  const editor = await f.login('editor@openingnight.invalid');
  const project = (await f.req('/bulk/projects/preview', {fileName: 'p.xlsx', headers: ['案件コード', '案件名', '状態', '予算（円）'], rows: [{rowNo: 2, values: ['PRJ-SECRET', '上書きしたい名前', '進行中', '']}]}, {cookie: editor})).data;
  assert.equal(project.rows[0].action, 'error');
  assert.equal(project.rows[0].before, null, 'the hidden project is not returned');
  assert.deepEqual(project.rows[0].changes, []);
  assert.match(project.rows[0].errors[0].message, /閲覧できない別の案件/);
  const work = (await f.req('/bulk/works/preview', {fileName: 'w.xlsx', headers: ['作品コード', '案件コード', '作品名', '形式', '売上見込（円）'], rows: [{rowNo: 2, values: ['WRK-SECRET', 'PRJ-DEMO', '同じコードの作品', '映画', '']}]}, {cookie: editor})).data;
  assert.equal(work.rows[0].action, 'error', 'stopped at preview instead of failing on commit');
  assert.match(work.rows[0].errors[0].message, /閲覧できない別の案件で使われています/);
  const headers = ['経費ID', '案件コード', '作品コード', '取引先コード', '発生日', '計上月', '費目', '内容', '予算（円）', '実績税抜（円）', '税額（円）', '実績税込（円）'];
  const same = ['', 'PRJ-DEMO', '', '', '2026-09-01', '', '宣伝費', '同じ行', '', '1000', '100', ''];
  const expenses = (await f.req('/bulk/expenses/preview', {fileName: 'e.xlsx', headers, rows: [{rowNo: 2, values: same}, {rowNo: 3, values: same}]})).data;
  assert.deepEqual(expenses.rows.map((row) => row.action), ['insert', 'error']);
  assert.match(expenses.rows[1].errors[0].message, /2行目と同じ内容/);
  assert.equal(expenses.canCommit, false);
});
