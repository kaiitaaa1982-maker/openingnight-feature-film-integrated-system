// MG 作品の一覧（受取 MG）の行を、契約・条件版・台帳の行から導く純関数。表には持たず、開くたびに計算する。
// 会社ルートの計画 plans/2026-10-22-folder-mg-sell.md の「MG 作品の一覧」（見せ方は案 A: 回収の帯＋期間の帯＋到達見込み）。
// 回収の数字は MG 契約・台帳の画面が出す contractProgress（mg-ledger-import.mjs。累計の実充当・最新の条件版の保証額）を受け取って使い、
// 別の式で計算し直さない。台帳の行も、画面が訂正前を除いて契約ごとに絞ったもの（effectiveLedger）を受け取る。
// ブラウザ・Node で同じに動く（node:* を使わない）。

const latestVersion = (contract) => [...(contract?.versions || [])].sort((a, b) => Number(b.version) - Number(a.version))[0] || null;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PACE_MONTHS = 3;
// 台帳の額は DB で整数の円に限られている。整数でない値が来たら黙って0にせず止める（FR-SETL-MGL-027）
const yenOf = (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`MG の台帳の額が整数の円ではありません: ${value}`);
  return n;
};
export const monthIndex = (month) => {
  const [y, m] = String(month).slice(0, 7).split('-').map(Number);
  return y * 12 + m - 1;
};
export const indexMonth = (index) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

export const SELL_LIST_STATES = Object.freeze({
  reached: {label: '到達', tone: 'done'},
  onTrack: {label: '期間内', tone: 'ok'},
  atRisk: {label: '届かない見込', tone: 'risk'},
  waiting: {label: '報告待ち', tone: 'muted'},
  zero: {label: '保証額0円', tone: 'muted'},
});
const ORDER = {atRisk: 0, onTrack: 1, waiting: 2, reached: 3, zero: 4};

// 計上月ごとの実充当の和（訂正前の行を除く）。古い順。
export function monthlyApplied(rows = []) {
  const buckets = new Map();
  for (const row of rows) {
    const month = String(row.accounting_month || '');
    if (!MONTH.test(month)) continue;
    buckets.set(month, (buckets.get(month) || 0) + yenOf(row.applied_recoup_yen));
  }
  return [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([month, appliedYen]) => ({month, appliedYen}));
}

// 契約1件の一覧の行。progress は contractProgress の結果、entries はその契約の有効な台帳の行。today は 'YYYY-MM' か 'YYYY-MM-DD'。
export function sellListRow(contract, progress, entries = [], {today, partnerName = ''} = {}) {
  const version = latestVersion(contract);
  const months = monthlyApplied(entries);
  const startIndex = version?.starts_on ? monthIndex(version.starts_on) : null;
  const endIndex = version?.ends_on ? monthIndex(version.ends_on) : null;
  const todayIndex = monthIndex(today);
  const totalMonths = startIndex !== null && endIndex !== null ? endIndex - startIndex + 1 : 0;
  const elapsedMonths = totalMonths ? Math.min(totalMonths, Math.max(0, todayIndex - startIndex + 1)) : 0;
  const guaranteeYen = progress.guaranteeYen;

  let reachedMonth = null;
  let running = 0;
  for (const {month, appliedYen} of months) {
    running += appliedYen;
    if (guaranteeYen > 0 && reachedMonth === null && running >= guaranteeYen) reachedMonth = month;
  }
  const recent = months.slice(-PACE_MONTHS);
  // ペースは1円未満を切り捨てる（整数の割り算。見込みの月を出すだけで金額としては残さない）
  const paceYen = recent.length ? Number(BigInt(recent.reduce((total, m) => total + m.appliedYen, 0)) / BigInt(recent.length)) : 0;

  let state;
  let projectedMonth = null;
  if (guaranteeYen === 0) state = 'zero';
  else if (reachedMonth || progress.remainingYen === 0) {
    state = 'reached';
    projectedMonth = reachedMonth;
  } else if (!months.length) {
    state = endIndex !== null && todayIndex > endIndex ? 'atRisk' : 'waiting';
  } else if (paceYen <= 0) {
    state = 'atRisk';
  } else {
    const lastIndex = monthIndex(months.at(-1).month);
    // 残りをペースで割った月数（切り上げ）。整数の割り算で出す
    const monthsToGo = Number((BigInt(progress.remainingYen) + BigInt(paceYen) - 1n) / BigInt(paceYen));
    const projectedIndex = lastIndex + monthsToGo;
    projectedMonth = indexMonth(projectedIndex);
    state = endIndex !== null && projectedIndex > endIndex ? 'atRisk' : 'onTrack';
  }
  const products = (version?.products || []).map((p) => ({productId: Number(p.product_id), sku: p.sku, name: p.name, evaluationYen: yenOf(p.evaluation_yen)}));
  return {
    contractId: Number(contract?.id), code: contract?.code || '', title: contract?.title || '', partnerName,
    termVersion: version?.version ?? null, mode: version?.mode ?? null, startsOn: version?.starts_on || null, endsOn: version?.ends_on || null,
    products, guaranteeYen, cumulativeAppliedYen: progress.cumulativeAppliedYen, remainingYen: progress.remainingYen, exceedYen: progress.exceedYen,
    rate: progress.rate, unverifiedCount: progress.unverifiedCount, lastAccountingMonth: progress.lastAccountingMonth,
    totalMonths, elapsedMonths, leftMonths: Math.max(0, totalMonths - elapsedMonths),
    months, paceYen, reachedMonth, projectedMonth,
    overrunMonths: projectedMonth && endIndex !== null && state === 'atRisk' ? Math.max(0, monthIndex(projectedMonth) - endIndex) : null,
    projectedPercent: projectedMonth && totalMonths ? Math.min(100, Math.max(0, ((monthIndex(projectedMonth) - startIndex + 1) / totalMonths) * 100)) : null,
    state, stateLabel: SELL_LIST_STATES[state].label, tone: SELL_LIST_STATES[state].tone,
  };
}

// 一覧の全行と、上に出す5つの数字。items は {contract, progress, entries} の並び。
// 並びは「届かない見込」→「期間内」→「報告待ち」→「到達」、同じ状態は残りの大きい順。
export function buildSellList({items = [], partners = [], today} = {}) {
  const partnerOf = new Map(partners.map((p) => [Number(p.id), p.name]));
  const rows = items
    .map(({contract: c, progress, entries}) => sellListRow(c, progress, entries, {today, partnerName: partnerOf.get(Number(c.party_id ?? c.partner_id)) || ''}))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.remainingYen - a.remainingYen || a.code.localeCompare(b.code));
  const guaranteeYen = rows.reduce((t, r) => t + r.guaranteeYen, 0);
  const recoveredYen = rows.reduce((t, r) => t + Math.min(r.cumulativeAppliedYen, r.guaranteeYen), 0);
  return {
    rows,
    summary: {
      contractCount: rows.length, guaranteeYen, recoveredYen, remainingYen: guaranteeYen - recoveredYen,
      rate: guaranteeYen > 0 ? recoveredYen / guaranteeYen : null,
      reachedCount: rows.filter((r) => r.state === 'reached').length, atRiskCount: rows.filter((r) => r.state === 'atRisk').length,
    },
  };
}
