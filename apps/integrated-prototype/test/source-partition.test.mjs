// 受領原本を作品ごとに分ける純関数（src/import/source-partition.mjs）と、取込ウィザードの列対応（商品を行ごとに照合する）の試験。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOLVED_PRODUCT_COLUMN, normalizeCode, parseCsvCells, toCsvText, selectionTable, normalizeBinding, sameBinding, bindingText, planPartitions, planKey,
  partitionCsv, commitProgress, guessSplitColumn, usesResolvedProduct,
} from '../src/import/source-partition.mjs';
import {buildDefinition, defaultFields, fieldsFromDefinition, blankField} from '../src/import/wizard-model.mjs';
import {buildSelection} from '../src/import/sales-import-routes.mjs';

const works = [{id: 1, project_id: 1, code: 'WRK-A', title: '作品A'}, {id: 2, project_id: 1, code: 'WRK-B', title: '作品B'}, {id: 3, project_id: 2, code: 'wrk-a', title: '小文字の作品'}];
const products = [
  {id: 10, sku: 'SKU-A', name: 'A配信', channel: 'digital'}, {id: 11, sku: 'SKU-B', name: 'B配信', channel: 'digital'},
  {id: 12, sku: 'SKU-AB', name: 'AB配信', channel: 'digital'}, {id: 13, sku: 'SKU-PKG', name: 'Aパッケージ', channel: 'package'},
  {id: 14, sku: 'SKU-NONE', name: '未配賦', channel: 'digital'}, {id: 15, sku: 'SKU-BAD', name: '配賦が足りない', channel: 'digital'},
];
const allocations = [
  {product_id: 10, work_id: 1, allocation_bps: 10000}, {product_id: 11, work_id: 2, allocation_bps: 10000},
  {product_id: 12, work_id: 1, allocation_bps: 5000}, {product_id: 12, work_id: 2, allocation_bps: 5000},
  {product_id: 13, work_id: 1, allocation_bps: 10000}, {product_id: 15, work_id: 1, allocation_bps: 9000},
];
const tableOf = (rows) => selectionTable(toCsvText([['作品', '商品', '金額'], ...rows]), rows.map((_, index) => index + 5));

test('FR-REV-INTAKE-012 コードは NFKC にして前後の空白を除く。大文字・小文字は変えない（推測しない）', () => {
  assert.equal(normalizeCode(' ＳＫＵ－Ａ '), 'SKU-A');
  assert.equal(normalizeCode('ｻﾝﾌﾟﾙ'), 'サンプル');
  assert.equal(normalizeCode(null), '');
  assert.notEqual(normalizeCode('sku-a'), normalizeCode('SKU-A'));
});

test('自分で書き出した表は、セルの値（前後の空白・引用符・改行）を変えずに読み戻せる', () => {
  const rows = [['見出し', '備考'], [' 前後に空白 ', 'カンマ,入り'], ['"引用"', '改行\r\nあり'], ['', '']];
  assert.deepEqual(parseCsvCells(toCsvText(rows)), rows);
  const selection = buildSelection([['題'], ['明細', '金額'], [' A ', '100'], ['B', '2,00']], 2);
  const table = selectionTable(selection.canonicalCsv, selection.sourceRowNumbers);
  assert.deepEqual(table.headers, ['明細', '金額']);
  assert.deepEqual(table.rows.map((row) => [row.sourceRow, row.cells]), [[3, [' A ', '100']], [4, ['B', '2,00']]]);
  assert.throws(() => selectionTable(selection.canonicalCsv, [3]), /行数/);
});

