import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/app.mjs';

export const tables={works:'id,org_id,code,title',partners:'id,org_id,code,name',product_works:'org_id,product_id,work_id,allocation_bps',report_imports:'id,org_id,kind,status',sale_lines:'id,org_id,work_id,report_id,product_id,partner_id,accounting_month,amount_ex_tax',sale_distribution_versions:'org_id,sale_id,version_no,distribution_code',billing_invoices:'id,org_id,invoice_number,partner_id,invoice_date,due_date,amount_inc_tax',billing_invoice_voids:'org_id,invoice_id,voided_on',billing_receipts:'id,org_id,received_on',billing_receipt_allocations:'org_id,receipt_id,invoice_id,amount_yen',billing_receipt_reversals:'org_id,receipt_id,reversed_on',receipt_plan_requests:'id,org_id,invoice_id,proposed_due_date',receipt_plan_decisions:'org_id,request_id,invoice_id,decision,version_no,effective_on',committee_report_snapshots:'id,org_id,work_id,contract_id,term_version_id,period_index,period_from,period_to,close_on,report_on,payment_on,status,verification,calculation_version',committee_snapshot_member_amounts:'org_id,snapshot_id,window_id,partner_id,share_bps,amount_yen,route',committee_snapshot_lines:'org_id,snapshot_id,work_id,report_id,sale_id,window_id,allocated_amount_ex_tax,accounting_month',mg_term_versions:'id,org_id,incoming_contract_id,outgoing_contract_id,version,mode,mg_amount_yen,starts_on,ends_on,special_unverified',mg_version_products:'org_id,term_version_id,product_id,evaluation_yen',mg_ledger_entries:'id,org_id,term_version_id,product_id,accounting_month,reported_eligible_yen,applied_recoup_yen,reported_overage_yen,recognized_yen,status,reverses_entry_id'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const csv=(keys,rows)=>[keys,...rows.map(r=>keys.map(k=>r[k]??''))].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n')+'\n';

export async function exportSnapshot({source,out,asOf=new Date().toISOString().slice(0,10)}){
 source=resolve(source);out=resolve(out);
 const registration=JSON.parse(readFileSync(source+'.workbench-demo.json','utf8'));
 if(registration.kind!=='workbench-synthetic-v1'||resolve(registration.database)!==source||!registration.id)throw Error('登録済みの専用架空DBを指定してください');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf)||new Date(asOf).toISOString().slice(0,10)!==asOf)throw Error('確認日が不正です');
 if(existsSync(resolve(out,'snapshot.json')))throw Error('既存スナップショットは上書きできません');
 const raw=new DatabaseSync(source,{readOnly:true});
 const db={all:async(sql,p=[])=>raw.prepare(sql).all(...p),get:async(sql,p=[])=>raw.prepare(sql).get(...p)||null,run:async()=>{throw Error('読取専用')},batch:async()=>{throw Error('読取専用')}};
 const org=1,identity={org_id:org,user_id:1,role:'admin'};
 const app=createApp({db,mode:'snapshot',authenticate:async()=>identity});
 const request=async path=>{const r=await app.request('/api'+path);const b=await r.json();if(!r.ok||!b.ok)throw Error(JSON.stringify(b));return b};
 mkdirSync(resolve(out,'seeds'),{recursive:true});mkdirSync(resolve(out,'reports'),{recursive:true});
 const files={},reports={};
 const save=(name,keys,rows)=>{const data=csv(keys,rows);writeFileSync(resolve(out,'seeds',name+'.csv'),data);files[name]={columns:keys,rows:rows.length,sha256:hash(data)}};
 raw.exec('BEGIN');
 try{
  for(const [name,cols] of Object.entries(tables))save('raw_'+name,cols.split(','),await db.all(`SELECT ${cols} FROM ${name} WHERE org_id=?`,[org]));
  const committeeWindows=[];
  for(const row of await db.all('SELECT id,work_id,period_from,period_to,calculation_json FROM committee_report_snapshots WHERE org_id=? ORDER BY id',[org])){
   const calculation=JSON.parse(row.calculation_json);
   for(const window of calculation.windows||[])committeeWindows.push({snapshot_id:row.id,work_id:row.work_id,period_from:row.period_from,period_to:row.period_to,window_id:window.windowId,kind:window.kind,platform_net_yen:window.platformNet,window_fee_yen:window.windowFee,manager_fee_yen:window.managerFee,expense_yen:window.expenseTotal,royalty_deduction_yen:window.royaltyDeductions||0,production_recoup_yen:window.productionRecoupDeductions||0,distribution_pool_yen:window.distributionPool,residual_yen:window.residual});
  }
  save('raw_committee_windows',['snapshot_id','work_id','period_from','period_to','window_id','kind','platform_net_yen','window_fee_yen','manager_fee_yen','expense_yen','royalty_deduction_yen','production_recoup_yen','distribution_pool_yen','residual_yen'],committeeWindows);
  const years=(await db.all("SELECT DISTINCT substr(accounting_month,1,4) y FROM sale_lines WHERE org_id=? ORDER BY y",[org])).map(x=>x.y);
  const lines=[];for(const year of years){const result=await request('/report-center?start='+year+'-01');reports[year]=result;lines.push(...result.lines)}
  save('expected_sales',['id','work_id','partner_id','distribution_code','accounting_month','amount'],lines);
  const receipt=await request('/receipt-sheet?start='+asOf.slice(0,4)+'-01&asOf='+asOf);
  save('expected_invoices',['as_of','invoice_id','paid','balance','planned_date'],receipt.rows.map(r=>({as_of:asOf,invoice_id:r.id,paid:r.paid,balance:r.balance,planned_date:r.plannedDate})));
  save('snapshot_dates',['as_of'],[{as_of:asOf}]);
  const audit=await db.get('SELECT COALESCE(MAX(id),0) id FROM audit_log WHERE org_id=?',[org]);
  const reportDocument={purpose:'local_reference',layoutVersion:'workbench-report-1',asOf,sales:reports,receivables:receipt};
  const reportJson=JSON.stringify(reportDocument,null,2);writeFileSync(resolve(out,'reports/report.json'),reportJson);
  const codeFiles=['app.mjs','reporting.mjs','commercial.mjs','tax.mjs','committee.mjs','committee-finance.mjs','mg-portfolio.mjs','rights-reports.mjs','report-center-model.mjs','semantic-definitions.mjs'];const definitions={};
  for(const file of codeFiles){const path=fileURLToPath(new URL('../src/'+file,import.meta.url));definitions[file]=hash(readFileSync(path))}
  const snapshot={id:randomUUID(),source:'registered-synthetic-workbench',registrationId:registration.id,org_id:org,asOf,exported_at:new Date().toISOString(),auditThrough:audit.id,files,definitions,reportHash:hash(reportJson)};
  writeFileSync(resolve(out,'snapshot.json'),JSON.stringify(snapshot,null,2));
  raw.exec('COMMIT');return snapshot;
 }catch(e){try{raw.exec('ROLLBACK')}catch{}throw e}finally{raw.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=Object.fromEntries(process.argv.slice(2).reduce((r,v,i,a)=>i%2?r:[...r,[v.replace(/^--/,''),a[i+1]]],[]));
 try{const result=await exportSnapshot(args);console.log(JSON.stringify({ok:true,id:result.id,auditThrough:result.auditThrough}))}catch(e){console.error(e.message);process.exitCode=1}
}
