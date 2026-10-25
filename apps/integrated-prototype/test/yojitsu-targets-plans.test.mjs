// 案件収支の予実の期間・目標の版・計画の版と採用の記録・設定の行（フェーズ1の仕様書 #11、移行 0014）を、DB の制約と store
// （src/revenue/revenue-store.mjs）で確かめる。期待値は要件 docs/requirements/revenue/project-cashflow-forecast-actual.md の
// FR-REV-YOJITSU-003・006・008〜012・014 と、計画の K-8・K-9・K-19、行動指標の計画の K2-12 から持ってくる。
// ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。架空のデータだけを使う（組織1・2と利用者は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {BULK_ENTITIES} from '../src/bulk/bulk-entities.mjs';
import {OWNER_ONLY_TABLES} from '../src/admin/data-browser-routes.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {normalizeTargetInput, periodStarts} from '../src/revenue/yojitsu/yojitsu-model.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）。目標・計画の持ち主にする
const EDITOR = 2; // 組織1の編集担当（試作の行）。持ち主でない人
const OUTSIDER = 4; // 組織2の管理者（試作の行）
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});
const raw = (db, sql, params = []) => db.run(sql, params);
const count = async (db, table, where = 'org_id=1') => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)).n);

// 1〜5年目（1年目は 2026-10-01 始まり）を組織1に足し、年目 → 期間の id を返す
async function periods(db, orgId = 1, createdBy = ADMIN) {
  await store.definePeriods(db, orgId, periodStarts('2026-10-01').map((startsOn, i) => ({yearNo: i + 1, startsOn})), {createdBy});
  return new Map((await store.listPeriods(db, orgId)).map((p) => [p.yearNo, p.id]));
}
const target = (periodId, overrides = {}) => {
  const n = normalizeTargetInput({periodId, previousVersionNo: 0, kind: 'self', basisKind: 'amount', amountYen: 314159263, decidedOn: '2026-10-02',
    decidedBy: '架空の代表', basis: '架空の目標', ownerUserId: ADMIN, ...overrides});
  assert.equal(n.ok, true, JSON.stringify(n.errors));
  return n.value;
};
const AMOUNTS = [
  {earningType: 'acquisition', amountYen: 41421356}, {earningType: 'consignment', amountYen: 7320508},
  {earningType: 'own_investment', amountYen: 223606797}, {earningType: 'committee', amountYen: 26457513}, {earningType: 'contract_work', amountYen: 9949874},
];
const TOTAL = AMOUNTS.reduce((sum, a) => sum + a.amountYen, 0); // 308756048
const plan = (periodId, overrides = {}) => ({periodId, previousVersionNo: 0, ownerUserId: ADMIN, status: 'provisional', basis: '架空の計画',
  createdOn: '2026-10-02', adoptedOn: '2026-10-02', amounts: AMOUNTS, ...overrides});

