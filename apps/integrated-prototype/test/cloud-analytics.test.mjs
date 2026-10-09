// 分析の写し（src/cloud-analytics.mjs）の試験。DB は試験の DB のファクトリ（cloud-analytics-fixture.mjs → test-db.mjs）で開き、SQLite と PostgreSQL の両方で流す。
// D1 の束ねを node:sqlite で模す試験と、SQLite のファイルを2つの接続で開く試験は cloud-analytics-sqlite.test.mjs（SQLite だけ）。
// R2 の層（R2LargeValueDatabase）を試験の DB の入口にかぶせた写しは、このファイルが両方の DB で確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {prepareHistoryImport} from '../scripts/cloud-snapshot-import-local.mjs';
import {createCloudAnalytics,freezeAnalyticsSnapshot,sha256,snapshotTables} from '../src/cloud-analytics.mjs';
import {R2LargeValueDatabase} from '../src/cloud-r2-db.mjs';
import {identity,resultFor,setup,plain,freezeArgs,stable} from './cloud-analytics-fixture.mjs';

// ---------- 分析の写しの抽出（FR-CORE-DATA-009・010。PG 計画 段1・香盤表 #10。PostgreSQL の2つの接続は test/cloud-analytics-pg.test.mjs） ----------

// 写しの定義（表・列・組織の絞り込み）どおりに、読み取りの一括を通さず入口の all で表ごとに読んだ行
const entryRows=async(db,orgId)=>{const out={};for(const [table,columns] of Object.entries(snapshotTables)){const global=table.startsWith('distribution_');out[table]=plain(await db.all(`SELECT ${columns} FROM ${table}${global?'':' WHERE org_id=?'}`,global?[]:[orgId]))}return out};

// 入口（試験の DB。SQLite は LocalDatabase、PostgreSQL は PgDatabase）だけで写しを確かめる。D1 の束ねの模擬の上の本番の D1 の入口（R2BackedD1Database）と並べる試験は cloud-analytics-sqlite.test.mjs
test('FR-CORE-DATA-010 分析の写しは入口の読み取りの一括で読み、表・列・行・audit_through・管理者の確かめが、表ごとに読んだ行と同じ（試験の DB の入口）',async(t)=>{
 const f=await setup({t});
 await f.db.run("INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(2,4,'test','works','2','{}')");
 const expected=await entryRows(f.db,1),auditThrough=(await f.db.get('SELECT MAX(id) n FROM audit_log WHERE org_id=1')).n;
 assert.ok(auditThrough>0&&expected.sale_lines.length&&expected.works.length&&expected.distribution_types.length,'架空の行がある表で確かめる');
 assert.ok((await f.db.get('SELECT count(*) n FROM works WHERE org_id=2')).n>0,'組織2の行もある');
 const snap=await freezeAnalyticsSnapshot({db:f.db,...freezeArgs});
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
 // 管理者の確かめも同じ一括の中で行う。失効・無効・管理者でない利用者・別の組織の管理者は 403
 for(const [change,undo,userId] of [
  ["UPDATE memberships SET expires_at='2000-01-01T00:00:00Z' WHERE org_id=1 AND user_id=1",'UPDATE memberships SET expires_at=NULL WHERE org_id=1 AND user_id=1',1],
  ['UPDATE memberships SET active=0 WHERE org_id=1 AND user_id=1','UPDATE memberships SET active=1 WHERE org_id=1 AND user_id=1',1],
  [null,null,2],[null,null,4]
 ]){
  if(change)await f.db.run(change);
  await assert.rejects(freezeAnalyticsSnapshot({db:f.db,...freezeArgs,userId}),e=>e.status===403&&/権限が失効/.test(e.message));
  if(undo)await f.db.run(undo);
 }
 assert.equal((await freezeAnalyticsSnapshot({db:f.db,...freezeArgs})).auditThrough,auditThrough);
});

