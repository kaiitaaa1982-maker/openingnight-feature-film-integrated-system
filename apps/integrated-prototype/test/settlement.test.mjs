import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

async function fixture({t}={}){
  const db=await openTestDb({t}),app=createApp({db,mode:'local'});
  const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const req=async(path,payload)=>{const response=await app.request(`/api${path}`,{method:payload?'POST':'GET',headers:{cookie,...(payload?{'content-type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});return {status:response.status,body:await response.json()}};
  return {db,req};
}

test('condition versions are immutable and mixed report bases are not combined',async(t)=>{
  const {db,req}=await fixture({t});
  try{
    const contract=await req('/settlement/contracts',{workId:1,contractCode:'RIGHTS-MIXED',title:'架空手数料契約',contractType:'commission',holderPartnerId:3,terms:{platformRateBps:5000,agencyFeeBps:2000}});
    assert.equal(contract.status,201);
    await assert.rejects(db.run('UPDATE settlement_term_versions SET agency_fee_bps=1000 WHERE id=?',[contract.body.versionId]),/immutable/);
    async function sale(key,amount){const result=await req('/sales',{workId:1,kind:'digital',report_key:key,partner_id:2,period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09',description:key,amount_ex_tax:amount,tax_amount:0,amount_inc_tax:amount});assert.equal(result.status,200);return (await req('/reports?workId=1')).body.rows.find(row=>row.report_key===key).id;}
    const gross=await sale('MIXED-GROSS',100000),net=await sale('MIXED-NET',50000);
    for(const [reportId,reportBasis] of [[gross,'gross'],[net,'net']])assert.equal((await req('/settlement/links',{reportId,workId:1,contractId:contract.body.contractId,termVersionId:contract.body.versionId,reportBasis})).status,201);
    const preview=(await req('/settlement/preview?workId=1')).body,summary=preview.contractSummaries[0];
    assert.equal(summary.reportBasis,'mixed');assert.equal(summary.reportedAmount,null);assert.equal(summary.grossReported,100000);assert.equal(summary.netReported,50000);assert.equal(summary.platformNet,100000);
  }finally{await db.close()}
});

test('one shared sale is allocated once and report basis is consistent across works',async(t)=>{
  const {db,req}=await fixture({t});
  try{
    await db.run("INSERT INTO works(id,org_id,project_id,code,title,format) VALUES(3,1,1,'WRK-SHARED','配賦先B','film')");
    const product=(await db.get("INSERT INTO products(org_id,sku,name,channel) VALUES(1,'SKU-SHARED','共有商品','digital') RETURNING id")).id;
    await db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,?,?,5000)',[product,1]);
    await db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,?,?,5000)',[product,3]);
    async function contract(workId,code){const result=await req('/settlement/contracts',{workId,contractCode:code,title:'配賦検証',contractType:'self_owned',terms:{platformRateBps:0}});assert.equal(result.status,201);return result.body;}
    const first=await contract(1,'RIGHTS-SHARED-A'),second=await contract(3,'RIGHTS-SHARED-B');
    assert.equal((await req('/sales',{workId:1,kind:'digital',report_key:'SHARED-REPORT',partner_id:2,product_id:product,period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09',description:'共有作品売上',amount_ex_tax:101,tax_amount:0,amount_inc_tax:101})).status,200);
    const reportId=(await req('/reports?workId=1')).body.rows.find(row=>row.report_key==='SHARED-REPORT').id;
    assert.equal((await req('/settlement/links',{reportId,workId:1,contractId:first.contractId,termVersionId:first.versionId,reportBasis:'gross'})).status,201);
    assert.equal((await req('/settlement/links',{reportId,workId:3,contractId:second.contractId,termVersionId:second.versionId,reportBasis:'net'})).status,409);
    assert.equal((await req('/settlement/links',{reportId,workId:3,contractId:second.contractId,termVersionId:second.versionId,reportBasis:'gross'})).status,201);
    const a=(await req('/settlement/preview?workId=1')).body.lineResults[0],b=(await req('/settlement/preview?workId=3')).body.lineResults[0];
    assert.equal(a.reportedAmount+b.reportedAmount,101);assert.deepEqual([a.reportedAmount,b.reportedAmount],[51,50]);
    await db.run("UPDATE report_imports SET status='void' WHERE id=?",[reportId]);
    assert.equal((await req('/settlement/preview?workId=1')).body.lineResults.length,0);
  }finally{await db.close()}
});