test('FR-REV-YOJITSU-003 期間は1〜5年目を順に足し、各年目は月初の日に始まり、前の年目のちょうど12か月後。足したあとは変えられない', async (t) => {
  const db = await openTestDb({t});
  const insert = (yearNo, startsOn, orgId = 1, by = ADMIN) => raw(db, 'INSERT INTO yojitsu_periods(org_id,year_no,starts_on,created_by) VALUES(?,?,?,?)', [orgId, yearNo, startsOn, by]);
  await rejects(insert(2, '2027-10-01'), 'raise', /out of order/);
  await rejects(insert(1, '2026-10-02'), 'check');
  await rejects(insert(1, '2026-13-01'), 'check');
  await rejects(insert(1, '２０２６-10-01'), 'check');
  await insert(1, '2026-10-01');
  await rejects(insert(2, '2027-11-01'), 'raise', /12 months after/);
  await rejects(insert(2, '2028-10-01'), 'raise', /12 months after/);
  await rejects(insert(2, '2027-09-01'), 'raise', /12 months after/);
  // 年目の順と12か月後の両方に当たる書き込みは、前の決まり（年目の順）の文で断る
  await rejects(insert(3, '2027-11-01'), 'raise', /out of order/);
  await insert(2, '2027-10-01');
  for (const [yearNo, startsOn] of [[3, '2028-10-01'], [4, '2029-10-01'], [5, '2030-10-01']]) await insert(yearNo, startsOn);
  await rejects(insert(6, '2031-10-01'), 'check', undefined); // 通算は5年まで
  await rejects(raw(db, "UPDATE yojitsu_periods SET starts_on='2026-11-01' WHERE org_id=1 AND year_no=1"), 'raise', /period is fixed/);
  await rejects(raw(db, 'DELETE FROM yojitsu_periods WHERE org_id=1 AND year_no=5'), 'raise', /period is fixed/);
  // 組織ごとに1年目から足す。別の組織の利用者は created_by にできない（所属への外部キー）
  await rejects(insert(1, '2027-01-01', 1, OUTSIDER), 'raise', /out of order/);
  await rejects(insert(1, '2027-01-01', 2, ADMIN), 'foreign_key');
  await insert(1, '2027-01-01', 2, OUTSIDER);
  assert.deepEqual((await store.listPeriods(db, 1)).map((p) => [p.yearNo, p.startsOn]),
    [[1, '2026-10-01'], [2, '2027-10-01'], [3, '2028-10-01'], [4, '2029-10-01'], [5, '2030-10-01']]);
  assert.deepEqual((await store.listPeriods(db, 2)).map((p) => [p.yearNo, p.startsOn]), [[1, '2027-01-01']]);
});

test('FR-REV-YOJITSU-008 目標は版を足して残り、最初の版を消せず、有効な目標は期間×種類×範囲ごとの最新の版', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  await store.addTargetVersion(db, 1, target(period.get(1)), {createdBy: ADMIN});
  await store.addTargetVersion(db, 1, target(period.get(1), {kind: 'company', amountYen: 209439509}), {createdBy: ADMIN});
  await store.addTargetVersion(db, 1, target(period.get(1), {previousVersionNo: 1, amountYen: 271828183, decidedOn: '2026-11-16'}), {createdBy: ADMIN});
  // 古い画面（第1版を見て足す）は断る。記録の行も入らない
  const audits = await count(db, 'audit_log', "org_id=1 AND entity_type='yojitsu_target_version'");
  await rejects(store.addTargetVersion(db, 1, target(period.get(1), {amountYen: 1}), {createdBy: ADMIN}), 'raise', /stale yojitsu target version/);
  assert.equal(await count(db, 'audit_log', "org_id=1 AND entity_type='yojitsu_target_version'"), audits);
  const history = await store.readTargets(db, 1, {viewerUserId: ADMIN, history: true});
  assert.deepEqual(history.map((r) => [r.yearNo, r.kind, r.versionNo, r.effective, r.amountYen]), [
    [1, 'self', 1, false, 314159263], [1, 'self', 2, true, 271828183], [1, 'company', 1, true, 209439509]]);
  assert.deepEqual((await store.readTargets(db, 1, {viewerUserId: ADMIN})).map((r) => [r.kind, r.versionNo]), [['self', 2], ['company', 1]]);
  // アプリを通さない書き換え・削除も断る（最初の版を残す。K-8）
  await rejects(raw(db, 'UPDATE yojitsu_target_versions SET amount_yen=1 WHERE org_id=1 AND version_no=1'), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM yojitsu_target_versions WHERE org_id=1 AND version_no=1'), 'raise', /append-only/);
  assert.equal(await count(db, 'yojitsu_target_versions'), 3);
});

