import test from 'node:test';
import assert from 'node:assert/strict';
import {setupExpense} from './req6-expense-fixture.mjs';
import {expenseSource,resolveExpenseAccounts} from '../src/expense-sheet/expense-read.mjs';
import {buildPlBs,DEFAULT_ACCOUNTS} from '../src/reports/pl-bs-model.mjs';
import {EXPENSE_TABLE_LABELS} from '../src/expense-sheet/expense-definitions.mjs';
import {tableLinks,columnRows} from '../src/admin/er-model.mjs';
import {loadCommitteeExpenseLines} from '../src/committee/committee-income.mjs';
import {expenseTemplate} from '../src/expense-sheet/expense-workbook.mjs';
import {requiredPreviewApiUrls} from '../scripts/build-preview.mjs';
import {splitPreviewData,mergePreviewData,snapshotKey} from '../src/preview/snapshot-client.mjs';

const reportPath='/reports/pl-bs?from=2026-09&to=2026-11&asOf=2026-11';
const value=(report,key)=>report.companyBs.rows.find(r=>r.key===key)?.value;
const accounts=DEFAULT_ACCOUNTS.map((a,n)=>({...a,id:n+1}));
const mapped=(id,month,amount,key,category=key)=>{const a=accounts.find(a=>a.systemKey===key);return {id,workId:1,month,category,exTax:amount,tax:0,incTax:amount,accountId:a.id,accountName:a.name,section:a.section,systemKey:key,recognitionTiming:key==='production_cost'?'release_month_once':'incurred_month'};};

test('固定の架空入力を独立計算：各月・期間・累計・4科目・委員会の自社取得額が円一致',()=>{
 const input={from:'2026-09',to:'2026-11',works:[{id:1,code:'DEMO-A',title:'自社（架空）',releaseMonth:'2026-10',releaseSource:'window'},{id:2,code:'DEMO-C',title:'委員会（架空）',committee:true}],accounts,profile:{selfPartnerId:1},
  saleLines:[{workId:1,month:'2026-09',amount:10000},{workId:1,month:'2026-10',amount:20000},{workId:1,month:'2026-11',amount:30000}],
  expenses:[mapped(1,'2026-09',1000,'production_cost','任意の費目'),mapped(2,'2026-10',200,'production_cost'),mapped(3,'2026-09',300,'direct_cost','制作費と書いてあっても直接費'),mapped(4,'2026-10',400,'promotion'),mapped(5,'2026-11',500,'work_other_expense')],
  committee:[{workId:2,acquisitions:[{month:'2026-10',distribution:700,windowFee:100,managerFee:50,acquisition:850}]}]};
 const r=buildPlBs(input),w=r.workPl.find(w=>w.workId===1);
 assert.deepEqual(w.monthly.map(m=>[m.direct,m.production,m.promotion,m.workOther,m.profit]),[[300,0,0,0,9700],[0,1200,400,0,18400],[0,0,0,500,29500]]);
 assert.equal(w.period.profit,57600);assert.equal(w.cumulative.profit,57600);
 assert.equal(r.workPl.find(w=>w.workId===2).period.acq,850);
 assert.equal(r.companyPl.netIncome.period,58450);
 assert.deepEqual(r.companyPl.rows.find(r=>r.key==='netIncome').values,{'m:2026-09':9700,'m:2026-10':19250,'m:2026-11':29500,period:58450});
 const narrowed=buildPlBs({...input,from:'2026-10'});assert.equal(narrowed.workPl[0].period.profit,47900);assert.equal(narrowed.workPl[0].cumulative.profit,57600);
});

