-- Generated from an empty LocalDatabase(':memory:') schema and static reference codes.
-- No demo organization, user, project, work, or operational rows are seeded.
-- Do not apply automatically to an existing production database.


CREATE TABLE ai_usage (
  org_id INTEGER PRIMARY KEY REFERENCES organizations(id), calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL, version_hash TEXT, detail_json TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE billing_invoice_line_works (
  org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, work_id INTEGER NOT NULL, allocation_bps INTEGER NOT NULL,
  PRIMARY KEY(org_id,invoice_id,sale_id,work_id), CHECK(allocation_bps BETWEEN 1 AND 10000),
  FOREIGN KEY(org_id,invoice_id,sale_id) REFERENCES billing_invoice_lines(org_id,invoice_id,sale_id), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);

CREATE TABLE billing_invoice_lines (
  org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL, work_id INTEGER NOT NULL, product_id INTEGER, partner_id INTEGER NOT NULL,
  description TEXT NOT NULL, accounting_month TEXT NOT NULL, source_row INTEGER,
  amount_ex_tax INTEGER NOT NULL, tax_amount INTEGER NOT NULL, amount_inc_tax INTEGER NOT NULL,
  PRIMARY KEY(org_id,invoice_id,sale_id), UNIQUE(org_id,sale_id,invoice_id),
  CHECK(amount_inc_tax=amount_ex_tax+tax_amount),
  FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id), FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id), FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE billing_invoice_sequences (
  org_id INTEGER NOT NULL, year_month TEXT NOT NULL, last_number INTEGER NOT NULL CHECK(last_number>0),
  PRIMARY KEY(org_id,year_month), FOREIGN KEY(org_id) REFERENCES organizations(id),
  CHECK(year_month GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]')
);

CREATE TABLE billing_invoice_voids (
  org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, voided_on TEXT NOT NULL, reason TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,invoice_id), FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id), CHECK(length(trim(reason)) BETWEEN 1 AND 1000)
);

CREATE TABLE billing_invoices (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, invoice_number TEXT NOT NULL, partner_id INTEGER NOT NULL,
  invoice_date TEXT NOT NULL, due_date TEXT NOT NULL, source_amount_basis TEXT NOT NULL CHECK(source_amount_basis='platform_net'),
  amount_ex_tax INTEGER NOT NULL, tax_amount INTEGER NOT NULL, amount_inc_tax INTEGER NOT NULL CHECK(amount_inc_tax>0),
  status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','void')), note TEXT,
  snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,invoice_number), UNIQUE(org_id,snapshot_hash),
  CHECK(due_date>=invoice_date), CHECK(amount_inc_tax=amount_ex_tax+tax_amount),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE billing_receipt_allocations (
  org_id INTEGER NOT NULL, receipt_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, amount_yen INTEGER NOT NULL CHECK(amount_yen>0),
  PRIMARY KEY(org_id,receipt_id,invoice_id), FOREIGN KEY(org_id,receipt_id) REFERENCES billing_receipts(org_id,id),
  FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id)
);

CREATE TABLE billing_receipt_reversals (
  org_id INTEGER NOT NULL, receipt_id INTEGER NOT NULL, reversed_on TEXT NOT NULL, reason TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,receipt_id), FOREIGN KEY(org_id,receipt_id) REFERENCES billing_receipts(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id), CHECK(length(trim(reason)) BETWEEN 1 AND 1000)
);

CREATE TABLE billing_receipts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, reference TEXT NOT NULL,
  received_on TEXT NOT NULL, amount_yen INTEGER NOT NULL CHECK(amount_yen>0), allocation_count INTEGER NOT NULL CHECK(allocation_count>0),
  note TEXT, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by INTEGER NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,partner_id,reference), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id), CHECK(length(trim(reference)) BETWEEN 1 AND 160)
);

CREATE TABLE billing_sale_claims (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,sale_id), FOREIGN KEY(org_id,invoice_id,sale_id) REFERENCES billing_invoice_lines(org_id,invoice_id,sale_id)
);

CREATE TABLE broadcast_airings (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, slot_id INTEGER NOT NULL,
 aired_on TEXT NOT NULL, run_count INTEGER NOT NULL CHECK(run_count BETWEEN 1 AND 9999),
 source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0), note TEXT,
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), FOREIGN KEY(org_id,work_id,slot_id) REFERENCES broadcast_slots(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE broadcast_availability_previews (
 token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE broadcast_availability_rates (
 org_id INTEGER NOT NULL, availability_version_id INTEGER NOT NULL,
 rate_bps INTEGER CHECK(rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
 PRIMARY KEY(org_id,availability_version_id),
 FOREIGN KEY(org_id,availability_version_id) REFERENCES sales_availability_versions(org_id,id)
);

CREATE TABLE broadcast_import_previews (
 token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
 payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE broadcast_sale_links (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, slot_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
 note TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,sale_id),
 FOREIGN KEY(org_id,work_id,slot_id) REFERENCES broadcast_slots(org_id,work_id,id),
 FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE broadcast_slot_versions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, slot_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 broadcast_month TEXT NOT NULL CHECK(broadcast_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
 station_name TEXT NOT NULL CHECK(length(trim(station_name)) BETWEEN 1 AND 200),
 customer_partner_id INTEGER, agency_partner_id INTEGER, agreement_id INTEGER,
 period_from TEXT NOT NULL, period_to TEXT NOT NULL, planned_on TEXT,
 planned_runs INTEGER NOT NULL DEFAULT 1 CHECK(planned_runs BETWEEN 1 AND 9999),
 status TEXT NOT NULL CHECK(status IN ('draft','pending_first','tentative','pending_final','confirmed','rejected','cancelled')),
 reason TEXT, source_reference TEXT, changed_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,slot_id,revision),
 FOREIGN KEY(org_id,work_id,slot_id) REFERENCES broadcast_slots(org_id,work_id,id),
 FOREIGN KEY(org_id,customer_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,agency_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,agreement_id,work_id) REFERENCES sales_agreements(org_id,id,work_id),
 FOREIGN KEY(org_id,changed_by) REFERENCES memberships(org_id,user_id),
 CHECK(period_to>=period_from), CHECK(substr(period_from,1,7)=broadcast_month), CHECK(substr(period_to,1,7)=broadcast_month),
 CHECK(planned_on IS NULL OR (planned_on>=period_from AND planned_on<=period_to))
);

CREATE TABLE broadcast_slots (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  name TEXT NOT NULL, objective TEXT NOT NULL, audience_hypothesis TEXT, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
  target_region TEXT, target_channel TEXT, version INTEGER NOT NULL DEFAULT 1, CHECK(ends_on>=starts_on), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);

CREATE TABLE catalog_credits (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('director','writer','cast','staff')), name TEXT NOT NULL CHECK(length(trim(name))>0), detail TEXT,
 PRIMARY KEY(org_id,work_id,revision,position), FOREIGN KEY(org_id,work_id,revision) REFERENCES catalog_profiles(org_id,work_id,revision)
);

CREATE TABLE catalog_edition_tags (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, edition_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('country','language','music_society')), value TEXT NOT NULL CHECK(length(trim(value))>0),
 PRIMARY KEY(org_id,work_id,revision,edition_key,kind,value), FOREIGN KEY(org_id,work_id,revision,edition_key) REFERENCES catalog_editions(org_id,work_id,revision,edition_key)
);

CREATE TABLE catalog_editions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, edition_key TEXT NOT NULL, name TEXT NOT NULL CHECK(length(trim(name))>0),
 runtime_seconds INTEGER CHECK(runtime_seconds>0 AND runtime_seconds<360000), aspect_ratio TEXT, rating_authority TEXT, rating_code TEXT,
 PRIMARY KEY(org_id,work_id,revision,edition_key), FOREIGN KEY(org_id,work_id,revision) REFERENCES catalog_profiles(org_id,work_id,revision)
);

CREATE TABLE catalog_product_editions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, product_id INTEGER NOT NULL, edition_key TEXT NOT NULL,
 PRIMARY KEY(org_id,work_id,revision,product_id), FOREIGN KEY(org_id,product_id,work_id) REFERENCES product_works(org_id,product_id,work_id),
 FOREIGN KEY(org_id,work_id,revision,edition_key) REFERENCES catalog_editions(org_id,work_id,revision,edition_key)
);

CREATE TABLE catalog_product_windows (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
 distribution_code TEXT NOT NULL REFERENCES distribution_types(code), territory TEXT NOT NULL CHECK(length(trim(territory))>0), window_key TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), release_on TEXT, sales_end_on TEXT, terms_text TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('draft','confirmed','withdrawn')), source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,work_id,product_id,distribution_code,territory,window_key,revision),
 FOREIGN KEY(org_id,product_id,work_id) REFERENCES product_works(org_id,product_id,work_id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(sales_end_on IS NULL OR release_on IS NULL OR sales_end_on>=release_on),
 CHECK(status<>'confirmed' OR (release_on IS NOT NULL AND sales_end_on IS NOT NULL AND length(trim(terms_text))>0))
);

CREATE TABLE catalog_profiles (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 synopsis_long TEXT, synopsis_short TEXT, catch_long TEXT, catch_short TEXT,
 production_year INTEGER CHECK(production_year BETWEEN 1880 AND 2200), creation_year INTEGER CHECK(creation_year BETWEEN 1880 AND 2200),
 source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,work_id,revision), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE change_proposals (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), requested_by INTEGER NOT NULL REFERENCES users(id),
  request_text TEXT NOT NULL, field_key TEXT NOT NULL, label TEXT NOT NULL, value_type TEXT NOT NULL,
  unit TEXT, aggregation TEXT NOT NULL, sample_header TEXT NOT NULL, meaning_reason TEXT NOT NULL, affected_apps_json TEXT NOT NULL,
  base_schema_version INTEGER NOT NULL, proposal_hash TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('offline-rule','ai-json','workers-ai','service')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','adopted','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, decided_by INTEGER REFERENCES users(id), UNIQUE(org_id,proposal_hash)
);

CREATE TABLE committee_contracts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  intake_case_id INTEGER NOT NULL, document_id INTEGER NOT NULL, contract_code TEXT NOT NULL, title TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,id,work_id), UNIQUE(org_id,contract_code),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,intake_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
  FOREIGN KEY(org_id,intake_case_id,document_id) REFERENCES rights_intake_documents(org_id,intake_case_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE committee_report_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);

CREATE TABLE committee_report_snapshots (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  contract_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, period_index INTEGER NOT NULL,
  period_from TEXT NOT NULL, period_to TEXT NOT NULL, close_on TEXT NOT NULL, report_on TEXT NOT NULL, payment_on TEXT NOT NULL,
  period_date_basis TEXT NOT NULL CHECK(period_date_basis IN ('sales_period','report_received')),
  stub INTEGER NOT NULL CHECK(stub IN (0,1)), allow_stub INTEGER NOT NULL CHECK(allow_stub IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status='draft'), verification TEXT NOT NULL DEFAULT 'unverified' CHECK(verification='unverified'),
  calculation_version TEXT NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL, calculation_json TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,id,work_id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,contract_id,work_id) REFERENCES committee_contracts(org_id,id,work_id),
  FOREIGN KEY(org_id,contract_id,term_version_id) REFERENCES committee_term_versions(org_id,contract_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE committee_schedule_phases (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, phase_order INTEGER NOT NULL CHECK(phase_order>0),
  label TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, first_close_on TEXT NOT NULL,
  interval_months INTEGER NOT NULL CHECK(interval_months BETWEEN 1 AND 12), close_day TEXT NOT NULL,
  report_offset_months INTEGER NOT NULL CHECK(report_offset_months BETWEEN 0 AND 24), report_day TEXT NOT NULL,
  payment_offset_months INTEGER NOT NULL CHECK(payment_offset_months BETWEEN 0 AND 24), payment_day TEXT NOT NULL,
  reference_type TEXT NOT NULL CHECK(reference_type IN ('release','first_sales','first_report','contract_specific')), reference_date TEXT NOT NULL,
  CHECK(ends_on>=starts_on AND first_close_on>=starts_on AND first_close_on<=ends_on),
  UNIQUE(org_id,id), UNIQUE(org_id,term_version_id,phase_order),
  FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id)
);

CREATE TABLE committee_snapshot_deductions (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, work_id INTEGER NOT NULL, report_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('royalty','production_recoup')), recipient_partner_id INTEGER NOT NULL,
  amount_yen INTEGER NOT NULL CHECK(amount_yen>0), source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0),
  PRIMARY KEY(org_id,snapshot_id,source_reference), UNIQUE(org_id,work_id,source_reference),
  FOREIGN KEY(org_id,snapshot_id,work_id) REFERENCES committee_report_snapshots(org_id,id,work_id),
  FOREIGN KEY(org_id,snapshot_id,report_id) REFERENCES committee_snapshot_reports(org_id,snapshot_id,report_id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id),
  FOREIGN KEY(org_id,recipient_partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE committee_snapshot_expenses (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, work_id INTEGER NOT NULL, expense_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  amount_ex_tax INTEGER NOT NULL, PRIMARY KEY(org_id,snapshot_id,expense_id), UNIQUE(org_id,expense_id),
  FOREIGN KEY(org_id,snapshot_id,work_id) REFERENCES committee_report_snapshots(org_id,id,work_id),
  FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id)
);

CREATE TABLE committee_snapshot_lines (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, work_id INTEGER NOT NULL, report_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
  window_id INTEGER NOT NULL, source_row INTEGER, allocation_bps INTEGER NOT NULL, allocated_amount_ex_tax INTEGER NOT NULL,
  sales_period_from TEXT NOT NULL, sales_period_to TEXT NOT NULL, accounting_month TEXT NOT NULL,
  PRIMARY KEY(org_id,snapshot_id,sale_id,work_id),
  FOREIGN KEY(org_id,snapshot_id,work_id) REFERENCES committee_report_snapshots(org_id,id,work_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id)
);

