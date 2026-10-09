import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateCommitteeWindow,committeePeriods,validateCommitteeTerms} from '../src/committee.mjs';

const members=[{partnerId:1,shareBps:6000},{partnerId:2,shareBps:4000}];
const window={kind:'digital',label:'架空配信窓口',windowPartnerId:1,managerPartnerId:2,route:'via_manager',platformRateBps:5000,windowFeeBps:2000,managerFeeBps:500,feeOrder:'window_first',windowFeeBasis:'platform_net',managerFeeBasis:'after_window'};
const phase={label:'架空初回',startsOn:'2026-09-01',endsOn:'2026-09-30',firstCloseOn:'2026-09-30',intervalMonths:1,closeDay:'eom',reportOffsetMonths:1,reportDay:'eom',paymentOffsetMonths:2,paymentDay:'eom',referenceType:'release',referenceDate:'2026-09-01'};

test('committee gross flow conserves integer yen and keeps fee recipients separate from investment shares',()=>{
  validateCommitteeTerms({managerPartnerId:2,members,windows:[window],phases:[phase]});
  const result=calculateCommitteeWindow({window,reports:[{reportBasis:'gross',amount:100000}],expenses:[{amount:3000}],members});
  assert.deepEqual({platform:result.platformFeeKnown,window:result.windowFee,manager:result.managerFee,pool:result.distributionPool,payouts:result.payouts.map(row=>row.amount),residual:result.residual},{platform:50000,window:10000,manager:2000,pool:35000,payouts:[21000,14000],residual:0});
  assert.equal(result.payouts[0].windowFeeRecipient,true);
  assert.equal(result.payouts[1].managerFeeRecipient,true);
  assert.equal(result.conservation.balanced,true);
});

test('committee schedule clamps month-end, exposes stubs and rejects reversed report dates',()=>{
  const periods=committeePeriods([{...phase,endsOn:'2026-10-15'}]);
  assert.deepEqual(periods.map(row=>[row.start,row.end,row.stub]),[['2026-09-01','2026-09-30',false],['2026-10-01','2026-10-15',true]]);
  assert.equal(periods[1].reportOn,'2026-11-30');
  assert.throws(()=>validateCommitteeTerms({managerPartnerId:2,members,windows:[window],phases:[{...phase,reportOffsetMonths:0,reportDay:1}]}),/報告予定日/);
});
