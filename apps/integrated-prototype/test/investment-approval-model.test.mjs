// 稟議の版の流れと入力の判定（src/planning/investment-approval/investment-approval-model.mjs）と、源泉2 自社出資の出資と回収
// （src/accounting/profit/own-investment-source-model.mjs）の純関数を、架空の版の行と利益額の応答の形で確かめる（行動指標の計画 段B #4）。
// 期待値は要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-038・039・049 と計画の J-10 (a)・J-11b (a)・「利益の5源泉」の払込の判定から
// 手で数えた値。架空のデータだけを使う
import test from 'node:test';
import assert from 'node:assert/strict';
import {APPROVAL_POLICY, isCalendarDate, nextApprovalNo, normalizeApprovalStep, normalizeNewApproval, summarizeApprovals}
  from '../src/planning/investment-approval/investment-approval-model.mjs';
import {ownInvestmentSource, paymentSide} from '../src/accounting/profit/own-investment-source-model.mjs';

// 版の行（store の readInvestmentApprovals の versions と同じ列）
const row = (projectId, approvalNo, versionNo, status, amountYen, {by = 7, paidOn = null, basis = null} = {}) => ({
  project_id: projectId, approval_no: approvalNo, version_no: versionNo, status, amount_yen: amountYen, basis_reference: basis, paid_on: paidOn, note: null,
  created_by: by, created_at: '2026-05-01 00:00:00',
});
// 入金の基準の利益額の応答（buildCompanyProfit）のうち、回収が読む所だけ
const cashView = (sales, unsettledProjects = []) => ({
  basis: 'cash', byProject: Object.entries(sales).map(([projectId, salesYen]) => ({projectId: Number(projectId), salesYen})),
  unsettled: unsettledProjects.length ? [{key: 'sales_amount_differs', side: 'sales', projectIds: unsettledProjects}] : [],
});

test('FR-REV-KPI-038 版の並びから稟議ごとのいまの状態・承認の額・払込の累計・出資枠を導き、承認・却下の版には申請した人と同じかを出す', () => {
  const rows = [
    // 稟議1: 申請（利用者7）→ 承認（同じ利用者7。J-10 (a)）→ 払込 2回（分けて払う）で払い切り
    row(1, 1, 1, 'applied', 3000000, {basis: '架空の企画書'}), row(1, 1, 2, 'approved', 3000000),
    row(1, 1, 3, 'paid', 1200000, {paidOn: '2026-04-15'}), row(1, 1, 4, 'paid', 1800000, {paidOn: '2026-06-30'}),
    // 稟議2: 申請 → 却下（利用者8）→ 申請し直し（額を変える）→ 承認（利用者8。申請した7と違う）→ 払込の途中
    row(1, 2, 1, 'applied', 2000000, {basis: '架空の試算 v1'}), row(1, 2, 2, 'rejected', 2000000, {by: 8, basis: '回収が届かない'}),
    row(1, 2, 3, 'applied', 1500000, {basis: '架空の試算 v2'}), row(1, 2, 4, 'approved', 1500000, {by: 8}), row(1, 2, 5, 'paid', 500000, {paidOn: '2026-08-01'}),
    // 稟議3: 申請だけ
    row(1, 3, 1, 'applied', 900000, {basis: '架空の企画書 v3'}),
  ];
  const [a1, a2, a3] = summarizeApprovals([...rows].reverse());
  assert.deepEqual([a1.approvalNo, a1.state, a1.approvedYen, a1.paidYen, a1.remainingYen, a1.nextActions], [1, 'paid_in_full', 3000000, 3000000, 0, []]);
  assert.deepEqual(a1.versions.map((v) => [v.versionNo, v.status, v.sameAsApplicant]), [[1, 'applied', null], [2, 'approved', true], [3, 'paid', null], [4, 'paid', null]]);
  assert.deepEqual([a2.state, a2.applicantUserId, a2.applicationAmountYen, a2.approvedYen, a2.paidYen, a2.remainingYen, a2.nextActions],
    ['paying', 7, 1500000, 1500000, 500000, 1000000, ['pay']]);
  assert.deepEqual(a2.versions.map((v) => [v.status, v.sameAsApplicant]), [['applied', null], ['rejected', false], ['applied', null], ['approved', false], ['paid', null]]);
  assert.deepEqual([a3.state, a3.approvedYen, a3.remainingYen, a3.nextActions], ['applied', null, null, ['apply', 'approve', 'reject']]);
  assert.equal(nextApprovalNo(rows), 4);
  assert.equal(nextApprovalNo([]), 1);
});

