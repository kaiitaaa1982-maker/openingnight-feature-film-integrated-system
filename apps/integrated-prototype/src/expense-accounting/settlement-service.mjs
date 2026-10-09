import {insert,newId,guard} from '../expense-sheet/expense-service.mjs';
import {fail,integer,str,day,expected,addYen} from '../expense-sheet/expense-model.mjs';
import {loadSettlement,settlementProjection,settlementStamp,recognitionOn} from './settlement-model.mjs';

export async function cashClass(s,i,id){const c=await s.ref(i,'gl_account_class_versions',integer(id,1),true);if(c.settlement_role!=='cash')fail('現預金の科目を選んでください');return c.id;}
export async function expenseChangeGuard(s,i,{created=null,voids=[]}={}){
 const stamp=await settlementStamp(s.db,i.org_id),data=await loadSettlement(s.db,i.org_id);
 for(const v of voids){const e=data.expenses.find(e=>e.id===v.id);if(!e)fail('請求書の整備が必要です',409);if(v.on<recognitionOn(e))fail('取消日は計上日以後にしてください');if(data.payments.some(p=>p.expense_id===e.id&&p.paid_on>v.on))fail('支払と取消の記録日以後に経費を取り消してください',409);e.voided_on=v.on;}
 if(created){const a=created.accounting;if(a){const category=await s.ref(i,'expense_category_versions',a.category_version_id,true);data.expenses=data.expenses.filter(e=>e.id!==created.id);data.expenses.push({...created,account_class_version_id:category.account_class_version_id,recognition_timing:category.recognition_timing,tax_category_version_id:a.tax_category_version_id});}}
 settlementProjection(data,'9999-12-31',{validate:true});return stamp;
}
export async function creditStatements(s,i,b,e,invoiceId){
 if(e.actual_inc_tax>=0){if(b.credit||e.actual_ex_tax<0||e.tax_amount<0||b.invoice?.document_kind==='credit_note')fail('減額は負の明細と減額証憑で登録してください');return [];}
 if(e.actual_ex_tax>0||e.tax_amount>0||!b.credit)fail('減額の元明細と元請求書が必要です');
 const origin=await s.expense(i,integer(b.credit.original_expense_id,1)),d=await s.db.get('SELECT * FROM expense_details WHERE org_id=? AND expense_id=?',[i.org_id,origin.id]);
 if(!d||d.invoice_id!==b.credit.original_invoice_id||origin.actual_inc_tax<=0||origin.partner_id!==e.partner_id||origin.project_id!==e.project_id||origin.work_id!==e.work_id)fail('同じ支払先・案件・作品の元明細と元請求書を指定してください');
 const on=recognitionOn({...e,recorded_on:b.details?.recorded_on}),originalOn=recognitionOn({...origin,recorded_on:d.recorded_on});if(!on||!originalOn||on<originalOn)fail('減額の計上日は元明細の計上日以後にしてください');
 if(b.invoice_id){const inv=await s.latest(i,'expense_invoice_versions','invoice_id',invoiceId);if(inv.document_kind!=='credit_note')fail('減額の証憑を選んでください');}else if(b.invoice?.document_kind!=='credit_note')fail('減額の証憑を選んでください');
 if(b.accounting?.withholding_yen!==0)fail('減額の源泉は0を明示してください。控除済み源泉は支払の取消で訂正します');
 return [guard(`EXISTS(SELECT 1 FROM expense_line_voids WHERE org_id=? AND expense_id=?)`,[i.org_id,origin.id]),guard(`?+COALESCE((SELECT SUM(-e.actual_inc_tax) FROM expense_credit_links c JOIN expenses e ON e.org_id=c.org_id AND e.id=c.expense_id WHERE c.org_id=? AND c.original_expense_id=? AND NOT EXISTS(SELECT 1 FROM expense_line_voids v WHERE v.org_id=e.org_id AND v.expense_id=e.id)),0)>?`,[-e.actual_inc_tax,i.org_id,origin.id,origin.actual_inc_tax]),insert('expense_credit_links',{expense_id:e.id,original_expense_id:origin.id,original_invoice_id:d.invoice_id,...s.meta(i,b)})];
}

