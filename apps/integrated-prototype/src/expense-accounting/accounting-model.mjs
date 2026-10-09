import {str,integer,choice,day,METHODS,fail} from '../expense-sheet/expense-model.mjs';
export const ACCOUNTING_SPECS=Object.freeze({
  'account-classes':{table:'gl_account_class_versions',parent:'account_id',reference:'gl_accounts'},
  categories:{table:'expense_category_versions',parent:'category_id',identity:'expense_categories'},
  aliases:{table:'expense_category_alias_versions',parent:'alias_text'},
  taxes:{table:'expense_tax_category_versions',parent:'tax_category_id',identity:'expense_tax_categories'},
  withholding:{table:'expense_withholding_category_versions',parent:'withholding_category_id',identity:'expense_withholding_categories'},
  'payment-terms':{table:'partner_payment_term_versions',parent:'partner_id',reference:'partners'},
});
export function accountingSetting(kind,b){const common={active:integer(b.active??1,0,1)};let fields={};
 if(kind==='account-classes')fields={normal_side:choice(b.normal_side,['debit','credit']),balance_class:choice(b.balance_class,['none','current','noncurrent']),settlement_role:b.settlement_role==null?null:choice(b.settlement_role,['cash','payable','card_payable','receivable','refund_receivable','prepaid','input_tax','output_tax','withholding','wip'])};
 if(kind==='categories')fields={name:str(b.name,100,true),account_class_version_id:integer(b.account_class_version_id,1),recognition_timing:choice(b.recognition_timing,['incurred_month','release_month_once'])};
 if(kind==='aliases')fields={category_version_id:integer(b.category_version_id,1)};
 if(kind==='taxes'){const tax_kind=choice(b.tax_kind,['taxable','exempt','non_taxable','out_of_scope']);fields={name:str(b.name,100,true),tax_kind,rate_bps:tax_kind==='taxable'?choice(b.rate_bps,[800,1000]):null,rounding:choice(b.rounding,['floor','nearest','ceil'])};if(tax_kind!=='taxable'&&b.rate_bps!=null)fail('課税以外の税率は空欄にしてください');}
 if(kind==='withholding')fields={name:str(b.name,100,true),treatment:choice(b.treatment,['not_applicable','manual_confirmed']),basis:str(b.basis,1000,true)};
 if(kind==='payment-terms'){fields={effective_from:day(b.effective_from),payment_month_offset:integer(b.payment_month_offset,0,24),payment_method:choice(b.payment_method,METHODS)};for(const p of ['closing','payment']){fields[p+'_rule']=choice(b[p+'_rule'],['day','month_end']);fields[p+'_day']=fields[p+'_rule']==='day'?integer(b[p+'_day'],1,31):null;if(fields[p+'_rule']==='month_end'&&b[p+'_day']!=null)fail('月末の条件には日を指定できません');}}
 return {...fields,...common};
}
export function accountingValues(b){const state=choice(b.withholding_state??'unverified',['unverified','confirmed']);return {category_version_id:integer(b.category_version_id,1),tax_category_version_id:integer(b.tax_category_version_id,1),withholding_category_version_id:b.withholding_category_version_id==null?null:integer(b.withholding_category_version_id,1),withholding_yen:state==='confirmed'?integer(b.withholding_yen):null,withholding_state:state,active:integer(b.active??1,0,1)};}
