import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,good} from './field-sales-independent-fixture.mjs';
const bill=(f,extra={})=>f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net',...extra});
const receipt=(f,id,reference,amountYen,date='2026-11-15')=>f.req('/billing/receipts',{partnerId:2,reference,receivedOn:date,amountYen,allocations:[{invoiceId:id,amountYen}]});

test('independent: partial overdue and final settlement preserve source and recognition',async(t)=>{const f=await fixture({t});try{
 const invoice=good(await bill(f));assert.equal(invoice.amountExTax,8000);assert.equal(invoice.taxAmount,800);assert.equal(invoice.amountIncTax,8800);
 const first=good(await receipt(f,invoice.invoiceId,'PART-A',4400));
 assert.equal((await receipt(f,invoice.invoiceId,'PART-A',4400)).status,409);
 let s=good(await f.req('/billing?workId=1&asOf=2026-11-14'));assert.equal(s.invoices[0].balanceAsOf,8800);
 s=good(await f.req('/billing?workId=1&asOf=2026-12-01'));assert.equal(s.invoices[0].balanceAsOf,4400);assert.equal(s.invoices[0].overdue,true);assert.equal(s.invoices[0].statusAsOf,'partially_paid');
 assert.equal((await f.req(`/billing/invoices/${invoice.invoiceId}/void`,{voidedOn:'2026-12-01',reason:'有効入金あり'},{version:1})).status,409);
 const before=await f.db.get('SELECT count(*) n FROM billing_receipts');assert.equal((await receipt(f,invoice.invoiceId,'OVER',4401)).status,409);assert.deepEqual(await f.db.get('SELECT count(*) n FROM billing_receipts'),before);
 good(await receipt(f,invoice.invoiceId,'PART-B',4400,'2026-12-02'));
 s=good(await f.req('/billing?workId=1&asOf=2026-12-02'));assert.equal(s.invoices[0].balanceAsOf,0);assert.equal(s.invoices[0].overdue,false);assert.equal(s.invoices[0].statusAsOf,'paid');
 assert.equal(s.monthly.find(x=>x.month==='2026-10').recognizedSalesExTax,8000);assert.equal(s.monthly.find(x=>x.month==='2026-11').actualReceipts,4400);assert.equal(s.monthly.find(x=>x.month==='2026-12').actualReceipts,4400);
 assert.equal(JSON.stringify(await f.db.all('SELECT * FROM sale_lines ORDER BY id')),f.originalSales);assert.deepEqual(await foreignKeyViolations(f.db),[]);
}finally{f.db.close()}});

test('independent: concurrent double billing succeeds once and void keeps old snapshot',async(t)=>{const f=await fixture({t});try{
 const outcomes=await Promise.all([bill(f),bill(f)]);assert.equal(outcomes.filter(x=>x.status===201).length,1);assert.equal(outcomes.filter(x=>x.status===409).length,1);const invoice=good(outcomes.find(x=>x.status===201));
 const old=await f.db.get('SELECT snapshot_json FROM billing_invoices WHERE id=?',[invoice.invoiceId]);
 assert.equal((await bill(f,{sourceAmountBasis:'gross'})).status,400);
 good(await f.req(`/billing/invoices/${invoice.invoiceId}/void`,{voidedOn:'2026-10-07',reason:'架空訂正'},{version:1}));
 assert.equal((await f.req(`/billing/invoices/${invoice.invoiceId}/void`,{voidedOn:'2026-10-07',reason:'再送'},{version:1})).status,409);
 const next=good(await bill(f,{invoiceDate:'2026-10-08'}));assert.notEqual(next.invoiceNumber,invoice.invoiceNumber);
 assert.deepEqual(await f.db.get('SELECT snapshot_json FROM billing_invoices WHERE id=?',[invoice.invoiceId]),old);
 assert.equal((await f.db.get('SELECT count(*) n FROM billing_sale_claims')).n,1);
}finally{f.db.close()}});

