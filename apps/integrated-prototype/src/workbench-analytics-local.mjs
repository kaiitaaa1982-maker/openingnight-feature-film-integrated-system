import {spawn} from 'node:child_process';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Local, explicitly registered synthetic database only. Never included in Worker.
export function registerLocalWorkbenchAnalytics(app,{db,database,root,python,node,script}){
 let busy=false,lastError=null,jobId=null;
 const json=file=>JSON.parse(readFileSync(file,'utf8'));
 const enabled=()=>{try{const registration=json(database+'.workbench-demo.json');return registration.kind==='workbench-synthetic-v1'&&resolve(registration.database)===resolve(database)&&existsSync(python)}catch{return false}};
 const authorized=c=>c.get('identity')?.role==='admin'&&c.get('identity')?.org_id===1;
 const fail=(c,error,status=400)=>c.json({ok:false,error},status);
 const runPath=id=>{if(!/^[a-f0-9]{32}$/.test(String(id)))throw Error('分析版が不正です');return resolve(root,'runs',id)};
 const checked=id=>{
  const dir=runPath(id),verification=json(resolve(dir,'verification.json'));
  for(const [file,expected] of Object.entries(verification.files)){
   const path=resolve(dir,file);if(!path.startsWith(dir+'/')&&!path.startsWith(dir+'\\'))throw Error('証跡パスが不正です');
   if(createHash('sha256').update(readFileSync(path)).digest('hex')!==expected)throw Error('分析版が検証後に変更されています');
  }
  const snapshot=json(resolve(dir,'snapshot.json'));
  if(snapshot.registrationId!==json(database+'.workbench-demo.json').id)throw Error('別のデータベースの分析版です');
  return {dir,verification,snapshot};
 };
 const guard=fn=>async c=>{if(!authorized(c))return fail(c,'分析同期は架空環境の管理者専用です',403);try{return await fn(c)}catch(e){return fail(c,e.message)}};
 app.get('/api/workbench/analytics/status',guard(async c=>{
  if(!enabled())return c.json({ok:true,enabled:false,busy:false,active:null});
  let active=null;
  if(existsSync(resolve(root,'active.json'))){const pointer=json(resolve(root,'active.json'));const {snapshot,verification}=checked(pointer.runId);const audit=await db.get('SELECT COALESCE(MAX(id),0) id FROM audit_log WHERE org_id=1');let definitionStale=false;for(const [file,expected] of Object.entries(verification.sourceDefinitions||{})){try{if(createHash('sha256').update(readFileSync(resolve(dirname(script),'dbt',file))).digest('hex')!==expected)definitionStale=true}catch{definitionStale=true}}for(const [file,expected] of Object.entries(snapshot.definitions||{})){try{if(createHash('sha256').update(readFileSync(fileURLToPath(new URL('./'+file,import.meta.url)))).digest('hex')!==expected)definitionStale=true}catch{definitionStale=true}}if(verification.runnerHash&&createHash('sha256').update(readFileSync(script)).digest('hex')!==verification.runnerHash)definitionStale=true;active={...pointer,exportedAt:snapshot.exported_at,auditThrough:snapshot.auditThrough,asOf:snapshot.asOf,definitionStale,stale:audit.id!==snapshot.auditThrough||definitionStale,passedTests:verification.passedTests}}
  let lightdash=null;
  if(active){const path=resolve(runPath(active.runId),'lightdash.json');if(existsSync(path)){
   const record=json(path);let changed=false;
   for(const [file,expected] of Object.entries(record.definitions||{})){try{if(createHash('sha256').update(readFileSync(resolve(dirname(script),file))).digest('hex')!==expected)changed=true}catch{changed=true}}
   if(record.snapshotId===active.snapshotId&&record.registrationId===json(database+'.workbench-demo.json').id)lightdash={status:active.stale||changed?'stale':'verified',url:record.url,charts:record.charts,verifiedAt:record.verifiedAt,snapshotId:record.snapshotId};
  }}
  return c.json({ok:true,enabled:true,busy,jobId,lastError,active,lightdash});
 }));
 app.post('/api/workbench/analytics/sync',guard(async c=>{
  if(!enabled())return fail(c,'登録済みの専用架空DBと分析Pythonが必要です');
  if(busy)return fail(c,'分析更新が実行中です',409);
  const input=await c.req.json(),asOf=String(input.asOf||new Date().toISOString().slice(0,10));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf))return fail(c,'確認日を指定してください');
  busy=true;lastError=null;jobId=randomUUID();const currentJob=jobId;
  const child=spawn(python,[script,'sync','--source',database,'--root',root,'--node',node,'--as-of',asOf],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',DBT_SEND_ANONYMOUS_USAGE_STATS:'false'}});
  // Python bounds export/build separately and removes its lock in finally.
  // Killing only Python here could strand dbt and the lock on Windows.
  let output='',error='';const timer=setTimeout(()=>{lastError='分析更新に時間がかかっています。検証済み版を表示しています。'},240_000);
  child.stdout.on('data',chunk=>{if(output.length<16000)output+=chunk});child.stderr.on('data',chunk=>{if(error.length<2000)error+=chunk});
  child.on('error',e=>{clearTimeout(timer);lastError=e.message;busy=false});
  child.on('close',code=>{clearTimeout(timer);if(code!==0){try{lastError=JSON.parse(output.trim().split('\n').at(-1)).error}catch{lastError=error||'分析更新に失敗しました'}}busy=false});
  return c.json({ok:true,jobId:currentJob,status:'running'},202);
 }));
 app.get('/api/workbench/analytics/history',guard(async c=>{
  const runs=[];if(enabled()&&existsSync(resolve(root,'runs')))for(const id of readdirSync(resolve(root,'runs'))){try{const {snapshot,verification}=checked(id);runs.push({runId:id,snapshotId:snapshot.id,verifiedAt:verification.verifiedAt,asOf:snapshot.asOf,exportedAt:snapshot.exported_at})}catch{}}
  return c.json({ok:true,runs:runs.sort((a,b)=>b.verifiedAt.localeCompare(a.verifiedAt))});
 }));
 for(const [route,file,type] of [['report','report.html','text/html; charset=utf-8'],['export','sales.csv','text/csv; charset=utf-8']])app.get('/api/workbench/analytics/'+route,guard(async c=>{
  if(!enabled())return fail(c,'専用架空環境でのみ参照できます');
  const id=c.req.query('runId')||json(resolve(root,'active.json')).runId,{dir}=checked(id);
  c.header('Content-Type',type);if(route==='export')c.header('Content-Disposition','attachment; filename="workbench-sales.csv"');
  return c.body(readFileSync(resolve(dir,'reports',file)));
 }));
}
