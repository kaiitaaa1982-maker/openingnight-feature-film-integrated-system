import {expenseDemoWriter} from './seed-expense-support.mjs';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';

// Only the isolated, fictional annual-demo database is a valid target.
const expectedFile=fileURLToPath(new URL('../../../analytics-poc/.runtime/year-demo.sqlite',import.meta.url));
if(!process.env.ON_DB_FILE||resolve(process.env.ON_DB_FILE)!==resolve(expectedFile))throw new Error('架空年間デモのDBだけを指定してください');
const db=new LocalDatabase(expectedFile),app=createApp({db,mode:'local'});
try{
 const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 async function rawReq(path,input){const r=await app.request('/api'+path,{method:input?'POST':'GET',headers:{cookie,...(input?{'content-type':'application/json'}:{})},body:input?JSON.stringify(input):undefined});const out=await r.json();if(!r.ok||!out.ok)throw new Error(`${path}: ${JSON.stringify(out)}`);return out}
 const expensePost=expenseDemoWriter(db,1,rawReq);
 const req=(path,input,...rest)=>path==='/expenses'?expensePost(path,input):rawReq(path,input,...rest);
 const baseline=await db.get("SELECT COUNT(*) n, SUM(amount_ex_tax) total FROM sale_lines WHERE accounting_month LIKE '2025-%'");
 let work=await db.get("SELECT * FROM works WHERE org_id=1 AND code='SYNTH-RIGHTS-REPORT'");
 if(!work){await req('/works',{project_id:1,code:'SYNTH-RIGHTS-REPORT',title:'架空映画・夜明けの航路',format:'映画',forecast_yen:0});work=await db.get("SELECT * FROM works WHERE org_id=1 AND code='SYNTH-RIGHTS-REPORT'")}
 let product=await db.get("SELECT * FROM products WHERE org_id=1 AND sku='SYNTH-RIGHTS-DIGITAL'");
 if(!product){await req('/products',{sku:'SYNTH-RIGHTS-DIGITAL',name:'架空映画・夜明けの航路 配信商品',channel:'digital'});product=await db.get("SELECT * FROM products WHERE org_id=1 AND sku='SYNTH-RIGHTS-DIGITAL'")}
 if(!await db.get('SELECT 1 FROM product_works WHERE org_id=1 AND product_id=?',[product.id]))await req('/product-works',{productId:product.id,allocations:[{workId:work.id,allocationBps:10000}]});
 let intake=await db.get("SELECT id FROM rights_intake_cases WHERE org_id=1 AND case_code='SYNTH-RIGHTS-INTAKE'");
 if(!intake){await req('/intakes',{workId:work.id,caseCode:'SYNTH-RIGHTS-INTAKE',title:'架空映画の製作委員会',intakeType:'committee',documents:[{title:'架空契約・収支帳票検証用',reference:'SYNTHETIC-ONLY-RIGHTS-REPORT',versionLabel:'v1'}],participants:[{partyKind:'partner',partnerId:1,role:'出資者・配信窓口',investmentYen:600000,explicitShareBps:6000},{partyKind:'partner',partnerId:2,role:'出資者・幹事',investmentYen:400000,explicitShareBps:4000}]});intake=await db.get("SELECT id FROM rights_intake_cases WHERE org_id=1 AND case_code='SYNTH-RIGHTS-INTAKE'")}
 let contract=await db.get("SELECT id FROM committee_contracts WHERE org_id=1 AND contract_code='SYNTH-RIGHTS-CONTRACT'");
 if(!contract){const document=await db.get('SELECT id FROM rights_intake_documents WHERE org_id=1 AND intake_case_id=?',[intake.id]);await req('/committee/contracts',{workId:work.id,intakeCaseId:intake.id,documentId:document.id,contractCode:'SYNTH-RIGHTS-CONTRACT',title:'架空映画・夜明けの航路 収支報告契約',managerPartnerId:2,windows:[{kind:'digital',label:'架空配信窓口',windowPartnerId:1,route:'via_manager',platformRateBps:5000,windowFeeBps:2000,managerFeeBps:500,feeOrder:'window_first',windowFeeBasis:'platform_net',managerFeeBasis:'after_window'}],phases:[{label:'架空月次',startsOn:'2026-07-01',endsOn:'2026-08-31',firstCloseOn:'2026-07-31',intervalMonths:1,closeDay:'eom',reportOffsetMonths:1,reportDay:'eom',paymentOffsetMonths:2,paymentDay:'eom',referenceType:'release',referenceDate:'2026-07-01'}]});contract=await db.get("SELECT id FROM committee_contracts WHERE org_id=1 AND contract_code='SYNTH-RIGHTS-CONTRACT'")}
 const version=await db.get('SELECT id FROM committee_term_versions WHERE org_id=1 AND contract_id=? ORDER BY version_no LIMIT 1',[contract.id]);
 const window=await db.get('SELECT id FROM committee_term_windows WHERE org_id=1 AND term_version_id=?',[version.id]);
 for(const [index,month,amount,cost] of [[1,'2026-07',100000,3000],[2,'2026-08',200000,6000]]){
  const key=`SYNTH-RIGHTS-${month}`;
  let report=await db.get('SELECT id FROM report_imports WHERE org_id=1 AND report_key=?',[key]);
  if(!report){await req('/sales',{workId:work.id,report_key:key,kind:'digital',partner_id:2,product_id:product.id,period_from:`${month}-01`,period_to:`${month}-31`,recognition_basis_id:1,sales_month:month,basis_reason:'架空販売月の月次報告',description:'架空の収支帳票検証',quantity:1,amount_ex_tax:amount,tax_amount:0,amount_inc_tax:amount});report=await db.get('SELECT id FROM report_imports WHERE org_id=1 AND report_key=?',[key])}
  let expense=await db.get('SELECT id FROM expenses WHERE org_id=1 AND work_id=? AND description=?',[work.id,key]);
  if(!expense){await req('/expenses',{project_id:work.project_id,work_id:work.id,incurred_on:`${month}-20`,accounting_month:month,category:'宣伝',description:key,actual_ex_tax:cost,tax_amount:0,actual_inc_tax:cost});expense=await db.get('SELECT id FROM expenses WHERE org_id=1 AND work_id=? AND description=?',[work.id,key])}
  if(!await db.get('SELECT id FROM committee_report_snapshots WHERE org_id=1 AND contract_id=? AND period_index=?',[contract.id,index])){
   const preview=await req('/committee/previews',{workId:work.id,termVersionId:version.id,periodIndex:index,periodDateBasis:'sales_period',allowStub:false,reportLinks:[{reportId:report.id,reportBasis:'gross'}],expenseAllocations:[{expenseId:expense.id,windowId:window.id}]});
   assert.equal(preview.totals.distributionPool,index===1?35000:70000);
   await req('/committee/snapshots',{token:preview.token});
  }
 }
 // Three fictional annual-demo titles illustrate a shared recoupment pool.
 const mgProducts=[];
 for(const [sku,value] of [['DEMO25-NINKYO-1-B001',1800000],['DEMO25-NINKYO-2-B001',500000],['DEMO25-NINKYO-3-B001',700000]]){
  const p=await db.get('SELECT id FROM products WHERE org_id=1 AND sku=?',[sku]);
  if(!p)throw new Error('架空年間デモの商品がありません');
  mgProducts.push({productId:p.id,evaluationYen:value});
 }
 let mg=await db.get("SELECT id FROM mg_incoming_contracts WHERE org_id=1 AND code='MG-REPORT-3WORK'");
 if(!mg){await req('/mg/contracts',{direction:'incoming',code:'MG-REPORT-3WORK',title:'架空3作品・一括回収の現況例',partnerId:2,contractDate:'2026-06-01',contractSourceReference:'SYNTH-3WORK-CONTRACT',mgAmountYen:3000000,startsOn:'2026-07-01',endsOn:'2027-06-30',mode:'cross',reason:'架空の作品別現況検証',sourceReference:'SYNTH-3WORK-TERMS',products:mgProducts,phases:[{startsOn:'2026-07-01',endsOn:'2027-06-30',intervalMonths:1,firstCloseOn:'2026-07-31',closeDay:'eom',reportOffsetMonths:1,reportDay:28,payOffsetMonths:2,payDay:28}]});mg=await db.get("SELECT id FROM mg_incoming_contracts WHERE org_id=1 AND code='MG-REPORT-3WORK'")}
 const mgVersion=await db.get('SELECT id FROM mg_term_versions WHERE org_id=1 AND incoming_contract_id=? ORDER BY version LIMIT 1',[mg.id]);
 for(const [month,amounts] of [['2026-07',[1000000,200000,100000]],['2026-08',[400000,300000,350000]]])for(let n=0;n<3;n++){
  const source=`SYNTH-3WORK-${month}-${n}`,amount=amounts[n];
  if(!await db.get('SELECT id FROM mg_ledger_entries WHERE org_id=1 AND term_version_id=? AND source_reference=?',[mgVersion.id,source]))await req('/mg/ledger',{termVersionId:mgVersion.id,productId:mgProducts[n].productId,periodFrom:`${month}-01`,periodTo:`${month}-31`,accountingMonth:month,sourceReference:source,reportedEligibleYen:amount,appliedRecoupYen:amount,reportedOverageYen:0,recognizedYen:0,status:'unverified'});
 }
 const old=await db.get("SELECT id FROM mg_ledger_entries WHERE org_id=1 AND term_version_id=? AND source_reference='SYNTH-3WORK-2026-08-1'",[mgVersion.id]);
 if(!await db.get('SELECT id FROM mg_ledger_entries WHERE org_id=1 AND reverses_entry_id=?',[old.id]))await req('/mg/ledger',{termVersionId:mgVersion.id,productId:mgProducts[1].productId,periodFrom:'2026-08-01',periodTo:'2026-08-31',accountingMonth:'2026-08',sourceReference:'SYNTH-3WORK-2026-08-1-CORRECTED',reportedEligibleYen:250000,appliedRecoupYen:250000,reportedOverageYen:0,recognizedYen:0,status:'unverified',reversesEntryId:old.id,confirmationReason:'架空の訂正版を反映する検証'});
 assert.deepEqual(await db.get("SELECT COUNT(*) n,SUM(amount_ex_tax) total FROM sale_lines WHERE accounting_month LIKE '2025-%'"),baseline);
 assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 console.log(JSON.stringify({ok:true,syntheticOnly:true,workId:work.id,contractId:contract.id,unchanged2025Sales:true}));
}finally{db.close()}