test('対応なしは文字に戻さず件数と額を残す。追加科目は実際の科目・区分で一度だけ計上',()=>{
 const extra={id:999,code:'DEMO-EXP',name:'特別な費用（架空）',section:'non_operating_expense',source:'manual',sortOrder:10};
 const r=buildPlBs({from:'2026-09',to:'2026-09',accounts:[...accounts,extra],works:[{id:1,code:'DEMO-A'}],expenses:[{id:1,workId:1,month:'2026-09',category:'制作費',exTax:100,tax:0,incTax:100},{...mapped(2,'2026-09',200,'direct_cost'),accountId:999,accountName:extra.name,section:extra.section,systemKey:null}],manual:[{accountId:999,workId:1,kind:'flow',month:'2026-09',amount:30,tax:0,status:'reviewed'}]});
 assert.equal(r.companyPl.netIncome.period,-330);assert.equal(r.workPl[0].period.profit,-330);assert.equal(r.workPl[0].period.sga,100);
 assert.equal(r.companyPl.rows.find(r=>r.key==='expense:999').values.period,200);
 assert.equal(r.companyPl.rows.find(r=>r.key==='manual:999').values.period,30);
 assert.equal(r.companyPl.rows.find(r=>r.key==='expense:unclassified').values.period,100);
 assert.ok(r.workDetail[1].rows.some(r=>r.label===extra.name));
 assert.ok(r.expenseClassification.some(r=>r.label==='費用区分未整備'&&r.count===1&&r.exTax===100));
 const common=buildPlBs({from:'2026-09',to:'2026-09',accounts,expenses:[{id:1,workId:null,month:'2026-09',category:'未整備',exTax:100,tax:0,incTax:100}]});assert.equal(common.companyPl.netIncome.period,-100);assert.equal(common.checks.find(c=>c.item.startsWith('会社PLの当期純利益')).value,0);
});

test('管理者の理由つき初期採用・完全一致・競合・再送。明細の版を優先し別名の変更で再分類しない',async(t)=>{
 const f=await setupExpense({t});try{
  const old=await f.db.get("INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,'2026-09-01','2026-09','制作費 新規（架空）','旧経費（架空）',1000,100,1100) RETURNING id");
  const before=await f.db.get('SELECT * FROM expenses WHERE id=?',[old.id]);
  let p=(await f.call('/expense-accounting/adoption-preview')).data;
  assert.ok(p.rows.some(r=>r.alias==='制作費 新規(架空)'&&r.key==='production_cost'));
  const editor=await f.login('editor@openingnight.invalid');assert.equal((await f.call('/expense-accounting/adopt',{token:p.token,reason:'採用（架空）'},editor)).status,403);
  assert.equal((await f.call('/expense-accounting/adopt',{token:p.token,reason:''})).status,400);
  assert.equal((await f.call('/expense-accounting/adopt',{token:p.token,reason:'採用（架空）'})).status,201);
  assert.deepEqual(await f.db.get('SELECT * FROM expenses WHERE id=?',[old.id]),before);
  assert.equal((await resolveExpenseAccounts(f.db,1,[before]))[0].expense_system_key,'production_cost');
  assert.equal((await resolveExpenseAccounts(f.db,1,[{...before,category:'制作費 新規（架空） 別'}]))[0].expense_account_id,null);
  p=(await f.call('/expense-accounting/adoption-preview')).data;const audit=(await f.db.get('SELECT COUNT(*) n FROM audit_log')).n;
  assert.equal((await f.call('/expense-accounting/adopt',{token:p.token,reason:'再確認（架空）'})).data.adopted,0);assert.equal((await f.db.get('SELECT COUNT(*) n FROM audit_log')).n,audit);
  const made=await f.post('/expenses',f.payload({category:'制作費 新規（架空）'}));const row=await f.db.get('SELECT * FROM expenses WHERE id=?',[made.id]);assert.equal((await resolveExpenseAccounts(f.db,1,[row]))[0].expense_system_key,'work_other_expense');
  assert.equal((await f.call('/expense-accounting/adopt',{token:p.token,reason:'古い下見（架空）'})).status,409);
 }finally{f.db.close();}
});

