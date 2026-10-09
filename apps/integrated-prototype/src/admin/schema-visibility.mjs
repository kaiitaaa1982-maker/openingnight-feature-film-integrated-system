export const SECRET_COLUMN = /(token|secret|password|session|credential|api_key)/i;
// 原本・表編集の中身などの大きな列は読み込まない（Worker では R2 から行ごとに読み戻すため、2,000行ぶんでメモリ上限を超える）。
// cloud-r2-db.mjs の externalColumns（R2 に置く列）と同じ列に、*_base64・*_csv・raw_text を加える。値は「省略」とだけ返す
const LARGE_COLUMNS = new Map([
  ['workbench_source_artifacts', new Set(['raw_base64', 'extraction_json'])],
  ['workflow_raw_artifacts', new Set(['original_base64', 'extraction_json'])],
  ['sales_source_files', new Set(['original_base64', 'extraction_json'])],
  ['workbench_snapshots', new Set(['rows_json'])],
  ['workbench_drafts', new Set(['rows_json'])],
  ['workbench_validations', new Set(['result_json'])],
  ['workbench_applications', new Set(['result_json'])],
  ['workbench_lineage', new Set(['detail_json'])],
  ['import_previews', new Set(['payload_json'])],
]);
const LARGE_COLUMN = /(_base64|_csv)$|^raw_text$|^source_rows_json$/;
export const isLargeColumn = (table, column) => Boolean(LARGE_COLUMNS.get(table)?.has(column)) || LARGE_COLUMN.test(column);

export const isDefinitionColumn = (table, column) => !SECRET_COLUMN.test(column) && !isLargeColumn(table, column);

export function visibleDefinition(table) {
  return {...table,
    columns: table.columns.filter((c) => isDefinitionColumn(table.name, c.name)),
    foreignKeys: table.foreignKeys.filter((fk) => isDefinitionColumn(table.name, fk.from) && isDefinitionColumn(fk.table, fk.to)),
  };
}
