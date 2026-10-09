// 受領原本（sales_source_*）の読み出しと、旧経路・登録処理から使う検査文。Worker でも動くよう node:* を import しない。
// 設計: docs/platform/team-development/royalty-committee-design.md §5。
// 大きな列（original_base64・extraction_json）はクラウドでは R2 から読み戻すため、要るときだけ読む。
import {selectionTable, partitionCsv, bindingFromRow, commitProgress, allocationKey} from './source-partition.mjs';
import {allIn} from '../sql-in.mjs';

const FILE_COLUMNS = 'id, org_id, storage, file_name, media_type, byte_length, raw_sha256, extractor_name, extractor_version, extraction_status, legacy_artifact_id, created_by, created_at';

const parseJson = (text, fallback) => {
  try { return JSON.parse(text); } catch { return fallback; }
};

export async function fileRow(db, orgId, fileId) {
  return db.get(`SELECT ${FILE_COLUMNS} FROM sales_source_files WHERE org_id=? AND id=?`, [orgId, fileId]);
}

export async function fileByHash(db, orgId, hash) {
  return db.get(`SELECT ${FILE_COLUMNS} FROM sales_source_files WHERE org_id=? AND raw_sha256=?`, [orgId, hash]);
}

export async function fileByLegacyArtifact(db, orgId, artifactId) {
  return db.get(`SELECT ${FILE_COLUMNS} FROM sales_source_files WHERE org_id=? AND legacy_artifact_id=?`, [orgId, artifactId]);
}

// 抽出結果（旧原本を引き継いだものは旧原本から読む）
export async function fileExtraction(db, orgId, file) {
  const row = file.storage === 'legacy_artifact'
    ? await db.get("SELECT extraction_json FROM workflow_raw_artifacts WHERE org_id=? AND id=? AND kind='sales_report'", [orgId, file.legacy_artifact_id])
    : await db.get('SELECT extraction_json FROM sales_source_files WHERE org_id=? AND id=?', [orgId, file.id]);
  return row ? parseJson(row.extraction_json, null) : null;
}

export async function latestBindingRow(db, orgId, fileId) {
  return db.get('SELECT * FROM sales_source_bindings WHERE org_id=? AND file_id=? ORDER BY version_no DESC LIMIT 1', [orgId, fileId]);
}

export async function latestSelectionRow(db, orgId, fileId) {
  return db.get('SELECT * FROM sales_source_selections WHERE org_id=? AND file_id=? ORDER BY version_no DESC LIMIT 1', [orgId, fileId]);
}

export const selectionFromRow = (row) => (row ? {
  id: Number(row.id), versionNo: Number(row.version_no), sheetName: row.sheet_name, headerRow: Number(row.header_row),
  canonicalCsv: row.canonical_csv, canonicalHash: row.canonical_sha256, sourceRowNumbers: parseJson(row.source_rows_json, []),
  excluded: parseJson(row.excluded_json, []), suggestions: parseJson(row.suggestions_json, []), suggestionSource: row.suggestion_source,
  legacySelectionId: row.legacy_selection_id ?? null, createdAt: row.created_at,
} : null);

// 取り込まない行の記録（選択版に持つ）を、既存の除外の記録と同じ形にする
export function exclusionSummary(rows, recordedAt = null) {
  const list = Array.isArray(rows) ? rows : [];
  const sum = (key) => list.reduce((total, row) => total + (Number.isFinite(row?.[key]) ? row[key] : 0), 0);
  return {rows: list, count: list.length, amountExTax: sum('amountExTax'), taxAmount: sum('taxAmount'), amountIncTax: sum('amountIncTax'),
    unknown: list.filter((row) => !Number.isFinite(row?.amountExTax)).length, recordedAt};
}

