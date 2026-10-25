// 需給予測の曲線（段A）: 売上明細から、窓口（流通区分。無ければ報告の種類。sales/channel-group.mjs の channelGroup）×公開からの月数ごとの
// 1作品あたりの平均の売上（税抜）を、読むたびに集計する。表を足さない。純関数で、DB・時刻・乱数に触れない。
// 計画: 会社ルートの plans/2026-10-09-sales-producer-kpi.md の「需給予測」。起点は作品の公開月（loadPlBsInput の works[].releaseMonth。
// 劇場公開の確定の版か、無ければ最初の売上月）。窓口ごとの起点（catalog_product_windows の確定の版）は段B #11。
// - 平均＝その窓口×月数の売上の和 ÷ その月数まで観測できた作品の数（公開月＋月数 が締めた月以前で、その窓口に公開後の売上がある作品）。truncate
// - 公開月の無い作品の行・公開月より前の行・締めた月より後の行は曲線に入れず、件数を出す
// - 元の行が無い窓口は「曲線なし」（status: no_curve）。配るときは均等に配る（fallback: even。段A は配らない）
import {CHANNEL_GROUPS, CHANNEL_LABELS} from '../../sales/channel-group.mjs';
import {truncateRatio} from './money-scenario.mjs';

export const DEMAND_CURVE_VERSION = 'demand-curve.2026-10-10';

const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

// works: [{id, releaseMonth, releaseSource}]、saleLines: [{workId, month, amount, channelGroup}]、throughMonth: 締めた月
export function demandCurve({works, saleLines, throughMonth}) {
  const last = monthIndex(throughMonth);
  const release = new Map();
  const releaseSources = {window: 0, first_sale: 0, none: 0, after_close: 0};
  for (const work of works) {
    if (!work.releaseMonth) {
      releaseSources.none += 1;
      continue;
    }
    const index = monthIndex(work.releaseMonth);
    if (index > last) {
      releaseSources.after_close += 1;
      continue;
    }
    releaseSources[work.releaseSource === 'window' ? 'window' : 'first_sale'] += 1;
    release.set(work.id, index);
  }
  const excluded = {afterCloseLines: 0, noReleaseLines: 0, beforeReleaseLines: 0};
  const cells = new Map();
  for (const line of saleLines) {
    const month = monthIndex(line.month);
    if (month > last) {
      excluded.afterCloseLines += 1;
      continue;
    }
    if (!release.has(line.workId)) {
      excluded.noReleaseLines += 1;
      continue;
    }
    const offset = month - release.get(line.workId);
    if (offset < 0) {
      excluded.beforeReleaseLines += 1;
      continue;
    }
    const channel = CHANNEL_GROUPS.includes(line.channelGroup) ? line.channelGroup : 'other';
    if (!cells.has(channel)) cells.set(channel, {works: new Set(), lines: 0, sums: new Map()});
    const cell = cells.get(channel);
    cell.works.add(line.workId);
    cell.lines += 1;
    cell.sums.set(offset, (cell.sums.get(offset) || 0) + line.amount);
  }
  const channels = CHANNEL_GROUPS.map((channel) => {
    const cell = cells.get(channel);
    if (!cell) return {channel, label: CHANNEL_LABELS[channel], status: 'no_curve', fallback: 'even', workCount: 0, lineCount: 0, points: []};
    const top = Math.max(...cell.sums.keys());
    const points = [];
    for (let offset = 0; offset <= top; offset++) {
      // その月数まで観測できた作品（公開月＋月数が締めた月以前）
      const observed = [...cell.works].filter((workId) => release.get(workId) + offset <= last).length;
      const sumYen = cell.sums.get(offset) || 0;
      points.push({offset, workCount: observed, sumYen, averageYen: truncateRatio(sumYen, observed)});
    }
    return {channel, label: CHANNEL_LABELS[channel], status: 'curve', fallback: null, workCount: cell.works.size, lineCount: cell.lines, points};
  });
  return {
    definitionVersion: DEMAND_CURVE_VERSION,
    origin: 'release_month',
    throughMonth,
    workCount: new Set([...cells.values()].flatMap((cell) => [...cell.works])).size,
    lineCount: [...cells.values()].reduce((n, cell) => n + cell.lines, 0),
    releaseSources,
    // 作品ごとの公開月と出どころ（window＝劇場公開の確定の版、first_sale＝最初の売上月、null＝どちらも無い）
    releases: [...works].sort((a, b) => a.id - b.id).map((work) => ({workId: work.id, releaseMonth: work.releaseMonth ?? null, releaseSource: work.releaseSource ?? null})),
    excluded,
    channels,
  };
}
