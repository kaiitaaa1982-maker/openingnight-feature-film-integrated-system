import test from 'node:test';
import assert from 'node:assert/strict';
import {R2BackedD1Database,R2LargeValueDatabase,cloudR2Internals} from '../src/cloud-r2-db.mjs';
import {D1Database} from '../src/d1-db.mjs';
import {PgDatabase} from '../src/data-platform/pg-db.mjs';
import {readTableSchema} from '../src/admin/er-routes.mjs';
import {openTestDb} from './test-db.mjs';

class Bucket{constructor(){this.values=new Map()}async head(key){const row=this.values.get(key);return row?{customMetadata:row.metadata}:null}async put(key,value,options){this.values.set(key,{bytes:new Uint8Array(value),metadata:options.customMetadata});return {key}}async get(key){const row=this.values.get(key);return row?{body:true,arrayBuffer:async()=>row.bytes.buffer.slice(row.bytes.byteOffset,row.bytes.byteOffset+row.bytes.byteLength)}:null}}
class Binding{constructor(){this.last=null;this.firstResult=null;this.batchFails=false}prepare(sql){const self=this;return {bind(...params){return {run:async()=>{self.last={sql,params};return {success:true,meta:{changes:1,last_row_id:1}}},first:async()=>self.firstResult,all:async()=>({results:self.firstResult?[self.firstResult]:[]})}}}}async batch(statements){if(this.batchFails)throw new Error('batch failed');return Promise.all(statements.map(statement=>statement.run()))}}

test('経費の原本もR2へ外出しして元のbytesを読戻せる',async()=>{const binding=new Binding(),bucket=new Bucket(),db=new R2BackedD1Database(binding,bucket),raw=Buffer.alloc(180000,9).toString('base64');await db.run('INSERT INTO expense_source_files(id,org_id,file_name,original_base64) VALUES(?,?,?,?)',[1,1,'証憑（架空）.bin',raw]);const marker=binding.last.params[3];assert.ok(marker.startsWith(cloudR2Internals.markerPrefix));assert.ok(Buffer.byteLength(marker)<128*1024);binding.firstResult={original_base64:marker};assert.equal((await db.get('SELECT original_base64 FROM expense_source_files')).original_base64,raw);});

test('R2-backed D1 stores artifact bytes out of row and hydrates transparently',async()=>{const binding=new Binding(),bucket=new Bucket(),db=new R2BackedD1Database(binding,bucket),raw=Buffer.alloc(200_000,7).toString('base64');await db.run('INSERT INTO workbench_source_artifacts(id,org_id,name,media_type,raw_base64,source_hash,byte_length,extraction_json,created_by) VALUES(?,?,?,?,?,?,?,?,?)',['a',1,'x.xlsx','x',raw,'h',1,'{}',1]);const stored=binding.last.params[4];assert.ok(stored.startsWith(cloudR2Internals.markerPrefix));assert.notEqual(stored,raw);binding.firstResult={raw_base64:stored};assert.equal((await db.get('SELECT raw_base64 FROM workbench_source_artifacts')).raw_base64,raw)});
test('R2 hash mismatch and D1 batch failure never expose a partial database reference',async()=>{const binding=new Binding(),bucket=new Bucket(),db=new R2BackedD1Database(binding,bucket),large='x'.repeat(200_000);binding.batchFails=true;await assert.rejects(()=>db.batch([{sql:'INSERT INTO workbench_snapshots(id,rows_json) VALUES(?,?)',params:['s',large]}]),/batch failed/);assert.equal(binding.last,null);const stored=await db.store(large,{force:true}),ref=cloudR2Internals.parseMarker(stored);bucket.values.get(ref.key).bytes[0]^=1;await assert.rejects(()=>db.hydrateValue(stored),/完全性/)});
test('oversized atomic batches fail before writing R2 or D1',async()=>{const binding=new Binding(),bucket=new Bucket(),db=new R2BackedD1Database(binding,bucket,{maxBatchStatements:2}),large='x'.repeat(200_000);await assert.rejects(()=>db.batch([1,2,3].map(index=>({sql:'INSERT INTO workbench_snapshots(id,rows_json) VALUES(?,?)',params:[String(index),large]}))),/exceeds 2/);assert.equal(bucket.values.size,0);assert.equal(binding.last,null)});
test('reserved markers cannot be injected through ordinary columns',async()=>{const binding=new Binding(),bucket=new Bucket(),db=new R2BackedD1Database(binding,bucket),literal='@r2:v1:private/workbench/sha256/aa/'+('a'.repeat(64))+':'+('a'.repeat(64))+':1';await assert.rejects(()=>db.run('INSERT INTO works(id,title) VALUES(?,?)',[1,literal]),/予約済み/);binding.firstResult={title:literal};assert.equal((await db.get('SELECT title FROM works')).title,literal);await assert.rejects(()=>db.run('INSERT INTO works(id,title) VALUES(?,?)',[1,'x'.repeat(200_000)]),/D1行内/)});

