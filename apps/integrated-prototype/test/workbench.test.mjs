import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {executeTransform} from '../src/transforms/engine.mjs';
import {rowsFromSheet} from '../src/workbench-ui.mjs';
const fixture=async({t}={})=>{const db=await openTestDb({t});return {db,app:createApp({db,mode:'local'})}};
async function login(app,email='admin@openingnight.invalid'){const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});return r.headers.get('set-cookie').split(';')[0]}
const api=(app,path,cookie,method='GET',data,headers={})=>app.request(`/api/workbench${path}`,{method,headers:{cookie,...(data?{'content-type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
const read=async r=>({status:r.status,body:await r.json()});

test('deterministic typed transformations preserve source lineage and aggregates',async()=>{
 const rows=[{id:'01',group:'A',net:'100',tax:10},{id:'02',group:'A',net:'50',tax:5},{id:'03',group:'B',net:'20',tax:2}];
 const steps=[{operation:'type',parameters:{column:'net',type:'integer'}},{operation:'calculate',parameters:{columns:['net','tax'],operator:'add',into:'gross'}},{operation:'filter',parameters:{column:'gross',operator:'gte',value:22}},{operation:'group',parameters:{by:['group'],aggregates:[{column:'gross',operation:'sum',into:'total'},{operation:'count',into:'count'}]}},{operation:'sort',parameters:{by:[{column:'group',direction:'asc'}]}}];
 const a=executeTransform(rows,steps),b=executeTransform(rows,steps);assert.deepEqual(a,b);assert.deepEqual(a.rows.map(({_lineage,...r})=>r),[{group:'A',total:165,count:2},{group:'B',total:22,count:1}]);assert.equal(a.rows[0]._lineage.length,2);
});

test('workbench exact revision approval applies once and stale row rolls back whole batch',async(t)=>{
 const {db,app}=await fixture({t}),cookie=await login(app);await db.run("INSERT INTO works(org_id,project_id,code,title,format,version) VALUES(1,1,'WB2','Second','film',1)");
 const data=await read(await api(app,'/datasets/works?projectId=1',cookie));const rows=data.body.rows.map((r,i)=>({...r,title:`Changed ${i}`}));
 const made=await read(await api(app,'/drafts',cookie,'POST',{dataset:'works',projectId:1,sourceSnapshotId:data.body.snapshot.id,rows}));const did=made.body.draft.id;
 const valid=await read(await api(app,`/drafts/${did}/validate`,cookie,'POST',{revision:1}));const submitted=await read(await api(app,`/drafts/${did}/submit`,cookie,'POST',{revision:1,validationId:valid.body.validation.id,reason:'batch test'}));const cs=submitted.body.changeSet;
 assert.equal((await api(app,`/change-sets/${cs.id}/approve`,cookie,'POST',{revision:1,hash:cs.hash})).status,200);
 await db.run('UPDATE works SET title=?,version=version+1 WHERE org_id=1 AND id=?',['external',rows[1].id]);
 const failed=await api(app,`/change-sets/${cs.id}/apply`,cookie,'POST',{revision:1,hash:cs.hash,idempotencyKey:'batch-stale-1'});assert.equal(failed.status,409);assert.notEqual((await db.get('SELECT title FROM works WHERE id=?',[rows[0].id])).title,'Changed 0');db.close();
});

test('sales workbench validates domain facts and atomically imports with idempotent replay',async(t)=>{
 const {db,app}=await fixture({t}),cookie=await login(app),row={report_key:'wb-sales-1',kind:'digital',partner_id:2,product_id:1,period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09',description:'workbench',quantity:1,amount_ex_tax:100,tax_amount:10,amount_inc_tax:110};
 const made=await read(await api(app,'/drafts',cookie,'POST',{dataset:'sales_import',workId:1,rows:[row]}));
 assert.equal(made.status,201,JSON.stringify(made.body));
 const did=made.body.draft.id;
 const valid=await read(await api(app,`/drafts/${did}/validate`,cookie,'POST',{revision:1}));
 assert.equal(valid.status,200,JSON.stringify(valid.body));assert.ok(valid.body.validation,JSON.stringify(valid.body));
 const submitted=await read(await api(app,`/drafts/${did}/submit`,cookie,'POST',{revision:1,validationId:valid.body.validation.id,reason:'sales test'}));
 assert.equal(submitted.status,201,JSON.stringify(submitted.body));
 const cs=submitted.body.changeSet;
 const approved=await read(await api(app,`/change-sets/${cs.id}/approve`,cookie,'POST',{revision:1,hash:cs.hash}));assert.equal(approved.status,200,JSON.stringify(approved.body));
 const one=await read(await api(app,`/change-sets/${cs.id}/apply`,cookie,'POST',{revision:1,hash:cs.hash,idempotencyKey:'sales-apply-1'}));assert.equal(one.status,200,JSON.stringify(one.body));
 const two=await read(await api(app,`/change-sets/${cs.id}/apply`,cookie,'POST',{revision:1,hash:cs.hash,idempotencyKey:'sales-apply-1'}));assert.equal(two.body.replayed,true);
 const report=await db.get("SELECT id FROM report_imports WHERE report_key='wb-sales-1'");assert.ok(report);assert.equal((await db.get('SELECT amount_inc_tax FROM sale_lines WHERE report_id=?',[report.id])).amount_inc_tax,110);db.close();
});

test('permission is rechecked at apply time',async(t)=>{
 const {db,app}=await fixture({t}),cookie=await login(app,'editor@openingnight.invalid'),data=await read(await api(app,'/datasets/works?projectId=1',cookie)),rows=data.body.rows.map(r=>({...r,title:'revoked'})),made=await read(await api(app,'/drafts',cookie,'POST',{dataset:'works',projectId:1,sourceSnapshotId:data.body.snapshot.id,rows})),did=made.body.draft.id,valid=await read(await api(app,`/drafts/${did}/validate`,cookie,'POST',{revision:1})),submitted=await read(await api(app,`/drafts/${did}/submit`,cookie,'POST',{revision:1,validationId:valid.body.validation.id,reason:'permission test'})),cs=submitted.body.changeSet,admin=await login(app);await api(app,`/change-sets/${cs.id}/approve`,admin,'POST',{revision:1,hash:cs.hash});await db.run("UPDATE project_memberships SET permission='production' WHERE org_id=1 AND project_id=1 AND user_id=(SELECT id FROM users WHERE email='editor@openingnight.invalid')");const out=await read(await api(app,`/change-sets/${cs.id}/apply`,cookie,'POST',{revision:1,hash:cs.hash,idempotencyKey:'permission-1'}));assert.equal(out.status,403,JSON.stringify(out.body));db.close();
});

test('engine rejects impossible dates and null arithmetic',()=>{
 assert.throws(()=>executeTransform([{date:'2026-02-30'}],[{operation:'type',parameters:{column:'date',type:'date'}}]),/日付/);
 assert.throws(()=>executeTransform([{amount:null}],[{operation:'calculate',parameters:{columns:['amount'],operator:'add',into:'total'}}]),/null/);
});

test('product stale version aborts and recipe versions cannot be paired with different steps',async(t)=>{
 const {db,app}=await fixture({t}),cookie=await login(app),data=await read(await api(app,'/datasets/products',cookie)),rows=data.body.rows.map((r,i)=>i? r:{...r,name:'changed product'}),made=await read(await api(app,'/drafts',cookie,'POST',{dataset:'products',sourceSnapshotId:data.body.snapshot.id,rows})),did=made.body.draft.id,valid=await read(await api(app,`/drafts/${did}/validate`,cookie,'POST',{revision:1})),submitted=await read(await api(app,`/drafts/${did}/submit`,cookie,'POST',{revision:1,validationId:valid.body.validation.id,reason:'product cas'})),cs=submitted.body.changeSet;await api(app,`/change-sets/${cs.id}/approve`,cookie,'POST',{revision:1,hash:cs.hash});await db.run('UPDATE products SET version=version+1 WHERE id=?',[rows[0].id]);assert.equal((await api(app,`/change-sets/${cs.id}/apply`,cookie,'POST',{revision:1,hash:cs.hash,idempotencyKey:'product-stale-1'})).status,409);
 const recipe=await read(await api(app,'/recipes',cookie,'POST',{name:'fixed',dataset:'works',steps:[{operation:'select',parameters:{columns:['title']}}]}));const rejected=await api(app,'/drafts',cookie,'POST',{dataset:'works',projectId:1,recipeVersionId:recipe.body.version.id,steps:[],rows:[]});assert.equal(rejected.status,400);db.close();
});

test('pinned JOIN snapshots replay through validation and apply, while duplicate source keys fail',async(t)=>{
 const {db,app}=await fixture({t}),cookie=await login(app),works=await read(await api(app,'/datasets/works?projectId=1',cookie)),partners=await read(await api(app,'/datasets/partners',cookie)),refs=[{name:'partners',snapshotId:partners.body.snapshot.id}],steps=[{operation:'select',parameters:{columns:['id']}},{operation:'join',parameters:{lookup:'partners',leftKey:'id',rightKey:'id',kind:'left',columns:['name']}},{operation:'rename',parameters:{mapping:{partners_name:'title'}}}],made=await read(await api(app,'/drafts',cookie,'POST',{dataset:'works',projectId:1,sourceSnapshotId:works.body.snapshot.id,rows:works.body.rows,steps,lookupSnapshots:refs})),did=made.body.draft.id,valid=await read(await api(app,`/drafts/${did}/validate`,cookie,'POST',{revision:1,lookupSnapshots:refs}));assert.equal(valid.status,200,JSON.stringify(valid.body));
 const badRows=[works.body.rows[0],works.body.rows[0]],dup=await read(await api(app,'/drafts',cookie,'POST',{dataset:'works',projectId:1,sourceSnapshotId:works.body.snapshot.id,rows:badRows})),dupValid=await api(app,`/drafts/${dup.body.draft.id}/validate`,cookie,'POST',{revision:1});assert.equal(dupValid.status,400);db.close();
});

test('revoked editor cannot reload a saved draft and list endpoints expose exact state only in scope',async(t)=>{
 const {db,app}=await fixture({t}),cookie=await login(app,'editor@openingnight.invalid'),data=await read(await api(app,'/datasets/works?projectId=1',cookie)),made=await read(await api(app,'/drafts',cookie,'POST',{dataset:'works',projectId:1,sourceSnapshotId:data.body.snapshot.id,rows:data.body.rows}));assert.equal((await api(app,'/drafts',cookie)).status,200);await db.run("UPDATE project_memberships SET permission='production' WHERE org_id=1 AND project_id=1 AND user_id=(SELECT id FROM users WHERE email='editor@openingnight.invalid')");assert.equal((await api(app,`/drafts/${made.body.draft.id}`,cookie)).status,403);const list=await read(await api(app,'/drafts',cookie));assert.deepEqual(list.body.drafts,[]);db.close();
});

test('file extraction retains immutable server-hashed source and draft links artifact',async(t)=>{
 const db=await openTestDb({t}),sheet={name:'CSV',rows:[['a'],['1']],formulaIssues:[]},app=createApp({db,mode:'local',extractWorkbenchFile:async()=>({sheets:[sheet],sourceEncoding:'utf-8'})}),cookie=await login(app),base64=Buffer.from('a\n1\n').toString('base64'),extracted=await read(await api(app,'/files/extract',cookie,'POST',{name:'source.csv',base64}));assert.equal(extracted.status,200,JSON.stringify(extracted.body));assert.ok(extracted.body.sourceArtifactId);const artifact=await db.get('SELECT * FROM workbench_source_artifacts WHERE id=?',[extracted.body.sourceArtifactId]);assert.equal(artifact.raw_base64,base64);assert.equal(artifact.source_hash,extracted.body.file.sourceHash);
 const sourceRows=rowsFromSheet(sheet,1,artifact.source_hash),sourceArtifactId=artifact.id;
 const forged=await api(app,'/drafts',cookie,'POST',{dataset:'sales_import',workId:1,sourceArtifactId,sheetName:'CSV',headerRow:1,rows:[{a:'1',_source:{key:'forged'}}]});assert.equal(forged.status,400);
 const made=await read(await api(app,'/drafts',cookie,'POST',{dataset:'sales_import',workId:1,sourceArtifactId,sheetName:'CSV',headerRow:1,rows:sourceRows.map(row=>({...row,_lineage:[{source:'forged',row:9}]}))}));assert.equal(made.status,201,JSON.stringify(made.body));assert.equal(made.body.draft.sourceArtifactId,artifact.id);
 const saved=await read(await api(app,`/drafts/${made.body.draft.id}`,cookie));assert.deepEqual(saved.body.draft.rows,sourceRows);
 const changed=await api(app,`/drafts/${made.body.draft.id}`,cookie,'PUT',{rows:[{...sourceRows[0],_source:{...sourceRows[0]._source,row:9}}]},{'If-Match':'1'});assert.equal(changed.status,400);
 await assert.rejects(()=>db.run('UPDATE workbench_source_artifacts SET name=? WHERE id=?',['changed',artifact.id]),/immutable/);await db.close();
});

test('workbench file upload accepts encoded source above the ordinary JSON limit',async(t)=>{
 const db=await openTestDb({t}),app=createApp({db,mode:'local',extractWorkbenchFile:async()=>({sheets:[{name:'CSV',rows:[['a'],['1']]}]})}),cookie=await login(app);
 try{
  const base64=Buffer.alloc(400_000,65).toString('base64');
  const extracted=await read(await api(app,'/files/extract',cookie,'POST',{name:'large.csv',base64}));
  assert.equal(extracted.status,200,JSON.stringify(extracted.body));
  assert.equal(extracted.body.file.byteLength,400_000);
 }finally{await db.close()}
});

test('sales apply re-runs domain correction rules after approval',async(t)=>{
 const {db,app}=await fixture({t}),cookie=await login(app),row={report_key:'late-conflict',kind:'digital',partner_id:2,product_id:1,period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09',description:'candidate',quantity:1,amount_ex_tax:100,tax_amount:10,amount_inc_tax:110},made=await read(await api(app,'/drafts',cookie,'POST',{dataset:'sales_import',workId:1,rows:[row]})),valid=await read(await api(app,`/drafts/${made.body.draft.id}/validate`,cookie,'POST',{revision:1})),submitted=await read(await api(app,`/drafts/${made.body.draft.id}/submit`,cookie,'POST',{revision:1,validationId:valid.body.validation.id,reason:'late conflict'})),cs=submitted.body.changeSet;await api(app,`/change-sets/${cs.id}/approve`,cookie,'POST',{revision:1,hash:cs.hash});await db.run("INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,created_by) VALUES(1,1,2,'late-conflict','digital','2026-09-01','2026-09-30','2026-09','other','other-hash',1)");const out=await api(app,`/change-sets/${cs.id}/apply`,cookie,'POST',{revision:1,hash:cs.hash,idempotencyKey:'late-conflict-1'});assert.equal(out.status,409);assert.equal((await db.get('SELECT status FROM workbench_change_sets WHERE id=?',[cs.id])).status,'approved');db.close();
});
