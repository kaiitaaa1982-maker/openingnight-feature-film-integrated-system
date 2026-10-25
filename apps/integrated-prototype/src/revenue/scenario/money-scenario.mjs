// シナリオの比較で使う金額の式（率の連なり・1万円の格子への寄せ・金額の比）。純関数で、DB・時刻・乱数に触れない。
// 率を連ねる式は、BigInt の分子に全部の率を掛け、分母（10000 の k 乗と追加の割る数）で1回だけ truncate する（money.md の「端数の処理は1回だけ」）。
// 格子への寄せは half_up（ちょうど0.5は0から遠ざける）を BigInt の商と余りで行い、Number の Math.round を使わない（Math.round(-2.5) は -2）。

const BPS = 10000n;

function toBig(value, label) {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new Error(`${label}を整数として確認できません`);
  return BigInt(value);
}

function toSafeNumber(value) {
  const out = Number(value);
  if (!Number.isSafeInteger(out)) throw new Error('計算の結果が安全な整数の範囲を超えました');
  return out;
}

// truncate（0に向かって切り捨て）。符号に対して対称
function truncateDiv(numerator, denominator) {
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  return sign * (n / d);
}

// half_up（ちょうど0.5は0から遠ざける）。符号に対して対称
function halfUpDiv(numerator, denominator) {
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  return sign * (r * 2n >= d ? q + 1n : q);
}

// trunc(額 × 率1 × 率2 × … ÷ (10000^k × 割る数))。率は bp の整数、割る数は正の整数（件数_x100 なら 100）
export function rateChain(amount, bpsList, {divisor = 1} = {}) {
  let numerator = toBig(amount, '額');
  let denominator = toBig(divisor, '割る数');
  if (denominator <= 0n) throw new Error('割る数は1以上の整数にしてください');
  for (const bps of bpsList) {
    numerator *= toBig(bps, '率');
    denominator *= BPS;
  }
  return toSafeNumber(truncateDiv(numerator, denominator));
}

// 額を格子の番号（額 ÷ 格子の幅 を half_up）にする。格子の幅は正の整数の円
export function gridIndex(amount, gridYen) {
  const grid = toBig(gridYen, '格子の幅');
  if (grid <= 0n) throw new Error('格子の幅は1円以上にしてください');
  return toSafeNumber(halfUpDiv(toBig(amount, '額'), grid));
}

// 額 ÷ 件数 を truncate（需給の曲線の1作品あたりの平均）。件数が0以下なら null（0円で埋めない）
export function truncateRatio(amount, count) {
  const d = toBig(count, '件数');
  if (d <= 0n) return null;
  return toSafeNumber(truncateDiv(toBig(amount, '額'), d));
}

// 額の比を bp で（分子 × 10000 ÷ 分母 を truncate）。分母が0以下なら null（0% で埋めない）
export function ratioBps(numerator, denominator) {
  const d = toBig(denominator, '分母');
  if (d <= 0n) return null;
  return toSafeNumber(truncateDiv(toBig(numerator, '分子') * BPS, d));
}
