#!/usr/bin/env node
// migrations/*.sql（SQLite・D1 の移行。表の定義の正本）から、PostgreSQL の DDL（pg/schema.sql）を生成する。
// 正本は migrations/ のまま（FR-CORE-DATA-017）。pg/schema.sql は生成物なので手で直さない。
//
//   node scripts/pg-ddl.mjs           生成して pg/schema.sql に書く
//   node scripts/pg-ddl.mjs --check   生成したものと pg/schema.sql・pg/local-seed.sql・pg/reconcile.sql が一致するかだけを見る（違えば 1 で終わる）
//
// pg/local-seed.sql は、手元の SQLite（src/db.mjs の LocalDatabase）が表の定義のあとに入れる試作・初期の行（src/*.sql の INSERT）を
// PostgreSQL でも同じに入れる文（試験の DB の土台。test/test-db.mjs が pg/schema.sql のあとに当てる）。本番の D1 には当てない。
// SQLite の INSERT OR IGNORE は ON CONFLICT DO NOTHING にし（どの INSERT にも付ける。移行がすでに入れた行と重ならないように）、
// 最後に IDENTITY の次の値を進める（setval）。行が SQLite と一致することは test/pg-local-seed.test.mjs が確かめる
//
// pg/schema.sql の最後には、PostgreSQL だけの「版の印」の表（src/data-platform/pg-fingerprint.mjs の PG_FINGERPRINT_TABLE）を作って1行入れる
// （香盤表 #27・段2の準備 論点9）。元の移行とアプリの DDL の指紋、生成器の版（GENERATOR_VERSION）、印より前の DDL の指紋、期待する数を持ち、
// 手で書いた pg/verify-catalog.sql がこの行と実際のカタログを並べる。代表が staging・本番に当てたあとに流し、どの版が当たったかを数と指紋で確かめる。
// pg/reconcile.sql は表ごとの件数と金額の列の合計を出す1つの SELECT（SQLite・D1 と PostgreSQL の両方で流れる書き方。値の行は出さない）で、
// 切り替えの照合（FR-CORE-DATA-045）に使う。金額の列は、整数の列のうち名前が RECONCILE_MONEY_COLUMN に当たるもの
//
// 変換の決まり（会社ルートの plans/2026-10-01-postgres-migration.md の段1。記録は
// docs/platform/operations/records/2026-10-03-pg-ddl-feasibility.md）:
// - 表は FK を外して作り、FK は最後に ALTER TABLE で足す（SQLite は後で作る表を先に参照できる）
// - INTEGER PRIMARY KEY は IDENTITY（BY DEFAULT）。初期データのあとに setval で次の ID を進める
// - 型は INTEGER → bigint、TEXT → text COLLATE "C"（SQLite の BINARY と同じ並び）、REAL → double precision、型なし → numeric
// - TEXT の DEFAULT CURRENT_TIMESTAMP は、SQLite と同じ 'YYYY-MM-DD HH:MM:SS'（UTC）の文字列を作る式にする（FR-CORE-DATA-023）
// - GLOB は dialect.md の「形の CHECK」（length・substr・ltrim）にする。date()・typeof・CAST・json_* は、SQLite と同じ結果を返す
//   補助関数（lite_*。この DDL の先頭で作る）にする。日付・年月・JSON の列は TEXT のまま持つ（保存した文字列とアプリの比べ方を変えない）
// - 更新・削除などを無条件に拒むだけのトリガーは、共通の関数 lite_reject_change 1つと表ごとのトリガーにする
// - そのほかのトリガー（WHEN・CASE・RAISE・INSERT を持つもの）は、トリガーごとの PL/pgSQL の関数にする
//   （WHEN は関数の先頭の IF に移す。PostgreSQL のトリガーの WHEN は副問い合わせを書けないため）
// - round() は numeric に直して丸める（PostgreSQL の round(double precision) は偶数へ丸め、SQLite と向きが違う）
// - 変換できない形は、黙って落とさずに止めて一覧に出す（終了コード 1）。SQLite と PostgreSQL で黙って意味が変わる形
//   （LIKE・REGEXP・MATCH、%、0 でない定数以外で割る /、開始位置が正の整数の定数でない substr・負の長さ、桁数つきの round）も止める

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTEGER_TYPES, LITE_CAST_INT, TIMESTAMP_TEXT, isComparison, liteCall } from '../src/data-platform/lite-sql.mjs';
import { PG_FINGERPRINT_TABLE } from '../src/data-platform/pg-fingerprint.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = resolve(app, 'migrations');
export const OUTPUT_PATH = resolve(app, 'pg/schema.sql');
export const SEED_PATH = resolve(app, 'pg/local-seed.sql');
export const RECONCILE_PATH = resolve(app, 'pg/reconcile.sql');
export const VERIFY_CATALOG_PATH = resolve(app, 'pg/verify-catalog.sql');
// 生成器の版。変換の決まりを変えて pg/schema.sql の DDL が変わるときに上げる（版の印の表に入る。印より前の DDL の指紋 ddl_sha256 は、
// 上げ忘れても生成物が変われば変わる）
export const GENERATOR_VERSION = 'pg-ddl 1';
// 照合（pg/reconcile.sql）で合計を出す金額の列。整数の列で、名前の終わりが金額のもの（率・倍の bps・rate・_x は合計しても意味が無いので除く。
// 金額の列の決まりは docs/rules/money.md、test/money-rules.test.mjs の MONEY_COLUMN）
export const RECONCILE_MONEY_COLUMN = /(?:^|_)(?:yen|amount|tax|price|fee|total|cost|budget)$/;
// 分析の2表は 0011_cloud_analytics.sql に移した。表の定義の正本は migrations/（香盤表 #28）。
export const APP_DDL_SOURCES = Object.freeze([]);
// LocalDatabase（src/db.mjs）が表の定義を流す順（行の INSERT はこの順で当てる。FK の参照先の行を先に入れるため）
export const LOCAL_SEED_SOURCES = Object.freeze([
  'schema.sql', 'production.sql', 'reporting.sql', 'workflow.sql', 'distribution-master.sql', 'catalog.sql', 'tax.sql', 'workbench.sql',
  'channel-sales.sql', 'source-controls.sql', 'broadcast.sql', 'report-dimensions.sql', 'rights-payments.sql', 'committee-finance.sql',
  'committee-joint.sql', 'ux-extensions.sql', 'report-issuance.sql', 'progress/expected-reports.sql',
  'royalty/royalty.sql', 'committee/committee-extras.sql', 'sales-source.sql', 'session-org.sql',
  'sales-ops/release-windows.sql', 'sales-ops/partner-lists.sql', 'sales-sheet/sales-sheet.sql', 'sales-ops/distribution-additions.sql',
  'sales-ops/proposal-profiles.sql', 'broadcast/broadcast-windows.sql', 'pl-bs/pl-bs.sql', 'broadcast/proposal-drafts.sql',
  'master-extensions/work-master.sql', 'master-extensions/product-master.sql',
  'expense-accounting/expense-accounting.sql', 'expense-sheet/expense-sheet.sql', 'expense-sheet/expense-import.sql', 'mg.sql',
]);

// SQLite のまま意味を変えずに書き換えてから変換する箇所（手直し）。元の文が変わったら照合で止まる。
// find は、そのトリガーの元の SQL にちょうど1回だけ現れること。
export const SOURCE_PATCHES = [
  {
    trigger: 'royalty_statement_calculation_parts_valid',
    why: 'json_extract は SQLite では整数を返すが、PostgreSQL の補助関数は text を返す。COALESCE(…, 0) で型が合わないので、SQLite でも同じ値になる CAST を明示する',
    find: "(SELECT json_extract(calculation_json, '$.calculationParts') FROM royalty_statements",
    replace: "(SELECT CAST(json_extract(calculation_json, '$.calculationParts') AS INTEGER) FROM royalty_statements",
  },
];

// ---------- 字句 ----------

class ConvertError extends Error {}

// 改行を LF にそろえる（Windows の作業場で CRLF になっていても、生成物と指紋を変えない）
export const lf = (text) => text.replace(/\r\n/g, '\n');

export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '-' && src[i + 1] === '-') { const j = src.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); if (j < 0) throw new ConvertError('閉じていないコメント'); i = j + 2; continue; }
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new ConvertError('閉じていない文字列');
        if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } break; }
        j += 1;
      }
      out.push({ t: 'str', v: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === '"' || c === '`') {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new ConvertError('閉じていない識別子');
      out.push({ t: 'id', v: src.slice(i + 1, j), q: true });
      i = j + 1;
      continue;
    }
    if (c === '[') throw new ConvertError('角括弧の識別子は変換しない');
    if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(src[j])) j += 1;
      out.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '?' || c === ':' || c === '@' || c === '$') throw new ConvertError(`移行に置き場所の記号 ${c} がある`);
    const two = src.slice(i, i + 2);
    if (['||', '<>', '!=', '<=', '>=', '==', '<<', '>>'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('(),;.=<>+-*/%&|~'.includes(c)) { out.push({ t: 'op', v: c }); i += 1; continue; }
    throw new ConvertError(`読めない文字 ${JSON.stringify(c)}`);
  }
  return out;
}

export const up = (tok) => (tok && tok.t === 'id' && !tok.q ? tok.v.toUpperCase() : null);
export const isOp = (tok, v) => tok && tok.t === 'op' && tok.v === v;
const raw = (v) => ({ t: 'raw', v });

// 括弧を入れ子の grp にする
export function tree(tokens) {
  const root = [];
  const stack = [root];
  for (const tok of tokens) {
    if (isOp(tok, '(')) { const g = { t: 'grp', items: [] }; stack.at(-1).push(g); stack.push(g.items); continue; }
    if (isOp(tok, ')')) { if (stack.length === 1) throw new ConvertError('閉じ括弧が多い'); stack.pop(); continue; }
    stack.at(-1).push(tok);
  }
  if (stack.length !== 1) throw new ConvertError('括弧が閉じていない');
  return root;
}

