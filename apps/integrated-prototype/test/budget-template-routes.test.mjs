// 予算書の型（テンプレ）・行の内訳・xlsx の書き出し（移行 0027）を、DB の制約と受け口で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-027〜034 と架空の行から手で書いた。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {readBudgetFile} from '../src/planning/budget/budget-xlsx.mjs';
import {buildBudgetWorkbook} from '../src/planning/budget/budget-xlsx-write.mjs';

const PROJECT = 1;
const rejects = (promise, message) => assert.rejects(promise, (error) => { assert.equal(dbErrorKind(error), 'raise', error.message); assert.match(error.message, message); return true; });

async function appWithLogin(db) {
  const app = createApp({db, mode: 'local'});
  const login = async (email) => {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const call = async (cookie, path, {method = 'GET', payload} = {}) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, ...(payload ? {'content-type': 'application/json'} : {})}, body: payload ? JSON.stringify(payload) : undefined});
    const type = response.headers.get('content-type') ?? '';
    return {status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : new Uint8Array(await response.arrayBuffer())};
  };
  return {login, call};
}
const CAST_LINE = {categoryCode: 'B', name: 'キャスト費', amountExTaxYen: 1400000, breakdown: {sheet: 'キャスト', items: [
  {label: '主演', qtyMilli: 5000, unitPriceYen: 200000, amountExTaxYen: 1000000}, {label: 'ヒロイン', amountExTaxYen: 400000, castingRef: 'cast-2'}]}};

test('FR-PLAN-BUDGET-029 FR-PLAN-BUDGET-027 内訳のある行を版に残し、1冊に内訳が出て、版を xlsx で落とすと内訳は別のシートの SUMIF になり、読み直すと同じ額', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const added = await call(admin, `/planning/projects/${PROJECT}/budget/versions`, {method: 'POST', payload: {reason: '架空', managementFeeYen: 100000,
    lines: [{categoryCode: 'A', name: '脚本料', amountExTaxYen: 400000}, CAST_LINE]}});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const detail = (await call(admin, `/planning/projects/${PROJECT}/budget`)).body;
  const cast = detail.version.lines.find((l) => l.name === 'キャスト費');
  assert.deepEqual(cast.breakdown.items.map((i) => [i.itemNo, i.label, i.amountExTaxYen, i.castingRef]), [[1, '主演', 1000000, null], [2, 'ヒロイン', 400000, 'cast-2']]);
  assert.equal(detail.version.totals.totalExTaxYen, 1900000);
  const file = await call(admin, `/planning/projects/${PROJECT}/budget/versions/1/xlsx`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''/);
  const parsed = readBudgetFile(file.body);
  assert.deepEqual(parsed.breakdownSheets, ['キャスト']);
  assert.deepEqual(parsed.lines.find((l) => l.name === 'キャスト費').breakdown.items.map((i) => i.label), ['主演', 'ヒロイン']);
  assert.equal(parsed.breakdownChecks[0].ok, true);
  // 内訳の和と違う額の行は断る
  const bad = await call(admin, `/planning/projects/${PROJECT}/budget/versions`, {method: 'POST', payload: {reason: '架空', lines: [{...CAST_LINE, amountExTaxYen: 1}]}});
  assert.equal(bad.status, 400);
  // 確定した版には内訳を足せず、内訳は書き換え・削除できない
  assert.equal((await call(admin, `/planning/projects/${PROJECT}/budget/fixes`, {method: 'POST', payload: {action: 'fix', versionNo: 1, reason: '架空'}})).status, 201);
  await rejects(db.run(`INSERT INTO budget_line_items(org_id,project_id,version_id,category_code,line_no,item_no,breakdown_sheet,label,amount_ex_tax_yen)
    VALUES(1,1,(SELECT id FROM budget_versions WHERE org_id=1 AND project_id=1 AND version_no=1),'B',1,3,'キャスト','後から',1)`), /already fixed/);
  await rejects(db.run('DELETE FROM budget_line_items WHERE org_id=1'), /immutable/);
});

