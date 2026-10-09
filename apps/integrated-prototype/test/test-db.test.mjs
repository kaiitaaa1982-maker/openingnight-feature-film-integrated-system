// 試験の DB のファクトリ（test/test-db.mjs）の後始末。1つの close が落ちても、残りの DB は閉じ、失敗は最後に投げる
// （接続が残ると node --test の子プロセスが終わらず、CI が timeout まで止まる）
import test from 'node:test';
import assert from 'node:assert/strict';
import {closeAllTestDbs, foreignKeyViolations, hasTable, openTestDb, writeMark} from './test-db.mjs';

test('closeAllTestDbs は1つの close が落ちても残りを閉じ、失敗をまとめて投げる', async () => {
  const broken = await openTestDb({kind: 'sqlite'});
  const second = await openTestDb({kind: 'sqlite'});
  const third = await openTestDb({kind: 'sqlite'});
  const close = broken.close;
  broken.close = async () => { await close(); throw new Error('DROP DATABASE に失敗した（架空）'); };
  await assert.rejects(closeAllTestDbs(), /DROP DATABASE に失敗した/);
  assert.equal(broken.raw.isOpen, false);
  assert.equal(second.raw.isOpen, false);
  assert.equal(third.raw.isOpen, false);
  // 閉じたあとも開き直せる（土台と管理の接続は作り直す）
  const again = await openTestDb({kind: 'sqlite'});
  assert.equal((await again.get('SELECT 1 AS one')).one, 1);
  await again.close();
});

test('closeAllTestDbs は2つ以上の失敗を AggregateError で投げる', async () => {
  const a = await openTestDb({kind: 'sqlite'});
  const b = await openTestDb({kind: 'sqlite'});
  for (const db of [a, b]) {
    const close = db.close;
    db.close = async () => { await close(); throw new Error('閉じられない（架空）'); };
  }
  await assert.rejects(closeAllTestDbs(), (error) => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(a.raw.isOpen, false);
  assert.equal(b.raw.isOpen, false);
});

// 外部キーの違反の行を返す道具。違反が無ければ空、外部キーの強制が外れた表に違反の行があれば、その表を返す（両方の DB で流す）
test('foreignKeyViolations は違反が無ければ空で、強制を外して入れた違反の行を見つける', async (t) => {
  const db = await openTestDb({t});
  assert.deepEqual(await foreignKeyViolations(db), []);
  // 強制を外して、無い組織（架空の 999）を指す行を入れる。SQLite は foreign_keys=OFF、PostgreSQL は表の強制のトリガーを止める
  if (db.kind === 'sqlite') await db.run('PRAGMA foreign_keys=OFF');
  else await db.run('ALTER TABLE ai_usage DISABLE TRIGGER ALL');
  await db.run('INSERT INTO ai_usage(org_id, calls) VALUES(999, 0)');
  const found = await foreignKeyViolations(db);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].table, 'ai_usage');
  assert.equal(found[0].parent, 'organizations');
  // 強制を戻しても、残った違反の行は見つける（PostgreSQL の強制は、戻したあとの書き込みだけを見て、カタログにも跡が残らない）
  if (db.kind === 'sqlite') await db.run('PRAGMA foreign_keys=ON');
  else await db.run('ALTER TABLE ai_usage ENABLE TRIGGER ALL');
  const left = await foreignKeyViolations(db);
  assert.equal(left.length, 1, JSON.stringify(left));
  assert.equal(left[0].table, 'ai_usage');
  await db.run('DELETE FROM ai_usage WHERE org_id = 999');
  assert.deepEqual(await foreignKeyViolations(db), []);
});

// 書き込みの印。読み取りでは変わらず、値を変えない UPDATE・INSERT・DELETE と、ROLLBACK した INSERT で変わる（両方の DB で流す）
test('writeMark は読み取りで変わらず、書き込みで変わる', async (t) => {
  const db = await openTestDb({t});
  const before = await writeMark(db);
  await db.all('SELECT * FROM organizations ORDER BY id');
  await db.readBatch([{sql: 'SELECT COUNT(*) AS n FROM works'}, {sql: 'SELECT * FROM partners WHERE org_id = ?', params: [1]}]);
  await db.run('UPDATE organizations SET name = name WHERE id = 999');
  assert.deepEqual(await writeMark(db), before, '読み取りと、行に当たらない UPDATE は印を変えない');
  const marks = [before];
  const changed = async (label) => { const mark = await writeMark(db); assert.notDeepEqual(mark, marks.at(-1), label); marks.push(mark); };
  await db.run('UPDATE organizations SET name = name WHERE id = 1');
  await changed('値を変えない UPDATE');
  await db.run("INSERT INTO organizations(code, name) VALUES('DEMO-MARK', '架空の組織')");
  await changed('INSERT');
  await db.run("DELETE FROM organizations WHERE code = 'DEMO-MARK'");
  await changed('DELETE');
  await assert.rejects(db.batch([{sql: "INSERT INTO organizations(code, name) VALUES('DEMO-MARK2', '架空の組織')"}, {sql: 'INSERT INTO organizations(code, name) VALUES(NULL, NULL)'}]));
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM organizations WHERE code = 'DEMO-MARK2'")).n, 0);
  await changed('ROLLBACK した INSERT（自動の ID を使う）');
});

test('hasTable はある表だけを true にする（両方の DB で流す）', async (t) => {
  const db = await openTestDb({t});
  assert.equal(await hasTable(db, 'organizations'), true);
  assert.equal(await hasTable(db, 'no_such_table_demo'), false);
});
