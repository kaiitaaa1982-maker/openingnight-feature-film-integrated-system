// 分析の写しの抽出（FR-CORE-DATA-009・010）のうち、SQLite・D1 そのものを確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。
// - 本番の D1 の束ね（env.DB）と同じ形の素の API を node:sqlite の上に作り（d1Binding）、本番の入口 R2BackedD1Database が素の batch を1回だけ呼ぶこと、
//   LocalDatabase と同じ写しになることを確かめる（PostgreSQL の試験の DB では D1 の束ねを組めない）
// - SQLite のファイルを2つの接続（LocalDatabase と node:sqlite）で開き、抽出の途中に別の接続が書いても写しが1つの時点の行だけを含むことを、
//   node:sqlite の prepare を差し替えて書き込みを挟んで確かめる（PostgreSQL の2つの接続の試験は cloud-analytics-pg.test.mjs）
// 元は cloud-analytics.test.mjs の中にあった試験（2026-10-03、香盤表 #11 の PR7 で分けた。中身は変えていない）。組み立ては cloud-analytics-fixture.mjs。
// 入口だけで写しを確かめる部分と、R2 の層（R2LargeValueDatabase）を試験の DB の入口にかぶせた写しは cloud-analytics.test.mjs が両方の DB で流す。
// ここに残すのは D1 の束ねの模擬（素の batch を1回だけ呼ぶこと）と、SQLite のファイルを2つの接続で開く試験（2026-10-04 に見直した）
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalDatabase} from '../src/db.mjs';
import {R2BackedD1Database} from '../src/cloud-r2-db.mjs';
import {freezeAnalyticsSnapshot,sha256,snapshotTables} from '../src/cloud-analytics.mjs';
import {MemoryBucket,setup,plain,freezeArgs,stable} from './cloud-analytics-fixture.mjs';

// ---------- 分析の写しの抽出（FR-CORE-DATA-009・010。PG 計画 段1・香盤表 #10。PostgreSQL は test/cloud-analytics-pg.test.mjs） ----------

// 本番の D1 の束ね（env.DB）と同じ形の素の API を node:sqlite の上に作り、素の API の呼び出しを calls に数える。
// batch は文を一度に受け取り、1つのトランザクションで流す（D1 の素の batch と同じ）。afterStatement(index) は batch の文を1つ流すたびに呼ぶ
function d1Binding(raw,{afterStatement}={}){
 const calls={prepare:0,batch:0,all:0,first:0,run:0},batches=[];
 const exec=(sql,params)=>{const statement=raw.prepare(sql);if(!statement.columns().length)return {success:true,results:[],meta:{changes:Number(statement.run(...params).changes)}};return {success:true,results:statement.all(...params),meta:{changes:0}}};
 const prepared=(sql,params)=>({sql,params,bind:(...next)=>prepared(sql,next),all:async()=>{calls.all++;return exec(sql,params)},first:async()=>{calls.first++;return exec(sql,params).results[0]??null},run:async()=>{calls.run++;return exec(sql,params)}});
 return {calls,batches,prepare(sql){calls.prepare++;return prepared(sql,[])},async batch(statements){calls.batch++;batches.push(statements.length);raw.exec('BEGIN');try{const out=statements.map((s,index)=>{const result=exec(s.sql,s.params);afterStatement?.(index);return result});raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}}};
}
// LocalDatabase（node:sqlite）が文の行を読むたびに after(index) を呼ぶ（raw の prepare を包む）。戻り値を呼ぶと外す
function hookStatements(db,after){
 const raw=db.raw;let index=0;
 const wrap=(target,override)=>new Proxy(target,{get(t,key){if(key in override)return override[key];const value=t[key];return typeof value==='function'?value.bind(t):value}});
 db.raw=wrap(raw,{prepare:sql=>{const statement=raw.prepare(sql);return wrap(statement,{all:(...params)=>{const rows=statement.all(...params);after(index++);return rows}})}});
 return ()=>{db.raw=raw};
}
// 写しの定義（表・列・組織の絞り込み）どおりに、入口を通さず node:sqlite で表ごとに読んだ行
const directRows=(raw,orgId)=>Object.fromEntries(Object.entries(snapshotTables).map(([table,columns])=>{const global=table.startsWith('distribution_');return [table,plain(raw.prepare(`SELECT ${columns} FROM ${table}${global?'':' WHERE org_id=?'}`).all(...(global?[]:[orgId])))]}));
const statementCount=Object.keys(snapshotTables).length+2; // 写しの表＋監査の上限＋管理者の確かめ

