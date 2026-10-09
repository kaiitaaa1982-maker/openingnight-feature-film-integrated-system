const amount=(value,label)=>{if(!Number.isSafeInteger(value)||value<0)throw Error(`${label}は0以上の整数円で入力してください`);return value};
export function normalizeFunding(input,members){
 if(input==null)return null;
 const productionCostYen=amount(input.productionCostYen,'製作費'),investments=(input.investments||[]).map(row=>({partnerId:Number(row.partnerId),amountYen:amount(row.amountYen,'出資額')}));
 if(investments.length!==members.length||new Set(investments.map(r=>r.partnerId)).size!==members.length||investments.some(r=>!members.some(m=>Number(m.partnerId??m.partner_id)===r.partnerId)))throw Error('出資額は全参加者を1回ずつ明示してください');
 if(investments.reduce((n,r)=>n+BigInt(r.amountYen),0n)!==BigInt(productionCostYen))throw Error('出資額の合計を製作費総額に一致させてください');
 return {productionCostYen,investments};
}
export function normalizeDeductions(input,reports,partners,members,funding,previousRecoupYen=0){
 if(!Array.isArray(input)||input.length>100)throw Error('追加控除は100件以内です');
 const rows=input.map(row=>{
  const report=reports.find(r=>r.reportId===Number(row.reportId));if(!report)throw Error('追加控除は選択済み売上報告に紐付けてください');
  const category=String(row.category),recipientPartnerId=Number(row.recipientPartnerId),sourceReference=String(row.sourceReference||'').trim(),amountYen=amount(row.amountYen,'控除額');
  if(!['royalty','production_recoup'].includes(category)||!amountYen)throw Error('追加控除の区分と正の金額が必要です');
  if(!partners.some(p=>p.id===recipientPartnerId))throw Error('控除の受取先を選択してください');
  if(category==='production_recoup'&&!members.some(m=>Number(m.partnerId??m.partner_id)===recipientPartnerId))throw Error('製作費の回収先は委員会参加者から選択してください');
  if(!sourceReference||sourceReference.length>240)throw Error('控除根拠の識別番号を1〜240文字で入力してください');
  return {reportId:report.reportId,windowId:report.windowId,category,recipientPartnerId,amountYen,sourceReference};
 });
 if(new Set(rows.map(r=>r.sourceReference)).size!==rows.length)throw Error('追加控除の根拠が重複しています');
 const recoup=rows.filter(r=>r.category==='production_recoup').reduce((n,r)=>n+BigInt(r.amountYen),0n);
 if(recoup>0n&&(!funding||BigInt(previousRecoupYen)+recoup>BigInt(funding.productionCostYen)))throw Error('製作費の回収額が明示された回収残高を超えています');
 return rows.sort((a,b)=>a.sourceReference.localeCompare(b.sourceReference));
}
// A saved window is the contractual calculation grain. Monthly report rows keep
// raw income; these allocation columns explain that window total without rerounding it.
function allocateSigned(total,weights){
 const divisor=weights.reduce((n,w)=>n+BigInt(w),0n);if(!divisor)return weights.map((_,i)=>i===0?total:0);
 const parts=weights.map(w=>Number(BigInt(total)*BigInt(w)/divisor));
 if(parts.some(p=>!Number.isSafeInteger(p)))throw Error('経緯表の照合配賦が整数範囲外です');
 parts[0]+=total-parts.reduce((n,p)=>n+p,0);return parts;
}
export function committeeHistory(rows){
 return rows.flatMap(snapshot=>snapshot.calculation.windows.flatMap(window=>{
  const calc=snapshot.calculation,reports=(calc.selectedReports||[]).filter(r=>r.windowId===window.windowId);
  if(!reports.length){
   if(!window.expenseTotal&&!window.distributionPool&&!(calc.selectedExpenses||[]).some(e=>e.windowId===window.windowId))return [];
   const groups=new Map();for(const expense of (calc.selectedExpenses||[]).filter(e=>e.windowId===window.windowId)){
    const month=expense.accountingMonth||null;if(!groups.has(month))groups.set(month,{reportId:null,amount:0,reportBasis:'売上なし・費用のみ',accountingMonth:month,expenseAmount:0,expenseIds:[]});
    const group=groups.get(month);group.expenseAmount+=expense.amount;group.expenseIds.push(expense.expenseId);
   }
   reports.push(...groups.values());
   if(!reports.length)reports.push({reportId:null,amount:0,reportBasis:'売上なし・費用のみ',accountingMonth:null,expenseAmount:window.expenseTotal,expenseIds:[]});
  }
  const platformFees=Number.isInteger(window.platformRateBps)?reports.map(r=>r.reportBasis==='gross'?Number(BigInt(r.amount)*BigInt(window.platformRateBps)/10000n):0):allocateSigned(window.platformFeeKnown||0,reports.map(r=>r.reportBasis==='gross'?r.amount:0));
  const weights=reports.map((r,i)=>r.amount-platformFees[i]),keys=['windowFee','managerFee','expenseTotal'];
  const allocated=Object.fromEntries(keys.map(key=>[key,allocateSigned(window[key]||0,weights)]));
  if(reports.every(r=>r.reportId==null))allocated.expenseTotal=reports.map(r=>r.expenseAmount);
  allocated.platformFeeKnown=platformFees;
  const reportDeductions=reports.map(r=>(calc.deductions||[]).filter(d=>d.reportId===r.reportId));
  allocated.distributionPool=weights.map((net,i)=>net-keys.reduce((n,key)=>n+allocated[key][i],0)-reportDeductions[i].reduce((n,d)=>n+d.amountYen,0));
  const payouts=(window.payouts||[]).map(p=>({partnerId:p.partnerId,amounts:allocateSigned(p.amount,allocated.distributionPool)}));
  allocated.residual=allocated.distributionPool.map((pool,i)=>pool-payouts.reduce((n,p)=>n+p.amounts[i],0));
  return reports.map((r,i)=>({snapshotId:snapshot.id,reportId:r.reportId,accountingMonth:r.accountingMonth,kind:window.kind,label:window.label,windowPartnerId:window.windowPartnerId,reportBasis:r.reportBasis,reportedAmount:r.amount,
   ...Object.fromEntries(Object.keys(allocated).map(key=>[key,allocated[key][i]])),platformNet:weights[i],
   deductions:reportDeductions[i],
   memberDistributions:payouts.map(p=>({partnerId:p.partnerId,amount:p.amounts[i]})),
   saleIds:(calc.lines||[]).filter(l=>l.reportId===r.reportId).map(l=>l.saleId),expenseIds:r.expenseIds||[],
   allocationBasis:r.reportId==null?'売上なし・保存済み費用と返戻の行':reports.length===1?'窓口計算と一致':'窓口の計算額を報告額比で照合配賦（端数は報告順の先頭）'}));
 }));
}
