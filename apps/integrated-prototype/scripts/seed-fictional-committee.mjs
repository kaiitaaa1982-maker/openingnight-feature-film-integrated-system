// 架空の製作委員会（合同会計）のデモを作る。
//   node scripts/seed-fictional-committee.mjs [新しい SQLite のファイル]   … ファイルに作る（既存のファイルは上書きしない）
//   await seedFictionalCommittee(db)                                     … 開いた DB（入口の all・get・run・batch。試験の DB のファクトリの SQLite・PostgreSQL も）に作る
// マスタの書き換えと契約・窓口・売上・費用・出資の行は1つのトランザクション（db.batch）で入れ、独立手計算表と照合してから計算の版を残す。架空のデータだけを使う
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {calculateJointPeriods,jointCalculationVersion} from '../src/committee-joint.mjs';
import {jointCalculationInput,loadJointContract} from '../src/committee-joint-routes.mjs';

export async function seedFictionalCommittee(db){
  const statements=[];
  const add=(sql,...values)=>statements.push({sql,params:values});
  add("UPDATE organizations SET code='FICTIONAL-JOINT',name='架空合同会計デモ組織' WHERE id=1");
  add("UPDATE users SET email='demo-admin@example.invalid',display_name='架空デモ管理者' WHERE id=1");
  add("UPDATE projects SET code='FIC-MONDAY',title='透明な月曜日・架空案件',budget_yen=48000000 WHERE id=1 AND org_id=1");
  add("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,1,1,'edit')");
  add("UPDATE works SET code='FIC-MON-01',title='透明な月曜日 — 架空委員会デモ',forecast_yen=NULL WHERE id=1 AND org_id=1");
  for(const [id,code,name] of [[1,'FIC-A','架空A社'],[2,'FIC-B','架空B社'],[3,'FIC-C','架空C社']])add('UPDATE partners SET code=?,name=?,kind=? WHERE id=? AND org_id=1',code,name,id===3?'vendor':'agency',id);
  add(`INSERT INTO joint_committee_contracts(id,org_id,work_id,code,title,calculation_version,demo_flag,manager_partner_id,producer_partner_id,production_cost_inc_tax_yen,pa_inc_tax_yen,manager_fee_bps,income_threshold_yen,transfer_threshold_yen,investor_report_offset_months,investor_report_day,investor_payment_offset_months,investor_payment_day,terms_note)
    VALUES(1,1,1,'FIC-JOINT-01','「透明な月曜日」架空製作委員会',?,1,1,3,40000000,8000000,250,20000,26000,2,'eom',2,'eom',?)`,jointCalculationVersion,'税込契約額を計算基準とする架空追加合意。通常のMG・製作費優先回収は設定しない。');
  for(const [partner,share,contribution] of [[1,5800,27840000],[2,4200,20160000]])add("INSERT INTO joint_committee_members(org_id,contract_id,partner_id,role,share_bps,contribution_inc_tax_yen) VALUES(1,1,?,'investor',?,?)",partner,share,contribution);
  for(const [id,kind,label,partner,fee] of [[1,'theatrical','国内劇場',1,1900],[2,'non_theatrical','国内非劇場',2,1700],[3,'video','国内ビデオ',1,2300],[4,'digital','国内配信',2,1100]])add("INSERT INTO joint_committee_windows(id,org_id,contract_id,kind,label,partner_id,fee_bps,report_offset_months,report_day,payment_offset_months,payment_day) VALUES(?,1,1,?,?,?, ?,1,'eom',2,'eom')",id,kind,label,partner,fee);
  for(const [sequence,from,to] of [[1,'2032-01-01','2032-04-30'],[2,'2032-05-01','2032-07-31']])add('INSERT INTO joint_committee_periods(org_id,contract_id,sequence,from_on,to_on) VALUES(1,1,?,?,?)',sequence,from,to);
  add("INSERT INTO joint_business_holidays(org_id,contract_id,holiday_on,label) VALUES(1,1,'2032-10-31','架空の金融機関休日')");
  for(const [id,window,period,amount,reported,received] of [[1,2,1,18000,'2032-05-31',null],[2,1,2,1800000,'2032-07-31','2032-07-31'],[3,2,2,360000,'2032-07-31','2032-07-31'],[4,3,2,950000,'2032-07-31','2032-07-31'],[5,4,2,700000,'2032-07-31','2032-07-31']])add('INSERT INTO joint_committee_sales(id,org_id,contract_id,window_id,period_sequence,source_ref,amount_contract_yen,gross_inc_tax_yen,reported_on,manager_receipt_on) VALUES(?,1,1,?,?,?, ?,?,?,?)',id,window,period,`FIC-SALE-${id}`,amount,amount,reported,received);
  for(const [id,period,window,kind,amount] of [[1,1,2,'window_direct',2000],[2,2,1,'window_direct',160000],[3,2,1,'music_window_paid',24000],[4,2,2,'window_direct',40000],[5,2,3,'window_direct',150000],[6,2,3,'music_window_paid',16000],[7,2,4,'window_direct',60000],[8,2,null,'rights_manager',126000],[9,2,null,'master_management',28000]])add("INSERT INTO joint_committee_costs(id,org_id,contract_id,window_id,period_sequence,source_ref,kind,amount_yen,tax_basis,approved) VALUES(?,1,1,?,?,?,?,?,'inc_tax',1)",id,window,period,`FIC-COST-${id}`,kind,amount);
  for(const [id,stage,due,amount,condition,acceptance,paid,paidAmount] of [[1,'schedule_approved','2031-05-30',16000000,'2031-05-28',null,'2031-05-30',16000000],[2,'shooting_complete','2031-07-31',14000000,null,null,null,0],[3,'delivery_accepted','2031-11-28',10000000,null,null,null,0]])add('INSERT INTO joint_production_milestones(id,org_id,contract_id,producer_partner_id,stage,due_on,condition_met_on,acceptance_on,amount_inc_tax_yen,paid_on,paid_inc_tax_yen) VALUES(?,1,1,3,?,?,?,?,?,?,?)',id,stage,due,condition,acceptance,amount,paid,paidAmount);
  for(const [id,partner,kind,source,amount,on,milestone] of [[1,1,'production_payment_credit','FIC-PROD-1',16000000,'2031-05-30',1],[2,1,'cash_contribution','FIC-FUND-A',11840000,'2031-06-30',null],[3,2,'cash_contribution','FIC-FUND-B',20160000,'2031-06-30',null]])add('INSERT INTO joint_funding_events(id,org_id,contract_id,partner_id,kind,source_ref,amount_inc_tax_yen,paid_on,milestone_id) VALUES(?,1,1,?,?,?,?,?,?)',id,partner,kind,source,amount,on,milestone);
  await db.batch(statements);
  const data=await loadJointContract(db,1,1);
  const input=jointCalculationInput(data),results=calculateJointPeriods(input);
  const p1=results[0],p2=results[1];
  if(p1.windows.find(w=>w.windowId===2).carriedYen!==13280||p1.committeeIncomeYen!==0||p2.committeeIncomeYen!==2752880||p2.managerFeeYen!==65672||p2.distributableYen!==2533208||p2.distributions[0].earnedYen!==1469260||p2.distributions[1].earnedYen!==1063947||p2.roundingResidualYen!==1)throw Error('独立手計算表との照合に失敗しました');
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(data))))].map(x=>x.toString(16).padStart(2,'0')).join('');
  await db.run('INSERT INTO joint_committee_snapshots(org_id,contract_id,calculation_version,input_hash,calculation_json) VALUES(1,1,?,?,?)',[jointCalculationVersion,hash,JSON.stringify({source:data,results})]);
  return {workId:1,contractId:1,periods:results.length,p1CarryYen:13280,p2CashYen:p2.committeeIncomeYen,p2DistributionYen:p2.distributableYen};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=resolve(process.argv[2]||'data/fictional-committee.sqlite');
  if(existsSync(file))throw Error('既存DBを上書きしません。新しいパスを指定してください');
  const db=new LocalDatabase(file);
  try{
    const summary=await seedFictionalCommittee(db);
    process.stdout.write(JSON.stringify({database:file,...summary})+'\n');
  }finally{db.close()}
}
