// 計上と入金の切り替え（フェーズ1の仕様書 #16）と、入金ベースの税抜換算（src/reports/pl-bs-cash-model.mjs）の試験。
// 期待値の出どころ: 計画の「計上と入金（全画面で同じ）」（basis=accrual|cash、既定は計上。売上は入金日・経費は出金日。取消は取消日の月に負の額。
// BS は入金ベースを作らない）、K-16 と U-5（入金の税抜の出し方は未決で、決まるまで源泉のある入金は「未確定」の行に出し 0円で埋めない）、
// 要件 FR-REV-YOJITSU-032 の仮の出し方（請求どおりの額で入った入金だけを請求明細の税抜額で税抜にする）、docs/rules/money.md の配賦（最大剰余法）。
// 金額は下の架空の行から手で計算した値（コメントに書き下した）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBasis, basisFields, BASES, cashReceiptParts, cashExpenseParts, cashRoyaltyParts, buildPlBsForBasis, UNSETTLED_REASONS,
} from '../src/reports/pl-bs-cash-model.mjs';
import {buildPlBs, DEFAULT_ACCOUNTS, checksOk} from '../src/reports/pl-bs-model.mjs';

test('基準の引数: 無ければ既定（計上。会社の帳票は呼び出し側が入金を渡す）、accrual・cash だけを受け、ほかの値は誤りで既定に埋めない', () => {
  assert.deepEqual(BASES, ['accrual', 'cash']);
  assert.deepEqual(parseBasis(undefined), {ok: true, basis: 'accrual'});
  assert.deepEqual(parseBasis(''), {ok: true, basis: 'accrual'});
  assert.deepEqual(parseBasis(undefined, {defaultBasis: 'cash'}), {ok: true, basis: 'cash'});
  assert.deepEqual(parseBasis('cash'), {ok: true, basis: 'cash'});
  assert.deepEqual(parseBasis('accrual', {defaultBasis: 'cash'}), {ok: true, basis: 'accrual'});
  for (const raw of ['accounting', 'sales', 'CASH', ' cash']) {
    const read = parseBasis(raw);
    assert.equal(read.ok, false, raw);
    assert.match(read.error, /accrual（計上）か cash（入金）/);
  }
  assert.deepEqual(basisFields('cash'), {basis: 'cash', basisLabel: '入金', basisDescription: '入金（売上は入金日・経費は出金日の月・税抜。税抜にできない入出金は未確定）'});
  assert.equal(basisFields('accrual').basisLabel, '計上');
  assert.throws(() => basisFields('accounting'), /基準/);
});

// 請求10: 売上明細100（税抜10,000・作品1へ全部）と101（税抜3,001・作品1へ60%・作品2へ40%）、税込14,301。
// 請求11: 売上明細102（税抜50,000・税込55,000・作品2）。請求12: 売上明細103（作品の配賦が50%しかない）
const SIDE = {
  invoiceLines: [
    {invoiceId: 10, saleId: 100, exTax: 10000, incTax: 11000, workId: 1, bps: 10000},
    {invoiceId: 10, saleId: 101, exTax: 3001, incTax: 3301, workId: 1, bps: 6000},
    {invoiceId: 10, saleId: 101, exTax: 3001, incTax: 3301, workId: 2, bps: 4000},
    {invoiceId: 11, saleId: 102, exTax: 50000, incTax: 55000, workId: 2, bps: 10000},
    {invoiceId: 12, saleId: 103, exTax: 2000, incTax: 2200, workId: 1, bps: 5000},
  ],
  receiptAllocations: [
    {receiptId: 1, invoiceId: 10, amount: 14301, invoiceIncTax: 14301, receivedOn: '2026-05-20', reversedOn: '2026-06-03'},
    {receiptId: 2, invoiceId: 11, amount: 49895, invoiceIncTax: 55000, receivedOn: '2026-05-31', reversedOn: null},
    {receiptId: 3, invoiceId: 12, amount: 2200, invoiceIncTax: 2200, receivedOn: '2026-06-10', reversedOn: null},
  ],
};

