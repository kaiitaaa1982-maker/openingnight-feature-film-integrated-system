#!/usr/bin/env node
// D1 の中身を数えて照合する（表の一覧・各表の行数・トリガー数・インデックス数・ビュー数）。
//
//   node scripts/ops/d1-reconcile.mjs --left <sqlite|sql> --right <sqlite|sql> [--json]
//   node scripts/ops/d1-reconcile.mjs --db <sqlite|sql> --expect <manifest.json> [--json]
//   node scripts/ops/d1-reconcile.mjs --db <sqlite|sql> [--json]          … 数えて出すだけ（各表の行数も出る）
//   node scripts/ops/d1-reconcile.mjs --db <sqlite|sql> --manifest       … マニフェスト（表・トリガー・インデックス・ビューの数だけ）を出す
//
// 入力は SQLite のファイル（先頭が "SQLite format 3"）か、wrangler d1 export の .sql。
// .sql は 400MiB 以下なら node:sqlite のメモリ DB に1回で流し込む。超えたら文ごとに一時ファイルの SQLite へ流し込み
// （--tmp-dir の下。終わったら消す）、大きさで止まらない。
// 失敗したら、何文目・何行目で止まったかを出す（SQLite のエラー文は値の断片を伏せる）。
// 名前が sqlite_ か _cf_ で始まるもの（SQLite と D1 の内部表、その上のインデックス・トリガー）は数えない。
// 一致なら exit 0、不一致は exit 1、使い方の誤りと読み込みの失敗は exit 2。行の中身は出力しない。

import { closeSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const EXCLUDED_PREFIXES = ['sqlite_', '_cf_'];
// これを超える .sql は1つの文字列にしない（V8 の文字列の上限は約 512MiB）。文ごとに一時ファイルの SQLite へ流す
export const MAX_SQL_BYTES = 400 * 1024 * 1024;
// 文ごとに流すときに一度に読む量
export const SQL_CHUNK_BYTES = 8 * 1024 * 1024;

const USAGE = `使い方:
  node scripts/ops/d1-reconcile.mjs --left <sqlite|sql> --right <sqlite|sql> [--json]
  node scripts/ops/d1-reconcile.mjs --db <sqlite|sql> --expect <manifest.json> [--json]
  node scripts/ops/d1-reconcile.mjs --db <sqlite|sql> [--json]
  node scripts/ops/d1-reconcile.mjs --db <sqlite|sql> --manifest

D1 の表の一覧・各表の行数・トリガー数・インデックス数・ビュー数を数え、2つを比べるか期待値と照合する。

  --left, --right <file>   比べる2つ（SQLite ファイルか wrangler d1 export の .sql）
  --db <file>              数える1つ
  --expect <manifest>      期待値 {"tables":111,"triggers":143,"indexes":N,"views":N,"rowCounts":{"表名":行数}}
                           （tables・triggers・indexes・views・rowCounts はどれも省略できる。書いたものだけ照合する）
  --json                   結果を JSON で出す（--db だけのときは各表の行数とパスも入る。マニフェストには使わない）
  --manifest               --db の数からマニフェスト {"tables","triggers","indexes","views"} を JSON で出す。
                           行数（rowCounts）・パスは入れない（ci-contract.md §2）
  --tmp-dir <dir>          400MiB を超える .sql を流し込む一時ファイルの置き場所（既定は OS の一時フォルダ）。
                           中身は書き出しの平文なので、平文を置いている場所と同じにする。終わったら消す
  -h, --help               この説明

名前が sqlite_ か _cf_ で始まる表と、その上のインデックス・トリガーは数えない。
終了コード: 0 = 一致 / 1 = 不一致 / 2 = 使い方の誤り・読み込みの失敗`;

let DatabaseSyncCtor;
async function loadSqlite() {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch {
    throw new LoadError('node:sqlite が使えない。Node 22.13 以上か Node 24 で実行する（22.5〜22.12 は --experimental-sqlite が要る）');
  }
  return DatabaseSyncCtor;
}

export class LoadError extends Error {}

function isSqliteFile(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return n === 16 && buf.toString('latin1') === 'SQLite format 3\0';
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------ SQL を文に分ける（失敗箇所を探すときだけ使う）
// sqlite3_complete() と同じ考え方。CREATE TRIGGER の中は「; END ;」で1文が終わる。

/**
 * text を文に分ける。終わった文（statements）と、まだ終わっていない残りの位置を返す。
 * 残りは text.slice(restIndex)。restLine はその位置の行番号、restFirstLine は残りの最初の語の行番号（無ければ null）。
 * 残りを次の読み込みの頭に付けて呼び直せば、途中で区切って読んでも同じ文に分かれる。
 * @returns {{statements: {sql:string, line:number}[], restIndex:number, restLine:number, restFirstLine:number|null}}
 */
export function scanSqlStatements(text) {
  const out = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  let lineAtStart = 1;
  let i = 0;
  const n = text.length;
  // トークン列から CREATE [TEMP] TRIGGER かどうかと、; END ; の並びを追う
  let tokens = []; // 文の先頭から数語だけ
  let inTrigger = false;
  let state = 'normal'; // trigger 内: 'body' | 'semi' | 'end'
  let atStatementStart = true;

  const pushWord = (w) => {
    const u = w.toUpperCase();
    if (tokens.length < 4) {
      tokens.push(u);
      if (tokens[0] === 'CREATE' && (tokens[1] === 'TRIGGER' || ((tokens[1] === 'TEMP' || tokens[1] === 'TEMPORARY') && tokens[2] === 'TRIGGER'))) {
        inTrigger = true;
        state = 'body';
      }
    }
    if (inTrigger) {
      if (state === 'semi' && u === 'END') state = 'end';
      else if (state === 'end' || state === 'semi') state = 'body';
    }
  };
  const finish = (endIdx) => {
    const sql = text.slice(start, endIdx);
    if (sql.trim()) out.push({ sql, line: startLine });
    start = endIdx;
    lineAtStart = line;
    tokens = [];
    inTrigger = false;
    state = 'normal';
    atStatementStart = true;
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (atStatementStart) { startLine = line; atStatementStart = false; }
    if (c === '-' && text[i + 1] === '-') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < n) {
        if (text[i] === '\n') line++;
        if (text[i] === close) {
          if (close !== ']' && text[i + 1] === close) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      if (inTrigger && (state === 'semi' || state === 'end')) state = 'body';
      continue;
    }
    if (c === ';') {
      i++;
      if (!inTrigger) { finish(i); continue; }
      if (state === 'end') { finish(i); continue; }
      state = 'semi';
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      pushWord(text.slice(i, j));
      i = j;
      continue;
    }
    if (inTrigger && (state === 'semi' || state === 'end')) state = 'body';
    i++;
  }
  return { statements: out, restIndex: start, restLine: lineAtStart, restFirstLine: atStatementStart ? null : startLine };
}

/** @returns {{sql:string, line:number}[]} 終わっていない最後の文も1文として含める */
export function splitSqlStatements(text) {
  const { statements, restIndex, restFirstLine } = scanSqlStatements(text);
  const rest = text.slice(restIndex);
  return rest.trim() ? [...statements, { sql: rest, line: restFirstLine ?? 1 }] : statements;
}

/** 文の頭（種類と対象の名前）だけを返す。値は含めない */
export function statementHead(sql) {
  const s = sql.replace(/^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*/, '');
  const m = /^(CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:"[^"]*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)|(?:DELETE\s+FROM|UPDATE|DROP\s+\w+(?:\s+IF\s+EXISTS)?)\s+(?:"[^"]*"|[^\s(]+)|\w+)/i.exec(s);
  return (m ? m[1] : s.slice(0, 20)).replace(/\s+/g, ' ');
}

// ------------------------------------------------ 読み込み

export async function openDatabase(path, { maxInMemoryBytes = MAX_SQL_BYTES, chunkBytes = SQL_CHUNK_BYTES, tmpDir } = {}) {
  const DatabaseSync = await loadSqlite();
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new LoadError(`ファイルが見つからない: ${path}`);
  }
  if (!st.isFile()) throw new LoadError(`ファイルでない: ${path}`);

  if (isSqliteFile(path)) {
    try {
      return { db: new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: false }), kind: 'sqlite' };
    } catch (e) {
      throw new LoadError(`SQLite ファイルを開けない: ${path}: ${e.message}`);
    }
  }

  if (st.size > maxInMemoryBytes) return streamSqlIntoFile(DatabaseSync, path, { chunkBytes, tmpDir });
  let text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const options = { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true };
  const db = new DatabaseSync(':memory:', options);
  try {
    db.exec(text);
  } catch (e) {
    db.close();
    throw new LoadError(`SQL の取り込みに失敗: ${path}\n  ${await locateFailure(DatabaseSync, options, text, e)}`);
  }
  return { db, kind: 'sql' };
}

/**
 * 大きな .sql を、文ごとに一時ファイルの SQLite へ流し込む。一度に持つのは読み込みの1回分と、終わっていない1文だけ。
 * 一時ファイルは tmpDir（無ければ OS の一時フォルダ）の下に作り、返す cleanup で消す。失敗したときはここで消す。
 */
