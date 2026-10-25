// 案件収支の予実の案件×月の予測の版と活動記録（フェーズ1の仕様書 #13、移行 0015）を、DB の制約と store（src/revenue/revenue-store.mjs）と
// 純関数（src/revenue/yojitsu/forecast-model.mjs・activity-model.mjs）で確かめる。期待値は要件 docs/requirements/revenue/project-cashflow-forecast-actual.md の
// FR-REV-YOJITSU-015・017・023・029・035・037 から持ってくる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 架空のデータだけを使う（組織1・2と利用者・試作の案件と作品は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {BULK_ENTITIES} from '../src/bulk/bulk-entities.mjs';
import {CREATOR_ONLY_TABLES} from '../src/admin/data-browser-routes.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {MAX_FORECAST_LINES, forecastCashflowByMonth, normalizeForecastVersionInput} from '../src/revenue/yojitsu/forecast-model.mjs';
import {countActivitySteps, engagedProjectCounts, normalizeActivityCancellation, normalizeActivityInput} from '../src/revenue/yojitsu/activity-model.mjs';
import {periodStarts} from '../src/revenue/yojitsu/yojitsu-model.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const EDITOR = 2; // 組織1の編集担当（試作の行）
const OUTSIDER = 4; // 組織2の管理者（試作の行）
const DEMO_PROJECT = 1; // 組織1の試作の案件（作品1を持つ）
const DEMO_WORK = 1;
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});
const raw = (db, sql, params = []) => db.run(sql, params);

// 区分マスタ（入金の流通売上・出金の出資）と、型と稼ぎ方のある架空の案件（自社出資と買付）を足す
async function setup(db) {
  const categories = [
    {id: await planning.addCashflowCategory(db, 1, {code: 'distribution_sales', label: '流通売上', direction: 'in', countsAsRevenue: 1, sortOrder: 1}), direction: 'in'},
    {id: await planning.addCashflowCategory(db, 1, {code: 'investment', label: '出資', direction: 'out', countsAsRevenue: 0, sortOrder: 5}), direction: 'out'},
  ];
  const otherCategory = await planning.addCashflowCategory(db, 2, {code: 'distribution_sales', label: '流通売上', direction: 'in', countsAsRevenue: 1, sortOrder: 1});
  const project = (code, projectType, earningType) => planning.createProject(db, 1, {code, title: `${code}（架空）`, projectType, earningType, baseAmountYen: null,
    revenueRateBps: null, counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null}, {createdBy: ADMIN});
  const own = await project('FICT-FC-1', 'production', 'own_investment');
  const buy = await project('FICT-FC-2', 'acquisition', 'acquisition');
  return {categories, inflow: categories[0].id, outflow: categories[1].id, otherCategory, own, buy};
}
const forecast = (ctx, overrides = {}, lines = null) => {
  const n = normalizeForecastVersionInput({projectId: ctx.own, previousVersionNo: 0, label: '架空の試算 第1版', sourceKind: 'manual', source: '架空の手入力',
    createdOn: '2026-10-05', lines: lines ?? [
      {scenario: 'good', month: '2026-11-01', categoryId: ctx.inflow, item: '流通の入金（架空）', counterparty: '架空配信', amountYen: 1234567, status: 'provisional'},
      {scenario: 'even', month: '2026-11-01', categoryId: ctx.inflow, item: '流通の入金（架空）', counterparty: '架空配信', amountYen: 987654, status: 'provisional'},
      {scenario: 'single', month: '2026-12-01', categoryId: ctx.outflow, item: '製作費の支払い（架空）', counterparty: null, amountYen: 3141592, status: 'confirmed'},
    ], ...overrides}, {categories: ctx.categories});
  assert.equal(n.ok, true, JSON.stringify(n.errors));
  return n.value;
};
const lineSql = 'INSERT INTO yojitsu_forecast_lines(org_id,project_id,version_no,line_no,scenario,forecast_month,category_id,item,counterparty,amount_yen,status,use_for_forecast) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)';
const versionSql = 'INSERT INTO yojitsu_forecast_versions(org_id,project_id,version_no,label,source_kind,source,source_sha256,line_count,created_on,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)';