test('FR-REV-YOJITSU-008 根拠が額なら額が要り倍率を持たず、人件費×倍率なら額を持たず倍率が要る。源泉別の目標は範囲が全体だけ（アプリを通さない書き込みでも）', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  const insert = (cols) => {
    const row = {period_id: period.get(1), target_kind: 'self', target_scope: 'all', version_no: 1, basis_kind: 'amount', amount_yen: 1000, multiplier_x100: null,
      source1_yen: null, unit: 'period_total', status: 'provisional', decided_on: '2026-10-02', owner_user_id: ADMIN, created_by: ADMIN, ...cols};
    const names = Object.keys(row);
    return raw(db, `INSERT INTO yojitsu_target_versions(org_id,${names.join(',')}) VALUES(1,${names.map(() => '?').join(',')})`, Object.values(row));
  };
  await rejects(insert({amount_yen: null}), 'check');
  await rejects(insert({multiplier_x100: 300}), 'check');
  await rejects(insert({basis_kind: 'labor_cost_multiple'}), 'check', undefined);
  await rejects(insert({basis_kind: 'labor_cost_multiple', amount_yen: null}), 'check');
  await rejects(insert({basis_kind: 'labor_cost_multiple', amount_yen: null, multiplier_x100: 300, unit: 'monthly'}), 'check');
  await rejects(insert({basis_kind: 'labor_cost_multiple', amount_yen: null, multiplier_x100: 300, target_scope: 'production_share'}), 'check');
  await rejects(insert({target_scope: 'production_share', source1_yen: 1}), 'check');
  await rejects(insert({amount_yen: 1000.5}), 'check');
  await rejects(insert({amount_yen: -1}), 'check');
  await rejects(insert({target_kind: 'team'}), 'check');
  await rejects(insert({decided_on: '2026-02-30x'}), 'check');
  // 持ち主は同じ組織の所属だけ（別の組織の利用者を owner にできない）
  await rejects(insert({owner_user_id: OUTSIDER}), 'foreign_key');
  await insert({basis_kind: 'labor_cost_multiple', amount_yen: null, multiplier_x100: 300});
  await insert({target_kind: 'company', source1_yen: 600, multiplier_x100: null});
  await insert({target_scope: 'production_share', unit: 'monthly', amount_yen: 500001});
  assert.equal(await count(db, 'yojitsu_target_versions'), 3);
});

test('FR-REV-YOJITSU-006 FR-REV-YOJITSU-009 目標の読み取り関数は額を owner 本人だけに返し、人件費×倍率の目標は報酬の行が無い間は null（未接続）', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  await store.addTargetVersion(db, 1, target(period.get(1), {sources: {2: 111111111}}), {createdBy: ADMIN});
  await store.addTargetVersion(db, 1, target(period.get(2), {basisKind: 'labor_cost_multiple', amountYen: null}), {createdBy: ADMIN});
  await store.addTargetVersion(db, 1, target(period.get(2), {kind: 'company', basisKind: 'labor_cost_multiple', amountYen: null}), {createdBy: ADMIN});
  const own = await store.readTargets(db, 1, {viewerUserId: ADMIN});
  assert.deepEqual(own.map((r) => [r.yearNo, r.kind, r.resolution, r.amountYen, r.multiplierX100]), [
    [1, 'self', 'amount', 314159263, null], [2, 'self', 'unconnected', null, 300], [2, 'company', 'unconnected', null, 200]]);
  assert.equal(own[0].sources[2], 111111111);
  for (const viewer of [EDITOR, undefined]) {
    const other = await store.readTargets(db, 1, {viewerUserId: viewer});
    assert.equal(other.length, 3, '項目は残す');
    assert.ok(other.every((r) => r.resolution === 'owner_only' && r.amountYen === null && r.multiplierX100 === null && r.sources === null && r.basis === null));
    assert.ok(!JSON.stringify(other).includes('314159263') && !JSON.stringify(other).includes('111111111'));
  }
  // 別の組織からは見えない（org_id で絞る）
  assert.deepEqual(await store.readTargets(db, 2, {viewerUserId: OUTSIDER, history: true}), []);
});

