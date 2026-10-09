import {classifyExpense} from '../src/expense-accounting/adoption.mjs';
// PL・BS の純関数（src/reports/pl-bs-model.mjs）と、画面・Excel の表（src/pl-bs/pl-bs-view.mjs）の試験。
// 小さな架空の材料で、作品別PL・会社PL・作品別の残高・会社BS を手で計算した額と照合する（計算は下のコメントに書き下した）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildPlBs, DEFAULT_ACCOUNTS, splitByWeights, PL_BS_HEADING, checksOk} from '../src/reports/pl-bs-model.mjs';
import {advanceRecoupSeries} from '../src/royalty/royalty-model.mjs';
import {runAction, reversalDateError} from '../src/pl-bs/payment-actions.mjs';
import {plBsSheets, manualMatrix, SHEET_NAMES, WORK_PL_COLUMNS} from '../src/pl-bs/pl-bs-view.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';

const ACCOUNTS = DEFAULT_ACCOUNTS.map((row, index) => ({...row, id: index + 1}));
const acc = (code) => ACCOUNTS.find((row) => row.code === code).id;
const SELF = 9;

// 自社作品 A（公開 2026-02・全作品のウィンドウ）、自社作品 B（公開は最初の売上の月）、委員会作品 C。期首残高の基準月 2025-12、期間 2026-01〜03
function fixture(overrides = {}) {
  return {
    from: '2026-01', to: '2026-03', asOf: '2026-03',
    fiscal: {fiscalStartMonth: 5, confirmed: true},
    profile: {selfPartnerId: SELF, openingMonth: '2025-12', legalName: '架空テスト映像（架空）'},
    accounts: ACCOUNTS,
    works: [
      {id: 1, code: 'A', title: '作品A（架空）', committee: false, releaseMonth: '2026-02', releaseSource: 'window'},
      {id: 2, code: 'B', title: '作品B（架空）', committee: false, releaseMonth: '2026-03', releaseSource: 'first_sale'},
      {id: 3, code: 'C', title: '作品C（委員会・架空）', committee: true},
    ],
    saleLines: [
      {saleId: 1, workId: 1, month: '2026-02', amount: 1000, tax: 100, channelGroup: 'theatrical'},
      {saleId: 2, workId: 1, month: '2026-03', amount: 500, tax: 50, channelGroup: 'digital'},
      {saleId: 3, workId: 2, month: '2026-03', amount: 300, tax: 30, channelGroup: 'rental'},
      {saleId: 4, workId: 3, month: '2026-02', amount: 10000, tax: 1000, channelGroup: 'theatrical'}, // 委員会の売上（自社の売上にしない）
    ],
    expenses: [
      {id: 1, workId: 1, month: '2026-01', category: '制作費', accountId:acc('5300'), accountName:'制作費', systemKey:'production_cost', section:'cogs', recognitionTiming:'release_month_once', exTax: 500, tax: 50, incTax: 550},
      {id: 2, workId: 1, month: '2026-03', category: '制作費', accountId:acc('5300'), accountName:'制作費', systemKey:'production_cost', section:'cogs', recognitionTiming:'release_month_once', exTax: 100, tax: 10, incTax: 110},
      {id: 3, workId: 1, month: '2026-02', category: 'P&A', accountId:acc('6100'), accountName:'P&A', systemKey:'promotion', section:'sga', recognitionTiming:'incurred_month', exTax: 200, tax: 20, incTax: 220},
      {id: 4, workId: 1, month: '2026-03', category: 'パッケージ製作費', accountId:acc('5200'), accountName:'パッケージ製作費', systemKey:'direct_cost', section:'cogs', recognitionTiming:'incurred_month', exTax: 40, tax: 4, incTax: 44},
      {id: 5, workId: 1, month: '2026-03', category: '事務費', accountId:acc('6150'), accountName:'事務費', systemKey:'work_other_expense', section:'sga', recognitionTiming:'incurred_month', exTax: 10, tax: 1, incTax: 11},
      {id: 6, workId: 3, month: '2026-02', category: 'P&A', accountId:acc('6100'), accountName:'P&A', systemKey:'promotion', section:'sga', recognitionTiming:'incurred_month', exTax: 300, tax: 30, incTax: 330}, // 委員会の経費
      {id: 7, workId: null, projectId: 1, month: '2026-03', category: '事務費', accountId:acc('6150'), accountName:'事務費', systemKey:'work_other_expense', section:'sga', recognitionTiming:'incurred_month', exTax: 70, tax: 7, incTax: 77}, // 作品の決まっていない案件の経費
    ],
    expensePayments: [
      {id: 1, expenseId: 1, paidOn: '2026-02-10', amount: 550},
      {id: 2, expenseId: 3, paidOn: '2026-03-31', amount: 220},
      {id: 3, expenseId: 6, paidOn: '2026-03-31', amount: 330}, // 委員会の口座から（自社の現預金に入れない）
      {id: 4, expenseId: 7, paidOn: '2026-04-30', amount: 77}, // 基準月より後
    ],
    royaltyAccruals: [
      {workId: 1, month: '2026-02', royaltyYen: 50, holdSalesYen: 0},
      {workId: 1, month: '2026-03', royaltyYen: null, holdSalesYen: 20}, // 算定できない（未確定）
      {workId: 3, month: '2026-02', royaltyYen: 999, holdSalesYen: 0}, // 委員会の権利処理費
    ],
    royaltyPayments: [{statementId: 1, paidOn: '2026-03-31', amount: 60, weights: [{workId: 1, weight: 50}, {workId: 3, weight: 10}]}],
    committee: [{workId: 3, contractId: 1, committedYen: 2000, selfShareBps: 5000, acquisitions: [
      {month: '2026-02', distribution: 100, windowFee: 20, managerFee: 10, acquisition: 130},
      {month: '2026-03', distribution: 50, windowFee: 20, managerFee: 0, acquisition: 70},
    ]}],
    investmentPayments: [{workId: 3, partnerId: SELF, paidOn: '2026-01-15', amount: 1000}, {workId: 3, partnerId: 7, paidOn: '2026-01-15', amount: 500}],
    committeeReceipts: [{workId: 3, receivedOn: '2026-03-20', amount: 100}],
    receipts: [
      {receiptId: 1, invoiceId: 1, receivedOn: '2026-03-31', amount: 1100, weights: [{workId: 1, weight: 1100}]},
      {receiptId: 2, invoiceId: 2, receivedOn: '2026-03-10', amount: 33, weights: []}, // 作品に分けられない入金
    ],
    manual: [
      {id: 1, accountId: acc('1100'), month: '2025-12', kind: 'balance', amount: 10000, status: 'reviewed'},
      {id: 2, accountId: acc('3100'), month: '2025-12', kind: 'balance', amount: 8000, status: 'reviewed'},
      {id: 3, accountId: acc('2500'), month: '2025-12', kind: 'balance', amount: 3000, status: 'reviewed'},
      {id: 4, accountId: acc('3200'), month: '2025-12', kind: 'balance', amount: -1000, status: 'reviewed'},
      ...['2026-01', '2026-02', '2026-03'].map((month, k) => ({id: 10 + k, accountId: acc('6240'), month, kind: 'flow', amount: 100, status: 'reviewed'})),
      {id: 20, accountId: acc('6280'), month: '2026-02', kind: 'flow', amount: 30, status: 'reviewed'}, // 減価償却費（現預金を動かさない）
      {id: 21, accountId: acc('7500'), month: '2026-03', kind: 'flow', amount: 5, status: 'reviewed'},
      {id: 22, accountId: acc('5900'), month: '2026-03', kind: 'flow', amount: 15, workId: 1, status: 'reviewed'}, // 作品Aに付けた費用
      {id: 23, accountId: acc('2500'), month: '2026-03', kind: 'balance', amount: 3500, status: 'reviewed'}, // 借入 +500
    ],
    mg: [],
    ...overrides,
  };
}
const row = (rows, key) => rows.find((item) => item.key === key);

