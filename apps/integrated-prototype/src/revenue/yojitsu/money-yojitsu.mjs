// 案件収支の予実（4段）で使う金額・件数・比の式（フェーズ1の仕様書 #14）。純関数で、DB・時刻・乱数に触れない。
// 端数の処理は式ごとに1回だけ名前で選ぶ（docs/rules/money.md。BigInt の分子と分母を持ってから割る）:
// - 料率の額（売上率・確度を掛けた額）は truncate（FR-SETL-ACCR-009 と同じ。要件 FR-REV-YOJITSU-004）。率を連ねる式は全部の率を分子に掛け、1回だけ割る
// - 比（達成率・進み）は bps の truncate（要件の要確認11 の仮。決まるまで truncate）。分母が0以下か、どちらかが null なら null（0% で埋めない）
// - 行動の目標件数の逆算は ceil（K-19。整数の bps で割り、小数の誤差で1件多くならない）
// 同じ式（rateChain・ratioBps）は行動指標の計画の段A（src/revenue/scenario/money-scenario.mjs。core PR #109）にもある。両方が main に入ったら1つに寄せる

const BPS = 10000n;

function toBig(value, label) {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new Error(`${label}を整数として確認できません: ${value}`);
  return BigInt(value);
}

function toSafeNumber(value, label) {
  const out = Number(value);
  if (!Number.isSafeInteger(out)) throw new Error(`${label}が安全な整数の範囲を超えました`);
  return out;
}

// truncate（0に向かって切り捨て）。符号に対して対称
function truncateDiv(numerator, denominator) {
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  return sign * (n / d);
}

// trunc(額 × 率1 × 率2 × … ÷ 10000^k)。率は bp の整数。額は負（入金の取消）も受ける
export function rateChain(amount, bpsList) {
  let numerator = toBig(amount, '額');
  let denominator = 1n;
  for (const bps of bpsList) {
    numerator *= toBig(bps, '率');
    denominator *= BPS;
  }
  return toSafeNumber(truncateDiv(numerator, denominator), '料率の額');
}

// 比を bp で（分子 × 10000 ÷ 分母 を truncate）。どちらかが null・分母が0以下なら null
export function ratioBps(numerator, denominator) {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined) return null;
  const d = toBig(denominator, '分母');
  if (d <= 0n) return null;
  return toSafeNumber(truncateDiv(toBig(numerator, '分子') * BPS, d), '比');
}

// ceil(分子 × 10000 ÷ 分母)。行動の目標件数の逆算（契約＝計画の額 ÷（1件の額×売上率）、提案＝契約 ÷ 率、面談＝提案 ÷ 率）。
// 分子は0以上、分母は正の整数（分母の率は bp。1件の額×売上率のように bp を掛けた値も受ける）
export function ceilBpsQuotient(numerator, denominator) {
  const n = toBig(numerator, '分子');
  const d = toBig(denominator, '分母');
  if (n < 0n || d <= 0n) throw new Error('件数の逆算は0以上の分子と正の分母で呼んでください');
  return toSafeNumber((n * BPS + d - 1n) / d, '件数');
}
