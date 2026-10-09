import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,good} from './field-sales-independent-fixture.mjs';

const assignment=(sceneId,sequenceOrder=1)=>({sceneId,sequenceOrder,plannedStart:'2026-09-25T23:00',plannedEnd:'2026-09-26T01:00',actualStart:null,actualEnd:null,outcome:'planned',notes:'架空深夜撮影'});
const dayInput=f=>({workId:1,shootDate:'2026-09-25',unit:'A班',label:'架空日々スケ',notes:'実際の撮影ではありません',assignments:[assignment(f.sceneIds[0]),{...assignment(f.sceneIds[1],2),plannedStart:'2026-09-26T01:15',plannedEnd:'2026-09-26T02:00'}]});
const terms=()=>({documentReference:'架空販売契約 SALES-TEST-001',versionLabel:'v1',channel:'digital',territory:'日本',licenseStart:'2026-09-01',licenseEnd:'2027-08-31',expectedAmountYen:120000,note:'独立検証用'});
async function makeAgreement(f,overrides={}){return good(await f.req('/sales-agreements',{workId:1,opportunityId:f.opportunityId,productId:1,contractCode:'SALES-INDEPENDENT',title:'架空配信販売契約',terms:terms(),...overrides}));}

test('independent field day preserves overnight dates, scene identity and atomic day version',async(t)=>{
  const f=await fixture({t});try{
    const created=good(await f.req('/field/days',dayInput(f)));
    assert.equal(created.version,1);
    const changed={...dayInput(f),assignments:dayInput(f).assignments.map((a,i)=>i? a:{...a,actualStart:'2026-09-25T23:10',actualEnd:'2026-09-26T00:50',outcome:'partial'})};
    good(await f.req(`/field/days/${created.dayId}`,changed,{method:'PATCH',version:1}));
    const beforeAudit=(await f.db.get('SELECT count(*) AS n FROM audit_log')).n;
    const snapshot=JSON.stringify(good(await f.req('/field?workId=1')));
    assert.equal((await f.req(`/field/days/${created.dayId}`,{...changed,label:'古い上書き'},{method:'PATCH',version:1})).status,409);
    assert.equal((await f.db.get('SELECT count(*) AS n FROM audit_log')).n,beforeAudit);
    assert.equal(JSON.stringify(good(await f.req('/field?workId=1'))),snapshot);
    assert.equal((await f.db.get('SELECT status FROM scenes WHERE id=?',[f.sceneIds[0]])).status,'draft');
    good(await f.req(`/scenes/${f.sceneIds[0]}`,{status:'ready'},{method:'PATCH',version:1}));
    assert.match(snapshot,/2026-09-26T00:50/);
    good(await f.req('/field/days',{...dayInput(f),shootDate:'2026-09-27',assignments:[{...assignment(f.sceneIds[0]),plannedStart:'2026-09-27T10:00',plannedEnd:'2026-09-27T11:00',actualStart:'2026-09-27T10:00',actualEnd:'2026-09-27T11:00',outcome:'shot'}]}));
    assert.equal((await f.db.get('SELECT status FROM scenes WHERE id=?',[f.sceneIds[0]])).status,'ready','A day marked shot must not automatically complete the scene');
    const duplicate=assignment(f.sceneIds[0]);
    assert.equal((await f.req('/field/days',{...dayInput(f),unit:'B班',assignments:[duplicate,{...duplicate,sequenceOrder:2}]})).data.ok,false);
    assert.equal((await f.req('/field/days',{...dayInput(f),shootDate:'2026-02-30'})).data.ok,false);
    assert.equal((await f.req(`/field/days/${created.dayId}`,{...changed,assignments:[{...assignment(f.sceneIds[0]),plannedEnd:'2026-09-25T22:00'}]},{method:'PATCH',version:2})).data.ok,false);
    assert.deepEqual(await foreignKeyViolations(f.db),[]);
  }finally{f.db.close();}
});

