import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {mgPeriods,normalizeMgVersion} from '../src/mg.mjs';

async function fixture({t}={}){const db=await openTestDb({t}),app=createApp({db,mode:'local'});const login=async email=>{const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});return r.headers.get('set-cookie').split(';')[0]},admin=await login('admin@openingnight.invalid');const req=async(path,input,cookie=admin)=>{const r=await app.request(`/api${path}`,{method:input?'POST':'GET',headers:{cookie,...(input?{'content-type':'application/json'}:{})},body:input?JSON.stringify(input):undefined});return {status:r.status,data:await r.json()}};return {db,app,admin,login,req}}
const good=r=>{assert.equal(r.data.ok,true,JSON.stringify(r.data));return r.data};
const terms=(direction='incoming')=>({direction,code:`MG-${direction}`,title:`架空${direction}MG`,partnerId:2,supplierId:1,contractDate:'2026-09-20',contractSourceReference:`CONTRACT-${direction}`,mgAmountYen:100000,startsOn:'2026-10-01',endsOn:'2027-09-30',mode:'cross',reason:'架空条件の登録',sourceReference:`TERMS-${direction}`,products:[{productId:1,evaluationYen:70000},{productId:2,evaluationYen:30000}],phases:[{startsOn:'2026-10-01',endsOn:'2027-09-30',intervalMonths:3,firstCloseOn:'2026-12-31',reportOffsetMonths:1,reportDay:28,payOffsetMonths:2,payDay:28}]});

test('FR-SETL-MGL-003 MG validation preserves contract evaluation, current-period semantics and schedule dates',()=>{
 const v=normalizeMgVersion(terms());assert.equal(v.amount,100000);assert.deepEqual(v.products.map(x=>x.evaluationYen),[70000,30000]);
 assert.throws(()=>normalizeMgVersion({...terms(),mgAmountYen:99999}),/一致/);assert.throws(()=>normalizeMgVersion({...terms(),mgAmountYen:-1}),/0以上/);assert.throws(()=>normalizeMgVersion({...terms(),mode:'special'}),/未確認/);
 const periods=mgPeriods(v.phases);assert.equal(periods[0].closeOn,'2026-12-31');assert.equal(periods[0].reportOn,'2027-01-28');assert.equal(periods[0].payOn,'2027-02-28');assert.equal(periods.length,4);
});