test('FR-REV-KPI-038 承認の前に払込は入れられず、払い切ったあとも足せない。承認・却下は申請の額のままで、却下には理由、払込には払った日と承認の残りまでの額が要る', () => {
  const applied = summarizeApprovals([row(1, 1, 1, 'applied', 3000000, {basis: '架空の企画書'})])[0];
  // 承認の前の払込は 409（入力の形が正しくても）
  const early = normalizeApprovalStep({action: 'pay', previousVersionNo: 1, amountYen: 1000, paidOn: '2026-05-20'}, {approval: applied, actorUserId: 7});
  assert.deepEqual([early.ok, early.status, early.errors[0].message], [false, 409, '承認の前に払込は入れられません']);
  const rejected = summarizeApprovals([row(1, 1, 1, 'applied', 3000000, {basis: 'x'}), row(1, 1, 2, 'rejected', 3000000, {basis: '理由'})])[0];
  assert.equal(normalizeApprovalStep({action: 'pay', previousVersionNo: 2, amountYen: 1000, paidOn: '2026-05-20'}, {approval: rejected, actorUserId: 7}).status, 409);
  assert.equal(normalizeApprovalStep({action: 'approve', previousVersionNo: 2}, {approval: rejected, actorUserId: 7}).status, 409);
  // 承認は申請の額のまま（額を省けば申請の額）。違う額は 400
  const approve = normalizeApprovalStep({action: 'approve', previousVersionNo: 1}, {approval: applied, actorUserId: 7});
  assert.deepEqual(approve.value, {approvalNo: 1, versionNo: 2, status: 'approved', amountYen: 3000000, basisReference: null, paidOn: null, note: null});
  assert.equal(normalizeApprovalStep({action: 'approve', previousVersionNo: 1, amountYen: 2999999}, {approval: applied, actorUserId: 7}).status, 400);
  // 却下は理由が要る
  assert.deepEqual(normalizeApprovalStep({action: 'reject', previousVersionNo: 1}, {approval: applied, actorUserId: 7}).errors.map((e) => e.field), ['basisReference']);
  // 古い画面（見ていた版が最新でない）は 409
  assert.equal(normalizeApprovalStep({action: 'approve', previousVersionNo: 0}, {approval: applied, actorUserId: 7}).status, 400);
  const stale = normalizeApprovalStep({action: 'reject', previousVersionNo: 2, basisReference: 'x'}, {approval: applied, actorUserId: 7});
  assert.deepEqual([stale.status, stale.errors[0].field], [409, 'previousVersionNo']);
  // 払込: 承認の残りまで（ちょうどは通り、1円超えは 400）、暦にある払った日
  const approved = summarizeApprovals([row(1, 1, 1, 'applied', 3000000, {basis: 'x'}), row(1, 1, 2, 'approved', 3000000), row(1, 1, 3, 'paid', 1000000, {paidOn: '2026-04-01'})])[0];
  const pay = (over) => normalizeApprovalStep({action: 'pay', previousVersionNo: 3, amountYen: 2000000, paidOn: '2026-05-20', ...over}, {approval: approved, actorUserId: 7});
  assert.deepEqual(pay({}).value, {approvalNo: 1, versionNo: 4, status: 'paid', amountYen: 2000000, basisReference: null, paidOn: '2026-05-20', note: null});
  assert.deepEqual(pay({amountYen: 2000001}).errors.map((e) => e.field), ['amountYen']);
  assert.deepEqual(pay({amountYen: 0}).errors.map((e) => e.field), ['amountYen']);
  assert.deepEqual(pay({paidOn: '2026-02-30'}).errors.map((e) => e.field), ['paidOn']);
  assert.deepEqual(pay({paidOn: undefined}).errors.map((e) => e.field), ['paidOn']);
  const full = summarizeApprovals([row(1, 1, 1, 'applied', 3000000, {basis: 'x'}), row(1, 1, 2, 'approved', 3000000), row(1, 1, 3, 'paid', 3000000, {paidOn: '2026-04-01'})])[0];
  const after = normalizeApprovalStep({action: 'pay', previousVersionNo: 3, amountYen: 1, paidOn: '2026-05-20'}, {approval: full, actorUserId: 7});
  assert.deepEqual([after.status, after.errors[0].message], [409, '承認の額まで払い込み済みです。追加の出資は新しい稟議で申請してください']);
  // 承認のあとに申請し直しはできない（追加の出資は新しい稟議）
  assert.equal(normalizeApprovalStep({action: 'apply', previousVersionNo: 3, amountYen: 10, basisReference: 'x'}, {approval: approved, actorUserId: 7}).status, 409);
  // 操作の語の誤りは 400
  assert.equal(normalizeApprovalStep({action: 'cancel', previousVersionNo: 1}, {approval: applied, actorUserId: 7}).status, 400);
});

