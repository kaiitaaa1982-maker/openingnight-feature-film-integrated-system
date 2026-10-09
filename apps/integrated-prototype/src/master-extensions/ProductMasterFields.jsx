import React,{useEffect,useState} from 'react';
import {MasterField,PartnerField,MoneyFields,MasterVersionForm} from './MasterVersionForm.jsx';
import {PRODUCT_FIELDS,PRODUCT_MONEY_FIELDS} from './product-master-model.mjs';
export function ProductMasterFields({product,request,readOnly=false}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[reload,setReload]=useState(0),path=`/product-master/${product.id}`;
  useEffect(()=>{let live=true;request(path).then(r=>{if(live){setData(r);setError('');}}).catch(e=>{if(live)setError(e.message);});return ()=>{live=false;};},[path,request,reload]);
  if(!data) return <p>{error||'商品の仕様を読み込んでいます。'}{error&&<button onClick={()=>setReload(n=>n+1)}>再読込</button>}</p>;
  return <MasterVersionForm title={`商品の仕様：${product.name}（${product.sku}）`} path={path} saved={data.profile} history={data.history} request={request} canEdit={data.canEdit&&!readOnly} onSaved={async()=>setData(await request(path))} readHistory={async revision=>(await request(`${path}?revision=${revision}`)).profile}>
    {(draft,set)=><><p className="master-note">品番は商品コードと別に管理します。JANは先頭の0を含めた文字列で入力します。商品固有の権利元表記は作品の権利元と異なる場合に記入します。</p>
      <div className="master-grid">{Object.entries(PRODUCT_FIELDS).map(([k,label])=>k.endsWith('_partner_id')?<PartnerField key={k} label={label} value={draft[k]} onChange={v=>set(k,v)} partners={data.partners} />:<MasterField key={k} label={label} value={draft[k]} onChange={v=>set(k,v)} type={k.endsWith('_on')?'date':['disc_count','runtime_minutes'].includes(k)?'number':'text'} />)}</div>
      {data.canFinance && <MoneyFields fields={PRODUCT_MONEY_FIELDS} draft={draft} set={set} />}
    </>}
  </MasterVersionForm>;
}