test('FR-PLAN-BUDGET-032 FR-PLAN-BUDGET-033 FR-PLAN-BUDGET-028 案件の版から型を作り、費目を「型にも足す」と型の版が上がり、型を xlsx で落とすと費目と空の内訳のシートが並び、型から作った版はどの型かを持つ', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  await call(admin, `/planning/projects/${PROJECT}/budget/versions`, {method: 'POST', payload: {reason: '架空', lines: [
    {categoryCode: 'A', name: '脚本料', amountExTaxYen: 400000, unitPriceYen: 200000, qtyMilli: 2000, unit: '本'}, CAST_LINE, {categoryCode: 'F', name: '撮影機材費', amountExTaxYen: 250000}]}});
  const created = await call(admin, '/planning/budget-templates', {method: 'POST', payload: {name: 'Vシネ 2〜3本撮り', reason: '架空の予算書から', from: {projectId: PROJECT, versionNo: 1}}});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.templateId;
  const v1 = (await call(admin, `/planning/budget-templates/${id}`)).body;
  assert.deepEqual(v1.items.map((i) => [i.categoryCode, i.name, i.breakdownSheet]), [['A', '脚本料', null], ['B', 'キャスト費', 'キャスト'], ['F', '撮影機材費', null]]);
  assert.equal(v1.items[0].qtyMilli, 2000);
  // 同じ名前の型は作れない
  assert.equal((await call(admin, '/planning/budget-templates', {method: 'POST', payload: {name: 'Vシネ 2〜3本撮り', reason: '二度目', items: []}})).status, 409);
  // 型にも足す（今の版のあとに区分ごとに足す）。同じ名前は断る。古い版を見て足そうとすると 409
  const grown = await call(admin, `/planning/budget-templates/${id}/versions`, {method: 'POST', payload: {reason: '夜間ドローンを足した', baseVersionNo: 1,
    additions: [{categoryCode: 'F', name: '夜間ドローン撮影'}]}});
  assert.equal(grown.status, 201, JSON.stringify(grown.body));
  assert.equal(grown.body.versionNo, 2);
  assert.equal((await call(admin, `/planning/budget-templates/${id}/versions`, {method: 'POST', payload: {reason: '重複', additions: [{categoryCode: 'F', name: '撮影機材費'}]}})).status, 400);
  assert.equal((await call(admin, `/planning/budget-templates/${id}/versions`, {method: 'POST', payload: {reason: '古い', baseVersionNo: 1, additions: [{categoryCode: 'K', name: '試写'}]}})).status, 409);
  const list = (await call(admin, '/planning/budget-templates')).body.templates;
  assert.deepEqual(list.map((x) => [x.name, x.latestVersionNo, x.itemCount, x.breakdownCount]), [['Vシネ 2〜3本撮り', 2, 4, 1]]);
  const v2 = (await call(admin, `/planning/budget-templates/${id}`)).body;
  assert.deepEqual(v2.items.filter((i) => i.categoryCode === 'F').map((i) => [i.lineNo, i.name]), [[1, '撮影機材費'], [2, '夜間ドローン撮影']]);
  assert.equal((await call(admin, `/planning/budget-templates/${id}?version=1`)).body.items.length, 3); // 前の版は残る
  // 型を xlsx で落とし、型として読み直すと同じ費目
  const file = await call(admin, `/planning/budget-templates/${id}/xlsx`);
  assert.equal(file.status, 200);
  const asTemplate = readBudgetFile(file.body, {keepEmpty: true});
  assert.deepEqual(asTemplate.lines.map((l) => l.name), ['脚本料', 'キャスト費', '撮影機材費', '夜間ドローン撮影']);
  assert.deepEqual(asTemplate.breakdownSheets, ['キャスト']);
  // 型から作った版は型の版を指す
  const fromTemplate = await call(admin, `/planning/projects/${PROJECT}/budget/versions`, {method: 'POST', payload: {reason: '型から', templateId: id,
    lines: v2.items.map((i) => ({categoryCode: i.categoryCode, name: i.name, amountExTaxYen: 0}))}});
  assert.equal(fromTemplate.status, 201, JSON.stringify(fromTemplate.body));
  assert.deepEqual((await call(admin, `/planning/projects/${PROJECT}/budget`)).body.version.template, {templateId: id, name: 'Vシネ 2〜3本撮り', versionNo: 2});
  // 型の版と費目は書き換え・削除できない
  await rejects(db.run("UPDATE budget_template_items SET name='書き換え' WHERE org_id=1"), /immutable/);
  await rejects(db.run('DELETE FROM budget_template_versions WHERE org_id=1'), /immutable/);
});

test('FR-PLAN-BUDGET-034 予算書 xlsx から型を作れ、制作担当は型を見られず、別の組織の型は見えない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const {bytes} = buildBudgetWorkbook({title: '架空', template: true, lines: [{categoryCode: 'A', name: '企画開発費'}, {categoryCode: 'D', name: '撮影技師', unitPriceYen: 50000, qtyMilli: 9000, unit: '日'}]});
  const created = await call(admin, '/planning/budget-templates', {method: 'POST', payload: {name: '架空の型', reason: '代表の予算表（デモ）から', fileName: '型.xlsx',
    base64: Buffer.from(bytes).toString('base64')}});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual((await call(admin, `/planning/budget-templates/${created.body.templateId}`)).body.items.map((i) => i.name), ['企画開発費', '撮影技師']);
  const production = await login('production@openingnight.invalid');
  assert.equal((await call(production, '/planning/budget-templates')).status, 403);
  assert.equal((await call(production, `/planning/budget-templates/${created.body.templateId}/xlsx`)).status, 403);
  const outsider = await login('outsider@other.invalid');
  assert.equal((await call(outsider, `/planning/budget-templates/${created.body.templateId}`)).status, 404);
  assert.deepEqual((await call(outsider, '/planning/budget-templates')).body.templates, []);
});
