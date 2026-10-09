import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sortRows, filterRows, totalsFor, withSubtotals, cellText, limitItems, gridSheetSpec, describeFilters, countText, totalText,
  inferColumns, parseComparison, totalsValues, ignoresRowToggle, NULL_FILTER, RENDER_LIMIT,
} from '../src/ui/grid-model.mjs';

const columns = [
  {key: 'code', label: '作品コード', type: 'id', sticky: true},
  {key: 'title', label: '作品名', type: 'text'},
  {key: 'partner', label: '取引先', type: 'text'},
  {key: 'channel', label: '流通', type: 'status', domain: 'productChannel'},
  {key: 'amount', label: '税抜', type: 'yen'},
  {key: 'qty', label: '数量', type: 'int', total: 'sum'},
  {key: 'mg', label: 'MG契約額', type: 'yen', total: 'not-summable'},
  {key: 'share', label: '構成比', type: 'rate'},
  {key: 'on', label: '計上日', type: 'date'},
];
const rows = [
  {id: 1, code: '001', title: '風のあとさき', partner: '架空配信', channel: 'digital', amount: 1200, qty: 3, mg: 500000, share: 0.1, on: '2026-09-01'},
  {id: 2, code: '002', title: '作品10', partner: '架空劇場', channel: 'theatrical', amount: null, qty: 1, mg: 500000, share: 0.2, on: '2026-08-15'},
  {id: 3, code: '003', title: '作品2', partner: '架空配信', channel: 'package', amount: -300, qty: null, mg: 500000, share: 0.3, on: null},
  {id: 4, code: '004', title: 'ＡＢＣ作品', partner: '架空劇場', channel: 'digital', amount: 10000, qty: 2, mg: 800000, share: 0.4, on: '2026-09-30'},
  {id: 5, code: '005', title: '作品1', partner: '架空配信', channel: 'unknown_x', amount: '200', qty: 5, mg: 800000, share: null, on: '2026-10-01'},
];
const ids = (list) => list.map((row) => row.id);

test('並べ替え: 数値・文字・日付、null は向きにかかわらず末尾、同順位は元の順', () => {
  assert.deepEqual(ids(sortRows(rows, columns, {key: 'amount', dir: 'asc'})), [3, 5, 1, 4, 2]);
  assert.deepEqual(ids(sortRows(rows, columns, {key: 'amount', dir: 'desc'})), [4, 1, 5, 3, 2]);
  assert.deepEqual(ids(sortRows(rows, columns, {key: 'on', dir: 'asc'})), [2, 1, 4, 5, 3]);
  assert.deepEqual(ids(sortRows(rows, columns, {key: 'on', dir: 'desc'})), [5, 4, 1, 2, 3]);
  assert.deepEqual(ids(sortRows(rows, columns, {key: 'share', dir: 'desc'})), [4, 3, 2, 1, 5]);
  const titles = sortRows(rows.filter((row) => row.title.startsWith('作品')), columns, {key: 'title', dir: 'asc'}).map((row) => row.title);
  assert.deepEqual(titles, ['作品1', '作品2', '作品10']);
  assert.deepEqual(ids(sortRows(rows, columns, {key: 'mg', dir: 'asc'})), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids(sortRows(rows, columns, null)), [1, 2, 3, 4, 5]);
  const sorted = sortRows(rows, columns, {key: 'amount', dir: 'asc'});
  assert.notEqual(sorted, rows);
  assert.deepEqual(ids(rows), [1, 2, 3, 4, 5]);
});

test('並べ替え: 状態列は日本語名の順', () => {
  const byLabel = sortRows(rows, columns, {key: 'channel', dir: 'asc'}).map((row) => cellText(columns[3], row.channel));
  assert.deepEqual(byLabel, [...byLabel].sort(new Intl.Collator('ja-JP', {numeric: true, sensitivity: 'base'}).compare));
});

