// 共通の原本を選ぶ一覧。中身の取得や外の置き場への接続は行わない。
import {listSourceDocuments, SourceDocumentError} from './source-documents-store.mjs';

export function registerSourceDocumentRoutes(app, {db, bad}) {
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
