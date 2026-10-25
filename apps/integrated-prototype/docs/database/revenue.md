<!-- 生成物。直さない。正本は DB の定義（src/**/*.sql）と docs/database/dictionary.json。作り直しは node scripts/build-db-docs.mjs -->
# 売上（revenue）の表

[目次へ戻る](README.md)

## ER 図

```mermaid
erDiagram
  billing_invoice_line_works {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER invoice_id PK, FK "請求書（billing_invoices）"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
    INTEGER work_id PK, FK "作品（works）"
  }
  billing_invoice_lines {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER invoice_id PK, FK "請求書（billing_invoices）"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
    INTEGER report_id FK "売上報告（report_imports）"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "作品（works）"
    INTEGER product_id FK "商品（products）"
    INTEGER partner_id FK "取引先（partners）"
  }
  billing_invoice_sequences {
    INTEGER org_id PK "組織（organizations）。データの持ち主"
    TEXT year_month PK "請求日の年月（YYYYMM）"
  }
  billing_invoice_voids {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER invoice_id PK, FK "取り消した請求書（billing_invoices）"
  }
  billing_invoices {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER partner_id FK "請求先の取引先（partners）"
  }
  billing_receipt_allocations {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER receipt_id PK, FK "入金（billing_receipts）"
    INTEGER invoice_id PK, FK "請求書（billing_invoices）"
  }
  billing_receipt_reversals {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER receipt_id PK, FK "取り消した入金（billing_receipts）"
  }
  billing_receipts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER partner_id FK "入金した取引先（partners）"
  }
  billing_sale_claims {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
    INTEGER invoice_id FK "請求書（billing_invoices）"
  }
  digital_sale_details {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
  }
  expected_report_closures {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER expected_report_id PK, FK "届くはずの報告（expected_reports）"
  }
  expected_reports {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER partner_id FK "報告を送る取引先（partners）"
    INTEGER work_id FK "作品（works）。空なら作品を問わない"
  }
  import_previews {
    TEXT token PK "プレビューの鍵（ランダムな文字列）"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "取り込む先の作品（works）"
  }
  kpi_metric_steps {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER metric_version_id PK, FK "指標マスタの版（kpi_metric_versions）"
    TEXT role PK "役（producer プロデューサー・sales_sourcing 営業（仕入れ）・sales_selling 営業（売り））"
    TEXT earning_type PK, FK "稼ぎ方（earning_types）"
    INTEGER seq PK "役×稼ぎ方の中の段の順（1から）"
    TEXT step FK "段（action_steps。細目の段は親のステップへ畳む）"
  }
  kpi_metric_versions {
    INTEGER id PK "行のID"
  }
  mapping_import_provenance {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER report_id PK, FK "登録した売上報告（report_imports）。1報告に1行"
    INTEGER work_id FK "作品（works）"
    INTEGER partner_id FK "報告元の取引先（partners）"
    INTEGER mapping_version_id FK "使った読み替えの版（report_mapping_versions）"
  }
  package_observation_products {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER report_id PK, FK "売上報告（report_imports）"
    INTEGER source_row PK, FK "報告書の行番号"
    TEXT metric PK, FK "数の種類（package_report_observations と同じ）"
    INTEGER product_id FK "商品（products）"
  }
  package_report_observations {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER report_id PK, FK "売上報告（report_imports。ビデオグラムだけ）"
    INTEGER source_row PK "報告書の行番号"
    TEXT metric PK "数の種類（出荷・稼働・在庫・返品）"
  }
  package_sale_details {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
  }
  plan_adoptions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER period_id FK "期間（yojitsu_periods。指す版と同じ期間）"
    INTEGER plan_version_id FK "採用した計画の版（yojitsu_plan_versions）"
  }
  receipt_plan_decisions {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER request_id PK, FK "変更申請（receipt_plan_requests）"
    INTEGER invoice_id FK "請求書（billing_invoices）"
  }
  receipt_plan_requests {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER invoice_id FK "請求書（billing_invoices）"
  }
  recognition_bases {
    INTEGER id PK "基準の番号（1〜5で固定）"
  }
  report_channel_fact_seals {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER report_id PK, FK "売上報告（report_imports）"
  }
  report_check_cases {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER check_version_id FK "検査の決まりの版（report_check_versions）"
  }
  report_check_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER partner_id FK "型の取引先（partners）"
    INTEGER mapping_version_id FK "指す列対応の版（report_mapping_versions。同じ取引先と報告の種類）"
  }
  report_imports {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER work_id FK "作品（works）"
    INTEGER partner_id FK "報告元の取引先（partners）。宣伝の取込では空"
    INTEGER supersedes_id FK "この版が訂正した前の報告（report_imports）"
    INTEGER created_by FK "作成した利用者（users）"
  }
  report_mapping_profiles {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER partner_id FK "報告を出す取引先（partners）"
  }
  report_mapping_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER profile_id FK "読み替え定義（report_mapping_profiles）"
  }
  report_recognition {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER report_id PK, FK "売上報告（report_imports）。1報告に1行"
    INTEGER recognition_basis_id FK "計上基準（recognition_bases）"
  }
  report_source_controls {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER report_id PK, FK "売上報告（report_imports）"
    TEXT scope_kind PK "範囲。report＝報告全体、channel＝流通ごと"
    TEXT channel PK "流通（範囲が channel のときだけ。ほかは空文字）"
    TEXT metric PK "何の合計か（行数・税抜額・税額・税込額）"
  }
  report_voids {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER report_id PK, FK "取り消した報告（report_imports）"
  }
  sale_attribute_values {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
    TEXT column_key PK "拡張属性の列キー（sales_sheet_column_versions）"
    INTEGER version_no PK "売上×列ごとの版の連番"
  }
  sale_currency_versions {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
    INTEGER version_no PK "売上ごとの版の連番"
  }
  sale_lines {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "作品（works）"
    INTEGER report_id FK "元の売上報告（report_imports）"
    INTEGER product_id FK "商品（products）。空なら明細の作品の売上とする"
    INTEGER partner_id FK "取引先（partners）"
  }
  sale_royalty_basis_versions {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
    INTEGER version_no PK "売上ごとの版の連番"
  }
  sales_sheet_column_versions {
    INTEGER org_id PK "組織（organizations）。データの持ち主"
    TEXT column_key PK "列キー（英小文字・数字・_。版をまたいで同じ列）"
    INTEGER version_no PK "列ごとの版の連番"
  }
  sales_sheet_view_versions {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER view_id PK, FK "保存した形（sales_sheet_views）"
    INTEGER version_no PK "形ごとの版の連番"
  }
  sales_sheet_views {
    INTEGER id PK "行のID"
  }
  sales_source_bindings {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER file_id FK "原本（sales_source_files）"
    INTEGER project_id FK "案件（projects）。1つの作品のときだけ"
    INTEGER work_id FK "作品（works）。1つの作品のときだけ"
  }
  sales_source_commits {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER file_id FK "原本（sales_source_files）"
    INTEGER partition_id FK "分割（sales_source_partitions）"
    INTEGER work_id FK "作品（works）"
    INTEGER mapping_version_id FK "使った列対応の版（report_mapping_versions）"
    INTEGER report_id FK "登録した売上報告（report_imports）"
  }
  sales_source_file_terms {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER file_id FK "原本（sales_source_files）"
    INTEGER partner_id FK "1通を送ってきた取引先（partners）"
  }
  sales_source_files {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER legacy_artifact_id FK "引き継いだ旧方式の原本（workflow_raw_artifacts）"
  }
  sales_source_partitions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER file_id FK "原本（sales_source_files）"
    INTEGER selection_id FK "使った取込範囲の版（sales_source_selections）"
    INTEGER binding_id FK "使った割り当ての版（sales_source_bindings）"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "分けた先の作品（works）"
  }
  sales_source_selections {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER file_id FK "原本（sales_source_files）"
    INTEGER legacy_selection_id FK "写した旧方式の選択（workflow_report_selections）"
  }
  source_check_runs {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER file_id FK "原本（sales_source_files）"
    INTEGER check_version_id FK "使った検査の決まりの版（report_check_versions）"
  }
  source_sampling_reviews {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER check_run_id FK "見た検査の回（source_check_runs）"
  }
  tax_calculation_lines {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER snapshot_id PK, FK "税計算（tax_calculation_snapshots）"
    INTEGER sale_id PK, FK "元の売上明細（sale_lines）"
    INTEGER report_id FK "元の売上報告（report_imports）"
  }
  tax_calculation_snapshots {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER invoice_id FK "請求（billing_invoices）"
    INTEGER rule_version_id FK "使った税ルールの版（tax_rule_versions）"
  }
  tax_invoice_links {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER invoice_id PK, FK "再発行した請求（billing_invoices）"
    INTEGER prior_invoice_id FK "取り消した元の請求（billing_invoices）"
  }
  tax_invoice_rate_totals {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER snapshot_id PK, FK "税計算（tax_calculation_snapshots）"
    TEXT category PK "税区分（課税10%・軽減8%・免税・非課税・不課税）"
    INTEGER rate_bps PK "税率（bps。1000＝10%）"
  }
  theatrical_sale_details {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
  }
  workflow_report_commits {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER work_id FK "作品（works）"
    INTEGER artifact_id FK "売上報告の原本（workflow_raw_artifacts）"
    INTEGER selection_id FK "使った取込範囲（workflow_report_selections）"
    INTEGER mapping_version_id FK "使った列対応の版（report_mapping_versions）"
    INTEGER report_id FK "登録した売上報告（report_imports）"
  }
  workflow_report_selections {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER artifact_id FK "売上報告の原本（workflow_raw_artifacts）"
  }
  yojitsu_activity_cancellations {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER activity_id PK, FK "取り消した活動記録（yojitsu_activity_records）"
  }
  yojitsu_activity_records {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects。必須）"
    TEXT earning_type FK "稼ぎ方（earning_types。空なら案件の稼ぎ方で数える）"
    TEXT step FK "ステップ（action_steps の段。空は数えない）"
    INTEGER work_id FK "作品（works。案件の作品。作品の無い段は空）"
    INTEGER source_sales_activity_id FK "取り込んだ営業の活動（sales_activities。組織の中で1回だけ）"
  }
  yojitsu_choice_versions {
    INTEGER id PK "行のID"
  }
  yojitsu_forecast_lines {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER project_id PK, FK "案件（yojitsu_forecast_versions の案件）"
    INTEGER version_no PK, FK "版（yojitsu_forecast_versions）"
    INTEGER line_no PK "版の中の行の番号（1〜版の line_count の連番。最後の番号の次だけ足せる）"
    INTEGER category_id FK "区分（cashflow_categories）"
  }
  yojitsu_forecast_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
  }
  yojitsu_periods {
    INTEGER id PK "行のID"
  }
  yojitsu_plan_amounts {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER plan_version_id PK, FK "計画の版（yojitsu_plan_versions）"
    TEXT earning_type PK, FK "稼ぎ方（earning_types）"
  }
  yojitsu_plan_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER period_id FK "期間（yojitsu_periods）"
  }
  yojitsu_setting_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    TEXT variable_key FK "変数（yojitsu_variables）"
    TEXT earning_type FK "稼ぎ方（earning_types。範囲が稼ぎ方・稼ぎ方×ステップのとき）"
    TEXT step FK "ステップ（action_steps。範囲が稼ぎ方×ステップのとき。率はその段から次の段へ）"
    INTEGER project_id FK "案件（projects。範囲が案件のとき）"
  }
  yojitsu_target_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER period_id FK "期間（yojitsu_periods）"
  }
  yojitsu_variables {
    TEXT code PK "変数のコード"
  }
  billing_invoice_line_works }o--|| works : "work_id"
  billing_invoice_line_works }o--|| billing_invoice_lines : "invoice_id,sale_id"
  billing_invoice_lines }o--|| partners : "partner_id"
  billing_invoice_lines }o--o| products : "product_id"
  billing_invoice_lines }o--|| works : "project_id,work_id"
  billing_invoice_lines }o--|| report_imports : "report_id"
  billing_invoice_lines }o--|| sale_lines : "sale_id"
  billing_invoice_lines }o--|| billing_invoices : "invoice_id"
  billing_invoice_voids }o--|| billing_invoices : "invoice_id"
  billing_invoices }o--|| partners : "partner_id"
  billing_receipt_allocations }o--|| billing_invoices : "invoice_id"
  billing_receipt_allocations }o--|| billing_receipts : "receipt_id"
  billing_receipt_reversals }o--|| billing_receipts : "receipt_id"
  billing_receipts }o--|| partners : "partner_id"
  billing_sale_claims }o--|| billing_invoice_lines : "invoice_id,sale_id"
  digital_sale_details }o--|| sale_lines : "sale_id"
  expected_report_closures }o--|| expected_reports : "expected_report_id"
  expected_reports }o--o| works : "work_id"
  expected_reports }o--|| partners : "partner_id"
  import_previews }o--|| works : "project_id,work_id"
  kpi_metric_steps }o--|| kpi_metric_versions : "metric_version_id"
  kpi_metric_steps }o--|| action_steps : "step"
  kpi_metric_steps }o--|| earning_types : "earning_type"
  mapping_import_provenance }o--|| report_mapping_versions : "mapping_version_id"
  mapping_import_provenance }o--|| partners : "partner_id"
  mapping_import_provenance }o--|| report_imports : "work_id,report_id"
  package_observation_products }o--|| products : "product_id"
  package_observation_products }o--|| package_report_observations : "report_id,source_row,metric"
  package_report_observations }o--|| report_imports : "report_id"
  package_sale_details }o--|| sale_lines : "sale_id"
  plan_adoptions }o--|| yojitsu_plan_versions : "period_id,plan_version_id"
  receipt_plan_decisions }o--|| receipt_plan_requests : "invoice_id,request_id"
  receipt_plan_requests }o--|| billing_invoices : "invoice_id"
  report_channel_fact_seals }o--|| report_imports : "report_id"
  report_check_cases }o--|| report_check_versions : "check_version_id"
  report_check_versions }o--|| report_mapping_versions : "mapping_version_id"
  report_check_versions }o--|| partners : "partner_id"
  report_imports }o--o| report_imports : "supersedes_id"
  report_imports }o--o| partners : "partner_id"
  report_imports }o--|| works : "work_id"
  report_imports }o--|| users : "created_by"
  report_imports }o--o| report_imports : "supersedes_id"
  report_mapping_profiles }o--|| partners : "partner_id"
  report_mapping_versions }o--|| report_mapping_profiles : "profile_id"
  report_recognition }o--|| report_imports : "report_id"
  report_recognition }o--|| recognition_bases : "recognition_basis_id"
  report_source_controls }o--|| report_imports : "report_id"
  report_voids }o--|| report_imports : "report_id"
  sale_attribute_values }o--|| sale_lines : "sale_id"
  sale_currency_versions }o--|| sale_lines : "sale_id"
  sale_lines }o--|| partners : "partner_id"
  sale_lines }o--o| products : "product_id"
  sale_lines }o--o| report_imports : "work_id,report_id"
  sale_lines }o--|| works : "project_id,work_id"
  sale_royalty_basis_versions }o--|| sale_lines : "sale_id"
  sales_sheet_view_versions }o--|| sales_sheet_views : "view_id"
  sales_source_bindings }o--o| works : "project_id,work_id"
  sales_source_bindings }o--|| sales_source_files : "file_id"
  sales_source_commits }o--|| report_mapping_versions : "mapping_version_id"
  sales_source_commits }o--|| report_imports : "work_id,report_id"
  sales_source_commits }o--|| sales_source_partitions : "work_id,partition_id"
  sales_source_commits }o--|| sales_source_files : "file_id"
  sales_source_file_terms }o--|| partners : "partner_id"
  sales_source_file_terms }o--|| sales_source_files : "file_id"
  sales_source_files }o--o| workflow_raw_artifacts : "legacy_artifact_id"
  sales_source_partitions }o--|| works : "project_id,work_id"
  sales_source_partitions }o--|| sales_source_bindings : "file_id,binding_id"
  sales_source_partitions }o--|| sales_source_selections : "file_id,selection_id"
  sales_source_selections }o--o| workflow_report_selections : "legacy_selection_id"
  sales_source_selections }o--|| sales_source_files : "file_id"
  source_check_runs }o--|| report_check_versions : "check_version_id"
  source_check_runs }o--|| sales_source_files : "file_id"
  source_sampling_reviews }o--|| source_check_runs : "check_run_id"
  tax_calculation_lines }o--|| report_imports : "report_id"
  tax_calculation_lines }o--|| sale_lines : "sale_id"
  tax_calculation_lines }o--|| tax_calculation_snapshots : "snapshot_id"
  tax_calculation_snapshots }o--|| tax_rule_versions : "rule_version_id"
  tax_calculation_snapshots }o--o| billing_invoices : "invoice_id"
  tax_invoice_links }o--|| billing_invoices : "prior_invoice_id"
  tax_invoice_links }o--|| billing_invoices : "invoice_id"
  tax_invoice_rate_totals }o--|| tax_calculation_snapshots : "snapshot_id"
  theatrical_sale_details }o--|| sale_lines : "sale_id"
  workflow_report_commits }o--|| report_imports : "work_id,report_id"
  workflow_report_commits }o--|| report_mapping_versions : "mapping_version_id"
  workflow_report_commits }o--|| workflow_report_selections : "work_id,selection_id"
  workflow_report_commits }o--|| workflow_raw_artifacts : "work_id,artifact_id"
  workflow_report_selections }o--|| workflow_raw_artifacts : "artifact_id"
  yojitsu_activity_cancellations }o--|| yojitsu_activity_records : "activity_id"
  yojitsu_activity_records }o--o| sales_activities : "source_sales_activity_id"
  yojitsu_activity_records }o--o| works : "project_id,work_id"
  yojitsu_activity_records }o--|| projects : "project_id"
  yojitsu_activity_records }o--o| action_steps : "step"
  yojitsu_activity_records }o--o| earning_types : "earning_type"
  yojitsu_forecast_lines }o--|| cashflow_categories : "category_id"
  yojitsu_forecast_lines }o--|| yojitsu_forecast_versions : "project_id,version_no"
  yojitsu_forecast_versions }o--|| projects : "project_id"
  yojitsu_plan_amounts }o--|| yojitsu_plan_versions : "plan_version_id"
  yojitsu_plan_amounts }o--|| earning_types : "earning_type"
  yojitsu_plan_versions }o--|| yojitsu_periods : "period_id"
  yojitsu_setting_versions }o--o| projects : "project_id"
  yojitsu_setting_versions }o--o| action_steps : "step"
  yojitsu_setting_versions }o--o| earning_types : "earning_type"
  yojitsu_setting_versions }o--|| yojitsu_variables : "variable_key"
  yojitsu_target_versions }o--|| yojitsu_periods : "period_id"
```

主キーと参照の列だけを載せる。組織（organizations・memberships）への参照は省く。

## 表の一覧

