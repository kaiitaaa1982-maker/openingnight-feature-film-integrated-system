import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setupExpense} from './req6-expense-fixture.mjs';
import {fictionalInvoice,demoAccounting} from '../scripts/seed-expense-support.mjs';

const reason='会計の検証（架空）';
async function fixture({t}={}){
 const f=await setupExpense({t});await f.post('/expense-accounting/defaults',{expectedVersion:0,reason});
 const roles=Object.fromEntries((await f.db.all('SELECT settlement_role,id FROM gl_account_class_versions WHERE org_id=1 AND settlement_role IS NOT NULL')).map(x=>[x.settlement_role,x.id]));let n=0;
 const expense=async(amount=11000,on='2026-09-14',extra={})=>f.post('/expenses',f.payload({incurred_on:on,accounting_month:on.slice(0,7),actual_ex_tax:amount,tax_amount:0,actual_inc_tax:amount,invoice:fictionalInvoice('DEMO-EXTRA-'+(++n),on),accounting:demoAccounting(f.settings,'事務費',0),...extra}));
 const pay=(id,amount,on,extra={})=>f.post('/expense-payments',{expenseId:id,amountYen:amount,withheldYen:0,paidOn:on,method:'transfer',cashAccountClassVersionId:roles.cash,expectedVersion:1,reason,...extra});
 const balances=async on=>{const r=await f.call('/expense-accounting/balances?asOf='+on);assert.equal(r.status,200,JSON.stringify(r));for(const j of r.data.journal){assert.equal(j.lines.filter(l=>l.side==='debit').reduce((n,l)=>n+l.amount_yen,0),j.lines.filter(l=>l.side==='credit').reduce((n,l)=>n+l.amount_yen,0));assert.ok(j.expense_id||j.payment_id||j.record_id);assert.ok(j.lines.every(l=>l.account_class_version_id),JSON.stringify(j));}return r.data;};
 const card=()=>f.post('/expense-cards',{code:'DEMO-CARD',name:'業務カード（架空）',effective_from:'2026-01-01',closing_rule:'month_end',payment_rule:'day',payment_day:10,payment_month_offset:1,cash_account_class_version_id:roles.cash,expectedVersion:0,reason});
 const event=(path,b)=>f.post(path,{expectedVersion:0,reason,cash_account_class_version_id:roles.cash,...b});
 return {...f,roles,expense,pay,balances,card,event};
}
const selected=t=>[t.payable,t.card_payable,t.prepaid,t.refund_receivable,t.withholding,t.cash_change];

test('会社BSへ前払・未収・カード・源泉を一度だけ反映し、PLは税抜費用だけ。貸借差は0',async(t)=>{const f=await fixture({t});try{
 const pre=await f.expense(11000,'2026-10-10');await f.pay(pre.id,6000,'2026-09-10');
 const original=await f.expense(9000,'2026-09-01');await f.pay(original.id,9000,'2026-09-02');
 const credit=await f.expense(-3000,'2026-09-20',{invoice:{...fictionalInvoice('DEMO-BS-CREDIT','2026-09-20'),document_kind:'credit_note'},credit:{original_expense_id:original.id,original_invoice_id:original.invoice_id}});
 await f.event('/expense-refund-receipts',{code:'DEMO-BS-REFUND',credit_expense_id:credit.id,partner_id:f.settings.payee,occurred_on:'2026-09-25',amount_yen:2000});
 const c=await f.card(),ce=await f.expense(7000);await f.pay(ce.id,7000,'2026-09-15',{method:'card',cardVersionId:c.id});await f.event('/expense-card-debits',{code:'DEMO-BS-DEBIT',card_id:c.card_id,occurred_on:'2026-10-10',amount_yen:4000});
 const wh=await f.expense(11000,'2026-09-14',{accounting:demoAccounting(f.settings,'事務費',0,1000)});await f.pay(wh.id,10000,'2026-09-20',{withheldYen:1000});await f.event('/expense-withholding-remittances',{code:'DEMO-BS-REMIT',occurred_on:'2026-10-10',amount_yen:600,month_from:'2026-09',month_to:'2026-09'});
 for(const [month,expected,profit] of [['2026-09',[0,7000,6000,1000,1000,-23000],-24000],['2026-10',[5000,3000,0,1000,400,-27600],-35000]]){
  const response=await f.call(`/reports/pl-bs?from=2026-09&to=${month}&asOf=${month}`);assert.equal(response.status,200,JSON.stringify(response));const report=response.data;
  const row=key=>report.companyBs.rows.find(r=>r.key===key).value;
  assert.deepEqual(['expense_payable','expense_card_payable','expense_prepaid','expense_refund_receivable','expense_withholding','cash'].map(row),expected);
  assert.equal(report.companyPl.netIncome.period,profit);assert.equal(report.companyBs.difference,0);
 }
 }finally{f.db.close();}});

