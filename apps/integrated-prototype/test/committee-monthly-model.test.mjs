import test from 'node:test';
import assert from 'node:assert/strict';
import {committeeFee, windowFees, computeCommitteeIncome, summarizeExpenses} from '../src/committee/committee-income.mjs';
import {buildCommitteeMonthly, buildColumns, splitLargestRemainder, checksOk, royaltyCategoryLabel} from '../src/committee/committee-monthly-model.mjs';
import {calculateCommitteeWindow} from '../src/committee.mjs';

// 独立に書いた料率計算（|額|×bp÷10000 を切り捨て、符号を戻す）
const oracleFee = (amount, bps) => Math.sign(amount) * Math.floor(Math.abs(amount) * bps / 10000);

const W = (over = {}) => ({id: 11, kind: 'digital', label: '配信', windowPartnerId: 1, windowPartnerName: 'A社', platformRateBps: 0, windowFeeBps: 1000, managerFeeBps: 500,
  feeOrder: 'window_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'after_window', route: 'direct', ...over});
const MEMBERS = [{partnerId: 1, name: 'A社', shareBps: 6000, memberOrder: 1}, {partnerId: 2, name: 'B社', shareBps: 4000, memberOrder: 2}];

function income(rows) {
  return rows.map((row) => ({hold: null, netReportedSales: 0, platformFee: 0, windowFee: 0, managerFee: 0, channelGroup: 'digital', windowKind: 'digital', windowId: 11, ...row,
    income: row.income ?? row.sales - (row.platformFee || 0) - (row.windowFee || 0) - (row.managerFee || 0)}));
}
const find = (report, key) => report.rows.find((row) => row.key === key);

test('料率の計算は切り捨てで符号を保ち、保存用の委員会計算（calculateCommitteeWindow）と同じ額になる', () => {
  assert.equal(committeeFee(999, 1000), 99);
  assert.equal(committeeFee(-999, 1000), -99, '返品（負）も絶対値で切り捨ててから符号を戻す');
  assert.equal(committeeFee(0, 5000), 0);
  assert.throws(() => committeeFee(1.5, 100), /整数/);
  const orders = [
    {feeOrder: 'window_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'platform_net'},
    {feeOrder: 'window_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'after_window'},
    {feeOrder: 'manager_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'platform_net'},
    {feeOrder: 'manager_first', windowFeeBasis: 'after_manager', managerFeeBasis: 'platform_net'},
  ];
  let seed = 7;
  const next = (limit) => { seed = (seed * 48271) % 2147483647; return seed % limit; };
  for (let n = 0; n < 400; n += 1) {
    const order = orders[n % orders.length];
    const window = W({...order, platformRateBps: next(3000), windowFeeBps: next(4000), managerFeeBps: next(2000)});
    const amount = next(50_000_000);
    const saved = calculateCommitteeWindow({window, reports: [{reportBasis: 'gross', amount}], expenses: [], members: [{partnerId: 1, shareBps: 10000}]});
    const {rows} = computeCommitteeIncome({lines: [{workId: 1, reportId: 5, accountingMonth: '2026-01', amount, channelGroup: 'digital'}],
      termsByWork: new Map([[1, {windows: [window]}]])});
    assert.equal(rows[0].platformFee, saved.platformFeeKnown, `PF ${JSON.stringify(window)} ${amount}`);
    assert.equal(rows[0].windowFee, saved.windowFee, `窓口 ${JSON.stringify(window)} ${amount}`);
    assert.equal(rows[0].managerFee, saved.managerFee, `幹事 ${JSON.stringify(window)} ${amount}`);
    assert.equal(rows[0].income, saved.platformNet - saved.windowFee - saved.managerFee);
  }
});

test('幹事先引き・幹事手数料控除後の基礎: 幹事手数料を先に引いた額に窓口手数料を掛ける', () => {
  const window = W({feeOrder: 'manager_first', windowFeeBasis: 'after_manager', managerFeeBasis: 'platform_net', windowFeeBps: 2000, managerFeeBps: 1000});
  assert.deepEqual(windowFees(100_001, window), {managerFee: 10000, windowFee: oracleFee(100_001 - 10000, 2000)});
  const windowFirst = W({feeOrder: 'window_first', managerFeeBasis: 'after_window', windowFeeBps: 2000, managerFeeBps: 1000});
  assert.deepEqual(windowFees(100_001, windowFirst), {windowFee: 20000, managerFee: oracleFee(100_001 - 20000, 1000)});
  assert.deepEqual(windowFees(-100_001, windowFirst), {windowFee: -20000, managerFee: -8000}, '返品の月は手数料も負（切り捨ては0の方向）');
  assert.throws(() => windowFees(1, W({feeOrder: 'xx'})), /控除順/);
});

test('区分→窓口の対応: レンタル・セル・区分未確認はビデオグラム、海外・その他はその他の窓口。窓口の無い区分は保留（0円にしない）', () => {
  const windows = [W({id: 1, kind: 'digital', platformRateBps: 1000}), W({id: 2, kind: 'package', windowFeeBps: 2000, managerFeeBps: 0}), W({id: 3, kind: 'other', windowFeeBps: 3000, managerFeeBps: 0})];
  const line = (reportId, channelGroup, amount, month = '2026-04') => ({workId: 1, reportId, accountingMonth: month, amount, channelGroup});
  const lines = [line(1, 'rental', 1000), line(2, 'sell', 2000), line(3, 'package', 300), line(4, 'overseas', 10000), line(5, 'other', 500),
    line(6, 'broadcast', 7000), line(7, 'digital', 9999), line(8, 'digital', 1, '2026-05'), {...line(9, 'digital', 50000), workId: 2}];
  const {rows, lines: detailed} = computeCommitteeIncome({lines, termsByWork: new Map([[1, {windows}]])});
  const byGroup = (group, month = '2026-04') => rows.find((row) => row.channelGroup === group && row.month === month);
  for (const group of ['rental', 'sell', 'package']) assert.equal(byGroup(group).windowKind, 'package', group);
  assert.equal(byGroup('rental').windowFee, 200);
  assert.equal(byGroup('sell').windowFee, 400);
  assert.equal(byGroup('overseas').windowKind, 'other');
  assert.equal(byGroup('overseas').windowFee, 3000);
  assert.equal(byGroup('overseas').channelLabel, '海外', '表示は区分のまま');
  assert.equal(byGroup('other').windowId, 3);
  const broadcast = byGroup('broadcast');
  assert.equal(broadcast.hold, 'no_window');
  assert.equal(broadcast.sales, 7000, '保留でも売上は残す');
  for (const key of ['platformFee', 'windowFee', 'managerFee', 'income']) assert.equal(broadcast[key], null, `${key} は算定できないので null`);
  assert.equal(byGroup('digital').platformFee, 999);
  assert.equal(rows.filter((row) => row.workId === 2).length, 0, '委員会の条件の無い作品の売上は数えない');
  assert.equal(detailed.length, 8);
  assert.equal(detailed.find((row) => row.reportId === 6).hold, 'no_window');
  assert.deepEqual(rows.map((row) => `${row.month}:${row.channelGroup}`),
    ['2026-04:rental', '2026-04:sell', '2026-04:package', '2026-04:digital', '2026-04:broadcast', '2026-04:overseas', '2026-04:other', '2026-05:digital']);
});

test('PF控除は売上報告ごとに切り捨て、控除後（net）の報告にはPF控除を掛けず、控除後の売上として別に持つ', () => {
  const window = W({platformRateBps: 5000, windowFeeBps: 0, managerFeeBps: 0});
  const lines = [1, 2, 3].map((amount, index) => ({workId: 1, reportId: index + 1, accountingMonth: '2026-01', amount, channelGroup: 'digital'}));
  lines.push({workId: 1, reportId: 3, accountingMonth: '2026-01', amount: 4, channelGroup: 'digital'});
  lines.push({workId: 1, reportId: 9, accountingMonth: '2026-01', amount: 1000, channelGroup: 'digital'});
  const basisByReport = new Map([['1:9', {basis: 'net', source: 'committee'}]]);
  const {rows, lines: detailed} = computeCommitteeIncome({lines, termsByWork: new Map([[1, {windows: [window]}]]), basisByReport});
  // 報告1:1→0、報告2:2→1、報告3:3+4=7→3。まとめて掛けると (1+2+7)×50%=5 になるが、報告ごとなので 4
  assert.equal(rows[0].platformFee, 4);
  assert.equal(rows[0].sales, 1010);
  assert.equal(rows[0].grossSales, 10);
  assert.equal(rows[0].netReportedSales, 1000);
  assert.equal(rows[0].income, 1006);
  assert.equal(rows[0].reportCount, 4);
  assert.equal(detailed.find((row) => row.reportId === 9).basisSource, 'committee');
  assert.equal(detailed.find((row) => row.reportId === 1).basisSource, 'default', '決まっていない報告は控除前として計算し、そう記録する');
  assert.deepEqual(summarizeExpenses([{workId: 1, month: '2026-01', category: '宣伝', amount: 100}, {workId: 1, month: '2026-01', category: '宣伝', amount: -30}, {workId: 1, month: '2026-02', category: '製造', amount: 5}]),
    [{workId: 1, month: '2026-01', category: '宣伝', amount: 70, count: 2}, {workId: 1, month: '2026-02', category: '製造', amount: 5, count: 1}]);
});

test('最大剰余法: 端数は余りの大きい順、同じなら並び順。負の額も同じ規則', () => {
  const parts = [{key: 'A', bps: 3333}, {key: 'B', bps: 3333}, {key: 'C', bps: 3334}];
  assert.deepEqual([...splitLargestRemainder(101, parts)], [['A', 34], ['B', 33], ['C', 34]]);
  assert.deepEqual([...splitLargestRemainder(-101, parts)], [['A', -34], ['B', -33], ['C', -34]]);
  assert.deepEqual([...splitLargestRemainder(1, [{key: 2, bps: 5000}, {key: 1, bps: 5000}])], [[2, 1], [1, 0]], '同じ余りなら先に並んだ方');
  assert.throws(() => splitLargestRemainder(10, [{key: 1, bps: 5000}]), /配賦/);
});

test('赤字の月は累計が正になるまで分配しない。月の分配は累計の分配可能額の増分、未分配は赤字の繰越', () => {
  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const pools = [-100, 30, 50, 80, -40, -100];
  const report = buildCommitteeMonthly({
    from: '2026-01', to: '2026-06', fiscalStartMonth: 1,
    incomeRows: income(months.map((month, i) => ({month, sales: pools[i] + 1000}))),
    expenses: months.map((month) => ({month, category: '宣伝', amount: 1000})),
    members: MEMBERS, windows: [W({windowFeeBps: 0, managerFeeBps: 0})], managerPartnerId: null, investments: null,
  });
  const at = (key) => report.monthly.map((row) => row[key]);
  assert.deepEqual(at('pool'), pools);
  assert.deepEqual(at('cumPool'), [-100, -70, -20, 60, 20, -80]);
  assert.deepEqual(at('distributable'), [0, 0, 0, 60, 20, 0]);
  assert.deepEqual(at('distribution'), [0, 0, 0, 60, -40, -20]);
  assert.deepEqual(at('undistributed'), [-100, -70, -20, 0, 0, -80]);
  assert.deepEqual(report.monthly.map((row) => row.investors[1].distribution), [0, 0, 0, 36, -24, -12]);
  assert.deepEqual(report.monthly.map((row) => row.investors[2].distribution), [0, 0, 0, 24, -16, -8]);
  assert.equal(find(report, 'distribution').values.period, 0, '期間の分配の和＝最後の分配可能額（0）');
  assert.equal(find(report, 'cumPool').values.period, -80);
  assert.equal(find(report, 'undistributed').values['m:2026-03'], -20);
  assert.deepEqual(report.summary.deficitMonths, ['2026-01', '2026-02', '2026-03', '2026-06']);
  assert.ok(checksOk(report.checks), JSON.stringify(report.checks.filter((c) => c.value !== 0)));
});

test('月次収支の行: 計算順どおりに売上→手数料→本委員会収入→経費→権利処理費→分配原資、出資者ごとの分配・手数料・取得額・回収率・利益', () => {
  const windows = [W({id: 11, kind: 'digital', windowPartnerId: 1, platformRateBps: 1000}), W({id: 12, kind: 'package', windowPartnerId: 2, windowFeeBps: 2000, managerFeeBps: 0})];
  const {rows: incomeRows, lines} = computeCommitteeIncome({
    lines: [
      {workId: 1, reportId: 1, saleId: 1, accountingMonth: '2026-05', amount: 1_000_000, channelGroup: 'digital'},
      {workId: 1, reportId: 2, saleId: 2, accountingMonth: '2026-05', amount: 200_001, channelGroup: 'rental'},
      {workId: 1, reportId: 3, saleId: 3, accountingMonth: '2026-06', amount: 300_000, channelGroup: 'sell'},
      {workId: 1, reportId: 4, saleId: 4, accountingMonth: '2026-06', amount: 50_000, channelGroup: 'broadcast'},
    ],
    termsByWork: new Map([[1, {windows}]]),
  });
  const accruals = [
    {agreementId: 1, workId: 1, category: 'director', accrualMonth: '2026-05', baseYen: 500_000, royaltyYen: 15_000, holdSalesYen: 0},
    {agreementId: 2, workId: 1, category: 'screenplay', accrualMonth: '2026-05', baseYen: 500_000, royaltyYen: 10_000, holdSalesYen: 0},
    {agreementId: 3, workId: 1, category: 'music', accrualMonth: '2026-06', baseYen: 0, royaltyYen: 3_333, holdSalesYen: 0},
    {agreementId: 4, workId: 1, category: 'original', accrualMonth: '2026-06', baseYen: 0, royaltyYen: 0, holdSalesYen: 120_000},
  ];
  const expenseLines = [{id: 1, workId: 1, month: '2026-05', category: '宣伝', amount: 80_000}, {id: 2, workId: 1, month: '2026-06', category: '製造', amount: 20_000}];
  const report = buildCommitteeMonthly({
    from: '2026-05', to: '2026-06', fiscalStartMonth: 5, incomeRows, lines, expenseLines, expenses: summarizeExpenses(expenseLines), accruals,
    members: MEMBERS, windows, feeShares: [], managerPartnerId: 2, investments: [{partnerId: 1, amountYen: 600_000}, {partnerId: 2, amountYen: 400_000}],
  });
  // 独立に計算した期待値
  const digital = {pf: 100_000}; digital.net = 900_000; digital.wf = 90_000; digital.mf = oracleFee(900_000 - 90_000, 500);
  const rental = {wf: oracleFee(200_001, 2000)};
  const sell = {wf: 60_000};
  const may = {sales: 1_200_001, pf: 100_000, wf: 90_000 + rental.wf, mf: digital.mf, exp: 80_000, roy: 25_000};
  may.income = may.sales - may.pf - may.wf - may.mf; may.pool = may.income - may.exp - may.roy;
  const jun = {sales: 350_000, hold: 50_000, wf: sell.wf, exp: 20_000, roy: 3_333};
  jun.income = 300_000 - sell.wf; jun.pool = jun.income - jun.exp - jun.roy;
  const m = (key, month) => find(report, key).values[`m:${month}`];
  assert.equal(m('sales', '2026-05'), may.sales);
  assert.equal(m('sales:digital', '2026-05'), 1_000_000);
  assert.equal(m('sales:rental', '2026-05'), 200_001);
  assert.equal(m('platformFee', '2026-05'), may.pf);
  assert.equal(m('windowFee', '2026-05'), may.wf);
  assert.equal(m('managerFee', '2026-05'), may.mf);
  assert.equal(m('income', '2026-05'), may.income);
  assert.equal(m('royalty:director', '2026-05'), 15_000);
  assert.equal(m('royalty', '2026-05'), may.roy);
  assert.equal(m('pool', '2026-05'), may.pool);
  assert.equal(m('holdSales', '2026-06'), 50_000, '放送の窓口が無いので保留');
  assert.equal(m('sales', '2026-06'), jun.sales);
  assert.equal(m('income', '2026-06'), jun.income);
  assert.equal(m('pool', '2026-06'), jun.pool);
  assert.equal(m('royaltyHold', '2026-06'), 120_000, '算定できない原作料の対象売上は保留として残す');
  assert.equal(m('royalty:original', '2026-06'), 0);
  assert.equal(report.holds.royalty.length, 1);
  assert.deepEqual(report.holds.windowMissing.map((row) => [row.channelGroup, row.periodSales]), [['broadcast', 50_000]]);
  // 分配（6:4）と、窓口手数料・幹事手数料の取り分
  const distMay = may.pool;
  assert.equal(m('dist:1', '2026-05') + m('dist:2', '2026-05'), distMay);
  assert.equal(m('wfee:1', '2026-05'), 90_000, '配信の窓口は A社');
  assert.equal(m('wfee:2', '2026-05'), rental.wf, 'ビデオグラムの窓口は B社');
  assert.equal(m('mfee:2', '2026-05'), may.mf, '幹事手数料は幹事の B社');
  assert.equal(find(report, 'mfee:1'), undefined, '幹事でない社には幹事手数料の行を出さない');
  assert.equal(m('acq:1', '2026-05'), m('dist:1', '2026-05') + 90_000);
  const cumA = find(report, 'acq:1').values.period;
  assert.equal(find(report, 'cumAcq:1').values.cumulative, cumA);
  assert.equal(find(report, 'inv:1').values.period, 600_000);
  assert.equal(find(report, 'rate:1').values.cumulative, cumA / 600_000);
  assert.equal(find(report, 'profit:1').values.cumulative, cumA - 600_000);
  const investorA = report.investors.find((row) => row.partnerId === 1);
  assert.equal(investorA.recoveryRate, cumA / 600_000);
  assert.equal(investorA.period.windowFee, 90_000 + 0);
  assert.equal(investorA.shareBps, 6000);
  // 行の並び（計算順）
  const order = report.rows.map((row) => row.key);
  const pos = (key) => order.indexOf(key);
  for (const [a, b] of [['sales', 'platformFee'], ['platformFee', 'windowFee'], ['windowFee', 'managerFee'], ['managerFee', 'income'], ['income', 'expense'], ['expense', 'royalty:director'], ['royalty', 'pool'], ['pool', 'distribution'], ['distribution', 'dist:1']]) {
    assert.ok(pos(a) < pos(b), `${a} は ${b} より前`);
  }
  assert.ok(checksOk(report.checks), JSON.stringify(report.checks.filter((c) => c.value !== 0)));
  const identity = report.checks.find((row) => row.item.startsWith('売上 = PF控除'));
  assert.equal(identity.value, 0);
  assert.equal(report.checks.find((row) => row.item.startsWith('元明細（売上）')).value, 0);
});

test('窓口手数料の取り分: 登録があれば窓口×月ごとに持分で分け（端数は最大剰余法）、無ければ窓口の受取先が100%', () => {
  const windows = [W({id: 11, kind: 'digital', windowPartnerId: 1, windowFeeBps: 1010, managerFeeBps: 0}), W({id: 12, kind: 'package', windowPartnerId: 2, windowFeeBps: 1000, managerFeeBps: 0})];
  const incomeRows = income([
    {month: '2026-01', sales: 1000, channelGroup: 'digital', windowKind: 'digital', windowId: 11, windowFee: 101},
    {month: '2026-01', sales: 500, channelGroup: 'rental', windowKind: 'package', windowId: 12, windowFee: 50},
  ]);
  const report = buildCommitteeMonthly({
    from: '2026-01', to: '2026-01', incomeRows, members: MEMBERS, windows,
    feeShares: [{windowId: 11, partnerId: 2, shareBps: 5000, name: 'B社'}, {windowId: 11, partnerId: 1, shareBps: 5000, name: 'A社'}],
  });
  // 配信の101円を A・B で半分ずつ → 並び順（A社が先）で A=51, B=50。ビデオグラムの50円は受取先 B社に100%
  assert.equal(find(report, 'wfee:1').values['m:2026-01'], 51);
  assert.equal(find(report, 'wfee:2').values['m:2026-01'], 50 + 50);
  const digital = report.windows.find((row) => row.id === 11);
  assert.equal(digital.feeSharesRegistered, true);
  assert.deepEqual(digital.feeShares.map((row) => [row.partnerId, row.shareBps]), [[1, 5000], [2, 5000]]);
  assert.equal(report.windows.find((row) => row.id === 12).feeSharesRegistered, false);
  assert.ok(checksOk(report.checks));

  const broken = buildCommitteeMonthly({from: '2026-01', to: '2026-01', incomeRows, members: MEMBERS, windows, feeShares: [{windowId: 11, partnerId: 2, shareBps: 5000}]});
  assert.deepEqual(broken.holds.invalidFeeShares.map((row) => row.windowId), [11], '合計が100%でない取り分は推測で埋めない');
  assert.equal(broken.holds.unassignedWindowFee, 101);
  assert.notEqual(broken.checks.find((row) => row.item.startsWith('窓口手数料の取り分の和')).value, 0, '照合で差として出る');
  assert.equal(checksOk(broken.checks), false);
});

test('出資額の登録が無いときは出資額・回収率・利益を「未確認」（null）にし、0円として扱わない', () => {
  const report = buildCommitteeMonthly({from: '2026-01', to: '2026-01', incomeRows: income([{month: '2026-01', sales: 1000}]), members: MEMBERS, windows: [W()], investments: null});
  for (const key of ['inv:1', 'rate:1', 'profit:1']) assert.equal(find(report, key).values.cumulative, null, key);
  assert.equal(report.investors[0].investmentYen, null);
  assert.equal(report.investors[0].recoveryRate, null);
  const zero = buildCommitteeMonthly({from: '2026-01', to: '2026-01', incomeRows: income([{month: '2026-01', sales: 1000}]), members: MEMBERS, windows: [W()],
    investments: [{partnerId: 1, amountYen: 0}, {partnerId: 2, amountYen: 1000}]});
  assert.equal(find(zero, 'rate:1').values.cumulative, null, '出資額0円では回収率を出さない');
  assert.equal(find(zero, 'profit:1').values.cumulative, find(zero, 'cumAcq:1').values.cumulative);
});

test('列: 年度（期首5月）ごとに月を並べて年度計をはさみ、期間計・期間前の累計・累計。累計の行は期末の値', () => {
  const months = ['2025-12', '2026-03', '2026-04', '2026-05', '2026-06'];
  const report = buildCommitteeMonthly({
    from: '2026-03', to: '2026-06', fiscalStartMonth: 5,
    incomeRows: income(months.map((month, i) => ({month, sales: (i + 1) * 100}))),
    members: MEMBERS, windows: [W({windowFeeBps: 0, managerFeeBps: 0})],
  });
  assert.deepEqual(report.columns.map((column) => column.key),
    ['m:2026-03', 'm:2026-04', 'fy:2025', 'm:2026-05', 'm:2026-06', 'fy:2026', 'period', 'prior', 'cumulative']);
  assert.equal(report.columns.find((column) => column.key === 'fy:2025').label, '2025年度計（期間内）');
  assert.equal(report.firstMonth, '2025-12', '累計は最初のデータの月から');
  const sales = find(report, 'sales').values;
  assert.equal(sales['fy:2025'], 200 + 300);
  assert.equal(sales['fy:2026'], 400 + 500);
  assert.equal(sales.period, 1400);
  assert.equal(sales.prior, 100);
  assert.equal(sales.cumulative, 1500);
  const cumPool = find(report, 'cumPool').values;
  assert.equal(cumPool['fy:2025'], 100 + 200 + 300, '累計の行の年度計は年度の最後の月の値');
  assert.equal(cumPool.prior, 100);
  assert.equal(cumPool.period, 1500);
  assert.ok(checksOk(report.checks));
  const single = buildColumns({periodMonths: ['2026-05', '2026-06'], historyMonths: ['2026-05', '2026-06'], periodStart: 0, fiscalStartMonth: 5});
  assert.deepEqual(single.map((column) => column.key), ['m:2026-05', 'm:2026-06', 'period', 'cumulative'], '年度が1つなら年度計は出さない（期間計と同じ）');
});

test('期間の後のデータは数えず、入力の誤りは日本語で断る', () => {
  const report = buildCommitteeMonthly({from: '2026-01', to: '2026-01', incomeRows: income([{month: '2026-01', sales: 10}, {month: '2026-02', sales: 999}]), members: MEMBERS, windows: [W()]});
  assert.equal(find(report, 'sales').values.cumulative, 10);
  assert.throws(() => buildCommitteeMonthly({from: '2026-02', to: '2026-01', members: MEMBERS}), /開始月が終了月より後/);
  assert.throws(() => buildCommitteeMonthly({from: '2016-01', to: '2026-12', members: MEMBERS}), /120か月以内/);
  assert.throws(() => buildCommitteeMonthly({from: '2026-1', to: '2026-01', members: MEMBERS}), /2026-05/);
  assert.throws(() => buildCommitteeMonthly({from: '2026-01', to: '2026-01', members: [{partnerId: 1, shareBps: 9000, memberOrder: 1}]}), /持分の合計/);
  assert.throws(() => buildCommitteeMonthly({from: '2026-01', to: '2026-01', members: []}), /参加者/);
  assert.equal(royaltyCategoryLabel('music'), '音楽著作権料');
  assert.equal(royaltyCategoryLabel('mystery'), 'その他の権利処理費（mystery）');
});

test('照合は全月・全列で差0。どの出資者の分配の和も分配額に一致し、取得額の和は分配額＋手数料', () => {
  let seed = 11;
  const next = (limit) => { seed = (seed * 48271) % 2147483647; return seed % limit; };
  const members = [{partnerId: 1, name: 'A', shareBps: 3333, memberOrder: 1}, {partnerId: 2, name: 'B', shareBps: 3333, memberOrder: 2}, {partnerId: 3, name: 'C', shareBps: 3334, memberOrder: 3}];
  const windows = [W({id: 1, kind: 'digital', windowPartnerId: 1, platformRateBps: 1500, windowFeeBps: 1234, managerFeeBps: 321}),
    W({id: 2, kind: 'package', windowPartnerId: 2, feeOrder: 'manager_first', windowFeeBasis: 'after_manager', managerFeeBasis: 'platform_net', windowFeeBps: 1777, managerFeeBps: 555}),
    W({id: 3, kind: 'theatrical', windowPartnerId: 3, platformRateBps: 5000, windowFeeBps: 999, managerFeeBps: 0})];
  const groups = ['digital', 'rental', 'sell', 'package', 'theatrical', 'broadcast'];
  const lines = [];
  for (let n = 0; n < 300; n += 1) {
    const month = `2025-${String(1 + next(12)).padStart(2, '0')}`;
    lines.push({workId: 1, reportId: 1 + next(40), saleId: n + 1, accountingMonth: month, amount: next(400_000) - 60_000, channelGroup: groups[next(groups.length)]});
  }
  const basisByReport = new Map([...Array(10).keys()].map((k) => [`1:${k + 1}`, {basis: 'net', source: 'committee'}]));
  const {rows: incomeRows, lines: detailed} = computeCommitteeIncome({lines, termsByWork: new Map([[1, {windows}]]), basisByReport});
  const expenseLines = [...Array(30).keys()].map((k) => ({id: k + 1, workId: 1, month: `2025-${String(1 + next(12)).padStart(2, '0')}`, category: ['宣伝', '製造', '配送'][k % 3], amount: next(300_000)}));
  const accruals = [...Array(40).keys()].map((k) => ({agreementId: k % 6, workId: 1, category: ['director', 'screenplay', 'music', 'original', 'creator', 'other'][k % 6],
    accrualMonth: `2025-${String(1 + next(12)).padStart(2, '0')}`, royaltyYen: next(90_000) - 10_000, holdSalesYen: k % 13 === 0 ? 5000 : 0}));
  const report = buildCommitteeMonthly({
    from: '2025-04', to: '2025-12', fiscalStartMonth: 5, incomeRows, lines: detailed, expenseLines, expenses: summarizeExpenses(expenseLines), accruals,
    members, windows, feeShares: [{windowId: 3, partnerId: 1, shareBps: 2500}, {windowId: 3, partnerId: 2, shareBps: 2500}, {windowId: 3, partnerId: 3, shareBps: 5000}],
    managerPartnerId: 1, investments: [{partnerId: 1, amountYen: 1_000_000}, {partnerId: 2, amountYen: 1_000_000}, {partnerId: 3, amountYen: 1_000_001}],
  });
  assert.ok(checksOk(report.checks), JSON.stringify(report.checks.filter((c) => c.value !== 0)));
  assert.ok(report.checks.length >= 14);
  for (const month of report.monthly) {
    const investors = Object.values(month.investors);
    assert.equal(investors.reduce((n, row) => n + row.distribution, 0), month.distribution);
    assert.equal(investors.reduce((n, row) => n + row.acquisition, 0), month.distribution + month.windowFee + month.managerFee);
    assert.equal(month.sales, month.platformFee + month.windowFee + month.managerFee + month.expense + month.royalty + month.pool + month.holdSales);
  }
  const fromRows = incomeRows.filter((row) => row.month >= '2025-04' && !row.hold).reduce((n, row) => n + row.income, 0);
  assert.equal(find(report, 'income').values.period, fromRows);
});
