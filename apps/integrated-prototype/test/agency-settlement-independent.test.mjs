import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignKeyViolations, openTestDb } from './test-db.mjs';
import { createApp } from '../src/app.mjs';

test('FR-PLAN-ACQ-010 independent agency examples preserve bases, immutable terms, MG pool and authorization', async (t) => {
  const db=await openTestDb({t});
  try {
    const app=createApp({db});
    async function login(email){const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
    const admin=await login('admin@openingnight.invalid');
    async function req(path,body,cookie=admin){const r=await app.request('/api'+path,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
    function success(result){assert.ok(result.status>=200&&result.status<300,JSON.stringify(result));return result.data;}
    let seq=0;
    async function contract(type,extra={}){
      const code=`INDEPENDENT-${++seq}`;
      success(await req('/settlement/contracts',{workId:1,contractCode:code,title:'架空の独立検証',contractType:type,holderPartnerId:type==='self_owned'?undefined:3,...extra,terms:{platformRateBps:5000,agencyFeeBps:type==='self_owned'?0:2000,...extra.terms}}));
      const list=success(await req('/settlement/contracts?workId=1')).contracts;
      const c=list.find(x=>(x.contractCode??x.contract_code)===code);assert.ok(c,JSON.stringify(list));return c;
    }
    async function report(amount){
      const key=`INDEPENDENT-REPORT-${++seq}`;
      success(await req('/sales',{workId:1,kind:'digital',report_key:key,partner_id:2,period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09',description:'新規架空検証',quantity:1,amount_ex_tax:amount,tax_amount:0,amount_inc_tax:amount}));
      return success(await req('/reports?workId=1')).rows.find(x=>x.report_key===key).id;
    }
    async function link(c,reportId,basis,versionId=c.versions[0].id){return req('/settlement/links',{reportId,workId:1,contractId:c.id,termVersionId:versionId,reportBasis:basis});}
    const preview=async()=>success(await req('/settlement/preview?workId=1'));
    const commission=await contract('commission');
    const gross=await report(100000);success(await link(commission,gross,'gross'));
    const net=await report(50000);success(await link(commission,net,'net'));
    let p=await preview();
    let line=p.lineResults.find(x=>x.reportId===gross);
    assert.equal(line.platformDeduction,50000);assert.equal(line.platformNet,50000);assert.equal(line.agencyFee,10000);assert.equal(line.holderAmount,40000);
    line=p.lineResults.find(x=>x.reportId===net);
    assert.equal(line.grossAmount,null);assert.equal(line.platformDeduction,null);assert.equal(line.platformNet,50000);assert.equal(line.agencyFee,10000);assert.equal(line.holderAmount,40000);
    assert.equal((await link(commission,gross,'net')).status,409);
    success(await req(`/settlement/contracts/${commission.id}/versions`,{platformRateBps:5000,agencyFeeBps:3000}));
    p=await preview();assert.equal(p.lineResults.find(x=>x.reportId===gross).agencyFee,10000);
    const reversal=await report(-100000);success(await link(commission,reversal,'gross'));
    line=(await preview()).lineResults.find(x=>x.reportId===reversal);
    assert.equal(line.platformNet,-50000);assert.equal(line.agencyFee,-10000);assert.equal(line.holderAmount,-40000);
    const self=await contract('self_owned');const ownedReport=await report(100000);success(await link(self,ownedReport,'gross'));
    assert.equal((await preview()).lineResults.find(x=>x.reportId===ownedReport).ownReceipts,50000);
    const mg=await contract('mg',{mgContractYen:30000,terms:{recoupBasis:'after_fee'}});
    const mgReport=await report(100000);success(await link(mg,mgReport,'gross'));
    let summary=(await preview()).contractSummaries.find(x=>x.contractId===mg.id);
    assert.equal(summary.mgPaidYen,null);assert.equal(summary.recoupSource,40000);assert.equal(summary.recouped,30000);assert.equal(summary.mgBalance,0);assert.equal(summary.excess,10000);assert.equal(summary.holderAdditional,null);
    success(await req(`/settlement/contracts/${mg.id}/versions`,{platformRateBps:5000,agencyFeeBps:2000,recoupBasis:'after_fee'}));
    const newMg=success(await req('/settlement/contracts?workId=1')).contracts.find(x=>x.id===mg.id);
    const latest=newMg.versions.reduce((a,b)=>a.id>b.id?a:b);
    success(await link(mg,await report(100000),'gross',latest.id));
    summary=(await preview()).contractSummaries.find(x=>x.contractId===mg.id);
    assert.equal(summary.recoupSource,80000);assert.equal(summary.recouped,30000);assert.equal(summary.excess,50000);
    const mgNet=await contract('mg',{mgContractYen:30000,mgPaidYen:30000,terms:{recoupBasis:'platform_net'}});
    success(await link(mgNet,await report(100000),'gross'));
    summary=(await preview()).contractSummaries.find(x=>x.contractId===mgNet.id);
    assert.equal(summary.recoupSource,50000);assert.equal(summary.recouped,30000);assert.equal(summary.excess,20000);
    const odd=await report(101),oddReturn=await report(-101);
    success(await link(commission,odd,'gross'));success(await link(commission,oddReturn,'gross'));
    p=await preview();
    const oddLine=p.lineResults.find(x=>x.reportId===odd),negativeLine=p.lineResults.find(x=>x.reportId===oddReturn);
    assert.equal(oddLine.platformDeduction,50);assert.equal(oddLine.agencyFee,10);assert.equal(oddLine.holderAmount,41);
    for(const key of ['reportedAmount','platformDeduction','platformNet','agencyFee','holderAmount'])assert.equal(oddLine[key]+negativeLine[key],0);
    await db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,1,'MULTI-CHECK','別作品（架空）')");
    const product=success(await req('/products',{sku:'MULTI-CHECK',name:'複数作品（架空）',channel:'digital'}));
    success(await req('/product-works',{productId:product.id,allocations:[{workId:1,allocationBps:4000},{workId:3,allocationBps:6000}]}));
    const secondContract=success(await req('/settlement/contracts',{workId:3,contractCode:'SECOND-WORK',title:'別作品契約',contractType:'commission',holderPartnerId:3,terms:{platformRateBps:5000,agencyFeeBps:2000}}));
    success(await req('/sales',{workId:1,kind:'digital',report_key:'MULTI-REPORT',product_id:product.id,partner_id:2,period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09',description:'配賦検証',quantity:1,amount_ex_tax:100000,tax_amount:0,amount_inc_tax:100000}));
    const multiId=success(await req('/reports?workId=1')).rows.find(x=>x.report_key==='MULTI-REPORT').id;
    success(await link(commission,multiId,'gross'));
    const secondLink={reportId:multiId,workId:3,contractId:secondContract.contractId,termVersionId:secondContract.versionId,reportBasis:'net'};
    assert.equal((await req('/settlement/links',secondLink)).status,409);
    success(await req('/settlement/links',{...secondLink,reportBasis:'gross'}));
    const firstMulti=(await preview()).lineResults.find(x=>x.reportId===multiId);
    const secondMulti=success(await req('/settlement/preview?workId=3')).lineResults.find(x=>x.reportId===multiId);
    assert.equal(firstMulti.holderAmount,16000);assert.equal(secondMulti.holderAmount,24000);
    const oldKey=(await db.get('SELECT report_key FROM report_imports WHERE id=?',[gross])).report_key;
    success(await req('/sales',{workId:1,kind:'digital',report_key:oldKey,supersedes_id:gross,partner_id:2,period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09',description:'訂正版',quantity:1,amount_ex_tax:120000,tax_amount:0,amount_inc_tax:120000}));
    p=await preview();assert.equal(p.lineResults.some(x=>x.reportId===gross),false);assert.ok(p.unlinkedReports.some(x=>x.report_key===oldKey));
    const production=await login('production@openingnight.invalid'),outsider=await login('outsider@other.invalid'),editor=await login('editor@openingnight.invalid');
    assert.equal((await req('/settlement/preview?workId=1',null,production)).status,403);
    assert.equal((await req('/settlement/contracts?workId=1',null,outsider)).status,403);
    await db.run("UPDATE project_memberships SET permission='production' WHERE org_id=1 AND user_id=2 AND project_id=1");
    assert.equal((await req('/settlement/preview?workId=1',null,editor)).status,403);
    assert.deepEqual(await foreignKeyViolations(db),[]);
  } finally {await db.close();}
});
