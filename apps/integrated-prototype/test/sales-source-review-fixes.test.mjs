// 受領原本の付け替え・分割（設計 §5）のレビュー指摘の回帰試験。
// F1 付け替えた本人が開けなくなる / F2 分割後の配賦の変更 / F3 分けた報告の取引先・種類の混在 / F4 未登録の原本の一覧の打ち切り /
// F5 作品の付け替えと固定の商品 / F6 クラウドの行数の上限は作品ごと / F7 大きさの上限はバイト数・大きな列は R2 へ /
// F8 作品コードの列で分けるときの商品の初期値 / F9 権限のない作品の題名を伏せる
// 組み立て（架空の原本・マスタ・列対応の版）は sales-source-review-fixture.mjs。F7 のクラウドの試験は、試験の DB の入口に R2 の層（R2LargeValueDatabase）をかぶせて両方の DB で流す
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  buildDefinition, defaultFields, guessPeriod, blankField, mappingFitsBinding, productChoicesFor, refitProductField, restrictedFileMessage, pendingListTitle,
} from '../src/import/wizard-model.mjs';
import {planKey, planPartitions, selectionTable, toCsvText, RESOLVED_PRODUCT_COLUMN} from '../src/import/source-partition.mjs';
import {fileAccess} from '../src/import/sales-source-store.mjs';
import {utf8Bytes, importLimits} from '../src/import/limits.mjs';
import {R2LargeValueDatabase} from '../src/cloud-r2-db.mjs';
import {HEADERS, row, HEADER_ROW, ADMIN, EDITOR, EDITOR2, EDITOR3, fixture, mappingVersion, select, previewPartition, commitPartition, count} from './sales-source-review-fixture.mjs';

