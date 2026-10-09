// 画面・帳票で共通に使う表示書式。純関数のみ（ブラウザ・Node・Worker で同じ結果）。
// 日時は日本時間（JST, UTC+9 固定）で表示する。値が無いときは「未確認」と書き、0で埋めない。

export const UNKNOWN_TEXT = '未確認';
export const BLANK_ZERO_TEXT = '—';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const integerFormat = new Intl.NumberFormat('ja-JP', {maximumFractionDigits: 0});
const yenFormat = new Intl.NumberFormat('ja-JP', {style: 'currency', currency: 'JPY', maximumFractionDigits: 0});
const decimalFormats = new Map();

export function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value));
}

// 数値または数値だけの文字列（"1200" "-3.5"）を数に直す。数でないものは null。
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

const noNegativeZero = (n) => (Object.is(n, -0) ? 0 : n);

// 整数表示（桁区切り）。-1234 → "-1,234"。
export function int(value) {
  if (isBlank(value)) return UNKNOWN_TEXT;
  const n = toNumber(value);
  if (n === null) return String(value);
  return integerFormat.format(noNegativeZero(Math.round(n)) + 0);
}

// 小数を含む数値（最大 digits 桁）。
export function decimal(value, {digits = 2} = {}) {
  if (isBlank(value)) return UNKNOWN_TEXT;
  const n = toNumber(value);
  if (n === null) return String(value);
  if (!decimalFormats.has(digits)) decimalFormats.set(digits, new Intl.NumberFormat('ja-JP', {maximumFractionDigits: digits}));
  return decimalFormats.get(digits).format(noNegativeZero(n) + 0);
}

// 円表示（文章中で使う）。-1234 → "-￥1,234"。表のセルは単位を見出しに書き、int() で出す。
export function yen(value) {
  if (isBlank(value)) return UNKNOWN_TEXT;
  const n = toNumber(value);
  if (n === null) return String(value);
  return yenFormat.format(noNegativeZero(Math.round(n)) + 0);
}

// 率表示。0.123 → "12.3%"。分母0などで有限でないときは「—」。
export function rate(value, {digits = 1} = {}) {
  if (isBlank(value)) return UNKNOWN_TEXT;
  if (typeof value === 'number' && !Number.isFinite(value)) return BLANK_ZERO_TEXT;
  const n = toNumber(value);
  if (n === null) return String(value);
  const text = (n * 100).toFixed(digits);
  return `${/^-0(\.0+)?$/.test(text) ? text.slice(1) : text}%`;
}

// 年付きの月。"2026-09" / "2026-09-24" / "202609" → "2026年9月"。
export function month(value) {
  if (isBlank(value) || value === '') return UNKNOWN_TEXT;
  const match = String(value).trim().match(/^(\d{4})[-/]?(\d{1,2})(?:[-/]\d{1,2})?$/);
  if (!match) return String(value);
  const m = Number(match[2]);
  if (m < 1 || m > 12) return String(value);
  return `${match[1]}年${m}月`;
}

// ISO・SQLite の日時文字列を Date に直す。時差の無い日時（SQLite の CURRENT_TIMESTAMP）は UTC とみなす。
export function parseTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(text);
  const date = new Date(naive ? `${naive[1]}T${naive[2]}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (n) => String(n).padStart(2, '0');

function jstParts(date) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(), mm: shifted.getUTCMinutes(),
  };
}

// 日付（JST）。"2026-09-24" はそのまま暦日として "2026/09/24"。日時は JST の暦日にする。
export function dateJst(value) {
  if (isBlank(value) || value === '') return UNKNOWN_TEXT;
  if (typeof value === 'string') {
    const dateOnly = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) return `${dateOnly[1]}/${dateOnly[2]}/${dateOnly[3]}`;
  }
  const date = parseTimestamp(value);
  if (!date) return String(value);
  const p = jstParts(date);
  return `${p.y}/${pad(p.m)}/${pad(p.d)}`;
}

// 日時（JST）。"2026-09-24T00:18:32Z" → "2026/09/24 09:18"。
export function dateTimeJst(value) {
  if (isBlank(value) || value === '') return UNKNOWN_TEXT;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return dateJst(value);
  const date = parseTimestamp(value);
  if (!date) return String(value);
  const p = jstParts(date);
  return `${p.y}/${pad(p.m)}/${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`;
}

// JST の暦日を "YYYYMMDD" で返す（ファイル名用）。
export function compactDateJst(date = new Date()) {
  const p = jstParts(date instanceof Date ? date : new Date(date));
  return `${p.y}${pad(p.m)}${pad(p.d)}`;
}

export const NUMERIC_TYPES = Object.freeze(['yen', 'int', 'number', 'rate']);
export const isNumericType = (type) => NUMERIC_TYPES.includes(type);

// 型に応じたセルの表示文字列。null/undefined →「未確認」、blankZero のとき数値の 0 →「—」。
export function cellText(type, value, {blankZero = false, digits} = {}) {
  if (isBlank(value)) return UNKNOWN_TEXT;
  if (isNumericType(type)) {
    const n = toNumber(value);
    if (n === null) return value === '' ? UNKNOWN_TEXT : String(value);
    if (blankZero && n === 0) return BLANK_ZERO_TEXT;
    if (type === 'rate') return rate(n, {digits: digits ?? 1});
    if (type === 'number') return decimal(n, {digits: digits ?? 2});
    return int(n);
  }
  if (type === 'date') return value === '' ? UNKNOWN_TEXT : dateJst(value);
  if (type === 'datetime') return value === '' ? UNKNOWN_TEXT : dateTimeJst(value);
  if (type === 'month') return value === '' ? UNKNOWN_TEXT : month(value);
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  return String(value);
}

// 表示幅（全角=2、半角=1）。Excel の列幅や固定幅の計算に使う。
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    width += code <= 0x7e || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2;
  }
  return width;
}
