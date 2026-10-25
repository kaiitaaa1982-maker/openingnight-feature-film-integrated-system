// 計上と入金の切り替え（フェーズ1の仕様書 #16）の受け口の試験。PL・BS（/api/reports/pl-bs）・作品別収支（/api/reports/work-pnl と文書データ）・
// 作品の月別収支（/api/analytics/income）・会社への利益額（/api/accounting/profit。#14b）が basis=accrual|cash を受け、既定は計上、ほかの値は400、
// どの応答にも基準が付く（基準の無い応答が無い）。
// 予実の4段（/api/revenue/yojitsu）は入金に固定のまま。openTestDb で開くので PostgreSQL でも流れる。
// 期待値の出どころ: 計画の「計上と入金」（売上は入金日・経費は出金日、税抜にできない入金は U-5 まで「未確定」）、FR-REV-YOJITSU-032 の仮の出し方
// （請求どおりの額の入金だけを請求明細の税抜額で税抜にする）。金額は下の架空の行から手で計算した値。
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {BASES} from '../src/reports/pl-bs-cash-model.mjs';
import {ensureExpenseDemoSettings, demoAccounting, fictionalInvoice} from '../scripts/seed-expense-support.mjs';

/// 請求・入金・経費・出金を書く道具（組織・案件・取引先・記録した人ごと）。請求は請求ごとに報告1件・売上明細1行で、
// 請求明細の作品の配賦（lineWorks）を省くと売上明細の作品へ全額。lineWorks: [] は配賦の無い請求明細（作品を決められない入金になる）。
// 報告の取込日時は固定する（データ時点の最終取込を動かさない。足したあとの応答を足す前と比べるため）
function writer(db, {org, project, partner, by, prefix}) {
  const invoice = async (key, exTax, tax, {work, product = null, lineWorks} = {}) => {
    const report = Number((await db.get(`INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,created_by,status,created_at)
      VALUES(?,?,?,?,'digital','2026-04-01','2026-04-30','2026-04','架空の報告',?,?,'active','2000-01-01 00:00:00') RETURNING id`,
    [org, work, partner, `${prefix}-${key}`, `fictional-${prefix}-${key}`, by])).id);
    const sale = Number((await db.get(`INSERT INTO sale_lines(org_id,project_id,work_id,report_id,product_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax,source_row)
      VALUES(?,?,?,?,?,?,'2026-04-01','2026-04-30','2026-04','架空の売上',?,?,?,1) RETURNING id`, [org, project, work, report, product, partner, exTax, tax, exTax + tax])).id);
    const id = Number((await db.get(`INSERT INTO billing_invoices(org_id,invoice_number,partner_id,invoice_date,due_date,source_amount_basis,amount_ex_tax,tax_amount,amount_inc_tax,snapshot_json,snapshot_hash,created_by)
      VALUES(?,?,?,'2026-04-30','2026-05-31','platform_net',?,?,?,'{}',?,?) RETURNING id`, [org, `INV-${prefix}-${key}`, partner, exTax, tax, exTax + tax, `fictional-${prefix}-invoice-${key}`, by])).id);
    await db.run(`INSERT INTO billing_invoice_lines(org_id,invoice_id,sale_id,report_id,project_id,work_id,product_id,partner_id,description,accounting_month,source_row,amount_ex_tax,tax_amount,amount_inc_tax)
      VALUES(?,?,?,?,?,?,?,?,'架空の売上','2026-04',1,?,?,?)`, [org, id, sale, report, project, work, product, partner, exTax, tax, exTax + tax]);
    for (const [workId, bps] of lineWorks ?? [[work, 10000]]) {
      await db.run('INSERT INTO billing_invoice_line_works(org_id,invoice_id,sale_id,work_id,allocation_bps) VALUES(?,?,?,?,?)', [org, id, sale, workId, bps]);
    }
    return id;
  };
  const receipt = async (key, invoiceId, receivedOn, amount) => {
    const id = Number((await db.get('INSERT INTO billing_receipts(org_id,partner_id,reference,received_on,amount_yen,allocation_count,created_by) VALUES(?,?,?,?,?,1,?) RETURNING id',
      [org, partner, `RCPT-${prefix}-${key}`, receivedOn, amount, by])).id);
    await db.run('INSERT INTO billing_receipt_allocations(org_id,receipt_id,invoice_id,amount_yen) VALUES(?,?,?,?)', [org, id, invoiceId, amount]);
  };
  const expense = async (exTax, tax, work) => Number((await db.get(`INSERT INTO expenses(org_id,project_id,work_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax)
    VALUES(?,?,?,'2026-04-15','2026-04','架空の費目','架空の経費',?,?,?) RETURNING id`, [org, project, work, exTax, tax, exTax + tax])).id);
  const pay = (expenseId, paidOn, amount) => db.run("INSERT INTO expense_payments(org_id,expense_id,paid_on,amount_yen,method,created_by) VALUES(?,?,?,?,'transfer',?)", [org, expenseId, paidOn, amount, by]);
  return {invoice, receipt, expense, pay};
}