// いまの分け方: 登録を始めていればその分け方、まだなら最新の割り当て×最新の選択で最後に作った分け方
export async function currentPlan(db, orgId, fileId) {
  const [bindingRow, selectionRow] = await Promise.all([latestBindingRow(db, orgId, fileId), latestSelectionRow(db, orgId, fileId)]);
  const commits = await db.all(`SELECT x.id, x.partition_id, x.work_id, x.report_id, x.binding_id, x.selection_id, x.created_at, p.plan_sha256
    FROM sales_source_commits x JOIN sales_source_partitions p ON p.org_id=x.org_id AND p.id=x.partition_id
    WHERE x.org_id=? AND x.file_id=? ORDER BY x.id`, [orgId, fileId]);
  let planSha = commits[0]?.plan_sha256 ?? null;
  const bindingId = commits[0]?.binding_id ?? bindingRow?.id ?? null;
  const selectionId = commits[0]?.selection_id ?? selectionRow?.id ?? null;
  if (!planSha && bindingId && selectionId) {
    planSha = (await db.get('SELECT plan_sha256 FROM sales_source_partitions WHERE org_id=? AND file_id=? AND binding_id=? AND selection_id=? ORDER BY id DESC LIMIT 1', [orgId, fileId, bindingId, selectionId]))?.plan_sha256 ?? null;
  }
  const partitions = planSha
    ? await db.all('SELECT * FROM sales_source_partitions WHERE org_id=? AND file_id=? AND binding_id=? AND selection_id=? AND plan_sha256=? ORDER BY work_id', [orgId, fileId, bindingId, selectionId, planSha])
    : [];
  const byPartition = new Map(commits.map((commit) => [Number(commit.partition_id), commit]));
  const list = partitions.map((row) => ({...row, commit: byPartition.get(Number(row.id)) || null}));
  const progress = commitProgress(list.map((row) => ({committed: Boolean(row.commit)})));
  return {bindingRow, selectionRow, binding: bindingFromRow(bindingRow), commits, planSha, partitions: list, progress};
}

// ファイルに結び付いている作品（最新の割り当ての作品・その割り当てで分けた作品・登録した作品）
export async function boundWorkIds(db, orgId, fileId, latest = undefined) {
  const ids = new Set();
  const binding = latest === undefined ? await latestBindingRow(db, orgId, fileId) : latest;
  if (binding?.work_id != null) ids.add(Number(binding.work_id));
  if (binding) for (const row of await db.all('SELECT DISTINCT work_id FROM sales_source_partitions WHERE org_id=? AND file_id=? AND binding_id=?', [orgId, fileId, binding.id])) ids.add(Number(row.work_id));
  for (const row of await db.all('SELECT DISTINCT work_id FROM sales_source_commits WHERE org_id=? AND file_id=?', [orgId, fileId])) ids.add(Number(row.work_id));
  return [...ids];
}

// 財務権限のある案件（settlementWork と同じ基準: 制作担当は無し、管理者は全案件、ほかは編集権限のある案件）
export async function financeProjectSet({db, permittedProjects}, identity) {
  if (identity.role === 'production') return new Set();
  return new Set((await permittedProjects(db, identity, true)).map((row) => Number(row.id)));
}

// 権限のない作品のコード・題名を伏せる（分割の一覧・未登録の一覧・割り当ての表示で同じ扱いにする）
export function workLabel(work, visible) {
  return {workCode: visible ? work?.code ?? null : null, workTitle: visible ? work?.title ?? null : null, restricted: Boolean(work) && !visible};
}

// 作品がすべて財務権限のある案件のものか（問い合わせの数を作品の数に比例させない）
async function allWorksPermitted(ctx, identity, workIds, finance = null) {
  const ids = [...new Set(workIds.map(Number))];
  if (!ids.length) return false;
  if (identity.role === 'admin') return true;
  const allowed = finance || await financeProjectSet(ctx, identity);
  const rows = await allIn(ctx.db, 'SELECT id, project_id FROM works WHERE org_id=? AND id IN (:in)', {before: [identity.org_id], ids});
  return rows.length === ids.length && rows.every((row) => allowed.has(Number(row.project_id)));
}

// 原本を見られる人: 管理者・受け取った人・結び付いた作品すべての財務権限を持つ人。
// 作品未定の原本（割り当てが無い、または列で分ける割り当てで、まだ分けていない）は、管理者・受け取った人と、
// その最新の割り当てを作った人だけ（列で分ける割り当ては分割を保存するまで作品が結び付かないため、付け替えた本人が続けられるようにする）。
// 返り値 {allowed, reason}。reason は見られないときの理由: 'unbound'（作品未定の、ほかの人が受け取った原本）・'restricted'（権限のない作品の原本）
export async function fileAccess(ctx, identity, file) {
  if (!file || identity.role === 'production') return {allowed: false, reason: 'restricted'};
  if (identity.role === 'admin') return {allowed: true, reason: null};
  if (Number(file.created_by) === Number(identity.user_id)) return {allowed: true, reason: null};
  const latest = await latestBindingRow(ctx.db, identity.org_id, file.id);
  const ids = await boundWorkIds(ctx.db, identity.org_id, file.id, latest || null);
  if (!ids.length) {
    if (latest && Number(latest.created_by) === Number(identity.user_id)) return {allowed: true, reason: null};
    return {allowed: false, reason: 'unbound'};
  }
  return await allWorksPermitted(ctx, identity, ids) ? {allowed: true, reason: null} : {allowed: false, reason: 'restricted'};
}

