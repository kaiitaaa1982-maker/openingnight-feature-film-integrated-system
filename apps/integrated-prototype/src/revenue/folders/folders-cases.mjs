// フォルダからの受け取りの、正解表の正答率（純関数）。
// 要件は docs/requirements/revenue/folder-entry.md の FR-REV-FOLDER-009。
// 一致は、見出しが検査の決まりの版の列名と全部一致し、7つの検査の合否が期待と全部一致すること。
// 正答率100%は、一致した件数＝件数かつ件数が1以上。0件は100%にしない。
// 取り込まない行の規則（skipRules）は、1件の形が文書に無いので適用しない。除外は入力の planned.excluded を使う。
// DB・時刻・環境変数は読まない。
import {evaluateFolderChecks} from './folders-checks.mjs';

export const FOLDER_CHECK_KEYS = Object.freeze(['row_count', 'totals', 'period', 'linkage', 'round_trip', 'arithmetic', 'overlap']);

const MONEY_KEYS = ['amountExTax', 'taxAmount', 'amountIncTax'];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stringList(value) {
  return Array.isArray(value) && value.length >= 1 && value.every(item => typeof item === 'string' && item !== '');
}

function moneyColumnsOk(value) {
  const columns = asObject(value);
  return !!columns && MONEY_KEYS.every(key => typeof columns[key] === 'string' && columns[key] !== '');
}

function expectedFlags(value) {
  const expected = asObject(value);
  if (!expected || FOLDER_CHECK_KEYS.some(key => typeof expected[key] !== 'boolean')) return null;
  return expected;
}

function headersEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((name, index) => name === right[index]);
}

// 1つの型の版と、その正解表の行から正答率を導く。型の検算・見出し・金額の列・商品で分けるかは版の値で上書きする。
// 期待する合否が7つの真偽でなければ、正答率にせず例外にする（不一致と静かに数えない）。
export function scoreCheckCases({headerColumns, checks, moneyColumns, splitByProduct, cases} = {}) {
  if (!stringList(headerColumns)) throw new Error('見出しの列名は、空でない名前の配列です');
  if (!Array.isArray(checks)) throw new Error('検算の決まりは配列です');
  if (!moneyColumnsOk(moneyColumns)) throw new Error('税抜・税額・税込の列名がありません');
  if (typeof splitByProduct !== 'boolean') throw new Error('商品で分けるかは真偽です');
  const list = Array.isArray(cases) ? cases : [];
  const rows = list.map(item => {
    const expected = expectedFlags(item?.expected);
    if (!expected) throw new Error('正解表の期待する結果は、7つの検査の合否です');
    const input = asObject(item?.input);
    if (!input) throw new Error('正解表の原本がありません');
    const headersMatch = headersEqual(headerColumns, input.source?.headers);
    const overlaid = structuredClone(input);
    overlaid.typeVersion = {splitByProduct, moneyColumns, checks};
    const result = evaluateFolderChecks(overlaid);
    const flags = Object.fromEntries(result.checks.map(check => [check.key, check.pass]));
    const checksMatch = FOLDER_CHECK_KEYS.every(key => flags[key] === expected[key]);
    return {origin: item.origin ?? null, matched: headersMatch && checksMatch, headersMatch, checks: flags};
  });
  const matched = rows.filter(row => row.matched).length;
  const total = rows.length;
  const complete = total > 0 && matched === total;
  return {matched, total, complete, label: complete ? '100%' : '100%未満', rows};
}

// 表3・表4から読んだ行（列の名前は移行 0023）を、scoreCheckCases の引数にする。JSON が壊れていれば例外。
export function scoreStoredVersion(version, caseRows) {
  const row = version && typeof version === 'object' ? version : {};
  return scoreCheckCases({
    headerColumns: JSON.parse(row.header_columns_json),
    checks: JSON.parse(row.checks_json),
    moneyColumns: JSON.parse(row.money_columns_json),
    splitByProduct: Number(row.split_by_product) === 1,
    cases: (Array.isArray(caseRows) ? caseRows : []).map(item => ({
      origin: item.origin,
      input: JSON.parse(item.input_json),
      expected: JSON.parse(item.expected_json),
    })),
  });
}

// 表5・表6の行を、実績の純関数（deriveFolderRecord）が受け取る形にする。file_id は文字列にする。
export function toRecordRun(row) {
  return {
    id: Number(row.id),
    checkVersionId: Number(row.check_version_id),
    sourceFileId: String(row.file_id),
    at: row.created_at,
    judgment: row.judgment,
    goldenMatched: Number(row.golden_matched),
    goldenTotal: Number(row.golden_total),
  };
}

export function toRecordReview(row) {
  return {
    id: Number(row.id),
    checkRunId: Number(row.check_run_id),
    at: row.created_at,
    result: row.result,
  };
}

export function formatScoreLine(type, score) {
  const name = typeof type?.partnerName === 'string' ? type.partnerName : '';
  const kind = typeof type?.kind === 'string' ? type.kind : '';
  return `${name} ${kind} ${score.matched}/${score.total} ${score.label}`;
}
