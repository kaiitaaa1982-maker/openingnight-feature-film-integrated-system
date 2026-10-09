// 試験の二重化（香盤表 #11）の一覧 test/pg-matrix.json を読む道具と、試験のファイルが DB をどう開くかの見分け方。
// test/test-rules.test.mjs（規則）と scripts/test-pg.mjs（npm run test:pg）が使う。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchParen, scanJs } from './js-scan.mjs';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const MATRIX_PATH = join(TEST_DIR, 'pg-matrix.json');
export const FACTORY = 'test-db.mjs';

// PostgreSQL で落ちる原因の札（pending の cause）。札ごとに直し、直した札は消す。
// 2026-10-03（香盤表 #11 の PR3・PR4）に直して消した札: json_extract・insert-or・timestamp（PR3）、sqlite-catalog・is-param・upsert-ambiguous・
// cast-int・trigger-alias・error-text（PR4。記録 docs/platform/operations/records/2026-10-03-pg-src-dialect2.md）。
// 残す札のうち null-order・group-by・like・numeric は、自前の DB の本（own-db）をファクトリへ移したときに出たら付ける
export const PENDING_CAUSES = Object.freeze({
  'own-db': '自前で LocalDatabase・DatabaseSync を作り、ファクトリを通っていない（PR5〜7 で付け替える）',
  'sync-api': '同期の API（db.raw・prepare・exec・同期の assert.throws）を直接使う（PR5〜7 で入口の形に直す）',
  'null-order': 'ORDER BY の NULL の並び（SQLite は昇順で先、PostgreSQL は後）',
  'group-by': 'GROUP BY に無い列を SELECT に書いている',
  like: 'LIKE の大文字・小文字',
  numeric: '型なしの列（numeric）の値が Decimal の文字列で返る（sale_attribute_values.value_number は読んだ所で Number にそろえた）',
  other: '上のどれでもない（理由を note に書く）',
});

export const readMatrix = (path = MATRIX_PATH) => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
export const testFiles = (dir = TEST_DIR) => readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort();

// DB を作る new（new LocalDatabase(・new DatabaseSync(・名前空間の new dbm.LocalDatabase(）
const OWN_DB = /\bnew\s+(?:[\w$]+\s*\.\s*)?(LocalDatabase|DatabaseSync)\s*\(/;
// 静的な import・export … from '…'
const STATIC_IMPORT = /(?:^|[;\n])\s*(?:import|export)\b([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]/g;
// 動的な import。const {a, b: c} = await import('…') は名前つき、それ以外は全体（名前空間）とみなす
const DYNAMIC_NAMED = /\{([^{}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_ANY = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
// DB の型の定義（中は見ない。src/db.mjs は LocalDatabase の定義そのもの）
const DB_MODULE = '../src/db.mjs';
const SQLITE = 'node:sqlite';
const DB_CLASSES = new Set(['LocalDatabase', 'DatabaseSync']);
const escapeRe = (text) => text.replace(/[$]/g, '\\$');

// test/ から見た相対の道（posix）。アプリ（test・src・scripts）の外と、.mjs・.js 以外は null。test/ の中は名前だけ
function resolveDep(from, spec) {
  if (spec === SQLITE) return SQLITE;
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const path = posix.normalize(posix.join(posix.dirname(from), spec));
  if (path.startsWith('../../') || !/\.(mjs|js)$/.test(path)) return null;
  return path.startsWith('../test/') ? path.slice('../test/'.length) : path;
}
const inTestDir = (name) => !name.startsWith('../');

// import の束縛。names は {imported, local}（default は imported 'default'）、whole は名前空間・副作用だけ・export * など全体を読むもの
function parseClause(clause, { destructure = false } = {}) {
  const names = [];
  let whole = false;
  const braces = clause.match(/\{([^}]*)\}/);
  for (const part of braces ? braces[1].split(',') : []) {
    const text = part.trim();
    if (!text) continue;
    const [imported, local = imported] = text.split(destructure ? /\s*:\s*/ : /\s+as\s+/).map((v) => v.trim());
    names.push({ imported, local });
  }
  const rest = clause.replace(/\{[^}]*\}/, '').replace(/^\s*(?:import|export)\b/, '');
  if (/\*/.test(rest)) whole = true;
  const namespace = rest.match(/\*\s*as\s+([\w$]+)/)?.[1] ?? null;
  const def = rest.match(/^\s*([\w$]+)\s*(?:,|$)/);
  if (def) names.push({ imported: 'default', local: def[1] });
  return { names, whole, namespace };
}

// 最上位の関数（function f(…){…}・const f = (…) => …）の名前と範囲
function topFunctions(masked) {
  const fns = new Map();
  const declare = /(?:^|[;\n}])\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/g;
  for (const m of masked.matchAll(declare)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    const body = close < 0 ? -1 : masked.indexOf('{', close);
    const end = body < 0 ? masked.length : matchBrace(masked, body);
    fns.set(m[1], masked.slice(m.index, end + 1));
  }
  const arrow = /(?:^|[;\n}])\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?=[(\w$])/g;
  for (const m of masked.matchAll(arrow)) {
    let k = m.index + m[0].length;
    if (masked[k] === '(') k = matchParen(masked, k) + 1;
    else while (/[\w$]/.test(masked[k] ?? '')) k++;
    const after = masked.slice(k).match(/^\s*=>\s*/);
    if (!after || k <= 0) continue;
    k += after[0].length;
    const end = masked[k] === '{' ? matchBrace(masked, k) : endOfExpression(masked, k);
    fns.set(m[1], masked.slice(m.index, end + 1));
  }
  return fns;
}
function matchBrace(masked, open) {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === '{') depth++;
    else if (masked[k] === '}' && --depth === 0) return k;
  }
  return masked.length - 1;
}
function endOfExpression(masked, from) {
  let depth = 0;
  for (let k = from; k < masked.length; k++) {
    const c = masked[k];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (--depth < 0) return k - 1; }
    else if ((c === ';' || c === '\n') && depth === 0) return k - 1;
  }
  return masked.length - 1;
}