test('作品別PL: 自社作品は売上−ロイヤリティ−経費−制作費（公開月に一括）、委員会作品は自社の取得額だけ', () => {
  const report = buildPlBs(fixture());
  const [a, b, c] = report.workPl;
  // A: 売上 1000+500。ロイヤリティ 50（算定できない月は入れない）。制作費は 1月の500を公開月2月に一括、公開後の3月の100は3月に。
  //    直接費40・宣伝費200・その他10・手入力の費用15 → 1500−50−600−40−200−10−15 = 585
  assert.deepEqual({sales: a.period.sales, royalty: a.period.royalty, production: a.period.production, direct: a.period.direct, promotion: a.period.promotion,
    workOther: a.period.workOther, manualCost: a.period.manualCost, profit: a.period.profit},
  {sales: 1500, royalty: 50, production: 600, direct: 40, promotion: 200, workOther: 10, manualCost: 15, profit: 585});
  assert.deepEqual(a.monthly.map((m) => m.production), [0, 500, 100], '制作費は公開月（2月）に一括、公開後は発生月');
  assert.equal(a.origin, 'unverified');
  assert.ok(a.reasons.some((text) => text.startsWith('ロイヤリティの発生額に算定できない月')), a.reasons.join());
  assert.equal(b.period.profit, 300);
  assert.equal(b.origin, 'system', '制作費の無い作品は、公開月が推定でも未確定にしない');
  // C: 委員会の売上10000・経費300・権利処理費999は入れず、自社の取得額 130+70 だけ
  assert.deepEqual({revenue: c.period.revenue, acq: c.period.acq, dist: c.period.acqDist, wfee: c.period.acqWindowFee, mfee: c.period.acqManagerFee, profit: c.period.profit},
    {revenue: 200, acq: 200, dist: 150, wfee: 40, mfee: 10, profit: 200});
  assert.equal(c.kindLabel, '委員会作品（自社の取り分）');
  const detail = report.workDetail[1];
  assert.deepEqual(detail.columns.map((col) => col.label), ['2026年1月', '2026年2月', '2026年3月', '期間計', '累計']);
  assert.equal(row(detail.rows, 'profit').values.period, 585);
});

