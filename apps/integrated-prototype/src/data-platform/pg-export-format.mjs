// 書き出しの形式と、金額の照合の共通部品。行の値はエラーに含めない。
export const EXPORT_FORMAT = 'openingnight-pg-ndjson-v1';
export const RECONCILE_MONEY_COLUMN = /(?:^|_)(?:yen|amount|tax|price|fee|total|cost|budget)$/;
export const MAX_PART_BYTES = 20 * 1024 * 1024;
export const quoteIdentifier = value => `"${String(value).replaceAll('"', '""')}"`;
// ログに出してよい原因の種類（許可リスト）。exportError の固定の語はすべてここに載せる（test/pg-export.test.mjs が src と
// core の scripts/ops の呼び出しと照らす）。binding_missing は定時実行の束ねの欠け、invalid_arguments・invalid_json・input_missing は
// core の pg-restore.mjs・pg-reconcile.mjs の入力の誤り、invalid_key・invalid_path・symlink_escape・object_too_large・artifact_conflict は
// 取得したフォルダの読み書きの誤り。
export const EXPORT_ERROR_CODES = Object.freeze([
  'artifact_checksum', 'artifact_conflict', 'artifact_manifest_extra', 'artifact_manifest_missing', 'artifact_missing', 'artifact_write_failed',
  'begin_failed', 'binding_missing', 'database_reconciliation', 'export_deadline', 'input_missing', 'invalid_arguments',
  'invalid_artifact_key', 'invalid_artifact_reference', 'invalid_artifact_target', 'invalid_export_options', 'invalid_integer', 'invalid_json',
  'invalid_key', 'invalid_ndjson', 'invalid_part', 'invalid_path', 'invalid_reconciliation', 'invalid_restore_options', 'invalid_row_shape',
  'manifest_invalid', 'manifest_missing', 'manifest_too_large', 'manifest_write_failed', 'object_too_large', 'object_write_failed',
  'part_checksum', 'part_missing_or_large', 'part_order', 'postgres_required', 'restore_reconciliation', 'row_refetch_missing',
  'row_too_large', 'schema_fingerprint_missing', 'schema_mismatch', 'schema_table_count', 'symlink_escape', 'table_checksum',
  'table_set_mismatch', 'table_shape_mismatch', 'target_not_empty', 'trigger_state',
]);
const EXPORT_ERROR_SET = new Set(EXPORT_ERROR_CODES);
// 別の読み込み経路で同じファイルが2回読まれても印がそろうよう、Symbol.for で共有の印にする。
const EXPORT_ERROR_MARK = Symbol.for('openingnight.pg-export-error');
export function exportError(code) {
  const error = new Error(`PG export: ${code}`);
  error.code = code;
  error[EXPORT_ERROR_MARK] = true;
  return error;
}
// 失敗をログに出すときの原因の種類。exportError の許可リストの語、PostgreSQL の SQLSTATE（5文字）、それ以外は unexpected。
// 元のエラーの message・SQL・行の値・接続値は返さない（docs/rules/logging.md）。
export function failureCause(error) {
  const code = error?.code;
  if (typeof code !== 'string') return 'unexpected';
  if (error[EXPORT_ERROR_MARK] === true && EXPORT_ERROR_SET.has(code)) return code;
  if (/^[0-9A-Z]{5}$/.test(code)) return code;
  return 'unexpected';
}
export function integerText(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw exportError('invalid_integer');
  if (!/^-?\d+$/.test(String(value))) throw exportError('invalid_integer');
  return BigInt(value).toString();
}
export function moneyColumns(columns) {
  return columns.filter(c => ['int2', 'int4', 'int8'].includes(c.type) && RECONCILE_MONEY_COLUMN.test(c.name)).map(c => c.name);
}
export function addMoney(sums, row) {
  for (const column of Object.keys(sums)) {
    if (row[column] !== null) sums[column] = (BigInt(sums[column]) + BigInt(integerText(row[column]))).toString();
  }
}

// manifest と reconcile.sql の JSON の両方を、同じ精度の照合表にする。
export function reconciliationRows(input) {
  const rows = Array.isArray(input) ? input : input?.tables;
  if (!Array.isArray(rows) || !rows.length) throw exportError('invalid_reconciliation');
  const out = new Map();
  for (const row of rows) {
    const name = row.table_name;
    if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(name) || out.has(name)) throw exportError('invalid_reconciliation');
    const count = integerText(row.row_count);
    if (BigInt(count) < 0n) throw exportError('invalid_reconciliation');
    let sums = row.money_sums;
    if (typeof sums === 'string') {
      const pairs = sums ? sums.split(';').map(s => s.split('=')) : [];
      if (pairs.some(p => p.length !== 2) || new Set(pairs.map(p => p[0])).size !== pairs.length) throw exportError('invalid_reconciliation');
      sums = Object.fromEntries(pairs);
    }
    if (!sums || typeof sums !== 'object' || Array.isArray(sums)) throw exportError('invalid_reconciliation');
    const normalized = Object.create(null);
    for (const column of Object.keys(sums).sort()) {
      if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw exportError('invalid_reconciliation');
      normalized[column] = integerText(sums[column]);
    }
    out.set(name, {row_count: count, money_sums: normalized});
  }
  return out;
}
export function compareReconciliation(left, right) {
  const a = reconciliationRows(left), b = reconciliationRows(right), differences = [];
  for (const table of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(table), y = b.get(table);
    if (!x || !y) differences.push({table, reason: 'missing_table'});
    else {
      if (x.row_count !== y.row_count) differences.push({table, reason: 'row_count'});
      if (JSON.stringify(x.money_sums) !== JSON.stringify(y.money_sums)) differences.push({table, reason: 'money_sums'});
    }
  }
  return {equal: differences.length === 0, differences};
}
