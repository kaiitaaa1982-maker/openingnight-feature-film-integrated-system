// PL・BS の架空データ（scripts/seed-plbs-demo.mjs）の試験。
// ・売上の架空データ（seed-sales-demo）の後に1回だけ入り、2回目は何も足さない。DDL を流さず、1つの値は128KB未満（本番へ記録して再生できる）。
// ・PL・BS の数字を、pl-bs-model の関数を使わずに元の行（売上明細と配賦・経費・出金・入金・手入力）から計算し直して照合する。
// ・委員会作品の自社の取り分は、委員会の月次収支（/api/reports/committee-monthly）の自社の取得額と一致する。
// ・会社BSの「説明のつかない差額」は、減価償却費（現預金を動かさない手入力の費用）に見合う固定資産の月末残高も入れているので0円。
//   わざと固定資産を入れずに減価償却費だけ足すと、その額だけ差額が出る（差額の行は消さない）。
// ・現預金は期首の翌月から基準月の後まで、どの月末もマイナスにならない（架空の追加借入で賄う）。
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {seedSalesDemo, SALES_DEMO} from '../scripts/seed-sales-demo.mjs';
import {seedPlbsDemo, PLBS_DEMO, PRODUCTION_COSTS, loanBalanceAt, interestFor, fixedAssetsAt} from '../scripts/seed-plbs-demo.mjs';
import {termsFormFromVersion, termsPayload} from '../src/rights/committee-ui-model.mjs';
import {plBsSheets} from '../src/pl-bs/pl-bs-view.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';

// ---------- 独立に書いた計算 ----------
const pad = (n) => String(n).padStart(2, '0');
const addMonth = (ym, n) => {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
};
// 最大剰余法（端数は余りの大きい順、同じなら並び順）。parts: [{key, weight}]
function split(amount, parts) {
  const total = parts.reduce((n, part) => n + BigInt(part.weight), 0n);
  const sign = amount < 0 ? -1n : 1n;
  const whole = BigInt(Math.abs(amount));
  const rows = parts.map((part, index) => ({key: part.key, index, base: whole * BigInt(part.weight) / total, rest: whole * BigInt(part.weight) % total}));
  let left = whole - rows.reduce((n, row) => n + row.base, 0n);
  const order = [...rows].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (let j = 0; left > 0n; j += 1, left -= 1n) order[j % order.length].base += 1n;
  return new Map(rows.map((row) => [row.key, Number(sign * row.base)]));
}
const sum = (list) => list.reduce((n, value) => n + value, 0);
const PROMO = new Set(['P&A', '宣伝費']);
const kindOf = (category) => (category === '制作費' ? 'production' : PROMO.has(category) ? 'promotion' : category === '事務費' ? 'other' : 'direct');

let db, app, seeded, second, recorded, cookie, orgId, raw;
const FY = {from: '2025-05', to: '2026-04'};
const BS_MONTH = '2026-06';
const call = async (path) => {
  const response = await app.request(`/api${path}`, {headers: {cookie}});
  return {status: response.status, body: await response.json()};
};

before(async (t) => {
  db = await openTestDb({t});
  await seedSalesDemo(db);
  // 架空データの投入で流れる文を記録する（DDL を含まない・1つの値は128KB未満・D1 の上限）
  recorded = {ddl: [], maxValueBytes: 0, maxParams: 0, maxBatch: 0, statements: 0};
  const note = (sql, params = []) => {
    recorded.statements += 1;
    if (/^\s*(CREATE|ALTER|DROP|PRAGMA)\b/i.test(sql)) recorded.ddl.push(sql.slice(0, 60));
    recorded.maxParams = Math.max(recorded.maxParams, params.length);
    for (const value of params) if (typeof value === 'string') recorded.maxValueBytes = Math.max(recorded.maxValueBytes, Buffer.byteLength(value, 'utf8'));
  };
  const recorder = new Proxy(db, {get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    if (prop === 'run') return (sql, params) => { note(sql, params); return value.call(target, sql, params); };
    if (prop === 'batch') return (list) => { recorded.maxBatch = Math.max(recorded.maxBatch, list.length); for (const item of list) note(item.sql, item.params); return value.call(target, list); };
    if (prop === 'all' || prop === 'get') return (sql, params = []) => { recorded.maxParams = Math.max(recorded.maxParams, params.length); return value.call(target, sql, params); };
    return value.bind(target);
  }});
  seeded = await seedPlbsDemo(recorder);
  second = await seedPlbsDemo(db);
  orgId = seeded.orgId;
  app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  cookie = login.headers.get('set-cookie').split(';')[0];
  const all = (sql) => db.all(sql, [orgId]);
  raw = {
    works: await all('SELECT id, code, project_id FROM works WHERE org_id=? ORDER BY code'),
    committeeWorks: new Set((await all('SELECT DISTINCT work_id FROM committee_contracts WHERE org_id=?')).map((row) => row.work_id)),
    sales: await all(`SELECT s.id, s.work_id, s.product_id, s.accounting_month, s.amount_ex_tax, s.tax_amount FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
      WHERE s.org_id=? AND r.status='active' ORDER BY s.id`),
    productWorks: await all('SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=? ORDER BY product_id, work_id'),
    expenses: await all('SELECT id, work_id, accounting_month, category, actual_ex_tax, tax_amount, actual_inc_tax FROM expenses WHERE org_id=? ORDER BY id'),
    expensePayments: await all('SELECT id, expense_id, paid_on, amount_yen, reverses_id FROM expense_payments WHERE org_id=? ORDER BY id'),
    receipts: await all('SELECT r.id, r.received_on, r.amount_yen, x.reversed_on FROM billing_receipts r LEFT JOIN billing_receipt_reversals x ON x.org_id=r.org_id AND x.receipt_id=r.id WHERE r.org_id=?'),
    invoiceWorks: await all('SELECT DISTINCT lw.invoice_id, lw.work_id FROM billing_invoice_line_works lw WHERE lw.org_id=?'),
    royaltyEvents: await all("SELECT statement_id, occurred_on, amount_yen, reverses_event_id FROM royalty_statement_events WHERE org_id=? AND event_kind='paid'"),
    // 支払を作品へ分ける比: 報告書の明細の作品ごとの額から、前払金の充当を引いた額（取り消した報告書は除く）
    royaltyLines: await all(`SELECT l.statement_id, a.work_id, l.line_kind, l.amount_yen FROM royalty_statement_lines l JOIN royalty_agreements a ON a.org_id=l.org_id AND a.id=l.agreement_id
      WHERE l.org_id=? AND l.line_kind IN ('accrual','revision','advance_recoup') AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=l.org_id AND v.statement_id=l.statement_id)
      ORDER BY l.statement_id, a.work_id`),
    agreements: await all('SELECT id, work_id FROM royalty_agreements WHERE org_id=?'),
    investmentPayments: await all(`SELECT p.paid_on, p.amount_yen, p.partner_id, c.work_id FROM committee_investment_payments p JOIN committee_term_versions v ON v.org_id=p.org_id AND v.id=p.term_version_id
      JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id WHERE p.org_id=?`),
    manual: await all('SELECT m.id, m.month, m.kind, m.amount_yen, m.tax_yen, m.reverses_id, a.code, a.section, a.cash_effect FROM gl_manual_amounts m JOIN gl_accounts a ON a.org_id=m.org_id AND a.id=m.account_id WHERE m.org_id=?'),
    self: (await db.get("SELECT id FROM partners WHERE org_id=? AND code='DEMO-SELF'", [orgId])).id,
    committeeReceipts: await all(`SELECT e.paid_on, e.amount_yen, e.reverses_event_id, s.work_id FROM rights_payment_events e JOIN committee_report_snapshots s ON s.org_id=e.org_id AND s.id=e.committee_snapshot_id
      WHERE e.org_id=? AND e.partner_id=(SELECT id FROM partners WHERE org_id=e.org_id AND code='DEMO-SELF')`),
  };
});

