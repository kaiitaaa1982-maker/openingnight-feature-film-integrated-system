import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {financeTotals} from '../src/master-extensions/work-master-model.mjs';
import {setupMaster,meta} from './req5-master-fixture.mjs';
const amount=(key,yen)=>({[key+'_yen']:yen,[key+'_tax_basis']:'ex_tax',[key+'_status']:yen===null?'unknown':'confirmed',[key+'_as_of']:yen===null?null:'2026-09-28',[key+'_evidence']:yen===null?null:'見積書（架空）'});
test('作品仕様は既存作品を変えず版を追加し、競合は原子的に拒否して監査する',async(t)=>{
  const {db,call}=await setupMaster({t});try {
    const before=await db.get('SELECT * FROM works WHERE id=1');
    let r=await call('/work-master/1/profile',{...meta,series:'連作（架空）'});assert.equal(r.status,201,JSON.stringify(r.data));
    const results=await Promise.all([call('/work-master/1/profile',{...meta,baseRevision:1,series:'次版（架空）'}),call('/work-master/1/profile',{...meta,baseRevision:1,series:'競合（架空）'})]);
    assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);
    assert.equal((await call('/work-master/1/profile?revision=1')).data.version.series,'連作（架空）');
    assert.equal((await call('/work-master/1')).data.history.profile.length,2);
    assert.deepEqual(await db.get('SELECT * FROM works WHERE id=1'),before);
    assert.equal((await db.get("SELECT COUNT(*) n FROM audit_log WHERE entity_type='work_master_profile_versions'")).n,2);
    await assert.rejects(db.run('UPDATE work_master_profile_versions SET series=?',['上書き']));await assert.rejects(db.run('DELETE FROM work_master_profile_versions'));
  }finally{db.close();}
});
test('FR-PLAN-ACQ-020 FR-PLAN-ACQ-021 契約と権利元の複数行・順序を版で保持し、異常な期間・別組織の相手を拒否する',async(t)=>{
  const {db,call}=await setupMaster({t});try {
    const rows=[{partner_id:1,role:'権利元',evidence:'文書（架空）'},{name:'原作者（架空）',role:'原作者',evidence:'文書（架空）'}];
    assert.equal((await call('/work-master/1/rights',{...meta,rows})).status,201);
    assert.equal((await call('/work-master/1/rights',{...meta,baseRevision:1,rows:[...rows].reverse()})).status,201);
    assert.equal((await call('/work-master/1/rights?revision=1')).data.version.rows[0].partner_id,1);
    assert.equal((await call('/work-master/1')).data.sections.rights.rows[0].name,'原作者（架空）');
    const contracts=[{contract_key:'DEMO-A',title:'取得（架空）',kind:'acquisition',signed_on:'2026-09-01',starts_on:'2026-10-01',ends_on:'2027-09-30',partner_id:1,document_reference:'契約書（架空）'},{contract_key:'DEMO-B',title:'製作（架空）',kind:'production',partner_id:1,document_reference:'発注書（架空）'}];
    assert.equal((await call('/work-master/1/contracts',{...meta,rows:contracts})).status,201);
    assert.equal((await call('/work-master/1/contracts',{...meta,baseRevision:1,rows:contracts.reverse()})).status,201);
    assert.equal((await call('/work-master/1/contracts?revision=1')).data.version.rows[0].signed_on,'2026-09-01');
    assert.equal((await call('/work-master/1/contracts',{...meta,baseRevision:2,rows:[{...contracts[0],starts_on:'2027-01-01',ends_on:'2026-01-01'}]})).status,400);
    assert.equal((await call('/work-master/1/rights',{...meta,baseRevision:2,rows:[{partner_id:99999,role:'権利元',evidence:'文書'}]})).status,400);
    assert.equal((await call('/work-master/1/rights',{...meta,baseRevision:2,rows:[]})).status,201);
    assert.equal((await call('/work-master/1')).data.sections.rights.rows.length,0);
    assert.deepEqual(await foreignKeyViolations(db),[]);
  }finally{db.close();}
});
test('費用は空と0を分け、実績は宣伝経費だけを独立集計し、税区分不一致は合算しない',async(t)=>{
  const {db,call}=await setupMaster({t});try {
    // seedの委員会に依存しない作品を用意する。
    await db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(91,1,1,'DEMO-91','単独作品（架空）')");
    const body={...meta,...amount('production_cost',12000000),...amount('promotion_budget',3000000),...amount('own_investment',0)};
    assert.equal((await call('/work-master/91/finance',body)).status,201);
    for(const [category,ex,tax] of [['宣伝費',1000000,100000],['P&A',1400000,140000],['制作費',500000,50000]]) await db.run('INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,91,?,?,?,?,?,?,?)',['2026-09-01','2026-09',category,'検証（架空）',ex,tax,ex+tax]);
    const preview=(await call('/expense-accounting/adoption-preview')).data;assert.equal((await call('/expense-accounting/adopt',{token:preview.token,reason:'既存費目を採用（架空）'})).status,201);
    const result=(await call('/work-master/91')).data;
    assert.equal(result.finance_totals.total_project_cost_yen,15000000);
    assert.equal(result.finance_totals.promotion_actual_ex_tax,2400000);assert.equal(result.finance_totals.promotion_budget_remaining_yen,600000);
    assert.equal(result.sections.finance.own_investment_yen,0);assert.equal(result.sections.finance.sales_rights_purchase_yen,null);
    for(const patch of [{production_cost_yen:-1},{production_cost_yen:null},{production_cost_as_of:'2026-02-30'},{own_investment_tax_basis:'inc_tax'},{production_cost_evidence:null}]) assert.equal((await call('/work-master/91/finance',{...body,baseRevision:1,...patch})).status,400);
    assert.equal(financeTotals({...body,promotion_budget_tax_basis:'inc_tax'}).total_project_cost_yen,null);
  }finally{db.close();}
});
test('宣伝実績はPLと同じ費目で集計し、全角P&Aを含み、制作費を重ねて含めない',async(t)=>{
  const {db,call}=await setupMaster({t});try {
    await db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(91,1,1,'DEMO-PROMOTION','宣伝集計（架空）')");
    for(const [category,ex] of [['Ｐ＆Ａ',1100],['広告費',2200],['制作費・宣伝素材',3300],['その他P&A素材',4400]]) {
      await db.run('INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,91,?,?,?,?,?,?,?)',['2026-09-01','2026-09',category,'分類の照合（架空）',ex,ex/10,ex+ex/10]);
    }
    const preview=(await call('/expense-accounting/adoption-preview')).data;assert.equal((await call('/expense-accounting/adopt',{token:preview.token,reason:'既存費目を採用（架空）'})).status,201);
    const total=(await call('/work-master/91')).data.finance_totals;
    assert.equal(total.promotion_actual_ex_tax,1100+2200);
    assert.equal(total.promotion_actual_inc_tax,1210+2420);
    assert.equal(total.promotion_expense_count,2);
  }finally{db.close();}
});
test('制作担当・他組織・閲覧だけの担当へ金額や履歴を返さず編集も禁止する',async(t)=>{
  const {db,call,login}=await setupMaster({t});try {
    const production=await login('production@openingnight.invalid'),other=await login('outsider@other.invalid');
    const r=await call('/work-master/1',null,production);assert.equal(r.status,200);assert.equal(r.data.canEdit,false);assert.ok(!Object.hasOwn(r.data.sections,'finance'));assert.ok(!Object.hasOwn(r.data,'finance_totals'));assert.ok(!Object.hasOwn(r.data,'committee_references'));
    assert.equal((await call('/work-master/1/finance?revision=1',null,production)).status,403);
    assert.equal((await call('/work-master/1/profile',meta,production)).status,403);
    assert.equal((await call('/work-master/1',null,other)).status,403);
    assert.equal((await call('/work-master/1/profile?revision=1',null,other)).status,403);
    await db.run("UPDATE project_memberships SET permission='production' WHERE org_id=1 AND project_id=1 AND user_id=(SELECT id FROM users WHERE email='editor@openingnight.invalid')");
    const reader=await login('editor@openingnight.invalid');
    const read=await call('/work-master/1',null,reader);assert.equal(read.status,200);assert.ok(!Object.hasOwn(read.data.sections,'finance'));
    assert.equal((await call('/work-master/1/finance?revision=1',null,reader)).status,403);
    assert.equal((await call('/product-master/1',null,reader)).data.canFinance,false);
  }finally{db.close();}
});

test('FR-PLAN-ACQ-020 FR-PLAN-ACQ-021 権利元と契約の組織外参照はAPIと外部キーの両方で拒否する',async(t)=>{
  const {db,call}=await setupMaster({t});try{
    await db.run("INSERT INTO partners(id,org_id,code,name) VALUES(990,2,'DEMO-OUTSIDE','別組織（架空）')");
    const rights={...meta,rows:[{partner_id:990,role:'権利元',evidence:'文書（架空）'}]};
    assert.equal((await call('/work-master/1/rights',rights)).status,400);
    assert.equal((await call('/work-master/1/rights',{...meta,rows:[]})).status,201);
    await assert.rejects(db.run("INSERT INTO work_rights_party_versions(org_id,work_id,revision,position,partner_id,role,evidence) VALUES(1,1,1,0,990,'権利元','文書')"),(e)=>e.dbError?.kind==='foreign_key');
    assert.equal((await call('/work-master/1/contracts',{...meta,rows:[{contract_key:'DEMO-X',title:'契約（架空）',kind:'other',partner_id:990,document_reference:'文書'}]})).status,400);
    assert.equal((await db.get('SELECT COUNT(*) n FROM work_contract_set_versions')).n,0);
  }finally{db.close();}
});
