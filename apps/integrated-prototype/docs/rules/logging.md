---
paths:
  - "src/**"
title: ロギング（エラーの残し方と、残してはいけないもの）
impact: HIGH（秘密値や個人情報が一度ログへ出ると取り戻せない）
tags: logging, error-handling, privacy
---

# ロギング

エラー処理・ログ・変更の記録を書くときに読む。守れる部分は `test/logging-rules.test.mjs` が検査する。

## 2種類の記録を分ける

| 記録 | 置き場所 | 何を残すか |
|---|---|---|
| 業務データの変更 | DB の `audit_log`（組織・利用者・操作・対象・前後） | 誰がいつ何を変えたか。数字の正本と同じ DB に残す |
| 失敗 | Worker のログ（`app.onError` が書く） | どの API で・どの組織の・どの操作で・何が起きたか |

業務データの変更をログへ書かない。失敗を `audit_log` へ書かない。

## 失敗の扱い

- エラーは API 全体の受け止め口（`app.onError`）に集める。各 routes で `console.error` を書き足さない
- 受け止めずに捨てない。`catch {}` で黙らせるのは、予想した失敗（権限が無い行を一覧から外す、など）を、その種類だと確かめたときだけにする。それ以外は投げ直す
- 画面に返すエラーは、利用者が次に何をすればよいかが分かる日本語にする。内部の SQL や値をそのまま返さない

## 残してはいけないもの

- 秘密値（認証トークン・Cookie・API キー・接続文字列・招待のリンク）
- 個人を特定する値（メールアドレス・氏名・電話）。利用者は ID で残す
- 契約の金額や業務データの行そのもの。残すのは ID と件数まで

## console を使ってよい場所

起動の知らせ（`server.mjs`・`server-production.mjs`）と、エラーの受け止め口（サーバーは `app.mjs` の `app.onError` と `report-issuance-routes.mjs` の帳票の失敗、画面は `ui/ErrorBoundary.jsx`、閲覧用プレビューは `preview/preview-main.mjs`）だけ。
ほかの場所で使うと検査が落ちる。足すときは、なぜ受け止め口に集められないかを PR に書く。

`data-platform/cloud-pg-export.mjs` は定時実行の受け止め口で、HTTP の `app.onError` を通らないため例外とする（成功の `console.log` と失敗の `console.error` の2か所）。
ログは固定の名前（`pg_daily_export_succeeded`・`pg_daily_export_failed`・`pg_daily_export_close_failed`）の JSON 1行にし、出すのは次だけにする。元のエラーの message・SQL・行・金額・接続文字列は渡さない。

- 失敗: 原因の種類（`cause`）・経過（`elapsed_ms`）・終えた表の数（`tables`）・読み終えた行の数（`rows`）
- 成功: 世代のキー（`manifest_key`）・表の数・行の数・所要時間（`elapsed_ms`）

原因の種類は許可リスト（`data-platform/pg-export-format.mjs` の `failureCause`）で決める。`exportError` の固定の語（`EXPORT_ERROR_CODES`。`binding_missing` を含む）、PostgreSQL の SQLSTATE の5文字（`/^[0-9A-Z]{5}$/`）、それ以外は `unexpected`。
core の `scripts/ops/pg-restore.mjs`・`pg-reconcile.mjs` の失敗も、同じ許可リストの種類だけを1行で出す。

## 返すべき借り（2026-09-30 時点）

- `app.onError` はエラーを丸ごと出すだけで、どの API・どの組織の操作かが残らない。AI にログを渡しても原因にたどり着けないので、ルート・組織 ID・利用者 ID・Cloudflare のリクエスト ID を添えた1行の形にする
- サーバー側に空の `catch {}` が6か所ある（`mg.mjs` 2・`tax.mjs` 1・`workbench.mjs` 2・`workbench-analytics-local.mjs` 1）。権限で外す失敗だけを受け止める形に直す
- 画面側の `main.jsx` に、画面遷移の失敗を黙らせる空の `catch {}` が6か所ある。失敗したら利用者に知らせる形に直す
