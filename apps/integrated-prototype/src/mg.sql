PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS mg_suppliers (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL CHECK(code GLOB 'SUP-*'),
  name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,code), FOREIGN KEY(org_id) REFERENCES organizations(id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS mg_incoming_contracts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, partner_id INTEGER NOT NULL,
  contract_date TEXT NOT NULL, source_reference TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,code),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS mg_outgoing_contracts (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, supplier_id INTEGER NOT NULL,
  contract_date TEXT NOT NULL, source_reference TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,code),
  FOREIGN KEY(org_id,supplier_id) REFERENCES mg_suppliers(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS mg_term_versions (
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
CREATE TABLE IF NOT EXISTS mg_version_products (
  org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, product_id INTEGER NOT NULL, evaluation_yen INTEGER NOT NULL CHECK(evaluation_yen>=0),
  PRIMARY KEY(org_id,term_version_id,product_id), FOREIGN KEY(org_id,term_version_id) REFERENCES mg_term_versions(org_id,id),
  FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id)
);
CREATE TABLE IF NOT EXISTS mg_version_phases (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, phase_order INTEGER NOT NULL,
  starts_on TEXT NOT NULL, ends_on TEXT NOT NULL CHECK(ends_on>=starts_on), interval_months INTEGER NOT NULL CHECK(interval_months IN (1,3,6,12)), close_day TEXT NOT NULL DEFAULT '31' CHECK(close_day='eom' OR (close_day NOT GLOB '*[^0-9]*' AND CAST(close_day AS INTEGER) BETWEEN 1 AND 31)),
  first_close_on TEXT NOT NULL, report_offset_months INTEGER NOT NULL CHECK(report_offset_months BETWEEN 0 AND 24), report_day INTEGER NOT NULL CHECK(report_day BETWEEN 1 AND 31),
  pay_offset_months INTEGER NOT NULL CHECK(pay_offset_months BETWEEN 0 AND 24), pay_day INTEGER NOT NULL CHECK(pay_day BETWEEN 1 AND 31),
  UNIQUE(org_id,term_version_id,phase_order), FOREIGN KEY(org_id,term_version_id) REFERENCES mg_term_versions(org_id,id)
);
CREATE TABLE IF NOT EXISTS mg_contract_links (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, incoming_contract_id INTEGER NOT NULL, outgoing_contract_id INTEGER NOT NULL,
  rationale TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,incoming_contract_id,outgoing_contract_id), FOREIGN KEY(org_id,incoming_contract_id) REFERENCES mg_incoming_contracts(org_id,id),
  FOREIGN KEY(org_id,outgoing_contract_id) REFERENCES mg_outgoing_contracts(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS mg_ledger_entries (
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
CREATE TRIGGER IF NOT EXISTS mg_terms_no_update BEFORE UPDATE ON mg_term_versions BEGIN SELECT RAISE(ABORT,'MG条件版は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_terms_no_delete BEFORE DELETE ON mg_term_versions BEGIN SELECT RAISE(ABORT,'MG条件版は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_products_no_update BEFORE UPDATE ON mg_version_products BEGIN SELECT RAISE(ABORT,'MG商品評価は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_products_no_delete BEFORE DELETE ON mg_version_products BEGIN SELECT RAISE(ABORT,'MG商品評価は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_phases_no_update BEFORE UPDATE ON mg_version_phases BEGIN SELECT RAISE(ABORT,'MG日程は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_phases_no_delete BEFORE DELETE ON mg_version_phases BEGIN SELECT RAISE(ABORT,'MG日程は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_incoming_no_update BEFORE UPDATE ON mg_incoming_contracts BEGIN SELECT RAISE(ABORT,'MG契約マスターは変更できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_incoming_no_delete BEFORE DELETE ON mg_incoming_contracts BEGIN SELECT RAISE(ABORT,'MG契約マスターは削除できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_outgoing_no_update BEFORE UPDATE ON mg_outgoing_contracts BEGIN SELECT RAISE(ABORT,'MG契約マスターは変更できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_outgoing_no_delete BEFORE DELETE ON mg_outgoing_contracts BEGIN SELECT RAISE(ABORT,'MG契約マスターは削除できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_ledger_no_update BEFORE UPDATE ON mg_ledger_entries BEGIN SELECT RAISE(ABORT,'MG月次報告は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_ledger_no_delete BEFORE DELETE ON mg_ledger_entries BEGIN SELECT RAISE(ABORT,'MG月次報告は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS mg_ledger_successor_scope BEFORE INSERT ON mg_ledger_entries WHEN NEW.reverses_entry_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM mg_ledger_entries old
    WHERE old.org_id=NEW.org_id AND old.id=NEW.reverses_entry_id
      AND old.term_version_id=NEW.term_version_id AND old.product_id=NEW.product_id
  ) THEN RAISE(ABORT,'訂正元は同じ条件版・商品の原報告を指定してください') END;
END;
