CREATE TABLE IF NOT EXISTS report_sale_dimensions_versions (
 org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
 department_name TEXT CHECK(department_name IS NULL OR length(trim(department_name)) BETWEEN 1 AND 100),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000), created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,sale_id,version_no),
 FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS report_dimensions_immutable_update BEFORE UPDATE ON report_sale_dimensions_versions BEGIN SELECT RAISE(ABORT,'report dimensions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_dimensions_immutable_delete BEFORE DELETE ON report_sale_dimensions_versions BEGIN SELECT RAISE(ABORT,'report dimensions are immutable'); END;