// ---------- F1 ----------
test('FR-REV-INTAKE-005 F1: 受け取った人でない担当が列で分ける割り当てに付け替えても、本人は開いて分け続けられる。見られない理由は作品未定と権限なしで分ける', async (t) => {
  const f = await fixture({t});
  const fileId = (await f.receive('lock', [row('WRK-DEMO', 'SKU-DIGI', '1000'), row('WRK-B', 'SKU-B', '2000')], {binding: {mode: 'single_work', workId: 1}, email: EDITOR})).data.fileId;
  assert.equal((await f.call(`/sales-import/files/${fileId}`, null, EDITOR2)).status, 200, '作品1の財務権限があれば開ける');
  await select(f, fileId, [], EDITOR2);
  const rebind = await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ', reason: '2作品分が1ファイルで届いたため', expectedVersion: 1}, EDITOR2);
  assert.equal(rebind.status, 201, JSON.stringify(rebind.data));
  // 付け替えた本人は、分割を保存するまで作品が結び付かない間も開ける（以前は 403 で行き止まりになった）
  assert.equal((await f.call(`/sales-import/files/${fileId}`, null, EDITOR2)).status, 200);
  assert.deepEqual((await f.call('/sales-import/files', null, EDITOR2)).data.rows.map((item) => item.fileId), [fileId], '未登録の一覧にも出る');
  const lookup = await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('lock')}`, null, EDITOR2);
  assert.equal(lookup.data.file?.id, fileId);
  const versionId = await mappingVersion(f, {resolvedProduct: true, email: EDITOR2});
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId}, EDITOR2);
  assert.equal(split.status, 200, JSON.stringify(split.data));
  assert.equal(split.data.saved, true);
  assert.deepEqual(split.data.partitions.map((item) => item.workId), [1, 3]);
  // 作品未定の間、受け取った人でも付け替えた人でもない担当には開けない。理由は「作品未定のほかの人の原本」
  const other = await f.receive('unbound-other', [row('WRK-DEMO', 'SKU-DIGI', '5')], {email: EDITOR});
  assert.equal((await f.call(`/sales-import/files/${other.data.fileId}`, null, EDITOR3)).status, 403);
  const unbound = await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('unbound-other')}`, null, EDITOR3);
  assert.deepEqual([unbound.data.restricted, unbound.data.restrictedReason], [true, 'unbound']);
  assert.match(restrictedFileMessage('unbound'), /作品を決めないまま受け取った原本/);
  // 権限のない作品の原本は「権限なし」
  await f.receive('restricted', [row('WRK-C', 'SKU-C', '7')], {binding: {mode: 'single_work', workId: 4}});
  const restricted = await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('restricted')}`, null, EDITOR3);
  assert.deepEqual([restricted.data.restricted, restricted.data.restrictedReason], [true, 'restricted']);
  assert.match(restrictedFileMessage('restricted'), /権限のない作品の原本/);
});

// ---------- F2 ----------
test('FR-REV-INTAKE-016 F2: 分割のあとで商品の配賦に権限のない作品が足されたら、確かめる・登録するときはいまの配賦で権限を確かめて止める', async (t) => {
  const f = await fixture({t});
  const fileId = (await f.receive('stale', [row('WRK-DEMO', 'SKU-NEW', '1000'), row('WRK-DEMO', 'SKU-DIGI', '500')], {email: EDITOR})).data.fileId;
  await select(f, fileId, [], EDITOR);
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'}, EDITOR);
  const versionId = await mappingVersion(f, {resolvedProduct: true, email: EDITOR});
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId}, EDITOR);
  assert.equal(split.data.saved, true);
  const re = await f.call('/product-works', {productId: 8, allocations: [{workId: 1, allocationBps: 5000}, {workId: 4, allocationBps: 5000}], baseAllocations: [{workId: 1, allocationBps: 10000}]});
  assert.equal(re.status, 200, JSON.stringify(re.data));
  const preview = await previewPartition(f, split.data.partitions[0], versionId, EDITOR);
  assert.equal(preview.status, 403, JSON.stringify(preview.data));
  assert.match(preview.data.error, /権限のない作品にも配賦/);
  const fresh = await f.call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, kind: 'digital', mappingVersionId: versionId}, EDITOR);
  assert.equal(fresh.data.restrictedCount, 1);
  assert.equal(await count(f, 'sales_source_commits'), 0);
  assert.equal(await count(f, 'sale_lines'), 0, '権限のない作品へ按分される売上は登録していない');
});

test('FR-REV-INTAKE-028 F2: 配賦が変わった分割は、登録を始める前なら今の配賦で分け直させる（分け直すと新しい写しの分割を作る）', async (t) => {
  const f = await fixture({t});
  const fileId = (await f.receive('realloc', [row('WRK-DEMO', 'SKU-NEW', '1000'), row('WRK-DEMO', 'SKU-DIGI', '500')], {email: EDITOR})).data.fileId;
  await select(f, fileId, [], EDITOR);
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'}, EDITOR);
  const versionId = await mappingVersion(f, {resolvedProduct: true, email: EDITOR});
  const first = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId}, EDITOR);
  // 権限のある作品どうしで配賦し直す（作品1 50%・作品3 50%）。置く作品は同率なので作品1のまま（行の分け方は同じ）
  assert.equal((await f.call('/product-works', {productId: 8, allocations: [{workId: 1, allocationBps: 5000}, {workId: 3, allocationBps: 5000}], baseAllocations: [{workId: 1, allocationBps: 10000}]})).status, 200);
  const stale = await previewPartition(f, first.data.partitions[0], versionId, EDITOR);
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /商品の作品配賦が変わりました/);
  const again = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId}, EDITOR);
  assert.equal(again.data.saved, true);
  assert.notEqual(again.data.planHash, first.data.planHash, '配賦が変われば分け方の照合値も変わる');
  assert.notEqual(again.data.partitions[0].id, first.data.partitions[0].id, '古い写しの分割を使い続けない');
  const stored = JSON.parse((await f.db.get('SELECT product_map_json FROM sales_source_partitions WHERE id=?', [again.data.partitions[0].id])).product_map_json);
  assert.deepEqual(stored.find((item) => item.productId === 8).allocations, [{workId: 1, bps: 5000}, {workId: 3, bps: 5000}]);
  assert.equal((await commitPartition(f, again.data.partitions[0], versionId, EDITOR)).status, 200);
});

test('FR-REV-INTAKE-016 F2: 登録の batch は、確かめたときの配賦先の作品の範囲から外れていれば止める（登録のAPIを直接呼んでも）', async (t) => {
  const f = await fixture({t});
  // 商品を使わない列対応（行に商品IDが無いので、マスタの照合値には配賦が入らない）でも、分割の商品の配賦は batch で確かめる
  const fileId = (await f.receive('guard', [row('WRK-DEMO', 'SKU-NEW', '1000')], {email: EDITOR})).data.fileId;
  await select(f, fileId, [], EDITOR);
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'}, EDITOR);
  const versionId = await mappingVersion(f, {email: EDITOR, resolvedProduct: true, productNone: true});
  // 画面は商品コードの列で分けるとき「行ごとに照合」を求める（mappingFitsBinding）が、APIは列対応の商品の取り方を問わない
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId}, EDITOR);
  assert.equal(split.data.saved, true, JSON.stringify(split.data));
  const preview = await previewPartition(f, split.data.partitions[0], versionId, EDITOR);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  // 確かめたあと、登録の前に権限のない作品へ配賦が足される
  await f.db.batch([
    {sql: 'DELETE FROM product_works WHERE org_id=1 AND product_id=8'},
    {sql: 'INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES (1,8,1,5000),(1,8,4,5000)'},
  ]);
  const commit = await f.call('/mapped-imports/commit', {token: preview.data.token}, EDITOR);
  assert.notEqual(commit.status, 200, JSON.stringify(commit.data));
  assert.equal(await count(f, 'sales_source_commits'), 0);
  assert.equal(await count(f, 'report_imports'), 0);
});

test('F2: 分け方の照合値は、商品の配賦（作品と率）が変われば変わる', () => {
  const table = selectionTable(toCsvText([['商品', '金額'], ['SKU-A', '100']]), [3]);
  const binding = {mode: 'by_product', workId: null, productColumn: '商品', workColumn: null};
  const products = [{id: 10, sku: 'SKU-A', name: 'A', channel: 'digital'}];
  const works = [{id: 1, project_id: 1, code: 'A', title: 'A'}, {id: 2, project_id: 1, code: 'B', title: 'B'}];
  const before = planPartitions({table, binding, products, allocations: [{product_id: 10, work_id: 1, allocation_bps: 10000}], works});
  const after = planPartitions({table, binding, products, allocations: [{product_id: 10, work_id: 1, allocation_bps: 5000}, {product_id: 10, work_id: 2, allocation_bps: 5000}], works});
  assert.deepEqual(before.partitions.map((item) => [item.workId, item.sourceRows]), after.partitions.map((item) => [item.workId, item.sourceRows]), '行の分け方は同じ');
  assert.notEqual(planKey(binding, before.partitions), planKey(binding, after.partitions));
});

// ---------- F3 ----------
test('FR-REV-INTAKE-040 F3: 1つの原本から分けた報告は、最初の登録と同じ取引先・報告の種類でしか登録できない（画面の確認・登録・トリガー）', async (t) => {
  const f = await fixture({t});
  const fileId = (await f.receive('mix', [row('WRK-DEMO', 'SKU-DIGI', '1000'), row('WRK-B', 'SKU-B', '2000')])).data.fileId;
  await select(f, fileId);
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'});
  const v2 = await mappingVersion(f, {resolvedProduct: true, partnerId: 2});
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: v2});
  const [p1, p3] = split.data.partitions;
  assert.equal((await commitPartition(f, p1, v2, ADMIN, {kind: 'digital', partnerId: 2})).status, 200);
  // 続きを開くと、登録条件（取引先・報告の種類・列対応の版）が返る
  const detail = await f.call(`/sales-import/files/${fileId}`);
  assert.deepEqual({partnerId: detail.data.commitTerms.partnerId, kind: detail.data.commitTerms.kind, mappingVersionId: detail.data.commitTerms.mappingVersionId, partnerName: detail.data.commitTerms.partnerName},
    {partnerId: 2, kind: 'digital', mappingVersionId: v2, partnerName: '架空配信'});
  assert.equal((await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('mix')}`)).data.file.commitTerms.partnerId, 2);
  // 手順1で別の取引先（架空ストア）を選んで続けると、確かめる段階で止める
  const v3 = await mappingVersion(f, {resolvedProduct: true, partnerId: 3, reportKey: 'OTHER-KEY'});
  const other = await previewPartition(f, p3, v3);
  assert.equal(other.status, 409, JSON.stringify(other.data));
  assert.match(other.data.error, /取引先「架空配信」.*同じ取引先・報告の種類/);
  // 同じ取引先なら、列対応の版が違っても続けられる（列の直しは許す）
  const v2b = await mappingVersion(f, {resolvedProduct: true, partnerId: 2, reportKey: 'SPLIT-202608-B'});
  assert.equal((await commitPartition(f, p3, v2b, ADMIN, {kind: 'digital', partnerId: 2})).status, 200);
  const reports = await f.db.all('SELECT r.partner_id, r.kind FROM report_imports r JOIN sales_source_commits x ON x.report_id=r.id ORDER BY r.id');
  assert.deepEqual(reports.map((item) => [item.partner_id, item.kind]), [[2, 'digital'], [2, 'digital']]);
});

