// 作品の月別収支の受け口（GET /api/analytics/income。src/accounting/work-income/work-income-routes.mjs）と、
// その読み取り（src/accounting/accounting-store.mjs）の権限と組織の境界。openTestDb で開くので PostgreSQL でも流れる。
// 期待値の出どころ: 役割は docs/requirements/README.md の「使う人と役割」（制作担当は財務を見られない。財務を扱うのは
// 管理者と、案件への所属が edit の編集担当。別の組織の利用者は自分の組織だけ）。売上は有効な報告の明細と手入力の明細だけ
// （docs/requirements/revenue/report-intake.md。置き換え済み・取消の報告は数えない）。配賦は docs/rules/money.md の最大剰余法。
// 金額は下の架空の行から手で足した値。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {listWorkProjects, listActiveSaleLines, listProductWorkShares, listActiveExpenses} from '../src/accounting/accounting-store.mjs';

// 架空の行。組織1に案件5（作品5）と案件6（作品6）を足す。編集担当（利用者5）は案件5が edit、案件6が production
// （財務の権限は案件5だけ）。制作担当（利用者3）にも案件5の edit を付け、役割が制作担当なら所属の権限によらず止まることを見る。
// 組織2（試作の行の案件2・作品2・取引先4）にも売上・配賦・経費を置く
async function seed(db) {
  for (const sql of [
    "INSERT INTO projects(id,org_id,code,title,status) VALUES(5,1,'PRJ-WI-A','架空の収支A','active'),(6,1,'PRJ-WI-B','架空の収支B','active')",
    "INSERT INTO works(id,org_id,project_id,code,title,format) VALUES(5,1,5,'WRK-WI-A','架空の収支作品A','film'),(6,1,6,'WRK-WI-B','架空の収支作品B','film')",
    "INSERT INTO users(id,email,display_name) VALUES(5,'wi-editor@openingnight.invalid','架空の編集担当（収支）')",
    "INSERT INTO memberships(org_id,user_id,role) VALUES(1,5,'editor')",
    "INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,5,5,'edit'),(1,6,5,'production'),(1,5,3,'edit')",
    // 商品8は作品5と作品6に半分ずつ。商品9は組織2の作品2へ全部
    "INSERT INTO products(id,org_id,sku,name,channel) VALUES(8,1,'SKU-WI-SET','架空のセット','digital'),(9,2,'SKU-WI-OTHER','架空の別組織の商品','digital')",
    "INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,8,5,5000),(1,8,6,5000),(2,9,2,10000)",
  ]) await db.run(sql);
  const sale = async (org, project, work, partner, product, month, exTax, tax, reportId = null) => (await db.get(
    `INSERT INTO sale_lines(org_id,project_id,work_id,report_id,product_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax)
     VALUES(?,?,?,?,?,?,'2026-01-01','2026-01-31',?,'架空の売上',?,?,?) RETURNING id`, [org, project, work, reportId, product, partner, month, exTax, tax, exTax + tax])).id;
  const expense = async (org, project, work, month, exTax, tax) => (await db.get(
    `INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax)
     VALUES(?,?,?,'2026-01-15',?,'架空の費目','架空の経費',?,?,?) RETURNING id`, [org, project, work, month, exTax, tax, exTax + tax])).id;
  return {
    sale, expense,
    sales: {
      a: await sale(1, 5, 5, 1, null, '2026-04', 10000, 1000), // 作品5へ全額
      b: await sale(1, 5, 5, 2, 8, '2026-04', 20000, 2000), // 商品8: 作品5と作品6へ 10000 / 1000 ずつ
      c: await sale(1, 6, 6, 1, null, '2026-04', 50000, 5000), // 作品6へ全額
      other: await sale(2, 2, 2, 4, 9, '2026-04', 900, 90), // 組織2
    },
    expenses: {
      d: await expense(1, 5, 5, '2026-03', 2000, 200), // 作品5。売上の最初の月より前の、経費だけの月
      e: await expense(1, 5, null, '2026-04', 4000, 400), // 案件5の未配賦
      f: await expense(1, 6, 6, '2026-04', 6000, 600), // 作品6
      g: await expense(1, 6, null, '2026-05', 8000, 800), // 案件6の未配賦（漏れると月の行が増える）
      other: await expense(2, 2, 2, '2026-04', 300, 30), // 組織2
      otherUnallocated: await expense(2, 2, null, '2026-04', 70, 7), // 組織2の未配賦
    },
  };
}

async function setup(t) {
  const db = await openTestDb({t});
  const ids = await seed(db);
  const app = createApp({db, mode: 'local'});
  async function as(email) {
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(login.status, 200, email);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return async (query = '') => {
      const response = await app.request(`/api/analytics/income${query}`, {headers: {cookie}});
      return {status: response.status, body: await response.json()};
    };
  }
  return {db, ids, as};
}

