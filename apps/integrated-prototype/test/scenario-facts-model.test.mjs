// シナリオの比較（段A）の実績の組み立て（src/revenue/scenario/scenario-facts-model.mjs の buildScenarioFacts）を、手で数えた小さい架空の入力で確かめる。
// 期待値は計画（会社ルートの plans/2026-10-09-sales-producer-kpi.md の「段A」の表と「出資の回収」）から取る。DB を使わない。
// - 委員会の作品は、自社の出資比率（参加者の持分）・約定の出資額・締めた月までの払込のどれかがあるときだけ出資の回収の行にし（selfInvested）、
//   源泉3の実績にはどの作品も入れる
// - 作品ごとの参考の列: 源泉4の買付額・MG・MG 残と、作品単位の入金（税込・未確定。請求の作品の重みで分けた額の締めた月までの累計と期間内）
// - 作品→源泉（計画の決定 D2）: 買付に入れるのは、最新の版の買付額がある作品（買い切り）か MG の分配契約がある作品（MG つき）だけ。
//   買付額も MG も無い自社出資の作品は自社出資だけに入り、入金が回収に当たる（store は契約一覧の権利の取得を読まない。DB の契約一覧の確かめは scenario-routes の試験）
// - 重なり: 買い切りの買付にも入る自社出資の作品は入金を自社出資の回収に当てず、MG つきなら紐付かない報告の入金だけを当てる。
//   契約のある稼ぎ方にも入る委員会の作品は、源泉3の実績に入れない（未確定）
// - 自社出資の出資額と買い切りの買付額は期間より前に払った扱いで、期間の粗利から引かない（計画の決定 D1。式は model）
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildScenarioFacts} from '../src/revenue/scenario/scenario-facts-model.mjs';
import {normalizeScenarioFacts, ScenarioInputError} from '../src/revenue/scenario/scenario-inputs.mjs';
import {investmentRecovery, sourceActuals} from '../src/revenue/scenario/scenario-model.mjs';

const SELF = 9;
const OTHER = 21;
const request = {period: {from: '2026-04', to: '2027-03'}, closedMonth: '2026-08'};
const committeeEntry = (workId, {selfShareBps = null, committedYen = null, acquisitions = []} = {}) => ({
  workId, contractId: workId * 10, contractCode: `DEMO-CMT-${workId}`, selfShareBps, committedYen, acquisitions, error: null, holdNote: null});

// 委員会の作品4本（1: 自社の持分あり、2: 自社が参加者でなく他社だけが払込、3: 持分も約定も無いが締めた月までに自社の払込、4: 自社の払込が締めた月の後だけ）と、
// 買い切りの買付の作品5（買付額25万円）。入金は 120万円（2026-06。作品1と5に 2:1）と 30万円（2026-02。作品5だけ）と 50万円（2026-09。締めた月の後）
const raw = () => ({
  workIds: [1, 2, 3, 4, 5],
  selfPartnerId: SELF,
  works: [1, 2, 3, 4].map((id) => ({id, code: `DEMO-W${id}`, title: `架空の委員会作品${id}`, projectId: 1, committee: true}))
    .concat([{id: 5, code: 'DEMO-W5', title: '架空の買付作品', projectId: 1, committee: false}]),
  saleLines: [],
  committee: [
    committeeEntry(1, {selfShareBps: 4000, acquisitions: [{month: '2026-05', acquisition: 150000}]}),
    committeeEntry(2, {acquisitions: [{month: '2026-06', acquisition: 80000}]}),
    committeeEntry(3, {acquisitions: [{month: '2026-07', acquisition: 60000}]}),
    committeeEntry(4),
  ],
  investmentPayments: [
    {workId: 2, partnerId: OTHER, paidOn: '2026-04-20', amount: 900000},
    {workId: 3, partnerId: SELF, paidOn: '2026-05-10', amount: 500000},
    {workId: 4, partnerId: SELF, paidOn: '2026-10-01', amount: 300000},
  ],
  receipts: [
    {receiptId: 1, invoiceId: 1, receivedOn: '2026-06-15', amount: 1200000, weights: [{workId: 1, weight: 2}, {workId: 5, weight: 1}]},
    {receiptId: 2, invoiceId: 2, receivedOn: '2026-02-01', amount: 300000, weights: [{workId: 5, weight: 1}]},
    {receiptId: 3, invoiceId: 3, receivedOn: '2026-09-03', amount: 500000, weights: [{workId: 5, weight: 1}]},
  ],
  opportunities: [], activities: [],
  finance: [{workId: 5, ownInvestmentYen: null, salesRightsPurchaseYen: 250000}],
  settlementContracts: [],
  invoiceLines: [],
  previews: new Map(),
});