// 自社作品の売上（計上月・税抜・税額）を作品×月に（商品の作品配賦を最大剰余法で。同じ余りは作品IDの小さい順）
function ownSalesByWorkMonth() {
  const shares = new Map();
  for (const row of raw.productWorks) {
    if (!shares.has(row.product_id)) shares.set(row.product_id, []);
    shares.get(row.product_id).push({key: row.work_id, weight: row.allocation_bps});
  }
  const out = new Map();
  for (const sale of raw.sales) {
    const parts = sale.product_id && shares.get(sale.product_id) ? shares.get(sale.product_id) : [{key: sale.work_id, weight: 10000}];
    const ex = split(sale.amount_ex_tax, parts), tax = split(sale.tax_amount, parts);
    for (const {key} of parts) {
      if (raw.committeeWorks.has(key)) continue;
      const cell = `${key}|${sale.accounting_month}`;
      const current = out.get(cell) || {ex: 0, tax: 0};
      out.set(cell, {ex: current.ex + ex.get(key), tax: current.tax + tax.get(key)});
    }
  }
  return out;
}
const inRange = (month, from, to) => month >= from && month <= to;
const liveManual = () => {
  const reversed = new Set(raw.manual.filter((row) => row.reverses_id != null).map((row) => row.reverses_id));
  return raw.manual.filter((row) => row.reverses_id == null && !reversed.has(row.id));
};

test('架空データは DEMO-SALES に1回だけ入り、2回目は何も足さない。DDL を流さず、値は128KB未満、D1 の上限を守る', async () => {
  assert.deepEqual(recorded.ddl, [], 'DDL を流さない');
  assert.ok(recorded.maxValueBytes < 128 * 1024, `最大の値 ${recorded.maxValueBytes}バイト`);
  assert.ok(recorded.maxParams <= 100, `1文の値 ${recorded.maxParams}個`);
  assert.ok(recorded.maxBatch <= 480, `1回の batch ${recorded.maxBatch}文`);
  assert.deepEqual(second.counts, seeded.counts, '2回目は増えない');
  assert.equal(second.productionExpenses, undefined);
  assert.equal(seeded.productionExpenses, 36, '委員会でない12本×3か月');
  assert.equal(seeded.counts.expenses, 123 + 36, '既存の経費123件＋制作費36件');
  assert.equal(seeded.counts.profiles, 1);
  assert.equal(seeded.manualAmounts, 5 + 28 * 11 + 3, '期首残高5行＋28か月×（全社費用9科目＋固定資産の月末残高＋支払利息）＋追加の借入3回');
  assert.equal(seeded.committeeReceipts, 2);
  const profile = (await call('/pl-bs/settings')).body.profile;
  assert.equal(profile.selfPartnerCode, 'DEMO-SELF');
  assert.equal(profile.openingMonth, PLBS_DEMO.openingMonth);
  assert.match(profile.legalName, /（架空）$/);
  assert.equal(profile.corporateNumber, null, '実在の番号と重ならないよう空欄');
  const fiscal = (await call('/settings/fiscal')).body.setting;
  assert.deepEqual({start: fiscal.fiscalStartMonth, confirmed: fiscal.confirmed}, {start: 5, confirmed: true});
  // 経費の出金: 多くは翌月末、一部は未払、1件は2回に分け、1件は取消して払い直す
  const paidByExpense = new Map();
  for (const row of raw.expensePayments) paidByExpense.set(row.expense_id, (paidByExpense.get(row.expense_id) || 0) + row.amount_yen);
  const unpaid = raw.expenses.filter((row) => (paidByExpense.get(row.id) || 0) < row.actual_inc_tax);
  assert.ok(unpaid.length >= 5 && unpaid.length <= 15, `未払 ${unpaid.length}件`);
  assert.ok(raw.expensePayments.some((row) => row.reverses_id != null), '取消の行がある');
  assert.ok([...new Set(raw.expensePayments.map((row) => row.expense_id))].some((id) => raw.expensePayments.filter((row) => row.expense_id === id && row.reverses_id == null).length === 2 && !raw.expensePayments.some((row) => row.reverses_id != null && raw.expensePayments.find((x) => x.id === row.reverses_id)?.expense_id === id)), '2回に分けて払った経費');
  const nextMonthEnd = raw.expensePayments.filter((row) => row.reverses_id == null).filter((row) => {
    const expense = raw.expenses.find((item) => item.id === row.expense_id);
    return row.paid_on.slice(0, 7) === addMonth(expense.accounting_month, 1);
  });
  assert.ok(nextMonthEnd.length / raw.expensePayments.length > 0.9, '多くは計上月の翌月末');
  // 出資の払込は自社の分だけ、8本すべて（2本は2回）
  assert.equal(new Set(raw.investmentPayments.map((row) => row.work_id)).size, 8);
  assert.ok(raw.investmentPayments.every((row) => row.partner_id === raw.self));
  // 請求は自社作品の売上だけ、2026-04 計上分まで
  assert.ok(raw.invoiceWorks.length > 100);
  assert.ok(raw.invoiceWorks.every((row) => !raw.committeeWorks.has(row.work_id)), '委員会作品の売上は請求しない');
  const lastBilled = (await db.get("SELECT MAX(accounting_month) AS m FROM billing_invoice_lines WHERE org_id=?", [orgId])).m;
  assert.equal(lastBilled, PLBS_DEMO.billingTo);
  // 名前・コードは架空
  const accounts = (await call('/pl-bs/settings')).body.accounts;
  assert.ok(accounts.length >= 40);
  const expenses = await db.all("SELECT description FROM expenses WHERE org_id=? AND category='制作費'", [orgId]);
  assert.ok(expenses.every((row) => row.description.includes('架空')));
});

