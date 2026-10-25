-- フォルダ型の画面の最初の一切れ（会社ルートの plans/2026-10-18-folder-ui-first-slice.md の香盤表 #3。区切り U1）の2表。
-- 要件は docs/requirements/revenue/folder-entry.md（FR-REV-FOLDER）と report-intake.md の FR-REV-INTAKE-006・023・051・053。
-- 足すだけの移行: 2表と、その表だけのトリガーを作る。既存の表（sales_source_files・report_imports など）の列・制約・トリガーは変えない。
--
-- sales_source_file_terms: 1通の原本の「条件」の版（取引先・報告の種類・対象期間・受領日・報告月・申告合計）。
--   いまは登録して初めて取引先と期間が付く（report_imports）。登録前の原本を取引先×月のマスに置くために、受け取った時点の条件を持つ。
--   原本の表（sales_source_files）は変更も削除もできないので、受け取ったあとに決まる値は版で足す（FR-REV-INTAKE-006 の置き場所の候補）。
--   原本ごとの連番で、最新の version_no がその時点の条件（読むたびに導く。状態の列は持たない）。置き場所を誤ったときは理由つきで次の版を足す。
--   登録を始めた原本（sales_source_commits がある原本）には版を足せない（登録した報告の取引先・期間と食い違わないように）。変更・削除は DB が断る。
--   分からない値は NULL（未検証）で持ち、0 や空文字で埋めない:
--     対象期間 period_from・period_to   2つとも無いか、2つとも持つ（YYYY-MM-DD。終わりは始まり以後）
--     受領日 received_on                人が入れるまで無い。読み手は原本を取り込んだ日時で代え、代えたことを示す（FR-REV-INTAKE-051・FR-REV-FCST-017）
--     報告月 report_month               受領日から埋めない（FR-REV-INTAKE-068）。原本の欄か、人が入れた月だけ（YYYY-MM）
--     申告合計 declared_*               件数・税抜・税額・税込。入れていない項目は無い（FR-REV-INTAKE-023）。3つの額がそろえば 税込＝税抜＋税額
--
-- report_voids: 登録済みの報告の取消の記録（FR-REV-INTAKE-053。取り違えに限り、請求前、理由必須）。
--   受け口は、1つの書き込み（batch）で report_imports.status を 'void' にしてから、この行を足す（訂正版が superseded にするのと同じ形）。
--   この行は void になった報告にだけ足せる（先に void にしていなければ断る）。報告ごとに1行（主キー）。変更・削除は DB が断る。
--   請求済みの売上を含む報告は、既存のトリガー billed_report_locked_update が void への更新を断る（同じ書き込みの全体が戻る）。
--   請求済みの売上は void の報告に結べない（既存の billing_invoice_line_validate が有効な報告だけを請求に入れる）ので、記録のある報告は請求前に取り消したもの。
--   取消は active の報告からだけ・void から戻さない・記録の無い void を作らない、の3つは受け口が守る（report_imports にトリガーを足すと、
--   status を直接 'void' にする既存の試験の種〈test/settlement.test.mjs・scripts/sales-sheet-grain-fixtures.mjs〉が通らなくなるため。区切り U3 で受け口と試験を作る）。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす。core の runbooks/07-cd.md 3-5）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作り、後ろの決まりの WHEN に「前の決まりに当たらない」を足して、D1 と PostgreSQL で同じ文で断る
-- （0013・0016 と同じ。決まりの順: 版の番号 → 登録を始めた原本）。
-- 形の CHECK は GLOB を使わず、docs/rules/dialect.md の「形の CHECK」（length・substr・ltrim・BETWEEN）で書く。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、作るだけの文なので毎回当てる（0020 のあと）。
-- 番号は 0021。#131 の仮の 0019 を、#140 が使う 0019（稟議の版）と 0020（営業活動の結果）のあとへ振り直した。