test('FR-REV-YOJITSU-011 FR-REV-YOJITSU-012 計画は版（ヘッダ＋稼ぎ方別の子表）と採用の記録を1回で書き、第1版も採用し、戻すは古い版を指す行を足すだけ', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  await store.addPlanVersion(db, 1, plan(period.get(1)), {createdBy: ADMIN});
  assert.equal(await count(db, 'plan_adoptions'), 1, '第1版も採用の記録を1行書く');
  const v2 = AMOUNTS.map((a) => ({...a, amountYen: a.amountYen + 7}));
  await store.addPlanVersion(db, 1, plan(period.get(1), {previousVersionNo: 1, amounts: v2, status: 'confirmed', createdOn: '2026-11-16', adoptedOn: '2026-11-16'}), {createdBy: ADMIN});
  let effective = await store.readPlans(db, 1, {viewerUserId: ADMIN});
  assert.deepEqual(effective.map((p) => [p.yearNo, p.versionNo, p.totalYen]), [[1, 2, TOTAL + 35]]);
  assert.deepEqual(effective[0].amounts.map((a) => a.earningType), ['acquisition', 'consignment', 'own_investment', 'committee', 'contract_work'], '稼ぎ方の参照表の並び');
  // 戻す: 第1版を指す行を足すだけ。版は消えず書き換わらない
  await store.adoptPlanVersion(db, 1, {periodId: period.get(1), versionNo: 1, adoptedOn: '2026-12-01'}, {createdBy: ADMIN});
  effective = await store.readPlans(db, 1, {viewerUserId: ADMIN});
  assert.deepEqual(effective.map((p) => [p.versionNo, p.totalYen]), [[1, TOTAL]]);
  assert.deepEqual((await store.readPlans(db, 1, {viewerUserId: ADMIN, history: true})).map((p) => [p.versionNo, p.effective]), [[1, true], [2, false]]);
  assert.deepEqual((await db.all('SELECT seq FROM plan_adoptions WHERE org_id=1 ORDER BY seq')).map((r) => Number(r.seq)), [1, 2, 3]);
  // 古い画面の版の番号は断り、ヘッダ・子表・採用の記録・記録の行のどれも残らない（1回の batch）
  const before = await Promise.all(['yojitsu_plan_versions', 'yojitsu_plan_amounts', 'plan_adoptions', 'audit_log'].map((table) => count(db, table)));
  await rejects(store.addPlanVersion(db, 1, plan(period.get(1), {previousVersionNo: 1, createdOn: '2026-12-02', adoptedOn: '2026-12-02'}), {createdBy: ADMIN}), 'raise', /stale yojitsu plan version/);
  // 同じ稼ぎ方を2行入れる版も、途中で断って何も残さない
  await rejects(store.addPlanVersion(db, 1, plan(period.get(2), {amounts: [AMOUNTS[0], AMOUNTS[0]]}), {createdBy: ADMIN}), 'unique');
  assert.deepEqual(await Promise.all(['yojitsu_plan_versions', 'yojitsu_plan_amounts', 'plan_adoptions', 'audit_log'].map((table) => count(db, table))), before);
  for (const table of ['yojitsu_plan_versions', 'yojitsu_plan_amounts', 'plan_adoptions']) {
    await rejects(raw(db, `UPDATE ${table} SET org_id=1 WHERE org_id=1`), 'raise', /append-only/);
    await rejects(raw(db, `DELETE FROM ${table} WHERE org_id=1`), 'raise', /append-only/);
  }
});

