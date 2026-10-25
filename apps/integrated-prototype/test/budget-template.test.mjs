// 予算書の型の書き出しと、内訳（キャストの別シート＋SUMIF）の読み取りを、DB を使わずに確かめる（src/planning/budget/budget-xlsx-write.mjs・budget-xlsx.mjs）。
// 期待値は要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-026〜030 と、架空の行から手で書いた
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBudgetWorkbook} from '../src/planning/budget/budget-xlsx-write.mjs';
import {parseBreakdownFormula, readBudgetFile, readBudgetWorkbook} from '../src/planning/budget/budget-xlsx.mjs';
import {budgetVerdict, checkParsedBudget, normalizeBudgetVersionInput, versionInputFromParsed} from '../src/planning/budget/budget-model.mjs';
import {buildBudgetXlsx} from './fixtures/folder-budget/build-budget-xlsx.mjs';

const CAST = {sheet: 'キャスト', items: [
  {label: '主演', qtyMilli: 5000, unitPriceYen: 200000, amountExTaxYen: 1000000},
  {label: 'ヒロイン', qtyMilli: 4000, unitPriceYen: 100000, amountExTaxYen: 400000},
  {label: 'その他', amountExTaxYen: 340000},
]};
const LINES = [
  {categoryCode: 'A', name: '脚本料', unitPriceYen: 200000, qtyMilli: 2000, unit: '本', amountExTaxYen: 400000},
  {categoryCode: 'B', name: 'キャスト費', breakdown: CAST},
  {categoryCode: 'B', name: 'エキストラ', amountExTaxYen: 150000, confirmed: true},
  {categoryCode: 'D', name: '助監督', unitPriceYen: 120000, qtyMilli: 2500, unit: '週', amountExTaxYen: 300000},
  {categoryCode: 'H', name: 'ロケ地', amountExTaxYen: 300000},
];

test('FR-PLAN-BUDGET-026 FR-PLAN-BUDGET-027 予算書を書き出すと、合計は数式で、キャスト費は別のシートから SUMIF で足し、読み直すと同じ行・同じ額・例外なしに戻る', () => {
  const {bytes, totals} = buildBudgetWorkbook({title: '架空 夜行列車', lines: LINES, managementFeeYen: 100000, contingencyYen: 50000, taxRateBps: 1000});
  // 1740000 + 400000 + 150000 + 300000 + 300000 = 2,890,000、＋管理費＋予備費 = 3,040,000、消費税 304,000
  assert.deepEqual([totals.directYen, totals.totalExTaxYen, totals.taxYen], [2890000, 3040000, 304000]);
  const sheets = readBudgetWorkbook(bytes);
  assert.deepEqual(sheets.map((s) => s.name), ['予算', 'キャスト']);
  const formulas = [...sheets[0].cells.values()].filter((c) => c.formula).map((c) => c.formula);
  assert.ok(formulas.some((f) => /^SUMIF\('キャスト'!\$A\$3:\$A\$500,B\d+,'キャスト'!\$E\$3:\$E\$500\)$/.test(f)), 'キャスト費は SUMIF で足す');
  assert.ok(formulas.some((f) => /^ROUNDDOWN\(C6\*1000\/10000,0\)$/.test(f)), '消費税は総合計に1回だけ切り捨て');
  const parsed = readBudgetFile(bytes);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.breakdownSheets, ['キャスト']);
  const cast = parsed.lines.find((l) => l.name === 'キャスト費');
  assert.deepEqual([cast.categoryCode, cast.amountExTaxYen, cast.breakdown.items.map((i) => [i.label, i.amountExTaxYen])],
    ['B', 1740000, [['主演', 1000000], ['ヒロイン', 400000], ['その他', 340000]]]);
  assert.equal(cast.breakdown.items[0].qtyMilli, 5000);
  assert.equal(parsed.lines.find((l) => l.name === 'エキストラ').confirmed, true);
  const {checks, totals: read} = checkParsedBudget(parsed);
  assert.equal(read.totalExTaxYen, 3040000);
  assert.deepEqual(budgetVerdict(checks).failedKeys, []);
  // 読んだ版は内訳ごと版の本文になり、行の金額＝内訳の和を満たす
  const value = normalizeBudgetVersionInput(versionInputFromParsed(parsed, {reason: '架空'}));
  assert.equal(value.ok, true, JSON.stringify(value.errors));
  assert.equal(value.value.lines.find((l) => l.name === 'キャスト費').breakdown.items.length, 3);
});

