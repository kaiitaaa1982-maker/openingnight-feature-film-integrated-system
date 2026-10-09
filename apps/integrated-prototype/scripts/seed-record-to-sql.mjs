#!/usr/bin/env node
// 架空データの記録（scripts/seed-all-demo.mjs --record の JSON Lines）を、本番の D1 に1回で当てられる SQL ファイルに変える。
// 本番へは代表が `wrangler d1 execute <DB> --remote --file <SQL>` で当てる（import の経路。ファイル全体が1つの単位で当たり、
// 途中で落ちると元のままに戻る。2026-09-25 の本番反映で使った）。このスクリプトは Cloudflare に接続しない。手順は req4-integration.md §3。
//
//   node scripts/seed-record-to-sql.mjs --record <記録.jsonl> --out <SQL> [--try <写しの複製.sqlite>] [--compare <記録した写し.sqlite>]
//   node scripts/seed-record-to-sql.mjs --sql <SQL> --try <写しの複製.sqlite> [--compare <記録した写し.sqlite>]
//   node scripts/seed-record-to-sql.mjs --prepare-copy --from <本番の書き出し.sql | SQLite> --out <写し.sqlite> [--applied <0001_initial.sql,…>]
//
// SQL ファイルの形（1文1行。行頭が「-- 」の行は説明で、その下の文が何を確かめるか・どの batch かを書く）:
//   1. 当てる前の確かめ: 記録の見出しの指紋（表の数・表ごとの行数・rowid の別名のある表の最大の rowid・主な表の最大ID・利用者と組織）と
//      当てる先が1つでも違えば、transaction_guards（CHECK(value=1)）に 0 を入れる文が CHECK に反して失敗する
//      （src/sales-ops/distribution-additions.sql と同じ型）。import はファイル全体で1つの単位なので、1文も当たらない。
//      別名の無い表の隠れ rowid は比べない（本番の書き出しから作った写しでは1から振り直される。seed-all-demo.mjs の databaseFingerprint）
//   2. 記録の文。値は SQL の文字として埋め込む（D1 の binding と同じ型・同じ値になるように書く）
//   3. 当てた後の確かめ: 流した後の写しの指紋（見出しの after）と同じ件数・ID になったか。違えば同じく失敗し、1文も当たらない
// 値の書き方: null → NULL、整数（安全な範囲の number・bigint）→ そのまま、ほかの number → 小数点つき（REAL）、真偽 → 1/0、
//   文字 → '…'（' は ''）。制御文字（改行・NUL など U+0000〜U+001F・U+007F）は、その値に無い私用領域の文字（U+E000〜）に置き換えて書き、
//   replace(…, char(私用の文字), char(元の文字)) で戻す（文が1行に収まり、改行の変換や NUL で値が変わらない）。バイナリ → X'…'
//   binding と同じ値になると言えるのは、整数・文字・バイナリ・NULL と普通の大きさの実数（金額・比率。|値| が 1e15 以下で、0 か 1e-6 以上）だけ。
//   範囲の外の実数（指数つきの文字になり、SQLite が読むと最下位の桁がずれることがある）が記録にあれば、ファイルを書かずに止める
// 定義・設定・トランザクションの文と、ログイン（sessions）の書き込みは、コメントを外した文で見分けて止める（先頭のコメントで見逃さない）。
// D1 の1文の上限（100,000 バイト）以上の文があれば、ファイルを書かずに止める。BEGIN・COMMIT・PRAGMA は書かない（import が1つの単位で当てる）。
// 本番の DB 部品が R2 に置く値（原本・抽出結果の列、128KB を超える値）を書く文があっても止める（SQL ファイルは D1 にしか書けない）。
//   本番の DEMO-SALES では、原本を書く売上・制作の節は入れ済みで記録に入らない（2026-09-27 の本番に見立てた写しで確かめた）。
// --try: SQL ファイル全体を写しの複製に1つのトランザクションで当てる（BEGIN … COMMIT）。失敗したら ROLLBACK し、1文ずつ当て直して
//   どの文（説明の行）で落ちたかを出す（その当て直しも ROLLBACK する）。--compare を付けると、当てた後の複製と記録した写しの
//   表ごとの行数と中身（既定値が今の時刻の列を除く）を比べる。
// --prepare-copy: 本番の書き出し（wrangler d1 export の .sql。runbook 07 の 3-4b で取るもの）か SQLite から写しの SQLite を作り、
//   まだ当たっていない移行（migrations/）を番号の順に当てて d1_migrations に名前を残す。書き出しは外部キーの確認を切って読み、
//   読み終えてから外部キーを確かめる（違反があれば写しを作らない）。書き出しは列名つきの INSERT で rowid を書かないので、
//   rowid の別名（INTEGER PRIMARY KEY）の無い表の隠れ rowid は写しで1から振り直される（指紋では比べない）。別名のある表は id の列として入るので同じ値になる。
// 行の中身は出力しない（出すのは数・表の名前・説明の行だけ）。終了コード: 0 = できた・当たった / 1 = 当たらなかった・違う / 2 = 使い方の誤り・読めない
import {closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {basename, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {SEED_RECORD_FORMAT, isSessionWrite, sqlWithoutComments, staleRowidFingerprint, STALE_ROWID_MESSAGE} from './seed-all-demo.mjs';
import {cloudR2Internals} from '../src/cloud-r2-db.mjs';

export const STATEMENT_LIMIT_BYTES = 100_000;
const appDir = fileURLToPath(new URL('..', import.meta.url));
const CONTROL = /[\u0000-\u001f\u007f]/u;
const PRIVATE_USE_FROM = 0xe000;
const PRIVATE_USE_TO = 0xf8ff;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// ---------- 値を SQL の文字にする ----------
// 文字。制御文字は私用領域の文字に置き換えて書き、replace() で元に戻す（replace の入れ子は、値に出てくる制御文字の種類の数だけ）
export function sqlString(value) {
  const text = String(value);
  if (!CONTROL.test(text)) return `'${text.replaceAll("'", "''")}'`;
  const controls = [...new Set([...text].filter((ch) => CONTROL.test(ch)))];
  const pairs = [];
  let candidate = PRIVATE_USE_FROM;
  for (const control of controls) {
    while (candidate <= PRIVATE_USE_TO && text.includes(String.fromCodePoint(candidate))) candidate += 1;
    if (candidate > PRIVATE_USE_TO) throw new Error('制御文字を置き換える私用領域の文字が足りません');
    pairs.push([String.fromCodePoint(candidate), control]);
    candidate += 1;
  }
  let body = text;
  for (const [placeholder, control] of pairs) body = body.replaceAll(control, placeholder);
  let expression = `'${body.replaceAll("'", "''")}'`;
  for (const [placeholder, control] of pairs) expression = `replace(${expression},char(${placeholder.codePointAt(0)}),char(${control.codePointAt(0)}))`;
  return expression;
}

// 実数を SQL の文字にしてよい大きさ。この範囲の JavaScript の数の文字（元の数に戻る最短の10進）は指数を使わず、SQLite が元と同じ
// 倍精度に読む（試験で、ビットを乱数で作った数・金額・比率の10万個で確かめている）。範囲の外（|値| が 1e15 を超える、または 0 でなく 1e-6 未満）は
// 指数つきの文字になり、SQLite の読み取りで最下位の桁がずれることがある（node:sqlite の SQLite 3.51.2 で、範囲の外の乱数の 8〜36%（大きさによる）がずれた）ので止める
export const REAL_LITERAL_RANGE = Object.freeze({max: 1e15, min: 1e-6});

// 1つの値。D1 の binding と同じ型・同じ値になるように書く（整数の number は INTEGER、そのほかは REAL、真偽は 1/0）。
// 同じになると言えるのは、整数・文字・バイナリ・NULL と、普通の大きさの実数（金額・比率。REAL_LITERAL_RANGE の中）だけ
export function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'bigint') {
    if (value < INT64_MIN || value > INT64_MAX) throw new Error(`64ビットに収まらない整数です（${value}）`);
    return String(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`有限でない数です（${value}）`);
    if (Number.isSafeInteger(value)) return String(value === 0 ? 0 : value); // -0 は 0
    const size = Math.abs(value);
    if (size > REAL_LITERAL_RANGE.max || size < REAL_LITERAL_RANGE.min) {
      // 値そのものは出さない（行の中身は出力しない）
      throw new Error(`${size > REAL_LITERAL_RANGE.max ? '|値| が 1e15 を超える' : '0 でなく |値| が 1e-6 未満の'}実数は、SQL の文字にすると D1 の binding と最下位の桁がずれうるので書けません（SQL にできる実数は |値| が 1e15 以下で 1e-6 以上。金額・比率の大きさ）`);
    }
    const text = String(value);
    return /[.eE]/.test(text) ? text : `${text}.0`;
  }
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex').toUpperCase()}'`;
  if (value instanceof ArrayBuffer) return `X'${Buffer.from(new Uint8Array(value)).toString('hex').toUpperCase()}'`;
  if (typeof value === 'string') return sqlString(value);
  throw new Error(`SQL にできない値です（${Object.prototype.toString.call(value)}）`);
}

// 記録の値（JSON にできない値は印つき）を元に戻す。seed-all-demo.mjs の recordLines と対
export function decodeRecordValue(value) {
  if (value && typeof value === 'object' && '$base64' in value) return new Uint8Array(Buffer.from(value.$base64, 'base64'));
  if (value && typeof value === 'object' && '$bigint' in value) return BigInt(value.$bigint);
  return value;
}

// 文の ? に値を埋め込み、1行の文にする（文字の引用符の外の改行・空白は1つの空白に、コメントは外す）。
// ?NNN（番号つき）は SQLite と同じ数え方。名前つきの値（:name・@name・$name）と、文の途中の ; は受け付けない
export function bindValues(sql, params = []) {
  const text = String(sql);
  const n = text.length;
  let out = '', i = 0, maxIndex = 0;
  const used = new Set();
  const space = () => { if (out && !out.endsWith(' ')) out += ' '; };
  while (i < n) {
    const c = text[i];
    if (c === "'") {
      let j = i + 1, value = '';
      for (;;) {
        if (j >= n) throw new Error('文の中の文字の引用符が閉じていません');
        if (text[j] === "'") { if (text[j + 1] === "'") { value += "'"; j += 2; continue; } break; }
        value += text[j];
        j += 1;
      }
      out += sqlString(value);
      i = j + 1;
      continue;
    }
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error('文の中の名前の引用符が閉じていません');
        if (text[j] === close) { if (close !== ']' && text[j + 1] === close) { j += 2; continue; } break; }
        j += 1;
      }
      const name = text.slice(i, j + 1);
      if (CONTROL.test(name)) throw new Error('名前に制御文字があります');
      out += name;
      i = j + 1;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') { while (i < n && text[i] !== '\n') i += 1; space(); continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('文の中のコメントが閉じていません');
      i = end + 2;
      space();
      continue;
    }
    if (c === '?') {
      let j = i + 1;
      while (j < n && text[j] >= '0' && text[j] <= '9') j += 1;
      const index = j > i + 1 ? Number(text.slice(i + 1, j)) : maxIndex + 1;
      if (!Number.isInteger(index) || index < 1 || index > params.length) throw new Error(`値の番号 ${index} がありません（値は ${params.length}個）`);
      maxIndex = Math.max(maxIndex, index);
      used.add(index);
      out += sqlValue(params[index - 1]);
      i = j;
      continue;
    }
    if ((c === ':' || c === '@' || c === '$') && /[A-Za-z_]/.test(text[i + 1] || '')) throw new Error('名前つきの値（:name・@name・$name）には対応していません');
    if (c === ';') {
      if (text.slice(i + 1).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) throw new Error('1つの文の途中に ; があります');
      break;
    }
    if (/\s/u.test(c)) { space(); i += 1; continue; }
    if (CONTROL.test(c)) throw new Error('文に制御文字があります');
    out += c;
    i += 1;
  }
  if (used.size !== params.length) throw new Error(`値の数が合いません（文が使う値 ${used.size}個・記録の値 ${params.length}個）`);
  const statement = `${out.trim()};`;
  if (statement === ';') throw new Error('空の文です');
  return statement;
}

const bytesOf = (text) => Buffer.byteLength(text, 'utf8');
const quoteName = (name) => `"${String(name).replaceAll('"', '""')}"`;
const commentText = (text) => String(text).replace(/[\r\n]+/g, ' ').replaceAll(';', '；');
const guard = (condition) => `INSERT INTO transaction_guards(value) SELECT 0 WHERE ${condition};`;
// 表の数の数え方は seed-all-demo.mjs の tableCounts と同じ（sqlite_・_cf_ で始まる表と sessions を除く。指紋は d1_migrations も除く）
const TABLES_CONDITION = "type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('sessions','d1_migrations')";

// 指紋（seed-all-demo.mjs の databaseFingerprint）を、合わないときだけ失敗する文にする → [{label, sql}]
export function fingerprintGuards(fingerprint, when) {
  if (!fingerprint?.counts) throw new Error(`${when}の指紋がありません`);
  // 隠れ rowid の表も比べる古い指紋は、本番の書き出しから作った写しでは必ず合わない（先頭の確かめで落ちる）ので、SQL にしない
  if (staleRowidFingerprint(fingerprint)) throw new Error(`${when}: ${STALE_ROWID_MESSAGE}`);
  const out = [];
  const tables = Object.keys(fingerprint.counts).sort();
  out.push({label: `${when}: 表の数 ${tables.length}`, sql: guard(`(SELECT COUNT(*) FROM sqlite_master WHERE ${TABLES_CONDITION})<>${tables.length}`)});
  for (const table of tables) {
    const parts = [`(SELECT COUNT(*) FROM ${quoteName(table)})<>${fingerprint.counts[table]}`];
    const notes = [`行数 ${fingerprint.counts[table]}`];
    if (fingerprint.rowids && Object.hasOwn(fingerprint.rowids, table)) {
      parts.push(`(SELECT COALESCE(MAX(rowid),0) FROM ${quoteName(table)})<>${fingerprint.rowids[table]}`);
      notes.push(`最大の rowid ${fingerprint.rowids[table]}`);
    }
    if (fingerprint.maxIds && Object.hasOwn(fingerprint.maxIds, table)) {
      parts.push(`(SELECT COALESCE(MAX(id),0) FROM ${quoteName(table)})<>${fingerprint.maxIds[table]}`);
      notes.push(`最大ID ${fingerprint.maxIds[table]}`);
    }
    out.push({label: `${when}: ${table} の${notes.join('・')}`, sql: guard(parts.join(' OR '))});
  }
  // 指紋に行数の無い表の最大ID（ふつうは無い）
  for (const [table, n] of Object.entries(fingerprint.maxIds || {})) {
    if (Object.hasOwn(fingerprint.counts, table)) continue;
    out.push({label: `${when}: ${table} の最大ID ${n}`, sql: guard(`(SELECT COALESCE(MAX(id),0) FROM ${quoteName(table)})<>${n}`)});
  }
  // 利用者（id・メール）と組織（id・コード）の一覧。件数が同じで、どの行もある → 一覧が同じ
  const listGuards = (rows, table, column, what) => {
    const size = 200;
    for (let start = 0; start < Math.max(rows.length, 1); start += size) {
      const chunk = rows.slice(start, start + size);
      const parts = [`(SELECT COUNT(*) FROM ${table})<>${rows.length}`, ...chunk.map(([id, value]) => `NOT EXISTS(SELECT 1 FROM ${table} WHERE id=${sqlValue(id)} AND ${column} IS ${sqlValue(value)})`)];
      out.push({label: `${when}: ${what}の一覧 ${rows.length}件${rows.length > size ? `（${start + 1}〜${start + chunk.length}件目）` : ''}`, sql: guard(parts.join(' OR '))});
    }
  };
  if (Array.isArray(fingerprint.users)) listGuards(fingerprint.users, 'users', 'email', '利用者（id・メール）');
  if (Array.isArray(fingerprint.orgs)) listGuards(fingerprint.orgs, 'organizations', 'code', '組織（id・コード）');
  return out;
}

const FORBIDDEN = /^\s*(CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|VACUUM|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|REINDEX|ANALYZE)\b/i;

// 本番の DB 部品（src/cloud-r2-db.mjs の R2BackedD1Database）が R2 に置く値。SQL ファイルは D1 にしか書けないので、
// いつも R2 に置く列（原本・抽出結果）の値と、128KB を超える値は受け付けない（その節は Worker の部品を通して入れる）
export function r2BoundValue(sql, params) {
  const info = cloudR2Internals.insertColumns(sql);
  const external = info && cloudR2Internals.externalColumns.get(info.table);
  if (!external) return null;
  for (const [index, column] of info.columns.entries()) {
    const value = params[index];
    if (!external.has(column) || typeof value !== 'string') continue;
    if (cloudR2Internals.forcedExternalColumns.has(column)) return `${info.table}.${column}（いつも R2 に置く列）`;
    if (bytesOf(value) > cloudR2Internals.largeValueBytes) return `${info.table}.${column}（${bytesOf(value).toLocaleString('ja-JP')}バイト。128KB を超える値は R2 に置く）`;
  }
  return null;
}

// 記録（JSON Lines の文字）→ SQL ファイルの文字と数。1文が上限以上なら止める（一覧を投げる）
export function recordToSql(text, {source = ''} = {}) {
  const lines = String(text).split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim());
  if (!lines.length) throw new Error('記録が空です');
  const head = JSON.parse(lines[0]);
  if (head.format !== SEED_RECORD_FORMAT) throw new Error('架空データの記録ではありません（seed-all-demo.mjs --record の出力を渡してください）');
  if (!head.fingerprint) throw new Error('記録に写しの指紋がありません（古い記録です。写しを取り直して記録し直してください）');
  const before = fingerprintGuards(head.fingerprint, '当てる前');
  const after = head.after ? fingerprintGuards(head.after, '当てた後') : [];
  const body = [];
  let batchNo = 0;
  for (const line of lines.slice(1)) {
    const batch = JSON.parse(line);
    batchNo += 1;
    const statements = batch.statements || [];
    statements.forEach((statement, index) => {
      const params = (statement.params || []).map(decodeRecordValue);
      let sql;
      try { sql = bindValues(statement.sql, params); } catch (error) { throw new Error(`batch ${batchNo} の ${index + 1}文目: ${error.message}`); }
      // 文の種類は、コメントを外した文（bindValues の結果）で見る。先頭や途中のコメントで定義の文・ログインの書き込みを見逃さない。
      // 出すのは値を埋め込む前の文の頭（行の中身は出さない）
      if (FORBIDDEN.test(sql)) throw new Error(`batch ${batchNo}: 定義・設定・トランザクションの文は入れられません（${sqlWithoutComments(statement.sql).replace(/\s+/g, ' ').slice(0, 60)}）`);
      if (isSessionWrite(sql)) throw new Error(`batch ${batchNo}: ログイン（sessions）の書き込みは入れません`);
      const r2 = r2BoundValue(statement.sql, params);
      if (r2) throw new Error(`batch ${batchNo}（${batch.step || '節なし'}）: 本番では R2 に置く値があります: ${r2}。この記録は SQL にできません（その節は Worker の部品を通して入れる）`);
      body.push({label: index === 0 ? `batch ${batchNo}/${lines.length - 1}（${batch.step || '節なし'}・${statements.length}文）` : null, sql});
    });
  }
  const tooLong = [...before, ...body, ...after].map((row, index) => ({row, index, bytes: bytesOf(row.sql)})).filter((x) => x.bytes >= STATEMENT_LIMIT_BYTES);
  if (tooLong.length) {
    const list = tooLong.slice(0, 10).map((x) => `${x.index + 1}文目（${x.bytes.toLocaleString('ja-JP')}バイト）${x.row.sql.slice(0, 60)}`);
    throw new Error(`D1 の1文の上限（${STATEMENT_LIMIT_BYTES.toLocaleString('ja-JP')}バイト）以上の文が ${tooLong.length}文あります:\n  ${list.join('\n  ')}`);
  }
  const steps = (head.steps || []).map((step) => `${step.key}=${step.skipped ? '入れ済み' : '投入'}`).join('・');
  const header = [
    '-- 架空データの記録を SQL にしたもの（scripts/seed-record-to-sql.mjs）。本番へは wrangler d1 execute <DB> --remote --file <このファイル> で当てる',
    `-- 記録: ${commentText(source || '（名前なし）')}・記録した日時 ${commentText(head.createdAt || '—')}・写し ${commentText(head.database || '—')}・基準日 ${commentText(head.asOf || '—')}`,
    `-- 節: ${commentText(steps || '—')}${head.only ? `（--only ${commentText(head.only.join(','))}）` : ''}`,
    `-- 文の数: 当てる前の確かめ ${before.length}・記録 ${body.length}（batch ${batchNo}）・当てた後の確かめ ${after.length}${head.after ? '' : '（見出しに after が無い古い記録なので入れていない）'}。1文1行`,
    '-- 確かめの文は、合わないときだけ transaction_guards（CHECK(value=1)）に 0 を入れて失敗する。ファイル全体が1つの単位で当たるので、失敗したら1文も当たらない',
    '-- 当てる前の確かめで落ちたら、本番は写しを取った後に変わっている。写しを取り直して記録し直す（どの確かめかは --try で写しに当てると出る）',
    '-- BEGIN・COMMIT・PRAGMA は書いていない',
  ];
  const render = (rows) => rows.flatMap((row) => (row.label ? [`-- ${commentText(row.label)}`, row.sql] : [row.sql]));
  const sql = [...header, '-- ---- 1. 当てる前の確かめ（記録した写しの指紋） ----', ...render(before), '-- ---- 2. 記録 ----', ...render(body),
    ...(after.length ? ['-- ---- 3. 当てた後の確かめ（流した後の写しの指紋） ----', ...render(after)] : [])].join('\n') + '\n';
  const all = [...before, ...body, ...after];
  return {sql, head, counts: {before: before.length, body: body.length, after: after.length, statements: all.length, batches: batchNo},
    bytes: bytesOf(sql), maxStatementBytes: Math.max(...all.map((row) => bytesOf(row.sql)))};
}

