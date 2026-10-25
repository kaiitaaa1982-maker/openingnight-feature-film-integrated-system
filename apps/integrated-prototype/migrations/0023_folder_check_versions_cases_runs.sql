-- フォルダ型の画面の区切り U2a 後半（会社ルートの plans/2026-10-18-folder-ui-first-slice.md の香盤表 #5・#7）。
-- 要件は docs/requirements/revenue/folder-entry.md の FR-REV-FOLDER-008・009・013。
-- 足すだけの移行: 4表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。
--
-- 番号は 0023。区切りの文書は表3〜6を 0022 からと書いていた。#145 が 0022 を稟議の払込の取消に使ったので、この枝は 0023 から振る。
-- この枝に 0022 のファイルは無い（#145 は別の枝。中身は混ぜない）。
--
-- 表3 report_check_versions: 検査の決まりの版（FR-REV-FOLDER-009）。
--   型は取引先×報告の種類。版は、その型の列対応の版（report_mapping_versions）を1つ指す。
--   持つもの: 指す列対応の版、検算の決まり、見出しの一致に使う列名、取り込まない行の規則、税抜・税額・税込の列名、商品で分けるか、版の理由、誰が、いつ。
--   税抜・税額・税込の列名と商品で分けるかは、009 の括弧の列挙には無い。008 が型の性質として書いており、検査がこの2つ無しでは走らないので版の列にした。
--   取り込まない行の規則の1件の形は文書に無い。JSON の配列として持つだけで、この移行は中身を解釈しない。
--   取引先×報告の種類ごとの連番。追加のみ。変更と削除は DB が断る。
--   指す列対応の版は、同じ組織・同じ取引先・同じ報告の種類の profile に属するものだけ（別の型の版は断る）。
--
-- 表4 report_check_cases: 型の版ごとの正解表（架空の原本と、7つの検査の期待する合否）。
--   出どころは種（ふつうの通・端数のある通・取り込まない行のある通）か人の直し。追加のみ。実在の原本は入れない（fictional は 1 だけ）。
--   人の直しを足せるのは、代表（memberships.role='admin' で在籍が有効）か、財務担当（同じ組織で permission='edit' の在籍が有効。期限が切れていない）だけ。
--   財務担当の見分けは、既存の財務権限（project_memberships.permission='edit'）と同じ読み。種の行はこの止めの対象外。
--   正答率（一致した件数÷件数。0件は100%にしない）は DB に列を持たず、読むたびに導く。
--
-- 表5 source_check_runs: 1通の検査の結果を回ごとに残す（FR-REV-FOLDER-008）。
--   原本ごとの連番。再検査は新しい回を足すだけで、登録（sales_source_commits）を書き換えるトリガーは無い。
--   判定の語は5つ（自動で確定・人の確認・人の確認（実績が足りない）・形が違う・人が読む）のキー。合否の数と正解表の件数を、その回の値として持つ。
--   判定の語と合否の数が食い違う行を DB は止めない（純関数の戻りを書くのは受け口。区切り U2b）。
--
-- 表6 source_sampling_reviews: 抜き取りの記録（FR-REV-FOLDER-013）。
--   結果は直し無し・型の誤り・原本の誤りの3つ。追加のみ。型の誤りを足しても、新しい版は自動では作らない（版を足すのは承認の操作）。
--   実績の通数は数える列を持たず、検査の回とこの記録から読むたびに導く。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作り、後ろの決まりの WHEN に「前の決まりに当たらない」を足して、D1 と PostgreSQL で同じ文で断る。
-- 形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs の LocalDatabase）は、作るだけの文なので毎回当てる（0021 のあと）。

