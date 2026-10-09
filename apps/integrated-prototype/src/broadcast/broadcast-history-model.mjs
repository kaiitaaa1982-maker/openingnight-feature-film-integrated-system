// 放送履歴表（全作品×年月。セルに局名と状態の注記・実放送の回数）の純関数。ブラウザ・node・Worker 共通。
// 定型業務の「放送ウィンドウ管理表」（放映ウインドウチェック表）と同じ意味の表を、放送枠（作品×月×局・版）と実放送から組み立てる。
// - 既定の期間は今月の11か月前〜12か月後（24か月）。条件（期間・作品・局・同じ月に別の局があるものだけ）は URL に残す
// - セルは生きている放送枠の局名。確定以外は状態（下書き・一次承認待ち・仮押さえ・最終承認待ち・差し戻し。放送枠のタブと同じ語）を付け、
//   実放送があれば「×回数」。中止の枠は出さないが、実放送を記録した中止の枠は「局名（中止）×回数」で出し、実放送の回数・初回放送月にも数える
// - 同じ月の別の局は、確定同士＝赤、申請中・仮押さえを含む＝黄（番販・放送の競合と同じ判定。局名は NFKC で比べる）
// - 画面は120作品で打ち切り、打ち切った件数を返す。Excel は打ち切らない
import {stationKey, isLiveSlot, broadcastConflictMap} from './slot-duplicates.mjs';
import {addMonthsYm, isYm, monthList, monthCount, ymText, dateSlash} from './intervals.mjs';
import {labelOf} from '../ui/labels.mjs';

export const HISTORY_ROW_LIMIT = 120;
export const HISTORY_MAX_MONTHS = 60;
// セルの状態の注記は、放送枠のタブ・承認待ち・Excel の2枚目と同じ呼び名（DOMAINS.broadcastStatus）。確定は注記なし
export const STATUS_NOTES = Object.freeze(Object.fromEntries(['draft', 'pending_first', 'tentative', 'pending_final', 'rejected', 'cancelled']
  .map((status) => [status, labelOf('broadcastStatus', status)]).concat([['confirmed', '']])));
export const CELL_FILLS = Object.freeze({red: 'FFFFC7CE', yellow: 'FFFFEB9C'});
export const HISTORY_PARAMS = Object.freeze({from: 'bhfrom', to: 'bhto', q: 'bhq', station: 'bhst', overlaps: 'bhov'});

const nfkcKey = (value) => String(value ?? '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
export const todayYmJst = (now = new Date()) => new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 7);

// 既定の期間: 今月の11か月前〜12か月後
export function defaultHistoryRange(thisMonth) {
  return {from: addMonthsYm(thisMonth, -11), to: addMonthsYm(thisMonth, 12)};
}

// URL・API の条件を確かめて正規化する。→ {value} か {error}
export function normalizeHistoryQuery(query = {}, thisMonth) {
  const range = defaultHistoryRange(thisMonth);
  const from = query.from ? String(query.from) : range.from;
  const to = query.to ? String(query.to) : range.to;
  if (!isYm(from) || !isYm(to)) return {error: '期間は 2026-10 の形（年-月）で指定してください'};
  if (to < from) return {error: '期間の終わりは始まり以降の月にしてください'};
  if (monthCount(from, to) > HISTORY_MAX_MONTHS) return {error: `期間は${HISTORY_MAX_MONTHS}か月までです`};
  const q = String(query.q ?? '').trim().slice(0, 200);
  const station = String(query.station ?? '').trim().slice(0, 200);
  const overlaps = ['1', 'true', 'on'].includes(String(query.overlaps ?? ''));
  return {value: {from, to, q, station, overlaps}};
}

export function cellEntryText(entry) {
  const note = STATUS_NOTES[entry.status] || '';
  return `${entry.station}${note ? `（${note}）` : ''}${entry.runs ? ` ×${entry.runs}` : ''}`;
}
export const cellText = (cell) => (cell?.entries?.length ? cell.entries.map(cellEntryText).join('／') : '');

