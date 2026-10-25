// 現場の連絡帳の受け口（移行 0055）。作品の案件に所属する人（と管理者）が、スペースを見て連絡を出し、既読と了解を残す。
// 表は追加だけ。連絡は消せず、直すときは訂正の連絡を出す。社外の人の入口は作らない（裁定待ち）。
import {NOTEBOOK_TEMPLATES, NOTEBOOK_DESIGNS, DEFAULT_SPACES, threadView} from './notebook-model.mjs';
import {findSpace, listSpaces, addSpaceIfMissing, addSpace, unreadBySpace, listPosts, listReceipts, insertPost, findPost, addReceipt} from './notebook-store.mjs';
import {findWork} from '../preprod/preprod-store.mjs';
import {isPlacedInWork} from '../preprod/vault-store.mjs';

const integer = (v, label) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw Error(`${label}を確認してください`); return n; };
const text = (v, label, max, required = false) => { if (v != null && typeof v !== 'string') throw Error(`${label}を確認してください`); const s = (v || '').trim(); if (s.length > max || (required && !s)) throw Error(`${label}を確認してください`); return s || null; };

export function normalizePost(input) {
  const template = NOTEBOOK_TEMPLATES.find((t) => t.id === input.template);
  if (!template) throw Error('型を確認してください');
  if (!Object.hasOwn(NOTEBOOK_DESIGNS, input.design || 'simple')) throw Error('デザインを確認してください');
  const fields = Array.isArray(input.fields) ? input.fields : [];
  if (fields.length > 20) throw Error('欄が多すぎます');
  const cleanFields = fields.map((f) => ({label: text(f?.label, '欄の名前', 40, true), value: text(f?.value, '欄の値', 1000) || '', system: Boolean(f?.system)}));
  const attachments = Array.isArray(input.attachments) ? input.attachments.map((x) => integer(x, '添付')) : [];
  if (attachments.length > 20) throw Error('添付が多すぎます');
  return {template: template.id, title: text(input.title, '題', 200, true), fields: cleanFields, body: text(input.body, '本文', 5000), attachments: [...new Set(attachments)],
    design: input.design || 'simple', needs_ack: template.needsAck ? 1 : 0, corrects_post_id: input.correctsPostId == null || input.correctsPostId === '' ? null : integer(input.correctsPostId, '訂正元')};
}

export function registerNotebookRoutes(app, {db, bad, body, permittedProjects}) {
  async function workFor(identity, workId) {
    const work = await findWork(db, identity.org_id, workId);
    if (!work) return null;
    const allowed = await permittedProjects(db, identity, false);
    return allowed.some((p) => p.id === work.project_id) ? work : null;
  }
  async function spaceFor(identity, spaceId) {
    const space = await findSpace(db, identity.org_id, spaceId);
    return space && await workFor(identity, space.work_id) ? space : null;
  }

  // スペースの一覧。初めて開いた作品には既定のスペース（全体と部署）を作る
  app.get('/api/notebook/spaces', async (c) => {
    const i = c.get('identity');
    let workId; try { workId = integer(c.req.query('workId'), '作品'); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId)) return bad(c, '作品への権限がありません', 403);
    let spaces = await listSpaces(db, i.org_id, workId);
    if (!spaces.length) {
      for (const [k, name] of DEFAULT_SPACES.entries()) await addSpaceIfMissing(db, i.org_id, workId, k === 0 ? 'all' : 'department', name, i.user_id);
      spaces = await listSpaces(db, i.org_id, workId);
    }
    const unread = await unreadBySpace(db, i.org_id, workId, i.user_id);
    const counts = new Map(unread.map((u) => [u.space_id, Number(u.n)]));
    return c.json({ok: true, spaces: spaces.map((s) => ({...s, unread: counts.get(s.id) || 0}))});
  });

  app.post('/api/notebook/spaces', async (c) => {
    const i = c.get('identity');
    let input, workId, name; try { input = await body(c); workId = integer(input.workId, '作品'); name = text(input.name, '名前', 80, true); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId)) return bad(c, '作品への権限がありません', 403);
    try { await addSpace(db, i.org_id, workId, 'group', name, i.user_id); } catch (e) { return bad(c, '同じ名前のスペースがあります', 409, undefined, e); }
    return c.json({ok: true});
  });

  app.get('/api/notebook/spaces/:spaceId/posts', async (c) => {
    const i = c.get('identity');
    let spaceId; try { spaceId = integer(c.req.param('spaceId'), 'スペース'); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await spaceFor(i, spaceId)) return bad(c, 'スペースへの権限がありません', 403);
    const posts = await listPosts(db, i.org_id, spaceId);
    const receipts = posts.length ? await listReceipts(db, i.org_id, spaceId) : [];
    const view = threadView(posts.map((p) => ({...p, fields: JSON.parse(p.fields_json), attachments: JSON.parse(p.attachments_json)})), receipts, i.user_id);
    return c.json({ok: true, posts: view});
  });

  app.post('/api/notebook/spaces/:spaceId/posts', async (c) => {
    const i = c.get('identity');
    let spaceId, post; try { spaceId = integer(c.req.param('spaceId'), 'スペース'); post = normalizePost(await body(c)); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    const space = await spaceFor(i, spaceId);
    if (!space) return bad(c, 'スペースへの権限がありません', 403);
    // 添付は同じ組織の原本だけ（保管庫の置き場の記録がこの作品にあるもの）
    for (const id of post.attachments) {
      const ok = await isPlacedInWork(db, i.org_id, space.work_id, id);
      if (!ok) return bad(c, '添付はこの作品の保管庫の原本から選んでください', 400);
    }
    try {
      await insertPost(db, i.org_id, space.work_id, spaceId, i.user_id, post);
    } catch (e) { return bad(c, '出せませんでした。訂正元と入力を確かめ、開き直してください', 409, undefined, e); }
    return c.json({ok: true});
  });

  // 既読（開いた連絡）と了解（ボタン）。同じ人の2回目は何も足さない
  for (const kind of ['read', 'ack']) {
    app.post(`/api/notebook/posts/:postId/${kind}`, async (c) => {
      const i = c.get('identity');
      let postId; try { postId = integer(c.req.param('postId'), '連絡'); } catch (e) { return bad(c, e.message, 400, undefined, e); }
      const post = await findPost(db, i.org_id, postId);
      if (!post || !await spaceFor(i, post.space_id)) return bad(c, '連絡への権限がありません', 403);
      await addReceipt(db, i.org_id, postId, i.user_id, kind);
      return c.json({ok: true});
    });
  }
}
