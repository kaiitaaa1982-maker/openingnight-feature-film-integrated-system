// 会社への利益額（K-16）の純関数（src/accounting/profit/profit-model.mjs）の、golden の種に行の無い経路を架空の小さな記録で確かめる
// （golden の「値の無い経路」: 案件不明・作品の無い案件・買い切り〈J-9 (c)〉・受託〈J-14 (a)〉。ほかに源泉のある取引先・売上率の決まらない案件・
// 請求額と違う入金・税込額と違う出金・取消・負担者・費用区分・未接続・期間・会社全体を見ない人）。期待値は要件 docs/requirements/accounting/company-profit.md と
// 計画の K-16・J-11b (a)・J-9 (c)・J-14 (a) から手で計算した値
import test from 'node:test';
import assert from 'node:assert/strict';
import {accrualSaleParts, buildCompanyProfit, profitRecordsFromSources, PROFIT_ITEMS} from '../src/accounting/profit/profit-model.mjs';

const project = (id, over = {}) => ({id, code: `P${String(id).padStart(2, '0')}`, title: `架空案件${id}`, earningType: 'own_investment', earningTypeLabel: '自社出資',
  rateBps: 10000, rateReason: null, hasWork: true, mgContracts: 0, purchaseWorks: 0, ...over});
const records = (over = {}) => ({
  projects: [project(1)], receipts: {settled: [], unsettled: []}, saleLines: [], expenses: [], expensePayments: [],
  ownInvestmentPayments: [], committeeInvestmentPayments: [], mgPayments: [], buyoutPayments: [], withholdingPartnerIds: [], ...over,
});
const row = (view, label) => [...view.unsettled, ...view.excluded].find((r) => r.label === label);

test('FR-ACCT-PROFIT-001 FR-ACCT-PROFIT-003 売上は入金（計上は売上明細）×案件の売上率を、月×案件で足してから1回だけ切り捨て、利益額＝売上−経費', () => {
  // 売上率 50%（5000 bp）: 同じ月の入金 101 と 101 を足した 202×5000/10000 = 101（1行ずつ切り捨てると 50+50 = 100 になる）
  const r = records({projects: [project(1, {rateBps: 5000})],
    receipts: {settled: [{projectId: 1, month: '2026-05', exTaxYen: 101, partnerId: 7}, {projectId: 1, month: '2026-05', exTaxYen: 101, partnerId: 7}], unsettled: []},
    saleLines: [{projectId: 1, month: '2026-04', exTaxYen: 101, partnerId: 7}, {projectId: 1, month: '2026-04', exTaxYen: 101, partnerId: 8}],
    expenses: [{id: 1, projectId: 1, month: '2026-04', exTax: 40, incTax: 44, voidedOn: null, kind: 'other', bearer: null}],
    expensePayments: [{id: 1, expenseId: 1, paidOn: '2026-05-10', amount: 44, reversesId: null, withheld: null}]});
  const cash = buildCompanyProfit(r, {basis: 'cash'});
  assert.deepEqual(cash.months, ['2026-04', '2026-05']);
  assert.deepEqual([cash.settled.salesYen, cash.settled.costYen, cash.settled.profitYen], [[0, 101], [0, 40], [0, 61]]);
  const accrual = buildCompanyProfit(r, {basis: 'accrual'});
  assert.deepEqual([accrual.settled.salesYen, accrual.settled.costYen, accrual.settled.profitYen], [[101, 0], [40, 0], [61, 0]]);
  assert.deepEqual(accrual.byProject, [{projectId: 1, code: 'P01', title: '架空案件1', earningType: 'own_investment', earningTypeLabel: '自社出資', salesYen: 101, costYen: 40, profitYen: 61}]);
});

