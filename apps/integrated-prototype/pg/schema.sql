-- 生成物。手で直さない。元は migrations/*.sql（SQLite・D1）で、scripts/pg-ddl.mjs が作る（FR-CORE-DATA-017）
-- 元の移行の指紋: sha256 3e686b1f53f04da7ff4df2c19033db622574d78d3c3430454d344abe53efb835
-- 表 258・索引 125・トリガー 540（共通の関数 362・PL/pgSQL の関数 178）・FK 628・IDENTITY 137
-- 手直し: royalty_statement_calculation_parts_valid — json_extract は SQLite では整数を返すが、PostgreSQL の補助関数は text を返す。COALESCE(…, 0) で型が合わないので、SQLite でも同じ値になる CAST を明示する
-- 索引の名前を縮めた（63 バイトの上限）: expense_withholding_category_versions_withholding_category_id_idx → expense_withholding_category_versions_withholding_cate_f60e46f4
-- 索引の名前を縮めた（63 バイトの上限）: expense_payment_settlements_counter_account_class_version_id_idx → expense_payment_settlements_counter_account_class_vers_d802c3a4
-- 索引の名前を縮めた（63 バイトの上限）: expense_withholding_remittances_cash_account_class_version_id_idx → expense_withholding_remittances_cash_account_class_ver_f5138063

SET check_function_bodies = on;

-- 無条件に拒むトリガー（更新・削除の禁止など）の共通の関数。文はトリガーの引数で渡す
CREATE FUNCTION lite_reject_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = TG_ARGV[0];
END
$fn$;

-- date(x, '+0 days')。YYYY-MM-DD（時刻つきも可）を読み、日があふれたら SQLite と同じく翌月へ送る。読めなければ NULL
-- make_date は 0000 年を受け付けない（SQLite は受け付ける）。グレゴリオ暦は400年で一周するので、400年ずらして計算して戻す
CREATE FUNCTION lite_date(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  y int; m int; d int; shifted date;
BEGIN
  IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?)?$' THEN RETURN NULL; END IF;
  y := substr(value, 1, 4)::int; m := substr(value, 6, 2)::int; d := substr(value, 9, 2)::int;
  IF m < 1 OR m > 12 OR d < 1 OR d > 31 THEN RETURN NULL; END IF;
  shifted := make_date(y + 400, m, 1) + (d - 1);
  RETURN lpad((extract(year FROM shifted)::int - 400)::text, 4, '0') || to_char(shifted, '-MM-DD');
END
$fn$;

-- typeof(x)。列の型で決まる（bigint は integer、numeric は小数部の桁があれば real）
CREATE FUNCTION lite_typeof(value bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN value IS NULL THEN 'null' ELSE 'integer' END $fn$;
CREATE FUNCTION lite_typeof(value numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN value IS NULL THEN 'null' WHEN scale(value) = 0 THEN 'integer' ELSE 'real' END $fn$;
CREATE FUNCTION lite_typeof(value double precision) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN value IS NULL THEN 'null' ELSE 'real' END $fn$;
CREATE FUNCTION lite_typeof(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN value IS NULL THEN 'null' ELSE 'text' END $fn$;

-- max(a, b)・min(a, b)（2つの値）。SQLite はどちらかが NULL なら NULL（PostgreSQL の greatest・least は NULL を飛ばす）
CREATE FUNCTION lite_max(a anycompatible, b anycompatible) RETURNS anycompatible LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL ELSE greatest(a, b) END $fn$;
CREATE FUNCTION lite_min(a anycompatible, b anycompatible) RETURNS anycompatible LANGUAGE sql IMMUTABLE AS $fn$ SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL ELSE least(a, b) END $fn$;

-- CAST(x AS INTEGER)。文字は先頭の整数だけを読み（読めなければ 0）、小数は 0 の方へ切り捨てる
CREATE FUNCTION lite_cast_int(value text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN value IS NULL THEN NULL ELSE COALESCE(substring(value FROM '^\s*([+-]?[0-9]{1,18})')::bigint, 0) END
$fn$;
CREATE FUNCTION lite_cast_int(value bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$ SELECT value $fn$;
CREATE FUNCTION lite_cast_int(value numeric) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$ SELECT trunc(value)::bigint $fn$;
CREATE FUNCTION lite_cast_int(value double precision) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$ SELECT trunc(value)::bigint $fn$;

-- json_valid(x)。JSON として読めるか（NULL は NULL）
CREATE FUNCTION lite_json_valid(value text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  PERFORM value::jsonb;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END
$fn$;

-- 読めない JSON は NULL（SQLite は誤りで止める。CHECK では json_valid と並べて使っているので結果は同じ「通さない」）。
-- jsonb でなく json で読む。json は文書のキーの順と元の文字を保つので、json_each のキーの順と、入れ子の値の文字が SQLite と同じになる
-- （アプリが JSON.stringify で作った空白の無い JSON のとき。SQLite は入れ子の値を空白を除いた文字で返す）
CREATE FUNCTION lite_json(value text) RETURNS json LANGUAGE plpgsql IMMUTABLE AS $fn$
BEGIN
  RETURN value::json;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;

-- '$.a.b'・'$[0]'・'$.a[1]' の形の道筋を text[] にする
CREATE FUNCTION lite_json_path(path text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN path = '$' THEN ARRAY[]::text[]
    ELSE string_to_array(regexp_replace(regexp_replace(substr(path, 2), '\[([0-9]+)\]', '.\1', 'g'), '^\.', ''), '.') END
$fn$;

-- SQLite の json_type の名前（integer・real・text・true・false・null・array・object）
CREATE FUNCTION lite_json_kind(value json) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE json_typeof(value)
    WHEN 'number' THEN CASE WHEN btrim(value::text) ~ '[.eE]' THEN 'real' ELSE 'integer' END
    WHEN 'string' THEN 'text'
    WHEN 'boolean' THEN btrim(value::text)
    ELSE json_typeof(value) END
$fn$;

CREATE FUNCTION lite_json_type(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT lite_json_kind(lite_json(value)) $fn$;

CREATE FUNCTION lite_json_array_length(value text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN lite_json(value) IS NULL THEN NULL WHEN json_typeof(lite_json(value)) = 'array' THEN json_array_length(lite_json(value)) ELSE 0 END
$fn$;

-- SQLite の値として返す（文字は引用符を外し、真偽は 1・0、小数は倍精度の値の文字（1.50 は 1.5）。配列・オブジェクトは JSON の文字。null は NULL）。
-- 返す型は text なので、数として比べる・足すときはアプリの SQL で CAST(… AS INTEGER) と書く（dialect.md）
CREATE FUNCTION lite_json_value(value json) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE json_typeof(value)
    WHEN 'string' THEN value #>> '{}'
    WHEN 'null' THEN NULL
    WHEN 'boolean' THEN CASE WHEN btrim(value::text) = 'true' THEN '1' ELSE '0' END
    WHEN 'number' THEN CASE WHEN btrim(value::text) ~ '[.eE]' THEN (btrim(value::text)::double precision)::text ELSE btrim(value::text) END
    ELSE btrim(value::text) END
$fn$;

CREATE FUNCTION lite_json_extract(value text, path text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT lite_json_value(lite_json(value) #> lite_json_path(path))
$fn$;

-- json_each(x, path)。配列は添字、オブジェクトはキーを key にし、文書の順に返す。文字・数などのスカラー（JSON の null を含む）は key が NULL の1行
-- （SQLite と同じ）。SQLite との違い: key はいつも text（SQLite は配列の添字を整数で返す。並べるときは ORDER BY CAST(key AS INTEGER)）
CREATE FUNCTION lite_json_each(value text, path text) RETURNS TABLE(key text, value text, type text) LANGUAGE sql IMMUTABLE AS $fn$
  WITH target AS (SELECT lite_json(value) #> lite_json_path(path) AS j)
  SELECT x.k, x.v, x.t FROM (
    SELECT e.ord, (e.ord - 1)::text AS k, lite_json_value(e.v) AS v, lite_json_kind(e.v) AS t
      FROM target, json_array_elements(target.j) WITH ORDINALITY AS e(v, ord) WHERE json_typeof(target.j) = 'array'
    UNION ALL
    SELECT o.ord, o.k, lite_json_value(o.v), lite_json_kind(o.v)
      FROM target, json_each(target.j) WITH ORDINALITY AS o(k, v, ord) WHERE json_typeof(target.j) = 'object'
    UNION ALL
    SELECT 1, NULL, lite_json_value(target.j), lite_json_kind(target.j)
      FROM target WHERE json_typeof(target.j) NOT IN ('array', 'object')
  ) x ORDER BY x.ord
$fn$;


-- ===== 0001_initial.sql =====
CREATE TABLE ai_usage (
  org_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  calls bigint NOT NULL DEFAULT 0 CHECK (calls >= 0)
);
CREATE TABLE audit_log (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  action text COLLATE "C" NOT NULL,
  entity_type text COLLATE "C" NOT NULL,
  entity_id text COLLATE "C" NOT NULL,
  version_hash text COLLATE "C",
  detail_json text COLLATE "C" NOT NULL,
  at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE billing_invoice_line_works (
  org_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  work_id bigint NOT NULL,
  allocation_bps bigint NOT NULL,
  PRIMARY KEY (org_id, invoice_id, sale_id, work_id),
  CHECK (allocation_bps BETWEEN 1 AND 10000)
);
CREATE TABLE billing_invoice_lines (
  org_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  report_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  product_id bigint,
  partner_id bigint NOT NULL,
  description text COLLATE "C" NOT NULL,
  accounting_month text COLLATE "C" NOT NULL,
  source_row bigint,
  amount_ex_tax bigint NOT NULL,
  tax_amount bigint NOT NULL,
  amount_inc_tax bigint NOT NULL,
  PRIMARY KEY (org_id, invoice_id, sale_id),
  UNIQUE (org_id, sale_id, invoice_id),
  CHECK (amount_inc_tax = amount_ex_tax + tax_amount)
);
CREATE TABLE billing_invoice_sequences (
  org_id bigint NOT NULL,
  year_month text COLLATE "C" NOT NULL,
  last_number bigint NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (org_id, year_month),
  CHECK ((length(year_month) = 6 AND ltrim(substr(year_month, 1, 6), '0123456789') = ''))
);
CREATE TABLE billing_invoice_voids (
  org_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  voided_on text COLLATE "C" NOT NULL,
  reason text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, invoice_id),
  CHECK (length(trim(reason)) BETWEEN 1 AND 1000)
);
CREATE TABLE billing_invoices (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  invoice_number text COLLATE "C" NOT NULL,
  partner_id bigint NOT NULL,
  invoice_date text COLLATE "C" NOT NULL,
  due_date text COLLATE "C" NOT NULL,
  source_amount_basis text COLLATE "C" NOT NULL CHECK (source_amount_basis = 'platform_net'),
  amount_ex_tax bigint NOT NULL,
  tax_amount bigint NOT NULL,
  amount_inc_tax bigint NOT NULL CHECK (amount_inc_tax > 0),
  status text COLLATE "C" NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  note text COLLATE "C",
  snapshot_json text COLLATE "C" NOT NULL,
  snapshot_hash text COLLATE "C" NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, invoice_number),
  UNIQUE (org_id, snapshot_hash),
  CHECK (due_date >= invoice_date),
  CHECK (amount_inc_tax = amount_ex_tax + tax_amount)
);
CREATE TABLE billing_receipt_allocations (
  org_id bigint NOT NULL,
  receipt_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  amount_yen bigint NOT NULL CHECK (amount_yen > 0),
  PRIMARY KEY (org_id, receipt_id, invoice_id)
);
CREATE TABLE billing_receipt_reversals (
  org_id bigint NOT NULL,
  receipt_id bigint NOT NULL,
  reversed_on text COLLATE "C" NOT NULL,
  reason text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, receipt_id),
  CHECK (length(trim(reason)) BETWEEN 1 AND 1000)
);
CREATE TABLE billing_receipts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  reference text COLLATE "C" NOT NULL,
  received_on text COLLATE "C" NOT NULL,
  amount_yen bigint NOT NULL CHECK (amount_yen > 0),
  allocation_count bigint NOT NULL CHECK (allocation_count > 0),
  note text COLLATE "C",
  recorded_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  created_by bigint NOT NULL,
  UNIQUE (org_id, id),
  UNIQUE (org_id, partner_id, reference),
  CHECK (length(trim(reference)) BETWEEN 1 AND 160)
);
CREATE TABLE billing_sale_claims (
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  claimed_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, sale_id)
);
CREATE TABLE broadcast_airings (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  slot_id bigint NOT NULL,
  aired_on text COLLATE "C" NOT NULL,
  run_count bigint NOT NULL CHECK (run_count BETWEEN 1 AND 9999),
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) > 0),
  note text COLLATE "C",
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TABLE broadcast_availability_previews (
  token text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  payload_json text COLLATE "C" NOT NULL,
  expires_at text COLLATE "C" NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
);
CREATE TABLE broadcast_availability_rates (
  org_id bigint NOT NULL,
  availability_version_id bigint NOT NULL,
  rate_bps bigint CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  PRIMARY KEY (org_id, availability_version_id)
);
CREATE TABLE broadcast_import_previews (
  token text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  work_id bigint NOT NULL,
  payload_json text COLLATE "C" NOT NULL,
  expires_at text COLLATE "C" NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
);
CREATE TABLE broadcast_sale_links (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  slot_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  note text COLLATE "C",
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, sale_id)
);
CREATE TABLE broadcast_slot_versions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  slot_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  broadcast_month text COLLATE "C" NOT NULL CHECK ((length(broadcast_month) = 7 AND ltrim(substr(broadcast_month, 1, 4), '0123456789') = '' AND substr(broadcast_month, 5, 1) = '-' AND ltrim(substr(broadcast_month, 6, 2), '0123456789') = '')),
  station_name text COLLATE "C" NOT NULL CHECK (length(trim(station_name)) BETWEEN 1 AND 200),
  customer_partner_id bigint,
  agency_partner_id bigint,
  agreement_id bigint,
  period_from text COLLATE "C" NOT NULL,
  period_to text COLLATE "C" NOT NULL,
  planned_on text COLLATE "C",
  planned_runs bigint NOT NULL DEFAULT 1 CHECK (planned_runs BETWEEN 1 AND 9999),
  status text COLLATE "C" NOT NULL CHECK (status IN ('draft', 'pending_first', 'tentative', 'pending_final', 'confirmed', 'rejected', 'cancelled')),
  reason text COLLATE "C",
  source_reference text COLLATE "C",
  changed_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, slot_id, revision),
  CHECK (period_to >= period_from),
  CHECK (substr(period_from, 1, 7) = broadcast_month),
  CHECK (substr(period_to, 1, 7) = broadcast_month),
  CHECK (planned_on IS NULL OR (planned_on >= period_from AND planned_on <= period_to))
);
CREATE TABLE broadcast_slots (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id)
);
CREATE TABLE campaigns (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  name text COLLATE "C" NOT NULL,
  objective text COLLATE "C" NOT NULL,
  audience_hypothesis text COLLATE "C",
  starts_on text COLLATE "C" NOT NULL,
  ends_on text COLLATE "C" NOT NULL,
  target_region text COLLATE "C",
  target_channel text COLLATE "C",
  version bigint NOT NULL DEFAULT 1,
  CHECK (ends_on >= starts_on),
  UNIQUE (org_id, id)
);
CREATE TABLE catalog_credits (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL,
  position bigint NOT NULL,
  role text COLLATE "C" NOT NULL CHECK (role IN ('director', 'writer', 'cast', 'staff')),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) > 0),
  detail text COLLATE "C",
  PRIMARY KEY (org_id, work_id, revision, position)
);
CREATE TABLE catalog_edition_tags (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL,
  edition_key text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('country', 'language', 'music_society')),
  value text COLLATE "C" NOT NULL CHECK (length(trim(value)) > 0),
  PRIMARY KEY (org_id, work_id, revision, edition_key, kind, value)
);
CREATE TABLE catalog_editions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL,
  edition_key text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) > 0),
  runtime_seconds bigint CHECK (runtime_seconds > 0 AND runtime_seconds < 360000),
  aspect_ratio text COLLATE "C",
  rating_authority text COLLATE "C",
  rating_code text COLLATE "C",
  PRIMARY KEY (org_id, work_id, revision, edition_key)
);
CREATE TABLE catalog_product_editions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL,
  product_id bigint NOT NULL,
  edition_key text COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, work_id, revision, product_id)
);
CREATE TABLE catalog_product_windows (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  product_id bigint NOT NULL,
  distribution_code text COLLATE "C" NOT NULL,
  territory text COLLATE "C" NOT NULL CHECK (length(trim(territory)) > 0),
  window_key text COLLATE "C" NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  release_on text COLLATE "C",
  sales_end_on text COLLATE "C",
  terms_text text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL CHECK (status IN ('draft', 'confirmed', 'withdrawn')),
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) > 0),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, work_id, product_id, distribution_code, territory, window_key, revision),
  CHECK (sales_end_on IS NULL OR release_on IS NULL OR sales_end_on >= release_on),
  CHECK (status <> 'confirmed' OR (release_on IS NOT NULL AND sales_end_on IS NOT NULL AND length(trim(terms_text)) > 0))
);
CREATE TABLE catalog_profiles (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  synopsis_long text COLLATE "C",
  synopsis_short text COLLATE "C",
  catch_long text COLLATE "C",
  catch_short text COLLATE "C",
  production_year bigint CHECK (production_year BETWEEN 1880 AND 2200),
  creation_year bigint CHECK (creation_year BETWEEN 1880 AND 2200),
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) > 0),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, work_id, revision)
);
CREATE TABLE change_proposals (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  requested_by bigint NOT NULL,
  request_text text COLLATE "C" NOT NULL,
  field_key text COLLATE "C" NOT NULL,
  label text COLLATE "C" NOT NULL,
  value_type text COLLATE "C" NOT NULL,
  unit text COLLATE "C",
  aggregation text COLLATE "C" NOT NULL,
  sample_header text COLLATE "C" NOT NULL,
  meaning_reason text COLLATE "C" NOT NULL,
  affected_apps_json text COLLATE "C" NOT NULL,
  base_schema_version bigint NOT NULL,
  proposal_hash text COLLATE "C" NOT NULL,
  source text COLLATE "C" NOT NULL CHECK (source IN ('offline-rule', 'ai-json', 'workers-ai', 'service')),
  status text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'adopted', 'rejected')),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  decided_at text COLLATE "C",
  decided_by bigint,
  UNIQUE (org_id, proposal_hash)
);
CREATE TABLE committee_contracts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  intake_case_id bigint NOT NULL,
  document_id bigint NOT NULL,
  contract_code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, id, work_id),
  UNIQUE (org_id, contract_code)
);
CREATE TABLE committee_report_previews (
  token text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  payload_json text COLLATE "C" NOT NULL,
  expires_at text COLLATE "C" NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
);
CREATE TABLE committee_report_snapshots (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  period_index bigint NOT NULL,
  period_from text COLLATE "C" NOT NULL,
  period_to text COLLATE "C" NOT NULL,
  close_on text COLLATE "C" NOT NULL,
  report_on text COLLATE "C" NOT NULL,
  payment_on text COLLATE "C" NOT NULL,
  period_date_basis text COLLATE "C" NOT NULL CHECK (period_date_basis IN ('sales_period', 'report_received')),
  stub bigint NOT NULL CHECK (stub IN (0, 1)),
  allow_stub bigint NOT NULL CHECK (allow_stub IN (0, 1)),
  status text COLLATE "C" NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  verification text COLLATE "C" NOT NULL DEFAULT 'unverified' CHECK (verification = 'unverified'),
  calculation_version text COLLATE "C" NOT NULL,
  input_json text COLLATE "C" NOT NULL,
  input_hash text COLLATE "C" NOT NULL,
  calculation_json text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, id, work_id)
);
CREATE TABLE committee_schedule_phases (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  phase_order bigint NOT NULL CHECK (phase_order > 0),
  label text COLLATE "C" NOT NULL,
  starts_on text COLLATE "C" NOT NULL,
  ends_on text COLLATE "C" NOT NULL,
  first_close_on text COLLATE "C" NOT NULL,
  interval_months bigint NOT NULL CHECK (interval_months BETWEEN 1 AND 12),
  close_day text COLLATE "C" NOT NULL,
  report_offset_months bigint NOT NULL CHECK (report_offset_months BETWEEN 0 AND 24),
  report_day text COLLATE "C" NOT NULL,
  payment_offset_months bigint NOT NULL CHECK (payment_offset_months BETWEEN 0 AND 24),
  payment_day text COLLATE "C" NOT NULL,
  reference_type text COLLATE "C" NOT NULL CHECK (reference_type IN ('release', 'first_sales', 'first_report', 'contract_specific')),
  reference_date text COLLATE "C" NOT NULL,
  CHECK (ends_on >= starts_on AND first_close_on >= starts_on AND first_close_on <= ends_on),
  UNIQUE (org_id, id),
  UNIQUE (org_id, term_version_id, phase_order)
);
CREATE TABLE committee_snapshot_deductions (
  org_id bigint NOT NULL,
  snapshot_id bigint NOT NULL,
  work_id bigint NOT NULL,
  report_id bigint NOT NULL,
  window_id bigint NOT NULL,
  category text COLLATE "C" NOT NULL CHECK (category IN ('royalty', 'production_recoup')),
  recipient_partner_id bigint NOT NULL,
  amount_yen bigint NOT NULL CHECK (amount_yen > 0),
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) > 0),
  PRIMARY KEY (org_id, snapshot_id, source_reference),
  UNIQUE (org_id, work_id, source_reference)
);
CREATE TABLE committee_snapshot_expenses (
  org_id bigint NOT NULL,
  snapshot_id bigint NOT NULL,
  work_id bigint NOT NULL,
  expense_id bigint NOT NULL,
  window_id bigint NOT NULL,
  amount_ex_tax bigint NOT NULL,
  PRIMARY KEY (org_id, snapshot_id, expense_id),
  UNIQUE (org_id, expense_id)
);
CREATE TABLE committee_snapshot_lines (
  org_id bigint NOT NULL,
  snapshot_id bigint NOT NULL,
  work_id bigint NOT NULL,
  report_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  window_id bigint NOT NULL,
  source_row bigint,
  allocation_bps bigint NOT NULL,
  allocated_amount_ex_tax bigint NOT NULL,
  sales_period_from text COLLATE "C" NOT NULL,
  sales_period_to text COLLATE "C" NOT NULL,
  accounting_month text COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, snapshot_id, sale_id, work_id)
);
CREATE TABLE committee_snapshot_member_amounts (
  org_id bigint NOT NULL,
  snapshot_id bigint NOT NULL,
  window_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  share_bps bigint NOT NULL,
  amount_yen bigint NOT NULL,
  route text COLLATE "C" NOT NULL CHECK (route IN ('direct', 'via_manager')),
  window_fee_recipient bigint NOT NULL CHECK (window_fee_recipient IN (0, 1)),
  manager_fee_recipient bigint NOT NULL CHECK (manager_fee_recipient IN (0, 1)),
  PRIMARY KEY (org_id, snapshot_id, window_id, partner_id)
);
CREATE TABLE committee_snapshot_reports (
  org_id bigint NOT NULL,
  snapshot_id bigint NOT NULL,
  work_id bigint NOT NULL,
  report_id bigint NOT NULL,
  window_id bigint NOT NULL,
  report_basis text COLLATE "C" NOT NULL CHECK (report_basis IN ('gross', 'net')),
  PRIMARY KEY (org_id, snapshot_id, report_id),
  UNIQUE (org_id, work_id, report_id)
);
CREATE TABLE committee_term_funding (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  production_cost_yen bigint NOT NULL CHECK (production_cost_yen >= 0),
  PRIMARY KEY (org_id, term_version_id)
);
CREATE TABLE committee_term_investments (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  amount_yen bigint NOT NULL CHECK (amount_yen >= 0),
  PRIMARY KEY (org_id, term_version_id, partner_id)
);
CREATE TABLE committee_term_members (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  role text COLLATE "C",
  share_bps bigint NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  member_order bigint NOT NULL CHECK (member_order > 0),
  UNIQUE (org_id, id),
  UNIQUE (org_id, term_version_id, partner_id),
  UNIQUE (org_id, term_version_id, member_order)
);
CREATE TABLE committee_term_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  source_version_id bigint,
  manager_partner_id bigint,
  calculation_version text COLLATE "C" NOT NULL,
  note text COLLATE "C",
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, id),
  UNIQUE (org_id, contract_id, version_no)
);
CREATE TABLE committee_term_windows (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('theatrical', 'digital', 'package', 'broadcast', 'other')),
  label text COLLATE "C" NOT NULL,
  window_partner_id bigint NOT NULL,
  route text COLLATE "C" NOT NULL CHECK (route IN ('direct', 'via_manager')),
  platform_rate_bps bigint NOT NULL CHECK (platform_rate_bps BETWEEN 0 AND 10000),
  window_fee_bps bigint NOT NULL CHECK (window_fee_bps BETWEEN 0 AND 10000),
  manager_fee_bps bigint NOT NULL CHECK (manager_fee_bps BETWEEN 0 AND 10000),
  fee_order text COLLATE "C" NOT NULL CHECK (fee_order IN ('window_first', 'manager_first')),
  window_fee_basis text COLLATE "C" NOT NULL CHECK (window_fee_basis IN ('platform_net', 'after_manager')),
  manager_fee_basis text COLLATE "C" NOT NULL CHECK (manager_fee_basis IN ('platform_net', 'after_window')),
  UNIQUE (org_id, id),
  UNIQUE (org_id, term_version_id, id),
  UNIQUE (org_id, term_version_id, kind)
);
CREATE TABLE day_scene_assignments (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  shooting_day_id bigint NOT NULL,
  scene_id bigint NOT NULL,
  sequence_order bigint NOT NULL CHECK (sequence_order > 0),
  planned_start text COLLATE "C",
  planned_end text COLLATE "C",
  actual_start text COLLATE "C",
  actual_end text COLLATE "C",
  outcome text COLLATE "C" NOT NULL DEFAULT 'planned' CHECK (outcome IN ('planned', 'partial', 'shot', 'not_shot')),
  notes text COLLATE "C",
  UNIQUE (org_id, id),
  UNIQUE (org_id, shooting_day_id, scene_id),
  UNIQUE (org_id, shooting_day_id, sequence_order),
  CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end > planned_start),
  CHECK (actual_end IS NULL OR actual_start IS NULL OR actual_end > actual_start)
);
CREATE TABLE digital_sale_details (
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  model text COLLATE "C" NOT NULL CHECK (model IN ('est', 'tvod', 'svod', 'avod', 'flat', 'mg')),
  service_code text COLLATE "C" NOT NULL CHECK (length(trim(service_code)) > 0),
  sales_count bigint CHECK (sales_count IS NULL OR sales_count >= 0),
  view_count bigint CHECK (view_count IS NULL OR view_count >= 0),
  view_seconds bigint CHECK (view_seconds IS NULL OR view_seconds >= 0),
  unit_price_ex_tax text COLLATE "C",
  holder_unit_price_ex_tax text COLLATE "C",
  contract_amount_ex_tax text COLLATE "C",
  contract_period_from text COLLATE "C",
  contract_period_to text COLLATE "C",
  reported_actual_ex_tax text COLLATE "C",
  reported_recognized_ex_tax text COLLATE "C",
  calculated_actual_ex_tax text COLLATE "C",
  PRIMARY KEY (org_id, sale_id),
  CHECK ((model IN ('est', 'tvod') AND view_count IS NULL AND view_seconds IS NULL AND contract_amount_ex_tax IS NULL) OR (model IN ('svod', 'avod') AND sales_count IS NULL AND unit_price_ex_tax IS NULL AND contract_amount_ex_tax IS NULL) OR (model IN ('flat', 'mg') AND sales_count IS NULL AND view_count IS NULL AND view_seconds IS NULL AND unit_price_ex_tax IS NULL)),
  CHECK (model = 'flat' OR (contract_amount_ex_tax IS NULL AND contract_period_from IS NULL AND contract_period_to IS NULL)),
  CHECK (contract_amount_ex_tax IS NULL OR (contract_period_from IS NOT NULL AND contract_period_to IS NOT NULL AND contract_period_to >= contract_period_from))
);
CREATE TABLE distribution_master (
  code text COLLATE "C" PRIMARY KEY,
  distribution_name text COLLATE "C" NOT NULL,
  transaction_method text COLLATE "C" NOT NULL,
  sales_type text COLLATE "C" NOT NULL,
  notes text COLLATE "C" NOT NULL,
  source_sha256 text COLLATE "C" NOT NULL,
  source_row bigint NOT NULL
);
CREATE TABLE distribution_types (
  code text COLLATE "C" PRIMARY KEY,
  family text COLLATE "C" NOT NULL,
  label text COLLATE "C" NOT NULL,
  utilization text COLLATE "C",
  sort_order bigint NOT NULL
);
CREATE TABLE expenses (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint,
  partner_id bigint,
  incurred_on text COLLATE "C" NOT NULL,
  accounting_month text COLLATE "C" NOT NULL CHECK ((length(accounting_month) = 7 AND ltrim(substr(accounting_month, 1, 4), '0123456789') = '' AND substr(accounting_month, 5, 1) = '-' AND ltrim(substr(accounting_month, 6, 2), '0123456789') = '')),
  category text COLLATE "C" NOT NULL,
  description text COLLATE "C" NOT NULL,
  budget_yen bigint CHECK (budget_yen IS NULL OR budget_yen >= 0),
  actual_ex_tax bigint NOT NULL,
  tax_amount bigint NOT NULL,
  actual_inc_tax bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  CHECK (actual_inc_tax = actual_ex_tax + tax_amount),
  UNIQUE (org_id, id)
);
CREATE TABLE exposures (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  campaign_id bigint NOT NULL,
  medium text COLLATE "C" NOT NULL,
  asset_version text COLLATE "C",
  scheduled_at text COLLATE "C",
  happened_at text COLLATE "C",
  source_url text COLLATE "C",
  region text COLLATE "C",
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (org_id, id)
);
CREATE TABLE import_previews (
  token text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  payload_json text COLLATE "C" NOT NULL,
  expires_at text COLLATE "C" NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE intake_settlement_links (
  org_id bigint NOT NULL,
  intake_case_id bigint NOT NULL,
  work_id bigint NOT NULL,
  settlement_contract_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, intake_case_id, settlement_contract_id),
  UNIQUE (org_id, settlement_contract_id)
);
CREATE TABLE invitations (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  email text COLLATE "C" NOT NULL CHECK (email = lower(email)),
  project_id bigint NOT NULL,
  role text COLLATE "C" NOT NULL CHECK (role IN ('editor', 'production')),
  expires_at text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, email, project_id, status)
);
CREATE TABLE joint_business_holidays (
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  holiday_on text COLLATE "C" NOT NULL,
  label text COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, contract_id, holiday_on)
);
CREATE TABLE joint_committee_contracts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  calculation_version text COLLATE "C" NOT NULL CHECK (calculation_version = 'joint_cash_v1'),
  demo_flag bigint NOT NULL DEFAULT 0 CHECK (demo_flag IN (0, 1)),
  manager_partner_id bigint NOT NULL,
  producer_partner_id bigint NOT NULL,
  production_cost_inc_tax_yen bigint NOT NULL CHECK (production_cost_inc_tax_yen >= 0),
  pa_inc_tax_yen bigint NOT NULL CHECK (pa_inc_tax_yen >= 0),
  manager_fee_bps bigint NOT NULL CHECK (manager_fee_bps BETWEEN 0 AND 10000),
  income_threshold_yen bigint NOT NULL CHECK (income_threshold_yen >= 0),
  transfer_threshold_yen bigint NOT NULL CHECK (transfer_threshold_yen >= 0),
  investor_report_offset_months bigint NOT NULL,
  investor_report_day text COLLATE "C" NOT NULL,
  investor_payment_offset_months bigint NOT NULL,
  investor_payment_day text COLLATE "C" NOT NULL,
  terms_note text COLLATE "C" NOT NULL,
  UNIQUE (org_id, id),
  UNIQUE (org_id, code),
  CHECK (manager_partner_id <> producer_partner_id)
);
CREATE TABLE joint_committee_costs (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  window_id bigint,
  period_sequence bigint NOT NULL,
  source_ref text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('window_direct', 'music_window_paid', 'rights_manager', 'master_management', 'bank_advance')),
  amount_yen bigint NOT NULL CHECK (amount_yen >= 0),
  tax_basis text COLLATE "C" NOT NULL CHECK (tax_basis IN ('ex_tax', 'inc_tax')),
  approved bigint NOT NULL CHECK (approved = 1),
  UNIQUE (org_id, contract_id, source_ref),
  CHECK ((kind IN ('window_direct', 'music_window_paid') AND window_id IS NOT NULL) OR (kind NOT IN ('window_direct', 'music_window_paid') AND window_id IS NULL))
);
CREATE TABLE joint_committee_members (
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  role text COLLATE "C" NOT NULL CHECK (role = 'investor'),
  share_bps bigint NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  contribution_inc_tax_yen bigint NOT NULL CHECK (contribution_inc_tax_yen >= 0),
  PRIMARY KEY (org_id, contract_id, partner_id)
);
CREATE TABLE joint_committee_periods (
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  from_on text COLLATE "C" NOT NULL,
  to_on text COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, contract_id, sequence),
  CHECK (from_on <= to_on)
);
CREATE TABLE joint_committee_sales (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  window_id bigint NOT NULL,
  period_sequence bigint NOT NULL,
  source_ref text COLLATE "C" NOT NULL,
  amount_contract_yen bigint NOT NULL CHECK (amount_contract_yen >= 0),
  gross_inc_tax_yen bigint NOT NULL CHECK (gross_inc_tax_yen >= 0),
  reported_on text COLLATE "C",
  manager_receipt_on text COLLATE "C",
  UNIQUE (org_id, contract_id, source_ref)
);
CREATE TABLE joint_committee_snapshots (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  calculation_version text COLLATE "C" NOT NULL CHECK (calculation_version = 'joint_cash_v1'),
  input_hash text COLLATE "C" NOT NULL,
  calculation_json text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, contract_id, input_hash)
);
CREATE TABLE joint_committee_windows (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL,
  label text COLLATE "C" NOT NULL,
  partner_id bigint NOT NULL,
  fee_bps bigint NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  report_offset_months bigint NOT NULL,
  report_day text COLLATE "C" NOT NULL,
  payment_offset_months bigint NOT NULL,
  payment_day text COLLATE "C" NOT NULL,
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, id)
);
CREATE TABLE joint_funding_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('cash_contribution', 'production_payment_credit')),
  source_ref text COLLATE "C" NOT NULL,
  amount_inc_tax_yen bigint NOT NULL CHECK (amount_inc_tax_yen > 0),
  paid_on text COLLATE "C" NOT NULL,
  milestone_id bigint,
  UNIQUE (org_id, contract_id, source_ref),
  CHECK ((kind = 'production_payment_credit' AND milestone_id IS NOT NULL) OR (kind = 'cash_contribution' AND milestone_id IS NULL))
);
CREATE TABLE joint_production_milestones (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  producer_partner_id bigint NOT NULL,
  stage text COLLATE "C" NOT NULL CHECK (stage IN ('schedule_approved', 'shooting_complete', 'delivery_accepted')),
  due_on text COLLATE "C" NOT NULL,
  condition_met_on text COLLATE "C",
  acceptance_on text COLLATE "C",
  amount_inc_tax_yen bigint NOT NULL CHECK (amount_inc_tax_yen >= 0),
  paid_on text COLLATE "C",
  paid_inc_tax_yen bigint NOT NULL DEFAULT 0 CHECK (paid_inc_tax_yen >= 0),
  UNIQUE (org_id, contract_id, stage),
  CHECK (paid_inc_tax_yen <= amount_inc_tax_yen),
  CHECK (paid_inc_tax_yen = 0 OR (paid_on IS NOT NULL AND condition_met_on IS NOT NULL)),
  CHECK (stage <> 'delivery_accepted' OR paid_inc_tax_yen = 0 OR acceptance_on IS NOT NULL)
);
CREATE TABLE mapping_import_provenance (
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  work_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('theatrical', 'digital', 'package', 'broadcast', 'other')),
  mapping_version_id bigint NOT NULL,
  original_text text COLLATE "C" NOT NULL,
  original_hash text COLLATE "C" NOT NULL,
  canonical_text text COLLATE "C" NOT NULL,
  canonical_hash text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, report_id),
  UNIQUE (org_id, work_id, partner_id, kind, original_hash)
);
CREATE TABLE memberships (
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  role text COLLATE "C" NOT NULL CHECK (role IN ('admin', 'editor', 'production')),
  active bigint NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  expires_at text COLLATE "C",
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE metric_definitions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  field_key text COLLATE "C" NOT NULL,
  label text COLLATE "C" NOT NULL,
  value_type text COLLATE "C" NOT NULL CHECK (value_type IN ('integer', 'decimal', 'text', 'boolean')),
  unit text COLLATE "C",
  aggregation text COLLATE "C" NOT NULL CHECK (aggregation IN ('sum', 'average', 'latest', 'none')),
  active bigint NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, field_key),
  CHECK (length(field_key) BETWEEN 1 AND 40 AND (length(substr(field_key, 1, 1)) = 1 AND ltrim(substr(substr(field_key, 1, 1), 1, 1), 'abcdefghijklmnopqrstuvwxyz') = '') AND (NOT (ltrim(field_key, 'abcdefghijklmnopqrstuvwxyz0123456789_') <> '')))
);
CREATE TABLE mg_contract_links (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  incoming_contract_id bigint NOT NULL,
  outgoing_contract_id bigint NOT NULL,
  rationale text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, incoming_contract_id, outgoing_contract_id)
);
CREATE TABLE mg_incoming_contracts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  partner_id bigint NOT NULL,
  contract_date text COLLATE "C" NOT NULL,
  source_reference text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code)
);
CREATE TABLE mg_ledger_entries (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  product_id bigint NOT NULL,
  period_from text COLLATE "C" NOT NULL,
  period_to text COLLATE "C" NOT NULL CHECK (period_to >= period_from),
  report_received_on text COLLATE "C",
  accounting_month text COLLATE "C" NOT NULL CHECK ((length(accounting_month) = 7 AND ltrim(substr(accounting_month, 1, 4), '0123456789') = '' AND substr(accounting_month, 5, 1) = '-' AND ltrim(substr(accounting_month, 6, 2), '0123456789') = '')),
  source_reference text COLLATE "C" NOT NULL,
  reported_eligible_yen bigint NOT NULL CHECK (reported_eligible_yen >= 0),
  applied_recoup_yen bigint NOT NULL CHECK (applied_recoup_yen >= 0),
  reported_overage_yen bigint NOT NULL CHECK (reported_overage_yen >= 0),
  recognized_yen bigint NOT NULL CHECK (recognized_yen >= 0),
  status text COLLATE "C" NOT NULL CHECK (status IN ('unverified', 'reviewed')),
  acknowledgement bigint NOT NULL DEFAULT 0 CHECK (acknowledgement IN (0, 1)),
  confirmation_reason text COLLATE "C",
  reverses_entry_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, term_version_id, product_id, source_reference),
  UNIQUE (org_id, reverses_entry_id),
  CHECK (status = 'unverified' OR (acknowledgement = 1 AND length(trim(confirmation_reason)) > 0)),
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
CREATE TABLE mg_outgoing_contracts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  supplier_id bigint NOT NULL,
  contract_date text COLLATE "C" NOT NULL,
  source_reference text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code)
);
CREATE TABLE mg_suppliers (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL CHECK ((length(code) >= 4 AND substr(code, 1, 4) = 'SUP-')),
  name text COLLATE "C" NOT NULL,
  note text COLLATE "C" NOT NULL DEFAULT '',
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code)
);
CREATE TABLE mg_term_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  incoming_contract_id bigint,
  outgoing_contract_id bigint,
  version bigint NOT NULL CHECK (version > 0),
  mode text COLLATE "C" NOT NULL CHECK (mode IN ('single', 'cross', 'special')),
  mg_amount_yen bigint NOT NULL CHECK (mg_amount_yen >= 0),
  starts_on text COLLATE "C" NOT NULL,
  ends_on text COLLATE "C" NOT NULL CHECK (ends_on >= starts_on),
  reason text COLLATE "C" NOT NULL,
  source_reference text COLLATE "C" NOT NULL,
  special_unverified bigint NOT NULL DEFAULT 0 CHECK (special_unverified IN (0, 1)),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  CHECK ((incoming_contract_id IS NULL) != (outgoing_contract_id IS NULL)),
  CHECK (mode = 'special' OR special_unverified = 0),
  UNIQUE (org_id, id),
  UNIQUE (org_id, incoming_contract_id, version),
  UNIQUE (org_id, outgoing_contract_id, version)
);
CREATE TABLE mg_version_phases (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  phase_order bigint NOT NULL,
  starts_on text COLLATE "C" NOT NULL,
  ends_on text COLLATE "C" NOT NULL CHECK (ends_on >= starts_on),
  interval_months bigint NOT NULL CHECK (interval_months IN (1, 3, 6, 12)),
  close_day text COLLATE "C" NOT NULL DEFAULT '31' CHECK (close_day = 'eom' OR ((NOT (ltrim(close_day, '0123456789') <> '')) AND lite_cast_int(close_day) BETWEEN 1 AND 31)),
  first_close_on text COLLATE "C" NOT NULL,
  report_offset_months bigint NOT NULL CHECK (report_offset_months BETWEEN 0 AND 24),
  report_day bigint NOT NULL CHECK (report_day BETWEEN 1 AND 31),
  pay_offset_months bigint NOT NULL CHECK (pay_offset_months BETWEEN 0 AND 24),
  pay_day bigint NOT NULL CHECK (pay_day BETWEEN 1 AND 31),
  UNIQUE (org_id, term_version_id, phase_order)
);
CREATE TABLE mg_version_products (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  product_id bigint NOT NULL,
  evaluation_yen bigint NOT NULL CHECK (evaluation_yen >= 0),
  PRIMARY KEY (org_id, term_version_id, product_id)
);
CREATE TABLE observations (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  exposure_id bigint NOT NULL,
  metric_definition_id bigint NOT NULL,
  report_id bigint,
  source_row bigint,
  period_from text COLLATE "C" NOT NULL,
  period_to text COLLATE "C" NOT NULL,
  granularity text COLLATE "C" NOT NULL CHECK (granularity IN ('day', 'week', 'month', 'event', 'unknown')),
  value_number double precision,
  value_text text COLLATE "C",
  verification text COLLATE "C" NOT NULL DEFAULT 'unverified' CHECK (verification IN ('verified', 'unverified')),
  acquired_at text COLLATE "C" NOT NULL,
  paid_organic text COLLATE "C" CHECK (paid_organic IS NULL OR paid_organic IN ('paid', 'organic', 'mixed', 'unknown')),
  source text COLLATE "C",
  region text COLLATE "C",
  CHECK (period_to >= period_from),
  CHECK (NOT (value_number IS NOT NULL AND value_text IS NOT NULL)),
  UNIQUE (org_id, id)
);
CREATE TABLE organizations (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL UNIQUE,
  name text COLLATE "C" NOT NULL
);
CREATE TABLE package_observation_products (
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  source_row bigint NOT NULL,
  metric text COLLATE "C" NOT NULL,
  product_id bigint NOT NULL,
  PRIMARY KEY (org_id, report_id, source_row, metric)
);
CREATE TABLE package_report_observations (
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  source_row bigint NOT NULL CHECK (source_row >= 1),
  metric text COLLATE "C" NOT NULL CHECK (metric IN ('delivered', 'active', 'inventory', 'returned')),
  count bigint NOT NULL CHECK (count >= 0),
  unit text COLLATE "C" NOT NULL CHECK (length(trim(unit)) > 0),
  scope text COLLATE "C" NOT NULL CHECK (length(trim(scope)) > 0),
  basis text COLLATE "C" NOT NULL CHECK (length(trim(basis)) > 0),
  observed_on text COLLATE "C",
  PRIMARY KEY (org_id, report_id, source_row, metric),
  CHECK (metric <> 'inventory' OR observed_on IS NOT NULL)
);
CREATE TABLE package_sale_details (
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  model text COLLATE "C" NOT NULL CHECK (model IN ('rental', 'sell_through', 'license')),
  turns_count bigint CHECK (turns_count IS NULL OR turns_count >= 0),
  average_rental_price_ex_tax text COLLATE "C",
  holder_unit_price_ex_tax text COLLATE "C",
  reported_actual_ex_tax text COLLATE "C",
  reported_recognized_ex_tax text COLLATE "C",
  calculated_actual_ex_tax text COLLATE "C",
  PRIMARY KEY (org_id, sale_id),
  CHECK (model = 'rental' OR (turns_count IS NULL AND average_rental_price_ex_tax IS NULL))
);
CREATE TABLE partners (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL DEFAULT 'other' CHECK (kind IN ('cinema', 'platform', 'retailer', 'agency', 'vendor', 'other')),
  region text COLLATE "C",
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  UNIQUE (org_id, code)
);
CREATE TABLE prep_tasks (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  shooting_day_id bigint,
  scene_id bigint,
  title text COLLATE "C" NOT NULL,
  owner_label text COLLATE "C",
  due_on text COLLATE "C",
  status text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'blocked')),
  note text COLLATE "C",
  version bigint NOT NULL DEFAULT 1,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (length(trim(title)) BETWEEN 1 AND 200)
);
CREATE TABLE product_works (
  org_id bigint NOT NULL,
  product_id bigint NOT NULL,
  work_id bigint NOT NULL,
  allocation_bps bigint NOT NULL CHECK (allocation_bps BETWEEN 1 AND 10000),
  PRIMARY KEY (org_id, product_id, work_id)
);
CREATE TABLE production_appearances (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  scene_id bigint NOT NULL,
  character_key text COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, work_id, scene_id, character_key)
);
CREATE TABLE production_calls (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  day_id bigint NOT NULL,
  character_key text COLLATE "C" NOT NULL,
  call_time text COLLATE "C",
  ready_time text COLLATE "C",
  note text COLLATE "C",
  PRIMARY KEY (org_id, work_id, day_id, character_key)
);
CREATE TABLE production_characters (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  key text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL,
  short_name text COLLATE "C",
  actor_name text COLLATE "C",
  note text COLLATE "C",
  PRIMARY KEY (org_id, work_id, key),
  UNIQUE (org_id, work_id, name)
);
CREATE TABLE production_day_slots (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  day_id bigint NOT NULL,
  key text COLLATE "C" NOT NULL,
  after_scene_order bigint NOT NULL CHECK (after_scene_order >= 0),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('move', 'meal', 'wrap', 'prep', 'other')),
  label text COLLATE "C" NOT NULL,
  planned_start text COLLATE "C",
  planned_end text COLLATE "C",
  actual_start text COLLATE "C",
  actual_end text COLLATE "C",
  note text COLLATE "C",
  PRIMARY KEY (org_id, work_id, day_id, key),
  CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end > planned_start),
  CHECK (actual_end IS NULL OR actual_start IS NULL OR actual_end > actual_start)
);
CREATE TABLE production_location_plans (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  location_key text COLLATE "C" NOT NULL,
  strokes_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(strokes_json) AND lite_json_type(strokes_json) = 'array' AND length(strokes_json) <= 262144),
  PRIMARY KEY (org_id, work_id, location_key)
);
CREATE TABLE production_locations (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  key text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL,
  address text COLLATE "C",
  floor text COLLATE "C",
  green_room text COLLATE "C",
  parking text COLLATE "C",
  facilities text COLLATE "C",
  contact text COLLATE "C",
  note text COLLATE "C",
  PRIMARY KEY (org_id, work_id, key),
  UNIQUE (org_id, work_id, name)
);
CREATE TABLE production_looks (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  key text COLLATE "C" NOT NULL,
  character_key text COLLATE "C" NOT NULL,
  label text COLLATE "C" NOT NULL,
  makeup text COLLATE "C",
  props text COLLATE "C",
  shoes text COLLATE "C",
  accessories text COLLATE "C",
  note text COLLATE "C",
  PRIMARY KEY (org_id, work_id, key),
  UNIQUE (org_id, work_id, character_key, label)
);
CREATE TABLE production_revisions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (org_id, work_id)
);
CREATE TABLE production_scene_details (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  scene_id bigint NOT NULL,
  page_eighths bigint CHECK (page_eighths IS NULL OR page_eighths >= 0),
  estimated_minutes bigint CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  location_key text COLLATE "C",
  note text COLLATE "C",
  PRIMARY KEY (org_id, work_id, scene_id)
);
CREATE TABLE production_scene_looks (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  scene_id bigint NOT NULL,
  look_key text COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, work_id, scene_id, look_key)
);
CREATE TABLE products (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  sku text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL,
  channel text COLLATE "C" NOT NULL CHECK (channel IN ('theatrical', 'digital', 'package', 'broadcast', 'license', 'other')),
  version bigint NOT NULL DEFAULT 1,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, sku)
);
CREATE TABLE project_memberships (
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  user_id bigint NOT NULL,
  permission text COLLATE "C" NOT NULL CHECK (permission IN ('edit', 'production')),
  expires_at text COLLATE "C",
  PRIMARY KEY (org_id, project_id, user_id)
);
CREATE TABLE projects (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'complete', 'paused')),
  budget_yen bigint CHECK (budget_yen IS NULL OR budget_yen >= 0),
  version bigint NOT NULL DEFAULT 1,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code)
);
CREATE TABLE receipt_plan_decisions (
  org_id bigint NOT NULL,
  request_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  decision text COLLATE "C" NOT NULL CHECK (decision IN ('approved', 'rejected')),
  version_no bigint,
  effective_on text COLLATE "C" NOT NULL,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, request_id),
  UNIQUE (org_id, invoice_id, version_no),
  CHECK ((decision = 'approved' AND version_no > 0) OR (decision = 'rejected' AND version_no IS NULL))
);
CREATE TABLE receipt_plan_requests (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  base_version bigint NOT NULL CHECK (base_version >= 0),
  previous_due_date text COLLATE "C" NOT NULL,
  proposed_due_date text COLLATE "C" NOT NULL,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, invoice_id, id)
);
CREATE TABLE recognition_bases (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY CHECK (id IN (1, 2, 3, 4, 5)),
  code text COLLATE "C" NOT NULL UNIQUE,
  name text COLLATE "C" NOT NULL,
  source_field text COLLATE "C" NOT NULL UNIQUE,
  CHECK ((id = 1 AND code = 'sales_month' AND source_field = 'sales_month') OR (id = 2 AND code = 'report_received_month' AND source_field = 'report_received_on') OR (id = 3 AND code = 'contract_start_month' AND source_field = 'contract_start_on') OR (id = 4 AND code = 'license_start_month' AND source_field = 'license_start_on') OR (id = 5 AND code = 'broadcast_month' AND source_field = 'broadcast_on'))
);
CREATE TABLE report_channel_fact_seals (
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  sealed_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, report_id)
);
CREATE TABLE report_imports (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  partner_id bigint,
  report_key text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('theatrical', 'digital', 'package', 'broadcast', 'other', 'publicity')),
  period_from text COLLATE "C" NOT NULL,
  period_to text COLLATE "C" NOT NULL,
  accounting_month text COLLATE "C" NOT NULL CHECK ((length(accounting_month) = 7 AND ltrim(substr(accounting_month, 1, 4), '0123456789') = '' AND substr(accounting_month, 5, 1) = '-' AND ltrim(substr(accounting_month, 6, 2), '0123456789') = '')),
  raw_text text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'void')),
  supersedes_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, report_key, content_hash),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  CHECK (period_to >= period_from),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
CREATE TABLE report_mapping_profiles (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('theatrical', 'digital', 'package', 'broadcast', 'other')),
  name text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, partner_id, kind, name)
);
CREATE TABLE report_mapping_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  profile_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  definition_json text COLLATE "C" NOT NULL,
  definition_hash text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, profile_id, id),
  UNIQUE (org_id, profile_id, version_no)
);
CREATE TABLE report_recognition (
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  recognition_basis_id bigint NOT NULL,
  sales_month text COLLATE "C",
  report_received_on text COLLATE "C",
  contract_start_on text COLLATE "C",
  license_start_on text COLLATE "C",
  broadcast_on text COLLATE "C",
  basis_reason text COLLATE "C" NOT NULL CHECK (length(trim(basis_reason)) BETWEEN 1 AND 1000),
  accounting_status text COLLATE "C" NOT NULL DEFAULT 'unverified' CHECK (accounting_status = 'unverified'),
  resolved_month text COLLATE "C" NOT NULL CHECK ((length(resolved_month) = 7 AND ltrim(substr(resolved_month, 1, 4), '0123456789') = '' AND substr(resolved_month, 5, 1) = '-' AND ltrim(substr(resolved_month, 6, 2), '0123456789') = '')),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, report_id),
  CHECK (sales_month IS NULL OR (length(sales_month) = 7 AND ltrim(substr(sales_month, 1, 4), '0123456789') = '' AND substr(sales_month, 5, 1) = '-' AND ltrim(substr(sales_month, 6, 2), '0123456789') = '')),
  CHECK (report_received_on IS NULL OR (length(report_received_on) = 10 AND ltrim(substr(report_received_on, 1, 4), '0123456789') = '' AND substr(report_received_on, 5, 1) = '-' AND ltrim(substr(report_received_on, 6, 2), '0123456789') = '' AND substr(report_received_on, 8, 1) = '-' AND ltrim(substr(report_received_on, 9, 2), '0123456789') = '')),
  CHECK (contract_start_on IS NULL OR (length(contract_start_on) = 10 AND ltrim(substr(contract_start_on, 1, 4), '0123456789') = '' AND substr(contract_start_on, 5, 1) = '-' AND ltrim(substr(contract_start_on, 6, 2), '0123456789') = '' AND substr(contract_start_on, 8, 1) = '-' AND ltrim(substr(contract_start_on, 9, 2), '0123456789') = '')),
  CHECK (license_start_on IS NULL OR (length(license_start_on) = 10 AND ltrim(substr(license_start_on, 1, 4), '0123456789') = '' AND substr(license_start_on, 5, 1) = '-' AND ltrim(substr(license_start_on, 6, 2), '0123456789') = '' AND substr(license_start_on, 8, 1) = '-' AND ltrim(substr(license_start_on, 9, 2), '0123456789') = '')),
  CHECK (broadcast_on IS NULL OR (length(broadcast_on) = 10 AND ltrim(substr(broadcast_on, 1, 4), '0123456789') = '' AND substr(broadcast_on, 5, 1) = '-' AND ltrim(substr(broadcast_on, 6, 2), '0123456789') = '' AND substr(broadcast_on, 8, 1) = '-' AND ltrim(substr(broadcast_on, 9, 2), '0123456789') = '')),
  CHECK ((recognition_basis_id = 1 AND sales_month IS NOT NULL AND resolved_month = sales_month) OR (recognition_basis_id = 2 AND report_received_on IS NOT NULL AND resolved_month = substr(report_received_on, 1, 7)) OR (recognition_basis_id = 3 AND contract_start_on IS NOT NULL AND resolved_month = substr(contract_start_on, 1, 7)) OR (recognition_basis_id = 4 AND license_start_on IS NOT NULL AND resolved_month = substr(license_start_on, 1, 7)) OR (recognition_basis_id = 5 AND broadcast_on IS NOT NULL AND resolved_month = substr(broadcast_on, 1, 7)))
);
CREATE TABLE report_sale_dimensions_versions (
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  department_name text COLLATE "C" CHECK (department_name IS NULL OR length(trim(department_name)) BETWEEN 1 AND 100),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, sale_id, version_no)
);
CREATE TABLE report_source_controls (
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  scope_kind text COLLATE "C" NOT NULL CHECK (scope_kind IN ('report', 'channel')),
  channel text COLLATE "C" NOT NULL DEFAULT '',
  metric text COLLATE "C" NOT NULL CHECK (metric IN ('row_count', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax')),
  expected_value bigint NOT NULL CHECK (expected_value BETWEEN - 9007199254740991 AND 9007199254740991),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, report_id, scope_kind, channel, metric),
  CHECK ((scope_kind = 'report' AND channel = '') OR (scope_kind = 'channel' AND channel IN ('theatrical', 'digital', 'package', 'broadcast', 'other'))),
  CHECK (metric <> 'row_count' OR expected_value >= 0)
);
CREATE TABLE rights_intake_cases (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  case_code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  intake_type text COLLATE "C" NOT NULL CHECK (intake_type IN ('committee', 'sole_owned', 'entrusted')),
  source_case_id bigint,
  snapshot_version bigint NOT NULL DEFAULT 1 CHECK (snapshot_version > 0),
  status text COLLATE "C" NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, id, work_id),
  UNIQUE (org_id, case_code)
);
CREATE TABLE rights_intake_documents (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  intake_case_id bigint NOT NULL,
  title text COLLATE "C",
  reference text COLLATE "C",
  version_label text COLLATE "C",
  content_hash text COLLATE "C",
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TABLE rights_intake_participants (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  intake_case_id bigint NOT NULL,
  party_kind text COLLATE "C" NOT NULL CHECK (party_kind IN ('current_org', 'partner')),
  partner_id bigint,
  role text COLLATE "C",
  investment_yen bigint CHECK (investment_yen IS NULL OR investment_yen >= 0),
  explicit_share_bps bigint CHECK (explicit_share_bps IS NULL OR explicit_share_bps BETWEEN 0 AND 10000),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((party_kind = 'current_org' AND partner_id IS NULL) OR party_kind = 'partner')
);
CREATE TABLE rights_intake_scopes (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  intake_case_id bigint NOT NULL,
  channel text COLLATE "C",
  territory text COLLATE "C",
  rights_start text COLLATE "C",
  rights_end text COLLATE "C",
  exclusivity text COLLATE "C" CHECK (exclusivity IS NULL OR exclusivity IN ('exclusive', 'nonexclusive', 'unknown')),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (rights_end IS NULL OR rights_start IS NULL OR rights_end >= rights_start)
);
CREATE TABLE rights_payment_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  settlement_contract_id bigint,
  committee_snapshot_id bigint,
  partner_id bigint NOT NULL,
  amount_yen bigint NOT NULL CHECK (amount_yen > 0),
  paid_on text COLLATE "C" NOT NULL,
  reference text COLLATE "C" NOT NULL CHECK (length(trim(reference)) BETWEEN 1 AND 160),
  reverses_event_id bigint,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  CHECK ((settlement_contract_id IS NOT NULL)::int + (committee_snapshot_id IS NOT NULL)::int = 1),
  CHECK ((length(paid_on) = 10 AND ltrim(substr(paid_on, 1, 4), '0123456789') = '' AND substr(paid_on, 5, 1) = '-' AND ltrim(substr(paid_on, 6, 2), '0123456789') = '' AND substr(paid_on, 8, 1) = '-' AND ltrim(substr(paid_on, 9, 2), '0123456789') = '')),
  UNIQUE (org_id, id),
  UNIQUE (org_id, reference),
  UNIQUE (org_id, reverses_event_id)
);
CREATE TABLE sale_distribution_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  distribution_code text COLLATE "C" NOT NULL,
  territory text COLLATE "C",
  service_name text COLLATE "C",
  settlement_method text COLLATE "C" NOT NULL CHECK (settlement_method IN ('unverified', 'royalty', 'MG', 'FLAT', 'other')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, sale_id, version_no),
  UNIQUE (org_id, id)
);
CREATE TABLE sale_lines (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  report_id bigint,
  product_id bigint,
  partner_id bigint NOT NULL,
  sales_period_from text COLLATE "C" NOT NULL,
  sales_period_to text COLLATE "C" NOT NULL,
  accounting_month text COLLATE "C" NOT NULL CHECK ((length(accounting_month) = 7 AND ltrim(substr(accounting_month, 1, 4), '0123456789') = '' AND substr(accounting_month, 5, 1) = '-' AND ltrim(substr(accounting_month, 6, 2), '0123456789') = '')),
  description text COLLATE "C" NOT NULL,
  quantity bigint CHECK (quantity IS NULL OR quantity >= 0),
  amount_ex_tax bigint NOT NULL,
  tax_amount bigint NOT NULL,
  amount_inc_tax bigint NOT NULL,
  source_row bigint,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (amount_inc_tax = amount_ex_tax + tax_amount),
  CHECK (sales_period_to >= sales_period_from)
);
CREATE TABLE sales_activities (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  opportunity_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  occurred_on text COLLATE "C" NOT NULL,
  activity_type text COLLATE "C" NOT NULL CHECK (activity_type IN ('contact', 'proposal', 'negotiation', 'note')),
  summary text COLLATE "C" NOT NULL,
  next_action text COLLATE "C",
  next_due_on text COLLATE "C",
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE TABLE sales_agreement_term_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  agreement_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  source_version_id bigint,
  document_reference text COLLATE "C",
  version_label text COLLATE "C",
  channel text COLLATE "C" NOT NULL CHECK (channel IN ('digital', 'broadcast', 'theatrical', 'package', 'other')),
  territory text COLLATE "C",
  license_start text COLLATE "C",
  license_end text COLLATE "C",
  expected_amount_yen bigint CHECK (expected_amount_yen IS NULL OR expected_amount_yen >= 0),
  note text COLLATE "C",
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, agreement_id, id),
  UNIQUE (org_id, agreement_id, version_no),
  CHECK (license_end IS NULL OR license_start IS NULL OR license_end >= license_start)
);
CREATE TABLE sales_agreements (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  opportunity_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  product_id bigint,
  intake_case_id bigint,
  contract_code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  UNIQUE (org_id, contract_code)
);
CREATE TABLE sales_availability_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  distribution_code text COLLATE "C" NOT NULL,
  territory text COLLATE "C" NOT NULL CHECK (length(trim(territory)) > 0),
  version_no bigint NOT NULL CHECK (version_no > 0),
  release_on text COLLATE "C",
  sales_end_on text COLLATE "C",
  terms_text text COLLATE "C" NOT NULL,
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) > 0),
  intake_case_id bigint,
  document_id bigint,
  exclusivity text COLLATE "C" NOT NULL CHECK (exclusivity IN ('unknown', 'exclusive', 'nonexclusive')),
  status text COLLATE "C" NOT NULL CHECK (status IN ('draft', 'confirmed', 'withdrawn')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, distribution_code, territory, version_no),
  CHECK (sales_end_on IS NULL OR release_on IS NULL OR sales_end_on >= release_on),
  CHECK (status <> 'confirmed' OR (release_on IS NOT NULL AND sales_end_on IS NOT NULL AND length(trim(terms_text)) > 0))
);
CREATE TABLE sales_deliverables (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  agreement_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  title text COLLATE "C" NOT NULL,
  due_on text COLLATE "C",
  status text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'accepted', 'blocked')),
  submitted_on text COLLATE "C",
  accepted_on text COLLATE "C",
  note text COLLATE "C",
  version bigint NOT NULL DEFAULT 1,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (length(trim(title)) BETWEEN 1 AND 200),
  CHECK ((status NOT IN ('submitted', 'accepted')) OR submitted_on IS NOT NULL),
  CHECK (status <> 'accepted' OR accepted_on IS NOT NULL),
  CHECK (accepted_on IS NULL OR submitted_on IS NOT NULL),
  CHECK (accepted_on IS NULL OR accepted_on >= submitted_on)
);
CREATE TABLE sales_material_snapshots (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  opportunity_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  product_id bigint,
  version_no bigint NOT NULL CHECK (version_no > 0),
  title text COLLATE "C" NOT NULL,
  synopsis text COLLATE "C" NOT NULL,
  pitch text COLLATE "C" NOT NULL,
  terms_text text COLLATE "C" NOT NULL,
  source_json text COLLATE "C" NOT NULL,
  snapshot_hash text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, opportunity_id, version_no),
  UNIQUE (org_id, snapshot_hash),
  CHECK (length(trim(title)) BETWEEN 1 AND 200),
  CHECK (length(trim(synopsis)) BETWEEN 1 AND 5000),
  CHECK (length(trim(pitch)) BETWEEN 1 AND 5000),
  CHECK (length(trim(terms_text)) BETWEEN 1 AND 5000)
);
CREATE TABLE sales_opportunities (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  name text COLLATE "C" NOT NULL,
  stage text COLLATE "C" NOT NULL CHECK (stage IN ('lead', 'proposal', 'negotiation', 'won', 'lost')),
  expected_yen bigint CHECK (expected_yen IS NULL OR expected_yen >= 0),
  close_date text COLLATE "C",
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (org_id, id)
);
CREATE TABLE sales_report_links (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  report_id bigint NOT NULL,
  agreement_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, work_id, report_id)
);
CREATE TABLE scenes (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  scene_no text COLLATE "C" NOT NULL,
  day_night text COLLATE "C" CHECK (day_night IS NULL OR day_night IN ('D', 'N', 'DN')),
  location text COLLATE "C",
  synopsis text COLLATE "C" NOT NULL DEFAULT '',
  status text COLLATE "C" NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'shot')),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, work_id, scene_no)
);
CREATE TABLE schema_meta (
  org_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0)
);
CREATE TABLE sessions (
  id_hash text COLLATE "C" PRIMARY KEY,
  user_id bigint NOT NULL,
  org_id bigint NOT NULL,
  expires_at text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE settlement_contracts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  contract_code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  contract_type text COLLATE "C" NOT NULL CHECK (contract_type IN ('commission', 'mg', 'self_owned')),
  holder_partner_id bigint,
  mg_contract_yen bigint,
  mg_paid_yen bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  CHECK ((contract_type = 'commission' AND holder_partner_id IS NOT NULL AND mg_contract_yen IS NULL AND mg_paid_yen IS NULL) OR (contract_type = 'mg' AND holder_partner_id IS NOT NULL AND mg_contract_yen IS NOT NULL AND mg_contract_yen >= 0 AND (mg_paid_yen IS NULL OR (mg_paid_yen >= 0 AND mg_paid_yen <= mg_contract_yen))) OR (contract_type = 'self_owned' AND holder_partner_id IS NULL AND mg_contract_yen IS NULL AND mg_paid_yen IS NULL)),
  UNIQUE (org_id, id),
  UNIQUE (org_id, id, work_id),
  UNIQUE (org_id, contract_code)
);
CREATE TABLE settlement_report_links (
  org_id bigint NOT NULL,
  report_id bigint NOT NULL,
  work_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  report_basis text COLLATE "C" NOT NULL CHECK (report_basis IN ('gross', 'net')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, report_id, work_id)
);
CREATE TABLE settlement_term_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  contract_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  platform_rate_bps bigint NOT NULL CHECK (platform_rate_bps BETWEEN 0 AND 10000),
  agency_fee_bps bigint CHECK (agency_fee_bps IS NULL OR agency_fee_bps BETWEEN 0 AND 10000),
  recoup_basis text COLLATE "C" CHECK (recoup_basis IS NULL OR recoup_basis IN ('platform_net', 'after_fee')),
  overage_enabled bigint CHECK (overage_enabled IS NULL OR overage_enabled IN (0, 1)),
  overage_rate_bps bigint CHECK (overage_rate_bps IS NULL OR overage_rate_bps BETWEEN 0 AND 10000),
  note text COLLATE "C",
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  CHECK ((overage_enabled IS NULL AND overage_rate_bps IS NULL) OR (overage_enabled = 0 AND overage_rate_bps IS NULL) OR (overage_enabled = 1 AND overage_rate_bps IS NOT NULL)),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contract_id, id),
  UNIQUE (org_id, contract_id, version_no)
);
CREATE TABLE shooting_days (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  shoot_date text COLLATE "C" NOT NULL,
  unit text COLLATE "C" NOT NULL,
  label text COLLATE "C" NOT NULL,
  notes text COLLATE "C",
  version bigint NOT NULL DEFAULT 1,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  UNIQUE (org_id, work_id, shoot_date, unit),
  CHECK (length(trim(unit)) BETWEEN 1 AND 80),
  CHECK (length(trim(label)) BETWEEN 1 AND 160)
);
CREATE TABLE tax_calculation_lines (
  org_id bigint NOT NULL,
  snapshot_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  report_id bigint NOT NULL,
  voucher_id text COLLATE "C" NOT NULL,
  category text COLLATE "C" NOT NULL CHECK (category IN ('standard', 'reduced', 'zero', 'exempt', 'non_taxable')),
  rate_bps bigint NOT NULL CHECK (rate_bps IN (0, 800, 1000)),
  amount_ex_tax bigint NOT NULL,
  source_tax bigint NOT NULL,
  amount_inc_tax bigint NOT NULL,
  exact_numerator text COLLATE "C" NOT NULL,
  exact_denominator text COLLATE "C" NOT NULL,
  reference_tax_scaled bigint NOT NULL,
  reference_precision bigint NOT NULL CHECK (reference_precision BETWEEN 0 AND 4),
  PRIMARY KEY (org_id, snapshot_id, sale_id),
  CHECK ((category = 'standard' AND rate_bps = 1000) OR (category = 'reduced' AND rate_bps = 800) OR (category IN ('zero', 'exempt', 'non_taxable') AND rate_bps = 0))
);
CREATE TABLE tax_calculation_snapshots (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  invoice_id bigint,
  preview_hash text COLLATE "C" NOT NULL,
  rule_version_id bigint NOT NULL,
  invoice_date text COLLATE "C" NOT NULL,
  source_period_from text COLLATE "C" NOT NULL,
  source_period_to text COLLATE "C" NOT NULL,
  calculation_json text COLLATE "C" NOT NULL,
  amount_ex_tax bigint NOT NULL,
  source_tax bigint NOT NULL,
  billed_tax bigint NOT NULL,
  delta bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, invoice_id),
  CHECK (delta = billed_tax - source_tax),
  CHECK (source_period_to >= source_period_from)
);
CREATE TABLE tax_invoice_links (
  org_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  prior_invoice_id bigint NOT NULL,
  reason text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, invoice_id),
  CHECK (invoice_id <> prior_invoice_id),
  CHECK (length(trim(reason)) BETWEEN 1 AND 1000)
);
CREATE TABLE tax_invoice_rate_totals (
  org_id bigint NOT NULL,
  snapshot_id bigint NOT NULL,
  category text COLLATE "C" NOT NULL CHECK (category IN ('standard', 'reduced', 'zero', 'exempt', 'non_taxable')),
  rate_bps bigint NOT NULL CHECK (rate_bps IN (0, 800, 1000)),
  amount_ex_tax bigint NOT NULL,
  exact_numerator text COLLATE "C" NOT NULL,
  exact_denominator text COLLATE "C" NOT NULL,
  billed_tax bigint NOT NULL,
  source_tax bigint NOT NULL,
  delta bigint NOT NULL,
  PRIMARY KEY (org_id, snapshot_id, category, rate_bps),
  CHECK (delta = billed_tax - source_tax)
);
CREATE TABLE tax_rule_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  scope_type text COLLATE "C" NOT NULL CHECK (scope_type IN ('default', 'partner')),
  partner_id bigint,
  version bigint NOT NULL CHECK (version > 0),
  base_version bigint NOT NULL CHECK (base_version >= 0),
  effective_from text COLLATE "C" NOT NULL,
  effective_to text COLLATE "C",
  basis text COLLATE "C" NOT NULL CHECK (basis IN ('exclusive', 'inclusive')),
  grouping_mode text COLLATE "C" NOT NULL CHECK (grouping_mode IN ('invoice', 'voucher')),
  rounding_mode text COLLATE "C" NOT NULL CHECK (rounding_mode IN ('truncate', 'half_up', 'ceil')),
  precision bigint NOT NULL CHECK (precision BETWEEN 0 AND 4),
  reason text COLLATE "C" NOT NULL,
  evidence text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, scope_type, partner_id, version),
  CHECK ((scope_type = 'default' AND partner_id IS NULL) OR (scope_type = 'partner' AND partner_id IS NOT NULL)),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  CHECK (length(trim(evidence)) BETWEEN 1 AND 4000)
);
CREATE TABLE theatrical_sale_details (
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  model text COLLATE "C" NOT NULL CHECK (model IN ('theatrical_rs', 'theatrical_flat', 'non_theatrical_rs', 'non_theatrical_flat')),
  ticket_type_code text COLLATE "C",
  purchase_channel text COLLATE "C",
  admissions_count bigint CHECK (admissions_count IS NULL OR admissions_count >= 0),
  gross_box_office_ex_tax text COLLATE "C",
  reported_actual_ex_tax text COLLATE "C",
  reported_recognized_ex_tax text COLLATE "C",
  calculated_actual_ex_tax text COLLATE "C",
  PRIMARY KEY (org_id, sale_id)
);
CREATE TABLE transaction_guards (
  value bigint NOT NULL CHECK (value = 1)
);
CREATE TABLE users (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  email text COLLATE "C" NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text COLLATE "C" NOT NULL
);
CREATE TABLE workbench_analysis_snapshots (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  dataset text COLLATE "C" NOT NULL,
  change_set_id text COLLATE "C",
  source_boundary_json text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  row_count bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE workbench_applications (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  change_set_id text COLLATE "C" NOT NULL,
  idempotency_key text COLLATE "C" NOT NULL,
  result_json text COLLATE "C" NOT NULL,
  applied_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, idempotency_key),
  UNIQUE (org_id, change_set_id)
);
CREATE TABLE workbench_change_sets (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  draft_id text COLLATE "C" NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  draft_revision bigint NOT NULL,
  validation_id text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  reason text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  submitted_by bigint NOT NULL,
  approved_by bigint,
  approved_at text COLLATE "C",
  applied_at text COLLATE "C",
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE workbench_drafts (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  dataset text COLLATE "C" NOT NULL,
  project_id bigint,
  work_id bigint,
  revision bigint NOT NULL DEFAULT 1,
  status text COLLATE "C" NOT NULL DEFAULT 'draft',
  source_snapshot_id text COLLATE "C",
  source_artifact_id text COLLATE "C",
  rows_json text COLLATE "C" NOT NULL,
  steps_json text COLLATE "C" NOT NULL DEFAULT '[]',
  lookup_refs_json text COLLATE "C" NOT NULL DEFAULT '[]',
  recipe_version_id text COLLATE "C",
  updated_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE workbench_lineage (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  run_type text COLLATE "C" NOT NULL,
  source_id text COLLATE "C",
  engine_version text COLLATE "C" NOT NULL,
  input_hash text COLLATE "C" NOT NULL,
  result_hash text COLLATE "C" NOT NULL,
  detail_json text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE workbench_recipe_versions (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  recipe_id text COLLATE "C" NOT NULL,
  version_no bigint NOT NULL,
  steps_json text COLLATE "C" NOT NULL,
  lookup_refs_json text COLLATE "C" NOT NULL DEFAULT '[]',
  steps_hash text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, recipe_id, version_no)
);
CREATE TABLE workbench_recipes (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  dataset text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE workbench_snapshots (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  dataset text COLLATE "C" NOT NULL,
  scope_json text COLLATE "C" NOT NULL,
  rows_json text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE workbench_source_artifacts (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  name text COLLATE "C" NOT NULL,
  media_type text COLLATE "C" NOT NULL,
  raw_base64 text COLLATE "C" NOT NULL,
  source_hash text COLLATE "C" NOT NULL,
  byte_length bigint NOT NULL,
  extraction_json text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, source_hash)
);
CREATE TABLE workbench_validations (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  draft_id text COLLATE "C" NOT NULL,
  draft_revision bigint NOT NULL,
  input_hash text COLLATE "C" NOT NULL,
  result_hash text COLLATE "C" NOT NULL,
  result_json text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE workflow_raw_artifacts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('script', 'sales_report')),
  file_name text COLLATE "C" NOT NULL,
  media_type text COLLATE "C",
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  raw_sha256 text COLLATE "C" NOT NULL,
  original_base64 text COLLATE "C" NOT NULL,
  extractor_name text COLLATE "C" NOT NULL,
  extractor_version text COLLATE "C" NOT NULL,
  extraction_json text COLLATE "C" NOT NULL,
  extraction_status text COLLATE "C" NOT NULL CHECK (extraction_status IN ('extracted', 'ocr_pending')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  UNIQUE (org_id, kind, raw_sha256)
);
CREATE TABLE workflow_report_commits (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  artifact_id bigint NOT NULL,
  selection_id bigint NOT NULL,
  mapping_version_id bigint NOT NULL,
  report_id bigint NOT NULL,
  preview_token text COLLATE "C" NOT NULL,
  committed_by bigint NOT NULL,
  committed_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, artifact_id),
  UNIQUE (org_id, report_id),
  UNIQUE (preview_token)
);
CREATE TABLE workflow_report_selections (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  artifact_id bigint NOT NULL,
  work_id bigint NOT NULL,
  version_no bigint NOT NULL,
  sheet_name text COLLATE "C" NOT NULL,
  header_row bigint NOT NULL CHECK (header_row > 0),
  canonical_csv text COLLATE "C" NOT NULL,
  canonical_sha256 text COLLATE "C" NOT NULL,
  source_rows_json text COLLATE "C" NOT NULL DEFAULT '[]',
  suggestions_json text COLLATE "C" NOT NULL,
  suggestion_source text COLLATE "C" NOT NULL CHECK (suggestion_source IN ('rule-based', 'imported-ai', 'configured-ai')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  UNIQUE (org_id, artifact_id, version_no)
);
CREATE TABLE workflow_schedule_previews (
  token text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  artifact_id bigint NOT NULL,
  review_id bigint NOT NULL,
  work_id bigint NOT NULL,
  user_id bigint NOT NULL,
  input_json text COLLATE "C" NOT NULL,
  input_hash text COLLATE "C" NOT NULL,
  proposal_json text COLLATE "C" NOT NULL,
  proposal_hash text COLLATE "C" NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  expires_at text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE workflow_script_commit_days (
  org_id bigint NOT NULL,
  commit_id bigint NOT NULL,
  work_id bigint NOT NULL,
  shooting_day_id bigint NOT NULL,
  proposal_index bigint NOT NULL,
  PRIMARY KEY (org_id, commit_id, shooting_day_id),
  UNIQUE (org_id, commit_id, proposal_index)
);
CREATE TABLE workflow_script_commit_scenes (
  org_id bigint NOT NULL,
  commit_id bigint NOT NULL,
  work_id bigint NOT NULL,
  scene_id bigint NOT NULL,
  source_index bigint NOT NULL,
  PRIMARY KEY (org_id, commit_id, scene_id),
  UNIQUE (org_id, commit_id, source_index)
);
CREATE TABLE workflow_script_commits (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  artifact_id bigint NOT NULL,
  review_id bigint NOT NULL,
  work_id bigint NOT NULL,
  preview_token text COLLATE "C" NOT NULL,
  proposal_hash text COLLATE "C" NOT NULL,
  committed_by bigint NOT NULL,
  committed_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, artifact_id),
  UNIQUE (preview_token)
);
CREATE TABLE workflow_script_reviews (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  artifact_id bigint NOT NULL,
  work_id bigint NOT NULL,
  version_no bigint NOT NULL,
  scenes_json text COLLATE "C" NOT NULL,
  review_hash text COLLATE "C" NOT NULL,
  reviewed_by bigint NOT NULL,
  reviewed_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  UNIQUE (org_id, artifact_id, version_no),
  UNIQUE (org_id, artifact_id, review_hash)
);
CREATE TABLE works (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL,
  title text COLLATE "C" NOT NULL,
  format text COLLATE "C" NOT NULL DEFAULT 'film',
  forecast_yen bigint CHECK (forecast_yen IS NULL OR forecast_yen >= 0),
  version bigint NOT NULL DEFAULT 1,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, project_id, id),
  UNIQUE (org_id, code)
);
CREATE INDEX billing_claim_invoice_idx ON billing_sale_claims (org_id, invoice_id);
CREATE INDEX billing_invoice_partner_due_idx ON billing_invoices (org_id, partner_id, due_date);
CREATE INDEX billing_line_work_idx ON billing_invoice_line_works (org_id, work_id, invoice_id);
CREATE INDEX billing_receipt_invoice_idx ON billing_receipt_allocations (org_id, invoice_id, receipt_id);
CREATE INDEX broadcast_slot_month ON broadcast_slot_versions (org_id, work_id, broadcast_month, station_name);
CREATE UNIQUE INDEX observation_report_row_uidx ON observations (org_id, report_id, source_row) WHERE report_id IS NOT NULL;
CREATE UNIQUE INDEX opportunities_org_scope_id_uidx ON sales_opportunities (org_id, project_id, work_id, partner_id, id);
CREATE UNIQUE INDEX report_active_key_uidx ON report_imports (org_id, work_id, report_key) WHERE status = 'active';
CREATE UNIQUE INDEX rights_intake_documents_case_uidx ON rights_intake_documents (org_id, intake_case_id, id);
CREATE UNIQUE INDEX sale_report_row_uidx ON sale_lines (org_id, report_id, source_row) WHERE report_id IS NOT NULL;
CREATE INDEX sales_material_work_idx ON sales_material_snapshots (org_id, work_id, created_at);
CREATE UNIQUE INDEX scenes_org_work_id_uidx ON scenes (org_id, work_id, id);
CREATE UNIQUE INDEX tax_rule_scope_start_uq ON tax_rule_versions (org_id, scope_type, (coalesce(partner_id, 0)), effective_from);
CREATE UNIQUE INDEX tax_rule_scope_version_uq ON tax_rule_versions (org_id, scope_type, (coalesce(partner_id, 0)), version);
CREATE INDEX tax_rules_resolve_idx ON tax_rule_versions (org_id, scope_type, partner_id, effective_from, effective_to, version);
CREATE INDEX tax_snapshot_month_idx ON tax_calculation_snapshots (org_id, invoice_date, invoice_id);
CREATE FUNCTION availability_document_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.document_id IS NOT NULL) IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NOT EXISTS (SELECT 1 FROM rights_intake_documents d WHERE d.org_id = NEW.org_id AND d.id = NEW.document_id AND d.intake_case_id = NEW.intake_case_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'document case mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER availability_document_scope BEFORE INSERT ON sales_availability_versions FOR EACH ROW EXECUTE FUNCTION availability_document_scope_fn();
CREATE TRIGGER availability_no_delete BEFORE DELETE ON sales_availability_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('availability version immutable');
CREATE TRIGGER availability_no_update BEFORE UPDATE ON sales_availability_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('availability version immutable');
CREATE FUNCTION billed_report_locked_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id = s.org_id AND c.sale_id = s.id WHERE s.org_id = OLD.org_id AND s.report_id = OLD.id)) IS NOT TRUE THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report with billed sales is locked';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER billed_report_locked_delete BEFORE DELETE ON report_imports FOR EACH ROW EXECUTE FUNCTION billed_report_locked_delete_fn();
CREATE FUNCTION billed_report_locked_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id = s.org_id AND c.sale_id = s.id WHERE s.org_id = OLD.org_id AND s.report_id = OLD.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report with billed sales is locked';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billed_report_locked_update BEFORE UPDATE ON report_imports FOR EACH ROW EXECUTE FUNCTION billed_report_locked_update_fn();
CREATE FUNCTION billed_report_no_gross_committee_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.report_basis = 'gross' AND EXISTS (SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id = s.org_id AND c.sale_id = s.id WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'billed report cannot become gross basis';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billed_report_no_gross_committee BEFORE INSERT ON committee_snapshot_reports FOR EACH ROW EXECUTE FUNCTION billed_report_no_gross_committee_fn();
CREATE FUNCTION billed_report_no_gross_settlement_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.report_basis = 'gross' AND EXISTS (SELECT 1 FROM sale_lines s JOIN billing_sale_claims c ON c.org_id = s.org_id AND c.sale_id = s.id WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'billed report cannot become gross basis';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billed_report_no_gross_settlement BEFORE INSERT ON settlement_report_links FOR EACH ROW EXECUTE FUNCTION billed_report_no_gross_settlement_fn();
CREATE FUNCTION billed_sale_locked_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM billing_sale_claims c WHERE c.org_id = OLD.org_id AND c.sale_id = OLD.id)) IS NOT TRUE THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'billed sale line is locked';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER billed_sale_locked_delete BEFORE DELETE ON sale_lines FOR EACH ROW EXECUTE FUNCTION billed_sale_locked_delete_fn();
CREATE FUNCTION billed_sale_locked_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM billing_sale_claims c WHERE c.org_id = OLD.org_id AND c.sale_id = OLD.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'billed sale line is locked';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billed_sale_locked_update BEFORE UPDATE ON sale_lines FOR EACH ROW EXECUTE FUNCTION billed_sale_locked_update_fn();
CREATE FUNCTION billing_claim_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM billing_invoices i WHERE i.org_id = OLD.org_id AND i.id = OLD.invoice_id AND i.status = 'void')) IS NOT TRUE THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'active invoice claims cannot be released';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER billing_claim_delete BEFORE DELETE ON billing_sale_claims FOR EACH ROW EXECUTE FUNCTION billing_claim_delete_fn();
CREATE TRIGGER billing_claim_update BEFORE UPDATE ON billing_sale_claims FOR EACH ROW EXECUTE FUNCTION lite_reject_change('invoice claims cannot be changed');
CREATE FUNCTION billing_claim_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM billing_invoices i WHERE i.org_id = NEW.org_id AND i.id = NEW.invoice_id AND i.status = 'issued' AND i.source_amount_basis = 'platform_net')) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice claim requires an issued platform-net invoice';
  END IF;
  IF (EXISTS (SELECT 1 FROM billing_invoice_lines l WHERE l.org_id = NEW.org_id AND l.invoice_id = NEW.invoice_id AND l.sale_id = NEW.sale_id AND (EXISTS (SELECT 1 FROM settlement_report_links s WHERE s.org_id = l.org_id AND s.report_id = l.report_id AND s.report_basis = 'gross') OR EXISTS (SELECT 1 FROM committee_snapshot_reports s WHERE s.org_id = l.org_id AND s.report_id = l.report_id AND s.report_basis = 'gross')))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'gross report amount cannot be invoiced directly';
  END IF;
  IF (10000 <> (SELECT COALESCE(SUM(allocation_bps), 0) FROM billing_invoice_line_works w WHERE w.org_id = NEW.org_id AND w.invoice_id = NEW.invoice_id AND w.sale_id = NEW.sale_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice work allocation must total 100 percent';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billing_claim_validate BEFORE INSERT ON billing_sale_claims FOR EACH ROW EXECUTE FUNCTION billing_claim_validate_fn();
CREATE TRIGGER billing_invoice_line_immutable BEFORE UPDATE ON billing_invoice_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('invoice lines are immutable');
CREATE TRIGGER billing_invoice_line_no_delete BEFORE DELETE ON billing_invoice_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('invoice lines are immutable');
CREATE FUNCTION billing_invoice_line_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id = s.org_id AND r.id = s.report_id JOIN billing_invoices i ON i.org_id = s.org_id AND i.id = NEW.invoice_id WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id AND s.report_id = NEW.report_id AND s.project_id = NEW.project_id AND s.work_id = NEW.work_id AND s.partner_id = NEW.partner_id AND s.partner_id = i.partner_id AND s.product_id IS NOT DISTINCT FROM NEW.product_id AND s.description = NEW.description AND s.accounting_month = NEW.accounting_month AND s.source_row IS NOT DISTINCT FROM NEW.source_row AND s.amount_ex_tax = NEW.amount_ex_tax AND s.tax_amount = NEW.tax_amount AND s.amount_inc_tax = NEW.amount_inc_tax AND r.status = 'active')) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice line must snapshot an active original sale exactly';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billing_invoice_line_validate BEFORE INSERT ON billing_invoice_lines FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_validate_fn();
CREATE TRIGGER billing_invoice_no_delete BEFORE DELETE ON billing_invoices FOR EACH ROW EXECUTE FUNCTION lite_reject_change('invoice snapshots are immutable');
CREATE FUNCTION billing_invoice_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.org_id <> OLD.org_id OR NEW.invoice_number <> OLD.invoice_number OR NEW.partner_id <> OLD.partner_id OR NEW.invoice_date <> OLD.invoice_date OR NEW.due_date <> OLD.due_date OR NEW.source_amount_basis <> OLD.source_amount_basis OR NEW.amount_ex_tax <> OLD.amount_ex_tax OR NEW.tax_amount <> OLD.tax_amount OR NEW.amount_inc_tax <> OLD.amount_inc_tax OR NEW.note IS DISTINCT FROM OLD.note OR NEW.snapshot_json <> OLD.snapshot_json OR NEW.snapshot_hash <> OLD.snapshot_hash OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice snapshot is immutable';
  END IF;
  IF (OLD.status = 'void' OR NEW.status <> 'void' OR NEW.version <> OLD.version + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice can only transition once to void';
  END IF;
  IF (EXISTS (SELECT 1 FROM billing_receipt_allocations a LEFT JOIN billing_receipt_reversals x ON x.org_id = a.org_id AND x.receipt_id = a.receipt_id WHERE a.org_id = OLD.org_id AND a.invoice_id = OLD.id AND x.receipt_id IS NULL)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice with effective receipts cannot be voided';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billing_invoice_update BEFORE UPDATE ON billing_invoices FOR EACH ROW EXECUTE FUNCTION billing_invoice_update_fn();
CREATE TRIGGER billing_invoice_void_immutable BEFORE UPDATE ON billing_invoice_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('invoice void event is immutable');
CREATE TRIGGER billing_invoice_void_no_delete BEFORE DELETE ON billing_invoice_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('invoice void event is immutable');
CREATE FUNCTION billing_invoice_void_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM billing_invoices i WHERE i.org_id = NEW.org_id AND i.id = NEW.invoice_id AND i.status = 'void' AND NEW.voided_on >= i.invoice_date)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice void date or state is invalid';
  END IF;
  IF (EXISTS (SELECT 1 FROM billing_receipt_allocations a LEFT JOIN billing_receipt_reversals x ON x.org_id = a.org_id AND x.receipt_id = a.receipt_id WHERE a.org_id = NEW.org_id AND a.invoice_id = NEW.invoice_id AND (x.receipt_id IS NULL OR x.reversed_on > NEW.voided_on))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice has a receipt effective on the void date';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billing_invoice_void_validate BEFORE INSERT ON billing_invoice_voids FOR EACH ROW EXECUTE FUNCTION billing_invoice_void_validate_fn();
CREATE TRIGGER billing_line_work_immutable BEFORE UPDATE ON billing_invoice_line_works FOR EACH ROW EXECUTE FUNCTION lite_reject_change('invoice allocation snapshots are immutable');
CREATE TRIGGER billing_line_work_no_delete BEFORE DELETE ON billing_invoice_line_works FOR EACH ROW EXECUTE FUNCTION lite_reject_change('invoice allocation snapshots are immutable');
CREATE FUNCTION billing_line_work_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM billing_invoice_lines l JOIN sale_lines s ON s.org_id = l.org_id AND s.id = l.sale_id WHERE l.org_id = NEW.org_id AND l.invoice_id = NEW.invoice_id AND l.sale_id = NEW.sale_id AND ((s.product_id IS NULL AND NEW.work_id = s.work_id AND NEW.allocation_bps = 10000) OR (s.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_works pw WHERE pw.org_id = s.org_id AND pw.product_id = s.product_id AND pw.work_id = NEW.work_id AND pw.allocation_bps = NEW.allocation_bps))))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice work allocation must match the original sale allocation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billing_line_work_validate BEFORE INSERT ON billing_invoice_line_works FOR EACH ROW EXECUTE FUNCTION billing_line_work_validate_fn();
CREATE FUNCTION billing_receipt_allocation_complete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT COUNT(*) FROM billing_receipt_allocations a WHERE a.org_id = NEW.org_id AND a.receipt_id = NEW.receipt_id) = (SELECT allocation_count FROM billing_receipts r WHERE r.org_id = NEW.org_id AND r.id = NEW.receipt_id)) IS NOT TRUE THEN RETURN NULL; END IF;
  IF ((SELECT SUM(a.amount_yen) FROM billing_receipt_allocations a WHERE a.org_id = NEW.org_id AND a.receipt_id = NEW.receipt_id) <> (SELECT amount_yen FROM billing_receipts r WHERE r.org_id = NEW.org_id AND r.id = NEW.receipt_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'receipt allocations must equal receipt amount';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER billing_receipt_allocation_complete AFTER INSERT ON billing_receipt_allocations FOR EACH ROW EXECUTE FUNCTION billing_receipt_allocation_complete_fn();
CREATE TRIGGER billing_receipt_allocation_immutable BEFORE UPDATE ON billing_receipt_allocations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('receipt allocations are immutable');
CREATE TRIGGER billing_receipt_allocation_no_delete BEFORE DELETE ON billing_receipt_allocations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('receipt allocations are immutable');
CREATE FUNCTION billing_receipt_allocation_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM billing_receipts r JOIN billing_invoices i ON i.org_id = r.org_id AND i.id = NEW.invoice_id WHERE r.org_id = NEW.org_id AND r.id = NEW.receipt_id AND i.partner_id = r.partner_id AND i.status = 'issued' AND i.invoice_date <= r.received_on)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'receipt allocation invoice scope mismatch';
  END IF;
  IF ((SELECT COUNT(*) FROM billing_receipt_allocations a WHERE a.org_id = NEW.org_id AND a.receipt_id = NEW.receipt_id) >= (SELECT allocation_count FROM billing_receipts r WHERE r.org_id = NEW.org_id AND r.id = NEW.receipt_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'too many receipt allocations';
  END IF;
  IF (COALESCE((SELECT SUM(a.amount_yen) FROM billing_receipt_allocations a LEFT JOIN billing_receipt_reversals x ON x.org_id = a.org_id AND x.receipt_id = a.receipt_id AND x.reversed_on <= (SELECT received_on FROM billing_receipts WHERE org_id = NEW.org_id AND id = NEW.receipt_id) WHERE a.org_id = NEW.org_id AND a.invoice_id = NEW.invoice_id AND x.receipt_id IS NULL), 0) + NEW.amount_yen > (SELECT amount_inc_tax FROM billing_invoices i WHERE i.org_id = NEW.org_id AND i.id = NEW.invoice_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'receipt exceeds invoice balance';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billing_receipt_allocation_validate BEFORE INSERT ON billing_receipt_allocations FOR EACH ROW EXECUTE FUNCTION billing_receipt_allocation_validate_fn();
CREATE TRIGGER billing_receipt_immutable BEFORE UPDATE ON billing_receipts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('receipt events are immutable');
CREATE TRIGGER billing_receipt_no_delete BEFORE DELETE ON billing_receipts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('receipt events are immutable');
CREATE TRIGGER billing_receipt_reversal_immutable BEFORE UPDATE ON billing_receipt_reversals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('receipt reversal event is immutable');
CREATE TRIGGER billing_receipt_reversal_no_delete BEFORE DELETE ON billing_receipt_reversals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('receipt reversal event is immutable');
CREATE FUNCTION billing_receipt_reversal_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM billing_receipts r WHERE r.org_id = NEW.org_id AND r.id = NEW.receipt_id AND NEW.reversed_on >= r.received_on)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'receipt reversal date is invalid';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER billing_receipt_reversal_validate BEFORE INSERT ON billing_receipt_reversals FOR EACH ROW EXECUTE FUNCTION billing_receipt_reversal_validate_fn();
CREATE TRIGGER broadcast_airing_no_delete BEFORE DELETE ON broadcast_airings FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast airing immutable');
CREATE TRIGGER broadcast_airing_no_update BEFORE UPDATE ON broadcast_airings FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast airing immutable');
CREATE TRIGGER broadcast_availability_rate_no_delete BEFORE DELETE ON broadcast_availability_rates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('availability rate version immutable');
CREATE TRIGGER broadcast_availability_rate_no_update BEFORE UPDATE ON broadcast_availability_rates FOR EACH ROW EXECUTE FUNCTION lite_reject_change('availability rate version immutable');
CREATE TRIGGER broadcast_sale_link_no_update BEFORE UPDATE ON broadcast_sale_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast sale link immutable');
CREATE FUNCTION broadcast_sale_link_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id AND s.work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'broadcast sale work mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER broadcast_sale_link_scope BEFORE INSERT ON broadcast_sale_links FOR EACH ROW EXECUTE FUNCTION broadcast_sale_link_scope_fn();
CREATE TRIGGER broadcast_version_no_delete BEFORE DELETE ON broadcast_slot_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast version immutable');
CREATE TRIGGER broadcast_version_no_update BEFORE UPDATE ON broadcast_slot_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast version immutable');
CREATE TRIGGER catalog_credits_immutable_delete BEFORE DELETE ON catalog_credits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_credits_immutable_update BEFORE UPDATE ON catalog_credits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_edition_tags_immutable_delete BEFORE DELETE ON catalog_edition_tags FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_edition_tags_immutable_update BEFORE UPDATE ON catalog_edition_tags FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_editions_immutable_delete BEFORE DELETE ON catalog_editions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_editions_immutable_update BEFORE UPDATE ON catalog_editions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_product_editions_immutable_delete BEFORE DELETE ON catalog_product_editions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_product_editions_immutable_update BEFORE UPDATE ON catalog_product_editions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_product_windows_immutable_delete BEFORE DELETE ON catalog_product_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_product_windows_immutable_update BEFORE UPDATE ON catalog_product_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_profiles_immutable_delete BEFORE DELETE ON catalog_profiles FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE TRIGGER catalog_profiles_immutable_update BEFORE UPDATE ON catalog_profiles FOR EACH ROW EXECUTE FUNCTION lite_reject_change('catalog version immutable');
CREATE FUNCTION channel_report_kind_locked_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM package_report_observations o WHERE o.org_id = OLD.org_id AND o.report_id = OLD.id) OR EXISTS (SELECT 1 FROM sale_lines s JOIN theatrical_sale_details d ON d.org_id = s.org_id AND d.sale_id = s.id WHERE s.org_id = OLD.org_id AND s.report_id = OLD.id) OR EXISTS (SELECT 1 FROM sale_lines s JOIN package_sale_details d ON d.org_id = s.org_id AND d.sale_id = s.id WHERE s.org_id = OLD.org_id AND s.report_id = OLD.id) OR EXISTS (SELECT 1 FROM sale_lines s JOIN digital_sale_details d ON d.org_id = s.org_id AND d.sale_id = s.id WHERE s.org_id = OLD.org_id AND s.report_id = OLD.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'channel report kind is immutable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER channel_report_kind_locked BEFORE UPDATE OF kind ON report_imports FOR EACH ROW EXECUTE FUNCTION channel_report_kind_locked_fn();
CREATE FUNCTION channel_sale_parent_locked_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id = OLD.org_id AND d.sale_id = OLD.id) OR EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id = OLD.org_id AND d.sale_id = OLD.id) OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id = OLD.org_id AND d.sale_id = OLD.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'channel detail parent is immutable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER channel_sale_parent_locked BEFORE UPDATE OF org_id, report_id ON sale_lines FOR EACH ROW EXECUTE FUNCTION channel_sale_parent_locked_fn();
CREATE TRIGGER committee_contract_immutable BEFORE UPDATE ON committee_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee contract is immutable');
CREATE TRIGGER committee_deduction_immutable BEFORE UPDATE ON committee_snapshot_deductions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee deductions are immutable');
CREATE TRIGGER committee_deduction_no_delete BEFORE DELETE ON committee_snapshot_deductions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee deductions are immutable');
CREATE FUNCTION committee_deduction_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM committee_snapshot_reports r WHERE r.org_id = NEW.org_id AND r.snapshot_id = NEW.snapshot_id AND r.work_id = NEW.work_id AND r.report_id = NEW.report_id AND r.window_id = NEW.window_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee deduction report scope mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_deduction_scope BEFORE INSERT ON committee_snapshot_deductions FOR EACH ROW EXECUTE FUNCTION committee_deduction_scope_fn();
CREATE TRIGGER committee_funding_immutable BEFORE UPDATE ON committee_term_funding FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee funding is immutable');
CREATE TRIGGER committee_funding_no_delete BEFORE DELETE ON committee_term_funding FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee funding is immutable');
CREATE TRIGGER committee_investment_immutable BEFORE UPDATE ON committee_term_investments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee investment is immutable');
CREATE TRIGGER committee_investment_no_delete BEFORE DELETE ON committee_term_investments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee investment is immutable');
CREATE TRIGGER committee_member_immutable BEFORE UPDATE ON committee_term_members FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee terms are immutable');
CREATE TRIGGER committee_phase_immutable BEFORE UPDATE ON committee_schedule_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee terms are immutable');
CREATE TRIGGER committee_snapshot_expense_immutable BEFORE UPDATE ON committee_snapshot_expenses FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee report snapshot is immutable');
CREATE FUNCTION committee_snapshot_expense_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id = s.org_id AND w.term_version_id = s.term_version_id JOIN expenses e ON e.org_id = s.org_id AND e.id = NEW.expense_id AND e.work_id = s.work_id WHERE s.org_id = NEW.org_id AND s.id = NEW.snapshot_id AND s.work_id = NEW.work_id AND w.id = NEW.window_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee expense scope mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_snapshot_expense_scope BEFORE INSERT ON committee_snapshot_expenses FOR EACH ROW EXECUTE FUNCTION committee_snapshot_expense_scope_fn();
CREATE TRIGGER committee_snapshot_immutable BEFORE UPDATE ON committee_report_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee report snapshot is immutable');
CREATE TRIGGER committee_snapshot_line_immutable BEFORE UPDATE ON committee_snapshot_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee report snapshot is immutable');
CREATE FUNCTION committee_snapshot_line_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id = s.org_id AND w.term_version_id = s.term_version_id JOIN sale_lines sl ON sl.org_id = s.org_id AND sl.id = NEW.sale_id AND sl.report_id = NEW.report_id WHERE s.org_id = NEW.org_id AND s.id = NEW.snapshot_id AND s.work_id = NEW.work_id AND w.id = NEW.window_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee sale line scope mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_snapshot_line_scope BEFORE INSERT ON committee_snapshot_lines FOR EACH ROW EXECUTE FUNCTION committee_snapshot_line_scope_fn();
CREATE TRIGGER committee_snapshot_member_immutable BEFORE UPDATE ON committee_snapshot_member_amounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee report snapshot is immutable');
CREATE FUNCTION committee_snapshot_member_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id = s.org_id AND w.term_version_id = s.term_version_id WHERE s.org_id = NEW.org_id AND s.id = NEW.snapshot_id AND w.id = NEW.window_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee member window scope mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_snapshot_member_scope BEFORE INSERT ON committee_snapshot_member_amounts FOR EACH ROW EXECUTE FUNCTION committee_snapshot_member_scope_fn();
CREATE TRIGGER committee_snapshot_report_immutable BEFORE UPDATE ON committee_snapshot_reports FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee report snapshot is immutable');
CREATE FUNCTION committee_snapshot_report_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM committee_report_snapshots s JOIN committee_term_windows w ON w.org_id = s.org_id AND w.term_version_id = s.term_version_id WHERE s.org_id = NEW.org_id AND s.id = NEW.snapshot_id AND s.work_id = NEW.work_id AND w.id = NEW.window_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee report window scope mismatch';
  END IF;
  IF (EXISTS (SELECT 1 FROM settlement_report_links r WHERE r.org_id = NEW.org_id AND r.work_id = NEW.work_id AND r.report_id = NEW.report_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report already used by individual settlement';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_snapshot_report_scope BEFORE INSERT ON committee_snapshot_reports FOR EACH ROW EXECUTE FUNCTION committee_snapshot_report_scope_fn();
CREATE TRIGGER committee_term_immutable BEFORE UPDATE ON committee_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee terms are immutable');
CREATE TRIGGER committee_window_immutable BEFORE UPDATE ON committee_term_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('committee terms are immutable');
CREATE TRIGGER digital_detail_immutable_delete BEFORE DELETE ON digital_sale_details FOR EACH ROW EXECUTE FUNCTION lite_reject_change('channel detail is immutable');
CREATE TRIGGER digital_detail_immutable_update BEFORE UPDATE ON digital_sale_details FOR EACH ROW EXECUTE FUNCTION lite_reject_change('channel detail is immutable');
CREATE FUNCTION digital_detail_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id = s.org_id AND r.id = s.report_id WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id AND r.kind = 'digital')) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'digital detail requires digital report sale';
  END IF;
  IF (EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id = NEW.org_id AND d.sale_id = NEW.sale_id) OR EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id = NEW.org_id AND d.sale_id = NEW.sale_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale already has another channel detail';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER digital_detail_scope BEFORE INSERT ON digital_sale_details FOR EACH ROW EXECUTE FUNCTION digital_detail_scope_fn();
CREATE FUNCTION digital_detail_sealed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id = s.org_id AND f.report_id = s.report_id WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report channel facts are sealed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER digital_detail_sealed BEFORE INSERT ON digital_sale_details FOR EACH ROW EXECUTE FUNCTION digital_detail_sealed_fn();
CREATE TRIGGER distribution_master_no_delete BEFORE DELETE ON distribution_master FOR EACH ROW EXECUTE FUNCTION lite_reject_change('distribution master in use');
CREATE TRIGGER distribution_master_no_update BEFORE UPDATE ON distribution_master FOR EACH ROW EXECUTE FUNCTION lite_reject_change('distribution master requires explicit migration');
CREATE TRIGGER distribution_no_delete BEFORE DELETE ON sale_distribution_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('distribution versions immutable');
CREATE TRIGGER distribution_no_update BEFORE UPDATE ON sale_distribution_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('distribution versions immutable');
CREATE TRIGGER joint_contract_immutable BEFORE UPDATE ON joint_committee_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint terms are immutable');
CREATE TRIGGER joint_contract_no_delete BEFORE DELETE ON joint_committee_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint terms are immutable');
CREATE TRIGGER joint_cost_immutable BEFORE UPDATE ON joint_committee_costs FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint cost event is immutable');
CREATE TRIGGER joint_cost_no_delete BEFORE DELETE ON joint_committee_costs FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint cost event is immutable');
CREATE FUNCTION joint_funding_credit_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.kind = 'production_payment_credit') IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NOT EXISTS (SELECT 1 FROM joint_production_milestones m JOIN joint_committee_contracts c ON c.org_id = m.org_id AND c.id = m.contract_id WHERE m.org_id = NEW.org_id AND m.contract_id = NEW.contract_id AND m.id = NEW.milestone_id AND c.manager_partner_id = NEW.partner_id AND m.paid_on = NEW.paid_on AND m.paid_inc_tax_yen >= NEW.amount_inc_tax_yen)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'production payment credit source mismatch';
  END IF;
  IF ((SELECT COALESCE(SUM(f.amount_inc_tax_yen), 0) FROM joint_funding_events f WHERE f.org_id = NEW.org_id AND f.contract_id = NEW.contract_id AND f.milestone_id = NEW.milestone_id) + NEW.amount_inc_tax_yen > (SELECT m.paid_inc_tax_yen FROM joint_production_milestones m WHERE m.org_id = NEW.org_id AND m.contract_id = NEW.contract_id AND m.id = NEW.milestone_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'production payment credit exceeds paid amount';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER joint_funding_credit_validate BEFORE INSERT ON joint_funding_events FOR EACH ROW EXECUTE FUNCTION joint_funding_credit_validate_fn();
CREATE TRIGGER joint_funding_event_immutable BEFORE UPDATE ON joint_funding_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('funding event is immutable');
CREATE TRIGGER joint_funding_event_no_delete BEFORE DELETE ON joint_funding_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('funding event is immutable');
CREATE TRIGGER joint_holiday_immutable BEFORE UPDATE ON joint_business_holidays FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint calendar is immutable');
CREATE TRIGGER joint_holiday_no_delete BEFORE DELETE ON joint_business_holidays FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint calendar is immutable');
CREATE TRIGGER joint_member_immutable BEFORE UPDATE ON joint_committee_members FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint terms are immutable');
CREATE TRIGGER joint_member_no_delete BEFORE DELETE ON joint_committee_members FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint terms are immutable');
CREATE TRIGGER joint_milestone_immutable BEFORE UPDATE ON joint_production_milestones FOR EACH ROW EXECUTE FUNCTION lite_reject_change('production milestone is immutable');
CREATE TRIGGER joint_milestone_no_delete BEFORE DELETE ON joint_production_milestones FOR EACH ROW EXECUTE FUNCTION lite_reject_change('production milestone is immutable');
CREATE TRIGGER joint_period_immutable BEFORE UPDATE ON joint_committee_periods FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint terms are immutable');
CREATE TRIGGER joint_period_no_delete BEFORE DELETE ON joint_committee_periods FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint terms are immutable');
CREATE TRIGGER joint_sale_immutable BEFORE UPDATE ON joint_committee_sales FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint sale event is immutable');
CREATE TRIGGER joint_sale_no_delete BEFORE DELETE ON joint_committee_sales FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint sale event is immutable');
CREATE TRIGGER joint_snapshot_immutable BEFORE UPDATE ON joint_committee_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint snapshot is immutable');
CREATE TRIGGER joint_snapshot_no_delete BEFORE DELETE ON joint_committee_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint snapshot is immutable');
CREATE TRIGGER joint_window_immutable BEFORE UPDATE ON joint_committee_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint terms are immutable');
CREATE TRIGGER joint_window_no_delete BEFORE DELETE ON joint_committee_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('joint terms are immutable');
CREATE TRIGGER mapping_provenance_immutable BEFORE UPDATE ON mapping_import_provenance FOR EACH ROW EXECUTE FUNCTION lite_reject_change('mapping provenance is immutable');
CREATE TRIGGER mg_incoming_no_delete BEFORE DELETE ON mg_incoming_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG契約マスターは削除できません');
CREATE TRIGGER mg_incoming_no_update BEFORE UPDATE ON mg_incoming_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG契約マスターは変更できません');
CREATE TRIGGER mg_ledger_no_delete BEFORE DELETE ON mg_ledger_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG月次報告は削除できません');
CREATE TRIGGER mg_ledger_no_update BEFORE UPDATE ON mg_ledger_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG月次報告は変更できません');
CREATE FUNCTION mg_ledger_successor_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_entry_id IS NOT NULL) IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NOT EXISTS (SELECT 1 FROM mg_ledger_entries old_row WHERE old_row.org_id = NEW.org_id AND old_row.id = NEW.reverses_entry_id AND old_row.term_version_id = NEW.term_version_id AND old_row.product_id = NEW.product_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '訂正元は同じ条件版・商品の原報告を指定してください';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER mg_ledger_successor_scope BEFORE INSERT ON mg_ledger_entries FOR EACH ROW EXECUTE FUNCTION mg_ledger_successor_scope_fn();
CREATE TRIGGER mg_outgoing_no_delete BEFORE DELETE ON mg_outgoing_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG契約マスターは削除できません');
CREATE TRIGGER mg_outgoing_no_update BEFORE UPDATE ON mg_outgoing_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG契約マスターは変更できません');
CREATE TRIGGER mg_phases_no_delete BEFORE DELETE ON mg_version_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG日程は削除できません');
CREATE TRIGGER mg_phases_no_update BEFORE UPDATE ON mg_version_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG日程は変更できません');
CREATE TRIGGER mg_products_no_delete BEFORE DELETE ON mg_version_products FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG商品評価は削除できません');
CREATE TRIGGER mg_products_no_update BEFORE UPDATE ON mg_version_products FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG商品評価は変更できません');
CREATE TRIGGER mg_terms_no_delete BEFORE DELETE ON mg_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG条件版は削除できません');
CREATE TRIGGER mg_terms_no_update BEFORE UPDATE ON mg_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('MG条件版は変更できません');
CREATE FUNCTION observation_value_type_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT value_type FROM metric_definitions WHERE org_id = NEW.org_id AND id = NEW.metric_definition_id) IN ('integer', 'decimal', 'boolean') AND NEW.value_text IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'numeric metric requires value_number';
  ELSIF ((SELECT value_type FROM metric_definitions WHERE org_id = NEW.org_id AND id = NEW.metric_definition_id) = 'text' AND NEW.value_number IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'text metric requires value_text';
  ELSIF ((SELECT value_type FROM metric_definitions WHERE org_id = NEW.org_id AND id = NEW.metric_definition_id) = 'integer' AND NEW.value_number IS NOT NULL AND NEW.value_number <> lite_cast_int(NEW.value_number)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'integer metric requires integer value';
  ELSIF ((SELECT value_type FROM metric_definitions WHERE org_id = NEW.org_id AND id = NEW.metric_definition_id) = 'boolean' AND NEW.value_number IS NOT NULL AND NEW.value_number NOT IN (0, 1)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'boolean metric requires 0 or 1';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER observation_value_type_insert BEFORE INSERT ON observations FOR EACH ROW EXECUTE FUNCTION observation_value_type_insert_fn();
CREATE FUNCTION opportunity_scope_locked_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.work_id <> OLD.work_id OR NEW.partner_id <> OLD.partner_id) AND (EXISTS (SELECT 1 FROM sales_activities a WHERE a.org_id = OLD.org_id AND a.opportunity_id = OLD.id) OR EXISTS (SELECT 1 FROM sales_agreements a WHERE a.org_id = OLD.org_id AND a.opportunity_id = OLD.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'opportunity scope is referenced';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER opportunity_scope_locked BEFORE UPDATE OF org_id, project_id, work_id, partner_id ON sales_opportunities FOR EACH ROW EXECUTE FUNCTION opportunity_scope_locked_fn();
CREATE TRIGGER package_detail_immutable_delete BEFORE DELETE ON package_sale_details FOR EACH ROW EXECUTE FUNCTION lite_reject_change('channel detail is immutable');
CREATE TRIGGER package_detail_immutable_update BEFORE UPDATE ON package_sale_details FOR EACH ROW EXECUTE FUNCTION lite_reject_change('channel detail is immutable');
CREATE FUNCTION package_detail_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id = s.org_id AND r.id = s.report_id WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id AND r.kind = 'package')) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'package detail requires package report sale';
  END IF;
  IF (EXISTS (SELECT 1 FROM theatrical_sale_details d WHERE d.org_id = NEW.org_id AND d.sale_id = NEW.sale_id) OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id = NEW.org_id AND d.sale_id = NEW.sale_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale already has another channel detail';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER package_detail_scope BEFORE INSERT ON package_sale_details FOR EACH ROW EXECUTE FUNCTION package_detail_scope_fn();
CREATE FUNCTION package_detail_sealed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id = s.org_id AND f.report_id = s.report_id WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report channel facts are sealed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER package_detail_sealed BEFORE INSERT ON package_sale_details FOR EACH ROW EXECUTE FUNCTION package_detail_sealed_fn();
CREATE TRIGGER package_observation_immutable_delete BEFORE DELETE ON package_report_observations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('package observation is immutable');
CREATE TRIGGER package_observation_immutable_update BEFORE UPDATE ON package_report_observations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('package observation is immutable');
CREATE TRIGGER package_observation_product_immutable_delete BEFORE DELETE ON package_observation_products FOR EACH ROW EXECUTE FUNCTION lite_reject_change('package observation product is immutable');
CREATE TRIGGER package_observation_product_immutable_update BEFORE UPDATE ON package_observation_products FOR EACH ROW EXECUTE FUNCTION lite_reject_change('package observation product is immutable');
CREATE FUNCTION package_observation_product_sealed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id = NEW.org_id AND f.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report channel facts are sealed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER package_observation_product_sealed BEFORE INSERT ON package_observation_products FOR EACH ROW EXECUTE FUNCTION package_observation_product_sealed_fn();
CREATE FUNCTION package_observation_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id = NEW.org_id AND r.id = NEW.report_id AND r.kind = 'package')) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'package observation requires package report';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER package_observation_scope BEFORE INSERT ON package_report_observations FOR EACH ROW EXECUTE FUNCTION package_observation_scope_fn();
CREATE FUNCTION package_observation_sealed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id = NEW.org_id AND f.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report channel facts are sealed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER package_observation_sealed BEFORE INSERT ON package_report_observations FOR EACH ROW EXECUTE FUNCTION package_observation_sealed_fn();
CREATE FUNCTION plan_approval_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.decision = 'approved') IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NOT EXISTS (SELECT 1 FROM receipt_plan_requests q JOIN billing_invoices i ON i.org_id = q.org_id AND i.id = q.invoice_id WHERE q.org_id = NEW.org_id AND q.id = NEW.request_id AND i.status = 'issued' AND q.proposed_due_date >= i.invoice_date AND i.amount_inc_tax > COALESCE((SELECT SUM(ba.amount_yen) FROM billing_receipt_allocations ba LEFT JOIN billing_receipt_reversals br ON br.org_id = ba.org_id AND br.receipt_id = ba.receipt_id WHERE ba.org_id = i.org_id AND ba.invoice_id = i.id AND br.receipt_id IS NULL), 0) AND q.base_version = COALESCE((SELECT max(d.version_no) FROM receipt_plan_decisions d WHERE d.org_id = NEW.org_id AND d.invoice_id = NEW.invoice_id), 0) AND NEW.version_no = q.base_version + 1)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale plan request';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER plan_approval_guard BEFORE INSERT ON receipt_plan_decisions FOR EACH ROW EXECUTE FUNCTION plan_approval_guard_fn();
CREATE TRIGGER plan_decision_no_delete BEFORE DELETE ON receipt_plan_decisions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('plan decision immutable');
CREATE TRIGGER plan_decision_no_update BEFORE UPDATE ON receipt_plan_decisions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('plan decision immutable');
CREATE TRIGGER plan_request_no_delete BEFORE DELETE ON receipt_plan_requests FOR EACH ROW EXECUTE FUNCTION lite_reject_change('plan request immutable');
CREATE TRIGGER plan_request_no_update BEFORE UPDATE ON receipt_plan_requests FOR EACH ROW EXECUTE FUNCTION lite_reject_change('plan request immutable');
CREATE TRIGGER report_channel_fact_seal_immutable_delete BEFORE DELETE ON report_channel_fact_seals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('report channel facts are sealed');
CREATE TRIGGER report_channel_fact_seal_immutable_update BEFORE UPDATE ON report_channel_fact_seals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('report channel facts are sealed');
CREATE TRIGGER report_dimensions_immutable_delete BEFORE DELETE ON report_sale_dimensions_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('report dimensions are immutable');
CREATE TRIGGER report_dimensions_immutable_update BEFORE UPDATE ON report_sale_dimensions_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('report dimensions are immutable');
CREATE TRIGGER report_mapping_profile_immutable BEFORE UPDATE ON report_mapping_profiles FOR EACH ROW EXECUTE FUNCTION lite_reject_change('mapping profiles are immutable');
CREATE TRIGGER report_mapping_version_immutable BEFORE UPDATE ON report_mapping_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('mapping versions are immutable');
CREATE TRIGGER report_recognition_immutable BEFORE UPDATE ON report_recognition FOR EACH ROW EXECUTE FUNCTION lite_reject_change('report recognition metadata is immutable');
CREATE FUNCTION report_recognition_month_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id = NEW.org_id AND r.id = NEW.report_id AND r.accounting_month = NEW.resolved_month)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report recognition month mismatch';
  END IF;
  IF (EXISTS (SELECT 1 FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id AND s.accounting_month <> NEW.resolved_month)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale recognition month mismatch';
  END IF;
  IF (NEW.recognition_basis_id = 1 AND EXISTS (SELECT 1 FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id AND (substr(s.sales_period_from, 1, 7) <> NEW.sales_month OR substr(s.sales_period_to, 1, 7) <> NEW.sales_month))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales recognition month requires single-month sale period';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_recognition_month_insert BEFORE INSERT ON report_recognition FOR EACH ROW EXECUTE FUNCTION report_recognition_month_insert_fn();
CREATE FUNCTION report_recognition_month_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id = NEW.org_id AND r.id = NEW.report_id AND r.accounting_month = NEW.resolved_month)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report recognition month mismatch';
  END IF;
  IF (EXISTS (SELECT 1 FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id AND s.accounting_month <> NEW.resolved_month)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale recognition month mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_recognition_month_update BEFORE UPDATE ON report_recognition FOR EACH ROW EXECUTE FUNCTION report_recognition_month_update_fn();
CREATE FUNCTION report_recognition_report_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NEW.accounting_month <> (SELECT resolved_month FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report recognition month mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_recognition_report_update BEFORE UPDATE OF accounting_month ON report_imports FOR EACH ROW EXECUTE FUNCTION report_recognition_report_update_fn();
CREATE FUNCTION report_recognition_sale_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.report_id IS NOT NULL AND EXISTS (SELECT 1 FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NEW.accounting_month <> (SELECT resolved_month FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale recognition month mismatch';
  END IF;
  IF ((SELECT recognition_basis_id FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id) = 1 AND (substr(NEW.sales_period_from, 1, 7) <> (SELECT sales_month FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id) OR substr(NEW.sales_period_to, 1, 7) <> (SELECT sales_month FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales recognition month requires single-month sale period';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_recognition_sale_insert BEFORE INSERT ON sale_lines FOR EACH ROW EXECUTE FUNCTION report_recognition_sale_insert_fn();
CREATE FUNCTION report_recognition_sale_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.report_id IS NOT NULL AND EXISTS (SELECT 1 FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NEW.accounting_month <> (SELECT resolved_month FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale recognition month mismatch';
  END IF;
  IF ((SELECT recognition_basis_id FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id) = 1 AND (substr(NEW.sales_period_from, 1, 7) <> (SELECT sales_month FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id) OR substr(NEW.sales_period_to, 1, 7) <> (SELECT sales_month FROM report_recognition rr WHERE rr.org_id = NEW.org_id AND rr.report_id = NEW.report_id))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales recognition month requires single-month sale period';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_recognition_sale_update BEFORE UPDATE OF accounting_month, report_id, sales_period_from, sales_period_to ON sale_lines FOR EACH ROW EXECUTE FUNCTION report_recognition_sale_update_fn();
CREATE FUNCTION report_source_control_channel_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.scope_kind = 'channel') IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id = NEW.org_id AND r.id = NEW.report_id AND r.kind = NEW.channel)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source control channel must match report kind';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_source_control_channel_scope BEFORE INSERT ON report_source_controls FOR EACH ROW EXECUTE FUNCTION report_source_control_channel_scope_fn();
CREATE TRIGGER report_source_control_immutable_delete BEFORE DELETE ON report_source_controls FOR EACH ROW EXECUTE FUNCTION lite_reject_change('source control is immutable');
CREATE TRIGGER report_source_control_immutable_update BEFORE UPDATE ON report_source_controls FOR EACH ROW EXECUTE FUNCTION lite_reject_change('source control is immutable');
CREATE FUNCTION report_source_control_matches_sealed_report_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id = NEW.org_id AND f.report_id = NEW.report_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source control requires sealed report';
  END IF;
  IF (NEW.expected_value <> CASE NEW.metric WHEN 'row_count' THEN (SELECT COUNT(*) FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id) + (SELECT COUNT(DISTINCT o.source_row) FROM package_report_observations o WHERE o.org_id = NEW.org_id AND o.report_id = NEW.report_id AND NOT EXISTS (SELECT 1 FROM sale_lines s WHERE s.org_id = o.org_id AND s.report_id = o.report_id AND s.source_row = o.source_row)) WHEN 'amount_ex_tax' THEN (SELECT COALESCE(SUM(s.amount_ex_tax), 0) FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id) WHEN 'tax_amount' THEN (SELECT COALESCE(SUM(s.tax_amount), 0) FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id) WHEN 'amount_inc_tax' THEN (SELECT COALESCE(SUM(s.amount_inc_tax), 0) FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id) END) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source control does not match sealed report';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_source_control_matches_sealed_report BEFORE INSERT ON report_source_controls FOR EACH ROW EXECUTE FUNCTION report_source_control_matches_sealed_report_fn();
CREATE FUNCTION report_source_control_observation_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = OLD.org_id AND c.report_id = OLD.report_id)) IS NOT TRUE THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source-controlled observation is immutable';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER report_source_control_observation_delete BEFORE DELETE ON package_report_observations FOR EACH ROW EXECUTE FUNCTION report_source_control_observation_delete_fn();
CREATE FUNCTION report_source_control_observation_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = NEW.org_id AND c.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source-controlled observation is immutable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_source_control_observation_insert BEFORE INSERT ON package_report_observations FOR EACH ROW EXECUTE FUNCTION report_source_control_observation_insert_fn();
CREATE FUNCTION report_source_control_observation_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = OLD.org_id AND c.report_id = OLD.report_id) OR EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = NEW.org_id AND c.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source-controlled observation is immutable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_source_control_observation_update BEFORE UPDATE ON package_report_observations FOR EACH ROW EXECUTE FUNCTION report_source_control_observation_update_fn();
CREATE FUNCTION report_source_control_report_identity_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = OLD.org_id AND c.report_id = OLD.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source-controlled report identity is immutable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_source_control_report_identity_update BEFORE UPDATE OF org_id, report_key, content_hash, kind ON report_imports FOR EACH ROW EXECUTE FUNCTION report_source_control_report_identity_update_fn();
CREATE FUNCTION report_source_control_sale_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = OLD.org_id AND c.report_id = OLD.report_id)) IS NOT TRUE THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source-controlled sale is immutable';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER report_source_control_sale_delete BEFORE DELETE ON sale_lines FOR EACH ROW EXECUTE FUNCTION report_source_control_sale_delete_fn();
CREATE FUNCTION report_source_control_sale_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.report_id IS NOT NULL AND EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = NEW.org_id AND c.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source-controlled sale is immutable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_source_control_sale_insert BEFORE INSERT ON sale_lines FOR EACH ROW EXECUTE FUNCTION report_source_control_sale_insert_fn();
CREATE FUNCTION report_source_control_sale_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = OLD.org_id AND c.report_id = OLD.report_id) OR EXISTS (SELECT 1 FROM report_source_controls c WHERE c.org_id = NEW.org_id AND c.report_id = NEW.report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'source-controlled sale is immutable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_source_control_sale_update BEFORE UPDATE ON sale_lines FOR EACH ROW EXECUTE FUNCTION report_source_control_sale_update_fn();
CREATE FUNCTION report_supersede_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.supersedes_id IS NOT NULL) IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id = NEW.org_id AND r.id = NEW.supersedes_id AND r.work_id = NEW.work_id AND r.report_key = NEW.report_key)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'superseded report scope mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_supersede_scope BEFORE INSERT ON report_imports FOR EACH ROW EXECUTE FUNCTION report_supersede_scope_fn();
CREATE TRIGGER rights_intake_case_immutable BEFORE UPDATE ON rights_intake_cases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('rights intake snapshots are immutable');
CREATE TRIGGER rights_intake_document_immutable BEFORE UPDATE ON rights_intake_documents FOR EACH ROW EXECUTE FUNCTION lite_reject_change('rights intake snapshots are immutable');
CREATE TRIGGER rights_intake_link_immutable BEFORE UPDATE ON intake_settlement_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('rights intake settlement links are immutable');
CREATE TRIGGER rights_intake_participant_immutable BEFORE UPDATE ON rights_intake_participants FOR EACH ROW EXECUTE FUNCTION lite_reject_change('rights intake snapshots are immutable');
CREATE TRIGGER rights_intake_scope_immutable BEFORE UPDATE ON rights_intake_scopes FOR EACH ROW EXECUTE FUNCTION lite_reject_change('rights intake snapshots are immutable');
CREATE TRIGGER rights_payments_no_delete BEFORE DELETE ON rights_payment_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('rights payment events are immutable');
CREATE TRIGGER rights_payments_no_update BEFORE UPDATE ON rights_payment_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('rights payment events are immutable');
CREATE FUNCTION rights_payments_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.settlement_contract_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM settlement_contracts c WHERE c.org_id = NEW.org_id AND c.id = NEW.settlement_contract_id AND c.holder_partner_id = NEW.partner_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'rights payment recipient mismatch';
  END IF;
  IF (NEW.committee_snapshot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committee_snapshot_member_amounts m WHERE m.org_id = NEW.org_id AND m.snapshot_id = NEW.committee_snapshot_id AND m.partner_id = NEW.partner_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee payment recipient mismatch';
  END IF;
  IF (NEW.reverses_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rights_payment_events p WHERE p.org_id = NEW.org_id AND p.id = NEW.reverses_event_id AND p.reverses_event_id IS NULL AND p.partner_id = NEW.partner_id AND p.settlement_contract_id IS NOT DISTINCT FROM NEW.settlement_contract_id AND p.committee_snapshot_id IS NOT DISTINCT FROM NEW.committee_snapshot_id AND p.amount_yen = NEW.amount_yen AND p.paid_on <= NEW.paid_on)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'rights payment reversal mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER rights_payments_validate BEFORE INSERT ON rights_payment_events FOR EACH ROW EXECUTE FUNCTION rights_payments_validate_fn();
CREATE TRIGGER sales_activity_immutable BEFORE UPDATE ON sales_activities FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales activities are append-only');
CREATE TRIGGER sales_activity_no_delete BEFORE DELETE ON sales_activities FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales activities are append-only');
CREATE TRIGGER sales_agreement_scope_immutable BEFORE UPDATE OF org_id, project_id, work_id, opportunity_id, partner_id, product_id, intake_case_id, contract_code, title ON sales_agreements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales agreement scope is immutable');
CREATE TRIGGER sales_material_immutable BEFORE UPDATE ON sales_material_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales material snapshots are immutable');
CREATE TRIGGER sales_material_no_delete BEFORE DELETE ON sales_material_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales material snapshots are immutable');
CREATE TRIGGER sales_report_link_immutable BEFORE UPDATE ON sales_report_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales report links are immutable');
CREATE TRIGGER sales_report_link_no_delete BEFORE DELETE ON sales_report_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales report links are immutable');
CREATE FUNCTION sales_report_link_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM report_imports r JOIN sales_agreements a ON a.org_id = r.org_id AND a.id = NEW.agreement_id AND a.work_id = NEW.work_id JOIN sales_agreement_term_versions v ON v.org_id = a.org_id AND v.agreement_id = a.id AND v.id = NEW.term_version_id WHERE r.org_id = NEW.org_id AND r.id = NEW.report_id AND r.status = 'active' AND r.partner_id = a.partner_id AND v.channel = r.kind)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales report must be active and match partner and supported channel';
  END IF;
  IF (NOT EXISTS (SELECT 1 FROM sales_agreement_term_versions v WHERE v.org_id = NEW.org_id AND v.id = NEW.term_version_id AND v.agreement_id = NEW.agreement_id AND v.version_no = (SELECT max(latest.version_no) FROM sales_agreement_term_versions latest WHERE latest.org_id = v.org_id AND latest.agreement_id = v.agreement_id))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales report link requires current agreement term';
  END IF;
  IF (NOT EXISTS (SELECT 1 FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id AND ((s.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_works pw WHERE pw.org_id = s.org_id AND pw.product_id = s.product_id AND pw.work_id = NEW.work_id)) OR (NOT EXISTS (SELECT 1 FROM product_works any_pw WHERE any_pw.org_id = s.org_id AND any_pw.product_id = s.product_id) AND s.work_id = NEW.work_id)))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales report has no allocated lines for work';
  END IF;
  IF (EXISTS (SELECT 1 FROM sale_lines s JOIN sales_agreements a ON a.org_id = NEW.org_id AND a.id = NEW.agreement_id WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id AND ((s.product_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_works pw WHERE pw.org_id = s.org_id AND pw.product_id = s.product_id AND pw.work_id = NEW.work_id)) OR (NOT EXISTS (SELECT 1 FROM product_works any_pw WHERE any_pw.org_id = s.org_id AND any_pw.product_id = s.product_id) AND s.work_id = NEW.work_id)) AND (s.partner_id <> a.partner_id OR (a.product_id IS NOT NULL AND (s.product_id IS NULL OR s.product_id <> a.product_id))))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales report lines do not match agreement partner or product';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_report_link_validate BEFORE INSERT ON sales_report_links FOR EACH ROW EXECUTE FUNCTION sales_report_link_validate_fn();
CREATE TRIGGER sales_term_immutable BEFORE UPDATE ON sales_agreement_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales agreement terms are immutable');
CREATE TRIGGER sales_term_no_delete BEFORE DELETE ON sales_agreement_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales agreement terms are immutable');
CREATE FUNCTION scene_scope_locked_by_field_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.work_id <> OLD.work_id) AND (EXISTS (SELECT 1 FROM day_scene_assignments a WHERE a.org_id = OLD.org_id AND a.scene_id = OLD.id) OR EXISTS (SELECT 1 FROM prep_tasks t WHERE t.org_id = OLD.org_id AND t.scene_id = OLD.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'scene scope is referenced by field operations';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER scene_scope_locked_by_field BEFORE UPDATE OF org_id, project_id, work_id ON scenes FOR EACH ROW EXECUTE FUNCTION scene_scope_locked_by_field_fn();
CREATE TRIGGER settlement_contract_core_immutable BEFORE UPDATE OF project_id, work_id, contract_type, holder_partner_id, mg_contract_yen, mg_paid_yen ON settlement_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('settlement contract financial core is immutable');
CREATE FUNCTION settlement_report_basis_consistent_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM settlement_report_links l WHERE l.org_id = NEW.org_id AND l.report_id = NEW.report_id AND l.report_basis <> NEW.report_basis)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report basis must be consistent across works';
  END IF;
  IF (NOT EXISTS (SELECT 1 FROM report_imports r WHERE r.org_id = NEW.org_id AND r.id = NEW.report_id AND r.status = 'active')) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'settlement report must be active';
  END IF;
  IF (NOT EXISTS (SELECT 1 FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.report_id = NEW.report_id AND ((EXISTS (SELECT 1 FROM product_works any_pw WHERE any_pw.org_id = s.org_id AND any_pw.product_id = s.product_id) AND EXISTS (SELECT 1 FROM product_works target_pw WHERE target_pw.org_id = s.org_id AND target_pw.product_id = s.product_id AND target_pw.work_id = NEW.work_id)) OR (NOT EXISTS (SELECT 1 FROM product_works any_pw WHERE any_pw.org_id = s.org_id AND any_pw.product_id = s.product_id) AND s.work_id = NEW.work_id)))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report has no allocation for work';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER settlement_report_basis_consistent BEFORE INSERT ON settlement_report_links FOR EACH ROW EXECUTE FUNCTION settlement_report_basis_consistent_fn();
CREATE FUNCTION settlement_report_no_committee_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM committee_snapshot_reports r WHERE r.org_id = NEW.org_id AND r.work_id = NEW.work_id AND r.report_id = NEW.report_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report already used by committee snapshot';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER settlement_report_no_committee BEFORE INSERT ON settlement_report_links FOR EACH ROW EXECUTE FUNCTION settlement_report_no_committee_fn();
CREATE TRIGGER settlement_terms_immutable_delete BEFORE DELETE ON settlement_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('settlement term versions are immutable');
CREATE TRIGGER settlement_terms_immutable_update BEFORE UPDATE ON settlement_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('settlement term versions are immutable');
CREATE FUNCTION settlement_terms_validate_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM settlement_contracts c WHERE c.org_id = NEW.org_id AND c.id = NEW.contract_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'settlement contract scope mismatch';
  ELSIF ((SELECT contract_type FROM settlement_contracts WHERE org_id = NEW.org_id AND id = NEW.contract_id) = 'commission' AND (NEW.agency_fee_bps IS NULL OR NEW.recoup_basis IS NOT NULL OR NEW.overage_enabled IS NOT NULL)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid commission terms';
  ELSIF ((SELECT contract_type FROM settlement_contracts WHERE org_id = NEW.org_id AND id = NEW.contract_id) = 'mg' AND (NEW.agency_fee_bps IS NULL OR NEW.recoup_basis IS NULL)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid mg terms';
  ELSIF ((SELECT contract_type FROM settlement_contracts WHERE org_id = NEW.org_id AND id = NEW.contract_id) = 'self_owned' AND (NEW.agency_fee_bps IS NOT NULL OR NEW.recoup_basis IS NOT NULL OR NEW.overage_enabled IS NOT NULL)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid self owned terms';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER settlement_terms_validate BEFORE INSERT ON settlement_term_versions FOR EACH ROW EXECUTE FUNCTION settlement_terms_validate_fn();
CREATE FUNCTION shooting_day_scope_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((NEW.org_id <> OLD.org_id OR NEW.project_id <> OLD.project_id OR NEW.work_id <> OLD.work_id) AND (EXISTS (SELECT 1 FROM day_scene_assignments a WHERE a.org_id = OLD.org_id AND a.shooting_day_id = OLD.id) OR EXISTS (SELECT 1 FROM prep_tasks t WHERE t.org_id = OLD.org_id AND t.shooting_day_id = OLD.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'shooting day scope is referenced';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER shooting_day_scope_immutable BEFORE UPDATE OF org_id, project_id, work_id ON shooting_days FOR EACH ROW EXECUTE FUNCTION shooting_day_scope_immutable_fn();
CREATE TRIGGER tax_line_immutable BEFORE UPDATE ON tax_calculation_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax calculation lines are immutable');
CREATE TRIGGER tax_line_no_delete BEFORE DELETE ON tax_calculation_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax calculation lines are immutable');
CREATE TRIGGER tax_link_immutable BEFORE UPDATE ON tax_invoice_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax invoice links are immutable');
CREATE TRIGGER tax_link_no_delete BEFORE DELETE ON tax_invoice_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax invoice links are immutable');
CREATE TRIGGER tax_rule_immutable BEFORE UPDATE ON tax_rule_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax rule versions are immutable');
CREATE TRIGGER tax_rule_no_delete BEFORE DELETE ON tax_rule_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax rule versions are immutable');
CREATE TRIGGER tax_snapshot_immutable BEFORE UPDATE ON tax_calculation_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax calculation snapshots are immutable');
CREATE TRIGGER tax_snapshot_no_delete BEFORE DELETE ON tax_calculation_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax calculation snapshots are immutable');
CREATE TRIGGER tax_total_immutable BEFORE UPDATE ON tax_invoice_rate_totals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax rate totals are immutable');
CREATE TRIGGER tax_total_no_delete BEFORE DELETE ON tax_invoice_rate_totals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('tax rate totals are immutable');
CREATE TRIGGER theatrical_detail_immutable_delete BEFORE DELETE ON theatrical_sale_details FOR EACH ROW EXECUTE FUNCTION lite_reject_change('channel detail is immutable');
CREATE TRIGGER theatrical_detail_immutable_update BEFORE UPDATE ON theatrical_sale_details FOR EACH ROW EXECUTE FUNCTION lite_reject_change('channel detail is immutable');
CREATE FUNCTION theatrical_detail_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM sale_lines s JOIN report_imports r ON r.org_id = s.org_id AND r.id = s.report_id WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id AND r.kind = 'theatrical')) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'theatrical detail requires theatrical report sale';
  END IF;
  IF (EXISTS (SELECT 1 FROM package_sale_details d WHERE d.org_id = NEW.org_id AND d.sale_id = NEW.sale_id) OR EXISTS (SELECT 1 FROM digital_sale_details d WHERE d.org_id = NEW.org_id AND d.sale_id = NEW.sale_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale already has another channel detail';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER theatrical_detail_scope BEFORE INSERT ON theatrical_sale_details FOR EACH ROW EXECUTE FUNCTION theatrical_detail_scope_fn();
CREATE FUNCTION theatrical_detail_sealed_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM sale_lines s JOIN report_channel_fact_seals f ON f.org_id = s.org_id AND f.report_id = s.report_id WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'report channel facts are sealed';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER theatrical_detail_sealed BEFORE INSERT ON theatrical_sale_details FOR EACH ROW EXECUTE FUNCTION theatrical_detail_sealed_fn();
CREATE TRIGGER workbench_recipe_version_immutable_delete BEFORE DELETE ON workbench_recipe_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workbench recipe versions are immutable');
CREATE TRIGGER workbench_recipe_version_immutable_update BEFORE UPDATE ON workbench_recipe_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workbench recipe versions are immutable');
CREATE TRIGGER workbench_snapshot_immutable_delete BEFORE DELETE ON workbench_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workbench snapshots are immutable');
CREATE TRIGGER workbench_snapshot_immutable_update BEFORE UPDATE ON workbench_snapshots FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workbench snapshots are immutable');
CREATE TRIGGER workbench_source_artifact_immutable_delete BEFORE DELETE ON workbench_source_artifacts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workbench source artifacts are immutable');
CREATE TRIGGER workbench_source_artifact_immutable_update BEFORE UPDATE ON workbench_source_artifacts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workbench source artifacts are immutable');
CREATE TRIGGER workbench_validation_immutable_delete BEFORE DELETE ON workbench_validations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workbench validations are immutable');
CREATE TRIGGER workbench_validation_immutable_update BEFORE UPDATE ON workbench_validations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workbench validations are immutable');
CREATE TRIGGER workflow_raw_artifacts_immutable BEFORE UPDATE ON workflow_raw_artifacts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workflow raw artifacts are immutable');
CREATE TRIGGER workflow_raw_artifacts_no_delete BEFORE DELETE ON workflow_raw_artifacts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workflow raw artifacts cannot be deleted');
CREATE TRIGGER workflow_report_commits_immutable BEFORE UPDATE ON workflow_report_commits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workflow report commits are immutable');
CREATE TRIGGER workflow_report_commits_no_delete BEFORE DELETE ON workflow_report_commits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workflow report commits cannot be deleted');
CREATE TRIGGER workflow_report_selections_immutable BEFORE UPDATE ON workflow_report_selections FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workflow report selections are immutable');
CREATE TRIGGER workflow_report_selections_no_delete BEFORE DELETE ON workflow_report_selections FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workflow report selections cannot be deleted');
CREATE FUNCTION workflow_script_commit_link_days_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO workflow_script_commit_days(org_id, commit_id, work_id, shooting_day_id, proposal_index) SELECT NEW.org_id, NEW.id, NEW.work_id, d.id, lite_cast_int(j.key) FROM workflow_schedule_previews p CROSS JOIN lite_json_each(p.proposal_json, '$.days') j JOIN shooting_days d ON d.org_id = p.org_id AND d.work_id = p.work_id AND d.shoot_date = lite_json_extract(j.value, '$.date') AND d.unit = lite_json_extract(p.input_json, '$.unit') WHERE p.org_id = NEW.org_id AND p.token = NEW.preview_token;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER workflow_script_commit_link_days AFTER INSERT ON workflow_script_commits FOR EACH ROW EXECUTE FUNCTION workflow_script_commit_link_days_fn();
CREATE FUNCTION workflow_script_commit_link_scenes_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO workflow_script_commit_scenes(org_id, commit_id, work_id, scene_id, source_index) SELECT NEW.org_id, NEW.id, NEW.work_id, s.id, lite_cast_int(j.key) FROM workflow_script_reviews r CROSS JOIN lite_json_each(r.scenes_json, '$') j JOIN scenes s ON s.org_id = r.org_id AND s.work_id = r.work_id AND s.scene_no = lite_json_extract(j.value, '$.sceneNo') WHERE r.org_id = NEW.org_id AND r.id = NEW.review_id;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER workflow_script_commit_link_scenes AFTER INSERT ON workflow_script_commits FOR EACH ROW EXECUTE FUNCTION workflow_script_commit_link_scenes_fn();
CREATE TRIGGER workflow_script_reviews_immutable BEFORE UPDATE ON workflow_script_reviews FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workflow script reviews are immutable');
CREATE TRIGGER workflow_script_reviews_no_delete BEFORE DELETE ON workflow_script_reviews FOR EACH ROW EXECUTE FUNCTION lite_reject_change('workflow script reviews cannot be deleted');
INSERT INTO recognition_bases (id, code, name, source_field) VALUES
  (1, 'sales_month', '販売月', 'sales_month');
INSERT INTO recognition_bases (id, code, name, source_field) VALUES
  (2, 'report_received_month', '報告受領月', 'report_received_on');
INSERT INTO recognition_bases (id, code, name, source_field) VALUES
  (3, 'contract_start_month', '契約開始月', 'contract_start_on');
INSERT INTO recognition_bases (id, code, name, source_field) VALUES
  (4, 'license_start_month', 'ライセンス利用開始月', 'license_start_on');
INSERT INTO recognition_bases (id, code, name, source_field) VALUES
  (5, 'broadcast_month', '放送月', 'broadcast_on');
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('A001', 'unverified', 'A001', NULL, 128);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('A002', 'unverified', 'A002', NULL, 129);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('A003', 'unverified', 'A003', NULL, 130);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('B001', 'unverified', 'B001', NULL, 126);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('B002', 'unverified', 'B002', NULL, 127);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D001', 'unverified', 'D001', NULL, 118);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D002', 'unverified', 'D002', NULL, 119);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D003', 'unverified', 'D003', NULL, 120);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D004', 'unverified', 'D004', NULL, 121);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D005', 'unverified', 'D005', NULL, 122);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D006', 'unverified', 'D006', NULL, 123);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('E001', 'unverified', 'E001', NULL, 135);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('F001', 'unverified', 'F001', NULL, 138);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('G001', 'unverified', 'G001', NULL, 131);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H001', 'unverified', 'H001', NULL, 100);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H002', 'unverified', 'H002', NULL, 101);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H003', 'unverified', 'H003', NULL, 102);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H004', 'unverified', 'H004', NULL, 103);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('H005', 'unverified', 'H005', NULL, 104);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('K001', 'unverified', 'K001', NULL, 134);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('O001', 'unverified', 'O001', NULL, 136);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('O002', 'unverified', 'O002', NULL, 137);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('P001', 'unverified', 'P001', NULL, 132);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('P002', 'unverified', 'P002', NULL, 133);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R001', 'unverified', 'R001', NULL, 112);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R002', 'unverified', 'R002', NULL, 113);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R003', 'unverified', 'R003', NULL, 114);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R004', 'unverified', 'R004', NULL, 115);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R005', 'unverified', 'R005', NULL, 116);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('R006', 'unverified', 'R006', NULL, 117);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S001', 'unverified', 'S001', NULL, 105);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S002', 'unverified', 'S002', NULL, 106);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S003', 'unverified', 'S003', NULL, 107);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S004', 'unverified', 'S004', NULL, 108);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S005', 'unverified', 'S005', NULL, 109);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S006', 'unverified', 'S006', NULL, 110);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('S007', 'unverified', 'S007', NULL, 111);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('V001', 'unverified', 'V001', NULL, 124);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('V002', 'unverified', 'V002', NULL, 125);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('avod', 'digital', '配信・AVOD', 'AVOD', 33);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('broadcast_bs', 'broadcast', '放送・BS', NULL, 41);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('broadcast_cable', 'broadcast', '放送・CATV', NULL, 43);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('broadcast_cs', 'broadcast', '放送・CS', NULL, 42);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('broadcast_free', 'broadcast', '放送・地上波', NULL, 40);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('broadcast_unknown', 'broadcast', '放送・区分未確認', NULL, 49);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('digital_unknown', 'digital', '配信・区分未確認', NULL, 39);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('est', 'digital', '配信・EST', 'EST', 30);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('other', 'other', 'その他・未確認', NULL, 90);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('package_rental', 'package', 'ビデオグラム・レンタル', 'rental', 20);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('package_sell', 'package', 'ビデオグラム・セル', 'sell', 21);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('package_unknown', 'package', 'ビデオグラム・区分未確認', NULL, 29);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('svod', 'digital', '配信・SVOD', 'SVOD', 32);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('theatrical', 'theatrical', '劇場配給', NULL, 10);
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('tvod', 'digital', '配信・TVOD', 'TVOD', 31);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('A001', '海外', 'FLAT', '海外_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 30);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('A002', '海外', 'RS', '海外_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 31);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('A003', '海外', 'MG', 'クロスリクープ_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 32);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('B001', '放送', 'FLAT', '放送_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 28);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('B002', '放送', 'RS', '放送_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 29);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('D001', '配信', 'MG', '配信_MG', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 20);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('D002', '配信', 'FLAT', '配信_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 21);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('D003', '配信', 'RS', 'EST', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 22);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('D004', '配信', 'RS', 'TVOD', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 23);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('D005', '配信', 'RS', 'SVOD', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 24);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('D006', '配信', 'RS', 'AVOD', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 25);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('E001', '映像、画像使用', 'FLAT', '映像使用_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 37);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('F001', '調整', '調整', '', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 40);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('G001', 'グッズ', 'RS', 'グッズ_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 33);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('H001', '配給', 'RS', '劇場_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 2);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('H002', '配給', 'FLAT', '劇場_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 3);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('H003', '配給', 'RS', '非劇場_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 4);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('H004', '配給', 'FLAT', '非劇場_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 5);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('H005', '配給_物販', 'RS', '配給_物販', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 6);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('K001', '相殺', 'FLAT', '相殺_FLAT', '代引き、印紙代、振込手数料、システム使用料', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 36);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('O001', '稿料', 'FLAT', '稿料_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 38);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('O002', '稿料', 'RS', '稿料_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 39);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('P001', '製作委員会収入', '幹事', '製作委員会収入_幹事分_バンドル', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 34);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('P002', '製作委員会収入', '分配', '製作委員会収入_分配分_バンドル', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 35);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('R001', 'レンタル_RSS', 'LF', 'レンタル_RSS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 14);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('R002', 'レンタル_RSS', 'MG', 'レンタル_RSS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 15);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('R003', 'レンタル', '有償', 'レンタル_有償', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 16);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('R004', 'レンタル_RSS', 'RS', 'レンタル_RSS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 17);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('R005', 'レンタル', '無償', 'レンタル_無償', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 18);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('R006', 'レンタル', '返品', 'レンタル_返品', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 19);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('S001', 'セル', '委託', 'セル_委託', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 7);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('S002', 'セル', '委託返品', 'セル_委託返品', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 8);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('S003', 'セル', '消化納品', 'セル_消化納品', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 9);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('S004', 'セル', '消化売上', 'セル_消化売上', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 10);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('S005', 'セル', '消化返品', 'セル_消化返品', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 11);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('S006', 'セル', '買切', 'セル_買切', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 12);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('S007', 'セル', '無償', 'セル_無償', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 13);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('V001', '業務用VOD', 'FLAT', '業務用VOD_FLAT', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 26);
INSERT INTO distribution_master (code, distribution_name, transaction_method, sales_type, notes, source_sha256, source_row) VALUES
  ('V002', '業務用VOD', 'RS', '業務用VOD_RS', '', '204857434d701c1085af178475f2131dcb77037320faa4de21587998f86f5dc5', 27);

-- ===== 0002_ux_extensions.sql =====
CREATE TABLE fiscal_settings (
  org_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  fiscal_start_month bigint NOT NULL CHECK (fiscal_start_month BETWEEN 1 AND 12),
  confirmed bigint NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  updated_by bigint,
  updated_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TABLE bulk_import_previews (
  token text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  entity text COLLATE "C" NOT NULL CHECK (entity IN ('partners', 'projects', 'works', 'products', 'expenses')),
  file_name text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  rows_json text COLLATE "C" NOT NULL,
  fingerprint text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  expires_at text COLLATE "C" NOT NULL,
  used_at text COLLATE "C"
);
CREATE TABLE bulk_import_batches (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  entity text COLLATE "C" NOT NULL CHECK (entity IN ('partners', 'projects', 'works', 'products', 'expenses')),
  file_name text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  inserted_count bigint NOT NULL CHECK (inserted_count >= 0),
  updated_count bigint NOT NULL CHECK (updated_count >= 0),
  unchanged_count bigint NOT NULL CHECK (unchanged_count >= 0),
  approval_count bigint NOT NULL CHECK (approval_count >= 0),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE TRIGGER bulk_import_batches_no_update BEFORE UPDATE ON bulk_import_batches FOR EACH ROW EXECUTE FUNCTION lite_reject_change('一括登録の記録は変更できません');
CREATE TRIGGER bulk_import_batches_no_delete BEFORE DELETE ON bulk_import_batches FOR EACH ROW EXECUTE FUNCTION lite_reject_change('一括登録の記録は削除できません');
CREATE TABLE partner_profile_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  roles_json text COLLATE "C" NOT NULL DEFAULT '[]',
  invoice_registration_number text COLLATE "C" CHECK (invoice_registration_number IS NULL OR (length(invoice_registration_number) = 14 AND substr(invoice_registration_number, 1, 1) = 'T' AND ltrim(substr(invoice_registration_number, 2, 13), '0123456789') = '')),
  postal_code text COLLATE "C",
  address text COLLATE "C",
  phone text COLLATE "C",
  contact_name text COLLATE "C",
  contact_email text COLLATE "C",
  billing_note text COLLATE "C",
  effective_from text COLLATE "C",
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, partner_id, version_no)
);
CREATE TRIGGER partner_profile_versions_no_update BEFORE UPDATE ON partner_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('取引先情報の版は変更できません。新しい版を作ってください');
CREATE TRIGGER partner_profile_versions_no_delete BEFORE DELETE ON partner_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('取引先情報の版は削除できません');
CREATE INDEX workbench_snapshots_reuse ON workbench_snapshots (org_id, dataset, created_by, content_hash);
CREATE TABLE report_issuances (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  report_kind text COLLATE "C" NOT NULL CHECK (report_kind IN ('royalty', 'mg-sales')),
  conditions_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(conditions_json)),
  conditions_hash text COLLATE "C" NOT NULL CHECK (length(conditions_hash) = 64),
  content_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(content_json)),
  content_hash text COLLATE "C" NOT NULL CHECK (length(content_hash) = 64),
  recipient_type text COLLATE "C" NOT NULL CHECK (recipient_type IN ('partner', 'supplier')),
  recipient_id bigint NOT NULL CHECK (recipient_id > 0),
  recipient_name text COLLATE "C" NOT NULL CHECK (length(trim(recipient_name)) > 0),
  work_ids_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(work_ids_json)),
  headline_yen bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  previous_issuance_id bigint,
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 1000),
  issued_on text COLLATE "C" NOT NULL CHECK ((length(issued_on) = 10 AND ltrim(substr(issued_on, 1, 4), '0123456789') = '' AND substr(issued_on, 5, 1) = '-' AND ltrim(substr(issued_on, 6, 2), '0123456789') = '' AND substr(issued_on, 8, 1) = '-' AND ltrim(substr(issued_on, 9, 2), '0123456789') = '')),
  issued_by bigint NOT NULL,
  issued_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, report_kind, conditions_hash, version_no),
  CHECK ((version_no = 1 AND previous_issuance_id IS NULL) OR (version_no > 1 AND previous_issuance_id IS NOT NULL))
);
CREATE INDEX report_issuances_by_conditions ON report_issuances (org_id, report_kind, conditions_hash);
CREATE TABLE report_issuance_voids (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  issuance_id bigint NOT NULL,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1000),
  voided_by bigint NOT NULL,
  voided_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (issuance_id)
);
CREATE FUNCTION report_issuances_one_active_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM report_issuances i WHERE i.org_id = NEW.org_id AND i.report_kind = NEW.report_kind AND i.conditions_hash = NEW.conditions_hash AND NOT EXISTS (SELECT 1 FROM report_issuance_voids v WHERE v.org_id = i.org_id AND v.issuance_id = i.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '発行記録: この条件の帳票は発行済みです。取り消してから再発行してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_issuances_one_active BEFORE INSERT ON report_issuances FOR EACH ROW EXECUTE FUNCTION report_issuances_one_active_fn();
CREATE FUNCTION report_issuances_previous_voided_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.previous_issuance_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM report_issuances p JOIN report_issuance_voids v ON v.org_id = p.org_id AND v.issuance_id = p.id WHERE p.org_id = NEW.org_id AND p.id = NEW.previous_issuance_id AND p.report_kind = NEW.report_kind AND p.conditions_hash = NEW.conditions_hash AND p.version_no = NEW.version_no - 1)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '発行記録: 再発行の前の版が取り消されていないか、条件が一致しません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER report_issuances_previous_voided BEFORE INSERT ON report_issuances FOR EACH ROW EXECUTE FUNCTION report_issuances_previous_voided_fn();
CREATE TRIGGER report_issuances_no_update BEFORE UPDATE ON report_issuances FOR EACH ROW EXECUTE FUNCTION lite_reject_change('発行記録は変更できません。取り消してから再発行してください');
CREATE TRIGGER report_issuances_no_delete BEFORE DELETE ON report_issuances FOR EACH ROW EXECUTE FUNCTION lite_reject_change('発行記録は削除できません');
CREATE TRIGGER report_issuance_voids_no_update BEFORE UPDATE ON report_issuance_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('発行の取消記録は変更できません');
CREATE TRIGGER report_issuance_voids_no_delete BEFORE DELETE ON report_issuance_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('発行の取消記録は削除できません');
CREATE TABLE expected_reports (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('theatrical', 'digital', 'package', 'broadcast', 'other')),
  work_id bigint,
  frequency text COLLATE "C" NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'semiannual', 'annual')),
  due_day bigint CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  active_from text COLLATE "C" NOT NULL CHECK ((length(active_from) = 7 AND ltrim(substr(active_from, 1, 4), '0123456789') = '' AND substr(active_from, 5, 1) = '-' AND ltrim(substr(active_from, 6, 2), '0123456789') = '')),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE INDEX expected_reports_by_partner ON expected_reports (org_id, partner_id, kind);
CREATE TABLE expected_report_closures (
  org_id bigint NOT NULL,
  expected_report_id bigint NOT NULL,
  last_month text COLLATE "C" NOT NULL CHECK ((length(last_month) = 7 AND ltrim(substr(last_month, 1, 4), '0123456789') = '' AND substr(last_month, 5, 1) = '-' AND ltrim(substr(last_month, 6, 2), '0123456789') = '')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, expected_report_id)
);
CREATE TRIGGER expected_reports_no_update BEFORE UPDATE ON expected_reports FOR EACH ROW EXECUTE FUNCTION lite_reject_change('届くはずの報告は変更できません。終了して新しく登録してください');
CREATE TRIGGER expected_reports_no_delete BEFORE DELETE ON expected_reports FOR EACH ROW EXECUTE FUNCTION lite_reject_change('届くはずの報告は削除できません。終了の記録を足してください');
CREATE TRIGGER expected_report_closures_no_update BEFORE UPDATE ON expected_report_closures FOR EACH ROW EXECUTE FUNCTION lite_reject_change('終了の記録は変更できません');
CREATE TRIGGER expected_report_closures_no_delete BEFORE DELETE ON expected_report_closures FOR EACH ROW EXECUTE FUNCTION lite_reject_change('終了の記録は削除できません');
CREATE FUNCTION expected_reports_no_overlap_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expected_reports e LEFT JOIN expected_report_closures x ON x.org_id = e.org_id AND x.expected_report_id = e.id WHERE e.org_id = NEW.org_id AND e.partner_id = NEW.partner_id AND e.kind = NEW.kind AND e.work_id IS NOT DISTINCT FROM NEW.work_id AND (x.last_month IS NULL OR x.last_month >= NEW.active_from))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '同じ取引先・種類・作品の届くはずの報告が有効期間中です。前の登録を終了してから登録してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expected_reports_no_overlap BEFORE INSERT ON expected_reports FOR EACH ROW EXECUTE FUNCTION expected_reports_no_overlap_fn();
CREATE FUNCTION expected_report_closures_after_start_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.last_month < (SELECT active_from FROM expected_reports WHERE org_id = NEW.org_id AND id = NEW.expected_report_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '最後の対象月は有効期間の開始月以後にしてください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expected_report_closures_after_start BEFORE INSERT ON expected_report_closures FOR EACH ROW EXECUTE FUNCTION expected_report_closures_after_start_fn();

-- ===== 0003_royalty_committee.sql =====
CREATE TABLE royalty_agreements (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  holder_partner_id bigint NOT NULL,
  category text COLLATE "C" NOT NULL CHECK (category IN ('director', 'screenplay', 'music', 'original', 'creator', 'other')),
  agreement_code text COLLATE "C" NOT NULL CHECK (length(trim(agreement_code)) BETWEEN 1 AND 60),
  title text COLLATE "C" NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  document_reference text COLLATE "C" CHECK (document_reference IS NULL OR length(document_reference) <= 500),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, agreement_code)
);
CREATE INDEX royalty_agreements_by_holder ON royalty_agreements (org_id, holder_partner_id);
CREATE INDEX royalty_agreements_by_work ON royalty_agreements (org_id, work_id);
CREATE TABLE royalty_term_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  agreement_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  effective_from text COLLATE "C" NOT NULL CHECK ((length(effective_from) = 7 AND ltrim(substr(effective_from, 1, 4), '0123456789') = '' AND substr(effective_from, 5, 1) = '-' AND ltrim(substr(effective_from, 6, 1), '01') = '' AND ltrim(substr(effective_from, 7, 1), '0123456789') = '') AND substr(effective_from, 6, 2) BETWEEN '01' AND '12'),
  calc_method text COLLATE "C" NOT NULL CHECK (calc_method IN ('rate', 'fixed_monthly', 'manual')),
  base_kind text COLLATE "C" CHECK (base_kind IS NULL OR base_kind IN ('gross_sales', 'after_window_fee', 'after_window_fee_and_expenses', 'committee_income', 'committee_income_after_expenses')),
  rate_bps bigint CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  window_fee_bps bigint CHECK (window_fee_bps IS NULL OR window_fee_bps BETWEEN 0 AND 10000),
  fixed_amount_yen bigint CHECK (fixed_amount_yen IS NULL OR fixed_amount_yen >= 0),
  advance_yen bigint NOT NULL DEFAULT 0 CHECK (advance_yen >= 0),
  min_payment_yen bigint CHECK (min_payment_yen IS NULL OR min_payment_yen >= 0),
  clause_reference text COLLATE "C" NOT NULL CHECK (length(trim(clause_reference)) BETWEEN 1 AND 500),
  reason text COLLATE "C" CHECK (reason IS NULL OR length(reason) <= 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, agreement_id, version_no),
  UNIQUE (org_id, agreement_id, effective_from),
  CHECK ((calc_method = 'rate' AND base_kind IS NOT NULL AND rate_bps IS NOT NULL AND fixed_amount_yen IS NULL AND ((base_kind IN ('after_window_fee', 'after_window_fee_and_expenses') AND window_fee_bps IS NOT NULL) OR (base_kind NOT IN ('after_window_fee', 'after_window_fee_and_expenses') AND window_fee_bps IS NULL))) OR (calc_method = 'fixed_monthly' AND fixed_amount_yen IS NOT NULL AND base_kind IS NULL AND rate_bps IS NULL AND window_fee_bps IS NULL) OR (calc_method = 'manual' AND base_kind IS NULL AND rate_bps IS NULL AND window_fee_bps IS NULL AND fixed_amount_yen IS NULL))
);
CREATE TABLE royalty_term_channels (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  channel_group text COLLATE "C" NOT NULL CHECK (channel_group IN ('theatrical', 'rental', 'sell', 'digital', 'broadcast', 'overseas', 'other')),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, term_version_id, channel_group)
);
CREATE TABLE royalty_term_expense_categories (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  category text COLLATE "C" NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 100),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, term_version_id, category)
);
CREATE TABLE royalty_schedule_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  agreement_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  statements_from text COLLATE "C" CHECK (statements_from IS NULL OR ((length(statements_from) = 7 AND ltrim(substr(statements_from, 1, 4), '0123456789') = '' AND substr(statements_from, 5, 1) = '-' AND ltrim(substr(statements_from, 6, 1), '01') = '' AND ltrim(substr(statements_from, 7, 1), '0123456789') = '') AND substr(statements_from, 6, 2) BETWEEN '01' AND '12')),
  reason text COLLATE "C" CHECK (reason IS NULL OR length(reason) <= 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, agreement_id, version_no)
);
CREATE TABLE royalty_schedule_phases (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  schedule_version_id bigint NOT NULL,
  starts_month text COLLATE "C" NOT NULL CHECK ((length(starts_month) = 7 AND ltrim(substr(starts_month, 1, 4), '0123456789') = '' AND substr(starts_month, 5, 1) = '-' AND ltrim(substr(starts_month, 6, 1), '01') = '' AND ltrim(substr(starts_month, 7, 1), '0123456789') = '') AND substr(starts_month, 6, 2) BETWEEN '01' AND '12'),
  ends_month text COLLATE "C" CHECK (ends_month IS NULL OR ((length(ends_month) = 7 AND ltrim(substr(ends_month, 1, 4), '0123456789') = '' AND substr(ends_month, 5, 1) = '-' AND ltrim(substr(ends_month, 6, 1), '01') = '' AND ltrim(substr(ends_month, 7, 1), '0123456789') = '') AND substr(ends_month, 6, 2) BETWEEN '01' AND '12')),
  cycle_kind text COLLATE "C" NOT NULL CHECK (cycle_kind IN ('monthly', 'quarterly', 'semiannual', 'annual', 'custom', 'manual', 'none')),
  anchor_month bigint CHECK (anchor_month IS NULL OR anchor_month BETWEEN 1 AND 12),
  custom_close_months text COLLATE "C" CHECK (custom_close_months IS NULL OR length(custom_close_months) BETWEEN 7 AND 2000),
  first_close_immediate bigint NOT NULL DEFAULT 0 CHECK (first_close_immediate IN (0, 1)),
  report_offset_months bigint NOT NULL DEFAULT 1 CHECK (report_offset_months BETWEEN 0 AND 24),
  report_day text COLLATE "C" NOT NULL DEFAULT 'eom' CHECK (report_day = 'eom' OR (length(report_day) = 1 AND ltrim(substr(report_day, 1, 1), '123456789') = '') OR (length(report_day) = 2 AND ltrim(substr(report_day, 1, 1), '12') = '' AND ltrim(substr(report_day, 2, 1), '0123456789') = '') OR (length(report_day) = 2 AND substr(report_day, 1, 1) = '3' AND ltrim(substr(report_day, 2, 1), '01') = '')),
  payment_offset_months bigint NOT NULL DEFAULT 2 CHECK (payment_offset_months BETWEEN 0 AND 24),
  payment_day text COLLATE "C" NOT NULL DEFAULT 'eom' CHECK (payment_day = 'eom' OR (length(payment_day) = 1 AND ltrim(substr(payment_day, 1, 1), '123456789') = '') OR (length(payment_day) = 2 AND ltrim(substr(payment_day, 1, 1), '12') = '' AND ltrim(substr(payment_day, 2, 1), '0123456789') = '') OR (length(payment_day) = 2 AND substr(payment_day, 1, 1) = '3' AND ltrim(substr(payment_day, 2, 1), '01') = '')),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (ends_month IS NULL OR ends_month >= starts_month),
  CHECK ((cycle_kind IN ('quarterly', 'semiannual', 'annual') AND anchor_month IS NOT NULL) OR (cycle_kind NOT IN ('quarterly', 'semiannual', 'annual') AND anchor_month IS NULL)),
  CHECK ((cycle_kind = 'custom' AND custom_close_months IS NOT NULL) OR (cycle_kind <> 'custom' AND custom_close_months IS NULL)),
  CHECK (first_close_immediate = 0 OR cycle_kind IN ('quarterly', 'semiannual', 'annual', 'custom'))
);
CREATE TABLE royalty_manual_accruals (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  agreement_id bigint NOT NULL,
  accrual_month text COLLATE "C" NOT NULL CHECK ((length(accrual_month) = 7 AND ltrim(substr(accrual_month, 1, 4), '0123456789') = '' AND substr(accrual_month, 5, 1) = '-' AND ltrim(substr(accrual_month, 6, 1), '01') = '' AND ltrim(substr(accrual_month, 7, 1), '0123456789') = '') AND substr(accrual_month, 6, 2) BETWEEN '01' AND '12'),
  amount_yen bigint NOT NULL CHECK (amount_yen <> 0),
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 200),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  reverses_entry_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX royalty_manual_accruals_source ON royalty_manual_accruals (org_id, agreement_id, accrual_month, source_reference) WHERE reverses_entry_id IS NULL;
CREATE UNIQUE INDEX royalty_manual_accruals_reversal ON royalty_manual_accruals (org_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE TABLE royalty_irregular_entries (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  holder_partner_id bigint NOT NULL,
  agreement_id bigint,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('adjust_amount', 'move_period', 'hold', 'release', 'note')),
  accrual_month text COLLATE "C" CHECK (accrual_month IS NULL OR ((length(accrual_month) = 7 AND ltrim(substr(accrual_month, 1, 4), '0123456789') = '' AND substr(accrual_month, 5, 1) = '-' AND ltrim(substr(accrual_month, 6, 1), '01') = '' AND ltrim(substr(accrual_month, 7, 1), '0123456789') = '') AND substr(accrual_month, 6, 2) BETWEEN '01' AND '12')),
  close_month text COLLATE "C" CHECK (close_month IS NULL OR ((length(close_month) = 7 AND ltrim(substr(close_month, 1, 4), '0123456789') = '' AND substr(close_month, 5, 1) = '-' AND ltrim(substr(close_month, 6, 1), '01') = '' AND ltrim(substr(close_month, 7, 1), '0123456789') = '') AND substr(close_month, 6, 2) BETWEEN '01' AND '12')),
  amount_yen bigint,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  source_reference text COLLATE "C" CHECK (source_reference IS NULL OR length(source_reference) <= 200),
  reverses_entry_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((kind = 'adjust_amount' AND close_month IS NOT NULL AND amount_yen IS NOT NULL AND amount_yen <> 0) OR (kind = 'move_period' AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND close_month IS NOT NULL AND close_month >= accrual_month AND amount_yen IS NULL) OR (kind IN ('hold', 'release') AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND close_month IS NULL AND amount_yen IS NULL) OR (kind = 'note' AND amount_yen IS NULL))
);
CREATE INDEX royalty_irregular_entries_by_holder ON royalty_irregular_entries (org_id, holder_partner_id);
CREATE UNIQUE INDEX royalty_irregular_entries_reversal ON royalty_irregular_entries (org_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE TABLE royalty_statements (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  holder_partner_id bigint NOT NULL,
  close_month text COLLATE "C" NOT NULL CHECK ((length(close_month) = 7 AND ltrim(substr(close_month, 1, 4), '0123456789') = '' AND substr(close_month, 5, 1) = '-' AND ltrim(substr(close_month, 6, 1), '01') = '' AND ltrim(substr(close_month, 7, 1), '0123456789') = '') AND substr(close_month, 6, 2) BETWEEN '01' AND '12'),
  report_due_on text COLLATE "C" CHECK (report_due_on IS NULL OR (length(report_due_on) = 10 AND ltrim(substr(report_due_on, 1, 4), '0123456789') = '' AND substr(report_due_on, 5, 1) = '-' AND ltrim(substr(report_due_on, 6, 1), '01') = '' AND ltrim(substr(report_due_on, 7, 1), '0123456789') = '' AND substr(report_due_on, 8, 1) = '-' AND ltrim(substr(report_due_on, 9, 1), '0123') = '' AND ltrim(substr(report_due_on, 10, 1), '0123456789') = '')),
  payment_due_on text COLLATE "C" CHECK (payment_due_on IS NULL OR (length(payment_due_on) = 10 AND ltrim(substr(payment_due_on, 1, 4), '0123456789') = '' AND substr(payment_due_on, 5, 1) = '-' AND ltrim(substr(payment_due_on, 6, 1), '01') = '' AND ltrim(substr(payment_due_on, 7, 1), '0123456789') = '' AND substr(payment_due_on, 8, 1) = '-' AND ltrim(substr(payment_due_on, 9, 1), '0123') = '' AND ltrim(substr(payment_due_on, 10, 1), '0123456789') = '')),
  version_no bigint NOT NULL CHECK (version_no > 0),
  previous_statement_id bigint,
  calculation_version text COLLATE "C" NOT NULL CHECK (calculation_version IN ('royalty-cycle-v1')),
  as_of text COLLATE "C" NOT NULL CHECK ((length(as_of) = 10 AND ltrim(substr(as_of, 1, 4), '0123456789') = '' AND substr(as_of, 5, 1) = '-' AND ltrim(substr(as_of, 6, 1), '01') = '' AND ltrim(substr(as_of, 7, 1), '0123456789') = '' AND substr(as_of, 8, 1) = '-' AND ltrim(substr(as_of, 9, 1), '0123') = '' AND ltrim(substr(as_of, 10, 1), '0123456789') = '')),
  input_hash text COLLATE "C" NOT NULL CHECK (length(input_hash) = 64),
  calculation_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(calculation_json)),
  royalty_yen bigint NOT NULL,
  adjustment_yen bigint NOT NULL,
  advance_recouped_yen bigint NOT NULL,
  carried_in_yen bigint NOT NULL,
  payable_yen bigint NOT NULL CHECK (payable_yen >= 0),
  carried_out_yen bigint NOT NULL,
  hold_count bigint NOT NULL CHECK (hold_count >= 0),
  line_count bigint NOT NULL CHECK (line_count >= 0),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, holder_partner_id, close_month, version_no),
  CHECK (carried_in_yen + royalty_yen + adjustment_yen - advance_recouped_yen = payable_yen + carried_out_yen),
  CHECK (line_count > 0 OR (royalty_yen = 0 AND adjustment_yen = 0 AND advance_recouped_yen = 0))
);
CREATE INDEX royalty_statements_by_holder ON royalty_statements (org_id, holder_partner_id, close_month);
CREATE TABLE royalty_statement_voids (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  statement_id bigint NOT NULL,
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, statement_id)
);
CREATE TABLE royalty_statement_lines (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  statement_id bigint NOT NULL,
  line_no bigint NOT NULL CHECK (line_no > 0),
  line_kind text COLLATE "C" NOT NULL CHECK (line_kind IN ('accrual', 'revision', 'adjustment', 'advance_recoup')),
  agreement_id bigint,
  accrual_month text COLLATE "C" CHECK (accrual_month IS NULL OR ((length(accrual_month) = 7 AND ltrim(substr(accrual_month, 1, 4), '0123456789') = '' AND substr(accrual_month, 5, 1) = '-' AND ltrim(substr(accrual_month, 6, 1), '01') = '' AND ltrim(substr(accrual_month, 7, 1), '0123456789') = '') AND substr(accrual_month, 6, 2) BETWEEN '01' AND '12')),
  term_version_id bigint,
  irregular_entry_id bigint,
  sales_yen bigint,
  window_fee_yen bigint,
  expense_yen bigint,
  committee_income_yen bigint,
  base_yen bigint,
  rate_bps bigint CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  amount_yen bigint NOT NULL,
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, statement_id, line_no),
  CHECK ((line_kind IN ('accrual', 'revision') AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND irregular_entry_id IS NULL) OR (line_kind = 'adjustment' AND irregular_entry_id IS NOT NULL) OR (line_kind = 'advance_recoup' AND agreement_id IS NOT NULL AND accrual_month IS NULL AND irregular_entry_id IS NULL))
);
CREATE INDEX royalty_statement_lines_by_agreement ON royalty_statement_lines (org_id, agreement_id, accrual_month);
CREATE TABLE royalty_statement_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  statement_id bigint NOT NULL,
  event_kind text COLLATE "C" NOT NULL CHECK (event_kind IN ('reported', 'paid')),
  occurred_on text COLLATE "C" NOT NULL CHECK ((length(occurred_on) = 10 AND ltrim(substr(occurred_on, 1, 4), '0123456789') = '' AND substr(occurred_on, 5, 1) = '-' AND ltrim(substr(occurred_on, 6, 1), '01') = '' AND ltrim(substr(occurred_on, 7, 1), '0123456789') = '' AND substr(occurred_on, 8, 1) = '-' AND ltrim(substr(occurred_on, 9, 1), '0123') = '' AND ltrim(substr(occurred_on, 10, 1), '0123456789') = '')),
  amount_yen bigint,
  reference text COLLATE "C" CHECK (reference IS NULL OR length(trim(reference)) BETWEEN 1 AND 200),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 1000),
  reverses_event_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((event_kind = 'reported' AND amount_yen IS NULL) OR (event_kind = 'paid' AND amount_yen IS NOT NULL AND amount_yen > 0 AND reference IS NOT NULL)),
  CHECK (reverses_event_id IS NULL OR (note IS NOT NULL AND length(trim(note)) > 0))
);
CREATE INDEX royalty_statement_events_by_statement ON royalty_statement_events (org_id, statement_id);
CREATE UNIQUE INDEX royalty_statement_events_reversal ON royalty_statement_events (org_id, reverses_event_id) WHERE reverses_event_id IS NOT NULL;
CREATE TRIGGER royalty_agreements_no_update BEFORE UPDATE ON royalty_agreements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('ロイヤリティ契約は変更できません。条件版・サイクルの版を足してください');
CREATE TRIGGER royalty_agreements_no_delete BEFORE DELETE ON royalty_agreements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('ロイヤリティ契約は削除できません');
CREATE TRIGGER royalty_term_versions_no_update BEFORE UPDATE ON royalty_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('条件版は変更できません。新しい版を足してください');
CREATE TRIGGER royalty_term_versions_no_delete BEFORE DELETE ON royalty_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('条件版は削除できません');
CREATE FUNCTION royalty_term_versions_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM royalty_term_versions WHERE org_id = NEW.org_id AND agreement_id = NEW.agreement_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '条件版の版番号が連続していません。再読込してから追加してください';
  END IF;
  IF (EXISTS (SELECT 1 FROM royalty_term_versions WHERE org_id = NEW.org_id AND agreement_id = NEW.agreement_id AND effective_from >= NEW.effective_from)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '条件版の適用開始月は、前の版より後の月にしてください';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_term_versions_order BEFORE INSERT ON royalty_term_versions FOR EACH ROW EXECUTE FUNCTION royalty_term_versions_order_fn();
CREATE TRIGGER royalty_term_channels_no_update BEFORE UPDATE ON royalty_term_channels FOR EACH ROW EXECUTE FUNCTION lite_reject_change('条件版の対象流通は変更できません。新しい版を足してください');
CREATE TRIGGER royalty_term_channels_no_delete BEFORE DELETE ON royalty_term_channels FOR EACH ROW EXECUTE FUNCTION lite_reject_change('条件版の対象流通は削除できません');
CREATE FUNCTION royalty_term_channels_latest_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_term_versions v JOIN royalty_term_versions n ON n.org_id = v.org_id AND n.agreement_id = v.agreement_id AND n.version_no > v.version_no WHERE v.org_id = NEW.org_id AND v.id = NEW.term_version_id) OR EXISTS (SELECT 1 FROM royalty_statement_lines l WHERE l.org_id = NEW.org_id AND l.term_version_id = NEW.term_version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '対象流通は、報告書で使われる前の最新の条件版にだけ登録できます';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_term_channels_latest BEFORE INSERT ON royalty_term_channels FOR EACH ROW EXECUTE FUNCTION royalty_term_channels_latest_fn();
CREATE TRIGGER royalty_term_expense_categories_no_update BEFORE UPDATE ON royalty_term_expense_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('控除する経費の費目は変更できません。新しい版を足してください');
CREATE TRIGGER royalty_term_expense_categories_no_delete BEFORE DELETE ON royalty_term_expense_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('控除する経費の費目は削除できません');
CREATE FUNCTION royalty_term_expense_categories_base_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT base_kind FROM royalty_term_versions WHERE org_id = NEW.org_id AND id = NEW.term_version_id) IS NULL OR (SELECT base_kind FROM royalty_term_versions WHERE org_id = NEW.org_id AND id = NEW.term_version_id) NOT IN ('after_window_fee_and_expenses', 'committee_income_after_expenses')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '控除する経費の費目は、経費を差し引く基礎の条件版にだけ登録できます';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_term_expense_categories_base BEFORE INSERT ON royalty_term_expense_categories FOR EACH ROW EXECUTE FUNCTION royalty_term_expense_categories_base_fn();
CREATE FUNCTION royalty_term_expense_categories_latest_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_term_versions v JOIN royalty_term_versions n ON n.org_id = v.org_id AND n.agreement_id = v.agreement_id AND n.version_no > v.version_no WHERE v.org_id = NEW.org_id AND v.id = NEW.term_version_id) OR EXISTS (SELECT 1 FROM royalty_statement_lines l WHERE l.org_id = NEW.org_id AND l.term_version_id = NEW.term_version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '控除する経費の費目は、報告書で使われる前の最新の条件版にだけ登録できます';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_term_expense_categories_latest BEFORE INSERT ON royalty_term_expense_categories FOR EACH ROW EXECUTE FUNCTION royalty_term_expense_categories_latest_fn();
CREATE TRIGGER royalty_schedule_versions_no_update BEFORE UPDATE ON royalty_schedule_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('サイクルの版は変更できません。新しい版を足してください');
CREATE TRIGGER royalty_schedule_versions_no_delete BEFORE DELETE ON royalty_schedule_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('サイクルの版は削除できません');
CREATE FUNCTION royalty_schedule_versions_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM royalty_schedule_versions WHERE org_id = NEW.org_id AND agreement_id = NEW.agreement_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'サイクルの版番号が連続していません。再読込してから追加してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_schedule_versions_order BEFORE INSERT ON royalty_schedule_versions FOR EACH ROW EXECUTE FUNCTION royalty_schedule_versions_order_fn();
CREATE TRIGGER royalty_schedule_phases_no_update BEFORE UPDATE ON royalty_schedule_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('サイクルのフェーズは変更できません。新しい版を足してください');
CREATE TRIGGER royalty_schedule_phases_no_delete BEFORE DELETE ON royalty_schedule_phases FOR EACH ROW EXECUTE FUNCTION lite_reject_change('サイクルのフェーズは削除できません');
CREATE FUNCTION royalty_schedule_phases_valid_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_schedule_versions v JOIN royalty_schedule_versions n ON n.org_id = v.org_id AND n.agreement_id = v.agreement_id AND n.version_no > v.version_no WHERE v.org_id = NEW.org_id AND v.id = NEW.schedule_version_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'フェーズは最新のサイクルの版にだけ足せます';
  END IF;
  IF (EXISTS (SELECT 1 FROM royalty_schedule_phases p WHERE p.org_id = NEW.org_id AND p.schedule_version_id = NEW.schedule_version_id AND p.starts_month <= COALESCE(NEW.ends_month, '9999-12') AND NEW.starts_month <= COALESCE(p.ends_month, '9999-12'))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'サイクルのフェーズの期間が重なっています';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_schedule_phases_valid BEFORE INSERT ON royalty_schedule_phases FOR EACH ROW EXECUTE FUNCTION royalty_schedule_phases_valid_fn();
CREATE TRIGGER royalty_manual_accruals_no_update BEFORE UPDATE ON royalty_manual_accruals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('実額の計上は変更できません。取り消して計上し直してください');
CREATE TRIGGER royalty_manual_accruals_no_delete BEFORE DELETE ON royalty_manual_accruals FOR EACH ROW EXECUTE FUNCTION lite_reject_change('実額の計上は削除できません。取消の行を足してください');
CREATE FUNCTION royalty_manual_accruals_reversal_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM royalty_manual_accruals o WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_entry_id AND o.reverses_entry_id IS NULL AND o.agreement_id = NEW.agreement_id AND o.accrual_month = NEW.accrual_month AND o.amount_yen = - NEW.amount_yen)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取り消す実額の計上と、契約・計上月・金額（符号が反対）が一致しません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_manual_accruals_reversal BEFORE INSERT ON royalty_manual_accruals FOR EACH ROW EXECUTE FUNCTION royalty_manual_accruals_reversal_fn();
CREATE TRIGGER royalty_irregular_entries_no_update BEFORE UPDATE ON royalty_irregular_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('イレギュラーの記録は変更できません。取り消して記録し直してください');
CREATE TRIGGER royalty_irregular_entries_no_delete BEFORE DELETE ON royalty_irregular_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('イレギュラーの記録は削除できません。取消の行を足してください');
CREATE FUNCTION royalty_irregular_entries_valid_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.agreement_id IS NOT NULL AND (SELECT holder_partner_id FROM royalty_agreements WHERE org_id = NEW.org_id AND id = NEW.agreement_id) IS DISTINCT FROM NEW.holder_partner_id) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'イレギュラーの権利者が契約の権利者と一致しません';
  END IF;
  IF (NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM royalty_irregular_entries o WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_entry_id AND o.reverses_entry_id IS NULL AND o.kind = NEW.kind AND o.holder_partner_id = NEW.holder_partner_id AND o.agreement_id IS NOT DISTINCT FROM NEW.agreement_id AND o.accrual_month IS NOT DISTINCT FROM NEW.accrual_month AND o.close_month IS NOT DISTINCT FROM NEW.close_month AND o.amount_yen IS NOT DISTINCT FROM NEW.amount_yen)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取り消すイレギュラーの記録と内容が一致しません';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_irregular_entries_valid BEFORE INSERT ON royalty_irregular_entries FOR EACH ROW EXECUTE FUNCTION royalty_irregular_entries_valid_fn();
CREATE TRIGGER royalty_statements_no_update BEFORE UPDATE ON royalty_statements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告書の確定版は変更できません。取り消して作り直してください');
CREATE TRIGGER royalty_statements_no_delete BEFORE DELETE ON royalty_statements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告書の確定版は削除できません');
CREATE FUNCTION royalty_statements_valid_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_statements s WHERE s.org_id = NEW.org_id AND s.holder_partner_id = NEW.holder_partner_id AND s.close_month = NEW.close_month AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id = s.org_id AND v.statement_id = s.id))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'この権利者・締め月の報告書は作成済みです。取り消してから作り直してください';
  END IF;
  IF (NEW.version_no <> (SELECT COUNT(*) + 1 FROM royalty_statements s WHERE s.org_id = NEW.org_id AND s.holder_partner_id = NEW.holder_partner_id AND s.close_month = NEW.close_month)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告書の版番号が連続していません。再読込してから作成してください';
  END IF;
  IF (EXISTS (SELECT 1 FROM royalty_statements s WHERE s.org_id = NEW.org_id AND s.holder_partner_id = NEW.holder_partner_id AND s.close_month > NEW.close_month AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id = s.org_id AND v.statement_id = s.id))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '後の締め月の報告書が作成済みのため、この締め月の報告書は作れません';
  END IF;
  IF (NEW.previous_statement_id IS DISTINCT FROM (SELECT s.id FROM royalty_statements s WHERE s.org_id = NEW.org_id AND s.holder_partner_id = NEW.holder_partner_id AND s.close_month < NEW.close_month AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id = s.org_id AND v.statement_id = s.id) ORDER BY s.close_month DESC LIMIT 1)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '前の報告書が最新ではありません。再読込してから作成してください';
  END IF;
  IF (NEW.carried_in_yen <> COALESCE((SELECT carried_out_yen FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.previous_statement_id), 0)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '前期繰越が前の報告書の翌期繰越と一致しません';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statements_valid BEFORE INSERT ON royalty_statements FOR EACH ROW EXECUTE FUNCTION royalty_statements_valid_fn();
CREATE TRIGGER royalty_statement_voids_no_update BEFORE UPDATE ON royalty_statement_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告書の取消記録は変更できません');
CREATE TRIGGER royalty_statement_voids_no_delete BEFORE DELETE ON royalty_statement_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告書の取消記録は削除できません');
CREATE FUNCTION royalty_statement_voids_valid_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_statements t JOIN royalty_statements s ON s.org_id = t.org_id AND s.holder_partner_id = t.holder_partner_id AND s.close_month > t.close_month WHERE t.org_id = NEW.org_id AND t.id = NEW.statement_id AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id = s.org_id AND v.statement_id = s.id))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '後の締め月の報告書があるため取り消せません。後の報告書から順に取り消してください';
  END IF;
  IF (EXISTS (SELECT 1 FROM royalty_statement_events e WHERE e.org_id = NEW.org_id AND e.statement_id = NEW.statement_id AND e.event_kind = 'paid' AND e.reverses_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM royalty_statement_events r WHERE r.org_id = e.org_id AND r.reverses_event_id = e.id))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '支払の記録があるため取り消せません。先に支払の記録を取り消してください';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statement_voids_valid BEFORE INSERT ON royalty_statement_voids FOR EACH ROW EXECUTE FUNCTION royalty_statement_voids_valid_fn();
CREATE TRIGGER royalty_statement_lines_no_update BEFORE UPDATE ON royalty_statement_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告書の明細は変更できません');
CREATE TRIGGER royalty_statement_lines_no_delete BEFORE DELETE ON royalty_statement_lines FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告書の明細は削除できません');
CREATE FUNCTION royalty_statement_lines_valid_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT COUNT(*) FROM royalty_statement_lines l WHERE l.org_id = NEW.org_id AND l.statement_id = NEW.statement_id) >= (SELECT line_count FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告書の明細の行数が確定版と一致しません';
  END IF;
  IF (NEW.agreement_id IS NOT NULL AND (SELECT holder_partner_id FROM royalty_agreements WHERE org_id = NEW.org_id AND id = NEW.agreement_id) IS DISTINCT FROM (SELECT holder_partner_id FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '明細の契約の権利者が報告書の権利者と一致しません';
  END IF;
  IF (NEW.irregular_entry_id IS NOT NULL AND (SELECT holder_partner_id FROM royalty_irregular_entries WHERE org_id = NEW.org_id AND id = NEW.irregular_entry_id) IS DISTINCT FROM (SELECT holder_partner_id FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '明細のイレギュラーの権利者が報告書の権利者と一致しません';
  END IF;
  IF (EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id = NEW.org_id AND v.statement_id = NEW.statement_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取り消した報告書には明細を足せません';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statement_lines_valid BEFORE INSERT ON royalty_statement_lines FOR EACH ROW EXECUTE FUNCTION royalty_statement_lines_valid_fn();
CREATE FUNCTION royalty_statement_lines_complete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT COUNT(*) FROM royalty_statement_lines l WHERE l.org_id = NEW.org_id AND l.statement_id = NEW.statement_id) = (SELECT line_count FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id)) IS NOT TRUE THEN RETURN NULL; END IF;
  IF ((SELECT COALESCE(SUM(amount_yen), 0) FROM royalty_statement_lines WHERE org_id = NEW.org_id AND statement_id = NEW.statement_id AND line_kind IN ('accrual', 'revision')) <> (SELECT royalty_yen FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id) OR (SELECT COALESCE(SUM(amount_yen), 0) FROM royalty_statement_lines WHERE org_id = NEW.org_id AND statement_id = NEW.statement_id AND line_kind = 'adjustment') <> (SELECT adjustment_yen FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id) OR (SELECT COALESCE(SUM(amount_yen), 0) FROM royalty_statement_lines WHERE org_id = NEW.org_id AND statement_id = NEW.statement_id AND line_kind = 'advance_recoup') <> (SELECT advance_recouped_yen FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告書の明細の和が確定版の金額と一致しません';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER royalty_statement_lines_complete AFTER INSERT ON royalty_statement_lines FOR EACH ROW EXECUTE FUNCTION royalty_statement_lines_complete_fn();
CREATE TRIGGER royalty_statement_events_no_update BEFORE UPDATE ON royalty_statement_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告・支払の記録は変更できません。取消の記録を足してください');
CREATE TRIGGER royalty_statement_events_no_delete BEFORE DELETE ON royalty_statement_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告・支払の記録は削除できません。取消の記録を足してください');
CREATE FUNCTION royalty_statement_events_valid_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id = NEW.org_id AND v.statement_id = NEW.statement_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取り消した報告書には報告・支払を記録できません';
  END IF;
  IF (NEW.reverses_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM royalty_statement_events o WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_event_id AND o.statement_id = NEW.statement_id AND o.reverses_event_id IS NULL AND o.event_kind = NEW.event_kind AND o.amount_yen IS NOT DISTINCT FROM NEW.amount_yen AND o.occurred_on <= NEW.occurred_on)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取り消す記録と、報告書・種類・金額・日付が一致しません';
  END IF;
  IF (NEW.reverses_event_id IS NULL AND NEW.event_kind = 'reported' AND EXISTS (SELECT 1 FROM royalty_statement_events e WHERE e.org_id = NEW.org_id AND e.statement_id = NEW.statement_id AND e.event_kind = 'reported' AND e.reverses_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM royalty_statement_events r WHERE r.org_id = e.org_id AND r.reverses_event_id = e.id))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告の記録は登録済みです。日付を直すときは取り消してから記録してください';
  END IF;
  IF (NEW.reverses_event_id IS NULL AND NEW.event_kind = 'paid' AND COALESCE((SELECT SUM(e.amount_yen) FROM royalty_statement_events e WHERE e.org_id = NEW.org_id AND e.statement_id = NEW.statement_id AND e.event_kind = 'paid' AND e.reverses_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM royalty_statement_events r WHERE r.org_id = e.org_id AND r.reverses_event_id = e.id)), 0) + NEW.amount_yen > (SELECT payable_yen FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '支払の合計が報告書の支払予定額を超えます';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statement_events_valid BEFORE INSERT ON royalty_statement_events FOR EACH ROW EXECUTE FUNCTION royalty_statement_events_valid_fn();
CREATE FUNCTION royalty_schedule_versions_statements_from_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.statements_from IS NOT NULL AND EXISTS (SELECT 1 FROM royalty_statement_lines l JOIN royalty_statements s ON s.org_id = l.org_id AND s.id = l.statement_id WHERE l.org_id = NEW.org_id AND l.agreement_id = NEW.agreement_id AND s.close_month < NEW.statements_from AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id = s.org_id AND v.statement_id = s.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '確定版がある締め月は移行前（以前の仕組みで報告済み）にできません。報告書を作り始める締め月を、この契約の明細を含む最初の確定版の締め月以前にしてください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_schedule_versions_statements_from BEFORE INSERT ON royalty_schedule_versions FOR EACH ROW EXECUTE FUNCTION royalty_schedule_versions_statements_from_fn();
CREATE TABLE royalty_statement_calculation_parts (
  org_id bigint NOT NULL,
  statement_id bigint NOT NULL,
  part_no bigint NOT NULL CHECK (part_no > 0),
  body text COLLATE "C" NOT NULL CHECK (length(convert_to(body, 'UTF8')) BETWEEN 1 AND 100000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, statement_id, part_no)
);
CREATE TRIGGER royalty_statement_calculation_parts_no_update BEFORE UPDATE ON royalty_statement_calculation_parts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告書の計算の内容は変更できません');
CREATE TRIGGER royalty_statement_calculation_parts_no_delete BEFORE DELETE ON royalty_statement_calculation_parts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('報告書の計算の内容は削除できません');
CREATE FUNCTION royalty_statement_calculation_parts_valid_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.part_no <> (SELECT COUNT(*) + 1 FROM royalty_statement_calculation_parts p WHERE p.org_id = NEW.org_id AND p.statement_id = NEW.statement_id) OR NEW.part_no > COALESCE((SELECT lite_cast_int(lite_json_extract(calculation_json, '$.calculationParts')) FROM royalty_statements WHERE org_id = NEW.org_id AND id = NEW.statement_id), 0)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告書の計算の内容の分割が確定版の記録と一致しません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statement_calculation_parts_valid BEFORE INSERT ON royalty_statement_calculation_parts FOR EACH ROW EXECUTE FUNCTION royalty_statement_calculation_parts_valid_fn();
CREATE FUNCTION royalty_agreements_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_agreements WHERE id = NEW.id) OR EXISTS (SELECT 1 FROM royalty_agreements WHERE org_id = NEW.org_id AND agreement_code = NEW.agreement_code)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ロイヤリティ契約は登録済みです（同じ番号・契約コードの行は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_agreements_no_replace BEFORE INSERT ON royalty_agreements FOR EACH ROW EXECUTE FUNCTION royalty_agreements_no_replace_fn();
CREATE FUNCTION royalty_term_versions_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_term_versions WHERE id = NEW.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '条件版は変更できません（同じ番号の行は置き換えられません）。新しい版を足してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_term_versions_no_replace BEFORE INSERT ON royalty_term_versions FOR EACH ROW EXECUTE FUNCTION royalty_term_versions_no_replace_fn();
CREATE FUNCTION royalty_term_channels_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_term_channels WHERE org_id = NEW.org_id AND term_version_id = NEW.term_version_id AND channel_group = NEW.channel_group)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '条件版の対象流通は登録済みです（行は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_term_channels_no_replace BEFORE INSERT ON royalty_term_channels FOR EACH ROW EXECUTE FUNCTION royalty_term_channels_no_replace_fn();
CREATE FUNCTION royalty_term_expense_categories_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_term_expense_categories WHERE org_id = NEW.org_id AND term_version_id = NEW.term_version_id AND category = NEW.category)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '控除する経費の費目は登録済みです（行は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_term_expense_categories_no_replace BEFORE INSERT ON royalty_term_expense_categories FOR EACH ROW EXECUTE FUNCTION royalty_term_expense_categories_no_replace_fn();
CREATE FUNCTION royalty_schedule_versions_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_schedule_versions WHERE id = NEW.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'サイクルの版は変更できません（同じ番号の行は置き換えられません）。新しい版を足してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_schedule_versions_no_replace BEFORE INSERT ON royalty_schedule_versions FOR EACH ROW EXECUTE FUNCTION royalty_schedule_versions_no_replace_fn();
CREATE FUNCTION royalty_schedule_phases_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_schedule_phases WHERE id = NEW.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'サイクルのフェーズは変更できません（同じ番号の行は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_schedule_phases_no_replace BEFORE INSERT ON royalty_schedule_phases FOR EACH ROW EXECUTE FUNCTION royalty_schedule_phases_no_replace_fn();
CREATE FUNCTION royalty_manual_accruals_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_manual_accruals WHERE id = NEW.id) OR (NEW.reverses_entry_id IS NULL AND EXISTS (SELECT 1 FROM royalty_manual_accruals WHERE org_id = NEW.org_id AND agreement_id = NEW.agreement_id AND accrual_month = NEW.accrual_month AND source_reference = NEW.source_reference AND reverses_entry_id IS NULL)) OR (NEW.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM royalty_manual_accruals WHERE org_id = NEW.org_id AND reverses_entry_id = NEW.reverses_entry_id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '実額の計上は変更できません（同じ番号・同じ元資料の計上・取消済みの計上の行は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_manual_accruals_no_replace BEFORE INSERT ON royalty_manual_accruals FOR EACH ROW EXECUTE FUNCTION royalty_manual_accruals_no_replace_fn();
CREATE FUNCTION royalty_irregular_entries_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_irregular_entries WHERE id = NEW.id) OR (NEW.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM royalty_irregular_entries WHERE org_id = NEW.org_id AND reverses_entry_id = NEW.reverses_entry_id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'イレギュラーの記録は変更できません（同じ番号の行・取消済みの記録の取消は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_irregular_entries_no_replace BEFORE INSERT ON royalty_irregular_entries FOR EACH ROW EXECUTE FUNCTION royalty_irregular_entries_no_replace_fn();
CREATE FUNCTION royalty_statements_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_statements WHERE id = NEW.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告書の確定版は変更できません（同じ番号の行は置き換えられません）。再読込してから作成してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statements_no_replace BEFORE INSERT ON royalty_statements FOR EACH ROW EXECUTE FUNCTION royalty_statements_no_replace_fn();
CREATE FUNCTION royalty_statement_voids_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_statement_voids WHERE id = NEW.id) OR EXISTS (SELECT 1 FROM royalty_statement_voids WHERE org_id = NEW.org_id AND statement_id = NEW.statement_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告書の取消記録は変更できません（取消済みの報告書・同じ番号の行は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statement_voids_no_replace BEFORE INSERT ON royalty_statement_voids FOR EACH ROW EXECUTE FUNCTION royalty_statement_voids_no_replace_fn();
CREATE FUNCTION royalty_statement_lines_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_statement_lines WHERE id = NEW.id) OR EXISTS (SELECT 1 FROM royalty_statement_lines WHERE org_id = NEW.org_id AND statement_id = NEW.statement_id AND line_no = NEW.line_no)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告書の明細は変更できません（同じ番号・同じ行番号の行は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statement_lines_no_replace BEFORE INSERT ON royalty_statement_lines FOR EACH ROW EXECUTE FUNCTION royalty_statement_lines_no_replace_fn();
CREATE FUNCTION royalty_statement_events_no_replace_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM royalty_statement_events WHERE id = NEW.id) OR (NEW.reverses_event_id IS NOT NULL AND EXISTS (SELECT 1 FROM royalty_statement_events WHERE org_id = NEW.org_id AND reverses_event_id = NEW.reverses_event_id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '報告・支払の記録は変更できません（同じ番号の行・取消済みの記録の取消は置き換えられません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER royalty_statement_events_no_replace BEFORE INSERT ON royalty_statement_events FOR EACH ROW EXECUTE FUNCTION royalty_statement_events_no_replace_fn();
CREATE TABLE committee_term_window_fee_shares (
  org_id bigint NOT NULL,
  window_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  share_bps bigint NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, window_id, partner_id)
);
CREATE TRIGGER committee_window_fee_shares_no_update BEFORE UPDATE ON committee_term_window_fee_shares FOR EACH ROW EXECUTE FUNCTION lite_reject_change('窓口手数料の取り分は変更できません。新しい条件版で登録してください');
CREATE TRIGGER committee_window_fee_shares_no_delete BEFORE DELETE ON committee_term_window_fee_shares FOR EACH ROW EXECUTE FUNCTION lite_reject_change('窓口手数料の取り分は削除できません');
CREATE FUNCTION committee_window_fee_shares_total_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT COALESCE(SUM(share_bps), 0) FROM committee_term_window_fee_shares WHERE org_id = NEW.org_id AND window_id = NEW.window_id) + NEW.share_bps > 10000) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '窓口手数料の取り分の合計は100%以内にしてください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_window_fee_shares_total BEFORE INSERT ON committee_term_window_fee_shares FOR EACH ROW EXECUTE FUNCTION committee_window_fee_shares_total_fn();
CREATE TABLE committee_term_version_effective (
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  effective_from text COLLATE "C" NOT NULL CHECK ((length(effective_from) = 7 AND ltrim(substr(effective_from, 1, 4), '0123456789') = '' AND substr(effective_from, 5, 1) = '-' AND ltrim(substr(effective_from, 6, 1), '01') = '' AND ltrim(substr(effective_from, 7, 1), '0123456789') = '') AND substr(effective_from, 6, 2) BETWEEN '01' AND '12'),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, term_version_id)
);
CREATE TRIGGER committee_term_version_effective_no_update BEFORE UPDATE ON committee_term_version_effective FOR EACH ROW EXECUTE FUNCTION lite_reject_change('条件版の適用開始月は変更できません。新しい条件版で登録してください');
CREATE TRIGGER committee_term_version_effective_no_delete BEFORE DELETE ON committee_term_version_effective FOR EACH ROW EXECUTE FUNCTION lite_reject_change('条件版の適用開始月は削除できません');
CREATE INDEX committee_sale_lines_product_month_idx ON sale_lines (org_id, product_id, accounting_month);
CREATE INDEX committee_sale_lines_work_month_idx ON sale_lines (org_id, work_id, accounting_month);
CREATE INDEX committee_product_works_work_idx ON product_works (org_id, work_id, product_id);
CREATE TABLE sales_source_files (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  storage text COLLATE "C" NOT NULL CHECK (storage IN ('inline', 'legacy_artifact')),
  file_name text COLLATE "C" NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 240),
  media_type text COLLATE "C",
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  raw_sha256 text COLLATE "C" NOT NULL CHECK (length(raw_sha256) = 64),
  original_base64 text COLLATE "C",
  extraction_json text COLLATE "C",
  extractor_name text COLLATE "C" NOT NULL,
  extractor_version text COLLATE "C" NOT NULL,
  extraction_status text COLLATE "C" NOT NULL CHECK (extraction_status IN ('extracted', 'ocr_pending')),
  legacy_artifact_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, raw_sha256),
  UNIQUE (org_id, legacy_artifact_id),
  CHECK ((storage = 'inline' AND original_base64 IS NOT NULL AND extraction_json IS NOT NULL AND legacy_artifact_id IS NULL) OR (storage = 'legacy_artifact' AND original_base64 IS NULL AND extraction_json IS NULL AND legacy_artifact_id IS NOT NULL))
);
CREATE TABLE sales_source_selections (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  file_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  sheet_name text COLLATE "C" NOT NULL,
  header_row bigint NOT NULL CHECK (header_row > 0),
  canonical_csv text COLLATE "C" NOT NULL,
  canonical_sha256 text COLLATE "C" NOT NULL CHECK (length(canonical_sha256) = 64),
  source_rows_json text COLLATE "C" NOT NULL,
  excluded_json text COLLATE "C" NOT NULL DEFAULT '[]',
  suggestions_json text COLLATE "C" NOT NULL DEFAULT '[]',
  suggestion_source text COLLATE "C" NOT NULL CHECK (suggestion_source IN ('rule-based', 'imported-ai', 'configured-ai')),
  legacy_selection_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, file_id, id),
  UNIQUE (org_id, file_id, version_no)
);
CREATE TABLE sales_source_bindings (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  file_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  mode text COLLATE "C" NOT NULL CHECK (mode IN ('single_work', 'by_product', 'by_work_column')),
  project_id bigint,
  work_id bigint,
  product_column text COLLATE "C",
  work_column text COLLATE "C",
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, file_id, id),
  UNIQUE (org_id, file_id, version_no),
  CHECK ((mode = 'single_work' AND project_id IS NOT NULL AND work_id IS NOT NULL AND product_column IS NULL AND work_column IS NULL) OR (mode = 'by_product' AND project_id IS NULL AND work_id IS NULL AND length(trim(product_column)) BETWEEN 1 AND 200 AND work_column IS NULL) OR (mode = 'by_work_column' AND project_id IS NULL AND work_id IS NULL AND length(trim(work_column)) BETWEEN 1 AND 200 AND (product_column IS NULL OR length(trim(product_column)) BETWEEN 1 AND 200)))
);
CREATE TABLE sales_source_partitions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  file_id bigint NOT NULL,
  selection_id bigint NOT NULL,
  binding_id bigint NOT NULL,
  plan_sha256 text COLLATE "C" NOT NULL CHECK (length(plan_sha256) = 64),
  project_id bigint NOT NULL,
  work_id bigint NOT NULL,
  row_count bigint NOT NULL CHECK (row_count > 0),
  source_rows_json text COLLATE "C" NOT NULL,
  product_map_json text COLLATE "C" NOT NULL DEFAULT '[]',
  partition_sha256 text COLLATE "C" NOT NULL CHECK (length(partition_sha256) = 64),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, id),
  UNIQUE (org_id, file_id, id),
  UNIQUE (org_id, binding_id, selection_id, plan_sha256, work_id)
);
CREATE TABLE sales_source_commits (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  file_id bigint NOT NULL,
  partition_id bigint NOT NULL,
  binding_id bigint NOT NULL,
  selection_id bigint NOT NULL,
  work_id bigint NOT NULL,
  mapping_version_id bigint NOT NULL,
  report_id bigint NOT NULL,
  preview_token text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, partition_id),
  UNIQUE (org_id, report_id),
  UNIQUE (preview_token)
);
CREATE INDEX sales_source_commits_file_idx ON sales_source_commits (org_id, file_id);
CREATE TRIGGER sales_source_files_no_update BEFORE UPDATE ON sales_source_files FOR EACH ROW EXECUTE FUNCTION lite_reject_change('受領した原本は変更できません');
CREATE TRIGGER sales_source_files_no_delete BEFORE DELETE ON sales_source_files FOR EACH ROW EXECUTE FUNCTION lite_reject_change('受領した原本は削除できません');
CREATE TRIGGER sales_source_selections_no_update BEFORE UPDATE ON sales_source_selections FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の表の選択は変更できません。新しい版を作ってください');
CREATE TRIGGER sales_source_selections_no_delete BEFORE DELETE ON sales_source_selections FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の表の選択は削除できません');
CREATE TRIGGER sales_source_bindings_no_update BEFORE UPDATE ON sales_source_bindings FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の割り当ては変更できません。付け替えは新しい版で行います');
CREATE TRIGGER sales_source_bindings_no_delete BEFORE DELETE ON sales_source_bindings FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の割り当ては削除できません');
CREATE TRIGGER sales_source_partitions_no_update BEFORE UPDATE ON sales_source_partitions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の分割は変更できません');
CREATE TRIGGER sales_source_partitions_no_delete BEFORE DELETE ON sales_source_partitions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の分割は削除できません');
CREATE TRIGGER sales_source_commits_no_update BEFORE UPDATE ON sales_source_commits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の分割の登録は変更できません');
CREATE TRIGGER sales_source_commits_no_delete BEFORE DELETE ON sales_source_commits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('原本の分割の登録は削除できません');
CREATE FUNCTION sales_source_files_inline_not_legacy_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.storage = 'inline' AND EXISTS (SELECT 1 FROM workflow_raw_artifacts a WHERE a.org_id = NEW.org_id AND a.kind = 'sales_report' AND a.raw_sha256 = NEW.raw_sha256)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '同じ原本が旧方式の原本として保存済みです。その原本を引き継いでください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_files_inline_not_legacy BEFORE INSERT ON sales_source_files FOR EACH ROW EXECUTE FUNCTION sales_source_files_inline_not_legacy_fn();
CREATE FUNCTION sales_source_files_legacy_takeover_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.storage = 'legacy_artifact' AND (NOT EXISTS (SELECT 1 FROM workflow_raw_artifacts a WHERE a.org_id = NEW.org_id AND a.id = NEW.legacy_artifact_id AND a.kind = 'sales_report' AND a.raw_sha256 = NEW.raw_sha256 AND a.byte_length = NEW.byte_length) OR EXISTS (SELECT 1 FROM workflow_report_commits x WHERE x.org_id = NEW.org_id AND x.artifact_id = NEW.legacy_artifact_id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '引き継げない旧方式の原本です（売上報告でない・中身が一致しない・旧方式で登録済みのいずれか）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_files_legacy_takeover BEFORE INSERT ON sales_source_files FOR EACH ROW EXECUTE FUNCTION sales_source_files_legacy_takeover_fn();
CREATE FUNCTION sales_source_selections_before_commit_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM sales_source_commits x WHERE x.org_id = NEW.org_id AND x.file_id = NEW.file_id) OR NEW.version_no <> COALESCE((SELECT max(s.version_no) FROM sales_source_selections s WHERE s.org_id = NEW.org_id AND s.file_id = NEW.file_id), 0) + 1) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '登録を始めた原本の表の選択は変えられません（または版番号が連番ではありません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_selections_before_commit BEFORE INSERT ON sales_source_selections FOR EACH ROW EXECUTE FUNCTION sales_source_selections_before_commit_fn();
CREATE FUNCTION sales_source_selections_legacy_match_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.legacy_selection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow_report_selections s JOIN sales_source_files f ON f.org_id = s.org_id AND f.legacy_artifact_id = s.artifact_id WHERE s.org_id = NEW.org_id AND s.id = NEW.legacy_selection_id AND f.id = NEW.file_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '引き継ぐ旧選択がこの原本のものではありません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_selections_legacy_match BEFORE INSERT ON sales_source_selections FOR EACH ROW EXECUTE FUNCTION sales_source_selections_legacy_match_fn();
CREATE FUNCTION sales_source_bindings_before_commit_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM sales_source_commits x WHERE x.org_id = NEW.org_id AND x.file_id = NEW.file_id) OR NEW.version_no <> COALESCE((SELECT max(b.version_no) FROM sales_source_bindings b WHERE b.org_id = NEW.org_id AND b.file_id = NEW.file_id), 0) + 1) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '登録を始めた原本は付け替えられません（または版番号が連番ではありません）';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_bindings_before_commit BEFORE INSERT ON sales_source_bindings FOR EACH ROW EXECUTE FUNCTION sales_source_bindings_before_commit_fn();
CREATE FUNCTION sales_source_partitions_consistent_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.binding_id <> (SELECT b.id FROM sales_source_bindings b WHERE b.org_id = NEW.org_id AND b.file_id = NEW.file_id ORDER BY b.version_no DESC LIMIT 1) OR NEW.selection_id <> (SELECT s.id FROM sales_source_selections s WHERE s.org_id = NEW.org_id AND s.file_id = NEW.file_id ORDER BY s.version_no DESC LIMIT 1) OR EXISTS (SELECT 1 FROM sales_source_bindings b WHERE b.org_id = NEW.org_id AND b.id = NEW.binding_id AND b.mode = 'single_work' AND b.work_id <> NEW.work_id) OR EXISTS (SELECT 1 FROM sales_source_commits x WHERE x.org_id = NEW.org_id AND x.file_id = NEW.file_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '原本の分割は、最新の割り当てと表の選択で、登録を始める前に作ります';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_partitions_consistent BEFORE INSERT ON sales_source_partitions FOR EACH ROW EXECUTE FUNCTION sales_source_partitions_consistent_fn();
CREATE FUNCTION sales_source_commits_consistent_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM sales_source_partitions p WHERE p.org_id = NEW.org_id AND p.id = NEW.partition_id AND p.file_id = NEW.file_id AND p.binding_id = NEW.binding_id AND p.selection_id = NEW.selection_id AND p.work_id = NEW.work_id) OR NEW.binding_id <> (SELECT b.id FROM sales_source_bindings b WHERE b.org_id = NEW.org_id AND b.file_id = NEW.file_id ORDER BY b.version_no DESC LIMIT 1) OR NEW.selection_id <> (SELECT s.id FROM sales_source_selections s WHERE s.org_id = NEW.org_id AND s.file_id = NEW.file_id ORDER BY s.version_no DESC LIMIT 1) OR EXISTS (SELECT 1 FROM sales_source_commits x JOIN sales_source_partitions xp ON xp.org_id = x.org_id AND xp.id = x.partition_id WHERE x.org_id = NEW.org_id AND x.file_id = NEW.file_id AND (x.binding_id <> NEW.binding_id OR x.selection_id <> NEW.selection_id OR xp.plan_sha256 <> (SELECT p.plan_sha256 FROM sales_source_partitions p WHERE p.org_id = NEW.org_id AND p.id = NEW.partition_id)))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '原本の割り当てか表の選択が更新されたため、この分割は登録できません。割り当てからやり直してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_commits_consistent BEFORE INSERT ON sales_source_commits FOR EACH ROW EXECUTE FUNCTION sales_source_commits_consistent_fn();
CREATE FUNCTION sales_source_commits_same_terms_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM sales_source_commits x JOIN report_imports r ON r.org_id = x.org_id AND r.id = x.report_id JOIN report_imports n ON n.org_id = NEW.org_id AND n.id = NEW.report_id WHERE x.org_id = NEW.org_id AND x.file_id = NEW.file_id AND (r.partner_id IS DISTINCT FROM n.partner_id OR r.kind <> n.kind))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '1つの原本から分けた報告は、最初の登録と同じ取引先・報告の種類で登録します';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_source_commits_same_terms BEFORE INSERT ON sales_source_commits FOR EACH ROW EXECUTE FUNCTION sales_source_commits_same_terms_fn();
CREATE TABLE org_switch_events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  from_org_id bigint NOT NULL,
  at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (org_id <> from_org_id)
);
CREATE TRIGGER org_switch_events_no_update BEFORE UPDATE ON org_switch_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('組織の切替の記録は変更できません');
CREATE TRIGGER org_switch_events_no_delete BEFORE DELETE ON org_switch_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('組織の切替の記録は削除できません');

-- ===== 0004_eigyo_sales_sheet.sql =====
CREATE TABLE release_window_types (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  type_key text COLLATE "C" NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, type_key),
  CHECK (length(type_key) BETWEEN 1 AND 40 AND (length(substr(type_key, 1, 1)) = 1 AND ltrim(substr(substr(type_key, 1, 1), 1, 1), 'abcdefghijklmnopqrstuvwxyz') = '') AND (NOT (ltrim(type_key, 'abcdefghijklmnopqrstuvwxyz0123456789_') <> '')))
);
CREATE TABLE release_window_type_versions (
  org_id bigint NOT NULL,
  type_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 40),
  group_label text COLLATE "C" NOT NULL CHECK (length(trim(group_label)) BETWEEN 1 AND 40),
  family text COLLATE "C" NOT NULL CHECK (family IN ('theatrical', 'digital', 'package', 'broadcast', 'overseas', 'other')),
  date_mode text COLLATE "C" NOT NULL CHECK (date_mode IN ('point', 'period')),
  start_label text COLLATE "C" NOT NULL CHECK (length(trim(start_label)) BETWEEN 1 AND 30),
  end_label text COLLATE "C",
  has_announce bigint NOT NULL CHECK (has_announce IN (0, 1)),
  default_territory text COLLATE "C" NOT NULL DEFAULT '日本' CHECK (length(trim(default_territory)) BETWEEN 1 AND 100),
  sort_order bigint NOT NULL CHECK (sort_order BETWEEN 0 AND 100000),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, type_id, version_no),
  CHECK ((date_mode = 'point' AND end_label IS NULL) OR (date_mode = 'period' AND end_label IS NOT NULL AND length(trim(end_label)) BETWEEN 1 AND 30))
);
CREATE TABLE release_window_type_fields (
  org_id bigint NOT NULL,
  type_id bigint NOT NULL,
  version_no bigint NOT NULL,
  field_key text COLLATE "C" NOT NULL,
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 30),
  value_type text COLLATE "C" NOT NULL CHECK (value_type IN ('date', 'integer', 'yen', 'text', 'choice')),
  choice_domain text COLLATE "C",
  sort_order bigint NOT NULL CHECK (sort_order BETWEEN 0 AND 1000),
  PRIMARY KEY (org_id, type_id, version_no, field_key),
  CHECK (length(field_key) BETWEEN 1 AND 40 AND (length(substr(field_key, 1, 1)) = 1 AND ltrim(substr(substr(field_key, 1, 1), 1, 1), 'abcdefghijklmnopqrstuvwxyz') = '') AND (NOT (ltrim(field_key, 'abcdefghijklmnopqrstuvwxyz0123456789_') <> ''))),
  CHECK ((value_type = 'choice' AND length(choice_domain) BETWEEN 1 AND 40) OR (value_type <> 'choice' AND choice_domain IS NULL))
);
CREATE TABLE release_window_type_distributions (
  org_id bigint NOT NULL,
  type_id bigint NOT NULL,
  version_no bigint NOT NULL,
  distribution_code text COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, type_id, version_no, distribution_code)
);
CREATE TABLE work_release_windows (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  type_id bigint NOT NULL,
  territory text COLLATE "C" NOT NULL DEFAULT '日本' CHECK (length(trim(territory)) BETWEEN 1 AND 100),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, work_id, type_id, territory)
);
CREATE TABLE work_release_window_versions (
  org_id bigint NOT NULL,
  window_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  type_version_no bigint NOT NULL CHECK (type_version_no > 0),
  start_on text COLLATE "C",
  end_on text COLLATE "C",
  announce_on text COLLATE "C",
  date_precision text COLLATE "C" NOT NULL CHECK (date_precision IN ('day', 'month', 'range', 'year', 'tbd')),
  timing_raw text COLLATE "C" CHECK (timing_raw IS NULL OR length(trim(timing_raw)) BETWEEN 1 AND 200),
  status text COLLATE "C" NOT NULL CHECK (status IN ('draft', 'confirmed', 'withdrawn')),
  availability_version_id bigint,
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('manual', 'excel_import', 'from_availability')),
  source_reference text COLLATE "C" CHECK (source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  import_batch_id text COLLATE "C" CHECK (import_batch_id IS NULL OR length(import_batch_id) BETWEEN 1 AND 80),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, window_id, version_no),
  CHECK ((date_precision = 'day' AND (length(start_on) = 10 AND ltrim(substr(start_on, 1, 4), '0123456789') = '' AND substr(start_on, 5, 1) = '-' AND ltrim(substr(start_on, 6, 1), '01') = '' AND ltrim(substr(start_on, 7, 1), '0123456789') = '' AND substr(start_on, 8, 1) = '-' AND ltrim(substr(start_on, 9, 1), '0123') = '' AND ltrim(substr(start_on, 10, 1), '0123456789') = '')) OR (date_precision = 'month' AND (length(start_on) = 7 AND ltrim(substr(start_on, 1, 4), '0123456789') = '' AND substr(start_on, 5, 1) = '-' AND ltrim(substr(start_on, 6, 1), '01') = '' AND ltrim(substr(start_on, 7, 1), '0123456789') = '')) OR (date_precision = 'year' AND (length(start_on) = 4 AND ltrim(substr(start_on, 1, 4), '0123456789') = '')) OR (date_precision = 'range' AND timing_raw IS NOT NULL AND (start_on IS NULL OR (length(start_on) = 7 AND ltrim(substr(start_on, 1, 4), '0123456789') = '' AND substr(start_on, 5, 1) = '-' AND ltrim(substr(start_on, 6, 1), '01') = '' AND ltrim(substr(start_on, 7, 1), '0123456789') = ''))) OR (date_precision = 'tbd' AND start_on IS NULL)),
  CHECK (end_on IS NULL OR (length(end_on) = 10 AND ltrim(substr(end_on, 1, 4), '0123456789') = '' AND substr(end_on, 5, 1) = '-' AND ltrim(substr(end_on, 6, 1), '01') = '' AND ltrim(substr(end_on, 7, 1), '0123456789') = '' AND substr(end_on, 8, 1) = '-' AND ltrim(substr(end_on, 9, 1), '0123') = '' AND ltrim(substr(end_on, 10, 1), '0123456789') = '') OR (length(end_on) = 7 AND ltrim(substr(end_on, 1, 4), '0123456789') = '' AND substr(end_on, 5, 1) = '-' AND ltrim(substr(end_on, 6, 1), '01') = '' AND ltrim(substr(end_on, 7, 1), '0123456789') = '') OR (length(end_on) = 4 AND ltrim(substr(end_on, 1, 4), '0123456789') = '')),
  CHECK (announce_on IS NULL OR (length(announce_on) = 10 AND ltrim(substr(announce_on, 1, 4), '0123456789') = '' AND substr(announce_on, 5, 1) = '-' AND ltrim(substr(announce_on, 6, 1), '01') = '' AND ltrim(substr(announce_on, 7, 1), '0123456789') = '' AND substr(announce_on, 8, 1) = '-' AND ltrim(substr(announce_on, 9, 1), '0123') = '' AND ltrim(substr(announce_on, 10, 1), '0123456789') = '') OR (length(announce_on) = 7 AND ltrim(substr(announce_on, 1, 4), '0123456789') = '' AND substr(announce_on, 5, 1) = '-' AND ltrim(substr(announce_on, 6, 1), '01') = '' AND ltrim(substr(announce_on, 7, 1), '0123456789') = '') OR (length(announce_on) = 4 AND ltrim(substr(announce_on, 1, 4), '0123456789') = '')),
  CHECK (end_on IS NULL OR start_on IS NULL OR substr(end_on, 1, lite_min(length(end_on), length(start_on))) >= substr(start_on, 1, lite_min(length(end_on), length(start_on)))),
  CHECK (status <> 'confirmed' OR start_on IS NOT NULL)
);
CREATE TABLE work_release_window_field_values (
  org_id bigint NOT NULL,
  window_id bigint NOT NULL,
  version_no bigint NOT NULL,
  field_key text COLLATE "C" NOT NULL,
  value_text text COLLATE "C" CHECK (value_text IS NULL OR length(value_text) BETWEEN 1 AND 500),
  value_number bigint,
  PRIMARY KEY (org_id, window_id, version_no, field_key),
  CHECK ((value_text IS NULL) <> (value_number IS NULL))
);
CREATE TABLE release_window_import_previews (
  token text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  payload_json text COLLATE "C" NOT NULL,
  expires_at text COLLATE "C" NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX work_release_windows_type_idx ON work_release_windows (org_id, type_id);
CREATE TRIGGER release_window_types_no_update BEFORE UPDATE ON release_window_types FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window type immutable');
CREATE TRIGGER release_window_types_no_delete BEFORE DELETE ON release_window_types FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window type immutable');
CREATE TRIGGER release_window_type_versions_no_update BEFORE UPDATE ON release_window_type_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window type version immutable');
CREATE TRIGGER release_window_type_versions_no_delete BEFORE DELETE ON release_window_type_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window type version immutable');
CREATE TRIGGER release_window_type_fields_no_update BEFORE UPDATE ON release_window_type_fields FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window type field immutable');
CREATE TRIGGER release_window_type_fields_no_delete BEFORE DELETE ON release_window_type_fields FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window type field immutable');
CREATE TRIGGER release_window_type_distributions_no_update BEFORE UPDATE ON release_window_type_distributions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window type distribution immutable');
CREATE TRIGGER release_window_type_distributions_no_delete BEFORE DELETE ON release_window_type_distributions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window type distribution immutable');
CREATE TRIGGER work_release_windows_no_update BEFORE UPDATE ON work_release_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window immutable');
CREATE TRIGGER work_release_windows_no_delete BEFORE DELETE ON work_release_windows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window immutable');
CREATE TRIGGER work_release_window_versions_no_update BEFORE UPDATE ON work_release_window_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window version immutable');
CREATE TRIGGER work_release_window_versions_no_delete BEFORE DELETE ON work_release_window_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window version immutable');
CREATE TRIGGER work_release_window_field_values_no_update BEFORE UPDATE ON work_release_window_field_values FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window field value immutable');
CREATE TRIGGER work_release_window_field_values_no_delete BEFORE DELETE ON work_release_window_field_values FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window field value immutable');
CREATE TRIGGER release_window_import_previews_no_delete BEFORE DELETE ON release_window_import_previews FOR EACH ROW EXECUTE FUNCTION lite_reject_change('release window preview immutable');
CREATE FUNCTION release_window_import_previews_consume_only_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT (OLD.consumed = 0 AND NEW.consumed = 1 AND NEW.token = OLD.token AND NEW.org_id = OLD.org_id AND NEW.user_id = OLD.user_id AND NEW.payload_json = OLD.payload_json AND NEW.expires_at = OLD.expires_at)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'release window preview can only be consumed once';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER release_window_import_previews_consume_only BEFORE UPDATE ON release_window_import_previews FOR EACH ROW EXECUTE FUNCTION release_window_import_previews_consume_only_fn();
CREATE FUNCTION release_window_type_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM release_window_type_versions WHERE org_id = NEW.org_id AND type_id = NEW.type_id), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale release window type version';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER release_window_type_versions_sequence BEFORE INSERT ON release_window_type_versions FOR EACH ROW EXECUTE FUNCTION release_window_type_versions_sequence_fn();
CREATE FUNCTION work_release_window_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM work_release_window_versions WHERE org_id = NEW.org_id AND window_id = NEW.window_id), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale release window version';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_release_window_versions_sequence BEFORE INSERT ON work_release_window_versions FOR EACH ROW EXECUTE FUNCTION work_release_window_versions_sequence_fn();
CREATE FUNCTION work_release_window_versions_type_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM release_window_type_versions tv JOIN work_release_windows w ON w.org_id = tv.org_id AND w.type_id = tv.type_id WHERE w.org_id = NEW.org_id AND w.id = NEW.window_id AND tv.version_no = NEW.type_version_no)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'release window type version mismatch';
  END IF;
  IF (NEW.availability_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales_availability_versions a JOIN work_release_windows w ON w.org_id = a.org_id AND w.work_id = a.work_id WHERE w.org_id = NEW.org_id AND w.id = NEW.window_id AND a.id = NEW.availability_version_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'availability version scope mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_release_window_versions_type_scope BEFORE INSERT ON work_release_window_versions FOR EACH ROW EXECUTE FUNCTION work_release_window_versions_type_scope_fn();
CREATE FUNCTION work_release_window_field_values_type_check_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM work_release_window_versions v JOIN work_release_windows w ON w.org_id = v.org_id AND w.id = v.window_id JOIN release_window_type_fields f ON f.org_id = w.org_id AND f.type_id = w.type_id AND f.version_no = v.type_version_no AND f.field_key = NEW.field_key WHERE v.org_id = NEW.org_id AND v.window_id = NEW.window_id AND v.version_no = NEW.version_no AND ((f.value_type IN ('integer', 'yen') AND NEW.value_number IS NOT NULL AND NEW.value_number >= 0) OR (f.value_type = 'date' AND ((length(NEW.value_text) = 10 AND ltrim(substr(NEW.value_text, 1, 4), '0123456789') = '' AND substr(NEW.value_text, 5, 1) = '-' AND ltrim(substr(NEW.value_text, 6, 1), '01') = '' AND ltrim(substr(NEW.value_text, 7, 1), '0123456789') = '' AND substr(NEW.value_text, 8, 1) = '-' AND ltrim(substr(NEW.value_text, 9, 1), '0123') = '' AND ltrim(substr(NEW.value_text, 10, 1), '0123456789') = '') OR (length(NEW.value_text) = 7 AND ltrim(substr(NEW.value_text, 1, 4), '0123456789') = '' AND substr(NEW.value_text, 5, 1) = '-' AND ltrim(substr(NEW.value_text, 6, 1), '01') = '' AND ltrim(substr(NEW.value_text, 7, 1), '0123456789') = '') OR (length(NEW.value_text) = 4 AND ltrim(substr(NEW.value_text, 1, 4), '0123456789') = ''))) OR (f.value_type IN ('text', 'choice') AND NEW.value_text IS NOT NULL)))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'release window field type mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_release_window_field_values_type_check BEFORE INSERT ON work_release_window_field_values FOR EACH ROW EXECUTE FUNCTION work_release_window_field_values_type_check_fn();
CREATE TABLE partner_list_kinds (
  code text COLLATE "C" PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 40 AND (length(substr(code, 1, 1)) = 1 AND ltrim(substr(substr(code, 1, 1), 1, 1), 'abcdefghijklmnopqrstuvwxyz') = '') AND (NOT (ltrim(code, 'abcdefghijklmnopqrstuvwxyz0123456789_') <> ''))),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 40),
  sort_order bigint NOT NULL CHECK (sort_order BETWEEN 0 AND 100000)
);
INSERT INTO partner_list_kinds (code, label, sort_order) VALUES
  ('distribution', '配信リスト', 10),
  ('sales', '販売リスト', 20)
ON CONFLICT DO NOTHING;
CREATE TABLE partner_lists (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  list_kind text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  service_name text COLLATE "C" CHECK (service_name IS NULL OR length(trim(service_name)) BETWEEN 1 AND 200),
  contract_reference text COLLATE "C" CHECK (contract_reference IS NULL OR length(trim(contract_reference)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, partner_id, list_kind, name)
);
CREATE TABLE partner_list_import_batches (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  list_id bigint NOT NULL,
  file_name text COLLATE "C" CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  content_hash text COLLATE "C" NOT NULL CHECK (length(content_hash) = 64 AND (NOT (ltrim(content_hash, '0123456789abcdef') <> ''))),
  template_version text COLLATE "C" NOT NULL CHECK (length(template_version) BETWEEN 1 AND 40),
  mode text COLLATE "C" NOT NULL CHECK (mode IN ('partial', 'full')),
  appended bigint NOT NULL CHECK (appended >= 0),
  revised bigint NOT NULL CHECK (revised >= 0),
  withdrawn bigint NOT NULL CHECK (withdrawn >= 0),
  unchanged bigint NOT NULL CHECK (unchanged >= 0),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, list_id, content_hash)
);
CREATE TABLE partner_list_entries (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  list_id bigint NOT NULL,
  work_id bigint NOT NULL,
  renews_entry_id bigint,
  created_batch_id bigint,
  created_source_row bigint CHECK (created_source_row IS NULL OR created_source_row > 0),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, list_id, id),
  UNIQUE (org_id, work_id, id),
  CHECK ((created_batch_id IS NULL) = (created_source_row IS NULL))
);
CREATE TABLE partner_list_entry_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  list_id bigint NOT NULL,
  entry_id bigint NOT NULL,
  work_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  distribution_code text COLLATE "C" NOT NULL,
  partner_category text COLLATE "C" CHECK (partner_category IS NULL OR length(trim(partner_category)) BETWEEN 1 AND 200),
  territory text COLLATE "C" NOT NULL DEFAULT '日本' CHECK (length(trim(territory)) BETWEEN 1 AND 100),
  product_id bigint,
  partner_work_code text COLLATE "C" CHECK (partner_work_code IS NULL OR length(trim(partner_work_code)) BETWEEN 1 AND 200),
  contract_start text COLLATE "C" CHECK (contract_start IS NULL OR (length(contract_start) = 10 AND ltrim(substr(contract_start, 1, 4), '0123456789') = '' AND substr(contract_start, 5, 1) = '-' AND ltrim(substr(contract_start, 6, 1), '01') = '' AND ltrim(substr(contract_start, 7, 1), '0123456789') = '' AND substr(contract_start, 8, 1) = '-' AND ltrim(substr(contract_start, 9, 1), '0123') = '' AND ltrim(substr(contract_start, 10, 1), '0123456789') = '')),
  contract_end text COLLATE "C" CHECK (contract_end IS NULL OR (length(contract_end) = 10 AND ltrim(substr(contract_end, 1, 4), '0123456789') = '' AND substr(contract_end, 5, 1) = '-' AND ltrim(substr(contract_end, 6, 1), '01') = '' AND ltrim(substr(contract_end, 7, 1), '0123456789') = '' AND substr(contract_end, 8, 1) = '-' AND ltrim(substr(contract_end, 9, 1), '0123') = '' AND ltrim(substr(contract_end, 10, 1), '0123456789') = '')),
  end_rule text COLLATE "C" NOT NULL CHECK (end_rule IN ('date', 'auto_renew', 'perpetual', 'unknown')),
  announce_on text COLLATE "C" CHECK (announce_on IS NULL OR (length(announce_on) = 10 AND ltrim(substr(announce_on, 1, 4), '0123456789') = '' AND substr(announce_on, 5, 1) = '-' AND ltrim(substr(announce_on, 6, 1), '01') = '' AND ltrim(substr(announce_on, 7, 1), '0123456789') = '' AND substr(announce_on, 8, 1) = '-' AND ltrim(substr(announce_on, 9, 1), '0123') = '' AND ltrim(substr(announce_on, 10, 1), '0123456789') = '')),
  exclusivity text COLLATE "C" NOT NULL CHECK (exclusivity IN ('unknown', 'exclusive', 'nonexclusive')),
  status text COLLATE "C" NOT NULL CHECK (status IN ('planned', 'contracted', 'withdrawn')),
  settlement_method text COLLATE "C" NOT NULL DEFAULT 'unverified' CHECK (settlement_method IN ('unverified', 'FLAT', 'MG', 'RS', 'other')),
  amount_ex_tax bigint CHECK (amount_ex_tax IS NULL OR amount_ex_tax >= 0),
  rate_bps bigint CHECK (rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  billing_partner_id bigint,
  agreement_id bigint,
  source_reference text COLLATE "C" CHECK (source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 1000),
  note text COLLATE "C" CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
  import_batch_id bigint,
  source_row bigint CHECK (source_row IS NULL OR source_row > 0),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, entry_id, version_no),
  CHECK (contract_end IS NULL OR contract_start IS NULL OR contract_end >= contract_start),
  CHECK (end_rule <> 'date' OR contract_end IS NOT NULL),
  CHECK (status <> 'contracted' OR contract_start IS NOT NULL)
);
CREATE TABLE partner_list_field_definitions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  field_key text COLLATE "C" NOT NULL CHECK (length(field_key) BETWEEN 1 AND 40 AND (length(substr(field_key, 1, 1)) = 1 AND ltrim(substr(substr(field_key, 1, 1), 1, 1), 'abcdefghijklmnopqrstuvwxyz') = '') AND (NOT (ltrim(field_key, 'abcdefghijklmnopqrstuvwxyz0123456789_') <> ''))),
  value_type text COLLATE "C" NOT NULL CHECK (value_type IN ('text', 'integer', 'yen', 'date', 'month', 'choice')),
  list_kind text COLLATE "C",
  partner_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, field_key)
);
CREATE TABLE partner_list_field_states (
  org_id bigint NOT NULL,
  definition_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 40),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  sort_order bigint NOT NULL CHECK (sort_order BETWEEN 0 AND 100000),
  options_json text COLLATE "C" CHECK (options_json IS NULL OR length(options_json) BETWEEN 2 AND 4000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, definition_id, version_no)
);
CREATE TABLE partner_list_field_values (
  org_id bigint NOT NULL,
  entry_version_id bigint NOT NULL,
  definition_id bigint NOT NULL,
  value_text text COLLATE "C" CHECK (value_text IS NULL OR length(value_text) BETWEEN 1 AND 500),
  value_number bigint,
  PRIMARY KEY (org_id, entry_version_id, definition_id),
  CHECK ((value_text IS NULL) <> (value_number IS NULL))
);
CREATE TABLE partner_list_import_previews (
  token text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  user_id bigint NOT NULL,
  list_id bigint NOT NULL,
  file_name text COLLATE "C" CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  content_hash text COLLATE "C" NOT NULL CHECK (length(content_hash) = 64),
  template_version text COLLATE "C" NOT NULL,
  mode text COLLATE "C" NOT NULL CHECK (mode IN ('partial', 'full')),
  payload_json text COLLATE "C" NOT NULL,
  unchanged bigint NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
  expires_at text COLLATE "C" NOT NULL,
  consumed bigint NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX partner_lists_partner_idx ON partner_lists (org_id, partner_id);
CREATE INDEX partner_list_entries_list_idx ON partner_list_entries (org_id, list_id);
CREATE UNIQUE INDEX partner_list_entries_batch_row ON partner_list_entries (org_id, created_batch_id, created_source_row) WHERE created_batch_id IS NOT NULL;
CREATE INDEX partner_list_entry_versions_work_idx ON partner_list_entry_versions (org_id, work_id, distribution_code);
CREATE UNIQUE INDEX partner_list_entry_versions_batch_entry ON partner_list_entry_versions (org_id, import_batch_id, entry_id) WHERE import_batch_id IS NOT NULL;
CREATE TRIGGER partner_list_kinds_no_update BEFORE UPDATE ON partner_list_kinds FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list kind immutable');
CREATE TRIGGER partner_list_kinds_no_delete BEFORE DELETE ON partner_list_kinds FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list kind immutable');
CREATE TRIGGER partner_lists_no_update BEFORE UPDATE ON partner_lists FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list immutable');
CREATE TRIGGER partner_lists_no_delete BEFORE DELETE ON partner_lists FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list immutable');
CREATE TRIGGER partner_list_import_batches_no_update BEFORE UPDATE ON partner_list_import_batches FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list batch immutable');
CREATE TRIGGER partner_list_import_batches_no_delete BEFORE DELETE ON partner_list_import_batches FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list batch immutable');
CREATE TRIGGER partner_list_entries_no_update BEFORE UPDATE ON partner_list_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list entry immutable');
CREATE TRIGGER partner_list_entries_no_delete BEFORE DELETE ON partner_list_entries FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list entry immutable');
CREATE TRIGGER partner_list_entry_versions_no_update BEFORE UPDATE ON partner_list_entry_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list entry version immutable');
CREATE TRIGGER partner_list_entry_versions_no_delete BEFORE DELETE ON partner_list_entry_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list entry version immutable');
CREATE TRIGGER partner_list_field_definitions_no_update BEFORE UPDATE ON partner_list_field_definitions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list field immutable');
CREATE TRIGGER partner_list_field_definitions_no_delete BEFORE DELETE ON partner_list_field_definitions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list field immutable');
CREATE TRIGGER partner_list_field_states_no_update BEFORE UPDATE ON partner_list_field_states FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list field state immutable');
CREATE TRIGGER partner_list_field_states_no_delete BEFORE DELETE ON partner_list_field_states FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list field state immutable');
CREATE TRIGGER partner_list_field_values_no_update BEFORE UPDATE ON partner_list_field_values FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list field value immutable');
CREATE TRIGGER partner_list_field_values_no_delete BEFORE DELETE ON partner_list_field_values FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list field value immutable');
CREATE TRIGGER partner_list_import_previews_no_delete BEFORE DELETE ON partner_list_import_previews FOR EACH ROW EXECUTE FUNCTION lite_reject_change('partner list preview immutable');
CREATE FUNCTION partner_list_import_previews_consume_only_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT (OLD.consumed = 0 AND NEW.consumed = 1 AND NEW.token = OLD.token AND NEW.org_id = OLD.org_id AND NEW.user_id = OLD.user_id AND NEW.list_id = OLD.list_id AND NEW.content_hash = OLD.content_hash AND NEW.payload_json = OLD.payload_json AND NEW.unchanged = OLD.unchanged AND NEW.expires_at = OLD.expires_at)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'partner list preview can only be consumed once';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER partner_list_import_previews_consume_only BEFORE UPDATE ON partner_list_import_previews FOR EACH ROW EXECUTE FUNCTION partner_list_import_previews_consume_only_fn();
CREATE FUNCTION partner_list_entry_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM partner_list_entry_versions WHERE org_id = NEW.org_id AND entry_id = NEW.entry_id), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale partner list entry version';
  END IF;
  IF (NOT EXISTS (SELECT 1 FROM distribution_master m WHERE m.code = NEW.distribution_code)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'partner list distribution code must be in distribution_master';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER partner_list_entry_versions_sequence BEFORE INSERT ON partner_list_entry_versions FOR EACH ROW EXECUTE FUNCTION partner_list_entry_versions_sequence_fn();
CREATE FUNCTION partner_list_field_states_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM partner_list_field_states WHERE org_id = NEW.org_id AND definition_id = NEW.definition_id), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale partner list field state';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER partner_list_field_states_sequence BEFORE INSERT ON partner_list_field_states FOR EACH ROW EXECUTE FUNCTION partner_list_field_states_sequence_fn();
CREATE FUNCTION partner_list_entries_renewal_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.renews_entry_id IS NOT NULL) IS NOT TRUE THEN RETURN NEW; END IF;
  IF (NOT EXISTS (SELECT 1 FROM partner_list_entries e WHERE e.org_id = NEW.org_id AND e.id = NEW.renews_entry_id AND e.list_id = NEW.list_id AND e.work_id = NEW.work_id)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'partner list renewal scope mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER partner_list_entries_renewal_scope BEFORE INSERT ON partner_list_entries FOR EACH ROW EXECUTE FUNCTION partner_list_entries_renewal_scope_fn();
CREATE FUNCTION partner_list_field_values_type_check_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM partner_list_entry_versions v JOIN partner_lists l ON l.org_id = v.org_id AND l.id = v.list_id JOIN partner_list_field_definitions d ON d.org_id = v.org_id AND d.id = NEW.definition_id WHERE v.org_id = NEW.org_id AND v.id = NEW.entry_version_id AND (d.list_kind IS NULL OR d.list_kind = l.list_kind) AND (d.partner_id IS NULL OR d.partner_id = l.partner_id) AND ((d.value_type IN ('integer', 'yen') AND NEW.value_number IS NOT NULL AND NEW.value_number = lite_cast_int(NEW.value_number)) OR (d.value_type = 'date' AND (length(NEW.value_text) = 10 AND ltrim(substr(NEW.value_text, 1, 4), '0123456789') = '' AND substr(NEW.value_text, 5, 1) = '-' AND ltrim(substr(NEW.value_text, 6, 1), '01') = '' AND ltrim(substr(NEW.value_text, 7, 1), '0123456789') = '' AND substr(NEW.value_text, 8, 1) = '-' AND ltrim(substr(NEW.value_text, 9, 1), '0123') = '' AND ltrim(substr(NEW.value_text, 10, 1), '0123456789') = '')) OR (d.value_type = 'month' AND (length(NEW.value_text) = 7 AND ltrim(substr(NEW.value_text, 1, 4), '0123456789') = '' AND substr(NEW.value_text, 5, 1) = '-' AND ltrim(substr(NEW.value_text, 6, 1), '01') = '' AND ltrim(substr(NEW.value_text, 7, 1), '0123456789') = '')) OR (d.value_type IN ('text', 'choice') AND NEW.value_text IS NOT NULL)))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'partner list field type mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER partner_list_field_values_type_check BEFORE INSERT ON partner_list_field_values FOR EACH ROW EXECUTE FUNCTION partner_list_field_values_type_check_fn();
CREATE TABLE sales_sheet_column_versions (
  org_id bigint NOT NULL,
  column_key text COLLATE "C" NOT NULL CHECK (length(column_key) BETWEEN 1 AND 48 AND (length(substr(column_key, 1, 1)) = 1 AND ltrim(substr(substr(column_key, 1, 1), 1, 1), 'abcdefghijklmnopqrstuvwxyz') = '') AND (NOT (ltrim(column_key, 'abcdefghijklmnopqrstuvwxyz0123456789_') <> ''))),
  version_no bigint NOT NULL CHECK (version_no > 0),
  label text COLLATE "C" NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  legacy_position bigint CHECK (legacy_position IS NULL OR legacy_position BETWEEN 1 AND 83),
  group_key text COLLATE "C" NOT NULL CHECK (group_key IN ('identity', 'dates', 'quantity', 'unit_price', 'rate', 'partner_gross', 'holder_sales', 'currency', 'booking', 'mg_balance', 'theatre', 'note', 'audit', 'reference', 'helper', 'custom')),
  value_type text COLLATE "C" NOT NULL CHECK (value_type IN ('yen', 'integer', 'decimal', 'rate_pct', 'date', 'month', 'text', 'bool')),
  aggregation text COLLATE "C" NOT NULL CHECK (aggregation IN ('sum', 'period_end', 'ratio', 'min_max', 'distinct')),
  numerator_key text COLLATE "C",
  denominator_key text COLLATE "C",
  ratio_scale bigint CHECK (ratio_scale IS NULL OR ratio_scale IN (1, 100)),
  digits bigint CHECK (digits IS NULL OR digits BETWEEN 0 AND 6),
  source_kind text COLLATE "C" NOT NULL CHECK (source_kind IN ('core', 'derived', 'attribute')),
  source_ref text COLLATE "C" CHECK (source_ref IS NULL OR (length(source_ref) BETWEEN 1 AND 60 AND (NOT (ltrim(source_ref, 'abcdefghijklmnopqrstuvwxyz0123456789_.') <> '')))),
  formula_json text COLLATE "C" CHECK (formula_json IS NULL OR (length(formula_json) BETWEEN 2 AND 2000 AND lite_json_valid(formula_json))),
  description text COLLATE "C" CHECK (description IS NULL OR length(trim(description)) BETWEEN 1 AND 500),
  sort_order bigint NOT NULL CHECK (sort_order BETWEEN 0 AND 100000),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, column_key, version_no),
  CHECK ((aggregation = 'ratio') = (numerator_key IS NOT NULL AND denominator_key IS NOT NULL AND ratio_scale IS NOT NULL)),
  CHECK (aggregation <> 'ratio' OR value_type IN ('decimal', 'rate_pct', 'yen', 'integer')),
  CHECK (aggregation NOT IN ('sum', 'period_end') OR value_type IN ('yen', 'integer', 'decimal')),
  CHECK (aggregation <> 'min_max' OR value_type IN ('date', 'month', 'text', 'integer')),
  CHECK (source_kind <> 'core' OR (source_ref IS NOT NULL AND formula_json IS NULL)),
  CHECK (source_kind <> 'derived' OR (source_ref IS NULL) <> (formula_json IS NULL)),
  CHECK (source_kind <> 'attribute' OR (source_ref IS NULL AND formula_json IS NULL))
);
CREATE TABLE sale_attribute_values (
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  column_key text COLLATE "C" NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  value_text text COLLATE "C" CHECK (value_text IS NULL OR length(value_text) BETWEEN 1 AND 500),
  value_number numeric CHECK (value_number IS NULL OR lite_typeof(value_number) IN ('integer', 'real')),
  origin text COLLATE "C" NOT NULL CHECK (origin IN ('manual', 'report_import')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, sale_id, column_key, version_no),
  CHECK (value_text IS NULL OR value_number IS NULL)
);
CREATE TABLE sale_currency_versions (
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  currency_code text COLLATE "C" NOT NULL CHECK (length(currency_code) = 3 AND (NOT (ltrim(currency_code, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') <> ''))),
  original_amount_x100 bigint CHECK (original_amount_x100 IS NULL OR lite_typeof(original_amount_x100) = 'integer'),
  original_royalty_x100 bigint CHECK (original_royalty_x100 IS NULL OR lite_typeof(original_royalty_x100) = 'integer'),
  exchange_rate_x10000 bigint NOT NULL CHECK (lite_typeof(exchange_rate_x10000) = 'integer' AND exchange_rate_x10000 > 0),
  rate_date text COLLATE "C" NOT NULL CHECK ((length(rate_date) = 10 AND ltrim(substr(rate_date, 1, 4), '0123456789') = '' AND substr(rate_date, 5, 1) = '-' AND ltrim(substr(rate_date, 6, 1), '01') = '' AND ltrim(substr(rate_date, 7, 1), '0123456789') = '' AND substr(rate_date, 8, 1) = '-' AND ltrim(substr(rate_date, 9, 1), '0123') = '' AND ltrim(substr(rate_date, 10, 1), '0123456789') = '')),
  basis text COLLATE "C" NOT NULL CHECK (length(trim(basis)) BETWEEN 1 AND 500),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, sale_id, version_no),
  CHECK (currency_code <> 'JPY' OR exchange_rate_x10000 = 10000),
  CHECK (currency_code = 'JPY' OR original_amount_x100 IS NOT NULL)
);
CREATE TABLE sale_royalty_basis_versions (
  org_id bigint NOT NULL,
  sale_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  royalty_month text COLLATE "C" NOT NULL CHECK ((length(royalty_month) = 7 AND ltrim(substr(royalty_month, 1, 4), '0123456789') = '' AND substr(royalty_month, 5, 1) = '-' AND ltrim(substr(royalty_month, 6, 1), '01') = '' AND ltrim(substr(royalty_month, 7, 1), '0123456789') = '') AND lite_cast_int(substr(royalty_month, 6, 2)) BETWEEN 1 AND 12),
  royalty_amount_ex_tax bigint NOT NULL CHECK (lite_typeof(royalty_amount_ex_tax) = 'integer'),
  royalty_tax_amount bigint NOT NULL CHECK (lite_typeof(royalty_tax_amount) = 'integer'),
  royalty_amount_inc_tax bigint NOT NULL CHECK (lite_typeof(royalty_amount_inc_tax) = 'integer'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, sale_id, version_no),
  CHECK (royalty_amount_inc_tax = royalty_amount_ex_tax + royalty_tax_amount)
);
CREATE TABLE sales_sheet_views (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name)
);
CREATE TABLE sales_sheet_view_versions (
  org_id bigint NOT NULL,
  view_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  column_keys_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(column_keys_json) AND lite_json_type(column_keys_json) = 'array' AND lite_json_array_length(column_keys_json) BETWEEN 1 AND 200 AND length(column_keys_json) <= 12000),
  grain text COLLATE "C" NOT NULL CHECK (grain IN ('detail', 'aggregate')),
  dimensions_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(dimensions_json) AND lite_json_type(dimensions_json) = 'array' AND lite_json_array_length(dimensions_json) <= 3),
  month_basis text COLLATE "C" NOT NULL CHECK (month_basis IN ('accounting', 'sales', 'royalty')),
  tax_basis text COLLATE "C" NOT NULL CHECK (tax_basis IN ('ex', 'inc')),
  pivot_months bigint NOT NULL CHECK (pivot_months IN (0, 1)),
  hide_empty bigint NOT NULL CHECK (hide_empty IN (0, 1)),
  filters_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(filters_json) AND lite_json_type(filters_json) = 'object' AND length(filters_json) <= 4000),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, view_id, version_no),
  CHECK (grain = 'aggregate' OR (lite_json_array_length(dimensions_json) = 0 AND pivot_months = 0))
);
CREATE INDEX sale_attribute_values_column_idx ON sale_attribute_values (org_id, column_key);
CREATE TRIGGER sales_sheet_column_versions_no_update BEFORE UPDATE ON sales_sheet_column_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales sheet column immutable');
CREATE TRIGGER sales_sheet_column_versions_no_delete BEFORE DELETE ON sales_sheet_column_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales sheet column immutable');
CREATE TRIGGER sale_attribute_values_no_update BEFORE UPDATE ON sale_attribute_values FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sale attribute immutable');
CREATE TRIGGER sale_attribute_values_no_delete BEFORE DELETE ON sale_attribute_values FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sale attribute immutable');
CREATE TRIGGER sale_currency_versions_no_update BEFORE UPDATE ON sale_currency_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sale currency immutable');
CREATE TRIGGER sale_currency_versions_no_delete BEFORE DELETE ON sale_currency_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sale currency immutable');
CREATE TRIGGER sale_royalty_basis_versions_no_update BEFORE UPDATE ON sale_royalty_basis_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sale royalty basis immutable');
CREATE TRIGGER sale_royalty_basis_versions_no_delete BEFORE DELETE ON sale_royalty_basis_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sale royalty basis immutable');
CREATE TRIGGER sales_sheet_views_no_update BEFORE UPDATE ON sales_sheet_views FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales sheet view immutable');
CREATE TRIGGER sales_sheet_views_no_delete BEFORE DELETE ON sales_sheet_views FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales sheet view immutable');
CREATE TRIGGER sales_sheet_view_versions_no_update BEFORE UPDATE ON sales_sheet_view_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales sheet view version immutable');
CREATE TRIGGER sales_sheet_view_versions_no_delete BEFORE DELETE ON sales_sheet_view_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('sales sheet view version immutable');
CREATE FUNCTION sales_sheet_column_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM sales_sheet_column_versions WHERE org_id = NEW.org_id AND column_key = NEW.column_key), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale sales sheet column version';
  END IF;
  IF (EXISTS (SELECT 1 FROM sales_sheet_column_versions p WHERE p.org_id = NEW.org_id AND p.column_key = NEW.column_key AND p.version_no = NEW.version_no - 1 AND (p.value_type <> NEW.value_type OR p.source_kind <> NEW.source_kind OR COALESCE(p.source_ref, '') <> COALESCE(NEW.source_ref, '') OR COALESCE(p.legacy_position, 0) <> COALESCE(NEW.legacy_position, 0)))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales sheet column type is immutable';
  END IF;
  IF (NEW.legacy_position IS NOT NULL AND EXISTS (SELECT 1 FROM sales_sheet_column_versions x WHERE x.org_id = NEW.org_id AND x.legacy_position = NEW.legacy_position AND x.column_key <> NEW.column_key)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sales sheet legacy position already used';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_sheet_column_versions_sequence BEFORE INSERT ON sales_sheet_column_versions FOR EACH ROW EXECUTE FUNCTION sales_sheet_column_versions_sequence_fn();
CREATE FUNCTION sale_attribute_values_check_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM sale_attribute_values WHERE org_id = NEW.org_id AND sale_id = NEW.sale_id AND column_key = NEW.column_key), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale sale attribute version';
  END IF;
  IF (NOT EXISTS (SELECT 1 FROM sales_sheet_column_versions c WHERE c.org_id = NEW.org_id AND c.column_key = NEW.column_key AND c.version_no = (SELECT max(x.version_no) FROM sales_sheet_column_versions x WHERE x.org_id = c.org_id AND x.column_key = c.column_key) AND c.source_kind = 'attribute' AND c.active = 1 AND ((NEW.value_text IS NULL AND NEW.value_number IS NULL) OR (c.value_type IN ('yen', 'integer') AND lite_typeof(NEW.value_number) = 'integer') OR (c.value_type IN ('decimal', 'rate_pct') AND lite_typeof(NEW.value_number) IN ('integer', 'real')) OR (c.value_type = 'bool' AND lite_typeof(NEW.value_number) = 'integer' AND NEW.value_number IN (0, 1)) OR (c.value_type = 'date' AND (length(NEW.value_text) = 10 AND ltrim(substr(NEW.value_text, 1, 4), '0123456789') = '' AND substr(NEW.value_text, 5, 1) = '-' AND ltrim(substr(NEW.value_text, 6, 1), '01') = '' AND ltrim(substr(NEW.value_text, 7, 1), '0123456789') = '' AND substr(NEW.value_text, 8, 1) = '-' AND ltrim(substr(NEW.value_text, 9, 1), '0123') = '' AND ltrim(substr(NEW.value_text, 10, 1), '0123456789') = '')) OR (c.value_type = 'month' AND (length(NEW.value_text) = 7 AND ltrim(substr(NEW.value_text, 1, 4), '0123456789') = '' AND substr(NEW.value_text, 5, 1) = '-' AND ltrim(substr(NEW.value_text, 6, 1), '01') = '' AND ltrim(substr(NEW.value_text, 7, 1), '0123456789') = '')) OR (c.value_type = 'text' AND NEW.value_text IS NOT NULL)))) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale attribute type mismatch';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sale_attribute_values_check BEFORE INSERT ON sale_attribute_values FOR EACH ROW EXECUTE FUNCTION sale_attribute_values_check_fn();
CREATE FUNCTION sale_currency_versions_check_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM sale_currency_versions WHERE org_id = NEW.org_id AND sale_id = NEW.sale_id), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale sale currency version';
  END IF;
  IF (NEW.currency_code <> 'JPY' AND NOT EXISTS (SELECT 1 FROM sale_lines s WHERE s.org_id = NEW.org_id AND s.id = NEW.sale_id AND ABS(round((NEW.original_amount_x100 * (NEW.exchange_rate_x10000 / 1000000.0))::numeric) - s.amount_ex_tax) <= 1 + ABS(s.amount_ex_tax) / 1000000000.0)) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'sale currency amount does not match the booked yen amount';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sale_currency_versions_check BEFORE INSERT ON sale_currency_versions FOR EACH ROW EXECUTE FUNCTION sale_currency_versions_check_fn();
CREATE FUNCTION sale_royalty_basis_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM sale_royalty_basis_versions WHERE org_id = NEW.org_id AND sale_id = NEW.sale_id), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale sale royalty basis version';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sale_royalty_basis_versions_sequence BEFORE INSERT ON sale_royalty_basis_versions FOR EACH ROW EXECUTE FUNCTION sale_royalty_basis_versions_sequence_fn();
CREATE FUNCTION sales_sheet_view_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(version_no) FROM sales_sheet_view_versions WHERE org_id = NEW.org_id AND view_id = NEW.view_id), 0) + 1) THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale sales sheet view version';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sales_sheet_view_versions_sequence BEFORE INSERT ON sales_sheet_view_versions FOR EACH ROW EXECUTE FUNCTION sales_sheet_view_versions_sequence_fn();
INSERT INTO distribution_types (code, family, label, utilization, sort_order) VALUES
  ('D007', 'unverified', 'D007', NULL, 139)
ON CONFLICT DO NOTHING;
INSERT INTO distribution_master VALUES
  ('D007', '配信', 'RS', 'PVOD', '2026-09-25 代表の判断で追加（元の流通マスタには無い）', 'added-2026-09-25', 0)
ON CONFLICT DO NOTHING;
INSERT INTO transaction_guards (value)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM distribution_master WHERE code = 'D007' AND distribution_name = '配信' AND transaction_method = 'RS' AND sales_type = 'PVOD');

-- ===== 0005_sales_proposals.sql =====
CREATE TABLE work_proposal_profiles (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  title_kana text COLLATE "C" CHECK (title_kana IS NULL OR length(trim(title_kana)) BETWEEN 1 AND 200),
  title_en text COLLATE "C" CHECK (title_en IS NULL OR length(trim(title_en)) BETWEEN 1 AND 300),
  genre text COLLATE "C" CHECK (genre IS NULL OR length(trim(genre)) BETWEEN 1 AND 100),
  copyright_notice text COLLATE "C" CHECK (copyright_notice IS NULL OR length(trim(copyright_notice)) BETWEEN 1 AND 300),
  caution text COLLATE "C" CHECK (caution IS NULL OR length(trim(caution)) BETWEEN 1 AND 2000),
  intro_short text COLLATE "C" CHECK (intro_short IS NULL OR length(trim(intro_short)) BETWEEN 1 AND 1000),
  intro_long text COLLATE "C" CHECK (intro_long IS NULL OR length(trim(intro_long)) BETWEEN 1 AND 4000),
  info_url text COLLATE "C" CHECK (info_url IS NULL OR (length(info_url) BETWEEN 10 AND 1000 AND ((length(info_url) >= 9 AND substr(info_url, 1, 8) = 'https://') OR (length(info_url) >= 8 AND substr(info_url, 1, 7) = 'http://')))),
  image_url text COLLATE "C" CHECK (image_url IS NULL OR (length(image_url) BETWEEN 10 AND 1000 AND ((length(image_url) >= 9 AND substr(image_url, 1, 8) = 'https://') OR (length(image_url) >= 8 AND substr(image_url, 1, 7) = 'http://')))),
  image_key text COLLATE "C" CHECK (image_key IS NULL OR (length(image_key) BETWEEN 1 AND 300 AND (NOT (ltrim(image_key, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/._-') <> '')))),
  image_file_name text COLLATE "C" CHECK (image_file_name IS NULL OR length(trim(image_file_name)) BETWEEN 1 AND 240),
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, work_id, revision),
  CHECK (image_url IS NULL OR image_key IS NULL),
  CHECK (image_file_name IS NULL OR image_url IS NOT NULL OR image_key IS NOT NULL)
);
CREATE TRIGGER work_proposal_profiles_no_update BEFORE UPDATE ON work_proposal_profiles FOR EACH ROW EXECUTE FUNCTION lite_reject_change('work proposal profile immutable');
CREATE TRIGGER work_proposal_profiles_no_delete BEFORE DELETE ON work_proposal_profiles FOR EACH ROW EXECUTE FUNCTION lite_reject_change('work proposal profile immutable');
CREATE FUNCTION work_proposal_profiles_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> COALESCE((SELECT max(p.revision) FROM work_proposal_profiles p WHERE p.org_id = NEW.org_id AND p.work_id = NEW.work_id), 0) + 1) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale work proposal profile';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_proposal_profiles_sequence BEFORE INSERT ON work_proposal_profiles FOR EACH ROW EXECUTE FUNCTION work_proposal_profiles_sequence_fn();

-- ===== 0006_broadcast_windows.sql =====
CREATE TABLE broadcast_station_type_versions (
  org_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  station_type text COLLATE "C" NOT NULL CHECK (station_type IN ('terrestrial', 'bs', 'cs', 'catv', 'streaming', 'other')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, partner_id, version_no)
);
CREATE TABLE broadcast_entry_term_versions (
  org_id bigint NOT NULL,
  entry_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  licensed_runs bigint CHECK (licensed_runs IS NULL OR licensed_runs BETWEEN 1 AND 9999),
  holdback_months bigint CHECK (holdback_months IS NULL OR holdback_months BETWEEN 0 AND 120),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, entry_id, version_no)
);
CREATE TRIGGER broadcast_station_type_versions_no_update BEFORE UPDATE ON broadcast_station_type_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast station type version immutable');
CREATE TRIGGER broadcast_station_type_versions_no_delete BEFORE DELETE ON broadcast_station_type_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast station type version immutable');
CREATE TRIGGER broadcast_entry_term_versions_no_update BEFORE UPDATE ON broadcast_entry_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast entry terms version immutable');
CREATE TRIGGER broadcast_entry_term_versions_no_delete BEFORE DELETE ON broadcast_entry_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast entry terms version immutable');
CREATE FUNCTION broadcast_station_type_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(x.version_no) FROM broadcast_station_type_versions x WHERE x.org_id = NEW.org_id AND x.partner_id = NEW.partner_id), 0) + 1) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale broadcast station type version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER broadcast_station_type_versions_sequence BEFORE INSERT ON broadcast_station_type_versions FOR EACH ROW EXECUTE FUNCTION broadcast_station_type_versions_sequence_fn();
CREATE FUNCTION broadcast_entry_term_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(x.version_no) FROM broadcast_entry_term_versions x WHERE x.org_id = NEW.org_id AND x.entry_id = NEW.entry_id), 0) + 1) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale broadcast entry terms version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER broadcast_entry_term_versions_sequence BEFORE INSERT ON broadcast_entry_term_versions FOR EACH ROW EXECUTE FUNCTION broadcast_entry_term_versions_sequence_fn();
CREATE FUNCTION broadcast_entry_term_versions_broadcast_only_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM partner_list_entry_versions v JOIN distribution_master m ON m.code = v.distribution_code WHERE v.org_id = NEW.org_id AND v.entry_id = NEW.entry_id AND m.distribution_name = '放送' AND v.version_no = (SELECT max(z.version_no) FROM partner_list_entry_versions z WHERE z.org_id = v.org_id AND z.entry_id = v.entry_id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'broadcast entry terms need a broadcast entry';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER broadcast_entry_term_versions_broadcast_only BEFORE INSERT ON broadcast_entry_term_versions FOR EACH ROW EXECUTE FUNCTION broadcast_entry_term_versions_broadcast_only_fn();

-- ===== 0007_pl_bs.sql =====
CREATE TABLE org_profile_versions (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  legal_name text COLLATE "C" NOT NULL CHECK (length(trim(legal_name)) BETWEEN 1 AND 200),
  corporate_number text COLLATE "C" CHECK (corporate_number IS NULL OR (length(corporate_number) = 13 AND (NOT (ltrim(corporate_number, '0123456789') <> '')))),
  invoice_registration_number text COLLATE "C" CHECK (invoice_registration_number IS NULL OR (length(invoice_registration_number) = 14 AND substr(invoice_registration_number, 1, 1) = 'T' AND ltrim(substr(invoice_registration_number, 2, 13), '0123456789') = '')),
  postal_code text COLLATE "C" CHECK (postal_code IS NULL OR (length(postal_code) = 8 AND ltrim(substr(postal_code, 1, 3), '0123456789') = '' AND substr(postal_code, 4, 1) = '-' AND ltrim(substr(postal_code, 5, 4), '0123456789') = '')),
  address text COLLATE "C" CHECK (address IS NULL OR length(trim(address)) BETWEEN 1 AND 300),
  capital_yen bigint CHECK (capital_yen IS NULL OR capital_yen >= 0),
  self_partner_id bigint,
  opening_month text COLLATE "C" CHECK (opening_month IS NULL OR ((length(opening_month) = 7 AND ltrim(substr(opening_month, 1, 4), '0123456789') = '' AND substr(opening_month, 5, 1) = '-' AND ltrim(substr(opening_month, 6, 2), '0123456789') = '') AND substr(opening_month, 6, 2) BETWEEN '01' AND '12')),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, version_no)
);
CREATE TRIGGER org_profile_versions_no_update BEFORE UPDATE ON org_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('会社の法人情報の版は変更できません。新しい版を作ってください');
CREATE TRIGGER org_profile_versions_no_delete BEFORE DELETE ON org_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('会社の法人情報の版は削除できません');
CREATE FUNCTION org_profile_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> COALESCE((SELECT max(p.version_no) FROM org_profile_versions p WHERE p.org_id = NEW.org_id), 0) + 1) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '会社の法人情報の版が連続していません。再読込してから保存してください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER org_profile_versions_sequence BEFORE INSERT ON org_profile_versions FOR EACH ROW EXECUTE FUNCTION org_profile_versions_sequence_fn();
CREATE TABLE gl_accounts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL CHECK (length(code) BETWEEN 1 AND 20 AND (NOT (ltrim(code, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-') <> ''))),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  section text COLLATE "C" NOT NULL CHECK (section IN ('sales', 'cogs', 'sga', 'non_operating_income', 'non_operating_expense', 'extraordinary_gain', 'extraordinary_loss', 'income_tax', 'asset', 'liability', 'equity')),
  source text COLLATE "C" NOT NULL CHECK (source IN ('system', 'manual')),
  system_key text COLLATE "C" CHECK (system_key IS NULL OR (length(system_key) BETWEEN 1 AND 40 AND (NOT (ltrim(system_key, 'abcdefghijklmnopqrstuvwxyz0123456789_') <> '')))),
  cash_effect bigint NOT NULL DEFAULT 1 CHECK (cash_effect IN (0, 1)),
  sort_order bigint NOT NULL CHECK (sort_order BETWEEN 0 AND 100000),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 500),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code),
  CHECK ((source = 'system' AND system_key IS NOT NULL) OR (source = 'manual' AND system_key IS NULL))
);
CREATE UNIQUE INDEX gl_accounts_system_key ON gl_accounts (org_id, system_key) WHERE system_key IS NOT NULL;
CREATE TRIGGER gl_accounts_no_update BEFORE UPDATE ON gl_accounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('勘定科目は変更できません。新しい科目を足してください');
CREATE TRIGGER gl_accounts_no_delete BEFORE DELETE ON gl_accounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('勘定科目は削除できません');
CREATE TABLE gl_manual_amounts (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  account_id bigint NOT NULL,
  month text COLLATE "C" NOT NULL CHECK ((length(month) = 7 AND ltrim(substr(month, 1, 4), '0123456789') = '' AND substr(month, 5, 1) = '-' AND ltrim(substr(month, 6, 2), '0123456789') = '') AND substr(month, 6, 2) BETWEEN '01' AND '12'),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('flow', 'balance')),
  amount_yen bigint NOT NULL,
  tax_yen bigint NOT NULL DEFAULT 0,
  work_id bigint,
  basis text COLLATE "C" NOT NULL CHECK (length(trim(basis)) BETWEEN 1 AND 500),
  status text COLLATE "C" NOT NULL CHECK (status IN ('unverified', 'reviewed')),
  reverses_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK (reverses_id IS NULL OR reverses_id <> id),
  CHECK (kind = 'flow' OR tax_yen = 0)
);
CREATE UNIQUE INDEX gl_manual_amounts_reversal ON gl_manual_amounts (org_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX gl_manual_amounts_by_month ON gl_manual_amounts (org_id, month);
CREATE TRIGGER gl_manual_amounts_no_update BEFORE UPDATE ON gl_manual_amounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('手入力の額は変更できません。取消の行を足して入れ直してください');
CREATE TRIGGER gl_manual_amounts_no_delete BEFORE DELETE ON gl_manual_amounts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('手入力の額は削除できません。取消の行を足してください');
CREATE FUNCTION gl_manual_amounts_kind_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM gl_accounts a WHERE a.org_id = NEW.org_id AND a.id = NEW.account_id AND ((NEW.kind = 'balance' AND a.section IN ('asset', 'liability', 'equity')) OR (NEW.kind = 'flow' AND a.section NOT IN ('asset', 'liability', 'equity'))))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '発生額はPLの科目、月末の残高はBSの科目にだけ入れられます';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER gl_manual_amounts_kind BEFORE INSERT ON gl_manual_amounts FOR EACH ROW EXECUTE FUNCTION gl_manual_amounts_kind_fn();
CREATE FUNCTION gl_manual_amounts_reversal_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM gl_manual_amounts o WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_id AND o.reverses_id IS NULL AND o.account_id = NEW.account_id AND o.month = NEW.month AND o.kind = NEW.kind AND o.work_id IS NOT DISTINCT FROM NEW.work_id AND o.amount_yen = - NEW.amount_yen AND o.tax_yen = - NEW.tax_yen)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '取消の行は、取り消す行と同じ科目・月・種類・作品で、金額と税額の符号を逆にしてください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER gl_manual_amounts_reversal_scope BEFORE INSERT ON gl_manual_amounts FOR EACH ROW EXECUTE FUNCTION gl_manual_amounts_reversal_scope_fn();
CREATE FUNCTION gl_manual_amounts_tax_cash_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.tax_yen <> 0 AND EXISTS (SELECT 1 FROM gl_accounts a WHERE a.org_id = NEW.org_id AND a.id = NEW.account_id AND a.cash_effect = 0)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '現預金を動かさない科目には消費税額を入れられません';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER gl_manual_amounts_tax_cash BEFORE INSERT ON gl_manual_amounts FOR EACH ROW EXECUTE FUNCTION gl_manual_amounts_tax_cash_fn();
CREATE TABLE expense_payments (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  expense_id bigint NOT NULL,
  paid_on text COLLATE "C" NOT NULL CHECK ((length(paid_on) = 10 AND ltrim(substr(paid_on, 1, 4), '0123456789') = '' AND substr(paid_on, 5, 1) = '-' AND ltrim(substr(paid_on, 6, 1), '01') = '' AND ltrim(substr(paid_on, 7, 1), '0123456789') = '' AND substr(paid_on, 8, 1) = '-' AND ltrim(substr(paid_on, 9, 1), '0123') = '' AND ltrim(substr(paid_on, 10, 1), '0123456789') = '')),
  amount_yen bigint NOT NULL,
  method text COLLATE "C" NOT NULL CHECK (method IN ('transfer', 'cash', 'card', 'offset', 'other')),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 500),
  reverses_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((reverses_id IS NULL AND amount_yen > 0) OR (reverses_id IS NOT NULL AND reverses_id <> id AND amount_yen < 0 AND note IS NOT NULL AND length(trim(note)) > 0))
);
CREATE UNIQUE INDEX expense_payments_reversal ON expense_payments (org_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX expense_payments_by_expense ON expense_payments (org_id, expense_id);
CREATE TRIGGER expense_payments_no_update BEFORE UPDATE ON expense_payments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('経費の出金の記録は変更できません。取消の行を足してください');
CREATE TRIGGER expense_payments_no_delete BEFORE DELETE ON expense_payments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('経費の出金の記録は削除できません。取消の行を足してください');
CREATE FUNCTION expense_payments_reversal_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM expense_payments o WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_id AND o.reverses_id IS NULL AND o.expense_id = NEW.expense_id AND o.amount_yen = - NEW.amount_yen AND o.paid_on <= NEW.paid_on)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '出金の取消は、取り消す出金と同じ経費・同じ額で、出金日以後の日付にしてください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_payments_reversal_scope BEFORE INSERT ON expense_payments FOR EACH ROW EXECUTE FUNCTION expense_payments_reversal_scope_fn();
CREATE TABLE committee_investment_payments (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  term_version_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  paid_on text COLLATE "C" NOT NULL CHECK ((length(paid_on) = 10 AND ltrim(substr(paid_on, 1, 4), '0123456789') = '' AND substr(paid_on, 5, 1) = '-' AND ltrim(substr(paid_on, 6, 1), '01') = '' AND ltrim(substr(paid_on, 7, 1), '0123456789') = '' AND substr(paid_on, 8, 1) = '-' AND ltrim(substr(paid_on, 9, 1), '0123') = '' AND ltrim(substr(paid_on, 10, 1), '0123456789') = '')),
  amount_yen bigint NOT NULL,
  method text COLLATE "C" NOT NULL CHECK (method IN ('transfer', 'cash', 'card', 'offset', 'other')),
  note text COLLATE "C" CHECK (note IS NULL OR length(note) <= 500),
  reverses_id bigint,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE (org_id, id),
  CHECK ((reverses_id IS NULL AND amount_yen > 0) OR (reverses_id IS NOT NULL AND reverses_id <> id AND amount_yen < 0 AND note IS NOT NULL AND length(trim(note)) > 0))
);
CREATE UNIQUE INDEX committee_investment_payments_reversal ON committee_investment_payments (org_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX committee_investment_payments_by_version ON committee_investment_payments (org_id, term_version_id, partner_id);
CREATE TRIGGER committee_investment_payments_no_update BEFORE UPDATE ON committee_investment_payments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('出資の払込の記録は変更できません。取消の行を足してください');
CREATE TRIGGER committee_investment_payments_no_delete BEFORE DELETE ON committee_investment_payments FOR EACH ROW EXECUTE FUNCTION lite_reject_change('出資の払込の記録は削除できません。取消の行を足してください');
CREATE FUNCTION committee_investment_payments_reversal_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.reverses_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committee_investment_payments o WHERE o.org_id = NEW.org_id AND o.id = NEW.reverses_id AND o.reverses_id IS NULL AND o.term_version_id = NEW.term_version_id AND o.partner_id = NEW.partner_id AND o.amount_yen = - NEW.amount_yen AND o.paid_on <= NEW.paid_on)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '払込の取消は、取り消す払込と同じ委員会・参加者・同じ額で、払込日以後の日付にしてください';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER committee_investment_payments_reversal_scope BEFORE INSERT ON committee_investment_payments FOR EACH ROW EXECUTE FUNCTION committee_investment_payments_reversal_scope_fn();

-- ===== 0008_broadcast_proposal_drafts.sql =====
CREATE TABLE broadcast_proposal_drafts (
  org_id bigint NOT NULL,
  slot_id bigint NOT NULL,
  work_id bigint NOT NULL,
  proposal_key text COLLATE "C" NOT NULL CHECK (length(proposal_key) BETWEEN 1 AND 64),
  product_id bigint,
  station_partner_id bigint NOT NULL,
  broadcast_month text COLLATE "C" NOT NULL CHECK ((length(broadcast_month) = 7 AND ltrim(substr(broadcast_month, 1, 4), '0123456789') = '' AND substr(broadcast_month, 5, 1) = '-' AND ltrim(substr(broadcast_month, 6, 2), '0123456789') = '')),
  run_kind text COLLATE "C" NOT NULL CHECK (run_kind IN ('first', 'rerun')),
  as_of text COLLATE "C" NOT NULL CHECK ((length(as_of) = 10 AND ltrim(substr(as_of, 1, 4), '0123456789') = '' AND substr(as_of, 5, 1) = '-' AND ltrim(substr(as_of, 6, 2), '0123456789') = '' AND substr(as_of, 8, 1) = '-' AND ltrim(substr(as_of, 9, 2), '0123456789') = '')),
  proposal_from text COLLATE "C" NOT NULL CHECK ((length(proposal_from) = 10 AND ltrim(substr(proposal_from, 1, 4), '0123456789') = '' AND substr(proposal_from, 5, 1) = '-' AND ltrim(substr(proposal_from, 6, 2), '0123456789') = '' AND substr(proposal_from, 8, 1) = '-' AND ltrim(substr(proposal_from, 9, 2), '0123456789') = '')),
  proposal_to text COLLATE "C" NOT NULL CHECK ((length(proposal_to) = 10 AND ltrim(substr(proposal_to, 1, 4), '0123456789') = '' AND substr(proposal_to, 5, 1) = '-' AND ltrim(substr(proposal_to, 6, 2), '0123456789') = '' AND substr(proposal_to, 8, 1) = '-' AND ltrim(substr(proposal_to, 9, 2), '0123456789') = '')),
  basis_text text COLLATE "C" NOT NULL CHECK (length(basis_text) BETWEEN 1 AND 4000),
  memo text COLLATE "C" CHECK (memo IS NULL OR length(memo) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, slot_id),
  CHECK (proposal_to >= proposal_from)
);
CREATE TABLE broadcast_proposal_draft_deletions (
  org_id bigint NOT NULL,
  slot_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 1),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  deleted_by bigint NOT NULL,
  deleted_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, slot_id)
);
CREATE TRIGGER broadcast_proposal_drafts_no_update BEFORE UPDATE ON broadcast_proposal_drafts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast proposal draft immutable');
CREATE TRIGGER broadcast_proposal_drafts_no_delete BEFORE DELETE ON broadcast_proposal_drafts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast proposal draft immutable');
CREATE TRIGGER broadcast_proposal_draft_deletions_no_update BEFORE UPDATE ON broadcast_proposal_draft_deletions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast proposal draft deletion immutable');
CREATE TRIGGER broadcast_proposal_draft_deletions_no_delete BEFORE DELETE ON broadcast_proposal_draft_deletions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('broadcast proposal draft deletion immutable');
CREATE FUNCTION broadcast_proposal_drafts_new_draft_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id = NEW.org_id AND v.slot_id = NEW.slot_id AND v.revision = 1 AND v.status = 'draft' AND v.work_id = NEW.work_id AND v.broadcast_month = NEW.broadcast_month AND v.customer_partner_id = NEW.station_partner_id) OR EXISTS (SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id = NEW.org_id AND v.slot_id = NEW.slot_id AND v.revision > 1)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'broadcast proposal draft needs a new draft slot';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER broadcast_proposal_drafts_new_draft BEFORE INSERT ON broadcast_proposal_drafts FOR EACH ROW EXECUTE FUNCTION broadcast_proposal_drafts_new_draft_fn();
CREATE FUNCTION broadcast_proposal_draft_deletions_draft_only_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id = NEW.org_id AND v.slot_id = NEW.slot_id AND v.revision = NEW.revision AND v.status = 'cancelled') OR NOT EXISTS (SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id = NEW.org_id AND v.slot_id = NEW.slot_id AND v.revision = NEW.revision - 1 AND v.status = 'draft') OR EXISTS (SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id = NEW.org_id AND v.slot_id = NEW.slot_id AND v.revision > NEW.revision) OR EXISTS (SELECT 1 FROM broadcast_sale_links l WHERE l.org_id = NEW.org_id AND l.slot_id = NEW.slot_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'broadcast proposal draft deletion needs a cancelled draft';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER broadcast_proposal_draft_deletions_draft_only BEFORE INSERT ON broadcast_proposal_draft_deletions FOR EACH ROW EXECUTE FUNCTION broadcast_proposal_draft_deletions_draft_only_fn();
CREATE FUNCTION broadcast_sale_links_not_deleted_draft_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM broadcast_proposal_draft_deletions d WHERE d.org_id = NEW.org_id AND d.slot_id = NEW.slot_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'broadcast slot deleted as a proposal draft';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER broadcast_sale_links_not_deleted_draft BEFORE INSERT ON broadcast_sale_links FOR EACH ROW EXECUTE FUNCTION broadcast_sale_links_not_deleted_draft_fn();
CREATE FUNCTION broadcast_slot_versions_not_deleted_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM broadcast_proposal_draft_deletions d WHERE d.org_id = NEW.org_id AND d.slot_id = NEW.slot_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'broadcast slot deleted as a proposal draft';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER broadcast_slot_versions_not_deleted BEFORE INSERT ON broadcast_slot_versions FOR EACH ROW EXECUTE FUNCTION broadcast_slot_versions_not_deleted_fn();

-- ===== 0009_req5_master_extensions.sql =====
CREATE TABLE work_master_profile_versions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  series text COLLATE "C",
  label text COLLATE "C",
  production_category text COLLATE "C",
  registration_state text COLLATE "C" NOT NULL CHECK (registration_state IN ('unconfirmed', 'provisional', 'confirmed')),
  work_kind text COLLATE "C" NOT NULL CHECK (work_kind IN ('work', 'aggregate', 'unresolved')),
  internal_notes text COLLATE "C",
  other1 text COLLATE "C",
  other2 text COLLATE "C",
  lead_distribution_class text COLLATE "C",
  cycle_boundary_date text COLLATE "C",
  active_flag text COLLATE "C",
  overseas_sales_rights text COLLATE "C",
  distribution_rights text COLLATE "C",
  primary_use text COLLATE "C",
  secondary_use text COLLATE "C",
  copyright_royalty_notes text COLLATE "C",
  director_copyright_royalty_status text COLLATE "C",
  screenplay_copyright_royalty_status text COLLATE "C",
  original_work_copyright_royalty_status text COLLATE "C",
  music_copyright_royalty_status text COLLATE "C",
  producer_royalty_status text COLLATE "C",
  video_quality_subtitle_dubbing text COLLATE "C",
  dubbing_availability text COLLATE "C",
  music_copyright_society_registration text COLLATE "C",
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, work_id, revision)
);
CREATE FUNCTION work_master_profile_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> (SELECT COALESCE(max(revision), 0) + 1 FROM work_master_profile_versions WHERE org_id = NEW.org_id AND work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale master revision';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_master_profile_versions_sequence BEFORE INSERT ON work_master_profile_versions FOR EACH ROW EXECUTE FUNCTION work_master_profile_versions_sequence_fn();
CREATE TRIGGER work_master_profile_versions_no_update BEFORE UPDATE ON work_master_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER work_master_profile_versions_no_delete BEFORE DELETE ON work_master_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TABLE work_finance_versions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  committee_term_version_id bigint,
  self_partner_id bigint,
  production_cost_yen bigint CHECK (production_cost_yen BETWEEN 0 AND 1000000000000),
  production_cost_tax_basis text COLLATE "C" NOT NULL CHECK (production_cost_tax_basis IN ('unknown', 'ex_tax', 'inc_tax')),
  production_cost_status text COLLATE "C" NOT NULL CHECK (production_cost_status IN ('unknown', 'estimated', 'confirmed')),
  production_cost_as_of text COLLATE "C",
  production_cost_evidence text COLLATE "C",
  promotion_budget_yen bigint CHECK (promotion_budget_yen BETWEEN 0 AND 1000000000000),
  promotion_budget_tax_basis text COLLATE "C" NOT NULL CHECK (promotion_budget_tax_basis IN ('unknown', 'ex_tax', 'inc_tax')),
  promotion_budget_status text COLLATE "C" NOT NULL CHECK (promotion_budget_status IN ('unknown', 'estimated', 'confirmed')),
  promotion_budget_as_of text COLLATE "C",
  promotion_budget_evidence text COLLATE "C",
  own_investment_yen bigint CHECK (own_investment_yen BETWEEN 0 AND 1000000000000),
  own_investment_tax_basis text COLLATE "C" NOT NULL CHECK (own_investment_tax_basis IN ('unknown', 'ex_tax', 'inc_tax')) CHECK (own_investment_tax_basis = 'ex_tax'),
  own_investment_status text COLLATE "C" NOT NULL CHECK (own_investment_status IN ('unknown', 'estimated', 'confirmed')),
  own_investment_as_of text COLLATE "C",
  own_investment_evidence text COLLATE "C",
  sales_rights_purchase_yen bigint CHECK (sales_rights_purchase_yen BETWEEN 0 AND 1000000000000),
  sales_rights_purchase_tax_basis text COLLATE "C" NOT NULL CHECK (sales_rights_purchase_tax_basis IN ('unknown', 'ex_tax', 'inc_tax')),
  sales_rights_purchase_status text COLLATE "C" NOT NULL CHECK (sales_rights_purchase_status IN ('unknown', 'estimated', 'confirmed')),
  sales_rights_purchase_as_of text COLLATE "C",
  sales_rights_purchase_evidence text COLLATE "C",
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, work_id, revision),
  CHECK ((production_cost_yen IS NULL AND production_cost_status = 'unknown') OR (production_cost_yen IS NOT NULL AND production_cost_status <> 'unknown' AND production_cost_as_of IS NOT NULL AND production_cost_evidence IS NOT NULL AND length(trim(production_cost_evidence)) > 0)),
  CHECK ((promotion_budget_yen IS NULL AND promotion_budget_status = 'unknown') OR (promotion_budget_yen IS NOT NULL AND promotion_budget_status <> 'unknown' AND promotion_budget_as_of IS NOT NULL AND promotion_budget_evidence IS NOT NULL AND length(trim(promotion_budget_evidence)) > 0)),
  CHECK ((own_investment_yen IS NULL AND own_investment_status = 'unknown') OR (own_investment_yen IS NOT NULL AND own_investment_status <> 'unknown' AND own_investment_as_of IS NOT NULL AND own_investment_evidence IS NOT NULL AND length(trim(own_investment_evidence)) > 0)),
  CHECK ((sales_rights_purchase_yen IS NULL AND sales_rights_purchase_status = 'unknown') OR (sales_rights_purchase_yen IS NOT NULL AND sales_rights_purchase_status <> 'unknown' AND sales_rights_purchase_as_of IS NOT NULL AND sales_rights_purchase_evidence IS NOT NULL AND length(trim(sales_rights_purchase_evidence)) > 0)),
  CHECK (committee_term_version_id IS NULL OR (production_cost_yen IS NULL AND own_investment_yen IS NULL))
);
CREATE FUNCTION work_finance_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> (SELECT COALESCE(max(revision), 0) + 1 FROM work_finance_versions WHERE org_id = NEW.org_id AND work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale master revision';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_finance_versions_sequence BEFORE INSERT ON work_finance_versions FOR EACH ROW EXECUTE FUNCTION work_finance_versions_sequence_fn();
CREATE TRIGGER work_finance_versions_no_update BEFORE UPDATE ON work_finance_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER work_finance_versions_no_delete BEFORE DELETE ON work_finance_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE FUNCTION work_finance_committee_work_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.committee_term_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committee_term_versions v JOIN committee_contracts c ON c.org_id = v.org_id AND c.id = v.contract_id WHERE v.org_id = NEW.org_id AND v.id = NEW.committee_term_version_id AND c.work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'committee work mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_finance_committee_work BEFORE INSERT ON work_finance_versions FOR EACH ROW EXECUTE FUNCTION work_finance_committee_work_fn();
CREATE TABLE work_contract_set_versions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, work_id, revision)
);
CREATE FUNCTION work_contract_set_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> (SELECT COALESCE(max(revision), 0) + 1 FROM work_contract_set_versions WHERE org_id = NEW.org_id AND work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale master revision';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_contract_set_versions_sequence BEFORE INSERT ON work_contract_set_versions FOR EACH ROW EXECUTE FUNCTION work_contract_set_versions_sequence_fn();
CREATE TRIGGER work_contract_set_versions_no_update BEFORE UPDATE ON work_contract_set_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER work_contract_set_versions_no_delete BEFORE DELETE ON work_contract_set_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TABLE work_contracts (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  contract_key text COLLATE "C" NOT NULL,
  PRIMARY KEY (org_id, work_id, contract_key)
);
CREATE TABLE work_contract_versions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL,
  contract_key text COLLATE "C" NOT NULL,
  position bigint NOT NULL CHECK (position >= 0),
  title text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('acquisition', 'investment', 'production', 'distribution', 'other')),
  signed_on text COLLATE "C",
  starts_on text COLLATE "C",
  ends_on text COLLATE "C",
  partner_id bigint NOT NULL,
  document_reference text COLLATE "C" NOT NULL CHECK (length(trim(document_reference)) > 0),
  PRIMARY KEY (org_id, work_id, revision, contract_key),
  UNIQUE (org_id, work_id, revision, position),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)
);
CREATE TRIGGER work_contracts_no_update BEFORE UPDATE ON work_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER work_contracts_no_delete BEFORE DELETE ON work_contracts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER work_contract_versions_no_update BEFORE UPDATE ON work_contract_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER work_contract_versions_no_delete BEFORE DELETE ON work_contract_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TABLE work_rights_versions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, work_id, revision)
);
CREATE FUNCTION work_rights_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> (SELECT COALESCE(max(revision), 0) + 1 FROM work_rights_versions WHERE org_id = NEW.org_id AND work_id = NEW.work_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale master revision';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_rights_versions_sequence BEFORE INSERT ON work_rights_versions FOR EACH ROW EXECUTE FUNCTION work_rights_versions_sequence_fn();
CREATE TRIGGER work_rights_versions_no_update BEFORE UPDATE ON work_rights_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER work_rights_versions_no_delete BEFORE DELETE ON work_rights_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TABLE work_rights_party_versions (
  org_id bigint NOT NULL,
  work_id bigint NOT NULL,
  revision bigint NOT NULL,
  position bigint NOT NULL CHECK (position >= 0),
  partner_id bigint,
  name text COLLATE "C",
  role text COLLATE "C" NOT NULL CHECK (length(trim(role)) > 0),
  rights_scope text COLLATE "C",
  notes text COLLATE "C",
  evidence text COLLATE "C" NOT NULL CHECK (length(trim(evidence)) > 0),
  PRIMARY KEY (org_id, work_id, revision, position),
  CHECK (partner_id IS NOT NULL OR (name IS NOT NULL AND length(trim(name)) > 0))
);
CREATE TRIGGER work_rights_party_versions_no_update BEFORE UPDATE ON work_rights_party_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER work_rights_party_versions_no_delete BEFORE DELETE ON work_rights_party_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TABLE product_master_profile_versions (
  org_id bigint NOT NULL,
  product_id bigint NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  product_number text COLLATE "C",
  jan_code text COLLATE "C",
  product_type text COLLATE "C",
  media text COLLATE "C",
  release_on text COLLATE "C",
  sales_end_on text COLLATE "C",
  publisher_partner_id bigint,
  distributor_partner_id bigint,
  label text COLLATE "C",
  series text COLLATE "C",
  sales_class text COLLATE "C",
  disc_count bigint CHECK (disc_count >= 0),
  disc_layer text COLLATE "C",
  case_color text COLLATE "C",
  pressing_company text COLLATE "C",
  audio text COLLATE "C",
  subtitles text COLLATE "C",
  video_quality text COLLATE "C",
  runtime_minutes bigint CHECK (runtime_minutes >= 0),
  design text COLLATE "C",
  video_production_company text COLLATE "C",
  rights_holder text COLLATE "C",
  original_rights_holder text COLLATE "C",
  system_product_name text COLLATE "C",
  notes text COLLATE "C",
  other1 text COLLATE "C",
  other2 text COLLATE "C",
  price_yen bigint CHECK (price_yen BETWEEN 0 AND 1000000000000),
  price_tax_basis text COLLATE "C" NOT NULL CHECK (price_tax_basis IN ('unknown', 'ex_tax', 'inc_tax')),
  price_status text COLLATE "C" NOT NULL CHECK (price_status IN ('unknown', 'estimated', 'confirmed')),
  price_as_of text COLLATE "C",
  price_evidence text COLLATE "C",
  price_ex_tax_yen bigint CHECK (price_ex_tax_yen BETWEEN 0 AND 1000000000000),
  price_ex_tax_tax_basis text COLLATE "C" NOT NULL CHECK (price_ex_tax_tax_basis IN ('unknown', 'ex_tax', 'inc_tax')) CHECK (price_ex_tax_tax_basis = 'ex_tax'),
  price_ex_tax_status text COLLATE "C" NOT NULL CHECK (price_ex_tax_status IN ('unknown', 'estimated', 'confirmed')),
  price_ex_tax_as_of text COLLATE "C",
  price_ex_tax_evidence text COLLATE "C",
  price_inc_tax_yen bigint CHECK (price_inc_tax_yen BETWEEN 0 AND 1000000000000),
  price_inc_tax_tax_basis text COLLATE "C" NOT NULL CHECK (price_inc_tax_tax_basis IN ('unknown', 'ex_tax', 'inc_tax')) CHECK (price_inc_tax_tax_basis = 'inc_tax'),
  price_inc_tax_status text COLLATE "C" NOT NULL CHECK (price_inc_tax_status IN ('unknown', 'estimated', 'confirmed')),
  price_inc_tax_as_of text COLLATE "C",
  price_inc_tax_evidence text COLLATE "C",
  source_reference text COLLATE "C" NOT NULL CHECK (length(trim(source_reference)) BETWEEN 1 AND 1000),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  PRIMARY KEY (org_id, product_id, revision),
  CHECK ((price_yen IS NULL AND price_status = 'unknown') OR (price_yen IS NOT NULL AND price_status <> 'unknown' AND price_as_of IS NOT NULL AND price_evidence IS NOT NULL AND length(trim(price_evidence)) > 0)),
  CHECK ((price_ex_tax_yen IS NULL AND price_ex_tax_status = 'unknown') OR (price_ex_tax_yen IS NOT NULL AND price_ex_tax_status <> 'unknown' AND price_ex_tax_as_of IS NOT NULL AND price_ex_tax_evidence IS NOT NULL AND length(trim(price_ex_tax_evidence)) > 0)),
  CHECK ((price_inc_tax_yen IS NULL AND price_inc_tax_status = 'unknown') OR (price_inc_tax_yen IS NOT NULL AND price_inc_tax_status <> 'unknown' AND price_inc_tax_as_of IS NOT NULL AND price_inc_tax_evidence IS NOT NULL AND length(trim(price_inc_tax_evidence)) > 0)),
  CHECK (jan_code IS NULL OR (length(jan_code) IN (8, 13) AND (NOT (ltrim(jan_code, '0123456789') <> '')))),
  CHECK (release_on IS NULL OR sales_end_on IS NULL OR release_on <= sales_end_on)
);
CREATE FUNCTION product_master_profile_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.revision <> (SELECT COALESCE(max(revision), 0) + 1 FROM product_master_profile_versions WHERE org_id = NEW.org_id AND product_id = NEW.product_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale master revision';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER product_master_profile_versions_sequence BEFORE INSERT ON product_master_profile_versions FOR EACH ROW EXECUTE FUNCTION product_master_profile_versions_sequence_fn();
CREATE TRIGGER product_master_profile_versions_no_update BEFORE UPDATE ON product_master_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');
CREATE TRIGGER product_master_profile_versions_no_delete BEFORE DELETE ON product_master_profile_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('master version immutable');

-- ===== 0010_req6_expenses.sql =====
CREATE TABLE gl_account_class_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  account_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  normal_side text COLLATE "C" NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  balance_class text COLLATE "C" NOT NULL CHECK (balance_class IN ('none', 'current', 'noncurrent')),
  settlement_role text COLLATE "C" CHECK (settlement_role IN ('cash', 'payable', 'card_payable', 'receivable', 'refund_receivable', 'prepaid', 'input_tax', 'output_tax', 'withholding', 'wip')),
  UNIQUE (org_id, account_id, version_no),
  UNIQUE (org_id, id)
);
CREATE TRIGGER gl_account_class_versions_no_update BEFORE UPDATE ON gl_account_class_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER gl_account_class_versions_no_delete BEFORE DELETE ON gl_account_class_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX gl_account_class_versions_account_id_idx ON gl_account_class_versions (org_id, account_id);
CREATE INDEX gl_account_class_versions_author_idx ON gl_account_class_versions (org_id, created_by);
CREATE FUNCTION gl_account_class_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM gl_account_class_versions WHERE org_id = NEW.org_id AND account_id = NEW.account_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER gl_account_class_versions_sequence BEFORE INSERT ON gl_account_class_versions FOR EACH ROW EXECUTE FUNCTION gl_account_class_versions_sequence_fn();
CREATE TABLE expense_categories (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL CHECK (code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_categories_no_update BEFORE UPDATE ON expense_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_categories_no_delete BEFORE DELETE ON expense_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_categories_author_idx ON expense_categories (org_id, created_by);
CREATE TABLE expense_tax_categories (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL CHECK (code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_tax_categories_no_update BEFORE UPDATE ON expense_tax_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_tax_categories_no_delete BEFORE DELETE ON expense_tax_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_tax_categories_author_idx ON expense_tax_categories (org_id, created_by);
CREATE TABLE expense_withholding_categories (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL CHECK (code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_withholding_categories_no_update BEFORE UPDATE ON expense_withholding_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_withholding_categories_no_delete BEFORE DELETE ON expense_withholding_categories FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_withholding_categories_author_idx ON expense_withholding_categories (org_id, created_by);
CREATE TABLE expense_category_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  category_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  name text COLLATE "C" NOT NULL CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 100),
  account_class_version_id bigint NOT NULL,
  recognition_timing text COLLATE "C" NOT NULL CHECK (recognition_timing IN ('incurred_month', 'release_month_once')),
  UNIQUE (org_id, category_id, version_no),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_category_versions_no_update BEFORE UPDATE ON expense_category_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_category_versions_no_delete BEFORE DELETE ON expense_category_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_category_versions_category_id_idx ON expense_category_versions (org_id, category_id);
CREATE INDEX expense_category_versions_account_class_version_id_idx ON expense_category_versions (org_id, account_class_version_id);
CREATE INDEX expense_category_versions_author_idx ON expense_category_versions (org_id, created_by);
CREATE FUNCTION expense_category_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM expense_category_versions WHERE org_id = NEW.org_id AND category_id = NEW.category_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_category_versions_sequence BEFORE INSERT ON expense_category_versions FOR EACH ROW EXECUTE FUNCTION expense_category_versions_sequence_fn();
CREATE TABLE expense_category_alias_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  alias_text text COLLATE "C" NOT NULL CHECK (alias_text IS NULL OR length(trim(alias_text)) BETWEEN 1 AND 100),
  version_no bigint NOT NULL CHECK (version_no > 0),
  category_version_id bigint NOT NULL,
  active bigint NOT NULL CHECK (active IN (0, 1)),
  UNIQUE (org_id, alias_text, version_no),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_category_alias_versions_no_update BEFORE UPDATE ON expense_category_alias_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_category_alias_versions_no_delete BEFORE DELETE ON expense_category_alias_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_category_alias_versions_category_version_id_idx ON expense_category_alias_versions (org_id, category_version_id);
CREATE INDEX expense_category_alias_versions_author_idx ON expense_category_alias_versions (org_id, created_by);
CREATE FUNCTION expense_category_alias_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM expense_category_alias_versions WHERE org_id = NEW.org_id AND alias_text = NEW.alias_text)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_category_alias_versions_sequence BEFORE INSERT ON expense_category_alias_versions FOR EACH ROW EXECUTE FUNCTION expense_category_alias_versions_sequence_fn();
CREATE TABLE expense_tax_category_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tax_category_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  name text COLLATE "C" NOT NULL CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 100),
  tax_kind text COLLATE "C" NOT NULL CHECK (tax_kind IN ('taxable', 'exempt', 'non_taxable', 'out_of_scope')),
  rate_bps bigint,
  rounding text COLLATE "C" NOT NULL CHECK (rounding IN ('floor', 'nearest', 'ceil')),
  UNIQUE (org_id, tax_category_id, version_no),
  UNIQUE (org_id, id),
  CHECK ((tax_kind = 'taxable' AND rate_bps IS NOT NULL AND rate_bps IN (800, 1000)) OR (tax_kind <> 'taxable' AND rate_bps IS NULL))
);
CREATE TRIGGER expense_tax_category_versions_no_update BEFORE UPDATE ON expense_tax_category_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_tax_category_versions_no_delete BEFORE DELETE ON expense_tax_category_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_tax_category_versions_tax_category_id_idx ON expense_tax_category_versions (org_id, tax_category_id);
CREATE INDEX expense_tax_category_versions_author_idx ON expense_tax_category_versions (org_id, created_by);
CREATE FUNCTION expense_tax_category_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM expense_tax_category_versions WHERE org_id = NEW.org_id AND tax_category_id = NEW.tax_category_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_tax_category_versions_sequence BEFORE INSERT ON expense_tax_category_versions FOR EACH ROW EXECUTE FUNCTION expense_tax_category_versions_sequence_fn();
CREATE TABLE expense_withholding_category_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  withholding_category_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  name text COLLATE "C" NOT NULL CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 100),
  treatment text COLLATE "C" NOT NULL CHECK (treatment IN ('not_applicable', 'manual_confirmed')),
  basis text COLLATE "C" NOT NULL CHECK (basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
  UNIQUE (org_id, withholding_category_id, version_no),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_withholding_category_versions_no_update BEFORE UPDATE ON expense_withholding_category_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_withholding_category_versions_no_delete BEFORE DELETE ON expense_withholding_category_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_withholding_category_versions_withholding_cate_f60e46f4 ON expense_withholding_category_versions (org_id, withholding_category_id);
CREATE INDEX expense_withholding_category_versions_author_idx ON expense_withholding_category_versions (org_id, created_by);
CREATE FUNCTION expense_withholding_category_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM expense_withholding_category_versions WHERE org_id = NEW.org_id AND withholding_category_id = NEW.withholding_category_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_withholding_category_versions_sequence BEFORE INSERT ON expense_withholding_category_versions FOR EACH ROW EXECUTE FUNCTION expense_withholding_category_versions_sequence_fn();
CREATE TABLE partner_payment_term_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  partner_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  effective_from text COLLATE "C" NOT NULL CHECK (effective_from IS NULL OR ((length(effective_from) = 10 AND ltrim(substr(effective_from, 1, 4), '0123456789') = '' AND substr(effective_from, 5, 1) = '-' AND ltrim(substr(effective_from, 6, 2), '0123456789') = '' AND substr(effective_from, 8, 1) = '-' AND ltrim(substr(effective_from, 9, 2), '0123456789') = '') AND lite_date(effective_from) IS NOT NULL AND lite_date(effective_from) = effective_from)),
  closing_rule text COLLATE "C" NOT NULL CHECK (closing_rule IN ('day', 'month_end')),
  closing_day bigint CHECK (closing_day IS NULL OR lite_typeof(closing_day) = 'integer'),
  payment_month_offset bigint NOT NULL CHECK (lite_typeof(payment_month_offset) = 'integer' AND payment_month_offset BETWEEN 0 AND 24),
  payment_rule text COLLATE "C" NOT NULL CHECK (payment_rule IN ('day', 'month_end')),
  payment_day bigint CHECK (payment_day IS NULL OR lite_typeof(payment_day) = 'integer'),
  payment_method text COLLATE "C" NOT NULL CHECK (payment_method IN ('transfer', 'cash', 'card', 'offset', 'other')),
  UNIQUE (org_id, partner_id, version_no),
  UNIQUE (org_id, id),
  CHECK ((closing_rule = 'day' AND closing_day IS NOT NULL AND closing_day BETWEEN 1 AND 31) OR (closing_rule = 'month_end' AND closing_day IS NULL)),
  CHECK ((payment_rule = 'day' AND payment_day IS NOT NULL AND payment_day BETWEEN 1 AND 31) OR (payment_rule = 'month_end' AND payment_day IS NULL))
);
CREATE TRIGGER partner_payment_term_versions_no_update BEFORE UPDATE ON partner_payment_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER partner_payment_term_versions_no_delete BEFORE DELETE ON partner_payment_term_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX partner_payment_term_versions_partner_id_idx ON partner_payment_term_versions (org_id, partner_id);
CREATE INDEX partner_payment_term_versions_author_idx ON partner_payment_term_versions (org_id, created_by);
CREATE INDEX partner_payment_term_versions_effective_idx ON partner_payment_term_versions (org_id, partner_id, effective_from, version_no);
CREATE FUNCTION partner_payment_term_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM partner_payment_term_versions WHERE org_id = NEW.org_id AND partner_id = NEW.partner_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER partner_payment_term_versions_sequence BEFORE INSERT ON partner_payment_term_versions FOR EACH ROW EXECUTE FUNCTION partner_payment_term_versions_sequence_fn();
CREATE TABLE expense_accounting_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  expense_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  category_version_id bigint NOT NULL,
  tax_category_version_id bigint NOT NULL,
  withholding_category_version_id bigint,
  withholding_yen bigint CHECK (withholding_yen IS NULL OR (lite_typeof(withholding_yen) = 'integer' AND withholding_yen BETWEEN 0 AND 9007199254740991)),
  withholding_state text COLLATE "C" NOT NULL CHECK (withholding_state IN ('unverified', 'confirmed')),
  UNIQUE (org_id, expense_id, version_no),
  UNIQUE (org_id, id),
  CHECK ((withholding_state = 'unverified' AND withholding_yen IS NULL) OR (withholding_state = 'confirmed' AND withholding_yen IS NOT NULL AND withholding_category_version_id IS NOT NULL))
);
CREATE TRIGGER expense_accounting_versions_no_update BEFORE UPDATE ON expense_accounting_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_accounting_versions_no_delete BEFORE DELETE ON expense_accounting_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_accounting_versions_expense_id_idx ON expense_accounting_versions (org_id, expense_id);
CREATE INDEX expense_accounting_versions_category_version_id_idx ON expense_accounting_versions (org_id, category_version_id);
CREATE INDEX expense_accounting_versions_tax_category_version_id_idx ON expense_accounting_versions (org_id, tax_category_version_id);
CREATE INDEX expense_accounting_versions_withholding_category_version_id_idx ON expense_accounting_versions (org_id, withholding_category_version_id);
CREATE INDEX expense_accounting_versions_author_idx ON expense_accounting_versions (org_id, created_by);
CREATE FUNCTION expense_accounting_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM expense_accounting_versions WHERE org_id = NEW.org_id AND expense_id = NEW.expense_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_accounting_versions_sequence BEFORE INSERT ON expense_accounting_versions FOR EACH ROW EXECUTE FUNCTION expense_accounting_versions_sequence_fn();
CREATE TABLE expense_payment_accounting (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  payment_id bigint NOT NULL,
  accounting_version_id bigint NOT NULL,
  withheld_yen bigint NOT NULL CHECK (lite_typeof(withheld_yen) = 'integer' AND withheld_yen BETWEEN - 9007199254740991 AND 9007199254740991),
  cash_account_class_version_id bigint,
  PRIMARY KEY (org_id, payment_id)
);
CREATE TRIGGER expense_payment_accounting_no_update BEFORE UPDATE ON expense_payment_accounting FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_payment_accounting_no_delete BEFORE DELETE ON expense_payment_accounting FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_payment_accounting_accounting_version_id_idx ON expense_payment_accounting (org_id, accounting_version_id);
CREATE INDEX expense_payment_accounting_cash_account_class_version_id_idx ON expense_payment_accounting (org_id, cash_account_class_version_id);
CREATE INDEX expense_payment_accounting_author_idx ON expense_payment_accounting (org_id, created_by);
CREATE FUNCTION expense_class_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM gl_accounts a WHERE a.org_id = NEW.org_id AND a.id = NEW.account_id AND ((a.section IN ('asset', 'liability', 'equity') AND NEW.balance_class <> 'none') OR (a.section NOT IN ('asset', 'liability', 'equity') AND NEW.balance_class = 'none')) AND (NEW.settlement_role IS NULL OR (NEW.settlement_role IN ('cash', 'receivable', 'refund_receivable', 'prepaid', 'input_tax', 'wip') AND a.section = 'asset' AND NEW.normal_side = 'debit') OR (NEW.settlement_role IN ('payable', 'card_payable', 'output_tax', 'withholding') AND a.section = 'liability' AND NEW.normal_side = 'credit')))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'account classification mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_class_scope BEFORE INSERT ON gl_account_class_versions FOR EACH ROW EXECUTE FUNCTION expense_class_scope_fn();
CREATE FUNCTION expense_category_account_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM gl_account_class_versions c JOIN gl_accounts a ON a.org_id = c.org_id AND a.id = c.account_id WHERE c.org_id = NEW.org_id AND c.id = NEW.account_class_version_id AND a.section IN ('cogs', 'sga', 'non_operating_expense', 'extraordinary_loss', 'income_tax'))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'expense account required';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_category_account_scope BEFORE INSERT ON expense_category_versions FOR EACH ROW EXECUTE FUNCTION expense_category_account_scope_fn();
CREATE FUNCTION expense_accounting_withholding_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.withholding_yen > lite_max(0, (SELECT actual_inc_tax FROM expenses WHERE org_id = NEW.org_id AND id = NEW.expense_id)) OR (NEW.withholding_yen <> 0 AND EXISTS (SELECT 1 FROM expense_withholding_category_versions w WHERE w.org_id = NEW.org_id AND w.id = NEW.withholding_category_version_id AND w.treatment = 'not_applicable'))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'withholding mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_accounting_withholding BEFORE INSERT ON expense_accounting_versions FOR EACH ROW EXECUTE FUNCTION expense_accounting_withholding_fn();
CREATE FUNCTION expense_accounting_paid_lock_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no > 1 AND EXISTS (SELECT 1 FROM expense_payments p WHERE p.org_id = NEW.org_id AND p.expense_id = NEW.expense_id AND p.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM expense_payments r WHERE r.org_id = p.org_id AND r.reverses_id = p.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'paid accounting version locked';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_accounting_paid_lock BEFORE INSERT ON expense_accounting_versions FOR EACH ROW EXECUTE FUNCTION expense_accounting_paid_lock_fn();
CREATE FUNCTION expense_payment_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM expense_payments p JOIN expense_accounting_versions a ON a.org_id = p.org_id AND a.expense_id = p.expense_id WHERE p.org_id = NEW.org_id AND p.id = NEW.payment_id AND a.id = NEW.accounting_version_id AND a.withholding_state = 'confirmed' AND ((p.reverses_id IS NULL AND NEW.withheld_yen >= 0) OR (p.reverses_id IS NOT NULL AND EXISTS (SELECT 1 FROM expense_payment_accounting x WHERE x.org_id = p.org_id AND x.payment_id = p.reverses_id AND x.accounting_version_id = NEW.accounting_version_id AND x.withheld_yen = - NEW.withheld_yen AND x.cash_account_class_version_id IS NOT DISTINCT FROM NEW.cash_account_class_version_id))) AND (p.method NOT IN ('cash', 'transfer') OR EXISTS (SELECT 1 FROM gl_account_class_versions c WHERE c.org_id = NEW.org_id AND c.id = NEW.cash_account_class_version_id AND c.settlement_role = 'cash')))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'payment accounting mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_payment_scope BEFORE INSERT ON expense_payment_accounting FOR EACH ROW EXECUTE FUNCTION expense_payment_scope_fn();
CREATE FUNCTION expense_payment_balance_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expense_payments p JOIN expenses e ON e.org_id = p.org_id AND e.id = p.expense_id JOIN expense_accounting_versions a ON a.org_id = e.org_id AND a.id = NEW.accounting_version_id WHERE p.org_id = NEW.org_id AND p.id = NEW.payment_id AND ((SELECT COALESCE(SUM(q.amount_yen), 0) FROM expense_payments q WHERE q.org_id = e.org_id AND q.expense_id = e.id) + (SELECT COALESCE(SUM(x.withheld_yen), 0) FROM expense_payment_accounting x JOIN expense_payments q ON q.org_id = x.org_id AND q.id = x.payment_id WHERE q.org_id = e.org_id AND q.expense_id = e.id) + NEW.withheld_yen > e.actual_inc_tax OR (SELECT COALESCE(SUM(x.withheld_yen), 0) FROM expense_payment_accounting x JOIN expense_payments q ON q.org_id = x.org_id AND q.id = x.payment_id WHERE q.org_id = e.org_id AND q.expense_id = e.id) + NEW.withheld_yen > a.withholding_yen OR (SELECT COALESCE(SUM(q.amount_yen), 0) FROM expense_payments q WHERE q.org_id = e.org_id AND q.expense_id = e.id) > e.actual_inc_tax - a.withholding_yen))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'payment exceeds outstanding balance';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_payment_balance BEFORE INSERT ON expense_payment_accounting FOR EACH ROW EXECUTE FUNCTION expense_payment_balance_fn();
CREATE TABLE expense_cards (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 60),
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_cards_no_update BEFORE UPDATE ON expense_cards FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_cards_no_delete BEFORE DELETE ON expense_cards FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_cards_created_by_idx ON expense_cards (org_id, created_by);
CREATE TABLE expense_card_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  card_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  name text COLLATE "C" NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  effective_from text COLLATE "C" NOT NULL CHECK (length(effective_from) = 10 AND lite_date(effective_from) IS NOT NULL AND lite_date(effective_from) = effective_from),
  cash_account_class_version_id bigint NOT NULL,
  closing_rule text COLLATE "C" NOT NULL CHECK (closing_rule IN ('day', 'month_end')),
  closing_day bigint,
  payment_rule text COLLATE "C" NOT NULL CHECK (payment_rule IN ('day', 'month_end')),
  payment_day bigint,
  payment_month_offset bigint NOT NULL CHECK (payment_month_offset BETWEEN 0 AND 24),
  UNIQUE (org_id, card_id, version_no),
  UNIQUE (org_id, id),
  CHECK ((closing_rule = 'day' AND closing_day IS NOT NULL AND closing_day BETWEEN 1 AND 31) OR (closing_rule = 'month_end' AND closing_day IS NULL)),
  CHECK ((payment_rule = 'day' AND payment_day IS NOT NULL AND payment_day BETWEEN 1 AND 31) OR (payment_rule = 'month_end' AND payment_day IS NULL))
);
CREATE TRIGGER expense_card_versions_no_update BEFORE UPDATE ON expense_card_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_card_versions_no_delete BEFORE DELETE ON expense_card_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_card_versions_created_by_idx ON expense_card_versions (org_id, created_by);
CREATE INDEX expense_card_versions_card_id_idx ON expense_card_versions (org_id, card_id);
CREATE INDEX expense_card_versions_cash_account_class_version_id_idx ON expense_card_versions (org_id, cash_account_class_version_id);
CREATE FUNCTION expense_card_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM expense_card_versions WHERE org_id = NEW.org_id AND card_id = NEW.card_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_card_sequence BEFORE INSERT ON expense_card_versions FOR EACH ROW EXECUTE FUNCTION expense_card_sequence_fn();
CREATE TABLE expense_credit_links (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  expense_id bigint NOT NULL,
  original_expense_id bigint NOT NULL,
  original_invoice_id bigint NOT NULL,
  PRIMARY KEY (org_id, expense_id),
  CHECK (expense_id <> original_expense_id)
);
CREATE TRIGGER expense_credit_links_no_update BEFORE UPDATE ON expense_credit_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_credit_links_no_delete BEFORE DELETE ON expense_credit_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_credit_links_created_by_idx ON expense_credit_links (org_id, created_by);
CREATE INDEX expense_credit_links_expense_id_idx ON expense_credit_links (org_id, expense_id);
CREATE INDEX expense_credit_links_original_expense_id_idx ON expense_credit_links (org_id, original_expense_id);
CREATE INDEX expense_credit_links_original_invoice_id_idx ON expense_credit_links (org_id, original_invoice_id);
CREATE FUNCTION expense_credit_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM expenses e JOIN expenses o ON o.org_id = e.org_id AND o.partner_id = e.partner_id AND o.project_id = e.project_id AND o.work_id IS NOT DISTINCT FROM e.work_id JOIN expense_details d ON d.org_id = o.org_id AND d.expense_id = o.id JOIN expense_details cd ON cd.org_id = e.org_id AND cd.expense_id = e.id JOIN expense_invoice_versions v ON v.org_id = cd.org_id AND v.invoice_id = cd.invoice_id WHERE e.org_id = NEW.org_id AND e.id = NEW.expense_id AND o.id = NEW.original_expense_id AND d.invoice_id = NEW.original_invoice_id AND e.actual_inc_tax < 0 AND o.actual_inc_tax > 0 AND v.document_kind = 'credit_note')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'credit scope mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_credit_scope BEFORE INSERT ON expense_credit_links FOR EACH ROW EXECUTE FUNCTION expense_credit_scope_fn();
CREATE TABLE expense_payment_settlements (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  payment_id bigint NOT NULL,
  card_version_id bigint,
  counter_account_class_version_id bigint,
  billing_invoice_id bigint,
  billing_receipt_id bigint,
  counter_description text COLLATE "C" CHECK (counter_description IS NULL OR length(trim(counter_description)) BETWEEN 1 AND 1000),
  PRIMARY KEY (org_id, payment_id),
  UNIQUE (org_id, billing_receipt_id),
  CHECK ((card_version_id IS NOT NULL AND counter_account_class_version_id IS NULL AND billing_invoice_id IS NULL AND billing_receipt_id IS NULL) OR (card_version_id IS NULL AND counter_account_class_version_id IS NOT NULL AND counter_description IS NOT NULL AND ((billing_invoice_id IS NULL AND billing_receipt_id IS NULL) OR (billing_invoice_id IS NOT NULL AND billing_receipt_id IS NOT NULL))))
);
CREATE TRIGGER expense_payment_settlements_no_update BEFORE UPDATE ON expense_payment_settlements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_payment_settlements_no_delete BEFORE DELETE ON expense_payment_settlements FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_payment_settlements_created_by_idx ON expense_payment_settlements (org_id, created_by);
CREATE INDEX expense_payment_settlements_payment_id_idx ON expense_payment_settlements (org_id, payment_id);
CREATE INDEX expense_payment_settlements_card_version_id_idx ON expense_payment_settlements (org_id, card_version_id);
CREATE INDEX expense_payment_settlements_counter_account_class_vers_d802c3a4 ON expense_payment_settlements (org_id, counter_account_class_version_id);
CREATE INDEX expense_payment_settlements_billing_invoice_id_idx ON expense_payment_settlements (org_id, billing_invoice_id);
CREATE INDEX expense_payment_settlements_billing_receipt_id_idx ON expense_payment_settlements (org_id, billing_receipt_id);
CREATE FUNCTION expense_settlement_method_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM expense_payments p WHERE p.org_id = NEW.org_id AND p.id = NEW.payment_id AND p.reverses_id IS NULL AND ((p.method = 'card' AND NEW.card_version_id IS NOT NULL) OR (p.method = 'offset' AND NEW.counter_account_class_version_id IS NOT NULL)))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'settlement method mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_settlement_method BEFORE INSERT ON expense_payment_settlements FOR EACH ROW EXECUTE FUNCTION expense_settlement_method_fn();
CREATE TABLE expense_withholding_remittances (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL,
  occurred_on text COLLATE "C" NOT NULL CHECK (length(occurred_on) = 10 AND lite_date(occurred_on) IS NOT NULL AND lite_date(occurred_on) = occurred_on),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
  month_from text COLLATE "C" NOT NULL,
  month_to text COLLATE "C" NOT NULL,
  cash_account_class_version_id bigint NOT NULL,
  UNIQUE (org_id, code),
  UNIQUE (org_id, id),
  CHECK (month_from <= month_to AND length(month_from) = 7 AND length(month_to) = 7)
);
CREATE TRIGGER expense_withholding_remittances_no_update BEFORE UPDATE ON expense_withholding_remittances FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_withholding_remittances_no_delete BEFORE DELETE ON expense_withholding_remittances FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_withholding_remittances_created_by_idx ON expense_withholding_remittances (org_id, created_by);
CREATE INDEX expense_withholding_remittances_cash_account_class_ver_f5138063 ON expense_withholding_remittances (org_id, cash_account_class_version_id);
CREATE TABLE expense_withholding_allocations (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  remittance_id bigint NOT NULL,
  payment_month text COLLATE "C" NOT NULL,
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
  UNIQUE (org_id, id),
  UNIQUE (org_id, remittance_id, payment_month)
);
CREATE TRIGGER expense_withholding_allocations_no_update BEFORE UPDATE ON expense_withholding_allocations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_withholding_allocations_no_delete BEFORE DELETE ON expense_withholding_allocations FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_withholding_allocations_created_by_idx ON expense_withholding_allocations (org_id, created_by);
CREATE INDEX expense_withholding_allocations_remittance_id_idx ON expense_withholding_allocations (org_id, remittance_id);
CREATE TABLE expense_card_debits (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL,
  card_id bigint NOT NULL,
  occurred_on text COLLATE "C" NOT NULL CHECK (length(occurred_on) = 10 AND lite_date(occurred_on) IS NOT NULL AND lite_date(occurred_on) = occurred_on),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
  cash_account_class_version_id bigint NOT NULL,
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_card_debits_no_update BEFORE UPDATE ON expense_card_debits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_card_debits_no_delete BEFORE DELETE ON expense_card_debits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_card_debits_created_by_idx ON expense_card_debits (org_id, created_by);
CREATE INDEX expense_card_debits_card_id_idx ON expense_card_debits (org_id, card_id);
CREATE INDEX expense_card_debits_cash_account_class_version_id_idx ON expense_card_debits (org_id, cash_account_class_version_id);
CREATE TABLE expense_refund_receipts (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL,
  credit_expense_id bigint NOT NULL,
  partner_id bigint NOT NULL,
  occurred_on text COLLATE "C" NOT NULL CHECK (length(occurred_on) = 10 AND lite_date(occurred_on) IS NOT NULL AND lite_date(occurred_on) = occurred_on),
  amount_yen bigint NOT NULL CHECK (lite_typeof(amount_yen) = 'integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
  cash_account_class_version_id bigint NOT NULL,
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_refund_receipts_no_update BEFORE UPDATE ON expense_refund_receipts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_refund_receipts_no_delete BEFORE DELETE ON expense_refund_receipts FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_refund_receipts_created_by_idx ON expense_refund_receipts (org_id, created_by);
CREATE INDEX expense_refund_receipts_credit_expense_id_idx ON expense_refund_receipts (org_id, credit_expense_id);
CREATE INDEX expense_refund_receipts_partner_id_idx ON expense_refund_receipts (org_id, partner_id);
CREATE INDEX expense_refund_receipts_cash_account_class_version_id_idx ON expense_refund_receipts (org_id, cash_account_class_version_id);
CREATE TABLE expense_withholding_remittances_voids (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  record_id bigint NOT NULL,
  voided_on text COLLATE "C" NOT NULL CHECK (length(voided_on) = 10 AND lite_date(voided_on) IS NOT NULL AND lite_date(voided_on) = voided_on),
  PRIMARY KEY (org_id, record_id)
);
CREATE TRIGGER expense_withholding_remittances_voids_no_update BEFORE UPDATE ON expense_withholding_remittances_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_withholding_remittances_voids_no_delete BEFORE DELETE ON expense_withholding_remittances_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_withholding_remittances_voids_created_by_idx ON expense_withholding_remittances_voids (org_id, created_by);
CREATE INDEX expense_withholding_remittances_voids_record_id_idx ON expense_withholding_remittances_voids (org_id, record_id);
CREATE FUNCTION expense_withholding_remittances_voids_date_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.voided_on < (SELECT occurred_on FROM expense_withholding_remittances WHERE org_id = NEW.org_id AND id = NEW.record_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'void date precedes record';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_withholding_remittances_voids_date BEFORE INSERT ON expense_withholding_remittances_voids FOR EACH ROW EXECUTE FUNCTION expense_withholding_remittances_voids_date_fn();
CREATE FUNCTION expense_withholding_remittances_cash_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM gl_account_class_versions c WHERE c.org_id = NEW.org_id AND c.id = NEW.cash_account_class_version_id AND c.settlement_role = 'cash' AND c.active = 1)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'cash account required';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_withholding_remittances_cash BEFORE INSERT ON expense_withholding_remittances FOR EACH ROW EXECUTE FUNCTION expense_withholding_remittances_cash_fn();
CREATE TABLE expense_card_debits_voids (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  record_id bigint NOT NULL,
  voided_on text COLLATE "C" NOT NULL CHECK (length(voided_on) = 10 AND lite_date(voided_on) IS NOT NULL AND lite_date(voided_on) = voided_on),
  PRIMARY KEY (org_id, record_id)
);
CREATE TRIGGER expense_card_debits_voids_no_update BEFORE UPDATE ON expense_card_debits_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_card_debits_voids_no_delete BEFORE DELETE ON expense_card_debits_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_card_debits_voids_created_by_idx ON expense_card_debits_voids (org_id, created_by);
CREATE INDEX expense_card_debits_voids_record_id_idx ON expense_card_debits_voids (org_id, record_id);
CREATE FUNCTION expense_card_debits_voids_date_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.voided_on < (SELECT occurred_on FROM expense_card_debits WHERE org_id = NEW.org_id AND id = NEW.record_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'void date precedes record';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_card_debits_voids_date BEFORE INSERT ON expense_card_debits_voids FOR EACH ROW EXECUTE FUNCTION expense_card_debits_voids_date_fn();
CREATE FUNCTION expense_card_debits_cash_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM gl_account_class_versions c WHERE c.org_id = NEW.org_id AND c.id = NEW.cash_account_class_version_id AND c.settlement_role = 'cash' AND c.active = 1)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'cash account required';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_card_debits_cash BEFORE INSERT ON expense_card_debits FOR EACH ROW EXECUTE FUNCTION expense_card_debits_cash_fn();
CREATE TABLE expense_refund_receipts_voids (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  record_id bigint NOT NULL,
  voided_on text COLLATE "C" NOT NULL CHECK (length(voided_on) = 10 AND lite_date(voided_on) IS NOT NULL AND lite_date(voided_on) = voided_on),
  PRIMARY KEY (org_id, record_id)
);
CREATE TRIGGER expense_refund_receipts_voids_no_update BEFORE UPDATE ON expense_refund_receipts_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_refund_receipts_voids_no_delete BEFORE DELETE ON expense_refund_receipts_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_refund_receipts_voids_created_by_idx ON expense_refund_receipts_voids (org_id, created_by);
CREATE INDEX expense_refund_receipts_voids_record_id_idx ON expense_refund_receipts_voids (org_id, record_id);
CREATE FUNCTION expense_refund_receipts_voids_date_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.voided_on < (SELECT occurred_on FROM expense_refund_receipts WHERE org_id = NEW.org_id AND id = NEW.record_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'void date precedes record';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_refund_receipts_voids_date BEFORE INSERT ON expense_refund_receipts_voids FOR EACH ROW EXECUTE FUNCTION expense_refund_receipts_voids_date_fn();
CREATE FUNCTION expense_refund_receipts_cash_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM gl_account_class_versions c WHERE c.org_id = NEW.org_id AND c.id = NEW.cash_account_class_version_id AND c.settlement_role = 'cash' AND c.active = 1)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'cash account required';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_refund_receipts_cash BEFORE INSERT ON expense_refund_receipts FOR EACH ROW EXECUTE FUNCTION expense_refund_receipts_cash_fn();
CREATE FUNCTION expense_offset_reverse_together_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expense_payment_settlements s WHERE s.org_id = NEW.org_id AND s.billing_receipt_id = NEW.receipt_id AND NOT EXISTS (SELECT 1 FROM expense_payments p WHERE p.org_id = s.org_id AND p.reverses_id = s.payment_id AND p.paid_on = NEW.reversed_on))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'reverse offset through expense payment';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_offset_reverse_together BEFORE INSERT ON billing_receipt_reversals FOR EACH ROW EXECUTE FUNCTION expense_offset_reverse_together_fn();
CREATE FUNCTION expense_card_cash_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM gl_account_class_versions c WHERE c.org_id = NEW.org_id AND c.id = NEW.cash_account_class_version_id AND c.settlement_role = 'cash')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'card cash account mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_card_cash BEFORE INSERT ON expense_card_versions FOR EACH ROW EXECUTE FUNCTION expense_card_cash_fn();
CREATE FUNCTION expense_refund_partner_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM expenses e WHERE e.org_id = NEW.org_id AND e.id = NEW.credit_expense_id AND e.partner_id = NEW.partner_id AND e.actual_inc_tax < 0)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'refund partner mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_refund_partner BEFORE INSERT ON expense_refund_receipts FOR EACH ROW EXECUTE FUNCTION expense_refund_partner_fn();
CREATE FUNCTION expense_offset_receipt_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.billing_receipt_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM expense_payments p JOIN expenses e ON e.org_id = p.org_id AND e.id = p.expense_id JOIN billing_receipts r ON r.org_id = e.org_id AND r.partner_id = e.partner_id JOIN billing_receipt_allocations a ON a.org_id = r.org_id AND a.receipt_id = r.id JOIN billing_invoices i ON i.org_id = a.org_id AND i.id = a.invoice_id AND i.partner_id = e.partner_id WHERE p.org_id = NEW.org_id AND p.id = NEW.payment_id AND r.id = NEW.billing_receipt_id AND i.id = NEW.billing_invoice_id AND r.amount_yen = p.amount_yen AND a.amount_yen = p.amount_yen AND r.received_on = p.paid_on)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'offset receipt mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_offset_receipt_scope BEFORE INSERT ON expense_payment_settlements FOR EACH ROW EXECUTE FUNCTION expense_offset_receipt_scope_fn();
CREATE FUNCTION expense_remittance_month_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM expense_withholding_remittances r WHERE r.org_id = NEW.org_id AND r.id = NEW.remittance_id AND NEW.payment_month BETWEEN r.month_from AND r.month_to AND NEW.amount_yen + COALESCE((SELECT SUM(a.amount_yen) FROM expense_withholding_allocations a WHERE a.org_id = r.org_id AND a.remittance_id = r.id), 0) <= r.amount_yen)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'remittance allocation mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_remittance_month_scope BEFORE INSERT ON expense_withholding_allocations FOR EACH ROW EXECUTE FUNCTION expense_remittance_month_scope_fn();
CREATE TABLE expense_invoices (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code text COLLATE "C" NOT NULL CHECK (code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
  partner_id bigint NOT NULL,
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_invoices_no_update BEFORE UPDATE ON expense_invoices FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_invoices_no_delete BEFORE DELETE ON expense_invoices FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_invoices_partner_id_idx ON expense_invoices (org_id, partner_id);
CREATE INDEX expense_invoices_author_idx ON expense_invoices (org_id, created_by);
CREATE TABLE expense_invoice_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoice_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  active bigint NOT NULL CHECK (active IN (0, 1)),
  invoice_number text COLLATE "C" CHECK (invoice_number IS NULL OR length(trim(invoice_number)) BETWEEN 1 AND 120),
  document_kind text COLLATE "C" NOT NULL CHECK (document_kind IN ('invoice', 'receipt', 'credit_note', 'other')),
  invoice_on text COLLATE "C" NOT NULL CHECK (invoice_on IS NULL OR ((length(invoice_on) = 10 AND ltrim(substr(invoice_on, 1, 4), '0123456789') = '' AND substr(invoice_on, 5, 1) = '-' AND ltrim(substr(invoice_on, 6, 2), '0123456789') = '' AND substr(invoice_on, 8, 1) = '-' AND ltrim(substr(invoice_on, 9, 2), '0123456789') = '') AND lite_date(invoice_on) IS NOT NULL AND lite_date(invoice_on) = invoice_on)),
  closing_on text COLLATE "C" NOT NULL CHECK (closing_on IS NULL OR ((length(closing_on) = 10 AND ltrim(substr(closing_on, 1, 4), '0123456789') = '' AND substr(closing_on, 5, 1) = '-' AND ltrim(substr(closing_on, 6, 2), '0123456789') = '' AND substr(closing_on, 8, 1) = '-' AND ltrim(substr(closing_on, 9, 2), '0123456789') = '') AND lite_date(closing_on) IS NOT NULL AND lite_date(closing_on) = closing_on)),
  due_on text COLLATE "C" NOT NULL CHECK (due_on IS NULL OR ((length(due_on) = 10 AND ltrim(substr(due_on, 1, 4), '0123456789') = '' AND substr(due_on, 5, 1) = '-' AND ltrim(substr(due_on, 6, 2), '0123456789') = '' AND substr(due_on, 8, 1) = '-' AND ltrim(substr(due_on, 9, 2), '0123456789') = '') AND lite_date(due_on) IS NOT NULL AND lite_date(due_on) = due_on)),
  payment_term_version_id bigint,
  closing_origin text COLLATE "C" NOT NULL CHECK (closing_origin IN ('term', 'manual', 'override')),
  due_origin text COLLATE "C" NOT NULL CHECK (due_origin IN ('term', 'manual', 'override')),
  override_note text COLLATE "C" CHECK (override_note IS NULL OR length(trim(override_note)) BETWEEN 1 AND 1000),
  payment_method text COLLATE "C" NOT NULL CHECK (payment_method IN ('transfer', 'cash', 'card', 'offset', 'other')),
  UNIQUE (org_id, invoice_id, version_no),
  UNIQUE (org_id, id),
  CHECK (invoice_on <= closing_on AND closing_on <= due_on),
  CHECK ((closing_origin = 'manual' AND due_origin = 'manual') OR payment_term_version_id IS NOT NULL),
  CHECK ((closing_origin <> 'override' AND due_origin <> 'override') OR override_note IS NOT NULL)
);
CREATE TRIGGER expense_invoice_versions_no_update BEFORE UPDATE ON expense_invoice_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_invoice_versions_no_delete BEFORE DELETE ON expense_invoice_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_invoice_versions_invoice_id_idx ON expense_invoice_versions (org_id, invoice_id);
CREATE INDEX expense_invoice_versions_payment_term_version_id_idx ON expense_invoice_versions (org_id, payment_term_version_id);
CREATE INDEX expense_invoice_versions_author_idx ON expense_invoice_versions (org_id, created_by);
CREATE INDEX expense_invoice_versions_dates_idx ON expense_invoice_versions (org_id, closing_on, due_on);
CREATE FUNCTION expense_invoice_versions_sequence_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM expense_invoice_versions WHERE org_id = NEW.org_id AND invoice_id = NEW.invoice_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale expense version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_invoice_versions_sequence BEFORE INSERT ON expense_invoice_versions FOR EACH ROW EXECUTE FUNCTION expense_invoice_versions_sequence_fn();
CREATE TABLE expense_details (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  expense_id bigint NOT NULL,
  invoice_id bigint NOT NULL,
  recorded_on text COLLATE "C" CHECK (recorded_on IS NULL OR ((length(recorded_on) = 10 AND ltrim(substr(recorded_on, 1, 4), '0123456789') = '' AND substr(recorded_on, 5, 1) = '-' AND ltrim(substr(recorded_on, 6, 2), '0123456789') = '' AND substr(recorded_on, 8, 1) = '-' AND ltrim(substr(recorded_on, 9, 2), '0123456789') = '') AND lite_date(recorded_on) IS NOT NULL AND lite_date(recorded_on) = recorded_on)),
  distribution_type_code text COLLATE "C",
  product_id bigint,
  source_product_number text COLLATE "C" CHECK (source_product_number IS NULL OR length(trim(source_product_number)) BETWEEN 1 AND 240),
  source_product_name text COLLATE "C" CHECK (source_product_name IS NULL OR length(trim(source_product_name)) BETWEEN 1 AND 240),
  source_client_name text COLLATE "C" CHECK (source_client_name IS NULL OR length(trim(source_client_name)) BETWEEN 1 AND 240),
  supplier_text text COLLATE "C" CHECK (supplier_text IS NULL OR length(trim(supplier_text)) BETWEEN 1 AND 240),
  specification text COLLATE "C" CHECK (specification IS NULL OR length(trim(specification)) BETWEEN 1 AND 1000),
  memo text COLLATE "C" CHECK (memo IS NULL OR length(trim(memo)) BETWEEN 1 AND 1000),
  quantity_x10000 bigint CHECK (quantity_x10000 IS NULL OR (lite_typeof(quantity_x10000) = 'integer' AND quantity_x10000 BETWEEN 0 AND 9007199254740991)),
  unit_price_x10000 bigint CHECK (unit_price_x10000 IS NULL OR (lite_typeof(unit_price_x10000) = 'integer' AND unit_price_x10000 BETWEEN 0 AND 9007199254740991)),
  PRIMARY KEY (org_id, expense_id)
);
CREATE TRIGGER expense_details_no_update BEFORE UPDATE ON expense_details FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_details_no_delete BEFORE DELETE ON expense_details FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_details_invoice_id_idx ON expense_details (org_id, invoice_id);
CREATE INDEX expense_details_product_id_idx ON expense_details (org_id, product_id);
CREATE INDEX expense_details_author_idx ON expense_details (org_id, created_by);
CREATE INDEX expense_details_distribution_idx ON expense_details (distribution_type_code);
CREATE TABLE expense_line_voids (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  expense_id bigint NOT NULL,
  voided_on text COLLATE "C" NOT NULL CHECK (voided_on IS NULL OR ((length(voided_on) = 10 AND ltrim(substr(voided_on, 1, 4), '0123456789') = '' AND substr(voided_on, 5, 1) = '-' AND ltrim(substr(voided_on, 6, 2), '0123456789') = '' AND substr(voided_on, 8, 1) = '-' AND ltrim(substr(voided_on, 9, 2), '0123456789') = '') AND lite_date(voided_on) IS NOT NULL AND lite_date(voided_on) = voided_on)),
  replacement_expense_id bigint,
  UNIQUE (org_id, replacement_expense_id),
  CHECK (replacement_expense_id IS NULL OR replacement_expense_id <> expense_id),
  PRIMARY KEY (org_id, expense_id)
);
CREATE TRIGGER expense_line_voids_no_update BEFORE UPDATE ON expense_line_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_line_voids_no_delete BEFORE DELETE ON expense_line_voids FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_line_voids_replacement_expense_id_idx ON expense_line_voids (org_id, replacement_expense_id);
CREATE INDEX expense_line_voids_author_idx ON expense_line_voids (org_id, created_by);
CREATE INDEX expense_line_voids_date_idx ON expense_line_voids (org_id, voided_on);
CREATE TABLE expense_source_files (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  file_name text COLLATE "C" NOT NULL CHECK (file_name IS NULL OR length(trim(file_name)) BETWEEN 1 AND 240),
  media_type text COLLATE "C" NOT NULL CHECK (media_type IS NULL OR length(trim(media_type)) BETWEEN 1 AND 100),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  raw_sha256 text COLLATE "C" NOT NULL CHECK (length(raw_sha256) = 64 AND (NOT (ltrim(raw_sha256, 'abcdef0123456789') <> ''))),
  original_base64 text COLLATE "C" NOT NULL,
  UNIQUE (org_id, raw_sha256),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_source_files_no_update BEFORE UPDATE ON expense_source_files FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_source_files_no_delete BEFORE DELETE ON expense_source_files FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_source_files_author_idx ON expense_source_files (org_id, created_by);
CREATE INDEX expense_source_files_created_idx ON expense_source_files (org_id, created_at);
CREATE TABLE expense_invoice_file_links (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoice_id bigint NOT NULL,
  file_id bigint NOT NULL,
  purpose text COLLATE "C" NOT NULL CHECK (purpose IN ('invoice', 'receipt', 'supporting')),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_invoice_file_links_no_update BEFORE UPDATE ON expense_invoice_file_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_invoice_file_links_no_delete BEFORE DELETE ON expense_invoice_file_links FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_invoice_file_links_invoice_id_idx ON expense_invoice_file_links (org_id, invoice_id);
CREATE INDEX expense_invoice_file_links_file_id_idx ON expense_invoice_file_links (org_id, file_id);
CREATE INDEX expense_invoice_file_links_author_idx ON expense_invoice_file_links (org_id, created_by);
CREATE TABLE expense_invoice_file_unlinks (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  link_id bigint NOT NULL,
  PRIMARY KEY (org_id, link_id)
);
CREATE TRIGGER expense_invoice_file_unlinks_no_update BEFORE UPDATE ON expense_invoice_file_unlinks FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_invoice_file_unlinks_no_delete BEFORE DELETE ON expense_invoice_file_unlinks FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_invoice_file_unlinks_author_idx ON expense_invoice_file_unlinks (org_id, created_by);
CREATE TABLE expense_pending_rows (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id bigint NOT NULL,
  code text COLLATE "C" NOT NULL CHECK (code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
  raw_payload_json text COLLATE "C" NOT NULL CHECK (lite_json_valid(raw_payload_json) AND lite_json_type(raw_payload_json) = 'object' AND length(convert_to(raw_payload_json, 'UTF8')) <= 65536),
  UNIQUE (org_id, code),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_pending_rows_no_update BEFORE UPDATE ON expense_pending_rows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_pending_rows_no_delete BEFORE DELETE ON expense_pending_rows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE INDEX expense_pending_rows_project_id_idx ON expense_pending_rows (org_id, project_id);
CREATE INDEX expense_pending_rows_author_idx ON expense_pending_rows (org_id, created_by);
CREATE FUNCTION expense_invoice_term_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.payment_term_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM partner_payment_term_versions t JOIN expense_invoices i ON i.org_id = t.org_id AND i.partner_id = t.partner_id WHERE i.org_id = NEW.org_id AND i.id = NEW.invoice_id AND t.id = NEW.payment_term_version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'payment term partner mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_invoice_term_scope BEFORE INSERT ON expense_invoice_versions FOR EACH ROW EXECUTE FUNCTION expense_invoice_term_scope_fn();
CREATE FUNCTION expense_detail_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NOT EXISTS (SELECT 1 FROM expenses e JOIN expense_invoices i ON i.org_id = e.org_id AND (i.partner_id = e.partner_id OR e.partner_id IS NULL) JOIN expense_invoice_versions v ON v.org_id = i.org_id AND v.invoice_id = i.id WHERE e.org_id = NEW.org_id AND e.id = NEW.expense_id AND i.id = NEW.invoice_id AND v.active = 1 AND v.version_no = (SELECT max(x.version_no) FROM expense_invoice_versions x WHERE x.org_id = i.org_id AND x.invoice_id = i.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice partner mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_detail_scope BEFORE INSERT ON expense_details FOR EACH ROW EXECUTE FUNCTION expense_detail_scope_fn();
CREATE FUNCTION expense_detail_product_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM expenses e JOIN product_works p ON p.org_id = e.org_id AND p.work_id = e.work_id WHERE e.org_id = NEW.org_id AND e.id = NEW.expense_id AND p.product_id = NEW.product_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'product work mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_detail_product_scope BEFORE INSERT ON expense_details FOR EACH ROW EXECUTE FUNCTION expense_detail_product_scope_fn();
CREATE FUNCTION expenses_req6_no_update_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expense_details d WHERE d.org_id = OLD.org_id AND d.expense_id = OLD.id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice expense immutable';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expenses_req6_no_update BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_req6_no_update_fn();
CREATE FUNCTION expenses_req6_no_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expense_details d WHERE d.org_id = OLD.org_id AND d.expense_id = OLD.id)) IS NOT TRUE THEN RETURN OLD; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invoice expense immutable';
  RETURN OLD;
END
$fn$;
CREATE TRIGGER expenses_req6_no_delete BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_req6_no_delete_fn();
CREATE FUNCTION expense_file_link_unique_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expense_invoice_file_links l WHERE l.org_id = NEW.org_id AND l.invoice_id = NEW.invoice_id AND l.file_id = NEW.file_id AND l.purpose = NEW.purpose AND NOT EXISTS (SELECT 1 FROM expense_invoice_file_unlinks u WHERE u.org_id = l.org_id AND u.link_id = l.id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'duplicate file link';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_file_link_unique BEFORE INSERT ON expense_invoice_file_links FOR EACH ROW EXECUTE FUNCTION expense_file_link_unique_fn();
CREATE FUNCTION expense_void_paid_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expense_payments p WHERE p.org_id = NEW.org_id AND p.expense_id = NEW.expense_id AND p.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM expense_payments r WHERE r.org_id = p.org_id AND r.reverses_id = p.id)) OR EXISTS (SELECT 1 FROM committee_snapshot_expenses s WHERE s.org_id = NEW.org_id AND s.expense_id = NEW.expense_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'paid or settled expense cannot be voided';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_void_paid BEFORE INSERT ON expense_line_voids FOR EACH ROW EXECUTE FUNCTION expense_void_paid_fn();
CREATE FUNCTION expense_void_replacement_scope_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.replacement_expense_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM expenses e JOIN expenses r ON r.org_id = e.org_id AND r.project_id = e.project_id AND r.work_id IS NOT DISTINCT FROM e.work_id JOIN expense_details d ON d.org_id = e.org_id AND d.expense_id = e.id JOIN expense_details n ON n.org_id = r.org_id AND n.expense_id = r.id AND n.invoice_id = d.invoice_id WHERE e.org_id = NEW.org_id AND e.id = NEW.expense_id AND r.id = NEW.replacement_expense_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'replacement scope mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_void_replacement_scope BEFORE INSERT ON expense_line_voids FOR EACH ROW EXECUTE FUNCTION expense_void_replacement_scope_fn();
CREATE FUNCTION expense_invoice_cancel_live_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.active = 0 AND EXISTS (SELECT 1 FROM expense_details d WHERE d.org_id = NEW.org_id AND d.invoice_id = NEW.invoice_id AND NOT EXISTS (SELECT 1 FROM expense_line_voids v WHERE v.org_id = d.org_id AND v.expense_id = d.expense_id))) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'void all invoice lines first';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_invoice_cancel_live BEFORE INSERT ON expense_invoice_versions FOR EACH ROW EXECUTE FUNCTION expense_invoice_cancel_live_fn();
CREATE TABLE expense_import_batches (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  file_id bigint NOT NULL,
  layout text COLLATE "C" NOT NULL CHECK (layout IN ('legacy22', 'standard25')),
  raw_sha256 text COLLATE "C" NOT NULL,
  UNIQUE (org_id, raw_sha256),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_import_batches_no_update BEFORE UPDATE ON expense_import_batches FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_import_batches_no_delete BEFORE DELETE ON expense_import_batches FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TABLE expense_import_rows (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL,
  row_no bigint NOT NULL,
  raw_json text COLLATE "C" NOT NULL,
  UNIQUE (org_id, batch_id, row_no),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_import_rows_no_update BEFORE UPDATE ON expense_import_rows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_import_rows_no_delete BEFORE DELETE ON expense_import_rows FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TABLE expense_import_versions (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  hash text COLLATE "C" NOT NULL,
  expires_at text COLLATE "C" NOT NULL,
  payload_json text COLLATE "C" NOT NULL,
  UNIQUE (org_id, batch_id, version_no),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_import_versions_no_update BEFORE UPDATE ON expense_import_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_import_versions_no_delete BEFORE DELETE ON expense_import_versions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TABLE expense_import_events (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  batch_id bigint NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('committed', 'cancelled')),
  version_id bigint NOT NULL,
  occurred_on text COLLATE "C" NOT NULL,
  UNIQUE (org_id, batch_id, kind),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_import_events_no_update BEFORE UPDATE ON expense_import_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_import_events_no_delete BEFORE DELETE ON expense_import_events FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TABLE expense_import_row_commits (
  org_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  row_id bigint NOT NULL,
  version_id bigint NOT NULL,
  expense_id bigint NOT NULL,
  UNIQUE (org_id, row_id),
  UNIQUE (org_id, expense_id),
  UNIQUE (org_id, id)
);
CREATE TRIGGER expense_import_row_commits_no_update BEFORE UPDATE ON expense_import_row_commits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_import_row_commits_no_delete BEFORE DELETE ON expense_import_row_commits FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE FUNCTION expense_import_versions_order_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.version_no <> (SELECT COALESCE(max(version_no), 0) + 1 FROM expense_import_versions WHERE org_id = NEW.org_id AND batch_id = NEW.batch_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'stale import version';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_import_versions_order BEFORE INSERT ON expense_import_versions FOR EACH ROW EXECUTE FUNCTION expense_import_versions_order_fn();
CREATE FUNCTION expense_import_row_same_batch_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF ((SELECT batch_id FROM expense_import_rows WHERE org_id = NEW.org_id AND id = NEW.row_id) <> (SELECT batch_id FROM expense_import_versions WHERE org_id = NEW.org_id AND id = NEW.version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'import batch mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_import_row_same_batch BEFORE INSERT ON expense_import_row_commits FOR EACH ROW EXECUTE FUNCTION expense_import_row_same_batch_fn();
CREATE FUNCTION expense_import_no_resolve_cancelled_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (EXISTS (SELECT 1 FROM expense_import_events e JOIN expense_import_rows r ON r.org_id = e.org_id AND r.batch_id = e.batch_id WHERE r.org_id = NEW.org_id AND r.id = NEW.row_id AND e.kind = 'cancelled')) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'import cancelled';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_import_no_resolve_cancelled BEFORE INSERT ON expense_import_row_commits FOR EACH ROW EXECUTE FUNCTION expense_import_no_resolve_cancelled_fn();
CREATE FUNCTION expense_import_event_same_batch_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.batch_id <> (SELECT batch_id FROM expense_import_versions WHERE org_id = NEW.org_id AND id = NEW.version_id)) IS NOT TRUE THEN RETURN NEW; END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'import batch mismatch';
  RETURN NEW;
END
$fn$;
CREATE TRIGGER expense_import_event_same_batch BEFORE INSERT ON expense_import_events FOR EACH ROW EXECUTE FUNCTION expense_import_event_same_batch_fn();
CREATE TABLE expense_pending_resolutions (
  org_id bigint NOT NULL,
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  pending_id bigint NOT NULL,
  expense_id bigint NOT NULL,
  created_by bigint NOT NULL,
  created_at text COLLATE "C" NOT NULL DEFAULT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason text COLLATE "C" NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  UNIQUE (org_id, id),
  UNIQUE (org_id, pending_id),
  UNIQUE (org_id, expense_id)
);
CREATE TRIGGER expense_pending_resolutions_no_update BEFORE UPDATE ON expense_pending_resolutions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');
CREATE TRIGGER expense_pending_resolutions_no_delete BEFORE DELETE ON expense_pending_resolutions FOR EACH ROW EXECUTE FUNCTION lite_reject_change('expense record immutable');

-- ===== 0011_cloud_analytics.sql =====
CREATE TABLE cloud_analytics_state (
  org_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 0,
  lock_job text COLLATE "C",
  lock_until text COLLATE "C",
  active_run text COLLATE "C",
  active_hash text COLLATE "C"
);
CREATE TABLE cloud_analytics_jobs (
  id text COLLATE "C" PRIMARY KEY,
  org_id bigint NOT NULL,
  generation bigint NOT NULL,
  status text COLLATE "C" NOT NULL,
  as_of text COLLATE "C" NOT NULL,
  definition_version text COLLATE "C" NOT NULL,
  audit_through bigint,
  manifest_hash text COLLATE "C",
  error text COLLATE "C",
  created_at text COLLATE "C" NOT NULL,
  finished_at text COLLATE "C"
);
CREATE INDEX cloud_analytics_jobs_org ON cloud_analytics_jobs (org_id, created_at);

-- ===== 外部キー（表をすべて作ってから足す） =====
ALTER TABLE ai_usage ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE audit_log ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE billing_invoice_line_works ADD FOREIGN KEY (org_id, invoice_id, sale_id) REFERENCES billing_invoice_lines (org_id, invoice_id, sale_id);
ALTER TABLE billing_invoice_line_works ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE billing_invoice_lines ADD FOREIGN KEY (org_id, invoice_id) REFERENCES billing_invoices (org_id, id);
ALTER TABLE billing_invoice_lines ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE billing_invoice_lines ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE billing_invoice_lines ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE billing_invoice_lines ADD FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id);
ALTER TABLE billing_invoice_lines ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE billing_invoice_sequences ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE billing_invoice_voids ADD FOREIGN KEY (org_id, invoice_id) REFERENCES billing_invoices (org_id, id);
ALTER TABLE billing_invoice_voids ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE billing_invoices ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE billing_invoices ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE billing_receipt_allocations ADD FOREIGN KEY (org_id, receipt_id) REFERENCES billing_receipts (org_id, id);
ALTER TABLE billing_receipt_allocations ADD FOREIGN KEY (org_id, invoice_id) REFERENCES billing_invoices (org_id, id);
ALTER TABLE billing_receipt_reversals ADD FOREIGN KEY (org_id, receipt_id) REFERENCES billing_receipts (org_id, id);
ALTER TABLE billing_receipt_reversals ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE billing_receipts ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE billing_receipts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE billing_sale_claims ADD FOREIGN KEY (org_id, invoice_id, sale_id) REFERENCES billing_invoice_lines (org_id, invoice_id, sale_id);
ALTER TABLE broadcast_airings ADD FOREIGN KEY (org_id, work_id, slot_id) REFERENCES broadcast_slots (org_id, work_id, id);
ALTER TABLE broadcast_airings ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_availability_previews ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_availability_rates ADD FOREIGN KEY (org_id, availability_version_id) REFERENCES sales_availability_versions (org_id, id);
ALTER TABLE broadcast_import_previews ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE broadcast_import_previews ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_sale_links ADD FOREIGN KEY (org_id, work_id, slot_id) REFERENCES broadcast_slots (org_id, work_id, id);
ALTER TABLE broadcast_sale_links ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE broadcast_sale_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_slot_versions ADD FOREIGN KEY (org_id, work_id, slot_id) REFERENCES broadcast_slots (org_id, work_id, id);
ALTER TABLE broadcast_slot_versions ADD FOREIGN KEY (org_id, customer_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE broadcast_slot_versions ADD FOREIGN KEY (org_id, agency_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE broadcast_slot_versions ADD FOREIGN KEY (org_id, agreement_id, work_id) REFERENCES sales_agreements (org_id, id, work_id);
ALTER TABLE broadcast_slot_versions ADD FOREIGN KEY (org_id, changed_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_slots ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE broadcast_slots ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE campaigns ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE catalog_credits ADD FOREIGN KEY (org_id, work_id, revision) REFERENCES catalog_profiles (org_id, work_id, revision);
ALTER TABLE catalog_edition_tags ADD FOREIGN KEY (org_id, work_id, revision, edition_key) REFERENCES catalog_editions (org_id, work_id, revision, edition_key);
ALTER TABLE catalog_editions ADD FOREIGN KEY (org_id, work_id, revision) REFERENCES catalog_profiles (org_id, work_id, revision);
ALTER TABLE catalog_product_editions ADD FOREIGN KEY (org_id, product_id, work_id) REFERENCES product_works (org_id, product_id, work_id);
ALTER TABLE catalog_product_editions ADD FOREIGN KEY (org_id, work_id, revision, edition_key) REFERENCES catalog_editions (org_id, work_id, revision, edition_key);
ALTER TABLE catalog_product_windows ADD FOREIGN KEY (distribution_code) REFERENCES distribution_types (code);
ALTER TABLE catalog_product_windows ADD FOREIGN KEY (org_id, product_id, work_id) REFERENCES product_works (org_id, product_id, work_id);
ALTER TABLE catalog_product_windows ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE catalog_profiles ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE catalog_profiles ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE change_proposals ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE change_proposals ADD FOREIGN KEY (requested_by) REFERENCES users (id);
ALTER TABLE change_proposals ADD FOREIGN KEY (decided_by) REFERENCES users (id);
ALTER TABLE committee_contracts ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE committee_contracts ADD FOREIGN KEY (org_id, intake_case_id, work_id) REFERENCES rights_intake_cases (org_id, id, work_id);
ALTER TABLE committee_contracts ADD FOREIGN KEY (org_id, intake_case_id, document_id) REFERENCES rights_intake_documents (org_id, intake_case_id, id);
ALTER TABLE committee_contracts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_report_previews ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_report_previews ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE committee_report_snapshots ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE committee_report_snapshots ADD FOREIGN KEY (org_id, contract_id, work_id) REFERENCES committee_contracts (org_id, id, work_id);
ALTER TABLE committee_report_snapshots ADD FOREIGN KEY (org_id, contract_id, term_version_id) REFERENCES committee_term_versions (org_id, contract_id, id);
ALTER TABLE committee_report_snapshots ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_schedule_phases ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_snapshot_deductions ADD FOREIGN KEY (org_id, snapshot_id, work_id) REFERENCES committee_report_snapshots (org_id, id, work_id);
ALTER TABLE committee_snapshot_deductions ADD FOREIGN KEY (org_id, snapshot_id, report_id) REFERENCES committee_snapshot_reports (org_id, snapshot_id, report_id);
ALTER TABLE committee_snapshot_deductions ADD FOREIGN KEY (org_id, window_id) REFERENCES committee_term_windows (org_id, id);
ALTER TABLE committee_snapshot_deductions ADD FOREIGN KEY (org_id, recipient_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE committee_snapshot_expenses ADD FOREIGN KEY (org_id, snapshot_id, work_id) REFERENCES committee_report_snapshots (org_id, id, work_id);
ALTER TABLE committee_snapshot_expenses ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE committee_snapshot_expenses ADD FOREIGN KEY (org_id, window_id) REFERENCES committee_term_windows (org_id, id);
ALTER TABLE committee_snapshot_lines ADD FOREIGN KEY (org_id, snapshot_id, work_id) REFERENCES committee_report_snapshots (org_id, id, work_id);
ALTER TABLE committee_snapshot_lines ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE committee_snapshot_lines ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE committee_snapshot_lines ADD FOREIGN KEY (org_id, window_id) REFERENCES committee_term_windows (org_id, id);
ALTER TABLE committee_snapshot_member_amounts ADD FOREIGN KEY (org_id, snapshot_id) REFERENCES committee_report_snapshots (org_id, id);
ALTER TABLE committee_snapshot_member_amounts ADD FOREIGN KEY (org_id, window_id) REFERENCES committee_term_windows (org_id, id);
ALTER TABLE committee_snapshot_member_amounts ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE committee_snapshot_reports ADD FOREIGN KEY (org_id, snapshot_id, work_id) REFERENCES committee_report_snapshots (org_id, id, work_id);
ALTER TABLE committee_snapshot_reports ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE committee_snapshot_reports ADD FOREIGN KEY (org_id, window_id) REFERENCES committee_term_windows (org_id, id);
ALTER TABLE committee_term_funding ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_term_investments ADD FOREIGN KEY (org_id, term_version_id, partner_id) REFERENCES committee_term_members (org_id, term_version_id, partner_id);
ALTER TABLE committee_term_members ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_term_members ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE committee_term_versions ADD FOREIGN KEY (org_id, contract_id) REFERENCES committee_contracts (org_id, id);
ALTER TABLE committee_term_versions ADD FOREIGN KEY (org_id, contract_id, source_version_id) REFERENCES committee_term_versions (org_id, contract_id, id);
ALTER TABLE committee_term_versions ADD FOREIGN KEY (org_id, manager_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE committee_term_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_windows ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_term_windows ADD FOREIGN KEY (org_id, window_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE day_scene_assignments ADD FOREIGN KEY (org_id, work_id, shooting_day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE day_scene_assignments ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE digital_sale_details ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE distribution_master ADD FOREIGN KEY (code) REFERENCES distribution_types (code);
ALTER TABLE expenses ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE expenses ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE expenses ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE exposures ADD FOREIGN KEY (org_id, campaign_id) REFERENCES campaigns (org_id, id);
ALTER TABLE import_previews ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE import_previews ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE intake_settlement_links ADD FOREIGN KEY (org_id, intake_case_id, work_id) REFERENCES rights_intake_cases (org_id, id, work_id);
ALTER TABLE intake_settlement_links ADD FOREIGN KEY (org_id, settlement_contract_id, work_id) REFERENCES settlement_contracts (org_id, id, work_id);
ALTER TABLE intake_settlement_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE invitations ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE invitations ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE invitations ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE joint_business_holidays ADD FOREIGN KEY (org_id, contract_id) REFERENCES joint_committee_contracts (org_id, id);
ALTER TABLE joint_committee_contracts ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE joint_committee_contracts ADD FOREIGN KEY (org_id, manager_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE joint_committee_contracts ADD FOREIGN KEY (org_id, producer_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE joint_committee_costs ADD FOREIGN KEY (org_id, contract_id, period_sequence) REFERENCES joint_committee_periods (org_id, contract_id, sequence);
ALTER TABLE joint_committee_costs ADD FOREIGN KEY (org_id, contract_id, window_id) REFERENCES joint_committee_windows (org_id, contract_id, id);
ALTER TABLE joint_committee_members ADD FOREIGN KEY (org_id, contract_id) REFERENCES joint_committee_contracts (org_id, id);
ALTER TABLE joint_committee_members ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE joint_committee_periods ADD FOREIGN KEY (org_id, contract_id) REFERENCES joint_committee_contracts (org_id, id);
ALTER TABLE joint_committee_sales ADD FOREIGN KEY (org_id, contract_id, period_sequence) REFERENCES joint_committee_periods (org_id, contract_id, sequence);
ALTER TABLE joint_committee_sales ADD FOREIGN KEY (org_id, contract_id, window_id) REFERENCES joint_committee_windows (org_id, contract_id, id);
ALTER TABLE joint_committee_snapshots ADD FOREIGN KEY (org_id, contract_id) REFERENCES joint_committee_contracts (org_id, id);
ALTER TABLE joint_committee_windows ADD FOREIGN KEY (org_id, contract_id) REFERENCES joint_committee_contracts (org_id, id);
ALTER TABLE joint_committee_windows ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE joint_funding_events ADD FOREIGN KEY (org_id, contract_id, partner_id) REFERENCES joint_committee_members (org_id, contract_id, partner_id);
ALTER TABLE joint_funding_events ADD FOREIGN KEY (milestone_id) REFERENCES joint_production_milestones (id);
ALTER TABLE joint_production_milestones ADD FOREIGN KEY (org_id, contract_id) REFERENCES joint_committee_contracts (org_id, id);
ALTER TABLE joint_production_milestones ADD FOREIGN KEY (org_id, producer_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE mapping_import_provenance ADD FOREIGN KEY (org_id, work_id, report_id) REFERENCES report_imports (org_id, work_id, id);
ALTER TABLE mapping_import_provenance ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE mapping_import_provenance ADD FOREIGN KEY (org_id, mapping_version_id) REFERENCES report_mapping_versions (org_id, id);
ALTER TABLE memberships ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE memberships ADD FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE metric_definitions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE mg_contract_links ADD FOREIGN KEY (org_id, incoming_contract_id) REFERENCES mg_incoming_contracts (org_id, id);
ALTER TABLE mg_contract_links ADD FOREIGN KEY (org_id, outgoing_contract_id) REFERENCES mg_outgoing_contracts (org_id, id);
ALTER TABLE mg_contract_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mg_incoming_contracts ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE mg_incoming_contracts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mg_ledger_entries ADD FOREIGN KEY (org_id, term_version_id, product_id) REFERENCES mg_version_products (org_id, term_version_id, product_id);
ALTER TABLE mg_ledger_entries ADD FOREIGN KEY (org_id, reverses_entry_id) REFERENCES mg_ledger_entries (org_id, id);
ALTER TABLE mg_ledger_entries ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mg_outgoing_contracts ADD FOREIGN KEY (org_id, supplier_id) REFERENCES mg_suppliers (org_id, id);
ALTER TABLE mg_outgoing_contracts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mg_suppliers ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE mg_suppliers ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mg_term_versions ADD FOREIGN KEY (org_id, incoming_contract_id) REFERENCES mg_incoming_contracts (org_id, id);
ALTER TABLE mg_term_versions ADD FOREIGN KEY (org_id, outgoing_contract_id) REFERENCES mg_outgoing_contracts (org_id, id);
ALTER TABLE mg_term_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE mg_version_phases ADD FOREIGN KEY (org_id, term_version_id) REFERENCES mg_term_versions (org_id, id);
ALTER TABLE mg_version_products ADD FOREIGN KEY (org_id, term_version_id) REFERENCES mg_term_versions (org_id, id);
ALTER TABLE mg_version_products ADD FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id);
ALTER TABLE observations ADD FOREIGN KEY (org_id, exposure_id) REFERENCES exposures (org_id, id);
ALTER TABLE observations ADD FOREIGN KEY (org_id, metric_definition_id) REFERENCES metric_definitions (org_id, id);
ALTER TABLE observations ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE package_observation_products ADD FOREIGN KEY (org_id, report_id, source_row, metric) REFERENCES package_report_observations (org_id, report_id, source_row, metric);
ALTER TABLE package_observation_products ADD FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id);
ALTER TABLE package_report_observations ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE package_sale_details ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE partners ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE prep_tasks ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE prep_tasks ADD FOREIGN KEY (org_id, work_id, shooting_day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE prep_tasks ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE prep_tasks ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE product_works ADD FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id);
ALTER TABLE product_works ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE production_appearances ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE production_appearances ADD FOREIGN KEY (org_id, work_id, character_key) REFERENCES production_characters (org_id, work_id, key);
ALTER TABLE production_calls ADD FOREIGN KEY (org_id, work_id, day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE production_calls ADD FOREIGN KEY (org_id, work_id, character_key) REFERENCES production_characters (org_id, work_id, key);
ALTER TABLE production_characters ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE production_day_slots ADD FOREIGN KEY (org_id, work_id, day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE production_location_plans ADD FOREIGN KEY (org_id, work_id, location_key) REFERENCES production_locations (org_id, work_id, key) ON DELETE CASCADE;
ALTER TABLE production_locations ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE production_looks ADD FOREIGN KEY (org_id, work_id, character_key) REFERENCES production_characters (org_id, work_id, key);
ALTER TABLE production_revisions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE production_scene_details ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE production_scene_details ADD FOREIGN KEY (org_id, work_id, location_key) REFERENCES production_locations (org_id, work_id, key);
ALTER TABLE production_scene_looks ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE production_scene_looks ADD FOREIGN KEY (org_id, work_id, look_key) REFERENCES production_looks (org_id, work_id, key);
ALTER TABLE products ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE project_memberships ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE project_memberships ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE projects ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE receipt_plan_decisions ADD FOREIGN KEY (org_id, invoice_id, request_id) REFERENCES receipt_plan_requests (org_id, invoice_id, id);
ALTER TABLE receipt_plan_decisions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE receipt_plan_requests ADD FOREIGN KEY (org_id, invoice_id) REFERENCES billing_invoices (org_id, id);
ALTER TABLE receipt_plan_requests ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE report_channel_fact_seals ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE report_imports ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE report_imports ADD FOREIGN KEY (supersedes_id) REFERENCES report_imports (id);
ALTER TABLE report_imports ADD FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE report_imports ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE report_imports ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE report_imports ADD FOREIGN KEY (org_id, supersedes_id) REFERENCES report_imports (org_id, id);
ALTER TABLE report_mapping_profiles ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE report_mapping_profiles ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE report_mapping_versions ADD FOREIGN KEY (org_id, profile_id) REFERENCES report_mapping_profiles (org_id, id);
ALTER TABLE report_mapping_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE report_recognition ADD FOREIGN KEY (recognition_basis_id) REFERENCES recognition_bases (id);
ALTER TABLE report_recognition ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE report_sale_dimensions_versions ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE report_sale_dimensions_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE report_source_controls ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE rights_intake_cases ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE rights_intake_cases ADD FOREIGN KEY (org_id, source_case_id, work_id) REFERENCES rights_intake_cases (org_id, id, work_id);
ALTER TABLE rights_intake_cases ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE rights_intake_documents ADD FOREIGN KEY (org_id, intake_case_id) REFERENCES rights_intake_cases (org_id, id);
ALTER TABLE rights_intake_participants ADD FOREIGN KEY (org_id, intake_case_id) REFERENCES rights_intake_cases (org_id, id);
ALTER TABLE rights_intake_participants ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE rights_intake_scopes ADD FOREIGN KEY (org_id, intake_case_id) REFERENCES rights_intake_cases (org_id, id);
ALTER TABLE rights_payment_events ADD FOREIGN KEY (org_id, settlement_contract_id) REFERENCES settlement_contracts (org_id, id);
ALTER TABLE rights_payment_events ADD FOREIGN KEY (org_id, committee_snapshot_id) REFERENCES committee_report_snapshots (org_id, id);
ALTER TABLE rights_payment_events ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE rights_payment_events ADD FOREIGN KEY (org_id, reverses_event_id) REFERENCES rights_payment_events (org_id, id);
ALTER TABLE rights_payment_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sale_distribution_versions ADD FOREIGN KEY (distribution_code) REFERENCES distribution_types (code);
ALTER TABLE sale_distribution_versions ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE sale_distribution_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sale_lines ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE sale_lines ADD FOREIGN KEY (org_id, work_id, report_id) REFERENCES report_imports (org_id, work_id, id);
ALTER TABLE sale_lines ADD FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id);
ALTER TABLE sale_lines ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE sales_activities ADD FOREIGN KEY (org_id, project_id, work_id, partner_id, opportunity_id) REFERENCES sales_opportunities (org_id, project_id, work_id, partner_id, id);
ALTER TABLE sales_activities ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_agreement_term_versions ADD FOREIGN KEY (org_id, agreement_id) REFERENCES sales_agreements (org_id, id);
ALTER TABLE sales_agreement_term_versions ADD FOREIGN KEY (org_id, agreement_id, source_version_id) REFERENCES sales_agreement_term_versions (org_id, agreement_id, id);
ALTER TABLE sales_agreement_term_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_agreements ADD FOREIGN KEY (org_id, project_id, work_id, partner_id, opportunity_id) REFERENCES sales_opportunities (org_id, project_id, work_id, partner_id, id);
ALTER TABLE sales_agreements ADD FOREIGN KEY (org_id, product_id, work_id) REFERENCES product_works (org_id, product_id, work_id);
ALTER TABLE sales_agreements ADD FOREIGN KEY (org_id, intake_case_id, work_id) REFERENCES rights_intake_cases (org_id, id, work_id);
ALTER TABLE sales_agreements ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_availability_versions ADD FOREIGN KEY (distribution_code) REFERENCES distribution_types (code);
ALTER TABLE sales_availability_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE sales_availability_versions ADD FOREIGN KEY (org_id, intake_case_id, work_id) REFERENCES rights_intake_cases (org_id, id, work_id);
ALTER TABLE sales_availability_versions ADD FOREIGN KEY (org_id, document_id) REFERENCES rights_intake_documents (org_id, id);
ALTER TABLE sales_availability_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_deliverables ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE sales_deliverables ADD FOREIGN KEY (org_id, agreement_id, work_id) REFERENCES sales_agreements (org_id, id, work_id);
ALTER TABLE sales_deliverables ADD FOREIGN KEY (org_id, agreement_id, term_version_id) REFERENCES sales_agreement_term_versions (org_id, agreement_id, id);
ALTER TABLE sales_deliverables ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_material_snapshots ADD FOREIGN KEY (org_id, project_id, work_id, partner_id, opportunity_id) REFERENCES sales_opportunities (org_id, project_id, work_id, partner_id, id);
ALTER TABLE sales_material_snapshots ADD FOREIGN KEY (org_id, product_id, work_id) REFERENCES product_works (org_id, product_id, work_id);
ALTER TABLE sales_material_snapshots ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_opportunities ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE sales_opportunities ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE sales_report_links ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE sales_report_links ADD FOREIGN KEY (org_id, agreement_id, work_id) REFERENCES sales_agreements (org_id, id, work_id);
ALTER TABLE sales_report_links ADD FOREIGN KEY (org_id, agreement_id, term_version_id) REFERENCES sales_agreement_term_versions (org_id, agreement_id, id);
ALTER TABLE sales_report_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE scenes ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE scenes ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE sessions ADD FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE sessions ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE settlement_contracts ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE settlement_contracts ADD FOREIGN KEY (org_id, holder_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE settlement_contracts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE settlement_report_links ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE settlement_report_links ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE settlement_report_links ADD FOREIGN KEY (org_id, contract_id, work_id) REFERENCES settlement_contracts (org_id, id, work_id);
ALTER TABLE settlement_report_links ADD FOREIGN KEY (org_id, contract_id, term_version_id) REFERENCES settlement_term_versions (org_id, contract_id, id);
ALTER TABLE settlement_report_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE settlement_term_versions ADD FOREIGN KEY (org_id, contract_id) REFERENCES settlement_contracts (org_id, id);
ALTER TABLE settlement_term_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE shooting_days ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE shooting_days ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE tax_calculation_lines ADD FOREIGN KEY (org_id, snapshot_id) REFERENCES tax_calculation_snapshots (org_id, id);
ALTER TABLE tax_calculation_lines ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE tax_calculation_lines ADD FOREIGN KEY (org_id, report_id) REFERENCES report_imports (org_id, id);
ALTER TABLE tax_calculation_snapshots ADD FOREIGN KEY (org_id, invoice_id) REFERENCES billing_invoices (org_id, id);
ALTER TABLE tax_calculation_snapshots ADD FOREIGN KEY (org_id, rule_version_id) REFERENCES tax_rule_versions (org_id, id);
ALTER TABLE tax_calculation_snapshots ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE tax_invoice_links ADD FOREIGN KEY (org_id, invoice_id) REFERENCES billing_invoices (org_id, id);
ALTER TABLE tax_invoice_links ADD FOREIGN KEY (org_id, prior_invoice_id) REFERENCES billing_invoices (org_id, id);
ALTER TABLE tax_invoice_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE tax_invoice_rate_totals ADD FOREIGN KEY (org_id, snapshot_id) REFERENCES tax_calculation_snapshots (org_id, id);
ALTER TABLE tax_rule_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE tax_rule_versions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE tax_rule_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE theatrical_sale_details ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE workbench_applications ADD FOREIGN KEY (change_set_id) REFERENCES workbench_change_sets (id);
ALTER TABLE workbench_change_sets ADD FOREIGN KEY (draft_id) REFERENCES workbench_drafts (id);
ALTER TABLE workbench_change_sets ADD FOREIGN KEY (validation_id) REFERENCES workbench_validations (id);
ALTER TABLE workbench_drafts ADD FOREIGN KEY (source_snapshot_id) REFERENCES workbench_snapshots (id);
ALTER TABLE workbench_drafts ADD FOREIGN KEY (source_artifact_id) REFERENCES workbench_source_artifacts (id);
ALTER TABLE workbench_recipe_versions ADD FOREIGN KEY (recipe_id) REFERENCES workbench_recipes (id);
ALTER TABLE workbench_validations ADD FOREIGN KEY (draft_id) REFERENCES workbench_drafts (id);
ALTER TABLE workflow_raw_artifacts ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE workflow_raw_artifacts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE workflow_report_commits ADD FOREIGN KEY (org_id, work_id, artifact_id) REFERENCES workflow_raw_artifacts (org_id, work_id, id);
ALTER TABLE workflow_report_commits ADD FOREIGN KEY (org_id, work_id, selection_id) REFERENCES workflow_report_selections (org_id, work_id, id);
ALTER TABLE workflow_report_commits ADD FOREIGN KEY (org_id, mapping_version_id) REFERENCES report_mapping_versions (org_id, id);
ALTER TABLE workflow_report_commits ADD FOREIGN KEY (org_id, work_id, report_id) REFERENCES report_imports (org_id, work_id, id);
ALTER TABLE workflow_report_selections ADD FOREIGN KEY (org_id, artifact_id) REFERENCES workflow_raw_artifacts (org_id, id);
ALTER TABLE workflow_schedule_previews ADD FOREIGN KEY (org_id, artifact_id) REFERENCES workflow_raw_artifacts (org_id, id);
ALTER TABLE workflow_schedule_previews ADD FOREIGN KEY (org_id, review_id) REFERENCES workflow_script_reviews (org_id, id);
ALTER TABLE workflow_script_commit_days ADD FOREIGN KEY (org_id, commit_id) REFERENCES workflow_script_commits (org_id, id);
ALTER TABLE workflow_script_commit_days ADD FOREIGN KEY (org_id, work_id, shooting_day_id) REFERENCES shooting_days (org_id, work_id, id);
ALTER TABLE workflow_script_commit_scenes ADD FOREIGN KEY (org_id, commit_id) REFERENCES workflow_script_commits (org_id, id);
ALTER TABLE workflow_script_commit_scenes ADD FOREIGN KEY (org_id, work_id, scene_id) REFERENCES scenes (org_id, work_id, id);
ALTER TABLE workflow_script_commits ADD FOREIGN KEY (org_id, artifact_id) REFERENCES workflow_raw_artifacts (org_id, id);
ALTER TABLE workflow_script_commits ADD FOREIGN KEY (org_id, review_id) REFERENCES workflow_script_reviews (org_id, id);
ALTER TABLE workflow_script_reviews ADD FOREIGN KEY (org_id, work_id, artifact_id) REFERENCES workflow_raw_artifacts (org_id, work_id, id);
ALTER TABLE workflow_script_reviews ADD FOREIGN KEY (org_id, reviewed_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE works ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE fiscal_settings ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE fiscal_settings ADD FOREIGN KEY (updated_by) REFERENCES users (id);
ALTER TABLE bulk_import_previews ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE bulk_import_previews ADD FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE bulk_import_batches ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE bulk_import_batches ADD FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE partner_profile_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE partner_profile_versions ADD FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE partner_profile_versions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE report_issuances ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE report_issuances ADD FOREIGN KEY (org_id, previous_issuance_id) REFERENCES report_issuances (org_id, id);
ALTER TABLE report_issuances ADD FOREIGN KEY (org_id, issued_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE report_issuance_voids ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE report_issuance_voids ADD FOREIGN KEY (org_id, issuance_id) REFERENCES report_issuances (org_id, id);
ALTER TABLE report_issuance_voids ADD FOREIGN KEY (org_id, voided_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expected_reports ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expected_reports ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE expected_reports ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE expected_reports ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expected_report_closures ADD FOREIGN KEY (org_id, expected_report_id) REFERENCES expected_reports (org_id, id);
ALTER TABLE expected_report_closures ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_agreements ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_agreements ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE royalty_agreements ADD FOREIGN KEY (org_id, holder_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE royalty_agreements ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_term_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_term_versions ADD FOREIGN KEY (org_id, agreement_id) REFERENCES royalty_agreements (org_id, id);
ALTER TABLE royalty_term_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_term_channels ADD FOREIGN KEY (org_id, term_version_id) REFERENCES royalty_term_versions (org_id, id);
ALTER TABLE royalty_term_channels ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_term_expense_categories ADD FOREIGN KEY (org_id, term_version_id) REFERENCES royalty_term_versions (org_id, id);
ALTER TABLE royalty_term_expense_categories ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_schedule_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_schedule_versions ADD FOREIGN KEY (org_id, agreement_id) REFERENCES royalty_agreements (org_id, id);
ALTER TABLE royalty_schedule_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_schedule_phases ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_schedule_phases ADD FOREIGN KEY (org_id, schedule_version_id) REFERENCES royalty_schedule_versions (org_id, id);
ALTER TABLE royalty_schedule_phases ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_manual_accruals ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_manual_accruals ADD FOREIGN KEY (org_id, agreement_id) REFERENCES royalty_agreements (org_id, id);
ALTER TABLE royalty_manual_accruals ADD FOREIGN KEY (org_id, reverses_entry_id) REFERENCES royalty_manual_accruals (org_id, id);
ALTER TABLE royalty_manual_accruals ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_irregular_entries ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_irregular_entries ADD FOREIGN KEY (org_id, holder_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE royalty_irregular_entries ADD FOREIGN KEY (org_id, agreement_id) REFERENCES royalty_agreements (org_id, id);
ALTER TABLE royalty_irregular_entries ADD FOREIGN KEY (org_id, reverses_entry_id) REFERENCES royalty_irregular_entries (org_id, id);
ALTER TABLE royalty_irregular_entries ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_statements ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_statements ADD FOREIGN KEY (org_id, holder_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE royalty_statements ADD FOREIGN KEY (org_id, previous_statement_id) REFERENCES royalty_statements (org_id, id);
ALTER TABLE royalty_statements ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_statement_voids ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_statement_voids ADD FOREIGN KEY (org_id, statement_id) REFERENCES royalty_statements (org_id, id);
ALTER TABLE royalty_statement_voids ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_statement_lines ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_statement_lines ADD FOREIGN KEY (org_id, statement_id) REFERENCES royalty_statements (org_id, id);
ALTER TABLE royalty_statement_lines ADD FOREIGN KEY (org_id, agreement_id) REFERENCES royalty_agreements (org_id, id);
ALTER TABLE royalty_statement_lines ADD FOREIGN KEY (org_id, term_version_id) REFERENCES royalty_term_versions (org_id, id);
ALTER TABLE royalty_statement_lines ADD FOREIGN KEY (org_id, irregular_entry_id) REFERENCES royalty_irregular_entries (org_id, id);
ALTER TABLE royalty_statement_lines ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_statement_events ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_statement_events ADD FOREIGN KEY (org_id, statement_id) REFERENCES royalty_statements (org_id, id);
ALTER TABLE royalty_statement_events ADD FOREIGN KEY (org_id, reverses_event_id) REFERENCES royalty_statement_events (org_id, id);
ALTER TABLE royalty_statement_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE royalty_statement_calculation_parts ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE royalty_statement_calculation_parts ADD FOREIGN KEY (org_id, statement_id) REFERENCES royalty_statements (org_id, id);
ALTER TABLE royalty_statement_calculation_parts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_window_fee_shares ADD FOREIGN KEY (org_id, window_id) REFERENCES committee_term_windows (org_id, id);
ALTER TABLE committee_term_window_fee_shares ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE committee_term_window_fee_shares ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_term_version_effective ADD FOREIGN KEY (org_id, term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE committee_term_version_effective ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_source_files ADD FOREIGN KEY (org_id, legacy_artifact_id) REFERENCES workflow_raw_artifacts (org_id, id);
ALTER TABLE sales_source_files ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_source_selections ADD FOREIGN KEY (org_id, file_id) REFERENCES sales_source_files (org_id, id);
ALTER TABLE sales_source_selections ADD FOREIGN KEY (org_id, legacy_selection_id) REFERENCES workflow_report_selections (org_id, id);
ALTER TABLE sales_source_selections ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_source_bindings ADD FOREIGN KEY (org_id, file_id) REFERENCES sales_source_files (org_id, id);
ALTER TABLE sales_source_bindings ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE sales_source_bindings ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_source_partitions ADD FOREIGN KEY (org_id, file_id, selection_id) REFERENCES sales_source_selections (org_id, file_id, id);
ALTER TABLE sales_source_partitions ADD FOREIGN KEY (org_id, file_id, binding_id) REFERENCES sales_source_bindings (org_id, file_id, id);
ALTER TABLE sales_source_partitions ADD FOREIGN KEY (org_id, project_id, work_id) REFERENCES works (org_id, project_id, id);
ALTER TABLE sales_source_partitions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_source_commits ADD FOREIGN KEY (org_id, file_id) REFERENCES sales_source_files (org_id, id);
ALTER TABLE sales_source_commits ADD FOREIGN KEY (org_id, work_id, partition_id) REFERENCES sales_source_partitions (org_id, work_id, id);
ALTER TABLE sales_source_commits ADD FOREIGN KEY (org_id, work_id, report_id) REFERENCES report_imports (org_id, work_id, id);
ALTER TABLE sales_source_commits ADD FOREIGN KEY (org_id, mapping_version_id) REFERENCES report_mapping_versions (org_id, id);
ALTER TABLE sales_source_commits ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE org_switch_events ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE org_switch_events ADD FOREIGN KEY (from_org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE release_window_types ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE release_window_types ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE release_window_type_versions ADD FOREIGN KEY (org_id, type_id) REFERENCES release_window_types (org_id, id);
ALTER TABLE release_window_type_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE release_window_type_fields ADD FOREIGN KEY (org_id, type_id, version_no) REFERENCES release_window_type_versions (org_id, type_id, version_no);
ALTER TABLE release_window_type_distributions ADD FOREIGN KEY (distribution_code) REFERENCES distribution_types (code);
ALTER TABLE release_window_type_distributions ADD FOREIGN KEY (org_id, type_id, version_no) REFERENCES release_window_type_versions (org_id, type_id, version_no);
ALTER TABLE work_release_windows ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE work_release_windows ADD FOREIGN KEY (org_id, type_id) REFERENCES release_window_types (org_id, id);
ALTER TABLE work_release_windows ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE work_release_window_versions ADD FOREIGN KEY (org_id, window_id) REFERENCES work_release_windows (org_id, id);
ALTER TABLE work_release_window_versions ADD FOREIGN KEY (org_id, availability_version_id) REFERENCES sales_availability_versions (org_id, id);
ALTER TABLE work_release_window_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE work_release_window_field_values ADD FOREIGN KEY (org_id, window_id, version_no) REFERENCES work_release_window_versions (org_id, window_id, version_no);
ALTER TABLE release_window_import_previews ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_lists ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE partner_lists ADD FOREIGN KEY (list_kind) REFERENCES partner_list_kinds (code);
ALTER TABLE partner_lists ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE partner_lists ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_list_import_batches ADD FOREIGN KEY (org_id, list_id) REFERENCES partner_lists (org_id, id);
ALTER TABLE partner_list_import_batches ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_list_entries ADD FOREIGN KEY (org_id, list_id) REFERENCES partner_lists (org_id, id);
ALTER TABLE partner_list_entries ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE partner_list_entries ADD FOREIGN KEY (org_id, renews_entry_id) REFERENCES partner_list_entries (org_id, id);
ALTER TABLE partner_list_entries ADD FOREIGN KEY (org_id, created_batch_id) REFERENCES partner_list_import_batches (org_id, id);
ALTER TABLE partner_list_entries ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_list_entry_versions ADD FOREIGN KEY (distribution_code) REFERENCES distribution_types (code);
ALTER TABLE partner_list_entry_versions ADD FOREIGN KEY (org_id, list_id, entry_id) REFERENCES partner_list_entries (org_id, list_id, id);
ALTER TABLE partner_list_entry_versions ADD FOREIGN KEY (org_id, work_id, entry_id) REFERENCES partner_list_entries (org_id, work_id, id);
ALTER TABLE partner_list_entry_versions ADD FOREIGN KEY (org_id, product_id, work_id) REFERENCES product_works (org_id, product_id, work_id);
ALTER TABLE partner_list_entry_versions ADD FOREIGN KEY (org_id, billing_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE partner_list_entry_versions ADD FOREIGN KEY (org_id, agreement_id, work_id) REFERENCES sales_agreements (org_id, id, work_id);
ALTER TABLE partner_list_entry_versions ADD FOREIGN KEY (org_id, import_batch_id) REFERENCES partner_list_import_batches (org_id, id);
ALTER TABLE partner_list_entry_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_list_field_definitions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE partner_list_field_definitions ADD FOREIGN KEY (list_kind) REFERENCES partner_list_kinds (code);
ALTER TABLE partner_list_field_definitions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE partner_list_field_definitions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_list_field_states ADD FOREIGN KEY (org_id, definition_id) REFERENCES partner_list_field_definitions (org_id, id);
ALTER TABLE partner_list_field_states ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_list_field_values ADD FOREIGN KEY (org_id, entry_version_id) REFERENCES partner_list_entry_versions (org_id, id);
ALTER TABLE partner_list_field_values ADD FOREIGN KEY (org_id, definition_id) REFERENCES partner_list_field_definitions (org_id, id);
ALTER TABLE partner_list_import_previews ADD FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_list_import_previews ADD FOREIGN KEY (org_id, list_id) REFERENCES partner_lists (org_id, id);
ALTER TABLE sales_sheet_column_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE sales_sheet_column_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sale_attribute_values ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE sale_attribute_values ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sale_currency_versions ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE sale_currency_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sale_royalty_basis_versions ADD FOREIGN KEY (org_id, sale_id) REFERENCES sale_lines (org_id, id);
ALTER TABLE sale_royalty_basis_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_sheet_views ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE sales_sheet_views ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE sales_sheet_view_versions ADD FOREIGN KEY (org_id, view_id) REFERENCES sales_sheet_views (org_id, id);
ALTER TABLE sales_sheet_view_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE work_proposal_profiles ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE work_proposal_profiles ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_station_type_versions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE broadcast_station_type_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_entry_term_versions ADD FOREIGN KEY (org_id, entry_id) REFERENCES partner_list_entries (org_id, id);
ALTER TABLE broadcast_entry_term_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE org_profile_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE org_profile_versions ADD FOREIGN KEY (org_id, self_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE org_profile_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE gl_accounts ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE gl_accounts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE gl_manual_amounts ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE gl_manual_amounts ADD FOREIGN KEY (org_id, account_id) REFERENCES gl_accounts (org_id, id);
ALTER TABLE gl_manual_amounts ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE gl_manual_amounts ADD FOREIGN KEY (org_id, reverses_id) REFERENCES gl_manual_amounts (org_id, id);
ALTER TABLE gl_manual_amounts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_payments ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_payments ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_payments ADD FOREIGN KEY (org_id, reverses_id) REFERENCES expense_payments (org_id, id);
ALTER TABLE expense_payments ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE committee_investment_payments ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE committee_investment_payments ADD FOREIGN KEY (org_id, term_version_id, partner_id) REFERENCES committee_term_investments (org_id, term_version_id, partner_id);
ALTER TABLE committee_investment_payments ADD FOREIGN KEY (org_id, reverses_id) REFERENCES committee_investment_payments (org_id, id);
ALTER TABLE committee_investment_payments ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_proposal_drafts ADD FOREIGN KEY (org_id, work_id, slot_id) REFERENCES broadcast_slots (org_id, work_id, id);
ALTER TABLE broadcast_proposal_drafts ADD FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id);
ALTER TABLE broadcast_proposal_drafts ADD FOREIGN KEY (org_id, station_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE broadcast_proposal_drafts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE broadcast_proposal_draft_deletions ADD FOREIGN KEY (org_id, slot_id) REFERENCES broadcast_proposal_drafts (org_id, slot_id);
ALTER TABLE broadcast_proposal_draft_deletions ADD FOREIGN KEY (org_id, slot_id, revision) REFERENCES broadcast_slot_versions (org_id, slot_id, revision);
ALTER TABLE broadcast_proposal_draft_deletions ADD FOREIGN KEY (org_id, deleted_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE work_master_profile_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE work_master_profile_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE work_finance_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE work_finance_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE work_finance_versions ADD FOREIGN KEY (org_id, committee_term_version_id) REFERENCES committee_term_versions (org_id, id);
ALTER TABLE work_finance_versions ADD FOREIGN KEY (org_id, self_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE work_contract_set_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE work_contract_set_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE work_contracts ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE work_contract_versions ADD FOREIGN KEY (org_id, work_id, revision) REFERENCES work_contract_set_versions (org_id, work_id, revision);
ALTER TABLE work_contract_versions ADD FOREIGN KEY (org_id, work_id, contract_key) REFERENCES work_contracts (org_id, work_id, contract_key);
ALTER TABLE work_contract_versions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE work_rights_versions ADD FOREIGN KEY (org_id, work_id) REFERENCES works (org_id, id);
ALTER TABLE work_rights_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE work_rights_party_versions ADD FOREIGN KEY (org_id, work_id, revision) REFERENCES work_rights_versions (org_id, work_id, revision);
ALTER TABLE work_rights_party_versions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE product_master_profile_versions ADD FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id);
ALTER TABLE product_master_profile_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE product_master_profile_versions ADD FOREIGN KEY (org_id, publisher_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE product_master_profile_versions ADD FOREIGN KEY (org_id, distributor_partner_id) REFERENCES partners (org_id, id);
ALTER TABLE gl_account_class_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE gl_account_class_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE gl_account_class_versions ADD FOREIGN KEY (org_id, account_id) REFERENCES gl_accounts (org_id, id);
ALTER TABLE expense_categories ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_categories ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_tax_categories ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_tax_categories ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_withholding_categories ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_withholding_categories ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_category_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_category_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_category_versions ADD FOREIGN KEY (org_id, category_id) REFERENCES expense_categories (org_id, id);
ALTER TABLE expense_category_versions ADD FOREIGN KEY (org_id, account_class_version_id) REFERENCES gl_account_class_versions (org_id, id);
ALTER TABLE expense_category_alias_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_category_alias_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_category_alias_versions ADD FOREIGN KEY (org_id, category_version_id) REFERENCES expense_category_versions (org_id, id);
ALTER TABLE expense_tax_category_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_tax_category_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_tax_category_versions ADD FOREIGN KEY (org_id, tax_category_id) REFERENCES expense_tax_categories (org_id, id);
ALTER TABLE expense_withholding_category_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_withholding_category_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_withholding_category_versions ADD FOREIGN KEY (org_id, withholding_category_id) REFERENCES expense_withholding_categories (org_id, id);
ALTER TABLE partner_payment_term_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE partner_payment_term_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE partner_payment_term_versions ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE expense_accounting_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_accounting_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_accounting_versions ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_accounting_versions ADD FOREIGN KEY (org_id, category_version_id) REFERENCES expense_category_versions (org_id, id);
ALTER TABLE expense_accounting_versions ADD FOREIGN KEY (org_id, tax_category_version_id) REFERENCES expense_tax_category_versions (org_id, id);
ALTER TABLE expense_accounting_versions ADD FOREIGN KEY (org_id, withholding_category_version_id) REFERENCES expense_withholding_category_versions (org_id, id);
ALTER TABLE expense_payment_accounting ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_payment_accounting ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_payment_accounting ADD FOREIGN KEY (org_id, payment_id) REFERENCES expense_payments (org_id, id);
ALTER TABLE expense_payment_accounting ADD FOREIGN KEY (org_id, accounting_version_id) REFERENCES expense_accounting_versions (org_id, id);
ALTER TABLE expense_payment_accounting ADD FOREIGN KEY (org_id, cash_account_class_version_id) REFERENCES gl_account_class_versions (org_id, id);
ALTER TABLE expense_cards ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_cards ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_card_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_card_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_card_versions ADD FOREIGN KEY (org_id, card_id) REFERENCES expense_cards (org_id, id);
ALTER TABLE expense_card_versions ADD FOREIGN KEY (org_id, cash_account_class_version_id) REFERENCES gl_account_class_versions (org_id, id);
ALTER TABLE expense_credit_links ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_credit_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_credit_links ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_credit_links ADD FOREIGN KEY (org_id, original_expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_credit_links ADD FOREIGN KEY (org_id, original_invoice_id) REFERENCES expense_invoices (org_id, id);
ALTER TABLE expense_payment_settlements ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_payment_settlements ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_payment_settlements ADD FOREIGN KEY (org_id, payment_id) REFERENCES expense_payments (org_id, id);
ALTER TABLE expense_payment_settlements ADD FOREIGN KEY (org_id, card_version_id) REFERENCES expense_card_versions (org_id, id);
ALTER TABLE expense_payment_settlements ADD FOREIGN KEY (org_id, counter_account_class_version_id) REFERENCES gl_account_class_versions (org_id, id);
ALTER TABLE expense_payment_settlements ADD FOREIGN KEY (org_id, billing_invoice_id) REFERENCES billing_invoices (org_id, id);
ALTER TABLE expense_payment_settlements ADD FOREIGN KEY (org_id, billing_receipt_id) REFERENCES billing_receipts (org_id, id);
ALTER TABLE expense_withholding_remittances ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_withholding_remittances ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_withholding_remittances ADD FOREIGN KEY (org_id, cash_account_class_version_id) REFERENCES gl_account_class_versions (org_id, id);
ALTER TABLE expense_withholding_allocations ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_withholding_allocations ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_withholding_allocations ADD FOREIGN KEY (org_id, remittance_id) REFERENCES expense_withholding_remittances (org_id, id);
ALTER TABLE expense_card_debits ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_card_debits ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_card_debits ADD FOREIGN KEY (org_id, card_id) REFERENCES expense_cards (org_id, id);
ALTER TABLE expense_card_debits ADD FOREIGN KEY (org_id, cash_account_class_version_id) REFERENCES gl_account_class_versions (org_id, id);
ALTER TABLE expense_refund_receipts ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_refund_receipts ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_refund_receipts ADD FOREIGN KEY (org_id, credit_expense_id) REFERENCES expense_credit_links (org_id, expense_id);
ALTER TABLE expense_refund_receipts ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE expense_refund_receipts ADD FOREIGN KEY (org_id, cash_account_class_version_id) REFERENCES gl_account_class_versions (org_id, id);
ALTER TABLE expense_withholding_remittances_voids ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_withholding_remittances_voids ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_withholding_remittances_voids ADD FOREIGN KEY (org_id, record_id) REFERENCES expense_withholding_remittances (org_id, id);
ALTER TABLE expense_card_debits_voids ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_card_debits_voids ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_card_debits_voids ADD FOREIGN KEY (org_id, record_id) REFERENCES expense_card_debits (org_id, id);
ALTER TABLE expense_refund_receipts_voids ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_refund_receipts_voids ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_refund_receipts_voids ADD FOREIGN KEY (org_id, record_id) REFERENCES expense_refund_receipts (org_id, id);
ALTER TABLE expense_invoices ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_invoices ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_invoices ADD FOREIGN KEY (org_id, partner_id) REFERENCES partners (org_id, id);
ALTER TABLE expense_invoice_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_invoice_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_invoice_versions ADD FOREIGN KEY (org_id, invoice_id) REFERENCES expense_invoices (org_id, id);
ALTER TABLE expense_invoice_versions ADD FOREIGN KEY (org_id, payment_term_version_id) REFERENCES partner_payment_term_versions (org_id, id);
ALTER TABLE expense_details ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_details ADD FOREIGN KEY (distribution_type_code) REFERENCES distribution_types (code);
ALTER TABLE expense_details ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_details ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_details ADD FOREIGN KEY (org_id, invoice_id) REFERENCES expense_invoices (org_id, id);
ALTER TABLE expense_details ADD FOREIGN KEY (org_id, product_id) REFERENCES products (org_id, id);
ALTER TABLE expense_line_voids ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_line_voids ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_line_voids ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_line_voids ADD FOREIGN KEY (org_id, replacement_expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_source_files ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_source_files ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_invoice_file_links ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_invoice_file_links ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_invoice_file_links ADD FOREIGN KEY (org_id, invoice_id) REFERENCES expense_invoices (org_id, id);
ALTER TABLE expense_invoice_file_links ADD FOREIGN KEY (org_id, file_id) REFERENCES expense_source_files (org_id, id);
ALTER TABLE expense_invoice_file_unlinks ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_invoice_file_unlinks ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_invoice_file_unlinks ADD FOREIGN KEY (org_id, link_id) REFERENCES expense_invoice_file_links (org_id, id);
ALTER TABLE expense_pending_rows ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_pending_rows ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_pending_rows ADD FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id);
ALTER TABLE expense_import_batches ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_import_batches ADD FOREIGN KEY (org_id, file_id) REFERENCES expense_source_files (org_id, id);
ALTER TABLE expense_import_batches ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_import_rows ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_import_rows ADD FOREIGN KEY (org_id, batch_id) REFERENCES expense_import_batches (org_id, id);
ALTER TABLE expense_import_rows ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_import_versions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_import_versions ADD FOREIGN KEY (org_id, batch_id) REFERENCES expense_import_batches (org_id, id);
ALTER TABLE expense_import_versions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_import_events ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_import_events ADD FOREIGN KEY (org_id, batch_id) REFERENCES expense_import_batches (org_id, id);
ALTER TABLE expense_import_events ADD FOREIGN KEY (org_id, version_id) REFERENCES expense_import_versions (org_id, id);
ALTER TABLE expense_import_events ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_import_row_commits ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_import_row_commits ADD FOREIGN KEY (org_id, row_id) REFERENCES expense_import_rows (org_id, id);
ALTER TABLE expense_import_row_commits ADD FOREIGN KEY (org_id, version_id) REFERENCES expense_import_versions (org_id, id);
ALTER TABLE expense_import_row_commits ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_import_row_commits ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);
ALTER TABLE expense_pending_resolutions ADD FOREIGN KEY (org_id) REFERENCES organizations (id);
ALTER TABLE expense_pending_resolutions ADD FOREIGN KEY (org_id, pending_id) REFERENCES expense_pending_rows (org_id, id);
ALTER TABLE expense_pending_resolutions ADD FOREIGN KEY (org_id, expense_id) REFERENCES expenses (org_id, id);
ALTER TABLE expense_pending_resolutions ADD FOREIGN KEY (org_id, created_by) REFERENCES memberships (org_id, user_id);

-- ===== IDENTITY の次の値（ID を指定して入れた初期データのあと） =====
DO $seq$
BEGIN
  PERFORM setval(pg_get_serial_sequence('ai_usage', 'org_id'), COALESCE(MAX(org_id), 0) + 1, false) FROM ai_usage;
  PERFORM setval(pg_get_serial_sequence('audit_log', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM audit_log;
  PERFORM setval(pg_get_serial_sequence('billing_invoices', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM billing_invoices;
  PERFORM setval(pg_get_serial_sequence('billing_receipts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM billing_receipts;
  PERFORM setval(pg_get_serial_sequence('broadcast_airings', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM broadcast_airings;
  PERFORM setval(pg_get_serial_sequence('broadcast_sale_links', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM broadcast_sale_links;
  PERFORM setval(pg_get_serial_sequence('broadcast_slots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM broadcast_slots;
  PERFORM setval(pg_get_serial_sequence('campaigns', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM campaigns;
  PERFORM setval(pg_get_serial_sequence('catalog_product_windows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM catalog_product_windows;
  PERFORM setval(pg_get_serial_sequence('change_proposals', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM change_proposals;
  PERFORM setval(pg_get_serial_sequence('committee_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_contracts;
  PERFORM setval(pg_get_serial_sequence('committee_report_snapshots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_report_snapshots;
  PERFORM setval(pg_get_serial_sequence('committee_schedule_phases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_schedule_phases;
  PERFORM setval(pg_get_serial_sequence('committee_term_members', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_term_members;
  PERFORM setval(pg_get_serial_sequence('committee_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_term_versions;
  PERFORM setval(pg_get_serial_sequence('committee_term_windows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_term_windows;
  PERFORM setval(pg_get_serial_sequence('day_scene_assignments', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM day_scene_assignments;
  PERFORM setval(pg_get_serial_sequence('expenses', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expenses;
  PERFORM setval(pg_get_serial_sequence('exposures', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM exposures;
  PERFORM setval(pg_get_serial_sequence('invitations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM invitations;
  PERFORM setval(pg_get_serial_sequence('joint_committee_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_contracts;
  PERFORM setval(pg_get_serial_sequence('joint_committee_costs', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_costs;
  PERFORM setval(pg_get_serial_sequence('joint_committee_sales', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_sales;
  PERFORM setval(pg_get_serial_sequence('joint_committee_snapshots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_snapshots;
  PERFORM setval(pg_get_serial_sequence('joint_committee_windows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_committee_windows;
  PERFORM setval(pg_get_serial_sequence('joint_funding_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_funding_events;
  PERFORM setval(pg_get_serial_sequence('joint_production_milestones', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM joint_production_milestones;
  PERFORM setval(pg_get_serial_sequence('metric_definitions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM metric_definitions;
  PERFORM setval(pg_get_serial_sequence('mg_contract_links', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_contract_links;
  PERFORM setval(pg_get_serial_sequence('mg_incoming_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_incoming_contracts;
  PERFORM setval(pg_get_serial_sequence('mg_ledger_entries', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_ledger_entries;
  PERFORM setval(pg_get_serial_sequence('mg_outgoing_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_outgoing_contracts;
  PERFORM setval(pg_get_serial_sequence('mg_suppliers', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_suppliers;
  PERFORM setval(pg_get_serial_sequence('mg_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_term_versions;
  PERFORM setval(pg_get_serial_sequence('mg_version_phases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM mg_version_phases;
  PERFORM setval(pg_get_serial_sequence('observations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM observations;
  PERFORM setval(pg_get_serial_sequence('organizations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM organizations;
  PERFORM setval(pg_get_serial_sequence('partners', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partners;
  PERFORM setval(pg_get_serial_sequence('prep_tasks', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM prep_tasks;
  PERFORM setval(pg_get_serial_sequence('products', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM products;
  PERFORM setval(pg_get_serial_sequence('projects', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM projects;
  PERFORM setval(pg_get_serial_sequence('receipt_plan_requests', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM receipt_plan_requests;
  PERFORM setval(pg_get_serial_sequence('recognition_bases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM recognition_bases;
  PERFORM setval(pg_get_serial_sequence('report_imports', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_imports;
  PERFORM setval(pg_get_serial_sequence('report_mapping_profiles', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_mapping_profiles;
  PERFORM setval(pg_get_serial_sequence('report_mapping_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_mapping_versions;
  PERFORM setval(pg_get_serial_sequence('rights_intake_cases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_intake_cases;
  PERFORM setval(pg_get_serial_sequence('rights_intake_documents', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_intake_documents;
  PERFORM setval(pg_get_serial_sequence('rights_intake_participants', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_intake_participants;
  PERFORM setval(pg_get_serial_sequence('rights_intake_scopes', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_intake_scopes;
  PERFORM setval(pg_get_serial_sequence('rights_payment_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM rights_payment_events;
  PERFORM setval(pg_get_serial_sequence('sale_distribution_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sale_distribution_versions;
  PERFORM setval(pg_get_serial_sequence('sale_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sale_lines;
  PERFORM setval(pg_get_serial_sequence('sales_activities', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_activities;
  PERFORM setval(pg_get_serial_sequence('sales_agreement_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_agreement_term_versions;
  PERFORM setval(pg_get_serial_sequence('sales_agreements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_agreements;
  PERFORM setval(pg_get_serial_sequence('sales_availability_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_availability_versions;
  PERFORM setval(pg_get_serial_sequence('sales_deliverables', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_deliverables;
  PERFORM setval(pg_get_serial_sequence('sales_material_snapshots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_material_snapshots;
  PERFORM setval(pg_get_serial_sequence('sales_opportunities', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_opportunities;
  PERFORM setval(pg_get_serial_sequence('scenes', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM scenes;
  PERFORM setval(pg_get_serial_sequence('schema_meta', 'org_id'), COALESCE(MAX(org_id), 0) + 1, false) FROM schema_meta;
  PERFORM setval(pg_get_serial_sequence('settlement_contracts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM settlement_contracts;
  PERFORM setval(pg_get_serial_sequence('settlement_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM settlement_term_versions;
  PERFORM setval(pg_get_serial_sequence('shooting_days', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM shooting_days;
  PERFORM setval(pg_get_serial_sequence('tax_calculation_snapshots', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM tax_calculation_snapshots;
  PERFORM setval(pg_get_serial_sequence('tax_rule_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM tax_rule_versions;
  PERFORM setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM users;
  PERFORM setval(pg_get_serial_sequence('workflow_raw_artifacts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_raw_artifacts;
  PERFORM setval(pg_get_serial_sequence('workflow_report_commits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_report_commits;
  PERFORM setval(pg_get_serial_sequence('workflow_report_selections', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_report_selections;
  PERFORM setval(pg_get_serial_sequence('workflow_script_commits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_script_commits;
  PERFORM setval(pg_get_serial_sequence('workflow_script_reviews', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM workflow_script_reviews;
  PERFORM setval(pg_get_serial_sequence('works', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM works;
  PERFORM setval(pg_get_serial_sequence('fiscal_settings', 'org_id'), COALESCE(MAX(org_id), 0) + 1, false) FROM fiscal_settings;
  PERFORM setval(pg_get_serial_sequence('bulk_import_batches', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM bulk_import_batches;
  PERFORM setval(pg_get_serial_sequence('partner_profile_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_profile_versions;
  PERFORM setval(pg_get_serial_sequence('report_issuances', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_issuances;
  PERFORM setval(pg_get_serial_sequence('report_issuance_voids', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM report_issuance_voids;
  PERFORM setval(pg_get_serial_sequence('expected_reports', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expected_reports;
  PERFORM setval(pg_get_serial_sequence('royalty_agreements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_agreements;
  PERFORM setval(pg_get_serial_sequence('royalty_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_term_versions;
  PERFORM setval(pg_get_serial_sequence('royalty_schedule_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_schedule_versions;
  PERFORM setval(pg_get_serial_sequence('royalty_schedule_phases', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_schedule_phases;
  PERFORM setval(pg_get_serial_sequence('royalty_manual_accruals', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_manual_accruals;
  PERFORM setval(pg_get_serial_sequence('royalty_irregular_entries', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_irregular_entries;
  PERFORM setval(pg_get_serial_sequence('royalty_statements', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_statements;
  PERFORM setval(pg_get_serial_sequence('royalty_statement_voids', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_statement_voids;
  PERFORM setval(pg_get_serial_sequence('royalty_statement_lines', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_statement_lines;
  PERFORM setval(pg_get_serial_sequence('royalty_statement_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM royalty_statement_events;
  PERFORM setval(pg_get_serial_sequence('sales_source_files', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_files;
  PERFORM setval(pg_get_serial_sequence('sales_source_selections', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_selections;
  PERFORM setval(pg_get_serial_sequence('sales_source_bindings', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_bindings;
  PERFORM setval(pg_get_serial_sequence('sales_source_partitions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_partitions;
  PERFORM setval(pg_get_serial_sequence('sales_source_commits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_source_commits;
  PERFORM setval(pg_get_serial_sequence('org_switch_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM org_switch_events;
  PERFORM setval(pg_get_serial_sequence('release_window_types', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM release_window_types;
  PERFORM setval(pg_get_serial_sequence('work_release_windows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM work_release_windows;
  PERFORM setval(pg_get_serial_sequence('partner_lists', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_lists;
  PERFORM setval(pg_get_serial_sequence('partner_list_import_batches', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_list_import_batches;
  PERFORM setval(pg_get_serial_sequence('partner_list_entries', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_list_entries;
  PERFORM setval(pg_get_serial_sequence('partner_list_entry_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_list_entry_versions;
  PERFORM setval(pg_get_serial_sequence('partner_list_field_definitions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_list_field_definitions;
  PERFORM setval(pg_get_serial_sequence('sales_sheet_views', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM sales_sheet_views;
  PERFORM setval(pg_get_serial_sequence('org_profile_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM org_profile_versions;
  PERFORM setval(pg_get_serial_sequence('gl_accounts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM gl_accounts;
  PERFORM setval(pg_get_serial_sequence('gl_manual_amounts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM gl_manual_amounts;
  PERFORM setval(pg_get_serial_sequence('expense_payments', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_payments;
  PERFORM setval(pg_get_serial_sequence('committee_investment_payments', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM committee_investment_payments;
  PERFORM setval(pg_get_serial_sequence('gl_account_class_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM gl_account_class_versions;
  PERFORM setval(pg_get_serial_sequence('expense_categories', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_categories;
  PERFORM setval(pg_get_serial_sequence('expense_tax_categories', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_tax_categories;
  PERFORM setval(pg_get_serial_sequence('expense_withholding_categories', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_withholding_categories;
  PERFORM setval(pg_get_serial_sequence('expense_category_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_category_versions;
  PERFORM setval(pg_get_serial_sequence('expense_category_alias_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_category_alias_versions;
  PERFORM setval(pg_get_serial_sequence('expense_tax_category_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_tax_category_versions;
  PERFORM setval(pg_get_serial_sequence('expense_withholding_category_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_withholding_category_versions;
  PERFORM setval(pg_get_serial_sequence('partner_payment_term_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM partner_payment_term_versions;
  PERFORM setval(pg_get_serial_sequence('expense_accounting_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_accounting_versions;
  PERFORM setval(pg_get_serial_sequence('expense_cards', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_cards;
  PERFORM setval(pg_get_serial_sequence('expense_card_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_card_versions;
  PERFORM setval(pg_get_serial_sequence('expense_withholding_remittances', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_withholding_remittances;
  PERFORM setval(pg_get_serial_sequence('expense_withholding_allocations', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_withholding_allocations;
  PERFORM setval(pg_get_serial_sequence('expense_card_debits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_card_debits;
  PERFORM setval(pg_get_serial_sequence('expense_refund_receipts', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_refund_receipts;
  PERFORM setval(pg_get_serial_sequence('expense_invoices', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_invoices;
  PERFORM setval(pg_get_serial_sequence('expense_invoice_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_invoice_versions;
  PERFORM setval(pg_get_serial_sequence('expense_source_files', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_source_files;
  PERFORM setval(pg_get_serial_sequence('expense_invoice_file_links', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_invoice_file_links;
  PERFORM setval(pg_get_serial_sequence('expense_pending_rows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_pending_rows;
  PERFORM setval(pg_get_serial_sequence('expense_import_batches', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_batches;
  PERFORM setval(pg_get_serial_sequence('expense_import_rows', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_rows;
  PERFORM setval(pg_get_serial_sequence('expense_import_versions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_versions;
  PERFORM setval(pg_get_serial_sequence('expense_import_events', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_events;
  PERFORM setval(pg_get_serial_sequence('expense_import_row_commits', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_import_row_commits;
  PERFORM setval(pg_get_serial_sequence('expense_pending_resolutions', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM expense_pending_resolutions;
  PERFORM setval(pg_get_serial_sequence('cloud_analytics_state', 'org_id'), COALESCE(MAX(org_id), 0) + 1, false) FROM cloud_analytics_state;
END
$seq$;

-- ===== 版の印（PostgreSQL だけの表。D1・SQLite には無い。pg/verify-catalog.sql が読む。src/data-platform/pg-fingerprint.mjs） =====
-- source_sha256 は上の「元の移行の指紋」、ddl_sha256 はこの節より前の生成物（このファイルの先頭から、この節の前の空行の手前まで）の sha256。test/pg-catalog.test.mjs が確かめる
CREATE TABLE schema_source_fingerprint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generator text COLLATE "C" NOT NULL,
  source_sha256 text COLLATE "C" NOT NULL,
  migrations_sha256 text COLLATE "C" NOT NULL,
  app_ddl_sha256 text COLLATE "C" NOT NULL,
  ddl_sha256 text COLLATE "C" NOT NULL,
  last_migration text COLLATE "C" NOT NULL,
  expected_tables bigint NOT NULL,
  expected_triggers bigint NOT NULL,
  expected_functions bigint NOT NULL,
  expected_identities bigint NOT NULL,
  expected_foreign_keys bigint NOT NULL,
  expected_indexes bigint NOT NULL
);
INSERT INTO schema_source_fingerprint (generator, source_sha256, migrations_sha256, app_ddl_sha256, ddl_sha256, last_migration, expected_tables, expected_triggers, expected_functions, expected_identities, expected_foreign_keys, expected_indexes)
  VALUES ('pg-ddl 1', '3e686b1f53f04da7ff4df2c19033db622574d78d3c3430454d344abe53efb835', '3e686b1f53f04da7ff4df2c19033db622574d78d3c3430454d344abe53efb835', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'a215f260d736c3d53705241b59a83aaeedfc1fc04c2cabd8d642f8105609bf4e', '0011_cloud_analytics.sql', 258, 540, 199, 137, 628, 125);
