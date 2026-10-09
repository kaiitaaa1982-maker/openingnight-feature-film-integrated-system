import {buildMgReport} from './rights-reports.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const metrics=['eligibleYen','appliedYen','overageYen','recognizedYen'];
const periods=['prior','current','cumulative'];
const blank=()=>Object.fromEntries(metrics.map(key=>[key,0]));
const monthOf=value=>{
 const month=String(value||'');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw fail('計上月はYYYY-MMで指定してください');
 return month;
};
const safe=value=>{
 const integer=typeof value==='bigint'?value:BigInt(value);
 if(integer>BigInt(Number.MAX_SAFE_INTEGER)||integer<BigInt(Number.MIN_SAFE_INTEGER))throw fail('MG集計が安全な整数円の範囲を超えています',409);
 return Number(integer);
};
const total=(rows,key)=>safe(rows.reduce((sum,row)=>sum+BigInt(row[key]??0),0n));
function sumPeriods(rows){return Object.fromEntries(periods.map(period=>[period,Object.fromEntries(metrics.map(key=>[key,total(rows.map(row=>row[period]),key)]))]));}
function reachedMonth(entries,column,guarantee){
 if(guarantee===0)return null;
 const buckets=new Map();
 for(const entry of entries)buckets.set(entry.accounting_month,(buckets.get(entry.accounting_month)||0n)+BigInt(entry[column]));
 let running=0n;
 for(const [month,amount] of [...buckets].sort(([a],[b])=>a.localeCompare(b))){running+=amount;if(running>=BigInt(guarantee))return month;}
 return null;
}
function rollup(contracts){
 const guaranteeYen=total(contracts,'guaranteeYen'),values=sumPeriods(contracts);
 return {contractCount:contracts.length,guaranteeYen,...values,
  remainingAppliedYen:total(contracts,'remainingAppliedYen'),exceedAppliedYen:total(contracts,'exceedAppliedYen'),
  eligibleDifferenceYen:safe(BigInt(guaranteeYen)-BigInt(values.cumulative.eligibleYen)),
  appliedRate:guaranteeYen?values.cumulative.appliedYen/guaranteeYen:null,
  eligibleRate:guaranteeYen?values.cumulative.eligibleYen/guaranteeYen:null,
  unverifiedCount:total(contracts,'unverifiedCount')};
}

/** Each item contains one contract and all its immutable versions and ledger rows. */
export function buildMgPortfolio({direction,accountingMonth,contracts,works=[]}){
 if(!['incoming','outgoing'].includes(direction))throw fail('受取MGか支払MGを選択してください');
 const month=monthOf(accountingMonth),seen=new Set(),rows=[];
 let notStartedCount=0;
 for(const item of contracts){
  if(item.direction!==direction)throw fail('受取MGと支払MGは別々に集計してください',409);
  const key=Number(item.contract.id);
  if(seen.has(key))throw fail('同じMG契約が重複しています',409);
  seen.add(key);
  const selected=item.versions.filter(v=>v.starts_on&&v.starts_on.slice(0,7)<=month).sort((a,b)=>b.version-a.version||b.id-a.id)[0];
  if(!selected){notStartedCount++;continue;}
  const report=buildMgReport({...item,direction,selectedVersionId:selected.id,accountingMonth:month});
  const effectiveIds=new Set(report.sourceEntryIds.map(Number));
  // Reuse the individual report's correction resolution, including corrections posted in later months.
  const sourceEntries=item.ledger.filter(entry=>effectiveIds.has(Number(entry.id))).map(entry=>({...entry}));
  const values=sumPeriods(report.rows),guaranteeYen=report.headline.guaranteeYen;
  const party=item.party||{id:direction==='incoming'?item.contract.partner_id:item.contract.supplier_id,code:'',name:'名称未確認'};
  rows.push({contractId:key,code:item.contract.code,title:item.contract.title,sourceReference:item.contract.source_reference,
   party:{id:Number(party.id),code:party.code,name:party.name,type:direction==='incoming'?'partner':'supplier'},
   termVersionId:selected.id,termVersion:selected.version,mode:selected.mode,startsOn:selected.starts_on,endsOn:selected.ends_on,
   guaranteeYen,...values,remainingAppliedYen:report.headline.contractRemainingYen,exceedAppliedYen:report.headline.appliedExceedYen,
   eligibleDifferenceYen:safe(BigInt(guaranteeYen)-BigInt(values.cumulative.eligibleYen)),
   appliedRate:guaranteeYen?values.cumulative.appliedYen/guaranteeYen:null,eligibleRate:guaranteeYen?values.cumulative.eligibleYen/guaranteeYen:null,
   appliedReachedMonth:reachedMonth(sourceEntries,'applied_recoup_yen',guaranteeYen),
   eligibleReachedMonth:reachedMonth(sourceEntries,'reported_eligible_yen',guaranteeYen),
   remainingIndicative:report.headline.remainingIndicative,unverifiedCount:report.unverifiedCount,warnings:report.warnings,
   rows:report.rows.map(row=>({...row,workName:works.find(work=>Number(work.id)===Number(row.workId))?.title||`作品 ${row.workId}`})),
   sourceEntries,sourceEntryIds:report.sourceEntryIds});
 }
 rows.sort((a,b)=>a.party.code.localeCompare(b.party.code)||a.party.id-b.party.id||a.code.localeCompare(b.code)||a.contractId-b.contractId);
 const parties=new Map();
 for(const row of rows){const key=`${row.party.type}:${row.party.id}`;if(!parties.has(key))parties.set(key,{...row.party,contracts:[]});parties.get(key).contracts.push(row);}
 return {kind:'mg_portfolio',direction,accountingMonth:month,generatedAt:new Date().toISOString(),knowledgeBasis:'current_known_corrections',
  versionPolicy:'基準月末までに開始した条件版のうち、版番号が最大の保証額を契約ごとに一度使用。終了済み契約の履歴も含む。',
  reachPolicy:'現在判明している訂正を反映し、選択した保証額に基準月までの累計が初めて到達した月。過去時点の契約判断の再現ではない。',
  totals:rollup(rows),parties:[...parties.values()].map(({contracts,...party})=>({...party,...rollup(contracts),contractIds:contracts.map(c=>c.contractId)})),
  contracts:rows,notStartedCount,warnings:[
   '受取MGと支払MGは相殺せず、別集計。保証額・計上額は実際の入出金を意味しません。',
   '未消化残高は実充当で計算。消化対象との差額・到達率は別の参考指標です。',
   '到達率は保証額0円では算出せず、クロス契約の商品別残高は算出しません。',
   ...(notStartedCount?[`基準月までに開始した条件版がない${notStartedCount}契約は集計対象外です。`]:[])
  ]};
}

