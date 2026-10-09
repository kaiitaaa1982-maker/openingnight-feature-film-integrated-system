# OpeningNight 映画DX 統合試作

企画、制作、商品、営業、売上報告、経費、収支、宣伝を、共通APIとリレーショナルDBで操作する統合試作です。ローカルの入力は `data/integrated.sqlite` に保存され、サーバーを再起動しても残ります。本人限定の `app.example.invalid` でもCloudflare D1に保存します。本番ERPのPostgreSQLやHP・既存5モックにはこの改修を適用していません。

## ローカル実行

Node.js 24 以上を使用します。固定した依存は `package-lock.json` にあります。

```powershell
npm ci --ignore-scripts
npm run build
npm start
```

## GitHub登録版の検証

文書抽出のテストにはPythonも必要です。Windowsでは次のように準備します。

```powershell
python -m venv .venv
& .venv/Scripts/python.exe -m pip install -r requirements-test.txt
$env:ON_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
npm test
npm run ci:migrations
```

Linuxでは `python3 -m venv .venv`、`.venv/bin/python -m pip install -r requirements-test.txt`、
`ON_PYTHON="$PWD/.venv/bin/python" npm test` を使います。依存の取得は準備時に行い、テスト本体は外部サービス・認証情報を使いません。

`pretest`・`prebuild`は、確認済みの架空CSVと読み取り可能なOOXMLソースから配布用サンプルを復元します。
元のExcelの値・数式・書式はOOXML各部品のハッシュで保持します。実契約書、業務DB、認証情報は含みません。
`fixtures/distribution-master.csv`は流通コード39種の設計要件です。取引記録や実績値を含まず、入力された空欄を維持します。

`ci:migrations`は専用一時フォルダに空のローカルD1を作り、全migration・構造manifest・外部キー・現行スキーマを照合します。
`migration-manifest.json`の表数は管理表`d1_migrations`を含みます。適用済み番号のSQLは変更せず、以後の変更は次の番号へ追加します。
初期SQLを既存本番へそのまま適用しないでください。既存D1と移行履歴の照合・登録は代表が別途実施します。
`pg/schema.sql`は`migrations/`から`node scripts/pg-ddl.mjs`で生成するPostgreSQLのDDLです（手で直さない）。`npm test`がPGliteで、CIがpostgres:18.6-alpineで、SQLiteと表・列・FK・索引・トリガーの組を照合します。最後の版の印の表（`schema_source_fingerprint`。PostgreSQLだけ）と`pg/verify-catalog.sql`で当てたDBの数と指紋を確かめ、`pg/reconcile.sql`（生成物）で表ごとの件数と金額の列の合計を出し、`scripts/pg-role-check.mjs`でアプリのロールの権限を確かめます。

Cloudflare・本番への操作、GitHub設定、Actions手動起動、PRマージは代表が行います。
運用手順の正本は [運用依頼書](../../docs/platform/operations/handoff-astra.md) です。

ブラウザで `http://127.0.0.1:9041` を開きます。サーバーは `127.0.0.1` にだけバインドし、Hostも `localhost` と `127.0.0.1` に制限します。ローカルログインは架空の `.invalid` メンバーだけを受け付け、ランダムなHttpOnly Cookieから所属・役割・案件権限をサーバーで解決します。

初期メンバー:

- `admin@openingnight.invalid`: 管理者
- `editor@openingnight.invalid`: 編集担当
- `production@openingnight.invalid`: 制作担当。財務API、作品予算、売上見込を取得できません
- `outsider@other.invalid`: 別組織。組織境界の確認用

管理者は「チーム」で、`.invalid` メール、案件、役割、有効期限を指定したローカル招待を準備し、参加確定・取消を試せます。メール送信や外部招待は行いません。

### 売上基幹の架空データ（DEMO-SALES）

計上・MG・ロイヤリティ・製作委員会の画面を、24か月分の数字で確かめるための架空データです。別組織 `DEMO-SALES`（架空データ（デモ））に入り、本物の組織とは混ざりません。
中身（作品20本・委員会8本・権利者20者・契約80件など）と場面の一覧は [設計書 §6](../../docs/platform/team-development/royalty-committee-design.md) にあります。

