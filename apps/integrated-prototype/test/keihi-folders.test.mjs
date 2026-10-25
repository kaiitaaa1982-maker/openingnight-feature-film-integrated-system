import test from 'node:test';
import assert from 'node:assert/strict';
import {setupExpense} from './req6-expense-fixture.mjs';
import {demoAccounting} from '../scripts/seed-expense-support.mjs';
import {lineChecks,invoiceChecks,expectedExTax,toX10000,fiscalMonths,distributionTotals,yearCells} from '../src/expense-sheet/keihi-model.mjs';
import {jstMonth} from '../src/expense-sheet/keihi-routes.mjs';

const line=(extra={})=>({work_id:1,distribution_type_code:'svod',item_type:'VOD-ENC',description:'HD エンコード（架空）',quantity:'120',unit_price:'150.00',actual_ex_tax:18000,tax_amount:1800,...extra});

test('税抜＝数量×単価は整数で掛けてから丸め、合わなければ理由が要る',()=>{
 assert.equal(expectedExTax(toX10000('48'),toX10000('12.50')),600);
 assert.equal(expectedExTax(toX10000('3'),toX10000('0.15')),0);// 0.45 は四捨五入で0
 assert.equal(expectedExTax(toX10000('3'),toX10000('0.17')),1);// 0.51 は1
 assert.equal(toX10000('1.234',{maxDecimals:2}),null);// 単価は小数第2位まで
 assert.ok(lineChecks(line()).every(c=>c.ok));
 const off=line({actual_ex_tax:17000,tax_amount:1700});assert.equal(lineChecks(off).find(c=>c.key==='qty_price').ok,false);
 assert.equal(lineChecks({...off,diff_reason:'値引き'}).find(c=>c.key==='qty_price').ok,true);
 for(const k of ['work_id','distribution_type_code','item_type','description','quantity','unit_price'])assert.equal(lineChecks(line({[k]:''})).find(c=>c.key==='required').ok,false,k);
 assert.equal(lineChecks(line({quantity:'0'})).find(c=>c.key==='required').ok,false);
});

test('原本の合計と明細の和・請求日の月・登録番号の形を検査する',()=>{
 const head={partner_id:1,invoice_on:'2026-10-15',project_id:1,category_version_id:1,tax_category_version_id:1,withholding_category_version_id:1};
 assert.equal(invoiceChecks({...head,original_total_inc_tax:19800},[line()],{month:'2026-10'}).ok,true);
 const r=invoiceChecks({...head,original_total_inc_tax:20460},[line()],{month:'2026-10'});assert.equal(r.ok,false);assert.match(r.checks.find(c=>c.key==='total').label,/差 660/);
 assert.equal(invoiceChecks({...head,original_total_inc_tax:19800},[line()],{month:'2026-09'}).checks.find(c=>c.key==='month').ok,false);
 assert.equal(invoiceChecks({...head,original_total_inc_tax:19800,registration_number:'T123'},[line()]).ok,false);
 assert.equal(invoiceChecks({...head,original_total_inc_tax:19800,registration_number:'T1234567890123'},[line()]).ok,true);
 assert.equal(invoiceChecks({...head},[line()]).ok,false);// 原本の合計が無い
});

