// docs/rules/architecture.md の「依存の向き」と「置き場所」のうち、機械で守れる部分を確かめる。
// - 計算（*-model.mjs）と画面（*.jsx）は、受け口・DB の役・DB の土台・本番の実行の部品・SQL を持つファイル・表の定義を import しない
// - DB の役（*-store.mjs・*-flow.mjs）は、受け口・画面・本番の実行の部品を import しない
// - SQL 文を書くのと DB を呼ぶのは、DB の役と DB の土台だけ。いまほかの場所にある分は「返すべき借り」の数として記録し、増えたら落ちる
// - 計算は時刻・乱数・環境変数を読まない（関数の引数の既定値 now = new Date() はよい）
// - src/ 直下に新しいファイルを置かない（業務の領域フォルダに置く）
// 借りは test/dependency-debt.json。直して数が減ったら、この JSON も減らす（減らし忘れも落ちる）。
// 一覧を作り直すとき: node test/dependency-rules.test.mjs --write （どの端末でも UTF-8 で書く）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {join, dirname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scanJs, matchParen} from './js-scan.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(app, 'src');
const debtPath = join(app, 'test', 'dependency-debt.json');

// SQL を書いてよい DB の土台（アダプタ・移行の部品・IN 句の組み立て）。フォルダを問わない
const DB_BASE = /(^|\/)(db|d1-db|pg-db|cloud-r2-db|local-migrations|sql-in|[a-z0-9-]+-migrations?)\.mjs$/;
// 本番の実行の部品（入口・サーバー・Worker・Cloudflare・ローカルの抽出と分析・AI の接続）。フォルダを問わない
const RUNTIME = /(^|\/)(app|server|server-production|worker|cloud-worker|production-gateway|ai-adapter|local-extractor|workbench-extractor-local|workbench-analytics-local|cloud-[a-z0-9-]+)\.mjs$/;

// 役の見分け方。DB の役は名前（-store・-flow）で決める。-read・-service・-data・-loader は
// 名前がそろっていないうえ SQL を持たない計算の部品も混ざる（bulk-read.mjs）ので、SQL は中身で見る。
export function roleOf(rel) {
  const path = rel.replace(/\?.*$/, '');
  const name = path.split('/').pop();
  if (name.endsWith('.sql')) return 'sql';
  if (name.endsWith('.jsx')) return 'jsx';
  if (name.endsWith('-model.mjs')) return 'model';
  if (name.endsWith('-routes.mjs')) return 'routes';
  if (name.endsWith('-store.mjs') || name.endsWith('-flow.mjs')) return 'store';
  if (DB_BASE.test(path)) return 'db-base';
  if (RUNTIME.test(path)) return 'runtime';
  return 'other';
}

const FORBIDDEN = {
  model: new Set(['routes', 'store', 'jsx', 'runtime', 'db-base', 'sql']),
  jsx: new Set(['routes', 'store', 'runtime', 'db-base', 'sql']),
  store: new Set(['routes', 'jsx', 'runtime']),
};
// 計算と画面は、名前にかかわらず SQL を持つファイル・本番の実行に触れるファイル（node: や process.env）も読まない
const PURE_ONLY = new Set(['model', 'jsx']);
const SQL_HOME = new Set(['store', 'db-base', 'sql']);