test('制作費は公開月より前に計上し、案件の予算の残りを割り振った額（作品ごとの合計）', async () => {
  const production = raw.expenses.filter((row) => row.category === '制作費');
  const byWork = new Map();
  for (const row of production) byWork.set(row.work_id, (byWork.get(row.work_id) || 0) + row.actual_ex_tax);
  for (const work of raw.works.filter((row) => !raw.committeeWorks.has(row.id))) {
    assert.equal(byWork.get(work.id), PRODUCTION_COSTS[work.code], work.code);
    const release = addMonth('2024-07', Number(work.code.slice(-2)) - 1);
    assert.ok(production.filter((row) => row.work_id === work.id).every((row) => row.accounting_month < release && row.accounting_month > PLBS_DEMO.openingMonth), work.code);
  }
  assert.ok(production.every((row) => !raw.committeeWorks.has(row.work_id)), '委員会作品には制作費を入れない（委員会の制作費は出資で賄う）');
});

test('委員会作品の自社の取り分は、委員会の月次収支の自社（DEMO-SELF）の取得額と一致する', async () => {
  const {body} = await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`);
  assert.equal(body.ok, true, body.error);
  let compared = 0;
  for (const workId of raw.committeeWorks) {
    const monthly = await call(`/reports/committee-monthly?workId=${workId}&from=${FY.from}&to=${FY.to}`);
    assert.equal(monthly.status, 200, JSON.stringify(monthly.body).slice(0, 200));
    const self = monthly.body.report.investors.find((row) => row.partnerId === raw.self);
    const pl = body.workPl.find((row) => row.workId === workId);
    assert.equal(pl.kind, 'committee');
    assert.equal(pl.period.acq, self.period.acquisition, `作品${workId}の期間の取得額`);
    assert.equal(pl.period.acqDist, self.period.distribution);
    assert.equal(pl.period.acqWindowFee, self.period.windowFee);
    assert.equal(pl.period.acqManagerFee, self.period.managerFee);
    assert.equal(pl.cumulative.acq, self.cumulative.acquisition, `作品${workId}の累計の取得額`);
    assert.equal(pl.period.royalty, 0, '委員会の権利処理費は自社の費用にしない');
    assert.equal(pl.period.direct + pl.period.promotion + pl.period.workOther, 0, '委員会の経費は自社の費用にしない');
    compared += 1;
  }
  assert.equal(compared, 8);
});

test('作品別PL・会社PL（2025年度）を、元の行から計算し直した額と照合する', async () => {
  const {body} = await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`);
  const sales = ownSalesByWorkMonth();
  const ledger = (await call(`/royalty/ledger?from=2024-07&to=${FY.to}`)).body;
  const workOfAgreement = new Map(raw.agreements.map((row) => [row.id, row.work_id]));
  const firstSale = new Map();
  for (const [cell] of sales) {
    const [workId, month] = cell.split('|');
    if (!firstSale.has(Number(workId)) || month < firstSale.get(Number(workId))) firstSale.set(Number(workId), month);
  }
  let expectedNet = 0;
  for (const work of raw.works.filter((row) => !raw.committeeWorks.has(row.id))) {
    const pl = body.workPl.find((row) => row.workId === work.id);
    const expectedSales = sum([...sales].filter(([cell]) => cell.startsWith(`${work.id}|`) && inRange(cell.split('|')[1], FY.from, FY.to)).map(([, value]) => value.ex));
    const royalty = sum(ledger.detail.filter((row) => workOfAgreement.get(row.agreementId) === work.id && inRange(row.accrualMonth, FY.from, FY.to) && Number.isSafeInteger(row.royaltyYen)).map((row) => row.royaltyYen));
    const own = raw.expenses.filter((row) => row.work_id === work.id);
    const byKind = (kind) => sum(own.filter((row) => kindOf(row.category) === kind && inRange(row.accounting_month, FY.from, FY.to)).map((row) => row.actual_ex_tax));
    // 制作費: 公開月（全作品のウィンドウが無いので最初に売上を計上した月）に、それまでの制作費をまとめて費用にする
    const release = firstSale.get(work.id);
    const production = inRange(release, FY.from, FY.to) ? sum(own.filter((row) => row.category === '制作費' && row.accounting_month <= release).map((row) => row.actual_ex_tax)) : 0;
    assert.deepEqual({sales: pl.period.sales, royalty: pl.period.royalty, direct: pl.period.direct, promotion: pl.period.promotion, other: pl.period.workOther, production: pl.period.production},
      {sales: expectedSales, royalty, direct: byKind('direct'), promotion: byKind('promotion'), other: byKind('other'), production}, work.code);
    assert.equal(pl.period.profit, expectedSales - royalty - byKind('direct') - byKind('promotion') - byKind('other') - production, work.code);
    expectedNet += pl.period.profit;
    assert.equal(pl.releaseMonth, release);
    assert.equal(pl.releaseSource, 'first_sale');
  }
  for (const workId of raw.committeeWorks) expectedNet += body.workPl.find((row) => row.workId === workId).period.acq;
  const manualFlows = liveManual().filter((row) => row.kind === 'flow' && inRange(row.month, FY.from, FY.to));
  expectedNet -= sum(manualFlows.map((row) => row.amount_yen)); // 全社費用と支払利息（どれも費用）
  assert.equal(sum(manualFlows.filter((row) => row.code === '6280').map((row) => row.amount_yen)), 12 * 50000);
  const pl = body.companyPl.rows;
  assert.equal(pl.find((row) => row.key === 'netIncome').values.period, expectedNet);
  assert.equal(sum(pl.filter((row) => row.key.startsWith('manual:') && row.section === 'sga').map((row) => row.values.period)), sum(manualFlows.filter((row) => row.section === 'sga').map((row) => row.amount_yen)), 'PL は税抜の額');
  // 支払利息は前月末の借入金×年1.08%÷12（期首2億は月18万円、追加の借入の翌月から増える）
  let interest = 0;
  for (let m = FY.from; m <= FY.to; m = addMonth(m, 1)) interest += Math.round(loanBalanceAt(addMonth(m, -1)) * 0.0108 / 12);
  assert.equal(pl.find((row) => row.label === '支払利息').values.period, interest);
  assert.equal(interestFor('2024-05'), PLBS_DEMO.interestYen);
  assert.ok(body.checks.every((row) => row.value === 0), JSON.stringify(body.checks));
});

