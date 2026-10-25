// store（scenario-store.mjs）が読んだ行から、シナリオの比較の実績（facts。scenario-inputs.mjs の normalizeScenarioFacts の形）を作る。純関数で、DB・時刻・乱数に触れない。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の「段A」の表（源泉1〜5の取り方・作品→源泉の対応）と「出資の回収」。
// - 期間内の実績は 期間の始まり〜（期間の終わりと締めた月の早い方）の月だけ。累計は締めた月まで（締めた月より後の行は実績に入れない）
// - 作品→源泉: 源泉3＝委員会の契約がある作品、源泉2＝委員会でなく最新の版の自社出資額が NULL でない作品、
//   源泉4＝最新の版の買付額（sales_rights_purchase_yen）が NULL でない作品（買い切り）か MG の分配契約がある作品（MG つき）、
//   源泉5＝委託（commission）の分配契約がある作品。作品マスタの契約一覧の権利の取得（kind='acquisition'）は見ない
//   （買付額も MG も無い作品を買付に入れない。架空の作品マスタはどの作品にも権利の取得の契約がある）
// - 重なり（源泉2・3の作品が源泉4・5にも入る）: 契約のある源泉4・5を先にする。自社出資の回収には、買い切りの買付（買付額があり MG の分配契約が無い）にも入る作品は
//   入金を当てず（0円。売上はすべて買付の契約に属するとみなす）、それ以外は分配契約に紐付かない報告の入金だけを当てる。
//   委員会の取得額は契約の分と分けられないので、その作品の行に overlap を付け、model は源泉3の実績に入れない（未確定。出資の回収の行には取得額を出す）。
//   重なった作品の数を overlapCount に出す
// - 源泉1（受託）は読む表が無いので facts に持たない（model が未接続にする）。自社の取引先が無い組織の委員会は null（未接続）で、0円で埋めない
// - 委員会の行に selfInvested（自社の出資比率・約定の出資額・払込のどれかがある）を付け、model は出資の回収の行をその作品だけにする
// - 作品ごとの参考の列（買付額・MG・MG 残・作品単位の入金。税込・未確定）は facts に入れず、作品→源泉の対応の行に添える
import {splitByWeights} from '../../reports/pl-bs-model.mjs';
import {splitByAllocation} from '../../money-allocation.mjs';
import {ScenarioInputError} from './scenario-inputs.mjs';

export const FACTS_VERSION = 'scenario-facts.2026-10-10';

const sum = (rows, pick) => rows.reduce((n, row) => n + pick(row), 0);
const monthOf = (date) => String(date ?? '').slice(0, 7);

// 期間内（始まり〜期間の終わりと締めた月の早い方）と、累計（締めた月まで）の月の判定
export function actualWindow(period, closedMonth) {
  const to = closedMonth < period.to ? closedMonth : period.to;
  return {
    from: period.from, to, closedMonth,
    inPeriod: (month) => month >= period.from && month <= to,
    upToClose: (month) => month <= closedMonth,
  };
}

// 作品ごとの源泉（複数あり得る）と、重なった作品
export function sourceMap({works, finance, settlementContracts}) {
  const financeOf = new Map(finance.map((row) => [row.workId, row]));
  const types = new Map();
  for (const row of settlementContracts) {
    if (!types.has(row.workId)) types.set(row.workId, new Set());
    types.get(row.workId).add(row.contractType);
  }
  const out = new Map();
  for (const work of works) {
    const kinds = types.get(work.id) ?? new Set();
    const purchased = financeOf.get(work.id)?.salesRightsPurchaseYen != null;
    const sources = [];
    if (work.committee) sources.push('committee');
    else if (financeOf.get(work.id)?.ownInvestmentYen != null) sources.push('own_investment');
    if (purchased || kinds.has('mg')) sources.push('acquisition');
    if (kinds.has('commission')) sources.push('consignment');
    const overlap = sources.some((s) => s === 'own_investment' || s === 'committee') && sources.some((s) => s === 'acquisition' || s === 'consignment');
    // outright: 買い切りの買付（最新の版の買付額があり、MG の分配契約が無い）。期間内の税抜売上をすべて源泉4に数える
    out.set(work.id, {sources, mg: kinds.has('mg'), outright: purchased && !kinds.has('mg'), overlap});
  }
  return out;
}

