// SQLite の関数・値と、PostgreSQL で同じ値を返す補助の関数（pg/schema.sql の先頭で作る lite_*）の対応表。
// DDL の変換（scripts/pg-ddl.mjs）と PostgreSQL の入口（src/data-platform/pg-db.mjs）が、この1つの表を読む（FR-CORE-DATA-025）。
// Worker でも読む（node:* を import しない）。
//
// - args: 受け付ける引数の数。ほかの数の呼び出しは読み替えない（PostgreSQL がそのまま断る）
// - fill: 引数が少ないときに足す値（位置ごと）。json_each(x) は json_each(x, '$') と同じ
export const LITE_FUNCTIONS = Object.freeze({
  json_extract: Object.freeze({to: 'lite_json_extract', args: [2]}),
  json_each: Object.freeze({to: 'lite_json_each', args: [1, 2], fill: [null, "'$'"]}),
  json_valid: Object.freeze({to: 'lite_json_valid', args: [1]}),
  json_type: Object.freeze({to: 'lite_json_type', args: [1]}),
  json_array_length: Object.freeze({to: 'lite_json_array_length', args: [1]}),
});

// 呼び出しの引数（文字の並び）に、足りない分の既定の値を足す。読み替えない呼び出しは null
export function liteCall(name, args) {
  const spec = LITE_FUNCTIONS[String(name).toLowerCase()];
  if (!spec || !spec.args.includes(args.length)) return null;
  const max = Math.max(...spec.args);
  const filled = [...args];
  for (let at = args.length; at < max; at += 1) filled.push(spec.fill[at]);
  return {name: spec.to, args: filled, added: filled.slice(args.length)};
}

// CAST(x AS INTEGER)・CAST(x AS INT)。SQLite の INTEGER は64ビットで、文字は先頭の整数だけを読み（読めなければ 0）、小数は 0 の方へ切り捨てる。
// PostgreSQL の integer は32ビットで、読めない文字は誤り、小数は四捨五入なので、同じ値を返す補助の関数にする
export const LITE_CAST_INT = 'lite_cast_int';
export const INTEGER_TYPES = Object.freeze(['INTEGER', 'INT']);

// CURRENT_TIMESTAMP。SQLite は 'YYYY-MM-DD HH:MM:SS'（UTC）の文字を返す。PostgreSQL の CURRENT_TIMESTAMP は時刻の型で、
// 文字の列へ入れるとマイクロ秒と時差（+00）が付くので、同じ書式の文字を作る式にする（FR-CORE-DATA-023）。
// 文ごとの時刻（statement_timestamp）にする。SQLite の CURRENT_TIMESTAMP は文ごと、PostgreSQL の CURRENT_TIMESTAMP はトランザクションの始まり
export const TIMESTAMP_TEXT = "to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";

// x IS y・x IS NOT y（y が NULL・TRUE・FALSE・UNKNOWN・DISTINCT 以外）。SQLite の IS は NULL どうしを等しいとみる比べ方で、y に値（? など）を書ける。
// PostgreSQL の IS は NULL などの決まった語だけを受け、値は IS NOT DISTINCT FROM（IS NOT は IS DISTINCT FROM）で比べる。DDL の変換と入口が同じ規則で読み替える
export const IS_KEYWORDS = Object.freeze(['NULL', 'TRUE', 'FALSE', 'UNKNOWN', 'DISTINCT']);
export const isComparison = (afterWord) => !IS_KEYWORDS.includes(String(afterWord ?? '').toUpperCase());
