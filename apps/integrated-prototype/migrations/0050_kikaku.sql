-- 企画（フォルダ原案 F01。会社ルートの plans/2026-10-22-folder-kikaku.md。要件 docs/requirements/planning/kikaku.md）。
-- 足すだけの移行: 10表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0050 は調整役から受け取った（0038 から振り直した。2026-10-24 17:20）（C:/ONwt/MIGRATION-ORDER.md）。
--
-- 原本は共通の原本の表 source_documents（移行 0025。core #176）に置き、企画の表はその ID を指すだけ。
-- planning_documents: 案件と原本の結び付き（企画書・試算・素材）。企画書の役（下書き／提出版）と提出先・提出日を持つ。
-- planning_profile_versions・planning_profile_people: 企画の項目の版と、版ごとの体制の候補（監督・主演など。状態は候補／交渉中／確定）。
-- planning_trial_versions・planning_trial_rates・planning_trial_lines・planning_trial_investments: 売上試算の3段の型（表紙 → 流通の大別 → 流通の詳細）。
--   版が持つのは入力だけ。売上・権利元収入・回収率・±0 の月は保存せず、src/planning/kikaku/trial-model.mjs が毎回計算する。
--   計画の表4b（案ごとの値）は、行の3つの列（even・good・max）にまとめた。
-- project_owner_versions: 案件の担当者の版（予実が「代表が担当の案件」を読む。約束 Y-2）。
-- planning_materials・planning_facts: 企画書の準備（素材と、AI と壁打ちして抜き出した事実。下書き→確定は新しい行で前を指す）。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。
-- 手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる。

CREATE TABLE IF NOT EXISTS planning_documents (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 document_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('deck','trial','material')),
 role TEXT CHECK(role IS NULL OR role IN ('draft','submitted')),
 submitted_to TEXT CHECK(submitted_to IS NULL OR length(trim(submitted_to)) BETWEEN 1 AND 200),
 submitted_on TEXT CHECK(submitted_on IS NULL OR (length(submitted_on)=10 AND substr(submitted_on,5,1)='-' AND substr(submitted_on,8,1)='-'
  AND ltrim(substr(submitted_on,1,4)||substr(submitted_on,6,2)||substr(submitted_on,9,2),'0123456789')='')),
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(kind='deck' OR role IS NULL),
 CHECK(role='submitted' OR (submitted_to IS NULL AND submitted_on IS NULL)),
 CHECK(role IS NULL OR role<>'submitted' OR submitted_on IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS planning_documents_no_update BEFORE UPDATE ON planning_documents BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_documents_no_delete BEFORE DELETE ON planning_documents BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE INDEX IF NOT EXISTS planning_documents_project_idx ON planning_documents(org_id,project_id);
CREATE INDEX IF NOT EXISTS planning_documents_document_idx ON planning_documents(org_id,document_id);
CREATE INDEX IF NOT EXISTS planning_documents_author_idx ON planning_documents(org_id,created_by);

CREATE TABLE IF NOT EXISTS planning_profile_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 working_title TEXT NOT NULL CHECK(length(trim(working_title)) BETWEEN 1 AND 200),
 origin TEXT NOT NULL CHECK(origin IN ('source','cast','concept','sequel','other')),
 logline TEXT CHECK(logline IS NULL OR length(logline) BETWEEN 1 AND 1000),
 synopsis_short TEXT CHECK(synopsis_short IS NULL OR length(synopsis_short) BETWEEN 1 AND 1000),
 synopsis_long TEXT CHECK(synopsis_long IS NULL OR length(synopsis_long) BETWEEN 1 AND 5000),
 format TEXT CHECK(format IS NULL OR length(trim(format)) BETWEEN 1 AND 100),
 episode_count INTEGER CHECK(episode_count IS NULL OR (typeof(episode_count)='integer' AND episode_count BETWEEN 1 AND 1000)),
 planned_release_year INTEGER CHECK(planned_release_year IS NULL OR (typeof(planned_release_year)='integer' AND planned_release_year BETWEEN 1900 AND 2200)),
 submit_to TEXT CHECK(submit_to IS NULL OR length(trim(submit_to)) BETWEEN 1 AND 200),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,project_id,revision),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS planning_profile_versions_sequence BEFORE INSERT ON planning_profile_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(v.revision),0)+1 FROM planning_profile_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id)
 BEGIN SELECT RAISE(ABORT,'stale planning profile'); END;
CREATE TRIGGER IF NOT EXISTS planning_profile_versions_no_update BEFORE UPDATE ON planning_profile_versions BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_profile_versions_no_delete BEFORE DELETE ON planning_profile_versions BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE INDEX IF NOT EXISTS planning_profile_versions_author_idx ON planning_profile_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS planning_profile_people (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 1 AND 100),
 role TEXT NOT NULL CHECK(role IN ('director','writer','lead','support','producer','studio','other')),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 status TEXT NOT NULL CHECK(status IN ('candidate','negotiating','confirmed')),
 UNIQUE(org_id,version_id,position),
 FOREIGN KEY(org_id,version_id) REFERENCES planning_profile_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS planning_profile_people_no_update BEFORE UPDATE ON planning_profile_people BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_profile_people_no_delete BEFORE DELETE ON planning_profile_people BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;