export async function canAccessFile(ctx, identity, file) {
  return (await fileAccess(ctx, identity, file)).allowed;
}

// ---------- 旧経路（workflow_raw_artifacts）と二重に取り込まないための検査文 ----------
// 旧原本を新しい経路へ引き継いだら、旧経路の登録を止める（commitImport の旧原本の分岐と同じ batch に入れる）
export function legacyTakenOverGuard(orgId, artifactId) {
  return {sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM sales_source_files WHERE org_id=? AND legacy_artifact_id=?)', params: [orgId, artifactId]};
}
// 同じハッシュの原本が新しい経路にあれば、旧経路で原本を作らない（workflow.mjs の抽出と同じ batch に入れる）
export function sourceHashGuard(orgId, hash) {
  return {sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM sales_source_files WHERE org_id=? AND raw_sha256=?)', params: [orgId, hash]};
}
export async function isTakenOver(db, orgId, artifactId) {
  return Boolean(await db.get('SELECT 1 FROM sales_source_files WHERE org_id=? AND legacy_artifact_id=?', [orgId, artifactId]));
}

// ---------- プレビューと登録（app.mjs の /api/mapped-imports/preview・commitImport から使う） ----------
const productIdsOf = (productMap) => [...new Set((productMap || []).map((item) => Number(item.productId)).filter((id) => Number.isSafeInteger(id) && id > 0))];

// 分割の商品の、いまの作品配賦（product_works）。分割に残した配賦は「分けたときの写し」なので、権限の確認には使わない
export async function currentAllocations(db, orgId, productIds) {
  if (!productIds.length) return [];
  return allIn(db, 'SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=? AND product_id IN (:in) ORDER BY product_id, work_id', {before: [orgId], ids: productIds});
}

// 分割の写しの配賦と、いまの配賦が同じか（商品ごとに作品と率を比べる）
function sameAllocations(productMap, rows) {
  const current = new Map();
  for (const row of rows) {
    const list = current.get(Number(row.product_id)) || [];
    list.push({workId: Number(row.work_id), bps: Number(row.allocation_bps)});
    current.set(Number(row.product_id), list);
  }
  return (productMap || []).every((item) => allocationKey(item.allocations) === allocationKey(current.get(Number(item.productId)) || []));
}

// 1つの原本から分けた報告の登録条件（最初の登録の取引先・報告の種類・列対応の版）。まだ登録していなければ null
export async function fileCommitTerms(db, orgId, fileId) {
  const row = await db.get(`SELECT r.partner_id, r.kind, x.mapping_version_id, v.profile_id, v.version_no AS mapping_version_no, p.name AS partner_name, p.code AS partner_code
    FROM sales_source_commits x JOIN report_imports r ON r.org_id=x.org_id AND r.id=x.report_id
    LEFT JOIN partners p ON p.org_id=r.org_id AND p.id=r.partner_id
    LEFT JOIN report_mapping_versions v ON v.org_id=x.org_id AND v.id=x.mapping_version_id
    WHERE x.org_id=? AND x.file_id=? ORDER BY x.id LIMIT 1`, [orgId, fileId]);
  return row ? {partnerId: Number(row.partner_id), partnerName: row.partner_name ?? null, partnerCode: row.partner_code ?? null, kind: row.kind,
    mappingVersionId: Number(row.mapping_version_id), mappingVersionNo: row.mapping_version_no == null ? null : Number(row.mapping_version_no), profileId: row.profile_id == null ? null : Number(row.profile_id)} : null;
}

// 登録条件と違う取引先・報告の種類なら、画面に出す理由の文（同じなら null）。kindText は報告の種類の日本語
export function commitTermsProblem(terms, {partnerId, kind}, kindText = (value) => value) {
  if (!terms) return null;
  if (Number(partnerId) === terms.partnerId && String(kind) === terms.kind) return null;
  return `この原本は、取引先「${terms.partnerName || terms.partnerId}」・報告の種類「${kindText(terms.kind)}」の報告として登録を始めています。1つの原本から分けた報告は同じ取引先・報告の種類で登録します。手順1で取引先と報告の種類を選び直してください`;
}

