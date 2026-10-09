// 商品の作品配賦を画面で % 入力するための純関数。
// サーバーは 1万分率（bp、100% = 10000）で保存する。画面は % で見せ、ここで相互に変換する。

export const FULL_BPS = 10000;

const toHalfWidth = value => String(value ?? '')
  .replace(/[０-９]/g, ch => String('０１２３４５６７８９'.indexOf(ch)))
  .replace(/[．。]/g, '.')
  .replace(/[％]/g, '%');

// 4000 → "40"、3333 → "33.33"、10000 → "100"
export function bpsToPercentText(bps) {
  if (bps === null || bps === undefined || bps === '') return '';
  const n = Math.round(Number(bps));
  if (!Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '', abs = Math.abs(n), whole = Math.floor(abs / 100), rest = abs % 100;
  if (!rest) return `${sign}${whole}`;
  return `${sign}${whole}.${String(rest).padStart(2, '0').replace(/0+$/, '')}`;
}

// "40"・"４０％"・" 33.33 % " → { bps }。小数は2桁まで、0より大きく100以下。
export function parsePercent(text) {
  const normalized = toHalfWidth(text).replace(/\s/g, '').replace(/%$/, '');
  if (!normalized) return { bps: null, error: '配賦率を入力してください' };
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return { bps: null, error: '配賦率は小数2桁までの%で入力してください' };
  const [whole, fraction = ''] = normalized.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (bps <= 0 || bps > FULL_BPS) return { bps: null, error: '配賦率は0%より大きく100%以下にしてください' };
  return { bps, error: null };
}

// サーバーの行（work_id・allocation_bps）と画面の行（workId・allocationBps）のどちらも受け取り、作品順に並べる。
export function normalizeAllocations(list) {
  return (Array.isArray(list) ? list : [])
    .map(row => ({ workId: Number(row.workId ?? row.work_id), allocationBps: Number(row.allocationBps ?? row.allocation_bps) }))
    .sort((a, b) => a.workId - b.workId);
}

export function sameAllocations(a, b) {
  const left = normalizeAllocations(a), right = normalizeAllocations(b);
  return left.length === right.length && left.every((row, index) => row.workId === right[index].workId && row.allocationBps === right[index].allocationBps);
}

// 一覧（bootstrap の productAllocations など）から、1つの商品の配賦だけを取り出す。
export function allocationsForProduct(productAllocations, productId) {
  return normalizeAllocations((productAllocations || []).filter(row => Number(row.product_id ?? row.productId) === Number(productId)));
}

// 既存の配賦を画面の編集行へ。配賦が無い商品は、既定の作品に100%を置く。
export function rowsFromAllocations(allocations, fallbackWorkId) {
  const rows = normalizeAllocations(allocations).map(row => ({ workId: row.workId, percent: bpsToPercentText(row.allocationBps) }));
  if (rows.length) return rows;
  return fallbackWorkId ? [{ workId: Number(fallbackWorkId), percent: '100' }] : [{ workId: '', percent: '100' }];
}

// 画面の編集行を保存用の bp に変換し、行ごとの誤りと合計の誤りを返す。
export function allocationsFromRows(rows) {
  const errors = [], allocations = [], seen = new Set();
  let totalBps = 0;
  (rows || []).forEach((row, index) => {
    const workId = Number(row.workId);
    if (!row.workId || !Number.isInteger(workId) || workId < 1) errors.push({ index, message: '作品を選んでください' });
    else if (seen.has(workId)) errors.push({ index, message: '同じ作品が2回あります。1行にまとめてください' });
    seen.add(workId);
    const parsed = parsePercent(row.percent);
    if (parsed.error) errors.push({ index, message: parsed.error });
    else totalBps += parsed.bps;
    if (!parsed.error && Number.isInteger(workId) && workId > 0) allocations.push({ workId, allocationBps: parsed.bps });
  });
  if (!(rows || []).length) errors.push({ index: null, message: '配賦する作品を1行以上入れてください' });
  else if (!errors.length && totalBps !== FULL_BPS) errors.push({ index: null, message: `合計を100%にしてください（現在 ${bpsToPercentText(totalBps)}%）` });
  return { allocations: errors.length ? [] : normalizeAllocations(allocations), errors, totalBps };
}

// 入力途中でも表示できる合計（読めない行は0として数える）。
export function totalBpsOfRows(rows) {
  return (rows || []).reduce((sum, row) => {
    const parsed = parsePercent(row.percent);
    return sum + (parsed.error ? 0 : parsed.bps);
  }, 0);
}

// 「風のあとさき 40%、別作品 60%」のような要約。
export function describeAllocations(allocations, works) {
  const titles = new Map((works || []).map(work => [Number(work.id), work.title]));
  return normalizeAllocations(allocations)
    .map(row => `${titles.get(row.workId) || '権限外の作品'} ${bpsToPercentText(row.allocationBps)}%`)
    .join('、');
}