test('FR-PLAN-ACQ-006 FR-SETL-MGL-001 FR-SETL-MGL-002 FR-SETL-MGL-006 FR-SETL-MGL-008 FR-SETL-MGL-009 FR-SETL-MGL-015 directional MG routes isolate parties, require all product permissions, append immutable versions and manual current-period rows',async(t)=>{
 const f=await fixture({t});try{
  const supplier=good(await f.req('/mg/suppliers',{code:'SUP-001',name:'架空権利元',note:'合成データ'}));
  const incoming=good(await f.req('/mg/contracts',terms('incoming'))),outgoing=good(await f.req('/mg/contracts',{...terms('outgoing'),supplierId:supplier.supplierId}));
  const beforeRollback=(await f.db.get('SELECT COUNT(*) n FROM mg_incoming_contracts')).n;
  assert.equal((await f.req('/mg/contracts',{...terms('incoming'),code:'ROLLBACK',contractSourceReference:'ROLLBACK',partnerId:999999})).status,409);
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM mg_incoming_contracts')).n,beforeRollback,'contract/version/children batch must roll back together');
  assert.notEqual(incoming.versionId,outgoing.versionId);
  const listedIn=good(await f.req('/mg/contracts?direction=incoming')).contracts,listedOut=good(await f.req('/mg/contracts?direction=outgoing')).contracts;
  assert.equal(listedIn.length,1);assert.equal(listedOut.length,1);assert.equal(listedIn[0].partner_id,2);assert.equal(listedOut[0].supplier_id,supplier.supplierId);
  const fresh={...terms('incoming'),baseVersion:1,reason:'更新根拠',sourceReference:'TERMS-incoming-v2'};delete fresh.direction;delete fresh.code;delete fresh.title;delete fresh.partnerId;delete fresh.contractDate;delete fresh.contractSourceReference;
  good(await f.req(`/mg/contracts/incoming/${incoming.contractId}/versions`,fresh));
  assert.equal((await f.req(`/mg/contracts/incoming/${incoming.contractId}/versions`,fresh)).status,409);
  await assert.rejects(f.db.run('UPDATE mg_term_versions SET reason=? WHERE id=?',['改変',incoming.versionId]),/変更できません/);
  const entry=good(await f.req('/mg/ledger',{termVersionId:incoming.versionId,productId:1,periodFrom:'2026-10-01',periodTo:'2026-10-31',accountingMonth:'2026-11',sourceReference:'MONTH-001',reportedEligibleYen:12000,appliedRecoupYen:10000,reportedOverageYen:2000,recognizedYen:9000,status:'unverified'}));
  assert.equal((await f.req('/mg/ledger',{termVersionId:incoming.versionId,productId:1,periodFrom:'2026-10-01',periodTo:'2026-10-31',accountingMonth:'2026-11',sourceReference:'MONTH-001',reportedEligibleYen:1,appliedRecoupYen:1,reportedOverageYen:0,recognizedYen:1,status:'unverified'})).status,409,'same source cannot be imported twice');
  assert.equal((await f.req('/mg/ledger',{termVersionId:incoming.versionId,productId:2,periodFrom:'2026-10-01',periodTo:'2026-10-31',accountingMonth:'2026-11',sourceReference:'MONTH-REVIEW',reportedEligibleYen:0,appliedRecoupYen:0,reportedOverageYen:0,recognizedYen:0,status:'reviewed',acknowledgement:false,confirmationReason:'確認'})).status,400);
  good(await f.req('/mg/ledger',{termVersionId:incoming.versionId,productId:2,periodFrom:'2026-10-01',periodTo:'2026-10-31',accountingMonth:'2026-11',sourceReference:'MONTH-ZERO',reportedEligibleYen:0,appliedRecoupYen:0,reportedOverageYen:0,recognizedYen:0,status:'reviewed',acknowledgement:true,confirmationReason:'当期増分ゼロを資料で確認'}));
  const correction=good(await f.req('/mg/ledger',{termVersionId:incoming.versionId,productId:1,periodFrom:'2026-10-01',periodTo:'2026-10-31',reportReceivedOn:'2026-11-12',accountingMonth:'2026-11',sourceReference:'MONTH-001-CORRECTION',reportedEligibleYen:11000,appliedRecoupYen:9000,reportedOverageYen:2000,recognizedYen:8000,status:'reviewed',acknowledgement:true,confirmationReason:'訂正版資料で全額を再入力',reversesEntryId:entry.entryId}));
  assert.equal((await f.req('/mg/ledger',{termVersionId:incoming.versionId,productId:1,periodFrom:'2026-10-01',periodTo:'2026-10-31',accountingMonth:'2026-11',sourceReference:'SECOND-CORRECTION',reportedEligibleYen:1,appliedRecoupYen:1,reportedOverageYen:0,recognizedYen:1,status:'unverified',confirmationReason:'二重訂正の拒否検証',reversesEntryId:entry.entryId})).status,409,'one row has at most one successor');
  const ledger=good(await f.req('/mg/ledger')).rows;assert.equal(ledger.find(r=>r.id===entry.entryId).isSuperseded,1);assert.equal(ledger.find(r=>r.id===correction.entryId).report_received_on,'2026-11-12');
  const link=good(await f.req('/mg/links',{incomingContractId:incoming.contractId,outgoingContractId:outgoing.contractId,rationale:'同じ架空商品の入出方向を監査用に関連付け'}));assert.ok(link.linkId);assert.equal(good(await f.req('/mg/links')).links.length,1);
  await assert.rejects(f.db.run('DELETE FROM mg_ledger_entries WHERE id=?',[entry.entryId]),/削除できません/);
  assert.equal((await f.db.get('SELECT reported_eligible_yen,applied_recoup_yen,reported_overage_yen FROM mg_ledger_entries WHERE id=?',[entry.entryId])).applied_recoup_yen,10000);
  const production=await f.login('production@openingnight.invalid');assert.equal((await f.req('/mg/contracts',terms('incoming'),production)).status,403);for(const path of ['/mg/catalog','/mg/contracts?direction=incoming','/mg/ledger','/mg/links',`/mg/periods?termVersionId=${incoming.versionId}`])assert.equal((await f.req(path,null,production)).status,403,`${path} must deny production`);
  const outsider=await f.login('outsider@other.invalid');assert.deepEqual(good(await f.req('/mg/contracts?direction=incoming',null,outsider)).contracts,[]);assert.deepEqual(good(await f.req('/mg/ledger',null,outsider)).rows,[]);
  assert.deepEqual(await foreignKeyViolations(f.db),[]);
 }finally{await f.db.close()}
});
