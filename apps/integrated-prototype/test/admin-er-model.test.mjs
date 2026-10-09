import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {objects} from '../src/design-model.mjs';
import {readTableSchema} from '../src/admin/er-routes.mjs';
import {sqliteDefault} from '../src/admin/pg-catalog-store.mjs';
import {
  TABLE_LABELS, tableLabel, tableTitle, columnDisplayName, columnTypeLabel, searchTables, groupTablesByConcept, tablesForRole,
  tableLinks, linkText, columnRows, conceptsOf, OTHER_GROUP_ID,
} from '../src/admin/er-model.mjs';

async function liveTables(t, role = 'admin') {
  const db = await openTestDb({t});
  try {
    const app = createApp({db, mode: 'local'});
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: `${role}@openingnight.invalid`})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await app.request('/api/er', {headers: {cookie}});
    assert.equal(response.status, 200);
    return (await response.json()).tables;
  } finally {
    await db.close();
  }
}

test('いまのDBの表はすべて和名を持ち、和名の辞書に実在しない表が残らない', async (t) => {
  const tables = await liveTables(t);
  const names = new Set(tables.map((table) => table.name));
  assert.deepEqual(tables.filter((table) => !tableLabel(table.name)).map((table) => table.name), [], '和名の無い表');
  assert.deepEqual(Object.keys(TABLE_LABELS).filter((name) => !names.has(name)), [], 'DBに無い表の和名');
  assert.equal(tableTitle('no_such_table'), '和名未登録の表');
  assert.equal(tableTitle('sale_lines'), '売上明細');
});

test('業務のまとまりごとの並びは、各表をちょうど1回ずつ置き、まとまりに無い表は最後の「その他」に集める', async (t) => {
  const tables = await liveTables(t);
  const groups = groupTablesByConcept(tables, objects);
  const placed = groups.flatMap((group) => group.tables.map((table) => table.name));
  assert.equal(placed.length, tables.length);
  assert.equal(new Set(placed).size, tables.length);
  const other = groups.at(-1);
  assert.equal(other.id, OTHER_GROUP_ID);
  assert.ok(other.tables.some((table) => table.name === 'sessions'), 'ログインの表は業務のまとまりに入らない');
  for (const group of groups.slice(0, -1)) assert.ok(objects.some((object) => object.id === group.id));
  assert.deepEqual(conceptsOf('works', objects).map((concept) => concept.id).sort(), objects.filter((object) => object.tables.includes('works')).map((object) => object.id).sort());
});

test('制作担当には制作に関わるまとまりの表だけを見せる（金額の表を出さない）', async (t) => {
  const tables = await liveTables(t);
  const visible = tablesForRole(tables, 'production', objects);
  const allowed = new Set(objects.filter((object) => object.production).flatMap((object) => object.tables));
  assert.ok(visible.length > 0);
  assert.ok(visible.every((table) => allowed.has(table.name)));
  for (const finance of ['sale_lines', 'billing_invoices', 'mg_ledger_entries', 'expenses']) assert.ok(!visible.some((table) => table.name === finance), finance);
  assert.equal(tablesForRole(tables, 'admin', objects).length, tables.length);
  assert.equal(tablesForRole(tables, 'editor', objects).length, tables.length);
});

test('表は和名でも英字の表名でも探せ、全角・大文字の違いを吸収する', async (t) => {
  const tables = await liveTables(t);
  assert.ok(searchTables(tables, '売上明細').some((table) => table.name === 'sale_lines'));
  assert.ok(searchTables(tables, 'ＳＡＬＥ_LINES').some((table) => table.name === 'sale_lines'));
  assert.equal(searchTables(tables, '').length, tables.length);
  assert.equal(searchTables(tables, 'ありえない表の名前').length, 0);
});

