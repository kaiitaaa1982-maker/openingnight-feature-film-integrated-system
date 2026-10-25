// プリプロの保管庫の受け口（移行 0054。PP4）。原本は共通の source_documents（0025）へ受け取り、置き場の記録を足す。
// 原本も置き場の記録も追加だけ。置き場を変えるときは新しい行を足す。権限は制作の画面と同じ（見る: 案件の所属・管理者、置く: 制作・編集の所属・管理者）。
import {registerSourceDocument, getSourceDocument, SourceDocumentError, MAX_INLINE_BYTES} from '../source-documents/source-documents-store.mjs';
import {VAULT_CATEGORY_IDS, sourceKindFor, currentPlacements} from './vault-model.mjs';
import {findWork, projectGrant} from './preprod-store.mjs';
import {insertPlacement as insertPlacementRow, readPlacementRows, isPlacedInWork} from './vault-store.mjs';

const integer = (v, label) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw Error(`${label}を確認してください`); return n; };
const optInt = (v, label) => (v == null || v === '' ? null : integer(v, label));
const text = (v, label, max) => { if (v != null && typeof v !== 'string') throw Error(`${label}を確認してください`); const s = (v || '').trim(); if (s.length > max) throw Error(`${label}を確認してください`); return s || null; };
const date = (v, label) => { const s = text(v, label, 10); if (!s) return null; if (!/^\d{4}-\d\d-\d\d$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw Error(`${label}を確認してください`); return s; };
const category = (v) => { if (!VAULT_CATEGORY_IDS.includes(v)) throw Error('置き場の種類を確認してください'); return v; };
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

function placementInput(input) {
  return {category: category(input.category), episode: text(input.episode, '話', 40), dated_on: date(input.datedOn, '日付'), origin_path: text(input.originPath, '元の置き場', 500),
    shooting_day_id: optInt(input.shootingDayId, '撮影日'), scene_id: optInt(input.sceneId, 'シーン'), note: text(input.note, 'メモ', 2000)};
}

export function registerVaultRoutes(app, {db, bad, body, permittedProjects}) {
  async function workFor(identity, workId, write = false) {
    const work = await findWork(db, identity.org_id, workId);
    if (!work) return null;
    const allowed = await permittedProjects(db, identity, false);
    if (!allowed.some((p) => p.id === work.project_id)) return null;
    if (!write || identity.role === 'admin') return work;
    if (!['production', 'editor'].includes(identity.role)) return null;
    const grant = await projectGrant(db, identity.org_id, work.project_id, identity.user_id, new Date().toISOString());
    return grant && (identity.role === 'production' ? grant.permission === 'production' : ['production', 'edit'].includes(grant.permission)) ? work : null;
  }
  const insertPlacement = (i, workId, documentId, p) => insertPlacementRow(db, i.org_id, i.user_id, workId, documentId, p);

  app.get('/api/preprod/works/:workId/documents', async (c) => {
    const i = c.get('identity');
    let workId; try { workId = integer(c.req.param('workId'), '作品'); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId)) return bad(c, '作品への権限がありません', 403);
    const rows = await readPlacementRows(db, i.org_id, workId);
    const origins = new Map();
    for (const r of rows) if (r.origin_path) { const set = origins.get(r.document_id) || new Set(); set.add(r.origin_path); origins.set(r.document_id, set); }
    const documents = currentPlacements(rows).map((r) => ({...r, origins: [...(origins.get(r.document_id) || [])]})).sort((a, b) => b.id - a.id);
    return c.json({ok: true, documents, maxBytes: MAX_INLINE_BYTES});
  });

  // 1ファイルを置く。中身は base64。同じ中身は原本を増やさず、置き場の記録だけ足す（duplicate: true）
  app.post('/api/preprod/works/:workId/documents', async (c) => {
    const i = c.get('identity');
    let workId, input, placement, bytes;
    try {
      workId = integer(c.req.param('workId'), '作品'); input = await body(c); placement = placementInput(input);
      if (typeof input.base64 !== 'string' || !input.base64) throw Error('中身が空です');
      const raw = atob(input.base64); bytes = new Uint8Array(raw.length); for (let k = 0; k < raw.length; k += 1) bytes[k] = raw.charCodeAt(k);
    } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    try {
      const fileName = text(input.fileName, 'ファイル名', 240);
      const saved = await registerSourceDocument(db, {orgId: i.org_id, userId: i.user_id, kind: sourceKindFor(placement.category, fileName), fileName, mediaType: text(input.mediaType, '形式', 160), receivedOn: todayJst(), bytes});
      await insertPlacement(i, workId, saved.id, placement);
      return c.json({ok: true, id: saved.id, duplicate: saved.duplicate});
    } catch (e) {
      if (e instanceof SourceDocumentError) return bad(c, e.message, 400, undefined, e);
      return bad(c, '置けませんでした。撮影日・シーンと入力を確かめ、開き直してください', 409, undefined, e);
    }
  });

  // 置き場を変える（索引を付ける）。新しい行を足す
  app.post('/api/preprod/works/:workId/documents/:documentId/placements', async (c) => {
    const i = c.get('identity');
    let workId, documentId, placement;
    try { workId = integer(c.req.param('workId'), '作品'); documentId = integer(c.req.param('documentId'), '原本'); placement = placementInput(await body(c)); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    const placed = await isPlacedInWork(db, i.org_id, workId, documentId);
    if (!placed) return bad(c, 'この作品の保管庫に無い原本です', 404);
    try { await insertPlacement(i, workId, documentId, placement); } catch (e) { return bad(c, '置き場を変えられませんでした。開き直してください', 409, undefined, e); }
    return c.json({ok: true});
  });

  // 原本を開く。この作品の保管庫に置いた原本だけ
  app.get('/api/preprod/works/:workId/documents/:documentId/content', async (c) => {
    const i = c.get('identity');
    let workId, documentId; try { workId = integer(c.req.param('workId'), '作品'); documentId = integer(c.req.param('documentId'), '原本'); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId)) return bad(c, '作品への権限がありません', 403);
    const placed = await isPlacedInWork(db, i.org_id, workId, documentId);
    if (!placed) return bad(c, '原本への権限がありません', 403);
    const doc = await getSourceDocument(db, i.org_id, documentId, {withContent: true});
    if (!doc || !doc.bytes) return bad(c, '外の置き場の原本は、ここでは開けません', 404);
    return new Response(doc.bytes, {headers: {'content-type': doc.media_type || 'application/octet-stream', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`, 'x-content-type-options': 'nosniff'}});
  });
}