test('FR-PLAN-BUDGET-028 型を書き出すと、額の無い費目も行として残り、型として読み直すと同じ費目が並ぶ', () => {
  const lines = [{categoryCode: 'A', name: '企画開発費'}, {categoryCode: 'B', name: 'キャスト費', breakdown: {sheet: 'キャスト', items: []}},
    {categoryCode: 'D', name: '撮影技師', unitPriceYen: 50000, qtyMilli: 9000, unit: '日'}, {categoryCode: 'K', name: '試写会場代'}];
  const {bytes, totals} = buildBudgetWorkbook({title: 'Vシネ 2〜3本撮り v1', lines, template: true});
  assert.equal(totals.totalExTaxYen, 450000); // 単価×数量の入った費目だけ額がある
  const asTemplate = readBudgetFile(bytes, {keepEmpty: true});
  assert.deepEqual(asTemplate.lines.map((l) => [l.categoryCode, l.name]), [['A', '企画開発費'], ['B', 'キャスト費'], ['D', '撮影技師'], ['K', '試写会場代']]);
  assert.equal(asTemplate.lines.find((l) => l.name === '撮影技師').qtyMilli, 9000);
  // 予算書として読むと額の無い行は明細にしない（内訳を別シートから足す行は、内訳を読むために残る）
  assert.deepEqual(readBudgetFile(bytes).lines.map((l) => [l.name, l.amountExTaxYen]), [['キャスト費', 0], ['撮影技師', 450000]]);
});

test('FR-PLAN-BUDGET-030 キャストの別シートの SUMIF の範囲が内訳の行を落としていると、行の額と内訳の和が合わない例外にし、範囲の外の行に印を付ける', () => {
  // 代表の予算表の形: 予算!C16 = SUMIF(キャスト!A3:A13, B16, キャスト!E3:E13)。14行目の「追加の助演」が範囲の外
  const budget = [
    {ref: 'B10', value: '科目'}, {ref: 'C10', value: '単価'}, {ref: 'D10', value: '数量'}, {ref: 'F10', value: '金額(税抜)'},
    {ref: 'B16', value: 'キャスト費'}, {ref: 'F16', value: 2100000, formula: 'SUMIF(キャスト!$A$3:$A$13,B16,キャスト!$E$3:$E$13)'},
    {ref: 'B17', value: 'エキストラ'}, {ref: 'F17', value: 300000},
    {ref: 'B18', value: 'B 俳優費'}, {ref: 'D18', value: '小計'}, {ref: 'F18', value: 2400000, formula: 'SUM(F16:F17)'},
  ];
  const cast = [
    {ref: 'A2', value: '費目'}, {ref: 'B2', value: '役名'}, {ref: 'C2', value: '日数'}, {ref: 'D2', value: '日額'}, {ref: 'E2', value: '金額'},
    {ref: 'A3', value: 'キャスト費'}, {ref: 'B3', value: '主演'}, {ref: 'C3', value: 5}, {ref: 'D3', value: 200000}, {ref: 'E3', value: 1000000},
    {ref: 'A4', value: 'キャスト費'}, {ref: 'B4', value: 'ヒロイン'}, {ref: 'E4', value: 400000},
    {ref: 'A5', value: 'キャスト費'}, {ref: 'B5', value: 'その他'}, {ref: 'E5', value: 700000},
    {ref: 'A6', value: 'スタッフ費'}, {ref: 'B6', value: '別の費目の行'}, {ref: 'E6', value: 999999},
    {ref: 'A14', value: 'キャスト費'}, {ref: 'B14', value: '追加の助演'}, {ref: 'E14', value: 150000},
  ];
  const parsed = readBudgetFile(buildBudgetXlsx([{name: '予算', cells: budget}, {name: 'キャスト', cells: cast}]));
  const line = parsed.lines.find((l) => l.name === 'キャスト費');
  assert.deepEqual(line.breakdown.items.map((i) => [i.label, i.amountExTaxYen, i.inRange]),
    [['主演', 1000000, true], ['ヒロイン', 400000, true], ['その他', 700000, true], ['追加の助演', 150000, false]]);
  assert.equal(line.amountExTaxYen, 2250000); // 行の金額は内訳の和
  assert.deepEqual(parsed.breakdownChecks.map((c) => [c.cell, c.ok, c.reason, c.statedYen, c.derivedYen, c.outside]),
    [['F16', false, 'outside_range', 2100000, 2250000, ['E14']]]);
  const {checks} = checkParsedBudget(parsed);
  const failed = budgetVerdict(checks).failedKeys;
  assert.ok(failed.includes('breakdown:F16'));
  assert.ok(failed.includes('subtotal:B')); // B の小計も内訳の和で 2,550,000 になり、原本の 2,400,000 と合わない
  assert.deepEqual(parsed.otherSheets, []);
});

