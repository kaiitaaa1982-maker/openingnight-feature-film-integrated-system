-- 営業基幹・全作品のウィンドウ・取引先別リスト・売上集計シート（2026-09-25）の追加表。src/ の sales-ops/release-windows.sql・sales-ops/partner-lists.sql・sales-sheet/sales-sheet.sql・sales-ops/distribution-additions.sql をこの順で連結したもの。
-- scripts/build-ux-migration.mjs で作る（手で直さない）。0003 の後に当てる。既存の本番D1へ自動では適用しない。

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

-- 取引先別の配信・販売リスト（営業基幹）。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §3。
-- 取引先ごとのリスト（見出し）→ 明細の系列 → 明細の版 の3段。再契約は新しい明細で、前の明細を renews_entry_id で指す。
-- 追加の列は「列の定義」（型・適用範囲は変えない）・「列の状態」（表示名・使う／やめる・並び・選択肢を版で）・「値」（明細の版ごと）で増やす。
-- すべて追加だけ・変更と削除はトリガーで禁止（取込の確認表 partner_list_import_previews の consumed だけは更新する）。
-- 取込は 1つの文で複数行を入れる（INSERT … SELECT … FROM json_each(確認の表)）。行数によらず文の数は一定。

-- リストの種類（選択肢の制限ではなく表。行を足せば種類が増える）
CREATE TABLE IF NOT EXISTS partner_list_kinds (
  code TEXT PRIMARY KEY CHECK(length(code) BETWEEN 1 AND 40 AND substr(code,1,1) GLOB '[a-z]' AND code NOT GLOB '*[^a-z0-9_]*'),
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 40),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 100000)
);
INSERT OR IGNORE INTO partner_list_kinds(code,label,sort_order) VALUES ('distribution','配信リスト',10),('sales','販売リスト',20);

-- リストの見出し（取引先ごと。1社に複数のサービスがあれば名前・サービス名で分ける）。取引先・種類・名前は変えない
CREATE TABLE IF NOT EXISTS partner_lists (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id), partner_id INTEGER NOT NULL,
  list_kind TEXT NOT NULL REFERENCES partner_list_kinds(code),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  service_name TEXT CHECK(service_name IS NULL OR length(trim(service_name)) BETWEEN 1 AND 200),
  contract_reference TEXT CHECK(contract_reference IS NULL OR length(trim(contract_reference)) BETWEEN 1 AND 1000),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,partner_id,list_kind,name),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- Excel 取込の記録（1回の登録＝1行）。同じリストへ同じ内容のファイルを2回入れない（content_hash）
