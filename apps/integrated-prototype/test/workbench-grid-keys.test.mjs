// 表編集（Workbench）の操作の純関数: キー操作の2モード、貼付・消去・下への複写、元に戻す、派生値、
// 検証エラーの行・セルへの対応付け、段階表示、下書きの表示名、出力のシート定義。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gridKeyAction, moveSelection, gridColumns, gridCellText, normalizeCellInput, cellIssue, deriveSalesValues, newSalesRow,
  setCells, applyEdits, clearCells, fillDown, pasteCells, deleteRowsByKeys, selectedRowKeys, ensureRowKeys, mapRowErrors,
  describeRowError, errorColumn, workflowState, draftLabel, datasetAccess, workbenchSheet, unsavedCount, cellErrorKey,
  sourceKey, pasteVisible, SALES_SAMPLE,
} from '../src/workbench-ui.mjs';
import {specTable, encodeReportXlsx} from '../src/xlsx-report.mjs';

const SALES_META = [
  {key: 'report_key', label: '報告キー', type: 'string', editable: true},
  {key: 'kind', label: '報告種別', type: 'string', editable: true},
  {key: 'partner_id', label: '取引先ID', type: 'integer', editable: true, lookup: 'partners'},
  {key: 'recognition_basis_id', label: '計上基準ID', type: 'integer', editable: true},
  {key: 'sales_month', label: '販売月', type: 'month', editable: true},
  {key: 'report_received_on', label: '報告受領日', type: 'date', editable: true},
  {key: 'accounting_month', label: '計上月', type: 'month', editable: true},
  {key: 'amount_ex_tax', label: '税抜額', type: 'integer', editable: true},
  {key: 'tax_amount', label: '税額', type: 'integer', editable: true},
  {key: 'amount_inc_tax', label: '税込額', type: 'integer', editable: true},
];
const partners = [{id: 2, code: 'P-A', name: '配信プラットフォームA'}, {id: 3, code: 'P-B', name: 'レンタル店B'}];
const salesColumns = (options = {}) => gridColumns(SALES_META, {dataset: 'sales_import', lookups: {partners}, ...options});

test('閲覧モード: Enter・F2・文字入力で編集、矢印と Tab で移動、Delete で消去、Ctrl+Z/Y/D', () => {
  assert.deepEqual(gridKeyAction({key: 'Enter'}), {type: 'edit', keep: true});
  assert.deepEqual(gridKeyAction({key: 'F2'}), {type: 'edit', keep: true});
  assert.deepEqual(gridKeyAction({key: 'a'}), {type: 'edit', keep: false, text: 'a'});
  assert.deepEqual(gridKeyAction({key: '５'}), {type: 'edit', keep: false, text: '５'});
  assert.deepEqual(gridKeyAction({key: 'ArrowLeft'}), {type: 'move', dr: 0, dc: -1, extend: false});
  assert.deepEqual(gridKeyAction({key: 'ArrowDown', shiftKey: true}), {type: 'move', dr: 1, dc: 0, extend: true});
  assert.deepEqual(gridKeyAction({key: 'Tab'}), {type: 'move', dr: 0, dc: 1, extend: false});
  assert.deepEqual(gridKeyAction({key: 'Tab', shiftKey: true}), {type: 'move', dr: 0, dc: -1, extend: false});
  assert.equal(gridKeyAction({key: 'Delete'}).type, 'clear');
  assert.equal(gridKeyAction({key: 'Backspace'}).type, 'clear');
  assert.equal(gridKeyAction({key: 'z', ctrlKey: true}).type, 'undo');
  assert.equal(gridKeyAction({key: 'y', ctrlKey: true}).type, 'redo');
  assert.equal(gridKeyAction({key: 'Z', metaKey: true, shiftKey: true}).type, 'redo');
  assert.equal(gridKeyAction({key: 'd', ctrlKey: true}).type, 'fillDown');
  assert.equal(gridKeyAction({key: 'c', ctrlKey: true}).type, 'copy');
  assert.equal(gridKeyAction({key: 'v', ctrlKey: true}).type, 'paste');
  // IME の変換中は何もしない
  assert.equal(gridKeyAction({key: 'Enter', isComposing: true}).type, 'none');
  assert.equal(gridKeyAction({key: 'Process', keyCode: 229}).type, 'none');
});