export function splitTop(nodes, sep = ',') {
  const parts = [[]];
  for (const node of nodes) {
    if (isOp(node, sep)) parts.push([]);
    else parts.at(-1).push(node);
  }
  return parts;
}

const KEYWORD_BEFORE_PAREN = new Set(['AND', 'OR', 'NOT', 'IN', 'EXISTS', 'WHEN', 'THEN', 'ELSE', 'AS', 'ON', 'WHERE', 'SELECT', 'FROM', 'BETWEEN', 'IS', 'CASE', 'VALUES', 'JOIN', 'BY', 'USING', 'SET', 'RETURN', 'IF']);
function render(nodes) {
  let s = '';
  let prev = null;
  for (const node of nodes) {
    let txt;
    if (node.t === 'grp') txt = `(${render(node.items)})`;
    else if (node.t === 'id' && node.q) txt = `"${node.v}"`;
    else txt = node.v;
    if (prev) {
      const noSpace = isOp(prev, '.') || isOp(node, '.') || isOp(node, ',') || isOp(node, ';')
        || (node.t === 'grp' && prev.t === 'id' && !KEYWORD_BEFORE_PAREN.has(up(prev)));
      if (!noSpace) s += ' ';
    }
    s += txt;
    prev = node;
  }
  return s;
}

const quoteLiteral = (text) => `'${text.replaceAll("'", "''")}'`;
const unquote = (str) => str.slice(1, -1).replaceAll("''", "'");

// PostgreSQL の予約語と重なる名前は引用符で囲む（いまの移行には無いが、黙って壊さない）
const PG_RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create', 'current_catalog', 'current_date', 'current_role', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'initially', 'intersect', 'into', 'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'placing', 'primary', 'references', 'returning', 'select', 'session_user', 'some', 'symmetric', 'system_user', 'table', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'when', 'where', 'window', 'with']);
const ident = (name) => {
  if (/[A-Z]/.test(name)) throw new ConvertError(`大文字を含む名前は変換しない（SQLite は大小を区別せず、PostgreSQL は引用符で区別する）: ${name}`);
  if (Buffer.byteLength(name) > 63) throw new ConvertError(`名前が 63 バイトを超える（PostgreSQL は黙って切る）: ${name}`);
  return /^[a-z_][a-z0-9_]*$/.test(name) && !PG_RESERVED.has(name) ? name : `"${name.replaceAll('"', '""')}"`;
};
// 索引の名前は 63 バイトに収める。長い名前は先頭 54 字＋元の名前の指紋 8 字にする（切って重ならないように）
const indexName = (name) => (Buffer.byteLength(name) <= 63 ? name : `${name.slice(0, 54)}_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`);

// ---------- 型 ----------

export function pgType(declared) {
  const d = (declared ?? '').toUpperCase().trim();
  if (d === '') return 'numeric';
  if (d.includes('INT')) return 'bigint';
  if (d.includes('CHAR') || d.includes('CLOB') || d.includes('TEXT')) return 'text';
  if (d.includes('BLOB')) return 'bytea';
  if (d.includes('REAL') || d.includes('FLOA') || d.includes('DOUB')) return 'double precision';
  throw new ConvertError(`変換しない列の型 ${declared}`);
}

// CURRENT_TIMESTAMP の式（TIMESTAMP_TEXT）・json_* の補助の関数・CAST(… AS INTEGER) の対応は、入口（src/data-platform/pg-db.mjs）と同じ
// src/data-platform/lite-sql.mjs の表から読む

// ---------- GLOB → 形の CHECK ----------

function globAtoms(pattern) {
  const atoms = [];
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i];
    if (c === '*') { atoms.push({ k: 'star' }); i += 1; continue; }
    if (c === '?') { atoms.push({ k: 'any' }); i += 1; continue; }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (pattern[j] === '^') { neg = true; j += 1; }
      const start = j;
      if (pattern[j] === ']') j += 1;
      while (j < pattern.length && pattern[j] !== ']') j += 1;
      if (j >= pattern.length) throw new ConvertError(`GLOB の [ が閉じていない: ${pattern}`);
      const body = pattern.slice(start, j);
      let set = '';
      for (let p = 0; p < body.length; p += 1) {
        if (body[p + 1] === '-' && p + 2 < body.length) {
          const a = body.codePointAt(p);
          const b = body.codePointAt(p + 2);
          if (b < a) throw new ConvertError(`GLOB の範囲が逆: ${pattern}`);
          for (let cp = a; cp <= b; cp += 1) set += String.fromCodePoint(cp);
          p += 2;
        } else set += body[p];
      }
      atoms.push({ k: 'class', set, neg });
      i = j + 1;
      continue;
    }
    atoms.push({ k: 'lit', v: c });
    i += 1;
  }
  return atoms;
}

export function globToCheck(lhs, pattern) {
  const atoms = globAtoms(pattern);
  const stars = atoms.filter((a) => a.k === 'star').length;
  if (stars === 0) {
    const parts = [`length(${lhs}) = ${atoms.length}`];
    for (let i = 0; i < atoms.length;) {
      const a = atoms[i];
      if (a.k === 'any') { i += 1; continue; }
      let j = i + 1;
      if (a.k === 'lit') {
        while (j < atoms.length && atoms[j].k === 'lit') j += 1;
        parts.push(`substr(${lhs}, ${i + 1}, ${j - i}) = ${quoteLiteral(atoms.slice(i, j).map((x) => x.v).join(''))}`);
      } else if (!a.neg) {
        while (j < atoms.length && atoms[j].k === 'class' && !atoms[j].neg && atoms[j].set === a.set) j += 1;
        parts.push(`ltrim(substr(${lhs}, ${i + 1}, ${j - i}), ${quoteLiteral(a.set)}) = ''`);
      } else {
        parts.push(`ltrim(substr(${lhs}, ${i + 1}, 1), ${quoteLiteral(a.set)}) <> ''`);
      }
      i = j;
    }
    return `(${parts.join(' AND ')})`;
  }
  // *[^集合]* : 集合の外の文字を1つでも含む
  if (atoms.length === 3 && atoms[0].k === 'star' && atoms[2].k === 'star' && atoms[1].k === 'class' && atoms[1].neg) {
    return `(ltrim(${lhs}, ${quoteLiteral(atoms[1].set)}) <> '')`;
  }
  // 文字の前置き＋任意の1文字（?）＋末尾の *
  if (stars === 1 && atoms.at(-1).k === 'star' && atoms.slice(0, -1).every((a) => a.k === 'lit' || a.k === 'any')) {
    const body = atoms.slice(0, -1);
    const firstAny = body.findIndex((a) => a.k === 'any');
    const prefix = (firstAny < 0 ? body : body.slice(0, firstAny));
    if (body.slice(prefix.length).some((a) => a.k !== 'any')) throw new ConvertError(`変換しない GLOB の形: ${pattern}`);
    const parts = [`length(${lhs}) >= ${body.length}`];
    if (prefix.length) parts.push(`substr(${lhs}, 1, ${prefix.length}) = ${quoteLiteral(prefix.map((a) => a.v).join(''))}`);
    return `(${parts.join(' AND ')})`;
  }
  throw new ConvertError(`変換しない GLOB の形: ${pattern}`);
}

// ---------- 式 ----------

const PASS_FUNCTIONS = new Set(['substr', 'length', 'trim', 'ltrim', 'rtrim', 'lower', 'upper', 'abs', 'coalesce', 'count', 'sum', 'nullif', 'replace', 'exists']);
// SQLite と PostgreSQL で意味が変わる演算子の語。SQLite の LIKE は ASCII の大小を区別しない（PostgreSQL は区別する）
const STOP_WORDS = new Set(['LIKE', 'REGEXP', 'MATCH']);
const isPositiveInt = (nodes) => nodes.length === 1 && nodes[0].t === 'num' && /^\d+$/.test(nodes[0].v) && Number(nodes[0].v) > 0;
// 0 でない数の定数（符号つき・括弧つきも）。SQLite は 0 で割ると NULL、PostgreSQL は誤りで止まる
function isNonZeroConstant(node, after) {
  if (node?.t === 'grp') return node.items.length > 0 && node.items.length <= 2 && isNonZeroConstant(node.items[0], node.items[1]);
  if (isOp(node, '-') || isOp(node, '+')) return isNonZeroConstant(after);
  return node?.t === 'num' && Number(node.v) !== 0;
}
const BINARY_TIGHTER = new Set(['||', '+', '-', '*', '/', '%']);
const FROM_END = new Set(['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT']);

function castNodes(items) {
  const asAt = items.findIndex((n) => up(n) === 'AS');
  if (asAt < 0) throw new ConvertError(`CAST に AS が無い: ${render(items)}`);
  const inner = items.slice(0, asAt);
  const type = items.slice(asAt + 1).map((n) => n.v).join(' ').toUpperCase();
  const expr = render(inner);
  if (INTEGER_TYPES.includes(type)) return raw(`${LITE_CAST_INT}(${expr})`);
  if (type === 'BLOB') return raw(`convert_to(${expr}, 'UTF8')`);
  if (type === 'TEXT') return raw(`CAST(${expr} AS text)`);
  if (type === 'REAL') return raw(`CAST(${expr} AS double precision)`);
  throw new ConvertError(`変換しない CAST の型: ${type}`);
}