export async function paymentExtras(s,i,b,p){
 const stamp=await settlementStamp(s.db,i.org_id),data=await loadSettlement(s.db,i.org_id),statements=[];
 const e=data.expenses.find(e=>e.id===p.expense_id);if(!recognitionOn(e))fail('計上日を確認してください',409);
 if(!p.reverses_id){const group=settlementProjection(data,p.paid_on).groups.find(g=>g.root===p.expense_id);if(group?.recognized&&addYen(p.amount_yen,p.withheld_yen)>group.payable)fail('支払額が減額後の未払金を超えています',409);}
 if(p.reverses_id){const old=data.payments.find(x=>x.id===p.reverses_id);Object.assign(p,{card_id:old.card_id,card_version_id:old.card_version_id,counter_account_class_version_id:old.counter_account_class_version_id,billing_receipt_id:old.billing_receipt_id,billing_invoice_id:old.billing_invoice_id});
  if(old.billing_receipt_id)statements.push(insert('billing_receipt_reversals',{org_id:i.org_id,receipt_id:old.billing_receipt_id,reversed_on:p.paid_on,reason:str(b.reason,1000,true),created_by:i.user_id}),s.audit(i,'billing_receipt_reversal',old.billing_receipt_id,b));
 }else if(p.method==='card'){
  const c=await s.ref(i,'expense_card_versions',integer(b.cardVersionId,1),true);if(c.effective_from>p.paid_on)fail('支払日に有効なカード条件版を指定してください');
  p.card_version_id=c.id;p.card_id=c.card_id;statements.push(insert('expense_payment_settlements',{payment_id:p.id,card_version_id:c.id,...s.meta(i,b)}));
 }else if(p.method==='offset'){
  const c=await s.ref(i,'gl_account_class_versions',integer(b.counterAccountClassVersionId,1),true),account=await s.ref(i,'gl_accounts',c.account_id);
  if(account.section!=='asset'||!['receivable','refund_receivable'].includes(c.settlement_role))fail('相殺する債権の科目を選んでください');
  const description=str(b.counterDescription,1000,true),e=await s.expense(i,p.expense_id);let receiptId=null,invoiceId=null;
  if(b.billingInvoiceId!=null){const inv=await s.ref(i,'billing_invoices',integer(b.billingInvoiceId,1));
   if(inv.partner_id!==e.partner_id||inv.status!=='issued'||inv.invoice_date>p.paid_on||c.settlement_role!=='receivable')fail('同じ支払先の発行済み売上請求書と売掛金科目を指定してください');
   const works=await s.db.all('SELECT DISTINCT w.project_id FROM billing_invoice_line_works l JOIN works w ON w.org_id=l.org_id AND w.id=l.work_id WHERE l.org_id=? AND l.invoice_id=?',[i.org_id,inv.id]);if(!works.length)fail('売上請求書の作品を確認してください');for(const w of works)await s.finance(i,w.project_id);
   // 既存の売上入金制約も束内で検査する。現金入金・相殺のいずれとも二重消込できない。
   statements.push(guard('EXISTS(SELECT 1 FROM billing_invoice_voids WHERE org_id=? AND invoice_id=?)',[i.org_id,inv.id]));
   receiptId=newId();invoiceId=inv.id;p.billing_receipt_id=receiptId;p.billing_invoice_id=invoiceId;
   statements.push(insert('billing_receipts',{id:receiptId,org_id:i.org_id,partner_id:e.partner_id,reference:'OFFSET-'+p.id,received_on:p.paid_on,amount_yen:p.amount_yen,allocation_count:1,note:'相殺による入金: '+description,created_by:i.user_id}),insert('billing_receipt_allocations',{org_id:i.org_id,receipt_id:receiptId,invoice_id:invoiceId,amount_yen:p.amount_yen}),s.audit(i,'billing_receipt',receiptId,b));
  }
  p.counter_account_class_version_id=c.id;p.counter_description=description;
  statements.push(insert('expense_payment_settlements',{payment_id:p.id,counter_account_class_version_id:c.id,counter_description:description,billing_invoice_id:invoiceId,billing_receipt_id:receiptId,...s.meta(i,b)}));
 }else await cashClass(s,i,p.cash_account_class_version_id);
 data.payments.push(p);settlementProjection(data,'9999-12-31',{validate:true});
 return {stamp,statements};
}

export async function recordSettlement(s,i,table,b,reverseId=null){
 await s.finance(i);const stamp=await settlementStamp(s.db,i.org_id),data=await loadSettlement(s.db,i.org_id),statements=[],id=newId();
 // 納付とカード引落は組織全体の資金。全案件の財務権限を必要とする。
 const projects=await s.db.all('SELECT id FROM projects WHERE org_id=?',[i.org_id]);for(const p of projects)await s.finance(i,p.id);
 if(reverseId){expected(b);if(b.expectedVersion!==1)fail('版が変わりました',409);const old=await s.ref(i,table,reverseId);const on=day(b.voided_on);if(on<old.occurred_on)fail('取消日は元の記録日以後にしてください');const r=data.records[table].find(r=>r.id===old.id);if(r.voided_on)fail('取消済みです',409);r.voided_on=on;statements.push(insert(table+'_voids',{record_id:old.id,voided_on:on,...s.meta(i,b)}));
 }else{
  if(expected(b)!==0)fail('初回の版は0です',409);
  const row={id,code:str(b.code,60,true),occurred_on:day(b.occurred_on),amount_yen:integer(b.amount_yen,1),cash_account_class_version_id:await cashClass(s,i,b.cash_account_class_version_id),...s.meta(i,b)};
  if(table==='expense_withholding_remittances'){
   for(const k of ['month_from','month_to'])if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(b[k]??''))fail('対象支払月を確認してください');
   if(b.month_from>b.month_to||b.month_to>row.occurred_on.slice(0,7))fail('納付日までの対象支払月を指定してください');Object.assign(row,{month_from:b.month_from,month_to:b.month_to});
   const balance=settlementProjection(data,row.occurred_on);let left=row.amount_yen;
   for(const m of balance.withholdingMonths.filter(m=>m.payment_month>=b.month_from&&m.payment_month<=b.month_to)){const n=Math.min(left,m.amount_yen);if(n>0){const a={id:newId(),remittance_id:id,payment_month:m.payment_month,amount_yen:n,...s.meta(i,b)};data.allocations.push(a);statements.push(insert('expense_withholding_allocations',a));left-=n;}}
   if(left)fail('納付が対象支払月の未納付額を超えています',409);
  }else if(table==='expense_card_debits'){row.card_id=(await s.ref(i,'expense_cards',integer(b.card_id,1))).id;
  }else{row.credit_expense_id=integer(b.credit_expense_id,1);const e=await s.expense(i,row.credit_expense_id);await s.ref(i,'partners',integer(b.partner_id,1));if(e.partner_id!==b.partner_id)fail('減額と同じ支払先を指定してください');row.partner_id=b.partner_id;}
  data.records[table].push(row);statements.unshift(insert(table,row));
 }
 settlementProjection(data,'9999-12-31',{validate:true});await s.batch([stamp,...statements,s.audit(i,table+(reverseId?'_void':''),reverseId??id,b)]);return {id:reverseId??id,version:reverseId?2:1};
}