const lineIds = (body) => body.allocatedLines.map((line) => [line.sale_id, line.allocated_work_id]);
const expenseIds = (rows) => rows.map((row) => row.id).sort((a, b) => a - b);

test('制作担当は、案件の所属が edit でも収支を開けず、403「収支への権限がありません」', async (t) => {
  const {as} = await setup(t);
  const production = await as('production@openingnight.invalid');
  for (const query of ['', '?workId=5', '?workId=5&month=2026-04']) {
    assert.deepEqual(await production(query), {status: 403, body: {ok: false, error: '収支への権限がありません'}}, query);
  }
});

test('財務の権限の無い作品・別の組織の作品・無い作品を指すと、どれも403「作品への権限がありません」', async (t) => {
  const {as} = await setup(t);
  const editor = await as('wi-editor@openingnight.invalid');
  // 作品6の案件6は所属しているが production（財務の権限ではない）。作品2は組織2。作品999は無い
  for (const workId of [6, 2, 999]) {
    const result = await editor(`?workId=${workId}`);
    assert.equal(result.status, 403, `作品${workId}`);
    assert.equal(result.body.error, '作品への権限がありません', `作品${workId}`);
  }
  const outsider = await as('outsider@other.invalid');
  const result = await outsider('?workId=5');
  assert.equal(result.status, 403);
  assert.equal(result.body.error, '作品への権限がありません');
});

test('作品で絞らない編集担当には、財務の権限のある案件5の売上・経費・月別だけが出て、案件6の分（配賦した分を含む）は出ない', async (t) => {
  const {ids, as} = await setup(t);
  const {a, b} = ids.sales, {e} = ids.expenses;
  const editor = await as('wi-editor@openingnight.invalid');
  const all = await editor();
  assert.equal(all.status, 200);
  // 売上: a の 10000 と、b の 20000 のうち作品5の半分 10000。c（作品6）と b の作品6の半分は出ない
  assert.deepEqual(all.body.sales, {exTax: 20000, tax: 2000, incTax: 22000});
  assert.deepEqual(lineIds(all.body), [[a, 5], [b, 5]]);
  // 経費: 案件5の d と e（未配賦も、作品で絞らないときは足す）。案件6の f・g は出ない
  assert.deepEqual(all.body.expenses, {exTax: 6000, tax: 600, incTax: 6600, budget: 0});
  assert.deepEqual(expenseIds(all.body.unallocatedProjectExpenses), [e]);
  assert.deepEqual(all.body.monthly, [
    {month: '2026-03', revenue: 0, cost: 2000, profit: -2000},
    {month: '2026-04', revenue: 20000, cost: 4000, profit: 16000},
  ]);
  assert.equal(all.body.profitExTax, 14000);

  // 計上月で絞ると、売上も経費もその月だけ（d の 2026-03 は外れる）
  const april = await editor('?month=2026-04');
  assert.deepEqual(april.body.sales, {exTax: 20000, tax: 2000, incTax: 22000});
  assert.deepEqual(april.body.expenses, {exTax: 4000, tax: 400, incTax: 4400, budget: 0});
  assert.deepEqual(april.body.monthly, [{month: '2026-04', revenue: 20000, cost: 4000, profit: 16000}]);

  // 作品5で絞ると、経費は作品5の d だけを引き、案件5の未配賦 e は引かずに別に並べる
  const work5 = await editor('?workId=5');
  assert.deepEqual(work5.body.expenses, {exTax: 2000, tax: 200, incTax: 2200, budget: 0});
  assert.deepEqual(expenseIds(work5.body.unallocatedProjectExpenses), [e]);
  assert.equal(work5.body.profitExTax, 18000);
  assert.deepEqual(work5.body.monthly, [
    {month: '2026-03', revenue: 0, cost: 2000, profit: -2000},
    {month: '2026-04', revenue: 20000, cost: 0, profit: 20000},
  ]);

  // 同じ行を管理者は案件6の分まで見る（上の「出ない」が、行が無いからではないことの対照）
  const admin = await as('admin@openingnight.invalid');
  const everything = await admin();
  assert.deepEqual(everything.body.sales, {exTax: 80000, tax: 8000, incTax: 88000});
  assert.deepEqual(everything.body.expenses, {exTax: 20000, tax: 2000, incTax: 22000, budget: 0});
  assert.deepEqual(expenseIds(everything.body.unallocatedProjectExpenses), [e, ids.expenses.g]);
});