test('割り当ての入力: 決め方ごとに要る値と列の有無を確かめる', () => {
  assert.match(normalizeBinding({mode: 'x'}).error, /作品の決め方/);
  assert.match(normalizeBinding({mode: 'single_work'}).error, /作品を選んで/);
  assert.deepEqual(normalizeBinding({mode: 'single_work', workId: '2', productColumn: '商品'}).binding, {mode: 'single_work', workId: 2, productColumn: null, workColumn: null});
  assert.match(normalizeBinding({mode: 'by_product'}).error, /商品コードの列/);
  assert.match(normalizeBinding({mode: 'by_product', productColumn: '無い'}, ['商品']).error, /見出しにありません/);
  assert.deepEqual(normalizeBinding({mode: 'by_product', productColumn: ' 商品 ', workId: 9}, ['商品']).binding, {mode: 'by_product', workId: null, productColumn: '商品', workColumn: null});
  assert.match(normalizeBinding({mode: 'by_work_column', productColumn: '商品'}).error, /作品コードの列/);
  assert.match(normalizeBinding({mode: 'by_work_column', workColumn: '作品', productColumn: '作品'}, ['作品']).error, /別の列/);
  const byWork = normalizeBinding({mode: 'by_work_column', workColumn: '作品', productColumn: '商品'}, ['作品', '商品']).binding;
  assert.equal(usesResolvedProduct(byWork), true);
  assert.equal(usesResolvedProduct({mode: 'by_work_column', workColumn: '作品'}), false);
  assert.equal(usesResolvedProduct({mode: 'single_work', workId: 1}), false);
  assert.equal(sameBinding(byWork, {...byWork}), true);
  assert.equal(sameBinding(byWork, {...byWork, productColumn: null}), false);
  assert.equal(bindingText(null), '作品はまだ決めていません');
  assert.equal(bindingText({mode: 'single_work', workId: 2}, works), '1つの作品「作品B」へ');
  assert.equal(bindingText({mode: 'single_work', workId: 99}, works), '1つの作品「権限のない作品」へ');
  assert.match(bindingText(byWork), /作品コードの列「作品」.*商品は列「商品」/);
});

test('FR-REV-INTAKE-013 FR-REV-INTAKE-014 商品コードの列で分ける: 照合できない値は理由つきで返し、複数作品に配賦された商品は配賦率の高い作品（同率なら作品IDの小さい方）へ置く', () => {
  const table = tableOf([['', 'SKU-A', '1'], ['', 'ＳＫＵ－Ｂ', '2'], ['', 'SKU-AB', '3'], ['', 'sku-a', '4'], ['', '', '5'], ['', 'SKU-PKG', '6'], ['', 'SKU-NONE', '7'], ['', 'SKU-BAD', '8'], ['', 'SKU-A', '9']]);
  const binding = {mode: 'by_product', productColumn: '商品'};
  const planned = planPartitions({table, binding, products, allocations, works, kind: 'digital'});
  assert.deepEqual(planned.errors, []);
  assert.deepEqual(planned.partitions.map((item) => [item.workId, item.projectId, item.sourceRows]), [[1, 1, [5, 7, 13]], [2, 1, [6]]]);
  assert.deepEqual(planned.partitions[0].productMap.map((item) => [item.code, item.productId, item.rows, item.allocations.length]), [['SKU-A', 10, 2, 1], ['SKU-AB', 12, 1, 2]]);
  assert.deepEqual(planned.unmatched.map((item) => [item.sourceRow, item.value]), [[8, 'sku-a'], [9, ''], [10, 'SKU-PKG'], [11, 'SKU-NONE'], [12, 'SKU-BAD']]);
  assert.match(planned.unmatched[0].reason, /商品マスタにない/);
  assert.match(planned.unmatched[2].reason, /販路/);
  assert.match(planned.unmatched[3].reason, /どの作品にも配賦されていません/);
  assert.match(planned.unmatched[4].reason, /100%になっていません/);
  // 報告の種類を指定しなければ販路は照らさない
  assert.ok(planPartitions({table, binding, products, allocations, works}).partitions[0].sourceRows.includes(10));
  // 報告を置く作品を選び直す（配賦先の中だけ）
  const moved = planPartitions({table, binding, products, allocations, works, kind: 'digital', reportWorks: {12: 2}});
  assert.deepEqual(moved.partitions.map((item) => [item.workId, item.sourceRows]), [[1, [5, 13]], [2, [6, 7]]]);
  assert.deepEqual(planPartitions({table, binding, products, allocations, works, kind: 'digital', reportWorks: {12: 3}}).partitions.map((item) => item.workId), [1, 2]);
  assert.notEqual(planKey(binding, planned.partitions), planKey(binding, moved.partitions));
  assert.equal(planKey(binding, planned.partitions), planKey({...binding}, planPartitions({table, binding, products, allocations, works, kind: 'digital'}).partitions));
});

