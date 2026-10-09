import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {openTestDb, writeMark} from './test-db.mjs';
import {buildMgPortfolio,mgPortfolioSheets,registerMgPortfolioRoutes} from '../src/mg-portfolio.mjs';
import {encodeXlsx} from '../src/xlsx.mjs';
import {printableReport} from '../src/report-output.mjs';

const entry=(id,term,product,month,eligible,applied,overage=0,recognized=0,extra={})=>({id,term_version_id:term,product_id:product,accounting_month:month,period_from:month+'-01',period_to:month+'-28',reported_eligible_yen:eligible,applied_recoup_yen:applied,reported_overage_yen:overage,recognized_yen:recognized,source_reference:`架空-${id}`,status:'reviewed',...extra});
function contract(id=1,partyId=2){
 return {direction:'incoming',contract:{id,code:`MG-${id}`,title:'架空MG',partner_id:partyId,source_reference:'架空契約'},party:{id:partyId,code:`P-${partyId}`,name:`架空先${partyId}`},
  versions:[{id:10,version:1,starts_on:'2026-01-01',ends_on:'2026-12-31',mode:'cross',mg_amount_yen:800,products:[{product_id:11,evaluation_yen:400},{product_id:12,evaluation_yen:400}]},
   {id:11,version:2,starts_on:'2026-03-01',ends_on:'2026-12-31',mode:'cross',mg_amount_yen:1000,products:[{product_id:11,evaluation_yen:600},{product_id:12,evaluation_yen:400}]},
   {id:12,version:3,starts_on:'2026-07-01',ends_on:'2026-12-31',mode:'cross',mg_amount_yen:2000,products:[{product_id:11,evaluation_yen:1600},{product_id:12,evaluation_yen:400}]}],
  ledger:[entry(1,10,11,'2026-01',600,500),entry(2,10,12,'2026-02',500,400,100,75),entry(3,11,11,'2026-03',400,200,200,150)],
  mappings:[{product_id:11,work_id:1,allocation_bps:6000},{product_id:11,work_id:2,allocation_bps:4000},{product_id:12,work_id:1,allocation_bps:10000}],products:[{id:11,sku:'P11',name:'架空商品11'},{id:12,sku:'P12',name:'架空商品12'}]};
}
const make=(contracts,month='2026-03',direction='incoming')=>buildMgPortfolio({direction,accountingMonth:month,contracts,works:[{id:1,title:'架空作品1'},{id:2,title:'架空作品2'}]});

test('FR-SETL-MGL-013 portfolio counts guarantees once per contract across products, works and versions, then rolls up parties',()=>{
 const second=contract(2);second.versions=[{...second.versions[0],mg_amount_yen:200}];second.ledger=[entry(10,10,11,'2026-03',150,100,50,40)];
 const third=contract(3,3);third.versions=[{...third.versions[0],mg_amount_yen:0}];third.ledger=[];
 const r=make([contract(),second,third]);
 assert.equal(r.totals.contractCount,3);assert.equal(r.totals.guaranteeYen,1200);assert.equal(r.parties.length,2);
 assert.equal(r.parties[0].guaranteeYen,1200);assert.equal(r.parties[1].guaranteeYen,0);
 assert.equal(r.totals.cumulative.appliedYen,1200);assert.equal(r.totals.current.appliedYen,300);
 // Over-recovery of one contract does not consume another contract's remaining balance.
 assert.equal(r.totals.remainingAppliedYen,100);assert.equal(r.totals.exceedAppliedYen,100);
 const c=r.contracts[0];assert.equal(c.termVersion,2);assert.equal(c.rows.length,3);
 assert.equal(c.appliedRate,1.1);assert.equal(c.eligibleRate,1.5);
 assert.equal(c.appliedReachedMonth,'2026-03');assert.equal(c.eligibleReachedMonth,'2026-02');
 assert.equal(c.rows.reduce((s,r)=>s+r.cumulative.appliedYen,0),1100);
 assert.equal(c.rows.reduce((s,r)=>s+r.evaluationYen,0),1000);
 for(const row of c.rows)for(const key of ['eligibleYen','appliedYen','overageYen','recognizedYen'])assert.equal(row.prior[key]+row.current[key],row.cumulative[key]);
 assert.equal(r.contracts[2].appliedRate,null);assert.equal(r.contracts[2].eligibleReachedMonth,null);
});

test('FR-SETL-MGL-013 baseline uses only started versions and excludes later months from arrival',()=>{
 const r=make([contract()],'2026-01');assert.equal(r.totals.guaranteeYen,800);
 assert.equal(r.contracts[0].appliedReachedMonth,null);assert.equal(r.contracts[0].eligibleReachedMonth,null);
 assert.deepEqual(r.contracts[0].sourceEntryIds,[1]);
 const before=make([contract()],'2025-12');assert.equal(before.contracts.length,0);assert.equal(before.notStartedCount,1);assert.equal(before.totals.guaranteeYen,0);
});

test('full replacement corrections are resolved before month filtering and source rows are not duplicated by allocation',()=>{
 const c=contract();c.ledger.push(entry(4,10,12,'2026-06',300,250,50,40,{reverses_entry_id:2}));
 const r=make([c]);assert.equal(r.totals.cumulative.appliedYen,700);assert.equal(r.contracts[0].appliedReachedMonth,null);
 assert.deepEqual(r.contracts[0].sourceEntryIds,[1,3]);assert.equal(r.contracts[0].sourceEntries.length,2);
 const june=make([c],'2026-06');assert.equal(june.totals.cumulative.appliedYen,950);assert.deepEqual(june.contracts[0].sourceEntryIds,[1,3,4]);
});

