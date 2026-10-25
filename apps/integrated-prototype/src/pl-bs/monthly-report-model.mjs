// 月次の報告（春川の単位の PL・BS を先月・前年同月と比べ、差から課題の候補を起こす）。React に依存しない純関数。
// 計画: 会社ルートの plans/2026-10-22-folder-plbs.md の「2026-10-24 の方向」（問い9〜14 は全部 A）。組織（org_id）＝春川の単位。
// 材料は /api/reports/pl-bs の応答（計上・税抜）。PL は (月−12)〜月 の会社PL の月の列、BS は月末と前の月末の会社BS。
// 金額は円の整数のまま扱い、率は bp（1万分率）の整数で truncate して出す（docs/rules/money.md）。
// 課題の候補の基準は問い13 の A: 先月か前年同月との差が ±5%（500bp）以上か ±50万円以上の行。
// 計画（予実管理の予測。入金の基準）と比べる行は、予実の受け口をつなぐ次の段で足す（約束13 の B）。
import {gridSheetSpec} from '../ui/grid-model.mjs';
import {monthLabel} from '../reports/pl-bs-model.mjs';

export const ISSUE_RATE_BPS = 500;
export const ISSUE_YEN = 500000;

// PL の行（会社PL の行キー）。cost は増えると悪い行
export const MONTHLY_PL_ROWS = Object.freeze([
  {key: 'total:sales', label: '売上高'},
  {key: 'total:cogs', label: '売上原価', cost: true},
  {key: 'grossProfit', label: '粗利（売上総利益）', emphasis: true},
  {key: 'total:sga', label: '販売費及び一般管理費', cost: true},
  {key: 'operatingProfit', label: '営業利益', emphasis: true},
  // 経常利益・当期純利益は表に出すが、課題の候補にはしない（営業利益と同じ差が重なって並ぶため）
  {key: 'ordinaryProfit', label: '経常利益', noIssue: true},
  {key: 'netIncome', label: '当期純利益', emphasis: true, noIssue: true},
]);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (value) => MONTH.test(String(value ?? ''));

export function shiftMonth(month, delta) {
  if (!isMonth(month)) throw new Error('月は「2026-04」の形で指定してください');
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// 読む2つの受け口の条件（PL は前年同月から当月まで、BS は当月末と前の月末）
export function monthlyQueries(month) {
  const prev = shiftMonth(month, -1);
  return {
    current: {from: shiftMonth(month, -12), to: month, asOf: month, basis: 'accrual'},
    previous: {from: prev, to: prev, asOf: prev, basis: 'accrual'},
  };
}

const int = (value) => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);
const sub = (a, b) => (a === null || b === null ? null : a - b);
// 率（bp）。分母が 0 か不明なら null。truncate（0 の向きへ切り捨て）
export function rateBps(numerator, denominator) {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return Number((BigInt(numerator) * 10000n) / BigInt(denominator));
}
// 表示は小数1桁（0.1% 未満は切り捨て）。bp の整数を BigInt で割って出す
export function bpsLabel(bps) {
  if (bps === null) return '—';
  const a = BigInt(bps < 0 ? -bps : bps);
  return `${bps < 0 ? '−' : ''}${a / 100n}.${(a % 100n) / 10n}%`;
}

// 差が基準を超えたか（|差| ≥ 50万円、または |差| ≥ |比べる値|×5%）。浮動小数点を使わず整数で比べる
export function exceedsThreshold(diff, base, {rateBps: limitBps = ISSUE_RATE_BPS, yen = ISSUE_YEN} = {}) {
  if (diff === null || diff === 0) return false;
  const d = BigInt(Math.abs(diff));
  if (d >= BigInt(yen)) return true;
  if (base === null || base === 0) return false;
  return d * 10000n >= BigInt(Math.abs(base)) * BigInt(limitBps);
}

const valueOf = (companyPl, key, month) => {
  const row = companyPl?.rows?.find((r) => r.key === key);
  return row ? int(row.values?.[`m:${month}`]) : null;
};

