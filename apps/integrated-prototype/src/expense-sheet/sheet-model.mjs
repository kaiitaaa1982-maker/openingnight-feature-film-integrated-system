import {expenseSource} from './expense-read.mjs';
import {day,fail,addYen,paymentBalance} from './expense-model.mjs';
import {expenseColumnsOfSet,expenseGridColumn,resolveExpenseSet,NEGATIVE_WITHHOLDING_SETS,EXPENSE_STATUS} from './expense-columns.mjs';
// 画面の列セットのボタン（キーは URL の set の値。basic＝standard33、legacy＝legacy22 は別名）
export const SET_LABELS={basic:'基本33列',standard25:'標準25列（互換）',legacy:'旧22列（互換）',accounting:'会計の確認',payout:'出金予定'};
// 一覧の画面で源泉を負（控除）で見せる列セット。統合前と同じく旧22列だけ。DB と基本33列・標準25列の画面は正の控除額
// （標準25列の画面は統合前の基本25列と同じ正。書き出しは3様式とも負。NEGATIVE_WITHHOLDING_SETS）
export const SCREEN_NEGATIVE_WITHHOLDING_SETS=Object.freeze(['legacy22']);
export const negativeWithholding=(set,{screen=false}={})=>(screen?SCREEN_NEGATIVE_WITHHOLDING_SETS:NEGATIVE_WITHHOLDING_SETS).includes(resolveExpenseSet(set));
// 列の定義（expense-columns.mjs）から一覧・書き出しの列を作る
export function sheetColumns(set='basic'){
 const columns=expenseColumnsOfSet(set);if(!columns)fail('列セットを選んでください');
 return columns.map(c=>expenseGridColumn(c,set));
}
export function filterSheet(rows,q={}){return rows.filter(r=>!r.voided&&(!q.projectId||r.project_id===Number(q.projectId))&&(!q.workId||r.work_id===Number(q.workId))&&(!q.partnerId||r.partner_id===Number(q.partnerId))&&(!q.month||r.accounting_month===q.month)&&(!q.closingOn||r.closing_on===q.closingOn)&&(!q.dueOn||r.due_on===q.dueOn)&&(!q.status||r.status===q.status));}
export function sumSheet(rows){return Object.fromEntries(['actual_ex_tax','tax_amount','withholding_yen','payable_yen','cash_due_yen'].map(key=>[key,{known:addYen(...rows.map(r=>r[key]??0)),unknown:rows.filter(r=>r[key]==null).length}]));}
export async function readSheet(s,i,asOf='9999-12-31'){
 day(asOf);const ids=await s.finance(i),db=s.db,rows=[];
 const source=await db.all(`SELECT e.*,d.invoice_id,d.recorded_on,d.distribution_type_code,d.product_id,d.source_product_number AS product_number,d.source_product_name AS product_name,d.source_client_name AS client_name,d.specification,d.quantity_x10000,d.unit_price_x10000,d.supplier_text,d.memo,w.code AS work_code,pr.sku AS product_code,dt.label AS distribution_name,pj.code AS project_code FROM ${expenseSource({history:true})} e LEFT JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id LEFT JOIN projects pj ON pj.org_id=e.org_id AND pj.id=e.project_id LEFT JOIN works w ON w.org_id=e.org_id AND w.id=e.work_id LEFT JOIN products pr ON pr.org_id=e.org_id AND pr.id=d.product_id LEFT JOIN distribution_types dt ON dt.code=d.distribution_type_code WHERE e.org_id=? ORDER BY e.id`,[i.org_id]);
 for(const e of source){if(!ids.has(e.project_id))continue;
  // 請求書の一部の案件しか見られないときは、日付・合計・原本も返さない。
  if(e.invoice_id){try{await s.invoice(i,e.invoice_id);}catch(error){if(error.status===403)continue;throw error;}}
  const invoice=e.invoice_id?await s.latest(i,'expense_invoice_versions','invoice_id',e.invoice_id):null;
  const identity=e.invoice_id?await s.ref(i,'expense_invoices',e.invoice_id):null;
  const a=await s.latest(i,'expense_accounting_versions','expense_id',e.id),payments=(await s.payments(i,e.id)).filter(p=>p.paid_on<=asOf),balance=paymentBalance(e,a,payments,asOf);
  const category=a?await s.ref(i,'expense_category_versions',a.category_version_id):null,accountClass=category?await s.ref(i,'gl_account_class_versions',category.account_class_version_id):null,account=accountClass?await s.ref(i,'gl_accounts',accountClass.account_id):null;
  const tax=a?await s.ref(i,'expense_tax_category_versions',a.tax_category_version_id):null,wh=a?.withholding_category_version_id?await s.ref(i,'expense_withholding_category_versions',a.withholding_category_version_id):null,partner=(identity?.partner_id??e.partner_id)?await s.ref(i,'partners',identity?.partner_id??e.partner_id):null;
  const voidRow=await db.get('SELECT voided_on FROM expense_line_voids WHERE org_id=? AND expense_id=?',[i.org_id,e.id]);
  const S=EXPENSE_STATUS,status=!invoice||!a||!a.active?S.unready:balance.cash_due_yen==null?S.withholding:balance.debt_yen<=0?S.paid:balance.cash_paid_yen||balance.withheld_yen?S.partial:S.unpaid;
  rows.push({...e,partner_id:partner?.id??null,partner_code:partner?.code??null,partner_name:partner?.name??null,invoice,detail:identity?{invoice_id:identity.id}:null,accounting:a,payments,balance,status,voided:!!e.expense_voided_on&&e.expense_voided_on<=asOf,invoice_on:invoice?.invoice_on??null,closing_on:invoice?.closing_on??null,due_on:invoice?.due_on??null,paid_on:balance.last_paid_on,amount_inc_tax:e.actual_inc_tax,cash_paid_yen:balance.cash_paid_yen,invoice_number:invoice?.invoice_number??null,document_kind:invoice?.document_kind??null,quantity:e.quantity_x10000==null?null:e.quantity_x10000/10000,unit_price:e.unit_price_x10000==null?null:e.unit_price_x10000/10000,withholding_yen:a?.withholding_yen??null,payable_yen:a?.withholding_state==='confirmed'?addYen(e.actual_inc_tax,-a.withholding_yen):null,cash_due_yen:balance.cash_due_yen,category_name:category?.name??null,account_name:account?.name??null,tax_name:tax?.name??null,withholding_name:wh?.name??null});
 }
 // 減額証憑は元明細の支払残へ反映する。減額行自体を出金予定に重ねない。
 const credits=await db.all('SELECT c.original_expense_id,c.expense_id FROM expense_credit_links c WHERE c.org_id=?',[i.org_id]);
 for(const link of credits){const credit=rows.find(r=>r.id===link.expense_id),original=rows.find(r=>r.id===link.original_expense_id);if(!credit||credit.voided||!original||(credit.recorded_on??credit.incurred_on)>asOf)continue;if(original.cash_due_yen!=null){original.cash_due_yen=Math.max(0,addYen(original.cash_due_yen,credit.actual_inc_tax));original.balance={...original.balance,cash_due_yen:original.cash_due_yen,debt_yen:Math.max(0,addYen(original.balance.debt_yen,credit.actual_inc_tax))};if(original.balance.debt_yen===0)original.status=EXPENSE_STATUS.paid;}credit.cash_due_yen=0;}
 return rows;
}
export function payoutSheet(rows,groupBy='partner'){
 if(!['partner','closing'].includes(groupBy))fail('集計の切り口を選んでください');const groups=new Map(),excluded={unready:0,withholding:0,known_yen:0};
 for(const r of rows.filter(r=>!r.voided)){
  if(r.status===EXPENSE_STATUS.unready||r.cash_due_yen==null){excluded[r.status===EXPENSE_STATUS.unready?'unready':'withholding']++;excluded.known_yen=addYen(excluded.known_yen,r.actual_inc_tax);continue;}
  if(r.cash_due_yen<=0)continue;
  const key=groupBy==='partner'?String(r.partner_id):r.closing_on;
  const g=groups.get(key)??{id:key,label:groupBy==='partner'?r.partner_name:r.closing_on,cash_due_yen:0,debt_yen:0,withholding_due_yen:0,count:0,lines:[]};
  g.cash_due_yen=addYen(g.cash_due_yen,r.cash_due_yen);g.debt_yen=addYen(g.debt_yen,r.balance.debt_yen);g.withholding_due_yen=addYen(g.withholding_due_yen,r.balance.withholding_due_yen);g.count++;g.lines.push(r);groups.set(key,g);
 }
 return {rows:[...groups.values()],excluded};
}
