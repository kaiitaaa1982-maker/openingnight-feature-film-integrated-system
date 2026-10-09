// 段1の DDL の変換（FR-CORE-DATA-017〜023）を確かめる。migrations/（SQLite・D1）を当てた空の SQLite と、
// 生成した pg/schema.sql を当てた PostgreSQL を比べる。
//
// PostgreSQL は既定で PGlite（手元・CI の npm test）。ON_TEST_PG_URL に手元の PostgreSQL（localhost だけ）を渡すと、
// 同じ試験をその DB で流す（CI の postgres:18-alpine のジョブ）。どちらも使い捨ての schema を作って、終わったら消す。
// 架空のデータだけを使う。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConvertError, convertExpression, convertMigrations, globToCheck, lf, OUTPUT_PATH, MIGRATIONS_DIR, renameRowAliases, tokenize, tree } from '../scripts/pg-ddl.mjs';
import {
  openPostgres, openSqlite, postgresSnapshot, postgresTriggerPairs, postgresTriggers, snapshotDiff, sqliteSnapshot, sqliteTriggerPairs, sqliteTriggers, triggerDiff,
} from './pg-schema-compare.mjs';

// ---------- 違反の試験の道具 ----------

const toDollar = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
function sqliteRun(db, sql, params = []) {
  try { db.prepare(sql).run(...params); return { ok: true }; } catch (error) { return { ok: false, message: error.message }; }
}
async function pgRun(pg, sql, params = []) {
  try { await pg.query(toDollar(sql), params); return { ok: true }; } catch (error) { return { ok: false, message: error.message, code: error.code }; }
}
async function both(ctx, sql, params = []) {
  return { sqlite: sqliteRun(ctx.sqlite, sql, params), pg: await pgRun(ctx.pg, sql, params) };
}
async function expectPass(ctx, sql, params = []) {
  const r = await both(ctx, sql, params);
  assert.ok(r.sqlite.ok, `SQLite で通るはず: ${r.sqlite.message}`);
  assert.ok(r.pg.ok, `PostgreSQL で通るはず: ${r.pg.message}`);
}
async function expectFail(ctx, sql, params = [], { message } = {}) {
  const r = await both(ctx, sql, params);
  assert.equal(r.sqlite.ok, false, 'SQLite で落ちるはず');
  assert.equal(r.pg.ok, false, 'PostgreSQL で落ちるはず');
  if (message) {
    assert.match(r.sqlite.message, message);
    assert.match(r.pg.message, message);
  }
  return r;
}

// 架空の組織・利用者・取引先（両方の DB に同じ行を入れる）
const BASE_ROWS = [
  "INSERT INTO organizations (id, code, name) VALUES (1, 'ORG1', '架空の組織')",
  "INSERT INTO users (id, email, display_name) VALUES (1, 'tester@example.invalid', '架空の利用者')",
  "INSERT INTO memberships (org_id, user_id, role, active) VALUES (1, 1, 'admin', 1)",
  "INSERT INTO partners (id, org_id, code, name) VALUES (1, 1, 'P001', '架空の取引先')",
];
const PAYMENT_TERM = `INSERT INTO partner_payment_term_versions (org_id, created_by, reason, partner_id, version_no, active, effective_from, closing_rule, closing_day, payment_month_offset, payment_rule, payment_day, payment_method)
  VALUES (1, 1, '架空の支払条件', ?, ?, 1, ?, 'day', ?, 1, 'month_end', NULL, 'transfer')`;

// ---------- 試験 ----------

const generated = convertMigrations();

test('変換できないものが無く、生成した DDL はリポジトリの pg/schema.sql と一致する（FR-CORE-DATA-017）', () => {
  assert.deepEqual(generated.errors, [], '変換できない形が出たら、黙って落とさずに一覧で止まる');
  assert.equal(lf(readFileSync(OUTPUT_PATH, 'utf8')), generated.sql, 'node scripts/pg-ddl.mjs で作り直してコミットする');
});

