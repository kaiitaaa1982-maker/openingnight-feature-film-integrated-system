import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync, strFromU8} from 'fflate';
import {XMLParser} from 'fast-xml-parser';
import {encodeReportXlsx, reportFilename, reportBaseName, specTable, excelDateSerial, formatCodeFor} from '../src/xlsx-report.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {printableReport, normalizeReportSheets, reportTables, csvDocument} from '../src/report-output.mjs';
import {gridSheetSpec} from '../src/ui/grid-model.mjs';

const columns = [
  {key: 'code', label: '作品コード', type: 'id'},
  {key: 'title', label: '作品名', type: 'text'},
  {key: 'channel', label: '流通', type: 'status', domain: 'productChannel'},
  {key: 'amount', label: '税抜', type: 'yen'},
  {key: 'qty', label: '数量', type: 'int'},
  {key: 'share', label: '構成比', type: 'rate'},
  {key: 'on', label: '計上日', type: 'date'},
  {key: 'note', label: '備考', type: 'text', wrap: true},
];
const rows = [
  {code: '001', title: '風のあとさき', channel: 'digital', amount: -1200, qty: 3, share: 0.25, on: '2026-09-24', note: '=SUM(A1) & <確認>'},
  {code: '002', title: '架空の長い作品名がここに入ります', channel: 'package', amount: 3600, qty: 1, share: 0.75, on: null, note: null},
  {code: '010', title: '作品C', channel: 'theatrical', amount: 0, qty: 0, share: 0, on: '2026-01-31', note: '劇場公開'},
];
const report = {
  name: '年間売上', title: '年間売上（月別推移）', conditions: [['期間', '2026-01〜2026-12'], ['基準', '計上月']], dataAsOf: '2026-09-24T01:00:00Z',
  columns, rows, totals: [{label: '合計', values: {amount: 2400, qty: 4, share: '合計不可'}}], notes: ['税抜・架空データ'], freezeCols: 2,
};
const generatedAt = new Date('2026-09-24T03:00:00Z');
const parser = new XMLParser({ignoreAttributes: false, attributeNamePrefix: '@'});
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

function open(bytes) {
  const files = unzipSync(bytes);
  const text = (path) => strFromU8(files[path]);
  const styles = parser.parse(text('xl/styles.xml')).styleSheet;
  const numFmts = new Map(list(styles.numFmts?.numFmt).map((f) => [Number(f['@numFmtId']), f['@formatCode']]));
  const xfs = list(styles.cellXfs.xf);
  const sheet = (n) => parser.parse(text(`xl/worksheets/sheet${n}.xml`)).worksheet;
  const cell = (ws, ref) => list(ws.sheetData.row).flatMap((row) => list(row.c)).find((c) => c['@r'] === ref);
  const formatOf = (ws, ref) => { const id = Number(xfs[Number(cell(ws, ref)['@s'])]['@numFmtId']); return numFmts.get(id) ?? {3: '#,##0', 49: '@', 0: 'General'}[id]; };
  return {files, text, sheet, cell, xfs, formatOf};
}

test('帳票のブックを decodeXlsx で読むとデータ行の値が一致し、ID は文字列のまま・日付は日付で戻る', () => {
  const bytes = encodeReportXlsx({sheets: [report], generatedAt});
  const [sheet] = decodeXlsx(bytes);
  assert.equal(sheet.name, '年間売上');
  assert.equal(sheet.rows[0][0], '年間売上（月別推移）');
  assert.equal(sheet.rows[1][0], '条件: 期間 2026-01〜2026-12 ／ 基準 計上月');
  assert.equal(sheet.rows[2][0], 'データ時点: 2026/09/24 10:00 ／ 出力日時: 2026/09/24 12:00');
  assert.deepEqual(sheet.rows[3], []);
  assert.deepEqual(sheet.rows[4], columns.map((c) => c.label));
  assert.deepEqual(sheet.rows[5], ['001', '風のあとさき', '配信', -1200, 3, 0.25, '2026-09-24', '=SUM(A1) & <確認>']);
  assert.deepEqual(sheet.rows[6], ['002', '架空の長い作品名がここに入ります', 'ビデオグラム', 3600, 1, 0.75, null, null]);
  assert.deepEqual(sheet.rows[7], ['010', '作品C', '劇場', 0, 0, 0, '2026-01-31', '劇場公開']);
  assert.equal(typeof sheet.rows[5][0], 'string');
  assert.deepEqual(sheet.rows[8], []); // 合計行の前の空行（Excel がフィルタ範囲を合計行まで広げないため）
  assert.deepEqual(sheet.rows[9], ['合計', null, null, 2400, 4, '合計不可', null, null]); // 上罫線を全列に引くため空セルも書く
  assert.deepEqual(sheet.rows[11], ['税抜・架空データ']);
});