test('商品コードの重なり・見出しにない列・照合列の名前の衝突はエラーにする', () => {
  const duplicate = planPartitions({table: tableOf([['', 'X-1', '1']]), binding: {mode: 'by_product', productColumn: '商品'}, products: [{id: 1, sku: 'X-1', channel: 'digital'}, {id: 2, sku: 'Ｘ-1', channel: 'digital'}], allocations: [], works});
  assert.match(duplicate.unmatched[0].reason, /複数あります/);
  assert.match(planPartitions({table: tableOf([['', 'SKU-A', '1']]), binding: {mode: 'by_product', productColumn: '無い'}, products, allocations, works}).errors[0], /見出しにありません/);
  const clash = selectionTable(toCsvText([['商品', RESOLVED_PRODUCT_COLUMN], ['SKU-A', '1']]), [2]);
  assert.match(planPartitions({table: clash, binding: {mode: 'by_product', productColumn: '商品'}, products, allocations, works}).errors[0], /商品ID（照合）/);
  assert.match(planPartitions({table: tableOf([['', '', '1']]), binding: null}).errors[0], /決まっていません/);
  assert.match(planPartitions({table: tableOf([['', '', '1']]), binding: {mode: 'single_work', workId: 99}, works}).errors[0], /見つかりません/);
});

test('FR-REV-INTAKE-013 作品コードの列で分ける: works.code と照合し、商品の列を併せればその作品への配賦を確かめる', () => {
  const table = tableOf([['WRK-A', 'SKU-A', '1'], ['ＷＲＫ－Ｂ', 'SKU-B', '2'], ['WRK-Z', 'SKU-A', '3'], ['', 'SKU-A', '4'], ['WRK-B', 'SKU-A', '5'], ['wrk-a', '', '6']]);
  const plain = planPartitions({table, binding: {mode: 'by_work_column', workColumn: '作品'}, products, allocations, works});
  assert.deepEqual(plain.partitions.map((item) => [item.workId, item.sourceRows]), [[1, [5]], [2, [6, 9]], [3, [10]]]);
  assert.deepEqual(plain.unmatched.map((item) => [item.sourceRow, item.reason.slice(0, 6)]), [[7, '作品マスタに'], [8, '作品コードが']]);
  const withProduct = planPartitions({table, binding: {mode: 'by_work_column', workColumn: '作品', productColumn: '商品'}, products, allocations, works, kind: 'digital'});
  assert.deepEqual(withProduct.partitions.map((item) => [item.workId, item.sourceRows]), [[1, [5]], [2, [6]]]);
  assert.deepEqual(withProduct.unmatched.map((item) => item.sourceRow), [7, 8, 9, 10]);
  assert.match(withProduct.unmatched[2].reason, /作品「WRK-B」に配賦されていません/);
});

test('分割後の表: 1つの作品なら選択版の表そのもの、商品を照合するなら右端に商品IDを足す（元の値は変えない）', () => {
  const selection = buildSelection([['作品', '商品', '金額'], ['A', ' SKU-A ', '100'], ['B', 'SKU-AB', '200'], ['C', 'SKU-B', '300']], 1);
  const table = selectionTable(selection.canonicalCsv, selection.sourceRowNumbers);
  const single = partitionCsv(table, planPartitions({table, binding: {mode: 'single_work', workId: 1}, works}).partitions[0], {mode: 'single_work', workId: 1});
  assert.equal(single.csv, selection.canonicalCsv);
  const binding = {mode: 'by_product', productColumn: '商品'};
  const [first, second] = planPartitions({table, binding, products, allocations, works}).partitions;
  const built = partitionCsv(table, first, binding);
  assert.deepEqual(built.headers, ['作品', '商品', '金額', RESOLVED_PRODUCT_COLUMN]);
  assert.equal(built.csv, `作品,商品,金額,${RESOLVED_PRODUCT_COLUMN}\r\nA, SKU-A ,100,10\r\nB,SKU-AB,200,12`);
  assert.deepEqual(built.sourceRowNumbers, [2, 3]);
  assert.equal(partitionCsv(table, second, binding).csv.split('\r\n')[1], 'C,SKU-B,300,11');
  assert.throws(() => partitionCsv(table, {...first, sourceRows: [99]}, binding), /表の選択にありません/);
  assert.throws(() => partitionCsv(table, {...first, productMap: []}, binding), /分割の記録にありません/);
});

