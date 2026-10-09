// docs/rules/money.md のうち、機械で守れる部分を確かめる。
// - 金額・率・倍の名前の列（MONEY_COLUMN）は INTEGER。小数の文字で持つ控えの列だけを名前で許す（TEXT_MONEY）
// - 小数をそのまま保つ列（REAL・NUMERIC・型なし）は、許した列（FLOAT_COLUMNS）のほかに増やさない
// - 金額・率の INTEGER の列は、表の CHECK か INSERT と UPDATE のトリガーの typeof で整数を強制する
// - src で浮動小数点で金額を扱う形（SRC_KINDS）を増やさない。形に当たるが金額でない所は NOT_MONEY に理由と回数で許す
// 空の DB は LocalDatabase(':memory:')。npm run ci:migrations が移行後の D1 との形の一致を見ているので、D1 にも当てはまる。
// 借りは test/money-debt.json。直して数が減ったら、この JSON も減らす（減らし忘れも落ちる）。
// 一覧を作り直すとき: node test/money-rules.test.mjs --write （どの端末でも UTF-8 で書く）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {LocalDatabase} from '../src/db.mjs';
import {scanJs, matchParen} from './js-scan.mjs';
import {mentionsMoney} from './money-words.mjs';
export {MONEY_WORDS, mentionsMoney} from './money-words.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(app, 'src');
const debtPath = join(app, 'test', 'money-debt.json');

// ---------- DB の列 ----------

// 金額・率・倍の列。名前の終わりで見分ける（_id で終わる列や price_status・rate_date のような添え字の列は入らない）
export const MONEY_COLUMN = /(?:^|_)(?:yen|amount|tax|bps|price|fee|rate|total|cost|budget)$|_x\d+$/;

// 小数の文字（TEXT）で持ってよい金額の列。流通別の詳細の控えで、報告の原本の小数を写し、sale_lines と合算しない（src/channel-sales.sql）
const TEXT_MONEY = new Set([
  'digital_sale_details.calculated_actual_ex_tax',
  'digital_sale_details.contract_amount_ex_tax',
  'digital_sale_details.holder_unit_price_ex_tax',
  'digital_sale_details.reported_actual_ex_tax',
  'digital_sale_details.reported_recognized_ex_tax',
  'digital_sale_details.unit_price_ex_tax',
  'package_sale_details.average_rental_price_ex_tax',
  'package_sale_details.calculated_actual_ex_tax',
  'package_sale_details.holder_unit_price_ex_tax',
  'package_sale_details.reported_actual_ex_tax',
  'package_sale_details.reported_recognized_ex_tax',
  'theatrical_sale_details.calculated_actual_ex_tax',
  'theatrical_sale_details.gross_box_office_ex_tax',
  'theatrical_sale_details.reported_actual_ex_tax',
  'theatrical_sale_details.reported_recognized_ex_tax',
]);

// 小数をそのまま保つ列（REAL・NUMERIC・型なし）として許す列と理由。金額・率には使わない
const FLOAT_COLUMNS = new Map([
  ['observations.value_number', '宣伝の指標の値（再生数・率など。金額ではない）'],
  ['sale_attribute_values.value_number', '売上の追加の項目。型が yen・integer の項目はトリガーが整数を強制する（src/sales-sheet/sales-sheet.sql）'],
]);

