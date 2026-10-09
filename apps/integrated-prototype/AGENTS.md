# 統合基幹システム — AI向けの地図

`apps/integrated-prototype/`。9つの領域（企画・制作・営業・宣伝・売上・経費・精算・会計・台帳。`docs/requirements/README.md`）を、1つの API と 1つの DB で扱う。
本番は本人限定の `app.example.invalid`（Cloudflare）で動いている。

このファイルは作業の前に読む地図である。仕様の詳細は `README.md` と core の `docs/` に置く。
会社の規約（本番の操作・公開・マージは代表が行う、実データと秘密値を入れない、未確定は `unverified` のまま残す）は、会社ルートの `AGENTS.md` に従う。

## 技術スタック

- Node.js 24 以上、ES Modules（`.mjs`）。API は Hono、画面は React 19 と Vite 7
- DB は SQLite 系の1本。ローカルは `node:sqlite`（`data/integrated.sqlite`）、本番は Cloudflare D1
- 本番は Cloudflare Workers（Access の JWT で本人を確かめる）、R2（原本の保管）、Container（Python の文書抽出と分析）
- テストは Node 標準の `node --test`。外部サービスと認証情報は使わない。文書抽出のテストだけ Python を使う

## ディレクトリ構成

- `src/app.mjs` — API の組み立て役。各業務の `register*Routes()` を呼び、認可・CSV 取込などの共通 API も持つ
- `src/server.mjs` — ローカルのサーバー。`src/cloud-worker.mjs` — 本番の Worker。`src/worker.mjs` — 配備しない準備用の Worker
- `src/main.jsx` — 画面の入口。`src/ui/` — 画面の部品と `api-client.mjs`。`src/shell/` — 画面の枠、組織と作品の選択
- `src/preview/` — 閲覧用プレビュー（架空データで記録した応答だけで動く、保存できない版）
- `src/db.mjs` — ローカルの DB。`src/d1-db.mjs` — D1（Node の組込みモジュールを import しない）
- `src/data-platform/` — PostgreSQL の入口（`pg-db.mjs`。pg の Pool か Client を受け取る。本番ではまだ使わない）と、入口が付ける共通のエラーの種類（`db-errors.mjs`。受け口はエラーの文でなくこの種類で分岐する）
- `src/data-platform/pg-export-store.mjs`・`pg-restore-store.mjs` — 同じ時点の PostgreSQL を NDJSON と manifest に書き出し、空の PostgreSQL に戻す。`cloud-pg-export.mjs` は `cloud-worker.mjs` の scheduled から呼ぶ（`DATABASE_ENGINE=postgres` と `PG_EXPORTS` の束ねがある環境だけ。いまは env.staging）。書き出し専用の R2 と30日の期限は代表が `scripts/pg-exports-bucket.ps1` で作る（core の runbooks/05 手順14）。世代から戻す練習は代表が `scripts/pg-drill-restore.ps1`（練習 F。手元の Docker へ戻して照合）と `scripts/pg-drill-pitr.ps1`（練習 E。PlanetScale の PITR の drill のブランチと照合）で流す（共通の部品は `pg-drill-common.ps1`。core の runbooks/03）
- `src/schema.sql`、`src/` 直下と業務フォルダの `*.sql` — 表の定義
- `src/<業務>/` — 業務ごとのフォルダ（下の表）。`*-routes.mjs` が API の受け口、`*-model.mjs` が計算と判定、`*.sql` が表、`*.jsx` が画面
- `migrations/` — D1 の移行ファイル（連番）。`migration-manifest.json` は表と構造の照合表
- `pg/schema.sql` — PostgreSQL の DDL。`migrations/` から `scripts/pg-ddl.mjs` が生成する（手で直さない。`--check` で一致を見る。照合は `test/pg-ddl.test.mjs`）
- `scripts/seed-staging.mjs` — 空の移行済みDBの売上デモを記録し、`data/staging-seed/` にD1・PGのSQLを生成する。`pg/staging-*.sql` と `scripts/pg-staging.ps1`・`d1-staging-member.ps1` は代表が手順書13で使う（AIは外部操作をしない）
- `test/` — `*.test.mjs`（フォルダ分けなし）と、架空データを作る `*-fixture.mjs`
- `docs/rules/` — 開発ルールの正本（索引は `docs/rules/README.md`）。守れる部分は `test/*-rules.test.mjs`・`test/dependency-rules.test.mjs`・`test/requirements-trace.test.mjs` が検査する。Claude Code には core の `.claude/rules/` の写しが自動で読まれる
- `docs/requirements/` — 要件定義。プロダクトの要件1枚（`docs/requirements/README.md`）と、工程の要件（`docs/requirements/<領域>/<工程>.md`）
- `scripts/` — 架空データの投入（`seed-*.mjs`）、確認（`verify-*.mjs`）、プレビューの作成、移行の照合（`ci-migrations.mjs`）、取込から予実までの時間の計測（手元の DB は `measure-d1-baseline.mjs`、動いているアプリへ向けるのは `measure-staging.mjs` と代表が流す `measure-staging.ps1`。共通の部品は `measure-common.mjs`）
- `python/` — 文書抽出と分析（本番では Container で動く）
- `fixtures/`・`demo-fixtures/`・`public/` — 架空の取込ファイル、その生成スクリプト、画面で配るデモ資料
- `wrangler.cloud.jsonc` — 本番の Worker 構成。`wrangler.jsonc` は配備しない準備用

