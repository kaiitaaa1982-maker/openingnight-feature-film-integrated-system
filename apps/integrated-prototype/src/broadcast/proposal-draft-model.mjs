// 放送ウィンドウ提案から放送枠の下書きを作るときの決まり（純関数。ブラウザ・node・Worker 共通）。
// 設計: docs/platform/team-development/broadcast-windows.md §9。
// - 選べる月は、その行の「提案する期間」と重なる月だけ（基準日から24か月の中）。独占・ホールドバックで塞がっている月、
//   放送してよい期間の外の月は選べず、理由を返す。月の一部だけが提案する期間なら、放送枠の期間はその重なり（例 9/25〜9/30）
// - 1か月の中に提案する期間が2つあるとき（途中が塞がっている）は、長いほう（同じ長さなら早いほう）を放送枠の期間にする
// - 放送枠は 作品×月×局 で1つ。同じ作品・月・局の生きている枠（中止以外）があれば、その月は作れない（二重登録）
import {interval, intersect, overlaps, monthList, monthStart, monthEnd, ymOf, ymText, intervalText, dateSlash, isYm, addMonthsYm} from './intervals.mjs';
import {stationKey, isLiveSlot} from './slot-duplicates.mjs';

export const DRAFT_RUN_KINDS = Object.freeze({first: '初回', rerun: '再放送'});
export const DRAFT_MAX_MONTHS = 24;
export const DELETED_LABEL = '削除（合意に至らず）';
const RUN_OF_TEXT = Object.freeze({初回: 'first', 再放送: 'rerun'});
export const runKindOf = (text) => RUN_OF_TEXT[text] || 'first';

const dayCount = (i) => Math.round((Date.parse(`${i.to}T00:00:00Z`) - Date.parse(`${i.from}T00:00:00Z`)) / 86400000) + 1;

// その月が選べない理由（独占・ホールドバック・放送してよい期間の外）
export function monthBlockReason(result, ym) {
  if (!result || result.state === 'blocked') return '提案なし（要確認の理由を見てください）';
  const month = interval(monthStart(ym), monthEnd(ym));
  const reasons = (result.blocked || []).filter((b) => overlaps(b, month)).map((b) => (b.kind === 'holdback'
    ? `ホールドバック（${b.station}・${b.months}か月・${intervalText(b)}）`
    : `独占契約中（${b.station}${b.planned ? '・予定' : ''}・${intervalText(b)}）`));
  if (reasons.length) return reasons.join('・');
  if (!(result.allowed || []).some((a) => overlaps(a, month))) return '放送してよい期間の外（権利・放送の解禁・販売条件）';
  return '提案する期間の外';
}

// 選べる月と選べない月（理由つき）。result は proposeWindow の結果（horizon・proposals・blocked・allowed）
export function proposalMonthOptions(result) {
  const months = [], blocked = [];
  const horizon = result?.horizon;
  if (!horizon?.from || !horizon?.to) return {months, blocked};
  for (const ym of monthList(ymOf(horizon.from), ymOf(horizon.to))) {
    const month = interval(monthStart(ym), monthEnd(ym));
    const hits = (result.state === 'ok' ? result.proposals || [] : [])
      .map((proposal) => ({proposal, hit: intersect(proposal, month)})).filter((x) => x.hit && x.hit.from && x.hit.to);
    if (!hits.length) { blocked.push({month: ym, reason: monthBlockReason(result, ym)}); continue; }
    const best = hits.reduce((a, b) => (dayCount(b.hit) > dayCount(a.hit) ? b : a));
    months.push({
      month: ym, from: best.hit.from, to: best.hit.to, whole: best.hit.from === month.from && best.hit.to === month.to,
      split: hits.length > 1, run: best.proposal.run, short: Boolean(best.proposal.short),
      proposal: {from: best.proposal.from, to: best.proposal.to},
      // 同時期の他局は、この月に重なるものだけ（放送枠はその月、契約は期間で比べる）
      others: (best.proposal.others || []).filter((o) => (o.month ? o.month === ym : overlaps(interval(o.from, o.to), month))),
    });
  }
  return {months, blocked};
}

// 選べない月を、続く月で理由が同じものごとにまとめる（画面の案内）→ [{from, to, reason, text}]
export function groupBlockedMonths(blocked) {
  const out = [];
  for (const b of Array.isArray(blocked) ? blocked : []) {
    const last = out.at(-1);
    if (last && last.reason === b.reason && addMonthsYm(last.to, 1) === b.month) last.to = b.month;
    else out.push({from: b.month, to: b.month, reason: b.reason});
  }
  return out.map((g) => ({...g, text: `${g.from === g.to ? ymText(g.from) : `${ymText(g.from)}〜${ymText(g.to)}`}：${g.reason}`}));
}

