import assert from 'node:assert/strict';
// seedの架空入力を列挙した独立オラクル。製品の分類・集計関数は呼ばない。
const categories={'劇場':'direct','ビデオグラム':'direct','配信':'direct','放送':'direct','宣伝':'promotion','制作費':'production','P&A':'promotion','宣伝費':'promotion','広告':'promotion','事務費':'workOther','パッケージ製作費':'direct','配信マスター制作費':'direct','海外素材費':'direct'};
const keys={direct:'direct_cost',production:'production_cost',promotion:'promotion',workOther:'work_other_expense'};
const sum=rows=>rows.reduce((n,r)=>n+r,0);
export function verifyDemoExpenseCompatibility(input,report){
 const expenses=input.expenses.map(e=>{const field=categories[e.category];assert.ok(field,`架空入力の期待分類を追加: ${e.id} ${e.category}`);assert.equal(e.systemKey,keys[field],`分類差: ${e.id} ${e.category}`);const w=input.works.find(w=>w.id===e.workId);return {...e,field,recognized:field==='production'&&w?(w.releaseMonth&&w.releaseMonth>e.month?w.releaseMonth:e.month):e.month};});
 const expectedWork=(w,from,to)=>{
  const take=(rows,month='month')=>rows.filter(r=>r[month]>=from&&r[month]<=to);
  const amounts={direct:0,production:0,promotion:0,workOther:0};
  if(!w.committee)for(const e of take(expenses.filter(e=>e.workId===w.id),'recognized'))amounts[e.field]+=e.exTax;
  const acquisitions=input.committee.find(c=>c.workId===w.id)?.acquisitions??[];
  const acq=w.committee?sum(take(acquisitions).map(a=>a.distribution+a.windowFee+a.managerFee)):0;
  const revenue=w.committee?acq:sum(take(input.saleLines.filter(s=>s.workId===w.id)).map(s=>s.amount));
  const royalties=w.committee?0:sum(take(input.royaltyAccruals.filter(s=>s.workId===w.id)).map(s=>s.royaltyYen??0));
  const manual=sum(take(input.manual.filter(m=>m.kind==='flow'&&m.workId===w.id)).map(m=>{const a=input.accounts.find(a=>a.id===m.accountId);return ['sales','non_operating_income','extraordinary_gain'].includes(a.section)?m.amount:-m.amount;}));
  return {...amounts,acq,profit:revenue-royalties-sum(Object.values(amounts))+manual};
 };
 let comparisons=0;
 for(const w of input.works){const actual=report.workPl.find(r=>r.workId===w.id);for(const [a,from,to] of [[actual.period,input.from,input.to],[actual.cumulative,'0000-01',input.to],...actual.monthly.map(m=>[m,m.month,m.month])]){
  const expected=expectedWork(w,from,to);for(const [key,v] of Object.entries(expected)){assert.equal(a[key],v,`${w.code} ${from}〜${to} ${key}`);comparisons++;}
 }}
 const company=(from,to)=>{
  const work=sum(input.works.map(w=>expectedWork(w,from,to).profit));
  const unallocated=sum(expenses.filter(e=>e.workId==null&&e.month>=from&&e.month<=to).map(e=>e.exTax));
  const manual=sum(input.manual.filter(m=>m.workId==null&&m.kind==='flow'&&m.month>=from&&m.month<=to).map(m=>{const a=input.accounts.find(a=>a.id===m.accountId);return ['sales','non_operating_income','extraordinary_gain'].includes(a.section)?m.amount:-m.amount;}));
  return work-unallocated+manual;
 };
 for(const [column,from,to] of [['period',input.from,input.to],...report.months.map(m=>['m:'+m,m,m])])for(const [field,key] of Object.entries(keys)){
  const expected=sum(input.works.map(w=>expectedWork(w,from,to)[field]))+sum(expenses.filter(e=>e.workId==null&&e.field===field&&e.month>=from&&e.month<=to).map(e=>e.exTax));
  assert.equal(report.companyPl.rows.find(r=>r.key===key).values[column],expected,`${key} ${column}`);comparisons++;
 }
 for(const month of report.months){assert.equal(report.companyPl.rows.find(r=>r.key==='netIncome').values['m:'+month],company(month,month),month);comparisons++;}
 assert.equal(report.companyPl.netIncome.period,company(input.from,input.to));
 assert.equal(report.companyPl.netIncome.cumulative,company('0000-01',input.to));
 const periodCosts=Object.fromEntries(Object.keys(keys).map(field=>[field,sum(input.works.map(w=>expectedWork(w,input.from,input.to)[field]))+sum(expenses.filter(e=>e.workId==null&&e.field===field&&e.month>=input.from&&e.month<=input.to).map(e=>e.exTax))]));
 const committeeAcquisition=sum(input.works.map(w=>expectedWork(w,input.from,input.to).acq));
 return {periodCosts,committeeAcquisition,comparisons:comparisons+2,period:company(input.from,input.to),cumulative:company('0000-01',input.to),differences:[]};
}