// 分割の表をプレビューに渡してよいか確かめ、プレビューの mapping に足す情報を返す。{error, status} か {mapping}
// partnerId・kind は列対応の版の取引先・報告の種類（登録を始めた原本は、最初の登録と同じでなければ確かめない）
export async function partitionPreviewSource({db, identity, workId, partitionId, text, sha256, permittedProjects, partnerId = null, kind = null, kindText}) {
  const partition = await db.get('SELECT * FROM sales_source_partitions WHERE org_id=? AND id=?', [identity.org_id, partitionId]);
  if (!partition || Number(partition.work_id) !== Number(workId)) return {status: 403, error: '原本の分割と作品が一致しません'};
  const productMap = parseJson(partition.product_map_json, []);
  const productIds = productIdsOf(productMap);
  const allocationRows = await currentAllocations(db, identity.org_id, productIds);
  const allocationIds = [...new Set(allocationRows.map((row) => Number(row.work_id)))];
  if (allocationIds.length && !await allWorksPermitted({db, permittedProjects}, identity, allocationIds)) return {status: 403, error: 'この分割の商品は、権限のない作品にも配賦されています。管理者に確認してください'};
  const [binding, selection] = await Promise.all([latestBindingRow(db, identity.org_id, partition.file_id), latestSelectionRow(db, identity.org_id, partition.file_id)]);
  if (!binding || Number(binding.id) !== Number(partition.binding_id) || !selection || Number(selection.id) !== Number(partition.selection_id)) {
    return {status: 409, error: '原本の割り当てか表の選択が更新されています。割り当てからやり直してください'};
  }
  if (await db.get('SELECT 1 FROM sales_source_commits WHERE org_id=? AND partition_id=?', [identity.org_id, partitionId])) return {status: 409, error: 'この作品の分は登録済みです'};
  const other = await db.get(`SELECT 1 FROM sales_source_commits x JOIN sales_source_partitions p ON p.org_id=x.org_id AND p.id=x.partition_id
    WHERE x.org_id=? AND x.file_id=? AND p.plan_sha256<>?`, [identity.org_id, partition.file_id, partition.plan_sha256]);
  if (other) return {status: 409, error: '同じ原本は、ほかの分け方で登録を始めています。割り当てを読み直してください'};
  const terms = await fileCommitTerms(db, identity.org_id, partition.file_id);
  if (terms) {
    const problem = partnerId != null && kind != null ? commitTermsProblem(terms, {partnerId, kind}, kindText) : null;
    if (problem) return {status: 409, error: problem};
  } else if (!sameAllocations(productMap, allocationRows)) {
    // 登録を始める前なら、分けたあとで変わった配賦のまま使わず、今の配賦で分け直させる（分割の写しを今の配賦に合わせる）
    return {status: 409, error: '作品ごとに分けたあとで、商品の作品配賦が変わりました。手順4の割り当てからやり直してください（今の配賦で分け直します）'};
  }
  let built;
  try {
    const table = selectionTable(selection.canonical_csv, parseJson(selection.source_rows_json, []));
    built = partitionCsv(table, {sourceRows: parseJson(partition.source_rows_json, []), productMap}, bindingFromRow(binding));
  } catch (error) {
    return {status: 409, error: `原本の分割を作り直せません: ${error.message}`};
  }
  if (built.csv !== String(text ?? '') || await sha256(String(text ?? '')) !== partition.partition_sha256) {
    return {status: 409, error: '原本から分けた表が分割の記録と一致しません。割り当てからやり直してください'};
  }
  return {mapping: {
    sourcePartitionId: Number(partition.id), sourceFileId: Number(partition.file_id), sourceBindingId: Number(partition.binding_id),
    sourceSelectionId: Number(partition.selection_id), sourcePlanHash: partition.plan_sha256, sourcePartitionHash: partition.partition_sha256,
    workflowOriginalRows: built.sourceRowNumbers,
    // 確かめたときの商品と、その配賦先の作品（登録の batch で、配賦がこの作品の範囲から外れていないことを確かめる）
    sourceProductIds: productIds, sourceAllocationWorkIds: allocationIds,
  }};
}

