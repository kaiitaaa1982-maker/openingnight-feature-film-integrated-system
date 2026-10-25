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
- `pg/schema.sql` — PostgreSQL の DDL。`migrations/` から `scripts/pg-ddl.mjs` が生成する（手で直さない。`--check` で一致を見る。照合は `test/pg-ddl.test.mjs`）。移行ごとの節の指紋は `pg/ddl-sections.json`（生成物。CI が直前の版と比べ、既存の節が変わらず新しい節だけが増えることを見る）
- `scripts/pg-migrate.mjs` — 差分の移行。動いている PostgreSQL の版の印から起点を決め、起点より新しい移行だけの差分（`pg-ddl.mjs` の `convertDelta`）と照合の SQL を作り（`plan`）、node で1つのトランザクションで当てる（`apply`）。定義の写しと比べ（`snapshot`・`compare`）は `scripts/pg-definition.mjs`。試験は `test/pg-migrate.test.mjs`。staging は代表が `scripts/pg-staging.ps1 -Action migrate-dryrun`・`migrate`（core の runbooks/13）、練習 G は `scripts/pg-drill-migrate.ps1`（core の runbooks/03）
- `scripts/seed-staging.mjs` — 空の移行済みDBの売上デモを記録し、`data/staging-seed/` にD1・PGのSQLを生成する。`pg/staging-*.sql` と `scripts/pg-staging.ps1`・`d1-staging-member.ps1` は代表が手順書13で使う（AIは外部操作をしない）
- `test/` — `*.test.mjs`（フォルダ分けなし）と、架空データを作る `*-fixture.mjs`。`test/fixtures/<名前>/` は独立に作った正解つきの架空データ（生成スクリプト込み。例: 入金の確認の `test/fixtures/receipt-matching/`、それを入金の行に使う案件収支の予実の種と golden `test/fixtures/yojitsu/`。行動指標の計画 段B の golden は、その種を延長する `test/fixtures/yojitsu/kpi-seed.json` から `test/fixtures/yojitsu/build-kpi-expected.mjs` が src を読まずに `kpi-expected.json` を作る）。import でたどれないので、フォルダを足したら `test/select-map.json` に読む試験との対応を足す。読む元の fixture を作り直したら、それを読む fixture も作り直す（予実の golden の `golden.py` は会社ルートの ORG/事業計画/_build/build_yojitsu.py を読むので、手元で `--build-yojitsu` か環境変数 `ON_BUILD_YOJITSU` を渡す）
- `docs/rules/` — 開発ルールの正本（索引は `docs/rules/README.md`）。守れる部分は `test/*-rules.test.mjs`・`test/dependency-rules.test.mjs`・`test/requirements-trace.test.mjs` が検査する。Claude Code には core の `.claude/rules/` の写しが自動で読まれる
- `docs/requirements/` — 要件定義。プロダクトの要件1枚（`docs/requirements/README.md`）と、工程の要件（`docs/requirements/<領域>/<工程>.md`）
- `scripts/` — 架空データの投入（`seed-*.mjs`）、確認（`verify-*.mjs`）、プレビューの作成、移行の照合（`ci-migrations.mjs`）、取込から予実までの時間の計測（手元の DB は `measure-d1-baseline.mjs`、動いているアプリへ向けるのは `measure-staging.mjs` と代表が流す `measure-staging.ps1`。共通の部品は `measure-common.mjs`）
- `goals/` — Claude Code の /goal で回すループの目標（1つの goal に1つの md）と、その記録。goal の書き方・指標の一覧・指標の足し方は `goals/README.md`。指標は `scripts/metrics.mjs` が JSON で出し、goal の閾値と比べて合否（goal_check）を返す（試験の件数は `scripts/metrics-reporter.mjs` が node --test から受け取る）
- `formal/` — 形式検査。`receipt_matching.py` は入金の消込の不変条件を Z3 で確かめる（いまの API・DB のトリガーと、入金の確認の計画 #6 の控除の決まりを写した模型。わざと壊した版で反例が出ることも見る。#6 の着手前に決める未決の点は `OPEN_DECISIONS`、#6 で同じ PR で直すことはスクリプトの冒頭）。`receipt_matching_cases.json` は見つけた反例を写した試験の入力（と取消の登録順の入力）で、`test/billing.test.mjs` が API へ、`test/receipt-model.test.mjs` が入金フォームの論理へ流す。CI は core の `ci.yml` の formal ジョブ
- `python/` — 文書抽出と分析（本番では Container で動く）
- `fixtures/`・`demo-fixtures/`・`public/` — 架空の取込ファイル、その生成スクリプト、画面で配るデモ資料
- `wrangler.cloud.jsonc` — 本番の Worker 構成。`wrangler.jsonc` は配備しない準備用

