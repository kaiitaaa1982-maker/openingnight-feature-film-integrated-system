import test from 'node:test';
import assert from 'node:assert/strict';
import {mgPeriods} from '../src/mg.mjs';

test('FR-SETL-MGL-004 MG calendar covers every day once across first close and phase changes',()=>{
 const common={reportOffsetMonths:1,reportDay:31,payOffsetMonths:2,payDay:31};
 const rows=mgPeriods([
  {...common,startsOn:'2028-01-15',endsOn:'2028-01-31',firstCloseOn:'2028-01-31',intervalMonths:1},
  {...common,startsOn:'2028-02-01',endsOn:'2028-07-31',firstCloseOn:'2028-04-30',intervalMonths:3},
  {...common,startsOn:'2028-08-01',endsOn:'2029-07-31',firstCloseOn:'2029-01-31',intervalMonths:6},
 ]);
 assert.deepEqual(rows.map(r=>[r.periodFrom,r.periodTo,r.reportOn,r.payOn]),[
  ['2028-01-15','2028-01-31','2028-02-29','2028-03-31'],
  ['2028-02-01','2028-04-30','2028-05-31','2028-06-30'],
  ['2028-05-01','2028-07-31','2028-08-31','2028-09-30'],
  ['2028-08-01','2029-01-31','2029-02-28','2029-03-31'],
  ['2029-02-01','2029-07-31','2029-08-31','2029-09-30'],
 ]);
});