// ---------- R2 の層を試験の DB の入口にかぶせる（FR-CORE-DATA-008。PG 計画 段2の準備） ----------
// 上の5件は本番の D1 の入口（R2BackedD1Database と D1 の束ねの模擬）。ここからは包み（R2LargeValueDatabase）を、ファクトリの本物の入口
// （SQLite は LocalDatabase、PostgreSQL は PgDatabase。ON_TEST_DB で選ぶ。npm run test:pg で PostgreSQL）にかぶせ、行を DB に書いて読み戻す
const SNAPSHOT_INSERT='INSERT INTO workbench_snapshots(id,org_id,dataset,scope_json,rows_json,content_hash,created_by) VALUES(?,?,?,?,?,?,?)';
const snapshot=(id,{dataset='架空の売上',rows='[]'}={})=>({sql:SNAPSHOT_INSERT,params:[id,1,dataset,'{}',rows,'h-'+id,1]});
const countSnapshots=async db=>Number((await db.get('SELECT count(*) AS n FROM workbench_snapshots')).n);

test('FR-CORE-DATA-008 包みを試験の DB の入口にかぶせると、外へ逃がす列は R2 の印になり、読み戻すと元の値になる（get・all・batch・readBatch）',async t=>{
 const db=await openTestDb({t}),bucket=new Bucket(),wrapped=new R2LargeValueDatabase(db,bucket);
 assert.equal(wrapped.dialect,db.kind==='pg'?'postgres':undefined,'DB の種類の印は内側の入口のもの');
 assert.equal(wrapped.maxBatchStatements,null,'文の数の上限は既定で持たない');
 const raw=Buffer.alloc(200_000,7).toString('base64'),big='x'.repeat(200_000);
 // 原本は大きさによらず R2 に置き、行には印だけを書く
 assert.deepEqual(await wrapped.run('INSERT INTO workbench_source_artifacts(id,org_id,name,media_type,raw_base64,source_hash,byte_length,extraction_json,created_by) VALUES(?,?,?,?,?,?,?,?,?)',['a',1,'架空.xlsx','x',raw,'h',150000,'{}',1]),{changes:1});
 const stored=await db.get('SELECT raw_base64,extraction_json FROM workbench_source_artifacts WHERE id=?',['a']);
 for(const value of [stored.raw_base64,stored.extraction_json]){assert.ok(cloudR2Internals.parseMarker(value),value.slice(0,40));assert.ok(Buffer.byteLength(value)<1024)}
 assert.deepEqual({...await wrapped.get('SELECT raw_base64,extraction_json FROM workbench_source_artifacts WHERE id=?',['a'])},{raw_base64:raw,extraction_json:'{}'});
 // 大きさで逃がす列は、128KB を超えた値だけを印にする。batch の RETURNING の行も読み戻す
 const results=await wrapped.batch([{...snapshot('big',{rows:big}),sql:SNAPSHOT_INSERT+' RETURNING id,rows_json'},snapshot('small',{rows:'[1]'})]);
 assert.deepEqual(results.map(r=>Number(r.changes)),[1,1]);
 assert.deepEqual(results[0].rows.map(r=>({...r})),[{id:'big',rows_json:big}]);
 const inner=Object.fromEntries((await db.all("SELECT id,rows_json FROM workbench_snapshots WHERE id IN ('big','small')")).map(r=>[r.id,r.rows_json]));
 assert.ok(cloudR2Internals.parseMarker(inner.big));
 assert.equal(inner.small,'[1]');
 assert.deepEqual((await wrapped.all("SELECT id,rows_json FROM workbench_snapshots WHERE id IN ('big','small') ORDER BY id")).map(r=>({...r})),[{id:'big',rows_json:big},{id:'small',rows_json:'[1]'}]);
 const [one,two]=await wrapped.readBatch([{sql:'SELECT rows_json FROM workbench_snapshots WHERE id=?',params:['big']},{sql:'SELECT raw_base64 FROM workbench_source_artifacts WHERE id=?',params:['a']}]);
 assert.equal(one[0].rows_json,big);
 assert.equal(two[0].raw_base64,raw);
 // INSERT … RETURNING を get で受け取るときも、書く前に R2 へ逃がす
 const returned=await wrapped.get(SNAPSHOT_INSERT+' RETURNING id,rows_json',snapshot('got',{rows:big}).params);
 assert.deepEqual({...returned},{id:'got',rows_json:big});
 assert.ok(cloudR2Internals.parseMarker((await db.get('SELECT rows_json FROM workbench_snapshots WHERE id=?',['got'])).rows_json));
 assert.equal(bucket.values.size,3,'同じ値は同じキー（原本・{}・大きな rows_json）');
});

