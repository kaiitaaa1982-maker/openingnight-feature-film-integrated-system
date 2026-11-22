// 編集できる表（EditSheet）の論理: 貼付で行が増える、型に合わない値と候補に無い ID は入らない、
// 絞り込みと合計の行、選んだ範囲の集計、1つ戻す、集計のシート。値はすべて架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sheetColumns, sheetView, sheetTotals, rangeStats, parseCell, pasteCells, applyEdits, invertEdits, writeCell, setCells,
  sheetCellText, sheetCandidates, cellProblem, filterChoices, nextFilter, summarize, sourceKey,
  selectionInfo, rowHeadSelection, columnForRow, historyAfterEpoch,
} from '../src/ui/edit-sheet-model.mjs';

const PAYEES = [{value: 'P1', label: '架空弁当', code: 'K-01'}, {value: 'P2', label: '架空パーキング', code: 'K-02'}];
const CATS = [{value: 'C1', label: '弁当'}, {value: 'C2', label: '駐車'}];
const columns = (extra = {}) => sheetColumns([
  {key: 'd', label: '日付', type: 'date', year: 2026},
  {key: 'n', label: '支払先', type: 'lookup', options: PAYEES, ...extra},
  {key: 'c', label: '費目', type: 'lookup', options: CATS},
  {key: 'memo', label: '内容'},
  {key: 'y', label: '金額', type: 'yen'},
]);
const detail = () => [
  {id: 1, d: '2026-11-17', n: 'P1', c: 'C1', memo: '昼', y: 28800},
  {id: 2, d: '2026-11-17', n: 'P2', c: 'C2', memo: '2台', y: 1800},
  {id: 3, d: '2026-11-18', n: 'P1', c: 'C1', memo: '夜', y: 30600},
];
let next = 100;
const makeRow = () => ({id: next++, d: '', n: '', c: '', memo: '', y: null});

test('Excel から2行×3列を貼ると、最後の行を越えた分だけ行が増え、1つ戻すと元の行に戻る', () => {
  const cols = columns();
  const rows = detail();
  const keys = rows.map(sourceKey);
  // 最後の行（3行目）の日付の列から、2行×3列（日付・支払先・費目）を貼る
  const text = '2026/11/19\t架空弁当\t弁当\n11/20\tK-02\t駐車\n';
  const pasted = pasteCells(rows, keys, cols, {anchor: {r: 2, c: 0}, focus: {r: 2, c: 0}}, text, {allowAppend: true, makeRow: () => makeRow(), read: parseCell});
  assert.equal(pasted.ok, true);
  assert.equal(pasted.appended, 1, '3行目に1行目を、越えた1行は足す');
  assert.equal(pasted.rows.length, 4);
  assert.deepEqual(pasted.rows.slice(2).map((r) => [r.d, r.n, r.c]), [['2026-11-19', 'P1', 'C1'], ['2026-11-20', 'P2', 'C2']]);
  assert.equal(pasted.rejected, 0);
  assert.deepEqual(applyEdits(pasted.rows, invertEdits(pasted.edits)), rows, '1つ戻すと足した行も消える');
});

test('型に合わない値（文字の金額・無い日付）は入らず、入らなかったセルの位置を返す', () => {
  const cols = columns();
  assert.deepEqual(parseCell(cols[4], '１２，０００円'), {ok: true, value: 12000});
  assert.equal(parseCell(cols[4], 'たくさん').ok, false);
  assert.equal(parseCell(cols[0], '2026/2/30').ok, false);
  assert.deepEqual(parseCell(cols[0], '11/19'), {ok: true, value: '2026-11-19'}, '月/日だけなら列の年を補う');
  const rows = detail();
  const keys = rows.map(sourceKey);
  const out = pasteCells(rows, keys, cols, {anchor: {r: 0, c: 3}, focus: {r: 0, c: 3}}, '弁当 追加\tたくさん', {read: parseCell});
  assert.equal(out.ok, true);
  assert.equal(out.rows[0].memo, '弁当 追加');
  assert.equal(out.rows[0].y, 28800, '金額は変わらない');
  assert.equal(out.rejected, 1);
  assert.deepEqual(out.rejectedCells, [{r: 0, c: 4}]);
  assert.equal(cellProblem(cols[4], {y: '12a'}), '数ではありません', '入っている値が型に合わなければ赤の枠の理由を返す');
  assert.equal(cellProblem(cols[4], {y: 12}), '');
});