test('絞込: 文字は全角半角を吸収、数値と日付は比較式、選択は値の一致、全体検索は語をすべて含む行', () => {
  assert.deepEqual(ids(filterRows(rows, columns, {title: 'abc'})), [4]);
  assert.deepEqual(ids(filterRows(rows, columns, {amount: '>=1000'})), [1, 4]);
  assert.deepEqual(ids(filterRows(rows, columns, {amount: '<0'})), [3]);
  assert.deepEqual(ids(filterRows(rows, columns, {amount: '100..1,500'})), [1, 5]);
  assert.deepEqual(ids(filterRows(rows, columns, {on: '2026-09'})), [1, 4]);
  assert.deepEqual(ids(filterRows(rows, columns, {on: '2026-08..2026-09'})), [1, 2, 4]);
  assert.deepEqual(ids(filterRows(rows, columns, {on: '>2026-09'})), [5]);
  assert.deepEqual(ids(filterRows(rows, columns, {channel: ['digital']})), [1, 4]);
  assert.deepEqual(ids(filterRows(rows, columns, {on: [NULL_FILTER]})), [3]);
  assert.deepEqual(ids(filterRows(rows, columns, {amount: '未確認'})), [2]);
  assert.deepEqual(ids(filterRows(rows, columns, {}, '架空配信 作品')), [3, 5]);
  assert.deepEqual(ids(filterRows(rows, columns, {}, '配信')), [1, 3, 4, 5]); // 流通「配信」の日本語名でも当たる
  const hiddenPartner = columns.map((c) => (c.key === 'partner' ? {...c, searchable: false} : c));
  assert.deepEqual(ids(filterRows(rows, hiddenPartner, {}, '架空劇場')), []);
  assert.deepEqual(ids(filterRows(rows, columns, {amount: ''}, '  ')), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseComparison('≧1000'), null);
  assert.deepEqual(parseComparison('＞＝１，０００'), {op: '>=', value: '1000'});
});

test('合計: 絞込後の全行を足し、合計不可の列は数値を出さず、未確認は件数で示す', () => {
  const filtered = filterRows(rows, columns, {partner: '架空配信'});
  const totals = totalsFor(filtered, columns);
  assert.deepEqual(totals.amount, {value: 1100, count: 3, missing: 0});
  assert.deepEqual(totals.qty, {value: 8, count: 2, missing: 1});
  assert.deepEqual(totals.mg, {notSummable: true});
  assert.equal(totals.share, undefined);
  assert.equal(totals.title, undefined);
  assert.equal(totalText(columns[6], totals.mg), '合計不可');
  assert.equal(totalText(columns[5], totals.qty), '8（未確認1件を除く）');
  const all = totalsFor(rows, columns);
  assert.deepEqual(all.amount, {value: 11100, count: 4, missing: 1});
  assert.deepEqual(totalsValues(all).mg, '合計不可');
});

test('小計: 取引先ごとの小計の合計が総合計と一致し、行はグループにまとまる', () => {
  const items = withSubtotals(rows, columns, 'partner');
  const subtotals = items.filter((item) => item.type === 'subtotal');
  assert.deepEqual(subtotals.map((s) => s.label), ['架空配信 小計', '架空劇場 小計']);
  assert.deepEqual(subtotals.map((s) => s.count), [3, 2]);
  const total = totalsFor(rows, columns);
  for (const key of ['amount', 'qty']) {
    assert.equal(subtotals.reduce((sum, s) => sum + s.totals[key].value, 0), total[key].value, key);
  }
  assert.deepEqual(items.filter((item) => item.type === 'row').map((item) => item.row.id), [1, 3, 5, 2, 4]);
  const byChannel = withSubtotals(rows, columns, 'channel', '計');
  assert.deepEqual(byChannel.filter((item) => item.type === 'subtotal').map((s) => s.label), ['配信 計', '劇場 計', 'ビデオグラム 計', '未登録の値（unknown_x） 計']);
  const custom = withSubtotals(rows, columns, (row) => row.on?.slice(0, 7), (value, members) => `${value ?? '日付なし'}（${members.length}件）`);
  assert.ok(custom.some((item) => item.label === '日付なし（1件）'));
});