test('independent preparation tasks keep work and role boundaries without financial access',async(t)=>{
  const f=await fixture({t});try{
    const day=good(await f.req('/field/days',dayInput(f))),production=await f.login('production@openingnight.invalid'),outsider=await f.login('outsider@other.invalid');
    const task=good(await f.req('/field/tasks',{workId:1,shootingDayId:day.dayId,sceneId:f.sceneIds[0],title:'架空照明の準備',ownerLabel:'照明担当',dueOn:'2026-09-24',status:'pending',note:'検証'},{cookie:production}));
    good(await f.req(`/field/tasks/${task.taskId}`,{workId:1,shootingDayId:day.dayId,sceneId:f.sceneIds[0],title:'架空照明の準備',ownerLabel:'照明担当',dueOn:'2026-09-24',status:'ready',note:'準備確認'},{cookie:production,method:'PATCH',version:1}));
    assert.equal((await f.req(`/field/tasks/${task.taskId}`,{status:'blocked'},{cookie:production,method:'PATCH',version:1})).status,409);
    const field=good(await f.req('/field?workId=1',null,{cookie:production}));
    assert.doesNotMatch(JSON.stringify(field),/expected_yen|expectedAmountYen|budget_yen|forecast_yen/);
    assert.ok((await f.req('/sales-operations?workId=1&asOf=2026-10-02',null,{cookie:production})).status>=400);
    assert.ok((await f.req('/field?workId=1',null,{cookie:outsider})).status>=400);
    await f.db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,1,'OTHER-WORK','別の架空作品')");
    assert.equal((await f.req('/field/tasks',{workId:3,shootingDayId:day.dayId,sceneId:f.sceneIds[0],title:'作品横断は禁止',status:'pending'})).data.ok,false);
    assert.deepEqual(await foreignKeyViolations(f.db),[]);
  }finally{f.db.close();}
});

test('independent sales agreement and delivery links never create revenue and retain old terms',async(t)=>{
  const f=await fixture({t});try{
    const agreement=await makeAgreement(f);
    const activity=good(await f.req('/sales-activities',{workId:1,opportunityId:f.opportunityId,occurredOn:'2026-09-18',activityType:'proposal',summary:'架空の提案記録',nextAction:'納品仕様確認',nextDueOn:'2026-09-22'}));
    assert.equal((await f.db.get('SELECT count(*) AS n FROM sales_activities')).n,1);
    await assert.rejects(f.db.run("UPDATE sales_activities SET summary='履歴の改変' WHERE id=?",[activity.activityId]));
    good(await f.req(`/opportunities/${f.opportunityId}`,{stage:'negotiation'},{method:'PATCH',version:1}));
    const delivery=good(await f.req('/deliverables',{workId:1,agreementId:agreement.agreementId,termVersionId:agreement.termVersionId,title:'架空本編マスター',dueOn:'2026-09-30',status:'pending'}));
    let state=good(await f.req('/sales-operations?workId=1&asOf=2026-10-02'));
    assert.equal(state.summary.opportunityExpectedYen,150000);
    assert.equal(state.summary.agreementExpectedYen,120000);
    assert.equal(state.summary.unknownForecastCount,0);
    assert.equal(state.deliverables.find(d=>d.id===delivery.deliverableId).overdue,true);
    assert.equal((await f.req(`/deliverables/${delivery.deliverableId}`,{status:'accepted',acceptedOn:'2026-10-02'},{method:'PATCH',version:1})).data.ok,false);
    good(await f.req(`/deliverables/${delivery.deliverableId}`,{status:'accepted',submittedOn:'2026-10-01',acceptedOn:'2026-10-02'},{method:'PATCH',version:1}));
    good(await f.req('/sales-report-links',{workId:1,reportId:f.report.id,agreementTermVersionId:agreement.termVersionId}));
    assert.equal((await f.req('/sales-report-links',{workId:1,reportId:f.report.id,agreementTermVersionId:agreement.termVersionId})).data.ok,false);
    state=good(await f.req('/sales-operations?workId=1&asOf=2026-10-02'));
    assert.equal(state.deliverables.find(d=>d.id===delivery.deliverableId).overdue,false);
    const oldLink=JSON.stringify(state.reportLinks[0]);
    const second=good(await f.req(`/sales-agreements/${agreement.agreementId}/versions`,{...terms(),sourceVersionId:agreement.termVersionId,versionLabel:'v2',expectedAmountYen:180000},{version:agreement.version}));
    assert.notEqual(second.termVersionId,agreement.termVersionId);
    assert.equal((await f.req(`/sales-agreements/${agreement.agreementId}/versions`,{...terms(),versionLabel:'stale'},{version:agreement.version})).status,409);
    state=good(await f.req('/sales-operations?workId=1&asOf=2026-10-02'));
    assert.equal(state.reportLinks[0].needsReview,true);
    assert.equal(state.deliverables.find(d=>d.id===delivery.deliverableId).term_version_id,agreement.termVersionId);
    assert.equal(state.agreements.find(a=>a.id===agreement.agreementId).terms.find(t=>t.id===agreement.termVersionId).expected_amount_yen,120000);
    assert.notEqual(JSON.stringify(state.reportLinks[0]),oldLink);
    assert.equal(JSON.stringify(await f.db.all('SELECT * FROM sale_lines ORDER BY id')),f.originalSales);
    assert.equal((await f.db.get('SELECT expected_yen FROM sales_opportunities WHERE id=?',[f.opportunityId])).expected_yen,150000);
    assert.equal((await f.db.get('SELECT count(*) AS n FROM report_imports')).n,1);
    assert.deepEqual(await foreignKeyViolations(f.db),[]);
  }finally{f.db.close();}
});

