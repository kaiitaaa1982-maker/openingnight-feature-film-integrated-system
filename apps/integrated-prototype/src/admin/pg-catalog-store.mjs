// 管理画面の ER 図・データ一覧の表の定義を、PostgreSQL の入口（PgDatabase。dialect が 'postgres'）で読む（香盤表 #11 の PR4・FR-CORE-DATA-025）。
// D1・LocalDatabase の道（sqlite_master・PRAGMA）は ./er-routes.mjs の readTableSchema にあり、PostgreSQL のときだけここへ来る。
// sqlite_master・pragma_table_info・pragma_foreign_key_list は無いので、pg_catalog から SQLite の PRAGMA と同じ形（列・外部キーの
// 項目名と値の書き方）を返す。表は pg/schema.sql（scripts/pg-ddl.mjs が SQLite の DDL から作る）のもので、次のとおり SQLite にそろえる。
// - type: DDL の変換（pgType）の逆。bigint → INTEGER、text → TEXT、double precision → REAL、numeric → ''（型なし）、bytea → BLOB。
//   ほかの型はそのままの名前（表示は「その他」）
// - notnull: PostgreSQL の実際の制約。主キーの列は PostgreSQL では必ず NOT NULL なので 1（SQLite は宣言どおりで 0 のことがある）
// - dflt_value: 文字の定数の ::text と、数の定数の型の印を外す。CURRENT_TIMESTAMP の変換の式（TIMESTAMP_TEXT）は CURRENT_TIMESTAMP に戻す
// - pk: 主キーの中の順番（1から。主キーでない列は 0）。cid: 列の順番（0から）
// - 外部キーの id: SQLite と同じく、表の中で宣言の逆の順（最後の外部キーが 0）。pg-ddl は宣言の順に ALTER TABLE … ADD FOREIGN KEY
//   するので、制約の oid の順が宣言の順になる。seq は外部キーの中の列の順番（0から）
// - on_update・on_delete: NO ACTION・RESTRICT・CASCADE・SET NULL・SET DEFAULT。match: MATCH SIMPLE は SQLite の表示と同じ NONE
// definitionSource は 'pg-catalog'
// 表は SQLite（D1）と同じ一覧にする。PostgreSQL だけにある版の印の表（PG_FINGERPRINT_TABLE。業務の表ではない）は出さない
import {PG_FINGERPRINT_TABLE} from '../data-platform/pg-fingerprint.mjs';

const PG_TABLE_FILTER = `c.relkind IN ('r', 'p') AND c.relnamespace = current_schema()::regnamespace AND c.relname NOT LIKE 'sqlite_%' AND c.relname NOT LIKE '_cf_%' AND c.relname <> 'd1_migrations' AND c.relname <> '${PG_FINGERPRINT_TABLE}'`;
const PG_TYPES = {bigint: 'INTEGER', text: 'TEXT', 'double precision': 'REAL', numeric: '', bytea: 'BLOB'};
const PG_ACTIONS = {a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT'};
const PG_MATCH = {s: 'NONE', f: 'FULL', p: 'PARTIAL'};
const TEXT_CAST = /^('(?:[^']|'')*')::(?:text|character varying|character)$/;
const NUMBER_DEFAULT = /^\(?'?(-?\d+(?:\.\d+)?)'?\)?(?:::(?:bigint|integer|smallint|numeric|double precision))?$/;

export function sqliteDefault(text) {
  if (text === null || text === undefined) return null;
  const literal = TEXT_CAST.exec(text);
  if (literal) return literal[1];
  const number = NUMBER_DEFAULT.exec(text);
  if (number) return number[1];
  if (/^to_char\(\(?statement_timestamp\(\) AT TIME ZONE 'UTC'(?:::text)?\)?, 'YYYY-MM-DD HH24:MI:SS'(?:::text)?\)$/.test(text)) return 'CURRENT_TIMESTAMP';
  return text;
}

export async function readPgTableSchema(db) {
  const names = await db.all(`SELECT c.relname AS name FROM pg_class c WHERE ${PG_TABLE_FILTER} ORDER BY c.relname COLLATE "C"`);
  const columns = await db.all(`SELECT c.relname AS table_name, row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum) - 1 AS cid, a.attname AS name,
      format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN a.attnotnull THEN 1 ELSE 0 END AS "notnull",
      pg_get_expr(d.adbin, d.adrelid) AS dflt_value, COALESCE(array_position(k.conkey, a.attnum), 0) AS pk
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    LEFT JOIN pg_constraint k ON k.conrelid = c.oid AND k.contype = 'p'
    WHERE ${PG_TABLE_FILTER} ORDER BY c.relname COLLATE "C", a.attnum`);
  const keys = await db.all(`SELECT c.relname AS table_name, f.oid::text AS constraint_oid, x.n - 1 AS seq, r.relname AS ref_table,
      fa.attname AS from_column, ta.attname AS to_column, f.confupdtype AS on_update, f.confdeltype AS on_delete, f.confmatchtype AS match_type
    FROM pg_class c JOIN pg_constraint f ON f.conrelid = c.oid AND f.contype = 'f'
    JOIN pg_class r ON r.oid = f.confrelid
    CROSS JOIN LATERAL unnest(f.conkey, f.confkey) WITH ORDINALITY x(from_num, to_num, n)
    JOIN pg_attribute fa ON fa.attrelid = f.conrelid AND fa.attnum = x.from_num
    JOIN pg_attribute ta ON ta.attrelid = f.confrelid AND ta.attnum = x.to_num
    WHERE ${PG_TABLE_FILTER} ORDER BY c.relname COLLATE "C", f.oid, x.n`);
  const tables = new Map(names.map(({name}) => [name, {name, columns: [], foreignKeys: []}]));
  for (const {table_name, type, dflt_value, ...column} of columns) {
    tables.get(table_name)?.columns.push({cid: Number(column.cid), name: column.name, type: Object.hasOwn(PG_TYPES, type) ? PG_TYPES[type] : type,
      notnull: Number(column.notnull), dflt_value: sqliteDefault(dflt_value), pk: Number(column.pk)});
  }
  // 外部キーの id は、表の中の制約の数から宣言の順（oid の順）を引いたもの（SQLite と同じく最後の宣言が 0）
  const order = new Map();
  for (const key of keys) {
    const list = order.get(key.table_name) ?? [];
    if (!list.includes(key.constraint_oid)) list.push(key.constraint_oid);
    order.set(key.table_name, list);
  }
  const rows = keys.map((key) => {
    const list = order.get(key.table_name);
    return {table_name: key.table_name, id: list.length - 1 - list.indexOf(key.constraint_oid), seq: Number(key.seq), table: key.ref_table, from: key.from_column, to: key.to_column,
      on_update: PG_ACTIONS[key.on_update] ?? key.on_update, on_delete: PG_ACTIONS[key.on_delete] ?? key.on_delete, match: PG_MATCH[key.match_type] ?? key.match_type};
  }).sort((a, b) => (a.table_name < b.table_name ? -1 : a.table_name > b.table_name ? 1 : a.id - b.id || a.seq - b.seq));
  for (const {table_name, ...key} of rows) tables.get(table_name)?.foreignKeys.push(key);
  return {tables: [...tables.values()], definitionSource: 'pg-catalog'};
}
