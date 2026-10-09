import {insert,newId} from '../expense-sheet/expense-service.mjs';
import {fail,expected,integer,str,day} from '../expense-sheet/expense-model.mjs';
import {accountingSetting} from './accounting-model.mjs';
import {recordSettlement,cashClass} from './settlement-service.mjs';
import {loadSettlement,settlementProjection} from './settlement-model.mjs';

export const SETTLEMENT_DEFAULTS=[
 ['1100','現預金','asset','cash','cash','debit'],['1200','売掛金','asset','receivable','receivable','debit'],
 ['2100','未払金','liability','expense_payable','payable','credit'],['1300','制作中の作品','asset','work_in_progress','wip','debit'],
 ['R6-PREPAID','前払金','asset','expense_prepaid','prepaid','debit'],['R6-REFUND','未収入金','asset','expense_refund_receivable','refund_receivable','debit'],
 ['R6-CARD','未払金（カード）','liability','expense_card_payable','card_payable','credit'],
 ['R6-WH','預り金（源泉）','liability','expense_withholding','withholding','credit'],['R6-TAX','仮払消費税','asset','expense_input_tax','input_tax','debit'],
];
export async function allFinance(s,i){await s.finance(i);for(const p of await s.db.all('SELECT id FROM projects WHERE org_id=?',[i.org_id]))await s.finance(i,p.id);}
export function registerSettlementRoutes(app,s,{wrap,input,identity}){
 app.post('/api/expense-accounting/defaults',wrap(async c=>{
  const i=identity(c);await s.finance(i);if(i.role!=='admin')fail('会計の設定は管理者だけが変更できます',403);const b=await input(c);if(expected(b)!==0)fail('初期採用の版は0です',409);const statements=[],conflicts=[],adopted=[];
  for(const [code,name,section,key,role,side] of SETTLEMENT_DEFAULTS){const found=await s.db.all('SELECT * FROM gl_accounts WHERE org_id=? AND (code=? OR system_key=?)',[i.org_id,code,key]);let account=found[0];
   if(found.length>1||(account&&(account.section!==section||account.system_key!==key))){conflicts.push({code,system_key:key,reason:'既存の科目と衝突するため採用していません'});continue;}
   const roleExists=await s.db.get('SELECT id FROM gl_account_class_versions WHERE org_id=? AND settlement_role=?',[i.org_id,role]);if(roleExists)continue;
   if(!account){account={id:newId()};statements.push(insert('gl_accounts',{id:account.id,org_id:i.org_id,code,name,section,source:'system',system_key:key,cash_effect:0,sort_order:500,created_by:i.user_id}));}
   const old=await s.latest(i,'gl_account_class_versions','account_id',account.id);if(old){conflicts.push({code,reason:'既存の分類版を上書きしません'});continue;}
   statements.push(insert('gl_account_class_versions',{id:newId(),account_id:account.id,version_no:1,active:1,normal_side:side,balance_class:'current',settlement_role:role,...s.meta(i,b)}),s.audit(i,'expense_account_default',account.id,b));adopted.push(code);
  }
  if(statements.length)await s.batch(statements);return c.json({ok:true,adopted,conflicts},201);
 }));
 app.get('/api/expense-cards',wrap(async c=>{const i=identity(c);await s.finance(i);return c.json({ok:true,rows:await s.db.all('SELECT c.code,v.* FROM expense_cards c JOIN expense_card_versions v ON v.org_id=c.org_id AND v.card_id=c.id WHERE c.org_id=? ORDER BY v.card_id,v.version_no',[i.org_id])});}));
 app.post('/api/expense-cards',wrap(async c=>{const i=identity(c);await s.finance(i);if(i.role!=='admin')fail('カードの設定は管理者だけが変更できます',403);const b=await input(c),base=expected(b),code=str(b.code,60,true),old=await s.db.get('SELECT id FROM expense_cards WHERE org_id=? AND code=?',[i.org_id,code]),id=old?.id??newId(),statements=[];
  const values=accountingSetting('payment-terms',{...b,payment_method:'card'});delete values.payment_method;
  if(!old)statements.push(insert('expense_cards',{id,code,...s.meta(i,b)}));const versionId=newId();statements.push(s.versionGuard(i,'expense_card_versions','card_id',id,base),insert('expense_card_versions',{id:versionId,card_id:id,version_no:base+1,name:str(b.name,100,true),cash_account_class_version_id:await cashClass(s,i,b.cash_account_class_version_id),...values,...s.meta(i,b)}),s.audit(i,'expense_card',id,b));await s.batch(statements);return c.json({ok:true,id:versionId,card_id:id,version:base+1},201);
 }));
 for(const [path,table] of [['withholding-remittances','expense_withholding_remittances'],['card-debits','expense_card_debits'],['refund-receipts','expense_refund_receipts']]){
  app.post('/api/expense-'+path,wrap(async c=>c.json({ok:true,...await recordSettlement(s,identity(c),table,await input(c))},201)));
  app.post('/api/expense-'+path+'/:id/void',wrap(async c=>c.json({ok:true,...await recordSettlement(s,identity(c),table,await input(c),integer(Number(c.req.param('id')),1))},201)));
  app.get('/api/expense-'+path,wrap(async c=>{const i=identity(c);await allFinance(s,i);return c.json({ok:true,rows:(await loadSettlement(s.db,i.org_id)).records[table]});}));
 }
 app.get('/api/expense-accounting/balances',wrap(async c=>{const i=identity(c);await allFinance(s,i);const asOf=day(c.req.query('asOf')),result=settlementProjection(await loadSettlement(s.db,i.org_id),asOf);return c.json({ok:true,...result});}));
 app.get('/api/expense-withholding-unpaid',wrap(async c=>{const i=identity(c);await allFinance(s,i);const result=settlementProjection(await loadSettlement(s.db,i.org_id),day(c.req.query('asOf')));return c.json({ok:true,asOf:result.asOf,rows:result.withholdingMonths,total:result.totals.withholding});}));
}
