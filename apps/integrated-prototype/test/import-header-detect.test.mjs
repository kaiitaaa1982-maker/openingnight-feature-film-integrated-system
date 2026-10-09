import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {unzipSync, zipSync, strFromU8, strToU8} from 'fflate';
import {decodeXlsx} from '../src/xlsx.mjs';
import {decodeText} from '../src/import/text-decode.mjs';
import {extractDocument} from '../src/local-extractor.mjs';
import {detectHeaderRow, detectTotalRows, headerProblems, columnLetter, sheetPreview} from '../src/import/header-detect.mjs';
import {suggestMappings, suggestionList, normalizeHeader} from '../src/import/column-synonyms.mjs';

const fixture = (name) => new URL(`../public/demo-fixtures/${name}`, import.meta.url);
const guide = JSON.parse(readFileSync(fixture('source-column-guide.json'), 'utf8'));

// デモのXLSXは OOXML の名前空間接頭辞（x:）付きで保存され、検証用シート「検証期待値」に数式がある。
// decodeXlsx は接頭辞付きのXMLと数式セルを読まない（数式の拒否は取込の方針）ため、試験では接頭辞を外し、
// 数式のある検証用シートだけを外した同じブックを decodeXlsx で読む。明細シート「Details」の値は変えない。
function readDemoWorkbook(name) {
  const bytes = new Uint8Array(readFileSync(fixture(name)));
  try {
    return decodeXlsx(bytes);
  } catch {
    const files = unzipSync(bytes);
    for (const path of Object.keys(files)) {
      if (!path.endsWith('.xml') && !path.endsWith('.rels')) continue;
      let text = strFromU8(files[path]).replace(/<(\/?)x:/g, '<$1').replace(/xmlns:x=/g, 'xmlns=');
      if (path === 'xl/workbook.xml') text = text.replace(/<sheet name="検証期待値"[^>]*\/>/, '');
      files[path] = strToU8(text);
    }
    return decodeXlsx(zipSync(files));
  }
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i += 1; } else if (char === '"') quoted = false; else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[i + 1] === '\n') i += 1; row.push(value); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

test('デモの配信XLSXを decodeXlsx で読むと、見出し行は案内どおり4行目と推定される', () => {
  const sheets = readDemoWorkbook('streaming-platform-sample.xlsx');
  const details = sheets.find((sheet) => sheet.name === 'Details');
  assert.ok(details, '明細シートがある');
  const result = detectHeaderRow(details.rows);
  assert.equal(result.row, guide['streaming-platform'].headerRow);
  assert.equal(result.row, 4);
  assert.equal(result.confidence, 'high');
  assert.ok(result.reasons.some((reason) => reason.includes('数値を含む明細')));
  assert.deepEqual(details.rows[result.row - 1].slice(0, 3), ['作品CD', '商品ｺｰﾄﾞ', '配信区分']);
  assert.deepEqual(detectTotalRows(details.rows, result.row), [], '合計行はない');
  assert.deepEqual(headerProblems(details.rows[result.row - 1]), []);
});

test('デモのビデオグラムXLSXも見出し行は4行目', () => {
  const sheets = readDemoWorkbook('videogram-rental-sample.xlsx');
  const details = sheets.find((sheet) => sheet.name === 'Details');
  assert.equal(detectHeaderRow(details.rows).row, guide['videogram-rental'].headerRow);
});

test('デモの元CSV（表題1行つき）は見出し行が2行目', () => {
  for (const name of ['streaming-platform-sample.csv', 'videogram-rental-sample.csv']) {
    const {text} = decodeText(readFileSync(fixture(name)));
    const rows = csvRows(text);
    assert.equal(detectHeaderRow(rows).row, 2, name);
  }
});

test('見出しが1行目の報告、見出しらしい行がない表、合計行と見出しの問題', () => {
  assert.equal(detectHeaderRow([['report id', 'start date', 'end date', 'qty', 'net sales'], ['R-1', '2026-09-01', '2026-09-30', '2', '1000']]).row, 1);
  const none = detectHeaderRow([['1', '2', '3'], ['4', '5', '6']]);
  assert.equal(none.row, null);
  assert.equal(none.confidence, 'none');
  const rows = [['売上報告'], ['明細', '数量', '金額'], ['A', '1', '100'], ['B', '2', '200'], ['合計', '3', '300']];
  assert.equal(detectHeaderRow(rows).row, 2);
  assert.deepEqual(detectTotalRows(rows, 2), [{row: 5, reason: '「合計」を含む行（合計行の可能性）'}]);
  assert.deepEqual(headerProblems(['明細', '', '金額', '明細']).map((problem) => problem.column), ['B', 'D']);
  assert.deepEqual(headerProblems(['明細', '金額', '', '']), [], '右端の空欄は問題にしない');
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  const preview = sheetPreview([['a', null, ''], ['1', '2']], {count: 30});
  assert.deepEqual(preview.columns, ['A', 'B']);
  assert.deepEqual(preview.rows[0], {row: 1, cells: ['a', '']});
});

test('同義語の候補: 一般的な語から選び、単価・手数料・総額を金額にしない。形が合わない月の列は理由つきで使わない', () => {
  const headers = ['作品CD', '商品ｺｰﾄﾞ', '配信区分', '対象月', '視聴/契約数', '単価(税抜)', '総額', 'PF手数料', '正味売上', '備考'];
  const rows = [['WRK-DEMO', 'SKU-DIGI', 'TVOD', '2026/08', '1250', '420', '525000', '157500', '367500', '正常']];
  const suggested = suggestMappings(headers, rows);
  assert.equal(suggested.amount_ex_tax.source, '正味売上');
  assert.equal(suggested.quantity.source, '視聴/契約数');
  assert.equal(suggested.description.source, '配信区分');
  assert.equal(suggested.sales_month.formatOk, false);
  assert.match(suggested.sales_month.reason, /2026\/08/);
  assert.equal(suggested.tax_amount, undefined);
  assert.equal(suggested.amount_inc_tax, undefined);
  assert.deepEqual(suggestionList(headers, rows).map((item) => item.target).sort(), ['amount_ex_tax', 'description', 'quantity']);
  const video = suggestMappings(['作品コード', '品番', '商材', '集計年月', '出荷数量', '返品数', '正味数量', '精算単価', '正味額', '検証メモ'], []);
  assert.equal(video.quantity.source, '正味数量', '正味を優先');
  assert.equal(video.amount_ex_tax.source, '正味額');
  assert.equal(normalizeHeader(' 商品ｺｰﾄﾞ（税抜） '), '商品コード税抜');
});

const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const hasOpenpyxl = spawnSync(python, ['-c', 'import openpyxl'], {windowsHide: true}).status === 0;

test('アプリの抽出（Python）で読んだデモの配信XLSXでも見出し行は4行目', {skip: hasOpenpyxl ? false : 'openpyxl が無い環境'}, async () => {
  const bytes = readFileSync(fixture('streaming-platform-sample.xlsx'));
  const extraction = await extractDocument({name: 'streaming-platform-sample.xlsx', base64: bytes.toString('base64'), pythonPath: python});
  const details = extraction.sheets.find((sheet) => sheet.name === 'Details');
  assert.equal(detectHeaderRow(details.rows).row, 4);
});