```powershell
node scripts/seed-sales-demo.mjs --db data/demo-sales.sqlite
$env:ON_DB_FILE = (Resolve-Path data/demo-sales.sqlite).Path; npm start
```

- `--db` は必須です。`data/integrated.sqlite` へは `--allow-main-db` を付けたときだけ投入します。`--as-of 2026-09-25`（既定）は報告書の一括作成と、報告・支払の記録の基準日です。
- 組織・利用者・所属だけを直接作り、残りは画面と同じAPIを通して登録します（約10秒）。2回流しても増えません。途中で止まったときは新しいファイルで流し直します。
- `demo-admin@openingnight.invalid` でログインすると `DEMO-SALES` だけが見えます。`admin@openingnight.invalid` は `DEMO-SALES` にも所属するので、上部の「組織」で切り替えられます。
- `test/seed-sales-demo.test.mjs` は、このデータの集計シート・報告書・委員会月次収支を、モデルの関数を使わずに元の行から計算し直して照合します。

制作・営業基幹・番販・放送・PL・BS の架空データも同じ組織に入ります。流す順（売上 → 制作 → 営業基幹 → 番販・放送 → PL・BS）の正本は `scripts/seed-all-demo.mjs` で、まとめて流せます。

```powershell
node scripts/seed-all-demo.mjs --db data/demo-sales.sqlite --twice --check-api
```

- `--twice` は2回目に増えないこと、`--check-api` は各画面の API が数字を返すことを確かめます。台本PDFの読み取りに `ON_PYTHON`（無ければ `python`）を使います。
- `--record <ファイル.jsonl>` は、API が発行した書き込みを batch の区切りのまま記録し、D1 の上限（DDL なし・1文の値は100個まで・1回の batch は480文まで・1つの値は128KB未満）を確かめます。`--record` のときの `--db` は本番DBの写しで、表の定義も試作用の行も流さずに開き、最新の移行まで当たっていない写しは断ります。記録の見出しに写しの指紋（表ごとの行数・主な表の最大ID・利用者と組織）が入り、再生（`replaySeedRecord`）は本番の指紋と合わなければ1文も当てません。再生は代表の運用手順で行います（[まとめの設計 §3](../../docs/platform/team-development/req4-integration.md)）。

## 構造

- `src/schema.sql`: SQLite/D1共通DDLと架空fixture
- `src/db.mjs`: Node 24 `node:sqlite` アダプター。ローカル起動時に追加SQLを適用
- `src/channel-sales.sql` / `src/source-controls.sql`: 流通別詳細、非売上観測、原本統制値、確定報告の封印
- `src/d1-db.mjs`: Node組込みを一切importしないWorker用D1アダプター
- `src/app.mjs`: Hono共通API、認可、CSV取込、分析、変更提案
- `src/committee.mjs`: 製作委員会の日程生成と符号付き整数円の分配計算
- `src/server.mjs`: `127.0.0.1:9041` のローカルサーバー
- `src/worker.mjs`: Cloudflare Access JWT検証、DB所属照合、D1、静的アセット認証
- `src/ai-adapter.mjs`: Workers AI / Service Binding向けの無効既定アダプター
- `src/main.jsx`: React業務画面と実スキーマから取得するERビュー
- `src/WorkCatalog.jsx` / `src/DesignCanvas.jsx`: 放送ウィンドウ一覧と概念・ER・画面を結ぶ設計表示
- `wrangler.jsonc`: 配備無効のローカル準備用Worker構成。実ID・秘密値なし
- `wrangler.cloud.jsonc`: 本人限定Cloudflare環境のWorker構成。公開版では、ドメインと識別子を架空の値に置き換えている（下の「Cloudflare本人限定環境」）

主要な関係は次の通りです。

```text
organizations ─ memberships ─ project_memberships ─ projects ─ works
                                                       │        ├ scenes
products ─ product_works ──────────────────────────────┤        ├ sales_opportunities
partners ─ report_imports ─ sale_lines ────────────────┤        ├ expenses
                    └ report_recognition ─ recognition_bases
                    └ settlement_report_links ─ settlement_term_versions ─ settlement_contracts
rights_intake_cases ─ documents / scopes / participants ─ intake_settlement_links ─┘
        └ committee_contracts ─ immutable term versions ─ windows / schedule phases
                                      └ committee report snapshots ─ reports / expenses / source lines / member amounts
report_mapping_profiles ─ immutable versions ─ mapping_import_provenance ─ report_imports
                                                       └────────┴ campaigns ─ exposures ─ observations ─ metric_definitions
change_proposals ─(管理者が特定版を採用)────────────────────────────────────────┘
```

