// 製作委員会の月次収支（作品別）の集計。DB に依存しない純関数で、サーバーの帳票 API・画面・試験が使う。
// 設計: docs/platform/team-development/royalty-committee-design.md §4（計算順は代表が選んだ「正しい順」）。
//
// 計算順: 売上 → PF控除 → 窓口手数料・幹事手数料（fee_order のとおり。committee-income.mjs）→ 本委員会収入 → 経費
//   → 権利処理費（ロイヤリティの発生額。監督料・脚本料・音楽著作権料・原作料・クリエーター報酬・その他）→ 分配原資 → 出資比率で分配。
// 赤字の月: 分配原資の累計が負のあいだは分配しない。累計の分配可能額 = max(0, 分配原資の累計)、月の分配額 = その増分
//   （累計が正のまま減る月は、増分が負＝前の分配を戻す額になる）。未分配（赤字の繰越）= 分配原資の累計 − 累計の分配可能額（0以下）。
//   これは帳票上の扱いで、保存済みの期間報告（スナップショット）の計算は変えない。
// 配分: 出資者への分配は月ごとに持分（share_bps）で最大剰余法（端数は余りの大きい順、同じなら参加者の並び順）。
//   窓口手数料は窓口×月ごとに取り分（committee_term_window_fee_shares。無ければ窓口の受取先1社が100%）で同じく最大剰余法。
//   幹事手数料は幹事1社。取得額 = 分配額 + 窓口手数料の取り分 + 幹事手数料。
// 条件版: 月ごとに、その計上月に効いている条件版（適用開始月がその月以前の版のうち版番号が最大のもの）の持分・窓口・取り分・幹事を使う。
//   出資額は最新の版の登録を使う。
// 回収率 = 累計取得額 ÷ 出資額、利益 = 累計取得額 − 出資額（出資額の登録が無ければ「未確認」。0円にしない）。
// 保留（HOLD）: 窓口の条件が無い区分の売上は収入にせず「保留の売上」として別の行に残す。算定できない権利処理費は
//   対象売上を「権利処理費の保留」の行に残す（その月の分配原資は保留分を差し引く前の額）。どちらも0円として扱わない。
//   一部だけ算定できた権利処理費（区分未確認の売上がある月など）は、算定できた額を権利処理費に含め、残りの対象売上を保留に示す。
import {CHANNEL_GROUPS, CHANNEL_LABELS} from '../sales/channel-group.mjs';
import {splitByAllocation} from '../money-allocation.mjs';
import {fiscalYearOf, monthsBetween, isYm, normalizeStartMonth} from '../ui/condition-model.mjs';

export const MONTHLY_CALCULATION_VERSION = 'committee-monthly-v1';
export const MAX_PERIOD_MONTHS = 120;
export const MAX_HISTORY_MONTHS = 600;
export const ROYALTY_CATEGORIES = Object.freeze(['director', 'screenplay', 'music', 'original', 'creator', 'other']);
export const ROYALTY_CATEGORY_LABELS = Object.freeze({
  director: '監督料', screenplay: '脚本料', music: '音楽著作権料', original: '原作料', creator: 'クリエーター報酬', other: 'その他の権利処理費',
});
export const WINDOW_KIND_LABELS = Object.freeze({theatrical: '劇場（配給）', digital: '配信', package: 'ビデオグラム', broadcast: '放送', other: 'その他・海外'});
export const SECTION_LABELS = Object.freeze({sales: '売上', fees: '手数料', income: '本委員会収入', expense: '経費', royalty: '権利処理費', pool: '分配', investor: '出資者'});

export const royaltyCategoryLabel = (code) => ROYALTY_CATEGORY_LABELS[code] || `その他の権利処理費（${code || '種別未確認'}）`;
export const channelLabel = (group) => CHANNEL_LABELS[group] || 'その他';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MIN = BigInt(Number.MIN_SAFE_INTEGER);
function toSafe(big, label = '金額') {
  if (big > MAX || big < MIN) throw new Error(`${label}が安全な整数範囲を超えています`);
  return Number(big);
}
function sumOf(values, label = '金額の合計') {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!Number.isSafeInteger(value)) throw new Error(`${label}に安全な整数でない値があります`);
    total += BigInt(value);
  }
  return toSafe(total, label);
}

// 計上月に効いている条件版。versions: [{versionNo, effectiveFrom(YYYY-MM か null＝最初の月から)}]。
// 適用開始月がその月以前の版のうち版番号が最大のもの。どれも当たらない月（適用開始月より前）は最初の版（版1は常に最初の月から）。
export function termVersionAt(versions, month) {
  let chosen = null;
  let first = null;
  for (const version of versions || []) {
    if (!first || version.versionNo < first.versionNo) first = version;
    if ((version.effectiveFrom || '') <= month && (!chosen || version.versionNo > chosen.versionNo)) chosen = version;
  }
  return chosen || first;
}

export function monthLabel(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  return match ? `${match[1]}年${Number(match[2])}月` : String(month ?? '');
}

