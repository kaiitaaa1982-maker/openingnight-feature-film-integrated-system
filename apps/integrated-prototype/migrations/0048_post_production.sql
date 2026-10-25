-- ポストプロダクションの最初の切れ（会社ルートの plans/2026-10-22-folder-postprod.md の第3版。要件 docs/requirements/production/post-production.md）。
-- 足すだけの移行: 7表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0048 は調整役から受け取った。
--
-- post_cuts: 編集の版（P1）。作品・話ごとに版を積む。視聴のリンク（Vimeo の非公開リンクなど。https だけ）を持つ。合言葉は持たない。
-- post_notes: 指摘（P3）。版を見て出た「TC・観点・誰から（立場の語）・担当・内容」の構造化されたメモ。人の名前は持たない。
-- post_note_actions: 指摘への対応（P4。直した・見送り・保留・戻す）。指摘の今の状態は最後の行から導く。見送りは理由が必須。
-- post_tasks: 工程のタスク（P15）。工程・話・名前・期日。済んだか・期日の変更は post_task_events に行を足して導く。
-- post_deliverable_items: 納品物の行（P10）。契約の納入の条項・取引先の納品ガイド・手で足した行。委員会の契約は条件版を指せる（約束 CM-1）。
--   取引先への納品の約束（sales_deliverables）を指せる（約束 E-4。ポスプロ → 営業の向きだけ）。
-- post_deliverable_events: 納品物の状態の記録（未・制作中・確認中・要再納品・納品済み）。今の状態は最後の行から導く。
-- 声のメモと原本の結び付きは、共通の原本の表（source_documents）が入ってから足す。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる（0024 のあと）。

CREATE TABLE IF NOT EXISTS post_cuts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 episode_no INTEGER CHECK(episode_no IS NULL OR (typeof(episode_no)='integer' AND episode_no BETWEEN 1 AND 999)),
 variant TEXT CHECK(variant IS NULL OR length(trim(variant)) BETWEEN 1 AND 60),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 40),
 kind TEXT NOT NULL CHECK(kind IN ('work','locked','final')),
 delivered_on TEXT CHECK(delivered_on IS NULL OR (length(delivered_on)=10 AND substr(delivered_on,5,1)='-' AND substr(delivered_on,8,1)='-'
  AND ltrim(substr(delivered_on,1,4)||substr(delivered_on,6,2)||substr(delivered_on,9,2),'0123456789')='')),
 runtime_seconds INTEGER CHECK(runtime_seconds IS NULL OR (typeof(runtime_seconds)='integer' AND runtime_seconds BETWEEN 1 AND 86400)),
 review_url TEXT CHECK(review_url IS NULL OR (length(review_url) BETWEEN 12 AND 500 AND substr(review_url,1,8)='https://')),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS post_cuts_no_update BEFORE UPDATE ON post_cuts BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE TRIGGER IF NOT EXISTS post_cuts_no_delete BEFORE DELETE ON post_cuts BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE INDEX IF NOT EXISTS post_cuts_work_idx ON post_cuts(org_id,project_id,work_id);
CREATE INDEX IF NOT EXISTS post_cuts_author_idx ON post_cuts(org_id,created_by);

CREATE TABLE IF NOT EXISTS post_notes (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 cut_id INTEGER NOT NULL,
 tc_in_seconds INTEGER NOT NULL CHECK(typeof(tc_in_seconds)='integer' AND tc_in_seconds BETWEEN 0 AND 86400),
 tc_out_seconds INTEGER CHECK(tc_out_seconds IS NULL OR (typeof(tc_out_seconds)='integer' AND tc_out_seconds BETWEEN 0 AND 86400)),
 viewpoint TEXT NOT NULL CHECK(length(trim(viewpoint)) BETWEEN 1 AND 40),
 from_role TEXT NOT NULL CHECK(length(trim(from_role)) BETWEEN 1 AND 40),
 assignee TEXT NOT NULL CHECK(length(trim(assignee)) BETWEEN 1 AND 40),
 body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id,cut_id) REFERENCES post_cuts(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(tc_out_seconds IS NULL OR tc_out_seconds>=tc_in_seconds)
);
CREATE TRIGGER IF NOT EXISTS post_notes_no_update BEFORE UPDATE ON post_notes BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE TRIGGER IF NOT EXISTS post_notes_no_delete BEFORE DELETE ON post_notes BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE INDEX IF NOT EXISTS post_notes_cut_idx ON post_notes(org_id,work_id,cut_id);
CREATE INDEX IF NOT EXISTS post_notes_author_idx ON post_notes(org_id,created_by);