// R2 の層（R2LargeValueDatabase）を試験の DB の入口にかぶせても、写しは包まない入口と同じで、内側の入口の読み取りの一括を1回だけ呼ぶ。
// 写しの表に R2 へ逃がす列は無いので、R2 には触れない（触れたら落ちる罠の bucket）。段2で PostgreSQL の入口に層をかぶせる形（FR-CORE-DATA-008）
test('FR-CORE-DATA-008 FR-CORE-DATA-010 R2 の層をかぶせた入口でも、写しは包まない入口と同じで、内側の入口の読み取りの一括を1回だけ呼ぶ（試験の DB の入口）',async(t)=>{
 const f=await setup({t}),batches=[];
 const counted={all:(...a)=>f.db.all(...a),get:(...a)=>f.db.get(...a),run:(...a)=>f.db.run(...a),batch:(...a)=>f.db.batch(...a),readBatch:statements=>{batches.push(statements.length);return f.db.readBatch(statements)},get dialect(){return f.db.dialect}};
 const trap={head(){throw Error('写しが R2 を読んだ')},get(){throw Error('写しが R2 を読んだ')},put(){throw Error('写しが R2 に書いた')}};
 const cloud=new R2LargeValueDatabase(counted,trap);
 const local=await freezeAnalyticsSnapshot({db:f.db,...freezeArgs}),wrapped=await freezeAnalyticsSnapshot({db:cloud,...freezeArgs});
 assert.deepEqual(batches,[Object.keys(snapshotTables).length+2],'写しの表＋監査の上限＋管理者の確かめを1回の一括で読む');
 assert.deepEqual(stable(wrapped),stable(local));
 assert.ok(wrapped.tables.sale_lines.rows.length&&wrapped.tables.works.rows.length,'架空の行がある表で確かめる');
 await f.db.run('UPDATE memberships SET active=0 WHERE org_id=1 AND user_id=1');
 await assert.rejects(freezeAnalyticsSnapshot({db:cloud,...freezeArgs}),e=>e.status===403&&/権限が失効/.test(e.message));
});

