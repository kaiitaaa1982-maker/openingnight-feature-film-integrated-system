// 予算書の架空の xlsx を作る（試験と検証の種。実在の作品・人・会社・額は使わない）。
// 形は代表の手元の予算表（左右2区画・区分ごとに明細と「X 名前 … 小計」の行・右下に合計の行・上に見積りと消費税）と同じ並び。
// 読み取りの実装（src/planning/budget/budget-xlsx.mjs）は使わず、セルの XML を直に書く。数式のセルには Excel が計算したのと同じ値を <v> に入れる。
// 期待する結果は呼ぶ側の試験に手で書く（ここで計算しない）。
import {zipSync, strToU8} from 'fflate';

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const STYLE = {plain: 0, gray: 1, yellow: 2, date: 3};

// cells: [{ref, value?, formula?, style?}]。value が数なら数、文字なら inline の文字。formula があれば <f> と、value を保存された値として書く
function sheetXml(cells) {
  const rows = new Map();
  for (const cell of cells) {
    const row = Number(cell.ref.match(/\d+$/)[0]);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(cell);
  }
  const colOf = (ref) => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
  const body = [...rows.keys()].sort((a, b) => a - b).map((r) => {
    const xml = rows.get(r).sort((a, b) => colOf(a.ref) - colOf(b.ref)).map((cell) => {
      const s = cell.style ? ` s="${STYLE[cell.style]}"` : '';
      const f = cell.formula ? `<f>${esc(cell.formula)}</f>` : '';
      if (typeof cell.value === 'number') return `<c r="${cell.ref}"${s}>${f}<v>${cell.value}</v></c>`;
      if (cell.value == null) return `<c r="${cell.ref}"${s}>${f}</c>`;
      if (cell.formula) return `<c r="${cell.ref}" t="str"${s}>${f}<v>${esc(cell.value)}</v></c>`;
      return `<c r="${cell.ref}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(cell.value)}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${xml}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export function buildBudgetXlsx(sheets) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC0C0C0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
  };
  sheets.forEach((sheet, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sheet.cells); });
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])), {level: 6});
}

// 架空の予算書「架空作品 夜行列車（仮）」。左の区画は B〜H（科目・単価・数量・単位・金額(税抜)・金額(税込)・実費）、右の区画は J〜P。
// options.badSubtotalB: B 俳優費の小計の値を 400000 にする（正しくは 450000）。options.noTotals: 合計の行と見出しの上の要約を書かない
export function fictionalBudgetSheets(options = {}) {
  const cells = [];
  const put = (ref, value, extra = {}) => cells.push({ref, value, ...extra});
  put('B1', '映画制作費予算書 【検討用】');
  put('B3', '架空作品 夜行列車（仮）');
  put('J5', '作成日'); put('K5', 46000, {style: 'date'});
  put('N8', '準備期間：1ヶ月　撮影日数：4日間');
  put('N9', 'キャスト・スタッフ数:12名（予定）');
  const header = (col) => ['科目', '単価', '数量', '単位', '金額(税抜)', '金額(税込)', '実費'].forEach((name, i) => put(`${String.fromCharCode(col.charCodeAt(0) + i)}10`, name));
  header('B'); header('J');
  put('T10', '役名'); put('U10', '役者名'); put('V10', '所属事務所'); put('W10', '金額');
  // 明細の行: [行, 名前, 単価, 数量, 単位, 金額, 確定の色]
  const line = (side, r, name, price, qty, unit, amount, yellow = false) => {
    const [n, p, q, u, a] = side === 'L' ? ['B', 'C', 'D', 'E', 'F'] : ['J', 'K', 'L', 'M', 'N'];
    put(`${n}${r}`, name, yellow ? {style: 'yellow'} : {});
    if (price != null) put(`${p}${r}`, price);
    if (qty != null) put(`${q}${r}`, qty);
    if (unit != null) put(`${u}${r}`, unit);
    put(`${a}${r}`, amount, price != null && qty != null && price * qty === amount ? {formula: `${p}${r}*${q}${r}`} : {});
  };
  const subtotal = (side, r, label, from, to, value) => {
    const [n, q, a] = side === 'L' ? ['B', 'D', 'F'] : ['J', 'L', 'N'];
    put(`${n}${r}`, label, {style: 'gray'}); put(`${q}${r}`, '小計', {style: 'gray'});
    put(`${a}${r}`, value, {formula: `SUM(${a}${from}:${a}${to})`, style: 'gray'});
  };
  // 左: A〜E
  line('L', 11, '企画開発費', 100000, 1, '式', 100000);
  line('L', 12, '脚本料', 200000, 2, '本', 400000);
  subtotal('L', 13, 'A 企画費', 11, 12, 500000);
  line('L', 14, '主演', 300000, 1, '人', 300000, true);
  line('L', 15, '助演', 50000, 3, '人', 150000);
  put('B16', ' ※エキストラは別途');
  subtotal('L', 17, 'B 俳優費', 14, 16, options.badSubtotalB ? 400000 : 450000);
  line('L', 18, 'プロデューサー', 200000, 1, '式', 200000);
  subtotal('L', 19, 'C プロデューサー費', 18, 18, 200000);
  line('L', 20, '監督', 500000, 1, '式', 500000);
  line('L', 21, '撮影', 380000, 1, '式', 400000);
  line('L', 22, '助監督', 120000, 2.5, '週', 300000);
  line('L', 23, '録音', null, null, null, 0);
  subtotal('L', 24, 'D スタッフ費', 20, 23, 1200000);
  line('L', 25, 'ロケハン', 80000, 1, '式', 80000);
  subtotal('L', 26, 'E 製作準備費', 25, 25, 80000);
  // 右: F〜K と合計
  line('R', 11, '撮影機材費', 250000, 1, '式', 250000);
  subtotal('R', 12, 'F 機材費', 11, 11, 250000);
  line('R', 13, '美術費', 120000, 1, '式', 120000);
  subtotal('R', 14, 'G 美術・衣装費', 13, 13, 120000);
  line('R', 15, 'ロケ地', 300000, 1, '式', 300000);
  line('R', 16, '食費', 1500, 40, '食', 60000);
  subtotal('R', 17, 'H ロケーション費', 15, 16, 360000);
  line('R', 18, '音楽制作費', 100000, 1, '式', 100000);
  subtotal('R', 19, 'I 音楽・効果費', 18, 18, 100000);
  line('R', 20, 'オフライン編集費', 200000, 1, '式', 200000);
  line('R', 21, 'MA', null, 0, null, 0);
  subtotal('R', 22, 'J 編集・MA費', 20, 21, 200000);
  line('R', 23, '試写会場代', 50000, 1, '式', 50000);
  subtotal('R', 24, 'K プリント・制作諸費', 23, 23, 50000);
  if (!options.noTotals) {
    // 直接制作費は正しい式。総合計の式は E・制作管理費・予備費を落としている（代表の手元の予算表にあった誤りと同じ型）
    put('J26', '直接制作費　合計'); put('N26', 3510000, {formula: 'F13+F17+F19+F24+F26+N12+N14+N17+N19+N22+N24'});
    put('J27', '制作管理費'); put('N27', 100000);
    put('J28', '小計'); put('N28', 3610000, {formula: 'SUM(N26:N27)'});
    put('J29', '予備費'); put('N29', 50000);
    put('J30', '総合計（税抜き）', {style: 'gray'}); put('N30', 3430000, {formula: 'F13+F17+F19+F24+N12+N14+N17+N19+N22+N24', style: 'gray'});
    put('B6', '制作費見積り（税抜き）'); put('C6', 3430000, {formula: 'SUM(N30)'});
    put('B7', '消費税（10％）'); put('C7', 343000, {formula: 'C6*0.1'});
    put('B8', '合計金額'); put('C8', 3773000, {formula: 'SUM(C6:C7)'});
  }
  // 2枚目: 仮払い・領収書のまとめ（予算書としては読まない）
  const receipts = [{ref: 'A1', value: '●仮払い'}, {ref: 'A2', value: 'スタッフ名'}, {ref: 'B2', value: '交通費'}, {ref: 'A3', value: '架空スタッフ'}, {ref: 'B3', value: 1200}];
  return [{name: '予算', cells}, {name: '領収書まとめ', cells: receipts}];
}
