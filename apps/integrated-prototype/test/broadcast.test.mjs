import {foreignKeyViolations,openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';
import {registerBroadcastRoutes,broadcastConflict,broadcastConflictMap} from '../src/broadcast.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';

// 放送の表（src/broadcast.sql）は LocalDatabase と pg/schema.sql がすでに持つ
async function setup({t}={}){
 const db=await openTestDb({t});
 const app=createApp({db});
 const permittedProjects=async(d,i,finance=false)=>i.role==='admin'?d.all('SELECT id FROM projects WHERE org_id=?',[i.org_id]):d.all(`SELECT p.id FROM projects p JOIN project_memberships pm ON pm.org_id=p.org_id AND pm.project_id=p.id WHERE p.org_id=? AND pm.user_id=? ${finance?"AND pm.permission='edit'":''}`,[i.org_id,i.user_id]);
 const bad=(c,error,status=400)=>c.json({ok:false,error},status),body=c=>c.req.json();
 registerBroadcastRoutes(app,{db,bad,body,permittedProjects});
 const login=async email=>{const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});return r.headers.get('set-cookie').split(';')[0]};
 const admin=await login('admin@openingnight.invalid'),editor=await login('editor@openingnight.invalid'),production=await login('production@openingnight.invalid'),outsider=await login('outsider@other.invalid');
 const call=async(path,{method='GET',body:payload,cookie=admin}={})=>{const r=await app.request('/api/broadcast'+path,{method,headers:{cookie,...(payload?{'content-type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});const type=r.headers.get('content-type')||'';return {status:r.status,data:type.includes('json')?await r.json():type.includes('spreadsheetml')?new Uint8Array(await r.arrayBuffer()):await r.text()}};
 return {db,call,admin,editor,production,outsider};
}
const row=(station='架空中央局')=>({workId:1,broadcastMonth:'2026-11',stationName:station,periodFrom:'2026-11-01',periodTo:'2026-11-30',plannedOn:'2026-11-18',plannedRuns:2,sourceReference:'架空編成表'});
async function created(call,station){const r=await call('/slots',{method:'POST',body:row(station)});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.slotId}
const move=(call,slotId,baseRevision,status,cookie)=>call(`/slots/${slotId}/transition`,{method:'POST',body:{baseRevision,status,reason:'架空確認'},cookie});

test('broadcast lifecycle requires manager approval, preserves revisions, and restricts schedule changes',async(t)=>{const {db,call,editor,production,outsider}=await setup({t});
 assert.equal((await call('/slots',{method:'POST',body:row(),cookie:production})).status,403);
 assert.equal((await call('/slots',{method:'POST',body:row(),cookie:outsider})).status,403);
 const slotId=await created(call);
 assert.equal((await move(call,slotId,1,'tentative')).status,409);
 assert.equal((await move(call,slotId,1,'pending_first',editor)).status,200);
 assert.equal((await move(call,slotId,2,'tentative',editor)).status,403);
 assert.equal((await move(call,slotId,2,'tentative')).status,200);
 assert.equal((await call(`/slots/${slotId}`,{method:'PATCH',body:{baseRevision:3,stationName:'別局'}})).status,409);
 assert.equal((await move(call,slotId,3,'pending_final',editor)).status,200);
 assert.equal((await move(call,slotId,4,'confirmed',editor)).status,403);
 assert.equal((await move(call,slotId,4,'confirmed')).status,200);
 assert.equal((await move(call,slotId,4,'cancelled')).status,409);
 const history=await call(`/slots/${slotId}/history`);assert.equal(history.data.rows.length,5);assert.deepEqual(history.data.rows.map(x=>x.status).reverse(),['draft','pending_first','tentative','pending_final','confirmed']);
 await assert.rejects(db.run('UPDATE broadcast_slot_versions SET station_name=? WHERE slot_id=?',['overwrite',slotId]),e=>e.dbError?.kind==='raise'&&/broadcast version immutable/.test(e.message));
 assert.deepEqual(await foreignKeyViolations(db),[]);
});

test('conflict color compares different stations of same work and month only',async(t)=>{const {db,call}=await setup({t});
 const a=await created(call,'局A'),b=await created(call,'局B');
 // 同じ作品・同じ月・同じ局の2つ目の枠は登録できない（二重登録。broadcast-duplicate.test.mjs で詳しく確かめる）
 assert.equal((await call('/slots',{method:'POST',body:row('局A')})).status,409);
 assert.equal((await call('?workId=1')).data.slots.every(s=>s.conflict===null),true);
 for(const id of [a,b]){assert.equal((await move(call,id,1,'pending_first')).status,200);assert.equal((await move(call,id,2,'tentative')).status,200)}
 let slots=(await call('?workId=1')).data.slots;assert.equal(slots.find(s=>s.slot_id===a).conflict,'yellow');assert.equal(slots.find(s=>s.slot_id===b).conflict,'yellow');assert.equal(slots.length,2);
 for(const id of [a,b]){assert.equal((await move(call,id,3,'pending_final')).status,200);assert.equal((await move(call,id,4,'confirmed')).status,200)}
 slots=(await call('?workId=1')).data.slots;assert.equal(slots.find(s=>s.slot_id===a).conflict,'red');assert.equal(slots.find(s=>s.slot_id===b).conflict,'red');
 assert.equal(broadcastConflict({slot_id:1,work_id:1,broadcast_month:'2026-11',station_name:'A',status:'confirmed'},{slot_id:2,work_id:1,broadcast_month:'2026-11',station_name:'B',status:'confirmed'}),'red');
 assert.equal(broadcastConflictMap([{slot_id:1,work_id:1,broadcast_month:'2026-11',station_name:'A',status:'cancelled'},{slot_id:2,work_id:1,broadcast_month:'2026-11',station_name:'B',status:'confirmed'}]).get(1),null);
});

test('CSV and XLSX roundtrip preserves IDs, previews differences, and never duplicates unchanged rows',async(t)=>{const {db,call,editor}=await setup({t});
 await created(call,'局A');const exported=await call('/export.csv?workId=1');assert.equal(exported.status,200);assert.match(exported.data,/slot_id,revision,work_id,broadcast_month,station_name/);
 const xlsx=await call('/export.xlsx?workId=1');assert.equal(xlsx.status,200);const workbook=decodeXlsx(xlsx.data);assert.equal(workbook[0].rows[1][4],'局A');
 const invalid=exported.data.replace(/\b1,2026-11/,'999,2026-11');assert.equal((await call('/import/preview',{method:'POST',body:{workId:1,csv:invalid}})).status,400);
 const preview=await call('/import/preview',{method:'POST',body:{workId:1,csv:exported.data},cookie:editor});assert.equal(preview.status,200,JSON.stringify(preview.data));assert.equal(preview.data.counts.unchanged,1);
 assert.equal((await call('/import/commit',{method:'POST',body:{token:preview.data.token,confirmed:true},cookie:editor})).status,201);
 assert.equal((await call('/import/commit',{method:'POST',body:{token:preview.data.token,confirmed:true},cookie:editor})).status,410);
 assert.equal((await db.get('SELECT COUNT(*) n FROM broadcast_slots')).n,1);
 const appendCsv=exported.data.replace('1,1,1,2026-11',',,1,2026-11').replace('局A','局B');const add=await call('/import/preview',{method:'POST',body:{workId:1,csv:appendCsv}});assert.equal(add.data.counts.append,1,JSON.stringify(add.data));assert.equal((await call('/import/commit',{method:'POST',body:{token:add.data.token,confirmed:true}})).status,201);
 assert.equal((await db.get('SELECT COUNT(*) n FROM broadcast_slots')).n,2);
});

test('availability XLSX/CSV roundtrip validates registered work and distribution references with versioned updates',async(t)=>{const {db,call,production}=await setup({t});
 await db.run("INSERT INTO sales_availability_versions(org_id,work_id,distribution_code,territory,version_no,release_on,sales_end_on,terms_text,source_reference,exclusivity,status,created_by) VALUES(1,1,'B001','日本',1,'2026-10-01','2027-09-30','架空放送条件','架空契約書','nonexclusive','confirmed',1)");
 const exported=await call('/avails/export.csv');assert.equal(exported.status,200);assert.match(exported.data,/work_id,work_code,work_title,distribution_code/);
 const xlsx=await call('/avails/export.xlsx');assert.equal(xlsx.status,200);assert.equal(decodeXlsx(xlsx.data)[0].rows[1][3],'B001');
 const same=await call('/avails/preview',{method:'POST',body:{csv:exported.data}});assert.equal(same.status,200,JSON.stringify(same.data));assert.equal(same.data.counts.unchanged,1);
 assert.equal((await call('/avails/commit',{method:'POST',body:{token:same.data.token,confirmed:true}})).status,201);
 assert.equal((await db.get('SELECT COUNT(*) n FROM sales_availability_versions')).n,1);
 assert.equal((await call('/avails/preview',{method:'POST',body:{csv:exported.data.replace('B001','BAD-ID')}})).status,400);
 assert.equal((await call('/avails/preview',{method:'POST',body:{csv:exported.data.replace('架空放送条件','改訂条件')},cookie:production})).status,400);
 const changed=await call('/avails/preview',{method:'POST',body:{csv:exported.data.replace('架空放送条件','改訂条件')}});assert.equal(changed.status,200,JSON.stringify(changed.data));assert.equal(changed.data.counts.revise,1);
 assert.equal((await call('/avails/commit',{method:'POST',body:{token:changed.data.token,confirmed:true}})).status,201);
 assert.equal((await db.get('SELECT COUNT(*) n FROM sales_availability_versions')).n,2);
 assert.equal((await db.get('SELECT terms_text FROM sales_availability_versions WHERE version_no=1')).terms_text,'架空放送条件');
 assert.equal((await call('/avails/preview',{method:'POST',body:{csv:exported.data}})).status,400);
 assert.deepEqual(await foreignKeyViolations(db),[]);
});

test('reconciliation links only active broadcast source sales and excludes superseded revenue',async(t)=>{const {db,call,production}=await setup({t});
 const slotId=await created(call);for(const [revision,status] of [[1,'pending_first'],[2,'tentative'],[3,'pending_final'],[4,'confirmed']])assert.equal((await move(call,slotId,revision,status)).status,200);
 const r=await call('/reconciliation?workId=1');assert.equal(r.status,200);assert.equal(r.data.rows[0].reconciliation,'missing');assert.deepEqual(r.data.surplus,[]);
 assert.equal((await call(`/slots/${slotId}/airings`,{method:'POST',body:{airedOn:'2026-11-18',runCount:2,sourceReference:'架空放送確認'}})).status,201);
 assert.equal((await call('/reconciliation?workId=1')).data.rows[0].actual_runs,2);
 assert.equal((await call(`/slots/${slotId}/airings`,{method:'POST',body:{airedOn:'2026-11-20',runCount:1,sourceReference:'上限超過'}})).status,409);
 assert.equal((await call(`/slots/${slotId}/sales`,{method:'POST',body:{saleId:99999}})).status,409);
 const report=await db.get("INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,created_by) VALUES(1,1,1,'BROADCAST-TEST','broadcast','2026-11-01','2026-11-30','2026-11','架空報告','test-broadcast',1) RETURNING id");
 const sale=await db.get("INSERT INTO sale_lines(org_id,project_id,work_id,report_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax) VALUES(1,1,1,?,1,'2026-11-01','2026-11-30','2026-11','架空放送料',200000,20000,220000) RETURNING id",[report.id]);
 assert.equal((await call('/reconciliation?workId=1')).data.surplus.length,1);
 assert.equal((await call(`/slots/${slotId}/sales`,{method:'POST',body:{saleId:sale.id},cookie:production})).status,403);
 assert.equal((await call(`/slots/${slotId}/sales`,{method:'POST',body:{saleId:sale.id}})).status,201);
 let check=(await call('/reconciliation?workId=1')).data;assert.equal(check.rows[0].linked_amount_ex_tax,200000);assert.equal(check.rows[0].reconciliation,'linked');assert.equal(check.surplus.length,0);
 assert.equal((await move(call,slotId,5,'cancelled')).status,200);check=(await call('/reconciliation?workId=1')).data;assert.equal(check.rows[0].reconciliation,'cancelled_linked');
 await db.run("UPDATE report_imports SET status='superseded' WHERE id=?",[report.id]);check=(await call('/reconciliation?workId=1')).data;assert.equal(check.rows[0].linked_amount_ex_tax,0);assert.equal(check.rows[0].superseded_links.length,1);
 assert.deepEqual(await foreignKeyViolations(db),[]);
});
