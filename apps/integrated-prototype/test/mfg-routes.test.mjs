// 製造（移行 0032）を、純関数・DB の制約・受け口（src/manufacturing/mfg-routes.mjs）で確かめる。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる。
// 期待値は会社ルートの plans/2026-10-24-folder-seizou.md の第2版の型（25日の型・日数の型）から手で書いた。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {dbErrorKind} from '../src/data-platform/db-errors.mjs';
import {mfgMaterialDueDate, monthDay, plannedSteps, priceToX100, purchaseOrderState} from '../src/manufacturing/mfg-model.mjs';

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

test('25日の型: 発売月の n か月前の d 日で12工程の予定日が出る（セルはレンタルの表1・表4を含まない）', () => {
  const sell = plannedSteps({releaseOn: '2027-04-25', scheduleRule: 'day25', channel: 'sell'});
  const at = (key) => sell.find((s) => s.key === key);
  assert.deepEqual([at('material').dueOn, at('text_spec').requestOn, at('text_spec').dueOn, at('check_disc').dueOn, at('announce').dueOn, at('release').dueOn],
    ['2027-01-15', '2027-01-10', '2027-01-17', '2027-02-20', '2027-02-25', '2027-04-25']);
  assert.equal(sell.some((s) => s.key === 'rental_front'), false);
  const rental = plannedSteps({releaseOn: '2027-04-25', scheduleRule: 'day25', channel: 'rental'});
  assert.deepEqual([rental.find((s) => s.key === 'rental_front').requestOn, rental.find((s) => s.key === 'rental_front').dueOn], ['2027-01-26', '2027-02-06']);
  assert.equal(monthDay('2027-03-25', -1, 31), '2027-02-28', '月末に寄せる');
});

test('日数の型: 25日でない発売日は発売日の n 日前。素材の期限は調達が読む', () => {
  assert.equal(mfgMaterialDueDate({releaseOn: '2027-05-21', scheduleRule: 'offset'}), '2027-02-11');
  assert.equal(mfgMaterialDueDate({releaseOn: '2027-04-25', scheduleRule: 'day25'}), '2027-01-15');
  const steps = plannedSteps({releaseOn: '2027-05-21', scheduleRule: 'offset', channel: 'rental'});
  assert.equal(steps.find((s) => s.key === 'announce').dueOn, '2027-03-21');
});

test('単価は小数2桁まで丸めずに銭へ。発注書の段は納品が全部の明細で揃ったとき', () => {
  assert.equal(priceToX100('12.5'), 1250);
  assert.equal(priceToX100('1,200'), 120000);
  assert.equal(priceToX100('1.234'), null);
  const lines = [{id: 1, qty: 10}, {id: 2, qty: 5}];
  const partial = purchaseOrderState({events: [{kind: 'ordered'}], lines, receipts: [{poLineId: 1, qty: 10, defectQty: 0, result: 'pass'}]});
  assert.equal(partial.stage, 'ordered');
  const full = purchaseOrderState({events: [{kind: 'ordered'}], lines, receipts: [{poLineId: 1, qty: 10, defectQty: 0, result: 'pass'}, {poLineId: 2, qty: 5, defectQty: 0, result: 'pass'}]});
  assert.equal(full.stage, 'received');
});

