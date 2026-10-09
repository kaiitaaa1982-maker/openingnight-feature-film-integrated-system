import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { channelSalesSql, LocalDatabase } from '../src/db.mjs';
import { parseChannelSalesDetail, buildChannelSalesStatements } from '../src/channel-sales.mjs';

test('local migration installs additive channel tables', () => {
  const db=new LocalDatabase(':memory:');
  try {
    for(const table of ['theatrical_sale_details','package_sale_details','digital_sale_details','package_report_observations','package_observation_products']) {
      assert.ok(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
  } finally {db.close();}
});

test('parser rejects mismatched metrics, missing companion values and fabricated stock date', () => {
  assert.throws(()=>parseChannelSalesDetail('digital',{digital_model:'est',service_code:'svc',view_count:'4'}),/EST\/TVOD/);
  assert.throws(()=>parseChannelSalesDetail('digital',{digital_model:'svod',service_code:'svc',sales_count:'4'}),/SVOD\/AVOD/);
  assert.throws(()=>parseChannelSalesDetail('digital',{digital_model:'flat',service_code:'svc',contract_amount_ex_tax:'1000'}),/both period dates/);
  assert.throws(()=>parseChannelSalesDetail('digital',{digital_model:'est',service_code:'svc',unit_price_ex_tax:'100'}),/sales_count/);
  assert.throws(()=>parseChannelSalesDetail('package',{inventory_count:'10',observation_unit:'disc',observation_scope:'partner',observation_basis:'as reported'}),/inventory_as_of/);
  assert.throws(()=>parseChannelSalesDetail('package',{package_model:'sell_through',turns_count:'2'}),/rental model/);
  assert.throws(()=>parseChannelSalesDetail('theatrical',{theatrical_model:'theatrical_rs',admissions_count:'2'}),/ticket_type_code/);
  assert.throws(()=>parseChannelSalesDetail('theatrical',{theatrical_model:'theatrical_rs',ticket_type_code:'adult',admissions_count:'9007199254740992'}),/safe nonnegative integer/);
  assert.throws(()=>parseChannelSalesDetail('package',{observation_unit:'disc'}),/metadata requires/);
  assert.deepEqual(parseChannelSalesDetail('digital',{}),{kind:'digital',detail:null,observations:[]});
});

test('same-batch lookup links detail to sale and observation to report, with immutable facts', () => {
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE organizations(id INTEGER PRIMARY KEY);
      CREATE TABLE report_imports(id INTEGER PRIMARY KEY,org_id INTEGER NOT NULL,report_key TEXT NOT NULL,content_hash TEXT NOT NULL,kind TEXT NOT NULL,UNIQUE(org_id,id));
      CREATE TABLE sale_lines(id INTEGER PRIMARY KEY,org_id INTEGER NOT NULL,report_id INTEGER,source_row INTEGER,UNIQUE(org_id,id));`);
    db.exec(channelSalesSql);
    db.exec("INSERT INTO organizations VALUES(1); INSERT INTO report_imports VALUES(10,1,'r','h','package'); INSERT INTO sale_lines VALUES(20,1,10,2);");
    const parsed=parseChannelSalesDetail('package',{package_model:'rental',turns_count:'3',average_rental_price_ex_tax:'50.25',inventory_count:'12',inventory_as_of:'2026-09-30',observation_unit:'disc',observation_scope:'partner/product',observation_basis:'reported snapshot'});
    for(const statement of buildChannelSalesStatements({orgId:1,reportKey:'r',contentHash:'h',sourceRow:2,parsed})) db.prepare(statement.sql).run(...statement.params);
    assert.equal(db.prepare('SELECT turns_count FROM package_sale_details WHERE sale_id=20').get().turns_count,3);
    assert.equal(db.prepare("SELECT count FROM package_report_observations WHERE metric='inventory'").get().count,12);
    assert.throws(()=>db.exec('UPDATE package_sale_details SET turns_count=9'),/immutable/);
    assert.throws(()=>db.exec('DELETE FROM package_report_observations'),/immutable/);
    assert.throws(()=>db.exec("UPDATE report_imports SET kind='digital' WHERE id=10"),/channel report kind is immutable/);
    assert.throws(()=>db.exec('UPDATE sale_lines SET report_id=NULL WHERE id=20'),/channel detail parent is immutable/);
    assert.throws(()=>db.exec("INSERT INTO digital_sale_details(org_id,sale_id,model,service_code) VALUES(1,20,'est','svc')"),/digital detail requires digital report sale/);
    assert.throws(()=>db.exec("INSERT INTO package_sale_details(org_id,sale_id,model) VALUES(2,20,'rental')"),/package detail requires package report sale/);
    assert.throws(()=>db.exec('DELETE FROM sale_lines WHERE id=20'),/FOREIGN KEY/);
  } finally {db.close();}
});
