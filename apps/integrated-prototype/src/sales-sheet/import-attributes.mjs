// 売上報告の取込（CSV・取引先別の列対応）で、売上集計シートの拡張属性の列に値を入れる。
// 取込の変換先の名前は attr_<列キー>（column-registry.mjs の attributeTargetKey）。値は売上明細を登録するのと同じ batch で
// sale_attribute_values の版1として入れる（1つの文・INSERT … SELECT … FROM json_each。行数によらず文の数は増えない）。
// 列の辞書（SHEET_COLUMNS）に従って、組織の列カタログ（最新の版）で使っていない列の値を次のように扱う:
//   - 辞書から外した列（removed）: 書き先が無いので読み飛ばす。行の attributes に {k, skipped:'removed', warning} を入れて確認（プレビュー）の応答に返し、
//     取込は止めない（前の値は sale_attribute_values に残る）。組織がまだ使っている（辞書の v2 を当てる前の）組織では、ほかの列と同じに入れる
//   - 新しいキーへ置き換えた列（retired_by）: 列対応の attr_<旧キー> を、置き換えた先の列へ振り替える。新しい表（sale_distribution_metric_versions）の
//     metric_key へ書く先は METRIC_DESTINATIONS に宣言だけを置き、書き込みは新しい表を足すとき（計画の香盤表 #6・PR C）に足す
//   - 辞書に無い列・拡張属性の列でない列・removed も retired_by も無いのに止めてある列（管理者が止めた列）・型が合わない値は、
//     確認の段階でその行のエラーにする
import {isAttributeTarget, columnKeyOfTarget, sheetColumnOf} from './column-registry.mjs';
import {parseAttributeValue} from './sales-sheet-input.mjs';

// 新しい表（sale_distribution_metric_versions。裁定2 (a)）の metric_key。置き換えた先のキー → metric_key。#2a では書き込まない（宣言だけ）
export const METRIC_DESTINATIONS = Object.freeze({
  reported_rate_pct: 'reported_rate_bps', reported_rental_turnover: 'rental_turnover_x100', reported_overdue_count: 'overdue_count',
  reported_overdue_amount: 'overdue_amount_yen', reported_overdue_share: 'overdue_share_yen', reported_rss_declared: 'reported_declared_ex_tax',
  reported_unique_viewers: 'viewer_uu_count', reported_theatre_name: 'theater_name', reported_ticket_category: 'ticket_class',
  reported_ticket_unit_inc_tax: 'ticket_unit_price_inc_tax_yen', reported_ticket_raw_label: 'ticket_type_text',
});
const isActive = (column) => Number(column.active) === 1 || column.active === true;
const usable = (column) => column && column.source_kind === 'attribute' && isActive(column);
// retired_by をたどった先の列キー（循環は止める）
function destinationOf(key) {
  let entry = sheetColumnOf(key);
  for (const seen = new Set(); entry?.retired_by && !seen.has(entry.key);) { seen.add(entry.key); entry = sheetColumnOf(entry.retired_by); }
  return entry?.key ?? key;
}
const skippedWarning = (label, target) => `${label}（${target}）は売上集計シートの辞書から外した列なので、取込では読み飛ばしました（値は登録しません。前の値は残ります）`;

// 取込の見出しに拡張属性の列があるときだけ、組織の列カタログ（最新の版）を読む
export async function attributeImportContext(db, orgId, headers) {
  const targets = (headers || []).filter(isAttributeTarget);
  if (!targets.length) return null;
  const rows = await db.all(`SELECT c.column_key,c.label,c.value_type,c.source_kind,c.active FROM sales_sheet_column_versions c
    WHERE c.org_id=? AND c.version_no=(SELECT MAX(x.version_no) FROM sales_sheet_column_versions x WHERE x.org_id=c.org_id AND x.column_key=c.column_key)`, [orgId]);
  const index = new Map(rows.map((row) => [row.column_key, row]));
  const problems = [];
  const columns = [];
  const skipped = [];
  for (const target of targets) {
    const key = columnKeyOfTarget(target);
    const column = index.get(key);
    const entry = sheetColumnOf(key);
    if (usable(column)) { columns.push({target, column}); continue; }
    const dictionaryAttribute = entry?.source_kind === 'attribute' && (!column || column.source_kind === 'attribute');
    if (entry?.removed && dictionaryAttribute) { skipped.push({target, key, label: column?.label || entry.label}); continue; }
    if (entry?.retired_by && dictionaryAttribute) {
      const destinationKey = destinationOf(key);
      const destination = index.get(destinationKey);
      if (usable(destination)) columns.push({target, column: destination});
      else problems.push(`${column?.label || entry.label}（${target}）の書き先 ${destinationKey}${METRIC_DESTINATIONS[destinationKey] ? `（新しい表の ${METRIC_DESTINATIONS[destinationKey]}）` : ''}にはまだ書き込めません`);
      continue;
    }
    if (!column) problems.push(`売上集計シートに無い列です: ${target}（先に列を採用・追加してください）`);
    else if (column.source_kind !== 'attribute') problems.push(`${column.label}（${target}）は拡張属性の列ではありません`);
    else problems.push(`${column.label}（${target}）は使うのをやめた列です`);
  }
  return {columns, skipped, problems};
}

// 1行の拡張属性の値。{attributes:[{k,t,n}], text:{target: 元の文字}}。空欄は入れない。誤りは例外。
// 読み飛ばした列の値は attributes に {k, skipped:'removed', warning} で入れる（登録はしない。確認の応答で件数が分かる）。text には読み飛ばした列の文字も入れる
// （列対応の取込は、登録の直前に変換後の値の attr_ の文字すべてと照合する。attributeTextOf）
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
  for (const {target, key, label} of context.skipped || []) {
    const raw = values?.[target];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    text[target] = String(raw);
    attributes.push({k: key, skipped: 'removed', warning: skippedWarning(label, target)});
  }
  return {attributes, text};
}

// 取込の変換後の値から、確認のときに読んだ元の文字と同じかを確かめる（登録の直前）
export function attributeTextOf(values) {
  return Object.fromEntries(Object.entries(values || {}).filter(([key, value]) => isAttributeTarget(key) && value !== undefined && value !== null && String(value).trim() !== '').map(([key, value]) => [key, String(value)]));
}

// 登録の文（売上明細と同じ batch）。rows は プレビューの行（destination='sale_lines' で attributes を持つもの）。読み飛ばした列の値は入れない
export function attributeInsertStatement({orgId, userId, reportKey, contentHash, rows}) {
  const payload = [];
  for (const row of rows || []) {
    if (row.destination !== 'sale_lines' || !Array.isArray(row.attributes)) continue;
    for (const item of row.attributes) if (!item.skipped) payload.push({r: row.data.source_row, k: item.k, t: item.t, n: item.n});
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
