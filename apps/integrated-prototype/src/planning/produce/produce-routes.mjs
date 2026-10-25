// プロデュース管理の進行表の受け口（要件 docs/requirements/planning/produce-progress.md。移行 0047）。
// 読めるのは案件を見られる人。書けるのは案件の編集の権限を持つ人（管理者を含む）。権限の無い案件と別の組織の案件は、有無を見せず同じ 403 にする。
// 金額は扱わない。状態は列に持たず、予定と記録から導く（produce-model.mjs）
import {STANDARD_TEMPLATE, PHASES, ROLES, KINDS, MILESTONES, boardSummary, isDate, latestTasks, normalizeLink, normalizeTaskInput, taskState,
  tasksFromTemplate, templateFromTasks} from './produce-model.mjs';
import {addCheck, addEvent, addLink, addPost, addTaskVersion, addTasks, addTemplate, nextTaskUid, readChecks, readEvents, readLinks, readPosts,
  readProduceProject, readProjectWorks, readProjectsByIds, readTaskHistory, readTaskVersions, readTemplates} from './produce-store.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';

const FORBIDDEN = 'この案件の進行表への権限がありません';
const STALE_MESSAGE = 'ほかの画面で進行表が変わりました。読み直してください';
const STALE = /stale produce (task|template)/;
const lostRace = (error, table) => (dbErrorKind(error) === 'raise' && STALE.test(error.message)) || isUniqueViolation(error, table);
const todayIso = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const MAX_TEMPLATE_TASKS = 300;

