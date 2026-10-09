PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  org_id INTEGER PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0)
);
CREATE TABLE IF NOT EXISTS transaction_guards (value INTEGER NOT NULL CHECK(value=1));

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE CHECK(email=lower(email)), display_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  org_id INTEGER NOT NULL REFERENCES organizations(id), user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('admin','editor','production')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  expires_at TEXT,
  PRIMARY KEY(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), email TEXT NOT NULL CHECK(email=lower(email)),
  project_id INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','production')), expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,email,project_id,status), FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), org_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), code TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','complete','paused')),
  budget_yen INTEGER CHECK(budget_yen IS NULL OR budget_yen>=0), version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id), UNIQUE(org_id,code)
);
CREATE TABLE IF NOT EXISTS project_memberships (
  org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('edit','production')),
  expires_at TEXT,
  PRIMARY KEY(org_id,project_id,user_id),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'film', forecast_yen INTEGER CHECK(forecast_yen IS NULL OR forecast_yen>=0), version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id), UNIQUE(org_id,project_id,id), UNIQUE(org_id,code),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
);
CREATE TABLE IF NOT EXISTS import_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), sku TEXT NOT NULL, name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('theatrical','digital','package','broadcast','license','other')), version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id), UNIQUE(org_id,sku)
);
CREATE TABLE IF NOT EXISTS product_works (
  org_id INTEGER NOT NULL, product_id INTEGER NOT NULL, work_id INTEGER NOT NULL, allocation_bps INTEGER NOT NULL CHECK(allocation_bps BETWEEN 1 AND 10000),
  PRIMARY KEY(org_id,product_id,work_id), FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);
CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), code TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK(kind IN ('cinema','platform','retailer','agency','vendor','other')), region TEXT,
  version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id), UNIQUE(org_id,code)
);
CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  scene_no TEXT NOT NULL, day_night TEXT CHECK(day_night IS NULL OR day_night IN ('D','N','DN')), location TEXT,
  synopsis TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','shot')),
  version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id), UNIQUE(org_id,project_id,work_id,scene_no),
  FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id), FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS sales_opportunities (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  name TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('lead','proposal','negotiation','won','lost')), expected_yen INTEGER CHECK(expected_yen IS NULL OR expected_yen>=0),
  close_date TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE IF NOT EXISTS recognition_bases (
  id INTEGER PRIMARY KEY CHECK(id IN (1,2,3,4,5)), code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, source_field TEXT NOT NULL UNIQUE,
  CHECK((id=1 AND code='sales_month' AND source_field='sales_month') OR
        (id=2 AND code='report_received_month' AND source_field='report_received_on') OR
        (id=3 AND code='contract_start_month' AND source_field='contract_start_on') OR
        (id=4 AND code='license_start_month' AND source_field='license_start_on') OR
        (id=5 AND code='broadcast_month' AND source_field='broadcast_on'))
);
INSERT OR IGNORE INTO recognition_bases(id,code,name,source_field) VALUES
  (1,'sales_month','販売月','sales_month'),
  (2,'report_received_month','報告受領月','report_received_on'),
  (3,'contract_start_month','契約開始月','contract_start_on'),
  (4,'license_start_month','ライセンス利用開始月','license_start_on'),
  (5,'broadcast_month','放送月','broadcast_on');

CREATE TABLE IF NOT EXISTS report_imports (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), work_id INTEGER NOT NULL, partner_id INTEGER,
  report_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other','publicity')), period_from TEXT NOT NULL, period_to TEXT NOT NULL,
  accounting_month TEXT NOT NULL CHECK(accounting_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), raw_text TEXT NOT NULL,
  content_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','void')),
  supersedes_id INTEGER REFERENCES report_imports(id), created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,report_key,content_hash), UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,supersedes_id) REFERENCES report_imports(org_id,id),
  CHECK(period_to>=period_from), CHECK(supersedes_id IS NULL OR supersedes_id<>id)
);
CREATE TABLE IF NOT EXISTS sale_lines (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  report_id INTEGER, product_id INTEGER, partner_id INTEGER NOT NULL, sales_period_from TEXT NOT NULL, sales_period_to TEXT NOT NULL,
  accounting_month TEXT NOT NULL CHECK(accounting_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), description TEXT NOT NULL,
  quantity INTEGER CHECK(quantity IS NULL OR quantity>=0), amount_ex_tax INTEGER NOT NULL, tax_amount INTEGER NOT NULL, amount_inc_tax INTEGER NOT NULL,
  source_row INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id),
  CHECK(amount_inc_tax=amount_ex_tax+tax_amount), CHECK(sales_period_to>=sales_period_from),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id), FOREIGN KEY(org_id,work_id,report_id) REFERENCES report_imports(org_id,work_id,id),
  FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sale_report_row_uidx ON sale_lines(org_id,report_id,source_row) WHERE report_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS report_active_key_uidx ON report_imports(org_id,work_id,report_key) WHERE status='active';