test('締め日前でも計上時に未払金。前払いは資産、計上日に振替。未来の取消は過去を変えない',async(t)=>{const f=await fixture({t});try{
 const e=await f.expense(11000,'2026-10-10');const p=await f.pay(e.id,6000,'2026-09-10');
 assert.deepEqual(selected((await f.balances('2026-09-09')).totals),[0,0,0,0,0,0]);
 assert.deepEqual(selected((await f.balances('2026-09-10')).totals),[0,0,6000,0,0,-6000]);
 assert.deepEqual(selected((await f.balances('2026-10-10')).totals),[5000,0,0,0,0,-6000]);
 assert.ok((await f.balances('2026-10-10')).journal.some(j=>j.kind==='prepaid_transfer'));
 await f.post(`/expense-payments/${p.id}/reverse`,{expectedVersion:1,reversedOn:'2026-11-01',reason});
 assert.equal((await f.balances('2026-10-31')).totals.payable,5000);assert.equal((await f.balances('2026-11-01')).totals.payable,11000);
 const v=await f.expense(1000,'2026-09-01');await f.post(`/expenses/${v.id}/void`,{expectedVersion:1,voided_on:'2026-09-20',reason});
 assert.equal((await f.balances('2026-09-19')).totals.payable,1000);assert.equal((await f.balances('2026-09-20')).totals.payable,0);
 }finally{f.db.close();}});

test('減額は費用を減らし、過払いは未収入金。返金の超過・他取引先・二重取消を拒否',async(t)=>{const f=await fixture({t});try{
 const e=await f.expense();await f.pay(e.id,11000,'2026-09-15');
 const credit=await f.expense(-3000,'2026-09-20',{invoice:{...fictionalInvoice('DEMO-CREDIT','2026-09-20'),document_kind:'credit_note'},credit:{original_expense_id:e.id,original_invoice_id:e.invoice_id}});
 assert.deepEqual(selected((await f.balances('2026-09-19')).totals),[0,0,0,0,0,-11000]);assert.deepEqual(selected((await f.balances('2026-09-20')).totals),[0,0,0,3000,0,-11000]);
 const payload={code:'DEMO-REFUND',credit_expense_id:credit.id,partner_id:f.settings.payee,occurred_on:'2026-09-25',amount_yen:2000};const refund=await f.event('/expense-refund-receipts',payload);
 assert.deepEqual(selected((await f.balances('2026-09-25')).totals),[0,0,0,1000,0,-9000]);
 assert.equal((await f.call('/expense-refund-receipts',{...payload,code:'DEMO-OVER',amount_yen:1001,expectedVersion:0,reason,cash_account_class_version_id:f.roles.cash})).status,409);
 assert.equal((await f.call('/expense-refund-receipts',{...payload,code:'DEMO-WRONG',partner_id:4,expectedVersion:0,reason,cash_account_class_version_id:f.roles.cash})).status,400);
 const voidPayload={expectedVersion:1,voided_on:'2026-10-01',reason};await f.post(`/expense-refund-receipts/${refund.id}/void`,voidPayload);
 assert.equal((await f.balances('2026-09-30')).totals.refund_receivable,1000);assert.equal((await f.balances('2026-10-01')).totals.refund_receivable,3000);
 assert.equal((await f.call(`/expense-refund-receipts/${refund.id}/void`,voidPayload)).status,409);
 }finally{f.db.close();}});

