// 撮影の許可申請の受け口（移行 0060。会社ルートの plans/2026-11-06-real-demo-split.md の手順8。決まりは brain の wiki/10_manual/road-use-permit.md）。
// 表は追加だけ。直すときも状態を変えるときも新しい版を足す。読んだ版の番号（baseVersionNo）が最新でなければ 409（楽観ロック）。
// 見る権限はプリプロの画面と同じ（案件に所属する人・管理者）。書く権限もプリプロの保存と同じ（管理者、または制作・編集の所属）。
// 提出先（警察署・役所など）は組織で共通。組織の所属なら誰でも足し・直せる。
// 祝日の表はまだ無いので、申請の最終日は土日だけを除いて数える（HOLIDAYS は空）。
import {PERMIT_KINDS, PERMIT_STATES, PERMIT_DOCUMENT_ROLES, checkSpan, latestVersions, latestOfficeSettings, permitRow, filterRows} from './permit-model.mjs';
import {findWork, projectGrant, writeAudit} from '../preprod-store.mjs';
import {isPlacedInWork} from '../vault-store.mjs';
import {getSourceDocument} from '../../source-documents/source-documents-store.mjs';
import {
  readOffices, readOfficeVersions, findOffice, latestOfficeVersion, createOffice, appendOfficeVersion,
  readWorks, findApplication, readApplicationRows, readApplicationVersions, readApplicationDocuments,
  createApplication, appendApplicationVersion, linkDocument,
} from './permit-store.mjs';

const HOLIDAYS = Object.freeze([]);
const STALE = 'ほかの人が先に直しました。開き直してください';

