import test from 'node:test';
import assert from 'node:assert/strict';
import {setupMaster, meta} from './req5-master-fixture.mjs';

test('最大80契約・80権利元と商品仕様をD1の文数・束縛値・値サイズ内で原子的に保存する', async (t) => {
  const {db, call} = await setupMaster({t});
  try {
    const batch = db.batch.bind(db), recorded = [];
    db.batch = async (statements) => {
      assert.ok(statements.length <= 480);
      for (const {params = []} of statements) {
        assert.ok(params.length <= 100);
        for (const value of params) if (typeof value === 'string') assert.ok(Buffer.byteLength(value) < 128 * 1024);
      }
      recorded.push(statements);
      return batch(statements);
    };
    const contracts = Array.from({length: 80}, (_, n) => ({contract_key: `DEMO-${n}`, title: `契約${n}（架空）`, kind: 'other', partner_id: 1, document_reference: 'DEMO-契約書（架空）'}));
    assert.equal((await call('/work-master/1/contracts', {...meta, rows: contracts})).status, 201);
    assert.equal((await call('/work-master/1/rights', {...meta, rows: contracts.map((_, n) => ({name: `権利元${n}（架空）`, role: '権利元', evidence: 'DEMO-文書（架空）'}))})).status, 201);
    assert.equal((await call('/product-master/1', {...meta, product_number: 'DEMO-LIMIT'})).status, 201);
    assert.equal((await call('/work-master/1')).data.sections.contracts.rows.length, 80);
    assert.equal((await call('/work-master/1')).data.sections.rights.rows.length, 80);
    assert.equal((await db.get("SELECT COUNT(*) n FROM audit_log WHERE entity_type IN ('work_contract_set_versions','work_rights_versions','product_master_profile_versions')")).n, 3);
    const before = recorded.length;
    assert.equal((await call('/work-master/1/contracts', {...meta, baseRevision: 1, rows: [...contracts, {...contracts[0], contract_key: 'DEMO-81'}]})).status, 400);
    assert.equal((await call('/product-master/1', {...meta, baseRevision: 1, notes: '架'.repeat(44000)})).status, 400);
    assert.equal(recorded.length, before, '上限超過は書き込み前に拒否する');
    assert.equal(Math.max(...recorded.map((b) => b.length)), 163);
  } finally {db.close();}
});

test('別組織の商品・作品・発売元IDはマスタの読み書きと外部キーで拒否する', async (t) => {
  const {db, call} = await setupMaster({t});
  try {
    await db.run("INSERT INTO partners(id,org_id,code,name) VALUES(990,2,'DEMO-OUTSIDE','別組織（架空）')");
    await db.run("INSERT INTO projects(id,org_id,code,title) VALUES(990,2,'DEMO-OUTSIDE','別組織（架空）')");
    await db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(990,2,990,'DEMO-OUTSIDE','別作品（架空）')");
    await db.run("INSERT INTO products(id,org_id,sku,name,channel) VALUES(990,2,'DEMO-OUTSIDE','別商品（架空）','package')");
    await db.run('INSERT INTO product_works VALUES(2,990,990,10000)');
    for (const path of ['/work-master/990', '/work-master/990/profile', '/product-master/990']) assert.equal((await call(path)).status, 403);
    for (const path of ['/work-master/990/profile', '/product-master/990']) assert.equal((await call(path, meta)).status, 403);
    assert.equal((await call('/product-master/1', {...meta, publisher_partner_id: 990})).status, 400);
    assert.equal((await call('/product-master/1', {...meta, distributor_partner_id: 990})).status, 400);
    assert.equal((await call('/product-master/1', meta)).status, 201);
    const row = await db.get('SELECT * FROM product_master_profile_versions WHERE org_id=1 AND product_id=1');
    for (const patch of [{product_id: 990}, {publisher_partner_id: 990}, {distributor_partner_id: 990}]) {
      const changed = {...row, product_id: patch.product_id ?? 1, revision: patch.product_id ? 1 : 2, ...patch};
      await assert.rejects(db.run(`INSERT INTO product_master_profile_versions(${Object.keys(changed).join(',')}) VALUES(${Object.keys(changed).map(() => '?').join(',')})`, Object.values(changed)), (e) => e.dbError?.kind === 'foreign_key');
    }
  } finally {db.close();}
});
