// PostgreSQL の入口（PG 計画 段1・香盤表 #8。FR-CORE-DATA-003〜007・009・012〜015・022・051）。
// LocalDatabase（src/db.mjs）・D1Database（src/d1-db.mjs）と同じ all・get・run・batch・readBatch を持つ。
// pg（node-postgres）の Pool か接続済みの Client を外から受け取る。接続文字列はこのファイルにも設定にも書かない（D-005・FR-CORE-DATA-033）。
// Worker でも動く（node:* と pg を import しない。Hyperdrive では呼ぶ側が pg の Client を作って渡す）。
//
// - アプリの SQL の `?` を `$1`・`$2`… に変える（文字列・識別子・コメントの中の ? は変えない）
// - batch は1つのトランザクション（BEGIN〜COMMIT、失敗で ROLLBACK）。文の数の上限を持ち込まない（FR-CORE-DATA-007）
// - readBatch は READ ONLY・REPEATABLE READ のトランザクションで、複数の読み取りを1つの時点で返す（FR-CORE-DATA-009）
// - 返す値の型は SQLite の入口にそろえる（下の parseValue。FR-CORE-DATA-012・013・051）
// - エラーには共通のエラーの種類（src/data-platform/db-errors.mjs）を付ける（FR-CORE-DATA-015）
// - ID を指定して入れた行のあと、順番の値（IDENTITY）を進める（FR-CORE-DATA-022。記録 2026-10-03-pg-ddl-feasibility の違い2）
// - 書き込みの文の値の置き場所（SET・VALUES・SELECT の並び）に小数になる式（小数の定数・avg・total・AS REAL など）があれば止める
//   （bigint の列へ黙って丸めて入るため。同じ記録の違い3）。WHERE などの条件の中の小数は止めない
// - CAST(… AS REAL) は double precision に読み替える（SQLite の REAL は倍精度。PostgreSQL の REAL は float4 で 16777217 が丸まる）
// - SQLite の関数を、同じ値を返す補助の関数（pg/schema.sql の lite_*）に読み替える。対応は DDL の変換と同じ表（./lite-sql.mjs）から読む
//   （json_extract・json_each・json_valid・json_type・json_array_length、CAST(… AS INTEGER)、CURRENT_TIMESTAMP、x IS ?。FR-CORE-DATA-025）。
//   INSERT INTO 表(列…) SELECT … の値がそのまま json_extract(…) のときは、入れる先の列の型へ CAST する（SQLite は列の型へ自動で直すが、
//   PostgreSQL は text の値を bigint などの列へ入れない）
import {DbError, attachDbError} from './db-errors.mjs';
import {INTEGER_TYPES, LITE_CAST_INT, TIMESTAMP_TEXT, isComparison, liteCall} from './lite-sql.mjs';

// ---------- SQL の文 ----------

// SQL を、値の置き場所・文字列などの区切りで読む。each(kind, text) を順に呼ぶ（kind: code・string・ident・comment・param）
function scanSql(sql, each) {
  let i = 0;
  let start = 0;
  const flush = (end) => { if (end > start) each('code', sql.slice(start, end)); };
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    let end = -1;
    let kind = null;
    if (ch === "'" || ch === '"' || ch === '`') {
      kind = ch === "'" ? 'string' : 'ident';
      end = i + 1;
      for (;;) {
        const at = sql.indexOf(ch, end);
        if (at < 0) { end = sql.length; break; }
        if (sql[at + 1] === ch) { end = at + 2; continue; }
        end = at + 1;
        break;
      }
    } else if (ch === '-' && next === '-') {
      kind = 'comment';
      const at = sql.indexOf('\n', i);
      end = at < 0 ? sql.length : at;
    } else if (ch === '/' && next === '*') {
      kind = 'comment';
      let depth = 1;
      end = i + 2;
      while (end < sql.length && depth) {
        if (sql[end] === '/' && sql[end + 1] === '*') { depth += 1; end += 2; } else if (sql[end] === '*' && sql[end + 1] === '/') { depth -= 1; end += 2; } else end += 1;
      }
    } else if (ch === '$' && /[A-Za-z_$]/.test(next ?? '') && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$[A-Za-z_]?\w*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        kind = 'string';
        const at = sql.indexOf(tag, i + tag.length);
        end = at < 0 ? sql.length : at + tag.length;
      }
    } else if (ch === '?') {
      kind = 'param';
      end = i + 1;
      while (/\d/.test(sql[end] ?? '')) end += 1;
    }
    if (kind) {
      flush(i);
      each(kind, sql.slice(i, end));
      i = end;
      start = i;
    } else i += 1;
  }
  flush(sql.length);
}

