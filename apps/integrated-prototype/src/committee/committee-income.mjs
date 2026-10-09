import {expenseSource} from '../expense-sheet/expense-read.mjs';
// 製作委員会の本委員会収入（作品×計上月×流通の区分）。ロイヤリティの基礎（committee_income 系）と委員会の月次収支が同じ値を使う。
// 設計: docs/platform/team-development/royalty-committee-design.md §4。Worker でも動くよう node:* を import しない。
//
// loadCommitteeIncome(db, identity, {workIds, from, to, contractIds}, ctx) →
//   {rows, expenses, lines, expenseLines, terms}
//   rows:     [{workId, month, channelGroup, channelLabel, windowKind, windowId, windowLabel, sales, grossSales, netReportedSales,
//              platformFee, platformNet, windowFee, managerFee, income, hold, lineCount, reportCount}]
//             hold='no_window' の行は、その区分の窓口が条件版に無いため手数料・収入を算定できない（platformFee 以降は null。0円にしない）
//   expenses: [{workId, month, category, amount, count}]（作品の経費・計上月・税抜。費目ごと）
//   lines:    作品へ配賦した売上明細（channel-group.mjs の workSaleLines）に、窓口・報告額の基準を付けたもの
//   terms:    Map(workId → 採用した委員会契約と条件版。version・members・windows などは最新の版、versions はすべての版（適用開始月つき）)
//   委員会契約の無い作品は返さない。ctx.settlementWork があれば、作品の財務権限がある作品だけにする。
//
// 条件版の適用: 計上月ごとに「適用開始月（committee_term_version_effective）がその月以前の条件版のうち、版番号が最大のもの」を使う。
//   適用開始月の無い版（契約の版1・適用開始月を決めずに作った版）は最初の月から適用する。新しい版は適用開始月から後の月だけを変える。
//
// 計算（保存済みの期間報告の calculateCommitteeWindow と同じ順・同じ基礎・同じ端数処理。月の帳票なので負の額も止めない）:
//   1. 売上の区分（channelGroup）→ 窓口（COMMITTEE_WINDOW_OF）。その計上月に効いている条件版の、その種類の窓口の料率を使う。
//   2. PF控除: 報告額の基準が「控除前（gross）」の売上だけ、売上報告×計上月×区分ごとに 売上×PF料率 を切り捨て。
//      「控除後（net）」の報告は報告元でPF控除済みのため、PF控除の額は分からない（0円ではなく netReportedSales として別に持つ）。
//   3. 窓口手数料・幹事手数料: 計上月×区分ごとの PF控除後の額に、窓口の fee_order と基礎（platform_net／after_window／after_manager）
//      のとおり料率を掛けて切り捨て（金額の絶対値に掛けて1円未満切り捨て、符号を戻す）。
//   4. 本委員会収入 = PF控除後 − 窓口手数料 − 幹事手数料。
// 報告額の基準は、委員会の期間報告で決めた基準（committee_snapshot_reports）→ 権利契約への紐付けの基準（settlement_report_links）
// の順に採り、どちらにも無い報告は「控除前（gross）」として計算する（売上明細は控除前が原則）。どれで決めたかを明細に残す。
import {workSaleLines, sharedReads, COMMITTEE_WINDOW_OF, CHANNEL_GROUPS, CHANNEL_LABELS} from '../sales/channel-group.mjs';
import {allIn} from '../sql-in.mjs';
import {termVersionAt} from './committee-monthly-model.mjs';

export const COMMITTEE_INCOME_VERSION = 'committee-income-v1';
export const BASIS_SOURCES = Object.freeze({
  committee: '委員会の期間報告で確定',
  settlement: '権利契約への紐付けで確定',
  default: '未確認（控除前として計算）',
});
export const HOLD_REASONS = Object.freeze({
  no_window: 'この区分の窓口が委員会の条件版に無いため、手数料と収入を算定できません',
});

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MIN = BigInt(Number.MIN_SAFE_INTEGER);

function toSafe(big, label = '金額') {
  if (big > MAX || big < MIN) throw new Error(`${label}が安全な整数範囲を超えています`);
  return Number(big);
}