test('FR-REV-INTAKE-040 F3: 取引先・種類の違う報告の分割の登録は、APIを通さなくてもトリガーで止める', async (t) => {
  const f = await fixture({t});
  const fileId = (await f.receive('mix-trigger', [row('WRK-DEMO', 'SKU-DIGI', '1000'), row('WRK-B', 'SKU-B', '2000')])).data.fileId;
  await select(f, fileId);
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'});
  const v2 = await mappingVersion(f, {resolvedProduct: true, partnerId: 2});
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: v2});
  const [p1, p3] = split.data.partitions;
  assert.equal((await commitPartition(f, p1, v2)).status, 200);
  const p3row = await f.db.get('SELECT * FROM sales_source_partitions WHERE id=?', [p3.id]);
  // 報告と分割の登録を1つのトランザクションで入れる（登録の batch と同じ。報告の ID は同じ batch の中で報告の照合値から引く）
  const insertOther = (partnerId, kind, key) => {
    const hash = createHash('sha256').update(key).digest('hex');
    return f.db.batch([
      {sql: "INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,created_by) VALUES(1,3,?,?,?,'2026-08-01','2026-08-31','2026-09','x',?,1)", params: [partnerId, key, kind, hash]},
      {sql: "INSERT INTO sales_source_commits(org_id,file_id,partition_id,binding_id,selection_id,work_id,mapping_version_id,report_id,preview_token,created_by) VALUES(1,?,?,?,?,3,?,(SELECT id FROM report_imports WHERE org_id=1 AND report_key=? AND content_hash=?),?,1)",
        params: [fileId, p3.id, p3row.binding_id, p3row.selection_id, v2, key, hash, `t-${key}`]},
    ]);
  };
  const mixed = (e) => e.dbError?.kind === 'raise' && /最初の登録と同じ取引先・報告の種類/.test(e.message);
  await assert.rejects(insertOther(3, 'digital', 'K-PARTNER'), mixed);
  await assert.rejects(insertOther(2, 'package', 'K-KIND'), mixed);
  await insertOther(2, 'digital', 'K-SAME');
  assert.equal(await count(f, 'sales_source_commits'), 2, '同じ取引先・種類なら入る');
});

