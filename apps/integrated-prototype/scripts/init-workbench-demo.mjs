import {existsSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
export async function initDemo(filename=resolve(appRoot,'data/workbench-demo.sqlite')){
 filename=resolve(filename);const marker=filename+'.workbench-demo.json';
 if(existsSync(filename)){
  if(!existsSync(marker))throw Error('既存DBを架空デモとして登録し直すことはできません');
  const saved=JSON.parse(readFileSync(marker,'utf8'));
  if(saved.kind!=='workbench-synthetic-v1'||resolve(saved.database)!==filename)throw Error('架空DB登録が一致しません');
  return {database:filename,created:false};
 }
 mkdirSync(dirname(filename),{recursive:true});
 const db=new LocalDatabase(filename),app=createApp({db});
 try{
  const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for(const [month,amount] of [['2026-07',120000],['2026-08',150000],['2026-09',90000]]){
   const body={workId:1,report_key:'WB-DEMO-'+month,kind:'digital',partner_id:2,product_id:1,period_from:month+'-01',period_to:month+(month.endsWith('09')?'-30':'-31'),recognition_basis_id:2,report_received_on:month+'-28',basis_reason:'架空報告の受領月',description:'表編集の架空実証',quantity:10,amount_ex_tax:amount,tax_amount:0,amount_inc_tax:amount};
   const r=await app.request('/api/sales',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
   if(!r.ok)throw Error(await r.text());
  }
  writeFileSync(marker,JSON.stringify({kind:'workbench-synthetic-v1',id:randomUUID(),database:filename,createdAt:new Date().toISOString()},null,2));
  return {database:filename,created:true};
 }finally{db.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await initDemo(process.argv[2])))}catch(e){console.error(e.message);process.exitCode=1}
}
