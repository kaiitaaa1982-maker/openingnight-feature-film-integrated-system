import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
export const completionExpected={prior:800000,current:{platformNet:2200000,windowFee:300000,managerFee:95000,expenseTotal:205000,distributionPool:1600000,members:[800000,480000,320000]},cumulative:2400000};
// db を渡さなければ、試験の DB のファクトリ（test/test-db.mjs）で開く。ON_TEST_DB=pg なら PostgreSQL。t を渡すと試験の後に閉じる
export async function reportCompletionFixture({db,t,includeBroadcast=true}={}){
 db??=await openTestDb({t});
 const app=createApp({db});
 const login=async(email='admin@openingnight.invalid')=>{const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]};
 const cookie=await login();
 const req=async(path,body,auth=cookie)=>{const r=await app.request('/api'+path,{method:body?'POST':'GET',headers:{cookie:auth,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}};
 const good=r=>{assert.ok(r.status<300&&r.data.ok,JSON.stringify(r));return r.data};
 const shares=[5000,3000,2000];
 good(await req('/intakes',{workId:1,caseCode:'SYNTH-COMPLETION',title:'架空・三期委員会',intakeType:'committee',documents:[{title:'架空契約',reference:'SYNTHETIC-ONLY / 独立期待値',versionLabel:'v1'}],scopes:[],participants:shares.map((share,i)=>({partyKind:'partner',partnerId:i+1,role:'出資者',investmentYen:share*100,explicitShareBps:share}))}));
 const intake=good(await req('/intakes?workId=1')).cases.find(c=>c.case_code==='SYNTH-COMPLETION');
 const windows=[['theatrical',1000],['package',2000],['digital',1500],...(includeBroadcast?[['broadcast',1000]]:[])].map(([kind,rate])=>({kind,label:kind,windowPartnerId:1,route:'via_manager',platformRateBps:0,windowFeeBps:rate,managerFeeBps:500,feeOrder:'window_first',windowFeeBasis:'platform_net',managerFeeBasis:'after_window'}));
 const terms={managerPartnerId:2,windows,phases:[{label:'架空・三か月',startsOn:'2026-01-01',endsOn:'2026-03-31',firstCloseOn:'2026-01-31',intervalMonths:1,closeDay:'eom',reportOffsetMonths:1,reportDay:'eom',paymentOffsetMonths:2,paymentDay:'eom',referenceType:'contract_specific',referenceDate:'2026-01-01'}]};
 const contract=good(await req('/committee/contracts',{...terms,workId:1,intakeCaseId:intake.id,documentId:intake.documents[0].id,contractCode:'SYNTH-COMPLETION',title:'架空・全販路委員会'}));
 const version=good(await req('/committee/contracts?workId=1')).contracts[0].versions.find(v=>v.id===contract.versionId),theater=version.windows.find(w=>w.kind==='theatrical');
 const snapshots=[],inputs=[];
 for(const [index,month,end,amounts,cost] of [[1,'01','31',[['theatrical',400000]],42000],[2,'02','28',[['theatrical',600000]],13000],[3,'03','31',[['theatrical',1000000],['package',600000],['digital',400000],...(includeBroadcast?[['broadcast',200000]]:[])],205000]]){
  const reportLinks=[];
  for(const [kind,amount] of amounts){const key=`SYNTH-COMPLETION-${month}-${kind}`;good(await req('/sales',{workId:1,report_key:key,kind,partner_id:1,product_id:null,period_from:`2026-${month}-01`,period_to:`2026-${month}-${end}`,recognition_basis_id:1,sales_month:`2026-${month}`,basis_reason:'架空資料に明示した販売月',description:key,quantity:1,amount_ex_tax:amount,tax_amount:0,amount_inc_tax:amount}));const report=await db.get('SELECT id FROM report_imports WHERE report_key=?',[key]);reportLinks.push({reportId:report.id,reportBasis:'net'})}
  const expense=await db.get('INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,?,?,?,?,?,0,?) RETURNING id',[`2026-${month}-15`,`2026-${month}`,'架空経費','独立期待値で明示した経費',cost,cost]);
  const input={workId:1,termVersionId:contract.versionId,periodIndex:index,periodDateBasis:'sales_period',allowStub:false,reportLinks,expenseAllocations:[{expenseId:expense.id,windowId:theater.id}]};
  const preview=good(await req('/committee/previews',input));const snapshot=good(await req('/committee/snapshots',{token:preview.token}));snapshots.push(snapshot.snapshotId);inputs.push(input);
 }
 return {db,app,req,login,good,contract,terms,snapshots,inputs};
}
