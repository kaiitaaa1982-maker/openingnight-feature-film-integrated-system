import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

async function fixture(t){
  const db=await openTestDb({t}),app=createApp({db});
  async function login(email='admin@openingnight.invalid'){const response=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0]}
  const cookie=await login();
  async function req(path,payload,options={}){const response=await app.request(`/api${path}`,{method:options.method||(payload?'POST':'GET'),headers:{cookie:options.cookie||cookie,...(payload?{'content-type':'application/json'}:{}),...(options.version?{'If-Match':String(options.version)}:{}),...(options.headers||{})},body:payload?JSON.stringify(payload):undefined});const type=response.headers.get('content-type')||'';return {status:response.status,data:type.includes('json')?await response.json():await response.text()}}
  const opportunity=(await req('/opportunities',{project_id:1,work_id:1,partner_id:2,name:'架空請求デモ商談',stage:'proposal',expected_yen:660000,close_date:'2026-10-01'})).data;
  const sale=(await req('/sales',{workId:1,report_key:'BILLING-DEMO-202609',kind:'digital',partner_id:2,product_id:1,period_from:'2026-09-01',period_to:'2026-09-30',recognition_basis_id:2,report_received_on:'2026-10-05',basis_reason:'架空の報告受領月',description:'架空配信売上',quantity:100,amount_ex_tax:600000,tax_amount:60000,amount_inc_tax:660000})).data;assert.equal(sale.ok,true);
  const report=await db.get("SELECT * FROM report_imports WHERE report_key='BILLING-DEMO-202609'");
  return {db,app,req,login,opportunityId:opportunity.id,report};
}
const good=result=>{assert.ok(result.status<300&&result.data.ok,JSON.stringify(result));return result.data};

