-- 生成物（scripts/pg-rls.mjs が pg/schema.sql から作る）。手で直さない。
-- 行単位の権限（RLS）。会社ルートの plans/2026-10-21-db-rls-owner-only.md。
-- pg/schema.sql と同じ search_path で、表の持ち主のロールが当てる。アプリのロールは持ち主にしない。
-- 関数は表と同じ schema に置く（試験は schema ごと作って消すので、別の schema に置くと前の試験の表を指したまま残る）。

-- いまの利用者 ID。トランザクションの設定値 app.user_id（set_config(…, true)）。無いか空か数でなければ NULL（どの業務の行も通さない）
CREATE OR REPLACE FUNCTION rls_current_user_id() RETURNS bigint LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN current_setting('app.user_id', true) ~ '^[1-9][0-9]{0,17}$' THEN current_setting('app.user_id', true)::bigint END
$f$;

-- ログインの照会で使うメール（Cloudflare Access で確かめたもの）。無ければ NULL
CREATE OR REPLACE FUNCTION rls_login_email() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT NULLIF(current_setting('app.login_email', true), '')
$f$;

-- 所属の期限。読めない値は期限切れとして扱う（閉じる側に倒す）。アプリは Date.parse で同じ判定をする（src/session-org.mjs の activeAt）
CREATE OR REPLACE FUNCTION rls_not_expired(expires_at text) RETURNS boolean LANGUAGE plpgsql STABLE AS $f$
BEGIN
  IF expires_at IS NULL OR expires_at = '' THEN RETURN true; END IF;
  RETURN expires_at::timestamptz > statement_timestamp();
EXCEPTION WHEN others THEN
  RETURN false;
END
$f$;

