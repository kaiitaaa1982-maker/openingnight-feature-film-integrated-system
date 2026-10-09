// 受領原本の付け替え・作品ごとの分割（設計 §5）の試験。原本を作品なしで受け取る・登録前の付け替え・登録後の拒否・
// 商品コードの列／作品コードの列での分割（複数作品に配賦された商品を含む）・旧原本の引き継ぎ・新旧どちらの経路でも二重に取り込めないこと・
// 権限・D1 の上限（1文100値・1回480文）を確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {buildDefinition, defaultFields, guessPeriod} from '../src/import/wizard-model.mjs';

const HEADERS = ['作品CD', '商品ｺｰﾄﾞ', '配信区分', '対象月', '視聴/契約数', '単価(税抜)', '総額', 'PF手数料', '正味売上', '備考'];
const row = (work, sku, net, note = '') => [work, sku, 'TVOD', '2026/08', '1', net, net, '0', net, note];
const sheetOf = (data) => [['架空の配信報告（複数作品）', '', '', '', '', '', '', '', '', ''], HEADERS, ...data];
const HEADER_ROW = 2;

// 作品: 1 WRK-DEMO（案件1）・3 WRK-B（案件1）・4 WRK-C（案件3。編集担当に権限なし）
// 商品: 1 SKU-DIGI→作品1、3 SKU-B→作品3、4 SKU-SHARED→作品1 60%・作品3 40%、5 SKU-C→作品4、6 SKU-PACK-B（ビデオグラム）→作品3、7 SKU-HALF→作品1 50%・作品4 50%
async function seedMasters(db) {
  await db.batch([
    {sql: "INSERT INTO projects(id,org_id,code,title,status) VALUES (3,1,'PRJ-SPLIT','分割用の架空案件','active')"},
    {sql: "INSERT INTO works(id,org_id,project_id,code,title) VALUES (3,1,1,'WRK-B','二本目の架空作品'),(4,1,3,'WRK-C','権限外の架空作品')"},
    {sql: `INSERT INTO products(id,org_id,sku,name,channel) VALUES (3,1,'SKU-B','二本目の配信','digital'),(4,1,'SKU-SHARED','二本立ての配信','digital'),
      (5,1,'SKU-C','権限外の配信','digital'),(6,1,'SKU-PACK-B','二本目のパッケージ','package'),(7,1,'SKU-HALF','半分ずつの配信','digital')`},
    {sql: 'INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES (1,3,3,10000),(1,4,1,6000),(1,4,3,4000),(1,5,4,10000),(1,6,3,10000),(1,7,1,5000),(1,7,4,5000)'},
  ]);
}

async function fixture({t, mode = 'local', wrap = null} = {}) {
  const inner = await openTestDb({t});
  await seedMasters(inner);
  const db = wrap ? wrap(inner) : inner;
  const sheets = new Map();
  const extractDocument = async ({name, base64}) => {
    const bytes = Buffer.from(base64, 'base64');
    return {extractorName: 'test', extractorVersion: '1', rawSha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, name, documentType: 'workbook', status: 'extracted', text: '', sheets: [{name: 'Details', rows: sheets.get(bytes.toString('utf8'))}]};
  };
  const app = createApp({db, mode, extractDocument});
  const cookies = {};
  async function login(email) {
    if (!cookies[email]) {
      const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
      cookies[email] = response.headers.get('set-cookie').split(';')[0];
    }
    return cookies[email];
  }
  async function call(path, body, email = 'admin@openingnight.invalid') {
    const cookie = await login(email);
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  }
  const base64Of = (label) => Buffer.from(label).toString('base64');
  const hashOf = (label) => createHash('sha256').update(label).digest('hex');
  async function receive(label, data, {binding = null, email} = {}) {
    sheets.set(label, sheetOf(data));
    return call('/sales-import/files', {name: `${label}.xlsx`, base64: base64Of(label), binding}, email);
  }
  async function legacyUpload(label, data, workId = 1) {
    sheets.set(label, sheetOf(data));
    return call('/workflow/artifacts/extract', {kind: 'sales_report', workId, name: `${label}.xlsx`, base64: base64Of(label)});
  }
  return {db: inner, app, call, receive, legacyUpload, hashOf, sheets};
}

// 列対応の版（配信・架空配信）。resolvedProduct なら商品は「商品ID（照合）」の列から取る
async function mappingVersion(f, {resolvedProduct = false, productId = null, reportKey = 'SPLIT-202608', email} = {}) {
  const sample = [row('WRK-DEMO', 'SKU-DIGI', '1000')];
  const {fields} = defaultFields({headers: HEADERS, sampleRows: sample, productIds: productId ? [productId] : [], period: guessPeriod(HEADERS, sample), resolvedProduct});
  if (!resolvedProduct && !productId) fields.product_id = {mode: 'none', value: '', source: '', operands: ['', '']};
  fields.report_key = {mode: 'literal', value: reportKey, source: '', operands: ['', '']};
  fields.recognition_basis_id = {mode: 'literal', value: '2', source: '', operands: ['', '']};
  fields.basis_date = {mode: 'literal', value: '2026-09-05', source: '', operands: ['', '']};
  fields.basis_reason = {mode: 'literal', value: '月次報告を受領した月で計上', source: '', operands: ['', '']};
  fields.tax_amount = {mode: 'zero', value: '', source: '', operands: ['', '']};
  fields.amount_inc_tax = {mode: 'same_ex', value: '', source: '', operands: ['', '']};
  const built = buildDefinition(fields, {headers: HEADERS, partnerId: 2, autoKey: reportKey, resolvedProduct});
  assert.deepEqual(built.errors, []);
  let profile = (await f.call('/sales-import/context?partnerId=2&kind=digital', null, email)).data.profile;
  if (!profile) profile = {id: (await f.call('/mapping-profiles', {partnerId: 2, kind: 'digital', name: '架空配信｜配信'}, email)).data.profileId};
  const version = await f.call(`/mapping-profiles/${profile.id}/versions`, built.definition, email);
  assert.equal(version.status, 201, JSON.stringify(version.data));
  return version.data.mappingVersionId;
}