CREATE TABLE IF NOT EXISTS post_note_actions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 note_id INTEGER NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('fixed','skipped','hold','reopen')),
 fixed_cut_id INTEGER,
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,work_id,note_id) REFERENCES post_notes(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id,fixed_cut_id) REFERENCES post_cuts(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(result<>'skipped' OR reason IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS post_note_actions_no_update BEFORE UPDATE ON post_note_actions BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE TRIGGER IF NOT EXISTS post_note_actions_no_delete BEFORE DELETE ON post_note_actions BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE INDEX IF NOT EXISTS post_note_actions_note_idx ON post_note_actions(org_id,work_id,note_id);
CREATE INDEX IF NOT EXISTS post_note_actions_cut_idx ON post_note_actions(org_id,work_id,fixed_cut_id);
CREATE INDEX IF NOT EXISTS post_note_actions_author_idx ON post_note_actions(org_id,created_by);

CREATE TABLE IF NOT EXISTS post_tasks (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('edit','sound','color','screening','final_screening','delivery','other')),
 episode_no INTEGER CHECK(episode_no IS NULL OR (typeof(episode_no)='integer' AND episode_no BETWEEN 1 AND 999)),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 due_on TEXT CHECK(due_on IS NULL OR (length(due_on)=10 AND substr(due_on,5,1)='-' AND substr(due_on,8,1)='-'
  AND ltrim(substr(due_on,1,4)||substr(due_on,6,2)||substr(due_on,9,2),'0123456789')='')),
 assignee TEXT CHECK(assignee IS NULL OR length(trim(assignee)) BETWEEN 1 AND 60),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS post_tasks_no_update BEFORE UPDATE ON post_tasks BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE TRIGGER IF NOT EXISTS post_tasks_no_delete BEFORE DELETE ON post_tasks BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE INDEX IF NOT EXISTS post_tasks_work_idx ON post_tasks(org_id,project_id,work_id);
CREATE INDEX IF NOT EXISTS post_tasks_author_idx ON post_tasks(org_id,created_by);

CREATE TABLE IF NOT EXISTS post_task_events (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 task_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('done','undone','due')),
 due_on TEXT CHECK(due_on IS NULL OR (length(due_on)=10 AND substr(due_on,5,1)='-' AND substr(due_on,8,1)='-'
  AND ltrim(substr(due_on,1,4)||substr(due_on,6,2)||substr(due_on,9,2),'0123456789')='')),
 on_date TEXT NOT NULL CHECK(length(on_date)=10 AND substr(on_date,5,1)='-' AND substr(on_date,8,1)='-'
  AND ltrim(substr(on_date,1,4)||substr(on_date,6,2)||substr(on_date,9,2),'0123456789')=''),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,work_id,task_id) REFERENCES post_tasks(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((kind='due' AND due_on IS NOT NULL) OR (kind<>'due' AND due_on IS NULL))
);
CREATE TRIGGER IF NOT EXISTS post_task_events_no_update BEFORE UPDATE ON post_task_events BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE TRIGGER IF NOT EXISTS post_task_events_no_delete BEFORE DELETE ON post_task_events BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE INDEX IF NOT EXISTS post_task_events_task_idx ON post_task_events(org_id,work_id,task_id);
CREATE INDEX IF NOT EXISTS post_task_events_author_idx ON post_task_events(org_id,created_by);

CREATE TABLE IF NOT EXISTS post_deliverable_items (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('contract','guide','manual')),
 committee_contract_id INTEGER,
 committee_term_version_id INTEGER,
 sales_deliverable_id INTEGER,
 section TEXT CHECK(section IS NULL OR length(trim(section)) BETWEEN 1 AND 40),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 episode_no INTEGER CHECK(episode_no IS NULL OR (typeof(episode_no)='integer' AND episode_no BETWEEN 1 AND 999)),
 spec TEXT CHECK(spec IS NULL OR length(trim(spec)) BETWEEN 1 AND 1000),
 owner TEXT CHECK(owner IS NULL OR length(trim(owner)) BETWEEN 1 AND 40),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,committee_contract_id,committee_term_version_id) REFERENCES committee_term_versions(org_id,contract_id,id),
 FOREIGN KEY(org_id,sales_deliverable_id) REFERENCES sales_deliverables(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(committee_term_version_id IS NULL OR committee_contract_id IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS post_deliverable_items_no_update BEFORE UPDATE ON post_deliverable_items BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE TRIGGER IF NOT EXISTS post_deliverable_items_no_delete BEFORE DELETE ON post_deliverable_items BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE INDEX IF NOT EXISTS post_deliverable_items_work_idx ON post_deliverable_items(org_id,project_id,work_id);
CREATE INDEX IF NOT EXISTS post_deliverable_items_term_idx ON post_deliverable_items(org_id,committee_contract_id,committee_term_version_id);
CREATE INDEX IF NOT EXISTS post_deliverable_items_sales_idx ON post_deliverable_items(org_id,sales_deliverable_id);
CREATE INDEX IF NOT EXISTS post_deliverable_items_author_idx ON post_deliverable_items(org_id,created_by);

CREATE TABLE IF NOT EXISTS post_deliverable_events (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 item_id INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','making','in_review','redo','delivered')),
 on_date TEXT NOT NULL CHECK(length(on_date)=10 AND substr(on_date,5,1)='-' AND substr(on_date,8,1)='-'
  AND ltrim(substr(on_date,1,4)||substr(on_date,6,2)||substr(on_date,9,2),'0123456789')=''),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,work_id,item_id) REFERENCES post_deliverable_items(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS post_deliverable_events_no_update BEFORE UPDATE ON post_deliverable_events BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE TRIGGER IF NOT EXISTS post_deliverable_events_no_delete BEFORE DELETE ON post_deliverable_events BEGIN SELECT RAISE(ABORT,'post record immutable'); END;
CREATE INDEX IF NOT EXISTS post_deliverable_events_item_idx ON post_deliverable_events(org_id,work_id,item_id);
CREATE INDEX IF NOT EXISTS post_deliverable_events_author_idx ON post_deliverable_events(org_id,created_by);
