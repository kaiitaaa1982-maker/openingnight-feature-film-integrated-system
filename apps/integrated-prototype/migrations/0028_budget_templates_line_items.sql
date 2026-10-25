-- 予算書の型（テンプレ）と、行の内訳（キャストリストなど）（要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-028・029・032〜034）。
-- 足すだけの移行: 5表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0028 は調整役から受け取った（0025 は source_documents、0026 は MG 買付、0027 は MG の支払）。
--
-- budget_templates: 型（組織ごと・名前で区別）。名前は変えない（変えるときは新しい型を作る）。
-- budget_template_versions: 型の版。型ごとの連番で追加だけ。出どころは予算書 xlsx・案件の版・画面。理由は必須。
-- budget_template_items: 型の版の費目の行。区分は A〜K（予算書の行と同じ CHECK）。内訳を持つ費目は内訳のシートの名前を持つ。
-- budget_version_templates: 予算書の版がどの型の版から作られたか（1つの版に1つまで）。
-- budget_line_items: 予算書の行の内訳（キャストリストの役ごとなど）。行の金額＝内訳の和は受け口と model が確かめる。確定した版には足せない。
--   役者名・事務所名の列は持たない（会社ルートの計画の問い8 の補足: キャスト一覧〈プリプロ〉を casting_ref で指す。指す先の表が入ったら外部キーを足す）。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる。

CREATE TABLE IF NOT EXISTS budget_templates (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,name),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS budget_templates_no_update BEFORE UPDATE ON budget_templates BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_templates_no_delete BEFORE DELETE ON budget_templates BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_templates_author_idx ON budget_templates(org_id,created_by);

CREATE TABLE IF NOT EXISTS budget_template_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 template_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('file','budget','screen')),
 source_file_name TEXT CHECK(source_file_name IS NULL OR length(trim(source_file_name)) BETWEEN 1 AND 240),
 source_project_id INTEGER,
 source_budget_version_id INTEGER,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,template_id,version_no),
 FOREIGN KEY(org_id,template_id) REFERENCES budget_templates(org_id,id),
 FOREIGN KEY(org_id,source_project_id,source_budget_version_id) REFERENCES budget_versions(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((source_kind='file' AND source_file_name IS NOT NULL) OR (source_kind<>'file' AND source_file_name IS NULL)),
 CHECK((source_kind='budget' AND source_project_id IS NOT NULL AND source_budget_version_id IS NOT NULL)
  OR (source_kind<>'budget' AND source_project_id IS NULL AND source_budget_version_id IS NULL))
);
CREATE TRIGGER IF NOT EXISTS budget_template_versions_sequence BEFORE INSERT ON budget_template_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM budget_template_versions v WHERE v.org_id=NEW.org_id AND v.template_id=NEW.template_id)
 BEGIN SELECT RAISE(ABORT,'stale budget template version'); END;
CREATE TRIGGER IF NOT EXISTS budget_template_versions_no_update BEFORE UPDATE ON budget_template_versions BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_template_versions_no_delete BEFORE DELETE ON budget_template_versions BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_template_versions_author_idx ON budget_template_versions(org_id,created_by);
CREATE INDEX IF NOT EXISTS budget_template_versions_source_idx ON budget_template_versions(org_id,source_project_id,source_budget_version_id);

CREATE TABLE IF NOT EXISTS budget_template_items (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 template_version_id INTEGER NOT NULL,
 category_code TEXT NOT NULL CHECK(category_code IN ('A','B','C','D','E','F','G','H','I','J','K')),
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 1000),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 unit TEXT CHECK(unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 20),
 unit_price_yen INTEGER CHECK(unit_price_yen IS NULL OR (typeof(unit_price_yen)='integer' AND unit_price_yen BETWEEN 0 AND 1000000000000)),
 qty_milli INTEGER CHECK(qty_milli IS NULL OR (typeof(qty_milli)='integer' AND qty_milli BETWEEN 0 AND 1000000000)),
 breakdown_sheet TEXT CHECK(breakdown_sheet IS NULL OR length(trim(breakdown_sheet)) BETWEEN 1 AND 31),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 UNIQUE(org_id,id), UNIQUE(org_id,template_version_id,category_code,line_no),
 FOREIGN KEY(org_id,template_version_id) REFERENCES budget_template_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS budget_template_items_no_update BEFORE UPDATE ON budget_template_items BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_template_items_no_delete BEFORE DELETE ON budget_template_items BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_template_items_version_idx ON budget_template_items(org_id,template_version_id);

CREATE TABLE IF NOT EXISTS budget_version_templates (
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 template_version_id INTEGER NOT NULL,
 PRIMARY KEY(org_id,version_id),
 FOREIGN KEY(org_id,project_id,version_id) REFERENCES budget_versions(org_id,project_id,id),
 FOREIGN KEY(org_id,template_version_id) REFERENCES budget_template_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS budget_version_templates_no_update BEFORE UPDATE ON budget_version_templates BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_version_templates_no_delete BEFORE DELETE ON budget_version_templates BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_version_templates_template_idx ON budget_version_templates(org_id,template_version_id);

CREATE TABLE IF NOT EXISTS budget_line_items (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 category_code TEXT NOT NULL CHECK(category_code IN ('A','B','C','D','E','F','G','H','I','J','K')),
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 1000),
 item_no INTEGER NOT NULL CHECK(typeof(item_no)='integer' AND item_no BETWEEN 1 AND 500),
 breakdown_sheet TEXT NOT NULL CHECK(length(trim(breakdown_sheet)) BETWEEN 1 AND 31),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 200),
 qty_milli INTEGER CHECK(qty_milli IS NULL OR (typeof(qty_milli)='integer' AND qty_milli BETWEEN 0 AND 1000000000)),
 unit_price_yen INTEGER CHECK(unit_price_yen IS NULL OR (typeof(unit_price_yen)='integer' AND unit_price_yen BETWEEN 0 AND 1000000000000)),
 amount_ex_tax_yen INTEGER NOT NULL CHECK(typeof(amount_ex_tax_yen)='integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000),
 casting_ref TEXT CHECK(casting_ref IS NULL OR length(trim(casting_ref)) BETWEEN 1 AND 80),
 source_cell TEXT CHECK(source_cell IS NULL OR length(source_cell) BETWEEN 2 AND 40),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 UNIQUE(org_id,id), UNIQUE(org_id,version_id,category_code,line_no,item_no),
 FOREIGN KEY(org_id,project_id,version_id) REFERENCES budget_versions(org_id,project_id,id),
 FOREIGN KEY(org_id,version_id,category_code,line_no) REFERENCES budget_version_lines(org_id,version_id,category_code,line_no)
);
CREATE TRIGGER IF NOT EXISTS budget_line_items_fixed BEFORE INSERT ON budget_line_items
 WHEN EXISTS(SELECT 1 FROM budget_fixes f WHERE f.org_id=NEW.org_id AND f.version_id=NEW.version_id)
 BEGIN SELECT RAISE(ABORT,'budget version already fixed'); END;
CREATE TRIGGER IF NOT EXISTS budget_line_items_no_update BEFORE UPDATE ON budget_line_items BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_line_items_no_delete BEFORE DELETE ON budget_line_items BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_line_items_version_idx ON budget_line_items(org_id,version_id);
