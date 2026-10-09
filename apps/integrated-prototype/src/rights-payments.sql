CREATE TABLE IF NOT EXISTS rights_payment_events (
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
CREATE TRIGGER IF NOT EXISTS rights_payments_validate BEFORE INSERT ON rights_payment_events BEGIN
 SELECT CASE WHEN NEW.settlement_contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM settlement_contracts c WHERE c.org_id=NEW.org_id AND c.id=NEW.settlement_contract_id AND c.holder_partner_id=NEW.partner_id) THEN RAISE(ABORT,'rights payment recipient mismatch') END;
 SELECT CASE WHEN NEW.committee_snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM committee_snapshot_member_amounts m WHERE m.org_id=NEW.org_id AND m.snapshot_id=NEW.committee_snapshot_id AND m.partner_id=NEW.partner_id) THEN RAISE(ABORT,'committee payment recipient mismatch') END;
 SELECT CASE WHEN NEW.reverses_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM rights_payment_events p WHERE p.org_id=NEW.org_id AND p.id=NEW.reverses_event_id AND p.reverses_event_id IS NULL AND p.partner_id=NEW.partner_id AND p.settlement_contract_id IS NEW.settlement_contract_id AND p.committee_snapshot_id IS NEW.committee_snapshot_id AND p.amount_yen=NEW.amount_yen AND p.paid_on<=NEW.paid_on) THEN RAISE(ABORT,'rights payment reversal mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS rights_payments_no_update BEFORE UPDATE ON rights_payment_events BEGIN SELECT RAISE(ABORT,'rights payment events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS rights_payments_no_delete BEFORE DELETE ON rights_payment_events BEGIN SELECT RAISE(ABORT,'rights payment events are immutable'); END;
