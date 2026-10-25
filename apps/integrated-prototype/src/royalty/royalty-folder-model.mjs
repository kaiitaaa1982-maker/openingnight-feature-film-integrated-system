// ロイヤリティ報告管理のフォルダ画面（会社ルート plans/2026-10-22-folder-royalty.md）で使う純関数。
// 期間の一覧（GET /api/royalty/periods の periods）だけを入力にし、権利者×締め月のマス・今月送る・支払月の合計・権利者の推移を作る。
// 状態の列は足さず、期間の一覧の状態（FR-SETL-STMT-008）をそのまま読む。React に依存しない（node で試験する）。

// マスの1字（色だけで示さない）。0円で報告済みは「0円済」
export const CELL_CHAR = Object.freeze({open: '受', pending: '作', overdue: '超', created: '済', reported: '報', paid: '払', merged: '後'});
const DONE = new Set(['reported', 'paid', 'merged']);

const monthAdd = (month, k) => {
  const [y, m] = month.split('-').map(Number), i = y * 12 + m - 1 + k;
  return `${Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`;
};

// 年度の12か月。startMonth は期首の月（1〜12）。fy はその年度の期首の年
export function fiscalMonths(fy, startMonth) {
  const first = `${fy}-${String(startMonth).padStart(2, '0')}`;
  return Array.from({length: 12}, (_, k) => monthAdd(first, k));
}

// 基準日の属する年度（期首の年）
export function fiscalYearOf(date, startMonth) {
  const [y, m] = date.slice(0, 7).split('-').map(Number);
  return m >= startMonth ? y : y - 1;
}

// 期間の額。確定版があればその額、無ければ下書きの額（draft: true）。権限外や計算できない期間は null
export function amountOf(period) {
  if (period.statementId) return {payableYen: period.payableYen ?? 0, royaltyYen: period.royaltyYen ?? 0, adjustmentYen: period.adjustmentYen ?? 0, carriedOutYen: period.carriedOutYen ?? 0, draft: false};
  const t = period.draft?.totals;
  if (!t) return null;
  return {payableYen: t.payableYen ?? 0, royaltyYen: t.royaltyYen ?? 0, adjustmentYen: t.adjustmentYen ?? 0, carriedOutYen: t.carriedOutYen ?? 0, draft: true};
}

export function cellOf(period) {
  const amount = amountOf(period);
  const zeroDone = period.status === 'reported' && period.statementId && (period.payableYen ?? 0) === 0;
  return {
    status: zeroDone ? 'paid' : period.status,
    char: zeroDone ? '0円済' : CELL_CHAR[period.status] || '?',
    label: zeroDone ? '0円で報告済' : period.statusLabel,
    amount, period,
  };
}

// 権利者×月のマス。年度は報告月（報告期限の月）で区切り、マスは締め月の列に置く（問い3 A）。
// 締め月でない月は null（画面では「–」）。権利者は名前の順
export function buildGrid(periods, months) {
  const inYear = new Set(months);
  const holders = new Map();
  const extra = new Set();
  for (const p of periods) {
    // 報告期限の無い期間（受付中の先の月など）は締め月で年度に入れる
    const yearMonth = p.reportDueOn ? p.reportDueOn.slice(0, 7) : p.closeMonth;
    if (!inYear.has(yearMonth)) continue;
    if (!holders.has(p.holderId)) holders.set(p.holderId, {holderId: p.holderId, holderName: p.holderName, cells: {}});
    holders.get(p.holderId).cells[p.closeMonth] = cellOf(p);
    if (!inYear.has(p.closeMonth)) extra.add(p.closeMonth);   // 期首前の締め月を期首の後に報告するもの
  }
  const columns = [...new Set([...extra, ...months])].sort();
  return {columns, rows: [...holders.values()].sort((a, b) => (a.holderName || '').localeCompare(b.holderName || '', 'ja'))};
}

// 今月送る: 報告期限が今月以前で、まだ報告していない期間（期限超過を含む）。古い期限の順
export function dueThisMonth(periods, month) {
  const rows = periods.filter((p) => p.reportDueOn && p.reportDueOn.slice(0, 7) <= month && !DONE.has(p.status) && p.status !== 'open');
  rows.sort((a, b) => a.reportDueOn.localeCompare(b.reportDueOn) || (a.holderName || '').localeCompare(b.holderName || '', 'ja'));
  return {rows, remaining: rows.length, unreported: rows.filter((p) => p.statementId).length, uncreated: rows.filter((p) => !p.statementId).length};
}

// 支払月ごとの合計（支払期限の月で足す）。確定版の支払予定・支払済・未払と、まだ確定していない下書きの額を分ける
export function paymentMonthTotals(periods) {
  const byMonth = new Map();
  for (const p of periods) {
    if (!p.paymentDueOn || p.status === 'merged') continue;
    const a = amountOf(p);
    if (!a || a.payableYen <= 0) continue;
    const k = p.paymentDueOn.slice(0, 7);
    const row = byMonth.get(k) || {month: k, statements: 0, payableYen: 0, paidYen: 0, unpaidYen: 0, drafts: 0, draftYen: 0};
    if (a.draft) { row.drafts += 1; row.draftYen += a.payableYen; }
    else { row.statements += 1; row.payableYen += a.payableYen; row.paidYen += p.paidYen ?? 0; row.unpaidYen += a.payableYen - (p.paidYen ?? 0); }
    byMonth.set(k, row);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// 権利者の推移（締め月の順。当期・支払予定・支払済と、当期の累計）
export function holderTrend(periods, holderId) {
  let cumulative = 0;
  return periods.filter((p) => String(p.holderId) === String(holderId)).sort((a, b) => a.closeMonth.localeCompare(b.closeMonth)).map((p) => {
    const a = amountOf(p);
    cumulative += a?.royaltyYen ?? 0;
    return {closeMonth: p.closeMonth, cell: cellOf(p), royaltyYen: a?.royaltyYen ?? null, adjustmentYen: a?.adjustmentYen ?? null, payableYen: a?.payableYen ?? null,
      carriedOutYen: a?.carriedOutYen ?? null, paidYen: p.statementId ? p.paidYen ?? 0 : null, draft: a?.draft ?? null, cumulativeYen: cumulative, reportedOn: p.reportedOn || null, period: p};
  });
}