test('委員会の作品は、自社の持分・約定の出資額・締めた月までの払込のどれかがあるときだけ出資の回収の行にし、源泉3の実績にはどれも入れる', () => {
  const built = buildScenarioFacts(raw(), request);
  assert.deepEqual(built.facts.committee.map((row) => [row.workId, row.selfInvested, row.paymentsTotalYen]), [[1, true, 0], [2, false, 0], [3, true, 500000], [4, false, 0]]);
  // 約定の出資額だけがある作品も出資のある作品
  const committed = raw();
  committed.committee[3] = committeeEntry(4, {committedYen: 2000000});
  assert.equal(buildScenarioFacts(committed, request).facts.committee[3].selfInvested, true);

  const facts = normalizeScenarioFacts(built.facts);
  const recovery = investmentRecovery(facts);
  assert.deepEqual(recovery.rows.map((row) => [row.workId, row.investmentYen, row.revenueYen, row.status]), [[1, 0, 150000, 'recovered'], [3, 500000, 60000, 'awaiting']]);
  assert.deepEqual([recovery.total.rowCount, recovery.total.investmentYen, recovery.total.revenueYen], [2, 500000, 210000]);
  // 作品4の自社の払込（2026-10-01）は期間内だが締めた月（2026-08）より後なので、累計にも期間内にも入れない（実績ではない。予定の払込は段B）
  assert.deepEqual(built.facts.committee.map((row) => [row.workId, row.paymentsPeriodYen]), [[1, 0], [2, 0], [3, 500000], [4, 0]]);
  // 源泉3: 期間内の取得額 15万＋8万＋6万＋0 − 期間内の自社の払込 50万（2026-05）。他社の払込と締めた月の後の払込は引かない
  assert.deepEqual(sourceActuals(facts).committee, {status: 'connected', actualYen: 150000 + 80000 + 60000 - 500000, actualSalesYen: 290000, rowCount: 4, unknownCount: 0});
});

// 自社出資の作品7（出資額100万円）に買付額（既定は0円）がある重なり。売上 200万円（2026-07・報告70）、その請求の入金 220万円（2026-08）。
// purchase を null にすると買付額の無い自社出資の作品。mg を渡すと、同じ作品に MG の分配契約（報告70を紐付けるかは linked）を足す
const overlapRaw = ({mg = false, linked = false, purchase = 0} = {}) => ({
  workIds: [7], selfPartnerId: SELF,
  works: [{id: 7, code: 'DEMO-W7', title: '架空の自社出資作品', projectId: 1, committee: false}],
  saleLines: [{saleId: 700, reportId: 70, workId: 7, partnerId: OTHER, month: '2026-07', amount: 2000000}],
  committee: [], investmentPayments: [],
  receipts: [{receiptId: 7, invoiceId: 7, receivedOn: '2026-08-31', amount: 2200000, weights: [{workId: 7, weight: 2200000}]}],
  opportunities: [], activities: [],
  finance: [{workId: 7, ownInvestmentYen: 1000000, salesRightsPurchaseYen: purchase}],
  settlementContracts: mg ? [{id: 71, workId: 7, contractType: 'mg'}] : [],
  invoiceLines: [{invoiceId: 7, saleId: 700, amountIncTax: 2200000, workId: 7, allocationBps: 10000}],
  previews: mg ? new Map([[7, {
    lineResults: linked ? [{contractId: 71, contractType: 'mg', reportId: 70, accountingMonth: '2026-07', agencyFee: 500000, holderAmount: 1500000}] : [],
    contractSummaries: [{contractId: 71, contractType: 'mg', mgContractYen: 1000000, mgBalance: linked ? 0 : 1000000}],
    linkedReportIds: linked ? [70] : [], unlinkedReportIds: linked ? [] : [70],
  }]]) : new Map(),
});

