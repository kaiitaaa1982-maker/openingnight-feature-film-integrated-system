import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignKeyViolations, openTestDb } from './test-db.mjs';
import { createApp } from '../src/app.mjs';
import { toCsv } from '../src/csv.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

async function fixture(t){
  const db=await openTestDb({t}),app=createApp({db});
  async function login(email){const r=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
  const admin=await login('admin@openingnight.invalid');
  async function req(path,body,cookie=admin){const r=await app.request('/api'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
  return {db,app,login,req};
}
function good(out){assert.ok(out.status<300&&out.data.ok,JSON.stringify(out));return out.data;}
const expected=JSON.parse(readFileSync(new URL('../../../docs/platform/team-development/intake-mapping-expected.json',import.meta.url),'utf8'));
const rawCsv=()=>toCsv(expected.raw_report.headers,expected.raw_report.rows);
const digest=text=>createHash('sha256').update(text).digest('hex');
function mappingDefinition(){
  const source=(target,source)=>({target,mode:'source',source});
  const literal=(target,value)=>({target,mode:'literal',valueType:typeof value==='number'?'integer':'string',value});
  return {ignoredColumns:[],mappings:[source('report_key','報告番号'),source('period_from','販売開始'),source('period_to','販売終了'),source('report_received_on','受領日'),source('quantity','数量'),source('tax_amount','税額'),source('amount_inc_tax','税込売上'),source('description','摘要'),literal('partner_id',2),literal('product_id',1),literal('recognition_basis_id',2),literal('basis_reason','架空月次報告の受領月で計上'),{target:'amount_ex_tax',mode:'multiply',operands:['数量','単価']}]};
}

test('independent mapped report retains raw evidence and posts exact amounts once across mapping versions',async(t)=>{
  const {db,req,login}=await fixture(t);
  try{
    const profile=good(await req('/mapping-profiles',{partnerId:2,kind:'digital',name:'架空配信CSV'}));
    const version=good(await req(`/mapping-profiles/${profile.profileId}/versions`,mappingDefinition()));
    const text=rawCsv(),input={workId:1,mappingVersionId:version.mappingVersionId,text};
    const preview=good(await req('/mapped-imports/preview',input));
    assert.deepEqual(preview.rows.map(r=>r.data.amount_ex_tax),[2000,6000]);
    assert.deepEqual(preview.rows.map(r=>r.data.tax_amount),[200,600]);
    assert.deepEqual(preview.rows.map(r=>r.data.amount_inc_tax),[2200,6600]);
    assert.deepEqual(preview.rows.map(r=>r.rowNo),[2,3]);
    assert.ok(preview.rows.every(r=>r.data.accounting_month==='2026-10'));
    assert.equal(preview.recognition.recognition_basis_id,2);
    assert.equal(preview.rawHash,digest(text));
    const competing=good(await req('/mapped-imports/preview',input));
    good(await req('/imports/commit',{token:preview.token}));
    assert.equal((await req('/imports/commit',{token:competing.token})).data.ok,false,'A preview made before the first commit must not duplicate the report');
    const report=await db.get("SELECT * FROM report_imports WHERE report_key='MAP-FAKE-001'");
    assert.equal(report.raw_text,text);
    assert.equal(report.content_hash,digest(text));
    const provenance=await db.get('SELECT * FROM mapping_import_provenance WHERE report_id=?',[report.id]);
    assert.equal(provenance.original_text,text);
    assert.equal(provenance.original_hash,digest(text));
    assert.equal(provenance.mapping_version_id,version.mappingVersionId);
    assert.equal(provenance.canonical_hash,digest(provenance.canonical_text));
    const sales=await db.all('SELECT * FROM sale_lines WHERE report_id=? ORDER BY source_row',[report.id]);
    assert.deepEqual(sales.map(r=>r.source_row),[2,3]);
    assert.equal(sales.reduce((sum,r)=>sum+r.amount_ex_tax,0),8000);
    const v2Definition=mappingDefinition();v2Definition.mappings=v2Definition.mappings.map(m=>m.target==='amount_ex_tax'?{target:'amount_ex_tax',mode:'subtract',operands:['税込売上','税額']}:m);v2Definition.ignoredColumns=['単価'];
    const v2=good(await req(`/mapping-profiles/${profile.profileId}/versions`,v2Definition));
    assert.equal((await req('/mapped-imports/preview',{...input,mappingVersionId:v2.mappingVersionId})).status,409);
    const second=good(await req('/mapping-profiles',{partnerId:2,kind:'digital',name:'別定義でも原本は同じ'}));
    const otherVersion=good(await req(`/mapping-profiles/${second.profileId}/versions`,mappingDefinition()));
    assert.equal((await req('/mapped-imports/preview',{...input,mappingVersionId:otherVersion.mappingVersionId})).status,409);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM sale_lines')).n,2);
    const production=await login('production@openingnight.invalid'),outsider=await login('outsider@other.invalid');
    assert.equal((await req('/mapping-profiles',null,production)).status,403);
    assert.equal((await req('/mapped-imports/preview',{...input,workId:2},outsider)).data.ok,false);
    assert.equal((await req('/mapped-imports?workId=1',null,outsider)).status,403);
    assert.deepEqual(await foreignKeyViolations(db),[]);
  }finally{await db.close();}
});

test('independent mapping rejects missing operands, mismatched tax, unknown headers and internal-field injection',async(t)=>{
  const {db,req}=await fixture(t);
  try{
    const p=good(await req('/mapping-profiles',{partnerId:2,kind:'digital',name:'架空厳格検証'}));
    const v=good(await req(`/mapping-profiles/${p.profileId}/versions`,mappingDefinition()));
    const preview=text=>req('/mapped-imports/preview',{workId:1,mappingVersionId:v.mappingVersionId,text});
    const headers=expected.raw_report.headers,rows=expected.raw_report.rows;
    for(const text of [
      toCsv(headers,rows.map((row,index)=>row.map((cell,col)=>index===0&&col===4?'':cell))),
      toCsv(headers,rows.map((row,index)=>row.map((cell,col)=>index===1&&col===7?'6601':cell))),
      toCsv(headers.map(h=>h==='単価'?'未定義単価':h),rows),
      toCsv([...headers,'未定義列'],rows.map(row=>[...row,'未知']))
    ])assert.equal((await preview(text)).data.ok,false);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM sale_lines')).n,0);
    const reordered=good(await preview(toCsv([...headers].reverse(),rows.map(row=>[...row].reverse()))));
    assert.deepEqual(reordered.rows.map(r=>r.data.amount_ex_tax),[2000,6000]);
    const definition={...mappingDefinition(),ignoredColumns:['備考']};
    const ignore=good(await req(`/mapping-profiles/${p.profileId}/versions`,definition));
    good(await req('/mapped-imports/preview',{workId:1,mappingVersionId:ignore.mappingVersionId,text:toCsv([...headers,'備考'],rows.map(row=>[...row,'明示して無視']))}));
    const quotedRows=rows.map((row,index)=>row.map((cell,col)=>col===8&&index===0?'架空\n複数行':cell));
    const multiline=good(await preview(toCsv(headers,quotedRows)));
    assert.deepEqual(multiline.rows.map(r=>r.rowNo),[2,4]);
    const withoutQuantity=mappingDefinition();withoutQuantity.mappings=withoutQuantity.mappings.filter(m=>m.target!=='quantity');
    const noQuantity=good(await req(`/mapping-profiles/${p.profileId}/versions`,withoutQuantity));
    const nullable=good(await req('/mapped-imports/preview',{workId:1,mappingVersionId:noQuantity.mappingVersionId,text:rawCsv()}));
    assert.ok(nullable.rows.every(row=>row.data.quantity===null),'Unmapped optional quantity stays unknown');
    const normalCsv=(await db.get('SELECT payload_json FROM import_previews WHERE token=?',[reordered.token]));
    const payload=JSON.parse(normalCsv.payload_json);
    assert.equal((await req('/imports/preview',{kind:'digital',workId:1,text:payload.canonicalRaw,sourceText:'forged',sourceRowNos:[90,91],mapping:{mappingVersionId:v.mappingVersionId}})).data.ok,false);
    payload.rows[0].data.amount_ex_tax=9999;
    payload.rows[0].data.amount_inc_tax=10199;
    await db.run('UPDATE import_previews SET payload_json=? WHERE token=?',[JSON.stringify(payload),reordered.token]);
    assert.equal((await req('/imports/commit',{token:reordered.token})).data.ok,false,'Changed financial preview must not be committed');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM sale_lines')).n,0);
  }finally{await db.close();}
});

test('FR-PLAN-ACQ-002 independent partial intake preserves an unknown counterparty without inventing one',async(t)=>{
  const {db,req}=await fixture(t);
  try{
    good(await req('/intakes',{workId:1,caseCode:'I-PARTIAL',title:'架空未確認調達',intakeType:'entrusted',documents:[{}],scopes:[{}],participants:[{partyKind:'partner',partnerId:null,role:''}]}));
    const item=good(await req('/intakes?workId=1')).cases[0];
    assert.equal(item.inputComplete,false);
    assert.equal(item.status,'draft');
    assert.equal(item.participants[0]?.partner_id??null,null);
    assert.ok(item.missingFields.length>0);
    assert.deepEqual(await foreignKeyViolations(db),[]);
  }finally{await db.close();}
});

test('FR-PLAN-ACQ-001 FR-PLAN-ACQ-002 FR-PLAN-ACQ-003 FR-PLAN-ACQ-004 independent intake cases preserve uncertain shares and only link same-work settlement contracts',async(t)=>{
  const {db,req,login}=await fixture(t);
  try{
    const source={workId:1,documents:[{title:'架空契約書',reference:'試験専用の参照・取得しない',versionLabel:'v1'}],scopes:[{channel:'digital',territory:'JP',rightsStart:'2026-01-01',rightsEnd:'2027-12-31',exclusivity:'exclusive'}]};
    const inputs=[
      {...source,caseCode:'I-COMMITTEE',title:'架空委員会',intakeType:'committee',participants:[{partyKind:'partner',partnerId:3,role:'investor',investmentYen:1000000,explicitShareBps:null}]},
      {...source,caseCode:'I-SOLE',title:'架空単独保有',intakeType:'sole_owned',participants:[{partyKind:'current_org',role:'owner',explicitShareBps:10000}]},
      {...source,caseCode:'I-ENTRUSTED',title:'架空受託',intakeType:'entrusted',participants:[{partyKind:'partner',partnerId:3,role:'holder'}]}
    ];
    for(const input of inputs)good(await req('/intakes',input));
    const cases=good(await req('/intakes?workId=1')).cases;
    assert.equal(cases.length,3);
    const find=code=>cases.find(c=>(c.caseCode??c.case_code)===code);
    const committee=find('I-COMMITTEE'),entrusted=find('I-ENTRUSTED');
    assert.equal(committee.status,'draft');
    assert.equal(committee.approvalStatus,'not_implemented');
    assert.equal(committee.participants.length,1);
    assert.equal(committee.participants[0].explicitShareBps??committee.participants[0].explicit_share_bps??null,null);
    assert.equal(committee.participants[0].investmentYen??committee.participants[0].investment_yen,1000000);
    assert.ok(committee.missingFields.length>0,'Incomplete committee must not appear complete');
    const contractInput={workId:1,contractCode:'I-CONTRACT',title:'架空分配条件',contractType:'commission',holderPartnerId:3,terms:{platformRateBps:5000,agencyFeeBps:2000}};
    const legacy=good(await req('/settlement/contracts',contractInput));
    let contracts=good(await req('/settlement/contracts?workId=1')).contracts;
    assert.equal(contracts.find(c=>c.id===legacy.contractId).intakeCaseId??null,null);
    good(await req(`/intakes/${entrusted.id}/settlement-links`,{settlementContractId:legacy.contractId}));
    contracts=good(await req('/settlement/contracts?workId=1')).contracts;
    assert.equal(contracts.find(c=>c.id===legacy.contractId).intakeCaseId,entrusted.id);
    const original=good(await req('/intakes?workId=1')).cases.find(c=>c.id===entrusted.id);
    good(await req('/intakes',{...inputs[2],caseCode:'I-ENTRUSTED-V2',sourceCaseId:entrusted.id,documents:[{...source.documents[0],versionLabel:'v2'}]}));
    const revised=good(await req('/intakes?workId=1')).cases.find(c=>c.case_code==='I-ENTRUSTED-V2');
    assert.equal(revised.source_case_id,entrusted.id);
    assert.equal(revised.snapshot_version,2);
    assert.equal(revised.settlementLinks.length,0,'Revision must not silently relink old contracts');
    assert.deepEqual(good(await req('/intakes?workId=1')).cases.find(c=>c.id===entrusted.id),original);
    assert.equal(good(await req('/settlement/contracts?workId=1')).contracts.find(c=>c.id===legacy.contractId).intakeCaseId,entrusted.id);
    assert.equal((await req('/intakes',{...inputs[1],caseCode:'I-BAD-REVISION',sourceCaseId:entrusted.id})).status,409);
    const linked=good(await req('/settlement/contracts',{...contractInput,contractCode:'I-ATOMIC',intakeCaseId:entrusted.id}));
    assert.equal(good(await req('/settlement/contracts?workId=1')).contracts.find(c=>c.id===linked.contractId).intakeCaseId,entrusted.id);
    good(await req('/intakes',{...source,caseCode:'I-90',title:'架空持分不足',intakeType:'committee',participants:[{partyKind:'partner',partnerId:1,role:'investor',investmentYen:600000,explicitShareBps:6000},{partyKind:'partner',partnerId:3,role:'investor',investmentYen:300000,explicitShareBps:3000}]}));
    let incomplete=good(await req('/intakes?workId=1')).cases.find(c=>(c.caseCode??c.case_code)==='I-90');
    good(await req('/settlement/contracts',{...contractInput,contractCode:'I-90-CONTRACT',intakeCaseId:incomplete.id}));
    incomplete=good(await req('/intakes?workId=1')).cases.find(c=>c.id===incomplete.id);
    assert.equal(incomplete.inputComplete,false,'90% explicit shares must remain incomplete even after linking');
    assert.ok(incomplete.missingFields.some(text=>/持分/.test(text)));
    await db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,1,'I-OTHER','別作品')");
    const before=(await db.get('SELECT COUNT(*) AS n FROM settlement_contracts')).n;
    const rejected=await req('/settlement/contracts',{...contractInput,workId:3,contractCode:'I-REJECT',intakeCaseId:entrusted.id});
    assert.equal(rejected.data.ok,false);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM settlement_contracts')).n,before);
    const other=good(await req('/settlement/contracts',{...contractInput,workId:3,contractCode:'I-OTHER'}));
    assert.equal((await req(`/intakes/${entrusted.id}/settlement-links`,{settlementContractId:other.contractId})).data.ok,false);
    const production=await login('production@openingnight.invalid'),outsider=await login('outsider@other.invalid');
    assert.equal((await req('/intakes?workId=1',null,production)).status,403);
    assert.equal((await req('/intakes?workId=1',null,outsider)).status,403);
    assert.deepEqual(await foreignKeyViolations(db),[]);
  }finally{await db.close();}
});
