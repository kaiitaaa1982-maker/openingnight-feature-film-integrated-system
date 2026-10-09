import test from'node:test';import assert from'node:assert/strict';import{readFile,stat}from'node:fs/promises';
import{SALES_PAGES,normalizePage,pageArea}from'../src/navigation.mjs';
import {fixture,good} from './field-sales-independent-fixture.mjs';
const dir=new URL('../public/demo-fixtures/',import.meta.url);
const csv=async name=>(await readFile(new URL(name,dir),'utf8')).replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(x=>x.split(','));
test('downloaded normal CSVs validate and apply through workbench approval',async(t)=>{
 const f=await fixture({t});try{for(const [slug,expected] of [['streaming-platform',1154700],['videogram-rental',726140]]){
  const [headers,...values]=await csv(slug+'-canonical.csv'),rows=values.map(v=>Object.fromEntries(headers.map((h,i)=>[h,v[i]])));
  const snapshot=good(await f.req('/workbench/datasets/sales_import?workId=1')).snapshot;
  const draft=good(await f.req('/workbench/drafts',{dataset:'sales_import',workId:1,sourceSnapshotId:snapshot.id,rows})).draft;
  const valid=good(await f.req(`/workbench/drafts/${draft.id}/validate`,{revision:1})).validation;
  const change=good(await f.req(`/workbench/drafts/${draft.id}/submit`,{revision:1,validationId:valid.id,reason:'架空資料の登録確認'})).changeSet;
  good(await f.req(`/workbench/change-sets/${change.id}/approve`,{revision:change.revision,hash:change.hash}));
  good(await f.req(`/workbench/change-sets/${change.id}/apply`,{revision:change.revision,hash:change.hash,idempotencyKey:slug}));
  const total=await f.db.get('SELECT SUM(s.amount_ex_tax) amount FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE r.report_key=?',[rows[0].report_key]);assert.equal(total.amount,expected);
 }}finally{f.db.close()}
});
test('demo page is a sales navigation target',()=>{assert.ok(SALES_PAGES.includes('デモ資料'));assert.equal(normalizePage('デモ資料'),'デモ資料');assert.equal(pageArea('デモ資料'),'sales')});
test('all downloadable demo assets are packaged',async()=>{for(const name of['streaming-platform-sample.xlsx','streaming-platform-sample.csv','streaming-platform-canonical.csv','videogram-rental-sample.xlsx','videogram-rental-sample.csv','videogram-rental-canonical.csv','demo-sales-streaming-sample.xlsx','demo-sales-videogram-sample.xlsx','broadcast-license-demo-contract.pdf','fixture-manifest.json','source-column-guide.json'])assert.ok((await stat(new URL(name,dir))).size>100,name)});
test('canonical CSVs match fixture master ids and totals',async()=>{const streaming=await csv('streaming-platform-canonical.csv'),video=await csv('videogram-rental-canonical.csv');assert.deepEqual([...new Set(streaming.slice(1).map(r=>`${r[1]}:${r[2]}`))],['2:1']);assert.deepEqual([...new Set(video.slice(1).map(r=>`${r[1]}:${r[2]}`))],['3:2']);assert.equal(streaming.slice(1).reduce((n,r)=>n+Number(r[17]),0),1154700);assert.equal(video.slice(1).reduce((n,r)=>n+Number(r[17]),0),726140);assert.ok(streaming.slice(1).every(r=>Number(r[19])===Number(r[17])+Number(r[18])));assert.ok(video.slice(1).every(r=>Number(r[19])===Number(r[17])+Number(r[18])))});