ER画面は固定画像ではなく `PRAGMA table_info` と `PRAGMA foreign_key_list` から列とFKを読み、表を展開・参照先へ絞り込めます。

## 既存正本との対応

| 試作 | 既存の意味 |
|---|---|
| `projects` / `works` | `core.projects` / `core.works` |
| `products` / `product_works` | `core.products` / `core.product_works` |
| `partners` | `master.partners` |
| `scenes` | `genba.scenes` |
| `report_imports` | `ar.report_imports` |
| `sale_lines` | `ar.sales` |
| `recognition_bases` / `report_recognition` | ローカルの計上基準・報告根拠試作。既存 `master.recognition_rules` とは別軸で未移行 |
| `expenses` | 支払・費用の試作。本運用の既存 `ap` への移行は未決定 |
| `settlement_contracts` | `core.contracts` / `ap.mg_ledger` への未移行試作 |
| `settlement_term_versions` | 契約条件の追記型・不変版。既存正本へ未移行 |
| `settlement_report_links` | 報告×作品×適用条件版の明示リンク。既存正本へ未移行 |
| `rights_intake_*` / `intake_settlement_links` | 制作委員会・単独保有・権利受託の不変入力スナップショットと分配契約への明示リンク。既存正本へ未移行 |
| `report_mapping_*` / `mapping_import_provenance` | 取引先別CSVの不変な列対応版と、元原文・共通CSV・両ハッシュの変換根拠。既存正本へ未移行 |
| `committee_contracts` / `committee_term_*` | 制作委員会の調達ケースと契約書参照へ紐付けた、不変の参加者持分・販路窓口・手数料・日程条件版。既存正本へ未移行 |
| `committee_report_snapshots` / `committee_snapshot_*` | 共通売上の作品配賦後明細、明示経費、条件版、締め期間、分配試算を固定したdraft報告。既存正本へ未移行 |

この試作DDLはローカルSQLite/D1向けで、本番ERPの既存DBへは適用しません。販売期間と計上月、報告書と明細、予算と実績、施策と観測を分離しています。商品から複数作品への配賦は合計10,000bpを必須とし、整数円の端数は小数余りの大きい順、同率時は作品ID順に決定します。返品は符号付き金額で保持します。数量から金額は推測しません。

収支は有効な `sale_lines` と `expenses` だけで計算し、施策数や露出数をJOINしません。同じ売上が複数施策の比較候補に現れても会計売上は増えません。宣伝画面の売上は同じ作品・販売期間の参照で、因果を示しません。地域は取引先登録地域であり、観客所在地ではありません。

## 計上基準と実計上月

ローカル試作の `recognition_bases` は、1=販売月、2=報告受領月、3=契約開始月、4=ライセンス利用開始月、5=放送月の固定5行です。既存ERPの `master.recognition_rules`（発生・報告・FLAT・MG・対象外）とは別の軸で、IDを流用せず、本番DBも変更しません。

新しい手入力とCSVでは、計上基準、対応するソース月・日付、計上根拠を必須にします。販売月は `YYYY-MM`、報告受領日・契約開始日・ライセンス利用開始日・放送日は `YYYY-MM-DD` です。サーバーがソースから実計上月を算出し、入力された `accounting_month` と矛盾すれば全件を拒否します。販売月基準は販売期間の開始・終了が同じ単月で、指定販売月と一致する場合だけ登録できます。複数月は報告書を月ごとに分けます。ほかの基準では販売期間の跨月を許容します。

`report_recognition` は報告書と1対1で、ソース月・日付、根拠、算出月を保持します。メタデータ、報告書、全明細の実計上月はDBトリガーでも一致を検証し、登録後の根拠メタデータは変更しません。旧レコードは計上基準NULLの「未確認」のまま保持し、従来の明示的な計上月を書き換えません。基準関連列が一つでもある入力は厳密検証し、廃止した `contract_signed_on` は明示的に拒否します。旧形式の保存済みプレビューは再プレビューが必要です。