// `?`・`?NNN` → `$n`。文字列・識別子・コメントの中は変えない。文字列などを除いた本文（masked）も返す
export function toPositional(sql) {
  let text = '';
  let masked = '';
  let n = 0;
  scanSql(sql, (kind, part) => {
    if (kind === 'param') {
      const number = part.length > 1 ? Number(part.slice(1)) : (n += 1);
      if (part.length > 1) n = Math.max(n, number);
      text += `$${number}`;
      masked += ` $${number} `;
    } else {
      // SQLite の REAL は倍精度。PostgreSQL の REAL（float4）では 16777217 が 16777216 に丸まるので、CAST の先を double precision にする
      text += kind === 'code' ? part.replace(/\bAS(\s+)REAL\b/gi, 'AS$1double precision') : part;
      masked += kind === 'code' ? part : kind === 'comment' ? ' ' : kind === 'ident' ? ` ${part} ` : " '' ";
    }
  });
  return {text, masked, count: n};
}

// ---------- SQLite の関数を補助の関数へ読み替える ----------

// SQL を字句に分ける。文字列・識別子・コメント・値の置き場所は1つの字句のまま（中を読み替えない）。字句をつなぐと元の SQL に戻る
const CODE_TOKEN = /\s+|[A-Za-z_][\w$]*|\d+|[(),.]|[^\s\w(),.]+/g;
const codeKind = (part) => (/^\s/.test(part) ? 'space' : /^[A-Za-z_]/.test(part) ? 'word' : part === '(' ? 'open' : part === ')' ? 'close' : part === ',' ? 'comma' : 'other');
export function lexSql(sql) {
  const tokens = [];
  scanSql(sql, (kind, text) => {
    if (kind !== 'code') tokens.push({kind, text});
    else for (const [part] of text.matchAll(CODE_TOKEN)) tokens.push({kind: codeKind(part), text: part});
  });
  return tokens;
}
const BLANK = new Set(['space', 'comment']);
const nextAt = (tokens, at) => { let i = at + 1; while (i < tokens.length && BLANK.has(tokens[i].kind)) i += 1; return i; };
const prevAt = (tokens, at) => { let i = at - 1; while (i >= 0 && BLANK.has(tokens[i].kind)) i -= 1; return i; };
const upper = (token) => (token?.kind === 'word' ? token.text.toUpperCase() : null);
// 開き括弧（tokens[open]）に対応する閉じ括弧の位置と、その中の一番外の区切り（,）の位置。閉じていなければ null
function group(tokens, open) {
  const commas = [];
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const {kind} = tokens[i];
    if (kind === 'open') depth += 1;
    else if (kind === 'close') { depth -= 1; if (depth === 0) return {close: i, commas}; }
    else if (kind === 'comma' && depth === 1) commas.push(i);
  }
  return null;
}
const depthBetween = (tokens, from, to) => tokens.slice(from, to).reduce((d, t) => d + (t.kind === 'open') - (t.kind === 'close'), 0);

