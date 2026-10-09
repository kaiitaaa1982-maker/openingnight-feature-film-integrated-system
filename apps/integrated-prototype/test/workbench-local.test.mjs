import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {registerLocalWorkbenchAnalytics} from '../src/workbench-analytics-local.mjs';

test('local analytics requires administrator and detects definition changes without hiding immutable reports',async(t)=>{
 const temporary=mkdtempSync(resolve(tmpdir(),'wb-local-')),database=resolve(temporary,'fixture.sqlite'),root=resolve(temporary,'analytics'),db=await openTestDb({t});
 try{
  writeFileSync(database+'.workbench-demo.json',JSON.stringify({kind:'workbench-synthetic-v1',database}));
  const script=resolve(temporary,'runner.py');writeFileSync(script,'original runner');
  const id='a'.repeat(32),run=resolve(root,'runs',id);mkdirSync(resolve(run,'reports'),{recursive:true});
  writeFileSync(resolve(run,'reports/report.html'),'<p>保存済み帳票</p>');
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  writeFileSync(resolve(run,'snapshot.json'),JSON.stringify({id:'snapshot',auditThrough:0,asOf:'2026-09-21',exported_at:'2026-09-21',definitions:{}}));
  writeFileSync(resolve(run,'verification.json'),JSON.stringify({files:{'reports/report.html':hash(resolve(run,'reports/report.html')),'snapshot.json':hash(resolve(run,'snapshot.json'))},sourceDefinitions:{},runnerHash:hash(script),passedTests:13}));
  writeFileSync(resolve(root,'active.json'),JSON.stringify({runId:id,verifiedAt:'2026-09-21'}));
  const app=createApp({db});registerLocalWorkbenchAnalytics(app,{db,database,root,python:process.execPath,node:process.execPath,script});
  async function login(email){const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});return r.headers.get('set-cookie').split(';')[0]}
  const admin=await login('admin@openingnight.invalid'),other=await login('outsider@other.invalid'),production=await login('production@openingnight.invalid');
  const get=(path,cookie=admin)=>app.request('/api/workbench/analytics/'+path,{headers:{cookie}});
  assert.equal((await get('status',other)).status,403);assert.equal((await get('status',production)).status,403);
  let state=await (await get('status')).json();assert.equal(state.active.stale,false);
  writeFileSync(script,'changed runner');state=await (await get('status')).json();assert.equal(state.active.definitionStale,true);
  assert.equal((await get('report?runId='+id)).status,200);
  writeFileSync(resolve(run,'reports/report.html'),'<p>modified</p>');assert.equal((await get('report?runId='+id)).status,400);
  assert.equal((await get('report?runId=../outside')).status,400);
 }finally{
  await db.close();const path=realpathSync(temporary),base=realpathSync(tmpdir());assert.ok(path.startsWith(base+sep)&&path.includes('wb-local-'));rmSync(path,{recursive:true});
 }
});