test('有効明細は取消日と取込取消を共通に除外。PLは取消月に反対額、委員会・予算一覧からは除外',async(t)=>{
 const f=await setupExpense({t});try{
  const e=await f.post('/expenses',f.payload());await f.post(`/expenses/${e.id}/void`,{expectedVersion:1,voided_on:'2026-10-01',reason:'取消（架空）'});
  assert.equal((await f.db.all(`SELECT * FROM ${expenseSource({asOf:'2026-09-30'})} WHERE org_id=1 AND id=?`,[e.id])).length,1);
  assert.equal((await f.db.all(`SELECT * FROM ${expenseSource()} WHERE org_id=1 AND id=?`,[e.id])).length,0);
  assert.ok(!(await loadCommitteeExpenseLines(f.db,1,[1])).some(r=>r.id===e.id));
  assert.equal((await f.call('/analytics/income?workId=1')).data.expenses.exTax,0);
  assert.equal((await f.call('/reports/work-pnl?workId=1&from=2026-09&to=2026-11')).data.totals.expense,0);
  const list=(await f.call('/expenses')).data;assert.ok(!JSON.stringify(list).includes('"id":'+e.id+','));
  const r=(await f.call(reportPath)).data;const cost=r.companyPl.rows.find(r=>r.key==='work_other_expense');assert.equal(cost.values['m:2026-09'],12000);assert.equal(cost.values['m:2026-10'],-12000);assert.equal(cost.values.period,0);
 }finally{f.db.close();}
});

test('旧経費は締め日未整備分に分け、予定へ入れない。源泉・前払・カードは期日までの事実だけ',async(t)=>{
 const f=await setupExpense({t});try{
  await f.post('/expense-accounting/defaults',{expectedVersion:0,reason:'科目確認（架空）'});
  await f.db.run("INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,'2026-09-01','2026-09','事務費','未整備（架空）',1000,100,1100)");
  const e=await f.post('/expenses',f.payload());const r=(await f.call(reportPath)).data;
  assert.equal(value(r,'expense_payable'),13200);assert.equal(value(r,'expense_unready_payable'),1100);assert.equal(r.workBalances.find(w=>w.workId===1).expensePayable,13200);assert.equal(r.workBalances.find(w=>w.workId===1).expenseUnreadyPayable,1100);assert.equal(r.companyBs.reference.find(x=>x.key==='expense_input_tax')?.value,1300);
  const p=(await f.call('/expense-payouts?asOf=2026-09-30')).data;assert.equal(p.excluded.unready,1);assert.equal(p.rows.reduce((n,r)=>n+r.cash_due_yen,0),13200);
  await f.post('/expense-payments',{expenseId:e.id,paidOn:'2026-10-05',amountYen:5000,withheldYen:0,cashAccountClassVersionId:f.settings.classes['1100'],expectedVersion:1,reason:'一部払い（架空）'});
  assert.equal(value((await f.call(reportPath)).data,'expense_payable'),8200);
  assert.equal(value((await f.call('/reports/pl-bs?from=2026-09&to=2026-09&asOf=2026-09')).data,'expense_payable'),13200);
 }finally{f.db.close();}
});

test('仕訳を期間・作品・支払先で絞り、借貸を独立集計。明細・支払・請求書に戻れる',async(t)=>{
 const f=await setupExpense({t});try{
  await f.post('/expense-accounting/defaults',{expectedVersion:0,reason:'確認（架空）'});const e=await f.post('/expenses',f.payload());
  await f.post('/expense-payments',{expenseId:e.id,paidOn:'2026-10-05',amountYen:5000,withheldYen:0,cashAccountClassVersionId:f.settings.classes['1100'],expectedVersion:1,reason:'確認（架空）'});
  const r=(await f.call(`/expense-journal?from=2026-10-01&to=2026-10-31&workId=1&partnerId=${f.settings.payee}`)).data;
  assert.equal(r.debitYen,5000);assert.equal(r.creditYen,5000);assert.equal(r.rows.length,1);assert.equal(r.rows[0].invoice_id,e.invoice_id);assert.ok(r.rows[0].payment_id);assert.equal(r.rows[0].expense_id,e.id);
  const prod=await f.login('production@openingnight.invalid');assert.equal((await f.call('/expense-journal',null,prod)).status,403);
 }finally{f.db.close();}
});

