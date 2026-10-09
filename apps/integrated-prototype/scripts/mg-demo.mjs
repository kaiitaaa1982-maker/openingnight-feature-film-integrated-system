import assert from 'node:assert/strict';
import {resolve,basename} from 'node:path';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';

const supplied=process.env.ON_DB_FILE;if(!supplied)throw new Error('ON_DB_FILEで合成デモ専用SQLiteを明示してください');
const file=resolve(supplied);if(basename(file)!=='year-demo.sqlite')throw new Error('MGデモはyear-demo.sqliteにだけ投入できます');
const db=new LocalDatabase(file),app=createApp({db,mode:'local'});
try{
 const auth=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});assert.equal(auth.status,200);const cookie=auth.headers.get('set-cookie').split(';')[0];
 async function req(path,input){const r=await app.request(`/api${path}`,{method:input?'POST':'GET',headers:{cookie,...(input?{'content-type':'application/json'}:{})},body:input?JSON.stringify(input):undefined}),out=await r.json();if(!r.ok||out.ok===false)throw new Error(`${path}: ${out.error}`);return out}
 const baseline=await db.get('SELECT COUNT(*) n,COALESCE(SUM(amount_ex_tax),0) amount FROM sale_lines');
 let supplier=await db.get("SELECT id FROM mg_suppliers WHERE org_id=1 AND code='SUP-DEMO'");if(!supplier){await req('/mg/suppliers',{code:'SUP-DEMO',name:'架空ライツ社',note:'MG方向別台帳の合成デモ'});supplier=await db.get("SELECT id FROM mg_suppliers WHERE org_id=1 AND code='SUP-DEMO'")}
 const phase={startsOn:'2026-10-01',endsOn:'2027-09-30',intervalMonths:3,firstCloseOn:'2026-12-31',reportOffsetMonths:1,reportDay:28,payOffsetMonths:2,payDay:28};
 for(const c of [{direction:'incoming',code:'MG-DEMO-IN',title:'架空配信受取MG',partnerId:2,contractSourceReference:'SYNTH-IN-CONTRACT',mgAmountYen:100000,sourceReference:'SYNTH-IN-TERMS',products:[{productId:1,evaluationYen:70000},{productId:2,evaluationYen:30000}]},{direction:'outgoing',code:'MG-DEMO-OUT',title:'架空権利支払MG',supplierId:supplier.id,contractSourceReference:'SYNTH-OUT-CONTRACT',mgAmountYen:80000,sourceReference:'SYNTH-OUT-TERMS',products:[{productId:1,evaluationYen:55000},{productId:2,evaluationYen:25000}]}]){
  let contract=await db.get(`SELECT id FROM mg_${c.direction}_contracts WHERE org_id=1 AND code=?`,[c.code]);if(!contract){await req('/mg/contracts',{...c,contractDate:'2026-09-20',startsOn:'2026-10-01',endsOn:'2027-09-30',mode:'cross',reason:'方向別MGの合成デモ',phases:[phase]});contract=await db.get(`SELECT id FROM mg_${c.direction}_contracts WHERE org_id=1 AND code=?`,[c.code])}
  const version=await db.get(`SELECT id FROM mg_term_versions WHERE org_id=1 AND ${c.direction}_contract_id=? ORDER BY version DESC LIMIT 1`,[contract.id]),source=`SYNTH-${c.direction.toUpperCase()}-2026-10`;
  if(!await db.get('SELECT id FROM mg_ledger_entries WHERE org_id=1 AND term_version_id=? AND source_reference=?',[version.id,source]))await req('/mg/ledger',{termVersionId:version.id,productId:1,periodFrom:'2026-10-01',periodTo:'2026-10-31',accountingMonth:'2026-11',sourceReference:source,reportedEligibleYen:c.direction==='incoming'?12000:9000,appliedRecoupYen:c.direction==='incoming'?10000:8000,reportedOverageYen:c.direction==='incoming'?2000:1000,recognizedYen:c.direction==='incoming'?9000:7000,status:'unverified'});
 }
 const after=await db.get('SELECT COUNT(*) n,COALESCE(SUM(amount_ex_tax),0) amount FROM sale_lines');assert.deepEqual(after,baseline);assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);console.log(JSON.stringify({ok:true,synthetic:true,salesUnchanged:true,contracts:2}));
}finally{db.close()}