CREATE TABLE committee_snapshot_member_amounts (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, window_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  share_bps INTEGER NOT NULL, amount_yen INTEGER NOT NULL, route TEXT NOT NULL CHECK(route IN ('direct','via_manager')),
  window_fee_recipient INTEGER NOT NULL CHECK(window_fee_recipient IN (0,1)), manager_fee_recipient INTEGER NOT NULL CHECK(manager_fee_recipient IN (0,1)),
  PRIMARY KEY(org_id,snapshot_id,window_id,partner_id),
  FOREIGN KEY(org_id,snapshot_id) REFERENCES committee_report_snapshots(org_id,id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE committee_snapshot_reports (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, work_id INTEGER NOT NULL, report_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  report_basis TEXT NOT NULL CHECK(report_basis IN ('gross','net')),
  PRIMARY KEY(org_id,snapshot_id,report_id), UNIQUE(org_id,work_id,report_id),
  FOREIGN KEY(org_id,snapshot_id,work_id) REFERENCES committee_report_snapshots(org_id,id,work_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id)
);

CREATE TABLE committee_term_funding (
  org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, production_cost_yen INTEGER NOT NULL CHECK(production_cost_yen>=0),
  PRIMARY KEY(org_id,term_version_id),
  FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id)
);

CREATE TABLE committee_term_investments (
  org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, amount_yen INTEGER NOT NULL CHECK(amount_yen>=0),
  PRIMARY KEY(org_id,term_version_id,partner_id),
  FOREIGN KEY(org_id,term_version_id,partner_id) REFERENCES committee_term_members(org_id,term_version_id,partner_id)
);

CREATE TABLE committee_term_members (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  role TEXT, share_bps INTEGER NOT NULL CHECK(share_bps BETWEEN 0 AND 10000), member_order INTEGER NOT NULL CHECK(member_order>0),
  UNIQUE(org_id,id), UNIQUE(org_id,term_version_id,partner_id), UNIQUE(org_id,term_version_id,member_order),
  FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE committee_term_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  source_version_id INTEGER, manager_partner_id INTEGER, calculation_version TEXT NOT NULL,
  note TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,contract_id,id), UNIQUE(org_id,contract_id,version_no),
  FOREIGN KEY(org_id,contract_id) REFERENCES committee_contracts(org_id,id),
  FOREIGN KEY(org_id,contract_id,source_version_id) REFERENCES committee_term_versions(org_id,contract_id,id),
  FOREIGN KEY(org_id,manager_partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE committee_term_windows (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other')), label TEXT NOT NULL, window_partner_id INTEGER NOT NULL,
  route TEXT NOT NULL CHECK(route IN ('direct','via_manager')), platform_rate_bps INTEGER NOT NULL CHECK(platform_rate_bps BETWEEN 0 AND 10000),
  window_fee_bps INTEGER NOT NULL CHECK(window_fee_bps BETWEEN 0 AND 10000), manager_fee_bps INTEGER NOT NULL CHECK(manager_fee_bps BETWEEN 0 AND 10000),
  fee_order TEXT NOT NULL CHECK(fee_order IN ('window_first','manager_first')),
  window_fee_basis TEXT NOT NULL CHECK(window_fee_basis IN ('platform_net','after_manager')),
  manager_fee_basis TEXT NOT NULL CHECK(manager_fee_basis IN ('platform_net','after_window')),
  UNIQUE(org_id,id), UNIQUE(org_id,term_version_id,id), UNIQUE(org_id,term_version_id,kind),
  FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id),
  FOREIGN KEY(org_id,window_partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE day_scene_assignments (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, shooting_day_id INTEGER NOT NULL,
  scene_id INTEGER NOT NULL, sequence_order INTEGER NOT NULL CHECK(sequence_order>0),
  planned_start TEXT, planned_end TEXT, actual_start TEXT, actual_end TEXT,
  outcome TEXT NOT NULL DEFAULT 'planned' CHECK(outcome IN ('planned','partial','shot','not_shot')), notes TEXT,
  UNIQUE(org_id,id), UNIQUE(org_id,shooting_day_id,scene_id), UNIQUE(org_id,shooting_day_id,sequence_order),
  CHECK(planned_end IS NULL OR planned_start IS NULL OR planned_end>planned_start),
  CHECK(actual_end IS NULL OR actual_start IS NULL OR actual_end>actual_start),
  FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id)
);

CREATE TABLE digital_sale_details (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('est','tvod','svod','avod','flat','mg')),
  service_code TEXT NOT NULL CHECK(length(trim(service_code))>0),
  sales_count INTEGER CHECK(sales_count IS NULL OR sales_count>=0),
  view_count INTEGER CHECK(view_count IS NULL OR view_count>=0),
  view_seconds INTEGER CHECK(view_seconds IS NULL OR view_seconds>=0),
  unit_price_ex_tax TEXT, holder_unit_price_ex_tax TEXT,
  contract_amount_ex_tax TEXT, contract_period_from TEXT, contract_period_to TEXT,
  reported_actual_ex_tax TEXT, reported_recognized_ex_tax TEXT, calculated_actual_ex_tax TEXT,
  PRIMARY KEY(org_id,sale_id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  CHECK((model IN ('est','tvod') AND view_count IS NULL AND view_seconds IS NULL AND contract_amount_ex_tax IS NULL)
     OR (model IN ('svod','avod') AND sales_count IS NULL AND unit_price_ex_tax IS NULL AND contract_amount_ex_tax IS NULL)
     OR (model IN ('flat','mg') AND sales_count IS NULL AND view_count IS NULL AND view_seconds IS NULL AND unit_price_ex_tax IS NULL)),
  CHECK(model='flat' OR (contract_amount_ex_tax IS NULL AND contract_period_from IS NULL AND contract_period_to IS NULL)),
  CHECK(contract_amount_ex_tax IS NULL OR (contract_period_from IS NOT NULL AND contract_period_to IS NOT NULL AND contract_period_to>=contract_period_from))
);

CREATE TABLE distribution_master (
 code TEXT PRIMARY KEY REFERENCES distribution_types(code), distribution_name TEXT NOT NULL, transaction_method TEXT NOT NULL, sales_type TEXT NOT NULL, notes TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_row INTEGER NOT NULL
);

CREATE TABLE distribution_types (
 code TEXT PRIMARY KEY, family TEXT NOT NULL, label TEXT NOT NULL, utilization TEXT, sort_order INTEGER NOT NULL
);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER,
  partner_id INTEGER, incurred_on TEXT NOT NULL, accounting_month TEXT NOT NULL CHECK(accounting_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  category TEXT NOT NULL, description TEXT NOT NULL, budget_yen INTEGER CHECK(budget_yen IS NULL OR budget_yen>=0),
  actual_ex_tax INTEGER NOT NULL, tax_amount INTEGER NOT NULL, actual_inc_tax INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CHECK(actual_inc_tax=actual_ex_tax+tax_amount), UNIQUE(org_id,id), FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE exposures (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, campaign_id INTEGER NOT NULL, medium TEXT NOT NULL, asset_version TEXT,
  scheduled_at TEXT, happened_at TEXT, source_url TEXT, region TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
);

CREATE TABLE import_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);

CREATE TABLE intake_settlement_links (
  org_id INTEGER NOT NULL, intake_case_id INTEGER NOT NULL, work_id INTEGER NOT NULL, settlement_contract_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,intake_case_id,settlement_contract_id), UNIQUE(org_id,settlement_contract_id),
  FOREIGN KEY(org_id,intake_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
  FOREIGN KEY(org_id,settlement_contract_id,work_id) REFERENCES settlement_contracts(org_id,id,work_id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE invitations (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), email TEXT NOT NULL CHECK(email=lower(email)),
  project_id INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','production')), expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,email,project_id,status), FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE joint_business_holidays (
  org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, holiday_on TEXT NOT NULL, label TEXT NOT NULL,
  PRIMARY KEY(org_id,contract_id,holiday_on), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id)
);

CREATE TABLE joint_committee_contracts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  code TEXT NOT NULL, title TEXT NOT NULL, calculation_version TEXT NOT NULL CHECK(calculation_version='joint_cash_v1'),
  demo_flag INTEGER NOT NULL DEFAULT 0 CHECK(demo_flag IN (0,1)), manager_partner_id INTEGER NOT NULL,
  producer_partner_id INTEGER NOT NULL, production_cost_inc_tax_yen INTEGER NOT NULL CHECK(production_cost_inc_tax_yen>=0),
  pa_inc_tax_yen INTEGER NOT NULL CHECK(pa_inc_tax_yen>=0), manager_fee_bps INTEGER NOT NULL CHECK(manager_fee_bps BETWEEN 0 AND 10000),
  income_threshold_yen INTEGER NOT NULL CHECK(income_threshold_yen>=0), transfer_threshold_yen INTEGER NOT NULL CHECK(transfer_threshold_yen>=0), investor_report_offset_months INTEGER NOT NULL,
  investor_report_day TEXT NOT NULL, investor_payment_offset_months INTEGER NOT NULL, investor_payment_day TEXT NOT NULL,
  terms_note TEXT NOT NULL, UNIQUE(org_id,id), UNIQUE(org_id,code),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
  FOREIGN KEY(org_id,manager_partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,producer_partner_id) REFERENCES partners(org_id,id),
  CHECK(manager_partner_id<>producer_partner_id)
);

CREATE TABLE joint_committee_costs (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, window_id INTEGER,
  period_sequence INTEGER NOT NULL, source_ref TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('window_direct','music_window_paid','rights_manager','master_management','bank_advance')),
  amount_yen INTEGER NOT NULL CHECK(amount_yen>=0), tax_basis TEXT NOT NULL CHECK(tax_basis IN ('ex_tax','inc_tax')),
  approved INTEGER NOT NULL CHECK(approved=1), UNIQUE(org_id,contract_id,source_ref),
  FOREIGN KEY(org_id,contract_id,period_sequence) REFERENCES joint_committee_periods(org_id,contract_id,sequence),
  FOREIGN KEY(org_id,contract_id,window_id) REFERENCES joint_committee_windows(org_id,contract_id,id),
  CHECK((kind IN ('window_direct','music_window_paid') AND window_id IS NOT NULL) OR (kind NOT IN ('window_direct','music_window_paid') AND window_id IS NULL))
);

CREATE TABLE joint_committee_members (
  org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role='investor'), share_bps INTEGER NOT NULL CHECK(share_bps BETWEEN 0 AND 10000),
  contribution_inc_tax_yen INTEGER NOT NULL CHECK(contribution_inc_tax_yen>=0),
  PRIMARY KEY(org_id,contract_id,partner_id), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE joint_committee_periods (
  org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
  from_on TEXT NOT NULL, to_on TEXT NOT NULL, PRIMARY KEY(org_id,contract_id,sequence),
  FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id), CHECK(from_on<=to_on)
);

CREATE TABLE joint_committee_sales (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  period_sequence INTEGER NOT NULL, source_ref TEXT NOT NULL, amount_contract_yen INTEGER NOT NULL CHECK(amount_contract_yen>=0),
  gross_inc_tax_yen INTEGER NOT NULL CHECK(gross_inc_tax_yen>=0), reported_on TEXT, manager_receipt_on TEXT,
  UNIQUE(org_id,contract_id,source_ref),
  FOREIGN KEY(org_id,contract_id,period_sequence) REFERENCES joint_committee_periods(org_id,contract_id,sequence),
  FOREIGN KEY(org_id,contract_id,window_id) REFERENCES joint_committee_windows(org_id,contract_id,id)
);

CREATE TABLE joint_committee_snapshots (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL,
  calculation_version TEXT NOT NULL CHECK(calculation_version='joint_cash_v1'), input_hash TEXT NOT NULL,
  calculation_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,contract_id,input_hash), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id)
);

CREATE TABLE joint_committee_windows (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, kind TEXT NOT NULL,
  label TEXT NOT NULL, partner_id INTEGER NOT NULL, fee_bps INTEGER NOT NULL CHECK(fee_bps BETWEEN 0 AND 10000),
  report_offset_months INTEGER NOT NULL, report_day TEXT NOT NULL, payment_offset_months INTEGER NOT NULL, payment_day TEXT NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,contract_id,id), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE joint_funding_events (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cash_contribution','production_payment_credit')),
  source_ref TEXT NOT NULL, amount_inc_tax_yen INTEGER NOT NULL CHECK(amount_inc_tax_yen>0),
  paid_on TEXT NOT NULL, milestone_id INTEGER,
  UNIQUE(org_id,contract_id,source_ref), FOREIGN KEY(org_id,contract_id,partner_id) REFERENCES joint_committee_members(org_id,contract_id,partner_id),
  FOREIGN KEY(milestone_id) REFERENCES joint_production_milestones(id),
  CHECK((kind='production_payment_credit' AND milestone_id IS NOT NULL) OR (kind='cash_contribution' AND milestone_id IS NULL))
);

CREATE TABLE joint_production_milestones (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, producer_partner_id INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('schedule_approved','shooting_complete','delivery_accepted')),
  due_on TEXT NOT NULL, condition_met_on TEXT, acceptance_on TEXT, amount_inc_tax_yen INTEGER NOT NULL CHECK(amount_inc_tax_yen>=0),
  paid_on TEXT, paid_inc_tax_yen INTEGER NOT NULL DEFAULT 0 CHECK(paid_inc_tax_yen>=0),
  UNIQUE(org_id,contract_id,stage), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id),
  FOREIGN KEY(org_id,producer_partner_id) REFERENCES partners(org_id,id),
  CHECK(paid_inc_tax_yen<=amount_inc_tax_yen),
  CHECK(paid_inc_tax_yen=0 OR (paid_on IS NOT NULL AND condition_met_on IS NOT NULL)),
  CHECK(stage<>'delivery_accepted' OR paid_inc_tax_yen=0 OR acceptance_on IS NOT NULL)
);

CREATE TABLE mapping_import_provenance (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, work_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other')), mapping_version_id INTEGER NOT NULL,
  original_text TEXT NOT NULL, original_hash TEXT NOT NULL, canonical_text TEXT NOT NULL, canonical_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,report_id), UNIQUE(org_id,work_id,partner_id,kind,original_hash),
  FOREIGN KEY(org_id,work_id,report_id) REFERENCES report_imports(org_id,work_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,mapping_version_id) REFERENCES report_mapping_versions(org_id,id)
);

CREATE TABLE memberships (
  org_id INTEGER NOT NULL REFERENCES organizations(id), user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('admin','editor','production')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  expires_at TEXT,
  PRIMARY KEY(org_id,user_id)
);

CREATE TABLE metric_definitions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), field_key TEXT NOT NULL,
  label TEXT NOT NULL, value_type TEXT NOT NULL CHECK(value_type IN ('integer','decimal','text','boolean')),
  unit TEXT, aggregation TEXT NOT NULL CHECK(aggregation IN ('sum','average','latest','none')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,field_key),
  CHECK(length(field_key) BETWEEN 1 AND 40 AND substr(field_key,1,1) GLOB '[a-z]' AND field_key NOT GLOB '*[^a-z0-9_]*')
);

CREATE TABLE mg_contract_links (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, incoming_contract_id INTEGER NOT NULL, outgoing_contract_id INTEGER NOT NULL,
  rationale TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,incoming_contract_id,outgoing_contract_id), FOREIGN KEY(org_id,incoming_contract_id) REFERENCES mg_incoming_contracts(org_id,id),
  FOREIGN KEY(org_id,outgoing_contract_id) REFERENCES mg_outgoing_contracts(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE mg_incoming_contracts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, partner_id INTEGER NOT NULL,
  contract_date TEXT NOT NULL, source_reference TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,code),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE mg_ledger_entries (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
  period_from TEXT NOT NULL, period_to TEXT NOT NULL CHECK(period_to>=period_from), report_received_on TEXT, accounting_month TEXT NOT NULL CHECK(accounting_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  source_reference TEXT NOT NULL, reported_eligible_yen INTEGER NOT NULL CHECK(reported_eligible_yen>=0), applied_recoup_yen INTEGER NOT NULL CHECK(applied_recoup_yen>=0),
  reported_overage_yen INTEGER NOT NULL CHECK(reported_overage_yen>=0), recognized_yen INTEGER NOT NULL CHECK(recognized_yen>=0), status TEXT NOT NULL CHECK(status IN ('unverified','reviewed')),
  acknowledgement INTEGER NOT NULL DEFAULT 0 CHECK(acknowledgement IN (0,1)), confirmation_reason TEXT,
  reverses_entry_id INTEGER, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,term_version_id,product_id,source_reference),
  UNIQUE(org_id,reverses_entry_id),
  FOREIGN KEY(org_id,term_version_id,product_id) REFERENCES mg_version_products(org_id,term_version_id,product_id),
  FOREIGN KEY(org_id,reverses_entry_id) REFERENCES mg_ledger_entries(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK(status='unverified' OR (acknowledgement=1 AND length(trim(confirmation_reason))>0)), CHECK(reverses_entry_id IS NULL OR reverses_entry_id<>id)
);

CREATE TABLE mg_outgoing_contracts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, supplier_id INTEGER NOT NULL,
  contract_date TEXT NOT NULL, source_reference TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,code),
  FOREIGN KEY(org_id,supplier_id) REFERENCES mg_suppliers(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE mg_suppliers (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL CHECK(code GLOB 'SUP-*'),
  name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,code), FOREIGN KEY(org_id) REFERENCES organizations(id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE mg_term_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, incoming_contract_id INTEGER, outgoing_contract_id INTEGER,
  version INTEGER NOT NULL CHECK(version>0), mode TEXT NOT NULL CHECK(mode IN ('single','cross','special')),
  mg_amount_yen INTEGER NOT NULL CHECK(mg_amount_yen>=0), starts_on TEXT NOT NULL, ends_on TEXT NOT NULL CHECK(ends_on>=starts_on),
  reason TEXT NOT NULL, source_reference TEXT NOT NULL, special_unverified INTEGER NOT NULL DEFAULT 0 CHECK(special_unverified IN (0,1)),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((incoming_contract_id IS NULL)!=(outgoing_contract_id IS NULL)), CHECK(mode='special' OR special_unverified=0),
  UNIQUE(org_id,id), UNIQUE(org_id,incoming_contract_id,version), UNIQUE(org_id,outgoing_contract_id,version),
  FOREIGN KEY(org_id,incoming_contract_id) REFERENCES mg_incoming_contracts(org_id,id),
  FOREIGN KEY(org_id,outgoing_contract_id) REFERENCES mg_outgoing_contracts(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE mg_version_phases (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, phase_order INTEGER NOT NULL,
  starts_on TEXT NOT NULL, ends_on TEXT NOT NULL CHECK(ends_on>=starts_on), interval_months INTEGER NOT NULL CHECK(interval_months IN (1,3,6,12)), close_day TEXT NOT NULL DEFAULT '31' CHECK(close_day='eom' OR (close_day NOT GLOB '*[^0-9]*' AND CAST(close_day AS INTEGER) BETWEEN 1 AND 31)),
  first_close_on TEXT NOT NULL, report_offset_months INTEGER NOT NULL CHECK(report_offset_months BETWEEN 0 AND 24), report_day INTEGER NOT NULL CHECK(report_day BETWEEN 1 AND 31),
  pay_offset_months INTEGER NOT NULL CHECK(pay_offset_months BETWEEN 0 AND 24), pay_day INTEGER NOT NULL CHECK(pay_day BETWEEN 1 AND 31),
  UNIQUE(org_id,term_version_id,phase_order), FOREIGN KEY(org_id,term_version_id) REFERENCES mg_term_versions(org_id,id)
);

CREATE TABLE mg_version_products (
  org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, product_id INTEGER NOT NULL, evaluation_yen INTEGER NOT NULL CHECK(evaluation_yen>=0),
  PRIMARY KEY(org_id,term_version_id,product_id), FOREIGN KEY(org_id,term_version_id) REFERENCES mg_term_versions(org_id,id),
  FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id)
);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, exposure_id INTEGER NOT NULL, metric_definition_id INTEGER NOT NULL,
  report_id INTEGER, source_row INTEGER,
  period_from TEXT NOT NULL, period_to TEXT NOT NULL, granularity TEXT NOT NULL CHECK(granularity IN ('day','week','month','event','unknown')),
  value_number REAL, value_text TEXT, verification TEXT NOT NULL DEFAULT 'unverified' CHECK(verification IN ('verified','unverified')),
  acquired_at TEXT NOT NULL, paid_organic TEXT CHECK(paid_organic IS NULL OR paid_organic IN ('paid','organic','mixed','unknown')),
  source TEXT, region TEXT, CHECK(period_to>=period_from), CHECK(NOT(value_number IS NOT NULL AND value_text IS NOT NULL)), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,exposure_id) REFERENCES exposures(org_id,id), FOREIGN KEY(org_id,metric_definition_id) REFERENCES metric_definitions(org_id,id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id)
);

