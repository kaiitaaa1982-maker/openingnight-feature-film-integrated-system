// 案件収支の予実の語を選ぶ設定と月の設定（採用するシナリオ・月別の表に入れる案件の範囲・締めた月。フェーズ1の仕様書 #14、移行 0018）を、
// DB の制約と store（src/revenue/revenue-store.mjs の addChoiceVersion・readEffectiveChoices）と入力の読み取り（yojitsu-model の normalizeChoiceInput）で
// 確かめる。期待値は要件 docs/requirements/revenue/project-cashflow-forecast-actual.md の FR-REV-YOJITSU-045・034 と要確認15 の推奨（語は CHECK、
// 月は月初の日の CHECK、版を足して残す）、計画の K-8（有効な版は最新の version_no）。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {CHOICE_CODES, latestChoices, normalizeChoiceInput} from '../src/revenue/yojitsu/yojitsu-model.mjs';

const ADMIN = 1; // 組織1の管理者（試作の行）
const OUTSIDER = 4; // 組織2の管理者（試作の行）
const rejects = (promise, kind, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), kind, error.message);
  if (message) assert.match(error.message, message);
  return true;
});
const insert = (db, {orgId = 1, key, versionNo = 1, code = null, month = null, by = ADMIN}) =>
  db.run('INSERT INTO yojitsu_choice_versions(org_id,choice_key,version_no,value_code,value_month,created_by) VALUES(?,?,?,?,?,?)', [orgId, key, versionNo, code, month, by]);
const choice = (overrides) => {
  const n = normalizeChoiceInput({previousVersionNo: 0, ...overrides});
  assert.equal(n.ok, true, JSON.stringify(n.errors));
  return n.value;
};

test('FR-REV-YOJITSU-045 採用するシナリオは even・good・max・single、月別の表の範囲は all・landing・contracted の語だけで、締めた月は月初の日だけ（DB の CHECK）', async (t) => {
  const db = await openTestDb({t});
  for (const code of CHOICE_CODES.adopted_scenario) await insert(db, {key: 'adopted_scenario', code, versionNo: CHOICE_CODES.adopted_scenario.indexOf(code) + 1});
  for (const code of CHOICE_CODES.monthly_scope) await insert(db, {key: 'monthly_scope', code, versionNo: CHOICE_CODES.monthly_scope.indexOf(code) + 1});
  await insert(db, {key: 'closed_month', month: '2026-11-01'});
  // 語の取り違え・空・大文字（画面の語の MAX）は断る。語の設定に月を、月の設定に語を入れても断る（値の列はちょうど1つ）
  await rejects(insert(db, {key: 'adopted_scenario', versionNo: 5, code: 'MAX'}), 'check');
  await rejects(insert(db, {key: 'adopted_scenario', versionNo: 5, code: 'landing'}), 'check');
  await rejects(insert(db, {key: 'adopted_scenario', versionNo: 5, code: null}), 'check');
  await rejects(insert(db, {key: 'adopted_scenario', versionNo: 5, code: 'good', month: '2026-11-01'}), 'check');
  await rejects(insert(db, {key: 'monthly_scope', versionNo: 4, code: 'good'}), 'check');
  await rejects(insert(db, {key: 'closed_month', versionNo: 2, month: '2026-11-02'}), 'check');
  await rejects(insert(db, {key: 'closed_month', versionNo: 2, month: '2026-13-01'}), 'check');
  await rejects(insert(db, {key: 'closed_month', versionNo: 2, month: '２０２６-11-01'}), 'check');
  await rejects(insert(db, {key: 'closed_month', versionNo: 2, month: '2026-12-01', code: 'good'}), 'check');
  await rejects(insert(db, {key: 'closed_month', versionNo: 2, month: null}), 'check');
  await rejects(insert(db, {key: 'scenario', versionNo: 1, code: 'good'}), 'check');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM yojitsu_choice_versions WHERE org_id=1')).n), 8);
});

