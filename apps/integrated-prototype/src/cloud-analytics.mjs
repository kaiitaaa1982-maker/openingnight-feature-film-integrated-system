import {isDbConflict} from './data-platform/db-errors.mjs';
// Worker-safe coordination. R2 artifacts are immutable; only D1 selects the active run.
export const cloudAnalyticsSql = `
CREATE TABLE IF NOT EXISTS cloud_analytics_state(org_id INTEGER PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,lock_job TEXT,lock_until TEXT,active_run TEXT,active_hash TEXT);
CREATE TABLE IF NOT EXISTS cloud_analytics_jobs(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,as_of TEXT NOT NULL,definition_version TEXT NOT NULL,audit_through INTEGER,manifest_hash TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
CREATE INDEX IF NOT EXISTS cloud_analytics_jobs_org ON cloud_analytics_jobs(org_id,created_at);
`;
// Every name and column is code-owned. Never export sessions, users, credentials or raw artifacts.
export const snapshotTables = {
 committee_report_snapshots:'id,org_id,work_id,contract_id,term_version_id,period_index,period_from,period_to,close_on,report_on,payment_on,status,verification,calculation_version,calculation_json',
 committee_snapshot_member_amounts:'org_id,snapshot_id,window_id,partner_id,share_bps,amount_yen,route',
 committee_snapshot_lines:'org_id,snapshot_id,work_id,report_id,sale_id,window_id,allocated_amount_ex_tax,accounting_month',
 mg_term_versions:'id,org_id,incoming_contract_id,outgoing_contract_id,version,mode,mg_amount_yen,starts_on,ends_on,special_unverified',
 mg_version_products:'org_id,term_version_id,product_id,evaluation_yen',
 mg_ledger_entries:'id,org_id,term_version_id,product_id,accounting_month,reported_eligible_yen,applied_recoup_yen,reported_overage_yen,recognized_yen,status,reverses_entry_id',
 projects:'id,org_id', works:'id,org_id,project_id,code,title', partners:'id,org_id,code,name', products:'id,org_id,sku,name',
 product_works:'org_id,product_id,work_id,allocation_bps', report_imports:'id,org_id,kind,status',
 sale_lines:'id,org_id,work_id,report_id,product_id,partner_id,accounting_month,amount_ex_tax,source_row',
 sale_distribution_versions:'org_id,sale_id,version_no,distribution_code,territory,service_name,settlement_method',
 report_sale_dimensions_versions:'org_id,sale_id,version_no,department_name',
 expenses:'id,org_id,project_id,work_id,accounting_month,category,budget_yen,actual_ex_tax,tax_amount,actual_inc_tax',
 distribution_types:'code,label,family,utilization,sort_order', distribution_master:'code,distribution_name,transaction_method,sales_type,notes,source_sha256,source_row',
 billing_invoices:'id,org_id,invoice_number,partner_id,invoice_date,due_date,amount_inc_tax,status',
 billing_invoice_line_works:'org_id,invoice_id,work_id', billing_invoice_voids:'org_id,invoice_id,voided_on',
 billing_receipts:'id,org_id,received_on,reference', billing_receipt_allocations:'org_id,receipt_id,invoice_id,amount_yen',
 billing_receipt_reversals:'org_id,receipt_id,reversed_on', receipt_plan_requests:'id,org_id,invoice_id,proposed_due_date',
 receipt_plan_decisions:'org_id,request_id,invoice_id,decision,version_no,effective_on,reason,created_by,created_at'
};
export async function sha256(value){const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')}
const json=JSON.stringify;
const globalTables=new Set(['distribution_types','distribution_master']);
const safePath=p=>typeof p==='string'&&/^[A-Za-z0-9_.\/-]+$/.test(p)&&!p.startsWith('/')&&!p.split('/').some(x=>!x||x==='.'||x==='..');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const date=s=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw fail('確認日が不正です');return s};
const bytesFromBase64=s=>{if(typeof s!=='string'||s.length>48*1024*1024||s.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))throw fail('成果物の符号化が不正です');return Uint8Array.from(atob(s),x=>x.charCodeAt(0))};