| 表 | 論理名 | 説明 |
|---|---|---|
| [billing_invoice_line_works](#billing_invoice_line_works) | 請求明細の作品配賦 | 請求明細1行の金額を作品へ分ける割合を、請求時の商品の配賦のまま写したものを表す。明細ごとに合計1万（100%）で、変更・削除できない。 |
| [billing_invoice_lines](#billing_invoice_lines) | 請求明細 | 請求書に含めた売上明細1行を、請求時の値のまま写したものを表す。元の売上明細と完全に一致するときだけ作れ、変更・削除できない。 |
| [billing_invoice_sequences](#billing_invoice_sequences) | 請求番号の採番 | 組織ごと・請求日の年月ごとに、最後に出した請求番号の連番を表す。請求書を作るたびに1進める。 |
| [billing_invoice_voids](#billing_invoice_voids) | 請求の取消 | 請求書1通を取り消した記録（日付と理由）を表す。有効な入金をすべて取り消してからでないと作れず、変更・削除できない。 |
| [billing_invoices](#billing_invoices) | 請求書 | 取引先1社へ出した請求書1通を表す。同じ取引先の有効な売上報告を選んで作り、そのときの明細・配賦・税計算を写して固定し、変えられるのは取消（void）への1回だけ。 |
| [billing_receipt_allocations](#billing_receipt_allocations) | 入金の消込 | 入金1回のうち、請求書1通に充てた額を表す。入金ごとの合計は入金額と一致し、請求の税込額を超えられず、変更・削除できない。 |
| [billing_receipt_reversals](#billing_receipt_reversals) | 入金の取消 | 入金1回を取り消した記録（逆仕訳の日と理由）を表す。取消日以後はその入金の消込を無いものとして残高を出し、変更・削除できない。 |
| [billing_receipts](#billing_receipts) | 入金 | 取引先からの入金1回を表す。請求書への消込（billing_receipt_allocations）と同時に作って変更・削除できず、直すときは入金の取消を足す。 |
| [billing_sale_claims](#billing_sale_claims) | 請求済みの売上 | 売上明細1行がどの請求書で請求済みかを表す。1つの売上は1つの請求書でしか請求できず、請求を取り消すとこの行を消す。 |
| [digital_sale_details](#digital_sale_details) | 配信売上の詳細 | 配信の売上報告の売上明細1行について、方式・サービス・販売数・視聴など報告にある値を表す。方式ごとに入れられる列が決まり、ここの額（小数も入る文字）は合算しない。 |
| [expected_report_closures](#expected_report_closures) | 届くはずの報告の終了 | 届くはずの報告1件の終わり（最後の対象月と理由）を表す。1件に1行だけ足し、変更・削除できない。 |
| [expected_reports](#expected_reports) | 届くはずの報告 | 取引先×報告の種類（×作品）ごとに、報告が届く頻度・期限・開始月を表し、受領進捗の母集合になる。変更・削除できず、やめるときは終了の記録を足す。 |
| [import_previews](#import_previews) | 報告取込のプレビュー | 売上報告や宣伝の指標の CSV を登録する前のプレビュー1件。登録の時に中身を照合し、一度使ったら consumed を1にする。期限は15分。 |
| [kpi_metric_steps](#kpi_metric_steps) | 指標マスタの段 | 指標マスタの版の子の行（追記だけ。変更・削除は DB が断る）。役×稼ぎ方ごとに段を seq の順に並べ、段は行動のステップの参照表のコード（細目は親のステップへ畳んで数える）。稼ぎ方×段は版の中で1回だけ。対応の出どころの状態を必ず持つ。行の数がヘッダの step_count を超えたら断る |
| [kpi_metric_versions](#kpi_metric_versions) | 指標マスタ（版） | 指標マスタの版のヘッダ（追記だけ。変更・削除は DB が断る）。組織ごとの連番で、最新の version_no の版が有効。段の行は kpi_metric_steps に持ち、step_count はその行の数（行が足りない版は有効にしない）。段の率・1件の時間・1件の額などの値は持たず、設定の行（yojitsu_setting_versions）だけに持つ |
| [mapping_import_provenance](#mapping_import_provenance) | 読み替え取込の出どころ | 読み替えを通して取り込んだ売上報告1件の出どころ。受け取った原文と読み替え後の CSV を両方残し、書き換えない。 |
| [package_observation_products](#package_observation_products) | ビデオグラム観測の対象商品 | ビデオグラム報告の観測値1つ（report_id・source_row・metric で指す）が、どの商品の数かを表す。商品が決まる行だけに作り、無ければ作品全体の数として扱う。 |
| [package_report_observations](#package_report_observations) | ビデオグラム報告の観測値 | ビデオグラムの報告の1行にある、出荷・稼働・在庫・返品の数1つを表す。売上ではないので売上額と合算せず、変更・削除できない。 |
| [package_sale_details](#package_sale_details) | ビデオグラム売上の詳細 | ビデオグラムの売上報告の売上明細1行について、方式・回転数・単価など報告にある値を表す。金額の正本は売上明細で、ここの額（小数も入る文字）は合算しない。 |
| [plan_adoptions](#plan_adoptions) | 計画の採用の記録 | 計画の版を採用した記録（追記だけ。変更・削除は DB が断る）。期間ごとの連番の最新の行が指す版が有効な計画。第1版も1行書き、「戻す」は古い版を指す行を足すだけ。指せるのは子表のそろった同じ期間の版で、採用した日は前の行より前にしない。シナリオとの結びは持たない。表はデータ一覧・一括出力・帳票の対象外 |
| [receipt_plan_decisions](#receipt_plan_decisions) | 入金予定の変更判断 | 入金予定の変更申請1件への管理者の承認か却下を表す。承認すると入金予定の版が1進み、適用日以後はその予定日を使う。 |
| [receipt_plan_requests](#receipt_plan_requests) | 入金予定の変更申請 | 請求書1通の入金予定日を変えたいという申請1件を表す。入金表の画面で出して管理者が承認・却下し、変更・削除できない。 |
| [recognition_bases](#recognition_bases) | 計上基準 | 売上の計上月を決める基準のマスタ。5件で固定で、DB を作るときに入り、書き換えない。 |
| [report_channel_fact_seals](#report_channel_fact_seals) | 報告の流通別の封印 | 売上報告1件の流通別の詳細（劇場・ビデオグラム・配信の詳細と観測値）を入れ終えた印を表す。報告の登録で最後に足し、以後その報告の詳細は足せない。 |
| [report_check_cases](#report_check_cases) | 検査の正解表 | 検査の決まりの版ごとの正解表の1行（追記だけ。変更・削除は DB が断る）。架空の原本と、7つの検査の期待する合否。出どころは種（ふつうの通・端数のある通・取り込まない行のある通）か人の直し。実在の原本は入れない（fictional は 1 だけ）。人の直しを足せるのは、代表（role が admin で在籍が有効）か財務担当（permission が edit で、在籍と権限の期限が切れていない）だけ。種の行はこの止めの対象外 |
| [report_check_versions](#report_check_versions) | 検査の決まり（版） | 取引先×報告の種類ごとの検査の決まりの版（追記だけ。変更・削除は DB が断る）。指す列対応の版・検算の決まり・見出しの列名・取り込まない行の規則・税抜・税額・税込の列名・商品で分けるか・版の理由を持つ。連番は取引先×報告の種類ごと。指す列対応の版は、同じ組織・同じ取引先・同じ報告の種類のものだけ。正答率の列は持たない |
| [report_imports](#report_imports) | 売上報告の取込 | 取り込んだ売上報告（宣伝の指標の報告も含む）1件の原文と情報。訂正は新しい行を足し、前の行を superseded（訂正版あり）にする。 |
| [report_mapping_profiles](#report_mapping_profiles) | 報告書の読み替え定義 | 取引先ごと・報告の種類ごとに、報告書の列を共通の形へ読み替える定義の見出し1件。中身は版に持ち、書き換えない。 |
| [report_mapping_versions](#report_mapping_versions) | 読み替え定義の版 | 読み替え定義の中身の版1件。直すときは新しい版を足し、書き換えない。取込の登録の時にハッシュで同じ版か確かめる。 |
| [report_recognition](#report_recognition) | 報告の計上基準 | 売上報告1件ごとの計上基準と、その基準から決めた計上月。基準の列を含む報告を取り込むときに作り、あとから変えられない。 |
| [report_source_controls](#report_source_controls) | 報告原本の合計値 | 売上報告の原本に書かれた合計（行数・税抜・税額・税込）を書き写した値1件。報告を登録して封をしたあと、取り込んだ明細の合計と一致するときだけ入る。入ったあとは、その報告の明細（パッケージの観測値を含む）を足すことも変えることも消すこともできず、この値も変更・削除できない |
| [report_voids](#report_voids) | 報告の取消の記録 | 登録済みの報告1件を取り違えのために取り消した記録（理由・誰が・いつ）を表す。同じ書き込みで報告（report_imports）を取消（void）にしたあとにだけ足せ、報告ごとに1つ。請求済みの報告は取り消せない（既存のトリガー）。変更・削除は DB が断る |
| [sale_attribute_values](#sale_attribute_values) | 売上の拡張属性の値（版） | 売上明細1件×拡張属性の列1つの値の版。ほかの表に置き場の無い値（劇場名・券種など）を、財務の権限で手入力か売上報告の取込で積み、書き換えない。 |
| [sale_currency_versions](#sale_currency_versions) | 売上の外貨（版） | 売上明細1件ごとの通貨・外貨の額・為替レートの版。円の計上額と外貨×レートが1円まで合うときだけ積め、書き換えない。 |
| [sale_lines](#sale_lines) | 売上明細 | 売上報告から取り込んだ売上の明細1行。取込の登録で作る。請求に使った行と、原本の合計で照合済みの報告の行は変えられない。 |
| [sale_royalty_basis_versions](#sale_royalty_basis_versions) | ロイヤリティ計上の基準（版） | 売上明細1件ごとの、ロイヤリティ計上月と計上額（税抜・税込）の版。記録の無い売上は計上月・計上額と同じとみなし、書き換えない。 |
| [sales_sheet_column_versions](#sales_sheet_column_versions) | 売上集計シートの列（版） | 売上集計シートの列1つの定義（見出し・型・集計の決まり・値の取り方）の版。管理者が初期の83列の採用や列の追加で積み、書き換えない。 |
| [sales_sheet_view_versions](#sales_sheet_view_versions) | 保存した形の中身（版） | 保存した形ごとの列の並び・粒度・切り口・月と税の基準・絞り込みの版。保存し直すたびに積み、書き換えない。 |
| [sales_sheet_views](#sales_sheet_views) | 売上集計シートの保存した形 | 売上集計シートの見せ方に名前をつけて保存したもの1件。名前は変えず（変えるときは新しく作る）、中身は sales_sheet_view_versions に版で持つ。 |
| [sales_source_bindings](#sales_source_bindings) | 売上原本の割り当て（版） | 原本の行をどの作品へ割り当てるかの決め方の版1つを表す。付け替えるたびに理由を付けて足し、登録を始めた後は足せず、最大の版番号が今の割り当て。 |
| [sales_source_commits](#sales_source_commits) | 売上原本の分割の登録 | 分割1つを売上報告1件として登録した記録を表す。1つの原本の登録はすべて同じ割り当て・取込範囲・分け方・取引先・報告の種類にそろえ、変更・削除できない。 |
| [sales_source_file_terms](#sales_source_file_terms) | 売上原本の1通の条件（版） | 受け取った原本1通の条件（取引先・報告の種類・対象期間・受領日・報告月・申告合計）の版1つを表す。原本ごとの連番で、最新の版がその時点の条件（状態の列は持たない）。置き場所を誤ったときは理由を書いて次の版を足し、分割の登録を始めた原本には足せない。変更・削除は DB が断る。分からない値は空（未検証）のまま持つ |
| [sales_source_files](#sales_source_files) | 受領した売上原本 | 受け取った売上報告のファイル1つを、作品から切り離して表す。原本取り込みで保存し、同じ中身は組織で1回だけで、変更・削除できない。 |
| [sales_source_partitions](#sales_source_partitions) | 売上原本の作品別の分割 | 1回の分け方で、原本から1つの作品へ分けた行の組を表す（分け方1回×作品ごとに1行）。分けた表そのものは保存せず、取込範囲の版と行番号から作り直す。 |
| [sales_source_selections](#sales_source_selections) | 売上原本の取込範囲（版） | 原本のどのシートの、どの行を見出しにし、どの行を取り込まないかの版1つを表す。登録を始める前だけ足せて変更・削除できず、最大の版番号が今の選択。 |
| [source_check_runs](#source_check_runs) | 検査の結果（回） | 原本1通の検査の結果を回ごとに残す（追記だけ。変更・削除は DB が断る）。原本ごとの連番。再検査は新しい回を足すだけで、登録（sales_source_commits）は書き換えない。判定の語は5つ。合否の数と正解表の件数を、その回の値として持つ。判定の語と合否の数が食い違う行は DB では止めない（純関数の戻りを書くのは受け口） |
| [source_sampling_reviews](#source_sampling_reviews) | 抜き取りの記録 | 人が見た1通の抜き取りの記録（追記だけ。変更・削除は DB が断る）。結果は直し無し・型の誤り・原本の誤りの3つ。型の誤りを足しても、検査の決まりの新しい版は自動では作らない。実績の通数は数える列を持たず、検査の回とこの記録から読むたびに導く |
| [tax_calculation_lines](#tax_calculation_lines) | 税計算の明細 | 1行は、税計算に使った元の売上明細1件と、その税区分・税率・参考の税額。変更・削除はできない。 |
| [tax_calculation_snapshots](#tax_calculation_snapshots) | 請求の税計算 | 1行は、請求1件を確定したときの税計算の結果。元の売上明細の税額と、税率ごとに1回丸めた請求の税額を並べて残す。変更・削除はできない。 |
| [tax_invoice_links](#tax_invoice_links) | 請求の再発行のつながり | 1行は、再発行した請求と、取り消した元の請求のつながり。変更・削除はできない。 |
| [tax_invoice_rate_totals](#tax_invoice_rate_totals) | 税計算の税率別合計 | 1行は、税計算の税区分×税率ごとの合計と、1回だけ丸めた請求の税額。変更・削除はできない。 |
| [theatrical_sale_details](#theatrical_sale_details) | 劇場売上の詳細 | 劇場の売上報告の売上明細1行について、方式・券種・動員など報告にある値を表す。金額の正本は売上明細で、ここの額（小数も入る文字）は合算しない。 |
| [workflow_report_commits](#workflow_report_commits) | 報告の登録確定 | 売上報告の原本を売上明細へ登録した記録を1行で持つ。原本1つ・報告1つにつき1回だけ書き、変更も削除もできない。 |
| [workflow_report_selections](#workflow_report_selections) | 報告の取込範囲 | 売上報告の原本から、取り込むシートと見出し行を選んだ版を1行で持つ。選び直すたびに版を積み、変更も削除もできない。 |
| [yojitsu_activity_cancellations](#yojitsu_activity_cancellations) | 予実の活動記録の取消 | 活動記録の取消（追記だけ。1行に1回）。取り消せるのは記録した人だけで、取り消した行は数えない。表はデータ一覧・一括出力の対象外 |
| [yojitsu_activity_records](#yojitsu_activity_records) | 予実の活動記録 | 案件の行動の記録（追記だけ。変更・削除は DB が断り、直しは取消の行 yojitsu_activity_cancellations を足す）。行の中身は記録した人の本人にだけ返し、ほかの人には件数だけを返す。ステップは行動のステップの参照表の段で、親の step（面談・提案・契約）へ畳んで数える。取り込んだ営業の活動は source_sales_activity_id で1回だけ。表はデータ一覧・一括出力の対象外 |
| [yojitsu_choice_versions](#yojitsu_choice_versions) | 予実の語と月の設定（版） | 値の列（bps・x100・months・yen）に入らない予実の設定の版（追記だけ。変更・削除は DB が断る）。組織×設定ごとの連番で、最新の version_no が有効。採用するシナリオ（予実の4段の着地予測・確度加重予測が読む）・月別の表に入れる案件の範囲・締めた月の3つ。数の設定は yojitsu_setting_versions |
| [yojitsu_forecast_lines](#yojitsu_forecast_lines) | 予実の予測の行 | 予測の版の行（追記だけ。変更・削除は DB が断る）。シナリオ（even・good・MAX・単一）×月（月初の日）×区分（区分マスタ）の金額。金額は税別の正の整数で、符号は区分の入出金で決める。予測に使う印は版の中の印で、有効な版の印が 1 の行だけを予測に使う |
| [yojitsu_forecast_versions](#yojitsu_forecast_versions) | 予実の予測（版） | 案件×月の予測の版のヘッダ（追記だけ。変更・削除は DB が断る）。案件ごとの連番で、最新の version_no の版が有効（前の版の行は「予測に使う＝いいえ」と読む。行が line_count に満たない版は有効にしない）。版は案件の予測の全部の行を持ち、行は yojitsu_forecast_lines。試算の写しは元のファイルの SHA-256 を持ち、同じ写しを二度取り込まない |
| [yojitsu_periods](#yojitsu_periods) | 予実の期間 | 組織ごとの1〜5年目の期間（追記だけ。変更・削除は DB が断る）。各年目は月初の日に始まる12か月で、年目の順に足し、n年目は n−1年目のちょうど12か月後に始まる（DB のトリガーが断る）。通算（5年）は持たない。目標・計画の版がこの期間を指す |
| [yojitsu_plan_amounts](#yojitsu_plan_amounts) | 予実の計画の稼ぎ方別の額 | 計画の版の子の行（追記だけ。変更・削除は DB が断る）。稼ぎ方ごとに1行で、行の数がヘッダの earning_type_count を超えたら断る。表はデータ一覧・一括出力・帳票の対象外 |
| [yojitsu_plan_versions](#yojitsu_plan_versions) | 予実の計画（版） | 計画の版のヘッダ（追記だけ。変更・削除は DB が断る）。期間ごとの連番。稼ぎ方別の額は yojitsu_plan_amounts に持ち、earning_type_count はその行の数。有効な計画は列に持たず、期間ごとの最新の採用の記録（plan_adoptions）が指す版。第1版の額は目標（会社）の仮置きで owner 本人にだけ返す。表はデータ一覧・一括出力・帳票の対象外 |
| [yojitsu_setting_versions](#yojitsu_setting_versions) | 予実の設定（版） | 行動の率と1件あたりの額などの設定の行（追記だけ。変更・削除は DB が断る）。変数×範囲ごとの連番の最新の version_no が有効。範囲で使う列だけが埋まり、値の列は bps・x100・months・yen のうちちょうど1つで、変数の値の種類と同じ。前提の数字なので状態を必ず持つ。移行では値の行を入れず、種か設定で足す |
| [yojitsu_target_versions](#yojitsu_target_versions) | 予実の目標（版） | 年の目標の版（追記だけ。変更・削除は DB が断る）。期間×種類（本人・会社）×範囲（全体・制作の取り分）ごとの連番の最新の version_no が有効。根拠が額なら額を持ち、人件費×倍率なら額を持たず倍率を持つ（報酬の行の12か月の合計×倍率を読むたびに計算する。報酬の表が無い間は未接続）。額は owner 本人にだけ返し、表はデータ一覧・一括出力・帳票の対象外（代表の報酬が割り戻せる） |
| [yojitsu_variables](#yojitsu_variables) | 予実の設定の変数 | 設定の行の変数の参照表（組織に依らない）。値の列の種類とステップごとに持つかを決める。移行 0014 で行動の率（次の段へ進む率）・1件あたりの額・着地に数える確度・窓口の支払いの間の4行を、移行 0017 で行動指標の変数（窓口の売上の倍率・1件の時間・通る確率・通過率を測る期間など18行。行動指標の計画 段B #9）を入れる。稼ぎ方の既定の売上率は持たない（earning_type_rate_versions だけが持つ）。値の種類とステップの要否は変えられない |

## billing_invoice_line_works

**請求明細の作品配賦** — 請求明細1行の金額を作品へ分ける割合を、請求時の商品の配賦のまま写したものを表す。明細ごとに合計1万（100%）で、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | invoice_id | INTEGER | 請求書（billing_invoices） | 不可 | - | PK（複合）、FK（複合）→ billing_invoice_lines |
| 3 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ billing_invoice_lines |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | PK（複合）、FK（複合）→ works |
| 5 | allocation_bps | INTEGER | 作品への配賦率（bps。1万で100%） | 不可 | - | CHECK: allocation_bps BETWEEN 1 AND 10000 |

表の制約:

- 複合の主キー: (org_id, invoice_id, sale_id, work_id)
- 複合の参照: (org_id, work_id) → works(org_id, id)
- 複合の参照: (org_id, invoice_id, sale_id) → billing_invoice_lines(org_id, invoice_id, sale_id)
- 索引 billing_line_work_idx: (org_id, work_id, invoice_id)
- トリガー billing_line_work_immutable: 更新の前
- トリガー billing_line_work_no_delete: 削除の前
- トリガー billing_line_work_validate: 追加の前

## billing_invoice_lines

**請求明細** — 請求書に含めた売上明細1行を、請求時の値のまま写したものを表す。元の売上明細と完全に一致するときだけ作れ、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | invoice_id | INTEGER | 請求書（billing_invoices） | 不可 | - | PK（複合）、FK（複合）→ billing_invoices |
| 3 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 4 | report_id | INTEGER | 売上報告（report_imports） | 不可 | - | FK（複合）→ report_imports |
| 5 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 6 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ works |
| 7 | product_id | INTEGER | 商品（products） | 可 | - | FK（複合）→ products |
| 8 | partner_id | INTEGER | 取引先（partners） | 不可 | - | FK（複合）→ partners |
| 9 | description | TEXT | 明細の内容 | 不可 | - | - |
| 10 | accounting_month | TEXT | 計上月（YYYY-MM） | 不可 | - | - |
| 11 | source_row | INTEGER | 元の報告書の行番号 | 可 | - | - |
| 12 | amount_ex_tax | INTEGER | 金額（円・税抜） | 不可 | - | - |
| 13 | tax_amount | INTEGER | 税額（円。元の報告の値） | 不可 | - | - |
| 14 | amount_inc_tax | INTEGER | 金額（円・税込） | 不可 | - | - |

表の制約:

- 複合の主キー: (org_id, invoice_id, sale_id)
- 複合の一意: (org_id, sale_id, invoice_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, product_id) → products(org_id, id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- 複合の参照: (org_id, invoice_id) → billing_invoices(org_id, id)
- CHECK: amount_inc_tax=amount_ex_tax+tax_amount
- トリガー billing_invoice_line_immutable: 更新の前
- トリガー billing_invoice_line_no_delete: 削除の前
- トリガー billing_invoice_line_validate: 追加の前

## billing_invoice_sequences

**請求番号の採番** — 組織ごと・請求日の年月ごとに、最後に出した請求番号の連番を表す。請求書を作るたびに1進める。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合）、FK → organizations.id |
| 2 | year_month | TEXT | 請求日の年月（YYYYMM） | 不可 | - | PK（複合）、CHECK: year_month GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]' |
| 3 | last_number | INTEGER | 最後に使った連番 | 不可 | - | CHECK: last_number>0 |

表の制約:

- 複合の主キー: (org_id, year_month)

## billing_invoice_voids

**請求の取消** — 請求書1通を取り消した記録（日付と理由）を表す。有効な入金をすべて取り消してからでないと作れず、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | invoice_id | INTEGER | 取り消した請求書（billing_invoices） | 不可 | - | PK（複合）、FK（複合）→ billing_invoices |
| 3 | voided_on | TEXT | 取消日（請求日以後） | 不可 | - | - |
| 4 | reason | TEXT | 取消の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 5 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, invoice_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, invoice_id) → billing_invoices(org_id, id)
- トリガー billing_invoice_void_immutable: 更新の前
- トリガー billing_invoice_void_no_delete: 削除の前
- トリガー billing_invoice_void_validate: 追加の前

## billing_invoices

**請求書** — 取引先1社へ出した請求書1通を表す。同じ取引先の有効な売上報告を選んで作り、そのときの明細・配賦・税計算を写して固定し、変えられるのは取消（void）への1回だけ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | invoice_number | TEXT | 請求番号（ON-INV-年月-連番。組織内で一意） | 不可 | - | - |
| 4 | partner_id | INTEGER | 請求先の取引先（partners） | 不可 | - | FK（複合）→ partners |
| 5 | invoice_date | TEXT | 請求日 | 不可 | - | - |
| 6 | due_date | TEXT | 契約上の支払期日 | 不可 | - | - |
| 7 | source_amount_basis | TEXT | 元の報告額の基準。platform_net（PF控除後）だけ | 不可 | - | CHECK: source_amount_basis='platform_net' |
| 8 | amount_ex_tax | INTEGER | 請求額（円・税抜） | 不可 | - | - |
| 9 | tax_amount | INTEGER | 税額（円） | 不可 | - | - |
| 10 | amount_inc_tax | INTEGER | 請求額（円・税込） | 不可 | - | CHECK: amount_inc_tax>0 |
| 11 | status | TEXT（列挙） | 状態（issued=発行済み、void=取消済み） | 不可 | issued | 値: issued / void |
| 12 | note | TEXT | 備考 | 可 | - | - |
| 13 | snapshot_json | TEXT | 請求時の報告・明細・配賦・税計算の写し | 不可 | - | - |
| 14 | snapshot_hash | TEXT | 写しの照合値（組織内で一意） | 不可 | - | - |
| 15 | version | INTEGER | 取消で1増える番号（同時更新の検出用） | 不可 | 1 | - |
| 16 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 17 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, invoice_number)
- 複合の一意: (org_id, snapshot_hash)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- CHECK: due_date>=invoice_date
- CHECK: amount_inc_tax=amount_ex_tax+tax_amount
- 索引 billing_invoice_partner_due_idx: (org_id, partner_id, due_date)
- トリガー billing_invoice_no_delete: 削除の前
- トリガー billing_invoice_update: 更新の前

## billing_receipt_allocations

**入金の消込** — 入金1回のうち、請求書1通に充てた額を表す。入金ごとの合計は入金額と一致し、請求の税込額を超えられず、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | receipt_id | INTEGER | 入金（billing_receipts） | 不可 | - | PK（複合）、FK（複合）→ billing_receipts |
| 3 | invoice_id | INTEGER | 請求書（billing_invoices） | 不可 | - | PK（複合）、FK（複合）→ billing_invoices |
| 4 | amount_yen | INTEGER | 充てた額（円。請求の税込額に対して） | 不可 | - | CHECK: amount_yen>0 |

表の制約:

- 複合の主キー: (org_id, receipt_id, invoice_id)
- 複合の参照: (org_id, invoice_id) → billing_invoices(org_id, id)
- 複合の参照: (org_id, receipt_id) → billing_receipts(org_id, id)
- 索引 billing_receipt_invoice_idx: (org_id, invoice_id, receipt_id)
- トリガー billing_receipt_allocation_complete: 追加の後
- トリガー billing_receipt_allocation_immutable: 更新の前
- トリガー billing_receipt_allocation_no_delete: 削除の前
- トリガー billing_receipt_allocation_validate: 追加の前

## billing_receipt_reversals

**入金の取消** — 入金1回を取り消した記録（逆仕訳の日と理由）を表す。取消日以後はその入金の消込を無いものとして残高を出し、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | receipt_id | INTEGER | 取り消した入金（billing_receipts） | 不可 | - | PK（複合）、FK（複合）→ billing_receipts |
| 3 | reversed_on | TEXT | 取消日（入金日以後） | 不可 | - | - |
| 4 | reason | TEXT | 取消の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 5 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, receipt_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, receipt_id) → billing_receipts(org_id, id)
- トリガー billing_receipt_reversal_immutable: 更新の前
- トリガー billing_receipt_reversal_no_delete: 削除の前
- トリガー billing_receipt_reversal_validate: 追加の前
- トリガー expense_offset_reverse_together: 追加の前

## billing_receipts

**入金** — 取引先からの入金1回を表す。請求書への消込（billing_receipt_allocations）と同時に作って変更・削除できず、直すときは入金の取消を足す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | partner_id | INTEGER | 入金した取引先（partners） | 不可 | - | FK（複合）→ partners |
| 4 | reference | TEXT | 入金の参照番号（取引先ごとに一意） | 不可 | - | CHECK: length(trim(reference)) BETWEEN 1 AND 160 |
| 5 | received_on | TEXT | 入金日 | 不可 | - | - |
| 6 | amount_yen | INTEGER | 入金額（円。請求の税込額に充てる） | 不可 | - | CHECK: amount_yen>0 |
| 7 | allocation_count | INTEGER | 消し込む請求書の件数（1〜10） | 不可 | - | CHECK: allocation_count>0 |
| 8 | note | TEXT | 備考 | 可 | - | - |
| 9 | recorded_at | TEXT | 記録した日時 | 不可 | 現在時刻 | - |
| 10 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, partner_id, reference)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- トリガー billing_receipt_immutable: 更新の前
- トリガー billing_receipt_no_delete: 削除の前

## billing_sale_claims

**請求済みの売上** — 売上明細1行がどの請求書で請求済みかを表す。1つの売上は1つの請求書でしか請求できず、請求を取り消すとこの行を消す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ billing_invoice_lines |
| 3 | invoice_id | INTEGER | 請求書（billing_invoices） | 不可 | - | FK（複合）→ billing_invoice_lines |
| 4 | claimed_at | TEXT | 請求に使った日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, sale_id)
- 複合の参照: (org_id, invoice_id, sale_id) → billing_invoice_lines(org_id, invoice_id, sale_id)
- 索引 billing_claim_invoice_idx: (org_id, invoice_id)
- トリガー billing_claim_delete: 削除の前
- トリガー billing_claim_update: 更新の前
- トリガー billing_claim_validate: 追加の前

## digital_sale_details

**配信売上の詳細** — 配信の売上報告の売上明細1行について、方式・サービス・販売数・視聴など報告にある値を表す。方式ごとに入れられる列が決まり、ここの額（小数も入る文字）は合算しない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 3 | model | TEXT（列挙） | 方式（EST・TVOD・SVOD・AVOD・FLAT・MG） | 不可 | - | 値: est / tvod / svod / avod / flat / mg |
| 4 | service_code | TEXT | 配信サービスのコード（必須） | 不可 | - | CHECK: length(trim(service_code))>0 |
| 5 | sales_count | INTEGER | 販売数（EST・TVOD） | 可 | - | CHECK: sales_count IS NULL OR sales_count>=0 |
| 6 | view_count | INTEGER | 視聴回数（SVOD・AVOD） | 可 | - | CHECK: view_count IS NULL OR view_count>=0 |
| 7 | view_seconds | INTEGER | 視聴秒数（SVOD・AVOD） | 可 | - | CHECK: view_seconds IS NULL OR view_seconds>=0 |
| 8 | unit_price_ex_tax | TEXT | 販売単価（円・税抜。EST・TVOD） | 可 | - | - |
| 9 | holder_unit_price_ex_tax | TEXT | 当社の単価（円・税抜） | 可 | - | - |
| 10 | contract_amount_ex_tax | TEXT | 契約額（円・税抜。FLATだけ） | 可 | - | - |
| 11 | contract_period_from | TEXT | 契約期間の開始日（FLATだけ） | 可 | - | - |
| 12 | contract_period_to | TEXT | 契約期間の終了日（FLATだけ） | 可 | - | - |
| 13 | reported_actual_ex_tax | TEXT | 報告にある実績額（円・税抜。合算しない） | 可 | - | - |
| 14 | reported_recognized_ex_tax | TEXT | 報告にある計上額（円・税抜。合算しない） | 可 | - | - |
| 15 | calculated_actual_ex_tax | TEXT | 実績額の計算照合値（円・税抜。合算しない） | 可 | - | - |

表の制約:

- 複合の主キー: (org_id, sale_id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- CHECK: (model IN ('est','tvod') AND view_count IS NULL AND view_seconds IS NULL AND contract_amount_ex_tax IS NULL) OR (model IN ('svod','avod') AND sales_count IS NULL AND unit_price_ex_tax IS NULL AND contract_amount_ex_tax IS NULL) OR (model IN ('flat','mg') AND sales_count IS NULL AND view_count IS NULL AND view_seconds IS NULL AND unit_price_ex_tax IS NULL)
- CHECK: model='flat' OR (contract_amount_ex_tax IS NULL AND contract_period_from IS NULL AND contract_period_to IS NULL)
- CHECK: contract_amount_ex_tax IS NULL OR (contract_period_from IS NOT NULL AND contract_period_to IS NOT NULL AND contract_period_to>=contract_period_from)
- トリガー digital_detail_immutable_delete: 削除の前
- トリガー digital_detail_immutable_update: 更新の前
- トリガー digital_detail_scope: 追加の前
- トリガー digital_detail_sealed: 追加の前

## expected_report_closures

**届くはずの報告の終了** — 届くはずの報告1件の終わり（最後の対象月と理由）を表す。1件に1行だけ足し、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | expected_report_id | INTEGER | 届くはずの報告（expected_reports） | 不可 | - | PK（複合）、FK（複合）→ expected_reports |
| 3 | last_month | TEXT（年月 YYYY-MM） | 最後の対象月（YYYY-MM） | 不可 | - | - |
| 4 | reason | TEXT | 終了の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 5 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, expected_report_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, expected_report_id) → expected_reports(org_id, id)
- トリガー expected_report_closures_after_start: 追加の前
- トリガー expected_report_closures_no_delete: 削除の前
- トリガー expected_report_closures_no_update: 更新の前

## expected_reports

**届くはずの報告** — 取引先×報告の種類（×作品）ごとに、報告が届く頻度・期限・開始月を表し、受領進捗の母集合になる。変更・削除できず、やめるときは終了の記録を足す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | partner_id | INTEGER | 報告を送る取引先（partners） | 不可 | - | FK（複合）→ partners |
| 4 | kind | TEXT（列挙） | 報告の種類（劇場・配信・ビデオグラム・放送・その他） | 不可 | - | 値: theatrical / digital / package / broadcast / other |
| 5 | work_id | INTEGER | 作品（works）。空なら作品を問わない | 可 | - | FK（複合）→ works |
| 6 | frequency | TEXT（列挙） | 頻度（毎月・四半期・半年・毎年） | 不可 | - | 値: monthly / quarterly / semiannual / annual |
| 7 | due_day | INTEGER | 期限の日。対象期間の最後の月の翌月のこの日（空は翌月末。月末を超える日はその月の末日） | 可 | - | CHECK: due_day IS NULL OR due_day BETWEEN 1 AND 31 |
| 8 | active_from | TEXT（年月 YYYY-MM） | 有効期間の開始月（YYYY-MM） | 不可 | - | - |
| 9 | note | TEXT | 備考 | 可 | - | CHECK: note IS NULL OR length(note)<=500 |
| 10 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, work_id) → works(org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 索引 expected_reports_by_partner: (org_id, partner_id, kind)
- トリガー expected_reports_no_delete: 削除の前
- トリガー expected_reports_no_overlap: 追加の前
- トリガー expected_reports_no_update: 更新の前

## import_previews

**報告取込のプレビュー** — 売上報告や宣伝の指標の CSV を登録する前のプレビュー1件。登録の時に中身を照合し、一度使ったら consumed を1にする。期限は15分。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | token | TEXT | プレビューの鍵（ランダムな文字列） | 可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | user_id | INTEGER | プレビューした利用者（users） | 不可 | - | FK（複合）→ memberships |
| 4 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 5 | work_id | INTEGER | 取り込む先の作品（works） | 不可 | - | FK（複合）→ works |
| 6 | payload_json | TEXT | プレビューの中身（原文・行・誤り・計上基準など） | 不可 | - | - |
| 7 | expires_at | TEXT | 期限（作ってから15分） | 不可 | - | - |
| 8 | consumed | INTEGER（真偽 0/1） | 登録に使ったか。1＝使用済み | 不可 | 0 | - |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 複合の参照: (org_id, user_id) → memberships(org_id, user_id)

## kpi_metric_steps

**指標マスタの段** — 指標マスタの版の子の行（追記だけ。変更・削除は DB が断る）。役×稼ぎ方ごとに段を seq の順に並べ、段は行動のステップの参照表のコード（細目は親のステップへ畳んで数える）。稼ぎ方×段は版の中で1回だけ。対応の出どころの状態を必ず持つ。行の数がヘッダの step_count を超えたら断る

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | metric_version_id | INTEGER | 指標マスタの版（kpi_metric_versions） | 不可 | - | PK（複合）、FK（複合）→ kpi_metric_versions |
| 3 | role | TEXT（列挙） | 役（producer プロデューサー・sales_sourcing 営業（仕入れ）・sales_selling 営業（売り）） | 不可 | - | PK（複合）、値: producer / sales_sourcing / sales_selling |
| 4 | earning_type | TEXT | 稼ぎ方（earning_types） | 不可 | - | PK（複合）、FK → earning_types.code |
| 5 | seq | INTEGER | 役×稼ぎ方の中の段の順（1から） | 不可 | - | PK（複合）、CHECK: typeof(seq)='integer' AND seq BETWEEN 1 AND 20 |
| 6 | step | TEXT | 段（action_steps。細目の段は親のステップへ畳む） | 不可 | - | FK → action_steps.code |
| 7 | status | TEXT（列挙） | 対応の出どころの状態（confirmed 確認済み・director_reported 監督申告・press_reported 報道値・provisional 仮置き） | 不可 | - | 値: confirmed / director_reported / press_reported / provisional |
| 8 | basis | TEXT | 出どころの文 | 可 | - | CHECK: basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000 |

表の制約:

- 複合の主キー: (org_id, metric_version_id, role, earning_type, seq)
- 複合の一意: (org_id, metric_version_id, earning_type, step)
- 複合の参照: (org_id, metric_version_id) → kpi_metric_versions(org_id, id)
- トリガー kpi_metric_steps_count: 追加の前
- トリガー kpi_metric_steps_in_order: 追加の前
- トリガー kpi_metric_steps_no_delete: 削除の前
- トリガー kpi_metric_steps_no_update: 更新の前

## kpi_metric_versions

**指標マスタ（版）** — 指標マスタの版のヘッダ（追記だけ。変更・削除は DB が断る）。組織ごとの連番で、最新の version_no の版が有効。段の行は kpi_metric_steps に持ち、step_count はその行の数（行が足りない版は有効にしない）。段の率・1件の時間・1件の額などの値は持たず、設定の行（yojitsu_setting_versions）だけに持つ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | version_no | INTEGER | 組織ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 4 | step_count | INTEGER | 段の行の数（1〜200） | 不可 | - | CHECK: typeof(step_count)='integer' AND step_count BETWEEN 1 AND 200 |
| 5 | basis | TEXT | 版を足した理由の文 | 可 | - | CHECK: basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000 |
| 6 | created_on | TEXT | 作った日（YYYY-MM-DD） | 不可 | - | CHECK: length(created_on)=10 AND substr(created_on,5,1)='-' AND substr(created_on,8,1)='-' AND ltrim(substr(created_on,1,4)\|\|substr(created_on,6,2)\|\|substr(created_on,9,2),'0123456789')='' AND substr(created_on,6,2) BETWEEN '01' AND '12' AND substr(created_on,9,2) BETWEEN '01' AND '31' |
| 7 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- トリガー kpi_metric_versions_no_delete: 削除の前
- トリガー kpi_metric_versions_no_update: 更新の前
- トリガー kpi_metric_versions_sequence: 追加の前

## mapping_import_provenance

**読み替え取込の出どころ** — 読み替えを通して取り込んだ売上報告1件の出どころ。受け取った原文と読み替え後の CSV を両方残し、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | report_id | INTEGER | 登録した売上報告（report_imports）。1報告に1行 | 不可 | - | PK（複合）、FK（複合）→ report_imports |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ report_imports |
| 4 | partner_id | INTEGER | 報告元の取引先（partners） | 不可 | - | FK（複合）→ partners |
| 5 | kind | TEXT（列挙） | 報告の種類（劇場・配信・ビデオグラム・放送・その他） | 不可 | - | 値: theatrical / digital / package / broadcast / other |
| 6 | mapping_version_id | INTEGER | 使った読み替えの版（report_mapping_versions） | 不可 | - | FK（複合）→ report_mapping_versions |
| 7 | original_text | TEXT | 受け取った原文（CSV） | 不可 | - | - |
| 8 | original_hash | TEXT | 原文の SHA-256。同じ作品・取引先・種類で同じ原文は二度入らない | 不可 | - | - |
| 9 | canonical_text | TEXT | 読み替えた後の共通の形の CSV | 不可 | - | - |
| 10 | canonical_hash | TEXT | 読み替え後の CSV の SHA-256 | 不可 | - | - |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, report_id)
- 複合の一意: (org_id, work_id, partner_id, kind, original_hash)
- 複合の参照: (org_id, mapping_version_id) → report_mapping_versions(org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, work_id, report_id) → report_imports(org_id, work_id, id)
- トリガー mapping_provenance_immutable: 更新の前

## package_observation_products

**ビデオグラム観測の対象商品** — ビデオグラム報告の観測値1つ（report_id・source_row・metric で指す）が、どの商品の数かを表す。商品が決まる行だけに作り、無ければ作品全体の数として扱う。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | report_id | INTEGER | 売上報告（report_imports） | 不可 | - | PK（複合）、FK（複合）→ package_report_observations |
| 3 | source_row | INTEGER | 報告書の行番号 | 不可 | - | PK（複合）、FK（複合）→ package_report_observations |
| 4 | metric | TEXT | 数の種類（package_report_observations と同じ） | 不可 | - | PK（複合）、FK（複合）→ package_report_observations |
| 5 | product_id | INTEGER | 商品（products） | 不可 | - | FK（複合）→ products |

表の制約:

- 複合の主キー: (org_id, report_id, source_row, metric)
- 複合の参照: (org_id, product_id) → products(org_id, id)
- 複合の参照: (org_id, report_id, source_row, metric) → package_report_observations(org_id, report_id, source_row, metric)
- トリガー package_observation_product_immutable_delete: 削除の前
- トリガー package_observation_product_immutable_update: 更新の前
- トリガー package_observation_product_sealed: 追加の前

## package_report_observations

**ビデオグラム報告の観測値** — ビデオグラムの報告の1行にある、出荷・稼働・在庫・返品の数1つを表す。売上ではないので売上額と合算せず、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | report_id | INTEGER | 売上報告（report_imports。ビデオグラムだけ） | 不可 | - | PK（複合）、FK（複合）→ report_imports |
| 3 | source_row | INTEGER | 報告書の行番号 | 不可 | - | PK（複合）、CHECK: source_row>=1 |
| 4 | metric | TEXT（列挙） | 数の種類（出荷・稼働・在庫・返品） | 不可 | - | PK（複合）、値: delivered / active / inventory / returned |
| 5 | count | INTEGER | 数 | 不可 | - | CHECK: count>=0 |
| 6 | unit | TEXT | 数の単位（観測単位） | 不可 | - | CHECK: length(trim(unit))>0 |
| 7 | scope | TEXT | 数の範囲（観測範囲） | 不可 | - | CHECK: length(trim(scope))>0 |
| 8 | basis | TEXT | 数の根拠（観測根拠） | 不可 | - | CHECK: length(trim(basis))>0 |
| 9 | observed_on | TEXT | 在庫を数えた日（在庫のときは必須） | 可 | - | - |

表の制約:

- 複合の主キー: (org_id, report_id, source_row, metric)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- CHECK: metric<>'inventory' OR observed_on IS NOT NULL
- トリガー package_observation_immutable_delete: 削除の前
- トリガー package_observation_immutable_update: 更新の前
- トリガー package_observation_scope: 追加の前
- トリガー package_observation_sealed: 追加の前
- トリガー report_source_control_observation_delete: 削除の前
- トリガー report_source_control_observation_insert: 追加の前
- トリガー report_source_control_observation_update: 更新の前

## package_sale_details

**ビデオグラム売上の詳細** — ビデオグラムの売上報告の売上明細1行について、方式・回転数・単価など報告にある値を表す。金額の正本は売上明細で、ここの額（小数も入る文字）は合算しない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 3 | model | TEXT（列挙） | 方式（rental=レンタル、sell_through=セル、license） | 不可 | - | 値: rental / sell_through / license |
| 4 | turns_count | INTEGER | レンタル回数（レンタルだけ） | 可 | - | CHECK: turns_count IS NULL OR turns_count>=0 |
| 5 | average_rental_price_ex_tax | TEXT | 平均レンタル単価（円・税抜。レンタルだけ） | 可 | - | - |
| 6 | holder_unit_price_ex_tax | TEXT | 当社の単価（円・税抜） | 可 | - | - |
| 7 | reported_actual_ex_tax | TEXT | 報告にある実績額（円・税抜。合算しない） | 可 | - | - |
| 8 | reported_recognized_ex_tax | TEXT | 報告にある計上額（円・税抜。合算しない） | 可 | - | - |
| 9 | calculated_actual_ex_tax | TEXT | 実績額の計算照合値（円・税抜。合算しない） | 可 | - | - |

表の制約:

- 複合の主キー: (org_id, sale_id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- CHECK: model='rental' OR (turns_count IS NULL AND average_rental_price_ex_tax IS NULL)
- トリガー package_detail_immutable_delete: 削除の前
- トリガー package_detail_immutable_update: 更新の前
- トリガー package_detail_scope: 追加の前
- トリガー package_detail_sealed: 追加の前

## plan_adoptions

**計画の採用の記録** — 計画の版を採用した記録（追記だけ。変更・削除は DB が断る）。期間ごとの連番の最新の行が指す版が有効な計画。第1版も1行書き、「戻す」は古い版を指す行を足すだけ。指せるのは子表のそろった同じ期間の版で、採用した日は前の行より前にしない。シナリオとの結びは持たない。表はデータ一覧・一括出力・帳票の対象外

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | period_id | INTEGER | 期間（yojitsu_periods。指す版と同じ期間） | 不可 | - | FK（複合）→ yojitsu_plan_versions |
| 4 | seq | INTEGER | 期間ごとの連番（1から） | 不可 | - | CHECK: typeof(seq)='integer' AND seq>0 |
| 5 | plan_version_id | INTEGER | 採用した計画の版（yojitsu_plan_versions） | 不可 | - | FK（複合）→ yojitsu_plan_versions |
| 6 | adopted_on | TEXT | 採用した日（YYYY-MM-DD） | 不可 | - | CHECK: length(adopted_on)=10 AND substr(adopted_on,5,1)='-' AND substr(adopted_on,8,1)='-' AND ltrim(substr(adopted_on,1,4)\|\|substr(adopted_on,6,2)\|\|substr(adopted_on,9,2),'0123456789')='' AND substr(adopted_on,6,2) BETWEEN '01' AND '12' AND substr(adopted_on,9,2) BETWEEN '01' AND '31' |
| 7 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, period_id, seq)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, period_id, plan_version_id) → yojitsu_plan_versions(org_id, period_id, id)
- トリガー plan_adoptions_complete_version: 追加の前
- トリガー plan_adoptions_date_order: 追加の前
- トリガー plan_adoptions_no_delete: 削除の前
- トリガー plan_adoptions_no_update: 更新の前
- トリガー plan_adoptions_sequence: 追加の前

## receipt_plan_decisions

**入金予定の変更判断** — 入金予定の変更申請1件への管理者の承認か却下を表す。承認すると入金予定の版が1進み、適用日以後はその予定日を使う。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | request_id | INTEGER | 変更申請（receipt_plan_requests） | 不可 | - | PK（複合）、FK（複合）→ receipt_plan_requests |
| 3 | invoice_id | INTEGER | 請求書（billing_invoices） | 不可 | - | FK（複合）→ receipt_plan_requests |
| 4 | decision | TEXT（列挙） | 判断（approved=承認、rejected=却下） | 不可 | - | 値: approved / rejected |
| 5 | version_no | INTEGER | 承認で決まる入金予定の版。却下は空 | 可 | - | - |
| 6 | effective_on | TEXT | 適用日（この日以後の基準日で新しい予定を使う） | 不可 | - | - |
| 7 | reason | TEXT | 判断の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 8 | created_by | INTEGER | 判断した管理者（memberships） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 判断した日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, request_id)
- 複合の一意: (org_id, invoice_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, invoice_id, request_id) → receipt_plan_requests(org_id, invoice_id, id)
- CHECK: (decision='approved' AND version_no>0) OR (decision='rejected' AND version_no IS NULL)
- トリガー plan_approval_guard: 追加の前
- トリガー plan_decision_no_delete: 削除の前
- トリガー plan_decision_no_update: 更新の前

## receipt_plan_requests

**入金予定の変更申請** — 請求書1通の入金予定日を変えたいという申請1件を表す。入金表の画面で出して管理者が承認・却下し、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | invoice_id | INTEGER | 請求書（billing_invoices） | 不可 | - | FK（複合）→ billing_invoices |
| 4 | base_version | INTEGER | 申請時の入金予定の版（0=請求書の支払期日のまま） | 不可 | - | CHECK: base_version>=0 |
| 5 | previous_due_date | TEXT | 変更前の入金予定日 | 不可 | - | - |
| 6 | proposed_due_date | TEXT | 変更後の入金予定日（請求日以後） | 不可 | - | - |
| 7 | reason | TEXT | 申請の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 8 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, invoice_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, invoice_id) → billing_invoices(org_id, id)
- トリガー plan_request_no_delete: 削除の前
- トリガー plan_request_no_update: 更新の前

## recognition_bases

**計上基準** — 売上の計上月を決める基準のマスタ。5件で固定で、DB を作るときに入り、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER（列挙） | 基準の番号（1〜5で固定） | 不可 | - | PK、値: 1 / 2 / 3 / 4 / 5 |
| 2 | code | TEXT | 基準のコード（sales_month・broadcast_month など） | 不可 | - | Unique |
| 3 | name | TEXT | 基準の名前（販売月・報告受領月・放送月など） | 不可 | - | - |
| 4 | source_field | TEXT | 計上月を取り出す列（report_recognition の列名。販売月は年月、ほかは日付） | 不可 | - | Unique |

表の制約:

- CHECK: (id=1 AND code='sales_month' AND source_field='sales_month') OR (id=2 AND code='report_received_month' AND source_field='report_received_on') OR (id=3 AND code='contract_start_month' AND source_field='contract_start_on') OR (id=4 AND code='license_start_month' AND source_field='license_start_on') OR (id=5 AND code='broadcast_month' AND source_field='broadcast_on')

## report_channel_fact_seals

**報告の流通別の封印** — 売上報告1件の流通別の詳細（劇場・ビデオグラム・配信の詳細と観測値）を入れ終えた印を表す。報告の登録で最後に足し、以後その報告の詳細は足せない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | report_id | INTEGER | 売上報告（report_imports） | 不可 | - | PK（複合）、FK（複合）→ report_imports |
| 3 | sealed_at | TEXT | 封印した日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, report_id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- トリガー report_channel_fact_seal_immutable_delete: 削除の前
- トリガー report_channel_fact_seal_immutable_update: 更新の前

## report_check_cases

**検査の正解表** — 検査の決まりの版ごとの正解表の1行（追記だけ。変更・削除は DB が断る）。架空の原本と、7つの検査の期待する合否。出どころは種（ふつうの通・端数のある通・取り込まない行のある通）か人の直し。実在の原本は入れない（fictional は 1 だけ）。人の直しを足せるのは、代表（role が admin で在籍が有効）か財務担当（permission が edit で、在籍と権限の期限が切れていない）だけ。種の行はこの止めの対象外

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | check_version_id | INTEGER | 検査の決まりの版（report_check_versions） | 不可 | - | FK（複合）→ report_check_versions |
| 4 | origin | TEXT（列挙） | 出どころ（normal ふつうの通・fractional 端数のある通・excluded 取り込まない行のある通・human_fix 人の直し） | 不可 | - | 値: normal / fractional / excluded / human_fix |
| 5 | fictional | INTEGER | 架空である印（1 だけ。実在の原本は入れない） | 不可 | - | CHECK: typeof(fictional)='integer' AND fictional=1 |
| 6 | input_json | TEXT | 架空の原本と登録予定（JSON のオブジェクト。検査の純関数の入力） | 不可 | - | CHECK: json_valid(input_json) AND json_type(input_json)='object' AND length(input_json) BETWEEN 2 AND 65536 |
| 7 | expected_json | TEXT | 7つの検査の期待する合否（JSON のオブジェクト。キーは検査の名前、値は真偽） | 不可 | - | CHECK: json_valid(expected_json) AND json_type(expected_json)='object' AND length(expected_json) BETWEEN 2 AND 2000 |
| 8 | reason | TEXT | この行を足した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 9 | created_by | INTEGER | 行を足した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, check_version_id) → report_check_versions(org_id, id)
- トリガー report_check_cases_human_fix_approval: 追加の前
- トリガー report_check_cases_no_delete: 削除の前
- トリガー report_check_cases_no_update: 更新の前

## report_check_versions

**検査の決まり（版）** — 取引先×報告の種類ごとの検査の決まりの版（追記だけ。変更・削除は DB が断る）。指す列対応の版・検算の決まり・見出しの列名・取り込まない行の規則・税抜・税額・税込の列名・商品で分けるか・版の理由を持つ。連番は取引先×報告の種類ごと。指す列対応の版は、同じ組織・同じ取引先・同じ報告の種類のものだけ。正答率の列は持たない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | partner_id | INTEGER | 型の取引先（partners） | 不可 | - | FK（複合）→ partners |
| 4 | kind | TEXT（列挙） | 報告の種類（劇場・配信・パッケージ・放送・その他・宣伝。列対応の profile と同じ語に、宣伝を足したもの） | 不可 | - | 値: theatrical / digital / package / broadcast / other / publicity |
| 5 | version_no | INTEGER | 取引先×報告の種類ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 6 | mapping_version_id | INTEGER | 指す列対応の版（report_mapping_versions。同じ取引先と報告の種類） | 不可 | - | FK（複合）→ report_mapping_versions |
| 7 | checks_json | TEXT | 検算の決まり（JSON の配列。空でもよい。中身は既存の CHECK_TYPES） | 不可 | - | CHECK: json_valid(checks_json) AND json_type(checks_json)='array' AND json_array_length(checks_json) BETWEEN 0 AND 50 AND length(checks_json) BETWEEN 2 AND 4000 |
| 8 | header_columns_json | TEXT | 見出しの一致に使う列名（JSON の配列。順も一致させる。1つ以上） | 不可 | - | CHECK: json_valid(header_columns_json) AND json_type(header_columns_json)='array' AND json_array_length(header_columns_json) BETWEEN 1 AND 200 AND length(header_columns_json) BETWEEN 2 AND 4000 |
| 9 | skip_rules_json | TEXT | 取り込まない行の規則（JSON の配列。1件の形は未決なので、この列は中身を解釈しない） | 不可 | - | CHECK: json_valid(skip_rules_json) AND json_type(skip_rules_json)='array' AND json_array_length(skip_rules_json) BETWEEN 0 AND 50 AND length(skip_rules_json) BETWEEN 2 AND 4000 |
| 10 | money_columns_json | TEXT | 税抜・税額・税込の列名（JSON のオブジェクト。amountExTax・taxAmount・amountIncTax） | 不可 | - | CHECK: json_valid(money_columns_json) AND json_type(money_columns_json)='object' AND length(money_columns_json) BETWEEN 2 AND 2000 AND json_extract(money_columns_json,'$.amountExTax') IS NOT NULL AND length(json_extract(money_columns_json,'$.amountExTax')) BETWEEN 1 AND 80 AND json_extract(money_columns_json,'$.taxAmount') IS NOT NULL AND length(json_extract(money_columns_json,'$.taxAmount')) BETWEEN 1 AND 80 AND json_extract(money_columns_json,'$.amountIncTax') IS NOT NULL AND length(json_extract(money_columns_json,'$.amountIncTax')) BETWEEN 1 AND 80 |
| 11 | split_by_product | INTEGER | 商品で分ける型なら 1、分けない型なら 0 | 不可 | - | CHECK: typeof(split_by_product)='integer' AND split_by_product IN (0,1) |
| 12 | reason | TEXT | この版を足した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 13 | created_by | INTEGER | 版を足した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 14 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, partner_id, kind, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, mapping_version_id) → report_mapping_versions(org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- トリガー report_check_versions_mapping_match: 追加の前
- トリガー report_check_versions_no_delete: 削除の前
- トリガー report_check_versions_no_update: 更新の前
- トリガー report_check_versions_sequence: 追加の前

## report_imports

**売上報告の取込** — 取り込んだ売上報告（宣伝の指標の報告も含む）1件の原文と情報。訂正は新しい行を足し、前の行を superseded（訂正版あり）にする。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ works |
| 4 | partner_id | INTEGER | 報告元の取引先（partners）。宣伝の取込では空 | 可 | - | FK（複合）→ partners |
| 5 | report_key | TEXT | 報告書キー（1〜200字）。訂正版を同じキーで束ねる | 不可 | - | - |
| 6 | kind | TEXT（列挙） | 報告の種類（劇場・配信・ビデオグラム・放送・その他・宣伝） | 不可 | - | 値: theatrical / digital / package / broadcast / other / publicity |
| 7 | period_from | TEXT | 報告の対象期間の開始日 | 不可 | - | - |
| 8 | period_to | TEXT | 報告の対象期間の終了日 | 不可 | - | - |
| 9 | accounting_month | TEXT（年月 YYYY-MM） | 計上月（YYYY-MM） | 不可 | - | - |
| 10 | raw_text | TEXT | 取り込んだ原文（CSV の文字） | 不可 | - | - |
| 11 | content_hash | TEXT | 原文の SHA-256。同じキーで同じ原文は二度入らない | 不可 | - | - |
| 12 | status | TEXT（列挙） | 状態。active＝有効、superseded＝訂正版あり、void＝取消済み。いまコードが入れるのは active と superseded だけで、void にする処理は無い | 不可 | active | 値: active / superseded / void |
| 13 | supersedes_id | INTEGER | この版が訂正した前の報告（report_imports） | 可 | - | FK（複合）→ report_imports、FK → report_imports.id |
| 14 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK → users.id |
| 15 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, report_key, content_hash)
- 複合の一意: (org_id, id)
- 複合の一意: (org_id, work_id, id)
- 複合の参照: (org_id, supersedes_id) → report_imports(org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, work_id) → works(org_id, id)
- CHECK: period_to>=period_from
- CHECK: supersedes_id IS NULL OR supersedes_id<>id
- 索引 report_active_key_uidx: (org_id, work_id, report_key) 一意 WHERE status='active'
- トリガー billed_report_locked_delete: 削除の前
- トリガー billed_report_locked_update: 更新の前
- トリガー channel_report_kind_locked: 更新（kind）の前
- トリガー report_recognition_report_update: 更新（accounting_month）の前
- トリガー report_source_control_report_identity_update: 更新（org_id,report_key,content_hash,kind）の前
- トリガー report_supersede_scope: 追加の前

## report_mapping_profiles

**報告書の読み替え定義** — 取引先ごと・報告の種類ごとに、報告書の列を共通の形へ読み替える定義の見出し1件。中身は版に持ち、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | partner_id | INTEGER | 報告を出す取引先（partners） | 不可 | - | FK（複合）→ partners |
| 4 | kind | TEXT（列挙） | 報告の種類（劇場・配信・ビデオグラム・放送・その他） | 不可 | - | 値: theatrical / digital / package / broadcast / other |
| 5 | name | TEXT | 読み替え定義の名前 | 不可 | - | - |
| 6 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, partner_id, kind, name)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- トリガー report_mapping_profile_immutable: 更新の前

## report_mapping_versions

**読み替え定義の版** — 読み替え定義の中身の版1件。直すときは新しい版を足し、書き換えない。取込の登録の時にハッシュで同じ版か確かめる。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | profile_id | INTEGER | 読み替え定義（report_mapping_profiles） | 不可 | - | FK（複合）→ report_mapping_profiles |
| 4 | version_no | INTEGER | 定義の中の版番号（1から） | 不可 | - | CHECK: version_no>0 |
| 5 | definition_json | TEXT | 列の対応（元の列・固定値・足し引き掛け）と無視する列 | 不可 | - | - |
| 6 | definition_hash | TEXT | 定義の SHA-256 | 不可 | - | - |
| 7 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, profile_id, id)
- 複合の一意: (org_id, profile_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, profile_id) → report_mapping_profiles(org_id, id)
- トリガー report_mapping_version_immutable: 更新の前

## report_recognition

**報告の計上基準** — 売上報告1件ごとの計上基準と、その基準から決めた計上月。基準の列を含む報告を取り込むときに作り、あとから変えられない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | report_id | INTEGER | 売上報告（report_imports）。1報告に1行 | 不可 | - | PK（複合）、FK（複合）→ report_imports |
| 3 | recognition_basis_id | INTEGER | 計上基準（recognition_bases） | 不可 | - | FK → recognition_bases.id |
| 4 | sales_month | TEXT（年月 YYYY-MM） | 販売月（YYYY-MM）。販売月の基準で使う | 可 | - | - |
| 5 | report_received_on | TEXT（日付 YYYY-MM-DD） | 報告受領日。報告受領月の基準で使う | 可 | - | - |
| 6 | contract_start_on | TEXT（日付 YYYY-MM-DD） | 契約開始日。契約開始月の基準で使う | 可 | - | - |
| 7 | license_start_on | TEXT（日付 YYYY-MM-DD） | ライセンス利用開始日。利用開始月の基準で使う | 可 | - | - |
| 8 | broadcast_on | TEXT（日付 YYYY-MM-DD） | 放送日。放送月の基準で使う | 可 | - | - |
| 9 | basis_reason | TEXT | 計上根拠（1〜1000字） | 不可 | - | CHECK: length(trim(basis_reason)) BETWEEN 1 AND 1000 |
| 10 | accounting_status | TEXT | 会計の確認状態。いまは unverified（未確認）だけ | 不可 | unverified | CHECK: accounting_status='unverified' |
| 11 | resolved_month | TEXT（年月 YYYY-MM） | 基準から出した計上月。報告と明細の計上月に一致 | 不可 | - | - |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, report_id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- CHECK: (recognition_basis_id=1 AND sales_month IS NOT NULL AND resolved_month=sales_month) OR (recognition_basis_id=2 AND report_received_on IS NOT NULL AND resolved_month=substr(report_received_on,1,7)) OR (recognition_basis_id=3 AND contract_start_on IS NOT NULL AND resolved_month=substr(contract_start_on,1,7)) OR (recognition_basis_id=4 AND license_start_on IS NOT NULL AND resolved_month=substr(license_start_on,1,7)) OR (recognition_basis_id=5 AND broadcast_on IS NOT NULL AND resolved_month=substr(broadcast_on,1,7))
- トリガー report_recognition_immutable: 更新の前
- トリガー report_recognition_month_insert: 追加の前
- トリガー report_recognition_month_update: 更新の前

## report_source_controls

**報告原本の合計値** — 売上報告の原本に書かれた合計（行数・税抜・税額・税込）を書き写した値1件。報告を登録して封をしたあと、取り込んだ明細の合計と一致するときだけ入る。入ったあとは、その報告の明細（パッケージの観測値を含む）を足すことも変えることも消すこともできず、この値も変更・削除できない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | report_id | INTEGER | 売上報告（report_imports） | 不可 | - | PK（複合）、FK（複合）→ report_imports |
| 3 | scope_kind | TEXT（列挙） | 範囲。report＝報告全体、channel＝流通ごと | 不可 | - | PK（複合）、値: report / channel |
| 4 | channel | TEXT | 流通（範囲が channel のときだけ。ほかは空文字） | 不可 | （空文字） | PK（複合） |
| 5 | metric | TEXT（列挙） | 何の合計か（行数・税抜額・税額・税込額） | 不可 | - | PK（複合）、値: row_count / amount_ex_tax / tax_amount / amount_inc_tax |
| 6 | expected_value | INTEGER | 原本の値（行数は件、額は円） | 不可 | - | CHECK: expected_value BETWEEN -9007199254740991 AND 9007199254740991 |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, report_id, scope_kind, channel, metric)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- CHECK: (scope_kind='report' AND channel='') OR (scope_kind='channel' AND channel IN ('theatrical','digital','package','broadcast','other'))
- CHECK: metric<>'row_count' OR expected_value>=0
- トリガー report_source_control_channel_scope: 追加の前
- トリガー report_source_control_immutable_delete: 削除の前
- トリガー report_source_control_immutable_update: 更新の前
- トリガー report_source_control_matches_sealed_report: 追加の前

## report_voids

**報告の取消の記録** — 登録済みの報告1件を取り違えのために取り消した記録（理由・誰が・いつ）を表す。同じ書き込みで報告（report_imports）を取消（void）にしたあとにだけ足せ、報告ごとに1つ。請求済みの報告は取り消せない（既存のトリガー）。変更・削除は DB が断る

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | report_id | INTEGER | 取り消した報告（report_imports） | 不可 | - | PK（複合）、FK（複合）→ report_imports |
| 3 | reason | TEXT | 取消の理由（取り違えの内容） | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 4 | created_by | INTEGER | 取り消した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 5 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, report_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- トリガー report_voids_no_delete: 削除の前
- トリガー report_voids_no_update: 更新の前
- トリガー report_voids_requires_void: 追加の前

## sale_attribute_values

**売上の拡張属性の値（版）** — 売上明細1件×拡張属性の列1つの値の版。ほかの表に置き場の無い値（劇場名・券種など）を、財務の権限で手入力か売上報告の取込で積み、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 3 | column_key | TEXT | 拡張属性の列キー（sales_sheet_column_versions） | 不可 | - | PK（複合） |
| 4 | version_no | INTEGER | 売上×列ごとの版の連番 | 不可 | - | PK（複合）、CHECK: version_no>0 |
| 5 | value_text | TEXT | 文字・日付・年月の値 | 可 | - | CHECK: value_text IS NULL OR length(value_text) BETWEEN 1 AND 500 |
| 6 | value_number | 型なし | 金額・数・率・はい/いいえの値（両方空は値を消した版） | 可 | - | CHECK: value_number IS NULL OR typeof(value_number) IN ('integer','real') |
| 7 | origin | TEXT（列挙） | manual＝画面で手入力、report_import＝売上報告の取込 | 不可 | - | 値: manual / report_import |
| 8 | reason | TEXT | この版を登録した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, sale_id, column_key, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- CHECK: value_text IS NULL OR value_number IS NULL
- 索引 sale_attribute_values_column_idx: (org_id, column_key)
- トリガー sale_attribute_values_check: 追加の前
- トリガー sale_attribute_values_no_delete: 削除の前
- トリガー sale_attribute_values_no_update: 更新の前

## sale_currency_versions

**売上の外貨（版）** — 売上明細1件ごとの通貨・外貨の額・為替レートの版。円の計上額と外貨×レートが1円まで合うときだけ積め、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 3 | version_no | INTEGER | 売上ごとの版の連番 | 不可 | - | PK（複合）、CHECK: version_no>0 |
| 4 | currency_code | TEXT | 通貨コード（USD など3文字。円は JPY） | 不可 | - | CHECK: length(currency_code)=3 AND currency_code NOT GLOB '*[^A-Z]*' |
| 5 | original_amount_x100 | INTEGER | 外貨の計上額（税抜。100倍した整数。円のときは空） | 可 | - | CHECK: original_amount_x100 IS NULL OR typeof(original_amount_x100)='integer' |
| 6 | original_royalty_x100 | INTEGER | 外貨のロイヤリティ計上額（100倍した整数） | 可 | - | CHECK: original_royalty_x100 IS NULL OR typeof(original_royalty_x100)='integer' |
| 7 | exchange_rate_x10000 | INTEGER | 為替レート（1外貨あたりの円。1万倍した整数） | 不可 | - | CHECK: typeof(exchange_rate_x10000)='integer' AND exchange_rate_x10000>0 |
| 8 | rate_date | TEXT | レートの適用日 | 不可 | - | CHECK: rate_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' |
| 9 | basis | TEXT | レートの根拠（出典） | 不可 | - | CHECK: length(trim(basis)) BETWEEN 1 AND 500 |
| 10 | reason | TEXT | この版を登録した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, sale_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- CHECK: currency_code<>'JPY' OR exchange_rate_x10000=10000
- CHECK: currency_code='JPY' OR original_amount_x100 IS NOT NULL
- トリガー sale_currency_versions_check: 追加の前
- トリガー sale_currency_versions_no_delete: 削除の前
- トリガー sale_currency_versions_no_update: 更新の前

## sale_lines

**売上明細** — 売上報告から取り込んだ売上の明細1行。取込の登録で作る。請求に使った行と、原本の合計で照合済みの報告の行は変えられない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ report_imports、FK（複合）→ works |
| 5 | report_id | INTEGER | 元の売上報告（report_imports） | 可 | - | FK（複合）→ report_imports |
| 6 | product_id | INTEGER | 商品（products）。空なら明細の作品の売上とする | 可 | - | FK（複合）→ products |
| 7 | partner_id | INTEGER | 取引先（partners） | 不可 | - | FK（複合）→ partners |
| 8 | sales_period_from | TEXT | 販売期間の開始日 | 不可 | - | - |
| 9 | sales_period_to | TEXT | 販売期間の終了日 | 不可 | - | - |
| 10 | accounting_month | TEXT（年月 YYYY-MM） | 計上月（YYYY-MM） | 不可 | - | - |
| 11 | description | TEXT | 明細の内容（なければ「報告明細」） | 不可 | - | - |
| 12 | quantity | INTEGER | 数量（空も可） | 可 | - | CHECK: quantity IS NULL OR quantity>=0 |
| 13 | amount_ex_tax | INTEGER | 税抜額（円）。マイナスも入る | 不可 | - | - |
| 14 | tax_amount | INTEGER | 税額（円）。マイナスも入る | 不可 | - | - |
| 15 | amount_inc_tax | INTEGER | 税込額（円）。税抜額＋税額 | 不可 | - | - |
| 16 | source_row | INTEGER | 原本の行番号 | 可 | - | - |
| 17 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, product_id) → products(org_id, id)
- 複合の参照: (org_id, work_id, report_id) → report_imports(org_id, work_id, id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- CHECK: amount_inc_tax=amount_ex_tax+tax_amount
- CHECK: sales_period_to>=sales_period_from
- 索引 committee_sale_lines_product_month_idx: (org_id, product_id, accounting_month)
- 索引 committee_sale_lines_work_month_idx: (org_id, work_id, accounting_month)
- 索引 sale_report_row_uidx: (org_id, report_id, source_row) 一意 WHERE report_id IS NOT NULL
- トリガー billed_sale_locked_delete: 削除の前
- トリガー billed_sale_locked_update: 更新の前
- トリガー channel_sale_parent_locked: 更新（org_id,report_id）の前
- トリガー report_recognition_sale_insert: 追加の前
- トリガー report_recognition_sale_update: 更新（accounting_month,report_id,sales_period_from,sales_period_to）の前
- トリガー report_source_control_sale_delete: 削除の前
- トリガー report_source_control_sale_insert: 追加の前
- トリガー report_source_control_sale_update: 更新の前

## sale_royalty_basis_versions

**ロイヤリティ計上の基準（版）** — 売上明細1件ごとの、ロイヤリティ計上月と計上額（税抜・税込）の版。記録の無い売上は計上月・計上額と同じとみなし、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 3 | version_no | INTEGER | 売上ごとの版の連番 | 不可 | - | PK（複合）、CHECK: version_no>0 |
| 4 | royalty_month | TEXT | ロイヤリティ計上月（YYYY-MM） | 不可 | - | CHECK: royalty_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND CAST(substr(royalty_month,6,2) AS INTEGER) BETWEEN 1 AND 12 |
| 5 | royalty_amount_ex_tax | INTEGER | ロイヤリティ計上額（円・税抜） | 不可 | - | CHECK: typeof(royalty_amount_ex_tax)='integer' |
| 6 | royalty_tax_amount | INTEGER | ロイヤリティ計上額の消費税（円） | 不可 | - | CHECK: typeof(royalty_tax_amount)='integer' |
| 7 | royalty_amount_inc_tax | INTEGER | ロイヤリティ計上額（円・税込＝税抜＋消費税） | 不可 | - | CHECK: typeof(royalty_amount_inc_tax)='integer' |
| 8 | reason | TEXT | この版を登録した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, sale_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- CHECK: royalty_amount_inc_tax=royalty_amount_ex_tax+royalty_tax_amount
- トリガー sale_royalty_basis_versions_no_delete: 削除の前
- トリガー sale_royalty_basis_versions_no_update: 更新の前
- トリガー sale_royalty_basis_versions_sequence: 追加の前

## sales_sheet_column_versions

**売上集計シートの列（版）** — 売上集計シートの列1つの定義（見出し・型・集計の決まり・値の取り方）の版。管理者が初期の83列の採用や列の追加で積み、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合）、FK → organizations.id |
| 2 | column_key | TEXT | 列キー（英小文字・数字・_。版をまたいで同じ列） | 不可 | - | PK（複合）、CHECK: length(column_key) BETWEEN 1 AND 48 AND substr(column_key,1,1) GLOB '[a-z]' AND column_key NOT GLOB '*[^a-z0-9_]*' |
| 3 | version_no | INTEGER | 列ごとの版の連番 | 不可 | - | PK（複合）、CHECK: version_no>0 |
| 4 | label | TEXT | 見出し | 不可 | - | CHECK: length(trim(label)) BETWEEN 1 AND 60 |
| 5 | legacy_position | INTEGER | 旧シート（83列）での列番号（1〜83） | 可 | - | CHECK: legacy_position IS NULL OR legacy_position BETWEEN 1 AND 83 |
| 6 | group_key | TEXT（列挙） | 列のまとまり（識別・日付・数量・外貨など） | 不可 | - | 値: identity / dates / quantity / unit_price / rate / partner_gross / holder_sales / currency / booking / mg_balance / theatre / note / audit / reference / helper / custom |
| 7 | value_type | TEXT（列挙） | 値の型（yen＝円、rate_pct＝率（%）、date＝日付など） | 不可 | - | 値: yen / integer / decimal / rate_pct / date / month / text / bool |
| 8 | aggregation | TEXT（列挙） | 集計の決まり（sum＝合計、ratio＝分子と分母で再計算など） | 不可 | - | 値: sum / period_end / ratio / min_max / distinct |
| 9 | numerator_key | TEXT | 比率を出すときの分子の列キー | 可 | - | - |
| 10 | denominator_key | TEXT | 比率を出すときの分母の列キー | 可 | - | - |
| 11 | ratio_scale | INTEGER（列挙） | 比率に掛ける数（1か、%で表す100） | 可 | - | 値: 1 / 100 |
| 12 | digits | INTEGER | 小数の桁数（0〜6） | 可 | - | CHECK: digits IS NULL OR digits BETWEEN 0 AND 6 |
| 13 | source_kind | TEXT（列挙） | 値の取り方（登録済みの表から・計算で作る・拡張属性） | 不可 | - | 値: core / derived / attribute |
| 14 | source_ref | TEXT | 値の取り方の許可リストのキー（SQL は持たない） | 可 | - | CHECK: source_ref IS NULL OR (length(source_ref) BETWEEN 1 AND 60 AND source_ref NOT GLOB '*[^a-z0-9_.]*') |
| 15 | formula_json | TEXT | 計算で作る列の式（JSON） | 可 | - | CHECK: formula_json IS NULL OR (length(formula_json) BETWEEN 2 AND 2000 AND json_valid(formula_json)) |
| 16 | description | TEXT | 列の説明 | 可 | - | CHECK: description IS NULL OR length(trim(description)) BETWEEN 1 AND 500 |
| 17 | sort_order | INTEGER | 並び順 | 不可 | - | CHECK: sort_order BETWEEN 0 AND 100000 |
| 18 | active | INTEGER（真偽 0/1） | 1＝使う、0＝使うのをやめた | 不可 | - | - |
| 19 | reason | TEXT | この版を登録した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 20 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 21 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, column_key, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- CHECK: (aggregation='ratio') = (numerator_key IS NOT NULL AND denominator_key IS NOT NULL AND ratio_scale IS NOT NULL)
- CHECK: aggregation<>'ratio' OR value_type IN ('decimal','rate_pct','yen','integer')
- CHECK: aggregation NOT IN ('sum','period_end') OR value_type IN ('yen','integer','decimal')
- CHECK: aggregation<>'min_max' OR value_type IN ('date','month','text','integer')
- CHECK: source_kind<>'core' OR (source_ref IS NOT NULL AND formula_json IS NULL)
- CHECK: source_kind<>'derived' OR (source_ref IS NULL) <> (formula_json IS NULL)
- CHECK: source_kind<>'attribute' OR (source_ref IS NULL AND formula_json IS NULL)
- トリガー sales_sheet_column_versions_no_delete: 削除の前
- トリガー sales_sheet_column_versions_no_update: 更新の前
- トリガー sales_sheet_column_versions_sequence: 追加の前

## sales_sheet_view_versions

**保存した形の中身（版）** — 保存した形ごとの列の並び・粒度・切り口・月と税の基準・絞り込みの版。保存し直すたびに積み、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | view_id | INTEGER | 保存した形（sales_sheet_views） | 不可 | - | PK（複合）、FK（複合）→ sales_sheet_views |
| 3 | version_no | INTEGER | 形ごとの版の連番 | 不可 | - | PK（複合）、CHECK: version_no>0 |
| 4 | column_keys_json | TEXT | 表示する列キーの並び（JSON） | 不可 | - | CHECK: json_valid(column_keys_json) AND json_type(column_keys_json)='array' AND json_array_length(column_keys_json) BETWEEN 1 AND 200 AND length(column_keys_json)<=12000 |
| 5 | grain | TEXT（列挙） | 粒度（detail＝明細、aggregate＝集計） | 不可 | - | 値: detail / aggregate |
| 6 | dimensions_json | TEXT | 集計の切り口（最大3つ。JSON） | 不可 | - | CHECK: json_valid(dimensions_json) AND json_type(dimensions_json)='array' AND json_array_length(dimensions_json)<=3 |
| 7 | month_basis | TEXT（列挙） | 月の基準（計上月・販売月・ロイヤリティ計上月） | 不可 | - | 値: accounting / sales / royalty |
| 8 | tax_basis | TEXT（列挙） | 税の基準（ex＝税抜、inc＝税込） | 不可 | - | 値: ex / inc |
| 9 | pivot_months | INTEGER（真偽 0/1） | 月を横に並べるか（1＝並べる） | 不可 | - | - |
| 10 | hide_empty | INTEGER（真偽 0/1） | 全行が空の列を隠すか（1＝隠す） | 不可 | - | - |
| 11 | filters_json | TEXT | 絞り込みの条件（JSON） | 不可 | - | CHECK: json_valid(filters_json) AND json_type(filters_json)='object' AND length(filters_json)<=4000 |
| 12 | active | INTEGER（真偽 0/1） | 1＝使う、0＝使うのをやめた | 不可 | - | - |
| 13 | reason | TEXT | この版を登録した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 14 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 15 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, view_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, view_id) → sales_sheet_views(org_id, id)
- CHECK: grain='aggregate' OR (json_array_length(dimensions_json)=0 AND pivot_months=0)
- トリガー sales_sheet_view_versions_no_delete: 削除の前
- トリガー sales_sheet_view_versions_no_update: 更新の前
- トリガー sales_sheet_view_versions_sequence: 追加の前

## sales_sheet_views

**売上集計シートの保存した形** — 売上集計シートの見せ方に名前をつけて保存したもの1件。名前は変えず（変えるときは新しく作る）、中身は sales_sheet_view_versions に版で持つ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | name | TEXT | 保存した形の名前（組織の中で重ねない） | 不可 | - | CHECK: length(trim(name)) BETWEEN 1 AND 60 |
| 4 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 5 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, name)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- トリガー sales_sheet_views_no_delete: 削除の前
- トリガー sales_sheet_views_no_update: 更新の前

## sales_source_bindings

**売上原本の割り当て（版）** — 原本の行をどの作品へ割り当てるかの決め方の版1つを表す。付け替えるたびに理由を付けて足し、登録を始めた後は足せず、最大の版番号が今の割り当て。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | file_id | INTEGER | 原本（sales_source_files） | 不可 | - | FK（複合）→ sales_source_files |
| 4 | version_no | INTEGER | 版番号（原本ごとに1から連番） | 不可 | - | CHECK: version_no>0 |
| 5 | mode | TEXT（列挙） | 決め方（1つの作品・商品コードの列・作品コードの列） | 不可 | - | 値: single_work / by_product / by_work_column |
| 6 | project_id | INTEGER | 案件（projects）。1つの作品のときだけ | 可 | - | FK（複合）→ works |
| 7 | work_id | INTEGER | 作品（works）。1つの作品のときだけ | 可 | - | FK（複合）→ works |
| 8 | product_column | TEXT | 商品コードの列の見出し | 可 | - | - |
| 9 | work_column | TEXT | 作品コードの列の見出し | 可 | - | - |
| 10 | reason | TEXT | 割り当て・付け替えの理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, file_id, id)
- 複合の一意: (org_id, file_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 複合の参照: (org_id, file_id) → sales_source_files(org_id, id)
- CHECK: (mode='single_work' AND project_id IS NOT NULL AND work_id IS NOT NULL AND product_column IS NULL AND work_column IS NULL) OR (mode='by_product' AND project_id IS NULL AND work_id IS NULL AND length(trim(product_column)) BETWEEN 1 AND 200 AND work_column IS NULL) OR (mode='by_work_column' AND project_id IS NULL AND work_id IS NULL AND length(trim(work_column)) BETWEEN 1 AND 200 AND (product_column IS NULL OR length(trim(product_column)) BETWEEN 1 AND 200))
- トリガー sales_source_bindings_before_commit: 追加の前
- トリガー sales_source_bindings_no_delete: 削除の前
- トリガー sales_source_bindings_no_update: 更新の前

## sales_source_commits

**売上原本の分割の登録** — 分割1つを売上報告1件として登録した記録を表す。1つの原本の登録はすべて同じ割り当て・取込範囲・分け方・取引先・報告の種類にそろえ、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | file_id | INTEGER | 原本（sales_source_files） | 不可 | - | FK（複合）→ sales_source_files |
| 4 | partition_id | INTEGER | 分割（sales_source_partitions） | 不可 | - | FK（複合）→ sales_source_partitions |
| 5 | binding_id | INTEGER | 割り当ての版（sales_source_bindings） | 不可 | - | - |
| 6 | selection_id | INTEGER | 取込範囲の版（sales_source_selections） | 不可 | - | - |
| 7 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ report_imports、FK（複合）→ sales_source_partitions |
| 8 | mapping_version_id | INTEGER | 使った列対応の版（report_mapping_versions） | 不可 | - | FK（複合）→ report_mapping_versions |
| 9 | report_id | INTEGER | 登録した売上報告（report_imports） | 不可 | - | FK（複合）→ report_imports |
| 10 | preview_token | TEXT | 登録前の確認の鍵（一意。二重登録を防ぐ） | 不可 | - | Unique |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, partition_id)
- 複合の一意: (org_id, report_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, mapping_version_id) → report_mapping_versions(org_id, id)
- 複合の参照: (org_id, work_id, report_id) → report_imports(org_id, work_id, id)
- 複合の参照: (org_id, work_id, partition_id) → sales_source_partitions(org_id, work_id, id)
- 複合の参照: (org_id, file_id) → sales_source_files(org_id, id)
- 索引 sales_source_commits_file_idx: (org_id, file_id)
- トリガー sales_source_commits_consistent: 追加の前
- トリガー sales_source_commits_no_delete: 削除の前
- トリガー sales_source_commits_no_update: 更新の前
- トリガー sales_source_commits_same_terms: 追加の前

## sales_source_file_terms

**売上原本の1通の条件（版）** — 受け取った原本1通の条件（取引先・報告の種類・対象期間・受領日・報告月・申告合計）の版1つを表す。原本ごとの連番で、最新の版がその時点の条件（状態の列は持たない）。置き場所を誤ったときは理由を書いて次の版を足し、分割の登録を始めた原本には足せない。変更・削除は DB が断る。分からない値は空（未検証）のまま持つ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | file_id | INTEGER | 原本（sales_source_files） | 不可 | - | FK（複合）→ sales_source_files |
| 4 | version_no | INTEGER | 版番号（原本ごとに1から連番） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | partner_id | INTEGER | 1通を送ってきた取引先（partners） | 不可 | - | FK（複合）→ partners |
| 6 | kind | TEXT（列挙） | 報告の種類（劇場・配信・パッケージ・放送・その他・宣伝。report_imports と同じ語） | 不可 | - | 値: theatrical / digital / package / broadcast / other / publicity |
| 7 | period_from | TEXT | 対象期間の始まり（YYYY-MM-DD）。分からなければ空（終わりと2つとも空） | 可 | - | CHECK: period_from IS NULL OR (length(period_from)=10 AND substr(period_from,5,1)='-' AND substr(period_from,8,1)='-' AND ltrim(substr(period_from,1,4)\|\|substr(period_from,6,2)\|\|substr(period_from,9,2),'0123456789')='' AND substr(period_from,6,2) BETWEEN '01' AND '12' AND substr(period_from,9,2) BETWEEN '01' AND '31') |
| 8 | period_to | TEXT | 対象期間の終わり（YYYY-MM-DD。始まり以後）。分からなければ空 | 可 | - | CHECK: period_to IS NULL OR (length(period_to)=10 AND substr(period_to,5,1)='-' AND substr(period_to,8,1)='-' AND ltrim(substr(period_to,1,4)\|\|substr(period_to,6,2)\|\|substr(period_to,9,2),'0123456789')='' AND substr(period_to,6,2) BETWEEN '01' AND '12' AND substr(period_to,9,2) BETWEEN '01' AND '31') |
| 9 | received_on | TEXT | 受領日（1通を受け取った日）。人が入れるまで空で、読み手は原本を取り込んだ日時で代え、代えたことを示す | 可 | - | CHECK: received_on IS NULL OR (length(received_on)=10 AND substr(received_on,5,1)='-' AND substr(received_on,8,1)='-' AND ltrim(substr(received_on,1,4)\|\|substr(received_on,6,2)\|\|substr(received_on,9,2),'0123456789')='' AND substr(received_on,6,2) BETWEEN '01' AND '12' AND substr(received_on,9,2) BETWEEN '01' AND '31') |
| 10 | report_month | TEXT | 報告書の上の報告月（YYYY-MM）。受領日から埋めない。原本の欄か人が入れた月だけ。無ければ空（未検証） | 可 | - | CHECK: report_month IS NULL OR (length(report_month)=7 AND substr(report_month,5,1)='-' AND ltrim(substr(report_month,1,4)\|\|substr(report_month,6,2),'0123456789')='' AND substr(report_month,6,2) BETWEEN '01' AND '12') |
| 11 | declared_row_count | INTEGER | 原本に書かれた件数（申告合計）。書かれていなければ空 | 可 | - | CHECK: declared_row_count IS NULL OR (typeof(declared_row_count)='integer' AND declared_row_count BETWEEN 0 AND 9007199254740991) |
| 12 | declared_amount_ex_tax | INTEGER | 原本に書かれた税抜の合計（円）。書かれていなければ空 | 可 | - | CHECK: declared_amount_ex_tax IS NULL OR (typeof(declared_amount_ex_tax)='integer' AND declared_amount_ex_tax BETWEEN -9007199254740991 AND 9007199254740991) |
| 13 | declared_tax_amount | INTEGER | 原本に書かれた税額の合計（円）。書かれていなければ空 | 可 | - | CHECK: declared_tax_amount IS NULL OR (typeof(declared_tax_amount)='integer' AND declared_tax_amount BETWEEN -9007199254740991 AND 9007199254740991) |
| 14 | declared_amount_inc_tax | INTEGER | 原本に書かれた税込の合計（円）。3つの額がそろえば 税込＝税抜＋税額 | 可 | - | CHECK: declared_amount_inc_tax IS NULL OR (typeof(declared_amount_inc_tax)='integer' AND declared_amount_inc_tax BETWEEN -9007199254740991 AND 9007199254740991) |
| 15 | reason | TEXT | この版を足した理由（置いたフォルダ・置き場所の直しなど） | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 16 | created_by | INTEGER | 版を足した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 17 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, file_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, file_id) → sales_source_files(org_id, id)
- CHECK: (period_from IS NULL AND period_to IS NULL) OR (period_from IS NOT NULL AND period_to IS NOT NULL AND period_to>=period_from)
- CHECK: declared_amount_ex_tax IS NULL OR declared_tax_amount IS NULL OR declared_amount_inc_tax IS NULL OR declared_amount_inc_tax=declared_amount_ex_tax+declared_tax_amount
- トリガー sales_source_file_terms_before_commit: 追加の前
- トリガー sales_source_file_terms_no_delete: 削除の前
- トリガー sales_source_file_terms_no_update: 更新の前
- トリガー sales_source_file_terms_sequence: 追加の前

## sales_source_files

**受領した売上原本** — 受け取った売上報告のファイル1つを、作品から切り離して表す。原本取り込みで保存し、同じ中身は組織で1回だけで、変更・削除できない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | storage | TEXT（列挙） | 中身の置き方（inline=保存、legacy_artifact=旧原本を参照） | 不可 | - | 値: inline / legacy_artifact |
| 4 | file_name | TEXT | ファイル名 | 不可 | - | CHECK: length(trim(file_name)) BETWEEN 1 AND 240 |
| 5 | media_type | TEXT | ファイルの種類（MIME） | 可 | - | - |
| 6 | byte_length | INTEGER | 大きさ（バイト） | 不可 | - | CHECK: byte_length>0 |
| 7 | raw_sha256 | TEXT | 原本の照合値（SHA-256。組織内で一意） | 不可 | - | CHECK: length(raw_sha256)=64 |
| 8 | original_base64 | TEXT | 原本の中身（base64。inline のときだけ） | 可 | - | - |
| 9 | extraction_json | TEXT | 読み取ったシートと表の中身（inline のときだけ） | 可 | - | - |
| 10 | extractor_name | TEXT | 読み取った部品の名前 | 不可 | - | - |
| 11 | extractor_version | TEXT | 読み取った部品の版 | 不可 | - | - |
| 12 | extraction_status | TEXT（列挙） | 読み取りの状態（抽出済み・文字認識待ち） | 不可 | - | 値: extracted / ocr_pending |
| 13 | legacy_artifact_id | INTEGER | 引き継いだ旧方式の原本（workflow_raw_artifacts） | 可 | - | FK（複合）→ workflow_raw_artifacts |
| 14 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 15 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, raw_sha256)
- 複合の一意: (org_id, legacy_artifact_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, legacy_artifact_id) → workflow_raw_artifacts(org_id, id)
- CHECK: (storage='inline' AND original_base64 IS NOT NULL AND extraction_json IS NOT NULL AND legacy_artifact_id IS NULL) OR (storage='legacy_artifact' AND original_base64 IS NULL AND extraction_json IS NULL AND legacy_artifact_id IS NOT NULL)
- トリガー sales_source_files_inline_not_legacy: 追加の前
- トリガー sales_source_files_legacy_takeover: 追加の前
- トリガー sales_source_files_no_delete: 削除の前
- トリガー sales_source_files_no_update: 更新の前

## sales_source_partitions

**売上原本の作品別の分割** — 1回の分け方で、原本から1つの作品へ分けた行の組を表す（分け方1回×作品ごとに1行）。分けた表そのものは保存せず、取込範囲の版と行番号から作り直す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | file_id | INTEGER | 原本（sales_source_files） | 不可 | - | FK（複合）→ sales_source_bindings、FK（複合）→ sales_source_selections |
| 4 | selection_id | INTEGER | 使った取込範囲の版（sales_source_selections） | 不可 | - | FK（複合）→ sales_source_selections |
| 5 | binding_id | INTEGER | 使った割り当ての版（sales_source_bindings） | 不可 | - | FK（複合）→ sales_source_bindings |
| 6 | plan_sha256 | TEXT | 分け方全体の照合値 | 不可 | - | CHECK: length(plan_sha256)=64 |
| 7 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 8 | work_id | INTEGER | 分けた先の作品（works） | 不可 | - | FK（複合）→ works |
| 9 | row_count | INTEGER | 分けた行数 | 不可 | - | CHECK: row_count>0 |
| 10 | source_rows_json | TEXT | この作品へ分けた元の行番号 | 不可 | - | - |
| 11 | product_map_json | TEXT | 商品コードと商品ID・そのときの配賦の写し | 不可 | [] | - |
| 12 | partition_sha256 | TEXT | 分けた表（CSV）の照合値 | 不可 | - | CHECK: length(partition_sha256)=64 |
| 13 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 14 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, work_id, id)
- 複合の一意: (org_id, file_id, id)
- 複合の一意: (org_id, binding_id, selection_id, plan_sha256, work_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 複合の参照: (org_id, file_id, binding_id) → sales_source_bindings(org_id, file_id, id)
- 複合の参照: (org_id, file_id, selection_id) → sales_source_selections(org_id, file_id, id)
- トリガー sales_source_partitions_consistent: 追加の前
- トリガー sales_source_partitions_no_delete: 削除の前
- トリガー sales_source_partitions_no_update: 更新の前

## sales_source_selections

**売上原本の取込範囲（版）** — 原本のどのシートの、どの行を見出しにし、どの行を取り込まないかの版1つを表す。登録を始める前だけ足せて変更・削除できず、最大の版番号が今の選択。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | file_id | INTEGER | 原本（sales_source_files） | 不可 | - | FK（複合）→ sales_source_files |
| 4 | version_no | INTEGER | 版番号（原本ごとに1から連番） | 不可 | - | CHECK: version_no>0 |
| 5 | sheet_name | TEXT | シート名 | 不可 | - | - |
| 6 | header_row | INTEGER | 見出しの行番号 | 不可 | - | CHECK: header_row>0 |
| 7 | canonical_csv | TEXT | 取り込む表を整えたCSV | 不可 | - | - |
| 8 | canonical_sha256 | TEXT | そのCSVの照合値 | 不可 | - | CHECK: length(canonical_sha256)=64 |
| 9 | source_rows_json | TEXT | CSVの各行の元の行番号 | 不可 | - | - |
| 10 | excluded_json | TEXT | 取り込まない行・理由・金額 | 不可 | [] | - |
| 11 | suggestions_json | TEXT | 列対応の候補（見出しから決めたもの） | 不可 | [] | - |
| 12 | suggestion_source | TEXT（列挙） | 候補の出どころ（規則・AI取込・AI） | 不可 | - | 値: rule-based / imported-ai / configured-ai |
| 13 | legacy_selection_id | INTEGER | 写した旧方式の選択（workflow_report_selections） | 可 | - | FK（複合）→ workflow_report_selections |
| 14 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 15 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, file_id, id)
- 複合の一意: (org_id, file_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, legacy_selection_id) → workflow_report_selections(org_id, id)
- 複合の参照: (org_id, file_id) → sales_source_files(org_id, id)
- トリガー sales_source_selections_before_commit: 追加の前
- トリガー sales_source_selections_legacy_match: 追加の前
- トリガー sales_source_selections_no_delete: 削除の前
- トリガー sales_source_selections_no_update: 更新の前

## source_check_runs

**検査の結果（回）** — 原本1通の検査の結果を回ごとに残す（追記だけ。変更・削除は DB が断る）。原本ごとの連番。再検査は新しい回を足すだけで、登録（sales_source_commits）は書き換えない。判定の語は5つ。合否の数と正解表の件数を、その回の値として持つ。判定の語と合否の数が食い違う行は DB では止めない（純関数の戻りを書くのは受け口）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | file_id | INTEGER | 原本（sales_source_files） | 不可 | - | FK（複合）→ sales_source_files |
| 4 | check_version_id | INTEGER | 使った検査の決まりの版（report_check_versions） | 不可 | - | FK（複合）→ report_check_versions |
| 5 | run_no | INTEGER | 原本ごとの回の連番（1から） | 不可 | - | CHECK: typeof(run_no)='integer' AND run_no>0 |
| 6 | checks_passed | INTEGER | 合った検査の数（0以上。checks_total 以下） | 不可 | - | CHECK: typeof(checks_passed)='integer' AND checks_passed BETWEEN 0 AND 9007199254740991 |
| 7 | checks_total | INTEGER | 検査の項目数（0以上） | 不可 | - | - |
| 8 | judgment | TEXT（列挙） | 判定の語（auto 自動で確定・human 人の確認・human_record 人の確認（実績が足りない）・shape 形が違う・unread 人が読む） | 不可 | - | 値: auto / human / human_record / shape / unread |
| 9 | golden_matched | INTEGER | 正解表のうち一致した件数 | 不可 | - | CHECK: typeof(golden_matched)='integer' AND golden_matched BETWEEN 0 AND 9007199254740991 |
| 10 | golden_total | INTEGER | 正解表の件数（0件は正答率100%にしない） | 不可 | - | CHECK: typeof(golden_total)='integer' AND golden_total BETWEEN 0 AND 9007199254740991 |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, file_id, run_no)
- 複合の参照: (org_id, check_version_id) → report_check_versions(org_id, id)
- 複合の参照: (org_id, file_id) → sales_source_files(org_id, id)
- CHECK: typeof(checks_total)='integer' AND checks_total BETWEEN 0 AND 9007199254740991 AND checks_passed<=checks_total
- トリガー source_check_runs_no_delete: 削除の前
- トリガー source_check_runs_no_update: 更新の前
- トリガー source_check_runs_sequence: 追加の前

## source_sampling_reviews

**抜き取りの記録** — 人が見た1通の抜き取りの記録（追記だけ。変更・削除は DB が断る）。結果は直し無し・型の誤り・原本の誤りの3つ。型の誤りを足しても、検査の決まりの新しい版は自動では作らない。実績の通数は数える列を持たず、検査の回とこの記録から読むたびに導く

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | check_run_id | INTEGER | 見た検査の回（source_check_runs） | 不可 | - | FK（複合）→ source_check_runs |
| 4 | result | TEXT（列挙） | 結果（clean 直し無し・type_error 型の誤り・source_error 原本の誤り） | 不可 | - | 値: clean / type_error / source_error |
| 5 | reason | TEXT | 記録の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 6 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, check_run_id) → source_check_runs(org_id, id)
- トリガー source_sampling_reviews_no_delete: 削除の前
- トリガー source_sampling_reviews_no_update: 更新の前

## tax_calculation_lines

**税計算の明細** — 1行は、税計算に使った元の売上明細1件と、その税区分・税率・参考の税額。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | snapshot_id | INTEGER | 税計算（tax_calculation_snapshots） | 不可 | - | PK（複合）、FK（複合）→ tax_calculation_snapshots |
| 3 | sale_id | INTEGER | 元の売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 4 | report_id | INTEGER | 元の売上報告（report_imports） | 不可 | - | FK（複合）→ report_imports |
| 5 | voucher_id | TEXT | 伝票の識別（元の売上報告の報告キー） | 不可 | - | - |
| 6 | category | TEXT（列挙） | 税区分（課税10%・軽減8%・免税・非課税・不課税） | 不可 | - | 値: standard / reduced / zero / exempt / non_taxable |
| 7 | rate_bps | INTEGER（列挙） | 税率（bps。1000＝10%） | 不可 | - | 値: 0 / 800 / 1000 |
| 8 | amount_ex_tax | INTEGER | 元の明細の税抜額（円） | 不可 | - | - |
| 9 | source_tax | INTEGER | 元の明細の税額（円） | 不可 | - | - |
| 10 | amount_inc_tax | INTEGER | 元の明細の税込額（円） | 不可 | - | - |
| 11 | exact_numerator | TEXT | 丸める前の税額を分数にしたときの分子 | 不可 | - | - |
| 12 | exact_denominator | TEXT | 丸める前の税額を分数にしたときの分母 | 不可 | - | - |
| 13 | reference_tax_scaled | INTEGER | 参考の税額を10の（桁数）乗倍した整数 | 不可 | - | - |
| 14 | reference_precision | INTEGER | 参考の税額の小数の桁数（0〜4） | 不可 | - | CHECK: reference_precision BETWEEN 0 AND 4 |

表の制約:

- 複合の主キー: (org_id, snapshot_id, sale_id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- 複合の参照: (org_id, snapshot_id) → tax_calculation_snapshots(org_id, id)
- CHECK: (category='standard' AND rate_bps=1000) OR (category='reduced' AND rate_bps=800) OR (category IN ('zero','exempt','non_taxable') AND rate_bps=0)
- トリガー tax_line_immutable: 更新の前
- トリガー tax_line_no_delete: 削除の前

## tax_calculation_snapshots

**請求の税計算** — 1行は、請求1件を確定したときの税計算の結果。元の売上明細の税額と、税率ごとに1回丸めた請求の税額を並べて残す。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | invoice_id | INTEGER | 請求（billing_invoices） | 可 | - | FK（複合）→ billing_invoices |
| 4 | preview_hash | TEXT | 確認の画面で見た入力と計算の SHA-256 | 不可 | - | - |
| 5 | rule_version_id | INTEGER | 使った税ルールの版（tax_rule_versions） | 不可 | - | FK（複合）→ tax_rule_versions |
| 6 | invoice_date | TEXT | 請求日 | 不可 | - | - |
| 7 | source_period_from | TEXT | 元の売上報告の期間の最初の日 | 不可 | - | - |
| 8 | source_period_to | TEXT | 元の売上報告の期間の最後の日 | 不可 | - | - |
| 9 | calculation_json | TEXT | 計算の内容（明細・参考の計算・税率別の合計。JSON） | 不可 | - | - |
| 10 | amount_ex_tax | INTEGER | 請求の税抜額（円） | 不可 | - | - |
| 11 | source_tax | INTEGER | 元の売上明細の税額の合計（円） | 不可 | - | - |
| 12 | billed_tax | INTEGER | 請求の税額（円） | 不可 | - | - |
| 13 | delta | INTEGER | 請求の税額−元の税額（円） | 不可 | - | - |
| 14 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 15 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, invoice_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, rule_version_id) → tax_rule_versions(org_id, id)
- 複合の参照: (org_id, invoice_id) → billing_invoices(org_id, id)
- CHECK: delta=billed_tax-source_tax
- CHECK: source_period_to>=source_period_from
- 索引 tax_snapshot_month_idx: (org_id, invoice_date, invoice_id)
- トリガー tax_snapshot_immutable: 更新の前
- トリガー tax_snapshot_no_delete: 削除の前

## tax_invoice_links

**請求の再発行のつながり** — 1行は、再発行した請求と、取り消した元の請求のつながり。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | invoice_id | INTEGER | 再発行した請求（billing_invoices） | 不可 | - | PK（複合）、FK（複合）→ billing_invoices |
| 3 | prior_invoice_id | INTEGER | 取り消した元の請求（billing_invoices） | 不可 | - | FK（複合）→ billing_invoices |
| 4 | reason | TEXT | 再発行の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 5 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, invoice_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, prior_invoice_id) → billing_invoices(org_id, id)
- 複合の参照: (org_id, invoice_id) → billing_invoices(org_id, id)
- CHECK: invoice_id<>prior_invoice_id
- トリガー tax_link_immutable: 更新の前
- トリガー tax_link_no_delete: 削除の前

## tax_invoice_rate_totals

**税計算の税率別合計** — 1行は、税計算の税区分×税率ごとの合計と、1回だけ丸めた請求の税額。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | snapshot_id | INTEGER | 税計算（tax_calculation_snapshots） | 不可 | - | PK（複合）、FK（複合）→ tax_calculation_snapshots |
| 3 | category | TEXT（列挙） | 税区分（課税10%・軽減8%・免税・非課税・不課税） | 不可 | - | PK（複合）、値: standard / reduced / zero / exempt / non_taxable |
| 4 | rate_bps | INTEGER（列挙） | 税率（bps。1000＝10%） | 不可 | - | PK（複合）、値: 0 / 800 / 1000 |
| 5 | amount_ex_tax | INTEGER | 税抜額（円）。税込起点では税込額−請求の税額 | 不可 | - | - |
| 6 | exact_numerator | TEXT | 丸める前の税額を分数にしたときの分子 | 不可 | - | - |
| 7 | exact_denominator | TEXT | 丸める前の税額を分数にしたときの分母 | 不可 | - | - |
| 8 | billed_tax | INTEGER | 請求の税額（円）。税率ごとに1回丸める | 不可 | - | - |
| 9 | source_tax | INTEGER | 元の明細の税額の合計（円） | 不可 | - | - |
| 10 | delta | INTEGER | 請求の税額−元の税額（円） | 不可 | - | - |

表の制約:

- 複合の主キー: (org_id, snapshot_id, category, rate_bps)
- 複合の参照: (org_id, snapshot_id) → tax_calculation_snapshots(org_id, id)
- CHECK: delta=billed_tax-source_tax
- トリガー tax_total_immutable: 更新の前
- トリガー tax_total_no_delete: 削除の前

## theatrical_sale_details

**劇場売上の詳細** — 劇場の売上報告の売上明細1行について、方式・券種・動員など報告にある値を表す。金額の正本は売上明細で、ここの額（小数も入る文字）は合算しない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 3 | model | TEXT（列挙） | 方式（劇場・非劇場×歩合・定額） | 不可 | - | 値: theatrical_rs / theatrical_flat / non_theatrical_rs / non_theatrical_flat |
| 4 | ticket_type_code | TEXT | 券種 | 可 | - | - |
| 5 | purchase_channel | TEXT | 購入経路 | 可 | - | - |
| 6 | admissions_count | INTEGER | 動員数 | 可 | - | CHECK: admissions_count IS NULL OR admissions_count>=0 |
| 7 | gross_box_office_ex_tax | TEXT | 興行収入（円・税抜。報告の値） | 可 | - | - |
| 8 | reported_actual_ex_tax | TEXT | 報告にある実績額（円・税抜。合算しない） | 可 | - | - |
| 9 | reported_recognized_ex_tax | TEXT | 報告にある計上額（円・税抜。合算しない） | 可 | - | - |
| 10 | calculated_actual_ex_tax | TEXT | 実績額の計算照合値（円・税抜。合算しない） | 可 | - | - |

表の制約:

- 複合の主キー: (org_id, sale_id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- トリガー theatrical_detail_immutable_delete: 削除の前
- トリガー theatrical_detail_immutable_update: 更新の前
- トリガー theatrical_detail_scope: 追加の前
- トリガー theatrical_detail_sealed: 追加の前

## workflow_report_commits

**報告の登録確定** — 売上報告の原本を売上明細へ登録した記録を1行で持つ。原本1つ・報告1つにつき1回だけ書き、変更も削除もできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ report_imports、FK（複合）→ workflow_report_selections、FK（複合）→ workflow_raw_artifacts |
| 4 | artifact_id | INTEGER | 売上報告の原本（workflow_raw_artifacts） | 不可 | - | FK（複合）→ workflow_raw_artifacts |
| 5 | selection_id | INTEGER | 使った取込範囲（workflow_report_selections） | 不可 | - | FK（複合）→ workflow_report_selections |
| 6 | mapping_version_id | INTEGER | 使った列対応の版（report_mapping_versions） | 不可 | - | FK（複合）→ report_mapping_versions |
| 7 | report_id | INTEGER | 登録した売上報告（report_imports） | 不可 | - | FK（複合）→ report_imports |
| 8 | preview_token | TEXT | 使った取込の確認（import_previews） | 不可 | - | Unique |
| 9 | committed_by | INTEGER | 登録した利用者（users） | 不可 | - | - |
| 10 | committed_at | TEXT | 登録した日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, artifact_id)
- 複合の一意: (org_id, report_id)
- 複合の参照: (org_id, work_id, report_id) → report_imports(org_id, work_id, id)
- 複合の参照: (org_id, mapping_version_id) → report_mapping_versions(org_id, id)
- 複合の参照: (org_id, work_id, selection_id) → workflow_report_selections(org_id, work_id, id)
- 複合の参照: (org_id, work_id, artifact_id) → workflow_raw_artifacts(org_id, work_id, id)
- トリガー workflow_report_commits_immutable: 更新の前
- トリガー workflow_report_commits_no_delete: 削除の前

## workflow_report_selections

**報告の取込範囲** — 売上報告の原本から、取り込むシートと見出し行を選んだ版を1行で持つ。選び直すたびに版を積み、変更も削除もできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | artifact_id | INTEGER | 売上報告の原本（workflow_raw_artifacts） | 不可 | - | FK（複合）→ workflow_raw_artifacts |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | - |
| 5 | version_no | INTEGER | 原本ごとの版の番号 | 不可 | - | - |
| 6 | sheet_name | TEXT | 選んだシート名 | 不可 | - | - |
| 7 | header_row | INTEGER | 見出しの行の番号（1から） | 不可 | - | CHECK: header_row>0 |
| 8 | canonical_csv | TEXT | 選んだ範囲を見出しつきの CSV にしたもの | 不可 | - | - |
| 9 | canonical_sha256 | TEXT | その CSV の照合値（SHA-256） | 不可 | - | - |
| 10 | source_rows_json | TEXT | CSV の各行が原本の何行目かの一覧（JSON） | 不可 | [] | - |
| 11 | suggestions_json | TEXT | 列の対応の候補（共通の列と原本の見出し）のJSON | 不可 | - | - |
| 12 | suggestion_source | TEXT（列挙） | 候補の出どころ。rule-based＝見出しの語から決まりで出した候補、imported-ai＝画面から持ち込んだAIの候補、configured-ai＝設定したAIが出した候補 | 不可 | - | 値: rule-based / imported-ai / configured-ai |
| 13 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | - |
| 14 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, work_id, id)
- 複合の一意: (org_id, artifact_id, version_no)
- 複合の参照: (org_id, artifact_id) → workflow_raw_artifacts(org_id, id)
- トリガー workflow_report_selections_immutable: 更新の前
- トリガー workflow_report_selections_no_delete: 削除の前

## yojitsu_activity_cancellations

**予実の活動記録の取消** — 活動記録の取消（追記だけ。1行に1回）。取り消せるのは記録した人だけで、取り消した行は数えない。表はデータ一覧・一括出力の対象外

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | activity_id | INTEGER | 取り消した活動記録（yojitsu_activity_records） | 不可 | - | PK（複合）、FK（複合）→ yojitsu_activity_records |
| 3 | cancelled_on | TEXT | 取り消した日（YYYY-MM-DD） | 不可 | - | CHECK: length(cancelled_on)=10 AND substr(cancelled_on,5,1)='-' AND substr(cancelled_on,8,1)='-' AND ltrim(substr(cancelled_on,1,4)\|\|substr(cancelled_on,6,2)\|\|substr(cancelled_on,9,2),'0123456789')='' AND substr(cancelled_on,6,2) BETWEEN '01' AND '12' AND substr(cancelled_on,9,2) BETWEEN '01' AND '31' |
| 4 | reason | TEXT | 理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 5 | created_by | INTEGER | 取り消した利用者（memberships。活動記録を記録した人） | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, activity_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, activity_id) → yojitsu_activity_records(org_id, id)
- トリガー yojitsu_activity_cancellations_no_delete: 削除の前
- トリガー yojitsu_activity_cancellations_no_update: 更新の前
- トリガー yojitsu_activity_cancellations_recorder_only: 追加の前

## yojitsu_activity_records

**予実の活動記録** — 案件の行動の記録（追記だけ。変更・削除は DB が断り、直しは取消の行 yojitsu_activity_cancellations を足す）。行の中身は記録した人の本人にだけ返し、ほかの人には件数だけを返す。ステップは行動のステップの参照表の段で、親の step（面談・提案・契約）へ畳んで数える。取り込んだ営業の活動は source_sales_activity_id で1回だけ。表はデータ一覧・一括出力の対象外

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects。必須） | 不可 | - | FK（複合）→ works、FK（複合）→ projects |
| 4 | occurred_on | TEXT | 日付（YYYY-MM-DD） | 不可 | - | CHECK: length(occurred_on)=10 AND substr(occurred_on,5,1)='-' AND substr(occurred_on,8,1)='-' AND ltrim(substr(occurred_on,1,4)\|\|substr(occurred_on,6,2)\|\|substr(occurred_on,9,2),'0123456789')='' AND substr(occurred_on,6,2) BETWEEN '01' AND '12' AND substr(occurred_on,9,2) BETWEEN '01' AND '31' |
| 5 | earning_type | TEXT | 稼ぎ方（earning_types。空なら案件の稼ぎ方で数える） | 可 | - | FK → earning_types.code |
| 6 | step | TEXT | ステップ（action_steps の段。空は数えない） | 可 | - | FK → action_steps.code |
| 7 | counterparty | TEXT | 相手 | 可 | - | CHECK: counterparty IS NULL OR length(trim(counterparty)) BETWEEN 1 AND 200 |
| 8 | summary | TEXT | したこと | 不可 | - | CHECK: length(trim(summary)) BETWEEN 1 AND 1000 |
| 9 | deliverable | TEXT | 成果物（携わった案件数の元） | 可 | - | CHECK: deliverable IS NULL OR length(trim(deliverable)) BETWEEN 1 AND 1000 |
| 10 | next_action | TEXT | 次の一手 | 可 | - | CHECK: next_action IS NULL OR length(trim(next_action)) BETWEEN 1 AND 1000 |
| 11 | next_due_on | TEXT | 次の一手の期日（YYYY-MM-DD） | 可 | - | CHECK: next_due_on IS NULL OR (length(next_due_on)=10 AND substr(next_due_on,5,1)='-' AND substr(next_due_on,8,1)='-' AND ltrim(substr(next_due_on,1,4)\|\|substr(next_due_on,6,2)\|\|substr(next_due_on,9,2),'0123456789')='' AND substr(next_due_on,6,2) BETWEEN '01' AND '12' AND substr(next_due_on,9,2) BETWEEN '01' AND '31') |
| 12 | result | TEXT（列挙） | 結果（advanced 進んだ・on_hold 保留・lost 失注） | 不可 | - | 値: advanced / on_hold / lost |
| 13 | work_id | INTEGER | 作品（works。案件の作品。作品の無い段は空） | 可 | - | FK（複合）→ works |
| 14 | source_sales_activity_id | INTEGER | 取り込んだ営業の活動（sales_activities。組織の中で1回だけ） | 可 | - | FK（複合）→ sales_activities |
| 15 | created_by | INTEGER | 記録した利用者（memberships。この人にだけ行の中身を返す） | 不可 | - | FK（複合）→ memberships |
| 16 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, source_sales_activity_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, source_sales_activity_id) → sales_activities(org_id, id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: next_due_on IS NULL OR next_action IS NOT NULL
- 索引 yojitsu_activity_records_project: (org_id, project_id, occurred_on)
- トリガー yojitsu_activity_records_no_delete: 削除の前
- トリガー yojitsu_activity_records_no_update: 更新の前
- トリガー yojitsu_activity_records_source_match: 追加の前

## yojitsu_choice_versions

**予実の語と月の設定（版）** — 値の列（bps・x100・months・yen）に入らない予実の設定の版（追記だけ。変更・削除は DB が断る）。組織×設定ごとの連番で、最新の version_no が有効。採用するシナリオ（予実の4段の着地予測・確度加重予測が読む）・月別の表に入れる案件の範囲・締めた月の3つ。数の設定は yojitsu_setting_versions

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | choice_key | TEXT（列挙） | 設定（adopted_scenario 採用するシナリオ・monthly_scope 月別の表に入れる案件の範囲・closed_month 締めた月） | 不可 | - | 値: adopted_scenario / monthly_scope / closed_month |
| 4 | version_no | INTEGER | 組織×設定ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | value_code | TEXT | 語の設定の値（採用するシナリオは even・good・max・single、月別の表の範囲は all 企画中も含む・landing 着地・contracted 契約済み）。締めた月は空 | 可 | - | - |
| 6 | value_month | TEXT | 締めた月（月初の日 YYYY-MM-01）。語の設定は空 | 可 | - | CHECK: value_month IS NULL OR (length(value_month)=10 AND substr(value_month,5,1)='-' AND substr(value_month,8,1)='-' AND ltrim(substr(value_month,1,4)\|\|substr(value_month,6,2),'0123456789')='' AND substr(value_month,6,2) BETWEEN '01' AND '12' AND substr(value_month,9,2)='01') |
| 7 | basis | TEXT | 根拠の文 | 可 | - | CHECK: basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000 |
| 8 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, choice_key, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- CHECK: (choice_key='adopted_scenario' AND value_code IS NOT NULL AND value_code IN ('even','good','max','single') AND value_month IS NULL) OR (choice_key='monthly_scope' AND value_code IS NOT NULL AND value_code IN ('all','landing','contracted') AND value_month IS NULL) OR (choice_key='closed_month' AND value_code IS NULL AND value_month IS NOT NULL)
- トリガー yojitsu_choice_versions_no_delete: 削除の前
- トリガー yojitsu_choice_versions_no_update: 更新の前
- トリガー yojitsu_choice_versions_sequence: 追加の前

## yojitsu_forecast_lines

**予実の予測の行** — 予測の版の行（追記だけ。変更・削除は DB が断る）。シナリオ（even・good・MAX・単一）×月（月初の日）×区分（区分マスタ）の金額。金額は税別の正の整数で、符号は区分の入出金で決める。予測に使う印は版の中の印で、有効な版の印が 1 の行だけを予測に使う

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | project_id | INTEGER | 案件（yojitsu_forecast_versions の案件） | 不可 | - | PK（複合）、FK（複合）→ yojitsu_forecast_versions |
| 3 | version_no | INTEGER | 版（yojitsu_forecast_versions） | 不可 | - | PK（複合）、FK（複合）→ yojitsu_forecast_versions |
| 4 | line_no | INTEGER | 版の中の行の番号（1〜版の line_count の連番。最後の番号の次だけ足せる） | 不可 | - | PK（複合）、CHECK: typeof(line_no)='integer' AND line_no>0 |
| 5 | scenario | TEXT（列挙） | シナリオ（even・good・max〈MAX〉・single〈単一〉。試算のケース） | 不可 | - | 値: even / good / max / single |
| 6 | forecast_month | TEXT | 月（月初の日。YYYY-MM-01） | 不可 | - | CHECK: length(forecast_month)=10 AND substr(forecast_month,5,1)='-' AND substr(forecast_month,8,1)='-' AND ltrim(substr(forecast_month,1,4)\|\|substr(forecast_month,6,2),'0123456789')='' AND substr(forecast_month,6,2) BETWEEN '01' AND '12' AND substr(forecast_month,9,2)='01' |
| 7 | category_id | INTEGER | 区分（cashflow_categories） | 不可 | - | FK（複合）→ cashflow_categories |
| 8 | item | TEXT | 項目 | 不可 | - | CHECK: length(trim(item)) BETWEEN 1 AND 200 |
| 9 | counterparty | TEXT | 相手 | 可 | - | CHECK: counterparty IS NULL OR length(trim(counterparty)) BETWEEN 1 AND 200 |
| 10 | amount_yen | INTEGER | 金額（円・税別。正の整数） | 不可 | - | CHECK: typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 9007199254740991 |
| 11 | status | TEXT（列挙） | 状態（confirmed 確認済み・director_reported 監督申告・press_reported 報道値・provisional 仮置き） | 不可 | - | 値: confirmed / director_reported / press_reported / provisional |
| 12 | use_for_forecast | INTEGER（真偽 0/1） | 予測に使う印（1 使う・0 使わない。前の版の行は印に関わらず使わない） | 不可 | - | - |

表の制約:

- 複合の主キー: (org_id, project_id, version_no, line_no)
- 複合の参照: (org_id, category_id) → cashflow_categories(org_id, id)
- 複合の参照: (org_id, project_id, version_no) → yojitsu_forecast_versions(org_id, project_id, version_no)
- トリガー yojitsu_forecast_lines_in_order: 追加の前
- トリガー yojitsu_forecast_lines_no_delete: 削除の前
- トリガー yojitsu_forecast_lines_no_update: 更新の前
- トリガー yojitsu_forecast_lines_within_count: 追加の前

## yojitsu_forecast_versions

**予実の予測（版）** — 案件×月の予測の版のヘッダ（追記だけ。変更・削除は DB が断る）。案件ごとの連番で、最新の version_no の版が有効（前の版の行は「予測に使う＝いいえ」と読む。行が line_count に満たない版は有効にしない）。版は案件の予測の全部の行を持ち、行は yojitsu_forecast_lines。試算の写しは元のファイルの SHA-256 を持ち、同じ写しを二度取り込まない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | version_no | INTEGER | 案件ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | label | TEXT | 版の名前（例: 試算の写し 2026-10-20） | 不可 | - | CHECK: length(trim(label)) BETWEEN 1 AND 100 |
| 6 | source_kind | TEXT（列挙） | 出所の種類（trial_import 試算の写し・manual 手入力・initiative 施策の既定の予測行） | 不可 | - | 値: trial_import / manual / initiative |
| 7 | source | TEXT | 出所の文 | 不可 | - | CHECK: length(trim(source)) BETWEEN 1 AND 1000 |
| 8 | source_sha256 | TEXT | 試算の写しの元のファイルの SHA-256（小文字の16進64桁。試算の写しだけ） | 可 | - | CHECK: source_sha256 IS NULL OR (length(source_sha256)=64 AND ltrim(source_sha256,'0123456789abcdef')='') |
| 9 | line_count | INTEGER | 行の数（1〜3824。1つの版が D1 の1回の batch に収まる数。行は版と同じ batch で行の番号の順に足す） | 不可 | - | CHECK: typeof(line_count)='integer' AND line_count BETWEEN 1 AND 3824 |
| 10 | created_on | TEXT | 作った日（YYYY-MM-DD） | 不可 | - | CHECK: length(created_on)=10 AND substr(created_on,5,1)='-' AND substr(created_on,8,1)='-' AND ltrim(substr(created_on,1,4)\|\|substr(created_on,6,2)\|\|substr(created_on,9,2),'0123456789')='' AND substr(created_on,6,2) BETWEEN '01' AND '12' AND substr(created_on,9,2) BETWEEN '01' AND '31' |
| 11 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: (source_kind='trial_import' AND source_sha256 IS NOT NULL) OR (source_kind<>'trial_import' AND source_sha256 IS NULL)
- トリガー yojitsu_forecast_versions_no_delete: 削除の前
- トリガー yojitsu_forecast_versions_no_update: 更新の前
- トリガー yojitsu_forecast_versions_sequence: 追加の前

## yojitsu_periods

**予実の期間** — 組織ごとの1〜5年目の期間（追記だけ。変更・削除は DB が断る）。各年目は月初の日に始まる12か月で、年目の順に足し、n年目は n−1年目のちょうど12か月後に始まる（DB のトリガーが断る）。通算（5年）は持たない。目標・計画の版がこの期間を指す

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | year_no | INTEGER | 年目（1〜5） | 不可 | - | CHECK: typeof(year_no)='integer' AND year_no BETWEEN 1 AND 5 |
| 4 | starts_on | TEXT | 始まりの月初の日（YYYY-MM-01） | 不可 | - | CHECK: length(starts_on)=10 AND substr(starts_on,5,1)='-' AND substr(starts_on,8,1)='-' AND ltrim(substr(starts_on,1,4)\|\|substr(starts_on,6,2),'0123456789')='' AND substr(starts_on,6,2) BETWEEN '01' AND '12' AND substr(starts_on,9,2)='01' |
| 5 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, year_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- トリガー yojitsu_periods_contiguous: 追加の前
- トリガー yojitsu_periods_no_delete: 削除の前
- トリガー yojitsu_periods_no_update: 更新の前
- トリガー yojitsu_periods_order: 追加の前

## yojitsu_plan_amounts

**予実の計画の稼ぎ方別の額** — 計画の版の子の行（追記だけ。変更・削除は DB が断る）。稼ぎ方ごとに1行で、行の数がヘッダの earning_type_count を超えたら断る。表はデータ一覧・一括出力・帳票の対象外

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | plan_version_id | INTEGER | 計画の版（yojitsu_plan_versions） | 不可 | - | PK（複合）、FK（複合）→ yojitsu_plan_versions |
| 3 | earning_type | TEXT | 稼ぎ方（earning_types） | 不可 | - | PK（複合）、FK → earning_types.code |
| 4 | amount_yen | INTEGER | 計画の額（税別・年の額） | 不可 | - | CHECK: typeof(amount_yen)='integer' AND amount_yen BETWEEN 0 AND 9007199254740991 |

表の制約:

- 複合の主キー: (org_id, plan_version_id, earning_type)
- 複合の参照: (org_id, plan_version_id) → yojitsu_plan_versions(org_id, id)
- トリガー yojitsu_plan_amounts_count: 追加の前
- トリガー yojitsu_plan_amounts_no_delete: 削除の前
- トリガー yojitsu_plan_amounts_no_update: 更新の前

## yojitsu_plan_versions

**予実の計画（版）** — 計画の版のヘッダ（追記だけ。変更・削除は DB が断る）。期間ごとの連番。稼ぎ方別の額は yojitsu_plan_amounts に持ち、earning_type_count はその行の数。有効な計画は列に持たず、期間ごとの最新の採用の記録（plan_adoptions）が指す版。第1版の額は目標（会社）の仮置きで owner 本人にだけ返す。表はデータ一覧・一括出力・帳票の対象外

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | period_id | INTEGER | 期間（yojitsu_periods） | 不可 | - | FK（複合）→ yojitsu_periods |
| 4 | version_no | INTEGER | 期間ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | owner_user_id | INTEGER | 額を読める本人（memberships） | 不可 | - | FK（複合）→ memberships |
| 6 | earning_type_count | INTEGER | 稼ぎ方別の額の行の数（1〜20） | 不可 | - | CHECK: typeof(earning_type_count)='integer' AND earning_type_count BETWEEN 1 AND 20 |
| 7 | status | TEXT（列挙） | 状態（confirmed 確認済み・provisional 仮置き） | 不可 | - | 値: confirmed / provisional |
| 8 | basis | TEXT | 根拠の文 | 可 | - | CHECK: basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000 |
| 9 | created_on | TEXT | 作った日（YYYY-MM-DD） | 不可 | - | CHECK: length(created_on)=10 AND substr(created_on,5,1)='-' AND substr(created_on,8,1)='-' AND ltrim(substr(created_on,1,4)\|\|substr(created_on,6,2)\|\|substr(created_on,9,2),'0123456789')='' AND substr(created_on,6,2) BETWEEN '01' AND '12' AND substr(created_on,9,2) BETWEEN '01' AND '31' |
| 10 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, period_id, id)
- 複合の一意: (org_id, period_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, owner_user_id) → memberships(org_id, user_id)
- 複合の参照: (org_id, period_id) → yojitsu_periods(org_id, id)
- トリガー yojitsu_plan_versions_no_delete: 削除の前
- トリガー yojitsu_plan_versions_no_update: 更新の前
- トリガー yojitsu_plan_versions_sequence: 追加の前

## yojitsu_setting_versions

**予実の設定（版）** — 行動の率と1件あたりの額などの設定の行（追記だけ。変更・削除は DB が断る）。変数×範囲ごとの連番の最新の version_no が有効。範囲で使う列だけが埋まり、値の列は bps・x100・months・yen のうちちょうど1つで、変数の値の種類と同じ。前提の数字なので状態を必ず持つ。移行では値の行を入れず、種か設定で足す

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | variable_key | TEXT | 変数（yojitsu_variables） | 不可 | - | FK → yojitsu_variables.code |
| 4 | scope | TEXT（列挙） | 範囲（all・earning_type・earning_type_step・project・channel） | 不可 | - | 値: all / earning_type / earning_type_step / project / channel |
| 5 | earning_type | TEXT | 稼ぎ方（earning_types。範囲が稼ぎ方・稼ぎ方×ステップのとき） | 可 | - | FK → earning_types.code |
| 6 | step | TEXT | ステップ（action_steps。範囲が稼ぎ方×ステップのとき。率はその段から次の段へ） | 可 | - | FK → action_steps.code |
| 7 | project_id | INTEGER | 案件（projects。範囲が案件のとき） | 可 | - | FK（複合）→ projects |
| 8 | channel_code | TEXT | 窓口のコード（範囲が窓口のとき。参照先は未決） | 可 | - | CHECK: channel_code IS NULL OR (length(channel_code) BETWEEN 1 AND 60 AND length(trim(channel_code))=length(channel_code)) |
| 9 | version_no | INTEGER | 変数×範囲ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 10 | value_bps | INTEGER | 値（bp） | 可 | - | CHECK: value_bps IS NULL OR (typeof(value_bps)='integer' AND value_bps BETWEEN 0 AND 10000) |
| 11 | value_x100 | INTEGER | 値（100倍の整数） | 可 | - | CHECK: value_x100 IS NULL OR (typeof(value_x100)='integer' AND value_x100 BETWEEN 0 AND 9007199254740991) |
| 12 | value_months | INTEGER | 値（月数。0〜120） | 可 | - | CHECK: value_months IS NULL OR (typeof(value_months)='integer' AND value_months BETWEEN 0 AND 120) |
| 13 | value_yen | INTEGER | 値（円・税別） | 可 | - | CHECK: value_yen IS NULL OR (typeof(value_yen)='integer' AND value_yen BETWEEN 0 AND 9007199254740991) |
| 14 | status | TEXT（列挙） | 状態（confirmed 確認済み・director_reported 監督申告・press_reported 報道値・provisional 仮置き） | 不可 | - | 値: confirmed / director_reported / press_reported / provisional |
| 15 | basis | TEXT | 根拠・1件あたりの中身の文 | 可 | - | CHECK: basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000 |
| 16 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 17 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: (scope='all' AND earning_type IS NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NULL) OR (scope='earning_type' AND earning_type IS NOT NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NULL) OR (scope='earning_type_step' AND earning_type IS NOT NULL AND step IS NOT NULL AND project_id IS NULL AND channel_code IS NULL) OR (scope='project' AND earning_type IS NULL AND step IS NULL AND project_id IS NOT NULL AND channel_code IS NULL) OR (scope='channel' AND earning_type IS NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NOT NULL)
- CHECK: (value_bps IS NOT NULL AND value_x100 IS NULL AND value_months IS NULL AND value_yen IS NULL) OR (value_bps IS NULL AND value_x100 IS NOT NULL AND value_months IS NULL AND value_yen IS NULL) OR (value_bps IS NULL AND value_x100 IS NULL AND value_months IS NOT NULL AND value_yen IS NULL) OR (value_bps IS NULL AND value_x100 IS NULL AND value_months IS NULL AND value_yen IS NOT NULL)
- 索引 yojitsu_setting_versions_slot: (org_id, variable_key, scope, （式）, （式）, （式）, （式）, version_no) 一意
- トリガー yojitsu_setting_versions_no_delete: 削除の前
- トリガー yojitsu_setting_versions_no_update: 更新の前
- トリガー yojitsu_setting_versions_sequence: 追加の前
- トリガー yojitsu_setting_versions_step_scope: 追加の前
- トリガー yojitsu_setting_versions_value_kind: 追加の前

## yojitsu_target_versions

**予実の目標（版）** — 年の目標の版（追記だけ。変更・削除は DB が断る）。期間×種類（本人・会社）×範囲（全体・制作の取り分）ごとの連番の最新の version_no が有効。根拠が額なら額を持ち、人件費×倍率なら額を持たず倍率を持つ（報酬の行の12か月の合計×倍率を読むたびに計算する。報酬の表が無い間は未接続）。額は owner 本人にだけ返し、表はデータ一覧・一括出力・帳票の対象外（代表の報酬が割り戻せる）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | period_id | INTEGER | 期間（yojitsu_periods） | 不可 | - | FK（複合）→ yojitsu_periods |
| 4 | target_kind | TEXT（列挙） | 種類（self 本人・company 会社） | 不可 | - | 値: self / company |
| 5 | target_scope | TEXT（列挙） | 範囲（all 全体・production_share 制作の取り分） | 不可 | - | 値: all / production_share |
| 6 | version_no | INTEGER | 期間×種類×範囲ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 7 | basis_kind | TEXT（列挙） | 根拠の種類（amount 額・labor_cost_multiple 人件費×倍率） | 不可 | - | 値: amount / labor_cost_multiple |
| 8 | amount_yen | INTEGER | 目標の額（税別。根拠が人件費×倍率なら NULL） | 可 | - | CHECK: amount_yen IS NULL OR (typeof(amount_yen)='integer' AND amount_yen BETWEEN 0 AND 9007199254740991) |
| 9 | multiplier_x100 | INTEGER | 倍率（100倍の整数。根拠が人件費×倍率のときだけ。既定は本人 300・会社 200） | 可 | - | CHECK: multiplier_x100 IS NULL OR (typeof(multiplier_x100)='integer' AND multiplier_x100 BETWEEN 1 AND 10000) |
| 10 | source1_yen | INTEGER | 源泉1（制作受託）の目標（税別。NULL 可） | 可 | - | CHECK: source1_yen IS NULL OR (typeof(source1_yen)='integer' AND source1_yen BETWEEN 0 AND 9007199254740991) |
| 11 | source2_yen | INTEGER | 源泉2（自社出資）の目標（税別。NULL 可） | 可 | - | CHECK: source2_yen IS NULL OR (typeof(source2_yen)='integer' AND source2_yen BETWEEN 0 AND 9007199254740991) |
| 12 | source3_yen | INTEGER | 源泉3（製作委員会）の目標（税別。NULL 可） | 可 | - | CHECK: source3_yen IS NULL OR (typeof(source3_yen)='integer' AND source3_yen BETWEEN 0 AND 9007199254740991) |
| 13 | source4_yen | INTEGER | 源泉4（買付）の目標（税別。NULL 可） | 可 | - | CHECK: source4_yen IS NULL OR (typeof(source4_yen)='integer' AND source4_yen BETWEEN 0 AND 9007199254740991) |
| 14 | source5_yen | INTEGER | 源泉5（販売委託）の目標（税別。NULL 可） | 可 | - | CHECK: source5_yen IS NULL OR (typeof(source5_yen)='integer' AND source5_yen BETWEEN 0 AND 9007199254740991) |
| 15 | unit | TEXT（列挙） | 単位（period_total 期間の合計・monthly 毎月） | 不可 | - | 値: period_total / monthly |
| 16 | basis | TEXT | 根拠の文 | 可 | - | CHECK: basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000 |
| 17 | status | TEXT（列挙） | 状態（confirmed 確認済み・provisional 仮置き） | 不可 | - | 値: confirmed / provisional |
| 18 | decided_on | TEXT | 決めた日（YYYY-MM-DD） | 不可 | - | CHECK: length(decided_on)=10 AND substr(decided_on,5,1)='-' AND substr(decided_on,8,1)='-' AND ltrim(substr(decided_on,1,4)\|\|substr(decided_on,6,2)\|\|substr(decided_on,9,2),'0123456789')='' AND substr(decided_on,6,2) BETWEEN '01' AND '12' AND substr(decided_on,9,2) BETWEEN '01' AND '31' |
| 19 | decided_by | TEXT | 決めた人の名前（owner とは別） | 可 | - | CHECK: decided_by IS NULL OR length(trim(decided_by)) BETWEEN 1 AND 200 |
| 20 | owner_user_id | INTEGER | 額を読める本人（memberships） | 不可 | - | FK（複合）→ memberships |
| 21 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 22 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, period_id, target_kind, target_scope, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, owner_user_id) → memberships(org_id, user_id)
- 複合の参照: (org_id, period_id) → yojitsu_periods(org_id, id)
- CHECK: (basis_kind='amount' AND amount_yen IS NOT NULL AND multiplier_x100 IS NULL) OR (basis_kind='labor_cost_multiple' AND amount_yen IS NULL AND multiplier_x100 IS NOT NULL AND target_scope='all' AND unit='period_total')
- CHECK: target_scope='all' OR (source1_yen IS NULL AND source2_yen IS NULL AND source3_yen IS NULL AND source4_yen IS NULL AND source5_yen IS NULL)
- トリガー yojitsu_target_versions_no_delete: 削除の前
- トリガー yojitsu_target_versions_no_update: 更新の前
- トリガー yojitsu_target_versions_sequence: 追加の前

## yojitsu_variables

**予実の設定の変数** — 設定の行の変数の参照表（組織に依らない）。値の列の種類とステップごとに持つかを決める。移行 0014 で行動の率（次の段へ進む率）・1件あたりの額・着地に数える確度・窓口の支払いの間の4行を、移行 0017 で行動指標の変数（窓口の売上の倍率・1件の時間・通る確率・通過率を測る期間など18行。行動指標の計画 段B #9）を入れる。稼ぎ方の既定の売上率は持たない（earning_type_rate_versions だけが持つ）。値の種類とステップの要否は変えられない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | code | TEXT | 変数のコード | 可 | - | PK、CHECK: length(code) BETWEEN 1 AND 60 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz0123456789_')='' |
| 2 | label | TEXT | 表示の名前 | 不可 | - | Unique、CHECK: length(trim(label)) BETWEEN 1 AND 60 |
| 3 | value_kind | TEXT（列挙） | 値の列の種類（bps・x100・months・yen） | 不可 | - | 値: bps / x100 / months / yen |
| 4 | per_step | INTEGER（真偽 0/1） | ステップごとに持つか（1＝範囲は稼ぎ方×ステップだけ） | 不可 | - | - |
| 5 | sort_order | INTEGER | 並び順 | 不可 | - | Unique、CHECK: sort_order>=0 |

表の制約:

- トリガー yojitsu_variables_fixed: 更新（value_kind,per_step）の前