CREATE TABLE organizations (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL
);

CREATE TABLE package_observation_products (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, source_row INTEGER NOT NULL,
  metric TEXT NOT NULL, product_id INTEGER NOT NULL,
  PRIMARY KEY(org_id,report_id,source_row,metric),
  FOREIGN KEY(org_id,report_id,source_row,metric) REFERENCES package_report_observations(org_id,report_id,source_row,metric),
  FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id)
);

CREATE TABLE package_report_observations (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, source_row INTEGER NOT NULL CHECK(source_row>=1),
  metric TEXT NOT NULL CHECK(metric IN ('delivered','active','inventory','returned')),
  count INTEGER NOT NULL CHECK(count>=0),
  unit TEXT NOT NULL CHECK(length(trim(unit))>0),
  scope TEXT NOT NULL CHECK(length(trim(scope))>0),
  basis TEXT NOT NULL CHECK(length(trim(basis))>0),
  observed_on TEXT,
  PRIMARY KEY(org_id,report_id,source_row,metric),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  CHECK(metric<>'inventory' OR observed_on IS NOT NULL)
);

CREATE TABLE package_sale_details (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('rental','sell_through','license')),
  turns_count INTEGER CHECK(turns_count IS NULL OR turns_count>=0),
  average_rental_price_ex_tax TEXT, holder_unit_price_ex_tax TEXT,
  reported_actual_ex_tax TEXT, reported_recognized_ex_tax TEXT, calculated_actual_ex_tax TEXT,
  PRIMARY KEY(org_id,sale_id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  CHECK(model='rental' OR (turns_count IS NULL AND average_rental_price_ex_tax IS NULL))
);

CREATE TABLE partners (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), code TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK(kind IN ('cinema','platform','retailer','agency','vendor','other')), region TEXT,
  version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id), UNIQUE(org_id,code)
);

CREATE TABLE prep_tasks (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  shooting_day_id INTEGER, scene_id INTEGER, title TEXT NOT NULL, owner_label TEXT, due_on TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','blocked')), note TEXT,
  version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), CHECK(length(trim(title)) BETWEEN 1 AND 200),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE product_works (
  org_id INTEGER NOT NULL, product_id INTEGER NOT NULL, work_id INTEGER NOT NULL, allocation_bps INTEGER NOT NULL CHECK(allocation_bps BETWEEN 1 AND 10000),
  PRIMARY KEY(org_id,product_id,work_id), FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);

CREATE TABLE production_appearances (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, scene_id INTEGER NOT NULL, character_key TEXT NOT NULL,
  PRIMARY KEY(org_id,work_id,scene_id,character_key),
  FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,character_key) REFERENCES production_characters(org_id,work_id,key)
);

CREATE TABLE production_calls (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, day_id INTEGER NOT NULL, character_key TEXT NOT NULL,
  call_time TEXT, ready_time TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,day_id,character_key),
  FOREIGN KEY(org_id,work_id,day_id) REFERENCES shooting_days(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,character_key) REFERENCES production_characters(org_id,work_id,key)
);

CREATE TABLE production_characters (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  short_name TEXT, actor_name TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,key), UNIQUE(org_id,work_id,name),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);

CREATE TABLE production_day_slots (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, day_id INTEGER NOT NULL, key TEXT NOT NULL,
  after_scene_order INTEGER NOT NULL CHECK(after_scene_order>=0), kind TEXT NOT NULL CHECK(kind IN ('move','meal','wrap','prep','other')),
  label TEXT NOT NULL, planned_start TEXT, planned_end TEXT, actual_start TEXT, actual_end TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,day_id,key),
  CHECK(planned_end IS NULL OR planned_start IS NULL OR planned_end>planned_start),
  CHECK(actual_end IS NULL OR actual_start IS NULL OR actual_end>actual_start),
  FOREIGN KEY(org_id,work_id,day_id) REFERENCES shooting_days(org_id,work_id,id)
);

CREATE TABLE production_location_plans (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, location_key TEXT NOT NULL,
  strokes_json TEXT NOT NULL CHECK(json_valid(strokes_json) AND json_type(strokes_json)='array' AND length(strokes_json)<=262144),
  PRIMARY KEY(org_id,work_id,location_key),
  FOREIGN KEY(org_id,work_id,location_key) REFERENCES production_locations(org_id,work_id,key) ON DELETE CASCADE
);

CREATE TABLE production_locations (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  address TEXT, floor TEXT, green_room TEXT, parking TEXT, facilities TEXT, contact TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,key), UNIQUE(org_id,work_id,name),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);

CREATE TABLE production_looks (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, key TEXT NOT NULL, character_key TEXT NOT NULL,
  label TEXT NOT NULL, makeup TEXT, props TEXT, shoes TEXT, accessories TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,key), UNIQUE(org_id,work_id,character_key,label),
  FOREIGN KEY(org_id,work_id,character_key) REFERENCES production_characters(org_id,work_id,key)
);

CREATE TABLE production_revisions (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  PRIMARY KEY(org_id,work_id), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);

CREATE TABLE production_scene_details (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, scene_id INTEGER NOT NULL,
  page_eighths INTEGER CHECK(page_eighths IS NULL OR page_eighths>=0),
  estimated_minutes INTEGER CHECK(estimated_minutes IS NULL OR estimated_minutes>0),
  location_key TEXT, note TEXT,
  PRIMARY KEY(org_id,work_id,scene_id),
  FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,location_key) REFERENCES production_locations(org_id,work_id,key)
);

CREATE TABLE production_scene_looks (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, scene_id INTEGER NOT NULL, look_key TEXT NOT NULL,
  PRIMARY KEY(org_id,work_id,scene_id,look_key),
  FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,look_key) REFERENCES production_looks(org_id,work_id,key)
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), sku TEXT NOT NULL, name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('theatrical','digital','package','broadcast','license','other')), version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id), UNIQUE(org_id,sku)
);

CREATE TABLE project_memberships (
  org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('edit','production')),
  expires_at TEXT,
  PRIMARY KEY(org_id,project_id,user_id),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), code TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','complete','paused')),
  budget_yen INTEGER CHECK(budget_yen IS NULL OR budget_yen>=0), version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id), UNIQUE(org_id,code)
);

CREATE TABLE receipt_plan_decisions (
 org_id INTEGER NOT NULL, request_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
 version_no INTEGER, effective_on TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,request_id), UNIQUE(org_id,invoice_id,version_no),
 CHECK((decision='approved' AND version_no>0) OR (decision='rejected' AND version_no IS NULL)),
 FOREIGN KEY(org_id,invoice_id,request_id) REFERENCES receipt_plan_requests(org_id,invoice_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE receipt_plan_requests (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, base_version INTEGER NOT NULL CHECK(base_version>=0),
 previous_due_date TEXT NOT NULL, proposed_due_date TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id), UNIQUE(org_id,invoice_id,id),
 FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE recognition_bases (
  id INTEGER PRIMARY KEY CHECK(id IN (1,2,3,4,5)), code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, source_field TEXT NOT NULL UNIQUE,
  CHECK((id=1 AND code='sales_month' AND source_field='sales_month') OR
        (id=2 AND code='report_received_month' AND source_field='report_received_on') OR
        (id=3 AND code='contract_start_month' AND source_field='contract_start_on') OR
        (id=4 AND code='license_start_month' AND source_field='license_start_on') OR
        (id=5 AND code='broadcast_month' AND source_field='broadcast_on'))
);

CREATE TABLE report_channel_fact_seals (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
  sealed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,report_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id)
);

CREATE TABLE report_imports (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), work_id INTEGER NOT NULL, partner_id INTEGER,
  report_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other','publicity')), period_from TEXT NOT NULL, period_to TEXT NOT NULL,
  accounting_month TEXT NOT NULL CHECK(accounting_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), raw_text TEXT NOT NULL,
  content_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','void')),
  supersedes_id INTEGER REFERENCES report_imports(id), created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,report_key,content_hash), UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,supersedes_id) REFERENCES report_imports(org_id,id),
  CHECK(period_to>=period_from), CHECK(supersedes_id IS NULL OR supersedes_id<>id)
);