CREATE TABLE IF NOT EXISTS partner_list_import_batches (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, list_id INTEGER NOT NULL,
  file_name TEXT CHECK(file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  template_version TEXT NOT NULL CHECK(length(template_version) BETWEEN 1 AND 40),
  mode TEXT NOT NULL CHECK(mode IN ('partial','full')),
  appended INTEGER NOT NULL CHECK(appended>=0), revised INTEGER NOT NULL CHECK(revised>=0),
  withdrawn INTEGER NOT NULL CHECK(withdrawn>=0), unchanged INTEGER NOT NULL CHECK(unchanged>=0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,list_id,content_hash),
  FOREIGN KEY(org_id,list_id) REFERENCES partner_lists(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 明細の系列（取引先×作品の1つの契約）。作品は変えない。再契約は新しい系列を作り、前の系列を renews_entry_id で指す
CREATE TABLE IF NOT EXISTS partner_list_entries (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, list_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  renews_entry_id INTEGER, created_batch_id INTEGER, created_source_row INTEGER CHECK(created_source_row IS NULL OR created_source_row>0),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,list_id,id), UNIQUE(org_id,work_id,id),
  FOREIGN KEY(org_id,list_id) REFERENCES partner_lists(org_id,id),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
  FOREIGN KEY(org_id,renews_entry_id) REFERENCES partner_list_entries(org_id,id),
  FOREIGN KEY(org_id,created_batch_id) REFERENCES partner_list_import_batches(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((created_batch_id IS NULL) = (created_source_row IS NULL))
);

-- 明細の版（修正＝次の版、取り下げ＝status='withdrawn' の版）。流通ID（流通マスタ）から販売種別・取引方法を引く
CREATE TABLE IF NOT EXISTS partner_list_entry_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, list_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  distribution_code TEXT NOT NULL REFERENCES distribution_types(code),
  partner_category TEXT CHECK(partner_category IS NULL OR length(trim(partner_category)) BETWEEN 1 AND 200),
  territory TEXT NOT NULL DEFAULT '日本' CHECK(length(trim(territory)) BETWEEN 1 AND 100),
  product_id INTEGER,
  partner_work_code TEXT CHECK(partner_work_code IS NULL OR length(trim(partner_work_code)) BETWEEN 1 AND 200),
  contract_start TEXT CHECK(contract_start IS NULL OR contract_start GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  contract_end TEXT CHECK(contract_end IS NULL OR contract_end GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  end_rule TEXT NOT NULL CHECK(end_rule IN ('date','auto_renew','perpetual','unknown')),
  announce_on TEXT CHECK(announce_on IS NULL OR announce_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  exclusivity TEXT NOT NULL CHECK(exclusivity IN ('unknown','exclusive','nonexclusive')),
  status TEXT NOT NULL CHECK(status IN ('planned','contracted','withdrawn')),
  settlement_method TEXT NOT NULL DEFAULT 'unverified' CHECK(settlement_method IN ('unverified','FLAT','MG','RS','other')),
  amount_ex_tax INTEGER CHECK(amount_ex_tax IS NULL OR amount_ex_tax>=0),
  rate_bps INTEGER CHECK(rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  billing_partner_id INTEGER,
  agreement_id INTEGER,
  source_reference TEXT CHECK(source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 1000),
  note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  import_batch_id INTEGER, source_row INTEGER CHECK(source_row IS NULL OR source_row>0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,entry_id,version_no),
  CHECK(contract_end IS NULL OR contract_start IS NULL OR contract_end>=contract_start),
  CHECK(end_rule<>'date' OR contract_end IS NOT NULL),
  CHECK(status<>'contracted' OR contract_start IS NOT NULL),
  FOREIGN KEY(org_id,list_id,entry_id) REFERENCES partner_list_entries(org_id,list_id,id),
  FOREIGN KEY(org_id,work_id,entry_id) REFERENCES partner_list_entries(org_id,work_id,id),
  FOREIGN KEY(org_id,product_id,work_id) REFERENCES product_works(org_id,product_id,work_id),
  FOREIGN KEY(org_id,billing_partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,agreement_id,work_id) REFERENCES sales_agreements(org_id,id,work_id),
  FOREIGN KEY(org_id,import_batch_id) REFERENCES partner_list_import_batches(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 追加の列の定義。field_key・型・適用範囲（リストの種類・取引先。空欄は共通）は変えない
CREATE TABLE IF NOT EXISTS partner_list_field_definitions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id),
  field_key TEXT NOT NULL CHECK(length(field_key) BETWEEN 1 AND 40 AND substr(field_key,1,1) GLOB '[a-z]' AND field_key NOT GLOB '*[^a-z0-9_]*'),
  value_type TEXT NOT NULL CHECK(value_type IN ('text','integer','yen','date','month','choice')),
  list_kind TEXT REFERENCES partner_list_kinds(code),
  partner_id INTEGER,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,field_key),
  FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 追加の列の状態（版）。表示名・使う／やめる・並び順・選択肢（choice のとき。JSON の文字の配列）
CREATE TABLE IF NOT EXISTS partner_list_field_states (
  org_id INTEGER NOT NULL, definition_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 40),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 100000),
  options_json TEXT CHECK(options_json IS NULL OR length(options_json) BETWEEN 2 AND 4000),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,definition_id,version_no),
  FOREIGN KEY(org_id,definition_id) REFERENCES partner_list_field_definitions(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 追加の列の値（明細の版ごと。文字か数値のどちらか一方）。変わっていない値も次の版へ写す
CREATE TABLE IF NOT EXISTS partner_list_field_values (
  org_id INTEGER NOT NULL, entry_version_id INTEGER NOT NULL, definition_id INTEGER NOT NULL,
  value_text TEXT CHECK(value_text IS NULL OR length(value_text) BETWEEN 1 AND 500),
  value_number INTEGER,
  PRIMARY KEY(org_id,entry_version_id,definition_id),
  FOREIGN KEY(org_id,entry_version_id) REFERENCES partner_list_entry_versions(org_id,id),
  FOREIGN KEY(org_id,definition_id) REFERENCES partner_list_field_definitions(org_id,id),
  CHECK((value_text IS NULL) <> (value_number IS NULL))
);

-- Excel 取込の確認（30分・確認した本人だけ・1回限り）。payload_json は登録する版の一覧（短いキーの JSON）
CREATE TABLE IF NOT EXISTS partner_list_import_previews (
  token TEXT PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, list_id INTEGER NOT NULL,
  file_name TEXT CHECK(file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  template_version TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('partial','full')),
  payload_json TEXT NOT NULL, unchanged INTEGER NOT NULL DEFAULT 0 CHECK(unchanged>=0), expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,list_id) REFERENCES partner_lists(org_id,id)
);

CREATE INDEX IF NOT EXISTS partner_lists_partner_idx ON partner_lists(org_id,partner_id);
CREATE INDEX IF NOT EXISTS partner_list_entries_list_idx ON partner_list_entries(org_id,list_id);
CREATE UNIQUE INDEX IF NOT EXISTS partner_list_entries_batch_row ON partner_list_entries(org_id,created_batch_id,created_source_row) WHERE created_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS partner_list_entry_versions_work_idx ON partner_list_entry_versions(org_id,work_id,distribution_code);
CREATE UNIQUE INDEX IF NOT EXISTS partner_list_entry_versions_batch_entry ON partner_list_entry_versions(org_id,import_batch_id,entry_id) WHERE import_batch_id IS NOT NULL;

-- 変更・削除の禁止
CREATE TRIGGER IF NOT EXISTS partner_list_kinds_no_update BEFORE UPDATE ON partner_list_kinds BEGIN SELECT RAISE(ABORT,'partner list kind immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_kinds_no_delete BEFORE DELETE ON partner_list_kinds BEGIN SELECT RAISE(ABORT,'partner list kind immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_lists_no_update BEFORE UPDATE ON partner_lists BEGIN SELECT RAISE(ABORT,'partner list immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_lists_no_delete BEFORE DELETE ON partner_lists BEGIN SELECT RAISE(ABORT,'partner list immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_import_batches_no_update BEFORE UPDATE ON partner_list_import_batches BEGIN SELECT RAISE(ABORT,'partner list batch immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_import_batches_no_delete BEFORE DELETE ON partner_list_import_batches BEGIN SELECT RAISE(ABORT,'partner list batch immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_entries_no_update BEFORE UPDATE ON partner_list_entries BEGIN SELECT RAISE(ABORT,'partner list entry immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_entries_no_delete BEFORE DELETE ON partner_list_entries BEGIN SELECT RAISE(ABORT,'partner list entry immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_entry_versions_no_update BEFORE UPDATE ON partner_list_entry_versions BEGIN SELECT RAISE(ABORT,'partner list entry version immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_entry_versions_no_delete BEFORE DELETE ON partner_list_entry_versions BEGIN SELECT RAISE(ABORT,'partner list entry version immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_definitions_no_update BEFORE UPDATE ON partner_list_field_definitions BEGIN SELECT RAISE(ABORT,'partner list field immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_definitions_no_delete BEFORE DELETE ON partner_list_field_definitions BEGIN SELECT RAISE(ABORT,'partner list field immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_states_no_update BEFORE UPDATE ON partner_list_field_states BEGIN SELECT RAISE(ABORT,'partner list field state immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_states_no_delete BEFORE DELETE ON partner_list_field_states BEGIN SELECT RAISE(ABORT,'partner list field state immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_values_no_update BEFORE UPDATE ON partner_list_field_values BEGIN SELECT RAISE(ABORT,'partner list field value immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_values_no_delete BEFORE DELETE ON partner_list_field_values BEGIN SELECT RAISE(ABORT,'partner list field value immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_import_previews_no_delete BEFORE DELETE ON partner_list_import_previews BEGIN SELECT RAISE(ABORT,'partner list preview immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_list_import_previews_consume_only BEFORE UPDATE ON partner_list_import_previews
WHEN NOT (OLD.consumed=0 AND NEW.consumed=1 AND NEW.token=OLD.token AND NEW.org_id=OLD.org_id AND NEW.user_id=OLD.user_id AND NEW.list_id=OLD.list_id
  AND NEW.content_hash=OLD.content_hash AND NEW.payload_json=OLD.payload_json AND NEW.unchanged=OLD.unchanged AND NEW.expires_at=OLD.expires_at) BEGIN
  SELECT RAISE(ABORT,'partner list preview can only be consumed once');
END;

-- 版は1から順に積む（前の版の次の番号だけ）。流通IDは流通マスタ（H001〜 など）のもので、旧区分（svod など）では登録しない
CREATE TRIGGER IF NOT EXISTS partner_list_entry_versions_sequence BEFORE INSERT ON partner_list_entry_versions BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM partner_list_entry_versions WHERE org_id=NEW.org_id AND entry_id=NEW.entry_id),0)+1
    THEN RAISE(ABORT,'stale partner list entry version') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM distribution_master m WHERE m.code=NEW.distribution_code)
    THEN RAISE(ABORT,'partner list distribution code must be in distribution_master') END;
END;
CREATE TRIGGER IF NOT EXISTS partner_list_field_states_sequence BEFORE INSERT ON partner_list_field_states BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM partner_list_field_states WHERE org_id=NEW.org_id AND definition_id=NEW.definition_id),0)+1
    THEN RAISE(ABORT,'stale partner list field state') END;
END;

-- 再契約の元は、同じリスト・同じ作品の明細だけ
CREATE TRIGGER IF NOT EXISTS partner_list_entries_renewal_scope BEFORE INSERT ON partner_list_entries WHEN NEW.renews_entry_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM partner_list_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.renews_entry_id AND e.list_id=NEW.list_id AND e.work_id=NEW.work_id)
    THEN RAISE(ABORT,'partner list renewal scope mismatch') END;
END;

-- 追加の列の値は、その明細のリストに当てはまる定義だけ・型どおり（整数・金額は整数、日付・年月は形、文字・選択肢は文字）
CREATE TRIGGER IF NOT EXISTS partner_list_field_values_type_check BEFORE INSERT ON partner_list_field_values BEGIN
  SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM partner_list_entry_versions v
      JOIN partner_lists l ON l.org_id=v.org_id AND l.id=v.list_id
      JOIN partner_list_field_definitions d ON d.org_id=v.org_id AND d.id=NEW.definition_id
      WHERE v.org_id=NEW.org_id AND v.id=NEW.entry_version_id
        AND (d.list_kind IS NULL OR d.list_kind=l.list_kind) AND (d.partner_id IS NULL OR d.partner_id=l.partner_id)
        AND ((d.value_type IN ('integer','yen') AND NEW.value_number IS NOT NULL AND NEW.value_number=CAST(NEW.value_number AS INTEGER))
          OR (d.value_type='date' AND NEW.value_text GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
          OR (d.value_type='month' AND NEW.value_text GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]')
          OR (d.value_type IN ('text','choice') AND NEW.value_text IS NOT NULL)))
    THEN RAISE(ABORT,'partner list field type mismatch') END;
END;

-- 売上集計シート（83列・売上基幹 › 計上 › 帳票）。設計: docs/platform/team-development/eigyo-sales-sheet-design.md §4。
-- 列カタログ（列の定義の版）・型で守る2表（外貨・ロイヤリティ計上の基準）・拡張属性（1売上×1列×版）・シート定義（保存した形）。
-- 列の値の取り方は src/sales-sheet/column-registry.mjs の許可リストのキー（source_ref）で持つ。SQL の文字列は保存しない。
-- 83列の初期の定義は移行では入れない（管理者が「採用」すると組織の列の版1になる。全作品のウィンドウの種別と同じ）。
-- すべて追加だけ・変更と削除はトリガーで禁止。版は1から順に積む（前の版の次の番号だけ）。

-- 列カタログ（組織×列キー×版）。value_type・source_kind・source_ref・legacy_position は版をまたいで変えない
CREATE TABLE IF NOT EXISTS sales_sheet_column_versions (
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  column_key TEXT NOT NULL CHECK(length(column_key) BETWEEN 1 AND 48 AND substr(column_key,1,1) GLOB '[a-z]' AND column_key NOT GLOB '*[^a-z0-9_]*'),
  version_no INTEGER NOT NULL CHECK(version_no>0),
  label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 60),
  legacy_position INTEGER CHECK(legacy_position IS NULL OR legacy_position BETWEEN 1 AND 83),
  group_key TEXT NOT NULL CHECK(group_key IN ('identity','dates','quantity','unit_price','rate','partner_gross','holder_sales','currency','booking','mg_balance','theatre','note','audit','reference','helper','custom')),
  value_type TEXT NOT NULL CHECK(value_type IN ('yen','integer','decimal','rate_pct','date','month','text','bool')),
  aggregation TEXT NOT NULL CHECK(aggregation IN ('sum','period_end','ratio','min_max','distinct')),
  numerator_key TEXT, denominator_key TEXT,
  ratio_scale INTEGER CHECK(ratio_scale IS NULL OR ratio_scale IN (1,100)),
  digits INTEGER CHECK(digits IS NULL OR digits BETWEEN 0 AND 6),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('core','derived','attribute')),
  source_ref TEXT CHECK(source_ref IS NULL OR (length(source_ref) BETWEEN 1 AND 60 AND source_ref NOT GLOB '*[^a-z0-9_.]*')),
  formula_json TEXT CHECK(formula_json IS NULL OR (length(formula_json) BETWEEN 2 AND 2000 AND json_valid(formula_json))),
  description TEXT CHECK(description IS NULL OR length(trim(description)) BETWEEN 1 AND 500),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 100000),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,column_key,version_no),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((aggregation='ratio') = (numerator_key IS NOT NULL AND denominator_key IS NOT NULL AND ratio_scale IS NOT NULL)),
  CHECK(aggregation<>'ratio' OR value_type IN ('decimal','rate_pct','yen','integer')),
  CHECK(aggregation NOT IN ('sum','period_end') OR value_type IN ('yen','integer','decimal')),
  CHECK(aggregation<>'min_max' OR value_type IN ('date','month','text','integer')),
  CHECK(source_kind<>'core' OR (source_ref IS NOT NULL AND formula_json IS NULL)),
  CHECK(source_kind<>'derived' OR (source_ref IS NULL) <> (formula_json IS NULL)),
  CHECK(source_kind<>'attribute' OR (source_ref IS NULL AND formula_json IS NULL))
);

-- 拡張属性（1売上×1列×版）。列カタログで source_kind='attribute' の列だけ。値は型ごとに文字か数のどちらか（両方空は「値を消した版」）
CREATE TABLE IF NOT EXISTS sale_attribute_values (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, column_key TEXT NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  value_text TEXT CHECK(value_text IS NULL OR length(value_text) BETWEEN 1 AND 500),
  value_number CHECK(value_number IS NULL OR typeof(value_number) IN ('integer','real')),
  origin TEXT NOT NULL CHECK(origin IN ('manual','report_import')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,sale_id,column_key,version_no),
  CHECK(value_text IS NULL OR value_number IS NULL),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 外貨（売上1件ごとに版）。額は ×100（小数2桁）、為替レートは ×10000（小数4桁・1外貨あたりの円）で持つ。
-- 円の計上額（sale_lines.amount_ex_tax）は「外貨の計上額×レート」と1円まで一致させる（トリガー）。円の行は JPY・レート1
CREATE TABLE IF NOT EXISTS sale_currency_versions (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  currency_code TEXT NOT NULL CHECK(length(currency_code)=3 AND currency_code NOT GLOB '*[^A-Z]*'),
  original_amount_x100 INTEGER CHECK(original_amount_x100 IS NULL OR typeof(original_amount_x100)='integer'),
  original_royalty_x100 INTEGER CHECK(original_royalty_x100 IS NULL OR typeof(original_royalty_x100)='integer'),
  exchange_rate_x10000 INTEGER NOT NULL CHECK(typeof(exchange_rate_x10000)='integer' AND exchange_rate_x10000>0),
  rate_date TEXT NOT NULL CHECK(rate_date GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  basis TEXT NOT NULL CHECK(length(trim(basis)) BETWEEN 1 AND 500),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,sale_id,version_no),
  CHECK(currency_code<>'JPY' OR exchange_rate_x10000=10000),
  CHECK(currency_code='JPY' OR original_amount_x100 IS NOT NULL),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- ロイヤリティ計上の基準（売上1件ごとに版）。記録の無い売上は 計上月・計上額（税抜・税込）と同じとみなす（シートの許可リスト側）
CREATE TABLE IF NOT EXISTS sale_royalty_basis_versions (
  org_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  royalty_month TEXT NOT NULL CHECK(royalty_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND CAST(substr(royalty_month,6,2) AS INTEGER) BETWEEN 1 AND 12),
  royalty_amount_ex_tax INTEGER NOT NULL CHECK(typeof(royalty_amount_ex_tax)='integer'),
  royalty_tax_amount INTEGER NOT NULL CHECK(typeof(royalty_tax_amount)='integer'),
  royalty_amount_inc_tax INTEGER NOT NULL CHECK(typeof(royalty_amount_inc_tax)='integer'),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,sale_id,version_no),
  CHECK(royalty_amount_inc_tax=royalty_amount_ex_tax+royalty_tax_amount),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- シート定義（保存した形）の見出し。名前は組織の中で重ねない。名前を変えるときは新しく作る
CREATE TABLE IF NOT EXISTS sales_sheet_views (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,name),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- シート定義の版。列の並び・粒度（明細／集計）・切り口（最大3つ）・月の基準・税抜／税込・月を横に並べるか・空の列を隠すか・絞り込み
CREATE TABLE IF NOT EXISTS sales_sheet_view_versions (
  org_id INTEGER NOT NULL, view_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  column_keys_json TEXT NOT NULL CHECK(json_valid(column_keys_json) AND json_type(column_keys_json)='array' AND json_array_length(column_keys_json) BETWEEN 1 AND 200 AND length(column_keys_json)<=12000),
  grain TEXT NOT NULL CHECK(grain IN ('detail','aggregate')),
  dimensions_json TEXT NOT NULL CHECK(json_valid(dimensions_json) AND json_type(dimensions_json)='array' AND json_array_length(dimensions_json)<=3),
  month_basis TEXT NOT NULL CHECK(month_basis IN ('accounting','sales','royalty')),
  tax_basis TEXT NOT NULL CHECK(tax_basis IN ('ex','inc')),
  pivot_months INTEGER NOT NULL CHECK(pivot_months IN (0,1)),
  hide_empty INTEGER NOT NULL CHECK(hide_empty IN (0,1)),
  filters_json TEXT NOT NULL CHECK(json_valid(filters_json) AND json_type(filters_json)='object' AND length(filters_json)<=4000),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,view_id,version_no),
  CHECK(grain='aggregate' OR (json_array_length(dimensions_json)=0 AND pivot_months=0)),
  FOREIGN KEY(org_id,view_id) REFERENCES sales_sheet_views(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE INDEX IF NOT EXISTS sale_attribute_values_column_idx ON sale_attribute_values(org_id,column_key);

-- 変更・削除の禁止
CREATE TRIGGER IF NOT EXISTS sales_sheet_column_versions_no_update BEFORE UPDATE ON sales_sheet_column_versions BEGIN SELECT RAISE(ABORT,'sales sheet column immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_sheet_column_versions_no_delete BEFORE DELETE ON sales_sheet_column_versions BEGIN SELECT RAISE(ABORT,'sales sheet column immutable'); END;
CREATE TRIGGER IF NOT EXISTS sale_attribute_values_no_update BEFORE UPDATE ON sale_attribute_values BEGIN SELECT RAISE(ABORT,'sale attribute immutable'); END;
CREATE TRIGGER IF NOT EXISTS sale_attribute_values_no_delete BEFORE DELETE ON sale_attribute_values BEGIN SELECT RAISE(ABORT,'sale attribute immutable'); END;
CREATE TRIGGER IF NOT EXISTS sale_currency_versions_no_update BEFORE UPDATE ON sale_currency_versions BEGIN SELECT RAISE(ABORT,'sale currency immutable'); END;
CREATE TRIGGER IF NOT EXISTS sale_currency_versions_no_delete BEFORE DELETE ON sale_currency_versions BEGIN SELECT RAISE(ABORT,'sale currency immutable'); END;
CREATE TRIGGER IF NOT EXISTS sale_royalty_basis_versions_no_update BEFORE UPDATE ON sale_royalty_basis_versions BEGIN SELECT RAISE(ABORT,'sale royalty basis immutable'); END;
CREATE TRIGGER IF NOT EXISTS sale_royalty_basis_versions_no_delete BEFORE DELETE ON sale_royalty_basis_versions BEGIN SELECT RAISE(ABORT,'sale royalty basis immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_sheet_views_no_update BEFORE UPDATE ON sales_sheet_views BEGIN SELECT RAISE(ABORT,'sales sheet view immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_sheet_views_no_delete BEFORE DELETE ON sales_sheet_views BEGIN SELECT RAISE(ABORT,'sales sheet view immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_sheet_view_versions_no_update BEFORE UPDATE ON sales_sheet_view_versions BEGIN SELECT RAISE(ABORT,'sales sheet view version immutable'); END;
CREATE TRIGGER IF NOT EXISTS sales_sheet_view_versions_no_delete BEFORE DELETE ON sales_sheet_view_versions BEGIN SELECT RAISE(ABORT,'sales sheet view version immutable'); END;

-- 列カタログ: 版は順に積む。型・取り方の種類・許可リストのキー・元の列番号は変えない。元の列番号（1〜83）はほかの列と重ねない
CREATE TRIGGER IF NOT EXISTS sales_sheet_column_versions_sequence BEFORE INSERT ON sales_sheet_column_versions BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM sales_sheet_column_versions WHERE org_id=NEW.org_id AND column_key=NEW.column_key),0)+1
    THEN RAISE(ABORT,'stale sales sheet column version') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM sales_sheet_column_versions p WHERE p.org_id=NEW.org_id AND p.column_key=NEW.column_key AND p.version_no=NEW.version_no-1
      AND (p.value_type<>NEW.value_type OR p.source_kind<>NEW.source_kind OR COALESCE(p.source_ref,'')<>COALESCE(NEW.source_ref,'') OR COALESCE(p.legacy_position,0)<>COALESCE(NEW.legacy_position,0)))
    THEN RAISE(ABORT,'sales sheet column type is immutable') END;
  SELECT CASE WHEN NEW.legacy_position IS NOT NULL AND EXISTS(SELECT 1 FROM sales_sheet_column_versions x WHERE x.org_id=NEW.org_id AND x.legacy_position=NEW.legacy_position AND x.column_key<>NEW.column_key)
    THEN RAISE(ABORT,'sales sheet legacy position already used') END;
END;

-- 拡張属性: 版は順に積む。列は最新の版が attribute・使う列で、値は型どおり（金額・整数は整数、小数・率は数、真偽は0か1、日付・年月は形、文字は文字）
CREATE TRIGGER IF NOT EXISTS sale_attribute_values_check BEFORE INSERT ON sale_attribute_values BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM sale_attribute_values WHERE org_id=NEW.org_id AND sale_id=NEW.sale_id AND column_key=NEW.column_key),0)+1
    THEN RAISE(ABORT,'stale sale attribute version') END;
  SELECT CASE WHEN NOT EXISTS(
      SELECT 1 FROM sales_sheet_column_versions c
      WHERE c.org_id=NEW.org_id AND c.column_key=NEW.column_key
        AND c.version_no=(SELECT MAX(x.version_no) FROM sales_sheet_column_versions x WHERE x.org_id=c.org_id AND x.column_key=c.column_key)
        AND c.source_kind='attribute' AND c.active=1
        AND ((NEW.value_text IS NULL AND NEW.value_number IS NULL)
          OR (c.value_type IN ('yen','integer') AND typeof(NEW.value_number)='integer')
          OR (c.value_type IN ('decimal','rate_pct') AND typeof(NEW.value_number) IN ('integer','real'))
          OR (c.value_type='bool' AND typeof(NEW.value_number)='integer' AND NEW.value_number IN (0,1))
          OR (c.value_type='date' AND NEW.value_text GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]')
          OR (c.value_type='month' AND NEW.value_text GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]')
          OR (c.value_type='text' AND NEW.value_text IS NOT NULL)))
    THEN RAISE(ABORT,'sale attribute type mismatch') END;
END;

-- 外貨: 版は順に積む。円の計上額は 外貨の計上額×レート と1円まで一致させる（桁が大きいときは10億分の1まで許す）
CREATE TRIGGER IF NOT EXISTS sale_currency_versions_check BEFORE INSERT ON sale_currency_versions BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM sale_currency_versions WHERE org_id=NEW.org_id AND sale_id=NEW.sale_id),0)+1
    THEN RAISE(ABORT,'stale sale currency version') END;
  SELECT CASE WHEN NEW.currency_code<>'JPY' AND NOT EXISTS(
      SELECT 1 FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.id=NEW.sale_id
        AND ABS(ROUND(NEW.original_amount_x100 * (NEW.exchange_rate_x10000 / 1000000.0)) - s.amount_ex_tax) <= 1 + ABS(s.amount_ex_tax) / 1000000000.0)
    THEN RAISE(ABORT,'sale currency amount does not match the booked yen amount') END;
END;

-- ロイヤリティ計上の基準: 版は順に積む
CREATE TRIGGER IF NOT EXISTS sale_royalty_basis_versions_sequence BEFORE INSERT ON sale_royalty_basis_versions BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM sale_royalty_basis_versions WHERE org_id=NEW.org_id AND sale_id=NEW.sale_id),0)+1
    THEN RAISE(ABORT,'stale sale royalty basis version') END;