test('FR-REV-YOJITSU-012 採用の記録は子表のそろった同じ期間の版だけを指し、連番は最新の次、採用した日は前の行より前にしない（アプリを通さない書き込みでも）', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  await store.addPlanVersion(db, 1, plan(period.get(1)), {createdBy: ADMIN});
  const versionId = Number((await db.get('SELECT id FROM yojitsu_plan_versions WHERE org_id=1 AND period_id=? AND version_no=1', [period.get(1)])).id);
  // 子表を2行と書いて1行だけの第2版（アプリは1回の batch で書くので作らない形）
  const header = await db.get(`INSERT INTO yojitsu_plan_versions(org_id,period_id,version_no,owner_user_id,earning_type_count,status,created_on,created_by)
    VALUES(1,?,2,?,2,'provisional','2026-11-01',?) RETURNING id`, [period.get(1), ADMIN, ADMIN]);
  const partial = Number(header.id);
  const amount = (id, earning, yen = 1000) => raw(db, 'INSERT INTO yojitsu_plan_amounts(org_id,plan_version_id,earning_type,amount_yen) VALUES(1,?,?,?)', [id, earning, yen]);
  await amount(partial, 'acquisition');
  const adopt = (periodId, seq, id, on) => raw(db, 'INSERT INTO plan_adoptions(org_id,period_id,seq,plan_version_id,adopted_on,created_by) VALUES(1,?,?,?,?,?)', [periodId, seq, id, on, ADMIN]);
  await rejects(adopt(period.get(1), 2, partial, '2026-11-01'), 'raise', /plan version is incomplete/);
  await rejects(amount(partial, 'crowdfunding'), 'foreign_key');
  await rejects(amount(partial, 'consignment', 1.5), 'check');
  await amount(partial, 'consignment');
  await rejects(amount(partial, 'committee'), 'raise', /beyond the count/);
  await rejects(amount(999999, 'committee'), 'foreign_key');
  await rejects(adopt(period.get(1), 3, partial, '2026-11-01'), 'raise', /stale plan adoption/);
  await rejects(adopt(period.get(1), 1, partial, '2026-11-01'), 'raise', /stale plan adoption/);
  await rejects(adopt(period.get(1), 2, partial, '2026-10-01'), 'raise', /date goes back/);
  // 連番と日付の両方に当たる書き込みは、前の決まり（連番）の文で断る
  await rejects(adopt(period.get(1), 3, partial, '2026-09-01'), 'raise', /stale plan adoption/);
  // 別の期間の版は指せない（期間と版の複合の外部キー）。別の組織の版も指せない
  await rejects(adopt(period.get(2), 1, versionId, '2026-11-01'), 'foreign_key');
  await adopt(period.get(1), 2, partial, '2026-10-02'); // 同じ日は通る
  assert.deepEqual((await store.readPlans(db, 1, {viewerUserId: ADMIN})).map((p) => [p.versionNo, p.totalYen]), [[2, 2000]]);
  const other = await periods(db, 2, OUTSIDER);
  await rejects(raw(db, 'INSERT INTO plan_adoptions(org_id,period_id,seq,plan_version_id,adopted_on,created_by) VALUES(2,?,1,?,?,?)', [other.get(1), versionId, '2026-11-01', OUTSIDER]), 'foreign_key');
  assert.deepEqual(await store.readPlans(db, 2, {viewerUserId: OUTSIDER, history: true}), []);
});

test('FR-REV-YOJITSU-006 第1版の計画の額は owner 本人だけに返し、第2版を採用したら本人以外にも額を返す（第1版の行は本人だけのまま）', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  await store.addPlanVersion(db, 1, plan(period.get(1)), {createdBy: ADMIN});
  const [own] = await store.readPlans(db, 1, {viewerUserId: ADMIN});
  assert.equal(own.totalYen, TOTAL);
  const [other] = await store.readPlans(db, 1, {viewerUserId: EDITOR});
  assert.deepEqual([other.versionNo, other.visibility, other.totalYen, other.basis], [1, 'owner_only', null, null]);
  assert.ok(other.amounts.every((a) => a.amountYen === null) && other.amounts.length === 5, '稼ぎ方の行は残して額は null');
  await store.addPlanVersion(db, 1, plan(period.get(1), {previousVersionNo: 1, createdOn: '2026-11-16', adoptedOn: '2026-11-16'}), {createdBy: ADMIN});
  const [second] = await store.readPlans(db, 1, {viewerUserId: EDITOR});
  assert.deepEqual([second.versionNo, second.visibility, second.totalYen], [2, 'visible', TOTAL]);
  const first = (await store.readPlans(db, 1, {viewerUserId: EDITOR, history: true})).find((p) => p.versionNo === 1);
  assert.equal(first.totalYen, null);
});