test('会社BS（2026-06末）の現預金・売掛金・出資金・委員会からの未収を元の行から計算し直し、説明のつかない差額は0（減価償却費に見合う固定資産も入れている）', async () => {
  const {body} = await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`);
  const bs = body.companyBs;
  const value = (key) => bs.rows.find((row) => row.key === key).value;
  const open = PLBS_DEMO.openingMonth;
  const inWindow = (date) => date.slice(0, 7) > open && date.slice(0, 7) <= BS_MONTH;
  // 請求の入金（取消は取消日に戻す）
  const receipts = sum(raw.receipts.filter((row) => inWindow(row.received_on)).map((row) => row.amount_yen)) - sum(raw.receipts.filter((row) => row.reversed_on && inWindow(row.reversed_on)).map((row) => row.amount_yen));
  const committeeReceipts = sum(raw.committeeReceipts.filter((row) => inWindow(row.paid_on)).map((row) => (row.reverses_event_id ? -row.amount_yen : row.amount_yen)));
  // 経費の出金（自社作品の経費だけ。委員会作品の経費は委員会の口座から払う前提）
  const expenseOf = new Map(raw.expenses.map((row) => [row.id, row]));
  const expensePaid = sum(raw.expensePayments.filter((row) => inWindow(row.paid_on) && !raw.committeeWorks.has(expenseOf.get(row.expense_id).work_id)).map((row) => row.amount_yen));
  // ロイヤリティの支払を報告書の明細の作品ごとの額の比で分け、自社作品の分だけ
  const weightOf = new Map();
  for (const row of raw.royaltyLines) {
    const key = `${row.statement_id}|${row.work_id}`;
    weightOf.set(key, (weightOf.get(key) || 0) + (row.line_kind === 'advance_recoup' ? -row.amount_yen : row.amount_yen));
  }
  const linesOf = new Map();
  for (const [key, amount] of weightOf) {
    const [statementId, workId] = key.split('|').map(Number);
    if (!linesOf.has(statementId)) linesOf.set(statementId, []);
    if (amount > 0) linesOf.get(statementId).push({key: workId, weight: amount});
  }
  let royaltyOwn = 0;
  for (const event of raw.royaltyEvents.filter((row) => inWindow(row.occurred_on))) {
    const amount = event.reverses_event_id ? -event.amount_yen : event.amount_yen;
    const parts = linesOf.get(event.statement_id) || [];
    if (!parts.length) { royaltyOwn += amount; continue; }
    for (const [workId, value] of split(amount, parts)) if (!raw.committeeWorks.has(workId)) royaltyOwn += value;
  }
  const invested = sum(raw.investmentPayments.filter((row) => inWindow(row.paid_on)).map((row) => row.amount_yen));
  const manual = liveManual();
  // 手入力の費用は税込（税抜＋消費税額）で現預金が動く。借入金の月末残高の増加は現預金の増加
  const manualCash = sum(manual.filter((row) => row.kind === 'flow' && row.cash_effect && row.month > open && row.month <= BS_MONTH).map((row) => row.amount_yen + row.tax_yen));
  const manualTax = sum(manual.filter((row) => row.kind === 'flow' && row.month > open && row.month <= BS_MONTH).map((row) => row.tax_yen));
  assert.ok(manualTax > 1500000, `手入力の費用の消費税額 ${manualTax}`);
  const loanIncrease = loanBalanceAt(BS_MONTH) - PLBS_DEMO.opening.loan;
  assert.equal(loanIncrease, 400000000);
  const cash = PLBS_DEMO.opening.cash + receipts + committeeReceipts - expensePaid - royaltyOwn - invested - manualCash + loanIncrease;
  assert.equal(value('cash'), cash);
  // 売掛金 = 自社作品の売上（税込）−請求の入金
  const sales = ownSalesByWorkMonth();
  const salesInc = sum([...sales].filter(([cell]) => { const m = cell.split('|')[1]; return m > open && m <= BS_MONTH; }).map(([, v]) => v.ex + v.tax));
  assert.equal(value('receivable'), salesInc - receipts);
  assert.equal(value('committee_investment'), invested);
  let acquired = 0;
  for (const workId of raw.committeeWorks) {
    const monthly = (await call(`/reports/committee-monthly?workId=${workId}&from=2024-05&to=${BS_MONTH}`)).body;
    acquired += monthly.report.investors.find((row) => row.partnerId === raw.self).cumulative.acquisition;
  }
  assert.equal(value('committee_receivable'), acquired - committeeReceipts);
  // 差額: 減価償却費（期首の翌月から2026-06までの26か月×5万円）に見合う固定資産の月末残高も入れているので0。手がかりの2つが打ち消し合う
  const months = 26;
  assert.equal(bs.difference, 0);
  assert.deepEqual(bs.hints.map((hint) => [hint.key, hint.value]), [['openingGap', 0], ['nonCashPl', months * 50000], ['nonCashBalance', -months * 50000], ['unexplained', 0]]);
  assert.equal(bs.rows.find((row) => row.label === '固定資産').value, fixedAssetsAt(BS_MONTH));
  assert.equal(bs.rows.find((row) => row.label === '借入金').value, loanBalanceAt(BS_MONTH));
  assert.equal(bs.rows.at(-1).key, 'difference');
  assert.equal(bs.rows.at(-1).label, '説明のつかない差額（資産−負債−純資産）');
  assert.equal(bs.rows.at(-1).origin, 'system', '差額0なら由来はシステム');
  assert.ok(value('cash') > 0);
  assert.ok(!body.notes.some((text) => text.includes('現預金がマイナス')));
  // 期首残高は貸借が合っている（繰越利益剰余金は差額で逆算した架空の額）
  assert.equal(bs.rows.find((row) => row.key === 'retained_earnings').opening, PLBS_DEMO.opening.cash + PLBS_DEMO.opening.fixedAssets - PLBS_DEMO.opening.loan - PLBS_DEMO.opening.capital);
  // 未払消費税等に手入力の費用の消費税額（仮払）が入る
  assert.ok(body.companyBs.cashFlows.manualCostTax === manualTax);
});

test('作品別の残高: 自社作品の売掛金・未払の経費と、委員会作品の出資金・回収率。未払の経費は経費の画面の未払と一致する', async () => {
  const {body} = await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${PLBS_DEMO.asOf.slice(0, 7)}`);
  for (const row of body.workBalances.filter((item) => item.kind === 'own')) {
    const payments = (await call(`/expense-payments?workId=${row.workId}`)).body.rows.filter((item) => item.workId === row.workId);
    const due = payments.filter((item) => item.accountingMonth <= PLBS_DEMO.asOf.slice(0, 7));
    // 架空データの出金はすべて基準日（2026-09-25）までなので、経費の画面の「出金済み」をそのまま引ける
    assert.equal(row.expensePayable, sum(due.map((item) => item.incTax)) - sum(due.map((item) => item.paidYen)), row.code);
    assert.equal(row.investmentPaid, null);
  }
  for (const row of body.workBalances.filter((item) => item.kind === 'committee')) {
    assert.equal(row.investmentUnpaid, 0, '自社の出資は払込済み');
    assert.ok(row.recoveryRate > 0 && row.recoveryRate < 2, `${row.code} ${row.recoveryRate}`);
    assert.equal(row.recoveryRate, row.cumulativeAcquisition / row.investmentCommitted);
    assert.equal(row.receivable, null, '委員会作品の売上は自社の売掛金にしない');
  }
});

