-- 現場の連絡帳（会社ルートの plans/2026-10-22-folder-preprod.md の「現場の連絡帳」N1・N4・N5。調整役の X-23: 共通の部品 src/notebook/、持ち主はプリプロ）。
-- 足すだけの移行: 3表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0055 は調整役から受け取った（MIGRATION-ORDER.md。0054 のあと）。
--
-- notebook_spaces: 作品ごとのスペース（全体・部署・任意の組）。追加だけ。部署は部署の一覧（departments）が入るまで名前で持つ。
-- notebook_posts: 連絡。型（コードに持つ定型の連絡）・欄の値・本文・添付（source_documents の ID の並び）・デザイン。追加だけ。
--   直すときは訂正の連絡を出し、訂正元（corrects_post_id）を指す。消す操作は無い。
-- notebook_receipts: 既読と了解。連絡×人×種類で1行だけ。追加だけ。
-- 社外の人の入口は作らない（D-005・関係者の入口の RLS の裁定待ち）。
--
-- トリガーの本体に CASE を書かない。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS notebook_spaces (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('all','department','group')),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,work_id,name),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS notebook_spaces_no_update BEFORE UPDATE ON notebook_spaces BEGIN SELECT RAISE(ABORT,'notebook record immutable'); END;
CREATE TRIGGER IF NOT EXISTS notebook_spaces_no_delete BEFORE DELETE ON notebook_spaces BEGIN SELECT RAISE(ABORT,'notebook record immutable'); END;
CREATE INDEX IF NOT EXISTS notebook_spaces_author_idx ON notebook_spaces(org_id,created_by);

CREATE TABLE IF NOT EXISTS notebook_posts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 space_id INTEGER NOT NULL,
 template TEXT NOT NULL CHECK(template IN ('daily','change','fitting','location','call','free')),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
 fields_json TEXT NOT NULL CHECK(json_valid(fields_json) AND json_type(fields_json)='array' AND length(fields_json)<=20000),
 body TEXT CHECK(body IS NULL OR length(body) BETWEEN 1 AND 5000),
 attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json) AND json_type(attachments_json)='array' AND length(attachments_json)<=2000),
 design TEXT NOT NULL CHECK(design IN ('simple','table','print')),
 needs_ack INTEGER NOT NULL CHECK(needs_ack IN (0,1)),
 corrects_post_id INTEGER,
 posted_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,space_id,id),
 FOREIGN KEY(org_id,work_id,space_id) REFERENCES notebook_spaces(org_id,work_id,id),
 FOREIGN KEY(org_id,space_id,corrects_post_id) REFERENCES notebook_posts(org_id,space_id,id),
 FOREIGN KEY(org_id,posted_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS notebook_posts_no_update BEFORE UPDATE ON notebook_posts BEGIN SELECT RAISE(ABORT,'notebook record immutable'); END;
CREATE TRIGGER IF NOT EXISTS notebook_posts_no_delete BEFORE DELETE ON notebook_posts BEGIN SELECT RAISE(ABORT,'notebook record immutable'); END;
CREATE INDEX IF NOT EXISTS notebook_posts_space_idx ON notebook_posts(org_id,space_id,id);
CREATE INDEX IF NOT EXISTS notebook_posts_work_idx ON notebook_posts(org_id,work_id,space_id);
CREATE INDEX IF NOT EXISTS notebook_posts_corrects_idx ON notebook_posts(org_id,space_id,corrects_post_id);
CREATE INDEX IF NOT EXISTS notebook_posts_author_idx ON notebook_posts(org_id,posted_by);

CREATE TABLE IF NOT EXISTS notebook_receipts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 post_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('read','ack')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,post_id,user_id,kind),
 FOREIGN KEY(org_id,post_id) REFERENCES notebook_posts(org_id,id),
 FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS notebook_receipts_no_update BEFORE UPDATE ON notebook_receipts BEGIN SELECT RAISE(ABORT,'notebook record immutable'); END;
CREATE TRIGGER IF NOT EXISTS notebook_receipts_no_delete BEFORE DELETE ON notebook_receipts BEGIN SELECT RAISE(ABORT,'notebook record immutable'); END;
CREATE INDEX IF NOT EXISTS notebook_receipts_post_idx ON notebook_receipts(org_id,post_id);
CREATE INDEX IF NOT EXISTS notebook_receipts_user_idx ON notebook_receipts(org_id,user_id);
