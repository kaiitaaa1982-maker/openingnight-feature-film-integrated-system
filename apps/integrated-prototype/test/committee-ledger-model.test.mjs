// 製作委員会の契約の式・日程・台帳（src/committee/ledger/）の試験。
// 期待値は実装を使わずに別に計算した値（分数で計算して最後に切り捨て。日付は暦から）。データはすべて架空。
import test from 'node:test';
import assert from 'node:assert/strict';
import {factorRateAmount} from '../src/money-allocation.mjs';
import {calcBusiness, calcCommittee, splitToMembers, calcRound} from '../src/committee/ledger/committee-formula-model.mjs';
import {roundsFor, yearIndex, previousBusinessDay, applyCarry} from '../src/committee/ledger/committee-schedule-model.mjs';
import {entriesFromRound, statement, cumulativeBy, checkReportedPrior, entriesFromReport, compareWithFormula} from '../src/committee/ledger/committee-ledger-model.mjs';

// 架空の委員会「星の港」。当事者4社、総事業費（閾値）1億円、出資金の総額1億円
const MEMBERS = [
  {partnerId: 'K', shareBps: 5000},
  {partnerId: 'L', shareBps: 2500},
  {partnerId: 'SELF', shareBps: 1250},
  {partnerId: 'M', shareBps: 1250},
];
const roy = (holderRole, rateBps, deductExpenses) => ({kind: 'secondary_royalty', holderRole, counterparty: `holder-${holderRole}`, rateBps, deductExpenses});
const fee = (rateBps, base, counterparty) => ({kind: 'agent_fee', rateBps, base, counterparty});
const businesses = (round) => round === 1 ? [
  {key: 'theatrical', incomeYen: 92500000, steps: [{kind: 'expense', amountYen: 24000000, item: '宣伝費'}, {kind: 'expense', amountYen: -24000000, item: 'P&A出資金充当'}, fee(2000, 'income', 'K')]},
  {key: 'home_video', incomeYen: 10000000, steps: [{kind: 'expense', amountYen: 2000000, item: '必要経費'}, roy('原作', 375, true), roy('監督', 150, false), roy('脚本', 150, false), fee(3000, 'remaining', 'SELF')]},
  {key: 'svod', incomeYen: 30000000, steps: [roy('原作', 300, true), roy('監督', 150, false), roy('脚本', 150, false), fee(2000, 'income', 'K')]},
  {key: 'tv', incomeYen: 4000000, steps: [roy('原作', 400, true), roy('監督', 200, false), roy('脚本', 200, false), fee(2000, 'income', 'L')]},
] : [
  {key: 'theatrical', incomeYen: 200000, steps: [fee(2000, 'income', 'K')]},
  {key: 'home_video', incomeYen: 400000, steps: [roy('原作', 375, true), roy('監督', 150, false), roy('脚本', 150, false), fee(3000, 'remaining', 'SELF')]},
  {key: 'svod', incomeYen: 2000000, steps: [roy('原作', 300, true), roy('監督', 150, false), roy('脚本', 150, false), fee(2000, 'income', 'K')]},
  {key: 'tv', incomeYen: 1500000, steps: [roy('原作', 400, true), roy('監督', 200, false), roy('脚本', 200, false), fee(2000, 'income', 'L')]},
];
const committeeSteps = (overheadYen) => [
  {kind: 'overhead', amountYen: overheadYen, item: '振込手数料'},
  {kind: 'manager_fee', rateBps: 500, base: 'remaining', counterparty: 'K'},
  {kind: 'success_fee', rateBps: 1200, thresholdYen: 100000000, mode: 'excess', counterparty: 'K'},
];

test('FR-SETL-COMM-003 二次使用料は（収入×係数−経費）×料率×後の係数で、最後に1回だけ切り捨てる', () => {
  assert.equal(factorRateAmount({amount: 3000000, grossFactorBps: 8000, minusYen: 600000, rateBps: 335}), 60300);
  assert.equal(factorRateAmount({amount: 3000000, rateBps: 335, afterFactorBps: 9000}), 90450);
  assert.equal(factorRateAmount({amount: 1234567, grossFactorBps: 8000, rateBps: 335, afterFactorBps: 9000}), 29777);
  assert.equal(factorRateAmount({amount: -1000, rateBps: 335}), -33); // 返品は符号に対して対称の切り捨て
  assert.throws(() => factorRateAmount({amount: 1.5, rateBps: 335}), /整数の円/);
});

