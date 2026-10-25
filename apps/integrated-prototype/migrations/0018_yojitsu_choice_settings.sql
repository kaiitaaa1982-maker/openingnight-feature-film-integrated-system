-- 案件収支の予実の、値の列に入らない設定（語を選ぶ設定と月の設定）の版（フェーズ1の仕様書 #14。要件 FR-REV-YOJITSU-045・034、要確認15 の推奨の形）。
-- 足すだけの移行: 1表を作る。追記だけで、変更・削除は DB が断る。有効な設定は列に持たず読むたびに導く: 組織×設定ごとの最新の version_no
-- （移行 0014 の目標の版・設定の行と同じ読み方。K-8）。
-- 設定は3つ: 採用するシナリオ（adopted_scenario。even・good・max・single。予測の行のシナリオ〈移行 0015〉と同じ語）、
-- 月別の表に入れる案件の範囲（monthly_scope。all＝企画中も含む・landing＝着地・contracted＝契約済み）、締めた月（closed_month。月初の日）。
-- 語の設定は value_code、月の設定は value_month のちょうど1つが埋まる。行動の率・1件あたりの額・着地確度など数の設定は、移行 0014 の
-- yojitsu_setting_versions（値の列は bps・x100・months・yen）に持ち、ここには持たない（語のコードを数の列に入れない。要確認15）。
-- 初期値は移行で入れず、種かアプリで足す（K-9）。予実の4段（src/revenue/yojitsu/yojitsu-model.mjs）は採用するシナリオを読み、
-- 無ければ着地予測と確度加重予測を null（未設定）にする（0 で埋めない）。
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす。core の runbooks/07-cd.md 3-5）。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、作るだけの文なので毎回当てる（0013・0015・0016 と同じ。0017 のあと）。

CREATE TABLE IF NOT EXISTS yojitsu_choice_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES organizations(id),
 choice_key TEXT NOT NULL CHECK(choice_key IN ('adopted_scenario','monthly_scope','closed_month')),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 value_code TEXT,
 value_month TEXT CHECK(value_month IS NULL OR (length(value_month)=10 AND substr(value_month,5,1)='-' AND substr(value_month,8,1)='-'
  AND ltrim(substr(value_month,1,4)||substr(value_month,6,2),'0123456789')=''
  AND substr(value_month,6,2) BETWEEN '01' AND '12' AND substr(value_month,9,2)='01')),
 basis TEXT CHECK(basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,choice_key,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((choice_key='adopted_scenario' AND value_code IS NOT NULL AND value_code IN ('even','good','max','single') AND value_month IS NULL)
  OR (choice_key='monthly_scope' AND value_code IS NOT NULL AND value_code IN ('all','landing','contracted') AND value_month IS NULL)
  OR (choice_key='closed_month' AND value_code IS NULL AND value_month IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS yojitsu_choice_versions_sequence BEFORE INSERT ON yojitsu_choice_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(c.version_no),0)+1 FROM yojitsu_choice_versions c WHERE c.org_id=NEW.org_id AND c.choice_key=NEW.choice_key)
 BEGIN SELECT RAISE(ABORT,'stale yojitsu choice version'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_choice_versions_no_update BEFORE UPDATE ON yojitsu_choice_versions BEGIN SELECT RAISE(ABORT,'yojitsu choice version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_choice_versions_no_delete BEFORE DELETE ON yojitsu_choice_versions BEGIN SELECT RAISE(ABORT,'yojitsu choice version is append-only'); END;
