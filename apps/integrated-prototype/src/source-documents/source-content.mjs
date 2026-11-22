// 共通の原本の中身を返す（会社ルートの plans/2026-11-06-r2-ingest.md の A）。
// inline は DB の中身を、external は業務データの置き場（R2 example-business-data）から読む。
// 置き場は「キーを渡すと中身を返す」関数 readBusinessObject(key) だけで受け取り、書き込み・削除の口は持たない。
// 読んだ中身の SHA-256 が記録と違えば返さない（置き場の取り違え・書き換えを画面に出さない）。
import {getSourceDocument, sha256Hex} from './source-documents-store.mjs';

// 業務データの置き場で読んでよいキー。current/ の下だけ、上の階層へ出る部品や空の部品を含まない
export function businessDataKeyAllowed(key) {
  if (typeof key !== 'string' || !key.startsWith('current/') || key.length > 1024) return false;
  return key.split('/').slice(1).every((part) => part !== '' && part !== '.' && part !== '..') && !/[\u0000-\u001f\\]/.test(key);
}

// RFC 6266 の filename*（日本語の名前をそのまま渡す）。attachment は「アプリで開く」（PowerPoint・Word・Excel に落とす）用
export function contentDisposition(fileName, {attachment = false} = {}) {
  const ascii = String(fileName).replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// → {status, body?, headers?, error?}。download: true で attachment にし、ブラウザがファイルとして保存する（同じ中身・同じ名前）
export async function readSourceContent(db, orgId, id, {readBusinessObject = null, download = false} = {}) {
  const document = await getSourceDocument(db, orgId, id, {withContent: true});
  if (!document) return {status: 404, error: '原本がありません'};
  let bytes;
  if (document.storage === 'inline') {
    bytes = document.bytes;
  } else {
    if (!readBusinessObject) return {status: 501, error: '業務データの置き場につながっていません'};
    const key = document.external_location;
    if (!businessDataKeyAllowed(key)) return {status: 400, error: '置き場のキーを確認してください'};
    const object = await readBusinessObject(key);
    if (!object) return {status: 404, error: '置き場に原本がありません。目録を取り込み直してください'};
    bytes = new Uint8Array(await object.arrayBuffer());
  }
  if (!bytes) return {status: 404, error: '原本の中身がありません'};
  if (await sha256Hex(bytes) !== document.sha256) return {status: 409, error: '置き場の中身が記録と違います。目録を取り込み直してください'};
  return {status: 200, body: bytes, headers: {
    'content-type': document.media_type || 'application/octet-stream',
    'content-disposition': contentDisposition(document.file_name, {attachment: download}),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }};
}