const PREDICATE_WORDS = new Set(['IS', 'IN', 'BETWEEN', 'NOT', 'AND', 'OR', 'EXISTS', 'LIKE', 'GLOB']);
function isPredicate(items) {
  if (up(items[0]) === 'SELECT') return false; // 副問い合わせ（値）は真偽でない
  return items.some((n) => (n.t === 'op' && ['=', '==', '<>', '!=', '<', '>', '<=', '>='].includes(n.v)) || PREDICATE_WORDS.has(up(n))
    || (n.t === 'raw' && /^\(?(\(length|ltrim|NOT \()/.test(n.v)));
}

// 式（CHECK・DEFAULT・WHERE・トリガーの中の文）を PostgreSQL の形にする
export function xexpr(nodes) {
  // 1) 入れ子と関数
  let out = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const next = nodes[i + 1];
    if (node.t === 'grp') { out.push({ t: 'grp', items: xexpr(node.items) }); continue; }
    if (node.t === 'id' && !node.q && next?.t === 'grp') {
      const name = node.v.toLowerCase();
      const prevWord = up(out.at(-1));
      if (prevWord === 'INTO' || prevWord === 'TABLE' || prevWord === 'REFERENCES' || KEYWORD_BEFORE_PAREN.has(up(node))) {
        out.push(node);
        continue;
      }
      if (name === 'cast') { out.push(castNodes(xexpr(next.items))); i += 1; continue; }
      const args = splitTop(next.items).map((a) => xexpr(a));
      const argText = args.map((a) => render(a));
      const call = (fn, list = argText) => raw(`${fn}(${list.join(', ')})`);
      i += 1;
      if (name === 'substr') {
        // 負の開始位置は SQLite では末尾から数え、PostgreSQL では先頭より前と読む。負の長さは SQLite では前の文字、PostgreSQL では誤り
        const rawArgs = splitTop(next.items);
        if (rawArgs.length < 2 || !isPositiveInt(rawArgs[1])) throw new ConvertError(`substr() の開始位置が正の整数の定数でない: ${render(next.items)}`);
        if (rawArgs[2] && isOp(rawArgs[2][0], '-')) throw new ConvertError(`substr() の長さが負: ${render(next.items)}`);
      }
      if (PASS_FUNCTIONS.has(name)) { out.push(node, { t: 'grp', items: xexpr(next.items) }); continue; }
      if (name === 'round') {
        // PostgreSQL の round(double precision) は偶数へ丸め、SQLite は 0 から遠い方へ丸める。numeric の round は SQLite と同じ向きなので、
        // いつも numeric に直して丸める。桁数つきは止める（SQLite は2進の値を丸め、numeric は10進で丸める。round(0.35, 1) が 0.3 と 0.4 に分かれる）
        if (args.length === 2) throw new ConvertError(`桁数つきの round() は変換しない（SQLite と PostgreSQL で丸めた値が変わる）: ${render(next.items)}`);
        if (args.length !== 1) throw new ConvertError(`round() の引数の数: ${args.length}`);
        out.push(raw(`round((${argText[0]})::numeric)`));
        continue;
      }
      if (name === 'ifnull') { out.push(call('coalesce')); continue; }
      if (name === 'max' || name === 'min') {
        if (args.length > 2) throw new ConvertError(`${name}() の引数が3つ以上`);
        if (args.length === 2) out.push(call(name === 'max' ? 'lite_max' : 'lite_min'));
        else out.push(call(name));
        continue;
      }
      if (name === 'typeof') { out.push(call('lite_typeof')); continue; }
      if (name === 'date') {
        if (args.length === 2 && argText[1] === "'+0 days'") { out.push(call('lite_date', [argText[0]])); continue; }
        if (args.length === 1) { out.push(call('lite_date')); continue; }
        throw new ConvertError(`変換しない date() の引数: ${argText.join(', ')}`);
      }
      const lite = liteCall(name, argText);
      if (lite) { out.push(call(lite.name, lite.args)); continue; }
      if (name === 'raise') throw new ConvertError('RAISE がトリガーの文の先頭以外にある');
      throw new ConvertError(`変換しない関数: ${node.v}()`);
    }
    if (STOP_WORDS.has(up(node))) throw new ConvertError(`変換しない演算子: ${node.v}（SQLite と PostgreSQL で大小の区別・意味が違う）`);
    if (isOp(node, '%')) throw new ConvertError('% は変換しない（SQLite は整数に直してから余りを取り、0 で割ると NULL。PostgreSQL は小数の余りを返し、0 で誤り）');
    if (isOp(node, '/') && !isNonZeroConstant(next, nodes[i + 2])) throw new ConvertError(`0 でない数の定数以外で割る / は変換しない（SQLite は 0 で割ると NULL、PostgreSQL は誤り）: / ${render(nodes.slice(i + 1, i + 3))}`);
    if (up(node) === 'CURRENT_TIMESTAMP') { out.push(raw(TIMESTAMP_TEXT)); continue; }
    if (up(node) === 'CURRENT_DATE' || up(node) === 'CURRENT_TIME') throw new ConvertError(`変換しない: ${node.v}`);
    if (node.t === 'str' && /^[xX]$/.test(out.at(-1)?.v ?? '')) throw new ConvertError('BLOB の定数は変換しない');
    out.push(node);
  }

  // 1b) 真偽の式を数として使う所（(a IS NOT NULL) + (b IS NOT NULL) など）。SQLite の真偽は 0/1 の整数
  for (let i = 0; i < out.length; i += 1) {
    const node = out[i];
    if (node.t !== 'grp' || !isPredicate(node.items)) continue;
    const prev = out[i - 1];
    const next = out[i + 1];
    const arith = (n) => n?.t === 'op' && ['+', '-', '*', '/', '%'].includes(n.v);
    if (arith(prev) || arith(next)) out[i] = raw(`(${render(node.items)})::int`);
  }

  // 2) GLOB
  for (let k = out.findIndex((n) => up(n) === 'GLOB'); k >= 0; k = out.findIndex((n) => up(n) === 'GLOB')) {
    const negated = up(out[k - 1]) === 'NOT';
    const end = negated ? k - 1 : k; // LHS は [start, end)
    let start = end - 1;
    if (start < 0) throw new ConvertError('GLOB の左辺が無い');
    if (out[start].t === 'grp' && out[start - 1]?.t === 'id' && !KEYWORD_BEFORE_PAREN.has(up(out[start - 1]))) start -= 1;
    else if (out[start].t === 'id' && isOp(out[start - 1], '.') && out[start - 2]?.t === 'id') start -= 2;
    else if (!(out[start].t === 'id' || out[start].t === 'grp' || out[start].t === 'raw')) throw new ConvertError(`GLOB の左辺を読めない: ${render(out.slice(Math.max(0, start - 3), k + 2))}`);
    if (out[start - 1]?.t === 'op' && BINARY_TIGHTER.has(out[start - 1].v)) throw new ConvertError(`GLOB の左辺が演算を含む: ${render(out.slice(Math.max(0, start - 3), k + 2))}`);
    const rhs = out[k + 1];
    if (rhs?.t !== 'str') throw new ConvertError('GLOB の右辺が文字の定数でない');
    const check = globToCheck(render(out.slice(start, end)), unquote(rhs.v));
    out.splice(start, k + 2 - start, raw(negated ? `(NOT ${check})` : check));
  }

  // 3) IS / IS NOT（NULL 以外と比べる） → IS [NOT] DISTINCT FROM
  const res = [];
  for (let i = 0; i < out.length; i += 1) {
    const node = out[i];
    if (up(node) === 'IS') {
      const not = up(out[i + 1]) === 'NOT';
      const after = out[i + (not ? 2 : 1)];
      if (isComparison(up(after))) { // 入口（src/data-platform/pg-db.mjs）と同じ規則（lite-sql.mjs）
        res.push(raw(not ? 'IS DISTINCT FROM' : 'IS NOT DISTINCT FROM'));
        if (not) i += 1;
        continue;
      }
    }
    if (isOp(node, '==')) { res.push({ t: 'op', v: '=' }); continue; }
    res.push(node);
  }

  // 4) FROM の並びのカンマ → CROSS JOIN（SQLite はカンマと JOIN を左から同じ強さで結ぶ。PostgreSQL は JOIN が強く、
  //    ON から前の表を見られなくなる）
  let inFrom = false;
  for (let i = 0; i < res.length; i += 1) {
    const w = up(res[i]);
    if (w === 'FROM') inFrom = true;
    else if (w && FROM_END.has(w)) inFrom = false;
    else if (inFrom && isOp(res[i], ',')) res[i] = raw('CROSS JOIN');
  }
  return res;
}

const exprText = (nodes) => render(xexpr(nodes));
// 式1つ（SQLite の文字）を PostgreSQL の式にする。試験が使う
export const convertExpression = (text) => exprText(tree(tokenize(text)));
export { ConvertError };

// ---------- 文を分ける ----------

function splitStatements(tokens) {
  const statements = [];
  let current = [];
  let inTrigger = false;
  let begun = false;
  let caseDepth = 0;
  for (const tok of tokens) {
    if (current.length === 0 && isOp(tok, ';')) continue;
    current.push(tok);
    if (current.length <= 4 && up(tok) === 'TRIGGER' && up(current[0]) === 'CREATE') inTrigger = true;
    if (inTrigger) {
      const w = up(tok);
      if (w === 'BEGIN' && !begun) { begun = true; continue; }
      if (begun && w === 'CASE') caseDepth += 1;
      else if (begun && w === 'END') {
        if (caseDepth > 0) caseDepth -= 1;
        else { statements.push(current); current = []; inTrigger = false; begun = false; }
      }
      continue;
    }
    if (isOp(tok, ';')) { current.pop(); statements.push(current); current = []; }
  }
  if (current.length) {
    if (inTrigger) throw new ConvertError('トリガーの END が無い');
    statements.push(current);
  }
  return statements;
}

// ---------- 変換 ----------

function parseColumn(nodes, table) {
  const name = nodes[0];
  if (name?.t !== 'id') throw new ConvertError(`${table}: 列の名前を読めない`);
  let i = 1;
  const typeWords = [];
  const STOP = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'REFERENCES', 'COLLATE', 'GENERATED']);
  while (i < nodes.length && nodes[i].t === 'id' && !STOP.has(up(nodes[i]))) { typeWords.push(nodes[i].v); i += 1; }
  if (nodes[i]?.t === 'grp' && typeWords.length) i += 1; // VARCHAR(10) など。長さは使わない
  const col = { name: name.v, declared: typeWords.join(' '), pk: false, notNull: false, unique: false, default: null, checks: [], fk: null };
  while (i < nodes.length) {
    const w = up(nodes[i]);
    if (w === 'PRIMARY' && up(nodes[i + 1]) === 'KEY') {
      col.pk = true; i += 2;
      if (up(nodes[i]) === 'ASC' || up(nodes[i]) === 'DESC') i += 1;
      if (up(nodes[i]) === 'AUTOINCREMENT') throw new ConvertError(`${table}.${col.name}: AUTOINCREMENT は変換しない`);
    } else if (w === 'NOT' && up(nodes[i + 1]) === 'NULL') { col.notNull = true; i += 2; }
    else if (w === 'NULL') { i += 1; }
    else if (w === 'UNIQUE') { col.unique = true; i += 1; }
    else if (w === 'CHECK' && nodes[i + 1]?.t === 'grp') { col.checks.push(nodes[i + 1].items); i += 2; }
    else if (w === 'DEFAULT') {
      const v = nodes[i + 1];
      if (isOp(v, '-') || isOp(v, '+')) { col.default = [v, nodes[i + 2]]; i += 3; }
      else { col.default = [v]; i += 2; }
    } else if (w === 'REFERENCES') {
      const ref = nodes[i + 1];
      const cols = nodes[i + 2]?.t === 'grp' ? nodes[i + 2] : null;
      i += cols ? 3 : 2;
      const actions = [];
      while (up(nodes[i]) === 'ON') { actions.push(nodes[i], nodes[i + 1], nodes[i + 2]); i += 3; if (up(nodes[i - 1]) === 'SET' || up(nodes[i - 1]) === 'NO') { actions.push(nodes[i]); i += 1; } }
      col.fk = { from: [col.name], ref: ref.v, to: cols ? colList(cols, table) : null, actions: render(actions) };
    } else throw new ConvertError(`${table}.${col.name}: 変換しない列の制約 ${render(nodes.slice(i, i + 3))}`);
  }
  return col;
}