test('FR-CORE-DATA-008 包みは、予約の印を混ぜた値と、逃がさない列の128KBを超える値を、どちらの DB でも書く前に断る（上限はオプションで外せる）',async t=>{
 const db=await openTestDb({t}),bucket=new Bucket(),wrapped=new R2LargeValueDatabase(db,bucket),before=await countSnapshots(db);
 const literal='@r2:v1:private/workbench/sha256/aa/'+('a'.repeat(64))+':'+('a'.repeat(64))+':1',big='x'.repeat(200_000);
 await assert.rejects(()=>wrapped.run(SNAPSHOT_INSERT,snapshot('m',{dataset:literal}).params),/予約済み/);
 await assert.rejects(()=>wrapped.batch([snapshot('ok'),snapshot('m',{dataset:literal})]),/予約済み/);
 await assert.rejects(()=>wrapped.run(SNAPSHOT_INSERT,snapshot('l',{dataset:big}).params),/D1行内/);
 await assert.rejects(()=>wrapped.batch([snapshot('ok'),snapshot('l',{dataset:big})]),/D1行内/);
 assert.equal(await countSnapshots(db),before,'断った文も、同じ batch の前の文も書いていない');
 // 128KB ちょうどは通り、1バイト超で断る（本番の D1 の入口と同じ境目）
 const edge='y'.repeat(cloudR2Internals.largeValueBytes);
 await wrapped.run(SNAPSHOT_INSERT,snapshot('edge',{dataset:edge}).params);
 await assert.rejects(()=>wrapped.run(SNAPSHOT_INSERT,snapshot('edge2',{dataset:edge+'y'}).params),/D1行内/);
 // 入口を通さずに入った印の形の文字は、逃がす列でなければ読み戻さない
 await db.run(SNAPSHOT_INSERT,snapshot('lit',{dataset:literal}).params);
 assert.equal((await wrapped.get('SELECT dataset FROM workbench_snapshots WHERE id=?',['lit'])).dataset,literal);
 // 逃がさない列の上限を外した包みは、大きな値をそのまま行に書く（予約の印は外しても断る）
 const unlimited=new R2LargeValueDatabase(db,bucket,{maxInlineValueBytes:null});
 await unlimited.run(SNAPSHOT_INSERT,snapshot('wide',{dataset:big}).params);
 assert.equal((await db.get('SELECT dataset FROM workbench_snapshots WHERE id=?',['wide'])).dataset,big);
 await assert.rejects(()=>unlimited.run(SNAPSHOT_INSERT,snapshot('m2',{dataset:literal}).params),/予約済み/);
 assert.equal(bucket.values.size,0,'断った文の大きな値も R2 に置いていない');
});