test('FR-PLAN-BUDGET-030 別シートを足す式の読み方: セルの条件・文字の条件・SUM の範囲を読み、読めない式は印を付ける', () => {
  const cell = (ref) => ({B16: 'キャスト費'})[ref] ?? '';
  assert.deepEqual(parseBreakdownFormula("SUMIF('キャスト 一覧'!$A:$A,$B16,'キャスト 一覧'!$E:$E)", cell),
    {kind: 'sumif', sheet: 'キャスト 一覧', criteriaCol: 'A', sumCol: 'E', from: null, to: null, criteria: 'キャスト費'});
  assert.equal(parseBreakdownFormula('SUMIF(キャスト!A3:A9,"スタッフ費",キャスト!E3:E9)').criteria, 'スタッフ費');
  assert.deepEqual(parseBreakdownFormula('SUM(スタッフ!E3:E20)'), {kind: 'sum', sheet: 'スタッフ', sumCol: 'E', from: 3, to: 20});
  assert.equal(parseBreakdownFormula('SUMIF(A!A3:A9,B16,B!E3:E9)', cell).kind, 'unsupported');
  assert.equal(parseBreakdownFormula('C16*D16'), null);
});

test('FR-PLAN-BUDGET-029 内訳のある行は、税抜額が内訳の和と違えば断る', () => {
  const bad = normalizeBudgetVersionInput({reason: '架空', lines: [{categoryCode: 'B', name: 'キャスト費', amountExTaxYen: 100, breakdown: {sheet: 'キャスト', items: [{label: '主演', amountExTaxYen: 90}]}}]});
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('内訳の和（90）')));
});

test('FR-PLAN-BUDGET-031 区分の名前を変えた・伏せた予算書は、小計の行の並び（左で A〜E、右で F〜K）から区分を当てて補った印を付け、英字で A〜K の外を書いた行には当てない', () => {
  const cells = [
    {ref: 'B10', value: '科目'}, {ref: 'D10', value: '数量'}, {ref: 'F10', value: '金額(税抜)'},
    {ref: 'B11', value: '脚本料'}, {ref: 'F11', value: 400000},
    {ref: 'B12', value: '架空の名前1'}, {ref: 'D12', value: '小計'}, {ref: 'F12', value: 400000},
    {ref: 'B13', value: '主演'}, {ref: 'F13', value: 300000},
    {ref: 'B14', value: '出演費'}, {ref: 'D14', value: '小計'}, {ref: 'F14', value: 300000},
    {ref: 'B15', value: '雑費'}, {ref: 'F15', value: 1000},
    {ref: 'B16', value: 'L 雑費'}, {ref: 'D16', value: '小計'}, {ref: 'F16', value: 1000},
  ];
  const parsed = readBudgetFile(buildBudgetXlsx([{name: '予算', cells}]));
  assert.deepEqual(parsed.lines.map((l) => [l.name, l.categoryCode]), [['脚本料', 'A'], ['主演', 'B']]);
  assert.deepEqual(parsed.inferredCategories.map((c) => [c.cell, c.code]), [['B12', 'A'], ['B14', 'B']]);
  assert.deepEqual(parsed.unknownSubtotals.map((r) => r.cell), ['B16']);
});
