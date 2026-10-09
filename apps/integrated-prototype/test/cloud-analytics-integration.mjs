import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture,good} from './field-sales-independent-fixture.mjs';
import {cloudAnalyticsSql,createCloudAnalytics} from '../src/cloud-analytics.mjs';

const python=process.env.CLOUD_ANALYTICS_TEST_PYTHON;if(!python)throw Error('Set CLOUD_ANALYTICS_TEST_PYTHON to the isolated dbt Python');
const f=await fixture();f.db.raw.exec(cloudAnalyticsSql);
const saved=new Map(),bucket={async put(k,v){saved.set(k,Buffer.from(v))},async get(k){const v=saved.get(k);return v?{arrayBuffer:async()=>Uint8Array.from(v).buffer}:null}};
let receivedFrozen;
const build=frozen=>new Promise((resolve,reject)=>{receivedFrozen=frozen;const child=spawn(python,[fileURLToPath(new URL('../python/cloud_analytics.py',import.meta.url))],{env:{...process.env,PYTHONIOENCODING:'utf-8',CLOUD_ANALYTICS_REGISTRATION_ID:'integration-synthetic',CLOUD_ANALYTICS_DEFINITION_VERSION:'integration-v1',CLOUD_ANALYTICS_NODE:process.execPath},windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>{try{const r=JSON.parse(out);if(code||!r.ok)reject(Error(r.error||err));else resolve(r)}catch(e){reject(Error(err+' '+out.slice(-2000)))}});child.stdin.end(JSON.stringify(frozen))});
try{
 const dataset=good(await f.req('/workbench/datasets/works'));
 const rows=dataset.rows.map(r=>({...r,title:r.id===1?'架空・クラウド加工後':r.title}));
 const draft=good(await f.req('/workbench/drafts',{dataset:'works',sourceSnapshotId:dataset.snapshot.id,rows})).draft;
 const valid=good(await f.req(`/workbench/drafts/${draft.id}/validate`,{revision:1})).validation;
 const change=good(await f.req(`/workbench/drafts/${draft.id}/submit`,{revision:1,validationId:valid.id,reason:'クラウド分析の独立検証'})).changeSet;
 good(await f.req(`/workbench/change-sets/${change.id}/approve`,{revision:change.revision,hash:change.hash}));
 good(await f.req(`/workbench/change-sets/${change.id}/apply`,{revision:change.revision,hash:change.hash,idempotencyKey:'cloud-integration-first'}));
 good(await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net'}));
 const service=createCloudAnalytics({db:f.db,bucket,registrationId:'integration-synthetic',definitionVersion:'integration-v1',containerBuild:build});
 const identity={org_id:1,user_id:1,role:'admin'},job=await service.begin(identity,'2026-11-20');
 await service.execute(job);
 const output=JSON.parse(saved.get(`analytics/org-1/runs/${job.id}/outputs.json`).toString());
 assert.equal(output.sales_by_work[0].work_title,'架空・クラウド加工後');
 assert.equal(output.sales_fact.reduce((n,r)=>n+r.amount_ex_tax,0),8000);
 assert.equal(output.invoice_balances[0].balance_yen,8800);
 assert.equal((await service.status(identity)).active.auditThrough,receivedFrozen.auditThrough);
 assert.match(Buffer.from(await service.report(identity,job.id,'report.html')).toString(),/クラウド加工後/);
 const frozen=JSON.parse(saved.get(`analytics/org-1/runs/${job.id}/frozen.json`).toString());
 assert.equal(frozen.tables.works.rows.length,1);
 console.log(JSON.stringify({ok:true,tests:['workbench approved edit exported','frozen entry readBatch','existing report API materialized','dbt independent sales 8000','invoice 8800','R2 verified artifacts','active CAS'],files:saved.size}));
}finally{f.db.close()}
