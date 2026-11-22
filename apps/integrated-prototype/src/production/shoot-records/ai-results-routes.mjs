// 撮影の結果を AI が入れる受け口（会社ルートの plans/2026-11-20-genba-inbox.md の手順7。決まりは brain の D-047 の3・4・7。移行 0069。番号は仮。
// 要件 docs/requirements/production/schedule-commit.md の FR-PROD-SCHED-103〜）。
// - POST /api/production/shoot-records/days/:dayId/ai-results  1回の取り込みの読みの束（シーンごとの独立した2回の読み）を受け、一致した行だけ撮影の結果を足す。
//   割れた行は読みの記録だけを足し、結果は足さない。同じ束の鍵の2回目は 409。作品のシーンでないものが1つでもあれば何も書かずに 400
// - GET  /api/production/shoot-records/reads/pending?workId=   要確認（いちばん新しい読みの束が割れていて、そのあとに人の結果の行が無い撮影日×シーン）
// 読める人・書ける人は撮影の記録（shoot-records-routes.mjs）と同じ。人のログインからも呼べる（止めない）。
// ホームの作業キューの「香盤の読みが割れたシーン」は scenePendingQueueItem（work-queue.mjs から呼ぶ）
import {readDay, readProjectGrant, readScenes, readWork} from './shoot-records-store.mjs';
import {addAiResults, readKeyUsed, readResultSeqs, readSceneReadSources} from './scene-reads-store.mjs';
import {derivePendingReads, normalizeAiResultsInput, planAiResults, READING_LABELS} from './ai-results-model.mjs';
import {getSourceDocument} from '../../source-documents/source-documents-store.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';

// 撮影の記録の受け口と同じ文（権限の無い作品と別の組織は、有無を見せず同じ 403）
const FORBIDDEN = 'この作品の撮影の記録への権限がありません';
const NOT_WRITER = '撮影の記録を書けるのは、管理者と、この案件に制作の権限を持つ人です';
const INPUT_ERROR = '読みの束の入力を確かめてください';
const DUPLICATE = '同じ束の鍵の読みがもうあります（二重に入れません）';
const STALE = 'ほかの画面で同じシーンの結果が足されました。読み直してください';

const positiveId = (raw) => (/^\d+$/.test(String(raw ?? '')) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null);
const ymd = (value) => String(value ?? '').replaceAll('-', '/');

// ホームの作業キューの「香盤の読みが割れたシーン」（全役割）。組織の行をまとめて読み（作品ごとに SQL を回さない）、見てよい作品（workTitle の鍵）だけを出す。
// 開く先は撮影の記録の画面の「未解決」（view=leftover）。行の workId で作品を選んで開く
export async function scenePendingQueueItem(db, orgId, {workTitle}) {
  const titles = new Map([...workTitle].map(([workId, title]) => [Number(workId), title]));
  const rows = derivePendingReads(await readSceneReadSources(db, orgId)).filter((row) => titles.has(row.workId));
  return {id: 'scene-reads-pending', title: '香盤の読みが割れたシーン', page: '撮影の記録', params: {view: 'leftover'}, tone: 'warn',
    rows: rows.map((row) => ({label: `S#${row.sceneNo}${row.location ? `・${row.location}` : ''}`,
      detail: `${titles.get(row.workId)}・${ymd(row.shootDate)}・${row.first?.label ?? '－'}／${row.second?.label ?? '－'}`, workId: row.workId}))};
}

