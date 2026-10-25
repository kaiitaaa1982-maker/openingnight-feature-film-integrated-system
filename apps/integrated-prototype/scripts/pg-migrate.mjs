#!/usr/bin/env node
// 差分の移行（PG 計画 段2の実測 S14）を、動いている PostgreSQL に当てる道具。差分の SQL は scripts/pg-ddl.mjs の convertDelta が作る
// （起点の版の印より新しい移行の節だけ。中身と順はそちらの冒頭）。この道具は、起点を決めて差分と照合の SQL をファイルに書く（plan）、
// node の pg の Client で BEGIN → 照合の前 → 差分 → 照合の後 → COMMIT と当てる（apply。予行は ROLLBACK）、定義を写して比べる（snapshot・compare）。
//
//   node scripts/pg-migrate.mjs plan (--from <起点の移行のファイル名> | --fingerprint <版の印の JSON>) --out <フォルダ>
//       起点の schema.sql（base-schema.sql）・reconcile.sql（base-reconcile.sql）・差分（delta.sql）・照合（check-before.sql・check-after.sql）・
//       plan.json を書く。--fingerprint は DB の版の印の行（SELECT row_to_json）か世代の manifest（schema を読む）で、起点はその last_migration
//   node scripts/pg-migrate.mjs status --fingerprint <版の印の JSON>      起点を決めるだけ（書かない）
//   node scripts/pg-migrate.mjs apply [--dry-run]                          PG 標準の環境変数で接続し、版の印を読んで当てる
//   node scripts/pg-migrate.mjs snapshot --out <JSON> [--state]            定義の写し（scripts/pg-definition.mjs）
//   node scripts/pg-migrate.mjs compare --left <JSON> --right <JSON>       2つの写しを比べる（0=一致、1=違う、2=入力の誤り）
//
// 照合の SQL は、差分と同じトランザクションの中で流す（psql の -1 なら check-before.sql → delta.sql → check-after.sql の順に -f で渡す）。
// check-before.sql は REPEATABLE READ にし、新しい節が INSERT する既存の IDENTITY の表を、最初の読み（snapshot を決める）の前に EXCLUSIVE で押さえてから
// （PostgreSQL の LOCK の文書のとおり。押さえる前の行は snapshot に入り、押さえた後は別の接続が行を入れられないので、差分の (5) の MAX が古い時点の値に
// ならない）、起点の reconcile.sql の結果（表ごとの件数と金額の合計だけ）を一時表に控える。
// check-after.sql は同じ結果を取り直し、元の表（新しい節が INSERT する既存の表を除く）の件数と金額が変わらないこと、新しい節が INSERT した
// 既存の表の行が入れた数だけ増えたこと、新しい表の行の数が移行の入れる数と同じことを確かめ、外れたら固定の語で RAISE する（COMMIT の前なので全部戻る）。
// 重なりを飛ばす INSERT（INSERT OR IGNORE）を含む表は「前以上、前＋VALUES の行の数以下」、INSERT … SELECT を含む表は「前以上」だけを見る。
// 出力は「reconcile_before|<JSON>」「reconcile_after|<JSON>」「new_tables|<JSON>」の行で、JSON は scripts/ops/pg-reconcile.mjs が読む形。
//
// 失敗は {"event":"pg_migrate_failed","cause":"<原因の種類>"} の1行だけを出す。原因の種類は、この道具の許可リストの語・差分の SQL の RAISE の
// 固定の語（DELTA_RAISE_WORDS）と照合の語・SQLSTATE の5文字・それ以外は unexpected（src/data-platform/pg-export-format.mjs の failureCause と同じ形）。
// 元のエラーの文・SQL・行の値・接続値は出さない
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DELTA_LOCK_TIMEOUT_MS, DELTA_RAISE_WORDS, DELTA_STATEMENT_TIMEOUT_MS, DeltaError, FINGERPRINT_COLUMNS, MIGRATIONS_DIR, SOURCE_PATCHES, convertDelta, convertMigrations, fingerprintRow,
} from './pg-ddl.mjs';
import { definitionDiff, definitionSnapshot } from './pg-definition.mjs';
import { compareReconciliation, failureCause } from '../src/data-platform/pg-export-format.mjs';
import { PG_FINGERPRINT_TABLE } from '../src/data-platform/pg-fingerprint.mjs';

