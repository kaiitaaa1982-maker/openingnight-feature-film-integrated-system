# goals — ループの目標と指標

`/goal` で回すループの目標（goal）を、1つの goal につき1つの md で置く。指標は `npm run metrics` が JSON で出し、`--goal` を付けると goal の閾値と比べて合否（goal_check）を返す。
置き場は会社ルートのフェーズ1の計画（`plans/2026-10-08-phase1-five-second-yojitsu.md`）の K-15。入金の確認の計画（`plans/2026-10-08-loop-and-exception-ux.md`）の #2 とフェーズ1の #19 が共用する。

指標にするのは、同じコミットで2回流して同じ値になるものだけ（K-11）。時間のように揺れる値は goal_check に使わず、verify のレシピの記録で人が見る。

## 指標を出す（このフォルダの1つ上で実行する）

```powershell
npm run -s metrics                                           # 静的な指標（試験の本数・FR の状態・借り）
npm run -s metrics -- --tests test/a.test.mjs test/b.test.mjs  # その試験を流した結果を足す
npm run -s metrics -- --tests changed --engine sqlite,pg     # 差分から選んだ試験（select-tests）を SQLite と PostgreSQL で
npm run -s metrics -- --baseline <コミット>                  # 基準のコミットの静的な指標と、FR の後戻りを足す
npm run -s metrics -- --goal goals/<名前>.md                 # goal の tests・engine・baseline を使い、goal_check の合否を足す
npm run -s metrics -- --goal goals/<名前>.md --out goals/records/<名前>/<ターン>.json
```

- 標準出力は JSON だけ（`-s` を付けないと npm の見出しの行が混ざる）。試験の経過と要約は標準エラーに出る。`--out` は同じ JSON をファイルにも書く
- 終了コード: 0＝出せた（goal があれば PASS）、1＝goal_check が FAIL、2＝引数・goal の書き方・試験の起動の誤り
- `--tests` は試験のファイル（`test/<名前>.test.mjs`）を挙げるか、`changed`（`scripts/select-tests.mjs` が `origin/main` との差分から選ぶ）か `all`（`test/*.test.mjs` 全部）。流す前に `npm test` と同じ前処理（`scripts/prepare-test-assets.mjs`）を流し、通ったかを `prepared` に残す
- PostgreSQL は `ON_TEST_PG_URL`（手元の PostgreSQL）が無ければ PGlite で流す。`all` と、差分から全部が選ばれた `changed` は PGlite では流さない（`docs/rules/testing.md`）。`test/pg-matrix.json` の `sqliteOnly` の本は PostgreSQL で流さない
- `changed` の選び方は `origin/main` の位置にもよる。同じ値にしたいときは、同じ `origin/main` のまま流す

## 出す指標

JSON の形は `{schema, commit, dirty, metrics, baseline, goalCheck}`。goal_check の「指標」の列は `metrics` の下の道を `.` でつないで書く（例 `testRun.sqlite.failed`）。

