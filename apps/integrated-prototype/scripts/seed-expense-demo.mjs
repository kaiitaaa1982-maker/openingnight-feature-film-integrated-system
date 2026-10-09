import {seedExpenseExtras} from './seed-expense-extras.mjs';
import {createApp} from '../src/app.mjs';
import {LocalDatabase} from '../src/db.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SALES_DEMO} from './seed-sales-demo.mjs';
import {ensureExpenseDemoSettings,demoAccounting,fictionalInvoice,DEMO_EXPENSE_REASON as reason} from './seed-expense-support.mjs';
// 架空データの管理者で手元の API に入る（画面と同じ API を通す）
async function demoCaller(db){
 const org=await db.get('SELECT id FROM organizations WHERE code=?',[SALES_DEMO.orgCode]);if(!org)throw Error('先に売上の架空データを入れてください');const app=createApp({db,mode:'local'}),login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:SALES_DEMO.adminEmail})});if(login.status!==200)throw Error('架空データの管理者でログインできません');const cookie=login.headers.get('set-cookie').split(';')[0];const call=async(path,payload)=>{const r=await app.request('/api'+path,{method:payload?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined}),b=await r.json();if(r.status>=300)throw Error(path+': '+JSON.stringify(b));return b;};if((await call('/session')).user.orgId!==org.id)throw Error('架空データの組織を確認してください');return {org,call,post:(p,b)=>call(p,b)};
}
export async function seedExpenseDemo(db,{log=()=>{}}={}){
 const {org,call,post}=await demoCaller(db),s=await ensureExpenseDemoSettings(db,org.id,post);let changed=0;
 // 投入済みの架空行の整備。日付は元seedの生成規則を根拠として明示する。実データを対象にしない。
 for(const e of await db.all('SELECT e.* FROM expenses e LEFT JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id WHERE e.org_id=? AND d.expense_id IS NULL',[org.id])){await post(`/expenses/${e.id}/repair`,{partner_id:e.partner_id??s.payee,expectedExpenseVersion:e.version,reason,invoice:fictionalInvoice('DEMO-EXP-REPAIR-'+e.id,e.incurred_on),accounting:demoAccounting(s,e.category,e.tax_amount)});changed++;}
 // 元seedの出金は源泉対象外。金額・日付は既存の支払をそのまま参照し、確認の補助行だけ足す。
 for(const p of await db.all('SELECT p.* FROM expense_payments p JOIN expense_details d ON d.org_id=p.org_id AND d.expense_id=p.expense_id LEFT JOIN expense_payment_accounting a ON a.org_id=p.org_id AND a.payment_id=p.id WHERE p.org_id=? AND a.payment_id IS NULL ORDER BY p.reverses_id IS NOT NULL,p.id',[org.id])){const a=await db.get('SELECT version_no FROM expense_accounting_versions WHERE org_id=? AND expense_id=? ORDER BY version_no DESC LIMIT 1',[org.id,p.expense_id]);await post(`/expense-payments/${p.id}/accounting`,{expectedVersion:a.version_no,withheldYen:0,cashAccountClassVersionId:s.classes['1100'],reason});changed++;}
 await post('/expense-accounting/defaults',{expectedVersion:0,reason});
 let project=await db.get("SELECT id FROM projects WHERE org_id=? AND code='DEMO-EXP-COMMON'",[org.id]);if(!project){project=await post('/projects',{code:'DEMO-EXP-COMMON',title:'全社共通経費（架空）',status:'active'});changed++;}
 const partner=async(code,name)=>{let p=await db.get('SELECT id FROM partners WHERE org_id=? AND code=?',[org.id,code]);if(!p){p=await post('/partners',{code,name:name+'（架空）',kind:'vendor'});changed++;}return p.id;};
 const eom=await partner('DEMO-PARTNER-EOM','月末締めの支払先'),twenty=await partner('DEMO-PARTNER-20','20日締めの支払先'),thirtyOne=await partner('DEMO-PARTNER-31','31日指定の支払先');
 const term=async(p,rule,closing,payment)=>{if(!await db.get('SELECT 1 FROM partner_payment_term_versions WHERE org_id=? AND partner_id=?',[org.id,p])){await post('/expense-accounting/payment-terms',{expectedVersion:0,reason,partner_id:p,effective_from:'2024-01-01',closing_rule:rule,closing_day:closing,payment_month_offset:1,payment_rule:rule,payment_day:payment,payment_method:'transfer'});changed++;}};await term(eom,'month_end',null,null);await term(twenty,'day',20,10);
 await term(thirtyOne,'day',31,31);
 const examples=[['DEMO-INVOICE-PARTIAL',eom,'2026-09-14',12000,1200,0,5000,0,'2026-10-05'],['DEMO-INVOICE-PAID',twenty,'2026-09-21',7500,600,0,8100,0,'2026-11-10'],['DEMO-INVOICE-UNPAID',eom,'2026-09-14',12000,1200,0,0,0,null],['DEMO-INVOICE-WH',eom,'2026-09-14',18000,1800,1700,18100,1700,'2026-10-31'],['DEMO-INVOICE-WH-PARTIAL',eom,'2026-09-14',18000,1800,1700,6000,500,'2026-10-05'],['DEMO-YEAR-END',eom,'2026-12-31',1000,100,0,0,0,null],['DEMO-YEAR-LEAP',eom,'2024-02-29',1000,100,0,0,0,null],['DEMO-DAY-20',twenty,'2026-09-20',1000,100,0,0,0,null],['DEMO-DAY-31',thirtyOne,'2026-02-01',1000,100,0,0,0,null],['DEMO-VOID',eom,'2026-09-14',1000,100,0,0,0,null]];
 for(const [code,p,on,ex,tax,wh,cash,withheld,paidOn] of examples){let inv=await db.get('SELECT id FROM expense_invoices WHERE org_id=? AND code=?',[org.id,code]),e;
 if(!inv){const a=demoAccounting(s,'事務費',tax,wh);if(code==='DEMO-INVOICE-PAID')a.tax_category_version_id=s.taxes['8'];const out=await post('/expenses',{project_id:project.id,work_id:null,partner_id:p,incurred_on:on,accounting_month:on.slice(0,7),category:'事務費',description:code+'（架空）',actual_ex_tax:ex,tax_amount:tax,actual_inc_tax:ex+tax,reason,invoice:{code,invoice_number:code+'（架空）',invoice_on:on,expectedVersion:0,reason},accounting:a});e=out.id;changed++;}else e=(await db.get('SELECT expense_id FROM expense_details WHERE org_id=? AND invoice_id=?',[org.id,inv.id])).expense_id;
 if(cash){const prior=await db.get('SELECT p.*,a.withheld_yen FROM expense_payments p JOIN expense_payment_accounting a ON a.org_id=p.org_id AND a.payment_id=p.id WHERE p.org_id=? AND p.expense_id=? AND p.reverses_id IS NULL',[org.id,e]);if(prior){if(prior.amount_yen!==cash||prior.withheld_yen!==withheld||prior.paid_on!==paidOn)throw Error('架空の出金が検証入力と異なります: '+code);}else{await post('/expense-payments',{expenseId:e,paidOn,amountYen:cash,withheldYen:withheld,cashAccountClassVersionId:s.classes['1100'],method:'transfer',expectedVersion:1,reason});changed++;}}
 if(code==='DEMO-VOID'&&!await db.get('SELECT 1 FROM expense_line_voids WHERE org_id=? AND expense_id=?',[org.id,e])){await post(`/expenses/${e}/void`,{expectedVersion:1,voided_on:'2026-09-28',reason});changed++;}}
 if(!await db.get('SELECT 1 FROM partner_payment_term_versions WHERE org_id=? AND partner_id=? AND version_no=2',[org.id,eom])){await post('/expense-accounting/payment-terms',{expectedVersion:1,reason,partner_id:eom,effective_from:'2026-10-01',closing_rule:'month_end',closing_day:null,payment_month_offset:2,payment_rule:'month_end',payment_day:null,payment_method:'transfer'});changed++;}
 if(!await db.get("SELECT 1 FROM expense_pending_rows WHERE org_id=? AND code='DEMO-UNKNOWN-AMOUNT'",[org.id])){await post('/expense-pending',{project_id:project.id,code:'DEMO-UNKNOWN-AMOUNT',reason,payload:{actual_ex_tax:null,tax_amount:null,actual_inc_tax:null,amount_state:'unverified',description:'金額未確認（架空）'}});changed++;}
 changed+=await seedExpenseExtras(db,org.id,post,s,project.id,eom);
 const adoption=await call('/expense-accounting/adoption-preview');if(adoption.rows.some(r=>!r.adopted)){await post('/expense-accounting/adopt',{token:adoption.token,reason});changed++;}
 const sheet=await call('/expense-sheet'),invoices=await call('/expense-invoices');log(`経費の請求書 ${invoices.rows.length}件・未整備 ${sheet.unready}件・出金予定 ${sheet.scheduled}件`);return {skipped:changed===0,orgId:org.id,invoices:invoices.rows.length,unready:sheet.unready,scheduled:sheet.scheduled};
}
// 原本の例（架空の領収書を DEMO-INVOICE-PARTIAL に紐づける）。原本の列は本番では R2 に置くので、本番へ入れる架空データの SQL
// （seed-record-to-sql.mjs）にできない。本番の記録ではこの節を --only から外し、原本は画面（Worker）から入れる（runbook 07 の 3-7b）
export async function seedExpenseOriginalsDemo(db,{log=()=>{}}={}){
 const {org,post}=await demoCaller(db);let changed=0;
 const invoice=await db.get("SELECT id FROM expense_invoices WHERE org_id=? AND code='DEMO-INVOICE-PARTIAL'",[org.id]);if(!invoice)throw Error('先に経費の架空データ（expenses の節）を入れてください');const sourceText='DEMO receipt (fictional) / expense evidence',sourceHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sourceText))),x=>x.toString(16).padStart(2,'0')).join('');let file=await db.get('SELECT id FROM expense_source_files WHERE org_id=? AND raw_sha256=?',[org.id,sourceHash]);if(!file){file=await post('/expense-source-files',{file_name:'DEMO-receipt（架空）.txt',media_type:'text/plain',original_base64:btoa(sourceText),reason});changed++;}if(!await db.get('SELECT 1 FROM expense_invoice_file_links WHERE org_id=? AND invoice_id=? AND file_id=?',[org.id,invoice.id,file.id])){await post(`/expense-invoices/${invoice.id}/files`,{file_id:file.id,purpose:'supporting',expectedVersion:1,reason});changed++;}
 log(`経費の原本の例: ${changed?'架空の領収書を請求書に紐づけました':'入れ済み'}`);return {skipped:changed===0,orgId:org.id};
}
// 本番へ接続しない。明示された手元のDBだけを対象にする。
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const index=process.argv.indexOf('--db'),path=index<0?null:process.argv[index+1];
 if(!path)throw Error('使い方: node scripts/seed-expense-demo.mjs --db <手元のSQLite>');
 if(resolve(path)===fileURLToPath(new URL('../data/integrated.sqlite',import.meta.url))&&!process.argv.includes('--allow-main-db'))throw Error('既定DBには --allow-main-db が必要です');
 const db=new LocalDatabase(resolve(path));try{console.log(await seedExpenseDemo(db,{log:console.log}));console.log(await seedExpenseOriginalsDemo(db,{log:console.log}));}finally{db.close();}
}