const FK_ACTION_WORDS = new Set(['ON', 'DELETE', 'UPDATE', 'CASCADE', 'SET', 'NULL', 'DEFAULT', 'RESTRICT', 'NO', 'ACTION']);
// (a, b) の列の並び。列の名前のほかの指定（ASC・COLLATE など）があれば止める
function colList(grp, where) {
  return splitTop(grp.items).map((p) => {
    if (p.length !== 1 || p[0].t !== 'id') throw new ConvertError(`${where}: 列の並びを読めない: ${render(p)}`);
    return p[0].v;
  });
}

function parseCreateTable(stmt) {
  let i = 2;
  let ifNotExists = false;
  if (up(stmt[i]) === 'IF' && up(stmt[i + 1]) === 'NOT' && up(stmt[i + 2]) === 'EXISTS') { ifNotExists = true; i += 3; }
  const name = stmt[i].v;
  const body = stmt[i + 1];
  if (body?.t !== 'grp' || stmt.length !== i + 2) throw new ConvertError(`${name}: 変換しない CREATE TABLE の形（WITHOUT ROWID・AS SELECT など）`);
  const columns = [];
  const constraints = [];
  for (const def of splitTop(body.items)) {
    const w = up(def[0]);
    if (w === 'CONSTRAINT') throw new ConvertError(`${name}: 名前つきの制約は変換しない`);
    if (w === 'PRIMARY' && up(def[1]) === 'KEY') constraints.push({ k: 'pk', cols: colList(def[2], name) });
    else if (w === 'UNIQUE') constraints.push({ k: 'unique', cols: colList(def[1], name) });
    else if (w === 'CHECK') constraints.push({ k: 'check', expr: def[1].items });
    else if (w === 'FOREIGN' && up(def[1]) === 'KEY') {
      const from = colList(def[2], name);
      if (up(def[3]) !== 'REFERENCES') throw new ConvertError(`${name}: FOREIGN KEY の形`);
      const to = def[5]?.t === 'grp' ? colList(def[5], name) : null;
      const rest = def.slice(to ? 6 : 5);
      if (rest.some((n) => !FK_ACTION_WORDS.has(up(n)))) throw new ConvertError(`${name}: 変換しない FOREIGN KEY の後ろ: ${render(rest)}`);
      constraints.push({ k: 'fk', fk: { from, ref: def[4].v, to, actions: render(rest) } });
    } else columns.push(parseColumn(def, name));
  }
  return { name, ifNotExists, columns, constraints };
}

function tableDdl(table, info) {
  const lines = [];
  const pkCols = table.columns.filter((c) => c.pk);
  const tablePk = table.constraints.find((c) => c.k === 'pk');
  if (pkCols.length + (tablePk ? 1 : 0) > 1) throw new ConvertError(`${table.name}: 主キーが2つある`);
  for (const col of table.columns) {
    const type = pgType(col.declared);
    const identity = col.pk && col.declared.toUpperCase() === 'INTEGER';
    const parts = [ident(col.name), type];
    if (type === 'text') parts.push('COLLATE "C"');
    if (identity) { parts.push('GENERATED BY DEFAULT AS IDENTITY'); info.identities.push({ table: table.name, column: col.name }); }
    if (col.pk) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    if (col.unique) parts.push('UNIQUE');
    if (col.default) {
      const d = col.default;
      if (d.length === 1 && up(d[0]) === 'CURRENT_TIMESTAMP') {
        if (type !== 'text') throw new ConvertError(`${table.name}.${col.name}: TEXT でない列の DEFAULT CURRENT_TIMESTAMP`);
        parts.push(`DEFAULT ${TIMESTAMP_TEXT}`);
        info.timestampDefaults += 1;
      } else if (d.length === 1 && d[0].t === 'grp') parts.push(`DEFAULT (${exprText(d[0].items)})`);
      else if (d.every((n) => n.t === 'num' || n.t === 'str' || isOp(n, '-') || isOp(n, '+') || up(n) === 'NULL')) parts.push(`DEFAULT ${render(d)}`);
      else throw new ConvertError(`${table.name}.${col.name}: 変換しない DEFAULT ${render(d)}`);
    }
    for (const check of col.checks) parts.push(`CHECK (${exprText(check)})`);
    lines.push(`  ${parts.join(' ')}`);
    if (col.fk) info.fks.push({ owner: table.name, ...col.fk });
  }
  for (const c of table.constraints) {
    if (c.k === 'pk') lines.push(`  PRIMARY KEY (${c.cols.map(ident).join(', ')})`);
    else if (c.k === 'unique') lines.push(`  UNIQUE (${c.cols.map(ident).join(', ')})`);
    else if (c.k === 'check') lines.push(`  CHECK (${exprText(c.expr)})`);
    else if (c.k === 'fk') info.fks.push({ owner: table.name, ...c.fk });
  }
  return `CREATE TABLE ${ident(table.name)} (\n${lines.join(',\n')}\n);`;
}

