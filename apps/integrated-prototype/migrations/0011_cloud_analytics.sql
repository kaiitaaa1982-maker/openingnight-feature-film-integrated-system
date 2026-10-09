CREATE TABLE IF NOT EXISTS cloud_analytics_state(org_id INTEGER PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,lock_job TEXT,lock_until TEXT,active_run TEXT,active_hash TEXT);
CREATE TABLE IF NOT EXISTS cloud_analytics_jobs(id TEXT PRIMARY KEY,org_id INTEGER NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,as_of TEXT NOT NULL,definition_version TEXT NOT NULL,audit_through INTEGER,manifest_hash TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
CREATE INDEX IF NOT EXISTS cloud_analytics_jobs_org ON cloud_analytics_jobs(org_id,created_at);
