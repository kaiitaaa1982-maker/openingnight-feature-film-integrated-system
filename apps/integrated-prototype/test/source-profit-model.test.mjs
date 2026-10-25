// 源泉別の利益額の純関数（src/accounting/profit/source-profit-model.mjs。行動指標の計画 段B #2）を、架空の小さな記録で確かめる。
// 期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-005・006・007・039 と、docs/requirements/accounting/company-profit.md の
// FR-ACCT-PROFIT-013、計画の J-11b (a)（払った月に引く）・J-14 (a)（受託は純額）・払込の判定（締めた月より前は実績の側）から手で計算した値。
// 架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {actualWindow, buildSourceProfit, PROFIT_SOURCES} from '../src/accounting/profit/source-profit-model.mjs';

const EARNING_TYPES = [
  {code: 'contract_work', label: '制作受託', profit_source: 1}, {code: 'own_investment', label: '自社出資', profit_source: 2},
  {code: 'committee', label: '製作委員会', profit_source: 3}, {code: 'acquisition', label: '買付', profit_source: 4}, {code: 'consignment', label: '販売委託', profit_source: 5},
];
const LABEL = Object.fromEntries(EARNING_TYPES.map((e) => [e.code, e.label]));
const project = (id, earningType = 'own_investment', over = {}) => ({id, code: `P${String(id).padStart(2, '0')}`, title: `架空案件${id}`, earningType,
  earningTypeLabel: earningType === null ? null : LABEL[earningType], rateBps: 10000, rateReason: null, hasWork: true, mgContracts: 0, purchaseWorks: 0, ...over});
const records = (over = {}) => ({
  projects: [], receipts: {settled: [], unsettled: []}, saleLines: [], expenses: [], expensePayments: [],
  ownInvestmentPayments: [], ownInvestmentUnpaidProjects: 0, committeeInvestmentPayments: [], mgPayments: null, buyoutPayments: null, withholdingPartnerIds: null, ...over,
});
const input = (r, {contractProjects = [], milestones = [], approvalProjects = [], versions = []} = {}) => ({
  records: r, earningTypes: EARNING_TYPES, contractWork: {projects: contractProjects, milestones}, approvals: {projects: approvalProjects, versions},
});
const version = (projectId, approvalNo, versionNo, status, amountYen, paidOn = null) => ({project_id: projectId, approval_no: approvalNo, version_no: versionNo, status,
  amount_yen: amountYen, basis_reference: status === 'applied' ? '架空の企画書' : null, paid_on: paidOn, note: null, created_by: 1, created_at: '2026-01-01 00:00:00'});
const expense = (id, projectId, month, exTax, kind = 'other', paidOn = null) => ({e: {id, projectId, month, exTax, incTax: exTax, voidedOn: null, kind, bearer: null},
  p: paidOn ? {id: 1000 + id, expenseId: id, paidOn, amount: exTax, reversesId: null, withheld: null} : null});
const src = (view, key) => view.sources.find((s) => s.key === key);
const AMOUNTS = (s) => [s.salesYen, s.investmentYen, s.expenseYen, s.costYen, s.profitYen, s.fourItemsYen, s.profitWithoutFourItemsYen];

// 自社出資の案件1（売上率 80%）: 入金 1,001（2026-05）と 500（2026-06）、計上の売上 2,000（2026-04）、稟議の払込 300（2026-03-01）と 700（2026-05-10）、
// ほかの費用区分の経費 50（計上 2026-05・出金 2026-06-01）、費用区分「制作費」の経費 90（未確定。計上 2026-05・出金 2026-05-20）
function ownCase() {
  const e1 = expense(1, 1, '2026-05', 50, 'other', '2026-06-01');
  const e2 = expense(2, 1, '2026-05', 90, 'production_cost', '2026-05-20');
  const r = records({projects: [project(1, 'own_investment', {rateBps: 8000})],
    receipts: {settled: [{projectId: 1, month: '2026-05', exTaxYen: 1001, partnerId: null}, {projectId: 1, month: '2026-06', exTaxYen: 500, partnerId: null}], unsettled: []},
    saleLines: [{projectId: 1, month: '2026-04', exTaxYen: 2000, partnerId: null}],
    expenses: [e1.e, e2.e], expensePayments: [e1.p, e2.p],
    ownInvestmentPayments: [{projectId: 1, paidOn: '2026-03-01', amountYen: 300}, {projectId: 1, paidOn: '2026-05-10', amountYen: 700}]});
  const versions = [version(1, 1, 1, 'applied', 1000), version(1, 1, 2, 'approved', 1000), version(1, 1, 3, 'paid', 300, '2026-03-01'), version(1, 1, 4, 'paid', 700, '2026-05-10')];
  return input(r, {approvalProjects: [{id: 1, code: 'P01', title: '架空案件1', earning_type: 'own_investment'}], versions});
}

