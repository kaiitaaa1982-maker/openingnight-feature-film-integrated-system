import test from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv} from '../src/csv.mjs';

const base={period_from:'2026-09-01',period_to:'2026-09-30',accounting_month:'2026-09',sales_period_from:'2026-09-01',sales_period_to:'2026-09-30'};
async function post(app,cookie,path,payload){
  const response=await app.request(path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(payload)});
  return {status:response.status,body:await response.json()};
}
async function importRows(app,cookie,kind,rows){
  const headers=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  const text=toCsv(headers,rows.map(row=>headers.map(key=>row[key]??'')));
  const preview=await post(app,cookie,'/api/imports/preview',{kind,workId:1,text});
  assert.equal(preview.body.ok,true,JSON.stringify(preview.body.errors));
  const commit=await post(app,cookie,'/api/imports/commit',{token:preview.body.token});
  assert.equal(commit.body.ok,true,JSON.stringify(commit.body));
  return preview.body;
}

test('FR-REV-INTAKE-024 FR-REV-INTAKE-025 channel facts import atomically while package stock stays outside booked sale lines',async(t)=>{
  const db=await openTestDb({t});
  try{
    const app=createApp({db,mode:'local'});
    const login=await post(app,'','/api/local/login',{email:'admin@openingnight.invalid'});
    assert.equal(login.status,200);
    const loginResponse=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
    const cookie=loginResponse.headers.get('set-cookie').split(';')[0];
    await importRows(app,cookie,'digital',[{...base,report_key:'DIGI-DETAIL',partner_id:2,product_id:1,digital_model:'tvod',service_code:'SERVICE-TEST',sales_count:4,unit_price_ex_tax:250,amount_ex_tax:1000,tax_amount:100,amount_inc_tax:1100}]);
    await importRows(app,cookie,'theatrical',[{...base,report_key:'THEATRICAL-DETAIL',partner_id:1,theatrical_model:'theatrical_rs',ticket_type_code:'ADULT',purchase_channel:'counter',admissions_count:10,gross_box_office_ex_tax:1000,amount_ex_tax:500,tax_amount:50,amount_inc_tax:550}]);
    const packageRows=[
      {...base,report_key:'PACKAGE-DETAIL',partner_id:3,product_id:2,package_model:'rental',turns_count:12,average_rental_price_ex_tax:300,amount_ex_tax:900,tax_amount:90,amount_inc_tax:990},
      {...base,report_key:'PACKAGE-DETAIL',partner_id:3,product_id:2,package_model:'rental',inventory_count:40,inventory_as_of:'2026-09-30',observation_unit:'枚',observation_scope:'月末倉庫',observation_basis:'事業者報告'}
    ];
    const preview=await importRows(app,cookie,'package',packageRows);
    assert.deepEqual(preview.rows.map(row=>row.destination),['sale_lines','package_report_observations']);
    assert.equal((await db.get("SELECT COUNT(*) n FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE r.report_key='PACKAGE-DETAIL'")).n,1);
    assert.equal((await db.get("SELECT count n,observed_on FROM package_report_observations WHERE metric='inventory'")).n,40);
    assert.equal((await db.get('SELECT product_id FROM package_observation_products')).product_id,2);
    assert.equal((await db.get('SELECT sales_count FROM digital_sale_details')).sales_count,4);
    assert.equal((await db.get('SELECT admissions_count FROM theatrical_sale_details')).admissions_count,10);
    assert.equal((await db.get('SELECT turns_count FROM package_sale_details')).turns_count,12);
    assert.equal((await db.get("SELECT COUNT(*) n FROM report_channel_fact_seals f JOIN report_imports r ON r.org_id=f.org_id AND r.id=f.report_id WHERE r.report_key IN ('DIGI-DETAIL','THEATRICAL-DETAIL','PACKAGE-DETAIL')")).n,3);
    await assert.rejects(()=>db.run("INSERT INTO package_report_observations(org_id,report_id,source_row,metric,count,unit,scope,basis) VALUES(1,(SELECT id FROM report_imports WHERE report_key='PACKAGE-DETAIL'),8,'active',1,'枚','後日','架空')"),/sealed/);
    await assert.rejects(()=>db.run("INSERT INTO package_observation_products(org_id,report_id,source_row,metric,product_id) VALUES(1,(SELECT id FROM report_imports WHERE report_key='PACKAGE-DETAIL'),8,'active',2)"),/sealed/);
    assert.deepEqual(await foreignKeyViolations(db),[]);
  }finally{await db.close()}
});

