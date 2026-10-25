-- プロデュース管理の進行表（要件 docs/requirements/planning/produce-progress.md の FR-PLAN-PRODUCE。会社ルートの plans/2026-10-22-folder-produce.md）。
-- 足すだけの移行: 7表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0047 は調整役から受け取った（MIGRATION-ORDER.md）。
--
-- produce_tasks: 進行表のチケットの版。チケットは案件に付き（作品は任意。脚本開発は作品ができる前から始まる）、直すたびに同じ task_uid で版を足す。
--   最新の版が有効。やめたチケットは retired=1 の版。種類は作業・チェック・節目。節目のチケットは1日（開始＝終了）。
--   第一切れは節目の日もチケットに持つ（節目の予定の版の表 produce_milestone_plans は次の切れ。計画の決定ログ 2026-10-24）。
-- produce_task_events: 着手・完了・戻すの記録。状態の列は持たず、予定と記録から導く。
-- produce_task_checks: チェック項目。チェックを入れる・外すたびに同じ check_uid で行を足し、最新の行が有効。
-- produce_task_posts: 掲示板の書き込み（発言者は呼び名の文字。まずは代表1人が入力する前提）。直すときは新しい書き込みで書く。
-- produce_task_links: 関連する場所（業務の画面やフォルダへのリンク）。写しは持たない。外すのは removed=1 の行。
-- produce_task_templates / produce_task_template_items: 組織で使い回すテンプレートの版と行。行は起点（クランクイン）からの日数で持つ。
--   標準の進行（代表の19項目と節目「初号」）はコードの定数（src/planning/produce/produce-model.mjs）に持ち、ここには利用者が残したテンプレートだけが入る。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。形の CHECK は GLOB を使わない。
-- 手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる（0024 のあと。0025〜0033 の別の業務の移行とは表がぶつからない）。

CREATE TABLE IF NOT EXISTS produce_tasks (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER,
 task_uid INTEGER NOT NULL CHECK(typeof(task_uid)='integer' AND task_uid>0),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 kind TEXT NOT NULL CHECK(kind IN ('work','check','milestone')),
 phase TEXT NOT NULL CHECK(phase IN ('script','prep','shoot','post','delivery','finance')),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 role TEXT NOT NULL CHECK(role IN ('producer','line_producer')),
 assignee_label TEXT CHECK(assignee_label IS NULL OR length(trim(assignee_label)) BETWEEN 1 AND 60),
 checkers TEXT CHECK(checkers IS NULL OR length(trim(checkers)) BETWEEN 1 AND 200),
 planned_start TEXT NOT NULL CHECK(length(planned_start)=10 AND substr(planned_start,5,1)='-' AND substr(planned_start,8,1)='-'
  AND ltrim(substr(planned_start,1,4)||substr(planned_start,6,2)||substr(planned_start,9,2),'0123456789')=''),
 planned_end TEXT NOT NULL CHECK(length(planned_end)=10 AND substr(planned_end,5,1)='-' AND substr(planned_end,8,1)='-'
  AND ltrim(substr(planned_end,1,4)||substr(planned_end,6,2)||substr(planned_end,9,2),'0123456789')=''),
 milestone_code TEXT CHECK(milestone_code IS NULL OR milestone_code IN ('kikaku_go','crank_in','crank_up','edit_lock','sound_mix','first_print','final_screening','release','delivery')),
 template_label TEXT CHECK(template_label IS NULL OR length(trim(template_label)) BETWEEN 1 AND 120),
 retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,task_uid,version_no),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(planned_end>=planned_start),
 CHECK(kind<>'milestone' OR planned_end=planned_start),
 CHECK(version_no=1 OR reason IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS produce_tasks_sequence BEFORE INSERT ON produce_tasks
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(t.version_no),0)+1 FROM produce_tasks t WHERE t.org_id=NEW.org_id AND t.task_uid=NEW.task_uid)
 BEGIN SELECT RAISE(ABORT,'stale produce task'); END;
CREATE TRIGGER IF NOT EXISTS produce_tasks_same_project BEFORE INSERT ON produce_tasks
 WHEN NEW.version_no>1 AND NOT EXISTS(SELECT 1 FROM produce_tasks t WHERE t.org_id=NEW.org_id AND t.task_uid=NEW.task_uid AND t.version_no=1 AND t.project_id=NEW.project_id)
 BEGIN SELECT RAISE(ABORT,'produce task project mismatch'); END;
