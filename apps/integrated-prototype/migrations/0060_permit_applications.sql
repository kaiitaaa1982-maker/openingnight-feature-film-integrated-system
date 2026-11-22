-- 撮影の許可申請（道路使用許可・公園や施設の使用許可。会社ルートの plans/2026-11-06-real-demo-split.md の手順8、案A＝1行に1件）。
-- 業務の決まりの正本は brain の wiki/10_manual/road-use-permit.md（受け取りまでの日数は提出先で違う・期間でまとめて申請できる上限）。
-- 足すだけの移行: 5表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0060 は調整役から受け取った（0059 のあと）。
--
-- permit_offices: 提出先（警察署・役所・施設の管理者）。名前だけを持ち、組織の中で名前は一意。
-- permit_office_versions: 提出先の設定の版。受け取りまでの日数（中N日。申請の翌日から N 日の窓口の開く日をはさみ、その次の日から受け取れる）と、
--   期間でまとめて申請できる上限の日数。提出先ごとの連番で追加だけ。わからない値は NULL（推測で埋めない）。
-- permit_applications: 申請の1件（作品と種類）。書き換えない。
-- permit_application_versions: 申請の中身の版（提出先・場所・使う期間・申請日・受け取り予定日・受け取った日・状態・手数料）。
--   申請ごとの連番で追加だけ。いまの中身は最新の版。状態を変えるときも新しい版を足す。
-- permit_application_documents: 申請と共通の原本（source_documents）の結び付き（申請書・略図・地図・許可証・通知書）。追加だけ。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS permit_offices (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,name),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS permit_offices_no_update BEFORE UPDATE ON permit_offices BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE TRIGGER IF NOT EXISTS permit_offices_no_delete BEFORE DELETE ON permit_offices BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE INDEX IF NOT EXISTS permit_offices_author_idx ON permit_offices(org_id,created_by);

CREATE TABLE IF NOT EXISTS permit_office_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 office_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 lead_business_days INTEGER CHECK(lead_business_days IS NULL OR (typeof(lead_business_days)='integer' AND lead_business_days BETWEEN 0 AND 30)),
 max_span_days INTEGER CHECK(max_span_days IS NULL OR (typeof(max_span_days)='integer' AND max_span_days BETWEEN 1 AND 366)),
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,office_id,version_no),
 FOREIGN KEY(org_id,office_id) REFERENCES permit_offices(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS permit_office_versions_sequence BEFORE INSERT ON permit_office_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM permit_office_versions v WHERE v.org_id=NEW.org_id AND v.office_id=NEW.office_id)
 BEGIN SELECT RAISE(ABORT,'stale permit office version'); END;
CREATE TRIGGER IF NOT EXISTS permit_office_versions_no_update BEFORE UPDATE ON permit_office_versions BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE TRIGGER IF NOT EXISTS permit_office_versions_no_delete BEFORE DELETE ON permit_office_versions BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE INDEX IF NOT EXISTS permit_office_versions_author_idx ON permit_office_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS permit_applications (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 application_key TEXT NOT NULL CHECK(length(application_key) BETWEEN 1 AND 64),
 kind TEXT NOT NULL CHECK(kind IN ('road','park','facility')),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,application_key),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS permit_applications_no_update BEFORE UPDATE ON permit_applications BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE TRIGGER IF NOT EXISTS permit_applications_no_delete BEFORE DELETE ON permit_applications BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE INDEX IF NOT EXISTS permit_applications_work_idx ON permit_applications(org_id,work_id);
CREATE INDEX IF NOT EXISTS permit_applications_author_idx ON permit_applications(org_id,created_by);

