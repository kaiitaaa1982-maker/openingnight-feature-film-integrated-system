import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';

const expectedFile=fileURLToPath(new URL('../../../analytics-poc/.runtime/year-demo.sqlite',import.meta.url));
if(!process.env.ON_DB_FILE||resolve(process.env.ON_DB_FILE)!==resolve(expectedFile))throw new Error('架空年間デモのDBだけを指定してください');
const expected=JSON.parse(readFileSync(new URL('../../../docs/platform/team-development/rights-report-independent-expectations.json',import.meta.url),'utf8'));
const db=new LocalDatabase(expectedFile),app=createApp({db,mode:'local'});
try{
 const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 async function req(path){const response=await app.request('/api'+path,{headers:{cookie}});const out=await response.json();assert.equal(response.status,200,JSON.stringify(out));assert.equal(out.ok,true);return out.report}
 const before=(await db.get('SELECT total_changes() n')).n;
 const snapshot=await db.get("SELECT s.* FROM committee_report_snapshots s JOIN committee_contracts c ON c.org_id=s.org_id AND c.id=s.contract_id WHERE c.contract_code='SYNTH-RIGHTS-CONTRACT' AND s.period_index=2");
 const committee=await req(`/rights-reports/committee?workId=${snapshot.work_id}&snapshotId=${snapshot.id}`);
 for(const period of ['previous','current','cumulative']){
  for(const [key,value] of Object.entries(expected.committee[period]))if(key!=='members')assert.equal(committee.totals[period][key],value,`${period}.${key}`);
  assert.deepEqual(committee.totals[period].memberDistributions.map(r=>r.amount).sort((a,b)=>a-b),Object.values(expected.committee[period].members).sort((a,b)=>a-b));
 }
 const contract=await db.get("SELECT * FROM mg_incoming_contracts WHERE org_id=1 AND code='MG-REPORT-3WORK'");
 const version=await db.get('SELECT * FROM mg_term_versions WHERE org_id=1 AND incoming_contract_id=? ORDER BY version LIMIT 1',[contract.id]);
 const mg=await req(`/rights-reports/mg?direction=incoming&contractId=${contract.id}&termVersionId=${version.id}&month=2026-08`);
 assert.equal(mg.headline.guaranteeYen,expected.mg.guarantee);
 assert.equal(mg.headline.cumulativeAppliedYen,expected.mg.cumulativeAppliedTotal);
 assert.equal(mg.headline.contractRemainingYen,expected.mg.contractRemaining);
 assert.equal(mg.sourceEntryIds.length,6,'訂正前行を含めない');
 for(const [period,key] of [['prior','previousAppliedTotal'],['current','currentAppliedTotal'],['cumulative','cumulativeAppliedTotal']])assert.equal(mg.rows.reduce((n,r)=>n+r[period].appliedYen,0),expected.mg[key]);
 const sorted=mg.rows.sort((a,b)=>a.productSku.localeCompare(b.productSku));
 for(let n=0;n<3;n++)assert.equal(sorted[n].cumulative.appliedYen,expected.mg.cumulativeApplied[['A','B','C'][n]]);
 const outgoing=await db.get("SELECT c.id,v.id versionId FROM mg_outgoing_contracts c JOIN mg_term_versions v ON v.outgoing_contract_id=c.id AND v.org_id=c.org_id WHERE c.code='MG-DEMO-OUT'");
 const paid=await req(`/rights-reports/mg?direction=outgoing&contractId=${outgoing.id}&termVersionId=${outgoing.versionId}&month=2026-11`);
 assert.equal(paid.headline.guaranteeYen,80000);assert.equal(paid.headline.cumulativeAppliedYen,8000);assert.equal(paid.headline.contractRemainingYen,72000);
 const after=(await db.get('SELECT total_changes() n')).n;assert.equal(after,before,'帳票読取はDBを書き換えない');
 assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
 console.log(JSON.stringify({ok:true,independentExpectedValues:true,committeeThreePeriods:true,mgThreeWorksWithCorrection:true,outgoingSeparated:true,noWrites:true}));
}finally{db.close()}