const userId = async (db, email) => Number((await db.get('SELECT id FROM users WHERE email=?', [email])).id);

// 組織1に案件41（作品41・作品42）を足す。作品41に 2026-04 計上の売上2行（請求1・請求2）と経費2行。
// 請求1（税込11,000）は 2026-05-10 に請求どおり入金（税抜 10,000 で確定）。請求2（税込22,000）は 2026-06-05 に源泉を引かれた 19,958 が入金（未確定）。
// 経費1（税込5,500）は 2026-05-20 に全額を出金（税抜 5,000 で確定）、経費2（税込8,800）は 2026-06-20 に 4,000 だけ出金（分割。未確定）。
// 案件41の未配賦の経費（税込3,300）は 2026-06-25 に 1,000 だけ出金（作品に付かない未確定）。
// 編集担当（basis-editor）は案件41だけに edit（組織のほかの案件には権限が無いので、会社PLは見られない）
async function seed(db) {
  const admin = await userId(db, 'admin@openingnight.invalid');
  for (const sql of [
    "INSERT INTO projects(id,org_id,code,title,status) VALUES(41,1,'PRJ-BASIS','架空の基準の案件','active')",
    "INSERT INTO works(id,org_id,project_id,code,title,format) VALUES(41,1,41,'WRK-BASIS-A','架空の基準の作品A','film'),(42,1,41,'WRK-BASIS-B','架空の基準の作品B','film')",
  ]) await db.run(sql);
  const partner = Number((await db.get("INSERT INTO partners(org_id,code,name,kind) VALUES(1,'PT-BASIS','架空の取引先（基準）','other') RETURNING id")).id);
  const editor = Number((await db.get("INSERT INTO users(email,display_name) VALUES('basis-editor@openingnight.invalid','架空の編集担当（基準）') RETURNING id")).id);
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,?,'editor')", [editor]);
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,41,?,'edit')", [editor]);
  const {invoice, receipt, expense, pay} = writer(db, {org: 1, project: 41, partner, by: admin, prefix: 'BASIS'});
  await receipt('1', await invoice('1', 10000, 1000, {work: 41}), '2026-05-10', 11000);
  await receipt('2', await invoice('2', 20000, 2000, {work: 41}), '2026-06-05', 19958);
  await pay(await expense(5000, 500, 41), '2026-05-20', 5500);
  await pay(await expense(8000, 800, 41), '2026-06-20', 4000);
  await pay(await expense(3000, 300, null), '2026-06-25', 1000); // 案件41の未配賦の経費（作品に付かない。分割で未確定）
}

// 組織2（別組織。種の案件2・作品2・取引先4・別組織担当）の請求・入金・出金。金額はどれも組織1の種に無い値。
// 請求O1（税込77,000）は 2026-05-12 に請求どおり入金。請求O2（税込33,000）は請求明細に作品の配賦が無く、2026-05-14 に全額入金（作品を決められない入金。
// 組織で絞らずに読むと、組織1の会社PLの「作品に付かない未確定」に混ざる）。作品2の経費（税込6,600）は 2026-05-21 に全額、
// 経費（税込7,700）は 2026-06-22 に 2,345 だけ、案件2の未配賦の経費（税込4,400）は 2026-06-23 に 1,234 だけ出金
async function seedOtherOrg(db) {
  const {invoice, receipt, expense, pay} = writer(db, {org: 2, project: 2, partner: 4, by: await userId(db, 'outsider@other.invalid'), prefix: 'OTHER'});
  await receipt('1', await invoice('1', 70000, 7000, {work: 2}), '2026-05-12', 77000);
  await receipt('2', await invoice('2', 30000, 3000, {work: 2, lineWorks: []}), '2026-05-14', 33000);
  await pay(await expense(6000, 600, 2), '2026-05-21', 6600);
  await pay(await expense(7000, 700, 2), '2026-06-22', 2345);
  await pay(await expense(4000, 400, null), '2026-06-23', 1234);
}

