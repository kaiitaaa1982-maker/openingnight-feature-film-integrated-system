import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCommitteeMonthly} from '../src/committee/committee-monthly-model.mjs';
import {
  pivotValue, pivotColumns, committeeMonthlySheets, parsePercentToBps, feeShareDraftState, feeShareText, sourceRows, investorRows, SHEET_NAMES,
} from '../src/committee/committee-monthly-view.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';

const W = {id: 11, kind: 'digital', kindLabel: '配信', label: '配信', windowPartnerId: 1, windowPartnerName: 'A社', platformRateBps: 0, windowFeeBps: 1000, managerFeeBps: 0,
  feeOrder: 'window_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'platform_net'};
const MEMBERS = [{partnerId: 1, name: 'A社', shareBps: 6000, memberOrder: 1}, {partnerId: 2, name: 'B社', shareBps: 4000, memberOrder: 2}];

function sampleBody() {
  const report = buildCommitteeMonthly({
    from: '2026-01', to: '2026-02', fiscalStartMonth: 5,
    incomeRows: [{month: '2026-01', channelGroup: 'digital', windowKind: 'digital', windowId: 11, sales: 10000, netReportedSales: 0, platformFee: 0, windowFee: 1000, managerFee: 0, income: 9000, hold: null}],
    expenses: [{month: '2026-02', category: '宣伝', amount: 500}],
    accruals: [{agreementId: 1, workId: 1, holderName: '監督A', category: 'director', accrualMonth: '2026-01', baseYen: 9000, royaltyYen: 900, holdSalesYen: 0}],
    lines: [{saleId: 1, reportId: 1, accountingMonth: '2026-01', amount: 10000, allocationBps: 10000, basisSource: 'default'}],
    expenseLines: [{id: 1, workId: 1, month: '2026-02', category: '宣伝', amount: 500}],
    members: MEMBERS, windows: [W], investments: [{partnerId: 1, amountYen: 6000}, {partnerId: 2, amountYen: 4000}],
  });
  return {
    work: {id: 1, code: 'W', title: '作品'}, contract: {code: 'C', title: '契約'}, term: {versionNo: 1},
    notes: ['注記'], report,
    incomeRows: [{month: '2026-01', channelGroup: 'digital', channelLabel: '配信', windowKind: 'digital', windowKindLabel: '配信', windowLabel: '配信', sales: 10000, platformFee: 0, windowFee: 1000, managerFee: 0, income: 9000, hold: null, holdText: null, lineCount: 1}],
    accruals: [{agreementId: 1, holderName: '監督A', category: 'director', categoryLabel: '監督料', accrualMonth: '2026-01', baseYen: 9000, royaltyYen: 900, holdSalesYen: 0}],
    lines: [{saleId: 1, allocationBps: 10000, accountingMonth: '2026-01', channelLabel: '配信', partnerName: '架空配信', description: '配信売上', reportKey: 'R1',
      basisText: '控除前', basisSourceText: '未確認（控除前として計算）', windowLabel: '配信', amount: 10000, holdText: null, sourceRow: 2, distributionLabel: null}],
    expenseLines: [{id: 1, month: '2026-02', category: '宣伝', description: '広告', partnerName: null, amount: 500}],
  };
}

test('月次収支の表: 行＝項目・列＝月〜累計。率の行は％の文字、出資額0円は「—」、未登録は未確認（null）', () => {
  const body = sampleBody();
  const columns = pivotColumns(body.report);
  assert.equal(columns[0].label, '項目');
  assert.ok(columns.every((column) => column.sortable === false), '項目の並びを崩さない');
  assert.deepEqual(columns.slice(1).map((column) => column.label), ['2026年1月', '2026年2月', '期間計', '累計']);
  const rate = body.report.rows.find((row) => row.key === 'rate:1');
  assert.match(pivotValue(rate, 'cumulative'), /^\d+(\.\d)?%$/);
  assert.equal(pivotValue({unit: 'rate', investmentKnown: true, values: {x: null}}, 'x'), '—');
  assert.equal(pivotValue({unit: 'rate', investmentKnown: false, values: {x: null}}, 'x'), null);
  assert.equal(pivotValue({unit: 'yen', values: {x: -5}}, 'x'), -5);
  const label = columns[0].value(body.report.rows.find((row) => row.level === 1));
  assert.ok(label.startsWith('　'), '内訳の行は字下げ');
});

test('Excel は6シート（月次収支／出資者別／区分別売上／権利処理費の内訳／元明細／照合）で、書き出して読み戻せる', () => {
  const body = sampleBody();
  const sheets = committeeMonthlySheets(body, {title: '製作委員会の月次収支（作品）', conditions: [['期間', '2026年1月〜2月']], dataAsOf: null});
  assert.deepEqual(sheets.map((sheet) => sheet.name), SHEET_NAMES);
  assert.deepEqual(SHEET_NAMES, ['月次収支', '出資者別', '区分別売上', '権利処理費の内訳', '元明細', '照合']);
  assert.equal(sheets[0].totals.length, 0, '月次収支は行ごとの意味が違うので合計行を付けない');
  assert.equal(sheets[4].rows.length, 2, '元明細は売上明細と経費');
  const workbook = decodeXlsx(encodeReportXlsx({sheets}));
  assert.deepEqual(workbook.map((sheet) => sheet.name), SHEET_NAMES);
  const text = JSON.stringify(workbook);
  for (const english of ['platformFee', 'windowFee', 'undefined', 'NaN', 'director']) assert.ok(!text.includes(english), english);
  for (const japanese of ['分配原資', '権利処理費｜監督料', '本委員会収入', '回収率']) assert.ok(text.includes(japanese), japanese);
});

test('元明細・出資者別の行の作り方', () => {
  const body = sampleBody();
  const rows = sourceRows(body);
  assert.deepEqual(rows.map((row) => [row.kind, row.month, row.amount]), [['売上', '2026-01', 10000], ['経費', '2026-02', 500]]);
  assert.equal(rows[0].basisText, '控除前（未確認（控除前として計算））');
  const investors = investorRows(body.report);
  assert.equal(investors.length, 2);
  assert.equal(investors[0].windowKindLabels, '配信');
  assert.equal(investors[0].cumulativeAcquisition, investors[0].cumulative.acquisition);
});

test('窓口手数料の取り分の入力: ％を bp にし、合計100%・理由を確かめる', () => {
  assert.deepEqual(parsePercentToBps('50'), {ok: true, bps: 5000});
  assert.deepEqual(parsePercentToBps('33.33'), {ok: true, bps: 3333});
  assert.deepEqual(parsePercentToBps('５０％'), {ok: true, bps: 5000}, '全角・％を吸収');
  assert.deepEqual(parsePercentToBps(' '), {ok: true, bps: null});
  assert.equal(parsePercentToBps('33.333').ok, false);
  assert.equal(parsePercentToBps('0').ok, false);
  assert.equal(parsePercentToBps('100.01').ok, false);
  assert.equal(parsePercentToBps('abc').ok, false);
  const candidates = [{partnerId: 1, name: 'A社'}, {partnerId: 2, name: 'B社'}];
  const empty = feeShareDraftState(candidates, {}, '');
  assert.equal(empty.ok, false);
  assert.equal(empty.dirty, false);
  const partial = feeShareDraftState(candidates, {1: '60', 2: '30'}, '第8条');
  assert.equal(partial.ok, false);
  assert.match(partial.errors.join(), /いまは90%/);
  const good = feeShareDraftState(candidates, {1: '66.67', 2: '33.33'}, ' 第8条 ');
  assert.equal(good.ok, true);
  assert.deepEqual(good.payload, {shares: [{partnerId: 1, shareBps: 6667}, {partnerId: 2, shareBps: 3333}], reason: '第8条'});
  const noReason = feeShareDraftState(candidates, {1: '100'}, '');
  assert.equal(noReason.ok, false);
  assert.match(noReason.errors.join(), /理由/);
  assert.equal(feeShareText({feeShares: [{partnerId: 1, name: 'A社', shareBps: 10000}], feeSharesRegistered: false}), 'A社 100%（登録なし＝窓口の受取先が100%）');
  assert.equal(feeShareText({feeShares: [], feeSharesRegistered: true}), '登録が不完全（合計が100%ではありません）');
});
