import {labelOf} from './ui/labels.mjs';

// Dates in the catalog are inclusive calendar dates. Compare their ISO form without timezone conversion.
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function monthBounds(year, month) {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) throw Error('年月を確認してください');
  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const end = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
  return {start, end};
}

export function windowOverlapsMonth(row, year, month) {
  const {start, end} = monthBounds(year, month);
  return validDate(row.release_on) && validDate(row.sales_end_on) && row.release_on <= row.sales_end_on && row.release_on <= end && row.sales_end_on >= start;
}

export function isBroadcastType(type) {
  return type?.distribution_name === '放送' || /^broadcast(?:_|$)/.test(type?.code || '');
}

export function broadcastEntries(catalog) {
  const codes = new Set((catalog.types || []).filter(isBroadcastType).map(type => type.code));
  return [
    ...(catalog.windows || []).filter(row => codes.has(row.distribution_code)).map(row => ({...row, scope:'product'})),
    ...(catalog.workWindows || []).filter(row => codes.has(row.distribution_code)).map(row => ({...row, scope:'work'}))
  ];
}

export function monthCell(entries, workId, year, month) {
  const overlapping = entries.filter(row => row.work_id === workId && row.status !== 'withdrawn' && windowOverlapsMonth(row, year, month));
  const confirmed = overlapping.filter(row => row.status === 'confirmed');
  const unconfirmed = overlapping.filter(row => row.status !== 'confirmed');
  return {
    entries: overlapping,
    count: overlapping.length,
    status: overlapping.length > 1 ? 'overlap' : confirmed.length ? 'confirmed' : unconfirmed.length ? 'draft' : 'empty',
    // Multiple rows in one month need review, but do not establish a contractual conflict.
    sameMonthOverlap: overlapping.length > 1
  };
}

// 状態の語彙は labels.mjs の availabilityStatus（条件未確定・条件確認済み・取り下げ）にそろえる。
export function broadcastStatus(row) {
  if (row.status === 'withdrawn') return labelOf('availabilityStatus', 'withdrawn');
  if (!validDate(row.release_on) || !validDate(row.sales_end_on) || row.release_on > row.sales_end_on) return '期間未確認';
  return labelOf('availabilityStatus', row.status === 'confirmed' ? 'confirmed' : 'draft');
}
