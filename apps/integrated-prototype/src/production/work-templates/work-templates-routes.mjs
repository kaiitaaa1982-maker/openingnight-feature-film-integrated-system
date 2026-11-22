// 制作部の業務のひな型の受け口（移行 0057。要件 docs/requirements/production/work-templates.md）。
// - GET  /api/work-templates/folders                          業務の種類のフォルダの一覧（やめていないひな型の数つき。?retired=1 でやめたフォルダも）
// - POST /api/work-templates/folders                          フォルダを作る（種類は利用者が足していく）
// - POST /api/work-templates/folders/:id/revisions            フォルダの改名・説明の更新・やめる／戻す（追加だけ。expectedRev が古ければ 409。名前の重なりは 409）
// - POST /api/work-templates/templates/:id/move               ひな型を別のフォルダへ移す（追加だけ。expectedMoveNo が古ければ 409。やめたフォルダへは移せない）
// - GET  /api/work-templates/folders/:id/templates            フォルダの中のひな型（最新の版。?retired=1 でやめたものも）
// - POST /api/work-templates/folders/:id/templates            ひな型を作る（1版目）
// - GET  /api/work-templates/search?q=                        名前・何のためか・使う場面・フォルダ・原本のファイル名で探す
// - GET  /api/work-templates/templates/:id                    1通（全部の版・原本の履歴）
// - POST /api/work-templates/templates/:id/versions           新しい版（理由必須。expectedVersion が古ければ 409）
// - POST /api/work-templates/templates/:id/copy               複製（別のフォルダへも。複製元を残す）
// - POST /api/work-templates/templates/:id/files              Office の原本を置く・置き直す（古い原本も残る）
// - POST /api/work-templates/templates/:id/files {documentId}  すでに共通の原本にある Word・Excel・PowerPoint（毎晩の R2 の取り込みで入ったもの）を、原本として結ぶ（admin・editor）
// - GET  /api/work-templates/source-candidates?q=              結べる共通の原本を探す（docx・xlsx・pptx だけ。admin・editor。R2 の取り込みで入った external も出る）
// - GET  /api/work-templates/files/:fileId/download           原本をダウンロードする（external の原本は R2 にあり、まだ画面から開けないので場所を返して 409）
// 読める・書けるのは組織の所属の全員（ひな型は作品の外の、組織の共有の型）。別の組織のものは有無を見せず 404。画面内での Office の編集は作らない。
import {registerSourceDocument, getSourceDocument, listSourceDocuments, SourceDocumentError} from '../../source-documents/source-documents-store.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';
import {MAX_FILE_BYTES, looksLikeZip, normalizeDriveRef, normalizeFolderInput, normalizeFolderRevisionInput, normalizeMoveReason, normalizeVersionInput, officeFileInfo} from './work-templates-model.mjs';
import {findFile, findFolder, findTemplate, insertFile, insertFolder, insertFolderRevision, insertMove, insertTemplate, insertVersion, readFiles, readFolderRevisions, readFolders, readMoves, readTemplates, readVersions, searchTemplates} from './work-templates-store.mjs';

const STALE = 'ほかの画面で先に直されました。読み直してください';
const positiveId = (raw) => (/^\d+$/.test(String(raw ?? '')) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null);
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const isStale = (error) => dbErrorKind(error) === 'raise' && /stale work template/.test(error.message);
const isDuplicateName = (error) => dbErrorKind(error) === 'raise' && /duplicate work template folder name/.test(error.message);
const DUPLICATE_NAME = '同じ名前のフォルダがあります';
const folderRow = (f) => ({...f, retired: Boolean(Number(f.retired)), rev_no: Number(f.rev_no)});
const parse = (row) => ({...row, blocks: JSON.parse(row.blocks_json), variables: JSON.parse(row.variables_json), source: JSON.parse(row.source_json)});
const present = ({blocks_json, variables_json, source_json, ...rest}) => rest;
const listRow = (row) => ({...row, retired: Boolean(row.retired), folder_retired: Boolean(Number(row.folder_retired)), move_no: Number(row.move_no), file_count: Number(row.file_count)});

