// 業務を問わない共通の原本の表（移行 0025 の source_documents）の読み書き。
// 会社ルートの plans/2026-10-22-folder-parallel-design.md の X-1・X-7（代表の決定 2026-10-22）。要件は docs/requirements/core/data-platform.md の FR-CORE-DATA-056〜060。
// Worker でも動く（node:* を使わない。ハッシュは crypto.subtle、base64 は btoa・atob）。
//
// - 業務の表は原本を持たず、ここで受け取った ID を指す結び付きの表を業務ごとに持つ
// - 同じ組織で同じ中身（SHA-256）は1行だけ。2回目は新しい行を作らず、前の行の ID を duplicate: true で返す
// - 中身は 12MB まで inline（base64）。Worker では 128KB を超える値を R2 の層が R2 へ逃がす（src/cloud-r2-db.mjs）。
//   それより大きい映像・音楽などは external にし、中身を置かず名前・大きさ・ハッシュ・外の置き場の名前だけを持つ
// - 変更と削除は DB が断る（移行のトリガー）
import {allIn} from '../sql-in.mjs';
import {sourceDocumentFileNameError, sourceDocumentLocationError} from './source-document-names-model.mjs';

export const SOURCE_DOCUMENT_KINDS = Object.freeze([
  'sales_report', 'contract', 'estimate', 'invoice', 'receipt', 'bank_statement', 'schedule', 'script', 'budget',
  'planning_deck', 'delivery_guide', 'media', 'image', 'audio', 'other',
]);
export const MAX_INLINE_BYTES = 12 * 1024 * 1024;
const LEGACY_TABLES = new Set(['sales_source_files', 'expense_source_files', 'workflow_raw_artifacts']);
// 最大のidで追加順を決める。秒単位のmoved_atが同じでも場所を一意に選べる。
const CURRENT_LOCATION = `COALESCE((SELECT m.to_location FROM source_document_moves m
  WHERE m.org_id=source_documents.org_id AND m.document_id=source_documents.id ORDER BY m.id DESC LIMIT 1), external_location)`;
const META_COLUMNS = `id, kind, file_name, media_type, byte_length, sha256, storage,
  ${CURRENT_LOCATION} AS external_location, external_location AS original_location,
  received_on, received_by, legacy_table, legacy_id, created_at`;