// 最大剰余法の配分。parts: [{key, bps}]（合計10000bp）。端数は余りの大きい順、同じなら parts の並び順。符号は額のまま。
export function splitLargestRemainder(amount, parts) {
  if (!parts.length) throw new Error('配分先がありません');
  const shares = parts.map((part, index) => ({work_id: index + 1, allocation_bps: part.bps}));
  const result = splitByAllocation(amount, shares);
  return new Map(parts.map((part, index) => [part.key, result.get(index + 1)]));
}

class Series {
  constructor(length) { this.values = Array.from({length}, () => 0n); }
  add(index, value, label) {
    if (!Number.isSafeInteger(value)) throw new Error(`${label || '金額'}に安全な整数でない値があります`);
    this.values[index] += BigInt(value);
  }
  numbers(label) { return this.values.map((value) => toSafe(value, label)); }
}

const byGroupOrder = (a, b) => {
  const ia = CHANNEL_GROUPS.indexOf(a), ib = CHANNEL_GROUPS.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || String(a).localeCompare(String(b));
};
const byRoyaltyOrder = (a, b) => {
  const ia = ROYALTY_CATEGORIES.indexOf(a), ib = ROYALTY_CATEGORIES.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || String(a).localeCompare(String(b));
};

// 列: 月（年度ごとに並べ、年度が2つ以上あるときは年度の最後の月の後に年度計）・期間計・期間前の累計（期間前にデータがあるとき）・累計
export function buildColumns({periodMonths, historyMonths, periodStart, fiscalStartMonth}) {
  const start = normalizeStartMonth(fiscalStartMonth);
  const groups = [];
  periodMonths.forEach((month, offset) => {
    const fy = fiscalYearOf(month, start);
    if (!groups.length || groups.at(-1).fiscalYear !== fy) groups.push({fiscalYear: fy, indices: []});
    groups.at(-1).indices.push(periodStart + offset);
  });
  const columns = [];
  for (const group of groups) {
    for (const index of group.indices) columns.push({key: `m:${historyMonths[index]}`, kind: 'month', month: historyMonths[index], label: monthLabel(historyMonths[index]), indices: [index]});
    if (groups.length > 1) {
      const partial = group.indices.length < 12;
      columns.push({key: `fy:${group.fiscalYear}`, kind: 'fy', fiscalYear: group.fiscalYear, label: `${group.fiscalYear}年度計${partial ? '（期間内）' : ''}`,
        partial, indices: group.indices});
    }
  }
  const periodIndices = periodMonths.map((_, offset) => periodStart + offset);
  columns.push({key: 'period', kind: 'period', label: '期間計', indices: periodIndices});
  if (periodStart > 0) columns.push({key: 'prior', kind: 'prior', label: '期間前の累計', indices: Array.from({length: periodStart}, (_, i) => i)});
  columns.push({key: 'cumulative', kind: 'cumulative', label: '累計', indices: historyMonths.map((_, i) => i)});
  return columns;
}

function validMonthRange(from, to) {
  if (!isYm(from) || !isYm(to)) throw new Error('期間（from・to）を「2026-05」の形で指定してください');
  if (from > to) throw new Error('期間の開始月が終了月より後になっています');
  const months = monthsBetween(from, to);
  if (months.length > MAX_PERIOD_MONTHS) throw new Error(`期間は${MAX_PERIOD_MONTHS}か月以内にしてください`);
  return months;
}

