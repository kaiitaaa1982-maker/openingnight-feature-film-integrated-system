// 入出金の履歴（会計の最初の組。会社ルートの plans/2026-10-22-folder-cashflow.md の「最優先」）の純関数。
// 銀行の明細 CSV の読み取り・重なりの判定に使う鍵・口座ごとの履歴と残高の累計。金額は整数の円で、小数・丸めは使わない（docs/rules/money.md）

export const CASHBOOK_PARSER = 'csv-v1';
export const MAX_STATEMENT_CHARS = 4_000_000;
const MAX_YEN = 1_000_000_000_000;

// 見出しの語（銀行ごとに違う）。どれにも当たらない列は使わない
const HEADER_WORDS = Object.freeze({
  date: ['取引日', '日付', '年月日', 'お取引日', '取扱日', '取引年月日', '勘定日', 'date'],
  in: ['入金', 'お預入れ', 'お預入金額', '預入金額', '入金額', '入金金額', 'お預け入れ', '預り金額', 'deposit'],
  out: ['出金', 'お引出し', 'お引出金額', '引出金額', '出金額', '出金金額', '支払金額', 'お支払金額', 'withdrawal'],
  amount: ['金額', '取引金額', '入出金', '入出金額', 'amount'],
  balance: ['残高', '差引残高', '取引後残高', 'お取引後残高', 'balance'],
  description: ['摘要', '内容', 'お取引内容', '取引内容', 'お取り扱い内容', 'お取扱内容', '取扱内容', '入出金内容', '摘要内容', '備考', 'メモ', 'description'],
});

const norm = (value) => String(value ?? '').normalize('NFKC').trim();

// CSV を行×列に分ける（ダブルクォートの中のカンマ・改行・"" を扱う）
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => norm(c) !== ''));
}

// 円の文字を整数にする。カンマ・円記号・空白は外す。小数や数字でないものは null（読めない額を0にしない）
export function parseYen(value) {
  const text = norm(value).replace(/[,，¥￥円\s]/g, '').replace(/^△/, '-').replace(/^▲/, '-');
  if (text === '' || text === '-') return {empty: true, value: null};
  if (!/^-?\d+$/.test(text)) return {empty: false, value: null};
  const n = Number(text);
  if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_YEN) return {empty: false, value: null};
  return {empty: false, value: n};
}

const pad = (n) => String(n).padStart(2, '0');
// 日付の文字を YYYY-MM-DD にする（2026/9/5・2026-09-05・20260905・2026年9月5日・令和8年9月5日・R8.9.5）。暦にない日は null
export function parseDate(value) {
  let text = norm(value);
  const era = text.match(/^(?:令和|R)(\d{1,2}|元)[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/i);
  if (era) text = `${(era[1] === '元' ? 1 : Number(era[1])) + 2018}/${era[2]}/${era[3]}`;
  let m = text.match(/^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/) || text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 20); r += 1) {
    // 見出しの「(円)」などの括弧は外して比べる（例「入出金(円)」「取引後残高(円)」）
    const cells = rows[r].map((c) => norm(c).replace(/[(（][^)）]*[)）]/g, '').trim().toLowerCase());
    const columns = {};
    for (const [key, words] of Object.entries(HEADER_WORDS)) {
      const index = cells.findIndex((c) => words.some((w) => c === w.toLowerCase()));
      if (index >= 0) columns[key] = index;
    }
    if (columns.date != null && (columns.amount != null || columns.in != null || columns.out != null)) return {headerRow: r, columns};
  }
  return null;
}

// 明細の CSV を行にする。見出しの行を探し、日付・入金・出金（または符号つきの金額）・残高・摘要の列を読む。
// 読めない行は errors に行番号つきで返し、lines には入れない（取込は errors が0のときだけ受け口が許す）
export function parseStatement(text) {
  if (typeof text !== 'string' || text.length === 0) return {lines: [], errors: [{row: 0, message: 'CSV が空です'}], columns: null};
  if (text.length > MAX_STATEMENT_CHARS) return {lines: [], errors: [{row: 0, message: 'CSV が大きすぎます'}], columns: null};
  const rows = parseCsv(text);
  const found = findHeader(rows);
  if (!found) return {lines: [], errors: [{row: 0, message: '見出しの行（日付と、入金・出金または金額の列）が見つかりません'}], columns: null};
  const {headerRow, columns} = found;
  const lines = [];
  const errors = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const rowNo = r + 1;
    const valueDate = parseDate(cells[columns.date]);
    if (!valueDate) { errors.push({row: rowNo, message: `日付を読めません（${norm(cells[columns.date]) || '空欄'}）`}); continue; }
    let direction = null;
    let amountYen = null;
    if (columns.in != null || columns.out != null) {
      const inYen = columns.in != null ? parseYen(cells[columns.in]) : {empty: true, value: null};
      const outYen = columns.out != null ? parseYen(cells[columns.out]) : {empty: true, value: null};
      if ((!inYen.empty && inYen.value == null) || (!outYen.empty && outYen.value == null)) { errors.push({row: rowNo, message: '入金・出金の額を読めません'}); continue; }
      const hasIn = inYen.value != null && inYen.value !== 0;
      const hasOut = outYen.value != null && outYen.value !== 0;
      if (hasIn === hasOut) { errors.push({row: rowNo, message: hasIn ? '入金と出金の両方に額があります' : '入金・出金のどちらにも額がありません'}); continue; }
      direction = hasIn ? 'in' : 'out';
      amountYen = Math.abs(hasIn ? inYen.value : outYen.value);
    } else {
      const signed = parseYen(cells[columns.amount]);
      if (signed.value == null || signed.value === 0) { errors.push({row: rowNo, message: '金額を読めません'}); continue; }
      direction = signed.value > 0 ? 'in' : 'out';
      amountYen = Math.abs(signed.value);
    }
    let balanceAfterYen = null;
    if (columns.balance != null) {
      const balance = parseYen(cells[columns.balance]);
      if (!balance.empty && balance.value == null) { errors.push({row: rowNo, message: '残高を読めません'}); continue; }
      balanceAfterYen = balance.value;
    }
    const description = columns.description != null ? norm(cells[columns.description]).slice(0, 300) || null : null;
    lines.push({lineNo: lines.length + 1, sourceRow: rowNo, valueDate, direction, amountYen, balanceAfterYen, description});
  }
  return {lines: withDedupeKeys(lines), errors, columns};
}