// ---------- F4 ----------
test('FR-REV-INTAKE-032 F4: 未登録の原本の一覧は、見られない原本・登録済みの原本が新しい側に多くても、古い未登録の原本を落とさない。総数も返す', async (t) => {
  const f = await fixture({t});
  const mine = (await f.receive('mine', [row('WRK-DEMO', 'SKU-DIGI', '1000')], {binding: {mode: 'single_work', workId: 1}, email: EDITOR})).data.fileId;
  // 管理者が作品未定のまま受け取った原本（編集担当には見えない）が60件
  const values = [];
  for (let n = 0; n < 60; n += 1) values.push(`(${1000 + n},1,'inline','admin-${n}.xlsx',NULL,1,'${createHash('sha256').update(`admin-${n}`).digest('hex')}','eA==','{"sheets":[]}','test','1','extracted',NULL,1)`);
  await f.db.run(`INSERT INTO sales_source_files(id,org_id,storage,file_name,media_type,byte_length,raw_sha256,original_base64,extraction_json,extractor_name,extractor_version,extraction_status,legacy_artifact_id,created_by) VALUES ${values.join(',')}`);
  const list = await f.call('/sales-import/files', null, EDITOR);
  assert.deepEqual(list.data.rows.map((item) => item.fileId), [mine]);
  assert.equal(list.data.total, 1);
  const context = await f.call('/sales-import/context?workId=1', null, EDITOR);
  assert.deepEqual(context.data.sourceFiles.map((item) => item.fileId), [mine]);
  assert.equal(context.data.sourceFilesTotal, 1);
  // 管理者には61件あり、手順1には新しい10件と総数を出す
  const adminContext = await f.call('/sales-import/context?workId=1');
  assert.equal(adminContext.data.sourceFiles.length, 10);
  assert.equal(adminContext.data.sourceFilesTotal, 61);
  assert.equal(adminContext.data.pendingTotal, 0);
  assert.equal(pendingListTitle({shown: 10, total: 61}), '受け取ったまま登録し終えていない原本（全61件。新しい10件を表示）');
  assert.equal(pendingListTitle({shown: 2, total: 2}), '受け取ったまま登録し終えていない原本（2件）');
});

test('FR-REV-INTAKE-032 F4: 一覧は登録し終えた原本を除き、途中の原本は残す。見られるかは原本の詳細と同じ基準', async (t) => {
  const f = await fixture({t});
  const versionId = await mappingVersion(f, {resolvedProduct: true});
  // 登録し終えた原本（作品3）と、2作品中1作品を登録した原本（作品1だけ登録。重なる報告にならないよう作品を分ける）
  const done = (await f.receive('done', [row('WRK-B', 'SKU-B', '100')], {binding: {mode: 'single_work', workId: 3}, email: EDITOR})).data.fileId;
  const half = (await f.receive('half', [row('WRK-DEMO', 'SKU-DIGI', '100'), row('WRK-B', 'SKU-B', '200')], {email: EDITOR})).data.fileId;
  const singleVersion = await mappingVersion(f, {productId: 3, reportKey: 'DONE-1'});
  await select(f, done);
  const doneSplit = await f.call(`/sales-import/files/${done}/partitions`, {kind: 'digital', mappingVersionId: singleVersion});
  assert.equal((await commitPartition(f, doneSplit.data.partitions[0], singleVersion)).status, 200);
  await select(f, half);
  await f.call(`/sales-import/files/${half}/bindings`, {mode: 'by_product', productColumn: '商品ｺｰﾄﾞ'});
  const halfSplit = await f.call(`/sales-import/files/${half}/partitions`, {kind: 'digital', mappingVersionId: versionId});
  assert.equal((await commitPartition(f, halfSplit.data.partitions[0], versionId)).status, 200);
  const restricted = (await f.receive('work4', [row('WRK-C', 'SKU-C', '1')], {binding: {mode: 'single_work', workId: 4}})).data.fileId;
  const adminUnbound = (await f.receive('admin-unbound', [row('WRK-DEMO', 'SKU-DIGI', '3')])).data.fileId;
  const adminWork1 = (await f.receive('admin-work1', [row('WRK-DEMO', 'SKU-DIGI', '4')], {binding: {mode: 'single_work', workId: 1}})).data.fileId;
  const all = [done, half, restricted, adminUnbound, adminWork1];
  for (const email of [ADMIN, EDITOR, EDITOR2]) {
    const listed = (await f.call('/sales-import/files', null, email)).data.rows;
    const identity = {...(await f.db.get('SELECT u.id AS user_id, m.org_id, m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=?', [email]))};
    const ctx = {db: f.db, permittedProjects: f.app.ux.permittedProjects};
    const expected = [];
    for (const id of all) if (id !== done && (await fileAccess(ctx, identity, await f.db.get('SELECT * FROM sales_source_files WHERE id=?', [id]))).allowed) expected.push(id);
    assert.deepEqual(listed.map((item) => item.fileId).sort((a, b) => a - b), expected.sort((a, b) => a - b), email);
  }
  const halfRow = (await f.call('/sales-import/files', null, EDITOR)).data.rows.find((item) => item.fileId === half);
  assert.equal(halfRow.progressLabel, '2作品中1作品を登録済み');
});

