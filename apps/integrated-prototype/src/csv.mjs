export function parseCsv(text) {
  const rows = []; let row = []; let value = ''; let quoted = false; let afterQuote = false; let line = 1; let rowLine = 1;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else { value += char; if (char === '\n') line++; }
    } else if (afterQuote) {
      if (char === ',') { row.push(value); value = ''; afterQuote = false; }
      else if (char === '\r' && input[i + 1] === '\n') { /* handled with LF */ }
      else if (char === '\n') { row.push(value); rows.push({ cells: row, line: rowLine }); row = []; value = ''; afterQuote = false; line++; rowLine = line; }
      else throw new Error(`${line}行目: 引用符の後に不正な文字があります`);
    } else if (char === '"') { if (value !== '') throw new Error(`${line}行目: 引用符はセルの先頭に必要です`); quoted = true; }
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); rows.push({ cells: row, line: rowLine }); row = []; value = ''; line++; rowLine = line; }
    else value += char;
  }
  if (quoted) throw new Error('CSVの引用符が閉じていません');
  if (value || row.length || afterQuote) { row.push(value.replace(/\r$/, '')); rows.push({ cells: row, line: rowLine }); }
  const nonEmpty = rows.filter(item => item.cells.some(cell => cell.trim() !== ''));
  if (nonEmpty.length < 2) throw new Error('CSVには見出しと1行以上のデータが必要です');
  const headers = nonEmpty[0].cells.map(v => v.trim());
  if (new Set(headers).size !== headers.length || headers.some(v => !v)) throw new Error('CSV見出しが空欄または重複しています');
  return nonEmpty.slice(1).map(item => {
    if (item.cells.length !== headers.length) throw new Error(`${item.line}行目: 列数が見出しと一致しません`);
    return { rowNo: item.line, values: Object.fromEntries(headers.map((h, i) => [h, item.cells[i].trim()])), extra: [] };
  });
}

export function toCsv(headers, rows) {
  const q = value => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
  return [headers, ...rows].map(row => row.map(q).join(',')).join('\r\n') + '\r\n';
}

export function integer(value, { signed = false, nullable = false } = {}) {
  if (nullable && value === '') return null;
  const normalized = String(value).replace(/[￥¥,，\s]/g, '').replace(/[－−]/g,'-').replace(/[０-９]/g, c => String('０１２３４５６７８９'.indexOf(c)));
  if (!/^-?\d+$/.test(normalized)) throw new Error(`整数ではありません: ${value}`);
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || (!signed && number < 0)) throw new Error(`有効な整数ではありません: ${value}`);
  return number;
}

export const isoDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`日付はYYYY-MM-DD形式です: ${value}`);
  const [y,m,d]=value.split('-').map(Number), date=new Date(Date.UTC(y,m-1,d));
  if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d) throw new Error(`存在しない日付です: ${value}`);
  return value;
};
export const month = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : (() => { throw new Error(`計上月はYYYY-MM形式です: ${value}`); })();
