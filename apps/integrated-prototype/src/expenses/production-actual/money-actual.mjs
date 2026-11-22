// 制作の実費の行の金額の式（docs/rules/money.md の「同じ式は1か所の関数で」）。整数の円の足し算と、税込＝税抜＋税額の照らし合わせだけ。
// 税抜・税額を税込から計算する式は持たない（分からないときは「不明」のまま。要件 FR-EXP-PCOST-015・046）。
// 足し算は BigInt で行い、安全な整数を超えたら止める（黙って丸めない）

// 整数の円の和。どれか1つでも安全な整数でなければ、または和が安全な整数を超えれば投げる
export function sumYen(values) {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error('実費の額が整数の円ではありません');
    total += BigInt(value);
  }
  const result = Number(total);
  if (!Number.isSafeInteger(result)) throw new Error('実費の合計が安全な整数を超えました');
  return result;
}

// 税込＝税抜＋税額か（3つとも整数の円のときだけ照らす）
export function taxSplitMatches(incTaxYen, exTaxYen, taxYen) {
  if (![incTaxYen, exTaxYen, taxYen].every(Number.isSafeInteger)) return false;
  return BigInt(exTaxYen) + BigInt(taxYen) === BigInt(incTaxYen);
}
