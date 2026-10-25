// 予実の4段の純関数（src/revenue/yojitsu/yojitsu-model.mjs の buildYojitsuView・actionTargetCounts、money-yojitsu.mjs の式、
// receipt-inflow-model.mjs の入金を案件に結ぶ規則）を、手で計算できる架空の小さな入力で確かめる（フェーズ1の仕様書 #14）。
// 期待値の出どころ: 要件 FR-REV-YOJITSU-004（料率の額は truncate、比は bp の truncate〈要確認11 の仮〉）・006（目標に由来する値は本人だけ）・
// 007（値の無い月は null）・016（目標件数の逆算は切り上げ）・028（着地＝確度≥着地確度、採用するシナリオか単一）・031・032（入金を案件に結ぶ規則と
// 請求額と違う入金は未確定）・033（実績＝入金×売上率）と、docs/rules/money.md（配賦は最大剰余法）。金額は手で足した値
import test from 'node:test';
import assert from 'node:assert/strict';
import {ceilBpsQuotient, rateChain, ratioBps} from '../src/revenue/yojitsu/money-yojitsu.mjs';
import {actionTargetCounts, buildYojitsuView} from '../src/revenue/yojitsu/yojitsu-model.mjs';
import {linkReceiptsToProjects} from '../src/revenue/yojitsu/receipt-inflow-model.mjs';

test('FR-REV-YOJITSU-004 料率の額は全部の率を掛けてから1回だけ 0 に向かって切り捨て、比は bp の切り捨てで、分母が0以下か null なら null', () => {
  assert.equal(rateChain(12345, [3333]), 4114); // 4114.5885 → 4114
  assert.equal(rateChain(-12345, [3333]), -4114); // 取消（負の額）は符号に対して対称
  assert.equal(rateChain(999, [3333, 8000]), 266); // 999×0.3333×0.8 = 266.37…（率ごとに切ると 333→266 で同じだが、1回で切る）
  assert.equal(rateChain(10, [3333, 3333]), 1); // 1.11… → 1（率ごとに切ると 3.333 → 3、3×0.3333 → 0 になる）
  assert.equal(ratioBps(1, 3), 3333);
  assert.equal(ratioBps(-1, 3), -3333);
  assert.equal(ratioBps(0, 5), 0);
  assert.equal(ratioBps(5, 0), null);
  assert.equal(ratioBps(null, 5), null);
  assert.equal(ratioBps(5, null), null);
  assert.equal(ceilBpsQuotient(8, 3000), 27); // 26.66… → 27
  assert.equal(ceilBpsQuotient(9, 3000), 30); // ちょうど割り切れるときは切り上げない
  assert.equal(ceilBpsQuotient(0, 3000), 0);
  assert.throws(() => ceilBpsQuotient(1, 0));
  assert.throws(() => rateChain(1.5, [100]));
});

test('FR-REV-YOJITSU-016 行動の目標件数は 契約→提案→面談 の順に整数の bps で割って切り上げ、材料が欠ければ件数を作らない', () => {
  // 計画 49,865,056 円・1件 31,345,186 円・売上率 20%: 契約 ceil(7.95…)=8、提案 ceil(8÷0.3)=27、面談 ceil(27÷0.5)=54（golden の買付 1年目）
  assert.deepEqual(actionTargetCounts({planYen: 49865056, unitYen: 31345186, revenueRateBps: 2000, toProposalBps: 5000, toContractBps: 3000}),
    {meeting: 54, proposal: 27, contract: 8});
  // 1件の売上でちょうど割り切れる計画は切り上げない
  assert.deepEqual(actionTargetCounts({planYen: 2000000, unitYen: 1000000, revenueRateBps: 10000, toProposalBps: 5000, toContractBps: 5000}),
    {meeting: 8, proposal: 4, contract: 2});
  assert.deepEqual(actionTargetCounts({planYen: 0, unitYen: 1000000, revenueRateBps: 10000, toProposalBps: 5000, toContractBps: 5000}),
    {meeting: 0, proposal: 0, contract: 0});
  for (const missing of ['planYen', 'unitYen', 'revenueRateBps', 'toProposalBps', 'toContractBps']) {
    assert.equal(actionTargetCounts({planYen: 1, unitYen: 1, revenueRateBps: 1, toProposalBps: 1, toContractBps: 1, [missing]: null}), null, missing);
  }
  assert.equal(actionTargetCounts({planYen: 1, unitYen: 0, revenueRateBps: 1, toProposalBps: 1, toContractBps: 1}), null);
});