async function select(f, fileId, excludedRows = [], email) {
  const selection = await f.call(`/sales-import/files/${fileId}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW, excludedRows}, email);
  assert.equal(selection.status, 201, JSON.stringify(selection.data));
  return selection.data;
}

async function previewPartition(f, partition, versionId, email) {
  return f.call('/mapped-imports/preview', {workId: partition.workId, mappingVersionId: versionId, text: partition.csv, sourcePartitionId: partition.id}, email);
}

async function commitPartition(f, partition, versionId, email) {
  const preview = await previewPartition(f, partition, versionId, email);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.ok, true, JSON.stringify(preview.data.errors));
  return f.call('/sales-import/commit', {token: preview.data.token}, email);
}

const count = async (f, table) => Number((await f.db.get(`SELECT count(*) AS n FROM ${table}`)).n);

test('FR-REV-INTAKE-001 FR-REV-INTAKE-002 FR-REV-INTAKE-005 原本は作品を決めずに受け取れ、見られるのは受け取った人と管理者だけ。同じファイルは重ねて受け取らない', async (t) => {
  const f = await fixture({t});
  const received = await f.receive('unbound', [row('WRK-DEMO', 'SKU-DIGI', '1000')], {email: 'editor@openingnight.invalid'});
  assert.equal(received.status, 201, JSON.stringify(received.data));
  assert.equal(received.data.bindingId, null, '作品は決めていない');
  const fileId = received.data.fileId;
  const stored = await f.db.get('SELECT storage, original_base64, legacy_artifact_id, created_by FROM sales_source_files WHERE id=?', [fileId]);
  assert.equal(stored.storage, 'inline');
  assert.equal(stored.original_base64, Buffer.from('unbound').toString('base64'));
  assert.equal(stored.created_by, 2);
  assert.equal(await count(f, 'sales_source_bindings'), 0);

  const mine = await f.call(`/sales-import/files/${fileId}`, null, 'editor@openingnight.invalid');
  assert.equal(mine.status, 200);
  assert.equal(mine.data.binding, null);
  assert.equal(mine.data.canRebind, true);
  assert.equal(mine.data.file.extraction.sheets[0].name, 'Details');
  assert.equal((await f.call(`/sales-import/files/${fileId}`)).status, 200, '管理者は見られる');
  assert.equal((await f.call(`/sales-import/files/${fileId}`, null, 'production@openingnight.invalid')).status, 403);
  assert.equal((await f.call(`/sales-import/files/${fileId}`, null, 'outsider@other.invalid')).status, 404, '別組織には無い');

  const list = await f.call('/sales-import/files', null, 'editor@openingnight.invalid');
  assert.deepEqual(list.data.rows.map((item) => item.fileId), [fileId]);
  assert.equal(list.data.rows[0].binding, null);
  const context = await f.call('/sales-import/context?workId=1', null, 'editor@openingnight.invalid');
  assert.deepEqual(context.data.sourceFiles.map((item) => item.fileId), [fileId]);
  assert.deepEqual(context.data.pending, [], '旧方式の未登録一覧とは分ける');

  const lookup = await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('unbound')}`, null, 'editor@openingnight.invalid');
  assert.equal(lookup.data.file.id, fileId);
  assert.equal(lookup.data.file.complete, false);
  assert.equal(lookup.data.artifact, null);

  const again = await f.receive('unbound', [row('WRK-DEMO', 'SKU-DIGI', '1000')]);
  assert.equal(again.status, 409);
  assert.equal(again.data.details.fileId, fileId);
  assert.equal(await count(f, 'sales_source_files'), 1);

  assert.equal((await f.receive('prod', [row('WRK-DEMO', 'SKU-DIGI', '1')], {email: 'production@openingnight.invalid'})).status, 403);
  assert.equal((await f.receive('split-at-upload', [row('WRK-DEMO', 'SKU-DIGI', '1')], {binding: {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'}})).status, 400, '列で分けるのは見出しを確かめてから');
  assert.equal((await f.receive('no-permission', [row('WRK-C', 'SKU-C', '1')], {binding: {mode: 'single_work', workId: 4}, email: 'editor@openingnight.invalid'})).status, 403);
  await assert.rejects(f.db.run("UPDATE sales_source_files SET file_name='x' WHERE id=?", [fileId]), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  await assert.rejects(f.db.run('DELETE FROM sales_source_files WHERE id=?', [fileId]), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
});

test('FR-REV-INTAKE-012 FR-REV-INTAKE-015 FR-REV-INTAKE-018 FR-REV-INTAKE-032 登録の前は理由を書いて付け替えられ、版と監査が残る。登録したら付け替え・選択の変更・分け直しはできない', async (t) => {
  const f = await fixture({t});
  const editor = 'editor@openingnight.invalid';
  const received = await f.receive('rebind', [row('WRK-B', 'SKU-B', '2000'), row('WRK-B', 'SKU-B', '3000')], {binding: {mode: 'single_work', workId: 1}, email: editor});
  assert.equal(received.status, 201, JSON.stringify(received.data));
  const fileId = received.data.fileId;
  const selection = await select(f, fileId, [], editor);
  assert.equal((await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 3}, editor)).status, 400, '理由なしでは付け替えない');
  assert.equal((await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 4, reason: '権限外'}, editor)).status, 403);
  assert.equal((await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 1, reason: '同じ'}, editor)).data.unchanged, true);
  assert.equal((await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 3, reason: 'x', expectedVersion: 5}, editor)).status, 409, '読んだ版が古ければ止める');
  const rebound = await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 3, reason: '二本目の作品の報告だったため', expectedVersion: 1}, editor);
  assert.equal(rebound.status, 201, JSON.stringify(rebound.data));
  assert.equal(rebound.data.binding.versionNo, 2);
  assert.equal(rebound.data.binding.workTitle, '二本目の架空作品');
  const log = await f.db.get("SELECT detail_json FROM audit_log WHERE action='rebind_source' AND entity_id=?", [String(fileId)]);
  assert.deepEqual(JSON.parse(log.detail_json).before.workId, 1);
  assert.deepEqual(JSON.parse(log.detail_json).after.workId, 3);
  assert.equal(JSON.parse(log.detail_json).reason, '二本目の作品の報告だったため');
  const history = await f.call(`/sales-import/files/${fileId}`, null, editor);
  assert.deepEqual(history.data.bindings.map((item) => [item.versionNo, item.workId]), [[2, 3], [1, 1]], '前の版も残る');

  const versionId = await mappingVersion(f, {productId: 3, email: editor});
  const planned = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId, bindingId: rebound.data.binding.id, selectionId: selection.selectionId}, editor);
  assert.equal(planned.status, 200, JSON.stringify(planned.data));
  assert.equal(planned.data.saved, true);
  assert.equal(planned.data.partitions.length, 1);
  const [partition] = planned.data.partitions;
  assert.equal(partition.workId, 3);
  assert.equal(partition.csv, selection.canonicalCsv, '1つの作品への割り当ては選択版の表そのもの');
  assert.deepEqual(partition.amounts, {amountExTax: 5000, taxAmount: 0, amountIncTax: 5000, unknownAmountRows: 0});
  assert.equal((await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital'}, editor)).data.partitions[0].id, partition.id, '同じ分け方は作り直さない');
  assert.equal((await previewPartition(f, {...partition, workId: 1}, versionId, editor)).status, 403, '分割と違う作品では確かめない');
  assert.equal((await previewPartition(f, {...partition, csv: partition.csv.replace('2000', '2001')}, versionId, editor)).status, 409, '分割の記録と違う表は通さない');

  // 分割を作ってから付け替えると、古い分割のプレビューは通らない
  const stalePreview = await previewPartition(f, partition, versionId, editor);
  assert.equal(stalePreview.data.ok, true);
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 1, reason: 'いったん戻す'}, editor);
  assert.equal((await f.call('/sales-import/commit', {token: stalePreview.data.token}, editor)).status, 409, '付け替えたあとは古い分割を登録しない');
  assert.equal(await count(f, 'report_imports'), 0);
  assert.equal((await previewPartition(f, partition, versionId, editor)).status, 409);
  const back = await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 3, reason: 'やはり二本目'}, editor);
  assert.equal(back.data.binding.versionNo, 4);
  const fresh = (await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital'}, editor)).data.partitions[0];
  assert.notEqual(fresh.id, partition.id, '新しい割り当てで分け直す');
  const committed = await commitPartition(f, fresh, versionId, editor);
  assert.equal(committed.status, 200, JSON.stringify(committed.data));
  assert.deepEqual({total: committed.data.progress.total, committed: committed.data.progress.committed, complete: committed.data.progress.complete}, {total: 1, committed: 1, complete: true});
  const report = await f.db.get('SELECT work_id FROM report_imports WHERE id=?', [committed.data.reportId]);
  assert.equal(report.work_id, 3);

  const refused = await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 1, reason: '登録後に戻したい'}, editor);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /付け替えられません/);
  assert.equal((await f.call(`/sales-import/files/${fileId}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW}, editor)).status, 409);
  await assert.rejects(f.db.run("INSERT INTO sales_source_bindings(org_id,file_id,version_no,mode,project_id,work_id,reason,created_by) VALUES(1,?,5,'single_work',1,1,'直接',1)", [fileId]), (e) => e.dbError?.kind === 'raise' && /付け替えられません/.test(e.message));
  await assert.rejects(f.db.run('UPDATE sales_source_bindings SET reason=? WHERE file_id=?', ['書き換え', fileId]), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  await assert.rejects(f.db.run('DELETE FROM sales_source_commits'), (e) => e.dbError?.kind === 'raise' && /削除できません/.test(e.message));
  const detail = await f.call(`/sales-import/files/${fileId}`, null, editor);
  assert.equal(detail.data.canRebind, false);
  assert.equal(detail.data.progress.complete, true);
  assert.deepEqual((await f.call('/sales-import/files', null, editor)).data.rows, [], '登録し終えた原本は一覧に出ない');
  const result = await f.call(`/sales-import/reports/${committed.data.reportId}`, null, editor);
  assert.equal(result.data.source.fileId, fileId);
  assert.equal(result.data.source.bindingVersion, 4);
  assert.equal(result.data.split.mode, 'single_work');
  assert.equal(result.data.split.partitions.length, 1);
  assert.equal(result.data.split.bindingReason, 'やはり二本目');
});

test('FR-REV-INTAKE-008 FR-REV-INTAKE-009 FR-REV-INTAKE-012 FR-REV-INTAKE-013 FR-REV-INTAKE-014 FR-REV-INTAKE-029 FR-REV-INTAKE-032 商品コードの列で作品ごとに分ける: 照合できない値は推測せず、理由つきで除くまで保存しない。複数作品に配賦された商品は配賦率の高い作品へ置き、集計で按分する', async (t) => {
  const f = await fixture({t});
  const data = [
    row('WRK-DEMO', 'SKU-DIGI', '1000', '作品1'),
    row('WRK-B', 'SKU-B', '2000', '作品3'),
    row('WRK-DEMO', ' ＳＫＵ－ＳＨＡＲＥＤ ', '3000', '全角・空白つき'),
    row('WRK-B', 'SKU-B', '4000', '作品3'),
    row('WRK-?', 'SKU-UNKNOWN', '500', 'マスタにない'),
    row('WRK-?', '', '600', '空欄'),
    row('WRK-B', 'SKU-PACK-B', '700', '販路違い'),
  ];
  const received = await f.receive('split-product', data);
  assert.equal(received.status, 201, JSON.stringify(received.data));
  const fileId = received.data.fileId;
  const first = await select(f, fileId);
  assert.deepEqual(first.sourceRowNumbers, [3, 4, 5, 6, 7, 8, 9]);
  const versionId = await mappingVersion(f, {resolvedProduct: true});

  // 保存しない試し（列の選び直しのたびに割り当ての版を作らない）
  const dry = await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, binding: {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'}, kind: 'digital', mappingVersionId: versionId});
  assert.equal(dry.status, 200);
  assert.equal(dry.data.saved, false);
  assert.equal(dry.data.ok, false);
  assert.deepEqual(dry.data.unmatched.map((item) => [item.sourceRow, item.value]), [[7, 'SKU-UNKNOWN'], [8, ''], [9, 'SKU-PACK-B']]);
  assert.match(dry.data.unmatched[0].reason, /商品マスタにない/);
  assert.match(dry.data.unmatched[1].reason, /空欄/);
  assert.match(dry.data.unmatched[2].reason, /販路（ビデオグラム）が報告の種類（配信）と違います/);
  assert.equal(await count(f, 'sales_source_bindings'), 0, '試しでは割り当てを保存しない');
  assert.equal((await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, binding: {mode: 'by_product', productColumn: '無い列'}})).status, 400);

  const bound = await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'});
  assert.equal(bound.status, 201, JSON.stringify(bound.data));
  assert.equal(bound.data.binding.reason, '受け取ったときの割り当て', '最初の割り当ては理由を書かなくてよい');
  const blocked = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId});
  assert.equal(blocked.data.ok, false);
  assert.equal(blocked.data.saved, false);
  assert.equal(await count(f, 'sales_source_partitions'), 0, '照合できない行が残る間は分割を保存しない');

  const reasons = [{sourceRow: 7, reason: '商品マスタに無い商品。取引先に確認中'}, {sourceRow: 8, reason: '商品コードが空欄のため確認中'}, {sourceRow: 9, reason: 'ビデオグラムの行は別の報告で取り込む'}];
  const second = await select(f, fileId, reasons);
  assert.deepEqual(second.sourceRowNumbers, [3, 4, 5, 6]);
  assert.equal(second.versionNo, 2);
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId});
  assert.equal(split.status, 200, JSON.stringify(split.data));
  assert.equal(split.data.saved, true);
  assert.deepEqual(split.data.partitions.map((item) => [item.workId, item.sourceRowNumbers, item.amounts.amountExTax]), [[1, [3, 5], 4000], [3, [4, 6], 6000]]);
  const [p1, p3] = split.data.partitions;
  assert.deepEqual(p1.products.map((item) => [item.sku, item.rows, item.allocations.map((share) => [share.workId, share.bps])]), [['SKU-DIGI', 1, [[1, 10000]]], ['SKU-SHARED', 1, [[1, 6000], [3, 4000]]]]);
  assert.equal(p1.headers.at(-1), '商品ID（照合）');
  assert.match(p1.csv, /SKU-DIGI.*,1\r\n/);
  assert.match(p1.csv, /ＳＫＵ－ＳＨＡＲＥＤ.*,4$/, '元の値は変えずに、照合した商品IDを右端に足す');

  // 報告を置く作品は画面で変えられる（配賦先の作品の中だけ）。試しで確かめる
  const moved = await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, kind: 'digital', mappingVersionId: versionId, reportWorks: {4: 3}});
  assert.deepEqual(moved.data.partitions.map((item) => [item.workId, item.sourceRowNumbers]), [[1, [3]], [3, [4, 5, 6]]]);
  const ignored = await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, kind: 'digital', reportWorks: {4: 4}});
  assert.deepEqual(ignored.data.partitions.map((item) => item.workId), [1, 3], '配賦先でない作品は選べない');

  const c1 = await commitPartition(f, p1, versionId);
  assert.equal(c1.status, 200, JSON.stringify(c1.data));
  assert.deepEqual([c1.data.progress.total, c1.data.progress.committed, c1.data.progress.complete], [2, 1, false]);
  assert.equal(c1.data.progress.label, '2作品中1作品を登録済み');
  // 途中まで登録した状態: 割り当て・選択・分け方は変えられない
  assert.equal((await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_work_column', workColumn: '作品CD', reason: '途中で変えたい'})).status, 409);
  const locked = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId, reportWorks: {4: 3}});
  assert.equal(locked.data.locked, true, '登録を始めたら分け方は変わらない（続きから登録できるよう、始めた分け方を返す）');
  assert.deepEqual(locked.data.partitions.map((item) => [item.id, item.sourceRowNumbers, Boolean(item.committed)]), [[p1.id, [3, 5], true], [p3.id, [4, 6], false]]);
  assert.equal(locked.data.partitions[1].csv, p3.csv);
  assert.equal(locked.data.partitions[0].committed.reportId, c1.data.reportId);
  assert.equal((await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, binding: {mode: 'by_work_column', workColumn: '作品CD'}})).data.locked, true);
  const lookup = await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('split-product')}`);
  assert.equal(lookup.data.file.progressLabel, '2作品中1作品を登録済み');
  const pending = await f.call('/sales-import/files');
  assert.equal(pending.data.rows[0].progressLabel, '2作品中1作品を登録済み');
  // 同じ原本の別作品分は「重複」ではなく「同じ原本の別作品分」
  const p3Preview = await previewPartition(f, p3, versionId);
  assert.equal(p3Preview.data.ok, true, JSON.stringify(p3Preview.data.errors));
  const overlaps = await f.call(`/sales-import/overlaps?token=${p3Preview.data.token}`);
  assert.deepEqual(overlaps.data.overlaps, []);
  assert.deepEqual(overlaps.data.otherWorks, []);
  assert.deepEqual(overlaps.data.sameFile.map((item) => item.id), [c1.data.reportId]);
  const c3 = await f.call('/sales-import/commit', {token: p3Preview.data.token});
  assert.equal(c3.status, 200, JSON.stringify(c3.data));
  assert.equal(c3.data.progress.complete, true);

  const reports = await f.db.all('SELECT id, work_id, report_key FROM report_imports ORDER BY id');
  assert.deepEqual(reports.map((item) => item.work_id), [1, 3]);
  assert.deepEqual(reports.map((item) => item.report_key), ['SPLIT-202608', 'SPLIT-202608'], '同じ報告番号を作品ごとに持つ');
  const lines = await f.db.all('SELECT work_id, product_id, amount_ex_tax FROM sale_lines ORDER BY amount_ex_tax');
  assert.deepEqual(lines.map((item) => [item.work_id, item.product_id, item.amount_ex_tax]), [[1, 1, 1000], [3, 3, 2000], [1, 4, 3000], [3, 3, 4000]]);
  // 二本立ての商品（作品1 60%・作品3 40%）は集計で按分される
  assert.equal((await f.call('/analytics/income?workId=3')).data.sales.exTax, 2000 + 4000 + 1200);

  const result = await f.call(`/sales-import/reports/${c3.data.reportId}`);
  assert.equal(result.data.split.mode, 'by_product');
  assert.equal(result.data.split.productColumn, '商品ｺｰﾄﾞ');
  assert.deepEqual(result.data.split.partitions.map((item) => [item.workId, item.committed, item.current]), [[1, true, false], [3, true, true]]);
  assert.equal(result.data.exclusions.count, 3, '原本全体で取り込まなかった行');
  assert.equal(result.data.exclusions.scope, 'file');
  assert.equal(result.data.exclusions.rows[0].reason, '商品マスタに無い商品。取引先に確認中');
  const log = JSON.parse((await f.db.get("SELECT detail_json FROM audit_log WHERE action='sales_import' AND entity_id=?", [String(c3.data.reportId)])).detail_json);
  assert.equal(log.source.fileId, fileId);
  assert.equal(log.excluded.count, 3);
  assert.equal((await f.receive('split-product', data)).status, 409, '同じファイルは受け取り直せない');
});