// 写しの表・監査の上限・管理者の確かめを、入口の読み取りの一括（db.readBatch）で1つの時点から読む（FR-CORE-DATA-009・010）。
// D1 の入口は素の batch を1回、PostgreSQL の入口は READ ONLY・REPEATABLE READ のトランザクションで流す。入口の all を並べても1つの時点にならない
export async function freezeAnalyticsSnapshot({db,orgId,registrationId,definitionVersion,runId,asOf,userId}){
 const entries=Object.entries(snapshotTables);
 const statements=entries.map(([table,columns])=>({sql:`SELECT ${columns} FROM ${table}${globalTables.has(table)?'':' WHERE org_id=?'}`,params:globalTables.has(table)?[]:[orgId]}));
 statements.push({sql:'SELECT COALESCE(MAX(id),0) audit_through FROM audit_log WHERE org_id=?',params:[orgId]});
 statements.push({sql:"SELECT 1 allowed FROM memberships WHERE org_id=? AND user_id=? AND active=1 AND role='admin' AND (expires_at IS NULL OR expires_at>?)",params:[orgId,userId,new Date().toISOString()]});
 const results=await db.readBatch(statements);
 if(!Array.isArray(results)||results.length!==statements.length||results.some(rows=>!Array.isArray(rows)))throw fail('分析入力の一括抽出に失敗しました');
 if(!results.at(-1).length)throw fail('分析抽出権限が失効しています',403);
 const tables=Object.fromEntries(entries.map(([name,columns],index)=>[name,{columns:columns.split(','),rows:results[index]}]));
 let count=0;for(const [name,t] of Object.entries(tables)){count+=t.rows.length;if(t.rows.some(r=>!globalTables.has(name)&&r.org_id!==orgId))throw fail('抽出組織が一致しません',403)}
 const payload={formatVersion:1,runId,source:'registered-synthetic-workbench',registrationId,orgId,definitionVersion,asOf:date(asOf),exportedAt:new Date().toISOString(),auditThrough:results[entries.length][0].audit_through,tables};
 if(count>100000||new TextEncoder().encode(json(payload)).length>8*1024*1024-256)throw fail('分析入力上限を超えました。部分抽出はしません');
 return {...payload,frozenHash:await sha256(json(payload))};
}

