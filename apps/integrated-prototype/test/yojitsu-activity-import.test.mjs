// 活動記録のステップと営業の活動の取り込み（行動指標の計画 段B #10）を、純関数（src/revenue/yojitsu/activity-import-model.mjs）と、
// 受け口（POST /api/revenue/activity-imports/sales-activities。activity-import-routes.mjs）・予実の4段の受け口（GET /api/revenue/yojitsu。フェーズ1 #14）で確かめる。
// 期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-017（細目の段は親の step に畳んで数える）・020（段A の数え方
// contact＝面談・proposal＝提案、段B は活動記録に1本化し source_sales_activity_id で二度数えない）と、project-cashflow-forecast-actual.md の
// FR-REV-YOJITSU-017・035・037 から持ってくる。細目の段は指標マスタの種（test/fixtures/kpi-metrics/seed.json。段B #9）の行を使う。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。架空のデータだけを使う（組織1・2と利用者・取引先は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {SALES_ACTIVITY_STEPS, planSalesActivityImport} from '../src/revenue/yojitsu/activity-import-model.mjs';
import {countActivitySteps} from '../src/revenue/yojitsu/activity-model.mjs';
import {periodStarts} from '../src/revenue/yojitsu/yojitsu-model.mjs';
import {readKpiMetricsSeed, seedDetailSteps} from '../scripts/seed-kpi-metrics-demo.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const EDITOR = 2; // 組織1の編集担当（試作の行）
const PARTNER = 2; // 組織1の取引先「架空配信」（試作の行）
const IMPORT_PATH = '/api/revenue/activity-imports/sales-activities';
const count = async (db, sql, params = []) => Number((await db.get(sql, params)).n);

// 参照表の行（純関数の試験用）: 面談・提案・契約と、種の細目の段
const seedSteps = () => [{code: 'meeting', parent_code: null}, {code: 'proposal', parent_code: null}, {code: 'contract', parent_code: null},
  ...readKpiMetricsSeed().steps.map((s) => ({code: s.code, parent_code: s.parent}))];
const row = (overrides) => ({id: 1, project_id: 10, work_id: 20, opportunity_id: 30, opportunity_stage: 'negotiation', partner_name: '架空配信',
  occurred_on: '2026-10-05', activity_type: 'contact', summary: '架空の接触', next_action: null, next_due_on: null, created_by: EDITOR, imported_id: null, result: 'advanced', ...overrides});

