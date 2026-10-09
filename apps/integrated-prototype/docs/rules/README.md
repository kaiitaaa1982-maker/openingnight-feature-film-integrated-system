---
title: 開発ルールの索引と書き方
---

# 開発ルール

統合基幹システムの開発ルールの正本。ルールは1ファイル1トピックで置く。

| ルール | いつ読む | 検査 |
|---|---|---|
| `architecture.md` | `src/` のファイルを足す・動かす・直す | `test/dependency-rules.test.mjs` |
| `requirements.md` | 工程を作る・直す前、テストを足す | `test/requirements-trace.test.mjs` |
| `testing.md` | テストを足す・直す | `test/test-rules.test.mjs` |
| `logging.md` | エラー処理・ログ・変更の記録を書く | `test/logging-rules.test.mjs` |
| `database.md` | 表の定義・SQL・移行を書く | `test/database-rules.test.mjs` |
| `money.md` | 金額・率・外貨を持つ・計算する・読む・表示する | `test/money-rules.test.mjs` |
| `dialect.md` | SQL・移行・DB を呼ぶコードを書く（D1 と PostgreSQL の両方で動く形） | `test/dialect-rules.test.mjs` |
| `review.md` | PR を出す前・レビュー | 無し（レビュー役が読む） |

## 読み込ませ方

- 正本はこのフォルダ。Claude Code には、core の `.claude/rules/integrated-<名前>.md` へ写したものを読ませる。写しは冒頭の `paths` に合うファイルを Claude が読んだときだけ読み込まれる（2026-09-30 に新しいセッションで確かめた。core を作業場として開いたときと、その1つ上のフォルダで開いたときの両方で読まれた。会社ルートの main フォルダから開いたときは未確認）
- 写しは `node scripts/ops/sync-rules.mjs`（core のルートで実行）で作り直す。手で直さない。正本と写しのずれは `scripts/ops/rules-sync.test.mjs` が見つける
- `paths` の無いルール（`review.md` とこの索引）は写さない。地図（`AGENTS.md`）の表から案内する
- Codex は `paths` を読まないので、地図の「作業の前に読むもの」を頼りに読む

## ルールの書き方

- 冒頭に `paths`（対象のファイル）・`title`・`impact`（破ったときの重さ）・`tags` を書く
- 機械で合否が決まる文で書く。「きちんと〜する」ではなく、コマンドの形や、してはいけない形を名指しする
- 書く前に、検査（テスト）や表の制約で守れないかを考える。守れる部分は検査にし、ルールには理由と例外を書く
- 1ファイル200行未満（検査が見る）。残す行は「この行を消したら AI が間違えるか」で選び、間違えない行は削る
- 薄く始める。レビューで同じ指摘が2回出たら、検査かルールへ上げる（検査を先に考える）
- 手順に育った節（何をどの順に実行するか）は、ルールから外してスキルへ移す
