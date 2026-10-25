import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

// Z3 がわざと壊した版で見つけた消込の反例（formal/receipt_matching_cases.json。入金の確認の計画 #4）を、いまの API と DB へ流す。
// 正しい版が断る最後の入金だけが断られ、それまでの入金・取消は通り、断られた入金は1行も残らない。取引先はすべて架空配信（2）
const {cases:formalCases,registration_order:formalOrders}=JSON.parse(readFileSync(new URL('../formal/receipt_matching_cases.json',import.meta.url),'utf8'));

async function formalFixture(t,invoices){
  const db=await openTestDb({t}),app=createApp({db});
  const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  async function req(path,payload,headers={}){
    const response=await app.request(`/api${path}`,{method:payload?'POST':'GET',headers:{cookie,...(payload?{'content-type':'application/json'}:{}),...headers},body:payload?JSON.stringify(payload):undefined});
    return {status:response.status,data:await response.json()};
  }
  const invoiceIds={};
  for(const invoice of invoices){
    // 請求は税込の額（11で割り切れる）を、税抜＝額×10/11 の架空の売上1行から作る
    const reportKey=`FORMAL-${invoice.key}`,exTax=invoice.amount_yen*10/11;
    assert.ok(Number.isInteger(exTax),`${invoice.key} の額は11で割り切れる額にする`);
    good(await req('/sales',{workId:1,report_key:reportKey,kind:'digital',partner_id:2,product_id:1,period_from:'2026-09-01',period_to:'2026-09-30',recognition_basis_id:2,report_received_on:'2026-10-05',basis_reason:'架空の報告受領月',description:`架空配信売上 ${invoice.key}`,quantity:1,amount_ex_tax:exTax,tax_amount:invoice.amount_yen-exTax,amount_inc_tax:invoice.amount_yen}));
    const report=await db.get('SELECT id FROM report_imports WHERE report_key=?',[reportKey]);
    const made=good(await req('/billing/invoices',{workId:1,reportIds:[report.id],invoiceDate:invoice.invoice_date,dueDate:'2026-12-31',sourceAmountBasis:'platform_net',note:'架空請求'}));
    assert.equal(made.amountIncTax,invoice.amount_yen);
    invoiceIds[invoice.key]=made.invoiceId;
  }
  const receiptBody=step=>({partnerId:2,reference:`FORMAL-${step.receipt}`,receivedOn:step.received_on,amountYen:step.amount_yen,
    allocations:step.allocations.map(a=>({invoiceId:invoiceIds[a.invoice],amountYen:a.amount_yen})),
    ...(step.deductions?{deductions:step.deductions.map(d=>({kind:d.kind,amountYen:d.amount_yen}))}:{})});
  const receiptIds={};
  async function run(step){
    if(step.reverse)return good(await req(`/billing/receipts/${receiptIds[step.reverse]}/reverse`,{reversedOn:step.reversed_on,reason:'架空の誤登録の逆仕訳'},{'If-Match':'1'}));
    const made=good(await req('/billing/receipts',receiptBody(step)));
    receiptIds[step.receipt]=made.receiptId;
    return made;
  }
  const rows=async()=>({receipts:await db.all('SELECT * FROM billing_receipts ORDER BY id'),allocations:await db.all('SELECT * FROM billing_receipt_allocations ORDER BY receipt_id,invoice_id'),
    reversals:await db.all('SELECT receipt_id,reversed_on FROM billing_receipt_reversals ORDER BY receipt_id')});
  return {db,req,run,rows,receiptBody,invoiceIds};
}

// rejected_now があるものは、いまの API が rejected_by と別の決まりで断る（控除を受けない間）。試験の名前にその決まりを出す
for(const c of formalCases.filter(row=>row.replay?.api)){
  const how=c.replay.api.rejected_now?`（いまは「${c.replay.api.rejected_now}」の検査で）`:'';
  test(`Z3 の消込の反例（${c.broken}）を API と DB が断る${how}: ${c.name}`,async(t)=>{const f=await formalFixture(t,c.invoices);try{
    for(const step of c.steps.slice(0,-1))await f.run(step);
    const before=await f.rows();
    const result=await f.req('/billing/receipts',f.receiptBody(c.steps.at(-1)));
    assert.equal(result.status,c.replay.api.status,JSON.stringify(result.data));
    assert.equal(result.data.ok,false);
    assert.equal(result.data.error,c.replay.api.error);
    assert.deepEqual(await f.rows(),before,'断った入金は入金・消込のどちらにも残らない');
  }finally{await f.db.close()}});
}