test('FR-REV-INTAKE-032 登録の進み具合と、分ける列の候補', () => {
  assert.deepEqual(commitProgress([]), {total: 0, committed: 0, remaining: 0, started: false, complete: false, label: '未登録'});
  assert.equal(commitProgress([{committed: false}]).label, '未登録');
  assert.equal(commitProgress([{committed: true}]).label, '登録済み');
  const partial = commitProgress([{committed: true}, {committed: false}, {committed: false}]);
  assert.deepEqual([partial.label, partial.started, partial.complete, partial.remaining], ['3作品中1作品を登録済み', true, false, 2]);
  assert.equal(commitProgress([{committed: true}, {committed: true}]).complete, true);
  assert.equal(guessSplitColumn(['作品CD', '商品ｺｰﾄﾞ', '金額']), '商品ｺｰﾄﾞ');
  assert.equal(guessSplitColumn(['作品CD', '商品ｺｰﾄﾞ', '金額'], 'work'), '作品CD');
  assert.equal(guessSplitColumn(['品番', '金額']), '品番');
  assert.equal(guessSplitColumn(['金額']), null);
});

test('列対応: 分ける原本では商品を「行ごとに照合」にでき、照合列を product_id の元の列にする。1つの作品の原本では選べない', () => {
  const headers = ['作品CD', '商品ｺｰﾄﾞ', '対象月', '正味売上'];
  const {fields} = defaultFields({headers, sampleRows: [['A', 'SKU-A', '2026/08', '100']], productIds: [1], period: {from: '2026-08-01', to: '2026-08-31', month: '2026-08', column: '対象月'}, resolvedProduct: true});
  assert.equal(fields.product_id.mode, 'resolved');
  fields.recognition_basis_id = {...blankField('none')};
  fields.accounting_month = {...blankField('literal'), value: '2026-09'};
  fields.amount_ex_tax = {...blankField('source'), source: '正味売上'};
  fields.tax_amount = blankField('zero');
  fields.amount_inc_tax = blankField('same_ex');
  const built = buildDefinition(fields, {headers, partnerId: 2, autoKey: 'K', resolvedProduct: true});
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.definition.mappings.find((rule) => rule.target === 'product_id'), {target: 'product_id', mode: 'source', source: RESOLVED_PRODUCT_COLUMN});
  assert.ok(built.definition.ignoredColumns.includes('商品ｺｰﾄﾞ'), '商品コードの列そのものは取り込まない列');
  assert.ok(!built.definition.ignoredColumns.includes(RESOLVED_PRODUCT_COLUMN));
  const refused = buildDefinition(fields, {headers, partnerId: 2, autoKey: 'K'});
  assert.match(refused.errors.find((error) => error.target === 'product_id').message, /分けるときだけ/);
  const none = buildDefinition({...fields, product_id: blankField('none')}, {headers, partnerId: 2, autoKey: 'K', resolvedProduct: true});
  assert.ok(none.definition.ignoredColumns.includes(RESOLVED_PRODUCT_COLUMN), '使わないなら照合列は取り込まない列');
  // 前回の版が「行ごとに照合」なら、分ける原本ではそのまま、1つの作品の原本では選び直す
  assert.equal(fieldsFromDefinition(built.definition, headers).product_id.mode, 'resolved');
  const again = defaultFields({headers, sampleRows: [], previous: {definition: built.definition, versionNo: 3}, productIds: [7]});
  assert.equal(again.fields.product_id.mode, 'literal');
  assert.equal(again.fields.product_id.value, '7');
  assert.match(again.notes.product_id, /選び直して/);
  assert.equal(defaultFields({headers, sampleRows: [], previous: {definition: built.definition, versionNo: 3}, productIds: [7], resolvedProduct: true}).fields.product_id.mode, 'resolved');
});

