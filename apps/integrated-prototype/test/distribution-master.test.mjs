import {foreignKeyViolations,openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseCsv} from '../src/csv.mjs';
import {distributionMasterSql} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
test('provided distribution master preserves 39 IDs, five columns, blank and source hash',async(t)=>{
 const raw=readFileSync(new URL('../fixtures/distribution-master.csv',import.meta.url));const source=parseCsv(raw.toString('utf8')),db=await openTestDb({t});
 // 元の CSV の39行。後から足した流通ID（D007 PVOD）は source_row が0で、照合値の代わりに追加の日付を持つ
 const rows=await db.all('SELECT * FROM distribution_master WHERE source_row>0 ORDER BY source_row');assert.equal(rows.length,39);
 assert.deepEqual((await db.all('SELECT code,distribution_name,transaction_method,sales_type,source_sha256 FROM distribution_master WHERE source_row=0')).map(x=>({...x})),[{code:'D007',distribution_name:'配信',transaction_method:'RS',sales_type:'PVOD',source_sha256:'added-2026-09-25'}]);
 assert.deepEqual(rows.map(x=>[x.code,x.distribution_name,x.transaction_method,x.sales_type,x.notes]),source.map(x=>Object.values(x.values)));
 assert.ok(rows.every(x=>x.source_sha256===createHash('sha256').update(raw).digest('hex')));
 assert.equal(rows.find(x=>x.code==='A003').transaction_method,'MG');assert.equal(rows.find(x=>x.code==='A003').sales_type,'クロスリクープ_RS');assert.equal(rows.find(x=>x.code==='F001').sales_type,'');
 // 生成した SQL（src/distribution-master.sql）を当て直しても39行のまま（LocalDatabase は開くたびに当てる。SQLite の書き方の SQL なので SQLite でだけ当てる。
 // PostgreSQL の土台は pg/schema.sql と pg/local-seed.sql で、上の39行の照合がその中身を確かめる）
 if(db.kind==='sqlite')db.raw.exec(distributionMasterSql);assert.equal((await db.get('SELECT count(*) n FROM distribution_master WHERE source_row>0')).n,39);
 assert.equal((await db.get("SELECT label FROM distribution_types WHERE code='tvod'")).label,'配信・TVOD');assert.deepEqual(await foreignKeyViolations(db),[]);
 await assert.rejects(db.run("UPDATE distribution_master SET sales_type='guess' WHERE code='F001'"),e=>e.dbError?.kind==='raise'&&/explicit migration/.test(e.message));
});
test('FR-REV-ROLL-004 master ID links canonical sales and catalog without changing source amounts or collapsing RSS variants',async(t)=>{
 const db=await openTestDb({t}),app=createApp({db});
 const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})}),cookie=r.headers.get('set-cookie').split(';')[0];
 async function req(path,payload){const res=await app.request('/api'+path,{method:payload?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined});const data=await res.json();assert.ok(res.status<300,JSON.stringify(data));return data}
 const types=(await req('/distribution-types')).rows;assert.equal(types.filter(x=>!x.legacy).length,40);assert.ok(types.some(x=>x.code==='D007'&&/PVOD/.test(x.label)));
 assert.notEqual(types.find(x=>x.code==='R001').label,types.find(x=>x.code==='R002').label);
 await req('/sales',{workId:1,report_key:'MASTER-TEST',kind:'digital',partner_id:2,product_id:1,period_from:'2026-09-01',period_to:'2026-09-30',recognition_basis_id:2,report_received_on:'2026-10-05',basis_reason:'架空受領',amount_ex_tax:1000,tax_amount:100,amount_inc_tax:1100});
 const sale=await db.get('SELECT * FROM sale_lines');await req('/report-center/classifications',{saleId:sale.id,baseVersion:0,distributionCode:'D004',territory:'日本',serviceName:'架空',settlementMethod:'unverified',reason:'指定マスタに照合'});
 const report=await req('/report-center?start=2026-01');assert.equal(report.total,1000);assert.equal(report.byPartner[0].distribution_code,'D004');assert.match(report.byPartner[0].distribution_label,/TVOD/);assert.deepEqual(await db.get('SELECT * FROM sale_lines'),sale);
 for(const code of ['R001','R002'])await req('/sales-catalog',{workId:1,distributionCode:code,territory:'日本',baseVersion:0,status:'draft',terms:'',sourceReference:'架空根拠',exclusivity:'unknown'});
 const catalog=await req('/sales-catalog');assert.equal(catalog.rows.length,2);assert.ok(catalog.rows.every(x=>x.distribution_label.startsWith(x.distribution_code)));
 assert.deepEqual(await foreignKeyViolations(db),[]);
});
