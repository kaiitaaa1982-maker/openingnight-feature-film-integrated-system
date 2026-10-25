-- 経費管理のフォルダ（販売の経費）の置いた月・外した記録・月の締め（会社ルート plans/2026-10-22-folder-keihi.md の表A・表B）。
-- 足すだけの移行: 3表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0041 は調整役から受け取った。
--
-- expense_file_placements: 原本（expense_source_files）をどの月のフォルダに置いたか。原本の表には列を足さない（変更できない表なので）。
--   1つの原本に有効な置き場所は1つだけ。置き直すときは外した記録を足してから新しい行を足す。
-- expense_file_placement_voids: 経費の原本ではないと外した記録（理由は必須）。原本は消さない。
-- expense_month_closures: 月の締め（受領が揃ったという記録。会計の締めではない）。最新の行が今の状態。
--
-- トリガーの本体に CASE を書かない。形の CHECK は GLOB を使わない（0024 と同じ）。

CREATE TABLE IF NOT EXISTS expense_file_placements (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 file_id INTEGER NOT NULL,
 placed_month TEXT NOT NULL CHECK(length(placed_month)=7 AND substr(placed_month,5,1)='-'
  AND ltrim(substr(placed_month,1,4)||substr(placed_month,6,2),'0123456789')='' AND substr(placed_month,6,2) BETWEEN '01' AND '12'),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,file_id) REFERENCES expense_source_files(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_file_placements_one_active BEFORE INSERT ON expense_file_placements
 WHEN EXISTS(SELECT 1 FROM expense_file_placements p WHERE p.org_id=NEW.org_id AND p.file_id=NEW.file_id
  AND NOT EXISTS(SELECT 1 FROM expense_file_placement_voids v WHERE v.org_id=p.org_id AND v.placement_id=p.id))
 BEGIN SELECT RAISE(ABORT,'duplicate expense file placement'); END;
CREATE TRIGGER IF NOT EXISTS expense_file_placements_no_update BEFORE UPDATE ON expense_file_placements BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_file_placements_no_delete BEFORE DELETE ON expense_file_placements BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_file_placements_file_idx ON expense_file_placements(org_id,file_id);
CREATE INDEX IF NOT EXISTS expense_file_placements_month_idx ON expense_file_placements(org_id,placed_month);
CREATE INDEX IF NOT EXISTS expense_file_placements_author_idx ON expense_file_placements(org_id,created_by);

CREATE TABLE IF NOT EXISTS expense_file_placement_voids (
 org_id INTEGER NOT NULL,
 placement_id INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,placement_id),
 FOREIGN KEY(org_id,placement_id) REFERENCES expense_file_placements(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_file_placement_voids_no_update BEFORE UPDATE ON expense_file_placement_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_file_placement_voids_no_delete BEFORE DELETE ON expense_file_placement_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_file_placement_voids_author_idx ON expense_file_placement_voids(org_id,created_by);

CREATE TABLE IF NOT EXISTS expense_month_closures (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 month TEXT NOT NULL CHECK(length(month)=7 AND substr(month,5,1)='-'
  AND ltrim(substr(month,1,4)||substr(month,6,2),'0123456789')='' AND substr(month,6,2) BETWEEN '01' AND '12'),
 kind TEXT NOT NULL CHECK(kind IN ('close','reopen')),
 file_count INTEGER NOT NULL CHECK(typeof(file_count)='integer' AND file_count>=0),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_month_closures_no_update BEFORE UPDATE ON expense_month_closures BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_month_closures_no_delete BEFORE DELETE ON expense_month_closures BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_month_closures_month_idx ON expense_month_closures(org_id,month);
CREATE INDEX IF NOT EXISTS expense_month_closures_author_idx ON expense_month_closures(org_id,created_by);