test('FR-CORE-DATA-010 分析の写しは入口の読み取りの一括で読み、表・列・行・audit_through・管理者の確かめが前と同じ（LocalDatabase と本番の D1 の入口）',async(t)=>{
 const f=await setup({t,kind:'sqlite'});
 try{
  await f.db.run("INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(2,4,'test','works','2','{}')");
  const expected=directRows(f.db.raw,1),auditThrough=(await f.db.get('SELECT MAX(id) n FROM audit_log WHERE org_id=1')).n;
  assert.ok(auditThrough>0&&expected.sale_lines.length&&expected.works.length&&expected.distribution_types.length,'架空の行がある表で確かめる');
  assert.ok((await f.db.get('SELECT count(*) n FROM works WHERE org_id=2')).n>0,'組織2の行もある');
  // 本番の入口は R2BackedD1Database（src/cloud-runtime.mjs）。readBatch が D1 の素の batch を1回だけ呼ぶ
  const binding=d1Binding(f.db.raw),cloud=new R2BackedD1Database(binding,new MemoryBucket(),{maxBatchStatements:500});
  const local=await freezeAnalyticsSnapshot({db:f.db,...freezeArgs}),d1=await freezeAnalyticsSnapshot({db:cloud,...freezeArgs});
  assert.deepEqual(binding.calls,{prepare:statementCount,batch:1,all:0,first:0,run:0});
  assert.deepEqual(binding.batches,[statementCount]);
  for(const snap of [local,d1]){
   assert.deepEqual(Object.keys(snap),['formatVersion','runId','source','registrationId','orgId','definitionVersion','asOf','exportedAt','auditThrough','tables','frozenHash']);
   const {frozenHash,...payload}=snap;assert.equal(frozenHash,await sha256(JSON.stringify(payload)));
   assert.deepEqual(Object.keys(snap.tables),Object.keys(snapshotTables));
   for(const [table,columns] of Object.entries(snapshotTables)){
    assert.deepEqual(snap.tables[table].columns,columns.split(','),table);
    assert.deepEqual(plain(snap.tables[table].rows),expected[table],table);
    for(const row of snap.tables[table].rows)assert.deepEqual(Object.keys(row),columns.split(','),table);
   }
   assert.equal(snap.auditThrough,auditThrough);
   assert.equal(snap.tables.works.rows.some(r=>r.id===2),false);
   assert.equal(Object.keys(snap.tables).includes('users'),false);
   assert.deepEqual([snap.formatVersion,snap.source,snap.orgId,snap.asOf],[1,'registered-synthetic-workbench',1,'2026-09-22']);
  }
  assert.deepEqual(stable(d1),stable(local));
  // 管理者の確かめも同じ一括の中で行う。失効・無効・管理者でない利用者・別の組織の管理者は 403
  for(const [change,undo,userId] of [
   ["UPDATE memberships SET expires_at='2000-01-01T00:00:00Z' WHERE org_id=1 AND user_id=1",'UPDATE memberships SET expires_at=NULL WHERE org_id=1 AND user_id=1',1],
   ['UPDATE memberships SET active=0 WHERE org_id=1 AND user_id=1','UPDATE memberships SET active=1 WHERE org_id=1 AND user_id=1',1],
   [null,null,2],[null,null,4]
  ]){
   if(change)await f.db.run(change);
   for(const db of [f.db,cloud])await assert.rejects(freezeAnalyticsSnapshot({db,...freezeArgs,userId}),e=>e.status===403&&/権限が失効/.test(e.message));
   if(undo)await f.db.run(undo);
  }
  assert.equal((await freezeAnalyticsSnapshot({db:f.db,...freezeArgs})).auditThrough,auditThrough);
 }finally{f.db.close()}
});

