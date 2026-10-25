-- 予算書作成（要件 docs/requirements/planning/budget-book.md の FR-PLAN-BUDGET-001・003・017・019。会社ルートの plans/2026-10-22-folder-budget.md）。
-- 足すだけの移行: 4表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0024 は調整役から受け取った（0022 は core #145）。
--
-- budget_versions: 予算書の版。案件ごとの連番で追加だけ。合計の列は持たない（明細から導く。FR-PLAN-BUDGET-004）。
--   版が持つ入力値は、明細から導けない制作管理費・予備費（計画）と税率だけ。理由は必須。
-- budget_version_lines: 版の行。区分は A〜K（実費の行と同じコード。FR-PLAN-BUDGET-002）。費目の区分の表は作らず、コードを CHECK で固定する
--   （名前は src/planning/budget/budget-model.mjs の BUDGET_CATEGORIES）。部署の列は部署の一覧（プロダクション系の departments）が入るまで外部キーを張らない。
--   個人名・事務所名の列は持たない（会社ルートの計画の問い8）。確定済みの版には行を足せない。
-- budget_check_runs: 版の検査の結果（回ごと）。最新の回が「例外あり」の版は確定できない（FR-PLAN-BUDGET-017）。
-- budget_fixes: 確定の記録（追加だけ）。取り消しは action='void' の行。いまの確定版は最後の行から導く（FR-PLAN-BUDGET-019）。
-- 原本の結び付き（budget_source_links）は、共通の原本の表（source_documents）が入ってから足す。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる（0023 のあと）。

