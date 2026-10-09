import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './test-db.mjs';
import { createApp } from '../src/app.mjs';

async function fixture(t) {
  const db=await openTestDb({t}),app=createApp({db,mode:'local'});return{db,app};
}
async function login(app,email='admin@openingnight.invalid'){
  const response=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
  assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
}
const req=(app,path,cookie,options={})=>app.request(`/api${path}`,{...options,headers:{...(options.body?{'content-type':'application/json'}:{}),cookie,...(options.headers||{})}});
const read=async response=>({status:response.status,body:await response.json()});

test('server-resolved roles hide finance and isolate organizations',async(t)=>{
  const {db,app}=await fixture(t);
  assert.equal((await app.request('/api/bootstrap')).status,401);
  const production=await login(app,'production@openingnight.invalid');
  const boot=await read(await req(app,'/bootstrap',production));
  assert.equal(boot.status,200);assert.equal('budget_yen' in boot.body.projects[0],false);assert.equal('forecast_yen' in boot.body.works[0],false);
  assert.equal((await req(app,'/expenses',production)).status,403);
  assert.equal((await req(app,'/downloads/digital?workId=1',production)).status,403);
  const outsider=await login(app,'outsider@other.invalid');
  const other=await read(await req(app,'/bootstrap',outsider));
  assert.deepEqual(other.body.works.map(x=>x.id),[2]);
  assert.equal((await req(app,'/downloads/publicity?workId=1',outsider)).status,403);
  await db.close();
});

test('invalid CSV rejects the whole batch and a valid preview survives a new app instance',async(t)=>{
  const {db,app}=await fixture(t),cookie=await login(app);
  const header='report_key,partner_id,product_id,period_from,period_to,accounting_month,description,quantity,amount_ex_tax,tax_amount,amount_inc_tax,supersedes_id';
  const invalid=`${header}\nrollback-1,2,1,2026-09-01,2026-09-30,2026-09,valid,1,100,10,110,\nrollback-1,2,1,2026-09-01,2026-09-30,2026-09,invalid,1,100,10,999,`;
  const badPreview=await read(await req(app,'/imports/preview',cookie,{method:'POST',body:JSON.stringify({kind:'digital',workId:1,text:invalid})}));
  assert.equal(badPreview.body.ok,false);assert.equal((await db.get('SELECT count(*) AS n FROM report_imports')).n,0);assert.equal((await db.get('SELECT count(*) AS n FROM sale_lines')).n,0);
  const valid=`${header}\npersist-preview,2,1,2026-09-01,2026-09-30,2026-09,valid,1,100,10,110,`;
  const preview=await read(await req(app,'/imports/preview',cookie,{method:'POST',body:JSON.stringify({kind:'digital',workId:1,text:valid})}));assert.equal(preview.body.ok,true);
  const restarted=createApp({db,mode:'local'});const committed=await read(await req(restarted,'/imports/commit',cookie,{method:'POST',body:JSON.stringify({token:preview.body.token})}));assert.equal(committed.status,200);
  const duplicate=await read(await req(restarted,'/imports/preview',cookie,{method:'POST',body:JSON.stringify({kind:'digital',workId:1,text:valid})}));assert.equal(duplicate.body.ok,false);assert.match(duplicate.body.errors.map(x=>x.message).join(' '),/登録済み/);
  await db.close();
});

test('income totals are independent from campaign fanout and preserve signed returns',async(t)=>{
  const {db,app}=await fixture(t),cookie=await login(app);
  await db.run(`INSERT INTO sale_lines(org_id,project_id,work_id,product_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax) VALUES(1,1,1,1,2,'2026-09-01','2026-09-30','2026-09','sale',100000,10000,110000)`);
  await db.run(`INSERT INTO sale_lines(org_id,project_id,work_id,product_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax) VALUES(1,1,1,1,2,'2026-09-01','2026-09-30','2026-09','return',-10000,-1000,-11000)`);
  await db.run(`INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,'2026-09-15','2026-09','広告','expense',30000,3000,33000)`);
  for(const name of ['施策A','施策B'])await db.run(`INSERT INTO campaigns(org_id,project_id,work_id,name,objective,starts_on,ends_on) VALUES(1,1,1,?,'比較','2026-09-01','2026-09-30')`,[name]);
  const result=await read(await req(app,'/analytics/income?workId=1&month=2026-09',cookie));assert.equal(result.body.sales.exTax,90000);assert.equal(result.body.expenses.exTax,30000);assert.equal(result.body.profitExTax,60000);assert.match(result.body.source,/campaigns are not joined/);
  await db.close();
});

