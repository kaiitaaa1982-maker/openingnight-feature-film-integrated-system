#!/usr/bin/env node
// 本番 D1 の書き出し（wrangler d1 export）を、配備の前に手元で調べる道具（runbooks/07-cd.md 手順 3-4・3-5）。
//
//   node scripts/ops/d1-rehearsal.mjs schema  --db <prod.sql|sqlite> --migrations <dir> [--applied <file,...>] [--json]
//   node scripts/ops/d1-rehearsal.mjs reorder --in <prod.sql|sqlite> --out <ordered.sql>
//
// schema: 書き出しの構造（表・トリガー・インデックス・ビューと、その定義の SQL）を、適用済みのマイグレーションだけを
//   白紙の DB に当てたものと比べる。本番が定義どおりかを、書き込む前に確かめるため。
//   あわせて、未適用のファイルのうち CASE を含むトリガーの数を出す。`wrangler d1 migrations apply --remote` は
//   そのようなファイルで `incomplete input: SQLITE_ERROR [code: 7500]` を返して落ちたことがある（2026-09-25 の本番配備）。
// reorder: 書き出しを「表の作成 → 行 → インデックス → ビュー → トリガー」の順の SQL に並べ直す。
//   D1 の書き出しは表ごとに「作成と行」が並ぶため、親の表より先に子の行が来ると、外部キーを確かめる
//   `wrangler d1 execute --local` が `no such table: main.<親の表>` で落ちる。並べ直したものは読み込める
//   （2026-09-25 に同じ並びの SQL を wrangler 4.127.0 の --local で読み込めた）。
//   AUTOINCREMENT の続き番号（sqlite_sequence）は写さない。そのときと同じ形に留めるため。
//   続き番号が無いと SQLite は「最大の id + 1」から振るので、予行の中で id がぶつかることはない。
//
// 入力の読み方は d1-reconcile.mjs と同じ（外部キーの確認を切って読み、400MiB を超える .sql は一時ファイル経由）。
// 名前が sqlite_ か _cf_ で始まるもの（SQLite と D1 の内部表、その上のインデックス・トリガー）は扱わない。
// 行の中身は標準出力に出さない（出すのは数と、表・トリガー・インデックス・ビューの名前だけ）。
// 終了コード: 0 = 差分なし・書き出した / 1 = 差分あり・外部キーの違反あり / 2 = 使い方の誤り・読み込みの失敗

import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EXCLUDED_PREFIXES, LoadError, openDatabase, redactSqliteMessage, splitSqlStatements } from './d1-reconcile.mjs';

// wrangler のマイグレーション記録。定義ファイルからは作られないので、構造の比較から外す
export const MIGRATIONS_TABLE = 'd1_migrations';

const USAGE = `使い方:
  node scripts/ops/d1-rehearsal.mjs schema  --db <prod.sql|sqlite> --migrations <dir> [--applied <file,...>] [--json]
  node scripts/ops/d1-rehearsal.mjs reorder --in <prod.sql|sqlite> --out <ordered.sql>

schema   書き出しの構造を、適用済みのマイグレーションを白紙の DB に当てたものと比べる。
         未適用のファイルごとに、CASE を含むトリガーの数を出す。
  --db <file>          本番の書き出し（wrangler d1 export の .sql か SQLite ファイル）
  --migrations <dir>   マイグレーションのフォルダ（apps/integrated-prototype/migrations）
  --applied <list>     適用済みのファイル名をカンマで区切って並べる。省くと書き出しの d1_migrations 表から読む
  --json               結果を JSON で出す

reorder  書き出しを、表の作成 → 行 → インデックス → ビュー → トリガー の順の .sql にする。
         AUTOINCREMENT の続き番号（sqlite_sequence）は写さない。
  --in <file>          本番の書き出し
  --out <file>         書き出す先（リポジトリの外。中身は本番の行そのもの）

共通:
  --tmp-dir <dir>      400MiB を超える .sql を流し込む一時ファイルの置き場所（書き出しと同じ場所にする）
  -h, --help           この説明

終了コード: 0 = 差分なし・書き出した / 1 = 差分あり・外部キーの違反あり / 2 = 使い方の誤り・読み込みの失敗`;

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const isExcluded = (name) => EXCLUDED_PREFIXES.some((p) => String(name ?? '').toLowerCase().startsWith(p));

