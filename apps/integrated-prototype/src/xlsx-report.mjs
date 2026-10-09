// 帳票・一覧・テンプレートの Excel 出力（書式つき）。数式は出さない。src/xlsx.mjs の decodeXlsx で読み戻せる。
// 書式: 1行目に帳票名、2行目に条件、3行目にデータ時点と出力日時、1行空けて見出し。合計行は太字・上罫線で
// オートフィルタの範囲（見出し〜最後のデータ行）の外。ウィンドウ枠は見出しの下と freezeCols 列。横向き・1ページ幅。
// title・conditions・dataAsOf をどれも渡さないシートは見出しを1行目に置く（テンプレート・取込の往復用）。
// 任意: cellFill(行, 列, 行の番号) → 'FFRRGGBB'（セルの塗り。放送履歴表の赤・黄など）、paperSize: 'A3'（既定は A4）、
// headerKinds の accent（見出しを橙黄で目立たせる列）。

import {zipSync, strToU8} from 'fflate';
import {toNumber, isBlank, displayWidth, dateTimeJst, compactDateJst, UNKNOWN_TEXT} from './ui/format.mjs';
import {labelOf} from './ui/labels.mjs';
import {cellText, valueOf, hasDomain} from './ui/grid-model.mjs';

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const xml = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export const columnLetters = (index) => { let s = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

export const EXCEL_FORMATS = Object.freeze({yen: '#,##0;[Red]-#,##0', int: '#,##0', rate: '0.0%', date: 'yyyy/mm/dd', text: '@'});
const MAX_COLUMNS = 256;
const MAX_ROWS = 100000;
const HEADER_FILLS = {header: 'FFF2F2F2', required: 'FFFCE4D6', optional: 'FFEDEDED', reference: 'FFDDEBF7', subtotal: 'FFF7F7F7', accent: 'FFFFE699'};
const PAPER_SIZES = {A4: 9, A3: 8};
const FILL_RGB = /^FF[0-9A-F]{6}$/;

const FONTS = [
  '<font><sz val="11"/><name val="Yu Gothic"/><family val="3"/></font>',
  '<font><b/><sz val="11"/><name val="Yu Gothic"/><family val="3"/></font>',
  '<font><b/><sz val="14"/><name val="Yu Gothic"/><family val="3"/></font>',
  '<font><sz val="10"/><color rgb="FF595959"/><name val="Yu Gothic"/><family val="3"/></font>',
];
const FONT = {normal: 0, bold: 1, title: 2, note: 3};
const BORDERS = [
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  '<border><left/><right/><top/><bottom style="thin"><color rgb="FF808080"/></bottom><diagonal/></border>',
  '<border><left/><right/><top style="thin"><color rgb="FF404040"/></top><bottom/><diagonal/></border>',
];
const BORDER = {none: 0, bottom: 1, top: 2};

function createStyles() {
  const numFmts = new Map(); // formatCode -> id
  const builtin = {'General': 0, '#,##0': 3, '@': 49};
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const fillIds = new Map();
  const xfs = [];
  const xfIds = new Map();
  const numFmtId = (code = 'General') => {
    if (Object.hasOwn(builtin, code)) return builtin[code];
    if (!numFmts.has(code)) numFmts.set(code, 164 + numFmts.size);
    return numFmts.get(code);
  };
  const fillId = (rgb) => {
    if (!rgb) return 0;
    if (!fillIds.has(rgb)) { fillIds.set(rgb, fills.length); fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`); }
    return fillIds.get(rgb);
  };
  const style = ({font = FONT.normal, fill, border = BORDER.none, format = 'General', wrap = false, top = false, horizontal} = {}) => {
    const n = numFmtId(format), f = fillId(fill);
    const key = `${font}|${f}|${border}|${n}|${wrap}|${top}|${horizontal || ''}`;
    if (!xfIds.has(key)) {
      const alignment = wrap || top || horizontal
        ? `<alignment${horizontal ? ` horizontal="${horizontal}"` : ''}${top ? ' vertical="top"' : ' vertical="center"'}${wrap ? ' wrapText="1"' : ''}/>`
        : '';
      const attrs = `numFmtId="${n}" fontId="${font}" fillId="${f}" borderId="${border}" xfId="0"${n ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${f ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}`;
      xfIds.set(key, xfs.length);
      xfs.push(alignment ? `<xf ${attrs} applyAlignment="1">${alignment}</xf>` : `<xf ${attrs}/>`);
    }
    return xfIds.get(key);
  };
  style(); // 0 = 既定
  const toXml = () => declaration + `<styleSheet xmlns="${ns}">`
    + (numFmts.size ? `<numFmts count="${numFmts.size}">${[...numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`).join('')}</numFmts>` : '')
    + `<fonts count="${FONTS.length}">${FONTS.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills>`
    + `<borders count="${BORDERS.length}">${BORDERS.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return {style, toXml};
}

// 列の Excel 書式コード。
export function formatCodeFor(column) {
  switch (column?.type) {
    case 'yen': return EXCEL_FORMATS.yen;
    case 'int': return EXCEL_FORMATS.int;
    case 'number': return `#,##0.${'0'.repeat(Math.max(1, column.digits ?? 2))}`;
    case 'rate': { const digits = column.digits ?? 1; return digits > 0 ? `0.${'0'.repeat(digits)}%` : '0%'; }
    case 'date': return EXCEL_FORMATS.date;
    case 'id': case 'code': case 'text': case 'status': case 'month': case 'datetime': return EXCEL_FORMATS.text;
    default: return 'General';
  }
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
export function excelDateSerial(value) {
  const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(y, m - 1, d);
  const check = new Date(time);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  const serial = (time - EXCEL_EPOCH) / 86400000;
  return serial > 60 ? serial : null; // 1900年2月以前は Excel の日付の扱いが不正確なので文字で出す
}

const isSubtotalRow = (row) => Boolean(row) && !Array.isArray(row) && row.__kind === 'subtotal';

function rawValue(column, row, index) {
  if (Array.isArray(row)) return row[index];
  if (isSubtotalRow(row)) return row[column.key]; // 小計行は計算済みの値をそのまま出す
  if (typeof column.exportValue === 'function') return column.exportValue(row);
  return valueOf(column, row);
}

// 1セルの Excel 値。{value: number|string|null, kind: 'number'|'date'|'text'|'blank'}。
export function excelCell(column, raw) {
  if (isBlank(raw) || raw === '') return {value: null, kind: 'blank'};
  const type = column?.type;
  if (type === 'yen' || type === 'int' || type === 'number' || type === 'rate') {
    const n = toNumber(raw);
    return n === null ? {value: String(raw), kind: 'text'} : {value: n, kind: 'number'};
  }
  if (type === 'date') {
    const serial = excelDateSerial(raw);
    return serial === null ? {value: String(raw), kind: 'text'} : {value: serial, kind: 'date'};
  }
  if (type === 'datetime') return {value: dateTimeJst(raw), kind: 'text'};
  if (hasDomain(column) && column.raw !== true) return {value: labelOf(column.domain, raw), kind: 'text'};
  if (typeof raw === 'boolean') return {value: raw ? 'はい' : 'いいえ', kind: 'text'};
  if (typeof raw === 'number' && !['id', 'code', 'text', 'status', 'month'].includes(type)) return {value: raw, kind: 'number'};
  return {value: String(raw), kind: 'text'};
}

// 小計・合計のように計算済みの値。数は数、それ以外は文字。
function plainCell(raw) {
  if (isBlank(raw) || raw === '') return {value: null, kind: 'blank'};
  if (raw && typeof raw === 'object') return raw.notSummable ? {value: '合計不可', kind: 'text'} : plainCell(raw.value);
  return typeof raw === 'number' ? {value: raw, kind: 'number'} : {value: String(raw), kind: 'text'};
}

function cellXml(ref, value, style) {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined) return style ? `<c r="${ref}"${s}/>` : '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Error('Excelに無限値は出力できません');
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function sanitizeSheetName(name, index, used) {
  let base = String(name || `Sheet${index + 1}`).replace(/[\\/?:*[\]]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${index + 1}`;
  let candidate = base, n = 2;
  while (used.has(candidate.toLowerCase())) { const suffix = `(${n++})`; candidate = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(candidate.toLowerCase());
  return candidate;
}

const quoteSheet = (name) => `'${name.replaceAll("'", "''")}'`;

function conditionsText(conditions) {
  const list = (conditions || []).filter((item) => Array.isArray(item) ? item[0] || item[1] : item);
  if (!list.length) return '条件: 指定なし';
  return `条件: ${list.map((item) => (Array.isArray(item) ? `${item[0]} ${item[1] ?? ''}`.trim() : String(item))).join(' ／ ')}`;
}

function columnWidth(column, index, rows, header) {
  if (Number.isFinite(column.width)) return Math.min(60, Math.max(8, column.width));
  let width = displayWidth(header) + 3; // フィルタボタンの分
  const sample = rows.length > 500 ? rows.slice(0, 500) : rows;
  for (const row of sample) {
    const raw = rawValue(column, row, index);
    const shown = isBlank(raw) || raw === '' ? '' : column.type === 'date' ? '2026/09/24' : cellText(column, raw);
    width = Math.max(width, displayWidth(shown) + 2);
  }
  return Math.min(column.wrap ? 40 : 60, Math.max(8, width));
}

function buildSheet(spec, name, styles, listSheet, generatedAt) {
  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  const rows = Array.isArray(spec.rows) ? spec.rows : [];
  if (columns.length > MAX_COLUMNS) throw Error(`帳票の列は${MAX_COLUMNS}列までです`);
  if (rows.length > MAX_ROWS) throw Error(`帳票の行は${MAX_ROWS.toLocaleString('ja-JP')}行までです`);
  const titleBand = spec.titleBand ?? Boolean(spec.title || (spec.conditions && spec.conditions.length) || spec.dataAsOf);
  const lastCol = columnLetters(Math.max(columns.length, 1) - 1);
  const out = [];
  const rowXml = (r, cells, extra = '') => out.push(`<row r="${r}"${extra}>${cells.join('')}</row>`);
  let r = 1;
  if (titleBand) {
    rowXml(r, [cellXml(`A${r}`, spec.title || spec.name || '帳票', styles.style({font: FONT.title}))], ' ht="24" customHeight="1"'); r += 1;
    rowXml(r, [cellXml(`A${r}`, conditionsText(spec.conditions), styles.style({font: FONT.note}))]); r += 1;
    rowXml(r, [cellXml(`A${r}`, `データ時点: ${spec.dataAsOf ? dateTimeJst(spec.dataAsOf) : UNKNOWN_TEXT} ／ 出力日時: ${dateTimeJst(generatedAt)}`, styles.style({font: FONT.note}))]); r += 1;
    r += 1; // 空行
  }
  const headerRow = r;
  const headerKinds = spec.headerKinds || {};
  rowXml(r, columns.map((column, c) => {
    const kind = headerKinds[column.key];
    return cellXml(`${columnLetters(c)}${r}`, column.label ?? column.key, styles.style({font: FONT.bold, fill: HEADER_FILLS[kind] || HEADER_FILLS.header, border: BORDER.bottom, wrap: true}));
  }));
  r += 1;
  const dataStyles = columns.map((column) => ({
    plain: styles.style({format: formatCodeFor(column), wrap: Boolean(column.wrap), top: Boolean(column.wrap), horizontal: column.align}),
    subtotal: styles.style({font: FONT.bold, fill: HEADER_FILLS.subtotal, format: formatCodeFor(column), horizontal: column.align}),
  }));
  const cellFill = typeof spec.cellFill === 'function' ? spec.cellFill : null;
  const filled = (column, c, fill) => {
    if (!fill) return dataStyles[c].plain;
    if (!FILL_RGB.test(fill)) throw Error(`セルの塗りの色は FFRRGGBB の形です: ${fill}`);
    return styles.style({format: formatCodeFor(column), wrap: Boolean(column.wrap), top: Boolean(column.wrap), horizontal: column.align, fill});
  };
  rows.forEach((row, index) => {
    const subtotal = isSubtotalRow(row);
    rowXml(r, columns.map((column, c) => {
      const {value} = subtotal ? plainCell(rawValue(column, row, c)) : excelCell(column, rawValue(column, row, c));
      const style = subtotal ? dataStyles[c].subtotal : cellFill ? filled(column, c, cellFill(row, column, index)) : dataStyles[c].plain;
      return cellXml(`${columnLetters(c)}${r}`, value, style);
    }));
    r += 1;
  });
  const lastDataRow = r - 1;
  // 合計行の前に空行を1行置く。隣接していると Excel が開くときにオートフィルタの範囲を合計行まで広げるため。
  if ((spec.totals || []).length) r += 1;
  (spec.totals || []).forEach((total, t) => {
    const border = t === 0 ? BORDER.top : BORDER.none;
    rowXml(r, columns.map((column, c) => {
      let value = total.values && Object.hasOwn(total.values, column.key) ? total.values[column.key] : null;
      if (value && typeof value === 'object' && value.notSummable) value = '合計不可';
      if (value && typeof value === 'object' && 'value' in value) value = value.value;
      if (c === 0 && (value === null || value === undefined)) value = total.label ?? '合計';
      const numeric = typeof value === 'number';
      return cellXml(`${columnLetters(c)}${r}`, value, styles.style({font: FONT.bold, border, format: numeric ? formatCodeFor(column) : 'General', horizontal: numeric ? undefined : c === 0 ? undefined : 'right'}));
    }));
    r += 1;
  });
  if ((spec.notes || []).length) {
    r += 1;
    for (const note of spec.notes) { rowXml(r, [cellXml(`A${r}`, String(note), styles.style({font: FONT.note}))]); r += 1; }
  }
  const lastRow = Math.max(r - 1, 1);

  // 選択リスト（入力規則）。255文字以内でカンマを含まなければ直接、そうでなければ非表示シートを参照。
  const validationRows = Math.max(rows.length, spec.validationRows ?? 1000);
  const validations = (spec.validations || []).map((validation) => {
    const c = columns.findIndex((column) => column.key === validation.key);
    if (c < 0) throw Error(`選択リストの列がありません: ${validation.key}`);
    const items = (validation.list || []).map((item) => String(item));
    const inline = items.every((item) => !/[,"]/.test(item)) && items.join(',').length <= 250;
    const formula = inline ? `"${items.join(',')}"` : listSheet.add(items);
    const ref = `${columnLetters(c)}${headerRow + 1}:${columnLetters(c)}${headerRow + validationRows}`;
    return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="選択肢にない値" error="一覧から選んでください" sqref="${ref}"><formula1>${xml(formula)}</formula1></dataValidation>`;
  });

  const freezeCols = Math.min(Math.max(0, spec.freezeCols ?? 1), columns.length);
  const topLeft = `${columnLetters(freezeCols)}${headerRow + 1}`;
  const pane = freezeCols
    ? `<pane xSplit="${freezeCols}" ySplit="${headerRow}" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="${topLeft}" sqref="${topLeft}"/>`
    : `<pane ySplit="${headerRow}" topLeftCell="${topLeft}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${topLeft}" sqref="${topLeft}"/>`;
  const widths = columns.map((column, c) => {
    const width = columnWidth(column, c, rows, column.label ?? column.key);
    // wholeColumnFormat: 空の行（利用者がこれから入れるセル）にも列の書式を効かせる（例: 料率の列を文字にして「50%」を 0.5 にさせない）
    const style = column.wholeColumnFormat ? ` style="${dataStyles[c].plain}"` : '';
    return `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"${style}${column.hidden ? ' hidden="1"' : ''}/>`;
  });
  const filterRef = `A${headerRow}:${lastCol}${Math.max(lastDataRow, headerRow)}`;
  const body = declaration + `<worksheet xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + `<dimension ref="A1:${columnLetters(Math.max(columns.length, 1) - 1)}${lastRow}"/>`
    + `<sheetViews><sheetView workbookViewId="0">${columns.length ? pane : ''}</sheetView></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="18"/>'
    + (widths.length ? `<cols>${widths.join('')}</cols>` : '')
    + `<sheetData>${out.join('')}</sheetData>`
    + (columns.length ? `<autoFilter ref="${filterRef}"/>` : '')
    + (validations.length ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>` : '')
    + '<printOptions horizontalCentered="1"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>'
    + `<pageSetup paperSize="${PAPER_SIZES[spec.paperSize] || PAPER_SIZES.A4}" orientation="landscape" fitToWidth="1" fitToHeight="0"/>`
    + '<headerFooter><oddFooter>&amp;P / &amp;N</oddFooter></headerFooter>'
    + '</worksheet>';
  const definedNames = columns.length ? [
    {name: '_xlnm._FilterDatabase', hidden: true, ref: `${quoteSheet(name)}!$A$${headerRow}:$${lastCol}$${Math.max(lastDataRow, headerRow)}`},
    {name: '_xlnm.Print_Titles', ref: `${quoteSheet(name)}!$${headerRow}:$${headerRow}`},
  ] : [];
  return {xml: body, definedNames, headerRow, lastDataRow};
}

function createListSheet(name) {
  const columns = [];
  return {
    name,
    get used() { return columns.length > 0; },
    add(items) {
      const c = columns.length;
      columns.push(items);
      return `${quoteSheet(name)}!$${columnLetters(c)}$1:$${columnLetters(c)}$${Math.max(items.length, 1)}`;
    },
    xml() {
      const height = Math.max(0, ...columns.map((list) => list.length));
      const rows = [];
      for (let r = 0; r < height; r += 1) rows.push(`<row r="${r + 1}">${columns.map((list, c) => (r < list.length ? cellXml(`${columnLetters(c)}${r + 1}`, list[r]) : '')).join('')}</row>`);
      return declaration + `<worksheet xmlns="${ns}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
    },
  };
}

// → Uint8Array（.xlsx）。sheets の各要素は ColumnSpec の列定義と行（オブジェクト、または列順の配列）。
export function encodeReportXlsx({sheets, generatedAt = new Date()} = {}) {
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 50) throw Error('帳票シートは1〜50枚です');
  const used = new Set();
  const names = sheets.map((sheet, index) => sanitizeSheetName(sheet?.name || sheet?.title, index, used));
  let listName = '選択肢', n = 2;
  while (used.has(listName.toLowerCase())) listName = `選択肢(${n++})`;
  const listSheet = createListSheet(listName);
  const styles = createStyles();
  const files = {};
  const entries = [];
  const definedNames = [];
  sheets.forEach((sheet, index) => {
    const built = buildSheet(sheet || {}, names[index], styles, listSheet, generatedAt);
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(built.xml);
    entries.push({name: names[index], id: index + 1, hidden: Boolean(sheet?.hidden)});
    for (const item of built.definedNames) definedNames.push({...item, localSheetId: index});
  });
  if (listSheet.used) {
    const id = entries.length + 1;
    files[`xl/worksheets/sheet${id}.xml`] = strToU8(listSheet.xml());
    entries.push({name: listSheet.name, id, hidden: true});
  }
  const firstVisible = entries.findIndex((entry) => !entry.hidden);
  if (firstVisible < 0) throw Error('表示するシートが1枚以上必要です');
  files['[Content_Types].xml'] = strToU8(declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + entries.map((e) => `<Override PartName="/xl/worksheets/sheet${e.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>');
  files['_rels/.rels'] = strToU8(declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files['xl/workbook.xml'] = strToU8(declaration + `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<bookViews><workbookView activeTab="${firstVisible}" firstSheet="${firstVisible}"/></bookViews>`
    + `<sheets>${entries.map((e) => `<sheet name="${xml(e.name)}" sheetId="${e.id}"${e.hidden ? ' state="hidden"' : ''} r:id="rId${e.id}"/>`).join('')}</sheets>`
    + (definedNames.length ? `<definedNames>${definedNames.map((d) => `<definedName name="${d.name}" localSheetId="${d.localSheetId}"${d.hidden ? ' hidden="1"' : ''}>${xml(d.ref)}</definedName>`).join('')}</definedNames>` : '')
    + '</workbook>');
  files['xl/_rels/workbook.xml.rels'] = strToU8(declaration + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + entries.map((e) => `<Relationship Id="rId${e.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${e.id}.xml"/>`).join('')
    + '<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  files['xl/styles.xml'] = strToU8(styles.toXml());
  return zipSync(files, {level: 6});
}

// ブラウザ専用。encodeReportXlsx の結果を保存させる。
export function downloadReportXlsx(filename, spec) {
  const bytes = encodeReportXlsx(spec);
  const url = URL.createObjectURL(new Blob([bytes], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = String(filename || '帳票').endsWith('.xlsx') ? filename : `${filename || '帳票'}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const cleanFilePart = (text) => String(text ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').replace(/^[_ .]+|[_ .]+$/g, '');

// 拡張子なしの日本語ファイル名。'年間売上_2026-01〜2026-12_20260924'。
export function reportBaseName(name, period, date = new Date()) {
  const parts = [cleanFilePart(name) || '帳票'];
  const periodPart = cleanFilePart(period);
  if (periodPart) parts.push(periodPart);
  parts.push(compactDateJst(date));
  return parts.join('_').slice(0, 150);
}

export function reportFilename(name, period, date = new Date()) {
  return `${reportBaseName(name, period, date)}.xlsx`;
}

// シート定義を行列（見出し＋行＋合計行）に直す。CSV（raw）と印刷（display）用。
export function specTable(spec, {mode = 'raw'} = {}) {
  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  const header = columns.map((column) => column.label ?? column.key);
  const numeric = columns.map((column) => ['yen', 'int', 'number', 'rate'].includes(column.type));
  const convert = (column, raw) => {
    if (mode === 'display') return isBlank(raw) || raw === '' ? UNKNOWN_TEXT : cellText(column, raw);
    const cell = excelCell(column, raw);
    if (cell.kind === 'date') return String(raw).slice(0, 10);
    return cell.value;
  };
  const plain = (column, raw) => {
    const {value} = plainCell(raw);
    return mode === 'display' && typeof value === 'number' ? cellText(column, value) : value ?? '';
  };
  const rows = (spec.rows || []).map((row) => columns.map((column, c) => (isSubtotalRow(row) ? plain : convert)(column, rawValue(column, row, c))));
  const totals = (spec.totals || []).map((total) => columns.map((column, c) => {
    const value = total.values && Object.hasOwn(total.values, column.key) ? total.values[column.key] : null;
    if (c === 0 && (value === null || value === undefined)) return total.label ?? '合計';
    return plain(column, value);
  }));
  return {name: spec.name || spec.title || '一覧', header, rows: [...rows, ...totals], numeric, totalRows: totals.length};
}