test('FR-REV-KPI-017 FR-REV-KPI-020 FR-REV-YOJITSU-035 営業の活動の種別は 接触→面談・提案→取引先への提案（提案に畳む）・交渉とメモ→数えない で読み替え、結果は明示した値を保ち、取り込み済みの行は足さない', () => {
  assert.deepEqual({...SALES_ACTIVITY_STEPS}, {contact: 'meeting', proposal: 'buyer_proposal', negotiation: null, note: null});
  const steps = seedSteps();
  // 「取引先への提案」は種の細目の段で、親は提案（ontology の「行動の段」の営業（売り））
  assert.deepEqual(steps.find((s) => s.code === 'buyer_proposal'), {code: 'buyer_proposal', parent_code: 'proposal'});
  const rows = [
    // 商談30（交渉中）: 接触 → 提案 → 交渉 → メモ。最後の行だけ保留、ほかは進んだ（日付の順。入力の並びに依らない）
    row({id: 4, occurred_on: '2026-10-25', activity_type: 'note', summary: '架空のメモ', result: 'on_hold'}),
    row({id: 1, occurred_on: '2026-10-05'}),
    row({id: 2, occurred_on: '2026-10-12', activity_type: 'proposal', summary: '架空の提案', next_action: '架空の返事を待つ', next_due_on: '2026-10-20'}),
    row({id: 3, occurred_on: '2026-10-20', activity_type: 'negotiation', summary: '架空の交渉'}),
    // 商談31（失注）: 最後の行は失注。商談32（受注）: 最後の行も進んだ
    row({id: 5, opportunity_id: 31, opportunity_stage: 'lost', occurred_on: '2026-11-02', created_by: ADMIN, result: 'lost'}),
    row({id: 6, opportunity_id: 32, opportunity_stage: 'won', occurred_on: '2026-10-07', activity_type: 'proposal'}),
    // 商談33（取り込み済みの行のあとに新しい行）: 取り込み済みの行は足さず、新しい行は商談の最後の行として結果を導く
    row({id: 7, opportunity_id: 33, opportunity_stage: 'lead', occurred_on: '2026-10-01', imported_id: 900}),
    row({id: 8, opportunity_id: 33, opportunity_stage: 'lead', occurred_on: '2026-10-09', result: 'on_hold'}),
  ];
  const plan = planSalesActivityImport(rows, {steps});
  assert.deepEqual(plan.errors, []);
  const byId = new Map(plan.records.map((r) => [r.sourceSalesActivityId, r]));
  assert.deepEqual([...byId.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 8]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 8].map((id) => [id, byId.get(id).step, byId.get(id).result]), [
    [1, 'meeting', 'advanced'], [2, 'buyer_proposal', 'advanced'], [3, null, 'advanced'], [4, null, 'on_hold'],
    [5, 'meeting', 'lost'], [6, 'buyer_proposal', 'advanced'], [8, 'meeting', 'on_hold']]);
  // 案件・作品・日付・したこと・次の一手と期日は元の行のまま、稼ぎ方と成果物は空（稼ぎ方は数えるときに案件の稼ぎ方）、記録した人は元の行を記録した人
  assert.deepEqual(byId.get(2), {projectId: 10, occurredOn: '2026-10-12', earningType: null, step: 'buyer_proposal', counterparty: '架空配信', summary: '架空の提案',
    deliverable: null, nextAction: '架空の返事を待つ', nextDueOn: '2026-10-20', result: 'advanced', workId: 20, sourceSalesActivityId: 2, createdBy: EDITOR});
  assert.equal(byId.get(5).createdBy, ADMIN);
  // 件数: 親の段に畳んだ数（段A と同じ: 接触3＝面談、提案2＝提案、契約は営業の活動から出ない）と、数えない行（交渉・メモ）
  assert.deepEqual(plan.summary, {read: 8, alreadyImported: 1, imported: 7, counted: {meeting: 3, proposal: 2, contract: 0}, uncounted: 2,
    dueDateDropped: 0, counterpartyOmitted: 0, rejected: []});
  // 何度読み直しても同じ（取り込んだ行を取り込み済みにすると、足す行は0）
  const again = planSalesActivityImport(rows.map((r) => ({...r, imported_id: r.imported_id ?? 1000 + r.id})), {steps});
  assert.deepEqual([again.records, again.summary.imported, again.summary.alreadyImported], [[], 0, 8]);
});