test('帳票の Excel は画面と同じ数字（会社BSの説明のつかない差額・作品別PLの行数）', async () => {
  const {body} = await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`);
  const bsBook = decodeXlsx(encodeReportXlsx({sheets: plBsSheets(body, 'company-bs')}));
  const rows = bsBook[0].rows;
  const last = rows.find((cells) => String(cells[1] || '').startsWith('説明のつかない差額'));
  assert.equal(Number(last[3]), body.companyBs.difference);
  const plBook = decodeXlsx(encodeReportXlsx({sheets: plBsSheets(body, 'work-pl')}));
  const header = plBook[0].rows.findIndex((cells) => cells[0] === '作品コード');
  const codes = plBook[0].rows.slice(header + 1).filter((cells) => /^DEMO-W\d\d$/.test(String(cells[0])));
  assert.equal(codes.length, 20);
  const companyPl = decodeXlsx(encodeReportXlsx({sheets: plBsSheets(body, 'company-pl')}));
  const net = companyPl[0].rows.find((cells) => String(cells[1] || '').trim() === '当期純利益');
  assert.equal(Number(net.at(-2)), body.companyPl.netIncome.period, '期間計の列');
});

test('D1 の上限: 20作品・2年分の PL・BS を出すときの1文の値は100個以下', async () => {
  let maxParams = 0, statements = 0;
  const recorder = new Proxy(db, {get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    if (['all', 'get', 'run'].includes(prop)) return (sql, params = []) => { maxParams = Math.max(maxParams, params.length); statements += 1; return value.call(target, sql, params); };
    return value.bind(target);
  }});
  const local = createApp({db: recorder, mode: 'local'});
  const response = await local.request(`/api/reports/pl-bs?from=2024-05&to=2026-06&asOf=2026-06`, {headers: {cookie}});
  assert.equal(response.status, 200);
  assert.ok(statements > 20 && statements < 400, `${statements}文`);
  assert.ok(maxParams <= 100, `1文の値 ${maxParams}個`);
});

test('組織1からは DEMO-SALES の PL・BS が見えず、出資の払込は約定額までで取消の行で戻せる', async () => {
  const fixture = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.fixtureAdminEmail})});
  const other = fixture.headers.get('set-cookie').split(';')[0];
  const response = await app.request(`/api/reports/pl-bs?from=${FY.from}&to=${FY.to}`, {headers: {cookie: other}});
  const body = await response.json();
  assert.ok(body.workPl.every((row) => !row.code.startsWith('DEMO-')), '組織1の画面に DEMO-SALES の作品は出ない');
  // 他の出資者（架空シネマ配給）の払込を1円記録して取り消す
  const workId = [...raw.committeeWorks][0];
  const list = (await call(`/committee-investments?workId=${workId}`)).body.rows.filter((row) => row.latest && !row.isSelf);
  const target = list[0];
  const post = async (path, payload) => {
    const res = await app.request(`/api${path}`, {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(payload)});
    return {status: res.status, body: await res.json()};
  };
  assert.equal((await post('/committee-investment-payments', {termVersionId: target.termVersionId, partnerId: target.partnerId, paidOn: '2024-06-30', amountYen: target.amountYen + 1})).status, 409, '約定額を超える払込は止める');
  assert.equal((await post('/committee-investment-payments', {termVersionId: target.termVersionId, partnerId: target.partnerId, paidOn: '2024-06-30', amountYen: 1000, note: '架空の払込'})).status, 201);
  const paid = (await call(`/committee-investments?workId=${workId}`)).body.rows.find((row) => row.termVersionId === target.termVersionId && row.partnerId === target.partnerId);
  assert.equal(paid.paidYen, 1000);
  const payment = paid.payments[0];
  assert.equal((await post(`/committee-investment-payments/${payment.id}/reverse`, {reversedOn: '2024-07-01', reason: '誤って記録した（架空）'})).status, 201);
  const after = (await call(`/committee-investments?workId=${workId}`)).body.rows.find((row) => row.termVersionId === target.termVersionId && row.partnerId === target.partnerId);
  assert.equal(after.paidYen, 0);
  await assert.rejects(db.run('UPDATE committee_investment_payments SET amount_yen=1'), (e) => e.dbError?.kind === 'raise' && /変更できません/.test(e.message));
  // 他の出資者の払込は自社の出資金に入らない
  const bs = (await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`)).body.companyBs;
  assert.equal(bs.rows.find((row) => row.key === 'committee_investment').value, sum(raw.investmentPayments.filter((row) => row.paid_on.slice(0, 7) <= BS_MONTH).map((row) => row.amount_yen)));
});

