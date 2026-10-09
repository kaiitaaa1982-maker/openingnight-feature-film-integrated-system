import {settlementProjection} from './settlement-model.mjs';
import {addYen} from '../expense-sheet/expense-model.mjs';

const sum=xs=>addYen(...xs);
export function monthEnd(month){const [y,m]=month.split('-').map(Number);const d=new Date(0);d.setUTCFullYear(y,m,0);return d.toISOString().slice(0,10);}
// 既存PLの費目分類には触れず、経費の決済だけを月末BSへ接続する。
export function expenseBsAdjustments(data,{asOf,openingMonth=null}){
 const at=on=>{
  const p=settlementProjection(data,on),ready=new Set(data.expenses.filter(e=>!p.unready.includes(e.id)).map(e=>e.id));
  const included=e=>ready.has(e.id)&&e.accounting_month<=on.slice(0,7)&&(!e.voided_on||e.voided_on>on);
  const oldDebt=sum(data.expenses.filter(included).map(e=>e.actual_inc_tax));
  const paid=data.payments.filter(p=>ready.has(p.expense_id)&&p.paid_on<=on),oldPaid=sum(paid.map(p=>p.amount_yen));
  const nonCashReceipts=sum(paid.filter(p=>p.billing_receipt_id).map(p=>p.amount_yen));
  const work={};for(const e of data.expenses.filter(e=>ready.has(e.id)&&!e.original_expense_id)){
   const related=data.expenses.filter(x=>x.id===e.id||x.original_expense_id===e.id),g=p.groups.find(g=>g.root===e.id);if(!g)continue;
   const old=sum(related.filter(included).map(x=>x.actual_inc_tax))-sum(paid.filter(x=>x.expense_id===e.id).map(x=>x.amount_yen));
   const key=e.work_id??'company';work[key]??={payable:0,prepaid:0,refund_receivable:0};work[key].payable=addYen(work[key].payable,g.payable,-old);work[key].prepaid=addYen(work[key].prepaid,g.prepaid);work[key].refund_receivable=addYen(work[key].refund_receivable,g.refund_receivable);
  }
  const unreadyIds=new Set(p.unready),unreadyDebt=sum(data.expenses.filter(e=>unreadyIds.has(e.id)&&e.accounting_month<=on.slice(0,7)&&(!e.voided_on||e.voided_on>on)).map(e=>e.actual_inc_tax))-sum(data.payments.filter(x=>unreadyIds.has(x.expense_id)&&x.paid_on<=on).map(x=>x.amount_yen));
  for(const e of data.expenses.filter(e=>unreadyIds.has(e.id))){const key=e.work_id??'company';work[key]??={payable:0,prepaid:0,refund_receivable:0};const amount=(e.accounting_month<=on.slice(0,7)&&(!e.voided_on||e.voided_on>on)?e.actual_inc_tax:0)-sum(data.payments.filter(x=>x.expense_id===e.id&&x.paid_on<=on).map(x=>x.amount_yen));work[key].payable-=amount;work[key].unready_payable=(work[key].unready_payable??0)+amount;}
  return {unready_payable:unreadyDebt,payable:p.totals.payable-oldDebt+oldPaid-unreadyDebt,cash:p.totals.cash_change+oldPaid-nonCashReceipts,prepaid:p.totals.prepaid,refund_receivable:p.totals.refund_receivable,card_payable:p.totals.card_payable,withholding:p.totals.withholding,pending_offset_assets:-sum(paid.filter(p=>p.method==='offset'&&!p.billing_receipt_id).map(p=>p.amount_yen)),work,unready:p.unready};
 };
 const end=at(monthEnd(asOf)),start=at(openingMonth?monthEnd(openingMonth):'0001-01-01'),result={work:{},unready:end.unready};
 for(const key of ['unready_payable','payable','cash','prepaid','refund_receivable','card_payable','withholding','pending_offset_assets'])result[key]=end[key]-start[key];
 for(const key of new Set([...Object.keys(end.work),...Object.keys(start.work)])){result.work[key]={};for(const field of ['payable','prepaid','refund_receivable','unready_payable'])result.work[key][field]=(end.work[key]?.[field]??0)-(start.work[key]?.[field]??0);}
 return result;
}