CREATE TABLE IF NOT EXISTS report_check_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 partner_id INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('theatrical','digital','package','broadcast','other','publicity')),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 mapping_version_id INTEGER NOT NULL,
 checks_json TEXT NOT NULL CHECK(json_valid(checks_json) AND json_type(checks_json)='array' AND json_array_length(checks_json) BETWEEN 0 AND 50 AND length(checks_json) BETWEEN 2 AND 4000),
 header_columns_json TEXT NOT NULL CHECK(json_valid(header_columns_json) AND json_type(header_columns_json)='array' AND json_array_length(header_columns_json) BETWEEN 1 AND 200 AND length(header_columns_json) BETWEEN 2 AND 4000),
 skip_rules_json TEXT NOT NULL CHECK(json_valid(skip_rules_json) AND json_type(skip_rules_json)='array' AND json_array_length(skip_rules_json) BETWEEN 0 AND 50 AND length(skip_rules_json) BETWEEN 2 AND 4000),
 money_columns_json TEXT NOT NULL CHECK(json_valid(money_columns_json) AND json_type(money_columns_json)='object' AND length(money_columns_json) BETWEEN 2 AND 2000
  AND json_extract(money_columns_json,'$.amountExTax') IS NOT NULL AND length(json_extract(money_columns_json,'$.amountExTax')) BETWEEN 1 AND 80
  AND json_extract(money_columns_json,'$.taxAmount') IS NOT NULL AND length(json_extract(money_columns_json,'$.taxAmount')) BETWEEN 1 AND 80
  AND json_extract(money_columns_json,'$.amountIncTax') IS NOT NULL AND length(json_extract(money_columns_json,'$.amountIncTax')) BETWEEN 1 AND 80),
 split_by_product INTEGER NOT NULL CHECK(typeof(split_by_product)='integer' AND split_by_product IN (0,1)),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,partner_id,kind,version_no),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,mapping_version_id) REFERENCES report_mapping_versions(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 版の番号は取引先×報告の種類ごとの最後の番号の次だけ
CREATE TRIGGER IF NOT EXISTS report_check_versions_sequence BEFORE INSERT ON report_check_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM report_check_versions v WHERE v.org_id=NEW.org_id AND v.partner_id=NEW.partner_id AND v.kind=NEW.kind)
 BEGIN SELECT RAISE(ABORT,'検査の決まりの版の番号が連番ではありません'); END;
-- 指す列対応の版は、同じ取引先×報告の種類のものだけ（番号が連番のときだけ、この文で断る）
CREATE TRIGGER IF NOT EXISTS report_check_versions_mapping_match BEFORE INSERT ON report_check_versions
 WHEN NEW.version_no=(SELECT COALESCE(MAX(v.version_no),0)+1 FROM report_check_versions v WHERE v.org_id=NEW.org_id AND v.partner_id=NEW.partner_id AND v.kind=NEW.kind)
  AND NOT EXISTS(SELECT 1 FROM report_mapping_versions mv JOIN report_mapping_profiles p ON p.org_id=mv.org_id AND p.id=mv.profile_id
   WHERE mv.org_id=NEW.org_id AND mv.id=NEW.mapping_version_id AND p.partner_id=NEW.partner_id AND p.kind=NEW.kind)
 BEGIN SELECT RAISE(ABORT,'検査の決まりの版が指す列対応の版は、同じ取引先と報告の種類のものです'); END;