test('年度は5月〜翌4月。マスと流通の合計は行から導く',()=>{
 assert.deepEqual([fiscalMonths(2026)[0],fiscalMonths(2026)[7],fiscalMonths(2026)[8],fiscalMonths(2026)[11]],['2026-05','2026-12','2027-01','2027-04']);
 const rows=[{accounting_month:'2026-10',actual_ex_tax:600,distribution_name:'配信・SVOD',category:'クラウド保管費'},{accounting_month:'2026-10',actual_ex_tax:125000,distribution_name:'劇場配給',category:'人件費（業務委託）'},{accounting_month:'2026-10',actual_ex_tax:30000,distribution_name:'劇場配給',category:'ポスター外注'}];
 const t=distributionTotals(rows);assert.deepEqual(t.map(x=>[x.name,x.count,x.ex_tax,x.labor_ex_tax]),[['劇場配給',2,155000,125000],['配信・SVOD',1,600,0]]);
 const cells=yearCells(2026,rows,[{month:'2026-11'}]);assert.deepEqual(cells.find(c=>c.month==='2026-10'),{month:'2026-10',registered:3,ex_tax:155600,pending:0,state:'registered'});assert.equal(cells.find(c=>c.month==='2026-11').state,'pending');
 assert.equal(jstMonth('2026-10-31 16:00:00'),'2026-11');assert.equal(jstMonth('2026-10-31 14:59:59'),'2026-10');
});

test('1通の登録は請求書・複数の明細・原本の結び付きを1回で書き、フォルダと経費集計シートに同じ額が出る',async(t)=>{const f=await setupExpense({t});try{
 const up=await f.post('/expense-source-files',{file_name:'ENC-1042（架空）.pdf',media_type:'application/pdf',original_base64:btoa('fictional invoice 1042'),reason:'確認（架空）'});
 const dup=await f.call('/expense-source-files',{file_name:'同じ.pdf',media_type:'application/pdf',original_base64:btoa('fictional invoice 1042'),reason:'確認（架空）'});assert.equal(dup.status,409);
 const month0=await f.call('/expense-folders/month?month='+jstMonth(new Date().toISOString()));assert.ok(month0.data.files.some(x=>x.id===up.id));
 const acc=demoAccounting(f.settings,'事務費',1);
 const body={project_id:1,file_id:up.id,original_total_inc_tax:22660,reason:'確認（架空）',accounting:{category_version_id:acc.category_version_id,tax_category_version_id:acc.tax_category_version_id,withholding_category_version_id:acc.withholding_category_version_id,withholding_yen:0,withholding_state:'confirmed'},
  invoice:{partner_id:f.settings.payee,invoice_number:'ENC-1042（架空）',document_kind:'invoice',invoice_on:'2026-10-15',closing_on:'2026-10-31',due_on:'2026-11-30',payment_method:'transfer'},
  lines:[line({actual_ex_tax:17000,tax_amount:1700,diff_reason:'値引き'}),line({item_type:'VOD-CLOUD',description:'クラウド保管（架空）',quantity:'48',unit_price:'12.50',actual_ex_tax:600,tax_amount:60}),line({item_type:'SHIP',description:'納品データ転送（架空）',quantity:'1',unit_price:'3000',actual_ex_tax:3000,tax_amount:300})]};
 const bad=await f.call('/expense-folders/register',{...body,original_total_inc_tax:22000});assert.equal(bad.status,400);assert.match(bad.data.error??JSON.stringify(bad.data),/合計/);
 const before=(await f.db.get('SELECT COUNT(*) n FROM expenses')).n;assert.equal((await f.call('/expense-folders/register',{...body,lines:[...body.lines,line({quantity:''})]})).status,400);assert.equal((await f.db.get('SELECT COUNT(*) n FROM expenses')).n,before);
 const ok=await f.post('/expense-folders/register',body);assert.equal(ok.expense_ids.length,3);
 assert.equal((await f.db.get('SELECT COUNT(*) n FROM expense_details WHERE invoice_id=?',[ok.invoice_id])).n,3);
 assert.equal((await f.db.get('SELECT file_id FROM expense_invoice_file_links WHERE invoice_id=?',[ok.invoice_id])).file_id,up.id);
 const d=await f.db.get('SELECT quantity_x10000,unit_price_x10000,distribution_type_code,memo FROM expense_details WHERE expense_id=?',[ok.expense_ids[0]]);assert.deepEqual({...d},{quantity_x10000:1200000,unit_price_x10000:1500000,distribution_type_code:'svod',memo:'差の理由: 値引き'});
 const month=await f.call('/expense-folders/month?month=2026-10');assert.equal(month.data.rows.length,3);assert.equal(month.data.rows.reduce((a,r)=>a+r.actual_ex_tax,0),20600);assert.equal(month.data.files.some(x=>x.id===up.id),false);
 assert.equal(month.data.rows.find(r=>r.category==='クラウド保管費').unit,'GB');
 const sheet=await f.call('/expense-sheet?month=2026-10');assert.equal(sheet.data.total,3);assert.equal(sheet.data.totals.actual_ex_tax.known,20600);
 const year=await f.call('/expense-folders/year?fy=2026');assert.equal(year.data.cells.find(c=>c.month==='2026-10').registered,3);
 const prod=await f.login('production@openingnight.invalid');assert.equal((await f.call('/expense-folders/month?month=2026-10',undefined,prod)).status,403);
}finally{await f.close?.();}});

