import {expenseDemoWriter} from './seed-expense-support.mjs';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {encodeXlsx} from '../src/xlsx.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
export const EXPECTED={currentSales:2200000,windowFee:300000,managerFee:95000,expenses:205000,currentPool:1600000,previousPool:800000,cumulativePool:2400000,payouts:[800000,480000,320000]};
export async function createWorkflowDemo({filename=resolve(root,'data/human-workflow-demo.sqlite'),prepareOnly=false}={}){
 filename=resolve(filename);if(!filename.startsWith(resolve(root,'data')+'\\')&&!filename.startsWith(resolve(root,'data')+'/'))throw Error('デモDBはアプリのdataフォルダ内に作成してください');
 if(existsSync(filename))throw Error('既存DBは上書きしません');mkdirSync(dirname(filename),{recursive:true});
 const db=new LocalDatabase(filename),app=createApp({db,mode:'local'});
 try{
  const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const rawReq=async(path,input,method=input?'POST':'GET',headers={})=>{const r=await app.request('/api'+path,{method,headers:{cookie,'content-type':'application/json',...headers},body:input?JSON.stringify(input):undefined});const out=await r.json();if(!r.ok||!out.ok)throw Error(`${path}: ${JSON.stringify(out)}`);return out};
 const expensePost=expenseDemoWriter(db,1,rawReq);
 const req=(path,input,...rest)=>path==='/expenses'?expensePost(path,input):rawReq(path,input,...rest);
  await req('/works',{project_id:1,code:'WF-DEMO',title:'架空映画・波の向こうへ',format:'映画',forecast_yen:0});const work=await db.get("SELECT * FROM works WHERE code='WF-DEMO'");const workId=work.id;
  const kinds=['theatrical','package','digital','broadcast'],labels=['劇場','ビデオグラム','配信','放送'],fees=[1000,2000,1500,1000],products=[];
  for(let n=0;n<kinds.length;n++){await req('/products',{sku:'WF-'+kinds[n],name:'波の向こうへ '+labels[n],channel:kinds[n]});const p=await db.get('SELECT * FROM products WHERE sku=?',['WF-'+kinds[n]]);products.push(p);await req('/product-works',{productId:p.id,allocations:[{workId,allocationBps:10000}]})}
  await req('/intakes',{workId,caseCode:'WF-COMMITTEE',title:'架空映画・製作委員会',intakeType:'committee',documents:[{title:'架空契約・説明用',reference:'SYNTHETIC-WF-001',versionLabel:'1'}],participants:[{partyKind:'partner',partnerId:1,role:'出資者A・劇場窓口',investmentYen:500000,explicitShareBps:5000},{partyKind:'partner',partnerId:2,role:'出資者B・幹事',investmentYen:300000,explicitShareBps:3000},{partyKind:'partner',partnerId:3,role:'出資者C・放送窓口',investmentYen:200000,explicitShareBps:2000}]});
  const intake=await db.get("SELECT id FROM rights_intake_cases WHERE case_code='WF-COMMITTEE'"),document=await db.get('SELECT id FROM rights_intake_documents WHERE intake_case_id=?',[intake.id]);
  await req('/committee/contracts',{workId,intakeCaseId:intake.id,documentId:document.id,contractCode:'WF-C-01',title:'波の向こうへ 製作委員会収支',managerPartnerId:2,windows:kinds.map((kind,n)=>({kind,label:labels[n]+'窓口',windowPartnerId:[1,2,2,3][n],route:'via_manager',platformRateBps:0,windowFeeBps:fees[n],managerFeeBps:500,feeOrder:'window_first',windowFeeBasis:'platform_net',managerFeeBasis:'after_window'})),phases:[{label:'架空月次',startsOn:'2026-07-01',endsOn:'2026-09-30',firstCloseOn:'2026-07-31',intervalMonths:1,closeDay:'eom',reportOffsetMonths:1,reportDay:'eom',paymentOffsetMonths:2,paymentDay:'eom',referenceType:'release',referenceDate:'2026-07-01'}]});
  const contract=await db.get("SELECT id FROM committee_contracts WHERE contract_code='WF-C-01'"),term=await db.get('SELECT id FROM committee_term_versions WHERE contract_id=?',[contract.id]),windows=await db.all('SELECT * FROM committee_term_windows WHERE term_version_id=?',[term.id]);
  const rows=[],snapshots=[];
  for(const [index,month,amounts,costs,wanted] of [[1,'2026-07',[400000,0,0,0],[42000,0,0,0],300000],[2,'2026-08',[600000,0,0,0],[13000,0,0,0],500000],[3,'2026-09',[1000000,600000,400000,200000],[100000,50000,35000,20000],1600000]]){
   const end=month+(index===3?'-30':'-31'),links=[],expenseAllocations=[];
   for(let n=0;n<kinds.length;n++){
    const row={report_key:`WF-${month}-${kinds[n]}`,kind:kinds[n],partner_id:[1,3,2,3][n],product_id:products[n].id,period_from:month+'-01',period_to:end,recognition_basis_id:1,sales_month:month,basis_reason:'架空報告・販売月を明示',description:'架空映画 '+labels[n]+' PF控除後売上',quantity:1,amount_ex_tax:amounts[n],tax_amount:0,amount_inc_tax:amounts[n]};
    if(index===3)rows.push(row);
    if(index<3||!prepareOnly){await req('/sales',{workId,...row});const report=await db.get('SELECT id FROM report_imports WHERE report_key=?',[row.report_key]);links.push({reportId:report.id,reportBasis:'net'})}
    if(costs[n]){await req('/expenses',{project_id:1,work_id:workId,incurred_on:month+'-20',accounting_month:month,category:labels[n],description:`WF-${month}-${kinds[n]}経費`,actual_ex_tax:costs[n],tax_amount:0,actual_inc_tax:costs[n]});const e=await db.get('SELECT id FROM expenses WHERE work_id=? AND description=?',[workId,`WF-${month}-${kinds[n]}経費`]);expenseAllocations.push({expenseId:e.id,windowId:windows.find(w=>w.kind===kinds[n]).id})}
   }
   if(index<3||!prepareOnly){const preview=await req('/committee/previews',{workId,termVersionId:term.id,periodIndex:index,periodDateBasis:'sales_period',allowStub:false,reportLinks:links,expenseAllocations});assert.equal(preview.totals.distributionPool,wanted);if(index===3){assert.equal(preview.totals.windowFee,EXPECTED.windowFee);assert.equal(preview.totals.managerFee,EXPECTED.managerFee)}const saved=await req('/committee/snapshots',{token:preview.token});snapshots.push(saved)}
  }
  // Both directions are explicit contracts. Ledger amounts never become new sale lines.
  await req('/mg/suppliers',{code:'SUP-WF',name:'架空権利元'});const supplier=await db.get("SELECT id FROM mg_suppliers WHERE code='SUP-WF'");
  for(const direction of ['incoming','outgoing']){
   await req('/mg/contracts',{direction,code:'WF-MG-'+direction,title:direction==='incoming'?'架空受取MG':'架空支払MG',partnerId:3,supplierId:supplier.id,contractDate:'2026-07-01',contractSourceReference:'SYNTHETIC-MG-'+direction,mgAmountYen:1000000,startsOn:'2026-07-01',endsOn:'2026-12-31',mode:'single',reason:'架空のMG帳票検証',sourceReference:'SYNTHETIC-MG-TERMS',products:[{productId:products[2].id,evaluationYen:1000000}],phases:[{startsOn:'2026-07-01',endsOn:'2026-12-31',intervalMonths:1,firstCloseOn:'2026-07-31',closeDay:'eom',reportOffsetMonths:1,reportDay:28,payOffsetMonths:2,payDay:28}]});
   const c=await db.get(`SELECT id FROM mg_${direction}_contracts WHERE code=?`,['WF-MG-'+direction]),v=await db.get(`SELECT id FROM mg_term_versions WHERE ${direction}_contract_id=?`,[c.id]);await req('/mg/ledger',{termVersionId:v.id,productId:products[2].id,periodFrom:'2026-07-01',periodTo:'2026-09-30',accountingMonth:'2026-09',sourceReference:'SYNTHETIC-MG-LEDGER-'+direction,reportedEligibleYen:1200000,appliedRecoupYen:1000000,reportedOverageYen:200000,recognizedYen:0,status:'unverified'});
  }
  for(const [no,loc,summary] of [['1','海辺の駅','朝、遥が駅で手紙を読む。'],['2','喫茶店','遥と誠が再会する。'],['3','海辺の駅','夕方、二人がホームに立つ。']])await req('/scenes',{project_id:1,work_id:workId,scene_no:no,day_night:no==='3'?'N':'D',location:loc,synopsis:summary,status:'draft'});
  const scenes=await db.all('SELECT id,scene_no FROM scenes WHERE work_id=? ORDER BY scene_no',[workId]);const day=await req('/field/days',{workId,shootDate:'2026-10-05',unit:'本隊',label:'第1撮影日',notes:'架空の撮影予定',assignments:scenes.map((s,n)=>({sceneId:s.id,sequenceOrder:n+1,plannedStart:`2026-10-05T${['09','11','15'][n]}:00`,plannedEnd:`2026-10-05T${['10','12','16'][n]}:00`,outcome:'planned'}))});
  await req(`/production/${workId}`,{characters:[{key:'haruka',name:'遥',short_name:'遥',actor_name:'架空キャストA'},{key:'makoto',name:'誠',short_name:'誠',actor_name:'架空キャストB'}],locations:[{key:'station',name:'海辺の駅',address:'東京都千代田区丸の内一丁目',parking:'別途確認',note:'架空ロケ設定・住所は地図リンクの説明用'},{key:'cafe',name:'喫茶店',address:'東京都千代田区丸の内二丁目',green_room:'奥の控室'}],sceneDetails:scenes.map((s,n)=>({scene_id:s.id,page_eighths:[12,20,8][n],estimated_minutes:[60,60,60][n],location_key:n===1?'cafe':'station'})),appearances:scenes.flatMap((s,n)=>[{scene_id:s.id,character_key:'haruka'},...(n?[{scene_id:s.id,character_key:'makoto'}]:[])]),looks:[{key:'h1',character_key:'haruka',label:'1・駅の私服',props:'手紙',shoes:'白いスニーカー'},{key:'m1',character_key:'makoto',label:'1・仕事帰り',props:'鞄'}],sceneLooks:scenes.flatMap((s,n)=>[{scene_id:s.id,look_key:'h1'},...(n?[{scene_id:s.id,look_key:'m1'}]:[])]),daySlots:[{day_id:day.dayId,key:'lunch',after_scene_order:2,kind:'meal',label:'昼食・移動',planned_start:'2026-10-05T12:00',planned_end:'2026-10-05T13:00'}],calls:[{day_id:day.dayId,character_key:'haruka',call_time:'2026-10-05T08:00',ready_time:'2026-10-05T08:45'}]},'PUT',{'If-Match':'0'});
  const output=resolve(dirname(filename),'human-workflow-files');mkdirSync(output,{recursive:true});const headers=Object.keys(rows[0]);writeFileSync(resolve(output,'2026年9月_4販路売上_架空.xlsx'),encodeXlsx([{name:'売上',rows:[headers,...rows.map(r=>headers.map(k=>r[k]))]}]));
  const snap=await db.get('SELECT id FROM committee_report_snapshots WHERE contract_id=? ORDER BY period_to DESC LIMIT 1',[contract.id]);
  if(!prepareOnly){const report=await req(`/rights-reports/committee?workId=${workId}&snapshotId=${snap.id}`);assert.equal(report.report.totals.previous.distributionPool,EXPECTED.previousPool);assert.equal(report.report.totals.current.distributionPool,EXPECTED.currentPool);assert.equal(report.report.totals.cumulative.distributionPool,EXPECTED.cumulativePool);assert.deepEqual(report.report.totals.current.memberDistributions.map(x=>x.amount),EXPECTED.payouts);writeFileSync(resolve(output,'committee-proof.json'),JSON.stringify(report,null,2));}
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);writeFileSync(filename+'.workbench-demo.json',JSON.stringify({kind:'workbench-synthetic-v1',id:crypto.randomUUID(),database:filename,createdAt:new Date().toISOString()},null,2));
  const manifest={syntheticOnly:true,database:filename,workId,contractId:contract.id,termVersionId:term.id,products:products.map(p=>p.id),latestSnapshotId:snap.id,prepareOnly,expected:EXPECTED,files:output};writeFileSync(filename+'.manifest.json',JSON.stringify(manifest,null,2));return manifest;
 }finally{db.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{console.log(JSON.stringify(await createWorkflowDemo({filename:process.argv[2]||undefined,prepareOnly:process.argv.includes('--prepare-only')})))}catch(e){console.error(e.stack);process.exitCode=1}}
