// 5つの源泉（稼ぎ方ごとの利益の内訳）の売上・出資額・経費・粗利を、計上・入金のどちらの基準でも出し、会社への利益額（K-16。フェーズ1 #14b）と
// 突き合わせる純関数（行動指標の計画 段B #2）。計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の「利益の5源泉」と香盤表 #2。
// 要件: docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-005・006・007・039 と、docs/requirements/accounting/company-profit.md の
// FR-ACCT-PROFIT-013。材料は src/accounting/accounting-store.mjs の readSourceProfitSources（利益額の記録・受託の契約の版の節目・稟議の版）。
// DB・時刻・環境変数を読まない（docs/rules/architecture.md）。
// - 源泉は案件の稼ぎ方から導き、手で選ばない（稼ぎ方の参照表 earning_types.profit_source。制作受託＝1・自社出資＝2・製作委員会＝3・買付＝4・販売委託＝5）
// - 実績の窓は 期間の始まり〜（期間の終わりと締めた月の早い方）。締めた月より後の記録は実績に入れない（計画の払込の判定「締めた月より前は実績の側」）。
//   締めた月が無ければ期間のまま（払込の判定をしない。源泉1は入金した節目を決められないので未確定）
// - 源泉2 自社出資: 会社への利益額の記録（profit-model の profitItemRows）のうち、稼ぎ方が自社出資の案件の行。売上＝回収（入金×売上率。計上の基準は
//   計上の売上×売上率）、出資額＝稟議の払込の版の額を払った月に（J-11b (a)）、経費＝ほかの確定の経費、粗利＝売上−出資額−経費。出資額は利益額の記録の
//   「自社出資の出資額」「製作委員会の出資額（自社の分）」の行からだけ数え、承認の額や出資の回収の累計から引き直さない（1回だけ引く）。
//   締めた月より後の払込と、承認したがまだ払っていない額は予測の側（forecast）に出し、実績から引かない。出資の回収（全期間の累計）は
//   own-investment-source-model の ownInvestmentSource をそのまま recovery に置く（入金の基準。#4）
// - 源泉1 制作受託: 売上＝粗利の売上の側＝受託費×入金した節目の割合の純額（J-14 (a)。contract-work-source-model の contractWorkSource）。
//   入金した節目は節目の月が締めた月までの節目（要確認12。receiptBasis が milestone_month）で、段階が契約済みの案件だけを数える。見送り（declined）と
//   契約前の段階の案件の節目は実績に数えず、理由つきで notCounted に出す（要確認12 の「見送りの案件の扱い」は除外にした）。契約済みで契約の版の無い
//   案件は受託費が分からないので売上に入れず、案件別の売上・粗利を null にして注記に件数を出す（0円の売上にしない）。経費は利益額の記録の
//   確定の経費（制作の実費は除外のまま。粗利に入れない）。利益額の売上（入金×受託費率）とは数え方が違うので、突き合わせの差の理由に出す
// - 源泉3〜5 は読み取りが入るまで（段B #5〜#7）未接続（額は null。0円で埋めない）。利益額にはその稼ぎ方の案件の額が入っているので、突き合わせに出す
// - 未確定（U-5・U-4 の残りなど）と除外の費目は粗利に入れず、源泉ごとに別の行に出す（利益額と同じ状態）
// - 突き合わせ: 源泉ごとに、源泉の粗利と利益額（同じ窓・同じ基準の buildCompanyProfit の案件別の和）と差、差の理由。合計の差は行の差の和
import {sumOf} from '../../reports/pl-bs-model.mjs';
import {basisFields} from '../../reports/pl-bs-cash-model.mjs';
import {AMOUNT_KINDS, PROFIT_ITEMS, STATUS_LABELS, TAX_LABEL, buildCompanyProfit, byCodePoint, profitItemRows, profitRecordsFromSources} from './profit-model.mjs';
import {CONTRACT_WORK_PROFIT_SOURCE, contractWorkSource} from './contract-work-source-model.mjs';
import {ownInvestmentSource} from './own-investment-source-model.mjs';

export const SOURCE_PROFIT_VERSION = 'source-profit.2026-10-11';
export const SOURCE_PROFIT_FORMULA = '源泉の粗利＝売上 − 出資額 − 経費（会社への利益額 K-16 の稼ぎ方ごとの内訳。源泉1の売上は受託費の純額）';

