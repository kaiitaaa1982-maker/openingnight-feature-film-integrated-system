import {calculateJointPeriods,jointCalculationVersion,jointExportColumns,jointExportRows} from './committee-joint.mjs';
import {toCsv,integer} from './csv.mjs';

export async function loadJointContract(db,orgId,contractId){
  const row=await db.get('SELECT c.*,w.title AS work_title FROM joint_committee_contracts c JOIN works w ON w.org_id=c.org_id AND w.id=c.work_id WHERE c.org_id=? AND c.id=?',[orgId,contractId]);
  if(!row)return null;
  const [members,windows,periods,sales,costs,milestones,fundingEvents,holidays]=await Promise.all([
    db.all('SELECT m.*,p.name AS partner_name FROM joint_committee_members m JOIN partners p ON p.org_id=m.org_id AND p.id=m.partner_id WHERE m.org_id=? AND m.contract_id=? ORDER BY m.partner_id',[orgId,contractId]),
    db.all('SELECT w.*,p.name AS partner_name FROM joint_committee_windows w JOIN partners p ON p.org_id=w.org_id AND p.id=w.partner_id WHERE w.org_id=? AND w.contract_id=? ORDER BY w.id',[orgId,contractId]),
    db.all('SELECT * FROM joint_committee_periods WHERE org_id=? AND contract_id=? ORDER BY sequence',[orgId,contractId]),
    db.all('SELECT * FROM joint_committee_sales WHERE org_id=? AND contract_id=? ORDER BY period_sequence,id',[orgId,contractId]),
    db.all('SELECT * FROM joint_committee_costs WHERE org_id=? AND contract_id=? ORDER BY period_sequence,id',[orgId,contractId]),
    db.all('SELECT * FROM joint_production_milestones WHERE org_id=? AND contract_id=? ORDER BY id',[orgId,contractId]),
    db.all('SELECT * FROM joint_funding_events WHERE org_id=? AND contract_id=? ORDER BY id',[orgId,contractId]),
    db.all('SELECT holiday_on,label FROM joint_business_holidays WHERE org_id=? AND contract_id=? ORDER BY holiday_on',[orgId,contractId])
  ]);
  return {row,members,windows,periods,sales,costs,milestones,fundingEvents,holidays};
}
export function jointCalculationInput(data){
  const c=data.row;
  const total=rows=>rows.reduce((n,r)=>n+BigInt(r),0n);
  if(total(data.members.map(m=>m.contribution_inc_tax_yen))!==BigInt(c.production_cost_inc_tax_yen)+BigInt(c.pa_inc_tax_yen))throw Error('出資額と税込製作費・P&Aの合計が一致しません');
  if(total(data.milestones.map(m=>m.amount_inc_tax_yen))!==BigInt(c.production_cost_inc_tax_yen))throw Error('制作支払条件の合計が税込直接製作費と一致しません');
  if(data.milestones.some(m=>m.producer_partner_id!==c.producer_partner_id))throw Error('制作支払先が受託制作会社と一致しません');
  for(const member of data.members){if(total(data.fundingEvents.filter(e=>e.partner_id===member.partner_id).map(e=>e.amount_inc_tax_yen))>BigInt(member.contribution_inc_tax_yen))throw Error('出資充当が出資予定額を超えています')}
  return {contract:{managerPartnerId:c.manager_partner_id,producerPartnerId:c.producer_partner_id,productionCostIncTaxYen:c.production_cost_inc_tax_yen,paIncTaxYen:c.pa_inc_tax_yen,managerFeeBps:c.manager_fee_bps,incomeThresholdYen:c.income_threshold_yen,transferThresholdYen:c.transfer_threshold_yen,investorReportOffsetMonths:c.investor_report_offset_months,investorReportDay:c.investor_report_day==='eom'?'eom':Number(c.investor_report_day),investorPaymentOffsetMonths:c.investor_payment_offset_months,investorPaymentDay:c.investor_payment_day==='eom'?'eom':Number(c.investor_payment_day)},
    members:data.members.map(r=>({partnerId:r.partner_id,role:r.role,shareBps:r.share_bps})),
    windows:data.windows.map(r=>({id:r.id,label:r.label,partnerId:r.partner_id,feeBps:r.fee_bps,reportOffsetMonths:r.report_offset_months,reportDay:r.report_day==='eom'?'eom':Number(r.report_day),paymentOffsetMonths:r.payment_offset_months,paymentDay:r.payment_day==='eom'?'eom':Number(r.payment_day)})),
    periods:data.periods.map(r=>({sequence:r.sequence,from:r.from_on,to:r.to_on})),
    receipts:data.sales.map(r=>({windowId:r.window_id,periodSequence:r.period_sequence,sourceRef:r.source_ref,amountYen:r.amount_contract_yen,grossIncTaxYen:r.gross_inc_tax_yen,managerReceiptOn:r.manager_receipt_on})),
    costs:data.costs.map(r=>({windowId:r.window_id,periodSequence:r.period_sequence,sourceRef:r.source_ref,kind:r.kind,amountYen:r.amount_yen,taxBasis:r.tax_basis})),holidays:data.holidays.map(r=>r.holiday_on)};
}
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
export function registerJointCommitteeRoutes(app,{db,bad,settlementWork}){
  async function scoped(c){
    const i=c.get('identity');let workId;
    try{workId=integer(c.req.query('workId')||'')}catch{return {error:bad(c,'作品IDが必要です')}}
    if(!await settlementWork(i,workId))return {error:bad(c,'作品の財務権限がありません',403)};
    const rows=await db.all('SELECT * FROM joint_committee_contracts WHERE org_id=? AND work_id=? ORDER BY id',[i.org_id,workId]);
    return {identity:i,workId,contracts:rows};
  }
  async function chosen(c){
    const scope=await scoped(c);if(scope.error)return scope;
    let id;try{id=integer(c.req.param('id'))}catch{return {...scope,error:bad(c,'契約IDを確認してください')}}
    const contract=scope.contracts.find(r=>r.id===id);
    if(!contract)return {...scope,error:bad(c,'選択作品の契約がありません',404)};
    return {...scope,contract};
  }
  app.get('/api/committee/joint',async c=>{
    const scope=await scoped(c);if(scope.error)return scope.error;
    return c.json({ok:true,contracts:scope.contracts});
  });
  app.get('/api/committee/joint/:id',async c=>{
    const scope=await chosen(c);if(scope.error)return scope.error;
    const data=await loadJointContract(db,scope.identity.org_id,scope.contract.id);
    const snapshot=await db.get('SELECT * FROM joint_committee_snapshots WHERE org_id=? AND contract_id=? ORDER BY id DESC LIMIT 1',[scope.identity.org_id,scope.contract.id]);
    const saved=snapshot?JSON.parse(snapshot.calculation_json):null;
    return c.json({ok:true,contract:saved&&!Array.isArray(saved)?saved.source:data,snapshot:snapshot?{id:snapshot.id,calculationVersion:snapshot.calculation_version,createdAt:snapshot.created_at,results:Array.isArray(saved)?saved:saved.results}:null});
  });
  app.post('/api/committee/joint/:id/snapshots',async c=>{
    const scope=await chosen(c);if(scope.error)return scope.error;
    if(scope.identity.role!=='admin')return bad(c,'管理者だけが計算版を保存できます',403);
    const data=await loadJointContract(db,scope.identity.org_id,scope.contract.id),input=jointCalculationInput(data);
    let results;try{results=calculateJointPeriods(input)}catch(error){return bad(c,error.message,400,undefined,error)}
    const inputHash=await digest(data),existing=await db.get('SELECT id,calculation_json FROM joint_committee_snapshots WHERE org_id=? AND contract_id=? AND input_hash=?',[scope.identity.org_id,scope.contract.id,inputHash]);
    if(existing){const saved=JSON.parse(existing.calculation_json);return c.json({ok:true,snapshotId:existing.id,reused:true,results:Array.isArray(saved)?saved:saved.results})}
    try{const out=await db.get('INSERT INTO joint_committee_snapshots(org_id,contract_id,calculation_version,input_hash,calculation_json) VALUES(?,?,?,?,?) RETURNING id',[scope.identity.org_id,scope.contract.id,jointCalculationVersion,inputHash,JSON.stringify({source:data,results})]);return c.json({ok:true,snapshotId:out.id,reused:false,results},201)}catch(error){return bad(c,error.message,409,undefined,error)}
  });
  app.get('/api/committee/joint/:id/exports/:name',async c=>{
    const scope=await chosen(c);if(scope.error)return scope.error;
    const name=c.req.param('name');if(!Object.hasOwn(jointExportColumns,name))return bad(c,'帳票種別がありません',404);
    const data=await loadJointContract(db,scope.identity.org_id,scope.contract.id);
    const snapshot=await db.get('SELECT calculation_json FROM joint_committee_snapshots WHERE org_id=? AND contract_id=? ORDER BY id DESC LIMIT 1',[scope.identity.org_id,scope.contract.id]);
    if(!snapshot)return bad(c,'保存済み計算がありません',409);
    const saved=JSON.parse(snapshot.calculation_json),source=Array.isArray(saved)?data:saved.source,results=Array.isArray(saved)?saved:saved.results,names=Object.fromEntries(source.members.map(m=>[m.partner_id,m.partner_name])),rows=jointExportRows(scope.contract.id,results,source.milestones,names)[name];
    if(c.req.query('format')==='csv')return new Response(toCsv(jointExportColumns[name],rows.map(r=>jointExportColumns[name].map(k=>r[k]??''))),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${name}.csv"`,'Cache-Control':'private, no-store'}});
    return c.json({ok:true,calculationVersion:jointCalculationVersion,columns:jointExportColumns[name],rows});
  });
}
