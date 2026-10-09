// 一括登録ファイルの読み取り（ブラウザ・node 共通）。Excel は「入力」シート（無ければ説明用以外の最初のシート）、
// CSV は文字コードを判定して読む。見出し行は必須の見出しが最も多い行を推定する（タイトル行があっても読める）。
import {decodeXlsx} from '../xlsx.mjs';
import {decodeText, ENCODING_LABELS} from '../import/text-decode.mjs';
import {detectHeaderRow} from './bulk-validate.mjs';

const SKIP_SHEETS = new Set(['記入例', '記入ガイド', '_meta', '失敗行', '_lists']);
const cellText = (value) => (value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value));

function splitCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i += 1; } else if (char === '"') quoted = false; else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  if (value !== '' || row.length) { row.push(value); rows.push(row); }
  return rows;
}

export function readSheetRows(entity, sheetRows, {fileName, sheetName, encoding} = {}) {
  const headerIndex = detectHeaderRow(entity, sheetRows);
  if (headerIndex < 0) throw new Error('見出しの行が見つかりません。テンプレートの見出し（例: 1行目）を消さずに使ってください');
  const headers = (sheetRows[headerIndex] || []).map(cellText);
  const rows = [];
  for (let index = headerIndex + 1; index < sheetRows.length; index += 1) {
    const values = headers.map((_, col) => cellText(sheetRows[index]?.[col]).trim());
    if (values.every((value) => value === '')) continue;
    rows.push({rowNo: index + 1, values});
  }
  return {fileName, sheetName, encoding, encodingLabel: encoding ? ENCODING_LABELS[encoding] : null, headerRowNo: headerIndex + 1, headers, rows};
}

export function readUpload(entity, bytes, fileName = '') {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx')) {
    let sheets;
    try {
      sheets = decodeXlsx(bytes, {formulas: 'sheet'});
    } catch (error) {
      if (/数式|formula/i.test(error.message)) throw new Error('数式のセルがあるため読み込めません。Excelで数式を値に変換（コピーして値として貼り付け）してから保存してください');
      throw error;
    }
    const meta = sheets.find((sheet) => sheet.name === '_meta');
    const metaMap = meta ? Object.fromEntries((meta.rows || []).slice(1).map((row) => [cellText(row[0]), cellText(row[1])])) : {};
    const input = sheets.find((sheet) => sheet.name === '入力') || sheets.find((sheet) => !SKIP_SHEETS.has(sheet.name) && !sheet.error) || sheets.find((sheet) => !SKIP_SHEETS.has(sheet.name));
    if (!input) throw new Error('読み込めるシートがありません');
    if (input.error) throw new Error(`「${input.name}」シートに数式のセルがあるため読み込めません。Excelで数式を値に変換（コピーして値として貼り付け）してから保存してください`);
    const result = readSheetRows(entity, input.rows || [], {fileName, sheetName: input.name});
    return {...result, meta: metaMap.entity ? {entity: metaMap.entity, version: metaMap.version, kind: metaMap.kind} : null};
  }
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const {text, encoding} = decodeText(bytes);
    return {...readSheetRows(entity, splitCsv(text), {fileName, sheetName: 'CSV', encoding}), meta: null};
  }
  throw new Error('Excel（.xlsx）か CSV（.csv）を選んでください。.xls（古い形式）は Excel で .xlsx に保存し直してください');
}
