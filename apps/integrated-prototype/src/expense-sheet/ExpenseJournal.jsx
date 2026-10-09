import React,{useEffect,useState} from 'react';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {Field,opts,today} from './ExpenseFields.jsx';
export function ExpenseJournal({request,options,work}){
 const [filters,setFilters]=useState({from:'',to:today(),workId:work?.id??'',partnerId:''}),[result,setResult]=useState({});
 const query=new URLSearchParams(Object.entries(filters).filter(([,v])=>v!==''));
 useEffect(()=>{let live=true;request('/expense-journal?'+query).then(r=>live&&setResult(r)).catch(error=>live&&setResult({error}));return()=>{live=false;};},[request,query.toString()]);
 const field=(key,label,type,options)=><Field label={label} type={type} options={options} value={filters[key]} onChange={v=>setFilters({...filters,[key]:v})}/>;
 return <section className="card stack" aria-label="仕訳の見え方"><h3>仕訳の見え方</h3><p>明細・出金・取消の記録からその都度計算します。仕訳として保存する操作はありません。</p>
 <div className="es-fields">{field('from','仕訳の開始日','date')}{field('to','仕訳の終了日','date')}{field('workId','仕訳の作品','text',opts(options.works,'title'))}{field('partnerId','仕訳の取引先','text',opts(options.partners))}</div>
 {result.error&&<Notice error={result.error}/>}<p>借方合計 {(result.debitYen??0).toLocaleString('ja-JP')}円／貸方合計 {(result.creditYen??0).toLocaleString('ja-JP')}円／未整備 {result.unready?.length??0}件</p>
 <DataGrid ariaLabel="仕訳の一覧" columns={[{key:'on',label:'日付'},{key:'account_name',label:'勘定科目'},{key:'debit',label:'借方',type:'yen'},{key:'credit',label:'貸方',type:'yen'},{key:'source',label:'元の記録',render:r=><>{r.expense_id&&<a href={`?p=expense-sheet&expenseId=${r.expense_id}`}>明細 {r.expense_id}</a>} {r.payment_id&&<a href={`?p=expense-sheet&expenseId=${r.expense_id}#payment-${r.payment_id}`}>支払 {r.payment_id}</a>} {r.invoice_id&&<a href={`?p=expense-sheet&invoiceId=${r.invoice_id}`}>請求書 {r.invoice_id}</a>}</>}]} rows={(result.rows??[]).flatMap((r,n)=>r.lines.map((l,j)=>({...r,...l,id:`${n}:${j}`,debit:l.side==='debit'?l.amount_yen:null,credit:l.side==='credit'?l.amount_yen:null})))} rowKey="id" showTotals={false}/>
 </section>;
}