test('別の組織の利用者には、その組織の売上・配賦・経費だけが出て、組織1の行は出ない', async (t) => {
  const {ids, as} = await setup(t);
  const outsider = await as('outsider@other.invalid');
  const result = await outsider();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.sales, {exTax: 900, tax: 90, incTax: 990});
  assert.deepEqual(lineIds(result.body), [[ids.sales.other, 2]]);
  assert.deepEqual(result.body.expenses, {exTax: 370, tax: 37, incTax: 407, budget: 0});
  assert.deepEqual(expenseIds(result.body.unallocatedProjectExpenses), [ids.expenses.otherUnallocated]);
  assert.deepEqual(result.body.monthly, [{month: '2026-04', revenue: 900, cost: 370, profit: 530}]);
});

test('読み取りはどれも組織で絞る: 組織2を読むと組織2の作品・有効な売上明細・商品の配賦・経費だけが返る', async (t) => {
  const {db, ids} = await setup(t);
  // 受け口では見てよい案件でも絞るので、組織の条件が抜けても応答には出にくい。読み取りそのものの約束として確かめる
  assert.deepEqual((await listWorkProjects(db, 2)).map((row) => ({...row})), [{id: 2, project_id: 2}]);
  assert.deepEqual((await listActiveSaleLines(db, 2)).map((row) => row.id), [ids.sales.other]);
  assert.deepEqual((await listActiveSaleLines(db, 2, '2026-04')).map((row) => row.id), [ids.sales.other]);
  assert.deepEqual((await listProductWorkShares(db, 2)).map((row) => ({...row})), [{org_id: 2, product_id: 9, work_id: 2, allocation_bps: 10000}]);
  assert.deepEqual(expenseIds(await listActiveExpenses(db, 2)), [ids.expenses.other, ids.expenses.otherUnallocated]);
  assert.deepEqual(expenseIds(await listActiveExpenses(db, 2, '2026-04')), [ids.expenses.other, ids.expenses.otherUnallocated]);
  // 組織1を読むと組織1の行（組織2の行は入らない）
  const {a, b, c} = ids.sales, {d, e, f, g} = ids.expenses;
  assert.deepEqual((await listActiveSaleLines(db, 1)).map((row) => row.id).sort((x, y) => x - y), [a, b, c]);
  assert.deepEqual(expenseIds(await listActiveExpenses(db, 1)), [d, e, f, g]);
  assert.deepEqual(expenseIds(await listActiveExpenses(db, 1, '2026-03')), [d]);
});

test('置き換え済み・取消の報告の売上明細は数えず、有効な報告の明細と手入力の明細だけを足す', async (t) => {
  const {db, ids, as} = await setup(t);
  const report = async (key, status) => (await db.get(
    `INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,created_by,status)
     VALUES(1,5,1,?,'digital','2026-06-01','2026-06-30','2026-06','架空の報告',?,1,?) RETURNING id`, [key, `hash-${key}`, status])).id;
  const active = await report('WI-ACTIVE', 'active'), superseded = await report('WI-OLD', 'superseded'), voided = await report('WI-VOID', 'void');
  const fromActive = await ids.sale(1, 5, 5, 1, null, '2026-06', 3000, 300, active);
  await ids.sale(1, 5, 5, 1, null, '2026-06', 7000, 700, superseded);
  await ids.sale(1, 5, 5, 1, null, '2026-06', 11000, 1100, voided);
  const manual = await ids.sale(1, 5, 5, 2, null, '2026-06', 500, 50);
  const admin = await as('admin@openingnight.invalid');
  const june = await admin('?workId=5&month=2026-06');
  assert.equal(june.status, 200);
  assert.deepEqual(june.body.sales, {exTax: 3500, tax: 350, incTax: 3850});
  assert.deepEqual(lineIds(june.body).map(([id]) => id).sort((x, y) => x - y), [fromActive, manual].sort((x, y) => x - y));
  assert.deepEqual(june.body.monthly, [{month: '2026-06', revenue: 3500, cost: 0, profit: 3500}]);
  // 読み取りも同じ（計上月を渡さないときも）
  const lines = (await listActiveSaleLines(db, 1)).filter((row) => row.accounting_month === '2026-06').map((row) => row.id).sort((x, y) => x - y);
  assert.deepEqual(lines, [fromActive, manual].sort((x, y) => x - y));
});

test('計上月は YYYY-MM の 01〜12 月だけ: 2026-12 は通り、2026-13 と 2026-4 は403で計上月の形式の文言を返す', async (t) => {
  const {as} = await setup(t);
  const editor = await as('wi-editor@openingnight.invalid');
  const december = await editor('?month=2026-12');
  assert.equal(december.status, 200);
  assert.deepEqual(december.body.monthly, []);
  // 403 は app.mjs から移す前と同じ（受け口の誤りはすべて 403 で返す）
  for (const value of ['2026-13', '2026-4']) {
    const result = await editor(`?month=${value}`);
    assert.equal(result.status, 403, value);
    assert.equal(result.body.error, `計上月はYYYY-MM形式です: ${value}`, value);
  }
});