計上基準の選択は、会計・税務上の正しさを自動で保証しません。契約開始、ライセンス利用開始、放送の各時点も、この試作では管理用の根拠として未確認状態で保存します。

## 権利・分配の試算

手数料型（`commission`）、MG調達型（`mg`）、自社権利型（`self_owned`）を同じDBで区別します。契約条件は追記だけできる不変版です。報告と作品を契約へ紐付けるときに適用版と、報告額がプラットフォーム控除前（`gross`）か控除後（`net`）かを必ず選びます。最新版への自動差替えや既存リンクの上書きは行いません。同じ報告を複数作品へ配賦する場合も報告額基準は統一します。

試算は、紐付けた有効報告の作品配賦済み税抜整数円だけを読みます。grossではプラットフォーム控除、控除後受取、代理店手数料の順に計算します。netではgrossを推計せず、プラットフォーム控除額をNULLのままにして二重控除を防ぎます。控除額は絶対額へ料率を掛けて1円未満を切り捨て、元の符号を戻します。手数料型は残額を権利元配分にするため、整数円の保存則を維持します。返品は符号付き明細を含む累計の再計算です。

MG契約額と実支払額は契約に一組だけ保持し、条件版ごとにMG枠を作りません。回収基礎は契約条件版ごとにプラットフォーム控除後、または代理店手数料控除後を選びます。契約額、実支払、報告由来の回収原資、MG充当、未回収残高、超過原資を別々に表示します。MG超過後の追加分配は条件未確認のためNULLです。複数権利元、入金、支払済み、請求、確定精算、最終利益は扱いません。この画面は読取用の試算で、本人限定のCloudflare環境でも実会計には適用しません。

## CSV

売上は `theatrical`、`digital`、`package`、`broadcast`、`other`、宣伝は `publicity` を扱います。選択作品ごとに、現在の有効IDを含むサンプルCSVを画面から取得できます。新しい作品では、商品配賦、または宣伝施策と露出を先に登録します。配給・ビデオグラム・配信の詳細項目と原本照合は [流通別売上取込の実装](../../docs/uriage/channel-sales-import-implementation.md) を参照してください。

取込は最大100行・200KBです。プレビューで原行番号、登録先列、参照ID、全エラーを表示します。登録時も権限、案件、スキーマ版、プレビュー未消費を再検査し、D1 `batch()` またはSQLiteトランザクションで全行を一括登録します。1行でも不正なら登録しません。原文とSHA-256、組織内の報告キーを保持し、同一原文は拒否します。訂正版は現在の有効報告IDを `supersedes_id` に指定し、旧版を `superseded` にして履歴を残します。

税抜・税額・税込は `税込 = 税抜 + 税額` をCHECK制約とAPIの両方で検証します。日付は実在日、計上月は `YYYY-MM` として検証します。地域や指標値が不明ならNULLと `unverified` のまま保持します。

「報告書マッピング」は、組織・取引先・報告種別ごとのプロファイルへ不変の列対応版を追記します。変換は、元列の完全一致、型付き固定値、元列だけを入力にした加算・減算・乗算に限定します。未知の元列は「無視」を明示しない限り拒否し、欠損値を0にしません。任意式、JavaScript、SQL、列名の曖昧照合は実行しません。

元CSVから作った共通CSVは通常のプレビュー・計上基準・税額・権限検証と同じ経路を通り、登録時に元原文から再変換します。元原文と変換後本文、両SHA-256、マッピング版、元の物理行番号を保存します。同じ組織・作品・取引先・報告種別・元原文ハッシュは、プロファイルや版を変えても再登録できません。再マッピングによる訂正はこの試作の対象外で、既存の訂正フローへ進む必要があります。

## 調達・権利の入口

作品には、制作委員会、単独保有、権利受託の調達ケースを複数登録できます。契約書は名称・参照文字列・版・任意ハッシュだけを保持し、ファイルやURLの内容は読みません。権利範囲の媒体・地域・期間・独占性、参加者の役割・出資額・明示持分は、未確認をNULLのまま残します。出資額から持分を自動生成せず、制作委員会で全員の持分が入力済みでも合計100%でなければ不足として表示します。