// 照合（check-after.sql）の RAISE の固定の語
export const CHECK_RAISE_WORDS = Object.freeze(['reconcile_mismatch', 'new_table_rows']);
// この道具が出す原因の種類（許可リスト）。DeltaError の語・入力の誤り・起点の決め方
export const MIGRATE_ERROR_CODES = Object.freeze([
  'app_ddl_sources', 'base_mismatch', 'base_unknown', 'convert_failed', 'database_ahead', 'input_missing', 'invalid_arguments', 'invalid_fingerprint',
  'invalid_json', 'invalid_snapshot', 'no_fingerprint', 'sections_changed',
]);
const ERROR_SET = new Set(MIGRATE_ERROR_CODES);
const RAISE_SET = new Set([...DELTA_RAISE_WORDS, ...CHECK_RAISE_WORDS]);
const MARK = Symbol.for('openingnight.pg-migrate-error');

export function migrateError(code) {
  const error = new Error(`PG migrate: ${code}`);
  error.code = code;
  error[MARK] = true;
  return error;
}

// 失敗をログに出すときの原因の種類（値を含めない）
export function migrateFailureCause(error) {
  if (error instanceof DeltaError || error?.[MARK] === true) return ERROR_SET.has(error.code) ? error.code : 'unexpected';
  if (error?.code === 'P0001' && RAISE_SET.has(error.message)) return error.message;
  return failureCause(error);
}

const quoteLiteral = (text) => `'${String(text).replaceAll("'", "''")}'`;
// 表の名前はいつも引用符で囲む（予約語と重なっても壊さない。小文字の名前は囲んでも同じ表）
const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;
const SHA = /^[0-9a-f]{64}$/;

// DB の版の印の行（または世代の manifest。schema を読む）を、12の列の文字の行にする。形が違えば invalid_fingerprint
export function normalizeFingerprint(input) {
  const source = input && typeof input === 'object' && input.schema && typeof input.schema === 'object' && !Array.isArray(input.schema) ? input.schema : input;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw migrateError('invalid_fingerprint');
  const row = {};
  for (const column of FINGERPRINT_COLUMNS) {
    const value = source[column];
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw migrateError('invalid_fingerprint');
    row[column] = String(value);
  }
  const shapeOk = row.generator.length > 0 && row.generator.length <= 100
    && ['source_sha256', 'migrations_sha256', 'app_ddl_sha256', 'ddl_sha256'].every((c) => SHA.test(row[c]))
    && /^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(row.last_migration)
    && FINGERPRINT_COLUMNS.filter((c) => c.startsWith('expected_')).every((c) => /^\d{1,9}$/.test(row[c]));
  if (!shapeOk) throw migrateError('invalid_fingerprint');
  return row;
}

const sameRow = (a, b) => FINGERPRINT_COLUMNS.every((c) => a[c] === b[c]);

// 版の印の行から起点を決める。state は current（全体と同じ。当てるものが無い）か delta（起点 → 最後の移行）。
// 起点の移行がこの作業場に無ければ database_ahead（DB の方が新しいか、別の版）、12の列が起点の変換と違えば base_mismatch
export function planFromFingerprint(input, { dir = MIGRATIONS_DIR, patches = SOURCE_PATCHES, ...options } = {}) {
  const row = normalizeFingerprint(input);
  let delta;
  try { delta = convertDelta({ dir, patches, from: row.last_migration, ...options }); }
  catch (error) { if (error instanceof DeltaError && error.code === 'base_unknown') throw migrateError('database_ahead'); throw error; }
  const expected = delta.state === 'current' ? fingerprintRow(delta.full.fingerprint) : delta.fromRow;
  if (!sameRow(row, expected)) throw migrateError('base_mismatch');
  return delta;
}