test('編集モード: 矢印はセル内に任せ、Esc で取消、Enter で確定して下へ、Tab で確定して右へ', () => {
  for (const arrow of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
    assert.equal(gridKeyAction({key: arrow}, {editing: true}).type, 'none', arrow);
  }
  assert.deepEqual(gridKeyAction({key: 'Escape'}, {editing: true}), {type: 'cancel'});
  assert.deepEqual(gridKeyAction({key: 'Enter'}, {editing: true}), {type: 'commit', dr: 1, dc: 0});
  assert.deepEqual(gridKeyAction({key: 'Enter', shiftKey: true}, {editing: true}), {type: 'commit', dr: -1, dc: 0});
  assert.deepEqual(gridKeyAction({key: 'Tab'}, {editing: true}), {type: 'commit', dr: 0, dc: 1});
  // 編集中の文字入力・Delete・Ctrl+Z は入力欄のもの
  assert.equal(gridKeyAction({key: 'x'}, {editing: true}).type, 'none');
  assert.equal(gridKeyAction({key: 'Delete'}, {editing: true}).type, 'none');
  assert.equal(gridKeyAction({key: 'z', ctrlKey: true}, {editing: true}).type, 'none');
});

test('読み取り専用の表では編集・消去・貼付・元に戻すを止め、移動とコピーはできる', () => {
  for (const event of [{key: 'Enter'}, {key: 'F2'}, {key: 'a'}, {key: 'Delete'}, {key: 'd', ctrlKey: true}, {key: 'v', ctrlKey: true}, {key: 'z', ctrlKey: true}]) {
    assert.equal(gridKeyAction(event, {readOnly: true}).type, 'readonly', JSON.stringify(event));
  }
  assert.equal(gridKeyAction({key: 'ArrowDown'}, {readOnly: true}).type, 'move');
  assert.equal(gridKeyAction({key: 'c', ctrlKey: true}, {readOnly: true}).type, 'copy');
});

test('選択の移動は端で止まり、Shift で範囲を広げ、確定後は下・右へ進む', () => {
  const bounds = {rows: 3, cols: 4};
  assert.deepEqual(moveSelection(null, {type: 'move', dr: -1, dc: -1}, bounds), {anchor: {r: 0, c: 0}, focus: {r: 0, c: 0}});
  const start = {anchor: {r: 1, c: 1}, focus: {r: 1, c: 1}};
  assert.deepEqual(moveSelection(start, {type: 'move', dr: 1, dc: 0, extend: true}, bounds), {anchor: {r: 1, c: 1}, focus: {r: 2, c: 1}});
  assert.deepEqual(moveSelection(start, {type: 'move', dr: 5, dc: 9}, bounds).focus, {r: 2, c: 3});
  assert.deepEqual(moveSelection(start, {type: 'commit', dr: 1, dc: 0}, bounds).focus, {r: 2, c: 1});
  assert.deepEqual(moveSelection(start, {type: 'moveTo', c: 'last'}, bounds).focus, {r: 1, c: 3});
  assert.deepEqual(moveSelection(start, {type: 'selectAll'}, bounds), {anchor: {r: 0, c: 0}, focus: {r: 2, c: 3}});
});

test('Enter/F2 で編集して Esc で取り消すと元の値のまま（確定しないと表は変わらない）', () => {
  const columns = salesColumns();
  const rows = [{...SALES_SAMPLE, amount_ex_tax: 1000, _source: {key: 'a'}}];
  // 画面は編集中の文字を別に持ち、Esc（cancel）では setCells を呼ばない。確定（commit）だけが表を変える。
  const cancelled = gridKeyAction({key: 'Escape'}, {editing: true});
  assert.equal(cancelled.type, 'cancel');
  assert.equal(rows[0].amount_ex_tax, 1000);
  const committed = setCells(rows, [{key: 'a', field: 'amount_ex_tax', value: normalizeCellInput(columns[7], '１，２００')}]);
  assert.equal(committed.rows[0].amount_ex_tax, 1200);
  assert.equal(rows[0].amount_ex_tax, 1000, '元の配列は変えない');
});