// 源泉の並び（稼ぎ方の参照表の profit_source と同じ番号）と、読み取りが入るまでの未接続の理由
export const PROFIT_SOURCES = Object.freeze([
  {source: 1, key: 'contract_work', label: '制作受託'},
  {source: 2, key: 'own_investment', label: '自社出資'},
  {source: 3, key: 'committee', label: '製作委員会', unconnected: '製作委員会の自社の取得額と払込を源泉に読む処理（行動指標の計画 段B #5）がまだ無い'},
  {source: 4, key: 'acquisition', label: '買付', unconnected: '買付の買付額・MG の支払と回収を源泉に読む処理（行動指標の計画 段B #6）がまだ無い'},
  {source: 5, key: 'consignment', label: '販売委託', unconnected: '販売委託の手数料を源泉に読む処理（行動指標の計画 段B #7）がまだ無い'},
]);
export const SOURCE_STATUS_LABELS = Object.freeze({connected: '接続', unconnected: '未接続', unknown: '未確定'});

// 出資額に数える費目（自社出資と製作委員会の自社の分）と、払った月に引く4費目（J-11b (a)）
export const INVESTMENT_ITEMS = Object.freeze(['own_investment', 'committee_investment']);
export const FOUR_ITEMS = Object.freeze(['own_investment', 'committee_investment', 'acquisition_mg', 'acquisition_buyout']);

// 源泉1で実績に数える段階（契約書を受領した段階）と、数えない理由
export const CONTRACTED_STAGE = 'contracted';
export const NOT_COUNTED_REASONS = Object.freeze({
  declined: '見送りの案件。入金を確かめる規則（フェーズ1 #14b の受託の入金）が入るまで、節目の月で入金したとはみなさない',
  not_contracted: '契約前の段階の案件。契約の版の節目は予定で、入金した節目に数えない',
});
export const RECEIPT_BASIS_LABEL = '節目の月で数える（入金は未確認。受託の入金を節目に当てる規則が入るまで）';

// 突き合わせの差の理由
export const RECONCILE_REASONS = Object.freeze({
  milestone_basis: '源泉1の売上は節目の月で数えた受託費の純額（J-14 (a)。入金は未確認）で、会社への利益額の売上は入金×受託費率（入金の行ごとに truncate）。差は売上の数え方の違い',
  unconnected: '源泉が未接続で粗利を出していない。会社への利益額には、この稼ぎ方の案件の額が入っている',
  unknown: '源泉の額が未確定（null）。会社への利益額には、この稼ぎ方の案件の額が入っている',
  no_earning_type: '稼ぎ方の無い案件。源泉に振り分けられず、会社への利益額にだけ入る',
  unexplained: '説明のつかない差（同じ記録を同じ規則で足しているので、出たら誤り）',
});

export const SOURCE_PROFIT_RULES = Object.freeze([
  '源泉は案件の稼ぎ方から導く（制作受託＝1・自社出資＝2・製作委員会＝3・買付＝4・販売委託＝5。J-2 (a)・J-3 (a)）。人件費を案件へ配らない',
  '実績の窓は 期間の始まり〜（期間の終わりと締めた月の早い方）。締めた月より後の記録は予測の側で、実績に入れない',
  '出資額（自社出資の稟議の払込・製作委員会への自社の払込）と買付の MG・買い切りの買付額は、計上・入金とも払った月に引く（J-11b (a)）。出資額は会社への利益額の払込の行からだけ数え、1回だけ引く',
  '源泉2 自社出資の粗利＝回収（入金×売上率。計上の基準は計上の売上×売上率）−出資額−ほかの確定の経費。締めた月より後の払込と承認したがまだ払っていない額は予測の側に出す',
  '源泉1 制作受託の売上と粗利の売上の側は受託費×入金した節目の割合の純額（J-14 (a)）。入金した節目は締めた月までの節目で、段階が契約済みの案件だけを数える。契約済みで契約の版の無い案件は受託費が分からないので売上に入れない（0円にしない）。制作の実費は粗利に入れない',
  '源泉3〜5 は読み取りが入るまで未接続（null）。0円で埋めない。5つの源泉の合計は全部が接続したときだけ出し、それまでは接続した源泉の和（connectedTotal）を別に出す',
  '未確定（U-5・U-4 の残り）と除外の費目は粗利に入れず、源泉ごとに別の行に出す',
  '会社への利益額（同じ窓・同じ基準）と源泉ごとに突き合わせ、差には理由を付ける',
]);

