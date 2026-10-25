// 源泉2 自社出資の出資と回収を、稟議の版（移行 0019）と会社への利益額（K-16。フェーズ1 #14b）の入金の売上から導く純関数（行動指標の計画 段B #4）。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の「利益の5源泉」の源泉2・「出資の回収」の節・香盤表 #4。要件:
// docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-039・049 と、project-cashflow-forecast-actual.md の FR-REV-YOJITSU-030。
// 材料は src/planning/planning-store.mjs の readInvestmentApprovals（案件と稟議の版）と、profit-model.mjs の buildCompanyProfit の入金の基準の応答。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。
// - 出資額＝稟議の払込の版の額の累計（払った日が締めた月まで。払った月に引く。J-11b (a)）。締めた月より後の払込と、承認したがまだ払っていない分は
//   予測の側（段B #2・#16 が払う月に引く）なので出資額に入れない。承認の額の合計は approvedYen で並べる（FR-REV-YOJITSU-030 の「最新の版の出資額」と
//   同じく予定の払込を含む額。出資の回収の出資額をどちらにするかは要件の要確認17）。払込の無い稟議は払込前、稟議の無い案件は出資額が分からない
// - 回収額（収益）＝案件の入金の基準の確定の売上（入金×売上率。税別）の累計（締めた月まで）。入金を案件に結ぶ規則は #14b と同じ
//   （消込 → 請求明細の作品の配賦 → 作品の案件。revenue/yojitsu/receipt-inflow-model.mjs）で、ここで入金を読み直さない
// - 差額＝収益−出資額、回収率＝収益÷出資額（bp。truncate は要件の要確認10 まで仮。money-yojitsu の ratioBps）。差額が負なら「回収待ち」で、未達と書かない
// - 稟議の無い案件・払込前の案件・収益に未確定（請求額と違う入金・売上率の決まらない案件など）のある案件は、差額と回収率を null にし、
//   合計に入れない（合計は差額の分かる行だけで足し、どの列も同じ行の集合にする。FR-REV-KPI-049）
// - 払込の判定（計画の「利益の5源泉」）: 払った月が締めた月まで（締めた月を含む）の払込は実績の側、あとは締めていない側（予測で払う月に引く側）。
//   締めた月が無ければ判定しない（null）
// 段A の出資の回収（src/revenue/scenario/。core PR #109）と段B #16 の予実の全体へは、段B #2・#16 が rows をそのまま源泉2の行として渡す
import {ratioBps} from '../../revenue/yojitsu/money-yojitsu.mjs';
import {summarizeApprovals} from '../../planning/investment-approval/investment-approval-model.mjs';

export const OWN_INVESTMENT_SOURCE_VERSION = 'own-investment-source.2026-10-11';
export const RECOVERY_STATUS_LABELS = Object.freeze({
  no_approval: '稟議なし', not_paid: '払込前', unsettled: '未確定', awaiting: '回収待ち', recovered: '回収済み',
});
// 収益に入れない売上の費目（profit-model の PROFIT_ITEMS の売上の側で、状態が未確定のもの）があれば、その案件の収益は未確定
const SALES_SIDE = 'sales';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOf = (date) => String(date ?? '').slice(0, 7);

// 払込1件の側（actual＝締めた月までで実績の側、open＝締めた月より後で締めていない側）。締めた月が無ければ null
export function paymentSide(paidOn, closedMonth) {
  if (closedMonth === null || closedMonth === undefined) return null;
  if (!MONTH.test(closedMonth)) throw new Error(`締めた月は YYYY-MM で渡します: ${closedMonth}`);
  return monthOf(paidOn) <= closedMonth ? 'actual' : 'open';
}

function checkPeriod(period) {
  if (period === null) return;
  const {from = null, to = null} = period;
  for (const value of [from, to]) if (value !== null && !MONTH.test(value)) throw new Error(`期間の月は YYYY-MM で渡します: ${value}`);
  if (from !== null && to !== null && from > to) throw new Error(`期間の始まりが終わりより後です: ${from}〜${to}`);
}

// 入金の基準の利益額の応答（buildCompanyProfit）から、案件ごとの確定の売上と、売上の側に未確定の額のある案件
function salesOf(view) {
  if (!view) return null;
  if (view.basis !== 'cash') throw new Error('回収額は入金の基準（cash）の利益額の応答から読みます');
  return {
    salesYen: new Map(view.byProject.map((p) => [Number(p.projectId), p.salesYen])),
    unsettled: new Set(view.unsettled.filter((row) => row.side === SALES_SIDE).flatMap((row) => row.projectIds.map(Number))),
  };
}

function sum(values) {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next)) throw new Error('額の和が安全な整数の範囲を超えました');
    return next;
  }, 0);
}

