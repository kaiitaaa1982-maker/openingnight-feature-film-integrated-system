---
paths:
  - "test/**"
  - "scripts/seed-*.mjs"
title: テスト（書き方・流し方・骨抜きの禁止）
impact: HIGH（骨抜きのテストは緑のまま誤りを通し、AI の自走を誤った方向へ進める）
tags: testing, node-test, verify
---

# テスト

テストを足す・直す前に読む。守れる部分は `test/test-rules.test.mjs` が検査する。

## 流し方（このフォルダで実行する）

| 段 | 流すもの |
|---|---|
| 作業中 | 1本ずつ `node --test test/<名前>.test.mjs` |
| PR の前（作り手） | `npm run test:changed` と `npm run test:pg:changed` で T0＋選んだ本を流す。段A の間は `npm test`（SQLite）の全体も残す。**PGlite の `npm run test:pg` の全体は手元で流さない** |
| 確かめ役 | draft の PR の head SHA の CI が終わってから結果を読む。全体を流し直さず、変更の近くを反証する（`review.md`） |
| 直し役 | 直したファイルから選び直した本＋足した本・直した本＋T0。選べないときは SQLite の全体と CI の PostgreSQL の全体で確かめる |
| PR の CI・main への push | 段A は SQLite・本物の PostgreSQL（CI の postgres:18）の全体。CI はこの段では絞らない |

- `npm run test:changed` は `origin/main...HEAD` と作業中の変更（未追跡を含む）から選ぶ。`-- --base <ref>` で比較元を替え、`-- --files src/<名前>.mjs ...` で架空の差分を渡せる。T0 の core の本は core で流す。`test:pg:changed` は `sqliteOnly` を除く
- `node scripts/select-tests.mjs --json` で選んだ本・省いた本・理由・R・抜き取りを出し、実行結果と PR に書く。JSON のパスは core 相対、`--list` はアプリ相対。`--full`・`--label full-test`・HEAD のコミット文の `[full]` は全部を選ぶ（GitHub のラベル接続は PR4）
- `src/app.mjs` を境界に import を逆引きする。import で届かない入力は `test/select-map.json`、URL→route の行は PR3。未対応・異常・git 差分取得の失敗は全部。R3 の金額・identity/役割・ログ・T0 の金額/権限からの依存・SQL/DB/試験の土台なども全部
- 履歴が無い間の q は 0.1。R は見逃しの確率ではない。閾値は暫定 0.02、抜き取りは SHA を種に max(5本, 残りの20%)。初月の設定を保ち、10%への移行と閾値の確定は影の期間の実績で決める。全体が選ばれた場合の PG の検証は CI に委ね、手元で PGlite 全体を起動しない
- SQLite は `node --test --test-concurrency=1 test/<名前>.test.mjs ...`、PGlite は **ファイルを明示して** `node scripts/test-pg.mjs test/<名前>.test.mjs ...`。`ON_TEST_PG_URL` を渡さなければ PGlite。T0 のパスは core ルートからの相対パスなので、core の試験は core で実行する
- `pg-matrix.json` の `sqliteOnly` の本は SQLite で流す。`pg-db`・`pg-ddl` は本自体が PGlite との比較を行い、CI では本物の PostgreSQL に対しても流す。`pg-ddl` に加えて `node scripts/pg-ddl.mjs --check` も行う。CI の guard と check-cloud-db-config も省かない
- 作り手は push したら、確かめ役に渡す前に **draft の PR を開く**。`ci.yml` は PR を開く前のブランチへの push では走らず、draft の PR では走る
- 結果が無い・実行中を緑と読まない。代表にマージを頼むのは、**最後の head SHA の CI が終わり、結果を PR の本文かコメントに書いてから**
- T0 から外すときは代表の承認を得る。ふだん落ちないことだけを理由に試験を省いたり消したりしない（計画 R11・R12）。T0 と危険度の高い範囲の試験は消さない。削除の手続きの実装は段Cで扱う
- ゆらいだ試験を自動で流し直して緑にしない。同時書き込みの欠陥を隠すためである