test('会社PL: 作品別PLの合計＋作品の決まっていない経費＋手入力。利益の段階と当期純利益', () => {
  const report = buildPlBs(fixture());
  const rows = report.companyPl.rows;
  const period = (key) => row(rows, key).values.period;
  assert.equal(period('own_sales'), 1800);
  assert.equal(period('committee_share'), 200);
  assert.equal(period('total:sales'), 2000);
  assert.equal(period('royalty'), 50);
  assert.equal(period('production_cost'), 600);
  assert.equal(period('work_other_expense'), 80, '作品の事務費10＋案件の事務費70');
  // 売上総利益 = 2000 −（50+40+600+15）= 1295、営業利益 = 1295 −（200+80+300+30）= 685、経常利益 = 685 − 5 = 680
  assert.equal(period('grossProfit'), 1295);
  assert.equal(period('operatingProfit'), 685);
  assert.equal(period('ordinaryProfit'), 680);
  assert.equal(period('netIncome'), 680);
  assert.deepEqual(report.companyPl.columns.map((col) => col.key), ['m:2026-01', 'm:2026-02', 'm:2026-03', 'period']);
  assert.equal(row(rows, 'netIncome').values['m:2026-02'], 1000 - 50 - 500 - 200 - 100 - 30 + 130, '2月: 売上1000−ロイヤリティ50−制作費500−宣伝費200−家賃100−減価償却30＋取得額130');
  assert.ok(checksOk(report.checks), JSON.stringify(report.checks));
  assert.equal(report.heading, PL_BS_HEADING);
});

test('会社BS: 期首残高＋動き。手入力の減価償却費（現預金を動かさない）の分だけ説明のつかない差額が出て、手がかりで説明できる', () => {
  const report = buildPlBs(fixture());
  const bs = report.companyBs;
  const value = (key) => row(bs.rows, key).value;
  // 現預金 = 10000 ＋入金（1100＋33）＋委員会からの受取100 −経費の出金（550＋220。委員会の経費330と4月の77は入れない）
  //        −ロイヤリティの支払（自社作品の分50）−出資の払込1000 −手入力の費用（家賃300＋利息5＋作品Aの原価15）＋借入の増加500 = 9593
  assert.equal(value('cash'), 9593);
  assert.equal(value('receivable'), 1650 + 330 - 1100 - 33);
  assert.equal(value('committee_receivable'), 200 - 100);
  assert.equal(value('committee_investment'), 1000, '他の出資者の払込は入れない');
  assert.equal(value('work_in_progress'), 0);
  assert.equal(value('expense_payable'), (550 + 110 + 220 + 44 + 11 + 77) - (550 + 220));
  assert.equal(value('royalty_payable'), 0);
  assert.equal(value('consumption_tax'), (100 + 50 + 30) - (50 + 10 + 20 + 4 + 1 + 7));
  assert.equal(value('retained_earnings'), -1000 + 680);
  assert.equal(bs.totals.asset, 9593 + 847 + 100 + 1000);
  assert.equal(bs.totals.liability, 242 + 88 + 3500);
  assert.equal(bs.totals.equity, 8000 - 320);
  assert.equal(bs.difference, 30);
  assert.equal(bs.rows.at(-1).key, 'difference', '最後の行は必ず説明のつかない差額');
  assert.deepEqual(bs.hints.map((hint) => [hint.key, hint.value]), [['openingGap', 0], ['nonCashPl', 30], ['nonCashBalance', 0], ['unexplained', 0]]);
  assert.equal(row(bs.rows, 'difference').origin, 'unverified');
  assert.deepEqual(bs.reference.find((item) => item.key === 'committee_royalty_paid').value, 10);
});

test('作品別の残高: 売掛金・未払・制作中の作品・出資金と回収率。委員会の経費は参考で合計に入れない', () => {
  const report = buildPlBs(fixture({asOf: '2026-01'}));
  const [a, , c] = report.workBalances;
  assert.equal(a.wip, 500, '公開前（2026-01末）は制作費を制作中の作品に置く');
  assert.equal(a.expensePayable, 550, '1月の制作費は未払（出金は2月）');
  assert.equal(c.investmentPaid, 1000);
  assert.equal(c.cumulativeAcquisition, 0);
  const later = buildPlBs(fixture());
  const [a2, b2, c2] = later.workBalances;
  assert.deepEqual({receivable: a2.receivable, expensePayable: a2.expensePayable, royaltyPayable: a2.royaltyPayable, wip: a2.wip, net: a2.net},
    {receivable: 550, expensePayable: 935 - 770, royaltyPayable: 0, wip: 0, net: 550 - 165});
  assert.equal(b2.receivable, 330);
  assert.deepEqual({receivable: c2.committeeReceivable, invested: c2.investmentPaid, committed: c2.investmentCommitted, acquired: c2.cumulativeAcquisition, rate: c2.recoveryRate, unpaid: c2.investmentUnpaid},
    {receivable: 100, invested: 1000, committed: 2000, acquired: 200, rate: 0.1, unpaid: 1000});
  assert.equal(c2.committeeUnpaidExpense, 0);
  assert.equal(c2.receivable, null);
  assert.equal(c2.net, 100 + 1000);
});