// 組織1の別案件42（作品43・作品44。編集担当に権限が無い）の請求・入金・出金。金額はどれも案件41の種に無い値。
// 請求P1（税込44,000）は 2026-05-15 に請求どおり入金（作品43の税抜 40,000 で確定）。請求P2（税込55,000）は 2026-06-08 に 45,678 が入金（未確定）。
// 請求P3（商品の配賦が作品43に60%・作品44に40%で、請求明細の配賦は作品43の60%だけ）は 2026-06-09 に 12,121 が入金（作品を決められない入金）。
// 作品43の経費（税込9,900）は 2026-05-25 に全額、経費（税込6,600）は 2026-06-26 に 2,222 だけ、案件42の未配賦の経費（税込2,200）は 2026-06-27 に 777 だけ出金
async function seedOtherProject(db) {
  for (const sql of [
    "INSERT INTO projects(id,org_id,code,title,status) VALUES(42,1,'PRJ-BASIS-OTHER','架空の基準の別案件','active')",
    "INSERT INTO works(id,org_id,project_id,code,title,format) VALUES(43,1,42,'WRK-BASIS-C','架空の基準の作品C','film'),(44,1,42,'WRK-BASIS-D','架空の基準の作品D','film')",
    "INSERT INTO products(id,org_id,sku,name,channel) VALUES(42,1,'SKU-BASIS-SPLIT','架空の分け合う商品','digital')",
    'INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,42,43,6000),(1,42,44,4000)',
  ]) await db.run(sql);
  const partner = Number((await db.get("INSERT INTO partners(org_id,code,name,kind) VALUES(1,'PT-BASIS-OTHER','架空の取引先（別案件）','other') RETURNING id")).id);
  const {invoice, receipt, expense, pay} = writer(db, {org: 1, project: 42, partner, by: await userId(db, 'admin@openingnight.invalid'), prefix: 'BASIS-OTHER'});
  await receipt('1', await invoice('1', 40000, 4000, {work: 43}), '2026-05-15', 44000);
  await receipt('2', await invoice('2', 50000, 5000, {work: 43}), '2026-06-08', 45678);
  await receipt('3', await invoice('3', 20000, 2000, {work: 43, product: 42, lineWorks: [[43, 6000]]}), '2026-06-09', 12121);
  await pay(await expense(9000, 900, 43), '2026-05-25', 9900);
  await pay(await expense(6000, 600, 43), '2026-06-26', 2222);
  await pay(await expense(2000, 200, null), '2026-06-27', 777);
}

// 案件41に、会社への利益額（#14b）の受け口の SQL が取消・源泉を読む経路の行を足す。金額はどれも上の種に無い値。
// (a) 取り消した報告（status 'void'）の売上明細（作品41・2026-04 計上・税抜 7,000）。
// (b)(c) 費目「事務費」（費用区分「作品のその他の経費」の科目。確定の「案件の経費」）の経費（税抜 2,000・税込 2,200・2026-04 計上）を 2026-05-12 に全額出金し、
//   2026-06-03 に出金を取り消してから 2026-06-10 に経費を取り消す。
// (d) 同じ費目の経費（税抜 10,000・税込 11,000・源泉 1,021・2026-04 計上）を 2026-05-25 に源泉を引いた 9,979 で出金する（出金＋源泉の控除＝税込）。
// (e) 同じ費目の未払の経費（税抜 3,000・税込 3,300・2026-04 計上）を 2026-07-15 に取り消す（取消日の月だけが期間に入る経費）。
// 経費と出金・取消は経費の受け口（POST /api/expenses・/api/expense-payments・取消）で入れる（費用区分・会計の版・源泉の確認の行がそろう）
async function seedProfitHistory(db) {
  const admin = await userId(db, 'admin@openingnight.invalid');
  const partner = Number((await db.get("SELECT id FROM partners WHERE org_id=1 AND code='PT-BASIS'")).id);
  const report = Number((await db.get(`INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,created_by,status,created_at)
    VALUES(1,41,?,'BASIS-VOID','digital','2026-04-01','2026-04-30','2026-04','架空の取り消した報告','fictional-basis-void',?,'void','2000-01-01 00:00:00') RETURNING id`, [partner, admin])).id);
  await db.run(`INSERT INTO sale_lines(org_id,project_id,work_id,report_id,product_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax,source_row)
    VALUES(1,41,41,?,NULL,?,'2026-04-01','2026-04-30','2026-04','架空の取り消した売上',7000,700,7700,1)`, [report, partner]);
  const post = await signInPoster(db, 'admin@openingnight.invalid');
  const settings = await ensureExpenseDemoSettings(db, 1, post);
  const reason = '架空の利益額の確かめ';
  const expense = async (key, exTax, tax, withholding = 0) => (await post('/expenses', {project_id: 41, work_id: 41, partner_id: settings.payee, incurred_on: '2026-04-20',
    accounting_month: '2026-04', category: '事務費', description: '架空の利益額の経費', actual_ex_tax: exTax, tax_amount: tax, actual_inc_tax: exTax + tax, reason,
    invoice: fictionalInvoice(`BASIS-PROFIT-${key}`, '2026-04-20'), accounting: demoAccounting(settings, '事務費', tax, withholding)})).id;
  const pay = async (expenseId, paidOn, amountYen, withheldYen) => (await post('/expense-payments', {expenseId, paidOn, amountYen, withheldYen,
    cashAccountClassVersionId: settings.classes['1100'], method: 'transfer', expectedVersion: 1, reason})).id;
  const voided = await expense('VOID', 2000, 200);
  const payment = await pay(voided, '2026-05-12', 2200, 0);
  await post(`/expense-payments/${payment}/reverse`, {reversedOn: '2026-06-03', expectedVersion: 1, reason: '架空の出金の取消'});
  await post(`/expenses/${voided}/void`, {voided_on: '2026-06-10', expectedVersion: 1, reason: '架空の経費の取消'});
  await pay(await expense('WITHHELD', 10000, 1000, 1021), '2026-05-25', 9979, 1021);
  await post(`/expenses/${await expense('UNPAID', 3000, 300)}/void`, {voided_on: '2026-07-15', expectedVersion: 1, reason: '架空の未払の経費の取消'});
}