// ---------- F5 ----------
test('F5: 1つの作品へ付け替えると、手順3で固定した商品が新しい作品に結び付いていなければ分割の前に理由を示して止める', async (t) => {
  const f = await fixture({t});
  const fileId = (await f.receive('rebind-product', [row('WRK-B', 'SKU-B', '2000'), row('WRK-B', 'SKU-B', '3000')], {binding: {mode: 'single_work', workId: 1}, email: EDITOR})).data.fileId;
  await select(f, fileId, [], EDITOR);
  const fixed = await mappingVersion(f, {productId: 1, email: EDITOR});
  assert.equal((await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 3, reason: '二本目の作品の報告だったため', expectedVersion: 1}, EDITOR)).status, 201);
  const blocked = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: fixed}, EDITOR);
  assert.equal(blocked.data.ok, false);
  assert.equal(blocked.data.saved, false);
  assert.ok(blocked.data.errors.some((message) => /デジタル視聴.*二本目の架空作品.*結び付いていません/.test(message)), JSON.stringify(blocked.data.errors));
  assert.equal(await count(f, 'sales_source_partitions'), 0);
  // 新しい作品の商品で列対応を作り直せば、分けて確かめられる
  const refit = await mappingVersion(f, {productId: 3, email: EDITOR, reportKey: 'REBIND-2'});
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: refit}, EDITOR);
  assert.equal(split.data.saved, true, JSON.stringify(split.data.errors));
  const preview = await previewPartition(f, split.data.partitions[0], refit, EDITOR);
  assert.equal(preview.data.ok, true, JSON.stringify(preview.data.errors));
});

