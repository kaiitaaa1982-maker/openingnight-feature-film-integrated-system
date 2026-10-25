// ポストプロダクションの受け口（要件 docs/requirements/production/post-production.md。移行 0025）。
// 見て書けるのは、作品の案件に所属する人（制作担当を含む。ポスプロは制作の仕事）と管理者。権限の無い作品と別の組織の作品は、有無を見せず同じ 403 にする。
// 金額は持たない（外注費は経費の側。約束 K-1・KC-6）。取引先への納品の〆切と状態は sales_deliverables を読むだけ（約束 E-4）
import {CONTRACT_DELIVERABLE_TEMPLATE, CUT_KINDS, DELIVERABLE_STATUSES, NOTE_RESULTS, PHASES, VIEWPOINTS, FROM_ROLES, ASSIGNEES,
  deliverableState, homeNumbers, isOpenNote, jstToday, normalizeCut, normalizeDeliverable, normalizeDeliverableEvent, normalizeNote, normalizeNoteAction,
  normalizeTask, normalizeTaskEvent, noteState, phaseSummaries, postFolderStatus, taskState, vimeoEmbed} from './post-model.mjs';
import {addCut, addDeliverableEvent, addDeliverables, addNote, addNoteAction, addTask, addTaskEvent, readCutForWork, readItemForWork, readNoteForWork,
  readPostDetail, readPostSummaries, readPostWork, readPostWorks, readSalesDeliverableForWork, readTaskForWork} from './post-store.mjs';

const FORBIDDEN = 'この作品のポスプロへの権限がありません';
const byKey = (rows, key) => {
  const map = new Map();
  for (const row of rows) { const k = Number(row[key]); if (!map.has(k)) map.set(k, []); map.get(k).push(row); }
  return map;
};

export function buildPostDetail(raw, today) {
  const actionsByNote = byKey(raw.actions, 'note_id');
  const eventsByTask = byKey(raw.taskEvents, 'task_id');
  const eventsByItem = byKey(raw.itemEvents, 'item_id');
  const sales = new Map(raw.sales.map((s) => [Number(s.id), {id: Number(s.id), title: s.title, dueOn: s.due_on, status: s.status, submittedOn: s.submitted_on, acceptedOn: s.accepted_on}]));
  const cuts = raw.cuts.map((c) => ({id: Number(c.id), episodeNo: c.episode_no == null ? null : Number(c.episode_no), variant: c.variant, label: c.label, kind: c.kind,
    deliveredOn: c.delivered_on, runtimeSeconds: c.runtime_seconds == null ? null : Number(c.runtime_seconds), reviewUrl: c.review_url,
    embedUrl: vimeoEmbed(c.review_url), createdAt: c.created_at}));
  const notes = raw.notes.map((n) => {
    const actions = (actionsByNote.get(Number(n.id)) ?? []).map((a) => ({id: Number(a.id), result: a.result, fixedCutId: a.fixed_cut_id == null ? null : Number(a.fixed_cut_id),
      reason: a.reason, createdAt: a.created_at}));
    return {id: Number(n.id), cutId: Number(n.cut_id), tcIn: Number(n.tc_in_seconds), tcOut: n.tc_out_seconds == null ? null : Number(n.tc_out_seconds),
      viewpoint: n.viewpoint, fromRole: n.from_role, assignee: n.assignee, body: n.body, createdAt: n.created_at, actions, state: noteState(actions)};
  });
  const tasks = raw.tasks.map((t) => {
    const base = {id: Number(t.id), phase: t.phase, episodeNo: t.episode_no == null ? null : Number(t.episode_no), name: t.name, dueOn: t.due_on, assignee: t.assignee};
    return {...base, ...taskState(base, (eventsByTask.get(base.id) ?? []).map((e) => ({kind: e.kind, dueOn: e.due_on, onDate: e.on_date})))};
  });
  const deliverables = raw.items.map((i) => {
    const events = (eventsByItem.get(Number(i.id)) ?? []).map((e) => ({status: e.status, onDate: e.on_date, note: e.note}));
    const state = deliverableState(events);
    return {id: Number(i.id), sourceKind: i.source_kind, section: i.section, name: i.name, episodeNo: i.episode_no == null ? null : Number(i.episode_no),
      spec: i.spec, owner: i.owner, salesDeliverable: i.sales_deliverable_id == null ? null : sales.get(Number(i.sales_deliverable_id)) ?? null,
      status: state.status, onDate: state.onDate, lastNote: events.at(-1)?.note ?? null};
  });
  const finalCutIds = new Set(cuts.filter((c) => c.kind === 'final').map((c) => c.id));
  const finalScreeningNoteOpen = notes.some((n) => finalCutIds.has(n.cutId) && isOpenNote(n.state));
  return {cuts, notes, tasks, deliverables, salesDeliverables: [...sales.values()],
    phases: phaseSummaries(tasks, deliverables, today), numbers: homeNumbers(tasks, deliverables, notes, today),
    folderStatus: postFolderStatus({tasks, deliverables, notes, finalScreeningNoteOpen, today})};
}