CREATE TABLE IF NOT EXISTS planning_trial_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 cost_total_yen INTEGER NOT NULL CHECK(typeof(cost_total_yen)='integer' AND cost_total_yen BETWEEN 0 AND 1000000000000),
 first_month TEXT NOT NULL CHECK(length(first_month)=7 AND substr(first_month,5,1)='-' AND ltrim(substr(first_month,1,4)||substr(first_month,6,2),'0123456789')=''
  AND substr(first_month,6,2) BETWEEN '01' AND '12'),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('screen','template','copy','file')),
 document_id INTEGER,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,project_id,revision),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((source_kind='file' AND document_id IS NOT NULL) OR source_kind<>'file')
);
CREATE TRIGGER IF NOT EXISTS planning_trial_versions_sequence BEFORE INSERT ON planning_trial_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(v.revision),0)+1 FROM planning_trial_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id)
 BEGIN SELECT RAISE(ABORT,'stale planning trial'); END;
CREATE TRIGGER IF NOT EXISTS planning_trial_versions_no_update BEFORE UPDATE ON planning_trial_versions BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_trial_versions_no_delete BEFORE DELETE ON planning_trial_versions BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE INDEX IF NOT EXISTS planning_trial_versions_document_idx ON planning_trial_versions(org_id,document_id);
CREATE INDEX IF NOT EXISTS planning_trial_versions_author_idx ON planning_trial_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS planning_trial_rates (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 type_code TEXT NOT NULL CHECK(type_code IN ('THEA','EVNT','PVOD','EST','TVOD','SVOD','AVOD','BIZ','BCST','SELL','RENT','OVS','GOOD')),
 share_bps INTEGER NOT NULL CHECK(typeof(share_bps)='integer' AND share_bps BETWEEN 0 AND 10000),
 fee_bps INTEGER NOT NULL CHECK(typeof(fee_bps)='integer' AND fee_bps BETWEEN 0 AND 10000),
 original_royalty_bps INTEGER NOT NULL CHECK(typeof(original_royalty_bps)='integer' AND original_royalty_bps BETWEEN 0 AND 10000),
 creator_royalty_bps INTEGER NOT NULL CHECK(typeof(creator_royalty_bps)='integer' AND creator_royalty_bps BETWEEN 0 AND 10000),
 unit_cost_yen INTEGER NOT NULL CHECK(typeof(unit_cost_yen)='integer' AND unit_cost_yen BETWEEN 0 AND 100000000),
 source TEXT CHECK(source IS NULL OR length(trim(source)) BETWEEN 1 AND 200),
 UNIQUE(org_id,version_id,type_code),
 FOREIGN KEY(org_id,version_id) REFERENCES planning_trial_versions(org_id,id),
 CHECK(fee_bps+original_royalty_bps+creator_royalty_bps<=10000)
);
CREATE TRIGGER IF NOT EXISTS planning_trial_rates_no_update BEFORE UPDATE ON planning_trial_rates BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_trial_rates_no_delete BEFORE DELETE ON planning_trial_rates BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;

CREATE TABLE IF NOT EXISTS planning_trial_lines (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 500),
 type_code TEXT NOT NULL CHECK(type_code IN ('THEA','EVNT','PVOD','EST','TVOD','SVOD','AVOD','BIZ','BCST','SELL','RENT','OVS','GOOD')),
 partner_name TEXT NOT NULL CHECK(length(trim(partner_name)) BETWEEN 1 AND 200),
 window_label TEXT CHECK(window_label IS NULL OR length(trim(window_label)) BETWEEN 1 AND 100),
 start_month TEXT NOT NULL CHECK(length(start_month)=7 AND substr(start_month,5,1)='-' AND ltrim(substr(start_month,1,4)||substr(start_month,6,2),'0123456789')=''
  AND substr(start_month,6,2) BETWEEN '01' AND '12'),
 months INTEGER NOT NULL CHECK(typeof(months)='integer' AND months BETWEEN 1 AND 120),
 calc TEXT NOT NULL CHECK(calc IN ('unit','fixed')),
 unit_price_yen INTEGER NOT NULL CHECK(typeof(unit_price_yen)='integer' AND unit_price_yen BETWEEN 0 AND 100000000),
 even_value INTEGER NOT NULL CHECK(typeof(even_value)='integer' AND even_value BETWEEN 0 AND 1000000000000),
 good_value INTEGER NOT NULL CHECK(typeof(good_value)='integer' AND good_value BETWEEN 0 AND 1000000000000),
 max_value INTEGER NOT NULL CHECK(typeof(max_value)='integer' AND max_value BETWEEN 0 AND 1000000000000),
 source TEXT CHECK(source IS NULL OR length(trim(source)) BETWEEN 1 AND 200),
 previous_sales_yen INTEGER CHECK(previous_sales_yen IS NULL OR (typeof(previous_sales_yen)='integer' AND previous_sales_yen BETWEEN 0 AND 1000000000000)),
 UNIQUE(org_id,version_id,line_no),
 FOREIGN KEY(org_id,version_id) REFERENCES planning_trial_versions(org_id,id),
 CHECK(calc='fixed' OR unit_price_yen>0)
);
CREATE TRIGGER IF NOT EXISTS planning_trial_lines_no_update BEFORE UPDATE ON planning_trial_lines BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_trial_lines_no_delete BEFORE DELETE ON planning_trial_lines BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;

