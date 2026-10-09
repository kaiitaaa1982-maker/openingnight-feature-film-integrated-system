// MG の段の締め日の移行（src/mg-migration.mjs の migrateMgCloseDays）を確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。
// SQLite の表（mg_version_phases）を古い CHECK で作り直し、node:sqlite の接続（db.raw）に SQLite だけの移行を当てて、行が変わらず、2回目は何もせず、
// 表のトリガーが締め日の変更を止めることを確かめる（PostgreSQL の表は pg/schema.sql で、この移行は当てない）。
// 元は mg-migration.test.mjs（2026-10-03、香盤表 #11 の PR7 で名前を変えた。DB を SQLite の試験の DB で開くほかは中身を変えていない）
import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,good} from './field-sales-independent-fixture.mjs';
import {mgSql} from '../src/db.mjs';
import {migrateMgCloseDays} from '../src/mg-migration.mjs';

test('MG phase migration preserves records and permits non-month-end closes',async(t)=>{
 const f=await fixture({t,kind:'sqlite'});try{
  const definition=mgSql.match(/CREATE TABLE IF NOT EXISTS mg_version_phases\s*\([\s\S]*?\);/)[0];
  f.db.raw.exec('DROP TABLE mg_version_phases');
  f.db.raw.exec(definition.replace("close_day='eom' OR (close_day NOT GLOB '*[^0-9]*' AND CAST(close_day AS INTEGER) BETWEEN 1 AND 31)","close_day IN ('28','29','30','31','eom')"));
  const c=good(await f.req('/mg/contracts',{direction:'incoming',code:'MIGRATION',title:'架空・日程移行',partnerId:2,contractDate:'2026-01-01',contractSourceReference:'架空資料',mgAmountYen:1000,startsOn:'2026-01-01',endsOn:'2026-12-31',mode:'single',reason:'検証',sourceReference:'架空条件',products:[{productId:1,evaluationYen:1000}],phases:[{startsOn:'2026-01-01',endsOn:'2026-12-31',intervalMonths:1,closeDay:'31',firstCloseOn:'2026-01-31',reportOffsetMonths:1,reportDay:31,payOffsetMonths:2,payDay:31}]}));
  const before=await f.db.all('SELECT * FROM mg_version_phases ORDER BY id');
  assert.equal(migrateMgCloseDays(f.db.raw,mgSql),true);
  assert.deepEqual(await f.db.all('SELECT * FROM mg_version_phases ORDER BY id'),before);
  assert.equal(migrateMgCloseDays(f.db.raw,mgSql),false);
  assert.throws(()=>f.db.raw.prepare('UPDATE mg_version_phases SET close_day=?').run('15'),/変更できません/);
  assert.equal((await f.req('/product-works',{productId:1,allocations:[{workId:1,allocationBps:10000}]})).status,409);
  assert.ok(c.versionId);
  assert.deepEqual(await foreignKeyViolations(f.db),[]);
 }finally{f.db.close()}
});
