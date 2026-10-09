// docs/rules/dialect.md のうち、機械で守れる部分を確かめる。
// - src（.mjs・.jsx・.js・.sql）と migrations/（.sql）で、SQLite の方言の形（KINDS）の数を、ファイルごとに増やさない
// - SQL の形（GLOB・typeof(・INSERT OR など）は、.sql ではコメントと文字の中身を除いた本文、JS では文字列・テンプレートの中を
//   同じように読んで数える（JS のコメント・JS の typeof は数えない）。テンプレートの ${…} の中の文字列も数える
// - lastInsertRowid・last_row_id・sqlite_master は、コメントを除いたコード（文字列を含む）で数える
// - SQLite のエラー文の照合は、SQLite の制約の語（constraint と、大文字の UNIQUE・CHECK など）を含む正規表現リテラルと、
//   includes などに渡す文字列、SQLite のエラーの決まり文句（constraint failed・SQLITE_CONSTRAINT など）を含む文字列を、1つずつ数える
// 整数の強制（money.md の typeof(列)='integer'）は数えない。money.md が足すよう求める形で、PostgreSQL では BIGINT の型が代わる。
// 借りは test/dialect-debt.json。直して数が減ったら、この JSON も減らす（減らし忘れも落ちる）。
// 一覧を作り直すとき: node test/dialect-rules.test.mjs --write （どの端末でも UTF-8 で書く）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scanJs} from './js-scan.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const debtPath = join(app, 'test', 'dialect-debt.json');

export const KINDS = ['glob', 'typeof', 'insertOr', 'upsertBare', 'lastInsertRowid', 'sqliteMaster', 'errorText'];
const KIND_HINTS = {
  glob: ['SQL の GLOB', '形と範囲の CHECK は DB に残し、ltrim(部分, \'許す文字\') = \'\' と数字だけの部分の BETWEEN で書く（dialect.md の「形の CHECK」）'],
  typeof: ['SQL の typeof(…)（整数の強制の typeof(列)=\'integer\' は数えない）', '列の型をそろえ、値の型はアプリの読み取りで確かめる'],
  insertOr: ['INSERT OR IGNORE・INSERT OR REPLACE・REPLACE INTO・ON CONFLICT REPLACE などの SQLite の衝突の書き方',
    'INSERT … ON CONFLICT (列) DO NOTHING か DO UPDATE SET 列 = excluded.列'],
  upsertBare: ['ON CONFLICT … DO UPDATE SET の右辺に、表の名前の無い同じ列（version=version+1）',
    '表の名前つきで書く（version=production_revisions.version+1）。PostgreSQL は excluded と区別できず ambiguous で断る'],
  lastInsertRowid: ['lastInsertRowid・meta.last_row_id・last_insert_rowid()', 'INSERT … RETURNING id を db.get で受け取る'],
  sqliteMaster: ['sqlite_master・sqlite_schema・sqlite_sequence', '表の有無で分岐しない。表は移行で作る'],
  errorText: ['SQLite のエラー文（UNIQUE constraint failed など）の照合',
    '一意の衝突は ON CONFLICT DO NOTHING RETURNING で行が返ったかを見る。業務の止めはトリガーの RAISE の文で見分ける（dialect.md）'],
};

// ---------- SQL の本文 ----------

// コメントと文字の中身を除く（'…' は '' に）。整数の強制の 'integer' だけは残す（typeof の除外に使う）
export const sqlBody = sql => sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, m => (m === "'integer'" ? m : m[0] === "'" ? "''" : ' '));

