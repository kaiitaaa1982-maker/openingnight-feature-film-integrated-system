---
paths:
  - "src/**"
  - "migrations/**"
  - "test/money-*"
title: 金額の計算（整数で持ち、端数の処理を名前で書く）
impact: CRITICAL（1円のずれは作り手への支払・請求・税に残り、気づいた後は報告書の出し直しになる）
tags: money, rounding, tax, currency, database
---

# 金額の計算

金額・率・外貨・数量を持つ、計算する、読む、表示するときに読む。根拠は brain の D-027
（`wiki/01_rules/decisions/2026-10-01-money-rules-and-postgres.md`）。
守れる部分は `test/money-rules.test.mjs` が検査し、いまの借りは `test/money-debt.json` にある。

## 値の持ち方

| 値 | 持ち方 | 列名の終わり |
|---|---|---|
| 円 | 整数の円 | `_yen`・`_ex_tax`・`_inc_tax`・`_amount`・`_tax` |
| 率 | 整数の bp（1万分率。10.5% = 1050、100% = 10000） | `_bps` |
| 小数の要る値（外貨額・レート・数量・単価） | 10のべき乗倍の整数（12.34 USD = 1234、150.1234円 = 1501234） | `_x100`・`_x10000` |
| 報告の原本の小数（控え。合算しない） | 小数の文字（TEXT） | 流通別の詳細の3表（`src/channel-sales.sql`）だけ |

- 金額・率・倍の列は、名前を上の終わりにする。検査は名前で列を見つける（`MONEY_COLUMN`。ほかに `price`・`fee`・`rate`・`total`・`cost`・`budget` で終わる列も金額として見る）
- 列は INTEGER にし、`CHECK(typeof(列)='integer' AND 列 BETWEEN -9007199254740991 AND 9007199254740991)` を付ける。
  NULL を許す列は `CHECK(列 IS NULL OR (…))`。SQLite の INTEGER の列は 1000.5 を REAL のまま保存する（STRICT でない表）ので、型の宣言だけでは守れない
- 既存の表は作り直さない。次の番号の移行で、INSERT と UPDATE の両方のトリガーで `typeof(NEW.列)<>'integer'` を拒む（INSERT だけだと UPDATE から小数が入る。移行の決まりは `database.md`）
- REAL・NUMERIC・型の無い列を金額・率に使わない。いまある2列（宣伝の指標・売上の追加の項目）のほかに足すときは、検査の `FLOAT_COLUMNS` に理由を書く
- 小数の文字の列は、表示と照合にだけ使う。計算に使うときは `scaledInteger` で整数倍にしてから
- Decimal のライブラリは入っていない。外貨2桁・レート4桁・数量4桁の整数倍で足りない値が出たら、入れる前に要件の要確認に書く

## 計算

**浮動小数点で金額を計算しない。** 金額・率・整数倍は整数のまま、BigInt か整数の演算で計算する（Number の小数・`Math.round` などの丸め・SQL の REAL と小数の定数を通さない）。

- 金額に率を掛ける・割るときは BigInt で計算し、丸める前の値（商と余り、または分子と分母）を持ってから、端数の処理を1回だけ名前で選ぶ。Number の `*`・`/` の結果を丸めない
- 内訳に分けたら、内訳の和が元の額と一致することを確かめる。端数を捨てない
- 安全な整数は ±9,007,199,254,740,991 まで。掛け算の途中（外貨_x100 × レート_x10000 など）はこれを超えうるので BigInt で計算し、`Number.isSafeInteger` を確かめて Number に戻す
- 端数の処理が要件で決まっていないときは、推測で選ばずに工程の要件の要確認に書く（端数の既定は D-027 で未決）。
  決まっているのは2つ: 料率の額は `truncate`（FR-SETL-ACCR-009）、配賦は内訳の和＝元の額（FR-REV-ROLL-006）

### 端数の処理の名前

新しいコードは次の語彙で書く（税の `src/tax.sql` の `rounding_mode` と `src/tax.mjs` の `roundRational` と同じ）。
どれも符号に対して対称で、返品（負の額）の結果は売上の結果の符号違いになる。

| 名前 | 意味 | 12.5 → | −12.5 → | −12.1 → |
|---|---|---|---|---|
| `truncate` | 0に向かって切り捨て | 12 | −12 | −12 |
| `half_up` | 四捨五入。ちょうど0.5は0から遠ざける | 13 | −13 | −12 |
| `ceil` | 0から遠ざける（切り上げ） | 13 | −13 | −13 |
| 最大剰余法 | 内訳を `truncate` し、足りない1円ずつを余りの大きい順に足す | — | — | — |

