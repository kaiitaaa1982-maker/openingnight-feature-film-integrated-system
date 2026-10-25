// 予算書の受け口（要件 docs/requirements/planning/budget-book.md。移行 0024）。
// 読めるのは案件の財務の権限のある人（管理者と、案件の編集の権限を持つ編集担当）。制作担当には読ませない（FR-PLAN-BUDGET-020）。
// 確定・取り消しは、作品ごとの役目の表（FR-PROD-SCHED-062）がまだ無いので管理者だけ（FR-PLAN-BUDGET-018）。自動で確定しない。
// 権限の無い案件と別の組織の案件は、有無を見せず同じ 403 にする。予算書から制作費の版と projects.budget_yen には書かない（FR-PLAN-BUDGET-007・024）
import {readBudgetFile} from './budget-xlsx.mjs';
import {buildBudgetWorkbook} from './budget-xlsx-write.mjs';
import {BUDGET_CATEGORIES, budgetFolderState, budgetTotals, checkParsedBudget, checkRunRecord, checkScreenVersion, compareBudgetVersions,
  currentFixedVersionNo, departmentTotals, noticesForLines, normalizeBudgetVersionInput, versionInputFromParsed, normalizeTemplateItems,
  templateItemsFromLines, addItemsToTemplate} from './budget-model.mjs';
import {addBudgetFix, addBudgetVersion, readBudgetCheckRuns, readBudgetFixes, readBudgetLines, readBudgetProject, readBudgetSummaries, readBudgetVersions,
  readProjectTitles, readProjectWorks, readVersionLinesFor, readLineItems, readVersionTemplate, readBudgetTemplates, readBudgetTemplate, readTemplateVersions,
  readTemplateItems, addBudgetTemplate, addTemplateVersion} from './budget-store.mjs';
import {dbErrorKind, isUniqueViolation} from '../../data-platform/db-errors.mjs';

const FORBIDDEN = 'この案件の予算書への権限がありません';
const NOT_FIXER = '予算書を確定・取り消しできるのは管理者です（作品ごとのプロデューサーの役目はまだ扱えません）';
const STALE_MESSAGE = 'ほかの画面で予算書が変わりました。読み直してください';
const STALE = /stale budget (version|fix)/;
const lostRace = (error, table) => (dbErrorKind(error) === 'raise' && STALE.test(error.message)) || isUniqueViolation(error, table);
const MAX_BASE64 = 28 * 1024 * 1024;

const lineView = (row) => ({categoryCode: row.category_code, lineNo: Number(row.line_no), workId: row.work_id == null ? null : Number(row.work_id),
  departmentId: row.department_id == null ? null : Number(row.department_id), name: row.name, unitPriceYen: row.unit_price_yen == null ? null : Number(row.unit_price_yen),
  qtyMilli: row.qty_milli == null ? null : Number(row.qty_milli), unit: row.unit, amountExTaxYen: Number(row.amount_ex_tax_yen), confirmedSource: row.confirmed_source,
  paymentMonth: row.payment_month, sourceCell: row.source_cell, note: row.note});
const versionView = (row) => ({id: Number(row.id), versionNo: Number(row.version_no), sourceKind: row.source_kind, sourceFileName: row.source_file_name,
  taxRateBps: Number(row.tax_rate_bps), managementFeeYen: Number(row.management_fee_yen), contingencyYen: Number(row.contingency_yen),
  sheetCreatedOn: row.sheet_created_on, headerNotes: row.header_notes, title: row.title, reason: row.reason, createdAt: row.created_at});

