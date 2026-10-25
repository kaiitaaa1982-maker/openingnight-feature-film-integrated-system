-- プロダクションの撮影の記録（会社ルートの plans/2026-10-22-folder-prod.md の P2・P3・P4。代表 2026-10-24「15時までに使えるように」の最初の一切れ）。
-- 足すだけの移行: 3表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない（day_scene_assignments.outcome も変えない。問い5 A）。
--
-- shooting_scene_results: 撮影の結果（撮影日×シーンごとの連番で追加だけ）。いまの結果は最新の行。割当の ID は保存のたびに変わるので、撮影日とシーンに結ぶ。
--   結果は撮影完了・一部・順延・欠番（SCHED-033）。順延の移し先は同じ作品の別の撮影日（無ければ未割当として残る。プリプロの約束 PR-3）。
-- shooting_day_records: 撮影日の記録の原本（撮影日×種類ごとの連番で追加だけ）。種類は日々スケの確定版・5部署の日報・スクリプター記録。
--   「不要」は理由つきの行で残す（問い6 A の予備日・部署が入らない日）。原本そのものは共通の原本の表（source_documents。移行 0025・調整役の X-1）に置き、
--   この表はその ID を指す（中身・名前・ハッシュを二重に持たない）。番号 0051 は調整役から受け取った（0041 のあとに振り直した）（C:\ONwt\MIGRATION-ORDER.md）。
-- shooting_day_report_items: 日報の項目（申し送り・問題・事故とけが・経費の手がかり・そのほか。数字は持たない。問い4 A）。追加だけで、
--   直しと取り下げは replaces_id で前の行を指す新しい行。いまの項目は、どの行からも指されていない行。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS shooting_scene_results (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 shooting_day_id INTEGER NOT NULL,
 scene_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 result TEXT NOT NULL CHECK(result IN ('shot','partial','postponed','dropped')),
 postponed_to_day_id INTEGER,
 actual_start TEXT CHECK(actual_start IS NULL OR (length(actual_start)=5 AND substr(actual_start,3,1)=':'
  AND ltrim(substr(actual_start,1,2)||substr(actual_start,4,2),'0123456789')='' AND substr(actual_start,1,2)<='29' AND substr(actual_start,4,2)<='59')),
 actual_end TEXT CHECK(actual_end IS NULL OR (length(actual_end)=5 AND substr(actual_end,3,1)=':'
  AND ltrim(substr(actual_end,1,2)||substr(actual_end,4,2),'0123456789')='' AND substr(actual_end,1,2)<='29' AND substr(actual_end,4,2)<='59')),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,shooting_day_id,scene_id,seq),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id,postponed_to_day_id) REFERENCES shooting_days(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(result='postponed' OR postponed_to_day_id IS NULL),
 CHECK(postponed_to_day_id IS NULL OR postponed_to_day_id<>shooting_day_id),
 CHECK(actual_start IS NULL OR actual_end IS NULL OR actual_end>actual_start)
);
CREATE TRIGGER IF NOT EXISTS shooting_scene_results_sequence BEFORE INSERT ON shooting_scene_results
 WHEN NEW.seq<>(SELECT COALESCE(MAX(r.seq),0)+1 FROM shooting_scene_results r WHERE r.org_id=NEW.org_id AND r.shooting_day_id=NEW.shooting_day_id AND r.scene_id=NEW.scene_id)
 BEGIN SELECT RAISE(ABORT,'stale shooting scene result'); END;
CREATE TRIGGER IF NOT EXISTS shooting_scene_results_no_update BEFORE UPDATE ON shooting_scene_results BEGIN SELECT RAISE(ABORT,'shooting record immutable'); END;
CREATE TRIGGER IF NOT EXISTS shooting_scene_results_no_delete BEFORE DELETE ON shooting_scene_results BEGIN SELECT RAISE(ABORT,'shooting record immutable'); END;
CREATE INDEX IF NOT EXISTS shooting_scene_results_work_idx ON shooting_scene_results(org_id,work_id,shooting_day_id);
CREATE INDEX IF NOT EXISTS shooting_scene_results_scene_idx ON shooting_scene_results(org_id,work_id,scene_id);
CREATE INDEX IF NOT EXISTS shooting_scene_results_moved_idx ON shooting_scene_results(org_id,work_id,postponed_to_day_id);
CREATE INDEX IF NOT EXISTS shooting_scene_results_author_idx ON shooting_scene_results(org_id,created_by);

