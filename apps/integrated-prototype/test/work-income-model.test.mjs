// 作品の月別収支（/api/analytics/income）の計算（src/accounting/work-income/work-income-model.mjs）。DB を使わない。
// 期待値の出どころ: 配賦は docs/rules/money.md（最大剰余法・同点は作品IDの小さい順・内訳の和＝元の額・返品は売上の符号違い）、
// 月を0円で埋めないのは行動指標の計画 K2-1（埋めるかは画面が incomeRows の fillGaps で選ぶ）、
// 未配賦の案件経費を引かずに別に並べるのは test/agency-dashboard.test.mjs と同じ約束。
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkIncome, buildWorkIncomeCash, permittedWorkIds} from '../src/accounting/work-income/work-income-model.mjs';

// 架空の3作品（作品1・2は案件1、作品3は案件2）。見てよい案件は呼び出しごとに渡す
const works = [{id: 1, project_id: 1}, {id: 2, project_id: 1}, {id: 3, project_id: 2}];
const thirds = [
  {product_id: 7, work_id: 1, allocation_bps: 3333},
  {product_id: 7, work_id: 2, allocation_bps: 3333},
  {product_id: 7, work_id: 3, allocation_bps: 3334},
];
const sale = (id, fields) => ({id, project_id: 1, work_id: 1, product_id: null, accounting_month: '2026-03', amount_ex_tax: 0, tax_amount: 0, ...fields});
const expense = (fields) => ({project_id: 1, work_id: 1, accounting_month: '2026-03', actual_ex_tax: 0, tax_amount: 0, actual_inc_tax: 0, budget_yen: null, ...fields});
const input = (fields) => ({projectIds: [1, 2], works, sales: [], mappings: thirds, expenses: [], ...fields});
const byWork = (lines, key) => Object.fromEntries(lines.map((line) => [line.allocated_work_id, line[key]]));

test('見てよい作品は、見てよい案件に属する作品だけ', () => {
  assert.deepEqual([...permittedWorkIds(works, [1])].sort(), [1, 2]);
  assert.deepEqual([...permittedWorkIds(works, [])], []);
});

test('商品の配賦で売上を作品へ分ける: 税抜と税を別々に最大剰余法で分け、内訳の和は元の額。返品は売上の符号違い', () => {
  const result = buildWorkIncome(input({sales: [
    sale(1, {product_id: 7, amount_ex_tax: 10001, tax_amount: 1000}),
    sale(2, {product_id: 7, amount_ex_tax: -10001, tax_amount: -1000}),
  ]}));
  const first = result.allocatedLines.filter((line) => line.sale_id === 1);
  // 10001 × 33.33% = 3333.3333…、× 33.34% = 3334.3334…。足りない1円は余りの大きい作品3へ
  assert.deepEqual(byWork(first, 'amount_ex_tax'), {1: 3333, 2: 3333, 3: 3335});
  // 1000 × 33.33% = 333.3、× 33.34% = 333.4。足りない1円は作品3へ
  assert.deepEqual(byWork(first, 'tax_amount'), {1: 333, 2: 333, 3: 334});
  assert.deepEqual(byWork(first, 'amount_inc_tax'), {1: 3666, 2: 3666, 3: 3669});
  assert.deepEqual(byWork(first, 'allocation_bps'), {1: 3333, 2: 3333, 3: 3334});
  const returned = result.allocatedLines.filter((line) => line.sale_id === 2);
  assert.deepEqual(byWork(returned, 'amount_ex_tax'), {1: -3333, 2: -3333, 3: -3335});
  assert.deepEqual(result.sales, {exTax: 0, tax: 0, incTax: 0});
});

