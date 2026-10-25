-- 案件収支の予実の目標・計画の版と期間、行動の設定（フェーズ1の仕様書 #11。要件 FR-REV-YOJITSU-003・006・008〜012・014）。
-- 足すだけの移行: 予実の期間（1〜5年目・月初の日）、目標の版、計画の版（ヘッダと稼ぎ方別の子表）、採用の記録、設定の変数（参照表）、
-- 設定の行（版）の7表を作る。どの版も追記だけで、変更・削除は DB が断る（最初の版を残す。K-8）。
-- 有効な版は列に持たず読むたびに導く: 目標＝期間×種類×範囲ごとの最新の version_no、計画＝期間ごとの最新の採用の記録（seq）が指す版、
-- 設定＝変数×範囲ごとの最新の version_no（部分 UNIQUE で「有効な版は1つ」を持たない。K-8 の 2026-10-10 の直し）。
-- 目標・計画の額は owner_user_id の本人にだけ返す（読み取りは src/revenue/revenue-store.mjs の readTargets・readPlans。FR-REV-YOJITSU-006）。
-- 目標の版・計画の版・その子表・採用の記録は、表名でデータ一覧（src/admin/data-browser-routes.mjs の HIDDEN_TABLES）から外す。
-- 稼ぎ方の既定の売上率は移行 0012 の earning_type_rate_versions だけに持ち、設定の行には持たない（設定の変数の参照表に売上率の行を置かない。
-- FR-REV-YOJITSU-014・020）。設定の行の値（率と1件の額などの初期値）は移行で入れず、種かアプリで足す（K-9・K-19・J-13）。
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす。core の runbooks/07-cd.md 3-5）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作り、後ろの決まりの WHEN に「前の決まりに当たらない」を足す（D1 と PostgreSQL で同じ文で断る。0012 と同じ）。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、まだ当てていない DB にだけこのファイルを1回当てる（参照表の行の INSERT を含む）。