test('FR-REV-INTAKE-012 FR-REV-INTAKE-013 作品コードの列で分ける: works.code と照合し（全角・空白を吸収）、無いコードは理由を示す。商品コードの列を併せると作品への配賦も確かめる', async (t) => {
  const f = await fixture({t});
  const data = [row('WRK-DEMO', 'SKU-DIGI', '1000'), row('ＷＲＫ－Ｂ', 'SKU-B', '2000'), row('WRK-ZZZ', 'SKU-B', '300'), row('WRK-B', 'SKU-DIGI', '400')];
  const fileId = (await f.receive('split-work', data)).data.fileId;
  await select(f, fileId);
  const plain = await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, binding: {mode: 'by_work_column', workColumn: '作品CD'}, kind: 'digital'});
  assert.deepEqual(plain.data.partitions.map((item) => [item.workId, item.sourceRowNumbers]), [[1, [3]], [3, [4, 6]]]);
  assert.deepEqual(plain.data.unmatched.map((item) => [item.sourceRow, item.value]), [[5, 'WRK-ZZZ']]);
  assert.match(plain.data.unmatched[0].reason, /作品マスタにない作品コード/);
  const withProduct = await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, binding: {mode: 'by_work_column', workColumn: '作品CD', productColumn: '商品ｺｰﾄﾞ'}, kind: 'digital'});
  assert.deepEqual(withProduct.data.unmatched.map((item) => item.sourceRow), [5, 6]);
  assert.match(withProduct.data.unmatched[1].reason, /商品が作品「WRK-B」に配賦されていません/);
  assert.equal((await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, binding: {mode: 'by_work_column', workColumn: '作品CD', productColumn: '作品CD'}})).status, 400);

  await select(f, fileId, [{sourceRow: 5, reason: '作品マスタに無いコード'}]);
  const bound = await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_work_column', workColumn: '作品CD'});
  assert.equal(bound.status, 201);
  const versionId = await mappingVersion(f);
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId});
  assert.equal(split.data.saved, true, JSON.stringify(split.data));
  assert.deepEqual(split.data.partitions.map((item) => [item.workId, item.amounts.amountExTax]), [[1, 1000], [3, 2400]]);
  assert.equal(split.data.partitions[0].headers.includes('商品ID（照合）'), false, '商品を照合しないときは列を足さない');
  for (const partition of split.data.partitions) assert.equal((await commitPartition(f, partition, versionId)).status, 200);
  const lines = await f.db.all('SELECT work_id, product_id, amount_ex_tax FROM sale_lines ORDER BY work_id, amount_ex_tax');
  assert.deepEqual(lines.map((item) => [item.work_id, item.product_id, item.amount_ex_tax]), [[1, null, 1000], [3, null, 400], [3, null, 2000]]);
});

