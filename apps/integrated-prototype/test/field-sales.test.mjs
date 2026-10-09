import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,good} from './field-sales-independent-fixture.mjs';

test('field day audit retains complete before and after assignment evidence',async(t)=>{
  const f=await fixture({t});try{
    const input={workId:1,shootDate:'2026-11-01',unit:'B班',label:'監査用draft',notes:'架空',assignments:[{sceneId:f.sceneIds[0],sequenceOrder:1,plannedStart:'2026-11-01T23:30',plannedEnd:'2026-11-02T00:30',actualStart:null,actualEnd:null,outcome:'planned',notes:'初期予定'}]};
    const created=good(await f.req('/field/days',input));
    good(await f.req(`/field/days/${created.dayId}`,{...input,assignments:[{...input.assignments[0],actualStart:'2026-11-01T23:40',actualEnd:'2026-11-02T00:20',outcome:'shot',notes:'実績'}]},{method:'PATCH',version:1}));
    const rows=await f.db.all("SELECT detail_json FROM audit_log WHERE entity_type='shooting_day' AND entity_id=? ORDER BY id",[String(created.dayId)]);
    assert.equal(rows.length,2);
    const createdAudit=JSON.parse(rows[0].detail_json),updatedAudit=JSON.parse(rows[1].detail_json);
    assert.equal(createdAudit.after.assignments[0].plannedEnd,'2026-11-02T00:30');
    assert.equal(updatedAudit.before.assignments[0].notes,'初期予定');
    assert.equal(updatedAudit.after.assignments[0].outcome,'shot');
    assert.equal(updatedAudit.after.assignments[0].actualEnd,'2026-11-02T00:20');
  }finally{f.db.close()}
});

test('sales activity is append-only and summary keeps opportunity and agreement estimates separate',async(t)=>{
  const f=await fixture({t});try{
    const activity=good(await f.req('/sales-activities',{workId:1,opportunityId:f.opportunityId,occurredOn:'2026-09-20',activityType:'proposal',summary:'架空条件を提示',nextAction:'契約条件を確認',nextDueOn:'2026-09-25'}));
    await assert.rejects(f.db.run('UPDATE sales_activities SET summary=? WHERE id=?',['改変',activity.activityId]));
    good(await f.req('/sales-agreements',{workId:1,opportunityId:f.opportunityId,productId:1,contractCode:'OWN-TEST',title:'架空契約',terms:{versionLabel:'v1',channel:'digital',expectedAmountYen:80000}}));
    const state=good(await f.req('/sales-operations?workId=1&asOf=2026-10-01'));
    assert.equal(state.summary.opportunityExpectedYen,150000);
    assert.equal(state.summary.agreementExpectedYen,80000);
    assert.equal(state.activities.find(row=>row.id===activity.activityId).summary,'架空条件を提示');
  }finally{f.db.close()}
});
