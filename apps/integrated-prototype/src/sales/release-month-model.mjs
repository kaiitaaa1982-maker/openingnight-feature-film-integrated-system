// 流通別の販売条件の月別表示（純関数）。選んだ月に「解禁するもの」「販売を終えるもの」「月をまたいで販売中のもの」を分ける。
// 日付が未確認（null）の条件は推測で月に入れず、「日付が未確認」にまとめる。

const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
export const shiftMonth = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

// rows: catalogGridRows の condition 行（release_on・sales_end_on・status）
export function releaseMonthGroups(rows = [], month) {
  const start = `${month}-01`;
  const end = `${month}-${String(lastDay(month)).padStart(2, '0')}`;
  const live = rows.filter((row) => row.status !== 'withdrawn');
  const starting = live.filter((row) => row.release_on && row.release_on >= start && row.release_on <= end);
  const ending = live.filter((row) => row.sales_end_on && row.sales_end_on >= start && row.sales_end_on <= end);
  const continuing = live.filter((row) => row.release_on && row.release_on < start && (!row.sales_end_on || row.sales_end_on > end));
  const undated = live.filter((row) => !row.release_on);
  const byDate = (key) => (a, b) => String(a[key]).localeCompare(String(b[key])) || String(a.work_title).localeCompare(String(b.work_title), 'ja');
  return {
    month,
    starting: starting.sort(byDate('release_on')),
    ending: ending.sort(byDate('sales_end_on')),
    continuing: continuing.sort(byDate('release_on')),
    undated,
    withdrawn: rows.length - live.length,
  };
}