const FOUR = new Set(FOUR_ITEMS);
const INVESTMENT = new Set(INVESTMENT_ITEMS);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// readSourceProfitSources の返り値を、buildSourceProfit の入力にする
export function sourceProfitInputFromSources(read) {
  return {records: profitRecordsFromSources(read.profit), earningTypes: read.profit.earningTypes, contractWork: read.contractWork, approvals: read.approvals};
}

// 実績の窓（期間の始まり〜期間の終わりと締めた月の早い方）。期間の始まりが締めた月より後なら空（empty）
export function actualWindow({from = null, to = null, closedMonth = null}) {
  for (const [name, value] of [['from', from], ['to', to], ['closedMonth', closedMonth]]) {
    if (value !== null && !MONTH.test(value)) throw new Error(`${name} は YYYY-MM で渡します: ${value}`);
  }
  if (from !== null && to !== null && from > to) throw new Error(`期間の始まりが終わりより後です: ${from}〜${to}`);
  const windowTo = closedMonth === null ? to : to === null || to > closedMonth ? closedMonth : to;
  return {from, to: windowTo, clippedAtClosedMonth: closedMonth !== null && windowTo !== to, empty: from !== null && windowTo !== null && from > windowTo};
}

// 費目の行（profitItemRows）の確定の額を、売上・出資額・経費・4費目に分けて足す
function settledTotals(rows, label) {
  const settled = rows.filter((r) => r.status === 'settled');
  const pick = (f) => sumOf(settled.filter(f).map((r) => r.amount), label);
  return {
    salesYen: pick((r) => r.side === 'sales'),
    investmentYen: pick((r) => INVESTMENT.has(r.item)),
    expenseYen: pick((r) => r.side === 'cost' && !INVESTMENT.has(r.item)),
    fourItemsYen: pick((r) => FOUR.has(r.item)),
  };
}

// 未確定・除外の費目の行（費目ごとに足す。並びは利益額の費目の表の順）
function itemGroups(rows, status) {
  return PROFIT_ITEMS.filter((item) => item.status === status).flatMap((item) => {
    const own = rows.filter((r) => r.item === item.key);
    if (!own.length) return [];
    return [{key: item.key, label: item.label, side: item.side, status, statusLabel: STATUS_LABELS[status], reason: item.reason,
      amountKind: item.amountKind, amountKindLabel: AMOUNT_KINDS[item.amountKind], amountYen: sumOf(own.map((r) => r.amount), item.label),
      projectIds: [...new Set(own.map((r) => r.projectId))].sort((a, b) => a - b)}];
  });
}

const withProfit = (t) => {
  const costYen = sumOf([t.investmentYen, t.expenseYen], '経費と出資額');
  const profitYen = sumOf([t.salesYen, -costYen], '粗利');
  return {...t, costYen, profitYen, profitWithoutFourItemsYen: sumOf([profitYen, t.fourItemsYen], '4費目を引かない粗利')};
};
const AMOUNT_KEYS = ['salesYen', 'investmentYen', 'expenseYen', 'costYen', 'profitYen', 'fourItemsYen', 'profitWithoutFourItemsYen'];
const nullAmounts = () => Object.fromEntries(AMOUNT_KEYS.map((k) => [k, null]));

// 月ごとの額（axis の月に合わせ、記録の無い月は0）
function monthly(axis, entries) {
  const at = new Map(axis.map((m, i) => [m, i]));
  const buckets = {salesYen: axis.map(() => []), investmentYen: axis.map(() => []), expenseYen: axis.map(() => [])};
  for (const e of entries) buckets[e.kind][at.get(e.month)].push(e.amount);
  const out = Object.fromEntries(Object.entries(buckets).map(([k, list]) => [k, list.map((values) => sumOf(values, '月の額'))]));
  out.profitYen = axis.map((_, i) => sumOf([out.salesYen[i], -out.investmentYen[i], -out.expenseYen[i]], '月の粗利'));
  return out;
}

// 確定の費目の行を、月ごとの区分（売上・出資額・経費）の入れ物へ
const entriesOf = (rows) => rows.filter((r) => r.status === 'settled').map((r) => ({
  month: r.month, amount: r.amount, kind: r.side === 'sales' ? 'salesYen' : INVESTMENT.has(r.item) ? 'investmentYen' : 'expenseYen',
}));

