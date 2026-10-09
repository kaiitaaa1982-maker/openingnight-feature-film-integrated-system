import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCommitteeTerms,committeePeriods,calculateCommitteeWindow} from '../src/committee.mjs';
import {expected,fixture,good} from './committee-independent-fixture.mjs';

const members=[{partnerId:1,role:'出資者・配信窓口',shareBps:6000},{partnerId:2,role:'出資者・幹事・ビデオ窓口',shareBps:4000}];
const digital=()=>({kind:'digital',label:'架空配信',windowPartnerId:1,managerPartnerId:2,route:'via_manager',platformRateBps:5000,windowFeeBps:2000,managerFeeBps:500,feeOrder:'window_first',windowFeeBasis:'platform_net',managerFeeBasis:'after_window'});
const packageWindow=()=>({...digital(),kind:'package',label:'架空ビデオグラム',windowPartnerId:2,route:'direct',windowFeeBps:3000,managerFeeBps:0});
const phase=(startsOn,endsOn,firstCloseOn,intervalMonths)=>({label:'架空契約日程',startsOn,endsOn,firstCloseOn,intervalMonths,closeDay:'eom',reportOffsetMonths:1,reportDay:'eom',paymentOffsetMonths:2,paymentDay:'eom',referenceType:'release',referenceDate:'2026-09-01'});
const phases=()=>[phase('2026-09-01','2026-09-30','2026-09-30',1),phase('2026-10-01','2028-08-31','2026-12-31',3),phase('2028-09-01','2029-08-31','2029-02-28',6),phase('2029-09-01','2031-08-31','2030-08-31',12)];
const terms=()=>({managerPartnerId:2,members,windows:[digital(),packageWindow()],phases:phases()});

test('independent committee calculation separates window fees, manager fees, costs, member distributions and residual',()=>{
  validateCommitteeTerms(terms());
  const d=calculateCommitteeWindow({window:digital(),reports:[{reportId:1,reportBasis:'gross',amount:100000}],expenses:[{expenseId:1,amount:3000}],members});
  const p=calculateCommitteeWindow({window:packageWindow(),reports:[{reportId:2,reportBasis:'net',amount:80000}],expenses:[{expenseId:2,amount:6000}],members});
  for(const [result,want] of [[d,expected.windows[0]],[p,expected.windows[1]]]){
    assert.equal(result.platformNet,want.platform_net);assert.equal(result.platformFeeKnown,want.platform_deduction);
    assert.equal(result.windowFee,want.window_fee);assert.equal(result.managerFee,want.manager_fee);assert.equal(result.expenseTotal,want.expenses);
    assert.equal(result.distributionPool,want.distribution_pool);assert.deepEqual(result.payouts.map(x=>x.amount),want.member_distributions);assert.equal(result.residual,0);assert.equal(result.conservation.balanced,true);
  }
  assert.equal(p.hasNetBasis,true);
  assert.deepEqual(members.map(m=>[d,p].reduce((sum,w)=>sum+w.payouts.find(x=>x.partnerId===m.partnerId).amount,0)),[51000,34000]);
  const first={...digital(),feeOrder:'manager_first',managerFeeBasis:'platform_net',windowFeeBasis:'after_manager'};
  validateCommitteeTerms({...terms(),windows:[first]});
  const managerFirst=calculateCommitteeWindow({window:first,reports:[{reportId:1,reportBasis:'net',amount:50000}],expenses:[],members});
  assert.equal(managerFirst.managerFee,2500);assert.equal(managerFirst.windowFee,9500);assert.equal(managerFirst.distributionPool,38000);
  const originalBasis={...digital(),managerFeeBasis:'platform_net'};
  validateCommitteeTerms({...terms(),windows:[originalBasis]});
  assert.equal(calculateCommitteeWindow({window:originalBasis,reports:[{reportId:1,reportBasis:'net',amount:50000}],expenses:[],members}).distributionPool,37500);
  const directWithFee={...digital(),route:'direct'};validateCommitteeTerms({...terms(),windows:[directWithFee]});
  const noFees={...digital(),route:'direct',platformRateBps:0,windowFeeBps:0,managerFeeBps:0};
  const rounding=calculateCommitteeWindow({window:noFees,reports:[{reportId:1,reportBasis:'net',amount:101}],expenses:[],members});
  assert.deepEqual(rounding.payouts.map(x=>x.amount),[60,40]);assert.equal(rounding.residual,1);
  const returned=calculateCommitteeWindow({window:digital(),reports:[{reportId:1,reportBasis:'gross',amount:101},{reportId:2,reportBasis:'gross',amount:-101}],expenses:[],members});
  assert.equal(returned.platformNet,0);assert.equal(returned.platformFeeKnown,0);
  assert.throws(()=>calculateCommitteeWindow({window:noFees,reports:[{reportId:1,reportBasis:'net',amount:10}],expenses:[{expenseId:1,amount:11}],members}));
  assert.throws(()=>calculateCommitteeWindow({window:noFees,reports:[{reportId:1,reportBasis:'net',amount:Number.MAX_SAFE_INTEGER},{reportId:2,reportBasis:'net',amount:10}],expenses:[],members}));
  const cancelledLarge=calculateCommitteeWindow({window:noFees,reports:[{reportId:1,reportBasis:'net',amount:Number.MAX_SAFE_INTEGER},{reportId:2,reportBasis:'net',amount:2},{reportId:3,reportBasis:'net',amount:-2}],expenses:[],members});
  assert.equal(cancelledLarge.netReported,Number.MAX_SAFE_INTEGER,'Intermediate overflow must not lose yen when returns cancel it');
});