test('余りが同点なら、足りない1円は作品IDの小さい作品へ', () => {
  const halves = [{product_id: 8, work_id: 3, allocation_bps: 5000}, {product_id: 8, work_id: 2, allocation_bps: 5000}];
  const result = buildWorkIncome(input({mappings: halves, sales: [sale(1, {product_id: 8, amount_ex_tax: 1, tax_amount: 3})]}));
  assert.deepEqual(byWork(result.allocatedLines, 'amount_ex_tax'), {2: 1, 3: 0});
  assert.deepEqual(byWork(result.allocatedLines, 'tax_amount'), {2: 2, 3: 1});
});

test('配賦の無い明細は明細の作品へ全額。見てよくない作品と、絞った作品の外の分は出さない', () => {
  const sales = [sale(1, {product_id: 7, amount_ex_tax: 10001, tax_amount: 1000}), sale(2, {work_id: 2, amount_ex_tax: 500, tax_amount: 50})];
  const onlyProject1 = buildWorkIncome(input({projectIds: [1], sales}));
  assert.deepEqual(onlyProject1.allocatedLines.map((line) => [line.sale_id, line.allocated_work_id, line.amount_ex_tax]), [[1, 1, 3333], [1, 2, 3333], [2, 2, 500]]);
  assert.deepEqual(onlyProject1.sales, {exTax: 7166, tax: 716, incTax: 7882});
  const work2 = buildWorkIncome(input({sales, workFilter: 2}));
  assert.deepEqual(work2.allocatedLines.map((line) => [line.sale_id, line.amount_ex_tax, line.amount_inc_tax]), [[1, 3333, 3666], [2, 500, 550]]);
  assert.deepEqual(work2.filters, {month: null, workId: 2});
});

test('配賦の合計が100%でない商品は、分けずに止める', () => {
  const broken = [{product_id: 9, work_id: 1, allocation_bps: 6000}, {product_id: 9, work_id: 2, allocation_bps: 3000}];
  assert.throws(() => buildWorkIncome(input({mappings: broken, sales: [sale(1, {product_id: 9, amount_ex_tax: 100})]})), {message: '商品配賦が100%ではありません'});
});

test('月別の行は売上か経費のある月だけ: 経費だけの月と返品の月も出し、数字の無い月を0円で埋めない', () => {
  const result = buildWorkIncome(input({workFilter: 1,
    sales: [sale(1, {amount_ex_tax: 10000}), sale(2, {amount_ex_tax: -2000}), sale(3, {accounting_month: '2026-05', amount_ex_tax: -3000})],
    expenses: [expense({actual_ex_tax: 1000, actual_inc_tax: 1000}), expense({accounting_month: '2026-07', actual_ex_tax: 4000, actual_inc_tax: 4000})]}));
  assert.deepEqual(result.monthly, [
    {month: '2026-03', revenue: 8000, cost: 1000, profit: 7000},
    {month: '2026-05', revenue: -3000, cost: 0, profit: -3000},
    {month: '2026-07', revenue: 0, cost: 4000, profit: -4000},
  ]);
  assert.equal(result.profitExTax, 0);
  assert.deepEqual(buildWorkIncome(input({workFilter: 1})).monthly, []);
  // 月は古い順。経費だけの月が売上の最初の月より前でも、その月を先に置く（画面のグラフは並びのまま描く）
  const earlier = buildWorkIncome(input({workFilter: 1,
    sales: [sale(1, {accounting_month: '2026-03', amount_ex_tax: 5000})],
    expenses: [expense({accounting_month: '2026-04', actual_ex_tax: 100, actual_inc_tax: 100}), expense({accounting_month: '2026-02', actual_ex_tax: 600, actual_inc_tax: 600})]}));
  assert.deepEqual(earlier.monthly, [
    {month: '2026-02', revenue: 0, cost: 600, profit: -600},
    {month: '2026-03', revenue: 5000, cost: 0, profit: 5000},
    {month: '2026-04', revenue: 0, cost: 100, profit: -100},
  ]);
});