// 案件別の行（確定の額。売上は源泉1なら受託費の純額）
function projectRows(projectIds, rows, info, {feeOf = null} = {}) {
  return [...projectIds].map((id) => {
    const own = rows.filter((r) => r.projectId === id);
    const t = settledTotals(feeOf ? own.filter((r) => r.side !== 'sales') : own, '案件の額');
    const salesYen = feeOf ? feeOf(id) : t.salesYen;
    const p = info.get(id) ?? {};
    const base = {projectId: id, code: p.code ?? null, title: p.title ?? null, hasWork: p.hasWork ?? null};
    if (salesYen === null) return {...base, salesYen: null, investmentYen: t.investmentYen, expenseYen: t.expenseYen, costYen: sumOf([t.investmentYen, t.expenseYen]), profitYen: null};
    const w = withProfit({...t, salesYen});
    return {...base, salesYen: w.salesYen, investmentYen: w.investmentYen, expenseYen: w.expenseYen, costYen: w.costYen, profitYen: w.profitYen};
  }).sort((a, b) => byCodePoint(String(a.code), String(b.code)) || a.projectId - b.projectId);
}

// 源泉2 自社出資の予測の側: 締めた月より後に払った日の払込（記録済み）と、承認したがまだ払っていない額（払う月が無い）
function ownInvestmentForecast(recovery) {
  const scheduled = [];
  const unscheduled = [];
  for (const row of recovery.rows) {
    for (const a of row.approvals) {
      for (const v of a.versions) if (v.status === 'paid' && v.side === 'open') scheduled.push({projectId: row.projectId, code: row.code, approvalNo: a.approvalNo, versionNo: v.versionNo, month: String(v.paidOn).slice(0, 7), amountYen: v.amountYen});
      if (a.remainingYen !== null && a.remainingYen > 0) unscheduled.push({projectId: row.projectId, code: row.code, approvalNo: a.approvalNo, remainingYen: a.remainingYen});
    }
  }
  scheduled.sort((x, y) => byCodePoint(x.month, y.month) || x.projectId - y.projectId || x.approvalNo - y.approvalNo || x.versionNo - y.versionNo);
  return {
    note: '締めた月より後の払込は払う月に予測の側で引き、承認したがまだ払っていない額は払う月の記録が無いので月を持たずに出す（実績の粗利からは引かない）',
    scheduled, scheduledYen: sumOf(scheduled.map((s) => s.amountYen), '予定の払込'),
    unscheduled, unscheduledYen: sumOf(unscheduled.map((s) => s.remainingYen), '承認済みで払っていない額'),
  };
}

// 源泉1の案件の段階の判定（契約済みだけを実績に数える）
const notCountedReason = (stageCode) => (stageCode === CONTRACTED_STAGE ? null : stageCode === 'declined' ? 'declined' : 'not_contracted');