test('税抜・税額を変えると税込額を計算し直し、計上基準と日付から計上月を出す', () => {
  const derive = deriveSalesValues;
  const rows = [{...SALES_SAMPLE, recognition_basis_id: '1', amount_ex_tax: '1000', tax_amount: '100', amount_inc_tax: '1100', _source: {key: 'a'}}];
  const changed = setCells(rows, [{key: 'a', field: 'tax_amount', value: 80}], {derive});
  assert.equal(changed.rows[0].amount_inc_tax, 1080);
  assert.ok(changed.edits.some((edit) => edit.field === 'amount_inc_tax' && edit.before === '1100' && edit.after === 1080), '派生値の変化も元に戻す履歴に入る');
  const basis = setCells(changed.rows, [{key: 'a', field: 'recognition_basis_id', value: '2'}, {key: 'a', field: 'report_received_on', value: '2026-10-05'}], {derive});
  assert.equal(basis.rows[0].accounting_month, '2026-10');
  const back = setCells(basis.rows, [{key: 'a', field: 'recognition_basis_id', value: '1'}, {key: 'a', field: 'sales_month', value: '2026-08'}], {derive});
  assert.equal(back.rows[0].accounting_month, '2026-08');
  // 税抜・税額が数でないうちは税込額を触らない（入力途中の値を壊さない）
  assert.equal(deriveSalesValues({amount_ex_tax: 'abc', tax_amount: '10', amount_inc_tax: '5'}).amount_inc_tax, '5');
  assert.equal(deriveSalesValues({amount_ex_tax: '', tax_amount: '', amount_inc_tax: '5'}).amount_inc_tax, '');
  // 計算列は読み取り専用
  const columns = salesColumns();
  assert.equal(columns.find((c) => c.key === 'amount_inc_tax').editable, false);
  assert.equal(columns.find((c) => c.key === 'accounting_month').editable, false);
  assert.equal(columns.find((c) => c.key === 'amount_ex_tax').editable, true);
  // 合わない計算列はセルで注意する
  const inc = columns.find((c) => c.key === 'amount_inc_tax');
  assert.match(cellIssue(inc, '999', {amount_ex_tax: '1000', tax_amount: '100', amount_inc_tax: '999'}), /計算値（1,100）と一致しません/);
  assert.equal(cellIssue(inc, 1100, {amount_ex_tax: '1000', tax_amount: '100', amount_inc_tax: 1100}), '');
});

test('新しい行は直前の行から報告キー・取引先・期間・計上基準を写し、計上基準が空なら販売月基準にする', () => {
  const first = newSalesRow(null, 'new:1');
  assert.equal(first.recognition_basis_id, '1');
  assert.equal(first.accounting_month, '2026-09');
  assert.equal(first._source.key, 'new:1');
  const second = newSalesRow({...first, report_key: 'R-9', partner_id: '2', amount_ex_tax: 5000}, 'new:2');
  assert.equal(second.report_key, 'R-9');
  assert.equal(second.partner_id, '2');
  assert.equal(second.amount_ex_tax, SALES_SAMPLE.amount_ex_tax, '金額は写さない');
});

test('Delete は選択範囲の編集できるセルだけを空にし、元に戻すと元の値に戻る', () => {
  const columns = gridColumns([{key: 'id', type: 'integer', editable: false}, {key: 'title', editable: true}, {key: 'forecast_yen', type: 'integer', editable: true}], {dataset: 'works'});
  const rows = [{id: 1, title: 'A', forecast_yen: 100}, {id: 2, title: 'B', forecast_yen: 200}, {id: 3, title: 'C', forecast_yen: 300}];
  const keys = rows.map(sourceKey);
  const cleared = clearCells(rows, keys, columns, {r1: 0, r2: 1, c1: 0, c2: 2});
  assert.deepEqual(cleared.rows.map((r) => [r.id, r.title, r.forecast_yen]), [[1, '', ''], [2, '', ''], [3, 'C', 300]]);
  assert.equal(cleared.skipped, 2, 'ID列は読み取り専用');
  assert.deepEqual(applyEdits(cleared.rows, cleared.edits, 'backward'), rows);
  assert.deepEqual(applyEdits(applyEdits(cleared.rows, cleared.edits, 'backward'), cleared.edits, 'forward'), cleared.rows, 'やり直しで同じ結果');
});

