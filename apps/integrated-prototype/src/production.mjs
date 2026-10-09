import {normalizeLocationPlans} from './production-plans.mjs';
const integer=(v,label)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)throw Error(`${label}を確認してください`);return n};
const optionalInteger=(v,label,max)=>{if(v==null||v==='')return null;const n=Number(v);if(!Number.isSafeInteger(n)||n<0||n>max)throw Error(`${label}を確認してください`);return n};
const string=(v,label,max=500,required=false)=>{if(v!=null&&typeof v!=='string')throw Error(`${label}を確認してください`);const s=(v||'').trim();if(s.length>max||(required&&!s))throw Error(`${label}を確認してください`);return s||null};
const key=v=>{const s=string(v,'識別子',320,true);if(/[\u0000-\u001f]/.test(s))throw Error('識別子を確認してください');return s};
const clock=(v,label)=>{const s=string(v,label,16);if(!s)return null;const match=/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)$/.exec(s);if(!match)throw Error(`${label}を確認してください`);const date=new Date(`${match[1]}T00:00:00Z`);if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==match[1]||Number(match[2])>23||Number(match[3])>59)throw Error(`${label}を確認してください`);return s};
const onShootOrNext=(value,dayId,dayDates)=>{if(!value||!dayDates.has(dayId))return;const shoot=dayDates.get(dayId),next=new Date(`${shoot}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);if(![shoot,next.toISOString().slice(0,10)].includes(value.slice(0,10)))throw Error('日時は撮影日または翌日で入力してください')};
const list=(v,label,max=1000)=>{if(!Array.isArray(v)||v.length>max)throw Error(`${label}を確認してください`);return v};
const distinct=(rows,pick,label)=>{const seen=new Set();for(const row of rows){const k=pick(row);if(seen.has(k))throw Error(`${label}が重複しています`);seen.add(k)}};

export function normalizeProduction(input,sceneIds,dayIds){
  const sceneSet=new Set(sceneIds),daySet=new Set(dayIds.map(x=>typeof x==='object'?x.id:x)),dayDates=new Map(dayIds.filter(x=>typeof x==='object').map(x=>[x.id,x.shoot_date]));
  const characters=list(input.characters,'役',300).map(x=>({key:key(x.key),name:string(x.name,'役名',120,true),short_name:string(x.short_name,'略称',30),actor_name:string(x.actor_name,'俳優名',120),note:string(x.note,'役の備考',1000)}));
  distinct(characters,x=>x.key,'役ID');distinct(characters,x=>x.name,'役名');const characterSet=new Set(characters.map(x=>x.key));
  const locations=list(input.locations,'ロケ地',300).map(x=>({key:key(x.key),name:string(x.name,'ロケ地名',160,true),address:string(x.address,'住所',500),floor:string(x.floor,'階',80),green_room:string(x.green_room,'控室',300),parking:string(x.parking,'駐車',300),facilities:string(x.facilities,'設備',1000),contact:string(x.contact,'連絡先',300),note:string(x.note,'ロケ地備考',1000)}));
  distinct(locations,x=>x.key,'ロケ地ID');distinct(locations,x=>x.name,'ロケ地名');const locationSet=new Set(locations.map(x=>x.key));
  const locationPlans=normalizeLocationPlans(input.locationPlans===undefined?[]:input.locationPlans,locationSet);
  const details=list(input.sceneDetails,'シーン詳細').map(x=>{const scene_id=integer(x.scene_id,'シーン');if(!sceneSet.has(scene_id))throw Error('別作品のシーンです');const location_key=x.location_key?key(x.location_key):null;if(location_key&&!locationSet.has(location_key))throw Error('ロケ地がありません');return {scene_id,page_eighths:optionalInteger(x.page_eighths,'ページ数',80000),estimated_minutes:optionalInteger(x.estimated_minutes,'予定尺',10000),location_key,note:string(x.note,'シーン備考',1000)}});
  if(details.some(x=>x.estimated_minutes===0))throw Error('予定尺は1分以上です');distinct(details,x=>x.scene_id,'シーン詳細');
  const appearances=list(input.appearances,'出演',3000).map(x=>{const scene_id=integer(x.scene_id,'シーン'),character_key=key(x.character_key);if(!sceneSet.has(scene_id)||!characterSet.has(character_key))throw Error('出演のシーンまたは役がありません');return {scene_id,character_key}});
  distinct(appearances,x=>`${x.scene_id}\u0000${x.character_key}`,'出演');const appearanceSet=new Set(appearances.map(x=>`${x.scene_id}\u0000${x.character_key}`));
  const looks=list(input.looks,'衣装',1000).map(x=>{const character_key=key(x.character_key);if(!characterSet.has(character_key))throw Error('衣装の役がありません');return {key:key(x.key),character_key,label:string(x.label,'衣装番号',100,true),makeup:string(x.makeup,'メイク',500),props:string(x.props,'持ち道具',500),shoes:string(x.shoes,'靴',300),accessories:string(x.accessories,'装飾品',300),note:string(x.note,'衣装備考',1000)}});
  distinct(looks,x=>x.key,'衣装ID');distinct(looks,x=>`${x.character_key}\u0000${x.label}`,'役の衣装番号');const lookMap=new Map(looks.map(x=>[x.key,x]));
  const sceneLooks=list(input.sceneLooks,'着用シーン',3000).map(x=>{const scene_id=integer(x.scene_id,'シーン'),look_key=key(x.look_key),look=lookMap.get(look_key);if(!sceneSet.has(scene_id)||!look||!appearanceSet.has(`${scene_id}\u0000${look.character_key}`))throw Error('衣装は出演する役のシーンへ指定してください');return {scene_id,look_key}});
  distinct(sceneLooks,x=>`${x.scene_id}\u0000${x.look_key}`,'着用シーン');
  const daySlots=list(input.daySlots,'日々スケ項目',1000).map(x=>{const day_id=integer(x.day_id,'撮影日');if(!daySet.has(day_id))throw Error('別作品の撮影日です');const after_scene_order=optionalInteger(x.after_scene_order,'撮影順',10000);if(after_scene_order==null)throw Error('撮影順を確認してください');if(!['move','meal','wrap','prep','other'].includes(x.kind))throw Error('日々スケ項目の種類を確認してください');const row={day_id,key:key(x.key),after_scene_order,kind:x.kind,label:string(x.label,'項目名',160,true),planned_start:clock(x.planned_start,'予定開始'),planned_end:clock(x.planned_end,'予定終了'),actual_start:clock(x.actual_start,'実績開始'),actual_end:clock(x.actual_end,'実績終了'),note:string(x.note,'項目備考',1000)};for(const value of [row.planned_start,row.planned_end,row.actual_start,row.actual_end])onShootOrNext(value,day_id,dayDates);if(row.planned_start&&row.planned_end&&row.planned_end<=row.planned_start)throw Error('予定終了を開始より後にしてください');if(row.actual_start&&row.actual_end&&row.actual_end<=row.actual_start)throw Error('実績終了を開始より後にしてください');return row});
  distinct(daySlots,x=>`${x.day_id}\u0000${x.key}`,'日々スケ項目');
  const calls=list(input.calls,'入り時間',2000).map(x=>{const day_id=integer(x.day_id,'撮影日'),character_key=key(x.character_key);if(!daySet.has(day_id)||!characterSet.has(character_key))throw Error('入り時間の撮影日または役がありません');const row={day_id,character_key,call_time:clock(x.call_time,'入り時間'),ready_time:clock(x.ready_time,'支度完了'),note:string(x.note,'入り時間備考',500)};onShootOrNext(row.call_time,day_id,dayDates);onShootOrNext(row.ready_time,day_id,dayDates);return row});
  distinct(calls,x=>`${x.day_id}\u0000${x.character_key}`,'入り時間');
  return {characters,locations,locationPlans,sceneDetails:details,appearances,looks,sceneLooks,daySlots,calls};
}

export function productionPageTotals(scenes,days){const map=new Map(scenes.map(s=>[s.id,s]));return days.map(day=>({dayId:day.id,pageEighths:day.assignments.reduce((n,a)=>n+(map.get(a.scene_id)?.page_eighths||0),0)}))}

export function productionCommitStatements(orgId,workId,scenes,sceneIds){
  const statements=[];
  for(const name of new Set(scenes.flatMap(scene=>scene.cast||[])))statements.push({sql:'INSERT INTO production_characters(org_id,work_id,key,name) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',params:[orgId,workId,`role:${name}`,name]});
  for(const scene of scenes){const sceneId=sceneIds.get(scene.sceneNo);if(scene.estimatedMinutes!=null||scene.pageEighths!=null)statements.push({sql:'INSERT INTO production_scene_details(org_id,work_id,scene_id,estimated_minutes,page_eighths) VALUES(?,?,?,?,?)',params:[orgId,workId,sceneId,scene.estimatedMinutes??null,scene.pageEighths??null]});for(const name of scene.cast||[])statements.push({sql:'INSERT INTO production_appearances(org_id,work_id,scene_id,character_key) SELECT ?,?,?,key FROM production_characters WHERE org_id=? AND work_id=? AND name=?',params:[orgId,workId,sceneId,orgId,workId,name]})}
  statements.push({sql:'INSERT INTO production_revisions(org_id,work_id,version) VALUES(?,?,1) ON CONFLICT(org_id,work_id) DO UPDATE SET version=production_revisions.version+1',params:[orgId,workId]});
  return statements;
}

// 保存は「全行を消して入れ直す」を1回の batch に積む。D1 の上限（1文の束縛値100個・本番の1回の batch は500文）に掛からないよう、
// 表ごとに複数行の INSERT にまとめる（1文の値は100個まで）。見取り図は1行が大きいので、JSON の合計が100KBを超えない行数ずつにする。
// 例: 架空の連続ドラマ DEMO-D78（58シーン・出演141・入り時間57）は、1行1文だと493文だったが、まとめると50文前後になる
export const PRODUCTION_MAX_BOUND_VALUES=100;
export const PRODUCTION_PLAN_STATEMENT_BYTES=100*1024;
export function productionInsertStatements(table,columns,rows,scope,{maxValues=PRODUCTION_MAX_BOUND_VALUES,maxBytes=Infinity,sizeOf=()=>0}={}){
  const names=['org_id','work_id',...columns],perRow=names.length;
  if(perRow>maxValues)throw Error(`${table} の列が多すぎます`);
  const rowsPer=Math.floor(maxValues/perRow),statements=[];
  let chunk=[],bytes=0;
  const flush=()=>{if(!chunk.length)return;const marks=`(${names.map(()=>'?').join(',')})`;statements.push({sql:`INSERT INTO ${table}(${names.join(',')}) VALUES ${chunk.map(()=>marks).join(',')}`,params:chunk.flatMap(row=>[...scope,...columns.map(name=>row[name])])});chunk=[];bytes=0};
  for(const row of rows){const size=sizeOf(row);if(chunk.length&&(chunk.length>=rowsPer||bytes+size>maxBytes))flush();chunk.push(row);bytes+=size}
  flush();
  return statements;
}
// 1回で保存できる処理の数を超えたときの文言（件数が原因だと分かるように。版の衝突の文言は使わない）
export const productionTooLargeMessage=(count,limit)=>`制作情報の件数が多すぎて、1回で保存できません（保存の処理 ${count}件・上限 ${limit}件）。見取り図の画数や日々スケの行を減らしてから、もう一度保存してください`;

export function registerProductionRoutes(app,{db,bad,body,permittedProjects}){
  async function workFor(identity,workId,write=false){const work=await db.get('SELECT id,project_id FROM works WHERE org_id=? AND id=?',[identity.org_id,workId]);if(!work)return null;const allowed=await permittedProjects(db,identity,false);if(!allowed.some(p=>p.id===work.project_id))return null;if(!write||identity.role==='admin')return work;if(!['production','editor'].includes(identity.role))return null;const grant=await db.get('SELECT permission FROM project_memberships WHERE org_id=? AND project_id=? AND user_id=? AND (expires_at IS NULL OR expires_at>?)',[identity.org_id,work.project_id,identity.user_id,new Date().toISOString()]);return grant&&(identity.role==='production'?grant.permission==='production':['production','edit'].includes(grant.permission))?work:null}
  app.get('/api/production',async c=>{const i=c.get('identity');let workId;try{workId=integer(c.req.query('workId'),'作品')}catch(e){return bad(c,e.message,400,undefined,e)}if(!await workFor(i,workId))return bad(c,'作品への権限がありません',403);const scope=[i.org_id,workId];const [revision,scenes,days,assignments,characters,locations,locationPlans,sceneDetails,appearances,looks,sceneLooks,daySlots,calls]=await Promise.all([
    db.get('SELECT version FROM production_revisions WHERE org_id=? AND work_id=?',scope),
    db.all('SELECT * FROM scenes WHERE org_id=? AND work_id=? ORDER BY scene_no',scope),
    db.all('SELECT * FROM shooting_days WHERE org_id=? AND work_id=? ORDER BY shoot_date,unit,id',scope),
    db.all('SELECT a.* FROM day_scene_assignments a WHERE a.org_id=? AND a.work_id=? ORDER BY a.shooting_day_id,a.sequence_order',scope),
    db.all('SELECT * FROM production_characters WHERE org_id=? AND work_id=? ORDER BY name',scope),
    db.all('SELECT * FROM production_locations WHERE org_id=? AND work_id=? ORDER BY name',scope),
    db.all('SELECT location_key,strokes_json FROM production_location_plans WHERE org_id=? AND work_id=? ORDER BY location_key',scope),
    db.all('SELECT * FROM production_scene_details WHERE org_id=? AND work_id=?',scope),
    db.all('SELECT * FROM production_appearances WHERE org_id=? AND work_id=?',scope),
    db.all('SELECT * FROM production_looks WHERE org_id=? AND work_id=? ORDER BY character_key,label',scope),
    db.all('SELECT * FROM production_scene_looks WHERE org_id=? AND work_id=?',scope),
    db.all('SELECT * FROM production_day_slots WHERE org_id=? AND work_id=? ORDER BY day_id,after_scene_order',scope),
    db.all('SELECT * FROM production_calls WHERE org_id=? AND work_id=?',scope)
  ]);const detailed=scenes.map(scene=>({...scene,...sceneDetails.find(d=>d.scene_id===scene.id)}));return c.json({ok:true,version:revision?.version||0,scenes:detailed,days:days.map(day=>({...day,assignments:assignments.filter(a=>a.shooting_day_id===day.id)})),characters,locations,locationPlans:locationPlans.map(p=>({location_key:p.location_key,strokes:JSON.parse(p.strokes_json)})),sceneDetails,appearances,looks,sceneLooks,daySlots,calls,pageTotals:productionPageTotals(detailed,days.map(day=>({...day,assignments:assignments.filter(a=>a.shooting_day_id===day.id)})))});
  });
  app.put('/api/production/:workId',async c=>{const i=c.get('identity');let workId;try{workId=integer(c.req.param('workId'),'作品')}catch(e){return bad(c,e.message,400,undefined,e)}const work=await workFor(i,workId,true);if(!work)return bad(c,'作品の制作編集権限がありません',403);const header=c.req.header('If-Match');if(header==null||header.trim()==='')return bad(c,'If-Matchに現在の版が必要です',428);const expected=Number(header);if(!Number.isSafeInteger(expected)||expected<0)return bad(c,'If-Matchに現在の版が必要です',428);const input=await body(c),scope=[i.org_id,workId],scenes=await db.all('SELECT id FROM scenes WHERE org_id=? AND work_id=?',scope),days=await db.all('SELECT id,shoot_date FROM shooting_days WHERE org_id=? AND work_id=?',scope);let normalized;try{if(!Object.hasOwn(input,'locationPlans')){const retained=new Set((Array.isArray(input.locations)?input.locations:[]).map(l=>l.key));input.locationPlans=(await db.all('SELECT location_key,strokes_json FROM production_location_plans WHERE org_id=? AND work_id=?',scope)).filter(p=>retained.has(p.location_key)).map(p=>({location_key:p.location_key,strokes:JSON.parse(p.strokes_json)}))}normalized=normalizeProduction(input,scenes.map(x=>x.id),days)}catch(e){return bad(c,e.message,422,undefined,e)}const current=(await db.get('SELECT version FROM production_revisions WHERE org_id=? AND work_id=?',scope))?.version||0;if(current!==expected)return bad(c,'別の利用者が更新しました。再読込してください',409);const statements=[{sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE ?<>COALESCE((SELECT version FROM production_revisions WHERE org_id=? AND work_id=?),0)',params:[expected,...scope]}];
    for(const table of ['production_location_plans','production_scene_looks','production_looks','production_appearances','production_scene_details','production_calls','production_day_slots','production_characters','production_locations'])statements.push({sql:`DELETE FROM ${table} WHERE org_id=? AND work_id=?`,params:scope});
    const add=(table,columns,rows,options)=>statements.push(...productionInsertStatements(table,columns,rows,scope,options));
    add('production_characters',['key','name','short_name','actor_name','note'],normalized.characters);
    add('production_locations',['key','name','address','floor','green_room','parking','facilities','contact','note'],normalized.locations);
    add('production_location_plans',['location_key','strokes_json'],normalized.locationPlans.map(p=>({location_key:p.location_key,strokes_json:JSON.stringify(p.strokes)})),{maxBytes:PRODUCTION_PLAN_STATEMENT_BYTES,sizeOf:row=>new TextEncoder().encode(row.strokes_json).byteLength});
    add('production_scene_details',['scene_id','page_eighths','estimated_minutes','location_key','note'],normalized.sceneDetails);
    add('production_appearances',['scene_id','character_key'],normalized.appearances);
    add('production_looks',['key','character_key','label','makeup','props','shoes','accessories','note'],normalized.looks);
    add('production_scene_looks',['scene_id','look_key'],normalized.sceneLooks);
    add('production_day_slots',['day_id','key','after_scene_order','kind','label','planned_start','planned_end','actual_start','actual_end','note'],normalized.daySlots);
    add('production_calls',['day_id','character_key','call_time','ready_time','note'],normalized.calls);
    statements.push({sql:'INSERT INTO production_revisions(org_id,work_id,version) VALUES(?,?,?) ON CONFLICT(org_id,work_id) DO UPDATE SET version=excluded.version',params:[...scope,expected+1]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'update','production_workspace',String(workId),JSON.stringify({beforeVersion:expected,afterVersion:expected+1,counts:Object.fromEntries(Object.entries(normalized).map(([k,v])=>[k,v.length]))})]});
    const limit=Number(db.maxBatchStatements);if(Number.isSafeInteger(limit)&&limit>0&&statements.length>limit)return bad(c,productionTooLargeMessage(statements.length,limit),413,{statements:statements.length,limit});
    try{await db.batch(statements)}catch(e){const over=/atomic batch exceeds (\d+)/.exec(String(e?.message||''));if(over)return bad(c,productionTooLargeMessage(statements.length,Number(over[1])),413,{statements:statements.length,limit:Number(over[1])});
      // 1行の値が D1 の上限（128KB）を超えた（見取り図など）。「再読込して」ではなく、何を減らせばよいかを返す
      if(/D1行内サイズ上限/.test(String(e?.message||'')))return bad(c,'見取り図が大きすぎて保存できません。画を減らしてください',413,{cause:e.message,table:'production_location_plans',column:'strokes_json'});
      return bad(c,'更新できませんでした。再読込して内容を確認してください',409,{cause:e.message})}return c.json({ok:true,version:expected+1});
  });
}