test('請求の入金: 請求どおりの額は請求明細の税抜額を作品の配賦（最大剰余法）で分けて確定、取消は取消日の月に負の額', () => {
  const {settled} = cashReceiptParts(SIDE);
  // 明細101 の 3,001 を 60:40 → 1,800.6 と 1,200.4。切り捨て 1,800・1,200 で残り1円は余りの大きい作品1へ → 1,801・1,200
  assert.deepEqual(settled.map(({workId, saleId, bps, month, amount, receiptId}) => ({workId, saleId, bps, month, amount, receiptId})), [
    {workId: 1, saleId: 100, bps: 10000, month: '2026-05', amount: 10000, receiptId: 1},
    {workId: 1, saleId: 100, bps: 10000, month: '2026-06', amount: -10000, receiptId: 1},
    {workId: 1, saleId: 101, bps: 6000, month: '2026-05', amount: 1801, receiptId: 1},
    {workId: 1, saleId: 101, bps: 6000, month: '2026-06', amount: -1801, receiptId: 1},
    {workId: 2, saleId: 101, bps: 4000, month: '2026-05', amount: 1200, receiptId: 1},
    {workId: 2, saleId: 101, bps: 4000, month: '2026-06', amount: -1200, receiptId: 1},
  ]);
  assert.equal(settled.filter((row) => row.month === '2026-05').reduce((n, row) => n + row.amount, 0), 14301 - 1300, '税抜の和は請求の税抜（10,000＋3,001）');
});

test('請求の入金: 請求額と違う額（源泉など）は税抜にせず税込のまま未確定、作品の配賦がそろわない消込は作品を決めずに未確定', () => {
  const {settled, unsettled} = cashReceiptParts(SIDE);
  assert.equal(settled.some((row) => row.receiptId === 2 || row.receiptId === 3), false, '未確定の入金は確定に入れない（0円にもしない）');
  assert.deepEqual(unsettled.map(({workId, workIds, month, amount, reason, receiptId}) => ({workId, workIds, month, amount, reason, receiptId})), [
    {workId: 2, workIds: [2], month: '2026-05', amount: 49895, reason: 'receipt_amount_differs', receiptId: 2},
    {workId: null, workIds: [1], month: '2026-06', amount: 2200, reason: 'receipt_allocation_incomplete', receiptId: 3},
  ]);
  assert.ok(UNSETTLED_REASONS.receipt_amount_differs.note.includes('U-5'));
});

test('請求の入金: 複数の作品にまたがる請求額と違う入金は、税込の額を作品の税抜額の比で分ける（和は入金の額）', () => {
  const {unsettled} = cashReceiptParts({invoiceLines: SIDE.invoiceLines, receiptAllocations: [{receiptId: 9, invoiceId: 10, amount: 13000, invoiceIncTax: 14301, receivedOn: '2026-07-01'}]});
  // 作品1 の税抜 11,801・作品2 の税抜 1,200（和 13,001）の比で 13,000 を分ける: 11,800.09…→11,800、1,199.90…→1,199。残り1円は余りの大きい作品2へ
  assert.deepEqual(unsettled.map(({workId, amount}) => ({workId, amount})), [{workId: 1, amount: 11800}, {workId: 2, amount: 1200}]);
});

