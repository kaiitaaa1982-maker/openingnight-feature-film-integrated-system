// 請求書つき経費登録→予算対比→月別収支。既存レシピの金額の独立照合を維持。
import assert from 'node:assert/strict';
import {openPage,runId,yen,profitCards,localToday,gridCell,until,DEMO_WORK} from './_sales.mjs';
const CATEGORY='検証費（架空）';
const budgetRow=async page=>{const table=page.getByRole('table',{name:/^費目別の予算対比/});if(!(await table.count())||!(await table.getByRole('row').filter({hasText:CATEGORY}).count()))return {count:0,actual:0};return {count:yen(await gridCell(table,CATEGORY,'件数')),actual:yen(await gridCell(table,CATEGORY,'実績（税抜）'))};};
export default async({page,shot,step,api})=>{
 const run=runId(),exTax=100000,tax=10000,content='経費登録の検証（架空） '+run,reason='画面検証（架空）';
 const get=async path=>(await api.get('/api'+path)).json(),post=async(path,data)=>{const response=await api.post('/api'+path,{data});const body=await response.json();assert.ok(response.ok(),JSON.stringify(body));return body;};
 // 空の使い捨てfixtureでも動かせるよう、APIで会計の検証用設定を用意する。
 await post('/pl-bs/accounts/defaults',{});
 const options=await get('/expense-sheet/options'),settings=(await get('/expense-accounting/settings')).settings,account=options.gl_accounts.find(a=>a.code==='6150');
 let cls=settings['account-classes'].find(c=>c.account_id===account.id);
 if(!cls)cls=await post('/expense-accounting/account-classes',{account_id:account.id,normal_side:'debit',balance_class:'none',expectedVersion:0,reason});
 let category=settings.categories.find(c=>c.code==='DEMO-VERIFY-EXPENSE');
 if(!category)category=await post('/expense-accounting/categories',{code:'DEMO-VERIFY-EXPENSE',name:CATEGORY,account_class_version_id:cls.id,recognition_timing:'incurred_month',expectedVersion:0,reason});
 let taxClass=settings.taxes.find(c=>c.tax_kind==='taxable'&&c.rate_bps===1000);
 if(!taxClass)taxClass=await post('/expense-accounting/taxes',{code:'DEMO-VERIFY-TAX',name:'10%（架空）',tax_kind:'taxable',rate_bps:1000,rounding:'floor',expectedVersion:0,reason});
 let wh=settings.withholding.find(c=>c.treatment==='not_applicable');
 if(!wh)wh=await post('/expense-accounting/withholding',{code:'DEMO-VERIFY-WH',name:'源泉対象外（架空）',treatment:'not_applicable',basis:reason,expectedVersion:0,reason});
 const before=await profitCards(page),countBefore=(await get('/expenses')).rows.length;
 await openPage(page,'経費',{work:DEMO_WORK});await page.getByRole('region',{name:'費目別の予算対比'}).waitFor();const budgetBefore=await budgetRow(page);
 await page.getByRole('button',{name:'経費を登録',exact:true}).click();const form=page.getByRole('form',{name:'経費の登録',exact:true}),month=localToday().slice(0,7),last=new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate(),partner=options.partners[0];
 await form.getByLabel('支払先',{exact:true}).selectOption(String(partner.id));await form.getByLabel('証憑コード',{exact:true}).fill('DEMO-VERIFY-'+run);await form.getByLabel('請求書番号',{exact:true}).fill('DEMO-VERIFY-'+run+'（架空）');await form.getByLabel('請求日',{exact:true}).fill(month+'-15');await form.getByLabel('締め日',{exact:true}).fill(month+'-'+last);await form.getByLabel('出金予定日',{exact:true}).fill(month+'-'+last);await form.getByLabel('日付の変更理由').fill(reason);
 await form.getByLabel('発生日',{exact:true}).fill(month+'-15');await form.getByLabel('計上月',{exact:true}).fill(month);await form.getByLabel('内容',{exact:true}).fill(content);await form.getByLabel('予算（円）').fill('120000');await form.getByLabel('実績税抜（円）').fill(String(exTax));await form.getByLabel('税額（円）').fill(String(tax));await form.getByLabel('費用区分',{exact:true}).selectOption(String(category.id));await form.getByLabel('税区分',{exact:true}).selectOption(String(taxClass.id));await form.getByLabel('源泉区分',{exact:true}).selectOption(String(wh.id));await form.getByLabel('源泉の確認').selectOption('confirmed');await form.getByLabel('源泉控除額（円）').fill('0');await form.getByLabel('登録理由',{exact:true}).fill(reason);
 assert.equal(yen(await form.getByLabel('実績税込（自動）').inputValue()),110000);step('expense-tax-included: 100,000＋10,000=110,000');await shot('input');
 await form.getByRole('button',{name:'登録',exact:true}).click();await page.getByRole('status').filter({hasText:'登録しました'}).first().waitFor();await page.getByLabel('基準日',{exact:true}).fill(month+'-'+last);await page.getByRole('table',{name:'経費集計シート',exact:true}).getByRole('cell',{name:content,exact:true}).waitFor();assert.equal((await get('/expenses')).rows.length,countBefore+1);await until(()=>budgetRow(page),x=>x.count===budgetBefore.count+1&&x.actual===budgetBefore.actual+exTax,{label:'予算対比'});await shot('registered');step('expense-register: 請求書・会計版つきで登録。予算対比は100,000円増加');
 const after=await profitCards(page);assert.deepEqual([after.sales,after.expenses,after.net],[before.sales,before.expenses+exTax,before.net-exTax]);await shot('profit');step('expense-profit: 売上不変、経費＋100,000、差引−100,000');
};
