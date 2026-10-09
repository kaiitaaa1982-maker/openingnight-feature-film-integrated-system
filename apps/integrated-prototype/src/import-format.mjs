// These suggestions describe evidence in the extracted report. They never select a format or authorize registration.
const FORMAT_RULES = [
  {kind:'theatrical',label:'配給・劇場',rules:[
    {label:'券種',pattern:/券種|ticket[\s_-]*type/i,weight:3},
    {label:'入場者・動員',pattern:/入場者|観客数|動員数|admission/i,weight:2},
    {label:'興行収入',pattern:/興収|興行収入|box[\s_-]*office/i,weight:2},
    {label:'劇場',pattern:/劇場|映画館|cinema|theat(?:er|re)/i,weight:1}
  ]},
  {kind:'package',label:'ビデオグラム',rules:[
    {label:'回転数',pattern:/回転数|レンタル回数|turns[\s_-]*count/i,weight:3},
    {label:'稼働数',pattern:/稼働数|active[\s_-]*count/i,weight:2},
    {label:'在庫数',pattern:/在庫|inventory|stock/i,weight:2},
    {label:'納品数',pattern:/納品|delivered[\s_-]*count/i,weight:2},
    {label:'返品数',pattern:/返品数|returned[\s_-]*count/i,weight:2},
    {label:'媒体区分',pattern:/ビデオグラム|パッケージ|videogram/i,weight:2}
  ]},
  {kind:'digital',label:'配信',rules:[
    {label:'視聴指標',pattern:/視聴|再生|view[\s_-]*(?:count|seconds)|watch[\s_-]*time/i,weight:3},
    {label:'配信区分',pattern:/配信|streaming|digital|\b(?:EST|TVOD|SVOD|AVOD)\b/i,weight:2},
    {label:'サービス',pattern:/サービス(?:名|ID|コード)|service[\s_-]*(?:id|code|name)/i,weight:2},
    {label:'販売件数',pattern:/販売件数|sales[\s_-]*count/i,weight:1}
  ]},
  {kind:'broadcast',label:'放送・番販',rules:[
    {label:'放送局',pattern:/放送局|broadcaster|station/i,weight:3},
    {label:'放送日',pattern:/放送日|air[\s_-]*date/i,weight:2},
    {label:'放送区分',pattern:/放送|番販|broadcast/i,weight:2},
    {label:'放送ウィンドウ',pattern:/ウィンドウ|window/i,weight:1}
  ]}
];

const ROW_KIND_KEYS = ['kind','channel','報告種別','販路'];
const KIND_VALUES = new Map([
  ['theatrical','theatrical'],['劇場','theatrical'],['配給','theatrical'],
  ['package','package'],['ビデオグラム','package'],['パッケージ','package'],
  ['digital','digital'],['配信','digital'],
  ['broadcast','broadcast'],['放送','broadcast'],['番販','broadcast']
]);
const hasValue = value => value !== null && value !== undefined && String(value).trim() !== '';
const clean = value => String(value ?? '').normalize('NFKC').trim();

/** A rule-based ranking of report formats, not a format decision. */
export function suggestSalesImportFormats({headers=[],rows=[]}={}) {
  if(!Array.isArray(headers)||!Array.isArray(rows))throw new TypeError('headersとrowsは配列で指定してください');
  const names=headers.map(clean).filter(Boolean);
  const observedKinds=new Set();
  for(const row of rows.slice(0,100)){
    if(!row||typeof row!=='object')continue;
    for(const key of ROW_KIND_KEYS){
      const value=Array.isArray(row)?row[headers.indexOf(key)]:row[key];
      const kind=KIND_VALUES.get(clean(value));
      if(kind)observedKinds.add(kind);
    }
  }
  const candidates=FORMAT_RULES.map(format=>{
    const evidence=[];
    for(const rule of format.rules){
      const matches=names.filter(name=>rule.pattern.test(name));
      if(matches.length)evidence.push({source:'header',signal:rule.label,headers:matches,weight:rule.weight});
    }
    if(observedKinds.has(format.kind))evidence.push({source:'row-kind',signal:'報告種別の明示値',headers:[],weight:4});
    const score=evidence.reduce((sum,item)=>sum+item.weight,0);
    return {kind:format.kind,label:format.label,score,evidence};
  }).filter(candidate=>candidate.score>0).sort((a,b)=>b.score-a.score||a.kind.localeCompare(b.kind));
  const first=candidates[0],second=candidates[1],margin=(first?.score??0)-(second?.score??0);
  const ambiguous=observedKinds.size>1||Boolean(first&&second&&margin<2);
  const confidence=!first?'none':ambiguous?'low':first.score>=6&&margin>=3?'high':first.score>=3&&margin>=2?'medium':'low';
  const recommended=confidence==='medium'||confidence==='high'?first.kind:null;
  return {recommended,confidence,ambiguous,candidates,requiresHumanConfirmation:true,
    reason:!first?'識別に使える列や報告種別がありません':ambiguous?'複数の販路を示す根拠があり、形式を一つに絞れません':recommended?'列名と明示された報告種別から候補を提示しました':'根拠が少ないため販路を確認してください'};
}