export class SourceDocumentError extends Error {
  constructor(message) { super(message); this.name = 'SourceDocumentError'; this.status = 400; }
}
const fail = (message) => { throw new SourceDocumentError(message); };

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
function fromBase64(value) {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;

function normalizeRow(row) {
  if (!row) return null;
  const {original_location: originalLocation, ...meta} = row;
  return {...meta, originalLocation, id: Number(row.id), byte_length: Number(row.byte_length), received_by: Number(row.received_by), legacy_id: row.legacy_id == null ? null : Number(row.legacy_id)};
}

// 同じ組織の中身の重複を読む。目録の事前確認でも使い、原本の中身は読まない。
export async function findSourceDocumentBySha256(db, orgId, sha256) {
  const row = await db.get('SELECT id FROM source_documents WHERE org_id=? AND sha256=?', [orgId, sha256]);
  return row ? {id: Number(row.id)} : null;
}

// 目録の重複は組織内で一括照会する。allIn が値を80件ずつに分ける（組織IDを足してもD1の100個以内）。
export async function findSourceDocumentsBySha256(db, orgId, sha256s) {
  const rows = await allIn(db, `SELECT id, sha256, storage, ${CURRENT_LOCATION} AS external_location
    FROM source_documents WHERE org_id=? AND sha256 IN (:in)`,
    {before: [orgId], ids: sha256s});
  return rows.map((row) => ({...row, id: Number(row.id)}));
}

// 読み取りと追加を1文で行い、書く時点の場所をfrom_locationにする。同じ場所なら追加しない。
// inlineはNULLとの比較も通してINSERTトリガーで断る（SQLite・PostgreSQL共通）。
export async function recordSourceDocumentMove(db, {orgId, userId, documentId, toLocation, reason = null} = {}) {
  if (!positiveInt(orgId) || !positiveInt(userId) || !positiveInt(documentId)) fail('組織と利用者と原本が要ります');
  const locationError = sourceDocumentLocationError(toLocation);
  if (locationError) fail(locationError);
  if (reason !== null && (typeof reason !== 'string' || [...reason].length > 500)) fail('移動の理由は500字までにしてください');
  const location = toLocation.trim();
  const row = await db.get(`INSERT INTO source_document_moves(org_id,document_id,from_location,to_location,moved_by,reason)
    SELECT org_id,id,${CURRENT_LOCATION},?,?,? FROM source_documents
    WHERE org_id=? AND id=? AND ${CURRENT_LOCATION} IS NOT ? RETURNING id`,
  [location, userId, reason, orgId, documentId, location]);
  return {moved: Boolean(row), id: row ? Number(row.id) : null};
}

// 原本を受け取る。bytes（Uint8Array）か external（{location, byteLength, sha256}）のどちらか一方を渡す。
// 戻り値は {id, duplicate}。同じ組織で同じ中身が既にあれば、その行の ID を duplicate: true で返す（中身の二重の受け取りを断る）
// skipDuplicateLookup は一括照会済みの目録だけで使う。競合は書き込み時の一意制約で防ぐ。
export async function registerSourceDocument(db, {orgId, userId, kind, fileName, mediaType = null, receivedOn, bytes, external, legacy} = {}, {skipDuplicateLookup = false} = {}) {
  if (!positiveInt(orgId) || !positiveInt(userId)) fail('組織と利用者が要ります');
  if (!SOURCE_DOCUMENT_KINDS.includes(kind)) fail(`原本の種類が違います: ${kind}`);
  const name = typeof fileName === 'string' ? fileName.trim() : '';
  const nameError = sourceDocumentFileNameError(fileName);
  if (nameError) fail(nameError);
  if (!isDate(receivedOn)) fail('受けた日は YYYY-MM-DD で入れてください');
  if ((bytes == null) === (external == null)) fail('中身（bytes）か外の置き場（external）のどちらか一方を渡してください');
  if (legacy && (!LEGACY_TABLES.has(legacy.table) || !positiveInt(legacy.id))) fail('既存の原本の表の指し方が違います');

  let storage; let sha256; let byteLength; let contentBase64 = null; let externalLocation = null;
  if (bytes != null) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail('中身が空です');
    if (bytes.length > MAX_INLINE_BYTES) fail('12MB を超える原本は、外の置き場に置いて external で記録してください');
    storage = 'inline';
    byteLength = bytes.length;
    sha256 = await sha256Hex(bytes);
    contentBase64 = toBase64(bytes);
  } else {
    const location = typeof external.location === 'string' ? external.location.trim() : '';
    const locationError = sourceDocumentLocationError(external.location);
    if (locationError) fail(locationError);
    if (!positiveInt(external.byteLength)) fail('外の置き場の原本の大きさが要ります');
    if (typeof external.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(external.sha256)) fail('外の置き場の原本のハッシュ（SHA-256 の16進64字・小文字）が要ります');
    storage = 'external';
    byteLength = external.byteLength;
    sha256 = external.sha256;
    externalLocation = location;
  }

  if (!skipDuplicateLookup) {
    const existing = await findSourceDocumentBySha256(db, orgId, sha256);
    if (existing) return {id: existing.id, duplicate: true};
  }
  try {
    const row = await db.get(
      `INSERT INTO source_documents(org_id,kind,file_name,media_type,byte_length,sha256,storage,content_base64,external_location,received_on,received_by,legacy_table,legacy_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [orgId, kind, name, mediaType, byteLength, sha256, storage, contentBase64, externalLocation, receivedOn, userId, legacy?.table ?? null, legacy?.id ?? null],
    );
    return {id: Number(row.id), duplicate: false};
  } catch (error) {
    // 一括照会の後に同じ中身が登録された場合も、先に入った行を返す。
    const raced = await findSourceDocumentBySha256(db, orgId, sha256);
    if (raced) return {id: raced.id, duplicate: true};
    throw error;
  }
}

// 1通の記録。withContent なら inline の中身を bytes（Uint8Array）で付ける（external は中身を持たない）。無ければ null
export async function getSourceDocument(db, orgId, id, {withContent = false} = {}) {
  const row = normalizeRow(await db.get(`SELECT ${META_COLUMNS}${withContent ? ', content_base64' : ''} FROM source_documents WHERE org_id=? AND id=?`, [orgId, id]));
  if (!row || !withContent) return row;
  const {content_base64: content, ...meta} = row;
  return {...meta, bytes: content == null ? null : fromBase64(content)};
}

// 一覧（中身は付けない）。種類・期間・名前と場所の部分一致で絞れる。受けた日・ID の順
export async function listSourceDocuments(db, orgId, {kind = null, from = null, to = null, q = null, limit = null} = {}) {
  if (kind != null && !SOURCE_DOCUMENT_KINDS.includes(kind)) fail(`原本の種類が違います: ${kind}`);
  if ((from != null && !isDate(from)) || (to != null && !isDate(to))) fail('期間は YYYY-MM-DD で入れてください');
  const where = ['org_id=?'];
  const params = [orgId];
  if (kind != null) { where.push('kind=?'); params.push(kind); }
  if (from != null) { where.push('received_on>=?'); params.push(from); }
  if (to != null) { where.push('received_on<=?'); params.push(to); }
  if (q != null && q.trim()) {
    // % と _ も検索する文字として扱う。両DBで同じ部分一致にする。
    const pattern = `%${q.trim().replace(/[!%_]/g, '!$&')}%`;
    where.push("(LOWER(file_name) LIKE LOWER(?) ESCAPE '!' OR LOWER(external_location) LIKE LOWER(?) ESCAPE '!')");
    params.push(pattern, pattern);
  }
  if (limit != null && (!positiveInt(limit) || limit > 200)) fail('一覧の件数は1〜200件です');
  if (limit != null) params.push(limit);
  const rows = await db.all(`SELECT ${META_COLUMNS} FROM source_documents WHERE ${where.join(' AND ')} ORDER BY received_on, id${limit == null ? '' : ' LIMIT ?'}`, params);
  return rows.map(normalizeRow);
}
