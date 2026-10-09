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
