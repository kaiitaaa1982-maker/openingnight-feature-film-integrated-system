-- 指標マスタ（行動指標の計画 段B #9。要件 docs/requirements/revenue/kpi-scenario-forecast.md の FR-REV-KPI-017・019）。
-- 足すだけの移行: 指標マスタの版（ヘッダ）と、その段の行（役×稼ぎ方×段の対応と、対応の出どころの状態）の2表を作り、
-- 設定の変数の参照表（移行 0014 の yojitsu_variables）に、行動指標で使う変数の行を足す。どの版も追記だけで、変更・削除は DB が断る。
-- 指標マスタが持つのは、役（プロデューサー・営業の仕入れ・営業の売り）×稼ぎ方×段（行動のステップの参照表 action_steps のコード）の並びと、
-- その対応の状態（確認済み・監督申告・報道値・仮置き。K-9）だけ。段の率・1件の時間・1件の額・通る確率・通過率を測る期間などの値は
-- 設定の行（移行 0014 の yojitsu_setting_versions。変数×範囲×step）だけに持ち、ここに写さない（二重に持たない。FR-REV-KPI-019・K2-5）。
-- 版は組織ごとの連番で、最新の version_no の版が有効（目標の版と同じ読み方。K-8）。版は全部の役×稼ぎ方の段を持ち、改めるときは全部の段を持つ版を足す。
-- 段の行が step_count に満たない版（アプリを通さない書き込みで欠けた版）は有効にしない（src/revenue/metrics/metric-master-model.mjs）。
-- 細目の段（企画メモ・条件書など。ontology の「行動の段」）は action_steps に種で足す行で（移行 0012 の決まり）、この移行では入れない。
-- 設定の行の値（初期値）も移行で入れず、種で足す（J-13。申し送り §仮置きの値の表のまま状態「仮置き」。test/fixtures/kpi-metrics/seed.json）。
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす。core の runbooks/07-cd.md 3-5）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作り、後ろの決まりの WHEN に「前の決まりに当たらない」を足す（0012・0014 と同じ）。
-- 手元の SQLite（src/db.mjs の LocalDatabase）は、変数の参照表の行の INSERT を含むので、指標マスタの版の表がまだ無い DB にだけ1回当てる（0016 のあと）。

-- 設定の変数（移行 0014 の参照表）に足す行。申し送り §DB の「#11 の設定に足す行」と FR-REV-KPI-019 の一覧で、0014 にある4つ
-- （1件あたりの額 unit_amount・次の段へ進む率 conversion_rate・着地に数える確度・窓口の支払いの間 payment_lag）は足さない。
-- 1件の時間（step_hours）だけがステップごとに持つ変数（範囲は稼ぎ方×ステップ。率と同じく、その段の1件の時間）。
-- 通過率を測る期間と最小件数（rate_window・rate_min_count）は、指標マスタの「期間」（過去 N か月。K2-7）を設定の行に持つための変数
INSERT INTO yojitsu_variables(code,label,value_kind,per_step,sort_order) VALUES
 ('sales_multiplier','窓口の売上の倍率','bps',0,5),
 ('recovery_amount','回収の量','bps',0,6),
 ('months_to_contract','契約までの月数','months',0,7),
 ('months_to_window','窓口に出るまでの月数','months',0,8),
 ('payment_delay','入金の遅れ','months',0,9),
 ('cost_overrun','受託の実費の超過','bps',0,10),
 ('deal_mg','1件の MG','yen',0,11),
 ('prep_cost','1件の商品化の費用','yen',0,12),
 ('videogram_cost','1件のビデオグラムの製造費','yen',0,13),
 ('labor_share','制作費のうち人へ渡る割合','bps',0,14),
 ('pass_rate','段階・交渉が通る確率','bps',0,15),
 ('work_hours','月の業務時間','x100',0,16),
 ('step_hours','1件の時間','x100',1,17),
 ('delivery_hours','成約後の実行の月の時間','x100',0,18),
 ('delivery_months','成約後の実行の月数','months',0,19),
 ('channel_share','窓口の比率','bps',0,20),
 ('rate_window','通過率を測る期間','months',0,21),
 ('rate_min_count','通過率の最小件数','x100',0,22);