test('F5: 手順4の割り当ての確認と、手順3の商品の選び直し（画面の論理）', () => {
  const products = [{id: 1, sku: 'SKU-DIGI', name: 'デジタル視聴', channel: 'digital'}, {id: 2, sku: 'SKU-PACK', name: 'パッケージ', channel: 'package'},
    {id: 3, sku: 'SKU-B', name: '二本目の配信', channel: 'digital'}, {id: 4, sku: 'SKU-SHARED', name: '二本立て', channel: 'digital'}];
  const allocations = [{product_id: 1, work_id: 1}, {product_id: 2, work_id: 1}, {product_id: 3, work_id: 3}, {product_id: 4, work_id: 1}, {product_id: 4, work_id: 3}];
  const works = [{id: 1, title: '風のあとさき'}, {id: 3, title: '二本目の架空作品'}, {id: 5, title: '商品の無い作品'}];
  const masters = {products, allocations, kind: 'digital', works};
  assert.deepEqual(productChoicesFor({...masters, workId: 3}).map((item) => item.id), [3, 4]);
  assert.deepEqual(productChoicesFor({...masters, workId: 1}).map((item) => item.id), [1, 4], '販路の違う商品は選べない');
  const literal = (id) => ({mappings: [{target: 'product_id', mode: 'literal', valueType: 'integer', value: String(id)}], ignoredColumns: [RESOLVED_PRODUCT_COLUMN]});
  assert.match(mappingFitsBinding(literal(1), {mode: 'single_work', workId: 3}, masters), /デジタル視聴」は、作品「二本目の架空作品」に結び付いていません/);
  assert.equal(mappingFitsBinding(literal(4), {mode: 'single_work', workId: 3}, masters), null, '両方の作品に配賦された商品は付け替えても使える');
  assert.equal(mappingFitsBinding(literal(1), {mode: 'single_work', workId: 3}), null, 'マスタを渡さなければ前と同じ判定');
  // 付け替えた先の作品の商品で選び直す
  const one = refitProductField({...blankField('literal'), value: '1'}, productChoicesFor({...masters, workId: 3}).slice(0, 1));
  assert.deepEqual([one.field.mode, one.field.value], ['literal', '3']);
  assert.match(one.note, /1つだけ/);
  const many = refitProductField({...blankField('literal'), value: '1'}, productChoicesFor({...masters, workId: 3}));
  assert.deepEqual([many.field.mode, many.field.value], ['literal', '']);
  const none = refitProductField({...blankField('literal'), value: '1'}, productChoicesFor({...masters, workId: 5}));
  assert.equal(none.field.mode, 'none');
  const same = refitProductField({...blankField('literal'), value: '4'}, productChoicesFor({...masters, workId: 3}));
  assert.equal(same.note, null, '新しい作品にも結び付いた商品はそのまま');
  assert.equal(refitProductField(blankField('resolved'), []).note, null);
  // 画面は、割り当てを保存したら手順1・3の作品を割り当てに合わせ、手順3へ戻るときは付け替える先の作品の商品で選び直す
  const source = readFileSync(new URL('../src/import/SalesImportWizard.jsx', import.meta.url), 'utf8');
  assert.match(source, /mappingFitsBinding\(version\?\.definition, locked \? binding : spec, masters\)/);
  assert.match(source, /workId: spec\.mode === 'single_work' \? spec\.workId : previous\.workId/);
  assert.match(source, /refitProductField\(fields\.product_id, productChoicesFor\(/);
});

// ---------- F6 ----------
test('F6: クラウドでも、作品ごとに100行以内なら原本全体が100行を超えても分けられる。1つの作品の原本は手順2で案内し、作品ごとの超過は分割で止める', async (t) => {
  const f = await fixture({t, mode: 'worker'});
  const data = [...Array.from({length: 75}, (_, n) => row('WRK-DEMO', 'SKU-DIGI', String(1000 + n))), ...Array.from({length: 75}, (_, n) => row('WRK-B', 'SKU-B', String(2000 + n)))];
  const fileId = (await f.receive('rows150', data)).data.fileId;
  const selection = await f.call(`/sales-import/files/${fileId}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW});
  assert.equal(selection.status, 201, JSON.stringify(selection.data));
  await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'by_work_column', workColumn: '作品CD'});
  const versionId = await mappingVersion(f, {reportKey: 'ROWS-150'});
  const split = await f.call(`/sales-import/files/${fileId}/partitions`, {kind: 'digital', mappingVersionId: versionId});
  assert.equal(split.data.saved, true, JSON.stringify(split.data.errors));
  assert.deepEqual(split.data.partitions.map((item) => item.rowCount), [75, 75]);
  const preview = await previewPartition(f, split.data.partitions[0], versionId);
  assert.equal(preview.data.ok, true, JSON.stringify(preview.data.errors));
  // 1つの作品に割り当てた原本は、表全体が1件の報告になるので手順2で100行の上限を案内する
  const single = (await f.receive('single101', Array.from({length: 101}, (_, n) => row('WRK-DEMO', 'SKU-DIGI', String(n + 1))), {binding: {mode: 'single_work', workId: 1}})).data.fileId;
  const refused = await f.call(`/sales-import/files/${single}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW});
  assert.equal(refused.status, 413);
  assert.match(refused.data.error, /100行まで/);
  // 作品ごとに分けても1作品が100行を超えるなら、分割を保存しない（理由つき）
  const over = (await f.receive('over101', [...Array.from({length: 101}, (_, n) => row('WRK-DEMO', 'SKU-DIGI', String(n + 1))), row('WRK-B', 'SKU-B', '5')])).data.fileId;
  assert.equal((await f.call(`/sales-import/files/${over}/selection`, {sheetName: 'Details', headerRow: HEADER_ROW})).status, 201);
  await f.call(`/sales-import/files/${over}/bindings`, {mode: 'by_work_column', workColumn: '作品CD'});
  const overSplit = await f.call(`/sales-import/files/${over}/partitions`, {kind: 'digital', mappingVersionId: versionId});
  assert.equal(overSplit.data.saved, false);
  assert.ok(overSplit.data.errors.some((message) => /風のあとさき」に割り当たる行が101行あり、1回の登録で取り込める100行を超えます/.test(message)), JSON.stringify(overSplit.data.errors));
  const limits = (await f.call('/sales-import/limits')).data.limits;
  assert.deepEqual([limits.salesRows, limits.sourceRows], [100, 2000]);
});

// ---------- F7 ----------
test('F7: 報告1件の上限はバイト数で比べる（ローカルの D1 でなくても、クラウドの上限で案内する）', async (t) => {
  const f = await fixture({t, mode: 'worker'});
  const limits = importLimits('worker');
  assert.equal(limits.reportBytes, 128_000);
  // 旧方式の選択（表全体が1件の報告）も、日本語の多い表は文字数でなくバイト数で上限を案内する
  const headers = ['作品CD', '商品ｺｰﾄﾞ', '備考', '正味売上'];
  const sheet = [headers, ...Array.from({length: 90}, (_, n) => ['WRK-DEMO', 'SKU-DIGI', '架空の備考欄'.repeat(90), String(n + 1)])];
  const csv = sheet.map((item) => item.join(',')).join('\r\n');
  assert.ok(csv.length < limits.bytes && utf8Bytes(csv) > limits.reportBytes);
  await f.db.run(`INSERT INTO workflow_raw_artifacts(id,org_id,project_id,work_id,kind,file_name,media_type,byte_length,raw_sha256,original_base64,extraction_json,extractor_name,extractor_version,extraction_status,created_by)
    VALUES (1,1,1,1,'sales_report','legacy.xlsx',NULL,1,'${createHash('sha256').update('legacy').digest('hex')}','eA==','${JSON.stringify({sheets: [{name: 'Details', rows: sheet}]}).replaceAll("'", "''")}','test','1','extracted',1)`);
  const refused = await f.call('/sales-import/artifacts/1/selection', {sheetName: 'Details', headerRow: 1});
  assert.equal(refused.status, 413, JSON.stringify(refused.data).slice(0, 200));
  assert.match(refused.data.error, /上限は約128KB/);
});

// クラウドの試験。2026-10-03（香盤表 #11 の PR5）に D1 の binding を node:sqlite で模す形で sales-source-review-fixes-sqlite.test.mjs へ分けたが、
// 2026-10-04 に R2 の層をどの入口にもかぶせられるようにしたので、試験の DB の入口にかぶせて両方の DB で流す形に戻した。R2 は Map
function memoryBucket() {
  const store = new Map();
  return {store, async head(key) { const value = store.get(key); return value ? {size: value.length, customMetadata: {}} : null; }, async put(key, bytes) { store.set(key, new Uint8Array(bytes)); return {}; },
    async get(key) { const value = store.get(key); return value ? {body: true, arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)} : null; }};
}

