// 管理者が本文で渡した R2 目録を、共通の原本の表へ登録する。R2 自体には接続しない。
import {parseManifest, kindForKey, fileNameForKey, receivedOnForUpload} from './r2-manifest.mjs';
import {findSourceDocumentsBySha256, registerSourceDocument, recordSourceDocumentMove} from './source-documents-store.mjs';
import {D1_MAX_STATEMENTS} from '../d1-limits.mjs';

// 200行。競合時の登録＋再照会で1行2文を使っても400文。移動は1行1文。
// 残り100文には現在の場所を含む一括照会（3文）と認証などを含める。
const RESERVED_STATEMENTS = 100;
export const MAX_R2_MANIFEST_ROWS = (D1_MAX_STATEMENTS - RESERVED_STATEMENTS) / 2;

export function registerR2ManifestRoutes(app, {db, bad}) {
  app.post('/api/source-documents/import-r2-manifest', async (c) => {
    const identity = c.get('identity');
    if (identity.role !== 'admin') return bad(c, 'R2 の目録は管理者だけが取り込めます', 403);
    let input;
    try { input = await c.req.json(); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return bad(c, 'JSON本文を確認してください', 400, undefined, error);
    }
    if (!input || typeof input.manifest !== 'string' || typeof input.dryRun !== 'boolean') {
      return bad(c, 'manifest に TSV の文字列、dryRun に真偽値を入れてください', 400);
    }
    const rows = parseManifest(input.manifest);
    if (rows.length > MAX_R2_MANIFEST_ROWS) {
      return bad(c, `有効行は${MAX_R2_MANIFEST_ROWS}行ずつに分けて送ってください`, 413,
        {maxRows: MAX_R2_MANIFEST_ROWS, validRows: rows.length});
    }
    const counts = {new: 0, duplicate: 0, moved: 0, rejected: rows.rejected.length};
    const existing = await findSourceDocumentsBySha256(db, identity.org_id, rows.map((row) => row.sha256));
    const seen = new Map(existing.map((row) => [row.sha256, row]));
    const manifestKeys = new Set(rows.map((row) => row.key));
    for (const row of rows) {
      const document = seen.get(row.sha256);
      if (document?.storage === 'external' && document.external_location !== row.key && !manifestKeys.has(document.external_location)) {
        const moved = input.dryRun || (await recordSourceDocumentMove(db, {
          orgId: identity.org_id, userId: identity.user_id, documentId: document.id, toLocation: row.key,
        })).moved;
        // dryRunでも現在地を進め、同じ要求の残りのコピーを移動に数えない。
        document.external_location = row.key;
        counts[moved ? 'moved' : 'duplicate'] += 1;
        continue;
      }
      let duplicate = seen.has(row.sha256);
      if (!input.dryRun && !duplicate) {
        ({duplicate} = await registerSourceDocument(db, {
          orgId: identity.org_id, userId: identity.user_id,
          kind: kindForKey(row.key), fileName: fileNameForKey(row.key), receivedOn: receivedOnForUpload(row.uploadedAt),
          external: {location: row.key, byteLength: row.byteLength, sha256: row.sha256},
        }, {skipDuplicateLookup: true}));
      }
      if (!seen.has(row.sha256)) seen.set(row.sha256, {storage: 'external', external_location: row.key});
      counts[duplicate ? 'duplicate' : 'new'] += 1;
    }
    return c.json({ok: true, counts, rejected: rows.rejected});
  });
}