CREATE TABLE report_mapping_profiles (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other')), name TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,partner_id,kind,name),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE report_mapping_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, profile_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK(version_no>0), definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,profile_id,id), UNIQUE(org_id,profile_id,version_no),
  FOREIGN KEY(org_id,profile_id) REFERENCES report_mapping_profiles(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE report_recognition (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, recognition_basis_id INTEGER NOT NULL REFERENCES recognition_bases(id),
  sales_month TEXT, report_received_on TEXT, contract_start_on TEXT, license_start_on TEXT, broadcast_on TEXT,
  basis_reason TEXT NOT NULL CHECK(length(trim(basis_reason)) BETWEEN 1 AND 1000),
  accounting_status TEXT NOT NULL DEFAULT 'unverified' CHECK(accounting_status='unverified'),
  resolved_month TEXT NOT NULL CHECK(resolved_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(org_id,report_id),
  CHECK(sales_month IS NULL OR sales_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  CHECK(report_received_on IS NULL OR report_received_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK(contract_start_on IS NULL OR contract_start_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK(license_start_on IS NULL OR license_start_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK(broadcast_on IS NULL OR broadcast_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK((recognition_basis_id=1 AND sales_month IS NOT NULL AND resolved_month=sales_month) OR
        (recognition_basis_id=2 AND report_received_on IS NOT NULL AND resolved_month=substr(report_received_on,1,7)) OR
        (recognition_basis_id=3 AND contract_start_on IS NOT NULL AND resolved_month=substr(contract_start_on,1,7)) OR
        (recognition_basis_id=4 AND license_start_on IS NOT NULL AND resolved_month=substr(license_start_on,1,7)) OR
        (recognition_basis_id=5 AND broadcast_on IS NOT NULL AND resolved_month=substr(broadcast_on,1,7))),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id)
);

CREATE TABLE report_sale_dimensions_versions (
 org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
 department_name TEXT CHECK(department_name IS NULL OR length(trim(department_name)) BETWEEN 1 AND 100),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000), created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,sale_id,version_no),
 FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE report_source_controls (
  org_id INTEGER NOT NULL,
  report_id INTEGER NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('report','channel')),
  channel TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL CHECK(metric IN ('row_count','amount_ex_tax','tax_amount','amount_inc_tax')),
  expected_value INTEGER NOT NULL CHECK(expected_value BETWEEN -9007199254740991 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,report_id,scope_kind,channel,metric),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  CHECK((scope_kind='report' AND channel='') OR
        (scope_kind='channel' AND channel IN ('theatrical','digital','package','broadcast','other'))),
  CHECK(metric<>'row_count' OR expected_value>=0)
);

CREATE TABLE rights_intake_cases (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  case_code TEXT NOT NULL, title TEXT NOT NULL, intake_type TEXT NOT NULL CHECK(intake_type IN ('committee','sole_owned','entrusted')),
  source_case_id INTEGER, snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK(snapshot_version>0), status TEXT NOT NULL DEFAULT 'draft' CHECK(status='draft'),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,id,work_id), UNIQUE(org_id,case_code),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,source_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE rights_intake_documents (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, intake_case_id INTEGER NOT NULL,
  title TEXT, reference TEXT, version_label TEXT, content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id),
  FOREIGN KEY(org_id,intake_case_id) REFERENCES rights_intake_cases(org_id,id)
);

CREATE TABLE rights_intake_participants (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, intake_case_id INTEGER NOT NULL,
  party_kind TEXT NOT NULL CHECK(party_kind IN ('current_org','partner')), partner_id INTEGER, role TEXT,
  investment_yen INTEGER CHECK(investment_yen IS NULL OR investment_yen>=0),
  explicit_share_bps INTEGER CHECK(explicit_share_bps IS NULL OR explicit_share_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id),
  CHECK((party_kind='current_org' AND partner_id IS NULL) OR party_kind='partner'),
  FOREIGN KEY(org_id,intake_case_id) REFERENCES rights_intake_cases(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE rights_intake_scopes (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, intake_case_id INTEGER NOT NULL,
  channel TEXT, territory TEXT, rights_start TEXT, rights_end TEXT,
  exclusivity TEXT CHECK(exclusivity IS NULL OR exclusivity IN ('exclusive','nonexclusive','unknown')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id),
  CHECK(rights_end IS NULL OR rights_start IS NULL OR rights_end>=rights_start),
  FOREIGN KEY(org_id,intake_case_id) REFERENCES rights_intake_cases(org_id,id)
);

CREATE TABLE rights_payment_events (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL,
 settlement_contract_id INTEGER, committee_snapshot_id INTEGER,
 partner_id INTEGER NOT NULL, amount_yen INTEGER NOT NULL CHECK(amount_yen>0),
 paid_on TEXT NOT NULL, reference TEXT NOT NULL CHECK(length(trim(reference)) BETWEEN 1 AND 160),
 reverses_event_id INTEGER, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((settlement_contract_id IS NOT NULL)+(committee_snapshot_id IS NOT NULL)=1),
 CHECK(paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 UNIQUE(org_id,id), UNIQUE(org_id,reference), UNIQUE(org_id,reverses_event_id),
 FOREIGN KEY(org_id,settlement_contract_id) REFERENCES settlement_contracts(org_id,id),
 FOREIGN KEY(org_id,committee_snapshot_id) REFERENCES committee_report_snapshots(org_id,id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,reverses_event_id) REFERENCES rights_payment_events(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE sale_distribution_versions (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
 distribution_code TEXT NOT NULL REFERENCES distribution_types(code), territory TEXT, service_name TEXT,
 settlement_method TEXT NOT NULL CHECK(settlement_method IN ('unverified','royalty','MG','FLAT','other')), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,sale_id,version_no), UNIQUE(org_id,id),
 FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE sale_lines (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  report_id INTEGER, product_id INTEGER, partner_id INTEGER NOT NULL, sales_period_from TEXT NOT NULL, sales_period_to TEXT NOT NULL,
  accounting_month TEXT NOT NULL CHECK(accounting_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), description TEXT NOT NULL,
  quantity INTEGER CHECK(quantity IS NULL OR quantity>=0), amount_ex_tax INTEGER NOT NULL, tax_amount INTEGER NOT NULL, amount_inc_tax INTEGER NOT NULL,
  source_row INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id),
  CHECK(amount_inc_tax=amount_ex_tax+tax_amount), CHECK(sales_period_to>=sales_period_from),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id), FOREIGN KEY(org_id,work_id,report_id) REFERENCES report_imports(org_id,work_id,id),
  FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE sales_activities (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  opportunity_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, occurred_on TEXT NOT NULL,
  activity_type TEXT NOT NULL CHECK(activity_type IN ('contact','proposal','negotiation','note')),
  summary TEXT NOT NULL, next_action TEXT, next_due_on TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id,partner_id,opportunity_id) REFERENCES sales_opportunities(org_id,project_id,work_id,partner_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE sales_agreement_term_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, agreement_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  source_version_id INTEGER, document_reference TEXT, version_label TEXT,
  channel TEXT NOT NULL CHECK(channel IN ('digital','broadcast','theatrical','package','other')), territory TEXT,
  license_start TEXT, license_end TEXT, expected_amount_yen INTEGER CHECK(expected_amount_yen IS NULL OR expected_amount_yen>=0), note TEXT,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,agreement_id,id), UNIQUE(org_id,agreement_id,version_no),
  CHECK(license_end IS NULL OR license_start IS NULL OR license_end>=license_start),
  FOREIGN KEY(org_id,agreement_id) REFERENCES sales_agreements(org_id,id),
  FOREIGN KEY(org_id,agreement_id,source_version_id) REFERENCES sales_agreement_term_versions(org_id,agreement_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE sales_agreements (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  opportunity_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, product_id INTEGER, intake_case_id INTEGER,
  contract_code TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,contract_code),
  FOREIGN KEY(org_id,project_id,work_id,partner_id,opportunity_id) REFERENCES sales_opportunities(org_id,project_id,work_id,partner_id,id),
  FOREIGN KEY(org_id,product_id,work_id) REFERENCES product_works(org_id,product_id,work_id),
  FOREIGN KEY(org_id,intake_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE sales_availability_versions (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, distribution_code TEXT NOT NULL REFERENCES distribution_types(code),
 territory TEXT NOT NULL CHECK(length(trim(territory))>0), version_no INTEGER NOT NULL CHECK(version_no>0),
 release_on TEXT, sales_end_on TEXT, terms_text TEXT NOT NULL, source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0),
 intake_case_id INTEGER, document_id INTEGER, exclusivity TEXT NOT NULL CHECK(exclusivity IN ('unknown','exclusive','nonexclusive')),
 status TEXT NOT NULL CHECK(status IN ('draft','confirmed','withdrawn')), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,distribution_code,territory,version_no),
 CHECK(sales_end_on IS NULL OR release_on IS NULL OR sales_end_on>=release_on),
 CHECK(status<>'confirmed' OR (release_on IS NOT NULL AND sales_end_on IS NOT NULL AND length(trim(terms_text))>0)),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id), FOREIGN KEY(org_id,intake_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
 FOREIGN KEY(org_id,document_id) REFERENCES rights_intake_documents(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE sales_deliverables (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  agreement_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, title TEXT NOT NULL, due_on TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','accepted','blocked')),
  submitted_on TEXT, accepted_on TEXT, note TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), CHECK(length(trim(title)) BETWEEN 1 AND 200),
  CHECK((status NOT IN ('submitted','accepted')) OR submitted_on IS NOT NULL),
  CHECK(status<>'accepted' OR accepted_on IS NOT NULL),
  CHECK(accepted_on IS NULL OR submitted_on IS NOT NULL), CHECK(accepted_on IS NULL OR accepted_on>=submitted_on),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,agreement_id,work_id) REFERENCES sales_agreements(org_id,id,work_id),
  FOREIGN KEY(org_id,agreement_id,term_version_id) REFERENCES sales_agreement_term_versions(org_id,agreement_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE sales_material_snapshots (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  opportunity_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, product_id INTEGER,
  version_no INTEGER NOT NULL CHECK(version_no>0), title TEXT NOT NULL, synopsis TEXT NOT NULL, pitch TEXT NOT NULL, terms_text TEXT NOT NULL,
  source_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,opportunity_id,version_no), UNIQUE(org_id,snapshot_hash),
  CHECK(length(trim(title)) BETWEEN 1 AND 200), CHECK(length(trim(synopsis)) BETWEEN 1 AND 5000),
  CHECK(length(trim(pitch)) BETWEEN 1 AND 5000), CHECK(length(trim(terms_text)) BETWEEN 1 AND 5000),
  FOREIGN KEY(org_id,project_id,work_id,partner_id,opportunity_id) REFERENCES sales_opportunities(org_id,project_id,work_id,partner_id,id),
  FOREIGN KEY(org_id,product_id,work_id) REFERENCES product_works(org_id,product_id,work_id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE sales_opportunities (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  name TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('lead','proposal','negotiation','won','lost')), expected_yen INTEGER CHECK(expected_yen IS NULL OR expected_yen>=0),
  close_date TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE sales_report_links (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
  agreement_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,work_id,report_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  FOREIGN KEY(org_id,agreement_id,work_id) REFERENCES sales_agreements(org_id,id,work_id),
  FOREIGN KEY(org_id,agreement_id,term_version_id) REFERENCES sales_agreement_term_versions(org_id,agreement_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE scenes (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  scene_no TEXT NOT NULL, day_night TEXT CHECK(day_night IS NULL OR day_night IN ('D','N','DN')), location TEXT,
  synopsis TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','shot')),
  version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id), UNIQUE(org_id,project_id,work_id,scene_no),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id), FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);

CREATE TABLE schema_meta (
  org_id INTEGER PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), org_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE settlement_contracts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  contract_code TEXT NOT NULL, title TEXT NOT NULL, contract_type TEXT NOT NULL CHECK(contract_type IN ('commission','mg','self_owned')),
  holder_partner_id INTEGER, mg_contract_yen INTEGER, mg_paid_yen INTEGER,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (contract_type='commission' AND holder_partner_id IS NOT NULL AND mg_contract_yen IS NULL AND mg_paid_yen IS NULL) OR
    (contract_type='mg' AND holder_partner_id IS NOT NULL AND mg_contract_yen IS NOT NULL AND mg_contract_yen>=0 AND (mg_paid_yen IS NULL OR (mg_paid_yen>=0 AND mg_paid_yen<=mg_contract_yen))) OR
    (contract_type='self_owned' AND holder_partner_id IS NULL AND mg_contract_yen IS NULL AND mg_paid_yen IS NULL)
  ),
  UNIQUE(org_id,id), UNIQUE(org_id,id,work_id), UNIQUE(org_id,contract_code),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,holder_partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE settlement_report_links (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, work_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL,
  report_basis TEXT NOT NULL CHECK(report_basis IN ('gross','net')), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,report_id,work_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
  FOREIGN KEY(org_id,contract_id,work_id) REFERENCES settlement_contracts(org_id,id,work_id),
  FOREIGN KEY(org_id,contract_id,term_version_id) REFERENCES settlement_term_versions(org_id,contract_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE settlement_term_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  platform_rate_bps INTEGER NOT NULL CHECK(platform_rate_bps BETWEEN 0 AND 10000),
  agency_fee_bps INTEGER CHECK(agency_fee_bps IS NULL OR agency_fee_bps BETWEEN 0 AND 10000),
  recoup_basis TEXT CHECK(recoup_basis IS NULL OR recoup_basis IN ('platform_net','after_fee')),
  overage_enabled INTEGER CHECK(overage_enabled IS NULL OR overage_enabled IN (0,1)),
  overage_rate_bps INTEGER CHECK(overage_rate_bps IS NULL OR overage_rate_bps BETWEEN 0 AND 10000),
  note TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((overage_enabled IS NULL AND overage_rate_bps IS NULL) OR (overage_enabled=0 AND overage_rate_bps IS NULL) OR (overage_enabled=1 AND overage_rate_bps IS NOT NULL)),
  UNIQUE(org_id,id), UNIQUE(org_id,contract_id,id), UNIQUE(org_id,contract_id,version_no),
  FOREIGN KEY(org_id,contract_id) REFERENCES settlement_contracts(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE shooting_days (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  shoot_date TEXT NOT NULL, unit TEXT NOT NULL, label TEXT NOT NULL, notes TEXT,
  version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,work_id,shoot_date,unit),
  CHECK(length(trim(unit)) BETWEEN 1 AND 80), CHECK(length(trim(label)) BETWEEN 1 AND 160),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE tax_calculation_lines (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
  voucher_id TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('standard','reduced','zero','exempt','non_taxable')),
  rate_bps INTEGER NOT NULL CHECK(rate_bps IN (0,800,1000)), amount_ex_tax INTEGER NOT NULL,
  source_tax INTEGER NOT NULL, amount_inc_tax INTEGER NOT NULL, exact_numerator TEXT NOT NULL, exact_denominator TEXT NOT NULL,
  reference_tax_scaled INTEGER NOT NULL, reference_precision INTEGER NOT NULL CHECK(reference_precision BETWEEN 0 AND 4),
  PRIMARY KEY(org_id,snapshot_id,sale_id),
  CHECK((category='standard' AND rate_bps=1000) OR (category='reduced' AND rate_bps=800) OR (category IN ('zero','exempt','non_taxable') AND rate_bps=0)),
  FOREIGN KEY(org_id,snapshot_id) REFERENCES tax_calculation_snapshots(org_id,id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id), FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id)
);

CREATE TABLE tax_calculation_snapshots (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, invoice_id INTEGER, preview_hash TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL, invoice_date TEXT NOT NULL, source_period_from TEXT NOT NULL, source_period_to TEXT NOT NULL,
  calculation_json TEXT NOT NULL, amount_ex_tax INTEGER NOT NULL, source_tax INTEGER NOT NULL,
  billed_tax INTEGER NOT NULL, delta INTEGER NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,invoice_id),
  CHECK(delta=billed_tax-source_tax), CHECK(source_period_to>=source_period_from),
  FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id),
  FOREIGN KEY(org_id,rule_version_id) REFERENCES tax_rule_versions(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE tax_invoice_links (
  org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, prior_invoice_id INTEGER NOT NULL, reason TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,invoice_id), CHECK(invoice_id<>prior_invoice_id), CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id),
  FOREIGN KEY(org_id,prior_invoice_id) REFERENCES billing_invoices(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE tax_invoice_rate_totals (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('standard','reduced','zero','exempt','non_taxable')),
  rate_bps INTEGER NOT NULL CHECK(rate_bps IN (0,800,1000)), amount_ex_tax INTEGER NOT NULL,
  exact_numerator TEXT NOT NULL, exact_denominator TEXT NOT NULL, billed_tax INTEGER NOT NULL, source_tax INTEGER NOT NULL, delta INTEGER NOT NULL,
  PRIMARY KEY(org_id,snapshot_id,category,rate_bps), CHECK(delta=billed_tax-source_tax),
  FOREIGN KEY(org_id,snapshot_id) REFERENCES tax_calculation_snapshots(org_id,id)
);

CREATE TABLE tax_rule_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN ('default','partner')),
  partner_id INTEGER, version INTEGER NOT NULL CHECK(version>0), base_version INTEGER NOT NULL CHECK(base_version>=0),
  effective_from TEXT NOT NULL, effective_to TEXT,
  basis TEXT NOT NULL CHECK(basis IN ('exclusive','inclusive')),
  grouping_mode TEXT NOT NULL CHECK(grouping_mode IN ('invoice','voucher')),
  rounding_mode TEXT NOT NULL CHECK(rounding_mode IN ('truncate','half_up','ceil')),
  precision INTEGER NOT NULL CHECK(precision BETWEEN 0 AND 4), reason TEXT NOT NULL, evidence TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,scope_type,partner_id,version),
  CHECK((scope_type='default' AND partner_id IS NULL) OR (scope_type='partner' AND partner_id IS NOT NULL)),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(length(trim(reason)) BETWEEN 1 AND 1000), CHECK(length(trim(evidence)) BETWEEN 1 AND 4000),
  FOREIGN KEY(org_id) REFERENCES organizations(id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE theatrical_sale_details (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('theatrical_rs','theatrical_flat','non_theatrical_rs','non_theatrical_flat')),
  ticket_type_code TEXT, purchase_channel TEXT,
  admissions_count INTEGER CHECK(admissions_count IS NULL OR admissions_count>=0),
  gross_box_office_ex_tax TEXT,
  reported_actual_ex_tax TEXT, reported_recognized_ex_tax TEXT, calculated_actual_ex_tax TEXT,
  PRIMARY KEY(org_id,sale_id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id)
);

CREATE TABLE transaction_guards (value INTEGER NOT NULL CHECK(value=1));

CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE CHECK(email=lower(email)), display_name TEXT NOT NULL
);

CREATE TABLE workbench_analysis_snapshots(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,dataset TEXT NOT NULL,change_set_id TEXT,source_boundary_json TEXT NOT NULL,content_hash TEXT NOT NULL,row_count INTEGER NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE workbench_applications(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,change_set_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,result_json TEXT NOT NULL,applied_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(org_id,idempotency_key),UNIQUE(org_id,change_set_id),FOREIGN KEY(change_set_id) REFERENCES workbench_change_sets(id));

CREATE TABLE workbench_change_sets(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,draft_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,draft_revision INTEGER NOT NULL,validation_id TEXT NOT NULL,content_hash TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,submitted_by INTEGER NOT NULL,approved_by INTEGER,approved_at TEXT,applied_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(draft_id) REFERENCES workbench_drafts(id),FOREIGN KEY(validation_id) REFERENCES workbench_validations(id));

CREATE TABLE workbench_drafts(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,user_id INTEGER NOT NULL,dataset TEXT NOT NULL,project_id INTEGER,work_id INTEGER,revision INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'draft',source_snapshot_id TEXT,source_artifact_id TEXT,rows_json TEXT NOT NULL,steps_json TEXT NOT NULL DEFAULT '[]',lookup_refs_json TEXT NOT NULL DEFAULT '[]',recipe_version_id TEXT,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(source_snapshot_id) REFERENCES workbench_snapshots(id),FOREIGN KEY(source_artifact_id) REFERENCES workbench_source_artifacts(id));

CREATE TABLE workbench_lineage(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,run_type TEXT NOT NULL,source_id TEXT,engine_version TEXT NOT NULL,input_hash TEXT NOT NULL,result_hash TEXT NOT NULL,detail_json TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE workbench_recipe_versions(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,recipe_id TEXT NOT NULL,version_no INTEGER NOT NULL,steps_json TEXT NOT NULL,lookup_refs_json TEXT NOT NULL DEFAULT '[]',steps_hash TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(org_id,recipe_id,version_no),FOREIGN KEY(recipe_id) REFERENCES workbench_recipes(id));

CREATE TABLE workbench_recipes(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,dataset TEXT NOT NULL,name TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE workbench_snapshots(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,dataset TEXT NOT NULL,scope_json TEXT NOT NULL,rows_json TEXT NOT NULL,content_hash TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE workbench_source_artifacts(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,name TEXT NOT NULL,media_type TEXT NOT NULL,raw_base64 TEXT NOT NULL,source_hash TEXT NOT NULL,byte_length INTEGER NOT NULL,extraction_json TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(org_id,source_hash));

CREATE TABLE workbench_validations(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,draft_id TEXT NOT NULL,draft_revision INTEGER NOT NULL,input_hash TEXT NOT NULL,result_hash TEXT NOT NULL,result_json TEXT NOT NULL,status TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(draft_id) REFERENCES workbench_drafts(id));

CREATE TABLE workflow_raw_artifacts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('script','sales_report')), file_name TEXT NOT NULL,
  media_type TEXT, byte_length INTEGER NOT NULL CHECK(byte_length>0), raw_sha256 TEXT NOT NULL,
  original_base64 TEXT NOT NULL, extractor_name TEXT NOT NULL, extractor_version TEXT NOT NULL,
  extraction_json TEXT NOT NULL, extraction_status TEXT NOT NULL CHECK(extraction_status IN ('extracted','ocr_pending')),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,kind,raw_sha256),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE workflow_report_commits (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, selection_id INTEGER NOT NULL,
  mapping_version_id INTEGER NOT NULL, report_id INTEGER NOT NULL, preview_token TEXT NOT NULL, committed_by INTEGER NOT NULL,
  committed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,artifact_id), UNIQUE(org_id,report_id), UNIQUE(preview_token),
  FOREIGN KEY(org_id,work_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,selection_id) REFERENCES workflow_report_selections(org_id,work_id,id),
  FOREIGN KEY(org_id,mapping_version_id) REFERENCES report_mapping_versions(org_id,id),
  FOREIGN KEY(org_id,work_id,report_id) REFERENCES report_imports(org_id,work_id,id)
);

CREATE TABLE workflow_report_selections (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL, sheet_name TEXT NOT NULL, header_row INTEGER NOT NULL CHECK(header_row>0),
  canonical_csv TEXT NOT NULL, canonical_sha256 TEXT NOT NULL, source_rows_json TEXT NOT NULL DEFAULT '[]', suggestions_json TEXT NOT NULL,
  suggestion_source TEXT NOT NULL CHECK(suggestion_source IN ('rule-based','imported-ai','configured-ai')),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,artifact_id,version_no),
  FOREIGN KEY(org_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,id)
);

CREATE TABLE workflow_schedule_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, review_id INTEGER NOT NULL,
  work_id INTEGER NOT NULL, user_id INTEGER NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
  proposal_json TEXT NOT NULL, proposal_hash TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,id),
  FOREIGN KEY(org_id,review_id) REFERENCES workflow_script_reviews(org_id,id)
);

CREATE TABLE workflow_script_commit_days (
  org_id INTEGER NOT NULL, commit_id INTEGER NOT NULL, work_id INTEGER NOT NULL, shooting_day_id INTEGER NOT NULL, proposal_index INTEGER NOT NULL,
  PRIMARY KEY(org_id,commit_id,shooting_day_id), UNIQUE(org_id,commit_id,proposal_index),
  FOREIGN KEY(org_id,commit_id) REFERENCES workflow_script_commits(org_id,id), FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id)
);

CREATE TABLE workflow_script_commit_scenes (
  org_id INTEGER NOT NULL, commit_id INTEGER NOT NULL, work_id INTEGER NOT NULL, scene_id INTEGER NOT NULL, source_index INTEGER NOT NULL,
  PRIMARY KEY(org_id,commit_id,scene_id), UNIQUE(org_id,commit_id,source_index),
  FOREIGN KEY(org_id,commit_id) REFERENCES workflow_script_commits(org_id,id), FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id)
);

CREATE TABLE workflow_script_commits (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, review_id INTEGER NOT NULL,
  work_id INTEGER NOT NULL, preview_token TEXT NOT NULL, proposal_hash TEXT NOT NULL,
  committed_by INTEGER NOT NULL, committed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,artifact_id), UNIQUE(preview_token),
  FOREIGN KEY(org_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,id),
  FOREIGN KEY(org_id,review_id) REFERENCES workflow_script_reviews(org_id,id)
);

CREATE TABLE workflow_script_reviews (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, artifact_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL, scenes_json TEXT NOT NULL, review_hash TEXT NOT NULL,
  reviewed_by INTEGER NOT NULL, reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,artifact_id,version_no), UNIQUE(org_id,artifact_id,review_hash),
  FOREIGN KEY(org_id,work_id,artifact_id) REFERENCES workflow_raw_artifacts(org_id,work_id,id),
  FOREIGN KEY(org_id,reviewed_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE works (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'film', forecast_yen INTEGER CHECK(forecast_yen IS NULL OR forecast_yen>=0), version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id), UNIQUE(org_id,project_id,id), UNIQUE(org_id,code),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
);

CREATE INDEX billing_claim_invoice_idx ON billing_sale_claims(org_id,invoice_id);

CREATE INDEX billing_invoice_partner_due_idx ON billing_invoices(org_id,partner_id,due_date);

CREATE INDEX billing_line_work_idx ON billing_invoice_line_works(org_id,work_id,invoice_id);

CREATE INDEX billing_receipt_invoice_idx ON billing_receipt_allocations(org_id,invoice_id,receipt_id);

CREATE INDEX broadcast_slot_month ON broadcast_slot_versions(org_id,work_id,broadcast_month,station_name);

CREATE UNIQUE INDEX observation_report_row_uidx ON observations(org_id,report_id,source_row) WHERE report_id IS NOT NULL;

CREATE UNIQUE INDEX opportunities_org_scope_id_uidx ON sales_opportunities(org_id,project_id,work_id,partner_id,id);

CREATE UNIQUE INDEX report_active_key_uidx ON report_imports(org_id,work_id,report_key) WHERE status='active';

CREATE UNIQUE INDEX rights_intake_documents_case_uidx ON rights_intake_documents(org_id,intake_case_id,id);

CREATE UNIQUE INDEX sale_report_row_uidx ON sale_lines(org_id,report_id,source_row) WHERE report_id IS NOT NULL;

CREATE INDEX sales_material_work_idx ON sales_material_snapshots(org_id,work_id,created_at);

CREATE UNIQUE INDEX scenes_org_work_id_uidx ON scenes(org_id,work_id,id);

CREATE UNIQUE INDEX tax_rule_scope_start_uq ON tax_rule_versions(org_id,scope_type,IFNULL(partner_id,0),effective_from);

CREATE UNIQUE INDEX tax_rule_scope_version_uq ON tax_rule_versions(org_id,scope_type,IFNULL(partner_id,0),version);

CREATE INDEX tax_rules_resolve_idx ON tax_rule_versions(org_id,scope_type,partner_id,effective_from,effective_to,version);

CREATE INDEX tax_snapshot_month_idx ON tax_calculation_snapshots(org_id,invoice_date,invoice_id);

CREATE TRIGGER availability_document_scope BEFORE INSERT ON sales_availability_versions WHEN NEW.document_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rights_intake_documents d WHERE d.org_id=NEW.org_id AND d.id=NEW.document_id AND d.intake_case_id=NEW.intake_case_id) THEN RAISE(ABORT,'document case mismatch') END;
END;

CREATE TRIGGER availability_no_delete BEFORE DELETE ON sales_availability_versions BEGIN SELECT RAISE(ABORT,'availability version immutable'); END;

CREATE TRIGGER availability_no_update BEFORE UPDATE ON sales_availability_versions BEGIN SELECT RAISE(ABORT,'availability version immutable'); END;

CREATE TRIGGER billed_report_locked_delete BEFORE DELETE ON report_imports WHEN EXISTS(SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id=s.org_id AND c.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id) BEGIN SELECT RAISE(ABORT,'report with billed sales is locked'); END;

CREATE TRIGGER billed_report_locked_update BEFORE UPDATE ON report_imports WHEN EXISTS(SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id=s.org_id AND c.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id) BEGIN SELECT RAISE(ABORT,'report with billed sales is locked'); END;

CREATE TRIGGER billed_report_no_gross_committee BEFORE INSERT ON committee_snapshot_reports
WHEN NEW.report_basis='gross' AND EXISTS(SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id=s.org_id AND c.sale_id=s.id WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'billed report cannot become gross basis'); END;

CREATE TRIGGER billed_report_no_gross_settlement BEFORE INSERT ON settlement_report_links
WHEN NEW.report_basis='gross' AND EXISTS(SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id=s.org_id AND c.sale_id=s.id WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'billed report cannot become gross basis'); END;

CREATE TRIGGER billed_sale_locked_delete BEFORE DELETE ON sale_lines WHEN EXISTS(SELECT 1 FROM billing_sale_claims c WHERE c.org_id=OLD.org_id AND c.sale_id=OLD.id) BEGIN SELECT RAISE(ABORT,'billed sale line is locked'); END;

CREATE TRIGGER billed_sale_locked_update BEFORE UPDATE ON sale_lines WHEN EXISTS(SELECT 1 FROM billing_sale_claims c WHERE c.org_id=OLD.org_id AND c.sale_id=OLD.id) BEGIN SELECT RAISE(ABORT,'billed sale line is locked'); END;

CREATE TRIGGER billing_claim_delete BEFORE DELETE ON billing_sale_claims WHEN NOT EXISTS(SELECT 1 FROM billing_invoices i WHERE i.org_id=OLD.org_id AND i.id=OLD.invoice_id AND i.status='void') BEGIN SELECT RAISE(ABORT,'active invoice claims cannot be released'); END;

CREATE TRIGGER billing_claim_update BEFORE UPDATE ON billing_sale_claims BEGIN SELECT RAISE(ABORT,'invoice claims cannot be changed'); END;

CREATE TRIGGER billing_claim_validate BEFORE INSERT ON billing_sale_claims BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM billing_invoices i WHERE i.org_id=NEW.org_id AND i.id=NEW.invoice_id AND i.status='issued' AND i.source_amount_basis='platform_net') THEN RAISE(ABORT,'invoice claim requires an issued platform-net invoice') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM billing_invoice_lines l
    WHERE l.org_id=NEW.org_id AND l.invoice_id=NEW.invoice_id AND l.sale_id=NEW.sale_id AND (
      EXISTS(SELECT 1 FROM settlement_report_links s WHERE s.org_id=l.org_id AND s.report_id=l.report_id AND s.report_basis='gross')
      OR EXISTS(SELECT 1 FROM committee_snapshot_reports s WHERE s.org_id=l.org_id AND s.report_id=l.report_id AND s.report_basis='gross')
    )
  ) THEN RAISE(ABORT,'gross report amount cannot be invoiced directly') END;
  SELECT CASE WHEN 10000<>(SELECT COALESCE(SUM(allocation_bps),0) FROM billing_invoice_line_works w WHERE w.org_id=NEW.org_id AND w.invoice_id=NEW.invoice_id AND w.sale_id=NEW.sale_id) THEN RAISE(ABORT,'invoice work allocation must total 100 percent') END;