test('オートフィルタは見出し〜最後のデータ行で、合計行を含めない。合計行は太字・上罫線', () => {
  const book = open(encodeReportXlsx({sheets: [report], generatedAt}));
  const ws = book.sheet(1);
  assert.equal(ws.autoFilter['@ref'], 'A5:H8');
  const total = book.cell(ws, 'D10');
  assert.equal(Number(total.v), 2400);
  const xf = book.xfs[Number(total['@s'])];
  assert.equal(xf['@fontId'], '1');
  assert.equal(xf['@borderId'], '2');
  assert.match(book.text('xl/workbook.xml'), /_xlnm\._FilterDatabase" localSheetId="0" hidden="1">&apos;年間売上&apos;!\$A\$5:\$H\$8</);
});

test('金額は #,##0;[Red]-#,##0、率は 0.0%、整数は #,##0、日付は yyyy/mm/dd、ID は文字列書式', () => {
  const book = open(encodeReportXlsx({sheets: [report], generatedAt}));
  const ws = book.sheet(1);
  assert.equal(book.formatOf(ws, 'D6'), '#,##0;[Red]-#,##0');
  assert.equal(book.formatOf(ws, 'F6'), '0.0%');
  assert.equal(book.formatOf(ws, 'E6'), '#,##0');
  assert.equal(book.formatOf(ws, 'G6'), 'yyyy/mm/dd');
  assert.equal(book.formatOf(ws, 'A6'), '@');
  assert.equal(book.cell(ws, 'A6')['@t'], 'inlineStr');
  assert.equal(formatCodeFor({type: 'rate', digits: 2}), '0.00%');
});

test('数式を出さない。列幅は内容の表示幅から列ごとに決まる（8〜60）', () => {
  const book = open(encodeReportXlsx({sheets: [report], generatedAt}));
  for (const [path, data] of Object.entries(book.files)) assert.ok(!strFromU8(data).includes('<f>'), path);
  const widths = list(book.sheet(1).cols.col).map((c) => Number(c['@width']));
  assert.equal(widths.length, columns.length);
  assert.ok(new Set(widths).size >= 3, `列幅: ${widths}`);
  assert.ok(widths.every((w) => w >= 8 && w <= 60));
  assert.ok(widths[1] > widths[3], '作品名の列は金額の列より広い');
});

test('ウィンドウ枠は見出しの下と freezeCols 列、横向き・1ページ幅・見出し行を印刷タイトル', () => {
  const book = open(encodeReportXlsx({sheets: [report], generatedAt}));
  const ws = book.sheet(1);
  const pane = ws.sheetViews.sheetView.pane;
  assert.equal(pane['@xSplit'], '2');
  assert.equal(pane['@ySplit'], '5');
  assert.equal(pane['@topLeftCell'], 'C6');
  assert.equal(pane['@state'], 'frozen');
  assert.equal(ws.sheetPr.pageSetUpPr['@fitToPage'], '1');
  assert.equal(ws.pageSetup['@orientation'], 'landscape');
  assert.equal(ws.pageSetup['@fitToWidth'], '1');
  assert.equal(ws.pageSetup['@fitToHeight'], '0');
  assert.match(book.text('xl/workbook.xml'), /_xlnm\.Print_Titles" localSheetId="0">&apos;年間売上&apos;!\$5:\$5</);
});

test('テンプレート: 見出しを1行目に置き、必須・任意・参考の塗り、選択リスト、非表示シートを出して往復できる', () => {
  const template = {
    name: '取引先', columns: [
      {key: 'code', label: '取引先コード', type: 'code'}, {key: 'name', label: '取引先名', type: 'text'},
      {key: 'kind', label: '区分', type: 'text'}, {key: 'ref', label: '参考_現在の名称', type: 'text'},
    ],
    rows: [{code: '0001', name: '架空配信', kind: '配信事業者', ref: '架空配信'}],
    headerKinds: {code: 'required', name: 'required', kind: 'optional', ref: 'reference'},
    validations: [{key: 'kind', list: ['劇場', '配信事業者', '販売店', '代理店', '委託先', 'その他']}],
    freezeCols: 1,
  };
  const longList = Array.from({length: 80}, (_, i) => `架空の流通区分${String(i + 1).padStart(3, '0')}`);
  const hidden = {name: '版情報', hidden: true, columns: [{key: 'k', label: '項目'}, {key: 'v', label: '値'}], rows: [['版', 'v1']]};
  const bytes = encodeReportXlsx({sheets: [template, {...template, name: '取引先2', validations: [{key: 'kind', list: longList}]}, hidden]});
  const decoded = decodeXlsx(bytes);
  assert.deepEqual(decoded[0].rows, [['取引先コード', '取引先名', '区分', '参考_現在の名称'], ['0001', '架空配信', '配信事業者', '架空配信']]);
  assert.deepEqual(decoded[2].rows, [['項目', '値'], ['版', 'v1']]);
  assert.equal(decoded[3].name, '選択肢');
  assert.equal(decoded[3].rows.length, 80);
  const book = open(bytes);
  const ws = book.sheet(1);
  const fill = (ref) => book.xfs[Number(book.cell(ws, ref)['@s'])]['@fillId'];
  assert.notEqual(fill('A1'), fill('C1'));
  assert.notEqual(fill('C1'), fill('D1'));
  assert.equal(fill('A1'), fill('B1'));
  assert.equal(ws.autoFilter['@ref'], 'A1:D2');
  assert.equal(ws.sheetViews.sheetView.pane['@ySplit'], '1');
  const validation = ws.dataValidations.dataValidation;
  assert.equal(validation['@type'], 'list');
  assert.equal(validation['@sqref'], 'C2:C1001');
  assert.equal(validation.formula1, '"劇場,配信事業者,販売店,代理店,委託先,その他"');
  assert.equal(book.sheet(2).dataValidations.dataValidation.formula1, "'選択肢'!$A$1:$A$80");
  const workbook = book.text('xl/workbook.xml');
  assert.match(workbook, /<sheet name="版情報" sheetId="3" state="hidden"/);
  assert.match(workbook, /<sheet name="選択肢" sheetId="4" state="hidden"/);
  assert.match(workbook, /activeTab="0"/);
});

test('小計行は計算済みの値をそのまま出し、シート名の重複と禁止文字は直す', () => {
  const spec = gridSheetSpec({columns, rows, groupBy: 'channel', exportSpec: {name: '流通別', title: '流通別'}});
  const [sheet, second] = decodeXlsx(encodeReportXlsx({sheets: [spec, {...spec, name: '流通別'}], generatedAt}));
  const subtotal = sheet.rows.find((row) => row[0] === '配信 小計');
  assert.deepEqual(subtotal.slice(0, 4), ['配信 小計', null, null, -1200]);
  assert.equal(second.name, '流通別(2)');
  const [odd] = decodeXlsx(encodeReportXlsx({sheets: [{name: '売上/税:集計?', columns, rows: []}]}));
  assert.equal(odd.name, '売上 税 集計');
  assert.deepEqual(odd.rows, [columns.map((c) => c.label)]);
});

test('日付のシリアル値と日本語ファイル名', () => {
  assert.equal(excelDateSerial('2026-09-24'), 46289);
  assert.equal(excelDateSerial('2026-02-30'), null);
  assert.equal(excelDateSerial('9月'), null);
  assert.equal(reportFilename('年間売上', '2026-01〜2026-12', generatedAt), '年間売上_2026-01〜2026-12_20260924.xlsx');
  assert.equal(reportFilename('MG売上報告（台帳ベース）', '', generatedAt), 'MG売上報告（台帳ベース）_20260924.xlsx');
  assert.equal(reportBaseName('売上/明細:*?', '2026/09', generatedAt), '売上_明細_2026_09_20260924');
  assert.equal(reportBaseName('', null, generatedAt), '帳票_20260924');
});

test('CSV と印刷用の表: CSV は生の値、印刷は画面と同じ表示で数値は右寄せ、合計行を区別する', () => {
  const raw = specTable(report, {mode: 'raw'});
  assert.deepEqual(raw.header, columns.map((c) => c.label));
  assert.deepEqual(raw.rows[0], ['001', '風のあとさき', '配信', -1200, 3, 0.25, '2026-09-24', '=SUM(A1) & <確認>']);
  assert.deepEqual(raw.rows.at(-1).slice(0, 6), ['合計', '', '', 2400, 4, '合計不可']);
  const shown = specTable(report, {mode: 'display'});
  assert.deepEqual(shown.rows[0].slice(3, 7), ['-1,200', '3', '25.0%', '2026/09/24']);
  assert.equal(shown.rows[1][6], '未確認');
  assert.deepEqual(shown.numeric, [false, false, false, true, true, true, false, false]);
  assert.equal(shown.totalRows, 1);
  const csv = csvDocument([raw.header, ...raw.rows]);
  assert.match(csv, /"'=SUM\(A1\) & <確認>"/);
  assert.match(csv, /"-1200"/, '負の金額は数値のまま（先頭に記号を付けると Excel で文字になり合計から外れる）');
  assert.doesNotMatch(csv, /"'-1200"/);
  assert.match(csvDocument([['-1+2']]), /"'-1\+2"/, '数値でない「-」始まりは数式として防ぐ');
  const [table] = reportTables([report], {mode: 'display'});
  const html = printableReport({title: '年間売上', sheets: [table], generatedAt: generatedAt.toISOString()});
  assert.match(html, /<td class="number">-1,200<\/td>/);
  assert.match(html, /<tr class="total">/);
  assert.match(html, /期間 2026-01〜2026-12 ／ 基準 計上月 ／ データ時点 2026\/09\/24 10:00/);
  assert.match(html, /生成日時 2026\/09\/24 12:00/);
  assert.match(html, /<li>税抜・架空データ<\/li>/);
  assert.match(html, /=SUM\(A1\) &amp; &lt;確認&gt;/);
});

test('従来のシート（1行目が見出しの配列）は今までどおり扱い、columns を渡すと型が付く', () => {
  const legacy = [{name: '番販作品', rows: [['作品コード', '作品名', '税抜'], ['001', '風のあとさき', 1600000]]}];
  assert.deepEqual(normalizeReportSheets(legacy), [{typed: false, sheet: legacy[0]}]);
  assert.deepEqual(reportTables(legacy), legacy);
  const html = printableReport({title: '架空収支', sheets: legacy});
  assert.match(html, /1,600,000/);
  assert.doesNotMatch(html, /class="total"/);
  const [typed] = normalizeReportSheets(legacy, [{type: 'id'}, {type: 'text'}, {type: 'yen'}]);
  assert.equal(typed.typed, true);
  assert.deepEqual(typed.spec.columns.map((c) => c.label), ['作品コード', '作品名', '税抜']);
  const [decoded] = decodeXlsx(encodeReportXlsx({sheets: [typed.spec]}));
  assert.deepEqual(decoded.rows, [['作品コード', '作品名', '税抜'], ['001', '風のあとさき', 1600000]]);
});

test('2,000行の帳票も出力でき、上限を超える列は拒否する', () => {
  const many = Array.from({length: 2000}, (_, i) => ({code: String(i).padStart(4, '0'), title: `架空${i}`, channel: 'digital', amount: i * 100, qty: 1, share: 0.001, on: '2026-09-01', note: ''}));
  const [sheet] = decodeXlsx(encodeReportXlsx({sheets: [{...report, rows: many}], generatedAt}));
  assert.equal(sheet.rows[5 + 1999][0], '1999');
  assert.equal(sheet.rows[5 + 1999][3], 199900);
  assert.throws(() => encodeReportXlsx({sheets: [{name: '広すぎ', columns: Array.from({length: 257}, (_, i) => ({key: `c${i}`})), rows: []}]}), /256列/);
  assert.throws(() => encodeReportXlsx({sheets: []}), /1〜50枚/);
  assert.throws(() => encodeReportXlsx({sheets: [{name: '隠す', hidden: true, columns, rows}]}), /表示するシート/);
  assert.throws(() => encodeReportXlsx({sheets: [{name: 'x', columns, rows, validations: [{key: 'nope', list: ['a']}]}]}), /選択リストの列/);
});
