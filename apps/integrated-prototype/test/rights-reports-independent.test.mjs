import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,good} from './committee-independent-fixture.mjs';
import {writeMark} from './test-db.mjs';
import {buildMgReport} from '../src/rights-reports.mjs';

test('shared-product report requires every allocated project, not only selected work; read stays side-effect free',async(t)=>{
 const f=await fixture({t});try{
  await f.db.run("INSERT INTO projects(id,org_id,code,title) VALUES(3,1,'PRIVATE-REPORT','架空制限案件')");
  await f.db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,3,'PRIVATE-WORK','架空別作品')");
  await f.db.run('UPDATE product_works SET allocation_bps=6000 WHERE org_id=1 AND product_id=1');
  await f.db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,1,3,4000)');
  const contract=good(await f.req('/committee/contracts',{workId:1,intakeCaseId:f.intakeCase.id,documentId:f.intakeCase.documents[0].id,contractCode:'REPORT-ACCESS',title:'架空帳票検証',managerPartnerId:2,windows:[{kind:'digital',label:'配信',windowPartnerId:1,route:'direct',platformRateBps:0,windowFeeBps:0,managerFeeBps:0,feeOrder:'window_first',windowFeeBasis:'platform_net',managerFeeBasis:'after_window'}],phases:[{label:'月次',startsOn:'2026-09-01',endsOn:'2026-09-30',firstCloseOn:'2026-09-30',intervalMonths:1,closeDay:'eom',reportOffsetMonths:1,reportDay:'eom',paymentOffsetMonths:2,paymentDay:'eom',referenceType:'release',referenceDate:'2026-09-01'}]}));
  const preview=good(await f.req('/committee/previews',{workId:1,termVersionId:contract.versionId,periodIndex:1,periodDateBasis:'sales_period',allowStub:false,reportLinks:[{reportId:f.reports[0].id,reportBasis:'net'}],expenseAllocations:[]}));
  const snapshot=good(await f.req('/committee/snapshots',{token:preview.token}));
  const mg=good(await f.req('/mg/contracts',{direction:'incoming',code:'ACCESS-MG',title:'架空MG',partnerId:2,contractDate:'2026-09-01',contractSourceReference:'FICTION',mgAmountYen:10000,startsOn:'2026-09-01',endsOn:'2026-09-30',mode:'single',reason:'検証',sourceReference:'FICTION',products:[{productId:1,evaluationYen:10000}],phases:[{startsOn:'2026-09-01',endsOn:'2026-09-30',firstCloseOn:'2026-09-30',intervalMonths:1,reportOffsetMonths:1,reportDay:28,payOffsetMonths:2,payDay:28}]}));
  const editor=await f.login('editor@openingnight.invalid'),outsider=await f.login('outsider@other.invalid');
  const paths=[`/rights-reports/committee?workId=1&snapshotId=${snapshot.snapshotId}`,`/rights-reports/mg?direction=incoming&contractId=${mg.contractId}&termVersionId=${mg.versionId}&month=2026-09`];
  const before=await writeMark(f.db);
  for(const path of paths){assert.equal((await f.req(path)).status,200);assert.equal((await f.req(path,null,editor)).status,403);assert.ok([403,404].includes((await f.req(path,null,outsider)).status))}
  assert.deepEqual(await writeMark(f.db),before);
  assert.equal((await f.req(paths[0]+'&recipientPartnerId=999')).status,400);
 }finally{f.db.close()}
});

test('MG rounds each source once using sales allocation, then prior plus current equals cumulative for every work',()=>{
 const args={direction:'incoming',contract:{id:1,code:'EXACT'},versions:[{id:1,version:1,mode:'cross',mg_amount_yen:100,products:[{product_id:1,evaluation_yen:100}]}],ledger:[1,2].map(id=>({id,term_version_id:1,product_id:1,accounting_month:`2026-0${id}`,reported_eligible_yen:1,applied_recoup_yen:1,reported_overage_yen:0,recognized_yen:0,status:'unverified'})),mappings:[{product_id:1,work_id:1,allocation_bps:6000},{product_id:1,work_id:3,allocation_bps:4000}],products:[{id:1}],selectedVersionId:1,accountingMonth:'2026-02'};
 const r=buildMgReport(args);assert.deepEqual(r.rows.map(x=>[x.prior.appliedYen,x.current.appliedYen,x.cumulative.appliedYen]),[[1,1,2],[0,0,0]]);
 const huge=structuredClone(args);huge.ledger.forEach(l=>l.applied_recoup_yen=Number.MAX_SAFE_INTEGER);assert.throws(()=>buildMgReport(huge),/安全な整数/);
});