END;

CREATE TRIGGER billing_invoice_line_immutable BEFORE UPDATE ON billing_invoice_lines BEGIN SELECT RAISE(ABORT,'invoice lines are immutable'); END;

CREATE TRIGGER billing_invoice_line_no_delete BEFORE DELETE ON billing_invoice_lines BEGIN SELECT RAISE(ABORT,'invoice lines are immutable'); END;

CREATE TRIGGER billing_invoice_line_validate BEFORE INSERT ON billing_invoice_lines BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    JOIN billing_invoices i ON i.org_id=s.org_id AND i.id=NEW.invoice_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND s.report_id=NEW.report_id AND s.project_id=NEW.project_id AND s.work_id=NEW.work_id
      AND s.partner_id=NEW.partner_id AND s.partner_id=i.partner_id AND s.product_id IS NEW.product_id AND s.description=NEW.description
      AND s.accounting_month=NEW.accounting_month AND s.source_row IS NEW.source_row
      AND s.amount_ex_tax=NEW.amount_ex_tax AND s.tax_amount=NEW.tax_amount AND s.amount_inc_tax=NEW.amount_inc_tax AND r.status='active'
  ) THEN RAISE(ABORT,'invoice line must snapshot an active original sale exactly') END;
END;

CREATE TRIGGER billing_invoice_no_delete BEFORE DELETE ON billing_invoices BEGIN SELECT RAISE(ABORT,'invoice snapshots are immutable'); END;

CREATE TRIGGER billing_invoice_update BEFORE UPDATE ON billing_invoices BEGIN
  SELECT CASE WHEN NEW.org_id<>OLD.org_id OR NEW.invoice_number<>OLD.invoice_number OR NEW.partner_id<>OLD.partner_id OR NEW.invoice_date<>OLD.invoice_date OR NEW.due_date<>OLD.due_date OR NEW.source_amount_basis<>OLD.source_amount_basis OR NEW.amount_ex_tax<>OLD.amount_ex_tax OR NEW.tax_amount<>OLD.tax_amount OR NEW.amount_inc_tax<>OLD.amount_inc_tax OR NEW.note IS NOT OLD.note OR NEW.snapshot_json<>OLD.snapshot_json OR NEW.snapshot_hash<>OLD.snapshot_hash OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN RAISE(ABORT,'invoice snapshot is immutable') END;
  SELECT CASE WHEN OLD.status='void' OR NEW.status<>'void' OR NEW.version<>OLD.version+1 THEN RAISE(ABORT,'invoice can only transition once to void') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM billing_receipt_allocations a LEFT JOIN billing_receipt_reversals x ON x.org_id=a.org_id AND x.receipt_id=a.receipt_id WHERE a.org_id=OLD.org_id AND a.invoice_id=OLD.id AND x.receipt_id IS NULL) THEN RAISE(ABORT,'invoice with effective receipts cannot be voided') END;
END;

CREATE TRIGGER billing_invoice_void_immutable BEFORE UPDATE ON billing_invoice_voids BEGIN SELECT RAISE(ABORT,'invoice void event is immutable'); END;

CREATE TRIGGER billing_invoice_void_no_delete BEFORE DELETE ON billing_invoice_voids BEGIN SELECT RAISE(ABORT,'invoice void event is immutable'); END;

CREATE TRIGGER billing_invoice_void_validate BEFORE INSERT ON billing_invoice_voids BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM billing_invoices i WHERE i.org_id=NEW.org_id AND i.id=NEW.invoice_id AND i.status='void' AND NEW.voided_on>=i.invoice_date) THEN RAISE(ABORT,'invoice void date or state is invalid') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM billing_receipt_allocations a
    LEFT JOIN billing_receipt_reversals x ON x.org_id=a.org_id AND x.receipt_id=a.receipt_id
    WHERE a.org_id=NEW.org_id AND a.invoice_id=NEW.invoice_id AND (x.receipt_id IS NULL OR x.reversed_on>NEW.voided_on)
  ) THEN RAISE(ABORT,'invoice has a receipt effective on the void date') END;
END;

CREATE TRIGGER billing_line_work_immutable BEFORE UPDATE ON billing_invoice_line_works BEGIN SELECT RAISE(ABORT,'invoice allocation snapshots are immutable'); END;

CREATE TRIGGER billing_line_work_no_delete BEFORE DELETE ON billing_invoice_line_works BEGIN SELECT RAISE(ABORT,'invoice allocation snapshots are immutable'); END;

CREATE TRIGGER billing_line_work_validate BEFORE INSERT ON billing_invoice_line_works BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM billing_invoice_lines l JOIN sale_lines s ON s.org_id=l.org_id AND s.id=l.sale_id
    WHERE l.org_id=NEW.org_id AND l.invoice_id=NEW.invoice_id AND l.sale_id=NEW.sale_id AND (
      (s.product_id IS NULL AND NEW.work_id=s.work_id AND NEW.allocation_bps=10000)
      OR (s.product_id IS NOT NULL AND EXISTS(
        SELECT 1 FROM product_works pw WHERE pw.org_id=s.org_id AND pw.product_id=s.product_id
          AND pw.work_id=NEW.work_id AND pw.allocation_bps=NEW.allocation_bps
      ))
    )
  ) THEN RAISE(ABORT,'invoice work allocation must match the original sale allocation') END;
END;

CREATE TRIGGER billing_receipt_allocation_complete AFTER INSERT ON billing_receipt_allocations WHEN (SELECT COUNT(*) FROM billing_receipt_allocations a WHERE a.org_id=NEW.org_id AND a.receipt_id=NEW.receipt_id)=(SELECT allocation_count FROM billing_receipts r WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id) BEGIN
  SELECT CASE WHEN (SELECT SUM(a.amount_yen) FROM billing_receipt_allocations a WHERE a.org_id=NEW.org_id AND a.receipt_id=NEW.receipt_id)<>(SELECT amount_yen FROM billing_receipts r WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id) THEN RAISE(ABORT,'receipt allocations must equal receipt amount') END;
END;

CREATE TRIGGER billing_receipt_allocation_immutable BEFORE UPDATE ON billing_receipt_allocations BEGIN SELECT RAISE(ABORT,'receipt allocations are immutable'); END;

CREATE TRIGGER billing_receipt_allocation_no_delete BEFORE DELETE ON billing_receipt_allocations BEGIN SELECT RAISE(ABORT,'receipt allocations are immutable'); END;

CREATE TRIGGER billing_receipt_allocation_validate BEFORE INSERT ON billing_receipt_allocations BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM billing_receipts r JOIN billing_invoices i ON i.org_id=r.org_id AND i.id=NEW.invoice_id WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id AND i.partner_id=r.partner_id AND i.status='issued' AND i.invoice_date<=r.received_on) THEN RAISE(ABORT,'receipt allocation invoice scope mismatch') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM billing_receipt_allocations a WHERE a.org_id=NEW.org_id AND a.receipt_id=NEW.receipt_id)>=(SELECT allocation_count FROM billing_receipts r WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id) THEN RAISE(ABORT,'too many receipt allocations') END;
  SELECT CASE WHEN COALESCE((SELECT SUM(a.amount_yen) FROM billing_receipt_allocations a LEFT JOIN billing_receipt_reversals x ON x.org_id=a.org_id AND x.receipt_id=a.receipt_id AND x.reversed_on<=(SELECT received_on FROM billing_receipts WHERE org_id=NEW.org_id AND id=NEW.receipt_id) WHERE a.org_id=NEW.org_id AND a.invoice_id=NEW.invoice_id AND x.receipt_id IS NULL),0)+NEW.amount_yen>(SELECT amount_inc_tax FROM billing_invoices i WHERE i.org_id=NEW.org_id AND i.id=NEW.invoice_id) THEN RAISE(ABORT,'receipt exceeds invoice balance') END;
END;

CREATE TRIGGER billing_receipt_immutable BEFORE UPDATE ON billing_receipts BEGIN SELECT RAISE(ABORT,'receipt events are immutable'); END;

CREATE TRIGGER billing_receipt_no_delete BEFORE DELETE ON billing_receipts BEGIN SELECT RAISE(ABORT,'receipt events are immutable'); END;

CREATE TRIGGER billing_receipt_reversal_immutable BEFORE UPDATE ON billing_receipt_reversals BEGIN SELECT RAISE(ABORT,'receipt reversal event is immutable'); END;

CREATE TRIGGER billing_receipt_reversal_no_delete BEFORE DELETE ON billing_receipt_reversals BEGIN SELECT RAISE(ABORT,'receipt reversal event is immutable'); END;

CREATE TRIGGER billing_receipt_reversal_validate BEFORE INSERT ON billing_receipt_reversals BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM billing_receipts r WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id AND NEW.reversed_on>=r.received_on) THEN RAISE(ABORT,'receipt reversal date is invalid') END;
END;

CREATE TRIGGER broadcast_airing_no_delete BEFORE DELETE ON broadcast_airings BEGIN SELECT RAISE(ABORT,'broadcast airing immutable'); END;

CREATE TRIGGER broadcast_airing_no_update BEFORE UPDATE ON broadcast_airings BEGIN SELECT RAISE(ABORT,'broadcast airing immutable'); END;

CREATE TRIGGER broadcast_availability_rate_no_delete BEFORE DELETE ON broadcast_availability_rates BEGIN SELECT RAISE(ABORT,'availability rate version immutable'); END;

CREATE TRIGGER broadcast_availability_rate_no_update BEFORE UPDATE ON broadcast_availability_rates BEGIN SELECT RAISE(ABORT,'availability rate version immutable'); END;

CREATE TRIGGER broadcast_sale_link_no_update BEFORE UPDATE ON broadcast_sale_links BEGIN SELECT RAISE(ABORT,'broadcast sale link immutable'); END;

CREATE TRIGGER broadcast_sale_link_scope BEFORE INSERT ON broadcast_sale_links
WHEN NOT EXISTS(SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND s.work_id=NEW.work_id)
BEGIN SELECT RAISE(ABORT,'broadcast sale work mismatch'); END;

CREATE TRIGGER broadcast_version_no_delete BEFORE DELETE ON broadcast_slot_versions BEGIN SELECT RAISE(ABORT,'broadcast version immutable'); END;

CREATE TRIGGER broadcast_version_no_update BEFORE UPDATE ON broadcast_slot_versions BEGIN SELECT RAISE(ABORT,'broadcast version immutable'); END;

CREATE TRIGGER catalog_credits_immutable_delete BEFORE DELETE ON catalog_credits BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_credits_immutable_update BEFORE UPDATE ON catalog_credits BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_edition_tags_immutable_delete BEFORE DELETE ON catalog_edition_tags BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_edition_tags_immutable_update BEFORE UPDATE ON catalog_edition_tags BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_editions_immutable_delete BEFORE DELETE ON catalog_editions BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_editions_immutable_update BEFORE UPDATE ON catalog_editions BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_product_editions_immutable_delete BEFORE DELETE ON catalog_product_editions BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_product_editions_immutable_update BEFORE UPDATE ON catalog_product_editions BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_product_windows_immutable_delete BEFORE DELETE ON catalog_product_windows BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_product_windows_immutable_update BEFORE UPDATE ON catalog_product_windows BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_profiles_immutable_delete BEFORE DELETE ON catalog_profiles BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER catalog_profiles_immutable_update BEFORE UPDATE ON catalog_profiles BEGIN SELECT RAISE(ABORT,'catalog version immutable'); END;

