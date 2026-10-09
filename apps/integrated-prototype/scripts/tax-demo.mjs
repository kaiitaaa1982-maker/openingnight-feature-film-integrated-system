import {resolve} from 'node:path';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import assert from 'node:assert/strict';

// Only the dedicated synthetic annual-sales database is accepted.
const file=resolve('../../analytics-poc/.runtime/year-demo.sqlite');
const db=new LocalDatabase(file),app=createApp({db});
try{
 const auth=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
 const cookie=auth.headers.get('set-cookie').split(';')[0];
 async function req(path,body){const r=await app.request('/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const out=await r.json();if(!r.ok||out.ok===false)throw Error(`${path}: ${JSON.stringify(out)}`);return out}
 const baseline=await db.get("SELECT COUNT(*) AS count,SUM(amount_ex_tax) AS amount FROM sale_lines WHERE id IN (SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE r.report_key NOT LIKE 'TAX-DEMO-%')");
 let rules=(await req('/tax/rules')).rules;
 if(!rules.some(r=>r.partner_id==null))await req('/tax/rules',{partnerId:null,baseVersion:0,effectiveFrom:'2025-01-01',basis:'exclusive',grouping:'invoice',rounding:'truncate',precision:0,reason:'架空デモ：税抜の月次請求を税率別に集計して1円未満切捨て',evidence:'代表承認の標準ルール（2026-09-20）。架空デモ用'});
 const results=[];
 for(const scenario of [{key:'EXCLUSIVE',month:'2026-09',date:'2026-09-20',expected:{base:2010,tax:201,total:2211}},{key:'INCLUSIVE',month:'2026-10',date:'2026-10-05',expected:{base:2010,tax:200,total:2210}}]){
  if(scenario.key==='INCLUSIVE'){
   rules=(await req('/tax/rules')).rules;
   if(!rules.some(r=>r.partner_id===2))await req('/tax/rules',{partnerId:2,baseVersion:0,effectiveFrom:'2026-10-01',basis:'inclusive',grouping:'voucher',rounding:'truncate',precision:2,reason:'架空デモ：取引先の税込起点・伝票別小数2桁の参考計算',evidence:'実在する取引先条件ではないテスト用の合意'});
  }
  const ids=[];
  for(let i=1;i<=2;i++){
   const key=`TAX-DEMO-${scenario.key}-${i}`;
   let report=await db.get('SELECT id FROM report_imports WHERE org_id=1 AND report_key=? AND status=\'active\'',[key]);
   if(!report){await req('/sales',{workId:1,report_key:key,kind:'digital',partner_id:2,product_id:1,period_from:`${scenario.month}-01`,period_to:`${scenario.month}-20`,recognition_basis_id:1,sales_month:scenario.month,basis_reason:'架空デモの販売月',description:`税計算説明用の架空明細 ${scenario.key} ${i}`,amount_ex_tax:1005,tax_amount:100,amount_inc_tax:1105});report=await db.get('SELECT id FROM report_imports WHERE org_id=1 AND report_key=?',[key])}
   ids.push(report.id);
  }
  const existing=await db.get('SELECT i.* FROM billing_sale_claims c JOIN billing_invoices i ON i.org_id=c.org_id AND i.id=c.invoice_id JOIN sale_lines s ON s.org_id=c.org_id AND s.id=c.sale_id WHERE s.org_id=1 AND s.report_id=?',[ids[0]]);
  let invoice=existing;
  if(!invoice){
   const sources=await req(`/tax/sources?workId=1&reportIds=${ids.join(',')}`),lineRates=sources.lines.map(l=>({saleId:l.id,category:'standard',rateBps:1000}));
   const input={workId:1,reportIds:ids,invoiceDate:scenario.date,lineRates};
   const preview=await req('/tax/preview',input);
   assert.equal(preview.billed.amountExTax,scenario.expected.base);assert.equal(preview.billed.taxAmount,scenario.expected.tax);assert.equal(preview.billed.amountIncTax,scenario.expected.total);
   const made=await req('/billing/invoices',{...input,dueDate:scenario.key==='EXCLUSIVE'?'2026-10-31':'2026-11-30',sourceAmountBasis:'platform_net',note:'税計算台帳の説明用。架空の請求。',tax:{previewHash:preview.previewHash,ruleVersionId:preview.rule.id,lineRates}});
   invoice=await db.get('SELECT * FROM billing_invoices WHERE org_id=1 AND id=?',[made.invoiceId]);
  }
  assert.equal(invoice.amount_ex_tax,scenario.expected.base);assert.equal(invoice.tax_amount,scenario.expected.tax);assert.equal(invoice.amount_inc_tax,scenario.expected.total);
  results.push({scenario:scenario.key,invoiceNumber:invoice.invoice_number,month:scenario.month,tax:invoice.tax_amount});
 }
 const after=await db.get("SELECT COUNT(*) AS count,SUM(amount_ex_tax) AS amount FROM sale_lines WHERE id IN (SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE r.report_key NOT LIKE 'TAX-DEMO-%')");assert.deepEqual(after,baseline);
 assert.equal((await db.all('PRAGMA foreign_key_check')).length,0);
 console.log(JSON.stringify({ok:true,results,originalSalesUnchanged:true}));
}finally{db.close()}
