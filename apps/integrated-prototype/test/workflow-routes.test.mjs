import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {openTestDb} from './test-db.mjs';
import {registerWorkflowRoutes} from '../src/workflow.mjs';

const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha256=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const bad=(c,error,status=400,details)=>c.json({ok:false,error,details},status),body=c=>c.req.json(),nowIso=()=>new Date().toISOString();

// 台本・報告書の取り込みの表（src/workflow.sql）は LocalDatabase と pg/schema.sql がすでに持つ
async function fixture({t}={}){
  const db=await openTestDb({t});
  const app=new Hono();app.use('/api/*',async(c,next)=>{c.set('identity',{org_id:Number(c.req.header('x-org')||1),user_id:Number(c.req.header('x-user')||1),role:c.req.header('x-role')||'admin'});await next()});
  const permittedProjects=async(_db,i)=>_db.all('SELECT id FROM projects WHERE org_id=?',[i.org_id]);
  const settlementWork=async(i,workId)=>db.get('SELECT id,project_id FROM works WHERE org_id=? AND id=?',[i.org_id,workId]);
  const extractDocument=async({name,base64})=>{const raw=Buffer.from(base64,'base64'),hash=await sha256(raw.toString('base64'));return {name,byteLength:raw.length,rawSha256:hash,extractorName:'test-local',extractorVersion:'1',status:'extracted',documentType:name.endsWith('.csv')?'workbook':'text',text:'S01',scenes:[{sceneNo:'S01',location:'港',dayNight:'D',synopsis:'架空',cast:[],estimatedMinutes:null}],sheets:name.endsWith('.csv')?[{name:'CSV',rows:[['report id','gross sales'],['R1','1100']]}]:undefined}};
  registerWorkflowRoutes(app,{db,bad,body,canonical,sha256,nowIso,permittedProjects,settlementWork,extractDocument});
  async function req(path,payload,headers={}){const method=payload===undefined?'GET':/\/review$/.test(path)?'PUT':'POST';const response=await app.request(`/api${path}`,{method,headers:{'content-type':'application/json',...headers},body:payload===undefined?undefined:JSON.stringify(payload)});return {status:response.status,data:await response.json()}}
  return {db,req};
}

test('FR-PROD-SCHED-008 FR-PROD-SCHED-010 FR-PROD-SCHED-015 FR-PROD-SCHED-016 script workflow retains raw, isolates org, rejects stale and duplicate commit',async(t)=>{
  const {db,req}=await fixture({t});
  const raw=Buffer.from('S01 / DAY\nfiction').toString('base64'),upload=await req('/workflow/artifacts/extract',{kind:'script',workId:1,name:'draft.txt',base64:raw});assert.equal(upload.status,201);
  const stored=await db.get('SELECT original_base64,raw_sha256 FROM workflow_raw_artifacts WHERE id=?',[upload.data.artifactId]);assert.equal(stored.original_base64,raw);assert.equal(stored.raw_sha256,upload.data.rawHash);
  assert.equal((await req('/workflow/artifacts/extract',{kind:'script',workId:1,name:'copy.txt',base64:raw})).status,409);
  assert.equal((await req(`/workflow/scripts?workId=1`,undefined,{'x-org':'2'})).status,403);
  const scenes=[{sceneNo:'WF-S01',location:'港',dayNight:'D',synopsis:'架空',cast:[],estimatedMinutes:60}];
  const review1=await req(`/workflow/scripts/${upload.data.artifactId}/review`,{scenes});assert.equal(review1.status,201);
  const preview1=await req(`/workflow/scripts/${upload.data.artifactId}/schedule-preview`,{reviewId:review1.data.reviewId,unit:'A班',dates:[{date:'2026-10-01',budgetMinutes:60}],availability:{cast:{},locations:{港:['2026-10-01']}}});assert.equal(preview1.data.proposal.commitAllowed,true);
  const review2=await req(`/workflow/scripts/${upload.data.artifactId}/review`,{scenes:[{...scenes[0],synopsis:'人が修正'}]});assert.equal(review2.status,201);
  assert.equal((await req(`/workflow/scripts/${upload.data.artifactId}/commit`,{token:preview1.data.token,confirmed:true})).status,409);
  const preview2=await req(`/workflow/scripts/${upload.data.artifactId}/schedule-preview`,{reviewId:review2.data.reviewId,unit:'A班',dates:[{date:'2026-10-01',budgetMinutes:60}],availability:{cast:{},locations:{港:['2026-10-01']}}});
  assert.equal((await req(`/workflow/scripts/${upload.data.artifactId}/commit`,{token:preview2.data.token,confirmed:true})).status,201);
  assert.equal((await req(`/workflow/scripts/${upload.data.artifactId}/commit`,{token:preview2.data.token,confirmed:true})).status,410);
  assert.equal((await db.get("SELECT COUNT(1) n FROM scenes WHERE scene_no='WF-S01'")).n,1);
  assert.equal((await db.get('SELECT COUNT(1) n FROM workflow_script_commit_scenes')).n,1);
  assert.equal((await db.get('SELECT COUNT(1) n FROM workflow_script_commit_days')).n,1);
});