test('FR-REV-YOJITSU-014 K-19 設定の行は変数×範囲ごとの版で、値の列はちょうど1つ・変数の種類どおり・範囲で使う列だけが埋まり、状態が要る', async (t) => {
  const db = await openTestDb({t});
  const projectId = Number((await db.get("SELECT id FROM projects WHERE org_id=1 AND code='PRJ-DEMO'")).id);
  const otherProject = Number((await db.get("SELECT id FROM projects WHERE org_id=2 AND code='PRJ-OTHER'")).id);
  const add = (setting) => store.addSettingVersion(db, 1, {previousVersionNo: 0, status: 'provisional', ...setting}, {createdBy: ADMIN});
  await add({variableKey: 'unit_amount', scope: 'earning_type', earningType: 'acquisition', value: {kind: 'yen', value: 31345186}, basis: '1作品の年間の入金（架空）'});
  await add({variableKey: 'conversion_rate', scope: 'earning_type_step', earningType: 'acquisition', step: 'meeting', value: {kind: 'bps', value: 5000}});
  await add({variableKey: 'conversion_rate', scope: 'earning_type_step', earningType: 'acquisition', step: 'proposal', value: {kind: 'bps', value: 3000}});
  await add({variableKey: 'landing_probability', scope: 'all', value: {kind: 'bps', value: 8000}, status: 'confirmed'});
  await add({variableKey: 'payment_lag', scope: 'channel', channelCode: 'svod', value: {kind: 'months', value: 2}});
  await add({variableKey: 'unit_amount', scope: 'project', projectId, value: {kind: 'yen', value: 12345678}});
  // 版を足すと最新の版が有効。古い画面は断る
  await add({variableKey: 'conversion_rate', scope: 'earning_type_step', earningType: 'acquisition', step: 'meeting', previousVersionNo: 1, value: {kind: 'bps', value: 4500}});
  await rejects(add({variableKey: 'conversion_rate', scope: 'earning_type_step', earningType: 'acquisition', step: 'meeting', value: {kind: 'bps', value: 1}}), 'raise', /stale yojitsu setting version/);
  const effective = await store.readEffectiveSettings(db, 1);
  assert.deepEqual(effective.map((s) => [s.variableKey, s.scope, s.earningType, s.step, s.projectId, s.channelCode, s.versionNo, s.value.kind, s.value.value, s.status]), [
    ['unit_amount', 'project', null, null, projectId, null, 1, 'yen', 12345678, 'provisional'],
    ['unit_amount', 'earning_type', 'acquisition', null, null, null, 1, 'yen', 31345186, 'provisional'],
    ['conversion_rate', 'earning_type_step', 'acquisition', 'meeting', null, null, 2, 'bps', 4500, 'provisional'],
    ['conversion_rate', 'earning_type_step', 'acquisition', 'proposal', null, null, 1, 'bps', 3000, 'provisional'],
    ['landing_probability', 'all', null, null, null, null, 1, 'bps', 8000, 'confirmed'],
    ['payment_lag', 'channel', null, null, null, 'svod', 1, 'months', 2, 'provisional'],
  ]);
  // 変数の値の種類と違う列・ステップの要否と違う範囲は断る（決まりの順: 連番 → 値の種類 → 範囲）
  await rejects(add({variableKey: 'unit_amount', scope: 'earning_type', earningType: 'consignment', value: {kind: 'bps', value: 2000}}), 'raise', /does not match the variable/);
  await rejects(add({variableKey: 'conversion_rate', scope: 'earning_type', earningType: 'consignment', value: {kind: 'bps', value: 5000}}), 'raise', /scope does not match/);
  await rejects(add({variableKey: 'unit_amount', scope: 'earning_type_step', earningType: 'consignment', step: 'meeting', value: {kind: 'yen', value: 1}}), 'raise', /scope does not match/);
  await rejects(add({variableKey: 'conversion_rate', scope: 'earning_type', earningType: 'consignment', value: {kind: 'yen', value: 1}}), 'raise', /does not match the variable/);
  await rejects(add({variableKey: 'revenue_rate', scope: 'earning_type', earningType: 'consignment', value: {kind: 'bps', value: 2000}}), 'foreign_key');
  // 範囲で使う列だけが埋まる・値の列はちょうど1つ・範囲と状態の語・値の範囲（アプリを通さない書き込みでも）
  const insert = (cols) => {
    const row = {variable_key: 'landing_probability', scope: 'all', version_no: 1, value_bps: 8000, status: 'provisional', created_by: ADMIN, ...cols};
    const names = Object.keys(row);
    return raw(db, `INSERT INTO yojitsu_setting_versions(org_id,${names.join(',')}) VALUES(1,${names.map(() => '?').join(',')})`, Object.values(row));
  };
  await rejects(insert({scope: 'all', earning_type: 'acquisition', version_no: 1}), 'check');
  await rejects(insert({scope: 'earning_type', earning_type: null}), 'check');
  await rejects(insert({scope: 'channel', channel_code: ' svod'}), 'check');
  await rejects(insert({scope: 'team'}), 'check');
  await rejects(insert({version_no: 2, value_x100: 100}), 'check');
  await rejects(insert({version_no: 2, value_bps: null}), 'raise', /does not match the variable/); // 値の列が1つも無い
  await rejects(insert({version_no: 2, value_bps: 10001}), 'check');
  await rejects(insert({version_no: 2, value_bps: 5000.5}), 'check');
  await rejects(insert({version_no: 2, status: null}), 'not_null');
  await rejects(insert({version_no: 2, status: 'active'}), 'check');
  await rejects(insert({variable_key: 'payment_lag', scope: 'channel', channel_code: 'tv', value_bps: null, value_months: 121}), 'check');
  await rejects(insert({variable_key: 'unit_amount', scope: 'project', project_id: otherProject, value_bps: null, value_yen: 1}), 'foreign_key');
  await rejects(raw(db, 'UPDATE yojitsu_setting_versions SET value_bps=1 WHERE org_id=1'), 'raise', /append-only/);
  await rejects(raw(db, 'DELETE FROM yojitsu_setting_versions WHERE org_id=1'), 'raise', /append-only/);
  assert.deepEqual(await store.readEffectiveSettings(db, 2), []);
});

