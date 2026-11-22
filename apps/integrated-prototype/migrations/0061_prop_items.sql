-- 小道具（持ち道具・消え物など）の品目と、小道具の打ち合わせの記録（会社ルートの plans/2026-11-09-props-meeting.md。画面は案A＋案B）。
-- 美術部・小道具担当がいない作品で、制作部・プロデューサー部・演出部が画面を囲んで打ち合わせをし、決めたことを品目ごとの担当・状態・次の行動に残す。
-- 足すだけの移行: 3表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0061 は仮（調整役が決める）。
--
-- prop_meetings: 打ち合わせの1回（作品・日付・題・出た部署・メモ）。書き換えない。
-- prop_items: 品目の1件（作品と、取込で二重に入れないための鍵）。書き換えない。
-- prop_item_versions: 品目の中身の版（シーン・撮影日・場面・品目・数・種別・部署・担当・状態・次の行動・期限・出典・台本の記述・メモ）。
--   品目ごとの連番で追加だけ。いまの中身は最新の版。打ち合わせで決めた版は meeting_id を持ち、「その回で決めたこと」を一覧にできる。
--   シーンは「#31・#32」のように複数を書くので、scenes の表は指さず文字で持つ。撮影日も日々スケが無い作品で使えるよう日付の文字で持つ。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS prop_meetings (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 held_on TEXT NOT NULL CHECK(length(held_on)=10 AND substr(held_on,5,1)='-' AND substr(held_on,8,1)='-'
  AND ltrim(substr(held_on,1,4)||substr(held_on,6,2)||substr(held_on,9,2),'0123456789')=''),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 departments TEXT CHECK(departments IS NULL OR length(departments) BETWEEN 1 AND 200),
 note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS prop_meetings_no_update BEFORE UPDATE ON prop_meetings BEGIN SELECT RAISE(ABORT,'prop record immutable'); END;
CREATE TRIGGER IF NOT EXISTS prop_meetings_no_delete BEFORE DELETE ON prop_meetings BEGIN SELECT RAISE(ABORT,'prop record immutable'); END;
CREATE INDEX IF NOT EXISTS prop_meetings_work_idx ON prop_meetings(org_id,work_id);
CREATE INDEX IF NOT EXISTS prop_meetings_author_idx ON prop_meetings(org_id,created_by);

CREATE TABLE IF NOT EXISTS prop_items (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 item_key TEXT NOT NULL CHECK(length(item_key) BETWEEN 1 AND 64),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,item_key),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS prop_items_no_update BEFORE UPDATE ON prop_items BEGIN SELECT RAISE(ABORT,'prop record immutable'); END;
CREATE TRIGGER IF NOT EXISTS prop_items_no_delete BEFORE DELETE ON prop_items BEGIN SELECT RAISE(ABORT,'prop record immutable'); END;
CREATE INDEX IF NOT EXISTS prop_items_author_idx ON prop_items(org_id,created_by);

CREATE TABLE IF NOT EXISTS prop_item_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 item_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 scene_label TEXT CHECK(scene_label IS NULL OR length(scene_label) BETWEEN 1 AND 60),
 shoot_on TEXT CHECK(shoot_on IS NULL OR (length(shoot_on)=10 AND substr(shoot_on,5,1)='-' AND substr(shoot_on,8,1)='-'
  AND ltrim(substr(shoot_on,1,4)||substr(shoot_on,6,2)||substr(shoot_on,9,2),'0123456789')='')),
 place TEXT CHECK(place IS NULL OR length(place) BETWEEN 1 AND 120),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 quantity TEXT CHECK(quantity IS NULL OR length(quantity) BETWEEN 1 AND 40),
 kind TEXT NOT NULL CHECK(kind IN ('hand','consumable','dressing','costume','vehicle','other')),
 department TEXT CHECK(department IS NULL OR department IN ('production','producer','direction','art','costume','other')),
 owner_label TEXT CHECK(owner_label IS NULL OR length(owner_label) BETWEEN 1 AND 80),
 state TEXT NOT NULL CHECK(state IN ('unassigned','adjust','arranging','ready','unneeded')),
 next_action TEXT CHECK(next_action IS NULL OR length(next_action) BETWEEN 1 AND 300),
 due_on TEXT CHECK(due_on IS NULL OR (length(due_on)=10 AND substr(due_on,5,1)='-' AND substr(due_on,8,1)='-'
  AND ltrim(substr(due_on,1,4)||substr(due_on,6,2)||substr(due_on,9,2),'0123456789')='')),
 source TEXT NOT NULL CHECK(source IN ('script','meeting','both','callsheet','manual')),
 script_note TEXT CHECK(script_note IS NULL OR length(script_note) BETWEEN 1 AND 500),
 memo TEXT CHECK(memo IS NULL OR length(memo) BETWEEN 1 AND 1000),
 meeting_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,item_id,version_no),
 FOREIGN KEY(org_id,item_id) REFERENCES prop_items(org_id,id),
 FOREIGN KEY(org_id,meeting_id) REFERENCES prop_meetings(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(state<>'unassigned' OR department IS NULL)
);
CREATE TRIGGER IF NOT EXISTS prop_item_versions_sequence BEFORE INSERT ON prop_item_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM prop_item_versions v WHERE v.org_id=NEW.org_id AND v.item_id=NEW.item_id)
 BEGIN SELECT RAISE(ABORT,'stale prop item version'); END;
CREATE TRIGGER IF NOT EXISTS prop_item_versions_same_work BEFORE INSERT ON prop_item_versions
 WHEN NEW.meeting_id IS NOT NULL AND (SELECT m.work_id FROM prop_meetings m WHERE m.org_id=NEW.org_id AND m.id=NEW.meeting_id)
  IS NOT (SELECT i.work_id FROM prop_items i WHERE i.org_id=NEW.org_id AND i.id=NEW.item_id)
 BEGIN SELECT RAISE(ABORT,'prop meeting of another work'); END;
CREATE TRIGGER IF NOT EXISTS prop_item_versions_no_update BEFORE UPDATE ON prop_item_versions BEGIN SELECT RAISE(ABORT,'prop record immutable'); END;
CREATE TRIGGER IF NOT EXISTS prop_item_versions_no_delete BEFORE DELETE ON prop_item_versions BEGIN SELECT RAISE(ABORT,'prop record immutable'); END;
CREATE INDEX IF NOT EXISTS prop_item_versions_meeting_idx ON prop_item_versions(org_id,meeting_id);
CREATE INDEX IF NOT EXISTS prop_item_versions_author_idx ON prop_item_versions(org_id,created_by);