test('FR-CORE-DATA-008 F7: クラウド（R2 の層をかぶせた入口）でも、日本語の多い原本の表の選択は保存でき、報告1件の大きさは UTF-8 のバイト数で上限と比べる', async (t) => {
  let bucket;
  // 試験の DB の入口（SQLite は LocalDatabase、PostgreSQL は PgDatabase）に R2 の層をかぶせる。文の数は本番の D1 と同じ500で断る
  const f = await fixture({t, mode: 'worker', makeDb: (inner) => { bucket = memoryBucket(); return new R2LargeValueDatabase(inner, bucket, {maxBatchStatements: 500}); }});
  const headers = ['作品CD', '商品ｺｰﾄﾞ', '作品名', '配信サービス', '備考', '正味売上'];
  const long = (note) => [headers, ...Array.from({length: 100}, (_, n) => ['WRK-DEMO', 'SKU-DIGI', '架空の長い作品名'.repeat(20), '架空配信サービス（見放題・レンタル）'.repeat(5), note, String(1000 + n)])];
  // 134KB（UTF-8）の表: 文字数では上限（200,000）の内側。以前は D1 の行内上限で手順2が 409 になった
  const big = long('架空の備考欄（契約番号・期間・条件の説明）'.repeat(9));
  const bigCsv = big.map((item) => item.join(',')).join('\r\n');
  assert.ok(bigCsv.length < 200_000 && utf8Bytes(bigCsv) > 128 * 1024, `${bigCsv.length}字・${utf8Bytes(bigCsv)}バイト`);
  const bigFile = (await f.receive('big', null, {sheet: big, binding: {mode: 'single_work', workId: 1}})).data.fileId;
  const bigSelection = await f.call(`/sales-import/files/${bigFile}/selection`, {sheetName: 'Details', headerRow: 1});
  assert.equal(bigSelection.status, 201, JSON.stringify(bigSelection.data).slice(0, 300));
  const storedCsv = (await f.db.get('SELECT canonical_csv FROM sales_source_selections WHERE file_id=?', [bigFile])).canonical_csv;
  assert.match(storedCsv, /^@r2:v1:/, '大きな選択は R2 に退避する');
  const versionId = await mappingVersion(f, {headers, amountColumn: '正味売上', reportKey: 'BIG-1'});
  const bigSplit = await f.call(`/sales-import/files/${bigFile}/partitions`, {kind: 'digital', mappingVersionId: versionId});
  assert.equal(bigSplit.data.saved, true, JSON.stringify(bigSplit.data.errors));
  // 報告1件としては D1 の1行（report_imports.raw_text）に入らないので、確かめる段階で理由を示す（以前は保存で失敗した）
  const tooBig = await previewPartition(f, bigSplit.data.partitions[0], versionId);
  assert.equal(tooBig.status, 400, JSON.stringify(tooBig.data).slice(0, 300));
  assert.match(tooBig.data.error, /約128KB以内/);
  // 97KB（UTF-8）の表は、確かめる（import_previews の大きな内容は R2 へ退避）・登録まで通る（以前は確認で 500）
  const mid = long('架空の備考欄（契約番号・期間・条件の説明）'.repeat(3));
  const midFile = (await f.receive('mid', null, {sheet: mid, binding: {mode: 'single_work', workId: 1}})).data.fileId;
  assert.equal((await f.call(`/sales-import/files/${midFile}/selection`, {sheetName: 'Details', headerRow: 1})).status, 201);
  const midVersion = await mappingVersion(f, {headers, amountColumn: '正味売上', reportKey: 'MID-1'});
  const midSplit = await f.call(`/sales-import/files/${midFile}/partitions`, {kind: 'digital', mappingVersionId: midVersion});
  const preview = await previewPartition(f, midSplit.data.partitions[0], midVersion);
  assert.equal(preview.status, 200, JSON.stringify(preview.data).slice(0, 300));
  assert.equal(preview.data.ok, true, JSON.stringify(preview.data.errors).slice(0, 300));
  assert.match((await f.db.get('SELECT payload_json FROM import_previews WHERE token=?', [preview.data.token])).payload_json, /^@r2:v1:/);
  const commit = await f.call('/sales-import/commit', {token: preview.data.token});
  assert.equal(commit.status, 200, JSON.stringify(commit.data));
  assert.equal(Number((await f.db.get('SELECT COUNT(*) AS n FROM sale_lines')).n), 100);
  assert.ok(bucket.store.size >= 2);
});