test('Ctrl+D は範囲の先頭行を下へ、1行だけならすぐ上の行を写す', () => {
  const columns = gridColumns([{key: 'a', editable: true}, {key: 'b', editable: true}], {dataset: 'works'});
  const rows = [{id: 1, a: 'x', b: 'y'}, {id: 2, a: '', b: ''}, {id: 3, a: 'z', b: ''}];
  const keys = rows.map(sourceKey);
  const range = fillDown(rows, keys, columns, {r1: 0, r2: 2, c1: 0, c2: 0});
  assert.deepEqual(range.rows.map((r) => r.a), ['x', 'x', 'x']);
  const single = fillDown(rows, keys, columns, {r1: 1, r2: 1, c1: 0, c2: 1});
  assert.deepEqual([single.rows[1].a, single.rows[1].b], ['x', 'y']);
  assert.equal(fillDown(rows, keys, columns, {r1: 0, r2: 0, c1: 0, c2: 0}).edits.length, 0, '先頭行の上には写す元がない');
});

test('売上取込では表示行を超える貼付で行を足し、元に戻すと足した行も消える', () => {
  const columns = salesColumns();
  const rows = ensureRowKeys([{...SALES_SAMPLE, recognition_basis_id: '1'}], () => 'first');
  const keys = rows.map(sourceKey);
  let n = 0;
  const makeRow = (i, previous) => newSalesRow(previous, `new:${++n}`);
  const exCol = columns.findIndex((c) => c.key === 'amount_ex_tax');
  const pasted = pasteCells(rows, keys, columns, {anchor: {r: 0, c: exCol}, focus: {r: 0, c: exCol}}, '1,000\t100\n2000\t200\n3000\t300\n', {allowAppend: true, makeRow, derive: deriveSalesValues});
  assert.equal(pasted.ok, true);
  assert.equal(pasted.appended, 2);
  assert.equal(pasted.rows.length, 3);
  assert.deepEqual(pasted.rows.map((r) => [r.amount_ex_tax, r.tax_amount, r.amount_inc_tax]), [[1000, 100, 1100], [2000, 200, 2200], [3000, 300, 3300]]);
  assert.equal(pasted.rows[2].report_key, SALES_SAMPLE.report_key, '足した行は直前の行の報告キーを写す');
  assert.deepEqual(applyEdits(pasted.rows, pasted.edits, 'backward'), rows);
});

test('マスタでは表示行を超える貼付を拒み、何も変えずに「Excel一括登録で」と案内する（alert を使わない）', () => {
  const columns = gridColumns([{key: 'title', editable: true}], {dataset: 'works'});
  const rows = [{id: 1, title: 'A'}];
  const out = pasteCells(rows, rows.map(sourceKey), columns, {anchor: {r: 0, c: 0}, focus: {r: 0, c: 0}}, 'x\ny\nz');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rows');
  assert.equal(out.overflow, 2);
  assert.match(out.message, /Excel一括登録/);
  assert.equal(out.rows, rows);
  const wide = pasteCells(rows, rows.map(sourceKey), columns, {anchor: {r: 0, c: 0}, focus: {r: 0, c: 0}}, 'x\ty');
  assert.equal(wide.reason, 'columns');
  // 既存の pasteVisible の契約は変えない
  assert.throws(() => pasteVisible(rows, ['1'], [{key: 'title'}], {r: 0, c: 0}, 'a\nb'), /超えています/);
});

test('貼付は読み取り専用列を飛ばし、1セルのコピーは選択範囲全体に入れ、選択肢は名称でも受け付ける', () => {
  const columns = salesColumns();
  const rows = [{...SALES_SAMPLE, _source: {key: 'a'}}, {...SALES_SAMPLE, _source: {key: 'b'}}];
  const keys = rows.map(sourceKey);
  const kindCol = columns.findIndex((c) => c.key === 'kind');
  const partnerCol = columns.findIndex((c) => c.key === 'partner_id');
  const filled = pasteCells(rows, keys, columns, {anchor: {r: 0, c: kindCol}, focus: {r: 1, c: kindCol}}, 'ビデオグラム');
  assert.deepEqual(filled.rows.map((r) => r.kind), ['package', 'package']);
  const partner = pasteCells(rows, keys, columns, {anchor: {r: 0, c: partnerCol}, focus: {r: 0, c: partnerCol}}, 'P-B');
  assert.equal(partner.rows[0].partner_id, '3', '取引先はコードでも名称でも ID に直す');
  const incCol = columns.findIndex((c) => c.key === 'amount_inc_tax');
  const skipped = pasteCells(rows, keys, columns, {anchor: {r: 0, c: incCol - 1}, focus: {r: 0, c: incCol - 1}}, '50\t9999');
  assert.equal(skipped.skipped, 1, '税込額（計算列）には貼らない');
  assert.equal(skipped.rows[0].tax_amount, 50);
});

