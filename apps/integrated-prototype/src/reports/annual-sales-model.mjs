// 年間売上（月別推移）の集計。DB に依存しない純関数で、サーバーの帳票 API と試験が使う。
// 入力の明細（line）は作品配賦済み: {id, month（基準の月）, amount（税抜または税込の整数円）, work_id, work_title,
//   partner_id, partner_name, product_id, product_sku, product_name, distribution_code, distribution_label, deal}
// 出力は軸ごとの行（12か月＋四半期・上下期・年度計・構成比・前年計・前年比）と合計、照合結果。

const bigSum = (values) => {
  const n = values.reduce((acc, value) => acc + BigInt(value || 0), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('金額合計が安全な整数範囲外です');
  return Number(n);
};

export const AXES = Object.freeze({
  total: {label: '合計', keys: () => ['total'], labels: () => ['合計']},
  work: {label: '作品別', keys: (l) => [l.work_id], labels: (l) => [l.work_title || '作品未登録']},
  partner: {label: '取引先別', keys: (l) => [l.partner_id], labels: (l) => [l.partner_name || '取引先未登録']},
  distribution: {label: '流通別', keys: (l) => [l.distribution_code], labels: (l) => [l.distribution_label || '未確認']},
  product: {label: '商品別', keys: (l) => [l.product_id ?? 'none'], labels: (l) => [l.product_id ? `${l.product_sku || ''}｜${l.product_name || ''}` : '商品未登録']},
  'partner-distribution': {label: '取引先×流通', keys: (l) => [l.partner_id, l.distribution_code], labels: (l) => [l.partner_name || '取引先未登録', l.distribution_label || '未確認']},
  deal: {label: '取引区分別', keys: (l) => [l.deal || 'unknown'], labels: (l) => [l.deal_label || '未確認']},
});

export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 120) throw new Error('期間は120か月以内にしてください');
  }
  return out;
}

export function shiftMonth(value, delta) {
  const [y, m] = value.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// 期間の月数が12のときだけ四半期・上下期を作る（任意期間では意味がずれるため出さない）
export function periodBuckets(months) {
  if (months.length !== 12) return {quarters: [], halves: []};
  const quarters = [0, 1, 2, 3].map((q) => ({label: `第${q + 1}四半期`, months: months.slice(q * 3, q * 3 + 3)}));
  const halves = [{label: '上期', months: months.slice(0, 6)}, {label: '下期', months: months.slice(6, 12)}];
  return {quarters, halves};
}

const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);

export function buildAnnualSales(lines, {months, axis = 'total', previousLines = [], currentMonth = null}) {
  const def = AXES[axis] || AXES.total;
  const monthIndex = new Map(months.map((month, index) => [month, index]));
  const previousMonths = months.map((month) => shiftMonth(month, -12));
  const previousIndex = new Map(previousMonths.map((month, index) => [month, index]));
  const {quarters, halves} = periodBuckets(months);
  const groups = new Map();
  const ensure = (line) => {
    const keys = def.keys(line);
    const key = JSON.stringify(keys);
    if (!groups.has(key)) {
      const labels = def.labels(line);
      groups.set(key, {key, keys, label: labels.join(' › '), labels, group: axis === 'partner-distribution' ? String(keys[0]) : null,
        groupLabel: axis === 'partner-distribution' ? labels[0] : null, values: months.map(() => []), previous: []});
    }
    return groups.get(key);
  };
  let inPeriod = 0;
  for (const line of lines) {
    const index = monthIndex.get(line.month);
    if (index === undefined) continue;
    ensure(line).values[index].push(line.amount);
    inPeriod += 1;
  }
  for (const line of previousLines) {
    if (!previousIndex.has(line.month)) continue;
    ensure(line).previous.push(line.amount);
  }
  const rows = [...groups.values()].map((group) => {
    const values = group.values.map(bigSum);
    const total = bigSum(values);
    const prevTotal = bigSum(group.previous);
    return {
      key: group.key, keys: group.keys, label: group.label, labels: group.labels, group: group.group, groupLabel: group.groupLabel,
      values, total, prevTotal, yoy: prevTotal ? total / prevTotal - 1 : null,
      quarters: quarters.map((q) => bigSum(q.months.map((m) => values[monthIndex.get(m)]))),
      halves: halves.map((h) => bigSum(h.months.map((m) => values[monthIndex.get(m)]))),
    };
  }).filter((row) => row.total !== 0 || row.prevTotal !== 0 || row.values.some((v) => v !== 0));
  const grand = bigSum(rows.map((row) => row.total));
  for (const row of rows) row.share = ratio(row.total, grand);
  rows.sort((a, b) => (a.group && b.group && a.group !== b.group ? (a.groupLabel || '').localeCompare(b.groupLabel || '', 'ja') : 0)
    || b.total - a.total || a.label.localeCompare(b.label, 'ja'));
  const totalValues = months.map((_, index) => bigSum(rows.map((row) => row.values[index])));
  const prevTotal = bigSum(rows.map((row) => row.prevTotal));
  const totals = {
    values: totalValues, total: grand, prevTotal, yoy: prevTotal ? grand / prevTotal - 1 : null,
    quarters: quarters.map((_, q) => bigSum(rows.map((row) => row.quarters[q]))),
    halves: halves.map((_, h) => bigSum(rows.map((row) => row.halves[h]))),
    cumulative: totalValues.reduce((acc, value) => [...acc, (acc.at(-1) || 0) + value], []),
  };
  // 照合: 帳票の合計（軸ごとの行の和）と、期間内の明細を直接足した額
  const lineTotal = bigSum(lines.filter((line) => monthIndex.has(line.month)).map((line) => line.amount));
  const integrity = {reportTotal: grand, lineTotal, diff: grand - lineTotal, lineCount: inPeriod};
  const future = currentMonth ? months.map((month) => month > currentMonth) : months.map(() => false);
  const subtotals = axis === 'partner-distribution' ? subtotalsByGroup(rows, months.length, quarters.length, halves.length) : [];
  return {axis, axisLabel: def.label, months, previousMonths, quarters: quarters.map((q) => q.label), halves: halves.map((h) => h.label), rows, totals, subtotals, integrity, future};
}

function subtotalsByGroup(rows, monthCount, quarterCount, halfCount) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.group)) map.set(row.group, {group: row.group, label: `${row.groupLabel} 小計`, rows: []});
    map.get(row.group).rows.push(row);
  }
  return [...map.values()].map((entry) => {
    const values = Array.from({length: monthCount}, (_, i) => bigSum(entry.rows.map((row) => row.values[i])));
    const total = bigSum(values);
    const prevTotal = bigSum(entry.rows.map((row) => row.prevTotal));
    return {
      group: entry.group, label: entry.label, values, total, prevTotal, yoy: prevTotal ? total / prevTotal - 1 : null,
      quarters: Array.from({length: quarterCount}, (_, i) => bigSum(entry.rows.map((row) => row.quarters[i]))),
      halves: Array.from({length: halfCount}, (_, i) => bigSum(entry.rows.map((row) => row.halves[i]))),
      share: null,
    };
  });
}

// 帳票の行（key）と月から、その数字を作った明細だけを取り出す
export function drillLines(lines, {axis = 'total', key, month}) {
  const def = AXES[axis] || AXES.total;
  return lines.filter((line) => (!month || line.month === month) && (key === undefined || key === null || key === '' || JSON.stringify(def.keys(line)) === key));
}