いまは2系統ある。経費（`src/expense-accounting/expense-accounting.sql` の `rounding` と、`src/expense-sheet/import-service.mjs` の
`calculatedTax`）は名前も向きも違い、正の額では同じ結果、負の額では違う結果になる。経費の側へ寄せる前に、経費で負の額に税を掛けるかを確かめる（未確認）。

| 経費の名前 | 意味 | −12.5 → | −12.1 → | 税の語彙での結果 |
|---|---|---|---|---|
| `floor` | 負の無限大へ | −13 | −13 | `truncate` は −12・−12 |
| `nearest` | ちょうど0.5は正の無限大へ | −12 | −12 | `half_up` は −13・−12 |
| `ceil` | 正の無限大へ | −12 | −12 | `ceil` は −13・−13 |

ほかに、ワークベンチの計算列（`floor`・`ceil`・`round` を Math で。`Math.round(-2.5)` は −2）と、売上集計シートの `roundTo`（小数の桁つきの `half_up`）が別の語彙を持つ。

## 同じ式は1か所の関数で

金額の式を別のファイルに書き足さない。次の関数を呼び、無ければ `money` で始まる名前のファイル（いまは `src/money-allocation.mjs`）に足す。
検査は BigInt の `/ 10000n`・`% 10000n` を `money*.mjs` の外で数える。

| したいこと | 関数（いまの置き場所） | 端数 |
|---|---|---|
| 料率を掛ける | `signedRateAmount(円, bp)`（`src/royalty/royalty-model.mjs`） | `truncate` |
| 配賦率で作品へ分ける | `splitByAllocation`（`src/money-allocation.mjs`） | 最大剰余法。同点は作品IDの小さい順 |
| 重みで分ける | `splitByWeights`（`src/reports/pl-bs-model.mjs`） | 最大剰余法。同点は並び順 |
| 税を出す | `roundRational(分子, 分母, 桁, 方式)`（`src/tax.mjs`） | 税ルールの版の `rounding_mode` |
| 小数の文字を整数倍に | `scaledInteger(文字, 桁)`（`src/sales-sheet/sales-sheet-input.mjs`） | 桁を超えたら読まない（丸めない） |
| % の文字を bp に | `percentToBps(文字)`（`src/royalty/royalty-model.mjs`） | 小数3桁以上は読まない |

いまの重複（寄せる借り）:

- 料率の額が6か所: `royalty-model.mjs` と `app.mjs` の `signedRateAmount`、`committee.mjs` の `fee`、`committee/committee-income.mjs` の `committeeFee`、`committee-joint.mjs` の `rate`、`committee-finance.mjs` の `committeeHistory` の中の式
- 最大剰余法が4か所: `money-allocation.mjs`（正本）、`app.mjs` の売上の配賦の中の写し、`reports/pl-bs-model.mjs` の `splitByWeights`、`committee/committee-monthly-model.mjs` の `splitLargestRemainder`（包み）。
  `committee-finance.mjs` の `allocateSigned` だけは、端数をすべて先頭へ寄せる別の方式
- % と bp の変換: 文字のまま変換するのが `percentToBps`・`work/allocation.mjs` の `parsePercent`・`committee/committee-monthly-view.mjs` の `parsePercentToBps`。
  `bulk/bulk-validate.mjs`・`sales-ops/partner-list-model.mjs`・`rights/rights-ui-model.mjs` は `Math.round(Number(文字) * 100)`（浮動小数を通る。下の返すべき借り）

## 外から読んだ値

- 取込・画面・API・DB から読んだ金額と率は、整数かを確かめてから使う。円は `integer`（`src/csv.mjs`）か `parseYen`（`src/ui/parse-input.mjs`）、小数の要る値は `scaledInteger`、率は `percentToBps`
- 読めない額・整数でない額を、0 や丸めた値にしない。NULL か「未確認」のまま返し、合計に入れなかった件数を示す
- 表示のための値（`yen()`・`int()`・`bps / 10000`・`toFixed`）を、保存や計算へ戻さない

## してはいけない形（検査が数える）