-- いまの利用者が有効に所属する組織（active=1・期限内）。所属の表自身にも RLS がかかるので、持ち主の権限で読む（SECURITY DEFINER）
CREATE OR REPLACE FUNCTION rls_member_org_ids() RETURNS bigint[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $f$
  SELECT coalesce(array_agg(m.org_id ORDER BY m.org_id), '{}')
    FROM memberships m
   WHERE m.user_id = rls_current_user_id() AND m.active = 1 AND rls_not_expired(m.expires_at)
$f$;

-- ai_usage
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "ai_usage";
CREATE POLICY rls_org_member ON "ai_usage" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- audit_log
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "audit_log";
CREATE POLICY rls_org_member ON "audit_log" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_invoice_line_works
ALTER TABLE "billing_invoice_line_works" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_invoice_line_works";
CREATE POLICY rls_org_member ON "billing_invoice_line_works" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_invoice_lines
ALTER TABLE "billing_invoice_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_invoice_lines";
CREATE POLICY rls_org_member ON "billing_invoice_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_invoice_sequences
ALTER TABLE "billing_invoice_sequences" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_invoice_sequences";
CREATE POLICY rls_org_member ON "billing_invoice_sequences" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_invoice_voids
ALTER TABLE "billing_invoice_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_invoice_voids";
CREATE POLICY rls_org_member ON "billing_invoice_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_invoices
ALTER TABLE "billing_invoices" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_invoices";
CREATE POLICY rls_org_member ON "billing_invoices" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_receipt_allocations
ALTER TABLE "billing_receipt_allocations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_receipt_allocations";
CREATE POLICY rls_org_member ON "billing_receipt_allocations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_receipt_reversals
ALTER TABLE "billing_receipt_reversals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_receipt_reversals";
CREATE POLICY rls_org_member ON "billing_receipt_reversals" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_receipts
ALTER TABLE "billing_receipts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_receipts";
CREATE POLICY rls_org_member ON "billing_receipts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- billing_sale_claims
ALTER TABLE "billing_sale_claims" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "billing_sale_claims";
CREATE POLICY rls_org_member ON "billing_sale_claims" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_airings
ALTER TABLE "broadcast_airings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_airings";
CREATE POLICY rls_org_member ON "broadcast_airings" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_availability_previews
ALTER TABLE "broadcast_availability_previews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_availability_previews";
CREATE POLICY rls_org_member ON "broadcast_availability_previews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_availability_rates
ALTER TABLE "broadcast_availability_rates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_availability_rates";
CREATE POLICY rls_org_member ON "broadcast_availability_rates" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_import_previews
ALTER TABLE "broadcast_import_previews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_import_previews";
CREATE POLICY rls_org_member ON "broadcast_import_previews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_sale_links
ALTER TABLE "broadcast_sale_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_sale_links";
CREATE POLICY rls_org_member ON "broadcast_sale_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_slot_versions
ALTER TABLE "broadcast_slot_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_slot_versions";
CREATE POLICY rls_org_member ON "broadcast_slot_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_slots
ALTER TABLE "broadcast_slots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_slots";
CREATE POLICY rls_org_member ON "broadcast_slots" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- campaigns
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "campaigns";
CREATE POLICY rls_org_member ON "campaigns" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- catalog_credits
ALTER TABLE "catalog_credits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "catalog_credits";
CREATE POLICY rls_org_member ON "catalog_credits" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- catalog_edition_tags
ALTER TABLE "catalog_edition_tags" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "catalog_edition_tags";
CREATE POLICY rls_org_member ON "catalog_edition_tags" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- catalog_editions
ALTER TABLE "catalog_editions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "catalog_editions";
CREATE POLICY rls_org_member ON "catalog_editions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- catalog_product_editions
ALTER TABLE "catalog_product_editions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "catalog_product_editions";
CREATE POLICY rls_org_member ON "catalog_product_editions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- catalog_product_windows
ALTER TABLE "catalog_product_windows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "catalog_product_windows";
CREATE POLICY rls_org_member ON "catalog_product_windows" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- catalog_profiles
ALTER TABLE "catalog_profiles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "catalog_profiles";
CREATE POLICY rls_org_member ON "catalog_profiles" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- change_proposals
ALTER TABLE "change_proposals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "change_proposals";
CREATE POLICY rls_org_member ON "change_proposals" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_contracts
ALTER TABLE "committee_contracts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_contracts";
CREATE POLICY rls_org_member ON "committee_contracts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_report_previews
ALTER TABLE "committee_report_previews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_report_previews";
CREATE POLICY rls_org_member ON "committee_report_previews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_report_snapshots
ALTER TABLE "committee_report_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_report_snapshots";
CREATE POLICY rls_org_member ON "committee_report_snapshots" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_schedule_phases
ALTER TABLE "committee_schedule_phases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_schedule_phases";
CREATE POLICY rls_org_member ON "committee_schedule_phases" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_snapshot_deductions
ALTER TABLE "committee_snapshot_deductions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_deductions";
CREATE POLICY rls_org_member ON "committee_snapshot_deductions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_snapshot_expenses
ALTER TABLE "committee_snapshot_expenses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_expenses";
CREATE POLICY rls_org_member ON "committee_snapshot_expenses" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_snapshot_lines
ALTER TABLE "committee_snapshot_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_lines";
CREATE POLICY rls_org_member ON "committee_snapshot_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_snapshot_member_amounts
ALTER TABLE "committee_snapshot_member_amounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_member_amounts";
CREATE POLICY rls_org_member ON "committee_snapshot_member_amounts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_snapshot_reports
ALTER TABLE "committee_snapshot_reports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_snapshot_reports";
CREATE POLICY rls_org_member ON "committee_snapshot_reports" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_funding
ALTER TABLE "committee_term_funding" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_funding";
CREATE POLICY rls_org_member ON "committee_term_funding" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_investments
ALTER TABLE "committee_term_investments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_investments";
CREATE POLICY rls_org_member ON "committee_term_investments" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_members
ALTER TABLE "committee_term_members" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_members";
CREATE POLICY rls_org_member ON "committee_term_members" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_versions
ALTER TABLE "committee_term_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_versions";
CREATE POLICY rls_org_member ON "committee_term_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_windows
ALTER TABLE "committee_term_windows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_windows";
CREATE POLICY rls_org_member ON "committee_term_windows" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- day_scene_assignments
ALTER TABLE "day_scene_assignments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "day_scene_assignments";
CREATE POLICY rls_org_member ON "day_scene_assignments" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- digital_sale_details
ALTER TABLE "digital_sale_details" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "digital_sale_details";
CREATE POLICY rls_org_member ON "digital_sale_details" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- distribution_master
ALTER TABLE "distribution_master" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "distribution_master";
CREATE POLICY rls_signed_in ON "distribution_master" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- distribution_types
ALTER TABLE "distribution_types" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "distribution_types";
CREATE POLICY rls_signed_in ON "distribution_types" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- expenses
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expenses";
CREATE POLICY rls_org_member ON "expenses" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- exposures
ALTER TABLE "exposures" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "exposures";
CREATE POLICY rls_org_member ON "exposures" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- import_previews
ALTER TABLE "import_previews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "import_previews";
CREATE POLICY rls_org_member ON "import_previews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- intake_settlement_links
ALTER TABLE "intake_settlement_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "intake_settlement_links";
CREATE POLICY rls_org_member ON "intake_settlement_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- invitations
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "invitations";
CREATE POLICY rls_org_member ON "invitations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_business_holidays
ALTER TABLE "joint_business_holidays" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_business_holidays";
CREATE POLICY rls_org_member ON "joint_business_holidays" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_committee_contracts
ALTER TABLE "joint_committee_contracts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_committee_contracts";
CREATE POLICY rls_org_member ON "joint_committee_contracts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_committee_costs
ALTER TABLE "joint_committee_costs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_committee_costs";
CREATE POLICY rls_org_member ON "joint_committee_costs" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_committee_members
ALTER TABLE "joint_committee_members" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_committee_members";
CREATE POLICY rls_org_member ON "joint_committee_members" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_committee_periods
ALTER TABLE "joint_committee_periods" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_committee_periods";
CREATE POLICY rls_org_member ON "joint_committee_periods" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_committee_sales
ALTER TABLE "joint_committee_sales" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_committee_sales";
CREATE POLICY rls_org_member ON "joint_committee_sales" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_committee_snapshots
ALTER TABLE "joint_committee_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_committee_snapshots";
CREATE POLICY rls_org_member ON "joint_committee_snapshots" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_committee_windows
ALTER TABLE "joint_committee_windows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_committee_windows";
CREATE POLICY rls_org_member ON "joint_committee_windows" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_funding_events
ALTER TABLE "joint_funding_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_funding_events";
CREATE POLICY rls_org_member ON "joint_funding_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- joint_production_milestones
ALTER TABLE "joint_production_milestones" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "joint_production_milestones";
CREATE POLICY rls_org_member ON "joint_production_milestones" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mapping_import_provenance
ALTER TABLE "mapping_import_provenance" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mapping_import_provenance";
CREATE POLICY rls_org_member ON "mapping_import_provenance" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- memberships
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "memberships";
CREATE POLICY rls_org_member ON "memberships" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- metric_definitions
ALTER TABLE "metric_definitions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "metric_definitions";
CREATE POLICY rls_org_member ON "metric_definitions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mg_contract_links
ALTER TABLE "mg_contract_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mg_contract_links";
CREATE POLICY rls_org_member ON "mg_contract_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mg_incoming_contracts
ALTER TABLE "mg_incoming_contracts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mg_incoming_contracts";
CREATE POLICY rls_org_member ON "mg_incoming_contracts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mg_ledger_entries
ALTER TABLE "mg_ledger_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mg_ledger_entries";
CREATE POLICY rls_org_member ON "mg_ledger_entries" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mg_outgoing_contracts
ALTER TABLE "mg_outgoing_contracts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mg_outgoing_contracts";
CREATE POLICY rls_org_member ON "mg_outgoing_contracts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mg_suppliers
ALTER TABLE "mg_suppliers" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mg_suppliers";
CREATE POLICY rls_org_member ON "mg_suppliers" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mg_term_versions
ALTER TABLE "mg_term_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mg_term_versions";
CREATE POLICY rls_org_member ON "mg_term_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mg_version_phases
ALTER TABLE "mg_version_phases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mg_version_phases";
CREATE POLICY rls_org_member ON "mg_version_phases" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mg_version_products
ALTER TABLE "mg_version_products" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mg_version_products";
CREATE POLICY rls_org_member ON "mg_version_products" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- observations
ALTER TABLE "observations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "observations";
CREATE POLICY rls_org_member ON "observations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- organizations
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_read ON "organizations";
CREATE POLICY rls_org_read ON "organizations" FOR SELECT USING (id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- package_observation_products
ALTER TABLE "package_observation_products" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "package_observation_products";
CREATE POLICY rls_org_member ON "package_observation_products" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- package_report_observations
ALTER TABLE "package_report_observations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "package_report_observations";
CREATE POLICY rls_org_member ON "package_report_observations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- package_sale_details
ALTER TABLE "package_sale_details" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "package_sale_details";
CREATE POLICY rls_org_member ON "package_sale_details" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partners
ALTER TABLE "partners" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partners";
CREATE POLICY rls_org_member ON "partners" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- prep_tasks
ALTER TABLE "prep_tasks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "prep_tasks";
CREATE POLICY rls_org_member ON "prep_tasks" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- product_works
ALTER TABLE "product_works" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "product_works";
CREATE POLICY rls_org_member ON "product_works" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_appearances
ALTER TABLE "production_appearances" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_appearances";
CREATE POLICY rls_org_member ON "production_appearances" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_calls
ALTER TABLE "production_calls" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_calls";
CREATE POLICY rls_org_member ON "production_calls" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_characters
ALTER TABLE "production_characters" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_characters";
CREATE POLICY rls_org_member ON "production_characters" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_day_slots
ALTER TABLE "production_day_slots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_day_slots";
CREATE POLICY rls_org_member ON "production_day_slots" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_location_plans
ALTER TABLE "production_location_plans" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_location_plans";
CREATE POLICY rls_org_member ON "production_location_plans" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_locations
ALTER TABLE "production_locations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_locations";
CREATE POLICY rls_org_member ON "production_locations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_looks
ALTER TABLE "production_looks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_looks";
CREATE POLICY rls_org_member ON "production_looks" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_revisions
ALTER TABLE "production_revisions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_revisions";
CREATE POLICY rls_org_member ON "production_revisions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_scene_details
ALTER TABLE "production_scene_details" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_scene_details";
CREATE POLICY rls_org_member ON "production_scene_details" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_scene_looks
ALTER TABLE "production_scene_looks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_scene_looks";
CREATE POLICY rls_org_member ON "production_scene_looks" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- products
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "products";
CREATE POLICY rls_org_member ON "products" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- project_memberships
ALTER TABLE "project_memberships" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "project_memberships";
CREATE POLICY rls_org_member ON "project_memberships" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- projects
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "projects";
CREATE POLICY rls_org_member ON "projects" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- receipt_plan_decisions
ALTER TABLE "receipt_plan_decisions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "receipt_plan_decisions";
CREATE POLICY rls_org_member ON "receipt_plan_decisions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- receipt_plan_requests
ALTER TABLE "receipt_plan_requests" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "receipt_plan_requests";
CREATE POLICY rls_org_member ON "receipt_plan_requests" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- recognition_bases
ALTER TABLE "recognition_bases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "recognition_bases";
CREATE POLICY rls_signed_in ON "recognition_bases" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- report_channel_fact_seals
ALTER TABLE "report_channel_fact_seals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_channel_fact_seals";
CREATE POLICY rls_org_member ON "report_channel_fact_seals" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_imports
ALTER TABLE "report_imports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_imports";
CREATE POLICY rls_org_member ON "report_imports" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_mapping_profiles
ALTER TABLE "report_mapping_profiles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_mapping_profiles";
CREATE POLICY rls_org_member ON "report_mapping_profiles" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_mapping_versions
ALTER TABLE "report_mapping_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_mapping_versions";
CREATE POLICY rls_org_member ON "report_mapping_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_recognition
ALTER TABLE "report_recognition" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_recognition";
CREATE POLICY rls_org_member ON "report_recognition" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_sale_dimensions_versions
ALTER TABLE "report_sale_dimensions_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_sale_dimensions_versions";
CREATE POLICY rls_org_member ON "report_sale_dimensions_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_source_controls
ALTER TABLE "report_source_controls" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_source_controls";
CREATE POLICY rls_org_member ON "report_source_controls" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- rights_intake_cases
ALTER TABLE "rights_intake_cases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "rights_intake_cases";
CREATE POLICY rls_org_member ON "rights_intake_cases" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- rights_intake_documents
ALTER TABLE "rights_intake_documents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "rights_intake_documents";
CREATE POLICY rls_org_member ON "rights_intake_documents" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- rights_intake_participants
ALTER TABLE "rights_intake_participants" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "rights_intake_participants";
CREATE POLICY rls_org_member ON "rights_intake_participants" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- rights_intake_scopes
ALTER TABLE "rights_intake_scopes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "rights_intake_scopes";
CREATE POLICY rls_org_member ON "rights_intake_scopes" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- rights_payment_events
ALTER TABLE "rights_payment_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "rights_payment_events";
CREATE POLICY rls_org_member ON "rights_payment_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sale_distribution_versions
ALTER TABLE "sale_distribution_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sale_distribution_versions";
CREATE POLICY rls_org_member ON "sale_distribution_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sale_lines
ALTER TABLE "sale_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sale_lines";
CREATE POLICY rls_org_member ON "sale_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_activities
ALTER TABLE "sales_activities" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_activities";
CREATE POLICY rls_org_member ON "sales_activities" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_agreement_term_versions
ALTER TABLE "sales_agreement_term_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_agreement_term_versions";
CREATE POLICY rls_org_member ON "sales_agreement_term_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_agreements
ALTER TABLE "sales_agreements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_agreements";
CREATE POLICY rls_org_member ON "sales_agreements" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_availability_versions
ALTER TABLE "sales_availability_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_availability_versions";
CREATE POLICY rls_org_member ON "sales_availability_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_deliverables
ALTER TABLE "sales_deliverables" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_deliverables";
CREATE POLICY rls_org_member ON "sales_deliverables" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_material_snapshots
ALTER TABLE "sales_material_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_material_snapshots";
CREATE POLICY rls_org_member ON "sales_material_snapshots" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_opportunities
ALTER TABLE "sales_opportunities" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_opportunities";
CREATE POLICY rls_org_member ON "sales_opportunities" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_report_links
ALTER TABLE "sales_report_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_report_links";
CREATE POLICY rls_org_member ON "sales_report_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- scenes
ALTER TABLE "scenes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "scenes";
CREATE POLICY rls_org_member ON "scenes" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- schema_meta
ALTER TABLE "schema_meta" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "schema_meta";
CREATE POLICY rls_org_member ON "schema_meta" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sessions
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sessions";
CREATE POLICY rls_org_member ON "sessions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- settlement_contracts
ALTER TABLE "settlement_contracts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "settlement_contracts";
CREATE POLICY rls_org_member ON "settlement_contracts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- settlement_report_links
ALTER TABLE "settlement_report_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "settlement_report_links";
CREATE POLICY rls_org_member ON "settlement_report_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- settlement_term_versions
ALTER TABLE "settlement_term_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "settlement_term_versions";
CREATE POLICY rls_org_member ON "settlement_term_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- shooting_days
ALTER TABLE "shooting_days" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "shooting_days";
CREATE POLICY rls_org_member ON "shooting_days" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- tax_calculation_lines
ALTER TABLE "tax_calculation_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "tax_calculation_lines";
CREATE POLICY rls_org_member ON "tax_calculation_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- tax_calculation_snapshots
ALTER TABLE "tax_calculation_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "tax_calculation_snapshots";
CREATE POLICY rls_org_member ON "tax_calculation_snapshots" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- tax_invoice_links
ALTER TABLE "tax_invoice_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "tax_invoice_links";
CREATE POLICY rls_org_member ON "tax_invoice_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- tax_invoice_rate_totals
ALTER TABLE "tax_invoice_rate_totals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "tax_invoice_rate_totals";
CREATE POLICY rls_org_member ON "tax_invoice_rate_totals" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- tax_rule_versions
ALTER TABLE "tax_rule_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "tax_rule_versions";
CREATE POLICY rls_org_member ON "tax_rule_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- theatrical_sale_details
ALTER TABLE "theatrical_sale_details" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "theatrical_sale_details";
CREATE POLICY rls_org_member ON "theatrical_sale_details" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- transaction_guards
-- transaction_guards: RLS をかけない（scripts/pg-rls.mjs の NON_ORG_TABLES に理由）

-- users
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_users_read ON "users";
CREATE POLICY rls_users_read ON "users" FOR SELECT USING (rls_current_user_id() IS NOT NULL OR email = rls_login_email());
DROP POLICY IF EXISTS rls_users_add ON "users";
CREATE POLICY rls_users_add ON "users" FOR INSERT WITH CHECK (rls_current_user_id() IS NOT NULL);
DROP POLICY IF EXISTS rls_users_self ON "users";
CREATE POLICY rls_users_self ON "users" FOR UPDATE USING (id = rls_current_user_id()) WITH CHECK (id = rls_current_user_id());

-- workbench_analysis_snapshots
ALTER TABLE "workbench_analysis_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_analysis_snapshots";
CREATE POLICY rls_org_member ON "workbench_analysis_snapshots" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_applications
ALTER TABLE "workbench_applications" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_applications";
CREATE POLICY rls_org_member ON "workbench_applications" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_change_sets
ALTER TABLE "workbench_change_sets" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_change_sets";
CREATE POLICY rls_org_member ON "workbench_change_sets" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_drafts
ALTER TABLE "workbench_drafts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_drafts";
CREATE POLICY rls_org_member ON "workbench_drafts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_lineage
ALTER TABLE "workbench_lineage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_lineage";
CREATE POLICY rls_org_member ON "workbench_lineage" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_recipe_versions
ALTER TABLE "workbench_recipe_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_recipe_versions";
CREATE POLICY rls_org_member ON "workbench_recipe_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_recipes
ALTER TABLE "workbench_recipes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_recipes";
CREATE POLICY rls_org_member ON "workbench_recipes" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_snapshots
ALTER TABLE "workbench_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_snapshots";
CREATE POLICY rls_org_member ON "workbench_snapshots" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_source_artifacts
ALTER TABLE "workbench_source_artifacts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_source_artifacts";
CREATE POLICY rls_org_member ON "workbench_source_artifacts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workbench_validations
ALTER TABLE "workbench_validations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workbench_validations";
CREATE POLICY rls_org_member ON "workbench_validations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workflow_raw_artifacts
ALTER TABLE "workflow_raw_artifacts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workflow_raw_artifacts";
CREATE POLICY rls_org_member ON "workflow_raw_artifacts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workflow_report_commits
ALTER TABLE "workflow_report_commits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workflow_report_commits";
CREATE POLICY rls_org_member ON "workflow_report_commits" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workflow_report_selections
ALTER TABLE "workflow_report_selections" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workflow_report_selections";
CREATE POLICY rls_org_member ON "workflow_report_selections" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workflow_schedule_previews
ALTER TABLE "workflow_schedule_previews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workflow_schedule_previews";
CREATE POLICY rls_org_member ON "workflow_schedule_previews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workflow_script_commit_days
ALTER TABLE "workflow_script_commit_days" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workflow_script_commit_days";
CREATE POLICY rls_org_member ON "workflow_script_commit_days" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workflow_script_commit_scenes
ALTER TABLE "workflow_script_commit_scenes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workflow_script_commit_scenes";
CREATE POLICY rls_org_member ON "workflow_script_commit_scenes" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workflow_script_commits
ALTER TABLE "workflow_script_commits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workflow_script_commits";
CREATE POLICY rls_org_member ON "workflow_script_commits" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- workflow_script_reviews
ALTER TABLE "workflow_script_reviews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "workflow_script_reviews";
CREATE POLICY rls_org_member ON "workflow_script_reviews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- works
ALTER TABLE "works" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "works";
CREATE POLICY rls_org_member ON "works" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- fiscal_settings
ALTER TABLE "fiscal_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "fiscal_settings";
CREATE POLICY rls_org_member ON "fiscal_settings" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- bulk_import_previews
ALTER TABLE "bulk_import_previews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "bulk_import_previews";
CREATE POLICY rls_org_member ON "bulk_import_previews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- bulk_import_batches
ALTER TABLE "bulk_import_batches" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "bulk_import_batches";
CREATE POLICY rls_org_member ON "bulk_import_batches" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_profile_versions
ALTER TABLE "partner_profile_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_profile_versions";
CREATE POLICY rls_org_member ON "partner_profile_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_issuances
ALTER TABLE "report_issuances" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_issuances";
CREATE POLICY rls_org_member ON "report_issuances" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_issuance_voids
ALTER TABLE "report_issuance_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_issuance_voids";
CREATE POLICY rls_org_member ON "report_issuance_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expected_reports
ALTER TABLE "expected_reports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expected_reports";
CREATE POLICY rls_org_member ON "expected_reports" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expected_report_closures
ALTER TABLE "expected_report_closures" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expected_report_closures";
CREATE POLICY rls_org_member ON "expected_report_closures" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_agreements
ALTER TABLE "royalty_agreements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_agreements";
CREATE POLICY rls_org_member ON "royalty_agreements" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_term_versions
ALTER TABLE "royalty_term_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_term_versions";
CREATE POLICY rls_org_member ON "royalty_term_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_term_channels
ALTER TABLE "royalty_term_channels" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_term_channels";
CREATE POLICY rls_org_member ON "royalty_term_channels" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_term_expense_categories
ALTER TABLE "royalty_term_expense_categories" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_term_expense_categories";
CREATE POLICY rls_org_member ON "royalty_term_expense_categories" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_schedule_versions
ALTER TABLE "royalty_schedule_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_schedule_versions";
CREATE POLICY rls_org_member ON "royalty_schedule_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_schedule_phases
ALTER TABLE "royalty_schedule_phases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_schedule_phases";
CREATE POLICY rls_org_member ON "royalty_schedule_phases" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_manual_accruals
ALTER TABLE "royalty_manual_accruals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_manual_accruals";
CREATE POLICY rls_org_member ON "royalty_manual_accruals" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_irregular_entries
ALTER TABLE "royalty_irregular_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_irregular_entries";
CREATE POLICY rls_org_member ON "royalty_irregular_entries" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_statements
ALTER TABLE "royalty_statements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_statements";
CREATE POLICY rls_org_member ON "royalty_statements" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_statement_voids
ALTER TABLE "royalty_statement_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_statement_voids";
CREATE POLICY rls_org_member ON "royalty_statement_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_statement_lines
ALTER TABLE "royalty_statement_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_statement_lines";
CREATE POLICY rls_org_member ON "royalty_statement_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_statement_events
ALTER TABLE "royalty_statement_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_statement_events";
CREATE POLICY rls_org_member ON "royalty_statement_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- royalty_statement_calculation_parts
ALTER TABLE "royalty_statement_calculation_parts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "royalty_statement_calculation_parts";
CREATE POLICY rls_org_member ON "royalty_statement_calculation_parts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_window_fee_shares
ALTER TABLE "committee_term_window_fee_shares" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_window_fee_shares";
CREATE POLICY rls_org_member ON "committee_term_window_fee_shares" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_version_effective
ALTER TABLE "committee_term_version_effective" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_version_effective";
CREATE POLICY rls_org_member ON "committee_term_version_effective" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_source_files
ALTER TABLE "sales_source_files" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_source_files";
CREATE POLICY rls_org_member ON "sales_source_files" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_source_selections
ALTER TABLE "sales_source_selections" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_source_selections";
CREATE POLICY rls_org_member ON "sales_source_selections" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_source_bindings
ALTER TABLE "sales_source_bindings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_source_bindings";
CREATE POLICY rls_org_member ON "sales_source_bindings" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_source_partitions
ALTER TABLE "sales_source_partitions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_source_partitions";
CREATE POLICY rls_org_member ON "sales_source_partitions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_source_commits
ALTER TABLE "sales_source_commits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_source_commits";
CREATE POLICY rls_org_member ON "sales_source_commits" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- org_switch_events
ALTER TABLE "org_switch_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "org_switch_events";
CREATE POLICY rls_org_member ON "org_switch_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- release_window_types
ALTER TABLE "release_window_types" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "release_window_types";
CREATE POLICY rls_org_member ON "release_window_types" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- release_window_type_versions
ALTER TABLE "release_window_type_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "release_window_type_versions";
CREATE POLICY rls_org_member ON "release_window_type_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- release_window_type_fields
ALTER TABLE "release_window_type_fields" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "release_window_type_fields";
CREATE POLICY rls_org_member ON "release_window_type_fields" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- release_window_type_distributions
ALTER TABLE "release_window_type_distributions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "release_window_type_distributions";
CREATE POLICY rls_org_member ON "release_window_type_distributions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_release_windows
ALTER TABLE "work_release_windows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_release_windows";
CREATE POLICY rls_org_member ON "work_release_windows" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_release_window_versions
ALTER TABLE "work_release_window_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_release_window_versions";
CREATE POLICY rls_org_member ON "work_release_window_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_release_window_field_values
ALTER TABLE "work_release_window_field_values" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_release_window_field_values";
CREATE POLICY rls_org_member ON "work_release_window_field_values" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- release_window_import_previews
ALTER TABLE "release_window_import_previews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "release_window_import_previews";
CREATE POLICY rls_org_member ON "release_window_import_previews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_list_kinds
ALTER TABLE "partner_list_kinds" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "partner_list_kinds";
CREATE POLICY rls_signed_in ON "partner_list_kinds" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- partner_lists
ALTER TABLE "partner_lists" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_lists";
CREATE POLICY rls_org_member ON "partner_lists" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_list_import_batches
ALTER TABLE "partner_list_import_batches" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_list_import_batches";
CREATE POLICY rls_org_member ON "partner_list_import_batches" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_list_entries
ALTER TABLE "partner_list_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_list_entries";
CREATE POLICY rls_org_member ON "partner_list_entries" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_list_entry_versions
ALTER TABLE "partner_list_entry_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_list_entry_versions";
CREATE POLICY rls_org_member ON "partner_list_entry_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_list_field_definitions
ALTER TABLE "partner_list_field_definitions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_list_field_definitions";
CREATE POLICY rls_org_member ON "partner_list_field_definitions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_list_field_states
ALTER TABLE "partner_list_field_states" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_list_field_states";
CREATE POLICY rls_org_member ON "partner_list_field_states" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_list_field_values
ALTER TABLE "partner_list_field_values" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_list_field_values";
CREATE POLICY rls_org_member ON "partner_list_field_values" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_list_import_previews
ALTER TABLE "partner_list_import_previews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_list_import_previews";
CREATE POLICY rls_org_member ON "partner_list_import_previews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_sheet_column_versions
ALTER TABLE "sales_sheet_column_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_sheet_column_versions";
CREATE POLICY rls_org_member ON "sales_sheet_column_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sale_attribute_values
ALTER TABLE "sale_attribute_values" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sale_attribute_values";
CREATE POLICY rls_org_member ON "sale_attribute_values" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sale_currency_versions
ALTER TABLE "sale_currency_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sale_currency_versions";
CREATE POLICY rls_org_member ON "sale_currency_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sale_royalty_basis_versions
ALTER TABLE "sale_royalty_basis_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sale_royalty_basis_versions";
CREATE POLICY rls_org_member ON "sale_royalty_basis_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_sheet_views
ALTER TABLE "sales_sheet_views" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_sheet_views";
CREATE POLICY rls_org_member ON "sales_sheet_views" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_sheet_view_versions
ALTER TABLE "sales_sheet_view_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_sheet_view_versions";
CREATE POLICY rls_org_member ON "sales_sheet_view_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_proposal_profiles
ALTER TABLE "work_proposal_profiles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_proposal_profiles";
CREATE POLICY rls_org_member ON "work_proposal_profiles" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_station_type_versions
ALTER TABLE "broadcast_station_type_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_station_type_versions";
CREATE POLICY rls_org_member ON "broadcast_station_type_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_entry_term_versions
ALTER TABLE "broadcast_entry_term_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_entry_term_versions";
CREATE POLICY rls_org_member ON "broadcast_entry_term_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- org_profile_versions
ALTER TABLE "org_profile_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "org_profile_versions";
CREATE POLICY rls_org_member ON "org_profile_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- gl_accounts
ALTER TABLE "gl_accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "gl_accounts";
CREATE POLICY rls_org_member ON "gl_accounts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- gl_manual_amounts
ALTER TABLE "gl_manual_amounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "gl_manual_amounts";
CREATE POLICY rls_org_member ON "gl_manual_amounts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_payments
ALTER TABLE "expense_payments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_payments";
CREATE POLICY rls_org_member ON "expense_payments" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_investment_payments
ALTER TABLE "committee_investment_payments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_investment_payments";
CREATE POLICY rls_org_member ON "committee_investment_payments" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_proposal_drafts
ALTER TABLE "broadcast_proposal_drafts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_proposal_drafts";
CREATE POLICY rls_org_member ON "broadcast_proposal_drafts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- broadcast_proposal_draft_deletions
ALTER TABLE "broadcast_proposal_draft_deletions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "broadcast_proposal_draft_deletions";
CREATE POLICY rls_org_member ON "broadcast_proposal_draft_deletions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_master_profile_versions
ALTER TABLE "work_master_profile_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_master_profile_versions";
CREATE POLICY rls_org_member ON "work_master_profile_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_finance_versions
ALTER TABLE "work_finance_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_finance_versions";
CREATE POLICY rls_org_member ON "work_finance_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_contract_set_versions
ALTER TABLE "work_contract_set_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_contract_set_versions";
CREATE POLICY rls_org_member ON "work_contract_set_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_contracts
ALTER TABLE "work_contracts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_contracts";
CREATE POLICY rls_org_member ON "work_contracts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_contract_versions
ALTER TABLE "work_contract_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_contract_versions";
CREATE POLICY rls_org_member ON "work_contract_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_rights_versions
ALTER TABLE "work_rights_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_rights_versions";
CREATE POLICY rls_org_member ON "work_rights_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- work_rights_party_versions
ALTER TABLE "work_rights_party_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "work_rights_party_versions";
CREATE POLICY rls_org_member ON "work_rights_party_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- product_master_profile_versions
ALTER TABLE "product_master_profile_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "product_master_profile_versions";
CREATE POLICY rls_org_member ON "product_master_profile_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- gl_account_class_versions
ALTER TABLE "gl_account_class_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "gl_account_class_versions";
CREATE POLICY rls_org_member ON "gl_account_class_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_categories
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_categories";
CREATE POLICY rls_org_member ON "expense_categories" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_tax_categories
ALTER TABLE "expense_tax_categories" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_tax_categories";
CREATE POLICY rls_org_member ON "expense_tax_categories" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_withholding_categories
ALTER TABLE "expense_withholding_categories" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_categories";
CREATE POLICY rls_org_member ON "expense_withholding_categories" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_category_versions
ALTER TABLE "expense_category_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_category_versions";
CREATE POLICY rls_org_member ON "expense_category_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_category_alias_versions
ALTER TABLE "expense_category_alias_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_category_alias_versions";
CREATE POLICY rls_org_member ON "expense_category_alias_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_tax_category_versions
ALTER TABLE "expense_tax_category_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_tax_category_versions";
CREATE POLICY rls_org_member ON "expense_tax_category_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_withholding_category_versions
ALTER TABLE "expense_withholding_category_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_category_versions";
CREATE POLICY rls_org_member ON "expense_withholding_category_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- partner_payment_term_versions
ALTER TABLE "partner_payment_term_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "partner_payment_term_versions";
CREATE POLICY rls_org_member ON "partner_payment_term_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_accounting_versions
ALTER TABLE "expense_accounting_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_accounting_versions";
CREATE POLICY rls_org_member ON "expense_accounting_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_payment_accounting
ALTER TABLE "expense_payment_accounting" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_payment_accounting";
CREATE POLICY rls_org_member ON "expense_payment_accounting" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_cards
ALTER TABLE "expense_cards" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_cards";
CREATE POLICY rls_org_member ON "expense_cards" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_card_versions
ALTER TABLE "expense_card_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_card_versions";
CREATE POLICY rls_org_member ON "expense_card_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_credit_links
ALTER TABLE "expense_credit_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_credit_links";
CREATE POLICY rls_org_member ON "expense_credit_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_payment_settlements
ALTER TABLE "expense_payment_settlements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_payment_settlements";
CREATE POLICY rls_org_member ON "expense_payment_settlements" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_withholding_remittances
ALTER TABLE "expense_withholding_remittances" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_remittances";
CREATE POLICY rls_org_member ON "expense_withholding_remittances" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_withholding_allocations
ALTER TABLE "expense_withholding_allocations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_allocations";
CREATE POLICY rls_org_member ON "expense_withholding_allocations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_card_debits
ALTER TABLE "expense_card_debits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_card_debits";
CREATE POLICY rls_org_member ON "expense_card_debits" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_refund_receipts
ALTER TABLE "expense_refund_receipts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_refund_receipts";
CREATE POLICY rls_org_member ON "expense_refund_receipts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_withholding_remittances_voids
ALTER TABLE "expense_withholding_remittances_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_withholding_remittances_voids";
CREATE POLICY rls_org_member ON "expense_withholding_remittances_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_card_debits_voids
ALTER TABLE "expense_card_debits_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_card_debits_voids";
CREATE POLICY rls_org_member ON "expense_card_debits_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_refund_receipts_voids
ALTER TABLE "expense_refund_receipts_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_refund_receipts_voids";
CREATE POLICY rls_org_member ON "expense_refund_receipts_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_invoices
ALTER TABLE "expense_invoices" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_invoices";
CREATE POLICY rls_org_member ON "expense_invoices" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_invoice_versions
ALTER TABLE "expense_invoice_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_invoice_versions";
CREATE POLICY rls_org_member ON "expense_invoice_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_details
ALTER TABLE "expense_details" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_details";
CREATE POLICY rls_org_member ON "expense_details" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_line_voids
ALTER TABLE "expense_line_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_line_voids";
CREATE POLICY rls_org_member ON "expense_line_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_source_files
ALTER TABLE "expense_source_files" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_source_files";
CREATE POLICY rls_org_member ON "expense_source_files" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_invoice_file_links
ALTER TABLE "expense_invoice_file_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_invoice_file_links";
CREATE POLICY rls_org_member ON "expense_invoice_file_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_invoice_file_unlinks
ALTER TABLE "expense_invoice_file_unlinks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_invoice_file_unlinks";
CREATE POLICY rls_org_member ON "expense_invoice_file_unlinks" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_pending_rows
ALTER TABLE "expense_pending_rows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_pending_rows";
CREATE POLICY rls_org_member ON "expense_pending_rows" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_import_batches
ALTER TABLE "expense_import_batches" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_import_batches";
CREATE POLICY rls_org_member ON "expense_import_batches" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_import_rows
ALTER TABLE "expense_import_rows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_import_rows";
CREATE POLICY rls_org_member ON "expense_import_rows" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_import_versions
ALTER TABLE "expense_import_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_import_versions";
CREATE POLICY rls_org_member ON "expense_import_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_import_events
ALTER TABLE "expense_import_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_import_events";
CREATE POLICY rls_org_member ON "expense_import_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_import_row_commits
ALTER TABLE "expense_import_row_commits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_import_row_commits";
CREATE POLICY rls_org_member ON "expense_import_row_commits" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_pending_resolutions
ALTER TABLE "expense_pending_resolutions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_pending_resolutions";
CREATE POLICY rls_org_member ON "expense_pending_resolutions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- cloud_analytics_state
ALTER TABLE "cloud_analytics_state" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "cloud_analytics_state";
CREATE POLICY rls_org_member ON "cloud_analytics_state" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- cloud_analytics_jobs
ALTER TABLE "cloud_analytics_jobs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "cloud_analytics_jobs";
CREATE POLICY rls_org_member ON "cloud_analytics_jobs" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- earning_types
ALTER TABLE "earning_types" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "earning_types";
CREATE POLICY rls_signed_in ON "earning_types" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- action_steps
ALTER TABLE "action_steps" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "action_steps";
CREATE POLICY rls_signed_in ON "action_steps" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- project_stages
ALTER TABLE "project_stages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "project_stages";
CREATE POLICY rls_signed_in ON "project_stages" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- project_stage_meanings
ALTER TABLE "project_stage_meanings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "project_stage_meanings";
CREATE POLICY rls_signed_in ON "project_stage_meanings" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- project_stage_events
ALTER TABLE "project_stage_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "project_stage_events";
CREATE POLICY rls_org_member ON "project_stage_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- earning_type_rate_versions
ALTER TABLE "earning_type_rate_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "earning_type_rate_versions";
CREATE POLICY rls_org_member ON "earning_type_rate_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- cashflow_categories
ALTER TABLE "cashflow_categories" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "cashflow_categories";
CREATE POLICY rls_org_member ON "cashflow_categories" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- contract_production_versions
ALTER TABLE "contract_production_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "contract_production_versions";
CREATE POLICY rls_org_member ON "contract_production_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- contract_production_milestones
ALTER TABLE "contract_production_milestones" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "contract_production_milestones";
CREATE POLICY rls_org_member ON "contract_production_milestones" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_periods
ALTER TABLE "yojitsu_periods" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_periods";
CREATE POLICY rls_org_member ON "yojitsu_periods" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_target_versions
ALTER TABLE "yojitsu_target_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_target_versions";
CREATE POLICY rls_org_member ON "yojitsu_target_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_plan_versions
ALTER TABLE "yojitsu_plan_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_plan_versions";
CREATE POLICY rls_org_member ON "yojitsu_plan_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_plan_amounts
ALTER TABLE "yojitsu_plan_amounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_plan_amounts";
CREATE POLICY rls_org_member ON "yojitsu_plan_amounts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- plan_adoptions
ALTER TABLE "plan_adoptions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "plan_adoptions";
CREATE POLICY rls_org_member ON "plan_adoptions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_variables
ALTER TABLE "yojitsu_variables" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_signed_in ON "yojitsu_variables";
CREATE POLICY rls_signed_in ON "yojitsu_variables" USING (rls_current_user_id() IS NOT NULL) WITH CHECK (rls_current_user_id() IS NOT NULL);

-- yojitsu_setting_versions
ALTER TABLE "yojitsu_setting_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_setting_versions";
CREATE POLICY rls_org_member ON "yojitsu_setting_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_forecast_versions
ALTER TABLE "yojitsu_forecast_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_forecast_versions";
CREATE POLICY rls_org_member ON "yojitsu_forecast_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_forecast_lines
ALTER TABLE "yojitsu_forecast_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_forecast_lines";
CREATE POLICY rls_org_member ON "yojitsu_forecast_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_activity_records
ALTER TABLE "yojitsu_activity_records" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_activity_records";
CREATE POLICY rls_org_member ON "yojitsu_activity_records" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_activity_cancellations
ALTER TABLE "yojitsu_activity_cancellations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_activity_cancellations";
CREATE POLICY rls_org_member ON "yojitsu_activity_cancellations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_cost_versions
ALTER TABLE "production_cost_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_cost_versions";
CREATE POLICY rls_org_member ON "production_cost_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- kpi_metric_versions
ALTER TABLE "kpi_metric_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "kpi_metric_versions";
CREATE POLICY rls_org_member ON "kpi_metric_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- kpi_metric_steps
ALTER TABLE "kpi_metric_steps" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "kpi_metric_steps";
CREATE POLICY rls_org_member ON "kpi_metric_steps" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- yojitsu_choice_versions
ALTER TABLE "yojitsu_choice_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "yojitsu_choice_versions";
CREATE POLICY rls_org_member ON "yojitsu_choice_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- investment_approval_versions
ALTER TABLE "investment_approval_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "investment_approval_versions";
CREATE POLICY rls_org_member ON "investment_approval_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_source_file_terms
ALTER TABLE "sales_source_file_terms" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_source_file_terms";
CREATE POLICY rls_org_member ON "sales_source_file_terms" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_voids
ALTER TABLE "report_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_voids";
CREATE POLICY rls_org_member ON "report_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_check_versions
ALTER TABLE "report_check_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_check_versions";
CREATE POLICY rls_org_member ON "report_check_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- report_check_cases
ALTER TABLE "report_check_cases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "report_check_cases";
CREATE POLICY rls_org_member ON "report_check_cases" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- source_check_runs
ALTER TABLE "source_check_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "source_check_runs";
CREATE POLICY rls_org_member ON "source_check_runs" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- source_sampling_reviews
ALTER TABLE "source_sampling_reviews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "source_sampling_reviews";
CREATE POLICY rls_org_member ON "source_sampling_reviews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_versions
ALTER TABLE "budget_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_versions";
CREATE POLICY rls_org_member ON "budget_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_version_lines
ALTER TABLE "budget_version_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_version_lines";
CREATE POLICY rls_org_member ON "budget_version_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_check_runs
ALTER TABLE "budget_check_runs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_check_runs";
CREATE POLICY rls_org_member ON "budget_check_runs" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_fixes
ALTER TABLE "budget_fixes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_fixes";
CREATE POLICY rls_org_member ON "budget_fixes" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- source_documents
ALTER TABLE "source_documents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "source_documents";
CREATE POLICY rls_org_member ON "source_documents" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_contracts
ALTER TABLE "acq_mg_contracts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_contracts";
CREATE POLICY rls_org_member ON "acq_mg_contracts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_term_versions
ALTER TABLE "acq_mg_term_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_versions";
CREATE POLICY rls_org_member ON "acq_mg_term_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_term_works
ALTER TABLE "acq_mg_term_works" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_works";
CREATE POLICY rls_org_member ON "acq_mg_term_works" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_term_deductions
ALTER TABLE "acq_mg_term_deductions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_deductions";
CREATE POLICY rls_org_member ON "acq_mg_term_deductions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_term_phases
ALTER TABLE "acq_mg_term_phases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_phases";
CREATE POLICY rls_org_member ON "acq_mg_term_phases" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_term_media_allocations
ALTER TABLE "acq_mg_term_media_allocations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_term_media_allocations";
CREATE POLICY rls_org_member ON "acq_mg_term_media_allocations" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_payment_schedule
ALTER TABLE "acq_mg_payment_schedule" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_payment_schedule";
CREATE POLICY rls_org_member ON "acq_mg_payment_schedule" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_report_links
ALTER TABLE "acq_mg_report_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_report_links";
CREATE POLICY rls_org_member ON "acq_mg_report_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_statements
ALTER TABLE "acq_mg_statements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_statements";
CREATE POLICY rls_org_member ON "acq_mg_statements" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_documents
ALTER TABLE "acq_mg_documents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_documents";
CREATE POLICY rls_org_member ON "acq_mg_documents" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- acq_mg_payments
ALTER TABLE "acq_mg_payments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "acq_mg_payments";
CREATE POLICY rls_org_member ON "acq_mg_payments" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_templates
ALTER TABLE "budget_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_templates";
CREATE POLICY rls_org_member ON "budget_templates" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_template_versions
ALTER TABLE "budget_template_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_template_versions";
CREATE POLICY rls_org_member ON "budget_template_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_template_items
ALTER TABLE "budget_template_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_template_items";
CREATE POLICY rls_org_member ON "budget_template_items" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_version_templates
ALTER TABLE "budget_version_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_version_templates";
CREATE POLICY rls_org_member ON "budget_version_templates" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- budget_line_items
ALTER TABLE "budget_line_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "budget_line_items";
CREATE POLICY rls_org_member ON "budget_line_items" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_file_placements
ALTER TABLE "expense_file_placements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_file_placements";
CREATE POLICY rls_org_member ON "expense_file_placements" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_file_placement_voids
ALTER TABLE "expense_file_placement_voids" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_file_placement_voids";
CREATE POLICY rls_org_member ON "expense_file_placement_voids" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- expense_month_closures
ALTER TABLE "expense_month_closures" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "expense_month_closures";
CREATE POLICY rls_org_member ON "expense_month_closures" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_templates
ALTER TABLE "committee_term_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_templates";
CREATE POLICY rls_org_member ON "committee_term_templates" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_version_templates
ALTER TABLE "committee_term_version_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_version_templates";
CREATE POLICY rls_org_member ON "committee_term_version_templates" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_businesses
ALTER TABLE "committee_term_businesses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_businesses";
CREATE POLICY rls_org_member ON "committee_term_businesses" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_business_steps
ALTER TABLE "committee_term_business_steps" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_business_steps";
CREATE POLICY rls_org_member ON "committee_term_business_steps" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_committee_steps
ALTER TABLE "committee_term_committee_steps" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_committee_steps";
CREATE POLICY rls_org_member ON "committee_term_committee_steps" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_term_budget_lines
ALTER TABLE "committee_term_budget_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_term_budget_lines";
CREATE POLICY rls_org_member ON "committee_term_budget_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_schedule_versions
ALTER TABLE "committee_schedule_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_schedule_versions";
CREATE POLICY rls_org_member ON "committee_schedule_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_schedule_version_phases
ALTER TABLE "committee_schedule_version_phases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_schedule_version_phases";
CREATE POLICY rls_org_member ON "committee_schedule_version_phases" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_round_overrides
ALTER TABLE "committee_round_overrides" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_round_overrides";
CREATE POLICY rls_org_member ON "committee_round_overrides" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- committee_ledger_entries
ALTER TABLE "committee_ledger_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "committee_ledger_entries";
CREATE POLICY rls_org_member ON "committee_ledger_entries" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- bank_accounts
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "bank_accounts";
CREATE POLICY rls_org_member ON "bank_accounts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- bank_statement_imports
ALTER TABLE "bank_statement_imports" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "bank_statement_imports";
CREATE POLICY rls_org_member ON "bank_statement_imports" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- bank_statement_lines
ALTER TABLE "bank_statement_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "bank_statement_lines";
CREATE POLICY rls_org_member ON "bank_statement_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- journal_entries
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "journal_entries";
CREATE POLICY rls_org_member ON "journal_entries" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- journal_lines
ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "journal_lines";
CREATE POLICY rls_org_member ON "journal_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mfg_products
ALTER TABLE "mfg_products" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mfg_products";
CREATE POLICY rls_org_member ON "mfg_products" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mfg_product_versions
ALTER TABLE "mfg_product_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mfg_product_versions";
CREATE POLICY rls_org_member ON "mfg_product_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mfg_step_events
ALTER TABLE "mfg_step_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mfg_step_events";
CREATE POLICY rls_org_member ON "mfg_step_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mfg_purchase_orders
ALTER TABLE "mfg_purchase_orders" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mfg_purchase_orders";
CREATE POLICY rls_org_member ON "mfg_purchase_orders" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mfg_purchase_order_lines
ALTER TABLE "mfg_purchase_order_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mfg_purchase_order_lines";
CREATE POLICY rls_org_member ON "mfg_purchase_order_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mfg_po_events
ALTER TABLE "mfg_po_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mfg_po_events";
CREATE POLICY rls_org_member ON "mfg_po_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mfg_receipts
ALTER TABLE "mfg_receipts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mfg_receipts";
CREATE POLICY rls_org_member ON "mfg_receipts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- mfg_po_expenses
ALTER TABLE "mfg_po_expenses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "mfg_po_expenses";
CREATE POLICY rls_org_member ON "mfg_po_expenses" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- produce_tasks
ALTER TABLE "produce_tasks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "produce_tasks";
CREATE POLICY rls_org_member ON "produce_tasks" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- produce_task_events
ALTER TABLE "produce_task_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "produce_task_events";
CREATE POLICY rls_org_member ON "produce_task_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- produce_task_checks
ALTER TABLE "produce_task_checks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "produce_task_checks";
CREATE POLICY rls_org_member ON "produce_task_checks" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- produce_task_posts
ALTER TABLE "produce_task_posts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "produce_task_posts";
CREATE POLICY rls_org_member ON "produce_task_posts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- produce_task_links
ALTER TABLE "produce_task_links" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "produce_task_links";
CREATE POLICY rls_org_member ON "produce_task_links" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- produce_task_templates
ALTER TABLE "produce_task_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "produce_task_templates";
CREATE POLICY rls_org_member ON "produce_task_templates" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- produce_task_template_items
ALTER TABLE "produce_task_template_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "produce_task_template_items";
CREATE POLICY rls_org_member ON "produce_task_template_items" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- post_cuts
ALTER TABLE "post_cuts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "post_cuts";
CREATE POLICY rls_org_member ON "post_cuts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- post_notes
ALTER TABLE "post_notes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "post_notes";
CREATE POLICY rls_org_member ON "post_notes" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- post_note_actions
ALTER TABLE "post_note_actions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "post_note_actions";
CREATE POLICY rls_org_member ON "post_note_actions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- post_tasks
ALTER TABLE "post_tasks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "post_tasks";
CREATE POLICY rls_org_member ON "post_tasks" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- post_task_events
ALTER TABLE "post_task_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "post_task_events";
CREATE POLICY rls_org_member ON "post_task_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- post_deliverable_items
ALTER TABLE "post_deliverable_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "post_deliverable_items";
CREATE POLICY rls_org_member ON "post_deliverable_items" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- post_deliverable_events
ALTER TABLE "post_deliverable_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "post_deliverable_events";
CREATE POLICY rls_org_member ON "post_deliverable_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_proposals
ALTER TABLE "sales_proposals" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_proposals";
CREATE POLICY rls_org_member ON "sales_proposals" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_proposal_windows
ALTER TABLE "sales_proposal_windows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_proposal_windows";
CREATE POLICY rls_org_member ON "sales_proposal_windows" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_proposal_reviews
ALTER TABLE "sales_proposal_reviews" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_proposal_reviews";
CREATE POLICY rls_org_member ON "sales_proposal_reviews" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_proposal_review_factors
ALTER TABLE "sales_proposal_review_factors" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_proposal_review_factors";
CREATE POLICY rls_org_member ON "sales_proposal_review_factors" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- sales_activity_notes
ALTER TABLE "sales_activity_notes" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "sales_activity_notes";
CREATE POLICY rls_org_member ON "sales_activity_notes" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_documents
ALTER TABLE "planning_documents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_documents";
CREATE POLICY rls_org_member ON "planning_documents" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_profile_versions
ALTER TABLE "planning_profile_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_profile_versions";
CREATE POLICY rls_org_member ON "planning_profile_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_profile_people
ALTER TABLE "planning_profile_people" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_profile_people";
CREATE POLICY rls_org_member ON "planning_profile_people" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_trial_versions
ALTER TABLE "planning_trial_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_trial_versions";
CREATE POLICY rls_org_member ON "planning_trial_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_trial_rates
ALTER TABLE "planning_trial_rates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_trial_rates";
CREATE POLICY rls_org_member ON "planning_trial_rates" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_trial_lines
ALTER TABLE "planning_trial_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_trial_lines";
CREATE POLICY rls_org_member ON "planning_trial_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_trial_investments
ALTER TABLE "planning_trial_investments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_trial_investments";
CREATE POLICY rls_org_member ON "planning_trial_investments" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- project_owner_versions
ALTER TABLE "project_owner_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "project_owner_versions";
CREATE POLICY rls_org_member ON "project_owner_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_materials
ALTER TABLE "planning_materials" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_materials";
CREATE POLICY rls_org_member ON "planning_materials" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- planning_facts
ALTER TABLE "planning_facts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "planning_facts";
CREATE POLICY rls_org_member ON "planning_facts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- shooting_scene_results
ALTER TABLE "shooting_scene_results" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "shooting_scene_results";
CREATE POLICY rls_org_member ON "shooting_scene_results" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- shooting_day_records
ALTER TABLE "shooting_day_records" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "shooting_day_records";
CREATE POLICY rls_org_member ON "shooting_day_records" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- shooting_day_report_items
ALTER TABLE "shooting_day_report_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "shooting_day_report_items";
CREATE POLICY rls_org_member ON "shooting_day_report_items" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_cases
ALTER TABLE "chotatsu_cases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_cases";
CREATE POLICY rls_org_member ON "chotatsu_cases" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_case_versions
ALTER TABLE "chotatsu_case_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_case_versions";
CREATE POLICY rls_org_member ON "chotatsu_case_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_stage_events
ALTER TABLE "chotatsu_stage_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_stage_events";
CREATE POLICY rls_org_member ON "chotatsu_stage_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_estimates
ALTER TABLE "chotatsu_estimates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_estimates";
CREATE POLICY rls_org_member ON "chotatsu_estimates" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_estimate_lines
ALTER TABLE "chotatsu_estimate_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_estimate_lines";
CREATE POLICY rls_org_member ON "chotatsu_estimate_lines" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_agreements
ALTER TABLE "chotatsu_agreements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_agreements";
CREATE POLICY rls_org_member ON "chotatsu_agreements" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_ringi
ALTER TABLE "chotatsu_ringi" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_ringi";
CREATE POLICY rls_org_member ON "chotatsu_ringi" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_contracts
ALTER TABLE "chotatsu_contracts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_contracts";
CREATE POLICY rls_org_member ON "chotatsu_contracts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_materials
ALTER TABLE "chotatsu_materials" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_materials";
CREATE POLICY rls_org_member ON "chotatsu_materials" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_handoffs
ALTER TABLE "chotatsu_handoffs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_handoffs";
CREATE POLICY rls_org_member ON "chotatsu_handoffs" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_handoff_events
ALTER TABLE "chotatsu_handoff_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_handoff_events";
CREATE POLICY rls_org_member ON "chotatsu_handoff_events" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_documents
ALTER TABLE "chotatsu_documents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_documents";
CREATE POLICY rls_org_member ON "chotatsu_documents" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- chotatsu_case_expenses
ALTER TABLE "chotatsu_case_expenses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "chotatsu_case_expenses";
CREATE POLICY rls_org_member ON "chotatsu_case_expenses" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- production_arrangement_versions
ALTER TABLE "production_arrangement_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "production_arrangement_versions";
CREATE POLICY rls_org_member ON "production_arrangement_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- scene_art_item_versions
ALTER TABLE "scene_art_item_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "scene_art_item_versions";
CREATE POLICY rls_org_member ON "scene_art_item_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- scene_shoot_plan_versions
ALTER TABLE "scene_shoot_plan_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "scene_shoot_plan_versions";
CREATE POLICY rls_org_member ON "scene_shoot_plan_versions" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- preprod_document_placements
ALTER TABLE "preprod_document_placements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "preprod_document_placements";
CREATE POLICY rls_org_member ON "preprod_document_placements" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- notebook_spaces
ALTER TABLE "notebook_spaces" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "notebook_spaces";
CREATE POLICY rls_org_member ON "notebook_spaces" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- notebook_posts
ALTER TABLE "notebook_posts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "notebook_posts";
CREATE POLICY rls_org_member ON "notebook_posts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- notebook_receipts
ALTER TABLE "notebook_receipts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "notebook_receipts";
CREATE POLICY rls_org_member ON "notebook_receipts" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- source_document_moves
ALTER TABLE "source_document_moves" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_org_member ON "source_document_moves";
CREATE POLICY rls_org_member ON "source_document_moves" USING (org_id = ANY ((SELECT rls_member_org_ids())::bigint[])) WITH CHECK (org_id = ANY ((SELECT rls_member_org_ids())::bigint[]));

-- schema_source_fingerprint
-- schema_source_fingerprint: RLS をかけない（scripts/pg-rls.mjs の NON_ORG_TABLES に理由）