const integer = (v, label) => { const n = Number(v); if (v == null || v === '' || !Number.isSafeInteger(n) || n <= 0) throw Error(`${label}を確認してください`); return n; };
const optCount = (v, label, min, max) => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : Number(v); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`${label}を確認してください`); return n; };
const text = (v, label, max, required = false) => { if (v != null && typeof v !== 'string') throw Error(`${label}を確認してください`); const s = (v || '').trim(); if (s.length > max || (required && !s)) throw Error(`${label}を確認してください`); return s || null; };
const date = (v, label, required = false) => { const s = text(v, label, 10, required); if (!s) return null; if (!/^\d{4}-\d\d-\d\d$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw Error(`${label}を確認してください`); return s; };
const pick = (v, map, label) => { if (typeof v !== 'string' || !Object.hasOwn(map, v)) throw Error(`${label}を確認してください`); return v; };
const optPick = (v, map, label) => (v == null || v === '' ? null : pick(v, map, label));
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const newKey = () => globalThis.crypto.randomUUID();

export function normalizeOffice(input) {
  return {name: text(input.name, '提出先', 120, true), lead_business_days: optCount(input.leadBusinessDays, '受け取りまでの日数', 0, 30),
    max_span_days: optCount(input.maxSpanDays, 'まとめて申請できる日数', 1, 366), note: text(input.note, 'メモ', 2000)};
}

// 版の中身。状態ごとの日付の決まりは表の CHECK と同じことを先に確かめ、分かる言葉で返す
export function normalizeVersion(input) {
  const out = {
    office_id: integer(input.officeId, '提出先'), place: text(input.place, '場所', 300, true),
    starts_on: date(input.startsOn, '使う日', true), ends_on: date(input.endsOn || input.startsOn, '使う日の終わり', true),
    applied_on: date(input.appliedOn, '申請日'), pickup_on: date(input.pickupOn, '受け取り予定'), received_on: date(input.receivedOn, '受け取った日'),
    state: pick(input.state || 'draft', PERMIT_STATES, '状態'), fee_yen: optCount(input.feeYen, '手数料', 0, Number.MAX_SAFE_INTEGER), note: text(input.note, 'メモ', 2000),
  };
  if (out.ends_on < out.starts_on) throw Error('使う日の終わりは始めより後にしてください');
  if (!['draft', 'withdrawn'].includes(out.state) && !out.applied_on) throw Error('提出したあとの状態には申請日を入れてください');
  if (out.received_on && !['permitted', 'done'].includes(out.state)) throw Error('受け取った日は許可か済みの状態で入れてください');
  if (out.applied_on && out.pickup_on && out.pickup_on < out.applied_on) throw Error('受け取り予定は申請日より後にしてください');
  if (out.applied_on && out.received_on && out.received_on < out.applied_on) throw Error('受け取った日は申請日より後にしてください');
  return out;
}

const versionInput = (v) => ({officeId: v.office_id, place: v.place, startsOn: v.starts_on, endsOn: v.ends_on, appliedOn: v.applied_on,
  pickupOn: v.pickup_on, receivedOn: v.received_on, state: v.state, feeYen: v.fee_yen, note: v.note});

export function registerPermitRoutes(app, {db, bad, body, permittedProjects}) {
  const fail = (c, e, status = 400) => bad(c, e.message, status, undefined, e);
  const audit = (i, action, entity, id, detail) => writeAudit(db, i.org_id, i.user_id, action, entity, id, detail);

  async function visibleWorks(identity) {
    const allowed = new Set((await permittedProjects(db, identity, false)).map((p) => p.id));
    return (await readWorks(db, identity.org_id)).filter((w) => allowed.has(w.project_id));
  }
  async function canWrite(identity, work) {
    if (identity.role === 'admin') return true;
    if (!['production', 'editor'].includes(identity.role)) return false;
    const grant = await projectGrant(db, identity.org_id, work.project_id, identity.user_id, new Date().toISOString());
    return Boolean(grant && (identity.role === 'production' ? grant.permission === 'production' : ['production', 'edit'].includes(grant.permission)));
  }
  // 作品が見えるか（write なら書けるか）。見えない作品は null
  async function workFor(identity, workId, write = false) {
    const work = await findWork(db, identity.org_id, workId);
    if (!work) return null;
    const allowed = await permittedProjects(db, identity, false);
    if (!allowed.some((p) => p.id === work.project_id)) return null;
    return !write || await canWrite(identity, work) ? work : null;
  }
  async function officeSettings(orgId) {
    const [offices, versions] = await Promise.all([readOffices(db, orgId), readOfficeVersions(db, orgId)]);
    const latest = latestOfficeSettings(versions);
    return offices.map((o) => ({id: o.id, name: o.name, versionNo: latest.get(o.id)?.version_no ?? 0,
      lead_business_days: latest.get(o.id)?.lead_business_days ?? null, max_span_days: latest.get(o.id)?.max_span_days ?? null, note: latest.get(o.id)?.note ?? null}));
  }
  async function spanError(orgId, row) {
    const setting = await latestOfficeVersion(db, orgId, row.office_id);
    const span = checkSpan({startsOn: row.starts_on, endsOn: row.ends_on, maxSpanDays: setting?.max_span_days ?? null});
    return span.ok ? null : `この提出先にまとめて申請できるのは${span.max}日までです（${span.days}日）`;
  }
  // 申請を開く（見える作品の申請だけ）。見えなければ null
  async function applicationFor(identity, id, write = false) {
    const application = await findApplication(db, identity.org_id, id);
    if (!application) return null;
    const work = await workFor(identity, application.work_id, write);
    return work ? {application, work} : null;
  }

  app.get('/api/permits', async (c) => {
    const i = c.get('identity');
    let filter;
    try {
      const q = (k) => c.req.query(k) || null;
      filter = {workId: q('workId') == null ? null : integer(q('workId'), '作品'), kind: optPick(q('kind'), PERMIT_KINDS, '種類'),
        officeId: q('officeId') == null ? null : integer(q('officeId'), '提出先'), state: optPick(q('state'), PERMIT_STATES, '状態')};
    } catch (e) { return fail(c, e); }
    const works = await visibleWorks(i);
    const workById = new Map(works.map((w) => [w.id, w]));
    const [offices, {applications, versions, documentCounts}] = await Promise.all([officeSettings(i.org_id), readApplicationRows(db, i.org_id)]);
    const officeById = new Map(offices.map((o) => [o.id, o]));
    const latest = latestVersions(versions);
    const counts = new Map(documentCounts.map((r) => [r.application_id, Number(r.n)]));
    const today = todayJst();
    const rows = applications.filter((a) => workById.has(a.work_id) && latest.has(a.id))
      .map((a) => permitRow({application: a, version: latest.get(a.id), office: officeById.get(latest.get(a.id).office_id), work: workById.get(a.work_id), documentCount: counts.get(a.id) || 0}, {today, holidays: HOLIDAYS}));
    const canWriteWorks = [];
    for (const w of works) if (await canWrite(i, w)) canWriteWorks.push(w.id);
    return c.json({ok: true, today, holidays: HOLIDAYS, applications: filterRows(rows, filter),
      works: works.map((w) => ({id: w.id, title: w.title, canWrite: canWriteWorks.includes(w.id)})),
      offices: offices.map((o) => ({id: o.id, name: o.name, versionNo: o.versionNo, leadBusinessDays: o.lead_business_days, maxSpanDays: o.max_span_days, note: o.note}))});
  });

  app.get('/api/permits/:id', async (c) => {
    const i = c.get('identity');
    let id; try { id = integer(c.req.param('id'), '申請'); } catch (e) { return fail(c, e); }
    const found = await applicationFor(i, id);
    if (!found) return bad(c, '申請への権限がありません', 403);
    const [versions, documents] = await Promise.all([readApplicationVersions(db, i.org_id, id), readApplicationDocuments(db, i.org_id, id)]);
    return c.json({ok: true, application: found.application, versions, documents, canWrite: await canWrite(i, found.work)});
  });

  app.post('/api/permits', async (c) => {
    const i = c.get('identity');
    let input, workId, kind, row;
    try { input = await body(c); workId = integer(input.workId, '作品'); kind = pick(input.kind, PERMIT_KINDS, '種類'); row = normalizeVersion(input); } catch (e) { return fail(c, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    if (!await findOffice(db, i.org_id, row.office_id)) return bad(c, '提出先を確認してください', 400);
    const over = await spanError(i.org_id, row); if (over) return bad(c, over, 400);
    try {
      const created = await createApplication(db, i.org_id, i.user_id, {key: newKey(), workId, kind}, row);
      await audit(i, 'create', 'permit_application', created.id, {workId, kind, state: row.state});
      return c.json({ok: true, id: created.id, versionNo: 1}, 201);
    } catch (e) { return bad(c, '保存できませんでした。入力を確かめ、開き直してください', 409, undefined, e); }
  });

  // 直す（中身の全部を新しい版にする）
  app.post('/api/permits/:id/versions', async (c) => {
    const i = c.get('identity');
    let id, input, row;
    try { id = integer(c.req.param('id'), '申請'); input = await body(c); row = normalizeVersion(input); } catch (e) { return fail(c, e); }
    return appendVersion(c, i, id, input.baseVersionNo, row);
  });

  // 状態を変える（いまの版を写して状態と日付だけを変える）
  app.post('/api/permits/:id/state', async (c) => {
    const i = c.get('identity');
    let id, input;
    try { id = integer(c.req.param('id'), '申請'); input = await body(c); pick(input.state, PERMIT_STATES, '状態'); } catch (e) { return fail(c, e); }
    if (!await applicationFor(i, id, true)) return bad(c, '申請の制作編集権限がありません', 403);
    const versions = await readApplicationVersions(db, i.org_id, id);
    const current = versions.at(-1);
    if (!current) return bad(c, '申請への権限がありません', 403);
    const patch = {state: input.state};
    for (const k of ['appliedOn', 'pickupOn', 'receivedOn']) if (Object.hasOwn(input, k)) patch[k] = input[k];
    let row; try { row = normalizeVersion({...versionInput(current), ...patch}); } catch (e) { return fail(c, e); }
    return appendVersion(c, i, id, input.baseVersionNo, row);
  });

  async function appendVersion(c, i, id, baseVersionNo, row) {
    const found = await applicationFor(i, id, true);
    if (!found) return bad(c, '申請の制作編集権限がありません', 403);
    const versions = await readApplicationVersions(db, i.org_id, id);
    const base = Number(baseVersionNo);
    if (!Number.isSafeInteger(base) || base !== versions.at(-1)?.version_no) return bad(c, STALE, 409);
    if (!await findOffice(db, i.org_id, row.office_id)) return bad(c, '提出先を確認してください', 400);
    const over = await spanError(i.org_id, row); if (over) return bad(c, over, 400);
    try { await appendApplicationVersion(db, i.org_id, i.user_id, id, base + 1, row); } catch (e) { return bad(c, STALE, 409, undefined, e); }
    await audit(i, 'append', 'permit_application', id, {versionNo: base + 1, state: row.state});
    return c.json({ok: true, versionNo: base + 1}, 201);
  }

  // 原本を結び付ける。管理者は組織の原本なら何でも、ほかの人はその作品のプリプロの保管庫に置いた原本だけ
  app.post('/api/permits/:id/documents', async (c) => {
    const i = c.get('identity');
    let id, documentId, role;
    try { id = integer(c.req.param('id'), '申請'); const input = await body(c); documentId = integer(input.documentId, '原本'); role = pick(input.role, PERMIT_DOCUMENT_ROLES, '書類の種類'); } catch (e) { return fail(c, e); }
    const found = await applicationFor(i, id, true);
    if (!found) return bad(c, '申請の制作編集権限がありません', 403);
    const allowed = i.role === 'admin' ? Boolean(await getSourceDocument(db, i.org_id, documentId)) : await isPlacedInWork(db, i.org_id, found.application.work_id, documentId);
    if (!allowed) return bad(c, 'この原本への権限がありません', 403);
    try { await linkDocument(db, i.org_id, i.user_id, id, documentId, role); } catch (e) { return bad(c, 'この原本はもう結び付いています', 409, undefined, e); }
    await audit(i, 'link', 'permit_application_document', id, {documentId, role});
    return c.json({ok: true}, 201);
  });

  app.post('/api/permit-offices', async (c) => {
    const i = c.get('identity');
    let row; try { row = normalizeOffice(await body(c)); } catch (e) { return fail(c, e); }
    try {
      const created = await createOffice(db, i.org_id, i.user_id, row);
      await audit(i, 'create', 'permit_office', created.id, {name: row.name});
      return c.json({ok: true, id: created.id, versionNo: 1}, 201);
    } catch (e) { return bad(c, '同じ名前の提出先があります', 409, undefined, e); }
  });

  app.post('/api/permit-offices/:id/versions', async (c) => {
    const i = c.get('identity');
    let id, input, row;
    try { id = integer(c.req.param('id'), '提出先'); input = await body(c); row = normalizeOffice(input); } catch (e) { return fail(c, e); }
    const office = await findOffice(db, i.org_id, id);
    if (!office) return bad(c, '提出先を確認してください', 404);
    if (row.name !== office.name) return bad(c, '提出先の名前は変えられません', 400);
    const current = await latestOfficeVersion(db, i.org_id, id);
    const base = Number(input.baseVersionNo);
    if (!Number.isSafeInteger(base) || base !== (current?.version_no ?? 0)) return bad(c, STALE, 409);
    try { await appendOfficeVersion(db, i.org_id, i.user_id, id, base + 1, row); } catch (e) { return bad(c, STALE, 409, undefined, e); }
    await audit(i, 'append', 'permit_office', id, {versionNo: base + 1});
    return c.json({ok: true, versionNo: base + 1}, 201);
  });
}