test('参照の向き（参照する表・参照される表）と列の一覧は、和名・型・制約を日本語で出す', async (t) => {
  const tables = await liveTables(t);
  const links = tableLinks(tables, 'sale_lines');
  assert.ok(links.outgoing.length > 0);
  assert.ok(links.incoming.length > 0);
  assert.ok(links.outgoing.every((edge) => edge.from === 'sale_lines'));
  assert.ok(links.incoming.every((edge) => edge.to === 'sale_lines' && edge.from !== 'sale_lines'));
  const text = linkText(links.outgoing[0], 'outgoing');
  assert.equal(text.table, links.outgoing[0].to);
  assert.equal(text.title, tableTitle(links.outgoing[0].to));
  assert.match(text.pairs, /→/);

  const visibleOnly = tableLinks(tables.filter((table) => table.name !== 'works'), 'product_works');
  assert.ok(!visibleOnly.outgoing.some((edge) => edge.to === 'works'), '見えていない表への参照は出さない');

  const works = tables.find((table) => table.name === 'works');
  const rows = columnRows(works);
  const id = rows.find((row) => row.name === 'id');
  assert.equal(id.constraint, '主キー');
  assert.equal(id.type, '整数');
  assert.ok(rows.every((row) => ['主キー', '主キー（複合）', '必須', '空欄可'].includes(row.constraint)));
  assert.equal(columnDisplayName('reported_eligible_yen'), '消化対象', 'MGの金額の呼び名をそろえる');
  assert.equal(columnDisplayName('applied_recoup_yen'), '実充当');
  assert.equal(columnDisplayName('reported_overage_yen'), '超過報告');
  assert.equal(columnDisplayName('recognized_yen'), '計上');
  assert.equal(columnDisplayName('zzz_unknown'), null);
  assert.equal(columnTypeLabel('text'), '文字');
  assert.equal(columnTypeLabel(''), '指定なし');
  assert.match(columnTypeLabel('JSONB'), /その他/);

  const composite = columnRows({columns: [{name: 'a', pk: 1}, {name: 'b', pk: 2}, {name: 'c', notnull: 1}, {name: 'd'}]});
  assert.deepEqual(composite.map((row) => row.constraint), ['主キー（複合）', '主キー（複合）', '必須', '空欄可']);
});

// ER 図・データ一覧の表の定義（readTableSchema）は、SQLite（D1・LocalDatabase）では sqlite_master と PRAGMA、PostgreSQL では pg_catalog から読む。
// 同じ DDL から作った2つの DB で、表の一覧・並び・列（順番・名前・型・既定値・主キー）・外部キー（id・seq・参照先・列・動作）が同じになる。
// 違ってよいのは1つだけ: 主キーの列の notnull。PostgreSQL は主キーの列を必ず NOT NULL にする（実際の制約を返す）が、SQLite は宣言どおりで 0 のことがある
test('表の定義は SQLite と PostgreSQL で同じ形（違いは主キーの列の notnull だけ）', async (t) => {
  const lite = await openTestDb({t, kind: 'sqlite'});
  const pg = await openTestDb({t, kind: 'pg'});
  const [a, b] = [await readTableSchema(lite), await readTableSchema(pg)];
  assert.equal(a.definitionSource, 'table-valued');
  assert.equal(b.definitionSource, 'pg-catalog');
  assert.ok(a.tables.length > 200, `表 ${a.tables.length}`);
  assert.deepEqual(b.tables.map((table) => table.name), a.tables.map((table) => table.name));
  let pkNotNull = 0;
  for (const [index, table] of a.tables.entries()) {
    const other = b.tables[index];
    assert.deepEqual(other.foreignKeys, table.foreignKeys, `${table.name} の外部キー`);
    assert.equal(other.columns.length, table.columns.length, `${table.name} の列の数`);
    for (const [k, column] of table.columns.entries()) {
      const theirs = {...other.columns[k]};
      if (column.pk > 0 && column.notnull === 0 && theirs.notnull === 1) { theirs.notnull = 0; pkNotNull += 1; }
      assert.deepEqual(theirs, {...column}, `${table.name}.${column.name}`);
    }
  }
  assert.ok(pkNotNull > 0, '主キーの列の notnull の違いを数えた');
  // 型・既定値は SQLite の書き方で返す（画面の「整数」「文字」と既定値の表示を変えない）
  const works = b.tables.find((table) => table.name === 'works');
  assert.equal(works.columns.find((column) => column.name === 'id').type, 'INTEGER');
  assert.ok(b.tables.some((table) => table.columns.some((column) => column.dflt_value === 'CURRENT_TIMESTAMP')));
  assert.ok(b.tables.some((table) => table.columns.some((column) => column.dflt_value === "'draft'")));
  assert.ok(b.tables.some((table) => table.foreignKeys.some((fk) => fk.on_delete === 'CASCADE')));
});

test('PostgreSQL の既定値の書き方を SQLite の書き方に戻す', () => {
  assert.equal(sqliteDefault(null), null);
  assert.equal(sqliteDefault("'pending'::text"), "'pending'");
  assert.equal(sqliteDefault("'it''s'::text"), "'it''s'");
  assert.equal(sqliteDefault("''::text"), "''");
  assert.equal(sqliteDefault('0'), '0');
  assert.equal(sqliteDefault("'-1'::integer"), '-1');
  assert.equal(sqliteDefault("to_char((statement_timestamp() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD HH24:MI:SS'::text)"), 'CURRENT_TIMESTAMP');
  assert.equal(sqliteDefault('nextval(\'x\'::regclass)'), "nextval('x'::regclass)");
});