export function bigSum(values, label = '金額の合計') {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!Number.isSafeInteger(value)) throw new Error(`${label}に安全な整数でない値があります`);
    total += BigInt(value);
  }
  return toSafe(total, label);
}

// 符号付きの額に料率（bp）を掛けて1円未満を切り捨てる（committee.mjs の fee、app.mjs の signedRateAmount と同じ）。
export function committeeFee(amount, bps) {
  if (!Number.isSafeInteger(amount) || !Number.isInteger(bps)) throw new Error('手数料の計算には整数円・整数bpが必要です');
  const sign = amount < 0 ? -1n : 1n;
  return toSafe(sign * (BigInt(Math.abs(amount)) * BigInt(bps) / 10000n), '手数料');
}

// 窓口手数料と幹事手数料。calculateCommitteeWindow と同じ: 窓口先引きは 窓口=PF控除後、幹事=PF控除後か窓口控除後。
// 幹事先引きは 幹事=PF控除後、窓口=PF控除後か幹事控除後。
export function windowFees(platformNet, window) {
  if (window.feeOrder === 'window_first') {
    const windowFee = committeeFee(platformNet, window.windowFeeBps);
    const managerFee = committeeFee(window.managerFeeBasis === 'after_window' ? platformNet - windowFee : platformNet, window.managerFeeBps);
    return {windowFee, managerFee};
  }
  if (window.feeOrder === 'manager_first') {
    const managerFee = committeeFee(platformNet, window.managerFeeBps);
    const windowFee = committeeFee(window.windowFeeBasis === 'after_manager' ? platformNet - managerFee : platformNet, window.windowFeeBps);
    return {windowFee, managerFee};
  }
  throw new Error('窓口の手数料の控除順が分かりません');
}

const groupOrder = (group) => {
  const index = CHANNEL_GROUPS.indexOf(group);
  return index === -1 ? CHANNEL_GROUPS.length : index;
};

// 計上月に効いている条件版（committee-monthly-model.mjs と同じ関数）
export {termVersionAt};

