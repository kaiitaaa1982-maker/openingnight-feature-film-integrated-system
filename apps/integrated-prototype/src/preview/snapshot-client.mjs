// 閲覧用プレビュー（vite build --mode preview）の API 応答。サーバーを持たない静的な版で、記録した GET の応答だけを返す。
// ・鍵は「メソッド＋パス＋並べ替えた問い合わせ」（snapshotKey）。記録（scripts/build-preview.mjs）と再生で同じ関数を使う。
// ・GET 以外（保存・登録・取消など）は受け付けず、403 と日本語の理由を返す。記録にない GET は 404 と日本語の理由を返す。
//   例外は保存しない照合（computedPosts）だけで、記録した GET の応答から同じ純関数で組み立てる。
//   どちらも ui/api-client.mjs の通常のエラー表示（describeError）でそのまま日本語の文になる。
// ・fetch と同じ形の関数を返すので、createApi の既定（globalThis.fetch）や画面の直接の fetch('/api/...') をまとめて差し替えられる。
// 純関数だけで、ブラウザ・Node・Worker で同じに動く（node:* を使わない）。

export const PREVIEW_READ_ONLY_MESSAGE = 'プレビューでは保存できません（閲覧専用・架空データ）';
export const PREVIEW_MISSING_MESSAGE = 'このプレビューに含まれていない表示です';
export const PREVIEW_BANNER_TEXT = '閲覧用のプレビュー（架空データ・保存はできません）';
export const PREVIEW_DATA_FORMAT = 'openingnight-preview';
export const PREVIEW_DATA_VERSION = 1;
export const PREVIEW_DATA_FILE = 'preview-data.json';

const DEFAULT_BASE = 'http://preview.invalid/';

