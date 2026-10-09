import {expenseSource} from '../expense-sheet/expense-read.mjs';
import {addYen,day,fail} from '../expense-sheet/expense-model.mjs';
import {releaseMonths} from '../pl-bs/pl-bs-data.mjs';

export const EVENT_TABLES=['expense_withholding_remittances','expense_card_debits','expense_refund_receipts'];
export const STATE_TABLES=['expenses','expense_details','expense_line_voids','expense_accounting_versions','expense_payments','expense_payment_accounting','expense_credit_links','expense_payment_settlements',...EVENT_TABLES,...EVENT_TABLES.map(t=>t+'_voids'),'expense_withholding_allocations','billing_receipts','billing_receipt_reversals'];
export async function settlementStamp(db,org){
 const counts=[];for(const table of STATE_TABLES)counts.push((await db.get(`SELECT COUNT(*) n FROM ${table} WHERE org_id=?`,[org])).n);
 return {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE '+STATE_TABLES.map(t=>`(SELECT COUNT(*) FROM ${t} WHERE org_id=?)<>?`).join(' OR '),params:counts.flatMap(n=>[org,n])};
}
export async function loadSettlement(db,org){
 const all=t=>db.all(`SELECT * FROM ${t} WHERE org_id=?`,[org]);
 const expenses=await db.all(`SELECT e.*,d.recorded_on,d.invoice_id,e.expense_voided_on AS voided_on,c.original_expense_id,a.id accounting_version_id,a.active accounting_active,a.category_version_id,a.tax_category_version_id,a.withholding_state,k.account_class_version_id,k.recognition_timing FROM ${expenseSource({history:true})} e
 LEFT JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id
 LEFT JOIN expense_line_voids v ON v.org_id=e.org_id AND v.expense_id=e.id
 LEFT JOIN expense_credit_links c ON c.org_id=e.org_id AND c.expense_id=e.id
 LEFT JOIN expense_accounting_versions a ON a.org_id=e.org_id AND a.expense_id=e.id AND a.version_no=(SELECT MAX(x.version_no) FROM expense_accounting_versions x WHERE x.org_id=e.org_id AND x.expense_id=e.id)
 LEFT JOIN expense_category_versions k ON k.org_id=a.org_id AND k.id=a.category_version_id WHERE e.org_id=?`,[org]);
 const payments=await db.all(`SELECT p.*,a.withheld_yen,a.cash_account_class_version_id,s.card_version_id,s.counter_account_class_version_id,s.billing_invoice_id,s.billing_receipt_id,s.counter_description,c.card_id FROM expense_payments p
 LEFT JOIN expense_payment_accounting a ON a.org_id=p.org_id AND a.payment_id=p.id
 LEFT JOIN expense_payment_settlements s ON s.org_id=p.org_id AND s.payment_id=COALESCE(p.reverses_id,p.id)
 LEFT JOIN expense_card_versions c ON c.org_id=s.org_id AND c.id=s.card_version_id WHERE p.org_id=?`,[org]);
 const records={};for(const t of EVENT_TABLES)records[t]=await db.all(`SELECT t.*,v.voided_on FROM ${t} t LEFT JOIN ${t}_voids v ON v.org_id=t.org_id AND v.record_id=t.id WHERE t.org_id=?`,[org]);
 const roles={};for(const c of await db.all(`SELECT c.* FROM gl_account_class_versions c WHERE c.org_id=? AND c.active=1 AND c.version_no=(SELECT MAX(x.version_no) FROM gl_account_class_versions x WHERE x.org_id=c.org_id AND x.account_id=c.account_id)`,[org]))if(c.settlement_role)roles[c.settlement_role]=Object.hasOwn(roles,c.settlement_role)?null:c.id;
 return {expenses,payments,records,allocations:await all('expense_withholding_allocations'),roles,releaseMonths:await releaseMonths(db,org)};
}
// 日付のない旧行に計上日を推定しない。発生日と計上月が一致する行だけは発生日を利用できる。
export const recognitionOn=e=>e.recorded_on??(e.incurred_on?.slice(0,7)===e.accounting_month?e.incurred_on:null);
const sum=values=>addYen(...values);
const line=(role,side,amount,source,roles)=>({account_class_version_id:typeof role==='number'?role:roles[role]??null,role,side:amount<0?(side==='debit'?'credit':'debit'):side,amount_yen:Math.abs(amount),source,status:(typeof role==='number'||roles[role])?'確認済み':'未整備'});

export function settlementProjection(data,asOf='9999-12-31',{validate=false}={}){
 day(asOf);const {expenses,payments,records,roles}=data,groups=new Map(),journal=[],events=[],unready=[];
 const byId=new Map(expenses.map(e=>[e.id,e]));
 for(const e of expenses){const on=recognitionOn(e);if(!on||!e.invoice_id||e.accounting_active===0||!e.account_class_version_id||payments.some(p=>p.expense_id===e.id&&p.paid_on<=asOf&&p.withheld_yen==null)){unready.push(e.id);continue;}const root=e.original_expense_id??e.id;
  if(!groups.has(root))groups.set(root,{root,debt:0,paid:0,refund:0,recognized:false,payable:0,prepaid:0,refund_receivable:0});
  events.push({kind:e.original_expense_id?'credit_note':'accrual',on,e,root,amount:e.actual_inc_tax,order:0});
  if(e.voided_on)events.push({kind:'expense_void',on:e.voided_on,e,root,amount:-e.actual_inc_tax,order:0});
  const release=data.releaseMonths?.get(e.work_id);
  if(e.recognition_timing==='release_month_once'&&release){const recognizedOn=release+'-01'>on?release+'-01':on;if(!e.voided_on||e.voided_on>=recognizedOn){events.push({kind:'recognition',on:recognizedOn,e,root,sign:1,order:4});if(e.voided_on)events.push({kind:'recognition_reversal',on:e.voided_on,e,root,sign:-1,order:4});}}
 }
 for(const p of payments){const e=byId.get(p.expense_id);if(!e||!groups.has(e.original_expense_id??e.id))continue;
  const origin=p.reverses_id?payments.find(x=>x.id===p.reverses_id):p;
  events.push({kind:p.reverses_id?'payment_reversal':p.method==='card'?'card_transfer':p.method==='offset'?'offset':'payment',on:p.paid_on,p,e,root:e.original_expense_id??e.id,month:origin.paid_on.slice(0,7),order:1});
 }
 for(const t of EVENT_TABLES)for(const r of records[t]??[]){events.push({kind:t,on:r.occurred_on,r,sign:1,order:2});if(r.voided_on)events.push({kind:t+'_void',on:r.voided_on,r,sign:-1,order:3});}
 events.sort((a,b)=>a.on.localeCompare(b.on)||a.order-b.order||(a.p?.id??a.e?.id??a.r.id)-(b.p?.id??b.e?.id??b.r.id));
 const months=new Map(),cards=new Map(),creditRefunded=new Map(),creditAmounts=new Map();let cash=0,offset=0;
 const add=(map,k,n)=>map.set(k,addYen(map.get(k)??0,n));
 const post=(event,kind,lines)=>{lines=lines.filter(l=>l.amount_yen!==0);if(!lines.length)return;const debit=sum(lines.filter(l=>l.side==='debit').map(l=>l.amount_yen)),credit=sum(lines.filter(l=>l.side==='credit').map(l=>l.amount_yen));if(debit!==credit)throw Error('仕訳の貸借が一致しません');journal.push({kind,on:event.on,expense_id:event.e?.id??null,payment_id:event.p?.id??null,record_id:event.r?.id??null,source_table:event.p?'expense_payments':event.r?event.kind.replace(/_void$/,''):'expenses',tax_category_version_id:event.e?.tax_category_version_id??null,lines});};
 const balances=g=>{const net=addYen(g.debt,-g.paid,g.refund);g.payable=Math.max(0,net);g.prepaid=g.recognized?0:Math.max(0,-net);g.refund_receivable=g.recognized?Math.max(0,-net):0;};
 for(const event of events){if(event.on>asOf)break;const {p,e,r}=event,source={expense_id:e?.id??null,payment_id:p?.id??null,record_id:r?.id??null};const l=(role,side,n)=>line(role,side,n,source,roles);let g=groups.get(event.root),lines=[],baseDebt=0;
  const before=g?{payable:g.payable,prepaid:g.prepaid,refund_receivable:g.refund_receivable}:null;
  if(event.kind==='recognition'||event.kind==='recognition_reversal'){post(event,event.kind,[l(e.account_class_version_id,'debit',event.sign*e.actual_ex_tax),l('wip','credit',event.sign*e.actual_ex_tax)]);continue;}
  if(e&&!p){const sign=event.kind==='expense_void'?-1:1;g.debt=addYen(g.debt,event.amount);if(!e.original_expense_id)g.recognized=sign===1;else add(creditAmounts,e.id,-event.amount);
   baseDebt=event.amount;lines=[l(e.recognition_timing==='release_month_once'?'wip':e.account_class_version_id,'debit',sign*e.actual_ex_tax),l('input_tax','debit',sign*e.tax_amount),l('payable','credit',event.amount)];
  }else if(p){const gross=addYen(p.amount_yen,p.withheld_yen);g.paid=addYen(g.paid,gross);add(months,event.month,p.withheld_yen);
   lines.push(l('withholding','credit',p.withheld_yen));
   if(p.method==='card'){if(!p.card_id)fail('カードの指定が必要です',409);add(cards,p.card_id,p.amount_yen);lines.push(l('card_payable','credit',p.amount_yen));}
   else if(p.method==='offset'){if(!p.counter_account_class_version_id)fail('相殺の相手科目が必要です',409);offset=addYen(offset,p.amount_yen);lines.push(l(p.counter_account_class_version_id,'credit',p.amount_yen));}
   else {cash=addYen(cash,-p.amount_yen);lines.push(l(p.cash_account_class_version_id,'credit',p.amount_yen));}
  }else if(r){const amount=event.sign*r.amount_yen;
   if(event.kind.startsWith('expense_withholding_remittances')){for(const a of data.allocations.filter(a=>a.remittance_id===r.id))add(months,a.payment_month,-event.sign*a.amount_yen);lines=[l('withholding','debit',amount),l(r.cash_account_class_version_id,'credit',amount)];cash=addYen(cash,-amount);}
   if(event.kind.startsWith('expense_card_debits')){add(cards,r.card_id,-amount);lines=[l('card_payable','debit',amount),l(r.cash_account_class_version_id,'credit',amount)];cash=addYen(cash,-amount);}
   if(event.kind.startsWith('expense_refund_receipts')){const credit=byId.get(r.credit_expense_id);g=groups.get(credit?.original_expense_id);if(!g)fail('減額明細を確認してください',409);g.refund=addYen(g.refund,amount);add(creditRefunded,r.credit_expense_id,amount);g.refund_receivable=addYen(g.refund_receivable,-amount);lines=[l(r.cash_account_class_version_id,'debit',amount),l('refund_receivable','credit',amount)];cash=addYen(cash,amount);
    if(validate&&(g.refund_receivable<0||(creditRefunded.get(credit.id)??0)>-credit.actual_inc_tax||event.on<recognitionOn(credit)))fail('返金の入金が未収入金を超えています',409);
   }
  }
  if(before){balances(g);const deltas=[l('payable','credit',g.payable-before.payable-baseDebt),l('prepaid','debit',g.prepaid-before.prepaid),l('refund_receivable','debit',g.refund_receivable-before.refund_receivable)];
   if(e&&!p){post(event,event.kind,lines);post(event,g.refund_receivable!==before.refund_receivable?'refund_reclassification':'prepaid_transfer',deltas);}
   else post(event,!g.recognized&&!p.reverses_id?'prepayment':event.kind,[...lines,...deltas]);
  }else post(event,event.kind,lines);
  // 全履歴の各日を検査するので、過去日付の追加や取消も将来の納付・引落・返金を破綻させない。
  if(validate){if([...months.values()].some(n=>n<0))fail('納付が控除済みの源泉を超えています',409);if([...cards.values()].some(n=>n<0))fail('引落がカードの未払金を超えています',409);if([...groups.values()].some(g=>g.refund_receivable<0||(g.refund>0&&g.paid-g.debt<g.refund))||[...creditRefunded].some(([id,n])=>n>(creditAmounts.get(id)??0)))fail('返金が未収入金を超えています',409);if([...groups.values()].some(g=>g.debt<0))fail('減額が元明細の債務を超えています',409);}
 }
 const rows=[...groups.values()];return {asOf,unready,journal,groups:rows,totals:{payable:sum(rows.map(g=>g.payable)),prepaid:sum(rows.map(g=>g.prepaid)),refund_receivable:sum(rows.map(g=>g.refund_receivable)),card_payable:sum([...cards.values()]),withholding:sum([...months.values()]),cash_change:cash,offset},cards:[...cards].map(([card_id,amount_yen])=>({card_id,amount_yen})),withholdingMonths:[...months].sort().map(([payment_month,amount_yen])=>({payment_month,amount_yen})),pendingOffsets:payments.filter(p=>p.method==='offset'&&!p.reverses_id&&!p.billing_receipt_id&&p.paid_on<=asOf&&!payments.some(x=>x.reverses_id===p.id&&x.paid_on<=asOf)).map(p=>({payment_id:p.id,amount_yen:p.amount_yen,counter_description:p.counter_description,status:'相殺の反映待ち'}))};
}