// ---------- F8 ----------
test('F8: 作品コードの列で分けるときは、前回の「行ごとに照合」を残し、1つの作品の原本という注記を出さない', () => {
  const sample = [row('WRK-DEMO', 'SKU-DIGI', '1000')];
  const base = defaultFields({headers: HEADERS, sampleRows: sample, resolvedProduct: true, period: guessPeriod(HEADERS, sample)}).fields;
  const previous = buildDefinition({...base,
    report_key: {...blankField('literal'), value: 'K'}, recognition_basis_id: {...blankField('literal'), value: '2'},
    basis_date: {...blankField('literal'), value: '2026-09-05'}, basis_reason: {...blankField('literal'), value: 'x'},
    tax_amount: blankField('zero'), amount_inc_tax: blankField('same_ex')}, {headers: HEADERS, partnerId: 2, autoKey: 'K', resolvedProduct: true});
  assert.deepEqual(previous.errors, []);
  const byWork = defaultFields({headers: HEADERS, sampleRows: sample, previous: {definition: previous.definition, versionNo: 3}, productIds: [], assignMode: 'by_work_column'});
  assert.equal(byWork.fields.product_id.mode, 'resolved');
  assert.doesNotMatch(byWork.notes.product_id, /1つの作品の原本/);
  assert.match(byWork.notes.product_id, /手順4で商品コードの列を選びます/);
  // 1つの作品の原本では、前回の照合は使わずに選び直させる（今までどおり）
  const single = defaultFields({headers: HEADERS, sampleRows: sample, previous: {definition: previous.definition, versionNo: 3}, productIds: [7], assignMode: 'single_work'});
  assert.deepEqual([single.fields.product_id.mode, single.fields.product_id.value], ['literal', '7']);
  assert.match(single.notes.product_id, /1つの作品の原本/);
  // 商品コードの列で分けるときは、前回が何であれ行ごとに照合する
  assert.equal(defaultFields({headers: HEADERS, sampleRows: sample, previous: {definition: previous.definition, versionNo: 3}, assignMode: 'by_product'}).fields.product_id.mode, 'resolved');
  // 作品コードの列で分け、前回は商品を1つに固定していた: 固定の商品は使わず、理由を書く
  const literalPrevious = {mappings: [{target: 'product_id', mode: 'literal', valueType: 'integer', value: '1'}], ignoredColumns: []};
  const noFixed = defaultFields({headers: HEADERS, sampleRows: sample, previous: {definition: literalPrevious, versionNo: 2}, productIds: [], assignMode: 'by_work_column'});
  assert.equal(noFixed.fields.product_id.mode, 'none');
  assert.match(noFixed.notes.product_id, /作品コードの列で作品ごとに分けるため/);
  // 画面は作品の決め方をそのまま渡す（以前は「商品コードの列で分ける」かどうかだけを渡していた）
  const source = readFileSync(new URL('../src/import/SalesImportWizard.jsx', import.meta.url), 'utf8');
  assert.match(source, /guessPeriod\(body\.headers, sample\), assignMode: setup\.assignMode\}/);
});

// ---------- F9 ----------
test('FR-REV-INTAKE-005 FR-REV-INTAKE-016 F9: 管理者が権限のない作品へ付け替えた原本は、受け取った人にも作品のコード・題名を伏せる（詳細・履歴・付け替えの応答・照合）', async (t) => {
  const f = await fixture({t});
  const fileId = (await f.receive('leak', [row('WRK-C', 'SKU-C', '1000')], {binding: {mode: 'single_work', workId: 1}, email: EDITOR})).data.fileId;
  await select(f, fileId);
  const rebind = await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 4, reason: '権限外の作品の報告だった'});
  assert.equal(rebind.status, 201);
  assert.equal(rebind.data.binding.workTitle, '権限外の架空作品', '管理者には見える');
  const detail = await f.call(`/sales-import/files/${fileId}`, null, EDITOR);
  assert.equal(detail.status, 200, '受け取った人は原本を開ける');
  assert.deepEqual({code: detail.data.binding.workCode, title: detail.data.binding.workTitle, restricted: detail.data.binding.restricted}, {code: null, title: null, restricted: true});
  assert.deepEqual(detail.data.bindings.map((item) => [item.versionNo, item.workCode, item.workTitle, item.restricted]), [[2, null, null, true], [1, 'WRK-DEMO', '風のあとさき', false]]);
  assert.ok(!JSON.stringify(detail.data.bindings).includes('WRK-C'));
  const lookup = await f.call(`/sales-import/artifacts/lookup?sha256=${f.hashOf('leak')}`, null, EDITOR);
  assert.deepEqual([lookup.data.file.binding.workTitle, lookup.data.file.binding.restricted], [null, true]);
  const stale = await f.call(`/sales-import/files/${fileId}/bindings`, {mode: 'single_work', workId: 1, reason: '戻す', expectedVersion: 1}, EDITOR);
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.data.details.current.workCode, stale.data.details.current.workTitle], [null, null]);
  const list = await f.call('/sales-import/files', null, EDITOR);
  assert.equal(list.data.rows.find((item) => item.fileId === fileId).binding.workTitle, null);
  assert.equal((await f.call(`/sales-import/files/${fileId}`)).data.binding.workCode, 'WRK-C', '管理者には見える');
});