test('経費の出金: 出金＋源泉の控除が税込額と同じ（払い切った）出金だけを経費の税抜で確定、分割の出金は出金の額のまま未確定、取消は負', () => {
  const expenses = [
    {id: 1, exTax: 100000, incTax: 110000, workId: 1},
    {id: 2, exTax: 50000, incTax: 55000, workId: 1},
    {id: 3, exTax: 100000, incTax: 110000, workId: null},
    {id: 4, exTax: 3000, incTax: 3300, workId: 2},
  ];
  const payments = [
    {id: 11, expenseId: 1, paidOn: '2026-05-31', amount: 110000, withheld: 0, reversesId: null},
    {id: 12, expenseId: 2, paidOn: '2026-05-10', amount: 30000, withheld: 0, reversesId: null},
    {id: 13, expenseId: 2, paidOn: '2026-06-10', amount: 25000, withheld: 0, reversesId: null},
    {id: 14, expenseId: 3, paidOn: '2026-06-30', amount: 99790, withheld: 10210, reversesId: null}, // 源泉を控除して払い切った
    {id: 15, expenseId: 1, paidOn: '2026-06-15', amount: -110000, withheld: 0, reversesId: 11}, // 11 の取消
    {id: 16, expenseId: 4, paidOn: '2026-07-01', amount: 3300, withheld: null, reversesId: null}, // 会計の確認が無い出金（源泉の記録なし）でも全額
    {id: 17, expenseId: 99, paidOn: '2026-07-01', amount: 5, withheld: 0, reversesId: null}, // 見えない経費
  ];
  const {settled, unsettled} = cashExpenseParts({expenses, payments});
  assert.deepEqual(settled.map((row) => [row.expense.id, row.paymentId, row.month, row.exTax, row.amount]), [
    [1, 11, '2026-05', 100000, 110000], [3, 14, '2026-06', 100000, 99790], [1, 15, '2026-06', -100000, -110000], [4, 16, '2026-07', 3000, 3300],
  ]);
  assert.deepEqual(unsettled.map((row) => [row.expense.id, row.paymentId, row.month, row.amount, row.reason]), [
    [2, 12, '2026-05', 30000, 'expense_amount_differs'], [2, 13, '2026-06', 25000, 'expense_amount_differs'],
  ]);
});

test('ロイヤリティの支払: 報告書の明細の和（充当を引いた額）と同じなら作品ごとに確定、違う額（税込など）は明細の比で分けて未確定', () => {
  const weights = [{workId: 1, weight: 3000, net: 3000}, {workId: 2, weight: 2000, net: 2000}];
  const {settled, unsettled} = cashRoyaltyParts([
    {statementId: 1, paidOn: '2026-05-31', amount: 5000, weights},
    {statementId: 1, paidOn: '2026-06-05', amount: -5000, weights}, // 取消
    {statementId: 2, paidOn: '2026-06-30', amount: 5500, weights}, // 消費税を含む支払
    {statementId: 3, paidOn: '2026-06-30', amount: 800, weights: [{workId: 1, weight: 0, net: -200}, {workId: 2, weight: 1000, net: 1000}]}, // 明細に負がある
    {statementId: 4, paidOn: '2026-06-30', amount: 70, weights: []}, // 作品に分けられない
  ]);
  assert.deepEqual(settled.map((row) => [row.statementId, row.workId, row.month, row.amount]), [[1, 1, '2026-05', 3000], [1, 2, '2026-05', 2000], [1, 1, '2026-06', -3000], [1, 2, '2026-06', -2000]]);
  assert.deepEqual(unsettled.map((row) => [row.statementId, row.workId, row.amount]), [[2, 1, 3300], [2, 2, 2200], [3, 2, 800], [4, null, 70]]);
});

