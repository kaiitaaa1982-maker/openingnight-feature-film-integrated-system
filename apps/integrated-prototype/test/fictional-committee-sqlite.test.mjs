// 架空の製作委員会（合同会計）の試験のうち、スクリプト（scripts/seed-fictional-committee.mjs）が SQLite のファイルに作った DB を閉じて開き直し、
// 記録と計算・出力・権限が残ることを確かめる試験。SQLite だけで流す（test/pg-matrix.json の sqliteOnly）。ファイルの SQLite を2回開く（閉じて開き直す）ので、
// PostgreSQL の試験の DB では組めない。同じ照合・出力・権限・追加だけの記録は、fictional-committee.test.mjs が試験の DB（SQLite・PostgreSQL）で確かめる。
// 元は fictional-committee.test.mjs の中にあった試験（2026-10-03、香盤表 #11 の PR6 で分けた。中身は変えていない）
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {calculateJointPeriods,jointExportColumns,jointExportRows} from '../src/committee-joint.mjs';
import {loadJointContract,jointCalculationInput} from '../src/committee-joint-routes.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));

test('independent two-period oracle, durable database, exports, and access boundaries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fic-joint-')),file=join(dir,'fictional.sqlite');
  try{
    execFileSync(process.execPath,[join(root,'scripts/seed-fictional-committee.mjs'),file],{cwd:root,stdio:'pipe'});
    const db=new LocalDatabase(file),data=await loadJointContract(db,1,1),results=calculateJointPeriods(jointCalculationInput(data));
    assert.deepEqual(results.map(p=>[p.committeeIncomeYen,p.managerFeeYen,p.distributableYen]),[[0,0,0],[2752880,65672,2533208]]);
    assert.deepEqual(results[1].distributions.map(d=>d.earnedYen),[1469260,1063947]);
    assert.equal(results[1].roundingResidualYen,1);
    assert.equal(results[0].windows[1].carriedYen,13280);
    assert.equal(results[1].windows[1].previousCarryYen,13280);
    assert.equal(results[1].windows[1].cashReceivedYen,278880);
    assert.equal(results[1].windows[1].windowFeeYen,54400);
    assert.equal(data.members.length,2);assert.equal(data.row.producer_partner_id,3);
    assert.equal(data.fundingEvents.reduce((n,e)=>n+e.amount_inc_tax_yen,0),48000000);
    assert.equal(data.milestones.reduce((n,m)=>n+m.amount_inc_tax_yen,0),40000000);
    const exports=jointExportRows(1,results,data.milestones,{1:'架空A社',2:'架空B社'});
    assert.equal(exports.joint_period_totals.length,2);
    assert.equal(exports.joint_window_periods.length,8);
    assert.equal(exports.joint_member_distributions.length,4);
    assert.equal(exports.joint_production_milestones.length,3);
    assert.equal(exports.joint_period_totals[1].tax_basis,'inc_tax');
    assert(jointExportColumns.joint_window_periods.includes('net_receipt_contract_yen'));
    db.close();
    const reopened=new LocalDatabase(file),app=createApp({db:reopened});
    assert.throws(()=>reopened.raw.prepare('UPDATE joint_funding_events SET amount_inc_tax_yen=32000000 WHERE id=1').run(),/funding event is immutable/);
    assert.throws(()=>reopened.raw.prepare('UPDATE joint_production_milestones SET paid_inc_tax_yen=0 WHERE id=1').run(),/production milestone is immutable/);
    const login=async email=>{
      const response=await app.fetch(new Request('http://localhost/api/local/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}));
      assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
    };
    const admin=await login('demo-admin@example.invalid'),outsider=await login('outsider@other.invalid'),production=await login('production@openingnight.invalid');
    const get=(cookie,path)=>app.fetch(new Request(`http://localhost${path}`,{headers:{Cookie:cookie}}));
    assert.equal((await get(admin,'/api/committee/joint?workId=1')).status,200);
    assert.equal((await get(outsider,'/api/committee/joint?workId=1')).status,403);
    assert.equal((await get(production,'/api/committee/joint?workId=1')).status,403);
    const sheet=await get(admin,'/api/committee/joint/1/exports/joint_period_totals?workId=1&format=csv');
    assert.equal(sheet.status,200);assert.match(await sheet.text(),/2752880,126000,2626880,65672/);
    const saved=await app.fetch(new Request('http://localhost/api/committee/joint/1/snapshots?workId=1',{method:'POST',headers:{Cookie:admin,'Content-Type':'application/json'},body:'{}'}));
    assert.equal(saved.status,200);assert.equal((await saved.json()).reused,true);
    reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true})}
});
