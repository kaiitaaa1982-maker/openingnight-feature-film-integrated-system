import {isDbConflict, dbErrorBody} from './data-platform/db-errors.mjs';
import {expenseSource,resolveExpenseAccounts} from './expense-sheet/expense-read.mjs';
import {registerExpenseRoutes} from './expense-sheet/expense-routes.mjs';
import {registerErRoutes} from './admin/er-routes.mjs';
import {registerSalesImportRoutes} from './import/sales-import-routes.mjs';
import {registerSalesPipelineRoutes, deliverableTiming} from './sales-ops/pipeline-routes.mjs';
import {resolveTerritory} from './sales-ops/sales-catalog-model.mjs';
import {registerBroadcastApprovalRoutes} from './broadcast/broadcast-approvals-routes.mjs';
import {registerBroadcastWindowRoutes} from './broadcast/broadcast-windows-routes.mjs';
import {registerWorkPnlRoutes} from './work-pnl-report-routes.mjs';
import {registerReportIssuanceRoutes} from './report-issuance-routes.mjs';
import {registerDashboardRoutes} from './reporting-dashboard.mjs';
import {registerProgressRoutes} from './progress/progress-routes.mjs';
import {registerRoyaltyRoutes} from './royalty/royalty-routes.mjs';
import {registerCommitteeMonthlyRoutes} from './committee/committee-monthly-routes.mjs';
import {parseEffectiveFrom, feeShareCopy, retroactiveRoyaltyImpact, retroactiveMessage} from './committee/committee-version-rules.mjs';
import {registerSalesSourceRoutes} from './import/sales-source-routes.mjs';
import {registerSalesSheetRoutes} from './sales-sheet/sales-sheet-routes.mjs';
import {registerPlBsRoutes} from './pl-bs/pl-bs-routes.mjs';
import {isAttributeTarget} from './sales-sheet/column-registry.mjs';
import {attributeImportContext, readRowAttributes, attributeTextOf, attributeInsertStatement} from './sales-sheet/import-attributes.mjs';
import {partitionPreviewSource,partitionCommitStatements,legacyTakenOverGuard,isTakenOver} from './import/sales-source-store.mjs';
import {importLimits,utf8Bytes,reportByteLimit} from './import/limits.mjs';
import {labelOf} from './ui/labels.mjs';
import {registerPartnerProfileRoutes} from './partners/partner-profile-routes.mjs';
import {registerDataBrowserRoutes} from './admin/data-browser-routes.mjs';
import {registerWorkQueueRoutes} from './work-queue.mjs';
import {registerReceivablesRoutes} from './billing/receivables-routes.mjs';
import {registerRoyaltyStatementRoutes} from './royalty-statement-routes.mjs';
import {registerMgSalesReportRoutes} from './mg-sales-report-routes.mjs';
import {registerSalesLinesRoutes} from './sales/sales-lines-routes.mjs';
import {registerBulkRoutes} from './bulk/bulk-io.mjs';
import {registerAnnualReportRoutes} from './reporting-annual.mjs';
import {registerMgPortfolioRoutes} from './mg-portfolio.mjs';
import { semanticDocument } from './semantic-definitions.mjs';
import { registerBroadcastRoutes } from './broadcast.mjs';
import { registerProductionRoutes } from './production.mjs';
import { KOUBAN_DEMO_CODE } from './demo-guide.mjs';
import { registerCatalogRoutes } from './catalog.mjs';
import {registerWorkMasterRoutes} from './master-extensions/work-master-routes.mjs';
import {registerProductMasterRoutes} from './master-extensions/product-master-routes.mjs';
import { registerReleaseWindowRoutes } from './sales-ops/release-window-routes.mjs';
import { registerPartnerListRoutes } from './sales-ops/partner-list-routes.mjs';
import { registerReleaseProposalRoutes } from './sales-ops/release-proposal-routes.mjs';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { ORG_COOKIE, ORG_HEADER, ORG_CHECK_EXEMPT_PATHS, activeMemberships, identityForUser, orgCookieOptions, orgCookieValue, orgMismatch, orgMismatchBody } from './session-org.mjs';
import { parseCsv, toCsv, integer, isoDate, month } from './csv.mjs';
import {normalizeFunding,normalizeDeductions} from './committee-finance.mjs';
import {registerJointCommitteeRoutes} from './committee-joint-routes.mjs';
import { validateCommitteeTerms, committeePeriods, calculateCommitteeWindow } from './committee.mjs';
import { registerCommercialRoutes } from './commercial.mjs';
import { registerReportingRoutes } from './reporting.mjs';
import { registerWorkflowRoutes } from './workflow.mjs';
import { registerMgRoutes } from './mg.mjs';
import {registerMgLedgerImportRoutes} from './mg-ledger-import.mjs';
import { registerRightsReportRoutes } from './rights-reports.mjs';
import { registerTaxRoutes } from './tax.mjs';
import { registerWorkbenchRoutes } from './workbench.mjs';
import { channelSalesColumns, parseChannelSalesDetail, buildChannelSalesStatements } from './channel-sales.mjs';

const encoder = new TextEncoder();
const json = value => JSON.stringify(value);
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const nowIso = () => new Date().toISOString();
async function sha256(value) {
  const data = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(data)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const randomToken = () => crypto.randomUUID() + crypto.randomUUID();
// error を渡すと、DB の制約の違反の種類（共通のエラーの種類。src/data-platform/db-errors.mjs）を dbError に載せる（画面はその種類で分岐する。FR-CORE-DATA-016）
const bad = (c, message, status = 400, details, error) => { const dbError = dbErrorBody(error); return c.json({ ok: false, error: message, details, ...(dbError ? { dbError } : {}) }, status); };
const body = async c => { try { return await c.req.json(); } catch { throw new Error('JSON本文を確認できません'); } };
const validKey = key => typeof key === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(key);
const activeAt = value => !value || Date.parse(value) > Date.now();
const optionalInteger = value => value == null || value === '' ? null : integer(value);
function localDateTime(value,{nullable=false}={}) {
  if(nullable&&(value==null||value===''))return null;
  const text=String(value||'');if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text))throw new Error('日時はYYYY-MM-DDTHH:mm形式で入力してください');
  isoDate(text.slice(0,10));const hour=Number(text.slice(11,13)),minute=Number(text.slice(14,16));if(hour>23||minute>59)throw new Error(`存在しない時刻です: ${text}`);return text;
}
const cleanText=(value,max=1000,{required=false}={})=>{const out=value==null?'':String(value).trim();if(required&&!out)throw new Error('必須の文字項目が空です');if(out.length>max)throw new Error(`文字項目は${max}文字以内です`);return out||null};
function signedRateAmount(value, bps) {
  if (!Number.isSafeInteger(value) || !Number.isInteger(bps)) throw new Error('精算金額または料率を整数として確認できません');
  const sign = value < 0 ? -1n : 1n;
  return Number(sign * (BigInt(Math.abs(value)) * BigInt(bps) / 10000n));
}
import {splitByAllocation} from './money-allocation.mjs';
function allocatedSaleParts(sales, mappings) {
  const output=[];
  for(const sale of sales){
    let shares=sale.product_id?mappings.filter(x=>x.product_id===sale.product_id):[];
    if(!shares.length)shares=[{work_id:sale.work_id,allocation_bps:10000}];
    if(shares.reduce((n,x)=>n+x.allocation_bps,0)!==10000)throw new Error('商品配賦が100%ではありません');
    const amounts=splitByAllocation(sale.amount_ex_tax,shares);
    for(const share of shares)output.push({...sale,allocated_work_id:share.work_id,allocation_bps:share.allocation_bps,allocated_amount_ex_tax:amounts.get(share.work_id)});
  }
  return output;
}
function settlementTerms(input, contractType) {
  const platformRateBps=integer(input?.platformRateBps);
  if(platformRateBps>10000)throw new Error('プラットフォーム料率は0〜10000bpです');
  if(input?.overageEnabled!=null||input?.overageRateBps!=null)throw new Error('MG超過後の追加分配条件は未確認のため登録できません');
  const note=input?.note==null?null:String(input.note).trim()||null;
  if(note&&note.length>1000)throw new Error('条件メモは1000文字以内です');
  if(contractType==='self_owned'){
    if(input?.agencyFeeBps!=null&&input.agencyFeeBps!==''&&Number(input.agencyFeeBps)!==0)throw new Error('自社権利型には代理店手数料を設定しません');
    if(input?.recoupBasis!=null&&input.recoupBasis!=='')throw new Error('自社権利型にはMG回収基礎を設定しません');
    return {platformRateBps,agencyFeeBps:null,recoupBasis:null,overageEnabled:null,overageRateBps:null,note};
  }
  const agencyFeeBps=integer(input?.agencyFeeBps);
  if(agencyFeeBps>10000)throw new Error('代理店手数料率は0〜10000bpです');
  if(contractType==='commission'){
    if(input?.recoupBasis!=null&&input.recoupBasis!=='')throw new Error('手数料型にはMG回収基礎を設定しません');
    return {platformRateBps,agencyFeeBps,recoupBasis:null,overageEnabled:null,overageRateBps:null,note};
  }
  if(!['platform_net','after_fee'].includes(input?.recoupBasis))throw new Error('MG回収基礎を選択してください');
  return {platformRateBps,agencyFeeBps,recoupBasis:input.recoupBasis,overageEnabled:null,overageRateBps:null,note};
}
const recognitionInputFields=['recognition_basis_id','sales_month','report_received_on','contract_start_on','license_start_on','broadcast_on','basis_reason'];
function hasRecognitionInput(values){return recognitionInputFields.some(key=>Object.hasOwn(values,key))||Object.hasOwn(values,'contract_signed_on');}
function parseRecognition(values,salesPeriodFrom,salesPeriodTo){
  if(!hasRecognitionInput(values))return null;
  if(Object.hasOwn(values,'contract_signed_on'))throw new Error('contract_signed_onは利用できません。契約開始日はcontract_start_onを指定してください');
  const recognitionBasisId=integer(values.recognition_basis_id),basisReason=String(values.basis_reason||'').trim();
  if(![1,2,3,4,5].includes(recognitionBasisId))throw new Error('計上基準IDは1〜5の計上基準マスタから選択してください');
  if(!basisReason||basisReason.length>1000)throw new Error('計上根拠は1〜1000文字で入力してください');
  const dates={sales_month:values.sales_month?month(String(values.sales_month)):null,report_received_on:values.report_received_on?isoDate(String(values.report_received_on)):null,contract_start_on:values.contract_start_on?isoDate(String(values.contract_start_on)):null,license_start_on:values.license_start_on?isoDate(String(values.license_start_on)):null,broadcast_on:values.broadcast_on?isoDate(String(values.broadcast_on)):null};
  const requiredField={1:'sales_month',2:'report_received_on',3:'contract_start_on',4:'license_start_on',5:'broadcast_on'}[recognitionBasisId],requiredDate=dates[requiredField];
  if(!requiredDate)throw new Error(`選択した計上基準には${requiredField}が必要です`);
  if(recognitionBasisId===1&&(salesPeriodFrom.slice(0,7)!==requiredDate||salesPeriodTo.slice(0,7)!==requiredDate))throw new Error('販売月基準は販売期間が同じ単月で、sales_monthと一致する必要があります。月ごとに報告を分割してください');
  const resolvedMonth=recognitionBasisId===1?requiredDate:requiredDate.slice(0,7),specified=values.accounting_month?month(String(values.accounting_month)):null;
  if(specified&&specified!==resolvedMonth)throw new Error(`指定した計上月${specified}と計上基準から算出した${resolvedMonth}が一致しません`);
  return {recognition_basis_id:recognitionBasisId,...dates,basis_reason:basisReason,accounting_status:'unverified',resolved_month:resolvedMonth};
}
function revalidateRecognitionPreview(preview){
  if(preview.kind==='publicity')return;
  const parsed=parseCsv(preview.canonicalRaw||preview.raw||'');
  if(parsed.length!==preview.rows.length)throw new Error('プレビューの行数が原文と一致しません。もう一度プレビューしてください');
  const expected=preview.meta?.recognition??null;
  for(let index=0;index<parsed.length;index++){
    const values=parsed[index].values,salesPeriodFrom=isoDate(values.sales_period_from||values.period_from),salesPeriodTo=isoDate(values.sales_period_to||values.period_to),recognition=parseRecognition(values,salesPeriodFrom,salesPeriodTo);
    if(canonical(recognition)!==canonical(expected))throw new Error('計上基準がプレビュー時の内容と一致しません。もう一度プレビューしてください');
    const resolved=recognition?.resolved_month??month(values.accounting_month);
    if(resolved!==preview.meta.accounting_month||resolved!==preview.rows[index].data.accounting_month)throw new Error('実計上月がプレビュー時の内容と一致しません。もう一度プレビューしてください');
  }
}

const mappingTargets=new Set(['report_key','partner_id','product_id','period_from','period_to','sales_period_from','sales_period_to','accounting_month','description','quantity','amount_ex_tax','tax_amount','amount_inc_tax','supersedes_id',...recognitionInputFields,...channelSalesColumns]);
function normalizeMappingDefinition(input){
  const ignoredColumns=Array.isArray(input?.ignoredColumns)?input.ignoredColumns.map(value=>String(value).trim()):[];
  if(ignoredColumns.some(value=>!value)||new Set(ignoredColumns).size!==ignoredColumns.length)throw new Error('無視する列名に空欄または重複があります');
  const mappings=Array.isArray(input?.mappings)?input.mappings:[];if(!mappings.length||mappings.length>50)throw new Error('列対応は1〜50件です');
  const targets=new Set(),usedColumns=new Set(),normalized=[];
  for(const raw of mappings){const target=String(raw.target||'').trim(),mode=String(raw.mode||'').trim();if(!mappingTargets.has(target)&&!isAttributeTarget(target))throw new Error(`変換先列が許可されていません: ${target}`);if(targets.has(target))throw new Error(`変換先列が重複しています: ${target}`);targets.add(target);
    if(mode==='source'){const source=String(raw.source||'').trim();if(!source)throw new Error(`${target}の元列が空です`);usedColumns.add(source);normalized.push({target,mode,source});continue;}
    if(mode==='literal'){const valueType=String(raw.valueType||'string');if(!['string','integer'].includes(valueType))throw new Error(`${target}の固定値型が不正です`);let value=raw.value==null?'':String(raw.value);if(valueType==='integer')value=String(integer(value,{signed:true}));normalized.push({target,mode,valueType,value});continue;}
    if(['add','subtract','multiply'].includes(mode)){const operands=Array.isArray(raw.operands)?raw.operands.map(value=>String(value).trim()):[];if((mode==='subtract'&&operands.length!==2)||(mode!=='subtract'&&(operands.length<2||operands.length>8))||operands.some(value=>!value))throw new Error(`${target}の${mode}演算列を確認してください`);operands.forEach(value=>usedColumns.add(value));normalized.push({target,mode,operands});continue;}
    throw new Error(`${target}の変換方式が許可されていません`);
  }
  for(const column of ignoredColumns)if(usedColumns.has(column))throw new Error(`使用列を無視列にできません: ${column}`);
  for(const required of ['report_key','partner_id','period_from','period_to','amount_ex_tax','tax_amount','amount_inc_tax'])if(!targets.has(required))throw new Error(`必須の変換先列がありません: ${required}`);
  return {ignoredColumns,mappings:normalized};
}
function mappedValue(rule,values){
  if(rule.mode==='source')return values[rule.source];
  if(rule.mode==='literal')return rule.value;
  const numbers=rule.operands.map(column=>BigInt(integer(values[column],{signed:true})));let result;
  if(rule.mode==='add')result=numbers.reduce((sum,value)=>sum+value,0n);
  else if(rule.mode==='subtract')result=numbers[0]-numbers[1];
  else result=numbers.reduce((total,value)=>total*value,1n);
  const number=Number(result);if(!Number.isSafeInteger(number))throw new Error(`${rule.target}の計算結果が安全な円整数の範囲外です`);return String(number);
}
function transformMappedCsv(text,definition){
  const parsed=parseCsv(text),headers=Object.keys(parsed[0].values),requiredColumns=new Set(definition.mappings.flatMap(rule=>rule.mode==='source'?[rule.source]:rule.operands||[])),allowed=new Set([...requiredColumns,...definition.ignoredColumns]);
  const missing=[...requiredColumns].filter(column=>!headers.includes(column)),unknown=headers.filter(column=>!allowed.has(column));if(missing.length)throw new Error(`元CSVに必要な列がありません: ${missing.join('、')}`);if(unknown.length)throw new Error(`用途未指定の列があります。列対応または無視を明示してください: ${unknown.join('、')}`);
  const targets=definition.mappings.map(rule=>rule.target),trace=[];const output=parsed.map(row=>{const values=[];const steps=[];for(const rule of definition.mappings){const result=mappedValue(rule,row.values);values.push(result);steps.push({target:rule.target,mode:rule.mode,source:rule.source||null,operands:rule.operands||null,literal:rule.mode==='literal'?rule.value:null,result});}trace.push({rowNo:row.rowNo,steps});return values;});
  return {canonicalText:toCsv(targets,output),trace,rowNos:parsed.map(row=>row.rowNo),headers};
}
function revalidateMappedRows(preview){
  const parsed=parseCsv(preview.canonicalRaw||'');if(parsed.length!==preview.rows.length)throw new Error('変換後CSVの行数がプレビューと一致しません');
  for(let index=0;index<parsed.length;index++){
    const values=parsed[index].values,row=preview.rows[index],salesPeriodFrom=isoDate(values.sales_period_from||values.period_from),salesPeriodTo=isoDate(values.sales_period_to||values.period_to),recognition=parseRecognition(values,salesPeriodFrom,salesPeriodTo),accountingMonth=recognition?.resolved_month??month(values.accounting_month);
    let channel=['theatrical','digital','package'].includes(preview.kind)?parseChannelSalesDetail(preview.kind,values):null;
    const observationOnly=packageObservationOnly(preview.kind,values,channel);
    if(observationOnly)channel={...channel,detail:null};
    if((observationOnly?'package_report_observations':'sale_lines')!==row.destination)throw new Error('変換後CSVと登録先が一致しません');
    const expected=observationOnly?{accounting_month:accountingMonth,source_row:row.rowNo}:{product_id:values.product_id?integer(values.product_id):null,partner_id:integer(values.partner_id),sales_period_from:salesPeriodFrom,sales_period_to:salesPeriodTo,accounting_month:accountingMonth,description:values.description||'報告明細',quantity:integer(values.quantity??'',{nullable:true}),amount_ex_tax:integer(values.amount_ex_tax,{signed:true}),tax_amount:integer(values.tax_amount,{signed:true}),amount_inc_tax:integer(values.amount_inc_tax,{signed:true}),source_row:row.rowNo};
    if(!observationOnly&&expected.amount_inc_tax!==expected.amount_ex_tax+expected.tax_amount)throw new Error('変換後CSVの税込額が税抜額＋税額と一致しません');
    if(canonical(expected)!==canonical(row.data)||canonical(channel)!==canonical(row.channel))throw new Error('変換後CSVと売上プレビューが一致しません。もう一度プレビューしてください');
    if(canonical(attributeTextOf(values))!==canonical(row.attributeText||{}))throw new Error('変換後CSVの売上集計シートの列が売上プレビューと一致しません。もう一度プレビューしてください');
  }
}

function packageObservationOnly(kind,values,channel){
  if(kind!=='package'||!channel?.observations.length)return false;
  const noMoney=['amount_ex_tax','tax_amount','amount_inc_tax'].every(key=>values[key]==null||values[key]==='');
  const noSaleFacts=!channel.detail||Object.entries(channel.detail).every(([key,value])=>key==='model'||value===null);
  return noMoney&&noSaleFacts&&(values.quantity==null||values.quantity==='');
}

const resourceSpecs = {
  projects: { table: 'projects', fields: ['code','title','status','budget_yen'], project: false, finance: ['budget_yen'] },
  works: { table: 'works', fields: ['project_id','code','title','format','forecast_yen'], project: 'project_id', finance: ['forecast_yen'] },
  products: { table: 'products', fields: ['sku','name','channel'], project: false },
  partners: { table: 'partners', fields: ['code','name','kind','region'], project: false },
  scenes: { table: 'scenes', fields: ['project_id','work_id','scene_no','day_night','location','synopsis','status'], project: 'project_id' },
  opportunities: { table: 'sales_opportunities', fields: ['project_id','work_id','partner_id','name','stage','expected_yen','close_date'], project: 'project_id', denied: ['production'] },
  expenses: { table: 'expenses', fields: ['project_id','work_id','partner_id','incurred_on','accounting_month','category','description','budget_yen','actual_ex_tax','tax_amount','actual_inc_tax'], project: 'project_id', denied: ['production'] },
  campaigns: { table: 'campaigns', fields: ['project_id','work_id','name','objective','audience_hypothesis','starts_on','ends_on','target_region','target_channel'], project: 'project_id' },
  exposures: { table: 'exposures', fields: ['campaign_id','medium','asset_version','scheduled_at','happened_at','source_url','region'], projectVia: 'campaigns' },
  observations: { table: 'observations', fields: ['exposure_id','metric_definition_id','period_from','period_to','granularity','value_number','value_text','verification','acquired_at','paid_organic','source','region'], projectVia: 'exposures' }
};

// ローカルのセッション Cookie から利用者を引き、操作する組織（Cookie on_org。無効なら org_id が最小の所属）を選ぶ
async function resolveLocal(db, request) {
  const header = request.headers.get('cookie') || '';
  const raw = /(?:^|;\s*)on_session=([^;]+)/.exec(header)?.[1];
  if (!raw) return null;
  let token; try { token = decodeURIComponent(raw); } catch { return null; }
  const row = await db.get(`SELECT u.id AS user_id,u.email,u.display_name,s.expires_at AS session_expires
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?`, [await sha256(token)]);
  if (!row || !activeAt(row.session_expires)) return null;
  return identityForUser(db, row, header);
}

// 見てよい案件の問い合わせ（副問い合わせとして IN (...) に入れる形）。案件IDを値として並べないので、案件が多くても
// D1 の上限（1つの問い合わせに値100個まで）に掛からない
function permittedProjectScope(identity, finance=false) {
  if (identity.role === 'admin') return {sql: 'SELECT id FROM projects WHERE org_id=?', params: [identity.org_id]};
  return {sql: `SELECT p.id FROM projects p JOIN project_memberships pm ON pm.org_id=p.org_id AND pm.project_id=p.id
    WHERE p.org_id=? AND pm.user_id=? AND (pm.expires_at IS NULL OR pm.expires_at>?) ${finance?"AND pm.permission='edit'":''}`, params: [identity.org_id, identity.user_id, nowIso()]};
}
async function permittedProjects(db, identity, finance=false) {
  const scope = permittedProjectScope(identity, finance);
  return db.all(scope.sql, scope.params);
}
async function canProject(db, identity, projectId) {
  if (!Number.isInteger(Number(projectId))) return false;
  if (identity.role === 'admin') return Boolean(await db.get('SELECT 1 FROM projects WHERE org_id=? AND id=?', [identity.org_id, projectId]));
  return Boolean(await db.get(`SELECT 1 FROM project_memberships pm JOIN projects p ON p.org_id=pm.org_id AND p.id=pm.project_id
    WHERE pm.org_id=? AND pm.project_id=? AND pm.user_id=? AND (pm.expires_at IS NULL OR pm.expires_at>?)`, [identity.org_id, projectId, identity.user_id, nowIso()]));
}
async function projectForRow(db, orgId, name, data) {
  if (data.project_id) return Number(data.project_id);
  if (name === 'exposures') return Number((await db.get('SELECT project_id FROM campaigns WHERE org_id=? AND id=?', [orgId,data.campaign_id]))?.project_id);
  if (name === 'observations') return Number((await db.get(`SELECT c.project_id FROM exposures e JOIN campaigns c ON c.org_id=e.org_id AND c.id=e.campaign_id WHERE e.org_id=? AND e.id=?`, [orgId,data.exposure_id]))?.project_id);
  return null;
}

function normalizeResource(name, source) {
  const spec = resourceSpecs[name]; const data = {};
  for (const field of spec.fields) if (Object.hasOwn(source, field)) data[field] = source[field] === '' ? null : source[field];
  const ints = ['project_id','work_id','partner_id','campaign_id','exposure_id','metric_definition_id','budget_yen','forecast_yen','expected_yen','actual_ex_tax','tax_amount','actual_inc_tax'];
  for (const key of ints) if (data[key] != null) data[key] = integer(data[key], { signed: ['actual_ex_tax','tax_amount','actual_inc_tax'].includes(key) });
  for (const key of ['starts_on','ends_on','incurred_on','close_date','period_from','period_to']) if(data[key]!=null) data[key]=isoDate(String(data[key]));
  if(data.accounting_month!=null) data.accounting_month=month(data.accounting_month);
  for(const [key,value] of Object.entries(data)) if(typeof value==='string' && value.length>4000) throw new Error(`${key}は4000文字以内です`);
  if (name === 'expenses' && data.actual_inc_tax !== data.actual_ex_tax + data.tax_amount) throw new Error('税込額は税抜額と税額の合計にしてください');
  if (name === 'observations') {
    if (data.value_number != null) { const n = Number(data.value_number); if (!Number.isFinite(n)) throw new Error('指標値を数値として確認できません'); data.value_number = n; }
    if (data.value_number != null && data.value_text != null) throw new Error('指標値は数値か文字列の一方だけです');
  }
  return data;
}

