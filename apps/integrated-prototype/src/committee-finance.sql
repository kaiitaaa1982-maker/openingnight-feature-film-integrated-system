CREATE TABLE IF NOT EXISTS committee_term_funding (
  org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, production_cost_yen INTEGER NOT NULL CHECK(production_cost_yen>=0),
  PRIMARY KEY(org_id,term_version_id),
  FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id)
);
CREATE TABLE IF NOT EXISTS committee_term_investments (
  org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL, partner_id INTEGER NOT NULL, amount_yen INTEGER NOT NULL CHECK(amount_yen>=0),
  PRIMARY KEY(org_id,term_version_id,partner_id),
  FOREIGN KEY(org_id,term_version_id,partner_id) REFERENCES committee_term_members(org_id,term_version_id,partner_id)
);
CREATE TABLE IF NOT EXISTS committee_snapshot_deductions (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, work_id INTEGER NOT NULL, report_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('royalty','production_recoup')), recipient_partner_id INTEGER NOT NULL,
  amount_yen INTEGER NOT NULL CHECK(amount_yen>0), source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0),
  PRIMARY KEY(org_id,snapshot_id,source_reference), UNIQUE(org_id,work_id,source_reference),
  FOREIGN KEY(org_id,snapshot_id,work_id) REFERENCES committee_report_snapshots(org_id,id,work_id),
  FOREIGN KEY(org_id,snapshot_id,report_id) REFERENCES committee_snapshot_reports(org_id,snapshot_id,report_id),
  FOREIGN KEY(org_id,window_id) REFERENCES committee_term_windows(org_id,id),
  FOREIGN KEY(org_id,recipient_partner_id) REFERENCES partners(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS committee_funding_immutable BEFORE UPDATE ON committee_term_funding BEGIN SELECT RAISE(ABORT,'committee funding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_investment_immutable BEFORE UPDATE ON committee_term_investments BEGIN SELECT RAISE(ABORT,'committee investment is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_deduction_immutable BEFORE UPDATE ON committee_snapshot_deductions BEGIN SELECT RAISE(ABORT,'committee deductions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_funding_no_delete BEFORE DELETE ON committee_term_funding BEGIN SELECT RAISE(ABORT,'committee funding is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_investment_no_delete BEFORE DELETE ON committee_term_investments BEGIN SELECT RAISE(ABORT,'committee investment is immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_deduction_no_delete BEFORE DELETE ON committee_snapshot_deductions BEGIN SELECT RAISE(ABORT,'committee deductions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_deduction_scope BEFORE INSERT ON committee_snapshot_deductions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM committee_snapshot_reports r WHERE r.org_id=NEW.org_id AND r.snapshot_id=NEW.snapshot_id AND r.work_id=NEW.work_id AND r.report_id=NEW.report_id AND r.window_id=NEW.window_id) THEN RAISE(ABORT,'committee deduction report scope mismatch') END;
END;