async function streamSqlIntoFile(DatabaseSync, path, { chunkBytes, tmpDir }) {
  const dir = mkdtempSync(join(tmpDir ?? tmpdir(), 'd1-reconcile-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const options = { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: true };
  let db;
  let fd;
  try {
    db = new DatabaseSync(join(dir, 'stream.sqlite'), options);
    // 照合のためだけの使い捨ての DB なので、書き込みの安全装置を外して速くする
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
    let count = 0;
    const run = (sql, line) => {
      count += 1;
      try {
        db.exec(sql);
      } catch (e) {
        throw new LoadError(`SQL の取り込みに失敗: ${path}\n  ${count}文目（${line}行目から、${statementHead(sql)}）で止まった: ${redactSqliteMessage(e.message)}`);
      }
    };
    fd = openSync(path, 'r');
    const decoder = new TextDecoder('utf-8');
    const buf = Buffer.alloc(chunkBytes);
    let pending = '';
    let pendingLine = 1;
    let atFileStart = true;
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, null);
      let piece = n > 0 ? decoder.decode(buf.subarray(0, n), { stream: true }) : decoder.decode();
      if (atFileStart && piece.length > 0) {
        if (piece.charCodeAt(0) === 0xfeff) piece = piece.slice(1);
        atFileStart = false;
      }
      pending += piece;
      if (n === 0) break;
      const { statements, restIndex, restLine } = scanSqlStatements(pending);
      for (const st of statements) run(st.sql, pendingLine + st.line - 1);
      pending = pending.slice(restIndex);
      pendingLine += restLine - 1;
    }
    // 最後に残った文（; で終わらない最後の文を含む）
    for (const st of splitSqlStatements(pending)) run(st.sql, pendingLine + st.line - 1);
  } catch (e) {
    db?.close();
    cleanup();
    throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { db, kind: 'sql', streamed: true, cleanup };
}

/**
 * SQLite のエラー文から値の断片を伏せる。`unrecognized token: "…"` と `near "…": syntax error` は、
 * 途中で切れた文字列や値の一部を引用する。値に " が入ることもあるので、最初の " から最後の " まで
 * （閉じていなければ末尾まで）をまとめて伏せる。no such column・no such function の後ろも伏せる。
 * `UNIQUE constraint failed: 表.列` のような表と列の名前だけの文はそのまま残す。
 */
export function redactSqliteMessage(message) {
  const m = String(message).replace(/^(no such (?:column|function)): [\s\S]*/, '$1: …');
  const i = m.indexOf('"');
  if (i < 0) return m;
  const j = m.lastIndexOf('"');
  return j > i ? `${m.slice(0, i)}"…"${m.slice(j + 1)}` : `${m.slice(0, i)}"…`;
}

async function locateFailure(DatabaseSync, options, text, original) {
  const statements = splitSqlStatements(text);
  const probe = new DatabaseSync(':memory:', options);
  try {
    for (let k = 0; k < statements.length; k++) {
      try {
        probe.exec(statements[k].sql);
      } catch (e) {
        return `${k + 1}文目（${statements[k].line}行目から、${statementHead(statements[k].sql)}）で止まった: ${redactSqliteMessage(e.message)}`;
      }
    }
  } finally {
    probe.close();
  }
  return `止まった文を特定できなかった: ${redactSqliteMessage(original.message)}`;
}

// ------------------------------------------------ 数える

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;
const isExcluded = (name) => EXCLUDED_PREFIXES.some((p) => name.toLowerCase().startsWith(p));

export function summarize(db, source, kind) {
  const rows = db.prepare('SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name').all();
  const tables = [];
  const triggers = [];
  const indexes = [];
  const views = [];
  let excluded = 0;
  for (const r of rows) {
    if (isExcluded(r.name) || isExcluded(r.tbl_name ?? '')) { excluded++; continue; }
    if (r.type === 'table') tables.push(r.name);
    else if (r.type === 'trigger') triggers.push(r.name);
    else if (r.type === 'index') indexes.push(r.name);
    else if (r.type === 'view') views.push(r.name);
  }
  const rowCounts = {};
  const unreadable = [];
  for (const t of tables) {
    try {
      rowCounts[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t)}`).get().n);
    } catch (e) {
      rowCounts[t] = null;
      unreadable.push(`${t}: ${e.message}`);
    }
  }
  return {
    source,
    kind,
    tables: tables.length,
    triggers: triggers.length,
    indexes: indexes.length,
    views: views.length,
    rowCounts,
    objects: { tables, triggers, indexes, views },
    excluded: { prefixes: EXCLUDED_PREFIXES, count: excluded },
    ...(unreadable.length ? { unreadable } : {}),
  };
}

export async function inspect(path, options = {}) {
  const { db, kind, streamed, cleanup } = await openDatabase(path, options);
  try {
    const summary = summarize(db, path, kind);
    return streamed ? { ...summary, streamed: true } : summary;
  } finally {
    db.close();
    cleanup?.();
  }
}

// ------------------------------------------------ 比べる

const setDiff = (a, b) => a.filter((x) => !b.includes(x));

export function compareSummaries(left, right) {
  const diffs = [];
  const lt = left.objects.tables;
  const rt = right.objects.tables;
  for (const t of setDiff(lt, rt)) diffs.push({ kind: 'table-missing', table: t, side: 'right', message: `表 ${t} が right に無い` });
  for (const t of setDiff(rt, lt)) diffs.push({ kind: 'table-missing', table: t, side: 'left', message: `表 ${t} が left に無い` });
  for (const t of lt.filter((x) => rt.includes(x))) {
    if (left.rowCounts[t] !== right.rowCounts[t]) {
      diffs.push({ kind: 'row-count', table: t, left: left.rowCounts[t], right: right.rowCounts[t], message: `表 ${t} の行数: left ${left.rowCounts[t]} / right ${right.rowCounts[t]}` });
    }
  }
  for (const key of ['triggers', 'indexes', 'views']) {
    const label = { triggers: 'トリガー', indexes: 'インデックス', views: 'ビュー' }[key];
    const a = left.objects[key];
    const b = right.objects[key];
    const onlyLeft = setDiff(a, b);
    const onlyRight = setDiff(b, a);
    if (left[key] !== right[key] || onlyLeft.length || onlyRight.length) {
      diffs.push({
        kind: `${key}-mismatch`,
        left: left[key],
        right: right[key],
        onlyLeft,
        onlyRight,
        message: `${label}: left ${left[key]} / right ${right[key]}` +
          (onlyLeft.length ? `（left だけ: ${onlyLeft.join(', ')}）` : '') +
          (onlyRight.length ? `（right だけ: ${onlyRight.join(', ')}）` : ''),
      });
    }
  }
  if (left.tables !== right.tables && !diffs.some((d) => d.kind === 'table-missing')) {
    diffs.push({ kind: 'table-count', left: left.tables, right: right.tables, message: `表の数: left ${left.tables} / right ${right.tables}` });
  }
  return diffs;
}

export function validateManifest(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new LoadError('マニフェストが JSON のオブジェクトでない');
  const keys = ['tables', 'triggers', 'indexes', 'views'];
  for (const k of keys) {
    if (m[k] !== undefined && !(Number.isInteger(m[k]) && m[k] >= 0)) throw new LoadError(`マニフェストの ${k} が 0 以上の整数でない`);
  }
  if (m.rowCounts !== undefined) {
    if (!m.rowCounts || typeof m.rowCounts !== 'object' || Array.isArray(m.rowCounts)) throw new LoadError('マニフェストの rowCounts がオブジェクトでない');
    for (const [t, v] of Object.entries(m.rowCounts)) {
      if (!(Number.isInteger(v) && v >= 0)) throw new LoadError(`マニフェストの rowCounts.${t} が 0 以上の整数でない`);
    }
  }
  if (!keys.some((k) => m[k] !== undefined) && m.rowCounts === undefined) {
    throw new LoadError('マニフェストに照合する項目が無い（tables・triggers・indexes・views・rowCounts のどれかを書く）');
  }
}

/** マニフェストに書くのは数だけ。行数は本番の書き出しとの照合（03 の A3）で必ず食い違うので入れない */
export function toManifest(summary) {
  return { tables: summary.tables, triggers: summary.triggers, indexes: summary.indexes, views: summary.views };
}

export function compareManifest(summary, manifest) {
  const diffs = [];
  const labels = { tables: '表', triggers: 'トリガー', indexes: 'インデックス', views: 'ビュー' };
  for (const k of Object.keys(labels)) {
    if (manifest[k] !== undefined && manifest[k] !== summary[k]) {
      diffs.push({ kind: `${k}-count`, expected: manifest[k], actual: summary[k], message: `${labels[k]}の数: 期待 ${manifest[k]} / 実際 ${summary[k]}` });
    }
  }
  for (const [t, expected] of Object.entries(manifest.rowCounts ?? {})) {
    if (!(t in summary.rowCounts)) diffs.push({ kind: 'table-missing', table: t, message: `表 ${t} が無い（期待 ${expected} 行）` });
    else if (summary.rowCounts[t] !== expected) diffs.push({ kind: 'row-count', table: t, expected, actual: summary.rowCounts[t], message: `表 ${t} の行数: 期待 ${expected} / 実際 ${summary.rowCounts[t]}` });
  }
  return diffs;
}

// ------------------------------------------------ 出力

function describe(s) {
  return `${s.source}（${s.kind === 'sql' ? (s.streamed ? 'SQL・大きいので一時ファイル経由' : 'SQL') : 'SQLite'}）: 表 ${s.tables} / トリガー ${s.triggers} / インデックス ${s.indexes} / ビュー ${s.views} / 行 合計 ${Object.values(s.rowCounts).reduce((a, b) => a + (b ?? 0), 0)}` +
    (s.excluded.count ? `（内部オブジェクト ${s.excluded.count} 件は除外）` : '');
}

export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        left: { type: 'string' },
        right: { type: 'string' },
        db: { type: 'string' },
        expect: { type: 'string' },
        json: { type: 'boolean', default: false },
        manifest: { type: 'boolean', default: false },
        'tmp-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    stderr(`${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (values.help) { stdout(`${USAGE}\n`); return 0; }

  const pair = values.left !== undefined || values.right !== undefined;
  const single = values.db !== undefined;
  if (pair === single || (pair && (!values.left || !values.right)) || (values.expect !== undefined && !single)) {
    stderr(`--left と --right の組か、--db（と --expect）のどちらか一方を指定する\n\n${USAGE}\n`);
    return 2;
  }
  if (values.manifest && (!single || values.expect !== undefined)) {
    stderr(`--manifest は --db と一緒に使う（--expect とは併用しない）\n\n${USAGE}\n`);
    return 2;
  }

  // deps の maxInMemoryBytes・chunkBytes はテスト用（大きな .sql の経路を小さなファイルで通す）
  const openOptions = { tmpDir: values['tmp-dir'], maxInMemoryBytes: deps.maxInMemoryBytes, chunkBytes: deps.chunkBytes };
  for (const k of Object.keys(openOptions)) if (openOptions[k] === undefined) delete openOptions[k];
  try {
    if (pair) {
      const left = await inspect(values.left, openOptions);
      const right = await inspect(values.right, openOptions);
      const diffs = compareSummaries(left, right);
      if (values.json) {
        stdout(JSON.stringify({ match: diffs.length === 0, left, right, differences: diffs }, null, 2) + '\n');
      } else {
        stdout(`left  ${describe(left)}\nright ${describe(right)}\n`);
        if (diffs.length) stdout(`不一致 ${diffs.length}件:\n${diffs.map((d) => `  ${d.message}`).join('\n')}\n判定: NG\n`);
        else stdout('判定: 一致\n');
        if (left.unreadable || right.unreadable) stdout(`数えられなかった表: ${[...(left.unreadable ?? []), ...(right.unreadable ?? [])].join(' / ')}\n`);
      }
      return diffs.length ? 1 : 0;
    }

    const summary = await inspect(values.db, openOptions);
    if (values.manifest) {
      stdout(JSON.stringify(toManifest(summary), null, 2) + '\n');
      if (summary.unreadable) stderr(`数えられなかった表: ${summary.unreadable.join(' / ')}\n`);
      return 0;
    }
    if (values.expect === undefined) {
      if (values.json) stdout(JSON.stringify(summary, null, 2) + '\n');
      else stdout(`${describe(summary)}\n${summary.objects.tables.map((t) => `  ${t}\t${summary.rowCounts[t] ?? '（数えられない）'}`).join('\n')}\n`);
      return 0;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(values.expect, 'utf8'));
    } catch (e) {
      throw new LoadError(`マニフェストを読めない: ${values.expect}: ${e.code ?? e.message}`);
    }
    validateManifest(manifest);
    const diffs = compareManifest(summary, manifest);
    if (values.json) {
      stdout(JSON.stringify({ match: diffs.length === 0, db: summary, expect: manifest, differences: diffs }, null, 2) + '\n');
    } else {
      stdout(`${describe(summary)}\n期待値 ${values.expect}: ${['tables', 'triggers', 'indexes', 'views'].filter((k) => manifest[k] !== undefined).map((k) => `${k}=${manifest[k]}`).join(' ')}` +
        (manifest.rowCounts ? ` rowCounts=${Object.keys(manifest.rowCounts).length}表` : '') + '\n');
      if (diffs.length) stdout(`不一致 ${diffs.length}件:\n${diffs.map((d) => `  ${d.message}`).join('\n')}\n判定: NG\n`);
      else stdout('判定: 一致\n');
    }
    return diffs.length ? 1 : 0;
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