test('FR-REV-KPI-007 FR-ACCT-PROFIT-013 源泉2の粗利＝回収−出資額−経費で、出資額は窓の中の払込の行からだけ1回引き、計上と入金で売上は違い出資額は同じ（払った月）', () => {
  const opts = {from: '2026-04', to: '2026-12', closedMonth: '2026-06'};
  const cash = buildSourceProfit(ownCase(), {basis: 'cash', ...opts});
  // 入金: 売上 trunc(1001×80%)=800（5月）＋trunc(500×80%)=400（6月）、出資額 700（5月。3月の 300 は窓の外）、経費 50（6月の出金）
  assert.deepEqual(AMOUNTS(src(cash, 'own_investment')), [1200, 700, 50, 750, 450, 700, 1150]);
  assert.deepEqual(cash.months, ['2026-05', '2026-06']);
  assert.deepEqual(src(cash, 'own_investment').monthly, {salesYen: [800, 400], investmentYen: [700, 0], expenseYen: [0, 50], profitYen: [100, 350]});
  // 計上: 売上 trunc(2000×80%)=1600（4月）、出資額は計上でも払った月の 700、経費は計上月の 50
  const accrual = buildSourceProfit(ownCase(), {basis: 'accrual', ...opts});
  assert.deepEqual(AMOUNTS(src(accrual, 'own_investment')), [1600, 700, 50, 750, 850, 700, 1550]);
  // 承認の額（1,000）や出資の回収の累計（1,000）で引き直さない: 出資の回収は累計で、粗利とは別に出る
  const recovery = src(cash, 'own_investment').detail.recovery;
  assert.deepEqual([recovery.rows[0].investmentYen, recovery.rows[0].revenueYen, recovery.rows[0].diffYen, recovery.rows[0].status], [1000, 1200, 200, 'recovered']);
  // 会社への利益額（同じ窓・同じ基準）と差が無い
  for (const view of [cash, accrual]) {
    const row = view.reconciliation.rows.find((r) => r.key === 'own_investment');
    assert.deepEqual([row.profitYen, row.p1ProfitYen, row.diffYen, row.reason], [src(view, 'own_investment').profitYen, src(view, 'own_investment').profitYen, 0, null]);
  }
  // 費用区分「制作費」の経費は未確定（U-5 の残り）で粗利に入れず、源泉の未確定の行に出す
  assert.deepEqual(src(cash, 'own_investment').unsettled.map((u) => [u.key, u.statusLabel, u.amountYen]), [['production_expense', '未確定', 90]]);
  // 案件別の行（作品の有無も出す）
  assert.deepEqual(src(cash, 'own_investment').projects, [{projectId: 1, code: 'P01', title: '架空案件1', hasWork: true, salesYen: 1200, investmentYen: 700, expenseYen: 50, costYen: 750, profitYen: 450}]);
  // 承認の額を払い終えた稟議（承認 1,000・払込 300＋700。出資枠 0）は、承認したがまだ払っていない額（月の無い予測の側）に出ない。
  // 壊れたら: 出資枠が 0 の稟議も予測の側に 0円の行で出る
  assert.equal(recovery.rows[0].remainingYen, 0);
  const forecast = src(cash, 'own_investment').detail.forecast;
  assert.deepEqual([forecast.scheduled, forecast.scheduledYen, forecast.unscheduled, forecast.unscheduledYen], [[], 0, [], 0]);
});

