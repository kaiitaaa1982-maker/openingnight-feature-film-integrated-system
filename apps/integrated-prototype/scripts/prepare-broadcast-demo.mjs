import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {resolve} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const path=resolve('data/human-workflow-proof.sqlite');
const registration=JSON.parse(readFileSync(path+'.workbench-demo.json'));
assert.equal(registration.kind,'workbench-synthetic-v1');assert.equal(resolve(registration.database),path);
const db=new LocalDatabase(path);const app=createApp({db});
try{
 const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 const req=async(p,b)=>{const r=await app.request('/api'+p,{method:b?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});const j=await r.json();assert.ok(r.ok&&j.ok,JSON.stringify(j));return j};
 assert.equal((await db.get('SELECT count(*) n FROM broadcast_slots WHERE work_id=3')).n,0,'Demo already prepared');
 await req('/work-catalog/3',{baseRevision:0,production_year:2026,source_reference:'架空作品の実演用設定',synopsis_short:'海辺の駅で再会する二人を描く架空作品。',credits:[{role:'director',name:'架空監督'}],editions:[{edition_key:'main',name:'本編',runtime_seconds:5880,country:['日本'],language:['日本語']}],bindings:[]});
 for(const code of ['B001','D003','V001'])await req('/sales-catalog',{workId:3,distributionCode:code,territory:'日本',baseVersion:0,releaseOn:'2026-09-01',salesEndOn:'2027-08-31',terms:'非独占。価格は案件ごとに確認。',sourceReference:'SYNTHETIC-AVAILS-'+code,exclusivity:'nonexclusive',status:'confirmed'});
 const ids=[];
 for(const [station,statuses] of [['架空BS局',['pending_first','tentative','pending_final','confirmed']],['架空CS局',['pending_first','tentative']],['架空ケーブル局',[]]]){
  let row=await req('/broadcast/slots',{workId:3,broadcastMonth:'2026-09',stationName:station,customerPartnerId:3,agencyPartnerId:2,periodFrom:'2026-09-01',periodTo:'2026-09-30',plannedOn:'2026-09-20',plannedRuns:1,sourceReference:'架空の放送予定表'});
  for(const status of statuses)row=await req(`/broadcast/slots/${row.slotId}/transition`,{baseRevision:row.revision,status,reason:'架空デモの承認'});
  ids.push(row.slotId);
 }
 const sale=await db.get("SELECT s.id FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE s.work_id=3 AND r.kind='broadcast' AND s.accounting_month='2026-09'");
 await req(`/broadcast/slots/${ids[0]}/airings`,{airedOn:'2026-09-20',runCount:1,sourceReference:'架空BS局の放送実績'});
 await req(`/broadcast/slots/${ids[0]}/sales`,{saleId:sale.id});
 const reconciled=await req('/broadcast/reconciliation?workId=3');assert.equal(reconciled.rows.find(s=>s.slot_id===ids[0]).linked_amount_ex_tax,200000);
 writeFileSync('data/human-workflow-files/broadcast-proof.json',JSON.stringify({syntheticOnly:true,slots:ids,saleId:sale.id,reconciled},null,2));
 console.log(JSON.stringify({ok:true,slots:ids,linkedSales:200000}));
}finally{db.close()}
