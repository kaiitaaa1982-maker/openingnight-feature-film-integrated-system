// 源泉1 制作受託の実績（期間内の粗利。会社の売上も同じ額）と入金の予定を、受託の契約の最新の版と支払いの節目から導く純関数（行動指標の計画 段B #3）。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の「利益の5源泉」の源泉1と香盤表 #3。要件: docs/requirements/revenue/kpi-scenario-forecast.md の
// FR-REV-KPI-006（要確認12）と、project-cashflow-forecast-actual.md の FR-REV-YOJITSU-044。材料は src/planning/planning-store.mjs の
// readContractWorkSourceRows。DB・時刻・環境変数を読まない（docs/rules/architecture.md）。
// - 粗利＝受託費の純額＝受託費×入金した節目の割合（J-14 (a)）。節目ごとの受託費は フェーズ1 #10b の milestoneAmounts（最大剰余法で和が受託費）を
//   そのまま足し、ここで率を掛け直さない。制作の実費は粗利に入れない。会社の売上も同じ純額（FR-REV-KPI-005）
// - 入金した節目＝節目の月が締めた月までの節目（実績の側。計画の払込の判定と同じ）。受託の入金を案件に結ぶ規則（フェーズ1 #14b）と受託の請求明細
//   （FR-REV-CWORK-027）がまだ無いので、節目の月に入金したとみなす（receiptBasis が milestone_month。要確認12）。締めた月より後の節目は入金の予定
//   （契約済み）で、節目の月と額を返す。入金の遅れは市場の前提なので、ここでは足さない（足すのは段A の model の入金の時期）
// - 使う版は最新の版（率や節目を改めた版のあとは、過去の節目の額も変わる。売上の4区分の集計と同じ。入金日の時点の版を当てるかは YOJITSU の要確認14）
// - 版の無い案件は unregistered に出し、節目の欠けた版（アプリを通さない書き込み）の額は null（未確定）、稼ぎ方の無い案件は excluded に出す。
//   どれも0円で埋めない。版のある案件が1件も無ければ rows を null（源泉1は未接続）にする
// - 受託費率・総製作費・節目は交渉の条件なので、ここでは読むだけで動かさない（FR-REV-KPI-018）
// 段A の model（src/revenue/scenario/。PR #109）へは、段B #2 が rows を実績（facts）の源泉1として渡し、feeReceivedPeriodYen が null でない行の
// feeReceivedPeriodYen の和を源泉1の実績（粗利と会社の売上）、received が false の節目を契約済みの入金の予定にする
import {contractVersionComplete, milestoneAmounts} from '../../planning/contract-production/contract-production-model.mjs';

export const CONTRACT_WORK_SOURCE_VERSION = 'contract-work-source.2026-10-11';
// 稼ぎ方の参照表 earning_types.profit_source の源泉1（制作受託。移行 0012）
export const CONTRACT_WORK_PROFIT_SOURCE = 1;
export const RECEIPT_BASIS = 'milestone_month';

const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const sum = (rows, pick) => rows.reduce((n, row) => n + pick(row), 0);

function checkWindow(period, closedMonth) {
  if (!period || !MONTH.test(period.from ?? '') || !MONTH.test(period.to ?? '')) throw new Error(`期間は {from, to} の YYYY-MM で渡します: ${JSON.stringify(period)}`);
  if (period.from > period.to) throw new Error(`期間の始まりが終わりより後です: ${period.from}〜${period.to}`);
  if (!MONTH.test(closedMonth ?? '')) throw new Error(`締めた月は YYYY-MM で渡します: ${closedMonth}`);
}

// 1つの案件の行（版のある案件）。complete が false の版は額を null にし、節目の月と割合だけを返す。
// 節目の行の版の番号が案件の行の版と食い違う（別の時点に読んだ材料。store は同じ時点から読むので、ほかの呼び出し元の誤り）ときは、
// 食い違う節目を使わず、版を揃っていない扱い（額 null）にする。古い版の受託費に新しい版の節目の割合を掛けた額を出さない
function projectRow(project, ownRows, window) {
  const budgetYen = Number(project.budget_yen);
  const feeYen = Number(project.fee_yen);
  const versionNo = Number(project.version_no);
  const own = ownRows.filter((m) => Number(m.version_no) === versionNo);
  const complete = own.length === ownRows.length && contractVersionComplete({milestone_count: project.milestone_count, recorded_milestones: own.length,
    share_total_bps: sum(own, (m) => Number(m.share_bps))});
  const amounts = complete ? new Map(milestoneAmounts({budgetYen, feeYen, milestones: own}).map((a) => [a.seq, a])) : null;
  const milestones = own.map((m) => {
    const seq = Number(m.seq);
    const month = String(m.due_on).slice(0, 7);
    return {seq, month, shareBps: Number(m.share_bps), received: month <= window.closedMonth,
      budgetYen: amounts ? amounts.get(seq).budgetYen : null, feeYen: amounts ? amounts.get(seq).feeYen : null};
  });
  const received = milestones.filter((m) => m.received);
  const inPeriod = received.filter((m) => m.month >= window.from && m.month <= window.to);
  return {
    projectId: Number(project.project_id), code: project.code, title: project.title,
    versionNo, budgetYen, markupBps: Number(project.markup_bps), feeYen, complete,
    receivedShareBps: complete ? sum(received, (m) => m.shareBps) : null,
    feeReceivedTotalYen: complete ? sum(received, (m) => m.feeYen) : null,
    feeReceivedPeriodYen: complete ? sum(inPeriod, (m) => m.feeYen) : null,
    milestones,
  };
}

// readContractWorkSourceRows の返り値と、期間（{from, to} の YYYY-MM）・締めた月（YYYY-MM）から源泉1を導く。
// 期間内の実績は 期間の始まり〜（期間の終わりと締めた月の早い方）の節目、累計は締めた月までの節目（段A の actualWindow と同じ窓）
export function contractWorkSource({projects, milestones}, {period, closedMonth}) {
  checkWindow(period, closedMonth);
  const window = {from: period.from, to: closedMonth < period.to ? closedMonth : period.to, closedMonth};
  const ownOf = new Map();
  for (const m of milestones) {
    const id = Number(m.project_id);
    if (!ownOf.has(id)) ownOf.set(id, []);
    ownOf.get(id).push(m);
  }
  const rows = [];
  const unregistered = [];
  const excluded = [];
  for (const project of [...projects].sort((a, b) => Number(a.project_id) - Number(b.project_id))) {
    const base = {projectId: Number(project.project_id), code: project.code, title: project.title};
    if (Number(project.profit_source) !== CONTRACT_WORK_PROFIT_SOURCE) {
      excluded.push({...base, reason: project.earning_type == null ? 'no_earning_type' : 'other_profit_source'});
      continue;
    }
    if (project.version_no == null) {
      unregistered.push(base);
      continue;
    }
    const own = (ownOf.get(base.projectId) ?? []).sort((a, b) => Number(a.seq) - Number(b.seq));
    rows.push(projectRow(project, own, window));
  }
  return {
    definitionVersion: CONTRACT_WORK_SOURCE_VERSION, receiptBasis: RECEIPT_BASIS, window,
    rows: rows.length ? rows : null, unknownCount: rows.filter((row) => !row.complete).length, unregistered, excluded,
  };
}