test('independent committee schedule keeps special first close, transition stub, changing cycles and separate due dates',()=>{
  const input=validateCommitteeTerms(terms()),periods=committeePeriods(input.phases);
  assert.equal(periods.length,13);
  assert.equal(periods[0].start,expected.schedule.first.from);assert.equal(periods[0].closeOn,expected.schedule.first.close);
  assert.equal(periods[0].reportOn,expected.schedule.first.report);assert.equal(periods[0].paymentOn,expected.schedule.first.payment);
  assert.deepEqual(periods.slice(1,8).map(x=>x.closeOn),expected.schedule.quarterly_closes);
  assert.equal(periods[8].stub,true);assert.equal(periods[8].start,'2028-07-01');assert.equal(periods[8].closeOn,'2028-08-31');
  assert.deepEqual(periods.slice(9,11).map(x=>x.closeOn),expected.schedule.semiannual_closes);
  assert.deepEqual(periods.slice(11).map(x=>x.closeOn),expected.schedule.annual_closes);
  const leap=committeePeriods([{...phase('2028-01-01','2028-02-29','2028-01-31',1),closeDay:31,reportDay:31,paymentDay:31}]);
  assert.equal(leap[0].reportOn,'2028-02-29');assert.equal(leap[1].closeOn,'2028-02-29');
  assert.equal(leap[1].paymentOn,'2028-04-30');
  assert.throws(()=>validateCommitteeTerms({...terms(),phases:[phase('2026-09-01','2026-09-30','2026-09-30',1),phase('2026-11-01','2026-12-31','2026-12-31',3)]}));
  assert.throws(()=>validateCommitteeTerms({...terms(),phases:[{...phase('2026-09-01','2026-09-30','2026-09-30',1),reportOffsetMonths:0,reportDay:1}]}));
  assert.throws(()=>validateCommitteeTerms({...terms(),members:[{...members[0],shareBps:5000},members[1]]}));
});

async function contractFixture(f){
  const contract=good(await f.req('/committee/contracts',{...terms(),workId:1,intakeCaseId:f.intakeCase.id,documentId:f.intakeCase.documents[0].id,contractCode:'COM-CONTRACT',title:'架空委員会収支'}));
  const versions=good(await f.req('/committee/contracts?workId=1')).contracts.find(c=>c.id===contract.contractId).versions;
  const version=versions.find(v=>v.id===contract.versionId),windowId=kind=>version.windows.find(w=>w.kind===kind).id;
  const input={workId:1,termVersionId:contract.versionId,periodIndex:1,periodDateBasis:'sales_period',allowStub:false,reportLinks:f.reports.map(r=>({reportId:r.id,reportBasis:r.kind==='digital'?'gross':'net'})),expenseAllocations:[{expenseId:1,windowId:windowId('digital')},{expenseId:2,windowId:windowId('package')}]};
  return {contract,version,input,windowId};
}