// 登録の batch に足す文（分割がプレビューのときのまま・最新の割り当てと選択であることはトリガーでも確かめる）。
// 分割の商品の配賦は、確かめたとき（プレビュー・登録の直前に権限を確かめた作品）の範囲から外れていないことを同じ batch で確かめる
// （確かめた後に権限のない作品へ配賦が足されても、その作品へ按分される売上を登録しない）。
export function partitionCommitStatements(identity, preview, token) {
  const mapping = preview.mapping;
  const meta = preview.meta;
  const productIds = Array.isArray(mapping.sourceProductIds) ? mapping.sourceProductIds.map(Number) : null;
  const allocationGuard = productIds === null
    // 旧形式の確認（配賦の範囲を持たない）は登録しない。もう一度確かめてもらう
    ? [{sql: 'INSERT INTO transaction_guards(value) SELECT 0', params: []}]
    : productIds.length ? [{sql: `INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM product_works WHERE org_id=?
        AND product_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) AND work_id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?)))`,
      params: [identity.org_id, JSON.stringify(productIds), JSON.stringify((mapping.sourceAllocationWorkIds || []).map(Number))]}] : [];
  return [
    ...allocationGuard,
    {sql: `INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM sales_source_partitions WHERE org_id=? AND id=? AND work_id=? AND file_id=?
      AND binding_id=? AND selection_id=? AND plan_sha256=? AND partition_sha256=?)`,
    params: [identity.org_id, mapping.sourcePartitionId, preview.workId, mapping.sourceFileId, mapping.sourceBindingId, mapping.sourceSelectionId, mapping.sourcePlanHash, preview.hash]},
    {sql: `INSERT INTO sales_source_commits(org_id,file_id,partition_id,binding_id,selection_id,work_id,mapping_version_id,report_id,preview_token,created_by)
      VALUES(?,?,?,?,?,?,?,(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?),?,?)`,
    params: [identity.org_id, mapping.sourceFileId, mapping.sourcePartitionId, mapping.sourceBindingId, mapping.sourceSelectionId, preview.workId, mapping.mappingVersionId,
      identity.org_id, meta.report_key, preview.hash, token, identity.user_id]},
  ];
}

// 報告が新しい経路（原本の分割）から登録されたものなら、その原本・割り当て・分割の記録
export async function sourceCommitForReport(db, orgId, reportId) {
  return db.get(`SELECT x.id AS commit_id, x.file_id, x.partition_id, x.binding_id, x.selection_id, x.mapping_version_id, x.created_at AS committed_at,
      f.file_name, f.raw_sha256, f.storage, s.sheet_name, s.header_row, s.version_no AS selection_version, s.excluded_json, s.created_at AS selection_at,
      b.mode, b.version_no AS binding_version, b.reason AS binding_reason, b.product_column, b.work_column, b.work_id AS binding_work_id,
      p.row_count, p.plan_sha256, p.product_map_json, v.version_no AS mapping_version_no, mp.name AS profile_name
    FROM sales_source_commits x
    JOIN sales_source_files f ON f.org_id=x.org_id AND f.id=x.file_id
    JOIN sales_source_selections s ON s.org_id=x.org_id AND s.id=x.selection_id
    JOIN sales_source_bindings b ON b.org_id=x.org_id AND b.id=x.binding_id
    JOIN sales_source_partitions p ON p.org_id=x.org_id AND p.id=x.partition_id
    LEFT JOIN report_mapping_versions v ON v.org_id=x.org_id AND v.id=x.mapping_version_id
    LEFT JOIN report_mapping_profiles mp ON mp.org_id=v.org_id AND mp.id=v.profile_id
    WHERE x.org_id=? AND x.report_id=?`, [orgId, reportId]);
}

// 同じ原本から登録した報告のID（重複検出で「同じ原本の別作品分」として分けるため）
export async function sameFileReportIds(db, orgId, fileId) {
  if (!fileId) return new Set();
  return new Set((await db.all('SELECT report_id FROM sales_source_commits WHERE org_id=? AND file_id=?', [orgId, fileId])).map((row) => Number(row.report_id)));
}

