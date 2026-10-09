import {fictionalInvoice,demoAccounting,DEMO_EXPENSE_REASON as reason} from './seed-expense-support.mjs';

export async function seedExpenseExtras(db,orgId,post,s,projectId,partnerId){
 let changed=0;
 await post('/expense-accounting/defaults',{expectedVersion:0,reason});
 const roles=Object.fromEntries((await db.all('SELECT settlement_role,id FROM gl_account_class_versions WHERE org_id=? AND settlement_role IS NOT NULL',[orgId])).map(r=>[r.settlement_role,r.id]));
 const expense=async(code,amount,on,extra={})=>{let e=await db.get('SELECT e.id,d.invoice_id FROM expenses e JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id JOIN expense_invoices i ON i.org_id=d.org_id AND i.id=d.invoice_id WHERE i.org_id=? AND i.code=?',[orgId,code]);if(!e){e=await post('/expenses',{project_id:projectId,work_id:null,partner_id:partnerId,category:'事務費',description:code+'（架空）',incurred_on:on,accounting_month:on.slice(0,7),actual_ex_tax:amount,tax_amount:0,actual_inc_tax:amount,reason,invoice:{...fictionalInvoice(code,on),override_note:reason},accounting:demoAccounting(s,'事務費',0),...extra});changed++;}return e;};
 const pay=async(e,amount,on,extra={})=>{const existing=await db.get('SELECT id FROM expense_payments WHERE org_id=? AND expense_id=? AND reverses_id IS NULL',[orgId,e.id]);if(!existing){await post('/expense-payments',{expenseId:e.id,paidOn:on,amountYen:amount,withheldYen:0,cashAccountClassVersionId:roles.cash,method:'transfer',expectedVersion:1,reason,...extra});changed++;}};
 const event=async(path,table,b)=>{if(!await db.get(`SELECT id FROM ${table} WHERE org_id=? AND code=?`,[orgId,b.code])){await post(path,{...b,cash_account_class_version_id:roles.cash,expectedVersion:0,reason});changed++;}};
 const prepaid=await expense('DEMO-EXTRA-PREPAID',12000,'2026-11-10',{invoice:{...fictionalInvoice('DEMO-EXTRA-PREPAID','2026-11-10'),override_note:reason}});await pay(prepaid,12000,'2026-10-15');
 const original=await expense('DEMO-EXTRA-ORIGINAL',9000,'2026-10-01');await pay(original,9000,'2026-10-02');
 const credit=await expense('DEMO-EXTRA-CREDIT',-3000,'2026-10-10',{invoice:{...fictionalInvoice('DEMO-EXTRA-CREDIT','2026-10-10'),document_kind:'credit_note',override_note:reason},credit:{original_expense_id:original.id,original_invoice_id:original.invoice_id}});
 await event('/expense-refund-receipts','expense_refund_receipts',{code:'DEMO-EXTRA-REFUND',credit_expense_id:credit.id,partner_id:partnerId,occurred_on:'2026-10-20',amount_yen:3000});
 let card=await db.get("SELECT v.id,v.card_id FROM expense_card_versions v JOIN expense_cards c ON c.org_id=v.org_id AND c.id=v.card_id WHERE c.org_id=? AND c.code='DEMO-EXP-CARD'",[orgId]);
 if(!card){card=await post('/expense-cards',{code:'DEMO-EXP-CARD',name:'業務カード（架空）',cash_account_class_version_id:roles.cash,effective_from:'2026-01-01',closing_rule:'month_end',payment_rule:'day',payment_day:10,payment_month_offset:1,expectedVersion:0,reason});changed++;}
 const cardExpense=await expense('DEMO-EXTRA-CARD',7000,'2026-10-01');await pay(cardExpense,7000,'2026-10-05',{method:'card',cardVersionId:card.id});
 await event('/expense-card-debits','expense_card_debits',{code:'DEMO-EXTRA-CARD-DEBIT',card_id:card.card_id,occurred_on:'2026-11-10',amount_yen:7000});
 const withholding=await expense('DEMO-EXTRA-WH',11000,'2026-10-01',{accounting:demoAccounting(s,'事務費',0,1000)});await pay(withholding,10000,'2026-10-20',{withheldYen:1000});
 await event('/expense-withholding-remittances','expense_withholding_remittances',{code:'DEMO-EXTRA-WH-REMIT',occurred_on:'2026-11-10',amount_yen:600,month_from:'2026-10',month_to:'2026-10'});
 // 既存作品の既存売上を使う。作品・売上明細を追加しない。
 const existingOffset=await db.get("SELECT e.id FROM expenses e JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id JOIN expense_invoices i ON i.org_id=d.org_id AND i.id=d.invoice_id WHERE i.org_id=? AND i.code='DEMO-EXTRA-OFFSET'",[orgId]);
 if(!existingOffset){
  const sale=await db.get(`SELECT s.report_id,s.work_id,s.partner_id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
   JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id
   WHERE s.org_id=? AND r.status='active' AND w.code LIKE 'DEMO-%' AND s.amount_inc_tax>=6000
   AND NOT EXISTS(SELECT 1 FROM billing_sale_claims c JOIN sale_lines x ON x.org_id=c.org_id AND x.id=c.sale_id WHERE x.org_id=s.org_id AND x.report_id=s.report_id)
   ORDER BY s.accounting_month DESC,s.id LIMIT 1`,[orgId]);
  if(!sale)throw Error('相殺例に使う未請求の架空売上がありません');
  const inv=await post('/billing/invoices',{workId:sale.work_id,reportIds:[sale.report_id],invoiceDate:'2026-10-05',dueDate:'2026-11-30',sourceAmountBasis:'platform_net',note:reason});changed++;
  const offset=await expense('DEMO-EXTRA-OFFSET',6000,'2026-10-01',{partner_id:sale.partner_id});
  await pay(offset,6000,'2026-10-20',{method:'offset',counterAccountClassVersionId:roles.receivable,billingInvoiceId:inv.invoiceId,counterDescription:'既存の売上請求と相殺（架空）'});
 }
 const pending=await expense('DEMO-EXTRA-OFFSET-PENDING',2000,'2026-10-01');await pay(pending,2000,'2026-10-20',{method:'offset',counterAccountClassVersionId:roles.refund_receivable,counterDescription:'システム外の未収入金と相殺（架空）'});
 return changed;
}