CREATE TABLE IF NOT EXISTS budget_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('file','screen','copy')),
 source_file_name TEXT CHECK(source_file_name IS NULL OR length(trim(source_file_name)) BETWEEN 1 AND 240),
 previous_version_id INTEGER,
 tax_rate_bps INTEGER NOT NULL CHECK(typeof(tax_rate_bps)='integer' AND tax_rate_bps BETWEEN 0 AND 9999),
 management_fee_yen INTEGER NOT NULL CHECK(typeof(management_fee_yen)='integer' AND management_fee_yen BETWEEN 0 AND 1000000000000),
 contingency_yen INTEGER NOT NULL CHECK(typeof(contingency_yen)='integer' AND contingency_yen BETWEEN 0 AND 1000000000000),
 sheet_created_on TEXT CHECK(sheet_created_on IS NULL OR (length(sheet_created_on)=10 AND substr(sheet_created_on,5,1)='-' AND substr(sheet_created_on,8,1)='-'
  AND ltrim(substr(sheet_created_on,1,4)||substr(sheet_created_on,6,2)||substr(sheet_created_on,9,2),'0123456789')='')),
 header_notes TEXT CHECK(header_notes IS NULL OR length(header_notes) BETWEEN 1 AND 2000),
 title TEXT CHECK(title IS NULL OR length(trim(title)) BETWEEN 1 AND 200),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,project_id,version_no), UNIQUE(org_id,project_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,project_id,previous_version_id) REFERENCES budget_versions(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((source_kind='file' AND source_file_name IS NOT NULL) OR (source_kind<>'file' AND source_file_name IS NULL)),
 CHECK(source_kind<>'copy' OR previous_version_id IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS budget_versions_sequence BEFORE INSERT ON budget_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM budget_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id)
 BEGIN SELECT RAISE(ABORT,'stale budget version'); END;
CREATE TRIGGER IF NOT EXISTS budget_versions_no_update BEFORE UPDATE ON budget_versions BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_versions_no_delete BEFORE DELETE ON budget_versions BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_versions_author_idx ON budget_versions(org_id,created_by);

CREATE TABLE IF NOT EXISTS budget_version_lines (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 category_code TEXT NOT NULL CHECK(category_code IN ('A','B','C','D','E','F','G','H','I','J','K')),
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 1000),
 work_id INTEGER,
 department_id INTEGER CHECK(department_id IS NULL OR (typeof(department_id)='integer' AND department_id>0)),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 unit_price_yen INTEGER CHECK(unit_price_yen IS NULL OR (typeof(unit_price_yen)='integer' AND unit_price_yen BETWEEN 0 AND 1000000000000)),
 qty_milli INTEGER CHECK(qty_milli IS NULL OR (typeof(qty_milli)='integer' AND qty_milli BETWEEN 0 AND 1000000000)),
 unit TEXT CHECK(unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 20),
 amount_ex_tax_yen INTEGER NOT NULL CHECK(typeof(amount_ex_tax_yen)='integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000),
 confirmed_source TEXT NOT NULL CHECK(confirmed_source IN ('none','manual','fill')),
 payment_month TEXT CHECK(payment_month IS NULL OR (length(payment_month)=7 AND substr(payment_month,5,1)='-'
  AND ltrim(substr(payment_month,1,4)||substr(payment_month,6,2),'0123456789')='' AND substr(payment_month,6,2) BETWEEN '01' AND '12')),
 source_cell TEXT CHECK(source_cell IS NULL OR length(source_cell) BETWEEN 2 AND 12),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
 UNIQUE(org_id,id), UNIQUE(org_id,version_id,category_code,line_no),
 FOREIGN KEY(org_id,project_id,version_id) REFERENCES budget_versions(org_id,project_id,id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id)
);
-- 確定した版には行を足せない（取り消しのあとも、一度確定した版は変えない）
CREATE TRIGGER IF NOT EXISTS budget_version_lines_fixed BEFORE INSERT ON budget_version_lines
 WHEN EXISTS(SELECT 1 FROM budget_fixes f WHERE f.org_id=NEW.org_id AND f.version_id=NEW.version_id)
 BEGIN SELECT RAISE(ABORT,'budget version already fixed'); END;
CREATE TRIGGER IF NOT EXISTS budget_version_lines_no_update BEFORE UPDATE ON budget_version_lines BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_version_lines_no_delete BEFORE DELETE ON budget_version_lines BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_version_lines_version_idx ON budget_version_lines(org_id,version_id);
CREATE INDEX IF NOT EXISTS budget_version_lines_work_idx ON budget_version_lines(org_id,project_id,work_id);

CREATE TABLE IF NOT EXISTS budget_check_runs (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_id INTEGER NOT NULL,
 run_no INTEGER NOT NULL CHECK(typeof(run_no)='integer' AND run_no>0),
 verdict TEXT NOT NULL CHECK(verdict IN ('draft_ok','exceptions')),
 passed INTEGER NOT NULL CHECK(typeof(passed)='integer' AND passed>=0),
 failed INTEGER NOT NULL CHECK(typeof(failed)='integer' AND failed>=0),
 checks_json TEXT NOT NULL CHECK(json_valid(checks_json) AND json_type(checks_json)='array' AND length(checks_json) BETWEEN 2 AND 20000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,version_id,run_no),
 FOREIGN KEY(org_id,project_id,version_id) REFERENCES budget_versions(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((verdict='draft_ok' AND failed=0) OR (verdict='exceptions' AND failed>0))
);
CREATE TRIGGER IF NOT EXISTS budget_check_runs_sequence BEFORE INSERT ON budget_check_runs
 WHEN NEW.run_no<>(SELECT COALESCE(MAX(r.run_no),0)+1 FROM budget_check_runs r WHERE r.org_id=NEW.org_id AND r.version_id=NEW.version_id)
 BEGIN SELECT RAISE(ABORT,'stale budget check run'); END;
CREATE TRIGGER IF NOT EXISTS budget_check_runs_no_update BEFORE UPDATE ON budget_check_runs BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_check_runs_no_delete BEFORE DELETE ON budget_check_runs BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_check_runs_author_idx ON budget_check_runs(org_id,created_by);

CREATE TABLE IF NOT EXISTS budget_fixes (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 action TEXT NOT NULL CHECK(action IN ('fix','void')),
 version_id INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,project_id,seq),
 FOREIGN KEY(org_id,project_id,version_id) REFERENCES budget_versions(org_id,project_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS budget_fixes_sequence BEFORE INSERT ON budget_fixes
 WHEN NEW.seq<>(SELECT COALESCE(MAX(f.seq),0)+1 FROM budget_fixes f WHERE f.org_id=NEW.org_id AND f.project_id=NEW.project_id)
 BEGIN SELECT RAISE(ABORT,'stale budget fix'); END;
-- 確定は、検査の回があり、最新の回が「例外なし」の版だけ
CREATE TRIGGER IF NOT EXISTS budget_fixes_requires_clean_check BEFORE INSERT ON budget_fixes
 WHEN NEW.action='fix' AND NEW.seq=(SELECT COALESCE(MAX(f.seq),0)+1 FROM budget_fixes f WHERE f.org_id=NEW.org_id AND f.project_id=NEW.project_id)
  AND COALESCE((SELECT r.verdict FROM budget_check_runs r WHERE r.org_id=NEW.org_id AND r.version_id=NEW.version_id ORDER BY r.run_no DESC LIMIT 1),'none')<>'draft_ok'
 BEGIN SELECT RAISE(ABORT,'budget version has exceptions'); END;
-- 取り消せるのは、いまの確定版（最後の行が同じ版の fix）だけ
CREATE TRIGGER IF NOT EXISTS budget_fixes_void_current BEFORE INSERT ON budget_fixes
 WHEN NEW.action='void' AND NEW.seq=(SELECT COALESCE(MAX(f.seq),0)+1 FROM budget_fixes f WHERE f.org_id=NEW.org_id AND f.project_id=NEW.project_id)
  AND NOT EXISTS(SELECT 1 FROM budget_fixes f WHERE f.org_id=NEW.org_id AND f.project_id=NEW.project_id AND f.seq=NEW.seq-1 AND f.action='fix' AND f.version_id=NEW.version_id)
 BEGIN SELECT RAISE(ABORT,'budget fix is not current'); END;
CREATE TRIGGER IF NOT EXISTS budget_fixes_no_update BEFORE UPDATE ON budget_fixes BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE TRIGGER IF NOT EXISTS budget_fixes_no_delete BEFORE DELETE ON budget_fixes BEGIN SELECT RAISE(ABORT,'budget record immutable'); END;
CREATE INDEX IF NOT EXISTS budget_fixes_version_idx ON budget_fixes(org_id,version_id);
CREATE INDEX IF NOT EXISTS budget_fixes_author_idx ON budget_fixes(org_id,created_by);