test('「選択行を削除」は選択範囲の行すべてを消し、元に戻すと同じ位置へ戻る', () => {
  const rows = ['a', 'b', 'c', 'd'].map((k) => ({v: k, _source: {key: k}}));
  const keys = rows.map(sourceKey);
  const picked = selectedRowKeys(keys, {anchor: {r: 2, c: 3}, focus: {r: 1, c: 0}});
  assert.deepEqual(picked, ['b', 'c']);
  const removed = deleteRowsByKeys(rows, picked);
  assert.deepEqual(removed.rows.map((r) => r.v), ['a', 'd']);
  assert.deepEqual(applyEdits(removed.rows, removed.edits, 'backward').map((r) => r.v), ['a', 'b', 'c', 'd']);
});

test('識別子の無い行に位置に依存しない識別子を付け、既にある行はそのまま', () => {
  const rows = [{id: 5}, {_source: {key: 'k'}}, {x: 1}];
  const out = ensureRowKeys(rows, (i) => `new:${i}`);
  assert.equal(out[0], rows[0]);
  assert.equal(out[1], rows[1]);
  assert.equal(out[2]._source.key, 'new:2');
  assert.equal(unsavedCount(out, out), 0);
  assert.equal(unsavedCount(out, [out[0], out[1], {...out[2], x: 2}]), 1, '識別子をそろえた行どうしなら変更は1件');
});

test('表示: 数値は桁区切り、日付・月・選択肢・参照は日本語、未知の値は理由を添える', () => {
  const columns = salesColumns();
  const col = (k) => columns.find((c) => c.key === k);
  assert.equal(gridCellText(col('amount_ex_tax'), '1200000'), '1,200,000');
  assert.equal(gridCellText(col('amount_ex_tax'), -5000), '-5,000');
  assert.equal(gridCellText(col('report_received_on'), '2026-10-05'), '2026/10/05');
  assert.equal(gridCellText(col('sales_month'), '2026-09'), '2026年9月');
  assert.equal(gridCellText(col('kind'), 'digital'), '配信');
  assert.equal(gridCellText(col('recognition_basis_id'), '2'), '報告受領月');
  assert.equal(gridCellText(col('partner_id'), 2), '配信プラットフォームA（P-A）');
  assert.match(gridCellText(col('partner_id'), 99), /候補にありません/);
  assert.match(gridCellText(col('kind'), 'xyz'), /未登録の値/);
  assert.equal(gridCellText(col('amount_ex_tax'), ''), '');
  assert.ok(!col('kind').options.some((o) => o.value === 'publicity'), '売上取込の報告種別に宣伝は出さない');
  assert.equal(col('amount_ex_tax').numeric, true);
  assert.equal(normalizeCellInput(col('report_received_on'), '2026/9/1'), '2026-09-01');
  assert.equal(normalizeCellInput(col('sales_month'), '2026年9月'), '2026-09');
  assert.equal(normalizeCellInput(col('recognition_basis_id'), '販売月'), '1');
  assert.match(cellIssue(col('amount_ex_tax'), '12a'), /整数/);
  assert.match(cellIssue(col('report_received_on'), '2026/09/01'), /2026-09-01/);
});

test('「全件を検証」の失敗本体を行・セルに結び付け、行番号は表の行（CSVの見出しを除いた行）とそろえる', () => {
  const columns = salesColumns();
  const rows = [
    {...SALES_SAMPLE, amount_ex_tax: '1000', tax_amount: '100', amount_inc_tax: '1100', _source: {key: 'a'}},
    {...SALES_SAMPLE, amount_ex_tax: '1000', tax_amount: '100', amount_inc_tax: '999', _source: {key: 'b', row: 7}},
    {...SALES_SAMPLE, accounting_month: '2026-13', _source: {key: 'c'}},
  ];
  // サーバーの応答（422）の details。rowNo は CSV の行（見出し＝1行目）なので 3 は表の2行目。
  const mapped = mapRowErrors([
    {rowNo: 3, message: '税込額が税抜額＋税額と一致しません'},
    {rowNo: 4, message: '計上月はYYYY-MM形式です: 2026-13'},
    {rowNo: 0, message: '同一報告は登録済みです'},
  ], {rows, columns});
  assert.deepEqual(mapped.items.map((item) => [item.gridRow, item.column]), [[null, null], [2, 'amount_inc_tax'], [3, 'accounting_month']]);
  assert.equal(mapped.items[1].sourceRow, 7, '原本の行も添える');
  assert.ok(mapped.cells.get(cellErrorKey('b', 'amount_inc_tax')));
  assert.match(mapped.cells.get(cellErrorKey('c', 'accounting_month')), /計上月は月（例: 2026-09）で入力してください（入力: 2026-13）/);
  // サーバーが下書きの行（inputRow）を返したときは、加工手順があってもそれを使う
  const withSteps = mapRowErrors([{rowNo: 2, inputRow: 3, message: '税込額が税抜額＋税額と一致しません'}], {rows, columns, hasSteps: true});
  assert.equal(withSteps.items[0].gridRow, 3);
  const unknown = mapRowErrors([{rowNo: 2, message: '税込額が税抜額＋税額と一致しません'}], {rows, columns, hasSteps: true});
  assert.equal(unknown.items[0].gridRow, null, '加工手順で行が変わるときは推測で結び付けない');
});