test('FR-REV-KPI-020 FR-REV-YOJITSU-035 取り込めない営業の活動の行は足さずに元の行の id を返し、次の一手の無い期日と長すぎる相手の名前は入れずに数え、要る細目の段が参照表に無ければ何も足さない', () => {
  const steps = seedSteps();
  const plan = planSalesActivityImport([
    row({id: 1, next_due_on: '2026-10-30'}), // 期日だけで次の一手が無い（活動記録の期日は次の一手に付ける）
    row({id: 2, opportunity_id: 31, partner_name: 'あ'.repeat(201)}), // 相手の名前は200字まで
    row({id: 3, opportunity_id: 32, occurred_on: '2026/10/05'}), // 日付の形が違う
    row({id: 4, opportunity_id: 33, summary: '  '}), // したことが空
    row({id: 5, opportunity_id: 34, activity_type: 'visit'}), // 種別が4つのどれでもない
  ], {steps});
  assert.deepEqual(plan.records.map((r) => [r.sourceSalesActivityId, r.nextDueOn, r.counterparty]), [[1, null, '架空配信'], [2, null, null]]);
  assert.deepEqual(plan.summary.rejected, [{salesActivityId: 3, fields: ['occurredOn']}, {salesActivityId: 4, fields: ['summary']}, {salesActivityId: 5, fields: ['activityType']}]);
  assert.deepEqual([plan.summary.dueDateDropped, plan.summary.counterpartyOmitted, plan.summary.imported], [1, 1, 2]);
  // 細目の段の無い参照表: 提案の行があれば何も足さない。接触だけなら親の段なので足せる
  const topOnly = steps.filter((s) => s.parent_code === null);
  const blocked = planSalesActivityImport([row({id: 1}), row({id: 2, activity_type: 'proposal', occurred_on: '2026-10-06'})], {steps: topOnly});
  assert.deepEqual([blocked.records, blocked.summary.imported, blocked.errors.map((e) => e.step)], [[], 0, ['buyer_proposal']]);
  const contactOnly = planSalesActivityImport([row({id: 1})], {steps: topOnly});
  assert.deepEqual([contactOnly.errors, contactOnly.records.map((r) => r.step)], [[], ['meeting']]);
});

// 期間（1〜5年目）・種の細目の段・型と稼ぎ方のある架空の案件（買付と自社出資）・買付の案件の作品と商談と営業の活動を足す
async function setup(db) {
  await store.definePeriods(db, 1, periodStarts('2026-10-01').map((startsOn, i) => ({yearNo: i + 1, startsOn})), {createdBy: ADMIN});
  const steps = await seedDetailSteps(db);
  assert.deepEqual(steps, {added: readKpiMetricsSeed().steps.length, existing: 0});
  const project = (code, projectType, earningType) => planning.createProject(db, 1, {code, title: `${code}（架空）`, projectType, earningType, baseAmountYen: null,
    revenueRateBps: null, counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null}, {createdBy: ADMIN});
  const buy = await project('FICT-IMP-1', 'acquisition', 'acquisition');
  const own = await project('FICT-IMP-2', 'production', 'own_investment');
  const work = Number((await db.get("INSERT INTO works(org_id,project_id,code,title,format) VALUES(1,?,'FICT-IMP-W1','架空の買付作品','film') RETURNING id", [buy])).id);
  const opportunity = async (name, stage) => Number((await db.get(`INSERT INTO sales_opportunities(org_id,project_id,work_id,partner_id,name,stage)
    VALUES(1,?,?,?,?,?) RETURNING id`, [buy, work, PARTNER, name, stage])).id);
  const salesActivity = async (opportunityId, occurredOn, type, by = ADMIN) => Number((await db.get(`INSERT INTO sales_activities(org_id,project_id,work_id,
    opportunity_id,partner_id,occurred_on,activity_type,summary,created_by,result) VALUES(1,?,?,?,?,?,?,?,?,?) RETURNING id`,
  [buy, work, opportunityId, PARTNER, occurredOn, type, `架空の${type}（${occurredOn}）`, by, by === EDITOR ? 'lost' : type === 'note' ? 'on_hold' : 'advanced'])).id);
  const pending = await opportunity('架空の商談（交渉中）', 'negotiation');
  const lost = await opportunity('架空の商談（失注）', 'lost');
  const won = await opportunity('架空の商談（受注）', 'won');
  const sales = [
    await salesActivity(pending, '2026-10-05', 'contact'), await salesActivity(pending, '2026-10-12', 'proposal'),
    await salesActivity(pending, '2026-10-20', 'negotiation'), await salesActivity(pending, '2026-10-25', 'note'),
    await salesActivity(lost, '2026-11-02', 'contact', EDITOR),
    await salesActivity(won, '2026-10-07', 'contact'), await salesActivity(won, '2026-10-15', 'proposal'),
  ];
  return {buy, own, work, sales};
}

