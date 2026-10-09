// 画面から API を呼ぶ共通の入口。通信失敗・認証切れ・権限・入力誤り・競合・サーバー障害を区別して投げる。
// 既定の挙動は旧 main.jsx の api() と同じ（2xx の本体は ok:false でもそのまま返す。プレビューの
// エラー本体を読む画面があるため）。options.strict=true のときだけ 2xx の ok:false を入力誤りとして投げる。
// 純関数とクラスだけで、ブラウザ・Node・Worker で同じに動く（node:* を使わない）。
import {ORG_HEADER, ORG_MISMATCH_CODE, isOrgMismatch} from '../org-header.mjs';

export const NETWORK_MESSAGE = 'サーバーに接続できません。通信を確認して再試行してください';

// kind ごとの既定の表示文。サーバーが日本語の理由を返したときはそちらを優先する（server を除く）。
export const ERROR_TEXT = Object.freeze({
  network: NETWORK_MESSAGE,
  auth: 'ログインの有効期限が切れました。もう一度ログインしてください',
  forbidden: 'この操作の権限がありません',
  validation: '入力内容を確認してください',
  conflict: '他の人が先に更新したか、登録済みの内容と重なっています。再読込して確認してください',
  not_found: '対象が見つかりません。一覧を再読込してください',
  server: 'サーバーで処理に失敗しました。時間をおいて再試行してください',
  aborted: '処理を中断しました',
});

export const ERROR_KINDS = Object.freeze(Object.keys(ERROR_TEXT).filter((kind) => kind !== 'aborted'));

export class ApiError extends Error {
  constructor(message, {status = 0, kind = 'server', details = null, body = null, cause, code = null} = {}) {
    super(message || ERROR_TEXT[kind] || ERROR_TEXT.server, cause === undefined ? undefined : {cause});
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.details = details;
    this.body = body;
    // サーバーが本体に付けた目印（例 org_mismatch＝画面の組織とサーバーの組織の食い違い）。無ければ null
    this.code = code;
  }
}

export {ORG_HEADER, ORG_MISMATCH_CODE, isOrgMismatch};

export function isApiError(error) {
  return error instanceof ApiError || (error && typeof error === 'object' && error.name === 'ApiError' && typeof error.kind === 'string');
}

// HTTP 状態 → kind。400・413・422・428 等の 4xx は入力誤り（利用者が直せるもの）として扱う。
export function kindForStatus(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  if (status >= 400) return 'validation';
  return 'server';
}

const isAbort = (error) => error && (error.name === 'AbortError' || error.name === 'TimeoutError');

function looksLikeMarkup(text) {
  return /^\s*</.test(text);
}

// サーバー本体から理由の文を取り出す。HTML のエラーページや長すぎる本文は使わない。
export function messageFromBody(body) {
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
    if (body.error && typeof body.error.message === 'string') return body.error.message;
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
    return '';
  }
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text || looksLikeMarkup(text) || text.length > 300) return '';
    return text;
  }
  return '';
}

function detailsFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (Array.isArray(body.errors) && body.errors.length) return body.errors;
  if (body.details !== undefined && body.details !== null) return body.details;
  if (Array.isArray(body.errors)) return body.errors;
  return null;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Array.isArray(value);
}

function headersObject(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    const out = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return {...headers};
}

const hasHeader = (headers, name) => Object.keys(headers).some((key) => key.toLowerCase() === name);

async function readBody(response) {
  if (response.status === 204 || response.status === 205) return null;
  const type = response.headers?.get?.('content-type') || '';
  const text = await response.text();
  if (type.includes('json')) {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ApiError('サーバーの応答を読み取れませんでした。時間をおいて再試行してください', {status: response.status, kind: 'server', body: text, cause: error});
    }
  }
  return text;
}

const validOrgId = (value) => Number.isSafeInteger(value) && value > 0;

