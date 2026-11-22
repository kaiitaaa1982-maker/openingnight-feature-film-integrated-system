// 小道具の品目と打ち合わせの受け口（移行 0061。会社ルートの plans/2026-11-09-props-meeting.md）。
// 表は追加だけ。直すときも打ち合わせで決めたときも新しい版を足す。読んだ版の番号（baseVersionNo）が最新でなければ 409（楽観ロック）。
// 見る権限はプリプロの画面と同じ（案件に所属する人・管理者）。書く権限もプリプロの保存と同じ（管理者、または制作・編集の所属）。
import {PROP_KINDS, PROP_DEPARTMENTS, PROP_STATES, PROP_SOURCES, IMPORT_LIMIT, normalizeVersion, normalizeMeeting, latestVersions, propRow, sortRows,
  meetingDecisions, checkImport, formatProblem} from './props-model.mjs';
import {findWork, projectGrant, writeAudit} from '../preprod-store.mjs';
import {readWorks, readWorkRows, findItem, findMeeting, readItemVersions, readMeetingVersions, readItemKeys, createItem, createItems,
  appendItemVersion, createMeeting} from './props-store.mjs';

const STALE = 'ほかの人が先に直しました。開き直してください';
const integer = (v, label) => { const n = Number(v); if (v == null || v === '' || !Number.isSafeInteger(n) || n <= 0) throw Error(`${label}を確認してください`); return n; };
const newKey = () => globalThis.crypto.randomUUID();

