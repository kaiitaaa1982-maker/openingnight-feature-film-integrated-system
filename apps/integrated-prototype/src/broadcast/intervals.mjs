// 日付の区間の計算（純関数。ブラウザ・node・Worker 共通）。区間は {from, to}（ISO の日付・両端を含む）。
// from が null は「始まりが無い（ずっと前から）」、to が null は「終わりが無い（ずっと先まで）」。
// 月の足し算は月末にそろえる（2028-02-29 の24か月後は 2030-02-28、1月31日の1か月後は2月の末日）。
// 日付は 9999-12-31 で止める（「終わりなし」の番兵に使う日。その先の日付は作らない）。

const pad = (n) => String(n).padStart(2, '0');
export const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isYm = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));
export const lastDayOfMonth = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
export const monthStart = (ym) => `${ym}-01`;
export const monthEnd = (ym) => `${ym}-${pad(lastDayOfMonth(ym))}`;
export const ymOf = (iso) => String(iso).slice(0, 7);

export const MAX_DATE = '9999-12-31';
const MAX_TIME = Date.UTC(9999, 11, 31);
export function addDays(iso, n) {
  const t = Date.parse(`${iso}T00:00:00Z`) + n * 86400000;
  if (!(t <= MAX_TIME)) return MAX_DATE; // 9999-12-31 より先（と読めない日付）は 9999-12-31 で止める
  return new Date(t).toISOString().slice(0, 10);
}
export function addMonthsYm(ym, n) {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}
const monthIndex = (ym, n = 0) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
// 日付の n か月後（月末にそろえる。9999年より先は 9999-12-31）
export function addMonthsDate(iso, n) {
  if (Math.floor(monthIndex(ymOf(iso), n) / 12) > 9999) return MAX_DATE;
  const ym = addMonthsYm(ymOf(iso), n);
  return `${ym}-${pad(Math.min(Number(iso.slice(8, 10)), lastDayOfMonth(ym)))}`;
}
// from から n か月の期間の最後の日（民法143条と同じ数え方: 応当日の前日。応当日が無ければその月の末日）。
// 2027-01-31 から1か月は 2027-02-28、2026-10-01 から3か月は 2026-12-31
export function monthsPeriodEnd(from, n) {
  if (Math.floor(monthIndex(ymOf(from), n) / 12) > 9999) return MAX_DATE;
  const ym = addMonthsYm(ymOf(from), n);
  const day = Number(from.slice(8, 10));
  return day > lastDayOfMonth(ym) ? monthEnd(ym) : addDays(`${ym}-${pad(day)}`, -1);
}
// from〜to（YYYY-MM）の月の並び（両端を含む）
export function monthList(from, to) {
  const out = [];
  for (let ym = from; ym <= to && out.length < 1200; ym = addMonthsYm(ym, 1)) out.push(ym);
  return out;
}
export const monthCount = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

const lo = (value) => (value === null || value === undefined ? '0000-01-01' : value);
const hi = (value) => (value === null || value === undefined ? '9999-12-31' : value);
const back = (value, edge) => (value === edge ? null : value);

export const interval = (from = null, to = null) => ({from: from || null, to: to || null});
export const isEmpty = (i) => hi(i.to) < lo(i.from);

// 2つの区間の重なり（無ければ null）
export function intersect(a, b) {
  const from = lo(a.from) > lo(b.from) ? lo(a.from) : lo(b.from);
  const to = hi(a.to) < hi(b.to) ? hi(a.to) : hi(b.to);
  return to < from ? null : {from: back(from, '0000-01-01'), to: back(to, '9999-12-31')};
}
export const overlaps = (a, b) => intersect(a, b) !== null;

// 並べて、重なる・隣り合う区間をつなぐ
export function normalize(list) {
  const sorted = (Array.isArray(list) ? list : []).filter((i) => i && !isEmpty(i)).map((i) => ({from: i.from || null, to: i.to || null}))
    .sort((a, b) => (lo(a.from) < lo(b.from) ? -1 : lo(a.from) > lo(b.from) ? 1 : 0));
  const out = [];
  for (const item of sorted) {
    const last = out.at(-1);
    if (last && (last.to === null || lo(item.from) <= addDays(hi(last.to), 1))) {
      if (last.to !== null && (item.to === null || item.to > last.to)) last.to = item.to;
    } else out.push({...item});
  }
  return out;
}
// 区間の並びどうしの重なり（どちらも normalize してから）
export function intersectLists(a, b) {
  const out = [];
  for (const x of normalize(a)) for (const y of normalize(b)) { const hit = intersect(x, y); if (hit) out.push(hit); }
  return normalize(out);
}
// list から blocks を引く
export function subtract(list, blocks) {
  let rest = normalize(list);
  for (const block of normalize(blocks)) {
    const next = [];
    for (const item of rest) {
      if (!overlaps(item, block)) { next.push(item); continue; }
      if (lo(item.from) < lo(block.from)) next.push({from: item.from, to: addDays(block.from, -1)});
      if (block.to !== null && hi(item.to) > block.to) next.push({from: addDays(block.to, 1), to: item.to});
    }
    rest = normalize(next);
  }
  return rest;
}
// 区間の長さが min か月に満たないか（開いた区間は満たす。期間の満了は応当日の前日、応当日が無ければ末日）
export function shorterThanMonths(i, months) {
  if (i.from === null || i.to === null) return false;
  return monthsPeriodEnd(i.from, months) > i.to;
}
// 表示: 2026/10/01〜2027/09/30、開いた端は「〜」だけ
export const dateSlash = (iso) => (iso ? iso.replaceAll('-', '/') : '');
export function intervalText(i) {
  if (!i) return '';
  if (i.from === null && i.to === null) return '期間の定めなし';
  return `${i.from ? dateSlash(i.from) : ''}〜${i.to ? dateSlash(i.to) : '（終わりなし）'}`;
}
export const ymText = (ym) => `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月`;
export const dateKanji = (iso) => `${iso.slice(0, 4)}年${Number(iso.slice(5, 7))}月${Number(iso.slice(8, 10))}日`;
