// プリプロの手配・美術・シーンの撮影の方針の受け口（移行 0053。会社ルートの plans/2026-10-22-folder-preprod.md の PP6・PP7）。
// 表は追加だけ。直すときも取り消すときも新しい版を足し、いまの値は識別子ごとの最新の版から読む。金額は持たない。
// 見る権限は制作の画面と同じ（案件に所属する人・管理者）。書く権限も制作の画面の保存と同じ（管理者、または制作・編集の所属）。

import {ARRANGEMENT_KINDS, ARRANGEMENT_STATES, ART_KINDS, ART_STATES} from './preprod-model.mjs';
export {ARRANGEMENT_KINDS, ARRANGEMENT_STATES, ART_KINDS, ART_STATES};
import {findWork, projectGrant, readPlanRows, appendArrangement, appendArtItem, appendShootPlan, writeAudit} from './preprod-store.mjs';

const integer = (v, label) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw Error(`${label}を確認してください`); return n; };
const optInt = (v, label, min, max) => { if (v == null || v === '') return null; const n = Number(v); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`${label}を確認してください`); return n; };
const text = (v, label, max, required = false) => { if (v != null && typeof v !== 'string') throw Error(`${label}を確認してください`); const s = (v || '').trim(); if (s.length > max || (required && !s)) throw Error(`${label}を確認してください`); return s || null; };
const date = (v, label) => { const s = text(v, label, 10); if (!s) return null; if (!/^\d{4}-\d\d-\d\d$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw Error(`${label}を確認してください`); return s; };
const pick = (v, map, label) => { if (!Object.hasOwn(map, v)) throw Error(`${label}を確認してください`); return v; };
const newKey = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 64);
const key = (v) => { if (v == null || v === '') return newKey(); const s = text(v, '識別子', 64, true); if (/[\u0000-\u001f]/.test(s)) throw Error('識別子を確認してください'); return s; };

export function normalizeArrangement(input) {
  const out = {
    key: key(input.key), kind: pick(input.kind, ARRANGEMENT_KINDS, '種類'), partner_id: optInt(input.partnerId, '取引先', 1, Number.MAX_SAFE_INTEGER),
    item: text(input.item, '品目', 200, true), quantity: optInt(input.quantity, '数量', 0, 100000), unit: text(input.unit, '単位', 20),
    capacity: optInt(input.capacity, '定員', 1, 1000), starts_on: date(input.startsOn, '開始日'), ends_on: date(input.endsOn, '終了日'),
    deadline_on: date(input.deadlineOn, '締切'), state: pick(input.state || 'hold', ARRANGEMENT_STATES, '状態'), note: text(input.note, 'メモ', 2000),
  };
  if (out.starts_on && out.ends_on && out.ends_on < out.starts_on) throw Error('終了日は開始日より後にしてください');
  return out;
}

export function normalizeArtItem(input) {
  return {
    key: key(input.key), scene_id: optInt(input.sceneId, 'シーン', 1, Number.MAX_SAFE_INTEGER), kind: pick(input.kind, ART_KINDS, '種類'),
    content: text(input.content, '中身', 500, true), owner_label: text(input.owner, '担当', 80), delivery_on: date(input.deliveryOn, '搬入の日'),
    state: pick(input.state || 'open', ART_STATES, '状態'), note: text(input.note, 'メモ', 2000),
  };
}

export function normalizeShootPlan(input) {
  return {scene_id: integer(input.sceneId, 'シーン'), methods: text(input.methods, '手法', 200), equipment: text(input.equipment, '機材', 500), note: text(input.note, 'メモ', 2000)};
}

// 識別子ごとの最新の版だけを残す（取消の版も残す。画面が取消を灰色で出す）
export function latestBy(rows, field) {
  const map = new Map();
  for (const row of rows) { const prev = map.get(row[field]); if (!prev || row.version_no > prev.version_no) map.set(row[field], row); }
  return [...map.values()];
}

export function registerPreprodRoutes(app, {db, bad, body, permittedProjects}) {
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
  const workParam = (c) => integer(c.req.param('workId'), '作品');
  const audit = (i, action, entity, id, detail) => writeAudit(db, i.org_id, i.user_id, action, entity, id, detail);

  app.get('/api/preprod/works/:workId/plans', async (c) => {
    const i = c.get('identity');
    let workId; try { workId = workParam(c); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId)) return bad(c, '作品への権限がありません', 403);
    const {arrangements, artItems, shootPlans, partners} = await readPlanRows(db, i.org_id, workId);
    return c.json({ok: true, arrangements: latestBy(arrangements, 'arrangement_key'), artItems: latestBy(artItems, 'item_key'), shootPlans: latestBy(shootPlans, 'scene_id'), partners});
  });

  app.post('/api/preprod/works/:workId/arrangements', async (c) => {
    const i = c.get('identity');
    let workId, row; try { workId = workParam(c); row = normalizeArrangement(await body(c)); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    try {
      await appendArrangement(db, i.org_id, i.user_id, workId, row);
      await audit(i, 'append', 'production_arrangement', row.key, {workId, kind: row.kind, state: row.state});
    } catch (e) { return bad(c, '保存できませんでした。取引先と入力を確かめ、開き直してください', 409, undefined, e); }
    return c.json({ok: true, key: row.key});
  });

  app.post('/api/preprod/works/:workId/art-items', async (c) => {
    const i = c.get('identity');
    let workId, row; try { workId = workParam(c); row = normalizeArtItem(await body(c)); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    try {
      await appendArtItem(db, i.org_id, i.user_id, workId, row);
      await audit(i, 'append', 'scene_art_item', row.key, {workId, kind: row.kind, state: row.state});
    } catch (e) { return bad(c, '保存できませんでした。シーンと入力を確かめ、開き直してください', 409, undefined, e); }
    return c.json({ok: true, key: row.key});
  });

  app.post('/api/preprod/works/:workId/shoot-plans', async (c) => {
    const i = c.get('identity');
    let workId, row; try { workId = workParam(c); row = normalizeShootPlan(await body(c)); } catch (e) { return bad(c, e.message, 400, undefined, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    try {
      await appendShootPlan(db, i.org_id, i.user_id, workId, row);
      await audit(i, 'append', 'scene_shoot_plan', row.scene_id, {workId});
    } catch (e) { return bad(c, '保存できませんでした。シーンを確かめ、開き直してください', 409, undefined, e); }
    return c.json({ok: true});
  });
}