export function createCloudAnalytics({db,bucket,registrationId,definitionVersion,containerBuild,orgId=1,clock=()=>new Date(),leaseMs=900000}){
 if(!registrationId||!definitionVersion||orgId!==1)throw Error('専用架空環境の登録ID・定義版・組織1が必要です');
 const now=()=>clock().toISOString(),prefix=run=>`analytics/org-${orgId}/runs/${run}/`;
 const authorize=i=>{if(i?.org_id!==orgId||i?.role!=='admin')throw fail('専用架空環境の管理者だけが利用できます',403)};
 async function liveIdentity(i){authorize(i);if(!await db.get("SELECT 1 FROM memberships WHERE org_id=? AND user_id=? AND role='admin' AND active=1 AND (expires_at IS NULL OR expires_at>?)",[orgId,i.user_id,now()]))throw fail('所属が失効しています',403)}
 async function begin(i,asOf){await liveIdentity(i);date(asOf);const runId=crypto.randomUUID().replaceAll('-',''),expires=new Date(clock().getTime()+leaseMs).toISOString();
  try{await db.batch([
   {sql:'INSERT INTO cloud_analytics_state(org_id) VALUES(?) ON CONFLICT(org_id) DO NOTHING',params:[orgId]},
   {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM cloud_analytics_state WHERE org_id=? AND lock_job IS NOT NULL AND lock_until>?)',params:[orgId,now()]},
   {sql:"UPDATE cloud_analytics_jobs SET status='expired',error='lease expired',finished_at=? WHERE org_id=? AND status='running' AND id=(SELECT lock_job FROM cloud_analytics_state WHERE org_id=?)",params:[now(),orgId,orgId]},
   {sql:'UPDATE cloud_analytics_state SET generation=generation+1,lock_job=?,lock_until=? WHERE org_id=?',params:[runId,expires,orgId]},
   {sql:"INSERT INTO cloud_analytics_jobs(id,org_id,generation,status,as_of,definition_version,created_at) SELECT ?,org_id,generation,'running',?,?,? FROM cloud_analytics_state WHERE org_id=?",params:[runId,asOf,definitionVersion,now(),orgId]}
  ])}catch(e){if(isDbConflict(e))throw fail('分析更新が実行中です',409);throw e}return {id:runId,asOf,identity:{...i}};
 }
 async function execute(job){const runId=job.id;try{
  const frozen=await freezeAnalyticsSnapshot({db,orgId,registrationId,definitionVersion,runId,asOf:job.asOf,userId:job.identity.user_id});
  const frozenText=json(frozen);await bucket.put(prefix(runId)+'frozen.json',frozenText);
  const storedInput=await bucket.get(prefix(runId)+'frozen.json');if(!storedInput||await sha256(await storedInput.arrayBuffer())!==await sha256(frozenText))throw fail('固定入力の永続化確認に失敗しました');
  const result=await containerBuild(frozen);
  if(new TextEncoder().encode(json(result)).length>16*1024*1024)throw fail('分析コンテナの応答上限を超えました');
  if(!result?.ok||!Array.isArray(result.files)||result.files.length>300)throw fail('分析コンテナの結果が不正です');
  const artifacts=new Map();let total=0;
  for(const f of result.files){if(!safePath(f.path)||artifacts.has(f.path))throw fail('成果物のパスが不正です');const data=bytesFromBase64(f.base64);total+=data.length;if(total>32*1024*1024)throw fail('分析成果物の上限を超えました');if(await sha256(data)!==f.sha256)throw fail('成果物ハッシュが一致しません');artifacts.set(f.path,{data,hash:f.sha256})}
  const parsed=name=>{const f=artifacts.get(name);if(!f)throw fail('必要な成果物がありません: '+name);return JSON.parse(new TextDecoder().decode(f.data))};
  const verification=parsed('verification.json'),snapshot=parsed('snapshot.json');
  if(verification.status!=='verified'||snapshot.frozenHash!==frozen.frozenHash||snapshot.registrationId!==registrationId||snapshot.org_id!==orgId||snapshot.auditThrough!==frozen.auditThrough||snapshot.cloudDefinitionVersion!==definitionVersion)throw fail('検証版と固定入力が一致しません');
  for(const required of ['analytics.duckdb','outputs.json','reports/report.json','reports/report.html','reports/sales.csv'])if(!artifacts.has(required)||verification.files?.[required]!==artifacts.get(required).hash)throw fail('必須成果物の検証がありません: '+required);
  for(const [path,hash] of Object.entries(verification.files||{}))if(!artifacts.has(path)||artifacts.get(path).hash!==hash)throw fail('検証manifestと成果物が一致しません');
  if(artifacts.size!==Object.keys(verification.files).length+1)throw fail('検証されていない成果物があります');
  for(const [path,f] of artifacts)if(path!=='verification.json')await bucket.put(prefix(runId)+path,f.data);
  const manifestHash=artifacts.get('verification.json').hash;
  await bucket.put(prefix(runId)+'verification.json',artifacts.get('verification.json').data);
  // Read back before selecting a run. An interrupted upload can never become active.
  for(const [path,f] of artifacts){const saved=await bucket.get(prefix(runId)+path);if(!saved||await sha256(await saved.arrayBuffer())!==f.hash)throw fail('成果物の永続化確認に失敗しました')}
  await liveIdentity(job.identity);
  await db.batch([
   {sql:"INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM memberships WHERE org_id=? AND user_id=? AND active=1 AND role='admin' AND (expires_at IS NULL OR expires_at>?))",params:[orgId,job.identity.user_id,now()]},
   {sql:"INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM cloud_analytics_state s JOIN cloud_analytics_jobs j ON j.id=s.lock_job AND j.org_id=s.org_id WHERE s.org_id=? AND s.lock_job=? AND s.lock_until>? AND j.status='running' AND j.generation=s.generation)",params:[orgId,runId,now()]},
   {sql:"UPDATE cloud_analytics_jobs SET status='verified',audit_through=?,manifest_hash=?,finished_at=? WHERE id=? AND org_id=? AND status='running'",params:[frozen.auditThrough,manifestHash,now(),runId,orgId]},
   {sql:'UPDATE cloud_analytics_state SET active_run=?,active_hash=?,lock_job=NULL,lock_until=NULL WHERE org_id=? AND lock_job=?',params:[runId,manifestHash,orgId,runId]}
  ]);return {runId,status:'verified'};
 }catch(e){await db.batch([{sql:"UPDATE cloud_analytics_jobs SET status='failed',error=?,finished_at=? WHERE id=? AND org_id=? AND status='running'",params:[String(e.message).slice(0,500),now(),runId,orgId]},{sql:'UPDATE cloud_analytics_state SET lock_job=NULL,lock_until=NULL WHERE org_id=? AND lock_job=?',params:[orgId,runId]}]);throw e}}
 async function checked(i,runId){await liveIdentity(i);if(!/^[a-f0-9]{32}$/.test(runId||''))throw fail('分析版が不正です');const j=await db.get("SELECT * FROM cloud_analytics_jobs WHERE org_id=? AND id=? AND status='verified'",[orgId,runId]);if(!j)throw fail('検証済み分析版がありません',404);const object=await bucket.get(prefix(runId)+'verification.json');if(!object)throw fail('検証証跡がありません');const data=await object.arrayBuffer();if(await sha256(data)!==j.manifest_hash)throw fail('分析版の証跡が変更されています');return {job:j,verification:JSON.parse(new TextDecoder().decode(data))}}
 async function status(i){await liveIdentity(i);const state=await db.get('SELECT * FROM cloud_analytics_state WHERE org_id=?',[orgId]);let active=null;if(state?.active_run){const {job,verification}=await checked(i,state.active_run),audit=await db.get('SELECT COALESCE(MAX(id),0) id FROM audit_log WHERE org_id=?',[orgId]);active={runId:job.id,snapshotId:job.id,verifiedAt:job.finished_at,auditThrough:job.audit_through,asOf:job.as_of,definitionStale:job.definition_version!==definitionVersion,stale:audit.id!==job.audit_through||job.definition_version!==definitionVersion,passedTests:verification.passedTests}}const latest=await db.get('SELECT status,error FROM cloud_analytics_jobs WHERE org_id=? ORDER BY generation DESC LIMIT 1',[orgId]);return {ok:true,enabled:true,runtime:"cloud",busy:!!state?.lock_job&&state.lock_until>now(),jobId:state?.lock_job||null,lastError:latest?.status==='failed'?latest.error:null,active}}
 async function history(i){await liveIdentity(i);const rows=await db.all("SELECT id,as_of,finished_at FROM cloud_analytics_jobs WHERE org_id=? AND status='verified' ORDER BY finished_at DESC LIMIT 100",[orgId]);return {ok:true,runs:rows.map(r=>({runId:r.id,snapshotId:r.id,asOf:r.as_of,verifiedAt:r.finished_at}))}}
 async function report(i,runId,file){await liveIdentity(i);if(!['report.html','sales.csv'].includes(file))throw fail('帳票が不正です');if(!runId)runId=(await db.get('SELECT active_run FROM cloud_analytics_state WHERE org_id=?',[orgId]))?.active_run;const {verification}=await checked(i,runId),path='reports/'+file,object=await bucket.get(prefix(runId)+path);if(!object)throw fail('帳票がありません',404);const data=await object.arrayBuffer();if(await sha256(data)!==verification.files[path])throw fail('帳票が検証後に変更されています');return data}
 return {begin,execute,status,history,report};
}

