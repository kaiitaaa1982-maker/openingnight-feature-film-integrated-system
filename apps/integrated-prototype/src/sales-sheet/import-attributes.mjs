// 売上報告の取込（CSV・取引先別の列対応）で、売上集計シートの拡張属性の列に値を入れる。
// 取込の変換先の名前は attr_<列キー>（column-registry.mjs の attributeTargetKey）。値は売上明細を登録するのと同じ batch で
// sale_attribute_values の版1として入れる（1つの文・INSERT … SELECT … FROM json_each。行数によらず文の数は増えない）。
// 列が無い・拡張属性の列でない・使うのをやめた列・型が合わない値は、確認（プレビュー）の段階でその行のエラーにする。
import {isAttributeTarget, columnKeyOfTarget} from './column-registry.mjs';
import {parseAttributeValue} from './sales-sheet-input.mjs';

// 取込の見出しに拡張属性の列があるときだけ、組織の列カタログ（最新の版）を読む
export async function attributeImportContext(db, orgId, headers) {
  const targets = (headers || []).filter(isAttributeTarget);
  if (!targets.length) return null;
  const rows = await db.all(`SELECT c.column_key,c.label,c.value_type,c.source_kind,c.active FROM sales_sheet_column_versions c
    WHERE c.org_id=? AND c.version_no=(SELECT MAX(x.version_no) FROM sales_sheet_column_versions x WHERE x.org_id=c.org_id AND x.column_key=c.column_key)`, [orgId]);
  const index = new Map(rows.map((row) => [row.column_key, row]));
  const problems = [];
  const columns = [];
  for (const target of targets) {
    const column = index.get(columnKeyOfTarget(target));
    if (!column) problems.push(`売上集計シートに無い列です: ${target}（先に列を採用・追加してください）`);
    else if (column.source_kind !== 'attribute') problems.push(`${column.label}（${target}）は拡張属性の列ではありません`);
    else if (Number(column.active) !== 1) problems.push(`${column.label}（${target}）は使うのをやめた列です`);
    else columns.push({target, column});
  }
  return {columns, problems};
}

// 1行の拡張属性の値。{attributes:[{k,t,n}], text:{target: 元の文字}}。空欄は入れない。誤りは例外
export function readRowAttributes(context, values) {
  if (!context) return {attributes: [], text: {}};
  if (context.problems.length) throw new Error(context.problems[0]);
  const attributes = [];
  const text = {};
  for (const {target, column} of context.columns) {
    const raw = values?.[target];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    text[target] = String(raw);
    const parsed = parseAttributeValue(column, raw);
    if (parsed.error) throw new Error(parsed.error);
    attributes.push({k: column.column_key, t: parsed.value.t, n: parsed.value.n});
  }
  return {attributes, text};
}

// 取込の変換後の値から、確認のときに読んだ元の文字と同じかを確かめる（登録の直前）
export function attributeTextOf(values) {
  return Object.fromEntries(Object.entries(values || {}).filter(([key, value]) => isAttributeTarget(key) && value !== undefined && value !== null && String(value).trim() !== '').map(([key, value]) => [key, String(value)]));
}

// 登録の文（売上明細と同じ batch）。rows は プレビューの行（destination='sale_lines' で attributes を持つもの）
export function attributeInsertStatement({orgId, userId, reportKey, contentHash, rows}) {
  const payload = [];
  for (const row of rows || []) {
    if (row.destination !== 'sale_lines' || !Array.isArray(row.attributes)) continue;
    for (const item of row.attributes) payload.push({r: row.data.source_row, k: item.k, t: item.t, n: item.n});
  }
  if (!payload.length) return null;
  return {
    sql: `INSERT INTO sale_attribute_values(org_id,sale_id,column_key,version_no,value_text,value_number,origin,reason,created_by)
      SELECT ?,s.id,json_extract(j.value,'$.k'),1,json_extract(j.value,'$.t'),json_extract(j.value,'$.n'),'report_import',?,?
      FROM json_each(?) j JOIN sale_lines s ON s.org_id=? AND s.source_row=CAST(json_extract(j.value,'$.r') AS INTEGER)
        AND s.report_id=(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?)`,
    params: [orgId, `売上報告の取込（${reportKey}）`, userId, JSON.stringify(payload), orgId, orgId, reportKey, contentHash],
  };
}
