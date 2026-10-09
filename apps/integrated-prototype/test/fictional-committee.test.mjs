import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {seedFictionalCommittee} from '../scripts/seed-fictional-committee.mjs';
import {createApp} from '../src/app.mjs';
import {calculateJointPeriods,priorBusinessDay,jointExportColumns,jointExportRows} from '../src/committee-joint.mjs';
import {loadJointContract,jointCalculationInput} from '../src/committee-joint-routes.mjs';

const base={contract:{managerPartnerId:1,producerPartnerId:3,productionCostIncTaxYen:40000000,paIncTaxYen:8000000,managerFeeBps:0,incomeThresholdYen:20000,transferThresholdYen:26000,investorReportOffsetMonths:2,investorReportDay:'eom',investorPaymentOffsetMonths:2,investorPaymentDay:'eom'},members:[{partnerId:1,role:'investor',shareBps:5800},{partnerId:2,role:'investor',shareBps:4200}],windows:[{id:1,label:'非劇場',partnerId:2,feeBps:0,reportOffsetMonths:1,reportDay:'eom',paymentOffsetMonths:2,paymentDay:'eom'}],periods:[{sequence:1,from:'2032-01-01',to:'2032-04-30'}],costs:[]};
const sale=(amount,receivedOn=null)=>({windowId:1,periodSequence:1,sourceRef:'FICTIONAL-1',amountYen:amount,grossIncTaxYen:amount,managerReceiptOn:receivedOn});

test('two strict small-payment tests are independent and equality releases cash',()=>{
  const byIncome=calculateJointPeriods({...base,receipts:[sale(26000)],costs:[{periodSequence:1,windowId:1,sourceRef:'FICTIONAL-E',kind:'window_direct',amountYen:6001,taxBasis:'inc_tax'}]})[0].windows[0];
  assert.equal(byIncome.incomeDeferred,true);assert.equal(byIncome.transferDeferredByGross,false);assert.equal(byIncome.carriedYen,19999);
  const byTransfer=calculateJointPeriods({...base,receipts:[sale(25999)]})[0].windows[0];
  assert.equal(byTransfer.incomeDeferred,false);assert.equal(byTransfer.transferDeferredByGross,true);
  const exact=calculateJointPeriods({...base,receipts:[sale(26000,'2032-04-30')],costs:[{periodSequence:1,windowId:1,sourceRef:'FICTIONAL-E',kind:'window_direct',amountYen:6000,taxBasis:'inc_tax'}]})[0].windows[0];
  assert.equal(exact.transferDeferred,false);assert.equal(exact.cashReceivedYen,20000);
  assert.throws(()=>calculateJointPeriods({...base,receipts:[{...sale(100),periodSequence:3}]}),/期間/);
  assert.throws(()=>calculateJointPeriods({...base,receipts:[{...sale(30000,'2032-02-29'),sourceRef:'A'},{...sale(40000),sourceRef:'B'}]}),/入金済みと未着金/);
  assert.throws(()=>calculateJointPeriods({...base,receipts:[{...sale(30000,'2032-02-29'),sourceRef:'A'},{...sale(40000,'2032-03-31'),sourceRef:'B'}]}),/異なる実入金月/);
  assert.throws(()=>calculateJointPeriods({...base,receipts:[sale(26000,'2032-04-30')],costs:[{periodSequence:1,windowId:1,sourceRef:'E',kind:'window_direct',amountYen:100,taxBasis:'ex_tax'}]}),/税込契約額/);
  const delayed=calculateJointPeriods({...base,periods:[{sequence:1,from:'2032-05-01',to:'2032-07-31'}],receipts:[{...sale(26000,'2032-09-30')}]})[0];
  assert.equal(delayed.investorPaymentDueOn,'2032-11-30');
  const delayedExport=jointExportRows(1,[delayed]).joint_period_totals[0];
  assert.equal(delayedExport.as_of,'2032-07-31');
  assert.equal(delayedExport.manager_receipt_on,'2032-09-30');
  assert.equal(priorBusinessDay('2032-10-31'),'2032-10-29');
  assert.equal(priorBusinessDay('2032-11-01',['2032-11-01']),'2032-10-29');
});

