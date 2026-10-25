// 企画の受け口（移行 0025。会社ルートの plans/2026-10-22-folder-kikaku.md、要件 docs/requirements/planning/kikaku.md）。
// 試算と判断の数字を含むので、読めるのは案件の財務の権限のある人（管理者と、案件の編集の権限を持つ編集担当）。制作担当には見せない。
// 権限の無い案件と別の組織の案件は、有無を見せず同じ 403 にする。版は追加だけで、前の版は消さない。
// 原本は共通の原本の置き場（source_documents）に1回だけ置き、クラウドでは本体が R2 に入る（src/cloud-r2-db.mjs）
import {computeTrial, deckBoard, normalizeFactInput, normalizeMaterialInput, normalizeProfileInput, normalizeTrialInput, readiness, templateTrial,
  SCENARIOS, TRIAL_TYPES} from './kikaku-model.mjs';
import {addFact, addMaterial, addOwnerVersion, addProfileVersion, addTrialVersion, createKikakuProject, hasPlanningDocument, isActiveMember, linkPlanningDocument, putSourceDocument,
  readDocumentForProject, readFact, readListRows, readProject, readProjectDetailRows, readProjectsByIds, readStages, readTrialParts} from './kikaku-store.mjs';
import {normalizeStageChange} from '../project/project-model.mjs';
import {recordStageChange, listEarningTypes} from '../planning-store.mjs';
import {readBudgetFixes, readBudgetLines, readBudgetVersions} from '../budget/budget-store.mjs';
import {budgetTotals, currentFixedVersionNo} from '../budget/budget-model.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';
import {getSourceDocument, MAX_INLINE_BYTES, SourceDocumentError} from '../../source-documents/source-documents-store.mjs';

const FORBIDDEN = 'この案件の企画への権限がありません';
const STALE = 'ほかの画面で先に版が足されました。読み直してください';
// 原本の上限は共通の原本の表の inline の上限（12MB。クラウドでは R2 から戻すときの上限 16MB に base64 で収まる大きさ）
export const MAX_DOCUMENT_BYTES = MAX_INLINE_BYTES;
const today = () => new Date().toISOString().slice(0, 10);
const lostRace = (error) => (dbErrorKind(error) === 'raise' && /stale (planning|project owner)/.test(error.message)) || isUniqueViolation(error);

function base64Bytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const rateRow = (r) => ({typeCode: r.type_code, shareBps: Number(r.share_bps), feeBps: Number(r.fee_bps), originalBps: Number(r.original_royalty_bps),
  creatorBps: Number(r.creator_royalty_bps), unitCostYen: Number(r.unit_cost_yen), source: r.source});
const lineRow = (l) => ({lineNo: Number(l.line_no), typeCode: l.type_code, partnerName: l.partner_name, windowLabel: l.window_label, startMonth: l.start_month,
  months: Number(l.months), calc: l.calc, unitPriceYen: Number(l.unit_price_yen), evenValue: Number(l.even_value), goodValue: Number(l.good_value), maxValue: Number(l.max_value),
  source: l.source, previousSalesYen: l.previous_sales_yen == null ? null : Number(l.previous_sales_yen)});
const investRow = (i) => ({seq: Number(i.seq), month: i.month, amountYen: Number(i.amount_yen)});

function trialFrom(version, parts) {
  const id = Number(version.id);
  const input = {costTotalYen: Number(version.cost_total_yen), firstMonth: version.first_month,
    rates: parts.rates.filter((r) => Number(r.version_id) === id).map(rateRow),
    lines: parts.lines.filter((l) => Number(l.version_id) === id).map(lineRow),
    investments: parts.investments.filter((i) => Number(i.version_id) === id).map(investRow)};
  return {input, result: computeTrial(input)};
}

function budgetFixedFrom(fixRows) {
  const fixes = fixRows.map((f) => ({seq: Number(f.seq), action: f.action, versionNo: Number(f.version_no), createdAt: f.created_at}));
  const no = currentFixedVersionNo(fixes);
  if (no == null) return null;
  const last = [...fixes].sort((a, b) => a.seq - b.seq).at(-1);
  return {versionNo: no, fixedOn: String(last?.createdAt ?? '').slice(0, 10)};
}