CREATE TABLE IF NOT EXISTS shooting_day_records (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 shooting_day_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('schedule','ad','art','camera','sound','production','script')),
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 status TEXT NOT NULL CHECK(status IN ('placed','not_needed')),
 source_document_id INTEGER,
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,shooting_day_id,kind,seq), UNIQUE(org_id,shooting_day_id,kind,source_document_id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((status='placed' AND source_document_id IS NOT NULL AND reason IS NULL) OR (status='not_needed' AND source_document_id IS NULL AND reason IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS shooting_day_records_sequence BEFORE INSERT ON shooting_day_records
 WHEN NEW.seq<>(SELECT COALESCE(MAX(r.seq),0)+1 FROM shooting_day_records r WHERE r.org_id=NEW.org_id AND r.shooting_day_id=NEW.shooting_day_id AND r.kind=NEW.kind)
 BEGIN SELECT RAISE(ABORT,'stale shooting day record'); END;
CREATE TRIGGER IF NOT EXISTS shooting_day_records_no_update BEFORE UPDATE ON shooting_day_records BEGIN SELECT RAISE(ABORT,'shooting record immutable'); END;
CREATE TRIGGER IF NOT EXISTS shooting_day_records_no_delete BEFORE DELETE ON shooting_day_records BEGIN SELECT RAISE(ABORT,'shooting record immutable'); END;
CREATE INDEX IF NOT EXISTS shooting_day_records_work_idx ON shooting_day_records(org_id,work_id,shooting_day_id);
CREATE INDEX IF NOT EXISTS shooting_day_records_author_idx ON shooting_day_records(org_id,created_by);
CREATE INDEX IF NOT EXISTS shooting_day_records_document_idx ON shooting_day_records(org_id,source_document_id);

CREATE TABLE IF NOT EXISTS shooting_day_report_items (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 shooting_day_id INTEGER NOT NULL,
 department TEXT NOT NULL CHECK(department IN ('ad','art','camera','sound','production')),
 item_type TEXT NOT NULL CHECK(item_type IN ('handover','problem','incident','expense_hint','other')),
 status TEXT NOT NULL CHECK(status IN ('active','withdrawn')),
 body TEXT CHECK(body IS NULL OR length(trim(body)) BETWEEN 1 AND 2000),
 scene_id INTEGER,
 record_id INTEGER,
 replaces_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,replaces_id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
 FOREIGN KEY(org_id,record_id) REFERENCES shooting_day_records(org_id,id),
 FOREIGN KEY(org_id,replaces_id) REFERENCES shooting_day_report_items(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((status='active' AND body IS NOT NULL) OR (status='withdrawn' AND body IS NULL AND replaces_id IS NOT NULL))
);
-- 直しと取り下げは、同じ撮影日・同じ部署の項目だけを指せる
CREATE TRIGGER IF NOT EXISTS shooting_day_report_items_same_day BEFORE INSERT ON shooting_day_report_items
 WHEN NEW.replaces_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shooting_day_report_items p WHERE p.org_id=NEW.org_id AND p.id=NEW.replaces_id
  AND p.shooting_day_id=NEW.shooting_day_id AND p.department=NEW.department AND p.status='active')
 BEGIN SELECT RAISE(ABORT,'report item replaces another day'); END;
-- 原本を指すなら、同じ撮影日の、同じ部署の日報の原本だけ
CREATE TRIGGER IF NOT EXISTS shooting_day_report_items_record BEFORE INSERT ON shooting_day_report_items
 WHEN NEW.record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shooting_day_records r WHERE r.org_id=NEW.org_id AND r.id=NEW.record_id
  AND r.shooting_day_id=NEW.shooting_day_id AND r.kind=NEW.department AND r.status='placed')
 BEGIN SELECT RAISE(ABORT,'report item record mismatch'); END;
CREATE TRIGGER IF NOT EXISTS shooting_day_report_items_no_update BEFORE UPDATE ON shooting_day_report_items BEGIN SELECT RAISE(ABORT,'shooting record immutable'); END;
CREATE TRIGGER IF NOT EXISTS shooting_day_report_items_no_delete BEFORE DELETE ON shooting_day_report_items BEGIN SELECT RAISE(ABORT,'shooting record immutable'); END;
CREATE INDEX IF NOT EXISTS shooting_day_report_items_work_idx ON shooting_day_report_items(org_id,work_id,shooting_day_id);
CREATE INDEX IF NOT EXISTS shooting_day_report_items_scene_idx ON shooting_day_report_items(org_id,work_id,scene_id);
CREATE INDEX IF NOT EXISTS shooting_day_report_items_record_idx ON shooting_day_report_items(org_id,record_id);
CREATE INDEX IF NOT EXISTS shooting_day_report_items_author_idx ON shooting_day_report_items(org_id,created_by);