test('36表すべてのデータ一覧に和名・列の意味・参照先。ERにも組織を含む関係が出る',async(t)=>{
 const f=await setupExpense({t});try{
  const er=(await f.call('/er')).data.tables;assert.equal(Object.keys(EXPENSE_TABLE_LABELS).length,36);
  for(const [name,label] of Object.entries(EXPENSE_TABLE_LABELS)){
   const r=await f.call(`/admin/tables/${name}/definition`);assert.equal(r.status,200,name);assert.equal(r.data.label,label);assert.ok(r.data.meanings.some(m=>m.description.length>10),name);
   for(const c of r.data.columns){assert.notEqual(c.label,c.name,`${name}.${c.name}`);assert.ok(c.description,`${name}.${c.name}`);}
   assert.ok(er.some(t=>t.name===name),name);assert.ok(tableLinks(er,name).outgoing.length>0,name);
   assert.ok(columnRows(er.find(t=>t.name===name)).every(c=>c.description),name);
  }
 }finally{f.db.close();}
});

test('取込束取消は全読取口へ反映し、計上月・取消月を一度ずつ反映する',async(t)=>{
 const f=await setupExpense({t});try{
  const partner=await f.post('/partners',{code:'DEMO-PARTNER-EOM',name:'取込支払先（架空）',kind:'vendor'});
  await f.post('/expense-accounting/payment-terms',{partner_id:partner.id,expectedVersion:0,reason:'確認（架空）',effective_from:'2026-01-01',closing_rule:'month_end',payment_rule:'month_end',payment_month_offset:1,payment_method:'transfer'});
  const p=await f.post('/expense-imports/preview',{file_name:'DEMO-cancel.xlsx',original_base64:Buffer.from(expenseTemplate('legacy22',{samples:true})).toString('base64'),expectedVersion:0,reason:'確認（架空）',supplement:{project_id:1,incurred_on:'2026-09-14',tax_category_version_id:f.settings.taxes['10'],withholding_category_version_id:f.settings.withholding.NONE,common_expense:true,each_row_invoice:true}});
  await f.post(`/expense-imports/${p.id}/commit`,{expectedVersion:1,hash:p.hash,reason:'登録（架空）'});
  await f.post(`/expense-imports/${p.id}/cancel`,{expectedVersion:1,voided_on:'2026-10-01',reason:'取消（架空）'});
  assert.equal((await f.db.all(`SELECT * FROM ${expenseSource()} WHERE org_id=1`)).length,0);
  assert.equal((await f.db.all(`SELECT * FROM ${expenseSource({asOf:'2026-09-30'})} WHERE org_id=1`)).length,1);
  const r=(await f.call(reportPath)).data,net=r.companyPl.rows.find(r=>r.key==='netIncome');
  assert.equal(net.values['m:2026-09'],-12000);assert.equal(net.values['m:2026-10'],12000);assert.equal(net.values.period,0);
 }finally{f.db.close();}
});