END;

-- シート定義: 版は順に積む
CREATE TRIGGER IF NOT EXISTS sales_sheet_view_versions_sequence BEFORE INSERT ON sales_sheet_view_versions BEGIN
  SELECT CASE WHEN NEW.version_no<>COALESCE((SELECT MAX(version_no) FROM sales_sheet_view_versions WHERE org_id=NEW.org_id AND view_id=NEW.view_id),0)+1
    THEN RAISE(ABORT,'stale sales sheet view version') END;
END;

-- 流通マスタに後から足した流通ID。元の流通マスタ（fixtures/distribution-master.csv、distribution-master.sql）は書き換えず、
-- 足した理由と日付を notes と source_sha256 に残す。source_row は元の CSV の行ではないので 0。
-- 2026-09-25 代表の判断: PVOD は TVOD とは別の流通IDとして持つ（配信・RS・PVOD）。
INSERT OR IGNORE INTO distribution_types(code,family,label,utilization,sort_order) VALUES('D007','unverified','D007',NULL,139);
INSERT OR IGNORE INTO distribution_master VALUES('D007','配信','RS','PVOD','2026-09-25 代表の判断で追加（元の流通マスタには無い）','added-2026-09-25',0);
INSERT INTO transaction_guards(value) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM distribution_master WHERE code='D007' AND distribution_name='配信' AND transaction_method='RS' AND sales_type='PVOD');
