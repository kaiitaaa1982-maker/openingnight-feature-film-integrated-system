import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {setupMaster,meta} from './req5-master-fixture.mjs';
test('商品のJAN先頭0・仕様・価格の税区分を版で保持し、元の商品と配賦を変えない',async(t)=>{
  const {db,call,login}=await setupMaster({t});try {
    const before=await db.get('SELECT * FROM products WHERE id=1'),links=await db.all('SELECT * FROM product_works');
    const b={...meta,jan_code:'0012345678901',product_number:'DEMO-BD-01',media:'Blu-ray',disc_count:2,release_on:'2026-10-01',price_yen:0,price_tax_basis:'ex_tax',price_status:'confirmed',price_as_of:'2026-09-28',price_evidence:'価格表（架空）',publisher_partner_id:1};
    let r=await call('/product-master/1',b);assert.equal(r.status,201,JSON.stringify(r.data));
    assert.equal((await call('/product-master/1',b)).status,409);
    assert.equal((await call('/product-master/1',{...b,baseRevision:1,disc_count:3})).status,201);
    r=await call('/product-master/1?revision=1');assert.equal(r.data.profile.jan_code,'0012345678901');assert.equal(r.data.profile.disc_count,2);assert.equal(r.data.profile.price_yen,0);assert.equal(r.data.profile.price_inc_tax_yen,null);
    const production=await login('production@openingnight.invalid');r=await call('/product-master/1?revision=1',null,production);assert.equal(r.status,200);assert.ok(!Object.keys(r.data.profile).some(k=>k.startsWith('price_')));
    assert.equal((await call('/product-master/1',b,production)).status,403);
    for(const patch of [{jan_code:1234567890123},{jan_code:'123'},{publisher_partner_id:9999},{release_on:'2026-02-30'}]) assert.equal((await call('/product-master/1',{...b,baseRevision:2,...patch})).status,400);
    assert.deepEqual(await db.get('SELECT * FROM products WHERE id=1'),before);assert.deepEqual(await db.all('SELECT * FROM product_works'),links);
    await assert.rejects(db.run('DELETE FROM product_master_profile_versions'));assert.deepEqual(await foreignKeyViolations(db),[]);
  }finally{db.close();}
});
test('共有商品はすべての作品への権限を検査する',async(t)=>{
  const {db,call,login}=await setupMaster({t});try {
    await db.run("INSERT INTO projects(id,org_id,code,title) VALUES(90,1,'DEMO-PRIVATE','非公開（架空）')");
    await db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(90,1,90,'DEMO-PRIVATE-W','非公開作品（架空）')");
    await db.run('INSERT INTO product_works VALUES(1,1,90,5000)');
    const editor=await login('editor@openingnight.invalid');assert.equal((await call('/product-master/1',null,editor)).status,403);assert.equal((await call('/product-master/1',meta,editor)).status,403);
  }finally{db.close();}
});