test('Z3 の消込の反例のうち API に流さないものは、流さない理由と流す時（#6）を持つ',()=>{
  const pending=formalCases.filter(c=>!c.replay?.api);
  assert.deepEqual(pending.map(c=>c.broken),['合計が控除を数えない'],'API に流さない反例を足すときは、ここに名前を足して理由を書く');
  for(const c of pending)assert.match(c.pending?.api??'',/#6/,c.name);
});

test('Z3 の消込の反例のうち API が別の決まりで断るものは、その理由と直す時（#6）を持つ',()=>{
  const interim=formalCases.filter(c=>c.replay?.api?.rejected_now);
  assert.deepEqual(interim.map(c=>c.broken),['控除の種類の検査なし'],'API が rejected_by と別の決まりで断る反例を足すときは、ここに名前を足して理由を書く');
  for(const c of interim){
    assert.ok(!c.rejected_by.includes(c.replay.api.rejected_now),`${c.name}: rejected_now は rejected_by と別の決まりにする`);
    assert.match(c.replay.api.note??'',/#6/,c.name);
  }
});

// 取消の登録順（formal/receipt_matching.py の released_at_receipt_date の reversed_before<=r）は、どの不変条件にも効かないので、
// 同じ入力（registration_order）を模型と API の両方で流す。取消を登録する前の入金は断り、取消を登録したあとの同じ入金は通る
for(const o of formalOrders){
  test(`取消の登録順: ${o.name}`,async(t)=>{const f=await formalFixture(t,o.invoices);try{
    for(const step of o.before)await f.run(step);
    const before=await f.rows();
    const early=await f.req('/billing/receipts',f.receiptBody(o.receipt));
    assert.equal(early.status,o.replay.api.status,JSON.stringify(early.data));
    assert.equal(early.data.error,o.replay.api.error);
    assert.deepEqual(await f.rows(),before,'断った入金は入金・消込のどちらにも残らない');
    await f.run(o.reversal);
    const late=await f.run(o.receipt);
    assert.equal(late.reference,`FORMAL-${o.receipt.receipt}`);
    const after=await f.rows();
    assert.deepEqual(after.reversals.map(x=>[x.receipt_id,x.reversed_on]),[[1,o.reversal.reversed_on]]);
    assert.equal(after.receipts.length,o.before.length+1);
  }finally{await f.db.close()}});
}

test('取り消した入金の分は、取消日以後の入金日でだけ入れ直せる（取消日の前日は断り、当日は通る）',async(t)=>{const f=await formalFixture(t,[{key:'A',amount_yen:110000,invoice_date:'2026-11-02'}]);try{
  const step=(receipt,receivedOn)=>({receipt,received_on:receivedOn,amount_yen:110000,allocations:[{invoice:'A',amount_yen:110000}]});
  await f.run(step('R1','2026-11-10'));
  await f.run({reverse:'R1',reversed_on:'2026-11-20'});
  const dayBefore=await f.req('/billing/receipts',f.receiptBody(step('R2','2026-11-19')));
  assert.equal(dayBefore.status,409,JSON.stringify(dayBefore.data));
  assert.equal(dayBefore.data.error,'receipt exceeds invoice balance');
  const sameDay=await f.run(step('R3','2026-11-20'));
  assert.equal(sameDay.reference,'FORMAL-R3');
  const after=await f.rows();
  assert.deepEqual(after.allocations.map(a=>[a.receipt_id,a.amount_yen]),[[1,110000],[2,110000]]);
  assert.deepEqual(after.reversals.map(x=>[x.receipt_id,x.reversed_on]),[[1,'2026-11-20']]);
}finally{await f.db.close()}});