CREATE TABLE IF NOT EXISTS sales_source_file_terms (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 file_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 partner_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other','publicity')),
 period_from TEXT CHECK(period_from IS NULL OR (length(period_from)=10 AND substr(period_from,5,1)='-' AND substr(period_from,8,1)='-'
  AND ltrim(substr(period_from,1,4)||substr(period_from,6,2)||substr(period_from,9,2),'0123456789')=''
  AND substr(period_from,6,2) BETWEEN '01' AND '12' AND substr(period_from,9,2) BETWEEN '01' AND '31')),
 period_to TEXT CHECK(period_to IS NULL OR (length(period_to)=10 AND substr(period_to,5,1)='-' AND substr(period_to,8,1)='-'
  AND ltrim(substr(period_to,1,4)||substr(period_to,6,2)||substr(period_to,9,2),'0123456789')=''
  AND substr(period_to,6,2) BETWEEN '01' AND '12' AND substr(period_to,9,2) BETWEEN '01' AND '31')),
 received_on TEXT CHECK(received_on IS NULL OR (length(received_on)=10 AND substr(received_on,5,1)='-' AND substr(received_on,8,1)='-'
  AND ltrim(substr(received_on,1,4)||substr(received_on,6,2)||substr(received_on,9,2),'0123456789')=''
  AND substr(received_on,6,2) BETWEEN '01' AND '12' AND substr(received_on,9,2) BETWEEN '01' AND '31')),
 report_month TEXT CHECK(report_month IS NULL OR (length(report_month)=7 AND substr(report_month,5,1)='-'
  AND ltrim(substr(report_month,1,4)||substr(report_month,6,2),'0123456789')=''
  AND substr(report_month,6,2) BETWEEN '01' AND '12')),
 declared_row_count INTEGER CHECK(declared_row_count IS NULL OR (typeof(declared_row_count)='integer' AND declared_row_count BETWEEN 0 AND 9007199254740991)),
 declared_amount_ex_tax INTEGER CHECK(declared_amount_ex_tax IS NULL OR (typeof(declared_amount_ex_tax)='integer' AND declared_amount_ex_tax BETWEEN -9007199254740991 AND 9007199254740991)),
 declared_tax_amount INTEGER CHECK(declared_tax_amount IS NULL OR (typeof(declared_tax_amount)='integer' AND declared_tax_amount BETWEEN -9007199254740991 AND 9007199254740991)),
 declared_amount_inc_tax INTEGER CHECK(declared_amount_inc_tax IS NULL OR (typeof(declared_amount_inc_tax)='integer' AND declared_amount_inc_tax BETWEEN -9007199254740991 AND 9007199254740991)),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,file_id,version_no),
 FOREIGN KEY(org_id,file_id) REFERENCES sales_source_files(org_id,id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 -- 対象期間は2つとも無いか、2つとも持って終わりが始まり以後
 CHECK((period_from IS NULL AND period_to IS NULL) OR (period_from IS NOT NULL AND period_to IS NOT NULL AND period_to>=period_from)),
 -- 申告合計の3つの額がそろえば 税込＝税抜＋税額（docs/rules/money.md。片方から計算しない）
 CHECK(declared_amount_ex_tax IS NULL OR declared_tax_amount IS NULL OR declared_amount_inc_tax IS NULL
  OR declared_amount_inc_tax=declared_amount_ex_tax+declared_tax_amount)
);
-- 版の番号は原本ごとの最後の番号の次だけ（古い画面からの書き込み・番号の飛ばし・同じ番号の入れ直しを断る）
CREATE TRIGGER IF NOT EXISTS sales_source_file_terms_sequence BEFORE INSERT ON sales_source_file_terms
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(t.version_no),0)+1 FROM sales_source_file_terms t WHERE t.org_id=NEW.org_id AND t.file_id=NEW.file_id)
 BEGIN SELECT RAISE(ABORT,'1通の条件の版の番号が連番ではありません（古い画面からの書き込みです）'); END;
-- 登録を始めた原本（分割の登録が1件でもある原本）には、条件の版を足さない
CREATE TRIGGER IF NOT EXISTS sales_source_file_terms_before_commit BEFORE INSERT ON sales_source_file_terms
 WHEN NEW.version_no=(SELECT COALESCE(MAX(t.version_no),0)+1 FROM sales_source_file_terms t WHERE t.org_id=NEW.org_id AND t.file_id=NEW.file_id)
  AND EXISTS(SELECT 1 FROM sales_source_commits x WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id)
 BEGIN SELECT RAISE(ABORT,'登録を始めた原本の1通の条件は変えられません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_file_terms_no_update BEFORE UPDATE ON sales_source_file_terms
 BEGIN SELECT RAISE(ABORT,'1通の条件の版は変更できません。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_file_terms_no_delete BEFORE DELETE ON sales_source_file_terms
 BEGIN SELECT RAISE(ABORT,'1通の条件の版は削除できません'); END;

CREATE TABLE IF NOT EXISTS report_voids (
 org_id INTEGER NOT NULL,
 report_id INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,report_id),
 FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 取消の記録は、同じ書き込みで報告を void にしたあとにだけ足す（有効な報告・置き換え済みの報告・別の組織の報告には足さない）
CREATE TRIGGER IF NOT EXISTS report_voids_requires_void BEFORE INSERT ON report_voids
 WHEN NOT EXISTS(SELECT 1 FROM report_imports r WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.status='void')
 BEGIN SELECT RAISE(ABORT,'取消の記録は、同じ書き込みで報告を取消（void）にしてから足します'); END;
CREATE TRIGGER IF NOT EXISTS report_voids_no_update BEFORE UPDATE ON report_voids
 BEGIN SELECT RAISE(ABORT,'報告の取消の記録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS report_voids_no_delete BEFORE DELETE ON report_voids
 BEGIN SELECT RAISE(ABORT,'報告の取消の記録は削除できません'); END;