test('FR-REV-YOJITSU-023 予測は案件ごとの版を足して残り、最初の版を消せず、書き換えも番号の飛ばしも古い画面からの書き込みも断る', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  assert.equal(await store.addForecastVersion(db, 1, forecast(ctx), {createdBy: ADMIN}), 1);
  assert.equal(await store.addForecastVersion(db, 1, forecast(ctx, {previousVersionNo: 1, label: '架空の試算 第2版', createdOn: '2026-11-16'}), {createdBy: ADMIN}), 2);
  // 古い画面（第1版を見ていた）からの書き込みは断り、行も変更の記録も入らない（1回の batch）
  const counts = async () => [Number((await db.get('SELECT COUNT(*) AS n FROM yojitsu_forecast_lines WHERE org_id=1')).n),
    Number((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE org_id=1 AND entity_type='yojitsu_forecast_version'")).n)];
  assert.deepEqual(await counts(), [6, 2]);
  await rejects(store.addForecastVersion(db, 1, forecast(ctx, {previousVersionNo: 1}), {createdBy: ADMIN}), 'raise', /stale yojitsu forecast version/);
  await rejects(raw(db, versionSql, [1, ctx.own, 5, '飛ばした版', 'manual', '架空', null, 1, '2026-11-17', ADMIN]), 'raise', /stale yojitsu forecast version/);
  assert.deepEqual(await counts(), [6, 2]);
  // 版も行も書き換え・削除できない（アプリを通さない書き込みでも）。最初の版が残る
  await rejects(raw(db, "UPDATE yojitsu_forecast_versions SET label='改めた' WHERE org_id=1 AND project_id=? AND version_no=1", [ctx.own]), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM yojitsu_forecast_versions WHERE org_id=1 AND project_id=? AND version_no=1', [ctx.own]), 'raise', /append-only/);
  await rejects(raw(db, 'UPDATE yojitsu_forecast_lines SET amount_yen=1 WHERE org_id=1 AND project_id=?', [ctx.own]), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM yojitsu_forecast_lines WHERE org_id=1 AND project_id=?', [ctx.own]), 'raise', /append-only/);
  // 版の行は版の数（line_count）を超えて足せない（あとから行を足して前の版を変えない）
  await rejects(raw(db, lineSql, [1, ctx.own, 1, 4, 'good', '2027-01-01', ctx.inflow, '足した行', null, 100, 'provisional', 1]), 'raise', /beyond the count/);
  // 行の番号は最後の番号の次だけ（番号を飛ばした行・そろった版の番号を入れ直す行は断る）
  await rejects(raw(db, lineSql, [1, ctx.own, 2, 2, 'good', '2027-01-01', ctx.inflow, '入れ直した行', null, 100, 'provisional', 1]), 'raise', /out of order/);
  // 案件ごとの連番（別の案件は1から）
  assert.equal(await store.addForecastVersion(db, 1, forecast(ctx, {projectId: ctx.buy}), {createdBy: ADMIN}), 1);
  // 有効な予測は案件ごとの最新の版。前の版の行は「予測に使う」が偽（Excel の 予測に使う＝いいえ）
  const all = await store.readForecasts(db, 1, [ctx.own, ctx.buy], {history: true});
  assert.deepEqual(all.map((v) => [v.projectId, v.versionNo, v.effective, v.lines.map((l) => l.used).join()]), [
    [ctx.own, 1, false, 'false,false,false'], [ctx.own, 2, true, 'true,true,true'], [ctx.buy, 1, true, 'true,true,true']]);
  assert.deepEqual((await store.readForecasts(db, 1, [ctx.own, ctx.buy])).map((v) => [v.projectId, v.versionNo]), [[ctx.own, 2], [ctx.buy, 1]]);
  // 別の組織の受け口が渡した案件の ID は org_id で落ちる
  assert.deepEqual(await store.readForecasts(db, 2, [ctx.own]), []);
  // 1つの版の行は 3,824 行まで（版の文 1+478+1 = 480 文が D1 の1回の batch に収まる。8行で1文）。3,825 行の版は入力の読み取り・store・DB のどれも断る
  const rowsOf = (count) => Array.from({length: count}, (_, i) => ({scenario: 'good', month: '2026-11-01', categoryId: ctx.inflow, item: `架空の窓口${i + 1}`,
    amountYen: 1000 + i, status: 'provisional'}));
  const many = (projectId, count) => forecast(ctx, {projectId, previousVersionNo: 0}, rowsOf(count));
  const newProject = (code) => planning.createProject(db, 1, {code, title: `${code}（架空）`, projectType: 'production', earningType: 'own_investment',
    baseAmountYen: null, revenueRateBps: null, counterpartyName: null, keyPerson: null, startedOn: null, planningFolder: null, note: null, stage: null}, {createdBy: ADMIN});
  const project3 = await newProject('FICT-FC-3');
  assert.equal(MAX_FORECAST_LINES, 3824);
  assert.equal(store.forecastVersionStatements(1, many(project3, MAX_FORECAST_LINES), {createdBy: ADMIN}).length, store.FORECAST_BATCH_STATEMENTS);
  const tooMany = normalizeForecastVersionInput({projectId: project3, previousVersionNo: 0, label: '架空の試算', sourceKind: 'manual', source: '架空の手入力',
    createdOn: '2026-10-05', lines: rowsOf(MAX_FORECAST_LINES + 1)}, {categories: ctx.categories});
  assert.deepEqual(tooMany.errors.map((e) => e.field), ['lines']);
  await assert.rejects(store.addForecastVersion(db, 1, tooMany.value, {createdBy: ADMIN}), /予測の版の行が多すぎます（保存の処理 481件・上限 480件）/);
  await rejects(raw(db, versionSql, [1, project3, 1, '架空', 'manual', '架空', null, MAX_FORECAST_LINES + 1, '2026-10-05', ADMIN]), 'check');
  assert.deepEqual(await store.readForecasts(db, 1, [project3], {history: true}), []);
  // いくつかの版をまとめて足すとき、D1 の1回の batch の文の数（480）を超えるなら何も書かない（2つの版で (1+250+1)+(1+229+1) = 483文）
  const project4 = await newProject('FICT-FC-4');
  assert.deepEqual(await store.addForecastVersions(db, 1, [many(project3, 2000), many(project4, 1832)], {createdBy: ADMIN}), {written: false, statementCount: 483});
  assert.deepEqual(await store.readForecasts(db, 1, [project3, project4], {history: true}), []);
  assert.deepEqual(await store.addForecastVersions(db, 1, [many(project3, MAX_FORECAST_LINES)], {createdBy: ADMIN}), {written: true, statementCount: 480});
  assert.equal((await store.readForecasts(db, 1, [project3]))[0].lines.length, MAX_FORECAST_LINES);
});

test('FR-REV-YOJITSU-023 行が line_count に満たない版（アプリを通さない書き込みで欠けた版）は有効な予測にせず、そろった版にはそれ以上行を足せない', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  await store.addForecastVersion(db, 1, forecast(ctx), {createdBy: ADMIN});
  const line = (version, lineNo) => raw(db, lineSql, [1, ctx.own, version, lineNo, 'good', '2027-01-01', ctx.inflow, `架空の行${lineNo}`, null, 100 * lineNo, 'provisional', 1]);
  const state = async () => (await store.readForecasts(db, 1, [ctx.own], {history: true})).map((v) => [v.versionNo, v.lineCount, v.lines.length, v.effective]);
  // 行が0の版（ヘッダだけ）が最新でも、有効な予測にしない（前の版にも戻さない）
  await raw(db, versionSql, [1, ctx.own, 2, '架空の手入力 第2版', 'manual', '架空', null, 3, '2026-11-16', ADMIN]);
  assert.deepEqual(await state(), [[1, 3, 3, false], [2, 3, 0, false]]);
  assert.deepEqual(await store.readForecasts(db, 1, [ctx.own]), []);
  // 行を1つだけ入れた版も有効にしない。番号を飛ばした行は断る
  await line(2, 1);
  await rejects(line(2, 3), 'raise', /out of order/);
  assert.deepEqual(await state(), [[1, 3, 3, false], [2, 3, 1, false]]);
  // 行がそろうと有効になり、そのあとは行を足せない（版の数を超える・番号を飛ばす、のどちらでも）
  await line(2, 2);
  await line(2, 3);
  assert.deepEqual(await state(), [[1, 3, 3, false], [2, 3, 3, true]]);
  await rejects(line(2, 4), 'raise', /beyond the count/);
  await rejects(line(2, 5), 'raise');
  assert.deepEqual((await store.readForecasts(db, 1, [ctx.own])).map((v) => [v.versionNo, v.lines.map((l) => l.amountYen).join()]), [[2, '100,200,300']]);
});

test('FR-REV-YOJITSU-023 予測の行は月初の日・正の整数の円・シナリオ（even・good・MAX・単一）・状態が必須で、案件と区分は同じ組織の行だけ', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  await raw(db, versionSql, [1, ctx.own, 1, '架空の手入力', 'manual', '架空', null, 20, '2026-10-05', ADMIN]);
  // 行の番号は最後の番号の次（断られた行の番号は使わない）
  let lineNo = 0;
  const line = async (overrides = {}) => {
    const v = {scenario: 'good', month: '2026-11-01', category: ctx.inflow, amount: 1000, status: 'provisional', use: 1, ...overrides};
    await raw(db, lineSql, [1, ctx.own, 1, lineNo + 1, v.scenario, v.month, v.category, '架空の項目', null, v.amount, v.status, v.use]);
    lineNo += 1;
  };
  await line();
  for (const month of ['2026-11-02', '2026-13-01', '２０２６-11-01', '2026-11']) await rejects(line({month}), 'check');
  for (const amount of [0, -1000, 1000.5]) await rejects(line({amount}), 'check');
  for (const scenario of ['MAX', '単一', 'best']) await rejects(line({scenario}), 'check');
  await rejects(line({status: '試算'}), 'check');
  await rejects(line({use: 2}), 'check');
  await rejects(line({category: ctx.otherCategory}), 'foreign_key'); // 別の組織の区分
  await line({scenario: 'max', month: '2027-09-01', category: ctx.outflow, amount: 9007199254740991, status: 'confirmed', use: 0});
  // 案件は必須で、別の組織の案件・無い案件の版は作れない
  await rejects(raw(db, versionSql, [1, null, 1, '架空', 'manual', '架空', null, 1, '2026-10-05', ADMIN]), 'not_null');
  await rejects(raw(db, versionSql, [1, 2, 1, '架空', 'manual', '架空', null, 1, '2026-10-05', ADMIN]), 'foreign_key');
  await rejects(raw(db, versionSql, [2, ctx.own, 1, '架空', 'manual', '架空', null, 1, '2026-10-05', OUTSIDER]), 'foreign_key');
  // 試算の写しだけが SHA-256（小文字の16進64桁）を持つ
  const sha = 'ab'.repeat(32);
  await rejects(raw(db, versionSql, [1, ctx.buy, 1, '試算の写し 2026-10-20', 'trial_import', '架空', null, 1, '2026-10-20', ADMIN]), 'check');
  await rejects(raw(db, versionSql, [1, ctx.buy, 1, '架空', 'manual', '架空', sha, 1, '2026-10-20', ADMIN]), 'check');
  await rejects(raw(db, versionSql, [1, ctx.buy, 1, '試算の写し 2026-10-20', 'trial_import', '架空', sha.toUpperCase(), 1, '2026-10-20', ADMIN]), 'check');
  await raw(db, versionSql, [1, ctx.buy, 1, '試算の写し 2026-10-20', 'trial_import', '架空', sha, 1, '2026-10-20', ADMIN]);
  // 入力の読み取りも同じ決まりを先に見る（項目ごとの誤り）
  const n = normalizeForecastVersionInput({projectId: ctx.own, previousVersionNo: 0, label: ' ', sourceKind: 'trial_import', source: '架空', createdOn: '2026-02-30',
    lines: [{scenario: 'MAX', month: '2026-11-15', categoryId: ctx.otherCategory, item: '', amountYen: 0, status: '試算', useForForecast: 'はい'}]}, {categories: ctx.categories});
  assert.equal(n.ok, false);
  assert.deepEqual(n.errors.map((e) => e.field), ['label', 'sourceSha256', 'createdOn', 'lines.0.scenario', 'lines.0.month', 'lines.0.categoryId', 'lines.0.item',
    'lines.0.amountYen', 'lines.0.status', 'lines.0.useForForecast']);
  // SHA-256 は小文字にそろえる
  const ok = normalizeForecastVersionInput({...forecast(ctx), sourceKind: 'trial_import', sourceSha256: sha.toUpperCase()}, {categories: ctx.categories});
  assert.equal(ok.value.sourceSha256, sha);
});

test('FR-REV-YOJITSU-023 予測に使う行の区分×月の収支は、採用するシナリオと単一の行だけを足し、入金は正・出金は負で、値の無い月は0円で埋めない', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  await store.addForecastVersion(db, 1, forecast(ctx), {createdBy: ADMIN});
  await store.addForecastVersion(db, 1, forecast(ctx, {projectId: ctx.buy}, [
    {scenario: 'good', month: '2026-11-01', categoryId: ctx.inflow, item: '流通の入金（架空）', amountYen: 271828, status: 'provisional'},
    {scenario: 'good', month: '2027-01-01', categoryId: ctx.inflow, item: '外した窓口（架空）', amountYen: 161803, status: 'provisional', useForForecast: false},
  ]), {createdBy: ADMIN});
  const versions = await store.readForecasts(db, 1, [ctx.own, ctx.buy]);
  const view = (map) => [...map].map(([id, months]) => [id, [...months]]);
  assert.deepEqual(view(forecastCashflowByMonth(versions, {categories: ctx.categories, scenario: 'good'})), [
    [ctx.inflow, [['2026-11-01', 1234567 + 271828]]], [ctx.outflow, [['2026-12-01', -3141592]]]]);
  assert.deepEqual(view(forecastCashflowByMonth(versions, {categories: ctx.categories, scenario: 'even'})), [
    [ctx.inflow, [['2026-11-01', 987654]]], [ctx.outflow, [['2026-12-01', -3141592]]]]);
  // 入れる案件を絞る（月別の表に入れる案件の範囲は #14 が渡す）
  assert.deepEqual(view(forecastCashflowByMonth(versions, {categories: ctx.categories, scenario: 'good', includeProject: (id) => id === ctx.buy})),
    [[ctx.inflow, [['2026-11-01', 271828]]]]);
  // 採用するシナリオが「単一」なら単一の行だけ（Excel の「採用するシナリオか単一」で、採用するシナリオに単一を選んだとき。FR-REV-YOJITSU-045）
  assert.deepEqual(view(forecastCashflowByMonth(versions, {categories: ctx.categories, scenario: 'single'})), [[ctx.outflow, [['2026-12-01', -3141592]]]]);
  for (const scenario of ['MAX', '単一', 'best', null]) {
    assert.throws(() => forecastCashflowByMonth(versions, {categories: ctx.categories, scenario}), /採用するシナリオは even・good・MAX・単一 のどれかです/);
  }
});

// ---------- 活動記録 ----------

const activity = (ctx, overrides = {}, steps = null) => {
  const n = normalizeActivityInput({projectId: ctx.own, occurredOn: '2026-10-15', step: 'meeting', counterparty: '架空の幹事会社', summary: '架空の打診',
    deliverable: '打診の記録（架空）', nextAction: '内諾に進める', nextDueOn: '2026-11-04', result: 'advanced', ...overrides},
  {steps: steps ?? [{code: 'meeting'}, {code: 'proposal'}, {code: 'contract'}, {code: 'meeting_rights'}], earningTypes: [{code: 'own_investment'}, {code: 'acquisition'}, {code: 'committee'}]});
  assert.equal(n.ok, true, JSON.stringify(n.errors));
  return n.value;
};
const activitySql = `INSERT INTO yojitsu_activity_records(org_id,project_id,occurred_on,earning_type,step,summary,result,work_id,source_sales_activity_id,next_action,next_due_on,created_by)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`;

test('FR-REV-YOJITSU-035 活動記録は案件（必須）・ステップ（参照表）・結果（進んだ・保留・失注）を持ち、作品は空でよく案件の作品だけ。追記だけで直しは取消の行', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  const insert = (o = {}) => {
    const v = {org: 1, project: ctx.own, on: '2026-10-15', earning: null, step: 'meeting', result: 'advanced', work: null, source: null, next: null, due: null, by: ADMIN, ...o};
    return raw(db, activitySql, [v.org, v.project, v.on, v.earning, v.step, '架空の打診', v.result, v.work, v.source, v.next, v.due, v.by]);
  };
  await insert();
  await insert({step: null}); // ステップの無い行（Excel の「その他」）も記録できる
  await rejects(insert({project: null}), 'not_null');
  await rejects(insert({project: 2}), 'foreign_key'); // 別の組織の案件
  await rejects(insert({step: 'negotiation'}), 'foreign_key'); // 参照表に無いステップ
  await rejects(insert({earning: 'crowdfunding'}), 'foreign_key');
  await rejects(insert({result: 'won'}), 'check');
  await rejects(insert({on: '2026-02-30x'}), 'check');
  await rejects(insert({due: '2026-11-04'}), 'check'); // 期日は次の一手に付ける
  await insert({next: '内諾に進める', due: '2026-11-04'});
  await rejects(insert({work: DEMO_WORK}), 'foreign_key'); // 作品は案件の作品だけ（作品1は試作の案件の作品）
  await insert({project: DEMO_PROJECT, work: DEMO_WORK});
  await rejects(insert({by: OUTSIDER}), 'foreign_key'); // 記録した人は組織の所属
  await rejects(raw(db, "UPDATE yojitsu_activity_records SET result='lost' WHERE org_id=1"), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM yojitsu_activity_records WHERE org_id=1'), 'raise', /append-only/);
  // 直しは取消の行（1行に1回。取り消せるのは記録した人だけ。取消も追記だけ）
  const id = await store.addActivityRecord(db, 1, activity(ctx), {createdBy: EDITOR});
  await rejects(store.cancelActivityRecord(db, 1, {activityId: id, cancelledOn: '2026-10-16', reason: '日付の誤り'}, {createdBy: ADMIN}), 'raise', /only the recorder/);
  await store.cancelActivityRecord(db, 1, {activityId: id, cancelledOn: '2026-10-16', reason: '日付の誤り'}, {createdBy: EDITOR});
  await rejects(store.cancelActivityRecord(db, 1, {activityId: id, cancelledOn: '2026-10-17', reason: '二度目'}, {createdBy: EDITOR}), 'unique');
  await rejects(raw(db, "UPDATE yojitsu_activity_cancellations SET reason='x' WHERE org_id=1"), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM yojitsu_activity_cancellations WHERE org_id=1'), 'raise', /append-only/);
  const [cancelled] = await store.readActivityRecords(db, 1, [ctx.own], {viewerUserId: EDITOR});
  assert.deepEqual([cancelled.id, cancelled.cancelledOn, cancelled.cancelReason], [id, '2026-10-16', '日付の誤り']);
  // 入力の読み取り（項目ごとの誤り）
  const bad = normalizeActivityInput({projectId: null, occurredOn: '2026/10/15', earningType: 'crowdfunding', step: 'xyz', summary: ' ', nextDueOn: '2026-11-04', result: '進んだ', workId: 0},
    {steps: [{code: 'meeting'}], earningTypes: [{code: 'own_investment'}]});
  assert.deepEqual(bad.errors.map((e) => e.field), ['projectId', 'occurredOn', 'earningType', 'step', 'summary', 'nextDueOn', 'result', 'workId']);
  assert.deepEqual(normalizeActivityCancellation({activityId: 1, cancelledOn: '2026-10-16', reason: ''}).errors.map((e) => e.field), ['reason']);
});

test('FR-REV-YOJITSU-035 K2-15 取り込み元の営業活動と明示結果を保ち、source_sales_activity_id で1回だけ。案件と作品は元の行と同じでなければ断る', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  const opportunity = Number((await db.get("INSERT INTO sales_opportunities(org_id,project_id,work_id,partner_id,name,stage) VALUES(1,?,?,1,'架空の商談','lead') RETURNING id", [DEMO_PROJECT, DEMO_WORK])).id);
  const source = Number((await db.get(`INSERT INTO sales_activities(org_id,project_id,work_id,opportunity_id,partner_id,occurred_on,activity_type,summary,created_by,result)
    VALUES(1,?,?,?,1,'2026-09-30','contact','架空の面談',1,'on_hold') RETURNING id`, [DEMO_PROJECT, DEMO_WORK, opportunity])).id);
  const original = await db.get('SELECT * FROM sales_activities WHERE org_id=1 AND id=?', [source]);
  const imported = activity({...ctx, own: DEMO_PROJECT}, {workId: DEMO_WORK, sourceSalesActivityId: source, occurredOn: '2026-09-30', result: 'on_hold'});
  await store.addActivityRecord(db, 1, imported, {createdBy: ADMIN});
  await rejects(store.addActivityRecord(db, 1, imported, {createdBy: ADMIN}), 'unique'); // 二度取り込まない
  await rejects(store.addActivityRecord(db, 1, {...imported, sourceSalesActivityId: source + 1000}, {createdBy: ADMIN}), 'foreign_key'); // 元の行が無い
  await rejects(store.addActivityRecord(db, 1, {...imported, projectId: ctx.own, workId: null}, {createdBy: ADMIN}), 'raise', /does not match the sales activity/);
  await rejects(store.addActivityRecord(db, 1, {...imported, workId: null}, {createdBy: ADMIN}), 'raise', /does not match the sales activity/);
  // 結果欄は代表回答（2026-10-15）で追加。取り込みは元の行を書き換えない。
  assert.deepEqual(await db.get('SELECT * FROM sales_activities WHERE org_id=1 AND id=?', [source]), original);
});

test('FR-REV-YOJITSU-037 活動記録の行の中身は記録した人の本人にだけ返り、ほかの人（管理者を含む）には返らない。件数は中身を出さずに数える', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  await store.addActivityRecord(db, 1, activity(ctx, {summary: '架空の打診（管理者）'}), {createdBy: ADMIN});
  await store.addActivityRecord(db, 1, activity(ctx, {summary: '架空の打診（編集担当）', occurredOn: '2026-10-20'}), {createdBy: EDITOR});
  const mine = await store.readActivityRecords(db, 1, [ctx.own], {viewerUserId: ADMIN});
  assert.deepEqual(mine.map((r) => [r.summary, r.createdBy]), [['架空の打診（管理者）', ADMIN]]);
  assert.deepEqual((await store.readActivityRecords(db, 1, [ctx.own], {viewerUserId: EDITOR})).map((r) => r.summary), ['架空の打診（編集担当）']);
  assert.deepEqual(await store.readActivityRecords(db, 1, [ctx.own], {viewerUserId: null}), []);
  assert.deepEqual(await store.readActivityRecords(db, 2, [ctx.own], {viewerUserId: OUTSIDER}), []);
  // 件数は2人の行を数え、行の中身（相手・したこと・次の一手）を持たない
  const tallies = await store.readActivityTallies(db, 1, [ctx.own]);
  assert.deepEqual(tallies.map((r) => ({...r, n: Number(r.n), with_deliverable: Number(r.with_deliverable), project_id: Number(r.project_id)})),
    [{project_id: ctx.own, earning_type: 'own_investment', step: 'meeting', month: '2026-10', n: 2, with_deliverable: 2}]);
  // 変更の記録は行ごとに1行で、対象は足した行の id。行の中身・案件・ステップを残さない
  const audit = await db.all("SELECT user_id,entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='yojitsu_activity_record' ORDER BY id");
  const ids = (await db.all('SELECT id,created_by FROM yojitsu_activity_records WHERE org_id=1 ORDER BY id')).map((r) => [Number(r.created_by), String(r.id)]);
  assert.deepEqual(audit.map((r) => [Number(r.user_id), r.entity_id, r.detail_json]), ids.map(([by, id]) => [by, id, '{}']));
});