// 放送解禁の期間の表示（全作品のウィンドウの放送の種別の最新版）
export function releaseWindowText(window) {
  if (!window) return '未登録';
  if (window.status === 'withdrawn') return '取り下げ';
  const show = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? dateSlash(value) : /^\d{4}-\d{2}$/.test(value || '') ? ymText(value) : value || '');
  if (window.date_precision === 'tbd') return window.timing_raw ? `未定（${window.timing_raw}）` : '未定';
  if (window.date_precision === 'range') return window.timing_raw || '時期未定';
  return `${show(window.start_on)}〜${window.end_on ? show(window.end_on) : ''}${window.status === 'draft' ? '（予定）' : ''}`;
}

// 表の組み立て。
// works: [{id, code, title}]（見られる作品）、slots: 最新版の放送枠（全作品）、airings: [{slot_id, run_count}]、
// products: [{work_id, sku, channel}]、windows: Map(work_id → 放送のウィンドウの版)
// → {months, rows(画面の分・打ち切り後), allRows(条件に合う全部), total, truncated, stations: [{key, label, count}], counts}
export function buildHistoryMatrix({works = [], slots = [], airings = [], products = [], windows = new Map(), filters, limit = HISTORY_ROW_LIMIT}) {
  const months = monthList(filters.from, filters.to);
  const monthSet = new Set(months);
  const runsBySlot = new Map();
  for (const a of airings) runsBySlot.set(a.slot_id, (runsBySlot.get(a.slot_id) || 0) + Number(a.run_count || 0));
  const workIds = new Set(works.map((w) => w.id));
  const mine = slots.filter((s) => workIds.has(s.work_id));
  const live = mine.filter(isLiveSlot);
  // 実放送を記録してから中止にした枠（残りの回の取りやめ）。枠数には数えないが、実放送は表と帳票で数える
  const airedCancelled = mine.filter((s) => s.status === 'cancelled' && runsBySlot.get(s.slot_id));
  const conflicts = broadcastConflictMap(live);
  const byWork = new Map();
  for (const s of live) { if (!byWork.has(s.work_id)) byWork.set(s.work_id, []); byWork.get(s.work_id).push(s); }
  const cancelledByWork = new Map();
  for (const s of airedCancelled) { if (!cancelledByWork.has(s.work_id)) cancelledByWork.set(s.work_id, []); cancelledByWork.get(s.work_id).push(s); }
  const productsOf = new Map();
  for (const p of products.filter((p) => p.channel === 'broadcast')) { if (!productsOf.has(p.work_id)) productsOf.set(p.work_id, []); productsOf.get(p.work_id).push(p.sku); }
  // 局の一覧（期間の中の生きている枠の数）。表示名は最初に出た書き方
  const stationIndex = new Map();
  for (const s of [...live, ...airedCancelled]) {
    if (!monthSet.has(s.broadcast_month)) continue;
    const key = stationKey(s.station_name);
    if (!stationIndex.has(key)) stationIndex.set(key, {key, label: String(s.station_name).trim(), count: 0});
    stationIndex.get(key).count += 1;
  }
  const qKey = nfkcKey(filters.q), stationFilter = filters.station ? stationKey(filters.station) : '';
  const sortedWorks = [...works].sort((a, b) => String(a.code).localeCompare(String(b.code), 'ja') || a.id - b.id);
  const all = [];
  for (const work of sortedWorks) {
    if (qKey && !nfkcKey(work.code).includes(qKey) && !nfkcKey(work.title).includes(qKey)) continue;
    const own = (byWork.get(work.id) || []).sort((a, b) => a.broadcast_month.localeCompare(b.broadcast_month) || a.slot_id - b.slot_id);
    const allOwn = [...own, ...(cancelledByWork.get(work.id) || [])].sort((a, b) => a.broadcast_month.localeCompare(b.broadcast_month) || a.slot_id - b.slot_id);
    const cells = {};
    let red = 0, yellow = 0, hasStation = !stationFilter;
    for (const s of allOwn) {
      if (!monthSet.has(s.broadcast_month)) continue;
      if (!cells[s.broadcast_month]) cells[s.broadcast_month] = {entries: [], color: null};
      const cell = cells[s.broadcast_month];
      cell.entries.push({slotId: s.slot_id, station: String(s.station_name).trim(), stationKey: stationKey(s.station_name), status: s.status, runs: runsBySlot.get(s.slot_id) || 0});
      const color = conflicts.get(s.slot_id);
      if (color === 'red' || (color === 'yellow' && cell.color !== 'red')) cell.color = color;
      if (stationFilter && stationKey(s.station_name) === stationFilter) hasStation = true;
    }
    for (const cell of Object.values(cells)) { if (cell.color === 'red') red += 1; else if (cell.color === 'yellow') yellow += 1; cell.text = cellText(cell); }
    if (!hasStation) continue;
    if (filters.overlaps && !red && !yellow) continue;
    const confirmedMonths = allOwn.filter((s) => s.status === 'confirmed' || runsBySlot.get(s.slot_id)).map((s) => s.broadcast_month).sort();
    const skus = (productsOf.get(work.id) || []).sort();
    all.push({
      work_id: work.id, work_code: work.code, work_title: work.title,
      product_skus: skus.length > 1 ? `${skus[0]} ほか${skus.length - 1}件` : skus[0] || '',
      release_window: releaseWindowText(windows.get(work.id)),
      slot_count: own.length,
      aired_runs: allOwn.reduce((n, s) => n + (runsBySlot.get(s.slot_id) || 0), 0),
      first_month: confirmedMonths[0] || '',
      cells, red, yellow,
    });
  }
  all.forEach((row, index) => { row.no = index + 1; });
  const rows = all.slice(0, limit);
  return {
    months, rows, allRows: all, total: all.length, truncated: Math.max(0, all.length - rows.length),
    stations: [...stationIndex.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ja')),
    counts: {red: all.reduce((n, r) => n + r.red, 0), yellow: all.reduce((n, r) => n + r.yellow, 0), works: all.length},
  };
}

// ---- Excel ----------------------------------------------------------------------------------
const monthColumn = (ym) => ({key: `m:${ym}`, label: ymText(ym), type: 'text', width: 14, wrap: true});
export const HISTORY_FIXED_COLUMNS = Object.freeze([
  {key: 'no', label: '通し番号', type: 'int', width: 8},
  {key: 'work_code', label: '作品コード', type: 'code'},
  {key: 'work_title', label: '作品名', type: 'text', width: 28},
  {key: 'product_skus', label: '放送用の品番', type: 'code'},
  {key: 'release_window', label: '放送解禁の期間', type: 'text', width: 24},
  {key: 'slot_count', label: '枠数', type: 'int', width: 8},
  {key: 'aired_runs', label: '実放送の回数', type: 'int', width: 10},
  {key: 'first_month', label: '初回放送月', type: 'text', width: 11, exportValue: (row) => (row.first_month ? ymText(row.first_month) : '')},
]);

// Excel の2枚。1枚目「放送履歴表」は作品の属性の列＋年月の列（前の月と同じ内容なら「〃」、期間の先頭の列は局名）と赤・黄の塗り、
// 2枚目「放送枠一覧」は縦長（作品×月×局の1枠1行）
export function historySheets(matrix, {conditions = [], dataAsOf, slots = [], airings = [], partners = []} = {}) {
  const columns = [...HISTORY_FIXED_COLUMNS, ...matrix.months.map(monthColumn)];
  const rows = matrix.allRows.map((row) => {
    const out = {...row};
    matrix.months.forEach((ym, index) => {
      const text = row.cells[ym]?.text || '';
      const previous = index > 0 ? row.cells[matrix.months[index - 1]]?.text || '' : '';
      out[`m:${ym}`] = text && index > 0 && text === previous ? '〃' : text;
    });
    return out;
  });
  const cellFill = (row, column) => {
    if (!column.key.startsWith('m:')) return null;
    const color = row.cells?.[column.key.slice(2)]?.color;
    return color ? CELL_FILLS[color] : null;
  };
  const names = new Map(partners.map((p) => [p.id, p.name]));
  const runs = new Map();
  for (const a of airings) runs.set(a.slot_id, (runs.get(a.slot_id) || 0) + Number(a.run_count || 0));
  const workOf = new Map(matrix.allRows.map((row) => [row.work_id, row]));
  const monthSet = new Set(matrix.months);
  const conflicts = broadcastConflictMap(slots.filter(isLiveSlot));
  const list = slots.filter((s) => (isLiveSlot(s) || runs.get(s.slot_id)) && workOf.has(s.work_id) && monthSet.has(s.broadcast_month))
    .sort((a, b) => String(workOf.get(a.work_id).work_code).localeCompare(String(workOf.get(b.work_id).work_code), 'ja') || a.broadcast_month.localeCompare(b.broadcast_month) || a.slot_id - b.slot_id)
    .map((s) => ({
      work_code: workOf.get(s.work_id).work_code, work_title: workOf.get(s.work_id).work_title, broadcast_month: s.broadcast_month, station_name: s.station_name,
      status: s.status, period_from: s.period_from, period_to: s.period_to, planned_runs: s.planned_runs, aired_runs: runs.get(s.slot_id) || 0,
      customer: names.get(s.customer_partner_id) || '', agency: names.get(s.agency_partner_id) || '',
      conflict: conflicts.get(s.slot_id) === 'red' ? '競合（確定同士の別局）' : conflicts.get(s.slot_id) === 'yellow' ? '注意（申請中・仮押さえの別局）' : '',
      source_reference: s.source_reference || '', slot_id: s.slot_id, revision: s.revision,
    }));
  return [
    {name: '放送履歴表', title: '放送履歴表', conditions, dataAsOf, columns, rows, freezeCols: 3, cellFill, paperSize: 'A3',
      notes: ['セルは放送枠の局名。確定以外は（下書き）（一次承認待ち）（仮押さえ）（最終承認待ち）（差し戻し）を付ける（2枚目「放送枠一覧」の状態と同じ語）。「×回数」は実放送の記録。中止の枠は出さない（実放送がある中止の枠は「局名（中止）×回数」で出す）。',
        '「〃」は前の月と同じ内容。赤は確定同士で同じ月に別の局、黄は申請中・仮押さえを含む同じ月の別の局。',
        '出典: 番販・放送の放送枠と実放送（DB が正本。この表は読むだけ）。']},
    {name: '放送枠一覧', title: '放送枠一覧', conditions, dataAsOf, freezeCols: 2, rows: list, columns: [
      {key: 'work_code', label: '作品コード', type: 'code'}, {key: 'work_title', label: '作品名', type: 'text', width: 28},
      {key: 'broadcast_month', label: '放送月', type: 'month'}, {key: 'station_name', label: '放送局', type: 'text'},
      {key: 'status', label: '状態', type: 'status', domain: 'broadcastStatus'},
      {key: 'period_from', label: '期間開始', type: 'date'}, {key: 'period_to', label: '期間終了', type: 'date'},
      {key: 'planned_runs', label: '予定回数', type: 'int'}, {key: 'aired_runs', label: '実放送の回数', type: 'int'},
      {key: 'customer', label: '取引先', type: 'text'}, {key: 'agency', label: '代理店', type: 'text'},
      {key: 'conflict', label: '競合', type: 'text'}, {key: 'source_reference', label: '根拠', type: 'text', wrap: true},
      {key: 'slot_id', label: '放送枠ID', type: 'id'}, {key: 'revision', label: '版', type: 'int'},
    ]},
  ];
}
