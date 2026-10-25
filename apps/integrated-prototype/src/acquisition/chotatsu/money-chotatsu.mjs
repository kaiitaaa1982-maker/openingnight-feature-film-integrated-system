// 調達の金額の式（docs/rules/money.md）。BigInt で計算し、端数の処理を名前で選ぶ
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function toSafeYen(big) {
  if (big > MAX_SAFE || big < -MAX_SAFE) throw new Error('金額が大きすぎます');
  return Number(big);
}

// 額×率（bp）の1円未満を切り捨てる（権利料の率。FR-PLAN-ACQ-045 と同じ既定の切り捨て）
export function rateAmountFloor(amountYen, rateBps) {
  return (BigInt(amountYen) * BigInt(rateBps)) / 10000n;
}