test('セル表示: null は未確認、0は blankZero で「—」、状態は日本語、未知の値は明示', () => {
  assert.equal(cellText(columns[4], null), '未確認');
  assert.equal(cellText(columns[4], 0, {blankZero: true}), '—');
  assert.equal(cellText(columns[4], -1234), '-1,234');
  assert.equal(cellText(columns[3], 'digital'), '配信');
  assert.equal(cellText(columns[3], 'unknown_x'), '未登録の値（unknown_x）');
  assert.equal(cellText(columns[7], 0.25), '25.0%');
  assert.equal(cellText(columns[8], '2026-09-01'), '2026/09/01');
  assert.equal(cellText(columns[0], '001'), '001');
});

test('描画は2,000行まで。超えたら件数を返し、黙って切らない', () => {
  const many = Array.from({length: RENDER_LIMIT + 1}, (_, i) => ({type: 'row', row: {id: i}}));
  const limited = limitItems(many);
  assert.equal(RENDER_LIMIT, 2000);
  assert.equal(limited.rowsShown, 2000);
  assert.equal(limited.rowsTotal, 2001);
  assert.equal(limited.truncated, true);
  const grouped = limitItems([{type: 'row'}, {type: 'subtotal'}, {type: 'row'}, {type: 'row'}, {type: 'subtotal'}], 2);
  assert.deepEqual(grouped.items.map((item) => item.type), ['row', 'subtotal', 'row']);
  assert.equal(countText(5, 5), '全5行');
  assert.equal(countText(2500, 1200), '全2,500行中1,200行');
});

test('出力用のシート定義: 表示中の列・並び・絞込条件・合計（合計不可を含む）・小計', () => {
  const visibleColumns = columns.map((c) => (c.key === 'share' ? {...c, hidden: true} : {...c, render: () => 'x'}));
  const filters = {partner: '架空配信', channel: ['digital', NULL_FILTER]};
  const filtered = filterRows(rows, visibleColumns, {partner: '架空配信'});
  const spec = gridSheetSpec({columns: visibleColumns, rows: filtered, exportSpec: {name: '売上明細', title: '売上明細一覧', conditions: [['期間', '2026-09']], dataAsOf: '2026-09-24T00:00:00Z'}, filters, query: '作品'});
  assert.equal(spec.name, '売上明細');
  assert.equal(spec.title, '売上明細一覧');
  assert.deepEqual(spec.conditions[0], ['期間', '2026-09']);
  assert.deepEqual(spec.conditions[1], ['絞込', '取引先: 架空配信 ／ 流通: 配信・未確認（空欄） ／ 検索: 作品']);
  assert.ok(!spec.columns.some((c) => c.key === 'share'));
  assert.ok(spec.columns.every((c) => !('render' in c)));
  assert.equal(spec.freezeCols, 1);
  assert.deepEqual(spec.totals, [{label: '合計（3行）', values: {amount: 1100, qty: 8, mg: '合計不可'}}]);
  const grouped = gridSheetSpec({columns, rows, groupBy: 'partner'});
  const subtotalRows = grouped.rows.filter((row) => row.__kind === 'subtotal');
  assert.deepEqual(subtotalRows.map((row) => row.code), ['架空配信 小計', '架空劇場 小計']);
  assert.equal(subtotalRows[0].mg, '合計不可');
  assert.equal(grouped.totals[0].values.amount, 11100);
  assert.equal(describeFilters(columns, {}, ''), '');
});

test('汎用一覧の列を行から推し量り、ID を名称に直す', () => {
  const data = [{id: 7, org_id: 1, project_id: 3, code: 'P-1', status: 'active', budget_yen: 1200000, created_at: '2026-09-01 00:00:00', mystery: 'x'}];
  const inferred = inferColumns(data, {resource: 'projects', lookups: {project_id: [{id: 3, code: 'PRJ-3', title: '架空企画'}]}});
  const byKey = Object.fromEntries(inferred.map((c) => [c.key, c]));
  assert.equal(byKey.id.hidden, true);
  assert.equal(byKey.org_id.hidden, true);
  assert.equal(byKey.created_at.hidden, true);
  assert.equal(byKey.mystery.hidden, true);
  assert.equal(byKey.status.domain, 'projectStatus');
  assert.equal(byKey.budget_yen.type, 'yen');
  assert.equal(byKey.project_id.hidden, false);
  assert.equal(byKey.project_id.value(data[0]), 'PRJ-3｜架空企画');
  assert.equal(byKey.project_id.value({project_id: 99}), '未登録（99）');
  assert.equal(cellText(byKey.status, 'active'), '進行中');
  assert.deepEqual(inferColumns(['code', 'title']).map((c) => c.label), ['コード', '名称']);
});