test('行エラーの英語の例外文を日本語にし、値から列を推し量る', () => {
  const columns = gridColumns([
    {key: 'service_code', label: '配信サービスコード'}, {key: 'digital_model', label: '配信方式'},
    {key: 'sales_count', label: '販売件数', type: 'integer'}, {key: 'unit_price_ex_tax', label: '販売単価税抜'},
    {key: 'quantity', label: '数量', type: 'integer'},
  ], {dataset: 'sales_import'});
  assert.equal(describeRowError('service_code is required for digital detail', {columns}), '配信サービスコードを入力してください');
  assert.equal(describeRowError('sales_count is required with unit_price_ex_tax', {columns}), '販売単価税抜を入れる行には販売件数も必要です');
  assert.equal(describeRowError('digital_model is required and must be a recognized model', {columns}), '配信方式を選択肢から選んでください');
  assert.match(describeRowError('SVOD/AVOD cannot carry sale count, unit price or contract amount'), /SVOD・AVOD/);
  assert.equal(errorColumn('整数ではありません: 1.5', {quantity: '1.5'}, columns), 'quantity');
  assert.equal(errorColumn('service_code is required for digital detail', {}, columns), 'service_code');
  assert.equal(describeRowError('整数ではありません: ', {columns, column: 'quantity'}), '数量は整数で入力してください（空欄です）');
});

test('段階表示: 読込→加工→検証→承認申請→承認→反映と次の操作', () => {
  const stateOf = (input) => workflowState({loaded: true, ...input});
  assert.equal(stateOf({}).next.enabled, false, '変更が無いうちは保存しない');
  assert.equal(stateOf({hasChanges: true}).next.action, 'save');
  assert.equal(stateOf({draft: {id: 'd'}, dirty: false}).next.action, 'validate');
  assert.equal(stateOf({draft: {id: 'd'}, dirty: true}).next.action, 'save');
  const errors = stateOf({draft: {id: 'd'}, errorCount: 2});
  assert.equal(errors.current, 'validate');
  assert.equal(errors.next.action, null);
  const noReason = stateOf({draft: {id: 'd'}, validation: {id: 'v'}});
  assert.equal(noReason.next.action, 'submit');
  assert.equal(noReason.next.enabled, false);
  assert.equal(stateOf({draft: {id: 'd'}, validation: {id: 'v'}, reason: '誤字の修正'}).next.enabled, true);
  assert.equal(stateOf({changeSet: {status: 'submitted'}, role: 'admin'}).next.action, 'approve');
  assert.equal(stateOf({changeSet: {status: 'submitted'}, role: 'editor'}).next.label, '管理者の承認待ち');
  assert.equal(stateOf({changeSet: {status: 'approved'}}).next.action, 'apply');
  const done = stateOf({changeSet: {status: 'applied'}});
  assert.equal(done.next.action, 'restart');
  assert.ok(done.stages.every((stage) => stage.state === 'done'));
  const approving = stateOf({changeSet: {status: 'submitted'}, role: 'admin'});
  assert.deepEqual(approving.stages.map((stage) => stage.state), ['done', 'done', 'done', 'done', 'current', 'todo']);
  assert.deepEqual(approving.stages.map((stage) => stage.label), ['読込', '加工', '検証', '承認申請', '承認', '反映']);
  assert.equal(stateOf({hasChanges: true, readOnly: true}).next.enabled, false, '設計キャンバスのプレビューでは保存しない');
  assert.equal(stateOf({locked: true}).next.enabled, false);
});