export function registerMgPortfolioRoutes(app,{db,bad,settlementWork}){
 app.get('/api/rights-reports/mg-portfolio',async c=>{
  try{
   const identity=c.get('identity');
   if(!identity||identity.role==='production')throw fail('MG集計の財務権限がありません',403);
   const direction=String(c.req.query('direction')||'incoming'),accountingMonth=monthOf(c.req.query('month'));
   if(!['incoming','outgoing'].includes(direction))throw fail('受取MGか支払MGを選択してください');
   const partyId=c.req.query('partyId')?Number(c.req.query('partyId')):null;
   if(partyId!==null&&(!Number.isSafeInteger(partyId)||partyId<1))throw fail('取引先を確認してください');
   const contractField=`${direction}_contract_id`,partyField=direction==='incoming'?'partner_id':'supplier_id',partyTable=direction==='incoming'?'partners':'mg_suppliers';
   const [contracts,versions,versionProducts,ledger,mappings,products,parties,works]=await Promise.all([
    db.all(`SELECT * FROM mg_${direction}_contracts WHERE org_id=?`,[identity.org_id]),
    db.all(`SELECT * FROM mg_term_versions WHERE org_id=? AND ${contractField} IS NOT NULL`,[identity.org_id]),
    db.all('SELECT * FROM mg_version_products WHERE org_id=?',[identity.org_id]),
    db.all(`SELECT l.* FROM mg_ledger_entries l JOIN mg_term_versions v ON v.org_id=l.org_id AND v.id=l.term_version_id WHERE l.org_id=? AND v.${contractField} IS NOT NULL ORDER BY l.id`,[identity.org_id]),
    db.all('SELECT * FROM product_works WHERE org_id=?',[identity.org_id]),
    db.all('SELECT id,sku,name FROM products WHERE org_id=?',[identity.org_id]),
    db.all(`SELECT id,code,name FROM ${partyTable} WHERE org_id=?`,[identity.org_id]),
    db.all('SELECT id,title FROM works WHERE org_id=?',[identity.org_id])
   ]);
   const allowed=[],access=new Map();
   for(const contract of contracts){
    if(partyId!==null&&Number(contract[partyField])!==partyId)continue;
    const terms=versions.filter(v=>v[contractField]===contract.id).map(v=>({...v,products:versionProducts.filter(p=>p.term_version_id===v.id)}));
    const ids=new Set(terms.map(v=>v.id)),productIds=new Set(terms.flatMap(v=>v.products.map(p=>p.product_id)));
    const allocation=mappings.filter(m=>productIds.has(m.product_id));
    let canRead=true;
    for(const workId of new Set(allocation.map(m=>m.work_id))){if(!access.has(workId))access.set(workId,Boolean(await settlementWork(identity,workId)));if(!access.get(workId))canRead=false;}
    // An incomplete mapping must not let a contract bypass work-level authorization.
    if(!canRead||!productIds.size||[...productIds].some(id=>!allocation.some(m=>m.product_id===id)))continue;
    allowed.push({direction,contract,versions:terms,ledger:ledger.filter(l=>ids.has(l.term_version_id)),mappings:allocation,
     products:products.filter(p=>productIds.has(p.id)),party:parties.find(p=>p.id===contract[partyField])});
   }
   return c.json({ok:true,report:buildMgPortfolio({direction,accountingMonth,contracts:allowed,works})});
  }catch(error){return bad(c,error.message,error.status||500,undefined,error);}
 });
}