export function registerPropRoutes(app, {db, bad, body, permittedProjects}) {
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
  // 打ち合わせの id を確かめる（同じ作品のものだけ）
  async function meetingFor(identity, meetingId, workId) {
    if (meetingId == null || meetingId === '') return null;
    const id = integer(meetingId, '打ち合わせ');
    const meeting = await findMeeting(db, identity.org_id, id);
    if (!meeting || meeting.work_id !== workId) throw Error('打ち合わせを確認してください');
    return id;
  }

  app.get('/api/props', async (c) => {
    const i = c.get('identity');
    const works = await visibleWorks(i);
    let workId = null;
    try { if (c.req.query('workId')) workId = integer(c.req.query('workId'), '作品'); } catch (e) { return fail(c, e); }
    if (workId != null && !works.some((w) => w.id === workId)) return bad(c, '作品への権限がありません', 403);
    const work = works.find((w) => w.id === workId) || works[0] || null;
    const list = [];
    for (const w of works) list.push({id: w.id, title: w.title, canWrite: await canWrite(i, w)});
    const vocab = {kinds: PROP_KINDS, departments: PROP_DEPARTMENTS, states: PROP_STATES, sources: PROP_SOURCES};
    if (!work) return c.json({ok: true, works: list, workId: null, items: [], meetings: [], vocab});
    const {items, versions, meetings} = await readWorkRows(db, i.org_id, work.id);
    const latest = latestVersions(versions);
    const rows = sortRows(items.filter((it) => latest.has(it.id)).map((it) => propRow({item: it, version: latest.get(it.id)})));
    return c.json({ok: true, works: list, workId: work.id, items: rows, vocab,
      meetings: meetings.map((m) => ({id: m.id, heldOn: m.held_on, title: m.title, departments: m.departments ? m.departments.split(',') : [], note: m.note, decided: Number(m.decided)}))});
  });

  app.get('/api/props/items/:id', async (c) => {
    const i = c.get('identity');
    let id; try { id = integer(c.req.param('id'), '品目'); } catch (e) { return fail(c, e); }
    const item = await findItem(db, i.org_id, id);
    const work = item && await workFor(i, item.work_id);
    if (!work) return bad(c, '品目への権限がありません', 403);
    const versions = await readItemVersions(db, i.org_id, id);
    return c.json({ok: true, item, canWrite: await canWrite(i, work),
      versions: versions.map((v) => ({...propRow({item, version: v}), meetingTitle: v.meeting_title ?? null, meetingHeldOn: v.meeting_held_on ?? null, createdBy: v.created_by}))});
  });

  app.post('/api/props/items', async (c) => {
    const i = c.get('identity');
    let input, workId, row;
    try { input = await body(c); workId = integer(input.workId, '作品'); row = normalizeVersion(input); } catch (e) { return fail(c, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    let meetingId; try { meetingId = await meetingFor(i, input.meetingId, workId); } catch (e) { return fail(c, e); }
    try {
      const created = await createItem(db, i.org_id, i.user_id, workId, newKey(), row, meetingId);
      await audit(i, 'create', 'prop_item', created.id, {workId, state: row.state, meetingId});
      return c.json({ok: true, id: created.id, versionNo: 1}, 201);
    } catch (e) { return bad(c, '保存できませんでした。入力を確かめ、開き直してください', 409, undefined, e); }
  });

  // 直す・打ち合わせで決める（中身の全部を新しい版にする。meetingId を付けるとその回で決めたことになる）
  app.post('/api/props/items/:id/versions', async (c) => {
    const i = c.get('identity');
    let id, input, row;
    try { id = integer(c.req.param('id'), '品目'); input = await body(c); row = normalizeVersion(input); } catch (e) { return fail(c, e); }
    const item = await findItem(db, i.org_id, id);
    if (!item || !await workFor(i, item.work_id, true)) return bad(c, '品目の制作編集権限がありません', 403);
    let meetingId; try { meetingId = await meetingFor(i, input.meetingId, item.work_id); } catch (e) { return fail(c, e); }
    const versions = await readItemVersions(db, i.org_id, id);
    const base = Number(input.baseVersionNo);
    if (!Number.isSafeInteger(base) || base !== versions.at(-1)?.version_no) return bad(c, STALE, 409);
    try { await appendItemVersion(db, i.org_id, i.user_id, id, base + 1, row, meetingId); } catch (e) { return bad(c, STALE, 409, undefined, e); }
    await audit(i, 'append', 'prop_item', id, {versionNo: base + 1, state: row.state, meetingId});
    return c.json({ok: true, versionNo: base + 1}, 201);
  });

  app.post('/api/props/meetings', async (c) => {
    const i = c.get('identity');
    let input, workId, row;
    try { input = await body(c); workId = integer(input.workId, '作品'); row = normalizeMeeting(input); } catch (e) { return fail(c, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    const created = await createMeeting(db, i.org_id, i.user_id, workId, row);
    await audit(i, 'create', 'prop_meeting', created.id, {workId, heldOn: row.held_on});
    return c.json({ok: true, id: created.id}, 201);
  });

  // 打ち合わせで決めたこと（その回に足した版を順に）
  app.get('/api/props/meetings/:id', async (c) => {
    const i = c.get('identity');
    let id; try { id = integer(c.req.param('id'), '打ち合わせ'); } catch (e) { return fail(c, e); }
    const meeting = await findMeeting(db, i.org_id, id);
    if (!meeting || !await workFor(i, meeting.work_id)) return bad(c, '打ち合わせへの権限がありません', 403);
    const {versions, items} = await readMeetingVersions(db, i.org_id, id);
    return c.json({ok: true, meeting: {id: meeting.id, workId: meeting.work_id, heldOn: meeting.held_on, title: meeting.title,
      departments: meeting.departments ? meeting.departments.split(',') : [], note: meeting.note}, decisions: meetingDecisions(versions, items)});
  });

  // 取込（scripts/import-props.mjs から）。問題が1つでもあれば何も書かない。登録済みの key は飛ばす（2回流しても増えない）
  app.post('/api/props/import', async (c) => {
    const i = c.get('identity');
    let input, workId;
    try { input = await body(c); workId = integer(input.workId, '作品'); } catch (e) { return fail(c, e); }
    if (!await workFor(i, workId, true)) return bad(c, '作品の制作編集権限がありません', 403);
    const {problems, rows} = checkImport(input);
    if (problems.length) return bad(c, problems.slice(0, 20).map(formatProblem).join(' ／ '), 400);
    const existing = await readItemKeys(db, i.org_id, workId);
    const fresh = rows.filter((r) => !existing.has(r.key));
    if (fresh.length) {
      try { await createItems(db, i.org_id, i.user_id, workId, fresh); } catch (e) { return bad(c, '取り込めませんでした。開き直してもう一度流してください', 409, undefined, e); }
    }
    await audit(i, 'import', 'prop_item', workId, {created: fresh.length, skipped: rows.length - fresh.length, limit: IMPORT_LIMIT});
    return c.json({ok: true, workId, created: fresh.length, skipped: rows.length - fresh.length}, 201);
  });
}