test('重なり: 自社出資の作品が買い切りの買付にも入るなら、売上はすべて買付に数え、自社出資の回収には入金を当てない（同じ売上を2つの源泉で数えない）', () => {
  const built = buildScenarioFacts(overlapRaw(), request);
  assert.equal(built.facts.overlapCount, 1);
  assert.deepEqual(built.outrightOverlapWorkIds, [7]);
  assert.deepEqual(built.facts.ownInvestment, [{workId: 7, title: '架空の自社出資作品', investmentYen: 1000000, receiptsTotalYen: 0, receiptsPeriodYen: 0}]);
  const facts = normalizeScenarioFacts(built.facts);
  const actuals = sourceActuals(facts);
  // 源泉2: 入金0円（出資額 100万円は期間より前に払った扱いで引かない）、会社の売上0円。源泉4: 売上 200万円（買付額は引かない）、会社の売上 200万円。
  // 会社の売上の実績は売上1回分（200万円）だけ
  assert.deepEqual([actuals.own_investment.actualYen, actuals.own_investment.actualSalesYen], [0, 0]);
  assert.deepEqual([actuals.acquisition.actualYen, actuals.acquisition.actualSalesYen], [2000000, 2000000]);
  assert.equal(Object.values(actuals).reduce((n, row) => n + (row.actualSalesYen ?? 0), 0), 2000000);
  // 出資の回収の行の収益も0円（回収待ち）。作品ごとの参考の列の入金は、紐付けを問わない作品の入金の全部
  assert.deepEqual(investmentRecovery(facts).rows.map((row) => [row.workId, row.revenueYen, row.diffYen, row.status]), [[7, 0, -1000000, 'awaiting']]);
  assert.deepEqual([built.sourceOfWork[0].receiptsTotalYen, built.sourceOfWork[0].receiptsPeriodYen], [2200000, 2200000]);
});

test('D2: 買付額も MG も無い自社出資の作品は自社出資だけに入り、入金が回収に当たる。買付額があれば買い切り、MG の分配契約だけでも MG つきの買付に入る', () => {
  // 買付額 NULL・分配契約なし: 自社出資だけ（重なりなし）。入金 220万円が自社出資の回収と期間の粗利に入り、買付の行は無い
  const own = buildScenarioFacts(overlapRaw({purchase: null}), request);
  assert.deepEqual(own.sourceOfWork.map((row) => [row.workId, row.sources, row.overlap]), [[7, ['own_investment'], false]]);
  assert.deepEqual([own.facts.overlapCount, own.outrightOverlapWorkIds, own.facts.acquisition], [0, [], []]);
  assert.deepEqual(own.facts.ownInvestment, [{workId: 7, title: '架空の自社出資作品', investmentYen: 1000000, receiptsTotalYen: 2200000, receiptsPeriodYen: 2200000}]);
  const facts = normalizeScenarioFacts(own.facts);
  assert.deepEqual([sourceActuals(facts).own_investment.actualYen, sourceActuals(facts).acquisition.actualYen], [2200000, 0]);
  assert.deepEqual(investmentRecovery(facts).rows.map((row) => [row.workId, row.revenueYen, row.diffYen, row.status, row.periodInvestmentYen]), [[7, 2200000, 1200000, 'recovered', 0]]);
  // 買付額 0円（NULL でない）は買い切りの買付にも入る
  assert.deepEqual(buildScenarioFacts(overlapRaw({purchase: 0}), request).sourceOfWork[0].sources, ['own_investment', 'acquisition']);
  // 買付額 NULL でも MG の分配契約があれば MG つきの買付に入る
  const mgOnly = buildScenarioFacts(overlapRaw({purchase: null, mg: true}), request);
  assert.deepEqual([mgOnly.sourceOfWork[0].sources, mgOnly.facts.acquisition.map((row) => row.kind)], [['own_investment', 'acquisition'], ['mg']]);
});