test('置いた月・外す・月の締め: 要入力が残ると締められず、締めのあとに置くと「締めのあとに追加」になる。記録は変えも消しもできない',async(t)=>{const f=await setupExpense({t});try{
 const up=async text=>(await f.post('/expense-source-files',{file_name:text+'.pdf',media_type:'application/pdf',original_base64:btoa(text),reason:'確認（架空）'})).id;
 const a=await up('fictional placement A'),b=await up('fictional placement B');
 await f.post('/expense-folders/place',{file_id:a,month:'2026-09'});await f.post('/expense-folders/place',{file_id:b,month:'2026-09'});
 let m=await f.call('/expense-folders/month?month=2026-09');assert.deepEqual(m.data.files.map(x=>x.id).sort(),[a,b].sort());
 assert.equal((await f.call('/expense-folders/close',{month:'2026-09'})).status,409);
 assert.equal((await f.call(`/expense-folders/files/${a}/remove`,{})).status,400);// 理由が要る
 await f.post(`/expense-folders/files/${a}/remove`,{reason:'宣伝の校正紙（架空）'});
 await f.post('/expense-folders/place',{file_id:b,month:'2026-08'});// 置き直し
 m=await f.call('/expense-folders/month?month=2026-09');assert.equal(m.data.files.length,0);assert.deepEqual(m.data.removed.map(x=>x.id),[a]);
 assert.deepEqual((await f.call('/expense-folders/month?month=2026-08')).data.files.map(x=>x.id),[b]);
 await f.post('/expense-folders/close',{month:'2026-09'});m=await f.call('/expense-folders/month?month=2026-09');assert.equal(m.data.closure.state,'closed');
 await new Promise(r=>setTimeout(r,1100));const c=await up('fictional placement C');await f.post('/expense-folders/place',{file_id:c,month:'2026-09'});
 m=await f.call('/expense-folders/month?month=2026-09');assert.equal(m.data.closure.state,'after');
 const y=await f.call('/expense-folders/year?fy=2026');assert.equal(y.data.cells.find(x=>x.month==='2026-09').closure,'after');
 for(const [sql,params] of [['UPDATE expense_month_closures SET reason=?',['x']],['DELETE FROM expense_file_placements WHERE file_id=?',[a]],['UPDATE expense_file_placement_voids SET reason=?',['x']]])await assert.rejects(f.db.run(sql,params),/immutable/,sql);
 await assert.rejects(f.db.run("INSERT INTO expense_file_placements(id,org_id,file_id,placed_month,reason,created_by) VALUES(999,1,?,'2026-09','二重（架空）',1)",[c]),/duplicate expense file placement/);
 await assert.rejects(f.db.run("INSERT INTO expense_month_closures(id,org_id,month,kind,file_count,reason,created_by) VALUES(998,1,'2026-13','close',0,'形（架空）',1)"),/CHECK|check constraint/i);
 const prod=await f.login('production@openingnight.invalid');assert.equal((await f.call('/expense-folders/close',{month:'2026-10'},prod)).status,403);
}finally{await f.close?.();}});
