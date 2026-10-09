import test from 'node:test';
import assert from 'node:assert/strict';
import {reportCompletionFixture,completionExpected as expected} from './report-completion-fixture.mjs';
import {committeeReportSheets} from '../src/rights-report-output.mjs';
import {salesReportSheets,reportBreakdowns} from '../src/report-center-model.mjs';
import {encodeXlsx,decodeXlsx} from '../src/xlsx.mjs';
import {printableReport} from '../src/report-output.mjs';

test('three distinct periods including broadcast reconcile source sales, frozen reports and genuine Excel',async(t)=>{
 const f=await reportCompletionFixture({t});
 const report=f.good(await f.req(`/rights-reports/committee?workId=1&snapshotId=${f.snapshots[2]}`)).report;
 for(const key of ['platformNet','windowFee','managerFee','expenseTotal','distributionPool'])assert.equal(report.totals.current[key],expected.current[key],key);
 assert.equal(report.totals.previous.distributionPool,expected.prior);assert.equal(report.totals.cumulative.distributionPool,expected.cumulative);
 assert.deepEqual(report.totals.current.memberDistributions.map(r=>r.amount),expected.current.members);
 assert.equal(report.byChannel.find(w=>w.kind==='broadcast').current.platformNet,200000);
 assert.equal(report.sourceSnapshots.length,3);assert.equal(report.sourceLines.length,6);assert.equal(report.gaps.length,0);
 const sheets=committeeReportSheets(report),roundTrip=decodeXlsx(encodeXlsx(sheets));assert.equal(roundTrip.find(s=>s.name==='収支報告').rows.find(r=>r[0]==='分配原資')[2],1600000);
 assert.equal(roundTrip.find(s=>s.name==='照合').rows.find(r=>r[0]==='原資保存（当期）')[1],0);
 const html=printableReport({title:'架空収支 <safe>',sheets});assert.match(html,/架空収支 &lt;safe&gt;/);assert.match(html,/break-after:page/);assert.match(html,/1,600,000/);
 const old=JSON.stringify(report.totals);f.good(await f.req(`/committee/contracts/${f.contract.contractId}/versions`,{...f.terms,sourceVersionId:f.contract.versionId,windows:f.terms.windows.map(w=>({...w,managerFeeBps:1000}))}));
 assert.equal(JSON.stringify(f.good(await f.req(`/rights-reports/committee?workId=1&snapshotId=${f.snapshots[2]}`)).report.totals),old);
 assert.equal((await f.req('/committee/previews',f.inputs[2])).data.ok,false);
});

test('annual banpan department grouping, P&L and drill sources preserve total and input authorization',async(t)=>{
 const f=await reportCompletionFixture({t});
 const before=f.good(await f.req('/report-center?start=2026-01'));
 const line=before.lines.find(r=>r.kind==='broadcast');
 f.good(await f.req('/report-center/departments',{saleId:line.id,baseVersion:0,department:'番販',reason:'架空資料の担当部門'}));
 const after=f.good(await f.req('/report-center?start=2026-01'));
 assert.equal(after.total,3200000);assert.equal(after.byBanpan.reduce((n,r)=>n+r.total,0),after.total);
 assert.equal(after.byBanpan.find(r=>r.kind==='broadcast').departmentShare,1);
 assert.equal(after.profitLoss[0].income,3200000);assert.equal(after.profitLoss[0].expense,260000);
 const round=decodeXlsx(encodeXlsx(salesReportSheets(after,'banpan')));assert.equal(round.find(s=>s.name==='元明細').rows.length,7);
 assert.equal((await f.req('/report-center/departments',{saleId:line.id,baseVersion:0,department:'競合',reason:'古い版'})).status,409);
 const production=await f.login('production@openingnight.invalid');assert.equal((await f.req('/report-center?start=2026-01',null,production)).status,403);
 assert.equal(reportBreakdowns([{kind:'digital',department_name:'D',partner_id:1,distribution_code:'X',amount:0,accounting_month:'2026-01'}],['2026-01'],[]).byBanpan[0].departmentShare,null);
});

test('payment events record actual evidence separately; duplicate, wrong recipient and reversal mutations are rejected',async(t)=>{
 const f=await reportCompletionFixture({t});
 const input={committeeSnapshotId:f.snapshots[2],partnerId:1,amountYen:400000,paidOn:'2026-05-31',reference:'SYNTH-PAY-1',reason:'架空支払証憑'};
 const saved=f.good(await f.req('/rights-reports/payments',input));
 assert.equal((await f.req('/rights-reports/payments',input)).status,409);
 assert.equal((await f.req('/rights-reports/payments',{...input,reference:'BAD',partnerId:4})).status,409);
 f.good(await f.req('/rights-reports/payments',{...input,reference:'SYNTH-REV-1',reversesEventId:saved.id,paidOn:'2026-06-01',reason:'架空訂正'}));
 assert.equal(f.good(await f.req('/rights-reports/payments?workId=1')).recordedNetYen,0);
 assert.equal((await f.req('/rights-reports/payments',{...input,reference:'SYNTH-REV-2',reversesEventId:saved.id})).status,409);
 await assert.rejects(f.db.run('UPDATE rights_payment_events SET amount_yen=1 WHERE id=?',[saved.id]),e=>e.dbError?.kind==='raise'&&/immutable/.test(e.message));
 assert.equal((await f.db.get('SELECT status FROM committee_report_snapshots WHERE id=?',[f.snapshots[2]])).status,'draft');
 const production=await f.login('production@openingnight.invalid');assert.equal((await f.req('/rights-reports/payments',input,production)).status,403);
});