CREATE TRIGGER channel_report_kind_locked BEFORE UPDATE OF kind ON report_imports
WHEN EXISTS (SELECT 1 FROM package_report_observations o WHERE o.org_id=OLD.org_id AND o.report_id=OLD.id)
  OR EXISTS (SELECT 1 FROM sale_lines s JOIN theatrical_sale_details d ON d.org_id=s.org_id AND d.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id)
  OR EXISTS (SELECT 1 FROM sale_lines s JOIN package_sale_details d ON d.org_id=s.org_id AND d.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id)
  OR EXISTS (SELECT 1 FROM sale_lines s JOIN digital_sale_details d ON d.org_id=s.org_id AND d.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'channel report kind is immutable'); END;

CREATE TRIGGER channel_sale_parent_locked BEFORE UPDATE OF org_id,report_id ON sale_lines
WHEN EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id=OLD.org_id AND d.sale_id=OLD.id)
  OR EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id=OLD.org_id AND d.sale_id=OLD.id)
  OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id=OLD.org_id AND d.sale_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'channel detail parent is immutable'); END;

CREATE TRIGGER committee_contract_immutable BEFORE UPDATE ON committee_contracts BEGIN SELECT RAISE(ABORT,'committee contract is immutable'); END;

CREATE TRIGGER committee_deduction_immutable BEFORE UPDATE ON committee_snapshot_deductions BEGIN SELECT RAISE(ABORT,'committee deductions are immutable'); END;

CREATE TRIGGER committee_deduction_no_delete BEFORE DELETE ON committee_snapshot_deductions BEGIN SELECT RAISE(ABORT,'committee deductions are immutable'); END;

CREATE TRIGGER committee_deduction_scope BEFORE INSERT ON committee_snapshot_deductions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_snapshot_reports r WHERE r.org_id=NEW.org_id AND r.snapshot_id=NEW.snapshot_id AND r.work_id=NEW.work_id AND r.report_id=NEW.report_id AND r.window_id=NEW.window_id) THEN RAISE(ABORT,'committee deduction report scope mismatch') END;
END;

CREATE TRIGGER committee_funding_immutable BEFORE UPDATE ON committee_term_funding BEGIN SELECT RAISE(ABORT,'committee funding is immutable'); END;

CREATE TRIGGER committee_funding_no_delete BEFORE DELETE ON committee_term_funding BEGIN SELECT RAISE(ABORT,'committee funding is immutable'); END;

CREATE TRIGGER committee_investment_immutable BEFORE UPDATE ON committee_term_investments BEGIN SELECT RAISE(ABORT,'committee investment is immutable'); END;

CREATE TRIGGER committee_investment_no_delete BEFORE DELETE ON committee_term_investments BEGIN SELECT RAISE(ABORT,'committee investment is immutable'); END;

CREATE TRIGGER committee_member_immutable BEFORE UPDATE ON committee_term_members BEGIN SELECT RAISE(ABORT,'committee terms are immutable'); END;

CREATE TRIGGER committee_phase_immutable BEFORE UPDATE ON committee_schedule_phases BEGIN SELECT RAISE(ABORT,'committee terms are immutable'); END;

CREATE TRIGGER committee_snapshot_expense_immutable BEFORE UPDATE ON committee_snapshot_expenses BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;

CREATE TRIGGER committee_snapshot_expense_scope BEFORE INSERT ON committee_snapshot_expenses BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id=s.org_id AND w.term_version_id=s.term_version_id JOIN expenses e ON e.org_id=s.org_id AND e.id=NEW.expense_id AND e.work_id=s.work_id WHERE s.org_id=NEW.org_id AND s.id=NEW.snapshot_id AND s.work_id=NEW.work_id AND w.id=NEW.window_id) THEN RAISE(ABORT,'committee expense scope mismatch') END;
END;

CREATE TRIGGER committee_snapshot_immutable BEFORE UPDATE ON committee_report_snapshots BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;

CREATE TRIGGER committee_snapshot_line_immutable BEFORE UPDATE ON committee_snapshot_lines BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;

CREATE TRIGGER committee_snapshot_line_scope BEFORE INSERT ON committee_snapshot_lines BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id=s.org_id AND w.term_version_id=s.term_version_id JOIN sale_lines sl ON sl.org_id=s.org_id AND sl.id=NEW.sale_id AND sl.report_id=NEW.report_id WHERE s.org_id=NEW.org_id AND s.id=NEW.snapshot_id AND s.work_id=NEW.work_id AND w.id=NEW.window_id) THEN RAISE(ABORT,'committee sale line scope mismatch') END;
END;

CREATE TRIGGER committee_snapshot_member_immutable BEFORE UPDATE ON committee_snapshot_member_amounts BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;

CREATE TRIGGER committee_snapshot_member_scope BEFORE INSERT ON committee_snapshot_member_amounts BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id=s.org_id AND w.term_version_id=s.term_version_id WHERE s.org_id=NEW.org_id AND s.id=NEW.snapshot_id AND w.id=NEW.window_id) THEN RAISE(ABORT,'committee member window scope mismatch') END;
END;

CREATE TRIGGER committee_snapshot_report_immutable BEFORE UPDATE ON committee_snapshot_reports BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;

CREATE TRIGGER committee_snapshot_report_scope BEFORE INSERT ON committee_snapshot_reports BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id=s.org_id AND w.term_version_id=s.term_version_id WHERE s.org_id=NEW.org_id AND s.id=NEW.snapshot_id AND s.work_id=NEW.work_id AND w.id=NEW.window_id) THEN RAISE(ABORT,'committee report window scope mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM settlement_report_links r WHERE r.org_id=NEW.org_id AND r.work_id=NEW.work_id AND r.report_id=NEW.report_id) THEN RAISE(ABORT,'report already used by individual settlement') END;
END;

CREATE TRIGGER committee_term_immutable BEFORE UPDATE ON committee_term_versions BEGIN SELECT RAISE(ABORT,'committee terms are immutable'); END;

CREATE TRIGGER committee_window_immutable BEFORE UPDATE ON committee_term_windows BEGIN SELECT RAISE(ABORT,'committee terms are immutable'); END;

CREATE TRIGGER digital_detail_immutable_delete BEFORE DELETE ON digital_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;

CREATE TRIGGER digital_detail_immutable_update BEFORE UPDATE ON digital_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;

CREATE TRIGGER digital_detail_scope BEFORE INSERT ON digital_sale_details BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND r.kind='digital'
  ) THEN RAISE(ABORT,'digital detail requires digital report sale') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    OR EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    THEN RAISE(ABORT,'sale already has another channel detail') END;
END;

CREATE TRIGGER digital_detail_sealed BEFORE INSERT ON digital_sale_details
WHEN EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id=s.org_id AND f.report_id=s.report_id WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;

CREATE TRIGGER distribution_master_no_delete BEFORE DELETE ON distribution_master BEGIN SELECT RAISE(ABORT,'distribution master in use'); END;

CREATE TRIGGER distribution_master_no_update BEFORE UPDATE ON distribution_master BEGIN SELECT RAISE(ABORT,'distribution master requires explicit migration'); END;

CREATE TRIGGER distribution_no_delete BEFORE DELETE ON sale_distribution_versions BEGIN SELECT RAISE(ABORT,'distribution versions immutable'); END;

CREATE TRIGGER distribution_no_update BEFORE UPDATE ON sale_distribution_versions BEGIN SELECT RAISE(ABORT,'distribution versions immutable'); END;

CREATE TRIGGER joint_contract_immutable BEFORE UPDATE ON joint_committee_contracts BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;

CREATE TRIGGER joint_contract_no_delete BEFORE DELETE ON joint_committee_contracts BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;

CREATE TRIGGER joint_cost_immutable BEFORE UPDATE ON joint_committee_costs BEGIN SELECT RAISE(ABORT,'joint cost event is immutable'); END;

CREATE TRIGGER joint_cost_no_delete BEFORE DELETE ON joint_committee_costs BEGIN SELECT RAISE(ABORT,'joint cost event is immutable'); END;

CREATE TRIGGER joint_funding_credit_validate BEFORE INSERT ON joint_funding_events WHEN NEW.kind='production_payment_credit' BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM joint_production_milestones m JOIN joint_committee_contracts c ON c.org_id=m.org_id AND c.id=m.contract_id
    WHERE m.org_id=NEW.org_id AND m.contract_id=NEW.contract_id AND m.id=NEW.milestone_id
      AND c.manager_partner_id=NEW.partner_id AND m.paid_on=NEW.paid_on AND m.paid_inc_tax_yen>=NEW.amount_inc_tax_yen
  ) THEN RAISE(ABORT,'production payment credit source mismatch') END;
  SELECT CASE WHEN (SELECT COALESCE(SUM(f.amount_inc_tax_yen),0) FROM joint_funding_events f WHERE f.org_id=NEW.org_id AND f.contract_id=NEW.contract_id AND f.milestone_id=NEW.milestone_id)+NEW.amount_inc_tax_yen>
    (SELECT m.paid_inc_tax_yen FROM joint_production_milestones m WHERE m.org_id=NEW.org_id AND m.contract_id=NEW.contract_id AND m.id=NEW.milestone_id)
    THEN RAISE(ABORT,'production payment credit exceeds paid amount') END;
END;

CREATE TRIGGER joint_funding_event_immutable BEFORE UPDATE ON joint_funding_events BEGIN SELECT RAISE(ABORT,'funding event is immutable'); END;

CREATE TRIGGER joint_funding_event_no_delete BEFORE DELETE ON joint_funding_events BEGIN SELECT RAISE(ABORT,'funding event is immutable'); END;

CREATE TRIGGER joint_holiday_immutable BEFORE UPDATE ON joint_business_holidays BEGIN SELECT RAISE(ABORT,'joint calendar is immutable'); END;

CREATE TRIGGER joint_holiday_no_delete BEFORE DELETE ON joint_business_holidays BEGIN SELECT RAISE(ABORT,'joint calendar is immutable'); END;

CREATE TRIGGER joint_member_immutable BEFORE UPDATE ON joint_committee_members BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;

CREATE TRIGGER joint_member_no_delete BEFORE DELETE ON joint_committee_members BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;

CREATE TRIGGER joint_milestone_immutable BEFORE UPDATE ON joint_production_milestones BEGIN SELECT RAISE(ABORT,'production milestone is immutable'); END;

CREATE TRIGGER joint_milestone_no_delete BEFORE DELETE ON joint_production_milestones BEGIN SELECT RAISE(ABORT,'production milestone is immutable'); END;

CREATE TRIGGER joint_period_immutable BEFORE UPDATE ON joint_committee_periods BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;

CREATE TRIGGER joint_period_no_delete BEFORE DELETE ON joint_committee_periods BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;

CREATE TRIGGER joint_sale_immutable BEFORE UPDATE ON joint_committee_sales BEGIN SELECT RAISE(ABORT,'joint sale event is immutable'); END;

CREATE TRIGGER joint_sale_no_delete BEFORE DELETE ON joint_committee_sales BEGIN SELECT RAISE(ABORT,'joint sale event is immutable'); END;

CREATE TRIGGER joint_snapshot_immutable BEFORE UPDATE ON joint_committee_snapshots BEGIN SELECT RAISE(ABORT,'joint snapshot is immutable'); END;

CREATE TRIGGER joint_snapshot_no_delete BEFORE DELETE ON joint_committee_snapshots BEGIN SELECT RAISE(ABORT,'joint snapshot is immutable'); END;

CREATE TRIGGER joint_window_immutable BEFORE UPDATE ON joint_committee_windows BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;

CREATE TRIGGER joint_window_no_delete BEFORE DELETE ON joint_committee_windows BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;

CREATE TRIGGER mapping_provenance_immutable BEFORE UPDATE ON mapping_import_provenance BEGIN SELECT RAISE(ABORT,'mapping provenance is immutable'); END;

CREATE TRIGGER mg_incoming_no_delete BEFORE DELETE ON mg_incoming_contracts BEGIN SELECT RAISE(ABORT,'MG契約マスターは削除できません'); END;

CREATE TRIGGER mg_incoming_no_update BEFORE UPDATE ON mg_incoming_contracts BEGIN SELECT RAISE(ABORT,'MG契約マスターは変更できません'); END;

CREATE TRIGGER mg_ledger_no_delete BEFORE DELETE ON mg_ledger_entries BEGIN SELECT RAISE(ABORT,'MG月次報告は削除できません'); END;

CREATE TRIGGER mg_ledger_no_update BEFORE UPDATE ON mg_ledger_entries BEGIN SELECT RAISE(ABORT,'MG月次報告は変更できません'); END;

CREATE TRIGGER mg_ledger_successor_scope BEFORE INSERT ON mg_ledger_entries WHEN NEW.reverses_entry_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM mg_ledger_entries old
    WHERE old.org_id=NEW.org_id AND old.id=NEW.reverses_entry_id
      AND old.term_version_id=NEW.term_version_id AND old.product_id=NEW.product_id
  ) THEN RAISE(ABORT,'訂正元は同じ条件版・商品の原報告を指定してください') END;
END;

CREATE TRIGGER mg_outgoing_no_delete BEFORE DELETE ON mg_outgoing_contracts BEGIN SELECT RAISE(ABORT,'MG契約マスターは削除できません'); END;

CREATE TRIGGER mg_outgoing_no_update BEFORE UPDATE ON mg_outgoing_contracts BEGIN SELECT RAISE(ABORT,'MG契約マスターは変更できません'); END;

CREATE TRIGGER mg_phases_no_delete BEFORE DELETE ON mg_version_phases BEGIN SELECT RAISE(ABORT,'MG日程は削除できません'); END;

CREATE TRIGGER mg_phases_no_update BEFORE UPDATE ON mg_version_phases BEGIN SELECT RAISE(ABORT,'MG日程は変更できません'); END;

CREATE TRIGGER mg_products_no_delete BEFORE DELETE ON mg_version_products BEGIN SELECT RAISE(ABORT,'MG商品評価は削除できません'); END;

CREATE TRIGGER mg_products_no_update BEFORE UPDATE ON mg_version_products BEGIN SELECT RAISE(ABORT,'MG商品評価は変更できません'); END;

CREATE TRIGGER mg_terms_no_delete BEFORE DELETE ON mg_term_versions BEGIN SELECT RAISE(ABORT,'MG条件版は削除できません'); END;

CREATE TRIGGER mg_terms_no_update BEFORE UPDATE ON mg_term_versions BEGIN SELECT RAISE(ABORT,'MG条件版は変更できません'); END;

CREATE TRIGGER observation_value_type_insert BEFORE INSERT ON observations BEGIN
  SELECT CASE
    WHEN (SELECT value_type FROM metric_definitions WHERE org_id=NEW.org_id AND id=NEW.metric_definition_id) IN ('integer','decimal','boolean') AND NEW.value_text IS NOT NULL THEN RAISE(ABORT,'numeric metric requires value_number')
    WHEN (SELECT value_type FROM metric_definitions WHERE org_id=NEW.org_id AND id=NEW.metric_definition_id)='text' AND NEW.value_number IS NOT NULL THEN RAISE(ABORT,'text metric requires value_text')
    WHEN (SELECT value_type FROM metric_definitions WHERE org_id=NEW.org_id AND id=NEW.metric_definition_id)='integer' AND NEW.value_number IS NOT NULL AND NEW.value_number<>CAST(NEW.value_number AS INTEGER) THEN RAISE(ABORT,'integer metric requires integer value')
    WHEN (SELECT value_type FROM metric_definitions WHERE org_id=NEW.org_id AND id=NEW.metric_definition_id)='boolean' AND NEW.value_number IS NOT NULL AND NEW.value_number NOT IN (0,1) THEN RAISE(ABORT,'boolean metric requires 0 or 1') END;
END;

CREATE TRIGGER opportunity_scope_locked BEFORE UPDATE OF org_id,project_id,work_id,partner_id ON sales_opportunities
WHEN (NEW.org_id<>OLD.org_id OR NEW.project_id<>OLD.project_id OR NEW.work_id<>OLD.work_id OR NEW.partner_id<>OLD.partner_id)
  AND (EXISTS(SELECT 1 FROM sales_activities a WHERE a.org_id=OLD.org_id AND a.opportunity_id=OLD.id)
    OR EXISTS(SELECT 1 FROM sales_agreements a WHERE a.org_id=OLD.org_id AND a.opportunity_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'opportunity scope is referenced'); END;

CREATE TRIGGER package_detail_immutable_delete BEFORE DELETE ON package_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;

CREATE TRIGGER package_detail_immutable_update BEFORE UPDATE ON package_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;

CREATE TRIGGER package_detail_scope BEFORE INSERT ON package_sale_details BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND r.kind='package'
  ) THEN RAISE(ABORT,'package detail requires package report sale') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    THEN RAISE(ABORT,'sale already has another channel detail') END;
END;

CREATE TRIGGER package_detail_sealed BEFORE INSERT ON package_sale_details
WHEN EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id=s.org_id AND f.report_id=s.report_id WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;

CREATE TRIGGER package_observation_immutable_delete BEFORE DELETE ON package_report_observations BEGIN SELECT RAISE(ABORT,'package observation is immutable'); END;

CREATE TRIGGER package_observation_immutable_update BEFORE UPDATE ON package_report_observations BEGIN SELECT RAISE(ABORT,'package observation is immutable'); END;