test('independent committee report snapshots shared source once, preserves recognition month, old conditions and access boundaries',async(t)=>{
  const f=await fixture({t});
  try{
    const {contract,version,input}=await contractFixture(f);
    const periodList=good(await f.req(`/committee/periods?termVersionId=${contract.versionId}`));
    assert.equal(periodList.periods.length,13);
    const preview=good(await f.req('/committee/previews',input));
    assert.equal(preview.totals.platformNet,130000);assert.equal(preview.totals.windowFee,34000);assert.equal(preview.totals.managerFee,2000);assert.equal(preview.totals.expenseTotal,9000);assert.equal(preview.totals.distributionPool,85000);assert.equal(preview.totals.memberPayouts,85000);
    assert.ok(preview.lines.every(line=>line.accountingMonth==='2026-10'));
    assert.ok(preview.selectedReports.every(report=>/^[a-f0-9]{64}$/.test(report.contentHash)&&report.rawReferenceId===report.reportId));
    assert.equal(preview.period.closeOn,'2026-09-30');assert.equal(preview.period.reportOn,'2026-10-31');assert.equal(preview.period.paymentOn,'2026-11-30');
    const otherPreview=good(await f.req('/committee/previews',input));
    const saved=good(await f.req('/committee/snapshots',{token:preview.token}));
    assert.equal((await f.req('/committee/snapshots',{token:otherPreview.token})).data.ok,false);
    let snapshots=good(await f.req('/committee/snapshots?workId=1')).rows;
    assert.equal(snapshots.length,1);assert.equal(snapshots[0].status,'draft');assert.equal(snapshots[0].verification,'unverified');
    const usedSources=good(await f.req(`/committee/sources?workId=1&termVersionId=${contract.versionId}&periodIndex=1&periodDateBasis=sales_period`));
    assert.ok(usedSources.candidateReports.every(report=>!report.eligible&&report.reason.includes('使用済み')));
    const original=JSON.stringify(snapshots[0]);
    good(await f.req(`/committee/contracts/${contract.contractId}/versions`,{...terms(),sourceVersionId:contract.versionId,windows:[{...digital(),windowFeeBps:3000},packageWindow()]}));
    snapshots=good(await f.req('/committee/snapshots?workId=1')).rows;
    assert.equal(JSON.stringify(snapshots[0]),original);
    await assert.rejects(f.db.run('UPDATE committee_report_snapshots SET verification=? WHERE id=?',['confirmed',saved.snapshotId]));
    const individual=good(await f.req('/settlement/contracts',{workId:1,contractCode:'BLOCK-INDIVIDUAL',title:'架空個別契約',contractType:'commission',holderPartnerId:1,terms:{platformRateBps:5000,agencyFeeBps:2000}}));
    const individualLink=await f.req('/settlement/links',{workId:1,reportId:f.reports[0].id,contractId:individual.contractId,termVersionId:individual.versionId,reportBasis:'gross'});
    assert.equal(individualLink.data.ok,false,'Already committee-assigned report cannot also receive individual fees');
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sale_lines')).n,2);
    const production=await f.login('production@openingnight.invalid'),outsider=await f.login('outsider@other.invalid');
    assert.equal((await f.req('/committee/contracts?workId=1',null,production)).status,403);
    assert.equal((await f.req('/committee/snapshots?workId=1',null,outsider)).status,403);
    assert.deepEqual(await foreignKeyViolations(f.db),[]);
  }finally{f.db.close();}
});

test('independent committee preview rejects wrong periods, duplicate costs and changed source before saving',async(t)=>{
  const f=await fixture({t});
  try{
    const {input,contract}=await contractFixture(f);
    assert.equal((await f.req('/committee/previews',{...input,periodDateBasis:'report_received'})).data.ok,false,'October receipt cannot enter September close');
    const wrongPeriod=good(await f.req(`/committee/sources?workId=1&termVersionId=${contract.versionId}&periodIndex=1&periodDateBasis=report_received`));
    assert.ok(wrongPeriod.candidateReports.every(report=>!report.eligible&&report.reason.includes('期間外')));
    const received=good(await f.req('/committee/previews',{...input,periodIndex:2,periodDateBasis:'report_received'}));
    assert.equal(received.period.closeOn,'2026-12-31');assert.equal(received.totals.distributionPool,85000);
    assert.equal((await f.req('/committee/previews',{...input,periodIndex:9})).data.ok,false,'Stub needs explicit acceptance');
    assert.equal((await f.req('/committee/previews',{...input,expenseAllocations:[...input.expenseAllocations,input.expenseAllocations[0]]})).data.ok,false);
    const preview=good(await f.req('/committee/previews',input));
    await f.db.run('UPDATE expenses SET actual_ex_tax=4000,actual_inc_tax=4000 WHERE id=1');
    assert.equal((await f.req('/committee/snapshots',{token:preview.token})).data.ok,false,'Expense change after preview requires a fresh calculation');
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM committee_report_snapshots')).n,0);
    const preview2=good(await f.req('/committee/previews',input));
    const record=await f.db.get('SELECT payload_json FROM committee_report_previews WHERE token=?',[preview2.token]);
    const payload=JSON.parse(record.payload_json);payload.calculation.totals.distributionPool=1;
    await f.db.run('UPDATE committee_report_previews SET payload_json=? WHERE token=?',[JSON.stringify(payload),preview2.token]);
    assert.equal((await f.req('/committee/snapshots',{token:preview2.token})).data.ok,false);
    const before=(await f.db.get('SELECT COUNT(*) AS n FROM committee_contracts')).n;
    assert.equal((await f.req('/committee/contracts',{...terms(),workId:2,intakeCaseId:f.intakeCase.id,documentId:f.intakeCase.documents[0].id,contractCode:'CROSS',title:'別組織'})).data.ok,false);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM committee_contracts')).n,before);
    assert.deepEqual(await foreignKeyViolations(f.db),[]);
  }finally{f.db.close();}
});

