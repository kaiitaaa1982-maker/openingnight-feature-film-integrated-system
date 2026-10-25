// PostgreSQL の定義の写し（PG 計画 段2の実測 S14。差分の移行を当てた DB と、新しい全体の pg/schema.sql を当てた DB を比べる）。
// test/pg-schema-compare.mjs の取り方（いまのスキーマ current_schema() のカタログを表ごとに写し、数でなく中身で比べる）を、名前と定義まで広げたもの:
//   列（attnum の順・型・照合順序・NOT NULL・IDENTITY・既定値の式）・制約（名前と pg_get_constraintdef）・トリガー（名前と pg_get_triggerdef）・
//   関数（名前・引数・戻り値・言語・揮発性・本体）・索引（名前と pg_get_indexdef）・シーケンス（型・開始・増分・上下限・cycle）・版の印の行。
// state を付けると、シーケンスの今の値（last_value・is_called）と表ごとの行の数と行の中身の md5 も写す（空の DB 同士の比べ。業務の行の値は出さない）。
// 使う所: test/pg-migrate.test.mjs、scripts/pg-migrate.mjs の snapshot・compare（CI の integrated-postgres と練習 G の ps1）。
// 外へは届かない（渡された接続で読むだけ）。スキーマの名前（試験の pgdb_… や public）は定義の文から外して比べる
import { PG_FINGERPRINT_TABLE } from '../src/data-platform/pg-fingerprint.mjs';

const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

