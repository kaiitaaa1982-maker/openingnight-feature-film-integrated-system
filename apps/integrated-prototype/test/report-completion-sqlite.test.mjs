// 委員会の報告の完成（3期・放送・支払の記録）の試験のうち、SQLite の古いファイルの移行（migrateCommitteeChannels）を確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。
// 一時ファイルの SQLite に古い表の定義（放送の無い CHECK）を当て、sqlite_master・rowid・PRAGMA で移行の前後を比べ、ファイルを開き直す。PostgreSQL の試験の DB では組めない
// （migrateCommitteeChannels は sqlite_master を読む SQLite だけの移行で、PostgreSQL では呼ばない）。
// 元は report-completion.test.mjs の中にあった試験（2026-10-03、香盤表 #11 の PR6 で分けた。中身は変えていない）。組み立ては report-completion-fixture.mjs
import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as database from '../src/db.mjs';
import {migrateCommitteeChannels} from '../src/committee-channel-migration.mjs';
import {reportCompletionFixture} from './report-completion-fixture.mjs';

test('populated old file migration keeps every row, referencing snapshots, constraints and triggers across reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'committee-old-')),path=join(dir,'old.sqlite');let db;
 try{
  db=new database.LocalDatabase(':memory:');db.close();db.raw=new DatabaseSync(path);db.raw.exec('PRAGMA foreign_keys=ON');
  const old=database.schemaSql.replace("kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other')), label TEXT NOT NULL", "kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package')), label TEXT NOT NULL");
  db.raw.exec(old);db.raw.exec(database.reportingSql);db.raw.exec(database.workbenchSql);db.raw.exec(database.mgSql);for(const [name,sql] of Object.entries(database))if(name.endsWith('Sql')&&!['schemaSql','reportingSql','workbenchSql','mgSql'].includes(name))db.raw.exec(sql);
  const f=await reportCompletionFixture({db,includeBroadcast:false});
  const tables=db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name),before=Object.fromEntries(tables.map(name=>[name,JSON.stringify(db.raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())]));
  const triggers=db.raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  assert.equal(migrateCommitteeChannels(db.raw,database.schemaSql),true);assert.equal(migrateCommitteeChannels(db.raw,database.schemaSql),false);
  for(const name of tables)assert.equal(JSON.stringify(db.raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()),before[name],name);
  assert.deepEqual(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),triggers);
  assert.deepEqual(db.raw.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.raw.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  f.good(await f.req(`/committee/contracts/${f.contract.contractId}/versions`,{...f.terms,sourceVersionId:f.contract.versionId,windows:[...f.terms.windows,{...f.terms.windows[0],kind:'broadcast',label:'架空放送'}]}));
  db.close();db=new database.LocalDatabase(path);assert.equal((await db.get('SELECT COUNT(*) AS n FROM committee_report_snapshots')).n,3);assert.deepEqual(await foreignKeyViolations(db),[]);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true})}
});