function appFor(db) {
  const app = createApp({db, mode: 'local'});
  return async (email) => {
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(login.status, 200, email);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return async (path, method = 'GET') => {
      const res = await app.request(path, {method, headers: {cookie, 'content-type': 'application/json'}});
      const text = await res.text();
      return {status: res.status, text, body: JSON.parse(text)};
    };
  };
}

test('FR-REV-KPI-020 FR-REV-YOJITSU-035 FR-REV-YOJITSU-037 営業の活動の取り込みは管理者だけで、2回流しても増えず、行は元の行を記録した人の本人にだけ見え、応答と変更の記録に行の中身が出ない', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  const as = appFor(db);
  const admin = await as('admin@openingnight.invalid');
  // 管理者のほかは取り込めない（編集担当・制作担当は 403。何も足さない）
  for (const email of ['editor@openingnight.invalid', 'production@openingnight.invalid']) {
    assert.equal((await (await as(email))(IMPORT_PATH, 'POST')).status, 403, email);
  }
  const records = () => count(db, 'SELECT COUNT(*) AS n FROM yojitsu_activity_records WHERE org_id=1');
  const audits = () => count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE org_id=1 AND entity_type='yojitsu_activity_record'");
  assert.deepEqual([await records(), await audits()], [0, 0]);

  const first = await admin(IMPORT_PATH, 'POST');
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, {ok: true, read: 7, alreadyImported: 0, imported: 7, counted: {meeting: 3, proposal: 2, contract: 0}, uncounted: 2,
    dueDateDropped: 0, counterpartyOmitted: 0, rejected: []});
  for (const content of ['架空の', 'contact', '架空配信']) assert.ok(!first.text.includes(content), `応答に行の中身（${content}）が出る`);
  assert.deepEqual([await records(), await audits()], [7, 7]);
  // 2回目は何も足さず、取り込み済みの件数を返す（200）。行も変更の記録も増えない
  const second = await admin(IMPORT_PATH, 'POST');
  assert.equal(second.status, 200);
  assert.deepEqual([second.body.read, second.body.alreadyImported, second.body.imported], [7, 7, 0]);
  assert.deepEqual([await records(), await audits()], [7, 7]);
  // 別の組織の管理者は組織1の営業の活動を取り込まない
  const outsider = await (await as('outsider@other.invalid'))(IMPORT_PATH, 'POST');
  assert.deepEqual([outsider.status, outsider.body.read, outsider.body.imported], [200, 0, 0]);
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM yojitsu_activity_records WHERE org_id=2'), 0);

  // 取り込んだ行は元の行の id を1回ずつ持ち、案件・作品・日付・したことは元の行のまま
  const imported = await db.all(`SELECT a.source_sales_activity_id AS source,a.project_id,a.work_id,a.occurred_on,a.summary,a.step,a.result,a.created_by,a.earning_type,
      s.project_id AS s_project,s.work_id AS s_work,s.occurred_on AS s_on,s.summary AS s_summary,s.created_by AS s_by
    FROM yojitsu_activity_records a JOIN sales_activities s ON s.org_id=a.org_id AND s.id=a.source_sales_activity_id WHERE a.org_id=1 ORDER BY a.source_sales_activity_id`);
  assert.deepEqual(imported.map((r) => Number(r.source)), ctx.sales);
  for (const r of imported) {
    assert.deepEqual([Number(r.project_id), Number(r.work_id), r.occurred_on, r.summary, Number(r.created_by), r.earning_type],
      [Number(r.s_project), Number(r.s_work), r.s_on, r.s_summary, Number(r.s_by), null]);
  }
  assert.deepEqual(imported.map((r) => [r.step, r.result]), [['meeting', 'advanced'], ['buyer_proposal', 'advanced'], [null, 'advanced'], [null, 'on_hold'],
    ['meeting', 'lost'], ['meeting', 'advanced'], ['buyer_proposal', 'advanced']]);
  // 行の中身は記録した人の本人にだけ返る（編集担当が記録した失注の接触は、編集担当にだけ見える。管理者が取り込んでも管理者には見えない）
  const mine = await store.readActivityRecords(db, 1, [ctx.buy], {viewerUserId: EDITOR});
  assert.deepEqual(mine.map((r) => [r.sourceSalesActivityId, r.result]), [[ctx.sales[4], 'lost']]);
  assert.ok(!(await store.readActivityRecords(db, 1, [ctx.buy], {viewerUserId: ADMIN})).some((r) => r.sourceSalesActivityId === ctx.sales[4]));
  // 変更の記録は取り込んだ人の1行ずつで、対象は足した行の id。行の中身・案件・ステップを残さない
  const audit = await db.all("SELECT user_id,action,entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='yojitsu_activity_record' ORDER BY id");
  const ids = (await db.all('SELECT id FROM yojitsu_activity_records WHERE org_id=1 ORDER BY source_sales_activity_id')).map((r) => String(r.id));
  assert.deepEqual(audit.map((r) => [Number(r.user_id), r.action, r.entity_id, r.detail_json]), ids.map((id) => [ADMIN, 'import', id, '{}']));
  // 営業の活動の行は変えない（取り込みは読むだけ）
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM sales_activities WHERE org_id=1 AND project_id=?', [ctx.buy]), ctx.sales.length);
});