test('FR-SETL-COMM-001 FR-SETL-COMM-002 事業の式は並べた順に引き、窓口手数料の基礎は収入か残り', () => {
  const lane = calcBusiness(businesses(1)[1]);
  assert.deepEqual(lane.steps.map((s) => s.amountYen), [2000000, 300000, 150000, 150000, 2220000]);
  assert.equal(lane.steps[4].baseYen, 7400000); // 残り＝収入−経費−二次使用料
  assert.equal(lane.distributionYen, 5180000);
  // 原作の二次使用料を経費より前に置くと、経費を引かずに計算され配分金が変わる
  const reordered = calcBusiness({incomeYen: 10000000, steps: [roy('原作', 375, true), {kind: 'expense', amountYen: 2000000}, fee(3000, 'remaining')]});
  assert.equal(reordered.steps[0].amountYen, 375000);
  assert.equal(reordered.distributionYen, 10000000 - 375000 - 2000000 - 2287500);
  assert.equal(calcBusiness({incomeYen: 200000, steps: [fee(2000, 'income')]}).distributionYen, 160000);
  assert.throws(() => calcBusiness({incomeYen: 1, steps: [{kind: 'manager_fee'}]}), /置けない段/);
  assert.throws(() => calcBusiness({incomeYen: 1, steps: [{kind: 'agent_fee', rateBps: 2000}]}), /基礎/);
});

test('FR-SETL-COMM-004 FR-SETL-COMM-005 FR-SETL-COMM-006 委員会全体は A から順に引き、成功報酬は累計で超えた分', () => {
  const r1 = calcCommittee({aYen: 104260000, steps: committeeSteps(3000)});
  assert.deepEqual(r1.steps.map((s) => s.amountYen), [3000, 5212850, 0]);
  assert.equal(r1.poolYen, 99044150);
  const r2 = calcCommittee({aYen: 2981100, steps: committeeSteps(1000), priorSuccessBaseYen: r1.successBaseCumulativeYen});
  assert.deepEqual(r2.steps.map((s) => s.amountYen), [1000, 149005, 225029]);
  assert.equal(r2.poolYen, 2606066);
  // 2回に分けても、通期で1回に計算した成功報酬と同じ
  const once = calcCommittee({aYen: 104260000 + 2981100, steps: [{kind: 'success_fee', rateBps: 1200, thresholdYen: 100000000, mode: 'excess'}]});
  const split = calcCommittee({aYen: 104260000, steps: [{kind: 'success_fee', rateBps: 1200, thresholdYen: 100000000, mode: 'excess'}]});
  const split2 = calcCommittee({aYen: 2981100, steps: [{kind: 'success_fee', rateBps: 1200, thresholdYen: 100000000, mode: 'excess'}], priorSuccessBaseYen: split.successBaseCumulativeYen});
  assert.equal(split.steps[0].amountYen + split2.steps[0].amountYen, once.steps[0].amountYen);
  // 幹事手数料を2社に、どちらも A を基礎に
  const two = calcCommittee({aYen: 1000000, steps: [{kind: 'manager_fee', rateBps: 300, base: 'a'}, {kind: 'manager_fee', rateBps: 200, base: 'a'}]});
  assert.deepEqual(two.steps.map((s) => s.amountYen), [30000, 20000]);
  assert.equal(two.poolYen, 950000);
});