test('independent shared-product report can link to agreements for each allocated work',async(t)=>{
  const f=await fixture({t});try{
    await f.db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,1,'SHARED-WORK','架空セット内の別作品')");
    await f.db.run("INSERT INTO products(id,org_id,sku,name,channel) VALUES(3,1,'SHARED-SALES','架空セット','digital')");
    await f.db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,3,1,6000),(1,3,3,4000)');
    good(await f.req('/sales',{workId:1,report_key:'SHARED-SALES-REPORT',kind:'digital',partner_id:2,product_id:3,period_from:'2026-09-01',period_to:'2026-09-30',recognition_basis_id:2,report_received_on:'2026-10-05',basis_reason:'架空受領月',description:'セット販売',amount_ex_tax:100000,tax_amount:0,amount_inc_tax:100000}));
    const report=await f.db.get("SELECT id FROM report_imports WHERE report_key='SHARED-SALES-REPORT'");
    const saleBefore=JSON.stringify(await f.db.all('SELECT * FROM sale_lines ORDER BY id'));
    for(const workId of [1,3]){
      const opportunity=good(await f.req('/opportunities',{project_id:1,work_id:workId,partner_id:2,name:`架空共有商談${workId}`,stage:'lead'}));
      const agreement=await makeAgreement(f,{workId,opportunityId:opportunity.id,productId:3,contractCode:`SHARED-${workId}`});
      good(await f.req('/sales-report-links',{workId,reportId:report.id,agreementTermVersionId:agreement.termVersionId}));
    }
    assert.equal((await f.db.get('SELECT count(*) AS n FROM sales_report_links WHERE report_id=?',[report.id])).n,2);
    assert.equal(JSON.stringify(await f.db.all('SELECT * FROM sale_lines ORDER BY id')),saleBefore);
    assert.deepEqual(await foreignKeyViolations(f.db),[]);
  }finally{f.db.close();}
});

test('independent sales report association rejects wrong partner, product and undefined channel',async(t)=>{
  const f=await fixture({t});try{
    const wrongProduct=await makeAgreement(f,{productId:2});
    assert.equal((await f.req('/sales-report-links',{workId:1,reportId:f.report.id,agreementTermVersionId:wrongProduct.termVersionId})).data.ok,false);
    const otherOpportunity=good(await f.req('/opportunities',{project_id:1,work_id:1,partner_id:3,name:'別取引先',stage:'lead'}));
    const wrongPartner=await makeAgreement(f,{opportunityId:otherOpportunity.id,contractCode:'WRONG-PARTNER'});
    assert.equal((await f.req('/sales-report-links',{workId:1,reportId:f.report.id,agreementTermVersionId:wrongPartner.termVersionId})).data.ok,false);
    const broadcast=await makeAgreement(f,{contractCode:'BROADCAST',terms:{...terms(),channel:'broadcast'}});
    assert.equal((await f.req('/sales-report-links',{workId:1,reportId:f.report.id,agreementTermVersionId:broadcast.termVersionId})).data.ok,false);
    assert.equal(JSON.stringify(await f.db.all('SELECT * FROM sale_lines ORDER BY id')),f.originalSales);
    assert.deepEqual(await foreignKeyViolations(f.db),[]);
  }finally{f.db.close();}
});

test('販売契約の地域が100文字を超えるときは、日本語の理由で400を返し、地域を黙って落とさない',async(t)=>{
  const f=await fixture({t});try{
    const long='北米・南米・欧州・アジア'.repeat(12);
    const refused=await f.req('/sales-agreements',{workId:1,opportunityId:f.opportunityId,productId:1,contractCode:'SALES-LONG',title:'架空配信販売契約',terms:{...terms(),territory:long}});
    assert.equal(refused.status,400);
    assert.match(refused.data.error,/地域は100文字以内/);
    const created=await makeAgreement(f);
    const version=await f.req(`/sales-agreements/${created.agreementId}/versions`,{sourceVersionId:created.termVersionId,...terms(),territory:long},{version:created.version});
    assert.equal(version.status,400,'「別の利用者が更新しました」にしない');
    assert.match(version.data.error,/地域は100文字以内/);
  }finally{f.db.close();}
});