export function registerProduceRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('produce routes require app, db, bad, body and permittedProjects');
  }

  async function projectAccess(c, {write = false} = {}) {
    const identity = c.get('identity');
    const raw = c.req.param('projectId');
    const projectId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(projectId) || projectId <= 0) return {error: bad(c, '案件の番号を確かめてください', 400)};
    const [project, allowed] = await Promise.all([readProduceProject(db, identity.org_id, projectId), permittedProjects(db, identity, write)]);
    if (!project || !allowed.some((row) => Number(row.id) === projectId)) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, project: {...project, id: projectId}};
  }

  async function readBody(c) {
    try {
      const input = await body(c);
      return {input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }

  async function taskAccess(c) {
    const found = await projectAccess(c, {write: true});
    if (found.error) return found;
    const uid = Number(c.req.param('taskUid'));
    if (!Number.isSafeInteger(uid) || uid <= 0) return {error: bad(c, 'チケットの番号を確かめてください', 400)};
    const history = await readTaskHistory(db, found.identity.org_id, found.project.id, uid);
    if (!history.length) return {error: bad(c, 'そのチケットはありません', 404)};
    return {...found, uid, history, current: history.at(-1)};
  }

  function boardOf(tasks, events, today) {
    const states = {};
    for (const t of tasks) states[t.taskUid] = taskState(t, events.filter((e) => e.taskUid === t.taskUid), today);
    return {states, summary: boardSummary(tasks, states, today)};
  }

  // 案件の一覧（見てよい案件ごとに、チケットの数・遅れ・次のチェック・初号と納品）
  app.get('/api/produce/projects', async (c) => {
    const identity = c.get('identity');
    const ids = (await permittedProjects(db, identity, false)).map((p) => Number(p.id));
    const [projects, versions, events] = await Promise.all([readProjectsByIds(db, identity.org_id, ids), readTaskVersions(db, identity.org_id, ids),
      readEvents(db, identity.org_id, ids)]);
    const today = todayIso();
    const tasks = latestTasks(versions);
    return c.json({ok: true, today, projects: projects.map((p) => {
      const id = Number(p.id);
      const own = tasks.filter((t) => t.projectId === id);
      const {summary} = boardOf(own, events.filter((e) => e.projectId === id), today);
      return {id, code: p.code, title: p.title, status: p.status, taskCount: own.length, summary};
    })});
  });

  // 案件の進行表の全体（チケット・状態・記録・チェック項目・掲示板・関連する場所・作品・上の箱）
  app.get('/api/produce/projects/:projectId', async (c) => {
    const found = await projectAccess(c);
    if (found.error) return found.error;
    const {identity, project} = found;
    const orgId = identity.org_id;
    const [versions, events, checks, posts, links, works, writable] = await Promise.all([readTaskVersions(db, orgId, [project.id]), readEvents(db, orgId, [project.id]),
      readChecks(db, orgId, project.id), readPosts(db, orgId, project.id), readLinks(db, orgId, project.id), readProjectWorks(db, orgId, project.id),
      permittedProjects(db, identity, true)]);
    const today = todayIso();
    const tasks = latestTasks(versions);
    const {states, summary} = boardOf(tasks, events, today);
    const latestBy = (rows, key) => { const m = new Map(); for (const r of rows) m.set(`${r.taskUid}:${r[key]}`, r); return [...m.values()]; };
    return c.json({ok: true, today, project: {id: project.id, code: project.code, title: project.title},
      canEdit: writable.some((row) => Number(row.id) === project.id),
      works: works.map((w) => ({id: Number(w.id), code: w.code, title: w.title})),
      tasks: tasks.map((t) => ({...t, state: states[t.taskUid]})).sort((a, b) => a.plannedStart.localeCompare(b.plannedStart) || a.taskUid - b.taskUid),
      events, checks: latestBy(checks, 'checkUid'), posts, links: latestBy(links, 'linkUid').filter((l) => !l.removed), summary,
      vocab: {phases: PHASES, roles: ROLES, kinds: KINDS, milestones: MILESTONES}});
  });

  // チケットを足す（FR-PLAN-PRODUCE-002）
  app.post('/api/produce/projects/:projectId/tasks', async (c) => {
    const found = await projectAccess(c, {write: true});
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const works = await readProjectWorks(db, found.identity.org_id, found.project.id);
    const normalized = normalizeTaskInput(read.input, {workIds: works.map((w) => Number(w.id))});
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
    const links = [];
    for (const raw of Array.isArray(read.input.links) ? read.input.links : []) {
      const link = normalizeLink(raw);
      if (!link.ok) return bad(c, link.errors.join('／'), 400);
      links.push(link.value);
    }
    try {
      const firstUid = await nextTaskUid(db, found.identity.org_id);
      const [uid] = await addTasks(db, found.identity.org_id, found.project.id, [{...normalized.value, links}], {createdBy: found.identity.user_id, firstUid});
      return c.json({ok: true, taskUid: uid}, 201);
    } catch (error) {
      if (lostRace(error, 'produce_tasks')) return bad(c, STALE_MESSAGE, 409);
      throw error;
    }
  });

  // チケットを直す・やめる（新しい版を足す。理由は必須。FR-PLAN-PRODUCE-003）
  app.post('/api/produce/projects/:projectId/tasks/:taskUid/versions', async (c) => {
    const found = await taskAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const reason = String(read.input.reason ?? '').trim();
    if (!reason || reason.length > 500) return bad(c, '直す理由を入れてください（500字まで）', 400);
    if (Number(read.input.baseVersionNo) !== found.current.versionNo) return bad(c, STALE_MESSAGE, 409);
    const works = await readProjectWorks(db, found.identity.org_id, found.project.id);
    const merged = {...found.current, ...read.input};
    const normalized = normalizeTaskInput(merged, {workIds: works.map((w) => Number(w.id))});
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
    const versionNo = found.current.versionNo + 1;
    try {
      await addTaskVersion(db, found.identity.org_id, found.project.id, found.uid, versionNo,
        {...normalized.value, templateLabel: found.current.templateLabel, retired: read.input.retired === true, reason}, {createdBy: found.identity.user_id});
    } catch (error) {
      if (lostRace(error, 'produce_tasks')) return bad(c, STALE_MESSAGE, 409);
      throw error;
    }
    return c.json({ok: true, taskUid: found.uid, versionNo}, 201);
  });

  // 着手・完了・戻す（FR-PLAN-PRODUCE-004）
  app.post('/api/produce/projects/:projectId/tasks/:taskUid/events', async (c) => {
    const found = await taskAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const kind = ['started', 'done', 'reopened'].includes(read.input.kind) ? read.input.kind : null;
    if (!kind) return bad(c, '着手・完了・戻すのどれかを選んでください', 400);
    const onDate = read.input.onDate || todayIso();
    if (!isDate(onDate)) return bad(c, '日を確かめてください', 400);
    const note = String(read.input.note ?? '').trim().slice(0, 500) || null;
    await addEvent(db, found.identity.org_id, found.project.id, found.uid, {kind, onDate, note}, {createdBy: found.identity.user_id});
    return c.json({ok: true}, 201);
  });

  // チェック項目（足す・チェックを入れる・外す。FR-PLAN-PRODUCE-006）
  app.post('/api/produce/projects/:projectId/tasks/:taskUid/checks', async (c) => {
    const found = await taskAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const orgId = found.identity.org_id;
    const existing = (await readChecks(db, orgId, found.project.id)).filter((x) => x.taskUid === found.uid);
    let checkUid = read.input.checkUid == null ? null : Number(read.input.checkUid);
    let label = String(read.input.label ?? '').trim();
    if (checkUid != null) {
      const prior = existing.filter((x) => x.checkUid === checkUid).at(-1);
      if (!prior) return bad(c, 'そのチェック項目はありません', 404);
      label = label || prior.label;
    } else {
      if (!label || label.length > 200) return bad(c, 'チェック項目を入れてください（200字まで）', 400);
      checkUid = existing.reduce((m, x) => Math.max(m, x.checkUid), 0) + 1;
    }
    await addCheck(db, orgId, found.project.id, found.uid, {checkUid, label, checked: read.input.checked === true}, {createdBy: found.identity.user_id});
    return c.json({ok: true, checkUid}, 201);
  });

  // 掲示板に書く（FR-PLAN-PRODUCE-006）
  app.post('/api/produce/projects/:projectId/tasks/:taskUid/posts', async (c) => {
    const found = await taskAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const speakerLabel = String(read.input.speakerLabel ?? '').trim();
    const text = String(read.input.body ?? '').trim();
    if (!speakerLabel || speakerLabel.length > 40) return bad(c, '誰の書き込みかを入れてください（40字まで）', 400);
    if (!text || text.length > 2000) return bad(c, '書き込みを入れてください（2000字まで）', 400);
    await addPost(db, found.identity.org_id, found.project.id, found.uid, {speakerLabel, body: text}, {createdBy: found.identity.user_id});
    return c.json({ok: true}, 201);
  });

  // 関連する場所を足す・外す（FR-PLAN-PRODUCE-009）
  app.post('/api/produce/projects/:projectId/tasks/:taskUid/links', async (c) => {
    const found = await taskAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const orgId = found.identity.org_id;
    const existing = (await readLinks(db, orgId, found.project.id)).filter((x) => x.taskUid === found.uid);
    if (read.input.remove === true) {
      const prior = existing.filter((x) => x.linkUid === Number(read.input.linkUid)).at(-1);
      if (!prior || prior.removed) return bad(c, 'そのリンクはありません', 404);
      await addLink(db, orgId, found.project.id, found.uid, prior.linkUid, prior, {createdBy: found.identity.user_id, removed: true});
      return c.json({ok: true}, 201);
    }
    const link = normalizeLink(read.input);
    if (!link.ok) return bad(c, link.errors.join('／'), 400);
    const linkUid = existing.reduce((m, x) => Math.max(m, x.linkUid), 0) + 1;
    await addLink(db, orgId, found.project.id, found.uid, linkUid, link.value, {createdBy: found.identity.user_id});
    return c.json({ok: true, linkUid}, 201);
  });

  // テンプレートの一覧（標準の進行と、組織で残したもの。FR-PLAN-PRODUCE-007）
  app.get('/api/produce/templates', async (c) => {
    const identity = c.get('identity');
    const saved = await readTemplates(db, identity.org_id);
    return c.json({ok: true, templates: [{...STANDARD_TEMPLATE, builtIn: true}, ...saved.map((t) => ({...t, builtIn: false}))]});
  });

  // テンプレートを当てる。本文は {templateId: 'standard'|番号, anchorDate, workId}
  app.post('/api/produce/projects/:projectId/apply-template', async (c) => {
    const found = await projectAccess(c, {write: true});
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const orgId = found.identity.org_id;
    const id = read.input.templateId;
    const template = id === 'standard' || id == null ? STANDARD_TEMPLATE : (await readTemplates(db, orgId)).find((t) => t.id === Number(id));
    if (!template) return bad(c, 'そのテンプレートはありません', 404);
    const built = tasksFromTemplate(template, read.input.anchorDate);
    if (!built.ok) return bad(c, built.errors.join('／'), 400);
    const works = await readProjectWorks(db, orgId, found.project.id);
    const workId = read.input.workId == null || read.input.workId === '' ? null : Number(read.input.workId);
    if (workId != null && !works.some((w) => Number(w.id) === workId)) return bad(c, '作品を確かめてください', 400);
    try {
      const firstUid = await nextTaskUid(db, orgId);
      const uids = await addTasks(db, orgId, found.project.id, built.tasks.map((t) => ({...t, workId})), {createdBy: found.identity.user_id, firstUid, action: 'apply_template'});
      return c.json({ok: true, created: uids.length}, 201);
    } catch (error) {
      if (lostRace(error, 'produce_tasks')) return bad(c, STALE_MESSAGE, 409);
      throw error;
    }
  });

  // この案件の進行をテンプレートとして残す。本文は {name}
  app.post('/api/produce/projects/:projectId/save-template', async (c) => {
    const found = await projectAccess(c, {write: true});
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const name = String(read.input.name ?? '').trim();
    if (!name || name.length > 120) return bad(c, 'テンプレートの名前を入れてください（120字まで）', 400);
    const orgId = found.identity.org_id;
    const tasks = latestTasks(await readTaskVersions(db, orgId, [found.project.id]));
    if (!tasks.length) return bad(c, 'チケットが無いので残せません', 400);
    if (tasks.length > MAX_TEMPLATE_TASKS) return bad(c, `チケットが多すぎます（${MAX_TEMPLATE_TASKS}件まで）`, 400);
    const links = (await readLinks(db, orgId, found.project.id));
    const latest = new Map(); for (const l of links) latest.set(`${l.taskUid}:${l.linkUid}`, l);
    const byTask = {}; for (const l of latest.values()) if (!l.removed) (byTask[l.taskUid] ??= []).push(l);
    const tpl = templateFromTasks(tasks, byTask);
    try {
      const uid = await addTemplate(db, orgId, {name, anchorKind: tpl.anchorKind, items: tpl.items}, {createdBy: found.identity.user_id});
      return c.json({ok: true, templateId: uid, items: tpl.items.length}, 201);
    } catch (error) {
      if (lostRace(error, 'produce_task_templates')) return bad(c, STALE_MESSAGE, 409);
      throw error;
    }
  });
}
