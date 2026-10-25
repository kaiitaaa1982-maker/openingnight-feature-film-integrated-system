// 予算書・予算書の型を xlsx に書き出す（要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-026〜028）。
// 形は代表の手元の予算表と同じ並び: 左の区画に A〜E、右の区画に F〜K、区分ごとに明細と「X 名前 … 小計」の行、右下に合計の行、上に見積り・消費税・合計金額。
// 内訳を持つ行（キャスト費など）は、内訳を別のシートに置き、行の金額を SUMIF で内訳のシートから足す（代表の予算表の形）。
// 合計はすべて数式で書き、Excel を開かずに読めるよう、数式のセルにも計算した値を保存する（読み取りの budget-xlsx.mjs が保存された値を読むため）。
// 金額の計算は model（budgetTotals）と money-budget.mjs の式を使い、ここで丸めない
import {zipSync, strToU8} from 'fflate';
import {BUDGET_CATEGORIES, budgetTotals} from './budget-model.mjs';
import {unitPriceTimesQty} from './money-budget.mjs';

const LEFT = ['A', 'B', 'C', 'D', 'E'];
const COLS = {L: {name: 'B', price: 'C', qty: 'D', unit: 'E', amount: 'F', note: 'G'}, R: {name: 'J', price: 'K', qty: 'L', unit: 'M', amount: 'N', note: 'O'}};
const HEADERS = ['科目', '単価', '数量', '単位', '金額(税抜)', 'メモ'];
const BREAKDOWN_HEADERS = ['費目', '役名・名目', '数量', '単価', '金額(税抜)', 'メモ'];
const STYLE = {plain: 0, gray: 1, yellow: 2, bold: 3, date: 4};
const esc = (value) => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const sheetName = (name) => String(name).replace(/[\\/?:*[\]]/g, ' ').slice(0, 31);
const quoteSheet = (name) => `'${sheetName(name).replaceAll("'", "''")}'`;

function sheetXml(cells, widths) {
  const rows = new Map();
  for (const cell of cells) {
    const row = Number(cell.ref.match(/\d+$/)[0]);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(cell);
  }
  const colOf = (ref) => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
  const body = [...rows.keys()].sort((a, b) => a - b).map((r) => `<row r="${r}">${rows.get(r).sort((a, b) => colOf(a.ref) - colOf(b.ref)).map((cell) => {
    const s = cell.style ? ` s="${STYLE[cell.style]}"` : '';
    const f = cell.formula ? `<f>${esc(cell.formula)}</f>` : '';
    if (typeof cell.value === 'number') return `<c r="${cell.ref}"${s}>${f}<v>${cell.value}</v></c>`;
    if (cell.value == null || cell.value === '') return `<c r="${cell.ref}"${s}>${f}</c>`;
    if (cell.formula) return `<c r="${cell.ref}" t="str"${s}>${f}<v>${esc(cell.value)}</v></c>`;
    return `<c r="${cell.ref}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(cell.value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const cols = widths ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

function workbook(sheets) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    // 開いたら Excel が数式を計算し直す（保存した値は読み取りのためのもの）
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${esc(sheetName(sheet.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Yu Gothic"/></font><font><b/><sz val="11"/><name val="Yu Gothic"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC0C0C0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
  };
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheet.cells, sheet.widths); });
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), {level: 6});
}