CREATE TRIGGER IF NOT EXISTS report_check_versions_no_update BEFORE UPDATE ON report_check_versions
 BEGIN SELECT RAISE(ABORT,'検査の決まりの版は変更できません。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS report_check_versions_no_delete BEFORE DELETE ON report_check_versions
 BEGIN SELECT RAISE(ABORT,'検査の決まりの版は削除できません'); END;

CREATE TABLE IF NOT EXISTS report_check_cases (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 check_version_id INTEGER NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('normal','fractional','excluded','human_fix')),
 fictional INTEGER NOT NULL CHECK(typeof(fictional)='integer' AND fictional=1),
 input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object' AND length(input_json) BETWEEN 2 AND 65536),
 expected_json TEXT NOT NULL CHECK(json_valid(expected_json) AND json_type(expected_json)='object' AND length(expected_json) BETWEEN 2 AND 2000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,check_version_id) REFERENCES report_check_versions(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 人の直しは、代表（管理者で在籍が有効）か財務担当（permission='edit' で、在籍と権限の期限が切れていない）だけ
CREATE TRIGGER IF NOT EXISTS report_check_cases_human_fix_approval BEFORE INSERT ON report_check_cases
 WHEN NEW.origin='human_fix'
  AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.org_id=NEW.org_id AND m.user_id=NEW.created_by AND m.role='admin' AND m.active=1
   AND (m.expires_at IS NULL OR m.expires_at>CURRENT_TIMESTAMP))
  AND NOT EXISTS(SELECT 1 FROM project_memberships pm JOIN memberships m ON m.org_id=pm.org_id AND m.user_id=pm.user_id
   WHERE pm.org_id=NEW.org_id AND pm.user_id=NEW.created_by AND pm.permission='edit' AND m.active=1
   AND (m.expires_at IS NULL OR m.expires_at>CURRENT_TIMESTAMP)
   AND (pm.expires_at IS NULL OR pm.expires_at>CURRENT_TIMESTAMP))
 BEGIN SELECT RAISE(ABORT,'人の直しを正解表に足せるのは、代表か財務担当だけです'); END;
CREATE TRIGGER IF NOT EXISTS report_check_cases_no_update BEFORE UPDATE ON report_check_cases
 BEGIN SELECT RAISE(ABORT,'正解表の行は変更できません。新しい行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS report_check_cases_no_delete BEFORE DELETE ON report_check_cases
 BEGIN SELECT RAISE(ABORT,'正解表の行は削除できません'); END;

CREATE TABLE IF NOT EXISTS source_check_runs (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 file_id INTEGER NOT NULL,
 check_version_id INTEGER NOT NULL,
 run_no INTEGER NOT NULL CHECK(typeof(run_no)='integer' AND run_no>0),
 checks_passed INTEGER NOT NULL CHECK(typeof(checks_passed)='integer' AND checks_passed BETWEEN 0 AND 9007199254740991),
 checks_total INTEGER NOT NULL CHECK(typeof(checks_total)='integer' AND checks_total BETWEEN 0 AND 9007199254740991 AND checks_passed<=checks_total),
 judgment TEXT NOT NULL CHECK(judgment IN ('auto','human','human_record','shape','unread')),
 golden_matched INTEGER NOT NULL CHECK(typeof(golden_matched)='integer' AND golden_matched BETWEEN 0 AND 9007199254740991),
 golden_total INTEGER NOT NULL CHECK(typeof(golden_total)='integer' AND golden_total BETWEEN 0 AND 9007199254740991),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,file_id,run_no),
 FOREIGN KEY(org_id,file_id) REFERENCES sales_source_files(org_id,id),
 FOREIGN KEY(org_id,check_version_id) REFERENCES report_check_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS source_check_runs_sequence BEFORE INSERT ON source_check_runs
 WHEN NEW.run_no<>(SELECT COALESCE(MAX(r.run_no),0)+1 FROM source_check_runs r WHERE r.org_id=NEW.org_id AND r.file_id=NEW.file_id)
 BEGIN SELECT RAISE(ABORT,'検査の回の番号が連番ではありません'); END;
CREATE TRIGGER IF NOT EXISTS source_check_runs_no_update BEFORE UPDATE ON source_check_runs
 BEGIN SELECT RAISE(ABORT,'検査の結果の回は変更できません。新しい回を足してください'); END;
CREATE TRIGGER IF NOT EXISTS source_check_runs_no_delete BEFORE DELETE ON source_check_runs
 BEGIN SELECT RAISE(ABORT,'検査の結果の回は削除できません'); END;

CREATE TABLE IF NOT EXISTS source_sampling_reviews (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 check_run_id INTEGER NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('clean','type_error','source_error')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,check_run_id) REFERENCES source_check_runs(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS source_sampling_reviews_no_update BEFORE UPDATE ON source_sampling_reviews
 BEGIN SELECT RAISE(ABORT,'抜き取りの記録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS source_sampling_reviews_no_delete BEFORE DELETE ON source_sampling_reviews
 BEGIN SELECT RAISE(ABORT,'抜き取りの記録は削除できません'); END;