### いまの業務フォルダ（`src/` の下。移す先の領域）

領域フォルダへ移すまでの、いまの形。行き先は、会社ルートの plans フォルダの計画（2026-09-29-integrated-src-restructure.md）にある。

| フォルダ | 領域 | 中身 |
|---|---|---|
| `sales-ops/` | 営業 `sales` | 取引先別リスト、リリースウィンドウ、リリース提案、パイプライン |
| `broadcast/` | 営業 `sales` | 放送ウィンドウ、提案と下書き、承認、放送履歴、アベイルズリスト |
| `import/` | 売上 `revenue` | 売上報告の取込ウィザード（見出しの検出、文字コード、行数の上限）、原本の保存 |
| `sales-sheet/` | 売上 `revenue` | 売上集計シート |
| `sales/` | 売上 `revenue` | 売上明細、リリース月 |
| `billing/` | 売上 `revenue` | 入金、売掛 |
| `progress/` | 売上 `revenue` | 取引先の報告の受領状況（未受領・取込済・請求済・入金済） |
| `expense-sheet/` | 経費 `expenses` | 経費集計シート、請求書、取込と保留、出金予定、会計の設定 |
| `expense-accounting/` | 経費 `expenses` | 支払の仕訳（前払い・返金・カード払い・相殺・源泉の納付）と PL/BS への反映 |
| `royalty/` | 精算 `settlement` | ロイヤリティの契約、期間、台帳、報告書 |
| `committee/` | 精算 `settlement` | 製作委員会の月次収支、条件版の規則 |
| `rights/` | 精算 `settlement` | 権利と委員会の画面用の整形 |
| `reports/` | 会計 `accounting` | 帳票センターの各帳票（年次、売掛、MG、作品別収支、ロイヤリティ明細、PL/BS の計算） |
| `pl-bs/` | 会計 `accounting` | PL/BS の画面、支払の操作 |
| `work/` | 台帳 `ledger` | 作品ごとの経費、配賦、宣伝、提案の設定、制作の印刷 |
| `master-extensions/` | 台帳 `ledger` | 作品と商品のマスタの版 |
| `partners/` | 台帳 `ledger` | 取引先のプロフィール |
| `bulk/` | 管理 `admin` | Excel での一括入出力 |
| `admin/` | 管理 `admin` | チーム、データ閲覧、ER 図、項目の拡張、取込履歴 |

`src/` の直下には、まだ業務フォルダに分かれていないファイルが残っている。探すときは、業務フォルダと直下の両方を見る。

| 領域 | 直下のファイル |
|---|---|
| 制作 `production` | `workflow.mjs`（台本を読み取り、シーン・撮影日・割り当てを作って確定）、`production.mjs`（シーンの詳細と出演の保存）、`production-plans.mjs`（ロケ地の見取り図の上限）、`Production*.jsx`、`FieldOperations.jsx`（準備タスク）、`Workflow.jsx` |
| 営業 `sales` | `broadcast*.mjs`、`commercial.mjs`（営業資料）、`SalesOperations.jsx`、`BroadcastWorkspace.jsx` |
| 売上 `revenue`（取込） | `workbench*.mjs`、`channel-sales.mjs`、`Workbench.jsx`、`transforms/` |
| 精算 `settlement` | `mg*.mjs`、`committee*.mjs`、`rights-*.mjs`、`royalty-statement-routes.mjs`、`Settlement.jsx` |
| 会計 `accounting`（帳票・収支） | `report-*.mjs`、`reporting*.mjs`、`work-pnl-report-routes.mjs`、`IncomeDashboard.jsx` |
| 会計 `accounting`（税） | `tax.mjs`、`TaxLedger.jsx` |
| 共通基盤 `core`（ホーム）・台帳 `ledger`（作品） | `work-queue.mjs`・`HomeQueue.jsx`（次に対応すること）、`catalog.mjs`（作品カタログ） |
| 共通基盤 `core`（本番環境での実行） | `cloud-*.mjs`、`production-gateway.mjs`、`server-production.mjs` |

