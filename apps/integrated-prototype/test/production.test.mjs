import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {normalizeProduction,productionPageTotals} from '../src/production.mjs';

async function login(app,email){const response=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0]}
async function request(app,cookie,path,method='GET',payload,headers={}){const response=await app.request(`/api${path}`,{method,headers:{cookie,...(payload?{'content-type':'application/json'}:{}),...headers},body:payload?JSON.stringify(payload):undefined});return {status:response.status,data:await response.json()}}
const empty=()=>({characters:[],locations:[],sceneDetails:[],appearances:[],looks:[],sceneLooks:[],daySlots:[],calls:[]});

test('production graph reuses scene and day identities, retains order and legacy field results',async(t)=>{
  const db=await openTestDb({t}),app=createApp({db,mode:'local'});try{
    const admin=await login(app,'admin@openingnight.invalid'),production=await login(app,'production@openingnight.invalid');
    const s1=await request(app,admin,'/scenes','POST',{project_id:1,work_id:1,scene_no:'P-1',synopsis:'架空の朝',status:'draft'}),s2=await request(app,admin,'/scenes','POST',{project_id:1,work_id:1,scene_no:'P-2',synopsis:'架空の夜',status:'draft'});assert.equal(s1.status,201);assert.equal(s2.status,201);
    const day=await request(app,production,'/field/days','POST',{workId:1,shootDate:'2026-10-01',unit:'A班',label:'第1日',notes:'',assignments:[{sceneId:s2.data.id,sequenceOrder:1,outcome:'planned',notes:'夜景'},{sceneId:s1.data.id,sequenceOrder:2,outcome:'shot',notes:'済'}]});assert.equal(day.status,201);
    const legacyBefore=(await request(app,production,'/field?workId=1')).data;
    const graph={...empty(),characters:[{key:'role1',name:'主人公',short_name:'主'}],locations:[{key:'loc1',name:'架空駅',address:'架空県架空市 1-2-3',green_room:'控室A',parking:'2台'}],sceneDetails:[{scene_id:s1.data.id,page_eighths:10,estimated_minutes:45,location_key:'loc1'},{scene_id:s2.data.id,page_eighths:6,estimated_minutes:20,location_key:'loc1'}],appearances:[{scene_id:s1.data.id,character_key:'role1'},{scene_id:s2.data.id,character_key:'role1'}],looks:[{key:'look1',character_key:'role1',label:'①',makeup:'朝'}],sceneLooks:[{scene_id:s1.data.id,look_key:'look1'},{scene_id:s2.data.id,look_key:'look1'}],daySlots:[{day_id:day.data.dayId,key:'meal1',after_scene_order:1,kind:'meal',label:'昼食',planned_start:'2026-10-01T12:00',planned_end:'2026-10-01T13:00'}],calls:[{day_id:day.data.dayId,character_key:'role1',call_time:'2026-10-01T07:30'}]};
    const save=await request(app,production,'/production/1','PUT',graph,{'If-Match':'0'});assert.equal(save.status,200,JSON.stringify(save.data));
    const reload=await request(app,production,'/production?workId=1');assert.equal(reload.status,200);assert.equal(reload.data.version,1);assert.deepEqual(reload.data.days[0].assignments.map(a=>a.scene_id),[s2.data.id,s1.data.id]);assert.equal(reload.data.pageTotals[0].pageEighths,16);assert.equal(reload.data.sceneLooks.length,2);assert.equal(reload.data.daySlots[0].label,'昼食');assert.equal(reload.data.locations[0].address,'架空県架空市 1-2-3');
    const legacyAfter=(await request(app,production,'/field?workId=1')).data;assert.deepEqual(legacyAfter,legacyBefore);
    assert.equal((await request(app,production,'/production/1','PUT',graph,{'If-Match':'0'})).status,409);
    assert.equal((await request(app,production,'/production/1','PUT',graph)).status,428);
    const invalidClock={...graph,daySlots:[{...graph.daySlots[0],planned_start:'2026-10-01T25:00'}]};assert.equal((await request(app,production,'/production/1','PUT',invalidClock,{'If-Match':'1'})).status,422);
    const nextDay={...graph,daySlots:[{...graph.daySlots[0],planned_start:'2026-10-01T23:50',planned_end:'2026-10-02T00:20'}]};assert.equal((await request(app,production,'/production/1','PUT',nextDay,{'If-Match':'1'})).status,200);
    await db.run("UPDATE project_memberships SET permission='edit' WHERE org_id=1 AND project_id=1 AND user_id=3");assert.equal((await request(app,production,'/production/1','PUT',nextDay,{'If-Match':'2'})).status,403);
    const outsider=await login(app,'outsider@other.invalid');assert.equal((await request(app,outsider,'/production?workId=1')).status,403);assert.equal((await request(app,outsider,'/production/1','PUT',graph,{'If-Match':'1'})).status,403);
  }finally{await db.close()}
});