export function registerShootAiResultRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('shoot ai result routes require app, db, bad, body and permittedProjects');
  }

  // 書けるか: 管理者、または制作担当（案件の権限が制作）・編集担当（制作か編集）。撮影の記録の受け口と同じ決まり
  async function canWrite(identity, projectId) {
    if (identity.role === 'admin') return true;
    if (!['production', 'editor'].includes(identity.role)) return false;
    const grant = await readProjectGrant(db, identity.org_id, projectId, identity.user_id, new Date().toISOString());
    if (!grant) return false;
    return identity.role === 'production' ? grant.permission === 'production' : ['production', 'edit'].includes(grant.permission);
  }

  async function workAccess(c, workId) {
    const identity = c.get('identity');
    if (!workId) return {error: bad(c, '作品の番号を確かめてください', 400)};
    const work = await readWork(db, identity.org_id, workId);
    const allowed = work ? new Set((await permittedProjects(db, identity, false)).map((row) => Number(row.id))) : new Set();
    if (!work || !allowed.has(Number(work.project_id))) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, work: {...work, id: Number(work.id), project_id: Number(work.project_id)}};
  }

  app.post('/api/production/shoot-records/days/:dayId/ai-results', async (c) => {
    const identity = c.get('identity');
    const dayId = positiveId(c.req.param('dayId'));
    if (!dayId) return bad(c, '撮影日の番号を確かめてください', 400);
    const found = await readDay(db, identity.org_id, dayId);
    if (!found) return bad(c, FORBIDDEN, 403);
    const access = await workAccess(c, Number(found.work_id));
    if (access.error) return access.error;
    if (!(await canWrite(identity, access.work.project_id))) return bad(c, NOT_WRITER, 403);
    const day = {...found, id: Number(found.id), project_id: Number(found.project_id), work_id: Number(found.work_id)};
    let raw;
    try { raw = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const n = normalizeAiResultsInput(raw);
    if (!n.ok) return bad(c, INPUT_ERROR, 400, n.errors);
    const {scenes: input, sourceDocumentId} = n.value;
    const sceneInfo = new Map((await readScenes(db, identity.org_id, day.work_id)).map((row) => [Number(row.id), row]));
    const foreign = input.flatMap((scene, index) => (sceneInfo.has(scene.sceneId) ? [] : [{scene: index, field: 'sceneId', message: 'この作品のシーンではありません'}]));
    if (foreign.length) return bad(c, INPUT_ERROR, 400, foreign);
    if (sourceDocumentId !== null && !(await getSourceDocument(db, identity.org_id, sourceDocumentId))) {
      return bad(c, INPUT_ERROR, 400, [{scene: null, field: 'sourceDocumentId', message: '香盤の原本を組織の原本から選んでください'}]);
    }
    const readKey = n.value.readKey ?? `srr-${crypto.randomUUID()}`;
    if (await readKeyUsed(db, identity.org_id, readKey)) return bad(c, DUPLICATE, 409, {readKey});
    const seqs = await readResultSeqs(db, identity.org_id, day.id);
    const scenes = input.map((scene) => ({...scene, priorSeq: seqs.get(scene.sceneId) ?? 0}));
    const plan = planAiResults(scenes);
    try {
      await addAiResults(db, {orgId: identity.org_id, day, userId: identity.user_id, readKey, sourceDocumentId, scenes, agreed: plan.agreed});
    } catch (error) {
      if (isUniqueViolation(error, 'shooting_scene_reads') || isUniqueViolation(error, 'shooting_scene_result_reads')) return bad(c, DUPLICATE, 409, {readKey}, error);
      if ((dbErrorKind(error) === 'raise' && /stale shooting/.test(error.message)) || isUniqueViolation(error, 'shooting_scene_results')) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
    const sceneNo = (sceneId) => sceneInfo.get(sceneId)?.scene_no ?? '';
    const read = (value) => ({model: value.model, reading: value.reading, label: READING_LABELS[value.reading]});
    return c.json({ok: true, dayId: day.id, readKey,
      added: plan.agreed.map((row) => ({sceneId: row.sceneId, sceneNo: sceneNo(row.sceneId), reading: row.reading, result: row.result})),
      split: plan.split.map((row) => ({sceneId: row.sceneId, sceneNo: sceneNo(row.sceneId), first: read(row.first), second: read(row.second)})),
      counts: {scenes: scenes.length, added: plan.agreed.length, split: plan.split.length}}, 201);
  });

  app.get('/api/production/shoot-records/reads/pending', async (c) => {
    const found = await workAccess(c, positiveId(c.req.query('workId')));
    if (found.error) return found.error;
    const {identity, work} = found;
    const rows = derivePendingReads(await readSceneReadSources(db, identity.org_id, work.id));
    return c.json({ok: true, work: {id: work.id, code: work.code, title: work.title}, rows, count: rows.length});
  });
}