// 締めた月 2026-06 より後の入金（2026-07 の 1,000）を足す。出資の回収（累計）は締めた月までの入金で、期間の終わりが締めた月より後でも、期間を省いても入れない。
// 壊れたら: 出資の回収の累計を期間の終わりで切ると、7月の trunc(1000×80%)=800 が回収額に入って 2,000 になる
test('FR-REV-KPI-039 FR-REV-KPI-049 出資の回収の収益は締めた月までの入金の累計で、締めた月より後の入金は期間の終わりが後でも入れず、締めた月を進めると入る', () => {
  const data = ownCase();
  data.records.receipts.settled.push({projectId: 1, month: '2026-07', exTaxYen: 1000, partnerId: null});
  for (const to of ['2026-12', null]) {
    const view = buildSourceProfit(data, {basis: 'cash', from: '2026-04', to, closedMonth: '2026-06'});
    const s2 = src(view, 'own_investment');
    // 締めた月までの入金 trunc(1001×80%)＋trunc(500×80%)＝1,200
    assert.deepEqual([s2.salesYen, s2.detail.recovery.rows[0].revenueYen, s2.detail.recovery.rows[0].periodRevenueYen, s2.detail.recovery.total.revenueYen], [1200, 1200, 1200, 1200], String(to));
  }
  const later = buildSourceProfit(data, {basis: 'cash', from: '2026-04', to: '2026-12', closedMonth: '2026-07'});
  assert.deepEqual([src(later, 'own_investment').salesYen, src(later, 'own_investment').detail.recovery.rows[0].revenueYen], [2000, 2000]);
});

// 境界: 締めた月 2026-06 の最後の日の払込は実績の側、翌月1日の払込は窓の外で予測の側（払う月 2026-07）。承認の額のうち記録の無い分は月の無い予測の側。
// 壊れたら: 締めた月で切らないと 2026-07 の払込が出資額に入り、予測の側の払込を実績からも引くと出資額が 300 になる
test('FR-REV-KPI-039 FR-REV-KPI-007 締めた月の払込は実績の出資額に入り、翌月の払込は実績に入らず予測の側に払う月で出る。承認したが払っていない額は月の無い予測の側', () => {
  const r = records({projects: [project(1)], ownInvestmentPayments: [{projectId: 1, paidOn: '2026-06-30', amountYen: 200}, {projectId: 1, paidOn: '2026-07-01', amountYen: 100}]});
  const versions = [version(1, 1, 1, 'applied', 500), version(1, 1, 2, 'approved', 500), version(1, 1, 3, 'paid', 200, '2026-06-30'), version(1, 1, 4, 'paid', 100, '2026-07-01')];
  const data = input(r, {approvalProjects: [{id: 1, code: 'P01', title: '架空案件1', earning_type: 'own_investment'}], versions});
  for (const basis of ['cash', 'accrual']) {
    const view = buildSourceProfit(data, {basis, from: '2026-04', to: '2027-03', closedMonth: '2026-06'});
    assert.deepEqual(view.window, {from: '2026-04', to: '2026-06', clippedAtClosedMonth: true, empty: false});
    assert.equal(src(view, 'own_investment').investmentYen, 200, basis);
    const forecast = src(view, 'own_investment').detail.forecast;
    assert.deepEqual(forecast.scheduled.map((s) => [s.month, s.amountYen]), [['2026-07', 100]]);
    assert.deepEqual([forecast.scheduledYen, forecast.unscheduledYen], [100, 200]);
    // 締めた月を1か月進めると、翌月の払込も実績の側
    const later = buildSourceProfit(data, {basis, from: '2026-04', to: '2027-03', closedMonth: '2026-07'});
    assert.equal(src(later, 'own_investment').investmentYen, 300, basis);
    assert.deepEqual(src(later, 'own_investment').detail.forecast.scheduled, []);
  }
  assert.deepEqual(actualWindow({from: '2026-04', to: '2026-05', closedMonth: '2026-06'}), {from: '2026-04', to: '2026-05', clippedAtClosedMonth: false, empty: false});
  assert.deepEqual(actualWindow({from: '2026-08', to: '2026-12', closedMonth: '2026-06'}), {from: '2026-08', to: '2026-06', clippedAtClosedMonth: true, empty: true});
});

// 受託の契約の版（架空）: 総製作費 1,234,567・受託費率 12%（受託費 trunc(148,148.04)=148,148）を 3333・3334・3333 bp の節目（2026-05・06・08）に配る。
// 最大剰余法: 49,377 r.7284・49,392 r.5432・49,377 r.7284 で足りない2円を余りの大きい順（同じなら前）に足して 49,378・49,392・49,378
const contract = (id, stage, over = {}) => ({project_id: id, code: `P${String(id).padStart(2, '0')}`, title: `架空案件${id}`, earning_type: 'contract_work', profit_source: 1,
  stage_code: stage, version_no: 1, budget_yen: 1234567, markup_bps: 1200, fee_yen: 148148, milestone_count: 3, ...over});
