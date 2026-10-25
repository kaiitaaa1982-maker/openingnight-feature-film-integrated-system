// 行動指標（行動指標の計画 段B）で使う金額の比の式。純関数で、DB・時刻・乱数に触れない（docs/rules/money.md の「同じ式は1か所の関数で」）。
// 比は BigInt の商で1回だけ truncate（0に向かって切り捨て）する。端数の処理は要件 kpi-scenario-forecast.md の要確認10 で代表が確かめるまでの仮。
// 段A（core #109）の src/revenue/scenario/money-scenario.mjs の ratioBps が同じ式を尺度 10000 で持つ（切り捨ての向きと、分母0以下で null も同じ）。
// 段A と段B #8 のうち後から main に入れる PR で、尺度を引数に取る1つの関数に寄せる（片方だけのいまは寄せる先が無い）

function toBig(value, label) {
  if (!Number.isSafeInteger(value)) throw new Error(`${label}を整数の円として確認できません`);
  return BigInt(value);
}

// 額の比を100倍の整数で（分子 × 100 ÷ 分母 を truncate。符号に対して対称）。分母が0以下なら null（割れない値を0倍で埋めない）
export function ratioX100(numerator, denominator) {
  const d = toBig(denominator, '分母');
  if (d <= 0n) return null;
  const n = toBig(numerator, '分子') * 100n;
  const q = (n < 0n ? -n : n) / d;
  const out = Number(n < 0n ? -q : q);
  if (!Number.isSafeInteger(out)) throw new Error('比が安全な整数の範囲を超えました');
  return out;
}