// 売上明細 → 作品×計上月×区分の本委員会収入（純関数）。
// lines: workSaleLines の行。termsByWork: Map(workId → {versions:[{id, versionNo, effectiveFrom, windows}]} または {windows:[...]})。
//   windows: [{id, kind, label, platformRateBps, windowFeeBps, managerFeeBps, feeOrder, windowFeeBasis, managerFeeBasis}]
//   basisByReport: Map(`${workId}:${reportId}` → {basis:'gross'|'net', source})
export function computeCommitteeIncome({lines = [], termsByWork = new Map(), basisByReport = new Map()} = {}) {
  const detailed = [];
  const cells = new Map();
  for (const line of lines) {
    const term = termsByWork.get(Number(line.workId));
    if (!term) continue;
    if (!Number.isSafeInteger(line.amount)) throw new Error('作品へ配賦した売上が安全な整数ではありません');
    const version = term.versions?.length ? termVersionAt(term.versions, line.accountingMonth) : null;
    const windows = (version ? version.windows : term.windows) || [];
    const group = line.channelGroup || 'other';
    const windowKind = COMMITTEE_WINDOW_OF[group] || 'other';
    const window = windows.find((row) => row.kind === windowKind) || null;
    const basisInfo = basisByReport.get(`${line.workId}:${line.reportId}`) || {basis: 'gross', source: 'default'};
    detailed.push({...line, channelGroup: group, windowKind, windowId: window?.id ?? null, windowLabel: window?.label ?? null,
      termVersionId: version?.id ?? null, termVersionNo: version?.versionNo ?? null,
      basis: basisInfo.basis, basisSource: basisInfo.source, hold: window ? null : 'no_window'});
    const key = `${line.workId}|${line.accountingMonth}|${group}`;
    if (!cells.has(key)) {
      cells.set(key, {workId: Number(line.workId), month: line.accountingMonth, channelGroup: group, windowKind, window, version, reports: new Map(), lineCount: 0});
    }
    const cell = cells.get(key);
    cell.lineCount += 1;
    if (!cell.reports.has(line.reportId)) cell.reports.set(line.reportId, {basis: basisInfo.basis, amounts: []});
    cell.reports.get(line.reportId).amounts.push(line.amount);
  }
  const rows = [];
  for (const cell of cells.values()) {
    const reports = [...cell.reports.values()].map((report) => ({basis: report.basis, amount: bigSum(report.amounts, '売上報告の額')}));
    const sales = bigSum(reports.map((report) => report.amount), '売上');
    const grossSales = bigSum(reports.filter((report) => report.basis === 'gross').map((report) => report.amount), '控除前の売上');
    const netReportedSales = bigSum(reports.filter((report) => report.basis === 'net').map((report) => report.amount), '控除後の売上');
    const base = {
      workId: cell.workId, month: cell.month, channelGroup: cell.channelGroup, channelLabel: CHANNEL_LABELS[cell.channelGroup] || 'その他',
      windowKind: cell.windowKind, windowId: cell.window?.id ?? null, windowLabel: cell.window?.label ?? null,
      termVersionId: cell.version?.id ?? null, termVersionNo: cell.version?.versionNo ?? null,
      sales, grossSales, netReportedSales, lineCount: cell.lineCount, reportCount: reports.length,
    };
    if (!cell.window) {
      rows.push({...base, platformFee: null, platformNet: null, windowFee: null, managerFee: null, income: null, hold: 'no_window'});
      continue;
    }
    // PF控除は売上報告ごと（保存用の計算と同じ粒度）。控除後の報告にはPF控除を掛けない
    const platformFee = bigSum(reports.filter((report) => report.basis === 'gross').map((report) => committeeFee(report.amount, cell.window.platformRateBps)), 'PF控除');
    const platformNet = sales - platformFee;
    const {windowFee, managerFee} = windowFees(platformNet, cell.window);
    rows.push({...base, platformFee, platformNet, windowFee, managerFee, income: platformNet - windowFee - managerFee, hold: null,
      platformRateBps: cell.window.platformRateBps, windowFeeBps: cell.window.windowFeeBps, managerFeeBps: cell.window.managerFeeBps, feeOrder: cell.window.feeOrder});
  }
  rows.sort((a, b) => a.workId - b.workId || a.month.localeCompare(b.month) || groupOrder(a.channelGroup) - groupOrder(b.channelGroup));
  return {rows, lines: detailed};
}

// 経費の明細 → 作品×計上月×費目の和（純関数）。
export function summarizeExpenses(expenseLines = []) {
  const map = new Map();
  for (const row of expenseLines) {
    const key = `${row.workId}|${row.month}|${row.category}`;
    if (!map.has(key)) map.set(key, {workId: row.workId, month: row.month, category: row.category, amounts: [], count: 0});
    const item = map.get(key);
    item.amounts.push(row.amount);
    item.count += 1;
  }
  return [...map.values()].map((item) => ({workId: item.workId, month: item.month, category: item.category, amount: bigSum(item.amounts, '経費'), count: item.count}))
    .sort((a, b) => a.workId - b.workId || a.month.localeCompare(b.month) || String(a.category).localeCompare(String(b.category), 'ja'));
}