// ---------- 見直しで足した試験（後ろの試験ほど架空データを書き足すので、ここより前の試験の数字には影響しない） ----------
const request = async (method, path, payload) => {
  const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
  return {status: response.status, body: await response.json()};
};

test('現預金は期首の翌月から基準月の後まで、どの月末もマイナスにならない。説明のつかない差額はどの月末も0', async () => {
  let lowest = Infinity;
  for (let m = addMonth(PLBS_DEMO.openingMonth, 1); m <= PLBS_DEMO.manualTo; m = addMonth(m, 1)) {
    const {body} = await call(`/reports/pl-bs?from=${m}&to=${m}&asOf=${m}`);
    const cash = body.companyBs.rows.find((row) => row.key === 'cash').value;
    lowest = Math.min(lowest, cash);
    assert.ok(cash >= 0, `${m}末の現預金 ${cash}`);
    assert.equal(body.companyBs.difference, 0, `${m}末の差額`);
  }
  assert.ok(lowest > 10000000, `最も少ない月末の現預金 ${lowest}`);
});

test('設計書の数字: 制作費は36件・税抜3億9,000万・税込4億2,900万。2026-06末までの制作費の出金は4億2,900万、出資の払込の累計は2億9,585万', async () => {
  const production = await db.get("SELECT COUNT(*) AS n, SUM(actual_ex_tax) AS ex, SUM(actual_inc_tax) AS inc FROM expenses WHERE org_id=? AND category='制作費'", [orgId]);
  const total = Object.values(PRODUCTION_COSTS).reduce((n, value) => n + value, 0);
  assert.deepEqual([production.n, production.ex, production.inc], [36, total, Math.trunc(total * 1.1)]);
  assert.deepEqual([total, Math.trunc(total * 1.1)], [390000000, 429000000]);
  const paid = await db.get(`SELECT SUM(p.amount_yen) AS n FROM expense_payments p JOIN expenses e ON e.org_id=p.org_id AND e.id=p.expense_id
    WHERE p.org_id=? AND e.category='制作費' AND p.paid_on<=?`, [orgId, `${BS_MONTH}-30`]);
  assert.equal(paid.n, 429000000);
  assert.equal(sum(raw.investmentPayments.filter((row) => row.paid_on <= `${BS_MONTH}-30`).map((row) => row.amount_yen)), 295850000);
});

