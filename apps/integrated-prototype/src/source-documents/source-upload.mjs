// 画面から原本を足す（POST /api/source-documents/upload。会社ルートの plans/2026-11-09-upload-from-any-device.md の手順3）。
// 置き場は「キーと中身を渡すと、無ければ置く」関数 addBusinessObject(key, body, {sha256}) だけで受け取る（business-data-bucket.mjs）。
// - 足すだけ。同じキーがあれば 409 で何も書かない（DB の記録を先に見て、置き場でも条件付きで止める）
// - 新しいフォルダは作らない。この組織の原本が既に置いてあるフォルダ（その下を含む）だけを選べる
// - 中身は Worker の中に溜めず、そのまま置き場へ流す。SHA-256 は送る側が計って渡し、置き場が中身と照らす
import {businessDataKeyAllowed} from './source-content.mjs';
import {sourceDocumentFileNameError} from './source-document-names-model.mjs';
import {findSourceDocumentBySha256, findSourceDocumentAtLocation, sourceFolderInUse, registerSourceDocument, SOURCE_DOCUMENT_KINDS} from './source-documents-store.mjs';

import {UPLOAD_PATH, MAX_UPLOAD_BYTES} from './source-upload-model.mjs';

export {UPLOAD_PATH, MAX_UPLOAD_BYTES};
// ドライブ（Windows）へ写せない字と、目録で符号に変える字（# ? %）は名前に使わない
const NAME_FORBIDDEN = /[\/\<>:"|*?#%]/;

// → {error} か {folder, name, key, kind, mediaType, sha256, byteLength}
export function parseUpload({folder, name, kind, mediaType, sha256, contentLength}) {
  const dir = typeof folder === 'string' ? folder.normalize('NFC').replace(/\/+$/, '') : '';
  const fileName = typeof name === 'string' ? name.normalize('NFC').trim() : '';
  const nameError = sourceDocumentFileNameError(fileName);
  if (nameError) return {error: nameError};
  if (NAME_FORBIDDEN.test(fileName) || fileName.startsWith('.') || /[. ]$/.test(fileName)) return {error: 'ファイル名に使えない字があります（/ \ < > : " | * ? # % と、先頭の点・末尾の点と空白）'};
  if (!businessDataKeyAllowed(`${dir}/x`) || dir === 'current') return {error: '置く先のフォルダを選んでください'};
  const key = `${dir}/${fileName}`;
  if (!businessDataKeyAllowed(key) || key.length > 500) return {error: '置く先とファイル名を合わせて500字までにしてください'};
  if (kind != null && !SOURCE_DOCUMENT_KINDS.includes(kind)) return {error: '原本の種類を確認してください'};
  if (mediaType != null && !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i.test(mediaType)) return {error: 'ファイルの形式を確認してください'};
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return {error: '中身のハッシュ（SHA-256）が要ります'};
  const byteLength = /^\d{1,12}$/.test(String(contentLength ?? '')) ? Number(contentLength) : NaN;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) return {error: '中身が空か、大きさが分かりません'};
  if (byteLength > MAX_UPLOAD_BYTES) return {error: `1つ ${MAX_UPLOAD_BYTES / 1024 / 1024}MB までです。大きいものはドライブに置いてください`, status: 413};
  return {folder: dir, name: fileName, key, kind: kind ?? 'other', mediaType: mediaType ?? null, sha256, byteLength};
}

// 日本時間の今日
export const todayJst = (now = new Date()) => new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

// → {status, body}
export async function addSourceUpload(db, identity, input, body, {addBusinessObject = null, now = new Date()} = {}) {
  if (!addBusinessObject) return {status: 501, body: {error: '業務データの置き場につながっていません'}};
  const parsed = parseUpload(input);
  if (parsed.error) return {status: parsed.status ?? 400, body: {error: parsed.error}};
  if (!body) return {status: 400, body: {error: '中身が空です'}};
  const orgId = identity.org_id;
  if (!(await sourceFolderInUse(db, orgId, parsed.folder))) return {status: 400, body: {error: 'このフォルダにはまだ原本がありません。新しいフォルダはドライブで作ってください'}};
  const taken = await findSourceDocumentAtLocation(db, orgId, parsed.key);
  if (taken) return {status: 409, body: {error: '同じ名前の原本が既にあります。名前を変えて上げ直してください', id: taken.id}};
  const same = await findSourceDocumentBySha256(db, orgId, parsed.sha256);
  if (same) return {status: 409, body: {error: '同じ中身の原本が既にあります', id: same.id}};
  let stored;
  try {
    stored = await addBusinessObject(parsed.key, body, {sha256: parsed.sha256});
  } catch (error) {
    console.error(error);
    return {status: 400, body: {error: '置き場に置けませんでした（中身がハッシュと合わない・通信が途中で切れた）。もう一度上げてください'}};
  }
  if (!stored) return {status: 409, body: {error: '同じ名前のファイルが置き場に既にあります。名前を変えて上げ直してください'}};
  const byteLength = Number(stored.size);
  const result = await registerSourceDocument(db, {orgId, userId: identity.user_id, kind: parsed.kind, fileName: parsed.name, mediaType: parsed.mediaType,
    receivedOn: todayJst(now), external: {location: parsed.key, byteLength, sha256: parsed.sha256}});
  return {status: 201, body: {ok: true, id: result.id, key: parsed.key, byteLength, sha256: parsed.sha256}};
}