function convertIndex(stmt) {
  let i = 1;
  const unique = up(stmt[i]) === 'UNIQUE';
  if (unique) i += 1;
  i += 1; // INDEX
  let ifNotExists = false;
  if (up(stmt[i]) === 'IF') { ifNotExists = true; i += 3; }
  const name = stmt[i].v;
  if (up(stmt[i + 1]) !== 'ON' || stmt[i + 3]?.t !== 'grp') throw new ConvertError(`索引 ${name} の形`);
  const table = stmt[i + 2].v;
  const cols = splitTop(stmt[i + 3].items).map((p) => exprText(p));
  const rest = stmt.slice(i + 4);
  let where = '';
  if (rest.length) {
    if (up(rest[0]) !== 'WHERE') throw new ConvertError(`索引 ${name} の後ろ: ${render(rest)}`);
    where = ` WHERE ${exprText(rest.slice(1))}`;
  }
  const columns = cols.map((c) => (/^[a-z_][a-z0-9_]*( (ASC|DESC))?$/i.test(c) ? c : `(${c})`));
  return { name, pgName: indexName(name), table, ifNotExists, sql: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${ident(indexName(name))} ON ${ident(table)} (${columns.join(', ')})${where};` };
}

function convertInsert(stmt, { alwaysIgnore = false } = {}) {
  let i = 1;
  let ignore = false;
  if (up(stmt[i]) === 'OR') {
    if (up(stmt[i + 1]) !== 'IGNORE') throw new ConvertError(`INSERT OR ${stmt[i + 1].v} は変換しない`);
    ignore = true;
    i += 2;
  }
  if (up(stmt[i]) !== 'INTO') throw new ConvertError('INSERT の形');
  const table = stmt[i + 1].v;
  let j = i + 2;
  const cols = stmt[j]?.t === 'grp' ? stmt[j] : null;
  if (cols) j += 1;
  const colSql = cols ? ` (${splitTop(cols.items).map((p) => ident(p[0].v)).join(', ')})` : '';
  const conflict = ignore || alwaysIgnore ? '\nON CONFLICT DO NOTHING' : '';
  if (up(stmt[j]) === 'SELECT') return { table, sql: `INSERT INTO ${ident(table)}${colSql}\n  ${exprText(stmt.slice(j))}${conflict};` };
  if (up(stmt[j]) !== 'VALUES') throw new ConvertError(`${table}: INSERT は VALUES か SELECT の形だけを変換する`);
  const rows = splitTop(stmt.slice(j + 1)).map((r) => {
    if (r.length !== 1 || r[0].t !== 'grp') throw new ConvertError(`${table}: VALUES の形`);
    return `(${exprText(r[0].items)})`;
  });
  return { table, sql: `INSERT INTO ${ident(table)}${colSql} VALUES\n  ${rows.join(',\n  ')}${conflict};` };
}

// RAISE(ABORT, '文') の grp から文を取り出す
function raiseMessage(grp, where) {
  const args = splitTop(grp.items);
  if (args.length !== 2 || up(args[0][0]) !== 'ABORT' || args[1].length !== 1 || args[1][0].t !== 'str') {
    throw new ConvertError(`${where}: RAISE は (ABORT, '文') だけを変換する`);
  }
  return unquote(args[1][0].v);
}
const raiseStmt = (message) => `RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = ${quoteLiteral(message)};`;

// CASE WHEN c THEN RAISE(...) ... END を IF … ELSIF … END IF にする
function caseToIf(nodes, where) {
  if (up(nodes[0]) !== 'CASE' || up(nodes.at(-1)) !== 'END') throw new ConvertError(`${where}: CASE の形`);
  const inner = nodes.slice(1, -1);
  if (up(inner[0]) !== 'WHEN') throw new ConvertError(`${where}: CASE x WHEN の形は変換しない`);
  const branches = [];
  let depth = 0;
  let cur = null;
  for (const node of inner) {
    const w = up(node);
    if (w === 'CASE') depth += 1;
    if (w === 'END') depth -= 1;
    if (depth === 0 && (w === 'WHEN' || w === 'THEN' || w === 'ELSE')) {
      if (w === 'WHEN') { cur = { cond: [], then: [] }; branches.push(cur); cur.part = 'cond'; }
      else if (w === 'THEN') cur.part = 'then';
      else { cur = { cond: null, then: [], part: 'then' }; branches.push(cur); }
      continue;
    }
    cur[cur.part].push(node);
  }
  const lines = [];
  const conditions = [];
  branches.forEach((b, idx) => {
    let action;
    if (up(b.then[0]) === 'RAISE' && b.then.length === 2 && b.then[1].t === 'grp') action = raiseStmt(raiseMessage(b.then[1], where));
    else if (b.then.length === 1 && up(b.then[0]) === 'NULL') action = 'NULL;';
    else throw new ConvertError(`${where}: CASE の THEN が RAISE でも NULL でもない: ${render(b.then)}`);
    if (b.cond === null) { lines.push(`ELSE ${action}`); return; }
    const cond = exprText(b.cond);
    conditions.push(cond);
    lines.push(`${idx === 0 ? 'IF' : 'ELSIF'} (${cond}) THEN ${action}`);
  });
  lines.push('END IF;');
  return { lines, conditions };
}

function parseTriggerHeader(stmt) {
  let i = 1;
  if (up(stmt[i]) === 'TEMP' || up(stmt[i]) === 'TEMPORARY') throw new ConvertError('一時トリガーは変換しない');
  i += 1; // TRIGGER
  let ifNotExists = false;
  if (up(stmt[i]) === 'IF') { ifNotExists = true; i += 3; }
  const name = stmt[i].v;
  i += 1;
  let timing = 'BEFORE';
  if (up(stmt[i]) === 'BEFORE' || up(stmt[i]) === 'AFTER') { timing = up(stmt[i]); i += 1; }
  else if (up(stmt[i]) === 'INSTEAD') throw new ConvertError(`${name}: INSTEAD OF は変換しない`);
  const event = up(stmt[i]);
  if (!['INSERT', 'UPDATE', 'DELETE'].includes(event)) throw new ConvertError(`${name}: 事象を読めない`);
  i += 1;
  let columns = [];
  if (up(stmt[i]) === 'OF') {
    i += 1;
    columns.push(stmt[i].v);
    i += 1;
    while (isOp(stmt[i], ',')) { columns.push(stmt[i + 1].v); i += 2; }
  }
  if (up(stmt[i]) !== 'ON') throw new ConvertError(`${name}: ON が無い`);
  const table = stmt[i + 1].v;
  i += 2;
  if (up(stmt[i]) === 'FOR') i += 3;
  let when = null;
  const beginAt = stmt.findIndex((n, idx) => idx >= i && up(n) === 'BEGIN');
  if (up(stmt[i]) === 'WHEN') when = stmt.slice(i + 1, beginAt);
  else if (beginAt !== i) throw new ConvertError(`${name}: BEGIN の前を読めない`);
  if (up(stmt.at(-1)) !== 'END') throw new ConvertError(`${name}: END で終わらない`);
  return { name, ifNotExists, timing, event, columns, table, when, body: stmt.slice(beginAt + 1, -1) };
}

// トリガーの中の表の別名 old・new（src/mg.sql の mg_ledger_successor_scope の `FROM mg_ledger_entries old`）。SQLite は、別名を宣言した段の
// 「別名.列」を別名の行として読むが、PL/pgSQL の関数では別名と OLD・NEW の行を区別できず `column reference "old.org_id" is ambiguous`
// で断る。別名を <別名>_row に言い換える。言い換えるのは、別名を宣言した文（その段の ; から ; まで）の宣言と、その段の「別名.列」だけ。
// 関数の括弧などの式の括弧はその段に含む。入れ子の副問い合わせ（SELECT・WITH・VALUES で始まる括弧）の中の「別名.列」を、SQLite は
// トリガーの OLD・NEW の行として読む（UPDATE・DELETE の old、INSERT・UPDATE の new）。その形は言い換えると意味が変わるので断る。
// その事象に無い行（INSERT の old・DELETE の new）なら、SQLite も別名として読むので、入れ子の中も言い換える。入れ子が同じ名前の別名を
// 自分で宣言していれば、そこは入れ子を訪ねたときに言い換える。同じ段に UNION などがあれば、別名の届く範囲を読まずに断る。
// 移行（migrations/）と D1 のトリガーは変えない
const ROW_ALIASES = new Set(['OLD', 'NEW']);
const SUBQUERY_HEADS = new Set(['SELECT', 'WITH', 'VALUES']);
const COMPOUND_WORDS = new Set(['UNION', 'INTERSECT', 'EXCEPT']);
export function renameRowAliases(nodes, where = 'トリガー', event = 'UPDATE') {
  if (!['INSERT', 'UPDATE', 'DELETE'].includes(event)) throw new ConvertError(`${where}: 事象 ${event} を読めない`);
  const rowExists = (alias) => event === 'UPDATE' || (alias === 'OLD' ? event === 'DELETE' : event === 'INSERT');
  const used = new Set();
  const collect = (items) => { for (const n of items) { if (n.t === 'grp') collect(n.items); else if (n.t === 'id') used.add(n.v.toLowerCase()); } };
  collect(nodes);
  const isSubquery = (n) => n.t === 'grp' && SUBQUERY_HEADS.has(up(n.items[0]));
  // items[k] が FROM・JOIN なら、宣言した別名とその位置
  const aliasAt = (items, k) => {
    const w = up(items[k]);
    if ((w !== 'FROM' && w !== 'JOIN') || items[k + 1]?.t !== 'id') return null;
    let at = k + 2;
    if (up(items[at]) === 'AS') at += 1;
    const alias = up(items[at]);
    if (!ROW_ALIASES.has(alias) || isOp(items[at + 1], '.')) return null;
    return { alias, at };
  };
  const declares = (items, alias) => items.some((_, k) => aliasAt(items, k)?.alias === alias);
  const refers = (items, alias) => items.some((n, k) => (n.t === 'grp' ? refers(n.items, alias) : up(n) === alias && isOp(items[k + 1], '.')));
  const rename = (items, alias, to) => items.map((n, k) => {
    if (n.t === 'grp') {
      if (isSubquery(n)) {
        if (declares(n.items, alias) || !refers(n.items, alias)) return n;
        if (rowExists(alias)) throw new ConvertError(`${where}: 入れ子の副問い合わせの ${alias}.列 は、SQLite ではトリガーの ${alias} の行を指すので、別名 ${alias} を言い換えられない`);
      }
      return { ...n, items: rename(n.items, alias, to) };
    }
    if (up(n) === alias && isOp(items[k + 1], '.')) return { ...n, v: to };
    return n;
  });
  const visit = (items) => {
    let out = items;
    for (let k = 0; k < out.length; k += 1) {
      const found = aliasAt(out, k);
      if (!found) continue;
      const { alias, at } = found;
      const to = `${alias.toLowerCase()}_row`;
      if (used.has(to)) throw new ConvertError(`${where}: 別名 ${alias} の言い換え先 ${to} が既にある`);
      let from = k;
      while (from > 0 && !isOp(out[from - 1], ';')) from -= 1;
      let until = at;
      while (until < out.length && !isOp(out[until], ';')) until += 1;
      const statement = out.slice(from, until);
      if (statement.some((n) => COMPOUND_WORDS.has(up(n)))) throw new ConvertError(`${where}: 別名 ${alias} を宣言した文に UNION・INTERSECT・EXCEPT がある`);
      const renamed = rename(statement, alias, to);
      renamed[at - from] = { ...renamed[at - from], v: to };
      out = [...out.slice(0, from), ...renamed, ...out.slice(until)];
    }
    return out.map((n) => (n.t === 'grp' ? { ...n, items: visit(n.items) } : n));
  };
  return visit(nodes);
}

function convertTrigger(stmt) {
  const h = parseTriggerHeader(stmt);
  h.body = renameRowAliases(h.body, `トリガー ${h.name}`, h.event);
  if (h.when) h.when = renameRowAliases(h.when, `トリガー ${h.name}`, h.event);
  const where = `トリガー ${h.name}`;
  const bodies = splitTop(h.body, ';').filter((s) => s.length);
  const header = `CREATE TRIGGER ${ident(h.name)} ${h.timing} ${h.event}${h.columns.length ? ` OF ${h.columns.map(ident).join(', ')}` : ''} ON ${ident(h.table)} FOR EACH ROW`;
  const base = { name: h.name, table: h.table, timing: h.timing, event: h.event, columns: h.columns };

  // 無条件に拒むだけ → 共通の関数
  if (!h.when && bodies.length === 1 && bodies[0].length === 3 && up(bodies[0][0]) === 'SELECT' && up(bodies[0][1]) === 'RAISE' && bodies[0][2].t === 'grp') {
    const message = raiseMessage(bodies[0][2], where);
    return { ...base, kind: 'reject', checks: [], sql: `${header} EXECUTE FUNCTION lite_reject_change(${quoteLiteral(message)});` };
  }

  const fn = `${h.name}_fn`;
  if (fn.length > 63) throw new ConvertError(`${where}: 関数の名前が 63 字を超える`);
  const ret = h.timing === 'AFTER' ? 'NULL' : h.event === 'DELETE' ? 'OLD' : 'NEW';
  const lines = [];
  const checks = []; // 関数の中の式を、表の行の型で計画だけ立てて確かめる（PL/pgSQL は文を実行するまで型を見ない）
  if (h.when) {
    const cond = exprText(h.when);
    checks.push({ cond });
    lines.push(`IF (${cond}) IS NOT TRUE THEN RETURN ${ret}; END IF;`);
  }
  for (const body of bodies) {
    const w0 = up(body[0]);
    if (w0 === 'SELECT' && up(body[1]) === 'RAISE' && body[2]?.t === 'grp') {
      const message = raiseMessage(body[2], where);
      const rest = body.slice(3);
      if (!rest.length) lines.push(raiseStmt(message));
      else if (up(rest[0]) === 'WHERE') { const cond = exprText(rest.slice(1)); checks.push({ cond }); lines.push(`IF (${cond}) THEN ${raiseStmt(message)} END IF;`); }
      else if (up(rest[0]) === 'FROM') { const cond = `EXISTS (SELECT 1 ${exprText(rest)})`; checks.push({ cond }); lines.push(`IF ${cond} THEN ${raiseStmt(message)} END IF;`); }
      else throw new ConvertError(`${where}: SELECT RAISE の後ろを読めない`);
    } else if (w0 === 'SELECT' && up(body[1]) === 'CASE') {
      const r = caseToIf(body.slice(1), where);
      for (const cond of r.conditions) checks.push({ cond });
      lines.push(...r.lines);
    } else if (w0 === 'INSERT' || w0 === 'UPDATE' || w0 === 'DELETE') {
      if (up(body[1]) === 'OR') throw new ConvertError(`${where}: ${w0} OR は変換しない`);
      const sql = exprText(body);
      checks.push({ statement: sql });
      lines.push(`${sql};`);
    } else throw new ConvertError(`${where}: 変換しない文: ${render(body).slice(0, 120)}`);
  }
  lines.push(`RETURN ${ret};`);
  // NEW・OLD を、その表の行の型を持つ0行の副問い合わせに置いて、式の型を計画で確かめる（実行はしない）
  const rows = `(SELECT * FROM ${ident(h.table)} LIMIT 0) AS "new" CROSS JOIN (SELECT * FROM ${ident(h.table)} LIMIT 0) AS "old"`;
  for (const check of checks) {
    if (check.cond) check.sql = `EXPLAIN SELECT 1 FROM ${rows} WHERE (${check.cond})`;
    else {
      const at = check.statement.search(/\bFROM\b/);
      if (at < 0) throw new ConvertError(`${where}: FROM の無い ${check.statement.slice(0, 6)} は検証できない`);
      check.sql = `EXPLAIN ${check.statement.slice(0, at)}FROM ${rows} CROSS JOIN ${check.statement.slice(at + 4)}`;
    }
  }
  const fnSql = `CREATE FUNCTION ${ident(fn)}() RETURNS trigger LANGUAGE plpgsql AS $fn$\nBEGIN\n${lines.map((l) => `  ${l.replaceAll('\n', '\n  ')}`).join('\n')}\nEND\n$fn$;`;
  return { ...base, kind: 'function', function: fn, checks, sql: `${fnSql}\n${header} EXECUTE FUNCTION ${ident(fn)}();` };
}

// SQLite と同じ結果を返す補助関数（変換した CHECK・トリガーが呼ぶ）
export const HELPERS_SQL = String.raw`-- 無条件に拒むトリガー（更新・削除の禁止など）の共通の関数。文はトリガーの引数で渡す
CREATE FUNCTION lite_reject_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = TG_ARGV[0];
END
$fn$;

-- date(x, '+0 days')。YYYY-MM-DD（時刻つきも可）を読み、日があふれたら SQLite と同じく翌月へ送る。読めなければ NULL
-- make_date は 0000 年を受け付けない（SQLite は受け付ける）。グレゴリオ暦は400年で一周するので、400年ずらして計算して戻す
CREATE FUNCTION lite_date(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  y int; m int; d int; shifted date;
BEGIN
  IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?)?$' THEN RETURN NULL; END IF;
  y := substr(value, 1, 4)::int; m := substr(value, 6, 2)::int; d := substr(value, 9, 2)::int;
  IF m < 1 OR m > 12 OR d < 1 OR d > 31 THEN RETURN NULL; END IF;
  shifted := make_date(y + 400, m, 1) + (d - 1);
  RETURN lpad((extract(year FROM shifted)::int - 400)::text, 4, '0') || to_char(shifted, '-MM-DD');
END
$fn$;

-- typeof(x)。列の型で決まる（bigint は integer、numeric は小数部の桁があれば real）
CREATE FUNCTION lite_typeof(value bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN value IS NULL THEN 'null' ELSE 'integer' END $fn$;
CREATE FUNCTION lite_typeof(value numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN value IS NULL THEN 'null' WHEN scale(value) = 0 THEN 'integer' ELSE 'real' END $fn$;
CREATE FUNCTION lite_typeof(value double precision) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN value IS NULL THEN 'null' ELSE 'real' END $fn$;
CREATE FUNCTION lite_typeof(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN value IS NULL THEN 'null' ELSE 'text' END $fn$;

-- max(a, b)・min(a, b)（2つの値）。SQLite はどちらかが NULL なら NULL（PostgreSQL の greatest・least は NULL を飛ばす）
CREATE FUNCTION lite_max(a anycompatible, b anycompatible) RETURNS anycompatible LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL ELSE greatest(a, b) END $fn$;
CREATE FUNCTION lite_min(a anycompatible, b anycompatible) RETURNS anycompatible LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL ELSE least(a, b) END $fn$;

-- CAST(x AS INTEGER)。文字は先頭の整数だけを読み（読めなければ 0）、小数は 0 の方へ切り捨てる
CREATE FUNCTION lite_cast_int(value text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN value IS NULL THEN NULL ELSE COALESCE(substring(value FROM '^\s*([+-]?[0-9]{1,18})')::bigint, 0) END
$fn$;
CREATE FUNCTION lite_cast_int(value bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$ SELECT value $fn$;
CREATE FUNCTION lite_cast_int(value numeric) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$ SELECT trunc(value)::bigint $fn$;
CREATE FUNCTION lite_cast_int(value double precision) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$ SELECT trunc(value)::bigint $fn$;

-- json_valid(x)。JSON として読めるか（NULL は NULL）
CREATE FUNCTION lite_json_valid(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  PERFORM value::jsonb;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END
$fn$;

-- 読めない JSON は NULL（SQLite は誤りで止める。CHECK では json_valid と並べて使っているので結果は同じ「通さない」）。
-- jsonb でなく json で読む。json は文書のキーの順と元の文字を保つので、json_each のキーの順と、入れ子の値の文字が SQLite と同じになる
-- （アプリが JSON.stringify で作った空白の無い JSON のとき。SQLite は入れ子の値を空白を除いた文字で返す）
CREATE FUNCTION lite_json(value text) RETURNS json LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  RETURN value::json;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;

-- '$.a.b'・'$[0]'・'$.a[1]' の形の道筋を text[] にする
CREATE FUNCTION lite_json_path(path text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN path = '$' THEN ARRAY[]::text[]
    ELSE string_to_array(regexp_replace(regexp_replace(substr(path, 2), '\[([0-9]+)\]', '.\1', 'g'), '^\.', ''), '.') END
$fn$;

-- SQLite の json_type の名前（integer・real・text・true・false・null・array・object）
CREATE FUNCTION lite_json_kind(value json) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE json_typeof(value)
    WHEN 'number' THEN CASE WHEN btrim(value::text) ~ '[.eE]' THEN 'real' ELSE 'integer' END
    WHEN 'string' THEN 'text'
    WHEN 'boolean' THEN btrim(value::text)
    ELSE json_typeof(value) END
$fn$;

CREATE FUNCTION lite_json_type(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT lite_json_kind(lite_json(value)) $fn$;

CREATE FUNCTION lite_json_array_length(value text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN lite_json(value) IS NULL THEN NULL WHEN json_typeof(lite_json(value)) = 'array' THEN json_array_length(lite_json(value)) ELSE 0 END
$fn$;

-- SQLite の値として返す（文字は引用符を外し、真偽は 1・0、小数は倍精度の値の文字（1.50 は 1.5）。配列・オブジェクトは JSON の文字。null は NULL）。
-- 返す型は text なので、数として比べる・足すときはアプリの SQL で CAST(… AS INTEGER) と書く（dialect.md）
CREATE FUNCTION lite_json_value(value json) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE json_typeof(value)
    WHEN 'string' THEN value #>> '{}'
    WHEN 'null' THEN NULL
    WHEN 'boolean' THEN CASE WHEN btrim(value::text) = 'true' THEN '1' ELSE '0' END
    WHEN 'number' THEN CASE WHEN btrim(value::text) ~ '[.eE]' THEN (btrim(value::text)::double precision)::text ELSE btrim(value::text) END
    ELSE btrim(value::text) END
$fn$;

CREATE FUNCTION lite_json_extract(value text, path text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lite_json_value(lite_json(value) #> lite_json_path(path))
$fn$;

-- json_each(x, path)。配列は添字、オブジェクトはキーを key にし、文書の順に返す。文字・数などのスカラー（JSON の null を含む）は key が NULL の1行
-- （SQLite と同じ）。SQLite との違い: key はいつも text（SQLite は配列の添字を整数で返す。並べるときは ORDER BY CAST(key AS INTEGER)）
CREATE FUNCTION lite_json_each(value text, path text) RETURNS TABLE(key text, value text, type text) LANGUAGE sql IMMUTABLE AS $fn$
  WITH target AS (SELECT lite_json(value) #> lite_json_path(path) AS j)
  SELECT x.k, x.v, x.t FROM (
    SELECT e.ord, (e.ord - 1)::text AS k, lite_json_value(e.v) AS v, lite_json_kind(e.v) AS t
      FROM target, json_array_elements(target.j) WITH ORDINALITY AS e(v, ord) WHERE json_typeof(target.j) = 'array'
    UNION ALL
    SELECT o.ord, o.k, lite_json_value(o.v), lite_json_kind(o.v)
      FROM target, json_each(target.j) WITH ORDINALITY AS o(k, v, ord) WHERE json_typeof(target.j) = 'object'
    UNION ALL
    SELECT 1, NULL, lite_json_value(target.j), lite_json_kind(target.j)
      FROM target WHERE json_typeof(target.j) NOT IN ('array', 'object')
  ) x ORDER BY x.ord
$fn$;
`;

const sameToken = (x, y) => x.t === y.t && (x.t === 'id' && !x.q ? x.v.toUpperCase() === y.v.toUpperCase() : x.v === y.v);
function applyPatches(flat, triggerName, used) {
  let out = flat;
  for (const patch of SOURCE_PATCHES.filter((p) => p.trigger === triggerName)) {
    const find = tokenize(patch.find);
    const hits = [];
    for (let i = 0; i + find.length <= out.length; i += 1) if (find.every((tok, k) => sameToken(tok, out[i + k]))) hits.push(i);
    if (hits.length !== 1) throw new ConvertError(`手直し（${patch.trigger}）の元の文が ${hits.length} 回見つかった。移行が変わったので手直しを見直す`);
    out = [...out.slice(0, hits[0]), ...tokenize(patch.replace), ...out.slice(hits[0] + find.length)];
    used.add(patch);
  }
  return out;
}

// appSources: 移行のあとに変換するアプリの DDL（APP_DDL_SOURCES）。既定は、移行の置き場が migrations/ のときだけ足す（試験が別の置き場で流すときは足さない）
export function convertMigrations({ dir = MIGRATIONS_DIR, appSources = dir === MIGRATIONS_DIR ? APP_DDL_SOURCES : [] } = {}) {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const units = [...files.map((file) => ({ file, read: () => readFileSync(resolve(dir, file), 'utf8') })), ...appSources.map(({ name, sql }) => ({ file: name, read: () => sql }))];
  const info = { identities: [], fks: [], timestampDefaults: 0 };
  const out = [];
  const errors = [];
  const tables = new Map();
  const indexes = new Set();
  const triggers = [];
  const triggerNames = new Set();
  const skipped = [];
  const renamed = [];
  const patchesUsed = new Set();
  const sourceHash = createHash('sha256');
  // 版の印に入れる指紋。元の移行だけ（migrations/）と、アプリの DDL だけ（APP_DDL_SOURCES）を分けても持つ
  const migrationsHash = createHash('sha256');
  const appHash = createHash('sha256');
  for (const [at, { file, read }] of units.entries()) {
    const src = lf(read());
    sourceHash.update(`${file}\n${src}\n`);
    (at < files.length ? migrationsHash : appHash).update(`${file}\n${src}\n`);
    let statements;
    try { statements = splitStatements(tokenize(src)); } catch (error) { errors.push(`${file}: ${error.message}`); continue; }
    out.push(`\n-- ===== ${file} =====`);
    for (const flat of statements) {
      const head = flat.slice(0, 4).map((t) => up(t)).join(' ');
      try {
        if (head.startsWith('CREATE TRIGGER') || head.startsWith('CREATE TEMP TRIGGER')) {
          const name = flat[up(flat[2]) === 'IF' ? 5 : 2].v;
          const patched = applyPatches(flat, name, patchesUsed);
          const trig = convertTrigger(tree(patched));
          if (triggerNames.has(trig.name)) {
            if (/^CREATE TRIGGER IF NOT EXISTS/.test(head + ' ' + up(flat[4]))) { skipped.push(`トリガー ${trig.name}（IF NOT EXISTS・作成済み）`); continue; }
            throw new ConvertError(`トリガー ${trig.name} が2回作られる`);
          }
          triggerNames.add(trig.name);
          triggers.push(trig);
          out.push(trig.sql);
        } else if (head.startsWith('CREATE TABLE')) {
          const table = parseCreateTable(tree(flat));
          if (tables.has(table.name)) {
            if (table.ifNotExists) { skipped.push(`表 ${table.name}（IF NOT EXISTS・作成済み）`); continue; }
            throw new ConvertError(`表 ${table.name} が2回作られる`);
          }
          tables.set(table.name, table);
          out.push(tableDdl(table, info));
        } else if (/^CREATE (UNIQUE )?INDEX/.test(head)) {
          const index = convertIndex(tree(flat));
          if (indexes.has(index.name)) {
            if (index.ifNotExists) { skipped.push(`索引 ${index.name}（IF NOT EXISTS・作成済み）`); continue; }
            throw new ConvertError(`索引 ${index.name} が2回作られる`);
          }
          indexes.add(index.name);
          if (index.pgName !== index.name) renamed.push(`索引の名前を縮めた（63 バイトの上限）: ${index.name} → ${index.pgName}`);
          out.push(index.sql);
        } else if (head.startsWith('INSERT')) {
          out.push(convertInsert(tree(flat)).sql);
        } else {
          throw new ConvertError(`変換しない文: ${render(flat).slice(0, 120)}`);
        }
      } catch (error) {
        if (!(error instanceof ConvertError)) throw error;
        errors.push(`${file}: ${error.message}`);
      }
    }
  }
  for (const patch of SOURCE_PATCHES) if (!patchesUsed.has(patch)) errors.push(`手直し（${patch.trigger}）が使われなかった。移行が変わったので手直しを見直す`);

  // FK は最後に足す（後で作る表を参照するため）
  for (const fk of info.fks) if (!tables.has(fk.ref)) errors.push(`FK の参照先の表 ${fk.ref} が無い（${fk.owner}.${fk.from.join(',')}）`);
  const fkLines = info.fks.map((fk) => `ALTER TABLE ${ident(fk.owner)} ADD FOREIGN KEY (${fk.from.map(ident).join(', ')}) REFERENCES ${ident(fk.ref)}${fk.to ? ` (${fk.to.map(ident).join(', ')})` : ''}${fk.actions ? ` ${fk.actions}` : ''};`);
  const seqLines = identitySetval(info.identities);

  const rejectCount = triggers.filter((t) => t.kind === 'reject').length;
  const sourceSha256 = sourceHash.digest('hex');
  const sql = [
    '-- 生成物。手で直さない。元は migrations/*.sql（SQLite・D1）で、scripts/pg-ddl.mjs が作る（FR-CORE-DATA-017）',
    ...appSources.map(({ name }) => `-- 移行のあとに足したアプリの DDL: ${name}（migrations/ の外で、アプリが CREATE TABLE IF NOT EXISTS で作る表）`),
    `-- 元の移行の指紋: sha256 ${sourceSha256}`,
    `-- 表 ${tables.size}・索引 ${indexes.size}・トリガー ${triggers.length}（共通の関数 ${rejectCount}・PL/pgSQL の関数 ${triggers.length - rejectCount}）・FK ${info.fks.length}・IDENTITY ${info.identities.length}`,
    ...SOURCE_PATCHES.map((p) => `-- 手直し: ${p.trigger} — ${p.why}`),
    ...skipped.map((s) => `-- 作らなかったもの: ${s}`),
    ...renamed.map((s) => `-- ${s}`),
    '',
    'SET check_function_bodies = on;',
    '',
    HELPERS_SQL,
    ...out,
    '',
    '-- ===== 外部キー（表をすべて作ってから足す） =====',
    ...fkLines,
    '',
    '-- ===== IDENTITY の次の値（ID を指定して入れた初期データのあと） =====',
    ...seqLines,
    '',
  ].join('\n');
  const fingerprint = {
    generator: GENERATOR_VERSION,
    sourceSha256,
    migrationsSha256: migrationsHash.digest('hex'),
    appDdlSha256: appHash.digest('hex'),
    ddlSha256: createHash('sha256').update(sql).digest('hex'),
    lastMigration: files.at(-1) ?? '',
    expected: {
      tables: tables.size,
      triggers: triggers.length,
      functions: helperFunctionCount + (triggers.length - rejectCount),
      identities: info.identities.length,
      foreignKeys: info.fks.length,
      indexes: indexes.size,
    },
  };
  const fingerprintLines = fingerprintSql(fingerprint);
  const statements = [HELPERS_SQL, ...out.filter((x) => !x.startsWith('\n-- ')), ...fkLines, seqLines.join('\n'), fingerprintLines.filter((x) => !x.startsWith('--')).join('\n')];
  return {
    sql: [sql, ...fingerprintLines, ''].join('\n'), statements, errors, tables: [...tables.keys()], tableDefs: tables, triggers, identities: info.identities, fkCount: info.fks.length,
    indexCount: indexes.size, timestampDefaults: info.timestampDefaults, skipped, fingerprint,
  };
}

// HELPERS_SQL が作る関数の数（版の印の期待する関数の数は、これとトリガーごとの PL/pgSQL の関数の数の和）
const helperFunctionCount = (HELPERS_SQL.match(/^CREATE FUNCTION /gm) ?? []).length;

// 版の印の表（PostgreSQL だけ。D1・SQLite には無い）。1行だけ持つ（singleton の CHECK）。印より前の DDL がすべて通ったあとに入るので、
// 行があれば DDL は最後まで当たっている
function fingerprintSql(f) {
  const table = ident(PG_FINGERPRINT_TABLE);
  const e = f.expected;
  return [
    '-- ===== 版の印（PostgreSQL だけの表。D1・SQLite には無い。pg/verify-catalog.sql が読む。src/data-platform/pg-fingerprint.mjs） =====',
    '-- source_sha256 は上の「元の移行の指紋」、ddl_sha256 はこの節より前の生成物（このファイルの先頭から、この節の前の空行の手前まで）の sha256。test/pg-catalog.test.mjs が確かめる',
    `CREATE TABLE ${table} (`,
    '  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),',
    '  generator text COLLATE "C" NOT NULL,',
    '  source_sha256 text COLLATE "C" NOT NULL,',
    '  migrations_sha256 text COLLATE "C" NOT NULL,',
    '  app_ddl_sha256 text COLLATE "C" NOT NULL,',
    '  ddl_sha256 text COLLATE "C" NOT NULL,',
    '  last_migration text COLLATE "C" NOT NULL,',
    '  expected_tables bigint NOT NULL,',
    '  expected_triggers bigint NOT NULL,',
    '  expected_functions bigint NOT NULL,',
    '  expected_identities bigint NOT NULL,',
    '  expected_foreign_keys bigint NOT NULL,',
    '  expected_indexes bigint NOT NULL',
    ');',
    `INSERT INTO ${table} (generator, source_sha256, migrations_sha256, app_ddl_sha256, ddl_sha256, last_migration, expected_tables, expected_triggers, expected_functions, expected_identities, expected_foreign_keys, expected_indexes)`,
    `  VALUES (${[f.generator, f.sourceSha256, f.migrationsSha256, f.appDdlSha256, f.ddlSha256, f.lastMigration].map(quoteLiteral).join(', ')}, ${[e.tables, e.triggers, e.functions, e.identities, e.foreignKeys, e.indexes].join(', ')});`,
  ];
}

// pg/reconcile.sql。表ごとに1行（並びの番号・表の名前・件数・金額の列の合計を「列=合計」で ; につないだ文字）を出す1つの SELECT。
// SQLite（D1）と PostgreSQL の両方で同じ結果になる書き方にする（|| と CAST(… AS TEXT)・COALESCE(SUM(…), 0)・UNION ALL。並びは ord の列）。
// 表ごとに1つの SELECT にするので、UNION ALL の数は表の数（SQLite の既定の上限 500 より少ない）。表は名前の符号の順（COLLATE "C" と同じ）
export function reconcileSql({ tableDefs }) {
  const names = [...tableDefs.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let moneyColumns = 0;
  const parts = names.map((name, at) => {
    const money = tableDefs.get(name).columns.filter((c) => pgType(c.declared) === 'bigint' && RECONCILE_MONEY_COLUMN.test(c.name)).map((c) => c.name);
    moneyColumns += money.length;
    const sums = money.length
      ? money.map((c, i) => `${i ? "';' || " : ''}${quoteLiteral(`${c}=`)} || CAST(COALESCE(SUM(${ident(c)}), 0) AS TEXT)`).join(' || ')
      : "''";
    return `SELECT ${at + 1} AS ord, ${quoteLiteral(name)} AS table_name, COUNT(*) AS row_count, ${sums} AS money_sums FROM ${ident(name)}`;
  });
  return [
    '-- 生成物。手で直さない。scripts/pg-ddl.mjs が migrations/ と APP_DDL_SOURCES の表から作る（香盤表 #27。切り替えの照合 FR-CORE-DATA-045）',
    '-- 表ごとの件数と、金額の列（整数の列で、名前の終わりが yen・amount・tax・price・fee・total・cost・budget）の合計だけを出す。値の行は出さない',
    '-- SQLite（D1）と PostgreSQL の両方で同じ結果になる（両方に流して、行ごとに比べる）。PostgreSQL だけの版の印の表は入れない',
    `-- 表 ${names.length}・金額の列 ${moneyColumns}`,
    `${parts.join('\nUNION ALL ')}\nORDER BY ord;`,
    '',
  ].join('\n');
}

const identitySetval = (identities) => ['DO $seq$', 'BEGIN', ...identities.map(({ table, column }) => `  PERFORM setval(pg_get_serial_sequence(${quoteLiteral(ident(table))}, ${quoteLiteral(column)}), COALESCE(MAX(${ident(column)}), 0) + 1, false) FROM ${ident(table)};`), 'END', '$seq$;'];

// src/*.sql（LocalDatabase が流す順）の INSERT を PostgreSQL の文にする（pg/local-seed.sql）。トリガーの中の INSERT は対象外
export function convertLocalSeed({ srcDir = resolve(app, 'src'), sources = LOCAL_SEED_SOURCES, identities = convertMigrations().identities } = {}) {
  const out = [];
  const errors = [];
  const tables = new Set();
  const sourceHash = createHash('sha256');
  for (const file of sources) {
    const src = lf(readFileSync(resolve(srcDir, file), 'utf8'));
    sourceHash.update(`${file}\n${src}\n`);
    let statements;
    try { statements = splitStatements(tokenize(src)); } catch (error) { errors.push(`src/${file}: ${error.message}`); continue; }
    const inserts = statements.filter((flat) => up(flat[0]) === 'INSERT');
    if (!inserts.length) continue;
    out.push(`\n-- ===== src/${file} =====`);
    for (let flat of inserts) {
      try {
        // 末尾の ON CONFLICT(…) DO NOTHING は外す（どの文にも ON CONFLICT DO NOTHING を付けるため）。DO UPDATE は変換しない
        const at = flat.findIndex((tok, i) => up(tok) === 'ON' && up(flat[i + 1]) === 'CONFLICT');
        if (at >= 0) {
          if (flat.slice(-2).map(up).join(' ') !== 'DO NOTHING') throw new ConvertError(`ON CONFLICT は DO NOTHING だけを変換する（${render(flat).slice(0, 80)}）`);
          flat = flat.slice(0, at);
        }
        const converted = convertInsert(tree(flat), { alwaysIgnore: true });
        tables.add(converted.table);
        out.push(converted.sql);
      } catch (error) {
        if (!(error instanceof ConvertError)) throw error;
        errors.push(`src/${file}: ${error.message}`);
      }
    }
  }
  const sql = [
    '-- 生成物。手で直さない。元は src/*.sql の INSERT（手元の SQLite の LocalDatabase が入れる試作・初期の行）で、scripts/pg-ddl.mjs が作る',
    '-- 試験の DB（test/test-db.mjs）の土台で、pg/schema.sql のあとに当てる。本番には当てない',
    `-- 元の指紋: sha256 ${sourceHash.digest('hex')}`,
    `-- 表 ${tables.size}・文 ${out.filter((x) => !x.startsWith('\n-- ')).length}`,
    ...out,
    '',
    '-- ===== IDENTITY の次の値（ID を指定して入れた行のあと） =====',
    ...identitySetval(identities),
    '',
  ].join('\n');
  return { sql, errors, tables: [...tables] };
}

function main() {
  const check = process.argv.includes('--check');
  const result = convertMigrations();
  const seed = result.errors.length ? { errors: [] } : convertLocalSeed({ identities: result.identities });
  const errors = [...result.errors, ...seed.errors];
  if (errors.length) {
    console.error(`変換できないものが ${errors.length} 件ある（pg/schema.sql・pg/local-seed.sql は書いていない）:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const reconcile = reconcileSql(result);
  const outputs = [[OUTPUT_PATH, result.sql, 'pg/schema.sql', 'migrations/'], [SEED_PATH, seed.sql, 'pg/local-seed.sql', 'src/*.sql の INSERT'], [RECONCILE_PATH, reconcile, 'pg/reconcile.sql', 'migrations/']];
  if (check) {
    let failed = false;
    for (const [path, generated, name, from] of outputs) {
      let current = '';
      try { current = readFileSync(path, 'utf8'); } catch { /* 無ければ違う */ }
      if (lf(current) !== generated) {
        console.error(`${name} が ${from} から生成したものと違う。node scripts/pg-ddl.mjs で作り直す`);
        failed = true;
      } else {
        console.log(`${name} は ${from} から生成したものと一致する`);
      }
    }
    if (failed) process.exit(1);
    return;
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, result.sql);
  writeFileSync(SEED_PATH, seed.sql);
  writeFileSync(RECONCILE_PATH, reconcile);
  console.log(`pg/schema.sql を書いた（表 ${result.tables.length}・トリガー ${result.triggers.length}・FK ${result.fkCount}・索引 ${result.indexCount}）`);
  console.log(`pg/local-seed.sql を書いた（表 ${seed.tables.length}）`);
  console.log(`pg/reconcile.sql を書いた（表 ${result.tables.length}）`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
