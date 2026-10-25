// 予算書（移行 0024）を、DB の制約と受け口（src/planning/budget/budget-routes.mjs）で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET と架空の予算書（test/fixtures/folder-budget/）から手で書いた。
// 架空のデータだけを使う（組織1・2と利用者・試作の案件1・2は試作の行）
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {buildBudgetXlsx, fictionalBudgetSheets} from './fixtures/folder-budget/build-budget-xlsx.mjs';

const DEMO_PROJECT = 1;
const OTHER_ORG_PROJECT = 2;
const rejects = (promise, message) => assert.rejects(promise, (error) => {
  assert.equal(dbErrorKind(error), 'raise', error.message);
  assert.match(error.message, message);
  return true;
});

async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, body: await response.json()};
  };
  return {login, call};
}
const budgetPath = (projectId, entry = '') => `/planning/projects/${projectId}/budget${entry ? `/${entry}` : ''}`;
const fileBase64 = (options) => Buffer.from(buildBudgetXlsx(fictionalBudgetSheets(options))).toString('base64');
const count = async (db, table) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=1`)).n);

test('FR-PLAN-BUDGET-008 FR-PLAN-BUDGET-010 FR-PLAN-BUDGET-017 予算書 xlsx を置くと下書きの版になり、総合計の式の誤りが例外として残って確定できない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const imported = await call(admin, budgetPath(DEMO_PROJECT, 'import'), {method: 'POST', payload: {fileName: '予算書_架空.xlsx', base64: fileBase64()}});
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.deepEqual([imported.body.versionNo, imported.body.verdict, imported.body.failed], [1, 'exceptions', 4]);
  const detail = await call(admin, budgetPath(DEMO_PROJECT));
  assert.equal(detail.status, 200);
  const v = detail.body.version;
  assert.deepEqual([v.versionNo, v.sourceKind, v.sourceFileName, v.lines.length, v.managementFeeYen, v.contingencyYen, v.sheetCreatedOn],
    [1, 'file', '予算書_架空.xlsx', 16, 100000, 50000, '2025-12-09']);
  assert.deepEqual([v.totals.directYen, v.totals.totalExTaxYen, v.totals.taxYen, v.totals.totalIncTaxYen], [3510000, 3660000, 366000, 4026000]);
  assert.equal(v.check.verdict, 'exceptions');
  assert.deepEqual(v.check.checks.filter((c) => c.ok === false).map((c) => c.key), ['total', 'estimate', 'tax', 'total_inc_tax']);
  assert.equal(v.lines.find((l) => l.name === '主演').confirmedSource, 'fill');
  assert.equal(v.lines.find((l) => l.name === '助監督').qtyMilli, 2500);
  assert.deepEqual(detail.body.state, {state: 'needs_review', done: 0, total: 1, reason: '例外 4'});
  const fix = await call(admin, budgetPath(DEMO_PROJECT, 'fixes'), {method: 'POST', payload: {action: 'fix', versionNo: 1, reason: '架空の確定'}});
  assert.equal(fix.status, 409);
  assert.equal(await count(db, 'budget_fixes'), 0);
  // DB も断る（受け口を通さない書き込み）
  await rejects(db.run("INSERT INTO budget_fixes(org_id,project_id,seq,action,version_id,reason,created_by) VALUES(1,1,1,'fix',(SELECT id FROM budget_versions WHERE org_id=1 AND project_id=1 AND version_no=1),'架空',1)"),
    /has exceptions/);
});

test('FR-PLAN-BUDGET-001 FR-PLAN-BUDGET-019 画面で直した版を足して確定し、取り消すと確定版が無くなり、確定した版には行を足せず、版と行は書き換え・削除できない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const payload = {reason: '架空の見積りを直した', managementFeeYen: 100000, contingencyYen: 50000,
    lines: [{categoryCode: 'A', name: '脚本料', amountExTaxYen: 400000, unitPriceYen: 200000, qtyMilli: 2000, unit: '本'},
      {categoryCode: 'D', name: '助監督', amountExTaxYen: 300000, confirmed: true, paymentMonth: '2026-11'},
      {categoryCode: 'A', name: '企画開発費', amountExTaxYen: 100000}]};
  const added = await call(admin, budgetPath(DEMO_PROJECT, 'versions'), {method: 'POST', payload});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual([added.body.versionNo, added.body.verdict], [1, 'draft_ok']);
  const detail = (await call(admin, budgetPath(DEMO_PROJECT))).body;
  assert.deepEqual(detail.version.lines.map((l) => [l.categoryCode, l.lineNo, l.name]), [['A', 1, '脚本料'], ['A', 2, '企画開発費'], ['D', 1, '助監督']]);
  assert.equal(detail.version.lines.find((l) => l.name === '助監督').confirmedSource, 'manual');
  assert.equal(detail.version.totals.totalExTaxYen, 950000);
  assert.equal(detail.state.state, 'in_progress');
  const fixed = await call(admin, budgetPath(DEMO_PROJECT, 'fixes'), {method: 'POST', payload: {action: 'fix', versionNo: 1, reason: '架空の確定'}});
  assert.equal(fixed.status, 201, JSON.stringify(fixed.body));
  const afterFix = (await call(admin, budgetPath(DEMO_PROJECT))).body;
  assert.deepEqual([afterFix.fixedVersionNo, afterFix.state.state, afterFix.state.reason], [1, 'done', '確定 rev1']);
  // 同じ版をもう一度確定しない
  assert.equal((await call(admin, budgetPath(DEMO_PROJECT, 'fixes'), {method: 'POST', payload: {action: 'fix', versionNo: 1, reason: '二度目'}})).status, 409);
  // 確定した版には行を足せない
  await rejects(db.run(`INSERT INTO budget_version_lines(org_id,project_id,version_id,category_code,line_no,name,amount_ex_tax_yen,confirmed_source)
    VALUES(1,1,(SELECT id FROM budget_versions WHERE org_id=1 AND project_id=1 AND version_no=1),'K',1,'後から足す行',1,'none')`), /already fixed/);
  // 版・行は書き換え・削除できない
  await rejects(db.run("UPDATE budget_versions SET reason='書き換え' WHERE org_id=1"), /immutable/);
  await rejects(db.run('DELETE FROM budget_version_lines WHERE org_id=1'), /immutable/);
  await rejects(db.run('DELETE FROM budget_fixes WHERE org_id=1'), /immutable/);
  // 前の版を写して直した版2。確定版は1のまま、進み具合の理由に下書きが出る
  const copy = await call(admin, budgetPath(DEMO_PROJECT, 'versions'), {method: 'POST', payload: {...payload, copyOf: 1, reason: '架空の追加',
    lines: [...payload.lines, {categoryCode: 'B', name: '主演', amountExTaxYen: 300000}]}});
  assert.equal(copy.status, 201);
  const second = (await call(admin, budgetPath(DEMO_PROJECT))).body;
  assert.deepEqual([second.version.versionNo, second.version.sourceKind, second.fixedVersionNo, second.state.reason], [2, 'copy', 1, '確定 rev1・下書き rev2']);
  assert.deepEqual(second.version.comparison.categories.filter((c) => c.diffYen).map((c) => [c.code, c.diffYen]), [['B', 300000]]);
  // 取り消せるのはいまの確定版だけ
  assert.equal((await call(admin, budgetPath(DEMO_PROJECT, 'fixes'), {method: 'POST', payload: {action: 'void', versionNo: 2, reason: '違う版'}})).status, 409);
  const voided = await call(admin, budgetPath(DEMO_PROJECT, 'fixes'), {method: 'POST', payload: {action: 'void', versionNo: 1, reason: '架空の取り消し'}});
  assert.equal(voided.status, 201);
  const afterVoid = (await call(admin, budgetPath(DEMO_PROJECT))).body;
  assert.deepEqual([afterVoid.fixedVersionNo, afterVoid.state.state], [null, 'in_progress']);
  assert.deepEqual(afterVoid.history.map((h) => [h.action, h.versionNo]), [['fix', 1], ['void', 1]]);
  // 版の番号の飛ばしは DB が断る
  await rejects(db.run("INSERT INTO budget_versions(org_id,project_id,version_no,source_kind,tax_rate_bps,management_fee_yen,contingency_yen,reason,created_by) VALUES(1,1,5,'screen',1000,0,0,'飛ばし',1)"),
    /stale budget version/);
});

test('FR-PLAN-BUDGET-018 FR-PLAN-BUDGET-020 FR-PLAN-BUDGET-021 制作担当と別の組織には見せず、確定は管理者だけで、一覧は見てよい案件の進み具合と確定版の総合計を返す', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const editor = await login('editor@openingnight.invalid');
  const production = await login('production@openingnight.invalid');
  const outsider = await login('outsider@other.invalid');
  const lines = [{categoryCode: 'F', name: '撮影機材費', amountExTaxYen: 250000}];
  // 編集担当（案件1に編集の権限）は版を足せるが、確定はできない
  const added = await call(editor, budgetPath(DEMO_PROJECT, 'versions'), {method: 'POST', payload: {reason: '架空', lines}});
  assert.equal(added.status, 201);
  assert.equal((await call(editor, budgetPath(DEMO_PROJECT, 'fixes'), {method: 'POST', payload: {action: 'fix', versionNo: 1, reason: '架空'}})).status, 403);
  assert.equal((await call(editor, budgetPath(DEMO_PROJECT))).body.canFix, false);
  // 制作担当・別の組織の人には頁も値も見せない（同じ 403）
  for (const cookie of [production, outsider]) {
    assert.equal((await call(cookie, budgetPath(DEMO_PROJECT))).status, 403);
    assert.equal((await call(cookie, budgetPath(DEMO_PROJECT, 'versions'), {method: 'POST', payload: {reason: '架空', lines}})).status, 403);
  }
  assert.equal((await call(production, '/planning/budgets')).status, 403);
  // 別の組織の案件は、管理者からも見えない
  assert.equal((await call(admin, budgetPath(OTHER_ORG_PROJECT))).status, 403);
  assert.equal((await call(admin, budgetPath(DEMO_PROJECT, 'fixes'), {method: 'POST', payload: {action: 'fix', versionNo: 1, reason: '架空の確定'}})).status, 201);
  const list = await call(admin, '/planning/budgets');
  assert.equal(list.status, 200);
  const row = list.body.budgets.find((b) => b.projectId === DEMO_PROJECT);
  assert.deepEqual([row.latestVersionNo, row.fixedVersionNo, row.fixedTotalExTaxYen, row.state.state], [1, 1, 250000, 'done']);
  assert.equal(list.body.budgets.some((b) => b.projectId === OTHER_ORG_PROJECT), false);
});

test('FR-PLAN-BUDGET-003 FR-PLAN-BUDGET-013 行の誤りは欄ごとの文で断り、見出しの無いブックは形違いで断って、どちらも版を足さない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const bad = await call(admin, budgetPath(DEMO_PROJECT, 'versions'), {method: 'POST', payload: {reason: '', lines: [{categoryCode: 'L', name: '雑費', amountExTaxYen: 1},
    {categoryCode: 'A', name: '', amountExTaxYen: -1}, {categoryCode: 'B', name: '主演', amountExTaxYen: 1, workId: 999, paymentMonth: '2026-13'}]}});
  assert.equal(bad.status, 400);
  for (const message of ['理由', '1行目の区分', '2行目の費目名', '2行目の税抜額', '3行目の作品', '3行目の支払予定月']) assert.ok(bad.body.details.errors.some((e) => e.includes(message)), message);
  const none = Buffer.from(buildBudgetXlsx([{name: '一覧', cells: [{ref: 'A1', value: '作品'}, {ref: 'B1', value: '金額'}]}])).toString('base64');
  const shape = await call(admin, budgetPath(DEMO_PROJECT, 'import'), {method: 'POST', payload: {fileName: '一覧.xlsx', base64: none}});
  assert.equal(shape.status, 422);
  assert.equal(shape.body.details.reason, 'no_header');
  assert.equal((await call(admin, budgetPath(DEMO_PROJECT, 'import'), {method: 'POST', payload: {fileName: '予算.csv', base64: fileBase64()}})).status, 400);
  assert.equal(await count(db, 'budget_versions'), 0);
});