const milestones = (id, months = ['2026-05-01', '2026-06-01', '2026-08-01'], shares = [3333, 3334, 3333]) => months.map((dueOn, i) => ({project_id: id, version_no: 1, seq: i + 1, due_on: dueOn, share_bps: shares[i]}));

test('FR-REV-KPI-006 FR-ACCT-PROFIT-013 源泉1の売上は契約済みの案件の締めた月までの節目の受託費の純額で、見送り・契約前の案件の節目は数えず、利益額の売上（入金×受託費率）との差は理由つき', () => {
  const e1 = expense(1, 1, '2026-06', 10, 'other', '2026-06-10');
  const e2 = expense(2, 1, '2026-06', 70000, 'production_cost', '2026-06-10');
  const r = records({projects: [project(1, 'contract_work', {rateBps: 1200}), project(2, 'contract_work', {rateBps: 1200, hasWork: false}),
    project(3, 'contract_work', {rateBps: 1200, hasWork: false})],
  receipts: {settled: [{projectId: 1, month: '2026-06', exTaxYen: 100000, partnerId: null}], unsettled: []},
  expenses: [e1.e, e2.e], expensePayments: [e1.p, e2.p]});
  const data = input(r, {contractProjects: [contract(1, 'contracted'), contract(2, 'declined'), contract(3, 'terms_agreed')],
    milestones: [...milestones(1), ...milestones(2), ...milestones(3)]});
  const view = buildSourceProfit(data, {basis: 'cash', from: '2026-04', to: '2027-03', closedMonth: '2026-06'});
  const s1 = src(view, 'contract_work');
  // 売上＝49,378（5月）＋49,392（6月）。経費は確定の 10 だけ（制作の実費 70,000 は除外）
  assert.deepEqual(AMOUNTS(s1), [98770, 0, 10, 10, 98760, 0, 98760]);
  assert.deepEqual(s1.monthly, {salesYen: [49378, 49392], investmentYen: [0, 0], expenseYen: [0, 10], profitYen: [49378, 49382]});
  assert.deepEqual(s1.excluded.map((x) => [x.label, x.amountYen]), [['制作の実費', 70000]]);
  assert.deepEqual(s1.detail.scheduled, [{projectId: 1, code: 'P01', seq: 3, month: '2026-08', feeYen: 49378}]);
  assert.deepEqual(s1.detail.notCounted.map((x) => [x.code, x.reason]), [['P02', 'declined'], ['P03', 'not_contracted']]);
  assert.equal(s1.detail.receiptBasis, 'milestone_month');
  assert.ok(s1.notes.includes('売上は節目の月で数える（入金は未確認。受託の入金を節目に当てる規則が入るまで）'), JSON.stringify(s1.notes));
  // 利益額の売上は入金×受託費率 = trunc(100,000×12%) = 12,000（作品のある案件の入金）。差は売上の数え方の違い（理由 milestone_basis）
  const row = view.reconciliation.rows.find((x) => x.key === 'contract_work');
  assert.deepEqual([row.p1SalesYen, row.p1ProfitYen, row.diffYen, row.reason], [12000, 11990, 98760 - 11990, 'milestone_basis']);
  // 案件別: 契約済みの P01 は受託費の純額。見送り・契約前の案件は額が無いので案件別の行に無く、数えない理由の行（notCounted）にだけ出る
  assert.deepEqual(s1.projects.map((p) => [p.code, p.salesYen, p.profitYen]), [['P01', 98770, 98760]]);
});

