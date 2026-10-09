// 売上報告の取込ウィザードのAPI。既存の原本保存・列対応の版・プレビュー・登録（/api/workflow/*、/api/mapping-profiles*、
// /api/mapped-imports/*）の上に、次を足す。
// - 前回の取込と、取引先×報告の種類の最新の列対応（手順1・3の初期値）
// - 取り込まない行（理由必須）を除いた表の選択版。除いた行番号・理由・件数・金額を監査に残す
// - 同じ取引先×対象期間の重なり×報告の種類の既存報告（重複検出）。登録は、訂正版か理由つきの別報告のときだけ通す
// - 登録結果（DBから読み直した報告・件数・合計・除外の記録）
// 制作担当は 403。作品の財務権限がない報告は返さない。node:* は使わない（Worker でも動く）。
import {importLimits, limitReason, utf8Bytes, kbText, reportByteLimit} from './limits.mjs';
import {suggestionList} from './column-synonyms.mjs';
import {headerProblems} from './header-detect.mjs';
import {parseCsv} from '../csv.mjs';
import {amountsOf, exclusionTotals, evaluateChecks, validateChecks, selectionRows, overlapDecisionProblem, isIsoDate} from './wizard-model.mjs';
import {fileByHash, fileAccess, currentPlan, isTakenOver, pendingSourceFilePage, sourceCommitForReport, sameFileReportIds, exclusionSummary, partitionWorksPermitted, siblingPartitions,
  financeProjectSet, fileCommitTerms, commitTermsProblem} from './sales-source-store.mjs';
import {commitProgress} from './source-partition.mjs';
import {attributeTargetKey} from '../sales-sheet/column-registry.mjs';