// 行に内訳（キャストリストなど）を付ける
function attachItems(lines, items) {
  return lines.map((line) => {
    const own = items.filter((item) => item.category_code === line.categoryCode && Number(item.line_no) === line.lineNo);
    if (!own.length) return line;
    return {...line, breakdown: {sheet: own[0].breakdown_sheet, items: own.map((item) => ({itemNo: Number(item.item_no), label: item.label,
      qtyMilli: item.qty_milli == null ? null : Number(item.qty_milli), unitPriceYen: item.unit_price_yen == null ? null : Number(item.unit_price_yen),
      amountExTaxYen: Number(item.amount_ex_tax_yen), castingRef: item.casting_ref, sourceCell: item.source_cell}))}};
  });
}
const templateItemView = (row) => ({categoryCode: row.category_code, lineNo: Number(row.line_no), name: row.name, unit: row.unit,
  unitPriceYen: row.unit_price_yen == null ? null : Number(row.unit_price_yen), qtyMilli: row.qty_milli == null ? null : Number(row.qty_milli), breakdownSheet: row.breakdown_sheet});
// xlsx を返す（ファイル名は日本語を含むので filename* で）
function xlsxResponse(bytes, filename) {
  return new Response(bytes, {headers: {'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="budget.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'cache-control': 'no-store'}});
}

export function registerBudgetRoutes(app, {db, bad, body, permittedProjects}) {
  if (!app || !db || typeof bad !== 'function' || typeof body !== 'function' || typeof permittedProjects !== 'function') {
    throw new Error('budget routes require app, db, bad, body and permittedProjects');
  }

  async function financeProjectIds(identity) {
    if (identity.role === 'production') return [];
    return (await permittedProjects(db, identity, true)).map((row) => Number(row.id));
  }

  async function projectAccess(c) {
    const identity = c.get('identity');
    const raw = c.req.param('projectId');
    const projectId = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(projectId) || projectId <= 0) return {error: bad(c, '案件の番号を確かめてください', 400)};
    const [project, finance] = await Promise.all([readBudgetProject(db, identity.org_id, projectId), financeProjectIds(identity)]);
    if (!project || !finance.includes(projectId)) return {error: bad(c, FORBIDDEN, 403)};
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

  // 案件の予算書の全体: 版の一覧・いまの確定版・見る版（既定は最新）の行と合計・区分ごと・部署ごと・検査・前の版との比較
  async function budgetDetail(orgId, projectId, wantedNo) {
    const [versionRows, fixes, runs, works] = await Promise.all([readBudgetVersions(db, orgId, projectId), readBudgetFixes(db, orgId, projectId),
      readBudgetCheckRuns(db, orgId, projectId), readProjectWorks(db, orgId, projectId)]);
    const versions = versionRows.map(versionView);
    const fixedNo = currentFixedVersionNo(fixes.map((f) => ({seq: Number(f.seq), action: f.action, versionNo: Number(f.version_no)})));
    const latestRun = (versionId) => runs.filter((r) => Number(r.version_id) === versionId).at(-1) ?? null;
    const target = wantedNo == null ? versions.at(-1) : versions.find((v) => v.versionNo === wantedNo);
    const state = budgetFolderState({versions, fixes: fixes.map((f) => ({seq: Number(f.seq), action: f.action, versionNo: Number(f.version_no)})),
      latestVerdict: (() => { const run = versions.length ? latestRun(versions.at(-1).id) : null; return run ? {kind: run.verdict, failed: Number(run.failed)} : null; })()});
    const base = {versions: versions.map((v) => ({...v, fixed: v.versionNo === fixedNo, verdict: latestRun(v.id)?.verdict ?? null})), fixedVersionNo: fixedNo,
      state, categories: BUDGET_CATEGORIES, works: works.map((w) => ({id: Number(w.id), code: w.code, title: w.title})),
      history: fixes.map((f) => ({seq: Number(f.seq), action: f.action, versionNo: Number(f.version_no), reason: f.reason, createdAt: f.created_at}))};
    if (!target) return {...base, version: null};
    const lines = attachItems((await readBudgetLines(db, orgId, target.id)).map(lineView), await readLineItems(db, orgId, target.id));
    const template = await readVersionTemplate(db, orgId, target.id);
    const totals = budgetTotals({lines, managementFeeYen: target.managementFeeYen, contingencyYen: target.contingencyYen, taxRateBps: target.taxRateBps});
    const run = latestRun(target.id);
    const previous = versions.filter((v) => v.versionNo < target.versionNo).at(-1);
    let comparison = null;
    if (previous) {
      const previousLines = (await readBudgetLines(db, orgId, previous.id)).map(lineView);
      comparison = {versionNo: previous.versionNo, ...compareBudgetVersions({lines: previousLines, managementFeeYen: previous.managementFeeYen,
        contingencyYen: previous.contingencyYen, taxRateBps: previous.taxRateBps}, {lines, managementFeeYen: target.managementFeeYen,
        contingencyYen: target.contingencyYen, taxRateBps: target.taxRateBps})};
    }
    return {...base, version: {...target, fixed: target.versionNo === fixedNo, lines, totals,
      template: template ? {templateId: Number(template.template_id), name: template.name, versionNo: Number(template.version_no)} : null, departments: departmentTotals(lines),
      check: run ? {runNo: Number(run.run_no), verdict: run.verdict, passed: Number(run.passed), failed: Number(run.failed), checks: JSON.parse(run.checks_json)} : null,
      notices: noticesForLines(lines.map((l) => ({...l, cell: l.sourceCell, marks: l.confirmedSource === 'fill' ? ['confirmed_from_fill'] : []}))),
      comparison}};
  }

  // 予算書の一覧（フォルダ画面と業務画面の入口。FR-PLAN-BUDGET-021）。見てよい案件ごとに確定版・下書き・総合計・進み具合
  app.get('/api/planning/budgets', async (c) => {
    const identity = c.get('identity');
    if (identity.role === 'production') return bad(c, FORBIDDEN, 403);
    const ids = (await permittedProjects(db, identity, true)).map((p) => Number(p.id));
    const projects = await readProjectTitles(db, identity.org_id, ids);
    const {versions, fixes, runs} = await readBudgetSummaries(db, identity.org_id, ids);
    const fixedIds = [];
    const rows = projects.map((p) => {
      const id = Number(p.id);
      const own = versions.filter((v) => Number(v.project_id) === id).map((v) => ({id: Number(v.id), versionNo: Number(v.version_no),
        managementFeeYen: Number(v.management_fee_yen), contingencyYen: Number(v.contingency_yen), taxRateBps: Number(v.tax_rate_bps)}));
      const ownFixes = fixes.filter((f) => Number(f.project_id) === id).map((f) => ({seq: Number(f.seq), action: f.action, versionNo: Number(f.version_no)}));
      const latest = own.at(-1);
      const run = latest ? runs.find((r) => Number(r.version_id) === latest.id) : null;
      const fixedNo = currentFixedVersionNo(ownFixes);
      const fixed = own.find((v) => v.versionNo === fixedNo) ?? null;
      if (fixed) fixedIds.push(fixed.id);
      return {projectId: id, code: p.code, title: p.title, latestVersionNo: latest?.versionNo ?? null, fixedVersionNo: fixedNo, fixed,
        state: budgetFolderState({versions: own, fixes: ownFixes, latestVerdict: run ? {kind: run.verdict, failed: Number(run.failed)} : null})};
    });
    const lines = await readVersionLinesFor(db, identity.org_id, fixedIds);
    return c.json({ok: true, budgets: rows.map(({fixed, ...row}) => ({...row, fixedTotalExTaxYen: fixed ? budgetTotals({
      lines: lines.filter((l) => Number(l.version_id) === fixed.id).map((l) => ({categoryCode: l.category_code, amountExTaxYen: Number(l.amount_ex_tax_yen)})),
      managementFeeYen: fixed.managementFeeYen, contingencyYen: fixed.contingencyYen, taxRateBps: fixed.taxRateBps}).totalExTaxYen : null}))});
  });

  app.get('/api/planning/projects/:projectId/budget', async (c) => {
    const found = await projectAccess(c);
    if (found.error) return found.error;
    const raw = c.req.query('version');
    const wanted = raw == null || raw === '' ? null : Number(raw);
    if (wanted != null && (!Number.isSafeInteger(wanted) || wanted <= 0)) return bad(c, '版の番号を確かめてください', 400);
    const detail = await budgetDetail(found.identity.org_id, found.project.id, wanted);
    if (wanted != null && !detail.version) return bad(c, 'その版はありません', 404);
    return c.json({ok: true, project: {id: found.project.id, code: found.project.code, title: found.project.title},
      canFix: found.identity.role === 'admin', ...detail});
  });

  async function appendVersion(c, found, value, extra) {
    const {identity, project} = found;
    const versions = await readBudgetVersions(db, identity.org_id, project.id);
    const versionNo = versions.length ? Number(versions.at(-1).version_no) + 1 : 1;
    try {
      await addBudgetVersion(db, identity.org_id, project.id, {...value, ...extra, versionNo}, {createdBy: identity.user_id});
    } catch (error) {
      if (lostRace(error, 'budget_versions')) return bad(c, STALE_MESSAGE, 409);
      throw error;
    }
    return c.json({ok: true, versionNo, verdict: extra.check.verdict, failed: extra.check.failed}, 201);
  }

  // 画面で作った版（FR-PLAN-BUDGET-001・003）。前の版を写して直すときは copyOf に版の番号
  app.post('/api/planning/projects/:projectId/budget/versions', async (c) => {
    const found = await projectAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const works = await readProjectWorks(db, found.identity.org_id, found.project.id);
    const normalized = normalizeBudgetVersionInput(read.input, {workIds: works.map((w) => Number(w.id))});
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
    let previousVersionId = null;
    if (read.input.copyOf != null) {
      const previous = (await readBudgetVersions(db, found.identity.org_id, found.project.id)).find((v) => Number(v.version_no) === Number(read.input.copyOf));
      if (!previous) return bad(c, '写す元の版がありません', 400);
      previousVersionId = Number(previous.id);
    }
    let templateVersionId = null;
    if (read.input.templateId != null) {
      const versions = await readTemplateVersions(db, found.identity.org_id, Number(read.input.templateId));
      const chosen = versions.find((v) => Number(v.version_no) === Number(read.input.templateVersionNo)) ?? versions.at(-1);
      if (!chosen) return bad(c, 'その型はありません', 400);
      templateVersionId = Number(chosen.id);
    }
    const {checks} = checkScreenVersion(normalized.value);
    return appendVersion(c, found, normalized.value, {sourceKind: previousVersionId ? 'copy' : 'screen', previousVersionId, templateVersionId, check: checkRunRecord(checks)});
  });

  // 予算書 xlsx を読んで下書きの版にする（FR-PLAN-BUDGET-008〜014）。本文は {fileName, base64, reason}。原本は保存しない（共通の原本の表が入るまで。FR-PLAN-BUDGET-022）
  app.post('/api/planning/projects/:projectId/budget/import', async (c) => {
    const found = await projectAccess(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const {fileName, base64} = read.input;
    if (typeof base64 !== 'string' || !base64 || base64.length > MAX_BASE64) return bad(c, '予算書のファイルがありません（20MB まで）', 400);
    const name = String(fileName ?? '').trim().slice(0, 240);
    if (!/\.xlsx$/i.test(name)) return bad(c, '予算書は xlsx で置いてください', 400);
    let parsed;
    try { parsed = readBudgetFile(Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))); } catch (error) { return bad(c, `予算書を読めません: ${error.message}`, 422); }
    if (!parsed.ok) return bad(c, parsed.message, 422, {reason: parsed.reason});
    const reason = String(read.input.reason ?? '').trim() || `予算書 ${name} から読んだ`;
    const works = await readProjectWorks(db, found.identity.org_id, found.project.id);
    const normalized = normalizeBudgetVersionInput(versionInputFromParsed(parsed, {reason}), {workIds: works.map((w) => Number(w.id))});
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 422, {errors: normalized.errors});
    const {checks} = checkParsedBudget(parsed, {taxRateBps: normalized.value.taxRateBps});
    return appendVersion(c, found, normalized.value, {sourceKind: 'file', sourceFileName: name, sheetCreatedOn: parsed.header.createdOn ?? null,
      headerNotes: parsed.header.notes.length ? parsed.header.notes.join('／').slice(0, 2000) : null, check: checkRunRecord(checks)});
  });

  // 確定・取り消し（FR-PLAN-BUDGET-017〜019）。本文は {action: 'fix'|'void', versionNo, reason}
  app.post('/api/planning/projects/:projectId/budget/fixes', async (c) => {
    const found = await projectAccess(c);
    if (found.error) return found.error;
    if (found.identity.role !== 'admin') return bad(c, NOT_FIXER, 403);
    const read = await readBody(c);
    if (read.error) return read.error;
    const action = read.input.action === 'void' ? 'void' : read.input.action === 'fix' ? 'fix' : null;
    const reason = String(read.input.reason ?? '').trim();
    if (!action) return bad(c, '確定か取り消しかを選んでください', 400);
    if (!reason || reason.length > 1000) return bad(c, '理由を入れてください（1000字まで）', 400);
    const {identity, project} = found;
    const [versions, fixes, runs] = await Promise.all([readBudgetVersions(db, identity.org_id, project.id), readBudgetFixes(db, identity.org_id, project.id),
      readBudgetCheckRuns(db, identity.org_id, project.id)]);
    const version = versions.find((v) => Number(v.version_no) === Number(read.input.versionNo));
    if (!version) return bad(c, 'その版はありません', 400);
    const fixedNo = currentFixedVersionNo(fixes.map((f) => ({seq: Number(f.seq), action: f.action, versionNo: Number(f.version_no)})));
    if (action === 'void' && fixedNo !== Number(version.version_no)) return bad(c, '取り消せるのは、いまの確定版だけです', 409);
    if (action === 'fix') {
      if (fixedNo === Number(version.version_no)) return bad(c, 'この版はもう確定しています', 409);
      const run = runs.filter((r) => Number(r.version_id) === Number(version.id)).at(-1);
      if (!run || run.verdict !== 'draft_ok') return bad(c, '例外のある版は確定できません。例外を直した版を足してください', 409);
    }
    const seq = fixes.length ? Number(fixes.at(-1).seq) + 1 : 1;
    try {
      await addBudgetFix(db, identity.org_id, project.id, {seq, action, versionId: Number(version.id), versionNo: Number(version.version_no), reason},
        {createdBy: identity.user_id});
    } catch (error) {
      if (lostRace(error, 'budget_fixes')) return bad(c, STALE_MESSAGE, 409);
      if (dbErrorKind(error) === 'raise' && /has exceptions|not current/.test(error.message)) return bad(c, STALE_MESSAGE, 409);
      throw error;
    }
    return c.json({ok: true, action, versionNo: Number(version.version_no), seq}, 201);
  });

  // 予算書の版を xlsx で落とす（FR-PLAN-BUDGET-027）。内訳のある行は別のシートから SUMIF で足す形
  app.get('/api/planning/projects/:projectId/budget/versions/:versionNo/xlsx', async (c) => {
    const found = await projectAccess(c);
    if (found.error) return found.error;
    const versionNo = Number(c.req.param('versionNo'));
    const detail = await budgetDetail(found.identity.org_id, found.project.id, Number.isSafeInteger(versionNo) && versionNo > 0 ? versionNo : -1);
    if (!detail.version) return bad(c, 'その版はありません', 404);
    const v = detail.version;
    const {bytes} = buildBudgetWorkbook({title: `${found.project.title} rev${v.versionNo}`, managementFeeYen: v.managementFeeYen, contingencyYen: v.contingencyYen,
      taxRateBps: v.taxRateBps, lines: v.lines.map((line) => ({...line, confirmed: line.confirmedSource !== 'none'}))});
    return xlsxResponse(bytes, `予算書_${found.project.code}_rev${v.versionNo}.xlsx`);
  });

  // ---- 予算書の型（テンプレ。FR-PLAN-BUDGET-032〜034）。組織で共有し、制作担当には見せない。作る・版を足すのは財務を扱う人（管理者・編集担当）----
  const templateAccess = (c) => (c.get('identity').role === 'production' ? bad(c, 'この役割では予算書の型を扱えません', 403) : null);

  app.get('/api/planning/budget-templates', async (c) => {
    const denied = templateAccess(c);
    if (denied) return denied;
    const rows = await readBudgetTemplates(db, c.get('identity').org_id);
    return c.json({ok: true, templates: rows.map((row) => ({id: Number(row.id), name: row.name, latestVersionNo: Number(row.version_no),
      itemCount: Number(row.item_count), breakdownCount: Number(row.breakdown_count), updatedAt: row.version_created_at, reason: row.reason}))});
  });

  async function templateDetail(c) {
    const denied = templateAccess(c);
    if (denied) return {error: denied};
    const orgId = c.get('identity').org_id;
    const raw = c.req.param('templateId');
    const template = /^\d+$/.test(raw) ? await readBudgetTemplate(db, orgId, Number(raw)) : null;
    if (!template) return {error: bad(c, 'その型はありません', 404)};
    const versions = await readTemplateVersions(db, orgId, Number(template.id));
    const wanted = c.req.query('version');
    const chosen = wanted ? versions.find((v) => Number(v.version_no) === Number(wanted)) : versions.at(-1);
    if (!chosen) return {error: bad(c, 'その版はありません', 404)};
    const items = (await readTemplateItems(db, orgId, Number(chosen.id))).map(templateItemView);
    return {template: {id: Number(template.id), name: template.name}, versions: versions.map((v) => ({versionNo: Number(v.version_no), sourceKind: v.source_kind,
      sourceFileName: v.source_file_name, reason: v.reason, createdAt: v.created_at})), versionNo: Number(chosen.version_no), latestVersionId: Number(versions.at(-1).id), items};
  }

  app.get('/api/planning/budget-templates/:templateId', async (c) => {
    const found = await templateDetail(c);
    if (found.error) return found.error;
    const {latestVersionId, ...view} = found;
    return c.json({ok: true, ...view});
  });

  // 型を xlsx で落とす（FR-PLAN-BUDGET-028）。額は単価×数量のある費目だけ数式で、内訳を持つ費目は空の内訳のシートと SUMIF を置く
  app.get('/api/planning/budget-templates/:templateId/xlsx', async (c) => {
    const found = await templateDetail(c);
    if (found.error) return found.error;
    const {bytes} = buildBudgetWorkbook({title: `${found.template.name} v${found.versionNo}`, template: true,
      lines: found.items.map((item) => ({...item, ...(item.breakdownSheet ? {breakdown: {sheet: item.breakdownSheet, items: []}} : {})}))});
    return xlsxResponse(bytes, `予算書の型_${found.template.name}_v${found.versionNo}.xlsx`);
  });

  // 型を作る。出どころは3つ: 案件の版（from: {projectId, versionNo}）・予算書 xlsx（fileName と base64）・費目の一覧（items）
  app.post('/api/planning/budget-templates', async (c) => {
    const denied = templateAccess(c);
    if (denied) return denied;
    const read = await readBody(c);
    if (read.error) return read.error;
    const identity = c.get('identity');
    const name = String(read.input.name ?? '').trim();
    const reason = String(read.input.reason ?? '').trim();
    if (!name || name.length > 100) return bad(c, '型の名前を100字までで入れてください', 400);
    if (!reason || reason.length > 1000) return bad(c, '理由を入れてください', 400);
    const built = await templateSource(c, identity, read.input);
    if (built.error) return built.error;
    const normalized = normalizeTemplateItems(built.items);
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
    try {
      const templateId = await addBudgetTemplate(db, identity.org_id, {name, source: built.source, items: normalized.items, reason}, {createdBy: identity.user_id});
      return c.json({ok: true, templateId, versionNo: 1, itemCount: normalized.items.length}, 201);
    } catch (error) {
      if (isUniqueViolation(error, 'budget_templates')) return bad(c, '同じ名前の型があります', 409);
      throw error;
    }
  });

  // 型の版を足す。additions（「型にも足す」の費目）は今の版の費目に足し、そのほか（案件の版・xlsx・一覧）は費目の一覧そのものを新しい版にする
  app.post('/api/planning/budget-templates/:templateId/versions', async (c) => {
    const found = await templateDetail(c);
    if (found.error) return found.error;
    const read = await readBody(c);
    if (read.error) return read.error;
    const identity = c.get('identity');
    const reason = String(read.input.reason ?? '').trim();
    if (!reason || reason.length > 1000) return bad(c, '理由を入れてください', 400);
    const latest = found.versions.at(-1);
    if (read.input.baseVersionNo != null && Number(read.input.baseVersionNo) !== latest.versionNo) return bad(c, 'ほかの画面で型の版が足されました。読み直してください', 409);
    let normalized;
    let source = {kind: 'screen'};
    if (Array.isArray(read.input.additions)) {
      const current = (await readTemplateItems(db, identity.org_id, found.latestVersionId)).map(templateItemView);
      normalized = addItemsToTemplate(current, read.input.additions);
    } else {
      const built = await templateSource(c, identity, read.input);
      if (built.error) return built.error;
      source = built.source;
      normalized = normalizeTemplateItems(built.items);
    }
    if (!normalized.ok) return bad(c, normalized.errors.join('／'), 400, {errors: normalized.errors});
    try {
      await addTemplateVersion(db, identity.org_id, found.template.id, {versionNo: latest.versionNo + 1, source, items: normalized.items, reason}, {createdBy: identity.user_id});
    } catch (error) {
      if ((dbErrorKind(error) === 'raise' && /stale budget template version/.test(error.message)) || isUniqueViolation(error, 'budget_template_versions')) {
        return bad(c, 'ほかの画面で型の版が足されました。読み直してください', 409);
      }
      throw error;
    }
    return c.json({ok: true, templateId: found.template.id, versionNo: latest.versionNo + 1, itemCount: normalized.items.length}, 201);
  });

  // 型の費目の出どころを読む（案件の版・予算書 xlsx・費目の一覧）
  async function templateSource(c, identity, input) {
    if (input.from && input.from.projectId != null) {
      const projectId = Number(input.from.projectId);
      const finance = await financeProjectIds(identity);
      if (!finance.includes(projectId)) return {error: bad(c, FORBIDDEN, 403)};
      const version = (await readBudgetVersions(db, identity.org_id, projectId)).find((v) => Number(v.version_no) === Number(input.from.versionNo));
      if (!version) return {error: bad(c, 'その版はありません', 400)};
      const lines = attachItems((await readBudgetLines(db, identity.org_id, Number(version.id))).map(lineView), await readLineItems(db, identity.org_id, Number(version.id)));
      return {items: templateItemsFromLines(lines), source: {kind: 'budget', projectId, budgetVersionId: Number(version.id)}};
    }
    if (typeof input.base64 === 'string' && input.base64) {
      const name = String(input.fileName ?? '').trim().slice(0, 240);
      if (!/\.xlsx$/i.test(name) || input.base64.length > MAX_BASE64) return {error: bad(c, '型は xlsx（20MB まで）で置いてください', 400)};
      let parsed;
      try { parsed = readBudgetFile(Uint8Array.from(atob(input.base64), (ch) => ch.charCodeAt(0)), {keepEmpty: true}); } catch (error) { return {error: bad(c, `予算書を読めません: ${error.message}`, 422)}; }
      if (!parsed.ok) return {error: bad(c, parsed.message, 422, {reason: parsed.reason})};
      return {items: templateItemsFromLines(parsed.lines), source: {kind: 'file', fileName: name}};
    }
    if (Array.isArray(input.items)) return {items: input.items, source: {kind: 'screen'}};
    return {error: bad(c, '型の出どころ（案件の版・予算書 xlsx・費目の一覧）を選んでください', 400)};
  }

}
