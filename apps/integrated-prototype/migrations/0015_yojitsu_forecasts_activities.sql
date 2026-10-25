-- 案件収支の予実の案件×月の予測の版と活動記録（フェーズ1の仕様書 #13。要件 FR-REV-YOJITSU-023・026・035・037）。
-- 足すだけの移行: 予測の版（案件ごとのヘッダ）・予測の行・活動記録・活動記録の取消の4表を作る。どれも追記だけで、変更・削除は DB が断る。
-- 有効な予測は列に持たず読むたびに導く: 案件ごとの最新の version_no の版の、予測に使う印（use_for_forecast）が 1 の行。
-- 試算の写しを改めて取り込むと新しい版が足され、前の版は残って「予測に使う＝いいえ」と読める（FR-REV-YOJITSU-026。目標・計画の版の K-8 と同じ読み方）。
-- 案件は外部キーで必須（予測も活動記録も）。月は月初の日だけ。金額は正の整数の円で、符号は区分マスタ（移行 0012 の cashflow_categories）の入出金で決める。
-- 活動記録の行の中身（相手・したこと・成果物・次の一手）は、記録した人（created_by）の本人にだけ返す（src/revenue/revenue-store.mjs の
-- readActivityRecords。FR-REV-YOJITSU-037）。行動の実績件数は、中身を出さず件数だけを数えて返す（readActivityTallies）。
-- 活動記録の直しは、取消の行（yojitsu_activity_cancellations）を足して、正しい行を足し直す（FR-REV-YOJITSU-035）。
-- 既存の sales_activities は広げず、取り込んだ行は source_sales_activity_id（組織の中で UNIQUE）で二重を止める（行動指標の計画 K2-15）。
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす。core の runbooks/07-cd.md 3-5）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作る（0012・0014 と同じ）。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、作るだけの文なので毎回当てる（0013 と同じ。0014 のあと）。

