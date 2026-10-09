-- New cash-basis calculation family. The existing committee terms and snapshots
-- remain untouched. All rows are scoped to the ordinary work and organization.
CREATE TABLE IF NOT EXISTS joint_committee_contracts (
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
CREATE TABLE IF NOT EXISTS joint_committee_members (
  org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role='investor'), share_bps INTEGER NOT NULL CHECK(share_bps BETWEEN 0 AND 10000),
  contribution_inc_tax_yen INTEGER NOT NULL CHECK(contribution_inc_tax_yen>=0),
  PRIMARY KEY(org_id,contract_id,partner_id), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);
CREATE TABLE IF NOT EXISTS joint_committee_windows (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, kind TEXT NOT NULL,
  label TEXT NOT NULL, partner_id INTEGER NOT NULL, fee_bps INTEGER NOT NULL CHECK(fee_bps BETWEEN 0 AND 10000),
  report_offset_months INTEGER NOT NULL, report_day TEXT NOT NULL, payment_offset_months INTEGER NOT NULL, payment_day TEXT NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,contract_id,id), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);
CREATE TABLE IF NOT EXISTS joint_committee_periods (
  org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
  from_on TEXT NOT NULL, to_on TEXT NOT NULL, PRIMARY KEY(org_id,contract_id,sequence),
  FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id), CHECK(from_on<=to_on)
);
CREATE TABLE IF NOT EXISTS joint_business_holidays (
  org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, holiday_on TEXT NOT NULL, label TEXT NOT NULL,
  PRIMARY KEY(org_id,contract_id,holiday_on), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id)
);
CREATE TABLE IF NOT EXISTS joint_committee_sales (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, window_id INTEGER NOT NULL,
  period_sequence INTEGER NOT NULL, source_ref TEXT NOT NULL, amount_contract_yen INTEGER NOT NULL CHECK(amount_contract_yen>=0),
  gross_inc_tax_yen INTEGER NOT NULL CHECK(gross_inc_tax_yen>=0), reported_on TEXT, manager_receipt_on TEXT,
  UNIQUE(org_id,contract_id,source_ref),
  FOREIGN KEY(org_id,contract_id,period_sequence) REFERENCES joint_committee_periods(org_id,contract_id,sequence),
  FOREIGN KEY(org_id,contract_id,window_id) REFERENCES joint_committee_windows(org_id,contract_id,id)
);
CREATE TABLE IF NOT EXISTS joint_committee_costs (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, window_id INTEGER,
  period_sequence INTEGER NOT NULL, source_ref TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('window_direct','music_window_paid','rights_manager','master_management','bank_advance')),
  amount_yen INTEGER NOT NULL CHECK(amount_yen>=0), tax_basis TEXT NOT NULL CHECK(tax_basis IN ('ex_tax','inc_tax')),
  approved INTEGER NOT NULL CHECK(approved=1), UNIQUE(org_id,contract_id,source_ref),
  FOREIGN KEY(org_id,contract_id,period_sequence) REFERENCES joint_committee_periods(org_id,contract_id,sequence),
  FOREIGN KEY(org_id,contract_id,window_id) REFERENCES joint_committee_windows(org_id,contract_id,id),
  CHECK((kind IN ('window_direct','music_window_paid') AND window_id IS NOT NULL) OR (kind NOT IN ('window_direct','music_window_paid') AND window_id IS NULL))
);
CREATE TABLE IF NOT EXISTS joint_production_milestones (
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
CREATE TABLE IF NOT EXISTS joint_funding_events (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cash_contribution','production_payment_credit')),
  source_ref TEXT NOT NULL, amount_inc_tax_yen INTEGER NOT NULL CHECK(amount_inc_tax_yen>0),
  paid_on TEXT NOT NULL, milestone_id INTEGER,
  UNIQUE(org_id,contract_id,source_ref), FOREIGN KEY(org_id,contract_id,partner_id) REFERENCES joint_committee_members(org_id,contract_id,partner_id),
  FOREIGN KEY(milestone_id) REFERENCES joint_production_milestones(id),
  CHECK((kind='production_payment_credit' AND milestone_id IS NOT NULL) OR (kind='cash_contribution' AND milestone_id IS NULL))
);
CREATE TRIGGER IF NOT EXISTS joint_funding_credit_validate BEFORE INSERT ON joint_funding_events WHEN NEW.kind='production_payment_credit' BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM joint_production_milestones m JOIN joint_committee_contracts c ON c.org_id=m.org_id AND c.id=m.contract_id
    WHERE m.org_id=NEW.org_id AND m.contract_id=NEW.contract_id AND m.id=NEW.milestone_id
      AND c.manager_partner_id=NEW.partner_id AND m.paid_on=NEW.paid_on AND m.paid_inc_tax_yen>=NEW.amount_inc_tax_yen
  ) THEN RAISE(ABORT,'production payment credit source mismatch') END;
  SELECT CASE WHEN (SELECT COALESCE(SUM(f.amount_inc_tax_yen),0) FROM joint_funding_events f WHERE f.org_id=NEW.org_id AND f.contract_id=NEW.contract_id AND f.milestone_id=NEW.milestone_id)+NEW.amount_inc_tax_yen>
    (SELECT m.paid_inc_tax_yen FROM joint_production_milestones m WHERE m.org_id=NEW.org_id AND m.contract_id=NEW.contract_id AND m.id=NEW.milestone_id)
    THEN RAISE(ABORT,'production payment credit exceeds paid amount') END;