// 起点の reconcile.sql の結果を JSON にする式（新しい節が INSERT する既存の表は除く。その表は check-after.sql が増えた数で見る）
function reconcileJson(table, changed) {
  return `COALESCE((SELECT json_agg(json_build_object('table_name', table_name, 'row_count', row_count::text, 'money_sums', money_sums) ORDER BY ord)
    FROM ${table} WHERE table_name <> ALL (ARRAY[${changed.map(quoteLiteral).join(', ')}]::text[]))::text, '[]')`;
}
const utcNow = `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// 照合の SQL（差分の前と後。差分と同じトランザクションで流す）
export function checkSql(delta, { lockTimeoutMs = DELTA_LOCK_TIMEOUT_MS, statementTimeoutMs = DELTA_STATEMENT_TIMEOUT_MS } = {}) {
  const changed = delta.changedTables.map((c) => c.table);
  const locked = [...new Set(delta.seqTargets.filter((x) => x.existing).map((x) => x.table))];
  const before = [
    `-- 生成物（scripts/pg-migrate.mjs plan）。差分の移行（${delta.from} → ${delta.to}）の前に、同じトランザクションの最初に流す`,
    '-- 新しい節が INSERT する既存の IDENTITY の表を、最初の読みの前に EXCLUSIVE で押さえる（読むのは止めない）。',
    '-- 起点の reconcile.sql の結果（表ごとの件数と金額の合計だけ。値の行は出さない）を一時表に控えて出す',
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;',
    `SET LOCAL lock_timeout = ${quoteLiteral(`${lockTimeoutMs}ms`)};`,
    `SET LOCAL statement_timeout = ${quoteLiteral(`${statementTimeoutMs}ms`)};`,
    ...locked.map((table) => `LOCK TABLE ${quoteIdent(table)} IN EXCLUSIVE MODE;`),
    'CREATE TEMP TABLE pg_migrate_before ON COMMIT DROP AS',
    `${delta.base.reconcileSelect};`,
    `SELECT 'reconcile_before|' || ${reconcileJson('pg_migrate_before', changed)} AS line;`,
    `SELECT 'apply_started|' || ${utcNow} AS line;`,
    '',
  ].join('\n');
  // 新しい表: ちょうどの数が分かれば等しい、上限だけ分かれば以下。既存の表: ちょうど前＋数、上限だけなら前以上・前＋上限以下、どちらも無ければ前以上
  const newChecks = delta.newTables.flatMap(({ table, rows, maxRows }) => {
    const count = `(SELECT count(*) FROM ${quoteIdent(table)})`;
    if (rows !== null) return [`${count} <> ${rows}`];
    if (maxRows !== null) return [`${count} > ${maxRows}`];
    return [];
  });
  const changedChecks = delta.changedTables.map(({ table, rows, maxRows }) => {
    const bad = rows !== null ? `a.row_count <> b.row_count + ${rows}`
      : maxRows !== null ? `(a.row_count < b.row_count OR a.row_count > b.row_count + ${maxRows})` : 'a.row_count < b.row_count';
    return `(table_name = ${quoteLiteral(table)} AND ${bad})`;
  });
  // jsonb_build_object の引数は100個まで（表1つで2個）。40表ずつに分けて || でつなぐ
  const newTablePairs = delta.newTables.map(({ table }) => `${quoteLiteral(table)}, (SELECT count(*) FROM ${quoteIdent(table)})`);
  const newTableChunks = [];
  for (let i = 0; i < newTablePairs.length; i += 40) newTableChunks.push(`jsonb_build_object(${newTablePairs.slice(i, i + 40).join(', ')})`);
  const newTablesJson = newTableChunks.length ? `(${newTableChunks.join(' || ')})::text` : "'{}'";
  const after = [
    `-- 生成物（scripts/pg-migrate.mjs plan）。差分の移行（${delta.from} → ${delta.to}）の後、COMMIT の前に、同じトランザクションで流す`,
    '-- 起点の reconcile.sql の結果を取り直して比べる。新しい表の行の数を、移行が入れる数と比べる。外れたら固定の語で RAISE（全部戻る）',
    'CREATE TEMP TABLE pg_migrate_after ON COMMIT DROP AS',
    `${delta.base.reconcileSelect};`,
    `SELECT 'reconcile_after|' || ${reconcileJson('pg_migrate_after', changed)} AS line;`,
    `SELECT 'new_tables|' || ${newTablesJson} AS line;`,
    'DO $check$',
    'BEGIN',
    '  IF EXISTS (SELECT 1 FROM pg_migrate_before b FULL JOIN pg_migrate_after a USING (table_name)',
    `      WHERE table_name <> ALL (ARRAY[${changed.map(quoteLiteral).join(', ')}]::text[])`,
    '        AND (b.ord IS NULL OR a.ord IS NULL OR a.row_count <> b.row_count OR a.money_sums IS DISTINCT FROM b.money_sums)) THEN',
    "    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reconcile_mismatch';",
    '  END IF;',
    ...(changedChecks.length ? [
      '  IF EXISTS (SELECT 1 FROM pg_migrate_before b JOIN pg_migrate_after a USING (table_name)',
      `      WHERE ${changedChecks.join(' OR ')}) THEN`,
      "    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reconcile_mismatch';",
      '  END IF;',
    ] : []),
    ...(newChecks.length ? [
      `  IF ${newChecks.join('\n    OR ')} THEN`,
      "    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'new_table_rows';",
      '  END IF;',
    ] : []),
    'END',
    '$check$;',
    `SELECT 'apply_checked|' || ${utcNow} AS line;`,
    '',
  ].join('\n');
  return { before, after };
}

const asMap = (list) => Object.fromEntries(list.map(({ table, rows }) => [table, rows]));
export function planSummary(delta) {
  if (delta.state === 'current') return { state: 'current', from: delta.from, to: delta.to };
  return {
    state: 'delta', from: delta.from, to: delta.to, sections: delta.sections,
    new_tables: asMap(delta.newTables), changed_tables: asMap(delta.changedTables), identity_targets: delta.seqTargets.length,
    from_fingerprint: delta.fromRow, to_fingerprint: delta.toRow,
  };
}

// plan のファイル（名前 → 中身）。改行は LF
export function planFiles(delta, options = {}) {
  const checks = checkSql(delta, options);
  return {
    'base-schema.sql': delta.base.sql,
    'base-reconcile.sql': delta.base.reconcile,
    'check-before.sql': checks.before,
    'delta.sql': delta.sql,
    'check-after.sql': checks.after,
    'plan.json': `${JSON.stringify(planSummary(delta), null, 2)}\n`,
  };
}

// psql の -tA の出力・pg の結果から「名前|値」の行を拾う
export function outputLines(lines) {
  const out = {};
  for (const line of lines) {
    const at = typeof line === 'string' ? line.indexOf('|') : -1;
    if (at > 0 && /^[a-z_]+$/.test(line.slice(0, at))) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}
const resultLines = (result) => (Array.isArray(result) ? result : [result]).flatMap((r) => (r?.rows ?? []).map((row) => row.line).filter((x) => typeof x === 'string'));

// 起点の照合の前と後を、scripts/ops/pg-reconcile.mjs と同じ比べ方で比べる（どちらも空なら比べる表が無い）
export function compareCheckOutputs(lines) {
  const before = JSON.parse(lines.reconcile_before ?? 'null');
  const after = JSON.parse(lines.reconcile_after ?? 'null');
  if (!Array.isArray(before) || !Array.isArray(after)) throw migrateError('invalid_json');
  if (!before.length && !after.length) return { equal: true, differences: [], tables: 0 };
  return { ...compareReconciliation(before, after), tables: before.length };
}

// DB の版の印の行を読む（表が無い・1行でなければ no_fingerprint）
export async function readDbFingerprint(client) {
  const found = await client.query(`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = $1 AND relkind IN ('r', 'p')`, [PG_FINGERPRINT_TABLE]);
  if (found.rows[0].n !== 1) throw migrateError('no_fingerprint');
  const { rows } = await client.query(`SELECT * FROM ${quoteIdent(PG_FINGERPRINT_TABLE)}`);
  if (rows.length !== 1) throw migrateError('no_fingerprint');
  return rows[0];
}

// node の当て方: BEGIN → check-before → delta → check-after → COMMIT（予行は ROLLBACK）。途中で落ちたら ROLLBACK して投げ直す
export async function applyDelta({ client, delta, dryRun = false, options = {}, clock = () => performance.now() }) {
  const checks = checkSql(delta, options);
  const t0 = clock();
  await client.query('BEGIN');
  let lines;
  let t1;
  let t2;
  try {
    const before = resultLines(await client.query(checks.before));
    t1 = clock();
    await client.query(delta.sql);
    t2 = clock();
    const after = resultLines(await client.query(checks.after));
    lines = outputLines([...before, ...after]);
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* 元の失敗を投げる */ }
    throw error;
  }
  const t3 = clock();
  const reconcile = compareCheckOutputs(lines);
  const ms = (a, b) => Math.round(b - a);
  return {
    state: dryRun ? 'dry_run' : 'applied', from: delta.from, to: delta.to, sections: delta.sections,
    reconcile_equal: reconcile.equal, reconcile_tables: reconcile.tables, differences: reconcile.differences.length,
    new_tables: JSON.parse(lines.new_tables ?? '{}'), expected_new_tables: asMap(delta.newTables),
    durations_ms: { check_before: ms(t0, t1), delta: ms(t1, t2), check_after_and_end: ms(t2, t3), total: ms(t0, t3) },
    lines,
  };
}

// 版の印を読み、起点を決めて当てる。当てるものが無ければ当てない
export async function migrateDatabase({ client, dryRun = false, dir = MIGRATIONS_DIR, patches = SOURCE_PATCHES, options = {} }) {
  const row = await readDbFingerprint(client);
  const delta = planFromFingerprint(row, { dir, patches, ...options });
  if (delta.state === 'current') return { state: 'current', from: delta.from, to: delta.to };
  return applyDelta({ client, delta, dryRun, options });
}

const readJson = (path) => {
  let text;
  try { text = readFileSync(path, 'utf8').replace(/^﻿/, ''); } catch (error) { if (error.code === 'ENOENT') throw migrateError('input_missing'); throw error; }
  try { return JSON.parse(text); } catch { throw migrateError('invalid_json'); }
};

async function connect() {
  const { default: pg } = await import('pg');
  const client = new pg.Client();
  client.on('error', () => { /* query・end の失敗だけを固定の文にして出す */ });
  await client.connect();
  return client;
}

export async function migrateCli(argv, { out = (line) => console.log(line), err = (line) => console.error(line), dir = MIGRATIONS_DIR, patches = SOURCE_PATCHES, open = connect } = {}) {
  const [command, ...rest] = argv;
  let client;
  let code = 0;
  try {
    let values;
    try {
      ({ values } = parseArgs({ args: rest, options: { from: { type: 'string' }, fingerprint: { type: 'string' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' },
        state: { type: 'boolean' }, left: { type: 'string' }, right: { type: 'string' } } }));
    } catch { throw migrateError('invalid_arguments'); }
    if (command === 'plan' || command === 'status') {
      if (Boolean(values.from) === Boolean(values.fingerprint) || (command === 'plan' && !values.out)) throw migrateError('invalid_arguments');
      let delta;
      if (values.fingerprint) delta = planFromFingerprint(readJson(values.fingerprint), { dir, patches });
      else delta = convertDelta({ dir, patches, from: values.from });
      if (command === 'plan' && delta.state === 'delta') {
        mkdirSync(values.out, { recursive: true });
        for (const [name, text] of Object.entries(planFiles(delta))) writeFileSync(resolve(values.out, name), text);
      }
      out(JSON.stringify(planSummary(delta)));
    } else if (command === 'apply') {
      // 変換できない移行があれば、接続する前に止める
      if (convertMigrations({ dir, patches }).errors.length) throw new DeltaError('convert_failed');
      client = await open();
      const result = await migrateDatabase({ client, dryRun: Boolean(values['dry-run']), dir, patches });
      const { lines, ...shown } = result;
      out(JSON.stringify(shown));
    } else if (command === 'snapshot') {
      if (!values.out) throw migrateError('invalid_arguments');
      client = await open();
      const snapshot = await definitionSnapshot((sql, params) => client.query(sql, params).then((r) => r.rows), { state: Boolean(values.state) });
      writeFileSync(values.out, `${JSON.stringify(snapshot)}\n`);
      out(JSON.stringify({ tables: snapshot.tables.length, functions: snapshot.functions.length, sequences: snapshot.sequences.length, state: Boolean(values.state) }));
    } else if (command === 'compare') {
      if (!values.left || !values.right) throw migrateError('invalid_arguments');
      const left = readJson(values.left);
      const right = readJson(values.right);
      if (!Array.isArray(left?.tables) || !Array.isArray(right?.tables)) throw migrateError('invalid_snapshot');
      const differences = definitionDiff(left, right);
      out(JSON.stringify({ equal: differences.length === 0, differences }));
      code = differences.length ? 1 : 0;
    } else throw migrateError('invalid_arguments');
  } catch (error) {
    err(JSON.stringify({ event: 'pg_migrate_failed', cause: migrateFailureCause(error) }));
    code = command === 'compare' ? 2 : 1;
  } finally {
    if (client) {
      try { await client.end(); }
      catch (error) { err(JSON.stringify({ event: 'pg_migrate_close_failed', cause: migrateFailureCause(error) })); code = code || 1; }
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await migrateCli(process.argv.slice(2));
}