// アプリの SQL（SQLite の形）を PostgreSQL の補助の関数の形へ読み替える。返り値の tokens は読み替えたあとの字句
export function rewriteLite(sql) {
  const tokens = lexSql(sql);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'word' || tokens[prevAt(tokens, i)]?.text === '.') continue; // 表の名前つきの列（j.value など）は読み替えない
    const word = token.text.toUpperCase();
    if (word === 'IS') {
      // x IS ? → x IS NOT DISTINCT FROM ?、x IS NOT ? → x IS DISTINCT FROM ?（NULL・TRUE などの決まった語はそのまま）
      const not = nextAt(tokens, i);
      const negated = upper(tokens[not]) === 'NOT';
      const after = tokens[negated ? nextAt(tokens, not) : not];
      // ? IS NULL・? IS NOT NULL は、PostgreSQL が値の置き場所の型を決められない（could not determine data type of parameter）。
      // NULL かどうかは型によらないので text にする（src/tax.mjs の (? IS NULL OR partner_id=? …)）
      const before = tokens[prevAt(tokens, i)];
      if (before?.kind === 'param' && upper(after) === 'NULL') before.text = `CAST(${before.text} AS text)`;
      if (after && !(after.kind === 'word' && !isComparison(after.text))) {
        token.text = negated ? 'IS DISTINCT FROM' : 'IS NOT DISTINCT FROM';
        if (negated) tokens[not].text = '';
      }
      continue;
    }
    const open = nextAt(tokens, i);
    const paren = tokens[open]?.kind === 'open' ? group(tokens, open) : null;
    if (word === 'CURRENT_TIMESTAMP') {
      if (!paren) token.text = TIMESTAMP_TEXT;
      continue;
    }
    if (!paren) continue;
    if (word === 'CAST') {
      // CAST(x AS INTEGER) → lite_cast_int(x)。AS と型は CAST の括弧のすぐ内側にあるものだけ
      const type = prevAt(tokens, paren.close);
      const as = prevAt(tokens, type);
      if (INTEGER_TYPES.includes(upper(tokens[type])) && upper(tokens[as]) === 'AS' && as > open && depthBetween(tokens, open + 1, as) === 0) {
        token.text = LITE_CAST_INT;
        for (let k = prevAt(tokens, as) + 1; k < paren.close; k += 1) tokens[k].text = '';
      }
      continue;
    }
    const count = nextAt(tokens, open) === paren.close ? 0 : paren.commas.length + 1;
    const call = liteCall(token.text, Array.from({length: count}, () => ''));
    if (!call) continue;
    token.text = call.name;
    if (call.added.length) tokens[paren.close].text = `, ${call.added.join(', ')})`;
  }
  return {text: tokens.map((t) => t.text).join(''), tokens};
}

// INSERT INTO 表(列…) SELECT … の並びのうち、値がそのまま lite_json_extract(…) のもの（入れる先の列と、字句の始まり・終わり）。
// 無ければ null。並びの数が列の数と合わない文・SELECT DISTINCT などは見ない
const SELECT_END = new Set(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'ON', 'RETURNING', 'WINDOW']);
const nameOf = (token) => (token.kind === 'ident' ? token.text.slice(1, -1).replaceAll(token.text[0].repeat(2), token.text[0]) : token.text.toLowerCase());
export function jsonInsertItems(tokens) {
  let at = nextAt(tokens, -1);
  if (upper(tokens[at]) !== 'INSERT') return null;
  at = nextAt(tokens, at);
  if (upper(tokens[at]) !== 'INTO') return null;
  at = nextAt(tokens, at);
  let table = tokens[at];
  let next = nextAt(tokens, at);
  while (tokens[next]?.text === '.') { at = nextAt(tokens, next); table = tokens[at]; next = nextAt(tokens, at); }
  if (!table || !['word', 'ident'].includes(table.kind) || tokens[next]?.kind !== 'open') return null;
  const list = group(tokens, next);
  if (!list) return null;
  const columns = [next, ...list.commas].map((cut) => tokens[nextAt(tokens, cut)]).map((token) => (token && ['word', 'ident'].includes(token.kind) ? nameOf(token) : null));
  const select = nextAt(tokens, list.close);
  if (upper(tokens[select]) !== 'SELECT' || ['DISTINCT', 'ALL'].includes(upper(tokens[nextAt(tokens, select)]))) return null;
  const cuts = [select];
  let end = tokens.length;
  let depth = 0;
  for (let k = select + 1; k < tokens.length; k += 1) {
    const {kind} = tokens[k];
    if (kind === 'open') depth += 1;
    else if (kind === 'close') depth -= 1;
    else if (depth === 0 && kind === 'comma') cuts.push(k);
    else if (depth === 0 && SELECT_END.has(upper(tokens[k]))) { end = k; break; }
  }
  cuts.push(end);
  if (cuts.length - 1 !== columns.length) return null;
  const items = [];
  for (let m = 0; m < columns.length; m += 1) {
    const first = nextAt(tokens, cuts[m]);
    const last = prevAt(tokens, cuts[m + 1]);
    const open = nextAt(tokens, first);
    if (columns[m] && tokens[first]?.text === 'lite_json_extract' && tokens[open]?.kind === 'open' && group(tokens, open)?.close === last) items.push({column: columns[m], first, last});
  }
  return items.length ? {table: nameOf(table), items} : null;
}

