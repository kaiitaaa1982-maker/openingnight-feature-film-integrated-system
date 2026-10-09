-- 依頼6①：追加のみ。すべての業務記録は版または取消の追記。
CREATE TABLE IF NOT EXISTS expense_invoices (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL CHECK(code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
 partner_id INTEGER NOT NULL,
 UNIQUE(org_id,code),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_invoices_no_update BEFORE UPDATE ON expense_invoices BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_invoices_no_delete BEFORE DELETE ON expense_invoices BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_invoices_partner_id_idx ON expense_invoices(org_id,partner_id);
CREATE INDEX IF NOT EXISTS expense_invoices_author_idx ON expense_invoices(org_id,created_by);

CREATE TABLE IF NOT EXISTS expense_invoice_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 invoice_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 invoice_number TEXT CHECK(invoice_number IS NULL OR length(trim(invoice_number)) BETWEEN 1 AND 120),
 document_kind TEXT NOT NULL CHECK(document_kind IN ('invoice','receipt','credit_note','other')),
 invoice_on TEXT NOT NULL CHECK(invoice_on IS NULL OR (invoice_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(invoice_on,'+0 days') IS NOT NULL AND date(invoice_on,'+0 days')=invoice_on)),
 closing_on TEXT NOT NULL CHECK(closing_on IS NULL OR (closing_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(closing_on,'+0 days') IS NOT NULL AND date(closing_on,'+0 days')=closing_on)),
 due_on TEXT NOT NULL CHECK(due_on IS NULL OR (due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(due_on,'+0 days') IS NOT NULL AND date(due_on,'+0 days')=due_on)),
 payment_term_version_id INTEGER,
 closing_origin TEXT NOT NULL CHECK(closing_origin IN ('term','manual','override')),
 due_origin TEXT NOT NULL CHECK(due_origin IN ('term','manual','override')),
 override_note TEXT CHECK(override_note IS NULL OR length(trim(override_note)) BETWEEN 1 AND 1000),
 payment_method TEXT NOT NULL CHECK(payment_method IN ('transfer','cash','card','offset','other')),
 UNIQUE(org_id,invoice_id,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,invoice_id) REFERENCES expense_invoices(org_id,id),
 FOREIGN KEY(org_id,payment_term_version_id) REFERENCES partner_payment_term_versions(org_id,id),
 CHECK(invoice_on<=closing_on AND closing_on<=due_on),
 CHECK((closing_origin='manual' AND due_origin='manual') OR payment_term_version_id IS NOT NULL),
 CHECK((closing_origin<>'override' AND due_origin<>'override') OR override_note IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS expense_invoice_versions_no_update BEFORE UPDATE ON expense_invoice_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_invoice_versions_no_delete BEFORE DELETE ON expense_invoice_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_invoice_versions_invoice_id_idx ON expense_invoice_versions(org_id,invoice_id);
CREATE INDEX IF NOT EXISTS expense_invoice_versions_payment_term_version_id_idx ON expense_invoice_versions(org_id,payment_term_version_id);
CREATE INDEX IF NOT EXISTS expense_invoice_versions_author_idx ON expense_invoice_versions(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_invoice_versions_dates_idx ON expense_invoice_versions(org_id,closing_on,due_on);
CREATE TRIGGER IF NOT EXISTS expense_invoice_versions_sequence BEFORE INSERT ON expense_invoice_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM expense_invoice_versions WHERE org_id=NEW.org_id AND invoice_id=NEW.invoice_id) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;

CREATE TABLE IF NOT EXISTS expense_details (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 expense_id INTEGER NOT NULL,
 invoice_id INTEGER NOT NULL,
 recorded_on TEXT CHECK(recorded_on IS NULL OR (recorded_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(recorded_on,'+0 days') IS NOT NULL AND date(recorded_on,'+0 days')=recorded_on)),
 distribution_type_code TEXT REFERENCES distribution_types(code),
 product_id INTEGER,
 source_product_number TEXT CHECK(source_product_number IS NULL OR length(trim(source_product_number)) BETWEEN 1 AND 240),
 source_product_name TEXT CHECK(source_product_name IS NULL OR length(trim(source_product_name)) BETWEEN 1 AND 240),
 source_client_name TEXT CHECK(source_client_name IS NULL OR length(trim(source_client_name)) BETWEEN 1 AND 240),
 supplier_text TEXT CHECK(supplier_text IS NULL OR length(trim(supplier_text)) BETWEEN 1 AND 240),
 specification TEXT CHECK(specification IS NULL OR length(trim(specification)) BETWEEN 1 AND 1000),
 memo TEXT CHECK(memo IS NULL OR length(trim(memo)) BETWEEN 1 AND 1000),
 quantity_x10000 INTEGER CHECK(quantity_x10000 IS NULL OR (typeof(quantity_x10000)='integer' AND quantity_x10000 BETWEEN 0 AND 9007199254740991)),
 unit_price_x10000 INTEGER CHECK(unit_price_x10000 IS NULL OR (typeof(unit_price_x10000)='integer' AND unit_price_x10000 BETWEEN 0 AND 9007199254740991)),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 PRIMARY KEY(org_id,expense_id),
 FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
 FOREIGN KEY(org_id,invoice_id) REFERENCES expense_invoices(org_id,id),
 FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_details_no_update BEFORE UPDATE ON expense_details BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_details_no_delete BEFORE DELETE ON expense_details BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_details_invoice_id_idx ON expense_details(org_id,invoice_id);
CREATE INDEX IF NOT EXISTS expense_details_product_id_idx ON expense_details(org_id,product_id);
CREATE INDEX IF NOT EXISTS expense_details_author_idx ON expense_details(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_details_distribution_idx ON expense_details(distribution_type_code);

CREATE TABLE IF NOT EXISTS expense_line_voids (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 expense_id INTEGER NOT NULL,
 voided_on TEXT NOT NULL CHECK(voided_on IS NULL OR (voided_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(voided_on,'+0 days') IS NOT NULL AND date(voided_on,'+0 days')=voided_on)),
 replacement_expense_id INTEGER,
 UNIQUE(org_id,replacement_expense_id),
 CHECK(replacement_expense_id IS NULL OR replacement_expense_id<>expense_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 PRIMARY KEY(org_id,expense_id),
 FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
 FOREIGN KEY(org_id,replacement_expense_id) REFERENCES expenses(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_line_voids_no_update BEFORE UPDATE ON expense_line_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_line_voids_no_delete BEFORE DELETE ON expense_line_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_line_voids_replacement_expense_id_idx ON expense_line_voids(org_id,replacement_expense_id);
CREATE INDEX IF NOT EXISTS expense_line_voids_author_idx ON expense_line_voids(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_line_voids_date_idx ON expense_line_voids(org_id,voided_on);

CREATE TABLE IF NOT EXISTS expense_source_files (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 file_name TEXT NOT NULL CHECK(file_name IS NULL OR length(trim(file_name)) BETWEEN 1 AND 240),
 media_type TEXT NOT NULL CHECK(media_type IS NULL OR length(trim(media_type)) BETWEEN 1 AND 100),
 byte_length INTEGER NOT NULL CHECK(byte_length>0),
 raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^a-f0-9]*'),
 original_base64 TEXT NOT NULL,
 UNIQUE(org_id,raw_sha256),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_source_files_no_update BEFORE UPDATE ON expense_source_files BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_source_files_no_delete BEFORE DELETE ON expense_source_files BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_source_files_author_idx ON expense_source_files(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_source_files_created_idx ON expense_source_files(org_id,created_at);

CREATE TABLE IF NOT EXISTS expense_invoice_file_links (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 invoice_id INTEGER NOT NULL,
 file_id INTEGER NOT NULL,
 purpose TEXT NOT NULL CHECK(purpose IN ('invoice','receipt','supporting')),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,invoice_id) REFERENCES expense_invoices(org_id,id),
 FOREIGN KEY(org_id,file_id) REFERENCES expense_source_files(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_invoice_file_links_no_update BEFORE UPDATE ON expense_invoice_file_links BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_invoice_file_links_no_delete BEFORE DELETE ON expense_invoice_file_links BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_invoice_file_links_invoice_id_idx ON expense_invoice_file_links(org_id,invoice_id);
CREATE INDEX IF NOT EXISTS expense_invoice_file_links_file_id_idx ON expense_invoice_file_links(org_id,file_id);
CREATE INDEX IF NOT EXISTS expense_invoice_file_links_author_idx ON expense_invoice_file_links(org_id,created_by);

CREATE TABLE IF NOT EXISTS expense_invoice_file_unlinks (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 link_id INTEGER NOT NULL,
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 PRIMARY KEY(org_id,link_id),
 FOREIGN KEY(org_id,link_id) REFERENCES expense_invoice_file_links(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_invoice_file_unlinks_no_update BEFORE UPDATE ON expense_invoice_file_unlinks BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_invoice_file_unlinks_no_delete BEFORE DELETE ON expense_invoice_file_unlinks BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_invoice_file_unlinks_author_idx ON expense_invoice_file_unlinks(org_id,created_by);

CREATE TABLE IF NOT EXISTS expense_pending_rows (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 project_id INTEGER NOT NULL,
 code TEXT NOT NULL CHECK(code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
 raw_payload_json TEXT NOT NULL CHECK(json_valid(raw_payload_json) AND json_type(raw_payload_json)='object' AND length(CAST(raw_payload_json AS BLOB))<=65536),
 UNIQUE(org_id,code),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_pending_rows_no_update BEFORE UPDATE ON expense_pending_rows BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_pending_rows_no_delete BEFORE DELETE ON expense_pending_rows BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_pending_rows_project_id_idx ON expense_pending_rows(org_id,project_id);
CREATE INDEX IF NOT EXISTS expense_pending_rows_author_idx ON expense_pending_rows(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS expense_invoice_term_scope BEFORE INSERT ON expense_invoice_versions
 WHEN NEW.payment_term_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM partner_payment_term_versions t JOIN expense_invoices i ON i.org_id=t.org_id AND i.partner_id=t.partner_id WHERE i.org_id=NEW.org_id AND i.id=NEW.invoice_id AND t.id=NEW.payment_term_version_id)
 BEGIN SELECT RAISE(ABORT,'payment term partner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_detail_scope BEFORE INSERT ON expense_details
 WHEN NOT EXISTS(SELECT 1 FROM expenses e JOIN expense_invoices i ON i.org_id=e.org_id AND (i.partner_id=e.partner_id OR e.partner_id IS NULL) JOIN expense_invoice_versions v ON v.org_id=i.org_id AND v.invoice_id=i.id WHERE e.org_id=NEW.org_id AND e.id=NEW.expense_id AND i.id=NEW.invoice_id AND v.active=1 AND v.version_no=(SELECT MAX(x.version_no) FROM expense_invoice_versions x WHERE x.org_id=i.org_id AND x.invoice_id=i.id))
 BEGIN SELECT RAISE(ABORT,'invoice partner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_detail_product_scope BEFORE INSERT ON expense_details
 WHEN NEW.product_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM expenses e JOIN product_works p ON p.org_id=e.org_id AND p.work_id=e.work_id WHERE e.org_id=NEW.org_id AND e.id=NEW.expense_id AND p.product_id=NEW.product_id)
 BEGIN SELECT RAISE(ABORT,'product work mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expenses_req6_no_update BEFORE UPDATE ON expenses WHEN EXISTS(SELECT 1 FROM expense_details d WHERE d.org_id=OLD.org_id AND d.expense_id=OLD.id) BEGIN SELECT RAISE(ABORT,'invoice expense immutable'); END;
CREATE TRIGGER IF NOT EXISTS expenses_req6_no_delete BEFORE DELETE ON expenses WHEN EXISTS(SELECT 1 FROM expense_details d WHERE d.org_id=OLD.org_id AND d.expense_id=OLD.id) BEGIN SELECT RAISE(ABORT,'invoice expense immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_file_link_unique BEFORE INSERT ON expense_invoice_file_links
 WHEN EXISTS(SELECT 1 FROM expense_invoice_file_links l WHERE l.org_id=NEW.org_id AND l.invoice_id=NEW.invoice_id AND l.file_id=NEW.file_id AND l.purpose=NEW.purpose AND NOT EXISTS(SELECT 1 FROM expense_invoice_file_unlinks u WHERE u.org_id=l.org_id AND u.link_id=l.id))
 BEGIN SELECT RAISE(ABORT,'duplicate file link'); END;
CREATE TRIGGER IF NOT EXISTS expense_void_paid BEFORE INSERT ON expense_line_voids
 WHEN EXISTS(SELECT 1 FROM expense_payments p WHERE p.org_id=NEW.org_id AND p.expense_id=NEW.expense_id AND p.reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM expense_payments r WHERE r.org_id=p.org_id AND r.reverses_id=p.id)) OR EXISTS(SELECT 1 FROM committee_snapshot_expenses s WHERE s.org_id=NEW.org_id AND s.expense_id=NEW.expense_id)
 BEGIN SELECT RAISE(ABORT,'paid or settled expense cannot be voided'); END;
CREATE TRIGGER IF NOT EXISTS expense_void_replacement_scope BEFORE INSERT ON expense_line_voids
 WHEN NEW.replacement_expense_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM expenses e JOIN expenses r ON r.org_id=e.org_id AND r.project_id=e.project_id AND r.work_id IS e.work_id JOIN expense_details d ON d.org_id=e.org_id AND d.expense_id=e.id JOIN expense_details n ON n.org_id=r.org_id AND n.expense_id=r.id AND n.invoice_id=d.invoice_id WHERE e.org_id=NEW.org_id AND e.id=NEW.expense_id AND r.id=NEW.replacement_expense_id)
 BEGIN SELECT RAISE(ABORT,'replacement scope mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_invoice_cancel_live BEFORE INSERT ON expense_invoice_versions
 WHEN NEW.active=0 AND EXISTS(SELECT 1 FROM expense_details d WHERE d.org_id=NEW.org_id AND d.invoice_id=NEW.invoice_id AND NOT EXISTS(SELECT 1 FROM expense_line_voids v WHERE v.org_id=d.org_id AND v.expense_id=d.expense_id))
 BEGIN SELECT RAISE(ABORT,'void all invoice lines first'); END;