test('作品別収支の「経費のうち制作費」は、作品別PLの制作費と同じ額（計上月か公開月かの違いだけ。DEMO-W16 の2025年度）', async () => {
  const w16 = raw.works.find((row) => row.code === 'DEMO-W16');
  const pnl = (await call(`/reports/work-pnl?workId=${w16.id}&from=${FY.from}&to=${FY.to}`)).body;
  const pl = (await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`)).body.workPl.find((row) => row.workId === w16.id);
  assert.equal(pnl.productionCost.status, 'included');
  assert.equal(pnl.productionCost.amount, 35000000);
  assert.equal(pl.period.production, pnl.productionCost.amount);
  assert.doesNotMatch(pnl.productionCost.note, /差し引いていません/);
});

test('会社BSの説明のつかない差額は消さない: 減価償却費だけを入れて固定資産を入れないと、その額だけ差額が出る（取り消すと0に戻る）', async () => {
  const added = await request('POST', '/pl-bs/manual', {entries: [{accountCode: '6280', month: BS_MONTH, amountYen: 12345, basis: '固定資産を入れずに足した減価償却費（試験・架空）', status: 'reviewed'}]});
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const {body} = await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`);
  assert.equal(body.companyBs.difference, 12345);
  assert.equal(body.companyBs.rows.at(-1).origin, 'unverified');
  assert.equal(body.companyBs.hints.at(-1).value, 0, '手がかり（現預金を動かさない手入力の費用）で説明できる');
  const row = (await call(`/pl-bs/manual?from=${BS_MONTH}&to=${BS_MONTH}`)).body.rows.find((item) => item.amountYen === 12345);
  assert.equal((await request('POST', `/pl-bs/manual/${row.id}/reverse`, {reason: '試験で入れた（架空）'})).status, 201);
  assert.equal((await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`)).body.companyBs.difference, 0);
});

test('委員会からの受取が取得額の累計を上回る年度（2024年度の DEMO-W01）は、未収をマイナスのまま未確定にする', async () => {
  const w01 = raw.works.find((row) => row.code === 'DEMO-W01');
  const fy2024 = (await call('/reports/pl-bs?from=2024-05&to=2025-04&asOf=2025-04')).body;
  const early = fy2024.workBalances.find((row) => row.workId === w01.id);
  assert.equal(early.committeeReceivable, -2138663);
  assert.equal(early.origin, 'unverified');
  assert.ok(early.reasons.some((text) => text.includes('2,138,663円上回って')), early.reasons.join());
  assert.equal(fy2024.companyBs.reference.find((row) => row.key === 'committee_over_received').value, 2138663);
  const fy2025 = (await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`)).body;
  const later = fy2025.workBalances.find((row) => row.workId === w01.id);
  assert.equal(later.committeeReceivable, 4301232);
  assert.ok(!later.reasons.some((text) => text.includes('上回って')));
});