test('FR-SETL-COMM-007 回収後は A×率。閾値に届く回の扱いを指定しないと計算しない', () => {
  const step = {kind: 'success_fee', rateBps: 500, thresholdYen: 1000000, mode: 'after_recoup'};
  assert.equal(calcCommittee({aYen: 300000, steps: [step], priorSuccessBaseYen: 500000}).steps[0].amountYen, 0);
  assert.equal(calcCommittee({aYen: 300000, steps: [step], priorSuccessBaseYen: 1200000}).steps[0].amountYen, 15000);
  assert.throws(() => calcCommittee({aYen: 800000, steps: [step], priorSuccessBaseYen: 500000}), /crossingRule/);
  assert.equal(calcCommittee({aYen: 800000, steps: [{...step, crossingRule: 'whole_period'}], priorSuccessBaseYen: 500000}).steps[0].amountYen, 40000);
  assert.equal(calcCommittee({aYen: 800000, steps: [{...step, crossingRule: 'excess_part'}], priorSuccessBaseYen: 500000}).steps[0].amountYen, 15000);
});

test('FR-SETL-COMM-008 配分原資は持分で最大剰余法、和は D と一致', () => {
  assert.deepEqual(splitToMembers(99044150, MEMBERS).map((d) => d.amountYen), [49522075, 24761037, 12380519, 12380519]);
  assert.deepEqual(splitToMembers(2606066, MEMBERS).map((d) => d.amountYen), [1303033, 651517, 325758, 325758]);
  assert.throws(() => splitToMembers(100, [{partnerId: 'X', shareBps: 9000}]), /100%/);
});

test('FR-SETL-COMM-009 1回の計算は保存則を満たす', () => {
  const r = calcRound({businesses: businesses(2), committeeSteps: committeeSteps(1000), members: MEMBERS, priorSuccessBaseYen: 99044150});
  assert.equal(r.aYen, 2981100);
  assert.equal(r.committee.poolYen, 2606066);
  assert.equal(r.incomeYen, 4100000);
});

test('FR-SETL-COMM-010 FR-SETL-COMM-011 FR-SETL-COMM-012 日程の式から回が出て、3年目から年1回、支払は前の営業日へ', () => {
  const phases = [
    {tier: 'to_members', fromYear: 1, toYear: 2, closeMonths: [2, 5, 8, 11], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, holidayRule: 'previous_business_day'},
    {tier: 'to_members', fromYear: 3, toYear: null, closeMonths: [8], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, holidayRule: 'previous_business_day'},
  ];
  const rounds = roundsFor({baseDate: '2031-05-01', phases, tier: 'to_members', untilDate: '2034-12-31'});
  assert.deepEqual(rounds.map((r) => [r.closeOn, r.reportOn, r.payOn]), [
    ['2031-05-31', '2031-07-31', '2031-08-29'],
    ['2031-08-31', '2031-10-31', '2031-11-28'],
    ['2031-11-30', '2032-01-31', '2032-02-27'],
    ['2032-02-29', '2032-04-30', '2032-05-31'],
    ['2032-05-31', '2032-07-31', '2032-08-31'],
    ['2032-08-31', '2032-10-31', '2032-11-30'],
    ['2032-11-30', '2033-01-31', '2033-02-28'],
    ['2033-02-28', '2033-04-30', '2033-05-31'],
    ['2033-08-31', '2033-10-31', '2033-11-30'],
    ['2034-08-31', '2034-10-31', '2034-11-30'],
  ]);
  assert.equal(yearIndex('2031-05-01', '2033-04-30'), 2);
  assert.equal(yearIndex('2031-05-01', '2033-05-01'), 3);
  assert.equal(previousBusinessDay('2032-05-31', ['2032-05-31']), '2032-05-28');
  const withHoliday = roundsFor({baseDate: '2031-05-01', phases, tier: 'to_members', untilDate: '2032-03-31', holidays: ['2032-05-31']});
  assert.equal(withHoliday.at(-1).payOn, '2032-05-28');
});