export function registerCloudAnalyticsRoutes(app,options){const service=createCloudAnalytics(options),wrap=fn=>async c=>{try{return await fn(c)}catch(e){return c.json({ok:false,error:e.message},e.status||400)}};
 app.get('/api/workbench/analytics/status',wrap(async c=>c.json(await service.status(c.get('identity')))));
 app.get('/api/workbench/analytics/history',wrap(async c=>c.json(await service.history(c.get('identity')))));
 // Keep the HTTP request alive: waitUntil alone only extends a completed request by 30s.
 // A disconnected run cannot alter the prior active version; its lease is reclaimable.
 app.post('/api/workbench/analytics/sync',wrap(async c=>{const x=await c.req.json(),job=await service.begin(c.get('identity'),String(x.asOf||new Date().toISOString().slice(0,10)));await service.execute(job);return c.json({ok:true,jobId:job.id,status:'verified'})}));
 for(const [route,file,type] of [['report','report.html','text/html; charset=utf-8'],['export','sales.csv','text/csv; charset=utf-8']])app.get('/api/workbench/analytics/'+route,wrap(async c=>{const data=await service.report(c.get('identity'),c.req.query('runId'),file);c.header('Content-Type',type);if(route==='export')c.header('Content-Disposition','attachment; filename="workbench-sales.csv"');return c.body(data)}));
 return service;
}