test('FR-REV-YOJITSU-015 FR-REV-YOJITSU-017 FR-REV-YOJITSU-029 行動の実績件数は 稼ぎ方（空なら案件の）×親のステップ×期間 で数え、ステップの無い行・取り消した行は数えず、成果物のある行は月×案件で1回', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  await planning.addActionStep(db, {code: 'meeting_rights', label: '権利元との面談', parentCode: 'meeting', sortOrder: 11});
  const steps = await planning.listActionSteps(db);
  const add = (overrides, by = ADMIN) => store.addActivityRecord(db, 1, activity(ctx, overrides), {createdBy: by});
  await add({occurredOn: '2026-10-15'}); // 自社出資の面談（1年目）
  await add({occurredOn: '2026-10-20', step: 'meeting_rights', deliverable: null}, EDITOR); // 細目の段は面談に畳む
  await add({occurredOn: '2026-10-21', earningType: 'committee', step: 'proposal'}); // 行の稼ぎ方が案件より先
  await add({projectId: ctx.buy, occurredOn: '2027-10-01', step: 'contract', deliverable: '契約書（架空）'}); // 2年目
  await add({occurredOn: '2026-09-30', deliverable: null}); // 期間の前の月（月の表にだけ入る）
  await add({occurredOn: '2026-10-22', step: null}); // ステップの無い行は数えない（成果物があれば携わった案件数には入る）
  const cancelled = await add({occurredOn: '2026-10-23', step: 'proposal'});
  await store.cancelActivityRecord(db, 1, {activityId: cancelled, cancelledOn: '2026-10-24', reason: '重複'}, {createdBy: ADMIN});
  const periods = periodStarts('2026-10-01').map((startsOn, i) => ({yearNo: i + 1, startsOn}));
  const tallies = await store.readActivityTallies(db, 1, [ctx.own, ctx.buy]);
  const counted = countActivitySteps(tallies, {steps, periods});
  assert.deepEqual([...counted.byPeriod].sort(), [['acquisition|contract|2', 1], ['committee|proposal|1', 1], ['own_investment|meeting|1', 2]]);
  assert.deepEqual([...counted.byMonth].sort(), [['contract|2027-10', 1], ['meeting|2026-09', 1], ['meeting|2026-10', 2], ['proposal|2026-10', 1]]);
  assert.deepEqual(counted.skipped, {noStep: 1, noEarningType: 0});
  // 携わった案件数: 2026-10 は自社出資の案件1つ（成果物のある行が3つでも1回）、2027-10 は買付の案件
  assert.deepEqual([...engagedProjectCounts(tallies)].sort(), [['2026-10', 1], ['2027-10', 1]]);
});