test('FR-SETL-COMM-013 回だけの変更は理由つきで反映し、理由が無ければ断る', () => {
  const phases = [{tier: 'to_members', fromYear: 1, toYear: null, closeMonths: [2, 5, 8, 11], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, holidayRule: 'none'}];
  const rounds = roundsFor({baseDate: '2031-05-01', phases, tier: 'to_members', untilDate: '2032-03-31', overrides: [
    {tier: 'to_members', closeOn: '2031-11-30', field: 'payOn', value: '2032-02-20', reason: '幹事の決算に合わせる（架空）'},
    {tier: 'to_members', closeOn: '2031-08-31', field: 'skip', reason: '報告なし（架空）'},
  ]});
  assert.deepEqual(rounds.map((r) => r.closeOn), ['2031-05-31', '2031-11-30', '2032-02-29']);
  assert.equal(rounds[1].payOn, '2032-02-20');
  assert.equal(rounds[1].overrides[0].reason, '幹事の決算に合わせる（架空）');
  assert.throws(() => roundsFor({baseDate: '2031-05-01', phases, tier: 'to_members', untilDate: '2032-03-31', overrides: [{tier: 'to_members', closeOn: '2031-11-30', field: 'payOn', value: '2032-02-20'}]}), /理由/);
});

test('FR-SETL-COMM-014 下限額未満の配分は翌回へ繰り越す', () => {
  const first = applyCarry({amounts: [{partnerId: 'X', amountYen: 8000}], carriedIn: {X: 1500}, thresholdYen: 10000});
  assert.deepEqual(first, [{partnerId: 'X', payYen: 0, carryOutYen: 9500}]);
  const second = applyCarry({amounts: [{partnerId: 'X', amountYen: 3000}], carriedIn: {X: 9500}, thresholdYen: 10000});
  assert.deepEqual(second, [{partnerId: 'X', payYen: 12500, carryOutYen: 0}]);
});

function twoRounds() {
  const r1 = calcRound({businesses: businesses(1), committeeSteps: committeeSteps(3000), members: MEMBERS});
  const r2 = calcRound({businesses: businesses(2), committeeSteps: committeeSteps(1000), members: MEMBERS, priorSuccessBaseYen: r1.committee.successBaseCumulativeYen});
  return [...entriesFromRound(r1, {tier: 'to_members', closeOn: '2031-08-31'}), ...entriesFromRound(r2, {tier: 'to_members', closeOn: '2031-11-30'})];
}

test('FR-SETL-COMM-015 FR-SETL-COMM-016 台帳の行から収支報告書を、前回まで累計・今回・累計で出す', () => {
  const entries = twoRounds();
  assert.ok(entries.every((r) => r.section !== 'distribution')); // 配分金は行にしない
  const s = statement(entries, {closeOn: '2031-11-30', investmentTotalYen: 100000000});
  assert.deepEqual(s.A, {prior: 104260000, current: 2981100, cumulative: 107241100});
  assert.deepEqual(s.costs.success_fee, {prior: 0, current: 225029, cumulative: 225029});
  assert.deepEqual(s.D, {prior: 99044150, current: 2606066, cumulative: 101650216});
  assert.deepEqual(s.balance, {prior: -955850, current: 2606066, cumulative: 1650216});
  const video = s.byBusiness.find((b) => b.business === 'home_video');
  assert.deepEqual(video.distribution, {prior: 5180000, current: 261100, cumulative: 5441100});
  // 前の回を「今回」にすると、あとの回は数えない
  assert.deepEqual(statement(entries, {closeOn: '2031-08-31', investmentTotalYen: 100000000}).D, {prior: 0, current: 99044150, cumulative: 99044150});
});

test('FR-SETL-COMM-017 当事者・著作権者・成功報酬の受取人・業務担当者ごとの累計', () => {
  const entries = twoRounds();
  const members = cumulativeBy(entries, {section: 'member_distribution', closeOn: '2031-11-30'});
  assert.deepEqual(members.get('SELF'), {prior: 12380519, current: 325758, cumulative: 12706277});
  const holders = cumulativeBy(entries, {section: 'secondary_royalty', closeOn: '2031-11-30', key: (r) => r.holderRole});
  assert.deepEqual(holders.get('原作'), {prior: 1360000, current: 135000, cumulative: 1495000});
  assert.deepEqual(holders.get('監督'), {prior: 680000, current: 66000, cumulative: 746000});
  assert.deepEqual(cumulativeBy(entries, {section: 'success_fee', closeOn: '2031-11-30'}).get('K'), {prior: 0, current: 225029, cumulative: 225029});
  assert.deepEqual(cumulativeBy(entries, {section: 'agent_fee', closeOn: '2031-11-30'}).get('SELF'), {prior: 2220000, current: 111900, cumulative: 2331900});
});

