-- 制作の実費の行と、その取消・確認の記録（会社ルートの plans/2026-11-20-genba-inbox.md の手順8。決まりは brain の D-047 の3・7。
-- 要件 docs/requirements/expenses/production-cost.md の FR-EXP-PCOST-009・010・015・021・033・036・043〜046。取り込みの鍵は要確認14）。
-- 足すだけの移行: 3表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。番号 0068 は仮（調整役が決める）。
--
-- production_actual_lines: 実費の行（作品ごとに1行1件。追記だけ）。費目は予算書の大分類 A〜K（FR-PLAN-BUDGET-002 と同じコード）。
--   支払先は取引先マスタの ID（任意）と、領収書に書いてあった名前（必須）。税込は必須で、税抜と税額は分かるときだけ2つそろえて持ち、
--   税込＝税抜＋税額。分からないときは2つとも NULL（「不明」。推測で埋めない）。符号は税込・税抜・税額でそろえる（0円の行は持たない）。
--   証憑は共通の原本（source_documents）の ID、撮影日は shooting_days の ID（同じ作品の撮影日だけ）を、どちらも任意で指す。
--   入れ方は人（human）か AI（ai）。AI が入れた行は読みの記録（ai_read_json。読んだ欄・読めなかった欄・読んだモデルの名前。
--   原本の中身や本文は入れない。形の検査はアプリ src/expenses/production-actual/actual-lines-model.mjs）を必ず持ち、人の行は持たない。
--   取り込みの鍵（entry_key）は組織で一意。同じ取り込みを2回送っても行が二重にならず、同じ batch の取消から置き換えの行を引ける。
-- production_actual_line_voids: 取消（1行に1回まで。理由つき。置き換えた行を指せる。expense_line_voids と同じ形）。
--   置き換えの行は同じ作品の行だけ。取消した行を置き換えの行にはできない。
-- production_actual_line_checks: 確認（1行に1回まで。誰がいつ確かめたか）。未確認の印は列に持たず、確認の行が無いことから導く。
--   取消した行は確かめられない（直した行は置き換えの行を確かめ直す）。
-- 経費（expenses）に結ぶ行（FR-EXP-PCOST-034・035）は、この移行では作らない。結ぶときは別の表を足す（この表の列は変えない）。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる。

CREATE TABLE IF NOT EXISTS production_actual_lines (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 entry_key TEXT NOT NULL CHECK(length(entry_key) BETWEEN 1 AND 100
  AND ltrim(entry_key,'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.:')=''),
 spent_on TEXT NOT NULL CHECK(length(spent_on)=10 AND substr(spent_on,5,1)='-' AND substr(spent_on,8,1)='-'
  AND ltrim(substr(spent_on,1,4)||substr(spent_on,6,2)||substr(spent_on,9,2),'0123456789')=''
  AND substr(spent_on,6,2) BETWEEN '01' AND '12' AND substr(spent_on,9,2) BETWEEN '01' AND '31'),
 category_code TEXT NOT NULL CHECK(category_code IN ('A','B','C','D','E','F','G','H','I','J','K')),
 payee_partner_id INTEGER,
 payee_name TEXT NOT NULL CHECK(length(trim(payee_name)) BETWEEN 1 AND 200),
 description TEXT CHECK(description IS NULL OR length(trim(description)) BETWEEN 1 AND 500),
 inc_tax_yen INTEGER NOT NULL CHECK(typeof(inc_tax_yen)='integer' AND inc_tax_yen BETWEEN -1000000000000 AND 1000000000000 AND inc_tax_yen<>0),
 ex_tax_yen INTEGER CHECK(ex_tax_yen IS NULL OR (typeof(ex_tax_yen)='integer' AND ex_tax_yen BETWEEN -1000000000000 AND 1000000000000)),
 tax_yen INTEGER CHECK(tax_yen IS NULL OR (typeof(tax_yen)='integer' AND tax_yen BETWEEN -1000000000000 AND 1000000000000)),
 source_document_id INTEGER,
 shooting_day_id INTEGER,
 entry_method TEXT NOT NULL CHECK(entry_method IN ('human','ai')),
 ai_read_json TEXT CHECK(ai_read_json IS NULL OR (length(ai_read_json) BETWEEN 2 AND 2000 AND json_valid(ai_read_json)
  AND json_type(ai_read_json)='object' AND json_extract(ai_read_json,'$.model') IS NOT NULL)),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,entry_key),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,payee_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,work_id,shooting_day_id) REFERENCES shooting_days(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 -- 税抜・税額は2つとも無い（不明）か、2つともあって税込＝税抜＋税額。符号は税込にそろえる
 CHECK((ex_tax_yen IS NULL AND tax_yen IS NULL)
  OR (ex_tax_yen IS NOT NULL AND tax_yen IS NOT NULL AND ex_tax_yen+tax_yen=inc_tax_yen
   AND ((inc_tax_yen>0 AND ex_tax_yen>0 AND tax_yen>=0) OR (inc_tax_yen<0 AND ex_tax_yen<0 AND tax_yen<=0)))),
 -- AI が入れた行だけが読みの記録を持つ
 CHECK((entry_method='ai' AND ai_read_json IS NOT NULL) OR (entry_method='human' AND ai_read_json IS NULL))
);
CREATE TRIGGER IF NOT EXISTS production_actual_lines_no_update BEFORE UPDATE ON production_actual_lines BEGIN SELECT RAISE(ABORT,'production actual record immutable'); END;
CREATE TRIGGER IF NOT EXISTS production_actual_lines_no_delete BEFORE DELETE ON production_actual_lines BEGIN SELECT RAISE(ABORT,'production actual record immutable'); END;
CREATE INDEX IF NOT EXISTS production_actual_lines_work_idx ON production_actual_lines(org_id,work_id,spent_on);
CREATE INDEX IF NOT EXISTS production_actual_lines_partner_idx ON production_actual_lines(org_id,payee_partner_id);
CREATE INDEX IF NOT EXISTS production_actual_lines_document_idx ON production_actual_lines(org_id,source_document_id);
CREATE INDEX IF NOT EXISTS production_actual_lines_day_idx ON production_actual_lines(org_id,work_id,shooting_day_id);
CREATE INDEX IF NOT EXISTS production_actual_lines_author_idx ON production_actual_lines(org_id,created_by);