CREATE TABLE IF NOT EXISTS report_recognition (
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
CREATE TRIGGER IF NOT EXISTS report_recognition_month_insert BEFORE INSERT ON report_recognition BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.accounting_month=NEW.resolved_month)
    THEN RAISE(ABORT,'report recognition month mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND s.accounting_month<>NEW.resolved_month)
    THEN RAISE(ABORT,'sale recognition month mismatch') END;
  SELECT CASE WHEN NEW.recognition_basis_id=1 AND EXISTS(SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND (substr(s.sales_period_from,1,7)<>NEW.sales_month OR substr(s.sales_period_to,1,7)<>NEW.sales_month))
    THEN RAISE(ABORT,'sales recognition month requires single-month sale period') END;
END;
CREATE TRIGGER IF NOT EXISTS report_recognition_month_update BEFORE UPDATE ON report_recognition BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.accounting_month=NEW.resolved_month)
    THEN RAISE(ABORT,'report recognition month mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id AND s.accounting_month<>NEW.resolved_month)
    THEN RAISE(ABORT,'sale recognition month mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS report_recognition_immutable BEFORE UPDATE ON report_recognition BEGIN
  SELECT RAISE(ABORT,'report recognition metadata is immutable');
END;
CREATE TRIGGER IF NOT EXISTS report_recognition_report_update BEFORE UPDATE OF accounting_month ON report_imports WHEN EXISTS(SELECT 1 FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.id) BEGIN
  SELECT CASE WHEN NEW.accounting_month<>(SELECT resolved_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.id) THEN RAISE(ABORT,'report recognition month mismatch') END;
END;
DROP TRIGGER IF EXISTS report_recognition_sale_insert;
CREATE TRIGGER report_recognition_sale_insert BEFORE INSERT ON sale_lines WHEN NEW.report_id IS NOT NULL AND EXISTS(SELECT 1 FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id) BEGIN
  SELECT CASE WHEN NEW.accounting_month<>(SELECT resolved_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id) THEN RAISE(ABORT,'sale recognition month mismatch') END;
  SELECT CASE WHEN (SELECT recognition_basis_id FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id)=1
    AND (substr(NEW.sales_period_from,1,7)<>(SELECT sales_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id)
      OR substr(NEW.sales_period_to,1,7)<>(SELECT sales_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id))
    THEN RAISE(ABORT,'sales recognition month requires single-month sale period') END;
END;
DROP TRIGGER IF EXISTS report_recognition_sale_update;
CREATE TRIGGER report_recognition_sale_update BEFORE UPDATE OF accounting_month,report_id,sales_period_from,sales_period_to ON sale_lines WHEN NEW.report_id IS NOT NULL AND EXISTS(SELECT 1 FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id) BEGIN
  SELECT CASE WHEN NEW.accounting_month<>(SELECT resolved_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id) THEN RAISE(ABORT,'sale recognition month mismatch') END;
  SELECT CASE WHEN (SELECT recognition_basis_id FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id)=1
    AND (substr(NEW.sales_period_from,1,7)<>(SELECT sales_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id)
      OR substr(NEW.sales_period_to,1,7)<>(SELECT sales_month FROM report_recognition rr WHERE rr.org_id=NEW.org_id AND rr.report_id=NEW.report_id))
    THEN RAISE(ABORT,'sales recognition month requires single-month sale period') END;
END;
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER,
  partner_id INTEGER, incurred_on TEXT NOT NULL, accounting_month TEXT NOT NULL CHECK(accounting_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  category TEXT NOT NULL, description TEXT NOT NULL, budget_yen INTEGER CHECK(budget_yen IS NULL OR budget_yen>=0),
  actual_ex_tax INTEGER NOT NULL, tax_amount INTEGER NOT NULL, actual_inc_tax INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CHECK(actual_inc_tax=actual_ex_tax+tax_amount), UNIQUE(org_id,id), FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);

CREATE TABLE IF NOT EXISTS settlement_contracts (
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
CREATE TABLE IF NOT EXISTS settlement_term_versions (
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
CREATE TABLE IF NOT EXISTS settlement_report_links (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, work_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL,
  report_basis TEXT NOT NULL CHECK(report_basis IN ('gross','net')), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,report_id,work_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
  FOREIGN KEY(org_id,contract_id,work_id) REFERENCES settlement_contracts(org_id,id,work_id),
  FOREIGN KEY(org_id,contract_id,term_version_id) REFERENCES settlement_term_versions(org_id,contract_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS settlement_terms_validate BEFORE INSERT ON settlement_term_versions BEGIN
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
CREATE TRIGGER IF NOT EXISTS settlement_terms_immutable_update BEFORE UPDATE ON settlement_term_versions BEGIN
  SELECT RAISE(ABORT,'settlement term versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS settlement_terms_immutable_delete BEFORE DELETE ON settlement_term_versions BEGIN
  SELECT RAISE(ABORT,'settlement term versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS settlement_contract_core_immutable BEFORE UPDATE OF project_id,work_id,contract_type,holder_partner_id,mg_contract_yen,mg_paid_yen ON settlement_contracts BEGIN
  SELECT RAISE(ABORT,'settlement contract financial core is immutable');
END;
CREATE TRIGGER IF NOT EXISTS settlement_report_basis_consistent BEFORE INSERT ON settlement_report_links BEGIN
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

CREATE TABLE IF NOT EXISTS rights_intake_cases (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  case_code TEXT NOT NULL, title TEXT NOT NULL, intake_type TEXT NOT NULL CHECK(intake_type IN ('committee','sole_owned','entrusted')),
  source_case_id INTEGER, snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK(snapshot_version>0), status TEXT NOT NULL DEFAULT 'draft' CHECK(status='draft'),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,id,work_id), UNIQUE(org_id,case_code),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,source_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS rights_intake_documents (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, intake_case_id INTEGER NOT NULL,
  title TEXT, reference TEXT, version_label TEXT, content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id),
  FOREIGN KEY(org_id,intake_case_id) REFERENCES rights_intake_cases(org_id,id)
);
CREATE TABLE IF NOT EXISTS rights_intake_scopes (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, intake_case_id INTEGER NOT NULL,
  channel TEXT, territory TEXT, rights_start TEXT, rights_end TEXT,
  exclusivity TEXT CHECK(exclusivity IS NULL OR exclusivity IN ('exclusive','nonexclusive','unknown')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id),
  CHECK(rights_end IS NULL OR rights_start IS NULL OR rights_end>=rights_start),
  FOREIGN KEY(org_id,intake_case_id) REFERENCES rights_intake_cases(org_id,id)
);
CREATE TABLE IF NOT EXISTS rights_intake_participants (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, intake_case_id INTEGER NOT NULL,
  party_kind TEXT NOT NULL CHECK(party_kind IN ('current_org','partner')), partner_id INTEGER, role TEXT,
  investment_yen INTEGER CHECK(investment_yen IS NULL OR investment_yen>=0),
  explicit_share_bps INTEGER CHECK(explicit_share_bps IS NULL OR explicit_share_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id),
  CHECK((party_kind='current_org' AND partner_id IS NULL) OR party_kind='partner'),
  FOREIGN KEY(org_id,intake_case_id) REFERENCES rights_intake_cases(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);
CREATE TABLE IF NOT EXISTS intake_settlement_links (
  org_id INTEGER NOT NULL, intake_case_id INTEGER NOT NULL, work_id INTEGER NOT NULL, settlement_contract_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,intake_case_id,settlement_contract_id), UNIQUE(org_id,settlement_contract_id),
  FOREIGN KEY(org_id,intake_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
  FOREIGN KEY(org_id,settlement_contract_id,work_id) REFERENCES settlement_contracts(org_id,id,work_id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS rights_intake_case_immutable BEFORE UPDATE ON rights_intake_cases BEGIN SELECT RAISE(ABORT,'rights intake snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS rights_intake_document_immutable BEFORE UPDATE ON rights_intake_documents BEGIN SELECT RAISE(ABORT,'rights intake snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS rights_intake_scope_immutable BEFORE UPDATE ON rights_intake_scopes BEGIN SELECT RAISE(ABORT,'rights intake snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS rights_intake_participant_immutable BEFORE UPDATE ON rights_intake_participants BEGIN SELECT RAISE(ABORT,'rights intake snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS rights_intake_link_immutable BEFORE UPDATE ON intake_settlement_links BEGIN SELECT RAISE(ABORT,'rights intake settlement links are immutable'); END;

CREATE TABLE IF NOT EXISTS report_mapping_profiles (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other')), name TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,partner_id,kind,name),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS report_mapping_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, profile_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK(version_no>0), definition_json TEXT NOT NULL, definition_hash TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,profile_id,id), UNIQUE(org_id,profile_id,version_no),
  FOREIGN KEY(org_id,profile_id) REFERENCES report_mapping_profiles(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS mapping_import_provenance (
  org_id INTEGER NOT NULL, report_id INTEGER NOT NULL, work_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other')), mapping_version_id INTEGER NOT NULL,
  original_text TEXT NOT NULL, original_hash TEXT NOT NULL, canonical_text TEXT NOT NULL, canonical_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,report_id), UNIQUE(org_id,work_id,partner_id,kind,original_hash),
  FOREIGN KEY(org_id,work_id,report_id) REFERENCES report_imports(org_id,work_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,mapping_version_id) REFERENCES report_mapping_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS report_mapping_profile_immutable BEFORE UPDATE ON report_mapping_profiles BEGIN SELECT RAISE(ABORT,'mapping profiles are immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_mapping_version_immutable BEFORE UPDATE ON report_mapping_versions BEGIN SELECT RAISE(ABORT,'mapping versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS mapping_provenance_immutable BEFORE UPDATE ON mapping_import_provenance BEGIN SELECT RAISE(ABORT,'mapping provenance is immutable'); END;

CREATE UNIQUE INDEX IF NOT EXISTS rights_intake_documents_case_uidx ON rights_intake_documents(org_id,intake_case_id,id);

CREATE TABLE IF NOT EXISTS committee_contracts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  intake_case_id INTEGER NOT NULL, document_id INTEGER NOT NULL, contract_code TEXT NOT NULL, title TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,id,work_id), UNIQUE(org_id,contract_code),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,intake_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
  FOREIGN KEY(org_id,intake_case_id,document_id) REFERENCES rights_intake_documents(org_id,intake_case_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS committee_term_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  source_version_id INTEGER, manager_partner_id INTEGER, calculation_version TEXT NOT NULL,
  note TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,contract_id,id), UNIQUE(org_id,contract_id,version_no),
  FOREIGN KEY(org_id,contract_id) REFERENCES committee_contracts(org_id,id),
  FOREIGN KEY(org_id,contract_id,source_version_id) REFERENCES committee_term_versions(org_id,contract_id,id),
  FOREIGN KEY(org_id,manager_partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS committee_term_members (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  role TEXT, share_bps INTEGER NOT NULL CHECK(share_bps BETWEEN 0 AND 10000), member_order INTEGER NOT NULL CHECK(member_order>0),
  UNIQUE(org_id,id), UNIQUE(org_id,term_version_id,partner_id), UNIQUE(org_id,term_version_id,member_order),
  FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);
CREATE TABLE IF NOT EXISTS committee_term_windows (
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
CREATE TABLE IF NOT EXISTS committee_schedule_phases (
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
CREATE TABLE IF NOT EXISTS committee_report_snapshots (
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
CREATE TABLE IF NOT EXISTS committee_report_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS committee_snapshot_reports (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, work_id INTEGER NOT NULL, report_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  report_basis TEXT NOT NULL CHECK(report_basis IN ('gross','net')),
  PRIMARY KEY(org_id,snapshot_id,report_id), UNIQUE(org_id,work_id,report_id),
  FOREIGN KEY(org_id,snapshot_id,work_id) REFERENCES committee_report_snapshots(org_id,id,work_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id)
);
CREATE TABLE IF NOT EXISTS committee_snapshot_expenses (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, work_id INTEGER NOT NULL, expense_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  amount_ex_tax INTEGER NOT NULL, PRIMARY KEY(org_id,snapshot_id,expense_id), UNIQUE(org_id,expense_id),
  FOREIGN KEY(org_id,snapshot_id,work_id) REFERENCES committee_report_snapshots(org_id,id,work_id),
  FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id)
);
CREATE TABLE IF NOT EXISTS committee_snapshot_lines (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, work_id INTEGER NOT NULL, report_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
  window_id INTEGER NOT NULL, source_row INTEGER, allocation_bps INTEGER NOT NULL, allocated_amount_ex_tax INTEGER NOT NULL,
  sales_period_from TEXT NOT NULL, sales_period_to TEXT NOT NULL, accounting_month TEXT NOT NULL,
  PRIMARY KEY(org_id,snapshot_id,sale_id,work_id),
  FOREIGN KEY(org_id,snapshot_id,work_id) REFERENCES committee_report_snapshots(org_id,id,work_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id)
);
CREATE TABLE IF NOT EXISTS committee_snapshot_member_amounts (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, window_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  share_bps INTEGER NOT NULL, amount_yen INTEGER NOT NULL, route TEXT NOT NULL CHECK(route IN ('direct','via_manager')),
  window_fee_recipient INTEGER NOT NULL CHECK(window_fee_recipient IN (0,1)), manager_fee_recipient INTEGER NOT NULL CHECK(manager_fee_recipient IN (0,1)),
  PRIMARY KEY(org_id,snapshot_id,window_id,partner_id),
  FOREIGN KEY(org_id,snapshot_id) REFERENCES committee_report_snapshots(org_id,id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS committee_contract_immutable BEFORE UPDATE ON committee_contracts BEGIN SELECT RAISE(ABORT,'committee contract is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_immutable BEFORE UPDATE ON committee_term_versions BEGIN SELECT RAISE(ABORT,'committee terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_member_immutable BEFORE UPDATE ON committee_term_members BEGIN SELECT RAISE(ABORT,'committee terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_window_immutable BEFORE UPDATE ON committee_term_windows BEGIN SELECT RAISE(ABORT,'committee terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_phase_immutable BEFORE UPDATE ON committee_schedule_phases BEGIN SELECT RAISE(ABORT,'committee terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_immutable BEFORE UPDATE ON committee_report_snapshots BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_report_immutable BEFORE UPDATE ON committee_snapshot_reports BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_expense_immutable BEFORE UPDATE ON committee_snapshot_expenses BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_line_immutable BEFORE UPDATE ON committee_snapshot_lines BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_member_immutable BEFORE UPDATE ON committee_snapshot_member_amounts BEGIN SELECT RAISE(ABORT,'committee report snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_report_scope BEFORE INSERT ON committee_snapshot_reports BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id=s.org_id AND w.term_version_id=s.term_version_id WHERE s.org_id=NEW.org_id AND s.id=NEW.snapshot_id AND s.work_id=NEW.work_id AND w.id=NEW.window_id) THEN RAISE(ABORT,'committee report window scope mismatch') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM settlement_report_links r WHERE r.org_id=NEW.org_id AND r.work_id=NEW.work_id AND r.report_id=NEW.report_id) THEN RAISE(ABORT,'report already used by individual settlement') END;
END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_expense_scope BEFORE INSERT ON committee_snapshot_expenses BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id=s.org_id AND w.term_version_id=s.term_version_id JOIN expenses e ON e.org_id=s.org_id AND e.id=NEW.expense_id AND e.work_id=s.work_id WHERE s.org_id=NEW.org_id AND s.id=NEW.snapshot_id AND s.work_id=NEW.work_id AND w.id=NEW.window_id) THEN RAISE(ABORT,'committee expense scope mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_line_scope BEFORE INSERT ON committee_snapshot_lines BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id=s.org_id AND w.term_version_id=s.term_version_id JOIN sale_lines sl ON sl.org_id=s.org_id AND sl.id=NEW.sale_id AND sl.report_id=NEW.report_id WHERE s.org_id=NEW.org_id AND s.id=NEW.snapshot_id AND s.work_id=NEW.work_id AND w.id=NEW.window_id) THEN RAISE(ABORT,'committee sale line scope mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS committee_snapshot_member_scope BEFORE INSERT ON committee_snapshot_member_amounts BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id=s.org_id AND w.term_version_id=s.term_version_id WHERE s.org_id=NEW.org_id AND s.id=NEW.snapshot_id AND w.id=NEW.window_id) THEN RAISE(ABORT,'committee member window scope mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS settlement_report_no_committee BEFORE INSERT ON settlement_report_links BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM committee_snapshot_reports r WHERE r.org_id=NEW.org_id AND r.work_id=NEW.work_id AND r.report_id=NEW.report_id) THEN RAISE(ABORT,'report already used by committee snapshot') END;
END;

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  name TEXT NOT NULL, objective TEXT NOT NULL, audience_hypothesis TEXT, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
  target_region TEXT, target_channel TEXT, version INTEGER NOT NULL DEFAULT 1, CHECK(ends_on>=starts_on), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);
CREATE TABLE IF NOT EXISTS exposures (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, campaign_id INTEGER NOT NULL, medium TEXT NOT NULL, asset_version TEXT,
  scheduled_at TEXT, happened_at TEXT, source_url TEXT, region TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE(org_id,id),
  FOREIGN KEY(org_id,campaign_id) REFERENCES campaigns(org_id,id)
);
CREATE TABLE IF NOT EXISTS metric_definitions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), field_key TEXT NOT NULL,
  label TEXT NOT NULL, value_type TEXT NOT NULL CHECK(value_type IN ('integer','decimal','text','boolean')),
  unit TEXT, aggregation TEXT NOT NULL CHECK(aggregation IN ('sum','average','latest','none')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,field_key),
  CHECK(length(field_key) BETWEEN 1 AND 40 AND substr(field_key,1,1) GLOB '[a-z]' AND field_key NOT GLOB '*[^a-z0-9_]*')
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, exposure_id INTEGER NOT NULL, metric_definition_id INTEGER NOT NULL,
  report_id INTEGER, source_row INTEGER,
  period_from TEXT NOT NULL, period_to TEXT NOT NULL, granularity TEXT NOT NULL CHECK(granularity IN ('day','week','month','event','unknown')),
  value_number REAL, value_text TEXT, verification TEXT NOT NULL DEFAULT 'unverified' CHECK(verification IN ('verified','unverified')),
  acquired_at TEXT NOT NULL, paid_organic TEXT CHECK(paid_organic IS NULL OR paid_organic IN ('paid','organic','mixed','unknown')),
  source TEXT, region TEXT, CHECK(period_to>=period_from), CHECK(NOT(value_number IS NOT NULL AND value_text IS NOT NULL)), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,exposure_id) REFERENCES exposures(org_id,id), FOREIGN KEY(org_id,metric_definition_id) REFERENCES metric_definitions(org_id,id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS observation_report_row_uidx ON observations(org_id,report_id,source_row) WHERE report_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS change_proposals (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), requested_by INTEGER NOT NULL REFERENCES users(id),
  request_text TEXT NOT NULL, field_key TEXT NOT NULL, label TEXT NOT NULL, value_type TEXT NOT NULL,
  unit TEXT, aggregation TEXT NOT NULL, sample_header TEXT NOT NULL, meaning_reason TEXT NOT NULL, affected_apps_json TEXT NOT NULL,
  base_schema_version INTEGER NOT NULL, proposal_hash TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('offline-rule','ai-json','workers-ai','service')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','adopted','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, decided_by INTEGER REFERENCES users(id), UNIQUE(org_id,proposal_hash)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL, version_hash TEXT, detail_json TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS ai_usage (
  org_id INTEGER PRIMARY KEY REFERENCES organizations(id), calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0)
);

CREATE UNIQUE INDEX IF NOT EXISTS scenes_org_work_id_uidx ON scenes(org_id,work_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_org_scope_id_uidx ON sales_opportunities(org_id,project_id,work_id,partner_id,id);

CREATE TABLE IF NOT EXISTS shooting_days (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  shoot_date TEXT NOT NULL, unit TEXT NOT NULL, label TEXT NOT NULL, notes TEXT,
  version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,work_id,shoot_date,unit),
  CHECK(length(trim(unit)) BETWEEN 1 AND 80), CHECK(length(trim(label)) BETWEEN 1 AND 160),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS day_scene_assignments (
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
CREATE TABLE IF NOT EXISTS prep_tasks (
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
CREATE TRIGGER IF NOT EXISTS scene_scope_locked_by_field BEFORE UPDATE OF org_id,project_id,work_id ON scenes
WHEN (NEW.org_id<>OLD.org_id OR NEW.project_id<>OLD.project_id OR NEW.work_id<>OLD.work_id)
  AND (EXISTS(SELECT 1 FROM day_scene_assignments a WHERE a.org_id=OLD.org_id AND a.scene_id=OLD.id)
    OR EXISTS(SELECT 1 FROM prep_tasks t WHERE t.org_id=OLD.org_id AND t.scene_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'scene scope is referenced by field operations'); END;
CREATE TRIGGER IF NOT EXISTS shooting_day_scope_immutable BEFORE UPDATE OF org_id,project_id,work_id ON shooting_days
WHEN (NEW.org_id<>OLD.org_id OR NEW.project_id<>OLD.project_id OR NEW.work_id<>OLD.work_id)
  AND (EXISTS(SELECT 1 FROM day_scene_assignments a WHERE a.org_id=OLD.org_id AND a.shooting_day_id=OLD.id)
    OR EXISTS(SELECT 1 FROM prep_tasks t WHERE t.org_id=OLD.org_id AND t.shooting_day_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'shooting day scope is referenced'); END;

CREATE TABLE IF NOT EXISTS sales_activities (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  opportunity_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, occurred_on TEXT NOT NULL,
  activity_type TEXT NOT NULL CHECK(activity_type IN ('contact','proposal','negotiation','note')),
  summary TEXT NOT NULL, next_action TEXT, next_due_on TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id,partner_id,opportunity_id) REFERENCES sales_opportunities(org_id,project_id,work_id,partner_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS sales_agreements (
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
CREATE TABLE IF NOT EXISTS sales_agreement_term_versions (
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
CREATE TABLE IF NOT EXISTS sales_deliverables (
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
CREATE TABLE IF NOT EXISTS sales_report_links (
  org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
  agreement_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,work_id,report_id),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  FOREIGN KEY(org_id,agreement_id,work_id) REFERENCES sales_agreements(org_id,id,work_id),
  FOREIGN KEY(org_id,agreement_id,term_version_id) REFERENCES sales_agreement_term_versions(org_id,agreement_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS sales_activity_immutable BEFORE UPDATE ON sales_activities BEGIN SELECT RAISE(ABORT,'sales activities are append-only'); END;
CREATE TRIGGER IF NOT EXISTS sales_activity_no_delete BEFORE DELETE ON sales_activities BEGIN SELECT RAISE(ABORT,'sales activities are append-only'); END;
CREATE TRIGGER IF NOT EXISTS sales_term_immutable BEFORE UPDATE ON sales_agreement_term_versions BEGIN SELECT RAISE(ABORT,'sales agreement terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_term_no_delete BEFORE DELETE ON sales_agreement_term_versions BEGIN SELECT RAISE(ABORT,'sales agreement terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_agreement_scope_immutable BEFORE UPDATE OF org_id,project_id,work_id,opportunity_id,partner_id,product_id,intake_case_id,contract_code,title ON sales_agreements BEGIN SELECT RAISE(ABORT,'sales agreement scope is immutable'); END;
CREATE TRIGGER IF NOT EXISTS opportunity_scope_locked BEFORE UPDATE OF org_id,project_id,work_id,partner_id ON sales_opportunities
WHEN (NEW.org_id<>OLD.org_id OR NEW.project_id<>OLD.project_id OR NEW.work_id<>OLD.work_id OR NEW.partner_id<>OLD.partner_id)
  AND (EXISTS(SELECT 1 FROM sales_activities a WHERE a.org_id=OLD.org_id AND a.opportunity_id=OLD.id)
    OR EXISTS(SELECT 1 FROM sales_agreements a WHERE a.org_id=OLD.org_id AND a.opportunity_id=OLD.id))
BEGIN SELECT RAISE(ABORT,'opportunity scope is referenced'); END;
CREATE TRIGGER IF NOT EXISTS sales_report_link_immutable BEFORE UPDATE ON sales_report_links BEGIN SELECT RAISE(ABORT,'sales report links are immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_report_link_no_delete BEFORE DELETE ON sales_report_links BEGIN SELECT RAISE(ABORT,'sales report links are immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_report_link_validate BEFORE INSERT ON sales_report_links BEGIN
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

CREATE TABLE IF NOT EXISTS sales_material_snapshots (
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
CREATE TRIGGER IF NOT EXISTS sales_material_immutable BEFORE UPDATE ON sales_material_snapshots BEGIN SELECT RAISE(ABORT,'sales material snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_material_no_delete BEFORE DELETE ON sales_material_snapshots BEGIN SELECT RAISE(ABORT,'sales material snapshots are immutable'); END;
CREATE INDEX IF NOT EXISTS sales_material_work_idx ON sales_material_snapshots(org_id,work_id,created_at);

CREATE TABLE IF NOT EXISTS billing_invoice_sequences (
  org_id INTEGER NOT NULL, year_month TEXT NOT NULL, last_number INTEGER NOT NULL CHECK(last_number>0),
  PRIMARY KEY(org_id,year_month), FOREIGN KEY(org_id) REFERENCES organizations(id),
  CHECK(year_month GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]')
);
CREATE TABLE IF NOT EXISTS billing_invoices (
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
CREATE TABLE IF NOT EXISTS billing_invoice_lines (
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
CREATE TABLE IF NOT EXISTS billing_invoice_line_works (
  org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, work_id INTEGER NOT NULL, allocation_bps INTEGER NOT NULL,
  PRIMARY KEY(org_id,invoice_id,sale_id,work_id), CHECK(allocation_bps BETWEEN 1 AND 10000),
  FOREIGN KEY(org_id,invoice_id,sale_id) REFERENCES billing_invoice_lines(org_id,invoice_id,sale_id), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);
CREATE TABLE IF NOT EXISTS billing_sale_claims (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,sale_id), FOREIGN KEY(org_id,invoice_id,sale_id) REFERENCES billing_invoice_lines(org_id,invoice_id,sale_id)
);
CREATE TABLE IF NOT EXISTS billing_invoice_voids (
  org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, voided_on TEXT NOT NULL, reason TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,invoice_id), FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id), CHECK(length(trim(reason)) BETWEEN 1 AND 1000)
);
CREATE TABLE IF NOT EXISTS billing_receipts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, reference TEXT NOT NULL,
  received_on TEXT NOT NULL, amount_yen INTEGER NOT NULL CHECK(amount_yen>0), allocation_count INTEGER NOT NULL CHECK(allocation_count>0),
  note TEXT, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_by INTEGER NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,partner_id,reference), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id), CHECK(length(trim(reference)) BETWEEN 1 AND 160)
);
CREATE TABLE IF NOT EXISTS billing_receipt_allocations (
  org_id INTEGER NOT NULL, receipt_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, amount_yen INTEGER NOT NULL CHECK(amount_yen>0),
  PRIMARY KEY(org_id,receipt_id,invoice_id), FOREIGN KEY(org_id,receipt_id) REFERENCES billing_receipts(org_id,id),
  FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id)
);
CREATE TABLE IF NOT EXISTS billing_receipt_reversals (
  org_id INTEGER NOT NULL, receipt_id INTEGER NOT NULL, reversed_on TEXT NOT NULL, reason TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,receipt_id), FOREIGN KEY(org_id,receipt_id) REFERENCES billing_receipts(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id), CHECK(length(trim(reason)) BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS billing_invoice_partner_due_idx ON billing_invoices(org_id,partner_id,due_date);
CREATE INDEX IF NOT EXISTS billing_line_work_idx ON billing_invoice_line_works(org_id,work_id,invoice_id);
CREATE INDEX IF NOT EXISTS billing_claim_invoice_idx ON billing_sale_claims(org_id,invoice_id);
CREATE INDEX IF NOT EXISTS billing_receipt_invoice_idx ON billing_receipt_allocations(org_id,invoice_id,receipt_id);
CREATE TRIGGER IF NOT EXISTS billing_invoice_line_validate BEFORE INSERT ON billing_invoice_lines BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    JOIN billing_invoices i ON i.org_id=s.org_id AND i.id=NEW.invoice_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND s.report_id=NEW.report_id AND s.project_id=NEW.project_id AND s.work_id=NEW.work_id
      AND s.partner_id=NEW.partner_id AND s.partner_id=i.partner_id AND s.product_id IS NEW.product_id AND s.description=NEW.description
      AND s.accounting_month=NEW.accounting_month AND s.source_row IS NEW.source_row
      AND s.amount_ex_tax=NEW.amount_ex_tax AND s.tax_amount=NEW.tax_amount AND s.amount_inc_tax=NEW.amount_inc_tax AND r.status='active'
  ) THEN RAISE(ABORT,'invoice line must snapshot an active original sale exactly') END;
END;
CREATE TRIGGER IF NOT EXISTS billing_invoice_line_immutable BEFORE UPDATE ON billing_invoice_lines BEGIN SELECT RAISE(ABORT,'invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_invoice_line_no_delete BEFORE DELETE ON billing_invoice_lines BEGIN SELECT RAISE(ABORT,'invoice lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_line_work_immutable BEFORE UPDATE ON billing_invoice_line_works BEGIN SELECT RAISE(ABORT,'invoice allocation snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_line_work_no_delete BEFORE DELETE ON billing_invoice_line_works BEGIN SELECT RAISE(ABORT,'invoice allocation snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_line_work_validate BEFORE INSERT ON billing_invoice_line_works BEGIN
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
CREATE TRIGGER IF NOT EXISTS billing_claim_validate BEFORE INSERT ON billing_sale_claims BEGIN
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
CREATE TRIGGER IF NOT EXISTS billed_report_no_gross_settlement BEFORE INSERT ON settlement_report_links
WHEN NEW.report_basis='gross' AND EXISTS(SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id=s.org_id AND c.sale_id=s.id WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'billed report cannot become gross basis'); END;
CREATE TRIGGER IF NOT EXISTS billed_report_no_gross_committee BEFORE INSERT ON committee_snapshot_reports
WHEN NEW.report_basis='gross' AND EXISTS(SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id=s.org_id AND c.sale_id=s.id WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
BEGIN SELECT RAISE(ABORT,'billed report cannot become gross basis'); END;
CREATE TRIGGER IF NOT EXISTS billing_claim_update BEFORE UPDATE ON billing_sale_claims BEGIN SELECT RAISE(ABORT,'invoice claims cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS billing_claim_delete BEFORE DELETE ON billing_sale_claims WHEN NOT EXISTS(SELECT 1 FROM billing_invoices i WHERE i.org_id=OLD.org_id AND i.id=OLD.invoice_id AND i.status='void') BEGIN SELECT RAISE(ABORT,'active invoice claims cannot be released'); END;
CREATE TRIGGER IF NOT EXISTS billing_invoice_update BEFORE UPDATE ON billing_invoices BEGIN
  SELECT CASE WHEN NEW.org_id<>OLD.org_id OR NEW.invoice_number<>OLD.invoice_number OR NEW.partner_id<>OLD.partner_id OR NEW.invoice_date<>OLD.invoice_date OR NEW.due_date<>OLD.due_date OR NEW.source_amount_basis<>OLD.source_amount_basis OR NEW.amount_ex_tax<>OLD.amount_ex_tax OR NEW.tax_amount<>OLD.tax_amount OR NEW.amount_inc_tax<>OLD.amount_inc_tax OR NEW.note IS NOT OLD.note OR NEW.snapshot_json<>OLD.snapshot_json OR NEW.snapshot_hash<>OLD.snapshot_hash OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN RAISE(ABORT,'invoice snapshot is immutable') END;
  SELECT CASE WHEN OLD.status='void' OR NEW.status<>'void' OR NEW.version<>OLD.version+1 THEN RAISE(ABORT,'invoice can only transition once to void') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM billing_receipt_allocations a LEFT JOIN billing_receipt_reversals x ON x.org_id=a.org_id AND x.receipt_id=a.receipt_id WHERE a.org_id=OLD.org_id AND a.invoice_id=OLD.id AND x.receipt_id IS NULL) THEN RAISE(ABORT,'invoice with effective receipts cannot be voided') END;
END;
CREATE TRIGGER IF NOT EXISTS billing_invoice_no_delete BEFORE DELETE ON billing_invoices BEGIN SELECT RAISE(ABORT,'invoice snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_invoice_void_validate BEFORE INSERT ON billing_invoice_voids BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM billing_invoices i WHERE i.org_id=NEW.org_id AND i.id=NEW.invoice_id AND i.status='void' AND NEW.voided_on>=i.invoice_date) THEN RAISE(ABORT,'invoice void date or state is invalid') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM billing_receipt_allocations a
    LEFT JOIN billing_receipt_reversals x ON x.org_id=a.org_id AND x.receipt_id=a.receipt_id
    WHERE a.org_id=NEW.org_id AND a.invoice_id=NEW.invoice_id AND (x.receipt_id IS NULL OR x.reversed_on>NEW.voided_on)
  ) THEN RAISE(ABORT,'invoice has a receipt effective on the void date') END;
END;
CREATE TRIGGER IF NOT EXISTS billing_invoice_void_immutable BEFORE UPDATE ON billing_invoice_voids BEGIN SELECT RAISE(ABORT,'invoice void event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_invoice_void_no_delete BEFORE DELETE ON billing_invoice_voids BEGIN SELECT RAISE(ABORT,'invoice void event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_allocation_validate BEFORE INSERT ON billing_receipt_allocations BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM billing_receipts r JOIN billing_invoices i ON i.org_id=r.org_id AND i.id=NEW.invoice_id WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id AND i.partner_id=r.partner_id AND i.status='issued' AND i.invoice_date<=r.received_on) THEN RAISE(ABORT,'receipt allocation invoice scope mismatch') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM billing_receipt_allocations a WHERE a.org_id=NEW.org_id AND a.receipt_id=NEW.receipt_id)>=(SELECT allocation_count FROM billing_receipts r WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id) THEN RAISE(ABORT,'too many receipt allocations') END;
  SELECT CASE WHEN COALESCE((SELECT SUM(a.amount_yen) FROM billing_receipt_allocations a LEFT JOIN billing_receipt_reversals x ON x.org_id=a.org_id AND x.receipt_id=a.receipt_id AND x.reversed_on<=(SELECT received_on FROM billing_receipts WHERE org_id=NEW.org_id AND id=NEW.receipt_id) WHERE a.org_id=NEW.org_id AND a.invoice_id=NEW.invoice_id AND x.receipt_id IS NULL),0)+NEW.amount_yen>(SELECT amount_inc_tax FROM billing_invoices i WHERE i.org_id=NEW.org_id AND i.id=NEW.invoice_id) THEN RAISE(ABORT,'receipt exceeds invoice balance') END;
END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_allocation_complete AFTER INSERT ON billing_receipt_allocations WHEN (SELECT COUNT(*) FROM billing_receipt_allocations a WHERE a.org_id=NEW.org_id AND a.receipt_id=NEW.receipt_id)=(SELECT allocation_count FROM billing_receipts r WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id) BEGIN
  SELECT CASE WHEN (SELECT SUM(a.amount_yen) FROM billing_receipt_allocations a WHERE a.org_id=NEW.org_id AND a.receipt_id=NEW.receipt_id)<>(SELECT amount_yen FROM billing_receipts r WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id) THEN RAISE(ABORT,'receipt allocations must equal receipt amount') END;
END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_immutable BEFORE UPDATE ON billing_receipts BEGIN SELECT RAISE(ABORT,'receipt events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_no_delete BEFORE DELETE ON billing_receipts BEGIN SELECT RAISE(ABORT,'receipt events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_allocation_immutable BEFORE UPDATE ON billing_receipt_allocations BEGIN SELECT RAISE(ABORT,'receipt allocations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_allocation_no_delete BEFORE DELETE ON billing_receipt_allocations BEGIN SELECT RAISE(ABORT,'receipt allocations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_reversal_validate BEFORE INSERT ON billing_receipt_reversals BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM billing_receipts r WHERE r.org_id=NEW.org_id AND r.id=NEW.receipt_id AND NEW.reversed_on>=r.received_on) THEN RAISE(ABORT,'receipt reversal date is invalid') END;
END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_reversal_immutable BEFORE UPDATE ON billing_receipt_reversals BEGIN SELECT RAISE(ABORT,'receipt reversal event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_receipt_reversal_no_delete BEFORE DELETE ON billing_receipt_reversals BEGIN SELECT RAISE(ABORT,'receipt reversal event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS billed_sale_locked_update BEFORE UPDATE ON sale_lines WHEN EXISTS(SELECT 1 FROM billing_sale_claims c WHERE c.org_id=OLD.org_id AND c.sale_id=OLD.id) BEGIN SELECT RAISE(ABORT,'billed sale line is locked'); END;
CREATE TRIGGER IF NOT EXISTS billed_sale_locked_delete BEFORE DELETE ON sale_lines WHEN EXISTS(SELECT 1 FROM billing_sale_claims c WHERE c.org_id=OLD.org_id AND c.sale_id=OLD.id) BEGIN SELECT RAISE(ABORT,'billed sale line is locked'); END;
CREATE TRIGGER IF NOT EXISTS billed_report_locked_update BEFORE UPDATE ON report_imports WHEN EXISTS(SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id=s.org_id AND c.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id) BEGIN SELECT RAISE(ABORT,'report with billed sales is locked'); END;
CREATE TRIGGER IF NOT EXISTS billed_report_locked_delete BEFORE DELETE ON report_imports WHEN EXISTS(SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id=s.org_id AND c.sale_id=s.id WHERE s.org_id=OLD.org_id AND s.report_id=OLD.id) BEGIN SELECT RAISE(ABORT,'report with billed sales is locked'); END;

INSERT OR IGNORE INTO organizations(id,code,name) VALUES (1,'demo','オープニングナイト試作チーム'),(2,'other','別組織（境界検証）');
INSERT OR IGNORE INTO schema_meta(org_id,version) VALUES (1,1),(2,1);
INSERT OR IGNORE INTO users(id,email,display_name) VALUES
 (1,'admin@openingnight.invalid','管理者'),(2,'editor@openingnight.invalid','編集担当'),(3,'production@openingnight.invalid','制作担当'),(4,'outsider@other.invalid','別組織担当');
INSERT OR IGNORE INTO memberships(org_id,user_id,role) VALUES (1,1,'admin'),(1,2,'editor'),(1,3,'production'),(2,4,'admin');
INSERT OR IGNORE INTO projects(id,org_id,code,title,status,budget_yen) VALUES (1,1,'PRJ-DEMO','風のあとさき','active',12000000),(2,2,'PRJ-OTHER','別組織作品','active',9999999);
INSERT OR IGNORE INTO project_memberships(org_id,project_id,user_id,permission) VALUES (1,1,2,'edit'),(1,1,3,'production'),(2,2,4,'edit');
INSERT OR IGNORE INTO works(id,org_id,project_id,code,title,format,forecast_yen) VALUES (1,1,1,'WRK-DEMO','風のあとさき','film',18000000),(2,2,2,'WRK-OTHER','別組織作品','film',9999999);
INSERT OR IGNORE INTO partners(id,org_id,code,name,kind,region) VALUES
 (1,1,'PT-CINEMA','架空シネマ','cinema','関東'),(2,1,'PT-DIGITAL','架空配信','platform',NULL),(3,1,'PT-STORE','架空ストア','retailer','全国'),(4,2,'PT-OTHER','別組織取引先','other',NULL);
INSERT OR IGNORE INTO products(id,org_id,sku,name,channel) VALUES (1,1,'SKU-DIGI','デジタル視聴','digital'),(2,1,'SKU-PACK','パッケージ','package');
INSERT OR IGNORE INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES (1,1,1,10000),(1,2,1,10000);
INSERT OR IGNORE INTO metric_definitions(id,org_id,field_key,label,value_type,unit,aggregation) VALUES
 (1,1,'impressions','表示回数','integer','回','sum'),(2,1,'engagement_rate','反応率','decimal','%','none'),(3,1,'qualitative_note','定性メモ','text',NULL,'none');

CREATE TRIGGER IF NOT EXISTS report_supersede_scope BEFORE INSERT ON report_imports WHEN NEW.supersedes_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.supersedes_id AND r.work_id=NEW.work_id AND r.report_key=NEW.report_key)
    THEN RAISE(ABORT,'superseded report scope mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS observation_value_type_insert BEFORE INSERT ON observations BEGIN
  SELECT CASE
    WHEN (SELECT value_type FROM metric_definitions WHERE org_id=NEW.org_id AND id=NEW.metric_definition_id) IN ('integer','decimal','boolean') AND NEW.value_text IS NOT NULL THEN RAISE(ABORT,'numeric metric requires value_number')
    WHEN (SELECT value_type FROM metric_definitions WHERE org_id=NEW.org_id AND id=NEW.metric_definition_id)='text' AND NEW.value_number IS NOT NULL THEN RAISE(ABORT,'text metric requires value_text')
    WHEN (SELECT value_type FROM metric_definitions WHERE org_id=NEW.org_id AND id=NEW.metric_definition_id)='integer' AND NEW.value_number IS NOT NULL AND NEW.value_number<>CAST(NEW.value_number AS INTEGER) THEN RAISE(ABORT,'integer metric requires integer value')
    WHEN (SELECT value_type FROM metric_definitions WHERE org_id=NEW.org_id AND id=NEW.metric_definition_id)='boolean' AND NEW.value_number IS NOT NULL AND NEW.value_number NOT IN (0,1) THEN RAISE(ABORT,'boolean metric requires 0 or 1') END;
END;
