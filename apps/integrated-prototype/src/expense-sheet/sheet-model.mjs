import {expenseSource} from './expense-read.mjs';
import {day,fail,addYen,paymentBalance} from './expense-model.mjs';
import {LEGACY_EXPENSE_COLUMNS} from './expense-columns.mjs';
export const SHEET_KEYS=['id','distribution_name','work_code','product_code','product_number','product_name','recorded_on','client_name','specification','description','quantity','unit_price','actual_ex_tax','tax_amount','withholding_yen','payable_yen','supplier_text','invoice_on','memo','partner_code','account_name','category_name','closing_on','due_on','paid_on'];
const labels=['経費ID','流通区分','作品コード','商品コード','品番（受領表記）','商品名（受領表記）','計上日','取引先名（受領表記）','仕様','請求項目','数量','単価（税別）','金額（税別）','消費税額','源泉徴収税額（控除）','差引支払額（税込）','発注先（受領表記）','請求日','メモ','支払先コード','勘定科目','費用区分','締め日','出金予定日','出金日'];
export const SET_LABELS={basic:'基本25列',legacy:'旧22列',accounting:'会計の確認',payout:'出金予定'};
export function sheetColumns(set='basic'){
 if(!Object.hasOwn(SET_LABELS,set))fail('列セットを選んでください');
 const columns=SHEET_KEYS.map((key,n)=>({key,label:set==='legacy'?LEGACY_EXPENSE_COLUMNS[n]:labels[n],type:[12,13,14,15].includes(n)?'yen':n===10||n===11?'number':'text'}));
 if(set==='basic')return columns;if(set==='legacy')return columns.slice(0,22);
 const keys=set==='accounting'?['id','category_name','account_name','tax_name','withholding_name','withholding_yen','status']:['partner_code','partner_name','closing_on','due_on','paid_on','cash_due_yen'];
 const extra={tax_name:'税区分',withholding_name:'源泉区分',status:'状態',partner_name:'支払先',cash_due_yen:'支払残額'};
 return keys.map(key=>columns.find(c=>c.key===key)??{key,label:extra[key],type:key==='cash_due_yen'?'yen':'text'});
}
export function filterSheet(rows,q={}){return rows.filter(r=>!r.voided&&(!q.projectId||r.project_id===Number(q.projectId))&&(!q.workId||r.work_id===Number(q.workId))&&(!q.partnerId||r.partner_id===Number(q.partnerId))&&(!q.month||r.accounting_month===q.month)&&(!q.closingOn||r.closing_on===q.closingOn)&&(!q.dueOn||r.due_on===q.dueOn)&&(!q.status||r.status===q.status));}
export function sumSheet(rows){return Object.fromEntries(['actual_ex_tax','tax_amount','withholding_yen','payable_yen','cash_due_yen'].map(key=>[key,{known:addYen(...rows.map(r=>r[key]??0)),unknown:rows.filter(r=>r[key]==null).length}]));}
export async function readSheet(s,i,asOf='9999-12-31'){
 day(asOf);const ids=await s.finance(i),db=s.db,rows=[];
 const source=await db.all(`SELECT e.*,d.invoice_id,d.recorded_on,d.distribution_type_code,d.product_id,d.source_product_number AS product_number,d.source_product_name AS product_name,d.source_client_name AS client_name,d.specification,d.quantity_x10000,d.unit_price_x10000,d.supplier_text,d.memo,w.code AS work_code,pr.sku AS product_code,dt.label AS distribution_name FROM ${expenseSource({history:true})} e LEFT JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id LEFT JOIN works w ON w.org_id=e.org_id AND w.id=e.work_id LEFT JOIN products pr ON pr.org_id=e.org_id AND pr.id=d.product_id LEFT JOIN distribution_types dt ON dt.code=d.distribution_type_code WHERE e.org_id=? ORDER BY e.id`,[i.org_id]);
 for(const e of source){if(!ids.has(e.project_id))continue;
  // 請求書の一部の案件しか見られないときは、日付・合計・原本も返さない。
  if(e.invoice_id){try{await s.invoice(i,e.invoice_id);}catch(error){if(error.status===403)continue;throw error;}}
  const invoice=e.invoice_id?await s.latest(i,'expense_invoice_versions','invoice_id',e.invoice_id):null;
  const identity=e.invoice_id?await s.ref(i,'expense_invoices',e.invoice_id):null;
  const a=await s.latest(i,'expense_accounting_versions','expense_id',e.id),payments=(await s.payments(i,e.id)).filter(p=>p.paid_on<=asOf),balance=paymentBalance(e,a,payments,asOf);
  const category=a?await s.ref(i,'expense_category_versions',a.category_version_id):null,accountClass=category?await s.ref(i,'gl_account_class_versions',category.account_class_version_id):null,account=accountClass?await s.ref(i,'gl_accounts',accountClass.account_id):null;
  const tax=a?await s.ref(i,'expense_tax_category_versions',a.tax_category_version_id):null,wh=a?.withholding_category_version_id?await s.ref(i,'expense_withholding_category_versions',a.withholding_category_version_id):null,partner=(identity?.partner_id??e.partner_id)?await s.ref(i,'partners',identity?.partner_id??e.partner_id):null;
  const voidRow=await db.get('SELECT voided_on FROM expense_line_voids WHERE org_id=? AND expense_id=?',[i.org_id,e.id]);
  const status=!invoice||!a||!a.active?'未整備':balance.cash_due_yen==null?'源泉未確認':balance.debt_yen<=0?'払い済み':balance.cash_paid_yen||balance.withheld_yen?'一部払い':'未払い';
  rows.push({...e,partner_id:partner?.id??null,partner_code:partner?.code??null,partner_name:partner?.name??null,invoice,detail:identity?{invoice_id:identity.id}:null,accounting:a,payments,balance,status,voided:!!e.expense_voided_on&&e.expense_voided_on<=asOf,invoice_on:invoice?.invoice_on??null,closing_on:invoice?.closing_on??null,due_on:invoice?.due_on??null,paid_on:balance.last_paid_on,quantity:e.quantity_x10000==null?null:e.quantity_x10000/10000,unit_price:e.unit_price_x10000==null?null:e.unit_price_x10000/10000,withholding_yen:a?.withholding_yen??null,payable_yen:a?.withholding_state==='confirmed'?addYen(e.actual_inc_tax,-a.withholding_yen):null,cash_due_yen:balance.cash_due_yen,category_name:category?.name??null,account_name:account?.name??null,tax_name:tax?.name??null,withholding_name:wh?.name??null});
 }
 // 減額証憑は元明細の支払残へ反映する。減額行自体を出金予定に重ねない。
 const credits=await db.all('SELECT c.original_expense_id,c.expense_id FROM expense_credit_links c WHERE c.org_id=?',[i.org_id]);
 for(const link of credits){const credit=rows.find(r=>r.id===link.expense_id),original=rows.find(r=>r.id===link.original_expense_id);if(!credit||credit.voided||!original||(credit.recorded_on??credit.incurred_on)>asOf)continue;if(original.cash_due_yen!=null){original.cash_due_yen=Math.max(0,addYen(original.cash_due_yen,credit.actual_inc_tax));original.balance={...original.balance,cash_due_yen:original.cash_due_yen,debt_yen:Math.max(0,addYen(original.balance.debt_yen,credit.actual_inc_tax))};if(original.balance.debt_yen===0)original.status='払い済み';}credit.cash_due_yen=0;}
 return rows;
}
export function payoutSheet(rows,groupBy='partner'){
 if(!['partner','closing'].includes(groupBy))fail('集計の切り口を選んでください');const groups=new Map(),excluded={unready:0,withholding:0,known_yen:0};
 for(const r of rows.filter(r=>!r.voided)){
  if(r.status==='未整備'||r.cash_due_yen==null){excluded[r.status==='未整備'?'unready':'withholding']++;excluded.known_yen=addYen(excluded.known_yen,r.actual_inc_tax);continue;}
  if(r.cash_due_yen<=0)continue;
  const key=groupBy==='partner'?String(r.partner_id):r.closing_on;
  const g=groups.get(key)??{id:key,label:groupBy==='partner'?r.partner_name:r.closing_on,cash_due_yen:0,debt_yen:0,withholding_due_yen:0,count:0,lines:[]};
  g.cash_due_yen=addYen(g.cash_due_yen,r.cash_due_yen);g.debt_yen=addYen(g.debt_yen,r.balance.debt_yen);g.withholding_due_yen=addYen(g.withholding_due_yen,r.balance.withholding_due_yen);g.count++;g.lines.push(r);groups.set(key,g);
 }
 return {rows:[...groups.values()],excluded};
}