test('自社を表す取引先・期首の基準月が無いときは、委員会の取り分を0円で埋めず未確定にし、注意を出す', () => {
  const report = buildPlBs(fixture({profile: {selfPartnerId: null, openingMonth: null}}));
  const c = report.workPl.find((item) => item.code === 'C');
  assert.equal(c.origin, 'unverified');
  assert.ok(c.reasons[0].includes('自社を表す取引先が未設定'));
  assert.equal(row(report.companyPl.rows, 'committee_share').origin, 'unverified');
  assert.ok(report.companyNotes.some((note) => note.includes('期首残高の基準月が未設定')), '会社全体の注意は companyNotes に出す（会社全体を見られない人には返さない）');
  assert.ok(!report.notes.some((note) => note.includes('期首残高の基準月が未設定')));
  assert.ok(report.notes.some((note) => note.includes('自社を表す取引先が未設定')));
  assert.equal(report.workBalances.find((item) => item.code === 'C').committeeReceivable, null);
});

test('公開月が分からない自社作品の制作費は資産に置いたまま未確定にする', () => {
  const input = fixture();
  input.works = input.works.map((work) => (work.id === 1 ? {...work, releaseMonth: null, releaseSource: null} : work));
  const report = buildPlBs(input);
  const a = report.workPl[0];
  assert.equal(a.period.production, 0);
  assert.ok(a.reasons.some((text) => text.includes('公開月が分からない')));
  assert.equal(report.workBalances[0].wip, 600);
  assert.equal(row(report.companyBs.rows, 'work_in_progress').value, 600);
  assert.equal(report.companyBs.hints.at(-1).value, 0, '資産に置いたままでも貸借の手がかりは説明できる');
});

test('期首の制作中の作品（手入力の期首残高・作品付き）は公開月に費用になり、期首の翌月より前の出金も落とさない', () => {
  const input = fixture();
  input.manual = input.manual.map((item) => (item.id === 4 ? {...item, amount: -700} : item)); // 期首の制作中の作品300の分だけ繰越利益剰余金を増やして貸借を合わせる
  input.manual.push({id: 40, accountId: acc('1300'), month: '2025-12', kind: 'balance', amount: 300, workId: 2, status: 'reviewed'});
  const report = buildPlBs(input);
  const b = report.workPl.find((row) => row.code === 'B');
  assert.equal(b.period.production, 300, '公開月（2026-03・最初の売上の月）に期首の制作中の作品を費用にする');
  assert.equal(b.period.profit, 0);
  assert.ok(b.reasons.some((text) => text.includes('最初に売上を計上した月')), '公開月が推定なので未確定');
  assert.equal(report.workBalances.find((row) => row.code === 'B').wip, 0);
  const bs = report.companyBs;
  assert.equal(bs.rows.find((row) => row.key === 'work_in_progress').opening, 300);
  assert.deepEqual(bs.hints.map((hint) => [hint.key, hint.value]), [['openingGap', 0], ['nonCashPl', 30], ['nonCashBalance', 0], ['unexplained', 0]]);
  // 期首の基準月が無いとき、最初の売上・経費（2026-01）より前の出金も現預金に入る
  const cashOf = (payments) => buildPlBs(fixture({profile: {selfPartnerId: SELF, openingMonth: null}, expensePayments: payments})).companyBs.rows.find((row) => row.key === 'cash').value;
  const base = fixture().expensePayments;
  assert.equal(cashOf([...base, {id: 9, expenseId: 3, paidOn: '2025-11-05', amount: 1}]), cashOf(base) - 1);
});

test('期首の貸借が合わない・現預金を動かさない残高の増減は、差額の手がかりに分けて出す', () => {
  const input = fixture();
  input.manual = input.manual.map((item) => (item.id === 4 ? {...item, amount: -900} : item)); // 繰越利益剰余金を100多く
  input.manual.push({id: 30, accountId: acc('1500'), month: '2026-03', kind: 'balance', amount: 40, status: 'unverified'}); // 固定資産（現預金を動かさない）
  const bs = buildPlBs(input).companyBs;
  assert.deepEqual(bs.hints.map((hint) => [hint.key, hint.value]), [['openingGap', -100], ['nonCashPl', 30], ['nonCashBalance', 40], ['unexplained', 0]]);
  assert.equal(bs.difference, -100 + 30 + 40);
  assert.equal(row(bs.rows, 'manual:' + acc('1500')).origin, 'unverified');
});