/** sqlite_master から、内部のものを除いたオブジェクトを作成の順に返す */
function schemaObjects(db) {
  return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').all()
    .filter((o) => !isExcluded(o.name) && !isExcluded(o.tbl_name));
}

/** 空白と記号のまわりの空白をそろえる。引用符・大文字小文字はそのまま（違いとして見せる） */
export function normalizeSql(sql) {
  return String(sql ?? '').replace(/\s+/g, ' ').replace(/\s*([(),;=])\s*/g, '$1').trim();
}

/** 識別子の二重引用符だけを外す。引用符だけの違いかを見分けるのに使う */
const unquoteIdents = (sql) => sql.replace(/"((?:[^"]|"")+)"/g, (_, s) => s.replace(/""/g, '"'));

// ------------------------------------------------ schema

/** 文字列・コメントを除いて、CREATE TRIGGER の中に CASE があるかを数える */
export function countCaseTriggers(sqlText) {
  let n = 0;
  for (const { sql } of splitSqlStatements(sqlText)) {
    const bare = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' ');
    if (/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(bare) && /\bCASE\b/i.test(bare)) n += 1;
  }
  return n;
}

function describeObjects(db) {
  const map = new Map();
  const counts = { tables: 0, triggers: 0, indexes: 0, views: 0 };
  const key = { table: 'tables', trigger: 'triggers', index: 'indexes', view: 'views' };
  for (const o of schemaObjects(db)) {
    if (o.type === 'table' && o.name.toLowerCase() === MIGRATIONS_TABLE) continue;
    map.set(`${o.type}:${o.name}`, normalizeSql(o.sql));
    if (key[o.type]) counts[key[o.type]] += 1;
  }
  return { map, counts };
}

function readApplied(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND lower(name)=?").get(MIGRATIONS_TABLE);
  if (!exists) return null;
  return db.prepare(`SELECT name FROM ${quoteIdent(MIGRATIONS_TABLE)} ORDER BY id`).all().map((r) => r.name);
}

export async function compareSchema({ dbPath, migrationsDir, applied, openOptions = {} }) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new LoadError('node:sqlite が使えない。Node 22.13 以上か Node 24 で実行する');
  }
  if (!existsSync(migrationsDir)) throw new LoadError(`マイグレーションのフォルダが無い: ${migrationsDir}`);
  const files = readdirSync(migrationsDir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
  const { db, cleanup } = await openDatabase(dbPath, openOptions);
  let recorded;
  let prod;
  try {
    recorded = readApplied(db);
    prod = describeObjects(db);
  } finally {
    db.close();
    cleanup?.();
  }
  const appliedFiles = applied ?? recorded;
  if (!appliedFiles) throw new LoadError(`書き出しに ${MIGRATIONS_TABLE} の表が無い。--applied で適用済みのファイル名を並べる（wrangler d1 migrations list で未適用と出なかったもの）`);
  const missing = appliedFiles.filter((f) => !files.includes(f));
  if (missing.length) throw new LoadError(`適用済みとされたファイルがフォルダに無い: ${missing.join(', ')}`);

  const base = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  let defs;
  try {
    for (const f of appliedFiles) {
      try {
        base.exec(readFileSync(join(migrationsDir, f), 'utf8'));
      } catch (e) {
        throw new LoadError(`定義ファイルを白紙の DB に当てられない: ${f}: ${redactSqliteMessage(e.message)}`);
      }
    }
    defs = describeObjects(base);
  } finally {
    base.close();
  }

  const onlyInDb = [...prod.map.keys()].filter((k) => !defs.map.has(k));
  const onlyInDefinitions = [...defs.map.keys()].filter((k) => !prod.map.has(k));
  const differentSql = [...prod.map.keys()].filter((k) => defs.map.has(k) && prod.map.get(k) !== defs.map.get(k))
    .map((k) => ({ object: k, quotesOnly: unquoteIdents(prod.map.get(k)) === unquoteIdents(defs.map.get(k)) }));
  const pending = files.filter((f) => !appliedFiles.includes(f))
    .map((f) => ({ file: f, caseTriggers: countCaseTriggers(readFileSync(join(migrationsDir, f), 'utf8')) }));
  return {
    match: onlyInDb.length === 0 && onlyInDefinitions.length === 0 && differentSql.length === 0,
    db: { ...prod.counts, migrationsTable: recorded !== null, recorded: recorded ?? [] },
    definitions: { ...defs.counts, applied: appliedFiles, appliedFrom: applied ? '--applied' : MIGRATIONS_TABLE },
    onlyInDb,
    onlyInDefinitions,
    differentSql,
    pending,
  };
}

