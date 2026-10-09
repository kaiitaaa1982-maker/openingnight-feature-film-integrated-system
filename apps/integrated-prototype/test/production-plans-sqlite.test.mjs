// 制作の見取り図の表（src/production.sql の production_location_plans）のうち、SQLite そのものを確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。
// LocalDatabase が開くたびに当てる SQLite の DDL（productionSql。CREATE TABLE IF NOT EXISTS）を、表を消した SQLite の DB に2回当て直しても既存の行が変わらないことを確かめる
// （PostgreSQL の表は pg/schema.sql で、この SQL は当てない）。元は production-plans.test.mjs の中にあった試験（2026-10-03、香盤表 #11 の PR7 で分けた。
// DB を試験の DB のファクトリで開くほかは中身を変えていない）。表の外部キー・CHECK の拒否は production-plans.test.mjs が両方の DB で確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import {productionSql} from '../src/db.mjs';
import {openTestDb} from './test-db.mjs';
test('additive plan table can be applied repeatedly without changing existing production locations',async(t)=>{
 const db=await openTestDb({t,kind:'sqlite'});try{
  db.raw.exec('DROP TABLE production_location_plans');
  await db.run("INSERT INTO production_locations(org_id,work_id,key,name,address) VALUES(1,1,'before','架空既存地点','既存住所')");
  const before=await db.all('SELECT * FROM production_locations');db.raw.exec(productionSql);db.raw.exec(productionSql);
  assert.deepEqual(await db.all('SELECT * FROM production_locations'),before);
  assert.equal((await db.get('SELECT COUNT(*) n FROM production_location_plans')).n,0);
  await assert.rejects(db.run('INSERT INTO production_location_plans(org_id,work_id,location_key,strokes_json) VALUES(?,?,?,?)',[1,1,'missing','[]']),/FOREIGN KEY/);
  await assert.rejects(db.run('INSERT INTO production_location_plans(org_id,work_id,location_key,strokes_json) VALUES(?,?,?,?)',[1,1,'before','{}']),/CHECK/);
  await assert.rejects(db.run('INSERT INTO production_location_plans(org_id,work_id,location_key,strokes_json) VALUES(?,?,?,?)',[1,1,'before',JSON.stringify(['x'.repeat(262144)])]),/CHECK/);
 }finally{db.close()}
});
