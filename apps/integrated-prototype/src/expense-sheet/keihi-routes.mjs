// 経費管理のフォルダ（販売の経費）の受け口。会社ルート plans/2026-10-22-folder-keihi.md。
// 既存の経費の表と書き込み（makeExpense）を使い、新しい表は持たない（置いた月・外す・月の締めの表は移行のあとに足す）。
import {readSheet,filterSheet} from './sheet-model.mjs';
import {insert,newId} from './expense-service.mjs';
import {fail,integer,str} from './expense-model.mjs';
import * as store from './keihi-store.mjs';
import {SALES_ITEM_TYPES,DIFF_REASONS,TAX_RATES,itemType,toX10000,assertRegistrable,distributionTotals,yearCells,fiscalMonths} from './keihi-model.mjs';

const MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
export function registerKeihiRoutes(app,s,{wrap,input,identity}){
 const db=s.db;
 // 請求書に結んでいない原本（取込の束に使ったものを除く）。結ぶ前の原本は置いた人と管理者だけに見せる（fileAccess と同じ）。
 // 月は有効な置き場所（expense_file_placements）の月。置き場所が無ければ受け取った日（日本の時刻）の月。外した原本は removed に分ける。
 async function unlinkedFiles(i){const rows=await store.unlinkedFiles(db,i.org_id);
  return rows.filter(f=>f.created_by===i.user_id||i.role==='admin').map(f=>{const removed=!f.placed_month&&f.removed_reason!=null;return {...f,removed,month:f.placed_month??(removed?f.last_month:null)??jstMonth(f.created_at)};});}
 const closures=i=>store.closures(db,i.org_id);
 const placedAfter=(i,month,since)=>store.placedAfter(db,i.org_id,month,since);
 const rowsFor=async i=>filterSheet(await readSheet(s,i),{});
 app.get('/api/expense-folders/options',wrap(async c=>{const i=identity(c),ids=await s.finance(i);const opt=await store.folderOptions(db,i.org_id,ids);
  return c.json({ok:true,itemTypes:SALES_ITEM_TYPES,diffReasons:DIFF_REASONS,taxRates:TAX_RATES,distributionTypes:opt.distributionTypes,products:opt.products});}));
 app.get('/api/expense-folders/year',wrap(async c=>{const i=identity(c),fy=integer(Number(c.req.query('fy')),2000,2100);const rows=await rowsFor(i),files=(await unlinkedFiles(i)).filter(f=>!f.removed),cl=await closures(i);const cells=[];for(const c0 of yearCells(fy,rows,files)){const last=cl.filter(x=>x.month===c0.month).at(-1);cells.push({...c0,closure:last?.kind==='close'?((await placedAfter(i,c0.month,last.created_at))||c0.pending?'after':'closed'):null});}return c.json({ok:true,fy,months:fiscalMonths(fy),cells});}));
 app.get('/api/expense-folders/month',wrap(async c=>{const i=identity(c),month=c.req.query('month');if(!MONTH.test(month??''))fail('月は YYYY-MM で指定してください');const rows=(await rowsFor(i)).filter(r=>r.accounting_month===month);const all=(await unlinkedFiles(i)).filter(f=>f.month===month),files=all.filter(f=>!f.removed),removed=all.filter(f=>f.removed),last=(await closures(i)).filter(x=>x.month===month).at(-1);const closure=last?.kind==='close'?{...last,state:(await placedAfter(i,month,last.created_at))||files.length?'after':'closed'}:null;
  return c.json({ok:true,month,files,removed,closure,rows:rows.map(r=>({id:r.id,invoice_id:r.invoice_id,invoice_on:r.invoice_on,partner_name:r.partner_name,distribution_name:r.distribution_name,work_code:r.work_code,product_code:r.product_code,category:r.category,unit:itemType(r.category)?.unit??null,quantity:r.quantity,unit_price:r.unit_price,actual_ex_tax:r.actual_ex_tax,tax_amount:r.tax_amount,description:r.description,status:r.status,due_on:r.due_on,paid_on:r.paid_on})),totals:distributionTotals(rows)});}));
 // 置く: 受け取った原本をこの月のフォルダに置く（置き直すときは前の置き場所を外してから）。
 app.post('/api/expense-folders/place',wrap(async c=>{const i=identity(c),b=await input(c);await s.finance(i);const month=String(b.month??'');if(!MONTH.test(month))fail('月は YYYY-MM で指定してください');const file=integer(b.file_id,1),f=await s.ref(i,'expense_source_files',file);if(f.created_by!==i.user_id&&i.role!=='admin')fail('この原本を置く権限がありません',403);
  const reason=str(b.reason,1000)??`経費のフォルダ ${month} に置いた`,statements=[];const active=await store.activePlacement(db,i.org_id,file);
  if(active)statements.push(insert('expense_file_placement_voids',{placement_id:active.id,...s.meta(i,{reason:`${month} へ置き直した`})}));const id=newId();statements.push(insert('expense_file_placements',{id,file_id:file,placed_month:month,...s.meta(i,{reason})}),s.audit(i,'expense_file_placement',id,{reason}));await s.batch(statements);return c.json({ok:true,id},201);}));
 // 外す: 経費の原本ではないと理由つきで外す（原本は消さない）。
 app.post('/api/expense-folders/files/:id/remove',wrap(async c=>{const i=identity(c),b=await input(c);await s.finance(i);const file=integer(Number(c.req.param('id')),1),f=await s.ref(i,'expense_source_files',file);if(f.created_by!==i.user_id&&i.role!=='admin')fail('この原本を外す権限がありません',403);const reason=str(b.reason,1000,true);
  if(await store.isFileLinked(db,i.org_id,file))fail('登録済みの原本は外せません。請求書の取消を使ってください',409);
  let active=await store.activePlacement(db,i.org_id,file);const statements=[];
  if(!active){active={id:newId()};statements.push(insert('expense_file_placements',{id:active.id,file_id:file,placed_month:jstMonth(f.created_at),...s.meta(i,{reason:'外すために受け取った月に置いた'})}));}
  statements.push(insert('expense_file_placement_voids',{placement_id:active.id,...s.meta(i,{reason})}),s.audit(i,'expense_file_remove',file,{reason}));await s.batch(statements);return c.json({ok:true},201);}));
 // 月の締め: 要入力が0件のときだけ。会計の締めではない（受領が揃ったという記録）。
 app.post('/api/expense-folders/close',wrap(async c=>{const i=identity(c),b=await input(c);await s.finance(i);const month=String(b.month??'');if(!MONTH.test(month))fail('月は YYYY-MM で指定してください');const kind=b.kind==='reopen'?'reopen':'close';const reason=str(b.reason,1000)??(kind==='close'?`${month} の受領が揃った`:`${month} の締めを開け直す`);
  const all=(await unlinkedFiles(i)).filter(f=>f.month===month),pending=all.filter(f=>!f.removed);if(kind==='close'&&pending.length)fail(`要入力の原本が ${pending.length} 件あるので締められません`,409);
  const registered=(await rowsFor(i)).filter(r=>r.accounting_month===month).length,id=newId();await s.batch([insert('expense_month_closures',{id,month,kind,file_count:registered+all.length,...s.meta(i,{reason})}),s.audit(i,'expense_month_closure',id,{reason})]);return c.json({ok:true,id},201);}));
 // 1通の登録: 請求書・版・明細の行（複数）・原本の結び付きを1回で書く。検査は画面と同じ関数で通す。
 app.post('/api/expense-folders/register',wrap(async c=>{const i=identity(c),b=await input(c);const lines=Array.isArray(b.lines)?b.lines:[];if(!lines.length||lines.length>50)fail('明細の行は1〜50行で指定してください');
  const draft={...b.invoice,project_id:b.project_id,category_version_id:b.accounting?.category_version_id,tax_category_version_id:b.accounting?.tax_category_version_id,withholding_category_version_id:b.accounting?.withholding_category_version_id,original_total_inc_tax:b.original_total_inc_tax,registration_number:b.registration_number};
  assertRegistrable(draft,lines);const project=integer(b.project_id,1);await s.finance(i,project);
  const file=b.file_id==null?null:integer(b.file_id,1);if(file){const f=await s.ref(i,'expense_source_files',file);if(f.created_by!==i.user_id&&i.role!=='admin')fail('この原本を結ぶ権限がありません',403);}
  const reason=str(b.reason,1000)??'経費のフォルダから登録';const month=b.invoice.invoice_on.slice(0,7);
  const stamps=[],statements=[];let invoiceId=null,next=await store.nextExpenseId(db);const created=[];
  for(const [n,l] of lines.entries()){const t=itemType(l.item_type),q=toX10000(l.quantity),p=toX10000(l.unit_price,{maxDecimals:2});
   const memo=[l.diff_reason?`差の理由: ${l.diff_reason}`:null,str(l.memo,900)].filter(Boolean).join('／')||null;
   const payload={project_id:project,work_id:integer(l.work_id,1),partner_id:integer(b.invoice.partner_id,1),incurred_on:b.invoice.invoice_on,accounting_month:month,category:t.name,description:str(l.description,1000,true),actual_ex_tax:l.actual_ex_tax,tax_amount:l.tax_amount,actual_inc_tax:l.actual_ex_tax+l.tax_amount,reason,
    accounting:{...b.accounting,expectedVersion:0,reason},details:{recorded_on:b.invoice.invoice_on,distribution_type_code:str(l.distribution_type_code,60,true),product_id:l.product_id==null||l.product_id===''?null:integer(Number(l.product_id),1),specification:str(l.specification,1000),memo,quantity_x10000:q,unit_price_x10000:p,source_client_name:str(b.invoice.partner_text,240)},
    ...(n===0?{invoice:{...b.invoice,code:str(b.invoice.code,60)??`KH-${b.invoice.invoice_on}-${newId().toString(36)}`,partner_id:undefined,partner_text:undefined,expectedVersion:0,reason}}:{invoice_id:invoiceId,expectedVersion:1})};
   const prepared=await s.makeExpense(i,payload,{prepare:true,preparedId:next++,preparedInvoice:n===0?null:{id:invoiceId,partner_id:payload.partner_id}});stamps.push(prepared.statements.shift());statements.push(...prepared.statements);invoiceId=prepared.invoice_id;created.push(prepared.id);}
  if(file)statements.push(insert('expense_invoice_file_links',{id:newId(),invoice_id:invoiceId,file_id:file,purpose:b.invoice.document_kind==='receipt'?'receipt':'invoice',...s.meta(i,{reason})}));
  await s.batch([...stamps,...statements]);return c.json({ok:true,invoice_id:invoiceId,expense_ids:created},201);}));
}
// created_at は UTC で入る（CURRENT_TIMESTAMP）。フォルダの月は日本の時刻で決める。
export function jstMonth(created){const t=Date.parse(String(created).replace(' ','T')+(String(created).includes('Z')||/[+-]\d\d:?\d\d$/.test(created)?'':'Z'));if(Number.isNaN(t))return null;return new Date(t+9*3600000).toISOString().slice(0,7);}
