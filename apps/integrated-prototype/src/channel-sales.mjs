// Canonical CSV column values only. No rate, rounding or recognition calculation occurs here.
const detailFields = {
  theatrical: ['ticket_type_code','purchase_channel','admissions_count','gross_box_office_ex_tax','reported_actual_ex_tax','reported_recognized_ex_tax','calculated_actual_ex_tax'],
  package: ['turns_count','average_rental_price_ex_tax','holder_unit_price_ex_tax','reported_actual_ex_tax','reported_recognized_ex_tax','calculated_actual_ex_tax'],
  digital: ['service_code','sales_count','view_count','view_seconds','unit_price_ex_tax','holder_unit_price_ex_tax','contract_amount_ex_tax','contract_period_from','contract_period_to','reported_actual_ex_tax','reported_recognized_ex_tax','calculated_actual_ex_tax']
};
const models = {
  theatrical: ['theatrical_rs','theatrical_flat','non_theatrical_rs','non_theatrical_flat'],
  package: ['rental','sell_through','license'],
  digital: ['est','tvod','svod','avod','flat','mg']
};
const modelKeys = { theatrical:'theatrical_model', package:'package_model', digital:'digital_model' };
const counts = new Set(['admissions_count','turns_count','sales_count','view_count','view_seconds','delivered_count','active_count','inventory_count','returned_count']);
const amounts = new Set(['gross_box_office_ex_tax','average_rental_price_ex_tax','holder_unit_price_ex_tax','unit_price_ex_tax','contract_amount_ex_tax','reported_actual_ex_tax','reported_recognized_ex_tax','calculated_actual_ex_tax']);
const observationFields = [['delivered_count','delivered'],['active_count','active'],['inventory_count','inventory'],['returned_count','returned']];
export const channelSalesColumns = [...new Set([
  ...Object.values(modelKeys), ...Object.values(detailFields).flat(),
  ...observationFields.map(([key])=>key), 'observation_unit','observation_scope','observation_basis','inventory_as_of'
])];
export const channelSalesGroups={
  theatrical:[modelKeys.theatrical,...detailFields.theatrical],
  package:[modelKeys.package,...detailFields.package,...observationFields.map(([key])=>key),'observation_unit','observation_scope','observation_basis','inventory_as_of'],
  digital:[modelKeys.digital,...detailFields.digital]
};