test('カード払いで現預金は動かず、カード別の引落で動く。過去の支払取消で将来の引落を不足させない',async(t)=>{const f=await fixture({t});try{
 const c=await f.card(),e=await f.expense();const p=await f.pay(e.id,11000,'2026-09-15',{method:'card',cardVersionId:c.id});
 assert.deepEqual(selected((await f.balances('2026-09-15')).totals),[0,11000,0,0,0,0]);
 const debit=await f.event('/expense-card-debits',{code:'DEMO-DEBIT',card_id:c.card_id,occurred_on:'2026-10-10',amount_yen:7000});
 assert.deepEqual(selected((await f.balances('2026-10-10')).totals),[0,4000,0,0,0,-7000]);
 assert.equal((await f.call(`/expense-payments/${p.id}/reverse`,{expectedVersion:1,reversedOn:'2026-09-16',reason})).status,409);
 assert.equal((await f.call('/expense-card-debits',{code:'DEMO-DEBIT-OVER',card_id:c.card_id,occurred_on:'2026-10-11',amount_yen:4001,expectedVersion:0,reason,cash_account_class_version_id:f.roles.cash})).status,409);
 await f.post(`/expense-card-debits/${debit.id}/void`,{expectedVersion:1,voided_on:'2026-10-20',reason});assert.equal((await f.balances('2026-10-20')).totals.card_payable,11000);
 }finally{f.db.close();}});

test('源泉は支払月ごとに控除−納付。部分納付・取消・遡及と超過を独立照合',async(t)=>{const f=await fixture({t});try{
 const a=demoAccounting(f.settings,'事務費',0,1000),e=await f.expense(11000,'2026-09-14',{accounting:a});const p=await f.pay(e.id,10000,'2026-09-20',{withheldYen:1000});
 const remit=await f.event('/expense-withholding-remittances',{code:'DEMO-REMIT',occurred_on:'2026-10-10',amount_yen:600,month_from:'2026-09',month_to:'2026-09'});
 assert.deepEqual(selected((await f.balances('2026-09-30')).totals),[0,0,0,0,1000,-10000]);assert.deepEqual(selected((await f.balances('2026-10-10')).totals),[0,0,0,0,400,-10600]);
 assert.deepEqual((await f.call('/expense-withholding-unpaid?asOf=2026-10-10')).data.rows,[{payment_month:'2026-09',amount_yen:400}]);
 assert.equal((await f.call(`/expense-payments/${p.id}/reverse`,{expectedVersion:1,reversedOn:'2026-09-25',reason})).status,409);
 assert.equal((await f.call('/expense-withholding-remittances',{code:'DEMO-OVER',occurred_on:'2026-10-11',amount_yen:401,month_from:'2026-09',month_to:'2026-09',expectedVersion:0,reason,cash_account_class_version_id:f.roles.cash})).status,409);
 await f.post(`/expense-withholding-remittances/${remit.id}/void`,{expectedVersion:1,voided_on:'2026-11-01',reason});assert.equal((await f.balances('2026-11-01')).totals.withholding,1000);
 }finally{f.db.close();}});

