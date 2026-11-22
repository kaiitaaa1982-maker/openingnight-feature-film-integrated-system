// 共通の原本を選ぶ一覧と、1通の中身（外の置き場は readBusinessObject で読む。source-content.mjs）、画面から足す受け口（addBusinessObject で足すだけ。source-upload.mjs）。
import {listSourceDocuments, SourceDocumentError} from './source-documents-store.mjs';
import {readSourceContent} from './source-content.mjs';
import {readAcqSourceLinks} from '../acquisition/acq-mg-store.mjs';
import {readPlanningSourceLinks} from '../planning/kikaku/kikaku-store.mjs';
import {readShootingSourceLinks} from '../production/production-store.mjs';
import {readChotatsuSourceLinks} from '../acquisition/chotatsu/chotatsu-store.mjs';
import {readVaultSourceLinks} from '../preprod/vault-store.mjs';
import {readPermitSourceLinks} from '../preprod/permits/permit-store.mjs';
import {sourceTreeItems} from './source-tree-model.mjs';
import {addSourceUpload, UPLOAD_PATH} from './source-upload.mjs';

export function registerSourceDocumentRoutes(app, {db, bad, readBusinessObject = null, addBusinessObject = null}) {
  // 置く先・名前は問い合わせの文字列、中身は本文（application/octet-stream）、SHA-256 は x-content-sha256。本文は溜めずに置き場へ流す
  app.post(UPLOAD_PATH, async (c) => {
    const identity = c.get('identity');
    if (!['admin', 'editor'].includes(identity.role)) return bad(c, '原本を足す権限がありません', 403);
    const result = await addSourceUpload(db, identity, {
      folder: c.req.query('folder'), name: c.req.query('name'), kind: c.req.query('kind') || null, mediaType: c.req.query('type') || null,
      sha256: c.req.header('x-content-sha256'), contentLength: c.req.header('content-length'),
    }, c.req.raw.body, {addBusinessObject});
    if (result.status !== 201) return bad(c, result.body.error, result.status, result.body.id ? {id: result.body.id} : undefined);
    return c.json(result.body, 201);
  });
  app.get('/api/source-documents/tree', async (c) => {
    const identity = c.get('identity');
    if (!['admin', 'editor'].includes(identity.role)) return bad(c, '原本の一覧への権限がありません', 403);
    const orgId = identity.org_id;
    const [documents, acq, planning, shooting, chotatsu, vault, permits] = await Promise.all([
      listSourceDocuments(db, orgId), readAcqSourceLinks(db, orgId), readPlanningSourceLinks(db, orgId),
      readShootingSourceLinks(db, orgId), readChotatsuSourceLinks(db, orgId), readVaultSourceLinks(db, orgId), readPermitSourceLinks(db, orgId),
    ]);
    return c.json({ok: true, items: sourceTreeItems(documents, [
      {table: 'acq_mg_documents', pageId: 'MG 買付', rows: acq},
      {table: 'planning_documents', pageId: '企画', rows: planning},
      {table: 'shooting_day_records', pageId: '撮影の記録', rows: shooting},
      {table: 'chotatsu_documents', pageId: '調達', rows: chotatsu},
      {table: 'preprod_document_placements', pageId: 'プリプロ', rows: vault},
      {table: 'permit_application_documents', pageId: '許可申請', rows: permits},
    ])});
  });
  app.get('/api/source-documents/:id/content', async (c) => {
    const identity = c.get('identity');
    if (!['admin', 'editor'].includes(identity.role)) return bad(c, '原本の一覧への権限がありません', 403);
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return bad(c, '原本を確認してください', 400);
    const result = await readSourceContent(db, identity.org_id, id, {readBusinessObject, download: c.req.query('download') === '1'});
    if (result.status !== 200) return bad(c, result.error, result.status);
    return new Response(result.body, {status: 200, headers: result.headers});
  });
  app.get('/api/source-documents', async (c) => {
    const identity = c.get('identity');
    if (!['admin', 'editor'].includes(identity.role)) return bad(c, '原本の一覧への権限がありません', 403);
    try {
      const rows = await listSourceDocuments(db, identity.org_id, {q: c.req.query('q') ?? null, kind: c.req.query('kind') || null, limit: 200});
      const items = rows.map((d) => ({id: d.id, kind: d.kind, fileName: d.file_name, byteLength: d.byte_length, sha256: d.sha256,
        storage: d.storage, externalLocation: d.storage === 'external' ? d.external_location : null, receivedOn: d.received_on}));
      return c.json({ok: true, items});
    } catch (error) {
      if (error instanceof SourceDocumentError) return bad(c, error.message, 400);
      throw error;
    }
  });
}
