import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {
  daysBetween, deliverableTiming, deliverableFormErrors, futureDateWarnings, nextActionState, latestActivityByOpportunity, pipelineStages, summarizePipeline,
  buildPipeline, todayJst, termVersionLabel, registerSalesPipelineRoutes,
} from '../src/sales-ops/pipeline-routes.mjs';

// 1. 判定の純関数

test('日数と日本時間の今日', () => {
  assert.equal(daysBetween('2026-09-30', '2026-10-01'), 1);
  assert.equal(daysBetween('2026-10-01', '2026-09-24'), -7);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysBetween('2026-09-30', ''), null);
  assert.equal(todayJst(Date.parse('2026-09-24T15:30:00Z')), '2026-09-25', 'UTC 15:30 は日本時間の翌日');
  assert.equal(todayJst(Date.parse('2026-09-24T14:59:00Z')), '2026-09-24');
});

test('納品の判定: 期限後の提出は「遅延提出（n日）」で数え、「超過なし」にしない', () => {
  const due = {due_on: '2026-09-30'};
  const late = deliverableTiming({...due, status: 'submitted', submitted_on: '2026-10-01'}, '2026-10-05');
  assert.deepEqual([late.code, late.label, late.late, late.overdue], ['late_submitted', '遅延提出（1日）', true, false]);
  const lateAccepted = deliverableTiming({...due, status: 'accepted', submitted_on: '2026-10-03', accepted_on: '2026-10-04'}, '2026-10-05');
  assert.equal(lateAccepted.label, '遅延提出（3日）', '受領済みでも期限後の提出は遅延提出');
  assert.equal(deliverableTiming({...due, status: 'submitted', submitted_on: '2026-09-30'}, '2026-10-05').label, '期限内に提出', '期限日の提出は期限内');
  const overdue = deliverableTiming({...due, status: 'pending'}, '2026-10-04');
  assert.deepEqual([overdue.code, overdue.label, overdue.overdue], ['overdue', '納期超過（4日）', true]);
  assert.equal(deliverableTiming({...due, status: 'blocked'}, '2026-10-01').label, '納期超過（1日）・保留中');
  assert.equal(deliverableTiming({...due, status: 'pending'}, '2026-09-30').code, 'due_today');
  assert.equal(deliverableTiming({...due, status: 'pending'}, '2026-09-25').label, '期限まで5日');
  assert.equal(deliverableTiming({...due, status: 'pending'}, '2026-09-01').tone, 'info');
  assert.equal(deliverableTiming({status: 'pending', due_on: null}, '2026-09-01').label, '期限未設定');
  assert.equal(deliverableTiming({status: 'submitted', submitted_on: '2026-09-01', due_on: null}, '2026-09-10').label, '提出済み（期限未設定）');
  assert.equal(deliverableTiming({...due, status: 'submitted', submitted_on: '2026-10-09'}, '2026-10-05').future, true, '判定日より後の提出日は印を付ける');
});

test('未来の実績日は入力時に警告する（保存は止めない）', () => {
  const warnings = futureDateWarnings({submittedOn: '2026-09-25', acceptedOn: '2026-09-24'}, '2026-09-24');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].field, 'submittedOn');
  assert.match(warnings[0].message, /提出日（2026\/09\/25）が今日（2026\/09\/24）より後/);
  assert.deepEqual(futureDateWarnings({submittedOn: '', acceptedOn: null}, '2026-09-24'), []);
  assert.equal(futureDateWarnings({occurredOn: '2026-10-01'}, '2026-09-24', [['occurredOn', '実施日']]).length, 1);
});

test('納品項目の入力の確認はサーバーと同じ規則で項目ごとに理由を返す', () => {
  const base = {agreementId: '1', termVersionId: '2', title: '架空本編', status: 'pending'};
  assert.deepEqual(deliverableFormErrors(base), {});
  assert.deepEqual(Object.keys(deliverableFormErrors({})).sort(), ['agreementId', 'termVersionId', 'title']);
  assert.equal(deliverableFormErrors({...base, status: 'submitted'}).submittedOn, '提出済み・受領済みには提出日が必要です');
  assert.equal(deliverableFormErrors({...base, status: 'accepted', submittedOn: '2026-09-10'}).acceptedOn, '受領済みには受領日が必要です');
  assert.equal(deliverableFormErrors({...base, acceptedOn: '2026-09-10'}).submittedOn, '受領日を入れるときは提出日も入れてください');
  assert.equal(deliverableFormErrors({...base, status: 'accepted', submittedOn: '2026-09-10', acceptedOn: '2026-09-09'}).acceptedOn, '受領日は提出日以後にしてください');
});