// 手順1の「読み込んだまま登録していない原本」。見られる原本だけ、登録し終えたものは除く。
// 登録し終えたか・見られるか（fileAccess と同じ基準）は SQL で絞ってから新しい順に limit 件を読み、総数は別に数える
// （先に件数で打ち切ってから絞ると、見られない原本や登録済みの原本が新しい側に多いとき、古い未登録の原本が一覧から消えるため）。
// D1 の1回の要求で使える問い合わせの数に限りがあるため、原本の数に比例して問い合わせを増やさない。
const LATEST_BINDING = (column) => `(SELECT lb.${column} FROM sales_source_bindings lb WHERE lb.org_id=f.org_id AND lb.file_id=f.id ORDER BY lb.version_no DESC LIMIT 1)`;
// 結び付いた作品（boundWorkIds と同じ: 最新の割り当ての作品・その割り当てで分けた作品・登録した作品）
const BOUND_WORKS = `SELECT bw.work_id FROM sales_source_bindings bw WHERE bw.org_id=f.org_id AND bw.id=${LATEST_BINDING('id')} AND bw.work_id IS NOT NULL
  UNION SELECT bp.work_id FROM sales_source_partitions bp WHERE bp.org_id=f.org_id AND bp.file_id=f.id AND bp.binding_id=${LATEST_BINDING('id')}
  UNION SELECT bx.work_id FROM sales_source_commits bx WHERE bx.org_id=f.org_id AND bx.file_id=f.id`;
// 登録し終えていない: 登録がまだ無いか、登録を始めた分け方（どの登録も同じ分け方。トリガーで保証）に登録していない作品が残る
const PENDING_FILE = `(NOT EXISTS(SELECT 1 FROM sales_source_commits px WHERE px.org_id=f.org_id AND px.file_id=f.id)
  OR EXISTS(SELECT 1 FROM sales_source_commits cx JOIN sales_source_partitions cp ON cp.org_id=cx.org_id AND cp.id=cx.partition_id
    JOIN sales_source_partitions op ON op.org_id=cp.org_id AND op.file_id=cp.file_id AND op.binding_id=cp.binding_id AND op.selection_id=cp.selection_id AND op.plan_sha256=cp.plan_sha256
    WHERE cx.org_id=f.org_id AND cx.file_id=f.id AND NOT EXISTS(SELECT 1 FROM sales_source_commits ox WHERE ox.org_id=op.org_id AND ox.partition_id=op.id)))`;
// 管理者以外が見られる原本（fileAccess と同じ基準）。値: 利用者ID・利用者ID・財務権限のある案件IDのJSON配列
const VISIBLE_FILE = `(f.created_by=?
  OR (NOT EXISTS(${BOUND_WORKS}) AND ${LATEST_BINDING('created_by')}=?)
  OR (EXISTS(${BOUND_WORKS}) AND NOT EXISTS(SELECT 1 FROM works vw WHERE vw.org_id=f.org_id AND vw.id IN (${BOUND_WORKS})
    AND vw.project_id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?)))))`;