test('FR-SETL-COMM-018 受け取った報告の前回まで累計を台帳の和と照合する', () => {
  const entries = twoRounds();
  const result = checkReportedPrior(entries, {closeOn: '2031-11-30', reported: [
    {business: 'theatrical', section: 'agent_fee', priorYen: 18500000},
    {business: null, section: 'manager_fee', priorYen: 5212000},
  ]});
  assert.deepEqual(result.map((r) => [r.ok, r.diffYen]), [[true, 0], [false, -850]]);
});

// 幹事から届いた収支報告書の形（架空）。第2回と同じ数字を、報告書に書かれた額として入れる
function report2() {
  const rights = (a, b, c) => [{holderRole: '原作', amountYen: a}, {holderRole: '監督', amountYen: b}, {holderRole: '脚本', amountYen: c}];
  return {
    businesses: [
      {business: 'theatrical', income: [{amountYen: 200000}], agent_fee: [{amountYen: 40000, counterparty: 'K'}]},
      {business: 'home_video', income: [{amountYen: 400000}], secondary_royalty: rights(15000, 6000, 6000), agent_fee: [{amountYen: 111900, counterparty: 'SELF'}]},
      {business: 'svod', income: [{amountYen: 2000000}], secondary_royalty: rights(60000, 30000, 30000), agent_fee: [{amountYen: 400000, counterparty: 'K'}]},
      {business: 'tv', income: [{amountYen: 1500000}], secondary_royalty: rights(60000, 30000, 30000), agent_fee: [{amountYen: 300000, counterparty: 'L'}]},
    ],
    overhead: [{amountYen: 1000, item: '振込手数料'}],
    manager_fee: [{amountYen: 149005, counterparty: 'K'}],
    success_fee: [{amountYen: 225029, counterparty: 'K'}],
    member_distribution: [{counterparty: 'K', amountYen: 1303033}, {counterparty: 'L', amountYen: 651517}, {counterparty: 'SELF', amountYen: 325758}, {counterparty: 'M', amountYen: 325758}],
  };
}

test('FR-SETL-COMM-022 届いた収支報告書の全行を台帳の行にし、配分の和が A＋B−C と合わなければ差を添えて断る', () => {
  const rows = entriesFromReport(report2(), {tier: 'to_members', closeOn: '2031-11-30'});
  const s = statement(rows, {closeOn: '2031-11-30', investmentTotalYen: 100000000});
  assert.equal(s.A.current, 2981100);
  assert.equal(s.D.current, 2606066);
  const broken = report2();
  broken.member_distribution[2].amountYen = 326358; // 自社の分を600円多く書いた報告書
  assert.throws(() => entriesFromReport(broken, {tier: 'to_members', closeOn: '2031-11-30'}), (e) => e.code === 'committee_report_unbalanced' && e.diffYen === 600);
});

test('FR-SETL-COMM-023 報告書の行と条件版の式で計算した行を事業×区分で比べ、差のある所だけを返す', () => {
  const formula = calcRound({businesses: businesses(2), committeeSteps: committeeSteps(1000), members: MEMBERS, priorSuccessBaseYen: 99044150});
  const fromFormula = entriesFromRound(formula, {tier: 'to_members', closeOn: '2031-11-30'});
  assert.deepEqual(compareWithFormula(entriesFromReport(report2(), {tier: 'to_members', closeOn: '2031-11-30'}), fromFormula), []);
  const r = report2();
  r.businesses[1].agent_fee[0].amountYen = 112000; // 窓口手数料を100円多く引いた報告書（配分も100円少ない）
  r.member_distribution[0].amountYen -= 100;
  const diffs = compareWithFormula(entriesFromReport(r, {tier: 'to_members', closeOn: '2031-11-30'}), fromFormula);
  assert.deepEqual(diffs.map((d) => [d.business, d.section, d.diffYen]), [['home_video', 'agent_fee', 100], [null, 'member_distribution', -100]]);
});