// 予算書（版）か型を書き出す。input: {title, lines, managementFeeYen, contingencyYen, taxRateBps, breakdowns?}
//   lines: [{categoryCode, name, unitPriceYen?, qtyMilli?, unit?, amountExTaxYen?, confirmed?, note?, breakdown?: {sheet, items: [{label, qtyMilli?, unitPriceYen?, amountExTaxYen, note?}]}}]
//   型は amountExTaxYen を持たない行がある（空欄で書き、単価・数量があれば数式で掛ける）
export function buildBudgetWorkbook({title = '予算書', lines = [], managementFeeYen = 0, contingencyYen = 0, taxRateBps = 1000, template = false} = {}) {
  const cells = [];
  const put = (ref, value, extra = {}) => cells.push({ref, value, ...extra});
  put('B1', template ? `映画制作費予算書（型）${title}` : `映画制作費予算書 ${title}`, {style: 'bold'});
  const header = (side) => HEADERS.forEach((name, i) => put(`${Object.values(COLS[side])[i]}10`, name, {style: 'bold'}));
  header('L'); header('R');
  const breakdownSheets = new Map();
  const amountOf = (line) => {
    if (line.breakdown) return line.breakdown.items.reduce((sum, item) => sum + item.amountExTaxYen, 0);
    if (line.amountExTaxYen != null) return line.amountExTaxYen;
    if (line.unitPriceYen != null && line.qtyMilli != null) return unitPriceTimesQty(line.unitPriceYen, line.qtyMilli);
    return 0;
  };
  const subtotalRefs = [];
  const place = (side, codes, startRow) => {
    const c = COLS[side];
    let r = startRow;
    for (const code of codes) {
      const category = BUDGET_CATEGORIES.find((cat) => cat.code === code);
      const own = lines.filter((line) => line.categoryCode === code);
      const first = r;
      for (const line of own) {
        put(`${c.name}${r}`, line.name, line.confirmed ? {style: 'yellow'} : {});
        if (line.unitPriceYen != null) put(`${c.price}${r}`, line.unitPriceYen);
        if (line.qtyMilli != null) put(`${c.qty}${r}`, line.qtyMilli / 1000);
        if (line.unit) put(`${c.unit}${r}`, line.unit);
        const amount = amountOf(line);
        if (line.breakdown) {
          const sheet = sheetName(line.breakdown.sheet);
          if (!breakdownSheets.has(sheet)) breakdownSheets.set(sheet, []);
          breakdownSheets.get(sheet).push({parent: line.name, items: line.breakdown.items});
          const q = quoteSheet(sheet);
          put(`${c.amount}${r}`, amount, {formula: `SUMIF(${q}!$A$3:$A$500,${c.name}${r},${q}!$E$3:$E$500)`});
        } else if (line.amountExTaxYen == null && line.unitPriceYen != null && line.qtyMilli != null) {
          put(`${c.amount}${r}`, amount, {formula: `${c.price}${r}*${c.qty}${r}`});
        } else if (line.amountExTaxYen != null) {
          const product = line.unitPriceYen != null && line.qtyMilli != null ? unitPriceTimesQty(line.unitPriceYen, line.qtyMilli) : null;
          put(`${c.amount}${r}`, amount, product === amount ? {formula: `${c.price}${r}*${c.qty}${r}`} : {});
        }
        if (line.note) put(`${c.note}${r}`, line.note);
        r += 1;
      }
      // 型は区分に行が無くても、書き足せるよう空の行を1つ置く
      if (!own.length) r += 1;
      const subtotal = own.reduce((sum, line) => sum + amountOf(line), 0);
      put(`${c.name}${r}`, `${code} ${category.name}`, {style: 'gray'});
      put(`${c.qty}${r}`, '小計', {style: 'gray'});
      put(`${c.amount}${r}`, subtotal, {formula: `SUM(${c.amount}${first}:${c.amount}${r - 1})`, style: 'gray'});
      subtotalRefs.push(`${c.amount}${r}`);
      r += 1;
    }
    return r;
  };
  const leftEnd = place('L', LEFT, 11);
  const rightEnd = place('R', BUDGET_CATEGORIES.map((cat) => cat.code).filter((code) => !LEFT.includes(code)), 11);
  const totals = budgetTotals({lines: lines.map((line) => ({categoryCode: line.categoryCode, amountExTaxYen: amountOf(line)})), managementFeeYen, contingencyYen, taxRateBps});
  let r = Math.max(leftEnd, rightEnd) + 1;
  const row = {};
  put(`J${r}`, '直接制作費　合計'); put(`N${r}`, totals.directYen, {formula: subtotalRefs.join('+')}); row.direct = r++;
  put(`J${r}`, '制作管理費'); put(`N${r}`, managementFeeYen); row.fee = r++;
  put(`J${r}`, '小計'); put(`N${r}`, totals.directYen + managementFeeYen, {formula: `N${row.direct}+N${row.fee}`}); row.sub = r++;
  put(`J${r}`, '予備費'); put(`N${r}`, contingencyYen); row.res = r++;
  put(`J${r}`, '総合計（税抜き）', {style: 'gray'}); put(`N${r}`, totals.totalExTaxYen, {formula: `N${row.sub}+N${row.res}`, style: 'gray'}); row.total = r++;
  put('B6', '制作費見積り（税抜き）'); put('C6', totals.totalExTaxYen, {formula: `N${row.total}`});
  put('B7', `消費税（${taxRateBps / 100}％）`); put('C7', totals.taxYen, {formula: `ROUNDDOWN(C6*${taxRateBps}/10000,0)`});
  put('B8', '合計金額'); put('C8', totals.totalIncTaxYen, {formula: 'C6+C7'});
  put('B9', '＊黄色は確定');
  const sheets = [{name: '予算', cells, widths: [2, 28, 12, 8, 6, 14, 18, 2, 2, 28, 12, 8, 6, 14, 18]}];
  for (const [name, groups] of breakdownSheets) {
    const bc = [];
    bc.push({ref: 'A1', value: `${name}（行の金額は予算のシートが SUMIF で費目ごとに足す）`, style: 'bold'});
    BREAKDOWN_HEADERS.forEach((h, i) => bc.push({ref: `${'ABCDEF'[i]}2`, value: h, style: 'bold'}));
    let br = 3;
    for (const group of groups) {
      for (const item of group.items) {
        bc.push({ref: `A${br}`, value: group.parent}, {ref: `B${br}`, value: item.label});
        if (item.qtyMilli != null) bc.push({ref: `C${br}`, value: item.qtyMilli / 1000});
        if (item.unitPriceYen != null) bc.push({ref: `D${br}`, value: item.unitPriceYen});
        const product = item.unitPriceYen != null && item.qtyMilli != null ? unitPriceTimesQty(item.unitPriceYen, item.qtyMilli) : null;
        bc.push({ref: `E${br}`, value: item.amountExTaxYen, ...(product === item.amountExTaxYen ? {formula: `C${br}*D${br}`} : {})});
        if (item.note) bc.push({ref: `F${br}`, value: item.note});
        br += 1;
      }
    }
    sheets.push({name, cells: bc, widths: [18, 24, 8, 12, 14, 24]});
  }
  return {bytes: workbook(sheets), totals};
}