test('経費プレビューは全列セット・請求書・取込・予定・設定・仕訳を記録し、16MB未満のpartsから同じ応答へ戻る',()=>{
 const source=new Map([[snapshotKey('GET','/api/expense-sheet?asOf=2026-09-28&set=basic&page=1&pageSize=100'),{status:200,body:{total:101,rows:[{id:123}]}}],['GET /api/expense-invoices',{status:200,body:{rows:[{id:456}]}}]]);
 const urls=requiredPreviewApiUrls(source);
 for(const path of ['/api/expense-invoices/456','/api/expense-imports','/api/expense-imports/holds','/api/expense-accounting/settings','/api/expense-journal?to=2026-09-28','/api/expense-sheet/123?asOf=2026-09-28'])assert.ok(urls.includes(path),path);
 for(const set of ['basic','legacy','accounting','payout'])assert.ok(urls.some(u=>u.includes('set='+set)&&u.includes('page=2')),set);
 const responses=new Map(urls.map((u,n)=>[snapshotKey('GET',u),{status:200,body:{id:n,text:'架空'.repeat(18000)}}]));
 const {index,parts}=splitPreviewData({},responses,{limitBytes:1000000});assert.ok(parts.length>1);
 for(const text of [index,...parts.map(p=>p.text)])assert.ok(Buffer.byteLength(text)<16000000);
 assert.deepEqual(mergePreviewData(JSON.parse(index),parts.map(p=>JSON.parse(p.text))).responses,new Map([...responses].sort(([a],[b])=>a<b?-1:a>b?1:0)));
});

test('初期採用後の新しい費目は既存区分の版を再利用。衝突した科目へ自動で上書きしない',async(t)=>{
 const f=await setupExpense({t});try{
  const legacy=category=>f.db.run("INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,'2026-09-01','2026-09',?,'追加の旧経費（架空）',1000,100,1100)",[category]);
  await legacy('制作費 A（架空）');let p=(await f.call('/expense-accounting/adoption-preview')).data;await f.post('/expense-accounting/adopt',{token:p.token,reason:'採用（架空）'});
  const n=(await f.db.get('SELECT COUNT(*) n FROM expense_category_versions')).n;
  await legacy('制作費 B（架空）');p=(await f.call('/expense-accounting/adoption-preview')).data;assert.ok(p.rows.find(r=>r.alias==='制作費 B(架空)').initialCategoryVersionId);
  await f.post('/expense-accounting/adopt',{token:p.token,reason:'追加（架空）'});assert.equal((await f.db.get('SELECT COUNT(*) n FROM expense_category_versions')).n,n);
  await legacy('未採用の費目（架空）');p=(await f.call('/expense-accounting/adoption-preview')).data;
  // 既存の直接費に対して科目分類の新しい版を不整合にする。
  const a=(await f.call('/expense-accounting/settings')).data.settings['account-classes'].find(c=>c.account_id===p.rows.find(r=>r.alias==='未採用の費目(架空)').accountId);
  await f.post('/expense-accounting/account-classes',{account_id:a.account_id,expectedVersion:a.version_no,normal_side:'credit',balance_class:'none',active:1,reason:'衝突の確認（架空）'});
  p=(await f.call('/expense-accounting/adoption-preview')).data;assert.ok(p.conflicts.length);assert.equal((await f.call('/expense-accounting/adopt',{token:p.token,reason:'採用（架空）'})).status,409);
 }finally{f.db.close();}
});

test('科目の名前に関係なく公開月一括の区分は公開まで資産に残し、公開月にだけ費用にする',()=>{
 const account={id:999,code:'DEMO-CUSTOM',name:'任意の費用（架空）',section:'sga',source:'manual'};
 const input={from:'2026-09',to:'2026-11',asOf:'2026-09',accounts:[...accounts,account],works:[{id:1,code:'DEMO-A',releaseMonth:'2026-10',releaseSource:'window'}],expenses:[{...mapped(1,'2026-09',200,'direct_cost'),accountId:999,accountName:account.name,section:'sga',systemKey:null,recognitionTiming:'release_month_once'}]};
 const r=buildPlBs(input);assert.deepEqual(r.workPl[0].monthly.map(m=>m.profit),[0,-200,0]);assert.deepEqual(r.workPl[0].monthly.map(m=>m.sga),[0,200,0]);assert.equal(value(r,'work_in_progress'),200);assert.equal(value(buildPlBs({...input,asOf:'2026-10'}),'work_in_progress'),0);
});
