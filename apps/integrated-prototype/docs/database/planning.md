<!-- 生成物。直さない。正本は DB の定義（src/**/*.sql）と docs/database/dictionary.json。作り直しは node scripts/build-db-docs.mjs -->
# 企画（planning）の表

[目次へ戻る](README.md)

## ER 図

```mermaid
erDiagram
  acq_mg_contracts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER partner_id FK "権利元（partners）"
    INTEGER intake_case_id FK "調達案件（rights_intake_cases）。受け方「買付」を足すまでは空を許す"
    INTEGER legacy_settlement_contract_id FK "移した元の配給委託の MG 型の契約（settlement_contracts）"
    INTEGER legacy_outgoing_contract_id FK "移した元の支払 MG の契約（mg_outgoing_contracts）"
  }
  acq_mg_documents {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "契約（acq_mg_contracts）"
    INTEGER term_version_id FK "条件版（acq_mg_term_versions）"
    INTEGER source_document_id FK "原本（source_documents）"
  }
  acq_mg_payment_schedule {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "条件版（acq_mg_term_versions）"
    INTEGER installment PK "支払の回"
  }
  acq_mg_payments {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "契約（acq_mg_contracts）"
    INTEGER term_version_id FK "条件版（acq_mg_term_versions）"
    INTEGER statement_id FK "分配報告書（acq_mg_statements。分配額の支払）"
    INTEGER partner_id FK "権利元（partners）"
    INTEGER reverses_payment_id FK "取り消した元の支払"
  }
  acq_mg_report_links {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER report_id FK "売上報告（report_imports）"
    INTEGER work_id FK "作品（works）"
    INTEGER term_version_id FK "条件版（acq_mg_term_versions）"
    INTEGER replaces_link_id FK "直した元の結び付け"
  }
  acq_mg_statements {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id FK "条件版（acq_mg_term_versions）"
    INTEGER voids_statement_id FK "取り消した報告書"
  }
  acq_mg_term_deductions {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "条件版（acq_mg_term_versions）"
    TEXT category PK "費目"
  }
  acq_mg_term_media_allocations {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "条件版（acq_mg_term_versions）"
    TEXT media PK "媒体（flat・mg・rs・rss・vod）"
  }
  acq_mg_term_phases {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "条件版（acq_mg_term_versions）"
    INTEGER phase_order PK "区間の順番"
  }
  acq_mg_term_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "契約（acq_mg_contracts）"
  }
  acq_mg_term_works {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "条件版（acq_mg_term_versions）"
    INTEGER work_id PK, FK "作品（works）"
  }
  action_steps {
    TEXT code PK "ステップのコード（meeting・proposal・contract と、種で足す細目）"
    TEXT parent_code FK "畳む先のステップ（action_steps。親の無い行は NULL）"
  }
  budget_check_runs {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（版と同じ）"
    INTEGER version_id FK "版（budget_versions）"
  }
  budget_fixes {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER version_id FK "確定した版・取り消した版"
  }
  budget_line_items {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（版と同じ）"
    INTEGER version_id FK "予算書の版（budget_versions）"
    TEXT category_code FK "行の区分（A〜K）"
    INTEGER line_no FK "行の区分の中の行番号"
  }
  budget_template_items {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER template_version_id FK "型の版（budget_template_versions）"
  }
  budget_template_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER template_id FK "型（budget_templates）"
    INTEGER source_project_id FK "もとにした案件（budget のときだけ）"
    INTEGER source_budget_version_id FK "もとにした予算書の版（budget のときだけ）"
  }
  budget_templates {
    INTEGER id PK "行のID"
  }
  budget_version_lines {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（版と同じ）"
    INTEGER version_id FK "版（budget_versions）"
    INTEGER work_id FK "作品（任意。案件の作品だけ）"
  }
  budget_version_templates {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（版と同じ）"
    INTEGER version_id PK, FK "予算書の版（budget_versions）"
    INTEGER template_version_id FK "もとにした型の版（budget_template_versions）"
  }
  budget_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER previous_version_id FK "もとにした前の版（copy は必須）"
  }
  cashflow_categories {
    INTEGER id PK "行のID"
  }
  chotatsu_agreements {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER estimate_id FK "合意した試算の版"
    INTEGER source_document_id FK "合意の原本（source_documents）"
  }
  chotatsu_case_expenses {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER expense_id FK "経費の明細の行（expenses）"
    INTEGER estimate_line_id FK "対応する試算の見積の行"
  }
  chotatsu_case_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER holder_partner_id FK "権利元（partners）"
    INTEGER distributor_partner_id FK "劇場の配給会社（partners）"
    INTEGER work_id FK "作品（契約までは空でよい）"
    INTEGER sales_activity_id FK "起点の営業の活動記録（sales_activities）"
  }
  chotatsu_cases {
    INTEGER id PK "行のID"
  }
  chotatsu_contracts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER intake_case_id FK "作った調達案件（rights_intake_cases）"
    INTEGER work_id FK "作品"
    INTEGER settlement_contract_id FK "作った配給委託の契約（settlement_contracts）"
    INTEGER signed_document_id FK "締結版の契約書の原本（source_documents）"
  }
  chotatsu_documents {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER source_document_id FK "原本（source_documents）"
  }
  chotatsu_estimate_lines {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER estimate_id FK "試算の版"
    INTEGER source_document_id FK "見積の原本（source_documents）"
  }
  chotatsu_estimates {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
  }
  chotatsu_handoff_events {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER handoff_id FK "引き渡しの行"
  }
  chotatsu_handoffs {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER work_id FK "作品"
    INTEGER intake_case_id FK "調達案件（rights_intake_cases）"
    INTEGER estimate_id FK "引き渡す試算の版（仕様案と予定枚数）"
  }
  chotatsu_materials {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER source_document_id FK "素材の原本（source_documents）"
  }
  chotatsu_ringi {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
    INTEGER estimate_id FK "稟議にかけた試算の版"
    INTEGER source_document_id FK "稟議書の原本（source_documents）"
  }
  chotatsu_stage_events {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER case_id FK "調達の案件"
  }
  contract_production_milestones {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER project_id PK, FK "案件（projects）"
    INTEGER version_no PK, FK "契約の版（contract_production_versions）"
    INTEGER seq PK "版の中の連番（1から。月の順）"
  }
  contract_production_versions {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER project_id PK, FK "案件（projects。型は受託制作だけ）"
    INTEGER version_no PK "案件ごとの版の連番（1から）"
  }
  earning_type_rate_versions {
    INTEGER org_id PK "組織（organizations）。データの持ち主"
    TEXT earning_type PK, FK "稼ぎ方（earning_types）"
    INTEGER version_no PK "組織×稼ぎ方ごとの版の連番"
  }
  earning_types {
    TEXT code PK "稼ぎ方のコード（acquisition・consignment・own_investment・committee・contract_work）"
  }
  investment_approval_versions {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER project_id PK, FK "案件（projects。稼ぎ方は自社出資だけ）"
    INTEGER approval_no PK "案件ごとの稟議の番号（1から）"
    INTEGER version_no PK "稟議ごとの版の連番（1から。版1は申請）"
  }
  mg_outgoing_contracts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER supplier_id FK "仕入先・権利元（mg_suppliers）"
  }
  mg_suppliers {
    INTEGER id PK "行のID"
  }
  planning_documents {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER document_id FK "共通の原本（source_documents）"
  }
  planning_facts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER material_id FK "素材（planning_materials）"
    INTEGER previous_id FK "確定のときに指す下書きの行"
  }
  planning_materials {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER document_id FK "共通の原本（source_documents）"
  }
  planning_profile_people {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER version_id FK "企画の項目の版（planning_profile_versions）"
  }
  planning_profile_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
  }
  planning_trial_investments {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER version_id FK "試算の版"
  }
  planning_trial_lines {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER version_id FK "試算の版"
  }
  planning_trial_rates {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER version_id FK "試算の版"
  }
  planning_trial_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER document_id FK "読んだ原本（source_documents）"
  }
  produce_task_checks {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
  }
  produce_task_events {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
  }
  produce_task_links {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
  }
  produce_task_posts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
  }
  produce_task_template_items {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER template_id FK "テンプレートの版（produce_task_templates）"
  }
  produce_task_templates {
    INTEGER id PK "行のID"
  }
  produce_tasks {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "作品（任意。案件の作品だけ）"
  }
  project_owner_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
  }
  project_stage_events {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    TEXT stage_code FK "入った段階（project_stages）"
    TEXT previous_stage_code FK "前の段階（project_stages。最初の行は NULL）"
  }
  project_stage_meanings {
    TEXT stage_code PK, FK "段階（project_stages）"
    TEXT earning_type PK, FK "稼ぎ方（earning_types）"
  }
  project_stages {
    TEXT code PK "段階のコード"
    TEXT step_code FK "対応する行動のステップ（action_steps。面談済み・提案済み・契約済みだけ）"
  }
  projects {
    INTEGER id PK "行のID"
    TEXT earning_type FK "稼ぎ方（earning_types）。型と対応表の組だけを許す。現場受託・受託開発の型は持たない"
  }
  rights_intake_cases {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "作品（works）"
    INTEGER source_case_id FK "改訂元のケース（rights_intake_cases）"
  }
  rights_intake_documents {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER intake_case_id FK "調達ケース（rights_intake_cases）"
  }
  rights_intake_participants {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER intake_case_id FK "調達ケース（rights_intake_cases）"
    INTEGER partner_id FK "取引先（partners）。自社なら空"
  }
  rights_intake_scopes {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER intake_case_id FK "調達ケース（rights_intake_cases）"
  }
  works {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
  }
  acq_mg_contracts }o--o| mg_outgoing_contracts : "legacy_outgoing_contract_id"
  acq_mg_contracts }o--o| settlement_contracts : "legacy_settlement_contract_id"
  acq_mg_contracts }o--o| rights_intake_cases : "intake_case_id"
  acq_mg_contracts }o--|| partners : "partner_id"
  acq_mg_documents }o--|| source_documents : "source_document_id"
  acq_mg_documents }o--o| acq_mg_term_versions : "term_version_id"
  acq_mg_documents }o--|| acq_mg_contracts : "contract_id"
  acq_mg_payment_schedule }o--|| acq_mg_term_versions : "term_version_id"
  acq_mg_payments }o--o| acq_mg_payments : "reverses_payment_id"
  acq_mg_payments }o--|| partners : "partner_id"
  acq_mg_payments }o--o| acq_mg_statements : "statement_id"
  acq_mg_payments }o--|| acq_mg_term_versions : "term_version_id"
  acq_mg_payments }o--|| acq_mg_contracts : "contract_id"
  acq_mg_report_links }o--o| acq_mg_report_links : "replaces_link_id"
  acq_mg_report_links }o--|| acq_mg_term_versions : "term_version_id"
  acq_mg_report_links }o--|| works : "work_id"
  acq_mg_report_links }o--|| report_imports : "report_id"
  acq_mg_statements }o--o| acq_mg_statements : "voids_statement_id"
  acq_mg_statements }o--|| acq_mg_term_versions : "term_version_id"
  acq_mg_term_deductions }o--|| acq_mg_term_versions : "term_version_id"
  acq_mg_term_media_allocations }o--|| acq_mg_term_versions : "term_version_id"
  acq_mg_term_phases }o--|| acq_mg_term_versions : "term_version_id"
  acq_mg_term_versions }o--|| acq_mg_contracts : "contract_id"
  acq_mg_term_works }o--|| works : "work_id"
  acq_mg_term_works }o--|| acq_mg_term_versions : "term_version_id"
  action_steps }o--o| action_steps : "parent_code"
  budget_check_runs }o--|| budget_versions : "project_id,version_id"
  budget_fixes }o--|| budget_versions : "project_id,version_id"
  budget_line_items }o--|| budget_version_lines : "version_id,category_code,line_no"
  budget_line_items }o--|| budget_versions : "project_id,version_id"
  budget_template_items }o--|| budget_template_versions : "template_version_id"
  budget_template_versions }o--o| budget_versions : "source_project_id,source_budget_version_id"
  budget_template_versions }o--|| budget_templates : "template_id"
  budget_version_lines }o--o| works : "project_id,work_id"
  budget_version_lines }o--|| budget_versions : "project_id,version_id"
  budget_version_templates }o--|| budget_template_versions : "template_version_id"
  budget_version_templates }o--|| budget_versions : "project_id,version_id"
  budget_versions }o--o| budget_versions : "project_id,previous_version_id"
  budget_versions }o--|| projects : "project_id"
  chotatsu_agreements }o--o| source_documents : "source_document_id"
  chotatsu_agreements }o--|| chotatsu_estimates : "case_id,estimate_id"
  chotatsu_case_expenses }o--o| chotatsu_estimate_lines : "estimate_line_id"
  chotatsu_case_expenses }o--|| expenses : "expense_id"
  chotatsu_case_expenses }o--|| chotatsu_cases : "case_id"
  chotatsu_case_versions }o--o| sales_activities : "sales_activity_id"
  chotatsu_case_versions }o--o| works : "work_id"
  chotatsu_case_versions }o--o| partners : "distributor_partner_id"
  chotatsu_case_versions }o--o| partners : "holder_partner_id"
  chotatsu_case_versions }o--|| chotatsu_cases : "case_id"
  chotatsu_contracts }o--o| source_documents : "signed_document_id"
  chotatsu_contracts }o--|| settlement_contracts : "settlement_contract_id,work_id"
  chotatsu_contracts }o--|| rights_intake_cases : "intake_case_id,work_id"
  chotatsu_contracts }o--|| chotatsu_cases : "case_id"
  chotatsu_documents }o--|| source_documents : "source_document_id"
  chotatsu_documents }o--|| chotatsu_cases : "case_id"
  chotatsu_estimate_lines }o--o| source_documents : "source_document_id"
  chotatsu_estimate_lines }o--|| chotatsu_estimates : "case_id,estimate_id"
  chotatsu_estimates }o--|| chotatsu_cases : "case_id"
  chotatsu_handoff_events }o--|| chotatsu_handoffs : "handoff_id"
  chotatsu_handoffs }o--|| chotatsu_estimates : "case_id,estimate_id"
  chotatsu_handoffs }o--|| rights_intake_cases : "intake_case_id,work_id"
  chotatsu_handoffs }o--|| chotatsu_cases : "case_id"
  chotatsu_materials }o--o| source_documents : "source_document_id"
  chotatsu_materials }o--|| chotatsu_cases : "case_id"
  chotatsu_ringi }o--o| source_documents : "source_document_id"
  chotatsu_ringi }o--|| chotatsu_estimates : "case_id,estimate_id"
  chotatsu_stage_events }o--|| chotatsu_cases : "case_id"
  contract_production_milestones }o--|| contract_production_versions : "project_id,version_no"
  contract_production_versions }o--|| projects : "project_id"
  earning_type_rate_versions }o--|| earning_types : "earning_type"
  investment_approval_versions }o--|| projects : "project_id"
  mg_outgoing_contracts }o--|| mg_suppliers : "supplier_id"
  planning_documents }o--|| source_documents : "document_id"
  planning_documents }o--|| projects : "project_id"
  planning_facts }o--o| planning_facts : "project_id,previous_id"
  planning_facts }o--o| planning_materials : "project_id,material_id"
  planning_facts }o--|| projects : "project_id"
  planning_materials }o--o| source_documents : "document_id"
  planning_materials }o--|| projects : "project_id"
  planning_profile_people }o--|| planning_profile_versions : "version_id"
  planning_profile_versions }o--|| projects : "project_id"
  planning_trial_investments }o--|| planning_trial_versions : "version_id"
  planning_trial_lines }o--|| planning_trial_versions : "version_id"
  planning_trial_rates }o--|| planning_trial_versions : "version_id"
  planning_trial_versions }o--o| source_documents : "document_id"
  planning_trial_versions }o--|| projects : "project_id"
  produce_task_checks }o--|| projects : "project_id"
  produce_task_events }o--|| projects : "project_id"
  produce_task_links }o--|| projects : "project_id"
  produce_task_posts }o--|| projects : "project_id"
  produce_task_template_items }o--|| produce_task_templates : "template_id"
  produce_tasks }o--o| works : "project_id,work_id"
  produce_tasks }o--|| projects : "project_id"
  project_owner_versions }o--|| projects : "project_id"
  project_stage_events }o--|| projects : "project_id"
  project_stage_events }o--o| project_stages : "previous_stage_code"
  project_stage_events }o--|| project_stages : "stage_code"
  project_stage_meanings }o--|| earning_types : "earning_type"
  project_stage_meanings }o--|| project_stages : "stage_code"
  project_stages }o--o| action_steps : "step_code"
  projects }o--o| earning_types : "earning_type"
  rights_intake_cases }o--o| rights_intake_cases : "source_case_id,work_id"
  rights_intake_cases }o--|| works : "project_id,work_id"
  rights_intake_documents }o--|| rights_intake_cases : "intake_case_id"
  rights_intake_participants }o--o| partners : "partner_id"
  rights_intake_participants }o--|| rights_intake_cases : "intake_case_id"
  rights_intake_scopes }o--|| rights_intake_cases : "intake_case_id"
  works }o--|| projects : "project_id"
```

主キーと参照の列だけを載せる。組織（organizations・memberships）への参照は省く。

## 表の一覧

