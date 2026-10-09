import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

test('FR-REV-INTAKE-028 approved import preview becomes stale when its product master changes',async(t)=>{
  const db=await openTestDb({t});
  try{
    const app=createApp({db,mode:'local'});
    const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const text='report_key,partner_id,product_id,period_from,period_to,accounting_month,description,quantity,amount_ex_tax,tax_amount,amount_inc_tax\nmaster-check,2,1,2026-09-01,2026-09-30,2026-09,架空売上,1,100,10,110';
    const previewResponse=await app.request('/api/imports/preview',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({kind:'digital',workId:1,text})});
    const preview=await previewResponse.json();
    assert.equal(preview.ok,true);

    await db.run('UPDATE products SET version=version+1 WHERE org_id=1 AND id=1');
    const commitResponse=await app.request('/api/imports/commit',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({token:preview.token})});
    assert.equal(commitResponse.status,409);
    assert.match((await commitResponse.json()).error,/マスタ/);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM report_imports WHERE report_key=?',['master-check'])).n,0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM sale_lines WHERE description=?',['架空売上'])).n,0);
  }finally{await db.close()}
});
