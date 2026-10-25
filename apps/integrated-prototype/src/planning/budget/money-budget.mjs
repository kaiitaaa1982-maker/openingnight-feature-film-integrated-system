// 予算書の金額の式（docs/rules/money.md。BigInt で商を出し、0に向かって切り捨てる）。
// 消費税（総合計×税率）・単価×数量（数量は千分の一の整数）・前の版からの増減の比（bp）
export function taxFromBps(yen, bps) {
  if (!Number.isSafeInteger(yen) || !Number.isSafeInteger(bps)) throw new Error('金額または税率を整数として確認できません');
  return Number(BigInt(yen) * BigInt(bps) / 10000n);
}

export function unitPriceTimesQty(unitPriceYen, qtyMilli) {
  if (!Number.isSafeInteger(unitPriceYen) || !Number.isSafeInteger(qtyMilli)) throw new Error('単価または数量を整数として確認できません');
  return Number(BigInt(unitPriceYen) * BigInt(qtyMilli) / 1000n);
}

export function changeInBps(diffYen, baseYen) {
  if (!Number.isSafeInteger(diffYen) || !Number.isSafeInteger(baseYen) || baseYen <= 0) return null;
  return Number(BigInt(diffYen) * 10000n / BigInt(baseYen));
}
