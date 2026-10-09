import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,good} from './field-sales-independent-fixture.mjs';

test('company reports reconcile product, channel, customer and work projections',async(t)=>{
 const f=await fixture({t});try{
  const r=good(await f.req('/report-center?start=2026-01'));
  for(const key of ['byPartner','byWork','byProduct','byDistribution']){
   assert.equal(r[key].reduce((a,b)=>a+b.total,0),r.total,key);
   for(let i=0;i<12;i++)assert.equal(r[key].reduce((a,b)=>a+b.values[i],0),r.totals[i],`${key}:${i}`);
  }
  assert.ok(r.byProduct.some(x=>x.product_id===1&&x.product_name&&x.product_sku));
  const cookie=await f.login('production@openingnight.invalid');
  assert.equal((await f.req('/report-center?start=2026-01',null,{cookie})).status,403);
 }finally{f.db.close()}
});