test('更新・削除などを無条件に拒むトリガーは共通の関数に、ほかは PL/pgSQL の関数になる（FR-CORE-DATA-019）', () => {
  const reject = generated.triggers.filter((t) => t.kind === 'reject');
  const functions = generated.triggers.filter((t) => t.kind === 'function');
  assert.ok(reject.length > 300, `共通の関数のトリガー ${reject.length}`);
  assert.equal(reject.length + functions.length, generated.triggers.length);
  assert.match(generated.sql, /CREATE FUNCTION lite_reject_change\(\)/);
  for (const t of functions) assert.match(generated.sql, new RegExp(`CREATE FUNCTION ${t.function}\\(\\) RETURNS trigger LANGUAGE plpgsql`));
});

test('トリガーの中の表の別名 old・new は、宣言した文の段だけ <別名>_row に言い換え、入れ子が OLD・NEW の行を指す形は断る（PL/pgSQL で OLD・NEW の行と区別できないため）', () => {
  const text = (sql) => {
    const flat = (nodes) => nodes.map((n) => (n.t === 'grp' ? `(${flat(n.items)})` : n.v)).join(' ');
    return flat(renameRowAliases(tree(tokenize(sql))));
  };
  assert.equal(
    text('SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM t old WHERE old.id=NEW.id AND old.k=NEW.k) THEN 1 END'),
    'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM t old_row WHERE old_row . id = NEW . id AND old_row . k = NEW . k) THEN 1 END',
  );
  // AS つき・JOIN の別名。副問い合わせの外の OLD.・NEW. はそのまま
  assert.equal(text('SELECT 1 FROM a JOIN b AS new ON new.id=a.id WHERE OLD.x=1'), 'SELECT 1 FROM a JOIN b AS new_row ON new_row . id = a . id WHERE OLD . x = 1');
  assert.equal(text('SELECT 1 FROM t WHERE (SELECT x FROM u old WHERE old.id=1)=OLD.id'), 'SELECT 1 FROM t WHERE (SELECT x FROM u old_row WHERE old_row . id = 1) = OLD . id');
  assert.equal(text('UPDATE t SET a=NEW.a WHERE id=OLD.id'), 'UPDATE t SET a = NEW . a WHERE id = OLD . id');
  assert.throws(() => renameRowAliases(tree(tokenize('SELECT old_row FROM t old WHERE old.id=1'))), ConvertError);
  // 言い換えるのは宣言した文だけ。; の後の文の OLD. は OLD の行
  assert.equal(
    text('INSERT INTO log SELECT old.x FROM u old WHERE old.id=1; UPDATE t SET a=OLD.a'),
    'INSERT INTO log SELECT old_row . x FROM u old_row WHERE old_row . id = 1 ; UPDATE t SET a = OLD . a',
  );
  // 関数などの式の括弧は宣言した段に含む
  assert.equal(text('SELECT coalesce(old.x, 0) FROM u old'), 'SELECT coalesce (old_row . x , 0) FROM u old_row');
  // 入れ子の副問い合わせの old.x を、SQLite は UPDATE・DELETE のトリガーでは OLD の行として読む（node:sqlite で、宣言した段は別名の行・
  // 入れ子は OLD の行を返す）。言い換えると意味が変わるので断る。INSERT のトリガーには OLD の行が無く、SQLite も別名として読むので言い換える
  const flatText = (nodes) => nodes.map((n) => (n.t === 'grp' ? `(${flatText(n.items)})` : n.v)).join(' ');
  const nested = 'SELECT old.x, (SELECT old.x) FROM u old WHERE old.id=1';
  for (const event of ['UPDATE', 'DELETE']) assert.throws(() => renameRowAliases(tree(tokenize(nested)), 'トリガー', event), ConvertError, event);
  assert.equal(flatText(renameRowAliases(tree(tokenize(nested)), 'トリガー', 'INSERT')), 'SELECT old_row . x , (SELECT old_row . x) FROM u old_row WHERE old_row . id = 1');
  const nestedNew = 'SELECT new.x FROM u new WHERE EXISTS (SELECT 1 FROM v WHERE v.id=new.id)';
  for (const event of ['UPDATE', 'INSERT']) assert.throws(() => renameRowAliases(tree(tokenize(nestedNew)), 'トリガー', event), ConvertError, event);
  assert.equal(flatText(renameRowAliases(tree(tokenize(nestedNew)), 'トリガー', 'DELETE')), 'SELECT new_row . x FROM u new_row WHERE EXISTS (SELECT 1 FROM v WHERE v . id = new_row . id)');
  // 入れ子が同じ名前の別名を自分で宣言していれば、入れ子の中はその別名として言い換える
  assert.equal(
    text('SELECT old.x FROM u old WHERE EXISTS (SELECT 1 FROM v old WHERE old.id=1)'),
    'SELECT old_row . x FROM u old_row WHERE EXISTS (SELECT 1 FROM v old_row WHERE old_row . id = 1)',
  );
  // 同じ文に UNION などがあれば、別名の届く範囲を読まずに断る
  assert.throws(() => renameRowAliases(tree(tokenize('SELECT old.x FROM u old UNION SELECT old.x FROM t'))), ConvertError);
  // 生成した DDL のトリガーには、old・new の別名が残っていない
  assert.doesNotMatch(generated.sql, /\b(?:FROM|JOIN)\s+\w+\s+(?:AS\s+)?(?:old|new)\b(?!\s*\.)/i);
  assert.match(generated.sql, /FROM mg_ledger_entries old_row WHERE old_row\.org_id = NEW\.org_id/);
});