test('sales material snapshots escape HTML and remain immutable',async(t)=>{const f=await fixture(t);try{
  const made=good(await f.req('/sales-materials',{workId:1,opportunityId:f.opportunityId,productId:1,title:'灯台へ帰る日 <架空>',synopsis:'海辺の物語 <script>alert(1)</script>',pitch:'配信向けの提案',terms:'架空条件。正式契約ではない'}));
  await f.db.run('UPDATE partners SET name=? WHERE id=2',['後日の名称変更']);
  const list=good(await f.req('/sales-materials?workId=1'));assert.equal(list.rows[0].version_no,1);assert.equal(list.rows[0].partner_name,'架空配信');
  const html=await f.req(`/sales-materials/${made.materialId}/html`);assert.equal(html.status,200);assert.match(html.data,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(html.data,/<script>alert/);
  assert.match(html.data,/架空配信/);assert.doesNotMatch(html.data,/後日の名称変更/);
  await assert.rejects(f.db.run('UPDATE sales_material_snapshots SET title=? WHERE id=?',['改変',made.materialId]));
}finally{await f.db.close()}});

test('FR-REV-INTAKE-030 invoice and receipt events preserve source sales, balances and historical reversals',async(t)=>{const f=await fixture(t);try{
  const before=JSON.stringify(await f.db.all('SELECT * FROM sale_lines ORDER BY id'));
  const candidates=good(await f.req('/billing?workId=1&asOf=2026-10-06')).candidates;assert.equal(candidates.find(row=>row.id===f.report.id).amountIncTax,660000);
  const invoice=good(await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net',note:'架空請求'}));assert.equal(invoice.amountIncTax,660000);
  await f.db.run('UPDATE partners SET name=? WHERE id=2',['請求後の名称変更']);
  const invoiceHtml=await f.req(`/billing/invoices/${invoice.invoiceId}/html`);assert.match(invoiceHtml.data,/架空配信/);assert.doesNotMatch(invoiceHtml.data,/請求後の名称変更/);
  assert.equal((await f.req('/billing/invoices',{workId:1,reportIds:[f.report.id],invoiceDate:'2026-10-06',dueDate:'2026-11-30',sourceAmountBasis:'platform_net'})).status,409);
  assert.equal(JSON.stringify(await f.db.all('SELECT * FROM sale_lines ORDER BY id')),before);
  const correction=await f.req('/sales',{workId:1,report_key:'BILLING-DEMO-202609',kind:'digital',partner_id:2,product_id:1,period_from:'2026-09-01',period_to:'2026-09-30',recognition_basis_id:2,report_received_on:'2026-10-06',basis_reason:'訂正',description:'訂正',amount_ex_tax:600000,tax_amount:60000,amount_inc_tax:660000,supersedes_id:f.report.id});assert.equal(correction.status,409);
  const first=good(await f.req('/billing/receipts',{partnerId:2,reference:'=BILL-RCP-001',receivedOn:'2026-11-15',amountYen:330000,allocations:[{invoiceId:invoice.invoiceId,amountYen:330000}]}));
  let state=good(await f.req('/billing?workId=1&asOf=2026-11-15'));assert.equal(state.invoices[0].balanceAsOf,330000);assert.equal(state.invoices[0].statusAsOf,'partially_paid');
  state=good(await f.req('/billing?workId=1&asOf=2026-12-01'));assert.equal(state.invoices[0].statusAsOf,'partially_paid');assert.equal(state.invoices[0].overdue,true);
  assert.equal((await f.req('/billing/receipts',{partnerId:2,reference:'OVERPAY',receivedOn:'2026-11-16',amountYen:330001,allocations:[{invoiceId:invoice.invoiceId,amountYen:330001}]})).status,409);
  good(await f.req(`/billing/receipts/${first.receiptId}/reverse`,{reversedOn:'2026-11-20',reason:'架空誤登録の逆仕訳'},{headers:{'If-Match':'1'}}));
  state=good(await f.req('/billing?workId=1&asOf=2026-11-19'));assert.equal(state.invoices[0].balanceAsOf,330000);
  state=good(await f.req('/billing?workId=1&asOf=2026-11-20'));assert.equal(state.invoices[0].balanceAsOf,660000);assert.equal(state.monthly.find(row=>row.month==='2026-11').actualReceipts,0);
  const csv=await f.req('/billing/cashflow.csv?workId=1&asOf=2026-11-20');assert.match(csv.data,/'=BILL-RCP-001/);assert.match(csv.data,/入金逆仕訳/);
  assert.equal((await f.req(`/billing/invoices/${invoice.invoiceId}/void`,{voidedOn:'2026-11-19',reason:'逆仕訳より前には取消不可'},{version:1})).status,409);
  good(await f.req(`/billing/invoices/${invoice.invoiceId}/void`,{voidedOn:'2026-11-21',reason:'架空請求を取消'},{version:1}));
  state=good(await f.req('/billing?workId=1&asOf=2026-11-20'));assert.equal(state.invoices[0].statusAsOf,'issued');
  state=good(await f.req('/billing?workId=1&asOf=2026-11-21'));assert.equal(state.invoices[0].statusAsOf,'void');
  assert.equal((await f.db.get('SELECT count(*) AS n FROM billing_sale_claims')).n,0);
  assert.equal(JSON.stringify(await f.db.all('SELECT * FROM sale_lines ORDER BY id')),before);
  assert.deepEqual(await foreignKeyViolations(f.db),[]);
}finally{await f.db.close()}});

test('billing endpoints deny production and keep tax as source values',async(t)=>{const f=await fixture(t);try{const production=await f.login('production@openingnight.invalid');assert.equal((await f.req('/billing?workId=1&asOf=2026-11-30',null,{cookie:production})).status,403);assert.equal((await f.req('/sales-materials?workId=1',null,{cookie:production})).status,403);const candidate=good(await f.req('/billing?workId=1&asOf=2026-11-30')).candidates[0];assert.equal(candidate.amountExTax,600000);assert.equal(candidate.taxAmount,60000);assert.equal(candidate.amountIncTax,660000)}finally{await f.db.close()}});
