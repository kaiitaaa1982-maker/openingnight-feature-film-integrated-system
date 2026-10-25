// 指標マスタ（行動指標の計画 段B #9、移行 0017）を、DB の制約と store（src/revenue/revenue-store.mjs）で確かめる。期待値は要件
// docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-017・019 と、計画の K-8（版）・K-9（状態）・K2-5（値は設定の行に持つ）から持ってくる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。架空のデータだけを使う（組織1・2と利用者は試作の行。細目の段は架空の試験用の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import * as planning from '../src/planning/planning-store.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {normalizeMetricMasterInput, attachStepSettings} from '../src/revenue/metrics/metric-master-model.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const OUTSIDER = 4; // 組織2の管理者（試作の行）
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});
const raw = (db, sql, params = []) => db.run(sql, params);
const count = async (db, table, where = 'org_id=1') => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)).n);

// 架空の細目の段（参照表に足す。親は集計の3ステップ）
async function detailSteps(db) {
  for (const [code, parentCode, sortOrder] of [['fx_memo', 'meeting', 31], ['fx_sheet', 'proposal', 32], ['fx_sign', 'contract', 33], ['fx_pitch', 'meeting', 34]]) {
    await planning.addActionStep(db, {code, label: `架空の段（${code}）`, parentCode, sortOrder});
  }
}
async function master(db, chains, overrides = {}) {
  const n = normalizeMetricMasterInput({previousVersionNo: 0, createdOn: '2026-10-11', basis: '架空の版', chains, ...overrides},
    {earningTypes: await planning.listEarningTypes(db), actionSteps: await planning.listActionSteps(db)});
  assert.equal(n.ok, true, JSON.stringify(n.errors));
  return n.value;
}
const CHAINS = [
  {role: 'producer', earningType: 'committee', steps: [{step: 'fx_pitch'}, {step: 'proposal'}, {step: 'contract'}]},
  {role: 'sales_sourcing', earningType: 'acquisition', steps: [{step: 'fx_memo'}, {step: 'fx_sheet'}, {step: 'fx_sign'}]},
  {role: 'sales_selling', earningType: 'acquisition', steps: [{step: 'meeting'}, {step: 'proposal'}]},
];
const shape = (view) => view.chains.map((c) => `${c.role}:${c.earningType}:${c.steps.map((s) => `${s.step}>${s.foldsTo}@${s.status}`).join(',')}`);