test('ID で結ぶ列は候補に無い名前を入れず、名前・コードは ID に直し、登録の道があれば名前を返す', () => {
  const cols = columns();
  assert.deepEqual(parseCell(cols[1], '架空弁当'), {ok: true, value: 'P1'});
  assert.deepEqual(parseCell(cols[1], 'k-02'), {ok: true, value: 'P2'}, 'コード（全角半角・大小を問わない）');
  assert.deepEqual(parseCell(cols[1], '架空パ'), {ok: true, value: 'P2'}, '前方一致で1つに絞れるときはそれ');
  assert.equal(parseCell(cols[1], '架空').ok, false, '2つに当たるときは決めない');
  assert.equal(parseCell(cols[1], '見知らぬ商店').ok, false);
  const rows = detail();
  const out = pasteCells(rows, rows.map(sourceKey), cols, {anchor: {r: 1, c: 1}, focus: {r: 1, c: 1}}, '見知らぬ商店', {read: parseCell});
  assert.equal(out.rows[1].n, 'P2', '候補に無い ID は入らない');
  assert.equal(out.rejected, 1);
  assert.equal(sheetCandidates(cols[1], '見知らぬ商店').create, null, '登録の道が無い列は出さない');
  const withCreate = columns({onCreate: () => null});
  assert.equal(sheetCandidates(withCreate[1], '見知らぬ商店').create, '見知らぬ商店');
  assert.equal(sheetCandidates(withCreate[1], '架空弁当').create, null, '同じ名前があれば登録の道は出さない');
  assert.deepEqual(sheetCandidates(withCreate[1], '弁当').options.map((o) => o.value), ['P1']);
  assert.equal(sheetCellText(cols[1], {n: 'P2'}), '架空パーキング', 'セルには名前を出す');
});

test('絞り込むと合計の行は見えている行の合計に変わり、並べ替えは行の順を変えない', () => {
  const cols = columns();
  const rows = detail();
  assert.deepEqual(sheetTotals(sheetView(rows, cols).rows, cols), {y: 61200});
  const choices = filterChoices(rows, cols[1]);
  assert.deepEqual(choices, ['架空パーキング', '架空弁当']);
  const filter = nextFilter(choices, ['架空弁当']);
  assert.deepEqual(filter, ['架空弁当']);
  const view = sheetView(rows, cols, {filters: {n: filter}});
  assert.deepEqual(view.keys, ['1', '3']);
  assert.deepEqual(sheetTotals(view.rows, cols), {y: 59400});
  assert.equal(nextFilter(choices, choices), null, '全部を選べば絞らない');
  assert.deepEqual(sheetView(rows, cols, {filters: {n: []}}).keys, [], '何も選ばなければ1行も見せない');
  const sorted = sheetView(rows, cols, {sort: {key: 'y', dir: 'asc'}});
  assert.deepEqual(sorted.keys, ['2', '1', '3']);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3], '元の行の並びは変えない');
});

test('選んだ範囲の合計・件数・平均は数の列のセルから出し、文字の列は空でないセルだけ数える', () => {
  const cols = columns();
  const rows = detail();
  const stats = rangeStats(rows, cols, {r1: 0, r2: 2, c1: 3, c2: 4});
  assert.deepEqual(stats, {cells: 6, filled: 6, count: 3, sum: 61200, average: 20400, yen: true});
  const text = rangeStats(rows, cols, {r1: 0, r2: 1, c1: 1, c2: 2});
  assert.equal(text.count, 0);
  assert.equal(text.average, null);
  assert.equal(text.filled, 4);
});

test('1つ戻すと直したセルは前の値に、空の行に打って足した行は消える', () => {
  const cols = columns();
  const rows = detail();
  const keys = rows.map(sourceKey);
  const changed = writeCell(rows, keys, cols, {r: 1, c: 4}, 2100);
  assert.deepEqual(changed.edits, [{type: 'cell', key: '2', field: 'y', before: 1800, after: 2100}]);
  assert.deepEqual(applyEdits(changed.rows, invertEdits(changed.edits)), rows);
  const added = writeCell(rows, keys, cols, {r: 3, c: 3}, '追加', {makeRow});
  assert.equal(added.rows.length, 4);
  assert.equal(added.rows[3].memo, '追加');
  assert.equal(added.edits[0].type, 'insert');
  assert.deepEqual(applyEdits(added.rows, invertEdits(added.edits)), rows);
  // 前へ当てる戻しは、後ろ向きの適用と同じ結果
  const both = setCells(rows, [{key: '1', field: 'memo', value: 'x'}, {key: '1', field: 'y', value: 1}]);
  assert.deepEqual(applyEdits(both.rows, invertEdits(both.edits)), applyEdits(both.rows, both.edits, 'backward'));
});

test('計算の列・率の列・読むだけの表は直せない', () => {
  const cols = sheetColumns([{key: 'a'}, {key: 'b', type: 'int', value: (row) => row.a.length}, {key: 'p', type: 'rate'}]);
  assert.deepEqual(cols.map((c) => c.editable), [true, false, false]);
  assert.deepEqual(sheetColumns([{key: 'a'}], {readOnly: true}).map((c) => c.editable), [false]);
  const rows = [{id: 1, a: 'x'}];
  const out = pasteCells(rows, ['1'], cols, {anchor: {r: 0, c: 0}, focus: {r: 0, c: 0}}, 'yy\t9', {read: parseCell});
  assert.equal(out.rows[0].a, 'yy');
  assert.equal(out.skipped, 1, '計算の列には貼らない');
  assert.equal(sheetCellText(cols[2], {p: 0.234}), '23.4%');
});