// 請求ごとの作品の重み（請求明細の税込額を作品配賦で分けた額の和。pl-bs-data.mjs の入金の配り方と同じ）。
// 重なった作品は、分配契約に紐付いた報告の明細を「作品:linked」、それ以外を「作品」の鍵に分ける
function invoiceWeights(invoiceLines, reportOfSale, linkedReports) {
  const bySale = new Map();
  for (const row of invoiceLines) {
    const key = `${row.invoiceId}:${row.saleId}`;
    if (!bySale.has(key)) bySale.set(key, {invoiceId: row.invoiceId, saleId: row.saleId, amount: row.amountIncTax, shares: []});
    bySale.get(key).shares.push({work_id: row.workId, allocation_bps: row.allocationBps});
  }
  const out = new Map();
  for (const item of bySale.values()) {
    if (sum(item.shares, (share) => share.allocation_bps) !== 10000) continue;
    const parts = splitByAllocation(item.amount, item.shares);
    if (!out.has(item.invoiceId)) out.set(item.invoiceId, new Map());
    const map = out.get(item.invoiceId);
    for (const [workId, amount] of parts) {
      const linked = linkedReports.get(workId)?.has(reportOfSale.get(item.saleId));
      const key = linked ? `${workId}:linked` : workId;
      map.set(key, (map.get(key) || 0) + amount);
    }
  }
  return out;
}

// 作品の入金（税込）を、入金ごとに請求の作品の重みで分けた額。onlyUnlinked なら分配契約に紐付かない報告の分だけ
function workReceipts(workId, receipts, weightsOf) {
  const out = [];
  for (const receipt of receipts) {
    const weights = weightsOf ? [...(weightsOf.get(receipt.invoiceId) ?? new Map()).entries()].map(([key, weight]) => ({key, weight: Math.max(0, weight)}))
      : receipt.weights.map((row) => ({key: row.workId, weight: row.weight}));
    const amount = (splitByWeights(receipt.amount, weights) ?? new Map()).get(workId);
    if (amount !== undefined) out.push({month: monthOf(receipt.receivedOn), amount});
  }
  return out;
}

