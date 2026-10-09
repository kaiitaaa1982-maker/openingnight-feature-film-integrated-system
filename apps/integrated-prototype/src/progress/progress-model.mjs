// 月次の受領進捗（純関数）。届くはずの報告（取引先×報告の種類×頻度×有効期間）から、月ごとに
// 未受領（期限前・期限超過）・取込済・一部請求・請求済・入金済を判定する。0円の報告と未受領を区別するための表。

export const FREQUENCIES = Object.freeze({
  monthly: {label: '毎月', step: 1},
  quarterly: {label: '四半期ごと', step: 3},
  semiannual: {label: '半年ごと', step: 6},
  annual: {label: '年1回', step: 12},
});

export const CELL_STATUS = Object.freeze({
  missing_overdue: {label: '未受領（期限超過）', short: '期限超過', tone: 'bad', rank: 0},
  missing: {label: '未受領（期限前）', short: '未受領', tone: 'warn', rank: 1},
  imported: {label: '取込済（未請求）', short: '取込済', tone: 'info', rank: 2},
  partly_billed: {label: '一部請求', short: '一部請求', tone: 'info', rank: 3},
  billed: {label: '請求済（入金待ち）', short: '請求済', tone: 'info', rank: 4},
  paid: {label: '入金済', short: '入金済', tone: 'ok', rank: 5},
  no_invoice: {label: '取込済（請求の対象外）', short: '取込済', tone: 'ok', rank: 5},
});

const monthIndex = (month) => {
  const [y, m] = month.split('-').map(Number);
  return y * 12 + (m - 1);
};
const fromIndex = (index) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
export const addMonths = (month, n) => fromIndex(monthIndex(month) + n);
const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export function monthsBetween(from, to) {
  const out = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i += 1) out.push(fromIndex(i));
  return out;
}

// 規則の対象月（期間の最初の月）。有効期間の開始月から頻度の間隔で並び、終了した規則は最後の対象月まで。
export function expectedMonths(rule, months) {
  const step = FREQUENCIES[rule.frequency]?.step || 1;
  const start = monthIndex(rule.active_from);
  const end = rule.last_month ? monthIndex(rule.last_month) : Infinity;
  return months.filter((month) => {
    const i = monthIndex(month);
    return i >= start && i <= end && (i - start) % step === 0;
  });
}

// 届く期限。対象期間の最後の月の翌月の due_day 日（月末を超える日はその月の末日）。due_day が無ければ翌月末。
export function dueDate(rule, month) {
  const step = FREQUENCIES[rule.frequency]?.step || 1;
  const dueMonth = addMonths(month, step);
  const day = Math.min(rule.due_day || lastDay(dueMonth), lastDay(dueMonth));
  return `${dueMonth}-${String(day).padStart(2, '0')}`;
}

// 報告がその対象期間（month から頻度の月数ぶん）に重なるか
export function coversPeriod(report, rule, month) {
  const step = FREQUENCIES[rule.frequency]?.step || 1;
  const start = `${month}-01`;
  const endMonth = addMonths(month, step - 1);
  const end = `${endMonth}-${String(lastDay(endMonth)).padStart(2, '0')}`;
  return report.period_from <= end && report.period_to >= start;
}

export function ruleMatches(rule, report) {
  return report.partner_id === rule.partner_id && report.kind === rule.kind && (rule.work_id == null || report.work_id === rule.work_id);
}

// billing: Map(reportId → {lines, claimed, paidInvoices, openInvoices})
export function cellFor({rule, month, reports, billing, today}) {
  const matched = reports.filter((report) => ruleMatches(rule, report) && coversPeriod(report, rule, month));
  const due = dueDate(rule, month);
  if (!matched.length) {
    const code = today > due ? 'missing_overdue' : 'missing';
    return {month, code, ...CELL_STATUS[code], due, reportIds: []};
  }
  let lines = 0, claimed = 0, open = 0;
  for (const report of matched) {
    const b = billing.get(report.id) || {lines: 0, claimed: 0, openInvoices: 0};
    lines += b.lines; claimed += b.claimed; open += b.openInvoices;
  }
  let code;
  if (lines === 0) code = 'no_invoice';
  else if (claimed === 0) code = 'imported';
  else if (claimed < lines) code = 'partly_billed';
  else if (open > 0) code = 'billed';
  else code = 'paid';
  // 欄は報告の対象期間で判定するので、売上明細へ移るときは報告の計上月（最小〜最大）で絞る
  const accountingMonths = matched.map((report) => report.accounting_month).filter(Boolean).sort();
  return {month, code, ...CELL_STATUS[code], due, reportIds: matched.map((report) => report.id),
    accountingFrom: accountingMonths[0] || month, accountingTo: accountingMonths[accountingMonths.length - 1] || month};
}

// rules: [{id, partner_id, partner_name, kind, kind_label, work_id, work_title, frequency, due_day, active_from, last_month}]
export function buildProgressMatrix({rules = [], reports = [], billing = new Map(), months, today}) {
  const rows = rules.map((rule) => {
    const expected = new Set(expectedMonths(rule, months));
    const cells = months.map((month) => (expected.has(month) ? cellFor({rule, month, reports, billing, today}) : {month, code: 'none', label: '対象外', short: '', tone: 'none', reportIds: []}));
    return {...rule, frequencyLabel: FREQUENCIES[rule.frequency]?.label || rule.frequency, cells};
  });
  const counts = Object.fromEntries(Object.keys(CELL_STATUS).map((code) => [code, 0]));
  for (const row of rows) for (const cell of row.cells) if (counts[cell.code] !== undefined) counts[cell.code] += 1;
  const expectedTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  return {months, rows, counts, expectedTotal};
}

// 件数カードで絞り込む。code が 'missing_all' なら未受領（期限前・超過の両方）
export function filterRows(rows, code) {
  if (!code) return rows;
  const want = code === 'missing_all' ? new Set(['missing', 'missing_overdue']) : new Set([code]);
  return rows.filter((row) => row.cells.some((cell) => want.has(cell.code)));
}
