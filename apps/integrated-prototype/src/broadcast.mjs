import {isDbConflict, isGuardViolation, isUniqueViolation} from './data-platform/db-errors.mjs';
import {integer,isoDate,month,toCsv} from './csv.mjs';
import {encodeReportXlsx} from './xlsx-report.mjs';
import {resolveTerritory} from './sales-ops/sales-catalog-model.mjs';
import {SLOT_SHEET,AVAIL_SHEET,readImportTable,validateSlotRow,validateAvailRow,summarizeRows,slotExportRows,slotExportSheets,availExportRows,availExportSheets,slotEnglishRows,availEnglishRows,japaneseRows,matchKey} from './broadcast/broadcast-sheet.mjs';
import {findDuplicateSlot,duplicateSlotMap,duplicateMessage,importDuplicateErrors,broadcastConflictMap} from './broadcast/slot-duplicates.mjs';

const text=(value,max=1000,required=false)=>{if(value!=null&&typeof value!=='string')throw Error('文字を入力してください');const v=String(value??'').trim();if(v.length>max||required&&!v)throw Error('必須項目または文字数を確認してください');return v||null};
const id=value=>{const n=integer(value);if(n<1)throw Error('IDは1以上です');return n};
const revision=value=>{const n=integer(value);if(n<0)throw Error('版が不正です');return n};
const audit=(i,action,entity,entityId,detail)=>({sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,action,entity,String(entityId),JSON.stringify(detail)]});
const guard=(sql,params)=>({sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE '+sql,params});
const currentSql=`SELECT v.*,s.created_at AS slot_created_at FROM broadcast_slot_versions v JOIN broadcast_slots s ON s.org_id=v.org_id AND s.id=v.slot_id WHERE v.org_id=? AND v.revision=(SELECT MAX(z.revision) FROM broadcast_slot_versions z WHERE z.org_id=v.org_id AND z.slot_id=v.slot_id)`;
// 放送ウィンドウ提案の下書きのうちに「削除（合意に至らず）」にした枠（移行 0008）。放送枠の一覧・Excel・売上突合から外す（版は消さず、中止の版を積んである）
export const NOT_DELETED_SLOT=' AND NOT EXISTS(SELECT 1 FROM broadcast_proposal_draft_deletions dd WHERE dd.org_id=v.org_id AND dd.slot_id=v.slot_id)';
const columns=['broadcast_month','station_name','customer_partner_id','agency_partner_id','agreement_id','period_from','period_to','planned_on','planned_runs','status','reason','source_reference'];
const params=(i,workId,slotId,rev,v)=>[i.org_id,workId,slotId,rev,...columns.map(k=>v[k]??null),i.user_id];
const insertVersion='INSERT INTO broadcast_slot_versions(org_id,work_id,slot_id,revision,'+columns.join(',')+',changed_by) VALUES('+Array(4+columns.length+1).fill('?').join(',')+')';

// 放送枠の登録の経路。画面の「放送枠を追加」（POST /api/broadcast/slots）と、放送ウィンドウ提案の「提案する（下書きを作る）」が同じものを使う。
// 入力の確かめ（放送月・期間・局・取引先・契約）・二重登録の判定（同じ作品・月・局の生きている枠）・同じ月の版の数の照合（transaction_guards）と、
// 下書きの第1版の文を作る。権限の確認と登録（db.batch。監査と一緒に）は呼ぶ側が行う。
export function broadcastSlotStore(db){
 async function partner(i,partnerId){if(partnerId==null||partnerId==='')return null;const n=id(partnerId);if(!await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?',[i.org_id,n]))throw Error('取引先IDが登録されていません');return n}
 async function agreement(i,agreementId,workId){if(agreementId==null||agreementId==='')return null;const n=id(agreementId),a=await db.get('SELECT id FROM sales_agreements WHERE org_id=? AND work_id=? AND id=?',[i.org_id,workId,n]);if(!a)throw Error('契約が対象作品にありません');const t=await db.get('SELECT channel FROM sales_agreement_term_versions WHERE org_id=? AND agreement_id=? ORDER BY version_no DESC LIMIT 1',[i.org_id,n]);if(t&&t.channel!=='broadcast')throw Error('放送契約を選んでください');return n}
 async function normalized(i,workId,input,previous=null){const m=month(String(input.broadcastMonth??previous?.broadcast_month??'')),station=text(input.stationName??previous?.station_name,200,true),from=isoDate(String(input.periodFrom??previous?.period_from??'')),to=isoDate(String(input.periodTo??previous?.period_to??'')),planned=input.plannedOn===undefined?previous?.planned_on??null:input.plannedOn==null||input.plannedOn===''?null:isoDate(String(input.plannedOn));if(from.slice(0,7)!==m||to.slice(0,7)!==m||to<from||planned&&(planned<from||planned>to))throw Error('放送月・期間・予定日を確認してください');const runs=id(input.plannedRuns??previous?.planned_runs??1);if(runs>9999)throw Error('予定回数は9999以下です');return {broadcast_month:m,station_name:station,period_from:from,period_to:to,planned_on:planned,planned_runs:runs,customer_partner_id:await partner(i,input.customerPartnerId??previous?.customer_partner_id),agency_partner_id:await partner(i,input.agencyPartnerId??previous?.agency_partner_id),agreement_id:await agreement(i,input.agreementId??previous?.agreement_id,workId),source_reference:text(input.sourceReference??previous?.source_reference,1000),reason:text(input.reason,1000)}}
 // 同じ作品・同じ月の枠（最新版）と、その版の数（登録の直前に数が変わっていないことを確かめる）
 async function monthSlots(i,workId,month){const [rows,count]=await Promise.all([db.all(currentSql+' AND v.work_id=? AND v.broadcast_month=?',[i.org_id,workId,month]),db.get('SELECT COUNT(*) n FROM broadcast_slot_versions WHERE org_id=? AND work_id=? AND broadcast_month=?',[i.org_id,workId,month])]);return {rows,count:Number(count.n)}}
 const monthGuard=(i,workId,month,count)=>guard('(SELECT COUNT(*) FROM broadcast_slot_versions WHERE org_id=? AND work_id=? AND broadcast_month=?)<>?',[i.org_id,workId,month,count]);
 const nextSlotId=async()=>Number((await db.get('SELECT COALESCE(MAX(id),0)+1 id FROM broadcast_slots')).id);
 // 下書きの放送枠を1つ作る文（放送枠ID slotId・第1版）。同じ作品・月・局の生きている枠があれば {duplicate, message}
 async function draftSlot(i,workId,input,slotId){const v={...await normalized(i,workId,input),status:'draft'},same=await monthSlots(i,workId,v.broadcast_month),dup=findDuplicateSlot(same.rows,{workId,month:v.broadcast_month,station:v.station_name});if(dup)return {value:v,duplicate:dup,message:duplicateMessage(dup,{stationName:v.station_name})};return {value:v,statements:[monthGuard(i,workId,v.broadcast_month,same.count),{sql:'INSERT INTO broadcast_slots(id,org_id,work_id,created_by) VALUES(?,?,?,?)',params:[slotId,i.org_id,workId,i.user_id]},{sql:insertVersion,params:params(i,workId,slotId,1,v)}]}}
 return {normalized,monthSlots,monthGuard,nextSlotId,draftSlot,insertVersion,params,columns};
}

// 競合（同じ作品・同じ月の別の局）の判定は画面と共通の純関数（src/broadcast/slot-duplicates.mjs）
export {broadcastConflict,broadcastConflictMap} from './broadcast/slot-duplicates.mjs';

// 取引先の最新の区分（得意先・放送局・代理店…）。取引先情報の表が無い環境では空。
export async function partnerRoles(db,orgId){try{const rows=await db.all('SELECT v.partner_id,v.roles_json FROM partner_profile_versions v WHERE v.org_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM partner_profile_versions x WHERE x.org_id=v.org_id AND x.partner_id=v.partner_id)',[orgId]);return new Map(rows.map(r=>{try{return [r.partner_id,JSON.parse(r.roles_json||'[]')]}catch{return [r.partner_id,[]]}}))}catch{return new Map()}}
const XLSX_TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const attachment=(name,ascii)=>`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name).toWellFormed())}`;
const stamp=()=>new Date(Date.now()+9*3600_000).toISOString().slice(0,10).replaceAll('-','');

export function registerBroadcastRoutes(app,{db,bad,body,permittedProjects}){
 const DELETED_DRAFT='この放送枠は放送ウィンドウ提案の下書きとして削除されています。同じ作品・月・局は提案から作り直してください';
 const friendly=e=>isGuardViolation(e)?'確かめた後に、別の人が同じ作品の放送枠を登録・更新しました。読み直してからもう一度登録してください':/broadcast slot deleted as a proposal draft/.test(e.message)?DELETED_DRAFT:isUniqueViolation(e,'broadcast_sale_links')?'この売上はすでに別の放送枠に紐付いています':e.message;
 // 提案の下書きとして削除した枠か（同時の操作で、削除が先に書いた後の申請・修正の文言を合わせる）
 const deletedDraft=async(i,slotId)=>Boolean(await db.get('SELECT 1 FROM broadcast_proposal_draft_deletions WHERE org_id=? AND slot_id=?',[i.org_id,slotId]));
 const orDeleted=async(i,slotId,run)=>{try{return await run()}catch(e){if(isGuardViolation(e)&&await deletedDraft(i,slotId))throw Error('broadcast slot deleted as a proposal draft');throw e}};
 const wrap=fn=>async c=>{try{return await fn(c)}catch(e){return bad(c,friendly(e),isDbConflict(e)||/immutable|mismatch|stale|deleted as a proposal draft/i.test(e.message)?409:400,undefined,e)}};
 const store=broadcastSlotStore(db),{normalized,monthSlots,monthGuard}=store;
 async function works(i,edit=false){if(i.role==='production')return [];const projects=await permittedProjects(db,i,edit);const ids=new Set(projects.map(p=>p.id));return (await db.all('SELECT id,project_id,code,title FROM works WHERE org_id=?',[i.org_id])).filter(w=>ids.has(w.project_id))}
 async function allowed(i,workId,edit=false){return (await works(i,edit)).find(w=>w.id===workId)||null}
 async function slot(i,slotId,edit=false){const s=await db.get(currentSql+' AND v.slot_id=?',[i.org_id,slotId]);return s&&await allowed(i,s.work_id,edit)?s:null}
 async function partnersWithRoles(i){const roles=await partnerRoles(db,i.org_id);return (await db.all('SELECT id,code,name,kind FROM partners WHERE org_id=? ORDER BY name',[i.org_id])).map(p=>({...p,roles:roles.get(p.id)||[]}))}
 async function workAgreements(i,workId){return db.all(`SELECT a.id,a.contract_code,a.title,t.channel FROM sales_agreements a LEFT JOIN sales_agreement_term_versions t ON t.org_id=a.org_id AND t.agreement_id=a.id AND t.version_no=(SELECT MAX(z.version_no) FROM sales_agreement_term_versions z WHERE z.org_id=a.org_id AND z.agreement_id=a.id) WHERE a.org_id=? AND a.work_id=?`,[i.org_id,workId])}
 async function distributionTypeMap(){return new Map((await db.all('SELECT t.code,t.label,d.distribution_name,d.transaction_method,d.sales_type,CASE WHEN d.code IS NULL THEN 1 ELSE 0 END AS legacy FROM distribution_types t LEFT JOIN distribution_master d ON d.code=t.code')).map(t=>[t.code,t]))}
 // 作品の放送枠（最新版）。提案の下書きのうちに削除した枠は出さない（一覧・Excel・取込の照合・売上突合）
 async function snapshot(i,workId){const rows=(await db.all(currentSql+NOT_DELETED_SLOT,[i.org_id])).filter(v=>v.work_id===workId),flags=broadcastConflictMap(rows),dups=duplicateSlotMap(rows);return rows.map(row=>({...row,conflict:flags.get(row.slot_id),duplicate_of:dups.get(row.slot_id)||null}))}
 app.get('/api/broadcast',wrap(async c=>{
  const i=c.get('identity'),visible=await works(i),edit=await works(i,true),filter=c.req.query('workId');
  const selected=filter?visible.filter(w=>w.id===id(filter)):visible;if(filter&&!selected.length)return bad(c,'作品への権限がありません',403);
  const slots=[];for(const w of selected)slots.push(...await snapshot(i,w.id));
  const partners=await partnersWithRoles(i);
  const agreements=(await db.all(`SELECT a.id,a.work_id,a.contract_code,a.title,p.name AS partner_name,t.channel,t.license_start,t.license_end
    FROM sales_agreements a JOIN partners p ON p.org_id=a.org_id AND p.id=a.partner_id
    LEFT JOIN sales_agreement_term_versions t ON t.org_id=a.org_id AND t.agreement_id=a.id AND t.version_no=(SELECT MAX(z.version_no) FROM sales_agreement_term_versions z WHERE z.org_id=a.org_id AND z.agreement_id=a.id)
    WHERE a.org_id=? ORDER BY a.id`,[i.org_id])).filter(a=>selected.some(w=>w.id===a.work_id)&&a.channel==='broadcast');
  const profiles=await db.all(`SELECT p.work_id,p.production_year,e.runtime_seconds,cr.name AS director
    FROM catalog_profiles p LEFT JOIN catalog_editions e ON e.org_id=p.org_id AND e.work_id=p.work_id AND e.revision=p.revision AND e.edition_key=(SELECT MIN(edition_key) FROM catalog_editions WHERE org_id=p.org_id AND work_id=p.work_id AND revision=p.revision)
    LEFT JOIN catalog_credits cr ON cr.org_id=p.org_id AND cr.work_id=p.work_id AND cr.revision=p.revision AND cr.role='director' AND cr.position=(SELECT MIN(position) FROM catalog_credits WHERE org_id=p.org_id AND work_id=p.work_id AND revision=p.revision AND role='director')
    WHERE p.org_id=? AND p.revision=(SELECT MAX(z.revision) FROM catalog_profiles z WHERE z.org_id=p.org_id AND z.work_id=p.work_id)`,[i.org_id]);
  const conditions=(await db.all(`SELECT v.work_id,v.distribution_code,v.release_on,v.sales_end_on,v.exclusivity,v.status,d.distribution_name,d.transaction_method,d.sales_type
    FROM sales_availability_versions v LEFT JOIN distribution_master d ON d.code=v.distribution_code
    WHERE v.org_id=? AND v.version_no=(SELECT MAX(z.version_no) FROM sales_availability_versions z WHERE z.org_id=v.org_id AND z.work_id=v.work_id AND z.distribution_code=v.distribution_code AND z.territory=v.territory)`,[i.org_id])).filter(v=>selected.some(w=>w.id===v.work_id));
  return c.json({ok:true,works:visible.map(w=>({...w,...profiles.find(p=>p.work_id===w.id),canEdit:edit.some(e=>e.id===w.id)})),slots,partners,agreements,conditions,approvalRole:i.role==='admin',statuses:['draft','pending_first','tentative','pending_final','confirmed','rejected','cancelled']});
 }));
 app.get('/api/broadcast/slots/:slotId/history',wrap(async c=>{const i=c.get('identity'),s=await slot(i,id(c.req.param('slotId')));if(!s)return bad(c,'放送枠への権限がありません',403);return c.json({ok:true,rows:await db.all('SELECT * FROM broadcast_slot_versions WHERE org_id=? AND slot_id=? ORDER BY revision DESC',[i.org_id,s.slot_id])})}));
 app.get('/api/broadcast/conditions/history',wrap(async c=>{const i=c.get('identity'),workId=id(c.req.query('workId'));if(!await allowed(i,workId))return bad(c,'作品への権限がありません',403);const code=text(c.req.query('distributionCode'),50,true),territory=text(c.req.query('territory'),100,true);return c.json({ok:true,rows:await db.all('SELECT v.*,r.rate_bps FROM sales_availability_versions v LEFT JOIN broadcast_availability_rates r ON r.org_id=v.org_id AND r.availability_version_id=v.id WHERE v.org_id=? AND v.work_id=? AND v.distribution_code=? AND v.territory=? ORDER BY v.version_no DESC',[i.org_id,workId,code,territory])})}));
 app.post('/api/broadcast/conditions',wrap(async c=>{
  const i=c.get('identity'),b=await body(c),workId=id(b.workId);if(!await allowed(i,workId,true))return bad(c,'作品の編集権限がありません',403);
  const code=text(b.distributionCode,50,true),type=await db.get('SELECT code FROM distribution_types WHERE code=?',[code]);if(!type)throw Error('登録済み流通を選んでください');
  const territory=text(b.territory,100,true),base=revision(b.baseVersion),release=b.releaseOn?isoDate(String(b.releaseOn)):null,end=b.salesEndOn?isoDate(String(b.salesEndOn)):null,status=String(b.status),exclusivity=String(b.exclusivity),terms=text(b.terms,5000)||'',source=text(b.sourceReference,1000,true);
  const rate=b.rateBps==null||b.rateBps===''?null:revision(b.rateBps);
  if(rate!=null&&rate>10000||release&&end&&end<release||!['draft','confirmed','withdrawn'].includes(status)||!['unknown','exclusive','nonexclusive'].includes(exclusivity)||status==='confirmed'&&(!release||!end||!terms))throw Error('解禁・終了・料率・独占・状態を確認してください');
  const current=await db.get('SELECT MAX(version_no) n FROM sales_availability_versions WHERE org_id=? AND work_id=? AND distribution_code=? AND territory=?',[i.org_id,workId,code,territory]);if(base!==(current?.n||0))return bad(c,'販売条件が更新されています',409);
  const previous=base?await db.get('SELECT intake_case_id,document_id FROM sales_availability_versions WHERE org_id=? AND work_id=? AND distribution_code=? AND territory=? AND version_no=?',[i.org_id,workId,code,territory,base]):null;
  const statements=[guard('?<>(SELECT COALESCE(MAX(version_no),0) FROM sales_availability_versions WHERE org_id=? AND work_id=? AND distribution_code=? AND territory=?)',[base,i.org_id,workId,code,territory]),
   {sql:'INSERT INTO sales_availability_versions(org_id,work_id,distribution_code,territory,version_no,release_on,sales_end_on,terms_text,source_reference,intake_case_id,document_id,exclusivity,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[i.org_id,workId,code,territory,base+1,release,end,terms,source,previous?.intake_case_id??null,previous?.document_id??null,exclusivity,status,i.user_id]},
   {sql:'INSERT INTO broadcast_availability_rates(org_id,availability_version_id,rate_bps) SELECT org_id,id,? FROM sales_availability_versions WHERE org_id=? AND work_id=? AND distribution_code=? AND territory=? AND version_no=?',params:[rate,i.org_id,workId,code,territory,base+1]},audit(i,'version','sales_availability',workId,{code,territory,version:base+1,rateBps:rate})];
  await db.batch(statements);return c.json({ok:true,version:base+1},201);
 }));
 app.post('/api/broadcast/slots',wrap(async c=>{const i=c.get('identity'),b=await body(c),workId=id(b.workId);if(!await allowed(i,workId,true))return bad(c,'作品の編集権限がありません',403);const slotId=await store.nextSlotId(),draft=await store.draftSlot(i,workId,b,slotId);if(draft.duplicate)return bad(c,draft.message,409);await db.batch([...draft.statements,audit(i,'create','broadcast_slot',slotId,{after:draft.value,revision:1})]);return c.json({ok:true,slotId,revision:1},201)}));
 app.patch('/api/broadcast/slots/:slotId',wrap(async c=>{const i=c.get('identity'),slotId=id(c.req.param('slotId')),s=await slot(i,slotId,true);if(!s)return bad(c,'放送枠の編集権限がありません',403);if(!['draft','rejected'].includes(s.status))return bad(c,'放送局・日時は下書きまたは差戻しから修正してください',409);const b=await body(c),base=revision(b.baseRevision);if(base!==s.revision)return bad(c,'放送枠が更新されています',409);const v={...await normalized(i,s.work_id,b,s),status:'draft'},same=await monthSlots(i,s.work_id,v.broadcast_month),dup=findDuplicateSlot(same.rows,{workId:s.work_id,month:v.broadcast_month,station:v.station_name,exceptSlotId:slotId});if(dup)return bad(c,duplicateMessage(dup,{stationName:v.station_name}),409);await orDeleted(i,slotId,()=>db.batch([guard('EXISTS(SELECT 1 FROM broadcast_slot_versions WHERE org_id=? AND slot_id=? AND revision>?)',[i.org_id,slotId,base]),monthGuard(i,s.work_id,v.broadcast_month,same.count),{sql:insertVersion,params:params(i,s.work_id,slotId,base+1,v)},audit(i,'revise','broadcast_slot',slotId,{before:s,after:v,revision:base+1})]));return c.json({ok:true,slotId,revision:base+1})}));
 app.post('/api/broadcast/slots/:slotId/transition',wrap(async c=>{const i=c.get('identity'),slotId=id(c.req.param('slotId')),s=await slot(i,slotId,true);if(!s)return bad(c,'放送枠への権限がありません',403);const b=await body(c),base=revision(b.baseRevision),next=String(b.status||'');if(base!==s.revision)return bad(c,'放送枠が更新されています',409);const permitted={draft:['pending_first','cancelled'],rejected:['pending_first','cancelled'],pending_first:['tentative','rejected','cancelled'],tentative:['pending_final','cancelled'],pending_final:['confirmed','rejected','cancelled'],confirmed:['cancelled'],cancelled:[]};if(!permitted[s.status]?.includes(next))return bad(c,'この状態変更はできません',409);if(['tentative','confirmed','rejected'].includes(next)&&i.role!=='admin')return bad(c,'承認・差戻しは管理者が行います',403);const reason=text(b.reason,1000,['rejected','cancelled'].includes(next)),v={...Object.fromEntries(columns.map(k=>[k,s[k]])),status:next,reason};await orDeleted(i,slotId,()=>db.batch([guard('EXISTS(SELECT 1 FROM broadcast_slot_versions WHERE org_id=? AND slot_id=? AND revision>?)',[i.org_id,slotId,base]),{sql:insertVersion,params:params(i,s.work_id,slotId,base+1,v)},audit(i,'transition','broadcast_slot',slotId,{from:s.status,to:next,reason,revision:base+1})]));return c.json({ok:true,slotId,revision:base+1,status:next})}));
 app.post('/api/broadcast/slots/:slotId/airings',wrap(async c=>{const i=c.get('identity'),s=await slot(i,id(c.req.param('slotId')),true);if(!s)return bad(c,'放送枠への権限がありません',403);if(s.status!=='confirmed')return bad(c,'確定した放送枠に実放送を記録してください',409);const b=await body(c),aired=isoDate(String(b.airedOn||'')),count=id(b.runCount??1),source=text(b.sourceReference,1000,true),note=text(b.note,1000);if(aired<s.period_from||aired>s.period_to||count>9999)throw Error('放送期間と回数を確認してください');if(s.agreement_id){const term=await db.get('SELECT license_start,license_end FROM sales_agreement_term_versions WHERE org_id=? AND agreement_id=? ORDER BY version_no DESC LIMIT 1',[i.org_id,s.agreement_id]);if(term&&(term.license_start&&aired<term.license_start||term.license_end&&aired>term.license_end))return bad(c,'契約の利用期間外です',409)}const out=await db.batch([guard('COALESCE((SELECT SUM(run_count) FROM broadcast_airings WHERE org_id=? AND slot_id=?),0)+?>?',[i.org_id,s.slot_id,count,s.planned_runs]),{sql:'INSERT INTO broadcast_airings(org_id,work_id,slot_id,aired_on,run_count,source_reference,note,created_by) VALUES(?,?,?,?,?,?,?,?) RETURNING id',params:[i.org_id,s.work_id,s.slot_id,aired,count,source,note,i.user_id]},audit(i,'record','broadcast_airing',s.slot_id,{aired,count,source})]);return c.json({ok:true,airingId:out[1].rows[0].id},201)}));
 app.post('/api/broadcast/slots/:slotId/sales',wrap(async c=>{
  const i=c.get('identity'),s=await slot(i,id(c.req.param('slotId')),true);
  if(!s)return bad(c,'放送枠への権限がありません',403);
  if(s.status==='cancelled')return bad(c,'中止済み放送枠へ新たな売上は紐付けできません',409);
  const b=await body(c),saleId=id(b.saleId);
  const sale=await db.get('SELECT l.id,l.work_id,r.kind,r.status,r.period_from,r.period_to FROM sale_lines l JOIN report_imports r ON r.org_id=l.org_id AND r.id=l.report_id WHERE l.org_id=? AND l.id=?',[i.org_id,saleId]);
  if(!sale||sale.work_id!==s.work_id||sale.kind!=='broadcast'||sale.status!=='active')return bad(c,'同じ作品の有効な放送報告売上を指定してください',409);
  if(s.period_to<sale.period_from||s.period_from>sale.period_to)return bad(c,'放送枠と報告期間が重なっていません',409);
  const note=text(b.note,1000);
  const out=await db.batch([{sql:'INSERT INTO broadcast_sale_links(org_id,work_id,slot_id,sale_id,note,created_by) VALUES(?,?,?,?,?,?) RETURNING id',params:[i.org_id,s.work_id,s.slot_id,saleId,note,i.user_id]},audit(i,'link','broadcast_sale',saleId,{slotId:s.slot_id})]);
  return c.json({ok:true,linkId:out[0].rows[0].id},201);
 }));
 app.get('/api/broadcast/reconciliation',wrap(async c=>{
  const i=c.get('identity'),workId=id(c.req.query('workId'));
  if(!await allowed(i,workId))return bad(c,'作品への権限がありません',403);
  const slots=await snapshot(i,workId);
  const links=await db.all('SELECT l.slot_id,l.sale_id,s.amount_ex_tax,s.accounting_month,s.report_id,r.status AS report_status FROM broadcast_sale_links l JOIN sale_lines s ON s.org_id=l.org_id AND s.id=l.sale_id JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE l.org_id=? AND l.work_id=?',[i.org_id,workId]);
  const airings=await db.all('SELECT slot_id,COUNT(*) records,SUM(run_count) runs FROM broadcast_airings WHERE org_id=? AND work_id=? GROUP BY slot_id',[i.org_id,workId]);
  const deliveries=await db.all('SELECT agreement_id,status,COUNT(*) count FROM sales_deliverables WHERE org_id=? AND work_id=? GROUP BY agreement_id,status',[i.org_id,workId]);
  const sales=await db.all("SELECT s.id,s.amount_ex_tax,s.accounting_month,s.report_id,r.report_key,p.name AS partner_name FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id WHERE s.org_id=? AND s.work_id=? AND r.kind='broadcast' AND r.status='active'",[i.org_id,workId]);
  return c.json({ok:true,rows:slots.map(s=>{
   const allLinks=links.filter(l=>l.slot_id===s.slot_id),matched=allLinks.filter(l=>l.report_status==='active'),air=airings.find(a=>a.slot_id===s.slot_id);
   return {...s,sales:matched,superseded_links:allLinks.filter(l=>l.report_status!=='active'),linked_amount_ex_tax:matched.reduce((n,l)=>n+l.amount_ex_tax,0),actual_runs:air?.runs??0,delivery:deliveries.filter(d=>d.agreement_id===s.agreement_id),reconciliation:s.status==='cancelled'&&matched.length?'cancelled_linked':s.status==='confirmed'&&matched.length===0?'missing':matched.length?'linked':'pending'};
  }),surplus:sales.filter(s=>!links.some(l=>l.sale_id===s.id))});
 }));
 async function slotExport(i,workId){const work=(await works(i)).find(w=>w.id===workId),partners=await partnersWithRoles(i);return {work,rows:await snapshot(i,workId),partners,stations:partners.filter(p=>p.roles.includes('broadcaster')),agreements:await workAgreements(i,workId)}}
 app.get('/api/broadcast/export.csv',wrap(async c=>{const i=c.get('identity'),workId=id(c.req.query('workId'));if(!await allowed(i,workId))return bad(c,'作品への権限がありません',403);const x=await slotExport(i,workId),ja=c.req.query('headers')==='ja',table=ja?japaneseRows(SLOT_SHEET,slotExportRows(x.rows,x)):slotEnglishRows(x.rows,workId);return new Response('\uFEFF'+toCsv(table[0],table.slice(1)),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':attachment(`放送枠_${x.work.code}_${stamp()}.csv`,'broadcast-slots.csv')}})}));
 app.get('/api/broadcast/export.xlsx',wrap(async c=>{const i=c.get('identity'),workId=id(c.req.query('workId'));if(!await allowed(i,workId))return bad(c,'作品への権限がありません',403);const x=await slotExport(i,workId),bytes=encodeReportXlsx({sheets:slotExportSheets(slotExportRows(x.rows,x))});return new Response(bytes,{headers:{'content-type':XLSX_TYPE,'content-disposition':attachment(`放送枠_${x.work.code}_${stamp()}.xlsx`,'broadcast-slots.xlsx')}})}));
 app.post('/api/broadcast/import/preview',wrap(async c=>{
  const i=c.get('identity'),b=await body(c),workId=id(b.workId);
  if(!await allowed(i,workId,true))return bad(c,'作品の編集権限がありません',403);
  const table=readImportTable(b,SLOT_SHEET),x=await slotExport(i,workId);
  const ctx={work:x.work,partners:x.partners,stations:x.stations,agreements:x.agreements,slots:new Map(x.rows.map(s=>[s.slot_id,s])),seen:new Map()};
  const results=table.rows.map(row=>validateSlotRow(row,table.mapping,ctx));
  // 取込後の状態で、同じ作品・月・局（全角・半角の違いは同じ局）の生きている枠が2つ以上になる行はエラー。
  const dupErrors=importDuplicateErrors(x.rows,results.filter(r=>!r.errors.length),workId);/* ほかの誤りがある行は値が確かでないので数えない */for(const r of results)if(dupErrors.has(r.rowNo))r.errors.push({column:table.mapping.headerOf.station_name||null,message:dupErrors.get(r.rowNo)});
  const summary=summarizeRows(results,table);
  const fileWarnings=[...(table.mapping.unknown.length?[`読み込まない列があります: ${table.mapping.unknown.join('、')}（見出しがテンプレートと違います）`]:[]),...(table.mapping.duplicated.length?[`同じ意味の列が2つあるため後の列を読みません: ${table.mapping.duplicated.join('、')}`]:[])];
  if(!summary.ok)return c.json({ok:false,error:summary.error,details:summary.details,headers:summary.headers,failedRows:summary.failedRows,counts:summary.counts,warnings:fileWarnings,headerMode:table.mapping.mode},400);
  const rows=results.map(r=>({rowNo:r.rowNo,action:r.action,slotId:r.slotId,baseRevision:r.baseRevision,diff:r.diff,value:r.value,warnings:r.warnings}));
  const token=crypto.randomUUID(),expires=new Date(Date.now()+15*60_000).toISOString();
  await db.run('INSERT INTO broadcast_import_previews(token,org_id,user_id,work_id,payload_json,expires_at) VALUES(?,?,?,?,?,?)',[token,i.org_id,i.user_id,workId,JSON.stringify(rows),expires]);
  return c.json({ok:true,token,rows:rows.map(r=>({...r,...r.value})),counts:summary.counts,expiresAt:expires,warnings:fileWarnings,headerMode:table.mapping.mode,ignoredColumns:table.mapping.references});
 }));
 app.post('/api/broadcast/import/commit',wrap(async c=>{
  const i=c.get('identity'),b=await body(c);
  const p=await db.get('SELECT * FROM broadcast_import_previews WHERE token=? AND org_id=? AND user_id=? AND consumed=0 AND expires_at>?',[String(b.token||''),i.org_id,i.user_id,new Date().toISOString()]);
  if(!p)return bad(c,'取込プレビューがないか期限切れです',410);
  if(!await allowed(i,p.work_id,true))return bad(c,'作品の編集権限がありません',403);
  if(b.confirmed!==true)return bad(c,'プレビューを確認してください',400);
  const rows=JSON.parse(p.payload_json);
  // 確認の後に他の人が枠を足していないか、今の状態で二重登録をもう一度確かめる（版の数が変わっていたら登録しない）
  const current=(await db.all(currentSql+' AND v.work_id=?',[i.org_id,p.work_id])),versions=Number((await db.get('SELECT COUNT(*) n FROM broadcast_slot_versions WHERE org_id=? AND work_id=?',[i.org_id,p.work_id])).n);
  const dupErrors=importDuplicateErrors(current,rows,p.work_id);if(dupErrors.size)return bad(c,`取込の確認の後に同じ放送月・同じ放送局の枠が登録されました（${[...dupErrors.keys()].map(n=>`${n}行目`).join('・')}）。もう一度読み込んで確かめてください`,409);
  const start=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 id FROM broadcast_slots')).id);
  const statements=[guard('NOT EXISTS(SELECT 1 FROM broadcast_import_previews WHERE token=? AND consumed=0 AND expires_at>?)',[p.token,new Date().toISOString()]),guard('(SELECT COUNT(*) FROM broadcast_slot_versions WHERE org_id=? AND work_id=?)<>?',[i.org_id,p.work_id,versions])];
  let nextId=start;
  for(const entry of rows){
   const {action,slotId,baseRevision,value}=entry;
   if(slotId)statements.push(guard('EXISTS(SELECT 1 FROM broadcast_slot_versions WHERE org_id=? AND slot_id=? AND revision>?)',[i.org_id,slotId,baseRevision]));
   if(action==='unchanged')continue;
   if(action==='append'){
    const createdId=nextId++;
    statements.push({sql:'INSERT INTO broadcast_slots(id,org_id,work_id,created_by) VALUES(?,?,?,?)',params:[createdId,i.org_id,p.work_id,i.user_id]},
      {sql:insertVersion,params:params(i,p.work_id,createdId,1,value)});
   }else if(action==='revise')statements.push({sql:insertVersion,params:params(i,p.work_id,slotId,baseRevision+1,value)});
  }
  const counts={append:rows.filter(r=>r.action==='append').length,revise:rows.filter(r=>r.action==='revise').length,unchanged:rows.filter(r=>r.action==='unchanged').length};
  statements.push({sql:'UPDATE broadcast_import_previews SET consumed=1 WHERE token=?',params:[p.token]},audit(i,'import','broadcast_slot',p.work_id,{...counts,firstSlotId:start}));
  await db.batch(statements);
  return c.json({ok:true,...counts,firstSlotId:counts.append?start:null},201);
 }));
 async function avails(i){const visible=await works(i),ids=new Set(visible.map(w=>w.id)),rows=await db.all(`SELECT v.*,w.code AS work_code,w.title AS work_title,d.distribution_name,d.transaction_method,ic.case_code AS intake_case_code,doc.title AS document_title FROM sales_availability_versions v JOIN works w ON w.org_id=v.org_id AND w.id=v.work_id LEFT JOIN distribution_master d ON d.code=v.distribution_code LEFT JOIN rights_intake_cases ic ON ic.org_id=v.org_id AND ic.id=v.intake_case_id LEFT JOIN rights_intake_documents doc ON doc.org_id=v.org_id AND doc.id=v.document_id WHERE v.org_id=? AND v.version_no=(SELECT MAX(z.version_no) FROM sales_availability_versions z WHERE z.org_id=v.org_id AND z.work_id=v.work_id AND z.distribution_code=v.distribution_code AND z.territory=v.territory) ORDER BY w.code,v.distribution_code,v.territory`,[i.org_id]);return rows.filter(r=>ids.has(r.work_id))}
 app.get('/api/broadcast/avails/export.csv',wrap(async c=>{const i=c.get('identity'),rows=await avails(i),ja=c.req.query('headers')==='ja',table=ja?japaneseRows(AVAIL_SHEET,availExportRows(rows,{types:await distributionTypeMap()})):availEnglishRows(rows);return new Response('\uFEFF'+toCsv(table[0],table.slice(1)),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':attachment(`販売条件_${stamp()}.csv`,'broadcast-avails.csv')}})}));
 app.get('/api/broadcast/avails/export.xlsx',wrap(async c=>{const i=c.get('identity'),rows=await avails(i),bytes=encodeReportXlsx({sheets:availExportSheets(availExportRows(rows,{types:await distributionTypeMap()}))});return new Response(bytes,{headers:{'content-type':XLSX_TYPE,'content-disposition':attachment(`販売条件_${stamp()}.xlsx`,'broadcast-avails.xlsx')}})}));
 app.post('/api/broadcast/avails/preview',wrap(async c=>{
  const i=c.get('identity'),b=await body(c),table=readImportTable(b,AVAIL_SHEET),edit=await works(i,true),types=await distributionTypeMap();
  const latest=await db.all('SELECT v.* FROM sales_availability_versions v WHERE v.org_id=? AND v.version_no=(SELECT MAX(z.version_no) FROM sales_availability_versions z WHERE z.org_id=v.org_id AND z.work_id=v.work_id AND z.distribution_code=v.distribution_code AND z.territory=v.territory)',[i.org_id]);
  const current=new Map(latest.map(r=>[[r.work_id,r.distribution_code,r.territory].join('|'),r])),series=new Map();for(const r of latest){const k=[r.work_id,r.distribution_code].join('|');series.set(k,[...(series.get(k)||[]),{territory:r.territory,version_no:r.version_no}])}
  const ctx={works:edit,types,current,series,resolveTerritory,seen:new Map()},results=table.rows.map(row=>validateAvailRow(row,table.mapping,ctx)),summary=summarizeRows(results,table);
  const fileWarnings=table.mapping.unknown.length?[`読み込まない列があります: ${table.mapping.unknown.join('、')}（見出しがテンプレートと違います）`]:[];
  if(!summary.ok)return c.json({ok:false,error:summary.error,details:summary.details,headers:summary.headers,failedRows:summary.failedRows,counts:summary.counts,warnings:fileWarnings,headerMode:table.mapping.mode},400);
  const rows=results.map(r=>({rowNo:r.rowNo,action:r.action,baseVersion:r.baseVersion,diff:r.diff,value:r.value,warnings:r.warnings,workTitle:r.workTitle,workCode:r.workCode,distributionName:r.distributionName,distributionLabel:r.distributionLabel}));
  const token=crypto.randomUUID(),expires=new Date(Date.now()+15*60_000).toISOString();await db.run('INSERT INTO broadcast_availability_previews(token,org_id,user_id,payload_json,expires_at) VALUES(?,?,?,?,?)',[token,i.org_id,i.user_id,JSON.stringify(rows),expires]);
  return c.json({ok:true,token,rows:rows.map(r=>({...r,...r.value})),counts:summary.counts,expiresAt:expires,warnings:fileWarnings,headerMode:table.mapping.mode,ignoredColumns:table.mapping.references});
 }));
 app.post('/api/broadcast/avails/commit',wrap(async c=>{
  const i=c.get('identity'),b=await body(c),p=await db.get('SELECT * FROM broadcast_availability_previews WHERE token=? AND org_id=? AND user_id=? AND consumed=0 AND expires_at>?',[String(b.token||''),i.org_id,i.user_id,new Date().toISOString()]);
  if(!p)return bad(c,'販売条件のプレビューがないか期限切れです',410);if(b.confirmed!==true)return bad(c,'差分を確認してください',400);
  const rows=JSON.parse(p.payload_json),editable=new Set((await works(i,true)).map(w=>w.id));if(rows.some(r=>!editable.has(r.value.work_id)))return bad(c,'作品の編集権限がありません',403);
  const statements=[guard('NOT EXISTS(SELECT 1 FROM broadcast_availability_previews WHERE token=? AND consumed=0 AND expires_at>?)',[p.token,new Date().toISOString()])];
  for(const r of rows){const v=r.value;statements.push(guard('?<>(SELECT COALESCE(MAX(version_no),0) FROM sales_availability_versions WHERE org_id=? AND work_id=? AND distribution_code=? AND territory=?)',[r.baseVersion,i.org_id,v.work_id,v.distribution_code,v.territory]));if(r.action==='unchanged')continue;statements.push({sql:'INSERT INTO sales_availability_versions(org_id,work_id,distribution_code,territory,version_no,release_on,sales_end_on,terms_text,source_reference,intake_case_id,document_id,exclusivity,status,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[i.org_id,v.work_id,v.distribution_code,v.territory,r.baseVersion+1,v.release_on,v.sales_end_on,v.terms_text,v.source_reference,v.intake_case_id??null,v.document_id??null,v.exclusivity,v.status,i.user_id]})}
  const counts={append:rows.filter(r=>r.action==='append').length,revise:rows.filter(r=>r.action==='revise').length,unchanged:rows.filter(r=>r.action==='unchanged').length};statements.push({sql:'UPDATE broadcast_availability_previews SET consumed=1 WHERE token=?',params:[p.token]},audit(i,'import','sales_availability',i.org_id,counts));await db.batch(statements);return c.json({ok:true,...counts},201);
 }));
}
