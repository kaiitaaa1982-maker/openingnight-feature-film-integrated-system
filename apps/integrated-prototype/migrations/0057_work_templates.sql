-- 制作部の業務のひな型（業務の種類のフォルダ → ひな型 → 版）。制作の仕事は毎回違うので、フォルダ（業務の種類）は利用者が作り、種類が溜まっていく。
-- 足すだけの移行: 6表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。
-- 番号 0057 は仮（調整役が決める。0056 のあと。この時点で 0057 以降を使う開いた PR・ブランチは無い）。
--
-- work_template_folders: 業務の種類のフォルダ。組織ごと。追加だけ。ここの name・description は作ったときの値で、直さない。種類の一覧はコードに持たない。
-- work_template_folder_revisions: フォルダの名前・説明・やめた印の直し。追加だけ。最新の行が現在の値（無ければ work_template_folders の値）。
--   名前は組織内で現在の名前どうしが重ならないようにトリガーで断る（直す前の名前は履歴に残り、ほかのフォルダが使ってよい）。
-- work_template_moves: ひな型をほかのフォルダへ移した記録。追加だけ。最新の行が現在のフォルダ（無ければ work_templates.folder_id）。
-- work_templates: ひな型の本体（どのフォルダのものか、複製元はどれか）。追加だけ。名前・中身は版（work_template_versions）が持つ。
-- work_template_versions: ひな型の版。追加だけ。直すときは新しい版を足し、2版目からは理由を必須にする。やめるときも retired=1 の新しい版を足す。
--   blocks_json は部品の並び（文・チェックリスト・項目表・表。条件つきの行を持てる）、variables_json は差し込みの穴の定義、
--   source_json は出どころ（どこから来た型か。分からなければ unverified）。部品の種類を増やしても移行は要らない（形はアプリ側で確かめる）。
--   drive_ref は出どころの Google ドライブのファイル ID またはリンク（任意）。ドライブとの自動の同期は作らない。
-- work_template_files: Word・Excel・PowerPoint などの原本（共通の source_documents を指す）。追加だけ。置き直すと新しい行（file_no が増える）を足し、古い行も残る。
--   原本の中身・名前・大きさ・ハッシュは source_documents（0025）が持つ。この表は「どのひな型の何番目の原本か」と理由・出どころのドライブの印だけを持つ。
--
-- トリガーの本体に CASE を書かない。形の CHECK は GLOB と typeof を使わない。