-- 予測の版（FR-REV-YOJITSU-023。案件ごとの連番で、最新の version_no が有効）。版は案件の予測の全部の行を持ち、改めるときは全部の行を持つ版を足す。
-- label は版の名前（例: 試算の写し 2026-10-20）、created_on は作った日（業務の日付）。source_kind は 試算の写し（trial_import）・手入力（manual）・
-- 施策の既定の予測行（initiative。フェーズ1 #12a）で、試算の写しだけが元のファイルの SHA-256（小文字の16進64桁）を持つ（同じ写しを二度取り込まない）。
-- line_count は行の数（1〜3824。1つの版の文が D1 の1回の batch〈480文。1文に8行〉に収まる数）。行は版と同じ batch で、行の番号の順に足す。
-- 行の番号は 1 からの連番（飛ばせない）で line_count まで。行が line_count に満たない版（アプリを通さない書き込みで欠けた版）は
-- 有効な予測にしない（src/revenue/yojitsu/forecast-model.mjs の latestForecastVersionIds）。そろった版にはそれ以上行を足せない
CREATE TABLE IF NOT EXISTS yojitsu_forecast_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 100),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('trial_import','manual','initiative')),
 source TEXT NOT NULL CHECK(length(trim(source)) BETWEEN 1 AND 1000),
 source_sha256 TEXT CHECK(source_sha256 IS NULL OR (length(source_sha256)=64 AND ltrim(source_sha256,'0123456789abcdef')='')),
 line_count INTEGER NOT NULL CHECK(typeof(line_count)='integer' AND line_count BETWEEN 1 AND 3824),
 created_on TEXT NOT NULL CHECK(length(created_on)=10 AND substr(created_on,5,1)='-' AND substr(created_on,8,1)='-'
  AND ltrim(substr(created_on,1,4)||substr(created_on,6,2)||substr(created_on,9,2),'0123456789')=''
  AND substr(created_on,6,2) BETWEEN '01' AND '12' AND substr(created_on,9,2) BETWEEN '01' AND '31'),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,project_id,version_no),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((source_kind='trial_import' AND source_sha256 IS NOT NULL) OR (source_kind<>'trial_import' AND source_sha256 IS NULL))
);
CREATE TRIGGER IF NOT EXISTS yojitsu_forecast_versions_sequence BEFORE INSERT ON yojitsu_forecast_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM yojitsu_forecast_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id)
 BEGIN SELECT RAISE(ABORT,'stale yojitsu forecast version'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_forecast_versions_no_update BEFORE UPDATE ON yojitsu_forecast_versions BEGIN SELECT RAISE(ABORT,'yojitsu forecast version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_forecast_versions_no_delete BEFORE DELETE ON yojitsu_forecast_versions BEGIN SELECT RAISE(ABORT,'yojitsu forecast version is append-only'); END;

-- 予測の行（FR-REV-YOJITSU-023）。シナリオ（試算のケース even・good・MAX と単一。行動指標の計画のシナリオとは別の軸）・月（月初の日）・
-- 区分（組織の区分マスタ）・項目・相手・金額（税別の正の整数の円）・状態（確認済み・監督申告・報道値・仮置き。K-9）・予測に使う印。
-- 予測に使う印は版の中の印（試算の窓口のうち外すもの）で、前の版の行は印に関わらず使わない。行の番号は 1〜版の line_count の連番
CREATE TABLE IF NOT EXISTS yojitsu_forecast_lines (
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL,
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no>0),
 scenario TEXT NOT NULL CHECK(scenario IN ('even','good','max','single')),
 forecast_month TEXT NOT NULL CHECK(length(forecast_month)=10 AND substr(forecast_month,5,1)='-' AND substr(forecast_month,8,1)='-'
  AND ltrim(substr(forecast_month,1,4)||substr(forecast_month,6,2),'0123456789')=''
  AND substr(forecast_month,6,2) BETWEEN '01' AND '12' AND substr(forecast_month,9,2)='01'),
 category_id INTEGER NOT NULL,
 item TEXT NOT NULL CHECK(length(trim(item)) BETWEEN 1 AND 200),
 counterparty TEXT CHECK(counterparty IS NULL OR length(trim(counterparty)) BETWEEN 1 AND 200),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
 status TEXT NOT NULL CHECK(status IN ('confirmed','director_reported','press_reported','provisional')),
 use_for_forecast INTEGER NOT NULL CHECK(use_for_forecast IN (0,1)),
 PRIMARY KEY(org_id,project_id,version_no,line_no),
 FOREIGN KEY(org_id,project_id,version_no) REFERENCES yojitsu_forecast_versions(org_id,project_id,version_no),
 FOREIGN KEY(org_id,category_id) REFERENCES cashflow_categories(org_id,id)
);
-- 版が無い（別の組織の版を含む）ときは数の決まりに当てず、外部キーで断る
CREATE TRIGGER IF NOT EXISTS yojitsu_forecast_lines_within_count BEFORE INSERT ON yojitsu_forecast_lines
 WHEN NEW.line_no>(SELECT v.line_count FROM yojitsu_forecast_versions v WHERE v.org_id=NEW.org_id AND v.project_id=NEW.project_id AND v.version_no=NEW.version_no)
 BEGIN SELECT RAISE(ABORT,'yojitsu forecast line beyond the count'); END;
-- 行の番号は版の中の最後の番号の次だけ（1 から順に足す。番号を飛ばした行や、欠けた番号を後から埋める行を断る）
CREATE TRIGGER IF NOT EXISTS yojitsu_forecast_lines_in_order BEFORE INSERT ON yojitsu_forecast_lines
 WHEN NEW.line_no<>(SELECT COALESCE(MAX(l.line_no),0)+1 FROM yojitsu_forecast_lines l WHERE l.org_id=NEW.org_id AND l.project_id=NEW.project_id AND l.version_no=NEW.version_no)
 BEGIN SELECT RAISE(ABORT,'yojitsu forecast line out of order'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_forecast_lines_no_update BEFORE UPDATE ON yojitsu_forecast_lines BEGIN SELECT RAISE(ABORT,'yojitsu forecast version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_forecast_lines_no_delete BEFORE DELETE ON yojitsu_forecast_lines BEGIN SELECT RAISE(ABORT,'yojitsu forecast version is append-only'); END;

-- 活動記録（FR-REV-YOJITSU-035）。日付・案件（必須）・稼ぎ方（空なら案件の稼ぎ方で数える）・ステップ（行動のステップの参照表の段のコード。
-- 細目の段は親の step へ畳んで数える。空は数えない＝Excel の「その他」）・相手・したこと・成果物・次の一手・期日・結果（進んだ・保留・失注）・
-- 作品（NULL 可。作品の無い段も記録できる。作品は案件の作品だけ）・取り込んだ sales_activities の行（組織の中で1回だけ）・記録した人。
-- 期日は次の一手に付ける。取り込んだ行の案件と作品は、元の sales_activities の行と同じでなければ断る
CREATE TABLE IF NOT EXISTS yojitsu_activity_records (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 project_id INTEGER NOT NULL,
 occurred_on TEXT NOT NULL CHECK(length(occurred_on)=10 AND substr(occurred_on,5,1)='-' AND substr(occurred_on,8,1)='-'
  AND ltrim(substr(occurred_on,1,4)||substr(occurred_on,6,2)||substr(occurred_on,9,2),'0123456789')=''
  AND substr(occurred_on,6,2) BETWEEN '01' AND '12' AND substr(occurred_on,9,2) BETWEEN '01' AND '31'),
 earning_type TEXT REFERENCES earning_types(code),
 step TEXT REFERENCES action_steps(code),
 counterparty TEXT CHECK(counterparty IS NULL OR length(trim(counterparty)) BETWEEN 1 AND 200),
 summary TEXT NOT NULL CHECK(length(trim(summary)) BETWEEN 1 AND 1000),
 deliverable TEXT CHECK(deliverable IS NULL OR length(trim(deliverable)) BETWEEN 1 AND 1000),
 next_action TEXT CHECK(next_action IS NULL OR length(trim(next_action)) BETWEEN 1 AND 1000),
 next_due_on TEXT CHECK(next_due_on IS NULL OR (length(next_due_on)=10 AND substr(next_due_on,5,1)='-' AND substr(next_due_on,8,1)='-'
  AND ltrim(substr(next_due_on,1,4)||substr(next_due_on,6,2)||substr(next_due_on,9,2),'0123456789')=''
  AND substr(next_due_on,6,2) BETWEEN '01' AND '12' AND substr(next_due_on,9,2) BETWEEN '01' AND '31')),
 result TEXT NOT NULL CHECK(result IN ('advanced','on_hold','lost')),
 work_id INTEGER,
 source_sales_activity_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,source_sales_activity_id),
 FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
 FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
 FOREIGN KEY(org_id,source_sales_activity_id) REFERENCES sales_activities(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(next_due_on IS NULL OR next_action IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS yojitsu_activity_records_project ON yojitsu_activity_records(org_id,project_id,occurred_on);
-- 元の行が無いときは外部キーで断る（ここでは当てない）
CREATE TRIGGER IF NOT EXISTS yojitsu_activity_records_source_match BEFORE INSERT ON yojitsu_activity_records
 WHEN NEW.source_sales_activity_id IS NOT NULL AND EXISTS(SELECT 1 FROM sales_activities s WHERE s.org_id=NEW.org_id AND s.id=NEW.source_sales_activity_id
  AND (s.project_id<>NEW.project_id OR s.work_id IS NOT NEW.work_id))
 BEGIN SELECT RAISE(ABORT,'activity record does not match the sales activity'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_activity_records_no_update BEFORE UPDATE ON yojitsu_activity_records BEGIN SELECT RAISE(ABORT,'activity record is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_activity_records_no_delete BEFORE DELETE ON yojitsu_activity_records BEGIN SELECT RAISE(ABORT,'activity record is append-only'); END;

-- 活動記録の取消（追記だけ。1行に1回）。取り消せるのは記録した人だけ（行は記録した人にしか見えない。FR-REV-YOJITSU-037）。
-- 取り消した行は数えず、行の中身も「取消」として本人に返す
CREATE TABLE IF NOT EXISTS yojitsu_activity_cancellations (
 org_id INTEGER NOT NULL,
 activity_id INTEGER NOT NULL,
 cancelled_on TEXT NOT NULL CHECK(length(cancelled_on)=10 AND substr(cancelled_on,5,1)='-' AND substr(cancelled_on,8,1)='-'
  AND ltrim(substr(cancelled_on,1,4)||substr(cancelled_on,6,2)||substr(cancelled_on,9,2),'0123456789')=''
  AND substr(cancelled_on,6,2) BETWEEN '01' AND '12' AND substr(cancelled_on,9,2) BETWEEN '01' AND '31'),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,activity_id),
 FOREIGN KEY(org_id,activity_id) REFERENCES yojitsu_activity_records(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS yojitsu_activity_cancellations_recorder_only BEFORE INSERT ON yojitsu_activity_cancellations
 WHEN EXISTS(SELECT 1 FROM yojitsu_activity_records a WHERE a.org_id=NEW.org_id AND a.id=NEW.activity_id AND a.created_by<>NEW.created_by)
 BEGIN SELECT RAISE(ABORT,'only the recorder can cancel an activity record'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_activity_cancellations_no_update BEFORE UPDATE ON yojitsu_activity_cancellations BEGIN SELECT RAISE(ABORT,'activity cancellation is append-only'); END;
CREATE TRIGGER IF NOT EXISTS yojitsu_activity_cancellations_no_delete BEFORE DELETE ON yojitsu_activity_cancellations BEGIN SELECT RAISE(ABORT,'activity cancellation is append-only'); END;