export function registerKikakuRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('kikaku routes require app, db, bad, body and permittedProjects');
  }

  async function financeIds(identity) {
    if (identity.role === 'production') return [];
    return (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
  }
  async function projectAccess(c) {
    const identity = c.get('identity');
    const raw = c.req.param('projectId');
    const projectId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(projectId) || projectId <= 0) return {error: bad(c, '案件の番号を確かめてください', 400)};
    const [project, ids] = await Promise.all([readProject(db, identity.org_id, projectId), financeIds(identity)]);
    if (!project || !ids.includes(projectId)) return {error: bad(c, FORBIDDEN, 403)};
    return {identity, projectId, project};
  }
  async function readBody(c) {
    try {
      const input = await body(c);
      return {input: input && typeof input === 'object' && !Array.isArray(input) ? input : {}};
    } catch (error) {
      return {error: bad(c, error.message, 400, undefined, error)};
    }
  }
  const invalid = (c, errors) => c.json({ok: false, error: errors[0]?.message ?? '入力を確かめてください', errors}, 400);

  // 一覧: 案件ごとの判定の1行・4つのマス・段階・担当・企画の項目・good の回収率
  app.get('/api/planning/kikaku', async (c) => {
    const identity = c.get('identity');
    if (identity.role === 'production') return bad(c, FORBIDDEN, 403);
    const ids = await financeIds(identity);
    const [projects, rows] = await Promise.all([readProjectsByIds(db, identity.org_id, ids), readListRows(db, identity.org_id, ids)]);
    const latestTrialIds = [];
    const trialsBy = new Map();
    for (const t of rows.trials) { const pid = Number(t.project_id); if (!trialsBy.has(pid)) trialsBy.set(pid, []); trialsBy.get(pid).push(t); }
    for (const list of trialsBy.values()) latestTrialIds.push(Number(list.at(-1).id));
    const parts = await readTrialParts(db, identity.org_id, latestTrialIds);
    const items = projects.map((p) => {
      const pid = Number(p.id);
      const stage = rows.stages.find((s) => Number(s.project_id) === pid) ?? null;
      const profile = rows.profiles.find((s) => Number(s.project_id) === pid) ?? null;
      const trials = (trialsBy.get(pid) ?? []).map((t) => ({createdAt: t.created_at}));
      const latest = trialsBy.get(pid)?.at(-1) ?? null;
      const trial = latest ? trialFrom(latest, parts) : null;
      const owners = rows.owners.filter((o) => Number(o.project_id) === pid && o.started_on <= today());
      const owner = owners.at(-1) ?? null;
      const ready = readiness({
        documents: rows.documents.filter((d) => Number(d.project_id) === pid).map((d) => ({kind: d.kind, role: d.role, submittedOn: d.submitted_on})),
        trialVersions: trials, budgetFixed: budgetFixedFrom(rows.fixes.filter((f) => Number(f.project_id) === pid)),
        approvals: rows.approvals.filter((a) => Number(a.project_id) === pid).map((a) => ({status: a.status, at: a.created_at})),
        stageCode: stage?.stage_code ?? null, stageEnteredOn: stage?.entered_on ?? null,
      });
      return {id: pid, code: p.code, title: p.title, status: p.status, workingTitle: profile?.working_title ?? p.title, origin: profile?.origin ?? null,
        episodeCount: profile?.episode_count ?? null, plannedReleaseYear: profile?.planned_release_year ?? null,
        stage: stage ? {code: stage.stage_code, label: stage.label} : null, owner: owner ? {userId: Number(owner.user_id), name: owner.display_name} : null,
        costTotalYen: trial ? trial.input.costTotalYen : null, recoveryBps: trial ? trial.result.totals.good.recoveryBps : null, readiness: ready};
    });
    return c.json({ok: true, items, me: identity.user_id});
  });

  // 案件を作る（企画として）。企画の項目の最初の版も同時に入れられる
  app.post('/api/planning/kikaku/projects', async (c) => {
    const identity = c.get('identity');
    if (identity.role === 'production') return bad(c, FORBIDDEN, 403);
    const {input, error} = await readBody(c); if (error) return error;
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const errors = [];
    if (!code || code.length > 40) errors.push({field: 'code', message: '案件コードを1〜40字で入れてください'});
    if (!title || title.length > 200) errors.push({field: 'title', message: '題名（作業題）を1〜200字で入れてください'});
    const earningTypes = await listEarningTypes(db);
    const earningType = input.earningType ?? 'own_investment';
    const earning = earningTypes.find((e) => e.code === earningType && e.project_type === 'production');
    if (!earning) errors.push({field: 'earningType', message: '稼ぎ方は 自社出資・製作委員会 のどちらかです'});
    let profile = null;
    if (input.profile) {
      const n = normalizeProfileInput({...input.profile, workingTitle: input.profile.workingTitle ?? title, reason: input.profile.reason ?? '最初の版'});
      if (!n.ok) errors.push(...n.errors); else profile = n.value;
    }
    if (errors.length) return invalid(c, errors);
    const stages = await readStages(db);
    const project = {code, title, projectType: 'production', earningType, counterpartyName: typeof input.counterpartyName === 'string' && input.counterpartyName.trim() ? input.counterpartyName.trim().slice(0, 200) : null,
      planningFolder: null, note: null, stage: stages.some((s) => s.code === 'memo') ? {code: 'memo', enteredOn: today(), reason: null} : null};
    try {
      const id = await createKikakuProject(db, identity, project, {profile, today: today()});
      return c.json({ok: true, id}, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return bad(c, 'この案件コードは使われています', 409);
      throw e;
    }
  });

  // 1件のまとめ: 項目・体制・試算（最新の版の計算と、版の一覧）・原本・段階・担当・揃い・準備ボード
  app.get('/api/planning/kikaku/:projectId', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {identity, projectId, project} = access;
    const orgId = identity.org_id;
    const [rows, stages, budgetVersions, budgetFixRows] = await Promise.all([readProjectDetailRows(db, orgId, projectId), readStages(db),
      readBudgetVersions(db, orgId, projectId), readBudgetFixes(db, orgId, projectId)]);
    const trialIds = rows.trials.map((t) => Number(t.id));
    const parts = await readTrialParts(db, orgId, trialIds);
    const wanted = Number(c.req.query('trial') || 0);
    const latest = rows.trials.find((t) => Number(t.revision) === wanted) ?? rows.trials.at(-1) ?? null;
    const trial = latest ? {revision: Number(latest.revision), reason: latest.reason, createdAt: latest.created_at, sourceKind: latest.source_kind, ...trialFrom(latest, parts)} : null;
    const versionSummaries = rows.trials.map((t) => {
      const r = trialFrom(t, parts).result;
      return {revision: Number(t.revision), reason: t.reason, createdAt: t.created_at, recovery: Object.fromEntries(SCENARIOS.map((s) => [s, r.totals[s].recoveryBps]))};
    });
    const fixed = budgetFixedFrom(budgetFixRows);
    let budget = null;
    if (fixed) {
      const v = budgetVersions.find((x) => Number(x.version_no) === fixed.versionNo);
      const lines = (await readBudgetLines(db, orgId, v.id)).map((l) => ({categoryCode: l.category_code, amountExTaxYen: Number(l.amount_ex_tax_yen)}));
      const t = budgetTotals({lines, managementFeeYen: Number(v.management_fee_yen), contingencyYen: Number(v.contingency_yen), taxRateBps: Number(v.tax_rate_bps)});
      budget = {versionNo: fixed.versionNo, totalExTaxYen: t.totalExTaxYen, fixedOn: fixed.fixedOn,
        diffFromTrialYen: trial ? t.totalExTaxYen - trial.input.costTotalYen : null};
    }
    const stageNow = rows.stages.at(-1) ?? null;
    const owners = rows.owners.filter((o) => o.started_on <= today());
    const documents = rows.documents.map((d) => ({id: Number(d.id), documentId: Number(d.document_id), kind: d.kind, role: d.role, submittedTo: d.submitted_to,
      submittedOn: d.submitted_on, note: d.note, fileName: d.file_name, mediaType: d.media_type, byteLength: Number(d.byte_length), createdAt: d.created_at,
      storage: d.storage, externalLocation: d.storage === 'external' ? d.external_location : null}));
    const ready = readiness({documents: documents.map((d) => ({kind: d.kind, role: d.role, submittedOn: d.submittedOn})),
      trialVersions: rows.trials.map((t) => ({createdAt: t.created_at})), budgetFixed: fixed,
      approvals: rows.approvals.map((a) => ({status: a.status, at: a.created_at})), stageCode: stageNow?.stage_code ?? null, stageEnteredOn: stageNow?.entered_on ?? null});
    const facts = rows.facts.map((f) => ({id: Number(f.id), materialId: f.material_id == null ? null : Number(f.material_id), body: f.body, valueInt: f.value_int == null ? null : Number(f.value_int),
      label: f.label, target: f.target, pages: f.pages, state: f.state, previousId: f.previous_id == null ? null : Number(f.previous_id), createdAt: f.created_at}));
    const profileRows = rows.profiles;
    const profileNow = profileRows.at(-1) ?? null;
    const people = profileNow ? rows.people.filter((p) => Number(p.version_id) === Number(profileNow.id)).map((p) => ({position: Number(p.position), role: p.role, name: p.name, status: p.status})) : [];
    return c.json({ok: true, project: {id: projectId, code: project.code, title: project.title, status: project.status, earningType: project.earning_type, counterpartyName: project.counterparty_name},
      profile: profileNow ? {revision: Number(profileNow.revision), workingTitle: profileNow.working_title, origin: profileNow.origin, logline: profileNow.logline,
        synopsisShort: profileNow.synopsis_short, synopsisLong: profileNow.synopsis_long, format: profileNow.format, episodeCount: profileNow.episode_count == null ? null : Number(profileNow.episode_count),
        plannedReleaseYear: profileNow.planned_release_year == null ? null : Number(profileNow.planned_release_year), submitTo: profileNow.submit_to, reason: profileNow.reason, createdAt: profileNow.created_at, people} : null,
      profileRevisions: profileRows.map((p) => ({revision: Number(p.revision), reason: p.reason, createdAt: p.created_at})),
      trial, trialVersions: versionSummaries, trialTypes: TRIAL_TYPES, budget, documents,
      materials: rows.materials.map((m) => ({id: Number(m.id), kind: m.kind, title: m.title, label: m.label, source: m.source, url: m.url, documentId: m.document_id == null ? null : Number(m.document_id),
        fileName: m.file_name, acquiredOn: m.acquired_on, createdAt: m.created_at})),
      facts, board: deckBoard({facts, hasTrial: Boolean(trial), materialCount: rows.materials.length}),
      stages: stages.map((s) => ({code: s.code, label: s.label})), stageHistory: rows.stages.map((s) => ({seq: Number(s.seq), code: s.stage_code, label: s.label, enteredOn: s.entered_on})),
      owner: owners.at(-1) ? {userId: Number(owners.at(-1).user_id), name: owners.at(-1).display_name, startedOn: owners.at(-1).started_on} : null,
      ownerRevision: rows.owners.length, members: rows.members.map((m) => ({userId: Number(m.user_id), name: m.display_name})),
      approvals: rows.approvals.map((a) => ({approvalNo: Number(a.approval_no), versionNo: Number(a.version_no), status: a.status, amountYen: a.amount_yen == null ? null : Number(a.amount_yen), createdAt: a.created_at})),
      readiness: ready});
  });

  app.post('/api/planning/kikaku/:projectId/profile', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {input, error} = await readBody(c); if (error) return error;
    const n = normalizeProfileInput(input);
    if (!n.ok) return invalid(c, n.errors);
    const revision = Number(input.expectedRevision ?? 0) + 1;
    try { await addProfileVersion(db, access.identity, access.projectId, revision, n.value); } catch (e) { if (lostRace(e)) return bad(c, STALE, 409); throw e; }
    return c.json({ok: true, revision}, 201);
  });

  // 試算の版を足す。template: true なら型（既定の率と例の2行）から作る
  app.post('/api/planning/kikaku/:projectId/trials', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {input, error} = await readBody(c); if (error) return error;
    const source = input.template ? templateTrial({costTotalYen: Number.isSafeInteger(input.costTotalYen) ? input.costTotalYen : 0, firstMonth: input.firstMonth}) : input;
    const n = normalizeTrialInput(source);
    if (!n.ok) return invalid(c, n.errors);
    const revision = Number(input.expectedRevision ?? 0) + 1;
    try {
      await addTrialVersion(db, access.identity, access.projectId, revision, n.value, {sourceKind: input.template ? 'template' : input.copyOf ? 'copy' : 'screen'});
    } catch (e) { if (lostRace(e)) return bad(c, STALE, 409); throw e; }
    return c.json({ok: true, revision}, 201);
  });

  async function storeUpload(c, identity, input, kind) {
    const fileName = typeof input.fileName === 'string' ? input.fileName.trim().slice(0, 240) : '';
    if (!fileName) return {error: bad(c, 'ファイルの名前がありません', 400)};
    if (typeof input.base64 !== 'string' || !input.base64) return {error: bad(c, 'ファイルの中身がありません', 400)};
    let bytes;
    try { bytes = base64Bytes(input.base64); } catch { return {error: bad(c, 'ファイルの中身を読めません', 400)}; }
    if (!bytes.length) return {error: bad(c, '空のファイルは置けません', 400)};
    if (bytes.length > MAX_DOCUMENT_BYTES) return {error: bad(c, `ファイルは ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB までです（いまの上限）`, 413)};
    const mediaType = typeof input.mediaType === 'string' && input.mediaType ? input.mediaType.slice(0, 160) : null;
    try {
      return await putSourceDocument(db, identity, {kind, fileName, mediaType, bytes, receivedOn: today()});
    } catch (e) {
      if (e instanceof SourceDocumentError) return {error: bad(c, e.message, 400)};
      throw e;
    }
  }

  // アップロードと既存原本の結び付けで、種類・役・提出日の扱いを揃える。
  function documentFields(c, input) {
    const kind = input.kind;
    if (!['deck', 'trial', 'material'].includes(kind)) return {error: bad(c, '置き場は 企画書・試算・素材 のどれかです', 400)};
    const role = kind === 'deck' ? (input.role === 'submitted' ? 'submitted' : 'draft') : null;
    const submittedOn = role === 'submitted' ? (typeof input.submittedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.submittedOn) ? input.submittedOn : null) : null;
    if (role === 'submitted' && !submittedOn) return {error: bad(c, '提出版には提出日（YYYY-MM-DD）を入れてください', 400)};
    return {value: {kind, role, submittedOn,
      submittedTo: role === 'submitted' && typeof input.submittedTo === 'string' && input.submittedTo.trim() ? input.submittedTo.trim().slice(0, 200) : null,
      note: typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 1000) : null}};
  }

  async function linkDocument(c, access, fields, documentId, reused) {
    const values = {...fields, documentId};
    const dup = await hasPlanningDocument(db, access.identity.org_id, access.projectId, values);
    if (dup) return bad(c, '同じ原本は受け取り済みです', 409);
    try {
      const id = await linkPlanningDocument(db, access.identity, access.projectId, values);
      return c.json({ok: true, id, documentId, reused}, 201);
    } catch (error) {
      if (isUniqueViolation(error)) return bad(c, '同じ原本は受け取り済みです', 409);
      throw error;
    }
  }

  // 原本を置く（企画書・試算・素材）。同じ中身を同じ案件・同じ種類にもう一度置くと 409
  app.post('/api/planning/kikaku/:projectId/documents', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {input, error} = await readBody(c); if (error) return error;
    const fields = documentFields(c, input); if (fields.error) return fields.error;
    const stored = await storeUpload(c, access.identity, input, fields.value.kind);
    if (stored.error) return stored.error;
    return linkDocument(c, access, fields.value, stored.documentId, stored.existed);
  });

  app.post('/api/planning/kikaku/:projectId/documents/link', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {input, error} = await readBody(c); if (error) return error;
    const fields = documentFields(c, input); if (fields.error) return fields.error;
    const documentId = input.documentId;
    if (!Number.isSafeInteger(documentId) || documentId <= 0) return bad(c, '原本の番号を確かめてください', 400);
    const doc = await getSourceDocument(db, access.identity.org_id, documentId);
    if (!doc) return bad(c, 'この原本への権限がありません', 403);
    return linkDocument(c, access, fields.value, documentId, true);
  });

  app.get('/api/planning/kikaku/:projectId/documents/:documentId', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const documentId = Number(c.req.param('documentId'));
    if (!Number.isSafeInteger(documentId) || documentId <= 0) return bad(c, '原本の番号を確かめてください', 400);
    const linked = await readDocumentForProject(db, access.identity.org_id, access.projectId, documentId);
    if (!linked) return bad(c, FORBIDDEN, 403);
    const doc = await getSourceDocument(db, access.identity.org_id, documentId, {withContent: true});
    if (!doc?.bytes) return bad(c, 'この原本は外の置き場にあり、ここからは取り出せません', 409);
    return c.json({ok: true, fileName: doc.fileName ?? doc.file_name, mediaType: doc.mediaType ?? doc.media_type, byteLength: Number(doc.byteLength ?? doc.byte_length), base64: bytesBase64(doc.bytes)});
  });

  app.post('/api/planning/kikaku/:projectId/stage', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {input, error} = await readBody(c); if (error) return error;
    const stages = await readStages(db);
    const n = normalizeStageChange({...input, enteredOn: input.enteredOn ?? today()}, {stages});
    if (!n.ok) return invalid(c, n.errors);
    try {
      const out = await recordStageChange(db, access.identity.org_id, {projectId: access.projectId, ...n.value, createdBy: access.identity.user_id});
      return c.json({ok: true, seq: out.seq}, 201);
    } catch (e) { if (dbErrorKind(e) === 'raise') return bad(c, STALE, 409); throw e; }
  });

  app.post('/api/planning/kikaku/:projectId/owner', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {input, error} = await readBody(c); if (error) return error;
    const userId = Number(input.userId);
    const startedOn = typeof input.startedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.startedOn) ? input.startedOn : today();
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!Number.isSafeInteger(userId) || userId <= 0) return bad(c, '担当を選んでください', 400);
    if (!reason) return bad(c, '担当を替える理由を書いてください', 400);
    const member = await isActiveMember(db, access.identity.org_id, userId);
    if (!member) return bad(c, 'この組織の人を選んでください', 400);
    const revision = Number(input.expectedRevision ?? 0) + 1;
    try { await addOwnerVersion(db, access.identity, access.projectId, revision, {userId, startedOn, reason: reason.slice(0, 1000)}); } catch (e) { if (lostRace(e)) return bad(c, STALE, 409); throw e; }
    return c.json({ok: true, revision}, 201);
  });

  // 素材を足す（ファイルがあれば共通の置き場へ）
  app.post('/api/planning/kikaku/:projectId/materials', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {input, error} = await readBody(c); if (error) return error;
    const n = normalizeMaterialInput(input);
    if (!n.ok) return invalid(c, n.errors);
    let documentId = null;
    if (input.base64) {
      const stored = await storeUpload(c, access.identity, input, 'material');
      if (stored.error) return stored.error;
      documentId = stored.documentId;
    }
    const id = await addMaterial(db, access.identity, access.projectId, n.value, documentId);
    return c.json({ok: true, id, documentId}, 201);
  });

  // 抜き出した事実を下書きで足す（AI と壁打ちした結果も、人が書いたものも、ここから入る）
  app.post('/api/planning/kikaku/:projectId/facts', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const {input, error} = await readBody(c); if (error) return error;
    const n = normalizeFactInput(input);
    if (!n.ok) return invalid(c, n.errors);
    try {
      const id = await addFact(db, access.identity, access.projectId, n.value, {state: input.confirmed === true ? 'human_confirmed' : 'ai_draft'});
      return c.json({ok: true, id}, 201);
    } catch (e) { if (dbErrorKind(e) === 'foreign_key') return bad(c, '素材が読めません', 400); throw e; }
  });

  // 下書きを確定する（確定の行を足して前の行を指す。下書きの行は消さない）
  app.post('/api/planning/kikaku/:projectId/facts/:factId/confirm', async (c) => {
    const access = await projectAccess(c); if (access.error) return access.error;
    const factId = Number(c.req.param('factId'));
    const orgId = access.identity.org_id;
    const f = await readFact(db, orgId, access.projectId, factId);
    if (!f) return bad(c, '事実が見つかりません', 404);
    if (f.state === 'human_confirmed') return bad(c, 'もう確定しています', 409);
    try {
      const id = await addFact(db, access.identity, access.projectId, {materialId: f.material_id, body: f.body, valueInt: f.value_int, label: f.label, target: f.target, pages: f.pages},
        {state: 'human_confirmed', previousId: factId});
      return c.json({ok: true, id}, 201);
    } catch (e) { if (isUniqueViolation(e)) return bad(c, STALE, 409); throw e; }
  });
}