- 見本の CSV・XLSX を読むテストを1本だけ流すときは、先に `npm test` か `npm run build` を1回流す（前処理が見本を作る）
- 表の移行は `npm run ci:migrations`、画面は core で `node .claude/skills/verify/scripts/verify.mjs launch` を使う

## 同時に書く試験

- 同じ資源への書き込みを同時に送る試験は、勝つ側を決め打ちしない。状態は並べ替えて比べ、残った値は通った側から求める
- `Promise.all` で API の POST・PUT・PATCH・DELETE や DB の run・batch を同時に送る本は、T0 の `concurrency: true` を付ける。`test-rules` が印の付け忘れを検査する。同じ資源か静的に確定できない書き込みも安全側で印を付ける
- SQLite と PGlite は1本の接続で順に処理するため、この種の試験の合否は PGlite では出ない。**本物の PostgreSQL（CI）で流すまで通ったと言わない**。PR でも必ず流す

## 置き場所と名前

- テストは `test/<対象>.test.mjs`。架空データを作る部品は `test/*-fixture.mjs`
- DB はファクトリ `openTestDb({t})`（`test/test-db.mjs`）で開く。`ON_TEST_DB=pg` で同じテストが PostgreSQL で流れる（PG 計画 段1の試験の二重化）。
  自前で `new LocalDatabase`・`new DatabaseSync` を作るテストは、`test/pg-matrix.json` の `pending`（PostgreSQL でまだ落ちる。原因の札をつける）か
  `sqliteOnly`（SQLite そのものを確かめる。理由を書く）に載せる。`pending` は直して減らすだけで増やさない（`test/test-rules.test.mjs` が検査する）
  `sqliteOnly` は名指しで固定し（`test/test-rules.test.mjs` の `SQLITE_ONLY`）、変えるときは規則を変える。`src/`・`scripts/` の道具の関数で DB を作るもの（例: `scripts/build-db-docs.mjs` の `plan`）も自前とみなす
- ファクトリで開くときは試験の `t` を渡す（`openTestDb({t})`・`fixture({t})`）。試験の終わりに閉じるのを待ち、次の試験と重ならない（PGlite の DB は1つ約75MB）。引数なしの呼び出しは `test/test-rules.test.mjs` が落とす
- テスト名は、守る振る舞いを日本語の1文で書く（例: 「月間発行数50件ちょうどまでは基本料金」）
- データは架空のものだけを使う。メールは `.invalid`、組織は `DEMO-SALES` など。実データ・秘密値を入れない

## 書き方

- 期待値は要件・計画から持ってくる。実装を読んで期待値を作らない（実装が間違っていてもテストが通ってしまう）
- 新しいテストは、先に失敗（Red）することを確かめてから実装を直す。最初から通ったテストは、実装済みか、確かめ方が弱いかを疑う
- 境界は両側を書く（ちょうど・1つ外）。金額は整数円で、符号（返品）と端数の行き先まで確かめる
- 「エラーになる」だけで済ませず、何のエラーか（状態・コード・文言）まで確かめる
- 「出ないこと」が約束なら、出ないことを確かめる（権限の無い人に見えない、など）

## 骨抜きの禁止

| してはいけない | 代わりに |
|---|---|
| `test.only`・`describe.only` を残す | 流す範囲はコマンドの引数で絞る |
| 理由を書かずに skip する | `{skip: 条件 ? false : '理由'}` か `t.skip('理由')`。道具が無い環境だけに限る |
| 環境変数が無いと黙って成功する（`if (!process.env.X) return`） | 上の skip を使い、CI の件数に「skipped」として出す |
| `assert.ok(result)` のように、何が返っても通る確かめ方 | 値そのものを `assert.equal` / `deepEqual` で確かめる |
| 画面の確かめで API の応答を差し替える | verify で実際の API と使い捨ての DB を通す |
| テストを通すために、テストの値だけに正しく答える実装 | 実装を直す。テストを変えるなら理由を PR に書く |