// PL・BS の入金ベース。自社作品 A（公開 2026-03）と委員会作品 C。期間 2026-01〜03、期首の基準月 2025-12
const ACCOUNTS = DEFAULT_ACCOUNTS.map((row, index) => ({...row, id: index + 1}));
const acc = (code) => ACCOUNTS.find((row) => row.code === code).id;
const SELF = 9;
function plInput() {
  const expense = (id, workId, month, systemKey, code, section, timing, exTax, incTax) => ({id, workId, projectId: 1, month, category: '架空の費目', accountId: acc(code), accountName: '架空の科目',
    systemKey, section, recognitionTiming: timing, exTax, tax: incTax - exTax, incTax});
  return {
    from: '2026-01', to: '2026-03', asOf: '2026-03',
    fiscal: {fiscalStartMonth: 5, confirmed: true},
    profile: {selfPartnerId: SELF, openingMonth: '2025-12'},
    accounts: ACCOUNTS,
    works: [
      {id: 1, code: 'A', title: '作品A（架空）', committee: false, releaseMonth: '2026-03', releaseSource: 'window'},
      {id: 3, code: 'C', title: '作品C（委員会・架空）', committee: true},
    ],
    saleLines: [
      {saleId: 1, workId: 1, month: '2026-02', amount: 1000, tax: 100, channelGroup: 'theatrical'},
      {saleId: 2, workId: 1, month: '2026-03', amount: 500, tax: 50, channelGroup: 'digital'},
    ],
    expenses: [
      expense(1, 1, '2026-01', 'production_cost', '5300', 'cogs', 'release_month_once', 500, 550),
      expense(3, 1, '2026-02', 'promotion', '6100', 'sga', 'incurred_month', 200, 220),
      expense(6, 3, '2026-02', 'promotion', '6100', 'sga', 'incurred_month', 300, 330), // 委員会の経費
      {...expense(7, null, '2026-03', 'work_other_expense', '6150', 'sga', 'incurred_month', 70, 77), workId: null},
    ],
    expensePayments: [
      {id: 1, expenseId: 1, paidOn: '2026-02-10', amount: 550},
      {id: 2, expenseId: 3, paidOn: '2026-03-05', amount: 100},
      {id: 3, expenseId: 7, paidOn: '2026-03-31', amount: 77},
      {id: 4, expenseId: 6, paidOn: '2026-03-31', amount: 330},
    ],
    royaltyAccruals: [{workId: 1, month: '2026-02', royaltyYen: 50, holdSalesYen: 0}],
    royaltyPayments: [{statementId: 1, paidOn: '2026-03-31', amount: 50, weights: [{workId: 1, weight: 50, net: 50}]}],
    committee: [{workId: 3, contractId: 1, committedYen: 2000, selfShareBps: 5000, acquisitions: [{month: '2026-02', distribution: 100, windowFee: 20, managerFee: 10, acquisition: 130}]}],
    investmentPayments: [{workId: 3, partnerId: SELF, paidOn: '2026-01-15', amount: 1000}, {workId: 3, partnerId: 7, paidOn: '2026-01-15', amount: 500}],
    committeeReceipts: [{workId: 3, receivedOn: '2026-03-20', amount: 100}],
    receipts: [
      {receiptId: 1, invoiceId: 1, receivedOn: '2026-03-31', amount: 1100, weights: [{workId: 1, weight: 1100}]},
      {receiptId: 2, invoiceId: 2, receivedOn: '2026-03-15', amount: 500, weights: [{workId: 1, weight: 550}]},
    ],
    manual: [
      {id: 1, accountId: acc('1100'), month: '2025-12', kind: 'balance', amount: 10000, status: 'reviewed'},
      {id: 2, accountId: acc('3100'), month: '2025-12', kind: 'balance', amount: 10000, status: 'reviewed'},
      ...['2026-01', '2026-02', '2026-03'].map((month, k) => ({id: 10 + k, accountId: acc('6240'), month, kind: 'flow', amount: 100, status: 'reviewed'})),
    ],
    mg: [],
    cashSide: {
      receiptAllocations: [
        {receiptId: 1, invoiceId: 1, amount: 1100, invoiceIncTax: 1100, receivedOn: '2026-03-31', reversedOn: null},
        {receiptId: 2, invoiceId: 2, amount: 500, invoiceIncTax: 550, receivedOn: '2026-03-15', reversedOn: null}, // 源泉などで請求額と違う
      ],
      invoiceLines: [{invoiceId: 1, saleId: 1, exTax: 1000, incTax: 1100, workId: 1, bps: 10000}, {invoiceId: 2, saleId: 2, exTax: 500, incTax: 550, workId: 1, bps: 10000}],
      expensePayments: [
        {id: 1, expenseId: 1, paidOn: '2026-02-10', amount: 550, withheld: 0, reversesId: null},
        {id: 2, expenseId: 3, paidOn: '2026-03-05', amount: 100, withheld: null, reversesId: null},
        {id: 3, expenseId: 7, paidOn: '2026-03-31', amount: 77, withheld: 0, reversesId: null},
        {id: 4, expenseId: 6, paidOn: '2026-03-31', amount: 330, withheld: 0, reversesId: null},
      ],
    },
  };
}

