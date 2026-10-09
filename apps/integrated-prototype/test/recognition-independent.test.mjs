import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignKeyViolations, openTestDb } from './test-db.mjs';
import { createApp } from '../src/app.mjs';
import { toCsv } from '../src/csv.mjs';

test('FR-REV-INTAKE-026 independent recognition months preserve source periods, legacy data and rejection boundaries', async (t) => {
  const db = await openTestDb({t});
  try {
    const app = createApp({db});
    const login = await app.request('/api/local/login', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'admin@openingnight.invalid'})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    async function request(path, body) {
      const r = await app.request('/api'+path, {method:body?'POST':'GET', headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
      return {status:r.status,data:await r.json()};
    }
    function good(r) { assert.ok(r.status<300 && r.data.ok,JSON.stringify(r)); return r.data; }
    let seq = 0;
    const row = extra => ({workId:1,kind:'digital',report_key:`RECOGNITION-INDEPENDENT-${++seq}`,partner_id:2,period_from:'2026-09-01',period_to:'2026-09-30',description:'架空の月基準比較',quantity:1,amount_ex_tax:100,tax_amount:10,amount_inc_tax:110,...extra});
    const legacy = row({accounting_month:'2026-12'});
    good(await request('/sales', legacy));
    const before = JSON.stringify(await db.all('SELECT * FROM sale_lines ORDER BY id'));
    const evidence = {sales_month:'2026-09',report_received_on:'2026-10-01',contract_start_on:'2026-07-31',license_start_on:'2026-08-01',broadcast_on:'2026-09-30',basis_reason:'架空の契約条件による管理用試算'};
    const cases = [[1,'2026-09'],[2,'2026-10'],[3,'2026-07'],[4,'2026-08'],[5,'2026-09']];
    for (const [basis,expected] of cases) {
      const input = row({...evidence,recognition_basis_id:basis});
      good(await request('/sales',input));
      const reports = good(await request('/reports?workId=1')).rows;
      const report = reports.find(r=>r.report_key===input.report_key);
      assert.equal(report.accounting_month,expected);
      assert.equal(report.recognition_basis_id,basis);
      assert.equal(report.report_received_on,'2026-10-01');
      assert.equal(report.contract_start_on,'2026-07-31');
      assert.equal(report.license_start_on,'2026-08-01');
      assert.equal(report.broadcast_on,'2026-09-30');
      assert.equal(report.sales_month,'2026-09');
      assert.equal(report.accounting_status,'unverified');
      const line = good(await request('/sales?workId=1')).rows.find(r=>r.report_id===report.id);
      assert.equal(line.accounting_month,expected);
      assert.equal(line.sales_period_from,'2026-09-01');
      assert.equal(line.sales_period_to,'2026-09-30');
      assert.equal(line.recognition_basis_id,basis);
    }
    assert.equal(JSON.stringify(await db.all('SELECT * FROM sale_lines WHERE id=1')),before);
    const legacyReport = good(await request('/reports?workId=1')).rows.find(r=>r.report_key===legacy.report_key);
    assert.equal(legacyReport.recognition_basis_id,null);
    assert.equal(legacyReport.accounting_month,'2026-12');

    const csvRow = row({...evidence,recognition_basis_id:2});
    const headers = Object.keys(csvRow).filter(k=>!['workId','kind'].includes(k));
    const csv = toCsv(headers,[headers.map(k=>csvRow[k])]);
    const preview = good(await request('/imports/preview',{workId:1,kind:'digital',text:csv}));
    assert.equal(preview.rows[0].data.accounting_month,'2026-10');
    good(await request('/imports/commit',{token:preview.token}));
    const monthly = good(await request('/analytics/income?workId=1')).monthly;
    assert.equal(monthly.find(r=>r.month==='2026-07').revenue,100);
    assert.equal(monthly.find(r=>r.month==='2026-08').revenue,100);
    assert.equal(monthly.find(r=>r.month==='2026-09').revenue,200);
    assert.equal(monthly.find(r=>r.month==='2026-10').revenue,200);
    assert.equal(monthly.find(r=>r.month==='2026-12').revenue,100);

    const invalid = [
      {recognition_basis_id:1,basis_reason:'missing'},
      {recognition_basis_id:2,basis_reason:'missing'},
      {recognition_basis_id:3,basis_reason:'missing'},
      {recognition_basis_id:4,basis_reason:'missing'},
      {recognition_basis_id:5,basis_reason:'missing'},
      {...evidence,recognition_basis_id:2,accounting_month:'2026-09'},
      {...evidence,recognition_basis_id:2,report_received_on:'2026-02-30'},
      {...evidence,recognition_basis_id:3,contract_start_on:'2026-13-01'},
      {...evidence,recognition_basis_id:4,license_start_on:'2026-02-30'},
      {...evidence,recognition_basis_id:5,broadcast_on:'2026-09-31'},
      {...evidence,recognition_basis_id:1,sales_month:'2026-13'},
      {...evidence,recognition_basis_id:1,sales_month:'2026-08'},
      {...evidence,recognition_basis_id:1,period_from:'2026-08-01'},
      {...evidence,recognition_basis_id:6},
      {...evidence,recognition_basis_id:''},
      {...evidence,recognition_basis_id:2,basis_reason:''},
      {accounting_month:'2026-09',report_received_on:'2026-10-01'},
      {accounting_month:'2026-09',contract_signed_on:'2026-09-01'},
      {...evidence,recognition_basis_id:3,contract_signed_on:'2026-09-01'},
    ];
    const countBefore = (await db.get('SELECT COUNT(*) AS n FROM sale_lines')).n;
    for (const extra of invalid) {
      const out = await request('/sales',row(extra));
      assert.equal(out.data.ok,false,JSON.stringify({extra,out}));
    }
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM sale_lines')).n,countBefore);
    assert.deepEqual(await foreignKeyViolations(db),[]);
  } finally { await db.close(); }
});