CREATE TRIGGER package_observation_product_immutable_delete BEFORE DELETE ON package_observation_products BEGIN SELECT RAISE(ABORT,'package observation product is immutable'); END;

CREATE TRIGGER package_observation_product_immutable_update BEFORE UPDATE ON package_observation_products BEGIN SELECT RAISE(ABORT,'package observation product is immutable'); END;

CREATE TRIGGER package_observation_product_sealed BEFORE INSERT ON package_observation_products
WHEN EXISTS (SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id=NEW.org_id AND f.report_id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;

CREATE TRIGGER package_observation_scope BEFORE INSERT ON package_report_observations BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.kind='package')
    THEN RAISE(ABORT,'package observation requires package report') END;
END;

CREATE TRIGGER package_observation_sealed BEFORE INSERT ON package_report_observations
WHEN EXISTS (SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id=NEW.org_id AND f.report_id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;

CREATE TRIGGER plan_approval_guard BEFORE INSERT ON receipt_plan_decisions WHEN NEW.decision='approved' BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM receipt_plan_requests q JOIN billing_invoices i ON i.org_id=q.org_id AND i.id=q.invoice_id
 WHERE q.org_id=NEW.org_id AND q.id=NEW.request_id AND i.status='issued' AND q.proposed_due_date>=i.invoice_date
 AND i.amount_inc_tax>COALESCE((SELECT SUM(ba.amount_yen) FROM billing_receipt_allocations ba LEFT JOIN billing_receipt_reversals br ON br.org_id=ba.org_id AND br.receipt_id=ba.receipt_id WHERE ba.org_id=i.org_id AND ba.invoice_id=i.id AND br.receipt_id IS NULL),0)
 AND q.base_version=COALESCE((SELECT MAX(d.version_no) FROM receipt_plan_decisions d WHERE d.org_id=NEW.org_id AND d.invoice_id=NEW.invoice_id),0)
 AND NEW.version_no=q.base_version+1) THEN RAISE(ABORT,'stale plan request') END;
END;

CREATE TRIGGER plan_decision_no_delete BEFORE DELETE ON receipt_plan_decisions BEGIN SELECT RAISE(ABORT,'plan decision immutable'); END;

CREATE TRIGGER plan_decision_no_update BEFORE UPDATE ON receipt_plan_decisions BEGIN SELECT RAISE(ABORT,'plan decision immutable'); END;

CREATE TRIGGER plan_request_no_delete BEFORE DELETE ON receipt_plan_requests BEGIN SELECT RAISE(ABORT,'plan request immutable'); END;

CREATE TRIGGER plan_request_no_update BEFORE UPDATE ON receipt_plan_requests BEGIN SELECT RAISE(ABORT,'plan request immutable'); END;

CREATE TRIGGER report_channel_fact_seal_immutable_delete BEFORE DELETE ON report_channel_fact_seals BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;

CREATE TRIGGER report_channel_fact_seal_immutable_update BEFORE UPDATE ON report_channel_fact_seals BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;

CREATE TRIGGER report_dimensions_immutable_delete BEFORE DELETE ON report_sale_dimensions_versions BEGIN SELECT RAISE(ABORT,'report dimensions are immutable'); END;

CREATE TRIGGER report_dimensions_immutable_update BEFORE UPDATE ON report_sale_dimensions_versions BEGIN SELECT RAISE(ABORT,'report dimensions are immutable'); END;

CREATE TRIGGER report_mapping_profile_immutable BEFORE UPDATE ON report_mapping_profiles BEGIN SELECT RAISE(ABORT,'mapping profiles are immutable'); END;

CREATE TRIGGER report_mapping_version_immutable BEFORE UPDATE ON report_mapping_versions BEGIN SELECT RAISE(ABORT,'mapping versions are immutable'); END;

CREATE TRIGGER report_recognition_immutable BEFORE UPDATE ON report_recognition BEGIN
  SELECT RAISE(ABORT,'report recognition metadata is immutable');
END;

CREATE TRIGGER report_recognition_month_insert BEFORE INSERT ON report_recognition BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.accounting_month=NEW.resolved_month)
    THEN RAISE(ABORT,'report recognition month mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND s.accounting_month<>NEW.resolved_month)
    THEN RAISE(ABORT,'sale recognition month mismatch') END;
  SELECT CASE WHEN NEW.recognition_basis_id=1 AND EXISTS(SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND (substr(s.sales_period_from,1,7)<>NEW.sales_month OR substr(s.sales_period_to,1,7)<>NEW.sales_month))
    THEN RAISE(ABORT,'sales recognition month requires single-month sale period') END;
END;

CREATE TRIGGER report_recognition_month_update BEFORE UPDATE ON report_recognition BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.accounting_month=NEW.resolved_month)
    THEN RAISE(ABORT,'report recognition month mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND s.accounting_month<>NEW.resolved_month)
    THEN RAISE(ABORT,'sale recognition month mismatch') END;
END;

CREATE TRIGGER report_recognition_report_update BEFORE UPDATE OF accounting_month ON report_imports WHEN EXISTS(SELECT 1 FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.id) BEGIN
  SELECT CASE WHEN NEW.accounting_month<>(SELECT resolved_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.id) THEN RAISE(ABORT,'report recognition month mismatch') END;
END;

CREATE TRIGGER report_recognition_sale_insert BEFORE INSERT ON sale_lines WHEN NEW.report_id IS NOT NULL AND EXISTS(SELECT 1 FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id) BEGIN
  SELECT CASE WHEN NEW.accounting_month<>(SELECT resolved_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id) THEN RAISE(ABORT,'sale recognition month mismatch') END;
  SELECT CASE WHEN (SELECT recognition_basis_id FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id)=1
    AND (substr(NEW.sales_period_from,1,7)<>(SELECT sales_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id)
      OR substr(NEW.sales_period_to,1,7)<>(SELECT sales_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id))
    THEN RAISE(ABORT,'sales recognition month requires single-month sale period') END;
END;

CREATE TRIGGER report_recognition_sale_update BEFORE UPDATE OF accounting_month,report_id,sales_period_from,sales_period_to ON sale_lines WHEN NEW.report_id IS NOT NULL AND EXISTS(SELECT 1 FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id) BEGIN
  SELECT CASE WHEN NEW.accounting_month<>(SELECT resolved_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id) THEN RAISE(ABORT,'sale recognition month mismatch') END;
  SELECT CASE WHEN (SELECT recognition_basis_id FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id)=1
    AND (substr(NEW.sales_period_from,1,7)<>(SELECT sales_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id)
      OR substr(NEW.sales_period_to,1,7)<>(SELECT sales_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id))
    THEN RAISE(ABORT,'sales recognition month requires single-month sale period') END;
END;

CREATE TRIGGER report_source_control_channel_scope BEFORE INSERT ON report_source_controls
WHEN NEW.scope_kind='channel'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM report_imports r
    WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.kind=NEW.channel
  ) THEN RAISE(ABORT,'source control channel must match report kind') END;
END;

CREATE TRIGGER report_source_control_immutable_delete BEFORE DELETE ON report_source_controls
BEGIN SELECT RAISE(ABORT,'source control is immutable'); END;

CREATE TRIGGER report_source_control_immutable_update BEFORE UPDATE ON report_source_controls
BEGIN SELECT RAISE(ABORT,'source control is immutable'); END;

CREATE TRIGGER report_source_control_matches_sealed_report BEFORE INSERT ON report_source_controls
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id=NEW.org_id AND f.report_id=NEW.report_id
  ) THEN RAISE(ABORT,'source control requires sealed report') END;
  SELECT CASE WHEN NEW.expected_value <> CASE NEW.metric
    WHEN 'row_count' THEN
      (SELECT COUNT(*) FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
      + (SELECT COUNT(DISTINCT o.source_row) FROM package_report_observations o
         WHERE o.org_id=NEW.org_id AND o.report_id=NEW.report_id
           AND NOT EXISTS (SELECT 1 FROM sale_lines s
             WHERE s.org_id=o.org_id AND s.report_id=o.report_id AND s.source_row=o.source_row))
    WHEN 'amount_ex_tax' THEN
      (SELECT COALESCE(SUM(s.amount_ex_tax),0) FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
    WHEN 'tax_amount' THEN
      (SELECT COALESCE(SUM(s.tax_amount),0) FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
    WHEN 'amount_inc_tax' THEN
      (SELECT COALESCE(SUM(s.amount_inc_tax),0) FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
  END THEN RAISE(ABORT,'source control does not match sealed report') END;
END;

CREATE TRIGGER report_source_control_observation_delete BEFORE DELETE ON package_report_observations
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled observation is immutable'); END;

CREATE TRIGGER report_source_control_observation_insert BEFORE INSERT ON package_report_observations
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=NEW.org_id AND c.report_id=NEW.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled observation is immutable'); END;

CREATE TRIGGER report_source_control_observation_update BEFORE UPDATE ON package_report_observations
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.report_id
) OR EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=NEW.org_id AND c.report_id=NEW.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled observation is immutable'); END;

CREATE TRIGGER report_source_control_report_identity_update
BEFORE UPDATE OF org_id,report_key,content_hash,kind ON report_imports
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.id
)
BEGIN SELECT RAISE(ABORT,'source-controlled report identity is immutable'); END;

CREATE TRIGGER report_source_control_sale_delete BEFORE DELETE ON sale_lines
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled sale is immutable'); END;

CREATE TRIGGER report_source_control_sale_insert BEFORE INSERT ON sale_lines
WHEN NEW.report_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=NEW.org_id AND c.report_id=NEW.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled sale is immutable'); END;

CREATE TRIGGER report_source_control_sale_update BEFORE UPDATE ON sale_lines
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.report_id
) OR EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=NEW.org_id AND c.report_id=NEW.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled sale is immutable'); END;

CREATE TRIGGER report_supersede_scope BEFORE INSERT ON report_imports WHEN NEW.supersedes_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.supersedes_id AND r.work_id=NEW.work_id AND r.report_key=NEW.report_key)
    THEN RAISE(ABORT,'superseded report scope mismatch') END;
END;

CREATE TRIGGER rights_intake_case_immutable BEFORE UPDATE ON rights_intake_cases BEGIN SELECT RAISE(ABORT,'rights intake snapshots are immutable'); END;

CREATE TRIGGER rights_intake_document_immutable BEFORE UPDATE ON rights_intake_documents BEGIN SELECT RAISE(ABORT,'rights intake snapshots are immutable'); END;

CREATE TRIGGER rights_intake_link_immutable BEFORE UPDATE ON intake_settlement_links BEGIN SELECT RAISE(ABORT,'rights intake settlement links are immutable'); END;

CREATE TRIGGER rights_intake_participant_immutable BEFORE UPDATE ON rights_intake_participants BEGIN SELECT RAISE(ABORT,'rights intake snapshots are immutable'); END;

CREATE TRIGGER rights_intake_scope_immutable BEFORE UPDATE ON rights_intake_scopes BEGIN SELECT RAISE(ABORT,'rights intake snapshots are immutable'); END;

CREATE TRIGGER rights_payments_no_delete BEFORE DELETE ON rights_payment_events BEGIN SELECT RAISE(ABORT,'rights payment events are immutable'); END;

CREATE TRIGGER rights_payments_no_update BEFORE UPDATE ON rights_payment_events BEGIN SELECT RAISE(ABORT,'rights payment events are immutable'); END;

CREATE TRIGGER rights_payments_validate BEFORE INSERT ON rights_payment_events BEGIN
 SELECT CASE WHEN NEW.settlement_contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM settlement_contracts c WHERE c.org_id=NEW.org_id AND c.id=NEW.settlement_contract_id AND c.holder_partner_id=NEW.partner_id) THEN RAISE(ABORT,'rights payment recipient mismatch') END;
 SELECT CASE WHEN NEW.committee_snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM committee_snapshot_member_amounts m WHERE m.org_id=NEW.org_id AND m.snapshot_id=NEW.committee_snapshot_id AND m.partner_id=NEW.partner_id) THEN RAISE(ABORT,'committee payment recipient mismatch') END;
 SELECT CASE WHEN NEW.reverses_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rights_payment_events p WHERE p.org_id=NEW.org_id AND p.id=NEW.reverses_event_id AND p.reverses_event_id IS NULL AND p.partner_id=NEW.partner_id AND p.settlement_contract_id IS NEW.settlement_contract_id AND p.committee_snapshot_id IS NEW.committee_snapshot_id AND p.amount_yen=NEW.amount_yen AND p.paid_on<=NEW.paid_on) THEN RAISE(ABORT,'rights payment reversal mismatch') END;
END;

CREATE TRIGGER sales_activity_immutable BEFORE UPDATE ON sales_activities BEGIN SELECT RAISE(ABORT,'sales activities are append-only'); END;

CREATE TRIGGER sales_activity_no_delete BEFORE DELETE ON sales_activities BEGIN SELECT RAISE(ABORT,'sales activities are append-only'); END;

CREATE TRIGGER sales_agreement_scope_immutable BEFORE UPDATE OF org_id,project_id,work_id,opportunity_id,partner_id,product_id,intake_case_id,contract_code,title ON sales_agreements BEGIN SELECT RAISE(ABORT,'sales agreement scope is immutable'); END;

CREATE TRIGGER sales_material_immutable BEFORE UPDATE ON sales_material_snapshots BEGIN SELECT RAISE(ABORT,'sales material snapshots are immutable'); END;

CREATE TRIGGER sales_material_no_delete BEFORE DELETE ON sales_material_snapshots BEGIN SELECT RAISE(ABORT,'sales material snapshots are immutable'); END;

CREATE TRIGGER sales_report_link_immutable BEFORE UPDATE ON sales_report_links BEGIN SELECT RAISE(ABORT,'sales report links are immutable'); END;

CREATE TRIGGER sales_report_link_no_delete BEFORE DELETE ON sales_report_links BEGIN SELECT RAISE(ABORT,'sales report links are immutable'); END;

CREATE TRIGGER sales_report_link_validate BEFORE INSERT ON sales_report_links BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM report_imports r JOIN sales_agreements a ON a.org_id=r.org_id AND a.id=NEW.agreement_id AND a.work_id=NEW.work_id
    JOIN sales_agreement_term_versions v ON v.org_id=a.org_id AND v.agreement_id=a.id AND v.id=NEW.term_version_id
    WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.status='active' AND r.partner_id=a.partner_id AND v.channel=r.kind
  ) THEN RAISE(ABORT,'sales report must be active and match partner and supported channel') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM sales_agreement_term_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.term_version_id AND v.agreement_id=NEW.agreement_id
      AND v.version_no=(SELECT MAX(latest.version_no) FROM sales_agreement_term_versions latest WHERE latest.org_id=v.org_id AND latest.agreement_id=v.agreement_id)
  ) THEN RAISE(ABORT,'sales report link requires current agreement term') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND (
      (s.product_id IS NOT NULL AND EXISTS(SELECT 1 FROM product_works pw WHERE pw.org_id=s.org_id AND pw.product_id=s.product_id AND pw.work_id=NEW.work_id))
      OR (NOT EXISTS(SELECT 1 FROM product_works any_pw WHERE any_pw.org_id=s.org_id AND any_pw.product_id=s.product_id) AND s.work_id=NEW.work_id)
    )
  ) THEN RAISE(ABORT,'sales report has no allocated lines for work') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM sale_lines s JOIN sales_agreements a ON a.org_id=NEW.org_id AND a.id=NEW.agreement_id
    WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND (
      (s.product_id IS NOT NULL AND EXISTS(SELECT 1 FROM product_works pw WHERE pw.org_id=s.org_id AND pw.product_id=s.product_id AND pw.work_id=NEW.work_id))
      OR (NOT EXISTS(SELECT 1 FROM product_works any_pw WHERE any_pw.org_id=s.org_id AND any_pw.product_id=s.product_id) AND s.work_id=NEW.work_id)
    ) AND (s.partner_id<>a.partner_id OR (a.product_id IS NOT NULL AND (s.product_id IS NULL OR s.product_id<>a.product_id)))
  ) THEN RAISE(ABORT,'sales report lines do not match agreement partner or product') END;
END;

CREATE TRIGGER sales_term_immutable BEFORE UPDATE ON sales_agreement_term_versions BEGIN SELECT RAISE(ABORT,'sales agreement terms are immutable'); END;

CREATE TRIGGER sales_term_no_delete BEFORE DELETE ON sales_agreement_term_versions BEGIN SELECT RAISE(ABORT,'sales agreement terms are immutable'); END;