function integer(value,label,{nonnegative=false}={}){
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw new TypeError(`${label}は安全な整数か整数文字列で指定してください`);
  const text=clean(value);
  if(!/^-?(?:0|[1-9]\d*)$/.test(text)&&!/^-[1-9]\d{0,2}(?:,\d{3})+$|^[1-9]\d{0,2}(?:,\d{3})+$/.test(text))throw new TypeError(`${label}は円整数または件数の整数で指定してください`);
  const result=BigInt(text.replaceAll(',',''));
  if(nonnegative&&result<0n)throw new TypeError(`${label}は0以上で指定してください`);
  return result;
}
const valueOf = number => number==null?null:number.toString();
const AMOUNTS = [{control:'amountExTax',column:'amount_ex_tax',label:'税抜額'},{control:'taxAmount',column:'tax_amount',label:'税額'},{control:'amountIncTax',column:'amount_inc_tax',label:'税込額'}];
const defaultIds=['report_key','partner_id'];
function equalId(left,right,key){
  const a=clean(left),b=clean(right);
  if(key.endsWith('_id')&&/^\d+$/.test(a)&&/^\d+$/.test(b))return BigInt(a)===BigInt(b);
  return a===b;
}

/**
 * Compare selected detail rows with report rows and explicitly supplied source controls.
 * reportRows includes non-revenue observations; canonicalRows contains only sale lines.
 * sourceTotals must come from a reviewed total/control row, not from an inferred subtotal.
 * Source ID columns are compared only when identified by name or sourceIdentifierColumns.
 */