async function setup(t) {
  const db = await openTestDb({t});
  await seed(db);
  return {db, admin: await signIn(db, 'admin@openingnight.invalid'), editor: await signIn(db, 'basis-editor@openingnight.invalid')};
}

// 利用者でログインし、その人として受け口を読む関数を返す
async function signIn(db, email) {
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(login.status, 200, email);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return async (path) => {
    const response = await app.request(`/api${path}`, {headers: {cookie}});
    return {status: response.status, body: await response.json()};
  };
}

// 利用者でログインし、その人として書き込みの受け口を呼ぶ関数を返す（201 でなければ落とす）
async function signInPoster(db, email) {
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(login.status, 200, email);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return async (path, payload) => {
    const response = await app.request(`/api${path}`, {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(payload)});
    const body = await response.json();
    assert.equal(response.status, 201, `${path}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  };
}

const withBasis = (path, basis) => (basis === undefined ? path : `${path}&basis=${basis}`);
// 基準を切り替える受け口と、応答の中で基準を持つべき所（応答そのものと文書データ）
const SWITCHED = [
  {path: '/reports/pl-bs?from=2026-04&to=2026-06', carriers: (body) => [body, {basis: body.conditions.basis, basisLabel: body.basisLabel}]},
  {path: '/reports/work-pnl?workId=41&from=2026-04&to=2026-06', carriers: (body) => [body, body.document, {basis: body.conditions.basis, basisLabel: body.basisLabel}]},
  {path: '/analytics/income?workId=41', carriers: (body) => [body]},
  {path: '/accounting/profit?from=2026-04&to=2026-06', carriers: (body) => [body]},
];

test('基準の無い応答が無い: PL・作品別収支・作品の月別収支は基準を省くと計上、cash で入金を返し、応答と文書データのどれにも基準が付く', async (t) => {
  const {admin} = await setup(t);
  for (const {path, carriers} of SWITCHED) {
    for (const [asked, expected] of [[undefined, 'accrual'], ['accrual', 'accrual'], ['cash', 'cash']]) {
      const response = await admin(withBasis(path, asked));
      assert.equal(response.status, 200, `${path} ${asked}: ${JSON.stringify(response.body).slice(0, 300)}`);
      for (const carrier of carriers(response.body)) {
        assert.ok(BASES.includes(carrier.basis), `${path} ${asked} の応答に基準が無い`);
        assert.equal(carrier.basis, expected, path);
        assert.equal(carrier.basisLabel ?? response.body.basisLabel, expected === 'cash' ? '入金' : '計上', path);
      }
    }
  }
  const document = (await admin(withBasis(SWITCHED[1].path, 'cash'))).body.document;
  assert.equal(document.conditions.find((row) => row.key === 'basis').value, '入金（入金日・出金日の月・税抜）');
  // 予実の4段は入金に固定（基準を受けず、cash 以外は400）
  const yojitsu = await admin('/revenue/yojitsu');
  assert.equal(yojitsu.status, 200, JSON.stringify(yojitsu.body).slice(0, 300));
  assert.equal(yojitsu.body.basis, 'cash');
  assert.equal(yojitsu.body.basisLabel, '入金ベース固定');
  assert.equal((await admin('/revenue/yojitsu?basis=accrual')).status, 400);
});

test('基準に accrual・cash 以外を渡すと、どの受け口も400で basis の項目を返し、計上で埋めない', async (t) => {
  const {admin} = await setup(t);
  for (const {path} of SWITCHED) {
    for (const bad of ['accounting', 'CASH', 'sales']) {
      const response = await admin(withBasis(path, bad));
      assert.equal(response.status, 400, `${path} ${bad}`);
      assert.equal(response.body.ok, false);
      assert.match(response.body.error, /accrual（計上）か cash（入金）/);
      assert.equal(response.body.details.field, 'basis');
    }
  }
});

test('作品別収支の入金ベース: 売上は請求どおりの入金の税抜を入金日の月、経費は払い切った出金の税抜を出金日の月に並べ、源泉・分割は未確定（税込）', async (t) => {
  const {admin} = await setup(t);
  const accrual = (await admin('/reports/work-pnl?workId=41&from=2026-04&to=2026-06')).body;
  assert.deepEqual(accrual.monthly.map((m) => [m.month, m.sales, m.expense]), [['2026-04', 30000, 13000], ['2026-05', 0, 0], ['2026-06', 0, 0]]);
  const cash = (await admin('/reports/work-pnl?workId=41&from=2026-04&to=2026-06&basis=cash')).body;
  assert.deepEqual(cash.monthly.map((m) => [m.month, m.sales, m.expense]), [['2026-04', 0, 0], ['2026-05', 10000, 5000], ['2026-06', 0, 0]]);
  assert.deepEqual(cash.totals, {sales: 10000, expense: 5000, balance: 5000});
  assert.deepEqual(cash.unsettled.map((row) => [row.kind, row.on, row.amount, row.reason]), [
    ['receipt', '2026-06-05', 19958, 'receipt_amount_differs'], ['expense', '2026-06-20', 4000, 'expense_amount_differs'], ['unallocated', '2026-06-25', 1000, 'expense_amount_differs'],
  ]);
  const summary = Object.fromEntries(cash.document.tables.find((table) => table.name === 'summary').rows.map((row) => [row.code, row.amount]));
  assert.equal(summary.sales, 10000);
  assert.equal(summary.unsettledIn, 19958);
  assert.equal(summary.unsettledOut, 4000, '未配賦の経費の未確定は作品の未確定の出金に入れない');
  assert.ok(cash.document.checks.every((check) => check.ok), JSON.stringify(cash.document.checks.filter((check) => !check.ok)));
  assert.ok(cash.document.notes.some((note) => note.code === 'unsettled' && note.text.includes('U-5')));
  assert.notEqual(cash.document.sourceHash, accrual.document.sourceHash, '基準が違えば hash の元が違う');
});

test('作品の月別収支の入金ベース: 入金日・出金日の月に税抜で並べ、未確定（税込）は差引に入れずに別に返す', async (t) => {
  const {admin} = await setup(t);
  const accrual = (await admin('/analytics/income?workId=41')).body;
  assert.deepEqual(accrual.monthly, [{month: '2026-04', revenue: 30000, cost: 13000, profit: 17000}]);
  const cash = (await admin('/analytics/income?workId=41&basis=cash')).body;
  assert.deepEqual(cash.monthly, [{month: '2026-05', revenue: 10000, cost: 5000, profit: 5000}]);
  assert.equal(cash.profitExTax, 5000);
  assert.equal(cash.sales.tax, null, '入金ベースの税額は出さない（0で埋めない）');
  assert.deepEqual([cash.unsettled.inflowYen, cash.unsettled.outflowYen], [19958, 4000]);
  const june = (await admin('/analytics/income?workId=41&basis=cash&month=2026-06')).body;
  assert.deepEqual(june.monthly, []);
  assert.deepEqual(june.unsettled.rows.map((row) => [row.direction, row.amount]), [['in', 19958], ['out', 4000]]);
});

test('PL の入金ベース: 作品41の利益は入金と出金の税抜の差で、会社全体を見られない編集担当には会社PLと作品に付かない未確定を返さない', async (t) => {
  const {admin, editor} = await setup(t);
  const accrual = (await admin('/reports/pl-bs?from=2026-04&to=2026-06')).body;
  const cash = (await admin('/reports/pl-bs?from=2026-04&to=2026-06&basis=cash')).body;
  const row = (body) => body.workPl.find((w) => w.workId === 41);
  assert.equal(row(accrual).period.profit, 17000);
  assert.equal(row(cash).period.profit, 5000);
  assert.deepEqual(row(cash).unsettled, {inflow: {period: 19958, cumulative: 19958}, outflow: {period: 4000, cumulative: 4000}});
  assert.deepEqual(cash.unsettled.rows.filter((r) => r.workId === null).map((r) => [r.kind, r.amount]), [['expense', 1000]], '会社全体を見る人には作品に付かない未確定を返す');
  const companyRow = (key) => cash.companyPl.rows.find((r) => r.key === key).values;
  assert.deepEqual([companyRow('unsettled:in')['m:2026-06'], companyRow('unsettled:out')['m:2026-06'], companyRow('unsettled:out').period], [19958, 5000, 5000]);
  assert.equal(cash.companyPl.rows.find((r) => r.key === 'netIncome').values.period, 5000, '未確定は利益に入れない（作品41の 10,000−5,000）');
  assert.deepEqual(cash.companyBs, accrual.companyBs, 'BS は基準によらない');
  const partial = (await editor('/reports/pl-bs?from=2026-04&to=2026-06&basis=cash')).body;
  assert.equal(partial.basis, 'cash');
  assert.equal(partial.companyPl, null);
  assert.deepEqual(partial.workPl.map((w) => w.workId).sort(), [41, 42]);
  assert.deepEqual(partial.unsettled.rows.map((r) => [r.workId, r.kind, r.amount]), [[41, 'receipt', 19958], [41, 'expense', 4000]]);
});

// 応答から作った時刻（dataAsOf.generatedAt）を外す。ほかの値は読むたびに同じ
const stable = (body) => JSON.parse(JSON.stringify(body, (key, value) => (key === 'generatedAt' ? undefined : value)));

// 入金側の読み取り（pl-bs-data.mjs の loadCashSide）は組織の全件を読み、見てよい作品・案件は呼び出し側が絞る。その境界の試験。
// 壊れたら: loadCashSide の消込の SQL から org_id の絞りを外すと、組織2の作品を決められない入金（33,000）が組織1の会社PLの未確定に混ざって1つ目の比較で落ちる。
// buildWorkIncomeCash の inScope を常に真にすると、案件42の確定した入金（40,000）と未確定の入金（45,678）が編集担当の作品の月別収支に混ざって落ちる。
// 作品別収支・作品の月別収支の作品の絞り（part.workId === workId・workFilter）を外すと、作品41の応答に作品43の入出金が混ざって落ちる
test('入金ベースの境界: 別組織の請求・入金・出金は組織1の応答を変えず、権限の無い案件42の入出金は編集担当に出ない（作品43の作品別収支・月別収支は403）', async (t) => {
  const {db, admin, editor} = await setup(t);
  const adminPaths = ['/reports/pl-bs?from=2026-04&to=2026-06&basis=cash', '/reports/work-pnl?workId=41&from=2026-04&to=2026-06&basis=cash',
    '/analytics/income?basis=cash', '/analytics/income?workId=41&basis=cash'];
  const editorPaths = ['/analytics/income?basis=cash', '/reports/pl-bs?from=2026-04&to=2026-06&basis=cash'];
  const read = async (who, paths) => {
    const out = {};
    for (const path of paths) {
      const response = await who(path);
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body).slice(0, 300)}`);
      out[path] = stable(response.body);
    }
    return out;
  };
  const adminBefore = await read(admin, adminPaths);
  const editorBefore = await read(editor, editorPaths);

  // (a) 組織2の請求・消込・出金。組織2の担当には見えていて（種が効いている）、組織1の管理者の応答は足す前と同じ
  await seedOtherOrg(db);
  const outsider = await signIn(db, 'outsider@other.invalid');
  const otherIncome = (await outsider('/analytics/income?basis=cash')).body;
  assert.deepEqual(otherIncome.monthly, [{month: '2026-05', revenue: 70000, cost: 6000, profit: 64000}], '組織2の担当には組織2の入金・出金が出る');
  const otherPl = (await outsider('/reports/pl-bs?from=2026-04&to=2026-06&basis=cash')).body;
  assert.ok(otherPl.unsettled.rows.some((row) => row.workId === null && row.kind === 'receipt' && row.amount === 33000), '組織2の作品を決められない入金は組織2の会社PLの未確定に出る');
  assert.deepEqual(await read(admin, adminPaths), adminBefore, '別組織の入金・出金は組織1の PL・作品別収支・作品の月別収支を変えない');

  // (b) 組織1の別案件42。管理者には見えていて（種が効いている）、編集担当（案件41だけ）の応答は足す前と同じ
  await seedOtherProject(db);
  const work43 = (await admin('/analytics/income?workId=43&basis=cash')).body;
  assert.deepEqual(work43.monthly, [{month: '2026-05', revenue: 40000, cost: 9000, profit: 31000}]);
  assert.deepEqual([work43.unsettled.inflowYen, work43.unsettled.outflowYen, work43.unsettled.unattachedReceiptCount], [45678, 2222, 1],
    '作品を決められない請求P3の入金（12,121）は額に入れず件数だけ');
  const work43June = (await admin('/analytics/income?workId=43&basis=cash&month=2026-06')).body;
  assert.deepEqual([work43June.monthly, work43June.unsettled.unattachedReceiptCount], [[], 1]);
  assert.deepEqual(stable((await editor('/analytics/income?basis=cash')).body), editorBefore['/analytics/income?basis=cash'], '案件42の入金・出金・未確定は編集担当の作品の月別収支に出ない');
  const editorIncome = (await editor('/analytics/income?basis=cash')).body;
  assert.deepEqual(editorIncome.monthly, [{month: '2026-05', revenue: 10000, cost: 5000, profit: 5000}]);
  assert.deepEqual(editorIncome.unsettled.rows.map((row) => [row.direction, row.workId, row.amount]), [['in', 41, 19958], ['out', 41, 4000], ['out', null, 1000]]);
  assert.deepEqual(stable((await editor('/reports/pl-bs?from=2026-04&to=2026-06&basis=cash')).body), editorBefore['/reports/pl-bs?from=2026-04&to=2026-06&basis=cash'],
    '案件42の作品は編集担当の作品別PLに出ない');
  assert.equal((await editor('/reports/work-pnl?workId=43&from=2026-04&to=2026-06&basis=cash')).status, 403);
  assert.equal((await editor('/analytics/income?workId=43&basis=cash')).status, 403);
  // 作品で絞った応答は、同じ組織のほかの作品の入出金を足しても変わらない
  const adminAfter = await read(admin, adminPaths.filter((path) => path.includes('workId=41')));
  for (const [path, body] of Object.entries(adminAfter)) assert.deepEqual(body, adminBefore[path], `${path} は作品43の入出金を含まない`);
});