CREATE TABLE IF NOT EXISTS work_template_folders (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 description TEXT CHECK(description IS NULL OR length(trim(description)) BETWEEN 1 AND 300),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS work_template_folders_no_update BEFORE UPDATE ON work_template_folders BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_template_folders_no_delete BEFORE DELETE ON work_template_folders BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE INDEX IF NOT EXISTS work_template_folders_author_idx ON work_template_folders(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS work_template_folders_name_unique BEFORE INSERT ON work_template_folders
 WHEN EXISTS (SELECT 1 FROM work_template_folders f WHERE f.org_id=NEW.org_id AND COALESCE((SELECT r.name FROM work_template_folder_revisions r WHERE r.org_id=f.org_id AND r.folder_id=f.id AND r.rev_no=(SELECT MAX(x.rev_no) FROM work_template_folder_revisions x WHERE x.org_id=f.org_id AND x.folder_id=f.id)),f.name)=NEW.name)
 BEGIN SELECT RAISE(ABORT,'duplicate work template folder name'); END;

CREATE TABLE IF NOT EXISTS work_template_folder_revisions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 folder_id INTEGER NOT NULL,
 rev_no INTEGER NOT NULL CHECK(rev_no>0),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 description TEXT CHECK(description IS NULL OR length(trim(description)) BETWEEN 1 AND 300),
 retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,folder_id,rev_no),
 FOREIGN KEY(org_id,folder_id) REFERENCES work_template_folders(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS work_template_folder_revisions_sequence BEFORE INSERT ON work_template_folder_revisions
 WHEN NEW.rev_no<>(SELECT COALESCE(MAX(x.rev_no),0)+1 FROM work_template_folder_revisions x WHERE x.org_id=NEW.org_id AND x.folder_id=NEW.folder_id)
 BEGIN SELECT RAISE(ABORT,'stale work template folder revision'); END;
CREATE TRIGGER IF NOT EXISTS work_template_folder_revisions_name_unique BEFORE INSERT ON work_template_folder_revisions
 WHEN EXISTS (SELECT 1 FROM work_template_folders f WHERE f.org_id=NEW.org_id AND f.id<>NEW.folder_id AND COALESCE((SELECT r.name FROM work_template_folder_revisions r WHERE r.org_id=f.org_id AND r.folder_id=f.id AND r.rev_no=(SELECT MAX(x.rev_no) FROM work_template_folder_revisions x WHERE x.org_id=f.org_id AND x.folder_id=f.id)),f.name)=NEW.name)
 BEGIN SELECT RAISE(ABORT,'duplicate work template folder name'); END;
CREATE TRIGGER IF NOT EXISTS work_template_folder_revisions_no_update BEFORE UPDATE ON work_template_folder_revisions BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_template_folder_revisions_no_delete BEFORE DELETE ON work_template_folder_revisions BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE INDEX IF NOT EXISTS work_template_folder_revisions_author_idx ON work_template_folder_revisions(org_id,created_by);

CREATE TABLE IF NOT EXISTS work_templates (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 folder_id INTEGER NOT NULL,
 copied_from_template_id INTEGER,
 copied_from_version_no INTEGER CHECK(copied_from_version_no IS NULL OR copied_from_version_no>0),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,folder_id) REFERENCES work_template_folders(org_id,id),
 FOREIGN KEY(org_id,copied_from_template_id) REFERENCES work_templates(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((copied_from_template_id IS NULL AND copied_from_version_no IS NULL) OR (copied_from_template_id IS NOT NULL AND copied_from_version_no IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS work_templates_no_update BEFORE UPDATE ON work_templates BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_templates_no_delete BEFORE DELETE ON work_templates BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE INDEX IF NOT EXISTS work_templates_folder_idx ON work_templates(org_id,folder_id);
CREATE INDEX IF NOT EXISTS work_templates_copied_idx ON work_templates(org_id,copied_from_template_id);
CREATE INDEX IF NOT EXISTS work_templates_author_idx ON work_templates(org_id,created_by);

CREATE TABLE IF NOT EXISTS work_template_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 template_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 purpose TEXT CHECK(purpose IS NULL OR length(trim(purpose)) BETWEEN 1 AND 500),
 scene TEXT CHECK(scene IS NULL OR length(trim(scene)) BETWEEN 1 AND 500),
 blocks_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(blocks_json) AND json_type(blocks_json)='array' AND length(blocks_json)<=60000),
 variables_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(variables_json) AND json_type(variables_json)='array' AND length(variables_json)<=20000),
 source_json TEXT NOT NULL DEFAULT '{"kind":"unverified"}' CHECK(json_valid(source_json) AND json_type(source_json)='object' AND length(source_json)<=4000),
 drive_ref TEXT CHECK(drive_ref IS NULL OR length(trim(drive_ref)) BETWEEN 1 AND 500),
 retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,template_id,version_no),
 FOREIGN KEY(org_id,template_id) REFERENCES work_templates(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(version_no=1 OR reason IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS work_template_versions_sequence BEFORE INSERT ON work_template_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM work_template_versions v WHERE v.org_id=NEW.org_id AND v.template_id=NEW.template_id)
 BEGIN SELECT RAISE(ABORT,'stale work template version'); END;
CREATE TRIGGER IF NOT EXISTS work_template_versions_no_update BEFORE UPDATE ON work_template_versions BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_template_versions_no_delete BEFORE DELETE ON work_template_versions BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE INDEX IF NOT EXISTS work_template_versions_author_idx ON work_template_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS work_template_moves (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 template_id INTEGER NOT NULL,
 move_no INTEGER NOT NULL CHECK(move_no>0),
 folder_id INTEGER NOT NULL,
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,template_id,move_no),
 FOREIGN KEY(org_id,template_id) REFERENCES work_templates(org_id,id),
 FOREIGN KEY(org_id,folder_id) REFERENCES work_template_folders(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS work_template_moves_sequence BEFORE INSERT ON work_template_moves
 WHEN NEW.move_no<>(SELECT COALESCE(MAX(m.move_no),0)+1 FROM work_template_moves m WHERE m.org_id=NEW.org_id AND m.template_id=NEW.template_id)
 BEGIN SELECT RAISE(ABORT,'stale work template move'); END;
CREATE TRIGGER IF NOT EXISTS work_template_moves_no_update BEFORE UPDATE ON work_template_moves BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_template_moves_no_delete BEFORE DELETE ON work_template_moves BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE INDEX IF NOT EXISTS work_template_moves_folder_idx ON work_template_moves(org_id,folder_id);
CREATE INDEX IF NOT EXISTS work_template_moves_author_idx ON work_template_moves(org_id,created_by);

CREATE TABLE IF NOT EXISTS work_template_files (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 template_id INTEGER NOT NULL,
 file_no INTEGER NOT NULL CHECK(file_no>0),
 document_id INTEGER NOT NULL,
 drive_ref TEXT CHECK(drive_ref IS NULL OR length(trim(drive_ref)) BETWEEN 1 AND 500),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,template_id,file_no),
 FOREIGN KEY(org_id,template_id) REFERENCES work_templates(org_id,id),
 FOREIGN KEY(org_id,document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(file_no=1 OR reason IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS work_template_files_sequence BEFORE INSERT ON work_template_files
 WHEN NEW.file_no<>(SELECT COALESCE(MAX(f.file_no),0)+1 FROM work_template_files f WHERE f.org_id=NEW.org_id AND f.template_id=NEW.template_id)
 BEGIN SELECT RAISE(ABORT,'stale work template file'); END;
CREATE TRIGGER IF NOT EXISTS work_template_files_no_update BEFORE UPDATE ON work_template_files BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_template_files_no_delete BEFORE DELETE ON work_template_files BEGIN SELECT RAISE(ABORT,'work template record immutable'); END;
CREATE INDEX IF NOT EXISTS work_template_files_document_idx ON work_template_files(org_id,document_id);
CREATE INDEX IF NOT EXISTS work_template_files_author_idx ON work_template_files(org_id,created_by);
