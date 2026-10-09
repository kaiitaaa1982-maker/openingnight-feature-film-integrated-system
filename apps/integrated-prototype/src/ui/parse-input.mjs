// 入力の揺れをシステム側で吸収するパース（ui-guidelines §3）。全角・カンマ・¥・円・空白を受け付けて数値や
// ISO 形式に直し、直せないときは日本語の理由を返す。純関数のみ（ブラウザ・Node・Worker で同じ結果）。
// 戻り値: 成功 {ok:true, value, blank} ／ 失敗 {ok:false, error}。空欄は {ok:true, value:null, blank:true}。

const ok = (value) => ({ok: true, value, blank: value === null});
const fail = (error) => ({ok: false, error});

// NFKC で全角英数・全角記号・半角カナをそろえ、空白（全角空白を含む）を取り除く。
function squash(text) {
  return String(text ?? '').normalize('NFKC').replace(/[\s​]+/g, '');
}

export function isBlankInput(value) {
  return value === null || value === undefined || (typeof value === 'string' && squash(value) === '');
}

const NEGATIVE_PREFIX = /^[-−‐‑‒–—―▲△]/; // - − ‐ ‑ ‒ – — ― ▲ △
const YEN_PREFIX = /^(?:¥|\\|jpy)/i; // ￥ は NFKC で ¥、＼ は \ になる
const YEN_SUFFIX = /(?:円|jpy|¥)$/i;

// 数字の文字列を符号・整数部・小数部に分ける。区切りの「,」「、」は取り除く。
function splitNumber(body) {
  let text = body.replace(/[,、]/g, '').replace(/。/g, '.');
  let negative = false;
  const paren = text.match(/^\((.*)\)$/);
  if (paren) {
    negative = true;
    text = paren[1];
  }
  if (NEGATIVE_PREFIX.test(text)) {
    negative = !negative;
    text = text.slice(1);
  }
  if (text.startsWith('+')) text = text.slice(1);
  const match = text.match(/^(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  return {negative, integer: match[1], fraction: match[2] || ''};
}

function toSafeInteger(parts) {
  const n = Number(parts.integer);
  if (!Number.isSafeInteger(n)) return null;
  const value = parts.negative ? -n : n;
  return Object.is(value, -0) ? 0 : value;
}

// 金額（円）。「１２，０００」「¥12,000」「12000円」「▲1,200」→ 数値。小数（0以外）は受け付けない。
export function parseYen(input, {allowNegative = true} = {}) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return fail('金額は数字で入力してください（例: 12,000）');
    if (!Number.isInteger(input)) return fail('金額は1円単位で入力してください（小数は使えません）');
    if (!allowNegative && input < 0) return fail('0以上の金額を入力してください');
    return ok(input);
  }
  if (isBlankInput(input)) return ok(null);
  let text = squash(input);
  let negative = false;
  if (NEGATIVE_PREFIX.test(text) && YEN_PREFIX.test(text.slice(1))) { // 「-¥1,000」
    negative = true;
    text = text.slice(1);
  }
  text = text.replace(YEN_PREFIX, '').replace(YEN_SUFFIX, '').replace(/[.。]-$/, '');
  const parts = splitNumber(text);
  if (!parts) return fail('金額は数字で入力してください（例: 12,000）');
  if (parts.fraction && /[1-9]/.test(parts.fraction)) return fail('金額は1円単位で入力してください（小数は使えません）');
  if (negative) parts.negative = !parts.negative;
  const value = toSafeInteger(parts);
  if (value === null) return fail('金額が大きすぎます。桁数を確認してください');
  if (!allowNegative && value < 0) return fail('0以上の金額を入力してください');
  return ok(value);
}

const COUNT_SUFFIX = /(?:件|個|枚|本|人|回|行|日|話|点|名|か月|ヶ月|ケ月|箇所)$/;

// 整数（数量・件数）。「１，２００」「1200件」→ 1200。
export function parseInteger(input, {allowNegative = true, min, max} = {}) {
  let value;
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) return fail('整数で入力してください（例: 1,200）');
    value = input;
  } else {
    if (isBlankInput(input)) return ok(null);
    const text = squash(input).replace(COUNT_SUFFIX, '');
    const parts = splitNumber(text);
    if (!parts) return fail('整数で入力してください（例: 1,200）');
    if (parts.fraction && /[1-9]/.test(parts.fraction)) return fail('整数で入力してください（小数は使えません）');
    value = toSafeInteger(parts);
    if (value === null) return fail('数が大きすぎます。桁数を確認してください');
  }
  if (!allowNegative && value < 0) return fail('0以上の数を入力してください');
  if (min !== undefined && value < min) return fail(`${min.toLocaleString('ja-JP')}以上の数を入力してください`);
  if (max !== undefined && value > max) return fail(`${max.toLocaleString('ja-JP')}以下の数を入力してください`);
  return ok(value);
}

// 仕様の名前（parseInt）でも使えるようにする。モジュール内では組み込みの parseInt を使わない。
export {parseInteger as parseInt};

const pad2 = (n) => String(n).padStart(2, '0');

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function eraYear(era, yearText) {
  const n = yearText === '元' ? 1 : Number(yearText);
  if (/^(令和|r)$/i.test(era)) return 2018 + n;
  return null;
}