test('下書きは名称・状態（日本語）・JSTの日時で表示し、IDを出さない', () => {
  const label = draftLabel({id: 'draft_123', status: 'submitted', revision: 2, rowCount: 12, updatedAt: '2026-09-24 00:18:32'},
    {datasetLabel: '売上取込', changeSet: {status: 'submitted', reason: '9月分の配信報告'}});
  assert.equal(label, '売上取込・「9月分の配信報告」・12行・第2版・承認申請中・2026/09/24 09:18');
  assert.doesNotMatch(label, /draft_|submitted/);
  assert.match(draftLabel({status: 'draft', updatedAt: '2026-09-24T15:30:00Z'}, {datasetLabel: '作品'}), /下書き・2026\/09\/25 00:30$/);
});

test('権限外のデータセットは理由つきで施錠する', () => {
  assert.deepEqual(datasetAccess('partners', 'editor'), {locked: true, reason: '管理者のみ編集できます'});
  assert.deepEqual(datasetAccess('products', 'admin'), {locked: false, reason: ''});
  assert.equal(datasetAccess('works', 'editor').locked, false);
  assert.equal(datasetAccess('sales_import', 'production').locked, true);
  assert.equal(datasetAccess('works', 'production').locked, true);
});

test('表示中の表を日本語見出しで出力し、行番号とエラー内容を添える（Excel・CSV）', () => {
  const columns = salesColumns();
  const rows = [
    {...SALES_SAMPLE, partner_id: '2', amount_ex_tax: '1000', tax_amount: '100', amount_inc_tax: '1100', _source: {key: 'a'}},
    {...SALES_SAMPLE, partner_id: '3', amount_ex_tax: '2000', tax_amount: '200', amount_inc_tax: '9', _source: {key: 'b'}},
  ];
  const errors = mapRowErrors([{rowNo: 3, message: '税込額が税抜額＋税額と一致しません'}], {rows, columns});
  const sheet = workbenchSheet({title: '売上取込', columns, rows: [rows[1]], allRows: rows, errors});
  const table = specTable(sheet, {mode: 'raw'});
  assert.deepEqual(table.header.slice(0, 4), ['行', '報告キー', '報告種別', '取引先']);
  assert.equal(table.header.at(-1), 'エラー内容');
  assert.equal(table.rows[0][0], 2, '行番号は表全体の行（絞込後も同じ）');
  assert.equal(table.rows[0][2], '配信');
  assert.equal(table.rows[0][3], 'レンタル店B（P-B）');
  assert.match(table.rows[0].at(-1), /税込額/);
  assert.equal(table.rows.at(-1)[0], '合計（1行）');
  const bytes = encodeReportXlsx({sheets: [sheet]});
  assert.ok(bytes.length > 500);
});

test('計上月は計上基準のある行では計算列、基準の無い行では手で入力できる', async () => {
  const {cellEditable} = await import('../src/workbench-ui.mjs');
  const columns = salesColumns();
  const month = columns.find((c) => c.key === 'accounting_month');
  assert.equal(cellEditable(month, {recognition_basis_id: '1', sales_month: '2026-09'}), false);
  assert.equal(cellEditable(month, {recognition_basis_id: '', accounting_month: '2026-13'}), true);
  assert.equal(cellEditable(columns.find((c) => c.key === 'amount_inc_tax'), {recognition_basis_id: ''}), false, '税込額は常に計算');
  const rows = [{...SALES_SAMPLE, recognition_basis_id: '', accounting_month: '2026-13', _source: {key: 'a'}}];
  const at = columns.findIndex((c) => c.key === 'accounting_month');
  const pasted = pasteCells(rows, ['a'], columns, {anchor: {r: 0, c: at}, focus: {r: 0, c: at}}, '2026/9', {derive: deriveSalesValues});
  assert.equal(pasted.rows[0].accounting_month, '2026-09');
  const readOnly = gridColumns(SALES_META, {dataset: 'sales_import', readOnly: true}).find((c) => c.key === 'accounting_month');
  assert.equal(cellEditable(readOnly, {recognition_basis_id: ''}), false, '申請済み・加工結果の表示中は入力しない');
  assert.match(describeRowError('税込額が税抜額＋税額と一致しません'), /計算し直す/);
});