test('FR-REV-KPI-038 申請と承認は同じ人でよく（J-10 (a)）、決まりを切り替えると申請した人の承認・却下を断る', () => {
  assert.equal(APPROVAL_POLICY.sameApproverAllowed, true);
  const applied = summarizeApprovals([row(1, 1, 1, 'applied', 3000000, {by: 7, basis: '架空の企画書'})])[0];
  assert.equal(normalizeApprovalStep({action: 'approve', previousVersionNo: 1}, {approval: applied, actorUserId: 7}).ok, true);
  const strict = {sameApproverAllowed: false};
  const self = normalizeApprovalStep({action: 'approve', previousVersionNo: 1}, {approval: applied, actorUserId: 7, policy: strict});
  assert.deepEqual([self.ok, self.status], [false, 409]);
  assert.equal(normalizeApprovalStep({action: 'reject', previousVersionNo: 1, basisReference: '理由'}, {approval: applied, actorUserId: 7, policy: strict}).status, 409);
  assert.equal(normalizeApprovalStep({action: 'approve', previousVersionNo: 1}, {approval: applied, actorUserId: 8, policy: strict}).ok, true);
});

test('FR-REV-KPI-038 新しい稟議は版1の申請で、額（1円〜1兆円の整数）と根拠の参照が要る', () => {
  assert.deepEqual(normalizeNewApproval({amountYen: 4800000, basisReference: ' 架空の企画書 v1 '}, {nextNo: 3}).value,
    {approvalNo: 3, versionNo: 1, status: 'applied', amountYen: 4800000, basisReference: '架空の企画書 v1', paidOn: null, note: null});
  assert.equal(normalizeNewApproval({amountYen: 1_000_000_000_000, basisReference: 'x'}, {nextNo: 1}).ok, true);
  for (const amountYen of [0, 1_000_000_000_001, 1500.5, '1500', null]) {
    assert.deepEqual(normalizeNewApproval({amountYen, basisReference: 'x'}, {nextNo: 1}).errors.map((e) => e.field), ['amountYen'], String(amountYen));
  }
  assert.deepEqual(normalizeNewApproval({amountYen: 1, basisReference: '  '}, {nextNo: 1}).errors.map((e) => e.field), ['basisReference']);
  assert.deepEqual(normalizeNewApproval({amountYen: 1, basisReference: 'x'.repeat(501)}, {nextNo: 1}).errors.map((e) => e.field), ['basisReference']);
});

test('暦にある日付だけを払った日として受ける（閏年を含む）', () => {
  assert.deepEqual(['2024-02-29', '2026-02-28', '2000-02-29', '2026-12-31'].map(isCalendarDate), [true, true, true, true]);
  assert.deepEqual(['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-5-1', '２０２６-05-01', 20260501].map(isCalendarDate), [false, false, false, false, false, false, false]);
});

test('FR-REV-KPI-039 払込の判定: 払った月が締めた月まで（締めた月を含む）なら実績の側、あとは締めていない側。締めた月が無ければ判定しない', () => {
  assert.equal(paymentSide('2026-11-30', '2026-11'), 'actual');
  assert.equal(paymentSide('2026-10-01', '2026-11'), 'actual');
  assert.equal(paymentSide('2026-12-01', '2026-11'), 'open');
  assert.equal(paymentSide('2026-12-01', null), null);
  assert.throws(() => paymentSide('2026-12-01', '2026-11-01'), /YYYY-MM/);
});