test('作品に配っていない案件の経費は差し引かず別に並べる。見てよくない案件の経費は出さない', () => {
  const unallocated = expense({id: 11, work_id: null, actual_ex_tax: 9000, actual_inc_tax: 9900, tax_amount: 900});
  const result = buildWorkIncome(input({projectIds: [1], workFilter: 1, expenses: [
    expense({id: 10, actual_ex_tax: 300, tax_amount: 30, actual_inc_tax: 330, budget_yen: 1000}),
    unallocated,
    expense({id: 12, project_id: 2, work_id: 3, actual_ex_tax: 700, actual_inc_tax: 700}),
    expense({id: 13, project_id: 2, work_id: null, actual_ex_tax: 800, actual_inc_tax: 800}),
  ]}));
  assert.deepEqual(result.expenses, {exTax: 300, tax: 30, incTax: 330, budget: 1000});
  assert.deepEqual(result.unallocatedProjectExpenses, [unallocated]);
  assert.equal(result.profitExTax, -300);
  // 作品で絞らないときは、見てよい案件の経費をすべて足し、未配賦の行も別に並べる。見てよくない案件2の経費
  // （作品3の行と未配賦の行）は、合計・予算・月別・未配賦の一覧のどれにも入らない
  const all = buildWorkIncome(input({projectIds: [1], expenses: [
    expense({id: 20, actual_ex_tax: 300, tax_amount: 30, actual_inc_tax: 330}),
    unallocated,
    expense({id: 21, project_id: 2, work_id: 3, actual_ex_tax: 700, actual_inc_tax: 700, budget_yen: 500}),
    expense({id: 22, project_id: 2, work_id: null, accounting_month: '2026-04', actual_ex_tax: 800, actual_inc_tax: 800}),
  ]}));
  assert.deepEqual(all.expenses, {exTax: 9300, tax: 930, incTax: 10230, budget: 0});
  assert.deepEqual(all.monthly, [{month: '2026-03', revenue: 0, cost: 9300, profit: -9300}]);
  assert.deepEqual(all.unallocatedProjectExpenses, [unallocated]);
  assert.equal(all.profitExTax, -9300);
});

test('作品で絞ったときの未配賦の経費は、その作品の案件の分だけを並べ、ほかの見てよい案件の未配賦は並べない', () => {
  const ownProject = expense({id: 30, project_id: 1, work_id: null, actual_ex_tax: 400, actual_inc_tax: 400});
  const otherProject = expense({id: 31, project_id: 2, work_id: null, actual_ex_tax: 500, actual_inc_tax: 500});
  const work1 = buildWorkIncome(input({projectIds: [1, 2], workFilter: 1, expenses: [ownProject, otherProject]}));
  assert.deepEqual(work1.unallocatedProjectExpenses, [ownProject]);
  const work3 = buildWorkIncome(input({projectIds: [1, 2], workFilter: 3, expenses: [ownProject, otherProject]}));
  assert.deepEqual(work3.unallocatedProjectExpenses, [otherProject]);
  // どちらも作品の経費ではないので、合計からは引かない
  assert.deepEqual(work1.expenses, {exTax: 0, tax: 0, incTax: 0, budget: 0});
});

test('合計が安全な整数を超えたら、丸めずに止める', () => {
  const huge = [sale(1, {amount_ex_tax: Number.MAX_SAFE_INTEGER}), sale(2, {amount_ex_tax: 1})];
  assert.throws(() => buildWorkIncome(input({sales: huge})), {message: '集計金額が試作の整数範囲を超えています'});
});

