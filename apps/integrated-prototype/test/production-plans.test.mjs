import {foreignKeyViolations,openTestDb} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.mjs';
import {normalizeLocationPlans,PLAN_LIMITS,planJsonBytesOf} from '../src/production-plans.mjs';
import {cloudR2Internals} from '../src/cloud-r2-db.mjs';

const stroke=(tool='blue',points=[{x:0.1,y:0.2},{x:0.6,y:0.8}])=>({tool,width:tool==='erase'?0.04:0.006,points});
const graph=()=>({characters:[],locations:[{key:'here',name:'架空ロケ地',address:''}],locationPlans:[{location_key:'here',strokes:[stroke(),stroke('red'),stroke('erase')]}],sceneDetails:[],appearances:[],looks:[],sceneLooks:[],daySlots:[],calls:[]});
const normalize=plans=>normalizeLocationPlans(plans,new Set(['here','second','third']));

test('location plans validate coordinates, tools, references and bounded storage',()=>{
 const plan=graph().locationPlans[0];assert.deepEqual(normalize([plan]),[plan]);
 assert.equal(normalize([{...plan,strokes:[stroke('blue',[{x:0.123456,y:1}])]}])[0].strokes[0].points[0].x,0.1235);
 for(const changed of [{location_key:'another-work'},{strokes:[{...stroke(),tool:'url'}]},{strokes:[{...stroke(),width:0.2}]},{strokes:[stroke('blue',[{x:-0.1,y:0}])]},{strokes:[stroke('blue',[{x:Infinity,y:0}])]},{strokes:[stroke('blue',[])]},{strokes:[stroke('blue',Array.from({length:1001},()=>({x:0,y:0})))]},{strokes:Array.from({length:201},()=>stroke())}])assert.throws(()=>normalize([{...plan,...changed}]));
 assert.throws(()=>normalize([plan,plan]),/重複/);
 const thousand=stroke('blue',Array.from({length:1000},()=>({x:0,y:0})));
 assert.throws(()=>normalize([{...plan,strokes:[...Array.from({length:12},()=>thousand),stroke()]}]),/点数上限/);
 // 作品の点数の上限（1ロケ地は128KB以内に収まる 8000点ずつ × 4か所 = 32000点）
 assert.throws(()=>normalizeLocationPlans(['here','second','third','fourth'].map(location_key=>({location_key,strokes:Array.from({length:8},()=>thousand)})),new Set(['here','second','third','fourth'])),/作品30000/);
 const precise=stroke('red',Array.from({length:1000},()=>({x:0.1234,y:0.5678})));
 assert.throws(()=>normalize([{...plan,strokes:Array.from({length:12},()=>precise)}]),/見取り図（ロケ地 here）は1ロケ地128KB以内です/);
 // 上限は本番の DB 部品（R2BackedD1Database）の1行の上限と同じ。バイト数で数え、ちょうど上限なら通り、1バイト超で落ちる
 assert.ok(PLAN_LIMITS.planJsonBytes<=cloudR2Internals.largeValueBytes);
 const five=Array.from({length:5},()=>precise),six=Array.from({length:6},()=>precise);
 assert.ok(planJsonBytesOf(five)<=PLAN_LIMITS.planJsonBytes&&planJsonBytesOf(six)>PLAN_LIMITS.planJsonBytes,`${planJsonBytesOf(five)}・${planJsonBytesOf(six)}`);
 assert.equal(normalize([{...plan,strokes:five}])[0].strokes.length,5,'上限の中なら通る');
 assert.throws(()=>normalize([{...plan,strokes:six}]),/128KB/);
 assert.throws(()=>normalize([{...plan,extra:'x'.repeat(PLAN_LIMITS.jsonBytes)}]),/2MB/);
});

