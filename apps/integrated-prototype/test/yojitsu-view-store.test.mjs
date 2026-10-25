// 予実の4段の読み取りの一括（src/revenue/revenue-store.mjs の readYojitsuSources。SQL を10本以内にするため、#10b・#11・#13 の読み取りを
// 9つの文にまとめた形）が、元の読み取り関数（readPlans・readRevenueClassInputs・readForecasts・readActivityTallies）と同じ定義で読むことを、
// 架空の種と境目の行で確かめる（フェーズ1の仕様書 #14）。期待値は要件 FR-REV-YOJITSU-012（有効な計画＝期間ごとの最新の採用の記録）・
// 023（有効な予測＝案件ごとの最新の版。行の欠けた版は有効にしない）・028（「予測に使う＝はい」の行だけを足す）・017（取り消した活動記録は数えない、
// 細目は親のステップへ畳む）・019（案件の段階は段階の履歴の最新の行から導く）・020（使う売上率）と、元の関数の値。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import {revenueClassBases} from '../src/revenue/revenue-class/revenue-class-model.mjs';
import {countActivitySteps} from '../src/revenue/yojitsu/activity-model.mjs';
import {forecastCashflowByMonth} from '../src/revenue/yojitsu/forecast-model.mjs';
import {addForecastVersionWithUnusedLine, loadYojitsuSeed} from './yojitsu-view-fixture.mjs';

const ADMIN_SCOPE = {sql: 'SELECT id FROM projects WHERE org_id=?', params: [1]}; // 管理者の「見てよい案件」（src/app.mjs の permittedProjectScope と同じ形）