// projects・versions は readInvestmentApprovals の返り値。cumulative は締めた月まで（締めた月が無ければ全期間）の入金の基準の利益額の応答、
// periodView は期間（period）の中で締めた月までの入金の基準の利益額の応答（期間を渡さなければ null）。
// closedMonth は締めた月（YYYY-MM か null）、period は {from, to}（YYYY-MM か null。期間の列を出すとき）か null
export function ownInvestmentSource({projects, versions, cumulative, periodView = null}, {closedMonth = null, period = null} = {}) {
  if (closedMonth !== null && !MONTH.test(closedMonth)) throw new Error(`締めた月は YYYY-MM で渡します: ${closedMonth}`);
  checkPeriod(period);
  const total = salesOf(cumulative);
  const inPeriod = salesOf(periodView);
  if (period !== null && !inPeriod) throw new Error('期間の列には期間の利益額の応答（periodView）が要ります');
  // 出資額に数える払込は、払込の側の印（paymentSide）が締めていない側でないもの（締めた月が無ければ全部）。規則は paymentSide の1か所に置く
  const upToClosed = (paidOn) => paymentSide(paidOn, closedMonth) !== 'open';
  const inPeriodMonth = (paidOn) => period !== null && (period.from === null || monthOf(paidOn) >= period.from) && (period.to === null || monthOf(paidOn) <= period.to);
  const versionsOf = new Map();
  for (const row of versions) {
    const id = Number(row.project_id);
    if (!versionsOf.has(id)) versionsOf.set(id, []);
    versionsOf.get(id).push(row);
  }
  const rows = [...projects].sort((a, b) => Number(a.id) - Number(b.id)).map((project) => {
    const projectId = Number(project.id);
    const approvals = summarizeApprovals(versionsOf.get(projectId) ?? []).map((approval) => ({
      ...approval,
      versions: approval.versions.map((v) => (v.status === 'paid' ? {...v, side: paymentSide(v.paidOn, closedMonth)} : v)),
    }));
    const payments = approvals.flatMap((a) => a.versions.filter((v) => v.status === 'paid'));
    const counted = payments.filter((v) => upToClosed(v.paidOn));
    const revenueYen = total.salesYen.get(projectId) ?? 0;
    const unsettledRevenue = total.unsettled.has(projectId);
    let status;
    if (!approvals.length) status = 'no_approval';
    else if (!counted.length) status = 'not_paid';
    else if (unsettledRevenue) status = 'unsettled';
    const investmentYen = approvals.length ? sum(counted.map((v) => v.amountYen)) : null;
    const known = status === undefined;
    const diffYen = known ? revenueYen - investmentYen : null;
    if (known) status = diffYen < 0 ? 'awaiting' : 'recovered';
    return {
      projectId, code: project.code, title: project.title, earningType: project.earning_type ?? null,
      investmentYen, revenueYen, diffYen, recoveryRateBps: known ? ratioBps(revenueYen, investmentYen) : null,
      status, statusLabel: RECOVERY_STATUS_LABELS[status], unsettledRevenue,
      periodInvestmentYen: period === null || investmentYen === null ? null : sum(counted.filter((v) => inPeriodMonth(v.paidOn)).map((v) => v.amountYen)),
      periodRevenueYen: period === null ? null : inPeriod.salesYen.get(projectId) ?? 0,
      // 承認の額の合計（予定の払込を含む出資の約束。作品の費用の版の出資額と同じ意味の額）。承認済みの稟議が無ければ null
      approvedYen: approvals.some((a) => a.approvedYen !== null) ? sum(approvals.filter((a) => a.approvedYen !== null).map((a) => a.approvedYen)) : null,
      // 出資枠（承認の額−払込の累計）。承認済みの稟議の分だけ足す。承認済みの稟議が無ければ null
      remainingYen: approvals.some((a) => a.remainingYen !== null) ? sum(approvals.filter((a) => a.remainingYen !== null).map((a) => a.remainingYen)) : null,
      approvals,
    };
  });
  const knownRows = rows.filter((r) => r.diffYen !== null);
  const totalOf = (key) => sum(knownRows.map((r) => r[key]));
  const totalRow = {
    rowCount: knownRows.length,
    investmentYen: totalOf('investmentYen'), revenueYen: totalOf('revenueYen'), diffYen: totalOf('diffYen'),
    periodInvestmentYen: period === null ? null : totalOf('periodInvestmentYen'), periodRevenueYen: period === null ? null : totalOf('periodRevenueYen'),
  };
  totalRow.recoveryRateBps = knownRows.length ? ratioBps(totalRow.revenueYen, totalRow.investmentYen) : null;
  totalRow.status = knownRows.length ? (totalRow.diffYen < 0 ? 'awaiting' : 'recovered') : 'unknown';
  const frames = rows.filter((r) => r.remainingYen !== null);
  return {
    definitionVersion: OWN_INVESTMENT_SOURCE_VERSION, closedMonth, period,
    rows, total: totalRow,
    // 出資枠の合計（承認済み−払込。プロデューサーの供給。FR-REV-KPI-024）
    frameYen: frames.length ? sum(frames.map((r) => r.remainingYen)) : null,
    excludedFromTotal: rows.filter((r) => r.diffYen === null).map((r) => ({projectId: r.projectId, code: r.code, status: r.status})),
  };
}