export function mgPortfolioSheets(report){
 const periodNames={prior:'前回まで',current:'当期',cumulative:'累計'},labels={eligibleYen:'消化対象額',appliedYen:'実充当額',overageYen:'超過報告額',recognizedYen:'計上額'};
 const groupHeader=['取引先ID','取引先','契約数','MG保証額','当期消化対象','当期実充当','当期超過報告','当期計上','累計消化対象','累計実充当','累計超過報告','累計計上','未消化残高（実充当）','保証額超の充当'];
 const values=row=>[row.contractCount,row.guaranteeYen,...metrics.map(k=>row.current[k]),...metrics.map(k=>row.cumulative[k]),row.remainingAppliedYen,row.exceedAppliedYen];
 return [
  {name:'取引先別',rows:[groupHeader,...report.parties.map(p=>[p.id,p.name,...values(p)]),['','合計',...values(report.totals)]]},
  {name:'契約別',rows:[['取引先','契約ID','契約','条件版','回収区分','保証額','累計消化対象','累計実充当','未消化残高（実充当）','保証額超の充当','保証額−消化対象','実充当到達率','消化対象到達率','実充当到達月','消化対象到達月','保証額の根拠'],...report.contracts.map(c=>[c.party.name,c.contractId,c.code,c.termVersion,c.mode,c.guaranteeYen,c.cumulative.eligibleYen,c.cumulative.appliedYen,c.remainingAppliedYen,c.exceedAppliedYen,c.eligibleDifferenceYen,c.appliedRate??'対象外（保証額0）',c.eligibleRate??'対象外（保証額0）',c.appliedReachedMonth??'未達・保証額0は対象外',c.eligibleReachedMonth??'未達・保証額0は対象外',c.sourceReference])]},
  {name:'商品作品別',rows:[['取引先','契約','商品ID','商品コード','商品','作品ID','作品','配賦bp','選択版の評価額','指標','前回まで','当期','累計'],...report.contracts.flatMap(c=>c.rows.flatMap(r=>metrics.map(key=>[c.party.name,c.code,r.productId,r.productSku,r.productName,r.workId,r.workName,r.allocationBps,r.evaluationYen??'未確認',labels[key],...periods.map(p=>r[p][key])])))]},
  {name:'元台帳',rows:[['取引先','契約','台帳ID','条件版ID','商品ID','対象開始','対象終了','計上月','消化対象','実充当','超過報告','計上額','訂正元ID','確認状態','原資料'],...report.contracts.flatMap(c=>c.sourceEntries.map(l=>[c.party.name,c.code,l.id,l.term_version_id,l.product_id,l.period_from,l.period_to,l.accounting_month,l.reported_eligible_yen,l.applied_recoup_yen,l.reported_overage_yen,l.recognized_yen,l.reverses_entry_id??'',l.status,l.source_reference]))]},
  {name:'集計基準',rows:[['項目','値'],['方向',report.direction==='incoming'?'受取MG（販売先）':'支払MG（仕入先）'],['基準計上月',report.accountingMonth],['保証額版',report.versionPolicy],['到達月',report.reachPolicy],['未確認台帳行数',report.totals.unverifiedCount],['生成日時',report.generatedAt],...report.warnings.map(w=>['注意',w]),...report.contracts.flatMap(c=>c.warnings.map(w=>[c.code,w])),...Object.entries(periodNames).map(([key,label])=>['期間区分',`${label}：${key==='prior'?'基準月より前':key==='current'?'基準月':'基準月以下'}`])]},
 ];
}
