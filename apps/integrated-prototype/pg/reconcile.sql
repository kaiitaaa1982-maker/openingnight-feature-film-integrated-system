-- 生成物。手で直さない。scripts/pg-ddl.mjs が migrations/ と APP_DDL_SOURCES の表から作る（香盤表 #27。切り替えの照合 FR-CORE-DATA-045）
-- 表ごとの件数と、金額の列（整数の列で、名前の終わりが yen・amount・tax・price・fee・total・cost・budget）の合計だけを出す。値の行は出さない
-- SQLite（D1）と PostgreSQL の両方で同じ結果になる（両方に流して、行ごとに比べる）。PostgreSQL だけの版の印の表は入れない
-- 表 389・金額の列 151
SELECT 1 AS ord, 'acq_mg_contracts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM acq_mg_contracts
UNION ALL SELECT 2 AS ord, 'acq_mg_documents' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM acq_mg_documents
UNION ALL SELECT 3 AS ord, 'acq_mg_payment_schedule' AS table_name, COUNT(*) AS row_count, 'amount=' || CAST(COALESCE(SUM(amount), 0) AS TEXT) AS money_sums FROM acq_mg_payment_schedule
UNION ALL SELECT 4 AS ord, 'acq_mg_payments' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) || ';' || 'foreign_amount=' || CAST(COALESCE(SUM(foreign_amount), 0) AS TEXT) AS money_sums FROM acq_mg_payments
UNION ALL SELECT 5 AS ord, 'acq_mg_report_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM acq_mg_report_links
UNION ALL SELECT 6 AS ord, 'acq_mg_statements' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM acq_mg_statements
UNION ALL SELECT 7 AS ord, 'acq_mg_term_deductions' AS table_name, COUNT(*) AS row_count, 'cap_amount=' || CAST(COALESCE(SUM(cap_amount), 0) AS TEXT) AS money_sums FROM acq_mg_term_deductions
UNION ALL SELECT 8 AS ord, 'acq_mg_term_media_allocations' AS table_name, COUNT(*) AS row_count, 'amount=' || CAST(COALESCE(SUM(amount), 0) AS TEXT) AS money_sums FROM acq_mg_term_media_allocations
UNION ALL SELECT 9 AS ord, 'acq_mg_term_phases' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM acq_mg_term_phases
UNION ALL SELECT 10 AS ord, 'acq_mg_term_versions' AS table_name, COUNT(*) AS row_count, 'mg_amount=' || CAST(COALESCE(SUM(mg_amount), 0) AS TEXT) AS money_sums FROM acq_mg_term_versions
UNION ALL SELECT 11 AS ord, 'acq_mg_term_works' AS table_name, COUNT(*) AS row_count, 'preset_amount=' || CAST(COALESCE(SUM(preset_amount), 0) AS TEXT) AS money_sums FROM acq_mg_term_works
UNION ALL SELECT 12 AS ord, 'action_steps' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM action_steps
UNION ALL SELECT 13 AS ord, 'ai_usage' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM ai_usage
UNION ALL SELECT 14 AS ord, 'audit_log' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM audit_log
UNION ALL SELECT 15 AS ord, 'bank_accounts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM bank_accounts
UNION ALL SELECT 16 AS ord, 'bank_statement_imports' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM bank_statement_imports
UNION ALL SELECT 17 AS ord, 'bank_statement_lines' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) || ';' || 'balance_after_yen=' || CAST(COALESCE(SUM(balance_after_yen), 0) AS TEXT) AS money_sums FROM bank_statement_lines
UNION ALL SELECT 18 AS ord, 'billing_invoice_line_works' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM billing_invoice_line_works
UNION ALL SELECT 19 AS ord, 'billing_invoice_lines' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) || ';' || 'tax_amount=' || CAST(COALESCE(SUM(tax_amount), 0) AS TEXT) || ';' || 'amount_inc_tax=' || CAST(COALESCE(SUM(amount_inc_tax), 0) AS TEXT) AS money_sums FROM billing_invoice_lines
UNION ALL SELECT 20 AS ord, 'billing_invoice_sequences' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM billing_invoice_sequences
UNION ALL SELECT 21 AS ord, 'billing_invoice_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM billing_invoice_voids
UNION ALL SELECT 22 AS ord, 'billing_invoices' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) || ';' || 'tax_amount=' || CAST(COALESCE(SUM(tax_amount), 0) AS TEXT) || ';' || 'amount_inc_tax=' || CAST(COALESCE(SUM(amount_inc_tax), 0) AS TEXT) AS money_sums FROM billing_invoices
UNION ALL SELECT 23 AS ord, 'billing_receipt_allocations' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM billing_receipt_allocations
UNION ALL SELECT 24 AS ord, 'billing_receipt_reversals' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM billing_receipt_reversals
UNION ALL SELECT 25 AS ord, 'billing_receipts' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM billing_receipts
UNION ALL SELECT 26 AS ord, 'billing_sale_claims' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM billing_sale_claims
UNION ALL SELECT 27 AS ord, 'broadcast_airings' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_airings
UNION ALL SELECT 28 AS ord, 'broadcast_availability_previews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_availability_previews
UNION ALL SELECT 29 AS ord, 'broadcast_availability_rates' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_availability_rates
UNION ALL SELECT 30 AS ord, 'broadcast_entry_term_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_entry_term_versions
UNION ALL SELECT 31 AS ord, 'broadcast_import_previews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_import_previews
UNION ALL SELECT 32 AS ord, 'broadcast_proposal_draft_deletions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_proposal_draft_deletions
UNION ALL SELECT 33 AS ord, 'broadcast_proposal_drafts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_proposal_drafts
UNION ALL SELECT 34 AS ord, 'broadcast_sale_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_sale_links
UNION ALL SELECT 35 AS ord, 'broadcast_slot_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_slot_versions
UNION ALL SELECT 36 AS ord, 'broadcast_slots' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_slots
UNION ALL SELECT 37 AS ord, 'broadcast_station_type_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM broadcast_station_type_versions
UNION ALL SELECT 38 AS ord, 'budget_check_runs' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM budget_check_runs
UNION ALL SELECT 39 AS ord, 'budget_fixes' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM budget_fixes
UNION ALL SELECT 40 AS ord, 'budget_line_items' AS table_name, COUNT(*) AS row_count, 'unit_price_yen=' || CAST(COALESCE(SUM(unit_price_yen), 0) AS TEXT) || ';' || 'amount_ex_tax_yen=' || CAST(COALESCE(SUM(amount_ex_tax_yen), 0) AS TEXT) AS money_sums FROM budget_line_items
UNION ALL SELECT 41 AS ord, 'budget_template_items' AS table_name, COUNT(*) AS row_count, 'unit_price_yen=' || CAST(COALESCE(SUM(unit_price_yen), 0) AS TEXT) AS money_sums FROM budget_template_items
UNION ALL SELECT 42 AS ord, 'budget_template_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM budget_template_versions
UNION ALL SELECT 43 AS ord, 'budget_templates' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM budget_templates
UNION ALL SELECT 44 AS ord, 'budget_version_lines' AS table_name, COUNT(*) AS row_count, 'unit_price_yen=' || CAST(COALESCE(SUM(unit_price_yen), 0) AS TEXT) || ';' || 'amount_ex_tax_yen=' || CAST(COALESCE(SUM(amount_ex_tax_yen), 0) AS TEXT) AS money_sums FROM budget_version_lines
UNION ALL SELECT 45 AS ord, 'budget_version_templates' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM budget_version_templates
UNION ALL SELECT 46 AS ord, 'budget_versions' AS table_name, COUNT(*) AS row_count, 'management_fee_yen=' || CAST(COALESCE(SUM(management_fee_yen), 0) AS TEXT) || ';' || 'contingency_yen=' || CAST(COALESCE(SUM(contingency_yen), 0) AS TEXT) AS money_sums FROM budget_versions
UNION ALL SELECT 47 AS ord, 'bulk_import_batches' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM bulk_import_batches
UNION ALL SELECT 48 AS ord, 'bulk_import_previews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM bulk_import_previews
UNION ALL SELECT 49 AS ord, 'campaigns' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM campaigns
UNION ALL SELECT 50 AS ord, 'cashflow_categories' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM cashflow_categories
UNION ALL SELECT 51 AS ord, 'catalog_credits' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM catalog_credits
UNION ALL SELECT 52 AS ord, 'catalog_edition_tags' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM catalog_edition_tags
UNION ALL SELECT 53 AS ord, 'catalog_editions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM catalog_editions
UNION ALL SELECT 54 AS ord, 'catalog_product_editions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM catalog_product_editions
UNION ALL SELECT 55 AS ord, 'catalog_product_windows' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM catalog_product_windows
UNION ALL SELECT 56 AS ord, 'catalog_profiles' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM catalog_profiles
UNION ALL SELECT 57 AS ord, 'change_proposals' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM change_proposals
UNION ALL SELECT 58 AS ord, 'chotatsu_agreements' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_agreements
UNION ALL SELECT 59 AS ord, 'chotatsu_case_expenses' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_case_expenses
UNION ALL SELECT 60 AS ord, 'chotatsu_case_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_case_versions
UNION ALL SELECT 61 AS ord, 'chotatsu_cases' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_cases
UNION ALL SELECT 62 AS ord, 'chotatsu_contracts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_contracts
UNION ALL SELECT 63 AS ord, 'chotatsu_documents' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_documents
UNION ALL SELECT 64 AS ord, 'chotatsu_estimate_lines' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax_yen=' || CAST(COALESCE(SUM(amount_ex_tax_yen), 0) AS TEXT) AS money_sums FROM chotatsu_estimate_lines
UNION ALL SELECT 65 AS ord, 'chotatsu_estimates' AS table_name, COUNT(*) AS row_count, 'list_price_ex_tax_yen=' || CAST(COALESCE(SUM(list_price_ex_tax_yen), 0) AS TEXT) || ';' || 'unit_revenue_ex_tax_yen=' || CAST(COALESCE(SUM(unit_revenue_ex_tax_yen), 0) AS TEXT) || ';' || 'royalty_per_unit_yen=' || CAST(COALESCE(SUM(royalty_per_unit_yen), 0) AS TEXT) AS money_sums FROM chotatsu_estimates
UNION ALL SELECT 66 AS ord, 'chotatsu_handoff_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_handoff_events
UNION ALL SELECT 67 AS ord, 'chotatsu_handoffs' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_handoffs
UNION ALL SELECT 68 AS ord, 'chotatsu_materials' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_materials
UNION ALL SELECT 69 AS ord, 'chotatsu_ringi' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_ringi
UNION ALL SELECT 70 AS ord, 'chotatsu_stage_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM chotatsu_stage_events
UNION ALL SELECT 71 AS ord, 'cloud_analytics_jobs' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM cloud_analytics_jobs
UNION ALL SELECT 72 AS ord, 'cloud_analytics_state' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM cloud_analytics_state
UNION ALL SELECT 73 AS ord, 'committee_contracts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_contracts
UNION ALL SELECT 74 AS ord, 'committee_investment_payments' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM committee_investment_payments
UNION ALL SELECT 75 AS ord, 'committee_ledger_entries' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM committee_ledger_entries
UNION ALL SELECT 76 AS ord, 'committee_report_previews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_report_previews
UNION ALL SELECT 77 AS ord, 'committee_report_snapshots' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_report_snapshots
UNION ALL SELECT 78 AS ord, 'committee_round_overrides' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_round_overrides
UNION ALL SELECT 79 AS ord, 'committee_schedule_phases' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_schedule_phases
UNION ALL SELECT 80 AS ord, 'committee_schedule_version_phases' AS table_name, COUNT(*) AS row_count, 'carry_under_yen=' || CAST(COALESCE(SUM(carry_under_yen), 0) AS TEXT) AS money_sums FROM committee_schedule_version_phases
UNION ALL SELECT 81 AS ord, 'committee_schedule_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_schedule_versions
UNION ALL SELECT 82 AS ord, 'committee_snapshot_deductions' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM committee_snapshot_deductions
UNION ALL SELECT 83 AS ord, 'committee_snapshot_expenses' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) AS money_sums FROM committee_snapshot_expenses
UNION ALL SELECT 84 AS ord, 'committee_snapshot_lines' AS table_name, COUNT(*) AS row_count, 'allocated_amount_ex_tax=' || CAST(COALESCE(SUM(allocated_amount_ex_tax), 0) AS TEXT) AS money_sums FROM committee_snapshot_lines
UNION ALL SELECT 85 AS ord, 'committee_snapshot_member_amounts' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM committee_snapshot_member_amounts
UNION ALL SELECT 86 AS ord, 'committee_snapshot_reports' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_snapshot_reports
UNION ALL SELECT 87 AS ord, 'committee_term_budget_lines' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM committee_term_budget_lines
UNION ALL SELECT 88 AS ord, 'committee_term_business_steps' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_business_steps
UNION ALL SELECT 89 AS ord, 'committee_term_businesses' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_businesses
UNION ALL SELECT 90 AS ord, 'committee_term_committee_steps' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_committee_steps
UNION ALL SELECT 91 AS ord, 'committee_term_funding' AS table_name, COUNT(*) AS row_count, 'production_cost_yen=' || CAST(COALESCE(SUM(production_cost_yen), 0) AS TEXT) AS money_sums FROM committee_term_funding
UNION ALL SELECT 92 AS ord, 'committee_term_investments' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM committee_term_investments
UNION ALL SELECT 93 AS ord, 'committee_term_members' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_members
UNION ALL SELECT 94 AS ord, 'committee_term_templates' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_templates
UNION ALL SELECT 95 AS ord, 'committee_term_version_effective' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_version_effective
UNION ALL SELECT 96 AS ord, 'committee_term_version_templates' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_version_templates
UNION ALL SELECT 97 AS ord, 'committee_term_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_versions
UNION ALL SELECT 98 AS ord, 'committee_term_window_fee_shares' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_window_fee_shares
UNION ALL SELECT 99 AS ord, 'committee_term_windows' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM committee_term_windows
UNION ALL SELECT 100 AS ord, 'contract_production_milestones' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM contract_production_milestones
UNION ALL SELECT 101 AS ord, 'contract_production_versions' AS table_name, COUNT(*) AS row_count, 'budget_yen=' || CAST(COALESCE(SUM(budget_yen), 0) AS TEXT) || ';' || 'fee_yen=' || CAST(COALESCE(SUM(fee_yen), 0) AS TEXT) AS money_sums FROM contract_production_versions
UNION ALL SELECT 102 AS ord, 'day_scene_assignments' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM day_scene_assignments
UNION ALL SELECT 103 AS ord, 'digital_sale_details' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM digital_sale_details
UNION ALL SELECT 104 AS ord, 'distribution_master' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM distribution_master
UNION ALL SELECT 105 AS ord, 'distribution_types' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM distribution_types
UNION ALL SELECT 106 AS ord, 'earning_type_rate_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM earning_type_rate_versions
UNION ALL SELECT 107 AS ord, 'earning_types' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM earning_types
UNION ALL SELECT 108 AS ord, 'expected_report_closures' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expected_report_closures
UNION ALL SELECT 109 AS ord, 'expected_reports' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expected_reports
UNION ALL SELECT 110 AS ord, 'expense_accounting_versions' AS table_name, COUNT(*) AS row_count, 'withholding_yen=' || CAST(COALESCE(SUM(withholding_yen), 0) AS TEXT) AS money_sums FROM expense_accounting_versions
UNION ALL SELECT 111 AS ord, 'expense_card_debits' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM expense_card_debits
UNION ALL SELECT 112 AS ord, 'expense_card_debits_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_card_debits_voids
UNION ALL SELECT 113 AS ord, 'expense_card_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_card_versions
UNION ALL SELECT 114 AS ord, 'expense_cards' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_cards
UNION ALL SELECT 115 AS ord, 'expense_categories' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_categories
UNION ALL SELECT 116 AS ord, 'expense_category_alias_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_category_alias_versions
UNION ALL SELECT 117 AS ord, 'expense_category_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_category_versions
UNION ALL SELECT 118 AS ord, 'expense_credit_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_credit_links
UNION ALL SELECT 119 AS ord, 'expense_details' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_details
UNION ALL SELECT 120 AS ord, 'expense_file_placement_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_file_placement_voids
UNION ALL SELECT 121 AS ord, 'expense_file_placements' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_file_placements
UNION ALL SELECT 122 AS ord, 'expense_import_batches' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_import_batches
UNION ALL SELECT 123 AS ord, 'expense_import_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_import_events
UNION ALL SELECT 124 AS ord, 'expense_import_row_commits' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_import_row_commits
UNION ALL SELECT 125 AS ord, 'expense_import_rows' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_import_rows
UNION ALL SELECT 126 AS ord, 'expense_import_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_import_versions
UNION ALL SELECT 127 AS ord, 'expense_invoice_file_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_invoice_file_links
UNION ALL SELECT 128 AS ord, 'expense_invoice_file_unlinks' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_invoice_file_unlinks
UNION ALL SELECT 129 AS ord, 'expense_invoice_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_invoice_versions
UNION ALL SELECT 130 AS ord, 'expense_invoices' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_invoices
UNION ALL SELECT 131 AS ord, 'expense_line_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_line_voids
UNION ALL SELECT 132 AS ord, 'expense_month_closures' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_month_closures
UNION ALL SELECT 133 AS ord, 'expense_payment_accounting' AS table_name, COUNT(*) AS row_count, 'withheld_yen=' || CAST(COALESCE(SUM(withheld_yen), 0) AS TEXT) AS money_sums FROM expense_payment_accounting
UNION ALL SELECT 134 AS ord, 'expense_payment_settlements' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_payment_settlements
UNION ALL SELECT 135 AS ord, 'expense_payments' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM expense_payments
UNION ALL SELECT 136 AS ord, 'expense_pending_resolutions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_pending_resolutions
UNION ALL SELECT 137 AS ord, 'expense_pending_rows' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_pending_rows
UNION ALL SELECT 138 AS ord, 'expense_refund_receipts' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM expense_refund_receipts
UNION ALL SELECT 139 AS ord, 'expense_refund_receipts_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_refund_receipts_voids
UNION ALL SELECT 140 AS ord, 'expense_source_files' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_source_files
UNION ALL SELECT 141 AS ord, 'expense_tax_categories' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_tax_categories
UNION ALL SELECT 142 AS ord, 'expense_tax_category_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_tax_category_versions
UNION ALL SELECT 143 AS ord, 'expense_withholding_allocations' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM expense_withholding_allocations
UNION ALL SELECT 144 AS ord, 'expense_withholding_categories' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_withholding_categories
UNION ALL SELECT 145 AS ord, 'expense_withholding_category_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_withholding_category_versions
UNION ALL SELECT 146 AS ord, 'expense_withholding_remittances' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM expense_withholding_remittances
UNION ALL SELECT 147 AS ord, 'expense_withholding_remittances_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM expense_withholding_remittances_voids
UNION ALL SELECT 148 AS ord, 'expenses' AS table_name, COUNT(*) AS row_count, 'budget_yen=' || CAST(COALESCE(SUM(budget_yen), 0) AS TEXT) || ';' || 'actual_ex_tax=' || CAST(COALESCE(SUM(actual_ex_tax), 0) AS TEXT) || ';' || 'tax_amount=' || CAST(COALESCE(SUM(tax_amount), 0) AS TEXT) || ';' || 'actual_inc_tax=' || CAST(COALESCE(SUM(actual_inc_tax), 0) AS TEXT) AS money_sums FROM expenses
UNION ALL SELECT 149 AS ord, 'exposures' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM exposures
UNION ALL SELECT 150 AS ord, 'fiscal_settings' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM fiscal_settings
UNION ALL SELECT 151 AS ord, 'gl_account_class_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM gl_account_class_versions
UNION ALL SELECT 152 AS ord, 'gl_accounts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM gl_accounts
UNION ALL SELECT 153 AS ord, 'gl_manual_amounts' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) || ';' || 'tax_yen=' || CAST(COALESCE(SUM(tax_yen), 0) AS TEXT) AS money_sums FROM gl_manual_amounts
UNION ALL SELECT 154 AS ord, 'import_previews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM import_previews
UNION ALL SELECT 155 AS ord, 'intake_settlement_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM intake_settlement_links
UNION ALL SELECT 156 AS ord, 'investment_approval_versions' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM investment_approval_versions
UNION ALL SELECT 157 AS ord, 'invitations' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM invitations
UNION ALL SELECT 158 AS ord, 'joint_business_holidays' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM joint_business_holidays
UNION ALL SELECT 159 AS ord, 'joint_committee_contracts' AS table_name, COUNT(*) AS row_count, 'production_cost_inc_tax_yen=' || CAST(COALESCE(SUM(production_cost_inc_tax_yen), 0) AS TEXT) || ';' || 'pa_inc_tax_yen=' || CAST(COALESCE(SUM(pa_inc_tax_yen), 0) AS TEXT) || ';' || 'income_threshold_yen=' || CAST(COALESCE(SUM(income_threshold_yen), 0) AS TEXT) || ';' || 'transfer_threshold_yen=' || CAST(COALESCE(SUM(transfer_threshold_yen), 0) AS TEXT) AS money_sums FROM joint_committee_contracts
UNION ALL SELECT 160 AS ord, 'joint_committee_costs' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM joint_committee_costs
UNION ALL SELECT 161 AS ord, 'joint_committee_members' AS table_name, COUNT(*) AS row_count, 'contribution_inc_tax_yen=' || CAST(COALESCE(SUM(contribution_inc_tax_yen), 0) AS TEXT) AS money_sums FROM joint_committee_members
UNION ALL SELECT 162 AS ord, 'joint_committee_periods' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM joint_committee_periods
UNION ALL SELECT 163 AS ord, 'joint_committee_sales' AS table_name, COUNT(*) AS row_count, 'amount_contract_yen=' || CAST(COALESCE(SUM(amount_contract_yen), 0) AS TEXT) || ';' || 'gross_inc_tax_yen=' || CAST(COALESCE(SUM(gross_inc_tax_yen), 0) AS TEXT) AS money_sums FROM joint_committee_sales
UNION ALL SELECT 164 AS ord, 'joint_committee_snapshots' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM joint_committee_snapshots
UNION ALL SELECT 165 AS ord, 'joint_committee_windows' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM joint_committee_windows
UNION ALL SELECT 166 AS ord, 'joint_funding_events' AS table_name, COUNT(*) AS row_count, 'amount_inc_tax_yen=' || CAST(COALESCE(SUM(amount_inc_tax_yen), 0) AS TEXT) AS money_sums FROM joint_funding_events
UNION ALL SELECT 167 AS ord, 'joint_production_milestones' AS table_name, COUNT(*) AS row_count, 'amount_inc_tax_yen=' || CAST(COALESCE(SUM(amount_inc_tax_yen), 0) AS TEXT) || ';' || 'paid_inc_tax_yen=' || CAST(COALESCE(SUM(paid_inc_tax_yen), 0) AS TEXT) AS money_sums FROM joint_production_milestones
UNION ALL SELECT 168 AS ord, 'journal_entries' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM journal_entries
UNION ALL SELECT 169 AS ord, 'journal_lines' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM journal_lines
UNION ALL SELECT 170 AS ord, 'kpi_metric_steps' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM kpi_metric_steps
UNION ALL SELECT 171 AS ord, 'kpi_metric_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM kpi_metric_versions
UNION ALL SELECT 172 AS ord, 'mapping_import_provenance' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mapping_import_provenance
UNION ALL SELECT 173 AS ord, 'memberships' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM memberships
UNION ALL SELECT 174 AS ord, 'metric_definitions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM metric_definitions
UNION ALL SELECT 175 AS ord, 'mfg_po_events' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax_yen=' || CAST(COALESCE(SUM(amount_ex_tax_yen), 0) AS TEXT) AS money_sums FROM mfg_po_events
UNION ALL SELECT 176 AS ord, 'mfg_po_expenses' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mfg_po_expenses
UNION ALL SELECT 177 AS ord, 'mfg_product_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mfg_product_versions
UNION ALL SELECT 178 AS ord, 'mfg_products' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mfg_products
UNION ALL SELECT 179 AS ord, 'mfg_purchase_order_lines' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax_yen=' || CAST(COALESCE(SUM(amount_ex_tax_yen), 0) AS TEXT) AS money_sums FROM mfg_purchase_order_lines
UNION ALL SELECT 180 AS ord, 'mfg_purchase_orders' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mfg_purchase_orders
UNION ALL SELECT 181 AS ord, 'mfg_receipts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mfg_receipts
UNION ALL SELECT 182 AS ord, 'mfg_step_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mfg_step_events
UNION ALL SELECT 183 AS ord, 'mg_contract_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mg_contract_links
UNION ALL SELECT 184 AS ord, 'mg_incoming_contracts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mg_incoming_contracts
UNION ALL SELECT 185 AS ord, 'mg_ledger_entries' AS table_name, COUNT(*) AS row_count, 'reported_eligible_yen=' || CAST(COALESCE(SUM(reported_eligible_yen), 0) AS TEXT) || ';' || 'applied_recoup_yen=' || CAST(COALESCE(SUM(applied_recoup_yen), 0) AS TEXT) || ';' || 'reported_overage_yen=' || CAST(COALESCE(SUM(reported_overage_yen), 0) AS TEXT) || ';' || 'recognized_yen=' || CAST(COALESCE(SUM(recognized_yen), 0) AS TEXT) AS money_sums FROM mg_ledger_entries
UNION ALL SELECT 186 AS ord, 'mg_outgoing_contracts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mg_outgoing_contracts
UNION ALL SELECT 187 AS ord, 'mg_suppliers' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mg_suppliers
UNION ALL SELECT 188 AS ord, 'mg_term_versions' AS table_name, COUNT(*) AS row_count, 'mg_amount_yen=' || CAST(COALESCE(SUM(mg_amount_yen), 0) AS TEXT) AS money_sums FROM mg_term_versions
UNION ALL SELECT 189 AS ord, 'mg_version_phases' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM mg_version_phases
UNION ALL SELECT 190 AS ord, 'mg_version_products' AS table_name, COUNT(*) AS row_count, 'evaluation_yen=' || CAST(COALESCE(SUM(evaluation_yen), 0) AS TEXT) AS money_sums FROM mg_version_products
UNION ALL SELECT 191 AS ord, 'notebook_posts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM notebook_posts
UNION ALL SELECT 192 AS ord, 'notebook_receipts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM notebook_receipts
UNION ALL SELECT 193 AS ord, 'notebook_spaces' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM notebook_spaces
UNION ALL SELECT 194 AS ord, 'observations' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM observations
UNION ALL SELECT 195 AS ord, 'org_profile_versions' AS table_name, COUNT(*) AS row_count, 'capital_yen=' || CAST(COALESCE(SUM(capital_yen), 0) AS TEXT) AS money_sums FROM org_profile_versions
UNION ALL SELECT 196 AS ord, 'org_switch_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM org_switch_events
UNION ALL SELECT 197 AS ord, 'organizations' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM organizations
UNION ALL SELECT 198 AS ord, 'package_observation_products' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM package_observation_products
UNION ALL SELECT 199 AS ord, 'package_report_observations' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM package_report_observations
UNION ALL SELECT 200 AS ord, 'package_sale_details' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM package_sale_details
UNION ALL SELECT 201 AS ord, 'partner_list_entries' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_list_entries
UNION ALL SELECT 202 AS ord, 'partner_list_entry_versions' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) AS money_sums FROM partner_list_entry_versions
UNION ALL SELECT 203 AS ord, 'partner_list_field_definitions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_list_field_definitions
UNION ALL SELECT 204 AS ord, 'partner_list_field_states' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_list_field_states
UNION ALL SELECT 205 AS ord, 'partner_list_field_values' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_list_field_values
UNION ALL SELECT 206 AS ord, 'partner_list_import_batches' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_list_import_batches
UNION ALL SELECT 207 AS ord, 'partner_list_import_previews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_list_import_previews
UNION ALL SELECT 208 AS ord, 'partner_list_kinds' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_list_kinds
UNION ALL SELECT 209 AS ord, 'partner_lists' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_lists
UNION ALL SELECT 210 AS ord, 'partner_payment_term_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_payment_term_versions
UNION ALL SELECT 211 AS ord, 'partner_profile_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partner_profile_versions
UNION ALL SELECT 212 AS ord, 'partners' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM partners
UNION ALL SELECT 213 AS ord, 'plan_adoptions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM plan_adoptions
UNION ALL SELECT 214 AS ord, 'planning_documents' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM planning_documents
UNION ALL SELECT 215 AS ord, 'planning_facts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM planning_facts
UNION ALL SELECT 216 AS ord, 'planning_materials' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM planning_materials
UNION ALL SELECT 217 AS ord, 'planning_profile_people' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM planning_profile_people
UNION ALL SELECT 218 AS ord, 'planning_profile_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM planning_profile_versions
UNION ALL SELECT 219 AS ord, 'planning_trial_investments' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM planning_trial_investments
UNION ALL SELECT 220 AS ord, 'planning_trial_lines' AS table_name, COUNT(*) AS row_count, 'unit_price_yen=' || CAST(COALESCE(SUM(unit_price_yen), 0) AS TEXT) || ';' || 'previous_sales_yen=' || CAST(COALESCE(SUM(previous_sales_yen), 0) AS TEXT) AS money_sums FROM planning_trial_lines
UNION ALL SELECT 221 AS ord, 'planning_trial_rates' AS table_name, COUNT(*) AS row_count, 'unit_cost_yen=' || CAST(COALESCE(SUM(unit_cost_yen), 0) AS TEXT) AS money_sums FROM planning_trial_rates
UNION ALL SELECT 222 AS ord, 'planning_trial_versions' AS table_name, COUNT(*) AS row_count, 'cost_total_yen=' || CAST(COALESCE(SUM(cost_total_yen), 0) AS TEXT) AS money_sums FROM planning_trial_versions
UNION ALL SELECT 223 AS ord, 'post_cuts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM post_cuts
UNION ALL SELECT 224 AS ord, 'post_deliverable_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM post_deliverable_events
UNION ALL SELECT 225 AS ord, 'post_deliverable_items' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM post_deliverable_items
UNION ALL SELECT 226 AS ord, 'post_note_actions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM post_note_actions
UNION ALL SELECT 227 AS ord, 'post_notes' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM post_notes
UNION ALL SELECT 228 AS ord, 'post_task_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM post_task_events
UNION ALL SELECT 229 AS ord, 'post_tasks' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM post_tasks
UNION ALL SELECT 230 AS ord, 'prep_tasks' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM prep_tasks
UNION ALL SELECT 231 AS ord, 'preprod_document_placements' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM preprod_document_placements
UNION ALL SELECT 232 AS ord, 'produce_task_checks' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM produce_task_checks
UNION ALL SELECT 233 AS ord, 'produce_task_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM produce_task_events
UNION ALL SELECT 234 AS ord, 'produce_task_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM produce_task_links
UNION ALL SELECT 235 AS ord, 'produce_task_posts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM produce_task_posts
UNION ALL SELECT 236 AS ord, 'produce_task_template_items' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM produce_task_template_items
UNION ALL SELECT 237 AS ord, 'produce_task_templates' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM produce_task_templates
UNION ALL SELECT 238 AS ord, 'produce_tasks' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM produce_tasks
UNION ALL SELECT 239 AS ord, 'product_master_profile_versions' AS table_name, COUNT(*) AS row_count, 'price_yen=' || CAST(COALESCE(SUM(price_yen), 0) AS TEXT) || ';' || 'price_ex_tax_yen=' || CAST(COALESCE(SUM(price_ex_tax_yen), 0) AS TEXT) || ';' || 'price_inc_tax_yen=' || CAST(COALESCE(SUM(price_inc_tax_yen), 0) AS TEXT) AS money_sums FROM product_master_profile_versions
UNION ALL SELECT 240 AS ord, 'product_works' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM product_works
UNION ALL SELECT 241 AS ord, 'production_appearances' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_appearances
UNION ALL SELECT 242 AS ord, 'production_arrangement_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_arrangement_versions
UNION ALL SELECT 243 AS ord, 'production_calls' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_calls
UNION ALL SELECT 244 AS ord, 'production_characters' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_characters
UNION ALL SELECT 245 AS ord, 'production_cost_versions' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) || ';' || 'production_part_yen=' || CAST(COALESCE(SUM(production_part_yen), 0) AS TEXT) || ';' || 'pa_part_yen=' || CAST(COALESCE(SUM(pa_part_yen), 0) AS TEXT) || ';' || 'contract_amount_yen=' || CAST(COALESCE(SUM(contract_amount_yen), 0) AS TEXT) || ';' || 'added_yen=' || CAST(COALESCE(SUM(added_yen), 0) AS TEXT) AS money_sums FROM production_cost_versions
UNION ALL SELECT 246 AS ord, 'production_day_slots' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_day_slots
UNION ALL SELECT 247 AS ord, 'production_location_plans' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_location_plans
UNION ALL SELECT 248 AS ord, 'production_locations' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_locations
UNION ALL SELECT 249 AS ord, 'production_looks' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_looks
UNION ALL SELECT 250 AS ord, 'production_revisions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_revisions
UNION ALL SELECT 251 AS ord, 'production_scene_details' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_scene_details
UNION ALL SELECT 252 AS ord, 'production_scene_looks' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM production_scene_looks
UNION ALL SELECT 253 AS ord, 'products' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM products
UNION ALL SELECT 254 AS ord, 'project_memberships' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM project_memberships
UNION ALL SELECT 255 AS ord, 'project_owner_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM project_owner_versions
UNION ALL SELECT 256 AS ord, 'project_stage_events' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM project_stage_events
UNION ALL SELECT 257 AS ord, 'project_stage_meanings' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM project_stage_meanings
UNION ALL SELECT 258 AS ord, 'project_stages' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM project_stages
UNION ALL SELECT 259 AS ord, 'projects' AS table_name, COUNT(*) AS row_count, 'budget_yen=' || CAST(COALESCE(SUM(budget_yen), 0) AS TEXT) || ';' || 'base_amount_yen=' || CAST(COALESCE(SUM(base_amount_yen), 0) AS TEXT) AS money_sums FROM projects
UNION ALL SELECT 260 AS ord, 'receipt_plan_decisions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM receipt_plan_decisions
UNION ALL SELECT 261 AS ord, 'receipt_plan_requests' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM receipt_plan_requests
UNION ALL SELECT 262 AS ord, 'recognition_bases' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM recognition_bases
UNION ALL SELECT 263 AS ord, 'release_window_import_previews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM release_window_import_previews
UNION ALL SELECT 264 AS ord, 'release_window_type_distributions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM release_window_type_distributions
UNION ALL SELECT 265 AS ord, 'release_window_type_fields' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM release_window_type_fields
UNION ALL SELECT 266 AS ord, 'release_window_type_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM release_window_type_versions
UNION ALL SELECT 267 AS ord, 'release_window_types' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM release_window_types
UNION ALL SELECT 268 AS ord, 'report_channel_fact_seals' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_channel_fact_seals
UNION ALL SELECT 269 AS ord, 'report_check_cases' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_check_cases
UNION ALL SELECT 270 AS ord, 'report_check_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_check_versions
UNION ALL SELECT 271 AS ord, 'report_imports' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_imports
UNION ALL SELECT 272 AS ord, 'report_issuance_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_issuance_voids
UNION ALL SELECT 273 AS ord, 'report_issuances' AS table_name, COUNT(*) AS row_count, 'headline_yen=' || CAST(COALESCE(SUM(headline_yen), 0) AS TEXT) AS money_sums FROM report_issuances
UNION ALL SELECT 274 AS ord, 'report_mapping_profiles' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_mapping_profiles
UNION ALL SELECT 275 AS ord, 'report_mapping_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_mapping_versions
UNION ALL SELECT 276 AS ord, 'report_recognition' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_recognition
UNION ALL SELECT 277 AS ord, 'report_sale_dimensions_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_sale_dimensions_versions
UNION ALL SELECT 278 AS ord, 'report_source_controls' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_source_controls
UNION ALL SELECT 279 AS ord, 'report_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM report_voids
UNION ALL SELECT 280 AS ord, 'rights_intake_cases' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM rights_intake_cases
UNION ALL SELECT 281 AS ord, 'rights_intake_documents' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM rights_intake_documents
UNION ALL SELECT 282 AS ord, 'rights_intake_participants' AS table_name, COUNT(*) AS row_count, 'investment_yen=' || CAST(COALESCE(SUM(investment_yen), 0) AS TEXT) AS money_sums FROM rights_intake_participants
UNION ALL SELECT 283 AS ord, 'rights_intake_scopes' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM rights_intake_scopes
UNION ALL SELECT 284 AS ord, 'rights_payment_events' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM rights_payment_events
UNION ALL SELECT 285 AS ord, 'royalty_agreements' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM royalty_agreements
UNION ALL SELECT 286 AS ord, 'royalty_irregular_entries' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM royalty_irregular_entries
UNION ALL SELECT 287 AS ord, 'royalty_manual_accruals' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM royalty_manual_accruals
UNION ALL SELECT 288 AS ord, 'royalty_schedule_phases' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM royalty_schedule_phases
UNION ALL SELECT 289 AS ord, 'royalty_schedule_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM royalty_schedule_versions
UNION ALL SELECT 290 AS ord, 'royalty_statement_calculation_parts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM royalty_statement_calculation_parts
UNION ALL SELECT 291 AS ord, 'royalty_statement_events' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM royalty_statement_events
UNION ALL SELECT 292 AS ord, 'royalty_statement_lines' AS table_name, COUNT(*) AS row_count, 'sales_yen=' || CAST(COALESCE(SUM(sales_yen), 0) AS TEXT) || ';' || 'window_fee_yen=' || CAST(COALESCE(SUM(window_fee_yen), 0) AS TEXT) || ';' || 'expense_yen=' || CAST(COALESCE(SUM(expense_yen), 0) AS TEXT) || ';' || 'committee_income_yen=' || CAST(COALESCE(SUM(committee_income_yen), 0) AS TEXT) || ';' || 'base_yen=' || CAST(COALESCE(SUM(base_yen), 0) AS TEXT) || ';' || 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM royalty_statement_lines
UNION ALL SELECT 293 AS ord, 'royalty_statement_voids' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM royalty_statement_voids
UNION ALL SELECT 294 AS ord, 'royalty_statements' AS table_name, COUNT(*) AS row_count, 'royalty_yen=' || CAST(COALESCE(SUM(royalty_yen), 0) AS TEXT) || ';' || 'adjustment_yen=' || CAST(COALESCE(SUM(adjustment_yen), 0) AS TEXT) || ';' || 'advance_recouped_yen=' || CAST(COALESCE(SUM(advance_recouped_yen), 0) AS TEXT) || ';' || 'carried_in_yen=' || CAST(COALESCE(SUM(carried_in_yen), 0) AS TEXT) || ';' || 'payable_yen=' || CAST(COALESCE(SUM(payable_yen), 0) AS TEXT) || ';' || 'carried_out_yen=' || CAST(COALESCE(SUM(carried_out_yen), 0) AS TEXT) AS money_sums FROM royalty_statements
UNION ALL SELECT 295 AS ord, 'royalty_term_channels' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM royalty_term_channels
UNION ALL SELECT 296 AS ord, 'royalty_term_expense_categories' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM royalty_term_expense_categories
UNION ALL SELECT 297 AS ord, 'royalty_term_versions' AS table_name, COUNT(*) AS row_count, 'fixed_amount_yen=' || CAST(COALESCE(SUM(fixed_amount_yen), 0) AS TEXT) || ';' || 'advance_yen=' || CAST(COALESCE(SUM(advance_yen), 0) AS TEXT) || ';' || 'min_payment_yen=' || CAST(COALESCE(SUM(min_payment_yen), 0) AS TEXT) AS money_sums FROM royalty_term_versions
UNION ALL SELECT 298 AS ord, 'sale_attribute_values' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sale_attribute_values
UNION ALL SELECT 299 AS ord, 'sale_currency_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sale_currency_versions
UNION ALL SELECT 300 AS ord, 'sale_distribution_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sale_distribution_versions
UNION ALL SELECT 301 AS ord, 'sale_lines' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) || ';' || 'tax_amount=' || CAST(COALESCE(SUM(tax_amount), 0) AS TEXT) || ';' || 'amount_inc_tax=' || CAST(COALESCE(SUM(amount_inc_tax), 0) AS TEXT) AS money_sums FROM sale_lines
UNION ALL SELECT 302 AS ord, 'sale_royalty_basis_versions' AS table_name, COUNT(*) AS row_count, 'royalty_amount_ex_tax=' || CAST(COALESCE(SUM(royalty_amount_ex_tax), 0) AS TEXT) || ';' || 'royalty_tax_amount=' || CAST(COALESCE(SUM(royalty_tax_amount), 0) AS TEXT) || ';' || 'royalty_amount_inc_tax=' || CAST(COALESCE(SUM(royalty_amount_inc_tax), 0) AS TEXT) AS money_sums FROM sale_royalty_basis_versions
UNION ALL SELECT 303 AS ord, 'sales_activities' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_activities
UNION ALL SELECT 304 AS ord, 'sales_activity_notes' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_activity_notes
UNION ALL SELECT 305 AS ord, 'sales_agreement_term_versions' AS table_name, COUNT(*) AS row_count, 'expected_amount_yen=' || CAST(COALESCE(SUM(expected_amount_yen), 0) AS TEXT) AS money_sums FROM sales_agreement_term_versions
UNION ALL SELECT 306 AS ord, 'sales_agreements' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_agreements
UNION ALL SELECT 307 AS ord, 'sales_availability_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_availability_versions
UNION ALL SELECT 308 AS ord, 'sales_deliverables' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_deliverables
UNION ALL SELECT 309 AS ord, 'sales_material_snapshots' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_material_snapshots
UNION ALL SELECT 310 AS ord, 'sales_opportunities' AS table_name, COUNT(*) AS row_count, 'expected_yen=' || CAST(COALESCE(SUM(expected_yen), 0) AS TEXT) AS money_sums FROM sales_opportunities
UNION ALL SELECT 311 AS ord, 'sales_proposal_review_factors' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_proposal_review_factors
UNION ALL SELECT 312 AS ord, 'sales_proposal_reviews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_proposal_reviews
UNION ALL SELECT 313 AS ord, 'sales_proposal_windows' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_proposal_windows
UNION ALL SELECT 314 AS ord, 'sales_proposals' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) AS money_sums FROM sales_proposals
UNION ALL SELECT 315 AS ord, 'sales_report_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_report_links
UNION ALL SELECT 316 AS ord, 'sales_sheet_column_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_sheet_column_versions
UNION ALL SELECT 317 AS ord, 'sales_sheet_view_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_sheet_view_versions
UNION ALL SELECT 318 AS ord, 'sales_sheet_views' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_sheet_views
UNION ALL SELECT 319 AS ord, 'sales_source_bindings' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_source_bindings
UNION ALL SELECT 320 AS ord, 'sales_source_commits' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_source_commits
UNION ALL SELECT 321 AS ord, 'sales_source_file_terms' AS table_name, COUNT(*) AS row_count, 'declared_amount_ex_tax=' || CAST(COALESCE(SUM(declared_amount_ex_tax), 0) AS TEXT) || ';' || 'declared_tax_amount=' || CAST(COALESCE(SUM(declared_tax_amount), 0) AS TEXT) || ';' || 'declared_amount_inc_tax=' || CAST(COALESCE(SUM(declared_amount_inc_tax), 0) AS TEXT) AS money_sums FROM sales_source_file_terms
UNION ALL SELECT 322 AS ord, 'sales_source_files' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_source_files
UNION ALL SELECT 323 AS ord, 'sales_source_partitions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_source_partitions
UNION ALL SELECT 324 AS ord, 'sales_source_selections' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sales_source_selections
UNION ALL SELECT 325 AS ord, 'scene_art_item_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM scene_art_item_versions
UNION ALL SELECT 326 AS ord, 'scene_shoot_plan_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM scene_shoot_plan_versions
UNION ALL SELECT 327 AS ord, 'scenes' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM scenes
UNION ALL SELECT 328 AS ord, 'schema_meta' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM schema_meta
UNION ALL SELECT 329 AS ord, 'sessions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM sessions
UNION ALL SELECT 330 AS ord, 'settlement_contracts' AS table_name, COUNT(*) AS row_count, 'mg_contract_yen=' || CAST(COALESCE(SUM(mg_contract_yen), 0) AS TEXT) || ';' || 'mg_paid_yen=' || CAST(COALESCE(SUM(mg_paid_yen), 0) AS TEXT) AS money_sums FROM settlement_contracts
UNION ALL SELECT 331 AS ord, 'settlement_report_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM settlement_report_links
UNION ALL SELECT 332 AS ord, 'settlement_term_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM settlement_term_versions
UNION ALL SELECT 333 AS ord, 'shooting_day_records' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM shooting_day_records
UNION ALL SELECT 334 AS ord, 'shooting_day_report_items' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM shooting_day_report_items
UNION ALL SELECT 335 AS ord, 'shooting_days' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM shooting_days
UNION ALL SELECT 336 AS ord, 'shooting_scene_results' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM shooting_scene_results
UNION ALL SELECT 337 AS ord, 'source_check_runs' AS table_name, COUNT(*) AS row_count, 'checks_total=' || CAST(COALESCE(SUM(checks_total), 0) AS TEXT) || ';' || 'golden_total=' || CAST(COALESCE(SUM(golden_total), 0) AS TEXT) AS money_sums FROM source_check_runs
UNION ALL SELECT 338 AS ord, 'source_document_moves' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM source_document_moves
UNION ALL SELECT 339 AS ord, 'source_documents' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM source_documents
UNION ALL SELECT 340 AS ord, 'source_sampling_reviews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM source_sampling_reviews
UNION ALL SELECT 341 AS ord, 'tax_calculation_lines' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) || ';' || 'source_tax=' || CAST(COALESCE(SUM(source_tax), 0) AS TEXT) || ';' || 'amount_inc_tax=' || CAST(COALESCE(SUM(amount_inc_tax), 0) AS TEXT) AS money_sums FROM tax_calculation_lines
UNION ALL SELECT 342 AS ord, 'tax_calculation_snapshots' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) || ';' || 'source_tax=' || CAST(COALESCE(SUM(source_tax), 0) AS TEXT) || ';' || 'billed_tax=' || CAST(COALESCE(SUM(billed_tax), 0) AS TEXT) AS money_sums FROM tax_calculation_snapshots
UNION ALL SELECT 343 AS ord, 'tax_invoice_links' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM tax_invoice_links
UNION ALL SELECT 344 AS ord, 'tax_invoice_rate_totals' AS table_name, COUNT(*) AS row_count, 'amount_ex_tax=' || CAST(COALESCE(SUM(amount_ex_tax), 0) AS TEXT) || ';' || 'billed_tax=' || CAST(COALESCE(SUM(billed_tax), 0) AS TEXT) || ';' || 'source_tax=' || CAST(COALESCE(SUM(source_tax), 0) AS TEXT) AS money_sums FROM tax_invoice_rate_totals
UNION ALL SELECT 345 AS ord, 'tax_rule_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM tax_rule_versions
UNION ALL SELECT 346 AS ord, 'theatrical_sale_details' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM theatrical_sale_details
UNION ALL SELECT 347 AS ord, 'transaction_guards' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM transaction_guards
UNION ALL SELECT 348 AS ord, 'users' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM users
UNION ALL SELECT 349 AS ord, 'work_contract_set_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_contract_set_versions
UNION ALL SELECT 350 AS ord, 'work_contract_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_contract_versions
UNION ALL SELECT 351 AS ord, 'work_contracts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_contracts
UNION ALL SELECT 352 AS ord, 'work_finance_versions' AS table_name, COUNT(*) AS row_count, 'production_cost_yen=' || CAST(COALESCE(SUM(production_cost_yen), 0) AS TEXT) || ';' || 'promotion_budget_yen=' || CAST(COALESCE(SUM(promotion_budget_yen), 0) AS TEXT) || ';' || 'own_investment_yen=' || CAST(COALESCE(SUM(own_investment_yen), 0) AS TEXT) || ';' || 'sales_rights_purchase_yen=' || CAST(COALESCE(SUM(sales_rights_purchase_yen), 0) AS TEXT) AS money_sums FROM work_finance_versions
UNION ALL SELECT 353 AS ord, 'work_master_profile_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_master_profile_versions
UNION ALL SELECT 354 AS ord, 'work_proposal_profiles' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_proposal_profiles
UNION ALL SELECT 355 AS ord, 'work_release_window_field_values' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_release_window_field_values
UNION ALL SELECT 356 AS ord, 'work_release_window_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_release_window_versions
UNION ALL SELECT 357 AS ord, 'work_release_windows' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_release_windows
UNION ALL SELECT 358 AS ord, 'work_rights_party_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_rights_party_versions
UNION ALL SELECT 359 AS ord, 'work_rights_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM work_rights_versions
UNION ALL SELECT 360 AS ord, 'workbench_analysis_snapshots' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_analysis_snapshots
UNION ALL SELECT 361 AS ord, 'workbench_applications' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_applications
UNION ALL SELECT 362 AS ord, 'workbench_change_sets' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_change_sets
UNION ALL SELECT 363 AS ord, 'workbench_drafts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_drafts
UNION ALL SELECT 364 AS ord, 'workbench_lineage' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_lineage
UNION ALL SELECT 365 AS ord, 'workbench_recipe_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_recipe_versions
UNION ALL SELECT 366 AS ord, 'workbench_recipes' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_recipes
UNION ALL SELECT 367 AS ord, 'workbench_snapshots' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_snapshots
UNION ALL SELECT 368 AS ord, 'workbench_source_artifacts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_source_artifacts
UNION ALL SELECT 369 AS ord, 'workbench_validations' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workbench_validations
UNION ALL SELECT 370 AS ord, 'workflow_raw_artifacts' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workflow_raw_artifacts
UNION ALL SELECT 371 AS ord, 'workflow_report_commits' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workflow_report_commits
UNION ALL SELECT 372 AS ord, 'workflow_report_selections' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workflow_report_selections
UNION ALL SELECT 373 AS ord, 'workflow_schedule_previews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workflow_schedule_previews
UNION ALL SELECT 374 AS ord, 'workflow_script_commit_days' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workflow_script_commit_days
UNION ALL SELECT 375 AS ord, 'workflow_script_commit_scenes' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workflow_script_commit_scenes
UNION ALL SELECT 376 AS ord, 'workflow_script_commits' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workflow_script_commits
UNION ALL SELECT 377 AS ord, 'workflow_script_reviews' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM workflow_script_reviews
UNION ALL SELECT 378 AS ord, 'works' AS table_name, COUNT(*) AS row_count, 'forecast_yen=' || CAST(COALESCE(SUM(forecast_yen), 0) AS TEXT) AS money_sums FROM works
UNION ALL SELECT 379 AS ord, 'yojitsu_activity_cancellations' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM yojitsu_activity_cancellations
UNION ALL SELECT 380 AS ord, 'yojitsu_activity_records' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM yojitsu_activity_records
UNION ALL SELECT 381 AS ord, 'yojitsu_choice_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM yojitsu_choice_versions
UNION ALL SELECT 382 AS ord, 'yojitsu_forecast_lines' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM yojitsu_forecast_lines
UNION ALL SELECT 383 AS ord, 'yojitsu_forecast_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM yojitsu_forecast_versions
UNION ALL SELECT 384 AS ord, 'yojitsu_periods' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM yojitsu_periods
UNION ALL SELECT 385 AS ord, 'yojitsu_plan_amounts' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) AS money_sums FROM yojitsu_plan_amounts
UNION ALL SELECT 386 AS ord, 'yojitsu_plan_versions' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM yojitsu_plan_versions
UNION ALL SELECT 387 AS ord, 'yojitsu_setting_versions' AS table_name, COUNT(*) AS row_count, 'value_yen=' || CAST(COALESCE(SUM(value_yen), 0) AS TEXT) AS money_sums FROM yojitsu_setting_versions
UNION ALL SELECT 388 AS ord, 'yojitsu_target_versions' AS table_name, COUNT(*) AS row_count, 'amount_yen=' || CAST(COALESCE(SUM(amount_yen), 0) AS TEXT) || ';' || 'source1_yen=' || CAST(COALESCE(SUM(source1_yen), 0) AS TEXT) || ';' || 'source2_yen=' || CAST(COALESCE(SUM(source2_yen), 0) AS TEXT) || ';' || 'source3_yen=' || CAST(COALESCE(SUM(source3_yen), 0) AS TEXT) || ';' || 'source4_yen=' || CAST(COALESCE(SUM(source4_yen), 0) AS TEXT) || ';' || 'source5_yen=' || CAST(COALESCE(SUM(source5_yen), 0) AS TEXT) AS money_sums FROM yojitsu_target_versions
UNION ALL SELECT 389 AS ord, 'yojitsu_variables' AS table_name, COUNT(*) AS row_count, '' AS money_sums FROM yojitsu_variables
ORDER BY ord;