test('FR-PROD-SCHED-023 未割当が残る日程案も確定でき、未割当のシーンは撮影日に入れずに登録して理由を確定記録に結ぶ。報告の候補は規則の出どころを正直に示す',async(t)=>{
  const {db,req}=await fixture({t});
  const script=await req('/workflow/artifacts/extract',{kind:'script',workId:1,name:'conflict.txt',base64:Buffer.from('unique conflict').toString('base64')});
  const review=await req(`/workflow/scripts/${script.data.artifactId}/review`,{scenes:[{sceneNo:'WF-C1',location:'港',dayNight:'D',synopsis:'',cast:['A'],estimatedMinutes:60}]});
  const preview=await req(`/workflow/scripts/${script.data.artifactId}/schedule-preview`,{reviewId:review.data.reviewId,unit:'A班',dates:[{date:'2026-10-01',budgetMinutes:60}],availability:{cast:{A:[]},locations:{港:['2026-10-01']}}});assert.equal(preview.data.proposal.commitAllowed,true);assert.deepEqual(preview.data.proposal.unassigned.map(x=>x.sceneNo),['WF-C1']);
  const done=await req(`/workflow/scripts/${script.data.artifactId}/commit`,{token:preview.data.token,confirmed:true});assert.equal(done.status,201);
  assert.deepEqual(done.data.unassigned,[{sceneNo:'WF-C1',reason:'時間予算・出演者・場所の候補日を同時に満たす日がありません'}]);
  const scene=await db.get("SELECT id FROM scenes WHERE org_id=1 AND scene_no='WF-C1'");assert.ok(scene,'未割当のシーンも登録する');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM day_scene_assignments WHERE org_id=1 AND scene_id=?',[scene.id])).n),0,'撮影日には割り当てない');
  const commit=await db.get('SELECT c.id,p.proposal_json FROM workflow_script_commits c JOIN workflow_schedule_previews p ON p.token=c.preview_token WHERE c.org_id=1 AND c.artifact_id=?',[script.data.artifactId]);
  assert.deepEqual(JSON.parse(commit.proposal_json).unassigned.map(x=>x.sceneNo),['WF-C1'],'未割当の理由を確定記録（の控え）に結ぶ');
  assert.equal(JSON.parse((await db.get("SELECT detail_json FROM audit_log WHERE entity_type='workflow_script_commit' AND entity_id=?",[String(commit.id)])).detail_json).unassignedCount,1);
  const report=await req('/workflow/artifacts/extract',{kind:'sales_report',workId:1,name:'raw.csv',base64:Buffer.from('unique report').toString('base64')});
  assert.equal((await req(`/workflow/reports/${report.data.artifactId}/selection`,{sheetName:'CSV',headerRow:1,useConfiguredAi:true})).status,503);
  const selection=await req(`/workflow/reports/${report.data.artifactId}/selection`,{sheetName:'CSV',headerRow:1});assert.equal(selection.status,201);assert.equal(selection.data.suggestionSource,'rule-based');assert.equal(selection.data.actualAiUsed,false);
  assert.equal((await req(`/workflow/reports/${report.data.artifactId}/selection`,{sheetName:'CSV',headerRow:1},{'x-role':'production'})).status,403);
});