END;
CREATE TRIGGER IF NOT EXISTS joint_funding_event_immutable BEFORE UPDATE ON joint_funding_events BEGIN SELECT RAISE(ABORT,'funding event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_funding_event_no_delete BEFORE DELETE ON joint_funding_events BEGIN SELECT RAISE(ABORT,'funding event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_milestone_immutable BEFORE UPDATE ON joint_production_milestones BEGIN SELECT RAISE(ABORT,'production milestone is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_milestone_no_delete BEFORE DELETE ON joint_production_milestones BEGIN SELECT RAISE(ABORT,'production milestone is immutable'); END;
CREATE TABLE IF NOT EXISTS joint_committee_snapshots (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, contract_id INTEGER NOT NULL,
  calculation_version TEXT NOT NULL CHECK(calculation_version='joint_cash_v1'), input_hash TEXT NOT NULL,
  calculation_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,contract_id,input_hash), FOREIGN KEY(org_id,contract_id) REFERENCES joint_committee_contracts(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS joint_snapshot_immutable BEFORE UPDATE ON joint_committee_snapshots BEGIN SELECT RAISE(ABORT,'joint snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_snapshot_no_delete BEFORE DELETE ON joint_committee_snapshots BEGIN SELECT RAISE(ABORT,'joint snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_contract_immutable BEFORE UPDATE ON joint_committee_contracts BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_contract_no_delete BEFORE DELETE ON joint_committee_contracts BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_member_immutable BEFORE UPDATE ON joint_committee_members BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_member_no_delete BEFORE DELETE ON joint_committee_members BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_window_immutable BEFORE UPDATE ON joint_committee_windows BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_window_no_delete BEFORE DELETE ON joint_committee_windows BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_period_immutable BEFORE UPDATE ON joint_committee_periods BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_period_no_delete BEFORE DELETE ON joint_committee_periods BEGIN SELECT RAISE(ABORT,'joint terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_sale_immutable BEFORE UPDATE ON joint_committee_sales BEGIN SELECT RAISE(ABORT,'joint sale event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_sale_no_delete BEFORE DELETE ON joint_committee_sales BEGIN SELECT RAISE(ABORT,'joint sale event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_cost_immutable BEFORE UPDATE ON joint_committee_costs BEGIN SELECT RAISE(ABORT,'joint cost event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_cost_no_delete BEFORE DELETE ON joint_committee_costs BEGIN SELECT RAISE(ABORT,'joint cost event is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_holiday_immutable BEFORE UPDATE ON joint_business_holidays BEGIN SELECT RAISE(ABORT,'joint calendar is immutable'); END;
CREATE TRIGGER IF NOT EXISTS joint_holiday_no_delete BEFORE DELETE ON joint_business_holidays BEGIN SELECT RAISE(ABORT,'joint calendar is immutable'); END;