保存したケースと子項目は不変です。不足を補う場合は `source_case_id` を持つ改訂スナップショットを追加し、旧版や旧版から分配契約へのリンクを付け替えません。既存の分配契約は調達入口未確認のまま保持でき、新しい契約の登録時または手動操作で同じ組織・作品のケースへだけ関連付けられます。制作委員会ケースは、契約書参照、参加者の役割、明示持分100%が揃えば、権利範囲や個別分配契約が未確認でも「製作委員会」画面の条件版へ進めます。承認は扱いません。

## 製作委員会の期間報告

制作委員会の条件版は、同じ作品の制作委員会調達ケースと契約書参照へ紐付けます。参加者と明示持分100%をスナップショット化し、幹事はなしも含めて明示します。劇場・配信・ビデオグラムの販路ごとに、委員会メンバーから窓口担当を選び、分配経路、PF料率、窓口手数料、幹事手数料、控除順、各手数料の計算基礎を入力します。3〜5%や20〜40%は既定値にせず、画面も空欄から始まります。料率は画面で%入力し、DBでは整数bpとして保持します。

締め日、報告予定日、支払予定日は計上月と別に管理します。初回締めと後続の1〜12か月間隔を日程フェーズとして登録し、月末を超える日は月末へ調整します。休日調整は行いません。フェーズ間の欠落・重複、報告予定日の締め前、支払予定日の報告前は拒否します。最後の端数期間は消さずに表示し、契約上の採用を明示しない限り報告を保存できません。画面の「架空の日程例を入力」は試用補助で、契約既定値ではありません。

期間報告は、販売期間または報告受領日のどちらで締め期間へ所属させるかを明示します。販売期間基準では、明細の期間全体が締め内にない報告を対象外にします。報告受領日基準では、計上根拠メタデータの受領日が必要です。候補一覧は期間外、既存個別精算で使用済み、保存済み委員会報告で使用済み、販路窓口条件なしを理由付きで示します。報告を自動で契約へ紐付けません。

金額は共通売上の作品配賦済み税抜JPYを一度だけ使います。gross報告だけPF控除を計算し、net報告ではgrossを推計せずPF控除額を未確認にします。窓口・幹事手数料、明示的に選んだ作品経費の順で分配原資を求め、メンバー持分を1円未満切捨てで配分します。差額は任意のメンバーへ配らず「未配分端数」に残し、各販路の保存則を照合します。負の返品明細は同じ販路の期間合計に含めますが、控除後原資が負なら保存を拒否します。

保存前プレビューと保存時にサーバーで再計算し、入力・計算ハッシュが一致したときだけトランザクションで不変のdraft/unverifiedスナップショットを作ります。元報告IDと内容ハッシュ、元売上明細、配賦率、販売期間、計上月、選択経費、未割当報告の理由を保持します。印刷画面は選択した1報告だけをA4横で表示します。これは予定試算であり、実会計、入金・実送金、優先回収、複数通貨、法定報告、最終利益を扱いません。

## 宣伝項目の変更提案

日本語依頼から作るローカル候補は、画面に「決定規則」と明示します。実AIではありません。外部AIで生成したJSONを貼り付け、同じ検証を通す経路もあります。

提案は依頼文、型、単位、集計法、見出し、意味と理由、影響画面、基準スキーマ版を正規化してハッシュ化します。管理者は、画面で確認したハッシュと基準版が一致する特定版だけを採用・却下できます。古い版はCHECK違反を使うトランザクションガードでロールバックします。採用時に追加するのは型付き `metric_definitions` 行だけで、任意DDL・SQL・JavaScriptは実行しません。過去の観測はNULLのままです。率や分母不明値を単純合算しません。

`WorkersAiAdapter` はWorkers AIのBinding、JSON Schema出力、モデル許可リスト、呼出上限、最大トークンを実装しています。`ServiceAiAdapter` はService Binding用です。`AI_ENABLED=false` が既定で、実呼出、認証情報、モデル実測は行っていません。ライブAI統合は未検証です。Workerでは組織ごとの永続 `ai_usage` を原子的に予約してから呼び出します。