test('FR-REV-KPI-006 FR-REV-KPI-005 源泉1は契約の版が無ければ未接続、締めた月が無ければ未確定、契約済みの版の節目が全部欠けていれば未確定で、どれも額は null（0円で埋めない）', () => {
  const r = records({projects: [project(1, 'contract_work', {rateBps: 1200})]});
  const noVersion = buildSourceProfit(input(r, {contractProjects: [contract(1, 'contracted', {version_no: null, budget_yen: null, markup_bps: null, fee_yen: null, milestone_count: null})]}),
    {basis: 'cash', from: '2026-04', to: '2027-03', closedMonth: '2026-06'});
  assert.deepEqual([src(noVersion, 'contract_work').status, ...AMOUNTS(src(noVersion, 'contract_work'))], ['unconnected', null, null, null, null, null, null, null]);
  const withVersion = input(r, {contractProjects: [contract(1, 'contracted')], milestones: milestones(1)});
  const noClosed = buildSourceProfit(withVersion, {basis: 'cash', from: '2026-04', to: '2027-03', closedMonth: null});
  assert.deepEqual([src(noClosed, 'contract_work').status, src(noClosed, 'contract_work').profitYen], ['unknown', null]);
  assert.equal(noClosed.reconciliation.rows.find((x) => x.key === 'contract_work').reason, 'unknown');
  const broken = buildSourceProfit(input(r, {contractProjects: [contract(1, 'contracted')], milestones: milestones(1).slice(0, 1)}),
    {basis: 'cash', from: '2026-04', to: '2027-03', closedMonth: '2026-06'});
  assert.deepEqual([src(broken, 'contract_work').status, src(broken, 'contract_work').salesYen, src(broken, 'contract_work').detail.unknownCount], ['unknown', null, 1]);
});

// 受託の案件: 契約済みの P01（版あり）・契約済みの P04（版なし。経費 30）・契約前の段階の P05（版なし）。
// 壊れたら: P04 の売上を0円で埋めると、案件別の行が売上 0・粗利 −30 になり、注記にも出ない
test('FR-REV-KPI-006 FR-ACCT-PROFIT-013 契約済みで契約の版が無い受託の案件は売上を0円で埋めず、案件別の売上・粗利を null にして注記に件数を出し、経費は源泉の経費に入れる', () => {
  const e1 = expense(1, 4, '2026-06', 30, 'other', '2026-06-10');
  const r = records({projects: [project(1, 'contract_work', {rateBps: 1200}), project(4, 'contract_work', {rateBps: 1200}), project(5, 'contract_work', {rateBps: 1200})],
    expenses: [e1.e], expensePayments: [e1.p]});
  const noVersion = {version_no: null, budget_yen: null, markup_bps: null, fee_yen: null, milestone_count: null};
  const data = input(r, {contractProjects: [contract(1, 'contracted'), contract(4, 'contracted', noVersion), contract(5, 'terms_agreed', noVersion)], milestones: milestones(1)});
  const s1 = src(buildSourceProfit(data, {basis: 'cash', from: '2026-04', to: '2027-03', closedMonth: '2026-06'}), 'contract_work');
  // 売上は P01 の 49,378＋49,392 だけ。P04 の経費 30 は源泉の経費に入る
  assert.deepEqual([s1.status, s1.salesYen, s1.expenseYen, s1.profitYen], ['connected', 98770, 30, 98740]);
  assert.deepEqual(s1.projects.map((p) => [p.code, p.salesYen, p.costYen, p.profitYen]), [['P01', 98770, 0, 98770], ['P04', null, 30, null]]);
  // 注記の件数は契約済みの P04 だけ（契約前の P05 は数える段階でないので入れない）。版の無い案件は両方とも unregistered に出る
  assert.ok(s1.notes.includes('契約済みで契約の版が無い案件 1件は、受託費が分からないので売上に入れていません'), JSON.stringify(s1.notes));
  assert.deepEqual([s1.detail.unregisteredContractedCount, s1.detail.unregistered.map((x) => x.code)], [1, ['P04', 'P05']]);
  const noExpense = {...data, records: {...data.records, expenses: [], expensePayments: []}};
  const withoutCost = src(buildSourceProfit(noExpense, {basis: 'cash', from: '2026-04', to: '2027-03', closedMonth: '2026-06'}), 'contract_work');
  assert.deepEqual(withoutCost.projects.find((p) => p.code === 'P04'), {...s1.projects.find((p) => p.code === 'P04'), expenseYen: 0, costYen: 0});
});