| 道 | 中身 | 種類 |
|---|---|---|
| `commit`・`dirty` | 測ったコミットと、コミットしていない変更（アプリの下。未追跡を含む）があるか | — |
| `tests.files` | 試験のファイルの数（`test/*.test.mjs`） | 静的 |
| `tests.declared` | 書いた試験の数。そのまま呼んだ `test(`・`it(` を数える。`.skip`・`.todo` と、試験の中の試験（`t.test(`）は数えない。ループで作る試験は1と数える。このため、ループの中の本や試験の中の試験を削っても減らない。試験を流す goal では `testRun.<sqlite か pg>.tests >= 始めの値` を数で書いて見る | 静的 |
| `tests.declaredSkipOrTodo` | `test.skip(`・`test.todo(` などの数 | 静的 |
| `tests.pgPending`・`tests.sqliteOnly` | `test/pg-matrix.json` の pending（PostgreSQL でまだ落ちる本。返すべき借り）と sqliteOnly の本の数 | 静的 |
| `fr.files`・`fr.total`・`fr.byState.<状態>` | 工程の要件のファイルの数（`docs/requirements/` の下。README を除く）、機能要件の行の数と、状態（テスト・画面・未検証・廃止）ごとの数。読み方は `test/requirements-trace.test.mjs` と同じ（`test/requirements-parse.mjs`） | 静的 |
| `fr.byDomain.<領域>.<状態>`・`fr.byFile.<領域>/<工程のファイル名>.<状態>` | 領域ごと・工程の要件のファイルごとの数（例 `fr.byFile.revenue/report-intake.未検証`） | 静的 |
| `fr.broken` | 機能要件の表で読めない行の数 | 静的 |
| `fr.sinceBaseline.regressed`（と `regressedIds`） | 基準のコミットでテストか画面だった番号のうち、いま未検証の数。基準があるときだけ | 静的 |
| `fr.sinceBaseline.removed`（と `removedIds`）・`added`・`addedByState.<状態>` | 基準から消えた番号（要件は消さず廃止にする）、足した番号の数と状態ごとの数 | 静的 |
| `debt.total`・`debt.byFile.<名前>.total`・`debt.byFile.<名前>.kinds.<種類>` | `test/<名前>-debt.json`（返すべき借り）の数。数はその値、配列は要素の数、入れ子は和。`note` は数えない | 静的 |
| `testRun.selection`・`testRun.prepared` | 選び方（`files`・`changed`・`all`）と、前処理が通ったか（真偽値なので goal_check には使えない。通っていなければ標準エラーの要約に1行出る）。`--tests` が無ければ `testRun` は `null` | 流す |
| `testRun.<sqlite か pg>.tests`・`passed`・`failed`・`cancelled`・`skipped`・`todo` | `node --test` の件数（試験の中の試験と、読み込みに失敗したファイルを含む）。基準のコミットでは流さないので、値に `baseline` は使えない | 流す |
| `testRun.<sqlite か pg>.exitCode`・`failures`・`files`・`fileCount`・`target` | 終了コード、落ちた試験の名前（並べ替え済み）、流したファイル、流した先（`sqlite`・`pglite`・`postgres`） | 流す |
| `baseline.commit`・`baseline.metrics.*` | 基準のコミットで数えた静的な指標（git の中身から読む。作業中のファイルを見ない） | 静的 |
| `goalCheck` | 下の goal_check の結果 | — |

- 「静的」は作業中のファイルか、コミットの中身だけから決まる。基準のコミットでも同じ関数で数える
- 「流す」は作業中の状態でだけ測る。頼まれていなければ `null`
- 同じ値になるように、時刻・所要時間・乱数・手元の絶対パスを入れず、一覧は並べ替えて出す。試験そのものが揺れると `testRun` は揺れる（揺れる試験は直す。自動で流し直して緑にしない）
- 目標・報酬の額など、本人だけに返す値を指標にしない（行動指標の計画 K2-12）。記録は git に入る

## goal の書き方

1つの goal を `goals/<名前>.md` に書く。人が読む節と、goal_check が読む表を同じファイルに置く。

