-- プリプロダクションの手配・美術・シーンの撮影の方針（会社ルートの plans/2026-10-22-folder-preprod.md の PP6・PP7。オールスタッフ／美術打ち合わせの資料の章 04・05・08）。
-- 足すだけの移行: 3表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0053 は調整役から受け取った（MIGRATION-ORDER.md。0052 のあと）。
--
-- production_arrangement_versions: 手配（撮影機材・特機・照明・録音機材・トラック・ロケバス・車両とドライバー・その他）の版。
--   手配の識別子ごとの連番で追加だけ。いまの手配は識別子ごとの最新の版。取り消しは状態 cancelled の版を足す。金額は持たない（経費管理の約束 KH-1）。
-- scene_art_item_versions: 美術（飾り・小道具・作り物）の項目の版。項目の識別子ごとの連番で追加だけ。シーンは任意。
-- scene_shoot_plan_versions: シーンの撮影の方針（手法・要る機材のメモ）の版。シーンごとの連番で追加だけ。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS production_arrangement_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 arrangement_key TEXT NOT NULL CHECK(length(arrangement_key) BETWEEN 1 AND 64),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 kind TEXT NOT NULL CHECK(kind IN ('camera','grip','lighting','sound','truck','location_bus','vehicle','other')),
 partner_id INTEGER,
 item TEXT NOT NULL CHECK(length(trim(item)) BETWEEN 1 AND 200),
 quantity INTEGER CHECK(quantity IS NULL OR (typeof(quantity)='integer' AND quantity BETWEEN 0 AND 100000)),
 unit TEXT CHECK(unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 20),
 capacity INTEGER CHECK(capacity IS NULL OR (typeof(capacity)='integer' AND capacity BETWEEN 1 AND 1000)),
 starts_on TEXT CHECK(starts_on IS NULL OR (length(starts_on)=10 AND substr(starts_on,5,1)='-' AND substr(starts_on,8,1)='-'
  AND ltrim(substr(starts_on,1,4)||substr(starts_on,6,2)||substr(starts_on,9,2),'0123456789')='')),
 ends_on TEXT CHECK(ends_on IS NULL OR (length(ends_on)=10 AND substr(ends_on,5,1)='-' AND substr(ends_on,8,1)='-'
  AND ltrim(substr(ends_on,1,4)||substr(ends_on,6,2)||substr(ends_on,9,2),'0123456789')='')),
 deadline_on TEXT CHECK(deadline_on IS NULL OR (length(deadline_on)=10 AND substr(deadline_on,5,1)='-' AND substr(deadline_on,8,1)='-'
  AND ltrim(substr(deadline_on,1,4)||substr(deadline_on,6,2)||substr(deadline_on,9,2),'0123456789')='')),
 state TEXT NOT NULL CHECK(state IN ('hold','confirmed','cancelled')),
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,arrangement_key,version_no),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(ends_on IS NULL OR starts_on IS NULL OR ends_on>=starts_on)
);
CREATE TRIGGER IF NOT EXISTS production_arrangement_versions_sequence BEFORE INSERT ON production_arrangement_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM production_arrangement_versions v WHERE v.org_id=NEW.org_id AND v.work_id=NEW.work_id AND v.arrangement_key=NEW.arrangement_key)
 BEGIN SELECT RAISE(ABORT,'stale arrangement version'); END;
CREATE TRIGGER IF NOT EXISTS production_arrangement_versions_no_update BEFORE UPDATE ON production_arrangement_versions BEGIN SELECT RAISE(ABORT,'preprod record immutable'); END;
CREATE TRIGGER IF NOT EXISTS production_arrangement_versions_no_delete BEFORE DELETE ON production_arrangement_versions BEGIN SELECT RAISE(ABORT,'preprod record immutable'); END;
CREATE INDEX IF NOT EXISTS production_arrangement_versions_work_idx ON production_arrangement_versions(org_id,work_id,arrangement_key);
CREATE INDEX IF NOT EXISTS production_arrangement_versions_partner_idx ON production_arrangement_versions(org_id,partner_id);
CREATE INDEX IF NOT EXISTS production_arrangement_versions_author_idx ON production_arrangement_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS scene_art_item_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 item_key TEXT NOT NULL CHECK(length(item_key) BETWEEN 1 AND 64),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 scene_id INTEGER,
 kind TEXT NOT NULL CHECK(kind IN ('dressing','prop','build')),
 content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 500),
 owner_label TEXT CHECK(owner_label IS NULL OR length(trim(owner_label)) BETWEEN 1 AND 80),
 delivery_on TEXT CHECK(delivery_on IS NULL OR (length(delivery_on)=10 AND substr(delivery_on,5,1)='-' AND substr(delivery_on,8,1)='-'
  AND ltrim(substr(delivery_on,1,4)||substr(delivery_on,6,2)||substr(delivery_on,9,2),'0123456789')='')),
 state TEXT NOT NULL CHECK(state IN ('open','arranging','done','cancelled')),
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,item_key,version_no),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS scene_art_item_versions_sequence BEFORE INSERT ON scene_art_item_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM scene_art_item_versions v WHERE v.org_id=NEW.org_id AND v.work_id=NEW.work_id AND v.item_key=NEW.item_key)
 BEGIN SELECT RAISE(ABORT,'stale art item version'); END;
CREATE TRIGGER IF NOT EXISTS scene_art_item_versions_no_update BEFORE UPDATE ON scene_art_item_versions BEGIN SELECT RAISE(ABORT,'preprod record immutable'); END;
CREATE TRIGGER IF NOT EXISTS scene_art_item_versions_no_delete BEFORE DELETE ON scene_art_item_versions BEGIN SELECT RAISE(ABORT,'preprod record immutable'); END;
CREATE INDEX IF NOT EXISTS scene_art_item_versions_work_idx ON scene_art_item_versions(org_id,work_id,item_key);
CREATE INDEX IF NOT EXISTS scene_art_item_versions_scene_idx ON scene_art_item_versions(org_id,work_id,scene_id);
CREATE INDEX IF NOT EXISTS scene_art_item_versions_author_idx ON scene_art_item_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS scene_shoot_plan_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 scene_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 methods TEXT CHECK(methods IS NULL OR length(trim(methods)) BETWEEN 1 AND 200),
 equipment TEXT CHECK(equipment IS NULL OR length(trim(equipment)) BETWEEN 1 AND 500),
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,scene_id,version_no),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,work_id,scene_id) REFERENCES scenes(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS scene_shoot_plan_versions_sequence BEFORE INSERT ON scene_shoot_plan_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM scene_shoot_plan_versions v WHERE v.org_id=NEW.org_id AND v.work_id=NEW.work_id AND v.scene_id=NEW.scene_id)
 BEGIN SELECT RAISE(ABORT,'stale shoot plan version'); END;
CREATE TRIGGER IF NOT EXISTS scene_shoot_plan_versions_no_update BEFORE UPDATE ON scene_shoot_plan_versions BEGIN SELECT RAISE(ABORT,'preprod record immutable'); END;
CREATE TRIGGER IF NOT EXISTS scene_shoot_plan_versions_no_delete BEFORE DELETE ON scene_shoot_plan_versions BEGIN SELECT RAISE(ABORT,'preprod record immutable'); END;
CREATE INDEX IF NOT EXISTS scene_shoot_plan_versions_scene_idx ON scene_shoot_plan_versions(org_id,work_id,scene_id);
CREATE INDEX IF NOT EXISTS scene_shoot_plan_versions_author_idx ON scene_shoot_plan_versions(org_id,created_by);
