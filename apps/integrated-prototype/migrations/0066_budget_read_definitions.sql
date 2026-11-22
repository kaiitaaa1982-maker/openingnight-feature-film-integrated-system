-- 予算書の読み取りの定義（見出しの語・合計の行の名前・区分の語）を、コードではなく組織ごとの版つきのデータで持つ
-- （会社ルートの plans/2026-11-12-ingest-definitions.md の手順4。要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-035〜041）。
-- 足すだけの移行: 4表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0066 は仮（調整役が決める）。
-- 既存の組織への初期値（コードに直書きしていた2つの書式）は、次の移行 0067 が入れる。
--
-- budget_read_profiles: 定義（組織ごと・名前で区別）。名前は変えない。初期値（source='seed'）は作った人を持たない。
-- budget_read_versions: 定義の版。定義ごとの連番で追加だけ。中身は JSON（definition_json）と、その SHA-256（definition_hash）。
--   中身の形（知らない読み方・知らないキー・決まった集合に無い行き先・空の語を断る）はアプリ（src/planning/budget/budget-read-model.mjs）が検査し、
--   DB は JSON のオブジェクトで kind が budget であること・長さ・指紋の形だけを守る。初期値の版（source='seed'）は初期値の定義にだけ足せる。
-- budget_read_approvals: 版ごとの判定（承認・差し戻し）を、版ごとの連番で追加だけ。いまの判定は最後の行。
--   初期値の承認（source='seed'）は人の承認と区別し、作った人を持たない。初期値の承認は初期値の版にだけ付けられる。
-- budget_version_reads: 予算書の版（budget_versions）が、どの定義の版で読まれたか（1つの版に1つまで。budget_version_templates と同じ形）。
--   承認していない版（最後の判定が承認でない版）を結び付けることを DB で断る。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる。

CREATE TABLE IF NOT EXISTS budget_read_profiles (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 source TEXT NOT NULL CHECK(source IN ('seed','member')),
 created_by INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,name),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((source='seed' AND created_by IS NULL) OR (source='member' AND created_by IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS budget_read_profiles_no_update BEFORE UPDATE ON budget_read_profiles BEGIN SELECT RAISE(ABORT,'budget read record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_read_profiles_no_delete BEFORE DELETE ON budget_read_profiles BEGIN SELECT RAISE(ABORT,'budget read record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_read_profiles_author_idx ON budget_read_profiles(org_id,created_by);

CREATE TABLE IF NOT EXISTS budget_read_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 profile_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 definition_json TEXT NOT NULL CHECK(length(definition_json) BETWEEN 2 AND 32768 AND json_valid(definition_json)
  AND json_type(definition_json)='object' AND json_extract(definition_json,'$.kind')='budget'),
 definition_hash TEXT NOT NULL CHECK(length(definition_hash)=64 AND ltrim(definition_hash,'0123456789abcdef')=''),
 source TEXT NOT NULL CHECK(source IN ('seed','member')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,profile_id,version_no),
 FOREIGN KEY(org_id,profile_id) REFERENCES budget_read_profiles(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((source='seed' AND created_by IS NULL) OR (source='member' AND created_by IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS budget_read_versions_sequence BEFORE INSERT ON budget_read_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM budget_read_versions v WHERE v.org_id=NEW.org_id AND v.profile_id=NEW.profile_id)
 BEGIN SELECT RAISE(ABORT,'stale budget read version'); END;
CREATE TRIGGER IF NOT EXISTS budget_read_versions_seed_only_seed BEFORE INSERT ON budget_read_versions
 WHEN NEW.source='seed' AND NOT EXISTS(SELECT 1 FROM budget_read_profiles p WHERE p.org_id=NEW.org_id AND p.id=NEW.profile_id AND p.source='seed')
 BEGIN SELECT RAISE(ABORT,'seed version only for seed profile'); END;
CREATE TRIGGER IF NOT EXISTS budget_read_versions_no_update BEFORE UPDATE ON budget_read_versions BEGIN SELECT RAISE(ABORT,'budget read record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_read_versions_no_delete BEFORE DELETE ON budget_read_versions BEGIN SELECT RAISE(ABORT,'budget read record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_read_versions_author_idx ON budget_read_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS budget_read_approvals (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 action TEXT NOT NULL CHECK(action IN ('approve','reject')),
 source TEXT NOT NULL CHECK(source IN ('seed','member')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,version_id,seq),
 FOREIGN KEY(org_id,version_id) REFERENCES budget_read_versions(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((source='seed' AND created_by IS NULL AND action='approve') OR (source='member' AND created_by IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS budget_read_approvals_sequence BEFORE INSERT ON budget_read_approvals
 WHEN NEW.seq<>(SELECT COALESCE(MAX(a.seq),0)+1 FROM budget_read_approvals a WHERE a.org_id=NEW.org_id AND a.version_id=NEW.version_id)
 BEGIN SELECT RAISE(ABORT,'stale budget read approval'); END;
CREATE TRIGGER IF NOT EXISTS budget_read_approvals_seed_only_seed BEFORE INSERT ON budget_read_approvals
 WHEN NEW.source='seed' AND NOT EXISTS(SELECT 1 FROM budget_read_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.version_id AND v.source='seed')
 BEGIN SELECT RAISE(ABORT,'seed approval only for seed version'); END;
CREATE TRIGGER IF NOT EXISTS budget_read_approvals_no_update BEFORE UPDATE ON budget_read_approvals BEGIN SELECT RAISE(ABORT,'budget read record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_read_approvals_no_delete BEFORE DELETE ON budget_read_approvals BEGIN SELECT RAISE(ABORT,'budget read record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_read_approvals_author_idx ON budget_read_approvals(org_id,created_by);

CREATE TABLE IF NOT EXISTS budget_version_reads (
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 read_version_id INTEGER NOT NULL,
 PRIMARY KEY(org_id,version_id),
 FOREIGN KEY(org_id,project_id,version_id) REFERENCES budget_versions(org_id,project_id,id),
 FOREIGN KEY(org_id,read_version_id) REFERENCES budget_read_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS budget_version_reads_approved BEFORE INSERT ON budget_version_reads
 WHEN COALESCE((SELECT a.action FROM budget_read_approvals a WHERE a.org_id=NEW.org_id AND a.version_id=NEW.read_version_id ORDER BY a.seq DESC LIMIT 1),'none')<>'approve'
 BEGIN SELECT RAISE(ABORT,'budget read version not approved'); END;
CREATE TRIGGER IF NOT EXISTS budget_version_reads_no_update BEFORE UPDATE ON budget_version_reads BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_version_reads_no_delete BEFORE DELETE ON budget_version_reads BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_version_reads_read_idx ON budget_version_reads(org_id,read_version_id);