test('重みで分ける: 端数は余りの大きい順、合計は元の額、重みが無ければ分けない', () => {
  const split = splitByWeights(100, [{key: 1, weight: 1}, {key: 2, weight: 1}, {key: 3, weight: 1}]);
  assert.deepEqual([...split.values()], [34, 33, 33]);
  assert.deepEqual([...splitByWeights(-10, [{key: 'a', weight: 3}, {key: 'b', weight: 7}]).values()], [-3, -7]);
  assert.equal(splitByWeights(10, []), null);
  assert.equal(splitByWeights(10, [{key: 1, weight: 0}]), null);
  assert.equal(classifyExpense('制作費（撮影）'), 'production_cost');
  assert.equal(classifyExpense('P&A'), 'promotion');
  assert.equal(classifyExpense('配信マスター制作費'), 'direct_cost');
  assert.equal(classifyExpense('事務費'), 'work_other_expense');
});

test('期間・基準月の指定が壊れているときは計算しない', () => {
  assert.throws(() => buildPlBs(fixture({from: '2026-13'})), /期間/);
  assert.throws(() => buildPlBs(fixture({from: '2026-04', to: '2026-03'})), /開始月/);
  assert.throws(() => buildPlBs(fixture({asOf: '26-03'})), /基準月/);
});

test('Excel: 作品別PL・作品別の残高・会社PL・会社BS のシートを書き出して読み戻すと、見出しと行数が画面の表と同じ', () => {
  const report = buildPlBs(fixture());
  const body = {...report, profile: {legalName: '架空テスト映像（架空）'}, dataAsOf: {latestImportAt: null}};
  for (const [view, names] of Object.entries(SHEET_NAMES)) {
    const sheets = plBsSheets(body, view, {workId: 1});
    const expectedNames = view === 'work-pl' ? names : names;
    assert.deepEqual(sheets.map((sheet) => sheet.name), expectedNames, view);
    const workbook = decodeXlsx(encodeReportXlsx({sheets}));
    assert.deepEqual(workbook.map((sheet) => sheet.name), expectedNames, view);
    const text = JSON.stringify(workbook);
    for (const english of ['undefined', 'NaN', 'own_sales', 'committee_share', '[object Object]']) assert.ok(!text.includes(english), `${view}: ${english}`);
    assert.ok(text.includes('管理会計の試算（決算書ではありません）'), `${view}: 見出しに試算と書く`);
  }
  const workbook = decodeXlsx(encodeReportXlsx({sheets: plBsSheets(body, 'company-bs')}));
  const bsRows = workbook[0].rows;
  const header = bsRows.findIndex((cells) => cells[0] === '科目コード');
  assert.ok(header >= 0);
  assert.deepEqual(bsRows[header].slice(0, 5), ['科目コード', '科目', '期首残高', '基準月末', '増減']);
  const after = bsRows.slice(header + 1);
  const blank = after.findIndex((cells) => !cells.some((cell) => cell !== '' && cell !== null && cell !== undefined));
  const data = blank === -1 ? after : after.slice(0, blank); // 表の後ろに1行空けて注記が続く
  assert.equal(data.length, report.companyBs.rows.length);
  assert.match(String(data.at(-1)[1]), /説明のつかない差額/);
  assert.equal(Number(data.at(-1)[3]), 30);
  const plBook = decodeXlsx(encodeReportXlsx({sheets: plBsSheets(body, 'work-pl', {workId: 1})}));
  const plHeader = plBook[0].rows.find((cells) => cells[0] === '作品コード');
  assert.equal(plHeader.length >= WORK_PL_COLUMNS.length, true);
  assert.equal(plBook[1].name, '作品別PLの月別');
});

test('手入力の表: 取り消されていない行だけを科目×月に足し、発生額は期間計を出す', () => {
  const rows = [
    {id: 1, live: true, accountId: 5, accountCode: '6240', accountName: '地代家賃', section: 'sga', kind: 'flow', month: '2026-01', amountYen: 100, status: 'reviewed'},
    {id: 2, live: false, accountId: 5, accountCode: '6240', accountName: '地代家賃', section: 'sga', kind: 'flow', month: '2026-02', amountYen: 999, status: 'reviewed'},
    {id: 3, live: true, accountId: 5, accountCode: '6240', accountName: '地代家賃', section: 'sga', kind: 'flow', month: '2026-02', amountYen: 100, status: 'unverified'},
    {id: 4, live: true, accountId: 8, accountCode: '2500', accountName: '借入金', section: 'liability', kind: 'balance', month: '2026-02', amountYen: 3000, status: 'reviewed'},
  ];
  const matrix = manualMatrix(rows, ['2026-01', '2026-02']);
  assert.deepEqual(matrix.map((item) => [item.accountCode, item.values, item.total, item.unverified]),
    [['2500', {'2026-02': 3000}, null, false], ['6240', {'2026-01': 100, '2026-02': 100}, 200, true]]);
});