test('FR-REV-KPI-005 FR-ACCT-PROFIT-013 源泉3〜5は未接続で額が null（0円で埋めない）。5つの合計は全部が接続するまで null で、接続した源泉の和を別に出し、利益額との差は理由つき', () => {
  const r = records({projects: [project(1), project(2, 'committee', {rateBps: 3000}), project(3, 'acquisition', {rateBps: 2000}), project(9, null, {rateBps: null})],
    receipts: {settled: [{projectId: 1, month: '2026-05', exTaxYen: 1000, partnerId: null}, {projectId: 2, month: '2026-05', exTaxYen: 1000, partnerId: null},
      {projectId: 3, month: '2026-05', exTaxYen: 1000, partnerId: null}], unsettled: []},
    expenses: [expense(1, 9, '2026-05', 40, 'other', '2026-05-15').e], expensePayments: [expense(1, 9, '2026-05', 40, 'other', '2026-05-15').p],
    committeeInvestmentPayments: [{projectId: 2, paidOn: '2026-05-01', amountYen: 100}]});
  const view = buildSourceProfit(input(r), {basis: 'cash', from: '2026-04', to: '2026-06', closedMonth: '2026-06'});
  for (const key of ['committee', 'acquisition', 'consignment']) {
    const s = src(view, key);
    assert.deepEqual([s.status, s.statusLabel, ...AMOUNTS(s), s.monthly, s.projects], ['unconnected', '未接続', null, null, null, null, null, null, null, null, null], key);
    assert.match(s.reason, /段B #[567]/, key);
  }
  // 源泉1は契約の版が無く未接続。合計は null、接続した源泉（自社出資）の和は 1000
  assert.equal(src(view, 'contract_work').status, 'unconnected');
  assert.deepEqual([view.total.complete, view.total.profitYen], [false, null]);
  assert.deepEqual([view.connectedTotal.sources, view.connectedTotal.salesYen, view.connectedTotal.profitYen], [['own_investment'], 1000, 1000]);
  // 利益額: 自社出資 1000、委員会 trunc(1000×30%)−100 = 200、買付 trunc(1000×20%) = 200、稼ぎ方の無い案件 −40（売上率が決まらず売上は未確定、経費 40）
  const rows = Object.fromEntries(view.reconciliation.rows.map((x) => [x.key, [x.p1ProfitYen, x.diffYen, x.reason]]));
  assert.deepEqual(rows, {contract_work: [0, 0, 'unconnected'], own_investment: [1000, 0, null], committee: [200, -200, 'unconnected'], acquisition: [200, -200, 'unconnected'],
    consignment: [0, 0, 'unconnected'], none: [-40, 40, 'no_earning_type']});
  assert.deepEqual(view.reconciliation.total, {sourceProfitYen: 1000, p1ProfitYen: 1360, diffYen: -360});
  assert.deepEqual(view.sources.map((s) => s.source), PROFIT_SOURCES.map((d) => d.source));
});

test('FR-REV-KPI-007 FR-ACCT-PROFIT-013 請求額と違う額の入金（U-5 の残り）は粗利に入れず未確定の行に税込で出し、期間の始まりが締めた月より後なら実績は無い', () => {
  const r = records({projects: [project(1)], receipts: {settled: [{projectId: 1, month: '2026-05', exTaxYen: 1000, partnerId: null}],
    unsettled: [{projectId: 1, month: '2026-05', amountYen: 333, reason: 'amount_differs'}]}});
  const view = buildSourceProfit(input(r), {basis: 'cash', from: '2026-04', to: '2026-06', closedMonth: '2026-06'});
  assert.equal(src(view, 'own_investment').salesYen, 1000);
  assert.deepEqual(src(view, 'own_investment').unsettled.map((u) => [u.key, u.amountKindLabel, u.amountYen]), [['sales_amount_differs', '税込（税抜にできない）', 333]]);
  const after = buildSourceProfit(input(r), {basis: 'cash', from: '2026-08', to: '2026-12', closedMonth: '2026-06'});
  assert.deepEqual([after.window.empty, src(after, 'own_investment').salesYen, src(after, 'own_investment').profitYen, after.reconciliation.total.p1ProfitYen, after.months], [true, 0, 0, 0, []]);
  assert.ok(after.notes.includes('期間の始まりが締めた月（2026-06）より後なので、実績はありません'), JSON.stringify(after.notes));
});

test('FR-ACCT-PROFIT-013 同じ入力から同じ応答を作り、入力を書き換えず、基準は accrual・cash だけを受ける', () => {
  const data = ownCase();
  const before = JSON.stringify(data);
  const opts = {basis: 'cash', from: '2026-04', to: '2026-12', closedMonth: '2026-06'};
  assert.deepEqual(buildSourceProfit(data, opts), buildSourceProfit(ownCase(), opts));
  assert.equal(JSON.stringify(data), before);
  assert.throws(() => buildSourceProfit(data, {...opts, basis: 'gross'}), /基準（basis）/);
  assert.throws(() => buildSourceProfit(data, {...opts, closedMonth: '2026/06'}), /closedMonth/);
});