// cloud-worker.mjs は @cloudflare/containers を読むため Node の試験では import できない（test/cloud-runtime-restart.test.mjs と同じ）。
// 分析の写しへ D1 の束ねを直接渡していないことは本文で、分析の写しが入口（db）だけで動くことは動かして確かめる
test('FR-CORE-DATA-010 cloud-worker は env.DB を分析の写しに直接渡さず、分析の写しは入口（db）だけを受け取る',async(t)=>{
 const worker=readFileSync(new URL('../src/cloud-worker.mjs',import.meta.url),'utf8'),analytics=readFileSync(new URL('../src/cloud-analytics.mjs',import.meta.url),'utf8');
 const call=/registerCloudAnalyticsRoutes\(app,\{([^}]*)\}\)/.exec(worker);
 assert.ok(call,'cloud-worker が分析の写しの受け口を登録している');
 assert.deepEqual(call[1].split(',').map(x=>x.split(':')[0].trim()),['db','bucket','registrationId','definitionVersion','containerBuild']);
 assert.doesNotMatch(worker,/env\.DB\b/,'D1 の束ねは createCloudRuntime（R2BackedD1Database）にだけ渡す');
 assert.doesNotMatch(analytics,/\bd1\b|\.prepare\(|\.bind\(/,'分析の写しは D1 の素の API を使わない');
 // D1 の束ねを渡されても触れない（触れたら落ちる罠）
 const trap=new Proxy({},{get(_,key){throw Error('分析の写しが D1 の束ねに触れた: '+String(key))}});
 const f=await setup({t,d1:trap});
 const job=await f.service.begin(identity,'2026-09-22');assert.deepEqual(await f.service.execute(job),{runId:job.id,status:'verified'});assert.equal((await f.service.status(identity)).active.runId,job.id)
});

test('start collision rejects second job and lease expiry permits replacement without old job promotion',async(t)=>{let tick=new Date('2030-01-01T00:00:00Z').getTime(),release;const f=await setup({t,clock:()=>new Date(tick),leaseMs:1000});const old=await f.service.begin(identity,'2026-09-22');await assert.rejects(f.service.begin(identity,'2026-09-22'),e=>e.status===409);const delayed=createCloudAnalytics({...f.options,clock:()=>new Date(tick),leaseMs:1000,containerBuild:async frozen=>{await new Promise(r=>release=r);return resultFor(frozen)}});const running=delayed.execute(old);while(!release)await new Promise(r=>setTimeout(r,1));tick+=2000;const next=await f.service.begin(identity,'2026-09-22');await f.service.execute(next);release();await assert.rejects(running);assert.equal((await f.service.status(identity)).active.runId,next.id);assert.equal((await f.service.status(identity)).busy,false)});

test('mid-upload failure retains old active and releases only own lock',async(t)=>{const f=await setup({t});const first=await f.service.begin(identity,'2026-09-22');await f.service.execute(first);const second=await f.service.begin(identity,'2026-09-22');f.bucket.failPut=key=>key.includes(second.id)&&key.endsWith('reports/report.html');await assert.rejects(f.service.execute(second),/injected/);const state=await f.service.status(identity);assert.equal(state.active.runId,first.id);assert.equal(state.busy,false);assert.match(state.lastError,/injected/);assert.equal((await f.service.history(identity)).runs.length,1)});

test('cross-org requests and report byte modification are rejected',async(t)=>{const f=await setup({t});const other={...identity,org_id:2};for(const call of [()=>f.service.begin(other,'2026-09-22'),()=>f.service.status(other),()=>f.service.history(other),()=>f.service.report(other,null,'report.html')])await assert.rejects(call,e=>e.status===403);const j=await f.service.begin(identity,'2026-09-22');await f.service.execute(j);assert.match(Buffer.from(await f.service.report(identity,j.id,'report.html')).toString(),/verified/);await f.bucket.put(`analytics/org-1/runs/${j.id}/reports/report.html`,'changed');await assert.rejects(f.service.report(identity,j.id,'report.html'),/変更/)});

test('definition changes mark stale, changed output hashes never promote',async(t)=>{const f=await setup({t});const j=await f.service.begin(identity,'2026-09-22');await f.service.execute(j);const next=createCloudAnalytics({...f.options,definitionVersion:'v2',containerBuild:async frozen=>{const r=await resultFor(frozen);r.files[0].base64=Buffer.from('tampered').toString('base64');return r}});assert.equal((await next.status(identity)).active.definitionStale,true);const job=await next.begin(identity,'2026-09-22');await assert.rejects(next.execute(job),/ハッシュ/);assert.equal((await next.status(identity)).active.runId,j.id)});

test('revoked membership after container build cannot promote',async(t)=>{const f=await setup({t});const service=createCloudAnalytics({...f.options,containerBuild:async frozen=>{const result=await resultFor(frozen);await f.db.run('UPDATE memberships SET active=0 WHERE org_id=1 AND user_id=1');return result}}),job=await service.begin(identity,'2026-09-22');await assert.rejects(service.execute(job),e=>e.status===403);assert.equal((await f.db.get('SELECT active_run FROM cloud_analytics_state WHERE org_id=1')).active_run,null)});

test('legacy history import preserves verified bytes, rejects tampering and cannot replace existing active',async()=>{
 const root=mkdtempSync(join(tmpdir(),'cloud-history-test-')),source=join(root,'source'),runId='a'.repeat(32),dir=join(source,'runs',runId);mkdirSync(dir,{recursive:true});
 const frozen={runId,orgId:1,registrationId:'legacy-synthetic',auditThrough:3,frozenHash:'test',definitionVersion:'old'},built=await resultFor(frozen);
 const contents=Object.fromEntries(built.files.map(f=>[f.path,Buffer.from(f.base64,'base64')]));
 const snapshot={...JSON.parse(contents['snapshot.json']),source:'registered-synthetic-workbench',asOf:'2026-09-22',exported_at:'2026-09-22T00:00:00Z'};contents['snapshot.json']=Buffer.from(JSON.stringify(snapshot));
 const v=JSON.parse(contents['verification.json']);v.files['snapshot.json']=await sha256(contents['snapshot.json']);v.verifiedAt='2026-09-22T00:01:00Z';v.runnerHash='legacy';contents['verification.json']=Buffer.from(JSON.stringify(v));
 for(const [path,bytes] of Object.entries(contents)){const full=join(dir,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,bytes)}writeFileSync(join(source,'active.json'),JSON.stringify({runId}));
 const out=join(root,'bundle'),r=prepareHistoryImport({source,out,registrationId:'legacy-synthetic'});assert.equal(r.runs,1);assert.match(readFileSync(join(out,'import.sql'),'utf8'),/active_run IS NULL AND lock_job IS NULL/);assert.deepEqual(readFileSync(join(dir,'reports/report.html')),contents['reports/report.html']);
 writeFileSync(join(dir,'reports/report.html'),'changed');assert.throws(()=>prepareHistoryImport({source,out:join(root,'bad'),registrationId:'legacy-synthetic'}),/変更/);
});