export function createApp({ db, mode = 'local', authenticate, extractDocument, extractWorkbenchFile, suggestMappings, ai = { enabled: false, provider: null, modelAllowlist: [], maxCalls: 0, maxTokens: 0 } }) {
  const app = new Hono();
  app.use('/api/*',async(c,next)=>{
    c.header('Cache-Control','private, no-store');
    if(!['GET','HEAD'].includes(c.req.method)) {
      const origin=c.req.header('Origin');
      if(origin && origin!==new URL(c.req.url).origin) return bad(c,'別サイトからの操作は受け付けません',403);
      if(c.req.method!=='DELETE' && !/^application\/json(?:;|$)/i.test(c.req.header('Content-Type')||''))return bad(c,'JSON形式で送信してください',415);
      const limit=['/api/workflow/artifacts/extract','/api/workbench/files/extract','/api/sales-import/files'].includes(c.req.path)?8*1024*1024:/^\/api\/(imports|mapped-imports|bulk\/[^/]+|workbench\/drafts|sales-import)(\/|$)/.test(c.req.path)?Math.max(512000,importLimits(mode).bytes*2):512000;// 取込の上限（ローカル2,000行・約2MB）まで受け取れるようにする。Worker は従来の512KBのまま
      const bytes=await c.req.raw.clone().arrayBuffer();if(bytes.byteLength>limit)return bad(c,`入力は${Math.floor(limit/1024)}KB以内です`,413);
    }
    await next();
  });
  app.onError((error, c) => { console.error(error); return bad(c, error.message || '処理に失敗しました', isDbConflict(error) || /locked|cannot|mismatch|requires/i.test(error.message) ? 409 : 500, undefined, error); });
  // database は入口の DB の種類（PgDatabase は dialect が postgres。Worker の D1 の入口と手元の LocalDatabase には dialect が無い）
  app.get('/api/health', c => c.json({ ok: true, mode, database: db.dialect === 'postgres' ? 'postgres' : mode === 'worker' ? 'd1' : 'sqlite', ai: { enabled: ai.enabled === true, provider: ai.enabled ? ai.provider : null, verified: false } }));

  app.post('/api/local/login', async c => {
    if (mode !== 'local') return bad(c, 'ローカルログインはWorkerでは利用できません', 404);
    const input = await body(c); const email = String(input.email || '').trim().toLowerCase();
    if(!email.endsWith('.invalid'))return bad(c,'ローカルは架空メール専用です',403);
    // 所属が複数あるときは org_id が最小の組織で入る（組織は入ったあと上部の「組織」で切り替える）
    const found = await db.get('SELECT id AS user_id,email,display_name FROM users WHERE email=?', [email]);
    const membership = found ? (await activeMemberships(db, found.user_id))[0] : null;
    if (!membership) return bad(c, '利用可能な架空メンバーではありません', 403);
    const user = {...found, org_id: membership.org_id, role: membership.role, expires_at: membership.expires_at};
    const token = randomToken(), hash = await sha256(token), expires = new Date(Date.now() + 8 * 3600_000).toISOString();
    await db.run('INSERT INTO sessions(id_hash,user_id,org_id,expires_at) VALUES(?,?,?,?)', [hash,user.user_id,user.org_id,expires]);
    setCookie(c, 'on_session', token, { httpOnly: true, sameSite: 'Strict', secure: false, maxAge: 8*3600, path: '/' });
    // 前の人が選んだ組織（退出せずにセッションが切れたときなどに残る）から始めない。入ると既定の組織（sessions.org_id と同じ）
    if (getCookie(c, ORG_COOKIE) !== undefined) deleteCookie(c, ORG_COOKIE, {path: '/'});
    return c.json({ ok: true, user: { email:user.email, displayName:user.display_name, role:user.role }, expiresAt: expires });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/local/login') return next();
    const identity = mode === 'local' ? await resolveLocal(db, c.req.raw) : await authenticate?.(c.req.raw, db);
    if (!identity || !activeAt(identity.expires_at)) return bad(c, '認証または所属の有効期限を確認できません', 401);
    // 画面が描いている組織（X-On-Org）とこの要求の組織が食い違えば、読み書きとも 409（別の画面で切り替えた・選んだ組織の所属が無効になった）。
    // 今の組織を知る API（/api/session 系）だけは照合しない
    if (!ORG_CHECK_EXEMPT_PATHS.includes(c.req.path)) {
      const mismatch = orgMismatch(identity, c.req.header(ORG_HEADER));
      if (mismatch) return c.json(orgMismatchBody(mismatch), 409);
    }
    c.set('identity', identity); await next();
  });
  // 選んでいた組織が無効で既定へ戻したときは、Cookie を消して既定の組織にそろえる（次の要求から照合で止めない）
  const settleOrgChoice = (c, i) => { if (i.org_fallback) deleteCookie(c, ORG_COOKIE, {path: '/'}); };
  app.get('/api/semantic-definitions', c=>c.json(semanticDocument));
  app.get('/api/session', c => { const i=c.get('identity'); settleOrgChoice(c,i); return c.json({ ok:true,user:{id:i.user_id,email:i.email,displayName:i.display_name,role:i.role,orgId:i.org_id},orgReset:Boolean(i.org_fallback),mode }); });
  // 所属している組織の一覧（有効な所属だけ、org_id の小さい順）。画面は2つ以上のときだけ「組織」の切替を出す
  app.get('/api/session/orgs', async c => {
    const i=c.get('identity'); settleOrgChoice(c,i);
    const orgs=(await activeMemberships(db,i.user_id)).map(m=>({id:m.org_id,code:m.org_code,name:m.org_name,role:m.role}));
    return c.json({ok:true,currentOrgId:i.org_id,orgs});
  });
  // 所属している組織のうち、デモ・機能がある組織（画面の「組織を切り替えて開く」の案内用）。返すのは組織の id と名前だけで、
  // 作品・列などの中身は返さない。判定は自分の有効な所属の範囲だけで、その組織での自分の役割と案件の権限に従う。
  // koubanDemo: 香盤のデモ（作品 DEMO-D78）を自分が見られる組織。salesSheet: 売上集計シートの列を採用済みで、自分が財務の画面を使える組織
  app.get('/api/session/org-features', async c => {
    const i=c.get('identity'), now=nowIso(), koubanDemo=[], salesSheet=[];
    for(const m of await activeMemberships(db,i.user_id)){
      const org={id:m.org_id,name:m.org_name};
      const work=m.role==='admin'
        ? await db.get('SELECT 1 AS ok FROM works WHERE org_id=? AND code=?',[m.org_id,KOUBAN_DEMO_CODE])
        : await db.get(`SELECT 1 AS ok FROM works w JOIN project_memberships pm ON pm.org_id=w.org_id AND pm.project_id=w.project_id
            WHERE w.org_id=? AND w.code=? AND pm.user_id=? AND (pm.expires_at IS NULL OR pm.expires_at>?)`,[m.org_id,KOUBAN_DEMO_CODE,i.user_id,now]);
      if(work)koubanDemo.push(org);
      if(m.role!=='production'&&await db.get('SELECT 1 AS ok FROM sales_sheet_column_versions WHERE org_id=? LIMIT 1',[m.org_id]))salesSheet.push(org);
    }
    return c.json({ok:true,currentOrgId:i.org_id,koubanDemo,salesSheet});
  });
  // 操作する組織を切り替える。所属していない組織は 403。選んだ組織は Cookie on_org（利用者ID:組織ID）に持ち、毎回の要求で所属を確かめ直す。
  // 切替の記録は業務データの変更ではないので audit_log ではなく org_switch_events に残す（分析の「更新あり」の判定を動かさない）
  app.post('/api/session/org', async c => {
    const i=c.get('identity'), input=await body(c), orgId=Number(input?.orgId);
    if(!Number.isSafeInteger(orgId)||orgId<1) return bad(c,'切り替える組織を選んでください');
    const target=(await activeMemberships(db,i.user_id)).find(m=>m.org_id===orgId);
    if(!target) return bad(c,'所属していない組織には切り替えられません',403);
    setCookie(c,ORG_COOKIE,orgCookieValue(i.user_id,orgId),orgCookieOptions(c.req.url));
    if(target.org_id!==Number(i.org_id)) await db.run('INSERT INTO org_switch_events(org_id,user_id,from_org_id) VALUES(?,?,?)',[orgId,i.user_id,Number(i.org_id)]);
    return c.json({ok:true,org:{id:target.org_id,code:target.org_code,name:target.org_name,role:target.role}});
  });
  app.get('/api/workflow/capabilities',c=>c.json({ok:true,extractionEnabled:typeof extractDocument==='function',mappingAiEnabled:typeof suggestMappings==='function'}));
  app.delete('/api/session', async c => {
    if (mode === 'local') { const token=getCookie(c,'on_session'); if(token) await db.run('DELETE FROM sessions WHERE id_hash=?',[await sha256(token)]); deleteCookie(c,'on_session',{path:'/'}); }
    // 次に入る人（別の利用者のこともある）が前の人の選んだ組織から始まらないよう、組織の選択も消す
    if (getCookie(c,ORG_COOKIE) !== undefined) deleteCookie(c,ORG_COOKIE,{path:'/'});
    return c.json({ok:true});
  });

  app.get('/api/bootstrap', async c => {
    const i=c.get('identity'), pids=(await permittedProjects(db,i)).map(x=>x.id); if(!pids.length) return c.json({ok:true,projects:[],works:[],products:[],partners:[],metrics:[],productAllocations:[],recognitionBases:await db.all('SELECT id,code,name,source_field FROM recognition_bases ORDER BY id'),ai:{enabled:ai.enabled===true,verified:false}});
    // 案件IDを値として並べず、見てよい案件の副問い合わせで絞る（案件が100件以上でも D1 の値の上限に掛からない）
    const scope=permittedProjectScope(i), args=[i.org_id,...scope.params];
    let projects=await db.all(`SELECT * FROM projects WHERE org_id=? AND id IN (${scope.sql}) ORDER BY id`,args);
    let works=await db.all(`SELECT * FROM works WHERE org_id=? AND project_id IN (${scope.sql}) ORDER BY id`,args);
    const financeIds=new Set((await permittedProjects(db,i,true)).map(p=>p.id));projects=projects.map(row=>{if(i.role==='production'||!financeIds.has(row.id)){const {budget_yen,...rest}=row;return rest;}return row;});works=works.map(row=>{if(i.role==='production'||!financeIds.has(row.project_id)){const {forecast_yen,...rest}=row;return rest;}return row;});
    const [products,partners,metrics,recognitionBases]=await Promise.all([
      db.all('SELECT * FROM products WHERE org_id=? ORDER BY id',[i.org_id]), db.all('SELECT * FROM partners WHERE org_id=? ORDER BY id',[i.org_id]),
      db.all('SELECT id,field_key,label,value_type,unit,aggregation FROM metric_definitions WHERE org_id=? AND active=1 ORDER BY id',[i.org_id]),db.all('SELECT id,code,name,source_field FROM recognition_bases ORDER BY id')]);
    const productAllocations=await db.all('SELECT pw.* FROM product_works pw JOIN works w ON w.org_id=pw.org_id AND w.id=pw.work_id WHERE pw.org_id=?',[i.org_id]);
    return c.json({ok:true,projects,works,products,partners,metrics,recognitionBases,productAllocations:productAllocations.filter(p=>works.some(w=>w.id===p.work_id)),ai:{enabled:ai.enabled===true,verified:false}});
  });

  registerExpenseRoutes(app,{db,bad,body,permittedProjects});

  app.get('/api/:resource', async (c,next) => {
    const name=c.req.param('resource'), spec=resourceSpecs[name]; if(!spec) return next();
    const i=c.get('identity'); if(spec.denied?.includes(i.role)) return bad(c,'この役割では財務データを参照できません',403);
    // 見てよい案件は副問い合わせで絞る（案件IDを値として並べない。D1 の値の上限100個に掛からない）
    const scope=permittedProjectScope(i,Boolean(spec.denied)), args=[i.org_id,...scope.params]; let rows;
    if(spec.project||name==='projects'){ rows=await db.all(`SELECT * FROM ${name==='expenses'?expenseSource():spec.table} WHERE org_id=? AND ${name==='projects'?'id':spec.project} IN (${scope.sql}) ORDER BY id DESC`,args); }
    else if(name==='exposures'){ rows=await db.all(`SELECT e.* FROM exposures e JOIN campaigns c ON c.org_id=e.org_id AND c.id=e.campaign_id WHERE e.org_id=? AND c.project_id IN (${scope.sql}) ORDER BY e.id DESC`,args); }
    else if(name==='observations'){ rows=await db.all(`SELECT o.* FROM observations o JOIN exposures e ON e.org_id=o.org_id AND e.id=o.exposure_id JOIN campaigns c ON c.org_id=e.org_id AND c.id=e.campaign_id WHERE o.org_id=? AND c.project_id IN (${scope.sql}) ORDER BY o.id DESC`,args); }
    else rows=await db.all(`SELECT * FROM ${spec.table} WHERE org_id=? ORDER BY id DESC`,[i.org_id]);
    if(name==='expenses')rows=await resolveExpenseAccounts(db,i.org_id,rows);
    if(spec.finance){const allowed=new Set((await permittedProjects(db,i,true)).map(p=>p.id));rows=rows.map(row=>{const copy={...row};if(i.role==='production'||!allowed.has(name==='projects'?row.id:row.project_id))for(const f of spec.finance)delete copy[f];return copy;});}
    return c.json({ok:true,rows});
  });

  app.post('/api/:resource', async (c,next) => {
    const name=c.req.param('resource'), spec=resourceSpecs[name]; if(!spec) return next();
    const i=c.get('identity'); if(i.role==='production'&&name!=='scenes'&&name!=='campaigns'&&name!=='exposures'&&name!=='observations') return bad(c,'この役割では登録できません',403);
    if(spec.denied?.includes(i.role)) return bad(c,'この役割では財務データを登録できません',403);
    const data=normalizeResource(name,await body(c)), projectId=await projectForRow(db,i.org_id,name,data);
    if(spec.project||spec.projectVia) if(!await canProject(db,i,projectId)) return bad(c,'案件への権限がありません',403);
    if(spec.denied && !(await permittedProjects(db,i,true)).some(p=>p.id===projectId))return bad(c,'案件の財務編集権限がありません',403);
    const fields=Object.keys(data); if(!fields.length) return bad(c,'登録項目がありません');
    const out=await db.get(`INSERT INTO ${spec.table}(org_id,${fields.join(',')}) VALUES(?,${fields.map(()=>'?').join(',')}) RETURNING id`,[i.org_id,...fields.map(k=>data[k])]);
    if(name==='projects'&&i.role!=='admin')await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(?,?,?,'edit')",[i.org_id,out.id,i.user_id]);
    await db.run('INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',[i.org_id,i.user_id,'create',name,String(out.id),json(data)]);
    return c.json({ok:true,id:out.id},201);
  });

  app.patch('/api/:resource/:id', async (c,next) => {
    const name=c.req.param('resource'),spec=resourceSpecs[name]; if(!spec||!['scenes','campaigns','exposures','expenses','opportunities'].includes(name))return next();
    const i=c.get('identity'); if(spec.denied?.includes(i.role))return bad(c,'更新権限がありません',403);
    const expected=Number(c.req.header('If-Match')||0); if(!Number.isInteger(expected)||expected<1)return bad(c,'If-Matchに現在のversionが必要です',428);
    const existing=await db.get(`SELECT * FROM ${spec.table} WHERE org_id=? AND id=?`,[i.org_id,c.req.param('id')]); if(!existing)return bad(c,'対象がありません',404);
    const projectId=await projectForRow(db,i.org_id,name,existing);if(!await canProject(db,i,projectId))return bad(c,'案件への権限がありません',403);
    const incoming=await body(c);const data=normalizeResource(name,{...existing,...incoming}),fields=Object.keys(data);if(!fields.length)return bad(c,'更新項目がありません');
    if(!await canProject(db,i,await projectForRow(db,i.org_id,name,data)))return bad(c,'移動先の案件への権限がありません',403);
    if(spec.denied){const ids=(await permittedProjects(db,i,true)).map(p=>p.id);if(!ids.includes(projectId)||!ids.includes(await projectForRow(db,i.org_id,name,data)))return bad(c,'案件の財務編集権限がありません',403);}
    try{await db.batch([
      {sql:`INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM ${spec.table} WHERE org_id=? AND id=? AND version=?)`,params:[i.org_id,c.req.param('id'),expected]},
      {sql:`UPDATE ${spec.table} SET ${fields.map(k=>`${k}=?`).join(',')},version=version+1 WHERE org_id=? AND id=? AND version=?`,params:[...fields.map(k=>data[k]),i.org_id,c.req.param('id'),expected]},
      {sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'update',name,String(c.req.param('id')),json({before:existing,after:{...data,version:expected+1}})]}
    ])}catch(error){return bad(c,'別の利用者が更新しました。再読込してください',409,{cause:error.message})}
    return c.json({ok:true,version:expected+1});
  });

  const allocationRefTables=[['sales_agreements','販売契約'],['sales_material_snapshots','営業資料'],['catalog_product_editions','作品マスタの商品版'],['catalog_product_windows','作品マスタの販売ウィンドウ']];
  async function productAllocationState(i,productId){
    const current=await db.all('SELECT pw.work_id,pw.allocation_bps,w.project_id FROM product_works pw JOIN works w ON w.org_id=pw.org_id AND w.id=pw.work_id WHERE pw.org_id=? AND pw.product_id=? ORDER BY pw.work_id',[i.org_id,productId]),hidden=[];
    for(const row of current)if(!await canProject(db,i,row.project_id))hidden.push(row.work_id);
    const count=async table=>Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=? AND product_id=?`,[i.org_id,productId]))?.n||0),sales=await count('sale_lines'),packages=await count('package_observation_products'),mg=await count('mg_version_products');
    const reasons=[...(sales?[`売上明細 ${sales}件`]:[]),...(packages?[`パッケージ報告の数量 ${packages}件`]:[]),...(mg?[`MG契約 ${mg}件`]:[])];
    return {allocations:current.map(r=>({workId:r.work_id,allocationBps:r.allocation_bps})),hidden,reasons,lockMessage:sales||packages?'売上登録済みの商品は配賦を変更できません':mg?'MG契約に登録済みの商品は配賦を変更できません':null};
  }
  const sameAllocation=(a,b)=>{const key=list=>JSON.stringify(list.map(x=>[Number(x.workId),Number(x.allocationBps)]).sort((x,y)=>x[0]-y[0]));return key(a)===key(b)};
  app.get('/api/product-works', async c => {
    const i=c.get('identity');if(i.role==='production')return bad(c,'商品配賦の編集権限がありません',403);
    let productId;try{productId=integer(c.req.query('productId'))}catch{return bad(c,'商品を選んでください')}
    if(!await db.get('SELECT 1 FROM products WHERE org_id=? AND id=?',[i.org_id,productId]))return bad(c,'商品がありません',404);
    const state=await productAllocationState(i,productId),lockReasons=[...(state.lockMessage?[`${state.lockMessage}（${state.reasons.join('、')}）`]:[]),...(state.hidden.length?['権限のない作品への配賦を含むため、この商品の配賦は変更できません']:[])];
    return c.json({ok:true,productId,allocations:state.allocations.filter(a=>!state.hidden.includes(a.workId)),hiddenCount:state.hidden.length,locked:lockReasons.length>0,lockReasons});
  });
  app.post('/api/product-works', async c => {
    const i=c.get('identity');if(i.role==='production')return bad(c,'商品配賦の編集権限がありません',403);
    const input=await body(c),parse=list=>list.map(a=>({workId:integer(a.workId),allocationBps:integer(a.allocationBps)}));let productId,allocations,base=null;
    try{productId=integer(input.productId);if(!Array.isArray(input.allocations)||!input.allocations.length)throw new Error('配賦する作品を1行以上入れてください');allocations=parse(input.allocations);if(Object.hasOwn(input,'baseAllocations')){if(!Array.isArray(input.baseAllocations))throw new Error('編集開始時の配賦を確認できません');base=parse(input.baseAllocations)}}catch(error){return bad(c,error.message,400,undefined,error)}
    if(allocations.some(a=>a.allocationBps<1||a.allocationBps>10000))return bad(c,'各作品の配賦は0%より大きく100%以下にしてください');
    if(new Set(allocations.map(a=>a.workId)).size!==allocations.length)return bad(c,'同じ作品が複数行にあります。1行にまとめてください');
    if(allocations.reduce((n,x)=>n+x.allocationBps,0)!==10000)return bad(c,'作品配賦は合計100.00%（10000bp）が必要です');
    if(!await db.get('SELECT 1 FROM products WHERE org_id=? AND id=?',[i.org_id,productId]))return bad(c,'商品がありません',404);
    for(const a of allocations){const work=await db.get('SELECT project_id FROM works WHERE org_id=? AND id=?',[i.org_id,a.workId]);if(!work||!await canProject(db,i,work.project_id))return bad(c,'作品への権限がありません',403);}
    const state=await productAllocationState(i,productId);if(state.hidden.length)return bad(c,'権限のない作品への配賦を含むため、この商品の配賦は変更できません',403);
    if(state.lockMessage)return bad(c,state.lockMessage,409,{reasons:state.reasons});
    if(base===null&&state.allocations.length)return bad(c,'編集開始時の配賦（baseAllocations）が必要です。再読込して直してください',428);
    if(base!==null&&!sameAllocation(base,state.allocations))return bad(c,'他の人が先に更新しました。再読込して直してください',409,{current:state.allocations});
    const next=new Set(allocations.map(a=>a.workId)),kept=new Set(state.allocations.map(a=>a.workId)),removed=state.allocations.filter(a=>!next.has(a.workId)).map(a=>a.workId);
    for(const workId of removed)for(const [table,label] of allocationRefTables)if(await db.get(`SELECT 1 FROM ${table} WHERE org_id=? AND product_id=? AND work_id=? LIMIT 1`,[i.org_id,productId,workId]))return bad(c,`${label}で使っている作品は配賦から外せません`,409,{workId,reason:label});
    const guard=(sql,params)=>({sql:`INSERT INTO transaction_guards(value) SELECT 0 WHERE ${sql}`,params});
    const statements=[...['sale_lines','package_observation_products','mg_version_products'].map(table=>guard(`EXISTS(SELECT 1 FROM ${table} WHERE org_id=? AND product_id=?)`,[i.org_id,productId])),guard('(SELECT COUNT(*) FROM product_works WHERE org_id=? AND product_id=?)<>?',[i.org_id,productId,state.allocations.length]),...state.allocations.map(a=>guard('NOT EXISTS(SELECT 1 FROM product_works WHERE org_id=? AND product_id=? AND work_id=? AND allocation_bps=?)',[i.org_id,productId,a.workId,a.allocationBps])),...removed.map(workId=>({sql:'DELETE FROM product_works WHERE org_id=? AND product_id=? AND work_id=?',params:[i.org_id,productId,workId]})),...allocations.map(a=>kept.has(a.workId)?{sql:'UPDATE product_works SET allocation_bps=? WHERE org_id=? AND product_id=? AND work_id=?',params:[a.allocationBps,i.org_id,productId,a.workId]}:{sql:'INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(?,?,?,?)',params:[i.org_id,productId,a.workId,a.allocationBps]}),{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'allocate','product_works',String(productId),json({before:state.allocations,after:allocations})]}];
    try{await db.batch(statements)}catch(error){const latest=await productAllocationState(i,productId);if(latest.lockMessage)return bad(c,latest.lockMessage,409,{reasons:latest.reasons});return bad(c,'他の人が先に更新しました。再読込して直してください',409,{current:latest.allocations,cause:error.message})}
    return c.json({ok:true,allocations:[...allocations].sort((a,b)=>a.workId-b.workId)});
  });

  app.get('/api/downloads/:kind', async c => {
    const i=c.get('identity'),kind=c.req.param('kind'),workId=integer(c.req.query('workId')||'');
    const work=await db.get('SELECT project_id FROM works WHERE org_id=? AND id=?',[i.org_id,workId]);if(!work||!await canProject(db,i,work.project_id))return bad(c,'作品への権限がありません',403);
    if(i.role==='production'&&kind!=='publicity')return bad(c,'制作担当には財務取込テンプレートを表示しません',403);
    if(kind!=='publicity'&&!(await permittedProjects(db,i,true)).some(p=>p.id===work.project_id))return bad(c,'案件の財務権限がありません',403);
    let csv;
    if(kind==='publicity'){
      const campaign=await db.get('SELECT id FROM campaigns WHERE org_id=? AND work_id=? ORDER BY id LIMIT 1',[i.org_id,workId]);
      const exposure=campaign&&await db.get('SELECT id FROM exposures WHERE org_id=? AND campaign_id=? ORDER BY id LIMIT 1',[i.org_id,campaign.id]);
      csv=toCsv(['campaign_id','exposure_id','metric_key','period_from','period_to','granularity','value','verification','acquired_at','region','source','paid_organic'],[[campaign?.id||'',exposure?.id||'','impressions','2026-09-01','2026-09-30','month','1000','unverified','2026-09-30T12:00:00Z','','架空サンプル','paid']]);
    }else{
      if(!['theatrical','digital','package'].includes(kind))return bad(c,'種類が不明です',404);
      const partner=await db.get(`SELECT id FROM partners WHERE org_id=? AND kind=? ORDER BY id LIMIT 1`,[i.org_id,kind==='theatrical'?'cinema':kind==='digital'?'platform':'retailer']);
      const product=await db.get(`SELECT p.id FROM products p JOIN product_works pw ON pw.org_id=p.org_id AND pw.product_id=p.id WHERE p.org_id=? AND p.channel=? AND pw.work_id=? ORDER BY p.id LIMIT 1`,[i.org_id,kind,workId]);
      const recognition=kind==='theatrical'?['1','2026-09','','','','','販売実績が発生した単月で計上','2026-09']:kind==='digital'?['2','','2026-10-05','','','','配信事業者の月次報告を受領した月で計上','2026-10']:['3','','','2026-08-15','','','契約の利用可能期間が始まる月を管理基準として仮設定','2026-08'];
      const headers=['report_key','partner_id','product_id','period_from','period_to','recognition_basis_id','sales_month','report_received_on','contract_start_on','license_start_on','broadcast_on','basis_reason','accounting_month','description','quantity','amount_ex_tax','tax_amount','amount_inc_tax','supersedes_id','sales_period_from','sales_period_to'];
      const values=[`${kind}-${workId}-202609`,partner?.id||'',product?.id||'','2026-09-01','2026-09-30',...recognition,`${kind} 架空売上`,'','10000','1000','11000','','2026-09-01',kind==='theatrical'?'2026-09-01':'2026-09-30'];
      const channelExamples={theatrical:{theatrical_model:'theatrical_rs',ticket_type_code:'ADULT',purchase_channel:'counter',admissions_count:'10',gross_box_office_ex_tax:'10000'},digital:{digital_model:'tvod',service_code:'SAMPLE_SERVICE',sales_count:'10',unit_price_ex_tax:'1000'},package:{package_model:'rental',turns_count:'10',average_rental_price_ex_tax:'1000'}};
      const example=channelExamples[kind];csv=toCsv([...headers,...Object.keys(example)],[[...values,...Object.values(example)]]);
    }
    return new Response('\uFEFF'+csv,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${kind}-work-${workId}.csv"`}});
  });

  async function salesMasterFingerprint(identity,workId,rows){
    const partnerIds=[...new Set(rows.map(row=>row.ids.partnerId))].sort((a,b)=>a-b);
    const productIds=[...new Set(rows.map(row=>row.ids.productId).filter(id=>id!=null))].sort((a,b)=>a-b);
    const work=await db.get('SELECT id,project_id,version FROM works WHERE org_id=? AND id=?',[identity.org_id,workId]);
    const partners=[];for(const id of partnerIds)partners.push(await db.get('SELECT id,version,kind FROM partners WHERE org_id=? AND id=?',[identity.org_id,id]));
    const products=[];for(const id of productIds)products.push(await db.get('SELECT id,version,channel FROM products WHERE org_id=? AND id=?',[identity.org_id,id]));
    const allocations=[];for(const id of productIds)allocations.push(...await db.all('SELECT product_id,work_id,allocation_bps FROM product_works WHERE org_id=? AND product_id=? ORDER BY work_id',[identity.org_id,id]));
    return sha256(canonical({work,partners,products,allocations}));
  }

  async function previewImport(c,input) {
    const i=c.get('identity'),kind=String(input.kind||''),workId=integer(input.workId),canonicalRaw=String(input.text||''),raw=String(input.sourceText??canonicalRaw);
    if(!['theatrical','digital','package','broadcast','other','publicity'].includes(kind))return bad(c,'取込種類が不明です');
    if(i.role==='production'&&kind!=='publicity')return bad(c,'制作担当には財務取込を許可していません',403);
    const work=await db.get('SELECT project_id FROM works WHERE org_id=? AND id=?',[i.org_id,workId]);if(!work||!await canProject(db,i,work.project_id))return bad(c,'作品への権限がありません',403);
    if(kind!=='publicity'&&!(await permittedProjects(db,i,true)).some(p=>p.id===work.project_id))return bad(c,'案件の財務権限がありません',403);
    let parsed;try{parsed=parseCsv(canonicalRaw);const importCap=importLimits(mode);if(parsed.length>importCap.salesRows)throw Error(`1回に取り込める行数は${importCap.salesRows}行までです`);const byteCap=reportByteLimit(importCap);if(utf8Bytes(raw)>byteCap||utf8Bytes(canonicalRaw)>byteCap)throw Error(`報告書は約${Math.floor(byteCap/1000)}KB以内です（UTF-8で数えます）`);}catch(e){return bad(c,e.message,400,undefined,e);}
    const errors=[],rows=[];let salesReportMeta=null;
    if(kind==='publicity'){
      for(const [index,row] of parsed.entries()){const sourceRowNo=input.sourceRowNos?.[index]??row.rowNo;try{
        const v=row.values,exposureId=integer(v.exposure_id),metric=await db.get('SELECT id,value_type,unit,aggregation FROM metric_definitions WHERE org_id=? AND field_key=? AND active=1',[i.org_id,v.metric_key]);
        const scope=await db.get(`SELECT c.work_id,c.project_id FROM exposures e JOIN campaigns c ON c.org_id=e.org_id AND c.id=e.campaign_id WHERE e.org_id=? AND e.id=?`,[i.org_id,exposureId]);
        if(!metric)throw new Error(`未定義の指標です: ${v.metric_key}`);if(!scope||scope.work_id!==workId)throw new Error('露出が選択作品に属していません');
        const empty=v.value==='';let numberValue=null,textValue=null;if(!empty){if(metric.value_type==='text')textValue=v.value;else{numberValue=Number(v.value);if(!Number.isFinite(numberValue))throw new Error('指標値が数値ではありません');if(metric.value_type==='integer'&&!Number.isInteger(numberValue))throw new Error('整数指標に小数は登録できません');if(metric.value_type==='boolean'&&![0,1].includes(numberValue))throw new Error('真偽指標は0または1です');}}
        rows.push({rowNo:sourceRowNo,destination:'observations',ids:{workId,exposureId,metricDefinitionId:metric.id},data:{exposure_id:exposureId,metric_definition_id:metric.id,period_from:isoDate(v.period_from),period_to:isoDate(v.period_to),paid_organic:v.paid_organic||'unknown',granularity:v.granularity||'unknown',value_number:numberValue,value_text:textValue,verification:v.verification||'unverified',acquired_at:v.acquired_at||nowIso(),region:v.region||null,source:v.source||null}});
      }catch(e){errors.push({rowNo:sourceRowNo,message:e.message});}}
    }else{
      let meta=null;let attributeContext;try{attributeContext=await attributeImportContext(db,i.org_id,parsed.length?Object.keys(parsed[0].values):[]);}catch(error){return bad(c,error.message,400,undefined,error);}for(const [index,row] of parsed.entries()){const sourceRowNo=input.sourceRowNos?.[index]??row.rowNo;try{const v=row.values,partnerId=integer(v.partner_id),productId=v.product_id?integer(v.product_id):null;
        const partner=await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?',[i.org_id,partnerId]);if(!partner)throw new Error('取引先IDが選択組織にありません');
        if(v.sales_period_from&&(isoDate(v.sales_period_from)<isoDate(v.period_from)||isoDate(v.sales_period_from)>isoDate(v.period_to)))throw Error('販売期間が報告対象期間外です');if(v.sales_period_to&&(isoDate(v.sales_period_to)>isoDate(v.period_to)||isoDate(v.sales_period_to)<isoDate(v.sales_period_from||v.period_from)))throw Error('販売期間が報告対象期間外または逆転しています');
        if(productId&&!await db.get('SELECT 1 FROM products p JOIN product_works pw ON pw.org_id=p.org_id AND pw.product_id=p.id WHERE p.org_id=? AND p.id=? AND pw.work_id=? AND p.channel=?',[i.org_id,productId,workId,kind]))throw new Error('商品が選択作品・販路に結び付いていません');
        const salesPeriodFrom=isoDate(v.sales_period_from||v.period_from),salesPeriodTo=isoDate(v.sales_period_to||v.period_to),recognition=parseRecognition(v,salesPeriodFrom,salesPeriodTo),accountingMonth=recognition?.resolved_month??month(v.accounting_month);
        const current={report_key:v.report_key,partner_id:partnerId,period_from:isoDate(v.period_from),period_to:isoDate(v.period_to),accounting_month:accountingMonth,supersedes_id:v.supersedes_id?integer(v.supersedes_id):null,recognition};
        if(!current.report_key?.trim()||current.report_key.length>200)throw Error('報告書キーは1〜200文字です');if(current.period_to<current.period_from)throw Error('期間が逆転しています');
        if(meta&&json(meta)!==json(current))throw new Error('同じCSV内で報告書情報または算出した計上月が一致しません。計上月ごとに報告を分割してください');meta ||= current;
        let channel=['theatrical','digital','package'].includes(kind)?parseChannelSalesDetail(kind,v):null;
        if(!channel&&channelSalesColumns.some(key=>v[key]!=null&&v[key]!==''))throw new Error('この報告種別には流通別売上項目を指定できません');
        const observationOnly=packageObservationOnly(kind,v,channel);
        const sheetAttributes=readRowAttributes(attributeContext,v);// 売上集計シートの拡張属性（attr_<列キー>）
        if(observationOnly&&sheetAttributes.attributes.length)throw new Error('売上集計シートの列（attr_…）は売上の行にだけ入れられます（在庫などの観測値だけの行には入れません）');
        if(observationOnly)channel={...channel,detail:null};
        if(observationOnly){rows.push({rowNo:sourceRowNo,destination:'package_report_observations',ids:{workId,partnerId,productId},channel,data:{accounting_month:current.accounting_month,source_row:sourceRowNo}});continue;}
        if(kind==='package'&&channel?.observations.length&&['amount_ex_tax','tax_amount','amount_inc_tax'].every(key=>v[key]==null||v[key]===''))throw new Error('売上指標を持つ行には売上金額が必要です。在庫などの観測値だけの行とは分けてください');
        const ex=integer(v.amount_ex_tax,{signed:true}),tax=integer(v.tax_amount,{signed:true}),inc=integer(v.amount_inc_tax,{signed:true});if(inc!==ex+tax)throw new Error('税込額が税抜額＋税額と一致しません');
        rows.push({rowNo:sourceRowNo,destination:'sale_lines',ids:{workId,partnerId,productId},channel,data:{product_id:productId,partner_id:partnerId,sales_period_from:salesPeriodFrom,sales_period_to:salesPeriodTo,accounting_month:current.accounting_month,description:v.description||'報告明細',quantity:integer(v.quantity??'',{nullable:true}),amount_ex_tax:ex,tax_amount:tax,amount_inc_tax:inc,source_row:sourceRowNo},...(sheetAttributes.attributes.length?{attributes:sheetAttributes.attributes,attributeText:sheetAttributes.text}:{})});
      }catch(e){errors.push({rowNo:sourceRowNo,message:e.message});}}
      salesReportMeta=meta;
      if(!errors.length){const hash=await sha256(raw),duplicate=await db.get('SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?',[i.org_id,meta.report_key,hash]);if(duplicate)errors.push({rowNo:0,message:`同一報告は登録済みです（report ${duplicate.id}）`});const active=await db.get("SELECT id FROM report_imports WHERE org_id=? AND work_id=? AND report_key=? AND status='active'",[i.org_id,workId,meta.report_key]);if(active&&!meta.supersedes_id)errors.push({rowNo:0,message:`訂正版はsupersedes_id=${active.id}を指定してください`});if(meta.supersedes_id!==null&&active?.id!==meta.supersedes_id)errors.push({rowNo:0,message:'訂正対象が現在の有効報告と一致しません'});}
    }
    const token=randomToken(),hash=await sha256(raw),canonicalHash=await sha256(canonicalRaw),schemaVersion=(await db.get('SELECT version FROM schema_meta WHERE org_id=?',[i.org_id])).version;
    const masterFingerprint=kind!=='publicity'&&!errors.length?await salesMasterFingerprint(i,workId,rows):null;
    const preview={formatVersion:3,orgId:i.org_id,userId:i.user_id,kind,workId,projectId:work.project_id,raw,canonicalRaw,hash,canonicalHash,rows,errors,schemaVersion,masterFingerprint,meta:null,mapping:input.mapping||null};
    if(!errors.length&&rows.length){preview.meta=kind==='publicity'?{report_key:`publicity-${workId}-${hash.slice(0,12)}`,partner_id:null,period_from:rows.map(r=>r.data.period_from).sort()[0],period_to:rows.map(r=>r.data.period_to).sort().at(-1),accounting_month:rows[0].data.period_from.slice(0,7),supersedes_id:null,recognition:null}:salesReportMeta;}
    await db.run('DELETE FROM import_previews WHERE expires_at<?',[nowIso()]);
    if(!errors.length)await db.run('INSERT INTO import_previews(token,org_id,user_id,project_id,work_id,payload_json,expires_at) VALUES(?,?,?,?,?,?,?)',[token,i.org_id,i.user_id,work.project_id,workId,json(preview),new Date(Date.now()+15*60_000).toISOString()]);
    return c.json({ok:errors.length===0,token,kind,workId,rawHash:hash,canonicalHash,destinationColumns:rows[0]?[...Object.keys(rows[0].data),...(salesReportMeta?.recognition?['report_recognition.recognition_basis_id','report_recognition.resolved_month','report_recognition.basis_reason']:[])]:[],recognition:salesReportMeta?.recognition||null,rows,errors,mappingTrace:input.mapping?.trace||null,workflowSourceRows:input.mapping?.workflowOriginalRows||null});
  }
  app.post('/api/imports/preview',async c=>{const input=await body(c);if(Object.hasOwn(input,'sourceText')||Object.hasOwn(input,'sourceRowNos')||Object.hasOwn(input,'mapping'))return bad(c,'内部用の変換情報は標準取込に指定できません');return previewImport(c,{kind:input.kind,workId:input.workId,text:input.text});});

  async function commitImport(c,input,additionalBatchStatements=[]) {
    const i=c.get('identity'),record=await db.get('SELECT * FROM import_previews WHERE token=? AND org_id=? AND user_id=? AND consumed=0 AND expires_at>?',[input.token,i.org_id,i.user_id,nowIso()]);
    if(!record)return bad(c,'プレビューがないか期限切れ・登録済みです',410);const preview=JSON.parse(record.payload_json);
    if(preview.formatVersion!==3)return bad(c,'旧形式のプレビューは登録できません。原文からもう一度プレビューしてください',409);
    if(preview.orgId!==i.org_id||preview.userId!==i.user_id)return bad(c,'別セッションのプレビューは登録できません',403);if(preview.errors.length)return bad(c,'エラーのあるプレビューは登録できません',409,preview.errors);
    if(await sha256(preview.raw||'')!==preview.hash)return bad(c,'CSV原文とプレビューのハッシュが一致しません',409);
    if(await sha256(preview.canonicalRaw||preview.raw||'')!==(preview.canonicalHash||preview.hash))return bad(c,'変換後CSVとプレビューのハッシュが一致しません',409);
    if(preview.mapping){const mappingVersion=await db.get('SELECT * FROM report_mapping_versions WHERE org_id=? AND id=?',[i.org_id,preview.mapping.mappingVersionId]);if(!mappingVersion||mappingVersion.definition_hash!==preview.mapping.definitionHash)return bad(c,'マッピング版が失効または不一致です',409);let retransformed;try{retransformed=transformMappedCsv(preview.raw,JSON.parse(mappingVersion.definition_json));revalidateMappedRows(preview);}catch(error){return bad(c,error.message,409,undefined,error);}if(retransformed.canonicalText!==preview.canonicalRaw||await sha256(retransformed.canonicalText)!==preview.canonicalHash||canonical(retransformed.trace)!==canonical(preview.mapping.trace)||retransformed.rowNos.some((rowNo,index)=>preview.rows[index]?.rowNo!==rowNo))return bad(c,'元CSVの再変換結果がプレビューと一致しません。もう一度プレビューしてください',409);}
    try{revalidateRecognitionPreview(preview);}catch(error){return bad(c,error.message,409,undefined,error);}
    if(!await canProject(db,i,preview.projectId)||(i.role==='production'&&preview.kind!=='publicity'))return bad(c,'登録権限が失効しました',403);
    if(preview.kind!=='publicity'&&!(await permittedProjects(db,i,true)).some(p=>p.id===preview.projectId))return bad(c,'案件の財務権限が失効しました',403);
    if(preview.kind!=='publicity'&&await salesMasterFingerprint(i,preview.workId,preview.rows)!==preview.masterFingerprint)return bad(c,'参照した作品・取引先・商品マスタがプレビュー後に変わりました。最新版で再検証してください',409);
    const m=preview.meta,statements=[
      {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM import_previews WHERE token=? AND consumed=0 AND expires_at>?)',params:[input.token,nowIso()]},
      {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM schema_meta WHERE org_id=? AND version=?)',params:[i.org_id,preview.schemaVersion]}
    ];
    if(preview.mapping)statements.push(
      {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM report_mapping_versions v JOIN report_mapping_profiles p ON p.org_id=v.org_id AND p.id=v.profile_id WHERE v.org_id=? AND v.id=? AND v.definition_hash=? AND p.partner_id=? AND p.kind=?)',params:[i.org_id,preview.mapping.mappingVersionId,preview.mapping.definitionHash,preview.mapping.partnerId,preview.kind]},
      {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM mapping_import_provenance WHERE org_id=? AND work_id=? AND partner_id=? AND kind=? AND original_hash=?)',params:[i.org_id,preview.workId,preview.mapping.partnerId,preview.kind,preview.hash]}
    );
    if(m.supersedes_id)statements.push({sql:"INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM report_imports WHERE org_id=? AND id=? AND work_id=? AND report_key=? AND status='active')",params:[i.org_id,m.supersedes_id,preview.workId,m.report_key]},{sql:"UPDATE report_imports SET status='superseded' WHERE org_id=? AND id=? AND work_id=? AND report_key=? AND status='active'",params:[i.org_id,m.supersedes_id,preview.workId,m.report_key]});
    statements.push({sql:`INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,supersedes_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,params:[i.org_id,preview.workId,m.partner_id,m.report_key,preview.kind,m.period_from,m.period_to,m.accounting_month,preview.raw,preview.hash,m.supersedes_id,i.user_id]});
    if(preview.mapping)statements.push({sql:`INSERT INTO mapping_import_provenance(org_id,report_id,work_id,partner_id,kind,mapping_version_id,original_text,original_hash,canonical_text,canonical_hash)
      VALUES(?,(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?),?,?,?,?,?,?,?,?)`,params:[i.org_id,i.org_id,m.report_key,preview.hash,preview.workId,preview.mapping.partnerId,preview.kind,preview.mapping.mappingVersionId,preview.raw,preview.hash,preview.canonicalRaw,preview.canonicalHash]});
    if(preview.mapping?.workflowSelectionId){
      const wm=preview.mapping;
      statements.push({sql:`INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM workflow_report_selections s JOIN workflow_raw_artifacts a ON a.org_id=s.org_id AND a.id=s.artifact_id WHERE s.org_id=? AND s.id=? AND s.artifact_id=? AND s.work_id=? AND a.work_id=s.work_id AND a.kind='sales_report' AND s.canonical_csv=? AND s.canonical_sha256=? AND s.id=(SELECT MAX(v.id) FROM workflow_report_selections v WHERE v.org_id=s.org_id AND v.artifact_id=s.artifact_id))`,params:[i.org_id,wm.workflowSelectionId,wm.workflowArtifactId,preview.workId,preview.raw,wm.workflowSelectionHash]});
      statements.push(legacyTakenOverGuard(i.org_id,wm.workflowArtifactId));// 新しい経路（原本の付け替え・分割）へ引き継いだ旧原本は、旧経路で登録しない
      statements.push({sql:'INSERT INTO workflow_report_commits(org_id,work_id,artifact_id,selection_id,mapping_version_id,report_id,preview_token,committed_by) VALUES(?,?,?,?,?,(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?),?,?)',params:[i.org_id,preview.workId,wm.workflowArtifactId,wm.workflowSelectionId,wm.mappingVersionId,i.org_id,m.report_key,preview.hash,input.token,i.user_id]});
    }
    if(preview.mapping?.sourcePartitionId)statements.push(...partitionCommitStatements(i,preview,input.token));// 原本を作品ごとに分けた表の登録（src/import/sales-source-store.mjs）
    if(preview.kind==='publicity') for(const row of preview.rows) statements.push({sql:`INSERT INTO observations(org_id,exposure_id,metric_definition_id,period_from,period_to,granularity,value_number,value_text,verification,acquired_at,source,region,paid_organic,source_row,report_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?))`,params:[i.org_id,...['exposure_id','metric_definition_id','period_from','period_to','granularity','value_number','value_text','verification','acquired_at','source','region','paid_organic'].map(k=>row.data[k]),row.rowNo,i.org_id,m.report_key,preview.hash]});
    else for(const row of preview.rows){
      if(row.destination==='sale_lines')statements.push({sql:`INSERT INTO sale_lines(org_id,project_id,work_id,report_id,product_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,quantity,amount_ex_tax,tax_amount,amount_inc_tax,source_row) VALUES(?,?,?,(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?),?,?,?,?,?,?,?,?,?,?,?)`,params:[i.org_id,preview.projectId,preview.workId,i.org_id,m.report_key,preview.hash,row.data.product_id,row.data.partner_id,row.data.sales_period_from,row.data.sales_period_to,row.data.accounting_month,row.data.description,row.data.quantity,row.data.amount_ex_tax,row.data.tax_amount,row.data.amount_inc_tax,row.data.source_row]});
      if(row.channel)statements.push(...buildChannelSalesStatements({orgId:i.org_id,reportKey:m.report_key,contentHash:preview.hash,sourceRow:row.rowNo,parsed:row.channel,productId:row.ids.productId}));
    }
    if(preview.kind!=='publicity'){const attributeStatement=attributeInsertStatement({orgId:i.org_id,userId:i.user_id,reportKey:m.report_key,contentHash:preview.hash,rows:preview.rows});if(attributeStatement)statements.push(attributeStatement);}// 売上集計シートの拡張属性（1つの文）
    if(m.recognition)statements.push({sql:`INSERT INTO report_recognition(org_id,report_id,recognition_basis_id,sales_month,report_received_on,contract_start_on,license_start_on,broadcast_on,basis_reason,accounting_status,resolved_month) VALUES(?,(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?),?,?,?,?,?,?,?,?,?)`,params:[i.org_id,i.org_id,m.report_key,preview.hash,m.recognition.recognition_basis_id,m.recognition.sales_month,m.recognition.report_received_on,m.recognition.contract_start_on,m.recognition.license_start_on,m.recognition.broadcast_on,m.recognition.basis_reason,m.recognition.accounting_status,m.recognition.resolved_month]});
    statements.push({sql:'INSERT INTO report_channel_fact_seals(org_id,report_id) VALUES(?,(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?))',params:[i.org_id,i.org_id,m.report_key,preview.hash]});
    statements.push(...additionalBatchStatements);
    statements.push({sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)',params:[i.org_id,i.user_id,'import',preview.kind,m.report_key,preview.hash,json({rows:preview.rows.length,workId:preview.workId})]});
    statements.push({sql:'UPDATE import_previews SET consumed=1 WHERE token=?',params:[input.token]});
    await db.batch(statements);return c.json({ok:true,rows:preview.rows.length,hash:preview.hash,canonicalHash:preview.canonicalHash||preview.hash,mappingVersionId:preview.mapping?.mappingVersionId||null});
  }
  app.post('/api/imports/commit',async c=>commitImport(c,await body(c)));
  app.post('/api/mapped-imports/commit',async c=>commitImport(c,await body(c)));

  async function mappingProfiles(i){
    const profiles=await db.all(`SELECT mp.*,p.name AS partner_name FROM report_mapping_profiles mp JOIN partners p ON p.org_id=mp.org_id AND p.id=mp.partner_id WHERE mp.org_id=? ORDER BY mp.id DESC`,[i.org_id]);
    const versions=await db.all('SELECT * FROM report_mapping_versions WHERE org_id=? ORDER BY profile_id,version_no',[i.org_id]);
    return profiles.map(profile=>({...profile,partnerId:profile.partner_id,partnerName:profile.partner_name,versions:versions.filter(version=>version.profile_id===profile.id).map(version=>({...version,profileId:version.profile_id,versionNo:version.version_no,definitionHash:version.definition_hash,definition:JSON.parse(version.definition_json)}))}));
  }
  app.get('/api/mapping-profiles',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は報告書マッピングを参照できません',403);if(!(await permittedProjects(db,i,true)).length)return bad(c,'案件の財務権限がありません',403);
    return c.json({ok:true,profiles:await mappingProfiles(i),allowedModes:['source','literal','add','subtract','multiply'],note:'演算の入力は元CSV列だけです。任意コード・SQL・式は実行しません。'});
  });
  app.post('/api/mapping-profiles',async c=>{
    const i=c.get('identity');if(i.role==='production'||!(await permittedProjects(db,i,true)).length)return bad(c,'報告書マッピングの登録権限がありません',403);
    const input=await body(c);let partnerId;try{partnerId=integer(input.partnerId);}catch(error){return bad(c,error.message,400,undefined,error);}if(!['theatrical','digital','package','broadcast','other'].includes(input.kind))return bad(c,'報告種別を確認してください');const name=String(input.name||'').trim();if(!name||name.length>120)return bad(c,'プロファイル名は1〜120文字です');if(!await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?',[i.org_id,partnerId]))return bad(c,'取引先がありません',404);
    const id=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM report_mapping_profiles')).id);await db.batch([{sql:'INSERT INTO report_mapping_profiles(id,org_id,partner_id,kind,name,created_by) VALUES(?,?,?,?,?,?)',params:[id,i.org_id,partnerId,input.kind,name,i.user_id]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','report_mapping_profile',String(id),json({partnerId,kind:input.kind,name})]}]);return c.json({ok:true,id,profileId:id},201);
  });
  app.post('/api/mapping-profiles/:id/versions',async c=>{
    const i=c.get('identity');if(i.role==='production'||!(await permittedProjects(db,i,true)).length)return bad(c,'マッピング版の登録権限がありません',403);let profileId;try{profileId=integer(c.req.param('id'));}catch(error){return bad(c,error.message,400,undefined,error);}const profile=await db.get('SELECT * FROM report_mapping_profiles WHERE org_id=? AND id=?',[i.org_id,profileId]);if(!profile)return bad(c,'マッピングプロファイルがありません',404);
    let definition;try{definition=normalizeMappingDefinition(await body(c));}catch(error){return bad(c,error.message,400,undefined,error);}const definitionText=canonical(definition),definitionHash=await sha256(definitionText),versionNo=Number((await db.get('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM report_mapping_versions WHERE org_id=? AND profile_id=?',[i.org_id,profileId])).n),id=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM report_mapping_versions')).id);
    await db.batch([{sql:'INSERT INTO report_mapping_versions(id,org_id,profile_id,version_no,definition_json,definition_hash,created_by) VALUES(?,?,?,?,?,?,?)',params:[id,i.org_id,profileId,versionNo,definitionText,definitionHash,i.user_id]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)',params:[i.org_id,i.user_id,'append','report_mapping_version',String(id),definitionHash,json({profileId,versionNo})]}]);return c.json({ok:true,id,mappingVersionId:id,profileId,versionNo,definitionHash},201);
  });
  app.post('/api/mapped-imports/preview',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は財務報告を変換できません',403);const input=await body(c);let workId,mappingVersionId;try{workId=integer(input.workId);mappingVersionId=integer(input.mappingVersionId);}catch(error){return bad(c,error.message,400,undefined,error);}const work=await settlementWork(i,workId);if(!work)return bad(c,'作品の財務編集権限がありません',403);
    const version=await db.get(`SELECT v.*,p.partner_id,p.kind,p.name AS profile_name FROM report_mapping_versions v JOIN report_mapping_profiles p ON p.org_id=v.org_id AND p.id=v.profile_id WHERE v.org_id=? AND v.id=?`,[i.org_id,mappingVersionId]);if(!version)return bad(c,'マッピング版がありません',404);const originalText=String(input.text||'');let transformed;try{transformed=transformMappedCsv(originalText,JSON.parse(version.definition_json));}catch(error){return bad(c,error.message,400,undefined,error);}
    const canonicalRows=parseCsv(transformed.canonicalText);if(canonicalRows.some(row=>{try{return integer(row.values.partner_id)!==version.partner_id}catch{return true}}))return bad(c,'変換後の取引先IDがプロファイルの取引先と一致しません');const originalHash=await sha256(originalText);const duplicate=await db.get('SELECT report_id FROM mapping_import_provenance WHERE org_id=? AND work_id=? AND partner_id=? AND kind=? AND original_hash=?',[i.org_id,workId,version.partner_id,version.kind,originalHash]);if(duplicate)return bad(c,`同じ元CSVは登録済みです（report ${duplicate.report_id}）。訂正フローを使用してください`,409);
    let workflow={};
    if(input.workflowSelectionId!=null&&input.sourcePartitionId!=null)return bad(c,'原本の選択版と原本の分割は同時に指定できません');
    if(input.sourcePartitionId!=null){// 受領原本を作品ごとに分けた表（src/import/sales-source-store.mjs）
      let partitionId;try{partitionId=integer(input.sourcePartitionId);}catch(error){return bad(c,error.message,400,undefined,error);}
      const checked=await partitionPreviewSource({db,identity:i,workId,partitionId,text:originalText,sha256,permittedProjects,partnerId:version.partner_id,kind:version.kind,kindText:value=>labelOf('reportKind',value)});if(checked.error)return bad(c,checked.error,checked.status);
      workflow=checked.mapping;
    }
    if(input.workflowSelectionId!=null){
      const selectionId=integer(input.workflowSelectionId),selection=await db.get('SELECT s.*,a.kind,a.work_id AS artifact_work_id FROM workflow_report_selections s JOIN workflow_raw_artifacts a ON a.org_id=s.org_id AND a.id=s.artifact_id WHERE s.org_id=? AND s.id=?',[i.org_id,selectionId]);
      if(!selection||selection.work_id!==workId||selection.artifact_work_id!==workId||selection.kind!=='sales_report')return bad(c,'原本の選択版と作品が一致しません',403);
      if(selection.canonical_csv!==originalText||await sha256(originalText)!==selection.canonical_sha256)return bad(c,'原本から抽出した表が選択版と一致しません',409);
      const latest=await db.get('SELECT MAX(id) AS id FROM workflow_report_selections WHERE org_id=? AND artifact_id=?',[i.org_id,selection.artifact_id]);if(latest.id!==selection.id)return bad(c,'原本の選択版が更新されています',409);
      if(await db.get('SELECT 1 FROM workflow_report_commits WHERE org_id=? AND artifact_id=?',[i.org_id,selection.artifact_id]))return bad(c,'原本は登録済みです',409);
      if(await isTakenOver(db,i.org_id,selection.artifact_id))return bad(c,'この原本は新しい取込（原本の付け替え・分割）へ引き継いでいます。取込ウィザードから続けてください',409);
      workflow={workflowSelectionId:selection.id,workflowArtifactId:selection.artifact_id,workflowSelectionHash:selection.canonical_sha256,workflowOriginalRows:JSON.parse(selection.source_rows_json)};
    }
    return previewImport(c,{kind:version.kind,workId,text:transformed.canonicalText,sourceText:originalText,sourceRowNos:transformed.rowNos,mapping:{...workflow,mappingVersionId,profileId:version.profile_id,profileName:version.profile_name,partnerId:version.partner_id,definitionHash:version.definition_hash,originalHeaders:transformed.headers,trace:transformed.trace}});
  });
  app.get('/api/mapped-imports',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は財務報告の変換履歴を参照できません',403);let workId;try{workId=integer(c.req.query('workId')||'');}catch(error){return bad(c,error.message,400,undefined,error);}if(!await settlementWork(i,workId))return bad(c,'作品の財務権限がありません',403);const rows=await db.all(`SELECT mp.*,p.name AS partner_name,v.version_no,pr.name AS profile_name,r.report_key,r.accounting_month FROM mapping_import_provenance mp JOIN partners p ON p.org_id=mp.org_id AND p.id=mp.partner_id JOIN report_mapping_versions v ON v.org_id=mp.org_id AND v.id=mp.mapping_version_id JOIN report_mapping_profiles pr ON pr.org_id=v.org_id AND pr.id=v.profile_id JOIN report_imports r ON r.org_id=mp.org_id AND r.id=mp.report_id WHERE mp.org_id=? AND mp.work_id=? ORDER BY mp.created_at DESC`,[i.org_id,workId]);return c.json({ok:true,rows});
  });

  app.get('/api/recognition-bases',async c=>c.json({ok:true,rows:await db.all('SELECT id,code,name,source_field FROM recognition_bases ORDER BY id')}));

  app.get('/api/reports',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'報告書への権限がありません',403);
    const pids=(await permittedProjects(db,i,true)).map(x=>x.id);
    const rows=await db.all(`SELECT r.*,w.project_id,rr.recognition_basis_id,rb.code AS recognition_basis_code,rb.name AS recognition_basis_name,
      rr.sales_month,rr.report_received_on,rr.contract_start_on,rr.license_start_on,rr.broadcast_on,rr.basis_reason,rr.accounting_status,rr.resolved_month
      FROM report_imports r JOIN works w ON w.org_id=r.org_id AND w.id=r.work_id
      LEFT JOIN report_recognition rr ON rr.org_id=r.org_id AND rr.report_id=r.id LEFT JOIN recognition_bases rb ON rb.id=rr.recognition_basis_id
      WHERE r.org_id=? ORDER BY r.id DESC`,[i.org_id]);
    return c.json({ok:true,rows:rows.filter(r=>pids.includes(r.project_id)&&(!c.req.query('workId')||r.work_id===Number(c.req.query('workId'))))});
  });
  app.get('/api/sales',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'売上への権限がありません',403);
    const pids=(await permittedProjects(db,i,true)).map(x=>x.id),rows=await db.all(`SELECT s.*,rr.recognition_basis_id,rb.code AS recognition_basis_code,rb.name AS recognition_basis_name,
      rr.sales_month,rr.report_received_on,rr.contract_start_on,rr.license_start_on,rr.broadcast_on,rr.basis_reason,rr.accounting_status,rr.resolved_month
      FROM sale_lines s LEFT JOIN report_recognition rr ON rr.org_id=s.org_id AND rr.report_id=s.report_id LEFT JOIN recognition_bases rb ON rb.id=rr.recognition_basis_id
      WHERE s.org_id=? ORDER BY s.id DESC`,[i.org_id]);
    return c.json({ok:true,rows:rows.filter(r=>pids.includes(r.project_id)&&(!c.req.query('workId')||r.work_id===Number(c.req.query('workId'))))});
  });
  app.post('/api/sales',async c=>{
    const input=await body(c);
    if(Object.hasOwn(input,'contract_signed_on'))return bad(c,'contract_signed_onは利用できません。契約開始日はcontract_start_onを指定してください');
    const headers=['report_key','partner_id','product_id','period_from','period_to','accounting_month','description','quantity','amount_ex_tax','tax_amount','amount_inc_tax','supersedes_id'];
    if(hasRecognitionInput(input))headers.push(...recognitionInputFields);
    const text=toCsv(headers,[headers.map(k=>input[k]??'')]);
    const result=await previewImport(c,{kind:input.kind||'digital',workId:input.workId??input.work_id,text});
    const preview=await result.json();if(!preview.ok)return c.json(preview,result.status);
    return commitImport(c,{token:preview.token});
  });

  async function fieldWork(i,workId){const work=await db.get('SELECT id,project_id,title FROM works WHERE org_id=? AND id=?',[i.org_id,workId]);return work&&await canProject(db,i,work.project_id)?work:null;}
  const nextIsoDate=value=>{const date=new Date(`${isoDate(value)}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10)};
  async function normalizeAssignments(i,workId,shootDate,rows){
    if(!Array.isArray(rows)||rows.length>300)throw new Error('シーン割当は0〜300件です');
    const scenes=await db.all('SELECT id FROM scenes WHERE org_id=? AND work_id=?',[i.org_id,workId]),allowed=new Set(scenes.map(row=>row.id)),seen=new Set(),orders=new Set(),nextDate=nextIsoDate(shootDate),out=[];
    for(const row of rows){const sceneId=integer(row.sceneId),sequenceOrder=integer(row.sequenceOrder);if(!allowed.has(sceneId))throw new Error('選択作品のシーンではありません');if(seen.has(sceneId)||orders.has(sequenceOrder))throw new Error('同じ撮影日のシーンまたは撮影順が重複しています');seen.add(sceneId);orders.add(sequenceOrder);const plannedStart=localDateTime(row.plannedStart,{nullable:true}),plannedEnd=localDateTime(row.plannedEnd,{nullable:true}),actualStart=localDateTime(row.actualStart,{nullable:true}),actualEnd=localDateTime(row.actualEnd,{nullable:true});for(const value of [plannedStart,plannedEnd,actualStart,actualEnd])if(value&&![shootDate,nextDate].includes(value.slice(0,10)))throw new Error('撮影日時は撮影日または翌日で入力してください');if(Boolean(plannedStart)!==Boolean(plannedEnd)||plannedEnd&&plannedEnd<=plannedStart)throw new Error('予定開始・終了を両方入力し、終了を開始より後にしてください');if(Boolean(actualStart)!==Boolean(actualEnd)||actualEnd&&actualEnd<=actualStart)throw new Error('実績開始・終了を両方入力し、終了を開始より後にしてください');const outcome=String(row.outcome||'planned');if(!['planned','partial','shot','not_shot'].includes(outcome))throw new Error('撮影実績区分を確認してください');out.push({sceneId,sequenceOrder,plannedStart,plannedEnd,actualStart,actualEnd,outcome,notes:cleanText(row.notes,1000)});}return out;
  }
  function normalizePrepTask(input){const shootingDayId=optionalInteger(input.shootingDayId),sceneId=optionalInteger(input.sceneId),title=cleanText(input.title,200,{required:true}),ownerLabel=cleanText(input.ownerLabel,160),dueOn=input.dueOn?isoDate(String(input.dueOn)):null,status=String(input.status||'pending');if(!['pending','ready','blocked'].includes(status))throw new Error('準備状態を確認してください');return {shootingDayId,sceneId,title,ownerLabel,dueOn,status,note:cleanText(input.note,2000)}}
  app.get('/api/field',async c=>{const i=c.get('identity');let workId;try{workId=integer(c.req.query('workId')||'')}catch(error){return bad(c,error.message,400,undefined,error)}const work=await fieldWork(i,workId);if(!work)return bad(c,'作品への権限がありません',403);const [scenes,days,assignments,tasks]=await Promise.all([db.all('SELECT * FROM scenes WHERE org_id=? AND work_id=? ORDER BY scene_no',[i.org_id,workId]),db.all('SELECT * FROM shooting_days WHERE org_id=? AND work_id=? ORDER BY shoot_date,unit,id',[i.org_id,workId]),db.all('SELECT a.* FROM day_scene_assignments a JOIN shooting_days d ON d.org_id=a.org_id AND d.id=a.shooting_day_id WHERE a.org_id=? AND a.work_id=? ORDER BY d.shoot_date,a.sequence_order',[i.org_id,workId]),db.all('SELECT * FROM prep_tasks WHERE org_id=? AND work_id=? ORDER BY due_on,id',[i.org_id,workId])]);const assigned=new Set(assignments.map(row=>row.scene_id));return c.json({ok:true,scenes,days:days.map(day=>({...day,assignments:assignments.filter(row=>row.shooting_day_id===day.id)})),tasks,summary:{sceneCount:scenes.length,unassignedSceneCount:scenes.filter(row=>!assigned.has(row.id)).length,shootingDayCount:days.length,plannedAssignments:assignments.filter(row=>row.outcome==='planned').length,shotAssignments:assignments.filter(row=>row.outcome==='shot').length,partialAssignments:assignments.filter(row=>row.outcome==='partial').length,notShotAssignments:assignments.filter(row=>row.outcome==='not_shot').length,pendingPrep:tasks.filter(row=>row.status==='pending').length,blockedPrep:tasks.filter(row=>row.status==='blocked').length},scopeNote:'日々スケと撮影実績のdraftです。正式承認・配布済み状態やシーン全体の完了を自動判定しません。日時はJSTのローカル日時です。'});});
  app.post('/api/field/days',async c=>{const i=c.get('identity'),input=await body(c);let workId,shootDate,assignments;try{workId=integer(input.workId);shootDate=isoDate(String(input.shootDate||''));assignments=await normalizeAssignments(i,workId,shootDate,input.assignments||[])}catch(error){return bad(c,error.message,400,undefined,error)}const work=await fieldWork(i,workId);if(!work)return bad(c,'作品への権限がありません',403);const unit=cleanText(input.unit,80,{required:true}),label=cleanText(input.label,160,{required:true}),notes=cleanText(input.notes,2000),dayId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM shooting_days')).id),assignmentStart=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM day_scene_assignments')).id),statements=[{sql:'INSERT INTO shooting_days(id,org_id,project_id,work_id,shoot_date,unit,label,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?)',params:[dayId,i.org_id,work.project_id,workId,shootDate,unit,label,notes,i.user_id]}];assignments.forEach((row,index)=>statements.push({sql:'INSERT INTO day_scene_assignments(id,org_id,work_id,shooting_day_id,scene_id,sequence_order,planned_start,planned_end,actual_start,actual_end,outcome,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',params:[assignmentStart+index,i.org_id,workId,dayId,row.sceneId,row.sequenceOrder,row.plannedStart,row.plannedEnd,row.actualStart,row.actualEnd,row.outcome,row.notes]}));statements.push({sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','shooting_day',String(dayId),json({before:null,after:{workId,shootDate,unit,label,notes,assignments}})]});try{await db.batch(statements)}catch(error){return bad(c,error.message,409,undefined,error)}return c.json({ok:true,dayId,version:1},201);});
  app.patch('/api/field/days/:id',async c=>{const i=c.get('identity');let dayId;try{dayId=integer(c.req.param('id'))}catch(error){return bad(c,error.message,400,undefined,error)}const expected=Number(c.req.header('If-Match')||0);if(!Number.isInteger(expected)||expected<1)return bad(c,'If-Matchに現在のversionが必要です',428);const day=await db.get('SELECT * FROM shooting_days WHERE org_id=? AND id=?',[i.org_id,dayId]);if(!day)return bad(c,'撮影日がありません',404);if(!await fieldWork(i,day.work_id))return bad(c,'作品への権限がありません',403);const previousAssignments=await db.all('SELECT scene_id AS sceneId,sequence_order AS sequenceOrder,planned_start AS plannedStart,planned_end AS plannedEnd,actual_start AS actualStart,actual_end AS actualEnd,outcome,notes FROM day_scene_assignments WHERE org_id=? AND shooting_day_id=? ORDER BY sequence_order',[i.org_id,dayId]);const input=await body(c);let shootDate,assignments;try{shootDate=isoDate(String(input.shootDate??day.shoot_date));assignments=await normalizeAssignments(i,day.work_id,shootDate,input.assignments||[])}catch(error){return bad(c,error.message,400,undefined,error)}const unit=cleanText(input.unit??day.unit,80,{required:true}),label=cleanText(input.label??day.label,160,{required:true}),notes=cleanText(input.notes??day.notes,2000),assignmentStart=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM day_scene_assignments')).id),statements=[{sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM shooting_days WHERE org_id=? AND id=? AND version=?)',params:[i.org_id,dayId,expected]},{sql:'DELETE FROM day_scene_assignments WHERE org_id=? AND shooting_day_id=?',params:[i.org_id,dayId]},{sql:'UPDATE shooting_days SET shoot_date=?,unit=?,label=?,notes=?,version=version+1 WHERE org_id=? AND id=? AND version=?',params:[shootDate,unit,label,notes,i.org_id,dayId,expected]}];assignments.forEach((row,index)=>statements.push({sql:'INSERT INTO day_scene_assignments(id,org_id,work_id,shooting_day_id,scene_id,sequence_order,planned_start,planned_end,actual_start,actual_end,outcome,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',params:[assignmentStart+index,i.org_id,day.work_id,dayId,row.sceneId,row.sequenceOrder,row.plannedStart,row.plannedEnd,row.actualStart,row.actualEnd,row.outcome,row.notes]}));statements.push({sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'update','shooting_day',String(dayId),json({before:{shootDate:day.shoot_date,unit:day.unit,label:day.label,notes:day.notes,version:day.version,assignments:previousAssignments},after:{shootDate,unit,label,notes,version:expected+1,assignments}})]});try{await db.batch(statements)}catch(error){return bad(c,'別の利用者が更新したか、日程が重複しています。再読込してください',409,{cause:error.message})}return c.json({ok:true,dayId,version:expected+1});});

  app.post('/api/field/tasks',async c=>{const i=c.get('identity'),input=await body(c);let workId,task;try{workId=integer(input.workId);task=normalizePrepTask(input)}catch(error){return bad(c,error.message,400,undefined,error)}const work=await fieldWork(i,workId);if(!work)return bad(c,'作品への権限がありません',403);if(task.shootingDayId&&!await db.get('SELECT 1 FROM shooting_days WHERE org_id=? AND work_id=? AND id=?',[i.org_id,workId,task.shootingDayId]))return bad(c,'選択作品の撮影日ではありません',409);if(task.sceneId&&!await db.get('SELECT 1 FROM scenes WHERE org_id=? AND work_id=? AND id=?',[i.org_id,workId,task.sceneId]))return bad(c,'選択作品のシーンではありません',409);const taskId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM prep_tasks')).id),after={workId,...task,version:1};try{await db.batch([{sql:'INSERT INTO prep_tasks(id,org_id,project_id,work_id,shooting_day_id,scene_id,title,owner_label,due_on,status,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',params:[taskId,i.org_id,work.project_id,workId,task.shootingDayId,task.sceneId,task.title,task.ownerLabel,task.dueOn,task.status,task.note,i.user_id]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','prep_task',String(taskId),json({before:null,after})]}])}catch(error){return bad(c,error.message,409,undefined,error)}return c.json({ok:true,taskId,version:1},201);});
  app.patch('/api/field/tasks/:id',async c=>{const i=c.get('identity');let taskId;try{taskId=integer(c.req.param('id'))}catch(error){return bad(c,error.message,400,undefined,error)}const expected=Number(c.req.header('If-Match')||0);if(!Number.isInteger(expected)||expected<1)return bad(c,'If-Matchに現在のversionが必要です',428);const current=await db.get('SELECT * FROM prep_tasks WHERE org_id=? AND id=?',[i.org_id,taskId]);if(!current)return bad(c,'準備タスクがありません',404);if(!await fieldWork(i,current.work_id))return bad(c,'作品への権限がありません',403);const input=await body(c);let task;try{task=normalizePrepTask({shootingDayId:input.shootingDayId??current.shooting_day_id,sceneId:input.sceneId??current.scene_id,title:input.title??current.title,ownerLabel:input.ownerLabel??current.owner_label,dueOn:input.dueOn??current.due_on,status:input.status??current.status,note:input.note??current.note})}catch(error){return bad(c,error.message,400,undefined,error)}if(task.shootingDayId&&!await db.get('SELECT 1 FROM shooting_days WHERE org_id=? AND work_id=? AND id=?',[i.org_id,current.work_id,task.shootingDayId]))return bad(c,'選択作品の撮影日ではありません',409);if(task.sceneId&&!await db.get('SELECT 1 FROM scenes WHERE org_id=? AND work_id=? AND id=?',[i.org_id,current.work_id,task.sceneId]))return bad(c,'選択作品のシーンではありません',409);const before={shootingDayId:current.shooting_day_id,sceneId:current.scene_id,title:current.title,ownerLabel:current.owner_label,dueOn:current.due_on,status:current.status,note:current.note,version:current.version},after={...task,version:expected+1};try{await db.batch([{sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM prep_tasks WHERE org_id=? AND id=? AND version=?)',params:[i.org_id,taskId,expected]},{sql:'UPDATE prep_tasks SET shooting_day_id=?,scene_id=?,title=?,owner_label=?,due_on=?,status=?,note=?,version=version+1 WHERE org_id=? AND id=? AND version=?',params:[task.shootingDayId,task.sceneId,task.title,task.ownerLabel,task.dueOn,task.status,task.note,i.org_id,taskId,expected]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'update','prep_task',String(taskId),json({before,after})]}])}catch(error){return bad(c,'別の利用者が更新しました。再読込してください',409,{cause:error.message})}return c.json({ok:true,taskId,version:expected+1});});

  function normalizeSalesTerms(input){const channel=String(input.channel||'');if(!['digital','broadcast','theatrical','package','other'].includes(channel))throw new Error('契約販路を選択してください');const licenseStart=input.licenseStart?isoDate(String(input.licenseStart)):null,licenseEnd=input.licenseEnd?isoDate(String(input.licenseEnd)):null;if(licenseStart&&licenseEnd&&licenseEnd<licenseStart)throw new Error('ライセンス終了日は開始日以後にしてください');const expectedAmountYen=optionalInteger(input.expectedAmountYen);if(expectedAmountYen!=null&&expectedAmountYen<0)throw new Error('契約見込額は0以上の円整数です');return {documentReference:cleanText(input.documentReference,500),versionLabel:cleanText(input.versionLabel,120),channel,territory:(()=>{const t=cleanText(input.territory,200);if(!t)return null;const r=resolveTerritory(t,[]);if(r.error)throw new Error(r.error);return r.territory})(),licenseStart,licenseEnd,expectedAmountYen,note:cleanText(input.note,2000)}}
  function normalizeDeliverable(input){const status=String(input.status||'pending');if(!['pending','submitted','accepted','blocked'].includes(status))throw new Error('納品状態を確認してください');const dueOn=input.dueOn?isoDate(String(input.dueOn)):null,submittedOn=input.submittedOn?isoDate(String(input.submittedOn)):null,acceptedOn=input.acceptedOn?isoDate(String(input.acceptedOn)):null;if(['submitted','accepted'].includes(status)&&!submittedOn)throw new Error('提出済み・受領済みには提出日が必要です');if(status==='accepted'&&!acceptedOn)throw new Error('受領済みには受領日が必要です');if(acceptedOn&&!submittedOn)throw new Error('受領日には提出日が必要です');if(acceptedOn&&acceptedOn<submittedOn)throw new Error('受領日は提出日以後にしてください');return {title:cleanText(input.title,200,{required:true}),dueOn,status,submittedOn,acceptedOn,note:cleanText(input.note,2000)}}
  async function salesReportCandidate(i,workId,termVersionId,reportId=null){const source=await settlementSource(i,workId),term=await db.get(`SELECT v.*,a.id AS agreement_id,a.partner_id,a.product_id,a.version AS agreement_version FROM sales_agreement_term_versions v JOIN sales_agreements a ON a.org_id=v.org_id AND a.id=v.agreement_id WHERE v.org_id=? AND v.id=? AND a.work_id=?`,[i.org_id,termVersionId,workId]);if(!term)return {source,term:null,candidates:source.reports.map(report=>({...report,eligible:false,reason:'選択作品の契約条件版ではありません'}))};const current=(await db.get('SELECT MAX(version_no) AS n FROM sales_agreement_term_versions WHERE org_id=? AND agreement_id=?',[i.org_id,term.agreement_id])).n,links=await db.all('SELECT report_id FROM sales_report_links WHERE org_id=? AND work_id=?',[i.org_id,workId]),linked=new Set(links.map(row=>row.report_id));const candidates=source.reports.map(report=>{const parts=source.parts.filter(row=>row.report_id===report.id);let reason=null;if(reportId!=null&&report.id!==reportId)reason='選択外';else if(term.version_no!==current)reason='最新版の契約条件ではありません';else if(linked.has(report.id))reason='この作品で関連付け済みです';else if(['broadcast','other'].includes(term.channel))reason='この契約販路と既存報告種別の対応規則は未設定です';else if(term.channel!==report.kind)reason=`契約販路「${labelOf('reportKind',term.channel)}」と報告種別「${labelOf('reportKind',report.kind)}」が一致しません`;else if(report.partner_id!==term.partner_id||parts.some(row=>row.partner_id!==term.partner_id))reason='取引先が契約と一致しません';else if(term.product_id!=null&&parts.some(row=>row.product_id!==term.product_id))reason='商品が契約と一致しません';return {...report,allocatedAmountExTax:parts.reduce((sum,row)=>sum+row.allocated_amount_ex_tax,0),lineCount:parts.length,eligible:reason==null,reason}});return {source,term,candidates}}
  app.get('/api/sales-operations',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は営業契約・売上関連を参照できません',403);let workId,termVersionId=null;try{workId=integer(c.req.query('workId')||'');if(c.req.query('termVersionId'))termVersionId=integer(c.req.query('termVersionId'))}catch(error){return bad(c,error.message,400,undefined,error)}const work=await settlementWork(i,workId);if(!work)return bad(c,'作品の財務権限がありません',403);let asOf;try{asOf=isoDate(String(c.req.query('asOf')||nowIso().slice(0,10)))}catch(error){return bad(c,error.message,400,undefined,error)}const [opportunities,activities,agreements,terms,deliverables,reportLinks,fieldDays,fieldAssignments,fieldTasks]=await Promise.all([db.all('SELECT * FROM sales_opportunities WHERE org_id=? AND work_id=? ORDER BY id DESC',[i.org_id,workId]),db.all('SELECT * FROM sales_activities WHERE org_id=? AND work_id=? ORDER BY occurred_on DESC,id DESC',[i.org_id,workId]),db.all(`SELECT a.*,p.name AS partner_name,pr.name AS product_name FROM sales_agreements a JOIN partners p ON p.org_id=a.org_id AND p.id=a.partner_id LEFT JOIN products pr ON pr.org_id=a.org_id AND pr.id=a.product_id WHERE a.org_id=? AND a.work_id=? ORDER BY a.id DESC`,[i.org_id,workId]),db.all('SELECT v.* FROM sales_agreement_term_versions v JOIN sales_agreements a ON a.org_id=v.org_id AND a.id=v.agreement_id WHERE v.org_id=? AND a.work_id=? ORDER BY v.agreement_id,v.version_no',[i.org_id,workId]),db.all('SELECT * FROM sales_deliverables WHERE org_id=? AND work_id=? ORDER BY due_on,id',[i.org_id,workId]),db.all('SELECT l.*,r.report_key,r.kind,r.accounting_month,r.content_hash FROM sales_report_links l JOIN report_imports r ON r.org_id=l.org_id AND r.id=l.report_id WHERE l.org_id=? AND l.work_id=? ORDER BY l.created_at DESC',[i.org_id,workId]),db.all('SELECT id,shoot_date,unit,label FROM shooting_days WHERE org_id=? AND work_id=? ORDER BY shoot_date',[i.org_id,workId]),db.all('SELECT outcome FROM day_scene_assignments WHERE org_id=? AND work_id=?',[i.org_id,workId]),db.all('SELECT status FROM prep_tasks WHERE org_id=? AND work_id=?',[i.org_id,workId])]);const maxVersion=new Map();for(const term of terms)maxVersion.set(term.agreement_id,Math.max(maxVersion.get(term.agreement_id)||0,term.version_no));const candidate=termVersionId?await salesReportCandidate(i,workId,termVersionId):{candidates:(await settlementSource(i,workId)).reports.map(report=>({...report,eligible:false,reason:'契約条件版を選択してください'}))};const stages={};for(const opportunity of opportunities)stages[opportunity.stage]=(stages[opportunity.stage]||0)+1;let opportunityExpectedYen=0,unknownForecastCount=0;for(const opportunity of opportunities){if(opportunity.expected_yen==null)unknownForecastCount++;else opportunityExpectedYen+=opportunity.expected_yen}let agreementExpectedYen=0,unknownAgreementAmountCount=0;for(const agreement of agreements){const latest=terms.filter(row=>row.agreement_id===agreement.id).at(-1);if(!latest||latest.expected_amount_yen==null)unknownAgreementAmountCount++;else agreementExpectedYen+=latest.expected_amount_yen}return c.json({ok:true,asOf,opportunities,activities,agreements:agreements.map(row=>({...row,terms:terms.filter(term=>term.agreement_id===row.id)})),terms,deliverables:deliverables.map(row=>{const timing=deliverableTiming(row,asOf);return {...row,overdue:timing.overdue,timing}}),reportLinks:reportLinks.map(row=>({...row,needsReview:(terms.find(term=>term.id===row.term_version_id)?.version_no||0)!==(maxVersion.get(row.agreement_id)||0)})),candidateReports:candidate.candidates,fieldReadiness:{shootingDayCount:fieldDays.length,shotAssignments:fieldAssignments.filter(row=>row.outcome==='shot').length,partialAssignments:fieldAssignments.filter(row=>row.outcome==='partial').length,pendingPrep:fieldTasks.filter(row=>row.status==='pending').length,blockedPrep:fieldTasks.filter(row=>row.status==='blocked').length,note:'制作日程と準備のdraft参照です。契約可能性や法的有効性を自動判定しません。'},summary:{stages,opportunityExpectedYen,unknownForecastCount,agreementExpectedYen,unknownAgreementAmountCount,overdueDeliverableCount:deliverables.filter(row=>deliverableTiming(row,asOf).overdue).length,lateSubmittedCount:deliverables.filter(row=>deliverableTiming(row,asOf).late).length},scopeNote:'商談見込と契約見込は別表示です。受注・契約・売上は自動生成せず、売上関連は作品配賦後の既存値を説明用に1回だけ参照します。'});});
  app.post('/api/sales-activities',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は営業活動を登録できません',403);const input=await body(c);let workId,opportunityId,occurredOn,nextDueOn;try{workId=integer(input.workId);opportunityId=integer(input.opportunityId);occurredOn=isoDate(String(input.occurredOn||''));nextDueOn=input.nextDueOn?isoDate(String(input.nextDueOn)):null}catch(error){return bad(c,error.message,400,undefined,error)}if(!await settlementWork(i,workId))return bad(c,'作品の財務編集権限がありません',403);const opportunity=await db.get('SELECT * FROM sales_opportunities WHERE org_id=? AND id=? AND work_id=?',[i.org_id,opportunityId,workId]);if(!opportunity)return bad(c,'選択作品の商談がありません',409);const activityType=String(input.activityType||'');if(!['contact','proposal','negotiation','note'].includes(activityType))return bad(c,'活動種別を確認してください');const summary=cleanText(input.summary,1000,{required:true}),nextAction=cleanText(input.nextAction,1000),activityId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM sales_activities')).id),after={workId,opportunityId,occurredOn,activityType,summary,nextAction,nextDueOn};await db.batch([{sql:'INSERT INTO sales_activities(id,org_id,project_id,work_id,opportunity_id,partner_id,occurred_on,activity_type,summary,next_action,next_due_on,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',params:[activityId,i.org_id,opportunity.project_id,workId,opportunityId,opportunity.partner_id,occurredOn,activityType,summary,nextAction,nextDueOn,i.user_id]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','sales_activity',String(activityId),json({before:null,after})]}]);return c.json({ok:true,activityId},201);});
  app.post('/api/sales-agreements',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は販売契約を登録できません',403);const input=await body(c);let workId,opportunityId,productId,intakeCaseId,terms;try{workId=integer(input.workId);opportunityId=integer(input.opportunityId);productId=optionalInteger(input.productId);intakeCaseId=optionalInteger(input.intakeCaseId);terms=normalizeSalesTerms(input.terms||{})}catch(error){return bad(c,error.message,400,undefined,error)}const work=await settlementWork(i,workId);if(!work)return bad(c,'作品の財務編集権限がありません',403);const opportunity=await db.get('SELECT * FROM sales_opportunities WHERE org_id=? AND id=? AND work_id=?',[i.org_id,opportunityId,workId]);if(!opportunity)return bad(c,'選択作品の商談がありません',409);if(productId&&!await db.get('SELECT 1 FROM product_works WHERE org_id=? AND product_id=? AND work_id=?',[i.org_id,productId,workId]))return bad(c,'選択作品へ配賦された商品ではありません',409);if(intakeCaseId&&!await db.get('SELECT 1 FROM rights_intake_cases WHERE org_id=? AND id=? AND work_id=?',[i.org_id,intakeCaseId,workId]))return bad(c,'選択作品の権利調達ケースではありません',409);const contractCode=cleanText(input.contractCode,100,{required:true}),title=cleanText(input.title,200,{required:true}),agreementId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM sales_agreements')).id),termVersionId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM sales_agreement_term_versions')).id),after={workId,opportunityId,partnerId:opportunity.partner_id,productId,intakeCaseId,contractCode,title,version:1,termVersionId,terms};try{await db.batch([{sql:'INSERT INTO sales_agreements(id,org_id,project_id,work_id,opportunity_id,partner_id,product_id,intake_case_id,contract_code,title,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',params:[agreementId,i.org_id,work.project_id,workId,opportunityId,opportunity.partner_id,productId,intakeCaseId,contractCode,title,i.user_id]},{sql:'INSERT INTO sales_agreement_term_versions(id,org_id,agreement_id,version_no,document_reference,version_label,channel,territory,license_start,license_end,expected_amount_yen,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[termVersionId,i.org_id,agreementId,1,terms.documentReference,terms.versionLabel,terms.channel,terms.territory,terms.licenseStart,terms.licenseEnd,terms.expectedAmountYen,terms.note,i.user_id]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','sales_agreement',String(agreementId),json({before:null,after})]}])}catch(error){return bad(c,error.message,409,undefined,error)}return c.json({ok:true,agreementId,termVersionId,version:1},201);});
  app.post('/api/sales-agreements/:id/versions',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は販売契約を改訂できません',403);let agreementId;try{agreementId=integer(c.req.param('id'))}catch(error){return bad(c,error.message,400,undefined,error)}const expected=Number(c.req.header('If-Match')||0);if(!Number.isInteger(expected)||expected<1)return bad(c,'If-Matchに契約headのversionが必要です',428);const agreement=await db.get('SELECT * FROM sales_agreements WHERE org_id=? AND id=?',[i.org_id,agreementId]);if(!agreement)return bad(c,'販売契約がありません',404);if(!await settlementWork(i,agreement.work_id))return bad(c,'作品の財務編集権限がありません',403);const input=await body(c);let sourceVersionId,terms;try{sourceVersionId=optionalInteger(input.sourceVersionId);terms=normalizeSalesTerms(input)}catch(error){return bad(c,error.message,400,undefined,error)}if(sourceVersionId&&!await db.get('SELECT 1 FROM sales_agreement_term_versions WHERE org_id=? AND agreement_id=? AND id=?',[i.org_id,agreementId,sourceVersionId]))return bad(c,'同じ契約の改訂元条件版ではありません',409);const versionNo=Number((await db.get('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM sales_agreement_term_versions WHERE org_id=? AND agreement_id=?',[i.org_id,agreementId])).n),termVersionId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM sales_agreement_term_versions')).id),after={termVersionId,versionNo,sourceVersionId,...terms,headVersion:expected+1};try{await db.batch([{sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM sales_agreements WHERE org_id=? AND id=? AND version=?)',params:[i.org_id,agreementId,expected]},{sql:'INSERT INTO sales_agreement_term_versions(id,org_id,agreement_id,version_no,source_version_id,document_reference,version_label,channel,territory,license_start,license_end,expected_amount_yen,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[termVersionId,i.org_id,agreementId,versionNo,sourceVersionId,terms.documentReference,terms.versionLabel,terms.channel,terms.territory,terms.licenseStart,terms.licenseEnd,terms.expectedAmountYen,terms.note,i.user_id]},{sql:'UPDATE sales_agreements SET version=version+1 WHERE org_id=? AND id=? AND version=?',params:[i.org_id,agreementId,expected]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'append','sales_agreement_term',String(termVersionId),json({before:{headVersion:expected},after})]}])}catch(error){return bad(c,'別の利用者が契約を更新しました。再読込してください',409,{cause:error.message})}return c.json({ok:true,termVersionId,versionNo,headVersion:expected+1},201);});
  app.post('/api/deliverables',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は営業納品を登録できません',403);const input=await body(c);let workId,agreementId,termVersionId,delivery;try{workId=integer(input.workId);agreementId=integer(input.agreementId);termVersionId=integer(input.termVersionId);delivery=normalizeDeliverable(input)}catch(error){return bad(c,error.message,400,undefined,error)}const work=await settlementWork(i,workId);if(!work)return bad(c,'作品の財務編集権限がありません',403);if(!await db.get('SELECT 1 FROM sales_agreement_term_versions v JOIN sales_agreements a ON a.org_id=v.org_id AND a.id=v.agreement_id WHERE v.org_id=? AND v.id=? AND v.agreement_id=? AND a.work_id=?',[i.org_id,termVersionId,agreementId,workId]))return bad(c,'選択作品の契約条件版ではありません',409);const deliverableId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM sales_deliverables')).id),after={workId,agreementId,termVersionId,...delivery,version:1};await db.batch([{sql:'INSERT INTO sales_deliverables(id,org_id,project_id,work_id,agreement_id,term_version_id,title,due_on,status,submitted_on,accepted_on,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[deliverableId,i.org_id,work.project_id,workId,agreementId,termVersionId,delivery.title,delivery.dueOn,delivery.status,delivery.submittedOn,delivery.acceptedOn,delivery.note,i.user_id]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','sales_deliverable',String(deliverableId),json({before:null,after})]}]);return c.json({ok:true,deliverableId,version:1},201);});
  app.patch('/api/deliverables/:id',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は営業納品を更新できません',403);let deliverableId;try{deliverableId=integer(c.req.param('id'))}catch(error){return bad(c,error.message,400,undefined,error)}const expected=Number(c.req.header('If-Match')||0);if(!Number.isInteger(expected)||expected<1)return bad(c,'If-Matchに現在のversionが必要です',428);const current=await db.get('SELECT * FROM sales_deliverables WHERE org_id=? AND id=?',[i.org_id,deliverableId]);if(!current)return bad(c,'納品項目がありません',404);if(!await settlementWork(i,current.work_id))return bad(c,'作品の財務編集権限がありません',403);const input=await body(c);let delivery;try{delivery=normalizeDeliverable({title:input.title??current.title,dueOn:input.dueOn??current.due_on,status:input.status??current.status,submittedOn:input.submittedOn??current.submitted_on,acceptedOn:input.acceptedOn??current.accepted_on,note:input.note??current.note})}catch(error){return bad(c,error.message,400,undefined,error)}const before={title:current.title,dueOn:current.due_on,status:current.status,submittedOn:current.submitted_on,acceptedOn:current.accepted_on,note:current.note,version:current.version},after={...delivery,version:expected+1};try{await db.batch([{sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM sales_deliverables WHERE org_id=? AND id=? AND version=?)',params:[i.org_id,deliverableId,expected]},{sql:'UPDATE sales_deliverables SET title=?,due_on=?,status=?,submitted_on=?,accepted_on=?,note=?,version=version+1 WHERE org_id=? AND id=? AND version=?',params:[delivery.title,delivery.dueOn,delivery.status,delivery.submittedOn,delivery.acceptedOn,delivery.note,i.org_id,deliverableId,expected]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'update','sales_deliverable',String(deliverableId),json({before,after})]}])}catch(error){return bad(c,'別の利用者が納品項目を更新しました。再読込してください',409,{cause:error.message})}return c.json({ok:true,deliverableId,version:expected+1});});
  app.post('/api/sales-report-links',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は売上報告を契約へ関連付けできません',403);const input=await body(c);let workId,reportId,termVersionId;try{workId=integer(input.workId);reportId=integer(input.reportId);termVersionId=integer(input.agreementTermVersionId)}catch(error){return bad(c,error.message,400,undefined,error)}if(!await settlementWork(i,workId))return bad(c,'作品の財務編集権限がありません',403);const checked=await salesReportCandidate(i,workId,termVersionId,reportId),candidate=checked.candidates.find(row=>row.id===reportId);if(!candidate||!candidate.eligible)return bad(c,candidate?.reason||'選択作品への有効な売上配賦がありません',409);const agreementId=checked.term.agreement_id,after={workId,reportId,agreementId,termVersionId,allocatedAmountExTax:candidate.allocatedAmountExTax};try{await db.batch([{sql:'INSERT INTO sales_report_links(org_id,work_id,report_id,agreement_id,term_version_id,created_by) VALUES(?,?,?,?,?,?)',params:[i.org_id,workId,reportId,agreementId,termVersionId,i.user_id]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'link','sales_report_link',`${workId}:${reportId}`,json({before:null,after})]}])}catch(error){return bad(c,error.message,409,undefined,error)}return c.json({ok:true,workId,reportId,agreementId,termVersionId},201);});

  async function settlementWork(i,workId){
    if(i.role==='production')return null;
    const work=await db.get('SELECT id,project_id,title FROM works WHERE org_id=? AND id=?',[i.org_id,workId]);
    if(!work)return null;
    const finance=(await permittedProjects(db,i,true)).some(p=>p.id===work.project_id);
    return finance?work:null;
  }
  function intakeMissing(row,documents,scopes,participants,links){
    const missing=[];
    if(!documents.length)missing.push('契約書参照');
    documents.forEach((document,index)=>{if(!document.title)missing.push(`契約書${index+1}の名称`);if(!document.reference)missing.push(`契約書${index+1}の参照先`);if(!document.version_label)missing.push(`契約書${index+1}の版`)});
    if(!scopes.length)missing.push('権利範囲');
    scopes.forEach((scope,index)=>{if(!scope.channel)missing.push(`権利範囲${index+1}の媒体`);if(!scope.territory)missing.push(`権利範囲${index+1}の地域`);if(!scope.rights_start)missing.push(`権利範囲${index+1}の開始日`);if(!scope.rights_end)missing.push(`権利範囲${index+1}の終了日`);if(!scope.exclusivity||scope.exclusivity==='unknown')missing.push(`権利範囲${index+1}の独占性`)});
    if(row.intake_type==='committee'){
      if(!participants.length)missing.push('委員会参加者');
      participants.forEach((participant,index)=>{if(participant.party_kind!=='partner'||!participant.partner_id)missing.push(`委員会参加者${index+1}の取引先`);if(!participant.role)missing.push(`委員会参加者${index+1}の役割`);if(participant.investment_yen==null)missing.push(`委員会参加者${index+1}の出資額`);if(participant.explicit_share_bps==null)missing.push(`委員会参加者${index+1}の明示持分`)});
      if(participants.length&&participants.every(participant=>participant.explicit_share_bps!=null)&&participants.reduce((sum,participant)=>sum+participant.explicit_share_bps,0)!==10000)missing.push('委員会の明示持分合計100%');
    }else if(row.intake_type==='sole_owned'){
      if(!participants.some(participant=>participant.party_kind==='current_org'))missing.push('自社保有主体');
    }else{
      if(!participants.some(participant=>participant.party_kind==='partner'&&participant.partner_id))missing.push('権利委託者');
      if(!participants.some(participant=>participant.role))missing.push('受託上の役割');
    }
    if(row.intake_type!=='committee'&&!links.length)missing.push('分配契約との関連');
    return [...new Set(missing)];
  }
  function committeeTermsMissing(documents,participants){
    const missing=[];
    if(!documents.some(row=>row.title&&row.reference&&row.version_label))missing.push('名称・参照先・版を備えた契約書参照');
    if(!participants.length)missing.push('委員会参加者');
    participants.forEach((row,index)=>{if(row.party_kind!=='partner'||!row.partner_id)missing.push(`委員会参加者${index+1}の取引先`);if(!row.role)missing.push(`委員会参加者${index+1}の役割`);if(row.explicit_share_bps==null)missing.push(`委員会参加者${index+1}の明示持分`)});
    if(participants.length&&participants.every(row=>row.explicit_share_bps!=null)&&participants.reduce((sum,row)=>sum+row.explicit_share_bps,0)!==10000)missing.push('委員会の明示持分合計100%');
    return [...new Set(missing)];
  }
  async function intakeCases(i,workId){
    const cases=await db.all('SELECT * FROM rights_intake_cases WHERE org_id=? AND work_id=? ORDER BY id DESC',[i.org_id,workId]);
    const [documents,scopes,participants,links]=await Promise.all([
      db.all('SELECT * FROM rights_intake_documents WHERE org_id=? ORDER BY id',[i.org_id]),db.all('SELECT * FROM rights_intake_scopes WHERE org_id=? ORDER BY id',[i.org_id]),
      db.all(`SELECT rp.*,p.name AS partner_name FROM rights_intake_participants rp LEFT JOIN partners p ON p.org_id=rp.org_id AND p.id=rp.partner_id WHERE rp.org_id=? ORDER BY rp.id`,[i.org_id]),
      db.all(`SELECT l.*,c.contract_code,c.title AS contract_title,c.contract_type FROM intake_settlement_links l JOIN settlement_contracts c ON c.org_id=l.org_id AND c.id=l.settlement_contract_id WHERE l.org_id=? AND l.work_id=? ORDER BY l.created_at`,[i.org_id,workId])
    ]);
    return cases.map(row=>{const ownDocuments=documents.filter(item=>item.intake_case_id===row.id),ownScopes=scopes.filter(item=>item.intake_case_id===row.id),ownParticipants=participants.filter(item=>item.intake_case_id===row.id),ownLinks=links.filter(item=>item.intake_case_id===row.id),missingFields=intakeMissing(row,ownDocuments,ownScopes,ownParticipants,ownLinks),committeeContractMissing=row.intake_type==='committee'?committeeTermsMissing(ownDocuments,ownParticipants):[];return {...row,caseCode:row.case_code,intakeType:row.intake_type,documents:ownDocuments,scopes:ownScopes,participants:ownParticipants,settlementLinks:ownLinks,missingFields,inputComplete:missingFields.length===0,committeeContractMissing,committeeContractReady:row.intake_type==='committee'&&committeeContractMissing.length===0,approvalStatus:'not_implemented'};});
  }
  app.get('/api/intakes',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は調達・権利情報を参照できません',403);
    let workId;try{workId=integer(c.req.query('workId')||'');}catch(error){return bad(c,error.message,400,undefined,error);}
    if(!await settlementWork(i,workId))return bad(c,'作品の財務権限がありません',403);
    return c.json({ok:true,cases:await intakeCases(i,workId),note:'すべてdraftの入力スナップショットです。承認状態は扱いません。制作委員会ケースは条件版と期間報告へ明示的に関連付けられます。'});
  });
  app.post('/api/intakes',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は調達・権利情報を登録できません',403);
    const input=await body(c);let workId,sourceCaseId=null;try{workId=integer(input.workId);if(input.sourceCaseId!=null&&input.sourceCaseId!=='')sourceCaseId=integer(input.sourceCaseId);}catch(error){return bad(c,error.message,400,undefined,error);}
    const work=await settlementWork(i,workId);if(!work)return bad(c,'作品の財務編集権限がありません',403);
    if(!['committee','sole_owned','entrusted'].includes(input.intakeType))return bad(c,'調達入口を「製作委員会・単独保有・権利受託」から選択してください');
    const caseCode=String(input.caseCode||'').trim(),title=String(input.title||'').trim();if(!caseCode||caseCode.length>80||!title||title.length>160)return bad(c,'ケースコードと名称を確認してください');
    const documents=Array.isArray(input.documents)?input.documents:[],scopes=Array.isArray(input.scopes)?input.scopes:[],participants=Array.isArray(input.participants)?input.participants:[];
    if(documents.length>20||scopes.length>50||participants.length>50)return bad(c,'1ケースの子項目数が試作上限を超えています');
    const normalizedDocuments=[];for(const document of documents){const contentHash=document.contentHash?String(document.contentHash).trim().toLowerCase():null;if(contentHash&&!/^[a-f0-9]{64}$/.test(contentHash))return bad(c,'契約書ハッシュは64桁のSHA-256形式です');const item={title:String(document.title||'').trim()||null,reference:String(document.reference||'').trim()||null,version_label:String(document.versionLabel||'').trim()||null,content_hash:contentHash};if(item.title?.length>200||item.reference?.length>1000||item.version_label?.length>100)return bad(c,'契約書参照の文字数を確認してください');normalizedDocuments.push(item);}
    const normalizedScopes=[];for(const scope of scopes){let start=null,end=null;try{start=scope.rightsStart?isoDate(String(scope.rightsStart)):null;end=scope.rightsEnd?isoDate(String(scope.rightsEnd)):null;}catch(error){return bad(c,error.message,400,undefined,error);}if(start&&end&&end<start)return bad(c,'権利期間が逆転しています');const exclusivity=scope.exclusivity||null;if(exclusivity&&!['exclusive','nonexclusive','unknown'].includes(exclusivity))return bad(c,'独占性を確認してください');const item={channel:String(scope.channel||'').trim()||null,territory:String(scope.territory||'').trim()||null,rights_start:start,rights_end:end,exclusivity};if(item.channel?.length>100||item.territory?.length>100)return bad(c,'媒体・地域は100文字以内です');normalizedScopes.push(item);}
    const allowedPartners=new Set((await db.all('SELECT id FROM partners WHERE org_id=?',[i.org_id])).map(row=>row.id)),normalizedParticipants=[];
    for(const participant of participants){const partyKind=participant.partyKind;if(!['current_org','partner'].includes(partyKind))return bad(c,'参加者種別を確認してください');let partnerId=null,investment=null,share=null;try{partnerId=partyKind==='partner'&&participant.partnerId!=null&&participant.partnerId!==''?integer(participant.partnerId):null;investment=optionalInteger(participant.investmentYen);share=optionalInteger(participant.explicitShareBps);}catch(error){return bad(c,error.message,400,undefined,error);}if(partnerId&&!allowedPartners.has(partnerId))return bad(c,'参加者の取引先が同じ組織にありません',403);if(share!=null&&share>10000)return bad(c,'明示持分は0〜10000bpです');const role=String(participant.role||'').trim()||null;if(role?.length>100)return bad(c,'参加者の役割は100文字以内です');normalizedParticipants.push({party_kind:partyKind,partner_id:partnerId,role,investment_yen:investment,explicit_share_bps:share});}
    if(input.intakeType==='committee'&&normalizedParticipants.some(participant=>participant.party_kind!=='partner'))return bad(c,'制作委員会の参加者は取引先マスタを明示してください');
    if(input.intakeType==='entrusted'&&normalizedParticipants.some(participant=>participant.party_kind!=='partner'))return bad(c,'権利受託の委託者は取引先マスタを明示してください');
    const sourceCase=sourceCaseId==null?null:await db.get('SELECT * FROM rights_intake_cases WHERE org_id=? AND id=? AND work_id=?',[i.org_id,sourceCaseId,workId]);
    if(sourceCaseId!=null&&!sourceCase)return bad(c,'同じ作品の改訂元ケースがありません',409);
    if(sourceCase&&sourceCase.intake_type!==input.intakeType)return bad(c,'改訂時に調達入口の種別は変更できません',409);
    const snapshotVersion=sourceCase?sourceCase.snapshot_version+1:1;
    const caseId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM rights_intake_cases')).id),documentStart=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM rights_intake_documents')).id),scopeStart=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM rights_intake_scopes')).id),participantStart=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM rights_intake_participants')).id);
    const statements=[{sql:'INSERT INTO rights_intake_cases(id,org_id,project_id,work_id,case_code,title,intake_type,source_case_id,snapshot_version,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',params:[caseId,i.org_id,work.project_id,workId,caseCode,title,input.intakeType,sourceCaseId,snapshotVersion,i.user_id]}];
    normalizedDocuments.forEach((item,index)=>statements.push({sql:'INSERT INTO rights_intake_documents(id,org_id,intake_case_id,title,reference,version_label,content_hash) VALUES(?,?,?,?,?,?,?)',params:[documentStart+index,i.org_id,caseId,item.title,item.reference,item.version_label,item.content_hash]}));
    normalizedScopes.forEach((item,index)=>statements.push({sql:'INSERT INTO rights_intake_scopes(id,org_id,intake_case_id,channel,territory,rights_start,rights_end,exclusivity) VALUES(?,?,?,?,?,?,?,?)',params:[scopeStart+index,i.org_id,caseId,item.channel,item.territory,item.rights_start,item.rights_end,item.exclusivity]}));
    normalizedParticipants.forEach((item,index)=>statements.push({sql:'INSERT INTO rights_intake_participants(id,org_id,intake_case_id,party_kind,partner_id,role,investment_yen,explicit_share_bps) VALUES(?,?,?,?,?,?,?,?)',params:[participantStart+index,i.org_id,caseId,item.party_kind,item.partner_id,item.role,item.investment_yen,item.explicit_share_bps]}));
    statements.push({sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','rights_intake_case',String(caseId),json({workId,intakeType:input.intakeType,sourceCaseId,snapshotVersion,documents:documents.length,scopes:scopes.length,participants:participants.length})]});
    await db.batch(statements);return c.json({ok:true,id:caseId,caseId,status:'draft',sourceCaseId,snapshotVersion},201);
  });
  app.post('/api/intakes/:id/settlement-links',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は分配契約との関連を登録できません',403);
    let intakeId,contractId;try{intakeId=integer(c.req.param('id'));contractId=integer((await body(c)).settlementContractId);}catch(error){return bad(c,error.message,400,undefined,error);}
    const intake=await db.get('SELECT * FROM rights_intake_cases WHERE org_id=? AND id=?',[i.org_id,intakeId]);if(!intake)return bad(c,'調達ケースがありません',404);if(!await settlementWork(i,intake.work_id))return bad(c,'作品の財務編集権限がありません',403);
    const contract=await db.get('SELECT * FROM settlement_contracts WHERE org_id=? AND id=? AND work_id=?',[i.org_id,contractId,intake.work_id]);if(!contract)return bad(c,'同じ作品の分配契約がありません',409);
    await db.batch([{sql:'INSERT INTO intake_settlement_links(org_id,intake_case_id,work_id,settlement_contract_id,created_by) VALUES(?,?,?,?,?)',params:[i.org_id,intakeId,intake.work_id,contractId,i.user_id]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'link','intake_settlement_link',`${intakeId}:${contractId}`,json({workId:intake.work_id})]}]);
    return c.json({ok:true,intakeCaseId:intakeId,settlementContractId:contractId},201);
  });
  async function settlementSource(i,workId){
    const financeProjects=(await permittedProjects(db,i,true)).map(p=>p.id);
    if(!financeProjects.length)return {reports:[],parts:[],mappings:[]};
    const scope=permittedProjectScope(i,true),marks=scope.sql;// 案件IDを値として並べない（D1 の値の上限100個）
    const reports=await db.all(`SELECT r.id,r.work_id,r.partner_id,r.report_key,r.kind,r.period_from,r.period_to,r.accounting_month,r.content_hash,r.status,r.created_at,w.project_id
      FROM report_imports r JOIN works w ON w.org_id=r.org_id AND w.id=r.work_id
      WHERE r.org_id=? AND r.status='active' AND w.project_id IN (${marks}) ORDER BY r.accounting_month,r.id`,[i.org_id,...scope.params]);
    const sales=await db.all(`SELECT s.* FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN works w ON w.org_id=r.org_id AND w.id=r.work_id
      WHERE s.org_id=? AND r.status='active' AND w.project_id IN (${marks}) ORDER BY s.accounting_month,s.report_id,s.id`,[i.org_id,...scope.params]);
    const mappings=await db.all('SELECT * FROM product_works WHERE org_id=? ORDER BY product_id,work_id',[i.org_id]);
    const parts=allocatedSaleParts(sales,mappings).filter(row=>row.allocated_work_id===workId);
    const reportIds=new Set(parts.map(row=>row.report_id));
    return {reports:reports.filter(row=>reportIds.has(row.id)),parts,mappings};
  }
  async function settlementContracts(i,workId){
    const contracts=await db.all(`SELECT c.*,p.name AS holder_name,l.intake_case_id,rc.case_code AS intake_case_code,rc.title AS intake_case_title,rc.intake_type
      FROM settlement_contracts c LEFT JOIN partners p ON p.org_id=c.org_id AND p.id=c.holder_partner_id
      LEFT JOIN intake_settlement_links l ON l.org_id=c.org_id AND l.settlement_contract_id=c.id
      LEFT JOIN rights_intake_cases rc ON rc.org_id=l.org_id AND rc.id=l.intake_case_id
      WHERE c.org_id=? AND c.work_id=? ORDER BY c.id`,[i.org_id,workId]);
    const versions=await db.all('SELECT * FROM settlement_term_versions WHERE org_id=? ORDER BY contract_id,version_no',[i.org_id]);
    return contracts.map(contract=>({...contract,contractCode:contract.contract_code,contractType:contract.contract_type,holderPartnerId:contract.holder_partner_id,mgContractYen:contract.mg_contract_yen,mgPaidYen:contract.mg_paid_yen,intakeCaseId:contract.intake_case_id,intakeCaseCode:contract.intake_case_code,intakeCaseTitle:contract.intake_case_title,intakeType:contract.intake_type,versions:versions.filter(version=>version.contract_id===contract.id).map(version=>({...version,platformRateBps:version.platform_rate_bps,agencyFeeBps:version.agency_fee_bps,recoupBasis:version.recoup_basis,overageEnabled:version.overage_enabled,overageRateBps:version.overage_rate_bps}))}));
  }

  app.get('/api/settlement/contracts',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は権利・分配条件を参照できません',403);
    let workId;try{workId=integer(c.req.query('workId')||'');}catch(e){return bad(c,e.message,400,undefined,e);}
    if(!await settlementWork(i,workId))return bad(c,'作品の財務権限がありません',403);
    return c.json({ok:true,contracts:await settlementContracts(i,workId)});
  });
  app.post('/api/settlement/contracts',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は権利・分配条件を登録できません',403);
    const input=await body(c);let workId,mgContractYen,mgPaidYen,terms,intakeCaseId=null;
    try{workId=integer(input.workId);mgContractYen=optionalInteger(input.mgContractYen);mgPaidYen=optionalInteger(input.mgPaidYen);terms=settlementTerms(input.terms||{},input.contractType);if(input.intakeCaseId!=null&&input.intakeCaseId!=='')intakeCaseId=integer(input.intakeCaseId);}catch(e){return bad(c,e.message,400,undefined,e);}
    const work=await settlementWork(i,workId);if(!work)return bad(c,'作品の財務編集権限がありません',403);
    const contractType=input.contractType;if(!['commission','mg','self_owned'].includes(contractType))return bad(c,'契約種別を確認してください');
    const contractCode=String(input.contractCode||'').trim(),title=String(input.title||'').trim();if(!contractCode||contractCode.length>80||!title||title.length>160)return bad(c,'契約コードと名称を確認してください');
    let holderPartnerId=null;
    if(contractType!=='self_owned'){
      try{holderPartnerId=integer(input.holderPartnerId);}catch(e){return bad(c,e.message,400,undefined,e);}
      if(!await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?',[i.org_id,holderPartnerId]))return bad(c,'権利元取引先がありません',404);
    }
    if(contractType==='mg'){if(mgContractYen==null)return bad(c,'MG契約額が必要です');if(mgPaidYen!=null&&mgPaidYen>mgContractYen)return bad(c,'MG実支払額は契約額以下にしてください');}
    else if(mgContractYen!=null||mgPaidYen!=null)return bad(c,'MG以外の契約にはMG金額を設定しません');
    if(intakeCaseId!=null&&!await db.get('SELECT 1 FROM rights_intake_cases WHERE org_id=? AND id=? AND work_id=?',[i.org_id,intakeCaseId,workId]))return bad(c,'選択作品の調達ケースがありません',409);
    const contractId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM settlement_contracts')).id),versionId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM settlement_term_versions')).id);
    const statements=[
      {sql:`INSERT INTO settlement_contracts(id,org_id,project_id,work_id,contract_code,title,contract_type,holder_partner_id,mg_contract_yen,mg_paid_yen,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,params:[contractId,i.org_id,work.project_id,workId,contractCode,title,contractType,holderPartnerId,mgContractYen,mgPaidYen,i.user_id]},
      {sql:`INSERT INTO settlement_term_versions(id,org_id,contract_id,version_no,platform_rate_bps,agency_fee_bps,recoup_basis,overage_enabled,overage_rate_bps,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,params:[versionId,i.org_id,contractId,1,terms.platformRateBps,terms.agencyFeeBps,terms.recoupBasis,terms.overageEnabled,terms.overageRateBps,terms.note,i.user_id]}
    ];
    if(intakeCaseId!=null)statements.push({sql:'INSERT INTO intake_settlement_links(org_id,intake_case_id,work_id,settlement_contract_id,created_by) VALUES(?,?,?,?,?)',params:[i.org_id,intakeCaseId,workId,contractId,i.user_id]});
    statements.push({sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','settlement_contract',String(contractId),json({workId,contractType,versionId,intakeCaseId})]});
    await db.batch(statements);
    return c.json({ok:true,id:contractId,contractId,versionId,versionNo:1,intakeCaseId},201);
  });
  app.post('/api/settlement/contracts/:id/versions',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は契約条件版を登録できません',403);
    let contractId;try{contractId=integer(c.req.param('id'));}catch(e){return bad(c,e.message,400,undefined,e);}
    const contract=await db.get('SELECT * FROM settlement_contracts WHERE org_id=? AND id=?',[i.org_id,contractId]);if(!contract)return bad(c,'契約がありません',404);
    if(!await settlementWork(i,contract.work_id))return bad(c,'作品の財務編集権限がありません',403);
    const input=await body(c);let terms;try{terms=settlementTerms(input.terms||input,contract.contract_type);}catch(e){return bad(c,e.message,400,undefined,e);}
    const versionNo=Number((await db.get('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM settlement_term_versions WHERE org_id=? AND contract_id=?',[i.org_id,contractId])).n),versionId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM settlement_term_versions')).id);
    await db.batch([
      {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM settlement_contracts WHERE org_id=? AND id=? AND work_id=?)',params:[i.org_id,contractId,contract.work_id]},
      {sql:`INSERT INTO settlement_term_versions(id,org_id,contract_id,version_no,platform_rate_bps,agency_fee_bps,recoup_basis,overage_enabled,overage_rate_bps,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,params:[versionId,i.org_id,contractId,versionNo,terms.platformRateBps,terms.agencyFeeBps,terms.recoupBasis,terms.overageEnabled,terms.overageRateBps,terms.note,i.user_id]},
      {sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'append','settlement_term_version',String(versionId),json({contractId,versionNo})]}
    ]);
    return c.json({ok:true,id:versionId,versionId,versionNo},201);
  });
  app.get('/api/settlement/reports',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は権利・分配報告を参照できません',403);
    let workId;try{workId=integer(c.req.query('workId')||'');}catch(e){return bad(c,e.message,400,undefined,e);}
    if(!await settlementWork(i,workId))return bad(c,'作品の財務権限がありません',403);
    const source=await settlementSource(i,workId),links=await db.all('SELECT * FROM settlement_report_links WHERE org_id=? AND work_id=? ORDER BY report_id',[i.org_id,workId]);
    const byReport=new Map(links.map(link=>[link.report_id,link]));
    const reports=source.reports.map(report=>({...report,link:byReport.get(report.id)||null}));
    return c.json({ok:true,reports,linked:reports.filter(row=>row.link),unlinked:reports.filter(row=>!row.link),unlinkedCount:reports.filter(row=>!row.link).length});
  });
  app.post('/api/settlement/links',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は権利・分配の紐付けを登録できません',403);
    const input=await body(c);let reportId,workId,contractId,termVersionId;
    try{reportId=integer(input.reportId);workId=integer(input.workId);contractId=integer(input.contractId);termVersionId=integer(input.termVersionId);}catch(e){return bad(c,e.message,400,undefined,e);}
    if(!['gross','net'].includes(input.reportBasis))return bad(c,'報告額の基準を「控除前・控除後」から選択してください');
    if(!await settlementWork(i,workId))return bad(c,'作品の財務編集権限がありません',403);
    const source=await settlementSource(i,workId),report=source.reports.find(row=>row.id===reportId);if(!report)return bad(c,'選択作品への有効な配賦を持つ報告がありません',409);
    const contract=await db.get('SELECT * FROM settlement_contracts WHERE org_id=? AND id=? AND work_id=?',[i.org_id,contractId,workId]);if(!contract)return bad(c,'選択作品の契約がありません',409);
    const version=await db.get('SELECT * FROM settlement_term_versions WHERE org_id=? AND id=? AND contract_id=?',[i.org_id,termVersionId,contractId]);if(!version)return bad(c,'選択した契約条件版がありません',409);
    if(await db.get('SELECT 1 FROM settlement_report_links WHERE org_id=? AND report_id=? AND work_id=?',[i.org_id,reportId,workId]))return bad(c,'この報告と作品は既に契約へ紐付いています',409);if(await db.get('SELECT 1 FROM committee_snapshot_reports WHERE org_id=? AND work_id=? AND report_id=?',[i.org_id,workId,reportId]))return bad(c,'この報告と作品は製作委員会報告に使用済みです',409);
    if(await db.get('SELECT 1 FROM settlement_report_links WHERE org_id=? AND report_id=? AND report_basis<>?',[i.org_id,reportId,input.reportBasis]))return bad(c,'同じ報告の報告額基準は作品間で統一してください',409);
    await db.batch([
      {sql:"INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM report_imports WHERE org_id=? AND id=? AND status='active')",params:[i.org_id,reportId]},
      {sql:'INSERT INTO settlement_report_links(org_id,report_id,work_id,contract_id,term_version_id,report_basis,created_by) VALUES(?,?,?,?,?,?,?)',params:[i.org_id,reportId,workId,contractId,termVersionId,input.reportBasis,i.user_id]},
      {sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'link','settlement_report_link',`${reportId}:${workId}`,json({contractId,termVersionId,reportBasis:input.reportBasis})]}
    ]);
    return c.json({ok:true,reportId,workId,contractId,termVersionId,reportBasis:input.reportBasis},201);
  });

  // 権利・分配の試算（作品単位）。/api/settlement/preview とロイヤリティ報告書が同じ結果を使う。
  async function settlementPreviewData(i,workId){
    const [source,contracts,links]=await Promise.all([settlementSource(i,workId),settlementContracts(i,workId),db.all('SELECT * FROM settlement_report_links WHERE org_id=? AND work_id=? ORDER BY report_id',[i.org_id,workId])]);
    const activeReports=new Map(source.reports.map(row=>[row.id,row])),contractMap=new Map(contracts.map(row=>[row.id,row])),linkMap=new Map(links.filter(link=>activeReports.has(link.report_id)).map(link=>[link.report_id,link]));
    const lineResults=[];
    for(const part of source.parts){
      const link=linkMap.get(part.report_id);if(!link)continue;
      const contract=contractMap.get(link.contract_id),version=contract?.versions.find(row=>row.id===link.term_version_id);if(!contract||!version)continue;
      const reportedAmount=part.allocated_amount_ex_tax,grossAmount=link.report_basis==='gross'?reportedAmount:null;
      const platformDeduction=link.report_basis==='gross'?signedRateAmount(reportedAmount,version.platform_rate_bps):null;
      const platformNet=link.report_basis==='gross'?reportedAmount-platformDeduction:reportedAmount;
      const agencyFee=version.agency_fee_bps==null?null:signedRateAmount(platformNet,version.agency_fee_bps);
      const result={reportId:part.report_id,saleId:part.id,sourceRow:part.source_row,accountingMonth:part.accounting_month,salesPeriodFrom:part.sales_period_from,salesPeriodTo:part.sales_period_to,description:part.description,allocationBps:part.allocation_bps,contractId:contract.id,contractCode:contract.contract_code,contractType:contract.contract_type,termVersionId:version.id,versionNo:version.version_no,reportBasis:link.report_basis,reportedAmount,grossAmount,platformDeduction,platformNet,agencyFee,holderAmount:null,ownReceipts:null,recoupSource:null};
      if(contract.contract_type==='commission')result.holderAmount=platformNet-agencyFee;
      else if(contract.contract_type==='self_owned')result.ownReceipts=platformNet;
      else result.recoupSource=version.recoup_basis==='after_fee'?platformNet-agencyFee:platformNet;
      lineResults.push(result);
    }
    const sum=(rows,key)=>{const value=rows.reduce((total,row)=>total+(row[key]??0),0);if(!Number.isSafeInteger(value))throw new Error('試算金額が整数範囲を超えています');return value;};
    const contractSummaries=contracts.map(contract=>{
      const rows=lineResults.filter(row=>row.contractId===contract.id),bases=new Set(rows.map(row=>row.reportBasis)),reportBasis=bases.size===0?null:bases.size===1?[...bases][0]:'mixed',base={contractId:contract.id,contractCode:contract.contract_code,title:contract.title,contractType:contract.contract_type,linkedReportCount:new Set(rows.map(row=>row.reportId)).size,lineCount:rows.length,reportBasis,reportedAmount:reportBasis==='mixed'?null:sum(rows,'reportedAmount'),grossReported:sum(rows.filter(row=>row.reportBasis==='gross'),'reportedAmount'),netReported:sum(rows.filter(row=>row.reportBasis==='net'),'reportedAmount'),platformNet:sum(rows,'platformNet')};
      if(contract.contract_type==='commission')return {...base,platformDeduction:rows.some(row=>row.platformDeduction==null)?null:sum(rows,'platformDeduction'),agencyFee:sum(rows,'agencyFee'),holderAmount:sum(rows,'holderAmount')};
      if(contract.contract_type==='self_owned')return {...base,platformDeduction:rows.some(row=>row.platformDeduction==null)?null:sum(rows,'platformDeduction'),ownReceipts:sum(rows,'ownReceipts')};
      const recoupSource=sum(rows,'recoupSource'),recouped=Math.min(Math.max(recoupSource,0),contract.mg_contract_yen),mgBalance=contract.mg_contract_yen-recouped,excess=Math.max(recoupSource-contract.mg_contract_yen,0);
      return {...base,mgContractYen:contract.mg_contract_yen,mgPaidYen:contract.mg_paid_yen,netReceipts:sum(rows,'platformNet'),recoupSource,recouped,mgBalance,excess,holderAdditional:null,overageStatus:'unconfirmed'};
    });
    const linkedReportIds=new Set(linkMap.keys()),unlinkedReports=source.reports.filter(row=>!linkedReportIds.has(row.id));
    return {workId,roundingRule:'控除額は絶対額に料率を掛けて1円未満を切り捨て、元の符号を戻します。残額を権利元または自社受取へ配分します。',scopeNote:'紐付けた有効報告の作品配賦済み明細だけを使う読取専用試算です。入金・支払・確定精算・最終利益ではありません。返品は累計を再計算します。',linkedReports:source.reports.filter(row=>linkedReportIds.has(row.id)),unlinkedReports,unlinkedCount:unlinkedReports.length,lineResults,contractSummaries};
  }
  app.get('/api/settlement/preview',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は権利・分配試算を参照できません',403);
    let workId;try{workId=integer(c.req.query('workId')||'');}catch(e){return bad(c,e.message,400,undefined,e);}
    if(!await settlementWork(i,workId))return bad(c,'作品の財務権限がありません',403);
    return c.json({ok:true,...await settlementPreviewData(i,workId)});
  });

  const committeeCalculationVersion='committee-v2-explicit-deductions';
  function committeeTermsFromInput(input,intakeParticipants){
    const snapshotMembers=intakeParticipants.map((row,index)=>({partnerId:row.partner_id,role:row.role||null,shareBps:row.explicit_share_bps,memberOrder:index+1}));
    if(input.members){const supplied=input.members.map((row,index)=>({partnerId:integer(row.partnerId),role:String(row.role||'').trim()||null,shareBps:integer(row.shareBps),memberOrder:index+1}));if(canonical(supplied)!==canonical(snapshotMembers))throw new Error('メンバーと持分は調達ケースの不変スナップショットと一致させてください');}
    const managerPartnerId=input.managerPartnerId==null||input.managerPartnerId===''?null:integer(input.managerPartnerId);
    const windows=(Array.isArray(input.windows)?input.windows:[]).map(row=>({kind:String(row.kind||''),label:String(row.label||'').trim(),windowPartnerId:integer(row.windowPartnerId),route:String(row.route||''),platformRateBps:integer(row.platformRateBps),windowFeeBps:integer(row.windowFeeBps),managerFeeBps:integer(row.managerFeeBps),feeOrder:String(row.feeOrder||''),windowFeeBasis:String(row.windowFeeBasis||''),managerFeeBasis:String(row.managerFeeBasis||'')}));
    if(windows.some(row=>!row.label||row.label.length>120))throw new Error('販路窓口の表示名は1〜120文字です');
    const day=value=>value==='eom'?'eom':integer(value);
    const phases=(Array.isArray(input.phases)?input.phases:[]).map((row,index)=>({phaseOrder:index+1,label:String(row.label||'').trim(),startsOn:String(row.startsOn||''),endsOn:String(row.endsOn||''),firstCloseOn:String(row.firstCloseOn||''),intervalMonths:integer(row.intervalMonths),closeDay:day(row.closeDay),reportOffsetMonths:integer(row.reportOffsetMonths),reportDay:day(row.reportDay),paymentOffsetMonths:integer(row.paymentOffsetMonths),paymentDay:day(row.paymentDay),referenceType:String(row.referenceType||''),referenceDate:String(row.referenceDate||'')}));
    if(phases.some(row=>!row.label||row.label.length>120))throw new Error('日程フェーズ名は1〜120文字です');
    const terms=validateCommitteeTerms({managerPartnerId,members:snapshotMembers,windows,phases});committeePeriods(terms.phases);terms.funding=normalizeFunding(input.funding,terms.members);return terms;
  }
  async function committeeContracts(i,workId){
    const contracts=await db.all(`SELECT c.*,rc.case_code AS intake_case_code,rc.title AS intake_title,d.title AS document_title,d.reference AS document_reference,d.version_label AS document_version FROM committee_contracts c JOIN rights_intake_cases rc ON rc.org_id=c.org_id AND rc.id=c.intake_case_id JOIN rights_intake_documents d ON d.org_id=c.org_id AND d.id=c.document_id WHERE c.org_id=? AND c.work_id=? ORDER BY c.id`,[i.org_id,workId]);
    const versions=await db.all('SELECT * FROM committee_term_versions WHERE org_id=? ORDER BY contract_id,version_no',[i.org_id]),members=await db.all(`SELECT m.*,p.name AS partner_name FROM committee_term_members m JOIN partners p ON p.org_id=m.org_id AND p.id=m.partner_id WHERE m.org_id=? ORDER BY m.term_version_id,m.member_order`,[i.org_id]),windows=await db.all(`SELECT w.*,p.name AS window_partner_name FROM committee_term_windows w JOIN partners p ON p.org_id=w.org_id AND p.id=w.window_partner_id WHERE w.org_id=? ORDER BY w.term_version_id,w.id`,[i.org_id]),phases=await db.all('SELECT * FROM committee_schedule_phases WHERE org_id=? ORDER BY term_version_id,phase_order',[i.org_id]);
    const funding=await db.all('SELECT * FROM committee_term_funding WHERE org_id=?',[i.org_id]),investments=await db.all('SELECT * FROM committee_term_investments WHERE org_id=?',[i.org_id]),effective=new Map((await db.all('SELECT term_version_id,effective_from FROM committee_term_version_effective WHERE org_id=?',[i.org_id])).map(row=>[row.term_version_id,row.effective_from]));
    return contracts.map(contract=>({...contract,intakeCaseId:contract.intake_case_id,documentId:contract.document_id,versions:versions.filter(version=>version.contract_id===contract.id).map(version=>({...version,effectiveFrom:effective.get(version.id)||null,funding:funding.some(f=>f.term_version_id===version.id)?{productionCostYen:funding.find(f=>f.term_version_id===version.id).production_cost_yen,investments:investments.filter(x=>x.term_version_id===version.id).map(x=>({partnerId:x.partner_id,amountYen:x.amount_yen}))}:null,managerPartnerId:version.manager_partner_id,members:members.filter(row=>row.term_version_id===version.id).map(row=>({...row,partnerId:row.partner_id,shareBps:row.share_bps})),windows:windows.filter(row=>row.term_version_id===version.id).map(row=>({...row,windowPartnerId:row.window_partner_id,platformRateBps:row.platform_rate_bps,windowFeeBps:row.window_fee_bps,managerFeeBps:row.manager_fee_bps,feeOrder:row.fee_order,windowFeeBasis:row.window_fee_basis,managerFeeBasis:row.manager_fee_basis})),phases:phases.filter(row=>row.term_version_id===version.id).map(row=>({...row,phaseOrder:row.phase_order,startsOn:row.starts_on,endsOn:row.ends_on,firstCloseOn:row.first_close_on,intervalMonths:row.interval_months,closeDay:/^\d+$/.test(row.close_day)?Number(row.close_day):row.close_day,reportOffsetMonths:row.report_offset_months,reportDay:/^\d+$/.test(row.report_day)?Number(row.report_day):row.report_day,paymentOffsetMonths:row.payment_offset_months,paymentDay:/^\d+$/.test(row.payment_day)?Number(row.payment_day):row.payment_day,referenceType:row.reference_type,referenceDate:row.reference_date}))}))}));
  }
  async function committeeVersionStatements(i,contract,input,sourceVersionId=null){
    const intake=await db.get("SELECT * FROM rights_intake_cases WHERE org_id=? AND id=? AND work_id=? AND intake_type='committee'",[i.org_id,contract.intake_case_id,contract.work_id]);if(!intake)throw new Error('同じ作品の制作委員会調達ケースがありません');const participants=await db.all('SELECT * FROM rights_intake_participants WHERE org_id=? AND intake_case_id=? ORDER BY id',[i.org_id,intake.id]);if(participants.some(row=>row.partner_id==null||!row.role||row.explicit_share_bps==null)||participants.reduce((sum,row)=>sum+row.explicit_share_bps,0)!==10000)throw new Error('調達ケースの参加者、役割、明示持分100%が必要です');
    const terms=committeeTermsFromInput(input,participants),versionNo=Number((await db.get('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM committee_term_versions WHERE org_id=? AND contract_id=?',[i.org_id,contract.id])).n),versionId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM committee_term_versions')).id),memberStart=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM committee_term_members')).id),windowStart=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM committee_term_windows')).id),phaseStart=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM committee_schedule_phases')).id),note=String(input.note||'').trim()||null;if(note?.length>1000)throw new Error('条件版メモは1000文字以内です');
    const statements=[{sql:'INSERT INTO committee_term_versions(id,org_id,contract_id,version_no,source_version_id,manager_partner_id,calculation_version,note,created_by) VALUES(?,?,?,?,?,?,?,?,?)',params:[versionId,i.org_id,contract.id,versionNo,sourceVersionId,terms.managerPartnerId,committeeCalculationVersion,note,i.user_id]}];
    terms.members.forEach((row,index)=>statements.push({sql:'INSERT INTO committee_term_members(id,org_id,term_version_id,partner_id,role,share_bps,member_order) VALUES(?,?,?,?,?,?,?)',params:[memberStart+index,i.org_id,versionId,row.partnerId,row.role,row.shareBps,row.memberOrder]}));
    terms.windows.forEach((row,index)=>statements.push({sql:'INSERT INTO committee_term_windows(id,org_id,term_version_id,kind,label,window_partner_id,route,platform_rate_bps,window_fee_bps,manager_fee_bps,fee_order,window_fee_basis,manager_fee_basis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[windowStart+index,i.org_id,versionId,row.kind,row.label,row.windowPartnerId,row.route,row.platformRateBps,row.windowFeeBps,row.managerFeeBps,row.feeOrder,row.windowFeeBasis,row.managerFeeBasis]}));
    terms.phases.forEach((row,index)=>statements.push({sql:'INSERT INTO committee_schedule_phases(id,org_id,term_version_id,phase_order,label,starts_on,ends_on,first_close_on,interval_months,close_day,report_offset_months,report_day,payment_offset_months,payment_day,reference_type,reference_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[phaseStart+index,i.org_id,versionId,row.phaseOrder,row.label,row.startsOn,row.endsOn,row.firstCloseOn,row.intervalMonths,String(row.closeDay),row.reportOffsetMonths,String(row.reportDay),row.paymentOffsetMonths,String(row.paymentDay),row.referenceType,row.referenceDate]}));
    if(terms.funding){statements.push({sql:'INSERT INTO committee_term_funding(org_id,term_version_id,production_cost_yen) VALUES(?,?,?)',params:[i.org_id,versionId,terms.funding.productionCostYen]});for(const investment of terms.funding.investments)statements.push({sql:'INSERT INTO committee_term_investments(org_id,term_version_id,partner_id,amount_yen) VALUES(?,?,?,?)',params:[i.org_id,versionId,investment.partnerId,investment.amountYen]})}
    // 適用開始月（版2以降。空は最初の月から）と、コピー元の版の窓口手数料の取り分の引き継ぎ（committee/committee-version-rules.mjs）
    const effectiveFrom=parseEffectiveFrom(input,{versionNo});if(effectiveFrom)statements.push({sql:'INSERT INTO committee_term_version_effective(org_id,term_version_id,effective_from,created_by) VALUES(?,?,?,?)',params:[i.org_id,versionId,effectiveFrom,i.user_id]});
    const feeShares=await feeShareCopy(db,{orgId:i.org_id,userId:i.user_id,sourceVersionId,enabled:input.copyFeeShares!==false,memberIds:terms.members.map(row=>row.partnerId),newWindows:terms.windows.map((row,index)=>({id:windowStart+index,kind:row.kind,label:row.label,windowPartnerId:row.windowPartnerId}))});statements.push(...feeShares.statements);
    return {terms,versionId,versionNo,statements,effectiveFrom,feeShares:{copied:feeShares.copied,skipped:feeShares.skipped}};
  }
  app.get('/api/committee/contracts',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は製作委員会条件を参照できません',403);let workId;try{workId=integer(c.req.query('workId')||'')}catch(error){return bad(c,error.message,400,undefined,error)}if(!await settlementWork(i,workId))return bad(c,'作品の財務権限がありません',403);return c.json({ok:true,contracts:await committeeContracts(i,workId),scopeNote:'契約書参照と不変条件版の管理試作です。実契約・実会計・実送金には適用しません。'});});
  app.post('/api/committee/contracts',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は製作委員会条件を登録できません',403);const input=await body(c);let workId,intakeCaseId,documentId;try{workId=integer(input.workId);intakeCaseId=integer(input.intakeCaseId);documentId=integer(input.documentId)}catch(error){return bad(c,error.message,400,undefined,error)}const work=await settlementWork(i,workId);if(!work)return bad(c,'作品の財務編集権限がありません',403);const intake=await db.get("SELECT * FROM rights_intake_cases WHERE org_id=? AND id=? AND work_id=? AND intake_type='committee'",[i.org_id,intakeCaseId,workId]);if(!intake)return bad(c,'制作委員会の調達ケースがありません',409);if(!await db.get("SELECT 1 FROM rights_intake_documents WHERE org_id=? AND id=? AND intake_case_id=? AND title<>'' AND reference<>'' AND version_label IS NOT NULL AND version_label<>''",[i.org_id,documentId,intakeCaseId]))return bad(c,'名称・参照先・版を備えた契約書参照が必要です',409);const contractCode=String(input.contractCode||'').trim(),title=String(input.title||'').trim();if(!contractCode||!title||contractCode.length>80||title.length>160)return bad(c,'契約コードと名称を確認してください');const contractId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM committee_contracts')).id),contract={id:contractId,intake_case_id:intakeCaseId,work_id:workId};let built;try{built=await committeeVersionStatements(i,contract,input)}catch(error){return bad(c,error.message,400,undefined,error)}const impact=await retroactiveRoyaltyImpact(db,{orgId:i.org_id,workId,newContract:true});if(impact.total&&input.confirmRetroactive!==true)return bad(c,retroactiveMessage(impact,{newContract:true}),409,{code:'retroactive',affectedStatements:impact.statements,affectedTotal:impact.total,effectiveFrom:null});const statements=[{sql:'INSERT INTO committee_contracts(id,org_id,project_id,work_id,intake_case_id,document_id,contract_code,title,created_by) VALUES(?,?,?,?,?,?,?,?,?)',params:[contractId,i.org_id,work.project_id,workId,intakeCaseId,documentId,contractCode,title,i.user_id]},...built.statements,{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','committee_contract',String(contractId),json({workId,intakeCaseId,documentId,versionId:built.versionId,retroactiveConfirmed:impact.total?impact.statements.map(row=>row.statementId):undefined})]}];try{await db.batch(statements)}catch(error){return bad(c,error.message,409,undefined,error)}return c.json({ok:true,contractId,versionId:built.versionId,versionNo:1},201);});
  app.post('/api/committee/contracts/:id/versions',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は製作委員会条件版を登録できません',403);let contractId;try{contractId=integer(c.req.param('id'))}catch(error){return bad(c,error.message,400,undefined,error)}const contract=await db.get('SELECT * FROM committee_contracts WHERE org_id=? AND id=?',[i.org_id,contractId]);if(!contract)return bad(c,'製作委員会契約がありません',404);if(!await settlementWork(i,contract.work_id))return bad(c,'作品の財務編集権限がありません',403);const input=await body(c);let sourceVersionId=null;if(input.sourceVersionId!=null&&input.sourceVersionId!==''){try{sourceVersionId=integer(input.sourceVersionId)}catch(error){return bad(c,error.message,400,undefined,error)}if(!await db.get('SELECT 1 FROM committee_term_versions WHERE org_id=? AND id=? AND contract_id=?',[i.org_id,sourceVersionId,contractId]))return bad(c,'コピー元条件版がありません',409)}let built;try{built=await committeeVersionStatements(i,contract,input,sourceVersionId)}catch(error){return bad(c,error.message,400,undefined,error)}const impact=await retroactiveRoyaltyImpact(db,{orgId:i.org_id,workId:contract.work_id,contractId,fromMonth:built.effectiveFrom});if(impact.total&&input.confirmRetroactive!==true)return bad(c,retroactiveMessage(impact),409,{code:'retroactive',affectedStatements:impact.statements,affectedTotal:impact.total,effectiveFrom:built.effectiveFrom});built.statements.push({sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'append','committee_term_version',String(built.versionId),json({contractId,versionNo:built.versionNo,sourceVersionId,effectiveFrom:built.effectiveFrom,feeShares:built.feeShares,retroactiveConfirmed:impact.total?impact.statements.map(row=>row.statementId):undefined})]});try{await db.batch(built.statements)}catch(error){return bad(c,error.message,409,undefined,error)}return c.json({ok:true,contractId,versionId:built.versionId,versionNo:built.versionNo,effectiveFrom:built.effectiveFrom,feeShares:built.feeShares},201);});
  app.get('/api/committee/periods',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は委員会日程を参照できません',403);let termVersionId;try{termVersionId=integer(c.req.query('termVersionId')||'')}catch(error){return bad(c,error.message,400,undefined,error)}const version=await db.get('SELECT v.*,c.work_id FROM committee_term_versions v JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id WHERE v.org_id=? AND v.id=?',[i.org_id,termVersionId]);if(!version||!await settlementWork(i,version.work_id))return bad(c,'条件版への権限がありません',403);const contracts=await committeeContracts(i,version.work_id),term=contracts.flatMap(row=>row.versions).find(row=>row.id===termVersionId);try{return c.json({ok:true,termVersionId,periods:committeePeriods(term.phases),dateRule:'月末を超える日付はその月の末日にクランプします。休日調整は行わず、すべて予定日です。'})}catch(error){return bad(c,error.message,400,undefined,error)};});

  async function committeePreview(i,input,allowEmpty=false){
    let workId,termVersionId,periodIndex;try{workId=integer(input.workId);termVersionId=integer(input.termVersionId);periodIndex=integer(input.periodIndex)}catch(error){throw new Error(error.message)}if(!['sales_period','report_received'].includes(input.periodDateBasis))throw new Error('期間所属基準を明示してください');const work=await settlementWork(i,workId);if(!work)throw new Error('作品の財務編集権限がありません');const contracts=await committeeContracts(i,workId),contract=contracts.find(row=>row.versions.some(version=>version.id===termVersionId)),term=contract?.versions.find(version=>version.id===termVersionId);if(!contract||!term)throw new Error('選択作品の条件版がありません');const periods=committeePeriods(term.phases),period=periods.find(row=>row.index===periodIndex);if(!period)throw new Error('条件版の日程に報告期間がありません');const allowStub=input.allowStub===true;if(period.stub&&!allowStub)throw new Error('端数期間です。契約上この端数期間を採用する場合だけallowStubを明示してください');
    const reportLinks=Array.isArray(input.reportLinks)?input.reportLinks.map(row=>({reportId:integer(row.reportId),reportBasis:String(row.reportBasis||'')})).sort((a,b)=>a.reportId-b.reportId):[],expenseAllocations=Array.isArray(input.expenseAllocations)?input.expenseAllocations.map(row=>({expenseId:integer(row.expenseId),windowId:integer(row.windowId)})).sort((a,b)=>a.expenseId-b.expenseId):[];/* 選んだ順によらず、保存時の作り直し（正規化した入力＝番号順）と同じ順で計算する */if(!allowEmpty&&!reportLinks.length&&!expenseAllocations.length)throw new Error('報告書または控除費用を1件以上明示してください');if(new Set(reportLinks.map(row=>row.reportId)).size!==reportLinks.length)throw new Error('同じ報告書が重複しています');if(new Set(expenseAllocations.map(row=>row.expenseId)).size!==expenseAllocations.length)throw new Error('同じ経費が重複しています');if(reportLinks.some(row=>!['gross','net'].includes(row.reportBasis)))throw new Error('報告額基準をgrossまたはnetで明示してください');
    const source=await settlementSource(i,workId),reportMap=new Map(source.reports.map(row=>[row.id,row])),windowByKind=new Map(term.windows.map(row=>[row.kind,row])),windowById=new Map(term.windows.map(row=>[row.id,row])),existingSettlement=new Set((await db.all('SELECT report_id FROM settlement_report_links WHERE org_id=? AND work_id=?',[i.org_id,workId])).map(row=>row.report_id)),usedReports=new Set((await db.all('SELECT report_id FROM committee_snapshot_reports WHERE org_id=? AND work_id=?',[i.org_id,workId])).map(row=>row.report_id)),usedExpenses=new Set((await db.all('SELECT expense_id FROM committee_snapshot_expenses WHERE org_id=?',[i.org_id])).map(row=>row.expense_id));const recognitionRows=await db.all('SELECT report_id,report_received_on FROM report_recognition WHERE org_id=?',[i.org_id]),received=new Map(recognitionRows.map(row=>[row.report_id,row.report_received_on]));
    const selectedReports=[],lines=[];for(const link of reportLinks){const report=reportMap.get(link.reportId);if(!report)throw new Error(`報告${link.reportId}は選択作品への有効な配賦がありません`);if(existingSettlement.has(link.reportId))throw new Error(`報告${link.reportId}は既存の個別精算に使用済みです`);if(usedReports.has(link.reportId))throw new Error(`報告${link.reportId}は保存済み委員会報告に使用済みです`);const window=windowByKind.get(report.kind);if(!window)throw new Error(`販路${report.kind}の窓口条件がありません`);const parts=source.parts.filter(row=>row.report_id===link.reportId);if(input.periodDateBasis==='sales_period'&&parts.some(row=>row.sales_period_from<period.start||row.sales_period_to>period.end))throw new Error(`報告${link.reportId}の販売期間が締め期間を跨ぐか期間外です`);if(input.periodDateBasis==='report_received'){const value=received.get(link.reportId);if(!value)throw new Error(`報告${link.reportId}に報告受領日がありません`);if(value<period.start||value>period.end)throw new Error(`報告${link.reportId}の受領日が締め期間外です`)}let amountBig=0n;for(const part of parts){if(!Number.isSafeInteger(part.allocated_amount_ex_tax))throw new Error('作品配賦済み売上が安全な整数ではありません');amountBig+=BigInt(part.allocated_amount_ex_tax)}if(amountBig>BigInt(Number.MAX_SAFE_INTEGER)||amountBig<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('作品配賦済み売上が整数範囲を超えています');const amount=Number(amountBig);selectedReports.push({...link,kind:report.kind,reportKey:report.report_key,contentHash:report.content_hash,rawReferenceId:report.id,windowId:window.id,amount,accountingMonth:report.accounting_month,periodFrom:report.period_from,periodTo:report.period_to,reportReceivedOn:received.get(link.reportId)||null});for(const row of parts)lines.push({reportId:link.reportId,reportBasis:link.reportBasis,windowId:window.id,saleId:row.id,sourceRow:row.source_row,allocationBps:row.allocation_bps,allocatedAmountExTax:row.allocated_amount_ex_tax,salesPeriodFrom:row.sales_period_from,salesPeriodTo:row.sales_period_to,accountingMonth:row.accounting_month,description:row.description})}
    const selectedExpenses=[];for(const allocation of expenseAllocations){const window=windowById.get(allocation.windowId);if(!window)throw new Error('条件版の販路窓口がありません');if(usedExpenses.has(allocation.expenseId))throw new Error(`経費${allocation.expenseId}は保存済み委員会報告に使用済みです`);const expense=await db.get(`SELECT * FROM ${expenseSource()} WHERE org_id=? AND id=? AND work_id=?`,[i.org_id,allocation.expenseId,workId]);if(!expense)throw new Error(`経費${allocation.expenseId}は同じ作品にありません`);selectedExpenses.push({...allocation,amount:expense.actual_ex_tax,description:expense.description,accountingMonth:expense.accounting_month,incurredOn:expense.incurred_on})}
    const previousRecoupYen=Number((await db.get("SELECT COALESCE(SUM(d.amount_yen),0) AS amount FROM committee_snapshot_deductions d JOIN committee_report_snapshots s ON s.org_id=d.org_id AND s.id=d.snapshot_id WHERE s.org_id=? AND s.contract_id=? AND d.category='production_recoup'",[i.org_id,contract.id])).amount);
    const deductions=normalizeDeductions(input.deductions||[],selectedReports,await db.all('SELECT id FROM partners WHERE org_id=?',[i.org_id]),term.members,term.funding,previousRecoupYen);
    for(const deduction of deductions)if(await db.get('SELECT 1 FROM committee_snapshot_deductions WHERE org_id=? AND work_id=? AND source_reference=?',[i.org_id,workId,deduction.sourceReference]))throw new Error('この控除根拠は保存済み委員会報告で使用済みです');
    const calculationWindows=term.windows.map(window=>({...calculateCommitteeWindow({deductions:deductions.filter(d=>d.windowId===window.id),window:{...window,managerPartnerId:term.manager_partner_id},reports:selectedReports.filter(row=>row.windowId===window.id).map(row=>({reportId:row.reportId,reportBasis:row.reportBasis,amount:row.amount})),expenses:selectedExpenses.filter(row=>row.windowId===window.id).map(row=>({expenseId:row.expenseId,amount:row.amount})),members:term.members.map(row=>({partnerId:row.partner_id,shareBps:row.share_bps}))}),windowId:window.id,windowPartnerId:window.window_partner_id,managerPartnerId:term.manager_partner_id}));const sumSafe=(rows,key)=>{let total=0n;for(const row of rows){if(!Number.isSafeInteger(row[key]))throw new Error('委員会報告の総計に安全でない整数があります');total+=BigInt(row[key])}if(total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('委員会報告の総計が安全な整数範囲を超えています');return Number(total)},memberPayoutRows=calculationWindows.map(row=>({amount:sumSafe(row.payouts,'amount')})),totals={grossReported:sumSafe(calculationWindows,'grossReported'),netReported:sumSafe(calculationWindows,'netReported'),platformNet:sumSafe(calculationWindows,'platformNet'),platformFeeKnown:sumSafe(calculationWindows,'platformFeeKnown'),platformFee:calculationWindows.some(row=>row.hasNetBasis)?null:sumSafe(calculationWindows,'platformFeeKnown'),windowFee:sumSafe(calculationWindows,'windowFee'),managerFee:sumSafe(calculationWindows,'managerFee'),expenseTotal:sumSafe(calculationWindows,'expenseTotal'),royaltyDeductions:sumSafe(calculationWindows,'royaltyDeductions'),productionRecoupDeductions:sumSafe(calculationWindows,'productionRecoupDeductions'),distributionPool:sumSafe(calculationWindows,'distributionPool'),memberPayouts:sumSafe(memberPayoutRows,'amount'),residual:sumSafe(calculationWindows,'residual')};
    const candidateReports=source.reports.map(report=>{let reason=null;const parts=source.parts.filter(row=>row.report_id===report.id),receivedOn=received.get(report.id);if(existingSettlement.has(report.id))reason='既存の個別精算に使用済み';else if(usedReports.has(report.id))reason='保存済み委員会報告に使用済み';else if(!windowByKind.has(report.kind))reason='販路窓口条件なし';else if(input.periodDateBasis==='sales_period'&&parts.some(row=>row.sales_period_from<period.start||row.sales_period_to>period.end))reason='販売期間が締め期間を跨ぐか期間外';else if(input.periodDateBasis==='report_received'&&!receivedOn)reason='報告受領日未確認';else if(input.periodDateBasis==='report_received'&&(receivedOn<period.start||receivedOn>period.end))reason='報告受領日が締め期間外';return {...report,reportReceivedOn:receivedOn||null,eligible:reason==null,reason}}),selectedIds=new Set(selectedReports.map(row=>row.reportId)),unallocatedReports=candidateReports.filter(row=>!selectedIds.has(row.id)).map(row=>({id:row.id,key:row.report_key,kind:row.kind,reason:row.reason||'期間対象だが未選択'})),availableExpenses=await db.all(`SELECT * FROM ${expenseSource()} WHERE org_id=? AND work_id=? ORDER BY incurred_on,id`,[i.org_id,workId]);const normalizedInput={workId,termVersionId,periodIndex,periodDateBasis:input.periodDateBasis,allowStub,deductions,reportLinks:[...reportLinks].sort((a,b)=>a.reportId-b.reportId),expenseAllocations:[...expenseAllocations].sort((a,b)=>a.expenseId-b.expenseId)},inputHash=await sha256(canonical({calculationVersion:committeeCalculationVersion,...normalizedInput}));const calculation={calculationVersion:committeeCalculationVersion,contract:{id:contract.id,code:contract.contract_code,title:contract.title,intakeCaseId:contract.intake_case_id,documentId:contract.document_id,documentTitle:contract.document_title,documentReference:contract.document_reference,documentVersion:contract.document_version},termVersion:{id:term.id,versionNo:term.version_no,managerPartnerId:term.manager_partner_id},period,periodDateBasis:input.periodDateBasis,selectedReports,unallocatedReports,selectedExpenses,deductions,funding:term.funding,previousRecoupYen,lines,windows:calculationWindows,totals,members:term.members,scopeNote:'JPY税抜の予定報告です。会計計上月と分配締めを分離し、入金・実送金・法定会計確定は扱いません。',roundingRule:'各料率は符号付き整数円の絶対額に適用して1円未満を切り捨てます。メンバー配分も切り捨て、差額は未配分端数として残します。'};const calculationHash=await sha256(canonical(calculation));return {work,contract,term,period,normalizedInput,inputHash,calculation,calculationHash,candidateReports,availableExpenses:availableExpenses.map(row=>({...row,eligible:!usedExpenses.has(row.id),reason:usedExpenses.has(row.id)?'保存済み委員会報告に使用済み':null}))};
  }
  app.get('/api/committee/sources',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は委員会報告候補を参照できません',403);let workId,termVersionId,periodIndex;try{workId=integer(c.req.query('workId')||'');termVersionId=integer(c.req.query('termVersionId')||'');periodIndex=integer(c.req.query('periodIndex')||'')}catch(error){return bad(c,error.message,400,undefined,error)}const periodDateBasis=String(c.req.query('periodDateBasis')||'');let built;try{built=await committeePreview(i,{workId,termVersionId,periodIndex,periodDateBasis,allowStub:true,reportLinks:[],expenseAllocations:[]},true)}catch(error){return bad(c,error.message,409,undefined,error)}return c.json({ok:true,period:built.period,candidateReports:built.candidateReports,availableExpenses:built.availableExpenses,windows:built.term.windows,funding:built.term.funding,scopeNote:built.calculation.scopeNote});});
  app.post('/api/committee/previews',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は委員会報告を作成できません',403);const input=await body(c);let built;try{built=await committeePreview(i,input)}catch(error){return bad(c,error.message,409,undefined,error)}const token=randomToken(),payload={formatVersion:1,orgId:i.org_id,userId:i.user_id,input:built.normalizedInput,inputHash:built.inputHash,calculation:built.calculation,calculationHash:built.calculationHash};await db.run('DELETE FROM committee_report_previews WHERE expires_at<?',[nowIso()]);await db.run('INSERT INTO committee_report_previews(token,org_id,user_id,project_id,work_id,payload_json,expires_at) VALUES(?,?,?,?,?,?,?)',[token,i.org_id,i.user_id,built.work.project_id,built.normalizedInput.workId,json(payload),new Date(Date.now()+15*60_000).toISOString()]);return c.json({ok:true,token,inputHash:built.inputHash,calculationHash:built.calculationHash,...built.calculation,candidateReports:built.candidateReports,availableExpenses:built.availableExpenses});});
  app.post('/api/committee/snapshots',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は委員会報告を保存できません',403);const input=await body(c),record=await db.get('SELECT * FROM committee_report_previews WHERE token=? AND org_id=? AND user_id=? AND consumed=0 AND expires_at>?',[input.token,i.org_id,i.user_id,nowIso()]);if(!record)return bad(c,'プレビューがないか期限切れ・保存済みです',410);const payload=JSON.parse(record.payload_json);let rebuilt;try{rebuilt=await committeePreview(i,payload.input)}catch(error){return bad(c,error.message,409,undefined,error)}if(rebuilt.inputHash!==payload.inputHash||rebuilt.calculationHash!==payload.calculationHash||canonical(rebuilt.calculation)!==canonical(payload.calculation))return bad(c,'元データまたは計算結果がプレビュー時から変わりました',409);const calc=rebuilt.calculation,snapshotId=Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM committee_report_snapshots')).id),statements=[{sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM committee_report_previews WHERE token=? AND consumed=0 AND expires_at>?)',params:[input.token,nowIso()]},{sql:'INSERT INTO committee_report_snapshots(id,org_id,project_id,work_id,contract_id,term_version_id,period_index,period_from,period_to,close_on,report_on,payment_on,period_date_basis,stub,allow_stub,calculation_version,input_json,input_hash,calculation_json,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',params:[snapshotId,i.org_id,rebuilt.work.project_id,payload.input.workId,calc.contract.id,calc.termVersion.id,calc.period.index,calc.period.start,calc.period.end,calc.period.closeOn,calc.period.reportOn,calc.period.paymentOn,calc.periodDateBasis,calc.period.stub?1:0,payload.input.allowStub?1:0,committeeCalculationVersion,json(payload.input),payload.inputHash,json(calc),i.user_id]}];if(calc.deductions?.some(d=>d.category==='production_recoup'))statements.push({sql:"INSERT INTO transaction_guards(value) SELECT 0 WHERE (SELECT COALESCE(SUM(d.amount_yen),0) FROM committee_snapshot_deductions d JOIN committee_report_snapshots s ON s.org_id=d.org_id AND s.id=d.snapshot_id WHERE s.org_id=? AND s.contract_id=? AND d.category='production_recoup')<>?",params:[i.org_id,calc.contract.id,calc.previousRecoupYen]});for(const report of calc.selectedReports){statements.push({sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM report_imports WHERE org_id=? AND id=? AND status=\'active\') OR EXISTS(SELECT 1 FROM settlement_report_links WHERE org_id=? AND work_id=? AND report_id=?) OR EXISTS(SELECT 1 FROM committee_snapshot_reports WHERE org_id=? AND work_id=? AND report_id=?)',params:[i.org_id,report.reportId,i.org_id,payload.input.workId,report.reportId,i.org_id,payload.input.workId,report.reportId]},{sql:'INSERT INTO committee_snapshot_reports(org_id,snapshot_id,work_id,report_id,window_id,report_basis) VALUES(?,?,?,?,?,?)',params:[i.org_id,snapshotId,payload.input.workId,report.reportId,report.windowId,report.reportBasis]})}for(const d of calc.deductions||[])statements.push({sql:'INSERT INTO committee_snapshot_deductions(org_id,snapshot_id,work_id,report_id,window_id,category,recipient_partner_id,amount_yen,source_reference) VALUES(?,?,?,?,?,?,?,?,?)',params:[i.org_id,snapshotId,payload.input.workId,d.reportId,d.windowId,d.category,d.recipientPartnerId,d.amountYen,d.sourceReference]});for(const expense of calc.selectedExpenses){statements.push({sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM committee_snapshot_expenses WHERE org_id=? AND expense_id=?)',params:[i.org_id,expense.expenseId]},{sql:'INSERT INTO committee_snapshot_expenses(org_id,snapshot_id,work_id,expense_id,window_id,amount_ex_tax) VALUES(?,?,?,?,?,?)',params:[i.org_id,snapshotId,payload.input.workId,expense.expenseId,expense.windowId,expense.amount]})}for(const line of calc.lines)statements.push({sql:'INSERT INTO committee_snapshot_lines(org_id,snapshot_id,work_id,report_id,sale_id,window_id,source_row,allocation_bps,allocated_amount_ex_tax,sales_period_from,sales_period_to,accounting_month) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',params:[i.org_id,snapshotId,payload.input.workId,line.reportId,line.saleId,line.windowId,line.sourceRow,line.allocationBps,line.allocatedAmountExTax,line.salesPeriodFrom,line.salesPeriodTo,line.accountingMonth]});for(const window of calc.windows)for(const payout of window.payouts)statements.push({sql:'INSERT INTO committee_snapshot_member_amounts(org_id,snapshot_id,window_id,partner_id,share_bps,amount_yen,route,window_fee_recipient,manager_fee_recipient) VALUES(?,?,?,?,?,?,?,?,?)',params:[i.org_id,snapshotId,window.windowId,payout.partnerId,payout.shareBps,payout.amount,payout.route,payout.windowFeeRecipient?1:0,payout.managerFeeRecipient?1:0]});statements.push({sql:'UPDATE committee_report_previews SET consumed=1 WHERE token=?',params:[input.token]},{sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)',params:[i.org_id,i.user_id,'create','committee_report_snapshot',String(snapshotId),payload.calculationHash,json({workId:payload.input.workId,termVersionId:payload.input.termVersionId,periodIndex:payload.input.periodIndex})]});try{await db.batch(statements)}catch(error){return bad(c,error.message,409,undefined,error)}return c.json({ok:true,snapshotId,inputHash:payload.inputHash,calculationHash:payload.calculationHash},201);});
  app.get('/api/committee/snapshots',async c=>{const i=c.get('identity');if(i.role==='production')return bad(c,'制作担当は委員会報告を参照できません',403);let workId;try{workId=integer(c.req.query('workId')||'')}catch(error){return bad(c,error.message,400,undefined,error)}if(!await settlementWork(i,workId))return bad(c,'作品の財務権限がありません',403);const rows=await db.all('SELECT * FROM committee_report_snapshots WHERE org_id=? AND work_id=? ORDER BY id DESC',[i.org_id,workId]);return c.json({ok:true,rows:rows.map(row=>({...row,input:JSON.parse(row.input_json),calculation:JSON.parse(row.calculation_json)}))});});
  registerMgPortfolioRoutes(app,{db,bad,settlementWork});
  registerJointCommitteeRoutes(app,{db,bad,settlementWork});
  registerBroadcastRoutes(app,{db,bad,body,permittedProjects});
  registerBroadcastApprovalRoutes(app,{db,bad,permittedProjects});
  registerBroadcastWindowRoutes(app,{db,bad,body,permittedProjects});
  registerProductionRoutes(app,{db,bad,body,permittedProjects});
  registerCommercialRoutes(app,{db,bad,body,canonical,sha256,nowIso,settlementWork,permittedProjects,allocatedSaleParts});
  registerMgRoutes(app,{db,bad,body,settlementWork});
  registerMgLedgerImportRoutes(app,{db,bad,body,settlementWork,sha256,mode});
  registerRightsReportRoutes(app,{db,bad,settlementWork});
  registerTaxRoutes(app,{db,bad,body,canonical,sha256,settlementWork,requireAllWorks:async(identity,workIds)=>{for(const workId of new Set(workIds))if(!await settlementWork(identity,workId))return false;return true}});
  registerCatalogRoutes(app,{db,bad,body,permittedProjects});
  registerWorkMasterRoutes(app,{db,bad,body,permittedProjects});
  registerProductMasterRoutes(app,{db,bad,body,permittedProjects});
  registerReleaseWindowRoutes(app,{db,bad,body,permittedProjects,mode});
  registerPartnerListRoutes(app,{db,bad,body,permittedProjects,mode});
  registerReleaseProposalRoutes(app,{db,bad,body,permittedProjects});
  registerWorkbenchRoutes(app,{db,bad,body,extractWorkbenchFile,previewImport,commitImport,mode});
  registerReportingRoutes(app,{db,bad,body,permittedProjects,settlementWork,allocatedSaleParts})
  registerAnnualReportRoutes(app,{db,bad,body,permittedProjects});
  registerBulkRoutes(app,{db,bad,body,permittedProjects,sha256,mode});
  registerSalesLinesRoutes(app,{db,bad,permittedProjects});
  registerMgSalesReportRoutes(app,{db,bad,settlementWork});
  registerRoyaltyStatementRoutes(app,{db,bad,settlementWork,settlementPreviewData});
  registerReceivablesRoutes(app,{db,bad,settlementWork});
  registerWorkQueueRoutes(app,{db,permittedProjects,settlementWork});
  registerDataBrowserRoutes(app,{db,bad});
  registerPartnerProfileRoutes(app,{db,bad,body});
  registerWorkflowRoutes(app,{db,bad,body,canonical,sha256,nowIso,permittedProjects,settlementWork,extractDocument,suggestMappings});
  app.get('/api/audit',async c=>{const i=c.get('identity');if(i.role!=='admin')return bad(c,'管理者だけが参照できます',403);return c.json({ok:true,rows:await db.all('SELECT * FROM audit_log WHERE org_id=? ORDER BY id DESC',[i.org_id])});});

  async function incomeData(i,monthFilter,workFilter) {
    const pids=(await permittedProjects(db,i,true)).map(x=>x.id);
    const works=await db.all('SELECT id,project_id FROM works WHERE org_id=?',[i.org_id]);
    const permitted=new Set(works.filter(w=>pids.includes(w.project_id)).map(w=>w.id));
    if(workFilter&&!permitted.has(workFilter))throw Error('作品への権限がありません');
    const sales=await db.all(`SELECT s.* FROM sale_lines s LEFT JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=? AND (s.report_id IS NULL OR r.status='active') ${monthFilter?'AND s.accounting_month=?':''}`,monthFilter?[i.org_id,month(monthFilter)]:[i.org_id]);
    const mappings=await db.all('SELECT * FROM product_works WHERE org_id=? ORDER BY work_id',[i.org_id]);
    const allocated=[];
    function split(value,shares){
      const sign=value<0?-1:1,v=BigInt(Math.abs(value));
      const parts=shares.map(x=>({workId:x.work_id,bps:x.allocation_bps,base:v*BigInt(x.allocation_bps)/10000n,rem:v*BigInt(x.allocation_bps)%10000n}));
      let left=v-parts.reduce((n,x)=>n+x.base,0n);parts.sort((a,b)=>a.rem===b.rem?a.workId-b.workId:a.rem>b.rem?-1:1);
      for(let j=0;left>0n;j++,left--)parts[j%parts.length].base++;
      return new Map(parts.map(x=>[x.workId,sign*Number(x.base)]));
    }
    for(const sale of sales){
      let shares=sale.product_id?mappings.filter(x=>x.product_id===sale.product_id):[];
      if(!shares.length)shares=[{work_id:sale.work_id,allocation_bps:10000}];
      if(shares.reduce((n,x)=>n+x.allocation_bps,0)!==10000)throw Error('商品配賦が100%ではありません');
      const ex=split(sale.amount_ex_tax,shares),tax=split(sale.tax_amount,shares);
      for(const share of shares)if(permitted.has(share.work_id)&&(!workFilter||workFilter===share.work_id))allocated.push({sale_id:sale.id,allocated_work_id:share.work_id,allocation_bps:share.allocation_bps,accounting_month:sale.accounting_month,amount_ex_tax:ex.get(share.work_id),tax_amount:tax.get(share.work_id),amount_inc_tax:ex.get(share.work_id)+tax.get(share.work_id)});
    }
    const allExpenses=await db.all(`SELECT * FROM ${expenseSource()} WHERE org_id=? ${monthFilter?'AND accounting_month=?':''}`,monthFilter?[i.org_id,monthFilter]:[i.org_id]);
    const visibleExpenses=allExpenses.filter(e=>pids.includes(e.project_id));
    const selectedExpenses=visibleExpenses.filter(e=>!workFilter||e.work_id===workFilter);
    const sum=(rows,key)=>{const n=rows.reduce((v,r)=>v+r[key],0);if(!Number.isSafeInteger(n))throw Error('集計金額が試作の整数範囲を超えています');return n;};
    const monthKeys=[...new Set([...allocated.map(r=>r.accounting_month),...selectedExpenses.map(r=>r.accounting_month)])].sort();
    const monthly=monthKeys.map(m=>{const revenue=sum(allocated.filter(r=>r.accounting_month===m),'amount_ex_tax'),cost=sum(selectedExpenses.filter(r=>r.accounting_month===m),'actual_ex_tax');return {month:m,revenue,cost,profit:revenue-cost};});
    return {ok:true,filters:{month:monthFilter||null,workId:workFilter},sales:{exTax:sum(allocated,'amount_ex_tax'),tax:sum(allocated,'tax_amount'),incTax:sum(allocated,'amount_inc_tax')},expenses:{exTax:sum(selectedExpenses,'actual_ex_tax'),tax:sum(selectedExpenses,'tax_amount'),incTax:sum(selectedExpenses,'actual_inc_tax'),budget:selectedExpenses.reduce((n,r)=>n+(r.budget_yen||0),0)},unallocatedProjectExpenses:visibleExpenses.filter(e=>e.work_id==null&&(!workFilter||e.project_id===works.find(w=>w.id===workFilter)?.project_id)),profitExTax:sum(allocated,'amount_ex_tax')-sum(selectedExpenses,'actual_ex_tax'),monthly,source:'sale_lines + expenses; campaigns are not joined',allocatedLines:allocated};
  }
  app.get('/api/analytics/income',async c=>{
    const i=c.get('identity');if(i.role==='production')return bad(c,'収支への権限がありません',403);
    try{return c.json(await incomeData(i,c.req.query('month'),c.req.query('workId')?integer(c.req.query('workId')):null));}catch(e){return bad(c,e.message,403,undefined,e);}
  });
  app.get('/api/analytics/publicity',async c=>{
    const i=c.get('identity'),workId=c.req.query('workId')?integer(c.req.query('workId')):null;
    const pids=(await permittedProjects(db,i)).map(x=>x.id);
    if(workId){const w=await db.get('SELECT project_id FROM works WHERE org_id=? AND id=?',[i.org_id,workId]);if(!w||!pids.includes(w.project_id))return bad(c,'作品への権限がありません',403);}
    const all=await db.all(`SELECT o.*,d.field_key,d.label,d.value_type,d.unit,d.aggregation,e.medium,c.name AS campaign_name,c.id AS campaign_id,c.project_id,c.work_id FROM observations o JOIN metric_definitions d ON d.org_id=o.org_id AND d.id=o.metric_definition_id JOIN exposures e ON e.org_id=o.org_id AND e.id=o.exposure_id JOIN campaigns c ON c.org_id=e.org_id AND c.id=e.campaign_id WHERE o.org_id=? ORDER BY o.acquired_at,o.id`,[i.org_id]);
    const rows=all.filter(r=>pids.includes(r.project_id)&&(!workId||r.work_id===workId)&&(!c.req.query('medium')||r.medium===c.req.query('medium'))&&(!c.req.query('region')||(r.region||'unverified')===c.req.query('region'))&&(!c.req.query('campaignId')||r.campaign_id===Number(c.req.query('campaignId'))));
    const groups={};for(const r of rows){const key=json([r.field_key,r.unit,r.period_from,r.period_to,r.granularity,r.medium,r.region,r.paid_organic]);const g=groups[key]??={metric:r.field_key,label:r.label,unit:r.unit,periodFrom:r.period_from,periodTo:r.period_to,granularity:r.granularity,medium:r.medium,region:r.region||'unverified',paidOrganic:r.paid_organic||'unknown',aggregation:r.aggregation,values:[],unknown:0};if(r.value_number==null&&r.value_text==null)g.unknown++;else g.values.push(r.value_number??r.value_text);}
    for(const g of Object.values(groups)){g.knownSubtotal=g.aggregation==='sum'&&g.values.every(v=>typeof v==='number')?g.values.reduce((a,b)=>a+b,0):null;g.result=g.unknown?null:g.aggregation==='sum'?g.knownSubtotal:g.aggregation==='latest'?g.values.at(-1)??null:null;}
    let salesReference=[];
    if(i.role!=='production'){
      const financePids=(await permittedProjects(db,i,true)).map(p=>p.id);
      const source=await db.all(`SELECT s.id,s.work_id,s.project_id,s.sales_period_from,s.sales_period_to,s.amount_ex_tax,s.partner_id,p.name AS partner,p.region,pr.channel FROM sale_lines s LEFT JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id LEFT JOIN products pr ON pr.org_id=s.org_id AND pr.id=s.product_id WHERE s.org_id=? AND (s.report_id IS NULL OR r.status='active')`,[i.org_id]);
      salesReference=source.filter(r=>financePids.includes(r.project_id)&&(!workId||r.work_id===workId)).map(r=>({...r,grain:r.sales_period_from===r.sales_period_to?'day':'period',regionMeaning:'取引先の登録地域。観客所在地ではありません'}));
    }
    return c.json({ok:true,groups:Object.values(groups),rows,salesReference,salesNote:'同じ作品の売上を販売期間別に参照します。観測期間との重なりを確認し、宣伝による売上とは確定せず、期間の一部だけを日割りしません。',note:'比較は関連の観測です。因果・施策別売上を確定しません。地域・媒体・広告自然・期間・単位を分け、未取得はゼロにしません。'});
  });

  app.post('/api/proposals/suggest', async c => {
    const i=c.get('identity'),input=await body(c),request=String(input.request||'').trim();if(!request)return bad(c,'依頼文が必要です');
    const type=/率|割合|％|%/.test(request)?'decimal':/数|回|件|人/.test(request)?'integer':'text',unit=type==='decimal'?'%':type==='integer'?'回':null,aggregation=type==='integer'?'sum':'none';
    const key=`custom_${(await sha256(request)).slice(0,10)}`;return saveProposal(c,i,{request,fieldKey:key,label:request.slice(0,24),valueType:type,unit,aggregation,sampleHeader:key,meaningReason:'依頼文から決定規則で作った候補。実AI出力ではありません。',affectedApps:['publicity-form','csv-import','analytics'],source:'offline-rule'});
  });
  app.post('/api/proposals/ai',async c=>{
    const i=c.get('identity'),input=await body(c),request=String(input.request||'').trim();
    if(!request||request.length>2000)return bad(c,'依頼は1〜2000文字です');
    if(!ai.enabled||typeof ai.suggest!=='function'||!Number.isInteger(ai.maxCalls)||ai.maxCalls<1||!ai.modelAllowlist?.includes(ai.model))return bad(c,'実AI接続は無効、またはモデル・利用枠が未設定です',503);
    await db.batch([
      {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE COALESCE((SELECT calls FROM ai_usage WHERE org_id=?),0)>=?',params:[i.org_id,ai.maxCalls]},
      {sql:'INSERT INTO ai_usage(org_id,calls) VALUES(?,1) ON CONFLICT(org_id) DO UPDATE SET calls=ai_usage.calls+1',params:[i.org_id]}
    ]);
    let output=await ai.suggest(request);if(output instanceof Response){if(!output.ok)throw Error('AI接続先が失敗しました');output=await output.json();}
    output=output?.response??output;if(typeof output==='string')output=JSON.parse(output);
    if(!output||typeof output!=='object'||JSON.stringify(output).length>12000)return bad(c,'AI出力を検証できません',422);
    return saveProposal(c,i,{request,fieldKey:output.fieldKey,label:output.label,valueType:output.valueType,unit:output.unit??null,aggregation:output.aggregation,sampleHeader:output.sampleHeader,meaningReason:output.meaningReason,affectedApps:output.affectedApps,source:ai.status?.().provider||'workers-ai'});
  });
  app.post('/api/proposals/import', async c => {const i=c.get('identity'),x=await body(c);return saveProposal(c,i,{request:String(x.request||'AI JSON貼付'),fieldKey:x.fieldKey,label:x.label,valueType:x.valueType,unit:x.unit??null,aggregation:x.aggregation,sampleHeader:x.sampleHeader||x.fieldKey,meaningReason:x.meaningReason,affectedApps:x.affectedApps,source:'ai-json'});});
  async function saveProposal(c,i,x){if(typeof x.label!=='string'||!x.label.trim()||x.label.length>100||typeof x.meaningReason!=='string'||!x.meaningReason.trim()||x.meaningReason.length>2000||typeof x.sampleHeader!=='string'||x.sampleHeader.length>100||x.unit!=null&&(typeof x.unit!=='string'||x.unit.length>40))return bad(c,'項目名・単位・理由・報告書見出しを確認してください');if(!Array.isArray(x.affectedApps)||!x.affectedApps.length||x.affectedApps.some(a=>!['publicity-form','csv-import','analytics'].includes(a)))return bad(c,'影響先が許可された範囲ではありません');if(['text','boolean'].includes(x.valueType)&&!['none','latest'].includes(x.aggregation))return bad(c,'文字・真偽値は合算しません');if(await db.get('SELECT 1 FROM metric_definitions WHERE org_id=? AND (field_key=? OR label=?)',[i.org_id,x.fieldKey,x.label]))return bad(c,'既存の項目を利用してください',409);if(!validKey(x.fieldKey)||!['integer','decimal','text','boolean'].includes(x.valueType)||!['sum','average','latest','none'].includes(x.aggregation)||!Array.isArray(x.affectedApps)||!x.meaningReason)return bad(c,'提案JSONの型・キー・理由を確認してください');if(x.valueType==='decimal'&&x.aggregation==='sum')return bad(c,'率・小数の単純合算は採用候補にできません');const base=(await db.get('SELECT version FROM schema_meta WHERE org_id=?',[i.org_id])).version,payload={...x,baseSchemaVersion:base},hash=await sha256(canonical(payload));const out=await db.get(`INSERT INTO change_proposals(org_id,requested_by,request_text,field_key,label,value_type,unit,aggregation,sample_header,meaning_reason,affected_apps_json,base_schema_version,proposal_hash,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,[i.org_id,i.user_id,x.request,x.fieldKey,x.label,x.valueType,x.unit,x.aggregation,x.sampleHeader,x.meaningReason,json(x.affectedApps),base,hash,x.source]);return c.json({ok:true,id:out.id,hash,source:x.source,actualAiUsed:['workers-ai','service'].includes(x.source)},201);}
  app.get('/api/proposals',async c=>{const i=c.get('identity');return c.json({ok:true,rows:await db.all('SELECT * FROM change_proposals WHERE org_id=? ORDER BY id DESC',[i.org_id]),ai:{enabled:ai.enabled===true,verified:false}});});
  app.post('/api/proposals/:id/:decision',async c=>{const i=c.get('identity');if(i.role!=='admin')return bad(c,'採否は管理者だけが行えます',403);const id=integer(c.req.param('id')),decision=c.req.param('decision');if(!['adopt','reject'].includes(decision))return bad(c,'判断が不明です',404);const p=await db.get('SELECT * FROM change_proposals WHERE org_id=? AND id=?',[i.org_id,id]);if(!p)return bad(c,'提案がありません',404);const seen=await body(c);if((seen.hash||seen.proposalHash)!==p.proposal_hash||Number(seen.baseSchemaVersion)!==p.base_schema_version)return bad(c,'確認した提案版と一致しません',409);const persisted={request:p.request_text,fieldKey:p.field_key,label:p.label,valueType:p.value_type,unit:p.unit,aggregation:p.aggregation,sampleHeader:p.sample_header,meaningReason:p.meaning_reason,affectedApps:JSON.parse(p.affected_apps_json),source:p.source,baseSchemaVersion:p.base_schema_version};if(await sha256(canonical(persisted))!==p.proposal_hash)return bad(c,'提案の内容が保存した版から変わっています',409);if(decision==='reject'){const out=await db.run("UPDATE change_proposals SET status='rejected',decided_at=?,decided_by=? WHERE org_id=? AND id=? AND status='pending'",[nowIso(),i.user_id,i.org_id,id]);if(!out.changes)return bad(c,'提案は既に判断済みです',409);return c.json({ok:true,status:'rejected'});}await db.batch([
    {sql:'INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM schema_meta WHERE org_id=? AND version=?)',params:[i.org_id,p.base_schema_version]},
    {sql:"INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM change_proposals WHERE org_id=? AND id=? AND proposal_hash=? AND status='pending')",params:[i.org_id,id,p.proposal_hash]},
    {sql:'INSERT INTO metric_definitions(org_id,field_key,label,value_type,unit,aggregation) VALUES(?,?,?,?,?,?)',params:[i.org_id,p.field_key,p.label,p.value_type,p.unit,p.aggregation]},
    {sql:"UPDATE change_proposals SET status='adopted',decided_at=?,decided_by=? WHERE org_id=? AND id=? AND proposal_hash=? AND status='pending'",params:[nowIso(),i.user_id,i.org_id,id,p.proposal_hash]},
    {sql:'UPDATE schema_meta SET version=version+1 WHERE org_id=? AND version=?',params:[i.org_id,p.base_schema_version]},
    {sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,version_hash,detail_json) VALUES(?,?,?,?,?,?,?)',params:[i.org_id,i.user_id,'adopt','metric_definition',p.field_key,p.proposal_hash,json({proposalId:id,base:p.base_schema_version})]}
  ]);return c.json({ok:true,status:'adopted',schemaVersion:p.base_schema_version+1});});

  registerErRoutes(app, {db});

  app.get('/api/team',async c=>{const i=c.get('identity');if(i.role!=='admin')return bad(c,'管理者だけが参照できます',403);return c.json({ok:true,members:await db.all(`SELECT u.email,u.display_name,m.role,m.active,m.expires_at,pm.project_id,pm.permission,pm.expires_at AS project_expires_at FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN project_memberships pm ON pm.org_id=m.org_id AND pm.user_id=m.user_id WHERE m.org_id=? ORDER BY u.email`,[i.org_id]),invitations:await db.all('SELECT * FROM invitations WHERE org_id=? ORDER BY id DESC',[i.org_id])});});
  app.post('/api/team/invitations',async c=>{const i=c.get('identity');if(i.role!=='admin')return bad(c,'管理者だけが招待準備できます',403);const x=await body(c),email=String(x.email||'').trim().toLowerCase(),projectId=integer(x.projectId),role=String(x.role||''),expiresAt=String(x.expiresAt||'');if(!/^[a-z0-9._+-]+@[a-z0-9.-]+\.invalid$/.test(email))return bad(c,'試作では.invalidの架空メールだけを使用します');if(!['editor','production'].includes(role)||!Number.isFinite(Date.parse(expiresAt))||!activeAt(expiresAt)||!await canProject(db,i,projectId))return bad(c,'案件・役割・有効期限を確認してください');const out=await db.get('INSERT INTO invitations(org_id,email,project_id,role,expires_at,created_by) VALUES(?,?,?,?,?,?) RETURNING id',[i.org_id,email,projectId,role,new Date(expiresAt).toISOString(),i.user_id]);return c.json({ok:true,id:out.id,externalSend:false},201);});
  app.post('/api/team/invitations/:id/accept',async c=>{const i=c.get('identity');if(i.role!=='admin')return bad(c,'管理者だけがローカル参加を確定できます',403);const inv=await db.get("SELECT * FROM invitations WHERE org_id=? AND id=? AND status='pending'",[i.org_id,integer(c.req.param('id'))]);if(!inv||!activeAt(inv.expires_at))return bad(c,'招待がないか期限切れです',409);let user=await db.get('SELECT id FROM users WHERE email=?',[inv.email]);if(user){const existingMembership=await db.get('SELECT role FROM memberships WHERE org_id=? AND user_id=?',[i.org_id,user.id]);if(existingMembership&&existingMembership.role!==inv.role)return bad(c,'既存メンバーの役割変更は別操作です',409);}if(!user){user=await db.get('INSERT INTO users(email,display_name) VALUES(?,?) RETURNING id',[inv.email,inv.email.split('@')[0]]);}await db.batch([{sql:"INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM invitations WHERE org_id=? AND id=? AND status='pending' AND expires_at>?)",params:[i.org_id,inv.id,nowIso()]},{sql:'INSERT INTO memberships(org_id,user_id,role,active,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(org_id,user_id) DO UPDATE SET role=excluded.role,active=1,expires_at=excluded.expires_at',params:[i.org_id,user.id,inv.role,1,inv.expires_at]},{sql:'INSERT INTO project_memberships(org_id,project_id,user_id,permission,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(org_id,project_id,user_id) DO UPDATE SET permission=excluded.permission,expires_at=excluded.expires_at',params:[i.org_id,inv.project_id,user.id,inv.role==='editor'?'edit':'production',inv.expires_at]},{sql:"UPDATE invitations SET status='accepted' WHERE org_id=? AND id=? AND status='pending'",params:[i.org_id,inv.id]}]);return c.json({ok:true,email:inv.email,externalSend:false});});
  app.post('/api/team/invitations/:id/revoke',async c=>{
    const i=c.get('identity');if(i.role!=='admin')return bad(c,'管理者だけが取消できます',403);
    const inv=await db.get('SELECT * FROM invitations WHERE org_id=? AND id=?',[i.org_id,integer(c.req.param('id'))]);if(!inv)return bad(c,'招待がありません',404);
    const statements=[{sql:"UPDATE invitations SET status='revoked' WHERE org_id=? AND id=?",params:[i.org_id,inv.id]}];
    if(inv.status==='accepted')statements.push({sql:"DELETE FROM project_memberships WHERE org_id=? AND project_id=? AND user_id=(SELECT id FROM users WHERE email=?) AND user_id NOT IN(SELECT user_id FROM memberships WHERE org_id=? AND role='admin')",params:[i.org_id,inv.project_id,inv.email,i.org_id]});
    statements.push({sql:'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',params:[i.org_id,i.user_id,'revoke','invitation',String(inv.id),json({projectId:inv.project_id})]});await db.batch(statements);return c.json({ok:true});
  });

  // 追加のルートモジュールと試験が使う内部の道具（createApp の外から register* に渡す）
  app.ux={db,bad,body,mode,sha256,nowIso,canonical,permittedProjects,permittedProjectScope,canProject,settlementWork,allocatedSaleParts,settlementPreviewData,commitImport,extractDocument};
  registerSalesImportRoutes(app,app.ux);
  registerSalesPipelineRoutes(app,app.ux);
  registerWorkPnlRoutes(app,app.ux);
  registerReportIssuanceRoutes(app,app.ux);
  registerDashboardRoutes(app,app.ux);
  registerProgressRoutes(app,app.ux);
  registerRoyaltyRoutes(app,app.ux);
  registerCommitteeMonthlyRoutes(app,app.ux);
  registerSalesSourceRoutes(app,app.ux);
  registerSalesSheetRoutes(app,app.ux);
  registerPlBsRoutes(app,app.ux);
  return app;
}