test('FR-REV-INTAKE-024 wrong-channel details and invalid package observation block the whole report',async(t)=>{
  const db=await openTestDb({t});
  try{
    const app=createApp({db,mode:'local'});
    const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const rows=[{...base,report_key:'BAD-CHANNEL',partner_id:2,product_id:1,digital_model:'tvod',service_code:'SERVICE-TEST',ticket_type_code:'ADULT',amount_ex_tax:100,tax_amount:10,amount_inc_tax:110}];
    const text=toCsv(Object.keys(rows[0]),[Object.values(rows[0])]);
    const preview=await post(app,cookie,'/api/imports/preview',{kind:'digital',workId:1,text});
    assert.equal(preview.body.ok,false);
    assert.match(preview.body.errors[0].message,/ticket_type_code/);
    assert.equal((await db.get("SELECT COUNT(*) n FROM report_imports WHERE report_key='BAD-CHANNEL'")).n,0);
    const metadataOnly=toCsv(['report_key','partner_id','period_from','period_to','accounting_month','amount_ex_tax','tax_amount','amount_inc_tax','inventory_as_of'],[['BAD-METADATA',2,'2026-09-01','2026-09-30','2026-09',100,10,110,'2026-09-30']]);
    const rejected=await post(app,cookie,'/api/imports/preview',{kind:'digital',workId:1,text:metadataOnly});
    assert.equal(rejected.body.ok,false);
    assert.match(rejected.body.errors[0].message,/package observations/);
  }finally{await db.close()}
});

test('mapped package report revalidates an observation-only source row at commit',async(t)=>{
  const db=await openTestDb({t});
  try{
    const app=createApp({db,mode:'local'});
    const login=await app.request('/api/local/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const profile=await post(app,cookie,'/api/mapping-profiles',{partnerId:3,kind:'package',name:'架空レンタル'});
    assert.equal(profile.status,201,JSON.stringify(profile.body));
    const source=(target,column)=>({target,mode:'source',source:column});
    const literal=(target,value)=>({target,mode:'literal',valueType:'string',value});
    const mappings=[literal('report_key','MAPPED-STOCK'),literal('partner_id','3'),literal('product_id','2'),literal('accounting_month','2026-09'),literal('package_model','rental'),source('period_from','開始'),source('period_to','終了'),source('amount_ex_tax','税抜'),source('tax_amount','税'),source('amount_inc_tax','税込'),source('inventory_count','在庫'),source('inventory_as_of','時点'),source('observation_unit','単位'),source('observation_scope','範囲'),source('observation_basis','根拠')];
    const version=await post(app,cookie,`/api/mapping-profiles/${profile.body.profileId}/versions`,{ignoredColumns:[],mappings});
    assert.equal(version.status,201,JSON.stringify(version.body));
    const headers=['開始','終了','税抜','税','税込','在庫','時点','単位','範囲','根拠'];
    const sourceText=toCsv(headers,[['2026-09-01','2026-09-30','100','10','110','','','','',''],['2026-09-01','2026-09-30','','','','25','2026-09-30','枚','月末倉庫','架空報告']]);
    const preview=await post(app,cookie,'/api/mapped-imports/preview',{workId:1,mappingVersionId:version.body.mappingVersionId,text:sourceText});
    assert.equal(preview.body.ok,true,JSON.stringify(preview.body));
    assert.deepEqual(preview.body.rows.map(row=>row.destination),['sale_lines','package_report_observations']);
    const commit=await post(app,cookie,'/api/mapped-imports/commit',{token:preview.body.token});
    assert.equal(commit.body.ok,true,JSON.stringify(commit.body));
    assert.equal((await db.get("SELECT COUNT(*) n FROM package_report_observations o JOIN report_imports r ON r.id=o.report_id WHERE r.report_key='MAPPED-STOCK'")).n,1);
    assert.equal((await db.get("SELECT COUNT(*) n FROM sale_lines s JOIN report_imports r ON r.id=s.report_id WHERE r.report_key='MAPPED-STOCK'")).n,1);
  }finally{await db.close()}
});