// 消込×請求明細×作品の配賦の行（store の receiptLinesStatement の形）
const line = (receipt, invoice, sale, {received = '2026-11-05', reversed = null, allocated, invoiceIncTax, exTax, work, bps = 10000, project}) => ({
  receipt_id: receipt, received_on: received, reversed_on: reversed, invoice_id: invoice, allocated_yen: allocated, invoice_inc_tax: invoiceIncTax,
  sale_id: sale, line_ex_tax: exTax, work_id: work, allocation_bps: bps, project_id: project,
});

test('FR-REV-YOJITSU-031 FR-REV-YOJITSU-032 請求どおりの入金は請求明細の税抜額を作品の配賦で案件へ分け、請求額と違う入金は未確定に税込で分け、取消は取消日の月に負の額', () => {
  const rows = [
    // 入金1: 請求10（税込 33,000）を全額。明細は案件A 10,000、案件B 20,000（税抜）
    line(1, 10, 100, {allocated: 33000, invoiceIncTax: 33000, exTax: 10000, work: 1, project: 1}),
    line(1, 10, 101, {allocated: 33000, invoiceIncTax: 33000, exTax: 20000, work: 2, project: 2}),
    // 入金2: 請求11 を全額。明細は商品で作品1・2に半分ずつ（税抜 10,001 → 5,001 と 5,000。最大剰余法で作品 ID の小さい方へ）。2026-12-03 に取消
    line(2, 11, 102, {received: '2026-11-20', reversed: '2026-12-03', allocated: 11001, invoiceIncTax: 11001, exTax: 10001, work: 1, bps: 5000, project: 1}),
    line(2, 11, 102, {received: '2026-11-20', reversed: '2026-12-03', allocated: 11001, invoiceIncTax: 11001, exTax: 10001, work: 2, bps: 5000, project: 2}),
    // 入金3: 請求12（税込 22,000）に 21,340 だけ（手数料・源泉など）。税抜は出さず、税込を案件の税抜額の比（A 1 : B 3）で分ける
    line(3, 12, 103, {received: '2026-12-10', allocated: 21340, invoiceIncTax: 22000, exTax: 5000, work: 1, project: 1}),
    line(3, 12, 104, {received: '2026-12-10', allocated: 21340, invoiceIncTax: 22000, exTax: 15000, work: 2, project: 2}),
    // 入金4: 作品の配賦が 10000 にそろわない明細（案件へ分けられない）
    line(4, 13, 105, {received: '2026-12-15', allocated: 5500, invoiceIncTax: 5500, exTax: 5000, work: 1, bps: 6000, project: 1}),
  ];
  const all = linkReceiptsToProjects(rows, {projectIds: [1, 2]});
  const key = (r) => `${r.projectId}|${r.month}`;
  const net = (list, field) => list.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + r[field]), new Map());
  assert.deepEqual(Object.fromEntries(net(all.settled, 'exTaxYen')), {'1|2026-11-01': 15001, '2|2026-11-01': 25000, '1|2026-12-01': -5001, '2|2026-12-01': -5000});
  assert.deepEqual(all.unsettled.map((r) => [r.projectId, r.month, r.amountYen, r.reason]), [
    [1, '2026-12-01', 5335, 'amount_differs'], [2, '2026-12-01', 16005, 'amount_differs'], [null, '2026-12-01', 5500, 'allocation_incomplete']]);
  // 見てよい案件だけ: 案件Bの分は返さない。案件へ分けられない消込は、請求の全部の作品の案件が見てよいときだけ返す
  const onlyA = linkReceiptsToProjects(rows, {projectIds: [1]});
  assert.deepEqual(Object.fromEntries(net(onlyA.settled, 'exTaxYen')), {'1|2026-11-01': 15001, '1|2026-12-01': -5001});
  assert.deepEqual(onlyA.unsettled.map((r) => [r.projectId, r.amountYen]), [[1, 5335], [null, 5500]]);
  assert.deepEqual(linkReceiptsToProjects(rows.slice(6), {projectIds: [2]}).unsettled, []);
});

// ---------- buildYojitsuView の小さな入力 ----------

