const controlMetrics = [
  ['rowCount','row_count'],
  ['amountExTax','amount_ex_tax'],
  ['taxAmount','tax_amount'],
  ['amountIncTax','amount_inc_tax']
];
const allowedKinds = new Set(['theatrical','digital','package','broadcast','other']);
const maximum = BigInt(Number.MAX_SAFE_INTEGER);

function sourceObject(value,label) {
  if(value===null || typeof value!=='object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function explicitInteger(value,label,{nonnegative=false}={}) {
  if(typeof value!=='string' && typeof value!=='number' && typeof value!=='bigint') throw new TypeError(`${label} must be an integer`);
  if(typeof value==='number' && !Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
  const input=String(value).trim();
  if(!/^-?(?:0|[1-9]\d*)$/.test(input) && !/^-?[1-9]\d{0,2}(?:,\d{3})+$/.test(input)) throw new TypeError(`${label} must be an integer`);
  const parsed=BigInt(input.replaceAll(',',''));
  if(parsed>maximum || parsed< -maximum) throw new RangeError(`${label} must be a safe integer`);
  if(nonnegative && parsed<0n) throw new RangeError(`${label} must be nonnegative`);
  return Number(parsed);
}

function collectControls(sourceTotals,kind) {
  const source=sourceObject(sourceTotals,'sourceTotals');
  const accepted=new Set([...controlMetrics.map(([key])=>key),'byChannel']);
  for(const key of Object.keys(source)) if(!accepted.has(key)) throw new TypeError(`unsupported source control: ${key}`);
  const recorded=[];
  const unverified=[];
  const collect=(controls,scopeKind,channel)=>{
    for(const key of Object.keys(controls)) if(!controlMetrics.some(([name])=>name===key)) throw new TypeError(`unsupported ${scopeKind} source control: ${key}`);
    for(const [inputKey,metric] of controlMetrics){
      const label=`${scopeKind}${channel?`.${channel}`:''}.${inputKey}`;
      if(!Object.hasOwn(controls,inputKey)) { unverified.push(label); continue; }
      recorded.push({scopeKind,channel,metric,expectedValue:explicitInteger(controls[inputKey],label,{nonnegative:metric==='row_count'})});
    }
  };
  const {byChannel,...report}=source;
  collect(report,'report','');
  if(byChannel===undefined){
    for(const [inputKey] of controlMetrics) unverified.push(`channel.${kind}.${inputKey}`);
  }else{
    const byKind=sourceObject(byChannel,'byChannel');
    for(const entryKind of Object.keys(byKind)) if(entryKind!==kind) throw new TypeError(`channel control ${entryKind} does not match report kind ${kind}`);
    if(!Object.hasOwn(byKind,kind)){
      for(const [inputKey] of controlMetrics) unverified.push(`channel.${kind}.${inputKey}`);
    }else collect(sourceObject(byKind[kind],`byChannel.${kind}`),'channel',kind);
  }
  return {recorded,unverified};
}

// Run after every sale and package observation INSERT in the same atomic batch.
// This guard intentionally compares only recorded controls. The other metrics have
// no stored "zero" value and remain unverified.
const reconciliationGuard = `INSERT INTO transaction_guards(value)
SELECT 0 WHERE EXISTS (
  SELECT 1
  FROM report_source_controls c
  JOIN report_imports r ON r.org_id=c.org_id AND r.id=c.report_id
  WHERE c.org_id=? AND r.report_key=? AND r.content_hash=?
    AND c.expected_value <> CASE c.metric
      WHEN 'row_count' THEN
        (SELECT COUNT(*) FROM sale_lines s WHERE s.org_id=c.org_id AND s.report_id=c.report_id)
        + (SELECT COUNT(DISTINCT o.source_row) FROM package_report_observations o
           WHERE o.org_id=c.org_id AND o.report_id=c.report_id
             AND NOT EXISTS (SELECT 1 FROM sale_lines s
               WHERE s.org_id=o.org_id AND s.report_id=o.report_id AND s.source_row=o.source_row))
      WHEN 'amount_ex_tax' THEN
        (SELECT COALESCE(SUM(s.amount_ex_tax),0) FROM sale_lines s WHERE s.org_id=c.org_id AND s.report_id=c.report_id)
      WHEN 'tax_amount' THEN
        (SELECT COALESCE(SUM(s.tax_amount),0) FROM sale_lines s WHERE s.org_id=c.org_id AND s.report_id=c.report_id)
      WHEN 'amount_inc_tax' THEN
        (SELECT COALESCE(SUM(s.amount_inc_tax),0) FROM sale_lines s WHERE s.org_id=c.org_id AND s.report_id=c.report_id)
    END
)`;

/**
 * Add the returned statements after report_imports, sale_lines and package report
 * observations in one db.batch. Each supplied value is persisted as an immutable
 * source fact; missing values are returned as unverified and never inferred.
 */
export function buildReportSourceControlStatements({orgId,reportKey,contentHash,sourceTotals={},kind}) {
  if(!Number.isSafeInteger(orgId) || orgId<=0) throw new TypeError('orgId must be a positive safe integer');
  if(typeof reportKey!=='string' || !reportKey.trim() || typeof contentHash!=='string' || !contentHash.trim()) throw new TypeError('reportKey and contentHash are required');
  if(!allowedKinds.has(kind)) throw new TypeError(`unsupported report kind: ${kind}`);
  const {recorded,unverified}=collectControls(sourceTotals,kind);
  const reportId='(SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND content_hash=?)';
  const statements=recorded.map(control=>({
    sql:`INSERT INTO report_source_controls(org_id,report_id,scope_kind,channel,metric,expected_value) VALUES(?,${reportId},?,?,?,?)`,
    params:[orgId,orgId,reportKey,contentHash,control.scopeKind,control.channel,control.metric,control.expectedValue]
  }));
  if(recorded.length) statements.push({sql:reconciliationGuard,params:[orgId,reportKey,contentHash]});
  return {statements,recorded,unverified};
}