test('集計のシートは明細から件数・和・構成比を出す（最初に現れた順）', () => {
  const rows = detail();
  const byPayee = summarize(rows, (row) => row.n, {measures: {y: (row) => row.y}, share: 'y'});
  assert.deepEqual(byPayee.map((g) => [g.key, g.count, g.y]), [['P1', 2, 59400], ['P2', 1, 1800]]);
  assert.equal(Math.round(byPayee[0].share * 1000), 971);
  assert.equal(byPayee.reduce((sum, g) => sum + g.share, 0), 1);
});

test('選択を呼び出し側へ渡す: 範囲に入っている見えている行の鍵と、2セル以上か。最後の空の行は入れない', () => {
  const keys = ['line:3', 'line:1', 'line:2'];
  assert.deepEqual(selectionInfo({r1: 1, r2: 1, c1: 2, c2: 2}, keys), {range: false, rowKeys: ['line:1'], visibleKeys: keys});
  assert.deepEqual(selectionInfo({r1: 0, r2: 1, c1: 0, c2: 0}, keys), {range: true, rowKeys: ['line:3', 'line:1'], visibleKeys: keys});
  // 1行の中で2列を選んでも範囲。空の行（3行目の次）まで伸ばしても鍵は見えている行だけ
  assert.equal(selectionInfo({r1: 2, r2: 2, c1: 0, c2: 1}, keys).range, true);
  assert.deepEqual(selectionInfo({r1: 2, r2: 3, c1: 0, c2: 0}, keys).rowKeys, ['line:2']);
  assert.deepEqual(selectionInfo(null, keys), {range: false, rowKeys: [], visibleKeys: keys});
});

test('行番号を押すとその行の全部の列、Shift を押しながら押すと起点の行から押した行まで', () => {
  const current = {anchor: {r: 1, c: 2}, focus: {r: 1, c: 2}};
  assert.deepEqual(rowHeadSelection(current, 4, 5), {anchor: {r: 4, c: 0}, focus: {r: 4, c: 4}});
  assert.deepEqual(rowHeadSelection(current, 4, 5, {extend: true}), {anchor: {r: 1, c: 0}, focus: {r: 4, c: 4}});
  assert.deepEqual(rowHeadSelection(current, 0, 5, {extend: true}), {anchor: {r: 1, c: 0}, focus: {r: 0, c: 4}}, '上へも広がる');
  assert.deepEqual(rowHeadSelection(null, 2, 0, {extend: true}), {anchor: {r: 2, c: 0}, focus: {r: 2, c: 0}});
});

test('行ごとの候補: candidatesFor(row) の候補だけで選び・読み、表示の名前は列の候補から引く。行が無ければ列の候補のまま', () => {
  const days = [{value: '21', label: '11/21 3日目'}, {value: '22', label: '11/22 4日目'}, {value: 'drop', label: '欠番'}];
  const [to] = sheetColumns([{key: 'to', label: '移し先', type: 'lookup', options: days,
    candidatesFor: (row) => days.filter((option) => option.value !== String(row.lastDayId))}]);
  const row = {id: 's1', lastDayId: 21, to: ''};
  const own = columnForRow(to, row);
  assert.deepEqual(sheetCandidates(own, '').options.map((option) => option.value), ['22', 'drop']);
  assert.deepEqual(parseCell(own, '11/21'), {ok: false, error: '候補にありません'}, 'その行で外した候補は入らない');
  assert.deepEqual(parseCell(own, '11/22 4日目'), {ok: true, value: '22'});
  assert.equal(columnForRow(to, null), to, '空の行は列の候補');
  assert.equal(sheetCellText(to, {...row, to: '21'}), '11/21 3日目', '表示は列の候補から');
  // 貼付の読み取りには貼る先の行が渡る（足す行は null）
  const seen = [];
  const pasted = pasteCells([row], ['s1'], [to], {anchor: {r: 0, c: 0}, focus: {r: 0, c: 0}}, '11/21\n11/22 4日目', {
    allowAppend: true, makeRow: () => ({id: 'n1', lastDayId: 99, to: ''}),
    read: (column, text, target) => { seen.push(target?.id ?? null); return parseCell(columnForRow(column, target), text); }});
  assert.deepEqual(seen, ['s1', null]);
  assert.deepEqual([pasted.rejected, pasted.rows.map((r) => r.to)], [1, ['', '22']]);
});

test('戻すの履歴: 呼び出し側の historyEpoch が変わったら空にし、同じなら残す', () => {
  const history = [{sheet: 'a', edits: [{type: 'cell'}]}];
  assert.equal(historyAfterEpoch(history, 3, 3), history);
  assert.deepEqual(historyAfterEpoch(history, 3, 4), []);
  assert.equal(historyAfterEpoch(history, undefined, undefined), history, '渡さない画面（表の見本・業務データ編集）は変わらない');
});