export const SALES_REPORT_KINDS = Object.freeze(['digital', 'package', 'theatrical', 'broadcast', 'other']);
import {labelOf} from '../ui/labels.mjs';
const json = JSON.stringify;
const positiveInt = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const csvCell = (value) => {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const toCsv = (rows) => rows.map((row) => row.map(csvCell).join(',')).join('\r\n');

// 原本のシートから、見出し行と取り込まない行を指定して表を作る（既存の原本選択と同じ規則: 見出しは空欄・重複なし、
// 欠けた値を空欄と推測しない）。右端の見出しが空で値もない列だけは落とす。
export function buildSelection(sheetRows, headerRow, excludedInput = []) {
  const rows = (sheetRows || []).slice(headerRow - 1).map((row) => (Array.isArray(row) ? row : []).map((value) => String(value ?? '')));
  const rawHeaders = (rows[0] || []).map((value) => value.trim());
  let width = rawHeaders.length;
  while (width > 0 && !rawHeaders[width - 1]) width -= 1;
  const headers = rawHeaders.slice(0, width);
  const problems = headerProblems(headers);
  if (!headers.length || problems.length) return {error: '見出しの行に空欄か同じ名前の列があります。見出しの行を選び直してください', status: 422, details: problems.length ? problems : [{message: 'この行には見出しがありません'}]};
  const data = rows.slice(1).map((cells, index) => ({cells, sourceRow: headerRow + index + 1})).filter((row) => row.cells.some((value) => value.trim()));
  const bySource = new Map(data.map((row) => [row.sourceRow, row]));
  const list = Array.isArray(excludedInput) ? excludedInput : [];
  if (list.length > 500) return {error: '取り込まない行は500行までです', status: 400};
  const excluded = [];
  const seen = new Set();
  for (const item of list) {
    const sourceRow = positiveInt(item?.sourceRow);
    const reason = String(item?.reason ?? '').trim();
    if (!sourceRow || !bySource.has(sourceRow)) return {error: `${item?.sourceRow ?? ''}行目は明細の行ではありません`, status: 400};
    if (seen.has(sourceRow)) return {error: `${sourceRow}行目が2回指定されています`, status: 400};
    if (!reason) return {error: `${sourceRow}行目を取り込まない理由を書いてください`, status: 400};
    if (reason.length > 200) return {error: `${sourceRow}行目の理由は200文字以内にしてください`, status: 400};
    seen.add(sourceRow);
    excluded.push({sourceRow, reason, cells: bySource.get(sourceRow).cells});
  }
  const kept = data.filter((row) => !seen.has(row.sourceRow));
  if (!kept.length) return {error: '取り込む行がありません。取り込まない行の指定を見直してください', status: 400};
  const wide = kept.filter((row) => row.cells.slice(width).some((value) => value.trim()));
  if (wide.length) return {error: '見出しのない列に値がある行があります。見出しの行を選び直すか、その行を取り込まない行にしてください', status: 422, details: wide.map((row) => ({row: row.sourceRow, message: '見出しより右の列に値があります'}))};
  const short = kept.filter((row) => row.cells.length < width);
  if (short.length) return {error: '列の数が見出しより少ない行があります（欠けた値を空欄とは推測しません）。その行を取り込まない行にするか、原本を確かめてください', status: 422, details: short.map((row) => ({row: row.sourceRow, message: `値のある列が${row.cells.length}列（見出しは${width}列）`}))};
  const canonicalCsv = toCsv([headers, ...kept.map((row) => row.cells.slice(0, width))]);
  return {headers, width, canonicalCsv, dataRows: kept, sourceRowNumbers: kept.map((row) => row.sourceRow), allRows: data.length, excluded};
}

function headersOf(csvText) {
  try {
    const parsed = parseCsv(csvText);
    return Object.keys(parsed[0]?.values || {});
  } catch {
    return [];
  }
}

export function registerSalesImportRoutes(app, ctx) {
  const {db, bad, body, mode = 'local', sha256, nowIso, permittedProjects, settlementWork, commitImport} = ctx;
  if (!app || !db) throw new Error('sales import routes require app and db');
  const deny = (c, i) => (i.role === 'production' ? bad(c, '売上の取込は財務担当の画面です', 403) : null);

  async function financeProjectIds(i) {
    return new Set((await permittedProjects(db, i, true)).map((row) => Number(row.id)));
  }
  async function financeWorks(i) {
    const allowed = await financeProjectIds(i);
    return (await db.all('SELECT id, project_id, code, title FROM works WHERE org_id=? ORDER BY id', [i.org_id])).filter((work) => allowed.has(Number(work.project_id)));
  }

  // 報告の要約（件数・合計つき）。作品の財務権限がある報告だけを返す。
  async function reportSummaries(i, where, params, limit = 50) {
    const allowed = await financeProjectIds(i);
    const rows = await db.all(`SELECT r.id, r.work_id, r.partner_id, r.report_key, r.kind, r.period_from, r.period_to, r.accounting_month, r.status,
        r.supersedes_id, r.created_at, r.created_by, w.title AS work_title, w.project_id, p.name AS partner_name, p.code AS partner_code, u.display_name AS created_by_name,
        COALESCE(t.n, 0) AS line_count, COALESCE(t.ex, 0) AS amount_ex_tax, COALESCE(t.tax, 0) AS tax_amount, COALESCE(t.inc, 0) AS amount_inc_tax
      FROM report_imports r
      JOIN works w ON w.org_id=r.org_id AND w.id=r.work_id
      LEFT JOIN partners p ON p.org_id=r.org_id AND p.id=r.partner_id
      LEFT JOIN users u ON u.id=r.created_by
      LEFT JOIN (SELECT report_id, COUNT(*) AS n, SUM(amount_ex_tax) AS ex, SUM(tax_amount) AS tax, SUM(amount_inc_tax) AS inc FROM sale_lines WHERE org_id=? GROUP BY report_id) t ON t.report_id=r.id
      WHERE r.org_id=? AND r.kind<>'publicity' ${where.length ? `AND ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?`, [i.org_id, i.org_id, ...params, limit]);
    return rows.filter((row) => allowed.has(Number(row.project_id))).map((row) => ({
      id: row.id, workId: row.work_id, workTitle: row.work_title, partnerId: row.partner_id, partnerName: row.partner_name, partnerCode: row.partner_code,
      reportKey: row.report_key, kind: row.kind, periodFrom: row.period_from, periodTo: row.period_to, accountingMonth: row.accounting_month,
      status: row.status, supersedesId: row.supersedes_id, createdAt: row.created_at, createdByName: row.created_by_name,
      lineCount: Number(row.line_count), totals: {amountExTax: Number(row.amount_ex_tax), taxAmount: Number(row.tax_amount), amountIncTax: Number(row.amount_inc_tax)},
    }));
  }

  async function findOverlaps(i, {workId, partnerId, kind, from, to}, {otherWorks = false} = {}) {
    return reportSummaries(i, [otherWorks ? 'r.work_id<>?' : 'r.work_id=?', 'r.partner_id=?', 'r.kind=?', "r.status='active'", 'r.period_from<=?', 'r.period_to>=?'], [workId, partnerId, kind, to, from], 50);
  }

  async function exclusionRecord(i, selectionId) {
    const row = await db.get("SELECT detail_json, at FROM audit_log WHERE org_id=? AND action='exclude_rows' AND entity_type='workflow_report_selection' AND entity_id=? ORDER BY id DESC LIMIT 1", [i.org_id, String(selectionId)]);
    if (!row) return null;
    try {
      const detail = JSON.parse(row.detail_json);
      return {rows: detail.excluded || [], ...(detail.totals || exclusionTotals(detail.excluded || [])), recordedAt: row.at};
    } catch {
      return null;
    }
  }

  async function mappingFor(i, partnerId, kind) {
    const latest = await db.get(`SELECT v.id, v.version_no, v.definition_json, v.created_at, p.id AS profile_id, p.name AS profile_name
      FROM report_mapping_versions v JOIN report_mapping_profiles p ON p.org_id=v.org_id AND p.id=v.profile_id
      WHERE v.org_id=? AND p.partner_id=? AND p.kind=? ORDER BY v.id DESC LIMIT 1`, [i.org_id, partnerId, kind]);
    const profile = latest
      ? {id: latest.profile_id, name: latest.profile_name}
      : await db.get('SELECT id, name FROM report_mapping_profiles WHERE org_id=? AND partner_id=? AND kind=? ORDER BY id DESC LIMIT 1', [i.org_id, partnerId, kind]);
    let definition = null;
    if (latest) try { definition = JSON.parse(latest.definition_json); } catch { definition = null; }
    return {
      profile: profile ? {id: profile.id, name: profile.name} : null,
      version: latest ? {id: latest.id, versionNo: latest.version_no, createdAt: latest.created_at, definition} : null,
    };
  }

  // 上限（画面に理由と一緒に出す）
  app.get('/api/sales-import/limits', (c) => c.json({ok: true, mode, limits: importLimits(mode), reason: limitReason(mode)}));

  // 手順1・3の文脈: 財務権限のある作品、前回の取込、最新の列対応、前回の検算、登録していない原本
  app.get('/api/sales-import/context', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const works = await financeWorks(i);
    const workId = c.req.query('workId') ? positiveInt(c.req.query('workId')) : null;
    const partnerId = c.req.query('partnerId') ? positiveInt(c.req.query('partnerId')) : null;
    const kind = c.req.query('kind') || null;
    if (c.req.query('workId') && !workId) return bad(c, '作品を確かめてください');
    if (c.req.query('partnerId') && !partnerId) return bad(c, '取引先を確かめてください');
    if (kind && !SALES_REPORT_KINDS.includes(kind)) return bad(c, '報告の種類を確かめてください');
    if (workId && !works.some((work) => Number(work.id) === workId)) return bad(c, '作品への財務権限がありません', 403);
    let recent = [];
    let mapping = {profile: null, version: null};
    let checks = null;
    if (partnerId) {
      if (!await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?', [i.org_id, partnerId])) return bad(c, '取引先が見つかりません', 404);
      recent = await reportSummaries(i, ['r.partner_id=?', ...(kind ? ['r.kind=?'] : [])], [partnerId, ...(kind ? [kind] : [])], 20);
      recent = recent.slice(0, 5);
      if (kind) {
        mapping = await mappingFor(i, partnerId, kind);
        const logs = await db.all("SELECT detail_json FROM audit_log WHERE org_id=? AND action='sales_import' ORDER BY id DESC LIMIT 100", [i.org_id]);
        for (const log of logs) {
          try {
            const detail = JSON.parse(log.detail_json);
            if (Number(detail.partnerId) === partnerId && detail.kind === kind && Array.isArray(detail.checks)) { checks = detail.checks; break; }
          } catch { /* 読めない記録は飛ばす */ }
        }
      }
    }
    const legacyWhere = `FROM workflow_raw_artifacts a WHERE a.org_id=? AND a.work_id=? AND a.kind='sales_report'
        AND NOT EXISTS(SELECT 1 FROM workflow_report_commits x WHERE x.org_id=a.org_id AND x.artifact_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM sales_source_files f WHERE f.org_id=a.org_id AND f.legacy_artifact_id=a.id)`;
    const pending = workId ? await db.all(`SELECT a.id, a.file_name, a.created_at, (SELECT MAX(s.id) FROM workflow_report_selections s WHERE s.org_id=a.org_id AND s.artifact_id=a.id) AS selection_id
        ${legacyWhere} ORDER BY a.id DESC LIMIT 10`, [i.org_id, workId]) : [];
    const pendingTotal = workId ? Number((await db.get(`SELECT COUNT(*) AS n ${legacyWhere}`, [i.org_id, workId]))?.n || 0) : 0;
    // 取込ウィザードで受け取った原本（作品未定・付け替え・分割を含む）のうち、登録し終えていないもの。新しい10件と総数
    const sourcePage = await pendingSourceFilePage(ctx, i, {limit: 10});
    // 売上集計シートの拡張属性の列のうち、組織が採用して使っているもの（取込ウィザードはこの中からだけ列を選ぶ）
    const attributeColumns = (await db.all(`SELECT c.column_key,c.label FROM sales_sheet_column_versions c WHERE c.org_id=? AND c.source_kind='attribute' AND c.active=1
      AND c.version_no=(SELECT MAX(x.version_no) FROM sales_sheet_column_versions x WHERE x.org_id=c.org_id AND x.column_key=c.column_key) ORDER BY c.sort_order,c.column_key`, [i.org_id]))
      .map((row) => ({key: attributeTargetKey(row.column_key), label: row.label}));
    return c.json({
      ok: true, mode, limits: importLimits(mode), limitReason: limitReason(mode),
      works: works.map((work) => ({id: work.id, code: work.code, title: work.title})),
      previous: recent[0] || null, recent, profile: mapping.profile, mapping: mapping.version, checks,
      pending: pending.map((row) => ({artifactId: row.id, fileName: row.file_name, createdAt: row.created_at, selectionId: row.selection_id})),
      pendingTotal,
      sourceFiles: sourcePage.rows, sourceFilesTotal: sourcePage.total,
      attributeTargets: attributeColumns.map((column) => column.key), attributeColumns,
    });
  });

  // 同じ原本（ハッシュが同じファイル）を読み込み済みか。登録済みなら報告、途中なら再開できる原本を返す。
  app.get('/api/sales-import/artifacts/lookup', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const hash = String(c.req.query('sha256') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return bad(c, 'ファイルのハッシュを確かめてください');
    // 取込ウィザードで受け取った原本（旧方式の原本を引き継いだものを含む）を先に探す
    const source = await fileByHash(db, i.org_id, hash);
    if (source) {
      // 見られない理由を分けて返す: 作品未定の、ほかの人が受け取った原本（unbound）か、権限のない作品の原本（restricted）か
      const access = await fileAccess(ctx, i, source);
      if (!access.allowed) return c.json({ok: true, artifact: null, file: null, restricted: true, restrictedReason: access.reason});
      const [plan, works, finance, commitTerms] = await Promise.all([
        currentPlan(db, i.org_id, source.id),
        db.all('SELECT id, project_id, title FROM works WHERE org_id=?', [i.org_id]),
        i.role === 'admin' ? null : financeProjectSet(ctx, i),
        fileCommitTerms(db, i.org_id, source.id),
      ]);
      const work = plan.binding?.workId ? works.find((row) => Number(row.id) === plan.binding.workId) : null;
      // 権限のない作品の題名は、受け取った人にも見せない（分割の一覧・未登録の一覧と同じ扱い）
      const visible = Boolean(work) && (i.role === 'admin' || finance.has(Number(work.project_id)));
      const progress = commitProgress(plan.partitions.map((row) => ({committed: Boolean(row.commit)})));
      return c.json({ok: true, artifact: null, file: {
        id: source.id, fileName: source.file_name, createdAt: source.created_at, storage: source.storage,
        binding: plan.binding ? {...plan.binding, workTitle: visible ? work.title : null, restricted: Boolean(work) && !visible} : null,
        partitions: plan.partitions.length, committed: progress.committed, complete: progress.complete, progressLabel: progress.label,
        reportIds: plan.commits.map((row) => Number(row.report_id)), committedAt: plan.commits.at(-1)?.created_at ?? null, commitTerms,
      }});
    }
    const artifact = await db.get(`SELECT a.id, a.work_id, a.file_name, a.created_at, w.title AS work_title FROM workflow_raw_artifacts a
      JOIN works w ON w.org_id=a.org_id AND w.id=a.work_id WHERE a.org_id=? AND a.kind='sales_report' AND a.raw_sha256=?`, [i.org_id, hash]);
    if (!artifact) return c.json({ok: true, artifact: null, file: null});
    if (!await settlementWork(i, artifact.work_id)) return c.json({ok: true, artifact: null, file: null, restricted: true, restrictedReason: 'restricted'});
    const commit = await db.get('SELECT report_id, committed_at FROM workflow_report_commits WHERE org_id=? AND artifact_id=?', [i.org_id, artifact.id]);
    return c.json({ok: true, file: null, artifact: {id: artifact.id, workId: artifact.work_id, workTitle: artifact.work_title, fileName: artifact.file_name, createdAt: artifact.created_at, committed: Boolean(commit), reportId: commit?.report_id ?? null, committedAt: commit?.committed_at ?? null}});
  });

  // 見出し行と取り込まない行（理由必須）を指定して、原本から表の選択版を作る。除外があれば監査に行番号・理由・金額を残す。
  app.post('/api/sales-import/artifacts/:artifactId/selection', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const artifactId = positiveInt(c.req.param('artifactId'));
    if (!artifactId) return bad(c, '原本を確かめてください');
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const artifact = await db.get("SELECT id, work_id, extraction_json FROM workflow_raw_artifacts WHERE org_id=? AND id=? AND kind='sales_report'", [i.org_id, artifactId]);
    if (!artifact) return bad(c, '売上の原本が見つかりません', 404);
    if (!await settlementWork(i, artifact.work_id)) return bad(c, '売上原本への権限がありません', 403);
    if (await db.get('SELECT 1 FROM workflow_report_commits WHERE org_id=? AND artifact_id=?', [i.org_id, artifactId])) return bad(c, 'この原本は登録済みです。直すときは売上明細から「訂正版を取り込む」を使います', 409);
    if (await isTakenOver(db, i.org_id, artifactId)) return bad(c, 'この原本は取込ウィザードへ引き継いでいます（作品の付け替え・分割ができる新しい取込）。取込ウィザードから続けてください', 409);
    let extraction;
    try { extraction = JSON.parse(artifact.extraction_json); } catch { return bad(c, '原本の抽出結果を読めません', 409); }
    const sheet = (extraction.sheets || []).find((item) => item.name === input.sheetName);
    if (!sheet) return bad(c, '選んだシートがありません');
    const headerRow = positiveInt(input.headerRow);
    if (!headerRow || headerRow > (sheet.rows || []).length) return bad(c, '見出しの行が範囲外です');
    const built = buildSelection(sheet.rows, headerRow, input.excludedRows);
    if (built.error) return bad(c, built.error, built.status || 422, built.details);
    const limits = importLimits(mode);
    if (built.dataRows.length > limits.salesRows) return bad(c, `1回に取り込めるのは${limits.salesRows.toLocaleString('ja-JP')}行までです（${limitReason(mode)}）。ファイルを分けてください`, 413, {rows: built.dataRows.length, limit: limits.salesRows});
    // 旧方式の選択は表全体がそのまま1件の報告になるので、報告1件の上限（UTF-8のバイト数。D1の1行に入る大きさ）で比べる
    const csvBytes = utf8Bytes(built.canonicalCsv);
    const byteLimit = reportByteLimit(limits);
    if (csvBytes > byteLimit) return bad(c, `取り込む表が大きすぎます（${kbText(csvBytes)}。上限は${kbText(byteLimit)}。${limitReason(mode)}）。ファイルを分けてください`, 413, {bytes: csvBytes, limit: byteLimit});
    let mappings = null;
    let mappingVersionId = null;
    if (input.mappingVersionId != null && input.mappingVersionId !== '') {
      mappingVersionId = positiveInt(input.mappingVersionId);
      const version = mappingVersionId ? await db.get('SELECT definition_json FROM report_mapping_versions WHERE org_id=? AND id=?', [i.org_id, mappingVersionId]) : null;
      if (!version) return bad(c, '列対応の版が見つかりません', 404);
      try { mappings = JSON.parse(version.definition_json).mappings || []; } catch { mappings = []; }
    }
    const excluded = built.excluded.map((row) => {
      const values = Object.fromEntries(built.headers.map((header, index) => [header, String(row.cells[index] ?? '').trim()]));
      const amounts = mappings ? amountsOf(mappings, values) : {amountExTax: null, taxAmount: null, amountIncTax: null};
      return {sourceRow: row.sourceRow, reason: row.reason, ...amounts};
    });
    const totals = exclusionTotals(excluded);
    const canonicalHash = await sha256(built.canonicalCsv);
    const suggestions = suggestionList(built.headers, built.dataRows.slice(0, 20).map((row) => row.cells));
    const id = Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM workflow_report_selections')).id);
    const versionNo = Number((await db.get('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM workflow_report_selections WHERE org_id=? AND artifact_id=?', [i.org_id, artifactId])).n);
    const statements = [{
      sql: 'INSERT INTO workflow_report_selections(id,org_id,artifact_id,work_id,version_no,sheet_name,header_row,canonical_csv,canonical_sha256,source_rows_json,suggestions_json,suggestion_source,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      params: [id, i.org_id, artifactId, artifact.work_id, versionNo, sheet.name, headerRow, built.canonicalCsv, canonicalHash, json(built.sourceRowNumbers), json(suggestions), 'rule-based', i.user_id],
    }];
    if (excluded.length) statements.push({
      sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)',
      params: [i.org_id, i.user_id, 'exclude_rows', 'workflow_report_selection', String(id), canonicalHash, json({artifactId, workId: artifact.work_id, sheetName: sheet.name, headerRow, dataRows: built.allRows, mappingVersionId, excluded, totals})],
    });
    try { await db.batch(statements); } catch (error) { return bad(c, `表の選択を保存できませんでした: ${error.message}`, 409); }
    return c.json({
      ok: true, selectionId: id, versionNo, sheetName: sheet.name, headerRow, headers: built.headers, canonicalCsv: built.canonicalCsv, canonicalHash,
      sourceRowNumbers: built.sourceRowNumbers, suggestions, suggestionSource: 'rule-based', dataRows: built.allRows, excluded: {rows: excluded, ...totals},
    }, 201);
  });

  // 重複検出: 同じ作品・取引先・報告の種類で、対象期間が重なる有効な報告。token（確認済みの内容）か、条件を直接指定する。
  app.get('/api/sales-import/overlaps', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    let params;
    const token = c.req.query('token');
    if (token) {
      const record = await db.get('SELECT payload_json FROM import_previews WHERE token=? AND org_id=? AND user_id=?', [token, i.org_id, i.user_id]);
      if (!record) return bad(c, '確認した内容が見つかりません。もう一度「表で確かめる」を行ってください', 404);
      const preview = JSON.parse(record.payload_json);
      if (!preview.meta || preview.kind === 'publicity') return bad(c, '売上報告の確認ではありません', 409);
      params = {workId: preview.workId, partnerId: preview.meta.partner_id, kind: preview.kind, from: preview.meta.period_from, to: preview.meta.period_to, supersedesId: preview.meta.supersedes_id ?? null, sourceFileId: preview.mapping?.sourceFileId ?? null};
    } else {
      params = {workId: positiveInt(c.req.query('workId')), partnerId: positiveInt(c.req.query('partnerId')), kind: c.req.query('kind'), from: c.req.query('from'), to: c.req.query('to'), supersedesId: null};
      if (!params.workId || !params.partnerId) return bad(c, '作品と取引先を指定してください');
      if (!SALES_REPORT_KINDS.includes(params.kind)) return bad(c, '報告の種類を確かめてください');
      if (!isIsoDate(params.from) || !isIsoDate(params.to)) return bad(c, '対象期間は「2026-08-01」の形で指定してください');
      if (params.to < params.from) return bad(c, '対象期間の末日が初日より前です');
    }
    if (!await settlementWork(i, params.workId)) return bad(c, '作品の財務権限がありません', 403);
    const overlaps = await findOverlaps(i, params);
    // 同じ原本を作品ごとに分けて登録した別作品の分は、重複ではなく「同じ原本の別作品分」として分ける
    const sameFileIds = await sameFileReportIds(db, i.org_id, params.sourceFileId);
    const others = await findOverlaps(i, params, {otherWorks: true});
    const otherWorks = others.filter((row) => !sameFileIds.has(Number(row.id)));
    const sameFile = others.filter((row) => sameFileIds.has(Number(row.id)));
    return c.json({ok: true, workId: params.workId, partnerId: params.partnerId, kind: params.kind, period: {from: params.from, to: params.to}, supersedesId: params.supersedesId, overlaps, otherWorks, sameFile});
  });

  // 登録。重なる報告があるときは「訂正版（元の報告を選ぶ）」か「別の報告（理由必須）」のときだけ、既存の登録APIへ渡す。
  // 検算の指定があれば、登録する表で合わない行が残っていないかをサーバーでも確かめる。
  app.post('/api/sales-import/commit', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const token = String(input.token || '');
    const record = await db.get('SELECT payload_json FROM import_previews WHERE token=? AND org_id=? AND user_id=? AND consumed=0 AND expires_at>?', [token, i.org_id, i.user_id, nowIso()]);
    if (!record) return bad(c, '確認した内容がないか、期限切れ・登録済みです。もう一度「表で確かめる」を行ってください', 410);
    const preview = JSON.parse(record.payload_json);
    if (!preview.meta || preview.kind === 'publicity') return bad(c, '売上報告の確認ではありません', 409);
    if (!await settlementWork(i, preview.workId)) return bad(c, '作品の財務権限がありません', 403);
    const checks = input.checks == null ? [] : input.checks;
    const checkErrors = validateChecks(checks, headersOf(preview.raw));
    if (checkErrors.length) return bad(c, checkErrors[0]);
    if (checks.length) {
      const issues = evaluateChecks(checks, selectionRows(preview.raw, preview.mapping?.workflowOriginalRows || []));
      if (issues.length) return bad(c, `検算に合わない行が${issues.length}件あります。取り込まない行にしてから登録してください`, 409, issues.map((issue) => ({row: issue.sourceRow, message: issue.message})));
    }
    // 画面で選んでいる報告の種類・取引先と、確認した内容（列対応の版の種類）が違えば登録しない
    if (input.kind != null && String(input.kind) !== String(preview.kind)) return bad(c, `確認した内容は「${labelOf("reportKind", preview.kind)}」の報告です。報告の種類を変えたときは、手順3からやり直してください`, 409);
    if (input.partnerId != null && Number(input.partnerId) !== Number(preview.meta.partner_id)) return bad(c, '確認した内容と取引先が違います。手順3からやり直してください', 409);
    const meta = preview.meta;
    const overlaps = await findOverlaps(i, {workId: preview.workId, partnerId: meta.partner_id, kind: preview.kind, from: meta.period_from, to: meta.period_to});
    const decision = input.decision && typeof input.decision === 'object' ? {mode: String(input.decision.mode || ''), reason: String(input.decision.reason ?? '').trim()} : null;
    const problem = overlapDecisionProblem(overlaps, decision, meta.supersedes_id);
    if (problem) return bad(c, problem, 409, {overlaps});
    // 受領原本を作品ごとに分けた表: 分割の商品が配賦されている作品すべての財務権限を、登録の直前にも確かめる
    const partitionId = preview.mapping?.sourcePartitionId ?? null;
    if (partitionId) {
      const partition = await db.get('SELECT file_id, work_id, product_map_json FROM sales_source_partitions WHERE org_id=? AND id=?', [i.org_id, partitionId]);
      if (!partition) return bad(c, '原本の分割が見つかりません。割り当てからやり直してください', 409);
      if (!await partitionWorksPermitted(ctx, i, partition)) return bad(c, 'この分割の商品は、権限のない作品にも配賦されています。管理者に確認してください', 403);
      // 1つの原本から分けた報告は、最初の登録と同じ取引先・報告の種類で登録する（同じ batch のトリガーでも止める）
      const terms = await fileCommitTerms(db, i.org_id, partition.file_id);
      const termsProblem = commitTermsProblem(terms, {partnerId: meta.partner_id, kind: preview.kind}, (value) => labelOf('reportKind', value));
      if (termsProblem) return bad(c, termsProblem, 409, {commitTerms: terms});
    }
    // 既存の登録処理を同じ要求の文脈（認証済みの利用者）のまま呼ぶ。HTTPで呼び直すと本番の認証（要求ごとの識別）が引き継がれない
    let response;
    try {
      response = await commitImport(c, {token});
    } catch (error) {
      if (!partitionId) throw error;
      return bad(c, `登録できませんでした（原本の割り当てか表の選択が更新された可能性があります。割り当てからやり直してください）: ${error.message}`, 409);
    }
    const result = await response.json().catch(() => ({ok: false, error: '登録の応答を読めませんでした'}));
    if (!response.ok || result.ok === false) return c.json(result, response.ok ? 409 : response.status);
    const report = await db.get('SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?', [i.org_id, meta.report_key, preview.hash]);
    const selectionId = preview.mapping?.workflowSelectionId ?? null;
    let exclusion = selectionId ? await exclusionRecord(i, selectionId) : null;
    if (partitionId) {
      const selection = await db.get('SELECT excluded_json, created_at FROM sales_source_selections WHERE org_id=? AND id=?', [i.org_id, preview.mapping.sourceSelectionId]);
      let rows = [];
      try { rows = JSON.parse(selection?.excluded_json || '[]'); } catch { rows = []; }
      exclusion = rows.length ? exclusionSummary(rows, selection.created_at) : null;
    }
    const detail = {
      reportId: report?.id ?? null, workId: preview.workId, partnerId: meta.partner_id, kind: preview.kind, period: {from: meta.period_from, to: meta.period_to},
      artifactId: preview.mapping?.workflowArtifactId ?? null, selectionId, mappingVersionId: preview.mapping?.mappingVersionId ?? null, rows: result.rows,
      source: partitionId ? {fileId: preview.mapping.sourceFileId, partitionId, bindingId: preview.mapping.sourceBindingId, selectionId: preview.mapping.sourceSelectionId, planHash: preview.mapping.sourcePlanHash} : null,
      supersedesId: meta.supersedes_id ?? null, overlaps: overlaps.map((row) => row.id), decision: overlaps.length ? decision : null, checks,
      excluded: exclusion ? {count: exclusion.count, amountExTax: exclusion.amountExTax, taxAmount: exclusion.taxAmount, amountIncTax: exclusion.amountIncTax, unknown: exclusion.unknown, rows: exclusion.rows} : null,
    };
    let auditWarning = null;
    try {
      await db.run('INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)',
        [i.org_id, i.user_id, 'sales_import', 'report_import', String(report?.id ?? meta.report_key), preview.hash, json(detail)]);
    } catch {
      auditWarning = '登録は完了しましたが、取込の判断（重なる報告・除外）の記録を残せませんでした。管理者に知らせてください';
    }
    let progress = null;
    if (partitionId) {
      const plan = await currentPlan(db, i.org_id, preview.mapping.sourceFileId);
      progress = {...plan.progress, fileId: preview.mapping.sourceFileId};
    }
    return c.json({ok: true, reportId: report?.id ?? null, rows: result.rows, auditWarning, progress});
  });

  // 登録結果（DBから読み直す）: 報告・件数・合計・原本・除外した行・重なる報告の扱い・訂正の関係
  app.get('/api/sales-import/reports/:reportId', async (c) => {
    const i = c.get('identity');
    const denied = deny(c, i);
    if (denied) return denied;
    const reportId = positiveInt(c.req.param('reportId'));
    if (!reportId) return bad(c, '報告を確かめてください');
    const exists = await db.get('SELECT work_id FROM report_imports WHERE org_id=? AND id=?', [i.org_id, reportId]);
    if (!exists) return bad(c, '報告が見つかりません', 404);
    if (!await settlementWork(i, exists.work_id)) return bad(c, '作品の財務権限がありません', 403);
    const [report] = await reportSummaries(i, ['r.id=?'], [reportId], 1);
    if (!report) return bad(c, '報告が見つかりません', 404);
    const commit = await db.get(`SELECT x.artifact_id, x.selection_id, x.mapping_version_id, x.committed_at, a.file_name, a.raw_sha256, s.sheet_name, s.header_row,
        s.version_no AS selection_version, v.version_no AS mapping_version_no, mp.name AS profile_name
      FROM workflow_report_commits x
      JOIN workflow_raw_artifacts a ON a.org_id=x.org_id AND a.id=x.artifact_id
      JOIN workflow_report_selections s ON s.org_id=x.org_id AND s.id=x.selection_id
      LEFT JOIN report_mapping_versions v ON v.org_id=x.org_id AND v.id=x.mapping_version_id
      LEFT JOIN report_mapping_profiles mp ON mp.org_id=v.org_id AND mp.id=v.profile_id
      WHERE x.org_id=? AND x.report_id=?`, [i.org_id, reportId]);
    let exclusions = commit ? await exclusionRecord(i, commit.selection_id) : null;
    // 取込ウィザードで受け取った原本（作品ごとの分割）から登録した報告
    const sourceCommit = commit ? null : await sourceCommitForReport(db, i.org_id, reportId);
    let split = null;
    if (sourceCommit) {
      let excludedRows = [];
      try { excludedRows = JSON.parse(sourceCommit.excluded_json || '[]'); } catch { excludedRows = []; }
      exclusions = excludedRows.length ? {...exclusionSummary(excludedRows, sourceCommit.selection_at), scope: 'file'} : null;
      const plan = await currentPlan(db, i.org_id, sourceCommit.file_id);
      const siblings = await siblingPartitions(ctx, i, plan, sourceCommit.partition_id);
      split = {fileId: sourceCommit.file_id, mode: sourceCommit.mode, bindingVersion: sourceCommit.binding_version, bindingReason: sourceCommit.binding_reason,
        productColumn: sourceCommit.product_column, workColumn: sourceCommit.work_column, partitions: siblings, progress: plan.progress};
    }
    const log = await db.get("SELECT detail_json, at FROM audit_log WHERE org_id=? AND action='sales_import' AND entity_type='report_import' AND entity_id=? ORDER BY id DESC LIMIT 1", [i.org_id, String(reportId)]);
    let detail = null;
    try { detail = log ? JSON.parse(log.detail_json) : null; } catch { detail = null; }
    const original = report.supersedesId ? (await reportSummaries(i, ['r.id=?'], [report.supersedesId], 1))[0] || null : null;
    const replacedBy = await db.get('SELECT id, report_key, created_at FROM report_imports WHERE org_id=? AND supersedes_id=? ORDER BY id DESC LIMIT 1', [i.org_id, reportId]);
    let observations = 0;
    try { observations = Number((await db.get('SELECT COUNT(DISTINCT source_row) AS n FROM package_report_observations WHERE org_id=? AND report_id=?', [i.org_id, reportId]))?.n || 0); } catch { observations = 0; }
    return c.json({
      ok: true, report, observations, readAt: nowIso(),
      source: commit ? {artifactId: commit.artifact_id, fileName: commit.file_name, rawHash: commit.raw_sha256, sheetName: commit.sheet_name, headerRow: commit.header_row, selectionVersion: commit.selection_version, mappingVersionNo: commit.mapping_version_no, profileName: commit.profile_name, committedAt: commit.committed_at}
        : sourceCommit ? {fileId: sourceCommit.file_id, fileName: sourceCommit.file_name, rawHash: sourceCommit.raw_sha256, sheetName: sourceCommit.sheet_name, headerRow: sourceCommit.header_row, selectionVersion: sourceCommit.selection_version, mappingVersionNo: sourceCommit.mapping_version_no, profileName: sourceCommit.profile_name, committedAt: sourceCommit.committed_at, bindingVersion: sourceCommit.binding_version, rowCount: sourceCommit.row_count}
        : null,
      split,
      exclusions, decision: detail ? {mode: detail.decision?.mode || null, reason: detail.decision?.reason || null, overlaps: detail.overlaps || [], checks: detail.checks || [], recordedAt: log.at} : null,
      original, replacedBy: replacedBy ? {id: replacedBy.id, reportKey: replacedBy.report_key, createdAt: replacedBy.created_at} : null,
    });
  });
}
