<!-- 生成物。直さない。正本は DB の定義（src/**/*.sql）と docs/database/dictionary.json。作り直しは node scripts/build-db-docs.mjs -->
# 精算（settlement）の表

[目次へ戻る](README.md)

## ER 図

```mermaid
erDiagram
  committee_contracts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "作品（works）"
    INTEGER intake_case_id FK "製作委員会の調達ケース（rights_intake_cases）"
    INTEGER document_id FK "元の契約書の参照（rights_intake_documents）"
  }
  committee_report_previews {
    TEXT token PK "確認の鍵（行のID。保存のときに照合する）"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "作品（works）"
  }
  committee_report_snapshots {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "作品（works）"
    INTEGER contract_id FK "製作委員会の契約（committee_contracts）"
    INTEGER term_version_id FK "使った条件版（committee_term_versions）"
  }
  committee_schedule_phases {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id FK "委員会の条件版（committee_term_versions）"
  }
  committee_snapshot_deductions {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER snapshot_id PK, FK "委員会報告の保存版（committee_report_snapshots）"
    INTEGER work_id FK "作品（works）"
    INTEGER report_id FK "元の売上報告。保存版に含めた報告（committee_snapshot_reports）に限り、窓口も一致させる"
    INTEGER window_id FK "販路の窓口（committee_term_windows）"
    INTEGER recipient_partner_id FK "受取先（partners）。製作費回収は委員会の参加者"
    TEXT source_reference PK "根拠の識別番号（作品の中で一意）"
  }
  committee_snapshot_expenses {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER snapshot_id PK, FK "委員会報告の下書き（committee_report_snapshots）"
    INTEGER work_id FK "作品（works）"
    INTEGER expense_id PK, FK "経費（expenses）"
    INTEGER window_id FK "経費を控除した窓口（committee_term_windows）"
  }
  committee_snapshot_lines {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER snapshot_id PK, FK "委員会報告の下書き（committee_report_snapshots）"
    INTEGER work_id PK, FK "作品（works）"
    INTEGER report_id FK "売上報告（report_imports）"
    INTEGER sale_id PK, FK "売上明細（sale_lines）"
    INTEGER window_id FK "当てはめた窓口（committee_term_windows）"
  }
  committee_snapshot_member_amounts {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER snapshot_id PK, FK "委員会報告の下書き（committee_report_snapshots）"
    INTEGER window_id PK, FK "窓口（committee_term_windows）"
    INTEGER partner_id PK, FK "参加者の取引先（partners）"
  }
  committee_snapshot_reports {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER snapshot_id PK, FK "委員会報告の下書き（committee_report_snapshots）"
    INTEGER work_id FK "作品（works）"
    INTEGER report_id PK, FK "売上報告（report_imports）"
    INTEGER window_id FK "当てはめた窓口（committee_term_windows）"
  }
  committee_term_funding {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "製作委員会の条件版（committee_term_versions）"
  }
  committee_term_investments {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "製作委員会の条件版（committee_term_versions）"
    INTEGER partner_id PK, FK "出資する参加者（partners。committee_term_members）"
  }
  committee_term_members {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id FK "委員会の条件版（committee_term_versions）"
    INTEGER partner_id FK "参加者の取引先（partners）"
  }
  committee_term_version_effective {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "製作委員会の条件版（committee_term_versions）"
  }
  committee_term_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "製作委員会契約（committee_contracts）"
    INTEGER source_version_id FK "コピー元の条件版（committee_term_versions）"
    INTEGER manager_partner_id FK "幹事会社の取引先（partners）"
  }
  committee_term_window_fee_shares {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER window_id PK, FK "販路の窓口（committee_term_windows）"
    INTEGER partner_id PK, FK "取り分を受け取る会社（partners）"
  }
  committee_term_windows {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id FK "委員会の条件版（committee_term_versions）"
    INTEGER window_partner_id FK "窓口の取引先（partners。参加者から選ぶ）"
  }
  intake_settlement_links {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER intake_case_id PK, FK "調達ケース（rights_intake_cases）"
    INTEGER work_id FK "作品（works）。ケースと契約で同じ作品"
    INTEGER settlement_contract_id PK, FK "分配契約（settlement_contracts）"
  }
  joint_business_holidays {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER contract_id PK, FK "共同製作の契約（joint_committee_contracts）"
    TEXT holiday_on PK "休日"
  }
  joint_committee_contracts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER work_id FK "作品（works）"
    INTEGER manager_partner_id FK "幹事（partners）。出資者の1社"
    INTEGER producer_partner_id FK "受託制作会社（partners）。委員会の外"
  }
  joint_committee_costs {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "共同製作の契約（joint_committee_contracts）"
    INTEGER window_id FK "窓口（joint_committee_windows）。直接経費と音楽使用料だけ"
    INTEGER period_sequence FK "分配期の番号（joint_committee_periods）"
  }
  joint_committee_members {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER contract_id PK, FK "共同製作の契約（joint_committee_contracts）"
    INTEGER partner_id PK, FK "出資者（partners）"
  }
  joint_committee_periods {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER contract_id PK, FK "共同製作の契約（joint_committee_contracts）"
    INTEGER sequence PK "期の番号（1から）"
  }
  joint_committee_sales {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "共同製作の契約（joint_committee_contracts）"
    INTEGER window_id FK "窓口（joint_committee_windows）"
    INTEGER period_sequence FK "分配期の番号（joint_committee_periods）"
  }
  joint_committee_snapshots {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "共同製作の契約（joint_committee_contracts）"
  }
  joint_committee_windows {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "共同製作の契約（joint_committee_contracts）"
    INTEGER partner_id FK "窓口担当の出資者（partners）"
  }
  joint_funding_events {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "共同製作の契約（joint_committee_contracts）"
    INTEGER partner_id FK "出資者（joint_committee_members）"
    INTEGER milestone_id FK "充当のもとの製作費支払（joint_production_milestones）"
  }
  joint_production_milestones {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "共同製作の契約（joint_committee_contracts）"
    INTEGER producer_partner_id FK "受託制作会社（partners）"
  }
  mg_contract_links {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER incoming_contract_id FK "受取MGの契約（mg_incoming_contracts）"
    INTEGER outgoing_contract_id FK "支払MGの契約（mg_outgoing_contracts）"
  }
  mg_incoming_contracts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER partner_id FK "販売先（partners）"
  }
  mg_ledger_entries {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id FK "MGの条件版（mg_version_products と組で参照）"
    INTEGER product_id FK "商品（products）"
    INTEGER reverses_entry_id FK "訂正元の報告（mg_ledger_entries）。この行で置き換える"
  }
  mg_term_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER incoming_contract_id FK "受取MGの契約（mg_incoming_contracts）。どちらか片方"
    INTEGER outgoing_contract_id FK "支払MGの契約（mg_outgoing_contracts）。どちらか片方"
  }
  mg_version_phases {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id FK "MGの条件版（mg_term_versions）"
  }
  mg_version_products {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "MGの条件版（mg_term_versions）"
    INTEGER product_id PK, FK "商品（products）"
  }
  rights_payment_events {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER settlement_contract_id FK "個別精算の契約（settlement_contracts）。どちらか片方"
    INTEGER committee_snapshot_id FK "委員会報告の保存版（committee_report_snapshots）"
    INTEGER partner_id FK "支払先（partners）。契約の権利者か報告の参加者"
    INTEGER reverses_event_id FK "取り消す支払（rights_payment_events）"
  }
  royalty_agreements {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "作品の案件（projects）。work_id と組で作品を指す"
    INTEGER work_id FK "作品（works）"
    INTEGER holder_partner_id FK "権利者（partners）。報告書と支払の相手"
  }
  royalty_irregular_entries {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER holder_partner_id FK "権利者（partners）"
    INTEGER agreement_id FK "ロイヤリティ契約（royalty_agreements）。調整と記録は空でもよい"
    INTEGER reverses_entry_id FK "取り消す記録（royalty_irregular_entries）"
  }
  royalty_manual_accruals {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER agreement_id FK "ロイヤリティ契約（royalty_agreements）"
    INTEGER reverses_entry_id FK "取り消す元の行（royalty_manual_accruals）"
  }
  royalty_schedule_phases {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER schedule_version_id FK "サイクルの版（royalty_schedule_versions）"
  }
  royalty_schedule_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER agreement_id FK "ロイヤリティ契約（royalty_agreements）"
  }
  royalty_statement_calculation_parts {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER statement_id PK, FK "報告書（royalty_statements）"
    INTEGER part_no PK "分割の番号。1から順"
  }
  royalty_statement_events {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER statement_id FK "報告書（royalty_statements）"
    INTEGER reverses_event_id FK "取り消す記録（royalty_statement_events）"
  }
  royalty_statement_lines {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER statement_id FK "報告書（royalty_statements）"
    INTEGER agreement_id FK "ロイヤリティ契約（royalty_agreements）"
    INTEGER term_version_id FK "使った条件版（royalty_term_versions）"
    INTEGER irregular_entry_id FK "もとのイレギュラー（royalty_irregular_entries）"
  }
  royalty_statement_voids {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER statement_id FK "取り消した報告書（royalty_statements）"
  }
  royalty_statements {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER holder_partner_id FK "権利者（partners）"
    INTEGER previous_statement_id FK "前の確定版（royalty_statements）。繰越の引き継ぎ元"
  }
  royalty_term_channels {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "条件版（royalty_term_versions）"
    TEXT channel_group PK "対象の流通（劇場・レンタル・セル・配信・放送・海外・その他）"
  }
  royalty_term_expense_categories {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER term_version_id PK, FK "条件版（royalty_term_versions）。経費を引く基礎の版だけ"
    TEXT category PK "差し引く経費の費目名"
  }
  royalty_term_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER agreement_id FK "ロイヤリティ契約（royalty_agreements）"
  }
  settlement_contracts {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER project_id FK "案件（projects）"
    INTEGER work_id FK "作品（works）"
    INTEGER holder_partner_id FK "権利元の取引先（partners）。自社権利型は空"
  }
  settlement_report_links {
    INTEGER org_id PK, FK "組織（organizations）。データの持ち主"
    INTEGER report_id PK, FK "売上報告（report_imports）"
    INTEGER work_id PK, FK "作品（works）"
    INTEGER contract_id FK "分配契約（settlement_contracts）"
    INTEGER term_version_id FK "使う条件版（settlement_term_versions）"
  }
  settlement_term_versions {
    INTEGER id PK "行のID"
    INTEGER org_id FK "組織（organizations）。データの持ち主"
    INTEGER contract_id FK "分配契約（settlement_contracts）"
  }
  committee_contracts }o--|| rights_intake_documents : "intake_case_id,document_id"
  committee_contracts }o--|| rights_intake_cases : "intake_case_id,work_id"
  committee_contracts }o--|| works : "project_id,work_id"
  committee_report_previews }o--|| works : "project_id,work_id"
  committee_report_snapshots }o--|| committee_term_versions : "contract_id,term_version_id"
  committee_report_snapshots }o--|| committee_contracts : "contract_id,work_id"
  committee_report_snapshots }o--|| works : "project_id,work_id"
  committee_schedule_phases }o--|| committee_term_versions : "term_version_id"
  committee_snapshot_deductions }o--|| partners : "recipient_partner_id"
  committee_snapshot_deductions }o--|| committee_term_windows : "window_id"
  committee_snapshot_deductions }o--|| committee_snapshot_reports : "snapshot_id,report_id"
  committee_snapshot_deductions }o--|| committee_report_snapshots : "snapshot_id,work_id"
  committee_snapshot_expenses }o--|| committee_term_windows : "window_id"
  committee_snapshot_expenses }o--|| expenses : "expense_id"
  committee_snapshot_expenses }o--|| committee_report_snapshots : "snapshot_id,work_id"
  committee_snapshot_lines }o--|| committee_term_windows : "window_id"
  committee_snapshot_lines }o--|| sale_lines : "sale_id"
  committee_snapshot_lines }o--|| report_imports : "report_id"
  committee_snapshot_lines }o--|| committee_report_snapshots : "snapshot_id,work_id"
  committee_snapshot_member_amounts }o--|| partners : "partner_id"
  committee_snapshot_member_amounts }o--|| committee_term_windows : "window_id"
  committee_snapshot_member_amounts }o--|| committee_report_snapshots : "snapshot_id"
  committee_snapshot_reports }o--|| committee_term_windows : "window_id"
  committee_snapshot_reports }o--|| report_imports : "report_id"
  committee_snapshot_reports }o--|| committee_report_snapshots : "snapshot_id,work_id"
  committee_term_funding }o--|| committee_term_versions : "term_version_id"
  committee_term_investments }o--|| committee_term_members : "term_version_id,partner_id"
  committee_term_members }o--|| partners : "partner_id"
  committee_term_members }o--|| committee_term_versions : "term_version_id"
  committee_term_version_effective }o--|| committee_term_versions : "term_version_id"
  committee_term_versions }o--o| partners : "manager_partner_id"
  committee_term_versions }o--o| committee_term_versions : "contract_id,source_version_id"
  committee_term_versions }o--|| committee_contracts : "contract_id"
  committee_term_window_fee_shares }o--|| partners : "partner_id"
  committee_term_window_fee_shares }o--|| committee_term_windows : "window_id"
  committee_term_windows }o--|| partners : "window_partner_id"
  committee_term_windows }o--|| committee_term_versions : "term_version_id"
  intake_settlement_links }o--|| settlement_contracts : "settlement_contract_id,work_id"
  intake_settlement_links }o--|| rights_intake_cases : "intake_case_id,work_id"
  joint_business_holidays }o--|| joint_committee_contracts : "contract_id"
  joint_committee_contracts }o--|| partners : "producer_partner_id"
  joint_committee_contracts }o--|| partners : "manager_partner_id"
  joint_committee_contracts }o--|| works : "work_id"
  joint_committee_costs }o--o| joint_committee_windows : "contract_id,window_id"
  joint_committee_costs }o--|| joint_committee_periods : "contract_id,period_sequence"
  joint_committee_members }o--|| partners : "partner_id"
  joint_committee_members }o--|| joint_committee_contracts : "contract_id"
  joint_committee_periods }o--|| joint_committee_contracts : "contract_id"
  joint_committee_sales }o--|| joint_committee_windows : "contract_id,window_id"
  joint_committee_sales }o--|| joint_committee_periods : "contract_id,period_sequence"
  joint_committee_snapshots }o--|| joint_committee_contracts : "contract_id"
  joint_committee_windows }o--|| partners : "partner_id"
  joint_committee_windows }o--|| joint_committee_contracts : "contract_id"
  joint_funding_events }o--o| joint_production_milestones : "milestone_id"
  joint_funding_events }o--|| joint_committee_members : "contract_id,partner_id"
  joint_production_milestones }o--|| partners : "producer_partner_id"
  joint_production_milestones }o--|| joint_committee_contracts : "contract_id"
  mg_contract_links }o--|| mg_outgoing_contracts : "outgoing_contract_id"
  mg_contract_links }o--|| mg_incoming_contracts : "incoming_contract_id"
  mg_incoming_contracts }o--|| partners : "partner_id"
  mg_ledger_entries }o--o| mg_ledger_entries : "reverses_entry_id"
  mg_ledger_entries }o--|| mg_version_products : "term_version_id,product_id"
  mg_term_versions }o--o| mg_outgoing_contracts : "outgoing_contract_id"
  mg_term_versions }o--o| mg_incoming_contracts : "incoming_contract_id"
  mg_version_phases }o--|| mg_term_versions : "term_version_id"
  mg_version_products }o--|| products : "product_id"
  mg_version_products }o--|| mg_term_versions : "term_version_id"
  rights_payment_events }o--o| rights_payment_events : "reverses_event_id"
  rights_payment_events }o--|| partners : "partner_id"
  rights_payment_events }o--o| committee_report_snapshots : "committee_snapshot_id"
  rights_payment_events }o--o| settlement_contracts : "settlement_contract_id"
  royalty_agreements }o--|| partners : "holder_partner_id"
  royalty_agreements }o--|| works : "project_id,work_id"
  royalty_irregular_entries }o--o| royalty_irregular_entries : "reverses_entry_id"
  royalty_irregular_entries }o--o| royalty_agreements : "agreement_id"
  royalty_irregular_entries }o--|| partners : "holder_partner_id"
  royalty_manual_accruals }o--o| royalty_manual_accruals : "reverses_entry_id"
  royalty_manual_accruals }o--|| royalty_agreements : "agreement_id"
  royalty_schedule_phases }o--|| royalty_schedule_versions : "schedule_version_id"
  royalty_schedule_versions }o--|| royalty_agreements : "agreement_id"
  royalty_statement_calculation_parts }o--|| royalty_statements : "statement_id"
  royalty_statement_events }o--o| royalty_statement_events : "reverses_event_id"
  royalty_statement_events }o--|| royalty_statements : "statement_id"
  royalty_statement_lines }o--o| royalty_irregular_entries : "irregular_entry_id"
  royalty_statement_lines }o--o| royalty_term_versions : "term_version_id"
  royalty_statement_lines }o--o| royalty_agreements : "agreement_id"
  royalty_statement_lines }o--|| royalty_statements : "statement_id"
  royalty_statement_voids }o--|| royalty_statements : "statement_id"
  royalty_statements }o--o| royalty_statements : "previous_statement_id"
  royalty_statements }o--|| partners : "holder_partner_id"
  royalty_term_channels }o--|| royalty_term_versions : "term_version_id"
  royalty_term_expense_categories }o--|| royalty_term_versions : "term_version_id"
  royalty_term_versions }o--|| royalty_agreements : "agreement_id"
  settlement_contracts }o--o| partners : "holder_partner_id"
  settlement_contracts }o--|| works : "project_id,work_id"
  settlement_report_links }o--|| settlement_term_versions : "contract_id,term_version_id"
  settlement_report_links }o--|| settlement_contracts : "contract_id,work_id"
  settlement_report_links }o--|| works : "work_id"
  settlement_report_links }o--|| report_imports : "report_id"
  settlement_term_versions }o--|| settlement_contracts : "contract_id"
```