// createApi({fetchImpl, base, orgId, onOrgMismatch}) → request(path, options)
// options: fetch の引数に加えて strict（2xx の ok:false を投げる）、raw（成功時に Response をそのまま返す）、
// orgId（この要求で X-On-Org に載せる組織。null で載せない。省略時は createApi の orgId() の値）、
// notifyOrgMismatch（false なら組織の食い違いの 409 で onOrgMismatch を呼ばない。読み直しの途中の要求に使う）。
// orgId() は画面が描いている組織を返す関数。サーバーは食い違えば 409（code org_mismatch）を返し、そのとき onOrgMismatch(error) を呼んでから投げる。
// body に素のオブジェクト・配列を渡すと JSON にする。文字列の body には従来どおり JSON の content-type を付ける。
export function createApi({fetchImpl, base = '/api', orgId, onOrgMismatch} = {}) {
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  return async function request(path, options = {}) {
    const {strict = false, raw = false, headers: rawHeaders, body: rawBody, orgId: requestOrgId, notifyOrgMismatch = true, ...rest} = options || {};
    const headers = headersObject(rawHeaders);
    const org = options && Object.hasOwn(options, 'orgId') ? requestOrgId : (typeof orgId === 'function' ? orgId() : null);
    if (org !== null && org !== undefined && org !== '' && validOrgId(Number(org)) && !hasHeader(headers, ORG_HEADER.toLowerCase())) headers[ORG_HEADER] = String(Number(org));
    let body = rawBody;
    if (isPlainObject(body)) body = JSON.stringify(body);
    if (typeof body === 'string' && body && !hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
    const init = {...rest, headers};
    if (body !== undefined && body !== null) init.body = body;
    const url = /^https?:\/\//.test(path) ? path : `${base}${path}`;

    let response;
    try {
      response = await doFetch(url, init);
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError(NETWORK_MESSAGE, {status: 0, kind: 'network', cause: error});
    }

    if (response.ok && raw) return response;
    const data = await readBody(response);
    if (!response.ok) {
      const kind = kindForStatus(response.status);
      const reason = messageFromBody(data);
      const code = data && typeof data === 'object' && typeof data.code === 'string' ? data.code : null;
      const error = new ApiError(reason || ERROR_TEXT[kind], {status: response.status, kind, details: detailsFromBody(data), body: data, code});
      // 画面の組織とサーバーの組織が食い違った（別の画面で切り替えた等）。画面に今の組織で読み直させる
      if (response.status === 409 && code === ORG_MISMATCH_CODE && notifyOrgMismatch && typeof onOrgMismatch === 'function') {
        try { onOrgMismatch(error); } catch { /* 読み直しの失敗はこの要求の誤りに混ぜない */ }
      }
      throw error;
    }
    if (strict && data && typeof data === 'object' && data.ok === false) {
      throw new ApiError(messageFromBody(data) || ERROR_TEXT.validation, {status: response.status, kind: 'validation', details: detailsFromBody(data), body: data});
    }
    return data;
  };
}

// 画面に出す日本語の1文。server 障害はサーバーの生の文（英語の例外文・SQL 等）を主表示に出さない。
export function describeError(error) {
  if (error === null || error === undefined || error === '') return '';
  if (typeof error === 'string') return error;
  if (isAbort(error)) return ERROR_TEXT.aborted;
  if (isApiError(error)) {
    if (error.kind === 'network') return NETWORK_MESSAGE;
    if (error.kind === 'server') return ERROR_TEXT.server;
    if (error.kind === 'auth') return ERROR_TEXT.auth;
    const reason = typeof error.message === 'string' ? error.message.trim() : '';
    if (!reason || reason === ERROR_TEXT[error.kind]) return ERROR_TEXT[error.kind] || ERROR_TEXT.server;
    if (error.kind === 'conflict' && !/再読込|読み直/.test(reason)) return `${reason}。再読込して確認してください`;
    return reason;
  }
  if (error instanceof Error) return error.message || '処理に失敗しました';
  if (typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

// 折りたたみに出す技術情報（HTTP 状態・サーバーの生の文）。主表示には使わない。
export function technicalDetail(error) {
  if (!error || typeof error !== 'object') return '';
  const parts = [];
  if (isApiError(error)) {
    parts.push(`種類: ${error.kind}`);
    if (error.status) parts.push(`HTTP ${error.status}`);
    const reason = messageFromBody(error.body);
    if (reason) parts.push(reason);
    else if (error.message && error.message !== describeError(error)) parts.push(error.message);
    if (error.cause?.message) parts.push(`原因: ${error.cause.message}`);
    if (error.details && !Array.isArray(error.details) && typeof error.details === 'object') {
      try { parts.push(JSON.stringify(error.details)); } catch { /* 循環参照は出さない */ }
    }
  } else if (error instanceof Error) {
    parts.push(error.name ? `${error.name}: ${error.message}` : error.message);
  }
  return parts.filter(Boolean).join(' ／ ');
}

// 行・列つきのエラーを [{row, column, message}] にそろえる。
// 受け付ける形: {row|rowNo|sourceRow|line|index, column|field|key|header, message|error|reason}、文字列。
export function normalizeDetails(details) {
  if (!details) return [];
  const list = Array.isArray(details) ? details : Array.isArray(details.errors) ? details.errors : Array.isArray(details.rows) ? details.rows : [];
  return list.map((item) => {
    if (typeof item === 'string') return {row: null, column: null, message: item};
    if (!item || typeof item !== 'object') return {row: null, column: null, message: String(item)};
    const row = item.row ?? item.rowNo ?? item.row_no ?? item.sourceRow ?? item.source_row ?? item.line ?? null;
    const column = item.column ?? item.columnLabel ?? item.header ?? item.field ?? item.key ?? null;
    const message = item.message ?? item.error ?? item.reason ?? '';
    return {row: row === null || row === undefined || row === '' ? null : row, column: column === '' ? null : column, message: String(message)};
  }).filter((item) => item.message || item.row !== null || item.column !== null);
}

// Notice に渡す形（tone は error で固定。成否を本文から推測しない）。
export function errorNotice(error) {
  const details = isApiError(error) ? normalizeDetails(error.details) : [];
  return {
    tone: 'error',
    message: describeError(error),
    details,
    technical: technicalDetail(error),
    retryable: isApiError(error) ? ['network', 'server', 'conflict', 'not_found'].includes(error.kind) : true,
    kind: isApiError(error) ? error.kind : 'unknown',
  };
}

// 行・列つきのエラーのうち、フォームの項目（name か label が一致）に当たるものを name → 理由にする。
// 当たらないものは rest に残す（フォームの上の通知に出す）。
export function fieldErrorsFromDetails(details, fields = []) {
  const byKey = new Map();
  for (const field of fields) {
    if (!field?.name) continue;
    byKey.set(String(field.name), field.name);
    if (field.label) byKey.set(String(field.label), field.name);
  }
  const errors = {};
  const rest = [];
  for (const item of normalizeDetails(details)) {
    const name = item.column !== null && item.column !== undefined ? byKey.get(String(item.column)) : undefined;
    if (name && !errors[name]) errors[name] = item.message;
    else rest.push(item);
  }
  return {errors, rest};
}