test('PL の入金ベース: 売上は入金日・経費は出金日・制作費は払った月で、税抜にできない入出金は未確定の行に出して利益に入れない', () => {
  const report = buildPlBsForBasis(plInput(), 'cash');
  assert.equal(report.basis, 'cash');
  assert.equal(report.conditions.basis, 'cash');
  const a = report.workPl.find((row) => row.workId === 1);
  // 作品A: 売上は入金1（3月・請求どおり）の税抜 1,000。入金2（請求 550 に 500）は未確定。制作費は2月に払った 500（公開月の3月に一括にしない）。
  // 広告宣伝費は分割の出金（100）なので未確定。ロイヤリティは3月の支払 50（報告書どおり）
  assert.deepEqual(a.monthly.map((m) => [m.month, m.sales, m.production, m.promotion, m.royalty, m.profit]), [
    ['2026-01', 0, 0, 0, 0, 0], ['2026-02', 0, 500, 0, 0, -500], ['2026-03', 1000, 0, 0, 50, 950],
  ]);
  assert.equal(a.period.profit, 450);
  assert.deepEqual(a.unsettled, {inflow: {period: 500, cumulative: 500}, outflow: {period: 100, cumulative: 100}});
  assert.equal(a.origin, 'unverified');
  assert.ok(a.reasons.some((r) => r.includes('未確定') && r.includes('請求額と違う額の入金') && r.includes('経費の税込額と違う額の出金')), a.reasons.join('／'));
  // 委員会作品C: 自社の売上（取得額）は入金ベースでは数えず、受取 100 と出資の払込 1,000（自社の分だけ）は未確定。委員会の経費の出金は自社の PL に出さない
  const c = report.workPl.find((row) => row.workId === 3);
  assert.equal(c.period.revenue, 0);
  assert.deepEqual(c.unsettled, {inflow: {period: 100, cumulative: 100}, outflow: {period: 1000, cumulative: 1000}});
  assert.equal(report.unsettled.rows.some((row) => row.kind === 'expense' && row.workId === 3), false);
  // 会社PL: 作品の利益 450 − 作品に付かない経費 70 − 家賃 300 = 80。未確定の行は利益に入れず、期間計を別に出す
  const rows = Object.fromEntries(report.companyPl.rows.map((row) => [row.key, row]));
  assert.equal(rows.netIncome.values.period, 80);
  assert.equal(rows.production_cost.label, '制作費（払った月）');
  assert.equal(rows.production_cost.values['m:2026-02'], 500);
  assert.equal(rows['unsettled:in'].values.period, 600);
  assert.equal(rows['unsettled:out'].values.period, 1100);
  assert.equal(rows['unsettled:in'].excluded, true);
  assert.equal(rows['unsettled:in:receipt_amount_differs'].values['m:2026-03'], 500);
  assert.equal(rows['unsettled:out:investment_payment'].values['m:2026-01'], 1000);
  // 確定した額だけの利益なので、未確定の入出金がある期間は利益の行と売上高・委員会の取得額・ロイヤリティを未確定と出す
  assert.deepEqual(['grossProfit', 'netIncome', 'own_sales', 'committee_share'].map((key) => rows[key].origin), ['unverified', 'unverified', 'unverified', 'unverified']);
  assert.equal(rows.royalty.origin, 'system', 'ロイヤリティの支払は報告書どおり（未確定なし）');
  const detail = report.workDetail[1];
  assert.equal(detail.rows.find((row) => row.key === 'production').label, '制作費（払った月）');
  assert.equal(detail.rows.find((row) => row.key === 'royalty').label, 'ロイヤリティの支払');
  assert.deepEqual(detail.rows.find((row) => row.key === 'unsettled:in').values, {'m:2026-01': 0, 'm:2026-02': 0, 'm:2026-03': 500, period: 500, cumulative: 500});
  assert.ok(checksOk(report.checks), JSON.stringify(report.checks.filter((row) => !row.ok)));
  assert.ok(report.checks.some((row) => row.item.startsWith('未確定の入出金')));
  assert.ok(report.headingNotes[0].startsWith('入金ベースのPL'));
});