ファイル名の production は、「制作」と「本番」の両方の意味で使われている。制作は `production.mjs` と `production-plans.mjs`、本番は `production-gateway.mjs` と `server-production.mjs` である。

## 主要コマンド（このフォルダで実行する）

- `npm ci --ignore-scripts` — 依存を入れる（初回だけ）
- `npm run build` のあと `npm start` — ローカルで起動する（`http://127.0.0.1:9041`。架空の `.invalid` メンバーでログインする）
- `node --test test/<名前>.test.mjs` — テストを1本だけ流す。計算だけのテストは、依存を入れなくても1秒かからずに終わる
- `npm test` — 全テストを1本ずつ順に流す。文書抽出のテストには `ON_PYTHON` で Python の場所を渡す（README）
- `npm run test:changed`・`npm run test:pg:changed` — `scripts/select-tests.mjs` が差分＋T0から選ぶ。PG は `sqliteOnly` を除く。全体が選ばれた場合の PG は CI に委ねる（`docs/rules/testing.md`）。対応表は `test/select-map.json`、選択の記録は `node scripts/select-tests.mjs --json`
- `npm run ci:migrations` — 空の D1 に全移行を当て、表・外部キー・`migration-manifest.json` を照合する
- `node scripts/seed-all-demo.mjs --db data/demo-sales.sqlite` — 架空データの組織 `DEMO-SALES` を別の DB ファイルに作る
- `node scripts/seed-staging.mjs` — staging専用のD1・PostgreSQL用seedを同じ記録から作る（外部接続なし。適用はcoreの `docs/platform/operations/runbooks/13-planetscale-schema.md`）
- 画面で確かめる — core のルートで `node .claude/skills/verify/scripts/verify.mjs launch`（使い捨ての DB で起動する）

`public/demo-fixtures/` の見本ファイル（CSV・XLSX）は git に入れず、`npm test` と `npm run build` の前処理が作る。見本を読むテストを1本だけ流すときは、先にどちらかを1回流しておく。

## 作業の前に読むもの

触るものに当てはまる文書を先に読む。複数当てはまるときは全部読む。

| 触るもの | 先に読む文書 |
|---|---|
| 工程を作る・直す（まず何を作るか） | `docs/requirements/README.md` と該当する工程の要件、`docs/rules/requirements.md` |
| `src/` のファイル（足す・動かす・直す） | `docs/rules/architecture.md` |
| テスト | `docs/rules/testing.md` |
| エラー処理・ログ・変更の記録 | `docs/rules/logging.md` |
| 表の定義・SQL・`migrations/` | `docs/rules/database.md` |
| 金額・率・外貨（持つ・計算する・読む・表示する） | `docs/rules/money.md` |
| SQL の書き方（D1 と PostgreSQL の両方で動く形） | `docs/rules/dialect.md` |
| PR を出す前・レビュー | `docs/rules/review.md` |
| ルールを足す・直す | `docs/rules/README.md` |
| 画面・API・権限 | core の `.claude/skills/verify/SKILL.md` と、`.claude/skills/verify/features/` の該当する機能 |
| 移行の照合の手順 | `README.md` の「GitHub登録版の検証」 |
| 売上の取込・流通別の項目 | core の `docs/uriage/channel-sales-import-implementation.md` |
| ロイヤリティ・製作委員会 | core の `docs/platform/team-development/royalty-committee-design.md` |
| D1 への書き込みの上限 | `README.md` の「売上基幹の架空データ」と `src/d1-limits.mjs` |
| 本番の設定・配備・CI | core の `docs/platform/operations/README.md` と `docs/platform/operations/ci-contract.md` |

文書どうし、または文書と依頼が食い違うときは、推測で埋めずに作業を止め、食い違いを報告する。

業務フォルダ・入口・コマンドを足したり動かしたりしたときは、同じ PR でこの地図も直す。
