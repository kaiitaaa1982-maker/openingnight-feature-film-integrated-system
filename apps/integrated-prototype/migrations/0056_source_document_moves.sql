-- 原本の場所の移動（FR-CORE-DATA-062）。原本は変えず、場所の履歴だけを追加する。
-- 最新は同じ組織・原本の最大の id（同秒の移動も追加順に読む）。番号0056は調整役の指定。
CREATE TABLE IF NOT EXISTS source_document_moves (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 document_id INTEGER NOT NULL,
 from_location TEXT NOT NULL CHECK(length(from_location) BETWEEN 1 AND 500),
 to_location TEXT NOT NULL CHECK(length(to_location) BETWEEN 1 AND 500),
 moved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 moved_by INTEGER NOT NULL,
 reason TEXT CHECK(reason IS NULL OR length(reason)<=500),
 CHECK(from_location<>to_location),
 FOREIGN KEY(org_id,document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,moved_by) REFERENCES memberships(org_id,user_id)
);

CREATE INDEX IF NOT EXISTS source_document_moves_document ON source_document_moves(org_id,document_id,id);

CREATE TRIGGER IF NOT EXISTS source_document_moves_no_update BEFORE UPDATE ON source_document_moves
BEGIN SELECT RAISE(ABORT,'原本の場所の移動は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS source_document_moves_no_delete BEFORE DELETE ON source_document_moves
BEGIN SELECT RAISE(ABORT,'原本の場所の移動は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS source_document_moves_external_only BEFORE INSERT ON source_document_moves
WHEN EXISTS(SELECT 1 FROM source_documents WHERE org_id=NEW.org_id AND id=NEW.document_id AND storage<>'external')
BEGIN SELECT RAISE(ABORT,'外の置き場の原本だけ移動できます'); END;