test('商品を登録し、工程を記録し、発注書を作って納品と経費の結びまで進める。制作担当と別の組織は403', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const list0 = await call(admin, '/mfg/products?today=2027-01-20');
  assert.equal(list0.status, 200, JSON.stringify(list0.body));
  const work = list0.body.works.find((w) => w.projectId === 1);
  assert.ok(work, '試作の案件1の作品');
  const created = await call(admin, '/mfg/products', {method: 'POST', payload: {workId: work.id, sourceKind: 'procure', name: '架空の作品 通常版', channel: 'sell', media: 'dvd',
    releaseOn: '2027-04-25', plannedQty: 3000}});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const productId = created.body.productId;

  const step = await call(admin, `/mfg/products/${productId}/steps`, {method: 'POST', payload: {stepKey: 'text_spec', kind: 'approved', onDate: '2027-01-16'}});
  assert.equal(step.status, 201, JSON.stringify(step.body));
  const detail = await call(admin, `/mfg/products/${productId}?today=2027-01-20`);
  assert.equal(detail.status, 200);
  const state = (key) => detail.body.steps.find((s) => s.key === key).state;
  assert.equal(state('text_spec'), 'done');
  assert.equal(state('material'), 'late', '素材の期限 1/15 を過ぎて済でない');
  assert.equal(state('release'), 'open');

  const order = await call(admin, `/mfg/products/${productId}/orders`, {method: 'POST', payload: {poKind: 'print', partnerLabel: '架空印刷', deliverTo: '架空倉庫',
    dueOn: '2027-03-31', lines: [{item: 'ジャケット', spec: '4色', qty: 3000, unitPrice: '12.5'}]}});
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const bad = await call(admin, `/mfg/products/${productId}/orders`, {method: 'POST', payload: {poKind: 'print', partnerLabel: '架空印刷', lines: [{item: '帯', qty: 3, unitPrice: '0.5'}]}});
  assert.equal(bad.status, 400, '1円で割り切れない額は断る');
  assert.equal((await call(admin, `/mfg/orders/${order.body.poId}/events`, {method: 'POST', payload: {kind: 'ordered', onDate: '2027-02-01'}})).status, 201);
  const after = await call(admin, `/mfg/products/${productId}`);
  const po = after.body.orders[0];
  assert.equal(po.orderedExTax, 37500);
  assert.equal(po.stage, 'ordered');
  const lineId = po.lines[0].id;
  assert.equal((await call(admin, `/mfg/order-lines/${lineId}/receipts`, {method: 'POST', payload: {receivedOn: '2027-03-28', qty: 3000}})).status, 201);
  const expense = await db.get('SELECT id FROM expenses WHERE org_id=1 AND project_id=1 ORDER BY id LIMIT 1');
  if (expense) {
    const linked = await call(admin, `/mfg/order-lines/${lineId}/expenses`, {method: 'POST', payload: {expenseId: Number(expense.id)}});
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
  }
  const last = await call(admin, `/mfg/products/${productId}`);
  assert.equal(last.body.orders[0].reached.includes('received'), true);

  // 取消した発注書には段を足せない
  assert.equal((await call(admin, `/mfg/orders/${order.body.poId}/events`, {method: 'POST', payload: {kind: 'void', onDate: '2027-03-29', note: '架空の取消'}})).status, 201);
  assert.equal((await call(admin, `/mfg/orders/${order.body.poId}/events`, {method: 'POST', payload: {kind: 'paid', onDate: '2027-04-30'}})).status, 409);

  const production = await login('production@openingnight.invalid').catch(() => null);
  if (production) assert.equal((await call(production, `/mfg/products/${productId}`)).status, 403);
  const other = await login('other@openingnight.invalid').catch(() => null);
  if (other) assert.equal((await call(other, `/mfg/products/${productId}`)).status, 403);
});

test('行は足すだけ: 商品の版・発注書の明細は書き換えも削除もできない', async (t) => {
  const db = await openTestDb({t});
  const {login, call} = await appWithLogin(db);
  const admin = await login('admin@openingnight.invalid');
  const list = await call(admin, '/mfg/products');
  const work = list.body.works.find((w) => w.projectId === 1);
  const created = await call(admin, '/mfg/products', {method: 'POST', payload: {workId: work.id, sourceKind: 'own', name: '架空のパンフ', channel: 'print', media: 'print', releaseOn: '2027-06-10'}});
  const raw = (sql) => assert.rejects(db.run(sql, [created.body.productId]), (error) => { assert.equal(dbErrorKind(error), 'raise', error.message); return true; });
  await raw('UPDATE mfg_product_versions SET name=\'x\' WHERE product_id=?');
  await raw('DELETE FROM mfg_products WHERE id=?');
});