// 案件10: 稟議1（3,000,000 払込 2026-04・2026-06）と稟議2（承認済み 1,500,000 のうち 500,000 払込 2026-08）。締めた月 2026-07 なので、
//   2026-08 の払込は締めていない側で出資額に入れない → 出資額 3,000,000、収益 1,234,567 → 差額 −1,765,433（回収待ち）、回収率 trunc(1234567×10000÷3000000)=4115
// 案件11: 稟議1（2,000,000 払込 2026-03）、収益 2,500,001 → 差額 500,001（回収済み）、回収率 trunc(2500001×10000÷2000000)=12500
// 案件12: 稟議の無い自社出資の案件 → 稟議なし。案件13: 承認だけ（払込前）。案件14: 払込はあるが請求額と違う入金がある（収益が未確定）
// 合計は差額の分かる案件10・11だけ: 出資額 5,000,000、収益 3,734,568、差額 −1,265,432、回収率 trunc(3734568×10000÷5000000)=7469
test('FR-REV-KPI-039 FR-REV-KPI-049 自社出資の出資額は締めた月までの稟議の払込の累計、収益は入金の基準の確定の売上で、差額・回収率・状態を出し、合計は差額の分かる案件だけで足す', () => {
  const projects = [10, 11, 12, 13, 14].map((id) => ({id, code: `FICT-OI-${id}`, title: `架空の自社出資${id}`, earning_type: 'own_investment'}));
  const versions = [
    row(10, 1, 1, 'applied', 3000000, {basis: 'x'}), row(10, 1, 2, 'approved', 3000000),
    row(10, 1, 3, 'paid', 1200000, {paidOn: '2026-04-15'}), row(10, 1, 4, 'paid', 1800000, {paidOn: '2026-06-30'}),
    row(10, 2, 1, 'applied', 1500000, {basis: 'x'}), row(10, 2, 2, 'approved', 1500000), row(10, 2, 3, 'paid', 500000, {paidOn: '2026-08-01'}),
    row(11, 1, 1, 'applied', 2000000, {basis: 'x'}), row(11, 1, 2, 'approved', 2000000), row(11, 1, 3, 'paid', 2000000, {paidOn: '2026-03-10'}),
    row(13, 1, 1, 'applied', 700000, {basis: 'x'}), row(13, 1, 2, 'approved', 700000),
    row(14, 1, 1, 'applied', 800000, {basis: 'x'}), row(14, 1, 2, 'approved', 800000), row(14, 1, 3, 'paid', 800000, {paidOn: '2026-02-01'}),
  ];
  const cumulative = cashView({10: 1234567, 11: 2500001, 14: 900000}, [14]);
  const periodView = cashView({10: 234567, 11: 0, 14: 0});
  const out = ownInvestmentSource({projects, versions, cumulative, periodView}, {closedMonth: '2026-07', period: {from: '2026-04', to: '2027-03'}});
  const pick = (r) => [r.code, r.investmentYen, r.revenueYen, r.diffYen, r.recoveryRateBps, r.status, r.periodInvestmentYen, r.periodRevenueYen, r.remainingYen];
  // 承認の額の合計（予定の払込を含む）は出資額と別に並べる
  assert.deepEqual(out.rows.map((r) => [r.code, r.approvedYen]), [['FICT-OI-10', 4500000], ['FICT-OI-11', 2000000], ['FICT-OI-12', null], ['FICT-OI-13', 700000], ['FICT-OI-14', 800000]]);
  assert.deepEqual(out.rows.map(pick), [
    ['FICT-OI-10', 3000000, 1234567, -1765433, 4115, 'awaiting', 3000000, 234567, 1000000],
    ['FICT-OI-11', 2000000, 2500001, 500001, 12500, 'recovered', 0, 0, 0],
    ['FICT-OI-12', null, 0, null, null, 'no_approval', null, 0, null],
    ['FICT-OI-13', 0, 0, null, null, 'not_paid', 0, 0, 700000],
    ['FICT-OI-14', 800000, 900000, null, null, 'unsettled', 0, 0, 0],
  ]);
  assert.deepEqual(out.total, {rowCount: 2, investmentYen: 5000000, revenueYen: 3734568, diffYen: -1265432, periodInvestmentYen: 3000000, periodRevenueYen: 234567,
    recoveryRateBps: 7469, status: 'awaiting'});
  assert.equal(out.frameYen, 1700000);
  assert.deepEqual(out.excludedFromTotal.map((r) => [r.code, r.status]), [['FICT-OI-12', 'no_approval'], ['FICT-OI-13', 'not_paid'], ['FICT-OI-14', 'unsettled']]);
  // 払込の版に実績の側・締めていない側の印
  const sides = out.rows[0].approvals.flatMap((a) => a.versions.filter((v) => v.status === 'paid').map((v) => [v.paidOn, v.side]));
  assert.deepEqual(sides, [['2026-04-15', 'actual'], ['2026-06-30', 'actual'], ['2026-08-01', 'open']]);
  // 期間の終わり（to）より後で締めた月までの払込（案件10の 2026-06-30 の 1,800,000）は出資額に入るが、期間の列には入らない
  //   → 期間 2026-04〜2026-05 の出資額は案件10が 2026-04-15 の 1,200,000 だけ、案件11は期間の始まりより前の払込だけで 0
  // 壊れたら: 期間の列を始まり（from）だけで絞ると案件10の期間の出資額が 3,000,000 になって落ちる
  const early = ownInvestmentSource({projects, versions, cumulative, periodView}, {closedMonth: '2026-07', period: {from: '2026-04', to: '2026-05'}});
  assert.deepEqual(early.rows.map((r) => [r.code, r.investmentYen, r.periodInvestmentYen]),
    [['FICT-OI-10', 3000000, 1200000], ['FICT-OI-11', 2000000, 0], ['FICT-OI-12', null, null], ['FICT-OI-13', 0, 0], ['FICT-OI-14', 800000, 0]]);
  assert.equal(early.total.periodInvestmentYen, 1200000);
  // 締めた月が無ければ全部の払込を数える（案件10は 3,500,000）。期間を渡さなければ期間の列は null
  const open = ownInvestmentSource({projects, versions, cumulative}, {});
  assert.deepEqual(pick(open.rows[0]), ['FICT-OI-10', 3500000, 1234567, -2265433, 3527, 'awaiting', null, null, 1000000]);
  assert.deepEqual([open.total.periodInvestmentYen, open.total.periodRevenueYen], [null, null]);
});