// ---------- 見直しで足した試験 ----------
test('前払金の充当: 台帳と同じ式で月ごとに充当し、未払ロイヤリティから引く。前払金の支払は記録が無いので未確定・差額に出る', () => {
  // 契約1: 前払金2000、発生 1000×3か月 → 充当 1000・1000・0。2か月目の発生が返品で −500 に減ると充当も戻す
  assert.deepEqual(advanceRecoupSeries({accruals: [1, 2, 3].map((k) => ({agreementId: 1, month: `2026-0${k}`, royaltyYen: 1000})), advanceOf: () => 2000}),
    [{agreementId: 1, month: '2026-01', amount: 1000}, {agreementId: 1, month: '2026-02', amount: 1000}]);
  assert.deepEqual(advanceRecoupSeries({accruals: [{agreementId: 1, month: '2026-01', royaltyYen: 1500}, {agreementId: 1, month: '2026-02', royaltyYen: -500}, {agreementId: 1, month: '2026-03', royaltyYen: null}], advanceOf: () => 2000}),
    [{agreementId: 1, month: '2026-01', amount: 1500}, {agreementId: 1, month: '2026-02', amount: -500}]);
  assert.deepEqual(advanceRecoupSeries({accruals: [{agreementId: 1, month: '2026-01', royaltyYen: 1500}], advanceOf: () => 0}), []);
  // 自社作品 B（作品2）: 発生 1000×3か月、前払金 2000（充当 1000・1000・0）、3か月目に支払 1000 → 未払ロイヤリティは 0
  const input = fixture();
  input.royaltyAccruals = [...input.royaltyAccruals, ...['2026-01', '2026-02', '2026-03'].map((month) => ({workId: 2, month, royaltyYen: 1000, holdSalesYen: 0}))];
  input.royaltyRecoups = [{workId: 2, month: '2026-01', amount: 1000}, {workId: 2, month: '2026-02', amount: 1000}, {workId: 3, month: '2026-02', amount: 999}];
  input.royaltyAdvances = [{workId: 2, advanceYen: 2000}, {workId: 3, advanceYen: 5000}];
  input.royaltyPayments = [...input.royaltyPayments, {statementId: 2, paidOn: '2026-03-31', amount: 1000, weights: [{workId: 2, weight: 1000}]}];
  const report = buildPlBs(input);
  const b = report.workBalances.find((item) => item.code === 'B');
  assert.equal(b.royaltyPayable, 0, '発生3000−充当2000−支払1000');
  assert.equal(b.royaltyRecouped, 2000);
  assert.equal(b.royaltyAdvanceUnrecouped, 0);
  assert.equal(b.origin, 'unverified');
  assert.ok(b.reasons.some((text) => text.includes('前払金（2,000円）の支払の記録が無い')), b.reasons.join());
  assert.equal(report.workBalances.find((item) => item.code === 'C').royaltyPayable, null, '委員会作品の充当は使わない');
  const bs = report.companyBs;
  const bsRow = (key) => row(bs.rows, key);
  assert.equal(bsRow('royalty_payable').value, 0);
  assert.equal(bsRow('royalty_payable').origin, 'unverified');
  assert.equal(bsRow('cash').origin, 'unverified');
  assert.equal(bsRow('cash').value, 9593 - 1000);
  // 充当2000は現預金が減らないまま未払を減らすので、説明のつかない差額に出る（減価償却費30＋2000）
  assert.equal(bs.difference, 30 + 2000);
  assert.equal(bs.hints.at(-1).value, 2000);
  assert.equal(bs.reference.find((item) => item.key === 'royalty_advance_unrecouped').value, 0);
  assert.equal(report.workPl.find((item) => item.code === 'B').period.royalty, 3000, 'PL のロイヤリティは発生額のまま');
});