test('FR-REV-INTAKE-004 旧方式の原本は、付け替えるときに参照行を作って引き継ぐ（中身は複製しない）。引き継いだ原本は旧経路で選び直し・登録できない', async (t) => {
  const f = await fixture({t});
  const legacy = await f.legacyUpload('legacy-a', [row('WRK-B', 'SKU-B', '2000')], 1);
  assert.equal(legacy.status, 201, JSON.stringify(legacy.data));
  const artifactId = legacy.data.artifactId;
  const legacySelection = await f.call(`/sales-import/artifacts/${artifactId}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW});
  assert.equal(legacySelection.status, 201);
  const legacyVersion = await mappingVersion(f, {productId: 1, reportKey: 'LEGACY-202608'});
  // 引き継ぐ前に旧経路で確かめておいた内容（あとで登録しようとしても止める）
  const oldPreview = await f.call('/mapped-imports/preview', {workId: 1, mappingVersionId: legacyVersion, text: legacySelection.data.canonicalCsv, workflowSelectionId: legacySelection.data.selectionId});
  assert.equal(oldPreview.data.ok, true, JSON.stringify(oldPreview.data));

  const lookup = await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('legacy-a')}`);
  assert.equal(lookup.data.artifact.id, artifactId);
  assert.equal(lookup.data.file, null);
  assert.equal((await f.receive('legacy-a', [row('WRK-B', 'SKU-B', '2000')])).status, 409, '新しい経路で同じファイルを受け取らない');
  assert.equal((await f.call('/sales-import/files/takeover', {artifactId, binding: {mode: 'single_work', workId: 3}})).status, 400, '付け替えには理由が要る');
  assert.equal((await f.call('/sales-import/files/takeover', {artifactId}, 'production@openingnight.invalid')).status, 403);
  const taken = await f.call('/sales-import/files/takeover', {artifactId, binding: {mode: 'single_work', workId: 3}, reason: '二本目の作品の報告だった'});
  assert.equal(taken.status, 201, JSON.stringify(taken.data));
  const fileId = taken.data.fileId;
  const stored = await f.db.get('SELECT storage, original_base64, extraction_json, legacy_artifact_id FROM sales_source_files WHERE id=?', [fileId]);
  assert.deepEqual({...stored}, {storage: 'legacy_artifact', original_base64: null, extraction_json: null, legacy_artifact_id: artifactId});
  const bindings = await f.db.all('SELECT version_no, work_id, reason FROM sales_source_bindings WHERE file_id=? ORDER BY version_no', [fileId]);
  assert.deepEqual(bindings.map((item) => [item.version_no, item.work_id]), [[1, 1], [2, 3]]);
  assert.match(bindings[0].reason, /旧方式の原本を引き継ぎ/);
  const copied = await f.db.get('SELECT version_no, legacy_selection_id, canonical_csv FROM sales_source_selections WHERE file_id=?', [fileId]);
  assert.equal(copied.legacy_selection_id, legacySelection.data.selectionId);
  assert.equal(copied.canonical_csv, legacySelection.data.canonicalCsv);
  assert.equal((await f.call('/sales-import/files/takeover', {artifactId})).data.existing, true, '引き継ぎは1回だけ');

  // 旧経路は止まる
  assert.equal((await f.call('/sales-import/commit', {token: oldPreview.data.token})).status, 409, '引き継ぐ前の確認でも登録しない');
  assert.equal(await count(f, 'report_imports'), 0);
  assert.equal((await f.call(`/sales-import/artifacts/${artifactId}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW})).status, 409);
  assert.equal((await f.call(`/workflow/reports/${artifactId}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW})).status, 409);
  assert.equal((await f.call('/mapped-imports/preview', {workId: 1, mappingVersionId: legacyVersion, text: legacySelection.data.canonicalCsv, workflowSelectionId: legacySelection.data.selectionId})).status, 409);
  assert.deepEqual((await f.call('/workflow/reports?workId=1')).data.rows, [], '旧方式の一覧から外す');
  assert.deepEqual((await f.call('/sales-import/context?workId=1')).data.pending, []);
  const lookupAfter = await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('legacy-a')}`);
  assert.equal(lookupAfter.data.file.id, fileId);

  // 新しい経路で続ける（原本の中身は旧原本から読む）
  const detail = await f.call(`/sales-import/files/${fileId}`);
  assert.equal(detail.data.file.extraction.sheets[0].rows.length, 3);
  assert.equal(detail.data.selection.legacySelectionId, legacySelection.data.selectionId);
  const selection = await select(f, fileId);
  assert.equal(selection.versionNo, 2);
  const versionId = await mappingVersion(f, {productId: 3, reportKey: 'TAKEN-202608'});
  const [partition] = (await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId})).data.partitions;
  assert.equal(partition.workId, 3);
  const committed = await commitPartition(f, partition, versionId);
  assert.equal(committed.status, 200, JSON.stringify(committed.data));
  assert.equal((await f.db.get('SELECT work_id FROM report_imports WHERE id=?', [committed.data.reportId])).work_id, 3);
  assert.equal(await count(f, 'workflow_report_commits'), 0, '旧経路の登録確定は作らない');
  assert.equal((await f.call(`/sales-import/reports/${committed.data.reportId}`)).data.source.fileName, 'legacy-a.xlsx');
});

test('FR-REV-INTAKE-002 FR-REV-INTAKE-004 FR-REV-INTAKE-018 二重取込の防止: 旧経路で登録した原本は引き継げず、新旧どちらの経路でも同じファイル・同じ分割を重ねて登録できない', async (t) => {
  const f = await fixture({t});
  // 新しい経路で受け取った原本は、旧経路で原本にできない
  const received = await f.receive('dup-new', [row('WRK-DEMO', 'SKU-DIGI', '1100')], {binding: {mode: 'single_work', workId: 1}});
  assert.equal(received.status, 201);
  const legacyAgain = await f.legacyUpload('dup-new', [row('WRK-DEMO', 'SKU-DIGI', '1100')], 1);
  assert.equal(legacyAgain.status, 409);
  assert.match(legacyAgain.data.error, /既に取り込まれています/);
  // 同時に保存された場合も、同じ batch の検査で止める（先に確かめた後で新しい経路に入ったとき）
  await assert.rejects(f.db.run("INSERT INTO sales_source_files(org_id,storage,file_name,byte_length,raw_sha256,original_base64,extraction_json,extractor_name,extractor_version,extraction_status,created_by) VALUES(1,'inline','x.xlsx',1,?,'eA==','{}','t','1','extracted',1)", [f.hashOf('dup-new')]), (e) => e.dbError?.kind === 'unique');

  // 旧経路で登録済みの原本は引き継げない（トリガーでも止める）
  const legacy = await f.legacyUpload('dup-old', [row('WRK-DEMO', 'SKU-DIGI', '1000')], 1);
  const artifactId = legacy.data.artifactId;
  const legacySelection = await f.call(`/sales-import/artifacts/${artifactId}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW});
  const legacyVersion = await mappingVersion(f, {productId: 1, reportKey: 'DUP-OLD'});
  const preview = await f.call('/mapped-imports/preview', {workId: 1, mappingVersionId: legacyVersion, text: legacySelection.data.canonicalCsv, workflowSelectionId: legacySelection.data.selectionId});
  assert.equal((await f.call('/sales-import/commit', {token: preview.data.token})).status, 200);
  assert.equal((await f.call('/sales-import/files/takeover', {artifactId})).status, 409);
  await assert.rejects(f.db.run("INSERT INTO sales_source_files(org_id,storage,file_name,byte_length,raw_sha256,extractor_name,extractor_version,extraction_status,legacy_artifact_id,created_by) VALUES(1,'legacy_artifact','x.xlsx',?,?,'t','1','extracted',?,1)", [Buffer.from('dup-old').length, f.hashOf('dup-old'), artifactId]), (e) => e.dbError?.kind === 'raise' && /引き継げない旧方式の原本/.test(e.message));
  assert.equal((await f.receive('dup-old', [row('WRK-DEMO', 'SKU-DIGI', '1000')])).status, 409, '旧経路で登録した原本は新しい経路でも受け取らない');
  await assert.rejects(f.db.run("INSERT INTO sales_source_files(org_id,storage,file_name,byte_length,raw_sha256,original_base64,extraction_json,extractor_name,extractor_version,extraction_status,created_by) VALUES(1,'inline','x.xlsx',1,?,'eA==','{}','t','1','extracted',1)", [f.hashOf('dup-old')]), (e) => e.dbError?.kind === 'raise' && /旧方式の原本として保存済み/.test(e.message));

  // 同じ分割は1回だけ登録できる（同じ確認で2回押しても、新しい確認を作っても）
  await select(f, received.data.fileId);
  const versionId = await mappingVersion(f, {productId: 1, reportKey: 'DUP-NEW'});
  const [partition] = (await f.call(`/sales-import/files/${received.data.fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId})).data.partitions;
  const first = await previewPartition(f, partition, versionId);
  const second = await previewPartition(f, partition, versionId);
  assert.equal(second.data.ok, true, JSON.stringify(second.data));
  const separate = {mode: 'separate', reason: '同じ月の別の報告として受領'};
  const firstCommit = await f.call('/sales-import/commit', {token: first.data.token, decision: separate});
  assert.equal(firstCommit.status, 200, JSON.stringify(firstCommit.data));
  assert.equal((await f.call('/sales-import/commit', {token: first.data.token, decision: separate})).status, 410);
  const again = await f.call('/sales-import/commit', {token: second.data.token, decision: separate});
  assert.equal(again.status, 409, JSON.stringify(again.data));
  assert.equal((await previewPartition(f, partition, versionId)).status, 409, '登録済みの分割は確かめ直さない');
  assert.equal(await count(f, 'sales_source_commits'), 1);
  assert.equal(Number((await f.db.get("SELECT count(*) n FROM report_imports WHERE report_key='DUP-NEW'")).n), 1);
});

test('FR-REV-INTAKE-015 FR-REV-INTAKE-018 分け方がそろっていない登録と、古い割り当て・選択の登録はトリガーで止める', async (t) => {
  const f = await fixture({t});
  const fileId = (await f.receive('plan-guard', [row('WRK-DEMO', 'SKU-DIGI', '1000'), row('WRK-DEMO', 'SKU-SHARED', '3000'), row('WRK-B', 'SKU-B', '2000')])).data.fileId;
  await select(f, fileId);
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'});
  const versionId = await mappingVersion(f, {resolvedProduct: true, reportKey: 'PLAN-GUARD'});
  const planA = (await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId})).data.partitions;
  const planB = (await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId, reportWorks: {4: 3}})).data.partitions;
  assert.equal(planA.length, 2);
  assert.equal(planB.length, 2);
  assert.notEqual(planA[1].id, planB[1].id, '分け方が違えば別の分割');
  const previewA1 = await previewPartition(f, planA[0], versionId);
  const previewB3 = await previewPartition(f, planB[1], versionId);
  assert.equal(previewA1.data.ok, true);
  assert.equal(previewB3.data.ok, true);
  assert.equal((await f.call('/sales-import/commit', {token: previewA1.data.token})).status, 200);
  const mixed = await f.call('/sales-import/commit', {token: previewB3.data.token});
  assert.equal(mixed.status, 409, '別の分け方の分割は登録しない');
  assert.equal(await count(f, 'sales_source_commits'), 1);
  assert.equal((await previewPartition(f, planB[1], versionId)).status, 409);
  const rest = await commitPartition(f, planA[1], versionId);
  assert.equal(rest.status, 200, JSON.stringify(rest.data));
  assert.equal(rest.data.progress.complete, true);
});

test('FR-REV-INTAKE-005 FR-REV-INTAKE-016 権限: 制作担当は使えない。権限のない作品に割り当たる行・配賦された商品を含む原本は分けられず、作品名も見せない', async (t) => {
  const f = await fixture({t});
  const editor = 'editor@openingnight.invalid';
  const production = 'production@openingnight.invalid';
  const fileId = (await f.receive('perm', [row('WRK-DEMO', 'SKU-DIGI', '1000'), row('WRK-DEMO', 'SKU-HALF', '2000')], {email: editor})).data.fileId;
  await select(f, fileId, [], editor);
  for (const [path, body] of [[`/sales-import/files/${fileId}`, null], ['/sales-import/files', null], [`/sales-import/files/${fileId}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW}],
    [`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'}], [`/sales-import/files/${fileId}/partitions`, {dryRun: true}], ['/sales-import/files/takeover', {artifactId: 1}]]) {
    assert.equal((await f.call(path, body, production)).status, 403, path);
  }
  const dry = await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, binding: {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'}, kind: 'digital'}, editor);
  assert.equal(dry.status, 200);
  assert.equal(dry.data.ok, false);
  assert.equal(dry.data.restrictedCount, 1, '半分を配賦した作品4に権限がない');
  assert.deepEqual(dry.data.partitions.map((item) => item.workId), [1]);
  assert.equal(dry.data.partitions[0].products.find((item) => item.sku === 'SKU-HALF').allocations.find((share) => share.workId === 4).workTitle, null, '権限のない作品名は出さない');
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'}, editor);
  const refused = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital'}, editor);
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /権限のない作品（1作品）/);
  assert.equal(await count(f, 'sales_source_partitions'), 0);

  // 管理者が分けた分割でも、編集担当は権限のない作品に配賦された商品の分を確かめられない
  const adminSplit = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital'});
  assert.equal(adminSplit.data.saved, true);
  const versionId = await mappingVersion(f, {resolvedProduct: true, reportKey: 'PERM'});
  assert.equal((await previewPartition(f, {...adminSplit.data.partitions[0]}, versionId, editor)).status, 403);
  // 作品4だけの原本: 編集担当は受け取った本人でも、作品4に分けた後は分割できない（別の原本で確かめる）
  const other = (await f.receive('perm-c', [row('WRK-C', 'SKU-C', '1')], {email: editor})).data.fileId;
  await select(f, other, [], editor);
  await f.call(`/sales-import/files/${other}/bindings`, {mode: 'by_work_column', workColumn: '作品CD'}, editor);
  assert.equal((await f.call(`/sales-import/files/${other}/partitions`, {}, editor)).status, 403);
  // 作品が決まった原本は、その作品すべての財務権限を持つ人（と管理者・受け取った人）だけが見られる
  const adminFile = (await f.receive('admin-own', [row('WRK-C', 'SKU-C', '1')], {binding: {mode: 'single_work', workId: 4}})).data.fileId;
  assert.equal((await f.call(`/sales-import/files/${adminFile}`, null, editor)).status, 403);
  const adminFile1 = (await f.receive('admin-own-1', [row('WRK-DEMO', 'SKU-DIGI', '1')], {binding: {mode: 'single_work', workId: 1}})).data.fileId;
  assert.equal((await f.call(`/sales-import/files/${adminFile1}`, null, editor)).status, 200, '作品1の財務権限があれば見られる');
  const unbound = (await f.receive('admin-unbound', [row('WRK-DEMO', 'SKU-DIGI', '2')])).data.fileId;
  assert.equal((await f.call(`/sales-import/files/${unbound}`, null, editor)).status, 403, '作品未定の原本は受け取った人と管理者だけ');
  assert.equal((await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('admin-unbound')}`, null, editor)).data.restricted, true);
  assert.ok(!(await f.call('/sales-import/files', null, editor)).data.rows.some((item) => item.fileId === unbound));
});