test('FR-REV-YOJITSU-012 FR-REV-YOJITSU-019 FR-REV-YOJITSU-020 FR-REV-YOJITSU-023 FR-REV-YOJITSU-028 FR-REV-YOJITSU-017 読み取りの一括は、計画・段階と売上率・予測に使う行・活動記録を元の読み取り関数と同じ定義で読む', async (t) => {
  const db = await openTestDb({t});
  const {owner, projectId} = await load(db);
  const projectIds = (await db.all('SELECT id FROM projects WHERE org_id=1')).map((r) => Number(r.id)); // 管理者が見てよい案件（試作の案件1と種の32件）
  assert.equal(projectIds.length, projectId.size + 1);
  // 境目の行: 1年目の計画を第1版へ戻す（採用の記録を足す）。案件 YJ-P01 の予測に行の欠けた版を足す（アプリを通さない書き込み）。活動記録を1行取り消す
  const period1 = (await store.listPeriods(db, 1))[0].id;
  await store.adoptPlanVersion(db, 1, {periodId: period1, versionNo: 1, adoptedOn: '2026-11-20'}, {createdBy: owner});
  const p01 = projectId.get('YJ-P01');
  const next = Number((await db.get('SELECT MAX(version_no) AS v FROM yojitsu_forecast_versions WHERE org_id=1 AND project_id=?', [p01])).v) + 1;
  await db.run(`INSERT INTO yojitsu_forecast_versions(org_id,project_id,version_no,label,source_kind,source,line_count,created_on,created_by)
    VALUES(1,?,?,'架空の欠けた版','manual','架空',2,'2026-11-21',?)`, [p01, next, owner]);
  const category = (await planning.listCashflowCategories(db, 1)).find((c) => c.direction === 'in' && Number(c.counts_as_revenue) === 1);
  await db.run(`INSERT INTO yojitsu_forecast_lines(org_id,project_id,version_no,line_no,scenario,forecast_month,category_id,item,amount_yen,status,use_for_forecast)
    VALUES(1,?,?,1,'good','2026-12-01',?,'架空の行',9999999,'provisional',1)`, [p01, next, category.id]);
  const activity = await db.get("SELECT id FROM yojitsu_activity_records WHERE org_id=1 AND step IS NOT NULL ORDER BY id LIMIT 1");
  await store.cancelActivityRecord(db, 1, {activityId: Number(activity.id), cancelledOn: '2026-11-22', reason: '架空の取消'}, {createdBy: owner});
  // 境目の行（つづき）: 案件 YJ-P02 の有効な版の行を写し、売上の元の区分に「予測に使う＝いいえ」の行を1行足した版を足す（試算の取り込みが除外した
  // 流通の行の形）。案件 YJ-P01 の段階を 契約済み→見送り へ1回変える（段階の履歴が2行になる）
  const p02 = projectId.get('YJ-P02');
  const p02Scope = {sql: 'SELECT id FROM projects WHERE org_id=? AND id=?', params: [1, p02]};
  const p02SumsBefore = (await store.readYojitsuSources(db, 1, {scope: p02Scope, viewerUserId: owner})).forecastSums;
  assert.ok(p02SumsBefore.length > 0);
  const unused = {scenario: 'good', month: '2027-01-01', categoryId: Number(category.id), item: '架空の除外した流通の行', counterparty: null, amountYen: 7777777, status: 'provisional'};
  const unusedVersion = await addForecastVersionWithUnusedLine(db, {projectId: p02, owner, line: unused});
  await planning.recordStageChange(db, 1, {projectId: p01, stageCode: 'declined', previousStageCode: 'contracted', enteredOn: '2026-11-24', evidence: null,
    reason: '架空の見送りの理由', createdBy: owner});

  const sources = await store.readYojitsuSources(db, 1, {scope: ADMIN_SCOPE, viewerUserId: owner});
  // 計画: 期間ごとの最新の採用の記録が指す版（1年目は第1版へ戻った）
  const plans = await store.readPlans(db, 1, {viewerUserId: owner});
  assert.deepEqual(sources.plans, plans);
  assert.deepEqual(await store.readEffectivePlans(db, 1, {viewerUserId: owner}), plans);
  assert.deepEqual(sources.plans.map((p) => [p.yearNo, p.versionNo]), [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
  // 持ち主でない人には第1版の額が返らない（readPlans と同じ）
  assert.deepEqual((await store.readYojitsuSources(db, 1, {scope: ADMIN_SCOPE, viewerUserId: 1})).plans, await store.readPlans(db, 1, {viewerUserId: 1}));
  // 期間・設定・語の設定
  assert.deepEqual(sources.periods, await store.listPeriods(db, 1));
  assert.deepEqual(sources.settings, await store.readEffectiveSettings(db, 1));
  assert.deepEqual(sources.choices, await store.readEffectiveChoices(db, 1));
  // 売上率（4区分の導き方と同じ材料）
  const classic = await planning.readRevenueClassInputs(db, 1, projectIds);
  assert.deepEqual([...revenueClassBases(sources.revenueClassInputs)], [...revenueClassBases(classic)]);
  assert.deepEqual(sources.projects.map((p) => [p.id, p.probability_bps]), classic.projects.map((p) => [Number(p.id), p.probability_bps === null ? null : Number(p.probability_bps)]));
  // 段階: 段階を変えた案件も1行だけで、段階と確度は段階の履歴の最新の行（見送り＝0）の値
  assert.deepEqual(sources.projects.map((p) => p.id), [...projectIds].sort((a, b) => a - b), '案件ごとに1行');
  assert.deepEqual(sources.projects.filter((p) => p.id === p01).map((p) => [p.stage_code, p.probability_bps]), [['declined', 0]]);
  // 予測: 有効な版の予測に使う行のうち、売上の元になる入金の区分の額を案件×月×シナリオで足したもの（行の欠けた版の案件は有効な予測が無い）
  assert.ok(!sources.forecastSums.some((r) => r.project_id === p01), '最新の版の行が欠けた案件は有効な予測にしない');
  const categories = await planning.listCashflowCategories(db, 1);
  const revenueIds = new Set(categories.filter((c) => c.direction === 'in' && Number(c.counts_as_revenue) === 1).map((c) => Number(c.id)));
  const versions = await store.readForecasts(db, 1, projectIds);
  // 「予測に使う＝いいえ」の行は有効な最新の版にあっても足さない（readForecasts の used が偽の行と同じ）。YJ-P02 の和は行を足す前と同じ
  const p02Version = versions.find((v) => v.projectId === p02);
  assert.deepEqual([p02Version.versionNo, p02Version.effective], [unusedVersion, true]);
  assert.deepEqual(p02Version.lines.filter((l) => !l.used).map((l) => [l.item, l.amountYen, l.useForForecast]), [[unused.item, unused.amountYen, false]]);
  assert.deepEqual(sources.forecastSums.filter((r) => r.project_id === p02), p02SumsBefore);
  for (const scenario of ['even', 'good', 'max', 'single']) {
    const want = new Map();
    for (const v of versions) for (const l of v.lines) {
      if (!l.used || l.scenario !== scenario || !revenueIds.has(l.categoryId)) continue;
      const key = `${v.projectId}|${l.month}`;
      want.set(key, (want.get(key) ?? 0) + l.amountYen);
    }
    const got = new Map(sources.forecastSums.filter((r) => r.scenario === scenario).map((r) => [`${r.project_id}|${r.forecast_month}`, r.amount_yen]));
    assert.deepEqual(got, want, scenario);
  }
  // 区分×月の収支（#13 の関数）の売上の元の区分の和とも合う（採用するシナリオ good と単一）
  const flows = forecastCashflowByMonth(versions, {categories, scenario: 'good'});
  const fromFlows = [...flows].filter(([id]) => revenueIds.has(id)).reduce((sum, [, months]) => sum + [...months.values()].reduce((a, b) => a + b, 0), 0);
  const fromSums = sources.forecastSums.filter((r) => r.scenario === 'good' || r.scenario === 'single').reduce((sum, r) => sum + r.amount_yen, 0);
  assert.equal(fromSums, fromFlows);
  // 活動記録: 取り消した行を数えず、細目の段を親のステップへ畳む（#13 の数え方と同じ件数）
  const periods = sources.periods;
  const mine = countActivitySteps(sources.activityTallies, {steps: sources.activitySteps, periods});
  const theirs = countActivitySteps(await store.readActivityTallies(db, 1, projectIds), {steps: await planning.listActionSteps(db), periods});
  assert.deepEqual([[...mine.byPeriod].sort(), [...mine.byMonth].sort(), mine.skipped], [[...theirs.byPeriod].sort(), [...theirs.byMonth].sort(), theirs.skipped]);
  const total = (map) => [...map.values()].reduce((a, b) => a + b, 0);
  assert.equal(total(mine.byMonth), (await db.get(`SELECT COUNT(*) AS n FROM yojitsu_activity_records a WHERE a.org_id=1 AND a.step IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM yojitsu_activity_cancellations c WHERE c.org_id=1 AND c.activity_id=a.id)`)).n);
});

test('FR-REV-YOJITSU-005 読み取りの一括は見てよい案件の行だけを読み、別の組織の行を読まない', async (t) => {
  const db = await openTestDb({t});
  const {owner, projectId} = await load(db);
  const p01 = projectId.get('YJ-P01');
  const scope = {sql: 'SELECT id FROM projects WHERE org_id=? AND id=?', params: [1, p01]};
  const sources = await store.readYojitsuSources(db, 1, {scope, viewerUserId: owner});
  assert.deepEqual(sources.projects.map((p) => p.code), ['YJ-P01']);
  assert.ok(sources.forecastSums.every((r) => r.project_id === p01) && sources.forecastSums.length > 0);
  assert.ok(sources.activityTallies.every((r) => Number(r.project_id) === p01));
  // 入金の行は、見てよい案件の作品を含む請求の消込だけ（請求明細の作品の配賦は全部読む）
  const invoices = new Set(sources.receiptLines.map((r) => Number(r.invoice_id)));
  assert.ok(sources.receiptLines.length > 0);
  for (const id of invoices) assert.ok(sources.receiptLines.some((r) => Number(r.invoice_id) === id && Number(r.project_id) === p01), `請求 ${id}`);
  // 別の組織（組織2）は期間も計画も案件も無い
  const other = await store.readYojitsuSources(db, 2, {scope: {sql: 'SELECT id FROM projects WHERE org_id=?', params: [2]}, viewerUserId: 4});
  assert.deepEqual([other.periods, other.plans, other.forecastSums, other.receiptLines, other.activityTallies], [[], [], [], [], []]);
  assert.deepEqual(other.projects.map((p) => p.code), ['PRJ-OTHER']);
  await assert.rejects(store.readYojitsuSources(db, 1, {viewerUserId: owner}), /scope/);
});

async function load(db) {
  return loadYojitsuSeed(db);
}