// SQL 文: 文字列・テンプレートの中身が SQL の言葉で始まるもの（大文字で書く決まり）。1つのリテラルの中だけを見る
const SQL_START = /^\s*(?:(?:SELECT|WITH)\s[\s\S]*?\bFROM\b|INSERT\s+(?:OR\s+[A-Z]+\s+)?INTO\s|REPLACE\s+INTO\s|UPDATE\s+\S+\s+SET\s|DELETE\s+FROM\s|(?:CREATE|DROP)\s+(?:TEMP\s+|UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\b|ALTER\s+TABLE\s|PRAGMA\s)/;
export const sqlCount = text => scanJs(text).strings.filter(s => SQL_START.test(s.value)).length;

// DB の呼び出し（SQL を変数で受け取って実行する形も拾う。読み取りの一括 readBatch も含む）。文字列の中は見ない
const DB_CALL = /\b(?:db|env\s*\.\s*DB|raw|d1)\s*\??\.\s*(?:all|get|run|exec|batch|readBatch|prepare|first)\s*\(|\ballIn\s*\(/g;
export const dbCalls = text => (scanJs(text).masked.match(DB_CALL) || []).length;
const TOUCHES_RUNTIME = /from\s*['"]node:|\bprocess\.env\b/;
const ENV_READ = /\bprocess\s*\.\s*env\b/g;

// 時刻・乱数（文字列の中は見ない）
const CLOCK = /\bDate\s*\.\s*now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)|\bnew\s+Date\b(?!\s*\()|(?<![\w.])Date\s*\(\s*\)|\bperformance\s*\.\s*now\s*\(|\bMath\s*\.\s*random\s*\(|\brandomUUID\s*\(|\bgetRandomValues\s*\(|\bTemporal\s*\.\s*Now\b|\bnew\s+Intl\s*\.\s*DateTimeFormat\s*\([^)]*\)\s*\.\s*format\s*\(\s*\)/g;

// 見つけた式が「関数の引数の既定値」の中にあるか（関数の引数リストの括弧の中で、識別子 = の直後に置かれているか）
function inParameterDefault(masked, index) {
  if (!/[A-Za-z_$][\w$]*\s*=\s*$/.test(masked.slice(Math.max(0, index - 80), index))) return false;
  let depth = 0;
  let open = -1;
  for (let k = index - 1; k >= 0; k--) {
    if (masked[k] === ')') depth++;
    else if (masked[k] === '(') {
      if (depth === 0) { open = k; break; }
      depth--;
    }
  }
  if (open < 0) return false;
  if (/\b(for|if|while|switch|catch|with)\s*$/.test(masked.slice(Math.max(0, open - 12), open))) return false; // 制御構文の見出し
  if (/\(\s*$/.test(masked.slice(Math.max(0, open - 4), open))) return false; // ((d = new Date()) => …)() の即時実行
  const close = matchParen(masked, open);
  return close > 0 && /^\s*(=>|\{)/.test(masked.slice(close + 1, close + 20));
}

export function clockReads(text) {
  const {masked} = scanJs(text);
  let n = 0;
  for (const m of masked.matchAll(CLOCK)) if (!inParameterDefault(masked, m.index)) n++;
  return n;
}

// import・export … from・動的 import（テンプレート文字列を含む）の指定。コメントの中は見ない
const IMPORT = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(['"`])(\.[^'"`$]+)\1|\bimport\s*\(\s*(['"`])(\.[^'"`$]+)\3\s*\)/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(mjs|jsx|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const toRel = path => relative(app, path).replaceAll('\\', '/');

export function importsOf(file, text) {
  const out = [];
  for (const m of scanJs(text).code.matchAll(IMPORT)) {
    const spec = (m[2] || m[4]).replace(/\?.*$/, '');
    let target = resolve(dirname(file), spec);
    if (!/\.[a-z]+$/.test(spec)) {
      const found = ['.mjs', '.js', '.jsx'].map(ext => target + ext).find(existsSync);
      if (found) target = found;
    }
    out.push(toRel(target));
  }
  return out;
}

export function scan() {
  const files = walk(src).map(path => ({path, rel: toRel(path), text: readFileSync(path, 'utf8')}));
  const sqlFiles = new Set(files.filter(f => sqlCount(f.text)).map(f => f.rel));
  const runtimeFiles = new Set(files.filter(f => TOUCHES_RUNTIME.test(scanJs(f.text).code)).map(f => f.rel));
  const result = {imports: {}, sql: {}, calls: {}, clock: {}, env: {}};
  for (const f of files) {
    const role = roleOf(f.rel);
    if (FORBIDDEN[role]) {
      const bad = importsOf(f.path, f.text).filter(t => FORBIDDEN[role].has(roleOf(t)) ||
        (PURE_ONLY.has(role) && (sqlFiles.has(t) || runtimeFiles.has(t))));
      if (bad.length) result.imports[f.rel] = [...new Set(bad)].sort();
    }
    if (!SQL_HOME.has(role)) {
      const n = sqlCount(f.text);
      if (n) result.sql[f.rel] = n;
      const c = dbCalls(f.text);
      if (c) result.calls[f.rel] = c;
    }
    if (role === 'model') {
      const n = clockReads(f.text);
      if (n) result.clock[f.rel] = n;
      const e = (scanJs(f.text).masked.match(ENV_READ) || []).length;
      if (e) result.env[f.rel] = e;
    }
  }
  result.rootFiles = readdirSync(src, {withFileTypes: true}).filter(e => e.isFile()).map(e => e.name).sort();
  return result;
}

const COUNTS = ['sql', 'calls', 'clock', 'env'];
const readDebt = () => existsSync(debtPath)
  ? JSON.parse(readFileSync(debtPath, 'utf8').replace(/^﻿/, ''))
  : {imports: {}, sql: {}, calls: {}, clock: {}, env: {}, rootFiles: []};

if (process.argv.includes('--write')) {
  const s = scan();
  const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const out = {note: '返すべき借り。docs/rules/architecture.md の依存の向きに反しているもの。直したら減らす。足してはいけない',
    imports: sorted(s.imports), ...Object.fromEntries(COUNTS.map(k => [k, sorted(s[k])])), rootFiles: s.rootFiles};
  writeFileSync(debtPath, JSON.stringify(out, null, 1) + '\n', 'utf8');
  console.log(`書いた: ${relative(app, debtPath)}`);
} else {
  const debt = readDebt();
  for (const k of COUNTS) debt[k] ||= {};
  const now = scan();
  const grew = (key, hint) => {
    const out = Object.entries(now[key]).filter(([file, n]) => n > (debt[key][file] || 0)).map(([file, n]) => `${file}: ${debt[key][file] || 0} → ${n}`);
    assert.deepEqual(out, [], hint);
  };

  test('禁じた import が増えていない（計算・画面・DB の役）', () => {
    const added = Object.entries(now.imports).flatMap(([file, targets]) =>
      targets.filter(t => !(debt.imports[file] || []).includes(t)).map(t => `${file} → ${t}`));
    assert.deepEqual(added, [], '計算と画面は DB・受け口・本番の部品を読まない。DB の役は受け口・画面・本番の部品を読まない');
  });

  test('SQL 文を書く場所が増えていない（DB の役と土台の外）', () => grew('sql', 'SQL は <領域>-store.mjs に置く'));
  test('DB を呼ぶ場所が増えていない（DB の役と土台の外）', () => grew('calls', '受け口は store の関数を呼ぶ'));
  test('計算が時刻と乱数を読む所が増えていない', () => grew('clock', '「今日」や乱数は引数で受け取る'));
  test('計算が環境変数を読む所が増えていない', () => grew('env', '設定は受け口で読み、引数で渡す'));

  test('src/ 直下に新しいファイルを置いていない', () => {
    assert.deepEqual(now.rootFiles.filter(name => !debt.rootFiles.includes(name)), [], '業務の領域フォルダに置く');
  });

  test('借りの一覧は実態と合っている（直したら減らす）', () => {
    const shrunk = key => Object.entries(debt[key]).filter(([file, n]) => (now[key][file] || 0) < n).map(([file, n]) => `${key} ${file}: ${n} → ${now[key][file] || 0}`);
    const stale = [
      ...Object.entries(debt.imports).flatMap(([file, targets]) =>
        targets.filter(t => !(now.imports[file] || []).includes(t)).map(t => `import ${file} → ${t}`)),
      ...COUNTS.flatMap(shrunk),
      ...debt.rootFiles.filter(name => !now.rootFiles.includes(name)).map(name => `root ${name}`),
    ];
    assert.deepEqual(stale, [], 'node test/dependency-rules.test.mjs --write で作り直す');
  });

  test('検査は役・import・SQL・時刻を見逃さない', () => {
    assert.equal(roleOf('src/expense/expense-model.mjs'), 'model');
    assert.equal(roleOf('src/expense/payout/payout-flow.mjs'), 'store');
    assert.equal(roleOf('src/bulk/bulk-read.mjs'), 'other');
    assert.equal(roleOf('src/app.mjs'), 'runtime');
    assert.equal(roleOf('src/core/app.mjs'), 'runtime');
    assert.equal(roleOf('src/core/db.mjs'), 'db-base');
    assert.equal(roleOf('src/mg-migration.mjs'), 'db-base');
    assert.equal(roleOf('src/schema.sql?raw'), 'sql');
    const from = join(src, 'x', 'a-model.mjs');
    assert.deepEqual(importsOf(from, [
      "import {a}from'../y/b-routes.mjs'",
      "export {c} from '../y/c-store.mjs'",
      'const m = await import (`./d-routes.mjs`)',
      "// import {z} from '../y/z-routes.mjs'",
      "const re = /['\"]/g; const p = '/api/*'; import {e} from './e-store.mjs'",
    ].join('\n')), ['src/y/b-routes.mjs', 'src/y/c-store.mjs', 'src/x/d-routes.mjs', 'src/x/e-store.mjs']);
    assert.equal(sqlCount("await allIn(db, 'SELECT id FROM works WHERE id IN ('+q+')', ids)"), 1);
    assert.equal(sqlCount("const s = raw.prepare('INSERT OR IGNORE INTO a(x) VALUES(?)')"), 1);
    assert.equal(sqlCount('await db.run(`UPDATE ${table} SET x=? WHERE id=?`, p)'), 1);
    assert.equal(sqlCount("const t = ['SELECT', 'INPUT']; const u = {FROM: '差出'}; const l = '一覧は SELECT で選び FROM に書く'"), 0);
    assert.equal(sqlCount("// SELECT x FROM y は書かない\nconst label = 'Select a file'"), 0);
    assert.equal(dbCalls("app.use('/api/*', f); await db.all('SELECT 1 FROM a'); /* note */ db.run(q); await allIn(db, Q, ids)"), 3);
    assert.equal(dbCalls("const re = /['\"]/; const u = 'https://x'; db.all(q); const s = 'db.all(x)'"), 1);
    assert.equal(dbCalls('const rows = await db.readBatch(statements); d1.prepare(q).bind(1); await d1.batch(list)'), 3);
    assert.equal(clockReads('export function today(now = new Date()) { return now }'), 0);
    assert.equal(clockReads('export function f({now = new Date()} = {}) { return now }'), 0);
    assert.equal(clockReads('export function f(at = new Date().toISOString()) { return at }'), 0);
    assert.equal(clockReads('export const f = () => { const t = Date.now(), u = 1; return t }'), 1);
    assert.equal(clockReads('for (let t = Date.now(); t < n; t++) { go() }'), 1);
    assert.equal(clockReads('const x = ((d = new Date()) => d)()'), 1);
    assert.equal(clockReads('const a = Date(); const b = new Date; const c = performance.now(); const d = randomUUID(); const e = Temporal.Now.instant()'), 5);
    assert.equal(clockReads("const s = 'Date.now()'"), 0);
  });
}