CREATE TABLE IF NOT EXISTS permit_application_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 application_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 office_id INTEGER NOT NULL,
 place TEXT NOT NULL CHECK(length(trim(place)) BETWEEN 1 AND 300),
 starts_on TEXT NOT NULL CHECK(length(starts_on)=10 AND substr(starts_on,5,1)='-' AND substr(starts_on,8,1)='-'
  AND ltrim(substr(starts_on,1,4)||substr(starts_on,6,2)||substr(starts_on,9,2),'0123456789')=''),
 ends_on TEXT NOT NULL CHECK(length(ends_on)=10 AND substr(ends_on,5,1)='-' AND substr(ends_on,8,1)='-'
  AND ltrim(substr(ends_on,1,4)||substr(ends_on,6,2)||substr(ends_on,9,2),'0123456789')=''),
 applied_on TEXT CHECK(applied_on IS NULL OR (length(applied_on)=10 AND substr(applied_on,5,1)='-' AND substr(applied_on,8,1)='-'
  AND ltrim(substr(applied_on,1,4)||substr(applied_on,6,2)||substr(applied_on,9,2),'0123456789')='')),
 pickup_on TEXT CHECK(pickup_on IS NULL OR (length(pickup_on)=10 AND substr(pickup_on,5,1)='-' AND substr(pickup_on,8,1)='-'
  AND ltrim(substr(pickup_on,1,4)||substr(pickup_on,6,2)||substr(pickup_on,9,2),'0123456789')='')),
 received_on TEXT CHECK(received_on IS NULL OR (length(received_on)=10 AND substr(received_on,5,1)='-' AND substr(received_on,8,1)='-'
  AND ltrim(substr(received_on,1,4)||substr(received_on,6,2)||substr(received_on,9,2),'0123456789')='')),
 state TEXT NOT NULL CHECK(state IN ('draft','submitted','permitted','returned','withdrawn','done')),
 fee_yen INTEGER CHECK(fee_yen IS NULL OR (typeof(fee_yen)='integer' AND fee_yen BETWEEN 0 AND 9007199254740991)),
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,application_id,version_no),
 FOREIGN KEY(org_id,application_id) REFERENCES permit_applications(org_id,id),
 FOREIGN KEY(org_id,office_id) REFERENCES permit_offices(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(ends_on>=starts_on),
 CHECK(state IN ('draft','withdrawn') OR applied_on IS NOT NULL),
 CHECK(received_on IS NULL OR state IN ('permitted','done')),
 CHECK(pickup_on IS NULL OR applied_on IS NULL OR pickup_on>=applied_on),
 CHECK(received_on IS NULL OR applied_on IS NULL OR received_on>=applied_on)
);
CREATE TRIGGER IF NOT EXISTS permit_application_versions_sequence BEFORE INSERT ON permit_application_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM permit_application_versions v WHERE v.org_id=NEW.org_id AND v.application_id=NEW.application_id)
 BEGIN SELECT RAISE(ABORT,'stale permit application version'); END;
CREATE TRIGGER IF NOT EXISTS permit_application_versions_no_update BEFORE UPDATE ON permit_application_versions BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE TRIGGER IF NOT EXISTS permit_application_versions_no_delete BEFORE DELETE ON permit_application_versions BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE INDEX IF NOT EXISTS permit_application_versions_office_idx ON permit_application_versions(org_id,office_id);
CREATE INDEX IF NOT EXISTS permit_application_versions_author_idx ON permit_application_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS permit_application_documents (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 application_id INTEGER NOT NULL,
 document_id INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('application','sketch','map','permit','notice','other')),
 linked_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,application_id,document_id),
 FOREIGN KEY(org_id,application_id) REFERENCES permit_applications(org_id,id),
 FOREIGN KEY(org_id,document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,linked_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS permit_application_documents_no_update BEFORE UPDATE ON permit_application_documents BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE TRIGGER IF NOT EXISTS permit_application_documents_no_delete BEFORE DELETE ON permit_application_documents BEGIN SELECT RAISE(ABORT,'permit record immutable'); END;
CREATE INDEX IF NOT EXISTS permit_application_documents_document_idx ON permit_application_documents(org_id,document_id);
CREATE INDEX IF NOT EXISTS permit_application_documents_author_idx ON permit_application_documents(org_id,linked_by);