// D1 の上限（1つの問い合わせの値は100個まで・1回の batch は480文まで）を超えないことを、数を数える包みで確かめる
function limitChecking(inner) {
  const seen = {maxParams: 0, maxBatch: 0, queries: 0};
  const check = (params) => {
    seen.queries += 1;
    seen.maxParams = Math.max(seen.maxParams, params.length);
    if (params.length > 100) throw new Error(`D1 の上限（100値）を超えました: ${params.length}`);
  };
  return Object.assign(Object.create(inner), {
    seen,
    all: (sql, params = []) => { check(params); return inner.all(sql, params); },
    get: (sql, params = []) => { check(params); return inner.get(sql, params); },
    run: (sql, params = []) => { check(params); return inner.run(sql, params); },
    batch: (statements) => {
      seen.maxBatch = Math.max(seen.maxBatch, statements.length);
      if (statements.length > 480) throw new Error(`D1 の上限（480文）を超えました: ${statements.length}`);
      statements.forEach((statement) => check(statement.params || []));
      return inner.batch(statements);
    },
  });
}

test('D1 の上限: 150作品に分ける原本でも、1文の値は100個まで・1回の batch は480文まで', async (t) => {
  let wrapped;
  const f = await fixture({t, wrap: (inner) => (wrapped = limitChecking(inner))});
  const values = Array.from({length: 150}, (_, index) => `(${100 + index},1,1,'BULK-${index}','架空の一括作品${index}')`).join(',');
  await f.db.run(`INSERT INTO works(id,org_id,project_id,code,title) VALUES ${values}`);
  const data = Array.from({length: 150}, (_, index) => row(`BULK-${index}`, '', String(100 + index)));
  const fileId = (await f.receive('bulk', data)).data.fileId;
  await select(f, fileId);
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_work_column', workColumn: '作品CD'});
  const versionId = await mappingVersion(f, {reportKey: 'BULK'});
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId});
  assert.equal(split.status, 200, JSON.stringify(split.data).slice(0, 300));
  assert.equal(split.data.partitions.length, 150);
  assert.equal(await count(f, 'sales_source_partitions'), 150);
  for (const partition of split.data.partitions.slice(0, 3)) assert.equal((await commitPartition(f, partition, versionId)).status, 200);
  assert.equal((await f.call(`/sales-import/files/${fileId}`)).data.progress.label, '150作品中3作品を登録済み');
  assert.ok(wrapped.seen.maxBatch >= 152, `分割は1回の batch（${wrapped.seen.maxBatch}文）`);
  assert.ok(wrapped.seen.maxParams <= 100);
  // 1回の要求で使う問い合わせの数は、作品の数（150）に比例させない（D1 の1回の呼び出しあたりの上限のため）
  const editor = 'editor@openingnight.invalid';
  await f.call('/sales-import/limits', null, editor);
  for (const [path, body] of [[`/sales-import/files/${fileId}`, null], ['/sales-import/files', null], ['/sales-import/context', null],
    [`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId}], [`/sales-import/reports/${split.data.partitions[0].committed?.reportId ?? (await f.db.get('SELECT report_id FROM sales_source_commits LIMIT 1')).report_id}`, null]]) {
    wrapped.seen.queries = 0;
    const response = await f.call(path, body, editor);
    assert.equal(response.status, 200, `${path} ${JSON.stringify(response.data).slice(0, 200)}`);
    assert.ok(wrapped.seen.queries < 60, `${path}: 問い合わせ ${wrapped.seen.queries}回`);
  }
  assert.equal((await f.call('/sales-import/files', null, editor)).data.rows[0].progressLabel, '150作品中3作品を登録済み', '編集担当（全作品の財務権限あり）にも見える');
});