export function isApiPath(pathname) {
  const path = String(pathname || '');
  return path === '/api' || path.startsWith('/api/');
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 問い合わせを名前→値の順に並べ替えた文字列（先頭の ? なし）。同じ名前が複数あっても順序によらず同じ文字列になる
export function sortedQuery(searchParams) {
  const pairs = [...new URLSearchParams(searchParams)];
  pairs.sort(([ak, av], [bk, bv]) => compare(ak, bk) || compare(av, bv));
  return new URLSearchParams(pairs).toString();
}

// "GET /api/path?a=1&b=2" の形。url は相対（/api/...）でも絶対でもよい
export function snapshotKey(method, url, base = DEFAULT_BASE) {
  const parsed = url instanceof URL ? url : new URL(String(url), base);
  const query = sortedQuery(parsed.searchParams);
  return `${String(method || 'GET').toUpperCase()} ${parsed.pathname}${query ? `?${query}` : ''}`;
}

// 文字として残す型。Excel（application/vnd.openxmlformats-…）は名前に xml を含むが中身は zip なので、
// xml は application/xml と +xml の接尾辞だけを文字とみなす
const TEXT_TYPE = /^text\/|json|(^|\/)xml(;|$)|\+xml|csv|javascript|html/i;
const JSON_TYPE = /json/i;
const NO_BODY = new Set([204, 205, 304]);

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(String(text || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 記録の形: JSON は {status, body}（body は解釈済みの値）。JSON 以外の文字は {status, type, body: 文字列}、
// 文字でないものは {status, type, body: base64, encoding: 'base64'}。disposition はダウンロードの名前（Content-Disposition）
export function encodeRecord({status, contentType = '', bytes, disposition = ''}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const type = String(contentType || '');
  const extra = disposition ? {disposition: String(disposition)} : {};
  if (NO_BODY.has(status) || !data.length) return {status, ...(type && !JSON_TYPE.test(type) ? {type} : {}), body: null, ...extra};
  if (TEXT_TYPE.test(type)) {
    const text = new TextDecoder('utf-8').decode(data);
    if (JSON_TYPE.test(type)) {
      try {
        return {status, body: JSON.parse(text), ...extra};
      } catch {
        return {status, type, body: text, ...extra};
      }
    }
    return {status, type, body: text, ...extra};
  }
  return {status, type: type || 'application/octet-stream', body: bytesToBase64(data), encoding: 'base64', ...extra};
}

function recordType(record) {
  return record.type || 'application/json; charset=utf-8';
}

function recordPayload(record) {
  if (record.body === null || record.body === undefined) return null;
  if (record.encoding === 'base64') return base64ToBytes(record.body);
  if (record.type) return String(record.body);
  return JSON.stringify(record.body);
}

export function responseFromRecord(record) {
  const status = Number(record?.status) || 200;
  const headers = {'content-type': recordType(record)};
  if (record?.disposition) headers['content-disposition'] = record.disposition;
  return new Response(NO_BODY.has(status) ? null : recordPayload(record), {status, headers});
}

// ダウンロードのリンク（<a href="/api/...">）用。記録を Blob にする（同期。クリックの中で新しい窓を開けるように）
export function blobFromRecord(record) {
  const payload = recordPayload(record);
  return new Blob(payload === null ? [] : [payload], {type: recordType(record)});
}

// Content-Disposition の filename*（UTF-8）か filename。無ければパスの最後
export function downloadName(record, url, base = DEFAULT_BASE) {
  const disposition = String(record?.disposition || '');
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* 読めない名前は次へ */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  if (plain) return plain[1].trim();
  const path = new URL(String(url), base).pathname;
  return decodeURIComponent(path.split('/').filter(Boolean).pop() || 'download');
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8'}});
}

export function readOnlyResponse() {
  return jsonResponse(403, {ok: false, error: PREVIEW_READ_ONLY_MESSAGE, preview: 'read-only'});
}

export function missingResponse() {
  return jsonResponse(404, {ok: false, error: PREVIEW_MISSING_MESSAGE, preview: 'missing'});
}

function toMap(responses) {
  if (responses instanceof Map) return responses;
  return new Map(Object.entries(responses || {}));
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  try { return new DOMException('処理を中断しました', 'AbortError'); } catch {
    const error = new Error('処理を中断しました');
    error.name = 'AbortError';
    return error;
  }
}

async function requestText(request, init) {
  if (typeof init?.body === 'string') return init.body;
  if (request) {
    try { return await request.clone().text(); } catch { return ''; }
  }
  return '';
}

// fetch と同じ形の関数。/api/ 以外（プレビューのデータ・画像など）は fallbackFetch に渡す。
// base は相対 URL を解決する基準（文字列か、呼ぶたびに今の URL を返す関数）。別の起点（外部）の URL は API として扱わない
// computedPosts は、保存しない（読むだけの）POST を記録した GET の応答から組み立てる決まり
//   {'/api/…': {source: '/api/…（記録した GET）', compute(input, sourceBody) → {status, body}}}。ほかの POST は今までどおり保存できないと返す
export function createSnapshotFetch({responses, fallbackFetch = null, base = DEFAULT_BASE, onMiss, onBlocked, computedPosts = {}} = {}) {
  const table = toMap(responses);
  const baseOf = () => (typeof base === 'function' ? base() : base) || DEFAULT_BASE;
  return async function snapshotFetch(input, init = {}) {
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const href = request ? request.url : input instanceof URL ? input.href : String(input);
    const method = String(init?.method || request?.method || 'GET').toUpperCase();
    const signal = init?.signal || request?.signal;
    if (signal?.aborted) throw abortError(signal);
    const origin = new URL(baseOf()).origin;
    const parsed = new URL(href, baseOf());
    if (parsed.origin !== origin || !isApiPath(parsed.pathname)) {
      if (typeof fallbackFetch === 'function') return fallbackFetch(input, init);
      return missingResponse();
    }
    const rule = method === 'POST' && Object.hasOwn(computedPosts, parsed.pathname) ? computedPosts[parsed.pathname] : null;
    if (rule) {
      const sourceKey = snapshotKey('GET', new URL(rule.source, parsed));
      const source = table.get(sourceKey);
      if (!source) {
        onMiss?.({key: sourceKey});
        return missingResponse();
      }
      if (Number(source.status) !== 200) return responseFromRecord(source);
      let payload = {};
      try { payload = JSON.parse((await requestText(request, init)) || '{}'); } catch { payload = {}; }
      const out = rule.compute(payload, source.body);
      return jsonResponse(out.status || 200, out.body);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      onBlocked?.({method, key: snapshotKey(method, parsed)});
      return readOnlyResponse();
    }
    const key = snapshotKey('GET', parsed);
    const record = table.get(key);
    if (!record) {
      onMiss?.({key});
      return missingResponse();
    }
    const response = responseFromRecord(record);
    return method === 'HEAD' ? new Response(null, {status: response.status, headers: response.headers}) : response;
  };
}

// preview-data.json（と、大きいときの分割ファイル）を1つの表にまとめる。形式・版が違えば読まない
export function mergePreviewData(index, parts = []) {
  if (!index || typeof index !== 'object' || index.format !== PREVIEW_DATA_FORMAT) throw new Error('プレビューのデータの形式が違います');
  if (index.version !== PREVIEW_DATA_VERSION) throw new Error(`プレビューのデータの版（${index.version}）に対応していません`);
  const responses = new Map(Object.entries(index.responses || {}));
  for (const part of parts) {
    if (!part || part.format !== PREVIEW_DATA_FORMAT || part.version !== PREVIEW_DATA_VERSION) throw new Error('プレビューの分割データの形式が違います');
    for (const [key, record] of Object.entries(part.responses || {})) {
      if (responses.has(key)) throw new Error(`プレビューのデータに同じ鍵が2回あります（${key}）`);
      responses.set(key, record);
    }
  }
  if (Number.isInteger(index.count) && index.count !== responses.size) throw new Error(`プレビューのデータの件数が合いません（${responses.size}／${index.count}）`);
  const {responses: _omit, parts: _parts, ...meta} = index;
  return {meta, responses};
}

// 記録を、1つあたり limitBytes 未満のファイルに分ける。小さければ分けない（parts は空）
export function splitPreviewData(meta, responses, {limitBytes = 16_000_000, partName = (n) => `preview-data-${n}.json`} = {}) {
  const entries = [...(responses instanceof Map ? responses : Object.entries(responses || {}))].sort(([a], [b]) => compare(a, b));
  const head = {format: PREVIEW_DATA_FORMAT, version: PREVIEW_DATA_VERSION, ...meta, count: entries.length};
  const whole = JSON.stringify({...head, responses: Object.fromEntries(entries)});
  if (new TextEncoder().encode(whole).length < limitBytes) return {index: whole, parts: []};
  const encoder = new TextEncoder();
  const parts = [];
  let current = [];
  let size = 0;
  const flush = () => {
    if (!current.length) return;
    parts.push({name: partName(parts.length + 1), text: JSON.stringify({format: PREVIEW_DATA_FORMAT, version: PREVIEW_DATA_VERSION, responses: Object.fromEntries(current)})});
    current = [];
    size = 0;
  };
  for (const entry of entries) {
    const bytes = encoder.encode(JSON.stringify(entry)).length + 8;
    if (bytes + 200 >= limitBytes) throw new Error(`1つの応答が大きすぎて分けられません（${entry[0]}・${bytes}バイト）`);
    if (size + bytes + 200 >= limitBytes) flush();
    current.push(entry);
    size += bytes;
  }
  flush();
  const index = JSON.stringify({...head, parts: parts.map((part) => part.name)});
  if (encoder.encode(index).length >= limitBytes) throw new Error('プレビューの索引が大きすぎて分けられません');
  return {index, parts};
}
