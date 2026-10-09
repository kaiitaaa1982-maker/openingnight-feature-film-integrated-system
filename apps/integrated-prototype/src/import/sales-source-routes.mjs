// 受領原本（作品を持たない）の受付・付け替え・作品ごとの分割のAPI。
// 設計: docs/platform/team-development/royalty-committee-design.md §5。Worker でも動くよう node:* を import しない。
// - POST /api/sales-import/files                 原本を受け取る（作品は決めなくてよい。1つの作品ならその場で割り当てる）
// - POST /api/sales-import/files/takeover        旧方式の原本（workflow_raw_artifacts）を引き継ぐ（中身は複製しない）
// - GET  /api/sales-import/files                 読み込んだまま登録し終えていない原本
// - GET  /api/sales-import/files/:id             原本・割り当ての版・最新の選択・いまの分け方と登録の進み具合
// - POST /api/sales-import/files/:id/selection   見出しの行と取り込まない行（理由必須）から表の選択版を作る
// - POST /api/sales-import/files/:id/bindings    割り当て（付け替え）の版を足す。登録を始めたら付け替えない
// - POST /api/sales-import/files/:id/partitions  作品ごとに分ける（dryRun は保存しない）。照合できない行があれば保存しない
// 制作担当は 403。作品の財務権限は ctx.settlementWork。すべて組織で絞る。
import {importLimits, limitReason, utf8Bytes, kbText} from './limits.mjs';
import {suggestionList} from './column-synonyms.mjs';
import {amountsOf, exclusionTotals} from './wizard-model.mjs';
import {buildSelection} from './sales-import-routes.mjs';
import {
  normalizeBinding, sameBinding, bindingFromRow, selectionTable, planPartitions, planKey, partitionCsv, usesResolvedProduct,
} from './source-partition.mjs';
import {
  fileRow, fileByHash, fileByLegacyArtifact, fileExtraction, latestBindingRow, latestSelectionRow, selectionFromRow, currentPlan, canAccessFile,
  pendingSourceFilePage, exclusionSummary, workLabel, fileCommitTerms,
} from './sales-source-store.mjs';

const json = JSON.stringify;
const positiveInt = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const parseJson = (text, fallback) => {
  try { return JSON.parse(text); } catch { return fallback; }
};
const SALES_KINDS = ['digital', 'package', 'theatrical', 'broadcast', 'other'];
const DEFAULT_BINDING_REASON = '受け取ったときの割り当て';
const TAKEOVER_REASON = '旧方式の原本を引き継ぎ（作品は元の原本のまま）';

// 作品ごとに分けた表を保存する前に、作品ごとの登録で通らないことが分かっている理由（保存しない）。
// - 1回の登録（報告1件）の行数の上限は、原本全体ではなく作品ごとに数える
// - 列対応で商品を1つに固定しているとき、その商品が分けた作品と報告の種類に結び付いていなければ、登録の確認で全行がエラーになる
function partitionProblems({views, mappings, kind, products, allocations, mode}) {
  const out = [];
  const limits = importLimits(mode);
  const title = (view) => (view.restricted ? '権限のない作品' : view.workTitle || `作品ID ${view.workId}`);
  for (const view of views) {
    if (view.rowCount > limits.salesRows) out.push(`作品「${title(view)}」に割り当たる行が${view.rowCount.toLocaleString('ja-JP')}行あり、1回の登録で取り込める${limits.salesRows.toLocaleString('ja-JP')}行を超えます（${limitReason(mode)}）。取り込まない行にするか、ファイルを分けてください`);
  }
  const rule = (mappings || []).find((item) => item.target === 'product_id');
  if (rule?.mode === 'literal' && String(rule.value ?? '').trim()) {
    const productId = Number(rule.value);
    const product = products.find((item) => Number(item.id) === productId);
    const name = product ? `${product.name || product.sku}（${product.sku}）` : `商品ID ${rule.value}`;
    if (!product) out.push(`列の対応で固定した商品（${name}）が見つかりません。手順3で商品を選び直してください`);
    else {
      if (kind && product.channel !== kind) out.push(`列の対応で固定した商品「${name}」は、報告の種類と販路が違います。手順3で商品を選び直してください`);
      for (const view of views) {
        if (!allocations.some((row) => Number(row.product_id) === productId && Number(row.work_id) === Number(view.workId))) {
          out.push(`列の対応で固定した商品「${name}」は、作品「${title(view)}」に結び付いていません。作品を付け替えたときは、手順3でその作品の商品を選び直してください`);
        }
      }
    }
  }
  return out;
}