// 入金ベースの作品別収支が読む売上明細（入金の行の流通・取引先などの元）。期間に入った確定の入金が指す明細だけを ID で読み、
// 組織の全期間の売上明細（計上月 0000-01〜9999-12）を読まない。壊れたら: 全期間で読むと sale_lines の問い合わせに計上月の範囲が渡って落ちる
test('入金ベースの作品別収支は、期間に入った確定の入金の売上明細だけを読み、組織の全期間の売上明細を読まない', async (t) => {
  const raw = await openTestDb({t});
  await seed(raw);
  await seedOtherProject(raw);
  const reads = [];
  const db = new Proxy(raw, {get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (prop === 'all') return (sql, params = []) => { reads.push({sql, params}); return value.call(target, sql, params); };
    return value.bind(target);
  }});
  const as = await signIn(db, 'admin@openingnight.invalid');
  const saleReads = () => reads.filter((read) => /FROM sale_lines s\b/.test(read.sql));
  const cash = await as('/reports/work-pnl?workId=41&from=2026-04&to=2026-06&basis=cash');
  assert.equal(cash.status, 200);
  const [read, ...more] = saleReads();
  assert.equal(more.length, 0, '売上明細の問い合わせは1本');
  assert.doesNotMatch(read.sql, /accounting_month BETWEEN/);
  assert.deepEqual(read.params, [1, ...cash.body.lines.map((line) => line.id)], '組織と、確定の入金（請求1）の売上明細の ID だけ');
  assert.equal(cash.body.lines.length, 1);
  assert.equal(cash.body.lines[0].report_key, 'BASIS-1', '入金の行に元の売上明細の報告キー');
  // 期間に確定の入金が無い（6月だけ）なら売上明細を読まない
  reads.length = 0;
  const june = await as('/reports/work-pnl?workId=41&from=2026-06&to=2026-06&basis=cash');
  assert.equal(june.status, 200);
  assert.deepEqual([saleReads().length, june.body.lines.length], [0, 0]);
  // 計上は従来どおり計上月の期間で読む
  reads.length = 0;
  await as('/reports/work-pnl?workId=41&from=2026-04&to=2026-06');
  assert.deepEqual(saleReads().map((r) => r.params), [[1, '2026-04', '2026-06']]);
});

