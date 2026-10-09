import test from 'node:test';
import assert from 'node:assert/strict';
import {validDate,monthBounds,windowOverlapsMonth,broadcastEntries,monthCell,broadcastStatus} from '../src/broadcast-window-model.mjs';

const row=(overrides={})=>({id:1,work_id:7,product_id:12,distribution_code:'B001',release_on:'2026-01-31',sales_end_on:'2026-02-01',status:'confirmed',...overrides});

test('calendar boundaries are inclusive, including leap day, without timezone shifts',()=>{
 assert.deepEqual(monthBounds(2028,2),{start:'2028-02-01',end:'2028-02-29'});
 assert.equal(validDate('2028-02-29'),true);
 assert.equal(validDate('2027-02-29'),false);
 assert.equal(windowOverlapsMonth(row(),2026,1),true);
 assert.equal(windowOverlapsMonth(row(),2026,2),true);
 assert.equal(windowOverlapsMonth(row(),2026,3),false);
 assert.equal(windowOverlapsMonth(row({release_on:'2026-02-02'}),2026,1),false);
 assert.equal(windowOverlapsMonth(row({release_on:'2026-02-02',sales_end_on:'2026-02-01'}),2026,2),false);
 assert.equal(windowOverlapsMonth(row({release_on:'2026-02-30'}),2026,2),false);
});

test('broadcast catalog keeps product and work-wide scope distinct',()=>{
 const catalog={types:[{code:'B001',distribution_name:'放送'},{code:'D001',distribution_name:'配信'}],windows:[row(),row({id:2,distribution_code:'D001'})],workWindows:[row({id:3,product_id:undefined})]};
 assert.deepEqual(broadcastEntries(catalog).map(entry=>[entry.id,entry.scope]),[[1,'product'],[3,'work']]);
});

test('same-month signal counts active rows only and is a review signal',()=>{
 const entries=[row(),row({id:2,release_on:'2026-02-01',sales_end_on:'2026-02-28',status:'draft'}),row({id:3,status:'withdrawn'})];
 const february=monthCell(entries,7,2026,2);
 assert.equal(february.status,'overlap');
 assert.equal(february.count,2);
 assert.equal(february.sameMonthOverlap,true);
 assert.equal(monthCell(entries,7,2026,1).status,'confirmed');
 assert.equal(monthCell(entries,8,2026,2).status,'empty');
 assert.equal(broadcastStatus(row({release_on:null})), '期間未確認');
});