test('手順4の下書き: 足りない値があれば割り当てを試さず、列対応と割り当てが合わなければ理由を返す。金額が計算できない行は保留と書く', async () => {
  const {draftBinding, mappingFitsBinding, partitionSelection, partitionAmountText} = await import('../src/import/wizard-model.mjs');
  assert.equal(draftBinding(null), null);
  assert.equal(draftBinding({mode: 'single_work', workId: ''}), null);
  assert.deepEqual(draftBinding({mode: 'single_work', workId: '3'}), {mode: 'single_work', workId: 3, productColumn: null, workColumn: null});
  assert.equal(draftBinding({mode: 'by_product', productColumn: ''}), null);
  assert.deepEqual(draftBinding({mode: 'by_product', productColumn: '商品', workColumn: '作品'}), {mode: 'by_product', workId: null, productColumn: '商品', workColumn: null});
  assert.equal(draftBinding({mode: 'by_work_column', workColumn: '作品', useProductColumn: true, productColumn: ''}), null);
  assert.deepEqual(draftBinding({mode: 'by_work_column', workColumn: '作品', useProductColumn: false, productColumn: '商品'}), {mode: 'by_work_column', workId: null, productColumn: null, workColumn: '作品'});
  const resolved = {mappings: [{target: 'product_id', mode: 'source', source: RESOLVED_PRODUCT_COLUMN}], ignoredColumns: []};
  const literal = {mappings: [{target: 'product_id', mode: 'literal', valueType: 'integer', value: '1'}], ignoredColumns: [RESOLVED_PRODUCT_COLUMN]};
  const none = {mappings: [], ignoredColumns: [RESOLVED_PRODUCT_COLUMN]};
  assert.equal(mappingFitsBinding(resolved, {mode: 'by_product', productColumn: '商品'}), null);
  assert.match(mappingFitsBinding(resolved, {mode: 'single_work', workId: 1}), /1つの作品に割り当てるときは/);
  assert.match(mappingFitsBinding(resolved, {mode: 'by_work_column', workColumn: '作品'}), /商品コードの列も選んで/);
  assert.match(mappingFitsBinding(none, {mode: 'by_product', productColumn: '商品'}), /按分する/);
  assert.match(mappingFitsBinding(literal, {mode: 'by_work_column', workColumn: '作品', productColumn: '商品'}), /行ごとに照合する/);
  assert.equal(mappingFitsBinding(literal, {mode: 'single_work', workId: 1}), null);
  assert.equal(mappingFitsBinding(none, {mode: 'by_work_column', workColumn: '作品'}), null);
  assert.equal(mappingFitsBinding(null, {mode: 'single_work'}), null);
  assert.deepEqual(partitionSelection({csv: 'a\r\n1', sourceRowNumbers: [5], headers: ['a']}), {canonicalCsv: 'a\r\n1', sourceRowNumbers: [5], headers: ['a']});
  assert.deepEqual(partitionSelection(null), {canonicalCsv: '', sourceRowNumbers: [], headers: []});
  assert.equal(partitionAmountText(null), '列の対応を保存すると出ます');
  assert.equal(partitionAmountText({amountExTax: 12000, unknownAmountRows: 0}), '12,000円');
  assert.equal(partitionAmountText({amountExTax: 0, unknownAmountRows: 0}), '0円');
  assert.equal(partitionAmountText({amountExTax: 500, unknownAmountRows: 2}), '保留（計算できない行2行。計算できた分は500円）');
});