// 会社への利益額（/api/accounting/profit。フェーズ1 #14b）の、golden の種に行の無い経路を DB で確かめる。案件41・42は稼ぎ方が無く売上率が決まらないので、
// 売上は率を掛ける前の額で「未確定」、費目「架空の費目」は費用区分の科目に対応していないので経費も「未確定」になり、確定は0。金額は上の種の行から手で計算した値
test('FR-ACCT-PROFIT-002 FR-ACCT-PROFIT-006 FR-ACCT-PROFIT-008 FR-ACCT-PROFIT-009 会社への利益額: 率の決まらない案件の売上・請求額と違う入金・費用区分の無い経費・違う額の出金は未確定、作品を決められない入金は会社全体を見る人だけの案件不明で、別組織と権限の無い案件の入出金は出ない', async (t) => {
  const {db, admin, editor} = await setup(t);
  const view = async (who, basis) => {
    const response = await who(`/accounting/profit?basis=${basis}`);
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
    const body = response.body;
    return {months: body.months, settled: body.settled.totals, unsettled: Object.fromEntries(body.unsettled.map((r) => [r.key, r.amounts])),
      unknown: body.unknownProject && body.unknownProject.amounts, unknownReasons: body.unknownProject && body.unknownProject.reasons.map((r) => [r.reason, r.total])};
  };
  const zero = {salesYen: 0, costYen: 0, profitYen: 0};
  // 案件41だけ: 入金 11,000（税抜 10,000）は率を掛ける前の額、源泉を引かれた 19,958 は税込、出金は税込どおりの 5,000（税抜）と違う額の 4,000・1,000
  const cash41 = {months: ['2026-04', '2026-05', '2026-06'], settled: zero,
    unsettled: {sales_no_rate: [0, 10000, 0], sales_amount_differs: [0, 0, 19958], unclassified_expense: [0, 5000, 0], expense_amount_differs: [0, 0, 5000]}};
  const accrual41 = {months: ['2026-04', '2026-05', '2026-06'], settled: zero, unsettled: {sales_no_rate: [30000, 0, 0], unclassified_expense: [16000, 0, 0]}};
  assert.deepEqual(await view(admin, 'cash'), {...cash41, unknown: [0, 0, 0], unknownReasons: []});
  assert.deepEqual(await view(admin, 'accrual'), {...accrual41, unknown: [0, 0, 0], unknownReasons: []});
  // 別組織の請求・入金・出金を足しても組織1の応答は変わらない
  await seedOtherOrg(db);
  assert.deepEqual(await view(admin, 'cash'), {...cash41, unknown: [0, 0, 0], unknownReasons: []});
  // 案件42を足すと管理者には案件42の分が足され、作品を決められない請求P3の入金（税込 12,121）は案件不明。商品の配賦（作品43・44）の売上明細は案件42へ
  await seedOtherProject(db);
  assert.deepEqual(await view(admin, 'cash'), {months: cash41.months, settled: zero,
    unsettled: {sales_no_rate: [0, 50000, 0], sales_amount_differs: [0, 0, 65636], unclassified_expense: [0, 14000, 0], expense_amount_differs: [0, 0, 7999]},
    unknown: [0, 0, 12121], unknownReasons: [['allocation_incomplete', 12121]]});
  assert.deepEqual(await view(admin, 'accrual'), {months: cash41.months, settled: zero,
    unsettled: {sales_no_rate: [140000, 0, 0], unclassified_expense: [33000, 0, 0]}, unknown: [0, 0, 0], unknownReasons: []});
  // 案件41だけに財務の権限がある編集担当には案件42の分も案件不明の行も出ない
  assert.deepEqual(await view(editor, 'cash'), {...cash41, unknown: null, unknownReasons: null});
  assert.deepEqual(await view(editor, 'accrual'), {...accrual41, unknown: null, unknownReasons: null});
  // 組織の全案件に財務の権限（edit）を持つ編集担当は会社全体を見てよい人。1案件でも欠ければ案件不明の行は出ず、全部そろうと管理者と同じ応答になる
  // （壊れたら: 会社全体を見てよい人を管理者だけにすると、全案件に edit を持つ編集担当に案件不明の行が出ずに落ちる）
  const editorId = await userId(db, 'basis-editor@openingnight.invalid');
  const others = (await db.all('SELECT id FROM projects WHERE org_id=1 AND id<>41 ORDER BY id')).map((row) => Number(row.id));
  for (const id of others.slice(0, -1)) await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,?,'edit')", [id, editorId]);
  const almost = (await editor('/accounting/profit?basis=cash')).body;
  assert.deepEqual([almost.scope, almost.unknownProject], [{company: false, projectCount: others.length}, null]);
  await db.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,?,'edit')", [others.at(-1), editorId]);
  const full = (await editor('/accounting/profit?basis=cash')).body;
  assert.deepEqual(full.scope, {company: true, projectCount: others.length + 1});
  for (const basis of BASES) assert.deepEqual(await view(editor, basis), await view(admin, basis), basis);
  assert.deepEqual((await view(editor, 'cash')).unknown, [0, 0, 12121]);
});