const GLOB = /\bGLOB\b/gi;
const TYPEOF = /\btypeof\s*\(/gi;
// 整数の強制（money.md）: typeof(列) を 'integer' だけと比べる形（= 'integer'・<> 'integer'・IN ('integer')）
const TYPEOF_INTEGER = /\btypeof\s*\(\s*[\w."`[\]]+\s*\)\s*(?:(?:==?|<>|!=|\bIS(?:\s+NOT)?)\s*'integer'|(?:NOT\s+)?IN\s*\(\s*'integer'\s*\))/gi;
const INSERT_OR = /\b(?:INSERT|UPDATE)\s+OR\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b|(?<!\bOR\s+)\bREPLACE\s+INTO\b|\bON\s+CONFLICT\s+(?:IGNORE|REPLACE|ABORT|FAIL|ROLLBACK)\b/gi;
const LAST_ID = /\blastInsertRowid\b|\blast_row_id\b|\blast_insert_rowid\s*\(/g;
const SQLITE_TABLES = /\bsqlite_(?:master|schema|temp_master|temp_schema|sequence)\b/gi;

const count = (text, pattern) => (text.match(pattern) || []).length;

// ON CONFLICT … DO UPDATE SET 列 = 式 の式に、表の名前の無い同じ列があるもの（SET version=version+1）。1つの代入を1つと数える。
// 句は WHERE・RETURNING・文の終わり（; と閉じ括弧）まで。式の中の excluded.列・表.列 は数えない
const DO_UPDATE = /\bDO\s+UPDATE\s+SET\b/gi;
function upsertBare(body) {
  let n = 0;
  for (const m of body.matchAll(DO_UPDATE)) {
    let depth = 0;
    let end = m.index + m[0].length;
    const parts = [];
    let from = end;
    for (; end < body.length; end += 1) {
      const c = body[end];
      if (c === '(') depth += 1;
      else if (c === ')') { if (depth === 0) break; depth -= 1; }
      else if (c === ';' && depth === 0) break;
      else if (c === ',' && depth === 0) { parts.push(body.slice(from, end)); from = end + 1; }
      else if (depth === 0 && /^(?:WHERE|RETURNING)\b/i.test(body.slice(end)) && !/[\w.]/.test(body[end - 1] ?? '')) break;
    }
    parts.push(body.slice(from, end));
    for (const part of parts) {
      const eq = /^\s*"?([A-Za-z_]\w*)"?\s*=(?!=)([\s\S]*)$/.exec(part);
      if (eq && new RegExp(`(?<![\\w."])"?${eq[1]}"?(?![\\w"])`, 'i').test(eq[2])) n += 1;
    }
  }
  return n;
}
const sqlKinds = body => ({
  glob: count(body, GLOB),
  typeof: count(body, TYPEOF) - count(body, TYPEOF_INTEGER),
  insertOr: count(body, INSERT_OR),
  upsertBare: upsertBare(body),
});

// ---------- SQLite のエラー文 ----------

// SQLite のエラー文に出る語（正規表現リテラルと、照合の関数に渡す文字列で見る）。
// 制約の名前（UNIQUE・CHECK など）は SQLite が大文字で出すので、大文字だけに合わせる（'/check'・'unique' の照合と分ける）
const ERROR_WORDS = /constraint|no such (?:table|column)|database is locked/i;
const CONSTRAINT_NAMES = /\b(?:UNIQUE|CHECK|FOREIGN\s+KEY|NOT\s+NULL|PRIMARY\s+KEY)\b/;
const errorWords = text => ERROR_WORDS.test(text) || CONSTRAINT_NAMES.test(text);
// SQLite のエラーの決まり文句（どの文字列に書いてあっても照合とみなす）
const SQLITE_MESSAGE = /constraint failed|no such (?:table|column)|database is locked/i;
// SQLite の結果コード（SQLITE_CONSTRAINT_UNIQUE・正規表現の SQLITE_[A-Z_]+ など）。大文字だけ（sqlite_master と分ける）
const SQLITE_CODE = /\bSQLITE_/;
// 直前がこれなら、その文字列は照合に使っている
const MATCH_CALL = /(?:\.\s*(?:includes|startsWith|endsWith|indexOf|lastIndexOf|match|matchAll|search|test)|\bRegExp)\s*\(\s*$/;

// テンプレートの文字の部分（${…} の式を除いた本文）。式は literalFindings が別に読む
const templateText = s => s.expressions.reduceRight((value, e) => value.slice(0, e.start - s.start - 3) + ' _ ' + value.slice(e.end - s.start), s.value);

// JS の文字列・テンプレート・正規表現リテラルで数える形（SQL の形とエラー文の照合）。${…} の中は同じ形で数えて足す
function literalFindings(text) {
  const {masked, strings, regexes} = scanJs(text);
  const out = {glob: 0, typeof: 0, insertOr: 0, upsertBare: 0, errorText: regexes.filter(r => errorWords(r.value) || SQLITE_CODE.test(r.value)).length};
  for (const s of strings) {
    const body = s.expressions ? templateText(s) : s.value;
    for (const [kind, n] of Object.entries(sqlKinds(sqlBody(body)))) out[kind] += n;
    const matched = MATCH_CALL.test(masked.slice(Math.max(0, s.start - 40), s.start)) && errorWords(body);
    if (matched || SQLITE_MESSAGE.test(body) || SQLITE_CODE.test(body)) out.errorText++;
    for (const e of s.expressions || []) {
      for (const [kind, n] of Object.entries(literalFindings(e.value))) out[kind] += n;
    }
  }
  return out;
}

// 1ファイルで、形ごとの数。rel は app からの相対パス（.sql かどうかで読み方を変える）
export function findings(rel, text) {
  const out = Object.fromEntries(KINDS.map(k => [k, 0]));
  if (rel.endsWith('.sql')) {
    const body = sqlBody(text);
    Object.assign(out, sqlKinds(body), {lastInsertRowid: count(body, LAST_ID), sqliteMaster: count(body, SQLITE_TABLES)});
    return out;
  }
  const {code} = scanJs(text);
  out.lastInsertRowid = count(code, LAST_ID);
  out.sqliteMaster = count(code, SQLITE_TABLES);
  for (const [kind, n] of Object.entries(literalFindings(text))) out[kind] += n;
  return out;
}

// ---------- ファイルを読んで、借りと比べる ----------

function walk(dir, pattern, out = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, pattern, out);
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

// 読むファイル（app からの相対パス → 中身）。overrides で中身を差し替え・足して読める（試験用。本物のファイルは書き換えない）
export function sourceFiles(overrides = {}) {
  const files = new Map([
    ...walk(join(app, 'src'), /\.(mjs|jsx|js|sql)$/),
    ...walk(join(app, 'migrations'), /\.sql$/),
  ].map(path => [relative(app, path).replaceAll('\\', '/'), null]));
  for (const rel of Object.keys(overrides)) files.set(rel, overrides[rel]);
  return new Map([...files].map(([rel, text]) => [rel, text ?? readFileSync(join(app, rel), 'utf8')]));
}

// 形 → {ファイル: 数}（0 のファイルは載せない）
export function scan(files = sourceFiles()) {
  const out = Object.fromEntries(KINDS.map(k => [k, {}]));
  for (const [rel, text] of files) {
    for (const [kind, n] of Object.entries(findings(rel, text))) if (n) out[kind][rel] = n;
  }
  return out;
}

// 借りより増えた所（落ちる）と、借りより減った所（一覧を減らす）
export const grown = (debt, now) => KINDS.flatMap(kind => Object.entries(now[kind] || {})
  .filter(([file, n]) => n > (debt[kind]?.[file] || 0)).map(([file, n]) => `${kind} ${file}: ${debt[kind]?.[file] || 0} → ${n}`));
export const stale = (debt, now) => KINDS.flatMap(kind => Object.entries(debt[kind] || {})
  .filter(([file, n]) => (now[kind]?.[file] || 0) < n).map(([file, n]) => `${kind} ${file}: ${n} → ${now[kind]?.[file] || 0}`));

const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const total = o => Object.values(o).reduce((a, b) => a + b, 0);

if (process.argv.includes('--write')) {
  const now = scan();
  const out = {
    note: '返すべき借り。docs/rules/dialect.md に反している SQLite の方言の形の数（ファイルごと）。直したら減らす。足してはいけない（別のファイルへ動かしただけなら、PR の差分で合計が増えていないことを見せる）',
    ...Object.fromEntries(KINDS.map(k => [k, sorted(now[k])])),
  };
  writeFileSync(debtPath, JSON.stringify(out, null, 1) + '\n', 'utf8');
  console.log(`書いた: ${relative(app, debtPath)}（${KINDS.map(k => `${k} ${total(now[k])}`).join('・')}）`);
} else {
  const debt = existsSync(debtPath) ? JSON.parse(readFileSync(debtPath, 'utf8').replace(/^﻿/, '')) : {};
  for (const k of KINDS) debt[k] ||= {};
  const files = sourceFiles();
  const now = scan(files);

  for (const kind of KINDS) {
    const [label, hint] = KIND_HINTS[kind];
    test(`src と migrations で増えていない: ${label}`, () => {
      assert.deepEqual(grown({[kind]: debt[kind]}, {[kind]: now[kind]}), [], hint);
    });
  }

  test('借りの一覧は実態と合っている（直したら減らす）', () => {
    assert.deepEqual(stale(debt, now), [], 'node test/dialect-rules.test.mjs --write で作り直す');
  });

  test('どの形も、本物のファイルに1か所足すと増えたとして落ち、新しいファイルに足しても落ちる', () => {
    const probes = {
      glob: ['src/schema.sql', "\nCREATE TABLE dialect_probe(d TEXT CHECK(d GLOB '[0-9]*'));\n"],
      typeof: ['src/catalog.mjs', "\nexport const dialectProbe = db => db.all(\"SELECT id FROM t WHERE typeof(v) = 'text'\");\n"],
      insertOr: ['src/catalog.mjs', "\nexport const dialectProbe = db => db.run('INSERT OR IGNORE INTO t(x) VALUES (?)', [1]);\n"],
      upsertBare: ['src/catalog.mjs', "\nexport const dialectProbe = db => db.run('INSERT INTO t(id,v) VALUES (?,1) ON CONFLICT(id) DO UPDATE SET v=v+1', [1]);\n"],
      lastInsertRowid: ['src/catalog.mjs', "\nexport const dialectProbe = async db => (await db.run('INSERT INTO t(x) VALUES (?)', [1])).lastInsertRowid;\n"],
      sqliteMaster: ['src/catalog.mjs', "\nexport const dialectProbe = db => db.all(\"SELECT name FROM sqlite_master WHERE type = 'table'\");\n"],
      errorText: ['src/catalog.mjs', '\nexport const dialectProbe = error => /UNIQUE constraint failed: t/.test(error.message);\n'],
    };
    // 1ファイルだけ中身を変えたときの全体の数（ほかのファイルの数は now のまま）
    const rescan = (rel, text) => {
      const one = scan(new Map([[rel, text]]));
      return Object.fromEntries(KINDS.map(k => [k, Object.fromEntries([...Object.entries(now[k]).filter(([f]) => f !== rel), ...Object.entries(one[k])])]));
    };
    assert.deepEqual(Object.keys(probes), KINDS);
    assert.deepEqual(grown(debt, now), [], '足す前は借りの内');
    for (const [kind, [rel, added]] of Object.entries(probes)) {
      const before = now[kind][rel] || 0;
      assert.deepEqual(grown(debt, rescan(rel, files.get(rel) + added)), [`${kind} ${rel}: ${before} → ${before + 1}`], kind);
    }
    // 新しいファイル（次の番号の移行）に書いても落ちる。読み方は本物の一覧に1本足した形
    const added = scan(sourceFiles({'migrations/9999_dialect_probe.sql': "CREATE TABLE p(d TEXT CHECK(d GLOB '[0-9]*'));\n"}));
    assert.deepEqual(grown(debt, added), ['glob migrations/9999_dialect_probe.sql: 0 → 1']);
    // 整数の強制（money.md）を足しても増えない
    const guard = "\nCREATE TABLE dialect_probe(a_yen INTEGER CHECK(typeof(a_yen)='integer'));\nCREATE TRIGGER dialect_probe_u BEFORE UPDATE OF a_yen ON dialect_probe WHEN typeof(NEW.a_yen) <> 'integer' BEGIN SELECT RAISE(ABORT,'integer'); END;\n";
    assert.deepEqual(grown(debt, rescan('src/schema.sql', files.get('src/schema.sql') + guard)), []);
    // 減らしたら、一覧を減らすよう落ちる
    const fewer = {...now, insertOr: {...now.insertOr, 'src/schema.sql': (now.insertOr['src/schema.sql'] || 0) - 1}};
    assert.deepEqual(stale(debt, fewer), [`insertOr src/schema.sql: ${debt.insertOr['src/schema.sql']} → ${debt.insertOr['src/schema.sql'] - 1}`]);
  });

  test('検査は SQLite の方言を見逃さず、コメント・文字の中身・JS の typeof・整数の強制は数えない', () => {
    const only = (text, rel = 'src/x/x-store.mjs') => Object.fromEntries(Object.entries(findings(rel, text)).filter(([, n]) => n));
    // SQL の形（JS の文字列とテンプレートの中）
    assert.deepEqual(only("db.all(\"SELECT id FROM t WHERE code GLOB 'A*' OR code glob ?\")"), {glob: 2});
    assert.deepEqual(only("db.all(`SELECT id FROM t WHERE a GLOB ${x} AND ${y ? `b GLOB '1'` : ''}`)"), {glob: 2});
    assert.deepEqual(only("db.run(\"INSERT OR REPLACE INTO t VALUES (1)\"); db.run('REPLACE INTO t VALUES (1)'); db.run('UPDATE OR IGNORE t SET a = 1')"), {insertOr: 3});
    assert.deepEqual(only("db.run('INSERT INTO t(a) VALUES (?) ON CONFLICT(a) DO UPDATE SET b = excluded.b RETURNING id')"), {});
    // 右辺の表の名前の無い同じ列（DO UPDATE の代入ごと）。excluded.・表の名前つき・別の列・WHERE の中は数えない
    assert.deepEqual(only("db.run('INSERT INTO t(id,v,w) VALUES (?,1,2) ON CONFLICT(id) DO UPDATE SET v=v+1, w = COALESCE(w, 0) + excluded.w WHERE v < 9')"), {upsertBare: 2});
    assert.deepEqual(only("db.run('INSERT INTO t(id,v,w) VALUES (?,1,2) ON CONFLICT(id) DO UPDATE SET v=t.v+1, w=excluded.w+t.w, x=y WHERE x=x RETURNING v')"), {});
    assert.deepEqual(only("db.all(\"SELECT id FROM t WHERE typeof(v) IN ('integer','real') OR typeof(w) = 'text'\")"), {typeof: 2});
    assert.deepEqual(only("db.exec(\"CREATE TABLE t(a_yen INTEGER CHECK(typeof(a_yen)='integer'), b INTEGER CHECK(b IS NULL OR typeof(b) IN ('integer')))\")"), {});
    // 識別子とシステムの表
    assert.deepEqual(only('const id = out.lastInsertRowid; const d1 = result.meta?.last_row_id; const s = `SELECT last_insert_rowid()`'), {lastInsertRowid: 3});
    assert.deepEqual(only("db.all(\"SELECT sql FROM sqlite_master WHERE type='table'\"); db.all('SELECT * FROM sqlite_schema')"), {sqliteMaster: 2});
    // SQLite のエラー文の照合
    assert.deepEqual(only('const conflict = /constraint|UNIQUE|stale/i.test(e.message)'), {errorText: 1});
    assert.deepEqual(only('const dup = /UNIQUE/i.test(e.message); const ck = message.startsWith("CHECK")'), {errorText: 2});
    assert.deepEqual(only("const a = message.includes('UNIQUE'); const b = new RegExp('FOREIGN KEY'); const c = e.message === 'UNIQUE constraint failed: t.code'"), {errorText: 3});
    assert.deepEqual(only('const label = `${/CHECK constraint failed: value/.test(m) ? "競合" : ""}`'), {errorText: 1});
    assert.deepEqual(only("const code = err.code === 'SQLITE_CONSTRAINT_UNIQUE'"), {errorText: 1});
    // 数えないもの
    assert.deepEqual(only([
      '// INSERT OR IGNORE・GLOB・sqlite_master・lastInsertRowid・/UNIQUE/.test(m) はコメント',
      '/* typeof(x) と REPLACE INTO */',
      "if (typeof x === 'string' && typeof(y) === 'number') throw new Error('stale');",
      "const ddl = 'CREATE TABLE t(a TEXT, UNIQUE(org_id, code))'; const fk = \"FOREIGN KEY (a) REFERENCES b(id)\";",
      "db.all(\"SELECT id FROM t WHERE label = 'GLOB' AND note = 'INSERT OR IGNORE' -- GLOB はコメント\\n\");",
      'const race = /stale|immutable|mismatch/.test(e.message); const label = name.includes("Uniqueness");',
      // 制約の名前と同じ綴りの小文字の照合（画面の道・種類の名前）は、SQLite のエラー文ではない
      "if (location.pathname.startsWith('/check') || /check/i.test(kind)) go(mode.includes('unique'), label.match('not null'));",
      "db.all('SELECT name FROM information_schema.tables'); const x = row.lastInsertRowidText;",
    ].join('\n')), {});
    // .sql のファイル
    const sql = (text, rel = 'migrations/0011_x.sql') => Object.fromEntries(Object.entries(findings(rel, text)).filter(([, n]) => n));
    assert.deepEqual(sql([
      "-- GLOB と INSERT OR IGNORE はコメント",
      "CREATE TABLE t(id INTEGER PRIMARY KEY, d TEXT CHECK(d GLOB '[0-9]*'), n CHECK(typeof(n) IN ('integer','real')), a_yen INTEGER CHECK(typeof(a_yen)='integer'));",
      "CREATE TRIGGER t_u BEFORE UPDATE ON t WHEN typeof(NEW.a_yen) <> 'integer' BEGIN SELECT RAISE(ABORT, 'INSERT OR IGNORE は文字'); END;",
      "INSERT OR IGNORE INTO t(id) VALUES (1); /* sqlite_master */ SELECT name FROM sqlite_master;",
    ].join('\n')), {glob: 1, typeof: 1, insertOr: 1, sqliteMaster: 1});
    assert.equal(sqlBody("SELECT 'a--b', x -- c\nFROM t /* 'd' */ WHERE y = 'it''s'"), "SELECT '', x  \nFROM t   WHERE y = ''");
    assert.deepEqual(scanJs('const r = /a\\/b/g; const s = x / 2 / y;').regexes.map(r => r.value), ['/a\\/b/g']);
  });
}
