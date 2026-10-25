// 個人の額の守り（行動指標の計画 K2-12・FR-REV-KPI-016）の試験が共有する部品。本人の倍率の試験（self-multiplier.test.mjs。段B #8）、
// 個人の額の試験（fictional-compensation.test.mjs。段B #23）、種を流した DB の検査（seed-all-demo.test.mjs）が使う。
// 架空の額は試験のソースに書かず fictionalYen で実行時に作る。種の目標・計画の額は fictional の印の行（フェーズ1 #23a）からだけ読む
import {readFileSync} from 'node:fs';

// 番号 n ごとに不規則な桁の9桁の円を作る（同じ n なら同じ額。目標・計画・報酬の額を試験のソースにも書かない）
export const fictionalYen = (n) => 100000000 + Number((BigInt(n) * 2654435761n + 97531n) % 899999999n);

// 報酬の表（フェーズ1 #17 が足す。報酬の種類は月収・家賃補助・交通費）の名前の取り決め。#17 が表名を HIDDEN_TABLES 側の定数
// （OWNER_ONLY_TABLES に足すか COMPENSATION_TABLES）に置くまで、データ一覧・一括出力・種の検査はこの名前に依る
export const COMPENSATION_TABLE_NAME = /compensation|salar|wage|payroll|remuneration|subsid|housing|^pay_/i;

// 案件収支の予実の架空の種（test/fixtures/yojitsu/seed.json。フェーズ1 #23a）の目標・計画の行のうち fictional の印がある行の額。
// 種を流した DB の目標・計画の行は、この額だけを持てる（印の無い行の額は入れない）
export function fictionalSeedAmounts() {
  const seed = JSON.parse(readFileSync(new URL('./fixtures/yojitsu/seed.json', import.meta.url), 'utf8'));
  const amounts = (rows, key) => new Set(rows.filter((row) => row.fictional === true && row[key] !== null).map((row) => row[key]));
  return {targets: amounts(seed.目標, '目標額（円）'), plans: amounts(seed.計画, '計画額（円・税別）')};
}