test('independent shared-product committee reports consume each work allocation once without blocking the other work',async(t)=>{
  const f=await fixture({t});
  try{
    await f.db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,1,'SHARED-WORK','架空共有作品')");
    await f.db.run("INSERT INTO products(id,org_id,sku,name,channel) VALUES(3,1,'SHARED-PRODUCT','架空セット','digital')");
    await f.db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,3,1,6000),(1,3,3,4000)');
    await f.sale('COM-SHARED','digital',100000,{product_id:3});
    const report=await f.db.get("SELECT * FROM report_imports WHERE report_key='COM-SHARED'");
    good(await f.req('/intakes',{workId:3,caseCode:'SHARED-COMMITTEE',title:'架空共有作品委員会',intakeType:'committee',documents:[{title:'架空契約',reference:'SHARED-001',versionLabel:'v1'}],participants:members.map(m=>({partyKind:'partner',partnerId:m.partnerId,role:m.role,investmentYen:m.shareBps*100,explicitShareBps:m.shareBps}))}));
    const second=good(await f.req('/intakes?workId=3')).cases[0];
    const noFees={...digital(),route:'direct',platformRateBps:0,windowFeeBps:0,managerFeeBps:0};
    const amounts=[];
    for(const intake of [f.intakeCase,second]){
      const contract=good(await f.req('/committee/contracts',{...terms(),windows:[noFees],workId:intake.work_id,intakeCaseId:intake.id,documentId:intake.documents[0].id,contractCode:`SHARED-CONTRACT-${intake.work_id}`,title:'架空配賦検証'}));
      const preview=good(await f.req('/committee/previews',{workId:intake.work_id,termVersionId:contract.versionId,periodIndex:1,periodDateBasis:'sales_period',allowStub:false,reportLinks:[{reportId:report.id,reportBasis:'net'}],expenseAllocations:[]}));
      amounts.push(preview.totals.distributionPool);
      good(await f.req('/committee/snapshots',{token:preview.token}));
    }
    assert.deepEqual(amounts,[60000,40000]);
    assert.equal((await f.db.get('SELECT SUM(allocated_amount_ex_tax) AS n FROM committee_snapshot_lines WHERE report_id=?',[report.id])).n,100000);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM committee_snapshot_reports WHERE report_id=?',[report.id])).n,2);
    assert.deepEqual(await foreignKeyViolations(f.db),[]);
  }finally{f.db.close();}
});

test('committee preview selected out of report-id order still saves (the save rebuilds the same order)',async(t)=>{
  const f=await fixture({t});
  try{
    const {input}=await contractFixture(f);
    // 画面で下から順に選ぶ・「すべて選ぶ」を押す（計上月の順）と、報告・経費の番号順にならない
    const reversed={...input,reportLinks:[...input.reportLinks].reverse(),expenseAllocations:[...input.expenseAllocations].reverse()};
    assert.ok(reversed.reportLinks[0].reportId>reversed.reportLinks[1].reportId);
    const ordered=good(await f.req('/committee/previews',input));
    const preview=good(await f.req('/committee/previews',reversed));
    assert.equal(preview.inputHash,ordered.inputHash);
    assert.equal(preview.calculationHash,ordered.calculationHash,'選んだ順で計算が変わらない');
    assert.deepEqual(preview.selectedReports.map(r=>r.reportId),[...input.reportLinks.map(r=>r.reportId)].sort((a,b)=>a-b));
    const saved=await f.req('/committee/snapshots',{token:preview.token});
    assert.equal(saved.status,201,JSON.stringify(saved.data));
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM committee_snapshot_reports')).n,2);
  }finally{f.db.close();}
});