test('FR-REV-KPI-019 指標マスタは版を足して残り、最初の版を消せず、有効な版は段の行がそろった最新の version_no の版', async (t) => {
  const db = await openTestDb({t});
  await detailSteps(db);
  assert.deepEqual(await store.readMetricMaster(db, 1), [], '版が無ければ空');
  assert.equal(await store.addMetricMasterVersion(db, 1, await master(db, CHAINS), {createdBy: ADMIN}), 1);
  const [v1] = await store.readMetricMaster(db, 1);
  assert.equal(v1.versionNo, 1);
  assert.equal(v1.stepCount, 8);
  assert.equal(v1.effective, true);
  assert.deepEqual(shape(v1), [
    'producer:committee:fx_pitch>meeting@provisional,proposal>proposal@provisional,contract>contract@provisional',
    'sales_sourcing:acquisition:fx_memo>meeting@provisional,fx_sheet>proposal@provisional,fx_sign>contract@provisional',
    'sales_selling:acquisition:meeting>meeting@provisional,proposal>proposal@provisional',
  ]);
  assert.deepEqual(v1.chains.map((c) => [c.roleLabel, c.roleGroup, c.profitSource]), [['プロデューサー', 'producer', 3], ['営業（仕入れ）', 'sales', 4], ['営業（売り）', 'sales', 4]]);
  // 改めた版（委員会の打診の段を確認済みにし、売りの契約の段を足す）。前の版は残り、有効なのは新しい版
  const revised = CHAINS.map((c) => (c.role === 'producer' ? {...c, steps: [{step: 'fx_pitch', status: 'confirmed', basis: '架空の実績'}, ...c.steps.slice(1)]}
    : c.role === 'sales_selling' ? {...c, steps: [...c.steps, {step: 'contract'}]} : c));
  assert.equal(await store.addMetricMasterVersion(db, 1, await master(db, revised, {previousVersionNo: 1, createdOn: '2026-11-02'}), {createdBy: ADMIN}), 2);
  const [v2] = await store.readMetricMaster(db, 1);
  assert.deepEqual([v2.versionNo, v2.stepCount, v2.createdOn], [2, 9, '2026-11-02']);
  assert.deepEqual([v2.chains[0].steps[0].status, v2.chains[0].steps[0].basis], ['confirmed', '架空の実績']);
  const history = await store.readMetricMaster(db, 1, {history: true});
  assert.deepEqual(history.map((v) => [v.versionNo, v.effective]), [[1, false], [2, true]]);
  assert.deepEqual(shape(history[0]), shape(v1), '前の版は書き換わらない');
  // 古い画面からの版（前の版の番号が古い）は断り、段の行も入らない（1回の batch）
  await rejects(store.addMetricMasterVersion(db, 1, await master(db, CHAINS), {createdBy: ADMIN}), 'raise', /stale kpi metric version/);
  assert.equal(await count(db, 'kpi_metric_versions'), 2);
  assert.equal(await count(db, 'kpi_metric_steps'), 17);
  // 版も段の行も変更・削除できない（最初の版を消せない）
  await rejects(raw(db, "UPDATE kpi_metric_versions SET basis='書き換え' WHERE org_id=1 AND version_no=1"), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM kpi_metric_versions WHERE org_id=1 AND version_no=1'), 'raise', /append-only/);
  await rejects(raw(db, "UPDATE kpi_metric_steps SET status='confirmed' WHERE org_id=1"), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM kpi_metric_steps WHERE org_id=1'), 'raise', /append-only/);
  // 段の行が欠けた版（アプリを通さない書き込み）は有効にせず、履歴に有効でない版として出す
  await raw(db, "INSERT INTO kpi_metric_versions(org_id,version_no,step_count,basis,created_on,created_by) VALUES(1,3,2,'欠けた版','2026-11-03',?)", [ADMIN]);
  const v3 = Number((await db.get('SELECT id FROM kpi_metric_versions WHERE org_id=1 AND version_no=3')).id);
  await raw(db, "INSERT INTO kpi_metric_steps(org_id,metric_version_id,role,earning_type,seq,step,status) VALUES(1,?,'producer','committee',1,'meeting','provisional')", [v3]);
  assert.equal((await store.readMetricMaster(db, 1))[0].versionNo, 2);
  assert.deepEqual((await store.readMetricMaster(db, 1, {history: true})).map((v) => [v.versionNo, v.effective, v.chains.length]), [[1, false, 3], [2, true, 3], [3, false, 1]]);
  // 組織ごとに連番で、別の組織の版は読めない
  assert.deepEqual(await store.readMetricMaster(db, 2), []);
  assert.equal(await store.addMetricMasterVersion(db, 2, await master(db, CHAINS.slice(0, 1)), {createdBy: OUTSIDER}), 1);
  assert.deepEqual((await store.readMetricMaster(db, 2)).map((v) => [v.versionNo, v.stepCount]), [[1, 3]]);
  assert.equal((await store.readMetricMaster(db, 1))[0].versionNo, 2);
});

test('FR-REV-KPI-017 FR-REV-KPI-019 段の行は役×稼ぎ方の中で seq の順・版の段の数まで・稼ぎ方×段は版で1回で、役と状態は決まった値だけ。参照表と組織の外を指せない（アプリを通さない書き込みも DB が断る）', async (t) => {
  const db = await openTestDb({t});
  await detailSteps(db);
  await raw(db, "INSERT INTO kpi_metric_versions(org_id,version_no,step_count,created_on,created_by) VALUES(1,1,3,'2026-10-11',?)", [ADMIN]);
  const id = Number((await db.get('SELECT id FROM kpi_metric_versions WHERE org_id=1 AND version_no=1')).id);
  const step = (values) => raw(db, 'INSERT INTO kpi_metric_steps(org_id,metric_version_id,role,earning_type,seq,step,status) VALUES(?,?,?,?,?,?,?)', values);
  await rejects(raw(db, "INSERT INTO kpi_metric_versions(org_id,version_no,step_count,created_on,created_by) VALUES(1,3,3,'2026-10-11',?)", [ADMIN]), 'raise', /stale kpi metric version/);
  await rejects(raw(db, "INSERT INTO kpi_metric_versions(org_id,version_no,step_count,created_on,created_by) VALUES(1,2,0,'2026-10-11',?)", [ADMIN]), 'check');
  await rejects(raw(db, "INSERT INTO kpi_metric_versions(org_id,version_no,step_count,created_on,created_by) VALUES(1,2,3,'2026-10-32',?)", [ADMIN]), 'check');
  await rejects(raw(db, "INSERT INTO kpi_metric_versions(org_id,version_no,step_count,created_on,created_by) VALUES(1,2,3,'2026-10-11',?)", [OUTSIDER]), 'foreign_key');
  await rejects(step([1, id, 'director', 'committee', 1, 'meeting', 'provisional']), 'check');
  await rejects(step([1, id, 'producer', 'committee', 1, 'meeting', 'guessed']), 'check');
  await rejects(raw(db, "INSERT INTO kpi_metric_steps(org_id,metric_version_id,role,earning_type,seq,step) VALUES(1,?,'producer','committee',1,'meeting')", [id]), 'not_null');
  await rejects(step([1, id, 'producer', 'crowdfunding', 1, 'meeting', 'provisional']), 'foreign_key');
  await rejects(step([1, id, 'producer', 'committee', 1, 'no_such_step', 'provisional']), 'foreign_key');
  await rejects(step([2, id, 'producer', 'committee', 1, 'meeting', 'provisional']), 'foreign_key'); // 別の組織の版を指せない
  await rejects(step([1, id, 'producer', 'committee', 2, 'meeting', 'provisional']), 'raise', /out of order/); // seq は 1 から
  await step([1, id, 'producer', 'committee', 1, 'fx_pitch', 'provisional']);
  await rejects(step([1, id, 'producer', 'committee', 3, 'proposal', 'provisional']), 'raise', /out of order/); // 番号を飛ばさない
  await rejects(step([1, id, 'sales_sourcing', 'committee', 1, 'fx_pitch', 'provisional']), 'unique'); // 稼ぎ方×段は版で1回
  await step([1, id, 'producer', 'committee', 2, 'proposal', 'provisional']);
  await step([1, id, 'sales_sourcing', 'acquisition', 1, 'fx_memo', 'confirmed']);
  // 段の数を超える行は、段の順の決まりより先に数の決まりの文で断る
  await rejects(step([1, id, 'producer', 'committee', 5, 'contract', 'provisional']), 'raise', /beyond the count/);
  await rejects(step([1, id, 'producer', 'committee', 3, 'contract', 'provisional']), 'raise', /beyond the count/);
  assert.deepEqual((await store.readMetricMaster(db, 1)).map((v) => [v.versionNo, v.stepCount]), [[1, 3]]);
});

test('FR-REV-KPI-019 段の率と1件の時間は設定の行（変数×稼ぎ方×段の版）だけに持ち、指標マスタの行は対応と状態だけを持つ。設定を改めても指標マスタの版は増えない', async (t) => {
  const db = await openTestDb({t});
  await detailSteps(db);
  await store.addMetricMasterVersion(db, 1, await master(db, CHAINS), {createdBy: ADMIN});
  // 指標マスタの段の行に値の列が無い（率・時間・額・通る確率を写さない）
  assert.deepEqual(Object.keys(await db.get('SELECT * FROM kpi_metric_steps WHERE org_id=1 AND seq=1 AND role=?', ['producer'])).sort(),
    ['basis', 'earning_type', 'metric_version_id', 'org_id', 'role', 'seq', 'status', 'step']);
  const setting = (variableKey, step, value, previousVersionNo = 0) => store.addSettingVersion(db, 1, {variableKey, scope: 'earning_type_step',
    earningType: 'acquisition', step, previousVersionNo, value, status: 'provisional', basis: '架空の値'}, {createdBy: ADMIN});
  await setting('conversion_rate', 'fx_memo', {kind: 'bps', value: 4700});
  await setting('step_hours', 'fx_memo', {kind: 'x100', value: 325});
  await setting('conversion_rate', 'fx_memo', {kind: 'bps', value: 5100}, 1);
  const attached = attachStepSettings((await store.readMetricMaster(db, 1))[0], await store.readEffectiveSettings(db, 1));
  const sourcing = attached.chains.find((c) => c.role === 'sales_sourcing');
  assert.deepEqual(sourcing.steps.map((s) => [s.step, s.conversionBps, s.hoursX100]), [['fx_memo', 5100, 325], ['fx_sheet', null, null], ['fx_sign', null, null]]);
  assert.equal(await count(db, 'kpi_metric_versions'), 1, '設定を改めても指標マスタの版は増えない');
  // 1件の時間はステップごとの変数（範囲は稼ぎ方×ステップだけ・値は100倍の整数）
  await rejects(store.addSettingVersion(db, 1, {variableKey: 'step_hours', scope: 'earning_type', earningType: 'acquisition', previousVersionNo: 0,
    value: {kind: 'x100', value: 300}, status: 'provisional'}, {createdBy: ADMIN}), 'raise', /scope does not match/);
  await rejects(setting('step_hours', 'fx_sheet', {kind: 'bps', value: 300}), 'raise', /does not match the variable/);
});

test('FR-REV-KPI-019 移行で足した設定の変数は値の列の種類が決まり、ステップごとに持つのは率と1件の時間だけ', async (t) => {
  const db = await openTestDb({t});
  const variables = new Map((await store.listSettingVariables(db)).map((v) => [v.code, [v.value_kind, Number(v.per_step)]]));
  assert.deepEqual(Object.fromEntries([...variables].filter(([code]) => !['unit_amount', 'conversion_rate', 'landing_probability', 'payment_lag'].includes(code))), {
    sales_multiplier: ['bps', 0], recovery_amount: ['bps', 0], months_to_contract: ['months', 0], months_to_window: ['months', 0], payment_delay: ['months', 0],
    cost_overrun: ['bps', 0], deal_mg: ['yen', 0], prep_cost: ['yen', 0], videogram_cost: ['yen', 0], labor_share: ['bps', 0], pass_rate: ['bps', 0],
    work_hours: ['x100', 0], step_hours: ['x100', 1], delivery_hours: ['x100', 0], delivery_months: ['months', 0], channel_share: ['bps', 0],
    rate_window: ['months', 0], rate_min_count: ['x100', 0],
  });
  assert.deepEqual([...variables].filter(([, [, perStep]]) => perStep === 1).map(([code]) => code).sort(), ['conversion_rate', 'step_hours']);
  await rejects(raw(db, "UPDATE yojitsu_variables SET per_step=0 WHERE code='step_hours'"), 'raise', /kind is fixed/);
});

test('指標マスタの書き込みは同じ batch で audit_log に1行残し、段の中身（役・段・状態）を残さない（docs/rules/logging.md）', async (t) => {
  const db = await openTestDb({t});
  await detailSteps(db);
  await store.addMetricMasterVersion(db, 1, await master(db, CHAINS), {createdBy: ADMIN});
  const rows = await db.all("SELECT entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='kpi_metric_version'");
  assert.deepEqual(rows.map((r) => [r.entity_id, JSON.parse(r.detail_json)]), [['1', {versionNo: 1, stepCount: 8}]]);
});