CREATE TABLE IF NOT EXISTS planning_trial_investments (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq BETWEEN 1 AND 100),
 month TEXT NOT NULL CHECK(length(month)=7 AND substr(month,5,1)='-' AND ltrim(substr(month,1,4)||substr(month,6,2),'0123456789')='' AND substr(month,6,2) BETWEEN '01' AND '12'),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 1000000000000),
 UNIQUE(org_id,version_id,seq),
 FOREIGN KEY(org_id,version_id) REFERENCES planning_trial_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS planning_trial_investments_no_update BEFORE UPDATE ON planning_trial_investments BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_trial_investments_no_delete BEFORE DELETE ON planning_trial_investments BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;

CREATE TABLE IF NOT EXISTS project_owner_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 user_id INTEGER NOT NULL,
 started_on TEXT NOT NULL CHECK(length(started_on)=10 AND substr(started_on,5,1)='-' AND substr(started_on,8,1)='-'
  AND ltrim(substr(started_on,1,4)||substr(started_on,6,2)||substr(started_on,9,2),'0123456789')=''),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,project_id,revision),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS project_owner_versions_sequence BEFORE INSERT ON project_owner_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(v.revision),0)+1 FROM project_owner_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id)
 BEGIN SELECT RAISE(ABORT,'stale project owner'); END;
CREATE TRIGGER IF NOT EXISTS project_owner_versions_no_update BEFORE UPDATE ON project_owner_versions BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS project_owner_versions_no_delete BEFORE DELETE ON project_owner_versions BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE INDEX IF NOT EXISTS project_owner_versions_user_idx ON project_owner_versions(org_id,user_id);
CREATE INDEX IF NOT EXISTS project_owner_versions_author_idx ON project_owner_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS planning_materials (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('similar','market','own_record','cast','director','world','story','title','report','other')),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 240),
 label TEXT NOT NULL CHECK(label IN ('confirmed','probable','unknown')),
 source TEXT CHECK(source IS NULL OR length(trim(source)) BETWEEN 1 AND 1000),
 url TEXT CHECK(url IS NULL OR (length(url) BETWEEN 8 AND 2000 AND (substr(url,1,8)='https://' OR substr(url,1,7)='http://'))),
 document_id INTEGER,
 acquired_on TEXT CHECK(acquired_on IS NULL OR (length(acquired_on)=10 AND substr(acquired_on,5,1)='-' AND substr(acquired_on,8,1)='-'
  AND ltrim(substr(acquired_on,1,4)||substr(acquired_on,6,2)||substr(acquired_on,9,2),'0123456789')='')),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,project_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS planning_materials_no_update BEFORE UPDATE ON planning_materials BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_materials_no_delete BEFORE DELETE ON planning_materials BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE INDEX IF NOT EXISTS planning_materials_document_idx ON planning_materials(org_id,document_id);
CREATE INDEX IF NOT EXISTS planning_materials_author_idx ON planning_materials(org_id,created_by);

CREATE TABLE IF NOT EXISTS planning_facts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 material_id INTEGER,
 body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
 value_int INTEGER CHECK(value_int IS NULL OR typeof(value_int)='integer'),
 label TEXT NOT NULL CHECK(label IN ('confirmed','probable','unknown')),
 target TEXT NOT NULL CHECK(target IN ('deck_text','trial','team','case')),
 pages TEXT NOT NULL CHECK(length(pages) BETWEEN 1 AND 200 AND ltrim(pages,'0123456789,')=''),
 state TEXT NOT NULL CHECK(state IN ('ai_draft','human_confirmed')),
 previous_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,project_id,id), UNIQUE(org_id,previous_id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,project_id,material_id) REFERENCES planning_materials(org_id,project_id,id),
 FOREIGN KEY(org_id,project_id,previous_id) REFERENCES planning_facts(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS planning_facts_no_update BEFORE UPDATE ON planning_facts BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE TRIGGER IF NOT EXISTS planning_facts_no_delete BEFORE DELETE ON planning_facts BEGIN SELECT RAISE(ABORT,'planning record immutable'); END;
CREATE INDEX IF NOT EXISTS planning_facts_project_idx ON planning_facts(org_id,project_id);
CREATE INDEX IF NOT EXISTS planning_facts_author_idx ON planning_facts(org_id,created_by);