test('FR-CORE-DATA-009 FR-CORE-DATA-010 分析の写しの抽出の途中に別の接続が書いても、写しは1つの時点の行だけを含む（LocalDatabase と本番の D1 の入口）',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cloud-analytics-snapshot-')),file=join(dir,'synthetic.sqlite');
 const db=new LocalDatabase(file),writer=new DatabaseSync(file);
 try{
  writer.exec('PRAGMA busy_timeout=5000');
  await db.run("INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(1,1,'test','partners','seed','{}')");
  // 別の要求の書き込み（取引先を1行足して監査に記録する）。WAL なので、読み取りのトランザクションの途中でも書いて確定できる
  const write=code=>{writer.exec(`BEGIN;INSERT INTO partners(org_id,code,name) VALUES(1,'${code}','抽出の途中に足した架空の取引先');INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(1,1,'create','partners','${code}','{}');COMMIT`);return writer.prepare('SELECT count(*) n FROM partners WHERE code=?').get(code).n};
  const audit=async()=>(await db.get('SELECT MAX(id) n FROM audit_log WHERE org_id=1')).n;
  const writeOnce=code=>{const state={at:null};return {state,after:index=>{if(state.at===null){state.at=index;assert.equal(write(code),1,'書き込みを確定した')}}}};
  const check=async(snap,code,before)=>{
   assert.equal(snap.tables.partners.rows.some(r=>r.code===code),false,'途中に足した行は写しに入らない');
   assert.ok(snap.tables.partners.rows.length>0);
   assert.equal(snap.auditThrough,before,'監査の上限も抽出を始めた時点のまま');
   assert.deepEqual(plain(await db.all('SELECT code FROM partners WHERE code=?',[code])),[{code}],'書き込みは確定している');
   assert.equal(await audit(),before+1);
  };
  // 対照: 入口の all を並べると、途中の書き込みが後の読み取りに見える（この試験が書き込みを本当に挟めている）
  const control=writeOnce('CONTROL');let unhook=hookStatements(db,control.after);
  try{await db.all('SELECT id FROM committee_report_snapshots WHERE org_id=?',[1]);assert.ok((await db.all('SELECT code FROM partners WHERE org_id=?',[1])).some(r=>r.code==='CONTROL'))}finally{unhook()}
  assert.equal(control.state.at,0);
  // LocalDatabase の readBatch: 1つ目の文を読んだあとに別の接続が書いても、残りの文は書く前の時点を読む
  let before=await audit();const local=writeOnce('MID-LOCAL');unhook=hookStatements(db,local.after);
  let snap;try{snap=await freezeAnalyticsSnapshot({db,...freezeArgs})}finally{unhook()}
  assert.equal(local.state.at,0);
  await check(snap,'MID-LOCAL',before);
  // 本番の D1 の入口（R2BackedD1Database → 素の batch を1回）: 同じく1つ目の文のあとに別の接続が書く
  before=await audit();const cloud=writeOnce('MID-D1'),reader=new DatabaseSync(file);
  try{
   const binding=d1Binding(reader,{afterStatement:cloud.after});
   snap=await freezeAnalyticsSnapshot({db:new R2BackedD1Database(binding,new MemoryBucket(),{maxBatchStatements:500}),...freezeArgs});
   assert.equal(cloud.state.at,0);
   assert.deepEqual([binding.calls.batch,binding.batches],[1,[statementCount]]);
  }finally{reader.close()}
  await check(snap,'MID-D1',before);
 }finally{writer.close();db.close();rmSync(dir,{recursive:true,force:true})}
});