function renderSchema(r, dbPath) {
  const c = (x) => `表 ${x.tables} / トリガー ${x.triggers} / インデックス ${x.indexes} / ビュー ${x.views}`;
  const lines = [
    `書き出し ${basename(dbPath)}: ${c(r.db)}（${MIGRATIONS_TABLE}: ${r.db.migrationsTable ? `${r.db.recorded.length}件` : '無し'}。比較には入れない）`,
    `定義（${r.definitions.appliedFrom} の ${r.definitions.applied.length}ファイル: ${r.definitions.applied.join(', ') || 'なし'}）: ${c(r.definitions)}`,
  ];
  const list = (title, items) => { if (items.length) lines.push(`${title} ${items.length}件:`, ...items.map((s) => `  ${s}`)); };
  list('書き出しだけにある', r.onlyInDb);
  list('定義だけにある', r.onlyInDefinitions);
  list('名前は同じで定義が違う', r.differentSql.map((d) => `${d.object}${d.quotesOnly ? '（識別子の引用符だけの違い）' : ''}`));
  if (r.pending.length) {
    lines.push('未適用のファイル:', ...r.pending.map((p) => `  ${p.file}（CASE を含むトリガー ${p.caseTriggers}）`));
    if (r.pending.some((p) => p.caseTriggers > 0)) {
      lines.push('  CASE を含むトリガーがあるファイルは、migrations apply --remote で落ちることがある（runbooks/07-cd.md 手順 3-5）');
    }
  } else {
    lines.push('未適用のファイル: なし');
  }
  lines.push(r.match ? '判定: 定義どおり' : '判定: 差分あり（中身を確かめ、意味の違いが無いかを判断してから進む）');
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------ reorder

/** SQLite の値を SQL のリテラルにする。整数は BigInt で受け取り、桁を落とさない */
export function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NULL';
    if (!Number.isFinite(v)) return v > 0 ? '9e999' : '-9e999';
    // REAL の列の値。整数に見える値も REAL のまま戻すため小数点を付ける
    return Number.isInteger(v) && Math.abs(v) < 1e21 ? v.toFixed(1) : String(v);
  }
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function bufferedWriter(path) {
  const fd = openSync(path, 'w');
  let buf = [];
  let size = 0;
  const flush = () => { if (buf.length) { writeSync(fd, buf.join('')); buf = []; size = 0; } };
  return {
    line(s) { buf.push(s, '\n'); size += s.length + 1; if (size > 1 << 20) flush(); },
    close() { flush(); closeSync(fd); },
  };
}

