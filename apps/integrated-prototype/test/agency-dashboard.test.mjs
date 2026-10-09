import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './test-db.mjs';
import { createApp } from '../src/app.mjs';

test('monthly source data preserves returns, cost-only months, work and accounting-period boundaries', async (t) => {
  const db = await openTestDb({ t });
  try {
    const app = createApp({ db });
    const login = await app.request('/api/local/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email:'admin@openingnight.invalid'}) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    // Independently chosen expected values; sales period deliberately differs from accounting month.
    for (const [m, amount] of [['2026-07',10000],['2026-07',-2000],['2026-08',-3000]]) {
      await db.run(`INSERT INTO sale_lines(org_id,project_id,work_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax) VALUES(1,1,1,1,'2026-06-01','2026-06-30',?,'架空検証',?,0,?)`,[m,amount,amount]);
    }
    for(const [m, amount] of [['2026-07',1000],['2026-09',4000]]) await db.run(`INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,1,'2026-06-01',?,'検証','架空検証',?,0,?)`,[m,amount,amount]);
    await db.run(`INSERT INTO expenses(org_id,project_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax) VALUES(1,1,'2026-06-01','2026-07','未配賦','作品へ未配賦',9000,0,9000)`);
    const get = async suffix => { const r=await app.request('/api/analytics/income?workId=1'+suffix,{headers:{cookie}});assert.equal(r.status,200);return r.json();};
    const all=await get('');
    assert.deepEqual(all.monthly,[{month:'2026-07',revenue:8000,cost:1000,profit:7000},{month:'2026-08',revenue:-3000,cost:0,profit:-3000},{month:'2026-09',revenue:0,cost:4000,profit:-4000}]);
    assert.equal(all.sales.exTax,5000);assert.equal(all.expenses.exTax,5000);assert.equal(all.profitExTax,0);
    assert.equal(all.unallocatedProjectExpenses.length,1);
    const july=await get('&month=2026-07');assert.equal(july.allocatedLines.length,2);assert.equal(july.allocatedLines.reduce((sum,r)=>sum+r.amount_ex_tax,0),8000);
    const empty=await get('&month=2025-01');assert.deepEqual(empty.monthly,[]);assert.deepEqual(empty.allocatedLines,[]);
  } finally { await db.close(); }
});