test('条件版の表示名は「第n版（版の名称）」で、名称が同じなら重ねない', () => {
  assert.equal(termVersionLabel({version_no: 1, version_label: '初版'}), '第1版（初版）');
  assert.equal(termVersionLabel({version_no: 2, version_label: '第2版'}), '第2版');
  assert.equal(termVersionLabel({version_no: 3, version_label: null}), '第3版');
  assert.equal(termVersionLabel(null), null);
});

test('次の行動の期限と、案件ごとの最新の活動', () => {
  assert.equal(nextActionState('2026-09-20', '条件確認', '2026-09-24').label, '期限切れ（4日）');
  assert.equal(nextActionState('2026-09-24', '条件確認', '2026-09-24').code, 'today');
  assert.equal(nextActionState('2026-09-28', '条件確認', '2026-09-24').label, 'あと4日');
  assert.equal(nextActionState(null, '条件確認', '2026-09-24').label, '期限未設定');
  assert.equal(nextActionState(null, null, '2026-09-24').label, '次の行動なし');
  const latest = latestActivityByOpportunity([
    {id: 1, opportunity_id: 10, occurred_on: '2026-09-01', next_due_on: '2026-09-05'},
    {id: 3, opportunity_id: 10, occurred_on: '2026-09-10', next_due_on: null},
    {id: 2, opportunity_id: 10, occurred_on: '2026-09-10', next_due_on: '2026-09-30'},
    {id: 4, opportunity_id: 11, occurred_on: '2026-08-01', next_due_on: '2026-08-02'},
  ]);
  assert.equal(latest.get(10).id, 3, '同じ日は後から登録した活動');
  assert.equal(latest.get(11).id, 4);
});

test('段階別の件数と見込額（見込が未入力の案件は金額に入れず、件数を別に数える）', () => {
  const opportunities = [
    {id: 1, stage: 'lead', expected_yen: 100000},
    {id: 2, stage: 'lead', expected_yen: null},
    {id: 3, stage: 'negotiation', expected_yen: 300000, next: {overdue: true}},
    {id: 4, stage: 'won', expected_yen: 500000},
    {id: 5, stage: 'lost', expected_yen: 900000, next: {overdue: true}},
  ];
  const stages = pipelineStages(opportunities);
  assert.deepEqual(stages.map((row) => [row.label, row.count, row.expectedYen, row.unknownCount]), [
    ['見込', 2, 100000, 1], ['提案', 0, 0, 0], ['交渉', 1, 300000, 0], ['受注', 1, 500000, 0], ['失注', 1, 900000, 0],
  ]);
  const summary = summarizePipeline({opportunities, deliverables: [{timing: {overdue: true}}, {timing: {late: true}}, {timing: {}}]});
  assert.deepEqual(summary.open, {count: 3, expectedYen: 400000, unknownCount: 1}, '進行中は見込・提案・交渉だけ');
  assert.equal(summary.won.expectedYen, 500000);
  assert.equal(summary.nextActionOverdue, 1, '失注の案件の期限切れは数えない');
  assert.equal(summary.deliverableOverdue, 1);
  assert.equal(summary.lateSubmitted, 1);
  const empty = buildPipeline({asOf: '2026-09-24'});
  assert.equal(empty.summary.open.count, 0);
  assert.deepEqual(empty.opportunities, []);
});

// 2. API: 作品横断、権限外の作品は出ない

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  if (!app.routes?.some?.((route) => route.path === '/api/sales-pipeline')) registerSalesPipelineRoutes(app, app.ux);
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const ok = (result) => { assert.ok(result.status < 300 && result.data.ok, JSON.stringify(result)); return result.data; };
  // 編集担当が所属しない、同じ組織の別案件・別作品
  await db.run("INSERT INTO projects(id,org_id,code,title,status) VALUES(3,1,'PRJ-HIDDEN','架空の別案件','active')");
  await db.run("INSERT INTO works(id,org_id,project_id,code,title,format) VALUES(3,1,3,'WRK-HIDDEN','架空の別作品','film')");
  const visible = ok(await req('/opportunities', {project_id: 1, work_id: 1, partner_id: 2, name: '架空配信への提案', stage: 'proposal', expected_yen: 150000, close_date: '2026-10-31'}));
  ok(await req('/opportunities', {project_id: 1, work_id: 1, partner_id: 1, name: '架空劇場の見込', stage: 'lead', close_date: null}));
  const hidden = ok(await req('/opportunities', {project_id: 3, work_id: 3, partner_id: 3, name: '別作品の商談', stage: 'negotiation', expected_yen: 700000}));
  ok(await req('/sales-activities', {workId: 1, opportunityId: visible.id, occurredOn: '2026-09-10', activityType: 'proposal', summary: '条件を提示', nextAction: '回答を確認', nextDueOn: '2026-09-20'}));
  const agreement = ok(await req('/sales-agreements', {workId: 1, opportunityId: visible.id, productId: 1, contractCode: 'PIPE-1', title: '架空配信契約', terms: {versionLabel: '初版', channel: 'digital', expectedAmountYen: 80000}}));
  ok(await req('/deliverables', {workId: 1, agreementId: agreement.agreementId, termVersionId: agreement.termVersionId, title: '架空本編マスター', dueOn: '2026-09-20', status: 'submitted', submittedOn: '2026-09-21'}));
  ok(await req('/deliverables', {workId: 1, agreementId: agreement.agreementId, termVersionId: agreement.termVersionId, title: '架空予告編', dueOn: '2026-09-20', status: 'pending'}));
  ok(await req('/deliverables', {workId: 1, agreementId: agreement.agreementId, termVersionId: agreement.termVersionId, title: '架空字幕', dueOn: '2026-10-20', status: 'pending'}));
  return {db, req, login, visibleId: visible.id, hiddenId: hidden.id};
}

