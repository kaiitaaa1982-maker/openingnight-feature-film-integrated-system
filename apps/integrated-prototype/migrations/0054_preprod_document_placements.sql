-- プリプロの保管庫の置き場の記録（会社ルートの plans/2026-10-22-folder-preprod.md の PP4）。原本は共通の source_documents（0025）が持ち、
-- この表は「どの作品の、どの種類の置き場に置いたか」と索引（話・日付・撮影日・シーン・元の置き場）だけを持つ。
-- 足すだけの移行: 1表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0054 は調整役から受け取った（MIGRATION-ORDER.md。0053 のあと）。
--
-- preprod_document_placements: 置き場の記録。追加だけ。置き場を変えるときも新しい行を足し、いまの置き場は原本×作品ごとの最新の行から読む。
--   同じ原本を別のフォルダから2回置いたときも行を足す（元の置き場が2つ残る。原本は1つのまま）。
--
-- トリガーの本体に CASE を書かない。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS preprod_document_placements (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 document_id INTEGER NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('script','schedule','daily','costume','location','cast','still','design','contract','other')),
 episode TEXT CHECK(episode IS NULL OR length(trim(episode)) BETWEEN 1 AND 40),
 dated_on TEXT CHECK(dated_on IS NULL OR (length(dated_on)=10 AND substr(dated_on,5,1)='-' AND substr(dated_on,8,1)='-'
  AND ltrim(substr(dated_on,1,4)||substr(dated_on,6,2)||substr(dated_on,9,2),'0123456789')='')),
 origin_path TEXT CHECK(origin_path IS NULL OR length(trim(origin_path)) BETWEEN 1 AND 500),
 shooting_day_id INTEGER,
 scene_id INTEGER,
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 placed_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
 FOREIGN KEY(org_id,placed_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS preprod_document_placements_no_update BEFORE UPDATE ON preprod_document_placements BEGIN SELECT RAISE(ABORT,'preprod record immutable'); END;
CREATE TRIGGER IF NOT EXISTS preprod_document_placements_no_delete BEFORE DELETE ON preprod_document_placements BEGIN SELECT RAISE(ABORT,'preprod record immutable'); END;
CREATE INDEX IF NOT EXISTS preprod_document_placements_work_idx ON preprod_document_placements(org_id,work_id,document_id);
CREATE INDEX IF NOT EXISTS preprod_document_placements_document_idx ON preprod_document_placements(org_id,document_id);
CREATE INDEX IF NOT EXISTS preprod_document_placements_day_idx ON preprod_document_placements(org_id,work_id,shooting_day_id);
CREATE INDEX IF NOT EXISTS preprod_document_placements_scene_idx ON preprod_document_placements(org_id,work_id,scene_id);
CREATE INDEX IF NOT EXISTS preprod_document_placements_author_idx ON preprod_document_placements(org_id,placed_by);