// ---------- 写しの複製に当てる（--try・試験） ----------
// SQL ファイル全体を1つのトランザクションで当てる。失敗したら ROLLBACK して {ok: false, error}
export function applySqlText(raw, sqlText) {
  raw.exec('BEGIN');
  try {
    raw.exec(sqlText);
    raw.exec('COMMIT');
    return {ok: true};
  } catch (error) {
    if (raw.isTransaction) raw.exec('ROLLBACK');
    return {ok: false, error: error.message};
  }
}
// どの文で落ちるかを1文ずつ当てて探す（当て直しも ROLLBACK する）→ {line, label, message} か null
export function locateFailure(raw, sqlText) {
  const lines = String(sqlText).split('\n');
  let label = null;
  raw.exec('BEGIN');
  try {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].replace(/\r$/, '');
      if (!line.trim()) continue;
      if (line.startsWith('--')) { if (!line.startsWith('-- ----')) label = line.slice(3); continue; }
      try { raw.exec(line); } catch (error) { return {line: index + 1, label, message: error.message}; }
    }
    return null;
  } finally {
    if (raw.isTransaction) raw.exec('ROLLBACK');
  }
}

// 表ごとの行数（seed-all-demo.mjs の tableCounts と同じ範囲。d1_migrations も除く）
export function rawTableCounts(raw) {
  const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE ${TABLES_CONDITION} ORDER BY name`).all().map((row) => row.name);
  return Object.fromEntries(tables.map((table) => [table, Number(raw.prepare(`SELECT COUNT(*) AS n FROM ${quoteName(table)}`).get().n)]));
}
// 既定値が今の時刻の列（当てた時刻が入る。比べない）
function timeDefaultColumns(raw, table) {
  return raw.prepare(`PRAGMA table_info(${quoteName(table)})`).all()
    .filter((column) => /CURRENT_(TIMESTAMP|DATE|TIME)|'now'|strftime|datetime|julianday|unixepoch/i.test(String(column.dflt_value ?? ''))).map((column) => column.name);
}
// 表ごとの中身の指紋（列ごとに型と値。実数は quote、ほかは hex。行は並べ替えてから）
function tableDigest(raw, table, skip) {
  const columns = raw.prepare(`PRAGMA table_info(${quoteName(table)})`).all().map((column) => column.name).filter((name) => !skip.includes(name));
  if (!columns.length) return '';
  const expr = columns.map((name) => `typeof(${quoteName(name)})||':'||CASE typeof(${quoteName(name)}) WHEN 'real' THEN quote(${quoteName(name)}) ELSE hex(${quoteName(name)}) END`).join(`||'|'||`);
  const rows = raw.prepare(`SELECT ${expr} AS v FROM ${quoteName(table)}`).all().map((row) => row.v).sort();
  const hash = createHash('sha256');
  for (const row of rows) hash.update(row).update('\n');
  return hash.digest('hex');
}
// 2つの DB の表ごとの行数と中身を比べる → {counts: [{table, left, right}], content: [table], skipped: {table: [列]}}。
// 中身は全部の列で比べ、違う表だけ、既定値が今の時刻の列（当てた時刻が入る）を除いて比べ直す。除いて同じなら skipped に列を出す
export function compareDatabases(left, right) {
  const a = rawTableCounts(left), b = rawTableCounts(right);
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const counts = names.filter((name) => a[name] !== b[name]).map((name) => ({table: name, left: a[name] ?? null, right: b[name] ?? null}));
  const content = [], skipped = {};
  for (const table of names.filter((name) => Object.hasOwn(a, name) && Object.hasOwn(b, name))) {
    if (tableDigest(left, table, []) === tableDigest(right, table, [])) continue;
    const skip = [...new Set([...timeDefaultColumns(left, table), ...timeDefaultColumns(right, table)])];
    if (skip.length && tableDigest(left, table, skip) === tableDigest(right, table, skip)) skipped[table] = skip;
    else content.push(table);
  }
  return {counts, content, skipped};
}

// ---------- 本番の書き出しから写しを作る（--prepare-copy） ----------
const isSqliteFile = (path) => {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(16);
    return readSync(fd, head, 0, 16, 0) === 16 && head.toString('latin1') === 'SQLite format 3\0';
  } finally { closeSync(fd); }
};
const migrationNames = (dir) => readdirSync(dir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
export function prepareCopy({from, out, applied = null, migrationsDir = resolve(appDir, 'migrations')}) {
  if (!existsSync(from)) throw new Error(`書き出しがありません: ${from}`);
  if (existsSync(out)) throw new Error(`写しの出力先がもうあります（新しいファイル名にしてください）: ${out}`);
  // 1. 読み込む（外部キーの確認を切る。書き出しは親の表より先に子の行が来ることがある）→ VACUUM INTO でファイルにする
  if (isSqliteFile(from)) {
    const source = new DatabaseSync(from, {readOnly: true});
    try { source.exec(`VACUUM INTO ${sqlString(out)}`); } finally { source.close(); }
  } else {
    const memory = new DatabaseSync(':memory:', {enableForeignKeyConstraints: false});
    try {
      memory.exec(readFileSync(from, 'utf8'));
      memory.exec(`VACUUM INTO ${sqlString(out)}`);
    } finally { memory.close(); }
  }
  const raw = new DatabaseSync(out);
  let result;
  try {
    const violations = raw.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error(`書き出しに外部キーの違反が ${violations.length}件あります（${[...new Set(violations.map((row) => row.table))].join('、')}）。写しは作りません`);
    // 2. まだ当たっていない移行を当てる（wrangler と同じく d1_migrations に名前を残す）
    const hasTable = Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get());
    const names = migrationNames(migrationsDir);
    if (hasTable && applied) throw new Error('書き出しに d1_migrations があるので、--applied は要りません');
    if (!hasTable && !applied) throw new Error('書き出しに d1_migrations がありません。--applied に本番で当たっているファイル名をカンマで並べてください（runbook 07 の 3-4 の migrations list で未適用と出なかったもの）');
    if (!hasTable) {
      const unknown = applied.filter((name) => !names.includes(name));
      if (unknown.length) throw new Error(`--applied に migrations/ に無いファイルがあります: ${unknown.join('、')}`);
      raw.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
      const insert = raw.prepare('INSERT INTO d1_migrations(name) VALUES(?)');
      for (const name of applied) insert.run(name);
    }
    const done = new Set(raw.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name));
    const pending = names.filter((name) => !done.has(name));
    for (const name of pending) {
      raw.exec('BEGIN');
      try {
        raw.exec(readFileSync(resolve(migrationsDir, name), 'utf8'));
        raw.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
        raw.exec('COMMIT');
      } catch (error) {
        if (raw.isTransaction) raw.exec('ROLLBACK');
        throw new Error(`${name} を写しに当てられません: ${error.message}`);
      }
    }
    const fk = raw.prepare('PRAGMA foreign_key_check').all().length;
    if (fk) throw new Error(`移行を当てた後に外部キーの違反が ${fk}件あります`);
    const counts = rawTableCounts(raw);
    result = {tables: Object.keys(counts).length, rows: Object.values(counts).reduce((sum, n) => sum + n, 0), applied: pending};
  } catch (error) {
    raw.close();
    rmSync(out, {force: true});
    throw error;
  }
  raw.close();
  return result;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const options = {prepareCopy: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} の値を指定してください`);
      i += 1;
      return next;
    };
    if (arg === '--record') options.record = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--sql') options.sql = value();
    else if (arg === '--try') options.try = value();
    else if (arg === '--compare') options.compare = value();
    else if (arg === '--prepare-copy') options.prepareCopy = true;
    else if (arg === '--from') options.from = value();
    else if (arg === '--applied') options.applied = value().split(',').map((name) => name.trim()).filter(Boolean);
    else throw new Error(`知らない指定です: ${arg}`);
  }
  if (options.prepareCopy) {
    if (!options.from || !options.out) throw new Error('--prepare-copy には --from（本番の書き出し）と --out（写し）を指定してください');
  } else if (options.record) {
    if (!options.out) throw new Error('--record には --out（書き出す SQL ファイル）を指定してください');
    if (options.sql) throw new Error('--record と --sql は一緒に使えません');
  } else if (options.sql) {
    if (!options.try) throw new Error('--sql には --try（当てる写しの複製）を指定してください');
  } else throw new Error('使い方: --record <記録.jsonl> --out <SQL> [--try <写しの複製>] ／ --sql <SQL> --try <写しの複製> ／ --prepare-copy --from <書き出し> --out <写し>');
  if (options.compare && !options.try) throw new Error('--compare は --try と一緒に使ってください');
  return options;
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB（${bytes.toLocaleString('ja-JP')}バイト）`;

function tryOnCopy(path, sqlText, comparePath) {
  if (!existsSync(path)) throw new Error(`写しの複製がありません: ${path}`);
  const raw = new DatabaseSync(path);
  try {
    const before = rawTableCounts(raw);
    const started = Date.now();
    const result = applySqlText(raw, sqlText);
    if (!result.ok) {
      const failed = locateFailure(raw, sqlText);
      const unchanged = JSON.stringify(rawTableCounts(raw)) === JSON.stringify(before);
      console.error(`写しの複製に当てられませんでした（ROLLBACK。表の行数は${unchanged ? '変わっていない' : '変わった（要確認）'}）: ${result.error}`);
      if (failed) console.error(`落ちた文: ${failed.line}行目${failed.label ? `（${failed.label}）` : ''}: ${failed.message}`);
      return false;
    }
    const after = rawTableCounts(raw);
    const changed = Object.keys(after).filter((table) => after[table] !== before[table]);
    const added = changed.reduce((sum, table) => sum + after[table] - (before[table] ?? 0), 0);
    const fk = raw.prepare('PRAGMA foreign_key_check').all().length;
    console.log(`写しの複製に当てました（1つのトランザクション・${((Date.now() - started) / 1000).toFixed(1)}秒）: 行が変わった表 ${changed.length}・増えた行 ${added.toLocaleString('ja-JP')}・外部キーの違反 ${fk}件`);
    let ok = fk === 0;
    if (comparePath) {
      const other = new DatabaseSync(comparePath, {readOnly: true});
      try {
        const diff = compareDatabases(raw, other);
        const skipped = Object.entries(diff.skipped).map(([table, columns]) => `${table}.${columns.join('/')}`);
        if (diff.counts.length || diff.content.length) {
          ok = false;
          console.error(`記録した写しと違います: 行数 ${diff.counts.map((row) => `${row.table} ${row.left}/${row.right}`).join('、') || 'なし'}・中身 ${diff.content.join('、') || 'なし'}`);
        } else console.log(`記録した写しと同じです: ${Object.keys(rawTableCounts(other)).length}表の行数と中身${skipped.length ? `（当てた時刻が入る列だけ違う: ${skipped.join('、')}）` : ''}`);
      } finally { other.close(); }
    }
    return ok;
  } finally { raw.close(); }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  try {
    if (options.prepareCopy) {
      const result = prepareCopy({from: resolve(options.from), out: resolve(options.out), applied: options.applied || null});
      console.log(`写しを作りました: ${resolve(options.out)}（${result.tables}表・${result.rows.toLocaleString('ja-JP')}行・外部キーの違反 0件）`);
      console.log(`当てた移行: ${result.applied.join('、') || 'なし（すべて当たっていた）'}`);
      process.exit(0);
    }
    let sqlText;
    if (options.record) {
      const text = readFileSync(resolve(options.record), 'utf8');
      const converted = recordToSql(text, {source: basename(resolve(options.record))});
      writeFileSync(resolve(options.out), converted.sql);
      console.log(`SQL にしました: ${resolve(options.out)}`);
      console.log(`  大きさ ${mb(converted.bytes)}・文 ${converted.counts.statements.toLocaleString('ja-JP')}（当てる前の確かめ ${converted.counts.before}・記録 ${converted.counts.body.toLocaleString('ja-JP')}（batch ${converted.counts.batches.toLocaleString('ja-JP')}）・当てた後の確かめ ${converted.counts.after}）`);
      console.log(`  いちばん長い文 ${converted.maxStatementBytes.toLocaleString('ja-JP')}バイト（上限 ${STATEMENT_LIMIT_BYTES.toLocaleString('ja-JP')}バイト未満）`);
      if (!converted.counts.after) console.log('  見出しに after が無い古い記録なので、当てた後の確かめは入れていません');
      sqlText = converted.sql;
    } else {
      sqlText = readFileSync(resolve(options.sql), 'utf8');
      console.log(`SQL: ${resolve(options.sql)}（${mb(statSync(resolve(options.sql)).size)}）`);
    }
    if (options.try) process.exit(tryOnCopy(resolve(options.try), sqlText, options.compare ? resolve(options.compare) : null) ? 0 : 1);
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