// store の行 → facts（normalizeScenarioFacts へ渡す形）と、作品→源泉の対応の要約
export function buildScenarioFacts(raw, request) {
  const window = actualWindow(request.period, request.closedMonth);
  const titleOf = new Map(raw.works.map((work) => [work.id, work.title]));
  const map = sourceMap(raw);
  const worksOf = (source) => raw.works.filter((work) => map.get(work.id).sources.includes(source)).map((work) => work.id);
  const financeOf = new Map(raw.finance.map((row) => [row.workId, row]));
  const linesOf = new Map();
  for (const line of raw.saleLines) {
    if (!window.upToClose(line.month)) continue;
    if (!linesOf.has(line.workId)) linesOf.set(line.workId, []);
    linesOf.get(line.workId).push(line);
  }
  const periodLines = (workId) => (linesOf.get(workId) ?? []).filter((line) => window.inPeriod(line.month));

  // 商談・売上（作品×取引先×月・税抜。締めた月まで）・活動
  const workSet = new Set(raw.works.map((work) => work.id));
  const opportunities = raw.opportunities.filter((row) => workSet.has(row.workId));
  const opportunityIds = new Set(opportunities.map((row) => row.id));
  const salesKey = new Map();
  for (const lines of linesOf.values()) {
    for (const line of lines) {
      const key = `${line.workId}:${line.partnerId}:${line.month}`;
      if (!salesKey.has(key)) salesKey.set(key, {workId: line.workId, partnerId: line.partnerId, month: line.month, amountYen: 0});
      salesKey.get(key).amountYen += line.amount;
    }
  }
  const salesByWorkPartner = [...salesKey.values()].sort((a, b) => a.workId - b.workId || a.partnerId - b.partnerId || (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const activities = raw.activities.filter((row) => opportunityIds.has(row.opportunityId));

  // 源泉2 自社出資: 出資額＝最新の版（払込の月を持たないので期間より前に払った扱い。model は期間の粗利から引かず、出資の回収の累計の差額にだけ使う）、
  // 回収額＝作品の入金（税込）。重なった作品のうち、買い切りの買付にも入る作品は入金を当てず（源泉4が売上を全部数える）、
  // それ以外（委託・MG の分配契約）は分配契約に紐付かない報告の入金だけ
  const outrightOwn = new Set(worksOf('own_investment').filter((workId) => map.get(workId).overlap && map.get(workId).outright));
  const overlapOwn = worksOf('own_investment').filter((workId) => map.get(workId).overlap && !outrightOwn.has(workId));
  let weightsOf = null;
  if (overlapOwn.length) {
    const reportOfSale = new Map(raw.saleLines.map((line) => [line.saleId, line.reportId]));
    const linked = new Map(overlapOwn.map((workId) => [workId, new Set(raw.previews.get(workId)?.linkedReportIds ?? [])]));
    weightsOf = invoiceWeights(raw.invoiceLines, reportOfSale, linked);
  }
  const ownInvestment = worksOf('own_investment').map((workId) => {
    const receipts = outrightOwn.has(workId) ? [] : workReceipts(workId, raw.receipts, map.get(workId).overlap ? weightsOf : null);
    return {
      workId, title: titleOf.get(workId), investmentYen: financeOf.get(workId).ownInvestmentYen,
      receiptsTotalYen: sum(receipts.filter((row) => window.upToClose(row.month)), (row) => row.amount),
      receiptsPeriodYen: sum(receipts.filter((row) => window.inPeriod(row.month)), (row) => row.amount),
    };
  });

  // 源泉3 委員会: 自社の払込（全部の条件版）と、自社の取得額（委員会の月次収支の月別の値）。自社の取引先が無ければ未接続。
  // selfInvested＝自社の出資比率（委員会の参加者の持分）か約定の出資額か締めた月までの払込がある作品。出資の回収の行はこの作品だけにする
  // （計画の「出資のある案件ごと」。自社が参加者でない・出資の無い委員会の作品は、源泉3の実績には入れるが、出資額0で回収済みの行にしない）
  const selfPartnerId = raw.selfPartnerId ?? null;
  const committeeOf = new Map(raw.committee.map((row) => [row.workId, row]));
  const committee = selfPartnerId === null ? null : worksOf('committee').map((workId) => {
    const entry = committeeOf.get(workId) ?? {acquisitions: [], error: '委員会の月次収支を読めません', holdNote: null};
    const payments = raw.investmentPayments.filter((row) => row.workId === workId && row.partnerId === selfPartnerId);
    // 締めた月より後の日付の払込（前もって記録したもの）は、期間内でも累計・期間内のどちらにも入れない（実績ではない。予定の払込として引くのは段B。model の注記で知らせる）
    const paid = payments.filter((row) => window.upToClose(monthOf(row.paidOn)));
    const acquisitions = (entry.acquisitions ?? []).filter((row) => window.upToClose(row.month));
    return {
      workId, title: titleOf.get(workId),
      selfInvested: entry.selfShareBps != null || entry.committedYen != null || paid.length > 0,
      overlap: map.get(workId).overlap,
      paymentsTotalYen: sum(paid, (row) => row.amount),
      paymentsPeriodYen: sum(payments.filter((row) => window.inPeriod(monthOf(row.paidOn))), (row) => row.amount),
      acquisitionsTotalYen: entry.error ? null : sum(acquisitions, (row) => row.acquisition || 0),
      acquisitionsPeriodYen: entry.error ? null : sum(acquisitions.filter((row) => window.inPeriod(row.month)), (row) => row.acquisition || 0),
      error: entry.error ?? null, holdNote: entry.holdNote ?? null,
    };
  });

  // 源泉4 買付（J-9 (c)）: MG の分配契約があれば MG つき（MG の行の手数料の和。MG 残は参考）、無ければ買い切り（期間内の税抜売上と買付額。
  // 買付額は払った月を持たないので期間より前に払った扱いで、model は期間の粗利から引かない）
  const acquisition = worksOf('acquisition').map((workId) => {
    const salesPeriodYen = sum(periodLines(workId), (line) => line.amount);
    const base = {workId, title: titleOf.get(workId), salesPeriodYen, purchaseYen: financeOf.get(workId)?.salesRightsPurchaseYen ?? null,
      agencyFeePeriodYen: null, mgContractYen: null, mgBalanceYen: null};
    if (!map.get(workId).mg) return {...base, kind: 'outright'};
    const preview = raw.previews.get(workId);
    const lines = preview.lineResults.filter((row) => row.contractType === 'mg' && window.inPeriod(row.accountingMonth));
    const summaries = preview.contractSummaries.filter((row) => row.contractType === 'mg');
    return {...base, kind: 'mg',
      agencyFeePeriodYen: lines.some((row) => row.agencyFee === null) ? null : sum(lines, (row) => row.agencyFee),
      mgContractYen: summaries.some((row) => row.mgContractYen === null) ? null : sum(summaries, (row) => row.mgContractYen),
      mgBalanceYen: summaries.some((row) => row.mgBalance === null) ? null : sum(summaries, (row) => row.mgBalance)};
  });

  // 源泉5 販売委託: 委託の行だけの手数料（純額）と権利元へ渡る額。紐付けていない報告は件数と税抜額を別に出す
  const unlinkedIds = new Set();
  let unlinkedAmount = 0;
  const consignment = worksOf('consignment').map((workId) => {
    const preview = raw.previews.get(workId);
    const lines = preview.lineResults.filter((row) => row.contractType === 'commission' && window.inPeriod(row.accountingMonth));
    // 記録の側の誤り（facts の形の誤りと同じく、受け口は409「記録を読めません」で返す）
    if (lines.some((row) => row.agencyFee === null || row.holderAmount === null)) throw new ScenarioInputError('facts.consignment', `委託の手数料率が無い分配契約の行があります（作品 ${workId}）`);
    const unlinked = new Set(preview.unlinkedReportIds);
    for (const line of periodLines(workId)) {
      if (!unlinked.has(line.reportId)) continue;
      unlinkedIds.add(line.reportId);
      unlinkedAmount += line.amount;
    }
    return {workId, title: titleOf.get(workId), agencyFeePeriodYen: sum(lines, (row) => row.agencyFee), holderAmountPeriodYen: sum(lines, (row) => row.holderAmount)};
  });

  // 作品ごとの参考の列（計画の段A の表）: 源泉4の買付額・MG の契約額・MG 残（未控除）と、作品単位の入金（税込・未確定。請求の作品の重みで分けた額の
  // 締めた月までの累計と期間内）。期待値には使わない。重なった自社出資の作品も、ここは紐付けを問わない作品の入金の全部
  const acquisitionOf = new Map(acquisition.map((row) => [row.workId, row]));
  const referenceOf = (workId) => {
    const receipts = workReceipts(workId, raw.receipts, null);
    const row = acquisitionOf.get(workId);
    return {
      purchaseYen: row ? row.purchaseYen : null, mgContractYen: row ? row.mgContractYen : null, mgBalanceYen: row ? row.mgBalanceYen : null,
      receiptsTotalYen: sum(receipts.filter((r) => window.upToClose(r.month)), (r) => r.amount),
      receiptsPeriodYen: sum(receipts.filter((r) => window.inPeriod(r.month)), (r) => r.amount),
    };
  };

  const overlapWorkIds = raw.works.filter((work) => map.get(work.id).overlap).map((work) => work.id);
  return {
    facts: {
      opportunities, salesByWorkPartner, activities, ownInvestment, committee, acquisition, consignment,
      overlapCount: overlapWorkIds.length, unlinkedReports: {count: unlinkedIds.size, amountYen: unlinkedAmount},
    },
    sourceOfWork: raw.works.map((work) => ({workId: work.id, sources: map.get(work.id).sources, overlap: map.get(work.id).overlap, ...referenceOf(work.id)})),
    overlapWorkIds,
    // 買い切りの買付にも入るので、自社出資の回収に入金を当てなかった作品
    outrightOverlapWorkIds: [...outrightOwn].sort((a, b) => a - b),
    window: {from: window.from, to: window.to, closedMonth: window.closedMonth},
  };
}