test('PL の基準を切り替えても BS（作品別の残高・会社BS・BS の照合）は同じで、計上は従来の計算と同じ', () => {
  const input = plInput();
  const plain = buildPlBs(input);
  const accrual = buildPlBsForBasis(input, 'accrual');
  const cash = buildPlBsForBasis(input, 'cash');
  assert.equal(accrual.basis, 'accrual');
  assert.equal(accrual.unsettled, null);
  assert.deepEqual(accrual.workPl, plain.workPl);
  assert.deepEqual(accrual.companyPl, plain.companyPl);
  // 計上: 作品Aの制作費は公開月（3月）に一括、売上は計上月（2月 1,000・3月 500）
  const a = accrual.workPl.find((row) => row.workId === 1);
  assert.deepEqual(a.monthly.map((m) => [m.month, m.sales, m.production]), [['2026-01', 0, 0], ['2026-02', 1000, 0], ['2026-03', 500, 500]]);
  assert.deepEqual(cash.workBalances, accrual.workBalances);
  assert.deepEqual(cash.companyBs, accrual.companyBs);
  assert.deepEqual(cash.checks.filter((row) => row.part === 'bs'), accrual.checks.filter((row) => row.part === 'bs'));
  assert.notDeepEqual(cash.companyPl, accrual.companyPl);
});

test('入金ベースの PL: 見えない作品の入出金は作品にも会社にも入れず、作品に付かない未確定は作品に付けない', () => {
  const input = plInput();
  input.works = input.works.filter((work) => work.id === 1);
  input.cashSide.receiptAllocations.push({receiptId: 5, invoiceId: 5, amount: 300, invoiceIncTax: 300, receivedOn: '2026-03-01', reversedOn: null});
  input.cashSide.invoiceLines.push({invoiceId: 5, saleId: 5, exTax: 300, incTax: 300, workId: 8, bps: 10000}); // 見えない作品8
  input.cashSide.receiptAllocations.push({receiptId: 6, invoiceId: 6, amount: 40, invoiceIncTax: 40, receivedOn: '2026-03-02', reversedOn: null});
  input.cashSide.invoiceLines.push({invoiceId: 6, saleId: 6, exTax: 40, incTax: 40, workId: 1, bps: 5000}); // 配賦がそろわない
  const report = buildPlBsForBasis(input, 'cash');
  assert.deepEqual(report.workPl.map((row) => row.workId), [1]);
  assert.equal(report.workPl[0].period.sales, 1000, '見えない作品8の入金は入れない');
  const unattached = report.unsettled.rows.filter((row) => row.workId === null);
  assert.deepEqual(unattached.map((row) => [row.kind, row.amount, row.reason]), [['receipt', 40, 'receipt_allocation_incomplete']]);
  assert.equal(report.workPl[0].unsettled.inflow.period, 500, '作品を決められない入金は作品の未確定に入れない');
  assert.ok(checksOk(report.checks));
});

test('入金ベースの PL: 未確定の入出金が無い期間は、利益の行を未確定にしない（未確定の行は0円で残す）', () => {
  const input = plInput();
  input.cashSide.receiptAllocations = input.cashSide.receiptAllocations.filter((row) => row.receiptId === 1);
  input.cashSide.expensePayments = input.cashSide.expensePayments.filter((row) => row.id !== 2);
  input.committeeReceipts = [];
  input.investmentPayments = [];
  const report = buildPlBsForBasis(input, 'cash');
  const rows = Object.fromEntries(report.companyPl.rows.map((row) => [row.key, row]));
  assert.equal(rows.netIncome.origin, 'manual', '手入力（家賃）があるので手入力。未確定にはしない');
  assert.equal(rows.own_sales.origin, 'system');
  assert.deepEqual([rows['unsettled:in'].values.period, rows['unsettled:out'].values.period], [0, 0]);
  assert.equal(report.workPl.find((row) => row.workId === 1).origin, 'system');
});

test('知らない基準は PL を作らずに止める', () => {
  assert.throws(() => buildPlBsForBasis(plInput(), 'accounting'), /基準/);
});
