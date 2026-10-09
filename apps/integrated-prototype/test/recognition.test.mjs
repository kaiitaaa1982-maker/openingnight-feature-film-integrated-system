import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv} from '../src/csv.mjs';

async function setup({t}={}){
  const db=await openTestDb({t}),app=createApp({db,mode:'local'});
  const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const req=async(path,payload)=>{const response=await app.request(`/api${path}`,{method:payload?'POST':'GET',headers:{cookie,...(payload?{'content-type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});return {status:response.status,body:await response.json()}};
  return {db,req};
}
const base={workId:1,kind:'digital',partner_id:2,period_from:'2026-09-01',period_to:'2026-09-30',sales_period_from:'2026-09-01',sales_period_to:'2026-09-30',description:'架空売上',quantity:1,amount_ex_tax:100,tax_amount:10,amount_inc_tax:110};

test('FR-REV-INTAKE-026 recognition metadata is atomic, immutable, and enforced by database triggers',async(t)=>{
  const {db,req}=await setup({t});
  try{
    const created=await req('/sales',{...base,report_key:'RECOGNITION-TRIGGER',recognition_basis_id:1,sales_month:'2026-09',basis_reason:'単月販売実績'});assert.equal(created.status,200);
    const report=(await req('/reports?workId=1')).body.rows.find(row=>row.report_key==='RECOGNITION-TRIGGER'),line=(await req('/sales?workId=1')).body.rows.find(row=>row.report_id===report.id);
    assert.equal(report.resolved_month,'2026-09');assert.equal(line.accounting_month,'2026-09');
    await assert.rejects(db.run('UPDATE report_recognition SET basis_reason=? WHERE org_id=1 AND report_id=?',['改変',report.id]),/immutable/);
    await assert.rejects(db.run("UPDATE sale_lines SET sales_period_to='2026-10-01' WHERE id=?",[line.id]),/single-month/);
    await assert.rejects(db.run("UPDATE report_imports SET accounting_month='2026-10' WHERE id=?",[report.id]),/mismatch/);
    assert.deepEqual(await foreignKeyViolations(db),[]);
  }finally{await db.close()}
});

test('FR-REV-INTAKE-027 typed multi-month CSV is rejected and old preview payload cannot commit',async(t)=>{
  const {db,req}=await setup({t});
  try{
    const headers=['report_key','partner_id','period_from','period_to','sales_period_from','sales_period_to','recognition_basis_id','sales_month','basis_reason','description','quantity','amount_ex_tax','tax_amount','amount_inc_tax'];
    const csv=toCsv(headers,[
      ['RECOGNITION-SPLIT',2,'2026-09-01','2026-10-31','2026-09-01','2026-09-30',1,'2026-09','月次基準','9月',1,100,10,110],
      ['RECOGNITION-SPLIT',2,'2026-09-01','2026-10-31','2026-10-01','2026-10-31',1,'2026-10','月次基準','10月',1,100,10,110]
    ]);
    const preview=await req('/imports/preview',{workId:1,kind:'digital',text:csv});assert.equal(preview.body.ok,false);assert.match(JSON.stringify(preview.body.errors),/分割/);assert.equal((await db.get('SELECT COUNT(*) AS n FROM report_imports')).n,0);
    const expires=new Date(Date.now()+60000).toISOString();await db.run('INSERT INTO import_previews(token,org_id,user_id,project_id,work_id,payload_json,expires_at) VALUES(?,?,?,?,?,?,?)',['old',1,1,1,1,JSON.stringify({orgId:1,userId:1,kind:'digital',workId:1,projectId:1,raw:'old',hash:'old',rows:[],errors:[],schemaVersion:1,meta:null}),expires]);
    const old=await req('/imports/commit',{token:'old'});assert.equal(old.status,409);assert.match(old.body.error,/旧形式/);
  }finally{await db.close()}
});