const PERIODS = [{id: 11, yearNo: 1, startsOn: '2026-10-01'}, {id: 12, yearNo: 2, startsOn: '2027-10-01'}];
const EARNING_TYPES = [
  {code: 'acquisition', label: '買付', rate_source: 'project', sort_order: 1, default_rate_bps: 2000, default_rate_status: 'provisional'},
  {code: 'contract_work', label: '制作受託', rate_source: 'contract', sort_order: 5, default_rate_bps: null, default_rate_status: null},
];
const setting = (variableKey, scope, value, extra = {}) => ({variableKey, scope, earningType: null, step: null, value, status: 'confirmed', ...extra});
const SETTINGS = [
  setting('landing_probability', 'all', {kind: 'bps', value: 8000}),
  ...EARNING_TYPES.flatMap((e) => [
    setting('unit_amount', 'earning_type', {kind: 'yen', value: 1000000}, {earningType: e.code}),
    setting('conversion_rate', 'earning_type_step', {kind: 'bps', value: 5000}, {earningType: e.code, step: 'meeting'}),
    setting('conversion_rate', 'earning_type_step', {kind: 'bps', value: 2500}, {earningType: e.code, step: 'proposal'}),
  ]),
];
const target = (periodId, kind, amountYen, extra = {}) => ({periodId, kind, scope: 'all', effective: true, unit: 'period_total', resolution: 'amount', amountYen, status: 'confirmed', ...extra});
const plan = (periodId, versionNo, amounts, {hidden = false} = {}) => ({periodId, versionNo, status: 'confirmed', visibility: hidden ? 'owner_only' : 'visible',
  amounts: Object.entries(amounts).map(([earningType, amountYen]) => ({earningType, amountYen: hidden ? null : amountYen})),
  totalYen: hidden ? null : Object.values(amounts).reduce((a, b) => a + b, 0)});
const base = (projectId, earningType, bps, reason = null) => [projectId, {projectId, earningType, rate: {bps, reason}}];

function input(overrides = {}) {
  return {
    periods: PERIODS,
    targets: [target(11, 'self', 1200000), target(12, 'self', 2400000), target(11, 'company', 600000)],
    plans: [plan(11, 2, {acquisition: 1200000, contract_work: 120000}), plan(12, 1, {acquisition: 2400000, contract_work: 0})],
    settings: SETTINGS,
    choices: {adoptedScenario: {value: 'good', versionNo: 1}},
    earningTypes: EARNING_TYPES,
    projects: [{id: 1, code: 'FICT-A', probability_bps: 10000}, {id: 2, code: 'FICT-B', probability_bps: 8000}, {id: 3, code: 'FICT-C', probability_bps: 3000},
      {id: 4, code: 'FICT-D', probability_bps: 9000}, {id: 5, code: 'FICT-E', probability_bps: null}],
    bases: new Map([base(1, 'acquisition', 2000), base(2, 'contract_work', 1000), base(3, 'acquisition', 2500), base(4, 'contract_work', null, 'contract_version_unregistered'),
      base(5, 'acquisition', 2000)]),
    forecastSums: [
      {project_id: 1, forecast_month: '2026-12-01', scenario: 'good', amount_yen: 100001},
      {project_id: 1, forecast_month: '2026-12-01', scenario: 'single', amount_yen: 9},     // 単一はいつも足す（案件×月で足してから率を掛ける: 100010×20%）
      {project_id: 1, forecast_month: '2026-12-01', scenario: 'even', amount_yen: 5000000}, // 採用していないシナリオ
      {project_id: 2, forecast_month: '2027-01-01', scenario: 'single', amount_yen: 30003},  // 確度 0.8 はちょうど着地に入る
      {project_id: 3, forecast_month: '2027-01-01', scenario: 'good', amount_yen: 40000},    // 確度 0.3 は確度加重だけ
      {project_id: 4, forecast_month: '2027-01-01', scenario: 'good', amount_yen: 70000},    // 率が決まらない（契約の版が無い）
      {project_id: 5, forecast_month: '2027-01-01', scenario: 'good', amount_yen: 80000},    // 段階が無い
      {project_id: 1, forecast_month: '2031-10-01', scenario: 'good', amount_yen: 1},        // 期間の外
    ],
    inflows: {
      settled: [{projectId: 1, month: '2026-11-01', exTaxYen: 50005}, {projectId: 1, month: '2026-11-01', exTaxYen: 50000}, {projectId: 4, month: '2026-11-01', exTaxYen: 7000}],
      unsettled: [{projectId: 3, month: '2026-12-01', amountYen: 21340, reason: 'amount_differs'}],
    },
    activity: {byMonth: new Map([['meeting|2026-10', 3], ['proposal|2026-11', 1]]), byPeriod: new Map([['acquisition|meeting|1', 3], ['acquisition|proposal|1', 1]]),
      skipped: {noStep: 2, noEarningType: 0}},
    ...overrides,
  };
}
const rowsOf = (view) => new Map(view.rows.map((r) => [r.key, r]));
const m = (pairs, n = 24) => { const out = Array(n).fill(null); for (const [i, v] of pairs) out[i] = v; return out; };

