// 制作の実費の行の受け口（会社ルートの plans/2026-11-20-genba-inbox.md の手順8。決まりは brain の D-047 の3・7。
// 要件 docs/requirements/expenses/production-cost.md の FR-EXP-PCOST-009・010・033・036・043〜046）。
//   GET  /api/expenses/works/:workId/actual-lines                    いまの行・未確認の印・合計（?from=&to=&shootingDayId= で絞る）
//   POST /api/expenses/works/:workId/actual-lines                    行を足す（1〜50行。人・AI の別と、AI の行は読みの記録）
//   POST /api/expenses/works/:workId/actual-lines/:lineId/void       取り消す（理由つき。置き換えの行を同時に足せる）
//   POST /api/expenses/works/:workId/actual-lines/checks             まとめて確かめる（取消済み・確認済みは飛ばして数を返す）
// 読めるのは管理者と、作品の案件の編集の権限を持つ編集担当。書けるのは、いまは管理者だけ（作品ごとの役目の表が入ってから広げる）。
// 制作担当には返さない。権限の無い作品と別の組織の作品は、有無を見せず同じ 403 にする。精算・会計へ出す数字はここでは作らない
// サービストークン（AI）の呼び出し（identity.via が service_token。FR-CORE-DATA-066）は、入れ方が ai の行だけを足せ（取消の置き換えの行も同じ）、
// まとめて確認は 403（FR-EXP-PCOST-047。D-047 の7 を本文の名乗りでなく呼び出しの経路で守る）
import {addActualLines, checkActualLines, readActualLineRecords, readPartnerIds, readUsedEntryKeys, readWork, readWorkShootingDayIds,
  voidActualLine} from '../expenses-store.mjs';
import {getSourceDocument} from '../../source-documents/source-documents-store.mjs';
import {actualLinesAccess, buildActualLinesView, humanLineErrors, normalizeActualLinesBatch, normalizeActualLinesQuery, normalizeCheckInput, normalizeVoidInput,
  planActualLineChecks} from './actual-lines-model.mjs';
import {todayJst} from '../../billing/receipt-model.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';

const FORBIDDEN = 'この作品の実費への権限がありません';
const NOT_WRITER = '実費の行を書けるのは、いまは管理者だけです';
const NOT_PERSON = '確認は、人が画面から行います';
const INPUT_ERROR = '実費の行の入力を確かめてください';
const DUPLICATE = '同じ取り込みの鍵の行がもうあります（二重に入れません）';
const STALE = '読んだあとにほかの画面が実費の行を変えました。読み直してください';
// 移行 0068 のトリガーの文（取消した行の確認・取消した行での置き換え）。読んだあとの取消と重なったときに断られる
const VOIDED_RACE = /voided production actual line/;