test('FR-SETL-MGL-014 direction cannot mix, duplicate contracts and unsafe integer totals are rejected',()=>{
 assert.throws(()=>make([contract(),contract()]),/重複/);
 assert.throws(()=>make([contract()],'2026-03','outgoing'),/別々/);
 const outgoing=contract();outgoing.direction='outgoing';outgoing.party={id:2,code:'SUP-2',name:'架空仕入先'};
 const r=make([outgoing],'2026-03','outgoing');assert.equal(r.parties[0].type,'supplier');assert.equal(r.totals.guaranteeYen,1000);
 const a=contract(),b=contract(2);for(const c of [a,b]){c.versions=[{...c.versions[0],mg_amount_yen:Number.MAX_SAFE_INTEGER}];c.ledger=[];}
 assert.throws(()=>make([a,b]),/安全な整数/);assert.throws(()=>make([],'2026-13'),/計上月/);
});

test('FR-SETL-MGL-021 portfolio sheets export the same financial totals and source lineage with safe HTML/XLSX',()=>{
 const c=contract();c.contract.title='<script>bad()</script>';c.party.name='=HYPERLINK("bad")';
 const report=make([c]),sheets=mgPortfolioSheets(report),bytes=encodeXlsx(sheets);
 assert.equal(sheets[0].rows.at(-1)[3],1000);assert.equal(sheets.find(s=>s.name==='元台帳').rows.length,4);
 assert.equal(sheets.find(s=>s.name==='商品作品別').rows.length,13);
 assert.equal(bytes[0],0x50);assert.equal(bytes[1],0x4b);
 const html=printableReport({title:c.contract.title,sheets,generatedAt:report.generatedAt});
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>bad()'));
});

test('FR-SETL-MGL-014 FR-SETL-MGL-015 API separates incoming and outgoing, enforces every allocated work and never writes',async(t)=>{
 const db=await openTestDb({t});
 try{
  await db.run("INSERT INTO mg_suppliers(id,org_id,code,name,created_by) VALUES(1,1,'SUP-TEST','架空仕入先',1)");
  await db.run("INSERT INTO mg_incoming_contracts(id,org_id,code,title,partner_id,contract_date,source_reference,created_by) VALUES(1,1,'IN-1','架空受取',2,'2026-01-01','TEST',1)");
  await db.run("INSERT INTO mg_outgoing_contracts(id,org_id,code,title,supplier_id,contract_date,source_reference,created_by) VALUES(1,1,'OUT-1','架空支払',1,'2026-01-01','TEST',1)");
  for(const [id,column,amount] of [[1,'incoming_contract_id',1000],[2,'outgoing_contract_id',1200]]){
   await db.run(`INSERT INTO mg_term_versions(id,org_id,${column},version,mode,mg_amount_yen,starts_on,ends_on,reason,source_reference,created_by) VALUES(?,1,1,1,'single',?,'2026-01-01','2026-12-31','架空検証','TEST',1)`,[id,amount]);
   await db.run('INSERT INTO mg_version_products(org_id,term_version_id,product_id,evaluation_yen) VALUES(1,?,1,?)',[id,amount]);
   await db.run("INSERT INTO mg_ledger_entries(org_id,term_version_id,product_id,period_from,period_to,accounting_month,source_reference,reported_eligible_yen,applied_recoup_yen,reported_overage_yen,recognized_yen,status,created_by) VALUES(1,?,1,'2026-01-01','2026-01-31','2026-01','TEST',100,90,10,8,'unverified',1)",[id]);
  }
  const app=new Hono();
  app.use('*',async(c,next)=>{c.set('identity',{org_id:Number(c.req.header('org')||1),role:c.req.header('role')||'admin'});await next()});
  registerMgPortfolioRoutes(app,{db,bad:(c,error,status=400)=>c.json({ok:false,error},status),settlementWork:async(i,workId)=>i.role!=='denied'&&workId===1});
  const before=await writeMark(db);
  const get=(direction,headers={})=>app.request(`/api/rights-reports/mg-portfolio?direction=${direction}&month=2026-01`,{headers});
  const incoming=await(await get('incoming')).json(),outgoing=await(await get('outgoing')).json();
  assert.equal(incoming.report.totals.guaranteeYen,1000);assert.equal(outgoing.report.totals.guaranteeYen,1200);
  assert.equal(incoming.report.parties[0].type,'partner');assert.equal(outgoing.report.parties[0].type,'supplier');
  assert.equal((await get('incoming',{role:'production'})).status,403);
  assert.equal((await(await get('incoming',{role:'denied'})).json()).report.contracts.length,0);
  assert.equal((await(await get('incoming',{org:'2'})).json()).report.contracts.length,0);
  assert.equal((await get('invalid')).status,400);
  assert.deepEqual(await writeMark(db),before);
  await db.run("INSERT INTO works(id,org_id,project_id,code,title,format) VALUES(3,1,1,'PRIVATE-MG','架空別作品','film')");
  await db.run('UPDATE product_works SET allocation_bps=6000 WHERE product_id=1 AND work_id=1');
  await db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,1,3,4000)');
  assert.equal((await(await get('incoming')).json()).report.contracts.length,0);
 }finally{await db.close();}
});