test('FR-REV-YOJITSU-028 FR-REV-YOJITSU-033 FR-REV-YOJITSU-007 着地・確度加重・実績を案件×月で出し、値の無い月は null、率の決まらない案件と段階の無い案件は入れずに注記する', () => {
  const view = buildYojitsuView(input());
  const rows = rowsOf(view);
  assert.equal(view.months.length, 24);
  // 着地: 案件1（確度1.0）の 2026-12 は (100001+9)×20% = 20002、案件2（確度0.8 = 着地確度）の 2027-01 は 30003×10% = 3000（3000.3 → 3000）
  assert.deepEqual(rows.get('landing').months, m([[2, 20002], [3, 3000]]));
  assert.deepEqual([rows.get('landing').periods, rows.get('landing').total], [[23002, null], 23002]);
  // 確度加重: 案件1 100010×20%×100% = 20002、2027-01 は 案件2 30003×10%×80% = 2400（2400.24）＋案件3 40000×25%×30% = 3000
  assert.deepEqual(rows.get('weighted').months, m([[2, 20002], [3, 5400]]));
  // 実績: 案件1 の 2026-11 は 100005×20% = 20001（案件×月で足してから切り捨て。行ごとだと 10001+10000=20001 で同じだが、式は1回）。
  // 案件4 は率が決まらないので実績に入れず、入金の総額と「売上率の決まらない案件の入金」に出す
  assert.deepEqual(rows.get('actual').months, m([[1, 20001]]));
  assert.deepEqual(rows.get('inflow').months, m([[1, 107005]]));
  assert.deepEqual(rows.get('inflow_unrated').months, m([[1, 7000]]));
  assert.deepEqual(rows.get('inflow_unsettled').months, m([[2, 21340]]));
  assert.ok(rows.get('inflow_unlinked').months.every((v) => v === null));
  // 稼ぎ方ごと: 制作受託の着地は案件2 だけ
  assert.deepEqual(rows.get('landing:acquisition').months, m([[2, 20002]]));
  assert.deepEqual(rows.get('landing:contract_work').months, m([[3, 3000]]));
  assert.deepEqual(rows.get('actual:contract_work').periods, [null, null], '入金の無い稼ぎ方は 0 でなく null');
  // 進み（着地÷計画）: 2026-12 は 20002 ÷ 110000（計画 1,320,000 の月割り）= 1818 bp。計画の無い月は無い
  assert.equal(rows.get('landing_progress').months[2], 1818);
  assert.equal(rows.get('landing_progress').months[0], null, '着地の無い月の進みは 0% でなく null');
  const codes = view.notes.map((n) => n.code);
  for (const code of ['basis_cash_fixed', 'unrated_projects', 'no_stage_projects', 'unsettled_receipts', 'outside_periods', 'activity_skipped', 'rounding']) assert.ok(codes.includes(code), code);
  assert.deepEqual(view.notes.find((n) => n.code === 'unrated_projects').projects, [{projectId: 4, code: 'FICT-D', reason: 'contract_version_unregistered'}]);
  assert.match(view.notes.find((n) => n.code === 'no_stage_projects').text, /FICT-E/);
  assert.deepEqual(view.checks.filter((c) => !c.ok), []);
});

test('FR-REV-YOJITSU-028 採用するシナリオが単一なら単一の行だけ、設定が無ければ着地・確度加重を null にし、着地確度が無ければ着地だけ null', () => {
  const single = rowsOf(buildYojitsuView(input({choices: {adoptedScenario: {value: 'single', versionNo: 2}}})));
  assert.deepEqual(single.get('landing').months, m([[2, 1], [3, 3000]])); // 単一の 9×20% = 1 と 案件2
  const unset = buildYojitsuView(input({choices: {adoptedScenario: null}}));
  assert.ok(['landing', 'weighted'].every((key) => rowsOf(unset).get(key).months.every((v) => v === null)));
  assert.ok(unset.notes.some((n) => n.code === 'scenario_unset'));
  assert.equal(unset.conditions.find((c) => c.key === 'scenario').value, null);
  const noLanding = buildYojitsuView(input({settings: SETTINGS.filter((s) => s.variableKey !== 'landing_probability')}));
  assert.ok(rowsOf(noLanding).get('landing').months.every((v) => v === null));
  assert.deepEqual(rowsOf(noLanding).get('weighted').months, m([[2, 20002], [3, 5400]]));
  assert.ok(noLanding.notes.some((n) => n.code === 'landing_probability_unset'));
});