主キーと参照の列だけを載せる。組織（organizations・memberships）への参照は省く。

## 表の一覧

| 表 | 論理名 | 説明 |
|---|---|---|
| [committee_contracts](#committee_contracts) | 製作委員会契約 | 製作委員会の契約1件。製作委員会の調達ケースと契約書の参照から作り、書き換えない。条件は条件版に持つ。 |
| [committee_report_previews](#committee_report_previews) | 委員会報告の保存前確認 | 委員会報告を保存する前の確認1回分を表す。確認画面で計算したときに作り、15分で期限が切れ、保存に使うと consumed を1にする。期限切れの行は、次に確認を作るときに消す。 |
| [committee_report_snapshots](#committee_report_snapshots) | 委員会報告の下書き | 製作委員会の1つの締め期間の報告の下書き1件を表す。確認画面の計算を保存したときに作り、入力と計算結果を入力の照合値とともに固定して変えられない。 |
| [committee_schedule_phases](#committee_schedule_phases) | 委員会の報告・支払日程 | 委員会の条件版ごとに、締め・報告・支払の日程の区切り（フェーズ）1つを表す。フェーズは隙間なく続き、ここから締め期間を数える。 |
| [committee_snapshot_deductions](#committee_snapshot_deductions) | 委員会報告の追加控除 | 1行は、委員会報告を保存するとき、手数料と経費を引いた後で差し引く追加の控除1件（権利処理費か製作費回収）。変更・削除はできない。 |
| [committee_snapshot_expenses](#committee_snapshot_expenses) | 委員会報告の経費 | 委員会報告の下書きで控除した経費1件を表す。1つの経費は1度しか使えず、保存時に作って変えられない。 |
| [committee_snapshot_lines](#committee_snapshot_lines) | 委員会報告の明細 | 委員会報告の下書きに入れた売上明細1行を、作品への配賦後の額で表す。保存時に作り、変えられない。 |
| [committee_snapshot_member_amounts](#committee_snapshot_member_amounts) | 委員会報告の分配額 | 委員会報告の下書きで、窓口ごと・参加者ごとに計算した分配額を表す。保存時に作り、変えられない。 |
| [committee_snapshot_reports](#committee_snapshot_reports) | 委員会報告に含めた売上報告 | 委員会報告の下書きに含めた売上報告1件と、当てはめた窓口を表す。1つの報告は作品ごとに1度しか使えず、個別精算（settlement_report_links）にも使えない。 |
| [committee_term_funding](#committee_term_funding) | 委員会の製作費総額 | 1行は、製作委員会の条件版に付ける製作費の総額。契約で確定したときだけ条件版と一緒に入れ、製作費回収の上限に使う。変更・削除はできない。 |
| [committee_term_investments](#committee_term_investments) | 委員会の出資額 | 1行は、製作委員会の条件版の参加者1社の出資額。製作費の総額と一緒に入れ、合計は製作費の総額と一致させる。変更・削除はできない。 |
| [committee_term_members](#committee_term_members) | 委員会の参加者（条件版） | 製作委員会の条件版ごとの参加者1者と持分を表す。条件版の登録時に調達案件の参加者から写して作り、あとから変えられない。 |
| [committee_term_version_effective](#committee_term_version_effective) | 委員会条件版の適用開始月 | 1行は、製作委員会の条件版の適用開始月。条件版の表に列を足せないため別の表に持つ。行の無い条件版は最初の月から効く。変更・削除はできない。 |
| [committee_term_versions](#committee_term_versions) | 委員会契約の条件版 | 製作委員会契約の条件の版1件。改訂は新しい版を足し、書き換えない。メンバー・窓口・日程は版ごとに別の表に持つ。 |
| [committee_term_window_fee_shares](#committee_term_window_fee_shares) | 窓口手数料の取り分 | 1行は、製作委員会の販路の窓口の窓口手数料を複数社で分けるときの1社の取り分。行が無い窓口は、窓口の受取先1社が全部を受け取る。変更・削除はできない。 |
| [committee_term_windows](#committee_term_windows) | 委員会の販路窓口 | 委員会の条件版ごと・販路の種類ごとに、窓口の取引先と手数料の条件を1行で表す。条件版の登録時に作り、変えられない。 |
| [intake_settlement_links](#intake_settlement_links) | 調達と分配契約の関連 | 調達ケースと分配契約の関連1件。分配契約を作るときか調達の画面でつなぎ、書き換えない。1つの契約につながるケースは1つ。 |
| [joint_business_holidays](#joint_business_holidays) | 共同製作の休日 | 1行は、共同製作の契約で使う休日1日。窓口の送金予定日が休日にあたるとき、前の営業日にずらすのに使う。 |
| [joint_committee_contracts](#joint_committee_contracts) | 共同製作の委員会契約 | 1行は、共同製作（入金基準）の製作委員会の契約条件。いまは架空データの投入スクリプトだけが書き、画面からは作れない。変更・削除はできない。 |
| [joint_committee_costs](#joint_committee_costs) | 共同製作の費用 | 1行は、共同製作の委員会の費用1件（窓口の直接経費・音楽使用料・権利処理費・原盤管理費・立替返済）。承認済みの費用だけを入れる。変更・削除はできない。 |
| [joint_committee_members](#joint_committee_members) | 共同製作の出資者 | 1行は、共同製作の委員会の出資者1社と、その持分・出資予定額。計算は出資者2社・持分の合計100%を前提にする。 |
| [joint_committee_periods](#joint_committee_periods) | 共同製作の分配期 | 1行は、共同製作の委員会の分配期（売上の対象期間）1つ。売上と費用はどれかの期に入れる。 |
| [joint_committee_sales](#joint_committee_sales) | 共同製作の売上 | 1行は、窓口から報告された共同製作の売上（収入）1件。証憑の識別子で契約の中の重複を防ぐ。変更・削除はできない。 |
| [joint_committee_snapshots](#joint_committee_snapshots) | 共同製作の計算の保存版 | 1行は、共同製作の分配計算を管理者が保存した版。入力が同じなら新しく作らず前の版を使う。変更・削除はできない。 |
| [joint_committee_windows](#joint_committee_windows) | 共同製作の窓口 | 1行は、共同製作の委員会の販路の窓口1つ（劇場・配信など）と、その手数料率・報告と送金の予定。窓口担当は出資者から選ぶ。 |
| [joint_funding_events](#joint_funding_events) | 共同製作の出資の払込 | 1行は、出資者の出資の払込1件。現金の出資か、幹事が制作会社へ払った製作費を幹事の出資に充てたもの。変更・削除はできない。 |
| [joint_production_milestones](#joint_production_milestones) | 共同製作の制作費支払条件 | 1行は、受託制作会社へ製作費を払う段階の1つと、その支払。段階ごとの支払額の合計は直接製作費と一致させる。変更・削除はできない。 |
| [mg_contract_links](#mg_contract_links) | 受取MGと支払MGの関連 | 1行は、受取MGの契約と支払MGの契約を関連づけた記録。関連だけを持ち、回収の条件は写さない。 |
| [mg_incoming_contracts](#mg_incoming_contracts) | 受取MGの契約 | 1行は、販売先から MG を受け取る契約（受取MG）1件。条件は条件版（mg_term_versions）で持ち、変更・削除はできない。 |
| [mg_ledger_entries](#mg_ledger_entries) | MGの当期報告 | 1行は、MG条件版×商品の当期の報告1件（消化対象・実充当・超過報告・計上）。直すときは訂正版の行を足し、訂正前の行は合計に含めない。変更・削除はできない。 |
| [mg_term_versions](#mg_term_versions) | MGの条件版 | 1行は、受取MGか支払MGの契約の条件の1つの版（回収方式・MG保証額・契約期間）。直すときは新しい版を足す（変更・削除はできない）。 |
| [mg_version_phases](#mg_version_phases) | MG条件版の日程 | 1行は、MG条件版の日程の1区間（締めの間隔・締め日・報告予定・支払予定）。区間は契約期間の全体を切れ目なく覆う。変更・削除はできない。 |
| [mg_version_products](#mg_version_products) | MG条件版の商品評価 | 1行は、MG条件版に含める商品1つとその評価額。条件版の商品の評価額の合計は MG保証額と一致させる。変更・削除はできない。 |
| [rights_payment_events](#rights_payment_events) | 権利元への支払の記録 | 1行は、権利元（個別精算の契約の権利者）か製作委員会の参加者へ支払った記録1件。銀行とはつながず記録だけ。直すときは取消の行を足す。 |
| [royalty_agreements](#royalty_agreements) | ロイヤリティ契約 | 1行は、作品×権利者×種別（監督料・脚本料など）のロイヤリティ契約。ロイヤリティ契約の画面で登録し、変更も削除もできない（条件とサイクルは版を足して変える）。 |
| [royalty_irregular_entries](#royalty_irregular_entries) | ロイヤリティのイレギュラー | 1行は、権利者の報告書に効かせるイレギュラーの記録（金額の調整・締め月の変更・保留・保留の解除・記録だけ）。取消は同じ内容で取消の行を足す。 |
| [royalty_manual_accruals](#royalty_manual_accruals) | ロイヤリティの実額計上 | 1行は、計算方法が実額入力の契約に、計上月の実額を入れた記録（音楽著作権料の分配明細など）。直すときは符号を逆にした取消の行を足す。 |
| [royalty_schedule_phases](#royalty_schedule_phases) | サイクルのフェーズ | 1行は、サイクルの版の中の1つの期間（フェーズ）の締め方。計上月から締め月を決め、締め月から報告期限と支払期限を出す。同じ版の中で期間は重ならない。 |
| [royalty_schedule_versions](#royalty_schedule_versions) | ロイヤリティのサイクル版 | 1行は、ロイヤリティ契約のサイクル（締め方と期限）の1つの版。最新の版がすべての計上月の締め方を決める（確定済みの報告書は変わらない）。 |
| [royalty_statement_calculation_parts](#royalty_statement_calculation_parts) | 報告書の計算の分割 | 1行は、報告書の計算の内容（JSON）が大きいときに分けて保存した1片。part_no の順につなぐと元の内容になる（クラウドの DB は1つの値を128KBまでしか入れられないため）。 |
| [royalty_statement_events](#royalty_statement_events) | 報告書の報告・支払 | 1行は、ロイヤリティ報告書を実際に報告した日、または支払った日と額の記録。直すときは同じ内容の取消の記録を足す。支払の合計は支払予定額まで。 |
| [royalty_statement_lines](#royalty_statement_lines) | 報告書の明細 | 1行は、ロイヤリティ報告書の確定版の明細の1行（当期の計上・報告後の修正・調整・前払金の充当）。確定版と同時に書き、種類ごとの和が確定版の金額と一致する。 |
| [royalty_statement_voids](#royalty_statement_voids) | 報告書の取消 | 1行は、ロイヤリティ報告書の確定版を取り消した記録。取り消せるのは権利者の最新の確定版で、取り消していない支払の記録が無いものだけ。 |
| [royalty_statements](#royalty_statements) | ロイヤリティ報告書 | 1行は、権利者×締め月のロイヤリティ報告書の確定版。前期繰越＋当期＋調整−前払金の充当＝支払予定額＋翌期繰越。取り消すと同じ締め月で次の版を作れる。 |
| [royalty_term_channels](#royalty_term_channels) | 条件版の対象流通 | 1行は、ロイヤリティ条件版が対象にする流通の1つ。行が無い条件版はすべての流通が対象。報告書で使う前の最新の版にだけ足せる。 |
| [royalty_term_expense_categories](#royalty_term_expense_categories) | 条件版の控除費目 | 1行は、経費を差し引く基礎のロイヤリティ条件版で、差し引く経費の費目の1つ。行が無ければ、その作品×計上月の経費すべてを差し引く。 |
| [royalty_term_versions](#royalty_term_versions) | ロイヤリティ条件版 | 1行は、ロイヤリティ契約の計算条件の1つの版（料率・基礎・前払金・支払の下限）。適用開始の計上月から効き、直すときは新しい版を足す（変更・削除はできない）。 |
| [settlement_contracts](#settlement_contracts) | 分配契約 | 作品ごとの権利・分配の契約1件。精算の画面で作る。案件・作品・種別・権利元・MG契約額・MG実支払額は書き換えられない（トリガーで止める）。料率などの条件は条件版に持つ |
| [settlement_report_links](#settlement_report_links) | 報告と分配契約の紐付け | 売上報告を、作品ごとにどの分配契約・条件版で精算するかの紐付け1件。精算の画面で作る。有効な報告だけを使え、製作委員会の報告に使った報告は使えない。 |
| [settlement_term_versions](#settlement_term_versions) | 分配契約の条件版 | 分配契約の条件（料率など）の版1件。契約を作るときに版1を作り、改訂は新しい版を足す。変更も削除もできない。 |

## committee_contracts

**製作委員会契約** — 製作委員会の契約1件。製作委員会の調達ケースと契約書の参照から作り、書き換えない。条件は条件版に持つ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ rights_intake_cases、FK（複合）→ works |
| 5 | intake_case_id | INTEGER | 製作委員会の調達ケース（rights_intake_cases） | 不可 | - | FK（複合）→ rights_intake_documents、FK（複合）→ rights_intake_cases |
| 6 | document_id | INTEGER | 元の契約書の参照（rights_intake_documents） | 不可 | - | FK（複合）→ rights_intake_documents |
| 7 | contract_code | TEXT | 契約コード（組織内で一意） | 不可 | - | - |
| 8 | title | TEXT | 契約名 | 不可 | - | - |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, id, work_id)
- 複合の一意: (org_id, contract_code)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, intake_case_id, document_id) → rights_intake_documents(org_id, intake_case_id, id)
- 複合の参照: (org_id, intake_case_id, work_id) → rights_intake_cases(org_id, id, work_id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- トリガー committee_contract_immutable: 更新の前

## committee_report_previews

**委員会報告の保存前確認** — 委員会報告を保存する前の確認1回分を表す。確認画面で計算したときに作り、15分で期限が切れ、保存に使うと consumed を1にする。期限切れの行は、次に確認を作るときに消す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | token | TEXT | 確認の鍵（行のID。保存のときに照合する） | 可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | user_id | INTEGER | 確認を作った利用者（memberships） | 不可 | - | FK（複合）→ memberships |
| 4 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 5 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ works |
| 6 | payload_json | TEXT | 確認時の入力・計算結果と照合値 | 不可 | - | - |
| 7 | expires_at | TEXT | 期限（作成から15分） | 不可 | - | - |
| 8 | consumed | INTEGER（真偽 0/1） | 保存に使ったか（1=使用済み） | 不可 | 0 | - |

表の制約:

- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 複合の参照: (org_id, user_id) → memberships(org_id, user_id)

## committee_report_snapshots

**委員会報告の下書き** — 製作委員会の1つの締め期間の報告の下書き1件を表す。確認画面の計算を保存したときに作り、入力と計算結果を入力の照合値とともに固定して変えられない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ committee_contracts、FK（複合）→ works |
| 5 | contract_id | INTEGER | 製作委員会の契約（committee_contracts） | 不可 | - | FK（複合）→ committee_term_versions、FK（複合）→ committee_contracts |
| 6 | term_version_id | INTEGER | 使った条件版（committee_term_versions） | 不可 | - | FK（複合）→ committee_term_versions |
| 7 | period_index | INTEGER | 何期目か（日程から数えた締め期間の番号） | 不可 | - | - |
| 8 | period_from | TEXT | 締め期間の開始日 | 不可 | - | - |
| 9 | period_to | TEXT | 締め期間の終了日 | 不可 | - | - |
| 10 | close_on | TEXT | 締め日 | 不可 | - | - |
| 11 | report_on | TEXT | 報告予定日 | 不可 | - | - |
| 12 | payment_on | TEXT | 支払予定日 | 不可 | - | - |
| 13 | period_date_basis | TEXT（列挙） | 報告を期間に入れる基準（販売期間か報告受領日） | 不可 | - | 値: sales_period / report_received |
| 14 | stub | INTEGER（真偽 0/1） | 端数期間か（1=フェーズの終わりで切れた期間） | 不可 | - | - |
| 15 | allow_stub | INTEGER（真偽 0/1） | 端数期間の採用を明示したか（1=明示） | 不可 | - | - |
| 16 | status | TEXT | 状態。いまは draft（下書き）だけ | 不可 | draft | CHECK: status='draft' |
| 17 | verification | TEXT | 確認の状態。いまは unverified（未確認）だけ | 不可 | unverified | CHECK: verification='unverified' |
| 18 | calculation_version | TEXT | 計算方式の版 | 不可 | - | - |
| 19 | input_json | TEXT | 計算に使った入力（報告・経費・控除の選択） | 不可 | - | - |
| 20 | input_hash | TEXT | 入力の照合値 | 不可 | - | - |
| 21 | calculation_json | TEXT | 計算結果（窓口ごとの手数料・分配など） | 不可 | - | - |
| 22 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 23 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, id, work_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, contract_id, term_version_id) → committee_term_versions(org_id, contract_id, id)
- 複合の参照: (org_id, contract_id, work_id) → committee_contracts(org_id, id, work_id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- トリガー committee_snapshot_immutable: 更新の前

## committee_schedule_phases

**委員会の報告・支払日程** — 委員会の条件版ごとに、締め・報告・支払の日程の区切り（フェーズ）1つを表す。フェーズは隙間なく続き、ここから締め期間を数える。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | term_version_id | INTEGER | 委員会の条件版（committee_term_versions） | 不可 | - | FK（複合）→ committee_term_versions |
| 4 | phase_order | INTEGER | フェーズの順番（1から） | 不可 | - | CHECK: phase_order>0 |
| 5 | label | TEXT | フェーズの名前 | 不可 | - | - |
| 6 | starts_on | TEXT | フェーズの開始日 | 不可 | - | - |
| 7 | ends_on | TEXT | フェーズの終了日 | 不可 | - | - |
| 8 | first_close_on | TEXT | 最初の締め日 | 不可 | - | - |
| 9 | interval_months | INTEGER | 締めの間隔（1〜12か月） | 不可 | - | CHECK: interval_months BETWEEN 1 AND 12 |
| 10 | close_day | TEXT | 締めの日（1〜31。eom=月末） | 不可 | - | - |
| 11 | report_offset_months | INTEGER | 締めから報告までの月数 | 不可 | - | CHECK: report_offset_months BETWEEN 0 AND 24 |
| 12 | report_day | TEXT | 報告の日（1〜31。eom=月末） | 不可 | - | - |
| 13 | payment_offset_months | INTEGER | 締めから支払までの月数 | 不可 | - | CHECK: payment_offset_months BETWEEN 0 AND 24 |
| 14 | payment_day | TEXT | 支払の日（1〜31。eom=月末） | 不可 | - | - |
| 15 | reference_type | TEXT（列挙） | 日程の基準（公開日・初回売上・初回報告・契約個別） | 不可 | - | 値: release / first_sales / first_report / contract_specific |
| 16 | reference_date | TEXT | 基準の日付 | 不可 | - | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, term_version_id, phase_order)
- 複合の参照: (org_id, term_version_id) → committee_term_versions(org_id, id)
- CHECK: ends_on>=starts_on AND first_close_on>=starts_on AND first_close_on<=ends_on
- トリガー committee_phase_immutable: 更新の前

## committee_snapshot_deductions

**委員会報告の追加控除** — 1行は、委員会報告を保存するとき、手数料と経費を引いた後で差し引く追加の控除1件（権利処理費か製作費回収）。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | snapshot_id | INTEGER | 委員会報告の保存版（committee_report_snapshots） | 不可 | - | PK（複合）、FK（複合）→ committee_snapshot_reports、FK（複合）→ committee_report_snapshots |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ committee_report_snapshots |
| 4 | report_id | INTEGER | 元の売上報告。保存版に含めた報告（committee_snapshot_reports）に限り、窓口も一致させる | 不可 | - | FK（複合）→ committee_snapshot_reports |
| 5 | window_id | INTEGER | 販路の窓口（committee_term_windows） | 不可 | - | FK（複合）→ committee_term_windows |
| 6 | category | TEXT（列挙） | 区分（権利処理費・製作費回収） | 不可 | - | 値: royalty / production_recoup |
| 7 | recipient_partner_id | INTEGER | 受取先（partners）。製作費回収は委員会の参加者 | 不可 | - | FK（複合）→ partners |
| 8 | amount_yen | INTEGER | 控除額（円・正の数）。税抜の売上から出した分配原資から差し引く | 不可 | - | CHECK: amount_yen>0 |
| 9 | source_reference | TEXT | 根拠の識別番号（作品の中で一意） | 不可 | - | PK（複合）、CHECK: length(trim(source_reference))>0 |

表の制約:

- 複合の主キー: (org_id, snapshot_id, source_reference)
- 複合の一意: (org_id, work_id, source_reference)
- 複合の参照: (org_id, recipient_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, window_id) → committee_term_windows(org_id, id)
- 複合の参照: (org_id, snapshot_id, report_id) → committee_snapshot_reports(org_id, snapshot_id, report_id)
- 複合の参照: (org_id, snapshot_id, work_id) → committee_report_snapshots(org_id, id, work_id)
- トリガー committee_deduction_immutable: 更新の前
- トリガー committee_deduction_no_delete: 削除の前
- トリガー committee_deduction_scope: 追加の前

## committee_snapshot_expenses

**委員会報告の経費** — 委員会報告の下書きで控除した経費1件を表す。1つの経費は1度しか使えず、保存時に作って変えられない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | snapshot_id | INTEGER | 委員会報告の下書き（committee_report_snapshots） | 不可 | - | PK（複合）、FK（複合）→ committee_report_snapshots |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ committee_report_snapshots |
| 4 | expense_id | INTEGER | 経費（expenses） | 不可 | - | PK（複合）、FK（複合）→ expenses |
| 5 | window_id | INTEGER | 経費を控除した窓口（committee_term_windows） | 不可 | - | FK（複合）→ committee_term_windows |
| 6 | amount_ex_tax | INTEGER | 控除した額（円・税抜。保存時の経費の実額） | 不可 | - | - |

表の制約:

- 複合の主キー: (org_id, snapshot_id, expense_id)
- 複合の一意: (org_id, expense_id)
- 複合の参照: (org_id, window_id) → committee_term_windows(org_id, id)
- 複合の参照: (org_id, expense_id) → expenses(org_id, id)
- 複合の参照: (org_id, snapshot_id, work_id) → committee_report_snapshots(org_id, id, work_id)
- トリガー committee_snapshot_expense_immutable: 更新の前
- トリガー committee_snapshot_expense_scope: 追加の前

## committee_snapshot_lines

**委員会報告の明細** — 委員会報告の下書きに入れた売上明細1行を、作品への配賦後の額で表す。保存時に作り、変えられない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | snapshot_id | INTEGER | 委員会報告の下書き（committee_report_snapshots） | 不可 | - | PK（複合）、FK（複合）→ committee_report_snapshots |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | PK（複合）、FK（複合）→ committee_report_snapshots |
| 4 | report_id | INTEGER | 売上報告（report_imports） | 不可 | - | FK（複合）→ report_imports |
| 5 | sale_id | INTEGER | 売上明細（sale_lines） | 不可 | - | PK（複合）、FK（複合）→ sale_lines |
| 6 | window_id | INTEGER | 当てはめた窓口（committee_term_windows） | 不可 | - | FK（複合）→ committee_term_windows |
| 7 | source_row | INTEGER | 元の報告書の行番号 | 可 | - | - |
| 8 | allocation_bps | INTEGER | 作品への配賦率（bps。1万で100%） | 不可 | - | - |
| 9 | allocated_amount_ex_tax | INTEGER | 作品へ配賦した額（円・税抜） | 不可 | - | - |
| 10 | sales_period_from | TEXT | 販売期間の開始日 | 不可 | - | - |
| 11 | sales_period_to | TEXT | 販売期間の終了日 | 不可 | - | - |
| 12 | accounting_month | TEXT | 計上月（YYYY-MM） | 不可 | - | - |

表の制約:

- 複合の主キー: (org_id, snapshot_id, sale_id, work_id)
- 複合の参照: (org_id, window_id) → committee_term_windows(org_id, id)
- 複合の参照: (org_id, sale_id) → sale_lines(org_id, id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- 複合の参照: (org_id, snapshot_id, work_id) → committee_report_snapshots(org_id, id, work_id)
- トリガー committee_snapshot_line_immutable: 更新の前
- トリガー committee_snapshot_line_scope: 追加の前

## committee_snapshot_member_amounts

**委員会報告の分配額** — 委員会報告の下書きで、窓口ごと・参加者ごとに計算した分配額を表す。保存時に作り、変えられない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | snapshot_id | INTEGER | 委員会報告の下書き（committee_report_snapshots） | 不可 | - | PK（複合）、FK（複合）→ committee_report_snapshots |
| 3 | window_id | INTEGER | 窓口（committee_term_windows） | 不可 | - | PK（複合）、FK（複合）→ committee_term_windows |
| 4 | partner_id | INTEGER | 参加者の取引先（partners） | 不可 | - | PK（複合）、FK（複合）→ partners |
| 5 | share_bps | INTEGER | 持分（bps。条件版の持分の写し） | 不可 | - | - |
| 6 | amount_yen | INTEGER | 分配額（円。税抜の売上・経費から計算） | 不可 | - | - |
| 7 | route | TEXT（列挙） | 支払経路（direct=直接、via_manager=幹事経由） | 不可 | - | 値: direct / via_manager |
| 8 | window_fee_recipient | INTEGER（真偽 0/1） | 窓口手数料の受取人か（1=はい） | 不可 | - | - |
| 9 | manager_fee_recipient | INTEGER（真偽 0/1） | 幹事手数料の受取人か（1=はい） | 不可 | - | - |

表の制約:

- 複合の主キー: (org_id, snapshot_id, window_id, partner_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, window_id) → committee_term_windows(org_id, id)
- 複合の参照: (org_id, snapshot_id) → committee_report_snapshots(org_id, id)
- トリガー committee_snapshot_member_immutable: 更新の前
- トリガー committee_snapshot_member_scope: 追加の前

## committee_snapshot_reports

**委員会報告に含めた売上報告** — 委員会報告の下書きに含めた売上報告1件と、当てはめた窓口を表す。1つの報告は作品ごとに1度しか使えず、個別精算（settlement_report_links）にも使えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | snapshot_id | INTEGER | 委員会報告の下書き（committee_report_snapshots） | 不可 | - | PK（複合）、FK（複合）→ committee_report_snapshots |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ committee_report_snapshots |
| 4 | report_id | INTEGER | 売上報告（report_imports） | 不可 | - | PK（複合）、FK（複合）→ report_imports |
| 5 | window_id | INTEGER | 当てはめた窓口（committee_term_windows） | 不可 | - | FK（複合）→ committee_term_windows |
| 6 | report_basis | TEXT（列挙） | 報告額の基準（gross=PF控除前、net=控除後） | 不可 | - | 値: gross / net |

表の制約:

- 複合の主キー: (org_id, snapshot_id, report_id)
- 複合の一意: (org_id, work_id, report_id)
- 複合の参照: (org_id, window_id) → committee_term_windows(org_id, id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- 複合の参照: (org_id, snapshot_id, work_id) → committee_report_snapshots(org_id, id, work_id)
- トリガー billed_report_no_gross_committee: 追加の前
- トリガー committee_snapshot_report_immutable: 更新の前
- トリガー committee_snapshot_report_scope: 追加の前

## committee_term_funding

**委員会の製作費総額** — 1行は、製作委員会の条件版に付ける製作費の総額。契約で確定したときだけ条件版と一緒に入れ、製作費回収の上限に使う。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 製作委員会の条件版（committee_term_versions） | 不可 | - | PK（複合）、FK（複合）→ committee_term_versions |
| 3 | production_cost_yen | INTEGER | 製作費の総額（円。税込か税抜かは未確認） | 不可 | - | CHECK: production_cost_yen>=0 |

表の制約:

- 複合の主キー: (org_id, term_version_id)
- 複合の参照: (org_id, term_version_id) → committee_term_versions(org_id, id)
- トリガー committee_funding_immutable: 更新の前
- トリガー committee_funding_no_delete: 削除の前

## committee_term_investments

**委員会の出資額** — 1行は、製作委員会の条件版の参加者1社の出資額。製作費の総額と一緒に入れ、合計は製作費の総額と一致させる。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 製作委員会の条件版（committee_term_versions） | 不可 | - | PK（複合）、FK（複合）→ committee_term_members |
| 3 | partner_id | INTEGER | 出資する参加者（partners。committee_term_members） | 不可 | - | PK（複合）、FK（複合）→ committee_term_members |
| 4 | amount_yen | INTEGER | 出資額（円。税込か税抜かは未確認） | 不可 | - | CHECK: amount_yen>=0 |

表の制約:

- 複合の主キー: (org_id, term_version_id, partner_id)
- 複合の参照: (org_id, term_version_id, partner_id) → committee_term_members(org_id, term_version_id, partner_id)
- トリガー committee_investment_immutable: 更新の前
- トリガー committee_investment_no_delete: 削除の前

## committee_term_members

**委員会の参加者（条件版）** — 製作委員会の条件版ごとの参加者1者と持分を表す。条件版の登録時に調達案件の参加者から写して作り、あとから変えられない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | term_version_id | INTEGER | 委員会の条件版（committee_term_versions） | 不可 | - | FK（複合）→ committee_term_versions |
| 4 | partner_id | INTEGER | 参加者の取引先（partners） | 不可 | - | FK（複合）→ partners |
| 5 | role | TEXT | 参加者の役割。調達案件の参加者から写す | 可 | - | - |
| 6 | share_bps | INTEGER | 持分（bps。1万で100%、参加者の合計は1万） | 不可 | - | CHECK: share_bps BETWEEN 0 AND 10000 |
| 7 | member_order | INTEGER | 参加者の並び順（1から） | 不可 | - | CHECK: member_order>0 |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, term_version_id, partner_id)
- 複合の一意: (org_id, term_version_id, member_order)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, term_version_id) → committee_term_versions(org_id, id)
- トリガー committee_member_immutable: 更新の前

## committee_term_version_effective

**委員会条件版の適用開始月** — 1行は、製作委員会の条件版の適用開始月。条件版の表に列を足せないため別の表に持つ。行の無い条件版は最初の月から効く。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 製作委員会の条件版（committee_term_versions） | 不可 | - | PK（複合）、FK（複合）→ committee_term_versions |
| 3 | effective_from | TEXT | 適用開始の計上月（YYYY-MM） | 不可 | - | CHECK: effective_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(effective_from,6,2) BETWEEN '01' AND '12' |
| 4 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 5 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, term_version_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, term_version_id) → committee_term_versions(org_id, id)
- トリガー committee_term_version_effective_no_delete: 削除の前
- トリガー committee_term_version_effective_no_update: 更新の前

## committee_term_versions

**委員会契約の条件版** — 製作委員会契約の条件の版1件。改訂は新しい版を足し、書き換えない。メンバー・窓口・日程は版ごとに別の表に持つ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 製作委員会契約（committee_contracts） | 不可 | - | FK（複合）→ committee_term_versions、FK（複合）→ committee_contracts |
| 4 | version_no | INTEGER | 契約の中の版番号（1から） | 不可 | - | CHECK: version_no>0 |
| 5 | source_version_id | INTEGER | コピー元の条件版（committee_term_versions） | 可 | - | FK（複合）→ committee_term_versions |
| 6 | manager_partner_id | INTEGER | 幹事会社の取引先（partners） | 可 | - | FK（複合）→ partners |
| 7 | calculation_version | TEXT | 計算方式の版の名前 | 不可 | - | - |
| 8 | note | TEXT | 条件版のメモ（1000字まで） | 可 | - | - |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, contract_id, id)
- 複合の一意: (org_id, contract_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, manager_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, contract_id, source_version_id) → committee_term_versions(org_id, contract_id, id)
- 複合の参照: (org_id, contract_id) → committee_contracts(org_id, id)
- トリガー committee_term_immutable: 更新の前

## committee_term_window_fee_shares

**窓口手数料の取り分** — 1行は、製作委員会の販路の窓口の窓口手数料を複数社で分けるときの1社の取り分。行が無い窓口は、窓口の受取先1社が全部を受け取る。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | window_id | INTEGER | 販路の窓口（committee_term_windows） | 不可 | - | PK（複合）、FK（複合）→ committee_term_windows |
| 3 | partner_id | INTEGER | 取り分を受け取る会社（partners） | 不可 | - | PK（複合）、FK（複合）→ partners |
| 4 | share_bps | INTEGER | 取り分（bps。1〜10000）。窓口ごとの合計は10000（100%）にする | 不可 | - | CHECK: share_bps BETWEEN 1 AND 10000 |
| 5 | reason | TEXT | 取り分を決めた理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 500 |
| 6 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, window_id, partner_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, window_id) → committee_term_windows(org_id, id)
- トリガー committee_window_fee_shares_no_delete: 削除の前
- トリガー committee_window_fee_shares_no_update: 更新の前
- トリガー committee_window_fee_shares_total: 追加の前

## committee_term_windows

**委員会の販路窓口** — 委員会の条件版ごと・販路の種類ごとに、窓口の取引先と手数料の条件を1行で表す。条件版の登録時に作り、変えられない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | term_version_id | INTEGER | 委員会の条件版（committee_term_versions） | 不可 | - | FK（複合）→ committee_term_versions |
| 4 | kind | TEXT（列挙） | 販路の種類（theatrical=配給、digital=配信 など） | 不可 | - | 値: theatrical / digital / package / broadcast / other |
| 5 | label | TEXT | 窓口の表示名 | 不可 | - | - |
| 6 | window_partner_id | INTEGER | 窓口の取引先（partners。参加者から選ぶ） | 不可 | - | FK（複合）→ partners |
| 7 | route | TEXT（列挙） | 分配金の支払経路（direct=直接、via_manager=幹事経由） | 不可 | - | 値: direct / via_manager |
| 8 | platform_rate_bps | INTEGER | PF手数料率（bps）。控除前の報告額にかける | 不可 | - | CHECK: platform_rate_bps BETWEEN 0 AND 10000 |
| 9 | window_fee_bps | INTEGER | 窓口手数料率（bps） | 不可 | - | CHECK: window_fee_bps BETWEEN 0 AND 10000 |
| 10 | manager_fee_bps | INTEGER | 幹事手数料率（bps） | 不可 | - | CHECK: manager_fee_bps BETWEEN 0 AND 10000 |
| 11 | fee_order | TEXT（列挙） | 手数料を引く順（window_first=窓口が先） | 不可 | - | 値: window_first / manager_first |
| 12 | window_fee_basis | TEXT（列挙） | 窓口手数料の基礎（PF控除後か幹事手数料控除後） | 不可 | - | 値: platform_net / after_manager |
| 13 | manager_fee_basis | TEXT（列挙） | 幹事手数料の基礎（PF控除後か窓口手数料控除後） | 不可 | - | 値: platform_net / after_window |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, term_version_id, id)
- 複合の一意: (org_id, term_version_id, kind)
- 複合の参照: (org_id, window_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, term_version_id) → committee_term_versions(org_id, id)
- トリガー committee_window_immutable: 更新の前

## intake_settlement_links

**調達と分配契約の関連** — 調達ケースと分配契約の関連1件。分配契約を作るときか調達の画面でつなぎ、書き換えない。1つの契約につながるケースは1つ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | intake_case_id | INTEGER | 調達ケース（rights_intake_cases） | 不可 | - | PK（複合）、FK（複合）→ rights_intake_cases |
| 3 | work_id | INTEGER | 作品（works）。ケースと契約で同じ作品 | 不可 | - | FK（複合）→ settlement_contracts、FK（複合）→ rights_intake_cases |
| 4 | settlement_contract_id | INTEGER | 分配契約（settlement_contracts） | 不可 | - | PK（複合）、FK（複合）→ settlement_contracts |
| 5 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, intake_case_id, settlement_contract_id)
- 複合の一意: (org_id, settlement_contract_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, settlement_contract_id, work_id) → settlement_contracts(org_id, id, work_id)
- 複合の参照: (org_id, intake_case_id, work_id) → rights_intake_cases(org_id, id, work_id)
- トリガー rights_intake_link_immutable: 更新の前

## joint_business_holidays

**共同製作の休日** — 1行は、共同製作の契約で使う休日1日。窓口の送金予定日が休日にあたるとき、前の営業日にずらすのに使う。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | PK（複合）、FK（複合）→ joint_committee_contracts |
| 3 | holiday_on | TEXT | 休日 | 不可 | - | PK（複合） |
| 4 | label | TEXT | 休日の名前 | 不可 | - | - |

表の制約:

- 複合の主キー: (org_id, contract_id, holiday_on)
- 複合の参照: (org_id, contract_id) → joint_committee_contracts(org_id, id)
- トリガー joint_holiday_immutable: 更新の前
- トリガー joint_holiday_no_delete: 削除の前

## joint_committee_contracts

**共同製作の委員会契約** — 1行は、共同製作（入金基準）の製作委員会の契約条件。いまは架空データの投入スクリプトだけが書き、画面からは作れない。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ works |
| 4 | code | TEXT | 契約コード（組織の中で一意） | 不可 | - | - |
| 5 | title | TEXT | 契約名 | 不可 | - | - |
| 6 | calculation_version | TEXT | 計算の版（joint_cash_v1） | 不可 | - | CHECK: calculation_version='joint_cash_v1' |
| 7 | demo_flag | INTEGER（真偽 0/1） | 1＝架空のデモデータ | 不可 | 0 | - |
| 8 | manager_partner_id | INTEGER | 幹事（partners）。出資者の1社 | 不可 | - | FK（複合）→ partners |
| 9 | producer_partner_id | INTEGER | 受託制作会社（partners）。委員会の外 | 不可 | - | FK（複合）→ partners |
| 10 | production_cost_inc_tax_yen | INTEGER | 直接製作費（円・税込） | 不可 | - | CHECK: production_cost_inc_tax_yen>=0 |
| 11 | pa_inc_tax_yen | INTEGER | P&A の額（円・税込）。出資の合計＝製作費＋P&A | 不可 | - | CHECK: pa_inc_tax_yen>=0 |
| 12 | manager_fee_bps | INTEGER | 幹事料率（bps）。委員会収入−権利処理費にかける | 不可 | - | CHECK: manager_fee_bps BETWEEN 0 AND 10000 |
| 13 | income_threshold_yen | INTEGER | 委員会収入の繰越の閾値（円）。未満は翌期へ | 不可 | - | CHECK: income_threshold_yen>=0 |
| 14 | transfer_threshold_yen | INTEGER | 窓口送金の繰越の閾値（円）。税込の総売上と比べる | 不可 | - | CHECK: transfer_threshold_yen>=0 |
| 15 | investor_report_offset_months | INTEGER | 出資者への報告予定は実入金月の何か月後か | 不可 | - | - |
| 16 | investor_report_day | TEXT | 出資者への報告予定の日（eom は月末） | 不可 | - | - |
| 17 | investor_payment_offset_months | INTEGER | 出資者への支払予定は実入金月の何か月後か | 不可 | - | - |
| 18 | investor_payment_day | TEXT | 出資者への支払予定の日（eom は月末） | 不可 | - | - |
| 19 | terms_note | TEXT | 条件のメモ | 不可 | - | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, code)
- 複合の参照: (org_id, producer_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, manager_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, work_id) → works(org_id, id)
- CHECK: manager_partner_id<>producer_partner_id
- トリガー joint_contract_immutable: 更新の前
- トリガー joint_contract_no_delete: 削除の前

## joint_committee_costs

**共同製作の費用** — 1行は、共同製作の委員会の費用1件（窓口の直接経費・音楽使用料・権利処理費・原盤管理費・立替返済）。承認済みの費用だけを入れる。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | FK（複合）→ joint_committee_windows、FK（複合）→ joint_committee_periods |
| 4 | window_id | INTEGER | 窓口（joint_committee_windows）。直接経費と音楽使用料だけ | 可 | - | FK（複合）→ joint_committee_windows |
| 5 | period_sequence | INTEGER | 分配期の番号（joint_committee_periods） | 不可 | - | FK（複合）→ joint_committee_periods |
| 6 | source_ref | TEXT | 証憑の識別子（契約の中で一意） | 不可 | - | - |
| 7 | kind | TEXT（列挙） | 費目（直接経費・音楽使用料・権利処理費・原盤管理費・立替返済） | 不可 | - | 値: window_direct / music_window_paid / rights_manager / master_management / bank_advance |
| 8 | amount_yen | INTEGER | 費用額（円。税込か税抜かは tax_basis） | 不可 | - | CHECK: amount_yen>=0 |
| 9 | tax_basis | TEXT（列挙） | 額の税の扱い（ex_tax 税抜・inc_tax 税込）。計算は税込だけ | 不可 | - | 値: ex_tax / inc_tax |
| 10 | approved | INTEGER | 承認済みの印。1 だけ入れられる | 不可 | - | CHECK: approved=1 |

表の制約:

- 複合の一意: (org_id, contract_id, source_ref)
- 複合の参照: (org_id, contract_id, window_id) → joint_committee_windows(org_id, contract_id, id)
- 複合の参照: (org_id, contract_id, period_sequence) → joint_committee_periods(org_id, contract_id, sequence)
- CHECK: (kind IN ('window_direct','music_window_paid') AND window_id IS NOT NULL) OR (kind NOT IN ('window_direct','music_window_paid') AND window_id IS NULL)
- トリガー joint_cost_immutable: 更新の前
- トリガー joint_cost_no_delete: 削除の前

## joint_committee_members

**共同製作の出資者** — 1行は、共同製作の委員会の出資者1社と、その持分・出資予定額。計算は出資者2社・持分の合計100%を前提にする。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | PK（複合）、FK（複合）→ joint_committee_contracts |
| 3 | partner_id | INTEGER | 出資者（partners） | 不可 | - | PK（複合）、FK（複合）→ partners |
| 4 | role | TEXT | 役割。いまは investor（出資者）だけ | 不可 | - | CHECK: role='investor' |
| 5 | share_bps | INTEGER | 持分（bps。2社の合計が10000） | 不可 | - | CHECK: share_bps BETWEEN 0 AND 10000 |
| 6 | contribution_inc_tax_yen | INTEGER | 出資予定額（円・税込） | 不可 | - | CHECK: contribution_inc_tax_yen>=0 |

表の制約:

- 複合の主キー: (org_id, contract_id, partner_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, contract_id) → joint_committee_contracts(org_id, id)
- トリガー joint_member_immutable: 更新の前
- トリガー joint_member_no_delete: 削除の前

## joint_committee_periods

**共同製作の分配期** — 1行は、共同製作の委員会の分配期（売上の対象期間）1つ。売上と費用はどれかの期に入れる。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | PK（複合）、FK（複合）→ joint_committee_contracts |
| 3 | sequence | INTEGER | 期の番号（1から） | 不可 | - | PK（複合）、CHECK: sequence>0 |
| 4 | from_on | TEXT | 期の開始日 | 不可 | - | - |
| 5 | to_on | TEXT | 期の終了日 | 不可 | - | - |

表の制約:

- 複合の主キー: (org_id, contract_id, sequence)
- 複合の参照: (org_id, contract_id) → joint_committee_contracts(org_id, id)
- CHECK: from_on<=to_on
- トリガー joint_period_immutable: 更新の前
- トリガー joint_period_no_delete: 削除の前

## joint_committee_sales

**共同製作の売上** — 1行は、窓口から報告された共同製作の売上（収入）1件。証憑の識別子で契約の中の重複を防ぐ。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | FK（複合）→ joint_committee_windows、FK（複合）→ joint_committee_periods |
| 4 | window_id | INTEGER | 窓口（joint_committee_windows） | 不可 | - | FK（複合）→ joint_committee_windows |
| 5 | period_sequence | INTEGER | 分配期の番号（joint_committee_periods） | 不可 | - | FK（複合）→ joint_committee_periods |
| 6 | source_ref | TEXT | 証憑の識別子（契約の中で一意） | 不可 | - | - |
| 7 | amount_contract_yen | INTEGER | 窓口の正味の収入（円・税込の契約額） | 不可 | - | CHECK: amount_contract_yen>=0 |
| 8 | gross_inc_tax_yen | INTEGER | 税込の総売上（円）。送金の繰越の判定に使う | 不可 | - | CHECK: gross_inc_tax_yen>=0 |
| 9 | reported_on | TEXT | 窓口が報告した日 | 可 | - | - |
| 10 | manager_receipt_on | TEXT | 幹事が実際に入金を受けた日 | 可 | - | - |

表の制約:

- 複合の一意: (org_id, contract_id, source_ref)
- 複合の参照: (org_id, contract_id, window_id) → joint_committee_windows(org_id, contract_id, id)
- 複合の参照: (org_id, contract_id, period_sequence) → joint_committee_periods(org_id, contract_id, sequence)
- トリガー joint_sale_immutable: 更新の前
- トリガー joint_sale_no_delete: 削除の前

## joint_committee_snapshots

**共同製作の計算の保存版** — 1行は、共同製作の分配計算を管理者が保存した版。入力が同じなら新しく作らず前の版を使う。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | FK（複合）→ joint_committee_contracts |
| 4 | calculation_version | TEXT | 計算の版（joint_cash_v1） | 不可 | - | CHECK: calculation_version='joint_cash_v1' |
| 5 | input_hash | TEXT | 計算の入力（契約と明細すべて）の SHA-256 | 不可 | - | - |
| 6 | calculation_json | TEXT | 入力と期ごとの計算結果（JSON） | 不可 | - | - |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, contract_id, input_hash)
- 複合の参照: (org_id, contract_id) → joint_committee_contracts(org_id, id)
- トリガー joint_snapshot_immutable: 更新の前
- トリガー joint_snapshot_no_delete: 削除の前

## joint_committee_windows

**共同製作の窓口** — 1行は、共同製作の委員会の販路の窓口1つ（劇場・配信など）と、その手数料率・報告と送金の予定。窓口担当は出資者から選ぶ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | FK（複合）→ joint_committee_contracts |
| 4 | kind | TEXT | 販路の種類（theatrical・digital など。値の決まりは無い） | 不可 | - | - |
| 5 | label | TEXT | 窓口の表示名 | 不可 | - | - |
| 6 | partner_id | INTEGER | 窓口担当の出資者（partners） | 不可 | - | FK（複合）→ partners |
| 7 | fee_bps | INTEGER | 窓口手数料率（bps） | 不可 | - | CHECK: fee_bps BETWEEN 0 AND 10000 |
| 8 | report_offset_months | INTEGER | 窓口の報告予定は期の終わりの何か月後か | 不可 | - | - |
| 9 | report_day | TEXT | 窓口の報告予定の日（eom は月末） | 不可 | - | - |
| 10 | payment_offset_months | INTEGER | 窓口の送金予定は期の終わりの何か月後か | 不可 | - | - |
| 11 | payment_day | TEXT | 送金予定の日（eom は月末）。休日なら前の営業日 | 不可 | - | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, contract_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, contract_id) → joint_committee_contracts(org_id, id)
- トリガー joint_window_immutable: 更新の前
- トリガー joint_window_no_delete: 削除の前

## joint_funding_events

**共同製作の出資の払込** — 1行は、出資者の出資の払込1件。現金の出資か、幹事が制作会社へ払った製作費を幹事の出資に充てたもの。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | FK（複合）→ joint_committee_members |
| 4 | partner_id | INTEGER | 出資者（joint_committee_members） | 不可 | - | FK（複合）→ joint_committee_members |
| 5 | kind | TEXT（列挙） | 種類（現金出資か、製作費支払の出資への充当） | 不可 | - | 値: cash_contribution / production_payment_credit |
| 6 | source_ref | TEXT | 証憑の識別子（契約の中で一意） | 不可 | - | - |
| 7 | amount_inc_tax_yen | INTEGER | 払込額（円・税込） | 不可 | - | CHECK: amount_inc_tax_yen>0 |
| 8 | paid_on | TEXT | 払い込んだ日。充当は製作費の支払日 | 不可 | - | - |
| 9 | milestone_id | INTEGER | 充当のもとの製作費支払（joint_production_milestones） | 可 | - | FK → joint_production_milestones.id |

表の制約:

- 複合の一意: (org_id, contract_id, source_ref)
- 複合の参照: (org_id, contract_id, partner_id) → joint_committee_members(org_id, contract_id, partner_id)
- CHECK: (kind='production_payment_credit' AND milestone_id IS NOT NULL) OR (kind='cash_contribution' AND milestone_id IS NULL)
- トリガー joint_funding_credit_validate: 追加の前
- トリガー joint_funding_event_immutable: 更新の前
- トリガー joint_funding_event_no_delete: 削除の前

## joint_production_milestones

**共同製作の制作費支払条件** — 1行は、受託制作会社へ製作費を払う段階の1つと、その支払。段階ごとの支払額の合計は直接製作費と一致させる。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 共同製作の契約（joint_committee_contracts） | 不可 | - | FK（複合）→ joint_committee_contracts |
| 4 | producer_partner_id | INTEGER | 受託制作会社（partners） | 不可 | - | FK（複合）→ partners |
| 5 | stage | TEXT（列挙） | 段階（スケジュール承認・撮影終了・納品物の検収合格） | 不可 | - | 値: schedule_approved / shooting_complete / delivery_accepted |
| 6 | due_on | TEXT | 支払予定日 | 不可 | - | - |
| 7 | condition_met_on | TEXT | 支払の条件がそろった日 | 可 | - | - |
| 8 | acceptance_on | TEXT | 納品物の検収に合格した日 | 可 | - | - |
| 9 | amount_inc_tax_yen | INTEGER | 支払額（円・税込） | 不可 | - | CHECK: amount_inc_tax_yen>=0 |
| 10 | paid_on | TEXT | 支払った日 | 可 | - | - |
| 11 | paid_inc_tax_yen | INTEGER | 支払済みの額（円・税込） | 不可 | 0 | CHECK: paid_inc_tax_yen>=0 |

表の制約:

- 複合の一意: (org_id, contract_id, stage)
- 複合の参照: (org_id, producer_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, contract_id) → joint_committee_contracts(org_id, id)
- CHECK: paid_inc_tax_yen<=amount_inc_tax_yen
- CHECK: paid_inc_tax_yen=0 OR (paid_on IS NOT NULL AND condition_met_on IS NOT NULL)
- CHECK: stage<>'delivery_accepted' OR paid_inc_tax_yen=0 OR acceptance_on IS NOT NULL
- トリガー joint_milestone_immutable: 更新の前
- トリガー joint_milestone_no_delete: 削除の前

## mg_contract_links

**受取MGと支払MGの関連** — 1行は、受取MGの契約と支払MGの契約を関連づけた記録。関連だけを持ち、回収の条件は写さない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | incoming_contract_id | INTEGER | 受取MGの契約（mg_incoming_contracts） | 不可 | - | FK（複合）→ mg_incoming_contracts |
| 4 | outgoing_contract_id | INTEGER | 支払MGの契約（mg_outgoing_contracts） | 不可 | - | FK（複合）→ mg_outgoing_contracts |
| 5 | rationale | TEXT | 関連づけた理由 | 不可 | - | - |
| 6 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 7 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, incoming_contract_id, outgoing_contract_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, outgoing_contract_id) → mg_outgoing_contracts(org_id, id)
- 複合の参照: (org_id, incoming_contract_id) → mg_incoming_contracts(org_id, id)

## mg_incoming_contracts

**受取MGの契約** — 1行は、販売先から MG を受け取る契約（受取MG）1件。条件は条件版（mg_term_versions）で持ち、変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | code | TEXT | 契約コード（組織の中で一意） | 不可 | - | - |
| 4 | title | TEXT | 契約名 | 不可 | - | - |
| 5 | partner_id | INTEGER | 販売先（partners） | 不可 | - | FK（複合）→ partners |
| 6 | contract_date | TEXT | 契約締結日 | 不可 | - | - |
| 7 | source_reference | TEXT | 契約資料の参照 | 不可 | - | - |
| 8 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 9 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, code)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- トリガー mg_incoming_no_delete: 削除の前
- トリガー mg_incoming_no_update: 更新の前

## mg_ledger_entries

**MGの当期報告** — 1行は、MG条件版×商品の当期の報告1件（消化対象・実充当・超過報告・計上）。直すときは訂正版の行を足し、訂正前の行は合計に含めない。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | term_version_id | INTEGER | MGの条件版（mg_version_products と組で参照） | 不可 | - | FK（複合）→ mg_version_products |
| 4 | product_id | INTEGER | 商品（products） | 不可 | - | FK（複合）→ mg_version_products |
| 5 | period_from | TEXT | 報告の対象期間の開始日 | 不可 | - | - |
| 6 | period_to | TEXT | 報告の対象期間の終了日 | 不可 | - | - |
| 7 | report_received_on | TEXT | 報告を実際に受け取った日 | 可 | - | - |
| 8 | accounting_month | TEXT（年月 YYYY-MM） | 計上月 | 不可 | - | - |
| 9 | source_reference | TEXT | 報告資料の参照 | 不可 | - | - |
| 10 | reported_eligible_yen | INTEGER | 消化対象（当期の分配金。円・税抜）。累計ではない | 不可 | - | CHECK: reported_eligible_yen>=0 |
| 11 | applied_recoup_yen | INTEGER | 実充当（MG に充てた額。円・税抜） | 不可 | - | CHECK: applied_recoup_yen>=0 |
| 12 | reported_overage_yen | INTEGER | 超過報告（MG を超えたと報告された額。円・税抜） | 不可 | - | CHECK: reported_overage_yen>=0 |
| 13 | recognized_yen | INTEGER | 計上（報告書の計上額。円。税込か税抜かは未確認） | 不可 | - | CHECK: recognized_yen>=0 |
| 14 | status | TEXT（列挙） | 確認状態（unverified 未確認・reviewed 確認済み） | 不可 | - | 値: unverified / reviewed |
| 15 | acknowledgement | INTEGER（真偽 0/1） | 1＝手で入れた値であることを了承した | 不可 | 0 | - |
| 16 | confirmation_reason | TEXT | 確認・訂正の理由 | 可 | - | - |
| 17 | reverses_entry_id | INTEGER | 訂正元の報告（mg_ledger_entries）。この行で置き換える | 可 | - | FK（複合）→ mg_ledger_entries |
| 18 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 19 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, term_version_id, product_id, source_reference)
- 複合の一意: (org_id, reverses_entry_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, reverses_entry_id) → mg_ledger_entries(org_id, id)
- 複合の参照: (org_id, term_version_id, product_id) → mg_version_products(org_id, term_version_id, product_id)
- CHECK: period_to>=period_from
- CHECK: status='unverified' OR (acknowledgement=1 AND length(trim(confirmation_reason))>0)
- CHECK: reverses_entry_id IS NULL OR reverses_entry_id<>id
- トリガー mg_ledger_no_delete: 削除の前
- トリガー mg_ledger_no_update: 更新の前
- トリガー mg_ledger_successor_scope: 追加の前

## mg_term_versions

**MGの条件版** — 1行は、受取MGか支払MGの契約の条件の1つの版（回収方式・MG保証額・契約期間）。直すときは新しい版を足す（変更・削除はできない）。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | incoming_contract_id | INTEGER | 受取MGの契約（mg_incoming_contracts）。どちらか片方 | 可 | - | FK（複合）→ mg_incoming_contracts |
| 4 | outgoing_contract_id | INTEGER | 支払MGの契約（mg_outgoing_contracts）。どちらか片方 | 可 | - | FK（複合）→ mg_outgoing_contracts |
| 5 | version | INTEGER | 版番号。契約ごとに1から順 | 不可 | - | CHECK: version>0 |
| 6 | mode | TEXT（列挙） | 回収方式（単品・クロスリクープ・特殊条件） | 不可 | - | 値: single / cross / special |
| 7 | mg_amount_yen | INTEGER | MG保証額（円・税抜） | 不可 | - | CHECK: mg_amount_yen>=0 |
| 8 | starts_on | TEXT | 契約期間の開始日 | 不可 | - | - |
| 9 | ends_on | TEXT | 契約期間の終了日 | 不可 | - | - |
| 10 | reason | TEXT | 登録の理由 | 不可 | - | - |
| 11 | source_reference | TEXT | 条件の根拠（契約資料の参照） | 不可 | - | - |
| 12 | special_unverified | INTEGER（真偽 0/1） | 1＝特殊条件を未確認の手動条件として登録した | 不可 | 0 | - |
| 13 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 14 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, incoming_contract_id, version)
- 複合の一意: (org_id, outgoing_contract_id, version)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, outgoing_contract_id) → mg_outgoing_contracts(org_id, id)
- 複合の参照: (org_id, incoming_contract_id) → mg_incoming_contracts(org_id, id)
- CHECK: ends_on>=starts_on
- CHECK: (incoming_contract_id IS NULL)!=(outgoing_contract_id IS NULL)
- CHECK: mode='special' OR special_unverified=0
- トリガー mg_terms_no_delete: 削除の前
- トリガー mg_terms_no_update: 更新の前

## mg_version_phases

**MG条件版の日程** — 1行は、MG条件版の日程の1区間（締めの間隔・締め日・報告予定・支払予定）。区間は契約期間の全体を切れ目なく覆う。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | term_version_id | INTEGER | MGの条件版（mg_term_versions） | 不可 | - | FK（複合）→ mg_term_versions |
| 4 | phase_order | INTEGER | 区間の順番（1から） | 不可 | - | - |
| 5 | starts_on | TEXT | 区間の開始日 | 不可 | - | - |
| 6 | ends_on | TEXT | 区間の終了日 | 不可 | - | - |
| 7 | interval_months | INTEGER（列挙） | 締めの間隔（1・3・6・12か月） | 不可 | - | 値: 1 / 3 / 6 / 12 |
| 8 | close_day | TEXT | 締め日（日にち。eom は月末） | 不可 | 31 | CHECK: close_day='eom' OR (close_day NOT GLOB '*[^0-9]*' AND CAST(close_day AS INTEGER) BETWEEN 1 AND 31) |
| 9 | first_close_on | TEXT | 最初の締め日 | 不可 | - | - |
| 10 | report_offset_months | INTEGER | 報告予定は締め日の何か月後か | 不可 | - | CHECK: report_offset_months BETWEEN 0 AND 24 |
| 11 | report_day | INTEGER | 報告予定の日 | 不可 | - | CHECK: report_day BETWEEN 1 AND 31 |
| 12 | pay_offset_months | INTEGER | 支払予定は締め日の何か月後か | 不可 | - | CHECK: pay_offset_months BETWEEN 0 AND 24 |
| 13 | pay_day | INTEGER | 支払予定の日 | 不可 | - | CHECK: pay_day BETWEEN 1 AND 31 |

表の制約:

- 複合の一意: (org_id, term_version_id, phase_order)
- 複合の参照: (org_id, term_version_id) → mg_term_versions(org_id, id)
- CHECK: ends_on>=starts_on
- トリガー mg_phases_no_delete: 削除の前
- トリガー mg_phases_no_update: 更新の前

## mg_version_products

**MG条件版の商品評価** — 1行は、MG条件版に含める商品1つとその評価額。条件版の商品の評価額の合計は MG保証額と一致させる。変更・削除はできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | MGの条件版（mg_term_versions） | 不可 | - | PK（複合）、FK（複合）→ mg_term_versions |
| 3 | product_id | INTEGER | 商品（products） | 不可 | - | PK（複合）、FK（複合）→ products |
| 4 | evaluation_yen | INTEGER | 商品評価額（円・税抜）。合計が MG保証額 | 不可 | - | CHECK: evaluation_yen>=0 |

表の制約:

- 複合の主キー: (org_id, term_version_id, product_id)
- 複合の参照: (org_id, product_id) → products(org_id, id)
- 複合の参照: (org_id, term_version_id) → mg_term_versions(org_id, id)
- トリガー mg_products_no_delete: 削除の前
- トリガー mg_products_no_update: 更新の前

## rights_payment_events

**権利元への支払の記録** — 1行は、権利元（個別精算の契約の権利者）か製作委員会の参加者へ支払った記録1件。銀行とはつながず記録だけ。直すときは取消の行を足す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | settlement_contract_id | INTEGER | 個別精算の契約（settlement_contracts）。どちらか片方 | 可 | - | FK（複合）→ settlement_contracts |
| 4 | committee_snapshot_id | INTEGER | 委員会報告の保存版（committee_report_snapshots） | 可 | - | FK（複合）→ committee_report_snapshots |
| 5 | partner_id | INTEGER | 支払先（partners）。契約の権利者か報告の参加者 | 不可 | - | FK（複合）→ partners |
| 6 | amount_yen | INTEGER | 支払額（円・正の数）。税込か税抜かは未確認 | 不可 | - | CHECK: amount_yen>0 |
| 7 | paid_on | TEXT（日付 YYYY-MM-DD） | 支払日 | 不可 | - | - |
| 8 | reference | TEXT | 支払の識別番号（組織の中で一意） | 不可 | - | CHECK: length(trim(reference)) BETWEEN 1 AND 160 |
| 9 | reverses_event_id | INTEGER | 取り消す支払（rights_payment_events） | 可 | - | FK（複合）→ rights_payment_events |
| 10 | reason | TEXT | 支払の根拠、または取消の理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, reference)
- 複合の一意: (org_id, reverses_event_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, reverses_event_id) → rights_payment_events(org_id, id)
- 複合の参照: (org_id, partner_id) → partners(org_id, id)
- 複合の参照: (org_id, committee_snapshot_id) → committee_report_snapshots(org_id, id)
- 複合の参照: (org_id, settlement_contract_id) → settlement_contracts(org_id, id)
- CHECK: (settlement_contract_id IS NOT NULL)+(committee_snapshot_id IS NOT NULL)=1
- トリガー rights_payments_no_delete: 削除の前
- トリガー rights_payments_no_update: 更新の前
- トリガー rights_payments_validate: 追加の前

## royalty_agreements

**ロイヤリティ契約** — 1行は、作品×権利者×種別（監督料・脚本料など）のロイヤリティ契約。ロイヤリティ契約の画面で登録し、変更も削除もできない（条件とサイクルは版を足して変える）。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | project_id | INTEGER | 作品の案件（projects）。work_id と組で作品を指す | 不可 | - | FK（複合）→ works |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ works |
| 5 | holder_partner_id | INTEGER | 権利者（partners）。報告書と支払の相手 | 不可 | - | FK（複合）→ partners |
| 6 | category | TEXT（列挙） | 種別（監督料・脚本料・音楽著作権料・原作料・クリエーター報酬・その他） | 不可 | - | 値: director / screenplay / music / original / creator / other |
| 7 | agreement_code | TEXT | 契約コード（組織の中で一意） | 不可 | - | CHECK: length(trim(agreement_code)) BETWEEN 1 AND 60 |
| 8 | title | TEXT | 契約名 | 不可 | - | CHECK: length(trim(title)) BETWEEN 1 AND 200 |
| 9 | document_reference | TEXT | 契約書の参照先 | 可 | - | CHECK: document_reference IS NULL OR length(document_reference)<=500 |
| 10 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(note)<=1000 |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, agreement_code)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, holder_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- 索引 royalty_agreements_by_holder: (org_id, holder_partner_id)
- 索引 royalty_agreements_by_work: (org_id, work_id)
- トリガー royalty_agreements_no_delete: 削除の前
- トリガー royalty_agreements_no_replace: 追加の前
- トリガー royalty_agreements_no_update: 更新の前

## royalty_irregular_entries

**ロイヤリティのイレギュラー** — 1行は、権利者の報告書に効かせるイレギュラーの記録（金額の調整・締め月の変更・保留・保留の解除・記録だけ）。取消は同じ内容で取消の行を足す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | holder_partner_id | INTEGER | 権利者（partners） | 不可 | - | FK（複合）→ partners |
| 4 | agreement_id | INTEGER | ロイヤリティ契約（royalty_agreements）。調整と記録は空でもよい | 可 | - | FK（複合）→ royalty_agreements |
| 5 | kind | TEXT（列挙） | 種類（金額の調整・締め月の変更・保留・保留を解く・記録だけ） | 不可 | - | 値: adjust_amount / move_period / hold / release / note |
| 6 | accrual_month | TEXT | 対象の計上月 | 可 | - | CHECK: accrual_month IS NULL OR (accrual_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(accrual_month,6,2) BETWEEN '01' AND '12') |
| 7 | close_month | TEXT | 調整を入れる締め月、または移し先の締め月 | 可 | - | CHECK: close_month IS NULL OR (close_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(close_month,6,2) BETWEEN '01' AND '12') |
| 8 | amount_yen | INTEGER | 調整額（円・税抜）。金額の調整のときだけ | 可 | - | - |
| 9 | reason | TEXT | 理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 10 | source_reference | TEXT | 根拠の資料 | 可 | - | CHECK: source_reference IS NULL OR length(source_reference)<=200 |
| 11 | reverses_entry_id | INTEGER | 取り消す記録（royalty_irregular_entries） | 可 | - | FK（複合）→ royalty_irregular_entries |
| 12 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 13 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, reverses_entry_id) → royalty_irregular_entries(org_id, id)
- 複合の参照: (org_id, agreement_id) → royalty_agreements(org_id, id)
- 複合の参照: (org_id, holder_partner_id) → partners(org_id, id)
- CHECK: (kind='adjust_amount' AND close_month IS NOT NULL AND amount_yen IS NOT NULL AND amount_yen<>0) OR (kind='move_period' AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND close_month IS NOT NULL AND close_month>=accrual_month AND amount_yen IS NULL) OR (kind IN ('hold','release') AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND close_month IS NULL AND amount_yen IS NULL) OR (kind='note' AND amount_yen IS NULL)
- 索引 royalty_irregular_entries_by_holder: (org_id, holder_partner_id)
- 索引 royalty_irregular_entries_reversal: (org_id, reverses_entry_id) 一意 WHERE reverses_entry_id IS NOT NULL
- トリガー royalty_irregular_entries_no_delete: 削除の前
- トリガー royalty_irregular_entries_no_replace: 追加の前
- トリガー royalty_irregular_entries_no_update: 更新の前
- トリガー royalty_irregular_entries_valid: 追加の前

## royalty_manual_accruals

**ロイヤリティの実額計上** — 1行は、計算方法が実額入力の契約に、計上月の実額を入れた記録（音楽著作権料の分配明細など）。直すときは符号を逆にした取消の行を足す。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | agreement_id | INTEGER | ロイヤリティ契約（royalty_agreements） | 不可 | - | FK（複合）→ royalty_agreements |
| 4 | accrual_month | TEXT | 計上月 | 不可 | - | CHECK: accrual_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(accrual_month,6,2) BETWEEN '01' AND '12' |
| 5 | amount_yen | INTEGER | 計上額（円・税抜）。取消の行は符号が逆 | 不可 | - | CHECK: amount_yen<>0 |
| 6 | source_reference | TEXT | 元資料（分配明細など）の参照 | 不可 | - | CHECK: length(trim(source_reference)) BETWEEN 1 AND 200 |
| 7 | reason | TEXT | 入れた理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 8 | reverses_entry_id | INTEGER | 取り消す元の行（royalty_manual_accruals） | 可 | - | FK（複合）→ royalty_manual_accruals |
| 9 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 10 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, reverses_entry_id) → royalty_manual_accruals(org_id, id)
- 複合の参照: (org_id, agreement_id) → royalty_agreements(org_id, id)
- 索引 royalty_manual_accruals_reversal: (org_id, reverses_entry_id) 一意 WHERE reverses_entry_id IS NOT NULL
- 索引 royalty_manual_accruals_source: (org_id, agreement_id, accrual_month, source_reference) 一意 WHERE reverses_entry_id IS NULL
- トリガー royalty_manual_accruals_no_delete: 削除の前
- トリガー royalty_manual_accruals_no_replace: 追加の前
- トリガー royalty_manual_accruals_no_update: 更新の前
- トリガー royalty_manual_accruals_reversal: 追加の前

## royalty_schedule_phases

**サイクルのフェーズ** — 1行は、サイクルの版の中の1つの期間（フェーズ）の締め方。計上月から締め月を決め、締め月から報告期限と支払期限を出す。同じ版の中で期間は重ならない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | schedule_version_id | INTEGER | サイクルの版（royalty_schedule_versions） | 不可 | - | FK（複合）→ royalty_schedule_versions |
| 4 | starts_month | TEXT | フェーズの開始の計上月 | 不可 | - | CHECK: starts_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(starts_month,6,2) BETWEEN '01' AND '12' |
| 5 | ends_month | TEXT | フェーズの終わりの計上月。空はその後ずっと | 可 | - | CHECK: ends_month IS NULL OR (ends_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(ends_month,6,2) BETWEEN '01' AND '12') |
| 6 | cycle_kind | TEXT（列挙） | 締め方（毎月・四半期・半年・1年・締め月の列挙・別途協議・計上無し） | 不可 | - | 値: monthly / quarterly / semiannual / annual / custom / manual / none |
| 7 | anchor_month | INTEGER | 締め月の1つ（1〜12）。四半期・半年・1年のとき | 可 | - | CHECK: anchor_month IS NULL OR anchor_month BETWEEN 1 AND 12 |
| 8 | custom_close_months | TEXT | 締め月の一覧（YYYY-MM をカンマ区切り）。custom のとき | 可 | - | CHECK: custom_close_months IS NULL OR length(custom_close_months) BETWEEN 7 AND 2000 |
| 9 | first_close_immediate | INTEGER（真偽 0/1） | 1＝開始の計上月をすぐ締める（初月即締） | 不可 | 0 | - |
| 10 | report_offset_months | INTEGER | 報告期限は締め月の何か月後か | 不可 | 1 | CHECK: report_offset_months BETWEEN 0 AND 24 |
| 11 | report_day | TEXT | 報告期限の日（eom は月末） | 不可 | eom | CHECK: report_day='eom' OR report_day GLOB '[1-9]' OR report_day GLOB '[12][0-9]' OR report_day GLOB '3[01]' |
| 12 | payment_offset_months | INTEGER | 支払期限は締め月の何か月後か | 不可 | 2 | CHECK: payment_offset_months BETWEEN 0 AND 24 |
| 13 | payment_day | TEXT | 支払期限の日（eom は月末） | 不可 | eom | CHECK: payment_day='eom' OR payment_day GLOB '[1-9]' OR payment_day GLOB '[12][0-9]' OR payment_day GLOB '3[01]' |
| 14 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(note)<=500 |
| 15 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 16 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, schedule_version_id) → royalty_schedule_versions(org_id, id)
- CHECK: ends_month IS NULL OR ends_month>=starts_month
- CHECK: (cycle_kind IN ('quarterly','semiannual','annual') AND anchor_month IS NOT NULL) OR (cycle_kind NOT IN ('quarterly','semiannual','annual') AND anchor_month IS NULL)
- CHECK: (cycle_kind='custom' AND custom_close_months IS NOT NULL) OR (cycle_kind<>'custom' AND custom_close_months IS NULL)
- CHECK: first_close_immediate=0 OR cycle_kind IN ('quarterly','semiannual','annual','custom')
- トリガー royalty_schedule_phases_no_delete: 削除の前
- トリガー royalty_schedule_phases_no_replace: 追加の前
- トリガー royalty_schedule_phases_no_update: 更新の前
- トリガー royalty_schedule_phases_valid: 追加の前

## royalty_schedule_versions

**ロイヤリティのサイクル版** — 1行は、ロイヤリティ契約のサイクル（締め方と期限）の1つの版。最新の版がすべての計上月の締め方を決める（確定済みの報告書は変わらない）。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | agreement_id | INTEGER | ロイヤリティ契約（royalty_agreements） | 不可 | - | FK（複合）→ royalty_agreements |
| 4 | version_no | INTEGER | 版番号。契約ごとに1から順 | 不可 | - | CHECK: version_no>0 |
| 5 | statements_from | TEXT | 報告書を作り始める締め月（移行用）。これより前の締め月は以前の仕組みで報告済みとして報告書を作らない。空はすべて作る | 可 | - | CHECK: statements_from IS NULL OR (statements_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(statements_from,6,2) BETWEEN '01' AND '12') |
| 6 | reason | TEXT | サイクルを変える理由 | 可 | - | CHECK: reason IS NULL OR length(reason)<=1000 |
| 7 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, agreement_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, agreement_id) → royalty_agreements(org_id, id)
- トリガー royalty_schedule_versions_no_delete: 削除の前
- トリガー royalty_schedule_versions_no_replace: 追加の前
- トリガー royalty_schedule_versions_no_update: 更新の前
- トリガー royalty_schedule_versions_order: 追加の前
- トリガー royalty_schedule_versions_statements_from: 追加の前

## royalty_statement_calculation_parts

**報告書の計算の分割** — 1行は、報告書の計算の内容（JSON）が大きいときに分けて保存した1片。part_no の順につなぐと元の内容になる（クラウドの DB は1つの値を128KBまでしか入れられないため）。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合）、FK → organizations.id |
| 2 | statement_id | INTEGER | 報告書（royalty_statements） | 不可 | - | PK（複合）、FK（複合）→ royalty_statements |
| 3 | part_no | INTEGER | 分割の番号。1から順 | 不可 | - | PK（複合）、CHECK: part_no>0 |
| 4 | body | TEXT | 計算の内容の一部（JSON の文字列の断片） | 不可 | - | CHECK: length(CAST(body AS BLOB)) BETWEEN 1 AND 100000 |
| 5 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, statement_id, part_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, statement_id) → royalty_statements(org_id, id)
- トリガー royalty_statement_calculation_parts_no_delete: 削除の前
- トリガー royalty_statement_calculation_parts_no_update: 更新の前
- トリガー royalty_statement_calculation_parts_valid: 追加の前

## royalty_statement_events

**報告書の報告・支払** — 1行は、ロイヤリティ報告書を実際に報告した日、または支払った日と額の記録。直すときは同じ内容の取消の記録を足す。支払の合計は支払予定額まで。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | statement_id | INTEGER | 報告書（royalty_statements） | 不可 | - | FK（複合）→ royalty_statements |
| 4 | event_kind | TEXT（列挙） | 種類（reported 報告・paid 支払） | 不可 | - | 値: reported / paid |
| 5 | occurred_on | TEXT | 報告した日、または支払日 | 不可 | - | CHECK: occurred_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' |
| 6 | amount_yen | INTEGER | 支払額（円）。支払のときだけ。合計は支払予定額まで | 可 | - | - |
| 7 | reference | TEXT | 支払の識別番号。支払のとき必須 | 可 | - | CHECK: reference IS NULL OR length(trim(reference)) BETWEEN 1 AND 200 |
| 8 | note | TEXT | メモ。取消のときは理由 | 可 | - | CHECK: note IS NULL OR length(note)<=1000 |
| 9 | reverses_event_id | INTEGER | 取り消す記録（royalty_statement_events） | 可 | - | FK（複合）→ royalty_statement_events |
| 10 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 11 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, reverses_event_id) → royalty_statement_events(org_id, id)
- 複合の参照: (org_id, statement_id) → royalty_statements(org_id, id)
- CHECK: (event_kind='reported' AND amount_yen IS NULL) OR (event_kind='paid' AND amount_yen IS NOT NULL AND amount_yen>0 AND reference IS NOT NULL)
- CHECK: reverses_event_id IS NULL OR (note IS NOT NULL AND length(trim(note))>0)
- 索引 royalty_statement_events_by_statement: (org_id, statement_id)
- 索引 royalty_statement_events_reversal: (org_id, reverses_event_id) 一意 WHERE reverses_event_id IS NOT NULL
- トリガー royalty_statement_events_no_delete: 削除の前
- トリガー royalty_statement_events_no_replace: 追加の前
- トリガー royalty_statement_events_no_update: 更新の前
- トリガー royalty_statement_events_valid: 追加の前

## royalty_statement_lines

**報告書の明細** — 1行は、ロイヤリティ報告書の確定版の明細の1行（当期の計上・報告後の修正・調整・前払金の充当）。確定版と同時に書き、種類ごとの和が確定版の金額と一致する。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | statement_id | INTEGER | 報告書（royalty_statements） | 不可 | - | FK（複合）→ royalty_statements |
| 4 | line_no | INTEGER | 報告書の中の行番号 | 不可 | - | CHECK: line_no>0 |
| 5 | line_kind | TEXT（列挙） | 種類（当期の計上・報告後の修正や遅れて締めた分・調整・前払金の充当） | 不可 | - | 値: accrual / revision / adjustment / advance_recoup |
| 6 | agreement_id | INTEGER | ロイヤリティ契約（royalty_agreements） | 可 | - | FK（複合）→ royalty_agreements |
| 7 | accrual_month | TEXT | 計上月。当期の計上と修正の行は必ず入る。調整の行は、もとのイレギュラーに計上月があるときだけ入る | 可 | - | CHECK: accrual_month IS NULL OR (accrual_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(accrual_month,6,2) BETWEEN '01' AND '12') |
| 8 | term_version_id | INTEGER | 使った条件版（royalty_term_versions） | 可 | - | FK（複合）→ royalty_term_versions |
| 9 | irregular_entry_id | INTEGER | もとのイレギュラー（royalty_irregular_entries） | 可 | - | FK（複合）→ royalty_irregular_entries |
| 10 | sales_yen | INTEGER | 売上（円・税抜） | 可 | - | - |
| 11 | window_fee_yen | INTEGER | 窓口手数料（円・税抜） | 可 | - | - |
| 12 | expense_yen | INTEGER | 差し引いた経費（円・税抜） | 可 | - | - |
| 13 | committee_income_yen | INTEGER | 委員会収入（円・税抜） | 可 | - | - |
| 14 | base_yen | INTEGER | 料率をかけた基礎（円・税抜） | 可 | - | - |
| 15 | rate_bps | INTEGER | 料率（bps） | 可 | - | CHECK: rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000 |
| 16 | amount_yen | INTEGER | 明細の額（円・税抜） | 不可 | - | - |
| 17 | note | TEXT | メモ | 可 | - | CHECK: note IS NULL OR length(note)<=500 |
| 18 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 19 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, statement_id, line_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, irregular_entry_id) → royalty_irregular_entries(org_id, id)
- 複合の参照: (org_id, term_version_id) → royalty_term_versions(org_id, id)
- 複合の参照: (org_id, agreement_id) → royalty_agreements(org_id, id)
- 複合の参照: (org_id, statement_id) → royalty_statements(org_id, id)
- CHECK: (line_kind IN ('accrual','revision') AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND irregular_entry_id IS NULL) OR (line_kind='adjustment' AND irregular_entry_id IS NOT NULL) OR (line_kind='advance_recoup' AND agreement_id IS NOT NULL AND accrual_month IS NULL AND irregular_entry_id IS NULL)
- 索引 royalty_statement_lines_by_agreement: (org_id, agreement_id, accrual_month)
- トリガー royalty_statement_lines_complete: 追加の後
- トリガー royalty_statement_lines_no_delete: 削除の前
- トリガー royalty_statement_lines_no_replace: 追加の前
- トリガー royalty_statement_lines_no_update: 更新の前
- トリガー royalty_statement_lines_valid: 追加の前

## royalty_statement_voids

**報告書の取消** — 1行は、ロイヤリティ報告書の確定版を取り消した記録。取り消せるのは権利者の最新の確定版で、取り消していない支払の記録が無いものだけ。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | statement_id | INTEGER | 取り消した報告書（royalty_statements） | 不可 | - | FK（複合）→ royalty_statements |
| 4 | reason | TEXT | 取り消す理由 | 不可 | - | CHECK: length(trim(reason)) BETWEEN 1 AND 1000 |
| 5 | created_by | INTEGER | 取り消した利用者 | 不可 | - | FK（複合）→ memberships |
| 6 | created_at | TEXT | 取り消した日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, statement_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, statement_id) → royalty_statements(org_id, id)
- トリガー royalty_statement_voids_no_delete: 削除の前
- トリガー royalty_statement_voids_no_replace: 追加の前
- トリガー royalty_statement_voids_no_update: 更新の前
- トリガー royalty_statement_voids_valid: 追加の前

## royalty_statements

**ロイヤリティ報告書** — 1行は、権利者×締め月のロイヤリティ報告書の確定版。前期繰越＋当期＋調整−前払金の充当＝支払予定額＋翌期繰越。取り消すと同じ締め月で次の版を作れる。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | holder_partner_id | INTEGER | 権利者（partners） | 不可 | - | FK（複合）→ partners |
| 4 | close_month | TEXT | 締め月 | 不可 | - | CHECK: close_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(close_month,6,2) BETWEEN '01' AND '12' |
| 5 | report_due_on | TEXT | 報告期限 | 可 | - | CHECK: report_due_on IS NULL OR report_due_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' |
| 6 | payment_due_on | TEXT | 支払期限 | 可 | - | CHECK: payment_due_on IS NULL OR payment_due_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' |
| 7 | version_no | INTEGER | 権利者×締め月の版番号。取り消して作り直すと増える | 不可 | - | CHECK: version_no>0 |
| 8 | previous_statement_id | INTEGER | 前の確定版（royalty_statements）。繰越の引き継ぎ元 | 可 | - | FK（複合）→ royalty_statements |
| 9 | calculation_version | TEXT（列挙） | 計算の版（royalty-cycle-v1） | 不可 | - | 値: royalty-cycle-v1 |
| 10 | as_of | TEXT | 作成したときの基準日 | 不可 | - | CHECK: as_of GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' |
| 11 | input_hash | TEXT | 計算の入力（明細・合計・保留）の SHA-256 | 不可 | - | CHECK: length(input_hash)=64 |
| 12 | calculation_json | TEXT（JSON） | 計算の内容（JSON）。大きいときは分割の数とバイト数だけを入れ、中身は royalty_statement_calculation_parts に分けて入れる | 不可 | - | - |
| 13 | royalty_yen | INTEGER | 当期のロイヤリティ（円・税抜）。当期と修正の明細の和 | 不可 | - | - |
| 14 | adjustment_yen | INTEGER | 調整（円・税抜）。イレギュラーの調整の明細の和 | 不可 | - | - |
| 15 | advance_recouped_yen | INTEGER | 前払金の充当（円・税抜） | 不可 | - | - |
| 16 | carried_in_yen | INTEGER | 前期繰越（円・税抜）。前の確定版の翌期繰越 | 不可 | - | - |
| 17 | payable_yen | INTEGER | 支払予定額（円・税抜） | 不可 | - | CHECK: payable_yen>=0 |
| 18 | carried_out_yen | INTEGER | 翌期繰越（円・税抜）。下限未満やマイナスの残高 | 不可 | - | - |
| 19 | hold_count | INTEGER | 締め月の時点で解決していない保留の件数（算定できない売上・サイクル未設定・保留の記録など） | 不可 | - | CHECK: hold_count>=0 |
| 20 | line_count | INTEGER | 明細の行数 | 不可 | - | CHECK: line_count>=0 |
| 21 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 22 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, holder_partner_id, close_month, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, previous_statement_id) → royalty_statements(org_id, id)
- 複合の参照: (org_id, holder_partner_id) → partners(org_id, id)
- CHECK: carried_in_yen+royalty_yen+adjustment_yen-advance_recouped_yen=payable_yen+carried_out_yen
- CHECK: line_count>0 OR (royalty_yen=0 AND adjustment_yen=0 AND advance_recouped_yen=0)
- 索引 royalty_statements_by_holder: (org_id, holder_partner_id, close_month)
- トリガー royalty_statements_no_delete: 削除の前
- トリガー royalty_statements_no_replace: 追加の前
- トリガー royalty_statements_no_update: 更新の前
- トリガー royalty_statements_valid: 追加の前

## royalty_term_channels

**条件版の対象流通** — 1行は、ロイヤリティ条件版が対象にする流通の1つ。行が無い条件版はすべての流通が対象。報告書で使う前の最新の版にだけ足せる。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 条件版（royalty_term_versions） | 不可 | - | PK（複合）、FK（複合）→ royalty_term_versions |
| 3 | channel_group | TEXT（列挙） | 対象の流通（劇場・レンタル・セル・配信・放送・海外・その他） | 不可 | - | PK（複合）、値: theatrical / rental / sell / digital / broadcast / overseas / other |
| 4 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 5 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, term_version_id, channel_group)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, term_version_id) → royalty_term_versions(org_id, id)
- トリガー royalty_term_channels_latest: 追加の前
- トリガー royalty_term_channels_no_delete: 削除の前
- トリガー royalty_term_channels_no_replace: 追加の前
- トリガー royalty_term_channels_no_update: 更新の前

## royalty_term_expense_categories

**条件版の控除費目** — 1行は、経費を差し引く基礎のロイヤリティ条件版で、差し引く経費の費目の1つ。行が無ければ、その作品×計上月の経費すべてを差し引く。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | term_version_id | INTEGER | 条件版（royalty_term_versions）。経費を引く基礎の版だけ | 不可 | - | PK（複合）、FK（複合）→ royalty_term_versions |
| 3 | category | TEXT | 差し引く経費の費目名 | 不可 | - | PK（複合）、CHECK: length(trim(category)) BETWEEN 1 AND 100 |
| 4 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 5 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, term_version_id, category)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, term_version_id) → royalty_term_versions(org_id, id)
- トリガー royalty_term_expense_categories_base: 追加の前
- トリガー royalty_term_expense_categories_latest: 追加の前
- トリガー royalty_term_expense_categories_no_delete: 削除の前
- トリガー royalty_term_expense_categories_no_replace: 追加の前
- トリガー royalty_term_expense_categories_no_update: 更新の前

## royalty_term_versions

**ロイヤリティ条件版** — 1行は、ロイヤリティ契約の計算条件の1つの版（料率・基礎・前払金・支払の下限）。適用開始の計上月から効き、直すときは新しい版を足す（変更・削除はできない）。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | FK → organizations.id |
| 3 | agreement_id | INTEGER | ロイヤリティ契約（royalty_agreements） | 不可 | - | FK（複合）→ royalty_agreements |
| 4 | version_no | INTEGER | 版番号。契約ごとに1から順 | 不可 | - | CHECK: version_no>0 |
| 5 | effective_from | TEXT | 適用開始の計上月（YYYY-MM）。前の版より後の月 | 不可 | - | CHECK: effective_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(effective_from,6,2) BETWEEN '01' AND '12' |
| 6 | calc_method | TEXT（列挙） | 計算方法（料率・毎月定額・実額入力） | 不可 | - | 値: rate / fixed_monthly / manual |
| 7 | base_kind | TEXT（列挙） | 料率をかける基礎（gross_sales 売上・after_window_fee 売上−窓口手数料・after_window_fee_and_expenses 売上−窓口手数料−経費・committee_income 本委員会収入・committee_income_after_expenses 本委員会収入−経費）。計算方法が料率のときだけ | 可 | - | 値: gross_sales / after_window_fee / after_window_fee_and_expenses / committee_income / committee_income_after_expenses |
| 8 | rate_bps | INTEGER | 料率（bps。10000＝100%） | 可 | - | CHECK: rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000 |
| 9 | window_fee_bps | INTEGER | 窓口手数料率（bps）。基礎が窓口手数料を引くときだけ | 可 | - | CHECK: window_fee_bps IS NULL OR window_fee_bps BETWEEN 0 AND 10000 |
| 10 | fixed_amount_yen | INTEGER | 毎月の定額（円・税抜）。毎月定額のときだけ | 可 | - | CHECK: fixed_amount_yen IS NULL OR fixed_amount_yen>=0 |
| 11 | advance_yen | INTEGER | 前払金（円・税抜）。ロイヤリティから充当する。なしは0 | 不可 | 0 | CHECK: advance_yen>=0 |
| 12 | min_payment_yen | INTEGER | 支払の下限（円・税抜）。未満は翌期へ繰り越す | 可 | - | CHECK: min_payment_yen IS NULL OR min_payment_yen>=0 |
| 13 | clause_reference | TEXT | 根拠の条項（契約書のどこに書いてあるか） | 不可 | - | CHECK: length(trim(clause_reference)) BETWEEN 1 AND 500 |
| 14 | reason | TEXT | 条件を変える理由 | 可 | - | CHECK: reason IS NULL OR length(reason)<=1000 |
| 15 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 16 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, agreement_id, version_no)
- 複合の一意: (org_id, agreement_id, effective_from)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, agreement_id) → royalty_agreements(org_id, id)
- CHECK: (calc_method='rate' AND base_kind IS NOT NULL AND rate_bps IS NOT NULL AND fixed_amount_yen IS NULL AND ( (base_kind IN ('after_window_fee','after_window_fee_and_expenses') AND window_fee_bps IS NOT NULL) OR (base_kind NOT IN ('after_window_fee','after_window_fee_and_expenses') AND window_fee_bps IS NULL))) OR (calc_method='fixed_monthly' AND fixed_amount_yen IS NOT NULL AND base_kind IS NULL AND rate_bps IS NULL AND window_fee_bps IS NULL) OR (calc_method='manual' AND base_kind IS NULL AND rate_bps IS NULL AND window_fee_bps IS NULL AND fixed_amount_yen IS NULL)
- トリガー royalty_term_versions_no_delete: 削除の前
- トリガー royalty_term_versions_no_replace: 追加の前
- トリガー royalty_term_versions_no_update: 更新の前
- トリガー royalty_term_versions_order: 追加の前

## settlement_contracts

**分配契約** — 作品ごとの権利・分配の契約1件。精算の画面で作る。案件・作品・種別・権利元・MG契約額・MG実支払額は書き換えられない（トリガーで止める）。料率などの条件は条件版に持つ

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | project_id | INTEGER | 案件（projects） | 不可 | - | FK（複合）→ works |
| 4 | work_id | INTEGER | 作品（works） | 不可 | - | FK（複合）→ works |
| 5 | contract_code | TEXT | 契約コード（組織内で一意） | 不可 | - | - |
| 6 | title | TEXT | 契約名 | 不可 | - | - |
| 7 | contract_type | TEXT（列挙） | 種別（手数料型・MG調達型・自社権利型） | 不可 | - | 値: commission / mg / self_owned |
| 8 | holder_partner_id | INTEGER | 権利元の取引先（partners）。自社権利型は空 | 可 | - | FK（複合）→ partners |
| 9 | mg_contract_yen | INTEGER | MG契約額（円）。MG調達型だけ。税の扱いは未確認 | 可 | - | - |
| 10 | mg_paid_yen | INTEGER | MGの実支払額（円）。契約額以下。MG調達型だけ | 可 | - | - |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, id, work_id)
- 複合の一意: (org_id, contract_code)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, holder_partner_id) → partners(org_id, id)
- 複合の参照: (org_id, project_id, work_id) → works(org_id, project_id, id)
- CHECK: (contract_type='commission' AND holder_partner_id IS NOT NULL AND mg_contract_yen IS NULL AND mg_paid_yen IS NULL) OR (contract_type='mg' AND holder_partner_id IS NOT NULL AND mg_contract_yen IS NOT NULL AND mg_contract_yen>=0 AND (mg_paid_yen IS NULL OR (mg_paid_yen>=0 AND mg_paid_yen<=mg_contract_yen))) OR (contract_type='self_owned' AND holder_partner_id IS NULL AND mg_contract_yen IS NULL AND mg_paid_yen IS NULL)
- トリガー settlement_contract_core_immutable: 更新（project_id,work_id,contract_type,holder_partner_id,mg_contract_yen,mg_paid_yen）の前

## settlement_report_links

**報告と分配契約の紐付け** — 売上報告を、作品ごとにどの分配契約・条件版で精算するかの紐付け1件。精算の画面で作る。有効な報告だけを使え、製作委員会の報告に使った報告は使えない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | PK（複合） |
| 2 | report_id | INTEGER | 売上報告（report_imports） | 不可 | - | PK（複合）、FK（複合）→ report_imports |
| 3 | work_id | INTEGER | 作品（works） | 不可 | - | PK（複合）、FK（複合）→ settlement_contracts、FK（複合）→ works |
| 4 | contract_id | INTEGER | 分配契約（settlement_contracts） | 不可 | - | FK（複合）→ settlement_term_versions、FK（複合）→ settlement_contracts |
| 5 | term_version_id | INTEGER | 使う条件版（settlement_term_versions） | 不可 | - | FK（複合）→ settlement_term_versions |
| 6 | report_basis | TEXT（列挙） | 報告額の基準。gross＝控除前、net＝控除後 | 不可 | - | 値: gross / net |
| 7 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 8 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の主キー: (org_id, report_id, work_id)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, contract_id, term_version_id) → settlement_term_versions(org_id, contract_id, id)
- 複合の参照: (org_id, contract_id, work_id) → settlement_contracts(org_id, id, work_id)
- 複合の参照: (org_id, work_id) → works(org_id, id)
- 複合の参照: (org_id, report_id) → report_imports(org_id, id)
- トリガー billed_report_no_gross_settlement: 追加の前
- トリガー settlement_report_basis_consistent: 追加の前
- トリガー settlement_report_no_committee: 追加の前

## settlement_term_versions

**分配契約の条件版** — 分配契約の条件（料率など）の版1件。契約を作るときに版1を作り、改訂は新しい版を足す。変更も削除もできない。

| No | カラム名 | データ型 | 説明 | NULL | デフォルト値 | 制約 |
|---|---|---|---|---|---|---|
| 1 | id | INTEGER | 行のID | 不可 | - | PK |
| 2 | org_id | INTEGER | 組織（organizations）。データの持ち主 | 不可 | - | - |
| 3 | contract_id | INTEGER | 分配契約（settlement_contracts） | 不可 | - | FK（複合）→ settlement_contracts |
| 4 | version_no | INTEGER | 契約の中の版番号（1から） | 不可 | - | CHECK: version_no>0 |
| 5 | platform_rate_bps | INTEGER | プラットフォーム料率（bps）。控除前の報告額から引く | 不可 | - | CHECK: platform_rate_bps BETWEEN 0 AND 10000 |
| 6 | agency_fee_bps | INTEGER | 代理店手数料率（bps）。自社権利型は空 | 可 | - | CHECK: agency_fee_bps IS NULL OR agency_fee_bps BETWEEN 0 AND 10000 |
| 7 | recoup_basis | TEXT（列挙） | MG回収に充てる額（料率控除後か手数料控除後か）。MG型だけ | 可 | - | 値: platform_net / after_fee |
| 8 | overage_enabled | INTEGER（真偽 0/1） | MG超過後の追加分配の有無（0/1）。いまは常に空 | 可 | - | - |
| 9 | overage_rate_bps | INTEGER | MG超過後の追加分配の料率（bps）。いまは常に空 | 可 | - | CHECK: overage_rate_bps IS NULL OR overage_rate_bps BETWEEN 0 AND 10000 |
| 10 | note | TEXT | 条件のメモ（1000字まで） | 可 | - | - |
| 11 | created_by | INTEGER | 作成した利用者（users） | 不可 | - | FK（複合）→ memberships |
| 12 | created_at | TEXT | 作成日時 | 不可 | 現在時刻 | - |

表の制約:

- 複合の一意: (org_id, id)
- 複合の一意: (org_id, contract_id, id)
- 複合の一意: (org_id, contract_id, version_no)
- 複合の参照: (org_id, created_by) → memberships(org_id, user_id)
- 複合の参照: (org_id, contract_id) → settlement_contracts(org_id, id)
- CHECK: (overage_enabled IS NULL AND overage_rate_bps IS NULL) OR (overage_enabled=0 AND overage_rate_bps IS NULL) OR (overage_enabled=1 AND overage_rate_bps IS NOT NULL)
- トリガー settlement_terms_immutable_delete: 削除の前
- トリガー settlement_terms_immutable_update: 更新の前
- トリガー settlement_terms_validate: 追加の前