export function buildCommitteeMonthly({
  from, to, fiscalStartMonth = 5,
  incomeRows = [], expenses = [], accruals = [], lines = null, expenseLines = null,
  members = [], windows = [], feeShares = [], managerPartnerId = null, investments = null, versions = null,
} = {}) {
  const periodMonths = validMonthRange(from, to);
  const dataMonths = [
    ...incomeRows.map((row) => row.month), ...expenses.map((row) => row.month), ...accruals.map((row) => row.accrualMonth),
  ].filter((month) => isYm(month) && month <= to);
  const first = dataMonths.reduce((min, month) => (month < min ? month : min), from);
  const historyMonths = monthsBetween(first, to);
  if (historyMonths.length > MAX_HISTORY_MONTHS) throw new Error(`累計の対象が${MAX_HISTORY_MONTHS}か月を超えています`);
  const index = new Map(historyMonths.map((month, i) => [month, i]));
  const periodStart = index.get(from);
  const n = historyMonths.length;
  const series = () => new Series(n);

  // ---- 売上・手数料・収入（committee-income の行） ----
  const salesBy = new Map();
  const sales = series(), holdSales = series(), netReported = series(), platformFee = series(), windowFee = series(), managerFee = series(), income = series();
  const windowFeeBy = new Map();
  const holdByGroup = new Map();
  for (const row of incomeRows) {
    const i = index.get(row.month);
    if (i === undefined) continue;
    if (!salesBy.has(row.channelGroup)) salesBy.set(row.channelGroup, series());
    salesBy.get(row.channelGroup).add(i, row.sales, '売上');
    sales.add(i, row.sales, '売上');
    if (row.hold) {
      holdSales.add(i, row.sales, '保留の売上');
      if (!holdByGroup.has(row.channelGroup)) holdByGroup.set(row.channelGroup, {channelGroup: row.channelGroup, label: channelLabel(row.channelGroup), windowKind: row.windowKind, reason: row.hold, months: new Set(), rows: []});
      holdByGroup.get(row.channelGroup).months.add(row.month);
      holdByGroup.get(row.channelGroup).rows.push(row);
      continue;
    }
    netReported.add(i, row.netReportedSales || 0, '控除後の売上');
    platformFee.add(i, row.platformFee, 'PF控除');
    windowFee.add(i, row.windowFee, '窓口手数料');
    managerFee.add(i, row.managerFee, '幹事手数料');
    income.add(i, row.income, '本委員会収入');
    if (!windowFeeBy.has(row.windowId)) windowFeeBy.set(row.windowId, series());
    windowFeeBy.get(row.windowId).add(i, row.windowFee, '窓口手数料');
  }

  // ---- 経費 ----
  const expense = series();
  const expenseBy = new Map();
  for (const row of expenses) {
    const i = index.get(row.month);
    if (i === undefined) continue;
    const category = row.category || '費目未確認';
    if (!expenseBy.has(category)) expenseBy.set(category, series());
    expenseBy.get(category).add(i, row.amount, '経費');
    expense.add(i, row.amount, '経費');
  }

  // ---- 権利処理費（ロイヤリティの発生額） ----
  const royalty = series(), royaltyHold = series();
  const royaltyBy = new Map();
  const royaltyHoldRows = [];
  const royaltyHoldMonths = new Set();
  for (const row of accruals) {
    const i = index.get(row.accrualMonth);
    if (i === undefined) continue;
    const category = row.category || 'other';
    if (!royaltyBy.has(category)) royaltyBy.set(category, series());
    const known = Number.isSafeInteger(row.royaltyYen);
    if (known) {
      royaltyBy.get(category).add(i, row.royaltyYen, '権利処理費');
      royalty.add(i, row.royaltyYen, '権利処理費');
    }
    const heldSales = Number.isSafeInteger(row.holdSalesYen) ? row.holdSalesYen : 0;
    if (heldSales !== 0 || !known) {
      royaltyHold.add(i, heldSales, '権利処理費の保留');
      royaltyHoldMonths.add(row.accrualMonth);
      royaltyHoldRows.push({...row, categoryLabel: royaltyCategoryLabel(category), inPeriod: row.accrualMonth >= from, royaltyKnown: known});
    }
  }

  const S = {
    sales: sales.numbers('売上'), holdSales: holdSales.numbers('保留の売上'), netReported: netReported.numbers('控除後の売上'),
    platformFee: platformFee.numbers('PF控除'), windowFee: windowFee.numbers('窓口手数料'), managerFee: managerFee.numbers('幹事手数料'),
    income: income.numbers('本委員会収入'), expense: expense.numbers('経費'), royalty: royalty.numbers('権利処理費'), royaltyHold: royaltyHold.numbers('権利処理費の保留'),
  };
  const salesGroups = [...salesBy.keys()].sort(byGroupOrder);
  const salesByNum = new Map(salesGroups.map((group) => [group, salesBy.get(group).numbers('売上')]));
  const expenseCategories = [...expenseBy.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
  const expenseByNum = new Map(expenseCategories.map((category) => [category, expenseBy.get(category).numbers('経費')]));
  const royaltyCategories = [...royaltyBy.keys()].sort(byRoyaltyOrder);
  const royaltyByNum = new Map(royaltyCategories.map((category) => [category, royaltyBy.get(category).numbers('権利処理費')]));

  // ---- 分配原資・赤字の繰越・分配額 ----
  const pool = S.income.map((value, i) => toSafe(BigInt(value) - BigInt(S.expense[i]) - BigInt(S.royalty[i]), '分配原資'));
  const cumPool = [], distributable = [], distribution = [], undistributed = [];
  let running = 0n, previous = 0n;
  pool.forEach((value, i) => {
    running += BigInt(value);
    const can = running > 0n ? running : 0n;
    cumPool[i] = toSafe(running, '分配原資の累計');
    distributable[i] = toSafe(can, '累計の分配可能額');
    distribution[i] = toSafe(can - previous, '分配額');
    undistributed[i] = toSafe(running - can, '未分配');
    previous = can;
  });

  // ---- 条件版（計上月ごとに効く版）。versions が無ければ members・windows・feeShares・managerPartnerId を1つの版として扱う ----
  const termVersions = (Array.isArray(versions) && versions.length ? versions : [{id: null, versionNo: 1, effectiveFrom: null, members, windows, feeShares, managerPartnerId}])
    .map((version) => ({...version, effectiveFrom: version.effectiveFrom || null, managerPartnerId: version.managerPartnerId ?? null,
      members: version.members || [], windows: version.windows || [], feeShares: version.feeShares || []}))
    .sort((a, b) => a.versionNo - b.versionNo);
  const versionAt = historyMonths.map((month) => termVersionAt(termVersions, month));
  const versionName = (version) => (termVersions.length > 1 ? `（条件版${version.versionNo}）` : '');

  // ---- 出資者・窓口手数料の取り分・幹事手数料 ----
  const partners = new Map();
  const ensurePartner = (partnerId, name, extra = {}) => {
    if (!partners.has(partnerId)) partners.set(partnerId, {partnerId, name: name || `取引先${partnerId}`, shareBps: 0, memberOrder: null, member: false, ...extra});
    return partners.get(partnerId);
  };
  const memberPartsOf = new Map();
  for (const version of termVersions) {
    const orderedMembers = [...version.members].sort((a, b) => (a.memberOrder ?? 0) - (b.memberOrder ?? 0) || a.partnerId - b.partnerId);
    const shareTotal = orderedMembers.reduce((total, member) => total + Number(member.shareBps || 0), 0);
    if (!orderedMembers.length) throw new Error(`委員会の参加者が登録されていません${versionName(version)}`);
    if (shareTotal !== 10000) throw new Error(`委員会の参加者の持分の合計が100%ではありません${versionName(version)}`);
    // 表示の持分・並び順は版番号の大きい版（最新）で上書きする
    for (const member of orderedMembers) {
      Object.assign(ensurePartner(member.partnerId, member.name), {name: member.name || `取引先${member.partnerId}`, shareBps: member.shareBps,
        memberOrder: member.memberOrder, member: true, role: member.role || null});
    }
    memberPartsOf.set(version, orderedMembers.map((member) => ({key: member.partnerId, bps: member.shareBps})));
  }

  const invalidFeeShares = [];
  const feePartsByWindow = new Map();
  const allWindows = [];
  for (const version of termVersions) {
    for (const window of version.windows) {
      allWindows.push({window, version});
      const rows = version.feeShares.filter((share) => share.windowId === window.id);
      if (!rows.length) {
        feePartsByWindow.set(window.id, {parts: [{key: window.windowPartnerId, bps: 10000}], registered: false});
        ensurePartner(window.windowPartnerId, window.windowPartnerName);
        continue;
      }
      const total = rows.reduce((sum, row) => sum + Number(row.shareBps || 0), 0);
      if (total !== 10000) {
        invalidFeeShares.push({windowId: window.id, label: window.label, totalBps: total, versionNo: version.versionNo});
        feePartsByWindow.set(window.id, {parts: null, registered: true});
        continue;
      }
      const ordered = [...rows].sort((a, b) => (partners.get(a.partnerId)?.memberOrder ?? 999) - (partners.get(b.partnerId)?.memberOrder ?? 999) || a.partnerId - b.partnerId);
      for (const row of ordered) ensurePartner(row.partnerId, row.name);
      feePartsByWindow.set(window.id, {parts: ordered.map((row) => ({key: row.partnerId, bps: row.shareBps})), registered: true});
    }
  }
  // 前の版（コピー元、無ければ1つ前の版）の同じ種類の窓口で複数社に分けていた取り分が、この版では未登録（受取先が100%）に戻っている窓口
  const splitParts = (parts) => Array.isArray(parts) && !(parts.length === 1 && parts[0].bps === 10000);
  const droppedFeeShares = new Map();
  termVersions.forEach((version, index) => {
    if (!index) return;
    const source = termVersions.find((item) => item.id != null && item.id === version.sourceVersionId) || termVersions[index - 1];
    for (const window of version.windows) {
      if (feePartsByWindow.get(window.id)?.registered) continue;
      const before = source.windows.find((item) => item.kind === window.kind);
      const config = before ? feePartsByWindow.get(before.id) : null;
      if (config?.registered && splitParts(config.parts)) droppedFeeShares.set(window.id, {fromVersionNo: source.versionNo});
    }
  });
  for (const version of termVersions) if (version.managerPartnerId != null) ensurePartner(version.managerPartnerId, null);
  const managerMissing = S.managerFee.some((value, i) => value !== 0 && versionAt[i].managerPartnerId == null);

  const partnerIds = [...partners.keys()];
  const zeroSeries = () => Array.from({length: n}, () => 0n);
  const memberDist = new Map(partnerIds.map((id) => [id, zeroSeries()]));
  const feeShare = new Map(partnerIds.map((id) => [id, zeroSeries()]));
  const managerShare = new Map(partnerIds.map((id) => [id, zeroSeries()]));
  const unassignedWindowFee = zeroSeries();
  for (let i = 0; i < n; i += 1) {
    const version = versionAt[i];
    for (const [partnerId, amount] of splitLargestRemainder(distribution[i], memberPartsOf.get(version))) memberDist.get(partnerId)[i] += BigInt(amount);
    for (const [windowId, feeSeries] of windowFeeBy) {
      const fee = feeSeries.values[i];
      if (fee === 0n) continue;
      const config = feePartsByWindow.get(windowId);
      if (!config?.parts) { unassignedWindowFee[i] += fee; continue; }
      for (const [partnerId, amount] of splitLargestRemainder(toSafe(fee, '窓口手数料'), config.parts)) feeShare.get(partnerId)[i] += BigInt(amount);
    }
    if (version.managerPartnerId != null) managerShare.get(version.managerPartnerId)[i] += BigInt(S.managerFee[i]);
  }
  const investmentOf = new Map((investments || []).map((row) => [row.partnerId, row.amountYen]));
  const investorSeries = partnerIds.map((partnerId) => {
    const dist = memberDist.get(partnerId).map((v) => toSafe(v, '分配額'));
    const wfee = feeShare.get(partnerId).map((v) => toSafe(v, '窓口手数料の取り分'));
    const mfee = managerShare.get(partnerId).map((v) => toSafe(v, '幹事手数料'));
    const acq = dist.map((value, i) => toSafe(BigInt(value) + BigInt(wfee[i]) + BigInt(mfee[i]), '取得額'));
    let cum = 0n;
    const cumAcq = acq.map((value) => { cum += BigInt(value); return toSafe(cum, '累計取得額'); });
    const investment = investments == null ? null : (investmentOf.has(partnerId) ? investmentOf.get(partnerId) : null);
    const info = partners.get(partnerId);
    const windowKinds = [...new Set(allWindows.filter(({window}) => (feePartsByWindow.get(window.id)?.parts || []).some((part) => part.key === partnerId)).map(({window}) => window.kind))];
    return {partnerId, info, dist, wfee, mfee, acq, cumAcq, investment, isManager: termVersions.some((version) => version.managerPartnerId === partnerId), windowKinds};
  });

  // ---- 列と行 ----
  const columns = buildColumns({periodMonths, historyMonths, periodStart, fiscalStartMonth});
  const flow = (values) => Object.fromEntries(columns.map((column) => [column.key, sumOf(column.indices.map((i) => values[i]))]));
  const stock = (values) => Object.fromEntries(columns.map((column) => [column.key, column.indices.length ? values[column.indices.at(-1)] : 0]));
  const constant = (value) => Object.fromEntries(columns.map((column) => [column.key, value]));
  const ratio = (cumValues, investment) => Object.fromEntries(columns.map((column) => {
    if (investment == null || investment <= 0) return [column.key, null];
    return [column.key, (column.indices.length ? cumValues[column.indices.at(-1)] : 0) / investment];
  }));
  const anyNonZero = (values) => values.some((value) => value !== 0);
  const rows = [];
  const push = (row) => rows.push({level: 0, emphasis: false, unit: 'yen', ...row});

  for (const group of salesGroups) {
    push({key: `sales:${group}`, section: 'sales', label: `売上｜${channelLabel(group)}`, kind: 'flow', level: 1, channelGroup: group, values: flow(salesByNum.get(group))});
  }
  push({key: 'sales', section: 'sales', label: '売上（合計）', kind: 'flow', emphasis: true, values: flow(S.sales)});
  if (anyNonZero(S.netReported)) push({key: 'netReported', section: 'sales', label: 'うち控除後で報告された売上（PF控除は報告元で差し引き済み・額は未確認）', kind: 'flow', level: 1, informational: true, values: flow(S.netReported)});
  if (anyNonZero(S.holdSales) || holdByGroup.size) push({key: 'holdSales', section: 'sales', label: 'うち保留の売上（窓口の条件が無い区分。収入にしていません）', kind: 'flow', level: 1, hold: true, values: flow(S.holdSales)});
  push({key: 'platformFee', section: 'fees', label: 'PF控除', kind: 'flow', values: flow(S.platformFee)});
  push({key: 'windowFee', section: 'fees', label: '窓口手数料', kind: 'flow', values: flow(S.windowFee)});
  push({key: 'managerFee', section: 'fees', label: '幹事手数料', kind: 'flow', values: flow(S.managerFee)});
  push({key: 'income', section: 'income', label: '本委員会収入', kind: 'flow', emphasis: true, values: flow(S.income)});
  for (const category of expenseCategories) {
    push({key: `expense:${category}`, section: 'expense', label: `経費｜${category}`, kind: 'flow', level: 1, values: flow(expenseByNum.get(category))});
  }
  push({key: 'expense', section: 'expense', label: '経費（合計）', kind: 'flow', emphasis: expenseCategories.length > 1, values: flow(S.expense)});
  for (const category of royaltyCategories) {
    push({key: `royalty:${category}`, section: 'royalty', label: `権利処理費｜${royaltyCategoryLabel(category)}`, kind: 'flow', level: 1, category, values: flow(royaltyByNum.get(category))});
  }
  push({key: 'royalty', section: 'royalty', label: '権利処理費（合計）', kind: 'flow', emphasis: royaltyCategories.length > 1, values: flow(S.royalty)});
  if (royaltyHoldRows.length) push({key: 'royaltyHold', section: 'royalty', label: '権利処理費の保留（算定できない部分の対象売上。この部分の権利処理費は含めていません）', kind: 'flow', level: 1, hold: true, values: flow(S.royaltyHold)});
  push({key: 'pool', section: 'pool', label: '分配原資', kind: 'flow', emphasis: true, values: flow(pool)});
  push({key: 'cumPool', section: 'pool', label: '分配原資の累計', kind: 'stock', values: stock(cumPool)});
  push({key: 'distributable', section: 'pool', label: '累計の分配可能額（累計が正の分）', kind: 'stock', values: stock(distributable)});
  push({key: 'undistributed', section: 'pool', label: '未分配（赤字の繰越）', kind: 'stock', values: stock(undistributed)});
  push({key: 'distribution', section: 'pool', label: '分配額（出資者へ）', kind: 'flow', emphasis: true, values: flow(distribution)});
  for (const item of investorSeries) {
    const name = item.info.name;
    const share = item.info.member ? `持分${(item.info.shareBps / 100).toLocaleString('ja-JP', {maximumFractionDigits: 2})}%` : '参加者以外';
    const base = {section: 'investor', partnerId: item.partnerId, partnerName: name};
    push({...base, key: `dist:${item.partnerId}`, label: `${name}｜分配額（${share}）`, kind: 'flow', level: 1, values: flow(item.dist)});
    if (item.windowKinds.length || anyNonZero(item.wfee)) push({...base, key: `wfee:${item.partnerId}`, label: `${name}｜窓口手数料の取り分`, kind: 'flow', level: 1, values: flow(item.wfee)});
    if (item.isManager || anyNonZero(item.mfee)) push({...base, key: `mfee:${item.partnerId}`, label: `${name}｜幹事手数料`, kind: 'flow', level: 1, values: flow(item.mfee)});
    push({...base, key: `acq:${item.partnerId}`, label: `${name}｜取得額`, kind: 'flow', emphasis: true, values: flow(item.acq)});
    push({...base, key: `cumAcq:${item.partnerId}`, label: `${name}｜累計取得額`, kind: 'stock', level: 1, values: stock(item.cumAcq)});
    push({...base, key: `inv:${item.partnerId}`, label: `${name}｜出資額`, kind: 'constant', level: 1, values: constant(item.investment)});
    push({...base, key: `rate:${item.partnerId}`, label: `${name}｜回収率（累計取得額÷出資額）`, kind: 'rate', unit: 'rate', level: 1,
      investmentKnown: item.investment != null, values: ratio(item.cumAcq, item.investment)});
    push({...base, key: `profit:${item.partnerId}`, label: `${name}｜利益（累計取得額−出資額）`, kind: 'stock', level: 1,
      values: item.investment == null ? constant(null) : stock(item.cumAcq.map((value) => value - item.investment))});
  }

  // ---- 出資者別 ----
  const periodCol = columns.find((column) => column.key === 'period');
  const priorCol = columns.find((column) => column.key === 'prior');
  const cumulativeCol = columns.find((column) => column.key === 'cumulative');
  const sumIn = (values, column) => (column ? sumOf(column.indices.map((i) => values[i])) : 0);
  const investors = investorSeries.map((item) => {
    const cumulativeAcquisition = item.cumAcq.at(-1) ?? 0;
    return {
      partnerId: item.partnerId, name: item.info.name, member: item.info.member, shareBps: item.info.shareBps, memberOrder: item.info.memberOrder,
      isManager: item.isManager, windowKinds: item.windowKinds, investmentYen: item.investment,
      period: {distribution: sumIn(item.dist, periodCol), windowFee: sumIn(item.wfee, periodCol), managerFee: sumIn(item.mfee, periodCol), acquisition: sumIn(item.acq, periodCol)},
      priorAcquisition: sumIn(item.acq, priorCol),
      cumulative: {distribution: sumIn(item.dist, cumulativeCol), windowFee: sumIn(item.wfee, cumulativeCol), managerFee: sumIn(item.mfee, cumulativeCol), acquisition: cumulativeAcquisition},
      recoveryRate: item.investment != null && item.investment > 0 ? cumulativeAcquisition / item.investment : null,
      profit: item.investment == null ? null : cumulativeAcquisition - item.investment,
    };
  });

  // ---- 照合 ----
  const checks = [];
  const monthCheck = (item, diffOf) => {
    const failures = historyMonths.map((month, i) => ({month, diff: diffOf(i)})).filter((row) => row.diff !== 0);
    checks.push({item, value: failures.length ? failures[0].diff : 0, failures: failures.length,
      detail: failures.length ? `${monthLabel(failures[0].month)}ほか${failures.length}か月で差があります` : `全${historyMonths.length}か月で一致`});
  };
  const valueCheck = (item, diff, detail) => checks.push({item, value: diff, failures: diff === 0 ? 0 : 1, detail: diff === 0 ? (detail || '一致') : `差 ${diff}`});
  const bigDiff = (a, parts) => toSafe(BigInt(a) - parts.reduce((total, value) => total + BigInt(value), 0n), '照合の差');
  monthCheck('売上 = PF控除 + 窓口手数料 + 幹事手数料 + 経費 + 権利処理費 + 分配原資 + 保留の売上（月ごと）',
    (i) => bigDiff(S.sales[i], [S.platformFee[i], S.windowFee[i], S.managerFee[i], S.expense[i], S.royalty[i], pool[i], S.holdSales[i]]));
  let paid = 0n;
  const cumDistributed = distribution.map((value) => { paid += BigInt(value); return toSafe(paid, '分配済みの累計'); });
  monthCheck('分配原資の累計 = 分配済みの累計 + 未分配（赤字の繰越）（月ごと）', (i) => bigDiff(cumPool[i], [cumDistributed[i], undistributed[i]]));
  monthCheck('出資者への分配の和 = 分配額（月ごと）', (i) => bigDiff(distribution[i], investorSeries.map((item) => item.dist[i])));
  monthCheck('窓口手数料の取り分の和 = 窓口手数料（月ごと）', (i) => bigDiff(S.windowFee[i], investorSeries.map((item) => item.wfee[i])));
  monthCheck('取得額の和 = 分配額 + 窓口手数料 + 幹事手数料（月ごと）', (i) => bigDiff(sumOf(investorSeries.map((item) => item.acq[i])), [distribution[i], S.windowFee[i], S.managerFee[i]]));
  monthCheck('流通の区分ごとの売上の和 = 売上（合計）（月ごと）', (i) => bigDiff(S.sales[i], salesGroups.map((group) => salesByNum.get(group)[i])));
  monthCheck('費目ごとの経費の和 = 経費（合計）（月ごと）', (i) => bigDiff(S.expense[i], expenseCategories.map((category) => expenseByNum.get(category)[i])));
  monthCheck('種別ごとの権利処理費の和 = 権利処理費（合計）（月ごと）', (i) => bigDiff(S.royalty[i], royaltyCategories.map((category) => royaltyByNum.get(category)[i])));
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  for (const key of ['sales', 'pool', 'distribution']) {
    const values = rowByKey.get(key).values;
    valueCheck(`期間前の累計 + 期間計 = 累計（${rowByKey.get(key).label}）`, bigDiff(values.cumulative, [values.period, values.prior ?? 0]));
  }
  const fyColumns = columns.filter((column) => column.kind === 'fy');
  if (fyColumns.length) {
    for (const key of ['sales', 'pool']) {
      const values = rowByKey.get(key).values;
      valueCheck(`年度計の和 = 期間計（${rowByKey.get(key).label}）`, bigDiff(values.period, fyColumns.map((column) => values[column.key])));
    }
  }
  const inPeriod = (month) => month >= from && month <= to;
  const periodSales = rowByKey.get('sales').values.period;
  // 元明細との照合（明細を渡されたときだけ。帳票 API は必ず渡す）
  if (Array.isArray(lines)) {
    const periodLines = lines.filter((line) => inPeriod(line.accountingMonth));
    valueCheck('元明細（売上）の和 = 期間の売上', bigDiff(sumOf(periodLines.map((line) => line.amount)), [periodSales]), `売上明細${periodLines.length}行`);
  }
  if (Array.isArray(expenseLines)) {
    const periodExpenses = expenseLines.filter((line) => inPeriod(line.month));
    valueCheck('元明細（経費）の和 = 期間の経費', bigDiff(sumOf(periodExpenses.map((line) => line.amount)), [rowByKey.get('expense').values.period]), `経費${periodExpenses.length}件`);
  }
  valueCheck('権利処理費の内訳の和 = 期間の権利処理費', bigDiff(sumOf(accruals.filter((row) => inPeriod(row.accrualMonth) && Number.isSafeInteger(row.royaltyYen)).map((row) => row.royaltyYen)), [rowByKey.get('royalty').values.period]));

  // ---- 保留・注意 ----
  const periodBasisDefault = new Set((lines || []).filter((line) => inPeriod(line.accountingMonth) && line.basisSource === 'default').map((line) => line.reportId));
  // 権利処理費の保留（期間内の分だけを数える）。一部だけ算定できた件は、算定できた額を権利処理費に含めている
  const periodRoyaltyHolds = royaltyHoldRows.filter((row) => row.inPeriod);
  const partialRoyaltyHolds = periodRoyaltyHolds.filter((row) => row.royaltyKnown);
  const royaltyPeriod = {
    count: periodRoyaltyHolds.length,
    months: [...new Set(periodRoyaltyHolds.map((row) => row.accrualMonth))].sort(),
    unknownCount: periodRoyaltyHolds.length - partialRoyaltyHolds.length,
    partialCount: partialRoyaltyHolds.length,
    includedYen: sumOf(partialRoyaltyHolds.map((row) => row.royaltyYen), '算定できた権利処理費'),
    holdSalesYen: sumOf(periodRoyaltyHolds.map((row) => (Number.isSafeInteger(row.holdSalesYen) ? row.holdSalesYen : 0)), '権利処理費の保留'),
  };
  const monthsOfVersion = (version) => historyMonths.filter((_, i) => versionAt[i] === version);
  const holds = {
    windowMissing: [...holdByGroup.values()].map((item) => ({
      channelGroup: item.channelGroup, label: item.label, windowKind: item.windowKind, reason: item.reason,
      months: [...item.months].sort(), periodSales: sumOf(item.rows.filter((row) => inPeriod(row.month)).map((row) => row.sales)),
      cumulativeSales: sumOf(item.rows.map((row) => row.sales)),
    })),
    royalty: royaltyHoldRows.sort((a, b) => a.accrualMonth.localeCompare(b.accrualMonth) || byRoyaltyOrder(a.category, b.category)),
    royaltyMonths: [...royaltyHoldMonths].sort(),
    royaltyPeriod,
    invalidFeeShares, managerMissing,
    feeSharesDropped: allWindows.filter(({window}) => droppedFeeShares.has(window.id)).map(({window, version}) => ({
      windowId: window.id, label: window.label, kind: window.kind, kindLabel: WINDOW_KIND_LABELS[window.kind] || window.kind, windowPartnerName: window.windowPartnerName || null,
      versionNo: version.versionNo, effectiveFrom: version.effectiveFrom, fromVersionNo: droppedFeeShares.get(window.id).fromVersionNo,
      monthCount: monthsOfVersion(version).length,
    })),
    unassignedWindowFee: toSafe(unassignedWindowFee.reduce((total, value) => total + value, 0n), '取り分の決まらない窓口手数料'),
    defaultBasisReports: periodBasisDefault.size,
    netReported: anyNonZero(S.netReported),
  };

  const monthly = historyMonths.map((month, i) => ({
    month, inPeriod: i >= periodStart, sales: S.sales[i], holdSales: S.holdSales[i], netReportedSales: S.netReported[i], platformFee: S.platformFee[i],
    windowFee: S.windowFee[i], managerFee: S.managerFee[i], income: S.income[i], expense: S.expense[i], royalty: S.royalty[i], royaltyHoldSales: S.royaltyHold[i],
    pool: pool[i], cumPool: cumPool[i], distributable: distributable[i], distribution: distribution[i], undistributed: undistributed[i],
    salesByChannel: Object.fromEntries(salesGroups.map((group) => [group, salesByNum.get(group)[i]])),
    royaltyByCategory: Object.fromEntries(royaltyCategories.map((category) => [category, royaltyByNum.get(category)[i]])),
    expenseByCategory: Object.fromEntries(expenseCategories.map((category) => [category, expenseByNum.get(category)[i]])),
    investors: Object.fromEntries(investorSeries.map((item) => [item.partnerId, {distribution: item.dist[i], windowFee: item.wfee[i], managerFee: item.mfee[i], acquisition: item.acq[i], cumulativeAcquisition: item.cumAcq[i]}])),
  }));

  const pick = (key, columnKey) => rowByKey.get(key)?.values[columnKey] ?? 0;
  const last = n - 1;
  const summary = {
    period: {sales: pick('sales', 'period'), holdSales: pick('holdSales', 'period'), platformFee: pick('platformFee', 'period'), windowFee: pick('windowFee', 'period'),
      managerFee: pick('managerFee', 'period'), income: pick('income', 'period'), expense: pick('expense', 'period'), royalty: pick('royalty', 'period'),
      pool: pick('pool', 'period'), distribution: pick('distribution', 'period')},
    cumulative: {sales: pick('sales', 'cumulative'), pool: pick('pool', 'cumulative'), distribution: pick('distribution', 'cumulative'),
      cumPool: cumPool[last] ?? 0, distributable: distributable[last] ?? 0, undistributed: undistributed[last] ?? 0},
    deficitMonths: historyMonths.filter((_, i) => i >= periodStart && undistributed[i] < 0),
  };

  return {
    calculationVersion: MONTHLY_CALCULATION_VERSION, from, to, periodMonths, historyMonths, firstMonth: historyMonths[0],
    columns: columns.map(({indices, ...column}) => ({...column, monthCount: indices.length})),
    rows, monthly, investors, checks, holds, summary,
    channels: salesGroups.map((group) => ({channelGroup: group, label: channelLabel(group), period: sumIn(salesByNum.get(group), periodCol), cumulative: sumIn(salesByNum.get(group), cumulativeCol),
      hold: holdByGroup.has(group)})),
    windows: allWindows.map(({window, version}) => ({...window, kindLabel: WINDOW_KIND_LABELS[window.kind] || window.kind,
      versionId: version.id, versionNo: version.versionNo, effectiveFrom: version.effectiveFrom,
      feeShares: (feePartsByWindow.get(window.id)?.parts || []).map((part) => ({partnerId: part.key, name: partners.get(part.key)?.name || null, shareBps: part.bps})),
      feeSharesRegistered: Boolean(feePartsByWindow.get(window.id)?.registered),
      feeSharesDroppedFrom: droppedFeeShares.get(window.id)?.fromVersionNo ?? null})),
    // 条件版ごとの適用（累計の対象の月のうち、その版で計算した月）
    versions: termVersions.map((version) => {
      const months = monthsOfVersion(version);
      return {id: version.id, versionNo: version.versionNo, effectiveFrom: version.effectiveFrom, managerPartnerId: version.managerPartnerId,
        monthCount: months.length, periodMonthCount: months.filter((month) => month >= from).length, firstMonth: months[0] || null, lastMonth: months.at(-1) || null};
    }),
  };
}

export function checksOk(checks = []) {
  return checks.every((check) => check.value === 0);
}