function optional(row,key) {
  const value=row[key];
  if(value===undefined || value===null || String(value).trim()==='') return null;
  return String(value).trim();
}
function date(value,key) {
  if(value===null) return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value) throw new Error(`${key} must be YYYY-MM-DD`);
  return value;
}
function field(row,key) {
  const value=optional(row,key);
  if(value===null) return null;
  if(counts.has(key) && (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error(`${key} must be a safe nonnegative integer`);
  if(amounts.has(key) && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`${key} must be a decimal`);
  if(key.endsWith('_from') || key.endsWith('_to') || key==='inventory_as_of') return date(value,key);
  if(value.length>200) throw new Error(`${key} is too long`);
  return value;
}

/** Returns {kind, detail|null, observations:[]} from canonical snake_case CSV values. */
export function parseChannelSalesDetail(kind,row) {
  if(!Object.hasOwn(detailFields,kind)) throw new Error(`unsupported channel kind: ${kind}`);
  if(!row || typeof row!=='object' || Array.isArray(row)) throw new Error('row must be an object');
  const ownModel=optional(row,modelKeys[kind]);
  for(const [other,key] of Object.entries(modelKeys)) if(other!==kind && optional(row,key)!==null) throw new Error(`${key} is invalid for ${kind}`);
  for(const [other,keys] of Object.entries(detailFields)) if(other!==kind)
    for(const key of keys) if(!detailFields[kind].includes(key) && optional(row,key)!==null) throw new Error(`${key} is invalid for ${kind}`);
  const detail={};
  for(const key of detailFields[kind]) detail[key]=field(row,key);
  const hasDetail=ownModel!==null || Object.values(detail).some(value=>value!==null);
  if(hasDetail && !models[kind].includes(ownModel)) throw new Error(`${modelKeys[kind]} is required and must be a recognized model`);
  if(kind==='theatrical' && detail.admissions_count!==null && detail.ticket_type_code===null) throw new Error('ticket_type_code is required with admissions_count');
  if(kind==='digital' && hasDetail) {
    if(detail.service_code===null) throw new Error('service_code is required for digital detail');
    if(['est','tvod'].includes(ownModel) && (detail.view_count!==null || detail.view_seconds!==null || detail.contract_amount_ex_tax!==null)) throw new Error('EST/TVOD cannot carry view or contract metrics');
    if(detail.unit_price_ex_tax!==null && detail.sales_count===null) throw new Error('sales_count is required with unit_price_ex_tax');
    if(['svod','avod'].includes(ownModel) && (detail.sales_count!==null || detail.unit_price_ex_tax!==null || detail.contract_amount_ex_tax!==null)) throw new Error('SVOD/AVOD cannot carry sale count, unit price or contract amount');
    if(['flat','mg'].includes(ownModel) && ['sales_count','view_count','view_seconds','unit_price_ex_tax'].some(key=>detail[key]!==null)) throw new Error('FLAT/MG cannot carry use metrics');
    if(ownModel!=='flat' && ['contract_amount_ex_tax','contract_period_from','contract_period_to'].some(key=>detail[key]!==null)) throw new Error('contract fields require FLAT');
    if(ownModel==='flat' && ['contract_amount_ex_tax','contract_period_from','contract_period_to'].some(key=>detail[key]!==null) && ['contract_amount_ex_tax','contract_period_from','contract_period_to'].some(key=>detail[key]===null)) throw new Error('FLAT contract amount and both period dates must be supplied together');
    if(detail.contract_period_from!==null && detail.contract_period_to<detail.contract_period_from) throw new Error('contract period is reversed');
  }
  if(kind==='package' && hasDetail && ownModel!=='rental' && (detail.turns_count!==null || detail.average_rental_price_ex_tax!==null)) throw new Error('turns and rental price require rental model');
  if(kind==='package' && detail.average_rental_price_ex_tax!==null && detail.turns_count===null) throw new Error('turns_count is required with average_rental_price_ex_tax');
  const observations=[];
  const present=observationFields.filter(([key])=>optional(row,key)!==null);
  const observationMetadata=['observation_unit','observation_scope','observation_basis','inventory_as_of'];
  if(kind!=='package' && (present.length||observationMetadata.some(key=>optional(row,key)!==null))) throw new Error('package observations require package report');
  if(kind==='package' && !present.length && observationMetadata.some(key=>optional(row,key)!==null)) throw new Error('observation metadata requires an observation count');
  if(kind==='package' && !present.some(([,metric])=>metric==='inventory') && optional(row,'inventory_as_of')!==null) throw new Error('inventory_as_of requires inventory_count');
  if(present.length) {
    const unit=field(row,'observation_unit'), scope=field(row,'observation_scope'), basis=field(row,'observation_basis');
    if(!unit || !scope || !basis) throw new Error('observation_unit, observation_scope and observation_basis are required');
    const observedOn=field(row,'inventory_as_of');
    for(const [key,metric] of present) {
      if(metric==='inventory' && !observedOn) throw new Error('inventory_as_of is required with inventory_count');
      observations.push({metric,count:field(row,key),unit,scope,basis,observed_on:metric==='inventory'?observedOn:null});
    }
  }
  return {kind,detail:hasDetail?{model:ownModel,...detail}:null,observations};
}

/** Append these statements after report_imports and sale_lines INSERTs in the same atomic db.batch. */
export function buildChannelSalesStatements({orgId,reportKey,contentHash,sourceRow,parsed,productId=null}) {
  if(!Number.isSafeInteger(orgId) || orgId<=0 || !Number.isSafeInteger(sourceRow) || sourceRow<=0 || !reportKey || !contentHash) throw new Error('valid orgId, reportKey, contentHash and sourceRow are required');
  if(productId!==null&&(!Number.isSafeInteger(productId)||productId<=0))throw new Error('productId must be a positive safe integer or null');
  if(!parsed || !Object.hasOwn(detailFields,parsed.kind)) throw new Error('parsed channel detail is required');
  const statements=[];
  const reportLookup='(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?)';
  if(parsed.detail) {
    const table={theatrical:'theatrical_sale_details',package:'package_sale_details',digital:'digital_sale_details'}[parsed.kind];
    const fields=['model',...detailFields[parsed.kind]];
    const saleLookup=`(SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=? AND r.report_key=? AND r.content_hash=? AND s.source_row=?)`;
    statements.push({sql:`INSERT INTO ${table}(org_id,sale_id,${fields.join(',')}) VALUES(?,${saleLookup},${fields.map(()=>'?').join(',')})`,params:[orgId,orgId,reportKey,contentHash,sourceRow,...fields.map(key=>parsed.detail[key]) ]});
  }
  for(const observation of parsed.observations){
    statements.push({sql:`INSERT INTO package_report_observations(org_id,report_id,source_row,metric,count,unit,scope,basis,observed_on) VALUES(?,${reportLookup},?,?,?,?,?,?,?)`,params:[orgId,orgId,reportKey,contentHash,sourceRow,observation.metric,observation.count,observation.unit,observation.scope,observation.basis,observation.observed_on]});
    if(productId!==null)statements.push({sql:`INSERT INTO package_observation_products(org_id,report_id,source_row,metric,product_id) VALUES(?,${reportLookup},?,?,?)`,params:[orgId,orgId,reportKey,contentHash,sourceRow,observation.metric,productId]});
  }
  return statements;
}