-- 予実の期間（FR-REV-YOJITSU-003）。組織ごとに1〜5年目を順に足し、各年目は月初の日に始まる12か月。n年目は n−1年目のちょうど12か月後に始まる。
-- 日の単位では扱わず、境の月の前後の日は月の単位で割り当てる。通算（5年）は列に持たない。目標・計画が期間を指すので、足したあとは変えない
CREATE TABLE IF NOT EXISTS yojitsu_periods (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES organizations(id),
 year_no INTEGER NOT NULL CHECK(typeof(year_no)='integer' AND year_no BETWEEN 1 AND 5),
 starts_on TEXT NOT NULL CHECK(length(starts_on)=10 AND substr(starts_on,5,1)='-' AND substr(starts_on,8,1)='-'
  AND ltrim(substr(starts_on,1,4)||substr(starts_on,6,2),'0123456789')=''
  AND substr(starts_on,6,2) BETWEEN '01' AND '12' AND substr(starts_on,9,2)='01'),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,year_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 決まりの順: 年目の順 → 12か月後に始まる
CREATE TRIGGER IF NOT EXISTS yojitsu_periods_order BEFORE INSERT ON yojitsu_periods
 WHEN NEW.year_no<>(SELECT COALESCE(MAX(p.year_no),0)+1 FROM yojitsu_periods p WHERE p.org_id=NEW.org_id)
 BEGIN SELECT RAISE(ABORT,'yojitsu period out of order'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_periods_contiguous BEFORE INSERT ON yojitsu_periods
 WHEN NEW.year_no=(SELECT COALESCE(MAX(p.year_no),0)+1 FROM yojitsu_periods p WHERE p.org_id=NEW.org_id) AND NEW.year_no>1
  AND NOT EXISTS(SELECT 1 FROM yojitsu_periods p WHERE p.org_id=NEW.org_id AND p.year_no=NEW.year_no-1
   AND substr(p.starts_on,6,5)=substr(NEW.starts_on,6,5) AND CAST(substr(p.starts_on,1,4) AS INTEGER)+1=CAST(substr(NEW.starts_on,1,4) AS INTEGER))
 BEGIN SELECT RAISE(ABORT,'yojitsu period must start 12 months after the previous'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_periods_no_update BEFORE UPDATE ON yojitsu_periods BEGIN SELECT RAISE(ABORT,'yojitsu period is fixed'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_periods_no_delete BEFORE DELETE ON yojitsu_periods BEGIN SELECT RAISE(ABORT,'yojitsu period is fixed'); END;

-- 目標の版（FR-REV-YOJITSU-008・009）。期間×種類（本人・会社）×範囲（全体・制作の取り分）ごとの連番で、最新の version_no が有効。
-- 根拠の種類: 額（amount_yen が要る）か、人件費×倍率（amount_yen は NULL で持ち、報酬の行〈フェーズ1 #17〉の12か月の合計×倍率を読むたびに計算する。
-- 倍率は100倍の整数で、既定は本人 300・会社 200。既定は src/revenue/yojitsu/yojitsu-model.mjs が入れる）。人件費×倍率は範囲が全体で単位が期間の合計だけ。
-- 稼ぎ方ごとの目標は5つの源泉別の列（NULL 可。源泉 n＝earning_types.profit_source が n の稼ぎ方: 1 制作受託・2 自社出資・3 製作委員会・4 買付・5 販売委託）で、
-- 範囲が全体の版だけが持つ。単位は期間の合計（月の値は年÷12。端数は最後の月）か毎月。状態は確認済み・仮置き（「有効・改めた」は列に持たない）。
-- decided_by は決めた人の名前（会社・代表など。owner_user_id とは別）、owner_user_id は額を読める本人（memberships への外部キー）
CREATE TABLE IF NOT EXISTS yojitsu_target_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 period_id INTEGER NOT NULL,
 target_kind TEXT NOT NULL CHECK(target_kind IN ('self','company')),
 target_scope TEXT NOT NULL CHECK(target_scope IN ('all','production_share')),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 basis_kind TEXT NOT NULL CHECK(basis_kind IN ('amount','labor_cost_multiple')),
 amount_yen INTEGER CHECK(amount_yen IS NULL OR (typeof(amount_yen)='integer' AND amount_yen BETWEEN 0 AND 9007199254740991)),
 multiplier_x100 INTEGER CHECK(multiplier_x100 IS NULL OR (typeof(multiplier_x100)='integer' AND multiplier_x100 BETWEEN 1 AND 10000)),
 source1_yen INTEGER CHECK(source1_yen IS NULL OR (typeof(source1_yen)='integer' AND source1_yen BETWEEN 0 AND 9007199254740991)),
 source2_yen INTEGER CHECK(source2_yen IS NULL OR (typeof(source2_yen)='integer' AND source2_yen BETWEEN 0 AND 9007199254740991)),
 source3_yen INTEGER CHECK(source3_yen IS NULL OR (typeof(source3_yen)='integer' AND source3_yen BETWEEN 0 AND 9007199254740991)),
 source4_yen INTEGER CHECK(source4_yen IS NULL OR (typeof(source4_yen)='integer' AND source4_yen BETWEEN 0 AND 9007199254740991)),
 source5_yen INTEGER CHECK(source5_yen IS NULL OR (typeof(source5_yen)='integer' AND source5_yen BETWEEN 0 AND 9007199254740991)),
 unit TEXT NOT NULL CHECK(unit IN ('period_total','monthly')),
 basis TEXT CHECK(basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
 status TEXT NOT NULL CHECK(status IN ('confirmed','provisional')),
 decided_on TEXT NOT NULL CHECK(length(decided_on)=10 AND substr(decided_on,5,1)='-' AND substr(decided_on,8,1)='-'
  AND ltrim(substr(decided_on,1,4)||substr(decided_on,6,2)||substr(decided_on,9,2),'0123456789')=''
  AND substr(decided_on,6,2) BETWEEN '01' AND '12' AND substr(decided_on,9,2) BETWEEN '01' AND '31'),
 decided_by TEXT CHECK(decided_by IS NULL OR length(trim(decided_by)) BETWEEN 1 AND 200),
 owner_user_id INTEGER NOT NULL,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,period_id,target_kind,target_scope,version_no),
 FOREIGN KEY(org_id,period_id) REFERENCES yojitsu_periods(org_id,id),
 FOREIGN KEY(org_id,owner_user_id) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((basis_kind='amount' AND amount_yen IS NOT NULL AND multiplier_x100 IS NULL)
  OR (basis_kind='labor_cost_multiple' AND amount_yen IS NULL AND multiplier_x100 IS NOT NULL AND target_scope='all' AND unit='period_total')),
 CHECK(target_scope='all' OR (source1_yen IS NULL AND source2_yen IS NULL AND source3_yen IS NULL AND source4_yen IS NULL AND source5_yen IS NULL))
);
CREATE TRIGGER IF NOT EXISTS yojitsu_target_versions_sequence BEFORE INSERT ON yojitsu_target_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(t.version_no),0)+1 FROM yojitsu_target_versions t
  WHERE t.org_id=NEW.org_id AND t.period_id=NEW.period_id AND t.target_kind=NEW.target_kind AND t.target_scope=NEW.target_scope)
 BEGIN SELECT RAISE(ABORT,'stale yojitsu target version'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_target_versions_no_update BEFORE UPDATE ON yojitsu_target_versions BEGIN SELECT RAISE(ABORT,'yojitsu target version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_target_versions_no_delete BEFORE DELETE ON yojitsu_target_versions BEGIN SELECT RAISE(ABORT,'yojitsu target version is append-only'); END;

-- 計画の版のヘッダ（FR-REV-YOJITSU-011）。期間ごとの連番。稼ぎ方別の額は子表 yojitsu_plan_amounts に持ち、earning_type_count はその行の数
-- （採用の記録は子表がそろった版だけを指せる。子表の行は版と同じ batch で足し、あとから足せない）。状態は確認済み・仮置き
-- （第1版は目標（会社）の額の仮置き。FR-REV-YOJITSU-013）。created_on は作った日（業務の日付）
CREATE TABLE IF NOT EXISTS yojitsu_plan_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 period_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 owner_user_id INTEGER NOT NULL,
 earning_type_count INTEGER NOT NULL CHECK(typeof(earning_type_count)='integer' AND earning_type_count BETWEEN 1 AND 20),
 status TEXT NOT NULL CHECK(status IN ('confirmed','provisional')),
 basis TEXT CHECK(basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
 created_on TEXT NOT NULL CHECK(length(created_on)=10 AND substr(created_on,5,1)='-' AND substr(created_on,8,1)='-'
  AND ltrim(substr(created_on,1,4)||substr(created_on,6,2)||substr(created_on,9,2),'0123456789')=''
  AND substr(created_on,6,2) BETWEEN '01' AND '12' AND substr(created_on,9,2) BETWEEN '01' AND '31'),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,period_id,id), UNIQUE(org_id,period_id,version_no),
 FOREIGN KEY(org_id,period_id) REFERENCES yojitsu_periods(org_id,id),
 FOREIGN KEY(org_id,owner_user_id) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS yojitsu_plan_versions_sequence BEFORE INSERT ON yojitsu_plan_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM yojitsu_plan_versions v WHERE v.org_id=NEW.org_id AND v.period_id=NEW.period_id)
 BEGIN SELECT RAISE(ABORT,'stale yojitsu plan version'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_plan_versions_no_update BEFORE UPDATE ON yojitsu_plan_versions BEGIN SELECT RAISE(ABORT,'yojitsu plan version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_plan_versions_no_delete BEFORE DELETE ON yojitsu_plan_versions BEGIN SELECT RAISE(ABORT,'yojitsu plan version is append-only'); END;

-- 計画の版の稼ぎ方別の額（子表。税別の整数円）。稼ぎ方は参照表 earning_types の行。行の数がヘッダの earning_type_count を超えたら断る。
-- 版が無い（別の組織の版を含む）ときは数の決まりに当てず、外部キーで断る
CREATE TABLE IF NOT EXISTS yojitsu_plan_amounts (
 org_id INTEGER NOT NULL,
 plan_version_id INTEGER NOT NULL,
 earning_type TEXT NOT NULL REFERENCES earning_types(code),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(org_id,plan_version_id,earning_type),
 FOREIGN KEY(org_id,plan_version_id) REFERENCES yojitsu_plan_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS yojitsu_plan_amounts_count BEFORE INSERT ON yojitsu_plan_amounts
 WHEN (SELECT COUNT(*) FROM yojitsu_plan_amounts a WHERE a.org_id=NEW.org_id AND a.plan_version_id=NEW.plan_version_id)
  >=(SELECT v.earning_type_count FROM yojitsu_plan_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.plan_version_id)
 BEGIN SELECT RAISE(ABORT,'yojitsu plan amount beyond the count'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_plan_amounts_no_update BEFORE UPDATE ON yojitsu_plan_amounts BEGIN SELECT RAISE(ABORT,'yojitsu plan version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_plan_amounts_no_delete BEFORE DELETE ON yojitsu_plan_amounts BEGIN SELECT RAISE(ABORT,'yojitsu plan version is append-only'); END;

-- 採用の記録（FR-REV-YOJITSU-012。期間ごと・追記だけ）。有効な計画は、期間ごとの最新の seq の行が指す版。第1版を作るときも1行書き、
-- 「戻す」は古い版を指す行を足すだけ。シナリオとの結び（scenario_set_id）は持たない（行動指標の計画 #12 の子表 plan_adoption_sources が持つ）。
-- period_id は期間ごとの最新の行を引く列で、指す版の期間と同じであることを複合の外部キーで守る。
-- 決まりの順: 連番 → 子表のそろった版 → 採用した日の順
CREATE TABLE IF NOT EXISTS plan_adoptions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 period_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 plan_version_id INTEGER NOT NULL,
 adopted_on TEXT NOT NULL CHECK(length(adopted_on)=10 AND substr(adopted_on,5,1)='-' AND substr(adopted_on,8,1)='-'
  AND ltrim(substr(adopted_on,1,4)||substr(adopted_on,6,2)||substr(adopted_on,9,2),'0123456789')=''
  AND substr(adopted_on,6,2) BETWEEN '01' AND '12' AND substr(adopted_on,9,2) BETWEEN '01' AND '31'),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,period_id,seq),
 FOREIGN KEY(org_id,period_id,plan_version_id) REFERENCES yojitsu_plan_versions(org_id,period_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS plan_adoptions_sequence BEFORE INSERT ON plan_adoptions
 WHEN NEW.seq<>(SELECT COALESCE(MAX(a.seq),0)+1 FROM plan_adoptions a WHERE a.org_id=NEW.org_id AND a.period_id=NEW.period_id)
 BEGIN SELECT RAISE(ABORT,'stale plan adoption'); END;
CREATE TRIGGER IF NOT EXISTS plan_adoptions_complete_version BEFORE INSERT ON plan_adoptions
 WHEN NEW.seq=(SELECT COALESCE(MAX(a.seq),0)+1 FROM plan_adoptions a WHERE a.org_id=NEW.org_id AND a.period_id=NEW.period_id)
  AND EXISTS(SELECT 1 FROM yojitsu_plan_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.plan_version_id
   AND v.earning_type_count<>(SELECT COUNT(*) FROM yojitsu_plan_amounts m WHERE m.org_id=v.org_id AND m.plan_version_id=v.id))
 BEGIN SELECT RAISE(ABORT,'plan version is incomplete'); END;
CREATE TRIGGER IF NOT EXISTS plan_adoptions_date_order BEFORE INSERT ON plan_adoptions
 WHEN NEW.seq=(SELECT COALESCE(MAX(a.seq),0)+1 FROM plan_adoptions a WHERE a.org_id=NEW.org_id AND a.period_id=NEW.period_id)
  AND NOT EXISTS(SELECT 1 FROM yojitsu_plan_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.plan_version_id
   AND v.earning_type_count<>(SELECT COUNT(*) FROM yojitsu_plan_amounts m WHERE m.org_id=v.org_id AND m.plan_version_id=v.id))
  AND EXISTS(SELECT 1 FROM plan_adoptions a WHERE a.org_id=NEW.org_id AND a.period_id=NEW.period_id AND a.seq=NEW.seq-1 AND a.adopted_on>NEW.adopted_on)
 BEGIN SELECT RAISE(ABORT,'plan adoption date goes back'); END;
CREATE TRIGGER IF NOT EXISTS plan_adoptions_no_update BEFORE UPDATE ON plan_adoptions BEGIN SELECT RAISE(ABORT,'plan adoption is append-only'); END;
CREATE TRIGGER IF NOT EXISTS plan_adoptions_no_delete BEFORE DELETE ON plan_adoptions BEGIN SELECT RAISE(ABORT,'plan adoption is append-only'); END;

-- 設定の変数（参照表。組織に依らない）。値の列の種類（bps・x100・months・yen のどれか1つ）と、ステップごとに持つ変数か（per_step）を決める。
-- 行動の率（その段から次の段へ進む率。面談→提案は step＝面談、提案→契約は step＝提案）と1件あたりの額（K-19）、着地確度、窓口の支払いの間（FR-REV-YOJITSU-014）。
-- 稼ぎ方の既定の売上率はここに置かない（earning_type_rate_versions だけが持つ。二重に持たない）。
-- 行動指標の計画 #9 が足す変数（1件の時間・通る確率など）は、移行でこの表に行を足し、値は種で設定の行に足す。値の種類とステップの要否は足したあと変えない
CREATE TABLE IF NOT EXISTS yojitsu_variables (
 code TEXT PRIMARY KEY CHECK(length(code) BETWEEN 1 AND 60 AND ltrim(code,'abcdefghijklmnopqrstuvwxyz0123456789_')=''),
 label TEXT NOT NULL UNIQUE CHECK(length(trim(label)) BETWEEN 1 AND 60),
 value_kind TEXT NOT NULL CHECK(value_kind IN ('bps','x100','months','yen')),
 per_step INTEGER NOT NULL CHECK(per_step IN (0,1)),
 sort_order INTEGER NOT NULL UNIQUE CHECK(sort_order>=0)
);
INSERT INTO yojitsu_variables(code,label,value_kind,per_step,sort_order) VALUES
 ('unit_amount','1件あたりの額','yen',0,1),
 ('conversion_rate','次の段へ進む率','bps',1,2),
 ('landing_probability','着地に数える確度','bps',0,3),
 ('payment_lag','窓口の支払いの間','months',0,4);
CREATE TRIGGER IF NOT EXISTS yojitsu_variables_fixed BEFORE UPDATE OF value_kind,per_step ON yojitsu_variables
 BEGIN SELECT RAISE(ABORT,'yojitsu variable kind is fixed'); END;

-- 設定の行（版。FR-REV-YOJITSU-014）。変数×範囲（scope と、その範囲で使う列）ごとの連番で、最新の version_no が有効。
-- 範囲: all（組織全体）・earning_type（稼ぎ方）・earning_type_step（稼ぎ方×ステップ）・project（案件）・channel（窓口。channel_code の参照先は
-- 行動指標の計画 #12 で決める）。範囲ごとに使う列だけが埋まる。値の列は bps・x100・months・yen のうちちょうど1つが埋まり、
-- それが変数の値の種類と同じ。状態（確認済み・監督申告・報道値・仮置き）は必須（K-9）。basis は根拠・1件あたりの中身などの文。
-- 決まりの順: 連番 → 値の種類 → ステップの要否
CREATE TABLE IF NOT EXISTS yojitsu_setting_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES organizations(id),
 variable_key TEXT NOT NULL REFERENCES yojitsu_variables(code),
 scope TEXT NOT NULL CHECK(scope IN ('all','earning_type','earning_type_step','project','channel')),
 earning_type TEXT REFERENCES earning_types(code),
 step TEXT REFERENCES action_steps(code),
 project_id INTEGER,
 channel_code TEXT CHECK(channel_code IS NULL OR (length(channel_code) BETWEEN 1 AND 60 AND length(trim(channel_code))=length(channel_code))),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 value_bps INTEGER CHECK(value_bps IS NULL OR (typeof(value_bps)='integer' AND value_bps BETWEEN 0 AND 10000)),
 value_x100 INTEGER CHECK(value_x100 IS NULL OR (typeof(value_x100)='integer' AND value_x100 BETWEEN 0 AND 9007199254740991)),
 value_months INTEGER CHECK(value_months IS NULL OR (typeof(value_months)='integer' AND value_months BETWEEN 0 AND 120)),
 value_yen INTEGER CHECK(value_yen IS NULL OR (typeof(value_yen)='integer' AND value_yen BETWEEN 0 AND 9007199254740991)),
 status TEXT NOT NULL CHECK(status IN ('confirmed','director_reported','press_reported','provisional')),
 basis TEXT CHECK(basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((scope='all' AND earning_type IS NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NULL)
  OR (scope='earning_type' AND earning_type IS NOT NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NULL)
  OR (scope='earning_type_step' AND earning_type IS NOT NULL AND step IS NOT NULL AND project_id IS NULL AND channel_code IS NULL)
  OR (scope='project' AND earning_type IS NULL AND step IS NULL AND project_id IS NOT NULL AND channel_code IS NULL)
  OR (scope='channel' AND earning_type IS NULL AND step IS NULL AND project_id IS NULL AND channel_code IS NOT NULL)),
 CHECK((value_bps IS NOT NULL AND value_x100 IS NULL AND value_months IS NULL AND value_yen IS NULL)
  OR (value_bps IS NULL AND value_x100 IS NOT NULL AND value_months IS NULL AND value_yen IS NULL)
  OR (value_bps IS NULL AND value_x100 IS NULL AND value_months IS NOT NULL AND value_yen IS NULL)
  OR (value_bps IS NULL AND value_x100 IS NULL AND value_months IS NULL AND value_yen IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS yojitsu_setting_versions_slot ON yojitsu_setting_versions(org_id,variable_key,scope,IFNULL(earning_type,''),IFNULL(step,''),IFNULL(project_id,0),IFNULL(channel_code,''),version_no);
CREATE TRIGGER IF NOT EXISTS yojitsu_setting_versions_sequence BEFORE INSERT ON yojitsu_setting_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(s.version_no),0)+1 FROM yojitsu_setting_versions s WHERE s.org_id=NEW.org_id AND s.variable_key=NEW.variable_key
  AND s.scope=NEW.scope AND s.earning_type IS NEW.earning_type AND s.step IS NEW.step AND s.project_id IS NEW.project_id AND s.channel_code IS NEW.channel_code)
 BEGIN SELECT RAISE(ABORT,'stale yojitsu setting version'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_setting_versions_value_kind BEFORE INSERT ON yojitsu_setting_versions
 WHEN NEW.version_no=(SELECT COALESCE(MAX(s.version_no),0)+1 FROM yojitsu_setting_versions s WHERE s.org_id=NEW.org_id AND s.variable_key=NEW.variable_key
  AND s.scope=NEW.scope AND s.earning_type IS NEW.earning_type AND s.step IS NEW.step AND s.project_id IS NEW.project_id AND s.channel_code IS NEW.channel_code)
  AND EXISTS(SELECT 1 FROM yojitsu_variables v WHERE v.code=NEW.variable_key
   AND NOT ((v.value_kind='bps' AND NEW.value_bps IS NOT NULL) OR (v.value_kind='x100' AND NEW.value_x100 IS NOT NULL)
    OR (v.value_kind='months' AND NEW.value_months IS NOT NULL) OR (v.value_kind='yen' AND NEW.value_yen IS NOT NULL)))
 BEGIN SELECT RAISE(ABORT,'yojitsu setting value does not match the variable'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_setting_versions_step_scope BEFORE INSERT ON yojitsu_setting_versions
 WHEN NEW.version_no=(SELECT COALESCE(MAX(s.version_no),0)+1 FROM yojitsu_setting_versions s WHERE s.org_id=NEW.org_id AND s.variable_key=NEW.variable_key
  AND s.scope=NEW.scope AND s.earning_type IS NEW.earning_type AND s.step IS NEW.step AND s.project_id IS NEW.project_id AND s.channel_code IS NEW.channel_code)
  AND NOT EXISTS(SELECT 1 FROM yojitsu_variables v WHERE v.code=NEW.variable_key
   AND NOT ((v.value_kind='bps' AND NEW.value_bps IS NOT NULL) OR (v.value_kind='x100' AND NEW.value_x100 IS NOT NULL)
    OR (v.value_kind='months' AND NEW.value_months IS NOT NULL) OR (v.value_kind='yen' AND NEW.value_yen IS NOT NULL)))
  AND EXISTS(SELECT 1 FROM yojitsu_variables v WHERE v.code=NEW.variable_key
   AND ((v.per_step=1 AND NEW.scope<>'earning_type_step') OR (v.per_step=0 AND NEW.scope='earning_type_step')))
 BEGIN SELECT RAISE(ABORT,'yojitsu setting scope does not match the variable'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_setting_versions_no_update BEFORE UPDATE ON yojitsu_setting_versions BEGIN SELECT RAISE(ABORT,'yojitsu setting version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_setting_versions_no_delete BEFORE DELETE ON yojitsu_setting_versions BEGIN SELECT RAISE(ABORT,'yojitsu setting version is append-only'); END;