| 表 | 論理名 | 説明 |
|---|---|---|
| [acq_mg_contracts](#acq_mg_contracts) | 支払う MG の契約 | 1行は、権利元へ払う MG（買付分）の契約1件。条件は条件版（acq_mg_term_versions）で持ち、変更・削除はできない。古い支払 MG（mg_outgoing_contracts）と配給委託の MG 型（settlement_contracts）から移した契約は、その元を指す。 |
| [acq_mg_documents](#acq_mg_documents) | 支払う MG の原本の結び付き | 1行は、契約（と条件版）に結んだ原本1つ（契約書・振込の控え・請求書）。原本は共通の原本の表（source_documents）を指す。 |
| [acq_mg_payment_schedule](#acq_mg_payment_schedule) | MG の支払予定 | 1行は、MG を分けて払う回1つ（署名・納品・公開・日付のきっかけと額）。出金予定と予実が読む。 |
| [acq_mg_payments](#acq_mg_payments) | 支払うMGの支払 | 1行は、権利元へ払った MG の前払か超過の分配額の支払1回。円の額は実際に払った額。直しは取消の行で、変更・削除はできない。 |
| [acq_mg_report_links](#acq_mg_report_links) | 売上報告と支払う MG の結び付け | 1行は、売上報告×作品を条件版へ結ぶ（入れる・外す）判断1つ。作品と期間で1つに決まれば自動、決まらなければ人が理由を書く。直すときは前の行を指す行を足す。 |
| [acq_mg_statements](#acq_mg_statements) | 支払う MG の分配報告書 | 1行は、締め月の分配報告書の発行か取消1つ。発行した時点の回収の値と本体・ハッシュを写して残す。 |
| [acq_mg_term_deductions](#acq_mg_term_deductions) | 分配の前に引く費目 | 1行は、条件版で権利元への分配の前に引くと契約に書かれた費目1つと、その上限（FR-PLAN-ACQ-040）。 |
| [acq_mg_term_media_allocations](#acq_mg_term_media_allocations) | 媒体ごとの MG の配分 | 1行は、媒体ごとに配分する契約の、媒体（売上集計シートの流通のまとまり）1つの配分額。 |
| [acq_mg_term_phases](#acq_mg_term_phases) | 分配報告の周期 | 1行は、条件版の分配報告の周期の区間1つ（ロイヤリティ・製作委員会と同じ表し方。D-029 決定1）。 |
| [acq_mg_term_versions](#acq_mg_term_versions) | 支払う MG の条件版 | 1行は、支払う MG の契約の条件の版1つ。契約ごとの連番で、直すときは新しい版を足す。回収の値は持たず、売上明細から毎回計算する（FR-PLAN-ACQ-011）。 |
| [acq_mg_term_works](#acq_mg_term_works) | 支払う MG の対象の作品 | 1行は、条件版の対象の作品1つ。作品ごとの額は、先に決めた契約だけ持つ。 |
| [action_steps](#action_steps) | 行動のステップ | 行動のステップの参照表。親の無い行が集計の3つ（面談・提案・契約）で、細目の段（ontology の行動の段）は親を持つ行として種で足す。2段まで。コードと親は足したあと変えない |
| [budget_check_runs](#budget_check_runs) | 予算書の検査の結果（回） | 予算書の版の検査の結果を回ごとに残す（追記だけ）。最新の回が例外ありの版は確定できない |
| [budget_fixes](#budget_fixes) | 予算書の確定の記録 | 予算書の版の確定と取り消しの記録（追記だけ）。いまの確定版は最後の行から導く（fix ならその版、void なら確定版なし）。確定は最新の検査が例外なしの版だけ、取り消しはいまの確定版だけ |
| [budget_line_items](#budget_line_items) | 予算書の行の内訳 | 予算書の行の内訳（キャストリストの役ごとなど。追記だけ。確定した版には足せない）。行の金額は内訳の和。役者名・事務所名は持たず、キャスト一覧を参照で指す |
| [budget_template_items](#budget_template_items) | 予算書の型の費目 | 予算書の型の版の費目（追記だけ）。区分は A〜K。額は持たず、単価・数量・単位と、内訳を持つ費目の内訳のシートの名前を持つ |
| [budget_template_versions](#budget_template_versions) | 予算書の型（版） | 予算書の型の版（追記だけ。型ごとの連番）。費目は版ごとに持ち、前の版は残る |
| [budget_templates](#budget_templates) | 予算書の型 | 予算書の型（テンプレ。追記だけ）。組織ごとに名前で区別し、名前は変えない。費目は型の版が持つ |
| [budget_version_lines](#budget_version_lines) | 予算書の行 | 予算書の版の明細の行（追記だけ。確定した版には足せない）。区分は A〜K の11区分（実費の行と同じコード）。個人名・事務所名は持たない |
| [budget_version_templates](#budget_version_templates) | 予算書の版の型 | 予算書の版がどの型の版から作られたか（追記だけ。1つの版に1つまで） |
| [budget_versions](#budget_versions) | 予算書（版） | 案件の予算書の版（追記だけ。変更・削除・同じ番号の入れ直しは DB が断る）。案件ごとの連番。合計の列は持たず、行と制作管理費・予備費（計画）・税率から読むたびに導く。理由は必須 |
| [cashflow_categories](#cashflow_categories) | 入出金の区分 | 案件の入金・出金の区分マスタ（入金4・出金5）。入出金と「売上の元になるか」を区分で決め、金額は正で持って符号は区分で決める。出金は売上の元にならない。移行では行を入れず、組織ごとに種かアプリで足す。入出金と売上の元は足したあと変えない |
| [chotatsu_agreements](#chotatsu_agreements) | 調達の合意 | 権利元と合意した試算の版と合意の日（いまはメールの原本を置く） |
| [chotatsu_case_expenses](#chotatsu_case_expenses) | 調達の経費の結び付き | 調達の案件と経費の明細の行（expenses）の結び付き（請求と支払が起きた実績だけ。追記だけ） |
| [chotatsu_case_versions](#chotatsu_case_versions) | 調達の案件の版 | 案件の題・権利元・配給・媒体・作品・起点・劇場公開日・提案できる期間・発売予定月と枠の版（追記だけ。最後の版がいま） |
| [chotatsu_cases](#chotatsu_cases) | 調達の案件 | MG を払わずに販売権を調達する1件の芯（番号だけ。変えない）。題・権利元・発売予定などは版に持つ |
| [chotatsu_contracts](#chotatsu_contracts) | 調達の契約 | 契約の段で作った調達案件（rights_intake_cases。受け方 entrusted）と配給委託の契約（settlement_contracts の commission）を指す |
| [chotatsu_documents](#chotatsu_documents) | 調達の原本の結び付き | 調達の案件と共通の原本の表（source_documents）の結び付き（追記だけ） |
| [chotatsu_estimate_lines](#chotatsu_estimate_lines) | 調達の試算の見積の行 | 試算の版の見積の行（経費の種類で書く。見積は経費の行に入れない） |
| [chotatsu_estimates](#chotatsu_estimates) | 調達の試算の版 | 試算と仕様案（形態・組数・特典・予定価格・1枚の売上・数量の見込み・権利料の条件案・宣伝案）の版（追記だけ）。MG の型は持たない。粗利の見込みは表に持たず計算する |
| [chotatsu_handoff_events](#chotatsu_handoff_events) | 調達から製造への引き渡しの段 | 引き渡しの段（notice 予告 → received 受領、void 取消）の記録（追記だけ） |
| [chotatsu_handoffs](#chotatsu_handoffs) | 調達から製造への引き渡し | 製造へ渡す行（予告で作る）。作品・調達案件・許された形・地域・権利期間の終わり・試算の版・発売の枠と月。製造は読むだけ |
| [chotatsu_materials](#chotatsu_materials) | 調達の素材の受領 | 素材（本編マスター・確認用・予告編・特典映像・音楽素材・メインアート・ロゴ・場面写真・ポスター・作品情報）の受領と検品の記録（追記だけ。種類ごとに最後の行がいま） |
| [chotatsu_ringi](#chotatsu_ringi) | 調達の稟議 | 販売稟議書の結果（承認・差し戻し・否決）と日、稟議にかけた試算の版。承認の流れは持たない（最後の行がいまの結果） |
| [chotatsu_stage_events](#chotatsu_stage_events) | 調達の段の出来事 | 見送り（dropped）・MG_買付分へ移した（moved_to_mg）・その取消（void）と、希望の登録（done）の記録（追記だけ）。閉じた案件には取消のほかを足せない |
| [contract_production_milestones](#contract_production_milestones) | 受託制作の契約の支払いの節目 | 受託制作の契約の版の子の行（追記だけ）。連番の順に月初の日が進み、最後の行で割合の和がちょうど 10000 になる（DB のトリガーが断る）。節目ごとの制作費と受託費（純額）は、総製作費と受託費をこの割合で最大剰余法に配って出す（保存しない） |
| [contract_production_versions](#contract_production_versions) | 受託制作の契約（版） | 型「受託制作」の案件の契約の版（追記だけ。変更・削除は DB が断る）。案件ごとの連番の最新の version_no が有効。総製作費（税別）・受託費率（1000〜1500 bp、既定 1000）と、受託費＝総製作費×受託費率を truncate した整数円を持ち、受託費が式どおりかを表の CHECK で確かめる。受託費は自社の売上で、制作予備費とは別の値。売上の4区分は持たず、案件の型・稼ぎ方・この版から導く（U-9 の答え）。版の番号が最新の次でない書き込み（古い画面）と、型が受託制作でない案件への版は断る |
| [earning_type_rate_versions](#earning_type_rate_versions) | 稼ぎ方の既定の売上率（版） | 組織ごと・稼ぎ方ごとの既定の売上率の版。版を足して残し、最新の version_no が有効。前提の数字なので状態を必ず持つ。移行では行を入れず、種か設定で足す。制作受託（受託の契約の版の率を使う稼ぎ方）には持たない。既定の売上率の置き場はこの表だけで、フェーズ1 #11 の設定の行（variable_key・scope=earning_type）に同じ値を持たせない |
| [earning_types](#earning_types) | 稼ぎ方 | 稼ぎ方の参照表（買付・販売委託・自社出資・製作委員会・制作受託の5つ）。コードの正本で、CHECK にせず行で持つ。案件の型との組・利益の源泉・基準額の中身・使う率の出どころを、要件（案件収支の予実）の対応表どおりに持つ。行は移行で入れ、型との組・利益の源泉・基準額の中身・使う率の出どころは足したあと変えない（トリガー earning_types_fixed。変えるときは移行で） |
| [investment_approval_versions](#investment_approval_versions) | 稟議（版） | 自社出資の稟議の版（追記だけ。変更・削除・同じ番号の入れ直しは DB が断り、最初の版も消せない）。稼ぎ方が自社出資の案件ごとに稟議の番号を振り、稟議ごとに版の連番を足す。いまの状態（申請中・承認済み・却下・払込）は最新の版から読むたびに導く。版1は申請で、申請のあとは申請し直し・承認・却下、却下のあとは申請し直し、承認と払込のあとは払込だけ。承認と却下の額は直前の申請の額のまま。払込は払った日と額を持ち、承認の前には入れられず、累計は承認の額まで。申請と承認は同じ人でよく、各版の記録した人と日時が残る。払込は会社への利益額が払った月に引き、出資の回収の出資額になる |
| [mg_outgoing_contracts](#mg_outgoing_contracts) | 支払MGの契約 | 1行は、仕入先・権利元へ MG を払う契約（支払MG）1件。条件は条件版（mg_term_versions）で持ち、変更・削除はできない。 |
| [mg_suppliers](#mg_suppliers) | MGの仕入先 | 1行は、支払MGの相手（仕入先・権利元）1社。MG契約の画面で登録し、取引先（partners）とは別の ID で持つ。 |
| [planning_documents](#planning_documents) | 企画の原本の結び付き | 案件と共通の原本（source_documents）の結び付き。種類は企画書・試算・素材。企画書は役（下書き／提出版）と提出先・提出日を持つ。追加のみ |
| [planning_facts](#planning_facts) | 企画の事実（抜き出し） | 素材から抜き出した事実（AI と壁打ちした下書きと、人が確定した行）。確定は新しい行で前の行を指す（下書きの行は消さない）。結ぶページ（企画書の32枚の番号）で準備ボードの揃いを出す |
| [planning_materials](#planning_materials) | 企画の素材 | 企画書のための素材（類似作・市場・自社の実績・キャスト・監督・世界観の文献・物語の構造・題名・申告）。判定の印（確・推・不明）と出典を持つ。原本があれば共通の原本を指す |
| [planning_profile_people](#planning_profile_people) | 企画の体制の候補 | 企画の項目の版ごとの体制の候補（監督・脚本・主演など）。状態は候補・交渉中・確定。追加のみ |
| [planning_profile_versions](#planning_profile_versions) | 企画の項目（版） | 企画の言葉の版（作業題・起点・ログライン・あらすじ・形式・本数・予定の公開年・提出先）。案件ごとの連番で追加のみ |
| [planning_trial_investments](#planning_trial_investments) | 試算の出資 | 試算の版ごとの出資（出金）の月と額。±0 になる月は最後の出資の月以降で数える |
| [planning_trial_lines](#planning_trial_lines) | 試算の詳細の行 | 流通の詳細の1行＝1取引先×1窓口。開始月と回収の月数から回収スケジュールを導く。数量か額は even・good・max の3列 |
| [planning_trial_rates](#planning_trial_rates) | 試算の率 | 試算の版ごとの、販売の型ごとの率と単価（先方の取り分・窓口とライツの手数料・原作の印税・監督と脚本の印税・製造単価）。根拠の数字は版ごとに変えられる |
| [planning_trial_versions](#planning_trial_versions) | 試算（版） | 売上試算の3段の型（表紙→流通の大別→流通の詳細）の版。持つのは入力だけで、売上・権利元収入・回収率・±0 の月は保存せず毎回計算する。案件ごとの連番で追加のみ |
| [produce_task_checks](#produce_task_checks) | 進行表のチェック項目 | チケットのチェック項目（追記だけ）。入れる・外すたびに同じ check_uid で行を足し、最新の行が有効 |
| [produce_task_events](#produce_task_events) | 進行表の着手・完了の記録 | チケットの着手・完了・戻すの記録（追記だけ）。完了は最後の完了が最後の戻すより後のとき |
| [produce_task_links](#produce_task_links) | 進行表の関連する場所 | チケットから移る業務の画面・書類へのリンク（追記だけ。写しは持たない）。外すのは removed=1 の行 |
| [produce_task_posts](#produce_task_posts) | 進行表の掲示板 | チケットの掲示板の書き込み（追記だけ。直すときは新しい書き込みで書く） |
| [produce_task_template_items](#produce_task_template_items) | 進行表のテンプレートの行 | テンプレートの版の行（追記だけ）。起点からの日数で持つ |
| [produce_task_templates](#produce_task_templates) | 進行表のテンプレート（版） | 組織で使い回す進行表のテンプレートの版（追記だけ）。標準の進行はコードの定数に持ち、ここには利用者が残したものだけが入る |
| [produce_tasks](#produce_tasks) | 進行表のチケット（版） | 進行表のチケットの版（追記だけ）。直すたびに同じ task_uid で版を足し、最新の版が有効。やめたものは retired=1 の版。状態の列は持たず、予定と記録から導く |
| [project_owner_versions](#project_owner_versions) | 案件の担当者（版） | 案件の担当者（利用者）の版。担当を替えるときは版を足す。今の担当は開始日が今日以前の最新の版。予実が「担当の案件」を読む |
| [project_stage_events](#project_stage_events) | 案件の段階の履歴 | 案件の段階を変えた記録（追記だけ。変更・削除は DB が断る）。案件ごとの連番の最新の行が、いまの段階。前の段階は直前の行の段階と同じでなければ断り、入った日は直前の行より前にしない。見送りに入るときは理由が要る |
| [project_stage_meanings](#project_stage_meanings) | 案件の段階の稼ぎ方ごとの意味 | 段階ごとの、稼ぎ方ごとの意味（営業ヨミ表のステータス表の稼ぎ方の列）。行は種で足す |
| [project_stages](#project_stages) | 案件の段階 | 案件の段階の参照表（10段階＋見送り。営業ヨミ表の型）。確度は段階から導き、案件に手で入れさせない。行は移行で入れ、確度・ステップ・理由の要否は足したあと変えない（トリガー project_stages_fixed。変えるときは移行で） |
| [projects](#projects) | 案件 | 案件1件。作品は案件にぶら下がる（作品を持たない案件もある）。案件の画面や一括登録で作り、作ったあとに書き換える画面・API は無い。予算は財務の権限がある人だけが見られる。型・稼ぎ方・基準額・売上率・相手などは移行0012で足した列で、既存の案件は NULL（未登録）のまま。足した列は既存の案件の API（bootstrap・/api/projects）が返さない。段階は段階の履歴の最新の行から、確度は段階から導くので列に持たない |
| [rights_intake_cases](#rights_intake_cases) | 権利の調達ケース | 作品の権利をどう調達したか（製作委員会・単独保有・権利受託）の下書き1件。改訂は新しい行を足し、書き換えない。 |
| [rights_intake_documents](#rights_intake_documents) | 調達の契約書参照 | 調達ケースの元になる契約書の参照1件（名前・参照先・版）。ケースと同時に作り、書き換えない。 |
| [rights_intake_participants](#rights_intake_participants) | 調達の参加者 | 調達ケースの参加者1件（自社か取引先、役割・出資額・持分）。ケースと同時に作り、書き換えない。 |
| [rights_intake_scopes](#rights_intake_scopes) | 調達した権利の範囲 | 調達ケースで得た権利の範囲1件（流通・地域・期間・独占か）。ケースと同時に作り、書き換えない。 |
| [works](#works) | 作品 | 作品1本。案件にぶら下がり、売上・経費・契約などが作品を参照する。作品の画面や一括登録で作る。 |

## acq_mg_contracts

**支払う MG の契約** — 1行は、権利元へ払う MG（買付分）の契約1件。条件は条件版（acq_mg_term_versions）で持ち、変更・削除はできない。古い支払 MG（mg_outgoing_contracts）と配給委託の MG 型（settlement_contracts）から移した契約は、その元を指す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | code | TEXT | 契約の番号（組織の中で一意） | 不可 | - | CHECK: length(trim(code)) BETWEEN 1 AND 40 |
| 4 | title | TEXT | 契約の題 | 不可 | - | CHECK: length(trim(title)) BETWEEN 1 AND 200 |
| 5 | partner_id | INTEGER | 権利元（partners） | 不可 | - | FK（複合）→ partners |
| 6 | intake_case_id | INTEGER | 調達案件（rights_intake_cases）。受け方「買付」を足すまでは空を許す | 可 | - | FK（複合）→ rights_intake_cases |
| 7 | legacy_settlement_contract_id | INTEGER | 移した元の配給委託の MG 型の契約（settlement_contracts） | 可 | - | FK（複合）→ settlement_contracts |
| 8 | legacy_outgoing_contract_id | INTEGER | 移した元の支払 MG の契約（mg_outgoing_contracts） | 可 | - | FK（複合）→ mg_outgoing_contracts |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, code)
- 複合の一意: (org_id, legacy_settlement_contract_id)
- 複合の一意: (org_id, legacy_outgoing_contract_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, legacy_outgoing_contract_id) → mg_outgoing_contracts(org_id, id)
- 複合の参照: (org_id, legacy_settlement_contract_id) → settlement_contracts(org_id, id)
- 複合の参照: (org_id, intake_case_id) → rights_intake_cases(org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- トリガー acq_mg_contracts_no_delete: 削除の前
- トリガー acq_mg_contracts_no_update: 更新の前

## acq_mg_documents

**支払う MG の原本の結び付き** — 1行は、契約（と条件版）に結んだ原本1つ（契約書・振込の控え・請求書）。原本は共通の原本の表（source_documents）を指す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 契約（acq_mg_contracts） | 不可 | - | FK（複合）→ acq_mg_contracts |
| 4 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 可 | - | FK（複合）→ acq_mg_term_versions |
| 5 | source_document_id | INTEGER | 原本（source_documents） | 不可 | - | FK（複合）→ source_documents、CHECK: typeof(source_document_id)='integer' AND source_document_id>0 |
| 6 | kind | TEXT（列挙） | 原本の種類（contract・payment_proof・invoice） | 不可 | - | 値: contract / payment_proof / invoice |
| 7 | reason | TEXT | 結んだ理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 8 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, contract_id, source_document_id, kind)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, source_document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- 複合の参照: (org_id, contract_id) → acq_mg_contracts(org_id, id)
- トリガー acq_mg_documents_no_delete: 削除の前
- トリガー acq_mg_documents_no_update: 更新の前
- トリガー acq_mg_documents_version_scope: 追加の前

## acq_mg_payment_schedule

**MG の支払予定** — 1行は、MG を分けて払う回1つ（署名・納品・公開・日付のきっかけと額）。出金予定と予実が読む。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 不可 | - | PK（複合）、FK（複合）→ acq_mg_term_versions |
| 3 | installment | INTEGER | 支払の回 | 不可 | - | PK（複合）、CHECK: typeof(installment)='integer' AND installment BETWEEN 1 AND 50 |
| 4 | trigger_kind | TEXT（列挙） | きっかけ（signing・delivery・release・date） | 不可 | - | 値: signing / delivery / release / date |
| 5 | due_on | TEXT | 予定日 | 可 | - | CHECK: due_on IS NULL OR (length(due_on)=10 AND due_on BETWEEN '1900-01-01' AND '2999-12-31') |
| 6 | amount | INTEGER | 額 | 不可 | - | CHECK: typeof(amount)='integer' AND amount BETWEEN 0 AND 9007199254740991 |

表の制約:

- 複合の主キー: (org_id, term_version_id, installment)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- CHECK: trigger_kind<>'date' OR due_on IS NOT NULL
- トリガー acq_mg_payment_schedule_no_delete: 削除の前
- トリガー acq_mg_payment_schedule_no_update: 更新の前

## acq_mg_payments

**支払うMGの支払** — 1行は、権利元へ払った MG の前払か超過の分配額の支払1回。円の額は実際に払った額。直しは取消の行で、変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 契約（acq_mg_contracts） | 不可 | - | FK（複合）→ acq_mg_contracts |
| 4 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 不可 | - | FK（複合）→ acq_mg_term_versions |
| 5 | kind | TEXT（列挙） | 種類（mg_advance＝MG の前払、distribution＝超過の分配額） | 不可 | - | 値: mg_advance / distribution |
| 6 | installment | INTEGER | 支払予定の回（MG の前払） | 可 | - | CHECK: installment IS NULL OR (typeof(installment)='integer' AND installment BETWEEN 1 AND 50) |
| 7 | statement_id | INTEGER | 分配報告書（acq_mg_statements。分配額の支払） | 可 | - | FK（複合）→ acq_mg_statements |
| 8 | partner_id | INTEGER | 権利元（partners） | 不可 | - | FK（複合）→ partners |
| 9 | amount_yen | INTEGER | 実際に払った円の額 | 不可 | - | CHECK: typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 9007199254740991 |
| 10 | paid_on | TEXT | 支払日 | 不可 | - | CHECK: length(paid_on)=10 AND paid_on BETWEEN '1900-01-01' AND '2999-12-31' |
| 11 | reference | TEXT | 振込などの参照（組織の中で一意） | 不可 | - | CHECK: length(trim(reference)) BETWEEN 1 AND 160 |
| 12 | currency | TEXT | 支払の通貨（3字） | 不可 | JPY | CHECK: length(currency)=3 AND upper(currency)=currency |
| 13 | foreign_amount | INTEGER | 外貨の額（通貨の最小単位の整数） | 可 | - | CHECK: foreign_amount IS NULL OR (typeof(foreign_amount)='integer' AND foreign_amount BETWEEN 1 AND 9007199254740991) |
| 14 | fx_rate_micro | INTEGER | レート（100万倍の整数） | 可 | - | CHECK: fx_rate_micro IS NULL OR (typeof(fx_rate_micro)='integer' AND fx_rate_micro BETWEEN 1 AND 9007199254740991) |
| 15 | fx_rate_on | TEXT | レートの日 | 可 | - | CHECK: fx_rate_on IS NULL OR (length(fx_rate_on)=10 AND fx_rate_on BETWEEN '1900-01-01' AND '2999-12-31') |
| 16 | reverses_payment_id | INTEGER | 取り消した元の支払 | 可 | - | FK（複合）→ acq_mg_payments |
| 17 | reason | TEXT | 理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 18 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 19 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, reference)
- 複合の一意: (org_id, reverses_payment_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, reverses_payment_id) → acq_mg_payments(org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, statement_id) → acq_mg_statements(org_id, id)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- 複合の参照: (org_id, contract_id) → acq_mg_contracts(org_id, id)
- CHECK: (currency='JPY' AND foreign_amount IS NULL AND fx_rate_micro IS NULL AND fx_rate_on IS NULL) OR (currency<>'JPY' AND foreign_amount IS NOT NULL AND fx_rate_micro IS NOT NULL AND fx_rate_on IS NOT NULL)
- CHECK: (kind='mg_advance' AND statement_id IS NULL) OR (kind='distribution' AND installment IS NULL AND statement_id IS NOT NULL)
- CHECK: reverses_payment_id IS NULL OR reverses_payment_id<>id
- トリガー acq_mg_payments_installment_scope: 追加の前
- トリガー acq_mg_payments_no_delete: 削除の前
- トリガー acq_mg_payments_no_update: 更新の前
- トリガー acq_mg_payments_partner_match: 追加の前
- トリガー acq_mg_payments_reverse_scope: 追加の前
- トリガー acq_mg_payments_statement_scope: 追加の前
- トリガー acq_mg_payments_version_scope: 追加の前

## acq_mg_report_links

**売上報告と支払う MG の結び付け** — 1行は、売上報告×作品を条件版へ結ぶ（入れる・外す）判断1つ。作品と期間で1つに決まれば自動、決まらなければ人が理由を書く。直すときは前の行を指す行を足す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | report_id | INTEGER | 売上報告（report_imports） | 不可 | - | FK（複合）→ report_imports |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ works |
| 5 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 不可 | - | FK（複合）→ acq_mg_term_versions |
| 6 | report_basis | TEXT（列挙） | 報告の額の基礎（gross＝控除前、net＝控除後） | 不可 | - | 値: gross / net |
| 7 | decided_by | TEXT（列挙） | 決め方（auto・human） | 不可 | - | 値: auto / human |
| 8 | decision | TEXT（列挙） | 判断（include・exclude） | 不可 | - | 値: include / exclude |
| 9 | reason | TEXT | 理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 10 | replaces_link_id | INTEGER | 直した元の結び付け | 可 | - | FK（複合）→ acq_mg_report_links |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, replaces_link_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, replaces_link_id) → acq_mg_report_links(org_id, id)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- 複合の参照: (org_id, work_id) → works(org_id, id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- トリガー acq_mg_report_links_no_delete: 削除の前
- トリガー acq_mg_report_links_no_update: 更新の前
- トリガー acq_mg_report_links_replace_scope: 追加の前
- トリガー acq_mg_report_links_single_chain: 追加の前

## acq_mg_statements

**支払う MG の分配報告書** — 1行は、締め月の分配報告書の発行か取消1つ。発行した時点の回収の値と本体・ハッシュを写して残す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 不可 | - | FK（複合）→ acq_mg_term_versions |
| 4 | close_month | TEXT | 締め月 | 不可 | - | CHECK: length(close_month)=7 AND substr(close_month,5,1)='-' AND substr(close_month,6,2) BETWEEN '01' AND '12' AND substr(close_month,1,4) BETWEEN '1900' AND '2999' |
| 5 | kind | TEXT（列挙） | 種類（issue＝発行、void＝取消） | 不可 | - | 値: issue / void |
| 6 | status | TEXT（列挙） | 回収の状態（recouping・recouped・buyout・hold） | 可 | - | 値: recouping / recouped / buyout / hold |
| 7 | recouped | INTEGER | 回収累計 | 可 | - | CHECK: recouped IS NULL OR typeof(recouped)='integer' |
| 8 | balance | INTEGER | 残高 | 可 | - | CHECK: balance IS NULL OR typeof(balance)='integer' |
| 9 | overage | INTEGER | 超過 | 可 | - | CHECK: overage IS NULL OR typeof(overage)='integer' |
| 10 | distribution | INTEGER | 分配額 | 可 | - | CHECK: distribution IS NULL OR typeof(distribution)='integer' |
| 11 | body_json | TEXT | 報告書の本体 | 可 | - | CHECK: body_json IS NULL OR (json_valid(body_json) AND length(body_json) BETWEEN 2 AND 1000000) |
| 12 | body_sha256 | TEXT | 本体のハッシュ | 可 | - | CHECK: body_sha256 IS NULL OR length(body_sha256)=64 |
| 13 | issued_on | TEXT | 発行日（取消は取消日） | 不可 | - | CHECK: length(issued_on)=10 AND issued_on BETWEEN '1900-01-01' AND '2999-12-31' |
| 14 | voids_statement_id | INTEGER | 取り消した報告書 | 可 | - | FK（複合）→ acq_mg_statements |
| 15 | reason | TEXT | 取消の理由 | 可 | - | CHECK: reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500 |
| 16 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 17 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, voids_statement_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, voids_statement_id) → acq_mg_statements(org_id, id)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- CHECK: (kind='issue' AND status IS NOT NULL AND recouped IS NOT NULL AND balance IS NOT NULL AND overage IS NOT NULL AND body_json IS NOT NULL AND body_sha256 IS NOT NULL AND voids_statement_id IS NULL) OR (kind='void' AND status IS NULL AND recouped IS NULL AND balance IS NULL AND overage IS NULL AND distribution IS NULL AND body_json IS NULL AND body_sha256 IS NULL AND voids_statement_id IS NOT NULL AND reason IS NOT NULL)
- トリガー acq_mg_statements_no_delete: 削除の前
- トリガー acq_mg_statements_no_update: 更新の前
- トリガー acq_mg_statements_one_live_issue: 追加の前
- トリガー acq_mg_statements_void_scope: 追加の前

## acq_mg_term_deductions

**分配の前に引く費目** — 1行は、条件版で権利元への分配の前に引くと契約に書かれた費目1つと、その上限（FR-PLAN-ACQ-040）。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 不可 | - | PK（複合）、FK（複合）→ acq_mg_term_versions |
| 3 | category | TEXT | 費目 | 不可 | - | PK（複合）、CHECK: length(trim(category)) BETWEEN 1 AND 80 |
| 4 | cap_amount | INTEGER | 上限の額 | 可 | - | CHECK: cap_amount IS NULL OR (typeof(cap_amount)='integer' AND cap_amount BETWEEN 0 AND 9007199254740991) |
| 5 | cap_bps | INTEGER | 上限の率（MG の額に対する bp） | 可 | - | CHECK: cap_bps IS NULL OR (typeof(cap_bps)='integer' AND cap_bps BETWEEN 0 AND 10000) |
| 6 | source_ref | TEXT | 根拠の契約の条項 | 不可 | - | CHECK: length(trim(source_ref)) BETWEEN 1 AND 200 |

表の制約:

- 複合の主キー: (org_id, term_version_id, category)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- トリガー acq_mg_term_deductions_no_delete: 削除の前
- トリガー acq_mg_term_deductions_no_update: 更新の前

## acq_mg_term_media_allocations

**媒体ごとの MG の配分** — 1行は、媒体ごとに配分する契約の、媒体（売上集計シートの流通のまとまり）1つの配分額。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 不可 | - | PK（複合）、FK（複合）→ acq_mg_term_versions |
| 3 | media | TEXT（列挙） | 媒体（flat・mg・rs・rss・vod） | 不可 | - | PK（複合）、値: flat / mg / rs / rss / vod |
| 4 | amount | INTEGER | 配分額 | 不可 | - | CHECK: typeof(amount)='integer' AND amount BETWEEN 0 AND 9007199254740991 |

表の制約:

- 複合の主キー: (org_id, term_version_id, media)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- トリガー acq_mg_term_media_allocations_no_delete: 削除の前
- トリガー acq_mg_term_media_allocations_no_update: 更新の前

## acq_mg_term_phases

**分配報告の周期** — 1行は、条件版の分配報告の周期の区間1つ（ロイヤリティ・製作委員会と同じ表し方。D-029 決定1）。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 不可 | - | PK（複合）、FK（複合）→ acq_mg_term_versions |
| 3 | phase_order | INTEGER | 区間の順番 | 不可 | - | PK（複合）、CHECK: typeof(phase_order)='integer' AND phase_order BETWEEN 1 AND 20 |
| 4 | starts_month | TEXT | 区間の開始月 | 不可 | - | CHECK: length(starts_month)=7 AND substr(starts_month,5,1)='-' AND substr(starts_month,6,2) BETWEEN '01' AND '12' AND substr(starts_month,1,4) BETWEEN '1900' AND '2999' |
| 5 | ends_month | TEXT | 区間の終了月 | 可 | - | CHECK: ends_month IS NULL OR (length(ends_month)=7 AND substr(ends_month,5,1)='-' AND substr(ends_month,6,2) BETWEEN '01' AND '12' AND substr(ends_month,1,4) BETWEEN '1900' AND '2999') |
| 6 | cycle_kind | TEXT（列挙） | サイクルの種類 | 不可 | - | 値: monthly / quarterly / semiannual / annual / custom / manual / none |
| 7 | anchor_month | INTEGER | 基準月 | 可 | - | CHECK: anchor_month IS NULL OR anchor_month BETWEEN 1 AND 12 |
| 8 | custom_close_months | TEXT | 任意の締め月の列挙 | 可 | - | CHECK: custom_close_months IS NULL OR length(custom_close_months) BETWEEN 7 AND 2000 |
| 9 | first_close_immediate | INTEGER（真偽 0/1） | 初月に即締めるか | 不可 | 0 | - |
| 10 | report_offset_months | INTEGER | 締めから報告までの月数 | 不可 | 1 | CHECK: report_offset_months BETWEEN 0 AND 24 |
| 11 | report_day | INTEGER | 報告の日（空は月末） | 可 | - | CHECK: report_day IS NULL OR report_day BETWEEN 1 AND 31 |
| 12 | payment_offset_months | INTEGER | 締めから支払までの月数 | 不可 | 1 | CHECK: payment_offset_months BETWEEN 0 AND 24 |
| 13 | payment_day | INTEGER | 支払の日（空は月末） | 可 | - | CHECK: payment_day IS NULL OR payment_day BETWEEN 1 AND 31 |

表の制約:

- 複合の主キー: (org_id, term_version_id, phase_order)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- CHECK: ends_month IS NULL OR ends_month>=starts_month
- CHECK: (cycle_kind IN ('quarterly','semiannual','annual') AND anchor_month IS NOT NULL) OR (cycle_kind NOT IN ('quarterly','semiannual','annual') AND anchor_month IS NULL)
- CHECK: (cycle_kind='custom' AND custom_close_months IS NOT NULL) OR (cycle_kind<>'custom' AND custom_close_months IS NULL)
- CHECK: first_close_immediate=0 OR cycle_kind IN ('quarterly','semiannual','annual','custom')
- トリガー acq_mg_term_phases_no_delete: 削除の前
- トリガー acq_mg_term_phases_no_update: 更新の前

## acq_mg_term_versions

**支払う MG の条件版** — 1行は、支払う MG の契約の条件の版1つ。契約ごとの連番で、直すときは新しい版を足す。回収の値は持たず、売上明細から毎回計算する（FR-PLAN-ACQ-011）。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 契約（acq_mg_contracts） | 不可 | - | FK（複合）→ acq_mg_contracts |
| 4 | version_no | INTEGER | 契約ごとの版の番号 | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | consideration | TEXT（列挙） | 対価の型（mg＝MG、buyout＝買切） | 不可 | - | 値: mg / buyout |
| 6 | currency | TEXT | 契約の通貨（3字） | 不可 | JPY | CHECK: length(currency)=3 AND upper(currency)=currency |
| 7 | mg_amount | INTEGER | MG の額（契約の通貨の整数） | 不可 | - | CHECK: typeof(mg_amount)='integer' AND mg_amount BETWEEN 0 AND 9007199254740991 |
| 8 | starts_on | TEXT | 契約開始日 | 不可 | - | CHECK: length(starts_on)=10 AND starts_on BETWEEN '1900-01-01' AND '2999-12-31' |
| 9 | ends_on | TEXT | 契約終了日 | 不可 | - | CHECK: length(ends_on)=10 AND ends_on BETWEEN '1900-01-01' AND '2999-12-31' |
| 10 | recoup_basis | TEXT（列挙） | 回収の基礎（platform_net＝PF の控除後、after_fee＝手数料の控除後） | 不可 | - | 値: platform_net / after_fee |
| 11 | platform_rate_bps | INTEGER | PF の率（bp） | 不可 | 0 | CHECK: typeof(platform_rate_bps)='integer' AND platform_rate_bps BETWEEN 0 AND 10000 |
| 12 | agency_fee_bps | INTEGER | 手数料の率（bp） | 可 | - | CHECK: agency_fee_bps IS NULL OR (typeof(agency_fee_bps)='integer' AND agency_fee_bps BETWEEN 0 AND 10000) |
| 13 | overage_enabled | INTEGER（真偽 0/1） | 超過後の分配の有無（空＝未登録で保留） | 可 | - | - |
| 14 | overage_rate_bps | INTEGER | 超過のうち権利元へ払う率（bp） | 可 | - | CHECK: overage_rate_bps IS NULL OR (typeof(overage_rate_bps)='integer' AND overage_rate_bps BETWEEN 0 AND 10000) |
| 15 | pooling | TEXT（列挙） | 回収のまとめ方（all_media＝全媒体まとめて、per_media＝媒体ごとに配分） | 不可 | all_media | 値: all_media / per_media |
| 16 | shortfall_from_other_media | INTEGER（真偽 0/1） | 媒体の不足を他の媒体で埋めてよいか | 不可 | 0 | - |
| 17 | multi_work | TEXT（列挙） | 作品をまたぐときの分け方（single・actual＝実績ベース・hold_until_total＝全体の超過まで分配しない） | 不可 | single | 値: single / actual / hold_until_total |
| 18 | hold_agreement_ref | TEXT | 全体の超過まで分配しない約束の根拠（契約書か合意の記録の参照） | 可 | - | CHECK: hold_agreement_ref IS NULL OR length(trim(hold_agreement_ref)) BETWEEN 1 AND 200 |
| 19 | reason | TEXT | 版を足した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 20 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 21 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, contract_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, contract_id) → acq_mg_contracts(org_id, id)
- CHECK: ends_on>=starts_on
- CHECK: recoup_basis<>'after_fee' OR agency_fee_bps IS NOT NULL
- CHECK: (overage_enabled IS NULL AND overage_rate_bps IS NULL) OR (overage_enabled=0 AND overage_rate_bps IS NULL) OR (overage_enabled=1 AND overage_rate_bps IS NOT NULL)
- CHECK: consideration='mg' OR (overage_enabled=0 AND overage_rate_bps IS NULL)
- CHECK: multi_work<>'hold_until_total' OR hold_agreement_ref IS NOT NULL
- CHECK: pooling='per_media' OR shortfall_from_other_media=0
- トリガー acq_mg_term_versions_no_delete: 削除の前
- トリガー acq_mg_term_versions_no_update: 更新の前
- トリガー acq_mg_term_versions_sequence: 追加の前

## acq_mg_term_works

**支払う MG の対象の作品** — 1行は、条件版の対象の作品1つ。作品ごとの額は、先に決めた契約だけ持つ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 条件版（acq_mg_term_versions） | 不可 | - | PK（複合）、FK（複合）→ acq_mg_term_versions |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | PK（複合）、FK（複合）→ works |
| 4 | preset_amount | INTEGER | 先に決めた作品ごとの額 | 可 | - | CHECK: preset_amount IS NULL OR (typeof(preset_amount)='integer' AND preset_amount BETWEEN 0 AND 9007199254740991) |

表の制約:

- 複合の主キー: (org_id, term_version_id, work_id)
- 複合の参照: (org_id, work_id) → works(org_id, id)
- 複合の参照: (org_id, term_version_id) → acq_mg_term_versions(org_id, id)
- トリガー acq_mg_term_works_no_delete: 削除の前
- トリガー acq_mg_term_works_no_update: 更新の前

## action_steps

**行動のステップ** — 行動のステップの参照表。親の無い行が集計の3つ（面談・提案・契約）で、細目の段（ontology の行動の段）は親を持つ行として種で足す。2段まで。コードと親は足したあと変えない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | code | TEXT | ステップのコード（meeting・proposal・contract と、種で足す細目） | 可 | - | PK、CHECK: length(code) BETWEEN 1 AND 60 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz0123456789_')='' |
| 2 | label | TEXT | ステップの名前 | 不可 | - | CHECK: length(trim(label)) BETWEEN 1 AND 60 |
| 3 | parent_code | TEXT | 畳む先のステップ（action_steps。親の無い行は NULL） | 可 | - | FK → action_steps.code |
| 4 | sort_order | INTEGER | 並び順 | 不可 | - | CHECK: sort_order>=0 |

表の制約:

- CHECK: parent_code IS NULL OR parent_code<>code
- トリガー action_steps_fixed: 更新（code,parent_code）の前
- トリガー action_steps_two_levels: 追加の前

## budget_check_runs

**予算書の検査の結果（回）** — 予算書の版の検査の結果を回ごとに残す（追記だけ）。最新の回が例外ありの版は確定できない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（版と同じ） | 不可 | - | FK（複合）→ budget_versions |
| 4 | version_id | INTEGER | 版（budget_versions） | 不可 | - | FK（複合）→ budget_versions |
| 5 | run_no | INTEGER | 版ごとの回の連番 | 不可 | - | CHECK: typeof(run_no)='integer' AND run_no>0 |
| 6 | verdict | TEXT（列挙） | 判定（draft_ok 例外なし／exceptions 例外あり） | 不可 | - | 値: draft_ok / exceptions |
| 7 | passed | INTEGER | 合った検査の数 | 不可 | - | CHECK: typeof(passed)='integer' AND passed>=0 |
| 8 | failed | INTEGER | 落ちた検査の数（draft_ok は0、exceptions は1以上） | 不可 | - | CHECK: typeof(failed)='integer' AND failed>=0 |
| 9 | checks_json | TEXT | 検査ごとの結果（キー・合否・原本の額・導いた額・セルの位置） | 不可 | - | CHECK: json_valid(checks_json) AND json_type(checks_json)='array' AND length(checks_json) BETWEEN 2 AND 20000 |
| 10 | created_by | INTEGER | 検査した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, version_id, run_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id, version_id) → budget_versions(org_id, project_id, id)
- CHECK: (verdict='draft_ok' AND failed=0) OR (verdict='exceptions' AND failed>0)
- 索引 budget_check_runs_author_idx: (org_id, created_by)
- トリガー budget_check_runs_no_delete: 削除の前
- トリガー budget_check_runs_no_update: 更新の前
- トリガー budget_check_runs_sequence: 追加の前

## budget_fixes

**予算書の確定の記録** — 予算書の版の確定と取り消しの記録（追記だけ）。いまの確定版は最後の行から導く（fix ならその版、void なら確定版なし）。確定は最新の検査が例外なしの版だけ、取り消しはいまの確定版だけ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ budget_versions |
| 4 | seq | INTEGER | 案件ごとの記録の連番 | 不可 | - | CHECK: typeof(seq)='integer' AND seq>0 |
| 5 | action | TEXT（列挙） | fix 確定／void 取り消し | 不可 | - | 値: fix / void |
| 6 | version_id | INTEGER | 確定した版・取り消した版 | 不可 | - | FK（複合）→ budget_versions |
| 7 | reason | TEXT | 理由（必須） | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 8 | created_by | INTEGER | 確定・取り消しをした利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, seq)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id, version_id) → budget_versions(org_id, project_id, id)
- 索引 budget_fixes_author_idx: (org_id, created_by)
- 索引 budget_fixes_version_idx: (org_id, version_id)
- トリガー budget_fixes_no_delete: 削除の前
- トリガー budget_fixes_no_update: 更新の前
- トリガー budget_fixes_requires_clean_check: 追加の前
- トリガー budget_fixes_sequence: 追加の前
- トリガー budget_fixes_void_current: 追加の前

## budget_line_items

**予算書の行の内訳** — 予算書の行の内訳（キャストリストの役ごとなど。追記だけ。確定した版には足せない）。行の金額は内訳の和。役者名・事務所名は持たず、キャスト一覧を参照で指す

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（版と同じ） | 不可 | - | FK（複合）→ budget_versions |
| 4 | version_id | INTEGER | 予算書の版（budget_versions） | 不可 | - | FK（複合）→ budget_version_lines、FK（複合）→ budget_versions |
| 5 | category_code | TEXT（列挙） | 行の区分（A〜K） | 不可 | - | FK（複合）→ budget_version_lines、値: A / B / C / D / E / F / G / H / I / J / K |
| 6 | line_no | INTEGER | 行の区分の中の行番号 | 不可 | - | FK（複合）→ budget_version_lines、CHECK: typeof(line_no)='integer' AND line_no BETWEEN 1 AND 1000 |
| 7 | item_no | INTEGER | 行の中の内訳の番号（1から） | 不可 | - | CHECK: typeof(item_no)='integer' AND item_no BETWEEN 1 AND 500 |
| 8 | breakdown_sheet | TEXT | 内訳のシートの名前（例「キャスト」。xlsx に書き出すときのシート） | 不可 | - | CHECK: length(trim(breakdown_sheet)) BETWEEN 1 AND 31 |
| 9 | label | TEXT | 役名・名目（例「主演」「その他 7役」） | 不可 | - | CHECK: length(trim(label)) BETWEEN 1 AND 200 |
| 10 | qty_milli | INTEGER | 数量・日数（千分の一の整数。任意） | 可 | - | CHECK: qty_milli IS NULL OR (typeof(qty_milli)='integer' AND qty_milli BETWEEN 0 AND 1000000000) |
| 11 | unit_price_yen | INTEGER | 単価・日額（税抜の整数円。任意） | 可 | - | CHECK: unit_price_yen IS NULL OR (typeof(unit_price_yen)='integer' AND unit_price_yen BETWEEN 0 AND 1000000000000) |
| 12 | amount_ex_tax_yen | INTEGER | 金額（税抜の整数円） | 不可 | - | CHECK: typeof(amount_ex_tax_yen)='integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000 |
| 13 | casting_ref | TEXT | キャスト一覧（プリプロ）の参照。役者名・事務所はそちらから表示する | 可 | - | CHECK: casting_ref IS NULL OR length(trim(casting_ref)) BETWEEN 1 AND 80 |
| 14 | source_cell | TEXT | 予算書で読んだセルの位置（例 キャスト!E3） | 可 | - | CHECK: source_cell IS NULL OR length(source_cell) BETWEEN 2 AND 40 |
| 15 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(trim(note)) BETWEEN 1 AND 500 |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, version_id, category_code, line_no, item_no)
- 複合の参照: (org_id, version_id, category_code, line_no) → budget_version_lines(org_id, version_id, category_code, line_no)
- 複合の参照: (org_id, project_id, version_id) → budget_versions(org_id, project_id, id)
- 索引 budget_line_items_version_idx: (org_id, version_id)
- トリガー budget_line_items_fixed: 追加の前
- トリガー budget_line_items_no_delete: 削除の前
- トリガー budget_line_items_no_update: 更新の前

## budget_template_items

**予算書の型の費目** — 予算書の型の版の費目（追記だけ）。区分は A〜K。額は持たず、単価・数量・単位と、内訳を持つ費目の内訳のシートの名前を持つ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | template_version_id | INTEGER | 型の版（budget_template_versions） | 不可 | - | FK（複合）→ budget_template_versions |
| 4 | category_code | TEXT（列挙） | 費目の大分類（A〜K） | 不可 | - | 値: A / B / C / D / E / F / G / H / I / J / K |
| 5 | line_no | INTEGER | 区分の中の行番号（1から） | 不可 | - | CHECK: typeof(line_no)='integer' AND line_no BETWEEN 1 AND 1000 |
| 6 | name | TEXT | 費目名（同じ区分に同じ名前を置かない） | 不可 | - | CHECK: length(trim(name)) BETWEEN 1 AND 200 |
| 7 | unit | TEXT | 単位 | 可 | - | CHECK: unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 20 |
| 8 | unit_price_yen | INTEGER | 既定の単価（税抜の整数円。任意） | 可 | - | CHECK: unit_price_yen IS NULL OR (typeof(unit_price_yen)='integer' AND unit_price_yen BETWEEN 0 AND 1000000000000) |
| 9 | qty_milli | INTEGER | 既定の数量（千分の一の整数。任意） | 可 | - | CHECK: qty_milli IS NULL OR (typeof(qty_milli)='integer' AND qty_milli BETWEEN 0 AND 1000000000) |
| 10 | breakdown_sheet | TEXT | 内訳を持つ費目の内訳のシートの名前（例「キャスト」。内訳の無い費目は空） | 可 | - | CHECK: breakdown_sheet IS NULL OR length(trim(breakdown_sheet)) BETWEEN 1 AND 31 |
| 11 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(trim(note)) BETWEEN 1 AND 500 |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, template_version_id, category_code, line_no)
- 複合の参照: (org_id, template_version_id) → budget_template_versions(org_id, id)
- 索引 budget_template_items_version_idx: (org_id, template_version_id)
- トリガー budget_template_items_no_delete: 削除の前
- トリガー budget_template_items_no_update: 更新の前

## budget_template_versions

**予算書の型（版）** — 予算書の型の版（追記だけ。型ごとの連番）。費目は版ごとに持ち、前の版は残る

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | template_id | INTEGER | 型（budget_templates） | 不可 | - | FK（複合）→ budget_templates |
| 4 | version_no | INTEGER | 型ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | source_kind | TEXT（列挙） | 出どころ（file 予算書 xlsx／budget 案件の予算書の版／screen 画面・型にも足す） | 不可 | - | 値: file / budget / screen |
| 6 | source_file_name | TEXT | 読んだ予算書のファイル名（file のときだけ） | 可 | - | CHECK: source_file_name IS NULL OR length(trim(source_file_name)) BETWEEN 1 AND 240 |
| 7 | source_project_id | INTEGER | もとにした案件（budget のときだけ） | 可 | - | FK（複合）→ budget_versions |
| 8 | source_budget_version_id | INTEGER | もとにした予算書の版（budget のときだけ） | 可 | - | FK（複合）→ budget_versions |
| 9 | reason | TEXT | 版を足した理由（必須） | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 10 | created_by | INTEGER | 版を足した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, template_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, source_project_id, source_budget_version_id) → budget_versions(org_id, project_id, id)
- 複合の参照: (org_id, template_id) → budget_templates(org_id, id)
- CHECK: (source_kind='file' AND source_file_name IS NOT NULL) OR (source_kind<>'file' AND source_file_name IS NULL)
- CHECK: (source_kind='budget' AND source_project_id IS NOT NULL AND source_budget_version_id IS NOT NULL) OR (source_kind<>'budget' AND source_project_id IS NULL AND source_budget_version_id IS NULL)
- 索引 budget_template_versions_author_idx: (org_id, created_by)
- 索引 budget_template_versions_source_idx: (org_id, source_project_id, source_budget_version_id)
- トリガー budget_template_versions_no_delete: 削除の前
- トリガー budget_template_versions_no_update: 更新の前
- トリガー budget_template_versions_sequence: 追加の前

## budget_templates

**予算書の型** — 予算書の型（テンプレ。追記だけ）。組織ごとに名前で区別し、名前は変えない。費目は型の版が持つ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | name | TEXT | 型の名前（組織の中で一意。例「Vシネ 2〜3本撮り」） | 不可 | - | CHECK: length(trim(name)) BETWEEN 1 AND 100 |
| 4 | created_by | INTEGER | 型を作った利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 5 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, name)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 索引 budget_templates_author_idx: (org_id, created_by)
- トリガー budget_templates_no_delete: 削除の前
- トリガー budget_templates_no_update: 更新の前

## budget_version_lines

**予算書の行** — 予算書の版の明細の行（追記だけ。確定した版には足せない）。区分は A〜K の11区分（実費の行と同じコード）。個人名・事務所名は持たない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（版と同じ） | 不可 | - | FK（複合）→ works、FK（複合）→ budget_versions |
| 4 | version_id | INTEGER | 版（budget_versions） | 不可 | - | FK（複合）→ budget_versions |
| 5 | category_code | TEXT（列挙） | 費目の大分類（A 企画費〜K プリント・制作諸費） | 不可 | - | 値: A / B / C / D / E / F / G / H / I / J / K |
| 6 | line_no | INTEGER | 区分の中の行番号（1から） | 不可 | - | CHECK: typeof(line_no)='integer' AND line_no BETWEEN 1 AND 1000 |
| 7 | work_id | INTEGER | 作品（任意。案件の作品だけ） | 可 | - | FK（複合）→ works |
| 8 | department_id | INTEGER | 部署（任意。部署の一覧が入るまで外部キーは無い） | 可 | - | CHECK: department_id IS NULL OR (typeof(department_id)='integer' AND department_id>0) |
| 9 | name | TEXT | 費目名（例「助監督」「食費」）。役割まで書き、個人名は書かない | 不可 | - | CHECK: length(trim(name)) BETWEEN 1 AND 200 |
| 10 | unit_price_yen | INTEGER | 単価（税抜の整数円。一式の行は空） | 可 | - | CHECK: unit_price_yen IS NULL OR (typeof(unit_price_yen)='integer' AND unit_price_yen BETWEEN 0 AND 1000000000000) |
| 11 | qty_milli | INTEGER | 数量（千分の一の整数。2.5 は 2500。一式の行は空） | 可 | - | CHECK: qty_milli IS NULL OR (typeof(qty_milli)='integer' AND qty_milli BETWEEN 0 AND 1000000000) |
| 12 | unit | TEXT | 単位（日・人・式など） | 可 | - | CHECK: unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 20 |
| 13 | amount_ex_tax_yen | INTEGER | 税抜額（整数円。単価×数量と一致しなくてよい） | 不可 | - | CHECK: typeof(amount_ex_tax_yen)='integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000 |
| 14 | confirmed_source | TEXT（列挙） | 確定の印（none 無し／manual 画面で付けた／fill 予算書のセルの黄色から起こした） | 不可 | - | 値: none / manual / fill |
| 15 | payment_month | TEXT | 支払予定月（YYYY-MM。任意。案件収支の予実が月ごとに足して読む） | 可 | - | CHECK: payment_month IS NULL OR (length(payment_month)=7 AND substr(payment_month,5,1)='-' AND ltrim(substr(payment_month,1,4)\|\|substr(payment_month,6,2),'0123456789')='' AND substr(payment_month,6,2) BETWEEN '01' AND '12') |
| 16 | source_cell | TEXT | 予算書で読んだセルの位置（例 B12） | 可 | - | CHECK: source_cell IS NULL OR length(source_cell) BETWEEN 2 AND 12 |
| 17 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(trim(note)) BETWEEN 1 AND 500 |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, version_id, category_code, line_no)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 複合の参照: (org_id, project_id, version_id) → budget_versions(org_id, project_id, id)
- 索引 budget_version_lines_version_idx: (org_id, version_id)
- 索引 budget_version_lines_work_idx: (org_id, project_id, work_id)
- トリガー budget_version_lines_fixed: 追加の前
- トリガー budget_version_lines_no_delete: 削除の前
- トリガー budget_version_lines_no_update: 更新の前

## budget_version_templates

**予算書の版の型** — 予算書の版がどの型の版から作られたか（追記だけ。1つの版に1つまで）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | project_id | INTEGER | 案件（版と同じ） | 不可 | - | FK（複合）→ budget_versions |
| 3 | version_id | INTEGER | 予算書の版（budget_versions） | 不可 | - | PK（複合）、FK（複合）→ budget_versions |
| 4 | template_version_id | INTEGER | もとにした型の版（budget_template_versions） | 不可 | - | FK（複合）→ budget_template_versions |

表の制約:

- 複合の主キー: (org_id, version_id)
- 複合の参照: (org_id, template_version_id) → budget_template_versions(org_id, id)
- 複合の参照: (org_id, project_id, version_id) → budget_versions(org_id, project_id, id)
- 索引 budget_version_templates_template_idx: (org_id, template_version_id)
- トリガー budget_version_templates_no_delete: 削除の前
- トリガー budget_version_templates_no_update: 更新の前

## budget_versions

**予算書（版）** — 案件の予算書の版（追記だけ。変更・削除・同じ番号の入れ直しは DB が断る）。案件ごとの連番。合計の列は持たず、行と制作管理費・予備費（計画）・税率から読むたびに導く。理由は必須

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ budget_versions、FK（複合）→ projects |
| 4 | version_no | INTEGER | 案件ごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | source_kind | TEXT（列挙） | 出どころ（file 予算書 xlsx から／screen 画面で作った／copy 前の版の写し） | 不可 | - | 値: file / screen / copy |
| 6 | source_file_name | TEXT | 読んだ予算書のファイル名（file のときだけ。原本そのものは共通の原本の表が入ってから結ぶ） | 可 | - | CHECK: source_file_name IS NULL OR length(trim(source_file_name)) BETWEEN 1 AND 240 |
| 7 | previous_version_id | INTEGER | もとにした前の版（copy は必須） | 可 | - | FK（複合）→ budget_versions |
| 8 | tax_rate_bps | INTEGER | 消費税率（bps。1000＝10%。総合計に1回だけ掛けて切り捨て） | 不可 | - | CHECK: typeof(tax_rate_bps)='integer' AND tax_rate_bps BETWEEN 0 AND 9999 |
| 9 | management_fee_yen | INTEGER | 制作管理費（税抜の整数円。明細から導けない入力値） | 不可 | - | CHECK: typeof(management_fee_yen)='integer' AND management_fee_yen BETWEEN 0 AND 1000000000000 |
| 10 | contingency_yen | INTEGER | 予備費（計画）（税抜の整数円。制作費の版の制作予備費とは別） | 不可 | - | CHECK: typeof(contingency_yen)='integer' AND contingency_yen BETWEEN 0 AND 1000000000000 |
| 11 | sheet_created_on | TEXT | 予算書に書かれた作成日（YYYY-MM-DD） | 可 | - | CHECK: sheet_created_on IS NULL OR (length(sheet_created_on)=10 AND substr(sheet_created_on,5,1)='-' AND substr(sheet_created_on,8,1)='-' AND ltrim(substr(sheet_created_on,1,4)\|\|substr(sheet_created_on,6,2)\|\|substr(sheet_created_on,9,2),'0123456789')='') |
| 12 | header_notes | TEXT | 予算書の見出しの項目（準備期間・撮影日数・完成の予定・人数）。参考の文で、合計には使わない | 可 | - | CHECK: header_notes IS NULL OR length(header_notes) BETWEEN 1 AND 2000 |
| 13 | title | TEXT | 題（例「ドラフト rev3」） | 可 | - | CHECK: title IS NULL OR length(trim(title)) BETWEEN 1 AND 200 |
| 14 | reason | TEXT | 版を足した理由（必須） | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 15 | created_by | INTEGER | 版を足した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 16 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, version_no)
- 複合の一意: (org_id, project_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id, previous_version_id) → budget_versions(org_id, project_id, id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: (source_kind='file' AND source_file_name IS NOT NULL) OR (source_kind<>'file' AND source_file_name IS NULL)
- CHECK: source_kind<>'copy' OR previous_version_id IS NOT NULL
- 索引 budget_versions_author_idx: (org_id, created_by)
- トリガー budget_versions_no_delete: 削除の前
- トリガー budget_versions_no_update: 更新の前
- トリガー budget_versions_sequence: 追加の前

## cashflow_categories

**入出金の区分** — 案件の入金・出金の区分マスタ（入金4・出金5）。入出金と「売上の元になるか」を区分で決め、金額は正で持って符号は区分で決める。出金は売上の元にならない。移行では行を入れず、組織ごとに種かアプリで足す。入出金と売上の元は足したあと変えない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | code | TEXT | 区分のコード（組織内で一意） | 不可 | - | CHECK: length(code) BETWEEN 1 AND 40 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz0123456789_')='' |
| 4 | label | TEXT | 区分の名前（組織内で一意） | 不可 | - | CHECK: length(trim(label)) BETWEEN 1 AND 60 |
| 5 | direction | TEXT（列挙） | 入出金（in＝入金・out＝出金） | 不可 | - | 値: in / out |
| 6 | counts_as_revenue | INTEGER（真偽 0/1） | 売上の元になるか（1＝なる。出金は 0 だけ） | 不可 | - | - |
| 7 | sort_order | INTEGER | 並び順 | 不可 | 0 | CHECK: sort_order>=0 |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, code)
- 複合の一意: (org_id, label)
- CHECK: direction='in' OR counts_as_revenue=0
- トリガー cashflow_categories_fixed: 更新（org_id,code,direction,counts_as_revenue）の前

## chotatsu_agreements

**調達の合意** — 権利元と合意した試算の版と合意の日（いまはメールの原本を置く）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_estimates |
| 4 | estimate_id | INTEGER | 合意した試算の版 | 不可 | - | FK（複合）→ chotatsu_estimates |
| 5 | agreed_on | TEXT | 合意の日（YYYY-MM-DD） | 不可 | - | CHECK: length(agreed_on)=10 AND substr(agreed_on,5,1)='-' AND substr(agreed_on,8,1)='-' AND ltrim(substr(agreed_on,1,4)\|\|substr(agreed_on,6,2)\|\|substr(agreed_on,9,2),'0123456789')='' |
| 6 | source_document_id | INTEGER | 合意の原本（source_documents） | 可 | - | FK（複合）→ source_documents |
| 7 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, source_document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, case_id, estimate_id) → chotatsu_estimates(org_id, case_id, id)
- 索引 chotatsu_agreements_case_idx: (org_id, case_id)
- トリガー chotatsu_agreements_no_delete: 削除の前
- トリガー chotatsu_agreements_no_update: 更新の前

## chotatsu_case_expenses

**調達の経費の結び付き** — 調達の案件と経費の明細の行（expenses）の結び付き（請求と支払が起きた実績だけ。追記だけ）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_cases |
| 4 | expense_id | INTEGER | 経費の明細の行（expenses） | 不可 | - | FK（複合）→ expenses |
| 5 | estimate_line_id | INTEGER | 対応する試算の見積の行 | 可 | - | FK（複合）→ chotatsu_estimate_lines |
| 6 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, case_id, expense_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, estimate_line_id) → chotatsu_estimate_lines(org_id, id)
- 複合の参照: (org_id, expense_id) → expenses(org_id, id)
- 複合の参照: (org_id, case_id) → chotatsu_cases(org_id, id)
- トリガー chotatsu_case_expenses_no_delete: 削除の前
- トリガー chotatsu_case_expenses_no_update: 更新の前

## chotatsu_case_versions

**調達の案件の版** — 案件の題・権利元・配給・媒体・作品・起点・劇場公開日・提案できる期間・発売予定月と枠の版（追記だけ。最後の版がいま）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_cases |
| 4 | version_no | INTEGER | 案件ごとの版の連番 | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | title | TEXT | 題（仮題可） | 不可 | - | CHECK: length(trim(title)) BETWEEN 1 AND 200 |
| 6 | holder_partner_id | INTEGER | 権利元（partners） | 可 | - | FK（複合）→ partners |
| 7 | distributor_partner_id | INTEGER | 劇場の配給会社（partners） | 可 | - | FK（複合）→ partners |
| 8 | media_family | TEXT（列挙） | 媒体のまとまり（videogram・digital・broadcast・overseas・other） | 不可 | - | 値: videogram / digital / broadcast / overseas / other |
| 9 | work_id | INTEGER | 作品（契約までは空でよい） | 可 | - | FK（複合）→ works |
| 10 | origin | TEXT（列挙） | 起点（self 自分／sales_activity 営業の活動記録） | 不可 | - | 値: self / sales_activity |
| 11 | sales_activity_id | INTEGER | 起点の営業の活動記録（sales_activities） | 可 | - | FK（複合）→ sales_activities |
| 12 | theatrical_release_on | TEXT | 劇場公開日（YYYY-MM-DD） | 可 | - | CHECK: theatrical_release_on IS NULL OR (length(theatrical_release_on)=10 AND substr(theatrical_release_on,5,1)='-' AND substr(theatrical_release_on,8,1)='-' AND ltrim(substr(theatrical_release_on,1,4)\|\|substr(theatrical_release_on,6,2)\|\|substr(theatrical_release_on,9,2),'0123456789')='') |
| 13 | offer_from | TEXT | 提案できる期間の始まり（YYYY-MM-DD） | 可 | - | CHECK: offer_from IS NULL OR (length(offer_from)=10 AND substr(offer_from,5,1)='-' AND substr(offer_from,8,1)='-' AND ltrim(substr(offer_from,1,4)\|\|substr(offer_from,6,2)\|\|substr(offer_from,9,2),'0123456789')='') |
| 14 | offer_until | TEXT | 提案できる期間の終わり（YYYY-MM-DD） | 可 | - | CHECK: offer_until IS NULL OR (length(offer_until)=10 AND substr(offer_until,5,1)='-' AND substr(offer_until,8,1)='-' AND ltrim(substr(offer_until,1,4)\|\|substr(offer_until,6,2)\|\|substr(offer_until,9,2),'0123456789')='') |
| 15 | release_month | TEXT | 発売予定月（YYYY-MM） | 可 | - | CHECK: release_month IS NULL OR (length(release_month)=7 AND substr(release_month,5,1)='-' AND ltrim(substr(release_month,1,4)\|\|substr(release_month,6,2),'0123456789')='' AND substr(release_month,6,2) BETWEEN '01' AND '12') |
| 16 | release_slot | TEXT（列挙） | 発売の枠（day25 25日／first_wed 第1水曜／other） | 可 | - | 値: day25 / first_wed / other |
| 17 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000 |
| 18 | reason | TEXT | 版を足した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 19 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 20 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, case_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, sales_activity_id) → sales_activities(org_id, id)
- 複合の参照: (org_id, work_id) → works(org_id, id)
- 複合の参照: (org_id, distributor_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, holder_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, case_id) → chotatsu_cases(org_id, id)
- CHECK: (origin='self' AND sales_activity_id IS NULL) OR (origin='sales_activity' AND sales_activity_id IS NOT NULL)
- CHECK: offer_from IS NULL OR offer_until IS NULL OR offer_until>=offer_from
- CHECK: release_slot IS NULL OR release_month IS NOT NULL
- 索引 chotatsu_case_versions_case_idx: (org_id, case_id)
- トリガー chotatsu_case_versions_no_delete: 削除の前
- トリガー chotatsu_case_versions_no_update: 更新の前
- トリガー chotatsu_case_versions_sequence: 追加の前

## chotatsu_cases

**調達の案件** — MG を払わずに販売権を調達する1件の芯（番号だけ。変えない）。題・権利元・発売予定などは版に持つ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_code | TEXT | 案件の番号（組織の中で一意。CH-0001 の形） | 不可 | - | CHECK: length(trim(case_code)) BETWEEN 1 AND 40 |
| 4 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 5 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, case_code)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- トリガー chotatsu_cases_no_delete: 削除の前
- トリガー chotatsu_cases_no_update: 更新の前

## chotatsu_contracts

**調達の契約** — 契約の段で作った調達案件（rights_intake_cases。受け方 entrusted）と配給委託の契約（settlement_contracts の commission）を指す

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_cases |
| 4 | intake_case_id | INTEGER | 作った調達案件（rights_intake_cases） | 不可 | - | FK（複合）→ rights_intake_cases |
| 5 | work_id | INTEGER | 作品 | 不可 | - | FK（複合）→ settlement_contracts、FK（複合）→ rights_intake_cases |
| 6 | settlement_contract_id | INTEGER | 作った配給委託の契約（settlement_contracts） | 不可 | - | FK（複合）→ settlement_contracts |
| 7 | signed_on | TEXT | 締結日（YYYY-MM-DD） | 不可 | - | CHECK: length(signed_on)=10 AND substr(signed_on,5,1)='-' AND substr(signed_on,8,1)='-' AND ltrim(substr(signed_on,1,4)\|\|substr(signed_on,6,2)\|\|substr(signed_on,9,2),'0123456789')='' |
| 8 | signed_document_id | INTEGER | 締結版の契約書の原本（source_documents） | 可 | - | FK（複合）→ source_documents |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, intake_case_id)
- 複合の一意: (org_id, settlement_contract_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, signed_document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, settlement_contract_id, work_id) → settlement_contracts(org_id, id, work_id)
- 複合の参照: (org_id, intake_case_id, work_id) → rights_intake_cases(org_id, id, work_id)
- 複合の参照: (org_id, case_id) → chotatsu_cases(org_id, id)
- 索引 chotatsu_contracts_case_idx: (org_id, case_id)
- トリガー chotatsu_contracts_no_delete: 削除の前
- トリガー chotatsu_contracts_no_update: 更新の前

## chotatsu_documents

**調達の原本の結び付き** — 調達の案件と共通の原本の表（source_documents）の結び付き（追記だけ）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_cases |
| 4 | source_document_id | INTEGER | 原本（source_documents） | 不可 | - | FK（複合）→ source_documents |
| 5 | doc_kind | TEXT（列挙） | 原本の種類（estimate・agreement・ringi・contract_draft・contract・materials・other） | 不可 | - | 値: estimate / agreement / ringi / contract_draft / contract / materials / other |
| 6 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, case_id, source_document_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, source_document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, case_id) → chotatsu_cases(org_id, id)
- トリガー chotatsu_documents_no_delete: 削除の前
- トリガー chotatsu_documents_no_update: 更新の前

## chotatsu_estimate_lines

**調達の試算の見積の行** — 試算の版の見積の行（経費の種類で書く。見積は経費の行に入れない）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_estimates |
| 4 | estimate_id | INTEGER | 試算の版 | 不可 | - | FK（複合）→ chotatsu_estimates |
| 5 | line_no | INTEGER | 版の中の行の番号 | 不可 | - | CHECK: typeof(line_no)='integer' AND line_no BETWEEN 1 AND 200 |
| 6 | expense_type | TEXT | 経費の種類（経費管理の一覧と同じ語） | 不可 | - | CHECK: length(trim(expense_type)) BETWEEN 1 AND 60 |
| 7 | name | TEXT | 名前 | 不可 | - | CHECK: length(trim(name)) BETWEEN 1 AND 200 |
| 8 | amount_ex_tax_yen | INTEGER | 額（税抜・円） | 不可 | - | CHECK: typeof(amount_ex_tax_yen)='integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000 |
| 9 | source_document_id | INTEGER | 見積の原本（source_documents） | 可 | - | FK（複合）→ source_documents |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, estimate_id, line_no)
- 複合の参照: (org_id, source_document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, case_id, estimate_id) → chotatsu_estimates(org_id, case_id, id)
- 索引 chotatsu_estimate_lines_estimate_idx: (org_id, estimate_id)
- トリガー chotatsu_estimate_lines_no_delete: 削除の前
- トリガー chotatsu_estimate_lines_no_update: 更新の前

## chotatsu_estimates

**調達の試算の版** — 試算と仕様案（形態・組数・特典・予定価格・1枚の売上・数量の見込み・権利料の条件案・宣伝案）の版（追記だけ）。MG の型は持たない。粗利の見込みは表に持たず計算する

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_cases |
| 4 | version_no | INTEGER | 案件ごとの版の連番 | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | format | TEXT（列挙） | 形態（sell_dvd・sell_bd・sell_dvd_bd・rental_dvd・rental_bd・digital・other） | 不可 | - | 値: sell_dvd / sell_bd / sell_dvd_bd / rental_dvd / rental_bd / digital / other |
| 6 | set_count | INTEGER | 組数 | 不可 | - | CHECK: typeof(set_count)='integer' AND set_count BETWEEN 1 AND 100 |
| 7 | bonus_note | TEXT | 特典 | 可 | - | CHECK: bonus_note IS NULL OR length(trim(bonus_note)) BETWEEN 1 AND 500 |
| 8 | list_price_ex_tax_yen | INTEGER | 予定価格（税抜・円） | 可 | - | CHECK: list_price_ex_tax_yen IS NULL OR (typeof(list_price_ex_tax_yen)='integer' AND list_price_ex_tax_yen BETWEEN 0 AND 1000000000) |
| 9 | unit_revenue_ex_tax_yen | INTEGER | 1枚の当社の売上（税抜・円） | 不可 | - | CHECK: typeof(unit_revenue_ex_tax_yen)='integer' AND unit_revenue_ex_tax_yen BETWEEN 0 AND 1000000000 |
| 10 | quantity | INTEGER | 数量の見込み | 不可 | - | CHECK: typeof(quantity)='integer' AND quantity BETWEEN 0 AND 100000000 |
| 11 | royalty_kind | TEXT（列挙） | 権利料の型（rate 率／per_unit 1枚あたり／none 無し） | 不可 | - | 値: rate / per_unit / none |
| 12 | royalty_rate_bps | INTEGER | 権利料の率（bp） | 可 | - | CHECK: royalty_rate_bps IS NULL OR (typeof(royalty_rate_bps)='integer' AND royalty_rate_bps BETWEEN 0 AND 10000) |
| 13 | royalty_per_unit_yen | INTEGER | 1枚あたりの権利料（円） | 可 | - | CHECK: royalty_per_unit_yen IS NULL OR (typeof(royalty_per_unit_yen)='integer' AND royalty_per_unit_yen BETWEEN 0 AND 1000000000) |
| 14 | promotion_note | TEXT | 宣伝案 | 可 | - | CHECK: promotion_note IS NULL OR length(trim(promotion_note)) BETWEEN 1 AND 2000 |
| 15 | reason | TEXT | 版を足した理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 16 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 17 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, case_id, id)
- 複合の一意: (org_id, case_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, case_id) → chotatsu_cases(org_id, id)
- CHECK: (royalty_kind='rate' AND royalty_rate_bps IS NOT NULL AND royalty_per_unit_yen IS NULL) OR (royalty_kind='per_unit' AND royalty_per_unit_yen IS NOT NULL AND royalty_rate_bps IS NULL) OR (royalty_kind='none' AND royalty_rate_bps IS NULL AND royalty_per_unit_yen IS NULL)
- トリガー chotatsu_estimates_no_delete: 削除の前
- トリガー chotatsu_estimates_no_update: 更新の前
- トリガー chotatsu_estimates_sequence: 追加の前

## chotatsu_handoff_events

**調達から製造への引き渡しの段** — 引き渡しの段（notice 予告 → received 受領、void 取消）の記録（追記だけ）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | handoff_id | INTEGER | 引き渡しの行 | 不可 | - | FK（複合）→ chotatsu_handoffs |
| 4 | seq | INTEGER | 引き渡しごとの連番 | 不可 | - | CHECK: typeof(seq)='integer' AND seq>0 |
| 5 | event | TEXT（列挙） | 段（notice・received・void） | 不可 | - | 値: notice / received / void |
| 6 | reason | TEXT | 理由（取消のときは必須） | 可 | - | CHECK: reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000 |
| 7 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, handoff_id, seq)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, handoff_id) → chotatsu_handoffs(org_id, id)
- CHECK: event<>'void' OR reason IS NOT NULL
- トリガー chotatsu_handoff_events_no_delete: 削除の前
- トリガー chotatsu_handoff_events_no_update: 更新の前
- トリガー chotatsu_handoff_events_order: 追加の前
- トリガー chotatsu_handoff_events_sequence: 追加の前

## chotatsu_handoffs

**調達から製造への引き渡し** — 製造へ渡す行（予告で作る）。作品・調達案件・許された形・地域・権利期間の終わり・試算の版・発売の枠と月。製造は読むだけ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_estimates、FK（複合）→ chotatsu_cases |
| 4 | handoff_no | INTEGER | 案件ごとの連番 | 不可 | - | CHECK: typeof(handoff_no)='integer' AND handoff_no>0 |
| 5 | work_id | INTEGER | 作品 | 不可 | - | FK（複合）→ rights_intake_cases |
| 6 | intake_case_id | INTEGER | 調達案件（rights_intake_cases） | 不可 | - | FK（複合）→ rights_intake_cases |
| 7 | estimate_id | INTEGER | 引き渡す試算の版（仕様案と予定枚数） | 不可 | - | FK（複合）→ chotatsu_estimates |
| 8 | allowed_formats | TEXT | 許された形（JSON の配列） | 不可 | - | CHECK: json_valid(allowed_formats) AND json_type(allowed_formats)='array' AND length(allowed_formats) BETWEEN 2 AND 500 |
| 9 | territory | TEXT | 地域 | 可 | - | CHECK: territory IS NULL OR length(trim(territory)) BETWEEN 1 AND 100 |
| 10 | rights_end | TEXT | 権利期間の終わり（YYYY-MM-DD） | 可 | - | CHECK: rights_end IS NULL OR (length(rights_end)=10 AND substr(rights_end,5,1)='-' AND substr(rights_end,8,1)='-') |
| 11 | release_slot | TEXT（列挙） | 発売の枠（day25・first_wed・other） | 不可 | - | 値: day25 / first_wed / other |
| 12 | release_month | TEXT | 発売予定月（YYYY-MM） | 不可 | - | CHECK: length(release_month)=7 AND substr(release_month,5,1)='-' AND ltrim(substr(release_month,1,4)\|\|substr(release_month,6,2),'0123456789')='' AND substr(release_month,6,2) BETWEEN '01' AND '12' |
| 13 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 14 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, case_id, handoff_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, case_id, estimate_id) → chotatsu_estimates(org_id, case_id, id)
- 複合の参照: (org_id, intake_case_id, work_id) → rights_intake_cases(org_id, id, work_id)
- 複合の参照: (org_id, case_id) → chotatsu_cases(org_id, id)
- トリガー chotatsu_handoffs_no_delete: 削除の前
- トリガー chotatsu_handoffs_no_update: 更新の前
- トリガー chotatsu_handoffs_requires_contract: 追加の前
- トリガー chotatsu_handoffs_sequence: 追加の前

## chotatsu_materials

**調達の素材の受領** — 素材（本編マスター・確認用・予告編・特典映像・音楽素材・メインアート・ロゴ・場面写真・ポスター・作品情報）の受領と検品の記録（追記だけ。種類ごとに最後の行がいま）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_cases |
| 4 | seq | INTEGER | 案件ごとの連番 | 不可 | - | CHECK: typeof(seq)='integer' AND seq>0 |
| 5 | material_kind | TEXT（列挙） | 素材の種類 | 不可 | - | 値: master / preview_copy / trailer / bonus / music / main_art / logo / stills / poster / work_info / other |
| 6 | required | INTEGER（真偽 0/1） | 製造に要るか（1 要る／0 要らない） | 不可 | - | - |
| 7 | received_on | TEXT | 受領日（YYYY-MM-DD） | 可 | - | CHECK: received_on IS NULL OR (length(received_on)=10 AND substr(received_on,5,1)='-' AND substr(received_on,8,1)='-' AND ltrim(substr(received_on,1,4)\|\|substr(received_on,6,2)\|\|substr(received_on,9,2),'0123456789')='') |
| 8 | check_result | TEXT（列挙） | 検品の結果（pending 未・ok 済・ng） | 不可 | - | 値: pending / ok / ng |
| 9 | source_document_id | INTEGER | 素材の原本（source_documents） | 可 | - | FK（複合）→ source_documents |
| 10 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000 |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, case_id, seq)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, source_document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, case_id) → chotatsu_cases(org_id, id)
- CHECK: check_result='pending' OR received_on IS NOT NULL
- トリガー chotatsu_materials_no_delete: 削除の前
- トリガー chotatsu_materials_no_update: 更新の前
- トリガー chotatsu_materials_sequence: 追加の前

## chotatsu_ringi

**調達の稟議** — 販売稟議書の結果（承認・差し戻し・否決）と日、稟議にかけた試算の版。承認の流れは持たない（最後の行がいまの結果）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_estimates |
| 4 | estimate_id | INTEGER | 稟議にかけた試算の版 | 不可 | - | FK（複合）→ chotatsu_estimates |
| 5 | result | TEXT（列挙） | 結果（approved・returned・rejected） | 不可 | - | 値: approved / returned / rejected |
| 6 | result_on | TEXT | 結果の日（YYYY-MM-DD） | 不可 | - | CHECK: length(result_on)=10 AND substr(result_on,5,1)='-' AND substr(result_on,8,1)='-' AND ltrim(substr(result_on,1,4)\|\|substr(result_on,6,2)\|\|substr(result_on,9,2),'0123456789')='' |
| 7 | source_document_id | INTEGER | 稟議書の原本（source_documents） | 可 | - | FK（複合）→ source_documents |
| 8 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000 |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, source_document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, case_id, estimate_id) → chotatsu_estimates(org_id, case_id, id)
- 索引 chotatsu_ringi_case_idx: (org_id, case_id)
- トリガー chotatsu_ringi_no_delete: 削除の前
- トリガー chotatsu_ringi_no_update: 更新の前

## chotatsu_stage_events

**調達の段の出来事** — 見送り（dropped）・MG_買付分へ移した（moved_to_mg）・その取消（void）と、希望の登録（done）の記録（追記だけ）。閉じた案件には取消のほかを足せない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | case_id | INTEGER | 調達の案件 | 不可 | - | FK（複合）→ chotatsu_cases |
| 4 | seq | INTEGER | 案件ごとの連番 | 不可 | - | CHECK: typeof(seq)='integer' AND seq>0 |
| 5 | stage | TEXT（列挙） | 段（wish・estimate・agreement・ringi・contract・materials・handoff） | 不可 | - | 値: wish / estimate / agreement / ringi / contract / materials / handoff |
| 6 | event | TEXT（列挙） | 出来事（done・void・dropped・moved_to_mg） | 不可 | - | 値: done / void / dropped / moved_to_mg |
| 7 | voids_seq | INTEGER | 取り消した出来事の seq（void のとき） | 可 | - | CHECK: voids_seq IS NULL OR (typeof(voids_seq)='integer' AND voids_seq>0) |
| 8 | on_date | TEXT | 出来事の日（YYYY-MM-DD） | 不可 | - | CHECK: length(on_date)=10 AND substr(on_date,5,1)='-' AND substr(on_date,8,1)='-' AND ltrim(substr(on_date,1,4)\|\|substr(on_date,6,2)\|\|substr(on_date,9,2),'0123456789')='' |
| 9 | reason | TEXT | 理由（取消・見送り・移すときは必須） | 可 | - | CHECK: reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000 |
| 10 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, case_id, seq)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, case_id) → chotatsu_cases(org_id, id)
- CHECK: (event='void' AND voids_seq IS NOT NULL AND voids_seq<seq AND reason IS NOT NULL) OR (event<>'void' AND voids_seq IS NULL)
- CHECK: event NOT IN ('dropped','moved_to_mg') OR reason IS NOT NULL
- トリガー chotatsu_stage_events_closed: 追加の前
- トリガー chotatsu_stage_events_no_delete: 削除の前
- トリガー chotatsu_stage_events_no_update: 更新の前
- トリガー chotatsu_stage_events_sequence: 追加の前
- トリガー chotatsu_stage_events_void_target: 追加の前

## contract_production_milestones

**受託制作の契約の支払いの節目** — 受託制作の契約の版の子の行（追記だけ）。連番の順に月初の日が進み、最後の行で割合の和がちょうど 10000 になる（DB のトリガーが断る）。節目ごとの制作費と受託費（純額）は、総製作費と受託費をこの割合で最大剰余法に配って出す（保存しない）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | project_id | INTEGER | 案件（projects） | 不可 | - | PK（複合）、FK（複合）→ contract_production_versions |
| 3 | version_no | INTEGER | 契約の版（contract_production_versions） | 不可 | - | PK（複合）、FK（複合）→ contract_production_versions |
| 4 | seq | INTEGER | 版の中の連番（1から。月の順） | 不可 | - | PK（複合）、CHECK: typeof(seq)='integer' AND seq>0 |
| 5 | due_on | TEXT | 支払いの節目の月（月初の日。YYYY-MM-01） | 不可 | - | CHECK: length(due_on)=10 AND substr(due_on,5,1)='-' AND substr(due_on,8,1)='-' AND ltrim(substr(due_on,1,4)\|\|substr(due_on,6,2),'0123456789')='' AND substr(due_on,6,2) BETWEEN '01' AND '12' AND substr(due_on,9,2)='01' |
| 6 | share_bps | INTEGER | 総製作費のうちこの節目の割合（bp。版の中の和が 10000） | 不可 | - | CHECK: typeof(share_bps)='integer' AND share_bps BETWEEN 1 AND 10000 |

表の制約:

- 複合の主キー: (org_id, project_id, version_no, seq)
- 複合の参照: (org_id, project_id, version_no) → contract_production_versions(org_id, project_id, version_no)
- トリガー contract_production_milestones_count: 追加の前
- トリガー contract_production_milestones_month_order: 追加の前
- トリガー contract_production_milestones_no_delete: 削除の前
- トリガー contract_production_milestones_no_update: 更新の前
- トリガー contract_production_milestones_order: 追加の前
- トリガー contract_production_milestones_share_total: 追加の前

## contract_production_versions

**受託制作の契約（版）** — 型「受託制作」の案件の契約の版（追記だけ。変更・削除は DB が断る）。案件ごとの連番の最新の version_no が有効。総製作費（税別）・受託費率（1000〜1500 bp、既定 1000）と、受託費＝総製作費×受託費率を truncate した整数円を持ち、受託費が式どおりかを表の CHECK で確かめる。受託費は自社の売上で、制作予備費とは別の値。売上の4区分は持たず、案件の型・稼ぎ方・この版から導く（U-9 の答え）。版の番号が最新の次でない書き込み（古い画面）と、型が受託制作でない案件への版は断る

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | project_id | INTEGER | 案件（projects。型は受託制作だけ） | 不可 | - | PK（複合）、FK（複合）→ projects |
| 3 | version_no | INTEGER | 案件ごとの版の連番（1から） | 不可 | - | PK（複合）、CHECK: typeof(version_no)='integer' AND version_no>0 |
| 4 | budget_yen | INTEGER | 総製作費（税別。1円〜1兆円） | 不可 | - | CHECK: typeof(budget_yen)='integer' AND budget_yen BETWEEN 1 AND 1000000000000 |
| 5 | markup_bps | INTEGER | 受託費率（bp。1000〜1500、既定 1000） | 不可 | 1000 | CHECK: typeof(markup_bps)='integer' AND markup_bps BETWEEN 1000 AND 1500 |
| 6 | fee_yen | INTEGER | 受託費（総製作費×受託費率を truncate した整数円） | 不可 | - | - |
| 7 | milestone_count | INTEGER | 支払いの節目の行の数（1〜60） | 不可 | - | CHECK: typeof(milestone_count)='integer' AND milestone_count BETWEEN 1 AND 60 |
| 8 | contract_reference | TEXT | 契約書（PDF）の参照 | 可 | - | CHECK: contract_reference IS NULL OR length(trim(contract_reference)) BETWEEN 1 AND 500 |
| 9 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(note) BETWEEN 1 AND 2000 |
| 10 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, project_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: typeof(fee_yen)='integer' AND fee_yen=budget_yen*markup_bps/10000
- トリガー contract_production_versions_no_delete: 削除の前
- トリガー contract_production_versions_no_update: 更新の前
- トリガー contract_production_versions_project_type: 追加の前
- トリガー contract_production_versions_sequence: 追加の前

## earning_type_rate_versions

**稼ぎ方の既定の売上率（版）** — 組織ごと・稼ぎ方ごとの既定の売上率の版。版を足して残し、最新の version_no が有効。前提の数字なので状態を必ず持つ。移行では行を入れず、種か設定で足す。制作受託（受託の契約の版の率を使う稼ぎ方）には持たない。既定の売上率の置き場はこの表だけで、フェーズ1 #11 の設定の行（variable_key・scope=earning_type）に同じ値を持たせない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合）、FK → organizations.id |
| 2 | earning_type | TEXT | 稼ぎ方（earning_types） | 不可 | - | PK（複合）、FK → earning_types.code |
| 3 | version_no | INTEGER | 組織×稼ぎ方ごとの版の連番 | 不可 | - | PK（複合）、CHECK: version_no>0 |
| 4 | revenue_rate_bps | INTEGER | 既定の売上率（bp） | 不可 | - | CHECK: typeof(revenue_rate_bps)='integer' AND revenue_rate_bps BETWEEN 0 AND 10000 |
| 5 | status | TEXT（列挙） | 状態（confirmed 確認済み・director_reported 監督申告・press_reported 報道値・provisional 仮置き） | 不可 | - | 値: confirmed / director_reported / press_reported / provisional |
| 6 | basis | TEXT | 根拠 | 可 | - | CHECK: basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000 |
| 7 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, earning_type, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- トリガー earning_type_rate_versions_no_delete: 削除の前
- トリガー earning_type_rate_versions_no_update: 更新の前
- トリガー earning_type_rate_versions_project_rate_only: 追加の前
- トリガー earning_type_rate_versions_sequence: 追加の前

## earning_types

**稼ぎ方** — 稼ぎ方の参照表（買付・販売委託・自社出資・製作委員会・制作受託の5つ）。コードの正本で、CHECK にせず行で持つ。案件の型との組・利益の源泉・基準額の中身・使う率の出どころを、要件（案件収支の予実）の対応表どおりに持つ。行は移行で入れ、型との組・利益の源泉・基準額の中身・使う率の出どころは足したあと変えない（トリガー earning_types_fixed。変えるときは移行で）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | code | TEXT | 稼ぎ方のコード（acquisition・consignment・own_investment・committee・contract_work） | 可 | - | PK、CHECK: length(code) BETWEEN 1 AND 40 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz_')='' |
| 2 | label | TEXT | 稼ぎ方の名前 | 不可 | - | Unique、CHECK: length(trim(label)) BETWEEN 1 AND 40 |
| 3 | project_type | TEXT（列挙） | 組になる案件の型（projects.project_type と同じ6つのどれか） | 不可 | - | 値: field_contract / production / acquisition / agency / sw_contract / contract_production |
| 4 | profit_source | INTEGER | 利益の源泉の番号（1 制作受託・2 自社出資・3 製作委員会・4 買付・5 販売委託） | 不可 | - | Unique、CHECK: profit_source>0 |
| 5 | base_amount_kind | TEXT（列挙） | 基準額の中身（rights_revenue＝権利売上の見込み・production_cost＝制作費） | 不可 | - | 値: rights_revenue / production_cost |
| 6 | rate_source | TEXT（列挙） | 使う率の出どころ（project＝案件の売上率か組織の既定・contract＝受託の契約の版の受託費率） | 不可 | - | 値: project / contract |
| 7 | sort_order | INTEGER | 並び順 | 不可 | - | Unique、CHECK: sort_order>=0 |

表の制約:

- トリガー earning_types_fixed: 更新（project_type,profit_source,base_amount_kind,rate_source）の前

## investment_approval_versions

**稟議（版）** — 自社出資の稟議の版（追記だけ。変更・削除・同じ番号の入れ直しは DB が断り、最初の版も消せない）。稼ぎ方が自社出資の案件ごとに稟議の番号を振り、稟議ごとに版の連番を足す。いまの状態（申請中・承認済み・却下・払込）は最新の版から読むたびに導く。版1は申請で、申請のあとは申請し直し・承認・却下、却下のあとは申請し直し、承認と払込のあとは払込だけ。承認と却下の額は直前の申請の額のまま。払込は払った日と額を持ち、承認の前には入れられず、累計は承認の額まで。申請と承認は同じ人でよく、各版の記録した人と日時が残る。払込は会社への利益額が払った月に引き、出資の回収の出資額になる

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | project_id | INTEGER | 案件（projects。稼ぎ方は自社出資だけ） | 不可 | - | PK（複合）、FK（複合）→ projects |
| 3 | approval_no | INTEGER | 案件ごとの稟議の番号（1から） | 不可 | - | PK（複合）、CHECK: typeof(approval_no)='integer' AND approval_no>0 |
| 4 | version_no | INTEGER | 稟議ごとの版の連番（1から。版1は申請） | 不可 | - | PK（複合）、CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | status | TEXT（列挙） | 版の種類（applied 申請・approved 承認・rejected 却下・paid 払込） | 不可 | - | 値: applied / approved / rejected / paid |
| 6 | amount_yen | INTEGER | 額（申請・承認・却下は稟議の出資額、払込はその回に払った額。消費税の不課税の整数円。1円〜1兆円） | 不可 | - | CHECK: typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 1000000000000 |
| 7 | basis_reference | TEXT | 根拠の参照（申請は企画書・試算など、却下は理由。申請と却下では必須） | 可 | - | CHECK: basis_reference IS NULL OR length(trim(basis_reference)) BETWEEN 1 AND 500 |
| 8 | paid_on | TEXT | 払った日（YYYY-MM-DD。払込の版だけ） | 可 | - | CHECK: paid_on IS NULL OR (length(paid_on)=10 AND substr(paid_on,5,1)='-' AND substr(paid_on,8,1)='-' AND ltrim(substr(paid_on,1,4)\|\|substr(paid_on,6,2)\|\|substr(paid_on,9,2),'0123456789')='' AND substr(paid_on,6,2) BETWEEN '01' AND '12' AND substr(paid_on,9,2) BETWEEN '01' AND '31') |
| 9 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000 |
| 10 | created_by | INTEGER | 記録した利用者（memberships。申請者・承認者・払込を記録した人） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, project_id, approval_no, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: version_no>1 OR status='applied'
- CHECK: (status='paid' AND paid_on IS NOT NULL) OR (status<>'paid' AND paid_on IS NULL)
- CHECK: status NOT IN ('applied','rejected') OR basis_reference IS NOT NULL
- トリガー investment_approval_versions_decision_amount: 追加の前
- トリガー investment_approval_versions_no_delete: 削除の前
- トリガー investment_approval_versions_no_update: 更新の前
- トリガー investment_approval_versions_own_investment: 追加の前
- トリガー investment_approval_versions_paid_after_approval: 追加の前
- トリガー investment_approval_versions_paid_total: 追加の前
- トリガー investment_approval_versions_sequence: 追加の前
- トリガー investment_approval_versions_step: 追加の前

## mg_outgoing_contracts

**支払MGの契約** — 1行は、仕入先・権利元へ MG を払う契約（支払MG）1件。条件は条件版（mg_term_versions）で持ち、変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | code | TEXT | 契約コード（組織の中で一意） | 不可 | - | - |
| 4 | title | TEXT | 契約名 | 不可 | - | - |
| 5 | supplier_id | INTEGER | 仕入先・権利元（mg_suppliers） | 不可 | - | FK（複合）→ mg_suppliers |
| 6 | contract_date | TEXT | 契約締結日 | 不可 | - | - |
| 7 | source_reference | TEXT | 契約資料の参照 | 不可 | - | - |
| 8 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, code)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, supplier_id) → mg_suppliers(org_id, id)
- トリガー mg_outgoing_no_delete: 削除の前
- トリガー mg_outgoing_no_update: 更新の前

## mg_suppliers

**MGの仕入先** — 1行は、支払MGの相手（仕入先・権利元）1社。MG契約の画面で登録し、取引先（partners）とは別の ID で持つ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | code | TEXT | 仕入先コード（SUP- で始まる。組織の中で一意） | 不可 | - | CHECK: code GLOB 'SUP-*' |
| 4 | name | TEXT | 仕入先・権利元の名前 | 不可 | - | - |
| 5 | note | TEXT | メモ | 不可 | （空文字） | - |
| 6 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, code)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)

## planning_documents

**企画の原本の結び付き** — 案件と共通の原本（source_documents）の結び付き。種類は企画書・試算・素材。企画書は役（下書き／提出版）と提出先・提出日を持つ。追加のみ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | document_id | INTEGER | 共通の原本（source_documents） | 不可 | - | FK（複合）→ source_documents |
| 5 | kind | TEXT（列挙） | deck 企画書／trial 試算／material 素材 | 不可 | - | 値: deck / trial / material |
| 6 | role | TEXT（列挙） | 企画書の役（draft 下書き／submitted 提出版） | 可 | - | 値: draft / submitted |
| 7 | submitted_to | TEXT | 提出先 | 可 | - | CHECK: submitted_to IS NULL OR length(trim(submitted_to)) BETWEEN 1 AND 200 |
| 8 | submitted_on | TEXT | 提出日（YYYY-MM-DD） | 可 | - | CHECK: submitted_on IS NULL OR (length(submitted_on)=10 AND substr(submitted_on,5,1)='-' AND substr(submitted_on,8,1)='-' AND ltrim(substr(submitted_on,1,4)\|\|substr(submitted_on,6,2)\|\|substr(submitted_on,9,2),'0123456789')='') |
| 9 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(note) BETWEEN 1 AND 1000 |
| 10 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: kind='deck' OR role IS NULL
- CHECK: role='submitted' OR (submitted_to IS NULL AND submitted_on IS NULL)
- CHECK: role IS NULL OR role<>'submitted' OR submitted_on IS NOT NULL
- 索引 planning_documents_author_idx: (org_id, created_by)
- 索引 planning_documents_document_idx: (org_id, document_id)
- 索引 planning_documents_project_idx: (org_id, project_id)
- トリガー planning_documents_no_delete: 削除の前
- トリガー planning_documents_no_update: 更新の前

## planning_facts

**企画の事実（抜き出し）** — 素材から抜き出した事実（AI と壁打ちした下書きと、人が確定した行）。確定は新しい行で前の行を指す（下書きの行は消さない）。結ぶページ（企画書の32枚の番号）で準備ボードの揃いを出す

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ planning_facts、FK（複合）→ planning_materials、FK（複合）→ projects |
| 4 | material_id | INTEGER | 素材（planning_materials） | 可 | - | FK（複合）→ planning_materials |
| 5 | body | TEXT | 事実の文 | 不可 | - | CHECK: length(trim(body)) BETWEEN 1 AND 2000 |
| 6 | value_int | INTEGER | 数値（任意） | 可 | - | CHECK: value_int IS NULL OR typeof(value_int)='integer' |
| 7 | label | TEXT（列挙） | 判定（確・推・不明） | 不可 | - | 値: confirmed / probable / unknown |
| 8 | target | TEXT（列挙） | 入る先（deck_text 企画書の文／trial 試算の前提／team 体制の候補／case 事例） | 不可 | - | 値: deck_text / trial / team / case |
| 9 | pages | TEXT | 結ぶページの番号（カンマ区切り） | 不可 | - | CHECK: length(pages) BETWEEN 1 AND 200 AND ltrim(pages,'0123456789,')='' |
| 10 | state | TEXT（列挙） | ai_draft 下書き／human_confirmed 確定 | 不可 | - | 値: ai_draft / human_confirmed |
| 11 | previous_id | INTEGER | 確定のときに指す下書きの行 | 可 | - | FK（複合）→ planning_facts |
| 12 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 13 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, id)
- 複合の一意: (org_id, previous_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id, previous_id) → planning_facts(org_id, project_id, id)
- 複合の参照: (org_id, project_id, material_id) → planning_materials(org_id, project_id, id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- 索引 planning_facts_author_idx: (org_id, created_by)
- 索引 planning_facts_project_idx: (org_id, project_id)
- トリガー planning_facts_no_delete: 削除の前
- トリガー planning_facts_no_update: 更新の前

## planning_materials

**企画の素材** — 企画書のための素材（類似作・市場・自社の実績・キャスト・監督・世界観の文献・物語の構造・題名・申告）。判定の印（確・推・不明）と出典を持つ。原本があれば共通の原本を指す

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | kind | TEXT（列挙） | 素材の種類 | 不可 | - | 値: similar / market / own_record / cast / director / world / story / title / report / other |
| 5 | title | TEXT | 素材の名前 | 不可 | - | CHECK: length(trim(title)) BETWEEN 1 AND 240 |
| 6 | label | TEXT（列挙） | 判定（confirmed 確／probable 推／unknown 不明） | 不可 | - | 値: confirmed / probable / unknown |
| 7 | source | TEXT | 出典 | 可 | - | CHECK: source IS NULL OR length(trim(source)) BETWEEN 1 AND 1000 |
| 8 | url | TEXT | URL | 可 | - | CHECK: url IS NULL OR (length(url) BETWEEN 8 AND 2000 AND (substr(url,1,8)='https://' OR substr(url,1,7)='http://')) |
| 9 | document_id | INTEGER | 共通の原本（source_documents） | 可 | - | FK（複合）→ source_documents |
| 10 | acquired_on | TEXT | 取得日 | 可 | - | CHECK: acquired_on IS NULL OR (length(acquired_on)=10 AND substr(acquired_on,5,1)='-' AND substr(acquired_on,8,1)='-' AND ltrim(substr(acquired_on,1,4)\|\|substr(acquired_on,6,2)\|\|substr(acquired_on,9,2),'0123456789')='') |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- 索引 planning_materials_author_idx: (org_id, created_by)
- 索引 planning_materials_document_idx: (org_id, document_id)
- トリガー planning_materials_no_delete: 削除の前
- トリガー planning_materials_no_update: 更新の前

## planning_profile_people

**企画の体制の候補** — 企画の項目の版ごとの体制の候補（監督・脚本・主演など）。状態は候補・交渉中・確定。追加のみ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | version_id | INTEGER | 企画の項目の版（planning_profile_versions） | 不可 | - | FK（複合）→ planning_profile_versions |
| 4 | position | INTEGER | 並び | 不可 | - | CHECK: typeof(position)='integer' AND position BETWEEN 1 AND 100 |
| 5 | role | TEXT（列挙） | 役割（director・writer・lead・support・producer・studio・other） | 不可 | - | 値: director / writer / lead / support / producer / studio / other |
| 6 | name | TEXT | 名前 | 不可 | - | CHECK: length(trim(name)) BETWEEN 1 AND 200 |
| 7 | status | TEXT（列挙） | candidate 候補／negotiating 交渉中／confirmed 確定 | 不可 | - | 値: candidate / negotiating / confirmed |

表の制約:

- 複合の一意: (org_id, version_id, position)
- 複合の参照: (org_id, version_id) → planning_profile_versions(org_id, id)
- トリガー planning_profile_people_no_delete: 削除の前
- トリガー planning_profile_people_no_update: 更新の前

## planning_profile_versions

**企画の項目（版）** — 企画の言葉の版（作業題・起点・ログライン・あらすじ・形式・本数・予定の公開年・提出先）。案件ごとの連番で追加のみ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | revision | INTEGER | 案件ごとの版の連番 | 不可 | - | CHECK: typeof(revision)='integer' AND revision>0 |
| 5 | working_title | TEXT | 作業題 | 不可 | - | CHECK: length(trim(working_title)) BETWEEN 1 AND 200 |
| 6 | origin | TEXT（列挙） | 起点（source 原作／cast キャスト／concept コンセプト／sequel 続編／other その他） | 不可 | - | 値: source / cast / concept / sequel / other |
| 7 | logline | TEXT | ログライン | 可 | - | CHECK: logline IS NULL OR length(logline) BETWEEN 1 AND 1000 |
| 8 | synopsis_short | TEXT | あらすじ（短） | 可 | - | CHECK: synopsis_short IS NULL OR length(synopsis_short) BETWEEN 1 AND 1000 |
| 9 | synopsis_long | TEXT | あらすじ（長） | 可 | - | CHECK: synopsis_long IS NULL OR length(synopsis_long) BETWEEN 1 AND 5000 |
| 10 | format | TEXT | 形式 | 可 | - | CHECK: format IS NULL OR length(trim(format)) BETWEEN 1 AND 100 |
| 11 | episode_count | INTEGER | 本数 | 可 | - | CHECK: episode_count IS NULL OR (typeof(episode_count)='integer' AND episode_count BETWEEN 1 AND 1000) |
| 12 | planned_release_year | INTEGER | 予定の公開年（公開前のフォルダは未公開に置き、この年は列に出すだけ） | 可 | - | CHECK: planned_release_year IS NULL OR (typeof(planned_release_year)='integer' AND planned_release_year BETWEEN 1900 AND 2200) |
| 13 | submit_to | TEXT | 提出先 | 可 | - | CHECK: submit_to IS NULL OR length(trim(submit_to)) BETWEEN 1 AND 200 |
| 14 | reason | TEXT | 版の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 15 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 16 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, revision)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- 索引 planning_profile_versions_author_idx: (org_id, created_by)
- トリガー planning_profile_versions_no_delete: 削除の前
- トリガー planning_profile_versions_no_update: 更新の前
- トリガー planning_profile_versions_sequence: 追加の前

## planning_trial_investments

**試算の出資** — 試算の版ごとの出資（出金）の月と額。±0 になる月は最後の出資の月以降で数える

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | version_id | INTEGER | 試算の版 | 不可 | - | FK（複合）→ planning_trial_versions |
| 4 | seq | INTEGER | 連番 | 不可 | - | CHECK: typeof(seq)='integer' AND seq BETWEEN 1 AND 100 |
| 5 | month | TEXT | 出資の月（YYYY-MM） | 不可 | - | CHECK: length(month)=7 AND substr(month,5,1)='-' AND ltrim(substr(month,1,4)\|\|substr(month,6,2),'0123456789')='' AND substr(month,6,2) BETWEEN '01' AND '12' |
| 6 | amount_yen | INTEGER | 額（円） | 不可 | - | CHECK: typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 1000000000000 |

表の制約:

- 複合の一意: (org_id, version_id, seq)
- 複合の参照: (org_id, version_id) → planning_trial_versions(org_id, id)
- トリガー planning_trial_investments_no_delete: 削除の前
- トリガー planning_trial_investments_no_update: 更新の前

## planning_trial_lines

**試算の詳細の行** — 流通の詳細の1行＝1取引先×1窓口。開始月と回収の月数から回収スケジュールを導く。数量か額は even・good・max の3列

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | version_id | INTEGER | 試算の版 | 不可 | - | FK（複合）→ planning_trial_versions |
| 4 | line_no | INTEGER | 行の番号 | 不可 | - | CHECK: typeof(line_no)='integer' AND line_no BETWEEN 1 AND 500 |
| 5 | type_code | TEXT（列挙） | 販売の型 | 不可 | - | 値: THEA / EVNT / PVOD / EST / TVOD / SVOD / AVOD / BIZ / BCST / SELL / RENT / OVS / GOOD |
| 6 | partner_name | TEXT | 取引先（名前） | 不可 | - | CHECK: length(trim(partner_name)) BETWEEN 1 AND 200 |
| 7 | window_label | TEXT | 窓口（独占・先行・開放など） | 可 | - | CHECK: window_label IS NULL OR length(trim(window_label)) BETWEEN 1 AND 100 |
| 8 | start_month | TEXT | 開始月（YYYY-MM） | 不可 | - | CHECK: length(start_month)=7 AND substr(start_month,5,1)='-' AND ltrim(substr(start_month,1,4)\|\|substr(start_month,6,2),'0123456789')='' AND substr(start_month,6,2) BETWEEN '01' AND '12' |
| 9 | months | INTEGER | 回収の月数 | 不可 | - | CHECK: typeof(months)='integer' AND months BETWEEN 1 AND 120 |
| 10 | calc | TEXT（列挙） | unit 単価×数量／fixed 固定額 | 不可 | - | 値: unit / fixed |
| 11 | unit_price_yen | INTEGER | 単価（円） | 不可 | - | CHECK: typeof(unit_price_yen)='integer' AND unit_price_yen BETWEEN 0 AND 100000000 |
| 12 | even_value | INTEGER | even の数量か額 | 不可 | - | CHECK: typeof(even_value)='integer' AND even_value BETWEEN 0 AND 1000000000000 |
| 13 | good_value | INTEGER | good の数量か額 | 不可 | - | CHECK: typeof(good_value)='integer' AND good_value BETWEEN 0 AND 1000000000000 |
| 14 | max_value | INTEGER | MAX の数量か額 | 不可 | - | CHECK: typeof(max_value)='integer' AND max_value BETWEEN 0 AND 1000000000000 |
| 15 | source | TEXT | 出典 | 可 | - | CHECK: source IS NULL OR length(trim(source)) BETWEEN 1 AND 200 |
| 16 | previous_sales_yen | INTEGER | 前作実績の売上（円） | 可 | - | CHECK: previous_sales_yen IS NULL OR (typeof(previous_sales_yen)='integer' AND previous_sales_yen BETWEEN 0 AND 1000000000000) |

表の制約:

- 複合の一意: (org_id, version_id, line_no)
- 複合の参照: (org_id, version_id) → planning_trial_versions(org_id, id)
- CHECK: calc='fixed' OR unit_price_yen>0
- トリガー planning_trial_lines_no_delete: 削除の前
- トリガー planning_trial_lines_no_update: 更新の前

## planning_trial_rates

**試算の率** — 試算の版ごとの、販売の型ごとの率と単価（先方の取り分・窓口とライツの手数料・原作の印税・監督と脚本の印税・製造単価）。根拠の数字は版ごとに変えられる

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | version_id | INTEGER | 試算の版 | 不可 | - | FK（複合）→ planning_trial_versions |
| 4 | type_code | TEXT（列挙） | 販売の型（THEA 劇場配給・EVNT イベント上映・PVOD・EST・TVOD・SVOD・AVOD・BIZ 業務用・BCST 放送・SELL セル・RENT レンタル・OVS 海外・GOOD 商品化） | 不可 | - | 値: THEA / EVNT / PVOD / EST / TVOD / SVOD / AVOD / BIZ / BCST / SELL / RENT / OVS / GOOD |
| 5 | share_bps | INTEGER | 先方の取り分（劇場・PF・仕切り）の率（bp） | 不可 | - | CHECK: typeof(share_bps)='integer' AND share_bps BETWEEN 0 AND 10000 |
| 6 | fee_bps | INTEGER | 窓口・ライツ手数料の率（bp） | 不可 | - | CHECK: typeof(fee_bps)='integer' AND fee_bps BETWEEN 0 AND 10000 |
| 7 | original_royalty_bps | INTEGER | 原作の印税の率（bp） | 不可 | - | CHECK: typeof(original_royalty_bps)='integer' AND original_royalty_bps BETWEEN 0 AND 10000 |
| 8 | creator_royalty_bps | INTEGER | 監督・脚本の印税の率（bp。作り手への印税） | 不可 | - | CHECK: typeof(creator_royalty_bps)='integer' AND creator_royalty_bps BETWEEN 0 AND 10000 |
| 9 | unit_cost_yen | INTEGER | 製造単価（1枚・円） | 不可 | - | CHECK: typeof(unit_cost_yen)='integer' AND unit_cost_yen BETWEEN 0 AND 100000000 |
| 10 | source | TEXT | 出典 | 可 | - | CHECK: source IS NULL OR length(trim(source)) BETWEEN 1 AND 200 |

表の制約:

- 複合の一意: (org_id, version_id, type_code)
- 複合の参照: (org_id, version_id) → planning_trial_versions(org_id, id)
- CHECK: fee_bps+original_royalty_bps+creator_royalty_bps<=10000
- トリガー planning_trial_rates_no_delete: 削除の前
- トリガー planning_trial_rates_no_update: 更新の前

## planning_trial_versions

**試算（版）** — 売上試算の3段の型（表紙→流通の大別→流通の詳細）の版。持つのは入力だけで、売上・権利元収入・回収率・±0 の月は保存せず毎回計算する。案件ごとの連番で追加のみ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | revision | INTEGER | 案件ごとの版の連番 | 不可 | - | CHECK: typeof(revision)='integer' AND revision>0 |
| 5 | cost_total_yen | INTEGER | 製作費（税抜・円） | 不可 | - | CHECK: typeof(cost_total_yen)='integer' AND cost_total_yen BETWEEN 0 AND 1000000000000 |
| 6 | first_month | TEXT | 回収スケジュールの起点の月（YYYY-MM） | 不可 | - | CHECK: length(first_month)=7 AND substr(first_month,5,1)='-' AND ltrim(substr(first_month,1,4)\|\|substr(first_month,6,2),'0123456789')='' AND substr(first_month,6,2) BETWEEN '01' AND '12' |
| 7 | source_kind | TEXT（列挙） | screen 画面／template 型から／copy 写し／file 原本から | 不可 | - | 値: screen / template / copy / file |
| 8 | document_id | INTEGER | 読んだ原本（source_documents） | 可 | - | FK（複合）→ source_documents |
| 9 | reason | TEXT | 版の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 10 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, revision)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, document_id) → source_documents(org_id, id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: (source_kind='file' AND document_id IS NOT NULL) OR source_kind<>'file'
- 索引 planning_trial_versions_author_idx: (org_id, created_by)
- 索引 planning_trial_versions_document_idx: (org_id, document_id)
- トリガー planning_trial_versions_no_delete: 削除の前
- トリガー planning_trial_versions_no_update: 更新の前
- トリガー planning_trial_versions_sequence: 追加の前

## produce_task_checks

**進行表のチェック項目** — チケットのチェック項目（追記だけ）。入れる・外すたびに同じ check_uid で行を足し、最新の行が有効

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | task_uid | INTEGER | チケットの番号（版を通して同じ。組織の中で一意） | 不可 | - | CHECK: typeof(task_uid)='integer' AND task_uid>0 |
| 5 | check_uid | INTEGER | チケットの中のチェック項目の番号 | 不可 | - | CHECK: typeof(check_uid)='integer' AND check_uid>0 |
| 6 | label | TEXT | チェック項目の文 | 不可 | - | CHECK: length(trim(label)) BETWEEN 1 AND 200 |
| 7 | checked | INTEGER（真偽 0/1） | チェックが入っているか（1） | 不可 | - | - |
| 8 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- 索引 produce_task_checks_author_idx: (org_id, created_by)
- 索引 produce_task_checks_task_idx: (org_id, project_id, task_uid, check_uid)
- トリガー produce_task_checks_no_delete: 削除の前
- トリガー produce_task_checks_no_update: 更新の前
- トリガー produce_task_checks_task: 追加の前

## produce_task_events

**進行表の着手・完了の記録** — チケットの着手・完了・戻すの記録（追記だけ）。完了は最後の完了が最後の戻すより後のとき

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | task_uid | INTEGER | チケットの番号（版を通して同じ。組織の中で一意） | 不可 | - | CHECK: typeof(task_uid)='integer' AND task_uid>0 |
| 5 | kind | TEXT（列挙） | 記録の種類（started 着手／done 完了／reopened 完了を戻す） | 不可 | - | 値: started / done / reopened |
| 6 | on_date | TEXT | その日（YYYY-MM-DD） | 不可 | - | CHECK: length(on_date)=10 AND substr(on_date,5,1)='-' AND substr(on_date,8,1)='-' AND ltrim(substr(on_date,1,4)\|\|substr(on_date,6,2)\|\|substr(on_date,9,2),'0123456789')='' |
| 7 | note | TEXT | ひとこと（任意） | 可 | - | CHECK: note IS NULL OR length(trim(note)) BETWEEN 1 AND 500 |
| 8 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- 索引 produce_task_events_author_idx: (org_id, created_by)
- 索引 produce_task_events_task_idx: (org_id, project_id, task_uid)
- トリガー produce_task_events_no_delete: 削除の前
- トリガー produce_task_events_no_update: 更新の前
- トリガー produce_task_events_task: 追加の前

## produce_task_links

**進行表の関連する場所** — チケットから移る業務の画面・書類へのリンク（追記だけ。写しは持たない）。外すのは removed=1 の行

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | task_uid | INTEGER | チケットの番号（版を通して同じ。組織の中で一意） | 不可 | - | CHECK: typeof(task_uid)='integer' AND task_uid>0 |
| 5 | link_uid | INTEGER | チケットの中のリンクの番号 | 不可 | - | CHECK: typeof(link_uid)='integer' AND link_uid>0 |
| 6 | label | TEXT | リンクの名前 | 不可 | - | CHECK: length(trim(label)) BETWEEN 1 AND 120 |
| 7 | target | TEXT | リンク先（?p= で始まる画面か https:// の場所） | 不可 | - | CHECK: length(trim(target)) BETWEEN 1 AND 500 |
| 8 | is_fallback | INTEGER（真偽 0/1） | 仮の書類か（1。スクリプター記録が無いときのコンテなど） | 不可 | 0 | - |
| 9 | removed | INTEGER（真偽 0/1） | 外した行（1） | 不可 | 0 | - |
| 10 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- 索引 produce_task_links_author_idx: (org_id, created_by)
- 索引 produce_task_links_task_idx: (org_id, project_id, task_uid, link_uid)
- トリガー produce_task_links_no_delete: 削除の前
- トリガー produce_task_links_no_update: 更新の前
- トリガー produce_task_links_task: 追加の前

## produce_task_posts

**進行表の掲示板** — チケットの掲示板の書き込み（追記だけ。直すときは新しい書き込みで書く）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | task_uid | INTEGER | チケットの番号（版を通して同じ。組織の中で一意） | 不可 | - | CHECK: typeof(task_uid)='integer' AND task_uid>0 |
| 5 | speaker_label | TEXT | 発言者の呼び名（P・監督・編集など。利用者のアカウントではない） | 不可 | - | CHECK: length(trim(speaker_label)) BETWEEN 1 AND 40 |
| 6 | body | TEXT | 書き込み | 不可 | - | CHECK: length(trim(body)) BETWEEN 1 AND 2000 |
| 7 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- 索引 produce_task_posts_author_idx: (org_id, created_by)
- 索引 produce_task_posts_task_idx: (org_id, project_id, task_uid)
- トリガー produce_task_posts_no_delete: 削除の前
- トリガー produce_task_posts_no_update: 更新の前
- トリガー produce_task_posts_task: 追加の前

## produce_task_template_items

**進行表のテンプレートの行** — テンプレートの版の行（追記だけ）。起点からの日数で持つ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | template_id | INTEGER | テンプレートの版（produce_task_templates） | 不可 | - | FK（複合）→ produce_task_templates |
| 4 | sort_no | INTEGER | 並び順（1から） | 不可 | - | CHECK: typeof(sort_no)='integer' AND sort_no BETWEEN 1 AND 500 |
| 5 | kind | TEXT（列挙） | 種類（work・check・milestone） | 不可 | - | 値: work / check / milestone |
| 6 | phase | TEXT（列挙） | 段（チケットと同じ6つ） | 不可 | - | 値: script / prep / shoot / post / delivery / finance |
| 7 | title | TEXT | 名前 | 不可 | - | CHECK: length(trim(title)) BETWEEN 1 AND 120 |
| 8 | role | TEXT（列挙） | 役（producer・line_producer） | 不可 | - | 値: producer / line_producer |
| 9 | checkers | TEXT | チェックする人の呼び名（任意） | 可 | - | CHECK: checkers IS NULL OR length(trim(checkers)) BETWEEN 1 AND 200 |
| 10 | start_offset_days | INTEGER | 起点からの開始の日数 | 不可 | - | CHECK: typeof(start_offset_days)='integer' AND start_offset_days BETWEEN -3650 AND 3650 |
| 11 | end_offset_days | INTEGER | 起点からの終了の日数 | 不可 | - | CHECK: typeof(end_offset_days)='integer' AND end_offset_days BETWEEN -3650 AND 3650 |
| 12 | milestone_code | TEXT（列挙） | 節目のコード（任意） | 可 | - | 値: kikaku_go / crank_in / crank_up / edit_lock / sound_mix / first_print / final_screening / release / delivery |
| 13 | links_json | TEXT | 既定の関連する場所（JSON の配列） | 不可 | [] | CHECK: json_valid(links_json) AND json_type(links_json)='array' AND length(links_json)<=4000 |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, template_id, sort_no)
- 複合の参照: (org_id, template_id) → produce_task_templates(org_id, id)
- CHECK: end_offset_days>=start_offset_days
- CHECK: kind<>'milestone' OR end_offset_days=start_offset_days
- 索引 produce_task_template_items_template_idx: (org_id, template_id)
- トリガー produce_task_template_items_no_delete: 削除の前
- トリガー produce_task_template_items_no_update: 更新の前

## produce_task_templates

**進行表のテンプレート（版）** — 組織で使い回す進行表のテンプレートの版（追記だけ）。標準の進行はコードの定数に持ち、ここには利用者が残したものだけが入る

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | template_uid | INTEGER | テンプレートの番号（版を通して同じ） | 不可 | - | CHECK: typeof(template_uid)='integer' AND template_uid>0 |
| 4 | version_no | INTEGER | テンプレートごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 5 | name | TEXT | テンプレートの名前 | 不可 | - | CHECK: length(trim(name)) BETWEEN 1 AND 120 |
| 6 | anchor_kind | TEXT（列挙） | 起点（crank_in クランクイン／project_start 最初の開始日） | 不可 | - | 値: crank_in / project_start |
| 7 | retired | INTEGER（真偽 0/1） | やめた版（1） | 不可 | 0 | - |
| 8 | reason | TEXT | 直した理由（2版目から必須） | 可 | - | CHECK: reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500 |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, template_uid, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- CHECK: version_no=1 OR reason IS NOT NULL
- 索引 produce_task_templates_author_idx: (org_id, created_by)
- トリガー produce_task_templates_no_delete: 削除の前
- トリガー produce_task_templates_no_update: 更新の前
- トリガー produce_task_templates_sequence: 追加の前

## produce_tasks

**進行表のチケット（版）** — 進行表のチケットの版（追記だけ）。直すたびに同じ task_uid で版を足し、最新の版が有効。やめたものは retired=1 の版。状態の列は持たず、予定と記録から導く

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works、FK（複合）→ projects |
| 4 | work_id | INTEGER | 作品（任意。案件の作品だけ） | 可 | - | FK（複合）→ works |
| 5 | task_uid | INTEGER | チケットの番号（版を通して同じ。組織の中で一意） | 不可 | - | CHECK: typeof(task_uid)='integer' AND task_uid>0 |
| 6 | version_no | INTEGER | チケットごとの版の連番（1から） | 不可 | - | CHECK: typeof(version_no)='integer' AND version_no>0 |
| 7 | kind | TEXT（列挙） | 種類（work 作業／check チェック期間／milestone 節目。節目は1日） | 不可 | - | 値: work / check / milestone |
| 8 | phase | TEXT（列挙） | 段（script 企画・脚本／prep 準備／shoot 撮影／post ポスプロ／delivery 完成・納品／finance 資金・契約） | 不可 | - | 値: script / prep / shoot / post / delivery / finance |
| 9 | title | TEXT | チケットの名前 | 不可 | - | CHECK: length(trim(title)) BETWEEN 1 AND 120 |
| 10 | role | TEXT（列挙） | 役（producer P／line_producer LP） | 不可 | - | 値: producer / line_producer |
| 11 | assignee_label | TEXT | 担当の呼び名（任意。利用者のアカウントではない） | 可 | - | CHECK: assignee_label IS NULL OR length(trim(assignee_label)) BETWEEN 1 AND 60 |
| 12 | checkers | TEXT | チェックする人の呼び名（チェック期間のとき。・で区切る） | 可 | - | CHECK: checkers IS NULL OR length(trim(checkers)) BETWEEN 1 AND 200 |
| 13 | planned_start | TEXT | 予定の開始日（YYYY-MM-DD） | 不可 | - | CHECK: length(planned_start)=10 AND substr(planned_start,5,1)='-' AND substr(planned_start,8,1)='-' AND ltrim(substr(planned_start,1,4)\|\|substr(planned_start,6,2)\|\|substr(planned_start,9,2),'0123456789')='' |
| 14 | planned_end | TEXT | 予定の終了日（YYYY-MM-DD。節目は開始と同じ） | 不可 | - | CHECK: length(planned_end)=10 AND substr(planned_end,5,1)='-' AND substr(planned_end,8,1)='-' AND ltrim(substr(planned_end,1,4)\|\|substr(planned_end,6,2)\|\|substr(planned_end,9,2),'0123456789')='' |
| 15 | milestone_code | TEXT（列挙） | 節目のコード（任意。初号・納品などは上の箱の日数に使う） | 可 | - | 値: kikaku_go / crank_in / crank_up / edit_lock / sound_mix / first_print / final_screening / release / delivery |
| 16 | template_label | TEXT | 作ったテンプレートの名前（自分で足したチケットは空） | 可 | - | CHECK: template_label IS NULL OR length(trim(template_label)) BETWEEN 1 AND 120 |
| 17 | retired | INTEGER（真偽 0/1） | やめた版（1） | 不可 | 0 | - |
| 18 | reason | TEXT | 直した理由（2版目から必須） | 可 | - | CHECK: reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500 |
| 19 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 20 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, task_uid, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: planned_end>=planned_start
- CHECK: kind<>'milestone' OR planned_end=planned_start
- CHECK: version_no=1 OR reason IS NOT NULL
- 索引 produce_tasks_author_idx: (org_id, created_by)
- 索引 produce_tasks_project_idx: (org_id, project_id, task_uid)
- 索引 produce_tasks_work_idx: (org_id, project_id, work_id)
- トリガー produce_tasks_no_delete: 削除の前
- トリガー produce_tasks_no_update: 更新の前
- トリガー produce_tasks_same_project: 追加の前
- トリガー produce_tasks_sequence: 追加の前

## project_owner_versions

**案件の担当者（版）** — 案件の担当者（利用者）の版。担当を替えるときは版を足す。今の担当は開始日が今日以前の最新の版。予実が「担当の案件」を読む

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | revision | INTEGER | 案件ごとの版の連番 | 不可 | - | CHECK: typeof(revision)='integer' AND revision>0 |
| 5 | user_id | INTEGER | 担当者（memberships） | 不可 | - | FK（複合）→ memberships |
| 6 | started_on | TEXT | 担当の開始日 | 不可 | - | CHECK: length(started_on)=10 AND substr(started_on,5,1)='-' AND substr(started_on,8,1)='-' AND ltrim(substr(started_on,1,4)\|\|substr(started_on,6,2)\|\|substr(started_on,9,2),'0123456789')='' |
| 7 | reason | TEXT | 理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 8 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, revision)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, user_id) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- 索引 project_owner_versions_author_idx: (org_id, created_by)
- 索引 project_owner_versions_user_idx: (org_id, user_id)
- トリガー project_owner_versions_no_delete: 削除の前
- トリガー project_owner_versions_no_update: 更新の前
- トリガー project_owner_versions_sequence: 追加の前

## project_stage_events

**案件の段階の履歴** — 案件の段階を変えた記録（追記だけ。変更・削除は DB が断る）。案件ごとの連番の最新の行が、いまの段階。前の段階は直前の行の段階と同じでなければ断り、入った日は直前の行より前にしない。見送りに入るときは理由が要る

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | seq | INTEGER | 案件ごとの連番（1から） | 不可 | - | CHECK: seq>0 |
| 5 | stage_code | TEXT | 入った段階（project_stages） | 不可 | - | FK → project_stages.code |
| 6 | previous_stage_code | TEXT | 前の段階（project_stages。最初の行は NULL） | 可 | - | FK → project_stages.code |
| 7 | entered_on | TEXT | その段階に入った日（YYYY-MM-DD） | 不可 | - | CHECK: length(entered_on)=10 AND substr(entered_on,5,1)='-' AND substr(entered_on,8,1)='-' AND ltrim(substr(entered_on,1,4)\|\|substr(entered_on,6,2)\|\|substr(entered_on,9,2),'0123456789')='' AND substr(entered_on,6,2) BETWEEN '01' AND '12' AND substr(entered_on,9,2) BETWEEN '01' AND '31' |
| 8 | evidence | TEXT | 言質（相手が言ったこと） | 可 | - | CHECK: evidence IS NULL OR length(trim(evidence)) BETWEEN 1 AND 1000 |
| 9 | reason | TEXT | 理由（見送りでは必須） | 可 | - | CHECK: reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000 |
| 10 | created_by | INTEGER | 記録した利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, project_id, seq)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- CHECK: previous_stage_code IS NULL OR previous_stage_code<>stage_code
- トリガー project_stage_events_date_order: 追加の前
- トリガー project_stage_events_no_delete: 削除の前
- トリガー project_stage_events_no_update: 更新の前
- トリガー project_stage_events_reason: 追加の前
- トリガー project_stage_events_stale: 追加の前

## project_stage_meanings

**案件の段階の稼ぎ方ごとの意味** — 段階ごとの、稼ぎ方ごとの意味（営業ヨミ表のステータス表の稼ぎ方の列）。行は種で足す

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | stage_code | TEXT | 段階（project_stages） | 不可 | - | PK（複合）、FK → project_stages.code |
| 2 | earning_type | TEXT | 稼ぎ方（earning_types） | 不可 | - | PK（複合）、FK → earning_types.code |
| 3 | meaning | TEXT | その稼ぎ方での段階の意味 | 不可 | - | CHECK: length(trim(meaning)) BETWEEN 1 AND 500 |

表の制約:

- 複合の主キー: (stage_code, earning_type)

## project_stages

**案件の段階** — 案件の段階の参照表（10段階＋見送り。営業ヨミ表の型）。確度は段階から導き、案件に手で入れさせない。行は移行で入れ、確度・ステップ・理由の要否は足したあと変えない（トリガー project_stages_fixed。変えるときは移行で）

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | code | TEXT | 段階のコード | 可 | - | PK、CHECK: length(code) BETWEEN 1 AND 40 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz_')='' |
| 2 | label | TEXT | 段階の名前 | 不可 | - | Unique、CHECK: length(trim(label)) BETWEEN 1 AND 40 |
| 3 | yomi | INTEGER | 営業ヨミ表の番号（1〜10。見送りは NULL） | 可 | - | Unique、CHECK: yomi IS NULL OR yomi>0 |
| 4 | probability_bps | INTEGER | 確度（bp。見送り 0・企画メモ 1000 〜 契約済み 10000） | 不可 | - | CHECK: typeof(probability_bps)='integer' AND probability_bps BETWEEN 0 AND 10000 |
| 5 | definition | TEXT | 段階の定義（共通） | 不可 | - | CHECK: length(trim(definition)) BETWEEN 1 AND 500 |
| 6 | step_code | TEXT | 対応する行動のステップ（action_steps。面談済み・提案済み・契約済みだけ） | 可 | - | FK → action_steps.code |
| 7 | requires_reason | INTEGER（真偽 0/1） | 入るときに理由が要る段階か（1＝見送り） | 不可 | 0 | - |
| 8 | sort_order | INTEGER | 並び順 | 不可 | - | Unique、CHECK: sort_order>=0 |

表の制約:

- トリガー project_stages_fixed: 更新（probability_bps,step_code,requires_reason）の前

## projects

**案件** — 案件1件。作品は案件にぶら下がる（作品を持たない案件もある）。案件の画面や一括登録で作り、作ったあとに書き換える画面・API は無い。予算は財務の権限がある人だけが見られる。型・稼ぎ方・基準額・売上率・相手などは移行0012で足した列で、既存の案件は NULL（未登録）のまま。足した列は既存の案件の API（bootstrap・/api/projects）が返さない。段階は段階の履歴の最新の行から、確度は段階から導くので列に持たない

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | code | TEXT | 案件コード（組織内で一意） | 不可 | - | - |
| 4 | title | TEXT | 案件名 | 不可 | - | - |
| 5 | status | TEXT（列挙） | 状態（企画中・進行中・完了・休止中の4つ） | 不可 | planning | 値: planning / active / complete / paused |
| 6 | budget_yen | INTEGER | 予算（円）。税込か税抜かは未確認 | 可 | - | CHECK: budget_yen IS NULL OR budget_yen>=0 |
| 7 | version | INTEGER | 行の版。いまは案件を書き換える経路が無いので、1のまま | 不可 | 1 | - |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |
| 9 | project_type | TEXT（列挙） | 案件の型（現場受託・製作・買付・受託配給・受託開発・受託制作の6つ。ontology の案件の型）。登録のあと変えない。NULL は未登録の既存の案件 | 可 | - | 値: field_contract / production / acquisition / agency / sw_contract / contract_production |
| 10 | earning_type | TEXT | 稼ぎ方（earning_types）。型と対応表の組だけを許す。現場受託・受託開発の型は持たない | 可 | - | FK → earning_types.code |
| 11 | base_amount_yen | INTEGER | 基準額（円・税別）。中身は稼ぎ方で決まる（制作受託は総製作費、ほかは権利売上の見込み） | 可 | - | CHECK: base_amount_yen IS NULL OR (typeof(base_amount_yen)='integer' AND base_amount_yen BETWEEN 0 AND 9007199254740991) |
| 12 | revenue_rate_bps | INTEGER | 案件の売上率（bp）。空なら稼ぎ方の既定の売上率（earning_type_rate_versions の最新の版）。制作受託は持たない（受託の契約の版の受託費率を使う） | 可 | - | CHECK: revenue_rate_bps IS NULL OR (typeof(revenue_rate_bps)='integer' AND revenue_rate_bps BETWEEN 0 AND 10000) |
| 13 | counterparty_name | TEXT | 相手（取引先・発注元・権利元）の名前 | 可 | - | CHECK: counterparty_name IS NULL OR length(trim(counterparty_name)) BETWEEN 1 AND 200 |
| 14 | key_person | TEXT | キーパーソン | 可 | - | CHECK: key_person IS NULL OR length(trim(key_person)) BETWEEN 1 AND 200 |
| 15 | started_on | TEXT | 始めた日（YYYY-MM-DD） | 可 | - | CHECK: started_on IS NULL OR (length(started_on)=10 AND substr(started_on,5,1)='-' AND substr(started_on,8,1)='-' AND ltrim(substr(started_on,1,4)\|\|substr(started_on,6,2)\|\|substr(started_on,9,2),'0123456789')='' AND substr(started_on,6,2) BETWEEN '01' AND '12' AND substr(started_on,9,2) BETWEEN '01' AND '31') |
| 16 | planning_folder | TEXT | 企画フォルダ（参照の文字） | 可 | - | CHECK: planning_folder IS NULL OR length(trim(planning_folder)) BETWEEN 1 AND 500 |
| 17 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(note) BETWEEN 1 AND 2000 |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, code)
- トリガー projects_earning_type_insert: 追加の前
- トリガー projects_earning_type_update: 更新（project_type,earning_type,revenue_rate_bps）の前
- トリガー projects_revenue_rate_insert: 追加の前
- トリガー projects_revenue_rate_update: 更新（project_type,earning_type,revenue_rate_bps）の前
- トリガー projects_sw_contract_has_no_works: 更新（project_type,earning_type,revenue_rate_bps）の前
- トリガー projects_type_fixed: 更新（project_type,earning_type,revenue_rate_bps）の前

## rights_intake_cases

**権利の調達ケース** — 作品の権利をどう調達したか（製作委員会・単独保有・権利受託）の下書き1件。改訂は新しい行を足し、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ rights_intake_cases、FK（複合）→ works |
| 5 | case_code | TEXT | ケースコード（組織内で一意） | 不可 | - | - |
| 6 | title | TEXT | ケースの名前 | 不可 | - | - |
| 7 | intake_type | TEXT（列挙） | 調達の入口（製作委員会・単独保有・権利受託） | 不可 | - | 値: committee / sole_owned / entrusted |
| 8 | source_case_id | INTEGER | 改訂元のケース（rights_intake_cases） | 可 | - | FK（複合）→ rights_intake_cases |
| 9 | snapshot_version | INTEGER | 改訂の版番号。改訂するたびに1つ進む | 不可 | 1 | CHECK: snapshot_version>0 |
| 10 | status | TEXT | 状態。いまは draft（下書き）だけ | 不可 | draft | CHECK: status='draft' |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, id, work_id)
- 複合の一意: (org_id, case_code)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, source_case_id, work_id) → rights_intake_cases(org_id, id, work_id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- トリガー rights_intake_case_immutable: 更新の前

## rights_intake_documents

**調達の契約書参照** — 調達ケースの元になる契約書の参照1件（名前・参照先・版）。ケースと同時に作り、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | intake_case_id | INTEGER | 調達ケース（rights_intake_cases） | 不可 | - | FK（複合）→ rights_intake_cases |
| 4 | title | TEXT | 契約書の名前 | 可 | - | - |
| 5 | reference | TEXT | 契約書の参照先（1000字まで） | 可 | - | - |
| 6 | version_label | TEXT | 契約書の版の表示 | 可 | - | - |
| 7 | content_hash | TEXT | 契約書の SHA-256（64桁。空も可） | 可 | - | - |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, intake_case_id) → rights_intake_cases(org_id, id)
- 索引 rights_intake_documents_case_uidx: (org_id, intake_case_id, id) 一意
- トリガー rights_intake_document_immutable: 更新の前

## rights_intake_participants

**調達の参加者** — 調達ケースの参加者1件（自社か取引先、役割・出資額・持分）。ケースと同時に作り、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | intake_case_id | INTEGER | 調達ケース（rights_intake_cases） | 不可 | - | FK（複合）→ rights_intake_cases |
| 4 | party_kind | TEXT（列挙） | 参加者の種類。current_org＝自社、partner＝取引先 | 不可 | - | 値: current_org / partner |
| 5 | partner_id | INTEGER | 取引先（partners）。自社なら空 | 可 | - | FK（複合）→ partners |
| 6 | role | TEXT | 役割（自由記述） | 可 | - | - |
| 7 | investment_yen | INTEGER | 出資額（円） | 可 | - | CHECK: investment_yen IS NULL OR investment_yen>=0 |
| 8 | explicit_share_bps | INTEGER | 契約に書かれた持分（bps。10000＝100%） | 可 | - | CHECK: explicit_share_bps IS NULL OR explicit_share_bps BETWEEN 0 AND 10000 |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, intake_case_id) → rights_intake_cases(org_id, id)
- CHECK: (party_kind='current_org' AND partner_id IS NULL) OR party_kind='partner'
- トリガー rights_intake_participant_immutable: 更新の前

## rights_intake_scopes

**調達した権利の範囲** — 調達ケースで得た権利の範囲1件（流通・地域・期間・独占か）。ケースと同時に作り、書き換えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | intake_case_id | INTEGER | 調達ケース（rights_intake_cases） | 不可 | - | FK（複合）→ rights_intake_cases |
| 4 | channel | TEXT | 流通（自由記述） | 可 | - | - |
| 5 | territory | TEXT | 地域（自由記述） | 可 | - | - |
| 6 | rights_start | TEXT | 権利期間の開始日 | 可 | - | - |
| 7 | rights_end | TEXT | 権利期間の終了日 | 可 | - | - |
| 8 | exclusivity | TEXT（列挙） | 独占か（独占・非独占・未確認） | 可 | - | 値: exclusive / nonexclusive / unknown |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, intake_case_id) → rights_intake_cases(org_id, id)
- CHECK: rights_end IS NULL OR rights_start IS NULL OR rights_end>=rights_start
- トリガー rights_intake_scope_immutable: 更新の前

## works

**作品** — 作品1本。案件にぶら下がり、売上・経費・契約などが作品を参照する。作品の画面や一括登録で作る。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ projects |
| 4 | code | TEXT | 作品コード（組織内で一意） | 不可 | - | - |
| 5 | title | TEXT | 作品名 | 不可 | - | - |
| 6 | format | TEXT | 形式。画面の選択肢は film＝映画、series＝シリーズ（DB では値を制限しない） | 不可 | film | - |
| 7 | forecast_yen | INTEGER | 売上見込（円）。税込か税抜かは未確認 | 可 | - | CHECK: forecast_yen IS NULL OR forecast_yen>=0 |
| 8 | version | INTEGER | 行の版。更新のたびに1つ進み、同時の更新を見つける | 不可 | 1 | - |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, project_id, id)
- 複合の一意: (org_id, code)
- 複合の参照: (org_id, project_id) → projects(org_id, id)
- トリガー works_not_under_sw_contract_insert: 追加の前
- トリガー works_not_under_sw_contract_update: 更新（project_id）の前