test('independent: shared product full-access boundary and global source claim',async(t)=>{const f=await fixture({t});try{
 const project=good(await f.req('/projects',{code:'SHARED-P',title:'別案件',status:'active'}));
 const work=good(await f.req('/works',{project_id:project.id,code:'SHARED-W',title:'共有作品',format:'film'}));
 await f.db.batch([{sql:'UPDATE product_works SET allocation_bps=6000 WHERE org_id=1 AND product_id=1 AND work_id=1'},{sql:'INSERT INTO product_works VALUES(1,1,?,4000)',params:[work.id]}]);
 const editor=await f.login('editor@openingnight.invalid');let state=good(await f.req('/billing?workId=1&asOf=2026-11-30',null,{cookie:editor}));assert.equal(state.candidates[0].eligible,false);assert.equal(state.candidates[0].amountIncTax,null);
 const invoice=good(await bill(f));assert.equal(invoice.amountIncTax,8800);
 state=good(await f.req(`/billing?workId=${work.id}&asOf=2026-11-30`));assert.equal(state.invoices[0].id,invoice.invoiceId);assert.equal(state.candidates[0].eligible,false);
 state=good(await f.req('/billing?workId=1&asOf=2026-11-30',null,{cookie:editor}));assert.equal(state.invoices.length,0);
 assert.equal((await f.req('/billing/receipts',{partnerId:2,reference:'NO-ACCESS',receivedOn:'2026-11-15',amountYen:8800,allocations:[{invoiceId:invoice.invoiceId,amountYen:8800}]},{cookie:editor})).status,403);
}finally{f.db.close()}});

test('independent: multi-invoice remittance is atomic with matching debtor and exact total',async(t)=>{const f=await fixture({t});try{
 const one=good(await bill(f));good(await f.req('/sales',{workId:1,report_key:'SECOND-BILL',kind:'digital',partner_id:2,product_id:1,period_from:'2026-10-01',period_to:'2026-10-31',recognition_basis_id:2,report_received_on:'2026-11-05',basis_reason:'架空受領',description:'2本目',amount_ex_tax:2000,tax_amount:200,amount_inc_tax:2200}));
 const report=await f.db.get("SELECT id FROM report_imports WHERE report_key='SECOND-BILL'");const two=good(await bill(f,{reportIds:[report.id],invoiceDate:'2026-11-06'}));
 const payload={partnerId:2,reference:'BULK',receivedOn:'2026-11-30',amountYen:11000,allocations:[{invoiceId:one.invoiceId,amountYen:8800},{invoiceId:two.invoiceId,amountYen:2200}]};
 assert.equal((await f.req('/billing/receipts',{...payload,amountYen:11001})).status,400);assert.equal((await f.req('/billing/receipts',{...payload,partnerId:1})).status,409);good(await f.req('/billing/receipts',payload));
 const state=good(await f.req('/billing?workId=1&asOf=2026-11-30'));assert.equal(state.invoices.every(x=>x.balanceAsOf===0),true);assert.equal(state.monthly.find(x=>x.month==='2026-11').actualReceipts,11000);
}finally{f.db.close()}});

test('independent: production and other organization cannot create/view financial documents',async(t)=>{const f=await fixture({t});try{
 const invoice=good(await bill(f));const production=await f.login('production@openingnight.invalid'),outsider=await f.login('outsider@other.invalid');
 for(const cookie of [production,outsider]){
  assert.equal((await f.req('/billing?workId=1&asOf=2026-11-30',null,{cookie})).status,403);
  assert.equal((await f.req('/sales-materials',{workId:1,opportunityId:f.opportunityId,title:'権限試験',synopsis:'概要',pitch:'提案',terms:'条件'},{cookie})).status,403);
  assert.equal((await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net'},{cookie})).status,403);
 }
}finally{f.db.close()}});
