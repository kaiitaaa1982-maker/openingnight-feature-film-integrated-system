import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

async function fixture({t} = {}) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  async function login(email) {
    const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    return response.headers.get('set-cookie').split(';')[0];
  }
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, body, cookie = admin) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const sale = (key, fields) => req('/sales', {workId: 1, report_key: key, kind: 'digital', description: '架空売上', quantity: 2, basis_reason: '架空の根拠', recognition_basis_id: 1, ...fields});
  assert.equal((await sale('LIST-1', {partner_id: 2, product_id: 1, period_from: '2026-06-01', period_to: '2026-06-30', sales_month: '2026-06', amount_ex_tax: 1000, tax_amount: 100, amount_inc_tax: 1100})).status, 200);
  assert.equal((await sale('LIST-2', {partner_id: 3, product_id: 2, kind: 'package', period_from: '2026-07-01', period_to: '2026-07-31', sales_month: '2026-07', amount_ex_tax: 5000, tax_amount: 500, amount_inc_tax: 5500})).status, 200);
  return {db, req, login};
}

test('company-wide sales lines filter by period, partner, search and show billing status', async (t) => {
  const f = await fixture({t});
  const all = (await f.req('/sales-lines?from=2026-05&to=2027-04')).data;
  assert.equal(all.count, 2);
  assert.deepEqual(all.totals, {amount_ex_tax: 6000, tax_amount: 600, amount_inc_tax: 6600});
  assert.equal(all.rows[0].accounting_month, '2026-07', 'newest first');
  assert.equal(all.rows[0].billing_status, '未請求');
  assert.equal(all.rows[0].receipt_status, '—');
  assert.equal(all.rows[1].product_name, 'デジタル視聴');
  assert.equal((await f.req('/sales-lines?partnerId=3')).data.count, 1);
  assert.equal((await f.req('/sales-lines?from=2026-07&to=2026-07')).data.rows[0].report_key, 'LIST-2');
  assert.equal((await f.req(`/sales-lines?q=${encodeURIComponent('架空ストア')}`)).data.count, 1);
  assert.equal((await f.req('/sales-lines?billing=billed')).data.count, 0);
  assert.equal((await f.req('/sales-lines?from=2026-13')).status, 400);
  const production = await f.login('production@openingnight.invalid');
  assert.equal((await f.req('/sales-lines', null, production)).status, 403);
  const outsider = await f.login('outsider@other.invalid');
  assert.equal((await f.req('/sales-lines', null, outsider)).data.count, 0);
});

test('filtering by work counts only that work\'s allocated share of a product shared between works', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const cookie = (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})})).headers.get('set-cookie').split(';')[0];
  const req = async (path, body) => {
    const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const project = await db.get("SELECT project_id FROM works WHERE id=1");
  await db.run("INSERT INTO works(org_id,project_id,code,title,format) VALUES(1,?,'WRK-SHARE','架空の第二作品','film')", [project.project_id]);
  const second = (await db.get("SELECT id FROM works WHERE code='WRK-SHARE'")).id;
  await db.run('DELETE FROM product_works WHERE org_id=1 AND product_id=1');
  await db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,1,1,6000),(1,1,?,4000)', [second]);
  const sale = await req('/sales', {workId: 1, report_key: 'SHARE-1', kind: 'digital', partner_id: 2, product_id: 1, period_from: '2026-06-01', period_to: '2026-06-30', sales_month: '2026-06',
    recognition_basis_id: 1, basis_reason: '架空の根拠', description: '架空売上', quantity: 1, amount_ex_tax: 320001, tax_amount: 32000, amount_inc_tax: 352001});
  assert.ok(sale.status < 300, JSON.stringify(sale.data));
  const first = (await req('/sales-lines?from=2026-06&to=2026-06&workId=1')).data;
  const other = (await req(`/sales-lines?from=2026-06&to=2026-06&workId=${second}`)).data;
  const all = (await req('/sales-lines?from=2026-06&to=2026-06')).data;
  assert.equal(all.totals.amount_ex_tax, 320001, 'company-wide list keeps the full amount');
  assert.equal(first.totals.amount_ex_tax + other.totals.amount_ex_tax, 320001, 'the two works add up to the line, not twice the line');
  assert.equal(first.totals.amount_ex_tax, 192001);
  assert.equal(first.rows[0].allocation_bps, 6000);
  assert.equal(first.rows[0].original_amount_ex_tax, 320001);
  assert.match(first.scope, /配賦分/);
});

test('FR-REV-ROLL-009 the annual report rows open the sales list with matching counts for the product, distribution and deal axes', async (t) => {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  const {seedReportDemo} = await import('../scripts/seed-report-demo.mjs');
  await seedReportDemo(db);
  const cookie = (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})})).headers.get('set-cookie').split(';')[0];
  const get = async (path) => (await app.request(`/api${path}`, {headers: {cookie}})).json();
  const period = 'from=2025-05&to=2027-04';
  const checks = {product: 'productId', distribution: 'distribution', deal: 'deal'};
  for (const [axis, param] of Object.entries(checks)) {
    const annual = await get(`/reports/annual-sales?${period}&axis=${axis}`);
    assert.ok(annual.rows.length > 0, axis);
    for (const row of annual.rows) {
      const drill = await get(`/reports/annual-sales/lines?${period}&axis=${axis}&key=${encodeURIComponent(row.key)}&limit=2000`);
      const list = await get(`/sales-lines?${period}&${param}=${encodeURIComponent(String(row.keys[0]))}`);
      assert.equal(list.count, drill.count, `${axis} ${row.label}: the sales list has as many lines as the report row`);
    }
  }
});