test('FR-REV-YOJITSU-045 設定は版を足して残り、最初の版を消せず、有効な設定は設定ごとの最新の版（古い画面からの書き込みは断る）', async (t) => {
  const db = await openTestDb({t});
  assert.deepEqual(await store.readEffectiveChoices(db, 1), {adoptedScenario: null, monthlyScope: null, closedMonth: null});
  assert.equal(await store.addChoiceVersion(db, 1, choice({choiceKey: 'adopted_scenario', value: 'good', basis: '架空の根拠'}), {createdBy: ADMIN}), 1);
  assert.equal(await store.addChoiceVersion(db, 1, choice({choiceKey: 'closed_month', value: '2026-11-01'}), {createdBy: ADMIN}), 1);
  assert.equal(await store.addChoiceVersion(db, 1, choice({choiceKey: 'adopted_scenario', previousVersionNo: 1, value: 'single'}), {createdBy: ADMIN}), 2);
  assert.deepEqual(await store.readEffectiveChoices(db, 1), {adoptedScenario: {value: 'single', versionNo: 2}, monthlyScope: null,
    closedMonth: {value: '2026-11-01', versionNo: 1}});
  // 同じ版の番号を2回足す（古い画面）・番号を飛ばすと断り、変更の記録も残らない
  const audits = async () => Number((await db.get("SELECT COUNT(*) AS n FROM audit_log WHERE org_id=1 AND entity_type='yojitsu_choice_version'")).n);
  const before = await audits();
  await rejects(store.addChoiceVersion(db, 1, choice({choiceKey: 'adopted_scenario', previousVersionNo: 1, value: 'even'}), {createdBy: ADMIN}), 'raise', /stale yojitsu choice version/);
  await rejects(store.addChoiceVersion(db, 1, choice({choiceKey: 'adopted_scenario', previousVersionNo: 3, value: 'even'}), {createdBy: ADMIN}), 'raise', /stale yojitsu choice version/);
  assert.equal(await audits(), before);
  // 変更・削除は DB が断る（最初の版を残す）
  await rejects(db.run("UPDATE yojitsu_choice_versions SET value_code='even' WHERE org_id=1 AND choice_key='adopted_scenario' AND version_no=1"), 'raise', /append-only/);
  await rejects(db.run("DELETE FROM yojitsu_choice_versions WHERE org_id=1 AND choice_key='adopted_scenario' AND version_no=1"), 'raise', /append-only/);
  const rows = await db.all("SELECT version_no,value_code FROM yojitsu_choice_versions WHERE org_id=1 AND choice_key='adopted_scenario' ORDER BY version_no");
  assert.deepEqual(rows.map((r) => [Number(r.version_no), r.value_code]), [[1, 'good'], [2, 'single']]);
  // 変更の記録は設定と版の番号だけ
  const detail = await db.all("SELECT entity_id,detail_json FROM audit_log WHERE org_id=1 AND entity_type='yojitsu_choice_version' ORDER BY id");
  assert.deepEqual(detail.map((r) => [r.entity_id, JSON.parse(r.detail_json)]), [
    ['adopted_scenario:1', {choiceKey: 'adopted_scenario', versionNo: 1}], ['closed_month:1', {choiceKey: 'closed_month', versionNo: 1}],
    ['adopted_scenario:2', {choiceKey: 'adopted_scenario', versionNo: 2}]]);
});

test('FR-REV-YOJITSU-045 設定は組織ごとで、別の組織の利用者は記録した人にできず、別の組織の設定は読めない', async (t) => {
  const db = await openTestDb({t});
  await store.addChoiceVersion(db, 1, choice({choiceKey: 'adopted_scenario', value: 'max'}), {createdBy: ADMIN});
  await rejects(insert(db, {orgId: 1, key: 'monthly_scope', code: 'all', by: OUTSIDER}), 'foreign_key');
  await store.addChoiceVersion(db, 2, choice({choiceKey: 'adopted_scenario', value: 'even'}), {createdBy: OUTSIDER});
  assert.deepEqual((await store.readEffectiveChoices(db, 1)).adoptedScenario, {value: 'max', versionNo: 1});
  assert.deepEqual((await store.readEffectiveChoices(db, 2)).adoptedScenario, {value: 'even', versionNo: 1});
});

test('FR-REV-YOJITSU-045 設定の入力の読み取りは、語の設定に語・締めた月に月初の日だけを受け、項目ごとの誤りを返す', () => {
  assert.deepEqual(normalizeChoiceInput({choiceKey: 'adopted_scenario', value: 'good'}).value,
    {choiceKey: 'adopted_scenario', previousVersionNo: 0, valueCode: 'good', valueMonth: null, basis: null});
  assert.deepEqual(normalizeChoiceInput({choiceKey: 'closed_month', value: '2027-03-01', previousVersionNo: 2, basis: ' 架空の根拠 '}).value,
    {choiceKey: 'closed_month', previousVersionNo: 2, valueCode: null, valueMonth: '2027-03-01', basis: '架空の根拠'});
  const fields = (raw) => normalizeChoiceInput(raw).errors.map((e) => e.field);
  assert.deepEqual(fields({choiceKey: 'scenario', value: 'good'}), ['choiceKey']);
  assert.deepEqual(fields({choiceKey: 'adopted_scenario', value: 'MAX'}), ['value']);
  assert.deepEqual(fields({choiceKey: 'monthly_scope', value: 'single'}), ['value']);
  assert.deepEqual(fields({choiceKey: 'closed_month', value: '2027-03-15'}), ['value']);
  assert.deepEqual(fields({choiceKey: 'closed_month', value: '2027-03-01', previousVersionNo: -1}), ['previousVersionNo']);
  assert.deepEqual(fields({choiceKey: 'adopted_scenario', value: 'good', basis: 'x'.repeat(1001)}), ['basis']);
  // 有効な設定は設定ごとの最新の版（行の並びに依らない）
  assert.deepEqual(latestChoices([
    {choice_key: 'monthly_scope', version_no: 2, value_code: 'landing', value_month: null},
    {choice_key: 'monthly_scope', version_no: 3, value_code: 'contracted', value_month: null},
    {choice_key: 'monthly_scope', version_no: 1, value_code: 'all', value_month: null},
  ]), {adoptedScenario: null, monthlyScope: {value: 'contracted', versionNo: 3}, closedMonth: null});
});
