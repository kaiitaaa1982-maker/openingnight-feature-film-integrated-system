CREATE TABLE IF NOT EXISTS broadcast_slots (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS broadcast_slot_versions (
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
CREATE INDEX IF NOT EXISTS broadcast_slot_month ON broadcast_slot_versions(org_id,work_id,broadcast_month,station_name);
CREATE TRIGGER IF NOT EXISTS broadcast_version_no_update BEFORE UPDATE ON broadcast_slot_versions BEGIN SELECT RAISE(ABORT,'broadcast version immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_version_no_delete BEFORE DELETE ON broadcast_slot_versions BEGIN SELECT RAISE(ABORT,'broadcast version immutable'); END;
CREATE TABLE IF NOT EXISTS broadcast_import_previews (
 token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
 payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS broadcast_availability_previews (
 token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS broadcast_availability_rates (
 org_id INTEGER NOT NULL, availability_version_id INTEGER NOT NULL,
 rate_bps INTEGER CHECK(rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
 PRIMARY KEY(org_id,availability_version_id),
 FOREIGN KEY(org_id,availability_version_id) REFERENCES sales_availability_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS broadcast_availability_rate_no_update BEFORE UPDATE ON broadcast_availability_rates BEGIN SELECT RAISE(ABORT,'availability rate version immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_availability_rate_no_delete BEFORE DELETE ON broadcast_availability_rates BEGIN SELECT RAISE(ABORT,'availability rate version immutable'); END;
CREATE TABLE IF NOT EXISTS broadcast_airings (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, slot_id INTEGER NOT NULL,
 aired_on TEXT NOT NULL, run_count INTEGER NOT NULL CHECK(run_count BETWEEN 1 AND 9999),
 source_reference TEXT NOT NULL CHECK(length(trim(source_reference))>0), note TEXT,
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), FOREIGN KEY(org_id,work_id,slot_id) REFERENCES broadcast_slots(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS broadcast_airing_no_update BEFORE UPDATE ON broadcast_airings BEGIN SELECT RAISE(ABORT,'broadcast airing immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_airing_no_delete BEFORE DELETE ON broadcast_airings BEGIN SELECT RAISE(ABORT,'broadcast airing immutable'); END;
CREATE TABLE IF NOT EXISTS broadcast_sale_links (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, slot_id INTEGER NOT NULL, sale_id INTEGER NOT NULL,
 note TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,sale_id),
 FOREIGN KEY(org_id,work_id,slot_id) REFERENCES broadcast_slots(org_id,work_id,id),
 FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS broadcast_sale_link_scope BEFORE INSERT ON broadcast_sale_links
WHEN NOT EXISTS(SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id AND s.work_id=NEW.work_id)
BEGIN SELECT RAISE(ABORT,'broadcast sale work mismatch'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_sale_link_no_update BEFORE UPDATE ON broadcast_sale_links BEGIN SELECT RAISE(ABORT,'broadcast sale link immutable'); END;
