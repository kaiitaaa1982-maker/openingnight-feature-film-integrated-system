import React,{useEffect,useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {dateTimeJst} from '../ui/format.mjs';
import {TAX_LABELS,STATUS_LABELS} from './work-master-model.mjs';
import './master-fields.css';

export function MasterField({label,value,onChange,type='text',options,required=false}) {
  return <label>{label}{options?<select aria-label={label} value={value??''} onChange={e=>onChange(e.target.value)} required={required}>{Object.entries(options).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>:<input aria-label={label} type={type} min={type==='number'?0:undefined} value={value??''} required={required} placeholder="未確認" onChange={e=>onChange(e.target.value)} />}</label>;
}
export function PartnerField({label,value,onChange,partners}) {
  return <MasterField label={label} value={value} onChange={onChange} options={{'':'未選択',...Object.fromEntries(partners.map(p=>[p.id,`${p.name}（${p.code}）`]))}} />;
}
export function MoneyFields({fields,draft,set,reference=false}) {
  return Object.entries(fields).map(([key,label])=><fieldset className="master-money" key={key} disabled={reference && ['production_cost','own_investment'].includes(key)}>
    <legend>{label}</legend>
    {reference && ['production_cost','own_investment'].includes(key)?<p>委員会の条件版の参照値を使います。</p>:<div className="master-grid">
      <MasterField label="金額（円）" type="number" value={draft[key+'_yen']} onChange={v=>set(key+'_yen',v)} />
      <MasterField label="税区分" value={draft[key+'_tax_basis']??(key==='own_investment'||key==='price_ex_tax'?'ex_tax':key==='price_inc_tax'?'inc_tax':'unknown')} options={key==='own_investment'||key==='price_ex_tax'?{ex_tax:'税別'}:key==='price_inc_tax'?{inc_tax:'税込'}:TAX_LABELS} onChange={v=>set(key+'_tax_basis',v)} />
      <MasterField label="確定状態" value={draft[key+'_status']??'unknown'} options={STATUS_LABELS} onChange={v=>set(key+'_status',v)} />
      <MasterField label="評価日" type="date" value={draft[key+'_as_of']} onChange={v=>set(key+'_as_of',v)} />
      <MasterField label="金額の根拠" value={draft[key+'_evidence']} onChange={v=>set(key+'_evidence',v)} />
    </div>}
  </fieldset>);
}
const draftOf=saved=>({...saved,source_reference:saved?.source_reference??'',reason:'',rows:saved?.rows??[]});
export function MasterVersionForm({title,path,saved,history=[],request,canEdit,children,onSaved,readHistory}) {
  const shell=useShell(),[draft,setDraft]=useState(()=>draftOf(saved)),[old,setOld]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  useEffect(()=>{setDraft(draftOf(saved));setOld(null);},[saved?.revision,path]);
  const dirty=JSON.stringify(draft)!==JSON.stringify(draftOf(saved)),id=`master-${path}`;
  useEffect(()=>{shell.registerUnsaved?.(id,dirty?1:0,title);return ()=>shell.registerUnsaved?.(id,0);},[dirty,id,shell.registerUnsaved,title]);
  const shown=old??draft,set=(k,v)=>setDraft(d=>({...d,[k]:v}));
  async function save(e) {
    e.preventDefault();setBusy(true);setError('');setMessage('');
    try {const result=await request(path,{method:'POST',body:JSON.stringify({...draft,baseRevision:saved?.revision??0})});setMessage(`第${result.revision}版を保存しました。`);await onSaved();}
    catch(e){setError(e.message||'保存できませんでした。入力を残しています。');}finally{setBusy(false);}
  }
  async function choose(revision) {
    if(!revision){setOld(null);return;}
    setBusy(true);setError('');
    try{setOld(await readHistory(revision));}catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <section className="master-section" aria-label={title}>
    <h3>{title}（{saved?`第${saved.revision}版`:'未登録'}）</h3>
    <label>版の履歴<select aria-label="版の履歴" disabled={busy||dirty} value={old?.revision??''} onChange={e=>choose(e.target.value)}><option value="">最新の内容</option>{history.map(v=><option key={v.revision} value={v.revision}>第{v.revision}版・{dateTimeJst(v.created_at)}・{v.reason}</option>)}</select></label>
    {old && <p>第{old.revision}版を閲覧中です。根拠：{old.source_reference}／改訂理由：{old.reason}</p>}
    {dirty && <p className="master-note">未保存の入力があります。履歴を見る前に保存するか、入力を戻してください。</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <form onSubmit={save} aria-label={`${title}の入力`}>
      <fieldset disabled={!canEdit||busy||Boolean(old)} className="master-form">
        {children(shown,set,setDraft)}
        <div className="master-grid">
          <MasterField label="出所・根拠" required value={shown.source_reference} onChange={v=>set('source_reference',v)} />
          <MasterField label="改訂理由" required value={shown.reason} onChange={v=>set('reason',v)} />
        </div>
        {canEdit && !old && <div className="on-form-actions"><button type="submit" disabled={busy}>新しい版として保存</button><button type="button" className="secondary" onClick={()=>setDraft(draftOf(saved))}>入力を戻す</button></div>}
      </fieldset>
    </form>
    {!canEdit && <p className="master-note">この作品・商品は閲覧のみです。</p>}
  </section>;
}
export function RowActions({index,rows,onChange}) {
  const move=delta=>{const next=[...rows];[next[index],next[index+delta]]=[next[index+delta],next[index]];onChange(next);};
  return <div className="on-form-actions"><button type="button" disabled={index===0} onClick={()=>move(-1)}>上へ</button><button type="button" disabled={index===rows.length-1} onClick={()=>move(1)}>下へ</button><button type="button" className="secondary" onClick={()=>onChange(rows.filter((_,n)=>n!==index))}>この行を外す</button></div>;
}