// 画面の月の選択肢の文（例「2026年9月（9/25〜9/30）」「2026年10月」）
export function monthOptionLabel(option) {
  const days = option.whole ? '' : `（${Number(option.from.slice(5, 7))}/${Number(option.from.slice(8, 10))}〜${Number(option.to.slice(5, 7))}/${Number(option.to.slice(8, 10))}${option.split ? '・月の途中に塞がる期間あり' : ''}）`;
  return `${ymText(option.month)}${days}`;
}

// 登録の前の確かめ。months: ['2026-11', …]（1〜24・重ならない）→ {accepted: [選べる月の option], errors: [{month, message}]}
export function checkDraftMonths(result, months) {
  if (!Array.isArray(months) || !months.length) return {accepted: [], errors: [{month: null, message: '放送する月を1つ以上選んでください'}]};
  if (months.length > DRAFT_MAX_MONTHS) return {accepted: [], errors: [{month: null, message: `放送する月は${DRAFT_MAX_MONTHS}か月までです`}]};
  const {months: options, blocked} = proposalMonthOptions(result);
  const byMonth = new Map(options.map((o) => [o.month, o]));
  const reasonOf = new Map(blocked.map((b) => [b.month, b.reason]));
  const accepted = [], errors = [], seen = new Set();
  for (const raw of months) {
    const ym = String(raw ?? '');
    if (!isYm(ym)) { errors.push({month: ym, message: `放送する月は 2026-11 の形で選んでください（${ym || '空欄'}）`}); continue; }
    if (seen.has(ym)) { errors.push({month: ym, message: `${ymText(ym)}が2回選ばれています`}); continue; }
    seen.add(ym);
    const option = byMonth.get(ym);
    if (option) { accepted.push(option); continue; }
    const reason = reasonOf.get(ym) || `提案の範囲（基準日から24か月・${intervalText(result?.horizon)}）の外`;
    errors.push({month: ym, message: `${ymText(ym)}は提案する期間の外なので選べません（${reason}）`});
  }
  accepted.sort((a, b) => a.month.localeCompare(b.month));
  return {accepted, errors};
}

// その局の生きている枠がある月（二重登録になる月）。slots: [{slot_id, month|broadcast_month, station|station_name, status}]
export function duplicateMonths(slots, stationName) {
  const key = stationKey(stationName);
  const out = new Map();
  if (!key) return out;
  for (const s of Array.isArray(slots) ? slots : []) {
    const station = s.station ?? s.station_name, month = s.month ?? s.broadcast_month;
    if (isLiveSlot(s) && stationKey(station) === key && !out.has(month)) out.set(month, s);
  }
  return out;
}

// 放送枠の「根拠」（source_reference）に残す一文
export const draftSourceReference = ({asOf, option}) => `放送ウィンドウ提案（基準日 ${dateSlash(asOf)}・提案する期間 ${intervalText(option.proposal)}）`;
// 放送枠の「理由」（reason）に残す一文
export const draftReason = ({runKind, memo}) => `放送ウィンドウ提案から下書き（${DRAFT_RUN_KINDS[runKind] || '初回'}）${memo ? `：${memo}` : ''}`.slice(0, 1000);
// 提案の記録に残す根拠（提案する期間・放送してよい期間の根拠・塞がっている期間。4000文字まで）
export function draftBasisText(result, option) {
  const lines = [
    `提案する期間: ${intervalText(option.proposal)}${option.short ? '（短い）' : ''}`,
    `この月の放送枠の期間: ${intervalText({from: option.from, to: option.to})}`,
    ...(result.basis || []),
    ...(result.blocked || []).map((b) => `塞がっている期間: ${intervalText(b)} ${b.station}（${b.kind === 'holdback' ? `ホールドバック ${b.months}か月` : '独占'}${b.planned ? '・予定' : ''}）`),
    ...(option.others.length ? [`同時期の他局: ${[...new Set(option.others.map((o) => o.station))].join('・')}`] : []),
  ];
  const text = lines.join('\n');
  return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
}

// 一覧の状態の表示（削除は「削除（合意に至らず）」、ほかは放送枠の状態の呼び名）
export const draftStatusText = (row, labelOf) => (row.deleted ? DELETED_LABEL : labelOf('broadcastStatus', row.status));

// 提案から作った下書きの件数の一文。counts は GET /api/broadcast/window-proposals/drafts の counts
// （下書き・申請中〜確定・差し戻し・中止・削除した下書き。差し戻しと中止は0件なら省く）
export function draftCountsText(counts) {
  if (!counts) return '';
  const parts = [`下書き ${counts.drafts ?? 0}件`, `申請中〜確定 ${counts.inFlow ?? 0}件`];
  if (counts.rejected) parts.push(`差し戻し ${counts.rejected}件`);
  if (counts.cancelled) parts.push(`中止 ${counts.cancelled}件`);
  parts.push(`削除した下書き ${counts.deleted ?? 0}件`);
  return parts.join('・');
}