test('FR-REV-KPI-020 細目の段が参照表に無い DB では、提案の行がある取り込みは何も足さずに 409 を返す', async (t) => {
  const db = await openTestDb({t});
  const buy = await planning.createProject(db, 1, {code: 'FICT-IMP-3', title: '架空の買付（細目なし）', projectType: 'acquisition', earningType: 'acquisition',
    baseAmountYen: null, revenueRateBps: null, counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null}, {createdBy: ADMIN});
  const work = Number((await db.get("INSERT INTO works(org_id,project_id,code,title,format) VALUES(1,?,'FICT-IMP-W3','架空の作品（細目なし）','film') RETURNING id", [buy])).id);
  const opportunity = Number((await db.get("INSERT INTO sales_opportunities(org_id,project_id,work_id,partner_id,name,stage) VALUES(1,?,?,?,'架空の商談','proposal') RETURNING id",
    [buy, work, PARTNER])).id);
  await db.run(`INSERT INTO sales_activities(org_id,project_id,work_id,opportunity_id,partner_id,occurred_on,activity_type,summary,created_by)
    VALUES(1,?,?,?,?,'2026-10-12','proposal','架空の提案',1)`, [buy, work, opportunity, PARTNER]);
  const admin = await appFor(db)('admin@openingnight.invalid');
  const res = await admin(IMPORT_PATH, 'POST');
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.details.errors.map((e) => e.step), ['buyer_proposal']);
  assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM yojitsu_activity_records WHERE org_id=1'), 0);
});