// 書き込みの文（INSERT・UPDATE）の、値の置き場所にある小数になる式（1.5・.5・1e3 の定数、avg(・total(、AS REAL などの CAST）。
// 値の置き場所は SET・VALUES・SELECT の並び（と CASE の THEN・ELSE）で、WHERE・HAVING・ON・WHEN などの条件の中は数えない。
// 括弧の中は外の状態を引き継ぎ、条件の中の副問い合わせの SELECT は値にしない。FROM の中の副問い合わせ（INSERT … SELECT の元）は値に数える
const WRITE = /\b(?:INSERT|UPDATE)\b/i;
const SQL_TOKEN = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_][\w$]*|\$\d+|[()]|[^\s\w()]/g;
const VALUE_WORDS = new Set(['SET', 'VALUES', 'SELECT', 'THEN', 'ELSE']);
const COND_WORDS = new Set(['WHERE', 'HAVING', 'ON', 'WHEN', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'RETURNING', 'USING', 'CONFLICT', 'INTO', 'UPDATE', 'INSERT', 'DELETE', 'WINDOW']);
const SOURCE_WORDS = new Set(['FROM', 'JOIN']);
const FLOAT_TYPES = new Set(['REAL', 'FLOAT', 'DOUBLE', 'NUMERIC', 'DECIMAL']);
export function floatInWrite(masked) {
  if (!WRITE.test(masked)) return null;
  const tokens = masked.match(SQL_TOKEN) || [];
  const stack = [];
  let state = 'cond';
  let allow = true; // この括弧の中で SELECT などを値として読むか
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '(') { stack.push({state, allow}); allow = state !== 'cond'; continue; }
    if (token === ')') { ({state, allow} = stack.pop() ?? {state, allow}); continue; }
    if (/^\.?\d/.test(token)) {
      if (state === 'value' && /[.eE]/.test(token)) return token;
      continue;
    }
    const word = token.toUpperCase();
    if (VALUE_WORDS.has(word)) state = allow ? 'value' : 'cond';
    else if (SOURCE_WORDS.has(word)) state = allow ? 'source' : 'cond';
    else if (COND_WORDS.has(word)) state = 'cond';
    else if (state === 'value' && (word === 'AVG' || word === 'TOTAL') && tokens[i + 1] === '(') return `${token}(`;
    else if (state === 'value' && word === 'AS' && FLOAT_TYPES.has(tokens[i + 1]?.toUpperCase())) return `AS ${tokens[i + 1]}`;
  }
  return null;
}

