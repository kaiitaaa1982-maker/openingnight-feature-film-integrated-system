// DB の定義書（docs/database/）が、空の DB と説明の辞書から作り直した結果とそろっているか、
// 辞書が全表・全列を説明しているかを確かめる（scripts/build-db-docs.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {plan, extractChecks, columnsIn, semantic, describeTable, dictionaryProblems} from '../scripts/build-db-docs.mjs';

const current = plan();

test('DB の定義書が、空の DB と辞書から作り直した結果とそろっている', () => {
  assert.deepEqual({differ: current.differ, stale: current.stale}, {differ: [], stale: []}, 'node scripts/build-db-docs.mjs で作り直す');
});

test('辞書が全表の領域・論理名・説明と全列の説明を持ち、DB に無い表や列の説明を残していない', () => {
  assert.deepEqual(current.problems, [], 'docs/database/dictionary.json を直してから作り直す');
});

test('CHECK を文字列とコメントの中では拾わず、1つの列だけを見る条件から型の中身を読む', () => {
  const sql = "CREATE TABLE t (a TEXT CHECK(a IN ('x','y')), -- CHECK(ignored)\n b TEXT NOT NULL DEFAULT 'CHECK(no)', m TEXT CHECK(m GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), f INTEGER CHECK(f IN (0,1)), CHECK(b<>a))";
  const checks = extractChecks(sql);
  assert.deepEqual(checks, ["a IN ('x','y')", "m GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'", 'f IN (0,1)', 'b<>a']);
  assert.deepEqual(columnsIn("b<>a AND 'c'=c", new Set(['a', 'b'])), ['b', 'a']);
  assert.deepEqual(semantic(checks[0], 'a'), {kind: '列挙', values: ['x', 'y']});
  assert.deepEqual(semantic(checks[1], 'm'), {kind: '年月 YYYY-MM'});
  assert.deepEqual(semantic(checks[2], 'f'), {kind: '真偽 0/1'});
  assert.deepEqual(semantic("m IS NULL OR m GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'", 'm'), {kind: '日付 YYYY-MM-DD'});
  assert.equal(semantic('m>=0', 'm'), null);
});

test('定義書の行は、主キー・参照・列挙・既定値・NULL を DB の定義どおりに書く', () => {
  const table = {
    name: 'child', checks: ["kind IN ('a','b')", 'qty>=0', 'b_id<>id'], triggers: [{name: 'child_locked', event: '更新の前'}],
    columns: [
      {name: 'id', type: 'INTEGER', notnull: false, dflt: null, pk: 1},
      {name: 'org_id', type: 'INTEGER', notnull: true, dflt: null, pk: 0},
      {name: 'b_id', type: 'INTEGER', notnull: false, dflt: null, pk: 0},
      {name: 'kind', type: 'TEXT', notnull: true, dflt: "'a'", pk: 0},
      {name: 'qty', type: 'INTEGER', notnull: true, dflt: '0', pk: 0},
      {name: 'at', type: 'TEXT', notnull: true, dflt: 'CURRENT_TIMESTAMP', pk: 0},
    ],
    fks: [{table: 'parent', from: ['org_id', 'b_id'], to: ['org_id', 'id']}, {table: 'organizations', from: ['org_id'], to: ['id']}],
    indexes: [{name: 'child_kind_idx', unique: false, origin: 'c', partial: false, columns: ['kind'], where: ''}],
  };
  const dict = {revisions: [], common: {id: '行のID'}, tables: {child: {domain: 'core', name: '子', description: '説明', columns: {kind: '種類'}}}};
  const {rows, extras} = describeTable(table, dict);
  assert.deepEqual(rows.map(r => [r.name, r.type, r.note, r.nullable, r.dflt, r.rules]), [
    ['id', 'INTEGER', '行のID', '不可', '-', 'PK'],
    ['org_id', 'INTEGER', '', '不可', '-', 'FK → organizations.id'],
    ['b_id', 'INTEGER', '', '可', '-', 'FK（複合）→ parent'],
    ['kind', 'TEXT（列挙）', '種類', '不可', 'a', '値: a / b'],
    ['qty', 'INTEGER', '', '不可', '0', 'CHECK: qty>=0'],
    ['at', 'TEXT', '', '不可', '現在時刻', '-'],
  ]);
  assert.deepEqual(extras, ['複合の参照: (org_id, b_id) → parent(org_id, id)', 'CHECK: b_id<>id', '索引 child_kind_idx: (kind)', 'トリガー child_locked: 更新の前']);
  assert.deepEqual(dictionaryProblems([table], dict), ['child.org_id: 列の説明が無い', 'child.b_id: 列の説明が無い', 'child.qty: 列の説明が無い', 'child.at: 列の説明が無い']);
  assert.deepEqual(dictionaryProblems([], dict), ['child: DB に無い表の説明が残っている']);
});