function decodeBase64(text) {
  if (typeof text !== 'string' || !text) throw new Error('中身が空です');
  let raw;
  try { raw = atob(text); } catch { throw new Error('中身を読めませんでした'); }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function registerWorkTemplateRoutes(app, {db, bad, body}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function') throw new Error('work template routes require app, db, bad and body');

  const input = async (c) => { try { return {value: await body(c)}; } catch (error) { return {error: bad(c, error.message, 400, undefined, error)}; } };

  app.get('/api/work-templates/folders', async (c) => {
    const i = c.get('identity');
    return c.json({ok: true, folders: (await readFolders(db, i.org_id, {withRetired: c.req.query('retired') === '1'})).map((f) => ({...folderRow(f), template_count: Number(f.template_count)}))});
  });

  app.post('/api/work-templates/folders', async (c) => {
    const i = c.get('identity');
    const parsed = await input(c); if (parsed.error) return parsed.error;
    let folder; try { folder = normalizeFolderInput(parsed.value); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    try { return c.json({ok: true, id: await insertFolder(db, i.org_id, i.user_id, folder)}); } catch (error) {
      if (isDuplicateName(error)) return bad(c, DUPLICATE_NAME, 409, undefined, error);
      throw error;
    }
  });

  app.post('/api/work-templates/folders/:id/revisions', async (c) => {
    const i = c.get('identity'); const folderId = positiveId(c.req.param('id'));
    const folder = folderId && await findFolder(db, i.org_id, folderId);
    if (!folder) return bad(c, 'フォルダがありません', 404);
    const parsed = await input(c); if (parsed.error) return parsed.error;
    const expected = parsed.value?.expectedRev;
    if (!Number.isSafeInteger(expected) || expected < 0) return bad(c, '直す元の番号を確かめてください', 400);
    if (expected !== Number(folder.rev_no)) return bad(c, STALE, 409);
    let next; try { next = normalizeFolderRevisionInput(parsed.value); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    try { await insertFolderRevision(db, i.org_id, i.user_id, folderId, expected + 1, next); } catch (error) {
      if (isDuplicateName(error)) return bad(c, DUPLICATE_NAME, 409, undefined, error);
      if (isStale(error) || isUniqueViolation(error, 'work_template_folder_revisions')) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
    return c.json({ok: true, revNo: expected + 1});
  });

  app.get('/api/work-templates/folders/:id/templates', async (c) => {
    const i = c.get('identity'); const folderId = positiveId(c.req.param('id'));
    const folder = folderId && await findFolder(db, i.org_id, folderId);
    if (!folder) return bad(c, 'フォルダがありません', 404);
    const templates = (await readTemplates(db, i.org_id, folderId, {withRetired: c.req.query('retired') === '1'})).map(listRow);
    return c.json({ok: true, folder: folderRow(folder), revisions: await readFolderRevisions(db, i.org_id, folderId), templates});
  });

  app.post('/api/work-templates/folders/:id/templates', async (c) => {
    const i = c.get('identity'); const folderId = positiveId(c.req.param('id'));
    const folder = folderId && await findFolder(db, i.org_id, folderId);
    if (!folder) return bad(c, 'フォルダがありません', 404);
    if (Number(folder.retired)) return bad(c, 'やめたフォルダには、ひな型を作れません。先に戻してください', 409);
    const parsed = await input(c); if (parsed.error) return parsed.error;
    let version; try { version = normalizeVersionInput(parsed.value, {first: true}); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    return c.json({ok: true, id: await insertTemplate(db, i.org_id, i.user_id, folderId, version)});
  });

  app.get('/api/work-templates/search', async (c) => {
    const i = c.get('identity'); const q = String(c.req.query('q') || '').trim();
    if (!q) return bad(c, '探す言葉を入れてください', 400);
    if (q.length > 80) return bad(c, '探す言葉は80字までにしてください', 400);
    return c.json({ok: true, templates: (await searchTemplates(db, i.org_id, q, {withRetired: c.req.query('retired') === '1'})).map(listRow)});
  });

  app.get('/api/work-templates/templates/:id', async (c) => {
    const i = c.get('identity'); const templateId = positiveId(c.req.param('id'));
    const template = templateId && await findTemplate(db, i.org_id, templateId);
    if (!template) return bad(c, 'ひな型がありません', 404);
    const versions = (await readVersions(db, i.org_id, templateId)).map((v) => ({...present(parse(v)), retired: Boolean(v.retired)}));
    const files = [];
    for (const f of await readFiles(db, i.org_id, templateId)) {
      const doc = await getSourceDocument(db, i.org_id, Number(f.document_id));
      files.push({...f, byte_length: Number(f.byte_length), storage: doc?.storage ?? 'inline', location: doc?.storage === 'external' ? doc.external_location : null});
    }
    return c.json({ok: true, template: listRow(template), versions, files, moves: await readMoves(db, i.org_id, templateId), maxBytes: MAX_FILE_BYTES});
  });

  app.post('/api/work-templates/templates/:id/versions', async (c) => {
    const i = c.get('identity'); const templateId = positiveId(c.req.param('id'));
    const template = templateId && await findTemplate(db, i.org_id, templateId);
    if (!template) return bad(c, 'ひな型がありません', 404);
    const parsed = await input(c); if (parsed.error) return parsed.error;
    const expected = positiveId(parsed.value?.expectedVersion);
    if (!expected) return bad(c, '直す元の版を確かめてください', 400);
    if (expected !== Number(template.version_no)) return bad(c, STALE, 409);
    let version; try { version = normalizeVersionInput(parsed.value, {first: false}); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    try { await insertVersion(db, i.org_id, i.user_id, templateId, expected + 1, version); } catch (error) {
      if (isStale(error) || isUniqueViolation(error, 'work_template_versions')) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
    return c.json({ok: true, versionNo: expected + 1});
  });

  app.post('/api/work-templates/templates/:id/move', async (c) => {
    const i = c.get('identity'); const templateId = positiveId(c.req.param('id'));
    const template = templateId && await findTemplate(db, i.org_id, templateId);
    if (!template) return bad(c, 'ひな型がありません', 404);
    const parsed = await input(c); if (parsed.error) return parsed.error;
    const expected = parsed.value?.expectedMoveNo;
    if (!Number.isSafeInteger(expected) || expected < 0) return bad(c, '移す元の番号を確かめてください', 400);
    if (expected !== Number(template.move_no)) return bad(c, STALE, 409);
    const folderId = positiveId(parsed.value?.folderId);
    const folder = folderId && await findFolder(db, i.org_id, folderId);
    if (!folder) return bad(c, 'フォルダがありません', 404);
    if (folderId === Number(template.folder_id)) return bad(c, 'いまと同じフォルダです', 409);
    if (Number(folder.retired)) return bad(c, 'やめたフォルダへは移せません。先に戻してください', 409);
    let reason; try { reason = normalizeMoveReason(parsed.value?.reason); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    try { await insertMove(db, i.org_id, i.user_id, templateId, expected + 1, folderId, reason); } catch (error) {
      if (isStale(error) || isUniqueViolation(error, 'work_template_moves')) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
    return c.json({ok: true, moveNo: expected + 1});
  });

  // 複製。最新の版の中身を新しいひな型の1版目にし、複製元（ひな型と版）を残す。最新の原本は同じ原本を指して引き継ぐ
  app.post('/api/work-templates/templates/:id/copy', async (c) => {
    const i = c.get('identity'); const templateId = positiveId(c.req.param('id'));
    const source = templateId && await findTemplate(db, i.org_id, templateId);
    if (!source) return bad(c, 'ひな型がありません', 404);
    const parsed = await input(c); if (parsed.error) return parsed.error;
    const folderId = parsed.value?.folderId == null ? Number(source.folder_id) : positiveId(parsed.value.folderId);
    const target = folderId && await findFolder(db, i.org_id, folderId);
    if (!target) return bad(c, 'フォルダがありません', 404);
    if (Number(target.retired)) return bad(c, 'やめたフォルダには複製できません。先に戻してください', 409);
    const latest = parse((await readVersions(db, i.org_id, templateId))[0]);
    const name = typeof parsed.value?.name === 'string' && parsed.value.name.trim() ? parsed.value.name : `${latest.name.slice(0, 100)}（複製）`;
    let version;
    try {
      version = normalizeVersionInput({name, purpose: latest.purpose, scene: latest.scene, blocks: latest.blocks, variables: latest.variables, source: latest.source, driveRef: latest.drive_ref}, {first: true});
    } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const newId = await insertTemplate(db, i.org_id, i.user_id, folderId, version, {templateId, versionNo: Number(source.version_no)});
    const file = (await readFiles(db, i.org_id, templateId))[0];
    if (file) await insertFile(db, i.org_id, i.user_id, newId, 1, Number(file.document_id), {driveRef: file.drive_ref, reason: null});
    return c.json({ok: true, id: newId});
  });

  // すでに共通の原本にあるファイル（毎晩 Google ドライブ→R2 に写され、管理者が目録を取り込んで入ったもの）を、原本として結ぶ。中身は動かさず、二重に登録しない
  async function linkDocument(c, i, templateId, latest, value) {
    if (!['admin', 'editor'].includes(i.role)) return bad(c, '共通の原本を結べるのは管理者と編集者だけです', 403);
    const documentId = positiveId(value.documentId);
    const doc = documentId && await getSourceDocument(db, i.org_id, documentId);
    if (!doc) return bad(c, '原本がありません', 404);
    let driveRef, reason;
    try {
      officeFileInfo(doc.file_name);
      driveRef = normalizeDriveRef(value.driveRef);
      reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null;
      if (reason && reason.length > 500) throw new Error('置き直す理由は500字までにしてください');
      if (latest && !reason) throw new Error('置き直す理由を入れてください');
      if (latest && positiveId(value.expectedFileNo) !== Number(latest.file_no)) throw Object.assign(new Error(STALE), {conflict: true});
      if (!latest && value.expectedFileNo != null && Number(value.expectedFileNo) !== 0) throw Object.assign(new Error(STALE), {conflict: true});
    } catch (error) { return bad(c, error.message, error.conflict ? 409 : 400, undefined, error); }
    if (latest && Number(latest.document_id) === doc.id) return bad(c, '直前に結んだ原本と同じです', 409);
    const fileNo = latest ? Number(latest.file_no) + 1 : 1;
    try { await insertFile(db, i.org_id, i.user_id, templateId, fileNo, doc.id, {driveRef, reason}); } catch (error) {
      if (isStale(error) || isUniqueViolation(error, 'work_template_files')) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
    return c.json({ok: true, fileNo, documentId: doc.id, storage: doc.storage});
  }

  app.get('/api/work-templates/source-candidates', async (c) => {
    const i = c.get('identity');
    if (!['admin', 'editor'].includes(i.role)) return bad(c, '共通の原本を探せるのは管理者と編集者だけです', 403);
    const q = String(c.req.query('q') || '').trim();
    if (!q) return bad(c, '探す言葉を入れてください', 400);
    if (q.length > 80) return bad(c, '探す言葉は80字までにしてください', 400);
    const isOffice = (d) => { try { officeFileInfo(d.file_name); return true; } catch { return false; } };
    const rows = (await listSourceDocuments(db, i.org_id, {q})).filter(isOffice).slice(-50).reverse();
    return c.json({ok: true, documents: rows.map((d) => ({id: d.id, file_name: d.file_name, byte_length: Number(d.byte_length), storage: d.storage, location: d.storage === 'external' ? d.external_location : null, received_on: d.received_on}))});
  });

  // Office の原本を置く。中身は base64。同じ中身は共通の原本を増やさず同じ原本を指す。直前の原本と同じ中身は断る
  app.post('/api/work-templates/templates/:id/files', async (c) => {
    const i = c.get('identity'); const templateId = positiveId(c.req.param('id'));
    const template = templateId && await findTemplate(db, i.org_id, templateId);
    if (!template) return bad(c, 'ひな型がありません', 404);
    const parsed = await input(c); if (parsed.error) return parsed.error;
    const files = await readFiles(db, i.org_id, templateId);
    const latest = files[0] || null;
    if (parsed.value?.documentId != null) return linkDocument(c, i, templateId, latest, parsed.value);
    let info, bytes, driveRef, reason;
    try {
      const value = parsed.value || {};
      info = officeFileInfo(value.fileName);
      bytes = decodeBase64(value.base64);
      if (bytes.length > MAX_FILE_BYTES) throw new Error('12MB を超えるファイルは置けません');
      if (!looksLikeZip(bytes)) throw new Error('Word・Excel・PowerPoint のファイルとして読めません（中身が違います）');
      driveRef = normalizeDriveRef(value.driveRef);
      reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null;
      if (reason && reason.length > 500) throw new Error('置き直す理由は500字までにしてください');
      if (latest && !reason) throw new Error('置き直す理由を入れてください');
      if (latest && positiveId(value.expectedFileNo) !== Number(latest.file_no)) throw Object.assign(new Error(STALE), {conflict: true});
      if (!latest && value.expectedFileNo != null && Number(value.expectedFileNo) !== 0) throw Object.assign(new Error(STALE), {conflict: true});
    } catch (error) { return bad(c, error.message, error.conflict ? 409 : 400, undefined, error); }
    try {
      const saved = await registerSourceDocument(db, {orgId: i.org_id, userId: i.user_id, kind: 'other', fileName: parsed.value.fileName, mediaType: info.mediaType, receivedOn: todayJst(), bytes});
      if (latest && Number(latest.document_id) === saved.id) return bad(c, '直前に置いた原本と同じ中身です', 409);
      const fileNo = latest ? Number(latest.file_no) + 1 : 1;
      await insertFile(db, i.org_id, i.user_id, templateId, fileNo, saved.id, {driveRef, reason});
      return c.json({ok: true, fileNo, documentId: saved.id, duplicate: saved.duplicate});
    } catch (error) {
      if (error instanceof SourceDocumentError) return bad(c, error.message, 400, undefined, error);
      if (isStale(error) || isUniqueViolation(error, 'work_template_files')) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
  });

  // 原本のダウンロード。ひな型に結んだ原本だけ（共通の原本の ID を直接渡しても開けない）
  app.get('/api/work-templates/files/:fileId/download', async (c) => {
    const i = c.get('identity'); const fileId = positiveId(c.req.param('fileId'));
    const file = fileId && await findFile(db, i.org_id, fileId);
    if (!file) return bad(c, '原本がありません', 404);
    const doc = await getSourceDocument(db, i.org_id, Number(file.document_id), {withContent: true});
    if (doc?.storage === 'external') return bad(c, `この原本は R2 にあり、まだ画面から開けません（場所: ${doc.external_location}）`, 409);
    if (!doc || !doc.bytes) return bad(c, '原本の中身を開けません', 404);
    return new Response(doc.bytes, {headers: {'content-type': doc.media_type || 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`, 'x-content-type-options': 'nosniff'}});
  });
}