CREATE TRIGGER IF NOT EXISTS produce_tasks_no_update BEFORE UPDATE ON produce_tasks BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE TRIGGER IF NOT EXISTS produce_tasks_no_delete BEFORE DELETE ON produce_tasks BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE INDEX IF NOT EXISTS produce_tasks_project_idx ON produce_tasks(org_id,project_id,task_uid);
CREATE INDEX IF NOT EXISTS produce_tasks_work_idx ON produce_tasks(org_id,project_id,work_id);
CREATE INDEX IF NOT EXISTS produce_tasks_author_idx ON produce_tasks(org_id,created_by);

CREATE TABLE IF NOT EXISTS produce_task_events (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 task_uid INTEGER NOT NULL CHECK(typeof(task_uid)='integer' AND task_uid>0),
 kind TEXT NOT NULL CHECK(kind IN ('started','done','reopened')),
 on_date TEXT NOT NULL CHECK(length(on_date)=10 AND substr(on_date,5,1)='-' AND substr(on_date,8,1)='-'
  AND ltrim(substr(on_date,1,4)||substr(on_date,6,2)||substr(on_date,9,2),'0123456789')=''),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS produce_task_events_task BEFORE INSERT ON produce_task_events
 WHEN NOT EXISTS(SELECT 1 FROM produce_tasks t WHERE t.org_id=NEW.org_id AND t.project_id=NEW.project_id AND t.task_uid=NEW.task_uid)
 BEGIN SELECT RAISE(ABORT,'produce task not found'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_events_no_update BEFORE UPDATE ON produce_task_events BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_events_no_delete BEFORE DELETE ON produce_task_events BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE INDEX IF NOT EXISTS produce_task_events_task_idx ON produce_task_events(org_id,project_id,task_uid);
CREATE INDEX IF NOT EXISTS produce_task_events_author_idx ON produce_task_events(org_id,created_by);

CREATE TABLE IF NOT EXISTS produce_task_checks (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 task_uid INTEGER NOT NULL CHECK(typeof(task_uid)='integer' AND task_uid>0),
 check_uid INTEGER NOT NULL CHECK(typeof(check_uid)='integer' AND check_uid>0),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200),
 checked INTEGER NOT NULL CHECK(checked IN (0,1)),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS produce_task_checks_task BEFORE INSERT ON produce_task_checks
 WHEN NOT EXISTS(SELECT 1 FROM produce_tasks t WHERE t.org_id=NEW.org_id AND t.project_id=NEW.project_id AND t.task_uid=NEW.task_uid)
 BEGIN SELECT RAISE(ABORT,'produce task not found'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_checks_no_update BEFORE UPDATE ON produce_task_checks BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_checks_no_delete BEFORE DELETE ON produce_task_checks BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE INDEX IF NOT EXISTS produce_task_checks_task_idx ON produce_task_checks(org_id,project_id,task_uid,check_uid);
CREATE INDEX IF NOT EXISTS produce_task_checks_author_idx ON produce_task_checks(org_id,created_by);

CREATE TABLE IF NOT EXISTS produce_task_posts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 task_uid INTEGER NOT NULL CHECK(typeof(task_uid)='integer' AND task_uid>0),
 speaker_label TEXT NOT NULL CHECK(length(trim(speaker_label)) BETWEEN 1 AND 40),
 body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS produce_task_posts_task BEFORE INSERT ON produce_task_posts
 WHEN NOT EXISTS(SELECT 1 FROM produce_tasks t WHERE t.org_id=NEW.org_id AND t.project_id=NEW.project_id AND t.task_uid=NEW.task_uid)
 BEGIN SELECT RAISE(ABORT,'produce task not found'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_posts_no_update BEFORE UPDATE ON produce_task_posts BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_posts_no_delete BEFORE DELETE ON produce_task_posts BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE INDEX IF NOT EXISTS produce_task_posts_task_idx ON produce_task_posts(org_id,project_id,task_uid);
CREATE INDEX IF NOT EXISTS produce_task_posts_author_idx ON produce_task_posts(org_id,created_by);

CREATE TABLE IF NOT EXISTS produce_task_links (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 task_uid INTEGER NOT NULL CHECK(typeof(task_uid)='integer' AND task_uid>0),
 link_uid INTEGER NOT NULL CHECK(typeof(link_uid)='integer' AND link_uid>0),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 120),
 target TEXT NOT NULL CHECK(length(trim(target)) BETWEEN 1 AND 500),
 is_fallback INTEGER NOT NULL DEFAULT 0 CHECK(is_fallback IN (0,1)),
 removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS produce_task_links_task BEFORE INSERT ON produce_task_links
 WHEN NOT EXISTS(SELECT 1 FROM produce_tasks t WHERE t.org_id=NEW.org_id AND t.project_id=NEW.project_id AND t.task_uid=NEW.task_uid)
 BEGIN SELECT RAISE(ABORT,'produce task not found'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_links_no_update BEFORE UPDATE ON produce_task_links BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_links_no_delete BEFORE DELETE ON produce_task_links BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE INDEX IF NOT EXISTS produce_task_links_task_idx ON produce_task_links(org_id,project_id,task_uid,link_uid);
CREATE INDEX IF NOT EXISTS produce_task_links_author_idx ON produce_task_links(org_id,created_by);

CREATE TABLE IF NOT EXISTS produce_task_templates (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 template_uid INTEGER NOT NULL CHECK(typeof(template_uid)='integer' AND template_uid>0),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 anchor_kind TEXT NOT NULL CHECK(anchor_kind IN ('crank_in','project_start')),
 retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,template_uid,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(version_no=1 OR reason IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS produce_task_templates_sequence BEFORE INSERT ON produce_task_templates
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(t.version_no),0)+1 FROM produce_task_templates t WHERE t.org_id=NEW.org_id AND t.template_uid=NEW.template_uid)
 BEGIN SELECT RAISE(ABORT,'stale produce template'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_templates_no_update BEFORE UPDATE ON produce_task_templates BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_templates_no_delete BEFORE DELETE ON produce_task_templates BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE INDEX IF NOT EXISTS produce_task_templates_author_idx ON produce_task_templates(org_id,created_by);

CREATE TABLE IF NOT EXISTS produce_task_template_items (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 template_id INTEGER NOT NULL,
 sort_no INTEGER NOT NULL CHECK(typeof(sort_no)='integer' AND sort_no BETWEEN 1 AND 500),
 kind TEXT NOT NULL CHECK(kind IN ('work','check','milestone')),
 phase TEXT NOT NULL CHECK(phase IN ('script','prep','shoot','post','delivery','finance')),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 role TEXT NOT NULL CHECK(role IN ('producer','line_producer')),
 checkers TEXT CHECK(checkers IS NULL OR length(trim(checkers)) BETWEEN 1 AND 200),
 start_offset_days INTEGER NOT NULL CHECK(typeof(start_offset_days)='integer' AND start_offset_days BETWEEN -3650 AND 3650),
 end_offset_days INTEGER NOT NULL CHECK(typeof(end_offset_days)='integer' AND end_offset_days BETWEEN -3650 AND 3650),
 milestone_code TEXT CHECK(milestone_code IS NULL OR milestone_code IN ('kikaku_go','crank_in','crank_up','edit_lock','sound_mix','first_print','final_screening','release','delivery')),
 links_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links_json) AND json_type(links_json)='array' AND length(links_json)<=4000),
 UNIQUE(org_id,id), UNIQUE(org_id,template_id,sort_no),
 FOREIGN KEY(org_id,template_id) REFERENCES produce_task_templates(org_id,id),
 CHECK(end_offset_days>=start_offset_days),
 CHECK(kind<>'milestone' OR end_offset_days=start_offset_days)
);
CREATE TRIGGER IF NOT EXISTS produce_task_template_items_no_update BEFORE UPDATE ON produce_task_template_items BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE TRIGGER IF NOT EXISTS produce_task_template_items_no_delete BEFORE DELETE ON produce_task_template_items BEGIN SELECT RAISE(ABORT,'produce record immutable'); END;
CREATE INDEX IF NOT EXISTS produce_task_template_items_template_idx ON produce_task_template_items(org_id,template_id);