```markdown
---
title: 入金の確認の突き合わせ（例）
baseline: <計画の最初の PR の base のコミット。ブランチ名は動くので SHA を書く>
tests: test/receipt-matching.test.mjs test/metrics.test.mjs
engine: sqlite pg
---

## 目標
何が・何件になれば止めるか。

## 守る指標（下がったら失敗）
## 伸ばす指標（上限つき）
## 上限
20ターン。指標が2ターン続けて動かなければ止める。

## 人へ上げる変更
migrations、権限、金額の丸めの規則、試験や性質を弱める変更。

## goal_check

| 指標 | 比べ方 | 値 | 種類 | 意味 |
|---|---|---|---|---|
| `testRun.sqlite.tests` | >= | <始めの値> | 守る | 流れた試験の数が減らない（tests.declared はループで作る試験と試験の中の試験を数えないので、それらを削ったことはここで見る） |
| `testRun.sqlite.failed` | = | 0 | 守る | 試験の失敗0件 |
| `testRun.sqlite.exitCode` | = | 0 | 守る | node --test が通った |
| `testRun.pg.failed` | = | 0 | 守る | PostgreSQL でも失敗0件 |
| `tests.declared` | >= | baseline | 守る | 書いた試験の本数が減らない |
| `debt.total` | <= | baseline | 守る | 借りが増えない |
| `fr.sinceBaseline.regressed` | = | 0 | 守る | 既存の FR が未検証へ戻らない |
| `fr.sinceBaseline.removed` | = | 0 | 守る | 基準にあった FR の行を消さない（消した行は regressed に出ない。やめた要件は廃止にする） |
| `fr.sinceBaseline.addedByState.未検証` | <= | <始めの値> | 守る | 足した FR を未検証のまま増やさない（足した要件は同じ goal で試験まで持っていく） |
| `fr.byFile.revenue/receipt-matching.テスト` | >= | <N> | 伸ばす | 関係する FR が N 件「テスト」になる（未検証 0 だけだと、要件の行を書かなくても通る） |
| `fr.byFile.revenue/receipt-matching.未検証` | <= | 0 | 伸ばす | 関係する FR に未検証が残らない |

## 記録

| ターン | コミット | goal_check | 動いた指標 | 人へ上げたこと |
|---|---|---|---|---|
```

- `<始めの値>` と `<N>` は、goal を始めるときに数で埋める。`<始めの値>` は始めたときに `npm run -s metrics -- --tests … --baseline …` で測った値、`<N>` は関係する工程の要件の行を数えて決めた件数。埋めないと値の書き方の誤りで終了コード2になる（`goals/` に置いた goal は `test/metrics.test.mjs` が書き方を確かめる）
- FR の行は、未検証が減ることだけでなく、テストの数が届くこと・行を消さないこと・未検証のまま足さないことを一緒に見る。要件を書かない・行を消す・性質を弱めることで指標を緑にしない（フェーズ1の計画の「増幅させたくないもの」）

frontmatter（1行に1つ。`tests`・`engine` は空白かカンマで区切る）:

| 項目 | 中身 |
|---|---|
| `title` | goal の名前 |
| `baseline` | 値に `baseline` を使う行と、`fr.sinceBaseline` の基準。計画の最初の PR の base のコミットを書いて固定する（「既存の FR」の基準。フェーズ1の守る指標） |
| `tests` | 流す試験。ファイルを挙げるか `changed`・`all`。無ければ試験を流さない（`testRun.*` の行は落ちる） |
| `engine` | `sqlite`・`pg`。無ければ `sqlite` |

コマンドの `--tests`・`--engine`・`--baseline` は frontmatter より優先する。

## goal_check

`## goal_check` の節の表を1行ずつ判定する。表は4列か5列（意味は書かなくてよい）。コードブロックの中の表は読まない。

| 列 | 書くもの |
|---|---|
| 指標 | `metrics` の下の道（上の「出す指標」）。バッククォートで囲んでよい |
| 比べ方 | `=`・`<=`・`>=`・`<`・`>` |
| 値 | 数か `baseline`（同じ道の基準のコミットの値。静的な指標だけ） |
| 種類 | `守る`（下がったら失敗。差分を戻すか人へ上げる）か `伸ばす`（届くまで回す） |
| 意味 | 人が読む説明（任意） |