test('FR-REV-YOJITSU-037 活動記録とその取消は管理者のデータ一覧に表名ごと出ず、一括入出力の対象でもなく、ほかのコードは読まない。予測の表はデータ一覧に出る', async (t) => {
  const db = await openTestDb({t});
  const ctx = await setup(db);
  await store.addActivityRecord(db, 1, activity(ctx, {summary: '架空の打診（本人だけ）'}), {createdBy: EDITOR});
  await store.addForecastVersion(db, 1, forecast(ctx), {createdBy: ADMIN});
  assert.deepEqual([...CREATOR_ONLY_TABLES].sort(), ['yojitsu_activity_cancellations', 'yojitsu_activity_records']);
  const app = createApp({db, mode: 'local'});
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const call = async (path) => {
    const res = await app.request(`/api${path}`, {headers: {cookie}});
    return {status: res.status, text: await res.text()};
  };
  const names = JSON.parse((await call('/admin/tables')).text).tables.map((x) => x.name);
  for (const table of CREATOR_ONLY_TABLES) {
    assert.ok(!names.includes(table), `${table} がデータ一覧に出る`);
    assert.equal((await call(`/admin/tables/${table}`)).status, 404);
    assert.equal((await call(`/admin/tables/${table}/definition`)).status, 404);
  }
  assert.ok(names.includes('yojitsu_forecast_versions') && names.includes('yojitsu_forecast_lines'));
  const audit = await call('/admin/tables/audit_log');
  assert.equal(audit.status, 200);
  assert.ok(!audit.text.includes('架空の打診（本人だけ）'));
  // 本人以外の管理者が読む変更の記録（GET /api/audit）からは、活動記録の案件・ステップが分からない（対象は行の id だけ）
  const [recorded] = await db.all('SELECT id FROM yojitsu_activity_records WHERE org_id=1');
  const rows = JSON.parse((await call('/audit')).text).rows.filter((r) => r.entity_type === 'yojitsu_activity_record');
  assert.deepEqual(rows.map((r) => [Number(r.user_id), r.entity_id, r.detail_json]), [[EDITOR, String(recorded.id), '{}']]);
  assert.ok(rows.every((r) => !/project|step|meeting/i.test(r.detail_json)));
  assert.ok(Object.values(BULK_ENTITIES).every((entity) => !CREATOR_ONLY_TABLES.includes(entity.table)));
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(mjs|jsx|js|sql)$/.test(name) ? [path] : [];
  });
  const allowed = new Set(['revenue/revenue-store.mjs', 'admin/data-browser-routes.mjs', 'admin/er-model.mjs']);
  const readers = files(src).map((path) => relative(src, path).replaceAll('\\', '/'))
    .filter((path) => !allowed.has(path) && CREATOR_ONLY_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(readFileSync(join(src, path), 'utf8'))));
  assert.deepEqual(readers, []);
});