## 閲覧用プレビュー（記録した応答で動く静的な版）

実際の画面を、架空データで記録した応答だけで動かす閲覧専用の版です。サーバーを持たず、`index.html`・`assets/`・`preview-data.json`（大きいときは `preview-data-N.json` に分割。どのファイルも16MB未満）を任意のパスに置いて開けます。

- `vite build --mode preview` のときだけ、`index.html` の入口を `src/preview/preview-main.mjs` に差し替え、相対パス（`base: './'`）で `dist-preview/` へ出力します。通常の `npm run build` の出力は変わりません（試験 `preview-snapshot.test.mjs` で確認）。
- 画面の API 呼び出し（`ui/api-client.mjs` の `createApi` と、売上サンプル取得の直接の `fetch('/api/downloads/…')`）は `window.fetch` の差し替えで記録から返します。鍵は「メソッド＋パス＋並べ替えた問い合わせ」。保存など GET 以外は「プレビューでは保存できません（閲覧専用・架空データ）」、記録に無い表示は「このプレビューに含まれていない表示です」を通常のエラー表示で出します。`<a href="/api/…">` のダウンロード（番販のExcel・分析の照合帳票）は記録した内容を開き・保存します。
- 画面の下端に「閲覧用のプレビュー（架空データ・保存はできません）」を常に出し、ログイン画面と退出は出しません。時計は記録した時点に合わせます（「今日」を既定にする画面が記録に当たるように。日本時間で見る前提）。

記録と確認（playwright は package.json に入れず、場所を環境変数で渡します）:

```powershell
$env:PLAYWRIGHT_MODULE_PATH = '<playwright-core のフォルダ>'
node scripts/build-preview.mjs --db <架空データのSQLite> --user demo-admin@openingnight.invalid
node scripts/verify-preview.mjs --dir dist-preview --base /preview/
```

`build-preview.mjs` は DB を一時フォルダへ写して（元の DB は読むだけ）アプリをこのプロセスで起動し、全画面・帳票センターの全帳票・ロイヤリティ（権利者・期間・報告書）・委員会月次収支（委員会の作品ごと）を開いて、画面内の `?p=` リンクとタブをたどり、GET の応答を記録します。巡回中の GET 以外は通しません。ログインは `.invalid` の架空メールだけで、記録に架空でないメールのドメインがあれば書き出しません。所属が複数ある人は `--org <組織コード>` で組織を選び、所属の一覧は記録する組織だけにします。`--works <数>` で作品ごとの画面を開く作品数を、`--no-public` でデモ資料・操作デモ動画（`public/`）を外せます。`verify-preview.mjs` は小さな静的サーバーでサブパスの下に置き、帯・移動・帳票・Excel・保存の拒否・記録に無い表示・`/api` へ通信しないことを確かめます。

提案資料（基準ごとに既定の月の前1か月〜後5か月と「確定だけ」・SVOD）、放送ウィンドウ提案（全作品）、PL・BS と売上集計シート（前の年度・前々年度）も開きます。組織ごとの機能の判定（`/api/session/org-features`）はいつも記録し、所属の一覧と同じく記録する組織だけにします。放送アベイルズリストの作品名の照合は POST ですが、保存しないので、照合の元（`/api/broadcast/availability-list/candidates`）を記録し、プレビューの中で API と同じ純関数で組み立てます（`src/preview/computed-posts.mjs`）。「放送履歴表に出ている作品をすべて入れる」ときの Excel も記録します。

## Cloudflare本人限定環境

`wrangler.jsonc` は `DEPLOYMENT_ENABLED=false`、`workers_dev=false`、`preview_urls=false` の準備用設定です。`wrangler.cloud.jsonc` は、Cloudflare Access で認証した本人だけが使う環境の構成です。公開版ではドメインと識別子を架空の値に置き換えているので、そのままでは配備できません。

配備の前には、次の3つを通します。

```powershell
npm test
npm run build
npx wrangler deploy --dry-run --config wrangler.cloud.jsonc --containers-rollout=none
```

ローカルDBの入力・履歴は `data/integrated.sqlite` に保持します。停止時はサーバーを終了し、DBの削除や初期化は別途判断します。