test('パイプラインAPI: 作品横断で段階別集計・次の行動の期限切れ・納期超過・遅延提出を返す', async (t) => {
  const {db, req, visibleId, hiddenId} = await fixture({t});
  try {
    const result = await req('/sales-pipeline?asOf=2026-09-24');
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const body = result.data;
    assert.deepEqual(body.works.map((work) => work.id).sort(), [1, 3], '管理者は組織の全作品');
    assert.ok(body.opportunities.some((row) => row.id === hiddenId));
    const stages = Object.fromEntries(body.summary.stages.map((row) => [row.stage, row]));
    assert.equal(stages.proposal.count, 1);
    assert.equal(stages.lead.unknownCount, 1);
    assert.equal(stages.negotiation.expectedYen, 700000);
    assert.equal(body.summary.open.expectedYen, 850000);
    const visible = body.opportunities.find((row) => row.id === visibleId);
    assert.equal(visible.next_action, '回答を確認');
    assert.equal(visible.next.label, '期限切れ（4日）');
    assert.equal(visible.partner_name, '架空配信');
    assert.equal(visible.work_title, '風のあとさき');
    assert.equal(body.summary.nextActionOverdue, 1);
    const byTitle = Object.fromEntries(body.deliverables.map((row) => [row.title, row]));
    assert.equal(byTitle['架空本編マスター'].timing.label, '遅延提出（1日）');
    assert.equal(byTitle['架空予告編'].timing.label, '納期超過（4日）');
    assert.equal(byTitle['架空字幕'].timing.label, '期限まで26日');
    assert.equal(byTitle['架空本編マスター'].term_label, '第1版（初版）');
    assert.equal(byTitle['架空本編マスター'].contract_code, 'PIPE-1');
    assert.equal(body.summary.deliverableOverdue, 1);
    assert.equal(body.summary.lateSubmitted, 1);
    assert.equal((await req('/sales-pipeline?asOf=2026-13-01')).status, 400);
  } finally {
    await db.close();
  }
});

test('パイプラインAPI: 権限外の作品は出ない（編集担当・別組織）、制作担当は403', async (t) => {
  const {db, req, login, hiddenId} = await fixture({t});
  try {
    const editor = await login('editor@openingnight.invalid');
    const mine = (await req('/sales-pipeline?asOf=2026-09-24', null, editor)).data;
    assert.deepEqual(mine.works.map((work) => work.id), [1]);
    assert.ok(!mine.opportunities.some((row) => row.id === hiddenId || row.work_id === 3), '所属しない案件の作品は出ない');
    assert.equal(mine.summary.stages.find((row) => row.stage === 'negotiation').count, 0, '集計にも入らない');
    assert.equal((await req('/sales-pipeline?workId=3', null, editor)).status, 403);
    const one = (await req('/sales-pipeline?workId=1&asOf=2026-09-24')).data;
    assert.ok(one.opportunities.every((row) => row.work_id === 1));
    assert.equal((await req('/sales-pipeline', null, await login('production@openingnight.invalid'))).status, 403);
    const outsider = (await req('/sales-pipeline', null, await login('outsider@other.invalid'))).data;
    assert.ok(outsider.works.every((work) => work.id === 2), '別組織は自分の組織の作品だけ');
    assert.equal(outsider.opportunities.length, 0);
    assert.equal(outsider.deliverables.length, 0);
  } finally {
    await db.close();
  }
});

test('a delivery submitted after the chosen as-of date is judged as not yet submitted on that date', () => {
  const row = {due_on: '2026-09-10', status: 'submitted', submitted_on: '2026-09-20'};
  const then = deliverableTiming(row, '2026-09-15');
  assert.deepEqual([then.code, then.overdue, then.late, then.future], ['overdue', true, false, true], 'on 9/15 it was 5 days overdue and unsubmitted');
  const now = deliverableTiming(row, '2026-09-24');
  assert.deepEqual([now.code, now.label], ['late_submitted', '遅延提出（10日）']);
});
