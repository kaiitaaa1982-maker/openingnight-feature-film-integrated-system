-- 全作品のウィンドウ（営業基幹の最初の画面）。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §2。
-- ウィンドウ種別（劇場公開・配給開始、PVOD先行、放送…）を行で持ち、種別を1行足すと画面の列と Excel の見出しが増える。
-- 作品ごとのウィンドウは 作品×種別×地域 の系列に版を積む。日付はこの表だけが持つ（流通別の販売条件・商品ごとのウィンドウへ写さない）。
-- すべて追加だけ・変更と削除はトリガーで禁止（取込の確認表 release_window_import_previews の consumed だけは更新する）。
-- 名前は委員会の「窓口」（committee_term_windows）と混ざらないよう release_window_* にする。

-- 種別（組織ごと）。type_key は英小文字・数字・_（拡張項目の field_key と同じ決まり）
CREATE TABLE IF NOT EXISTS release_window_types (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id),
  type_key TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,type_key),
  CHECK(length(type_key) BETWEEN 1 AND 40 AND substr(type_key,1,1) GLOB '[a-z]' AND type_key NOT GLOB '*[^a-z0-9_]*'),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 種別の版。表示名・分類・日付の形（point=公開日・発売日のような1日／period=解禁日〜期限）・見出しの材料・使う／やめる
CREATE TABLE IF NOT EXISTS release_window_type_versions (
  org_id INTEGER NOT NULL, type_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 40),
  group_label TEXT NOT NULL CHECK(length(trim(group_label)) BETWEEN 1 AND 40),
  family TEXT NOT NULL CHECK(family IN ('theatrical','digital','package','broadcast','overseas','other')),
  date_mode TEXT NOT NULL CHECK(date_mode IN ('point','period')),
  start_label TEXT NOT NULL CHECK(length(trim(start_label)) BETWEEN 1 AND 30),
  end_label TEXT,
  has_announce INTEGER NOT NULL CHECK(has_announce IN (0,1)),
  default_territory TEXT NOT NULL DEFAULT '日本' CHECK(length(trim(default_territory)) BETWEEN 1 AND 100),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 100000),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,type_id,version_no),
  FOREIGN KEY(org_id,type_id) REFERENCES release_window_types(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((date_mode='point' AND end_label IS NULL) OR (date_mode='period' AND end_label IS NOT NULL AND length(trim(end_label)) BETWEEN 1 AND 30))
);

-- 種別の版ごとの追加項目（販売予定価格（税抜）・視聴権利時間・独占種別など）。choice の選択肢はサーバーの許可リスト（choice_domain）
CREATE TABLE IF NOT EXISTS release_window_type_fields (
  org_id INTEGER NOT NULL, type_id INTEGER NOT NULL, version_no INTEGER NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 30),
  value_type TEXT NOT NULL CHECK(value_type IN ('date','integer','yen','text','choice')),
  choice_domain TEXT,
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 1000),
  PRIMARY KEY(org_id,type_id,version_no,field_key),
  FOREIGN KEY(org_id,type_id,version_no) REFERENCES release_window_type_versions(org_id,type_id,version_no),
  CHECK(length(field_key) BETWEEN 1 AND 40 AND substr(field_key,1,1) GLOB '[a-z]' AND field_key NOT GLOB '*[^a-z0-9_]*'),
  CHECK((value_type='choice' AND length(choice_domain) BETWEEN 1 AND 40) OR (value_type<>'choice' AND choice_domain IS NULL))
);

-- 種別と流通IDの対応（空欄可）。流通別の販売条件・売上との突合（期間外の警告）に使う
CREATE TABLE IF NOT EXISTS release_window_type_distributions (
  org_id INTEGER NOT NULL, type_id INTEGER NOT NULL, version_no INTEGER NOT NULL,
  distribution_code TEXT NOT NULL REFERENCES distribution_types(code),
  PRIMARY KEY(org_id,type_id,version_no,distribution_code),
  FOREIGN KEY(org_id,type_id,version_no) REFERENCES release_window_type_versions(org_id,type_id,version_no)
);