| 形 | 代わり |
|---|---|
| `parseFloat`・`Number.parseFloat` で数を読む | 上の読み取りの関数 |
| 小数の定数で掛ける・割る（`* 0.35`・`/ 1.1`・`/ 1e9`）。`Math.floor(180*0.35)` は 62（正しくは 63） | bp の整数と BigInt |
| 金額・率の式を `Math.round`・`floor`・`ceil`・`trunc` で丸める | 上の関数。`Math.round(-2.5)` は −2 で、返品が売上と逆の向きに丸まる |
| 小数を10のべき乗倍して丸める（`Math.round(Number(文字) * 100)` で % を bp に、`* 10000` で整数倍に） | 文字のまま読む。% は `percentToBps`、整数倍は `scaledInteger`（桁を超えたら読まない） |
| 値を1つ `Math.round(n)` で黙って整数にする | 整数でなければ誤りか未確認として返す |
| 読めない額を0にする（`Number(額) \|\| 0`・`isFinite(n) ? n : 0`） | NULL か未確認のまま返す |
| 料率・配賦の BigInt の式を `money*.mjs` の外に書く | 上の関数を呼ぶ |
| SQL の金額の式に小数の定数（`1000000.0`）・`ROUND(`・`avg(`・`total(`・`CAST(… AS REAL)` | 整数の式か、アプリの関数で計算した整数を保存する |

検査はテンプレートの `${…}` の中の式も同じ形で数える。
形に当たるが金額でない所（時刻・描画・件数など）は、検査の `NOT_MONEY` に理由と回数を書いて許す。借りの一覧（`money-debt.json`）には足さない。

## PostgreSQL へ移すとき（D-027 で検討中）

- 円・bp・整数倍は BIGINT（または INTEGER）で持つ。REAL・DOUBLE PRECISION・MONEY 型を使わない。NUMERIC を使う列は桁（`NUMERIC(p,s)`）を決め、計算の前に整数倍か BigInt に読み替える
- ドライバの型の変換を、接続を作る1か所で決める。node-postgres は BIGINT と NUMERIC を既定で文字列で返す。文字列のまま足したり比べたりしない（`'10' + '5'` は `'105'`、`'9' > '10'`）。
  BIGINT は BigInt か、`Number.isSafeInteger` を確かめた Number に変える。
  いまは PostgreSQL の入口（`src/data-platform/pg-db.mjs` の `parseValue`）の1か所で決めている: bigint・count・整数の sum は安全な整数の Number（超えたら止める）、表の numeric の列は Decimal の文字列
- PostgreSQL の INTEGER・BIGINT の列は、SQL の小数の値を代入すると黙って丸める（`1.5` → `2`）。SQL の中で金額を計算して保存しない。
  PostgreSQL の入口は、書き込みの文の小数の定数を止める（パラメータの小数は bigint の列が 22P02 で断り、入口が値の範囲の違反にする）
- SQLite の typeof の CHECK とトリガーで守っていた整数の強制を、型の宣言と CHECK に置き換える。`money-rules.test.mjs` の PRAGMA に頼る部分も作り直す

## 返すべき借り（2026-10-01。一覧は `test/money-debt.json`）

- 整数の強制が無い金額・率の INTEGER の列が111（54表）。`sale_lines` に 1000.5 が入る
- 外貨×レートの照合が浮動小数（`sales-sheet/sales-sheet-input.mjs` の `normalizeCurrencyInput` と、`sales-sheet/sales-sheet.sql` のトリガー `sale_currency_versions_check`）。JS と SQL で計算の順序も違う
- ワークベンチの計算列（`transforms/engine.mjs` の `calc`）が Number の四則演算と Math の丸めで、売上取込の下書きに使える
- % を bp にする3か所が浮動小数を通る（`Math.round(Number(文字) * 100)`）: `bulk/bulk-validate.mjs` の `parsePercent`、
  `sales-ops/partner-list-model.mjs` の `parsePercentToBps`、`rights/rights-ui-model.mjs` の `parsePercent`（`checkPercent`）。`percentToBps` に寄せる
- 経費の Excel 取込（`expense-sheet/import-service.mjs`）は、数量と単価を `Math.round(Number(セル) * 10000)` で `quantity_x10000`・`unit_price_x10000` にする。
  小数5桁目以降を黙って丸めるので、`scaledInteger(セル, 4)` で読み、桁を超えたら取り込まない
- 売上集計シートの計算列と集計（`sales-sheet/column-registry.mjs` の `roundTo`・`evaluateFormula`、`sales-sheet-model.mjs`）は浮動小数。表示と参考だけで保存しない。
  検査はここを見つけられないので、保存や取込に回していないかをレビューで見る
- 読めない額を0にする所: `billing/receipt-model.mjs` の `toInt`、`mg-ledger-import.mjs` の `num`、`pl-bs/pl-bs-data.mjs`、`import/sales-source-routes.mjs` の合計。
  作品で絞った売上一覧（`sales/sales-lines-routes.mjs`）は、配賦に失敗すると明細の全額を返す（検査は見つけられない）
- 表示の `yen()`・`int()`（`ui/format.mjs`）は、整数でない値を黙って丸める