test('FR-REV-KPI-017 FR-REV-KPI-020 FR-REV-YOJITSU-017 細目の段で記録した行も取り込んだ行も、予実の4段の行動の実績件数で親の段（面談・提案・契約）に畳んで数え、取り込みで増えた件数は段A の数え方と同じ', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  const admin = await appFor(db)('admin@openingnight.invalid');
  // プロデューサーの自社出資の細目の段（企画書→面談、稟議の申請→提案、決裁と出資の払込→契約）と、営業の仕入れの買付の細目（権利元との面談→面談）を記録する
  const record = (projectId, occurredOn, step) => store.addActivityRecord(db, 1, {projectId, occurredOn, earningType: null, step, counterparty: null,
    summary: `架空の${step}`, deliverable: null, nextAction: null, nextDueOn: null, result: 'advanced', workId: null, sourceSalesActivityId: null}, {createdBy: ADMIN});
  await record(ctx.own, '2026-10-03', 'pitch_document');
  await record(ctx.own, '2026-10-09', 'approval_request');
  await record(ctx.own, '2026-11-10', 'approval_decision');
  await record(ctx.own, '2026-11-20', 'investment_payment');
  await record(ctx.buy, '2026-10-01', 'rights_holder_meeting');
  const actual = (view, step) => {
    const row = view.rows.find((r) => r.key === `action_actual:${step}`);
    return Object.fromEntries(view.months.map((m, i) => [m.slice(0, 7), row.months[i]]).filter(([, n]) => n !== null));
  };
  const typed = (view, earningType, step) => view.action.earningTypes.find((e) => e.earningType === earningType).periods[0].actuals[step];
  const before = (await admin('/api/revenue/yojitsu')).body;
  assert.deepEqual([actual(before, 'meeting'), actual(before, 'proposal'), actual(before, 'contract')],
    [{'2026-10': 2}, {'2026-10': 1}, {'2026-11': 2}]);
  assert.deepEqual([typed(before, 'own_investment', 'meeting'), typed(before, 'own_investment', 'contract'), typed(before, 'acquisition', 'meeting')], [1, 2, 1]);

  assert.equal((await admin(IMPORT_PATH, 'POST')).status, 201);
  const after = (await admin('/api/revenue/yojitsu')).body;
  // 段A の数え方（contact＝面談・proposal＝提案。交渉・メモは数えない）で営業の活動を月ごとに数えた件数
  const stageA = {meeting: {}, proposal: {}};
  for (const s of await db.all('SELECT occurred_on,activity_type FROM sales_activities WHERE org_id=1 AND project_id=?', [ctx.buy])) {
    const step = {contact: 'meeting', proposal: 'proposal'}[s.activity_type];
    if (step) stageA[step][s.occurred_on.slice(0, 7)] = (stageA[step][s.occurred_on.slice(0, 7)] ?? 0) + 1;
  }
  assert.deepEqual(stageA, {meeting: {'2026-10': 2, '2026-11': 1}, proposal: {'2026-10': 2}});
  for (const step of ['meeting', 'proposal', 'contract']) {
    const grown = Object.fromEntries(Object.entries(actual(after, step)).map(([m, n]) => [m, n - (actual(before, step)[m] ?? 0)]).filter(([, n]) => n !== 0));
    assert.deepEqual(grown, stageA[step] ?? {}, `${step} の増えた件数`);
  }
  // 取り込んだ行は案件の稼ぎ方（買付）で数え、自社出資の件数は変わらない
  assert.deepEqual([typed(after, 'acquisition', 'meeting'), typed(after, 'acquisition', 'proposal'), typed(after, 'own_investment', 'meeting'),
    typed(after, 'own_investment', 'contract')], [4, 2, 1, 2]);
  // 4段の実績件数の和が行動の表の和と一致する照合も通る
  assert.equal(after.checks.find((c) => c.code === 'action_actual_by_table').ok, true);
  // 2回目の取り込みのあとも件数は同じ（二度数えない）
  assert.equal((await admin(IMPORT_PATH, 'POST')).status, 200);
  const again = (await admin('/api/revenue/yojitsu')).body;
  for (const step of ['meeting', 'proposal', 'contract']) assert.deepEqual(actual(again, step), actual(after, step));
  // 数え方は store の件数（readActivityTallies）と純関数（countActivitySteps）でも同じ: 細目の段は親へ、交渉とメモ（ステップが空）は数えない
  const tallies = await store.readActivityTallies(db, 1, [ctx.buy, ctx.own]);
  const counted = countActivitySteps(tallies, {steps: await planning.listActionSteps(db), periods: await store.listPeriods(db, 1)});
  assert.deepEqual([...counted.byPeriod].sort(), [['acquisition|meeting|1', 4], ['acquisition|proposal|1', 2], ['own_investment|contract|1', 2],
    ['own_investment|meeting|1', 1], ['own_investment|proposal|1', 1]]);
  assert.deepEqual(counted.skipped, {noStep: 2, noEarningType: 0});
});
