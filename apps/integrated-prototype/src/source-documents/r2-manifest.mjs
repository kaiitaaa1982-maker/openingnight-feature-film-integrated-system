// R2 目録の読み取りと分類だけを行う純関数。R2・DB・現在時刻には触れない。
// FR-CORE-DATA-061。分類表は docs/requirements/core/data-platform.md にある。
import {sourceDocumentFileNameError, sourceDocumentLocationError} from './source-document-names-model.mjs';
const HEADER = 'key\tsize\tsha256\tuploaded_at';
const SYMBOLS = {'%23': '#', '%3F': '?', '%25': '%'};
const MEDIA = new Set(['mp4', 'mov', 'mxf', 'avi', 'mkv', 'webm', 'm4v', 'mpg', 'mpeg']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'svg', 'heic']);
const AUDIO = new Set(['wav', 'mp3', 'aac', 'm4a', 'flac', 'aif', 'aiff', 'ogg']);
const BUDGET = new Set(['xls', 'xlsx', 'ods', 'csv', 'tsv', 'pdf']);

export function fileNameForKey(key) {
  // decodeURIComponent は使わない。他の符号や元からある % はそのまま、二重に戻さない。
  const name = key.split('/').at(-1).replace(/%23|%3f|%25/gi, (symbol) => SYMBOLS[symbol.toUpperCase()]);
  const error = sourceDocumentFileNameError(name);
  if (error) throw new Error(error);
  if (!name.trim() || name.length > 240) throw new Error('ファイル名は1〜240字にしてください');
  return name;
}

export function kindForKey(key) {
  const folders = key.split('/').slice(1, -1);
  const name = fileNameForKey(key);
  const ext = name.split('.').at(-1).toLowerCase();
  // 支払フォルダの資料だけでは口座の明細とは判断できない。
  if (folders.includes('payments')) return 'other';
  if (folders.includes('contracts')) return 'contract';
  if (folders.includes('invoices_in')) return 'invoice';
  if (folders.includes('materials')) {
    if (MEDIA.has(ext)) return 'media';
    if (IMAGE.has(ext)) return 'image';
    if (AUDIO.has(ext)) return 'audio';
    return 'other';
  }
  if (folders.includes('production') && /budget|予算/i.test(name) && BUDGET.has(ext)) return 'budget';
  return 'other';
}

export function receivedOnForUpload(uploadedAt) {
  const invalid = () => { throw new Error('上げた日時は実在する日時と時差を含む ISO 8601 で入れてください'); };
  // スクリプトが出す小数7桁も読む。時差のない日時を実行環境の時差で補わない。
  const parts = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(uploadedAt);
  if (!parts) return invalid();
  const midnight = new Date(`${parts[1]}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== parts[1]) return invalid();
  const millis = Date.parse(uploadedAt);
  if (!Number.isFinite(millis)) return invalid();
  const date = new Date(millis + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalid();
  return date;
}

// 戻り値は有効行の配列。断った行は配列の rejected（非列挙）に {line, reason} で付ける。
// 配列の各行は {key, byteLength, sha256, uploadedAt} のみ。行番号は見出し・空行も含む元の番号。
export function parseManifest(text) {
  if (typeof text !== 'string') throw new TypeError('目録は TSV の文字列で渡してください');
  const rows = [];
  const rejected = [];
  Object.defineProperty(rows, 'rejected', {value: rejected});
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop(); // 最後の改行は行として数えない。途中の空行は断る。
  for (const [index, line] of lines.entries()) {
    if (index === 0 && line === HEADER) continue;
    const columns = line.split('\t');
    if (columns.length !== 4) {
      rejected.push({line: index + 1, reason: '目録はキー・大きさ・SHA-256・上げた日時の4列にしてください'});
      continue;
    }
    const [key, size, sha256, uploadedAt] = columns;
    const reasons = [];
    if (!key.startsWith('current/')) reasons.push('キーは current/ で始めてください');
    if (key.length > 500) reasons.push('キーは外の置き場の上限500字以内にしてください');
    if (key !== key.trim()) reasons.push('キーの前後に空白は置けません');
    const locationError = sourceDocumentLocationError(key);
    if (locationError) reasons.push(locationError);
    if (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size)) || Number(size) <= 0) reasons.push('大きさはバイト単位の正の安全な整数にしてください');
    if (!/^[0-9a-f]{64}$/.test(sha256)) reasons.push('SHA-256 は16進64字の小文字にしてください');
    try { fileNameForKey(key); } catch (error) { reasons.push(error.message); }
    try { receivedOnForUpload(uploadedAt); } catch (error) { reasons.push(error.message); }
    if (reasons.length) rejected.push({line: index + 1, reason: reasons.join('。')});
    else rows.push({key, byteLength: Number(size), sha256, uploadedAt});
  }
  return rows;
}