test('相殺は売上の消込と一括。売上側の単独取消・超過回収を拒否し、相手債権なしは反映待ち',async(t)=>{const f=await fixture({t});try{
 await f.call('/sales',{workId:1,report_key:'DEMO-OFFSET-SALE',kind:'digital',partner_id:2,product_id:1,period_from:'2026-09-01',period_to:'2026-09-30',recognition_basis_id:1,sales_month:'2026-09',basis_reason:reason,description:'相殺対象（架空）',quantity:1,amount_ex_tax:8000,tax_amount:0,amount_inc_tax:8000});
 const report=await f.db.get("SELECT id FROM report_imports WHERE report_key='DEMO-OFFSET-SALE'");const inv=await f.post('/billing/invoices',{workId:1,reportIds:[report.id],invoiceDate:'2026-09-14',dueDate:'2026-10-31',sourceAmountBasis:'platform_net',note:reason});
 const e=await f.expense(11000,'2026-09-14',{partner_id:2});const p=await f.pay(e.id,6000,'2026-09-20',{method:'offset',counterAccountClassVersionId:f.roles.receivable,counterDescription:'売上請求との相殺（架空）',billingInvoiceId:inv.invoiceId});
 const receipt=await f.db.get('SELECT billing_receipt_id FROM expense_payment_settlements WHERE payment_id=?',[p.id]);
 let balance=(await f.call('/billing/receivables?asOf=2026-09-20')).data.rows.find(x=>x.invoiceId===inv.invoiceId);assert.equal(balance.balance,2000);
 assert.deepEqual(selected((await f.balances('2026-09-20')).totals),[5000,0,0,0,0,0]);
 assert.equal((await f.call('/billing/receipts',{partnerId:2,reference:'DEMO-OVER',receivedOn:'2026-09-21',amountYen:2001,allocations:[{invoiceId:inv.invoiceId,amountYen:2001}]})).status,409);
 await assert.rejects(f.db.run('INSERT INTO billing_receipt_reversals(org_id,receipt_id,reversed_on,reason,created_by) VALUES(1,?,?,?,1)',[receipt.billing_receipt_id,'2026-09-21',reason]));
 await f.post(`/expense-payments/${p.id}/reverse`,{expectedVersion:1,reversedOn:'2026-09-25',reason});
 assert.equal((await f.call('/billing/receivables?asOf=2026-09-24')).data.rows.find(x=>x.invoiceId===inv.invoiceId).balance,2000);assert.equal((await f.call('/billing/receivables?asOf=2026-09-25')).data.rows.find(x=>x.invoiceId===inv.invoiceId).balance,8000);
 await f.pay(e.id,1000,'2026-09-26',{method:'offset',counterAccountClassVersionId:f.roles.refund_receivable,counterDescription:'システム外の債権（架空）'});
 assert.equal((await f.balances('2026-09-26')).pendingOffsets[0].status,'相殺の反映待ち');
 }finally{f.db.close();}});

test('科目初期採用は再実行で増えず、既存code/system_keyを上書きしない。権限と組織外参照を拒否',async(t)=>{const f=await fixture({t});try{
 const before=await f.db.get('SELECT COUNT(*) n FROM gl_accounts');await f.post('/expense-accounting/defaults',{expectedVersion:0,reason});assert.deepEqual(await f.db.get('SELECT COUNT(*) n FROM gl_accounts'),before);
 const prod=await f.login('production@openingnight.invalid'),other=await f.login('outsider@other.invalid');assert.equal((await f.call('/expense-accounting/balances?asOf=2026-09-30',null,prod)).status,403);
 const e=await f.expense();assert.equal((await f.call('/expense-payments',{expenseId:e.id,expectedVersion:1,amountYen:1,withheldYen:0,paidOn:'2026-09-20',reason,method:'card',cardVersionId:999999},other)).status,404);
 const c=await f.card();await assert.rejects(f.db.run('UPDATE expense_card_versions SET name=? WHERE id=?',['上書き',c.id]));assert.deepEqual(await foreignKeyViolations(f.db),[]);
 }finally{f.db.close();}});

