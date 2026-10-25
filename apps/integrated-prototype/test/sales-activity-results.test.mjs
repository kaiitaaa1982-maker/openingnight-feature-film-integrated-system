import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {planSalesActivityImport} from '../src/revenue/yojitsu/activity-import-model.mjs';
import {activityOutcomeSummary} from '../src/revenue/yojitsu/activity-outcomes-model.mjs';

const steps = [{code: 'meeting', parent_code: null}, {code: 'proposal', parent_code: null}, {code: 'contract', parent_code: null}];
const source = (result) => ({id: 1, project_id: 1, work_id: 1, opportunity_id: 1, opportunity_stage: 'won', partner_name: '架空の相手',
  occurred_on: '2026-10-01', activity_type: 'contact', summary: '架空の面談', created_by: 1, result});

test('FR-REV-KPI-020 FR-REV-YOJITSU-035 営業活動の結果をそのまま取り込み、未記録は受注した商談でも推定しない。後続行が増えても結果は変わらない', () => {
  const unknown = planSalesActivityImport([source(null)], {steps});
  assert.deepEqual(unknown.records, []);
  assert.deepEqual(unknown.summary.rejected, [{salesActivityId: 1, fields: ['result']}]);
  for (const result of ['advanced', 'on_hold', 'lost']) {
    const a = planSalesActivityImport([source(result)], {steps});
    const b = planSalesActivityImport([source(result), {...source('advanced'), id: 2, occurred_on: '2026-11-01', activity_type: 'note'}], {steps});
    assert.equal(a.records[0].result, result);
    assert.equal(b.records[0].result, result);
  }
});

test('FR-REV-KPI-020 結果別の分母は案件と段を重複せず、進んだを分子にし、保留・失注も分母と内訳へ入れ、未記録を0扱いしない', () => {
  const rows = [
    {id: 1, project_id: 1, earning_type: 'acquisition', step: 'meeting', occurred_on: '2026-10-01', result: 'on_hold'},
    {id: 2, project_id: 1, earning_type: 'acquisition', step: 'meeting', occurred_on: '2026-10-02', result: 'advanced'},
    {id: 3, project_id: 2, earning_type: 'acquisition', step: 'meeting', occurred_on: '2026-10-01', result: 'on_hold'},
    {id: 4, project_id: 3, earning_type: 'acquisition', step: 'meeting', occurred_on: '2026-10-01', result: 'lost'},
    {id: 5, project_id: 4, earning_type: 'acquisition', step: 'meeting', occurred_on: '2026-10-01', result: null},
  ];
  const view = activityOutcomeSummary(rows, {steps});
  assert.deepEqual(view.rows, [{earningType: 'acquisition', step: 'meeting', advanced: 1, onHold: 1, lost: 1, numerator: 1, denominator: 3, rateBps: 3333}]);
  assert.equal(view.unverifiedCount, 1);
  assert.deepEqual(activityOutcomeSummary([], {steps}).rows, []);
  const detailed = [...steps, {code: 'buyer_proposal', parent_code: 'proposal'}];
  const dated = [
    {...rows[0], step: 'buyer_proposal', occurred_on: '2026-09-30'},
    {...rows[0], id: 2, step: 'proposal', occurred_on: '2026-10-01'},
    {...rows[0], id: 3, step: 'buyer_proposal', occurred_on: '2026-10-01', result: 'advanced'},
    {...rows[0], id: 4, step: 'buyer_proposal', occurred_on: '2026-10-31', result: 'lost'},
    {...rows[0], id: 5, step: 'proposal', occurred_on: '2026-11-01', result: 'advanced'},
  ];
  assert.deepEqual(activityOutcomeSummary([...dated].reverse(), {steps: detailed, from: '2026-10-01', to: '2026-10-01'}).rows,
    [{earningType: 'acquisition', step: 'proposal', advanced: 1, onHold: 0, lost: 0, numerator: 1, denominator: 1, rateBps: 10000}]);
  assert.equal(activityOutcomeSummary(dated, {steps: detailed, from: '2026-10-01', to: '2026-10-31'}).rows[0].lost, 1);
});