test('FR-CORE-DATA-007 FR-CORE-DATA-008 上限を渡さない包み（PostgreSQL の入口にかぶせる形）は batch の文の数で断らず、上限を渡した包みは R2 にも DB にも書く前に断る',async t=>{
 const db=await openTestDb({t}),bucket=new Bucket(),before=await countSnapshots(db);
 const wrapped=new R2LargeValueDatabase(db,bucket);
 const many=Array.from({length:600},(_,index)=>snapshot('n'+index));
 assert.equal((await wrapped.batch(many)).length,600,'D1 の500文を超えても1つのトランザクションで入る');
 assert.equal((await wrapped.readBatch(Array.from({length:600},()=>({sql:'SELECT 1 AS one'})))).length,600);
 assert.equal(await countSnapshots(db),before+600);
 const limited=new R2LargeValueDatabase(db,bucket,{maxBatchStatements:2}),large='x'.repeat(200_000);
 assert.equal(limited.maxBatchStatements,2);
 await assert.rejects(()=>limited.batch([1,2,3].map(index=>snapshot('o'+index,{rows:large}))),/D1 atomic batch exceeds 2 statements/);
 await assert.rejects(()=>limited.readBatch([1,2,3].map(()=>({sql:'SELECT 1 AS one'}))),/D1 atomic batch exceeds 2 statements/);
 await assert.rejects(()=>wrapped.batch(null),/文の配列/);
 assert.equal(bucket.values.size,0);
 assert.equal(await countSnapshots(db),before+600);
});

test('FR-CORE-DATA-008 包みは内側の入口の DB の種類を見せ、管理画面の表の定義は包みを通しても入口と同じ',async t=>{
 const db=await openTestDb({t}),wrapped=new R2LargeValueDatabase(db,{get(){throw new Error('定義を読むのに R2 を読まない')}});
 assert.deepEqual(await readTableSchema(wrapped),await readTableSchema(db));
});

test('FR-CORE-DATA-008 PgDatabase にかぶせた包みは、DB の種類が postgres で文の数の上限を持たず、外へ逃がす列を R2 の印にして読み戻す',async t=>{
 const db=await openTestDb({t,kind:'pg'}),bucket=new Bucket(),wrapped=new R2LargeValueDatabase(db,bucket);
 assert.ok(db instanceof PgDatabase);
 assert.deepEqual([wrapped.dialect,wrapped.maxBatchStatements],['postgres',null]);
 const raw=Buffer.alloc(150_000,3).toString('base64');
 await wrapped.run('INSERT INTO expense_source_files(org_id,created_by,reason,id,file_name,media_type,byte_length,raw_sha256,original_base64) VALUES(?,?,?,?,?,?,?,?,?)',[1,1,'架空の証憑',9001,'証憑（架空）.bin','application/octet-stream',150000,'b'.repeat(64),raw]);
 assert.ok(cloudR2Internals.parseMarker((await db.get('SELECT original_base64 FROM expense_source_files WHERE id=?',[9001])).original_base64));
 assert.equal((await wrapped.get('SELECT original_base64 FROM expense_source_files WHERE id=?',[9001])).original_base64,raw);
});

test('R2BackedD1Database は D1 の束ねを D1Database で開いて包む（名前・引数・文の数の上限500はいままでのまま）',()=>{
 const binding=new Binding(),db=new R2BackedD1Database(binding,new Bucket());
 assert.ok(db instanceof R2LargeValueDatabase);
 assert.ok(db.inner instanceof D1Database);
 assert.equal(db.inner.binding,binding);
 assert.equal(db.binding,binding);
 assert.deepEqual([db.dialect,db.maxBatchStatements,db.maxInlineValueBytes],[undefined,500,128*1024]);
 assert.throws(()=>new R2BackedD1Database(binding,null),/R2 binding is required/);
 assert.throws(()=>new R2LargeValueDatabase({all(){}},new Bucket()),/入口/);
});