export function preflightSalesImport({sourceDetailRows,canonicalRows,reportRows=canonicalRows,sourceTotals={},sourceIdentifierColumns={},requiredIds=defaultIds,kind=null}={}){
  if(!Array.isArray(canonicalRows)||!Array.isArray(reportRows)||sourceDetailRows!==undefined&&!Array.isArray(sourceDetailRows))throw new TypeError('明細行は配列で指定してください');
  if(!sourceTotals||typeof sourceTotals!=='object'||Array.isArray(sourceTotals))throw new TypeError('sourceTotalsはオブジェクトで指定してください');
  if(!Array.isArray(requiredIds)||requiredIds.some(key=>typeof key!=='string'))throw new TypeError('requiredIdsは列名の配列で指定してください');
  const checks=[];
  const add=(key,status,message,expected=null,actual=null)=>checks.push({key,status,message,expected:valueOf(expected),actual:valueOf(actual)});
  const canonical=canonicalRows.map((row,index)=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw new TypeError(`${index+1}行目の売上明細が不正です`);
    return row;
  });
  const report=reportRows.map((row,index)=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw new TypeError(`${index+1}行目の報告明細が不正です`);
    return row;
  });
  add('nonempty',report.length?'pass':'fail',report.length?'報告明細があります':'報告明細がありません',null,report.length);
  if(sourceDetailRows){
    const expected=BigInt(sourceDetailRows.length),actual=BigInt(report.length);
    add('source-row-count',expected===actual?'pass':'fail',expected===actual?'選択した原本明細と報告明細の件数が一致':'選択した原本明細と報告明細の件数が一致しません',expected,actual);
  }else add('source-row-count','unverified','原本の明細行数が渡されていません');
  if(Object.hasOwn(sourceTotals,'rowCount')){
    const expected=integer(sourceTotals.rowCount,'原本総件数',{nonnegative:true}),actual=BigInt(report.length);
    add('control-row-count',expected===actual?'pass':'fail',expected===actual?'原本の総件数と一致':'原本の総件数と一致しません',expected,actual);
  }else add('control-row-count','unverified','原本の総件数が指定されていません');
  for(const key of requiredIds){
    const bad=[];
    for(let index=0;index<report.length;index++)if(!hasValue(report[index][key]))bad.push(index+1);
    add(`required-id:${key}`,bad.length?'fail':'pass',bad.length?`${key}が空の明細があります: ${bad.join('、')}`:`${key}が全明細にあります`,null,bad.length);
  }
  for(const key of new Set([...defaultIds,'product_id','work_id',...Object.keys(sourceIdentifierColumns)])){
    if(!sourceDetailRows){add(`source-id:${key}`,'unverified','原本ID列を照合する明細がありません');continue}
    const sourceColumn=sourceIdentifierColumns[key]||key;
    const explicit=Object.hasOwn(sourceIdentifierColumns,key);
    const provided=sourceDetailRows.some(row=>row&&Object.hasOwn(row,sourceColumn)&&hasValue(row[sourceColumn]));
    if(!provided){add(`source-id:${key}`,explicit?'fail':'unverified',`原本に${sourceColumn}の明示値がありません`);continue}
    const mismatches=[],missing=[];
    for(let index=0;index<sourceDetailRows.length;index++){
      const expected=sourceDetailRows[index]?.[sourceColumn];
      if(!hasValue(expected)){missing.push(index+1);continue}
      if(!report[index]||!hasValue(report[index][key])||!equalId(expected,report[index][key],key))mismatches.push(index+1);
    }
    const status=mismatches.length||explicit&&missing.length?'fail':missing.length?'unverified':'pass';
    const message=mismatches.length?`${sourceColumn}と${key}が一致しない明細があります: ${mismatches.join('、')}`:missing.length?`原本の${sourceColumn}が空の明細があります: ${missing.join('、')}`:`原本の${sourceColumn}と${key}が一致`;
    add(`source-id:${key}`,status,message,null,mismatches.length+missing.length);
  }
  const sums={};
  for(const {control,column,label} of AMOUNTS){
    const invalid=[];let actual=0n;
    for(let index=0;index<canonical.length;index++){
      try{actual+=integer(canonical[index][column],`${index+1}行目の${label}`)}catch{invalid.push(index+1)}
    }
    if(invalid.length){add(`amount:${column}`,'fail',`${label}が円整数でない明細があります: ${invalid.join('、')}`);continue}
    sums[column]=actual;
    if(Object.hasOwn(sourceTotals,control)){
      const expected=integer(sourceTotals[control],`原本${label}`);
      add(`amount:${column}`,expected===actual?'pass':'fail',expected===actual?`原本${label}合計と一致`:`原本${label}合計と一致しません`,expected,actual);
    }else add(`amount:${column}`,'unverified',`原本${label}合計が指定されていません`,null,actual);
  }
  if(AMOUNTS.every(({column})=>sums[column]!==undefined)){
    const valid=canonical.every(row=>integer(row.amount_ex_tax,'税抜額')+integer(row.tax_amount,'税額')===integer(row.amount_inc_tax,'税込額'));
    add('row-tax-equation',valid?'pass':'fail',valid?'全明細で税抜額＋税額＝税込額':'税抜額＋税額と税込額が一致しない明細があります');
  }
  const byChannel=sourceTotals.byChannel;
  if(byChannel===undefined)add('channel-controls','unverified','原本の販路別件数・金額が指定されていません');
  else{
    if(!byChannel||typeof byChannel!=='object'||Array.isArray(byChannel))throw new TypeError('byChannelは販路別のオブジェクトで指定してください');
    const reportGroups=new Map(),canonicalGroups=new Map(),unclassified=[];
    for(const [rows,groups,label] of [[report,reportGroups,'報告'],[canonical,canonicalGroups,'売上']])rows.forEach((row,index)=>{
      const channel=clean(row.kind||row.channel||kind);
      if(!channel){unclassified.push(`${label}${index+1}`);return}
      const group=groups.get(channel)||[];group.push(row);groups.set(channel,group);
    });
    if(unclassified.length)add('channel-assignment','fail',`販路がない明細があります: ${unclassified.join('、')}`);
    else add('channel-assignment','pass','全明細の販路を確認できます');
    const unexpected=[...new Set([...reportGroups.keys(),...canonicalGroups.keys()])].filter(channel=>!Object.hasOwn(byChannel,channel));
    add('channel-coverage',unexpected.length?'fail':'pass',unexpected.length?`原本の販路別集計にない販路があります: ${unexpected.join('、')}`:'原本の販路別集計が全販路を含みます');
    for(const [channel,control] of Object.entries(byChannel)){
      if(!control||typeof control!=='object'||Array.isArray(control))throw new TypeError(`${channel}の販路別集計が不正です`);
      const reportChannelRows=reportGroups.get(channel)||[],saleChannelRows=canonicalGroups.get(channel)||[];
      if(Object.hasOwn(control,'rowCount')){
        const expected=integer(control.rowCount,`${channel}の原本件数`,{nonnegative:true}),actual=BigInt(reportChannelRows.length);
        add(`channel:${channel}:rowCount`,expected===actual?'pass':'fail',expected===actual?`${channel}の件数が一致`:`${channel}の件数が一致しません`,expected,actual);
      }else add(`channel:${channel}:rowCount`,'unverified',`${channel}の原本件数が指定されていません`);
      for(const {control:key,column,label} of AMOUNTS){
        if(!Object.hasOwn(control,key)){add(`channel:${channel}:${key}`,'unverified',`${channel}の原本${label}が指定されていません`);continue}
        const expected=integer(control[key],`${channel}の原本${label}`);let actual=0n,invalid=false;
        for(const row of saleChannelRows)try{actual+=integer(row[column],label)}catch{invalid=true}
        if(invalid){add(`channel:${channel}:${key}`,'fail',`${channel}の正規化${label}に不明値があります`);continue}
        add(`channel:${channel}:${key}`,expected===actual?'pass':'fail',expected===actual?`${channel}の${label}が一致`:`${channel}の${label}が一致しません`,expected,actual);
      }
    }
  }
  const failures=checks.filter(check=>check.status==='fail'),unverified=checks.filter(check=>check.status==='unverified');
  return {status:failures.length?'blocked':unverified.length?'unverified':'pass',blocking:failures.length>0,readyForHumanReview:failures.length===0,requiresHumanConfirmation:true,canCommit:false,checks,failures,unverified};
}
