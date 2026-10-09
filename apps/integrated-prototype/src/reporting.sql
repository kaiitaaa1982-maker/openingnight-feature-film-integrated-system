CREATE TABLE IF NOT EXISTS distribution_types (
 code TEXT PRIMARY KEY, family TEXT NOT NULL, label TEXT NOT NULL, utilization TEXT, sort_order INTEGER NOT NULL
);
INSERT OR IGNORE INTO distribution_types VALUES
 ('theatrical','theatrical','劇場配給',NULL,10),('package_rental','package','ビデオグラム・レンタル','rental',20),
 ('package_sell','package','ビデオグラム・セル','sell',21),('package_unknown','package','ビデオグラム・区分未確認',NULL,29),
 ('est','digital','配信・EST','EST',30),('tvod','digital','配信・TVOD','TVOD',31),
 ('svod','digital','配信・SVOD','SVOD',32),('avod','digital','配信・AVOD','AVOD',33),('digital_unknown','digital','配信・区分未確認',NULL,39),
 ('broadcast_free','broadcast','放送・地上波',NULL,40),('broadcast_bs','broadcast','放送・BS',NULL,41),
 ('broadcast_cs','broadcast','放送・CS',NULL,42),('broadcast_cable','broadcast','放送・CATV',NULL,43),
 ('broadcast_unknown','broadcast','放送・区分未確認',NULL,49),('other','other','その他・未確認',NULL,90);
CREATE TABLE IF NOT EXISTS sale_distribution_versions (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
 distribution_code TEXT NOT NULL REFERENCES distribution_types(code), territory TEXT, service_name TEXT,
 settlement_method TEXT NOT NULL CHECK(settlement_method IN ('unverified','royalty','MG','FLAT','other')), reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,sale_id,version_no), UNIQUE(org_id,id),
 FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS distribution_no_update BEFORE UPDATE ON sale_distribution_versions BEGIN SELECT RAISE(ABORT,'distribution versions immutable'); END;
CREATE TRIGGER IF NOT EXISTS distribution_no_delete BEFORE DELETE ON sale_distribution_versions BEGIN SELECT RAISE(ABORT,'distribution versions immutable'); END;
CREATE TABLE IF NOT EXISTS receipt_plan_requests (
 id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, base_version INTEGER NOT NULL CHECK(base_version>=0),
 previous_due_date TEXT NOT NULL, proposed_due_date TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id,id), UNIQUE(org_id,invoice_id,id),
 FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS receipt_plan_decisions (
 org_id INTEGER NOT NULL, request_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
 version_no INTEGER, effective_on TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,request_id), UNIQUE(org_id,invoice_id,version_no),
 CHECK((decision='approved' AND version_no>0) OR (decision='rejected' AND version_no IS NULL)),
 FOREIGN KEY(org_id,invoice_id,request_id) REFERENCES receipt_plan_requests(org_id,invoice_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS plan_request_no_update BEFORE UPDATE ON receipt_plan_requests BEGIN SELECT RAISE(ABORT,'plan request immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_request_no_delete BEFORE DELETE ON receipt_plan_requests BEGIN SELECT RAISE(ABORT,'plan request immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_decision_no_update BEFORE UPDATE ON receipt_plan_decisions BEGIN SELECT RAISE(ABORT,'plan decision immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_decision_no_delete BEFORE DELETE ON receipt_plan_decisions BEGIN SELECT RAISE(ABORT,'plan decision immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_approval_guard BEFORE INSERT ON receipt_plan_decisions WHEN NEW.decision='approved' BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM receipt_plan_requests q JOIN billing_invoices i ON i.org_id=q.org_id AND i.id=q.invoice_id
 WHERE q.org_id=NEW.org_id AND q.id=NEW.request_id AND i.status='issued' AND q.proposed_due_date>=i.invoice_date
 AND i.amount_inc_tax>COALESCE((SELECT SUM(ba.amount_yen) FROM billing_receipt_allocations ba LEFT JOIN billing_receipt_reversals br ON br.org_id=ba.org_id AND br.receipt_id=ba.receipt_id WHERE ba.org_id=i.org_id AND ba.invoice_id=i.id AND br.receipt_id IS NULL),0)
 AND q.base_version=COALESCE((SELECT MAX(d.version_no) FROM receipt_plan_decisions d WHERE d.org_id=NEW.org_id AND d.invoice_id=NEW.invoice_id),0)
 AND NEW.version_no=q.base_version+1) THEN RAISE(ABORT,'stale plan request') END;
END;
CREATE TABLE IF NOT EXISTS sales_availability_versions (
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
CREATE TRIGGER IF NOT EXISTS availability_no_update BEFORE UPDATE ON sales_availability_versions BEGIN SELECT RAISE(ABORT,'availability version immutable'); END;
CREATE TRIGGER IF NOT EXISTS availability_no_delete BEFORE DELETE ON sales_availability_versions BEGIN SELECT RAISE(ABORT,'availability version immutable'); END;
CREATE TRIGGER IF NOT EXISTS availability_document_scope BEFORE INSERT ON sales_availability_versions WHEN NEW.document_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM rights_intake_documents d WHERE d.org_id=NEW.org_id AND d.id=NEW.document_id AND d.intake_case_id=NEW.intake_case_id) THEN RAISE(ABORT,'document case mismatch') END;
END;