CREATE TRIGGER scene_scope_locked_by_field BEFORE UPDATE OF org_id,project_id,work_id ON scenes
WHEN (NEW.org_id<>OLD.org_id OR NEW.project_id<>OLD.project_id OR NEW.work_id<>OLD.work_id)
  AND (EXISTS(SELECT 1 FROM day_scene_assignments a WHERE a.org_id=OLD.org_id AND a.scene_id=OLD.id)
    OR EXISTS(SELECT 1 FROM prep_tasks t WHERE t.org_id=OLD.org_id AND t.scene_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'scene scope is referenced by field operations'); END;

CREATE TRIGGER settlement_contract_core_immutable BEFORE UPDATE OF project_id,work_id,contract_type,holder_partner_id,mg_contract_yen,mg_paid_yen ON settlement_contracts BEGIN
  SELECT RAISE(ABORT,'settlement contract financial core is immutable');
END;

CREATE TRIGGER settlement_report_basis_consistent BEFORE INSERT ON settlement_report_links BEGIN
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM settlement_report_links l WHERE l.org_id=NEW.org_id AND l.report_id=NEW.report_id AND l.report_basis<>NEW.report_basis
  ) THEN RAISE(ABORT,'report basis must be consistent across works') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.status='active'
  ) THEN RAISE(ABORT,'settlement report must be active') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM sale_lines s
    WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND (
      (EXISTS(SELECT 1 FROM product_works any_pw WHERE any_pw.org_id=s.org_id AND any_pw.product_id=s.product_id)
        AND EXISTS(SELECT 1 FROM product_works target_pw WHERE target_pw.org_id=s.org_id AND target_pw.product_id=s.product_id AND target_pw.work_id=NEW.work_id))
      OR (NOT EXISTS(SELECT 1 FROM product_works any_pw WHERE any_pw.org_id=s.org_id AND any_pw.product_id=s.product_id) AND s.work_id=NEW.work_id)
    )
  ) THEN RAISE(ABORT,'report has no allocation for work') END;
END;

CREATE TRIGGER settlement_report_no_committee BEFORE INSERT ON settlement_report_links BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM committee_snapshot_reports r WHERE r.org_id=NEW.org_id AND r.work_id=NEW.work_id AND r.report_id=NEW.report_id) THEN RAISE(ABORT,'report already used by committee snapshot') END;
END;

CREATE TRIGGER settlement_terms_immutable_delete BEFORE DELETE ON settlement_term_versions BEGIN
  SELECT RAISE(ABORT,'settlement term versions are immutable');
END;

CREATE TRIGGER settlement_terms_immutable_update BEFORE UPDATE ON settlement_term_versions BEGIN
  SELECT RAISE(ABORT,'settlement term versions are immutable');
END;

CREATE TRIGGER settlement_terms_validate BEFORE INSERT ON settlement_term_versions BEGIN
  SELECT CASE
    WHEN NOT EXISTS(SELECT 1 FROM settlement_contracts c WHERE c.org_id=NEW.org_id AND c.id=NEW.contract_id) THEN RAISE(ABORT,'settlement contract scope mismatch')
    WHEN (SELECT contract_type FROM settlement_contracts WHERE org_id=NEW.org_id AND id=NEW.contract_id)='commission'
      AND (NEW.agency_fee_bps IS NULL OR NEW.recoup_basis IS NOT NULL OR NEW.overage_enabled IS NOT NULL) THEN RAISE(ABORT,'invalid commission terms')
    WHEN (SELECT contract_type FROM settlement_contracts WHERE org_id=NEW.org_id AND id=NEW.contract_id)='mg'
      AND (NEW.agency_fee_bps IS NULL OR NEW.recoup_basis IS NULL) THEN RAISE(ABORT,'invalid mg terms')
    WHEN (SELECT contract_type FROM settlement_contracts WHERE org_id=NEW.org_id AND id=NEW.contract_id)='self_owned'
      AND (NEW.agency_fee_bps IS NOT NULL OR NEW.recoup_basis IS NOT NULL OR NEW.overage_enabled IS NOT NULL) THEN RAISE(ABORT,'invalid self owned terms')
  END;
END;

CREATE TRIGGER shooting_day_scope_immutable BEFORE UPDATE OF org_id,project_id,work_id ON shooting_days
WHEN (NEW.org_id<>OLD.org_id OR NEW.project_id<>OLD.project_id OR NEW.work_id<>OLD.work_id)
  AND (EXISTS(SELECT 1 FROM day_scene_assignments a WHERE a.org_id=OLD.org_id AND a.shooting_day_id=OLD.id)
    OR EXISTS(SELECT 1 FROM prep_tasks t WHERE t.org_id=OLD.org_id AND t.shooting_day_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'shooting day scope is referenced'); END;

CREATE TRIGGER tax_line_immutable BEFORE UPDATE ON tax_calculation_lines BEGIN SELECT RAISE(ABORT,'tax calculation lines are immutable'); END;

CREATE TRIGGER tax_line_no_delete BEFORE DELETE ON tax_calculation_lines BEGIN SELECT RAISE(ABORT,'tax calculation lines are immutable'); END;

CREATE TRIGGER tax_link_immutable BEFORE UPDATE ON tax_invoice_links BEGIN SELECT RAISE(ABORT,'tax invoice links are immutable'); END;

CREATE TRIGGER tax_link_no_delete BEFORE DELETE ON tax_invoice_links BEGIN SELECT RAISE(ABORT,'tax invoice links are immutable'); END;

CREATE TRIGGER tax_rule_immutable BEFORE UPDATE ON tax_rule_versions BEGIN SELECT RAISE(ABORT,'tax rule versions are immutable'); END;

CREATE TRIGGER tax_rule_no_delete BEFORE DELETE ON tax_rule_versions BEGIN SELECT RAISE(ABORT,'tax rule versions are immutable'); END;

CREATE TRIGGER tax_snapshot_immutable BEFORE UPDATE ON tax_calculation_snapshots BEGIN SELECT RAISE(ABORT,'tax calculation snapshots are immutable'); END;

CREATE TRIGGER tax_snapshot_no_delete BEFORE DELETE ON tax_calculation_snapshots BEGIN SELECT RAISE(ABORT,'tax calculation snapshots are immutable'); END;

CREATE TRIGGER tax_total_immutable BEFORE UPDATE ON tax_invoice_rate_totals BEGIN SELECT RAISE(ABORT,'tax rate totals are immutable'); END;

CREATE TRIGGER tax_total_no_delete BEFORE DELETE ON tax_invoice_rate_totals BEGIN SELECT RAISE(ABORT,'tax rate totals are immutable'); END;

CREATE TRIGGER theatrical_detail_immutable_delete BEFORE DELETE ON theatrical_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;

CREATE TRIGGER theatrical_detail_immutable_update BEFORE UPDATE ON theatrical_sale_details BEGIN SELECT RAISE(ABORT,'channel detail is immutable'); END;

CREATE TRIGGER theatrical_detail_scope BEFORE INSERT ON theatrical_sale_details BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND r.kind='theatrical'
  ) THEN RAISE(ABORT,'theatrical detail requires theatrical report sale') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id=NEW.org_id AND d.sale_id=NEW.sale_id)
    THEN RAISE(ABORT,'sale already has another channel detail') END;
END;

CREATE TRIGGER theatrical_detail_sealed BEFORE INSERT ON theatrical_sale_details
WHEN EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id=s.org_id AND f.report_id=s.report_id WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id)
BEGIN SELECT RAISE(ABORT,'report channel facts are sealed'); END;

CREATE TRIGGER workbench_recipe_version_immutable_delete BEFORE DELETE ON workbench_recipe_versions BEGIN SELECT RAISE(ABORT,'workbench recipe versions are immutable'); END;

CREATE TRIGGER workbench_recipe_version_immutable_update BEFORE UPDATE ON workbench_recipe_versions BEGIN SELECT RAISE(ABORT,'workbench recipe versions are immutable'); END;

CREATE TRIGGER workbench_snapshot_immutable_delete BEFORE DELETE ON workbench_snapshots BEGIN SELECT RAISE(ABORT,'workbench snapshots are immutable'); END;

CREATE TRIGGER workbench_snapshot_immutable_update BEFORE UPDATE ON workbench_snapshots BEGIN SELECT RAISE(ABORT,'workbench snapshots are immutable'); END;

CREATE TRIGGER workbench_source_artifact_immutable_delete BEFORE DELETE ON workbench_source_artifacts BEGIN SELECT RAISE(ABORT,'workbench source artifacts are immutable'); END;

CREATE TRIGGER workbench_source_artifact_immutable_update BEFORE UPDATE ON workbench_source_artifacts BEGIN SELECT RAISE(ABORT,'workbench source artifacts are immutable'); END;

CREATE TRIGGER workbench_validation_immutable_delete BEFORE DELETE ON workbench_validations BEGIN SELECT RAISE(ABORT,'workbench validations are immutable'); END;

CREATE TRIGGER workbench_validation_immutable_update BEFORE UPDATE ON workbench_validations BEGIN SELECT RAISE(ABORT,'workbench validations are immutable'); END;

CREATE TRIGGER workflow_raw_artifacts_immutable BEFORE UPDATE ON workflow_raw_artifacts BEGIN SELECT RAISE(ABORT,'workflow raw artifacts are immutable'); END;

CREATE TRIGGER workflow_raw_artifacts_no_delete BEFORE DELETE ON workflow_raw_artifacts BEGIN SELECT RAISE(ABORT,'workflow raw artifacts cannot be deleted'); END;

CREATE TRIGGER workflow_report_commits_immutable BEFORE UPDATE ON workflow_report_commits BEGIN SELECT RAISE(ABORT,'workflow report commits are immutable'); END;

CREATE TRIGGER workflow_report_commits_no_delete BEFORE DELETE ON workflow_report_commits BEGIN SELECT RAISE(ABORT,'workflow report commits cannot be deleted'); END;

CREATE TRIGGER workflow_report_selections_immutable BEFORE UPDATE ON workflow_report_selections BEGIN SELECT RAISE(ABORT,'workflow report selections are immutable'); END;

CREATE TRIGGER workflow_report_selections_no_delete BEFORE DELETE ON workflow_report_selections BEGIN SELECT RAISE(ABORT,'workflow report selections cannot be deleted'); END;

CREATE TRIGGER workflow_script_commit_link_days AFTER INSERT ON workflow_script_commits BEGIN
  INSERT INTO workflow_script_commit_days(org_id,commit_id,work_id,shooting_day_id,proposal_index)
  SELECT NEW.org_id,NEW.id,NEW.work_id,d.id,CAST(j.key AS INTEGER)
  FROM workflow_schedule_previews p,json_each(p.proposal_json,'$.days') j
  JOIN shooting_days d ON d.org_id=p.org_id AND d.work_id=p.work_id AND d.shoot_date=json_extract(j.value,'$.date')
    AND d.unit=json_extract(p.input_json,'$.unit')
  WHERE p.org_id=NEW.org_id AND p.token=NEW.preview_token;
END;

CREATE TRIGGER workflow_script_commit_link_scenes AFTER INSERT ON workflow_script_commits BEGIN
  INSERT INTO workflow_script_commit_scenes(org_id,commit_id,work_id,scene_id,source_index)
  SELECT NEW.org_id,NEW.id,NEW.work_id,s.id,CAST(j.key AS INTEGER)
  FROM workflow_script_reviews r,json_each(r.scenes_json) j
  JOIN scenes s ON s.org_id=r.org_id AND s.work_id=r.work_id AND s.scene_no=json_extract(j.value,'$.sceneNo')
  WHERE r.org_id=NEW.org_id AND r.id=NEW.review_id;
END;

CREATE TRIGGER workflow_script_reviews_immutable BEFORE UPDATE ON workflow_script_reviews BEGIN SELECT RAISE(ABORT,'workflow script reviews are immutable'); END;

CREATE TRIGGER workflow_script_reviews_no_delete BEFORE DELETE ON workflow_script_reviews BEGIN SELECT RAISE(ABORT,'workflow script reviews cannot be deleted'); END;

INSERT INTO "recognition_bases" ("id","code","name","source_field") VALUES (1,'sales_month','販売月','sales_month');

INSERT INTO "recognition_bases" ("id","code","name","source_field") VALUES (2,'report_received_month','報告受領月','report_received_on');

INSERT INTO "recognition_bases" ("id","code","name","source_field") VALUES (3,'contract_start_month','契約開始月','contract_start_on');

INSERT INTO "recognition_bases" ("id","code","name","source_field") VALUES (4,'license_start_month','ライセンス利用開始月','license_start_on');

INSERT INTO "recognition_bases" ("id","code","name","source_field") VALUES (5,'broadcast_month','放送月','broadcast_on');

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('A001','unverified','A001',NULL,128);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('A002','unverified','A002',NULL,129);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('A003','unverified','A003',NULL,130);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('B001','unverified','B001',NULL,126);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('B002','unverified','B002',NULL,127);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('D001','unverified','D001',NULL,118);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('D002','unverified','D002',NULL,119);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('D003','unverified','D003',NULL,120);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('D004','unverified','D004',NULL,121);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('D005','unverified','D005',NULL,122);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('D006','unverified','D006',NULL,123);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('E001','unverified','E001',NULL,135);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('F001','unverified','F001',NULL,138);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('G001','unverified','G001',NULL,131);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('H001','unverified','H001',NULL,100);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('H002','unverified','H002',NULL,101);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('H003','unverified','H003',NULL,102);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('H004','unverified','H004',NULL,103);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('H005','unverified','H005',NULL,104);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('K001','unverified','K001',NULL,134);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('O001','unverified','O001',NULL,136);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('O002','unverified','O002',NULL,137);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('P001','unverified','P001',NULL,132);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('P002','unverified','P002',NULL,133);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('R001','unverified','R001',NULL,112);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('R002','unverified','R002',NULL,113);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('R003','unverified','R003',NULL,114);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('R004','unverified','R004',NULL,115);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('R005','unverified','R005',NULL,116);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('R006','unverified','R006',NULL,117);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('S001','unverified','S001',NULL,105);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('S002','unverified','S002',NULL,106);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('S003','unverified','S003',NULL,107);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('S004','unverified','S004',NULL,108);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('S005','unverified','S005',NULL,109);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('S006','unverified','S006',NULL,110);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('S007','unverified','S007',NULL,111);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('V001','unverified','V001',NULL,124);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('V002','unverified','V002',NULL,125);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('avod','digital','配信・AVOD','AVOD',33);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('broadcast_bs','broadcast','放送・BS',NULL,41);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('broadcast_cable','broadcast','放送・CATV',NULL,43);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('broadcast_cs','broadcast','放送・CS',NULL,42);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('broadcast_free','broadcast','放送・地上波',NULL,40);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('broadcast_unknown','broadcast','放送・区分未確認',NULL,49);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('digital_unknown','digital','配信・区分未確認',NULL,39);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('est','digital','配信・EST','EST',30);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('other','other','その他・未確認',NULL,90);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('package_rental','package','ビデオグラム・レンタル','rental',20);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('package_sell','package','ビデオグラム・セル','sell',21);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('package_unknown','package','ビデオグラム・区分未確認',NULL,29);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('svod','digital','配信・SVOD','SVOD',32);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('theatrical','theatrical','劇場配給',NULL,10);

INSERT INTO "distribution_types" ("code","family","label","utilization","sort_order") VALUES ('tvod','digital','配信・TVOD','TVOD',31);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('A001','海外','FLAT','海外_FLAT','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',30);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('A002','海外','RS','海外_RS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',31);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('A003','海外','MG','クロスリクープ_RS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',32);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('B001','放送','FLAT','放送_FLAT','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',28);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('B002','放送','RS','放送_RS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',29);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('D001','配信','MG','配信_MG','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',20);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('D002','配信','FLAT','配信_FLAT','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',21);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('D003','配信','RS','EST','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',22);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('D004','配信','RS','TVOD','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',23);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('D005','配信','RS','SVOD','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',24);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('D006','配信','RS','AVOD','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',25);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('E001','映像、画像使用','FLAT','映像使用_FLAT','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',37);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('F001','調整','調整','','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',40);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('G001','グッズ','RS','グッズ_RS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',33);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('H001','配給','RS','劇場_RS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',2);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('H002','配給','FLAT','劇場_FLAT','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',3);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('H003','配給','RS','非劇場_RS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',4);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('H004','配給','FLAT','非劇場_FLAT','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',5);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('H005','配給_物販','RS','配給_物販','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',6);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('K001','相殺','FLAT','相殺_FLAT','代引き、印紙代、振込手数料、システム使用料','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',36);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('O001','稿料','FLAT','稿料_FLAT','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',38);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('O002','稿料','RS','稿料_RS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',39);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('P001','製作委員会収入','幹事','製作委員会収入_幹事分_バンドル','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',34);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('P002','製作委員会収入','分配','製作委員会収入_分配分_バンドル','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',35);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('R001','レンタル_RSS','LF','レンタル_RSS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',14);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('R002','レンタル_RSS','MG','レンタル_RSS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',15);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('R003','レンタル','有償','レンタル_有償','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',16);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('R004','レンタル_RSS','RS','レンタル_RSS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',17);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('R005','レンタル','無償','レンタル_無償','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',18);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('R006','レンタル','返品','レンタル_返品','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',19);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('S001','セル','委託','セル_委託','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',7);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('S002','セル','委託返品','セル_委託返品','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',8);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('S003','セル','消化納品','セル_消化納品','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',9);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('S004','セル','消化売上','セル_消化売上','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',10);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('S005','セル','消化返品','セル_消化返品','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',11);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('S006','セル','買切','セル_買切','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',12);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('S007','セル','無償','セル_無償','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',13);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('V001','業務用VOD','FLAT','業務用VOD_FLAT','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',26);

INSERT INTO "distribution_master" ("code","distribution_name","transaction_method","sales_type","notes","source_sha256","source_row") VALUES ('V002','業務用VOD','RS','業務用VOD_RS','','204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5',27);