// 入金ベース（buildWorkIncomeCash）の作品を決められない入金。請求明細の作品の配賦が100%にそろわない消込は、額をほかの作品と分けられないので
// 作品で絞った応答の行に入れず、件数（unattachedReceiptCount）だけを返す（作品の月別収支の画面は常に作品で絞るので、件数が無いと黙って消える）。
// 期待値の出どころ: 計画の「計上と入金」（税抜にできない入金は U-5 まで「未確定」）と、作品別収支の unattachedReceiptCount（work-pnl-cash-model.mjs）と同じ数え方
const cashInput = (fields) => ({projectIds: [1, 2], works, expenses: [], ...fields});
// 請求10: 請求明細の配賦が作品1の60%だけ（そろわない）。請求11: 作品1の50%と作品3の40%（そろわない。作品3は案件2）。
// 請求12: 作品1に100%（そろう）で、請求額（3,300）と違う額の入金。請求10の入金は 2026-06-02 に取り消した
const brokenSide = {
  invoiceLines: [
    {invoiceId: 10, saleId: 100, exTax: 1000, workId: 1, bps: 6000},
    {invoiceId: 11, saleId: 110, exTax: 2000, workId: 1, bps: 5000},
    {invoiceId: 11, saleId: 110, exTax: 2000, workId: 3, bps: 4000},
    {invoiceId: 12, saleId: 120, exTax: 3000, workId: 1, bps: 10000},
  ],
  receiptAllocations: [
    {receiptId: 1, invoiceId: 10, amount: 1100, invoiceIncTax: 1100, receivedOn: '2026-05-10', reversedOn: '2026-06-02'},
    {receiptId: 2, invoiceId: 11, amount: 2200, invoiceIncTax: 2200, receivedOn: '2026-05-11', reversedOn: null},
    {receiptId: 3, invoiceId: 12, amount: 3000, invoiceIncTax: 3300, receivedOn: '2026-05-12', reversedOn: null},
  ],
  expensePayments: [],
};
const rowsOf = (result) => result.unsettled.rows.map((row) => [row.receiptId, row.workId, row.amount]);

test('入金ベース: 作品で絞ると、作品を決められない入金は行に入れず、その作品を含む入金の件数を返す（取消の行があっても1件。月で絞るとその月の分）', () => {
  const work1 = buildWorkIncomeCash(cashInput({cashSide: brokenSide, workFilter: 1}));
  assert.deepEqual(work1.monthly, []);
  assert.deepEqual(rowsOf(work1), [[3, 1, 3000]], '作品を決められる未確定（請求12）だけが行');
  assert.equal(work1.unsettled.unattachedReceiptCount, 2, '請求10（取消を含む）と請求11の入金');
  assert.deepEqual([work1.unsettled.inflowYen, work1.sales.exTax], [3000, 0], '作品を決められない入金の額はどこにも足さない');
  const work2 = buildWorkIncomeCash(cashInput({cashSide: brokenSide, workFilter: 2}));
  assert.deepEqual([rowsOf(work2), work2.unsettled.unattachedReceiptCount], [[], 0], '請求明細に作品2の配賦の無い入金は数えない');
  const june = buildWorkIncomeCash(cashInput({cashSide: brokenSide, workFilter: 1, monthFilter: '2026-06'}));
  assert.deepEqual([rowsOf(june), june.unsettled.unattachedReceiptCount], [[], 1], '6月は請求10の取消だけ');
});

test('入金ベース: 作品で絞らないと、請求の作品が全部見てよい作品の入金は作品を付けない行に入れ、見てよくない作品を含む入金は件数だけ返す', () => {
  const all = buildWorkIncomeCash(cashInput({cashSide: brokenSide}));
  assert.deepEqual(rowsOf(all), [[1, null, 1100], [2, null, 2200], [3, 1, 3000], [1, null, -1100]]);
  assert.equal(all.unsettled.unattachedReceiptCount, 0);
  const project1 = buildWorkIncomeCash(cashInput({cashSide: brokenSide, projectIds: [1]}));
  assert.deepEqual(rowsOf(project1), [[1, null, 1100], [3, 1, 3000], [1, null, -1100]], '請求11は作品3（案件2）の額が混ざるので行に入れない');
  assert.equal(project1.unsettled.unattachedReceiptCount, 1);
  const project2 = buildWorkIncomeCash(cashInput({cashSide: brokenSide, projectIds: [2]}));
  assert.deepEqual([rowsOf(project2), project2.unsettled.unattachedReceiptCount], [[], 1], '作品3を含む請求11だけを数え、作品1だけの請求10は数えない');
});