CREATE TABLE IF NOT EXISTS production_actual_line_voids (
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 line_id INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 replacement_line_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,line_id),
 UNIQUE(org_id,replacement_line_id),
 CHECK(replacement_line_id IS NULL OR replacement_line_id<>line_id),
 FOREIGN KEY(org_id,work_id,line_id) REFERENCES production_actual_lines(org_id,work_id,id),
 FOREIGN KEY(org_id,work_id,replacement_line_id) REFERENCES production_actual_lines(org_id,work_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 取消した行を置き換えの行にしない（取消の取消で行が生き返る道を作らない）
CREATE TRIGGER IF NOT EXISTS production_actual_line_voids_live_replacement BEFORE INSERT ON production_actual_line_voids
 WHEN NEW.replacement_line_id IS NOT NULL AND EXISTS(SELECT 1 FROM production_actual_line_voids v WHERE v.org_id=NEW.org_id AND v.line_id=NEW.replacement_line_id)
 BEGIN SELECT RAISE(ABORT,'voided production actual line cannot replace'); END;
CREATE TRIGGER IF NOT EXISTS production_actual_line_voids_no_update BEFORE UPDATE ON production_actual_line_voids BEGIN SELECT RAISE(ABORT,'production actual record immutable'); END;
CREATE TRIGGER IF NOT EXISTS production_actual_line_voids_no_delete BEFORE DELETE ON production_actual_line_voids BEGIN SELECT RAISE(ABORT,'production actual record immutable'); END;
CREATE INDEX IF NOT EXISTS production_actual_line_voids_work_idx ON production_actual_line_voids(org_id,work_id,line_id);
CREATE INDEX IF NOT EXISTS production_actual_line_voids_replacement_idx ON production_actual_line_voids(org_id,work_id,replacement_line_id);
CREATE INDEX IF NOT EXISTS production_actual_line_voids_author_idx ON production_actual_line_voids(org_id,created_by);

CREATE TABLE IF NOT EXISTS production_actual_line_checks (
 org_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 line_id INTEGER NOT NULL,
 checked_by INTEGER NOT NULL,
 checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,line_id),
 FOREIGN KEY(org_id,work_id,line_id) REFERENCES production_actual_lines(org_id,work_id,id),
 FOREIGN KEY(org_id,checked_by) REFERENCES memberships(org_id,user_id)
);
-- 取消した行は確かめない
CREATE TRIGGER IF NOT EXISTS production_actual_line_checks_live BEFORE INSERT ON production_actual_line_checks
 WHEN EXISTS(SELECT 1 FROM production_actual_line_voids v WHERE v.org_id=NEW.org_id AND v.line_id=NEW.line_id)
 BEGIN SELECT RAISE(ABORT,'voided production actual line cannot be checked'); END;
CREATE TRIGGER IF NOT EXISTS production_actual_line_checks_no_update BEFORE UPDATE ON production_actual_line_checks BEGIN SELECT RAISE(ABORT,'production actual record immutable'); END;
CREATE TRIGGER IF NOT EXISTS production_actual_line_checks_no_delete BEFORE DELETE ON production_actual_line_checks BEGIN SELECT RAISE(ABORT,'production actual record immutable'); END;
CREATE INDEX IF NOT EXISTS production_actual_line_checks_work_idx ON production_actual_line_checks(org_id,work_id,line_id);
CREATE INDEX IF NOT EXISTS production_actual_line_checks_author_idx ON production_actual_line_checks(org_id,checked_by);