// SQLite の型の親和性（https://www.sqlite.org/datatype3.html の 3.1 の順に判定）
export function affinity(declared) {
  const t = String(declared ?? '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'TEXT';
  if (!t.trim() || t.includes('BLOB')) return 'BLOB';
  if (/REAL|FLOA|DOUB/.test(t)) return 'REAL';
  return 'NUMERIC';
}

// 表ごとの列・CREATE 文・トリガーの文
export function readSchema(raw) {
  const objects = raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name").all();
  return objects.filter(o => o.type === 'table').map(t => ({
    name: t.name,
    sql: t.sql,
    columns: raw.prepare(`PRAGMA table_info("${t.name.replaceAll('"', '""')}")`).all().map(c => ({name: c.name, type: c.type})),
    triggers: objects.filter(o => o.type === 'trigger' && o.tbl_name === t.name).map(o => o.sql),
  }));
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// typeof(列) を 'integer' と比べる式（= 'integer'・<> 'integer'・IN ('integer')）。IN ('integer','real') は数えない
const typeofInteger = (column, prefix = '') => new RegExp(String.raw`\btypeof\s*\(\s*${prefix}["\x60\[]?${escapeRe(column)}["\x60\]]?\s*\)\s*(?:(?:==?|<>|!=|\bIS(?:\s+NOT)?)\s*'integer'|(?:NOT\s+)?IN\s*\(\s*'integer'\s*\))`, 'i');
const TRIGGER_EVENT = /\bTRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|[\w.]+)\s+(?:BEFORE\s+|AFTER\s+|INSTEAD\s+OF\s+)?(INSERT|DELETE|UPDATE)(?:\s+OF\s+([\s\S]+?))?\s+ON\s/i;

export function triggerEvent(sql) {
  const m = TRIGGER_EVENT.exec(sql);
  if (!m) return null;
  return {event: m[1].toUpperCase(), columns: m[2] ? m[2].split(',').map(s => s.trim().replace(/^["`[]|["`\]]$/g, '')) : null};
}

// 列に整数を強制しているか。表の CHECK か、INSERT と UPDATE の両方のトリガー（UPDATE OF ならその列を含む）の typeof(NEW.列)
export function guarded(table, column) {
  if (typeofInteger(column).test(table.sql)) return true;
  const events = table.triggers.filter(sql => typeofInteger(column, String.raw`NEW\s*\.\s*`).test(sql)).map(triggerEvent).filter(Boolean);
  return events.some(e => e.event === 'INSERT') && events.some(e => e.event === 'UPDATE' && (!e.columns || e.columns.includes(column)));
}

export function scanSchema(raw) {
  const out = {nonInteger: [], floatColumns: [], unguarded: {}};
  for (const table of readSchema(raw)) {
    for (const column of table.columns) {
      const key = `${table.name}.${column.name}`;
      const kind = affinity(column.type);
      if (kind !== 'INTEGER' && kind !== 'TEXT') out.floatColumns.push(key);
      if (!MONEY_COLUMN.test(column.name)) continue;
      if (kind !== 'INTEGER') out.nonInteger.push(key);
      else if (!guarded(table, column.name)) (out.unguarded[table.name] ||= []).push(column.name);
    }
  }
  return out;
}

// ---------- src の浮動小数点 ----------

export const SRC_KINDS = ['parseFloat', 'floatLiteral', 'roundScaled', 'roundMoney', 'roundBare', 'zeroFill', 'rateFormula', 'sqlFloat'];
const KIND_HINTS = {
  parseFloat: ['parseFloat で数を読む', '整数は integer（src/csv.mjs）・parseYen、小数は scaledInteger で整数倍に読む'],
  floatLiteral: ['小数の定数（0.35・1.1・1e9）で掛ける・割る', 'bp や10のべき乗倍の整数と BigInt で計算する'],
  roundScaled: ['小数を10のべき乗倍して Math.round・floor・ceil・trunc で整数にする（Math.round(Number(文字) * 100) で % を bp に）', '文字のまま整数倍に読む。% は percentToBps、外貨・数量・単価は scaledInteger（money.md）'],
  roundMoney: ['金額・率の式を Math.round・floor・ceil・trunc で丸める', 'BigInt で商と余りを出し、端数の処理を名前で選ぶ（money.md）'],
  roundBare: ['値を1つ Math.round・floor・ceil・trunc で黙って整数にする', '整数でなければ誤りか未確認として返す。金額でなければ NOT_MONEY に理由を書く'],
  zeroFill: ['読めない額を0にする（Number(額) || 0・isFinite(n) ? n : 0）', 'NULL か未確認のまま返し、合計に入れなかった件数を示す'],
  rateFormula: ['料率・配賦の BigInt の式（/ 10000n・% 10000n）を money*.mjs の外に書く', 'signedRateAmount・splitByAllocation などを呼ぶ。無ければ money*.mjs に足す'],
  sqlFloat: ['SQL で小数の定数・ROUND(・avg(・total(・AS REAL を使う', '整数の式にするか、アプリの関数で計算した整数を保存する'],
};

// 形に当たるが金額・率を計算していない所。ファイル → {形: 回数}。足すときは理由を書く
const NOT_MONEY = new Map([
  ['src/IncomeDashboard.jsx', {floatLiteral: 2}],        // グラフの棒の位置
  ['src/import/header-detect.mjs', {floatLiteral: 2, roundScaled: 1}], // 見出し行の推定の点数
  ['src/main.jsx', {floatLiteral: 1}],                   // 時刻（分をミリ秒に）
  ['src/production-plans.mjs', {roundScaled: 2}],        // 見取り図の座標と線幅（0〜1 の値を小数4桁に）
  ['src/ProductionLocationPlan.jsx', {roundScaled: 1}],  // 見取り図の座標（同上）
  ['src/reporting.mjs', {floatLiteral: 1}],              // 時刻（日本時間へ9時間ずらす）
  ['src/reports/scroll-follow.mjs', {parseFloat: 1}],    // CSS の scroll-margin-top
  ['src/shell/unsaved.mjs', {roundBare: 1}],             // 未保存の件数
  ['src/work/production-print.mjs', {roundBare: 1}],     // 台本の頁（1/8頁単位）
]);

// 料率・配賦の式を置いてよいファイル（money.mjs・money-allocation.mjs など。フォルダを問わない）
const MONEY_HOME = /(^|\/)money(?:-[a-z0-9-]+)?\.mjs$/;
// 金額・率を表す語（識別子を _ と大文字で区切った語）。total は件数やページにも使うので入れない

const FLOAT_NUMBER = String.raw`(?:\d[\d_]*)?\.\d[\d_]*(?:e[+-]?\d+)?|\d[\d_]*e[+-]?\d+`;
const FLOAT_LITERAL = new RegExp(String.raw`[*/]\s*(?:${FLOAT_NUMBER})(?![\w.])|(?<![\w$.])(?:${FLOAT_NUMBER})\s*[*/](?![*/])`, 'gi');
const PARSE_FLOAT = /\bparseFloat\s*\(/g;
const MATH_ROUND = /\bMath\s*\.\s*(?:round|floor|ceil|trunc)\s*\(/g;
// 丸めの引数で、10のべき乗（10・100・10_000・1e4 など。BigInt の 100n は入らない）を掛けている形
const POWER_OF_TEN = String.raw`(?:1(?:_?0)+|1e\+?\d+)`;
const SCALED = new RegExp(String.raw`(?<![\w$.*])${POWER_OF_TEN}\s*\*(?!\*)|(?<!\*)\*\s*${POWER_OF_TEN}(?![\w$.])`, 'i');
// 丸めの引数から、入れ子の丸めを除く（入れ子の丸めはそれ自体を別に数える）
const withoutNestedRounds = arg => {
  let out = arg;
  for (const m of arg.matchAll(MATH_ROUND)) {
    const close = matchParen(arg, m.index + m[0].length - 1);
    if (close > 0) out = out.slice(0, m.index) + ' '.repeat(close + 1 - m.index) + out.slice(close + 1);
  }
  return out;
};
const BARE_VALUE = /^\s*(?:Number\s*\(\s*)?[\w$.]+\s*\)?\s*$/;
const NUMBER_CALL = /\bNumber\s*\(/g;
const FINITE_OR_ZERO = /\bisFinite\s*\(\s*[\w$.]+\s*\)\s*\?[^:;?]*:\s*0(?![\d.])/g;
const RATE_FORMULA = /[/%]\s*10_?000n\b/g;
const SQL_WORD = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|WHERE|ROUND)\b/;
// avg・total も小数を返す（SQLite は REAL の Number、PostgreSQL は numeric で入口が Decimal の文字列にし、bigint の列へは黙って丸めて入る。dialect.md）
const SQL_FLOAT = /(?<![\w.])\d+\.\d+(?![\w.])|\bROUND\s*\(|\b(?:AVG|TOTAL)\s*\(|\bAS\s+(?:REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)\b/gi;

// SQL の文から、コメントと文字の中身を除いて、小数の定数・ROUND(・avg(・total(・AS REAL を数える
export function sqlFloats(sql) {
  const body = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  return (body.match(SQL_FLOAT) || []).length;
}

// テンプレートの文字の部分（${…} の式を除いた本文）。式は findings が別に読む
const templateText = s => s.expressions.reduceRight((value, e) => value.slice(0, e.start - s.start - 3) + ' _ ' + value.slice(e.end - s.start), s.value);

// JS・JSX の1ファイルで、形ごとの数。コメントと文字の中身は見ない（SQL の文字だけは sqlFloat で見る）。
// テンプレートの ${…} の中の式は、同じ形で数えて足す（入れ子のテンプレートはその式を読むときに数える）
export function findings(rel, text) {
  const {masked, strings} = scanJs(text);
  const out = Object.fromEntries(SRC_KINDS.map(k => [k, 0]));
  out.parseFloat = (masked.match(PARSE_FLOAT) || []).length;
  out.floatLiteral = (masked.match(FLOAT_LITERAL) || []).length;
  for (const m of masked.matchAll(MATH_ROUND)) {
    const open = m.index + m[0].length - 1;
    const arg = masked.slice(open + 1, matchParen(masked, open));
    if (SCALED.test(withoutNestedRounds(arg))) out.roundScaled++;
    else if (BARE_VALUE.test(arg)) out.roundBare++;
    else if (mentionsMoney(arg)) out.roundMoney++;
  }
  for (const m of masked.matchAll(NUMBER_CALL)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    if (close > 0 && /^\s*\|\|\s*0(?![\d.])/.test(masked.slice(close + 1, close + 16)) && mentionsMoney(masked.slice(open, close))) out.zeroFill++;
  }
  out.zeroFill += (masked.match(FINITE_OR_ZERO) || []).length;
  if (!MONEY_HOME.test(rel)) out.rateFormula = (masked.match(RATE_FORMULA) || []).length;
  const bodies = strings.map(s => (s.expressions ? templateText(s) : s.value));
  out.sqlFloat = bodies.filter(body => SQL_WORD.test(body)).reduce((n, body) => n + sqlFloats(body), 0);
  for (const e of strings.flatMap(s => s.expressions || [])) {
    for (const [kind, n] of Object.entries(findings(rel, e.value))) out[kind] += n;
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(mjs|jsx|js|sql)$/.test(entry.name)) out.push(path);
  }
  return out;
}
const toRel = path => relative(app, path).replaceAll('\\', '/');

// raw: ファイルごとの数（NOT_MONEY を引く前）。debt: NOT_MONEY を引いた残り（借り）。移行（migrations/）は src の SQL から作るので src で数える
export function scanSrc() {
  const raw = {};
  const debt = Object.fromEntries(SRC_KINDS.map(k => [k, {}]));
  for (const path of walk(src)) {
    const rel = toRel(path);
    const text = readFileSync(path, 'utf8');
    const found = rel.endsWith('.sql') ? {sqlFloat: sqlFloats(text)} : findings(rel, text);
    raw[rel] = found;
    const allowed = NOT_MONEY.get(rel) || {};
    for (const [kind, n] of Object.entries(found)) if (n > (allowed[kind] || 0)) debt[kind][rel] = n - (allowed[kind] || 0);
  }
  return {raw, debt};
}

function scanAll() {
  const db = new LocalDatabase(':memory:');
  try {
    return {schema: scanSchema(db.raw), src: scanSrc()};
  } finally {
    db.close();
  }
}

const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

if (process.argv.includes('--write')) {
  const now = scanAll();
  const out = {
    note: '返すべき借り。docs/rules/money.md に反しているもの。直したら減らす。足してはいけない（金額でない所は money-rules.test.mjs の NOT_MONEY に理由を書いて許す）',
    unguarded: sorted(now.schema.unguarded),
    ...Object.fromEntries(SRC_KINDS.map(k => [k, sorted(now.src.debt[k])])),
  };
  writeFileSync(debtPath, JSON.stringify(out, null, 1) + '\n', 'utf8');
  console.log(`書いた: ${relative(app, debtPath)}`);
} else {
  const debt = existsSync(debtPath) ? JSON.parse(readFileSync(debtPath, 'utf8').replace(/^﻿/, '')) : {};
  debt.unguarded ||= {};
  for (const k of SRC_KINDS) debt[k] ||= {};
  const now = scanAll();

  test('金額・率・倍の名前の列は INTEGER（小数の文字で持つ控えは名前で許した列だけ）', () => {
    assert.deepEqual([...now.schema.nonInteger].sort(), [...TEXT_MONEY].sort(),
      '金額は整数の円、率は bp、小数の要る値は _x100・_x10000 の整数で持つ。控えの列を足す・消すときは TEXT_MONEY を直す');
  });

  test('小数をそのまま保つ列（REAL・NUMERIC・型なし）が増えていない', () => {
    assert.deepEqual([...now.schema.floatColumns].sort(), [...FLOAT_COLUMNS.keys()].sort(),
      '数の列は INTEGER にする。金額でない小数の列を足すときは FLOAT_COLUMNS に理由を書く');
  });

  test('整数の強制（typeof）が無い金額・率の列が増えていない', () => {
    const added = Object.entries(now.schema.unguarded).flatMap(([table, columns]) =>
      columns.filter(c => !(debt.unguarded[table] || []).includes(c)).map(c => `${table}.${c}`));
    assert.deepEqual(added, [], `CHECK(typeof(列)='integer' AND 列 BETWEEN -9007199254740991 AND 9007199254740991) を付ける（money.md）`);
  });

  for (const kind of SRC_KINDS) {
    const [label, hint] = KIND_HINTS[kind];
    test(`src で増えていない: ${label}`, () => {
      const grew = Object.entries(now.src.debt[kind]).filter(([file, n]) => n > (debt[kind][file] || 0))
        .map(([file, n]) => `${file}: ${debt[kind][file] || 0} → ${n}`);
      assert.deepEqual(grew, [], hint);
    });
  }

  test('借りと許可の一覧は実態と合っている（直したら減らす）', () => {
    const stale = [
      ...Object.entries(debt.unguarded).flatMap(([table, columns]) =>
        columns.filter(c => !(now.schema.unguarded[table] || []).includes(c)).map(c => `unguarded ${table}.${c}`)),
      ...SRC_KINDS.flatMap(kind => Object.entries(debt[kind]).filter(([file, n]) => (now.src.debt[kind][file] || 0) < n)
        .map(([file, n]) => `${kind} ${file}: ${n} → ${now.src.debt[kind][file] || 0}`)),
      ...[...NOT_MONEY].flatMap(([file, kinds]) => Object.entries(kinds).filter(([kind, n]) => (now.src.raw[file]?.[kind] || 0) < n)
        .map(([kind, n]) => `NOT_MONEY ${file} ${kind}: ${n} → ${now.src.raw[file]?.[kind] || 0}`)),
    ];
    assert.deepEqual(stale, [], 'node test/money-rules.test.mjs --write で作り直す（NOT_MONEY は手で減らす）');
  });

  test('検査は金額・率の列の名前と型の親和性を見分ける', () => {
    for (const name of ['amount_yen', 'amount_ex_tax', 'tax_amount', 'source_tax', 'rate_bps', 'exchange_rate_x10000', 'quantity_x10000',
      'price', 'window_fee', 'total', 'production_cost', 'promotion_budget']) assert.ok(MONEY_COLUMN.test(name), name);
    for (const name of ['tax_category_version_id', 'price_status', 'price_tax_basis', 'rate_date', 'fee_order', 'window_fee_recipient',
      'payment_day', 'ratio_scale', 'value_number', 'total_count', 'amount_note']) assert.ok(!MONEY_COLUMN.test(name), name);
    assert.deepEqual(['INTEGER', 'BIGINT', 'TEXT', 'VARCHAR(20)', '', 'REAL', 'DOUBLE PRECISION', 'NUMERIC', 'DECIMAL(12,2)'].map(affinity),
      ['INTEGER', 'INTEGER', 'TEXT', 'TEXT', 'BLOB', 'REAL', 'REAL', 'NUMERIC', 'NUMERIC']);
  });

  test('「整数を強制している」の判定は、SQLite が 1000.5 を拒むかどうかと一致する', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec(`
        CREATE TABLE t_check (id INTEGER PRIMARY KEY, amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer'));
        CREATE TABLE t_nullable (id INTEGER PRIMARY KEY, amount_yen INTEGER CHECK(amount_yen IS NULL OR (typeof(amount_yen)='integer' AND amount_yen BETWEEN -9007199254740991 AND 9007199254740991)));
        CREATE TABLE t_plain (id INTEGER PRIMARY KEY, amount_yen INTEGER NOT NULL);
        CREATE TABLE t_loose (id INTEGER PRIMARY KEY, amount_yen INTEGER CHECK(typeof(amount_yen) IN ('integer','real')));
        CREATE TABLE t_other (id INTEGER PRIMARY KEY, amount_yen INTEGER, tax_yen INTEGER CHECK(tax_yen IS NULL OR typeof(tax_yen)='integer'));
        CREATE TABLE t_triggers (id INTEGER PRIMARY KEY, amount_yen INTEGER);
        CREATE TRIGGER t_triggers_insert BEFORE INSERT ON t_triggers WHEN typeof(NEW.amount_yen)<>'integer' BEGIN SELECT RAISE(ABORT,'integer'); END;
        CREATE TRIGGER t_triggers_update BEFORE UPDATE OF amount_yen ON t_triggers BEGIN
          SELECT CASE WHEN typeof(NEW.amount_yen) <> 'integer' THEN RAISE(ABORT,'integer') END;
        END;
        CREATE TABLE t_insert_only (id INTEGER PRIMARY KEY, amount_yen INTEGER);
        CREATE TRIGGER t_insert_only_insert BEFORE INSERT ON t_insert_only WHEN typeof(NEW.amount_yen)<>'integer' BEGIN SELECT RAISE(ABORT,'integer'); END;
      `);
      // 小数を入れる（INSERT）か、整数の行を小数へ書き換える（UPDATE）かのどちらかで、小数が入るか
      const acceptsFraction = table => {
        let accepted = false;
        try { raw.exec(`INSERT INTO ${table}(id, amount_yen) VALUES (1, 1000.5)`); accepted = true; } catch { /* 拒んだ */ }
        raw.exec(`INSERT INTO ${table}(id, amount_yen) VALUES (2, 1000)`);
        try { raw.exec(`UPDATE ${table} SET amount_yen = 1000.5 WHERE id = 2`); accepted = true; } catch { /* 拒んだ */ }
        return accepted;
      };
      const tables = new Map(readSchema(raw).map(t => [t.name, t]));
      const verdict = Object.fromEntries([...tables.keys()].map(name => [name, guarded(tables.get(name), 'amount_yen')]));
      assert.deepEqual(verdict, {t_check: true, t_insert_only: false, t_loose: false, t_nullable: true, t_other: false, t_plain: false, t_triggers: true});
      for (const name of tables.keys()) assert.equal(verdict[name], !acceptsFraction(name), name);
      assert.equal(raw.prepare('SELECT typeof(amount_yen) AS t FROM t_plain WHERE id = 1').get().t, 'real', 'INTEGER と宣言しただけの列は 1000.5 を REAL のまま保存する');
      assert.equal(guarded(tables.get('t_other'), 'tax_yen'), true);
      assert.deepEqual(scanSchema(raw).unguarded, {t_insert_only: ['amount_yen'], t_loose: ['amount_yen'], t_other: ['amount_yen'], t_plain: ['amount_yen']});
    } finally {
      raw.close();
    }
  });

  test('検査は浮動小数点で金額を扱う形を見逃さず、金額でない形・コメント・文字は数えない', () => {
    const only = (text, rel = 'src/x/x-model.mjs') => Object.fromEntries(Object.entries(findings(rel, text)).filter(([, n]) => n));
    assert.deepEqual(only('const a = Math.floor(180 * 0.35); const b = total / 1.1; const c = n / 1e9; const d = .5 * x'), {floatLiteral: 4});
    assert.deepEqual(only('const yen = Math.round(Math.abs(amount) * rate / 1_000_000) * Math.sign(amount)'), {roundMoney: 1});
    assert.deepEqual(only('const pct = Math.trunc(rateBps / 100)'), {roundMoney: 1});
    assert.deepEqual(only('const a = Math.round(n); const b = Math.trunc(Number(bps)); const c = Math.floor(row.value)'), {roundBare: 3});
    assert.deepEqual(only([
      'const a = Math.round(Number(text) * 100); const b = Math.floor(n*10000);',
      'const c = Math.trunc(Number(v[10] * 100)); const d = Math.round(rate * 1000) / 10; const e = Math.round(100 * share)',
    ].join('\n')), {roundScaled: 5});
    assert.deepEqual(only('const a = Math.round(1e4 * x)'), {floatLiteral: 1, roundScaled: 1});
    assert.deepEqual(only('const a = Math.round(Math.round(n * 100) / 100)'), {roundScaled: 1});
    assert.deepEqual(only('const s = `合計 ${Math.round(amount * 1.1)}円`'), {floatLiteral: 1, roundMoney: 1});
    assert.deepEqual(only('const s = `a${`b${Math.round(n)}`}c`; const t = `${x ? `${parseFloat(y)}` : ""}`'), {roundBare: 1, parseFloat: 1});
    assert.deepEqual(only('const q = `SELECT ROUND(x) FROM t WHERE a = ${Math.round(n)} AND b = ${"1.5"}`'), {sqlFloat: 1, roundBare: 1});
    assert.deepEqual(scanJs('const s = `a${f(`b${g}`)}c${"}"}`').strings.map(s => s.expressions?.map(e => e.value)), [['f(`b${g}`)', '"}"']]);
    assert.deepEqual(only('const a = Number(row.amount_yen) || 0; const b = Number.isFinite(n) ? Math.trunc(n) : 0'), {zeroFill: 2, roundBare: 1});
    assert.deepEqual(only('const a = parseFloat(t); const b = Number.parseFloat(t)'), {parseFloat: 2});
    assert.deepEqual(only('const fee = BigInt(v) * BigInt(bps) / 10000n, rest = v * BigInt(bps) % 10_000n'), {rateFormula: 2});
    assert.deepEqual(only('const fee = BigInt(v) * BigInt(bps) / 10000n', 'src/core/money.mjs'), {});
    assert.deepEqual(only("await db.all('SELECT ROUND(amount_yen * 1.08) FROM t')"), {sqlFloat: 2});
    assert.deepEqual(only([
      '// Math.round(amount * 0.1) はコメント',
      "const label = '税率 0.1 * 金額';",
      'const ym = Math.floor(index / 12); const pages = Math.ceil(total / size); const kb = Math.max(1, Math.round(bytes / 1000));',
      'const n = Number(row.count) || 0; const v = 1_000_000 * x; const separate = Math.round(generated / 2);',
      'const re = /\\d+\\.\\d+/g; const fee = sign * (BigInt(amount) * BigInt(bps) / base);',
      'const label = `${Math.floor(index / 12)}年 ${Math.ceil(bytes / 1024)}KB`; const big = Math.round(2 ** 10); const yen = BigInt(v) * 100n;',
      "await db.all(\"SELECT version FROM t WHERE label = '1.0'\")",
    ].join('\n')), {});
    assert.equal(sqlFloats("-- 1.5 はコメント\nCREATE TABLE t(x INTEGER CHECK(x GLOB '[0-9].[0-9]'));"), 0);
    assert.equal(sqlFloats('SELECT ROUND(a * (b / 1000000.0)), CAST(c AS REAL) FROM t /* 2.5 */'), 3);
    assert.equal(sqlFloats("SELECT avg(a_yen), total(b_yen), sum(c_yen) FROM t WHERE note = 'avg(x)'"), 2);
    assert.equal(mentionsMoney('row.amountIncTax'), true);
    assert.equal(mentionsMoney('exchange_rate_x10000'), true);
    assert.equal(mentionsMoney('separate + generated + ratio'), false);
  });
}