test('FR-REV-YOJITSU-014 FR-REV-YOJITSU-020 稼ぎ方の既定の売上率は earning_type_rate_versions だけが持ち、設定の変数に売上率は無い（二重に持たない）', async (t) => {
  const db = await openTestDb({t});
  // 設定の変数は移行 0014 の行動の率・1件の額・着地の確度・窓口の支払いの間の4つ（K-19・FR-REV-YOJITSU-014）と、移行 0017 で足した行動指標の変数
  // （行動指標の計画 段B #9。種類は test/kpi-metric-master.test.mjs）。どれも売上率ではない。売上率の変数を足すときはこの試験と要件を直す
  const variables = (await store.listSettingVariables(db)).map((v) => [v.code, v.value_kind, Number(v.per_step)]);
  assert.deepEqual(variables.slice(0, 4), [
    ['unit_amount', 'yen', 0], ['conversion_rate', 'bps', 1], ['landing_probability', 'bps', 0], ['payment_lag', 'months', 0]]);
  assert.deepEqual(variables.slice(4).map(([code]) => code), ['sales_multiplier', 'recovery_amount', 'months_to_contract', 'months_to_window',
    'payment_delay', 'cost_overrun', 'deal_mg', 'prep_cost', 'videogram_cost', 'labor_share', 'pass_rate', 'work_hours', 'step_hours', 'delivery_hours',
    'delivery_months', 'channel_share', 'rate_window', 'rate_min_count']);
  await rejects(raw(db, "UPDATE yojitsu_variables SET value_kind='yen' WHERE code='conversion_rate'"), 'raise', /variable kind is fixed/);
  await rejects(raw(db, "UPDATE yojitsu_variables SET per_step=0 WHERE code='conversion_rate'"), 'raise', /variable kind is fixed/);
  await raw(db, "UPDATE yojitsu_variables SET label='次の段へ進む率（面談→提案・提案→契約）' WHERE code='conversion_rate'");
});