test('unknown observations remain null and are counted without illegal sums',async(t)=>{
  const {db,app}=await fixture(t),cookie=await login(app);
  const campaign=(await db.get(`INSERT INTO campaigns(org_id,project_id,work_id,name,objective,starts_on,ends_on) VALUES(1,1,1,'欠損試験','比較','2026-09-01','2026-09-30') RETURNING id`)).id;
  const exposure=(await db.get(`INSERT INTO exposures(org_id,campaign_id,medium) VALUES(1,?,'架空媒体') RETURNING id`,[campaign])).id;
  await db.run(`INSERT INTO observations(org_id,exposure_id,metric_definition_id,period_from,period_to,granularity,value_number,value_text,verification,acquired_at) VALUES(1,?,1,'2026-09-01','2026-09-30','month',NULL,NULL,'unverified','2026-10-01T00:00:00Z')`,[exposure]);
  const result=await read(await req(app,'/analytics/publicity?workId=1',cookie));assert.equal(result.body.groups[0].unknown,1);assert.equal(result.body.groups[0].result,null);
  await db.close();
});

test('optimistic versions, malicious keys, and stale proposal adoption fail',async(t)=>{
  const {db,app}=await fixture(t),cookie=await login(app);
  const scene=await read(await req(app,'/scenes',cookie,{method:'POST',body:JSON.stringify({project_id:1,work_id:1,scene_no:'CAS-1',synopsis:'before',status:'draft'})}));
  assert.equal((await req(app,`/scenes/${scene.body.id}`,cookie,{method:'PATCH',headers:{'If-Match':'1'},body:JSON.stringify({synopsis:'after'})})).status,200);
  assert.equal((await req(app,`/scenes/${scene.body.id}`,cookie,{method:'PATCH',headers:{'If-Match':'1'},body:JSON.stringify({synopsis:'lost update'})})).status,409);
  const malicious={fieldKey:'x);DROP_TABLE',label:'危険',valueType:'integer',unit:'回',aggregation:'sum',sampleHeader:'x',meaningReason:'検証',affectedApps:['publicity-form']};
  assert.equal((await req(app,'/proposals/import',cookie,{method:'POST',body:JSON.stringify(malicious)})).status,400);
  async function proposal(key){return (await read(await req(app,'/proposals/import',cookie,{method:'POST',body:JSON.stringify({...malicious,fieldKey:key,label:key,meaningReason:'安全な型付き項目'})}))).body;}
  const a=await proposal('metric_alpha'),b=await proposal('metric_beta');
  assert.equal((await req(app,`/proposals/${a.id}/adopt`,cookie,{method:'POST',body:JSON.stringify({hash:a.hash,baseSchemaVersion:1})})).status,200);
  assert.equal((await req(app,`/proposals/${b.id}/adopt`,cookie,{method:'POST',body:JSON.stringify({hash:b.hash,baseSchemaVersion:1})})).status,409);
  await db.close();
});

test('local invitations enforce fake addresses, expiry, project scope, and revocation',async(t)=>{
  const {db,app}=await fixture(t),cookie=await login(app);
  const past={email:'late@pilot.invalid',projectId:1,role:'editor',expiresAt:'2020-01-01T00:00:00Z'};
  assert.equal((await req(app,'/team/invitations',cookie,{method:'POST',body:JSON.stringify(past)})).status,400);
  const future={email:'guest@pilot.invalid',projectId:1,role:'editor',expiresAt:new Date(Date.now()+3600000).toISOString()};
  const invitation=await read(await req(app,'/team/invitations',cookie,{method:'POST',body:JSON.stringify(future)}));assert.equal(invitation.status,201);
  assert.equal((await req(app,`/team/invitations/${invitation.body.id}/accept`,cookie,{method:'POST',body:'{}'})).status,200);
  const guest=await login(app,'guest@pilot.invalid');assert.equal((await req(app,'/downloads/publicity?workId=1',guest)).status,200);assert.equal((await req(app,'/downloads/publicity?workId=2',guest)).status,403);
  assert.equal((await req(app,`/team/invitations/${invitation.body.id}/revoke`,cookie,{method:'POST',body:'{}'})).status,200);
  const afterRevoke=await read(await req(app,'/bootstrap',guest));assert.equal(afterRevoke.status,200);assert.deepEqual(afterRevoke.body.works,[]);await db.close();
});

test('worker mode never exposes local fixture login',async(t)=>{
  const db=await openTestDb({t}),worker=createApp({db,mode:'worker',authenticate:async()=>null});
  assert.equal((await worker.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
  assert.equal((await worker.request('/api/bootstrap')).status,401);await db.close();
});