// 読み取りの一括（readBatch）に渡してよい文か。SELECT・WITH・VALUES で始まり、本文に書き込み（INSERT・REPLACE・UPDATE … SET・DELETE FROM）が無いこと。
// 書き込みがあれば、その言葉を返す（無ければ null）。SQLite（node:sqlite・D1）は読み取りのトランザクションでも書き込みを通すので、
// 入口が先に断る（PostgreSQL は READ ONLY のトランザクションが 25006 で断る。どれも共通のエラーの種類 read_only になる）
const READ_START = /^\s*(?:SELECT|WITH|VALUES)\b/i;
const WRITE_WORD = /\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\b|\bUPDATE\s+(?:OR\s+\w+\s+)?[\w."]+\s+SET\b|\bDELETE\s+FROM\b/i;
export function writeInReadBatch(sql) {
  const {masked} = toPositional(sql);
  if (!READ_START.test(masked)) return (/^\s*(\w+)/.exec(masked)?.[1] ?? '空の文').toUpperCase();
  return WRITE_WORD.exec(masked)?.[0].split(/\s+/)[0].toUpperCase() ?? null;
}
export function assertReadBatch(statements) {
  for (const {sql} of statements) {
    const word = writeInReadBatch(sql);
    if (word) throw new DbError('read_only', `読み取りの一括（readBatch）に書き込みの文（${word}）は入れられません。書き込みは batch で行う`);
  }
}

// INSERT の先の表と列の並び（本文から読む）。列の並びが無ければ columns は null（全部の列を入れる）
export function insertTarget(masked) {
  const m = /\bINSERT\s+INTO\s+("(?:[^"]|"")+"|[A-Za-z_][\w.]*)(?:\s+AS\s+\w+)?\s*(\(([^()]*)\))?(\s*DEFAULT\s+VALUES)?/i.exec(masked);
  if (!m) return null;
  const unquote = (name) => (name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase());
  const table = unquote(m[1].includes('.') && !m[1].startsWith('"') ? m[1].slice(m[1].lastIndexOf('.') + 1) : m[1]);
  if (m[4]) return {table, columns: []};
  return {table, columns: m[3] === undefined ? null : m[3].split(',').map((name) => unquote(name.trim())).filter(Boolean)};
}

// ---------- 値の型（SQLite の入口にそろえる） ----------

const OID = {bool: 16, bytea: 17, int8: 20, int2: 21, int4: 23, oid: 26, json: 114, float4: 700, float8: 701, date: 1082, numeric: 1700, jsonb: 3802};
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
// 配列の型の OID（pg_type の typarray。bool・bytea・char・name・int8・int2・int2vector・int4・text・oid・json・xml・float4・float8・
// varchar・bpchar・date・time・timestamp・timestamptz・interval・numeric・uuid・jsonb）
const ARRAY_OIDS = new Set([1000, 1001, 1002, 1003, 1016, 1005, 1006, 1007, 1009, 1028, 199, 143, 1021, 1022, 1015, 1014, 1182, 1183, 1115, 1185, 1187, 1231, 2951, 3807]);

function safeInteger(text, field) {
  const big = BigInt(text);
  if (big > MAX_SAFE || big < -MAX_SAFE) {
    throw new DbError('out_of_range', `${field.name} の値 ${text} は安全な整数（±${Number.MAX_SAFE_INTEGER}）を超えるため、丸めずに止めました`, {columns: [field.name]});
  }
  return Number(big);
}