// 締めた月の境界（計画の「利益の5源泉」の払込の判定）: 案件20 の稟議1（承認 5,000,000）に、締めた月 2026-07 の最後の日 2026-07-31 の払込 1,000,000 と
//   翌月の最初の日 2026-08-01 の払込 2,000,000。出資額は締めた月の払込だけの 1,000,000、収益 400,000 → 差額 −600,000、回収率 trunc(400000×10000÷1000000)=4000。
//   期間の列（2026-07〜2026-08）の出資額も 1,000,000（翌月の払込は期間の中でも締めていない側なので入れない）。出資枠は承認−払込の累計で 2,000,000
// 壊れたら: 出資額の判定を締めた月を含まない形（払った月 < 締めた月）にすると出資額が 0 で払込前になり、翌月を含めると 3,000,000 になって落ちる
test('FR-REV-KPI-039 締めた月の払込は実績の側で出資額に入り、翌月の払込は締めていない側で出資額にも期間の列にも入らない（払込の側の印と同じ規則）', () => {
  const projects = [{id: 20, code: 'FICT-OI-20', title: '架空の自社出資20', earning_type: 'own_investment'}];
  const versions = [
    row(20, 1, 1, 'applied', 5000000, {basis: 'x'}), row(20, 1, 2, 'approved', 5000000),
    row(20, 1, 3, 'paid', 1000000, {paidOn: '2026-07-31'}), row(20, 1, 4, 'paid', 2000000, {paidOn: '2026-08-01'}),
  ];
  const out = ownInvestmentSource({projects, versions, cumulative: cashView({20: 400000}), periodView: cashView({20: 400000})},
    {closedMonth: '2026-07', period: {from: '2026-07', to: '2026-08'}});
  const [r] = out.rows;
  assert.deepEqual([r.investmentYen, r.diffYen, r.recoveryRateBps, r.status, r.periodInvestmentYen, r.approvedYen, r.remainingYen],
    [1000000, -600000, 4000, 'awaiting', 1000000, 5000000, 2000000]);
  assert.deepEqual(r.approvals[0].versions.filter((v) => v.status === 'paid').map((v) => [v.paidOn, v.side]), [['2026-07-31', 'actual'], ['2026-08-01', 'open']]);
  // 締めた月を1つ進めると、2026-08-01 の払込も実績の側で出資額に入る（3,000,000）
  const next = ownInvestmentSource({projects, versions, cumulative: cashView({20: 400000})}, {closedMonth: '2026-08'});
  assert.deepEqual([next.rows[0].investmentYen, next.rows[0].approvals[0].versions.at(-1).side], [3000000, 'actual']);
  // 締めた月が最初の払込より前なら、どの払込も出資額に入らず払込前
  const before = ownInvestmentSource({projects, versions, cumulative: cashView({20: 400000})}, {closedMonth: '2026-06'});
  assert.deepEqual([before.rows[0].investmentYen, before.rows[0].status], [0, 'not_paid']);
});

test('FR-REV-KPI-049 出資の回収の行が1つも無ければ合計の状態は unknown で回収率は null（0% で埋めない）', () => {
  const out = ownInvestmentSource({projects: [{id: 1, code: 'FICT-OI-1', title: 'x', earning_type: 'own_investment'}], versions: [], cumulative: cashView({})}, {});
  assert.deepEqual([out.total.rowCount, out.total.recoveryRateBps, out.total.status, out.frameYen], [0, null, 'unknown', null]);
  assert.throws(() => ownInvestmentSource({projects: [], versions: [], cumulative: {basis: 'accrual', byProject: [], unsettled: []}}, {}), /入金の基準/);
});