test('INTEGER PRIMARY KEY は IDENTITY になり、初期データのあとに次の値を進める（FR-CORE-DATA-022）', () => {
  assert.ok(generated.identities.length > 100);
  for (const { table, column } of generated.identities) {
    const block = new RegExp(`\\nCREATE TABLE ${table} \\(\\n([\\s\\S]*?)\\n\\);`).exec(generated.sql)?.[1] ?? '';
    assert.match(block, new RegExp(`(^|\\n)  ${column} bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`), `${table}.${column}`);
    assert.ok(generated.sql.includes(`setval(pg_get_serial_sequence('${table}', '${column}')`), `${table} の setval`);
  }
});

test('SQLite と PostgreSQL で黙って意味が変わる形は、変換が止めて一覧に出す', () => {
  const stopped = {
    "c LIKE 'ab%'": /LIKE/, // SQLite は ASCII の大小を区別しない
    "c NOT LIKE 'ab%'": /LIKE/,
    "c REGEXP 'a'": /REGEXP/,
    "substr(d, -2) = 'xy'": /開始位置/, // SQLite は末尾から数える
    "substr(d, 0, 2) = 'x'": /開始位置/,
    'substr(d, n, 2) = 1': /開始位置/,
    'substr(d, 1, -2) = 1': /長さが負/,
    'e / 0 IS NULL': /で割る/, // SQLite は NULL、PostgreSQL は誤り
    'e / n > 1': /で割る/,
    'e / (n) > 1': /で割る/,
    'e % 2 = 0': /%/, // SQLite は整数に直してから余りを取る
    'round(f, 1) > 0': /桁数/, // SQLite は2進の値を丸める（round(0.35, 1) は 0.3）。numeric は 0.4
  };
  for (const [expr, message] of Object.entries(stopped)) assert.throws(() => convertExpression(expr), (error) => error instanceof ConvertError && message.test(error.message), expr);
  // いまの移行の形は通る
  assert.equal(convertExpression('substr(d, 1, 7) = m'), 'substr(d, 1, 7) = m');
  assert.equal(convertExpression('a / 1000000.0 + b / -2 + c / (3)'), 'a / 1000000.0 + b / - 2 + c / (3)');
  assert.equal(convertExpression('ROUND(a * (b / 1000000.0))'), 'round((a * (b / 1000000.0))::numeric)');

  // 移行の中にあれば、黙って落とさずに errors の一覧に出す（pg/schema.sql は書かない）
  const dir = mkdtempSync(join(tmpdir(), 'pg-ddl-stop-'));
  try {
    writeFileSync(join(dir, '0001_stop.sql'), [
      "CREATE TABLE t1 (id INTEGER PRIMARY KEY, c TEXT CHECK(c LIKE 'ab%'));",
      "CREATE TABLE t2 (id INTEGER PRIMARY KEY, d TEXT CHECK(substr(d,-2)='xy'));",
      'CREATE TABLE t3 (id INTEGER PRIMARY KEY, e INTEGER CHECK(e / 0 IS NULL));',
      'CREATE TABLE t4 (id INTEGER PRIMARY KEY, g INTEGER CHECK(g % id = 0));',
      'CREATE TABLE t5 (id INTEGER PRIMARY KEY, f REAL CHECK(round(f) > 0));',
    ].join('\n'));
    const result = convertMigrations({ dir });
    const stops = result.errors.filter((e) => e.startsWith('0001_stop.sql'));
    assert.equal(stops.length, 4, stops.join('\n'));
    assert.match(result.sql, /CHECK \(round\(\(f\)::numeric\) > 0\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GLOB の形の CHECK は、SQLite の GLOB と同じ文字列を通す（dialect.md の形の CHECK）', () => {
  const sqlite = new DatabaseSync(':memory:');
  const patterns = new Set();
  for (const file of readdirSync(MIGRATIONS_DIR)) for (const m of readFileSync(join(MIGRATIONS_DIR, file), 'utf8').matchAll(/GLOB\s*'((?:[^']|'')*)'/g)) patterns.add(m[1].replaceAll("''", "'"));
  assert.ok(patterns.size >= 20, `GLOB の形 ${patterns.size}`);
  const samples = ['', '2026-10', '2026-1', '2026-100', '202610', '20261', '2026-13', '２０２６-10', '2026-10-31', '2026-1x-01', '2026-10-3', 'abc', 'a_b', 'a-b', 'A', 'a', 'x', 'Z',
    '0', '5', '12', '31', '32', '3', '30', 'SUP-1', 'SUP-', 'SUP', 'sup-1', 'https://a', 'https://', 'http://x', 'http://', 'ftp://x', 'T0123456789012', 'T012345678901', 't0123456789012',
    '123-4567', '1234567', 'deadbeef', 'DEADBEEF', 'ab.c', 'a/b-c_d.e', 'a b', 'ＡＢＣ', 'ABC', '1a', 'abc_1', 'éa'];
  const mismatches = [];
  for (const pattern of patterns) {
    const check = globToCheck('x', pattern);
    const stmt = sqlite.prepare(`SELECT (x GLOB ?) AS glob, (${check}) AS converted FROM (SELECT ? AS x)`);
    for (const value of samples) {
      const r = stmt.get(pattern, value);
      if (Number(r.glob) !== Number(r.converted)) mismatches.push(`${pattern} / ${JSON.stringify(value)}: GLOB ${r.glob}・変換 ${r.converted}`);
    }
  }
  assert.deepEqual(mismatches, []);
});

describe('SQLite と PostgreSQL の比較', () => {
  const ctx = {};
  before(async () => {
    ctx.sqlite = openSqlite();
    ctx.pg = await openPostgres();
    await ctx.pg.exec(generated.sql);
  });
  after(async () => {
    ctx.sqlite?.close();
    await ctx.pg?.close();
  });

  test('トリガーの関数の中の式と文が、表の行の型で計画できる（PL/pgSQL は実行するまで型を見ないため）', async () => {
    const failures = [];
    let count = 0;
    for (const trigger of generated.triggers) {
      for (const check of trigger.checks) {
        count += 1;
        try { await ctx.pg.query(check.sql); } catch (error) { failures.push(`${trigger.name}: ${error.message}`); }
      }
    }
    assert.ok(count > 200, `確かめた式 ${count}`);
    assert.deepEqual(failures, []);
  });

  test('表・列（名前・NULL・既定値の有無・IDENTITY・型）・表ごとの CHECK の数・FK・索引（列と一意）が SQLite と一致する（FR-CORE-DATA-018）', async () => {
    const expected = sqliteSnapshot(ctx.sqlite);
    const actual = await postgresSnapshot(ctx.pg);
    assert.equal(expected.tables.length, 258); // 分析の2表も移行0011に含む。アプリの追加DDLはない
    const total = (snap) => Object.values(snap.checks).reduce((a, b) => a + b, 0);
    assert.ok(total(expected) > 800, `CHECK ${total(expected)}`);
    assert.ok(Object.values(expected.columns).flat().filter((c) => c.identity).length > 100, 'IDENTITY の列');
    assert.deepEqual(snapshotDiff(expected, actual), []);
  });

  test('トリガーの組（表×時機×事象・列の指定）の一覧が SQLite と一致する（FR-CORE-DATA-020）', async () => {
    const expected = sqliteTriggerPairs(ctx.sqlite);
    const actual = await postgresTriggerPairs(ctx.pg);
    assert.ok(expected.length > 300, `組 ${expected.length}`);
    assert.deepEqual(actual.filter((k) => !expected.includes(k)), [], 'SQLite に無い組');
    assert.deepEqual(expected.filter((k) => !actual.includes(k)), [], 'PostgreSQL に無い組');
  });

  test('トリガーを名前ごとに（表・時機・事象・列の指定・WHEN の有無・RAISE の文）比べ、SQLite と一致する（FR-CORE-DATA-020）', async () => {
    const expected = sqliteTriggers(ctx.sqlite);
    assert.equal(generated.triggers.length, Object.keys(expected).length, '変換は1対1で、SQLite のトリガーを1本も落とさない');
    assert.ok(Object.values(expected).filter((t) => t.when).length > 10, 'WHEN つき');
    assert.deepEqual(triggerDiff(expected, await postgresTriggers(ctx.pg)), []);
  });

  test('比べ方は、1か所のずれ（NOT NULL・既定値・IDENTITY・CHECK・索引・FK・トリガー）を見逃さない', async () => {
    const base = sqliteSnapshot(ctx.sqlite);
    const clone = () => JSON.parse(JSON.stringify(base));
    const notNull = clone();
    notNull.columns.users[1].notNull = false;
    assert.equal(snapshotDiff(base, notNull).length, 1);
    const index = clone();
    index.indexes.users = index.indexes.users.slice(1);
    assert.equal(snapshotDiff(base, index).length, 1);
    const fk = clone();
    fk.foreignKeys.memberships = [];
    assert.equal(snapshotDiff(base, fk).length, 1);
    const def = clone();
    def.columns.memberships.find((c) => c.name === 'active').hasDefault = false;
    assert.equal(snapshotDiff(base, def).length, 1);
    const identity = clone();
    identity.columns.users.find((c) => c.name === 'id').identity = false;
    assert.equal(snapshotDiff(base, identity).length, 1);
    const check = clone();
    check.checks.billing_invoice_sequences -= 1;
    assert.equal(snapshotDiff(base, check).length, 1);

    // トリガー: 組を他のトリガーと共有するもの（組の一覧では見えない）を消す・WHEN を外す・拒否の文を消す・時機を変える
    const triggers = sqliteTriggers(ctx.sqlite);
    const pairs = sqliteTriggerPairs(ctx.sqlite);
    const shared = Object.keys(triggers).find((name) => {
      const t = triggers[name];
      return Object.entries(triggers).some(([other, u]) => other !== name && u.table === t.table && u.timing === t.timing && u.event === t.event && JSON.stringify(u.columns) === JSON.stringify(t.columns));
    });
    assert.ok(shared, '組を共有するトリガーがある');
    const mutate = (fn) => { const copy = JSON.parse(JSON.stringify(triggers)); fn(copy); return copy; };
    const dropped = mutate((t) => { delete t[shared]; });
    assert.deepEqual(triggerDiff(triggers, dropped), [`PostgreSQL に無いトリガー: ${shared}`]);
    const pairsOf = (map) => [...new Set(Object.values(map).map((t) => `${t.table}|${t.timing}|${t.event}|${t.columns.join(',')}`))].length;
    assert.equal(pairsOf(dropped), pairsOf(triggers), '組の一覧だけでは、このずれは見えない');
    assert.ok(pairs.length < Object.keys(triggers).length);
    const withWhen = Object.keys(triggers).find((name) => triggers[name].when);
    assert.equal(triggerDiff(triggers, mutate((t) => { t[withWhen].when = false; })).length, 1);
    assert.equal(triggerDiff(triggers, mutate((t) => { t[withWhen].messages = []; })).length, 1);
    assert.equal(triggerDiff(triggers, mutate((t) => { t[withWhen].timing = 'AFTER'; })).length, 1);
  });

  test('IDENTITY: 移行が ID を指定して入れた初期データのあと、次に振る ID は既存の ID とぶつからない（FR-CORE-DATA-022）', async () => {
    // 架空の行を入れる前に確かめる（この describe の最初の試験）。初期データがあるのは recognition_bases（ID 1〜5）
    const seeded = [];
    for (const { table, column } of generated.identities) {
      const [row] = await ctx.pg.query(`SELECT count(*)::int AS n, COALESCE(max(${column}), 0)::int AS max FROM ${table}`);
      if (!row.n) continue;
      const [next] = await ctx.pg.query(`SELECT nextval(pg_get_serial_sequence('${table}', '${column}'))::int AS v`);
      seeded.push(`${table}: 最大 ${row.max}・次 ${next.v}`);
      assert.ok(next.v > row.max, `${table}: 次の ID ${next.v} が既存の最大 ${row.max} 以下`);
    }
    assert.deepEqual(seeded, ['recognition_bases: 最大 5・次 6']);
  });

  test('架空の組織・利用者・取引先が両方に入る', async () => {
    for (const sql of BASE_ROWS) await expectPass(ctx, sql);
    await expectPass(ctx, PAYMENT_TERM, [1, 1, '2026-10-01', 25]);
  });

  test('更新・削除の禁止（共通の関数）: 両方の DB で同じ文で落ちる', async () => {
    await expectFail(ctx, 'UPDATE partner_payment_term_versions SET reason = ? WHERE org_id = 1 AND partner_id = 1', ['書き換え'], { message: /expense record immutable/ });
    await expectFail(ctx, 'DELETE FROM partner_payment_term_versions WHERE org_id = 1 AND partner_id = 1', [], { message: /expense record immutable/ });
  });

  test('RAISE のトリガー（PL/pgSQL の関数・WHEN つき）: 版の飛ばしが両方で同じ文で落ち、正しい次の版は通る', async () => {
    await expectFail(ctx, PAYMENT_TERM, [1, 3, '2026-11-01', 25], { message: /stale expense version/ });
    await expectPass(ctx, PAYMENT_TERM, [1, 2, '2026-11-01', 25]);
  });

  test('WHEN つきの拒否（消費は1回だけ）: 1回目の更新は通り、2回目は両方で落ちる', async () => {
    await expectPass(ctx, "INSERT INTO release_window_import_previews (token, org_id, user_id, payload_json, expires_at) VALUES ('tok-1', 1, 1, '{}', '2099-01-01 00:00:00')");
    await expectPass(ctx, "UPDATE release_window_import_previews SET consumed = 1 WHERE token = 'tok-1'");
    await expectFail(ctx, "UPDATE release_window_import_previews SET consumed = 1 WHERE token = 'tok-1'", [], { message: /can only be consumed once/ });
  });

  test('CHECK（GLOB の形）: 年月の形の違反が両方で落ちる', async () => {
    await expectPass(ctx, 'INSERT INTO billing_invoice_sequences (org_id, year_month, last_number) VALUES (1, ?, 1)', ['202610']);
    for (const bad of ['2026-11', '20261', '２０２６１１']) {
      const r = await expectFail(ctx, 'INSERT INTO billing_invoice_sequences (org_id, year_month, last_number) VALUES (1, ?, 1)', [bad]);
      assert.equal(r.pg.code, '23514', `${bad}: PostgreSQL は CHECK の違反（23514）`);
    }
  });

  test('CHECK（date()）: 暦に無い日が両方で落ちる', async () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-2-01']) {
      const r = await expectFail(ctx, PAYMENT_TERM, [1, 3, bad, 25]);
      assert.equal(r.pg.code, '23514', `${bad}: PostgreSQL は CHECK の違反（23514）`);
    }
  });

  test('CHECK（typeof の整数）: 小数の値が両方で落ちる', async () => {
    await expectFail(ctx, PAYMENT_TERM, [1, 3, '2026-12-01', 15.5]);
  });

  test('FK: 無い参照先が両方で落ちる', async () => {
    const r = await expectFail(ctx, "INSERT INTO memberships (org_id, user_id, role, active) VALUES (1, 99, 'admin', 1)");
    assert.equal(r.pg.code, '23503');
    await expectFail(ctx, PAYMENT_TERM, [99, 1, '2026-10-01', 25]);
  });

  test('時刻の既定値は SQLite と同じ形（UTC の YYYY-MM-DD HH:MM:SS）の文字列（FR-CORE-DATA-023）', async () => {
    const [row] = await ctx.pg.query("SELECT created_at FROM partner_payment_term_versions WHERE org_id = 1 AND version_no = 1");
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const sqliteRow = ctx.sqlite.prepare('SELECT created_at FROM partner_payment_term_versions WHERE org_id = 1 AND version_no = 1').get();
    assert.match(sqliteRow.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('補助関数は SQLite の date・CAST・json_* と同じ結果を返す', async () => {
    const mismatches = [];
    const compare = async (label, sqliteSql, pgSql, values) => {
      for (const value of values) {
        const a = ctx.sqlite.prepare(sqliteSql).get(value).v;
        const b = (await ctx.pg.query(pgSql, [value]))[0].v;
        // 配列・オブジェクトの JSON の文字は空白の入れ方が違う（jsonb は「, 」）。解析した値で比べる（FR-CORE-DATA-051）
        const norm = (v) => {
          if (v === null || v === undefined) return null;
          const text = String(typeof v === 'boolean' ? Number(v) : v);
          if (/^[[{]/.test(text)) { try { return JSON.stringify(JSON.parse(text)); } catch { return text; } }
          return text;
        };
        if (norm(a) !== norm(b)) mismatches.push(`${label} ${JSON.stringify(value)}: SQLite ${a}・PostgreSQL ${b}`);
      }
    };
    await compare('date', "SELECT date(?, '+0 days') AS v", 'SELECT lite_date($1::text) AS v',
      ['2026-02-28', '2024-02-29', '2026-02-29', '2026-02-30', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32', '2026-1-01', '2026-01-01 10:00', '2026-01-01T10:00:00', 'abc', '',
        '0000-01-01', '0000-02-29', '0001-02-29', '0100-02-29', '0400-02-29', '1900-02-29', '9999-12-31', '9999-02-30']);
    // round は numeric に直して丸める（変換の round。PostgreSQL の round(double precision) は偶数へ丸める）
    await compare('round', 'SELECT round(x) AS v FROM (SELECT ? AS x)', `SELECT ${convertExpression('round(x)')} AS v FROM (SELECT $1::double precision AS x) s`, [2.5, -2.5, 0.5, 1.5, 2.4, -0.5]);
    // 2つの値の max・min は、どちらかが NULL なら NULL（PostgreSQL の greatest・least は NULL を飛ばす）
    await compare('max', 'SELECT max(0, ?) AS v', 'SELECT lite_max(0, $1::bigint) AS v', [5, -5, null]);
    await compare('min', 'SELECT min(3, ?) AS v', 'SELECT lite_min(3, $1::bigint) AS v', [5, -5, null]);
    await compare('cast', 'SELECT CAST(? AS INTEGER) AS v', 'SELECT lite_cast_int($1::text) AS v', ['12', '12abc', 'abc', '-3', ' 7', '3.9', '', '+5', '007']);
    const json = ['{"a":1}', '[1,2,3]', '[]', '"s"', '1', '1.5', 'true', 'null', '{', 'abc', '', '{"a":[{"b":"x"}]}'];
    await compare('json_valid', 'SELECT json_valid(?) AS v', 'SELECT lite_json_valid($1::text) AS v', json);
    const validJson = json.filter((j) => { try { JSON.parse(j); return true; } catch { return false; } });
    await compare('json_type', 'SELECT json_type(?) AS v', 'SELECT lite_json_type($1::text) AS v', validJson);
    await compare('json_array_length', 'SELECT json_array_length(?) AS v', 'SELECT lite_json_array_length($1::text) AS v', validJson);
    await compare('json_extract', "SELECT json_extract(?, '$.a') AS v", "SELECT lite_json_extract($1::text, '$.a') AS v", ['{"a":1}', '{"a":"x"}', '{"a":null}', '{"a":[1,2]}', '{"b":1}', '{"a":1.5}']);
    await compare('json_extract_path', "SELECT json_extract(?, '$.a[0].b') AS v", "SELECT lite_json_extract($1::text, '$.a[0].b') AS v", ['{"a":[{"b":"x"}]}', '{"a":[]}']);
    assert.deepEqual(mismatches, []);
  });
});