test('production graph rejects wrong-work references and wardrobe discontinuity atomically',async(t)=>{
  const db=await openTestDb({t}),app=createApp({db,mode:'local'});try{
    const cookie=await login(app,'admin@openingnight.invalid');
    const scene=(await request(app,cookie,'/scenes','POST',{project_id:1,work_id:1,scene_no:'P-GAP',synopsis:'架空',status:'draft'})).data.id;
    const base={...empty(),characters:[{key:'role',name:'役A'}],looks:[{key:'look',character_key:'role',label:'①'}],sceneLooks:[{scene_id:scene,look_key:'look'}]};
    assert.equal((await request(app,cookie,'/production/1','PUT',base,{'If-Match':'0'})).status,422);
    assert.equal((await db.get('SELECT COUNT(*) n FROM production_characters')).n,0);
    const wrong={...empty(),sceneDetails:[{scene_id:999999,page_eighths:8}]};assert.equal((await request(app,cookie,'/production/1','PUT',wrong,{'If-Match':'0'})).status,422);
    assert.equal((await db.get('SELECT COUNT(*) n FROM production_revisions')).n,0);
    assert.throws(()=>normalizeProduction({...empty(),appearances:[{scene_id:scene,character_key:'missing'}]},[scene],[]),/役がありません/);
    assert.deepEqual(productionPageTotals([{id:scene,page_eighths:13}],[{id:1,assignments:[{scene_id:scene}]}]),[{dayId:1,pageEighths:13}]);
  }finally{await db.close()}
});

test('FR-PROD-SCHED-014 confirmed script commit carries reviewed role and estimated minutes into production',async(t)=>{
  const db=await openTestDb({t});const extractDocument=async({name,base64})=>({name,byteLength:Buffer.from(base64,'base64').length,rawSha256:'test-raw-script',extractorName:'fixture',extractorVersion:'1',status:'extracted',documentType:'text',text:'架空台本',scenes:[]});const app=createApp({db,mode:'local',extractDocument});try{
    const cookie=await login(app,'admin@openingnight.invalid');
    const artifact=await request(app,cookie,'/workflow/artifacts/extract','POST',{kind:'script',workId:1,name:'fiction.txt',base64:Buffer.from('fiction').toString('base64')});assert.equal(artifact.status,201);
    const scenes=[{sceneNo:'P-C1',dayNight:'D',location:'架空駅',synopsis:'架空',cast:['役A','役B'],estimatedMinutes:40},{sceneNo:'P-C2',dayNight:'N',location:'架空駅',synopsis:'架空',cast:['役A'],estimatedMinutes:30}];
    const review=await request(app,cookie,`/workflow/scripts/${artifact.data.artifactId}/review`,'PUT',{scenes});assert.equal(review.status,201);
    const preview=await request(app,cookie,`/workflow/scripts/${artifact.data.artifactId}/schedule-preview`,'POST',{reviewId:review.data.reviewId,unit:'A班',dates:[{date:'2026-10-02',budgetMinutes:100}],availability:{cast:{'役A':['2026-10-02'],'役B':['2026-10-02']},locations:{'架空駅':['2026-10-02']}}});assert.equal(preview.status,200);
    const commit=await request(app,cookie,`/workflow/scripts/${artifact.data.artifactId}/commit`,'POST',{token:preview.data.token,confirmed:true});assert.equal(commit.status,201,JSON.stringify(commit.data));
    const production=(await request(app,cookie,'/production?workId=1')).data;assert.equal(production.characters.length,2);assert.equal(production.appearances.length,3);assert.deepEqual(production.scenes.map(s=>s.estimated_minutes),[40,30]);assert.equal(production.version,1);
    assert.equal((await db.get('SELECT COUNT(*) n FROM production_characters WHERE org_id=1 AND work_id=1')).n,2);
  }finally{await db.close()}
});

test('制作の保存は表ごとに複数行の INSERT にまとめ、1文の値は100個まで・見取り図は100KBずつに分ける', async () => {
  const {productionInsertStatements, PRODUCTION_PLAN_STATEMENT_BYTES} = await import('../src/production.mjs');
  // 出演（2列＋組織・作品）は1文に25行まで
  const rows = Array.from({length: 141}, (_, n) => ({scene_id: n + 1, character_key: `role:${n % 20}`}));
  const statements = productionInsertStatements('production_appearances', ['scene_id', 'character_key'], rows, [3, 23]);
  assert.equal(statements.length, 6);
  assert.ok(statements.every((s) => s.params.length <= 100));
  assert.deepEqual(statements.flatMap((s) => { const out = []; for (let i = 0; i < s.params.length; i += 4) out.push(s.params.slice(i, i + 4)); return out; }), rows.map((r) => [3, 23, r.scene_id, r.character_key]));
  assert.match(statements[0].sql, /^INSERT INTO production_appearances\(org_id,work_id,scene_id,character_key\) VALUES \(\?,\?,\?,\?\),/);
  // 見取り図は JSON の合計が100KBを超えない行数ずつ（1行が大きければ1文に1行）
  const big = (key, bytes) => ({location_key: key, strokes_json: 'x'.repeat(bytes)});
  const plans = productionInsertStatements('production_location_plans', ['location_key', 'strokes_json'], [big('a', 60_000), big('b', 60_000), big('c', 10_000), big('d', 200_000)], [1, 1],
    {maxBytes: PRODUCTION_PLAN_STATEMENT_BYTES, sizeOf: (row) => row.strokes_json.length});
  assert.deepEqual(plans.map((s) => s.params.filter((_, i) => i % 4 === 2)), [['a'], ['b', 'c'], ['d']]);
  assert.deepEqual(productionInsertStatements('production_calls', ['day_id'], [], [1, 1]), [], '行が無ければ文も無い');
});