test('同じ残高からの同時引落は片方だけ。失敗側は記録・監査とも残さない',async(t)=>{const f=await fixture({t});try{
 const c=await f.card(),e=await f.expense(1000);await f.pay(e.id,1000,'2026-09-20',{method:'card',cardVersionId:c.id});
 const b={card_id:c.card_id,occurred_on:'2026-10-10',amount_yen:700,cash_account_class_version_id:f.roles.cash,reason,expectedVersion:0};
 const results=await Promise.all(['DEMO-CONCURRENT-A','DEMO-CONCURRENT-B'].map(code=>f.call('/expense-card-debits',{...b,code})));
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal((await f.balances('2026-10-10')).totals.card_payable,300);
 assert.equal((await f.db.get('SELECT COUNT(*) n FROM expense_card_debits')).n,1);assert.equal((await f.db.get("SELECT COUNT(*) n FROM audit_log WHERE entity_type='expense_card_debits'")).n,1);
 }finally{f.db.close();}});

test('実在する別組織のカード版・現預金科目版をAPIと複合FKで拒否',async(t)=>{const f=await fixture({t});try{
 const other=await f.login('outsider@other.invalid');let r=await f.call('/expense-accounting/defaults',{expectedVersion:0,reason},other);assert.equal(r.status,201);
 const cash=await f.db.get("SELECT id FROM gl_account_class_versions WHERE org_id=2 AND settlement_role='cash'");r=await f.call('/expense-cards',{code:'DEMO-OTHER-CARD',name:'別組織カード（架空）',cash_account_class_version_id:cash.id,effective_from:'2026-01-01',closing_rule:'month_end',payment_rule:'month_end',payment_month_offset:1,expectedVersion:0,reason},other);assert.equal(r.status,201);const card=r.data;
 const e=await f.expense();const before=(await f.db.get('SELECT COUNT(*) n FROM expense_payments')).n;
 assert.equal((await f.call('/expense-payments',{expenseId:e.id,amountYen:1000,withheldYen:0,paidOn:'2026-09-20',method:'card',cardVersionId:card.id,expectedVersion:1,reason})).status,400);
 assert.equal((await f.call('/expense-card-debits',{code:'DEMO-CROSS',card_id:card.card_id,occurred_on:'2026-10-10',amount_yen:1,cash_account_class_version_id:f.roles.cash,expectedVersion:0,reason})).status,400);
 assert.equal((await f.call('/expense-withholding-remittances',{code:'DEMO-CROSS',occurred_on:'2026-10-10',amount_yen:1,month_from:'2026-09',month_to:'2026-09',cash_account_class_version_id:cash.id,expectedVersion:0,reason})).status,400);
 await assert.rejects(f.db.run('INSERT INTO expense_card_debits(org_id,id,created_by,reason,code,card_id,occurred_on,amount_yen,cash_account_class_version_id) VALUES(1,900001,1,?,?,?,?,1,?)',[reason,'DEMO-CROSS-SQL',card.card_id,'2026-10-10',f.roles.cash]));
 assert.equal((await f.db.get('SELECT COUNT(*) n FROM expense_payments')).n,before);
 }finally{f.db.close();}});

test('返金済み減額の取消と追加支払を拒否。返金取消の後は減額を取消できる',async(t)=>{const f=await fixture({t});try{
 const e=await f.expense(1100);await f.pay(e.id,1100,'2026-09-15');const c=await f.expense(-1100,'2026-09-20',{invoice:{...fictionalInvoice('DEMO-VOID-CREDIT','2026-09-20'),document_kind:'credit_note'},credit:{original_expense_id:e.id,original_invoice_id:e.invoice_id}});
 const r=await f.event('/expense-refund-receipts',{code:'DEMO-VOID-REFUND',credit_expense_id:c.id,partner_id:f.settings.payee,occurred_on:'2026-09-21',amount_yen:1100});
 assert.equal((await f.call(`/expenses/${c.id}/void`,{expectedVersion:1,voided_on:'2026-09-22',reason})).status,409);
 await f.post(`/expense-refund-receipts/${r.id}/void`,{expectedVersion:1,voided_on:'2026-09-22',reason});await f.post(`/expenses/${c.id}/void`,{expectedVersion:1,voided_on:'2026-09-23',reason});
 assert.equal((await f.balances('2026-09-22')).totals.refund_receivable,1100);assert.equal((await f.balances('2026-09-23')).totals.refund_receivable,0);
 }finally{f.db.close();}});