test('重なり: MG つきの買付なら、自社出資の回収には MG の分配契約に紐付かない報告の入金だけを当てる（買い切りの扱いにしない）', () => {
  // 報告70を MG に紐付けない: 入金は自社出資の回収に入り、MG の手数料には入らない
  const unlinked = buildScenarioFacts(overlapRaw({mg: true}), request);
  assert.deepEqual(unlinked.outrightOverlapWorkIds, []);
  assert.deepEqual([unlinked.facts.ownInvestment[0].receiptsTotalYen, unlinked.facts.acquisition[0].kind, unlinked.facts.acquisition[0].agencyFeePeriodYen], [2200000, 'mg', 0]);
  // 報告70を MG に紐付ける: 入金は自社出資の回収から外れ、MG の行の手数料に入る
  const linked = buildScenarioFacts(overlapRaw({mg: true, linked: true}), request);
  assert.deepEqual([linked.facts.ownInvestment[0].receiptsTotalYen, linked.facts.acquisition[0].agencyFeePeriodYen], [0, 500000]);
});

test('重なり: 販売委託の契約にも入る委員会の作品は、取得額を契約の分と分けられないので源泉3の実績に入れず（未確定）、出資の回収の行には取得額をそのまま出す', () => {
  const base = normalizeScenarioFacts(buildScenarioFacts(raw(), request).facts);
  const withContract = raw();
  withContract.settlementContracts = [{id: 11, workId: 1, contractType: 'commission'}];
  withContract.previews = new Map([[1, {lineResults: [], contractSummaries: [], linkedReportIds: [], unlinkedReportIds: []}]]);
  const built = buildScenarioFacts(withContract, request);
  assert.deepEqual(built.facts.committee.map((row) => [row.workId, row.overlap]), [[1, true], [2, false], [3, false], [4, false]]);
  assert.equal(built.facts.overlapCount, 1);
  const facts = normalizeScenarioFacts(built.facts);
  // 源泉3: 作品1の取得額 15万円を除いて 8万＋6万＋0 − 期間内の自社の払込 50万。作品1は未確定の行に数える
  assert.deepEqual(sourceActuals(facts).committee, {status: 'connected', actualYen: 80000 + 60000 - 500000, actualSalesYen: 140000, rowCount: 3, unknownCount: 1});
  assert.deepEqual(investmentRecovery(facts), investmentRecovery(base));
});

test('委託の行の手数料か権利元へ渡る額が無い（null）記録は、facts.consignment の項目を添えた記録の側の誤り（ScenarioInputError）にする', () => {
  const broken = raw();
  broken.settlementContracts = [{id: 51, workId: 5, contractType: 'commission'}];
  broken.previews = new Map([[5, {lineResults: [{contractId: 51, contractType: 'commission', reportId: 1, accountingMonth: '2026-06', agencyFee: null, holderAmount: 100000}],
    contractSummaries: [], linkedReportIds: [1], unlinkedReportIds: []}]]);
  assert.throws(() => buildScenarioFacts(broken, request), (error) => error instanceof ScenarioInputError && error.field === 'facts.consignment' && /作品 5/.test(error.message));
});

test('作品ごとの参考の列は、買付額・MG・MG 残と、請求の作品の重みで分けた作品単位の入金（税込・未確定）の締めた月までの累計と期間内', () => {
  const rows = new Map(buildScenarioFacts(raw(), request).sourceOfWork.map((row) => [row.workId, row]));
  const pick = (row) => ({purchaseYen: row.purchaseYen, mgContractYen: row.mgContractYen, mgBalanceYen: row.mgBalanceYen, receiptsTotalYen: row.receiptsTotalYen, receiptsPeriodYen: row.receiptsPeriodYen});
  // 作品1: 120万円の 2/3。作品5: 120万円の 1/3（期間内）＋30万円（期間の前）。2026-09 の入金は締めた月の後なので数えない
  assert.deepEqual(pick(rows.get(1)), {purchaseYen: null, mgContractYen: null, mgBalanceYen: null, receiptsTotalYen: 800000, receiptsPeriodYen: 800000});
  assert.deepEqual(pick(rows.get(5)), {purchaseYen: 250000, mgContractYen: null, mgBalanceYen: null, receiptsTotalYen: 700000, receiptsPeriodYen: 400000});
  assert.deepEqual(pick(rows.get(2)), {purchaseYen: null, mgContractYen: null, mgBalanceYen: null, receiptsTotalYen: 0, receiptsPeriodYen: 0});
  assert.deepEqual(rows.get(5).sources, ['acquisition']);
});