test('委員会の条件版を足しても、払込は委員会契約×参加者で全部の版をまとめて数え、最新の版にだけ・最新の出資額まで記録できる', async () => {
  const w01 = raw.works.find((row) => row.code === 'DEMO-W01');
  const before = (await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`)).body;
  const contract = (await call(`/committee/contracts?workId=${w01.id}`)).body.contracts[0];
  const v1 = contract.versions.at(-1);
  const form = {...termsFormFromVersion(contract, v1), effectiveFrom: '2026-07'};
  const saved = await request('POST', `/committee/contracts/${contract.id}/versions`, {...termsPayload(form, w01.id), confirmRetroactive: true});
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const rows = (await call(`/committee-investments?workId=${w01.id}`)).body.rows;
  const selfLatest = rows.find((row) => row.latest && row.isSelf);
  const selfOld = rows.find((row) => !row.latest && row.isSelf);
  // (a) 最新の版の自社の行は、版1の払込をまとめて払込済み・未払込0。古い版の行は履歴（払込の数字を出さない）
  assert.deepEqual([selfLatest.versionNo, selfLatest.paidYen, selfLatest.unpaidYen], [saved.body.versionNo, selfLatest.amountYen, 0]);
  assert.equal(selfLatest.amountYen, 61200000);
  assert.ok(selfLatest.payments.length >= 1 && selfLatest.payments.every((payment) => payment.versionNo === v1.version_no));
  assert.deepEqual([selfOld.paidYen, selfOld.unpaidYen, selfOld.payments.length], [null, null, 0]);
  // (b) 払込済みの自社へは1円も記録できない。古い版へ送っても止める
  const pay = (termVersionId, partnerId, amountYen) => request('POST', '/committee-investment-payments', {termVersionId, partnerId, paidOn: '2026-07-10', amountYen, note: '試験（架空）'});
  assert.equal((await pay(selfLatest.termVersionId, selfLatest.partnerId, 1)).status, 409);
  const toOld = await pay(selfOld.termVersionId, selfOld.partnerId, 1);
  assert.equal(toOld.status, 409);
  assert.match(toOld.body.error, /最新の条件版/);
  // (c) 他の出資者: 版1に1,000円払い込んでから版2を足した扱い（版1の払込は版2の上限に数える）
  const otherOld = rows.find((row) => !row.latest && !row.isSelf);
  assert.equal((await db.run('INSERT INTO committee_investment_payments(org_id,term_version_id,partner_id,paid_on,amount_yen,method,note,created_by) VALUES(?,?,?,?,?,?,?,(SELECT user_id FROM memberships WHERE org_id=? LIMIT 1))',
    [orgId, otherOld.termVersionId, otherOld.partnerId, '2026-06-30', 1000, 'transfer', '版1への払込（試験・架空）', orgId])).changes, 1);
  const otherLatest = (await call(`/committee-investments?workId=${w01.id}`)).body.rows.find((row) => row.latest && row.partnerId === otherOld.partnerId);
  assert.deepEqual([otherLatest.paidYen, otherLatest.unpaidYen], [1000, otherLatest.amountYen - 1000]);
  assert.equal((await pay(otherLatest.termVersionId, otherLatest.partnerId, otherLatest.amountYen - 1000 + 1)).status, 409);
  assert.equal((await pay(otherLatest.termVersionId, otherLatest.partnerId, otherLatest.amountYen - 1000)).status, 201);
  // (f) 版1の払込を取消の行で戻すと、最新の行の払込済みが減る
  const listed = (await call(`/committee-investments?workId=${w01.id}`)).body.rows.find((row) => row.latest && row.partnerId === otherOld.partnerId);
  const first = listed.payments.find((payment) => payment.amountYen === 1000 && !payment.reversed && !payment.reversesId);
  assert.equal((await request('POST', `/committee-investment-payments/${first.id}/reverse`, {reversedOn: '2026-07-01', reason: '試験で戻す（架空）'})).status, 201);
  const afterReverse = (await call(`/committee-investments?workId=${w01.id}`)).body.rows.find((row) => row.latest && row.partnerId === otherOld.partnerId);
  assert.equal(afterReverse.paidYen, otherLatest.amountYen - 1000);
  // (e) PL・BS: 自社の出資金・未払込は版を足す前と同じ（他の出資者の払込は自社の出資金に入らない）
  const after = (await call(`/reports/pl-bs?from=${FY.from}&to=${FY.to}&asOf=${BS_MONTH}`)).body;
  const balance = (body) => body.workBalances.find((row) => row.workId === w01.id);
  assert.deepEqual([balance(after).investmentPaid, balance(after).investmentUnpaid], [balance(before).investmentPaid, 0]);
  const bsValue = (body, key) => body.companyBs.rows.find((row) => row.key === key).value;
  assert.equal(bsValue(after, 'committee_investment'), bsValue(before, 'committee_investment'));
  assert.equal(after.companyBs.reference.find((row) => row.key === 'investment_unpaid').value, before.companyBs.reference.find((row) => row.key === 'investment_unpaid').value);
  // (d) 版3で自社の出資額を100万円増やすと、上限は新しい額（残り100万円だけ払い込める）
  const contract2 = (await call(`/committee/contracts?workId=${w01.id}`)).body.contracts[0];
  const v2 = contract2.versions.at(-1);
  const form3 = {...termsFormFromVersion(contract2, v2), effectiveFrom: '2026-08'};
  form3.funding = {...form3.funding, investments: form3.funding.investments.map((item) => (Number(item.partnerId) === selfLatest.partnerId ? {...item, amountYen: String(61200000 + 1000000)} : item)),
    productionCostYen: String(Number(String(form3.funding.productionCostYen).replace(/,/g, '')) + 1000000)};
  const saved3 = await request('POST', `/committee/contracts/${contract2.id}/versions`, {...termsPayload(form3, w01.id), confirmRetroactive: true});
  assert.equal(saved3.status, 201, JSON.stringify(saved3.body));
  const self3 = (await call(`/committee-investments?workId=${w01.id}`)).body.rows.find((row) => row.latest && row.isSelf);
  assert.deepEqual([self3.amountYen, self3.paidYen, self3.unpaidYen], [62200000, 61200000, 1000000]);
  assert.equal((await pay(self3.termVersionId, self3.partnerId, 1000001)).status, 409);
  assert.equal((await pay(self3.termVersionId, self3.partnerId, 1000000)).status, 201);
});

test('自社作品の前払金: 充当で済んだ分は未払ロイヤリティに残らない（ロイヤリティ台帳の未払残と同じ）。前払金の支払は記録が無いので未確定', async () => {
  const w02 = raw.works.find((row) => row.code === 'DEMO-W02');
  const Q = `/reports/pl-bs?from=${FY.from}&to=${BS_MONTH}&asOf=${BS_MONTH}`;
  const before = (await call(Q)).body;
  const partner = await request('POST', '/partners', {code: 'DEMO-HX', name: '前払金のある原作者（架空）', kind: 'other', region: '全国'});
  assert.equal(partner.status, 201, JSON.stringify(partner.body));
  const agreement = await request('POST', '/royalty/agreements', {workId: w02.id, holderPartnerId: partner.body.id, category: 'original', agreementCode: 'DEMO-RY-W02-ADV', title: '「W02」原作の追加許諾（架空）',
    documentReference: '架空の原作利用許諾契約書（前払金つき）',
    term: {effectiveFrom: '2024-08', calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 1000, channels: [], expenseCategories: [], advanceYen: 3000000, clauseReference: '第6条・第7条（架空）'},
    schedule: {phases: [{startsMonth: '2024-08', endsMonth: null, cycleKind: 'semiannual', anchorMonth: 6, customCloseMonths: null, firstCloseImmediate: false, reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom', note: null}]}});
  assert.equal(agreement.status, 201, JSON.stringify(agreement.body));
  assert.equal((await request('POST', '/royalty/statements/generate', {asOf: '2026-09-25', confirmed: true})).status < 300, true);
  const statements = await db.all('SELECT id, advance_recouped_yen, payable_yen, payment_due_on FROM royalty_statements WHERE org_id=? AND holder_partner_id=? ORDER BY close_month', [orgId, partner.body.id]);
  assert.ok(statements.some((row) => row.advance_recouped_yen > 0), '充当のある報告書ができる');
  for (const row of statements.filter((item) => item.payable_yen > 0 && item.payment_due_on <= `${BS_MONTH}-30`)) {
    assert.equal((await request('POST', `/royalty/statements/${row.id}/events`, {kind: 'paid', occurredOn: row.payment_due_on, amountYen: row.payable_yen, reference: `DEMO-ADV-${row.id}`})).status, 201);
  }
  const after = (await call(Q)).body;
  const own = (body) => body.workBalances.find((row) => row.workId === w02.id);
  const ledger = (await call(`/royalty/ledger?from=2024-08&to=${BS_MONTH}&holderId=${partner.body.id}`)).body.byHolder.find((row) => row.holderId === partner.body.id);
  assert.equal(own(after).royaltyPayable - own(before).royaltyPayable, ledger.unpaidYen, `台帳の未払残 ${ledger.unpaidYen}・充当 ${ledger.recoupYen}`);
  assert.ok(own(after).royaltyPayable - own(before).royaltyPayable < 1000000, '充当で済んだ前払金3,000,000円が負債に残らない');
  assert.equal(own(after).royaltyAdvanceYen, 3000000);
  assert.equal(own(after).origin, 'unverified');
  assert.equal(after.companyBs.rows.find((row) => row.key === 'royalty_payable').origin, 'unverified');
  assert.equal(after.companyBs.reference.find((row) => row.key === 'royalty_advance_unrecouped').value, 3000000 - ledger.recoupYen);
  // 充当は現預金が減らないまま未払を減らすので、説明のつかない差額にその分が出る（前払金の支払の記録が無い）
  assert.equal(after.companyBs.difference - before.companyBs.difference, own(after).royaltyRecouped);
});