test('manager fee is calculated once before master storage and bank-advance repayment',()=>{
  const input={...base,contract:{...base.contract,managerFeeBps:1000},receipts:[sale(100000,'2032-04-30')],costs:[
    {periodSequence:1,windowId:null,sourceRef:'RIGHTS',kind:'rights_manager',amountYen:10000,taxBasis:'inc_tax'},
    {periodSequence:1,windowId:null,sourceRef:'MASTER',kind:'master_management',amountYen:5000,taxBasis:'inc_tax'},
    {periodSequence:1,windowId:null,sourceRef:'BANK',kind:'bank_advance',amountYen:2000,taxBasis:'inc_tax'}
  ]};
  const [result]=calculateJointPeriods(input);
  assert.deepEqual([result.managerFeeBasisYen,result.managerFeeYen,result.masterCostYen,result.bankAdvanceRepaidYen,result.distributableYen],[90000,9000,5000,2000,74000]);
  assert.equal(result.distributions.reduce((n,d)=>n+d.earnedYen,0)+result.roundingResidualYen,74000);
});

// 同じ架空の委員会を、試験の DB（ON_TEST_DB の SQLite・PostgreSQL）に seedFictionalCommittee で作って確かめる。
// SQLite のファイルにスクリプトで作り、開き直して残ることの確かめは fictional-committee-sqlite.test.mjs
test('independent two-period oracle, exports, append-only records and access boundaries on the test database',async(t)=>{
  const db=await openTestDb({t});
  await seedFictionalCommittee(db);
  const data=await loadJointContract(db,1,1),results=calculateJointPeriods(jointCalculationInput(data));
  assert.deepEqual(results.map(p=>[p.committeeIncomeYen,p.managerFeeYen,p.distributableYen]),[[0,0,0],[2752880,65672,2533208]]);
  assert.deepEqual(results[1].distributions.map(d=>d.earnedYen),[1469260,1063947]);
  assert.equal(results[1].roundingResidualYen,1);
  assert.equal(results[0].windows[1].carriedYen,13280);
  assert.equal(results[1].windows[1].previousCarryYen,13280);
  assert.equal(results[1].windows[1].cashReceivedYen,278880);
  assert.equal(results[1].windows[1].windowFeeYen,54400);
  assert.equal(data.members.length,2);assert.equal(data.row.producer_partner_id,3);
  assert.equal(data.fundingEvents.reduce((n,e)=>n+e.amount_inc_tax_yen,0),48000000);
  assert.equal(data.milestones.reduce((n,m)=>n+m.amount_inc_tax_yen,0),40000000);
  const exports=jointExportRows(1,results,data.milestones,{1:'架空A社',2:'架空B社'});
  assert.equal(exports.joint_period_totals.length,2);
  assert.equal(exports.joint_window_periods.length,8);
  assert.equal(exports.joint_member_distributions.length,4);
  assert.equal(exports.joint_production_milestones.length,3);
  assert.equal(exports.joint_period_totals[1].tax_basis,'inc_tax');
  assert(jointExportColumns.joint_window_periods.includes('net_receipt_contract_yen'));
  const app=createApp({db});
  await assert.rejects(db.run('UPDATE joint_funding_events SET amount_inc_tax_yen=32000000 WHERE id=1'),e=>e.dbError?.kind==='raise'&&/funding event is immutable/.test(e.message));
  await assert.rejects(db.run('UPDATE joint_production_milestones SET paid_inc_tax_yen=0 WHERE id=1'),e=>e.dbError?.kind==='raise'&&/production milestone is immutable/.test(e.message));
  const login=async email=>{
    const response=await app.fetch(new Request('http://localhost/api/local/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}));
    assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
  };
  const admin=await login('demo-admin@example.invalid'),outsider=await login('outsider@other.invalid'),production=await login('production@openingnight.invalid');
  const get=(cookie,path)=>app.fetch(new Request(`http://localhost${path}`,{headers:{Cookie:cookie}}));
  assert.equal((await get(admin,'/api/committee/joint?workId=1')).status,200);
  assert.equal((await get(outsider,'/api/committee/joint?workId=1')).status,403);
  assert.equal((await get(production,'/api/committee/joint?workId=1')).status,403);
  const sheet=await get(admin,'/api/committee/joint/1/exports/joint_period_totals?workId=1&format=csv');
  assert.equal(sheet.status,200);assert.match(await sheet.text(),/2752880,126000,2626880,65672/);
  const saved=await app.fetch(new Request('http://localhost/api/committee/joint/1/snapshots?workId=1',{method:'POST',headers:{Cookie:admin,'Content-Type':'application/json'},body:'{}'}));
  assert.equal(saved.status,200);assert.equal((await saved.json()).reused,true);
});