### いまの業務フォルダ（`src/` の下。移す先の領域）

領域フォルダへ移すまでの、いまの形。行き先は、会社ルートの plans フォルダの計画（2026-09-29-integrated-src-restructure.md）にある。

| フォルダ | 領域 | 中身 |
|---|---|---|
| `acquisition/` | 企画 `planning`（権利調達） | 支払う MG（権利元へ払う MG。買付分。計画は会社ルートの plans の 2026-10-22-folder-mg-buy）。表は移行 0026の acq_mg_*（契約・条件版・対象の作品・分配の前に引く費目・周期・媒体ごとの配分・支払予定・売上報告の結び付け・分配報告書・原本の結び付き）。回収の計算（回収累計・残高・超過・分配額・作品ごとの分配額・例外・検査）は純関数の `src/acquisition/acq-mg-recoup.mjs`（正解表は `test/fixtures/acq-mg-recoup/cases.json`）、DB の読み書きは `src/acquisition/acq-mg-store.mjs`、受け口（/api/acq-mg/*。制作担当は 403、対象の作品すべての財務権限）は `src/acquisition/acq-mg-routes.mjs`、業務画面「MG 買付」（売上基幹 › MG）は `src/acquisition/AcqMgBuy.jsx`。分配報告書の発行・原本・支払の記録と仕訳・古い支払 MG の入口を閉じることは次の区切り |
| `planning/` | 企画 `planning` | 案件の型・稼ぎ方・段階と確度・基準額・売上率と、その参照表・段階の履歴・区分マスタ（移行 0012）、受託制作の契約の版（総製作費・受託費率・受託費・支払いの節目。移行 0013）。DB の読み書きは `src/planning/planning-store.mjs`、入力の判定と売上率の導き方は `src/planning/project/project-model.mjs`、契約の版の入力の判定・受託費・節目ごとの額は `src/planning/contract-production/contract-production-model.mjs`、受け口（/api/planning/projects/:projectId/contract-versions）は `src/planning/contract-production/contract-production-routes.mjs`、その入力の画面（「企画・作品」の案件の下。総製作費・受託費率・節目の版を足す。行動指標の計画 #3）は `src/planning/contract-production/ContractProductionPanel.jsx` と欄の文字と本文の行き来の `contract-version-form-model.mjs`。稟議の版（自社出資の申請・承認・却下・払込の4状態の版。移行 0019。行動指標の計画 段B #4）の読み書きも `src/planning/planning-store.mjs`、版の流れ・入力の判定・いまの状態と出資枠は `src/planning/investment-approval/investment-approval-model.mjs`、受け口（/api/planning/investment-approvals と /api/planning/projects/:projectId/investment-approvals）は `src/planning/investment-approval/investment-approval-routes.mjs`。予算書（要件 `docs/requirements/planning/budget-book.md`。費目 A〜K の版と確定）の合計・検査・版の比べ方・進み具合は `src/planning/budget/budget-model.mjs`、予算書 xlsx の読み取り（保存された値・数式・塗りを見出しの名前で読む）は `src/planning/budget/budget-xlsx.mjs`、金額の式（消費税・単価×数量・増減の比を BigInt で）は `src/planning/budget/money-budget.mjs`、予算書の4表（移行 0024）の読み書きは `src/planning/budget/budget-store.mjs`、受け口（GET /api/planning/budgets と /api/planning/projects/:projectId/budget、POST …/budget/versions・import・fixes）は `src/planning/budget/budget-routes.mjs`、画面（ページ ID `予算書`、`?p=budget`。予算書と型のタブ）は `src/planning/budget/Budget.jsx`。予算書の型（テンプレの版）と行の内訳（移行 0028）の読み書きも `budget-store.mjs`、受け口（/api/planning/budget-templates と …/xlsx、予算書の版の …/versions/:versionNo/xlsx）も `budget-routes.mjs`、予算書と型の xlsx の書き出し（合計は数式・内訳は別シートの SUMIF）は `src/planning/budget/budget-xlsx-write.mjs`。プロデュース管理の進行表（要件 `docs/requirements/planning/produce-progress.md`。チケットの版・着手と完了・チェック項目・掲示板・関連する場所・テンプレート。移行 0047）の状態と上の箱の導き方・標準の進行は `src/planning/produce/produce-model.mjs`、7表の読み書きは `src/planning/produce/produce-store.mjs`、受け口（/api/produce/projects・/api/produce/templates ほか）は `src/planning/produce/produce-routes.mjs`、画面（ページ ID `プロデュース管理`、`?p=produce`。フォルダの形の入口とカレンダー）は `src/planning/produce/ProduceBoard.jsx`。企画（フォルダ原案 F01。要件 `docs/requirements/planning/kikaku.md`。移行 0050）の3段の試算の計算・4つの揃い・企画書の準備ボードは `src/planning/kikaku/kikaku-model.mjs`、DB の読み書きは `kikaku-store.mjs`、受け口（/api/planning/kikaku…）は `kikaku-routes.mjs`、画面（ページ ID `企画`、`?p=kikaku`）は `Kikaku.jsx`。原本は共通の原本の表（`source_documents`）を指す |
| `acquisition/chotatsu/` | 企画 `planning` | 調達（フォルダ台帳 F19。会社ルートの plans/2026-10-24-folder-chotatsu.md）。MG を払わない販売権の調達を希望から製造へ渡すまで。表は移行 0052 の chotatsu_*、読み書きは `chotatsu-store.mjs`、段・粗利の見込み・素材の期限・検査は `chotatsu-model.mjs`（金額の式は `money-chotatsu.mjs`）、受け口（/api/chotatsu/*。製造が読む /api/chotatsu/handoffs）は `chotatsu-routes.mjs`、画面（ページ ID `調達`、`?p=chotatsu`）は `Chotatsu.jsx`。契約の段で調達案件（entrusted）と配給委託の契約（commission）を作る。全作品のウィンドウへの下書きは営業の `src/sales-ops/release-window-draft-store.mjs` |
| `sales-ops/` | 営業 `sales` | 取引先別リスト、リリースウィンドウ、リリース提案、パイプライン |
| `manufacturing/` | 営業 `sales` | 製造（会社ルートの plans/2026-10-24-folder-seizou.md。移行 0046。番号は仮）。逆算の型（25日の型・日数の型の12工程）・工程の状態・発注書の段の導き方は `mfg-model.mjs`、8表の読み書きは `mfg-store.mjs`、受け口（/api/mfg/products・/api/mfg/orders/:id/events・/api/mfg/order-lines/:id/receipts と expenses）は `mfg-routes.mjs`、画面（ページ ID `製造`、`?p=mfg`。制作担当には出さない）は `Manufacturing.jsx` |
| `broadcast/` | 営業 `sales` | 放送ウィンドウ、提案と下書き、承認、放送履歴、アベイルズリスト |
| `import/` | 売上 `revenue` | 売上報告の取込ウィザード（見出しの検出、文字コード、行数の上限）、原本の保存 |
| `sales-sheet/` | 売上 `revenue` | 売上集計シート |
| `sales/` | 売上 `revenue` | 売上明細、リリース月 |
| `billing/` | 売上 `revenue` | 入金、売掛 |
| `revenue/` | 売上 `revenue` | シナリオの比較（`revenue/scenario/`。計算の model、要求の本文の形、実績の読み取り、比較の API、需給の曲線、画面〔`ScenarioCompare.jsx`＝配置、`use-scenario-compare.mjs`＝状態、`ScenarioResults.jsx`＝結果の表示、`ScenarioInputs.jsx`＝入力〕と、入力・表示の model〔`scenario-form-model.mjs`・`scenario-view-model.mjs`〕）。入口は売上基幹の計上の「シナリオの比較」（全表示だけ。代表モードの11画面には入れない） |
| `progress/` | 売上 `revenue` | 取引先の報告の受領状況（未受領・取込済・請求済・入金済） |
| `revenue/` | 売上 `revenue` | 売上の領域フォルダ（新しい工程の置き場）。案件収支の予実の期間・目標の版・計画の版と採用の記録・設定の行（移行 0014。フェーズ1 #11）の DB の読み書きは `src/revenue/revenue-store.mjs`（目標の読み取り関数 readTargets と計画の readPlans は額を owner 本人にだけ返す）、有効な版の選び方・月割り・本人だけの額は `src/revenue/yojitsu/yojitsu-model.mjs`。案件×月の予測の版と活動記録とその取消（移行 0015。フェーズ1 #13）の読み書きも `src/revenue/revenue-store.mjs`（活動記録の行の中身は readActivityRecords が記録した本人にだけ返し、件数は readActivityTallies）、予測の版の入力・有効な版・区分×月の収支は `src/revenue/yojitsu/forecast-model.mjs`、活動記録の入力と行動の実績件数・携わった案件数の数え方は `src/revenue/yojitsu/activity-model.mjs`、企画の試算の写し（trials_snapshot.json の形）の読み方と照合は `src/revenue/yojitsu/trial-import-model.mjs`、その受け口（/api/revenue/forecast-imports）は `src/revenue/yojitsu/forecast-import-routes.mjs`。予実の4段（目標→行動→予測→実績。入金ベース固定。フェーズ1 #14）の受け口（/api/revenue/yojitsu）は `src/revenue/yojitsu/yojitsu-routes.mjs`、組み立ては `src/revenue/yojitsu/yojitsu-model.mjs` の buildYojitsuView、料率の額・比・件数の逆算の式は `src/revenue/yojitsu/money-yojitsu.mjs`、入金を案件に結ぶ規則は `src/revenue/yojitsu/receipt-inflow-model.mjs`。4段が読むもの（目標を除く）は revenue-store の readYojitsuSources が1回の読み取りの一括で読み、語を選ぶ設定と月の設定（採用するシナリオ・月別の表に入れる案件の範囲・締めた月。移行 0018）の読み書きも revenue-store。売上の4区分（`src/revenue/revenue-class/`。案件の型・稼ぎ方・契約から導き、入金の行を4区分と稼ぎ方別に集計する `src/revenue/revenue-class/revenue-class-model.mjs` と、案件ごとの区分を返す受け口 `src/revenue/revenue-class/revenue-class-routes.mjs`（/api/revenue/revenue-classes）。表は持たず `src/planning/planning-store.mjs` を読む）。本人の倍率の API（行動指標の計画 段B #8。GET /api/revenue/metrics/self-multiplier。目標の版の持ち主にだけ年の目標の倍率と額・人件費・年の粗利・本人の倍率を返し、本人以外は管理者も 403）は `src/revenue/metrics/self-multiplier-routes.mjs`、期間ごとの行と持ち主の判定は `self-multiplier-model.mjs`、比の式は `money-metrics.mjs`。報酬の12か月の合計は `src/revenue/revenue-store.mjs` の readAnnualCompensations（報酬の表〈フェーズ1 #17〉が入るまで null）。指標マスタ（移行 0017。行動指標の計画 段B #9。役×稼ぎ方×段の対応と出どころの状態の版。段の率・1件の時間などの値は設定の行だけに持つ）の読み書きは `src/revenue/revenue-store.mjs` の addMetricMasterVersion・readMetricMaster、入力の読み取り・有効な版・段に設定の率と時間を添えるのは `src/revenue/metrics/metric-master-model.mjs`、架空の種（細目の段・最初の版・設定の行）は `test/fixtures/kpi-metrics/seed.json` を `scripts/seed-kpi-metrics-demo.mjs` が入れる（seed-all-demo.mjs にはまだ入れていない）。フォルダの見本（販売管理 › 売上報告書。木とマスは `src/revenue/folders/Folders.jsx`、1通の例外と数字は `SourceReview.jsx`、架空データは `folders-preview-model.mjs`。mode local かつ代表モード以外。U2b の受け口に `loadSalesReportYear` と `loadReview` を差し替える）。フォルダからの受け取り（販売管理 › 売上報告書）の必ず成り立つ検査は `src/revenue/folders/folders-checks.mjs`、型の実績・抜き取りの分母・判定の語は `src/revenue/folders/folders-record.mjs`、正解表の正答率は `src/revenue/folders/folders-cases.mjs`（3つとも純関数。表は読まない）。検査の決まりの版・正解表・検査の結果・抜き取りの記録は移行 0023 の `report_check_versions`・`report_check_cases`・`source_check_runs`・`source_sampling_reviews`。正解表の種を採点するコマンドは `scripts/run-check-cases.mjs`（画面はまだ無い） |
| `expense-sheet/` | 経費 `expenses` | 経費集計シート、請求書、取込と保留、出金予定、会計の設定 |
| `expenses/` | 経費 `expenses` | 経費の領域フォルダ（新しい工程の置き場）。制作費の版（移行 0016。フェーズ1 #5。成功報酬の線にする制作費を作品ごとの連番・追記だけで持つ）の DB の読み書きは `src/expenses/expenses-store.mjs`、出資の記録の選び方・入力の判定・登録できる人・状態（registered・tax_unknown・unregistered）は `src/expenses/production-cost/production-cost-model.mjs`、受け口（GET /api/expenses/works/:workId/production-cost と、最初の版を作る POST の from-investment・from-contract）は `src/expenses/production-cost/production-cost-routes.mjs` |
| `expense-accounting/` | 経費 `expenses` | 支払の仕訳（前払い・返金・カード払い・相殺・源泉の納付）と PL/BS への反映 |
| `royalty/` | 精算 `settlement` | ロイヤリティの契約、期間、台帳、報告書 |
| `mg-sell/` | 精算 `settlement` | 受取 MG（販売分）の作品一覧（回収・償却期間・到達見込み）。契約・台帳の本体はいまの `mg*.mjs`・`MgLedger.jsx` |
| `committee/` | 精算 `settlement` | 製作委員会の月次収支、条件版の規則。契約の式・日程・収支の台帳の計算（`committee/ledger/`。純関数で表は読まない。事業ごとの式と委員会全体の式は `committee-formula-model.mjs`、締め・報告・支払の回は `committee-schedule-model.mjs`、台帳の行・収支報告書・相手ごとの累計は `committee-ledger-model.mjs`、型・条件版の式・日程の版・台帳の DB の読み書きは `committee-ledger-store.mjs`〈移行 0042〜0044〉、受け口（/api/committee/ledger/…）は `committee-ledger-routes.mjs`、画面（売上基幹 › 製作委員会 › 契約の式と台帳）は `CommitteeLedger.jsx`。要件は `docs/requirements/settlement/committee.md`） |
| `rights/` | 精算 `settlement` | 権利と委員会の画面用の整形 |
| `reports/` | 会計 `accounting` | 帳票センターの各帳票（年次、売掛、MG、作品別収支、ロイヤリティ明細、PL/BS の計算）。計上と入金の切り替え（`basis=accrual\|cash`。フェーズ1 #16）の語・引数の読み方と入金ベースの税抜換算（U-5 まで仮の出し方。税抜にできない入出金は「未確定」）、入金ベースの PL は `reports/pl-bs-cash-model.mjs`（PL の本体 `pl-bs-model.mjs` を cash: true で動かし、BS は計上と同じ） |
| `pl-bs/` | 会計 `accounting` | PL/BS の画面、支払の操作。入出金の記録の読み取り（`pl-bs-data.mjs` の loadCashSide。入金ベースの PL・作品別収支・作品の月別収支が読む） |
| `accounting/` | 会計 `accounting` | 作品の月別収支の API（売上明細を作品へ配り、経費と月別に並べる。`accounting/work-income/` の受け口と計算）。作品別収支の文書データ（`accounting/work-pnl/work-pnl-document.mjs`。帳票の文書データの型の最初の1本で、画面・Excel・印刷がこれ1つから出る。出す側と関門は `src/report-output.mjs` の document で始まる関数）。入金ベース（フェーズ1 #16）の作品別収支の行は `accounting/work-pnl/work-pnl-cash-model.mjs`、作品の月別収支は `accounting/work-income/work-income-model.mjs` の buildWorkIncomeCash、画面の基準ごとの言葉は `accounting/work-income/work-income-view-model.mjs`。会社への利益額（K-16。フェーズ1 #14b）の受け口（/api/accounting/profit?basis=）は `accounting/profit/profit-routes.mjs`、費目（確定・未確定・除外・未接続）と計算は `accounting/profit/profit-model.mjs`（入金を案件に結ぶ規則は予実の4段と同じ `revenue/yojitsu/receipt-inflow-model.mjs`）。DB の読み取りは `src/accounting/accounting-store.mjs`（利益額は readProfitSources の1回の読み取りの一括）。利益の5源泉の集計（行動指標の計画 段B。置き場は計画の K2-1）のうち、源泉1 制作受託の導き方（受託費×締めた月までの節目の割合と入金の予定）は `src/accounting/profit/contract-work-source-model.mjs` で、材料は `src/planning/planning-store.mjs` の readContractWorkSourceRows（受託制作の契約の版の持ち主は企画）。源泉2 自社出資の出資と回収（出資額＝稟議の払込の累計、収益＝利益額の入金の基準の確定の売上、差額・回収率・払込の判定）は `src/accounting/profit/own-investment-source-model.mjs`。利益額の自社出資の出資額は稟議の払込の版から引く（readProfitSources が委員会への自社の払込と1つの文で読む）。源泉別の内訳（5つの源泉の売上・出資額・経費・粗利と、会社への利益額との突き合わせ。段B #2）は `src/accounting/profit/source-profit-model.mjs` で、受け口は /api/accounting/profit/sources（`accounting/profit/profit-routes.mjs`。材料は `src/accounting/accounting-store.mjs` の readSourceProfitSources）。入出金の履歴（会計の最初の組。口座・銀行の明細の取込・仕訳。移行 0045_cashbook）は `src/accounting/cashbook/`: 明細の CSV の読み取り・重なりの鍵・履歴と残高の累計・銀行との照合は `cashbook-model.mjs`、5表の読み書きは `cashbook-store.mjs`、受け口（/api/cashbook と /api/cashbook/accounts/:accountId・preview・imports・manual、/api/cashbook/entries/:entryId/classify。管理者だけ）は `cashbook-routes.mjs`、画面（ページ ID `入出金`、`?p=cashbook`）は `Cashbook.jsx` |
| `work/` | 台帳 `ledger` | 作品ごとの経費、配賦、宣伝、提案の設定、制作の印刷 |
| `master-extensions/` | 台帳 `ledger` | 作品と商品のマスタの版 |
| `partners/` | 台帳 `ledger` | 取引先のプロフィール |
| `bulk/` | 管理 `admin` | Excel での一括入出力 |
| `admin/` | 管理 `admin` | チーム、データ閲覧、ER 図、項目の拡張、取込履歴 |
| `source-documents/` | 共通 `core` | 業務を問わない共通の原本の表 `source_documents`（移行 0025。追加のみ・組織内で SHA-256 一意・12MB まで inline、それより大きい映像などは external）の読み書き `src/source-documents/source-documents-store.mjs`（受け取り・1通・一覧・場所の移動）。外の置き場の移動は `source_document_moves`（移行0056）へ追記し、1通・一覧は最新の場所と `originalLocation` を返す（FR-CORE-DATA-062〜064）。目録の取り込みは移動も事前確認・記録する。業務の表は原本を持たず、この表の ID を指す結び付きの表を業務ごとに持つ（FR-CORE-DATA-056〜060）。R2 目録の解析・種類・名前の復元は純関数 `src/source-documents/r2-manifest.mjs`、管理者の取り込み受け口（POST /api/source-documents/import-r2-manifest。事前確認と external 登録）は `src/source-documents/r2-manifest-routes.mjs`（FR-CORE-DATA-061。R2 への接続なし） |
| `production/` | 制作 `production` | 台本の構造化（左に原本、右に読み取ったシーンと出どころを並べて確かめる画面と、原本を返す受け口。`src/production/script-structuring/`）。DB の読み書きは `src/production/production-store.mjs`。ほかの制作の処理はまだ下の表の直下のファイル。ポストプロダクション（要件 `docs/requirements/production/post-production.md`。移行 0048 の7表）の状態の導き方・入力の判定・TC と Vimeo の埋め込みの URL は `src/production/post/post-model.mjs`、読み書きは `src/production/post/post-store.mjs`、受け口（/api/post/works と /api/post/works/:workId、POST …/cuts・notes・notes/:noteId/actions・tasks・tasks/:taskId/events・deliverables・deliverables/:itemId/events）は `src/production/post/post-routes.mjs`、画面（ページ ID `ポスプロ`、`?p=post`）は `src/production/post/PostProduction.jsx` |
| `preprod/` | プリプロ `preprod` | フォルダ原案 F03 プリプロダクションの業務画面（ページ ID `プリプロ`、`?p=preprod`）。要対応・子フォルダの帯・数字と、オールスタッフ／美術打ち合わせの資料の導き方は `src/preprod/preprod-model.mjs`（純関数。既存の GET /api/production・/api/workflow/scripts・/api/field の返り値から導き、表を持たない）、画面は `src/preprod/Preprod.jsx`。手配・美術の項目・シーンの撮影の方針（移行 0053。版で追記だけ。金額は持たない）の受け口と入力の判定は `src/preprod/preprod-routes.mjs`、DB の読み書きは `src/preprod/preprod-store.mjs`、噛み合いの確かめ（手配の期間・締切・美術の未決と搬入）は preprod-model の planChecks。保管庫（原本は共通の source_documents、置き場の記録は移行 0054 の追記だけの表）の受け口は `src/preprod/vault-routes.mjs`、DB の読み書きは `src/preprod/vault-store.mjs`、種類の提案といまの置き場は `src/preprod/vault-model.mjs`、画面は `src/preprod/Vault.jsx`。連絡帳（共通の部品。移行 0055 のスペース・連絡・既読と了解）は `src/notebook/`（受け口 notebook-routes.mjs、DB の読み書き notebook-store.mjs、型と欄の入れ方 notebook-model.mjs、画面 Notebook.jsx）。計画は会社ルートの plans/2026-10-22-folder-preprod.md |
| `production/` | 制作 `production` | 台本の構造化（左に原本、右に読み取ったシーンと出どころを並べて確かめる画面と、原本を返す受け口。`src/production/script-structuring/`）。撮影の記録（撮影日×記録の種類のマス目・1日の画面・撮影の結果・撮影日の原本・日報の項目。移行 0051。`src/production/shoot-records/`）。DB の読み書きは `src/production/production-store.mjs`。ほかの制作の処理はまだ下の表の直下のファイル |

`src/` の直下には、まだ業務フォルダに分かれていないファイルが残っている。探すときは、業務フォルダと直下の両方を見る。

- 共通原本の検索（GET /api/source-documents。管理者・編集者、組織内・中身なし・上限200件）は `src/source-documents/source-documents-routes.mjs`。既存の一覧の store を使う
- 企画への既存原本の結び付け（POST /api/planning/kikaku/:projectId/documents/link）は `kikaku-routes.mjs`。原本の段の「置き場」から検索・選択する画面は `src/planning/kikaku/DocumentPicker.jsx`

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
- `npm test` — 全テストを1本ずつ順に流す。文書抽出のテストには `ON_PYTHON` で Python の場所を渡す（README）。`-- --test-shard=i/n` で名前順に n 本おきの i 組目だけ（CI は2組。旗は `scripts/test-npm.mjs` が読む）
- `npm run test:changed`・`npm run test:pg:changed` — `scripts/select-tests.mjs` が差分＋T0から選ぶ。PG は `sqliteOnly` を除く。全体が選ばれた場合の PG は CI に委ねる（`docs/rules/testing.md`）。対応表は `test/select-map.json`、選択の記録は `node scripts/select-tests.mjs --json`
- `npm run ci:migrations` — 空の D1 に全移行を当て、表・外部キー・`migration-manifest.json` を照合する
- `npm run -s metrics` — 試験の本数・FR の状態の件数・借りの数を JSON で出す。`-- --tests <ファイル|changed|all>` で試験の結果、`-- --baseline <コミット>` で基準との比較、`-- --goal goals/<名前>.md` で goal_check の合否を足す（`goals/README.md`）
- `python formal/receipt_matching.py` — 消込の不変条件を Z3 で確かめる（`requirements-test.txt` を入れた venv の python で。`--show` で壊した版の反例を試験の入力の形に出す。終了コード 0＝成り立つ、1＝外れた、2＝入力の誤り）
- `node scripts/seed-all-demo.mjs --db data/demo-sales.sqlite` — 架空データの組織 `DEMO-SALES` を別の DB ファイルに作る
- `node scripts/seed-staging.mjs` — staging専用のD1・PostgreSQL用seedを同じ記録から作る（外部接続なし。適用はcoreの `docs/platform/operations/runbooks/13-planetscale-schema.md`）
- 画面で確かめる — core のルートで `node .claude/skills/verify/scripts/verify.mjs launch`（使い捨ての DB で起動する）

`public/demo-fixtures/` の見本ファイル（CSV・XLSX）は git に入れず、`npm test` と `npm run build` の前処理が作る。台本の構造化画面が原本の PDF を描くための pdf.js の文字の対応表（CMap）・標準の書体・WebAssembly を使わない画像の復号（JPEG 2000・JBIG2。`public/pdfjs/`）も、同じ前処理が `node_modules/pdfjs-dist` から写す（git に入れない）。見本を読むテストを1本だけ流すときは、先にどちらかを1回流しておく。

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
| PR を出す前・レビュー。開発の流れ（8ステップ）とループ（/goal）の対応を確かめるとき | `docs/rules/review.md` |
| 複数の業務が並行して PR を出す（移行の番号・共通のファイル・CI の費用） | `docs/rules/parallel-work.md` |
| ルールを足す・直す | `docs/rules/README.md` |
| 画面・API・権限 | core の `.claude/skills/verify/SKILL.md` と、`.claude/skills/verify/features/` の該当する機能 |
| 画面の見た目（色・形・書体・文言） | core の `docs/design/integrated-system-visual.md`（黒・白・灰＋赤1色。見本はフォルダ見本の Opening Night 配色。**不要なセカンダリラベルや説明を避け、レイアウトに説明させる**＝§5） |
| 移行の照合の手順 | `README.md` の「GitHub登録版の検証」 |
| 売上の取込・流通別の項目 | core の `docs/uriage/channel-sales-import-implementation.md` |
| ロイヤリティ・製作委員会 | core の `docs/platform/team-development/royalty-committee-design.md` |
| D1 への書き込みの上限 | `README.md` の「売上基幹の架空データ」と `src/d1-limits.mjs` |
| 本番の設定・配備・CI | core の `docs/platform/operations/README.md` と `docs/platform/operations/ci-contract.md` |

文書どうし、または文書と依頼が食い違うときは、推測で埋めずに作業を止め、食い違いを報告する。

業務フォルダ・入口・コマンドを足したり動かしたりしたときは、同じ PR でこの地図も直す。
