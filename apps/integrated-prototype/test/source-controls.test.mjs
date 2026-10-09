import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {buildReportSourceControlStatements} from '../src/source-controls.mjs';
import {channelSalesSql} from '../src/db.mjs';

const schema=readFileSync(new URL('../src/source-controls.sql',import.meta.url),'utf8');

function database(){
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE transaction_guards(value INTEGER NOT NULL CHECK(value=1));
    CREATE TABLE report_imports(id INTEGER PRIMARY KEY,org_id INTEGER NOT NULL,report_key TEXT NOT NULL,content_hash TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',UNIQUE(org_id,id),UNIQUE(org_id,report_key,content_hash));
    CREATE TABLE sale_lines(id INTEGER PRIMARY KEY,org_id INTEGER NOT NULL,report_id INTEGER,source_row INTEGER,amount_ex_tax INTEGER NOT NULL,tax_amount INTEGER NOT NULL,amount_inc_tax INTEGER NOT NULL,UNIQUE(org_id,id),FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id));
    CREATE UNIQUE INDEX sale_report_source_row ON sale_lines(org_id,report_id,source_row);
    CREATE TABLE package_report_observations(org_id INTEGER NOT NULL,report_id INTEGER NOT NULL,source_row INTEGER NOT NULL,metric TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(org_id,report_id,source_row,metric),FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id));`);
  db.exec(channelSalesSql);
  db.exec(schema);
  return db;
}

function batch(db,statements){
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const statement of statements) db.prepare(statement.sql).run(...statement.params);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

const baseStatements=[
  {sql:"INSERT INTO report_imports(id,org_id,report_key,content_hash,kind) VALUES(10,1,'report-a','hash-a','package')",params:[]},
  {sql:'INSERT INTO sale_lines(id,org_id,report_id,source_row,amount_ex_tax,tax_amount,amount_inc_tax) VALUES(20,1,10,2,100,10,110)',params:[]},
  {sql:'INSERT INTO sale_lines(id,org_id,report_id,source_row,amount_ex_tax,tax_amount,amount_inc_tax) VALUES(21,1,10,3,-20,-2,-22)',params:[]},
  {sql:"INSERT INTO package_report_observations(org_id,report_id,source_row,metric,count) VALUES(1,10,1,'inventory',99999)",params:[]},
  {sql:"INSERT INTO package_report_observations(org_id,report_id,source_row,metric,count) VALUES(1,10,2,'active',50000)",params:[]},
  {sql:'INSERT INTO report_channel_fact_seals(org_id,report_id) VALUES(1,10)',params:[]}
];
const matching={rowCount:'3',amountExTax:'80',taxAmount:'8',amountIncTax:'88',byChannel:{package:{rowCount:'3',amountExTax:'80'}}};
const args={orgId:1,reportKey:'report-a',contentHash:'hash-a',kind:'package'};

test('FR-REV-INTAKE-022 records only declared totals and reconciles stock rows without booking stock as revenue',()=>{
  const db=database();
  try{
    const built=buildReportSourceControlStatements({...args,sourceTotals:matching});
    assert.equal(built.recorded.length,6);
    assert.deepEqual(built.unverified,['channel.package.taxAmount','channel.package.amountIncTax']);
    batch(db,[...baseStatements,...built.statements]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_source_controls').get().n,6);
    assert.equal(db.prepare("SELECT expected_value FROM report_source_controls WHERE metric='amount_ex_tax' AND scope_kind='report'").get().expected_value,80);
    assert.throws(()=>db.exec('UPDATE report_source_controls SET expected_value=81'),/immutable/);
    assert.throws(()=>db.exec('DELETE FROM report_source_controls'),/immutable/);
    assert.throws(()=>db.exec('UPDATE sale_lines SET amount_ex_tax=101 WHERE id=20'),/immutable/);
    assert.throws(()=>db.exec("INSERT INTO package_report_observations VALUES(1,10,4,'inventory',1)"),/immutable/);
    db.exec("UPDATE report_imports SET status='superseded' WHERE id=10");
  }finally{db.close();}
});

test('FR-REV-INTAKE-022 a count or amount mismatch aborts the entire import batch',()=>{
  for(const sourceTotals of [{...matching,rowCount:2},{...matching,amountExTax:81},{...matching,byChannel:{package:{rowCount:4}}}]){
    const db=database();
    try{
      const built=buildReportSourceControlStatements({...args,sourceTotals});
      assert.throws(()=>batch(db,[...baseStatements,...built.statements]),/source control does not match sealed report/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_imports').get().n,0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get().n,0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_source_controls').get().n,0);
    }finally{db.close();}
  }
});

test('FR-REV-INTAKE-022 missing controls remain unverified and unsafe or cross-channel values are rejected',()=>{
  const empty=buildReportSourceControlStatements({...args,sourceTotals:{}});
  assert.equal(empty.statements.length,0);
  assert.equal(empty.unverified.length,8);
  assert.throws(()=>buildReportSourceControlStatements({...args,sourceTotals:{rowCount:'1.5'}}),/integer/);
  assert.throws(()=>buildReportSourceControlStatements({...args,sourceTotals:{amountExTax:'9007199254740992'}}),/safe integer/);
  assert.throws(()=>buildReportSourceControlStatements({...args,sourceTotals:{rowCount:'-1'}}),/nonnegative/);
  assert.throws(()=>buildReportSourceControlStatements({...args,sourceTotals:{byChannel:{digital:{rowCount:1}}}}),/does not match/);
  const db=database();
  try{
    db.exec("INSERT INTO report_imports(id,org_id,report_key,content_hash,kind) VALUES(10,1,'report-a','hash-a','package')");
    assert.throws(()=>db.exec("INSERT INTO report_source_controls(org_id,report_id,scope_kind,channel,metric,expected_value) VALUES(1,10,'report','','row_count',0)"),/requires sealed report/);
    db.exec('INSERT INTO report_channel_fact_seals(org_id,report_id) VALUES(1,10)');
    assert.throws(()=>db.exec("INSERT INTO report_source_controls(org_id,report_id,scope_kind,channel,metric,expected_value) VALUES(1,10,'channel','digital','row_count',0)"),/must match report kind/);
  }finally{db.close();}
});