function checkDate(year, month, day) {
  if (month < 1 || month > 12) return fail('月は1〜12で入力してください');
  if (day < 1 || day > daysInMonth(year, month)) return fail(`存在しない日付です（${year}年${month}月${day}日）`);
  return ok(`${year}-${pad2(month)}-${pad2(day)}`);
}

// 日付。「2026/9/1」「2026-09-01」「2026年9月1日」「20260901」「令和8年9月1日」→ "2026-09-01"。
export function parseDate(input) {
  if (isBlankInput(input)) return ok(null);
  const text = squash(input);
  let match = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:T.*)?$/);
  if (match) return checkDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return checkDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(令和|R)(\d{1,2}|元)[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/i);
  if (match) return checkDate(eraYear(match[1], match[2]), Number(match[3]), Number(match[4]));
  if (/^\d{1,2}[-/.月]\d{1,2}日?$/.test(text)) return fail('年を含めて入力してください（例: 2026/9/1）');
  return fail('日付は「2026/9/1」の形で入力してください');
}

// 月。「202609」「2026/9」「2026-09」「2026年9月」→ "2026-09"。日付を渡すとその月にする。
export function parseMonth(input) {
  if (isBlankInput(input)) return ok(null);
  const text = squash(input);
  let match = text.match(/^(\d{4})[-/.年](\d{1,2})月?$/) || text.match(/^(\d{4})(\d{2})$/);
  if (!match) {
    const era = text.match(/^(令和|R)(\d{1,2}|元)[-/.年](\d{1,2})月?$/i);
    if (era) match = [text, String(eraYear(era[1], era[2])), era[3]];
  }
  if (match) {
    const month = Number(match[2]);
    if (month < 1 || month > 12) return fail('月は1〜12で入力してください');
    return ok(`${match[1]}-${pad2(month)}`);
  }
  const date = parseDate(text);
  if (date.ok && date.value) return ok(date.value.slice(0, 7));
  if (!date.ok && /存在しない|1〜12/.test(date.error)) return date;
  return fail('月は「2026/9」の形で入力してください');
}

// 入力欄に出す整形（桁区切り、単位なし）。数でないものはそのまま返す。
export function formatNumberInput(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('ja-JP', {maximumFractionDigits: 0});
}

// 項目の型ごとの変換（RecordForm が保存前に使う）。text/textarea/select は前後の空白を落として空欄を null にする。
export function parseFieldValue(type, input, options = {}) {
  switch (type) {
    case 'yen': return parseYen(input, options);
    case 'int':
    case 'number': return parseInteger(input, options);
    case 'date': return parseDate(input);
    case 'month': return parseMonth(input);
    default: {
      if (input === null || input === undefined) return ok(null);
      if (typeof input !== 'string') return ok(input);
      const text = input.trim();
      return ok(text === '' ? null : text);
    }
  }
}

// ---- フォーム全体の検査（RecordForm が使う） ----
// fields: [{name, label, type, required, allowNegative, min, max, derived(values), validate(value, values), visible(raw), hidden, defaultValue}]
// raw: 入力中の値（文字）。derived はほかの項目を変換した後の値から計算する（入力させない導出値）。
// 戻り値: {ok, values（変換後）, errors（name → 日本語の理由）, order（理由のある項目名、画面の並び順）}

export function requiredMessage(field) {
  const label = field.label || field.name;
  return ['select', 'entity'].includes(field.type) ? `${label}を選択してください` : `${label}を入力してください`;
}

export function validateFields(fields = [], raw = {}) {
  const values = {};
  const errors = {};
  const active = fields.filter((field) => field && field.name && (!field.visible || field.visible(raw)));
  for (const field of active.filter((item) => typeof item.derived !== 'function')) {
    const input = raw[field.name] !== undefined ? raw[field.name] : field.defaultValue;
    const parsed = parseFieldValue(field.type, input, {allowNegative: field.allowNegative ?? false, min: field.min, max: field.max});
    if (!parsed.ok) {
      errors[field.name] = parsed.error;
      continue;
    }
    if (field.required && parsed.value === null) {
      errors[field.name] = requiredMessage(field);
      continue;
    }
    const custom = typeof field.validate === 'function' ? field.validate(parsed.value, raw) : null;
    if (custom) {
      errors[field.name] = custom;
      continue;
    }
    values[field.name] = parsed.value;
  }
  for (const field of active.filter((item) => typeof item.derived === 'function')) {
    const value = field.derived(values, raw);
    values[field.name] = value === undefined ? null : value;
  }
  const order = fields.map((field) => field?.name).filter((name) => Object.hasOwn(errors, name));
  return {ok: order.length === 0, values, errors, order};
}

// 新規登録で送る値。空欄（null）の任意項目は送らない（DB の既定値を上書きしない）。
export function createPayload(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined));
}

// 修正で送る値。元の値から変わった項目だけ（数値と数字の文字は同じとみなす。空欄にした項目は null で送る）。
export function diffValues(values, original = {}) {
  const same = (a, b) => {
    const blankA = a === null || a === undefined || a === '';
    const blankB = b === null || b === undefined || b === '';
    if (blankA || blankB) return blankA && blankB;
    return String(a) === String(b);
  };
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => !same(value, original[key])));
}
