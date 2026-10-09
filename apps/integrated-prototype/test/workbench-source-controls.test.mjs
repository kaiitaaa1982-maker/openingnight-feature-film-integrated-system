import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {rowsFromSheet} from '../src/workbench-ui.mjs';

async function fixture({t,extractWorkbenchFile}={}){
  const db=await openTestDb({t}),app=createApp({db,mode:'local',extractWorkbenchFile});
  const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
  return {db,app,cookie:login.headers.get('set-cookie').split(';')[0]};
}
async function request(app,cookie,path,input){
  const response=await app.request(`/api/workbench${path}`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(input)});
  return {status:response.status,body:await response.json()};
}
const base={period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09'};

test('FR-REV-INTAKE-022 approved report preserves declared source totals and database reconciliation',async(t)=>{
  const {db,app,cookie}=await fixture({t});
  try{
    const row={...base,report_key:'CONTROLLED-DIGITAL',kind:'digital',partner_id:2,product_id:1,digital_model:'tvod',service_code:'SERVICE-TEST',sales_count:1,unit_price_ex_tax:'100',amount_ex_tax:100,tax_amount:10,amount_inc_tax:110};
    const draft=await request(app,cookie,'/drafts',{dataset:'sales_import',workId:1,rows:[row]});
    assert.equal(draft.status,201);
    const id=draft.body.draft.id,sourceTotals={rowCount:'1',amountExTax:'100',taxAmount:'10',amountIncTax:'110'};
    const mismatch=await request(app,cookie,`/drafts/${id}/validate`,{revision:1,sourceTotals:{...sourceTotals,amountExTax:'101'}});
    assert.equal(mismatch.status,409);
    const valid=await request(app,cookie,`/drafts/${id}/validate`,{revision:1,sourceTotals,channelTotals:{rowCount:'1',amountExTax:'100'}});
    assert.equal(valid.status,200,JSON.stringify(valid.body));
    assert.equal(valid.body.validation.changes.sourceTotals.byChannel.digital.amountExTax,'100');
    const submitted=await request(app,cookie,`/drafts/${id}/submit`,{revision:1,validationId:valid.body.validation.id,reason:'架空原本との照合'});
    const cs=submitted.body.changeSet;
    const readback=await app.request(`/api/workbench/change-sets/${cs.id}/validation`,{headers:{cookie}});
    assert.equal(readback.status,200);
    assert.deepEqual((await readback.json()).validation.changes.sourceTotals.byChannel.digital,{rowCount:'1',amountExTax:'100'});
    assert.equal((await request(app,cookie,`/change-sets/${cs.id}/approve`,{revision:1,hash:cs.hash})).status,200);
    assert.equal((await request(app,cookie,`/change-sets/${cs.id}/apply`,{revision:1,hash:cs.hash,idempotencyKey:'controlled-digital-1'})).status,200);
    assert.equal((await db.get("SELECT COUNT(*) n FROM report_source_controls c JOIN report_imports r ON r.id=c.report_id WHERE r.report_key='CONTROLLED-DIGITAL'")).n,6);
    assert.equal((await db.get('SELECT sales_count FROM digital_sale_details')).sales_count,1);
    await assert.rejects(()=>db.run('UPDATE sale_lines SET amount_ex_tax=101 WHERE report_id=(SELECT id FROM report_imports WHERE report_key=?)',['CONTROLLED-DIGITAL']),/immutable/);
  }finally{await db.close()}
});

test('FR-REV-INTAKE-025 inventory-only package report checks source row count without creating a sale',async(t)=>{
  const {db,app,cookie}=await fixture({t});
  try{
    const row={...base,report_key:'CONTROLLED-STOCK',kind:'package',partner_id:3,product_id:2,inventory_count:25,inventory_as_of:'2026-09-30',observation_unit:'枚',observation_scope:'月末倉庫',observation_basis:'架空報告'};
    const draft=await request(app,cookie,'/drafts',{dataset:'sales_import',workId:1,rows:[row]});
    const id=draft.body.draft.id;
    const valid=await request(app,cookie,`/drafts/${id}/validate`,{revision:1,sourceTotals:{rowCount:'1',amountExTax:'0'}});
    assert.equal(valid.status,200,JSON.stringify(valid.body));
    const submitted=await request(app,cookie,`/drafts/${id}/submit`,{revision:1,validationId:valid.body.validation.id,reason:'架空在庫報告'});
    const cs=submitted.body.changeSet;
    assert.equal((await request(app,cookie,`/change-sets/${cs.id}/approve`,{revision:1,hash:cs.hash})).status,200);
    assert.equal((await request(app,cookie,`/change-sets/${cs.id}/apply`,{revision:1,hash:cs.hash,idempotencyKey:'controlled-stock-1'})).status,200);
    assert.equal((await db.get("SELECT COUNT(*) n FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE r.report_key='CONTROLLED-STOCK'")).n,0);
    assert.equal((await db.get("SELECT count n FROM package_report_observations WHERE metric='inventory'")).n,25);
  }finally{await db.close()}
});

test('uploaded source IDs are compared with server-frozen extraction rows',async(t)=>{
  const source={...base,report_key:'FILE-ID-CHECK',kind:'digital',partner_id:'999',product_id:'1',amount_ex_tax:'100',tax_amount:'10',amount_inc_tax:'110'};
  const headers=Object.keys(source),sheet={name:'CSV',rows:[headers,headers.map(key=>source[key])],formulaIssues:[]};
  const {db,app,cookie}=await fixture({t,extractWorkbenchFile:async()=>({sheets:[sheet],sourceEncoding:'utf-8'})});
  try{
    const extracted=await request(app,cookie,'/files/extract',{name:'fake.csv',base64:Buffer.from('fictional sheet').toString('base64'),workId:1});
    assert.equal(extracted.status,200,JSON.stringify(extracted.body));
    const frozen=rowsFromSheet(sheet,1,extracted.body.file.sourceHash);
    const edited={...frozen[0],partner_id:2,_lineage:[{source:'forged',row:1}]};
    const draft=await request(app,cookie,'/drafts',{dataset:'sales_import',workId:1,sourceArtifactId:extracted.body.sourceArtifactId,sheetName:'CSV',headerRow:1,rows:[edited]});
    assert.equal(draft.status,201,JSON.stringify(draft.body));
    const saved=await db.get('SELECT rows_json FROM workbench_drafts WHERE id=?',[draft.body.draft.id]);
    assert.equal(JSON.parse(saved.rows_json)[0]._lineage,undefined);
    const validated=await request(app,cookie,`/drafts/${draft.body.draft.id}/validate`,{revision:1,formatConfirmed:true,sourceIdentifierColumns:{partner_id:'partner_id'},sourceTotals:{rowCount:'1',amountExTax:'100'}});
    assert.equal(validated.status,409,JSON.stringify(validated.body));
    assert.match(JSON.stringify(validated.body),/partner_id/);
  }finally{await db.close()}
});
