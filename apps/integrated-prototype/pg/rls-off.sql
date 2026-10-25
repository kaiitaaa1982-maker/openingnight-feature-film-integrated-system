-- 生成物（scripts/pg-rls.mjs が pg/schema.sql から作る）。手で直さない。
-- 行単位の権限（pg/rls.sql）を外して戻す。表の持ち主のロールが、1つのトランザクションで当てる（core の runbooks/16-rls-staging.md の戻し方）。
-- 外したあとは、アプリのロールが全組織の行を読み書きできる（RLS を入れる前と同じ）。関数 rls_* は残す。

DROP POLICY IF EXISTS rls_org_member ON "ai_usage";
ALTER TABLE "ai_usage" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "audit_log";
ALTER TABLE "audit_log" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_invoice_line_works";
ALTER TABLE "billing_invoice_line_works" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_invoice_lines";
ALTER TABLE "billing_invoice_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_invoice_sequences";
ALTER TABLE "billing_invoice_sequences" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_invoice_voids";
ALTER TABLE "billing_invoice_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_invoices";
ALTER TABLE "billing_invoices" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_receipt_allocations";
ALTER TABLE "billing_receipt_allocations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_receipt_reversals";
ALTER TABLE "billing_receipt_reversals" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_receipts";
ALTER TABLE "billing_receipts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "billing_sale_claims";
ALTER TABLE "billing_sale_claims" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_airings";
ALTER TABLE "broadcast_airings" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_availability_previews";
ALTER TABLE "broadcast_availability_previews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_availability_rates";
ALTER TABLE "broadcast_availability_rates" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_import_previews";
ALTER TABLE "broadcast_import_previews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_sale_links";
ALTER TABLE "broadcast_sale_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_slot_versions";
ALTER TABLE "broadcast_slot_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_slots";
ALTER TABLE "broadcast_slots" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "campaigns";
ALTER TABLE "campaigns" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "catalog_credits";
ALTER TABLE "catalog_credits" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "catalog_edition_tags";
ALTER TABLE "catalog_edition_tags" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "catalog_editions";
ALTER TABLE "catalog_editions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "catalog_product_editions";
ALTER TABLE "catalog_product_editions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "catalog_product_windows";
ALTER TABLE "catalog_product_windows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "catalog_profiles";
ALTER TABLE "catalog_profiles" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "change_proposals";
ALTER TABLE "change_proposals" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_contracts";
ALTER TABLE "committee_contracts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_report_previews";
ALTER TABLE "committee_report_previews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_report_snapshots";
ALTER TABLE "committee_report_snapshots" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_schedule_phases";
ALTER TABLE "committee_schedule_phases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_deductions";
ALTER TABLE "committee_snapshot_deductions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_expenses";
ALTER TABLE "committee_snapshot_expenses" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_lines";
ALTER TABLE "committee_snapshot_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_member_amounts";
ALTER TABLE "committee_snapshot_member_amounts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_reports";
ALTER TABLE "committee_snapshot_reports" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_funding";
ALTER TABLE "committee_term_funding" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_investments";
ALTER TABLE "committee_term_investments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_members";
ALTER TABLE "committee_term_members" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_versions";
ALTER TABLE "committee_term_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_windows";
ALTER TABLE "committee_term_windows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "day_scene_assignments";
ALTER TABLE "day_scene_assignments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "digital_sale_details";
ALTER TABLE "digital_sale_details" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "distribution_master";
ALTER TABLE "distribution_master" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "distribution_types";
ALTER TABLE "distribution_types" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expenses";
ALTER TABLE "expenses" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "exposures";
ALTER TABLE "exposures" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "import_previews";
ALTER TABLE "import_previews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "intake_settlement_links";
ALTER TABLE "intake_settlement_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "invitations";
ALTER TABLE "invitations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_business_holidays";
ALTER TABLE "joint_business_holidays" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_committee_contracts";
ALTER TABLE "joint_committee_contracts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_committee_costs";
ALTER TABLE "joint_committee_costs" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_committee_members";
ALTER TABLE "joint_committee_members" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_committee_periods";
ALTER TABLE "joint_committee_periods" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_committee_sales";
ALTER TABLE "joint_committee_sales" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_committee_snapshots";
ALTER TABLE "joint_committee_snapshots" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_committee_windows";
ALTER TABLE "joint_committee_windows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_funding_events";
ALTER TABLE "joint_funding_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "joint_production_milestones";
ALTER TABLE "joint_production_milestones" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mapping_import_provenance";
ALTER TABLE "mapping_import_provenance" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "memberships";
ALTER TABLE "memberships" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "metric_definitions";
ALTER TABLE "metric_definitions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mg_contract_links";
ALTER TABLE "mg_contract_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mg_incoming_contracts";
ALTER TABLE "mg_incoming_contracts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mg_ledger_entries";
ALTER TABLE "mg_ledger_entries" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mg_outgoing_contracts";
ALTER TABLE "mg_outgoing_contracts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mg_suppliers";
ALTER TABLE "mg_suppliers" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mg_term_versions";
ALTER TABLE "mg_term_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mg_version_phases";
ALTER TABLE "mg_version_phases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mg_version_products";
ALTER TABLE "mg_version_products" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "observations";
ALTER TABLE "observations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_read ON "organizations";
ALTER TABLE "organizations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "package_observation_products";
ALTER TABLE "package_observation_products" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "package_report_observations";
ALTER TABLE "package_report_observations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "package_sale_details";
ALTER TABLE "package_sale_details" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partners";
ALTER TABLE "partners" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "prep_tasks";
ALTER TABLE "prep_tasks" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "product_works";
ALTER TABLE "product_works" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_appearances";
ALTER TABLE "production_appearances" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_calls";
ALTER TABLE "production_calls" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_characters";
ALTER TABLE "production_characters" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_day_slots";
ALTER TABLE "production_day_slots" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_location_plans";
ALTER TABLE "production_location_plans" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_locations";
ALTER TABLE "production_locations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_looks";
ALTER TABLE "production_looks" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_revisions";
ALTER TABLE "production_revisions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_scene_details";
ALTER TABLE "production_scene_details" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_scene_looks";
ALTER TABLE "production_scene_looks" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "products";
ALTER TABLE "products" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "project_memberships";
ALTER TABLE "project_memberships" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "projects";
ALTER TABLE "projects" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "receipt_plan_decisions";
ALTER TABLE "receipt_plan_decisions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "receipt_plan_requests";
ALTER TABLE "receipt_plan_requests" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "recognition_bases";
ALTER TABLE "recognition_bases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_channel_fact_seals";
ALTER TABLE "report_channel_fact_seals" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_imports";
ALTER TABLE "report_imports" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_mapping_profiles";
ALTER TABLE "report_mapping_profiles" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_mapping_versions";
ALTER TABLE "report_mapping_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_recognition";
ALTER TABLE "report_recognition" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_sale_dimensions_versions";
ALTER TABLE "report_sale_dimensions_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_source_controls";
ALTER TABLE "report_source_controls" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "rights_intake_cases";
ALTER TABLE "rights_intake_cases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "rights_intake_documents";
ALTER TABLE "rights_intake_documents" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "rights_intake_participants";
ALTER TABLE "rights_intake_participants" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "rights_intake_scopes";
ALTER TABLE "rights_intake_scopes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "rights_payment_events";
ALTER TABLE "rights_payment_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sale_distribution_versions";
ALTER TABLE "sale_distribution_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sale_lines";
ALTER TABLE "sale_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_activities";
ALTER TABLE "sales_activities" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_agreement_term_versions";
ALTER TABLE "sales_agreement_term_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_agreements";
ALTER TABLE "sales_agreements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_availability_versions";
ALTER TABLE "sales_availability_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_deliverables";
ALTER TABLE "sales_deliverables" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_material_snapshots";
ALTER TABLE "sales_material_snapshots" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_opportunities";
ALTER TABLE "sales_opportunities" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_report_links";
ALTER TABLE "sales_report_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "scenes";
ALTER TABLE "scenes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "schema_meta";
ALTER TABLE "schema_meta" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sessions";
ALTER TABLE "sessions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "settlement_contracts";
ALTER TABLE "settlement_contracts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "settlement_report_links";
ALTER TABLE "settlement_report_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "settlement_term_versions";
ALTER TABLE "settlement_term_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "shooting_days";
ALTER TABLE "shooting_days" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "tax_calculation_lines";
ALTER TABLE "tax_calculation_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "tax_calculation_snapshots";
ALTER TABLE "tax_calculation_snapshots" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "tax_invoice_links";
ALTER TABLE "tax_invoice_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "tax_invoice_rate_totals";
ALTER TABLE "tax_invoice_rate_totals" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "tax_rule_versions";
ALTER TABLE "tax_rule_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "theatrical_sale_details";
ALTER TABLE "theatrical_sale_details" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_users_read ON "users";
DROP POLICY IF EXISTS rls_users_add ON "users";
DROP POLICY IF EXISTS rls_users_self ON "users";
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_analysis_snapshots";
ALTER TABLE "workbench_analysis_snapshots" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_applications";
ALTER TABLE "workbench_applications" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_change_sets";
ALTER TABLE "workbench_change_sets" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_drafts";
ALTER TABLE "workbench_drafts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_lineage";
ALTER TABLE "workbench_lineage" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_recipe_versions";
ALTER TABLE "workbench_recipe_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_recipes";
ALTER TABLE "workbench_recipes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_snapshots";
ALTER TABLE "workbench_snapshots" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_source_artifacts";
ALTER TABLE "workbench_source_artifacts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workbench_validations";
ALTER TABLE "workbench_validations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workflow_raw_artifacts";
ALTER TABLE "workflow_raw_artifacts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workflow_report_commits";
ALTER TABLE "workflow_report_commits" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workflow_report_selections";
ALTER TABLE "workflow_report_selections" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workflow_schedule_previews";
ALTER TABLE "workflow_schedule_previews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workflow_script_commit_days";
ALTER TABLE "workflow_script_commit_days" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workflow_script_commit_scenes";
ALTER TABLE "workflow_script_commit_scenes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workflow_script_commits";
ALTER TABLE "workflow_script_commits" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "workflow_script_reviews";
ALTER TABLE "workflow_script_reviews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "works";
ALTER TABLE "works" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "fiscal_settings";
ALTER TABLE "fiscal_settings" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "bulk_import_previews";
ALTER TABLE "bulk_import_previews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "bulk_import_batches";
ALTER TABLE "bulk_import_batches" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_profile_versions";
ALTER TABLE "partner_profile_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_issuances";
ALTER TABLE "report_issuances" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_issuance_voids";
ALTER TABLE "report_issuance_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expected_reports";
ALTER TABLE "expected_reports" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expected_report_closures";
ALTER TABLE "expected_report_closures" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_agreements";
ALTER TABLE "royalty_agreements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_term_versions";
ALTER TABLE "royalty_term_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_term_channels";
ALTER TABLE "royalty_term_channels" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_term_expense_categories";
ALTER TABLE "royalty_term_expense_categories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_schedule_versions";
ALTER TABLE "royalty_schedule_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_schedule_phases";
ALTER TABLE "royalty_schedule_phases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_manual_accruals";
ALTER TABLE "royalty_manual_accruals" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_irregular_entries";
ALTER TABLE "royalty_irregular_entries" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_statements";
ALTER TABLE "royalty_statements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_statement_voids";
ALTER TABLE "royalty_statement_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_statement_lines";
ALTER TABLE "royalty_statement_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_statement_events";
ALTER TABLE "royalty_statement_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "royalty_statement_calculation_parts";
ALTER TABLE "royalty_statement_calculation_parts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_window_fee_shares";
ALTER TABLE "committee_term_window_fee_shares" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_version_effective";
ALTER TABLE "committee_term_version_effective" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_source_files";
ALTER TABLE "sales_source_files" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_source_selections";
ALTER TABLE "sales_source_selections" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_source_bindings";
ALTER TABLE "sales_source_bindings" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_source_partitions";
ALTER TABLE "sales_source_partitions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_source_commits";
ALTER TABLE "sales_source_commits" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "org_switch_events";
ALTER TABLE "org_switch_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "release_window_types";
ALTER TABLE "release_window_types" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "release_window_type_versions";
ALTER TABLE "release_window_type_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "release_window_type_fields";
ALTER TABLE "release_window_type_fields" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "release_window_type_distributions";
ALTER TABLE "release_window_type_distributions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_release_windows";
ALTER TABLE "work_release_windows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_release_window_versions";
ALTER TABLE "work_release_window_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_release_window_field_values";
ALTER TABLE "work_release_window_field_values" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "release_window_import_previews";
ALTER TABLE "release_window_import_previews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "partner_list_kinds";
ALTER TABLE "partner_list_kinds" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_lists";
ALTER TABLE "partner_lists" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_list_import_batches";
ALTER TABLE "partner_list_import_batches" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_list_entries";
ALTER TABLE "partner_list_entries" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_list_entry_versions";
ALTER TABLE "partner_list_entry_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_list_field_definitions";
ALTER TABLE "partner_list_field_definitions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_list_field_states";
ALTER TABLE "partner_list_field_states" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_list_field_values";
ALTER TABLE "partner_list_field_values" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_list_import_previews";
ALTER TABLE "partner_list_import_previews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_sheet_column_versions";
ALTER TABLE "sales_sheet_column_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sale_attribute_values";
ALTER TABLE "sale_attribute_values" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sale_currency_versions";
ALTER TABLE "sale_currency_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sale_royalty_basis_versions";
ALTER TABLE "sale_royalty_basis_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_sheet_views";
ALTER TABLE "sales_sheet_views" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_sheet_view_versions";
ALTER TABLE "sales_sheet_view_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_proposal_profiles";
ALTER TABLE "work_proposal_profiles" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_station_type_versions";
ALTER TABLE "broadcast_station_type_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_entry_term_versions";
ALTER TABLE "broadcast_entry_term_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "org_profile_versions";
ALTER TABLE "org_profile_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "gl_accounts";
ALTER TABLE "gl_accounts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "gl_manual_amounts";
ALTER TABLE "gl_manual_amounts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_payments";
ALTER TABLE "expense_payments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_investment_payments";
ALTER TABLE "committee_investment_payments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_proposal_drafts";
ALTER TABLE "broadcast_proposal_drafts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "broadcast_proposal_draft_deletions";
ALTER TABLE "broadcast_proposal_draft_deletions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_master_profile_versions";
ALTER TABLE "work_master_profile_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_finance_versions";
ALTER TABLE "work_finance_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_contract_set_versions";
ALTER TABLE "work_contract_set_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_contracts";
ALTER TABLE "work_contracts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_contract_versions";
ALTER TABLE "work_contract_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_rights_versions";
ALTER TABLE "work_rights_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "work_rights_party_versions";
ALTER TABLE "work_rights_party_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "product_master_profile_versions";
ALTER TABLE "product_master_profile_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "gl_account_class_versions";
ALTER TABLE "gl_account_class_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_categories";
ALTER TABLE "expense_categories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_tax_categories";
ALTER TABLE "expense_tax_categories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_categories";
ALTER TABLE "expense_withholding_categories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_category_versions";
ALTER TABLE "expense_category_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_category_alias_versions";
ALTER TABLE "expense_category_alias_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_tax_category_versions";
ALTER TABLE "expense_tax_category_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_category_versions";
ALTER TABLE "expense_withholding_category_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "partner_payment_term_versions";
ALTER TABLE "partner_payment_term_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_accounting_versions";
ALTER TABLE "expense_accounting_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_payment_accounting";
ALTER TABLE "expense_payment_accounting" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_cards";
ALTER TABLE "expense_cards" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_card_versions";
ALTER TABLE "expense_card_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_credit_links";
ALTER TABLE "expense_credit_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_payment_settlements";
ALTER TABLE "expense_payment_settlements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_remittances";
ALTER TABLE "expense_withholding_remittances" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_allocations";
ALTER TABLE "expense_withholding_allocations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_card_debits";
ALTER TABLE "expense_card_debits" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_refund_receipts";
ALTER TABLE "expense_refund_receipts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_remittances_voids";
ALTER TABLE "expense_withholding_remittances_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_card_debits_voids";
ALTER TABLE "expense_card_debits_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_refund_receipts_voids";
ALTER TABLE "expense_refund_receipts_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_invoices";
ALTER TABLE "expense_invoices" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_invoice_versions";
ALTER TABLE "expense_invoice_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_details";
ALTER TABLE "expense_details" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_line_voids";
ALTER TABLE "expense_line_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_source_files";
ALTER TABLE "expense_source_files" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_invoice_file_links";
ALTER TABLE "expense_invoice_file_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_invoice_file_unlinks";
ALTER TABLE "expense_invoice_file_unlinks" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_pending_rows";
ALTER TABLE "expense_pending_rows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_import_batches";
ALTER TABLE "expense_import_batches" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_import_rows";
ALTER TABLE "expense_import_rows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_import_versions";
ALTER TABLE "expense_import_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_import_events";
ALTER TABLE "expense_import_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_import_row_commits";
ALTER TABLE "expense_import_row_commits" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_pending_resolutions";
ALTER TABLE "expense_pending_resolutions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "cloud_analytics_state";
ALTER TABLE "cloud_analytics_state" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "cloud_analytics_jobs";
ALTER TABLE "cloud_analytics_jobs" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "earning_types";
ALTER TABLE "earning_types" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "action_steps";
ALTER TABLE "action_steps" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "project_stages";
ALTER TABLE "project_stages" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "project_stage_meanings";
ALTER TABLE "project_stage_meanings" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "project_stage_events";
ALTER TABLE "project_stage_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "earning_type_rate_versions";
ALTER TABLE "earning_type_rate_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "cashflow_categories";
ALTER TABLE "cashflow_categories" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "contract_production_versions";
ALTER TABLE "contract_production_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "contract_production_milestones";
ALTER TABLE "contract_production_milestones" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_periods";
ALTER TABLE "yojitsu_periods" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_target_versions";
ALTER TABLE "yojitsu_target_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_plan_versions";
ALTER TABLE "yojitsu_plan_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_plan_amounts";
ALTER TABLE "yojitsu_plan_amounts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "plan_adoptions";
ALTER TABLE "plan_adoptions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_signed_in ON "yojitsu_variables";
ALTER TABLE "yojitsu_variables" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_setting_versions";
ALTER TABLE "yojitsu_setting_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_forecast_versions";
ALTER TABLE "yojitsu_forecast_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_forecast_lines";
ALTER TABLE "yojitsu_forecast_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_activity_records";
ALTER TABLE "yojitsu_activity_records" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_activity_cancellations";
ALTER TABLE "yojitsu_activity_cancellations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_cost_versions";
ALTER TABLE "production_cost_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "kpi_metric_versions";
ALTER TABLE "kpi_metric_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "kpi_metric_steps";
ALTER TABLE "kpi_metric_steps" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "yojitsu_choice_versions";
ALTER TABLE "yojitsu_choice_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "investment_approval_versions";
ALTER TABLE "investment_approval_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_source_file_terms";
ALTER TABLE "sales_source_file_terms" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_voids";
ALTER TABLE "report_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_check_versions";
ALTER TABLE "report_check_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "report_check_cases";
ALTER TABLE "report_check_cases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "source_check_runs";
ALTER TABLE "source_check_runs" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "source_sampling_reviews";
ALTER TABLE "source_sampling_reviews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_versions";
ALTER TABLE "budget_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_version_lines";
ALTER TABLE "budget_version_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_check_runs";
ALTER TABLE "budget_check_runs" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_fixes";
ALTER TABLE "budget_fixes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "source_documents";
ALTER TABLE "source_documents" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_contracts";
ALTER TABLE "acq_mg_contracts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_versions";
ALTER TABLE "acq_mg_term_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_works";
ALTER TABLE "acq_mg_term_works" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_deductions";
ALTER TABLE "acq_mg_term_deductions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_phases";
ALTER TABLE "acq_mg_term_phases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_media_allocations";
ALTER TABLE "acq_mg_term_media_allocations" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_payment_schedule";
ALTER TABLE "acq_mg_payment_schedule" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_report_links";
ALTER TABLE "acq_mg_report_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_statements";
ALTER TABLE "acq_mg_statements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_documents";
ALTER TABLE "acq_mg_documents" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "acq_mg_payments";
ALTER TABLE "acq_mg_payments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_templates";
ALTER TABLE "budget_templates" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_template_versions";
ALTER TABLE "budget_template_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_template_items";
ALTER TABLE "budget_template_items" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_version_templates";
ALTER TABLE "budget_version_templates" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "budget_line_items";
ALTER TABLE "budget_line_items" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_file_placements";
ALTER TABLE "expense_file_placements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_file_placement_voids";
ALTER TABLE "expense_file_placement_voids" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "expense_month_closures";
ALTER TABLE "expense_month_closures" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_templates";
ALTER TABLE "committee_term_templates" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_version_templates";
ALTER TABLE "committee_term_version_templates" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_businesses";
ALTER TABLE "committee_term_businesses" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_business_steps";
ALTER TABLE "committee_term_business_steps" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_committee_steps";
ALTER TABLE "committee_term_committee_steps" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_term_budget_lines";
ALTER TABLE "committee_term_budget_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_schedule_versions";
ALTER TABLE "committee_schedule_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_schedule_version_phases";
ALTER TABLE "committee_schedule_version_phases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_round_overrides";
ALTER TABLE "committee_round_overrides" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "committee_ledger_entries";
ALTER TABLE "committee_ledger_entries" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "bank_accounts";
ALTER TABLE "bank_accounts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "bank_statement_imports";
ALTER TABLE "bank_statement_imports" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "bank_statement_lines";
ALTER TABLE "bank_statement_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "journal_entries";
ALTER TABLE "journal_entries" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "journal_lines";
ALTER TABLE "journal_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mfg_products";
ALTER TABLE "mfg_products" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mfg_product_versions";
ALTER TABLE "mfg_product_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mfg_step_events";
ALTER TABLE "mfg_step_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mfg_purchase_orders";
ALTER TABLE "mfg_purchase_orders" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mfg_purchase_order_lines";
ALTER TABLE "mfg_purchase_order_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mfg_po_events";
ALTER TABLE "mfg_po_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mfg_receipts";
ALTER TABLE "mfg_receipts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "mfg_po_expenses";
ALTER TABLE "mfg_po_expenses" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "produce_tasks";
ALTER TABLE "produce_tasks" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "produce_task_events";
ALTER TABLE "produce_task_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "produce_task_checks";
ALTER TABLE "produce_task_checks" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "produce_task_posts";
ALTER TABLE "produce_task_posts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "produce_task_links";
ALTER TABLE "produce_task_links" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "produce_task_templates";
ALTER TABLE "produce_task_templates" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "produce_task_template_items";
ALTER TABLE "produce_task_template_items" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "post_cuts";
ALTER TABLE "post_cuts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "post_notes";
ALTER TABLE "post_notes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "post_note_actions";
ALTER TABLE "post_note_actions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "post_tasks";
ALTER TABLE "post_tasks" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "post_task_events";
ALTER TABLE "post_task_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "post_deliverable_items";
ALTER TABLE "post_deliverable_items" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "post_deliverable_events";
ALTER TABLE "post_deliverable_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_proposals";
ALTER TABLE "sales_proposals" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_proposal_windows";
ALTER TABLE "sales_proposal_windows" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_proposal_reviews";
ALTER TABLE "sales_proposal_reviews" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_proposal_review_factors";
ALTER TABLE "sales_proposal_review_factors" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "sales_activity_notes";
ALTER TABLE "sales_activity_notes" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_documents";
ALTER TABLE "planning_documents" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_profile_versions";
ALTER TABLE "planning_profile_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_profile_people";
ALTER TABLE "planning_profile_people" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_trial_versions";
ALTER TABLE "planning_trial_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_trial_rates";
ALTER TABLE "planning_trial_rates" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_trial_lines";
ALTER TABLE "planning_trial_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_trial_investments";
ALTER TABLE "planning_trial_investments" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "project_owner_versions";
ALTER TABLE "project_owner_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_materials";
ALTER TABLE "planning_materials" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "planning_facts";
ALTER TABLE "planning_facts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "shooting_scene_results";
ALTER TABLE "shooting_scene_results" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "shooting_day_records";
ALTER TABLE "shooting_day_records" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "shooting_day_report_items";
ALTER TABLE "shooting_day_report_items" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_cases";
ALTER TABLE "chotatsu_cases" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_case_versions";
ALTER TABLE "chotatsu_case_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_stage_events";
ALTER TABLE "chotatsu_stage_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_estimates";
ALTER TABLE "chotatsu_estimates" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_estimate_lines";
ALTER TABLE "chotatsu_estimate_lines" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_agreements";
ALTER TABLE "chotatsu_agreements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_ringi";
ALTER TABLE "chotatsu_ringi" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_contracts";
ALTER TABLE "chotatsu_contracts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_materials";
ALTER TABLE "chotatsu_materials" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_handoffs";
ALTER TABLE "chotatsu_handoffs" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_handoff_events";
ALTER TABLE "chotatsu_handoff_events" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_documents";
ALTER TABLE "chotatsu_documents" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "chotatsu_case_expenses";
ALTER TABLE "chotatsu_case_expenses" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "production_arrangement_versions";
ALTER TABLE "production_arrangement_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "scene_art_item_versions";
ALTER TABLE "scene_art_item_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "scene_shoot_plan_versions";
ALTER TABLE "scene_shoot_plan_versions" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "preprod_document_placements";
ALTER TABLE "preprod_document_placements" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "notebook_spaces";
ALTER TABLE "notebook_spaces" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "notebook_posts";
ALTER TABLE "notebook_posts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "notebook_receipts";
ALTER TABLE "notebook_receipts" DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_org_member ON "source_document_moves";
ALTER TABLE "source_document_moves" DISABLE ROW LEVEL SECURITY;