export function registerActualLineRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('actual line routes require app, db, bad, body and permittedProjects');
  }

  async function workAccess(c) {
    const identity = c.get('identity');
    const raw = c.req.param('workId');
    const workId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(workId) || workId <= 0) return {error: bad(c, '作品の番号を確かめてください', 400)};
    const work = await readWork(db, identity.org_id, workId);
    const financeProjects = identity.role === 'production' ? [] : (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
    const access = actualLinesAccess({role: identity.role, financeProject: Boolean(work) && financeProjects.includes(Number(work.project_id)), via: identity.via ?? null});
    if (!work || !access.read) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, work: {...work, id: Number(work.id), project_id: Number(work.project_id)}, access};
  }

  async function writer(c) {
    const found = await workAccess(c);
    if (found.error) return found;
    if (!found.access.write) return {error: bad(c, NOT_WRITER, 403)};
    try {
      const input = await body(c);
      return {...found, input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }

  // 行が指す取引先・原本・撮影日が、組織の中（撮影日は同じ作品）にあるか。無い参照の誤り（行の位置つき）を返す
  async function referenceErrors(orgId, workId, lines, at = (index) => ({line: index})) {
    const ids = (field) => [...new Set(lines.map((line) => line[field]).filter((id) => id !== null))];
    const partners = new Set(await readPartnerIds(db, orgId, ids('payeePartnerId')));
    const days = new Set(await readWorkShootingDayIds(db, orgId, workId, ids('shootingDayId')));
    const documents = new Set();
    for (const id of ids('sourceDocumentId')) if (await getSourceDocument(db, orgId, id)) documents.add(id);
    const errors = [];
    for (const [index, line] of lines.entries()) {
      if (line.payeePartnerId !== null && !partners.has(line.payeePartnerId)) errors.push({...at(index), field: 'payeePartnerId', message: '支払先を組織の取引先から選んでください'});
      if (line.sourceDocumentId !== null && !documents.has(line.sourceDocumentId)) errors.push({...at(index), field: 'sourceDocumentId', message: '証憑を組織の原本から選んでください'});
      if (line.shootingDayId !== null && !days.has(line.shootingDayId)) errors.push({...at(index), field: 'shootingDayId', message: '撮影日をこの作品の撮影日から選んでください'});
    }
    return errors;
  }

  // 取り込みの鍵: 送られなければここで作る（同じ batch の中で行を引けるように、組織で一意の鍵をどの行にも持たせる）
  const withEntryKey = (line) => ({...line, entryKey: line.entryKey ?? `pal-${crypto.randomUUID()}`});

  app.get('/api/expenses/works/:workId/actual-lines', async (c) => {
    const found = await workAccess(c);
    if (found.error) return found.error;
    const {identity, work, access} = found;
    const query = normalizeActualLinesQuery({from: c.req.query('from'), to: c.req.query('to'), shootingDayId: c.req.query('shootingDayId')});
    if (!query.ok) return bad(c, '絞り込みを確かめてください', 400, query.errors);
    const records = await readActualLineRecords(db, identity.org_id, work.id);
    const view = buildActualLinesView({...records, today: todayJst(), filter: query.value});
    return c.json({ok: true, workId: work.id, workCode: work.code, canWrite: access.write, canCheck: access.check, ...view});
  });

  app.post('/api/expenses/works/:workId/actual-lines', async (c) => {
    const found = await writer(c);
    if (found.error) return found.error;
    const {identity, work, input, access} = found;
    const n = normalizeActualLinesBatch(input);
    if (!n.ok) return bad(c, INPUT_ERROR, 400, n.errors);
    const notAi = humanLineErrors(n.values, access);
    if (notAi.length) return bad(c, INPUT_ERROR, 400, notAi);
    const refs = await referenceErrors(identity.org_id, work.id, n.values);
    if (refs.length) return bad(c, INPUT_ERROR, 400, refs);
    const lines = n.values.map(withEntryKey);
    const used = await readUsedEntryKeys(db, identity.org_id, lines.map((line) => line.entryKey));
    if (used.length) return bad(c, DUPLICATE, 409, {entryKeys: used.sort()});
    try {
      const ids = await addActualLines(db, identity.org_id, work, lines, {createdBy: identity.user_id});
      return c.json({ok: true, workId: work.id, lineIds: ids, entryKeys: lines.map((line) => line.entryKey)}, 201);
    } catch (error) {
      if (isUniqueViolation(error, 'production_actual_lines')) return bad(c, DUPLICATE, 409, undefined, error);
      throw error;
    }
  });

  app.post('/api/expenses/works/:workId/actual-lines/checks', async (c) => {
    const found = await writer(c);
    if (found.error) return found.error;
    const {identity, work, input, access} = found;
    if (!access.check) return bad(c, NOT_PERSON, 403);
    const n = normalizeCheckInput(input);
    if (!n.ok) return bad(c, INPUT_ERROR, 400, n.errors);
    const plan = planActualLineChecks({lineIds: n.value.lineIds, ...await readActualLineRecords(db, identity.org_id, work.id)});
    if (plan.missing.length) return bad(c, 'この作品の行ではない番号があります', 400, {lineIds: plan.missing});
    try {
      const checked = plan.toCheck.length ? await checkActualLines(db, identity.org_id, work.id, plan.toCheck, {checkedBy: identity.user_id}) : 0;
      return c.json({ok: true, workId: work.id, checked, skipped: {voided: plan.voided.length, alreadyChecked: plan.alreadyChecked.length + plan.toCheck.length - checked}});
    } catch (error) {
      if (dbErrorKind(error) === 'raise' && VOIDED_RACE.test(error.message)) return bad(c, STALE, 409, undefined, error);
      throw error;
    }
  });

  app.post('/api/expenses/works/:workId/actual-lines/:lineId/void', async (c) => {
    const found = await writer(c);
    if (found.error) return found.error;
    const {identity, work, input, access} = found;
    const raw = c.req.param('lineId');
    const lineId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(lineId) || lineId <= 0) return bad(c, '行の番号を確かめてください', 400);
    const n = normalizeVoidInput(input);
    if (!n.ok) return bad(c, INPUT_ERROR, 400, n.errors);
    const records = await readActualLineRecords(db, identity.org_id, work.id);
    if (!records.lines.some((row) => Number(row.id) === lineId)) return bad(c, 'この作品の行ではありません', 404);
    if (records.voids.some((row) => Number(row.line_id) === lineId)) return bad(c, 'この行はもう取り消してあります', 409);
    let replacement = null;
    if (n.value.replacement) {
      const notAi = humanLineErrors([n.value.replacement], access, () => ({})).map((error) => ({...error, field: 'replacement.entryMethod'}));
      if (notAi.length) return bad(c, INPUT_ERROR, 400, notAi);
      const refs = await referenceErrors(identity.org_id, work.id, [n.value.replacement], () => ({}));
      if (refs.length) return bad(c, INPUT_ERROR, 400, refs.map((error) => ({...error, field: `replacement.${error.field}`})));
      replacement = withEntryKey(n.value.replacement);
      if ((await readUsedEntryKeys(db, identity.org_id, [replacement.entryKey])).length) return bad(c, DUPLICATE, 409, {entryKeys: [replacement.entryKey]});
    }
    try {
      const replacementLineId = await voidActualLine(db, identity.org_id, work, lineId, {reason: n.value.reason, replacement}, {createdBy: identity.user_id});
      return c.json({ok: true, workId: work.id, lineId, replacementLineId}, 201);
    } catch (error) {
      if (isUniqueViolation(error, 'production_actual_line_voids')) return bad(c, 'この行はもう取り消してあります', 409, undefined, error);
      if (isUniqueViolation(error, 'production_actual_lines')) return bad(c, DUPLICATE, 409, undefined, error);
      throw error;
    }
  });
}
