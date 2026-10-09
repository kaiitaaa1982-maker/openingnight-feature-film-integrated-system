// royalty-review-fixes.test.mjs と royalty-review-fixes-sqlite.test.mjs（F10）が共有する組み立て（架空の権利者・契約・売上）。
// ロイヤリティのレビュー指摘（2026-09-25）の回帰試験で使う。DB は試験の DB のファクトリ（test-db.mjs）で開く。kind は試験の DB の種類（既定は ON_TEST_DB）
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';

export async function fixture({t, kind} = {}) {
  const db = await openTestDb({t, kind});
  const app = createApp({db, mode: 'local'});
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const req = async (path, payload, cookie = admin) => {
    const response = await app.request(`/api${path}`, {method: payload ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: payload ? JSON.stringify(payload) : undefined});
    return {status: response.status, data: await response.json()};
  };
  const ok = (r) => { assert.ok(r.status < 300 && r.data.ok !== false, JSON.stringify(r.data)); return r.data; };
  let n = 0;
  const sale = async (month, amount, {kind = 'digital', workId = 1, product = 1} = {}) => {
    n += 1;
    return ok(await req('/sales', {workId, report_key: `RF-${n}`, kind, description: `架空売上 ${n}`, quantity: 1, basis_reason: '架空の根拠', recognition_basis_id: 1,
      partner_id: 2, product_id: product, period_from: `${month}-01`, period_to: `${month}-28`, sales_month: month, amount_ex_tax: amount, tax_amount: amount / 10, amount_inc_tax: amount + amount / 10}));
  };
  await db.run("INSERT INTO partners(id,org_id,code,name,kind) VALUES(10,1,'PT-DIR','架空監督A','other'),(11,1,'PT-MUS','架空音楽出版','other'),(12,1,'PT-SCR','架空脚本家B','other')");
  const phase = (extra = {}) => ({startsMonth: '2025-01', cycleKind: 'quarterly', anchorMonth: 3, reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom', ...extra});
  const term = (extra = {}) => ({effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1000, clauseReference: '第8条', ...extra});
  const create = async (overrides = {}) => ok(await req('/royalty/agreements', {workId: 1, holderPartnerId: 10, category: 'director', agreementCode: 'RF-DIR-1', title: '架空の監督料契約',
    documentReference: '架空の契約書', term: term(), schedule: {phases: [phase()]}, ...overrides}));
  const addWork = async (id, title) => {
    await db.run('INSERT INTO works(id,org_id,project_id,code,title) VALUES(?,1,1,?,?)', [id, `WRK-RF${id}`, title]);
    await db.run('INSERT INTO products(id,org_id,sku,name,channel) VALUES(?,1,?,?,?)', [id, `SKU-RF${id}`, `${title}の配信`, 'digital']);
    await db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,?,?,10000)', [id, id]);
  };
  return {db, app, req, ok, login, admin, sale, create, phase, term, addWork};
}
