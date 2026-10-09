-- 依頼6②：原行・下見・確定・取消を追記して保持する。
CREATE TABLE IF NOT EXISTS expense_import_batches (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, layout TEXT NOT NULL CHECK(layout IN ('legacy22','standard25')), raw_sha256 TEXT NOT NULL, UNIQUE(org_id,raw_sha256), FOREIGN KEY(org_id,file_id) REFERENCES expense_source_files(org_id,id), UNIQUE(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_import_batches_no_update BEFORE UPDATE ON expense_import_batches BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_batches_no_delete BEFORE DELETE ON expense_import_batches BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TABLE IF NOT EXISTS expense_import_rows (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, row_no INTEGER NOT NULL, raw_json TEXT NOT NULL, UNIQUE(org_id,batch_id,row_no), FOREIGN KEY(org_id,batch_id) REFERENCES expense_import_batches(org_id,id), UNIQUE(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_import_rows_no_update BEFORE UPDATE ON expense_import_rows BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_rows_no_delete BEFORE DELETE ON expense_import_rows BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TABLE IF NOT EXISTS expense_import_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0), hash TEXT NOT NULL, expires_at TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(org_id,batch_id,version_no), FOREIGN KEY(org_id,batch_id) REFERENCES expense_import_batches(org_id,id), UNIQUE(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_import_versions_no_update BEFORE UPDATE ON expense_import_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_versions_no_delete BEFORE DELETE ON expense_import_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TABLE IF NOT EXISTS expense_import_events (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('committed','cancelled')), version_id INTEGER NOT NULL, occurred_on TEXT NOT NULL, UNIQUE(org_id,batch_id,kind), FOREIGN KEY(org_id,batch_id) REFERENCES expense_import_batches(org_id,id), FOREIGN KEY(org_id,version_id) REFERENCES expense_import_versions(org_id,id), UNIQUE(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_import_events_no_update BEFORE UPDATE ON expense_import_events BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_events_no_delete BEFORE DELETE ON expense_import_events BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TABLE IF NOT EXISTS expense_import_row_commits (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY, row_id INTEGER NOT NULL, version_id INTEGER NOT NULL, expense_id INTEGER NOT NULL, UNIQUE(org_id,row_id), UNIQUE(org_id,expense_id), FOREIGN KEY(org_id,row_id) REFERENCES expense_import_rows(org_id,id), FOREIGN KEY(org_id,version_id) REFERENCES expense_import_versions(org_id,id), FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id), UNIQUE(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_import_row_commits_no_update BEFORE UPDATE ON expense_import_row_commits BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_row_commits_no_delete BEFORE DELETE ON expense_import_row_commits BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_versions_order BEFORE INSERT ON expense_import_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM expense_import_versions WHERE org_id=NEW.org_id AND batch_id=NEW.batch_id) BEGIN SELECT RAISE(ABORT,'stale import version'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_row_same_batch BEFORE INSERT ON expense_import_row_commits WHEN (SELECT batch_id FROM expense_import_rows WHERE org_id=NEW.org_id AND id=NEW.row_id)<>(SELECT batch_id FROM expense_import_versions WHERE org_id=NEW.org_id AND id=NEW.version_id) BEGIN SELECT RAISE(ABORT,'import batch mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_no_resolve_cancelled BEFORE INSERT ON expense_import_row_commits WHEN EXISTS(SELECT 1 FROM expense_import_events e JOIN expense_import_rows r ON r.org_id=e.org_id AND r.batch_id=e.batch_id WHERE r.org_id=NEW.org_id AND r.id=NEW.row_id AND e.kind='cancelled') BEGIN SELECT RAISE(ABORT,'import cancelled'); END;
CREATE TRIGGER IF NOT EXISTS expense_import_event_same_batch BEFORE INSERT ON expense_import_events WHEN NEW.batch_id<>(SELECT batch_id FROM expense_import_versions WHERE org_id=NEW.org_id AND id=NEW.version_id) BEGIN SELECT RAISE(ABORT,'import batch mismatch'); END;

CREATE TABLE IF NOT EXISTS expense_pending_resolutions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), id INTEGER PRIMARY KEY, pending_id INTEGER NOT NULL, expense_id INTEGER NOT NULL,
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 UNIQUE(org_id,id), UNIQUE(org_id,pending_id), UNIQUE(org_id,expense_id),
 FOREIGN KEY(org_id,pending_id) REFERENCES expense_pending_rows(org_id,id), FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_pending_resolutions_no_update BEFORE UPDATE ON expense_pending_resolutions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_pending_resolutions_no_delete BEFORE DELETE ON expense_pending_resolutions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