export async function reorderExport({ inPath, outPath, openOptions = {} }) {
  const { db, cleanup } = await openDatabase(inPath, openOptions);
  const counts = { tables: 0, rows: 0, indexes: 0, views: 0, triggers: 0 };
  let fkViolations = [];
  try {
    const objects = schemaObjects(db);
    const virtual = objects.filter((o) => o.type === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql)).map((o) => o.name);
    if (virtual.length) throw new LoadError(`仮想表には対応していない: ${virtual.join(', ')}`);
    const tables = objects.filter((o) => o.type === 'table');
    const out = bufferedWriter(outPath);
    try {
      out.line('PRAGMA defer_foreign_keys=TRUE;');
      for (const t of tables) { out.line(`${t.sql};`); counts.tables += 1; }
      for (const t of tables) {
        // table_info は生成列を返さない（生成列には INSERT できない）
        const cols = db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all().map((c) => c.name);
        const head = `INSERT INTO ${quoteIdent(t.name)} (${cols.map(quoteIdent).join(',')}) VALUES(`;
        const stmt = db.prepare(`SELECT ${cols.map(quoteIdent).join(',')} FROM ${quoteIdent(t.name)}`);
        stmt.setReadBigInts(true);
        for (const row of stmt.iterate()) {
          out.line(`${head}${cols.map((c) => sqlLiteral(row[c])).join(',')});`);
          counts.rows += 1;
        }
      }
      // 行の後に作る。トリガーは読み込みの INSERT で動かない（書き出しの行は、トリガーが動いた後の値である）。
      // ビューはトリガーより先に作る（ビューに付く INSTEAD OF トリガーがあるため）
      for (const [type, key] of [['index', 'indexes'], ['view', 'views'], ['trigger', 'triggers']]) {
        for (const o of objects.filter((x) => x.type === type)) { out.line(`${o.sql};`); counts[key] += 1; }
      }
    } finally {
      out.close();
    }
    try {
      fkViolations = db.prepare('PRAGMA foreign_key_check').all().map((r) => r.table);
    } catch (e) {
      throw new LoadError(`外部キーを確かめられない: ${redactSqliteMessage(e.message)}`);
    }
  } finally {
    db.close();
    cleanup?.();
  }
  const byTable = {};
  for (const t of fkViolations) byTable[t] = (byTable[t] ?? 0) + 1;
  return { counts, foreignKeyViolations: byTable };
}

// ------------------------------------------------ main

export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        db: { type: 'string' },
        migrations: { type: 'string' },
        applied: { type: 'string' },
        json: { type: 'boolean', default: false },
        in: { type: 'string' },
        out: { type: 'string' },
        'tmp-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (e) {
    stderr(`${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (values.help) { stdout(`${USAGE}\n`); return 0; }
  const [command, ...rest] = positionals;
  if (rest.length || !['schema', 'reorder'].includes(command)) {
    stderr(`schema か reorder のどちらかを1つ指定する\n\n${USAGE}\n`);
    return 2;
  }
  // deps の maxInMemoryBytes・chunkBytes はテスト用（大きな .sql の経路を小さなファイルで通す）
  const openOptions = { tmpDir: values['tmp-dir'], maxInMemoryBytes: deps.maxInMemoryBytes, chunkBytes: deps.chunkBytes };
  for (const k of Object.keys(openOptions)) if (openOptions[k] === undefined) delete openOptions[k];

  try {
    if (command === 'schema') {
      if (!values.db || !values.migrations || values.in || values.out) {
        stderr(`schema には --db と --migrations を指定する（--in・--out は reorder 用）\n\n${USAGE}\n`);
        return 2;
      }
      const applied = values.applied === undefined ? undefined : values.applied.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await compareSchema({ dbPath: values.db, migrationsDir: values.migrations, applied, openOptions });
      stdout(values.json ? `${JSON.stringify(r, null, 2)}\n` : renderSchema(r, values.db));
      return r.match ? 0 : 1;
    }

    if (!values.in || !values.out || values.db || values.migrations || values.applied !== undefined || values.json) {
      stderr(`reorder には --in と --out だけを指定する\n\n${USAGE}\n`);
      return 2;
    }
    if (resolve(values.in) === resolve(values.out)) {
      stderr('--in と --out が同じファイル。書き出しの原本を上書きしない\n');
      return 2;
    }
    const r = await reorderExport({ inPath: values.in, outPath: values.out, openOptions });
    const c = r.counts;
    stdout(`書き出した: ${basename(values.out)}（表 ${c.tables} / 行 ${c.rows} / インデックス ${c.indexes} / ビュー ${c.views} / トリガー ${c.triggers}）\n`);
    const fk = Object.entries(r.foreignKeyViolations);
    if (fk.length) {
      stdout(`外部キーの違反 ${fk.reduce((a, [, n]) => a + n, 0)}件: ${fk.map(([t, n]) => `${t} ${n}件`).join(', ')}\n判定: NG（書き出しの時点で外部キーが崩れている。予行を止めて確かめる）\n`);
      return 1;
    }
    stdout('外部キーの違反: なし\n判定: OK\n');
    return 0;
  } catch (e) {
    if (e instanceof LoadError) { stderr(`${e.message}\n`); return 2; }
    throw e;
  }
}

function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e.stack ?? e}\n`); process.exitCode = 2; });
}