// 同じ取引（日・向き・額・取引後の残高）が1通の中に何回目かまで含めた鍵。期間の重なる明細を置いても、同じ行は同じ鍵になる
export function withDedupeKeys(lines) {
  const seen = new Map();
  return lines.map((line) => {
    const base = `${line.valueDate}|${line.direction}|${line.amountYen}|${line.balanceAfterYen ?? ''}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {...line, dedupeKey: `${base}|${n}`};
  });
}

// 明細の行から作る仕訳の行（口座の現預金の科目と相手の科目）。入金は現預金が借方、出金は貸方
export function bankLineJournal({direction, amountYen}, {cashAccountId, bankAccountId, counterAccountId}) {
  const cash = {accountId: cashAccountId, bankAccountId, amountYen};
  const counter = {accountId: counterAccountId, bankAccountId: null, amountYen};
  return direction === 'in'
    ? [{lineNo: 1, side: 'debit', ...cash}, {lineNo: 2, side: 'credit', ...counter}]
    : [{lineNo: 1, side: 'debit', ...counter}, {lineNo: 2, side: 'credit', ...cash}];
}

// 取消の仕訳の行（借方と貸方を入れ替える）
export const reversedLines = (lines) => lines.map((line) => ({...line, side: line.side === 'debit' ? 'credit' : 'debit'}));

// 口座の履歴: 現預金の行（口座を持つ行）を日付・仕訳の順に並べ、残高の累計を足す。取り消した仕訳とその取消は、ふだんの履歴から外す
// rows: {entryId, entryDate, reversesEntryId, side, amountYen, sourceKind, description, counterAccounts:[{id,name}], bankLineId}
export function buildHistory(rows, {suspenseAccountId = null, includeReversed = false} = {}) {
  const reversed = new Set(rows.filter((r) => r.reversesEntryId != null).map((r) => r.reversesEntryId));
  const visible = includeReversed ? rows : rows.filter((r) => r.reversesEntryId == null && !reversed.has(r.entryId));
  const sorted = [...visible].sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : a.entryId - b.entryId));
  let balance = 0;
  return sorted.map((row) => {
    const signed = row.side === 'debit' ? row.amountYen : -row.amountYen;
    balance += signed;
    return {entryId: row.entryId, date: row.entryDate, sourceKind: row.sourceKind, inYen: signed > 0 ? signed : null, outYen: signed < 0 ? -signed : null,
      balanceYen: balance, items: row.counterAccounts.map((a) => a.name), description: row.description ?? null, bankLineId: row.bankLineId ?? null,
      unclassified: suspenseAccountId != null && row.counterAccounts.some((a) => a.id === suspenseAccountId)};
  });
}

// 銀行の残高（明細の最後の行の取引後の残高）と、その日までの履歴の残高を比べる
export function reconcile(history, statementLines) {
  const withBalance = statementLines.filter((l) => l.balanceAfterYen != null);
  if (!withBalance.length) return {bankBalanceYen: null, asOf: null, bookBalanceYen: history.at(-1)?.balanceYen ?? 0, diffYen: null};
  const last = [...withBalance].sort((a, b) => (a.valueDate < b.valueDate ? -1 : a.valueDate > b.valueDate ? 1 : a.id - b.id)).at(-1);
  const upTo = history.filter((h) => h.date <= last.valueDate);
  const bookBalanceYen = upTo.at(-1)?.balanceYen ?? 0;
  return {bankBalanceYen: last.balanceAfterYen, asOf: last.valueDate, bookBalanceYen, diffYen: last.balanceAfterYen - bookBalanceYen};
}