async function login(app,email){const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]}
async function request(app,cookie,method='GET',body,version,workId=1){const r=await app.request(method==='GET'?`/api/production?workId=${workId}`:`/api/production/${workId}`,{method,headers:{cookie,'content-type':'application/json',...(version==null?{}:{'If-Match':String(version)})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}}

test('plan API saves and reloads, preserves old-client drawings, rejects stale and foreign writes, and clears explicitly',async(t)=>{
 const db=await openTestDb({t}),app=createApp({db});
  const production=await login(app,'production@openingnight.invalid'),outsider=await login(app,'outsider@other.invalid');
  const initial=await request(app,production);assert.deepEqual(initial.data.locationPlans,[]);
  const input=graph();assert.equal((await request(app,production,'PUT',input,0)).status,200);
  const loaded=(await request(app,production)).data;assert.deepEqual(loaded.locationPlans,input.locationPlans);
  const oldClient={...input};delete oldClient.locationPlans;oldClient.locations[0].note='住所なしでも図を保持';
  assert.equal((await request(app,production,'PUT',oldClient,1)).status,200);
  assert.deepEqual((await request(app,production)).data.locationPlans,input.locationPlans);
  assert.equal((await request(app,production,'PUT',{...input,locationPlans:[]},1)).status,409);
  assert.equal((await request(app,production,'PUT',{...input,locationPlans:[{location_key:'foreign',strokes:[stroke()]}]},2)).status,422);
  assert.equal((await request(app,outsider)).status,403);
  assert.equal((await request(app,outsider,'PUT',input,2)).status,403);
  assert.equal((await request(app,production,'PUT',input,0,2)).status,403);
  await db.run("UPDATE project_memberships SET permission='edit' WHERE org_id=1 AND project_id=1 AND user_id=3");
  assert.equal((await request(app,production,'PUT',input,2)).status,403);
  await db.run("UPDATE project_memberships SET permission='production' WHERE org_id=1 AND project_id=1 AND user_id=3");
  assert.equal((await request(app,production,'PUT',{...input,locationPlans:[{location_key:'here',strokes:[]}]},2)).status,200);
  assert.deepEqual((await request(app,production)).data.locationPlans,[{location_key:'here',strokes:[]}]);
  assert.equal((await request(app,production,'PUT',input,3)).status,200);
  // 同じ版への同時の保存は片方だけが通る。どちらが先に通るかは DB が決める（SQLite は順番に、PostgreSQL は並べて処理する）ので、通った方の図が残ることを確かめる
  const race=await Promise.all([request(app,production,'PUT',oldClient,4),request(app,production,'PUT',{...input,locationPlans:[]},4)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  const kept=race[0].status===200?input.locationPlans:[];
  assert.deepEqual((await request(app,production)).data.locationPlans,kept);
  await db.run("DELETE FROM production_locations WHERE org_id=1 AND work_id=1 AND key='here'");
  assert.equal((await db.get('SELECT COUNT(*) n FROM production_location_plans')).n,0);
  assert.deepEqual(await foreignKeyViolations(db),[]);
});

// 見取り図の表の外部キー（ロケ地）・JSON の形（配列）・大きさ（256KB 以下）の CHECK は、両方の DB で書き込みを止める。
// SQLite の DDL を当て直す試験は production-plans-sqlite.test.mjs（SQLite だけ）
test('plan table rejects unknown locations, non-array JSON and oversized drawings on both databases',async(t)=>{
 const db=await openTestDb({t});
 await db.run("INSERT INTO production_locations(org_id,work_id,key,name,address) VALUES(1,1,'before','架空既存地点','既存住所')");
 await assert.rejects(db.run('INSERT INTO production_location_plans(org_id,work_id,location_key,strokes_json) VALUES(?,?,?,?)',[1,1,'missing','[]']),e=>e.dbError?.kind==='foreign_key');
 await assert.rejects(db.run('INSERT INTO production_location_plans(org_id,work_id,location_key,strokes_json) VALUES(?,?,?,?)',[1,1,'before','{}']),e=>e.dbError?.kind==='check');
 await assert.rejects(db.run('INSERT INTO production_location_plans(org_id,work_id,location_key,strokes_json) VALUES(?,?,?,?)',[1,1,'before',JSON.stringify(['x'.repeat(262144)])]),e=>e.dbError?.kind==='check');
 assert.equal((await db.get('SELECT COUNT(*) n FROM production_location_plans')).n,0);
 assert.equal((await db.run('INSERT INTO production_location_plans(org_id,work_id,location_key,strokes_json) VALUES(?,?,?,?)',[1,1,'before','[]'])).changes,1,'形の合う行は入る');
});