-- 指標マスタの版（ヘッダ。FR-REV-KPI-019）。組織ごとの連番で、最新の version_no が有効。step_count は段の行の数で、段の行は版と同じ batch で足す
-- （そろった版にはそれ以上足せない）。basis は版を足した理由の文、created_on は作った日（業務の日付）
CREATE TABLE IF NOT EXISTS kpi_metric_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES organizations(id),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 step_count INTEGER NOT NULL CHECK(typeof(step_count)='integer' AND step_count BETWEEN 1 AND 200),
 basis TEXT CHECK(basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
 created_on TEXT NOT NULL CHECK(length(created_on)=10 AND substr(created_on,5,1)='-' AND substr(created_on,8,1)='-'
  AND ltrim(substr(created_on,1,4)||substr(created_on,6,2)||substr(created_on,9,2),'0123456789')=''
  AND substr(created_on,6,2) BETWEEN '01' AND '12' AND substr(created_on,9,2) BETWEEN '01' AND '31'),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS kpi_metric_versions_sequence BEFORE INSERT ON kpi_metric_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM kpi_metric_versions v WHERE v.org_id=NEW.org_id)
 BEGIN SELECT RAISE(ABORT,'stale kpi metric version'); END;
CREATE TRIGGER IF NOT EXISTS kpi_metric_versions_no_update BEFORE UPDATE ON kpi_metric_versions BEGIN SELECT RAISE(ABORT,'kpi metric version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kpi_metric_versions_no_delete BEFORE DELETE ON kpi_metric_versions BEGIN SELECT RAISE(ABORT,'kpi metric version is append-only'); END;

-- 指標マスタの段（版の子の行。FR-REV-KPI-017・019）。役×稼ぎ方ごとに、段を seq の順（1 からの連番）に並べる。
-- 役: producer プロデューサー・sales_sourcing 営業（仕入れ）・sales_selling 営業（売り）（ontology の「行動の段」の役の列。D-039 の2つの役を、
-- 営業は相手〈権利元・取引先〉で2つに分けて持つ）。段は行動のステップの参照表のコード（細目は親の step へ畳んで数える）。
-- 稼ぎ方×段は版の中で1回だけ（設定の行の率・1件の時間は稼ぎ方×step で引くので、同じ稼ぎ方×段を2つの役に置かない）。
-- status は対応の出どころの状態（K-9。最初の版は申し送りの仮置きのまま「仮置き」。J-13）、basis は出どころの文
CREATE TABLE IF NOT EXISTS kpi_metric_steps (
 org_id INTEGER NOT NULL,
 metric_version_id INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('producer','sales_sourcing','sales_selling')),
 earning_type TEXT NOT NULL REFERENCES earning_types(code),
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq BETWEEN 1 AND 20),
 step TEXT NOT NULL REFERENCES action_steps(code),
 status TEXT NOT NULL CHECK(status IN ('confirmed','director_reported','press_reported','provisional')),
 basis TEXT CHECK(basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
 PRIMARY KEY(org_id,metric_version_id,role,earning_type,seq),
 UNIQUE(org_id,metric_version_id,earning_type,step),
 FOREIGN KEY(org_id,metric_version_id) REFERENCES kpi_metric_versions(org_id,id)
);
-- 決まりの順: 版の数 → 段の順。版が無い（別の組織の版を含む）ときは数の決まりに当てず、外部キーで断る
CREATE TRIGGER IF NOT EXISTS kpi_metric_steps_count BEFORE INSERT ON kpi_metric_steps
 WHEN (SELECT COUNT(*) FROM kpi_metric_steps s WHERE s.org_id=NEW.org_id AND s.metric_version_id=NEW.metric_version_id)
  >=(SELECT v.step_count FROM kpi_metric_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.metric_version_id)
 BEGIN SELECT RAISE(ABORT,'kpi metric step beyond the count'); END;
-- 段は役×稼ぎ方の中の最後の seq の次だけ（1 から順に足す。番号を飛ばした行や、欠けた番号を後から埋める行を断る）
CREATE TRIGGER IF NOT EXISTS kpi_metric_steps_in_order BEFORE INSERT ON kpi_metric_steps
 WHEN NOT ((SELECT COUNT(*) FROM kpi_metric_steps s WHERE s.org_id=NEW.org_id AND s.metric_version_id=NEW.metric_version_id)
   >=(SELECT v.step_count FROM kpi_metric_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.metric_version_id))
  AND NEW.seq<>(SELECT COALESCE(MAX(s.seq),0)+1 FROM kpi_metric_steps s WHERE s.org_id=NEW.org_id AND s.metric_version_id=NEW.metric_version_id
   AND s.role=NEW.role AND s.earning_type=NEW.earning_type)
 BEGIN SELECT RAISE(ABORT,'kpi metric step out of order'); END;
CREATE TRIGGER IF NOT EXISTS kpi_metric_steps_no_update BEFORE UPDATE ON kpi_metric_steps BEGIN SELECT RAISE(ABORT,'kpi metric version is append-only'); END;
CREATE TRIGGER IF NOT EXISTS kpi_metric_steps_no_delete BEFORE DELETE ON kpi_metric_steps BEGIN SELECT RAISE(ABORT,'kpi metric version is append-only'); END;