// 1つのファイルを読む（cache は seen と同じ Map に '#mod:' つきで置く）
function parseModule(name, ctx) {
  const key = `#mod:${name}`;
  if (ctx.seen.has(key)) return ctx.seen.get(key);
  const src = ctx.read(name);
  const { masked, code } = scanJs(src);
  const imports = [];
  for (const m of code.matchAll(STATIC_IMPORT)) imports.push({ dep: resolveDep(name, m[2]), ...parseClause(m[1]) });
  const dynamicNamed = new Set();
  for (const m of code.matchAll(DYNAMIC_NAMED)) { imports.push({ dep: resolveDep(name, m[2]), ...parseClause(`{${m[1]}}`, { destructure: true }) }); dynamicNamed.add(m.index + m[0].indexOf('import(')); }
  for (const m of code.matchAll(DYNAMIC_ANY)) if (!dynamicNamed.has(m.index)) imports.push({ dep: resolveDep(name, m[1]), names: [], whole: true });
  // DB の型の手元の名前（別名を含む）と、DB の型を持つ名前空間
  const dbLocals = new Set(DB_CLASSES);
  const dbNamespaces = new Set();
  for (const imp of imports) {
    if (imp.dep !== DB_MODULE && imp.dep !== SQLITE) continue;
    for (const { imported, local } of imp.names) if (DB_CLASSES.has(imported)) dbLocals.add(local);
    if (imp.namespace) dbNamespaces.add(imp.namespace);
  }
  const creates = (text) => OWN_DB.test(text)
    || [...dbLocals].some((local) => new RegExp(`\\bnew\\s+${escapeRe(local)}\\s*\\(`).test(text))
    || [...dbNamespaces].some((ns) => new RegExp(`\\b${escapeRe(ns)}\\s*\\.\\s*(LocalDatabase|DatabaseSync)\\b`).test(text));
  const mod = { name, masked, imports, creates, fns: topFunctions(masked) };
  ctx.seen.set(key, mod);
  return mod;
}