test('FR-REV-KPI-020 FR-REV-YOJITSU-035 営業活動の結果欄は3値か未記録だけ。APIが結果を保存し、不正値と権限のない登録は行を残さない', async (t) => {
  const db = await openTestDb({t});
  await db.run("UPDATE projects SET project_type='acquisition',earning_type='acquisition' WHERE org_id=1 AND id=1");
  const opp = Number((await db.get("INSERT INTO sales_opportunities(org_id,project_id,work_id,partner_id,name,stage) VALUES(1,1,1,2,'架空の結果入力','lead') RETURNING id")).id);
  const app = createApp({db, mode: 'local'});
  const as = async (email) => {
    const res = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    return res.headers.get('set-cookie').split(';')[0];
  };
  const cookie = await as('admin@openingnight.invalid');
  const input = {workId: 1, opportunityId: opp, occurredOn: '2026-10-01', activityType: 'contact', summary: '架空の面談', result: 'lost'};
  const post = (body, auth = cookie) => app.request('/api/sales-activities', {method: 'POST', headers: {cookie: auth, 'content-type': 'application/json'}, body: JSON.stringify(body)});
  assert.equal((await post(input)).status, 201);
  assert.equal((await db.get('SELECT result FROM sales_activities WHERE opportunity_id=?', [opp])).result, 'lost');
  assert.equal((await post({...input, result: 'inferred'})).status, 400);
  assert.equal((await post(input, await as('production@openingnight.invalid'))).status, 403);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM sales_activities WHERE opportunity_id=?', [opp])).n), 1);
  await assert.rejects(db.run("INSERT INTO sales_activities(org_id,project_id,work_id,opportunity_id,partner_id,occurred_on,activity_type,summary,created_by,result) VALUES(1,1,1,?,2,'2026-10-01','contact','架空',1,'inferred')", [opp]), /CHECK|check/i);
  const imported = await app.request('/api/revenue/activity-imports/sales-activities', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}});
  assert.equal(imported.status, 201);
  const get = (query = '', auth = cookie) => app.request(`/api/revenue/activity-results${query}`, {headers: {cookie: auth}});
  const summary = await (await get('?from=2026-10-01&to=2026-10-01')).json();
  assert.equal(summary.rows.length, 1);
  assert.deepEqual([summary.rows[0].advanced, summary.rows[0].onHold, summary.rows[0].lost, summary.rows[0].numerator, summary.rows[0].denominator], [0, 0, 1, 0, 1]);
  assert.ok(!JSON.stringify(summary).includes('架空の面談'));
  assert.deepEqual((await (await get('?from=2026-10-02')).json()).rows, []);
  for (const query of ['?from=2026-02-30', '?from=2026-11-01&to=2026-10-01']) assert.equal((await get(query)).status, 400);
  assert.equal((await get('', await as('production@openingnight.invalid'))).status, 403);
  assert.deepEqual((await (await get('', await as('outsider@other.invalid'))).json()).rows, []);
  const record = await db.get('SELECT id,created_by FROM yojitsu_activity_records WHERE source_sales_activity_id=(SELECT id FROM sales_activities WHERE opportunity_id=?)', [opp]);
  await db.run("INSERT INTO yojitsu_activity_cancellations(org_id,activity_id,cancelled_on,reason,created_by) VALUES(1,?,'2026-10-02','架空の取消',?)", [record.id, record.created_by]);
  assert.deepEqual((await (await get()).json()).rows, []);
  const {result: ignored, ...legacy} = input;
  assert.equal((await post(legacy)).status, 201);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM sales_activities WHERE opportunity_id=? AND result IS NULL', [opp])).n), 1);
  assert.equal((await (await app.request('/api/revenue/activity-imports/sales-activities', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}})).json()).imported, 0);
});