test('FR-REV-YOJITSU-010 FR-REV-YOJITSU-013 FR-REV-YOJITSU-016 FR-REV-YOJITSU-017 目標・計画は年÷12（端数は最後の月）、目標件数は計画から逆算して月は100倍の整数、達成率は bp', () => {
  const rows = rowsOf(buildYojitsuView(input({targets: [target(11, 'self', 1200005), target(12, 'self', 2400000)]})));
  assert.deepEqual(rows.get('target_self').months.slice(0, 12), [...Array(11).fill(100000), 100005]);
  assert.deepEqual([rows.get('target_self').periods, rows.get('target_self').total], [[1200005, 2400000], 3600005]);
  // 会社の目標は2年目が無い（未設定）ので通算は null（一部の期間だけを足さない）
  const company = rowsOf(buildYojitsuView(input())).get('target_company');
  assert.deepEqual([company.periods, company.total, company.states], [[600000, null], null, ['amount', 'unset']]);
  // 計画の達成率（計画÷目標（本人））: 1年目 1,320,000 ÷ 1,200,005 = 10999 bp
  assert.equal(rows.get('plan_rate').periods[0], 10999);
  // 目標件数: 買付 1年目 計画 1,200,000 ÷（1,000,000×20%）= 6 契約、提案 6÷25% = 24、面談 24÷50% = 48。
  // 制作受託は受託費率の既定（10%）で 120,000 ÷ 100,000 → 2 契約・8 提案・16 面談。2年目の制作受託は計画 0 なので 0 件
  assert.deepEqual(rows.get('action_target:meeting').periods, [64, 96]);
  assert.deepEqual(rows.get('action_target:contract').periods, [8, 12]);
  assert.deepEqual(rows.get('action_target:meeting').months.slice(0, 12), [...Array(11).fill(533), 537]); // 6400 ÷ 12 = 533 余り 37
  // 実績件数と達成率: 2026-10 の面談 3件 ÷ 月の目標 5.33 件 = 5628 bp、1年目 3 ÷ 64 = 468 bp。活動の無い月は null
  assert.deepEqual(rows.get('action_actual:meeting').months.slice(0, 2), [3, null]);
  assert.equal(rows.get('action_rate:meeting').months[0], 5628);
  assert.equal(rows.get('action_rate:meeting').months[1], null);
  assert.deepEqual(rows.get('action_rate:meeting').periods, [468, null]);
});

test('FR-REV-YOJITSU-006 持ち主でない人には、目標と目標で割る比、第1版の計画とその計画から出る進み・目標件数・達成率を、項目を残して null にする', () => {
  const view = buildYojitsuView(input({
    targets: [target(11, 'self', null, {resolution: 'owner_only'}), target(12, 'self', null, {resolution: 'owner_only'})],
    plans: [plan(11, 2, {acquisition: 1200000, contract_work: 120000}), plan(12, 1, {acquisition: 2400000, contract_work: 0}, {hidden: true})],
  }));
  const rows = rowsOf(view);
  for (const key of ['target_self', 'plan_rate', 'actual_rate']) {
    assert.deepEqual(rows.get(key).hiddenYears, [1, 2], key);
    assert.ok([...rows.get(key).months, ...rows.get(key).periods, rows.get(key).total].every((v) => v === null), key);
  }
  for (const key of ['plan', 'plan:acquisition', 'landing_progress', 'actual_progress', 'action_target:meeting', 'action_rate:meeting']) {
    assert.deepEqual(rows.get(key).hiddenYears, [2], key);
    assert.equal(rows.get(key).periods[1], null, key);
    assert.ok(rows.get(key).months.slice(12).every((v) => v === null), key);
    assert.equal(rows.get(key).total, null, `${key}: 通算は隠した年目を含むので null`);
  }
  assert.equal(rows.get('plan').periods[0], 1320000, '第2版の計画は見える');
  assert.ok(view.action.earningTypes.every((e) => e.periods[1].hidden && e.periods[1].planYen === null && Object.values(e.periods[1].targets).every((v) => v === null)));
  assert.ok(view.notes.some((n) => n.code === 'owner_only'));
  // 人件費×倍率の目標は報酬の行（#17）が入るまで null（未接続）で、隠しているのとは分けて出す
  const unconnected = buildYojitsuView(input({targets: [target(11, 'self', null, {resolution: 'unconnected', basisKind: 'labor_cost_multiple'})]}));
  assert.deepEqual([rowsOf(unconnected).get('target_self').states, rowsOf(unconnected).get('target_self').hiddenYears], [['unconnected', 'unset'], []]);
  assert.ok(unconnected.notes.some((n) => n.code === 'target_unconnected'));
});