// src/・scripts/ の道具の、名前を指した関数（とそれが呼ぶ関数）が DB を作るか。export 全体を読むときは、どれか1つでも作れば作る
function exportCreates(dep, exported, ctx, stack = new Set()) {
  const mod = parseModule(dep, ctx);
  if (exported === '*') return [...mod.fns.keys()].some((fn) => fnCreates(mod, fn, ctx, stack));
  if (mod.fns.has(exported)) return fnCreates(mod, exported, ctx, stack);
  // 読み直して出しているもの（export {a} from './b.mjs'・import {a} … export {a}）
  for (const imp of mod.imports) {
    if (!imp.dep || imp.dep === DB_MODULE || imp.dep === SQLITE) continue;
    const hit = imp.names.find((n) => n.local === exported);
    if (hit) return linkCreates(imp.dep, hit.imported, ctx, stack);
  }
  return false;
}
function linkCreates(dep, imported, ctx, stack) {
  if (dep === FACTORY || dep === DB_MODULE || dep === SQLITE) return false;
  if (inTestDir(dep)) return dbUsage(dep, ctx).own;
  return exportCreates(dep, imported === 'default' ? 'default' : imported, ctx, stack);
}
function fnCreates(mod, fn, ctx, stack) {
  const key = `${mod.name}#${fn}`;
  if (stack.has(key)) return false;
  stack.add(key);
  const text = mod.fns.get(fn);
  if (mod.creates(text)) return true;
  for (const call of text.matchAll(/\b([\w$]+)\s*\(/g)) {
    const callee = call[1];
    if (callee === fn) continue;
    if (mod.fns.has(callee) && fnCreates(mod, callee, ctx, stack)) return true;
    for (const imp of mod.imports) {
      if (!imp.dep) continue;
      const hit = imp.names.find((n) => n.local === callee);
      if (hit && linkCreates(imp.dep, hit.imported, ctx, stack)) return true;
    }
  }
  return false;
}

// 試験の本（と、それが読み込む test/ の中の道具。ファクトリは除く）が自前で DB を作るか・ファクトリを通るか。
// 自前で作るとみなすもの:
// - 本の中の new LocalDatabase(・new DatabaseSync(（別名で読み込んだ型の new と、名前空間の new dbm.LocalDatabase( を含む）
// - src/db.mjs の LocalDatabase・node:sqlite の DatabaseSync を読み込むこと（使い道を問わない）
// - src/・scripts/ の道具のうち、読み込んだ関数（とそれが呼ぶ関数）が DB を作るもの（例: scripts/build-db-docs.mjs の plan → openSchema）
export function dbUsage(name, { dir = TEST_DIR, read = (file) => readFileSync(join(dir, file), 'utf8'), seen = new Map() } = {}) {
  if (seen.has(name)) return seen.get(name);
  const result = { own: false, factory: false, via: [] };
  seen.set(name, result);
  const ctx = { dir, read, seen };
  const mod = parseModule(name, ctx);
  const add = (via) => { result.own = true; for (const v of via) if (!result.via.includes(v)) result.via.push(v); };
  if (mod.creates(mod.masked)) add([name]);
  for (const imp of mod.imports) {
    if (!imp.dep) continue;
    if (imp.dep === DB_MODULE || imp.dep === SQLITE) {
      if (imp.whole ? mod.creates(mod.masked) : imp.names.some((n) => DB_CLASSES.has(n.imported))) add([name]);
      continue;
    }
    if (imp.dep === FACTORY) { result.factory = true; continue; }
    if (inTestDir(imp.dep)) {
      let sub;
      try { sub = dbUsage(imp.dep, ctx); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (sub.own) add(sub.via);
      if (sub.factory) result.factory = true;
      continue;
    }
    try {
      const wanted = imp.whole ? ['*'] : imp.names.map((n) => n.imported);
      for (const exported of wanted) if (exportCreates(imp.dep, exported, ctx)) add([`${imp.dep}${exported === '*' ? '' : `#${exported}`}`]);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

// 規則の違反の一覧（空なら守っている）
export function matrixViolations(matrix, files, usage) {
  const problems = [];
  const pending = new Map((matrix.pending || []).map((p) => [p.file, p]));
  const sqliteOnly = new Map((matrix.sqliteOnly || []).map((p) => [p.file, p]));
  const known = new Set(files);
  for (const [list, entries] of [['pending', matrix.pending || []], ['sqliteOnly', matrix.sqliteOnly || []]]) {
    const names = entries.map((e) => e.file);
    for (const name of names.filter((n, i) => names.indexOf(n) !== i)) problems.push(`${list} に ${name} が2回ある`);
    for (const name of names) if (!known.has(name)) problems.push(`${list} の ${name} は test/ に無い`);
  }
  for (const name of pending.keys()) if (sqliteOnly.has(name)) problems.push(`${name} が pending と sqliteOnly の両方にある`);
  for (const entry of matrix.pending || []) {
    if (!Array.isArray(entry.causes) || !entry.causes.length) problems.push(`pending の ${entry.file} に原因の札が無い`);
    else for (const cause of entry.causes) if (!(cause in PENDING_CAUSES)) problems.push(`pending の ${entry.file} の札 ${cause} は PENDING_CAUSES に無い`);
    if (entry.causes?.includes('other') && !entry.note) problems.push(`pending の ${entry.file} は札 other なので note に理由を書く`);
  }
  for (const entry of matrix.sqliteOnly || []) if (!entry.reason) problems.push(`sqliteOnly の ${entry.file} に理由が無い`);
  for (const name of files) {
    if (usage(name).own && !pending.has(name) && !sqliteOnly.has(name)) {
      problems.push(`${name} は自前で DB を作る（${usage(name).via.join('・')}）。ファクトリ（test/test-db.mjs の openTestDb）を使うか、test/pg-matrix.json の pending か sqliteOnly に載せる`);
    }
  }
  return problems;
}

// ファクトリで DB を開く呼び出しのうち、試験の t を渡していないもの（[{name, call, line}]）。
// t を渡すと、試験の終わりに t.after で閉じるのを待つ。渡さないと、閉じるのが次の試験と重なり、閉じ忘れはファイルの終わりまで残る
// （PGlite の DB は1つ約75MB）。見るのは openTestDb() と、ファクトリを通る test/ の道具（fixture など）のうち引数に t を取る関数の
// 引数なしの呼び出し、それらへ {t} を渡す手元の包み（setup など）の引数なしの呼び出し
export function factoryCallsWithoutT(name, { dir = TEST_DIR, read = (file) => readFileSync(join(dir, file), 'utf8'), seen = new Map() } = {}) {
  const ctx = { dir, read, seen };
  const mod = parseModule(name, ctx);
  const names = new Set(['openTestDb']);
  for (const imp of mod.imports) {
    if (!imp.dep || !inTestDir(imp.dep) || imp.dep === FACTORY || imp.dep.endsWith('.test.mjs')) continue;
    let helper;
    try { if (!dbUsage(imp.dep, ctx).factory) continue; helper = parseModule(imp.dep, ctx); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const { imported, local } of imp.names) {
      const span = helper.fns.get(imported);
      const params = span?.slice(span.indexOf('('), matchParen(span, span.indexOf('(')) + 1) ?? '';
      if (/\bt\b/.test(params)) names.add(local);
    }
  }
  // 手元の包み: 本の中の関数で、上の名前へ t を渡すもの
  for (let grew = true; grew;) {
    grew = false;
    for (const [fn, span] of mod.fns) {
      if (names.has(fn)) continue;
      if ([...names].some((n) => new RegExp(`\\b${escapeRe(n)}\\s*\\(\\s*\\{[^)]*\\bt\\b`).test(span))) { names.add(fn); grew = true; }
    }
  }
  const found = [];
  for (const n of names) {
    for (const m of mod.masked.matchAll(new RegExp(`\\b${escapeRe(n)}\\s*\\(\\s*\\)`, 'g'))) {
      if (/function\s*$/.test(mod.masked.slice(Math.max(0, m.index - 20), m.index))) continue;
      found.push({ name, call: n, line: mod.masked.slice(0, m.index).split('\n').length });
    }
  }
  return found;
}

// npm run test:pg が流すファイル（pending と sqliteOnly を除いた全試験）
export function pgTestFiles(matrix = readMatrix(), files = testFiles()) {
  const skip = new Set([...(matrix.pending || []), ...(matrix.sqliteOnly || [])].map((e) => e.file));
  return files.filter((name) => !skip.has(name));
}