test('期首の基準月までに計上した制作費が期首の制作中の作品と合わないときは、黙って落とさず未確定にして注意を出す', () => {
  // a: 作品A（公開 2026-02）に 2025-11 計上の制作費10000。期首の制作中の作品（作品付き）は入れていない
  const a = fixture();
  a.expenses = [...a.expenses, {id: 50, workId: 1, month: '2025-11', category: '制作費', accountId:acc('5300'), accountName:'制作費', systemKey:'production_cost', section:'cogs', recognitionTiming:'release_month_once', exTax: 10000, tax: 1000, incTax: 11000}];
  const ra = buildPlBs(a);
  const workA = ra.workPl.find((item) => item.code === 'A');
  assert.equal(workA.origin, 'unverified');
  assert.ok(workA.reasons.some((text) => text.includes('期首の基準月（2025年12月）までに計上した制作費 10,000円') && text.includes('手入力 0円')), workA.reasons.join());
  assert.equal(workA.period.production, 600, '推奨案: PL の制作費は期首残高に置き換えたまま（10000は入れない）');
  assert.equal(row(ra.companyPl.rows, 'production_cost').origin, 'unverified');
  assert.equal(row(ra.companyBs.rows, 'work_in_progress').origin, 'unverified');
  assert.ok(ra.notes.some((note) => note.includes('10,000円')), ra.notes.join());
  // b: 作品Aに期首の制作中の作品 10000 を入れると、理由が消えて公開月に 10000＋500 を費用にする
  const b = fixture();
  b.expenses = a.expenses;
  b.manual = [...b.manual.map((item) => (item.id === 4 ? {...item, amount: -1000 + 10000} : item)), {id: 51, accountId: acc('1300'), month: '2025-12', kind: 'balance', amount: 10000, workId: 1, status: 'reviewed'}];
  const rb = buildPlBs(b);
  const workB = rb.workPl.find((item) => item.code === 'A');
  assert.ok(!workB.reasons.some((text) => text.includes('期首の基準月')), workB.reasons.join());
  assert.equal(workB.period.production, 10600);
  assert.deepEqual(workB.monthly.map((m) => m.production), [0, 10500, 100]);
  // c: 基準月そのもの（2025-12）に計上した制作費でも同じ理由が出る
  const c = fixture();
  c.expenses = [...c.expenses, {id: 52, workId: 1, month: '2025-12', category: '制作費', accountId:acc('5300'), accountName:'制作費', systemKey:'production_cost', section:'cogs', recognitionTiming:'release_month_once', exTax: 700, tax: 70, incTax: 770}];
  assert.ok(buildPlBs(c).workPl.find((item) => item.code === 'A').reasons.some((text) => text.includes('制作費 700円')));
  // d: 公開月が基準月以前の作品に基準月以前の制作費があっても理由を出さない（その時点で費用になっている）
  const d = fixture();
  d.works = d.works.map((work) => (work.id === 1 ? {...work, releaseMonth: '2025-10'} : work));
  d.expenses = [...d.expenses, {id: 53, workId: 1, month: '2025-09', category: '制作費', accountId:acc('5300'), accountName:'制作費', systemKey:'production_cost', section:'cogs', recognitionTiming:'release_month_once', exTax: 900, tax: 90, incTax: 990}];
  assert.ok(!buildPlBs(d).workPl.find((item) => item.code === 'A').reasons.some((text) => text.includes('期首の基準月')));
});

test('BSの基準月が期首残高の基準月より前なら、残高は出さず理由を出す（PL はそのまま）', () => {
  const base = buildPlBs(fixture());
  for (const overrides of [{asOf: '2025-11'}, {from: '2025-06', to: '2025-09', asOf: undefined}]) {
    const report = buildPlBs(fixture(overrides));
    assert.ok(report.notes.some((note) => note.includes('期首残高の基準月（2025年12月末）より前')), JSON.stringify(report.notes));
    assert.equal(report.companyBs.unavailable, true);
    assert.deepEqual(report.companyBs.rows, []);
    assert.deepEqual(report.workBalances, []);
    assert.equal(report.bsUnavailable, report.companyBs.reason);
    assert.ok(report.checks.every((item) => !/売掛金|説明できない/.test(item.item)), '残高を使う照合は外す');
    const sheets = plBsSheets({...report, profile: null, dataAsOf: {}}, 'company-bs');
    assert.equal(sheets.length, 1, '理由だけのシート');
  }
  assert.deepEqual(buildPlBs(fixture({asOf: '2025-11'})).companyPl.rows.map((item) => item.values.period), base.companyPl.rows.map((item) => item.values.period), 'PL は同じ');
  assert.equal(buildPlBs(fixture({asOf: '2025-12'})).companyBs.unavailable, undefined, '期首の基準月と同じ月は出す');
});

test('会社全体の注意（現預金がマイナス・期首の基準月が未設定）は companyNotes、照合は会社の分と作品の分を分ける', () => {
  const report = buildPlBs(fixture({manual: fixture().manual.filter((item) => item.accountId !== acc('1100')), expensePayments: [...fixture().expensePayments, {id: 9, expenseId: 4, paidOn: '2026-03-31', amount: 44}]}));
  assert.ok(report.companyNotes.some((note) => note.includes('現預金がマイナス')), report.companyNotes.join());
  assert.ok(!report.notes.some((note) => /現預金|期首残高の基準月が未設定/.test(note)));
  assert.ok(report.checks.every((item) => item.scope === 'company' || item.scope === 'work'));
  assert.deepEqual(report.checks.filter((item) => item.scope === 'work').map((item) => item.item), ['作品別PLの月別の利益の和 ＝ 期間計（作品ごと）']);
  assert.ok(report.checks.filter((item) => item.scope === 'company').length >= 5);
});

