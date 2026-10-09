import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';

const file=resolve(process.argv[2]),registration=JSON.parse(readFileSync(file+'.workbench-demo.json','utf8'));
if(registration.kind!=='workbench-synthetic-v1'||resolve(registration.database)!==file)throw Error('Dedicated synthetic DB required');
const db=new LocalDatabase(file),app=createApp({db});
try{
 const response=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
 const cookie=response.headers.get('set-cookie').split(';')[0];
 const api=async(path,body)=>{const r=await app.request('/api/workbench'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await r.json();if(!r.ok||!result.ok)throw Error(JSON.stringify(result));return result};
 async function apply(body,key){
  const {draft}=await api('/drafts',body),{validation}=await api(`/drafts/${draft.id}/validate`,{revision:draft.revision});
  const {changeSet}=await api(`/drafts/${draft.id}/submit`,{revision:draft.revision,validationId:validation.id,reason:'架空の独立した縦断検証'});
  await api(`/change-sets/${changeSet.id}/approve`,{revision:changeSet.revision,hash:changeSet.hash});
  const result=await api(`/change-sets/${changeSet.id}/apply`,{revision:changeSet.revision,hash:changeSet.hash,idempotencyKey:key});
  if(result.application.status!=='applied')throw Error('Not applied');return result.application;
 }
 const source=await api('/datasets/works?projectId=1');
 const master=await apply({dataset:'works',projectId:1,sourceSnapshotId:source.snapshot.id,rows:source.rows.map(r=>r.id===1?{...r,title:'架空・表編集後の作品名'}:r)},'independent-master-edit');
 const sales=await apply({dataset:'sales_import',workId:1,rows:[{report_key:'WB-INDEPENDENT-2027',kind:'digital',partner_id:2,product_id:1,period_from:'2027-01-01',period_to:'2027-01-31',recognition_basis_id:2,report_received_on:'2027-02-04',basis_reason:'架空の受領月',description:'縦断検証',quantity:1,amount_ex_tax:55,tax_amount:0,amount_inc_tax:55}]},'independent-sales-edit');
 console.log(JSON.stringify({ok:true,master:master.id,sales:sales.id}));
}finally{db.close()}