test('FR-REV-YOJITSU-006 K2-12 目標の版・計画の版と子表・採用の記録は、管理者のデータ一覧に表名ごと出ず、一括入出力の対象でもなく、ほかのコードは読まない', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  await store.addTargetVersion(db, 1, target(period.get(1)), {createdBy: ADMIN});
  await store.addPlanVersion(db, 1, plan(period.get(1)), {createdBy: ADMIN});
  assert.deepEqual([...OWNER_ONLY_TABLES].sort(), ['plan_adoptions', 'yojitsu_plan_amounts', 'yojitsu_plan_versions', 'yojitsu_target_versions']);
  const app = createApp({db, mode: 'local'});
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const call = async (path) => {
    const res = await app.request(`/api${path}`, {headers: {cookie}});
    return {status: res.status, text: await res.text()};
  };
  // 目標・計画の持ち主（管理者）でも、データ一覧の行・定義・Excel/CSV の元になる表には出さない（読むのは store の読み取り関数だけ）
  const list = JSON.parse((await call('/admin/tables')).text);
  const names = list.tables.map((t2) => t2.name);
  for (const table of OWNER_ONLY_TABLES) {
    assert.ok(!names.includes(table), `${table} がデータ一覧に出る`);
    assert.equal((await call(`/admin/tables/${table}`)).status, 404);
    assert.equal((await call(`/admin/tables/${table}/definition`)).status, 404);
  }
  // 期間と設定の行（額から報酬が割り戻せない）はデータ一覧に出る
  assert.ok(names.includes('yojitsu_periods') && names.includes('yojitsu_setting_versions'));
  // 監査の記録には額を残さない
  const audit = await call('/admin/tables/audit_log');
  assert.equal(audit.status, 200);
  assert.ok(!audit.text.includes('314159263') && !audit.text.includes('41421356'), '監査の記録に目標・計画の額が出る');
  // 一括入出力（Excel）の対象の表に入らない
  assert.ok(Object.values(BULK_ENTITIES).every((entity) => !OWNER_ONLY_TABLES.includes(entity.table)));
  // 帳票・一括出力・ほかの受け口のコードは、この4表を名前で読まない（読むのは revenue-store の読み取り関数だけ。表の和名と除外の一覧は除く）
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(mjs|jsx|js|sql)$/.test(name) ? [path] : [];
  });
  const allowed = new Set(['revenue/revenue-store.mjs', 'admin/data-browser-routes.mjs', 'admin/er-model.mjs']);
  const readers = files(src).map((path) => relative(src, path).replaceAll('\\', '/'))
    .filter((path) => !allowed.has(path) && OWNER_ONLY_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(readFileSync(join(src, path), 'utf8'))));
  assert.deepEqual(readers, []);
});

test('目標・計画・設定の書き込みは同じ batch で audit_log に1行ずつ残し、額・率・倍率を残さない（docs/rules/logging.md）', async (t) => {
  const db = await openTestDb({t});
  const period = await periods(db);
  await store.addTargetVersion(db, 1, target(period.get(1), {basisKind: 'labor_cost_multiple', amountYen: null, multiplierX100: 345}), {createdBy: ADMIN});
  await store.addPlanVersion(db, 1, plan(period.get(1)), {createdBy: ADMIN});
  await store.adoptPlanVersion(db, 1, {periodId: period.get(1), versionNo: 1, adoptedOn: '2026-10-03'}, {createdBy: ADMIN});
  await store.addSettingVersion(db, 1, {variableKey: 'unit_amount', scope: 'earning_type', earningType: 'committee', previousVersionNo: 0,
    value: {kind: 'yen', value: 19831303}, status: 'provisional'}, {createdBy: ADMIN});
  const rows = await db.all("SELECT entity_type,entity_id,detail_json FROM audit_log WHERE org_id=1 AND action='append' AND entity_type IN ('yojitsu_period','yojitsu_target_version','yojitsu_plan_version','plan_adoption','yojitsu_setting_version') ORDER BY id");
  assert.deepEqual(rows.map((r) => r.entity_type), ['yojitsu_period', 'yojitsu_target_version', 'yojitsu_plan_version', 'plan_adoption', 'plan_adoption', 'yojitsu_setting_version']);
  const details = rows.map((r) => JSON.parse(r.detail_json));
  assert.ok(details.every((d) => Object.keys(d).every((key) => !/yen|amount|bps|multiplier|value/i.test(key))), JSON.stringify(details));
  const values = details.flatMap((d) => Object.values(d).flat());
  for (const secret of [345, 41421356, 19831303, TOTAL]) assert.ok(!values.includes(secret), `${secret} が監査の記録に残る`);
});