- 全部の行が通れば PASS、1行でも落ちれば FAIL。指標が無い・数でない行は落ちる（流していない試験を緑と読まない）。基準の値が無い行も落ちる
- 行が1つも無い、列・比べ方・値・種類の書き方が違う、`baseline` を使うのに基準が無いときは、判定せず終了コード2で止まる
- 結果は JSON の `goalCheck`（`verdict`、守る・伸ばすごとの通った数、行ごとの `expected`・`actual`・`pass`）と、標準エラーの要約（`goal_check: PASS（守る 7/7・伸ばす 1/1）` と、行ごとの `OK`・`NG`）
- 判定の値は、goal を始めたときに決めて数で書いてよい（例: ループの始めの値より増やさない）。ターンごとに前のターンと比べる形（`previous`）はまだ無い。要るときは指標と同じ手順で足す

## /goal で回す

1. goal を書き、代表と守る指標・伸ばす指標・上限・人へ上げる変更を合わせる
2. Opus のセッションの Claude Code で `/goal goals/<名前>.md の goal_check が PASS を出すまで。20ターンか、指標が2ターン続けて動かなければ止める` と打つ
3. 各ターン: 実装は Opus のセッション、確かめは Sonnet のサブエージェント（`model: sonnet`）。差分を見てコミットしてから `npm run -s metrics -- --goal goals/<名前>.md --out goals/records/<名前>/<ターン>.json` を流す。`dirty` が `true` の結果は、コミットした状態の値ではない
4. /goal の判定（小型モデル）の材料は goal_check の出力だけにする。人へ上げる変更に当たったら、ループを止めて代表に聞く
5. 各ターンの終わりに、goal の「記録」の表に1行（ターン・コミット・合否・動いた指標・人へ上げたこと）を足す。記録の形は振り返り（入金の確認の計画 #9・フェーズ1 #21）で見直す

## 指標を足す（フェーズ1 #19 など）

`scripts/metrics.mjs` の `COLLECTORS` に1つ足す。JSON の `metrics.<key>` に入る。

```js
{key: 'shell', kind: 'static', title: '入口の画面数', collect({source}) { /* source.files・source.read だけで読む */ }}
{key: 'recipe', kind: 'run', title: '5秒のレシピ', enabled: options => Boolean(options.recipe), collect: ({options, appDir}) => { /* 流して測る */ }}
```

- 静的な指標は、引数の `source`（`files(フォルダ, 正規表現)`・`read(パス)`。パスはアプリ相対）だけから読む。こうすると基準のコミットでも同じ関数で数えられる
- 流す指標は、頼まれたときだけ流す（引数と goal の frontmatter の項目を足す）。流したもの（ファイル・流した先）を値に残す
- 同じコミットで2回流して同じ値にする。時刻・所要時間・乱数・環境変数の値・手元の絶対パスを返さず、一覧と名前つきの集まりは並べ替える
- `test/metrics.test.mjs` に、計画の定義から決めた期待値の試験を足し、この README の「出す指標」に行を足す

フェーズ1の #19 が足す予定の指標（キーは #19 で決める。下は案）:

| 指標 | キーの案 | 種類 | 測る所 |
|---|---|---|---|
| 施策1件の必須入力数（≤ 7。既定値で埋めた項目も数える） | `initiative.requiredInputs` | 静的 | 施策の受け口の入力の定義（K-17） |
| 送信 → 説明の帳票のクリック数（≤ 3） | `recipe.clicks` | 流す | verify の5秒のレシピ（#20）の記録 |
| 送信後の画面の API の往復（≤ 2） | `recipe.apiRoundTrips` | 流す | 同上（同時に出す要求は1と数える） |
| 帳票 API の SQL の数（≤ 10） | `sql.reportQueries` | 流す | 試験の中で DB の入口が数えた文の数 |
| 代表モードの入口の画面数（47 → 12） | `shell.entryScreens` | 静的 | `src/shell/nav-model.mjs` の代表モードの一覧 |
| `status` が `unregistered` の件数 | `documents.unregistered` | 流す | 架空の種から作った文書データ（#8） |
| 「0円」の埋め（0） | `documents.zeroFilled` | 流す | 同上。`status` が unregistered・未着・未到来の行で金額が null でない数 |
| FR の状態 | `fr`（済み） | 静的 | 上の表 |
