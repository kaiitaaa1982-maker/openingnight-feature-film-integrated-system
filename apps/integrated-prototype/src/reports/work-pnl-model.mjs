// 作品別収支（正式版）の集計。DB に依存しない純関数で、サーバーの帳票 API・画面・試験が使う。
// 入力の売上明細（line）は /api/reports/annual-sales と同じ配賦で作品へ割り当て済み（計上月・税抜）:
//   {id, month, amount, distribution_code, distribution_label, deal_label, partner_name, ...}
// 経費（expense）は作品に直接付いたものだけを作品計に入れ、作品の決まっていない案件の経費（未配賦）は別表にする。
// 制作費: 費用区分で公開月一括を指定した経費は、作品の経費として計上月で差し引いている。
// 作品別PL（管理会計の試算）は同じ額を公開月に一括で費用にするので、月ごとの差額は作品別PLと一致しない。案件の予算は差し引かない。
// 経費には流通の区分が無いので、流通別カードの経費は「流通別の記録なし」とし、作品の経費は「流通に紐づかない経費」の
// カードにまとめる（カードの差額の和＝作品計の差額）。



const bigSum = (values) => {
  const n = values.reduce((acc, value) => acc + BigInt(value || 0), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('金額合計が安全な整数範囲外です');
  return Number(n);
};

// 期間の作品の経費のうち公開月一括の費用区分の額と説明。計算（差額＝売上−作品の全経費）は変えない
export function productionCostOf(expenses = []) {
  const rows = expenses.filter((expense) => expense.expense_recognition_timing === 'release_month_once');
  if (!rows.length) {
    return {status: 'none', amount: 0, count: 0, months: [], label: '制作費: この期間の経費なし',
      note: 'この期間に公開月一括の費用区分の経費はありません。案件の予算は差し引きません。'};
  }
  return {status: 'included', amount: bigSum(rows.map((row) => row.actual_ex_tax)), count: rows.length,
    months: [...new Set(rows.map((row) => row.accounting_month))].sort(), label: '制作費（会計の費用区分）',
    note: '費用区分で公開月一括を指定した経費を、計上月で差し引いています（経費に含む）。作品別PL（管理会計の試算）は同じ額を公開月に一括で費用にするため、月ごとの差額は作品別PLと一致しません。案件の予算は差し引きません。'};
}

export const OUT_OF_SCOPE_NOTE = '支出の部（科目別の小計）と分配の部（分配方式・出資者別の支払状況）は、この帳票の範囲外です。分配は「製作委員会収支報告」「ロイヤリティ報告書」で確かめてください。';

export const EXPENSE_ONLY_CARD = '流通に紐づかない経費';

export function buildWorkPnl({lines = [], expenses = [], unallocatedExpenses = [], months = []}) {
  const monthIndex = new Map(months.map((month, index) => [month, index]));
  const salesByMonth = months.map(() => []);
  const expenseByMonth = months.map(() => []);
  const groups = new Map();
  let counted = 0;
  for (const line of lines) {
    const index = monthIndex.get(line.month);
    if (index === undefined) continue;
    counted += 1;
    salesByMonth[index].push(line.amount);
    const code = line.distribution_code || 'other';
    if (!groups.has(code)) {
      groups.set(code, {code, label: line.distribution_label || '未確認', amounts: [], byMonth: months.map(() => []), deals: new Set(), partners: new Set(), lineCount: 0});
    }
    const group = groups.get(code);
    group.amounts.push(line.amount);
    group.byMonth[index].push(line.amount);
    group.lineCount += 1;
    if (line.deal_label) group.deals.add(line.deal_label);
    if (line.partner_name) group.partners.add(line.partner_name);
  }
  const inRangeExpenses = expenses.filter((expense) => monthIndex.has(expense.accounting_month));
  for (const expense of inRangeExpenses) expenseByMonth[monthIndex.get(expense.accounting_month)].push(expense.actual_ex_tax);

  const distributions = [...groups.values()].map((group) => ({
    code: group.code, label: group.label, sales: bigSum(group.amounts), byMonth: group.byMonth.map(bigSum), lineCount: group.lineCount,
    deals: [...group.deals].sort(), partners: [...group.partners].sort((a, b) => a.localeCompare(b, 'ja')),
  })).sort((a, b) => b.sales - a.sales || a.label.localeCompare(b.label, 'ja'));
  const distributionSales = new Map(distributions.map((d) => [d.code, d.byMonth]));

  const monthly = months.map((month, index) => {
    const sales = bigSum(salesByMonth[index]);
    const expense = bigSum(expenseByMonth[index]);
    return {month, sales, expense, balance: sales - expense,
      byDistribution: Object.fromEntries([...distributionSales].map(([code, values]) => [code, values[index]]))};
  });
  const totals = {sales: bigSum(monthly.map((row) => row.sales)), expense: bigSum(monthly.map((row) => row.expense))};
  totals.balance = totals.sales - totals.expense;
  const productionCost = productionCostOf(inRangeExpenses);

  const cards = distributions.map((d) => ({kind: 'distribution', code: d.code, label: d.label, sales: d.sales, expense: 0, expenseLinked: false,
    balance: d.sales, lineCount: d.lineCount, deals: d.deals, partners: d.partners}));
  if (inRangeExpenses.length) {
    cards.push({kind: 'expense-only', code: null, label: EXPENSE_ONLY_CARD, sales: 0, expense: totals.expense, expenseLinked: true,
      balance: -totals.expense, lineCount: 0, expenseCount: inRangeExpenses.length, deals: [], partners: []});
  }

  const unallocatedRows = unallocatedExpenses.filter((expense) => monthIndex.has(expense.accounting_month));
  const unallocated = {rows: unallocatedRows, total: bigSum(unallocatedRows.map((row) => row.actual_ex_tax)), count: unallocatedRows.length};

  const sum = (list, pick) => bigSum(list.map(pick));
  const checks = [
    {item: '月別の売上の和−作品計の売上（差0）', value: sum(monthly, (row) => row.sales) - totals.sales},
    {item: '売上明細の和−作品計の売上（差0）', value: sum(lines.filter((line) => monthIndex.has(line.month)), (line) => line.amount) - totals.sales},
    {item: '流通別の売上の和−作品計の売上（差0）', value: sum(cards, (card) => card.sales) - totals.sales},
    {item: '月別の経費の和−作品計の経費（差0）', value: sum(monthly, (row) => row.expense) - totals.expense},
    {item: 'カードの差額の和−作品計の差額（差0）', value: sum(cards, (card) => card.balance) - totals.balance},
    {item: '経費のうち制作費 ≦ 作品計の経費（超えた分）', value: Math.max(0, Math.abs(productionCost.amount) - Math.abs(totals.expense))},
  ];
  return {
    months, totals, monthly, distributions, cards, unallocated, checks,
    productionCost, lineCount: counted, expenseCount: inRangeExpenses.length,
  };
}

export function checksOk(checks = []) {
  return checks.every((check) => check.value === 0);
}

// 流通カードの「明細を見る」→ 売上明細の画面の条件（URL）。流通の絞込は distribution で渡す。
export function salesDetailParams({workId, from, to, distribution = null}) {
  const params = {period: 'custom', from, to, workId: String(workId)};
  if (distribution) params.distribution = distribution;
  return params;
}

// 帳票センターの作品別収支を開く条件（収支の画面からのリンク）。
export function workPnlLinkParams(workId) {
  return workId ? {report: 'work-pnl', workId: String(workId)} : {report: 'work-pnl'};
}

// ---- 収支の画面（IncomeDashboard）の表示用 ----

// fillGaps: 最初の月から最後の月までの間で数字の無い月も 0 の行として出す（月が飛んで見えないようにする）
export function incomeRows(monthly = [], {fillGaps = false} = {}) {
  const rows = monthly.map((row) => {
    const revenue = Number(row.revenue || 0);
    const cost = Number(row.cost || 0);
    return {month: row.month, revenue, cost, profit: row.profit == null ? revenue - cost : Number(row.profit)};
  });
  if (!fillGaps || rows.length < 2) return rows;
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const sorted = [...byMonth.keys()].sort();
  const out = [];
  let [y, m] = sorted[0].split('-').map(Number);
  const [ly, lm] = sorted.at(-1).split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    out.push(byMonth.get(month) || {month, revenue: 0, cost: 0, profit: 0});
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function incomeTotals(rows = []) {
  const revenue = bigSum(rows.map((row) => row.revenue));
  const cost = bigSum(rows.map((row) => row.cost));
  return {revenue, cost, profit: bigSum(rows.map((row) => row.profit))};
}

// グラフの月ラベル。月は毎回、年は最初の月・年が変わった月（every のときは毎回）に付ける。
export function monthAxisLabels(months = [], {every = months.length <= 12} = {}) {
  let previousYear = null;
  return months.map((value) => {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
    if (!match) return {month: String(value ?? ''), year: '', full: String(value ?? '')};
    const year = Number(match[1]);
    const month = Number(match[2]);
    const showYear = every || year !== previousYear;
    previousYear = year;
    return {month: `${month}月`, year: showYear ? `${year}年` : '', full: `${year}年${month}月`};
  });
}