export function registerPostRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('post routes require app, db, bad, body and permittedProjects');
  }

  async function workAccess(c) {
    const identity = c.get('identity');
    const raw = c.req.param('workId');
    const workId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(workId) || workId <= 0) return {error: bad(c, '作品の番号を確かめてください', 400)};
    const [work, projects] = await Promise.all([readPostWork(db, identity.org_id, workId), permittedProjects(db, identity, false)]);
    if (!work || !projects.some((p) => Number(p.id) === Number(work.project_id))) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, work: {...work, id: Number(work.id), project_id: Number(work.project_id)}};
  }

  async function readBody(c) {
    try {
      const input = await body(c);
      return {input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }

  async function guarded(c, handler) {
    const found = await workAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    return handler(found, read.input);
  }
  const invalid = (c, normalized) => bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
  const idParam = (c, name) => { const v = Number(c.req.param(name)); return Number.isSafeInteger(v) && v > 0 ? v : null; };

  // 選べる語（工程・版の種類・観点・誰から・担当・納品物の状態）と、契約の納入物件の型
  const vocabulary = {phases: PHASES, cutKinds: CUT_KINDS, noteResults: NOTE_RESULTS, deliverableStatuses: DELIVERABLE_STATUSES, viewpoints: VIEWPOINTS,
    fromRoles: FROM_ROLES, assignees: ASSIGNEES, contractTemplate: CONTRACT_DELIVERABLE_TEMPLATE};

  // ホーム: 見てよい作品ごとに数字だけ（納品物の数・期限超のタスク・片づいていない指摘・フォルダの状態）
  app.get('/api/post/works', async (c) => {
    const identity = c.get('identity');
    const projectIds = (await permittedProjects(db, identity, false)).map((p) => Number(p.id));
    const works = await readPostWorks(db, identity.org_id, projectIds);
    const today = jstToday();
    const s = await readPostSummaries(db, identity.org_id, works.map((w) => Number(w.id)));
    const taskEvents = byKey(s.taskEvents, 'task_id');
    const itemEvents = byKey(s.itemEvents, 'item_id');
    const noteActions = byKey(s.actions, 'note_id');
    const rows = works.map((w) => {
      const id = Number(w.id);
      const tasks = s.tasks.filter((t) => Number(t.work_id) === id).map((t) => ({phase: t.phase, ...taskState({dueOn: t.due_on},
        (taskEvents.get(Number(t.id)) ?? []).map((e) => ({kind: e.kind, dueOn: e.due_on, onDate: e.on_date})))}));
      const deliverables = s.items.filter((i) => Number(i.work_id) === id).map((i) => deliverableState((itemEvents.get(Number(i.id)) ?? [])
        .map((e) => ({status: e.status, onDate: e.on_date}))));
      const notes = s.notes.filter((n) => Number(n.work_id) === id).map((n) => ({state: noteState((noteActions.get(Number(n.id)) ?? []).map((a) => ({result: a.result})))}));
      return {workId: id, code: w.code, title: w.title, projectTitle: w.project_title, numbers: homeNumbers(tasks, deliverables, notes, today),
        folderStatus: postFolderStatus({tasks, deliverables, notes, finalScreeningNoteOpen: false, today})};
    });
    return c.json({ok: true, today, works: rows, vocabulary});
  });

  app.get('/api/post/works/:workId', async (c) => {
    const found = await workAccess(c);
    if (found.error) return found.error;
    const today = jstToday();
    const raw = await readPostDetail(db, found.identity.org_id, found.work.id);
    return c.json({ok: true, today, work: {id: found.work.id, code: found.work.code, title: found.work.title, projectTitle: found.work.project_title},
      ...buildPostDetail(raw, today), vocabulary});
  });

  app.post('/api/post/works/:workId/cuts', (c) => guarded(c, async ({identity, work}, input) => {
    const n = normalizeCut(input);
    if (!n.ok) return invalid(c, n);
    await addCut(db, identity.org_id, work, n.value, identity.user_id);
    return c.json({ok: true}, 201);
  }));

  app.post('/api/post/works/:workId/notes', (c) => guarded(c, async ({identity, work}, input) => {
    const n = normalizeNote(input);
    if (!n.ok) return invalid(c, n);
    if (!await readCutForWork(db, identity.org_id, work.id, n.value.cutId)) return bad(c, 'その版はこの作品にありません', 400);
    await addNote(db, identity.org_id, work, n.value, identity.user_id);
    return c.json({ok: true}, 201);
  }));

  app.post('/api/post/works/:workId/notes/:noteId/actions', (c) => guarded(c, async ({identity, work}, input) => {
    const noteId = idParam(c, 'noteId');
    if (!noteId || !await readNoteForWork(db, identity.org_id, work.id, noteId)) return bad(c, 'そのメモはこの作品にありません', 404);
    const n = normalizeNoteAction(input);
    if (!n.ok) return invalid(c, n);
    if (n.value.fixedCutId != null && !await readCutForWork(db, identity.org_id, work.id, n.value.fixedCutId)) return bad(c, '直した版がこの作品にありません', 400);
    await addNoteAction(db, identity.org_id, work, noteId, n.value, identity.user_id);
    return c.json({ok: true}, 201);
  }));

  app.post('/api/post/works/:workId/tasks', (c) => guarded(c, async ({identity, work}, input) => {
    const n = normalizeTask(input);
    if (!n.ok) return invalid(c, n);
    await addTask(db, identity.org_id, work, n.value, identity.user_id);
    return c.json({ok: true}, 201);
  }));

  app.post('/api/post/works/:workId/tasks/:taskId/events', (c) => guarded(c, async ({identity, work}, input) => {
    const taskId = idParam(c, 'taskId');
    if (!taskId || !await readTaskForWork(db, identity.org_id, work.id, taskId)) return bad(c, 'そのタスクはこの作品にありません', 404);
    const n = normalizeTaskEvent(input);
    if (!n.ok) return invalid(c, n);
    await addTaskEvent(db, identity.org_id, work, taskId, n.value, jstToday(), identity.user_id);
    return c.json({ok: true}, 201);
  }));

  // 納品物の行を足す。本文は1行（{name,...}）か、まとめて（{items:[...]}）か、契約の納入物件の型から（{template:'contract'}）
  app.post('/api/post/works/:workId/deliverables', (c) => guarded(c, async ({identity, work}, input) => {
    let list;
    if (input.template === 'contract') list = CONTRACT_DELIVERABLE_TEMPLATE.map((t) => ({...t, sourceKind: 'contract'}));
    else if (Array.isArray(input.items)) list = input.items;
    else list = [input];
    if (!list.length || list.length > 200) return bad(c, '納品物の行は1〜200行で足してください', 400);
    const values = [];
    for (const item of list) {
      const n = normalizeDeliverable(item && typeof item === 'object' ? item : {});
      if (!n.ok) return invalid(c, n);
      if (n.value.salesDeliverableId != null && !await readSalesDeliverableForWork(db, identity.org_id, work.id, n.value.salesDeliverableId)) {
        return bad(c, 'その取引先への納品はこの作品にありません', 400);
      }
      values.push(n.value);
    }
    await addDeliverables(db, identity.org_id, work, values, identity.user_id);
    return c.json({ok: true, count: values.length}, 201);
  }));

  app.post('/api/post/works/:workId/deliverables/:itemId/events', (c) => guarded(c, async ({identity, work}, input) => {
    const itemId = idParam(c, 'itemId');
    if (!itemId || !await readItemForWork(db, identity.org_id, work.id, itemId)) return bad(c, 'その納品物はこの作品にありません', 404);
    const n = normalizeDeliverableEvent(input, jstToday());
    if (!n.ok) return invalid(c, n);
    await addDeliverableEvent(db, identity.org_id, work, itemId, n.value, identity.user_id);
    return c.json({ok: true}, 201);
  }));
}