const ids = (list) => [...new Set((list || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];

// 1回の要求の中の読み出しを分け合う（channel-group.mjs の withSharedReads で包んだ db のときだけ）。同じ鍵は1回だけ読む
function sharedOnce(db, key, load) {
  const cache = sharedReads(db);
  if (!cache) return load();
  if (!cache.has(key)) {
    const promise = load();
    cache.set(key, promise);
    promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
  }
  return cache.get(key);
}

// 作品の委員会契約と、採用する契約の条件版（すべての版。適用開始月・窓口・参加者・出資額・窓口手数料の取り分つき）。
// 採用する契約: contractIds に作品の契約があればそれ、無ければ作品の最後に登録した契約。
// 返す値の version・members・windows・funding・investments・feeShares は版番号が最大の版（いまの条件）。versions は版番号の順。
export async function loadCommitteeTerms(db, orgId, workIds, {contractIds = []} = {}) {
  const works = ids(workIds).sort((a, b) => a - b);
  if (!works.length) return new Map();
  const wanted = ids(contractIds).sort((a, b) => a - b);
  return sharedOnce(db, `committeeTerms|${orgId}|${works.join(',')}|${wanted.join(',')}`, () => readCommitteeTerms(db, orgId, works, new Set(wanted)));
}

async function readCommitteeTerms(db, orgId, works, wanted) {
  const out = new Map();
  const contracts = await allIn(db, `SELECT c.id, c.work_id, c.contract_code, c.title, c.created_at, d.title AS document_title, d.reference AS document_reference, d.version_label AS document_version
      FROM committee_contracts c LEFT JOIN rights_intake_documents d ON d.org_id=c.org_id AND d.id=c.document_id
      WHERE c.org_id=? AND c.work_id IN (:in)`, {before: [orgId], ids: works, sortBy: (a, b) => a.work_id - b.work_id || a.id - b.id});
  if (!contracts.length) return out;
  const chosen = [];
  for (const workId of works) {
    const own = contracts.filter((row) => row.work_id === workId);
    if (!own.length) continue;
    chosen.push({workId, contract: own.find((row) => wanted.has(row.id)) || own.at(-1), contracts: own});
  }
  const versions = await allIn(db, `SELECT v.id, v.contract_id, v.version_no, v.source_version_id, v.manager_partner_id, v.note, v.created_at, p.name AS manager_name,
        e.effective_from
      FROM committee_term_versions v LEFT JOIN partners p ON p.org_id=v.org_id AND p.id=v.manager_partner_id
      LEFT JOIN committee_term_version_effective e ON e.org_id=v.org_id AND e.term_version_id=v.id
      WHERE v.org_id=? AND v.contract_id IN (:in)`, {before: [orgId], ids: chosen.map((item) => item.contract.id), sortBy: (a, b) => a.contract_id - b.contract_id || a.version_no - b.version_no});
  const versionIds = versions.map((row) => row.id);
  const [members, windows, funding, investments] = versionIds.length ? await Promise.all([
    allIn(db, `SELECT m.term_version_id, m.partner_id, m.role, m.share_bps, m.member_order, p.name, p.code
        FROM committee_term_members m JOIN partners p ON p.org_id=m.org_id AND p.id=m.partner_id WHERE m.org_id=? AND m.term_version_id IN (:in)`,
    {before: [orgId], ids: versionIds, sortBy: (a, b) => a.term_version_id - b.term_version_id || a.member_order - b.member_order}),
    allIn(db, `SELECT w.*, p.name AS window_partner_name FROM committee_term_windows w JOIN partners p ON p.org_id=w.org_id AND p.id=w.window_partner_id
        WHERE w.org_id=? AND w.term_version_id IN (:in)`, {before: [orgId], ids: versionIds, sortBy: (a, b) => a.term_version_id - b.term_version_id || a.id - b.id}),
    allIn(db, 'SELECT term_version_id, production_cost_yen FROM committee_term_funding WHERE org_id=? AND term_version_id IN (:in)', {before: [orgId], ids: versionIds}),
    allIn(db, 'SELECT term_version_id, partner_id, amount_yen FROM committee_term_investments WHERE org_id=? AND term_version_id IN (:in)', {before: [orgId], ids: versionIds}),
  ]) : [[], [], [], []];
  const windowIds = windows.map((row) => row.id);
  const shares = windowIds.length ? await allIn(db, `SELECT s.window_id, s.partner_id, s.share_bps, s.reason, s.created_at, s.created_by, p.name, u.display_name AS created_by_name
      FROM committee_term_window_fee_shares s JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id LEFT JOIN users u ON u.id=s.created_by
      WHERE s.org_id=? AND s.window_id IN (:in)`, {before: [orgId], ids: windowIds, sortBy: (a, b) => a.window_id - b.window_id || a.partner_id - b.partner_id}) : [];
  const detailOf = (row) => {
    const versionId = row.id;
    const fund = funding.find((item) => item.term_version_id === versionId);
    const ownWindows = windows.filter((item) => item.term_version_id === versionId).map((item) => ({
      id: item.id, kind: item.kind, label: item.label, windowPartnerId: item.window_partner_id, windowPartnerName: item.window_partner_name, route: item.route,
      platformRateBps: item.platform_rate_bps, windowFeeBps: item.window_fee_bps, managerFeeBps: item.manager_fee_bps, feeOrder: item.fee_order,
      windowFeeBasis: item.window_fee_basis, managerFeeBasis: item.manager_fee_basis,
    }));
    const ownWindowIds = new Set(ownWindows.map((item) => item.id));
    return {
      id: versionId, versionNo: row.version_no, sourceVersionId: row.source_version_id ?? null, effectiveFrom: row.effective_from || null,
      managerPartnerId: row.manager_partner_id, managerName: row.manager_name || null, note: row.note || null, createdAt: row.created_at,
      members: members.filter((item) => item.term_version_id === versionId).map((item) => ({partnerId: item.partner_id, name: item.name, code: item.code,
        role: item.role || null, shareBps: item.share_bps, memberOrder: item.member_order})),
      windows: ownWindows,
      funding: fund ? {productionCostYen: fund.production_cost_yen} : null,
      investments: fund ? investments.filter((item) => item.term_version_id === versionId).map((item) => ({partnerId: item.partner_id, amountYen: item.amount_yen})) : null,
      feeShares: shares.filter((item) => ownWindowIds.has(item.window_id)).map((item) => ({windowId: item.window_id, partnerId: item.partner_id, name: item.name,
        shareBps: item.share_bps, reason: item.reason, createdAt: item.created_at, createdByName: item.created_by_name || null})),
    };
  };
  for (const item of chosen) {
    const ownVersions = versions.filter((row) => row.contract_id === item.contract.id).map(detailOf);
    const latest = ownVersions.at(-1) || null;
    out.set(item.workId, {
      workId: item.workId,
      contract: {id: item.contract.id, code: item.contract.contract_code, title: item.contract.title, createdAt: item.contract.created_at,
        documentTitle: item.contract.document_title || null, documentReference: item.contract.document_reference || null, documentVersion: item.contract.document_version || null},
      contracts: item.contracts.map((row) => ({id: row.id, code: row.contract_code, title: row.title})),
      version: latest ? {id: latest.id, versionNo: latest.versionNo, managerPartnerId: latest.managerPartnerId, managerName: latest.managerName, note: latest.note,
        createdAt: latest.createdAt, effectiveFrom: latest.effectiveFrom, versionCount: ownVersions.length} : null,
      versions: ownVersions,
      members: latest?.members || [],
      windows: latest?.windows || [],
      funding: latest?.funding || null,
      investments: latest ? latest.investments : null,
      feeShares: latest?.feeShares || [],
    });
  }
  return out;
}

// 売上報告ごとの報告額の基準（明示されたものだけ）。Map(`${workId}:${reportId}` → {basis, source})
export async function loadReportBasis(db, orgId, workIds) {
  const works = ids(workIds);
  const map = new Map();
  if (!works.length) return map;
  const settlement = await allIn(db, 'SELECT work_id, report_id, report_basis FROM settlement_report_links WHERE org_id=? AND work_id IN (:in)', {before: [orgId], ids: works});
  for (const row of settlement) map.set(`${row.work_id}:${row.report_id}`, {basis: row.report_basis, source: 'settlement'});
  const committee = await allIn(db, 'SELECT work_id, report_id, report_basis FROM committee_snapshot_reports WHERE org_id=? AND work_id IN (:in)', {before: [orgId], ids: works});
  for (const row of committee) map.set(`${row.work_id}:${row.report_id}`, {basis: row.report_basis, source: 'committee'});
  return map;
}

// 作品の経費の明細（計上月・税抜）。作品に直接付いた経費だけ。
export async function loadCommitteeExpenseLines(db, orgId, workIds, {from = '0000-01', to = '9999-12'} = {}) {
  const works = ids(workIds);
  if (!works.length) return [];
  const rows = await allIn(db, `SELECT e.id, e.work_id, e.accounting_month, e.incurred_on, e.category, e.description, e.actual_ex_tax, e.partner_id, p.name AS partner_name
      FROM ${expenseSource()} e LEFT JOIN partners p ON p.org_id=e.org_id AND p.id=e.partner_id
      WHERE e.org_id=? AND e.work_id IN (:in) AND e.accounting_month BETWEEN ? AND ?`,
  {before: [orgId], ids: works, after: [from, to], sortBy: (a, b) => a.accounting_month.localeCompare(b.accounting_month) || a.id - b.id});
  return rows.map((row) => ({id: row.id, workId: row.work_id, month: row.accounting_month, incurredOn: row.incurred_on, category: row.category,
    description: row.description, amount: row.actual_ex_tax, partnerId: row.partner_id, partnerName: row.partner_name || null}));
}

// 作品×計上月×区分の本委員会収入と経費。withSharedReads で包んだ db なら、同じ要求で先に計算した結果
// （作品・期間を包含し、採用する契約が同じもの）から返す（ロイヤリティの発生額が委員会の月次収支と同じ明細を読み直さない）。
export async function loadCommitteeIncome(db, identity, {workIds = [], from = '0000-01', to = '9999-12', contractIds = []} = {}, ctx = {}) {
  const orgId = identity?.org_id;
  if (!orgId) throw new Error('組織が分かりません');
  let works = ids(workIds);
  if (typeof ctx.settlementWork === 'function') {
    const allowed = [];
    for (const workId of works) if (await ctx.settlementWork(identity, workId)) allowed.push(workId);
    works = allowed;
  }
  const contractKey = ids(contractIds).sort((a, b) => a - b).join(',');
  const cache = sharedReads(db);
  if (cache && !cache.has('committeeIncome')) cache.set('committeeIncome', []);
  const entries = cache ? cache.get('committeeIncome') : null;
  const covering = entries?.find((entry) => entry.orgId === orgId && entry.contractKey === contractKey && entry.from <= from && entry.to >= to
    && works.every((workId) => entry.works.has(workId)));
  if (covering) return scopeIncome(await covering.promise, new Set(works), from, to);
  const promise = readCommitteeIncome(db, orgId, works, from, to, contractIds);
  if (entries) {
    const entry = {orgId, contractKey, works: new Set(works), from, to, promise};
    entries.push(entry);
    promise.catch(() => { entries.splice(entries.indexOf(entry), 1); });
  }
  return promise;
}

async function readCommitteeIncome(db, orgId, works, from, to, contractIds) {
  const terms = await loadCommitteeTerms(db, orgId, works, {contractIds});
  const termWorks = [...terms.keys()];
  if (!termWorks.length) return {rows: [], expenses: [], lines: [], expenseLines: [], terms};
  const [saleLines, basisByReport, expenseLines] = await Promise.all([
    workSaleLines(db, orgId, termWorks, {from, to}),
    loadReportBasis(db, orgId, termWorks),
    loadCommitteeExpenseLines(db, orgId, termWorks, {from, to}),
  ]);
  const {rows, lines} = computeCommitteeIncome({lines: saleLines, termsByWork: terms, basisByReport});
  return {rows, expenses: summarizeExpenses(expenseLines), lines, expenseLines, terms};
}

// 先に計算した結果を作品・期間で絞る（本委員会収入は計上月×区分ごとの計算なので、絞っても額は変わらない）
function scopeIncome(result, works, from, to) {
  const inWork = (workId) => works.has(Number(workId));
  const inRange = (month) => month >= from && month <= to;
  return {
    rows: result.rows.filter((row) => inWork(row.workId) && inRange(row.month)),
    expenses: result.expenses.filter((row) => inWork(row.workId) && inRange(row.month)),
    lines: result.lines.filter((line) => inWork(line.workId) && inRange(line.accountingMonth)),
    expenseLines: result.expenseLines.filter((row) => inWork(row.workId) && inRange(row.month)),
    terms: new Map([...result.terms].filter(([workId]) => inWork(workId))),
  };
}