test('FR-PROD-SCHED-004 FR-PROD-SCHED-007 FR-PROD-SCHED-011 FR-PROD-SCHED-014 2話持ち: 後の話数は同じ日付の撮影日に追記し、時間予算から登録済みの分を引く。S#が重なる・撮影日が変わったら止める',async(t)=>{
  const {db,req}=await fixture({t});
  const scene=(sceneNo,estimatedMinutes,pageEighths=null)=>({sceneNo,location:'港',dayNight:'D',synopsis:'架空',cast:[],estimatedMinutes,pageEighths});
  const plan=async(name,scenes,budgetMinutes=120)=>{const up=await req('/workflow/artifacts/extract',{kind:'script',workId:1,name,base64:Buffer.from(name).toString('base64')});const review=await req(`/workflow/scripts/${up.data.artifactId}/review`,{scenes});const preview=await req(`/workflow/scripts/${up.data.artifactId}/schedule-preview`,{reviewId:review.data.reviewId,unit:'A班',dates:[{date:'2026-10-01',budgetMinutes}],availability:{cast:{},locations:{港:['2026-10-01']}}});return {artifactId:up.data.artifactId,preview}};
  const commit=(p)=>req(`/workflow/scripts/${p.artifactId}/commit`,{token:p.preview.data.token,confirmed:true});
  const ep7=await plan('ep7.txt',[scene('7-1',60,3)]);
  assert.equal((await commit(ep7)).status,201);
  assert.equal((await db.get("SELECT d.page_eighths FROM production_scene_details d JOIN scenes s ON s.id=d.scene_id WHERE s.scene_no='7-1'")).page_eighths,3);
  const clash=await plan('ep7-again.txt',[scene('7-1',30)]);
  assert.equal(clash.preview.status,409);assert.match(clash.preview.data.error,/登録済みのシーン番号があります: 7-1/);
  const ep8=await plan('ep8.txt',[scene('8-1',40),scene('8-2',20)]);
  const day=ep8.preview.data.proposal.days[0];
  assert.equal(day.existingMinutes,60);assert.equal(day.remainingMinutes,0);assert.ok(day.existingDayId);assert.equal(ep8.preview.data.proposal.commitAllowed,true);
  const done=await commit(ep8);assert.equal(done.status,201);assert.equal(done.data.reusedDayCount,1);
  assert.equal((await db.get('SELECT COUNT(1) n FROM shooting_days')).n,1);
  assert.deepEqual((await db.all('SELECT s.scene_no,a.sequence_order FROM day_scene_assignments a JOIN scenes s ON s.id=a.scene_id ORDER BY a.sequence_order')).map(r=>[r.scene_no,r.sequence_order]),[['7-1',1],['8-1',2],['8-2',3]]);
  // 残りの無い日には入らない
  const full=await plan('ep9.txt',[scene('9-1',10)]);assert.deepEqual(full.preview.data.proposal.unassigned.map(x=>x.sceneNo),['9-1']);assert.deepEqual(full.preview.data.proposal.days[0].scenes,[]);
  // 日程案を作ったあとに撮影日が変わったら確定しない
  const later=await plan('ep9b.txt',[scene('9-2',10)],200);assert.equal(later.preview.data.proposal.commitAllowed,true);
  await db.run('UPDATE shooting_days SET version=version+1');
  const stale=await commit(later);assert.equal(stale.status,409);assert.match(stale.data.error,/撮影日が日程案を作ったあとに更新/);
});