export async function pendingSourceFilePage(ctx, identity, {limit = 20} = {}) {
  const {db} = ctx;
  if (identity.role === 'production') return {rows: [], total: 0, limit: 0};
  const size = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const admin = identity.role === 'admin';
  const finance = admin ? null : await financeProjectSet(ctx, identity);
  const where = `f.org_id=? AND ${PENDING_FILE}${admin ? '' : ` AND ${VISIBLE_FILE}`}`;
  const params = admin ? [identity.org_id] : [identity.org_id, identity.user_id, identity.user_id, JSON.stringify([...finance])];
  const [files, counted] = await Promise.all([
    db.all(`SELECT f.id, f.file_name, f.created_at, f.created_by, f.storage,
        b.id AS binding_id, b.mode, b.version_no, b.work_id AS binding_work_id, b.product_column, b.work_column,
        (SELECT COUNT(*) FROM sales_source_commits x WHERE x.org_id=f.org_id AND x.file_id=f.id) AS committed_count
      FROM sales_source_files f
      LEFT JOIN sales_source_bindings b ON b.org_id=f.org_id AND b.file_id=f.id
        AND b.version_no=(SELECT MAX(v.version_no) FROM sales_source_bindings v WHERE v.org_id=f.org_id AND v.file_id=f.id)
      WHERE ${where} ORDER BY f.id DESC LIMIT ?`, [...params, size]),
    db.get(`SELECT COUNT(*) AS n FROM sales_source_files f WHERE ${where}`, params),
  ]);
  const total = Number(counted?.n || 0);
  if (!files.length) return {rows: [], total, limit: size};
  const ids = files.map((file) => Number(file.id));
  // 登録を始めた原本の分け方の作品数（登録済みの分割と同じ割り当て・選択・分け方の分割）
  const planRows = await allIn(db, `SELECT p.file_id, p.work_id, p.binding_id, p.plan_sha256, p.selection_id,
      (SELECT 1 FROM sales_source_commits x WHERE x.org_id=p.org_id AND x.partition_id=p.id) AS committed
    FROM sales_source_partitions p WHERE p.org_id=? AND p.file_id IN (:in)`, {before: [identity.org_id], ids});
  const commitRows = await allIn(db, `SELECT x.file_id, x.work_id, x.binding_id, x.selection_id, p.plan_sha256
    FROM sales_source_commits x JOIN sales_source_partitions p ON p.org_id=x.org_id AND p.id=x.partition_id
    WHERE x.org_id=? AND x.file_id IN (:in) ORDER BY x.id`, {before: [identity.org_id], ids});
  const works = await db.all('SELECT id, project_id, title FROM works WHERE org_id=?', [identity.org_id]);
  const workById = new Map(works.map((row) => [Number(row.id), row]));
  const permitted = (workId) => admin || (workById.has(Number(workId)) && finance.has(Number(workById.get(Number(workId)).project_id)));
  const rows = files.map((file) => {
    const fileId = Number(file.id);
    const commits = commitRows.filter((row) => Number(row.file_id) === fileId);
    const plan = commits[0]
      ? planRows.filter((row) => Number(row.file_id) === fileId && row.plan_sha256 === commits[0].plan_sha256 && Number(row.binding_id) === Number(commits[0].binding_id) && Number(row.selection_id) === Number(commits[0].selection_id))
      : [];
    const progress = commitProgress(plan.map((row) => ({committed: Boolean(row.committed)})));
    return {
      fileId, fileName: file.file_name, createdAt: file.created_at, storage: file.storage,
      binding: file.mode ? {mode: file.mode, versionNo: Number(file.version_no), workId: file.binding_work_id == null ? null : Number(file.binding_work_id),
        workTitle: file.binding_work_id != null && permitted(file.binding_work_id) ? workById.get(Number(file.binding_work_id))?.title ?? null : null,
        productColumn: file.product_column ?? null, workColumn: file.work_column ?? null} : null,
      partitions: plan.length, committed: Number(file.committed_count), progressLabel: plan.length ? progress.label : '未登録',
    };
  });
  return {rows, total, limit: size};
}

export async function pendingSourceFiles(ctx, identity, options = {}) {
  return (await pendingSourceFilePage(ctx, identity, options)).rows;
}

// 分割に結び付く作品（分割の作品と、商品のいまの配賦先の作品）の財務権限をまとめて確かめる
export async function partitionWorksPermitted(ctx, identity, partitionRow) {
  const productMap = parseJson(partitionRow?.product_map_json, []);
  const rows = await currentAllocations(ctx.db, identity.org_id, productIdsOf(productMap));
  const ids = [Number(partitionRow.work_id), ...rows.map((row) => Number(row.work_id))];
  return allWorksPermitted(ctx, identity, ids);
}

// 同じ原本を分けた報告の一覧（報告の結果の画面用）。権限のない作品は名前と報告IDを出さない
export async function siblingPartitions(ctx, identity, plan, currentPartitionId) {
  const works = await ctx.db.all('SELECT id, project_id, code, title FROM works WHERE org_id=?', [identity.org_id]);
  const workById = new Map(works.map((row) => [Number(row.id), row]));
  const finance = identity.role === 'admin' ? null : await financeProjectSet(ctx, identity);
  const permitted = (workId) => identity.role === 'admin' || (workById.has(Number(workId)) && finance.has(Number(workById.get(Number(workId)).project_id)));
  return plan.partitions.map((row) => {
    const visible = permitted(row.work_id);
    const work = visible ? workById.get(Number(row.work_id)) : null;
    return {partitionId: row.id, workId: row.work_id, workCode: work?.code ?? null, workTitle: work?.title ?? null, restricted: !visible, rowCount: row.row_count,
      reportId: row.commit && visible ? row.commit.report_id : null, committed: Boolean(row.commit), current: Number(row.id) === Number(currentPartitionId)};
  });
}