function hexBytes(text) {
  const hex = text.startsWith('\\x') ? text.slice(2) : text;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// 1つの値（PostgreSQL の文字の形）→ アプリへ返す値
// - bigint・count: 安全な整数の Number。超えたら止める（FR-CORE-DATA-012）
// - numeric の列の値: Decimal の文字列のまま（FR-CORE-DATA-013）
// - 計算した numeric（表の列でないもの。bigint の sum など）: 小数点の無い値は安全な整数の Number（超えたら止める）、
//   小数点のある値（avg・numeric の列の sum など）は Decimal の文字列。PostgreSQL は式の型で桁を決める（bigint の sum はいつも小数点が無い）
// - boolean: 0/1 の Number。date: 'YYYY-MM-DD' の文字列。json・jsonb: JSON の文字列（FR-CORE-DATA-051）
export function parseValue(text, field) {
  if (text === null || text === undefined) return null;
  switch (field.dataTypeID) {
    case OID.int8: return safeInteger(text, field);
    case OID.int2: case OID.int4: case OID.oid: return Number(text);
    case OID.float4: case OID.float8: return Number(text);
    case OID.numeric: return !field.tableID && /^-?\d+$/.test(text) ? safeInteger(text, field) : text;
    case OID.bool: return text === 't' || text === 'true' ? 1 : 0;
    case OID.bytea: return hexBytes(text);
    default:
      // 配列は SQLite に無い型で、要素の型（bigint の範囲など）を確かめられないので止める（'{9007199254740993}' を生の文字で返さない）
      if (ARRAY_OIDS.has(field.dataTypeID)) {
        throw new DbError('unsupported_type', `${field.name} は配列の型（OID ${field.dataTypeID}）です。SQLite の入口に無い型なので返せません。配列にせず行で返す`, {columns: [field.name]});
      }
      return text; // text・date・json・jsonb・timestamp など（文字の形のまま）
  }
}

const RAW_TYPES = {getTypeParser: () => (value) => value};

// 行は列の番号で読む（rowMode: 'array'）。同じ名前の列が2つあるとき（x.* と別の表の列を結ぶ問い合わせなど）、
// 名前で読むと最初の列の型で最後の列の値を読んでしまう。列ごとにその列の型で読み、同じ名前は後の列の値を残す（SQLite と同じ）
function rowsOf(result, names = null) {
  const fields = result.fields || [];
  const keys = fields.map((field) => names?.get(field.name) ?? field.name);
  return (result.rows || []).map((raw) => {
    const row = {};
    for (let index = 0; index < fields.length; index += 1) row[keys[index]] = parseValue(raw[index], fields[index]);
    return row;
  });
}

// 列の名前の大文字・小文字。SQLite は別名（EXISTS(…) isSuperseded・AS N）を書いたとおりの名前で返すが、PostgreSQL は引用符の無い名前を
// 小文字にして返す（issuperseded）。SQL の本文（文字列・コメント・引用符つきの名前を除く）に大文字を含む書き方が1通りだけある名前は、
// 返す行の名前をその書き方に戻す（src/mg.mjs の /api/mg/ledger の isSuperseded）。同じ名前を小文字でも書いている文（AS count … COUNT(*)）は戻さない。
// 表と列の名前は小文字だけ（scripts/pg-ddl.mjs が大文字の名前を断る）なので、戻るのは別名と、別名と同じ綴りの書き方だけ
const UNQUOTED_WORD = /(?<![\w$"])[A-Za-z_][\w$]*(?![\w$"])/g;
export function columnSpellings(masked) {
  const spellings = new Map();
  for (const [word] of masked.matchAll(UNQUOTED_WORD)) {
    const lower = word.toLowerCase();
    if (!spellings.has(lower)) spellings.set(lower, new Set());
    spellings.get(lower).add(word);
  }
  const names = new Map();
  for (const [lower, set] of spellings) if (set.size === 1 && !set.has(lower)) names.set(lower, [...set][0]);
  return names.size ? names : null;
}

// サーバー（PostgreSQL）が返したエラーと、入口が自分で止めたエラー。これ以外（接続の切断など）は接続の誤りとみる
const serverError = (error) => error instanceof DbError || (Boolean(error) && typeof error === 'object' && typeof error.severity === 'string');

// アプリの値 → pg に渡す値。BigInt は文字に、真偽は 0/1 に（D1 と同じ）
const prepareParam = (value) => (typeof value === 'bigint' ? value.toString() : typeof value === 'boolean' ? (value ? 1 : 0) : value);

// ---------- 入口 ----------

const TX_WRITE = 'BEGIN';
const TX_READ = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;
// 文字の列（json_extract の値をそのまま入れてよい列）
const TEXT_TYPES = new Set(['text', 'character varying', 'character']);

// 入口をまたいで共有する控え。I/O（接続・Promise）を持たない値だけを入れる（Worker は要求をまたいで I/O の物を共有できない）。
// statements: SQL → 読み替えた文。catalog: information_schema から読んだ IDENTITY の列と列の型（スキーマを替えたら作り直す）
export function createPgSharedCache() {
  return {statements: new Map(), catalog: {identities: null, types: null}};
}

export class PgDatabase {
  // DB の種類の印。SQLite の入口（LocalDatabase・D1Database）には無い。カタログの読み方を分ける所（src/admin/er-routes.mjs）が見る
  get dialect() { return 'postgres'; }

  // queryable: pg の Pool（connect で接続を借りる）か、接続済みの Client（文を1つずつ順に流す）。
  // shared: 入口をまたいで使い回す控え（createPgSharedCache）。Worker では要求ごとに Client と入口を作るので、文の読み替えと
  // IDENTITY の列・列の型の読み取りを、モジュールが持つ控えで要求をまたいで共有する（src/data-platform/cloud-db.mjs）。省くと入口ごとに持つ
  constructor(queryable, {cacheSize = 1000, shared = null} = {}) {
    if (!queryable || typeof queryable.query !== 'function') throw new Error('PgDatabase には pg の Pool か Client を渡す');
    if (shared && !(shared.statements instanceof Map && shared.catalog && typeof shared.catalog === 'object')) throw new Error('PgDatabase の shared には createPgSharedCache() の値を渡す');
    const memo = shared ?? createPgSharedCache();
    this.queryable = queryable;
    this.isPool = typeof queryable.connect === 'function' && 'totalCount' in queryable;
    this.cache = memo.statements;
    this.catalog = memo.catalog;
    this.cacheSize = cacheSize;
    this.lock = Promise.resolve();
  }

  // IDENTITY の列（表 → 列）と列の型（表 → 列 → 型）。控え（shared.catalog）に置く
  get identities() { return this.catalog.identities; }
  set identities(value) { this.catalog.identities = value; }
  get types() { return this.catalog.types; }
  set types(value) { this.catalog.types = value; }

  statement(sql) {
    let found = this.cache.get(sql);
    if (!found) {
      const lite = rewriteLite(sql);
      found = toPositional(lite.text);
      // 値がそのまま json_extract の INSERT … SELECT は、列の型を読んでから文を作る（typedText）
      const json = jsonInsertItems(lite.tokens);
      if (json) found.json = {...json, tokens: lite.tokens.map((t) => t.text), text: null};
      found.write = WRITE.test(found.masked);
      found.decimal = floatInWrite(found.masked);
      found.insert = insertTarget(found.masked);
      found.names = columnSpellings(found.masked);
      if (this.cache.size >= this.cacheSize) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(sql, found);
    }
    return found;
  }

  // 1つの接続で fn(client, discard) を流す。Pool は接続を借り、Client は順番待ちにする（トランザクションの途中に別の文を混ぜない）。
  // Pool の接続は、接続の誤り（サーバーが返したエラーでないもの）か、fn が discard(error) を呼んだとき（ROLLBACK の失敗など）に
  // release(error) で捨てる。壊れた接続や、トランザクションの途中の接続を Pool に戻さない
  async withConnection(fn) {
    if (this.isPool) {
      const client = await this.queryable.connect();
      let broken = null;
      const discard = (error) => { broken = error || new Error('PgDatabase: 接続を捨てる'); };
      try {
        return await fn(client, discard);
      } catch (error) {
        if (!serverError(error)) discard(error);
        throw error;
      } finally {
        if (broken) client.release(broken); else client.release();
      }
    }
    const run = this.lock.then(() => fn(this.queryable, () => {}));
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async identityColumns(client) {
    if (!this.identities) {
      const result = await client.query({text: "SELECT table_name, column_name FROM information_schema.columns WHERE is_identity = 'YES' AND table_schema = current_schema()", types: RAW_TYPES});
      this.identities = new Map(result.rows.map((row) => [row.table_name, row.column_name]));
    }
    return this.identities;
  }

  // 表ごとの列の型（文字の名前。information_schema の data_type、型を作ったものは udt_name）
  async columnTypes(client) {
    if (!this.types) {
      const result = await client.query({text: "SELECT table_name, column_name, CASE WHEN data_type = 'USER-DEFINED' THEN udt_name ELSE data_type END AS type FROM information_schema.columns WHERE table_schema = current_schema()", types: RAW_TYPES});
      this.types = new Map();
      for (const row of result.rows) {
        if (!this.types.has(row.table_name)) this.types.set(row.table_name, new Map());
        this.types.get(row.table_name).set(row.column_name, row.type);
      }
    }
    return this.types;
  }

  // INSERT INTO 表(列…) SELECT json_extract(…) の文を、文字でない列の値を CAST(… AS 列の型) にして作る。
  // SQLite は列の型へ自動で直す（'12' は 12）。PostgreSQL は text の値を bigint などの列へ入れないので、同じ直し方を CAST で書く。
  // 直せない値（'1.5' を bigint へ）は PostgreSQL が 22P02 で断る（共通のエラーの種類は check。SQLite では typeof の CHECK が断る）
  async typedText(client, found) {
    if (found.json.text === null) {
      const types = (await this.columnTypes(client)).get(found.json.table);
      const texts = [...found.json.tokens];
      for (const {column, first, last} of found.json.items) {
        const type = types?.get(column);
        if (!type || TEXT_TYPES.has(type) || type === 'ARRAY') continue;
        texts[first] = `CAST(${texts[first]}`;
        texts[last] = `${texts[last]} AS ${type})`;
      }
      found.json.text = toPositional(texts.join('')).text;
    }
    return found.json.text;
  }

  // ID を指定して入れた INSERT のあと、順番の値を表の最大の ID まで進める（下げない）
  async advanceIdentity(client, insert) {
    if (!insert) return;
    const column = (await this.identityColumns(client)).get(insert.table);
    if (!column || (insert.columns && !insert.columns.includes(column))) return;
    const table = quoteIdent(insert.table);
    await client.query({
      text: `SELECT setval(s.seq, x.m) FROM (SELECT pg_get_serial_sequence($1, $2)::regclass AS seq) s, LATERAL (SELECT max(${quoteIdent(column)}) AS m FROM ${table}) x
        WHERE x.m IS NOT NULL AND x.m > COALESCE(pg_sequence_last_value(s.seq), 0)`,
      values: [table, column],
      types: RAW_TYPES,
    });
  }

  async execute(client, sql, params = []) {
    const found = this.statement(sql);
    if (found.decimal) {
      throw new DbError('check', `書き込みの文の値に小数になる式 ${found.decimal} があります。PostgreSQL は bigint の列へ黙って丸めて入れるので、整数の値をパラメータで渡す（money.md・dialect.md）`);
    }
    try {
      const text = found.json ? await this.typedText(client, found) : found.text;
      const result = await client.query({text, values: params.map(prepareParam), types: RAW_TYPES, rowMode: 'array'});
      if (found.insert) await this.advanceIdentity(client, found.insert);
      return {rows: rowsOf(result, found.names), changes: Number(result.rowCount || 0)};
    } catch (error) {
      throw attachDbError(error, {inWrite: found.write});
    }
  }

  async single(sql, params) {
    if (this.isPool) {
      const found = this.statement(sql);
      // ID を指定した INSERT は、順番の値を同じ接続で進める
      if (found.insert) return this.withConnection((client) => this.execute(client, sql, params));
      return this.execute(this.queryable, sql, params);
    }
    return this.withConnection((client) => this.execute(client, sql, params));
  }

  async all(sql, params = []) { return (await this.single(sql, params)).rows; }
  async get(sql, params = []) { return (await this.single(sql, params)).rows[0] ?? null; }
  async run(sql, params = []) { return {changes: (await this.single(sql, params)).changes}; }

  async transaction(begin, statements) {
    return this.withConnection(async (client, discard) => {
      try {
        await client.query(begin);
      } catch (error) {
        discard(error); // BEGIN が通らない接続は使わない
        throw attachDbError(error);
      }
      try {
        const out = [];
        for (const {sql, params = []} of statements) out.push(await this.execute(client, sql, params));
        await client.query('COMMIT');
        return out;
      } catch (error) {
        // ROLLBACK が失敗した接続は、トランザクションが閉じたか分からないので捨てる（元のエラーを投げる）
        try { await client.query('ROLLBACK'); } catch (rollbackError) { discard(rollbackError); }
        throw attachDbError(error);
      }
    });
  }

  // 複数の文を1つのトランザクションで書く。全部入るか、何も入らない（D1 の batch と同じ）
  async batch(statements) {
    return (await this.transaction(TX_WRITE, statements)).map(({changes, rows}) => ({changes, rows}));
  }

  // 複数の読み取りを1つの時点で返す（READ ONLY・REPEATABLE READ）。返り値は文ごとの行の配列
  async readBatch(statements) {
    assertReadBatch(statements);
    return (await this.transaction(TX_READ, statements)).map(({rows}) => rows);
  }
}