// input は sourceProfitInputFromSources の形（試験は架空の記録から同じ形を作る）。
// options: basis（accrual|cash）、from・to（YYYY-MM か null）、closedMonth（締めた月。YYYY-MM か null）、includeCompany（会社全体を見てよいか）
export function buildSourceProfit(input, {basis, from = null, to = null, closedMonth = null, includeCompany = true} = {}) {
  const fields = basisFields(basis);
  const window = actualWindow({from, to, closedMonth});
  const {records} = input;
  const info = new Map(records.projects.map((p) => [p.id, p]));
  const sourceOfType = new Map((input.earningTypes ?? []).map((e) => [e.code, Number(e.profit_source)]));
  const sourceOf = (projectId) => {
    const type = info.get(projectId)?.earningType ?? null;
    return type === null ? null : sourceOfType.get(type) ?? null;
  };
  const labelOf = new Map((input.earningTypes ?? []).map((e) => [Number(e.profit_source), e.label]));
  // 会社への利益額（同じ窓・同じ基準）と、その費目の行。窓が空（期間の始まりが締めた月より後）なら実績の記録は無い
  const windowArgs = {from: window.from, to: window.to};
  const p1 = window.empty ? null : buildCompanyProfit(records, {basis, ...windowArgs, includeCompany});
  const items = window.empty ? [] : profitItemRows(records, {basis, ...windowArgs});
  const p1Projects = p1 ? p1.byProject : [];
  const rowsOf = (source) => items.filter((r) => sourceOf(r.projectId) === source);

  // ---------- 源泉1 制作受託 ----------
  // 契約の版のある受託制作の案件が無ければ未接続、締めた月が無ければ入金した節目を決められないので未確定（どちらも0円で埋めない）
  const versioned = input.contractWork.projects.some((p) => Number(p.profit_source) === CONTRACT_WORK_PROFIT_SOURCE && p.version_no !== null && p.version_no !== undefined);
  const cw = versioned && closedMonth !== null
    ? contractWorkSource({projects: input.contractWork.projects, milestones: input.contractWork.milestones}, {period: {from: from ?? '0000-01', to: to ?? '9999-12'}, closedMonth})
    : null;
  const stageOf = new Map(input.contractWork.projects.map((p) => [Number(p.project_id), p.stage_code ?? null]));
  const counted = cw?.rows ? cw.rows.filter((r) => notCountedReason(stageOf.get(r.projectId)) === null) : [];
  const notCounted = cw?.rows ? cw.rows.filter((r) => notCountedReason(stageOf.get(r.projectId)) !== null).map((r) => {
    const reason = notCountedReason(stageOf.get(r.projectId));
    return {projectId: r.projectId, code: r.code, title: r.title, stageCode: stageOf.get(r.projectId), reason, reasonLabel: NOT_COUNTED_REASONS[reason],
      receivedShareBps: r.receivedShareBps, feeReceivedPeriodYen: r.feeReceivedPeriodYen};
  }) : [];
  // 契約済みで契約の版の無い案件（受託費が分からない。売上を0円にしない）
  const unregisteredContracted = (cw?.unregistered ?? []).filter((r) => stageOf.get(r.projectId) === CONTRACTED_STAGE);
  const knownCounted = counted.filter((r) => r.feeReceivedPeriodYen !== null);
  const feeInWindow = (r) => r.milestones.filter((m) => m.received && (window.from === null || m.month >= window.from) && (window.to === null || m.month <= window.to));

  // ---------- 月の軸（接続した源泉の記録のある月） ----------
  const source1Known = cw !== null && !(counted.length && !knownCounted.length);
  const connectedSources = new Set([2, ...(source1Known ? [1] : [])]);
  const axis = [...new Set([
    ...items.filter((r) => connectedSources.has(sourceOf(r.projectId))).map((r) => r.month),
    ...knownCounted.flatMap((r) => feeInWindow(r).map((m) => m.month)),
  ])].sort();

  const sources = PROFIT_SOURCES.map((def) => {
    const base = {source: def.source, key: def.key, label: labelOf.get(def.source) ?? def.label};
    const mine = rowsOf(def.source);
    if (def.source === 2) {
      const t = withProfit(settledTotals(mine, '源泉2'));
      const ids = new Set(mine.map((r) => r.projectId));
      const cumulative = buildCompanyProfit(records, {basis: 'cash', to: closedMonth ?? to, includeCompany: false});
      const hasPeriod = !window.empty && (window.from !== null || window.to !== null);
      const periodView = hasPeriod ? buildCompanyProfit(records, {basis: 'cash', from: window.from, to: window.to, includeCompany: false}) : null;
      const recovery = ownInvestmentSource({projects: input.approvals.projects, versions: input.approvals.versions, cumulative, periodView},
        {closedMonth, period: hasPeriod ? {from: window.from, to: window.to} : null});
      const notes = [];
      if (records.ownInvestmentUnpaidProjects > 0) notes.push(`稟議の払込の記録が無い自社出資の案件 ${records.ownInvestmentUnpaidProjects}件は、出資額を引いていません（出資していれば粗利はその分だけ大きく出ます）`);
      if (closedMonth === null) notes.push('締めた月が無いので払込の判定をせず、期間の払込を全部実績に数えました');
      return {...base, status: 'connected', statusLabel: SOURCE_STATUS_LABELS.connected, reason: null, ...t,
        monthly: monthly(axis, entriesOf(mine)), projects: projectRows(ids, mine, info),
        unsettled: itemGroups(mine, 'unsettled'), excluded: itemGroups(mine, 'excluded'), notes,
        detail: {recovery, forecast: ownInvestmentForecast(recovery),
          paymentJudgement: closedMonth === null ? null : {closedMonth, rule: '払った月が締めた月まで（締めた月を含む）の払込は実績の側、あとは予測の側（own-investment-source-model の paymentSide）'}}};
    }
    if (def.source === 1) {
      const costRows = mine.filter((r) => r.side !== 'sales');
      const groups = {unsettled: itemGroups(costRows, 'unsettled'), excluded: itemGroups(costRows, 'excluded')};
      const detail = {receiptBasis: cw?.receiptBasis ?? null, receiptBasisLabel: RECEIPT_BASIS_LABEL, definitionVersion: cw?.definitionVersion ?? null,
        counted: counted.map((r) => ({projectId: r.projectId, code: r.code, title: r.title, versionNo: r.versionNo, feeYen: r.feeYen, complete: r.complete,
          receivedShareBps: r.receivedShareBps, feeReceivedTotalYen: r.feeReceivedTotalYen, feeReceivedPeriodYen: r.feeReceivedPeriodYen})),
        notCounted,
        scheduled: counted.flatMap((r) => r.milestones.filter((m) => !m.received).map((m) => ({projectId: r.projectId, code: r.code, seq: m.seq, month: m.month, feeYen: m.feeYen}))),
        unregistered: cw?.unregistered ?? [], unregisteredContractedCount: unregisteredContracted.length,
        excludedProjects: cw?.excluded ?? [], unknownCount: counted.filter((r) => !r.complete).length};
      if (!versioned) {
        return {...base, status: 'unconnected', statusLabel: SOURCE_STATUS_LABELS.unconnected, reason: '受託制作の契約の版がある案件が無い（行動指標の計画 段B #3。0円で埋めない）',
          ...nullAmounts(), monthly: null, projects: null, ...groups, notes: [], detail};
      }
      if (closedMonth === null) {
        return {...base, status: 'unknown', statusLabel: SOURCE_STATUS_LABELS.unknown, reason: '締めた月が無く、入金した節目（締めた月までの節目）を決められない', ...nullAmounts(),
          monthly: null, projects: null, ...groups, notes: [], detail};
      }
      if (!source1Known) {
        return {...base, status: 'unknown', statusLabel: SOURCE_STATUS_LABELS.unknown, reason: '契約済みの受託の契約の版の節目がそろわず、受託費の額が未確定', ...nullAmounts(),
          monthly: null, projects: null, ...groups, notes: [], detail};
      }
      const fees = knownCounted.flatMap((r) => feeInWindow(r).map((m) => ({projectId: r.projectId, month: m.month, amount: m.feeYen})));
      const t = withProfit({...settledTotals(costRows, '源泉1'), salesYen: sumOf(fees.map((f) => f.amount), '受託費の純額')});
      const feeByProject = new Map();
      for (const f of fees) feeByProject.set(f.projectId, sumOf([feeByProject.get(f.projectId) ?? 0, f.amount]));
      const countedIds = new Set(counted.map((r) => r.projectId));
      const unknownIds = new Set([...counted.filter((r) => !r.complete), ...unregisteredContracted].map((r) => r.projectId));
      const ids = new Set([...mine.filter((r) => r.side !== 'sales').map((r) => r.projectId), ...counted.map((r) => r.projectId), ...unknownIds]);
      const notes = [`売上は${RECEIPT_BASIS_LABEL}`];
      if (detail.unknownCount) notes.push(`契約の版の節目がそろわない案件 ${detail.unknownCount}件は、受託費の額が未確定で売上に入れていません`);
      if (unregisteredContracted.length) notes.push(`契約済みで契約の版が無い案件 ${unregisteredContracted.length}件は、受託費が分からないので売上に入れていません`);
      if (notCounted.length) notes.push(`契約済みでない案件 ${notCounted.length}件（見送り ${notCounted.filter((r) => r.reason === 'declined').length}件）の節目は、実績に数えていません`);
      return {...base, status: 'connected', statusLabel: SOURCE_STATUS_LABELS.connected, reason: null, ...t,
        monthly: monthly(axis, [...entriesOf(costRows), ...fees.map((f) => ({month: f.month, amount: f.amount, kind: 'salesYen'}))]),
        projects: projectRows(ids, mine, info, {feeOf: (id) => (unknownIds.has(id) ? null : countedIds.has(id) ? feeByProject.get(id) ?? 0 : 0)}),
        ...groups, notes, detail};
    }
    return {...base, status: 'unconnected', statusLabel: SOURCE_STATUS_LABELS.unconnected, reason: def.unconnected, ...nullAmounts(),
      monthly: null, projects: null, unsettled: [], excluded: [], notes: [], detail: null};
  });

  // ---------- 合計（全部が接続したときだけ）と、接続した源泉の和 ----------
  const connected = sources.filter((s) => s.status === 'connected');
  const sumKey = (list, key) => sumOf(list.map((s) => s[key]), key);
  const complete = connected.length === sources.length;
  const total = {complete, ...(complete ? Object.fromEntries(AMOUNT_KEYS.map((k) => [k, sumKey(sources, k)])) : nullAmounts())};
  const connectedTotal = {sources: connected.map((s) => s.key), ...Object.fromEntries(AMOUNT_KEYS.map((k) => [k, sumKey(connected, k)]))};

  // ---------- 会社への利益額との突き合わせ ----------
  const p1Of = (match) => {
    const own = p1Projects.filter((p) => match(sourceOf(p.projectId)));
    return {p1SalesYen: sumOf(own.map((p) => p.salesYen)), p1CostYen: sumOf(own.map((p) => p.costYen)), p1ProfitYen: sumOf(own.map((p) => p.profitYen)), projectCount: own.length};
  };
  const rows = sources.map((s) => {
    const p = p1Of((x) => x === s.source);
    const profitYen = s.status === 'connected' ? s.profitYen : null;
    const diffYen = sumOf([profitYen ?? 0, -p.p1ProfitYen], '差');
    let reason = null;
    if (s.status === 'unconnected') reason = 'unconnected';
    else if (s.status === 'unknown') reason = 'unknown';
    else if (diffYen !== 0) reason = s.source === 1 ? 'milestone_basis' : 'unexplained';
    return {source: s.source, key: s.key, label: s.label, status: s.status, profitYen, ...p, diffYen, reason, reasonLabel: reason ? RECONCILE_REASONS[reason] : null};
  });
  const none = p1Of((x) => x === null || !PROFIT_SOURCES.some((d) => d.source === x));
  if (none.projectCount) {
    rows.push({source: null, key: 'none', label: '稼ぎ方の無い案件', status: null, profitYen: null, ...none, diffYen: -none.p1ProfitYen,
      reason: 'no_earning_type', reasonLabel: RECONCILE_REASONS.no_earning_type});
  }
  const p1ProfitYen = p1 ? p1.settled.totals.profitYen : 0;
  const reconciliation = {
    note: '会社への利益額（同じ実績の窓・同じ基準の確定の額）と源泉ごとに突き合わせる。差のある行には理由を付ける',
    rows,
    total: {sourceProfitYen: connectedTotal.profitYen, p1ProfitYen, diffYen: sumOf([connectedTotal.profitYen, -p1ProfitYen], '差')},
    p1Notes: p1 ? p1.notes : [],
  };
  if (sumOf(rows.map((r) => r.diffYen)) !== reconciliation.total.diffYen || sumOf(rows.map((r) => r.p1ProfitYen)) !== p1ProfitYen) {
    throw new Error('突き合わせの行の和が会社への利益額の合計と合いません');
  }

  const notes = [];
  if (window.clippedAtClosedMonth) notes.push(`実績は締めた月（${closedMonth}）までです。それより後の月の記録は予測の側で、ここには入れていません`);
  if (window.empty) notes.push(`期間の始まりが締めた月（${closedMonth}）より後なので、実績はありません`);
  if (!complete) notes.push(`5つの源泉の合計は、未接続・未確定の源泉（${sources.filter((s) => s.status !== 'connected').map((s) => s.label).join('・')}）があるので出していません（接続した源泉の和は connectedTotal）`);

  return {
    definitionVersion: SOURCE_PROFIT_VERSION,
    ...fields,
    taxLabel: TAX_LABEL,
    formula: SOURCE_PROFIT_FORMULA,
    rules: [...SOURCE_PROFIT_RULES],
    conditions: {from, to},
    closedMonth,
    window: {from: window.from, to: window.to, clippedAtClosedMonth: window.clippedAtClosedMonth, empty: window.empty},
    months: axis,
    sources,
    total,
    connectedTotal,
    reconciliation,
    unattributedYen: includeCompany ? (p1 ? p1.unknownProject.total : 0) : null,
    notes,
  };
}