-- 作品ごとのウィンドウの系列（作品×種別×地域）
CREATE TABLE IF NOT EXISTS work_release_windows (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, type_id INTEGER NOT NULL,
  territory TEXT NOT NULL DEFAULT '日本' CHECK(length(trim(territory)) BETWEEN 1 AND 100),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,type_id,territory),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
  FOREIGN KEY(org_id,type_id) REFERENCES release_window_types(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- ウィンドウの版。仮の日付を作らない: date_precision は開始の日付の細かさ。
--   day=YYYY-MM-DD／month=YYYY-MM（日は未定）／year=YYYY／range=時期を原文（timing_raw）で持つ（start_on は空か最も早い月 YYYY-MM）／tbd=未定
--   終了・告知は日付・月・年のどれでもよい（空欄可）。前後の比べ方は短い方の桁にそろえる
CREATE TABLE IF NOT EXISTS work_release_window_versions (
  org_id INTEGER NOT NULL, window_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  type_version_no INTEGER NOT NULL CHECK(type_version_no>0),
  start_on TEXT, end_on TEXT, announce_on TEXT,
  date_precision TEXT NOT NULL CHECK(date_precision IN ('day','month','range','year','tbd')),
  timing_raw TEXT CHECK(timing_raw IS NULL OR length(trim(timing_raw)) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK(status IN ('draft','confirmed','withdrawn')),
  availability_version_id INTEGER,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','excel_import','from_availability')),
  source_reference TEXT CHECK(source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 1000),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  import_batch_id TEXT CHECK(import_batch_id IS NULL OR length(import_batch_id) BETWEEN 1 AND 80),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,window_id,version_no),
  FOREIGN KEY(org_id,window_id) REFERENCES work_release_windows(org_id,id),
  FOREIGN KEY(org_id,availability_version_id) REFERENCES sales_availability_versions(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((date_precision='day' AND start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
     OR (date_precision='month' AND start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]')
     OR (date_precision='year' AND start_on GLOB '[0-9][0-9][0-9][0-9]')
     OR (date_precision='range' AND timing_raw IS NOT NULL AND (start_on IS NULL OR start_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'))
     OR (date_precision='tbd' AND start_on IS NULL)),
  CHECK(end_on IS NULL OR end_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' OR end_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' OR end_on GLOB '[0-9][0-9][0-9][0-9]'),
  CHECK(announce_on IS NULL OR announce_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' OR announce_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' OR announce_on GLOB '[0-9][0-9][0-9][0-9]'),
  CHECK(end_on IS NULL OR start_on IS NULL OR substr(end_on,1,min(length(end_on),length(start_on)))>=substr(start_on,1,min(length(end_on),length(start_on)))),
  CHECK(status<>'confirmed' OR start_on IS NOT NULL)
);

-- 版ごとの追加項目の値（文字か数値のどちらか一方）。型は種別の版の項目とトリガーで照合する
CREATE TABLE IF NOT EXISTS work_release_window_field_values (
  org_id INTEGER NOT NULL, window_id INTEGER NOT NULL, version_no INTEGER NOT NULL,
  field_key TEXT NOT NULL,
  value_text TEXT CHECK(value_text IS NULL OR length(value_text) BETWEEN 1 AND 500),
  value_number INTEGER,
  PRIMARY KEY(org_id,window_id,version_no,field_key),
  FOREIGN KEY(org_id,window_id,version_no) REFERENCES work_release_window_versions(org_id,window_id,version_no),
  CHECK((value_text IS NULL) <> (value_number IS NULL))
);

-- Excel 取込の確認（30分・1回限り）。payload_json は登録する版の一覧（変更のある系列だけ）
CREATE TABLE IF NOT EXISTS release_window_import_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL, expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id)
);

CREATE INDEX IF NOT EXISTS work_release_windows_type_idx ON work_release_windows(org_id,type_id);

-- 変更・削除の禁止
CREATE TRIGGER IF NOT EXISTS release_window_types_no_update BEFORE UPDATE ON release_window_types BEGIN SELECT RAISE(ABORT,'release window type immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_types_no_delete BEFORE DELETE ON release_window_types BEGIN SELECT RAISE(ABORT,'release window type immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_type_versions_no_update BEFORE UPDATE ON release_window_type_versions BEGIN SELECT RAISE(ABORT,'release window type version immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_type_versions_no_delete BEFORE DELETE ON release_window_type_versions BEGIN SELECT RAISE(ABORT,'release window type version immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_type_fields_no_update BEFORE UPDATE ON release_window_type_fields BEGIN SELECT RAISE(ABORT,'release window type field immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_type_fields_no_delete BEFORE DELETE ON release_window_type_fields BEGIN SELECT RAISE(ABORT,'release window type field immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_type_distributions_no_update BEFORE UPDATE ON release_window_type_distributions BEGIN SELECT RAISE(ABORT,'release window type distribution immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_type_distributions_no_delete BEFORE DELETE ON release_window_type_distributions BEGIN SELECT RAISE(ABORT,'release window type distribution immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_release_windows_no_update BEFORE UPDATE ON work_release_windows BEGIN SELECT RAISE(ABORT,'release window immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_release_windows_no_delete BEFORE DELETE ON work_release_windows BEGIN SELECT RAISE(ABORT,'release window immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_release_window_versions_no_update BEFORE UPDATE ON work_release_window_versions BEGIN SELECT RAISE(ABORT,'release window version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_release_window_versions_no_delete BEFORE DELETE ON work_release_window_versions BEGIN SELECT RAISE(ABORT,'release window version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_release_window_field_values_no_update BEFORE UPDATE ON work_release_window_field_values BEGIN SELECT RAISE(ABORT,'release window field value immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_release_window_field_values_no_delete BEFORE DELETE ON work_release_window_field_values BEGIN SELECT RAISE(ABORT,'release window field value immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_import_previews_no_delete BEFORE DELETE ON release_window_import_previews BEGIN SELECT RAISE(ABORT,'release window preview immutable'); END;
CREATE TRIGGER IF NOT EXISTS release_window_import_previews_consume_only BEFORE UPDATE ON release_window_import_previews
WHEN NOT (OLD.consumed=0 AND NEW.consumed=1 AND NEW.token=OLD.token AND NEW.org_id=OLD.org_id AND NEW.user_id=OLD.user_id AND NEW.payload_json=OLD.payload_json AND NEW.expires_at=OLD.expires_at) BEGIN
  SELECT RAISE(ABORT,'release window preview can only be consumed once');
END;

-- 版は1から順に積む（前の版の次の番号だけ）
CREATE TRIGGER IF NOT EXISTS release_window_type_versions_sequence BEFORE INSERT ON release_window_type_versions BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM release_window_type_versions WHERE org_id=NEW.org_id AND type_id=NEW.type_id),0)+1
    THEN RAISE(ABORT,'stale release window type version') END;
END;
CREATE TRIGGER IF NOT EXISTS work_release_window_versions_sequence BEFORE INSERT ON work_release_window_versions BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM work_release_window_versions WHERE org_id=NEW.org_id AND window_id=NEW.window_id),0)+1
    THEN RAISE(ABORT,'stale release window version') END;
END;

-- ウィンドウの版は、その系列の種別の版（実在する版）で作る。販売条件の版を根拠にするときは同じ作品の販売条件に限る
CREATE TRIGGER IF NOT EXISTS work_release_window_versions_type_scope BEFORE INSERT ON work_release_window_versions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM release_window_type_versions tv JOIN work_release_windows w ON w.org_id=tv.org_id AND w.type_id=tv.type_id
      WHERE w.org_id=NEW.org_id AND w.id=NEW.window_id AND tv.version_no=NEW.type_version_no)
    THEN RAISE(ABORT,'release window type version mismatch') END;
  SELECT CASE WHEN NEW.availability_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sales_availability_versions a JOIN work_release_windows w ON w.org_id=a.org_id AND w.work_id=a.work_id
      WHERE w.org_id=NEW.org_id AND w.id=NEW.window_id AND a.id=NEW.availability_version_id)
    THEN RAISE(ABORT,'availability version scope mismatch') END;
END;

-- 追加項目の値は、その版の種別の版に定めた項目だけ・型どおり（日付は日・月・年のどれか、金額・整数は0以上、選択肢は文字）
CREATE TRIGGER IF NOT EXISTS work_release_window_field_values_type_check BEFORE INSERT ON work_release_window_field_values BEGIN
  SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM work_release_window_versions v
      JOIN work_release_windows w ON w.org_id=v.org_id AND w.id=v.window_id
      JOIN release_window_type_fields f ON f.org_id=w.org_id AND f.type_id=w.type_id AND f.version_no=v.type_version_no AND f.field_key=NEW.field_key
      WHERE v.org_id=NEW.org_id AND v.window_id=NEW.window_id AND v.version_no=NEW.version_no
        AND ((f.value_type IN ('integer','yen') AND NEW.value_number IS NOT NULL AND NEW.value_number>=0)
          OR (f.value_type='date' AND (NEW.value_text GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' OR NEW.value_text GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' OR NEW.value_text GLOB '[0-9][0-9][0-9][0-9]'))
          OR (f.value_type IN ('text','choice') AND NEW.value_text IS NOT NULL)))
    THEN RAISE(ABORT,'release window field type mismatch') END;
END;