export function buildMonthlyReport({month, currentBody, previousBody}) {
  if (!isMonth(month)) throw new Error('月は「2026-04」の形で指定してください');
  const prevMonth = shiftMonth(month, -1);
  const lastYearMonth = shiftMonth(month, -12);
  const pl = currentBody?.companyPl || null;
  const notes = [];
  if (!pl) notes.push(currentBody?.companyNote || '会社PLを見る権限がありません');

  const plRows = MONTHLY_PL_ROWS.map((def) => {
    const actual = pl ? valueOf(pl, def.key, month) : null;
    const prev = pl ? valueOf(pl, def.key, prevMonth) : null;
    const lastYear = pl ? valueOf(pl, def.key, lastYearMonth) : null;
    const diffPrev = sub(actual, prev);
    const diffLastYear = sub(actual, lastYear);
    return {...def, actual, prev, lastYear, diffPrev, diffLastYear, ratePrevBps: rateBps(diffPrev, prev), rateLastYearBps: rateBps(diffLastYear, lastYear)};
  });
  const row = (key) => plRows.find((r) => r.key === key);
  const sales = row('total:sales'), gross = row('grossProfit'), op = row('operatingProfit');
  const grossRate = {actual: rateBps(gross.actual, sales.actual), prev: rateBps(gross.prev, sales.prev), lastYear: rateBps(gross.lastYear, sales.lastYear)};
  const kpis = [
    {key: 'sales', label: '売上高', value: sales.actual, diffPrev: sales.diffPrev, type: 'yen'},
    {key: 'gross', label: '粗利', value: gross.actual, diffPrev: gross.diffPrev, type: 'yen'},
    {key: 'grossRate', label: '粗利率', value: grossRate.actual, diffPrev: sub(grossRate.actual, grossRate.prev), type: 'bps'},
    {key: 'operating', label: '営業利益', value: op.actual, diffPrev: op.diffPrev, type: 'yen'},
  ];

  // BS（月末と前の月末）。期首残高の基準月より前などで出せないときは理由を出す
  const bs = currentBody?.companyBs || null, prevBs = previousBody?.companyBs || null;
  let bsRows = [];
  if (!bs) notes.push(currentBody?.companyNote || '会社BSを見る権限がありません');
  else if (bs.unavailable) notes.push(bs.reason);
  else {
    const prevByKey = new Map((prevBs && !prevBs.unavailable ? prevBs.rows : []).map((r) => [r.key, int(r.value)]));
    bsRows = bs.rows.filter((r) => r.section !== 'difference').map((r) => {
      const value = int(r.value), prev = prevByKey.has(r.key) ? prevByKey.get(r.key) : null;
      return {key: r.key, section: r.section, label: r.label, level: r.level, emphasis: !!r.emphasis, value, prev, diff: sub(value, prev), origin: r.origin};
    });
    if (bs.difference) notes.push(`会社BSに説明のつかない差額 ${bs.difference.toLocaleString('ja-JP')}円があります（会社BSのタブの手がかりを見てください）。`);
  }

  // 課題の候補（問い12・13 の A）。PL の行の先月・前年同月との差と、BS の売掛金の増え方から起こす
  const issues = [];
  for (const r of plRows.filter((item) => !item.noIssue)) {
    for (const [against, diff, base, rate] of [['先月', r.diffPrev, r.prev, r.ratePrevBps], ['前年同月', r.diffLastYear, r.lastYear, r.rateLastYearBps]]) {
      if (!exceedsThreshold(diff, base)) continue;
      const worse = r.cost ? diff > 0 : diff < 0;
      issues.push({key: `${r.key}:${against}`, rowKey: r.key, against, label: r.label, diff, rateBps: rate, worse,
        title: `${r.label}が${against}より ${diff > 0 ? '+' : '−'}${Math.abs(diff).toLocaleString('ja-JP')}円（${bpsLabel(rate)}）`});
    }
  }
  const receivable = bsRows.find((r) => r.key === 'receivable');
  if (receivable && exceedsThreshold(receivable.diff, receivable.prev) && receivable.diff > 0) {
    issues.push({key: 'receivable:先月', rowKey: 'receivable', against: '先月', label: receivable.label, diff: receivable.diff, rateBps: rateBps(receivable.diff, receivable.prev), worse: true,
      title: `${receivable.label}が先月末より +${receivable.diff.toLocaleString('ja-JP')}円（回収の遅れがないか）`});
  }
  // 悪い向きの差を先に、額の大きい順
  issues.sort((a, b) => Number(b.worse) - Number(a.worse) || Math.abs(b.diff) - Math.abs(a.diff));

  return {month, prevMonth, lastYearMonth, kpis, grossRate, plRows, bsRows, issues, notes,
    unit: currentBody?.profile?.legalName || null, fiscalConfirmed: currentBody?.conditions?.fiscalConfirmed ?? null};
}

// Excel・印刷のシート（画面と同じ値）。課題の原因・打ち手・期限は画面で書いたものを入れる
export function monthlySheets(report, notesByIssue = {}) {
  const title = `月次の報告 ${monthLabel(report.month)}`;
  const conditions = [['月', monthLabel(report.month)], ['基準', '計上・税抜'], ['比べる相手', `先月（${monthLabel(report.prevMonth)}）・前年同月（${monthLabel(report.lastYearMonth)}）`]];
  const spec = (name, sheetTitle) => ({name, sheetName: name, title: sheetTitle, conditions, notes: report.notes});
  const yenCol = (key, label) => ({key, label, type: 'yen'});
  const plSheet = gridSheetSpec({showTotals: false, columns: [{key: 'label', label: '科目', type: 'text'}, yenCol('actual', '当月'), yenCol('prev', '先月'), yenCol('diffPrev', '先月との差'),
    {key: 'ratePrevBps', label: '先月比', type: 'text', value: (r) => bpsLabel(r.ratePrevBps)}, yenCol('lastYear', '前年同月'), yenCol('diffLastYear', '前年同月との差')], rows: report.plRows, exportSpec: spec('PL', `${title} PL`)});
  const bsSheet = gridSheetSpec({showTotals: false, columns: [{key: 'label', label: '科目', type: 'text'}, yenCol('value', '月末'), yenCol('prev', '前の月末'), yenCol('diff', '増減')], rows: report.bsRows, exportSpec: spec('BS', `${title} BS`)});
  // 出すのは悪い向きの候補と、良い向きでも原因・打ち手を書いたもの
  const issueRows = report.issues.map((issue) => ({...issue, ...(notesByIssue[issue.key] || {})})).filter((issue) => issue.worse || issue.cause || issue.action);
  const issueSheet = gridSheetSpec({showTotals: false, columns: [{key: 'title', label: '差', type: 'text', wrap: true}, {key: 'cause', label: '原因', type: 'text', wrap: true},
    {key: 'action', label: '打ち手', type: 'text', wrap: true}, {key: 'due', label: '期限', type: 'text'}], rows: issueRows, exportSpec: spec('課題', `${title} 課題`)});
  return [plSheet, bsSheet, issueSheet];
}