// query(sql, params) は行の配列を返す関数（pg の Client なら (sql, params) => client.query(sql, params).then((r) => r.rows)）
export async function definitionSnapshot(query, { state = false } = {}) {
  const [{ schema }] = await query('SELECT current_schema() AS schema');
  const strip = (text) => (text == null ? text : String(text).replaceAll(`${quoteIdent(schema)}.`, '').replaceAll(`${schema}.`, ''));
  const tables = (await query(`SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p')
    ORDER BY c.relname COLLATE "C"`)).map((r) => r.name);
  const byTable = () => Object.fromEntries(tables.map((t) => [t, []]));

  const columns = byTable();
  // 行の中身の md5 に入れる列（作った時刻の既定値の列は、DB を作った時刻で変わるので除く）
  const rowColumns = byTable();
  for (const r of await query(`SELECT c.relname AS tbl, a.attnum::int AS attnum, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
      a.attidentity::text AS identity, a.attgenerated::text AS generated, CASE WHEN a.attcollation = 0 THEN NULL ELSE (SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation) END AS collation,
      pg_get_expr(d.adbin, d.adrelid) AS default_expr
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname COLLATE "C", a.attnum`)) {
    columns[r.tbl].push([r.attnum, r.name, r.type, r.collation, r.not_null, r.identity, r.generated, strip(r.default_expr)].join('|'));
    if (!/statement_timestamp\(\)|now\(\)|CURRENT_TIMESTAMP/i.test(r.default_expr ?? '')) rowColumns[r.tbl].push(r.name);
  }

  const constraints = byTable();
  for (const r of await query(`SELECT c.relname AS tbl, k.conname AS name, k.contype::text AS type, pg_get_constraintdef(k.oid) AS def, k.condeferrable AS deferrable, k.condeferred AS deferred
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p')
    ORDER BY c.relname COLLATE "C", k.conname COLLATE "C"`)) {
    constraints[r.tbl].push([r.name, r.type, strip(r.def), r.deferrable, r.deferred].join('|'));
  }

  const triggers = byTable();
  for (const r of await query(`SELECT c.relname AS tbl, t.tgname AS name, pg_get_triggerdef(t.oid) AS def, t.tgenabled::text AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal
    ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`)) {
    triggers[r.tbl].push([r.name, strip(r.def), r.enabled].join('|'));
  }

  const indexes = byTable();
  for (const r of await query(`SELECT t.relname AS tbl, i.relname AS name, pg_get_indexdef(x.indexrelid) AS def
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
    WHERE t.relnamespace = current_schema()::regnamespace AND t.relkind IN ('r', 'p')
    ORDER BY t.relname COLLATE "C", i.relname COLLATE "C"`)) {
    indexes[r.tbl].push([r.name, strip(r.def)].join('|'));
  }

  const functions = (await query(`SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result, l.lanname AS language,
      p.provolatile::text AS volatility, p.prosrc AS body
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.pronamespace = current_schema()::regnamespace
    ORDER BY p.proname COLLATE "C", pg_get_function_identity_arguments(p.oid) COLLATE "C"`)).map((r) => [r.name, r.args, strip(r.result), r.language, r.volatility, r.body].join('|'));

  const sequenceRows = await query(`SELECT s.relname AS name, format_type(q.seqtypid, NULL) AS type, q.seqstart::text AS start, q.seqincrement::text AS increment,
      q.seqmin::text AS min, q.seqmax::text AS max, q.seqcache::text AS cache, q.seqcycle AS cycle
    FROM pg_sequence q JOIN pg_class s ON s.oid = q.seqrelid WHERE s.relnamespace = current_schema()::regnamespace ORDER BY s.relname COLLATE "C"`);
  const sequences = sequenceRows.map((r) => [r.name, r.type, r.start, r.increment, r.min, r.max, r.cache, r.cycle].join('|'));

  let fingerprint = null;
  if (tables.includes(PG_FINGERPRINT_TABLE)) {
    fingerprint = (await query(`SELECT * FROM ${quoteIdent(PG_FINGERPRINT_TABLE)}`)).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)])));
  }

  const snapshot = { tables, columns, constraints, triggers, indexes, functions, sequences, fingerprint };
  if (state) {
    snapshot.sequenceState = [];
    for (const r of sequenceRows) {
      const [row] = await query(`SELECT last_value::text AS last_value, is_called FROM ${quoteIdent(r.name)}`);
      snapshot.sequenceState.push(`${r.name}|${row.last_value}|${row.is_called}`);
    }
    // 行の数と、行の中身の md5（作った時刻の列を除いた行を文字にして並べた md5。値そのものは出さない）
    snapshot.rows = {};
    for (const table of tables) {
      const cols = rowColumns[table].map(quoteIdent).join(', ');
      const [row] = await query(`SELECT count(*)::text AS n, md5(COALESCE(string_agg(x.v, E'\\n' ORDER BY x.v COLLATE "C"), '')) AS h
        FROM (SELECT ROW(${cols})::text AS v FROM ${quoteIdent(table)}) x`);
      snapshot.rows[table] = `${row.n}|${row.h}`;
    }
  }
  return snapshot;
}

// 2つの写しの違いを、読める文の一覧にする（空なら一致）。文には表・制約などの名前だけを出し、行の値は出さない
export function definitionDiff(expected, actual) {
  const diffs = [];
  const keys = ['tables', 'functions', 'sequences', 'fingerprint', 'sequenceState'];
  for (const key of keys) {
    if (!(key in expected) && !(key in actual)) continue;
    const a = JSON.stringify(expected[key] ?? null);
    const b = JSON.stringify(actual[key] ?? null);
    if (a === b) continue;
    if (Array.isArray(expected[key]) && Array.isArray(actual[key])) {
      const missing = expected[key].filter((x) => !actual[key].includes(x)).length;
      const extra = actual[key].filter((x) => !expected[key].includes(x)).length;
      diffs.push(`${key}: 期待にあって無い ${missing}・期待に無い ${extra}${missing + extra === 0 ? '・並びが違う' : ''}`);
    } else diffs.push(`${key}: 違う`);
  }
  for (const key of ['columns', 'constraints', 'triggers', 'indexes', 'rows']) {
    if (!(key in expected) && !(key in actual)) continue;
    const left = expected[key] ?? {};
    const right = actual[key] ?? {};
    for (const table of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (JSON.stringify(left[table] ?? null) !== JSON.stringify(right[table] ?? null)) diffs.push(`${key}: ${table}`);
    }
  }
  return diffs;
}