test('FR-ACCT-PROFIT-004 J-11b (a) の4費目は計上・入金とも払った月に引き、取消（負の額）も取消の月に戻す。買い切りは売上−買付額（J-9 (c)。売上率 100%）', () => {
  const r = records({projects: [project(1, {earningType: 'acquisition', earningTypeLabel: '買付'})],
    saleLines: [{projectId: 1, month: '2026-07', exTaxYen: 5000, partnerId: null}],
    ownInvestmentPayments: [{projectId: 1, paidOn: '2026-03-15', amountYen: 1000}],
    committeeInvestmentPayments: [{projectId: 1, paidOn: '2026-04-15', amountYen: 700}, {projectId: 1, paidOn: '2026-05-01', amountYen: -700}],
    mgPayments: [{projectId: 1, paidOn: '2026-04-20', amountYen: 300}],
    buyoutPayments: [{projectId: 1, paidOn: '2026-06-30', amountYen: 3000}]});
  for (const basis of ['accrual', 'cash']) {
    const view = buildCompanyProfit(r, {basis});
    assert.deepEqual(view.months, ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'], basis);
    assert.deepEqual(view.settled.costYen, [1000, 1000, -700, 3000, 0], basis);
    assert.deepEqual(view.settled.salesYen, basis === 'accrual' ? [0, 0, 0, 0, 5000] : [0, 0, 0, 0, 0], basis);
  }
  assert.equal(buildCompanyProfit(r, {basis: 'accrual'}).settled.totals.profitYen, 5000 - 1000 - 300 - 3000);
});

test('FR-ACCT-PROFIT-005 FR-ACCT-PROFIT-006 制作受託の案件の制作費は除外、ほかの案件の制作費と負担者の無い宣伝費・配給費と費用区分の無い経費は未確定、負担者が自社の宣伝費とほかの費用区分は確定', () => {
  const e = (id, projectId, kind, bearer, exTax) => ({id, projectId, month: '2026-06', exTax, incTax: exTax, voidedOn: null, kind, bearer});
  const r = records({projects: [project(1), project(2, {earningType: 'contract_work', earningTypeLabel: '制作受託', hasWork: false})],
    expenses: [e(1, 1, 'production_cost', null, 100), e(2, 2, 'production_cost', null, 200), e(3, 1, 'promotion', 'self', 30), e(4, 1, 'promotion', 'other', 40),
      e(5, 1, 'promotion', null, 50), e(6, 1, 'distribution', 'self', 60), e(7, 1, 'distribution', 'other', 70), e(8, 1, 'distribution', null, 80),
      e(9, 1, 'other', null, 9), e(10, 1, 'unclassified', null, 11)]});
  const view = buildCompanyProfit(r, {basis: 'accrual'});
  assert.deepEqual(view.settled.costYen, [30 + 9]);
  const pick = (label) => [row(view, label)?.status, row(view, label)?.total];
  assert.deepEqual(pick('制作の実費'), ['excluded', 200]);
  assert.deepEqual(pick('費用区分「制作費」の経費'), ['unsettled', 100]);
  assert.deepEqual(pick('宣伝費（負担者 自社以外）'), ['unsettled', 40]);
  assert.deepEqual(pick('宣伝費（負担者 未登録）'), ['unsettled', 50]);
  assert.deepEqual(pick('配給費（負担者 自社）'), ['unsettled', 60]);
  assert.deepEqual(pick('配給費（負担者 自社以外）'), ['unsettled', 70]);
  assert.deepEqual(pick('配給費（負担者 未登録）'), ['unsettled', 80]);
  assert.deepEqual(pick('費用区分の決まらない経費'), ['unsettled', 11]);
  // 制作受託の案件は確定の行が無いので案件別に出ない（除外だけ）
  assert.deepEqual(view.byProject.map((p) => [p.code, p.costYen]), [['P01', 39]]);
});

// 壊れたら: 違う額の出金を「制作の実費」（税別）の行へ足すと、税別の額と税込の一部払いの額が1行に混ざり、下の2行の額が 1000+550 の1行になって落ちる
test('FR-ACCT-PROFIT-005 制作受託の制作の実費は、入金の基準で税込額どおりに払い切った出金を税別の「制作の実費」に、違う額の出金を税込の別の除外の行に出し、1行に混ぜない', () => {
  const r = records({projects: [project(1, {earningType: 'contract_work', earningTypeLabel: '制作受託', hasWork: false})],
    expenses: [{id: 1, projectId: 1, month: '2026-06', exTax: 1000, incTax: 1100, voidedOn: null, kind: 'production_cost', bearer: null},
      {id: 2, projectId: 1, month: '2026-06', exTax: 2000, incTax: 2200, voidedOn: null, kind: 'production_cost', bearer: null}],
    expensePayments: [{id: 1, expenseId: 1, paidOn: '2026-07-10', amount: 1100, reversesId: null, withheld: null},
      {id: 2, expenseId: 2, paidOn: '2026-07-20', amount: 550, reversesId: null, withheld: null}]});
  const cash = buildCompanyProfit(r, {basis: 'cash'});
  assert.deepEqual(cash.excluded.map((x) => [x.key, x.amountKind, x.amounts]),
    [['contract_production_cost', 'ex_tax', [0, 1000]], ['contract_production_cost_amount_differs', 'inc_tax', [0, 550]]]);
  assert.deepEqual([cash.unsettled, cash.settled.totals.costYen], [[], 0], '除外の出金は未確定にも確定にも入れない');
  // 計上の基準は計上月の税別の額だけ（出金によらない）
  assert.deepEqual(buildCompanyProfit(r, {basis: 'accrual'}).excluded.map((x) => [x.key, x.amounts]), [['contract_production_cost', [3000, 0]]]);
});

// 壊れたら: 案件コードを localeCompare で並べると、大小文字を区別しない並び（A02・b01・B03）になって落ちる（golden の Python の sorted はコードポイントの順）
test('FR-ACCT-PROFIT-010 案件別は案件コードのコードポイントの順（大文字が小文字より前）に並ぶ', () => {
  const r = records({projects: [project(1, {code: 'b01'}), project(2, {code: 'B03'}), project(3, {code: 'A02'})],
    saleLines: [1, 2, 3].map((projectId) => ({projectId, month: '2026-04', exTaxYen: 100 * projectId, partnerId: null}))});
  assert.deepEqual(buildCompanyProfit(r, {basis: 'accrual'}).byProject.map((p) => p.code), ['A02', 'B03', 'b01']);
});

test('FR-ACCT-PROFIT-006 作品の無い案件・源泉のある取引先・売上率の決まらない案件の売上と、請求額と違う額の入金は、売上に入れず未確定の行に出す', () => {
  const r = records({projects: [project(1, {rateBps: 2000}), project(2, {rateBps: 1000, hasWork: false}), project(3, {rateBps: null, rateReason: 'default_unregistered'})],
    receipts: {settled: [{projectId: 1, month: '2026-08', exTaxYen: 1000, partnerId: 5}, {projectId: 1, month: '2026-08', exTaxYen: 3000, partnerId: 9},
      {projectId: 2, month: '2026-08', exTaxYen: 5000, partnerId: 5}, {projectId: 3, month: '2026-08', exTaxYen: 7000, partnerId: 5}],
    unsettled: [{projectId: 1, month: '2026-08', amountYen: 990, reason: 'amount_differs'}]},
    withholdingPartnerIds: [9]});
  const view = buildCompanyProfit(r, {basis: 'cash'});
  assert.deepEqual(view.settled.salesYen, [200]);
  assert.deepEqual([row(view, '売上（源泉のある取引先）').total, row(view, '売上（源泉のある取引先）').amountKind], [600, 'rate_applied']);
  assert.deepEqual([row(view, '売上（作品の無い案件）').total, row(view, '売上（作品の無い案件）').projectIds], [500, [2]]);
  assert.deepEqual([row(view, '売上（売上率の決まらない案件）').total, row(view, '売上（売上率の決まらない案件）').amountKind], [7000, 'before_rate']);
  assert.deepEqual([row(view, '売上（請求額と違う額の入金）').total, row(view, '売上（請求額と違う額の入金）').amountKind], [990, 'inc_tax']);
});

// 壊れたら: 買付の MG・買い切りの案件の数を稼ぎ方によらず MG の契約・買付額で数えると、自社出資の案件4・委託の案件5が入って落ちる
test('FR-ACCT-PROFIT-007 記録の一覧が無い（null）費目は額を出さず未接続にし、記録が0件（[]）の費目は未接続にしない。MG・買い切りの案件の数は稼ぎ方が買付の案件だけ', () => {
  const r = records({projects: [project(1), project(2, {earningType: 'acquisition', mgContracts: 1}), project(3, {earningType: 'acquisition', purchaseWorks: 2}),
    project(4, {mgContracts: 1}), project(5, {earningType: 'consignment', purchaseWorks: 1}), project(6, {earningType: 'acquisition', mgContracts: 1, purchaseWorks: 1})],
  ownInvestmentPayments: null, mgPayments: null, buyoutPayments: null, withholdingPartnerIds: null});
  const view = buildCompanyProfit(r, {basis: 'cash'});
  assert.deepEqual(view.unconnected.map((u) => [u.key, u.projectCount, u.settledWhenConnected]),
    [['own_investment', 2, true], ['acquisition_mg', 2, true], ['acquisition_buyout', 1, true], ['sales_withholding', null, false]]);
  assert.equal(view.notes.length, 3, JSON.stringify(view.notes));
  assert.deepEqual(buildCompanyProfit(records(), {basis: 'cash'}).unconnected, []);
});

test('FR-ACCT-PROFIT-008 案件に結べない入金・売上明細は案件不明の行に出して売上に数えず、会社全体を見ない人には案件不明の行を出さない', () => {
  const r = records({receipts: {settled: [], unsettled: [{projectId: null, month: '2026-09', amountYen: 1100, reason: 'allocation_incomplete'}]},
    unknownReceipts: [{month: '2026-10', amountYen: 500, reason: 'no_project'}],
    unknownSaleLines: [{month: '2026-09', amountYen: 800, reason: 'product_allocation_incomplete'}]});
  const cash = buildCompanyProfit(r, {basis: 'cash'});
  assert.deepEqual(cash.months, ['2026-09', '2026-10']);
  assert.deepEqual([cash.unknownProject.amounts, cash.unknownProject.total], [[1100, 500], 1600]);
  assert.deepEqual(cash.unknownProject.reasons.map((x) => [x.reason, x.total, x.amountKind]), [['allocation_incomplete', 1100, 'inc_tax'], ['no_project', 500, 'ex_tax']]);
  assert.deepEqual(cash.settled.salesYen, [0, 0]);
  const accrual = buildCompanyProfit(r, {basis: 'accrual'});
  assert.deepEqual(accrual.unknownProject.amounts, [800, 0]);
  const limited = buildCompanyProfit(r, {basis: 'cash', includeCompany: false});
  assert.equal(limited.unknownProject, null);
  assert.deepEqual(limited.months, [], '案件不明の行だけの月は、会社全体を見ない人の軸に出さない');
});

test('FR-ACCT-PROFIT-002 計上の経費は取り消すと取消日の月に負の額、入金の経費は税込額どおりの出金だけ税別で引き、違う額の出金は税込のまま未確定、出金の取消は取消の月に戻す', () => {
  const r = records({expenses: [{id: 1, projectId: 1, month: '2026-01', exTax: 1000, incTax: 1100, voidedOn: '2026-03-05', kind: 'other', bearer: null},
    {id: 2, projectId: 1, month: '2026-01', exTax: 500, incTax: 550, voidedOn: null, kind: 'other', bearer: null}],
  expensePayments: [{id: 1, expenseId: 1, paidOn: '2026-02-10', amount: 1100, reversesId: null, withheld: null},
    {id: 2, expenseId: 1, paidOn: '2026-03-06', amount: -1100, reversesId: 1, withheld: null},
    {id: 3, expenseId: 2, paidOn: '2026-02-20', amount: 300, reversesId: null, withheld: null}]});
  const accrual = buildCompanyProfit(r, {basis: 'accrual'});
  assert.deepEqual(accrual.months, ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(accrual.settled.costYen, [1500, 0, -1000]);
  const cash = buildCompanyProfit(r, {basis: 'cash'});
  assert.deepEqual(cash.settled.costYen, [0, 1000, -1000]);
  assert.deepEqual([row(cash, '出金（経費の税込額と違う額）').amounts, row(cash, '出金（経費の税込額と違う額）').amountKind], [[0, 300, 0], 'inc_tax']);
});

test('FR-ACCT-PROFIT-011 期間（from・to）の外の記録は軸にも額にも入れず、形の違う月は誤りにする', () => {
  const r = records({saleLines: ['2026-01', '2026-02', '2026-03'].map((month) => ({projectId: 1, month, exTaxYen: 100, partnerId: null}))});
  const view = buildCompanyProfit(r, {basis: 'accrual', from: '2026-02', to: '2026-02'});
  assert.deepEqual([view.months, view.settled.totals.salesYen, view.conditions], [['2026-02'], 100, {from: '2026-02', to: '2026-02'}]);
  assert.throws(() => buildCompanyProfit(r, {basis: 'accrual', from: '2026-2'}), /YYYY-MM/);
  assert.throws(() => buildCompanyProfit(r, {basis: 'gross'}), /基準/);
});

test('FR-ACCT-PROFIT-003 計上の売上明細は商品の作品への配賦で案件へ分け（最大剰余法）、配賦の和が 100% でない明細は案件不明、見てよくない案件の分は捨てる', () => {
  const rows = [
    // 商品の無い明細（作品の案件 1）
    {sale_id: 1, accounting_month: '2026-05', amount_ex_tax: 1000, partner_id: 3, product_id: null, work_id: 11, project_id: 1, share_work_id: null, share_bps: null, share_project_id: null},
    // 商品の配賦 3333・6667（案件 1・2）。1001 円を最大剰余法で 334・667 に
    {sale_id: 2, accounting_month: '2026-05', amount_ex_tax: 1001, partner_id: 3, product_id: 5, work_id: 11, project_id: 1, share_work_id: 11, share_bps: 3333, share_project_id: 1},
    {sale_id: 2, accounting_month: '2026-05', amount_ex_tax: 1001, partner_id: 3, product_id: 5, work_id: 11, project_id: 1, share_work_id: 21, share_bps: 6667, share_project_id: 2},
    // 配賦の和が 9000 の商品
    {sale_id: 3, accounting_month: '2026-06', amount_ex_tax: 700, partner_id: 3, product_id: 6, work_id: 11, project_id: 1, share_work_id: 11, share_bps: 9000, share_project_id: 1},
  ];
  const all = accrualSaleParts(rows, {projectIds: [1, 2]});
  assert.deepEqual(all.parts.map((p) => [p.saleId, p.projectId, p.exTaxYen]), [[1, 1, 1000], [2, 1, 334], [2, 2, 667]]);
  assert.deepEqual(all.unknown.map((u) => [u.saleId, u.amountYen, u.reason]), [[3, 700, 'product_allocation_incomplete']]);
  const onlyTwo = accrualSaleParts(rows, {projectIds: [2]});
  assert.deepEqual(onlyTwo.parts.map((p) => [p.saleId, p.projectId, p.exTaxYen]), [[2, 2, 667]]);
  assert.deepEqual(onlyTwo.unknown, [], '見てよい案件の作品を含まない明細の案件不明は返さない');
});

test('FR-ACCT-PROFIT-003 FR-ACCT-PROFIT-008 読み取りの行を記録にする: 消込は請求の取引先つきで案件に結び、作品の配賦がそろわない消込は案件不明、自社の取引先が無ければ委員会の払込は未接続', () => {
  const sources = {
    earningTypes: [{code: 'own_investment', label: '自社出資'}],
    projectRows: [{id: 1, code: 'P01', title: '架空', earning_type: 'own_investment', work_count: 1, mg_contracts: 0, purchase_works: 0}],
    revenueClassInputs: {projects: [{id: 1, code: 'P01', title: '架空', earning_type: 'own_investment', revenue_rate_bps: 10000}],
      earningTypes: [{code: 'own_investment', label: '自社出資', rate_source: 'project'}], defaultRates: [], contractVersions: [], acquisitionEvidence: []},
    receiptRows: [
      {receipt_id: 1, received_on: '2026-06-03', reversed_on: null, invoice_id: 10, allocated_yen: 1100, invoice_inc_tax: 1100, invoice_partner_id: 4, sale_id: 100, line_ex_tax: 1000, work_id: 11, allocation_bps: 10000, project_id: 1},
      {receipt_id: 2, received_on: '2026-06-04', reversed_on: null, invoice_id: 20, allocated_yen: 550, invoice_inc_tax: 550, invoice_partner_id: 4, sale_id: 200, line_ex_tax: 500, work_id: 11, allocation_bps: 9000, project_id: 1},
    ],
    saleRows: [], expenseRows: [], committeePaymentRows: [{id: 1, paid_on: '2026-06-01', amount_yen: 99, project_id: 1}], selfPartnerId: null, projectCount: 1,
  };
  const r = profitRecordsFromSources(sources);
  assert.deepEqual(r.receipts.settled, [{projectId: 1, month: '2026-06', exTaxYen: 1000, partnerId: 4}]);
  assert.deepEqual(r.receipts.unsettled, [{projectId: null, month: '2026-06', amountYen: 550, reason: 'allocation_incomplete'}]);
  assert.equal(r.committeeInvestmentPayments, null);
  assert.deepEqual(r.projects.map((p) => [p.id, p.rateBps, p.hasWork, p.earningTypeLabel]), [[1, 10000, true, '自社出資']]);
  const view = buildCompanyProfit(r, {basis: 'cash'});
  assert.deepEqual([view.settled.salesYen, view.unknownProject.total], [[1000], 550]);
  assert.ok(view.unconnected.some((u) => u.key === 'committee_investment'));
  // 自社の取引先があれば払込を払った月に引く
  const withSelf = profitRecordsFromSources({...sources, selfPartnerId: 7});
  assert.deepEqual(withSelf.committeeInvestmentPayments, [{projectId: 1, paidOn: '2026-06-01', amountYen: 99}]);
});

// 稟議の払込の版（行動指標の計画 段B #4）を読んだ行は自社出資の出資額として払った月に引き、未接続にしない。読んでいない（行が無い）ときは未接続のまま。
// 稟議の払込の無い自社出資の案件の数は注記に出し、0件なら出さない
// 壊れたら: 稟議の払込の行を記録へ渡さない（null のまま）と未接続に出て 2026-07 の経費が 0 になり、注記を数で出さないと落ちる
test('FR-ACCT-PROFIT-004 FR-ACCT-PROFIT-007 読み取りの行の稟議の払込は自社出資の出資額として払った月に引き、稟議の払込の無い自社出資の案件の数を注記する', () => {
  const sources = {
    earningTypes: [{code: 'own_investment', label: '自社出資'}],
    projectRows: [{id: 1, code: 'P01', title: '架空', earning_type: 'own_investment', work_count: 1, mg_contracts: 0, purchase_works: 0}],
    revenueClassInputs: {projects: [{id: 1, code: 'P01', title: '架空', earning_type: 'own_investment', revenue_rate_bps: 10000}],
      earningTypes: [{code: 'own_investment', label: '自社出資', rate_source: 'project'}], defaultRates: [], contractVersions: [], acquisitionEvidence: []},
    receiptRows: [], saleRows: [], expenseRows: [], committeePaymentRows: [], selfPartnerId: 7, projectCount: 1,
    ownInvestmentPaymentRows: [{source: 'own_investment', id: null, paid_on: '2026-07-14', amount_yen: 3170000, project_id: 1, approval_no: 1, version_no: 3}],
    ownInvestmentUnpaidCount: 2,
  };
  const r = profitRecordsFromSources(sources);
  assert.deepEqual(r.ownInvestmentPayments, [{projectId: 1, paidOn: '2026-07-14', amountYen: 3170000}]);
  for (const basis of ['accrual', 'cash']) {
    const view = buildCompanyProfit(r, {basis});
    assert.deepEqual([view.months, view.settled.costYen], [['2026-07'], [3170000]], basis);
    assert.ok(!view.unconnected.some((u) => u.key === 'own_investment'), basis);
    assert.deepEqual(view.notes, ['自社出資の出資額は、稟議の払込の記録が無い案件 2件では引いていません。出資していれば、利益額はその分だけ大きく出ます'], basis);
  }
  assert.deepEqual(buildCompanyProfit(profitRecordsFromSources({...sources, ownInvestmentUnpaidCount: 0}), {basis: 'cash'}).notes, []);
  // 稟議の払込を読んでいない読み取り（行が無い）は、これまでどおり未接続
  const {ownInvestmentPaymentRows, ...withoutApprovals} = sources;
  assert.ok(ownInvestmentPaymentRows.length);
  const unread = buildCompanyProfit(profitRecordsFromSources(withoutApprovals), {basis: 'cash'});
  assert.deepEqual(unread.unconnected.filter((u) => u.key === 'own_investment').map((u) => u.projectCount), [1]);
});

test('FR-ACCT-PROFIT-005 費目の表は確定・未確定・除外のどれかで、向きは売上か経費、額の中身の語がある', () => {
  for (const item of PROFIT_ITEMS) {
    assert.ok(['settled', 'unsettled', 'excluded'].includes(item.status), item.key);
    assert.ok(['sales', 'cost'].includes(item.side), item.key);
    assert.ok(['rate_applied', 'before_rate', 'ex_tax', 'inc_tax', 'paid'].includes(item.amountKind), item.key);
  }
  assert.deepEqual(PROFIT_ITEMS.filter((i) => i.status === 'settled').map((i) => i.key),
    ['sales', 'own_investment', 'committee_investment', 'acquisition_mg', 'acquisition_buyout', 'promotion_self', 'project_expense']);
});
