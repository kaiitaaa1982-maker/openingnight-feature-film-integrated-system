import React,{useEffect,useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {MasterField,PartnerField,MoneyFields,MasterVersionForm,RowActions} from './MasterVersionForm.jsx';
import {WORK_FIELDS,MONEY_FIELDS,CONTRACT_TYPES} from './work-master-model.mjs';
const yen=v=>v==null?'未確認':`${v.toLocaleString('ja-JP')}円`;
export function WorkMasterFields({workId,request,readOnly=false}) {
  const shell=useShell(),[data,setData]=useState(null),[error,setError]=useState(''),[reload,setReload]=useState(0);
  useEffect(()=>{let live=true;request(`/work-master/${workId}`).then(r=>{if(live){setData(r);setError('');}}).catch(e=>{if(live)setError(e.message);});return ()=>{live=false;};},[workId,request,reload]);
  const refresh=async()=>{const r=await request(`/work-master/${workId}`);setData(r);};
  if(!data) return <section>{error?<p role="alert">{error}<button onClick={()=>setReload(n=>n+1)}>再読込</button></p>:<p>契約・費用・権利元・仕様を読み込んでいます。</p>}</section>;
  const common=section=>({path:`/work-master/${workId}/${section}`,saved:data.sections[section],history:data.history[section],request,canEdit:data.canEdit&&!readOnly,onSaved:refresh,readHistory:async revision=>(await request(`/work-master/${workId}/${section}?revision=${revision}`)).version});
  return <div className="master-fields">
    <MasterVersionForm title="契約" {...common('contracts')}>{(draft,set)=><>
      <p className="master-note">締結日・開始日・終了日を分けて記録します。分からない日付は空欄にします。</p>
      {(draft.rows??[]).map((row,n)=>{const update=(k,v)=>set('rows',draft.rows.map((r,j)=>j===n?{...r,[k]:v}:r));return <article className="master-row" key={row.contract_key}>
        <h4>契約 {n+1}</h4><div className="master-grid">
          <MasterField label="契約名" value={row.title} onChange={v=>update('title',v)} required />
          <MasterField label="契約の種類" value={row.kind} options={CONTRACT_TYPES} onChange={v=>update('kind',v)} />
          <PartnerField label="契約の相手" value={row.partner_id} partners={data.partners} onChange={v=>update('partner_id',v)} />
          {[['signed_on','締結日'],['starts_on','開始日'],['ends_on','終了日']].map(([k,label])=><MasterField key={k} label={label} type="date" value={row[k]} onChange={v=>update(k,v)} />)}
          <MasterField label="根拠の文書" required value={row.document_reference} onChange={v=>update('document_reference',v)} />
        </div><RowActions index={n} rows={draft.rows} onChange={v=>set('rows',v)} />
      </article>;})}
      <button type="button" onClick={()=>set('rows',[...draft.rows,{contract_key:crypto.randomUUID(),kind:'acquisition',title:'',partner_id:'',document_reference:''}])}>契約を追加</button>
    </>}</MasterVersionForm>
    {data.mg_links?.length>0 && <section><h4>MG契約（既存の契約を参照）</h4>{data.mg_links.map(m=><p key={`${m.kind}-${m.id}`}>{m.code}・{m.title}／契約日 {m.contract_date}</p>)}<button type="button" onClick={()=>shell.navigate('MG契約・台帳')}>MG契約・台帳を開く</button></section>}
    {data.canFinance && <>
      <MasterVersionForm title="費用" {...common('finance')}>{(draft,set,setDraft)=><>
        <p className="master-note">空欄は未確認、0は0円です。総製作費に宣伝費は含めません。予算はPLに転記しません。</p>
        <MasterField label="委員会の参照条件版" value={draft.committee_term_version_id} options={{'':'参照なし',...Object.fromEntries((data.committee_references??[]).map(r=>[r.term_version_id,`${r.title}・第${r.version_no}版`]))}} onChange={v=>setDraft(d=>({...d,committee_term_version_id:v,...(v?{production_cost_yen:null,production_cost_status:'unknown',production_cost_as_of:null,production_cost_evidence:null,own_investment_yen:null,own_investment_status:'unknown',own_investment_as_of:null,own_investment_evidence:null}:{})}))} />
        <MoneyFields fields={MONEY_FIELDS} draft={draft} set={set} reference={Boolean(draft.committee_term_version_id)} />
      </>}</MasterVersionForm>
      {data.warnings?.map(w=><p role="alert" key={w}>{w}</p>)}
      <section className="master-totals" aria-label="費用の参照と集計"><h4>保存済みの予算と現在の実績</h4>
        <p>総事業費：{yen(data.finance_totals.total_project_cost_yen)}（総製作費＋宣伝予算。同じ税区分で確認できる場合のみ）</p>
        <p>宣伝費の実績：税別 {yen(data.finance_totals.promotion_actual_ex_tax)}／税込 {yen(data.finance_totals.promotion_actual_inc_tax)}（記録済み {data.finance_totals.promotion_expense_count}件）</p>
        <p>宣伝予算の残額：{yen(data.finance_totals.promotion_budget_remaining_yen)}</p>
        {(data.committee_references??[]).map(r=><details key={r.term_version_id}><summary>{r.title}・第{r.version_no}版（参照値・税区分未確認）</summary><p>製作費：{yen(r.production_cost_yen)}／自社の出資額：{yen(r.own_investment_yen)}</p>{r.investors.map(p=><p key={p.partner_id}>{p.name}：{yen(p.amount_yen)}</p>)}</details>)}
      </section>
    </>}
    <MasterVersionForm title="権利元" {...common('rights')}>{(draft,set)=><>
      {(draft.rows??[]).map((row,n)=>{const update=(k,v)=>set('rows',draft.rows.map((r,j)=>j===n?{...r,[k]:v}:r));return <article className="master-row" key={n}><h4>権利元 {n+1}</h4><div className="master-grid">
        <PartnerField label="取引先から選ぶ" value={row.partner_id} partners={data.partners} onChange={v=>update('partner_id',v)} />
        {[['name','名前・表記'],['role','役割（権利元・原権利元・原作者など）'],['rights_scope','権利の範囲（任意）'],['notes','権利元の備考'],['evidence','根拠']].map(([k,label])=><MasterField key={k} label={label} value={row[k]} onChange={v=>update(k,v)} />)}
      </div><RowActions index={n} rows={draft.rows} onChange={v=>set('rows',v)} /></article>;})}
      <button type="button" onClick={()=>set('rows',[...draft.rows,{name:'',role:'権利元',evidence:''}])}>権利元を追加</button>
    </>}</MasterVersionForm>
    <MasterVersionForm title="作品の仕様" {...common('profile')}>{(draft,set)=><>
      <p className="master-note">フリガナ・英題は「提案資料に出す作品情報」、あらすじ・クレジット・映像版は上の「作品情報」で管理します。各権利処理の記載は契約済みとの自動判定には使いません。</p>
      <div className="master-grid">{Object.entries(WORK_FIELDS).map(([k,label])=><MasterField key={k} label={label} value={draft[k]??(k==='registration_state'?'unconfirmed':k==='work_kind'?'work':'')} options={k==='registration_state'?{unconfirmed:'未確認',provisional:'仮登録',confirmed:'確認済み'}:k==='work_kind'?{work:'作品',aggregate:'集約',unresolved:'未同定'}:undefined} onChange={v=>set(k,v)} />)}</div>
    </>}</MasterVersionForm>
  </div>;
}