test('委員会からの受取が取得額の累計を上回ると、未収はマイナスのまま未確定にし、注意と参考の行を出す（差額は変わらない）', () => {
  const base = buildPlBs(fixture());
  const report = buildPlBs(fixture({committeeReceipts: [{workId: 3, receivedOn: '2026-03-20', amount: 250}]}));
  const c = report.workBalances.find((item) => item.code === 'C');
  assert.equal(c.committeeReceivable, 200 - 250);
  assert.equal(c.origin, 'unverified');
  assert.ok(c.reasons.some((text) => text.includes('50円上回って')), c.reasons.join());
  assert.equal(row(report.companyBs.rows, 'committee_receivable').origin, 'unverified');
  assert.ok(report.notes.some((note) => note.includes('委員会からの受取が自社の取得額の累計を上回る')));
  assert.equal(report.companyBs.reference.find((item) => item.key === 'committee_over_received').value, 50);
  assert.equal(report.companyBs.difference, base.companyBs.difference, '受取は現預金と未収を同じ額動かすので差額は変わらない');
});

test('手入力の費用の消費税額: PL は税抜、現預金は税込で減り、未払消費税等は仮払で減る。差額は変わらない', () => {
  const base = buildPlBs(fixture());
  const input = fixture();
  input.manual = [...input.manual, {id: 60, accountId: acc('6260'), month: '2026-02', kind: 'flow', amount: 100000, tax: 10000, status: 'reviewed'},
    {id: 61, accountId: acc('6280'), month: '2026-02', kind: 'flow', amount: 5, tax: 999, status: 'reviewed'}]; // 減価償却費の税額は使わない
  const report = buildPlBs(input);
  const value = (r, key) => row(r.companyBs.rows, key).value;
  assert.equal(row(report.companyPl.rows, `manual:${acc('6260')}`).values.period, 100000);
  assert.equal(value(report, 'cash') - value(base, 'cash'), -110000);
  assert.equal(value(report, 'consumption_tax') - value(base, 'consumption_tax'), -10000);
  assert.equal(report.companyBs.cashFlows.manualCostTax, 10000);
  assert.equal(report.companyBs.hints.at(-1).value, 0, '説明のつかない残りは0のまま');
  assert.equal(report.companyBs.difference, base.companyBs.difference + 5, '減価償却費5（現預金を動かさない）だけ増える');
});

test('経費の費目の区分: 「制作費」で始まる費目だけが制作費。製作費・パッケージ製作費は直接費。自社作品の期間の経費を区分ごとに返す', () => {
  assert.equal(classifyExpense('製作費'), 'direct_cost');
  assert.equal(classifyExpense('直接製作費'), 'direct_cost');
  assert.equal(classifyExpense('パッケージ製作費'), 'direct_cost');
  assert.equal(classifyExpense('配信マスター制作費'), 'direct_cost');
  const report = buildPlBs(fixture());
  assert.deepEqual(report.expenseClassification.map((item) => [item.category, item.kind, item.count, item.exTax]), [
    ['制作費', 'production_cost', 2, 600], ['P&A', 'promotion', 1, 200], ['事務費', 'work_other_expense', 2, 80], ['パッケージ製作費', 'direct_cost', 1, 40],
  ], '委員会作品の経費（P&A 300）は除き、会社共通の経費も対応を示す');
  assert.equal(report.expenseClassification[0].label, '制作費');
});

test('出金・払込の送信: 失敗したら false（入力を消さない）、成功したら true。取消日は出金日以後', async () => {
  const events = [];
  const conflict = Object.assign(new Error('他の人が先に出金を記録しました'), {kind: 'conflict', status: 409});
  assert.equal(await runAction(async () => { throw conflict; }, {onStart: () => events.push('start'), onOk: () => events.push('ok'), onError: (error) => events.push(error.kind), onFinally: () => events.push('end')}), false);
  assert.deepEqual(events, ['start', 'conflict', 'end']);
  assert.equal(await runAction(async () => { throw Object.assign(new Error('取消日は出金日以後'), {status: 400}); }), false);
  assert.equal(await runAction(async () => {}, {onOk: () => events.push('ok')}), true);
  assert.equal(events.at(-1), 'ok');
  assert.equal(reversalDateError({paidOn: '2026-05-31', reversedOn: '2026-05-30'}), '取消日は出金日以後の日付で入れてください');
  assert.equal(reversalDateError({paidOn: '2026-05-31', reversedOn: '2026-05-31'}, '払込日'), null);
  // 画面は run の結果が true のときだけ入力を空にし、取消の欄を閉じる（.then で成否によらず閉じない）
  const source = readFileSync(new URL('../src/pl-bs/ExpensePayments.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.then\(\(\) => setReverse\(null\)\)/);
  assert.equal((source.match(/setForm\(\(f\) => \(\{\.\.\.f, amount: '', note: ''\}\)\)/g) || []).length, 1);
  assert.ok(source.split('\n').filter((line) => line.includes("amount: '', note: ''")).every((line) => /if \(await run\(|\)\) setForm/.test(line)), '入力を空にするのは成功の後だけ');
});
