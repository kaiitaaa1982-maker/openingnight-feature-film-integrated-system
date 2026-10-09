import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,realpathSync} from 'node:fs';
import {resolve,relative,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {cloudAnalyticsSql} from '../src/cloud-analytics.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),load=p=>JSON.parse(readFileSync(p,'utf8'));
const sqlText=x=>x==null?'NULL':"'"+String(x).replaceAll("'","''")+"'";
const allowed=p=>/^(analytics\.duckdb|outputs\.json|snapshot\.json|seeds\/[A-Za-z0-9_.-]+\.csv|reports\/[A-Za-z0-9_.-]+|dbt\/(dbt_project\.yml|profiles\.yml|(?:models|tests)\/[A-Za-z0-9_./-]+))$/.test(p)&&!p.split('/').includes('..');

// Produces a local upload bundle and SQL only. No credentials, remote calls, or source edits.
export function prepareHistoryImport({source,out,registrationId}){
 source=resolve(source);out=resolve(out);if(!registrationId)throw Error('登録IDが必要です');if(existsSync(out))throw Error('出力先は新規ディレクトリを指定してください');
 const active=existsSync(resolve(source,'active.json'))?load(resolve(source,'active.json')).runId:null,runs=[],objects=[];
 mkdirSync(out,{recursive:true});
 let sql=cloudAnalyticsSql+'\nINSERT OR IGNORE INTO cloud_analytics_state(org_id) VALUES(1);\n';
 for(const name of readdirSync(resolve(source,'runs')).sort()){
  if(!/^[a-f0-9]{32}$/.test(name))continue;
  const dir=resolve(source,'runs',name);if(!existsSync(resolve(dir,'verification.json')))continue;
  const verification=load(resolve(dir,'verification.json')),snapshot=load(resolve(dir,'snapshot.json'));
  if(verification.status!=='verified'||snapshot.source!=='registered-synthetic-workbench'||snapshot.org_id!==1||snapshot.registrationId!==registrationId)throw Error('分析履歴の登録・組織が一致しません: '+name);
  if(!Number.isSafeInteger(snapshot.auditThrough)||snapshot.auditThrough<0)throw Error('分析境界が不正です');
  const runId=hash(registrationId+':local:'+name).slice(0,32),prefix=`analytics/org-1/runs/${runId}/`,files={};
  for(const [original,expected] of Object.entries(verification.files)){
   const path=original.replaceAll('\\','/');if(!allowed(path))throw Error('履歴パスは許可されていません: '+path);
   const file=realpathSync(resolve(dir,path)),base=realpathSync(dir);if(!file.startsWith(base+sep))throw Error('履歴パスが範囲外です');
   const data=readFileSync(file);if(hash(data)!==expected)throw Error('旧分析版が変更されています: '+path);
   const target=resolve(out,'objects',prefix,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data);files[path]=expected;objects.push({key:prefix+path,file:relative(out,target).replaceAll('\\','/'),sha256:expected});
  }
  for(const required of ['snapshot.json','outputs.json','analytics.duckdb','reports/report.json','reports/report.html','reports/sales.csv'])if(!files[required])throw Error('旧分析版の必須成果物がありません');
  const normalized=JSON.stringify({...verification,files,importedFrom:{kind:'local-verified-history',runId:name}},null,2),manifestHash=hash(normalized),manifestPath=resolve(out,'objects',prefix,'verification.json');writeFileSync(manifestPath,normalized);objects.push({key:prefix+'verification.json',file:relative(out,manifestPath).replaceAll('\\','/'),sha256:manifestHash});
  const created=snapshot.exported_at,finished=verification.verifiedAt;
  sql+=`INSERT OR IGNORE INTO cloud_analytics_jobs(id,org_id,generation,status,as_of,definition_version,audit_through,manifest_hash,created_at,finished_at) VALUES(${sqlText(runId)},1,-1,'verified',${sqlText(snapshot.asOf)},${sqlText('legacy-local:'+verification.runnerHash)},${snapshot.auditThrough},${sqlText(manifestHash)},${sqlText(created)},${sqlText(finished)});\n`;
  if(name===active)sql+=`UPDATE cloud_analytics_state SET active_run=${sqlText(runId)},active_hash=${sqlText(manifestHash)} WHERE org_id=1 AND active_run IS NULL AND lock_job IS NULL;\n`;
  runs.push({sourceRunId:name,runId,active:name===active,manifestHash});
 }
 if(!runs.length)throw Error('検証済み履歴がありません');
 if(active&&!runs.some(r=>r.sourceRunId===active))throw Error('旧activeの検証済み履歴がありません');
 writeFileSync(resolve(out,'import.sql'),sql);writeFileSync(resolve(out,'upload-manifest.json'),JSON.stringify({registrationId,runs,objects,instructions:'Upload all objects with hash verification first; then execute import.sql. Existing active is never overwritten.'},null,2));
 return {runs:runs.length,objects:objects.length,out};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=Object.fromEntries(process.argv.slice(2).reduce((r,v,i,a)=>i%2?r:[...r,[v.replace(/^--/,''),a[i+1]]],[]));
 try{console.log(JSON.stringify({ok:true,...prepareHistoryImport(args)}))}catch(e){console.error(e.message);process.exitCode=1}
}