test('rows whose keys are already Japanese labels show every column (numbers right-aligned)', async () => {
  const {inferColumns} = await import('../src/ui/grid-model.mjs');
  const columns = inferColumns([{売上明細: 3, 作品: '作品A', 販売期間: '2026-08-01〜2026-08-31', 税抜: '￥1,000'}, {売上明細: 4, 作品: '作品B', 販売期間: '—', 税抜: null}]);
  assert.deepEqual(columns.filter((c) => !c.hidden).map((c) => c.label), ['売上明細', '作品', '販売期間', '税抜']);
  assert.equal(columns.find((c) => c.key === '売上明細').type, 'number');
  assert.equal(columns.find((c) => c.key === '作品').type, 'text');
  assert.equal(inferColumns([{mystery_column: 1}])[0].hidden, true, 'unknown English DB columns stay hidden');
});

test('totalValue lets a row show its amount but stay out of the total (e.g. voided invoices)', async () => {
  const {totalsFor} = await import('../src/ui/grid-model.mjs');
  const columns = [{key: 'amount', type: 'yen', total: 'sum', totalValue: (row) => (row.void ? 0 : row.amount)}];
  const totals = totalsFor([{amount: 110000, void: true}, {amount: 110000}], columns);
  assert.equal(totals.amount.value, 110000);
});

test('2段の見出し（group）の列は、出力では「<group> <列名>」の1段になり、group の無い列はそのまま', () => {
  const grouped = [
    {key: 'code', label: '作品コード', type: 'code', sticky: true},
    {key: 'a_start', label: '解禁日', type: 'text', group: 'SVOD先行'},
    {key: 'a_end', label: '配信期限', type: 'text', group: 'SVOD先行'},
    {key: 'b_start', label: '公開日', type: 'text', group: '劇場公開・配給開始'},
    {key: 'hidden', label: '版', type: 'int', group: 'SVOD先行', hidden: true},
  ];
  const spec = gridSheetSpec({columns: grouped, rows: [{code: 'X', a_start: '2027-01-15', a_end: '2027-12', b_start: '2026-11'}], showTotals: false});
  assert.deepEqual(spec.columns.map((column) => column.label), ['作品コード', 'SVOD先行 解禁日', 'SVOD先行 配信期限', '劇場公開・配給開始 公開日']);
  assert.equal(grouped[1].label, '解禁日', '元の列の定義は変えない');
});

// 行を押したときの開閉: DOM の代わりに、tagName と親だけを持つ要素で closest・contains を真似る
const element = (tagName, parent = null) => ({
  tagName, parent,
  closest(selector) {
    const names = selector.split(',').map((name) => name.trim().toUpperCase());
    for (let node = this; node; node = node.parent) if (names.includes(node.tagName)) return node;
    return null;
  },
  contains(other) {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  },
});

test('行の開閉: セルの中のフォーム（削除の確認）の注意文・余白・ラベル・入力を押しても行を開閉せず、ただの文字を押すと開閉する', () => {
  const tr = element('TR');
  const actions = element('TD', tr);
  const form = element('FORM', element('SPAN', actions));
  const note = element('P', form);
  assert.equal(ignoresRowToggle(note, tr), true, '注意文（form の中の p）');
  assert.equal(ignoresRowToggle(form, tr), true, 'フォームの余白');
  assert.equal(ignoresRowToggle(element('LABEL', form), tr), true);
  assert.equal(ignoresRowToggle(element('TEXTAREA', form), tr), true);
  assert.equal(ignoresRowToggle(element('BUTTON', actions), tr), true, 'セルの中のボタン');
  assert.equal(ignoresRowToggle(element('SPAN', element('TD', tr)), tr), false, 'ただの文字のセルは行を開閉する');
  // 行の外のフォーム（表全体を包むものなど）は、行の中の操作とみなさない
  const outer = element('FORM');
  const row = element('TR', element('TBODY', outer));
  assert.equal(ignoresRowToggle(element('SPAN', element('TD', row)), row), false);
});
