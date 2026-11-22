-- 撮影の結果を AI が入れるときの、香盤の読みの記録と、結果の行と読みの束の結び（会社ルートの plans/2026-11-20-genba-inbox.md の手順7。
-- 決まりは brain の D-047 の3・4・7。要件 docs/requirements/production/schedule-commit.md の FR-PROD-SCHED-103〜）。
-- 足すだけの移行: 2表と、その表だけのトリガーを作る。既存の表（shooting_scene_results ほか）の列・制約・トリガーは変えない。番号 0069 は仮（調整役が決める）。
--
-- shooting_scene_reads: 香盤の読みの記録（追記だけ）。1回の取り込み（読みの束。read_key）で、撮影日×シーンごとに独立した2回の読みを持つ。
--   読んだ結果は shot（撮れた）・partial（一部）・not_shot（撮れず）・unreadable（読めず）。読んだモデルの名前を必ず残す。
--   (鍵, シーン, 何回目) は組織で一意（同じ取り込みを2回入れない）。1つの鍵は1つの撮影日だけ。2回目は、同じ鍵・同じシーンの1回目と別のモデルの読みだけ。
--   prior_result_seq は、読みを入れたときのその撮影日×シーンの結果の連番の最大（無ければ 0）。読みのあとに人が足した結果の行を、時刻でなく連番で見分ける。
-- shooting_scene_result_reads: 撮影の結果の行（shooting_scene_results）と読みの束の結び（追記だけ）。AI が入れた結果の行だけがこの行を持つ。
--   結べるのは、同じ撮影日・同じシーンで、別のモデルの2回の読みが同じ結果（読めず を除く）に一致し、その結果を撮影の結果に読み替えた値
--   （shot → shot、partial → partial、not_shot → 移し先の無い postponed）の行だけ（トリガーが断る）。1つの束は1つのシーンに1行まで。
-- 人が確かめたかは列に持たず、AI の結果の行より後に、結びの無い（人の）結果の行があるかで導く。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる。

CREATE TABLE IF NOT EXISTS shooting_scene_reads (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 shooting_day_id INTEGER NOT NULL,
 scene_id INTEGER NOT NULL,
 read_key TEXT NOT NULL CHECK(length(read_key) BETWEEN 1 AND 100
  AND ltrim(read_key,'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.:')=''),
 read_no INTEGER NOT NULL CHECK(typeof(read_no)='integer' AND read_no IN (1,2)),
 model TEXT NOT NULL CHECK(length(trim(model)) BETWEEN 1 AND 100),
 reading TEXT NOT NULL CHECK(reading IN ('shot','partial','not_shot','unreadable')),
 prior_result_seq INTEGER NOT NULL CHECK(typeof(prior_result_seq)='integer' AND prior_result_seq>=0),
 source_document_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,read_key,scene_id,read_no),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 1つの束（鍵）は1つの撮影日だけ
CREATE TRIGGER IF NOT EXISTS shooting_scene_reads_one_day BEFORE INSERT ON shooting_scene_reads
 WHEN EXISTS(SELECT 1 FROM shooting_scene_reads p WHERE p.org_id=NEW.org_id AND p.read_key=NEW.read_key AND p.shooting_day_id<>NEW.shooting_day_id)
 BEGIN SELECT RAISE(ABORT,'scene read key spans days'); END;
-- 2回目は、同じ鍵・同じ撮影日・同じシーンの1回目があり、モデルが違うときだけ（独立した読み）
CREATE TRIGGER IF NOT EXISTS shooting_scene_reads_independent BEFORE INSERT ON shooting_scene_reads
 WHEN NEW.read_no=2 AND NOT EXISTS(SELECT 1 FROM shooting_scene_reads p WHERE p.org_id=NEW.org_id AND p.read_key=NEW.read_key
  AND p.shooting_day_id=NEW.shooting_day_id AND p.scene_id=NEW.scene_id AND p.read_no=1 AND lower(trim(p.model))<>lower(trim(NEW.model)))
 BEGIN SELECT RAISE(ABORT,'scene read not independent'); END;
CREATE TRIGGER IF NOT EXISTS shooting_scene_reads_no_update BEFORE UPDATE ON shooting_scene_reads BEGIN SELECT RAISE(ABORT,'scene read record immutable'); END;
CREATE TRIGGER IF NOT EXISTS shooting_scene_reads_no_delete BEFORE DELETE ON shooting_scene_reads BEGIN SELECT RAISE(ABORT,'scene read record immutable'); END;
CREATE INDEX IF NOT EXISTS shooting_scene_reads_work_idx ON shooting_scene_reads(org_id,work_id,shooting_day_id,scene_id);
CREATE INDEX IF NOT EXISTS shooting_scene_reads_day_idx ON shooting_scene_reads(org_id,shooting_day_id,scene_id);
CREATE INDEX IF NOT EXISTS shooting_scene_reads_document_idx ON shooting_scene_reads(org_id,source_document_id);
CREATE INDEX IF NOT EXISTS shooting_scene_reads_author_idx ON shooting_scene_reads(org_id,created_by);

CREATE TABLE IF NOT EXISTS shooting_scene_result_reads (
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 scene_id INTEGER NOT NULL,
 result_id INTEGER NOT NULL,
 read_key TEXT NOT NULL CHECK(length(read_key) BETWEEN 1 AND 100),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,result_id),
 UNIQUE(org_id,read_key,scene_id),
 FOREIGN KEY(org_id,result_id) REFERENCES shooting_scene_results(org_id,id),
 FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id)
);
-- 結べるのは、別のモデルの2回の読みが一致し（読めず を除く）、その読みを読み替えた結果の行だけ
CREATE TRIGGER IF NOT EXISTS shooting_scene_result_reads_agree BEFORE INSERT ON shooting_scene_result_reads
 WHEN NOT EXISTS(SELECT 1 FROM shooting_scene_results res
  JOIN shooting_scene_reads r1 ON r1.org_id=res.org_id AND r1.read_key=NEW.read_key AND r1.shooting_day_id=res.shooting_day_id AND r1.scene_id=res.scene_id AND r1.read_no=1
  JOIN shooting_scene_reads r2 ON r2.org_id=res.org_id AND r2.read_key=NEW.read_key AND r2.shooting_day_id=res.shooting_day_id AND r2.scene_id=res.scene_id AND r2.read_no=2
  WHERE res.org_id=NEW.org_id AND res.id=NEW.result_id AND res.work_id=NEW.work_id AND res.scene_id=NEW.scene_id
   AND r1.reading=r2.reading AND r1.reading<>'unreadable' AND lower(trim(r1.model))<>lower(trim(r2.model)) AND res.postponed_to_day_id IS NULL
   AND (res.result=r1.reading OR (r1.reading='not_shot' AND res.result='postponed')))
 BEGIN SELECT RAISE(ABORT,'scene result reads disagree'); END;
CREATE TRIGGER IF NOT EXISTS shooting_scene_result_reads_no_update BEFORE UPDATE ON shooting_scene_result_reads BEGIN SELECT RAISE(ABORT,'scene read record immutable'); END;
CREATE TRIGGER IF NOT EXISTS shooting_scene_result_reads_no_delete BEFORE DELETE ON shooting_scene_result_reads BEGIN SELECT RAISE(ABORT,'scene read record immutable'); END;
CREATE INDEX IF NOT EXISTS shooting_scene_result_reads_work_idx ON shooting_scene_result_reads(org_id,work_id,scene_id);