// 会社への利益額の受け口の SQL が、取り消した報告の売上明細を除き（r.status='active'）、取り消した経費の取消日（expense_voided_on）・出金の取消の行（reverses_id）・
// 出金の源泉の控除額（withheld_yen）を読むことを、種の行から手で計算した値で確かめる（FR-ACCT-PROFIT-002）。案件41は売上率が決まらず売上は未確定のまま（上の試験と同じ）。
// 計上: 経費は 2026-04 に 2,000＋10,000＋3,000、取り消した経費は取消日の月に −2,000（2026-06）・−3,000（2026-07）。取り消した報告の 7,000 は売上に入れない。
// 入金: 全額の出金（2026-05-12）の税抜 2,000 と、源泉を引いた出金（9,979＋源泉 1,021＝税込 11,000。2026-05-25）の税抜 10,000 を 2026-05、出金の取消を 2026-06 に −2,000。
// 未払のまま取り消した経費は入金の基準に出ない。期間 2026-07 だけを開くと、取消日だけが期間に入る経費を読んで計上の −3,000 を出す（FR-ACCT-PROFIT-011）。
// 壊れたら: 報告の状態の絞りを外すと計上の未確定の売上が 37,000、取消日を読まないと計上の 2026-06・07 の取消が消え、出金の取消を読まないと
// 2026-06 の −2,200 が違う額の出金（未確定）に移り、源泉を読まないと 9,979 が違う額の出金に移り、期間の読み取りで取消日を見ないと 2026-07 が空になって落ちる
test('FR-ACCT-PROFIT-002 FR-ACCT-PROFIT-011 会社への利益額: 取り消した報告の売上明細は入れず、取り消した経費は取消日の月に戻し、出金の取消は取消の月に戻し、源泉を引いた出金は税込どおりの出金として税別で引く', async (t) => {
  const {db, admin} = await setup(t);
  await seedProfitHistory(db);
  const read = async (basis, period = '') => {
    const response = await admin(`/accounting/profit?basis=${basis}${period}`);
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 300));
    const body = response.body;
    return {months: body.months, settled: body.settled, unsettled: Object.fromEntries(body.unsettled.map((r) => [r.key, r.amounts])),
      byProject: body.byProject.map((p) => [p.code, p.salesYen, p.costYen, p.profitYen])};
  };
  const months = ['2026-04', '2026-05', '2026-06', '2026-07'];
  assert.deepEqual(await read('accrual'), {months,
    settled: {salesYen: [0, 0, 0, 0], costYen: [15000, 0, -2000, -3000], profitYen: [-15000, 0, 2000, 3000], totals: {salesYen: 0, costYen: 10000, profitYen: -10000}},
    unsettled: {sales_no_rate: [30000, 0, 0, 0], unclassified_expense: [16000, 0, 0, 0]},
    byProject: [['PRJ-BASIS', 0, 10000, -10000]]});
  assert.deepEqual(await read('cash'), {months,
    settled: {salesYen: [0, 0, 0, 0], costYen: [0, 12000, -2000, 0], profitYen: [0, -12000, 2000, 0], totals: {salesYen: 0, costYen: 10000, profitYen: -10000}},
    unsettled: {sales_no_rate: [0, 10000, 0, 0], sales_amount_differs: [0, 0, 19958, 0], unclassified_expense: [0, 5000, 0, 0], expense_amount_differs: [0, 0, 5000, 0]},
    byProject: [['PRJ-BASIS', 0, 10000, -10000]]});
  assert.deepEqual(await read('accrual', '&from=2026-07&to=2026-07'), {months: ['2026-07'],
    settled: {salesYen: [0], costYen: [-3000], profitYen: [3000], totals: {salesYen: 0, costYen: -3000, profitYen: 3000}},
    unsettled: {}, byProject: [['PRJ-BASIS', 0, -3000, 3000]]});
});
