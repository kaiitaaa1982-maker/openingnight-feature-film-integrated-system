# 架空資料の生成と検証

生成元は `generate_demo_fixtures.mjs`（XLSX/CSV）と `generate_broadcast_contract.py`（PDF）、`generate_script_pdfs.py`（架空の連続ドラマの縦書き台本PDF。元データは `kouban/kouban-demo.json`、出力は `../public/demo-fixtures/scripts/`）。生成先は同階層の `output/`。XLSXはArtifact Toolで計算・書出し・再読込を検証し、PDFは2ページの日本語本文を抽出して照合する。配布用の確定版は `../public/demo-fixtures/`。

配信はTVOD・SVOD・EST、ビデオグラムはDVD/BDの出荷・返品を扱う。すべて非公式の架空資料で、実在企業の書式は複製していない。PDFに実署名・口座情報はない。

- XLSXの見出し行は4、元CSVの見出し行は2。
- 上の2組（`streaming-platform`・`videogram-rental`）は手元用の初期データ（組織1・`WRK-DEMO`・取引先2・3・商品1・2）用。架空データ（デモ）`DEMO-SALES` 用に `demo-sales-streaming-sample.xlsx`（配信・取引先 DEMO-PF-B・6作品）と `demo-sales-videogram-sample.xlsx`（ビデオグラム・取引先 DEMO-RNT-A・5作品）を別に置く。生成元は `generate_demo_sales_samples.py`（openpyxl）。配布物は代表に渡した版のブックを OOXML の部品に展開した `../fixtures/xlsx-source/demo-sales-*/` から組み立てる（数値・行・列・シートを変えないため、生成し直した部品で置き換えない）。期待値は `fixture-manifest.json`（配信: 正常9行・6作品・正味2,287,040円・要修正14行目、ビデオグラム: 正常7行・5作品・正味数量1,449・正味額640,580円・要修正12行目）。DEMO-SALES 用には数字のIDの正常取込CSVを作らない（IDは環境・組織で変わる）。
- `node --test test/demo-sales-samples.test.mjs` は seed-sales-demo で作った DEMO-SALES に、原本の受取→見出し行4→商品コードの列で分割（要修正の行は理由を書いて除く）→作品ごとに登録 の順で取り込み、作品ごとの額を Details の行から計算し直した値と照合する。
- `*-canonical.csv` は「売上データ編集」用。見出し行1、報告種別の `kind` 列を含む。
- 正常CSVの報告キーは固定。同じ報告の再登録は拒否される。もう一度登録する場合は、デモ用の別報告キーへ変更する。
- 元XLSXの要修正行は、コード欠落・金額不一致または返品超過を含む。練習用の修正下書きとして残し、正常CSVの確定売上とは区別する。
- `node --test test/demo-samples.test.mjs` は正常CSVから下書き・検証・承認・DB反映を実行し、配信1,154,700円・ビデオグラム726,140円の税抜合計を照合する。
- 放送契約PDFは原本取り込みで保存済み原本を選び、「抽出した本文を確認」から期間・回数・地域・対価・期日を確認できる。契約本文の自動確定や権利台帳への自動登録は行わない。