export function registerSalesSourceRoutes(app, ctx) {
  const {db, bad, body, mode = 'local', sha256, nowIso, permittedProjects, settlementWork, extractDocument} = ctx;
  if (!app || !db) throw new Error('sales source routes require app and db');
  const deny = (c, i) => (i.role === 'production' ? bad(c, '売上の取込は財務担当の画面です', 403) : null);
  const nextId = async (table) => Number((await db.get(`SELECT COALESCE(MAX(id),0)+1 AS id FROM ${table}`)).id);
  const audit = (i, action, entityId, hash, detail) => ({
    sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)',
    params: [i.org_id, i.user_id, action, 'sales_source_file', String(entityId), hash ?? null, json(detail)],
  });
  const noCommitGuard = (i, fileId) => ({sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM sales_source_commits WHERE org_id=? AND file_id=?)', params: [i.org_id, fileId]});

  async function financeProjects(i) {
    if (i.role === 'production') return new Set();
    return new Set((await permittedProjects(db, i, true)).map((row) => Number(row.id)));
  }
  async function readBody(c) {
    try { return {input: await body(c)}; } catch (error) { return {error: bad(c, error.message, 400, undefined, error)}; }
  }
  // 原本を読み、見られるか確かめる。返り値 {file} か {response}
  async function loadFile(c, i) {
    const fileId = positiveInt(c.req.param('id'));
    if (!fileId) return {response: bad(c, '原本を確かめてください')};
    const file = await fileRow(db, i.org_id, fileId);
    if (!file) return {response: bad(c, '原本が見つかりません', 404)};
    if (!await canAccessFile(ctx, i, file)) return {response: bad(c, 'この原本への権限がありません', 403)};
    return {file};
  }
  const worksOf = async (i) => db.all('SELECT id, project_id, code, title FROM works WHERE org_id=? ORDER BY id', [i.org_id]);
  // 作品が財務権限のある案件のものか（管理者は全作品）
  const permittedBy = (i, finance) => (work) => Boolean(work) && (i.role === 'admin' || finance.has(Number(work.project_id)));
  // 割り当ての表示。権限のない作品はコード・題名を伏せて restricted を付ける（分割の一覧・未登録の一覧と同じ扱い。受け取った人にも見せない）
  function bindingView(row, works, permitted) {
    const binding = bindingFromRow(row);
    if (!binding) return null;
    const work = binding.workId ? works.find((item) => Number(item.id) === binding.workId) : null;
    return {...binding, ...workLabel(work, permitted(work))};
  }

  // ---------- 受け取り ----------
  app.post('/api/sales-import/files', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const {input, error} = await readBody(c);
    if (error) return error;
    if (i.role !== 'admin' && !(await financeProjects(i)).size) return bad(c, '売上を取り込める作品がありません', 403);
    let binding = null;
    if (input.binding != null) {
      const normalized = normalizeBinding(input.binding);
      if (normalized.error) return bad(c, normalized.error);
      if (normalized.binding.mode !== 'single_work') return bad(c, '列で作品を分けるときは、見出しを確かめたあとで割り当てます。受け取るときは作品を決めずに保存してください');
      binding = normalized.binding;
    }
    let work = null;
    if (binding) {
      work = await settlementWork(i, binding.workId);
      if (!work) return bad(c, '作品の財務権限がありません', 403);
    }
    if (typeof extractDocument !== 'function') return bad(c, 'この環境では原本の読み取り（抽出）を使えません', 503);
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 240) return bad(c, 'ファイル名は1〜240文字です');
    if (typeof input.base64 !== 'string' || !input.base64) return bad(c, 'ファイルの中身がありません');
    let extraction;
    try { extraction = await extractDocument({name, base64: input.base64}); } catch (failure) { return bad(c, failure.message, 422); }
    const existing = await fileByHash(db, i.org_id, extraction.rawSha256);
    if (existing) return bad(c, '同じ原本は受け取り済みです。続きから取り込んでください', 409, {fileId: existing.id});
    const legacy = await db.get("SELECT id FROM workflow_raw_artifacts WHERE org_id=? AND kind='sales_report' AND raw_sha256=?", [i.org_id, extraction.rawSha256]);
    if (legacy) return bad(c, '同じ原本が旧方式の原本として保存済みです。その原本を引き継いで取り込んでください', 409, {legacyArtifactId: legacy.id});
    if (!Array.isArray(extraction.sheets) || !extraction.sheets.length) return bad(c, '売上原本から表を抽出できません。画像PDFの文字認識は未対応です', 422, {status: extraction.status});
    const fileId = await nextId('sales_source_files');
    const statements = [
      {sql: "INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM workflow_raw_artifacts WHERE org_id=? AND kind='sales_report' AND raw_sha256=?)", params: [i.org_id, extraction.rawSha256]},
      {sql: 'INSERT INTO sales_source_files(id,org_id,storage,file_name,media_type,byte_length,raw_sha256,original_base64,extraction_json,extractor_name,extractor_version,extraction_status,legacy_artifact_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [fileId, i.org_id, 'inline', extraction.name || name, input.mediaType || null, extraction.byteLength, extraction.rawSha256, input.base64, json(extraction), extraction.extractorName, extraction.extractorVersion, extraction.status, null, i.user_id]},
    ];
    let bindingId = null;
    if (binding) {
      bindingId = await nextId('sales_source_bindings');
      statements.push({sql: 'INSERT INTO sales_source_bindings(id,org_id,file_id,version_no,mode,project_id,work_id,product_column,work_column,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        params: [bindingId, i.org_id, fileId, 1, 'single_work', work.project_id, binding.workId, null, null, DEFAULT_BINDING_REASON, i.user_id]});
    }
    statements.push(audit(i, 'receive_source', fileId, extraction.rawSha256, {fileName: extraction.name || name, byteLength: extraction.byteLength, binding: binding ? {mode: 'single_work', workId: binding.workId} : null}));
    try { await db.batch(statements); } catch (failure) { return bad(c, `原本を保存できませんでした（同じ原本が同時に保存された可能性があります）: ${failure.message}`, 409); }
    return c.json({ok: true, fileId, rawHash: extraction.rawSha256, status: extraction.status, extraction, bindingId}, 201);
  });

  // ---------- 旧方式の原本の引き継ぎ ----------
  app.post('/api/sales-import/files/takeover', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const {input, error} = await readBody(c);
    if (error) return error;
    const artifactId = positiveInt(input.artifactId);
    if (!artifactId) return bad(c, '引き継ぐ原本を確かめてください');
    const artifact = await db.get("SELECT id, project_id, work_id, file_name, media_type, byte_length, raw_sha256, extractor_name, extractor_version, extraction_status FROM workflow_raw_artifacts WHERE org_id=? AND id=? AND kind='sales_report'", [i.org_id, artifactId]);
    if (!artifact) return bad(c, '売上の原本が見つかりません', 404);
    if (!await settlementWork(i, artifact.work_id)) return bad(c, '売上原本への権限がありません', 403);
    const already = await fileByLegacyArtifact(db, i.org_id, artifactId);
    if (already) return c.json({ok: true, fileId: already.id, existing: true});
    if (await db.get('SELECT 1 FROM workflow_report_commits WHERE org_id=? AND artifact_id=?', [i.org_id, artifactId])) return bad(c, 'この原本は旧方式で登録済みです。引き継げません', 409);
    let target = null;
    let targetWork = null;
    if (input.binding != null) {
      const normalized = normalizeBinding(input.binding);
      if (normalized.error) return bad(c, normalized.error);
      if (normalized.binding.mode !== 'single_work') return bad(c, '列で作品を分けるときは、引き継いだあとで割り当てます');
      if (normalized.binding.workId !== Number(artifact.work_id)) {
        target = normalized.binding;
        targetWork = await settlementWork(i, target.workId);
        if (!targetWork) return bad(c, '付け替え先の作品の財務権限がありません', 403);
        const reason = String(input.reason ?? '').trim();
        if (!reason || reason.length > 500) return bad(c, '付け替える理由を書いてください（500文字まで）');
        target.reason = reason;
      }
    }
    const legacySelection = await db.get('SELECT * FROM workflow_report_selections WHERE org_id=? AND artifact_id=? ORDER BY version_no DESC LIMIT 1', [i.org_id, artifactId]);
    let excluded = [];
    if (legacySelection) {
      const log = await db.get("SELECT detail_json FROM audit_log WHERE org_id=? AND action='exclude_rows' AND entity_type='workflow_report_selection' AND entity_id=? ORDER BY id DESC LIMIT 1", [i.org_id, String(legacySelection.id)]);
      excluded = log ? parseJson(log.detail_json, {}).excluded || [] : [];
    }
    const fileId = await nextId('sales_source_files');
    const bindingId = await nextId('sales_source_bindings');
    const statements = [
      {sql: 'INSERT INTO sales_source_files(id,org_id,storage,file_name,media_type,byte_length,raw_sha256,original_base64,extraction_json,extractor_name,extractor_version,extraction_status,legacy_artifact_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [fileId, i.org_id, 'legacy_artifact', artifact.file_name, artifact.media_type, artifact.byte_length, artifact.raw_sha256, null, null, artifact.extractor_name, artifact.extractor_version, artifact.extraction_status, artifactId, i.user_id]},
      {sql: 'INSERT INTO sales_source_bindings(id,org_id,file_id,version_no,mode,project_id,work_id,product_column,work_column,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        params: [bindingId, i.org_id, fileId, 1, 'single_work', artifact.project_id, artifact.work_id, null, null, TAKEOVER_REASON, i.user_id]},
    ];
    if (legacySelection) {
      statements.push({sql: 'INSERT INTO sales_source_selections(id,org_id,file_id,version_no,sheet_name,header_row,canonical_csv,canonical_sha256,source_rows_json,excluded_json,suggestions_json,suggestion_source,legacy_selection_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [await nextId('sales_source_selections'), i.org_id, fileId, 1, legacySelection.sheet_name, legacySelection.header_row, legacySelection.canonical_csv, legacySelection.canonical_sha256, legacySelection.source_rows_json, json(excluded), legacySelection.suggestions_json, legacySelection.suggestion_source, legacySelection.id, i.user_id]});
    }
    if (target) {
      statements.push({sql: 'INSERT INTO sales_source_bindings(id,org_id,file_id,version_no,mode,project_id,work_id,product_column,work_column,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        params: [bindingId + 1, i.org_id, fileId, 2, 'single_work', targetWork.project_id, target.workId, null, null, target.reason, i.user_id]});
    }
    statements.push(audit(i, 'takeover_source', fileId, artifact.raw_sha256, {artifactId, workId: artifact.work_id, selectionId: legacySelection?.id ?? null, rebind: target ? {workId: target.workId, reason: target.reason} : null}));
    try { await db.batch(statements); } catch (failure) { return bad(c, `原本を引き継げませんでした: ${failure.message}`, 409); }
    return c.json({ok: true, fileId, bindingId: target ? bindingId + 1 : bindingId, existing: false}, 201);
  });

  // ---------- 一覧・詳細 ----------
  app.get('/api/sales-import/files', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const page = await pendingSourceFilePage(ctx, i, {limit: c.req.query('limit') || 20});
    return c.json({ok: true, rows: page.rows, total: page.total, limit: page.limit});
  });

  app.get('/api/sales-import/files/:id', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const {file, response} = await loadFile(c, i);
    if (response) return response;
    const [extraction, bindings, plan, works, finance, commitTerms] = await Promise.all([
      fileExtraction(db, i.org_id, file),
      db.all('SELECT * FROM sales_source_bindings WHERE org_id=? AND file_id=? ORDER BY version_no DESC', [i.org_id, file.id]),
      currentPlan(db, i.org_id, file.id),
      worksOf(i),
      financeProjects(i),
      fileCommitTerms(db, i.org_id, file.id),
    ]);
    const permitted = permittedBy(i, finance);
    const creators = new Map((await db.all('SELECT u.id, u.display_name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.org_id=?', [i.org_id])).map((row) => [Number(row.id), row.display_name]));
    return c.json({
      ok: true,
      file: {id: file.id, fileName: file.file_name, rawHash: file.raw_sha256, byteLength: file.byte_length, storage: file.storage, legacyArtifactId: file.legacy_artifact_id, status: file.extraction_status, createdAt: file.created_at, createdByName: creators.get(Number(file.created_by)) || null, extraction},
      bindings: bindings.map((row) => ({...bindingView(row, works, permitted), createdByName: creators.get(Number(row.created_by)) || null})),
      binding: bindingView(plan.bindingRow, works, permitted),
      selection: selectionFromRow(plan.selectionRow),
      partitions: plan.partitions.map((row) => {
        const work = works.find((item) => Number(item.id) === Number(row.work_id));
        const visible = permitted(work);
        return {id: row.id, workId: row.work_id, ...workLabel(work, visible), restricted: !visible, rowCount: row.row_count,
          committed: row.commit ? {reportId: visible ? row.commit.report_id : null, committedAt: row.commit.created_at} : null};
      }),
      progress: plan.progress,
      canRebind: plan.commits.length === 0,
      // 登録を始めた原本の登録条件（最初の登録の取引先・報告の種類・列対応の版）。続きの作品も同じ取引先・種類で登録する
      commitTerms,
    });
  });

  // ---------- 表の選択 ----------
  app.post('/api/sales-import/files/:id/selection', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const {file, response} = await loadFile(c, i);
    if (response) return response;
    const {input, error} = await readBody(c);
    if (error) return error;
    if (await db.get('SELECT 1 FROM sales_source_commits WHERE org_id=? AND file_id=?', [i.org_id, file.id])) return bad(c, '登録を始めた原本は、見出しの行や取り込まない行を変えられません。登録した報告を直すときは訂正版を取り込みます', 409);
    const extraction = await fileExtraction(db, i.org_id, file);
    if (!extraction) return bad(c, '原本の抽出結果を読めません', 409);
    const sheet = (extraction.sheets || []).find((item) => item.name === input.sheetName);
    if (!sheet) return bad(c, '選んだシートがありません');
    const headerRow = positiveInt(input.headerRow);
    if (!headerRow || headerRow > (sheet.rows || []).length) return bad(c, '見出しの行が範囲外です');
    const built = buildSelection(sheet.rows, headerRow, input.excludedRows);
    if (built.error) return bad(c, built.error, built.status || 422, built.details);
    // 上限: 1回の登録（報告1件）の行数は、作品ごとに分けたあとの作品ごとに確かめる（分割・プレビュー）。ここでは原本の表全体として
    // 保存できる大きさ（行数・UTF-8のバイト数。クラウドの大きな選択は R2 に退避する）だけを見る。1つの作品に割り当てた原本は、
    // 表全体がそのまま1件の報告になるので、ここで登録1回の上限も案内する。
    const limits = importLimits(mode);
    const single = (await latestBindingRow(db, i.org_id, file.id))?.mode === 'single_work';
    if (single && built.dataRows.length > limits.salesRows) return bad(c, `1回に取り込めるのは${limits.salesRows.toLocaleString('ja-JP')}行までです（${limitReason(mode)}）。ファイルを分けるか、作品コード・商品コードの列で作品ごとに分けてください`, 413, {rows: built.dataRows.length, limit: limits.salesRows});
    if (built.dataRows.length > limits.sourceRows) return bad(c, `1つの原本で扱えるのは${limits.sourceRows.toLocaleString('ja-JP')}行までです（${limitReason(mode)}）。ファイルを分けてください`, 413, {rows: built.dataRows.length, limit: limits.sourceRows});
    const csvBytes = utf8Bytes(built.canonicalCsv);
    if (csvBytes > limits.sourceBytes) return bad(c, `取り込む表が大きすぎます（${kbText(csvBytes)}。上限は${kbText(limits.sourceBytes)}。${limitReason(mode)}）。ファイルを分けてください`, 413, {bytes: csvBytes, limit: limits.sourceBytes});
    let mappings = null;
    let mappingVersionId = null;
    if (input.mappingVersionId != null && input.mappingVersionId !== '') {
      mappingVersionId = positiveInt(input.mappingVersionId);
      const version = mappingVersionId ? await db.get('SELECT definition_json FROM report_mapping_versions WHERE org_id=? AND id=?', [i.org_id, mappingVersionId]) : null;
      if (!version) return bad(c, '列対応の版が見つかりません', 404);
      mappings = parseJson(version.definition_json, {}).mappings || [];
    }
    const excluded = built.excluded.map((row) => {
      const values = Object.fromEntries(built.headers.map((header, index) => [header, String(row.cells[index] ?? '').trim()]));
      const amounts = mappings ? amountsOf(mappings, values) : {amountExTax: null, taxAmount: null, amountIncTax: null};
      return {sourceRow: row.sourceRow, reason: row.reason, ...amounts};
    });
    const totals = exclusionTotals(excluded);
    const canonicalHash = await sha256(built.canonicalCsv);
    const suggestions = suggestionList(built.headers, built.dataRows.slice(0, 20).map((row) => row.cells));
    const id = await nextId('sales_source_selections');
    const versionNo = Number((await db.get('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM sales_source_selections WHERE org_id=? AND file_id=?', [i.org_id, file.id])).n);
    const statements = [
      noCommitGuard(i, file.id),
      {sql: 'INSERT INTO sales_source_selections(id,org_id,file_id,version_no,sheet_name,header_row,canonical_csv,canonical_sha256,source_rows_json,excluded_json,suggestions_json,suggestion_source,legacy_selection_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [id, i.org_id, file.id, versionNo, sheet.name, headerRow, built.canonicalCsv, canonicalHash, json(built.sourceRowNumbers), json(excluded), json(suggestions), 'rule-based', null, i.user_id]},
    ];
    if (excluded.length) statements.push({
      sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)',
      params: [i.org_id, i.user_id, 'exclude_rows', 'sales_source_selection', String(id), canonicalHash, json({fileId: file.id, sheetName: sheet.name, headerRow, dataRows: built.allRows, mappingVersionId, excluded, totals})],
    });
    try { await db.batch(statements); } catch (failure) { return bad(c, `表の選択を保存できませんでした: ${failure.message}`, 409); }
    return c.json({
      ok: true, fileId: file.id, selectionId: id, versionNo, sheetName: sheet.name, headerRow, headers: built.headers, canonicalCsv: built.canonicalCsv, canonicalHash,
      sourceRowNumbers: built.sourceRowNumbers, suggestions, suggestionSource: 'rule-based', dataRows: built.allRows, excluded: {rows: excluded, ...totals},
    }, 201);
  });

  // ---------- 割り当て（付け替え） ----------
  app.post('/api/sales-import/files/:id/bindings', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const {file, response} = await loadFile(c, i);
    if (response) return response;
    const {input, error} = await readBody(c);
    if (error) return error;
    if (await db.get('SELECT 1 FROM sales_source_commits WHERE org_id=? AND file_id=?', [i.org_id, file.id])) return bad(c, '登録済みの作品がある原本は付け替えられません。登録した報告を直すときは訂正版を取り込みます', 409);
    const selection = await latestSelectionRow(db, i.org_id, file.id);
    const requestedMode = String(input.mode ?? '');
    if (requestedMode && requestedMode !== 'single_work' && !selection) return bad(c, '列で作品を分けるときは、先に見出しの行を確かめてください', 409);
    const headers = selection ? selectionTable(selection.canonical_csv, parseJson(selection.source_rows_json, [])).headers : null;
    const normalized = normalizeBinding(input, headers);
    if (normalized.error) return bad(c, normalized.error);
    const next = normalized.binding;
    let work = null;
    if (next.mode === 'single_work') {
      work = await settlementWork(i, next.workId);
      if (!work) return bad(c, '作品の財務権限がありません', 403);
    }
    const latest = await latestBindingRow(db, i.org_id, file.id);
    const works = await worksOf(i);
    const permitted = permittedBy(i, await financeProjects(i));
    if (input.expectedVersion != null && Number(input.expectedVersion) !== Number(latest?.version_no ?? 0)) return bad(c, '別の人が先に割り当てを変えました。読み直してください', 409, {current: bindingView(latest, works, permitted)});
    if (latest && sameBinding(bindingFromRow(latest), next)) return c.json({ok: true, unchanged: true, binding: bindingView(latest, works, permitted)});
    let reason = String(input.reason ?? '').trim();
    if (latest && !reason) return bad(c, '付け替える理由を書いてください（500文字まで）');
    if (reason.length > 500) return bad(c, '付け替える理由は500文字までです');
    if (!reason) reason = DEFAULT_BINDING_REASON;
    const id = await nextId('sales_source_bindings');
    const versionNo = Number(latest?.version_no ?? 0) + 1;
    const before = latest ? bindingFromRow(latest) : null;
    try {
      await db.batch([
        noCommitGuard(i, file.id),
        {sql: 'INSERT INTO sales_source_bindings(id,org_id,file_id,version_no,mode,project_id,work_id,product_column,work_column,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          params: [id, i.org_id, file.id, versionNo, next.mode, work?.project_id ?? null, next.workId, next.productColumn, next.workColumn, reason, i.user_id]},
        audit(i, latest ? 'rebind_source' : 'bind_source', file.id, file.raw_sha256, {before, after: {...next, versionNo}, reason}),
      ]);
    } catch (failure) {
      return bad(c, `付け替えられませんでした（登録が始まったか、別の人が先に付け替えた可能性があります）: ${failure.message}`, 409);
    }
    return c.json({ok: true, unchanged: false, binding: bindingView(await latestBindingRow(db, i.org_id, file.id), works, permitted)}, 201);
  });

  // ---------- 作品ごとの分割 ----------
  // 登録を始めた原本は分け方が決まっているので、要求の割り当て・報告を置く作品に関係なく、登録を始めた分け方を返す（続きから登録するため）。
  app.post('/api/sales-import/files/:id/partitions', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const {file, response} = await loadFile(c, i);
    if (response) return response;
    const {input, error} = await readBody(c);
    if (error) return error;
    const dryRun = input.dryRun === true;
    const selectionRow = await latestSelectionRow(db, i.org_id, file.id);
    if (!selectionRow) return bad(c, '先に見出しの行を確かめてください', 409);
    const table = selectionTable(selectionRow.canonical_csv, parseJson(selectionRow.source_rows_json, []));
    const bindingRow = await latestBindingRow(db, i.org_id, file.id);
    const plan = await currentPlan(db, i.org_id, file.id);
    const locked = plan.commits.length > 0;
    if (!locked && input.selectionId != null && Number(input.selectionId) !== Number(selectionRow.id)) return bad(c, '表の選択が新しくなっています。読み直してください', 409);
    let binding;
    if (!locked && dryRun && input.binding != null) {
      const normalized = normalizeBinding(input.binding, table.headers);
      if (normalized.error) return bad(c, normalized.error);
      binding = normalized.binding;
    } else {
      if (!bindingRow) return bad(c, '作品の決め方（割り当て）がまだありません', 409);
      if (!locked && input.bindingId != null && Number(input.bindingId) !== Number(bindingRow.id)) return bad(c, '割り当てが新しくなっています。読み直してください', 409);
      binding = bindingFromRow(bindingRow);
    }
    const kind = input.kind == null || input.kind === '' ? null : String(input.kind);
    if (kind && !SALES_KINDS.includes(kind)) return bad(c, '報告の種類を確かめてください');
    const reportWorks = input.reportWorks && typeof input.reportWorks === 'object' && !Array.isArray(input.reportWorks) ? input.reportWorks : {};
    const [products, allocations, works, finance] = await Promise.all([
      db.all('SELECT id, sku, name, channel FROM products WHERE org_id=? ORDER BY id', [i.org_id]),
      db.all('SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=? ORDER BY product_id, work_id', [i.org_id]),
      worksOf(i),
      financeProjects(i),
    ]);
    const workById = new Map(works.map((work) => [Number(work.id), work]));
    const permitted = (workId) => {
      const work = workById.get(Number(workId));
      return Boolean(work) && (i.role === 'admin' || finance.has(Number(work.project_id)));
    };
    let mappings = null;
    if (input.mappingVersionId != null && input.mappingVersionId !== '') {
      const version = await db.get('SELECT definition_json FROM report_mapping_versions WHERE org_id=? AND id=?', [i.org_id, positiveInt(input.mappingVersionId)]);
      if (!version) return bad(c, '列対応の版が見つかりません', 404);
      mappings = parseJson(version.definition_json, {}).mappings || [];
    }
    const planned = locked
      ? {partitions: plan.partitions.map((row) => ({workId: Number(row.work_id), projectId: Number(row.project_id), sourceRows: parseJson(row.source_rows_json, []), productMap: parseJson(row.product_map_json, [])})), unmatched: [], errors: []}
      : planPartitions({table, binding, products, allocations, works, kind, reportWorks});
    const planHash = locked ? plan.planSha : await sha256(planKey(binding, planned.partitions));
    // 商品のいまの配賦（登録を始めた分け方の写しが古くても、権限はいまの配賦先で数える。集計の按分もいまの配賦で行うため）
    const sharesOf = (productId) => allocations.filter((row) => Number(row.product_id) === Number(productId)).map((row) => ({workId: Number(row.work_id), bps: Number(row.allocation_bps)}));
    const restrictedWorks = new Set();
    const views = [];
    for (const partition of planned.partitions) {
      const involved = [partition.workId, ...partition.productMap.flatMap((item) => sharesOf(item.productId).map((share) => share.workId))];
      for (const id of involved) if (!permitted(id)) restrictedWorks.add(id);
      const visible = permitted(partition.workId);
      const built = partitionCsv(table, partition, binding);
      let amounts = null;
      if (mappings) {
        amounts = {amountExTax: 0, taxAmount: 0, amountIncTax: 0, unknownAmountRows: 0};
        for (const row of selectionTable(built.csv, built.sourceRowNumbers).rows) {
          const values = Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, String(value).trim()]));
          const found = amountsOf(mappings, values);
          // 計算できない金額は0円にせず、行数だけを数えて保留として示す
          if (!Number.isFinite(found.amountExTax)) { amounts.unknownAmountRows += 1; continue; }
          amounts.amountExTax += found.amountExTax;
          amounts.taxAmount += Number.isFinite(found.taxAmount) ? found.taxAmount : 0;
          amounts.amountIncTax += Number.isFinite(found.amountIncTax) ? found.amountIncTax : 0;
        }
      }
      const work = workById.get(partition.workId);
      views.push({
        workId: partition.workId, workCode: visible ? work?.code ?? null : null, workTitle: visible ? work?.title ?? null : null, restricted: !visible,
        rowCount: partition.sourceRows.length, sourceRowNumbers: partition.sourceRows.map(Number),
        products: partition.productMap.map((item) => ({code: item.code, productId: item.productId, sku: item.sku, name: item.name, rows: item.rows,
          allocations: sharesOf(item.productId).map((share) => ({workId: share.workId, bps: share.bps, workTitle: permitted(share.workId) ? workById.get(share.workId)?.title ?? null : null}))})),
        amounts, headers: visible ? built.headers : null, csv: visible ? built.csv : null, partitionHash: await sha256(built.csv),
        productMap: partition.productMap, projectId: partition.projectId ?? Number(work?.project_id ?? 0), sourceRows: partition.sourceRows,
      });
    }
    const unmatchedTotal = planned.unmatched.length;
    const errors = locked ? [] : [...planned.errors, ...partitionProblems({views, mappings, kind, products, allocations, mode})];
    const summary = {rows: table.rows.length, matched: table.rows.length - unmatchedTotal, unmatched: unmatchedTotal, works: views.length};
    const publicView = (view, persisted = null) => {
      const {productMap, projectId, sourceRows, ...rest} = view;
      return {...rest, id: persisted?.id ?? null, committed: persisted?.commit ? {reportId: view.restricted ? null : persisted.commit.report_id, committedAt: persisted.commit.created_at} : null};
    };
    const base = {bindingId: bindingRow?.id ?? null, bindingVersion: bindingRow?.version_no ?? null, selectionId: selectionRow.id, selectionVersion: selectionRow.version_no,
      binding, planHash, locked, summary, unmatched: planned.unmatched, errors, restrictedCount: restrictedWorks.size};
    if (locked) {
      const byWork = new Map(plan.partitions.map((row) => [Number(row.work_id), row]));
      return c.json({ok: true, saved: true, ...base, partitions: views.map((view) => publicView(view, byWork.get(view.workId)))});
    }
    if (dryRun || errors.length || unmatchedTotal) {
      return c.json({ok: !errors.length && !unmatchedTotal && !restrictedWorks.size && views.length > 0, saved: false, ...base, partitions: views.map((view) => publicView(view))});
    }
    if (!views.length) return bad(c, '分ける行がありません', 409);
    if (restrictedWorks.size) return bad(c, `権限のない作品（${restrictedWorks.size}作品）に割り当たる行があります。管理者に確認してください`, 403, {restrictedCount: restrictedWorks.size});
    const findPersisted = () => db.all('SELECT * FROM sales_source_partitions WHERE org_id=? AND file_id=? AND binding_id=? AND selection_id=? AND plan_sha256=? ORDER BY work_id', [i.org_id, file.id, bindingRow.id, selectionRow.id, planHash]);
    let persisted = await findPersisted();
    if (!persisted.length) {
      const limit = importLimits(mode).batchStatements;
      if (views.length + 2 > limit) return bad(c, `1回に分けられる作品は${limit - 2}作品までです（${limitReason(mode)}）。ファイルを分けてください`, 413);
      let id = await nextId('sales_source_partitions');
      const statements = [noCommitGuard(i, file.id)];
      for (const view of views) {
        statements.push({sql: 'INSERT INTO sales_source_partitions(id,org_id,file_id,selection_id,binding_id,plan_sha256,project_id,work_id,row_count,source_rows_json,product_map_json,partition_sha256,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          params: [id, i.org_id, file.id, selectionRow.id, bindingRow.id, planHash, view.projectId, view.workId, view.rowCount, json(view.sourceRows), json(view.productMap), view.partitionHash, i.user_id]});
        id += 1;
      }
      statements.push(audit(i, 'partition_source', file.id, planHash, {bindingId: bindingRow.id, selectionId: selectionRow.id, kind, works: views.map((view) => ({workId: view.workId, rows: view.rowCount}))}));
      try { await db.batch(statements); } catch (failure) { return bad(c, `作品ごとに分けられませんでした（割り当てか表の選択が同時に変わった可能性があります）: ${failure.message}`, 409); }
      persisted = await findPersisted();
    }
    const byWork = new Map(persisted.map((row) => [Number(row.work_id), {...row, commit: null}]));
    return c.json({ok: true, saved: true, ...base, partitions: views.map((view) => publicView(view, byWork.get(view.workId)))});
  });
}

export const salesSourceInternals = {DEFAULT_BINDING_REASON, TAKEOVER_REASON, usesResolvedProduct, exclusionSummary};
